use crate::{projects, store::Store};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyConflict {
    pub book_id: String,
    pub canonical_path: String,
    pub can_separate: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub book_id: String,
    pub canonical_path: String,
    pub kind: Choice,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Same,
    Separate,
}

pub fn require_canonical(
    settings: &projects::Settings,
    book_id: &str,
    path: &Path,
) -> Result<(), String> {
    let canonical = projects::canonical_book_path(settings, book_id)
        .ok_or("this book has no saved location; reopen it before updating its protection copies")?;
    if !projects::physical_same_file(path, canonical)? {
        return Err("another copy is now the same book; this older source was not used".into());
    }
    Ok(())
}

/// The caller holds both protection locks through installation of the store.
pub fn register(
    store: &Store,
    path: &Path,
    data_home: &Path,
    mirror_root: Option<&Path>,
    decision: Option<&Decision>,
) -> Result<String, String> {
    let mut opened_id = String::new();
    let mut forked = false;
    let result = projects::update_settings_checked(data_home, |settings| {
        let (id, separate) = resolve(store, path, settings, decision)?;
        opened_id = id;
        forked = separate;
        let known = projects::known(data_home);
        let plan = crate::protection::plan(
            settings, path, &opened_id, &known, data_home, mirror_root,
            store.may_adopt_legacy_protection().map_err(|error| error.to_string())?,
        )?;
        crate::protection::apply(settings, &plan);
        projects::record_book_location(settings, &opened_id, path);
        Ok(())
    });
    result.map_err(|error| if forked {
        format!("the separate book identity was created, but its location could not be saved: {error}. Choose the book again to retry")
    } else { error })?;
    Ok(opened_id)
}

pub fn conflict(
    store: &Store,
    path: &Path,
    settings: &projects::Settings,
) -> Result<Option<CopyConflict>, String> {
    let Some(id) = store.book_id().map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let Some(canonical) = projects::canonical_book_path(settings, &id) else {
        return Ok(None);
    };
    if canonical == path {
        return Ok(None);
    }
    let can_separate = match projects::physical_same_file(path, canonical) {
        Ok(true) => return Ok(None),
        Ok(false) => true,
        Err(error) => match canonical.try_exists() {
            Ok(false) => false,
            _ => return Err(error),
        },
    };
    Ok(Some(CopyConflict {
        book_id: id,
        canonical_path: canonical.to_string_lossy().into_owned(),
        can_separate,
    }))
}

/// Called under the protection locks with freshly read canonical settings.
/// A committed fork is retained if the subsequent settings write fails.
pub fn resolve(
    store: &Store,
    path: &Path,
    settings: &projects::Settings,
    decision: Option<&Decision>,
) -> Result<(String, bool), String> {
    let pending = conflict(store, path, settings)?;
    match (pending, decision) {
        (None, None) => Ok((
            store
                .book_id()
                .map_err(|error| error.to_string())?
                .ok_or("this book has not been upgraded for writing")?,
            false,
        )),
        (Some(copy), Some(decision))
            if copy.book_id == decision.book_id
                && copy.canonical_path == decision.canonical_path =>
        {
            match decision.kind {
                Choice::Same => Ok((copy.book_id, false)),
                Choice::Separate if copy.can_separate => store
                    .fork_book_identity(&copy.book_id)
                    .map(|id| (id, true))
                    .map_err(|error| error.to_string()),
                Choice::Separate => Err(
                    "the original book cannot be checked; open this as the same book or cancel"
                        .into(),
                ),
            }
        }
        _ => Err("the book or its saved location changed; choose it again".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn failed_registration_keeps_the_fork_and_retry_does_not_claim_legacy_history() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("data");
        let original = dir.path().join("original.db");
        let copy = dir.path().join("copy.db");
        let source = Store::open(&original).unwrap();
        let id = source.book_id().unwrap().unwrap();
        source.checkpoint().unwrap();
        std::fs::copy(&original, &copy).unwrap();
        let candidate = Store::open(&copy).unwrap();
        let mut settings = projects::Settings::default();
        projects::record_book_location(&mut settings, &id, &original);
        projects::write_settings(&home, &settings).unwrap();
        let settings_path = projects::settings_path(&home);
        let before = std::fs::read(&settings_path).unwrap();
        let blocked_temp = settings_path.with_extension("json.tmp");
        std::fs::create_dir(&blocked_temp).unwrap();
        let decision = Decision {
            book_id: id.clone(),
            canonical_path: original.to_string_lossy().into_owned(),
            kind: Choice::Separate,
        };
        let error = register(&candidate, &copy, &home, None, Some(&decision)).unwrap_err();
        assert!(error.contains("separate book identity was created"), "{error}");
        let fork = candidate.book_id().unwrap().unwrap();
        assert_ne!(fork, id);
        assert_eq!(source.book_id().unwrap().unwrap(), id);
        assert!(!candidate.may_adopt_legacy_protection().unwrap());
        assert_eq!(std::fs::read(&settings_path).unwrap(), before);
        std::fs::remove_dir(&blocked_temp).unwrap();
        assert_eq!(register(&candidate, &copy, &home, None, None).unwrap(), fork);
        let saved = projects::read_settings_checked(&home).unwrap();
        assert_eq!(projects::canonical_book_path(&saved, &fork), Some(copy.as_path()));
        assert!(saved.protection_claims.is_empty());
    }

    #[test]
    fn canonical_source_checks_do_not_depend_on_which_other_book_is_open() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.db");
        let other = dir.path().join("other.db");
        let copy = dir.path().join("copy.db");
        let a = Store::open(&first).unwrap();
        let a_id = a.book_id().unwrap().unwrap();
        let b_id = Store::open(&other).unwrap().book_id().unwrap().unwrap();
        a.checkpoint().unwrap();
        std::fs::copy(&first, &copy).unwrap();
        let mut settings = projects::Settings::default();
        assert!(require_canonical(&settings, &a_id, &first).is_err());
        projects::record_book_location(&mut settings, &a_id, &first);
        projects::record_book_location(&mut settings, &b_id, &other);
        assert!(require_canonical(&settings, &a_id, &first).is_ok());
        projects::record_book_location(&mut settings, &a_id, &copy);
        assert!(require_canonical(&settings, &a_id, &first).is_err());
        assert!(require_canonical(&settings, &a_id, &copy).is_ok());
        assert!(require_canonical(&settings, &b_id, &other).is_ok());
    }

    #[test]
    fn inspecting_a_legacy_book_does_not_create_its_identity() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let store = Store::open(&path).unwrap();
        store.delete_meta(crate::store::book_identity::KEY).unwrap();
        store.checkpoint().unwrap();
        drop(store);
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.pragma_update(None, "user_version", 10).unwrap();
        drop(raw);
        let before = std::fs::read(&path).unwrap();
        let reader = Store::open_readonly(&path).unwrap();
        assert!(conflict(&reader, &path, &projects::Settings::default())
            .unwrap()
            .is_none());
        assert_eq!(reader.user_version().unwrap(), 10);
        assert_eq!(reader.book_id().unwrap(), None);
        drop(reader);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn same_book_preserves_identity_and_separate_changes_only_the_copy() {
        let dir = tempdir().unwrap();
        let original = dir.path().join("original.db");
        let copy = dir.path().join("copy.db");
        let source = Store::open(&original).unwrap();
        source.set_meta("name", "Harbour").unwrap();
        let id = source.book_id().unwrap().unwrap();
        source.checkpoint().unwrap();
        std::fs::copy(&original, &copy).unwrap();
        let candidate = Store::open(&copy).unwrap();
        let mut settings = projects::Settings::default();
        projects::record_book_location(&mut settings, &id, &original);
        let pending = conflict(&candidate, &copy, &settings).unwrap().unwrap();
        assert!(pending.can_separate);
        assert!(resolve(&candidate, &copy, &settings, None).is_err());
        assert_eq!(candidate.book_id().unwrap().unwrap(), id);
        let mut decision = Decision {
            book_id: id.clone(),
            canonical_path: pending.canonical_path,
            kind: Choice::Same,
        };
        let stale_id = Decision { book_id: "00000000000000000000000000000000".into(), ..decision.clone() };
        assert!(resolve(&candidate, &copy, &settings, Some(&stale_id)).is_err());
        let stale_path = Decision { canonical_path: copy.to_string_lossy().into_owned(), ..decision.clone() };
        assert!(resolve(&candidate, &copy, &settings, Some(&stale_path)).is_err());
        assert_eq!(candidate.book_id().unwrap().unwrap(), id);
        assert_eq!(
            resolve(&candidate, &copy, &settings, Some(&decision)).unwrap(),
            (id.clone(), false)
        );
        decision.kind = Choice::Separate;
        let (fork, changed) = resolve(&candidate, &copy, &settings, Some(&decision)).unwrap();
        assert!(changed);
        assert_ne!(fork, id);
        assert_eq!(source.book_id().unwrap().unwrap(), id);
        assert_eq!(
            candidate.get_meta("name").unwrap().as_deref(),
            Some("Harbour")
        );
        assert!(resolve(&candidate, &copy, &settings, Some(&decision)).is_err());
        assert_eq!(candidate.book_id().unwrap().unwrap(), fork);
    }

    #[test]
    fn alias_and_changed_canonical_location_refuse_a_stale_separate_choice() {
        let dir = tempdir().unwrap();
        let original = dir.path().join("original.db");
        let alias = dir.path().join("alias.db");
        let source = Store::open(&original).unwrap();
        let id = source.book_id().unwrap().unwrap();
        source.checkpoint().unwrap();
        std::fs::hard_link(&original, &alias).unwrap();
        let mut settings = projects::Settings::default();
        projects::record_book_location(&mut settings, &id, &original);
        assert!(conflict(&source, &alias, &settings).unwrap().is_none());
        let decision = Decision {
            book_id: id.clone(),
            canonical_path: original.to_string_lossy().into_owned(),
            kind: Choice::Separate,
        };
        assert!(resolve(&source, &alias, &settings, Some(&decision)).is_err());
        projects::record_book_location(&mut settings, &id, &dir.path().join("missing.db"));
        assert!(resolve(&source, &original, &settings, Some(&decision)).is_err());
        let pending = conflict(&source, &original, &settings).unwrap().unwrap();
        assert!(!pending.can_separate);
        let separate = Decision {
            canonical_path: pending.canonical_path.clone(),
            ..decision.clone()
        };
        assert!(resolve(&source, &original, &settings, Some(&separate)).is_err());
        let same = Decision {
            canonical_path: pending.canonical_path,
            kind: Choice::Same,
            ..decision
        };
        assert_eq!(
            resolve(&source, &original, &settings, Some(&same)).unwrap(),
            (id, false)
        );
    }
}
