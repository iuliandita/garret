// app/shell-tauri/src-tauri/src/commands/synopsis.rs
// What a part, a chapter or a scene is about, as the page reaches it.
//
// THIN, DELIBERATELY. A `#[tauri::command]` cannot be unit-tested, so the rule
// this codebase already follows is that everything worth a test lives in a free
// function the tests can reach -- here `Store::synopsis` and
// `Store::synopsis_set`, whose refusals, trimming and delete-on-empty are all
// covered in `store/synopsis.rs`. Nothing decides anything here.
use crate::{locked, open_project, store, StoreState};
use tauri::State;

/// What this item is about, or null when nobody has said.
#[command_boundary::command]
pub(crate) fn synopsis_get(
    state: State<'_, StoreState>,
    item_id: String,
) -> std::result::Result<Option<store::synopsis::Synopsis>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .synopsis(&item_id)
        .map_err(|e| e.to_string())
}

/// Read only the visible outline page. The cap is checked before touching the
/// store so a caller cannot turn this into an unbounded manuscript scan.
#[command_boundary::command]
pub(crate) fn synopsis_batch(
    state: State<'_, StoreState>,
    ids: Vec<String>,
) -> std::result::Result<Vec<store::synopsis::Synopsis>, String> {
    validate_batch_ids(&ids)?;
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .synopsis_batch(&ids)
        .map_err(|e| e.to_string())
}

fn validate_batch_ids(ids: &[String]) -> std::result::Result<(), String> {
    if ids.len() > 100 {
        return Err("synopsis_batch accepts at most 100 ids".to_string());
    }
    if ids.iter().any(|id| id.is_empty()) {
        return Err("synopsis_batch refuses an empty id".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    if ids.iter().any(|id| !seen.insert(id)) {
        return Err("synopsis_batch refuses duplicate ids".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod batch_tests {
    use super::validate_batch_ids;

    #[test]
    fn bounded_ids_are_explicitly_validated() {
        let hundred = (0..100).map(|i| i.to_string()).collect::<Vec<_>>();
        assert!(validate_batch_ids(&hundred).is_ok());
        let mut too_many = hundred.clone();
        too_many.push("extra".into());
        assert!(validate_batch_ids(&too_many).is_err());
        assert!(validate_batch_ids(&["".into()]).is_err());
        assert!(validate_batch_ids(&["same".into(), "same".into()]).is_err());
    }
}

/// Write what this item is about. Returns null when the synopsis was cleared --
/// an answer, not an error, and the same shape the dialog commands use for a
/// cancelled pick.
///
/// NO `base_rev`, unlike a rename or a revision state and exactly like a
/// comment's body: a synopsis is its own row with one writer, one window and one
/// panel, so a revision discipline here would be a discipline with nothing to
/// guard. `itemId` is camelCase from the page and snake_case coming back, which
/// is the recorded Tauri rule rather than an inconsistency.
#[command_boundary::command]
pub(crate) fn synopsis_set(
    state: State<'_, StoreState>,
    item_id: String,
    body: String,
) -> std::result::Result<Option<store::synopsis::Synopsis>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .synopsis_set(&item_id, &body)
        .map_err(|e| e.to_string())
}

/// Every item that carries a synopsis, for the navigator's mark. One query,
/// not a field on the walk: the walk is the store's shape and this is a fact
/// about a table beside it.
#[command_boundary::command]
pub(crate) fn synopsis_ids(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<String>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .synopsis_item_ids()
        .map_err(|e| e.to_string())
}
