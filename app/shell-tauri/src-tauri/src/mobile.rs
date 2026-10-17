use crate::{core_constants::NAME_KEY, store, strings};
use crate::{
    mobile_saf::{Bridge, Kind, Mode},
    mobile_transfer as transfer,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

struct OpenBook {
    id: String,
    name: String,
    store: store::Store,
}

struct Session {
    generation: u64,
    open: Option<OpenBook>,
    transfer: Option<Transfer>,
}

struct MobileHost {
    books: PathBuf,
    transfers: PathBuf,
    transfers_available: bool,
    session: Mutex<Session>,
}

#[derive(Serialize)]
struct BookName {
    id: String,
    name: String,
    unavailable: bool,
    unsupported: bool,
    newer_schema: bool,
    imported: bool,
}

#[derive(Serialize)]
struct Catalog {
    generation: u64,
    books: Vec<BookName>,
    current_id: Option<String>,
    retained_transfers: usize,
    transfers_available: bool,
    transfer: Option<TransferStatus>,
}

#[derive(Clone, Serialize)]
struct SceneContext {
    id: String,
    title: String,
    kind: String,
}

#[derive(Serialize)]
struct Scene {
    id: String,
    title: String,
    depth: i64,
    context: Vec<SceneContext>,
}

#[derive(Serialize)]
struct Book {
    id: String,
    name: String,
    generation: u64,
    scenes: Vec<Scene>,
}

#[derive(Serialize)]
struct CreatedScene {
    item_id: String,
    scenes: Vec<Scene>,
}

#[derive(Serialize)]
struct CommentAnchor {
    id: i64,
    from: i64,
    to: i64,
    resolved: bool,
}

#[derive(Serialize)]
struct Document {
    item_id: String,
    body: String,
    rev: i64,
    comments: Vec<CommentAnchor>,
}

fn scenes(store: &store::Store) -> Result<Vec<Scene>, String> {
    let items = store.items().map_err(|error| error.to_string())?;
    let excluded = store::excluded_from_book(&items);
    let mut context: Vec<(i64, SceneContext)> = Vec::new();
    let mut scenes = Vec::new();
    for item in items {
        context.retain(|(depth, _)| *depth < item.depth);
        if excluded.contains(&item.id) {
            continue;
        }
        if item.item_type == "part" || item.item_type == "chapter" {
            context.push((
                item.depth,
                SceneContext {
                    id: item.id,
                    title: item.title,
                    kind: item.item_type,
                },
            ));
        } else if item.item_type == "scene" {
            scenes.push(Scene {
                id: item.id,
                title: item.title,
                depth: item.depth,
                context: context.iter().map(|(_, parent)| parent.clone()).collect(),
            });
        }
    }
    Ok(scenes)
}

fn current(session: &Session) -> Result<&OpenBook, String> {
    session
        .open
        .as_ref()
        .ok_or_else(|| "no book is open".into())
}

fn checked(session: &Session, generation: u64) -> Result<&OpenBook, String> {
    if session.generation != generation {
        return Err("this request belongs to an older book session".into());
    }
    current(session)
}

fn next_generation(session: &mut Session) -> Result<u64, String> {
    session.generation = session
        .generation
        .checked_add(1)
        .ok_or("book session counter exhausted")?;
    Ok(session.generation)
}

fn book_view(session: &Session) -> Result<Book, String> {
    let open = current(session)?;
    Ok(Book {
        id: open.id.clone(),
        name: open.name.clone(),
        generation: session.generation,
        scenes: scenes(&open.store)?,
    })
}

fn book_path(host: &MobileHost, id: &str) -> Result<PathBuf, String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "invalid book id")?;
    if parsed.to_string() != id {
        return Err("invalid book id".into());
    }
    Ok(host.books.join(format!("{id}.db")))
}

#[tauri::command]
fn mobile_catalog(host: State<'_, MobileHost>) -> Result<Catalog, String> {
    let mut books = Vec::new();
    for entry in fs::read_dir(&host.books).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|part| part.to_str()) != Some("db") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|part| part.to_str())
            .ok_or("invalid book filename")?;
        let regular = entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file();
        let name = (|| -> Result<(String, bool), String> {
            book_path(&host, id)?;
            if !regular {
                return Err("book path is not a regular file".into());
            }
            transfer::probe(&path, |store| {
                let name = store
                    .get_meta(NAME_KEY)
                    .map_err(|error| error.to_string())?
                    .unwrap_or_default();
                let imported = store
                    .get_meta(store::book_identity::TRANSFER_SOURCE_KEY)
                    .map_err(|error| error.to_string())?
                    .is_some();
                Ok((name, imported))
            })
        })();
        match name {
            Ok((name, imported)) => books.push(BookName {
                id: id.into(),
                name,
                unavailable: false,
                unsupported: false,
                newer_schema: false,
                imported,
            }),
            Err(error) => {
                eprintln!("library: book {id} is unavailable: {error}");
                books.push(BookName {
                    id: id.into(),
                    name: String::new(),
                    unavailable: true,
                    unsupported: error == "unsupported_project_preset",
                    newer_schema: error == "unsupported_schema",
                    imported: false,
                });
            }
        }
    }
    books.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    let session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    Ok(Catalog {
        generation: session.generation,
        books,
        current_id: session.open.as_ref().map(|book| book.id.clone()),
        retained_transfers: transfer::retained(&host.transfers).unwrap_or(0),
        transfers_available: host.transfers_available,
        transfer: session.transfer.as_ref().map(|job| job.status.clone()),
    })
}

#[tauri::command]
fn mobile_create(host: State<'_, MobileHost>, name: String) -> Result<Book, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("book name must contain 1 to 120 characters".into());
    }
    let mut session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    idle(&session)?;
    if session.open.is_some() {
        return Err("close the current book before creating another".into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    let path = book_path(&host, &id)?;
    let stage = host.books.join(format!("{id}.stage"));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stage)
        .map_err(|error| format!("cannot claim book stage: {error}"))?;
    let store = store::Store::open(&stage).map_err(|error| error.to_string())?;
    store
        .set_meta(NAME_KEY, name)
        .map_err(|error| error.to_string())?;
    store
        .ensure_starter_structure(&strings::Strings::new(&strings::EN))
        .map_err(|error| error.to_string())?;
    store.checkpoint().map_err(|error| error.to_string())?;
    drop(store);
    let reader = store::Store::open_readonly(&stage).map_err(|error| error.to_string())?;
    if reader
        .get_meta(NAME_KEY)
        .map_err(|error| error.to_string())?
        .as_deref()
        != Some(name)
        || scenes(&reader)?.is_empty()
    {
        return Err("new book stage is incomplete".into());
    }
    drop(reader);
    crate::mobile_core::move_new(&stage, &path)
        .map_err(|error| format!("cannot publish book: {error}"))?;
    if let Err(error) = fs::File::open(&host.books).and_then(|dir| dir.sync_all()) {
        let rollback = crate::mobile_core::move_new(&path, &stage);
        return Err(match rollback {
            Ok(()) => format!("cannot sync book directory: {error}"),
            Err(revert) => {
                format!("cannot sync book directory: {error}; book rollback failed: {revert}")
            }
        });
    }
    let store = match store::Store::open_existing(&path) {
        Ok(store) => store,
        Err(error) => {
            let rollback = crate::mobile_core::move_new(&path, &stage);
            return Err(match rollback {
                Ok(()) => format!("cannot reopen published book: {error}"),
                Err(revert) => {
                    format!("cannot reopen published book: {error}; book rollback failed: {revert}")
                }
            });
        }
    };
    next_generation(&mut session)?;
    session.open = Some(OpenBook {
        id,
        name: name.into(),
        store,
    });
    book_view(&session)
}

#[tauri::command]
fn mobile_open(host: State<'_, MobileHost>, id: String) -> Result<Book, String> {
    open_book(&host, &id)
}
fn open_book(host: &MobileHost, id: &str) -> Result<Book, String> {
    let mut session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    idle(&session)?;
    if let Some(open) = &session.open {
        if open.id == id {
            return book_view(&session);
        }
        return Err("close the current book before opening another".into());
    }
    let path = book_path(&host, &id)?;
    transfer::probe(&path, |reader| {
        if reader
            .get_meta(crate::backup_bundle::MARKER_KEY)
            .map_err(|_| "transfer_invalid")?
            .is_some()
        {
            return Err("transfer_invalid".into());
        }
        Ok(())
    })?;
    let store = store::Store::open_existing(&path).map_err(|error| error.to_string())?;
    let name = store
        .get_meta(NAME_KEY)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    next_generation(&mut session)?;
    session.open = Some(OpenBook {
        id: id.into(),
        name,
        store,
    });
    book_view(&session)
}

#[tauri::command]
fn mobile_scene_create(
    host: State<'_, MobileHost>,
    generation: u64,
    title: String,
) -> Result<CreatedScene, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("scene title must contain 1 to 120 characters".into());
    }
    let session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    idle(&session)?;
    let open = checked(&session, generation)?;
    let items = open.store.items().map_err(|error| error.to_string())?;
    let excluded = store::excluded_from_book(&items);
    let chapter = items
        .into_iter()
        .find(|item| item.item_type == "chapter" && !excluded.contains(&item.id))
        .ok_or("book has no chapter")?;
    let created = open
        .store
        .item_create(Some(&chapter.id), "scene", title)
        .map_err(|error| error.to_string())?;
    Ok(CreatedScene {
        item_id: created.id,
        scenes: scenes(&open.store)?,
    })
}

#[tauri::command]
fn mobile_document(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
) -> Result<Document, String> {
    let session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    let open = checked(&session, generation)?;
    if !scenes(&open.store)?.iter().any(|scene| scene.id == item_id) {
        return Err("scene is not in the open book".into());
    }
    let doc = open
        .store
        .load_doc(&item_id)
        .map_err(|error| error.to_string())?;
    let comments = open
        .store
        .comments(&item_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|comment| CommentAnchor {
            id: comment.id,
            from: comment.anchor_from,
            to: comment.anchor_to,
            resolved: comment.resolved,
        })
        .collect();
    Ok(Document {
        item_id,
        body: doc.body,
        rev: doc.rev,
        comments,
    })
}

#[tauri::command]
fn mobile_flush(
    host: State<'_, MobileHost>,
    generation: u64,
    entries: Vec<store::FlushEntry>,
    attribution: Option<Vec<store::source_words::FlushAttribution>>,
) -> Result<Vec<store::FlushAck>, String> {
    let session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    idle(&session)?;
    let open = current(&session)?;
    let allowed: std::collections::HashSet<_> = scenes(&open.store)?
        .into_iter()
        .map(|scene| scene.id)
        .collect();
    if entries
        .iter()
        .any(|entry| !allowed.contains(&entry.item_id))
    {
        return Err("scene is not in the open book".into());
    }
    crate::mobile_core::flush(
        &open.store,
        session.generation,
        generation,
        &entries,
        attribution.as_deref().unwrap_or(&[]),
    )
}

#[tauri::command]
fn mobile_close(host: State<'_, MobileHost>, generation: u64) -> Result<(), String> {
    let mut session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    idle(&session)?;
    let open = checked(&session, generation)?;
    open.store.checkpoint().map_err(|error| error.to_string())?;
    session.open = None;
    next_generation(&mut session)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(crate::mobile_saf::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let books = data.join("books");
            let transfers = data.join("transfer");
            fs::create_dir_all(&books)?;
            let transfers_available = transfer::sweep(&transfers, false).is_ok();
            app.manage(MobileHost {
                books,
                transfers,
                transfers_available,
                session: Mutex::new(Session {
                    generation: 0,
                    open: None,
                    transfer: None,
                }),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_catalog,
            mobile_create,
            mobile_open,
            mobile_scene_create,
            mobile_document,
            mobile_flush,
            mobile_close,
            mobile_transfer_start,
            mobile_transfer_status,
            mobile_transfer_cancel,
            mobile_transfer_confirm,
            mobile_transfer_finish,
            mobile_transfer_discard,
        ])
        .run(tauri::generate_context!())
        .expect("mobile host failed to start");
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Import,
    Export,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum KeyChoice {
    Existing,
    New,
}
#[derive(Clone, Serialize)]
struct TransferStatus {
    token: String,
    phase: String,
    code: Option<String>,
    preview: Option<transfer::Preview>,
    book_id: Option<String>,
}
struct Transfer {
    status: TransferStatus,
    generation: u64,
    book_id: Option<String>,
    stage: PathBuf,
    canceled: Arc<AtomicBool>,
    running: bool,
    direction: Direction,
    uncertain_write: bool,
}
fn idle(session: &Session) -> Result<(), String> {
    if session.transfer.is_some() {
        Err("transfer_busy".into())
    } else {
        Ok(())
    }
}
fn binding(session: &Session) -> Result<Option<String>, String> {
    session
        .open
        .as_ref()
        .map(|book| {
            book.store
                .book_id()
                .map_err(|_| "transfer_invalid".to_string())?
                .ok_or_else(|| "transfer_invalid".to_string())
        })
        .transpose()
}
fn admitted<'a>(session: &'a Session, token: &str) -> Result<&'a Transfer, String> {
    let job = session
        .transfer
        .as_ref()
        .filter(|job| job.status.token == token)
        .ok_or("transfer_stale")?;
    if job.generation != session.generation || job.book_id != binding(session)? {
        return Err("transfer_stale".into());
    }
    if job.canceled.load(Ordering::SeqCst) {
        return Err("transfer_cancelled".into());
    }
    Ok(job)
}
fn phase(app: &tauri::AppHandle, token: &str, phase: &str) -> Result<PathBuf, String> {
    let host = app.state::<MobileHost>();
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    let stage = admitted(&session, token)?.stage.clone();
    session.transfer.as_mut().unwrap().status.phase = phase.into();
    Ok(stage)
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "transfer_invalid".to_string())?
}
fn complete(
    app: &tauri::AppHandle,
    token: &str,
    result: Result<Option<transfer::Preview>, String>,
) {
    complete_transfer(&app.state::<MobileHost>(), token, result);
}
fn complete_transfer(
    host: &MobileHost,
    token: &str,
    result: Result<Option<transfer::Preview>, String>,
) {
    let cleanup = if matches!(&result, Ok(Some(_))) {
        Ok(())
    } else {
        let claim = host.session.lock().ok().and_then(|session| {
            session
                .transfer
                .as_ref()
                .filter(|job| job.status.token == token)
                .map(|job| {
                    (
                        job.stage.clone(),
                        job.direction == Direction::Export && job.uncertain_write,
                    )
                })
        });
        claim.map_or(Ok(()), |(stage, uncertain)| {
            transfer::finish_stage(&stage, uncertain)
        })
    };
    let Ok(mut session) = host.session.lock() else {
        return;
    };
    let result = match result {
        Ok(None) => {
            if cleanup.is_err() {
                if let Some(job) = session
                    .transfer
                    .as_mut()
                    .filter(|job| job.status.token == token)
                {
                    job.status.code = Some("transfer_cleanup".into());
                }
            }
            Ok(None)
        }
        Err(code) if code == "transfer_restart" => Err(code),
        result => cleanup.and(result),
    };
    settle(&mut session, token, result);
}

fn settle(session: &mut Session, token: &str, result: Result<Option<transfer::Preview>, String>) {
    let ownership = admitted(session, token).map(|_| ());
    let Some(job) = session
        .transfer
        .as_mut()
        .filter(|job| job.status.token == token)
    else {
        return;
    };
    job.running = false;
    let outcome = if matches!(&result, Err(code) if code == "transfer_restart") {
        result
    } else {
        ownership.and(result)
    };
    match outcome {
        Ok(Some(preview)) => {
            job.status.preview = Some(preview);
            job.status.phase = "preview".into();
        }
        Ok(None) => job.status.phase = "done".into(),
        Err(code) => {
            job.status.phase = if code == "transfer_restart" {
                "restart_required"
            } else if job.canceled.load(Ordering::SeqCst) || code == "transfer_cancelled" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            job.status.code = Some(code);
        }
    }
}
async fn pick_read(app: &tauri::AppHandle, token: &str, kind: Kind) -> Result<(), String> {
    let stage = phase(
        app,
        token,
        if kind == Kind::Key { "key" } else { "archive" },
    )?;
    let bridge = app.state::<Bridge<tauri::Wry>>();
    let ticket = bridge
        .pick(
            token,
            kind,
            Mode::Open,
            if kind == Kind::Key {
                "recovery-key.txt"
            } else {
                "book.age"
            },
        )
        .await
        .map_err(provider_error)?
        .ok_or("transfer_cancelled")?;
    phase(app, token, "reading")?;
    let limit = if kind == Kind::Key {
        512
    } else {
        transfer::read_budget(&stage)?
    };
    let receipt = bridge.read(ticket, token, limit).await.map_err(|code| {
        if matches!(
            code.as_str(),
            "transfer_too_large" | "transfer_storage" | "transfer_restart"
        ) {
            code
        } else {
            "transfer_provider".into()
        }
    })?;
    phase(app, token, "preparing")?;
    let path = stage.join(kind.file_name(Mode::Open));
    let digest = blocking(move || transfer::fingerprint(&path, limit)).await?;
    if digest != (receipt.bytes, receipt.sha256) {
        return Err("transfer_provider".into());
    }
    Ok(())
}
async fn pick_write(
    app: &tauri::AppHandle,
    token: &str,
    kind: Kind,
    digest: (u64, String),
) -> Result<(), String> {
    phase(
        app,
        token,
        if kind == Kind::Key {
            "save_key"
        } else {
            "save_archive"
        },
    )?;
    let bridge = app.state::<Bridge<tauri::Wry>>();
    let ticket = bridge
        .pick(
            token,
            kind,
            Mode::Create,
            if kind == Kind::Key {
                "garret-recovery-key.txt"
            } else {
                "garret-book.age"
            },
        )
        .await
        .map_err(provider_error)?
        .ok_or("transfer_cancelled")?;
    let stage = phase(app, token, "writing")?;
    transfer::write_started(&stage)?;
    write_state(&app.state::<MobileHost>(), token, true)?;
    if let Err(code) = bridge.write(ticket, token, digest.0, &digest.1).await {
        if code == "transfer_not_started" {
            write_state(&app.state::<MobileHost>(), token, false)?;
            transfer::write_verified(&stage)?;
        }
        return Err(provider_error(code));
    }
    write_state(&app.state::<MobileHost>(), token, false)?;
    transfer::write_verified(&stage)?;
    phase(app, token, "preparing")?;
    Ok(())
}
async fn export_book(
    app: &tauri::AppHandle,
    token: &str,
    choice: KeyChoice,
) -> Result<Option<transfer::Preview>, String> {
    let stage = phase(app, token, "preparing")?;
    let snapshot_app = app.clone();
    let snapshot_token = token.to_string();
    let bundle = blocking(move || {
        let host = snapshot_app.state::<MobileHost>();
        snapshot_transfer(&host, &snapshot_token, |path, stage| {
            let store = store::Store::open_existing(path).map_err(|_| "transfer_invalid")?;
            transfer::snapshot(path, &store, stage)
        })
    })
    .await?;
    phase(app, token, "preparing")?;
    let key_path = match choice {
        KeyChoice::Existing => {
            pick_read(app, token, Kind::Key).await?;
            stage.join("key.in")
        }
        KeyChoice::New => {
            let key = stage.join("key.out");
            let generate = key.clone();
            let digest = blocking(move || {
                crate::encrypted_archive::generate_key(&generate).map_err(|_| "transfer_key")?;
                transfer::fingerprint(&generate, 512)
            })
            .await?;
            pick_write(app, token, Kind::Key, digest).await?;
            key
        }
    };
    phase(app, token, "preparing")?;
    let encrypt_stage = stage.clone();
    let digest = blocking(move || transfer::encrypt(&bundle, &encrypt_stage, &key_path)).await?;
    pick_write(app, token, Kind::Archive, digest).await?;
    phase(app, token, "preparing")?;
    Ok(None)
}
async fn import_book(
    app: &tauri::AppHandle,
    token: &str,
) -> Result<Option<transfer::Preview>, String> {
    pick_read(app, token, Kind::Archive).await?;
    pick_read(app, token, Kind::Key).await?;
    let stage = phase(app, token, "preparing")?;
    let books = app.state::<MobileHost>().books.clone();
    let preview = blocking(move || transfer::preview(&stage, &books)).await?;
    phase(app, token, "preview")?;
    Ok(Some(preview))
}
fn write_state(host: &MobileHost, token: &str, uncertain: bool) -> Result<(), String> {
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    if uncertain {
        admitted(&session, token)?;
    }
    session
        .transfer
        .as_mut()
        .filter(|job| job.status.token == token)
        .ok_or("transfer_stale")?
        .uncertain_write = uncertain;
    Ok(())
}
fn provider_error(code: String) -> String {
    if code == "transfer_restart" {
        code
    } else {
        "transfer_provider".into()
    }
}
fn snapshot_transfer<T>(
    host: &MobileHost,
    token: &str,
    snapshot: impl FnOnce(&std::path::Path, &std::path::Path) -> Result<T, String>,
) -> Result<T, String> {
    let (path, stage) = {
        let session = host.session.lock().map_err(|_| "transfer_invalid")?;
        let job = admitted(&session, token)?;
        (book_path(host, &current(&session)?.id)?, job.stage.clone())
    };
    let result = snapshot(&path, &stage)?;
    let session = host.session.lock().map_err(|_| "transfer_invalid")?;
    admitted(&session, token)?;
    Ok(result)
}
fn start_transfer(
    host: &MobileHost,
    direction: Direction,
    generation: u64,
) -> Result<TransferStatus, String> {
    if !host.transfers_available {
        return Err("transfer_disabled".into());
    }
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    idle(&session)?;
    if generation != session.generation {
        return Err("transfer_stale".into());
    }
    if direction == Direction::Import && session.open.is_some() {
        return Err("transfer_busy".into());
    }
    if direction == Direction::Export {
        crate::mobile_core::supported(&checked(&session, generation)?.store)?;
    }
    let book_id = binding(&session)?;
    let token = uuid::Uuid::now_v7().to_string();
    let stage = transfer::stage(&host.transfers, &token)?;
    let status = TransferStatus {
        token: token.clone(),
        phase: "preparing".into(),
        code: None,
        preview: None,
        book_id: None,
    };
    session.transfer = Some(Transfer {
        status: status.clone(),
        generation,
        book_id,
        stage,
        canceled: Arc::new(AtomicBool::new(false)),
        running: true,
        direction,
        uncertain_write: false,
    });
    Ok(status)
}
#[tauri::command]
fn mobile_transfer_start(
    app: tauri::AppHandle,
    host: State<'_, MobileHost>,
    direction: Direction,
    generation: u64,
    key_choice: KeyChoice,
) -> Result<TransferStatus, String> {
    let status = start_transfer(&host, direction, generation)?;
    let token = status.token.clone();
    tauri::async_runtime::spawn(async move {
        let result = if direction == Direction::Export {
            export_book(&app, &token, key_choice).await
        } else {
            import_book(&app, &token).await
        };
        if result.is_err() {
            // Release an unconsumed picker ticket, while retaining original work until drained.
            let _ = app.state::<Bridge<tauri::Wry>>().cancel(&token).await;
        }
        complete(&app, &token, result);
    });
    Ok(status)
}
#[tauri::command]
fn mobile_transfer_status(
    host: State<'_, MobileHost>,
    token: String,
) -> Result<TransferStatus, String> {
    let session = host.session.lock().map_err(|_| "transfer_invalid")?;
    session
        .transfer
        .as_ref()
        .filter(|job| job.status.token == token)
        .map(|job| job.status.clone())
        .ok_or_else(|| "transfer_stale".into())
}
fn cancel_transfer(host: &MobileHost, token: &str) -> Result<(), String> {
    {
        let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
        let job = session
            .transfer
            .as_mut()
            .filter(|job| job.status.token == token)
            .ok_or("transfer_stale")?;
        if matches!(
            job.status.phase.as_str(),
            "done" | "failed" | "cancelled" | "publishing" | "restart_required"
        ) {
            return Ok(());
        }
        job.canceled.store(true, Ordering::SeqCst);
        job.status.phase = "cancelling".into();
        if !job.running {
            job.status.phase = "cancelled".into();
        }
    }
    Ok(())
}
#[tauri::command]
async fn mobile_transfer_cancel(
    app: tauri::AppHandle,
    host: State<'_, MobileHost>,
    token: String,
) -> Result<(), String> {
    cancel_transfer(&host, &token)?;
    app.state::<Bridge<tauri::Wry>>()
        .cancel(&token)
        .await
        .map_err(|_| "transfer_provider".into())
}
fn claim_publish(host: &MobileHost, token: &str) -> Result<(PathBuf, transfer::Preview), String> {
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    let job = admitted(&session, token)?;
    if job.running || job.status.phase != "preview" {
        return Err("transfer_stale".into());
    }
    let claim = (
        job.stage.clone(),
        job.status.preview.clone().ok_or("transfer_stale")?,
    );
    let job = session.transfer.as_mut().unwrap();
    job.running = true;
    job.status.phase = "publishing".into();
    Ok(claim)
}
fn publish_transfer(
    host: &MobileHost,
    token: &str,
    claim: (PathBuf, transfer::Preview),
    publish: impl FnOnce(
        &std::path::Path,
        &std::path::Path,
        &transfer::Preview,
    ) -> Result<String, String>,
) {
    let result = publish(&claim.0, &host.books, &claim.1);
    let cleanup = transfer::finish_stage(&claim.0, false);
    let Ok(mut session) = host.session.lock() else {
        return;
    };
    let result = result.and_then(|id| {
        admitted(&session, token)?;
        let job = session.transfer.as_mut().unwrap();
        job.status.book_id = Some(id);
        if cleanup.is_err() {
            job.status.code = Some("transfer_cleanup".into());
        }
        Ok(None)
    });
    settle(&mut session, token, result);
}
#[tauri::command]
fn mobile_transfer_confirm(
    app: tauri::AppHandle,
    host: State<'_, MobileHost>,
    token: String,
) -> Result<(), String> {
    let claim = claim_publish(&host, &token)?;
    tauri::async_runtime::spawn_blocking(move || {
        publish_transfer(&app.state::<MobileHost>(), &token, claim, transfer::publish);
    });
    Ok(())
}
fn finish_transfer(host: &MobileHost, token: &str) -> Result<(), String> {
    let (stage, uncertain) = {
        let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
        let job = session
            .transfer
            .as_mut()
            .filter(|job| job.status.token == token)
            .ok_or("transfer_stale")?;
        if job.running || !matches!(job.status.phase.as_str(), "done" | "failed" | "cancelled") {
            return Err("transfer_busy".into());
        }
        job.running = true;
        (
            job.stage.clone(),
            job.direction == Direction::Export && job.uncertain_write,
        )
    };
    let result = transfer::finish_stage(&stage, uncertain);
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    if let Some(job) = session
        .transfer
        .as_mut()
        .filter(|job| job.status.token == token)
    {
        job.running = false;
        result?;
        session.transfer = None;
    }
    Ok(())
}
#[tauri::command]
fn mobile_transfer_finish(host: State<'_, MobileHost>, token: String) -> Result<(), String> {
    finish_transfer(&host, &token)
}
#[tauri::command]
fn mobile_transfer_discard(host: State<'_, MobileHost>) -> Result<(), String> {
    discard_transfers(&host)
}
fn discard_transfers(host: &MobileHost) -> Result<(), String> {
    let session = host.session.lock().map_err(|_| "transfer_invalid")?;
    idle(&session)?;
    transfer::sweep(&host.transfers, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(root: &std::path::Path) -> (MobileHost, String) {
        let books = root.join("books");
        fs::create_dir(&books).unwrap();
        let transfers = root.join("transfer");
        transfer::private_dir(&transfers).unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let store = store::Store::open(&books.join(format!("{id}.db"))).unwrap();
        store.set_meta(NAME_KEY, "Harbour").unwrap();
        store
            .ensure_starter_structure(&strings::Strings::new(&strings::EN))
            .unwrap();
        store.checkpoint().unwrap();
        (
            MobileHost {
                books,
                transfers,
                transfers_available: true,
                session: Mutex::new(Session {
                    generation: 0,
                    open: None,
                    transfer: None,
                }),
            },
            id,
        )
    }
    #[test]
    fn mobile_transfer_seventeen_picker_cancels_do_not_exhaust_admission() {
        for direction in [Direction::Import, Direction::Export] {
            let root = tempfile::tempdir().unwrap();
            let (host, id) = host(root.path());
            if direction == Direction::Export {
                open_book(&host, &id).unwrap();
            }
            let generation = host.session.lock().unwrap().generation;
            fs::create_dir(host.transfers.join("probe-orphan")).unwrap();
            let mut stages = Vec::new();
            for attempt in 0..17 {
                let status = start_transfer(&host, direction, generation).unwrap();
                let stage = host.transfers.join(&status.token);
                fs::write(stage.join("key.in"), b"temporary recovery key").unwrap();
                if attempt % 2 == 0 {
                    cancel_transfer(&host, &status.token).unwrap();
                }
                assert!(finish_transfer(&host, &status.token).is_err());
                complete_transfer(&host, &status.token, Err("transfer_cancelled".into()));
                finish_transfer(&host, &status.token).unwrap();
                stages.push(stage);
            }
            assert!(stages.iter().all(|stage| !stage.exists()));
            assert_eq!(transfer::retained(&host.transfers).unwrap(), 0);
            let next = start_transfer(&host, direction, generation).unwrap();
            assert!(discard_transfers(&host).is_err());
            cancel_transfer(&host, &next.token).unwrap();
            complete_transfer(&host, &next.token, Err("transfer_cancelled".into()));
            finish_transfer(&host, &next.token).unwrap();
        }
    }
    #[test]
    fn mobile_transfer_verified_export_stays_done_until_cleanup_can_be_retried() {
        let root = tempfile::tempdir().unwrap();
        let (host, id) = host(root.path());
        let generation = open_book(&host, &id).unwrap().generation;
        let original = fs::read(book_path(&host, &id).unwrap()).unwrap();
        let status = start_transfer(&host, Direction::Export, generation).unwrap();
        let stage = host.transfers.join(&status.token);
        let destination = root.path().join("verified.age");
        fs::write(&destination, b"verified encrypted archive").unwrap();
        fs::remove_dir(&stage).unwrap();
        fs::write(&stage, b"cleanup unavailable").unwrap();

        complete_transfer(&host, &status.token, Ok(None));
        {
            let session = host.session.lock().unwrap();
            let job = session.transfer.as_ref().unwrap();
            assert_eq!(job.status.phase, "done");
            assert_eq!(job.status.code.as_deref(), Some("transfer_cleanup"));
            assert!(!job.running);
        }
        assert_eq!(
            finish_transfer(&host, &status.token).unwrap_err(),
            "transfer_cleanup"
        );
        assert_eq!(
            host.session
                .lock()
                .unwrap()
                .transfer
                .as_ref()
                .unwrap()
                .status
                .phase,
            "done"
        );
        fs::remove_file(&stage).unwrap();
        transfer::private_dir(&stage).unwrap();
        fs::write(stage.join("archive.out"), b"verified encrypted archive").unwrap();
        finish_transfer(&host, &status.token).unwrap();
        assert!(!stage.exists());
        assert!(host.session.lock().unwrap().transfer.is_none());
        assert_eq!(
            fs::read(destination).unwrap(),
            b"verified encrypted archive"
        );
        assert_eq!(fs::read(book_path(&host, &id).unwrap()).unwrap(), original);
    }
    #[test]
    fn mobile_transfer_terminal_cleanup_retains_only_uncertain_ciphertext() {
        let root = tempfile::tempdir().unwrap();
        let (host, id) = host(root.path());
        let generation = open_book(&host, &id).unwrap().generation;
        let original = fs::read(book_path(&host, &id).unwrap()).unwrap();
        for (uncertain, cipher) in [(false, true), (true, true), (true, false)] {
            let status = start_transfer(&host, Direction::Export, generation).unwrap();
            let stage = host.transfers.join(&status.token);
            fs::write(stage.join("key.out"), b"new secret recovery key").unwrap();
            fs::write(stage.join("key.in"), b"existing secret recovery key").unwrap();
            fs::create_dir(stage.join("snapshot.point")).unwrap();
            fs::write(
                stage.join("snapshot.point/project.db"),
                b"plaintext manuscript",
            )
            .unwrap();
            if cipher {
                fs::write(stage.join("archive.out"), b"encrypted archive").unwrap();
            }
            transfer::write_started(&stage).unwrap();
            write_state(&host, &status.token, true).unwrap();
            if !uncertain {
                write_state(&host, &status.token, false).unwrap();
                transfer::write_verified(&stage).unwrap();
            }
            complete_transfer(&host, &status.token, Err("transfer_provider".into()));
            assert!(!stage.join("key.out").exists());
            assert!(!stage.join("key.in").exists());
            assert!(!stage.join("snapshot.point").exists());
            finish_transfer(&host, &status.token).unwrap();
            assert_eq!(stage.exists(), uncertain);
            if uncertain {
                if cipher {
                    assert_eq!(
                        fs::read(stage.join("archive.out")).unwrap(),
                        b"encrypted archive"
                    );
                } else {
                    assert!(!stage.join("archive.out").exists());
                }
                assert_eq!(
                    fs::read_dir(&stage).unwrap().count(),
                    if cipher { 2 } else { 1 }
                );
            }
        }
        let stale = transfer::stage(&host.transfers, &uuid::Uuid::now_v7().to_string()).unwrap();
        fs::write(stale.join("key.out"), b"interrupted key").unwrap();
        fs::create_dir(host.transfers.join("probe-stale")).unwrap();
        transfer::sweep(&host.transfers, false).unwrap();
        assert!(!stale.exists());
        assert!(!host.transfers.join("probe-stale").exists());
        assert_eq!(transfer::retained(&host.transfers).unwrap(), 2);
        discard_transfers(&host).unwrap();
        assert_eq!(transfer::retained(&host.transfers).unwrap(), 0);
        assert_eq!(fs::read(book_path(&host, &id).unwrap()).unwrap(), original);
    }
    #[test]
    fn mobile_transfer_low_storage_open_needs_no_temporary_space_or_transfer_size_limit() {
        let root = tempfile::tempdir().unwrap();
        let (mut host, id) = host(root.path());
        fs::remove_dir(&host.transfers).unwrap();
        fs::write(&host.transfers, b"temporary storage unavailable").unwrap();
        host.transfers_available = false;
        let path = book_path(&host, &id).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(transfer::PAYLOAD_LIMIT + 4096)
            .unwrap();
        let opened = open_book(&host, &id).unwrap();
        assert_eq!(opened.name, "Harbour");
        assert!(!opened.scenes.is_empty());
        assert_eq!(
            fs::read(&host.transfers).unwrap(),
            b"temporary storage unavailable"
        );
        assert!(
            matches!(start_transfer(&host, Direction::Export, opened.generation), Err(code) if code == "transfer_disabled")
        );
    }
    #[test]
    fn mobile_transfer_snapshot_and_publish_release_the_session_guard_but_keep_admission() {
        let root = tempfile::tempdir().unwrap();
        let (host, id) = host(root.path());
        let generation = open_book(&host, &id).unwrap().generation;
        let job = start_transfer(&host, Direction::Export, generation).unwrap();
        snapshot_transfer(&host, &job.token, |path, stage| {
            let session = host
                .session
                .try_lock()
                .expect("snapshot holds the session guard");
            assert!(idle(&session).is_err());
            drop(session);
            let store = store::Store::open_existing(path).unwrap();
            transfer::snapshot(path, &store, stage)
        })
        .unwrap();
        complete_transfer(&host, &job.token, Err("transfer_cancelled".into()));
        finish_transfer(&host, &job.token).unwrap();
        host.session.lock().unwrap().open = None;
        let job = start_transfer(&host, Direction::Import, generation).unwrap();
        let stage = host.transfers.join(&job.token);
        let path = book_path(&host, &id).unwrap();
        let store = store::Store::open_readonly(&path).unwrap();
        let bundle = stage.join("point");
        crate::backup_bundle::write(&path, &store, &bundle).unwrap();
        let source = crate::transfer_copy::inspect(&bundle).unwrap();
        fs::write(stage.join("archive.in"), b"unchanged archive").unwrap();
        let (archive_bytes, archive_sha256) =
            transfer::fingerprint(&stage.join("archive.in"), transfer::ARCHIVE_LIMIT).unwrap();
        let preview = transfer::Preview {
            title: source.title.clone(),
            related: vec![],
            unreadable_books: 0,
            source,
            archive_bytes,
            archive_sha256,
        };
        complete_transfer(&host, &job.token, Ok(Some(preview)));
        let claim = claim_publish(&host, &job.token).unwrap();
        publish_transfer(&host, &job.token, claim, |stage, books, preview| {
            let session = host
                .session
                .try_lock()
                .expect("publish holds the session guard");
            assert!(idle(&session).is_err());
            drop(session);
            cancel_transfer(&host, &job.token).unwrap();
            assert!(!host
                .session
                .lock()
                .unwrap()
                .transfer
                .as_ref()
                .unwrap()
                .canceled
                .load(Ordering::SeqCst));
            transfer::publish(stage, books, preview)
        });
        let session = host.session.lock().unwrap();
        assert_eq!(session.transfer.as_ref().unwrap().status.phase, "done");
        assert!(session.transfer.as_ref().unwrap().status.book_id.is_some());
        drop(session);
        finish_transfer(&host, &job.token).unwrap();
    }
    #[test]
    fn mobile_transfer_open_refuses_schema_before_preset_without_library_changes() {
        for (preset, newer, code) in [
            ("short", false, "unsupported_project_preset"),
            ("zzz", false, "unsupported_project_preset"),
            ("novel", true, "unsupported_schema"),
            ("short", true, "unsupported_schema"),
            ("zzz", true, "unsupported_schema"),
        ] {
            for wal in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let (host, id) = host(root.path());
                let path = book_path(&host, &id).unwrap();
                let connection = rusqlite::Connection::open(&path).unwrap();
                connection
                    .pragma_update(None, "journal_mode", "WAL")
                    .unwrap();
                connection
                    .execute(
                        "INSERT OR REPLACE INTO meta(key,value) VALUES('project.preset',?1)",
                        [preset],
                    )
                    .unwrap();
                if newer {
                    connection
                        .pragma_update(None, "user_version", store::SCHEMA_VERSION + 1)
                        .unwrap();
                }
                let mut connection = Some(connection);
                if !wal {
                    drop(connection.take());
                }
                for directory in [
                    crate::pictures::dir_for(&path),
                    crate::research::dir_for(&path),
                ] {
                    std::fs::create_dir_all(&directory).unwrap();
                    std::fs::write(directory.join("retained"), b"original").unwrap();
                }
                let before = transfer::tests::contents(&host.books);
                assert!(
                    matches!(open_book(&host, &id), Err(found) if found == code),
                    "{preset} {newer}"
                );
                let session = host.session.lock().unwrap();
                assert!(session.open.is_none());
                assert_eq!(session.generation, 0);
                let after = transfer::tests::contents(&host.books);
                assert_eq!(
                    after.keys().collect::<Vec<_>>(),
                    before.keys().collect::<Vec<_>>()
                );
                for (path, bytes) in &before {
                    if !path.to_string_lossy().ends_with("-shm") {
                        assert_eq!(after.get(path), Some(bytes), "{preset} {newer} WAL={wal}");
                    }
                }
                drop(connection);
            }
        }
    }
    #[test]
    fn mobile_transfer_cancellation_keeps_admission_until_the_late_result_drains() {
        let root = tempfile::tempdir().unwrap();
        let (host, id) = host(root.path());
        let opened = open_book(&host, &id).unwrap();
        let token = uuid::Uuid::now_v7().to_string();
        let mut session = host.session.lock().unwrap();
        let book_id = binding(&session).unwrap();
        session.transfer = Some(Transfer {
            status: TransferStatus {
                token: token.clone(),
                phase: "writing".into(),
                code: None,
                preview: None,
                book_id: None,
            },
            generation: opened.generation,
            book_id,
            stage: host.transfers.join(&token),
            canceled: Arc::new(AtomicBool::new(false)),
            running: true,
            direction: Direction::Export,
            uncertain_write: false,
        });
        assert!(idle(&session).is_err());
        assert!(admitted(&session, &token).is_ok());
        session
            .transfer
            .as_ref()
            .unwrap()
            .canceled
            .store(true, Ordering::SeqCst);
        assert!(admitted(&session, &token).is_err());
        assert!(session.transfer.as_ref().unwrap().running);
        assert!(idle(&session).is_err());
        // Even a successful late provider callback cannot report success after cancellation.
        settle(&mut session, &token, Ok(None));
        let job = session.transfer.as_ref().unwrap();
        assert!(!job.running);
        assert_eq!(job.status.phase, "cancelled");
        assert!(idle(&session).is_err());
        session
            .transfer
            .as_mut()
            .unwrap()
            .canceled
            .store(false, Ordering::SeqCst);
        settle(&mut session, &token, Err("transfer_cancelled".into()));
        assert_eq!(session.transfer.as_ref().unwrap().status.phase, "cancelled");
        session.transfer = None;
        assert!(idle(&session).is_ok());
    }
    #[test]
    fn mobile_transfer_ownership_and_generation_are_rechecked_after_a_provider_reply() {
        let root = tempfile::tempdir().unwrap();
        let (host, id) = host(root.path());
        let opened = open_book(&host, &id).unwrap();
        let token = uuid::Uuid::now_v7().to_string();
        let mut session = host.session.lock().unwrap();
        let book_id = binding(&session).unwrap();
        session.transfer = Some(Transfer {
            status: TransferStatus {
                token: token.clone(),
                phase: "reading".into(),
                code: None,
                preview: None,
                book_id: None,
            },
            generation: opened.generation,
            book_id,
            stage: host.transfers.join(&token),
            canceled: Arc::new(AtomicBool::new(false)),
            running: true,
            direction: Direction::Export,
            uncertain_write: false,
        });
        session.generation += 1;
        assert!(admitted(&session, &token).is_err());
        settle(&mut session, &token, Ok(None));
        assert_eq!(session.transfer.as_ref().unwrap().status.phase, "failed");
        assert_eq!(
            session.transfer.as_ref().unwrap().status.code.as_deref(),
            Some("transfer_stale")
        );
        session.generation -= 1;
        session.transfer.as_mut().unwrap().book_id = Some("different-book".into());
        assert!(admitted(&session, &token).is_err());
    }
}
