use crate::{core_constants::NAME_KEY, store, strings};
use serde::Serialize;
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
}

struct MobileHost {
    books: PathBuf,
    session: Mutex<Session>,
}

#[derive(Serialize)]
struct BookName {
    id: String,
    name: String,
    unavailable: bool,
}

#[derive(Serialize)]
struct Catalog {
    books: Vec<BookName>,
    current_id: Option<String>,
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
        let name = (|| -> Result<String, String> {
            book_path(&host, id)?;
            if !regular {
                return Err("book path is not a regular file".into());
            }
            let store = store::Store::open_readonly(&path).map_err(|error| error.to_string())?;
            store
                .get_meta(NAME_KEY)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "book has no name".into())
        })();
        match name {
            Ok(name) => books.push(BookName {
                id: id.into(),
                name,
                unavailable: false,
            }),
            Err(error) => {
                eprintln!("library: book {id} is unavailable: {error}");
                books.push(BookName {
                    id: id.into(),
                    name: String::new(),
                    unavailable: true,
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
        books,
        current_id: session.open.as_ref().map(|book| book.id.clone()),
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
    let mut session = host
        .session
        .lock()
        .map_err(|_| "book session unavailable")?;
    if let Some(open) = &session.open {
        if open.id == id {
            return book_view(&session);
        }
        return Err("close the current book before opening another".into());
    }
    let path = book_path(&host, &id)?;
    let store = store::Store::open_existing(&path).map_err(|error| error.to_string())?;
    let name = store
        .get_meta(NAME_KEY)
        .map_err(|error| error.to_string())?
        .ok_or("book has no name")?;
    next_generation(&mut session)?;
    session.open = Some(OpenBook { id, name, store });
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
    let open = checked(&session, generation)?;
    open.store.checkpoint().map_err(|error| error.to_string())?;
    session.open = None;
    next_generation(&mut session)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let books = app.path().app_data_dir()?.join("books");
            fs::create_dir_all(&books)?;
            app.manage(MobileHost {
                books,
                session: Mutex::new(Session {
                    generation: 0,
                    open: None,
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
        ])
        .run(tauri::generate_context!())
        .expect("mobile host failed to start");
}
