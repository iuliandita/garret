use crate::{export_dir, locked, open_project, research, store, DataHome, StoreState};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{Manager, State};

#[derive(serde::Serialize)]
pub(crate) struct ResourceView {
    #[serde(flatten)]
    resource: store::knowledge::Resource,
    available: bool,
}

#[command_boundary::command]
pub(crate) fn knowledge_links(
    state: State<'_, StoreState>,
    endpoint: Option<store::knowledge::Endpoint>,
) -> Result<Vec<store::knowledge::Link>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .knowledge_links(endpoint.as_ref(), false)
}

#[command_boundary::command]
pub(crate) fn knowledge_link_create(
    state: State<'_, StoreState>,
    generation: u64,
    draft: store::knowledge::LinkDraft,
) -> Result<store::knowledge::Link, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("knowledge edit belongs to another book".into());
    }
    project.store.knowledge_link_create(&draft)
}

#[command_boundary::command]
pub(crate) fn knowledge_link_remove(
    state: State<'_, StoreState>,
    generation: u64,
    id: String,
) -> Result<(), String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("knowledge edit belongs to another book".into());
    }
    project.store.knowledge_link_remove(&id)
}

#[command_boundary::command]
pub(crate) async fn research_list(
    state: State<'_, StoreState>,
) -> Result<Vec<ResourceView>, String> {
    let (path, resources) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (project.path.clone(), project.store.research_resources()?)
    };
    tauri::async_runtime::spawn_blocking(move || {
        resources
            .into_iter()
            .map(|resource| {
                let available =
                    research::verify_original(&path, &resource.sha256, resource.bytes).is_ok();
                ResourceView {
                    resource,
                    available,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn research_remove(
    state: State<'_, StoreState>,
    generation: u64,
    id: String,
) -> Result<(), String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("knowledge edit belongs to another book".into());
    }
    project.store.research_resource_remove(&id)
}

#[command_boundary::command]
pub(crate) fn research_restore(
    state: State<'_, StoreState>,
    generation: u64,
    id: String,
) -> Result<(), String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("knowledge edit belongs to another book".into());
    }
    project.store.research_resource_restore(&id)
}

#[command_boundary::command]
pub(crate) fn craft_watchlist_get(
    state: State<'_, StoreState>,
) -> Result<Vec<store::watchlist::Term>, String> {
    let guard = locked(&state);
    open_project(&guard)?.store.craft_watchlist()
}

#[command_boundary::command]
pub(crate) fn craft_watchlist_set(
    state: State<'_, StoreState>,
    generation: u64,
    terms: Vec<store::watchlist::Term>,
) -> Result<(), String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("knowledge edit belongs to another book".into());
    }
    project.store.craft_watchlist_set(&terms)
}

async fn pick_file(app: &tauri::AppHandle, dir: &Path, title: &str) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        crate::privacy_native::pick(
            app,
            gtk::FileChooserAction::Open,
            title.into(),
            dir.to_path_buf(),
            None,
            None,
        )
        .await
    }
    #[cfg(windows)]
    {
        crate::privacy_windows::pick(
            app,
            crate::privacy_windows::PickAction::Open,
            title.into(),
            dir.to_path_buf(),
            None,
            None,
        )
        .await
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::DialogExt;
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        app.dialog()
            .file()
            .set_title(title)
            .set_directory(dir)
            .pick_file(move |picked| {
                let _ = tx.blocking_send(picked);
            });
        rx.recv()
            .await
            .flatten()
            .and_then(|path| path.into_path().ok())
    }
}

async fn save_file(
    app: &tauri::AppHandle,
    dir: &Path,
    name: &str,
    title: &str,
    filter: Option<(&str, &[&str])>,
) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        crate::privacy_native::pick(
            app,
            gtk::FileChooserAction::Save,
            title.into(),
            dir.to_path_buf(),
            Some(name.to_owned()),
            filter.map(|(label, extensions)| {
                (
                    label.into(),
                    extensions
                        .iter()
                        .map(|extension| (*extension).into())
                        .collect(),
                )
            }),
        )
        .await
    }
    #[cfg(windows)]
    {
        crate::privacy_windows::pick(
            app,
            crate::privacy_windows::PickAction::Save,
            title.into(),
            dir.to_path_buf(),
            Some(name.into()),
            filter.map(|(label, extensions)| {
                (label.into(), extensions.iter().map(|extension| (*extension).into()).collect())
            }),
        )
        .await
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::DialogExt;
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        let mut dialog = app
            .dialog()
            .file()
            .set_title(title)
            .set_directory(dir)
            .set_file_name(name);
        if let Some((label, extensions)) = filter {
            dialog = dialog.add_filter(label, extensions);
        }
        dialog.save_file(move |picked| {
            let _ = tx.blocking_send(picked);
        });
        rx.recv()
            .await
            .flatten()
            .and_then(|path| path.into_path().ok())
    }
}

fn epoch(app: &tauri::AppHandle) -> u64 {
    app.state::<crate::privacy_host::Epoch>()
        .0
        .load(Ordering::SeqCst)
}

#[command_boundary::command]
pub(crate) async fn research_import_pick(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    generation: u64,
    title: String,
    media_type: String,
    source_note: String,
    citation: String,
) -> Result<Option<store::knowledge::Resource>, String> {
    let path = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != generation {
            return Err("research selection belongs to another book".into());
        }
        project.path.clone()
    };
    let started = epoch(&app);
    if crate::privacy_host::locked(&app) {
        return Err("application locked".into());
    }
    let start = dirs::home_dir()
        .unwrap_or_else(|| path.parent().unwrap_or(Path::new(".")).to_path_buf());
    let dialog_title = crate::commands::export::strings_for(&data_home.0).t("research.dialog.import");
    let Some(source) = pick_file(&app, &start, &dialog_title).await else {
        return Ok(None);
    };
    if crate::privacy_host::locked(&app) || epoch(&app) != started {
        return Err("research selection interrupted by privacy locking".into());
    }
    {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.path != path || project.generation != generation {
            return Err("research selection belongs to another book".into());
        }
    }
    let app_for_copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        research::import_copy(&path, &source, |original_name, bytes, hash| {
            let state = app_for_copy.state::<StoreState>();
            let guard = locked(&state);
            let project = open_project(&guard)?;
            if project.path != path
                || project.generation != generation
                || crate::privacy_host::locked(&app_for_copy)
                || epoch(&app_for_copy) != started
            {
                return Err("research import was interrupted or belongs to another book".into());
            }
            project.store.research_resource_add(
                &title,
                original_name,
                &media_type,
                bytes,
                hash,
                &source_note,
                &citation,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map(Some)
}

#[command_boundary::command]
pub(crate) async fn research_save_copy(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    generation: u64,
    id: String,
) -> Result<Option<String>, String> {
    let (path, resource) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != generation {
            return Err("research copy belongs to another book".into());
        }
        let resource = project
            .store
            .research_resources()?
            .into_iter()
            .find(|resource| resource.id == id && resource.removed_at.is_none())
            .ok_or("research file is unavailable")?;
        (project.path.clone(), resource)
    };
    let started = epoch(&app);
    if crate::privacy_host::locked(&app) {
        return Err("application locked".into());
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let title = crate::commands::export::strings_for(&data_home.0).t("research.dialog.save");
    let Some(destination) = save_file(&app, dir, &resource.original_name, &title, None).await
    else {
        return Ok(None);
    };
    if crate::privacy_host::locked(&app) || epoch(&app) != started {
        return Err("research save interrupted by privacy locking".into());
    }
    {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.path != path || project.generation != generation {
            return Err("research copy belongs to another book".into());
        }
    }
    let filename = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let app_for_copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        research::save_copy(
            &path,
            &resource.sha256,
            resource.bytes,
            &destination,
            |stage, target| {
                let state = app_for_copy.state::<StoreState>();
                let guard = locked(&state);
                let project = open_project(&guard)?;
                if project.path != path
                    || project.generation != generation
                    || crate::privacy_host::locked(&app_for_copy)
                    || epoch(&app_for_copy) != started
                {
                    return Err("research copy was interrupted or belongs to another book".into());
                }
                std::fs::hard_link(stage, target)
                    .map_err(|e| format!("research copy could not be published: {e}"))
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(filename))
}

#[command_boundary::command]
pub(crate) async fn craft_report_export_as(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    generation: u64,
    kind: String,
    text: String,
) -> Result<Option<String>, String> {
    let extension = match kind.as_str() {
        "json" => "json",
        "csv" => "csv",
        _ => return Err("unsupported report format".into()),
    };
    if text.len() > 2 * 1024 * 1024 {
        return Err("report export exceeds its size limit".into());
    }
    let (path, name) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != generation {
            return Err("report belongs to another book".into());
        }
        (project.path.clone(), project.name.clone())
    };
    let started = epoch(&app);
    if crate::privacy_host::locked(&app) {
        return Err("application locked".into());
    }
    let dir = export_dir(&data_home.0);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let title = crate::commands::export::strings_for(&data_home.0).t("research.dialog.report");
    let default_name = format!(
        "{}-craft-report.{extension}",
        crate::commands::export::export_slug(&name)
    );
    let filter = if extension == "csv" {
        ("CSV", &["csv"][..])
    } else {
        ("JSON", &["json"][..])
    };
    let Some(destination) = save_file(&app, &dir, &default_name, &title, Some(filter)).await else {
        return Ok(None);
    };
    if crate::privacy_host::locked(&app) || epoch(&app) != started {
        return Err("report export interrupted by privacy locking".into());
    }
    {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != generation || project.path != path {
            return Err("report belongs to another book".into());
        }
    }
    crate::commands::export::replace_file(&destination, text.as_bytes())?;
    Ok(Some(
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    ))
}
