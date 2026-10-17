use crate::{
    collection, locked, open_project, open_project_mut, with_outline_generation, StoreState,
};
use tauri::State;

#[command_boundary::command]
pub(crate) fn story_get(
    state: State<'_, StoreState>,
    generation: u64,
    id: String,
) -> Result<collection::Story, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("the open book changed".into());
    }
    collection::story(&project.store, &id)
}

#[command_boundary::command]
pub(crate) fn story_save(
    state: State<'_, StoreState>,
    generation: u64,
    id: String,
    title: String,
    author: String,
    status: Option<String>,
    base_rev: i64,
) -> Result<(), String> {
    let mut guard = locked(&state);
    with_outline_generation(open_project_mut(&mut guard)?, generation, |project| {
        collection::save(
            &project.store,
            &id,
            &title,
            &author,
            status.as_deref(),
            base_rev,
        )
    })
}
