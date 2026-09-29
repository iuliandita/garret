use crate::store::analytics::{AdjustmentInput, Category, Report, Structure};
use crate::{locked, open_project, DataHome, StoreState};
use serde::Serialize;
use std::io::Write;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct AnalyticsView {
    pub generation: u64,
    pub session_id: Option<String>,
    pub report: Report,
    pub custom_categories: Vec<CustomCategory>,
    pub selected_category: Option<Category>,
    pub structure: Structure,
    pub tracking_on: bool,
}

#[derive(Debug, Serialize)]
pub struct CustomCategory {
    pub category: Category,
    pub retired: bool,
}

#[derive(Debug, Serialize)]
pub struct LibraryAnalyticsReport {
    pub book_id: Option<String>,
    pub identity_id: Option<String>,
    pub membership: crate::store::series::Membership,
    pub report: Option<Report>,
}

fn current<'a>(
    guard: &'a mut Option<crate::OpenProject>,
    generation: u64,
    session_id: Option<&str>,
) -> std::result::Result<&'a mut crate::OpenProject, String> {
    let project = guard.as_mut().ok_or(crate::NO_PROJECT)?;
    if project.generation != generation
        || project
            .analytics
            .as_ref()
            .map(|session| session.session_id.as_str())
            != session_id
    {
        return Err(
            "the analytics session changed; reopen Analytics before making a change".into(),
        );
    }
    Ok(project)
}

#[command_boundary::command]
pub(crate) fn analytics_get(
    state: State<'_, StoreState>,
) -> std::result::Result<AnalyticsView, String> {
    let (path, generation, session_id) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (
            project.path.clone(),
            project.generation,
            project
                .analytics
                .as_ref()
                .map(|runtime| runtime.session_id.clone()),
        )
    };
    let reader = crate::store::Store::open_readonly(&path).map_err(|error| error.to_string())?;
    let report = reader
        .analytics_report(Some(200))
        .map_err(|error| error.to_string())?;
    let custom_categories = reader
        .analytics_custom_categories()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(category, retired)| CustomCategory { category, retired })
        .collect();
    let selected_category = reader
        .analytics_selected_category()
        .map_err(|error| error.to_string())?;
    let structure = reader
        .analytics_structure()
        .map_err(|error| error.to_string())?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation
        || project
            .analytics
            .as_ref()
            .map(|runtime| &runtime.session_id)
            != session_id.as_ref()
    {
        return Err("the book changed while Analytics was loading; reopen it".into());
    }
    Ok(AnalyticsView {
        generation,
        session_id,
        report,
        custom_categories,
        selected_category,
        structure,
        tracking_on: project.tracking_on,
    })
}

#[command_boundary::command]
pub(crate) fn analytics_book_report(
    library: State<'_, crate::Library>,
    explicit: State<'_, crate::ExplicitProject>,
    data_home: State<'_, DataHome>,
    path: String,
) -> std::result::Result<LibraryAnalyticsReport, String> {
    let requested = std::path::PathBuf::from(&path);
    if !crate::may_open(
        &library.0,
        explicit.0.as_deref(),
        &crate::projects::known(&data_home.0),
        &requested,
    ) {
        return Err("this book is not in the library".into());
    }
    let store =
        crate::store::Store::open_readonly(&requested).map_err(|error| error.to_string())?;
    let snapshot = store
        .analytics_library_snapshot()
        .map_err(|error| error.to_string())?;
    Ok(LibraryAnalyticsReport {
        book_id: snapshot.book_id,
        identity_id: snapshot
            .raw_pin
            .and_then(|raw| crate::identity::pin_summary(&raw))
            .map(|(id, _)| id),
        membership: snapshot.membership,
        report: snapshot.report,
    })
}

#[command_boundary::command]
pub(crate) fn analytics_set_recording(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    enabled: bool,
    category: Option<Category>,
) -> std::result::Result<(), String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    if enabled {
        let category =
            category.ok_or("choose an activity category before enabling session recording")?;
        let runtime = project
            .store
            .analytics_enable(&category, project.analytics.as_ref())
            .map_err(|error| error.to_string())?;
        project.analytics = Some(runtime);
    } else {
        project
            .store
            .analytics_disable(project.analytics.as_ref())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[command_boundary::command]
pub(crate) fn analytics_set_category(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    category: Category,
) -> std::result::Result<(), String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    if !project
        .store
        .analytics_consent()
        .map_err(|error| error.to_string())?
    {
        return Err("session recording is off".into());
    }
    let runtime = project
        .analytics
        .as_ref()
        .ok_or("this book has no active analytics session")?;
    project.analytics = Some(
        project
            .store
            .analytics_change_category(runtime, &category)
            .map_err(|error| error.to_string())?,
    );
    Ok(())
}

#[command_boundary::command]
pub(crate) fn analytics_adjust(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    segment_id: String,
    adjustment: AdjustmentInput,
) -> std::result::Result<(), String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_adjust(&segment_id, adjustment)
        .map_err(|error| error.to_string())
}

#[command_boundary::command]
pub(crate) fn analytics_exclude_session(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    target_id: String,
    excluded: bool,
) -> std::result::Result<(), String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_exclude_session(&target_id, excluded)
        .map_err(|error| error.to_string())
}

#[command_boundary::command]
pub(crate) fn analytics_custom_add(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    name: String,
) -> std::result::Result<Category, String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_custom_category_add(&name)
        .map_err(|error| error.to_string())
}

#[command_boundary::command]
pub(crate) fn analytics_custom_retire(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    id: String,
) -> std::result::Result<(), String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_custom_category_retire(&id)
        .map_err(|error| error.to_string())
}

#[command_boundary::command]
pub(crate) fn analytics_reset_motivation(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
) -> std::result::Result<i64, String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_reset_motivation()
        .map_err(|error| error.to_string())
}

#[command_boundary::command]
pub(crate) fn analytics_set_motivation(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    visible: bool,
    goal_words: Option<u64>,
) -> std::result::Result<(), String> {
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_set_motivation(visible, goal_words)
        .map_err(|error| error.to_string())
}

#[command_boundary::command]
pub(crate) fn analytics_purge(
    state: State<'_, StoreState>,
    generation: u64,
    session_id: Option<String>,
    confirm: bool,
) -> std::result::Result<(), String> {
    if !confirm {
        return Err("purging session history requires explicit confirmation".into());
    }
    let mut guard = locked(&state);
    let project = current(&mut guard, generation, session_id.as_deref())?;
    project
        .store
        .analytics_purge()
        .map_err(|error| error.to_string())?;
    project.analytics = None;
    Ok(())
}

#[command_boundary::command]
pub(crate) fn analytics_raw_export(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    generation: u64,
    session_id: Option<String>,
) -> std::result::Result<String, String> {
    let path = {
        let mut guard = locked(&state);
        current(&mut guard, generation, session_id.as_deref())?
            .path
            .clone()
    };
    let reader = crate::store::Store::open_readonly(&path).map_err(|error| error.to_string())?;
    let report = reader
        .analytics_report(None)
        .map_err(|error| error.to_string())?;
    let raw = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    {
        let mut guard = locked(&state);
        current(&mut guard, generation, session_id.as_deref())?;
    }
    let dir = crate::export_dir(&data_home.0);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(&dir).map_err(|error| error.to_string())?;
    staged.write_all(&raw).map_err(|error| error.to_string())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    for ordinal in 1..=10_000 {
        let name = if ordinal == 1 {
            "analytics-raw.json".to_string()
        } else {
            format!("analytics-raw-{ordinal}.json")
        };
        let destination = dir.join(name);
        match staged.persist_noclobber(&destination) {
            Ok(_) => return Ok(destination.to_string_lossy().into_owned()),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                staged = error.file
            }
            Err(error) => return Err(error.error.to_string()),
        }
    }
    Err("no unused analytics export filename remains".into())
}
