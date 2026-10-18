use crate::{locked, open_project, StoreState};
use tauri::State;

#[command_boundary::command]
pub(crate) fn figure_preview(
    state: State<'_, StoreState>, item_id: String, instance_id: String, asset_id: String,
) -> Result<crate::pictures::PictureView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    crate::figures::preview(&project.path, &project.store, &item_id, &instance_id, &asset_id)
}
