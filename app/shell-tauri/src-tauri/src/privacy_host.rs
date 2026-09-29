use crate::{privacy, DataHome};
use serde::Serialize;
use tauri::{Emitter, Manager};

pub const CHANGED: &str = "app://privacy-changed";
pub const LOCK: &str = "app://privacy-lock";
pub struct Epoch(pub std::sync::atomic::AtomicU64);
pub struct Barrier(pub std::sync::atomic::AtomicBool);

#[cfg(any(windows, test))]
pub fn picker_epoch_allows(locked: bool, current: u64, captured: u64) -> bool {
    !locked && current == captured
}

pub fn locked(app: &tauri::AppHandle) -> bool {
    app.try_state::<Barrier>()
        .is_some_and(|b| b.0.load(std::sync::atomic::Ordering::SeqCst))
        || app
            .try_state::<privacy::Privacy>()
            .is_some_and(|p| p.locked())
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    locked: bool,
    recovery: bool,
    shortcut: privacy::Shortcut,
}

#[command_boundary::command]
pub fn privacy_status(app: tauri::AppHandle) -> Status {
    let state = app.state::<privacy::Privacy>().status().state;
    Status {
        enabled: state != privacy::LockState::Disabled,
        locked: locked(&app),
        recovery: state == privacy::LockState::Recovery,
        shortcut: app.state::<privacy::Privacy>().status().policy.shortcut,
    }
}

/// Only pending durable work and lifecycle acknowledgements cross a locked boundary.
pub fn allowed_while_locked(command: &str) -> bool {
    matches!(
        command,
        "privacy_status"
            | "privacy_drain_result"
            | "privacy_close_failed"
            | "privacy_ready"
            | "doc_flush"
            | "writing_time_note"
            | "confirm_close"
            | "holding_close"
            | "request_quit"
    )
}

#[command_boundary::command]
pub fn privacy_lock(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || crate::privacy_native::lock_now(&handle))
            .map_err(|_| "privacy unavailable".into())
    }
    #[cfg(windows)]
    {
        crate::privacy_windows::lock_now(&app);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    Err("privacy unavailable".into())
}

#[command_boundary::command]
pub fn privacy_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || crate::privacy_native::settings(&handle))
            .map_err(|_| "privacy unavailable".into())
    }
    #[cfg(windows)]
    {
        crate::privacy_windows::settings(&app);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    Err("privacy unavailable".into())
}

pub struct ContentShown(pub std::sync::atomic::AtomicBool);
pub struct PageReady(pub std::sync::atomic::AtomicBool);

#[command_boundary::command]
pub fn privacy_ready(app: tauri::AppHandle) {
    app.state::<PageReady>()
        .0
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

#[command_boundary::command]
pub fn privacy_drain_result(app: tauri::AppHandle, ok: bool) {
    if !ok {
        show_save_failure(&app);
    }
}

#[command_boundary::command]
pub fn privacy_close_failed(app: tauri::AppHandle) {
    // Do not release the host close hold until the writer can see their work.
    show_save_failure(&app);
}

fn show_save_failure(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::privacy_native::save_failed(&handle));
    }
    #[cfg(windows)]
    crate::privacy_windows::save_failed(app);
}

pub fn strings(app: &tauri::AppHandle) -> crate::strings::Strings {
    crate::projects::read_settings(&app.state::<DataHome>().0)
        .locale
        .strings()
}

pub fn changed(app: &tauri::AppHandle) {
    let _ = app.emit(CHANGED, ());
}

/// Always lowercase: the 2026-09-28 identity record.
pub const APP_NAME: &str = "garret";

/// What is open, then the application. Only for the titles that name a book or
/// the library; the locked and neutral titles exist to conceal and stay bare.
pub fn app_title(name: &str) -> String {
    format!("{name} - {APP_NAME}")
}

pub fn title(app: &tauri::AppHandle, name: &str) -> String {
    let privacy = app.state::<privacy::Privacy>();
    if locked(app) {
        strings(app).t("privacy.locked")
    } else if privacy.status().policy.neutral_title {
        strings(app).t("privacy.neutral")
    } else {
        app_title(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_saves_and_lifecycle_survive_but_content_and_new_actions_do_not() {
        for cmd in [
            "doc_flush",
            "writing_time_note",
            "confirm_close",
            "privacy_drain_result",
        ] {
            assert!(allowed_while_locked(cmd), "{cmd}");
        }
        for cmd in [
            "doc_load",
            "project_items",
            "project_open",
            "project_export_as",
            "item_create",
            "release_close",
            "privacy_settings",
            "unknown",
        ] {
            assert!(!allowed_while_locked(cmd), "{cmd}");
        }
    }

    #[test]
    fn an_open_title_names_the_application_after_what_is_open() {
        assert_eq!(app_title("Untitled book"), "Untitled book - garret");
    }

    #[test]
    fn picker_result_dies_when_lock_or_later_unlock_changes_epoch() {
        assert!(picker_epoch_allows(false, 7, 7));
        assert!(!picker_epoch_allows(true, 7, 7));
        assert!(!picker_epoch_allows(false, 8, 7));
    }
}

#[command_boundary::command]
pub fn privacy_activity(app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        let _ =
            app.run_on_main_thread(move || crate::privacy_native::composition_activity(&handle));
    }
    #[cfg(windows)]
    crate::privacy_windows::activity(&app);
}
