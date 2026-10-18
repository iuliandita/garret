use crate::{locked, open_project, StoreState};
use tauri::State;

#[derive(serde::Serialize)]
pub(crate) struct FigureDetails {
    asset: crate::store::figure_assets::FigureAsset,
    column_inches: f64,
    height_inches: f64,
    original_warning: Option<String>,
}

#[command_boundary::command]
pub(crate) fn figure_details(state: State<'_, StoreState>, generation: u64, asset_id: String) -> Result<FigureDetails, String> {
    let (asset, path, design) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != generation { return Err("figure properties belong to another book".into()); }
        let asset = project.store.figure_assets().map_err(|error| error.to_string())?.into_iter()
            .find(|asset| asset.id == asset_id).ok_or("unregistered figure asset")?;
        (asset, project.path.clone(), crate::design::design_of(&project.store)?)
    };
    // Hash potentially large originals outside the global store lock. Broken
    // bytes must not prevent correcting a placement's caption or alternative.
    let original_warning = crate::figures::verify_original(&crate::pictures::dir_for(&path).join(&asset.stored_name), &asset)
        .err().map(|_| "missing_or_changed".into());
    {
        let guard = locked(&state);
        if open_project(&guard)?.generation != generation { return Err("figure properties belong to another book".into()); }
    }
    Ok(FigureDetails { asset,
        column_inches: crate::pdf::measure_um(&design) as f64 / 25400.0,
        height_inches: (design.page.height_um - design.margins.top_um - design.margins.bottom_um) as f64 / 25400.0,
        original_warning })
}

#[command_boundary::command]
pub(crate) fn figure_preview(
    state: State<'_, StoreState>, item_id: String, instance_id: String, asset_id: String,
) -> Result<crate::pictures::PictureView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    crate::figures::preview(&project.path, &project.store, &item_id, &instance_id, &asset_id)
}
