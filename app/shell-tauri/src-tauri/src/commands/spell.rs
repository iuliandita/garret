use crate::{projects, store, DataHome};
use std::path::Path;
use tauri::State;

/// Turn WebKitGTK's own spell checker on, in the writer's language.
///
/// THE WEB ENGINE'S, NOT OURS, and that is the whole design. WebKitGTK already
/// links enchant, already draws the underlines in its web process on its own
/// schedule, and already offers suggestions plus Learn Spelling in its context
/// menu. A page-side checker would be a dictionary to ship, a decoration plugin
/// recomputing misspelled ranges on every `docChanged`, and our own suggestion
/// popover - and the recompute is the word-count-rescan shape that cost
/// measurable typing latency while every scalar gate stayed green. This adds NO
/// per-keystroke page work at all.
///
/// Reached through `with_webview`, which is a host-side Rust API on the window
/// rather than an IPC surface - so unlike `core:event:listen` it is NOT governed
/// by the capability ACL and needs no permission granted.
///
/// BEST EFFORT throughout. A machine with no dictionary for the chosen language
/// gets no underlines, which is exactly what it got before; a startup must not
/// fail while turning on a convenience.
///
/// PER-PROJECT DICTIONARY. Learn Spelling still writes to enchant's personal
/// wordlist at `~/.config/enchant/<lang>.dic`, machine-global and shared with
/// every other enchant application -- that path is untouched. What changed is
/// `ENCHANT_CONFIG_DIR`, set (in `main.rs`, before the window exists) to an
/// application-owned directory under the data home rather than left unset. The
/// open project's own word list -- stored in the project, so it travels with
/// the manuscript and the writer can see and edit it, see `store::dict` -- is
/// RENDERED into that directory as `<lang>.dic` by `sync_project_dictionary`,
/// on the open-project path, never on a keystroke. Enchant then reads from
/// there instead of from the machine-global directory, and a novelist's
/// invented names stop leaking between books.
#[cfg(target_os = "linux")]
pub(crate) fn apply_spell_checking(app: &tauri::AppHandle, enabled: bool) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let languages = spell_languages_from(
        std::env::var("APP_SPELL_LANGUAGES").ok().as_deref(),
        std::env::var("LANG").ok().as_deref(),
    );
    let _ = window.with_webview(move |webview| {
        use webkit2gtk::WebContextExt;
        use webkit2gtk::WebViewExt;
        if let Some(context) = webview.inner().context() {
            let borrowed: Vec<&str> = languages.iter().map(String::as_str).collect();
            context.set_spell_checking_languages(&borrowed);
            // AFTER the languages, so the first check runs against the list the
            // writer asked for rather than against WebKit's guess from the
            // locale and then again against ours.
            context.set_spell_checking_enabled(enabled);
        }
    });
}

// Other web engines have no application-controlled spelling integration yet.
#[cfg(not(target_os = "linux"))]
pub(crate) fn apply_spell_checking(_app: &tauri::AppHandle, _enabled: bool) {}

#[command_boundary::command]
pub(crate) fn settings_set_spelling(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
    spelling: String,
) -> std::result::Result<(), String> {
    let parsed = projects::Spelling::parse(&spelling)
        .ok_or_else(|| format!("{spelling:?} is not a spelling setting this application offers"))?;
    // PERSIST FIRST, then apply. A writer whose preference reached the file and
    // not the window sees it take effect on the next launch; one whose
    // preference reached the window and not the file watches it revert, with
    // nothing saying why - and would reasonably conclude the setting is broken.
    projects::update_settings(&data_home.0, |settings| settings.spelling = parsed)?;
    apply_spell_checking(&app, parsed.enabled());
    Ok(())
}

/// The languages to check in, most preferred first.
///
/// TAKES THE ENVIRONMENT AS ARGUMENTS rather than reading it, the shape
/// `windows_data_home_from` already uses here: a test that set `LANG` would
/// mutate process-global state shared with every other test running in
/// parallel, and the rule this encodes is worth pinning without that.
///
/// `override_list` is `APP_SPELL_LANGUAGES`, comma separated, so a rig can ask
/// for a language it KNOWS the machine has a dictionary for - depending on the
/// operator's locale would make the run report a different thing on a different
/// machine, and "no underlines" and "no dictionary installed" are one picture.
///
/// `locale` is `LANG`, whose encoding suffix is stripped: enchant wants `en_US`
/// and `LANG` is `en_US.UTF-8`.
fn spell_languages_from(override_list: Option<&str>, locale: Option<&str>) -> Vec<String> {
    if let Some(raw) = override_list {
        let chosen: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        // Set-but-empty is not a choice. Treating it as one asks enchant for no
        // languages at all, which is spell checking silently off with the
        // setting silently on.
        if !chosen.is_empty() {
            return chosen;
        }
    }
    let tag = locale.unwrap_or("").split('.').next().unwrap_or("").trim();
    // "C" and "POSIX" name no human language, so asking enchant for them would
    // be asking for a dictionary that cannot exist - and the writer would get no
    // underlines with nothing saying why.
    if tag.is_empty() || tag == "C" || tag == "POSIX" {
        return vec!["en_US".to_owned()];
    }
    vec![tag.to_owned()]
}

/// Where the machine-owned `.dic` files this application ever writes live.
/// Application scratch, never the storage of record -- see `projects::spell_dir`.
pub(crate) fn dict_dir(data_home: &Path) -> std::path::PathBuf {
    projects::spell_dir(data_home)
}

/// The languages the checker is configured for, resolved the same way
/// `apply_spell_checking` resolves them -- both must agree, or a word rendered
/// into `fr_FR.dic` would sit unread while enchant checks against `en_US.dic`.
///
/// PUBLIC TO THE CRATE because every real call site of `sync_project_dictionary`
/// calls this to build the `languages` argument that function now takes
/// explicitly -- see its doc comment for why reading the environment moved out
/// of it.
pub(crate) fn configured_languages() -> Vec<String> {
    spell_languages_from(
        std::env::var("APP_SPELL_LANGUAGES").ok().as_deref(),
        std::env::var("LANG").ok().as_deref(),
    )
}

/// Render the open project's word list into `ENCHANT_CONFIG_DIR`, one
/// `<lang>.dic` per configured language, one word per line.
///
/// CALLED ON THE OPEN-PROJECT PATH ONLY -- at startup and from `project_open`,
/// and again from `dict_add`/`dict_remove` so a change reaches the file
/// enchant reads without waiting for the next launch. NEVER on a keystroke:
/// that would reverse the founding performance argument recorded at the top of
/// this file.
///
/// `languages` ARRIVES AS AN ARGUMENT rather than being read here, the same
/// shape `spell_languages_from` already uses and for the same reason: a test
/// that set `APP_SPELL_LANGUAGES` or `LANG` would mutate process-global state
/// shared with every other test running in parallel. Every real call site
/// passes `configured_languages()`, which is what keeps this function and
/// `apply_spell_checking` resolving the same list.
///
/// TRUNCATES, deliberately, via `fs::write` rather than an append: a project
/// closed and a different one opened must not go on carrying the previous
/// project's words forward in a directory the two SHARE -- ENCHANT_CONFIG_DIR
/// is one directory for the whole process, not one per project.
/// `an_empty_list_replaces_a_previous_projects_words` below pins that
/// directly.
///
/// BEST EFFORT, like the rest of this module: a write that fails (a read-only
/// data home, a filesystem at capacity) must not fail the open, the add, or
/// the remove it rode in on -- the writer's project is fine either way, only
/// the checker's view of it is stale.
pub(crate) fn sync_project_dictionary(
    data_home: &Path,
    store: &store::Store,
    languages: &[String],
) {
    let words = match store.dict_words() {
        Ok(w) => w,
        Err(_) => return,
    };
    let dir = dict_dir(data_home);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut body = String::new();
    for word in &words {
        body.push_str(&word.word);
        body.push('\n');
    }
    for lang in languages {
        let _ = std::fs::write(dir.join(format!("{lang}.dic")), &body);
    }
}

#[cfg(test)]
mod tests {
    use super::{dict_dir, spell_languages_from, sync_project_dictionary};
    use crate::store::Store;
    use tempfile::tempdir;

    #[test]
    fn the_spell_language_comes_from_the_override_when_set() {
        // A rig has to be able to ask for a language it KNOWS this machine has a
        // dictionary for. Depending on the operator's locale would make the run
        // report a different thing on a different machine, and "no underlines"
        // and "no dictionary installed" are one picture.
        assert_eq!(
            spell_languages_from(Some("en_GB"), Some("de_DE.UTF-8")),
            vec!["en_GB".to_owned()],
        );
    }

    #[test]
    fn the_spell_language_override_takes_a_list() {
        assert_eq!(
            spell_languages_from(Some("en_US, fr_FR ,"), None),
            vec!["en_US".to_owned(), "fr_FR".to_owned()],
        );
    }

    #[test]
    fn an_empty_override_falls_through_to_the_locale() {
        // Set-but-empty is not a choice. Treating it as one would ask enchant
        // for no languages at all, which is spell checking silently off with the
        // setting silently on.
        assert_eq!(
            spell_languages_from(Some("  , ,"), Some("fr_FR.UTF-8")),
            vec!["fr_FR".to_owned()],
        );
    }

    #[test]
    fn the_locale_loses_its_encoding_suffix() {
        // enchant wants `en_US`; LANG is `en_US.UTF-8`. Passing the whole thing
        // asks for a dictionary named after an encoding.
        assert_eq!(
            spell_languages_from(None, Some("en_US.UTF-8")),
            vec!["en_US".to_owned()]
        );
        // And a locale with no encoding suffix at all.
        assert_eq!(
            spell_languages_from(None, Some("pt_BR")),
            vec!["pt_BR".to_owned()]
        );
    }

    #[test]
    fn a_locale_naming_no_human_language_falls_back_to_english() {
        // "C" and "POSIX" are not languages, so asking enchant for them is
        // asking for a dictionary that cannot exist - and the writer gets no
        // underlines with nothing saying why.
        for value in ["C", "POSIX", "", "  "] {
            assert_eq!(
                spell_languages_from(None, Some(value)),
                vec!["en_US".to_owned()],
                "{value:?}",
            );
        }
        assert_eq!(spell_languages_from(None, None), vec!["en_US".to_owned()]);
    }

    /// PINS THE TRUNCATION `sync_project_dictionary`'s own doc comment names:
    /// two projects sharing one `ENCHANT_CONFIG_DIR` must not let the second
    /// project's checker go on reading the first's words. `languages` is
    /// passed explicitly rather than through the environment, the same reason
    /// `spell_languages_from` takes its inputs as arguments -- a test that set
    /// `APP_SPELL_LANGUAGES` would mutate state shared with every other test
    /// running in parallel in this binary.
    #[test]
    fn an_empty_list_replaces_a_previous_projects_words() {
        let dir = tempdir().unwrap();
        let data_home = dir.path().join("data");
        let languages = vec!["en_US".to_owned()];

        let store_a = Store::open(&dir.path().join("a.db")).unwrap();
        store_a.dict_add("Zorbulax").unwrap();
        sync_project_dictionary(&data_home, &store_a, &languages);

        let dic_path = dict_dir(&data_home).join("en_US.dic");
        assert_eq!(std::fs::read_to_string(&dic_path).unwrap(), "Zorbulax\n");

        // A DIFFERENT project, opened into the SAME ENCHANT_CONFIG_DIR -- the
        // one directory this process ever points enchant at, regardless of
        // which project is open. Its own list is empty, so the file this
        // render leaves behind must be too.
        let store_b = Store::open(&dir.path().join("b.db")).unwrap();
        sync_project_dictionary(&data_home, &store_b, &languages);

        assert_eq!(std::fs::read_to_string(&dic_path).unwrap(), "");
    }

    /// The reverse direction: a project's own word reaches its OWN rendered
    /// file, for the language actually passed in -- not `en_US` by default,
    /// which every case above would pass even if the argument were silently
    /// ignored.
    #[test]
    fn a_projects_words_reach_its_rendered_file_for_the_languages_given() {
        let dir = tempdir().unwrap();
        let data_home = dir.path().join("data");
        let languages = vec!["fr_FR".to_owned()];

        let store = Store::open(&dir.path().join("p.db")).unwrap();
        store.dict_add("Kethrani").unwrap();
        sync_project_dictionary(&data_home, &store, &languages);

        let dic_path = dict_dir(&data_home).join("fr_FR.dic");
        assert_eq!(std::fs::read_to_string(&dic_path).unwrap(), "Kethrani\n");
        // No en_US.dic at all: only the language actually passed in is written.
        assert!(!dict_dir(&data_home).join("en_US.dic").exists());
    }
}
