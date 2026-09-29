use super::spell::{apply_spell_checking, configured_languages, sync_project_dictionary};
use crate::{
    locked, mark_mirror_dirty, open_project, projects, store, DataHome, MirrorDirty, StoreState,
    MIRROR_EVENT,
};
use tauri::{Emitter, State};

/// Every word on the open project's own dictionary, alphabetically.
#[command_boundary::command]
pub(crate) fn dict_list(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<store::dict::DictWord>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .dict_words()
        .map_err(|e| e.to_string())
}

/// Add a word to the open project's dictionary, and re-render the rendered
/// `.dic` files so the checker sees it without waiting for the next launch.
///
/// SYNCED AFTER THE STORE WRITE SUCCEEDS, not before: a word that failed to
/// save (empty, already there) must not reach the checker's file either.
///
/// THEN THE CHECKER IS TOLD. Enchant reads a personal wordlist when the
/// dictionary is requested, not on every lookup, so a rewritten `.dic` sat
/// unread until the next launch -- the "may not stop being underlined" note in
/// the panel was honest. Re-applying the spelling languages makes WebKit drop
/// its dictionaries and request them again, which reads the file. Best effort,
/// like `apply_spell_checking` itself; the word is in the store either way.
#[command_boundary::command]
pub(crate) fn dict_add(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    dirty: State<'_, MirrorDirty>,
    word: String,
) -> std::result::Result<store::dict::DictWord, String> {
    let (added, emit) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        let (added, emit) = then_mirror(&dirty, || {
            project.store.dict_add(&word).map_err(|e| e.to_string())
        })?;
        sync_project_dictionary(&data_home.0, &project.store, &configured_languages());
        reload_checker(&app, &data_home.0);
        (added, emit)
    };
    if emit {
        let _ = app.emit(MIRROR_EVENT, ());
    }
    Ok(added)
}

/// Run a dictionary change, then owe the readable folder its `wordlist.txt`.
///
/// ONLY AFTER THE CHANGE COMMITTED, `doc_flush`'s rule: a refused word (empty,
/// already there, unknown) changed nothing the folder shows. Called while
/// `StoreState` is held; the caller emits after dropping it.
fn then_mirror<T>(
    dirty: &MirrorDirty,
    change: impl FnOnce() -> std::result::Result<T, String>,
) -> std::result::Result<(T, bool), String> {
    let value = change()?;
    Ok((value, mark_mirror_dirty(dirty)))
}

/// Make the live checker read the rendered `.dic` again, keeping the writer's
/// on/off choice as it stands.
fn reload_checker(app: &tauri::AppHandle, data_home: &std::path::Path) {
    let enabled = projects::read_settings(data_home).spelling.enabled();
    apply_spell_checking(app, enabled);
}

/// Remove a word from the open project's dictionary, and re-render the `.dic`
/// files the same way `dict_add` does.
#[command_boundary::command]
pub(crate) fn dict_remove(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    dirty: State<'_, MirrorDirty>,
    word: String,
) -> std::result::Result<(), String> {
    let emit = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        let ((), emit) = then_mirror(&dirty, || {
            project.store.dict_remove(&word).map_err(|e| e.to_string())
        })?;
        sync_project_dictionary(&data_home.0, &project.store, &configured_languages());
        reload_checker(&app, &data_home.0);
        emit
    };
    if emit {
        let _ = app.emit(MIRROR_EVENT, ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::then_mirror;
    use crate::store::Store;
    use crate::MirrorDirty;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn dict_change_marks_the_mirror_only_after_it_commits() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        let err = |e: crate::store::StoreError| e.to_string();

        assert!(then_mirror(&dirty, || store.dict_remove("Absent").map_err(err)).is_err());
        assert!(
            !dirty.0.load(Ordering::Relaxed),
            "a refused remove owes no pass"
        );

        let (_, emit) = then_mirror(&dirty, || store.dict_add("Mireth").map_err(err)).unwrap();
        assert!(emit && dirty.0.load(Ordering::Relaxed));
        assert_eq!(store.dict_words().unwrap().len(), 1);

        dirty.0.store(false, Ordering::Relaxed);
        assert!(then_mirror(&dirty, || store.dict_add("Mireth").map_err(err)).is_err());
        assert!(!dirty.0.load(Ordering::Relaxed), "a duplicate owes no pass");

        let ((), emit) = then_mirror(&dirty, || store.dict_remove("Mireth").map_err(err)).unwrap();
        assert!(!emit, "the pending state was already surfaced");
        assert!(dirty.0.load(Ordering::Relaxed));
    }
}
