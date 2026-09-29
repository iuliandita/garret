use crate::{locked, open_project, store, StoreState};
use tauri::State;

#[command_boundary::command]
pub(crate) fn revision_pass_list(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<store::revision_planning::RevisionPass>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_passes()
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_pass_create(
    state: State<'_, StoreState>,
    name: String,
    purpose: Option<String>,
) -> std::result::Result<i64, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_pass_create(&name, purpose.as_deref())
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_pass_update(
    state: State<'_, StoreState>,
    id: i64,
    name: String,
    purpose: Option<String>,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_pass_update(id, &name, purpose.as_deref())
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_pass_delete(
    state: State<'_, StoreState>,
    id: i64,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_pass_delete(id)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_task_list(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<store::revision_planning::RevisionTask>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_tasks()
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_task_create(
    state: State<'_, StoreState>,
    body: String,
    item_id: Option<String>,
    pass_id: Option<i64>,
) -> std::result::Result<i64, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_task_create(&body, item_id.as_deref(), pass_id)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_task_update(
    state: State<'_, StoreState>,
    id: i64,
    body: String,
    pass_id: Option<i64>,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_task_update(id, &body, pass_id)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_task_set_done(
    state: State<'_, StoreState>,
    id: i64,
    done: bool,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_task_set_done(id, done)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn revision_task_delete(
    state: State<'_, StoreState>,
    id: i64,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .revision_task_delete(id)
        .map_err(|e| e.to_string())
}
