//! Verified, private owned copies. Platform adapters own final publication.
use crate::{backup_bundle, pictures, research, store::Store};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use crate::store::book_identity::TRANSFER_LINEAGE_KEY as LINEAGE_KEY;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Source {
    pub book_id: String,
    pub lineage: String,
    pub title: Option<String>,
    pub snapshot: String,
}

pub(crate) struct OwnedCopy {
    pub database: PathBuf,
    pub book_id: String,
    pub source: Source,
}

fn valid_identity(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn lineage(store: &Store) -> Result<String, String> {
    let id = store
        .get_meta(LINEAGE_KEY)
        .map_err(|e| e.to_string())?
        .or(store.book_id().map_err(|e| e.to_string())?)
        .ok_or("transfer source has no book identity")?;
    if !valid_identity(&id) {
        return Err("transfer lineage is malformed".into());
    }
    Ok(id)
}

pub(crate) fn inspect(bundle: &Path) -> Result<Source, String> {
    backup_bundle::verify(bundle)?;
    let store = Store::open_readonly(&backup_bundle::db_path(bundle)).map_err(|e| e.to_string())?;
    let book_id = store
        .book_id()
        .map_err(|e| e.to_string())?
        .ok_or("transfer source has no book identity")?;
    let lineage = lineage(&store)?;
    let title = store
        .get_meta(crate::core_constants::NAME_KEY)
        .map_err(|e| e.to_string())?
        .filter(|title| !title.trim().is_empty());
    let mut inventory = backup_bundle::open_regular_with_limit(
        &bundle.join(backup_bundle::INVENTORY_NAME),
        backup_bundle::MAX_INVENTORY_BYTES,
    )?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut remaining = backup_bundle::MAX_INVENTORY_BYTES;
    loop {
        let size = inventory
            .read(&mut buffer)
            .map_err(|_| "transfer inventory unreadable")?;
        if size == 0 {
            break;
        }
        remaining = remaining
            .checked_sub(size as u64)
            .ok_or("transfer inventory grew beyond its limit")?;
        hash.update(&buffer[..size]);
    }
    Ok(Source {
        book_id,
        lineage,
        title,
        snapshot: format!("{:x}", hash.finalize()),
    })
}

/// `parent` is a host-owned private stage. A failure retains its claimed copy
/// for inspection; this function never publishes to a library or deletes data.
pub(crate) fn stage(bundle: &Path, parent: &Path, expected: &Source) -> Result<OwnedCopy, String> {
    let source = inspect(bundle)?;
    if &source != expected {
        return Err("transfer source changed after preview".into());
    }
    let dir = parent.join("owned-copy");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&dir)
        .map_err(|_| "transfer copy stage already exists or is unavailable")?;
    let database = dir.join("book.db");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&database)
        .map_err(|_| "cannot claim transfer database")?;
    fs::create_dir(pictures::dir_for(&database)).map_err(|_| "cannot claim transfer pictures")?;
    builder
        .create(research::dir_for(&database))
        .map_err(|_| "cannot claim transfer research")?;
    backup_bundle::copy_database(&backup_bundle::db_path(bundle), &database)?;
    backup_bundle::verify_database_copy(bundle, &database)?;
    backup_bundle::copy_assets(bundle, &database)?;
    // Bind copying to the reviewed source, including all asset metadata.
    if inspect(bundle)? != source {
        return Err("transfer source changed during copy".into());
    }
    backup_bundle::clear_marker(&database)?;
    let store = Store::open_existing(&database).map_err(|e| e.to_string())?;
    let book_id = store
        .fork_transferred_book_identity(&source.book_id, &source.lineage, &source.snapshot)
        .map_err(|e| e.to_string())?;
    store.checkpoint().map_err(|e| e.to_string())?;
    drop(store);
    let validation = crate::validation::validate(&database).map_err(|e| e.to_string())?;
    if !validation.ok {
        return Err("owned transfer copy failed validation".into());
    }
    fs::OpenOptions::new()
        .write(true)
        .open(&database)
        .and_then(|file| file.sync_all())
        .map_err(|_| "transfer database sync failed")?;
    backup_bundle::sync_directory(&pictures::dir_for(&database))?;
    backup_bundle::sync_directory(&research::dir_for(&database))?;
    backup_bundle::sync_directory(&dir)?;
    backup_bundle::sync_directory(parent)?;
    Ok(OwnedCopy {
        database,
        book_id,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FlushEntry;

    fn point(database: &Path, target: &Path) {
        let store = Store::open_readonly(database).unwrap();
        assert!(
            backup_bundle::write(database, &store, target)
                .unwrap()
                .verified
        );
    }

    #[test]
    fn repeated_transfer_forks_ownership_and_preserves_lineage_and_originals() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("original.db");
        let store = Store::open(&database).unwrap();
        store
            .set_meta(crate::core_constants::NAME_KEY, "Harbour")
            .unwrap();
        let scene = store.item_create(None, "scene", "Arrival").unwrap();
        let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The tide waited."}]}]}"#;
        let entry = FlushEntry {
            item_id: scene.id.clone(),
            body: body.into(),
            base_rev: scene.doc_rev.unwrap(),
            comments: None,
        };
        store.flush(&[entry.clone()]).unwrap();
        store.record_versions(&[entry]).unwrap();
        let original_id = store.book_id().unwrap().unwrap();
        store.checkpoint().unwrap();
        drop(store);
        let first = root.path().join("first.point");
        point(&database, &first);
        let before = fs::read(&database).unwrap();
        let expected = inspect(&first).unwrap();
        let private = root.path().join("private");
        fs::create_dir(&private).unwrap();
        let copied = stage(&first, &private, &expected).unwrap();
        research::private_dir(&research::dir_for(&copied.database)).unwrap();
        assert_ne!(copied.book_id, original_id);
        assert_eq!(copied.source.lineage, original_id);
        assert_eq!(fs::read(&database).unwrap(), before);
        let second = root.path().join("second.point");
        point(&copied.database, &second);
        let next = inspect(&second).unwrap();
        assert_eq!(next.lineage, original_id);
        assert_eq!(next.book_id, copied.book_id);
        let private2 = root.path().join("private2");
        fs::create_dir(&private2).unwrap();
        let twice = stage(&second, &private2, &next).unwrap();
        assert_ne!(twice.book_id, copied.book_id);
        assert_ne!(twice.book_id, original_id);
        let read = Store::open_readonly(&twice.database).unwrap();
        assert_eq!(read.load_doc(&scene.id).unwrap().body, body);
        assert!(!read.doc_versions(&scene.id).unwrap().is_empty());
        assert_eq!(lineage(&read).unwrap(), original_id);
        assert!(stage(&second, &private2, &next).is_err());
        assert_eq!(read.book_id().unwrap().unwrap(), twice.book_id);
        let mut stale = expected.clone();
        stale.snapshot = "0".repeat(64);
        let unused = root.path().join("unused");
        fs::create_dir(&unused).unwrap();
        assert!(stage(&first, &unused, &stale).is_err());
        assert!(!unused.join("owned-copy").exists());
    }

    #[test]
    fn malformed_lineage_is_refused_without_repairing_the_source() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("book.db");
        let store = Store::open(&database).unwrap();
        store.set_meta(LINEAGE_KEY, "../../another-book").unwrap();
        assert!(lineage(&store).is_err());
        assert_eq!(
            store.get_meta(LINEAGE_KEY).unwrap().as_deref(),
            Some("../../another-book")
        );
    }

    #[test]
    fn unnamed_legacy_books_leave_title_localization_to_the_adapter() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("book.db");
        let store = Store::open(&database).unwrap();
        store.item_create(None, "scene", "Arrival").unwrap();
        drop(store);
        let bundle = root.path().join("source.point");
        point(&database, &bundle);
        assert_eq!(inspect(&bundle).unwrap().title, None);
    }
}
