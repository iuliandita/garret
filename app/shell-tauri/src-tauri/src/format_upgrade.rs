//! A complete, verified rollback copy must precede a format upgrade.
use crate::{backup_bundle, store::Store};
use std::path::{Path, PathBuf};

pub(crate) fn required(path: &Path, target: i64) -> Result<bool, String> {
    let reader = Store::open_readonly(path).map_err(|error| error.to_string())?;
    Ok(reader.user_version().map_err(|error| error.to_string())? < target)
}

/// Consent is supplied by the caller's UI. Refusal does not create a copy.
/// Keep incomplete or uncertain copies for inspection; never overwrite one.
pub(crate) fn retain(path: &Path, target: i64, consent: bool) -> Result<Option<PathBuf>, String> {
    let reader = Store::open_readonly(path).map_err(|error| error.to_string())?;
    if reader.user_version().map_err(|error| error.to_string())? >= target {
        return Ok(None);
    }
    if !consent {
        return Err("format_upgrade_required".into());
    }
    let name = path
        .file_stem()
        .ok_or("book has no filename")?
        .to_string_lossy();
    let copy = path.with_file_name(format!(
        "{name}.before-format-{target}-{}.point",
        uuid::Uuid::now_v7()
    ));
    let written = backup_bundle::write(path, &reader, &copy)?;
    if !written.verified {
        return Err(format!(
            "pre-upgrade copy is incomplete; book was not upgraded: {}",
            written.errors.join("; ")
        ));
    }
    Ok(Some(copy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FlushEntry;
    use sha2::{Digest, Sha256};
    use std::fs;

    fn book(path: &Path) -> String {
        let store = Store::open(path).unwrap();
        let id = store.item_create(None, "scene", "Chapter one").unwrap().id;
        store.flush(&[FlushEntry { item_id: id.clone(), base_rev: 1,
            body: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Original writing"}]}]}"#.into(), comments: None }]).unwrap();
        store.snapshot_create("Before revision").unwrap();
        store.checkpoint().unwrap();
        id
    }

    #[test]
    fn refusal_leaves_database_and_directory_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        book(&path);
        let _reader = Store::open_readonly(&path).unwrap();
        let before = fs::read(&path).unwrap();
        let names = || {
            let mut names: Vec<_> = fs::read_dir(dir.path())
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let entries = names();
        assert!(required(&path, 18).unwrap());
        assert_eq!(
            retain(&path, 18, false).unwrap_err(),
            "format_upgrade_required"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(names(), entries);
    }

    #[test]
    fn retained_copy_is_complete_independent_and_restorable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        let id = book(&path);
        let pictures = crate::pictures::dir_for(&path);
        fs::create_dir(&pictures).unwrap();
        let store = Store::open_existing(&path).unwrap();
        let member = store.cast_create("character", "A character").unwrap();
        let name = "retained.png";
        let data = b"retained original";
        fs::write(pictures.join(name), data).unwrap();
        store.cast_set_picture(&member.id, Some(name)).unwrap();
        drop(store);
        let copy = retain(&path, 18, true).unwrap().unwrap();
        let reader = Store::open_readonly(&backup_bundle::db_path(&copy)).unwrap();
        assert_eq!(reader.user_version().unwrap(), 17);
        assert!(reader
            .load_doc(&id)
            .unwrap()
            .body
            .contains("Original writing"));
        assert!(!reader.doc_versions(&id).unwrap().is_empty());
        let copied = copy.join(backup_bundle::PICTURES_NAME).join(name);
        assert_eq!(
            Sha256::digest(fs::read(&copied).unwrap()),
            Sha256::digest(data)
        );
        fs::write(pictures.join(name), b"later bytes").unwrap();
        assert_eq!(fs::read(&copied).unwrap(), data);
        backup_bundle::verify(&copy).unwrap();
        let library = dir.path().join("restored");
        fs::create_dir(&library).unwrap();
        let restored = crate::projects::restore_point_into(&copy, &library, "rollback", 1).unwrap();
        assert!(Store::open_readonly(Path::new(&restored.path))
            .unwrap()
            .load_doc(&id)
            .unwrap()
            .body
            .contains("Original writing"));
    }

    #[test]
    fn missing_original_blocks_upgrade_and_retains_incomplete_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        book(&path);
        let store = Store::open_existing(&path).unwrap();
        let member = store.cast_create("character", "A character").unwrap();
        store
            .cast_set_picture(&member.id, Some("missing.png"))
            .unwrap();
        drop(store);
        assert!(retain(&path, 18, true).unwrap_err().contains("incomplete"));
        assert_eq!(
            Store::open_readonly(&path).unwrap().user_version().unwrap(),
            17
        );
        assert!(fs::read_dir(dir.path()).unwrap().any(|e| e
            .unwrap()
            .path()
            .extension()
            .is_some_and(|e| e == "point")));
    }

    #[test]
    fn current_book_needs_no_decision_or_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        book(&path);
        assert!(!required(&path, 17).unwrap());
        assert_eq!(retain(&path, 17, false).unwrap(), None);
    }
}
