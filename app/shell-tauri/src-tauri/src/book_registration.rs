use crate::{projects, store::Store};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct Warning {
    pub token: Option<String>,
    pub kind: WarningKind,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningKind {
    RegistrationPending,
    DestinationPreference,
    RegistrationUnavailable,
}

#[derive(Clone, Serialize)]
pub struct PendingSummary {
    pub token: String,
    pub path: String,
    pub name: String,
}

struct Pending {
    home: PathBuf,
    path: PathBuf,
    book_id: String,
    name: String,
}

// Session-only capabilities. Page-supplied paths never authorize registration.
static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn profile(home: &Path) -> PathBuf {
    home.canonicalize().unwrap_or_else(|_| home.to_path_buf())
}

fn identity(path: &Path) -> Result<(PathBuf, String), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("the saved book is no longer a regular file".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    let id = Store::open_readonly(&canonical)
        .map_err(|error| error.to_string())?
        .book_id()
        .map_err(|error| error.to_string())?
        .ok_or("the saved book has no book identity")?;
    Ok((canonical, id))
}

pub fn remember(
    home: &Path,
    dir: &Path,
    mut summary: projects::ProjectSummary,
) -> projects::ProjectSummary {
    let path = PathBuf::from(&summary.path);
    let outside = !projects::in_library(&projects::library_dir(home), &path);
    let owned = identity(&path);
    let result = projects::update_settings(home, |settings| {
        if outside && !settings.books.contains(&summary.path) {
            settings.books.push(summary.path.clone());
        }
        settings.new_book_dir = Some(dir.to_string_lossy().into_owned());
    });
    if let Err(error) = result {
        let (token, kind) = if !outside {
            (None, WarningKind::DestinationPreference)
        } else if let Ok((path, book_id)) = owned {
            let token = uuid::Uuid::now_v7().to_string();
            PENDING
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    token.clone(),
                    Pending {
                        home: profile(home),
                        path,
                        book_id,
                        name: summary.name.clone(),
                    },
                );
            (Some(token), WarningKind::RegistrationPending)
        } else {
            (None, WarningKind::RegistrationUnavailable)
        };
        summary.registration_warning = Some(Warning { token, kind, error });
    }
    summary
}

pub fn list(home: &Path) -> Vec<PendingSummary> {
    let home = profile(home);
    let pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    let mut rows: Vec<_> = pending
        .iter()
        .filter(|(_, entry)| entry.home == home)
        .map(|(token, entry)| PendingSummary {
            token: token.clone(),
            path: entry.path.to_string_lossy().into_owned(),
            name: entry.name.clone(),
        })
        .collect();
    rows.sort_by(|a, b| a.path.cmp(&b.path));
    rows
}

pub fn retry(home: &Path, token: &str) -> Result<projects::ProjectSummary, String> {
    let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    let entry = pending
        .get(token)
        .filter(|entry| entry.home == profile(home))
        .ok_or(
            "this library registration request is unavailable; keep the saved book file",
        )?;
    let (path, id) = identity(&entry.path)?;
    if path != entry.path || id != entry.book_id {
        return Err(
            "the saved book changed; keep the file and check its identity before adding it to the library".into(),
        );
    }
    let recorded = path.to_string_lossy().into_owned();
    // Fresh checked settings, preserving later preferences and normal book-open protection checks.
    projects::update_settings_checked(home, |settings| {
        if !settings.books.contains(&recorded) {
            settings.books.push(recorded.clone());
        }
        Ok(())
    })?;
    let summary = projects::summarize(&path);
    pending.remove(token);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(home: &Path, dir: &Path) -> projects::ProjectSummary {
        let made =
            projects::create_in(dir, "Saved book", &crate::strings::Strings::english()).unwrap();
        let parent = projects::settings_path(home)
            .parent()
            .unwrap()
            .to_path_buf();
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir(parent.join("settings.json.tmp")).unwrap();
        remember(home, dir, made)
    }

    #[test]
    fn registration_failure_retains_book_and_retry_preserves_newer_preferences() {
        let home = tempfile::tempdir().unwrap();
        let books = tempfile::tempdir().unwrap();
        let made = failed(home.path(), books.path());
        let token = made
            .registration_warning
            .as_ref()
            .unwrap()
            .token
            .as_deref()
            .unwrap();
        assert!(Path::new(&made.path).is_file());
        let pictures = Path::new(&made.path).with_extension("pictures");
        let research = Path::new(&made.path).with_extension("research");
        for assets in [&pictures, &research] {
            std::fs::create_dir(assets).unwrap();
            std::fs::write(assets.join("retained-original"), b"retained bytes").unwrap();
        }
        assert!(!projects::known(home.path()).contains(&PathBuf::from(&made.path)));
        assert_eq!(list(home.path()).len(), 1);
        assert!(retry(home.path(), token).is_err());
        assert_eq!(list(home.path()).len(), 1);
        let other_home = tempfile::tempdir().unwrap();
        assert!(list(other_home.path()).is_empty());
        assert!(retry(other_home.path(), token).is_err());
        assert!(retry(home.path(), "not-a-token").is_err());
        std::fs::remove_dir(projects::settings_path(home.path()).with_extension("json.tmp"))
            .unwrap();
        projects::update_settings(home.path(), |settings| {
            settings.new_book_dir = Some("/newer/folder".into());
            settings.mark_cast_names = false;
            settings.books.push(made.path.clone());
        })
        .unwrap();
        let registered = retry(home.path(), token).unwrap();
        assert!(registered.registration_warning.is_none());
        let settings = projects::read_settings_checked(home.path()).unwrap();
        assert_eq!(settings.new_book_dir.as_deref(), Some("/newer/folder"));
        assert!(!settings.mark_cast_names);
        assert_eq!(
            settings
                .books
                .iter()
                .filter(|path| *path == &registered.path)
                .count(),
            1
        );
        assert!(list(home.path()).is_empty());
        for assets in [&pictures, &research] {
            assert_eq!(
                std::fs::read(assets.join("retained-original")).unwrap(),
                b"retained bytes"
            );
        }
    }

    #[test]
    fn retry_refuses_replacement_identity_and_retains_the_pending_record() {
        let home = tempfile::tempdir().unwrap();
        let books = tempfile::tempdir().unwrap();
        let made = failed(home.path(), books.path());
        let token = made
            .registration_warning
            .as_ref()
            .unwrap()
            .token
            .as_deref()
            .unwrap();
        let store = Store::open_existing(Path::new(&made.path)).unwrap();
        let old = store.book_id().unwrap().unwrap();
        store.fork_recovered_book_identity(&old).unwrap();
        drop(store);
        std::fs::remove_dir(projects::settings_path(home.path()).with_extension("json.tmp"))
            .unwrap();
        assert!(retry(home.path(), token).unwrap_err().contains("changed"));
        assert_eq!(list(home.path()).len(), 1);
        assert!(projects::read_settings(home.path()).books.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn retry_refuses_a_symlink_replacing_the_owned_file() {
        let home = tempfile::tempdir().unwrap();
        let books = tempfile::tempdir().unwrap();
        let made = failed(home.path(), books.path());
        let token = made
            .registration_warning
            .as_ref()
            .unwrap()
            .token
            .as_deref()
            .unwrap();
        let moved = books.path().join("moved.db");
        std::fs::rename(&made.path, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &made.path).unwrap();
        std::fs::remove_dir(projects::settings_path(home.path()).with_extension("json.tmp"))
            .unwrap();
        assert!(retry(home.path(), token)
            .unwrap_err()
            .contains("regular file"));
        assert_eq!(list(home.path()).len(), 1);
        assert!(moved.is_file());
    }

    #[test]
    fn a_scanned_library_book_reports_only_the_unsaved_folder_preference() {
        let home = tempfile::tempdir().unwrap();
        let library = projects::library_dir(home.path());
        let made = failed(home.path(), &library);
        let warning = made.registration_warning.as_ref().unwrap();
        assert_eq!(warning.kind, WarningKind::DestinationPreference);
        assert!(warning.token.is_none());
        assert!(list(home.path()).is_empty());
        assert!(projects::known(home.path()).contains(&PathBuf::from(&made.path)));
        assert!(Path::new(&made.path).is_file());
    }

    #[test]
    fn an_unverifiable_identity_does_not_offer_a_nonexistent_retry() {
        let home = tempfile::tempdir().unwrap();
        let books = tempfile::tempdir().unwrap();
        let made = projects::create_in(
            books.path(),
            "Saved book",
            &crate::strings::Strings::english(),
        )
        .unwrap();
        let store = Store::open_existing(Path::new(&made.path)).unwrap();
        store.set_meta("book_id", "changed-after-creation").unwrap();
        drop(store);
        let bytes = std::fs::read(&made.path).unwrap();
        let settings = projects::settings_path(home.path());
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::create_dir(settings.with_extension("json.tmp")).unwrap();
        let made = remember(home.path(), books.path(), made);
        let warning = made.registration_warning.as_ref().unwrap();
        assert_eq!(warning.kind, WarningKind::RegistrationUnavailable);
        assert!(warning.token.is_none());
        assert!(list(home.path()).is_empty());
        assert_eq!(std::fs::read(&made.path).unwrap(), bytes);
    }
}
