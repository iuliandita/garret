//! `settings.json` has three writers, one of them automatic (window
//! geometry). All three go through `projects::update_settings`, which locks
//! across the read-modify-write, so a preference set from the panel and a
//! window resize landing at the same moment cannot clobber each other.

use crate::{projects, DataHome, PendingWindow, StoreState};
use std::path::Path;
use tauri::{Manager, State};

/// Record which palette the writer chose. `system`, `light` or `dark`; anything
/// else is an error rather than a default.
///
/// There is no matching getter. The value the page starts with arrives in the
/// initialization script, because a round trip after mount is a round trip after
/// FIRST PAINT -- so a writer overriding a dark desktop to light would see a
/// dark flash on every launch, which is the whole defect the override exists to
/// remove, delivered once per launch instead of permanently.
#[command_boundary::command]
pub(crate) fn settings_set_theme(
    data_home: State<'_, DataHome>,
    theme: String,
) -> std::result::Result<(), String> {
    set_theme(&data_home.0, &theme)
}

/// The whole of `settings_set_theme` except unwrapping Tauri's `State`, which is
/// the only part a `#[tauri::command]` signature makes untestable.
///
/// Read-modify-write of the whole file, not a write of one field: `last_project`
/// lives in it too and must survive a theme change.
fn set_theme(data_home: &Path, theme: &str) -> std::result::Result<(), String> {
    let parsed = projects::Theme::parse(theme)
        .ok_or_else(|| format!("{theme:?} is not a theme this application has"))?;
    projects::update_settings(data_home, |settings| settings.theme = parsed)
}

/// Record which language the host writes in, on the theme's own rule: there is
/// no matching getter, because the value the panel starts with arrives in the
/// initialization script beside `__appTheme`, and NO LIVE RE-RENDER happens on
/// a change here -- every unit in the page renders its strings at mount, so
/// applying a new catalog to the running window would leave half the chrome in
/// one language and half in the other. The panel's own notice says as much:
/// the choice takes effect the next time the application opens.
#[command_boundary::command]
pub(crate) fn settings_set_locale(
    data_home: State<'_, DataHome>,
    locale: String,
) -> std::result::Result<(), String> {
    set_locale(&data_home.0, &locale)
}

/// The whole of `settings_set_locale` except unwrapping Tauri's `State`.
///
/// REFUSED rather than defaulted, unlike `LocaleTag::of`'s own leniency: that
/// leniency exists for a `settings.json` written by hand or by an older build,
/// which must never keep a project from opening. A page bug asking to write a
/// language this build has no catalog for is a different failure and must
/// leave the recorded language alone, exactly as a bad theme does.
fn set_locale(data_home: &Path, locale: &str) -> std::result::Result<(), String> {
    if !crate::strings::is_known(locale) {
        return Err(format!("{locale:?} is not a language this application offers"));
    }
    projects::update_settings(data_home, |settings| {
        settings.locale = projects::LocaleTag::of(locale)
    })
}

/// Record how many words a day the writer is aiming for. One of five known
/// spellings; anything else is an error rather than a default, so the page cannot
/// write a value the next launch will not understand.
#[command_boundary::command]
pub(crate) fn settings_set_daily_target(
    data_home: State<'_, DataHome>,
    target: String,
) -> std::result::Result<(), String> {
    set_daily_target(&data_home.0, &target)
}

#[command_boundary::command]
pub(crate) fn settings_set_theme_family(
    data_home: State<'_, DataHome>,
    family: String,
) -> std::result::Result<(), String> {
    set_theme_family(&data_home.0, &family)
}

#[command_boundary::command]
pub(crate) fn settings_set_time_tracking(
    data_home: State<'_, DataHome>,
    state: State<'_, StoreState>,
    tracking: String,
) -> std::result::Result<(), String> {
    let parsed = projects::TimeTracking::parse(&tracking).ok_or_else(|| {
        format!("{tracking:?} is not a time tracking setting this application offers")
    })?;
    projects::update_settings(&data_home.0, |settings| settings.time_tracking = parsed)?;
    let mut guard = crate::locked(&state);
    if let Some(project) = guard.as_mut() {
        project.tracking_on = parsed == projects::TimeTracking::On;
        if !project.tracking_on {
            if let Some(runtime) = project.analytics.as_ref() {
                if let Err(error) = project.store.analytics_mark_gap(runtime) {
                    eprintln!("analytics: could not mark a tracking gap: {error}");
                }
            }
        }
    }
    Ok(())
}

/// Record how large the interface is drawn, then draw it that large. Record
/// FIRST: a zoom the file refused is a zoom the next launch would not
/// reproduce, and applying it would show the writer a state that does not
/// survive -- the defect every other preference here avoids by the same order.
#[command_boundary::command]
pub(crate) fn settings_set_zoom(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
    zoom: String,
) -> std::result::Result<(), String> {
    let parsed = set_zoom(&data_home.0, &zoom)?;
    apply_zoom(&app, parsed);
    Ok(())
}

/// The whole of `settings_set_zoom` except Tauri's `State` and the webview.
/// Hands back the parsed `Zoom` so the caller can apply it without parsing
/// the string a second time.
fn set_zoom(data_home: &Path, zoom: &str) -> std::result::Result<crate::zoom::Zoom, String> {
    let parsed = crate::zoom::Zoom::parse(zoom)
        .ok_or_else(|| format!("{zoom:?} is not a zoom this application offers"))?;
    projects::update_settings(data_home, |settings| settings.zoom = parsed)?;
    Ok(parsed)
}

/// Page zoom on the one window. Best effort like `apply_spell_checking`: a
/// window that is not there yet is a launch that will apply it a moment later.
pub(crate) fn apply_zoom(app: &tauri::AppHandle, zoom: crate::zoom::Zoom) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(zoom.factor());
    }
}

/// The whole of `settings_set_theme_family` except unwrapping Tauri's `State`.
fn set_theme_family(data_home: &Path, family: &str) -> std::result::Result<(), String> {
    let parsed = projects::ThemeFamily::parse(family)
        .ok_or_else(|| format!("{family:?} is not a theme family this application offers"))?;
    projects::update_settings(data_home, |settings| settings.theme_family = parsed)
}

/// Record what the window opens onto with no `APP_PROJECT`. Read back only
/// through the initialization script (`__appStart`), on the theme's own
/// reason: applying it live would mean nothing, since it governs a launch that
/// already happened.
#[command_boundary::command]
pub(crate) fn settings_set_start(
    data_home: State<'_, DataHome>,
    start: String,
) -> std::result::Result<(), String> {
    set_start(&data_home.0, &start)
}

/// The whole of `settings_set_start` except unwrapping Tauri's `State`.
fn set_start(data_home: &Path, start: &str) -> std::result::Result<(), String> {
    let parsed = projects::Start::parse(start)
        .ok_or_else(|| format!("{start:?} is not a start this application offers"))?;
    projects::update_settings(data_home, |settings| settings.start = parsed)
}

/// Record which pen name the library screen is filtered to, or take the
/// filter off. Unlike `settings_set_theme` there IS a matching getter --
/// `library_overview` -- because this value is read back by a surface that
/// mounts and unmounts as the writer opens and closes the screen, not once at
/// launch.
///
/// A BARE STRING AND NOT A VALIDATED ENUM, unlike every preference above:
/// pen names are an open set the writer grows, so there is nothing here for a
/// closed list to check the id against. `library_overview` is what makes an
/// id the vault no longer holds read as All, rather than this command.
#[command_boundary::command]
pub(crate) fn settings_set_home_identity(
    data_home: State<'_, DataHome>,
    id: Option<String>,
) -> std::result::Result<(), String> {
    set_home_identity(&data_home.0, id)
}

/// The whole of `settings_set_home_identity` except unwrapping Tauri's
/// `State`.
fn set_home_identity(data_home: &Path, id: Option<String>) -> std::result::Result<(), String> {
    projects::update_settings(data_home, move |settings| settings.home_identity = id)
}

/// The whole of `settings_set_daily_target` except unwrapping Tauri's `State`.
fn set_daily_target(data_home: &Path, target: &str) -> std::result::Result<(), String> {
    let parsed = projects::DailyTarget::parse(target)
        .ok_or_else(|| format!("{target:?} is not a daily target this application offers"))?;
    projects::update_settings(data_home, |settings| settings.daily_target = parsed)
}

#[command_boundary::command]
pub(crate) fn settings_set_bible_rows(
    data_home: State<'_, DataHome>,
    rows: u8,
) -> std::result::Result<(), String> {
    set_bible_rows(&data_home.0, rows)
}

fn set_bible_rows(data_home: &Path, rows: u8) -> std::result::Result<(), String> {
    if !(1..=20).contains(&rows) {
        return Err(format!("{rows:?} is not a bible shortcut count this application offers"));
    }
    projects::update_settings(data_home, |settings| settings.bible_rows = rows)
}

#[command_boundary::command]
pub(crate) fn settings_set_writing_modes(
    data_home: State<'_, DataHome>,
    focus: String,
    typewriter: String,
) -> std::result::Result<(), String> {
    set_writing_modes(&data_home.0, &focus, &typewriter)
}

/// BOTH AXES PARSED BEFORE EITHER IS WRITTEN, exactly as `set_typography` does:
/// a call naming one axis wrongly must change nothing at all rather than half of
/// what was asked.
fn set_writing_modes(
    data_home: &Path,
    focus: &str,
    typewriter: &str,
) -> std::result::Result<(), String> {
    let focus = projects::FocusMode::parse(focus)
        .ok_or_else(|| format!("{focus:?} is not a focus mode this application offers"))?;
    let typewriter = projects::TypewriterMode::parse(typewriter).ok_or_else(|| {
        format!("{typewriter:?} is not a typewriter mode this application offers")
    })?;
    projects::update_settings(data_home, |settings| {
        settings.writing_modes = projects::WritingModes { focus, typewriter };
    })
}

/// Record whether a cast member's name is marked in the open scene's prose
/// A plain bool, unlike every other preference here: there is no
/// misspelling to refuse, and any value Tauri deserializes into the argument
/// is one this build already understands.
#[command_boundary::command]
pub(crate) fn settings_set_mark_cast_names(
    data_home: State<'_, DataHome>,
    mark: bool,
) -> std::result::Result<(), String> {
    set_mark_cast_names(&data_home.0, mark)
}

/// The whole of `settings_set_mark_cast_names` except unwrapping Tauri's
/// `State`.
fn set_mark_cast_names(data_home: &Path, mark: bool) -> std::result::Result<(), String> {
    projects::update_settings(data_home, |settings| settings.mark_cast_names = mark)
}

/// Remember the window's size for the next launch. Best effort throughout: a
/// window that fails to record its size must still close.
///
/// Read-modify-write of the whole file, like every other writer of it: the
/// theme, the typography and `last_project` all live there and none may be lost
/// to a resize.
/// What a window of this physical size, at this scale, should be recorded as -
/// or None when it should not be recorded at all.
///
/// A free function over three numbers because the caller below takes a
/// `&tauri::Window` and is therefore untestable, and BOTH of this rule's halves
/// survived a mutation pass while they lived there. That is the second time in
/// two slices; assume the next `#[tauri::command]`-adjacent rule has it too.
fn size_to_record(
    physical_width: f64,
    physical_height: f64,
    scale: f64,
) -> Option<projects::WindowSize> {
    // A scale factor of zero or less is not a display; dividing by it produces
    // an infinity that casts to a nonsense width.
    if scale <= 0.0 {
        return None;
    }
    let width = physical_width / scale;
    let height = physical_height / scale;
    // A zero-sized window is what a compositor reports for a surface that is
    // minimized or not yet mapped. Recording it would mean the next launch opens
    // at MIN_WINDOW having been told to open at nothing.
    if width < 1.0 || height < 1.0 {
        return None;
    }
    // LOGICAL pixels, because that is what the builder is given. Recording
    // physical ones would make a window sized on a HiDPI screen come back at
    // twice the size on an ordinary one - the same class of defect as storing a
    // pixel figure for the type size instead of a name.
    Some(projects::WindowSize {
        width: width as u32,
        height: height as u32,
    })
}

pub(crate) fn record_window_size<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Some(wanted) = size_to_record(f64::from(size.width), f64::from(size.height), scale) else {
        return;
    };
    let Some(data_home) = window.try_state::<DataHome>() else {
        return;
    };
    if let Some(pending) = window.try_state::<PendingWindow>() {
        // Nothing to write if this is the size already on disk. A launch that
        // opens at the recorded size and is never touched must not rewrite the
        // file, and a settle that fires twice for one drag must write once.
        let mut held = pending.last.lock().unwrap_or_else(|e| e.into_inner());
        if *held == Some(wanted) {
            return;
        }
        *held = Some(wanted);
    }
    let _ = projects::update_settings(&data_home.0, |settings| settings.window = wanted);
}

/// How long the window must sit still before its size is worth writing down.
/// Short enough that a writer who resizes and immediately kills the process
/// keeps it, long enough that a drag is one write and not a hundred.
pub(crate) const WINDOW_SETTLE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Record how the manuscript is set. Three bare enum spellings, arriving
/// camelCase-immune because none of them is more than one word.
///
/// All three are non-`Option`, deliberately: a misspelled `Option` argument
/// deserializes to `None` with NO error, which this codebase has already
/// recorded as a silent and destructive failure mode for `parentId`. A typo in
/// any of these is a loud deserialization error instead.
///
/// There is no matching getter, for the same reason `settings_set_theme` has
/// none: the values the page starts with arrive in the initialization script,
/// because a round trip after mount is a round trip after FIRST PAINT.
#[command_boundary::command]
pub(crate) fn settings_set_typography(
    data_home: State<'_, DataHome>,
    family: String,
    size: String,
    measure: String,
) -> std::result::Result<(), String> {
    set_typography(&data_home.0, &family, &size, &measure)
}

/// The whole of `settings_set_typography` except unwrapping Tauri's `State`.
///
/// Every axis is parsed BEFORE anything is written, so a call naming a good
/// family and a bad size changes nothing at all rather than half of what was
/// asked for. Read-modify-write of the whole file, because `last_project` and
/// the theme live in it and must survive a typography change.
fn set_typography(
    data_home: &Path,
    family: &str,
    size: &str,
    measure: &str,
) -> std::result::Result<(), String> {
    let family = projects::ProseFamily::parse(family)
        .ok_or_else(|| format!("{family:?} is not a font this application has"))?;
    let size = projects::ProseSize::parse(size)
        .ok_or_else(|| format!("{size:?} is not a size this application has"))?;
    let measure = projects::ProseMeasure::parse(measure)
        .ok_or_else(|| format!("{measure:?} is not a width this application has"))?;
    projects::update_settings(data_home, |settings| {
        settings.typography = projects::Typography {
            family,
            size,
            measure,
        };
    })
}

#[cfg(test)]
mod tests {
    use super::{
        set_bible_rows, set_daily_target, set_home_identity, set_locale, set_mark_cast_names, set_start,
        set_theme, set_typography, set_writing_modes, set_zoom, size_to_record,
    };
    use tempfile::tempdir;

    #[test]
    fn setting_a_theme_records_it_without_disturbing_the_open_project() {
        // The page sends one field; the file holds two. A write that dropped
        // last_project would send the next launch to a different manuscript.
        let dir = tempdir().unwrap();
        let mut settings = crate::projects::Settings::default();
        settings.last_project = Some("/x/y.db".into());
        crate::projects::write_settings(dir.path(), &settings).unwrap();

        set_theme(dir.path(), "dark").unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.theme, crate::projects::Theme::Dark);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_theme_the_application_does_not_have_is_refused_rather_than_defaulted() {
        // The page is the only caller and sends one of three strings, so this is
        // not a hostile-input guard: it is what stops a page bug from writing a
        // value the next launch reads as system, silently losing a preference
        // the writer set on purpose. Nothing is written on the refusal.
        let dir = tempdir().unwrap();
        set_theme(dir.path(), "light").unwrap();

        let err = set_theme(dir.path(), "chartreuse").unwrap_err();

        assert!(err.contains("chartreuse"), "{err}");
        assert_eq!(
            crate::projects::read_settings(dir.path()).theme,
            crate::projects::Theme::Light,
            "the refused write must leave the recorded theme alone"
        );
    }

    #[test]
    fn setting_a_start_records_it_without_disturbing_the_open_project() {
        let dir = tempdir().unwrap();
        let mut settings = crate::projects::Settings::default();
        settings.last_project = Some("/x/y.db".into());
        crate::projects::write_settings(dir.path(), &settings).unwrap();

        set_start(dir.path(), "home").unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.start, crate::projects::Start::Home);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_start_the_application_does_not_have_is_refused_rather_than_defaulted() {
        let dir = tempdir().unwrap();
        set_start(dir.path(), "blank").unwrap();

        let err = set_start(dir.path(), "sometimes").unwrap_err();

        assert!(err.contains("sometimes"), "{err}");
        assert_eq!(
            crate::projects::read_settings(dir.path()).start,
            crate::projects::Start::Blank,
            "the refused write must leave the recorded start alone"
        );
    }

    #[test]
    fn setting_a_locale_records_it_without_disturbing_the_open_project() {
        let dir = tempdir().unwrap();
        let mut settings = crate::projects::Settings::default();
        settings.last_project = Some("/x/y.db".into());
        crate::projects::write_settings(dir.path(), &settings).unwrap();

        set_locale(dir.path(), "de").unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.locale.as_str(), "de");
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_locale_the_application_does_not_have_is_refused_rather_than_defaulted() {
        // The refusal this command adds on top of `LocaleTag::of`'s own
        // leniency: a page bug asking for a language this build has no
        // catalog for must leave the recorded language alone, not quietly
        // write "en" in its place.
        let dir = tempdir().unwrap();
        set_locale(dir.path(), "de").unwrap();

        let err = set_locale(dir.path(), "fr").unwrap_err();

        assert!(err.contains("fr"), "{err}");
        assert_eq!(
            crate::projects::read_settings(dir.path()).locale.as_str(),
            "de",
            "the refused write must leave the recorded locale alone"
        );
    }

    #[test]
    fn a_window_is_recorded_in_logical_pixels() {
        // A HiDPI screen reports twice the pixels for the same window. Recording
        // those would make the next launch on an ordinary display open at twice
        // the size the writer chose.
        assert_eq!(
            size_to_record(2400.0, 1600.0, 2.0),
            Some(crate::projects::WindowSize {
                width: 1200,
                height: 800
            })
        );
        assert_eq!(
            size_to_record(1200.0, 800.0, 1.0),
            Some(crate::projects::WindowSize {
                width: 1200,
                height: 800
            })
        );
    }

    #[test]
    fn a_window_with_no_size_is_not_recorded_at_all() {
        // What a compositor reports for a surface that is minimized or not yet
        // mapped. Recording it means the next launch opens at MIN_WINDOW having
        // been told to open at nothing - and the size the writer chose is gone.
        assert_eq!(size_to_record(0.0, 0.0, 1.0), None);
        assert_eq!(size_to_record(1200.0, 0.0, 1.0), None);
        // Not a display. Dividing by it gives an infinity that casts to nonsense.
        assert_eq!(size_to_record(1200.0, 800.0, 0.0), None);
    }

    #[test]
    fn setting_typography_records_it_without_disturbing_the_project_or_the_theme() {
        // Three fields arrive; four live in the file. A write that dropped
        // last_project would send the next launch to a different manuscript,
        // and one that dropped the theme would undo a preference the writer set
        // from the same panel a moment earlier.
        let dir = tempdir().unwrap();
        let mut settings = crate::projects::Settings::default();
        settings.last_project = Some("/x/y.db".into());
        settings.theme = crate::projects::Theme::Dark;
        crate::projects::write_settings(dir.path(), &settings).unwrap();

        set_typography(dir.path(), "mono", "larger", "narrow").unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.typography.family, crate::projects::ProseFamily::Mono);
        assert_eq!(read.typography.size, crate::projects::ProseSize::Larger);
        assert_eq!(
            read.typography.measure,
            crate::projects::ProseMeasure::Narrow
        );
        assert_eq!(read.theme, crate::projects::Theme::Dark);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn one_bad_axis_refuses_the_whole_write_rather_than_applying_the_good_ones() {
        // Every axis is parsed before anything is written. A partial write is
        // the worst outcome available here: the panel would show three chosen
        // values, the file would hold two of them, and the next launch would
        // disagree with the panel the writer is looking at.
        let dir = tempdir().unwrap();
        set_typography(dir.path(), "sans", "large", "wide").unwrap();

        // The good family and the good measure sit either side of the bad size,
        // so a per-field write would leave at least one of them changed.
        let err = set_typography(dir.path(), "mono", "gigantic", "narrow").unwrap_err();

        assert!(err.contains("gigantic"), "{err}");
        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.typography.family, crate::projects::ProseFamily::Sans);
        assert_eq!(read.typography.size, crate::projects::ProseSize::Large);
        assert_eq!(read.typography.measure, crate::projects::ProseMeasure::Wide);
    }

    #[test]
    fn one_bad_writing_mode_refuses_the_whole_write() {
        // The same rule as the typography's, and it matters more with two axes
        // than with three: a per-field write here would leave the panel showing
        // one thing and the file holding another, with nothing on screen saying
        // which of them the next launch will believe.
        let dir = tempdir().unwrap();
        set_writing_modes(dir.path(), "paragraph", "on").unwrap();

        let err = set_writing_modes(dir.path(), "off", "sometimes").unwrap_err();

        assert!(err.contains("sometimes"), "{err}");
        let read = crate::projects::read_settings(dir.path());
        // The GOOD axis in the refused call is the one that would have changed,
        // so this is what a per-field write would break.
        assert_eq!(
            read.writing_modes.focus,
            crate::projects::FocusMode::Paragraph
        );
        assert_eq!(
            read.writing_modes.typewriter,
            crate::projects::TypewriterMode::On
        );
    }

    #[test]
    fn writing_modes_round_trip_through_the_file() {
        let dir = tempdir().unwrap();
        set_writing_modes(dir.path(), "paragraph", "on").unwrap();
        let read = crate::projects::read_settings(dir.path());
        assert_eq!(
            read.writing_modes.focus,
            crate::projects::FocusMode::Paragraph
        );
        assert_eq!(
            read.writing_modes.typewriter,
            crate::projects::TypewriterMode::On
        );

        // And back off again: a preference that can only be turned ON is a
        // preference a writer cannot undo.
        set_writing_modes(dir.path(), "off", "off").unwrap();
        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.writing_modes, crate::projects::WritingModes::default());
    }

    #[test]
    fn setting_the_writing_modes_keeps_the_rest_of_the_file() {
        // update_settings is a read-modify-write of the whole file; every other
        // preference and last_project live in it.
        let dir = tempdir().unwrap();
        crate::projects::update_settings(dir.path(), |s| {
            s.last_project = Some("/x/y.db".into());
            s.theme = crate::projects::Theme::Dark;
        })
        .unwrap();

        set_writing_modes(dir.path(), "paragraph", "on").unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
        assert_eq!(read.theme, crate::projects::Theme::Dark);
    }

    #[test]
    fn each_axis_refuses_a_word_that_is_legal_on_another_axis() {
        // A boundary that consulted one shared table would accept all three of
        // these, write them, and produce a settings file whose next launch
        // silently reads every axis as its default.
        let dir = tempdir().unwrap();
        for (family, size, measure, bad) in [
            ("large", "medium", "wide", "large"),
            ("sans", "mono", "wide", "mono"),
            ("sans", "medium", "larger", "larger"),
        ] {
            let err = set_typography(dir.path(), family, size, measure).unwrap_err();
            assert!(err.contains(bad), "{err}");
        }
    }

    #[test]
    fn a_target_the_application_does_not_offer_is_refused_and_written_nowhere() {
        let dir = tempdir().unwrap();
        set_daily_target(dir.path(), "500").expect("a target it does offer");
        let err = set_daily_target(dir.path(), "750").unwrap_err();
        assert!(err.contains("750"), "{err}");
        assert_eq!(
            crate::projects::read_settings(dir.path()).daily_target,
            crate::projects::DailyTarget::W500,
            "a refused target must leave the recorded one alone"
        );
    }

    #[test]
    fn every_offered_target_round_trips_through_the_file() {
        let dir = tempdir().unwrap();
        for name in ["off", "250", "500", "1000", "2000"] {
            set_daily_target(dir.path(), name).expect(name);
            assert_eq!(
                crate::projects::read_settings(dir.path())
                    .daily_target
                    .as_str(),
                name
            );
        }
    }

    #[test]
    fn bible_rows_round_trip_and_keep_other_settings() {
        let dir = tempdir().unwrap();
        crate::projects::update_settings(dir.path(), |settings| {
            settings.last_project = Some("/x/y.db".into());
        })
        .unwrap();
        set_bible_rows(dir.path(), 12).unwrap();
        let settings = crate::projects::read_settings(dir.path());
        assert_eq!(settings.bible_rows, 12);
        assert_eq!(settings.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn bible_rows_outside_the_offered_range_are_refused() {
        let dir = tempdir().unwrap();
        set_bible_rows(dir.path(), 12).unwrap();
        for rows in [0, 21] {
            assert!(set_bible_rows(dir.path(), rows).is_err());
            assert_eq!(crate::projects::read_settings(dir.path()).bible_rows, 12);
        }
    }

    #[test]
    fn setting_a_zoom_records_it_without_disturbing_the_open_project() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("cc.local.app")).unwrap();
        std::fs::write(
            dir.path().join("cc.local.app/settings.json"),
            br#"{"last_project":"/x/y.db"}"#,
        )
        .unwrap();
        let returned = set_zoom(dir.path(), "175").unwrap();
        assert_eq!(returned, crate::zoom::Zoom::Z175);
        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.zoom, crate::zoom::Zoom::Z175);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_zoom_this_build_does_not_offer_is_an_error_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let err = set_zoom(dir.path(), "110").unwrap_err();
        assert!(err.contains("110"), "{err}");
        assert!(!dir.path().join("cc.local.app/settings.json").exists());
    }

    #[test]
    fn setting_mark_cast_names_records_it_without_disturbing_the_open_project() {
        let dir = tempdir().unwrap();
        let mut settings = crate::projects::Settings::default();
        settings.last_project = Some("/x/y.db".into());
        crate::projects::write_settings(dir.path(), &settings).unwrap();

        set_mark_cast_names(dir.path(), false).unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert!(!read.mark_cast_names);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn mark_cast_names_round_trips_both_ways() {
        let dir = tempdir().unwrap();
        set_mark_cast_names(dir.path(), false).unwrap();
        assert!(!crate::projects::read_settings(dir.path()).mark_cast_names);
        set_mark_cast_names(dir.path(), true).unwrap();
        assert!(crate::projects::read_settings(dir.path()).mark_cast_names);
    }

    #[test]
    fn setting_a_home_identity_records_it_without_disturbing_the_open_project() {
        let dir = tempdir().unwrap();
        let mut settings = crate::projects::Settings::default();
        settings.last_project = Some("/x/y.db".into());
        crate::projects::write_settings(dir.path(), &settings).unwrap();

        set_home_identity(dir.path(), Some("i1".into())).unwrap();

        let read = crate::projects::read_settings(dir.path());
        assert_eq!(read.home_identity.as_deref(), Some("i1"));
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_home_identity_of_none_clears_it() {
        let dir = tempdir().unwrap();
        set_home_identity(dir.path(), Some("i1".into())).unwrap();
        set_home_identity(dir.path(), None).unwrap();
        assert_eq!(crate::projects::read_settings(dir.path()).home_identity, None);
    }
}
