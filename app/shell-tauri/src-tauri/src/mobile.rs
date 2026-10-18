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
    parent_id: Option<String>,
    rev: i64,
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
                parent_id: item.parent_id,
                rev: item.rev,
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
    if !crate::mobile_core::is_canonical_uuid(id) {
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
fn mobile_open(host: State<'_, MobileHost>, id: String, upgrade_confirmed: Option<bool>) -> Result<Book, String> {
    open_book_with_upgrade(&host, &id, upgrade_confirmed == Some(true))
}
fn open_book(host: &MobileHost, id: &str) -> Result<Book, String> {
    open_book_with_upgrade(host, id, false)
}
fn open_book_with_upgrade(host: &MobileHost, id: &str, consent: bool) -> Result<Book, String> {
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
    let path = book_path(host, id)?;
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
    if store::SCHEMA_VERSION >= store::READ_SCHEMA_VERSION {
        crate::format_upgrade::retain_mobile(&path, store::SCHEMA_VERSION, consent)?;
    }
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
    current_scene_id: String,
    title: String,
) -> Result<CreatedScene, String> {
    host.create_scene(generation, &current_scene_id, &title)
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
fn mobile_figure_preview(
    host: State<'_, MobileHost>, generation: u64, item_id: String, instance_id: String, asset_id: String,
) -> Result<crate::pictures::PictureView, String> {
    let session = host.session.lock().map_err(|_| "book session unavailable")?;
    let open = checked(&session, generation)?;
    crate::figures::preview(&book_path(&host, &open.id)?, &open.store, &item_id, &instance_id, &asset_id)
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

fn manuscript_items(store: &store::Store) -> Result<Vec<store::Item>, String> {
    let items = store.items().map_err(|error| error.to_string())?;
    let excluded = store::excluded_from_book(&items);
    Ok(items
        .into_iter()
        .filter(|item| {
            !excluded.contains(&item.id)
                && matches!(item.item_type.as_str(), "part" | "chapter" | "scene")
        })
        .collect())
}
fn writing_scene(store: &store::Store, id: &str) -> Result<(), String> {
    if !scenes(store)?.iter().any(|scene| scene.id == id) {
        return Err("scene is not in the open book".into());
    }
    Ok(())
}
impl MobileHost {
    fn create_scene(
        &self,
        generation: u64,
        current_scene_id: &str,
        title: &str,
    ) -> Result<CreatedScene, String> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err("scene title must contain 1 to 120 characters".into());
        }
        self.drafting(generation, |store| {
            let current = scenes(store)?
                .into_iter()
                .find(|scene| scene.id == current_scene_id)
                .ok_or("scene is not in the open book")?;
            let created = store
                .item_create_after(
                    current.parent_id.as_deref(),
                    "scene",
                    title,
                    Some(&current.id),
                )
                .map_err(|error| error.to_string())?;
            Ok(CreatedScene {
                item_id: created.id,
                scenes: scenes(store)?,
            })
        })
    }
    fn drafting<T>(
        &self,
        generation: u64,
        work: impl FnOnce(&store::Store) -> Result<T, String>,
    ) -> Result<T, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "book session unavailable")?;
        idle(&session)?;
        work(&checked(&session, generation)?.store)
    }
    fn rename_scene(
        &self,
        generation: u64,
        id: &str,
        title: &str,
        base_rev: i64,
    ) -> Result<Vec<Scene>, String> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err("invalid scene title".into());
        }
        self.drafting(generation, |store| {
            writing_scene(store, id)?;
            store
                .item_rename(id, title, base_rev)
                .map_err(|error| error.to_string())?;
            scenes(store)
        })
    }
    fn move_scene(
        &self,
        generation: u64,
        id: &str,
        parent: Option<&str>,
        after: Option<&str>,
        base_rev: i64,
    ) -> Result<Vec<Scene>, String> {
        self.drafting(generation, |store| {
            writing_scene(store, id)?;
            let items = manuscript_items(store)?;
            if parent.is_some_and(|parent| !items.iter().any(|item| item.id == parent))
                || after.is_some_and(|after| {
                    after == id
                        || !items
                            .iter()
                            .any(|item| item.id == after && item.parent_id.as_deref() == parent)
                })
            {
                return Err("destination is not in the manuscript".into());
            }
            store
                .item_move(id, parent, after, base_rev)
                .map_err(|error| error.to_string())?;
            scenes(store)
        })
    }
    fn scene_notes(
        &self,
        generation: u64,
        id: &str,
        body: Option<&str>,
    ) -> Result<Option<store::synopsis::Synopsis>, String> {
        self.drafting(generation, |store| {
            writing_scene(store, id)?;
            match body {
                Some(body) => store.synopsis_set(id, body),
                None => store.synopsis(id),
            }
            .map_err(|error| error.to_string())
        })
    }
    fn scene_comments(
        &self,
        generation: u64,
        id: &str,
        resolve: Option<i64>,
    ) -> Result<Vec<store::comments::Comment>, String> {
        self.drafting(generation, |store| {
            writing_scene(store, id)?;
            let comments = store.comments(id).map_err(|error| error.to_string())?;
            if let Some(comment_id) = resolve {
                if !comments.iter().any(|comment| comment.id == comment_id) {
                    return Err("comment is not in this scene".into());
                }
                store
                    .comment_set_resolved(comment_id, true)
                    .map_err(|error| error.to_string())?;
                return store.comments(id).map_err(|error| error.to_string());
            }
            Ok(comments)
        })
    }
    fn goals(&self, generation: u64, day: &str, target: Option<&str>) -> Result<Goals, String> {
        self.drafting(generation, |store| {
            let summary = store
                .source_word_summary(day)
                .map_err(|error| error.to_string())?;
            let path = self
                .books
                .parent()
                .ok_or("settings directory unavailable")?
                .join("settings.json");
            let mut settings: serde_json::Map<String, serde_json::Value> = match fs::read(&path) {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|error| format!("cannot read settings: {error}"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
                Err(error) => return Err(error.to_string()),
            };
            if let Some(target) = target {
                let target = crate::daily_target::DailyTarget::parse(target)
                    .ok_or("invalid daily target")?;
                settings.insert("daily_target".into(), serde_json::json!(target));
                let mut stage = tempfile::NamedTempFile::new_in(path.parent().unwrap())
                    .map_err(|error| error.to_string())?;
                use std::io::Write;
                stage
                    .write_all(&serde_json::to_vec(&settings).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
                stage
                    .as_file()
                    .sync_all()
                    .map_err(|error| error.to_string())?;
                stage.persist(&path).map_err(|error| error.to_string())?;
                fs::File::open(path.parent().unwrap())
                    .and_then(|dir| dir.sync_all())
                    .map_err(|error| error.to_string())?;
            }
            let target = settings
                .get("daily_target")
                .and_then(|value| value.as_str())
                .and_then(crate::daily_target::DailyTarget::parse)
                .unwrap_or_default();
            Ok(Goals {
                target: target.as_str().into_owned(),
                today: summary.today_typing,
                collecting: summary.collecting,
                available: summary.available,
            })
        })
    }
}
#[derive(Serialize)]
struct Goals {
    target: String,
    today: Option<i64>,
    collecting: bool,
    available: bool,
}
#[tauri::command]
fn mobile_scene_rename(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
    title: String,
    base_rev: i64,
) -> Result<Vec<Scene>, String> {
    host.rename_scene(generation, &item_id, &title, base_rev)
}
#[tauri::command]
fn mobile_structure(
    host: State<'_, MobileHost>,
    generation: u64,
) -> Result<Vec<store::Item>, String> {
    host.drafting(generation, manuscript_items)
}
#[tauri::command]
fn mobile_scene_move(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
    new_parent_id: Option<String>,
    after_id: Option<String>,
    base_rev: i64,
) -> Result<Vec<Scene>, String> {
    host.move_scene(
        generation,
        &item_id,
        new_parent_id.as_deref(),
        after_id.as_deref(),
        base_rev,
    )
}
#[tauri::command]
fn mobile_scene_notes(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
) -> Result<Option<store::synopsis::Synopsis>, String> {
    host.scene_notes(generation, &item_id, None)
}
#[tauri::command]
fn mobile_scene_notes_set(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
    body: String,
) -> Result<Option<store::synopsis::Synopsis>, String> {
    host.scene_notes(generation, &item_id, Some(&body))
}
#[tauri::command]
fn mobile_goals(
    host: State<'_, MobileHost>,
    generation: u64,
    day: String,
    target: Option<String>,
) -> Result<Goals, String> {
    host.goals(generation, &day, target.as_deref())
}
#[tauri::command]
fn mobile_comments(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
) -> Result<Vec<store::comments::Comment>, String> {
    host.scene_comments(generation, &item_id, None)
}
#[tauri::command]
fn mobile_comment_resolve(
    host: State<'_, MobileHost>,
    generation: u64,
    item_id: String,
    comment_id: i64,
) -> Result<Vec<store::comments::Comment>, String> {
    host.scene_comments(generation, &item_id, Some(comment_id))
}
#[derive(Serialize)]
struct ReferenceNote {
    title: String,
    body: String,
}
#[derive(Serialize)]
struct Reference {
    notes: Vec<ReferenceNote>,
    cast: Vec<store::cast::CastMember>,
    skipped: usize,
}
fn reference_items(store: &store::Store) -> Result<Vec<(String, String)>, String> {
    let items = store.items().map_err(|error| error.to_string())?;
    let live = store::without_trashed(items);
    let mut bible_depth = None;
    let mut notes = Vec::new();
    for item in live {
        if bible_depth.is_some_and(|depth| item.depth <= depth) {
            bible_depth = None;
        }
        if item.depth == 0 && item.item_type == store::BIBLE_TYPE {
            bible_depth = Some(item.depth);
        } else if bible_depth.is_some()
            && item.item_type != store::TIMELINE_TYPE
            && store::carries_document(&item.item_type)
        {
            notes.push((item.id, item.title));
        }
    }
    Ok(notes)
}
fn reference(path: &std::path::Path, items: Vec<(String, String)>) -> Result<Reference, String> {
    let store = store::Store::open_readonly(path).map_err(|error| error.to_string())?;
    let mut notes = Vec::new();
    let mut skipped = 0;
    for (id, title) in items {
        match store.load_doc(&id).ok().and_then(|doc| store::document_text(&doc.body)) {
            Some(body) => notes.push(ReferenceNote { title, body }),
            None => skipped += 1,
        }
    }
    Ok(Reference {
        notes,
        cast: store.cast_list().map_err(|error| error.to_string())?,
        skipped,
    })
}
#[tauri::command]
async fn mobile_reference(host: State<'_, MobileHost>, generation: u64) -> Result<Reference, String> {
    let (path, items) = {
        let session = host.session.lock().map_err(|_| "book session unavailable")?;
        idle(&session)?;
        let open = checked(&session, generation)?;
        (book_path(&host, &open.id)?, reference_items(&open.store)?)
    };
    tauri::async_runtime::spawn_blocking(move || reference(&path, items))
        .await
        .map_err(|error| error.to_string())?
}
fn search_book(
    path: &std::path::Path,
    query: &str,
    current_scene: &str,
) -> Result<crate::find::FindResults, String> {
    let store = store::Store::open_readonly(path).map_err(|error| error.to_string())?;
    let mut scenes = scenes(&store)?;
    scenes.sort_by_key(|scene| scene.id != current_scene);
    let (fields, scanned, skipped) = store.document_search_fields().map_err(|error| error.to_string())?;
    let items: Vec<_> = scenes
        .iter()
        .map(|scene| crate::find::SearchItem {
            id: &scene.id,
            title: &scene.title,
            kind: "scene",
        })
        .collect();
    Ok(crate::find::search(
        &items,
        &crate::find::Corpus {
            texts: Default::default(),
            fields,
            scanned,
            skipped,
        },
        query,
        crate::find::DEFAULT_LIMIT,
    ))
}
#[tauri::command]
async fn mobile_find(
    host: State<'_, MobileHost>,
    generation: u64,
    query: String,
    current_scene: String,
) -> Result<crate::find::FindResults, String> {
    let path = {
        let session = host
            .session
            .lock()
            .map_err(|_| "book session unavailable")?;
        let open = checked(&session, generation)?;
        writing_scene(&open.store, &current_scene)?;
        book_path(&host, &open.id)?
    };
    tauri::async_runtime::spawn_blocking(move || search_book(&path, &query, &current_scene))
        .await
        .map_err(|error| error.to_string())?
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
            mobile_scene_rename,
            mobile_structure,
            mobile_scene_move,
            mobile_find,
            mobile_goals,
            mobile_scene_notes,
            mobile_scene_notes_set,
            mobile_reference,
            mobile_comments,
            mobile_comment_resolve,
            mobile_document,
            mobile_flush,
            mobile_close,
            mobile_figure_preview,
            mobile_transfer_start,
            mobile_transfer_choose,
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
    picker: Option<String>,
    archive_name: Option<String>,
    existing_key: bool,
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
    picker_ready: Option<tauri::async_runtime::Sender<()>>,
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
fn offer_picker(
    host: &MobileHost, token: &str, phase: &str, code: Option<String>,
) -> Result<tauri::async_runtime::Receiver<()>, String> {
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    admitted(&session, token)?;
    let job = session.transfer.as_mut().unwrap();
    let (send, receive) = tauri::async_runtime::channel(1);
    job.status.phase = phase.into();
    job.status.code = code;
    job.status.picker = Some(uuid::Uuid::now_v7().to_string());
    job.picker_ready = Some(send);
    Ok(receive)
}
fn choose_picker(host: &MobileHost, token: &str, picker: &str) -> Result<(), String> {
    let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
    let job = admitted(&session, token)?;
    if job.status.picker.as_deref() != Some(picker) {
        return Err("transfer_stale".into());
    }
    let job = session.transfer.as_mut().unwrap();
    job.picker_ready.take().ok_or("transfer_stale")?
        .try_send(()).map_err(|_| "transfer_stale")?;
    job.status.picker = None;
    job.status.code = None;
    Ok(())
}
#[tauri::command]
fn mobile_transfer_choose(host: State<'_, MobileHost>, token: String, picker: String) -> Result<(), String> {
    choose_picker(&host, &token, &picker)
}
async fn wait_for_picker(app: &tauri::AppHandle, token: &str, step: &str, code: Option<String>) -> Result<(), String> {
    let mut receive = offer_picker(&app.state::<MobileHost>(), token, step, code)?;
    receive.recv().await.ok_or("transfer_cancelled")?;
    phase(app, token, step)?;
    Ok(())
}
async fn pick_read(app: &tauri::AppHandle, token: &str, kind: Kind) -> Result<(), String> {
    let step = if kind == Kind::Key { "key" } else { "archive" };
    let mut retry = None;
    loop {
        wait_for_picker(app, token, step, retry.take()).await?;
        match read_picked(app, token, kind).await {
            Err(code) if code == "transfer_wrong_key" || code == "transfer_wrong_archive" => {
                let stage = phase(app, token, step)?;
                // Native read has drained. Only discard this step's private input.
                let path = stage.join(kind.file_name(Mode::Open));
                if path.exists() { fs::remove_file(path).map_err(|_| "transfer_cleanup")?; }
                retry = Some(code);
            }
            result => return result,
        }
    }
}
async fn read_picked(app: &tauri::AppHandle, token: &str, kind: Kind) -> Result<(), String> {
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
            "transfer_too_large" | "transfer_key" | "transfer_storage" | "transfer_restart"
        ) {
            if code == "transfer_key" { "transfer_wrong_key".into() } else { code }
        } else {
            "transfer_provider".into()
        }
    })?;
    phase(app, token, "preparing")?;
    let archive_name = receipt.display_name.as_ref().map(|name| name.chars()
        .filter(|ch| !ch.is_control() && !matches!(ch, '/' | '\\'))
        .take(120).collect()).filter(|name: &String| !name.is_empty());
    let path = stage.join(kind.file_name(Mode::Open));
    blocking(move || {
        if transfer::fingerprint(&path, limit)? != (receipt.bytes, receipt.sha256) {
            return Err("transfer_provider".into());
        }
        transfer::check_input(&path, kind)
    }).await?;
    if kind == Kind::Archive {
        let host = app.state::<MobileHost>();
        let mut session = host.session.lock().map_err(|_| "transfer_invalid")?;
        admitted(&session, token)?;
        session.transfer.as_mut().unwrap().status.archive_name = archive_name;
    }
    Ok(())
}
async fn pick_write(
    app: &tauri::AppHandle,
    token: &str,
    kind: Kind,
    digest: (u64, String),
) -> Result<(), String> {
    wait_for_picker(app, token, if kind == Kind::Key { "save_key" } else { "save_archive" }, None).await?;
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
        picker: None,
        archive_name: None,
        existing_key: false,
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
        picker_ready: None,
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
    if direction == Direction::Export && matches!(key_choice, KeyChoice::Existing) {
        host.session.lock().map_err(|_| "transfer_invalid")?.transfer.as_mut().unwrap().status.existing_key = true;
    }
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
        job.picker_ready = None;
        job.status.picker = None;
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

    fn drafting_host() -> (tempfile::TempDir, MobileHost, Book) {
        let root = tempfile::tempdir().unwrap();
        let (host, id) = host(root.path());
        let book = open_book(&host, &id).unwrap();
        (root, host, book)
    }
    #[test]
    fn mobile_transferred_presets_create_scenes_in_order_without_scaffolding() {
        for preset in ["short", "nonfiction", "collection"] {
            let root = tempfile::tempdir().unwrap();
            let (host, _) = host(root.path());
            let source = root.path().join("source.db");
            let store = store::Store::open(&source).unwrap();
            store.set_meta(NAME_KEY, "Harbour").unwrap();
            store.set_meta("project.preset", preset).unwrap();
            store
                .ensure_starter_structure(&strings::Strings::new(&strings::EN))
                .unwrap();
            let other_story = if preset == "collection" {
                let story = store.item_create(None, "chapter", "Second story").unwrap();
                let scene = store.item_create(Some(&story.id), "scene", "Forest").unwrap();
                store.set_meta(&format!("collection.author.{}", story.id), "Other Author").unwrap();
                Some((story.id, scene.id))
            } else { None };
            let stage =
                transfer::stage(&host.transfers, &uuid::Uuid::now_v7().to_string()).unwrap();
            let bundle = transfer::snapshot(&source, &store, &stage).unwrap();
            let key = stage.join("key.in");
            crate::encrypted_archive::generate_key(&key).unwrap();
            transfer::encrypt(&bundle, &stage, &key).unwrap();
            fs::copy(stage.join("archive.out"), stage.join("archive.in")).unwrap();
            let preview = transfer::preview(&stage, &host.books).unwrap();
            let id = transfer::publish(&stage, &host.books, &preview).unwrap();
            let book = open_book(&host, &id).unwrap();
            let first = &book.scenes[0];
            assert_eq!(first.depth, if preset == "short" { 0 } else { 1 });
            let second = host
                .create_scene(book.generation, &first.id, "Second")
                .unwrap();
            let third = host
                .create_scene(book.generation, &second.item_id, "Third")
                .unwrap();
            let between = host
                .create_scene(book.generation, &first.id, "Between")
                .unwrap();
            assert_eq!(
                between
                    .scenes
                    .iter()
                    .filter(|scene| scene.parent_id == first.parent_id)
                    .map(|scene| scene.id.as_str())
                    .collect::<Vec<_>>(),
                [&first.id, &between.item_id, &second.item_id, &third.item_id]
            );
            host.drafting(book.generation, |store| {
                let items = manuscript_items(store)?;
                assert_eq!(
                    items
                        .iter()
                        .filter(|item| item.item_type == "chapter")
                        .count(),
                    if preset == "short" { 0 } else if preset == "collection" { 2 } else { 1 }
                );
                assert!(!items.iter().any(|item| item.item_type == "part"));
                assert_eq!(
                    store.get_meta("project.preset").unwrap().as_deref(),
                    Some(preset)
                );
                assert_eq!(
                    store
                        .items()
                        .unwrap()
                        .iter()
                        .filter(|item| item.item_type == "scene")
                        .count(),
                    if preset == "collection" { 5 } else { 4 }
                );
                Ok(())
            })
            .unwrap();
            assert_eq!(scenes(&store).unwrap().len(), if preset == "collection" { 2 } else { 1 });
            if let Some((story, scene)) = other_story {
                let first_before = host.drafting(book.generation, |store| Ok(store.documents().unwrap())).unwrap();
                let added = host.create_scene(book.generation, &scene, "Inside second story").unwrap();
                let new_scene = added.scenes.iter().find(|row| row.id == added.item_id).unwrap();
                assert_eq!(new_scene.parent_id.as_deref(), Some(story.as_str()));
                assert_eq!(added.scenes.iter().filter(|row| row.parent_id == first.parent_id).map(|row| row.id.clone()).collect::<Vec<_>>(), between.scenes.iter().filter(|row| row.parent_id == first.parent_id).map(|row| row.id.clone()).collect::<Vec<_>>());
                host.drafting(book.generation, |store| {
                    let after = store.documents().unwrap();
                    for (id, body) in &first_before { assert_eq!(after.get(id), Some(body)); }
                    assert_eq!(store.get_meta(&format!("collection.author.{story}")).unwrap().as_deref(), Some("Other Author"));
                    Ok(())
                }).unwrap();
            }
            if preset == "short" {
                let nested = host
                    .drafting(book.generation, |store| {
                        let chapter = store
                            .item_create(None, "chapter", "Explicit chapter")
                            .unwrap();
                        let nested = store
                            .item_create(Some(&chapter.id), "scene", "Inside")
                            .unwrap();
                        Ok((nested.id, chapter.id))
                    })
                    .unwrap();
                let added = host
                    .create_scene(book.generation, &nested.0, "Still inside")
                    .unwrap();
                assert!(added.scenes[..4]
                    .iter()
                    .all(|scene| scene.parent_id.is_none()));
                assert!(added.scenes[4..]
                    .iter()
                    .all(|scene| scene.parent_id.as_deref() == Some(nested.1.as_str())));
                host.drafting(book.generation, |store| {
                    assert!(!store
                        .items()
                        .unwrap()
                        .iter()
                        .any(|item| item.item_type == "part"));
                    Ok(())
                })
                .unwrap();
            }
        }
    }

    #[test]
    fn mobile_new_scene_stays_in_the_current_container_and_preserves_outline_context() {
        let (_root, host, book) = drafting_host();
        let first = &book.scenes[0];
        let (chapter, second) = host
            .drafting(book.generation, |store| {
                let chapter = store.item_create(None, "chapter", "Later").unwrap();
                let scene = store
                    .item_create(Some(&chapter.id), "scene", "Second")
                    .unwrap();
                Ok((chapter, scene))
            })
            .unwrap();
        let created = host
            .create_scene(book.generation, &second.id, "Next")
            .unwrap();
        assert_eq!(
            created
                .scenes
                .iter()
                .map(|scene| scene.id.as_str())
                .collect::<Vec<_>>(),
            [&first.id, &second.id, &created.item_id]
        );
        assert_eq!(created.scenes[0].parent_id, first.parent_id);
        for scene in &created.scenes[1..] {
            assert_eq!(scene.parent_id.as_deref(), Some(chapter.id.as_str()));
            assert_eq!(scene.context.len(), 1);
            assert_eq!(scene.context[0].title, "Later");
        }
    }

    #[test]
    fn mobile_new_scene_refuses_stale_missing_and_excluded_context_without_writes() {
        let (_root, host, book) = drafting_host();
        let first = &book.scenes[0];
        let hidden = host
            .drafting(book.generation, |store| {
                let bible = store.item_create(None, "bible", "Notes").unwrap();
                let hidden = store
                    .item_create(Some(&bible.id), "scene", "Hidden")
                    .unwrap();
                Ok(hidden.id)
            })
            .unwrap();
        for (generation, id) in [
            (book.generation + 1, first.id.as_str()),
            (book.generation, "missing"),
            (book.generation, hidden.as_str()),
            (book.generation, first.parent_id.as_deref().unwrap()),
        ] {
            assert!(host.create_scene(generation, id, "Lost").is_err());
        }
        host.drafting(book.generation, |store| {
            assert_eq!(
                store
                    .items()
                    .unwrap()
                    .iter()
                    .filter(|item| item.item_type == "scene")
                    .count(),
                2
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn mobile_drafting_rename_and_move_preserve_structure_and_refuse_stale_revisions() {
        let (_root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        let (chapter, second) = host
            .drafting(book.generation, |store| {
                let chapter = store.item_create(None, "chapter", "Later").unwrap();
                let second = store
                    .item_create(scene.parent_id.as_deref(), "scene", "Second")
                    .unwrap();
                Ok((chapter, second))
            })
            .unwrap();
        let renamed = host
            .rename_scene(book.generation, &scene.id, "  New title  ", scene.rev)
            .unwrap();
        assert_eq!(renamed[0].title, "New title");
        assert!(host
            .rename_scene(book.generation, &scene.id, "Lost", scene.rev)
            .is_err());
        let moved = host
            .move_scene(
                book.generation,
                &scene.id,
                scene.parent_id.as_deref(),
                Some(&second.id),
                renamed[0].rev,
            )
            .unwrap();
        assert_eq!(
            moved
                .iter()
                .map(|scene| scene.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), scene.id.as_str()]
        );
        let rev = moved.iter().find(|row| row.id == scene.id).unwrap().rev;
        let moved = host
            .move_scene(book.generation, &scene.id, Some(&chapter.id), None, rev)
            .unwrap();
        let row = moved.iter().find(|row| row.id == scene.id).unwrap();
        assert_eq!(row.parent_id.as_deref(), Some(chapter.id.as_str()));
        assert_eq!(row.context.last().unwrap().title, "Later");
        assert!(host
            .move_scene(book.generation, &scene.id, None, None, rev)
            .is_err());
        host.drafting(book.generation, |store| {
            let stored = store.items().unwrap();
            assert_eq!(
                stored.iter().find(|row| row.id == chapter.id).unwrap().rev,
                chapter.rev
            );
            assert_eq!(store.load_doc(&scene.id).unwrap().rev, 1);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn mobile_drafting_mutations_refuse_containers_excluded_destinations_and_older_sessions() {
        let (_root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        let (bin, bible, hidden) = host
            .drafting(book.generation, |store| {
                let bin = store
                    .item_create(None, store::TRASH_TYPE, "Removed")
                    .unwrap();
                let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
                let hidden = store.item_create(Some(&bin.id), "scene", "Hidden").unwrap();
                Ok((bin, bible, hidden))
            })
            .unwrap();
        for row in [&bin, &bible, &hidden] {
            assert!(host
                .rename_scene(book.generation, &row.id, "No", row.rev)
                .is_err());
            assert!(host
                .move_scene(book.generation, &scene.id, Some(&row.id), None, scene.rev)
                .is_err());
            assert!(host
                .scene_notes(book.generation, &row.id, Some("No"))
                .is_err());
        }
        let chapter = scene.parent_id.as_deref().unwrap();
        assert!(host
            .rename_scene(book.generation, chapter, "No", 1)
            .is_err());
        assert!(host
            .move_scene(book.generation, chapter, None, None, 1)
            .is_err());
        assert!(host
            .move_scene(book.generation, &scene.id, Some(&scene.id), None, scene.rev)
            .is_err());
        assert!(host
            .rename_scene(book.generation + 1, &scene.id, "No", scene.rev)
            .is_err());
        assert!(host
            .move_scene(book.generation + 1, &scene.id, None, None, scene.rev)
            .is_err());
        assert!(host
            .scene_notes(book.generation + 1, &scene.id, Some("No"))
            .is_err());
        assert!(host
            .goals(book.generation + 1, "2026-10-17", Some("500"))
            .is_err());
        assert!(host
            .scene_comments(book.generation + 1, &scene.id, None)
            .is_err());
        assert_eq!(
            host.drafting(book.generation, scenes).unwrap()[0].title,
            scene.title
        );
    }
    #[test]
    fn mobile_drafting_search_prioritizes_current_scene_and_uses_desktop_folding() {
        let (_root, host, book) = drafting_host();
        let first = &book.scenes[0];
        let second = host.drafting(book.generation, |store| {
            let second = store.item_create(first.parent_id.as_deref(), "scene", "Second").unwrap();
            let bin = store.item_create(None, store::TRASH_TYPE, "Bin").unwrap();
            let hidden = store.item_create(Some(&bin.id), "scene", "needle hidden").unwrap();
            for id in [&first.id, &second.id, &hidden.id] {
                store.flush(&[store::FlushEntry { item_id: id.clone(), base_rev: 1, body: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"İstanbul NEEDLE"}]}]}"#.into(), comments: None }]).unwrap();
            }
            Ok(second)
        }).unwrap();
        let path = book_path(&host, &book.id).unwrap();
        let result = search_book(&path, "  needle  ", &second.id).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.results[0].item_id, second.id);
        assert_eq!(result.results[1].item_id, first.id);
        assert!(result.results[0].snippet.contains("NEEDLE"));
        assert_eq!(search_book(&path, "İSTANBUL", &second.id).unwrap().total, 2);
        assert_eq!(search_book(&path, "  ", &second.id).unwrap().total, 0);
    }
    #[test]
    fn mobile_drafting_goals_share_desktop_settings_and_typed_progress_without_rewriting_legacy_baseline(
    ) {
        let (root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        fs::write(
            root.path().join("settings.json"),
            r#"{"daily_target":"250","theme":"dark"}"#,
        )
        .unwrap();
        host.drafting(book.generation, |store| {
            store.set_meta(crate::core_constants::DAY_BASELINE_KEY, "legacy bytes").unwrap();
            crate::mobile_core::flush(store, book.generation, book.generation,
                &[store::FlushEntry { item_id: scene.id.clone(), base_rev: 1, body: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"one two three"}]}]}"#.into(), comments: None }],
                &[store::source_words::FlushAttribution { item_id: scene.id.clone(), day: "2026-10-17".into(), changes: vec![store::source_words::SourceMovement { source: store::source_words::WordSource::Typing, added: 3, deleted: 0 }] }])?;
            Ok(())
        }).unwrap();
        let goals = host.goals(book.generation, "2026-10-17", None).unwrap();
        assert_eq!(goals.target, "250");
        assert_eq!(goals.today, Some(3));
        assert_eq!(
            host.goals(book.generation, "2026-10-18", Some("750"))
                .unwrap()
                .today,
            Some(0)
        );
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(root.path().join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["daily_target"], "750");
        assert_eq!(settings["theme"], "dark");
        let parsed: crate::daily_target::DailyTarget =
            serde_json::from_value(settings["daily_target"].clone()).unwrap();
        assert_eq!(parsed.as_str(), "750");
        assert!(host
            .goals(book.generation, "2026-10-17", Some("007"))
            .is_err());
        assert!(host.goals(book.generation, "bad", Some("100")).is_err());
        assert_eq!(
            host.goals(book.generation, "2026-10-17", None)
                .unwrap()
                .target,
            "750"
        );
        host.drafting(book.generation, |store| {
            assert_eq!(
                store
                    .get_meta(crate::core_constants::DAY_BASELINE_KEY)
                    .unwrap()
                    .as_deref(),
                Some("legacy bytes")
            );
            store.set_source_words_collecting(false).unwrap();
            Ok(())
        })
        .unwrap();
        assert!(
            !host
                .goals(book.generation, "2026-10-17", None)
                .unwrap()
                .collecting
        );
    }
    #[test]
    fn mobile_drafting_scene_notes_share_the_synopsis_and_preserve_prose() {
        let (_root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        assert!(host
            .scene_notes(book.generation, &scene.id, None)
            .unwrap()
            .is_none());
        host.scene_notes(book.generation, &scene.id, Some("  Remember the letter  "))
            .unwrap();
        host.drafting(book.generation, |store| {
            assert_eq!(
                store.synopsis(&scene.id).unwrap().unwrap().body,
                "Remember the letter"
            );
            assert_eq!(
                store.load_doc(&scene.id).unwrap().body,
                store::EMPTY_DOC_BODY
            );
            store.synopsis_set(&scene.id, "Desktop edit").unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            host.scene_notes(book.generation, &scene.id, None)
                .unwrap()
                .unwrap()
                .body,
            "Desktop edit"
        );
        assert!(host
            .scene_notes(book.generation, &scene.id, Some("  "))
            .unwrap()
            .is_none());
    }
    #[test]
    fn mobile_drafting_references_are_readonly_and_comments_resolve_only_in_the_requested_scene() {
        let (_root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        let path = book_path(&host, &book.id).unwrap();
        let (comment, other) = host.drafting(book.generation, |store| {
            let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
            let note = store.item_create(Some(&bible.id), "note", "Setting").unwrap();
            store.flush(&[store::FlushEntry { item_id: note.id, base_rev: 1, body: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The harbour"}]}]}"#.into(), comments: None }]).unwrap();
            let member = store.cast_create("character", "Ada").unwrap();
            store.cast_create("character", "Removed").and_then(|member| store.cast_remove(&member.id)).unwrap();
            let reference = reference(&path, reference_items(store).unwrap()).unwrap();
            assert_eq!(reference.notes.len(), 1); assert_eq!(reference.notes[0].body, "The harbour");
            assert_eq!(reference.cast.len(), 1); assert_eq!(reference.cast[0].id, member.id);
            let comment = store.comment_create(&scene.id, "Check this", 1, 2, "Old passage").unwrap();
            let second = store.item_create(scene.parent_id.as_deref(), "scene", "Second").unwrap();
            let other = store.comment_create(&second.id, "Keep open", 1, 2, "Other").unwrap();
            Ok((comment, other))
        }).unwrap();
        assert!(host
            .scene_comments(book.generation, &scene.id, Some(other.id))
            .is_err());
        let comments = host
            .scene_comments(book.generation, &scene.id, Some(comment.id))
            .unwrap();
        assert!(comments[0].resolved);
        assert_eq!(comments[0].body, "Check this");
        assert_eq!(comments[0].quote, "Old passage");
        host.drafting(book.generation, |store| {
            assert!(!store.comments(&other.item_id).unwrap()[0].resolved);
            assert_eq!(store.load_doc(&scene.id).unwrap().rev, 1);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn mobile_drafting_reference_skips_timelines_and_unreadable_notes() {
        let (_root, host, book) = drafting_host();
        let broken = host.drafting(book.generation, |store| {
            let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
            store.item_create(Some(&bible.id), "note", "Readable").unwrap();
            store.item_create(Some(&bible.id), store::TIMELINE_TYPE, "Timeline").unwrap();
            Ok(store.item_create(Some(&bible.id), "note", "Unreadable").unwrap())
        }).unwrap();
        let path = book_path(&host, &book.id).unwrap();
        rusqlite::Connection::open(&path).unwrap().execute(
            "UPDATE doc SET body = 'unreadable' WHERE item_id = ?1", [&broken.id],
        ).unwrap();
        let app = tauri::test::mock_builder().manage(host)
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let found = tauri::async_runtime::block_on(mobile_reference(app.state(), book.generation)).unwrap();
        assert_eq!(found.skipped, 1);
        assert_eq!(found.notes.len(), 1);
        assert_eq!(found.notes[0].title, "Readable");
    }
    #[test]
    fn mobile_drafting_commands_refuse_during_an_active_transfer() {
        let (_root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        start_transfer(&host, Direction::Export, book.generation).unwrap();
        let app = tauri::test::mock_builder().manage(host)
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        for command in ["rename", "structure", "move", "synopsis", "synopsis_set", "goals", "goals_set", "comments", "resolve", "reference"] {
            let state = app.state::<MobileHost>();
            let result = match command {
                "rename" => mobile_scene_rename(state, book.generation, scene.id.clone(), "Renamed".into(), scene.rev).map(|_| ()),
                "structure" => mobile_structure(state, book.generation).map(|_| ()),
                "move" => mobile_scene_move(state, book.generation, scene.id.clone(), None, None, scene.rev).map(|_| ()),
                "synopsis" => mobile_scene_notes(state, book.generation, scene.id.clone()).map(|_| ()),
                "synopsis_set" => mobile_scene_notes_set(state, book.generation, scene.id.clone(), "Remember".into()).map(|_| ()),
                "goals" | "goals_set" => mobile_goals(state, book.generation, "2026-10-17".into(), (command == "goals_set").then(|| "500".into())).map(|_| ()),
                "comments" => mobile_comments(state, book.generation, scene.id.clone()).map(|_| ()),
                "resolve" => mobile_comment_resolve(state, book.generation, scene.id.clone(), 1).map(|_| ()),
                "reference" => tauri::async_runtime::block_on(mobile_reference(state, book.generation)).map(|_| ()),
                _ => unreachable!(),
            };
            assert_eq!(result.unwrap_err(), "transfer_busy", "{command}");
        }
    }
    #[test]
    fn mobile_drafting_find_wrapper_checks_generation_and_scene_but_allows_transfer_reads() {
        let (_root, host, book) = drafting_host();
        let scene = &book.scenes[0];
        let app = tauri::test::mock_builder().manage(host)
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let state = app.state::<MobileHost>();
        let stale = tauri::async_runtime::block_on(mobile_find(state.clone(), book.generation + 1, "query".into(), scene.id.clone()));
        assert!(matches!(stale, Err(message) if message == "this request belongs to an older book session"));
        let container = tauri::async_runtime::block_on(mobile_find(state.clone(), book.generation, "query".into(), scene.parent_id.clone().unwrap()));
        assert!(matches!(container, Err(message) if message == "scene is not in the open book"));
        start_transfer(&state, Direction::Export, book.generation).unwrap();
        assert!(tauri::async_runtime::block_on(mobile_find(state, book.generation, "query".into(), scene.id.clone())).is_ok());
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
    fn schema18_reader_mobile_opens_edits_and_reopens_all_supported_presets() {
        for preset in [None, Some("novel"), Some("short"), Some("nonfiction"), Some("collection")] {
            let root = tempfile::tempdir().unwrap();
            let (host, id) = host(root.path());
            let path = book_path(&host, &id).unwrap();
            let (store, scene, body) = store::test_support::reader_fixture(&path);
            if let Some(preset) = preset { store.set_meta("project.preset", preset).unwrap(); }
            store.checkpoint().unwrap();
            drop(store);
            open_book(&host, &id).unwrap();
            let session = host.session.lock().unwrap();
            let open = checked(&session, session.generation).unwrap();
            assert_eq!(open.store.user_version().unwrap(), 18);
            assert_eq!(open.store.load_doc(&scene).unwrap().body, body);
            let edited = body.replace("Surrounding prose", "Mobile prose");
            crate::mobile_core::flush(&open.store, session.generation, session.generation, &[store::FlushEntry { item_id: scene.clone(), body: edited.clone(), base_rev: 1, comments: None }], &[]).unwrap();
            drop(session);
            // Opening the saved book through a fresh handle must preserve N.
            let reader = store::Store::open_existing(&path).unwrap();
            assert_eq!(reader.user_version().unwrap(), 18);
            assert_eq!(reader.load_doc(&scene).unwrap().body, edited);
        }
    }

    #[test]
    fn mobile_transfer_open_refuses_schema_before_preset_without_library_changes() {
        for (preset, version, code) in [
            ("zzz", 17, "unsupported_project_preset"),
            ("zzz", 18, "unsupported_project_preset"),
            ("novel", 19, "unsupported_schema"),
            ("short", 19, "unsupported_schema"),
            ("nonfiction", 19, "unsupported_schema"),
            ("collection", 19, "unsupported_schema"),
            ("zzz", 19, "unsupported_schema"),
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
                if version == 18 {
                    connection.execute_batch(store::figure_assets::PROPOSED_MIGRATION).unwrap();
                }
                connection.pragma_update(None, "user_version", version).unwrap();
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
                    "{preset} {version}"
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
                        assert_eq!(after.get(path), Some(bytes), "{preset} {version} WAL={wal}");
                    }
                }
                drop(connection);
            }
        }
    }
    #[test]
    fn mobile_picker_requires_a_fresh_tap_and_cancellation_wakes_the_waiter() {
        let root = tempfile::tempdir().unwrap();
        let (host, _) = host(root.path());
        let generation = host.session.lock().unwrap().generation;
        let status = start_transfer(&host, Direction::Import, generation).unwrap();
        let mut first = offer_picker(&host, &status.token, "archive", None).unwrap();
        assert!(first.try_recv().is_err());
        let picker = host.session.lock().unwrap().transfer.as_ref().unwrap().status.picker.clone().unwrap();
        assert!(choose_picker(&host, &status.token, "stale").is_err());
        choose_picker(&host, &status.token, &picker).unwrap();
        assert_eq!(first.try_recv(), Ok(()));
        assert!(choose_picker(&host, &status.token, &picker).is_err());
        let mut retry = offer_picker(&host, &status.token, "archive", Some("transfer_wrong_archive".into())).unwrap();
        assert!(choose_picker(&host, &status.token, &picker).is_err());
        assert!(retry.try_recv().is_err());
        cancel_transfer(&host, &status.token).unwrap();
        assert!(tauri::async_runtime::block_on(retry.recv()).is_none());
        let session = host.session.lock().unwrap();
        assert!(session.transfer.as_ref().unwrap().running);
        assert!(admitted(&session, &status.token).is_err());
        assert!(idle(&session).is_err());
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
                picker: None,
                archive_name: None,
                existing_key: false,
            },
            generation: opened.generation,
            book_id,
            stage: host.transfers.join(&token),
            canceled: Arc::new(AtomicBool::new(false)),
            running: true,
            direction: Direction::Export,
            uncertain_write: false,
            picker_ready: None,
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
                picker: None,
                archive_name: None,
                existing_key: false,
            },
            generation: opened.generation,
            book_id,
            stage: host.transfers.join(&token),
            canceled: Arc::new(AtomicBool::new(false)),
            running: true,
            direction: Direction::Export,
            uncertain_write: false,
            picker_ready: None,
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
