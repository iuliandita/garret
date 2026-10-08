// app/shell-tauri/src-tauri/src/projects.rs
// The project library: the directory the application owns, plus the small
// amount of state that must outlive a window (which project was open last).
// There is deliberately no file dialog -- it would be a dependency, and a
// native modal is undrivable under Xvfb -- so the library is a plain directory
// the application both lists and writes. APP_PROJECT still opens an arbitrary
// path; that contract is untouched by anything here.

use crate::store::Store;
use crate::APP_DIR;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// Long enough for a title, short enough to stay inside every filesystem's
/// name limit once ".db" and a WAL suffix are appended.
const SLUG_MAX: usize = 64;
static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The meta key holding the name the writer typed.
/// The meta key a project records its typed name under. Public so main.rs reads
/// the same constant rather than a second copy of the string.
pub use crate::core_constants::NAME_KEY;

/// The local date, `YYYY-MM-DD`, that `DAY_BASELINE_KEY` was taken on. Absent on
/// every project written before this slice, which is a missing value and not a
/// broken file -- `get_meta` returns None and the first call anchors it.
/// No production code reads or writes it now; tests use it to prove old files
/// keep it.
#[cfg(test)]
pub const DAY_KEY: &str = "day";

/// The project's saved word count at the moment `DAY_KEY` was written. Today's
/// progress is the current total minus this, which is a subtraction over two
/// figures the host already holds rather than a scan of the manuscript.
pub use crate::core_constants::DAY_BASELINE_KEY;

/// The local date `TIME_MINUTES_KEY` counts for. Same shape as `DAY_KEY`, kept
/// separate so a day that turns for one figure and not yet the other (the two
/// are anchored by different calls) cannot reset the wrong one.
pub const TIME_DAY_KEY: &str = "time_day";
/// Minutes of that day in which the manuscript changed. A MINUTE COUNTS WHEN
/// AN EDIT LANDED IN IT and for no other reason: not a timer, not idle
/// detection, nothing a writer cannot check against their own memory.
pub const TIME_MINUTES_KEY: &str = "time_minutes";
/// The last minute (epoch minutes) already counted, so a second edit in the
/// same minute counts nothing.
pub const TIME_LAST_MINUTE_KEY: &str = "time_last_minute";

/// The recovery point a project was restored from, as a FILE NAME and never a
/// path. The design puts this in the project's OWN meta table beside the name:
/// the restored project's own file name only approximates which point a copy
/// came from, because a truncated stem or a reused ordinal makes it approximate
/// badly. This row is the answer.
///
/// **THE DIRECTORY IS NOT PART OF THE ANSWER.** It held
/// `point.display()` whole until then, so every restored project carried the
/// operating-system user name inside the file that travels. See
/// `without_directory`.
pub const RECOVERED_FROM_KEY: &str = "recovered_from";

/// When the restore ran, in milliseconds. Not when the point was taken -- that
/// is the point's own `at_ms`, and conflating the two would date a manuscript
/// by when someone asked for it back.
pub const RECOVERED_AT_KEY: &str = "recovered_at";

/// The final component of a path, and nothing else.
///
/// THE ONE STATEMENT OF THE RULE, called by the restore path and by `salvage`
/// alike. Two
/// statements would let one artifact stop naming the writer's home directory
/// while the other went on naming it, which is the drift `fold_with_offsets`
/// is shared to prevent.
///
/// **A path in a file that travels is the operating-system user's name.**
/// `/home/<user>/...` reaches a beta reader, a USB stick, a backup and -- since
/// 050's `meta` sweep -- `manifest.json` in plain text. What a reader needs is
/// WHICH FILE, and the file name answers that: a recovery point is
/// `<point-id>.db`, unique within the book's own recovery directory, and an
/// archive is `<slug>-<point-id>.db`, whose slug is the project's own name,
/// which the same file already carries under `NAME_KEY`.
///
/// A value with no final component (`/`, a path ending in `.` or `..`) answers
/// with NOTHING. Returning the input there would put the directory back through
/// the one branch that has no name to give, which is the whole leak arriving by
/// the edge case.
pub fn without_directory(path: &Path) -> String {
    // TEXTUAL, and NOT `Path::file_name`, which was the first draft and leaked.
    // `file_name` answers over normalized COMPONENTS, and a `.` is not a
    // component: it reads `/home/writer/.` as `writer` and hands back the
    // operating-system user's own name, which is the exact string this function
    // exists to remove. Accept both separator spellings on every platform so
    // a project moved between operating systems cannot retain its old directory.
    let raw = path.to_string_lossy();
    match raw.rsplit(['/', '\\']).find(|part| !part.is_empty()) {
        Some(".") | Some("..") | None => String::new(),
        Some(last) => last.to_string(),
    }
}

/// Open a project file for WRITING, sweeping the one row an older build wrote
/// as an absolute path.
///
/// THE SEAM, so that opening a project read-write and forgetting the directory
/// are one act rather than two a call site can get half right. Both open paths
/// -- the launch and `project_open` -- go through it; `Store::open` itself does
/// not, because the CLI and the restore path open files they are not opening
/// FOR the writer.
///
pub fn open_for_writing(path: &Path) -> crate::store::Result<Store> {
    refuse_bundle_open(path)?;
    let store = Store::open(path)?;
    forget_recovery_directory(&store);
    Ok(store)
}

/// A selected or moved book must still exist; only first-run creation may create it.
pub fn open_existing_for_writing(path: &Path) -> crate::store::Result<Store> {
    refuse_bundle_open(path)?;
    let store = Store::open_existing(path)?;
    forget_recovery_directory(&store);
    Ok(store)
}

fn refuse_bundle_open(path: &Path) -> crate::store::Result<()> {
    if path.exists() && matches!(crate::backup_bundle::marker_present_typed(path), Ok(true)) {
        return Err(crate::store::StoreError::Corrupt(
            "this is a backup snapshot; restore its whole point folder into a new project".into(),
        ));
    }
    Ok(())
}

/// Rewrite a `RECOVERED_FROM_KEY` row an older build wrote as an absolute path
/// down to its file name. True when the file was changed.
///
/// ON THE OPEN PATH, because the fix applying only to NEW writes would leave
/// every project restored before this fix leaking for as long as it exists,
/// and the writer has nothing they could do about it. `name_if_unnamed` is the
/// precedent: a small, conditional, best-effort normalization of one `meta`
/// row, taken on an open that is already writing.
///
/// **CONDITIONAL, and that is not tidiness.** It must not write when the row is
/// already a bare name (an unconditional write is a `meta` write per open of
/// every restored project) and it must not write when there is no row at all
/// (which would put an empty `recovered_from` into every project in the
/// library, claiming a restore that never happened).
///
/// NOT A SCHEMA MIGRATION. A migration would bump `user_version` and close the
/// file to every distributable the test group is running, for a row nothing
/// branches on.
pub fn forget_recovery_directory(store: &Store) -> bool {
    // NO ARM OF ITS OWN FOR "NO ROW" OR "THE READ FAILED", and that is the
    // mutation pass's answer rather than a shortcut: an early return for either
    // one is a branch nothing can observe, because both leave `recorded` empty,
    // `without_directory` answers the empty string, and the comparison below
    // returns false without writing. A read failure is a damaged file, and
    // refusing to open a book over one `meta` row would trade a manuscript for
    // a caption -- `name_if_unnamed`'s rule, reached here by doing nothing.
    let recorded = store
        .get_meta(RECOVERED_FROM_KEY)
        .ok()
        .flatten()
        .unwrap_or_default();
    let named = without_directory(Path::new(&recorded));
    if named == recorded {
        return false;
    }
    store.set_meta(RECOVERED_FROM_KEY, &named).is_ok()
}

/// `<data_home>/garret/projects`
pub fn library_dir(data_home: &Path) -> PathBuf {
    data_home.join(APP_DIR).join("projects")
}

/// Where a new book goes with no folder the writer chose still in force:
/// `remembered` if it is an absolute path other than `library`,
/// `documents_dir` plus `"Books"` otherwise, `home_dir` plus `"Books"` if
/// there is no Documents folder, and a refusal if there is neither.
///
/// PURE, on purpose -- every environment lookup arrives as a parameter, so a
/// test drives it with a fabricated Documents folder or none at all, never the
/// real `$HOME`. It creates nothing and rewrites no settings; `create_into_dir`
/// and its siblings still own the moment a folder actually gets made.
///
/// `remembered == library` IS TREATED AS UNSET. The hidden library used to be
/// written into `new_book_dir` by every plain create, including one that never
/// saw a dialog (`create_into_dir` sets it unconditionally) -- so a settings
/// file from a build before this slice can hold the hidden library as a
/// "remembered" folder, and reading that back as a writer's own choice would
/// keep every pre-159 profile on the hidden default forever.
pub fn resolve_new_book_dir(
    remembered: Option<&str>,
    library: &Path,
    documents_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(custom) = remembered {
        let path = PathBuf::from(custom);
        if path.is_absolute() && path != library {
            return Ok(path);
        }
    }
    documents_dir
        .or(home_dir)
        .map(|base| base.join("Books"))
        .ok_or_else(|| {
            "no Documents folder and no home directory: nowhere to put a new book by default"
                .to_string()
        })
}

/// `<data_home>/garret/exports`, beside `projects/`.
pub fn exports_dir(data_home: &Path) -> PathBuf {
    data_home.join(APP_DIR).join("exports")
}

/// Where the writer drops a Markdown file for import, beside `exports/`.
pub fn imports_dir(data_home: &Path) -> PathBuf {
    data_home.join(APP_DIR).join("imports")
}

/// `<data_home>/garret/spell`, beside `projects/`. Pointed to by
/// `ENCHANT_CONFIG_DIR` so the open project's dictionary reaches enchant
/// without ever touching the machine-global `~/.config/enchant/` -- see
/// commands/spell.rs. APPLICATION-OWNED SCRATCH, not the storage of record:
/// the project's word list lives in the project's own file and is rendered
/// here on the open-project path.
pub fn spell_dir(data_home: &Path) -> PathBuf {
    data_home.join(APP_DIR).join("spell")
}

/// `<data_home>/garret/recovery/<slug>`, beside `projects/`.
///
/// PER PROJECT, not one shared directory: the retention rule thins a book's own
/// recovery points against each other, and a shared directory would let a
/// morning on one manuscript evict the only point another one had.
///
/// The application owns this outright -- it creates it, names files in it, and
/// prunes it. `<slug>` is the project FILE STEM, not the typed name: a project
/// opened through `APP_PROJECT` has no library slug at all, and the stem is
/// already unique per file.
pub fn recovery_dir(data_home: &Path, slug: &str) -> PathBuf {
    data_home.join(APP_DIR).join("recovery").join(slug)
}

/// `<data_home>/garret/recovery/<slug>/archives`, for the file a writer
/// moves off this computer themselves.
///
/// INSIDE the recovery area and NOT the recovery directory itself, and both
/// halves are the design's. Inside, because the design puts the archive "into
/// the same `recovery/` area" -- there is no application-owned destination for
/// device-loss protection and a path supplied by the page would be the first
/// outbound crossing of the `in_library`/`may_open` line.
///
/// Not the same directory, because `recovery::manifest_path` is one fixed
/// `manifest.json` per directory. An archive entry in the recovery manifest
/// would be handed out by `recovery::verified_points` as a restorable recovery
/// point and counted by `describe_dir` into the bar's same-device coverage --
/// the blur the design's section 6 exists to prevent, since a recovery point
/// is exactly as lost as the project when the machine goes and an archive is
/// not.
///
/// NOT PRUNED, unlike its parent. Deleting an archive the writer has not
/// carried away yet destroys the only off-device candidate that existed;
/// `exports/` is the shipped precedent for a directory the application writes
/// to and never deletes from.
pub fn archives_dir(data_home: &Path, slug: &str) -> PathBuf {
    recovery_dir(data_home, slug).join("archives")
}

/// `<data_home>/garret/mirror/<slug>`, or wherever `APP_MIRROR_DIR`
/// points, for the readable manuscript the writer opens in another editor.
///
/// **The only directory in this file the writer is invited to look inside**,
/// which is why it is also the only one with an override. Everything else here
/// is an application-owned area whose layout is an implementation detail;
/// a mirror is a folder of the writer's own manuscript.
///
/// An override REPLACES the application's own root, and the project's slug is
/// still appended to it: an operator pointing two projects at one directory
/// would otherwise have them overwrite each other's files, silently, one item
/// at a time.
///
/// The resolved path is what the enable act shows the writer, and showing it is
/// the point -- it is what catches a mirror landing in a synced or cloud folder,
/// which is the one place two pen names' manuscripts can end up side by side.
/// `root` is the resolved `APP_MIRROR_DIR`, read ONCE at startup and passed
/// down -- `APP_RECOVERY_MODE`'s discipline. A function that read the
/// environment itself would be untestable without mutating process-global
/// state from parallel test threads.
pub fn mirror_dir(data_home: &Path, root: Option<&Path>, slug: &str) -> PathBuf {
    match root {
        Some(root) => root.join(slug),
        None => data_home.join(APP_DIR).join("mirror").join(slug),
    }
}

/// Whether `name` is something the page may ask to import.
///
/// The check is on the NAME, before any filesystem call, and it is why import
/// takes a bare filename rather than a path. A name with no separator and no
/// `..` cannot address anything outside the one directory it is joined to, so
/// there is nothing here for a race to invalidate — unlike an `exists()` probe
/// or a canonicalize-and-compare, which is the check that keeps getting
/// bypassed.
///
/// A leading `.` is refused as well: not for traversal, which is already
/// covered, but because a dotfile in the drop directory is not something the
/// writer put there to import.
pub fn import_name_ok(name: &str) -> bool {
    if name.is_empty() || name.starts_with('.') {
        return false;
    }
    // `\` as well as `/`: it is not a separator on this platform, and a name
    // carrying one has still been composed somewhere this function cannot see.
    // `\0` truncates the name at the syscall boundary, so `book.md\0/../x` must
    // not read as ending in `.md`.
    //
    // This scan and nothing else. A `Path::new(name).components().count() != 1`
    // check was here as belt and braces and is GONE: on Linux it is unreachable
    // behind the scan above, no input could kill it, and an unfalsifiable guard
    // on a security boundary is worse than none — it invites the reader to
    // credit it for the refusal. What would make it live is a Windows path
    // prefix, and this application is Linux-only by scope decision.
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".docx")
}

/// The importable files in `dir`, by name, sorted. A missing directory is an
/// empty list rather than an error: not having dropped a file in yet is the
/// ordinary state, not a fault.
pub fn list_imports(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| import_name_ok(n))
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort();
    out
}

/// Create a project from an already-parsed import.
///
/// Deliberately NOT `create` plus a fill: `create` writes a starter scene, and a
/// manuscript that arrived with three hundred scenes must not also carry an
/// empty one nobody wrote. Storage publication is shared; manuscript
/// initialization remains separate.
pub fn create_imported(
    library: &Path,
    name: &str,
    rows: &[crate::store::ImportRow<'_>],
    strings: &crate::strings::Strings,
) -> Result<ProjectSummary, String> {
    create_imported_with(library, name, rows, strings, |_| {})
}

fn create_imported_with(
    library: &Path,
    name: &str,
    rows: &[crate::store::ImportRow<'_>],
    strings: &crate::strings::Strings,
    before_create: impl FnOnce(&Path),
) -> Result<ProjectSummary, String> {
    create_book_with(library, name, before_create, |store, path| {
        store.import_tree(rows).map(|_| ()).map_err(|e| {
            format!(
                "{}: cannot write the imported manuscript: {e}",
                path.display()
            )
        })?;
        // An outline still needs one scene to open; imported scenes gain none.
        store
            .ensure_starter_structure(strings)
            .map(|_| ())
            .map_err(|e| {
                format!(
                    "{}: cannot create the starter chapter and scene: {e}",
                    path.display()
                )
            })
    })
}

/// The first free `<slug>.md`, `<slug>-2.md`, `<slug>-3.md`, ... in `dir`.
/// Never returns a path that already exists. A manuscript is evidence and
/// evidence is never silently overwritten.
///
/// The answer is `max(ordinal on disk) + 1`, from ONE directory read, not an
/// `exists()` probe walking upward: with `n.md` and `n-3.md` present, filling
/// the gap at `n-2.md` would sort an older export ahead of a newer one.
///
/// NOT race-free, and cannot be from here: the directory can gain the chosen
/// name between this read and the caller's create. The real guard is the
/// caller opening with `create_new(true)`, which the kernel enforces.
pub fn pick_export_path(dir: &Path, slug: &str) -> PathBuf {
    let mut max = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            // Every entry, not just files: `create_new` fails on a directory
            // wearing the name too, so a path this function hands back must be
            // unclaimed by anything.
            if let Some(n) = export_ordinal(&entry.file_name().to_string_lossy(), slug) {
                max = max.max(n);
            }
        }
    }
    match max {
        0 => dir.join(format!("{slug}.md")),
        n => dir.join(format!("{slug}-{}.md", n + 1)),
    }
}

/// Which export of `slug` a file name is, or None when it is not one.
///
/// Read strictly against the spellings `pick_export_path` itself writes: the
/// bare name is 1 and a suffix is a plain decimal from 2 up. `n-0.md` and
/// `n-1.md` are therefore NOT ordinals -- reading `n-0` as one would make the
/// successor `n-1.md`, a name this module never claims. A leading zero and a
/// number too large to increment are refused for the same reason.
///
/// The reading is per-slug and that is deliberate: `n-3.md` is ordinal 3 for
/// slug `n` and the bare name for slug `n-3`. Both are true, neither is
/// ambiguous, because the slug is always known at the call.
/// What a restored project's file name says it is. Never shortened away.
const RECOVERED_SUFFIX: &str = "-recovered";

/// The file stem a restored project takes: `<stem>-recovered`, then
/// `-recovered-2`, and so on. Pure -- it names a candidate and looks at
/// nothing.
///
/// THERE IS NO `exists()` PROBE HERE, DELIBERATELY. The caller walks the
/// ordinals claiming each candidate with `create_new`, so the kernel's refusal
/// is the ONLY rule deciding whether a name is free. A probe beside it would
/// refuse the same inputs, which is this repo's recorded shape for a guard that
/// survives its own mutation: with the probe present, `create_new` could be
/// weakened to `create` and nothing would observe it.
///
/// A stem too long for `SLUG_MAX` is truncated, and the STEM yields rather than
/// the suffix: a name that has lost its `-recovered` no longer says what the
/// file is. The consequence, stated rather than hidden: two projects agreeing
/// in their first characters restore to `<truncated>-recovered` and
/// `-recovered-2`, which reads as two restores of one book. The authoritative
/// answer is the `RECOVERED_FROM_KEY` row inside the file. An ordinal's digits
/// can also carry a name a few characters past `SLUG_MAX`, which is safe: that
/// cap is this application's own tidiness limit, far below the filesystem's.
pub fn restored_stem(stem: &str, ordinal: u32) -> String {
    let mut base = stem.to_string();
    let mut room = SLUG_MAX.saturating_sub(RECOVERED_SUFFIX.len());
    if base.len() > room {
        // A stem arriving through APP_PROJECT is any UTF-8 the filesystem
        // accepted, so the cut is taken at a character boundary rather than at
        // a byte index that would panic.
        while room > 0 && !base.is_char_boundary(room) {
            room -= 1;
        }
        base.truncate(room);
        // The cap can land mid-gap; `slugify` carries the same correction for
        // the same reason.
        trim_hyphens(&mut base);
    }
    match ordinal {
        0 | 1 => format!("{base}{RECOVERED_SUFFIX}"),
        n => format!("{base}{RECOVERED_SUFFIX}-{n}"),
    }
}

/// The name a restored project shows in the library, tracking the ordinal its
/// file took so the row and the file cannot disagree.
///
/// COMPOSED IN THE HOST, which is the open half of plan 008: writer-facing
/// strings Rust builds do not go through the page's catalog yet. Named here so
/// the localization slice finds it rather than discovering it.
pub fn restored_name(original: &str, ordinal: u32) -> String {
    if ordinal <= 1 {
        format!("{original} (recovered)")
    } else {
        format!("{original} (recovered {ordinal})")
    }
}

fn export_ordinal(file_name: &str, slug: &str) -> Option<u64> {
    let rest = file_name.strip_prefix(slug)?.strip_suffix(".md")?;
    if rest.is_empty() {
        return Some(1);
    }
    let digits = rest.strip_prefix('-')?;
    if digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Parse failure here is overflow: refusing keeps the answer a free name,
    // where saturating would return one that exists.
    let n = digits.parse().ok()?;
    if n < 2 {
        None
    } else {
        Some(n)
    }
}

/// `<data_home>/garret/settings.json`
pub fn settings_path(data_home: &Path) -> PathBuf {
    data_home.join(APP_DIR).join("settings.json")
}

/// `<data_home>/garret/startup-error.txt`, beside `settings.json`.
///
/// It exists because a Windows GUI-subsystem executable HAS NO STDERR: nothing
/// is attached to it, so a panic on a failed startup prints into a void and the
/// writer double-clicks the application and sees nothing happen at all. The
/// likeliest cause is a missing WebView2 runtime, which is a thing they can fix
/// in two minutes once told. A file is the only channel that survives here, and
/// it is written on every platform so the path is exercised by the one this
/// project can actually run.
pub fn startup_error_path(data_home: &Path) -> PathBuf {
    data_home.join(APP_DIR).join("startup-error.txt")
}

/// Lowercase; ASCII alphanumerics and hyphens; runs of other characters
/// collapse to a single hyphen; leading and trailing hyphens trimmed; capped at
/// 64 characters. When no ASCII survives, Unicode alphanumeric titles use a
/// deterministic digest basename. Empty and punctuation-only titles are refused.
///
/// A typed hyphen is treated as a separator too, so "a - b" is one gap rather
/// than three; the output alphabet is unchanged either way.
pub fn slugify(name: &str) -> Option<String> {
    let mut out = String::new();
    for ch in name.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    trim_hyphens(&mut out);
    out.truncate(SLUG_MAX);
    // The cap can land mid-gap, so the trim runs again rather than emitting a
    // name ending in a hyphen.
    trim_hyphens(&mut out);
    if !out.is_empty() {
        return Some(out);
    }
    let title = name.trim();
    if !title.chars().any(char::is_alphanumeric) {
        return None;
    }
    let digest = Sha256::digest(title.as_bytes());
    Some(format!("book-{:x}", digest)[..37].to_string())
}

fn trim_hyphens(s: &mut String) {
    while s.ends_with('-') {
        s.pop();
    }
}

#[derive(Debug, Serialize)]
pub struct ProjectSummary {
    pub path: String,
    /// From the project's own meta table. Falls back to the file stem when the
    /// file cannot be opened or carries no name.
    pub name: String,
    /// Unix seconds from the file's mtime.
    pub modified_at: i64,
    /// Set when the file exists but could not be opened or read.
    pub error: Option<String>,
    /// The file is not there at all: a remembered book the writer moved or
    /// deleted in their file manager. Distinct from `error`, because the page
    /// offers to FORGET a missing book and must not offer that for a present
    /// one that merely failed to open.
    pub missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_warning: Option<crate::book_registration::Warning>,
}

/// 0 rather than an error: an unreadable mtime costs the list its ordering, not
/// its contents, and a project missing from the library is the worse failure.
///
/// `pub(crate)`: `commands::library` reads it too, for the same figure
/// `summarize` already shows in every other listing.
pub(crate) fn modified_at(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn book_is_missing(path: &Path) -> std::io::Result<bool> {
    match fs::metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

pub(crate) fn summarize(path: &Path) -> ProjectSummary {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // open_readonly, never open: `open` creates schema v1 on a blank file, so
    // listing a library with `open` would WRITE to every file it looked at and
    // leave -wal/-shm beside them. A listing must not modify what it lists.
    let (name, error) = match Store::open_readonly(path) {
        Ok(store) => match store.get_meta(NAME_KEY) {
            Ok(Some(n)) if !n.is_empty() => (n, None),
            // Opened fine, just has no name: a project from before names were
            // recorded. The file stem is a true answer, not an error.
            Ok(_) => (stem, None),
            Err(e) => (stem, Some(e.to_string())),
        },
        Err(e) => (stem, Some(e.to_string())),
    };
    ProjectSummary {
        path: path.to_string_lossy().into_owned(),
        name,
        modified_at: modified_at(path),
        error,
        // Lookup errors do not establish absence; the read error stays visible.
        missing: book_is_missing(path).unwrap_or(false),
        registration_warning: None,
    }
}

/// Every *.db directly in the library, newest first. A file that fails to open
/// is INCLUDED carrying its error, never skipped: a manuscript that has become
/// unreadable must be visible, not silently absent.
pub fn list(library: &Path) -> Vec<ProjectSummary> {
    let entries = match fs::read_dir(library) {
        Ok(e) => e,
        // A library that does not exist yet holds no projects. Distinguishing
        // that from an unreadable directory would give the page nothing to do
        // differently.
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<ProjectSummary> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("db"))
        .map(|p| summarize(&p))
        .collect();
    // Name breaks the tie so two projects written in the same second do not
    // swap places between calls.
    out.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// Every book the host knows about: the default library's contents, plus the
/// paths it recorded for books that live elsewhere.
///
/// THE OPENABILITY SET, not a convenience index. `may_open` used to ask "is this
/// file directly inside the library directory"; once a book can live anywhere
/// that question is not answerable from the path, and this is what replaces it.
///
/// DEDUPLICATED BY CANONICAL PATH where the file exists, and by the raw path
/// where it does not: a book that is both in the library and remembered must
/// appear once in the writer's own library panel, and two spellings of one path
/// are one book.
///
/// A remembered path whose file is gone is KEPT. `list`'s rule -- a manuscript
/// that has become unreadable must be visible, not silently absent -- and this
/// list is the only record of where that manuscript was.
pub fn known(data_home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let identity = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());

    // THE FIRST LOOP'S `insert` IS A POPULATOR, NOT A FILTER, and the mutation
    // pass is what asked: removing its guard changes nothing, because a
    // directory listing cannot yield the same file twice. What it is for is
    // filling `seen` so the SECOND loop can recognise a library book that was
    // also recorded. Kept and labelled rather than deleted -- the recorded rule
    // is that a guard no input can reach is worse than none, and this one is
    // not a guard.
    for summary in list(&library_dir(data_home)) {
        let path = PathBuf::from(summary.path);
        if seen.insert(identity(&path)) {
            out.push(path);
        }
    }
    for recorded in read_settings(data_home).books {
        let path = PathBuf::from(recorded);
        // A `~/` entry with no usable HOME to expand it is a relative
        // path, and a relative path in the openability set would resolve
        // against the process's working directory at open time. Listed as
        // missing by `list_known`, never here.
        if !path.is_absolute() {
            continue;
        }
        if seen.insert(identity(&path)) {
            out.push(path);
        }
    }
    out
}

/// Drop a remembered book from the list, because the writer asked.
///
/// ONLY A BOOK WHOSE FILE IS GONE. The list is the openability gate and the only
/// record of where a manuscript was; forgetting a book that is still there
/// would make a present manuscript unopenable from the page, and a writer who
/// wants it out of the list can move it first. A library book is never in the
/// list (the scan finds it), so it is refused as "not remembered", which is
/// the truth. Touches no file: what goes is a line in `settings.json`.
pub fn forget_book(data_home: &Path, path: &str) -> Result<(), String> {
    if !book_is_missing(Path::new(path))
        .map_err(|error| format!("{path}: could not check whether this book is missing: {error}"))?
    {
        return Err(format!("{path}: this book is still there, so it cannot be forgotten"));
    }
    if !read_settings(data_home).books.iter().any(|b| b == path) {
        return Err(format!("{path}: not a remembered book"));
    }
    update_settings(data_home, |s| s.books.retain(|b| b != path))
}

/// Where the book at `from` would land if moved into `dir`: the SAME FILE
/// NAME, in the new folder. Refused when that is not a move.
///
/// The name is kept on purpose. The stem is the slug the recovery directory,
/// the archives and the mirror are keyed by, and `<stem>.pictures/` beside the
/// file is named by it too; a move that renamed the file would orphan all
/// four, so a move does not rename. A writer who wants a new file name has no
/// such act, and that is the honest state of it.
pub fn move_target(from: &Path, dir: &Path) -> Result<PathBuf, String> {
    let name = from
        .file_name()
        .ok_or_else(|| format!("{}: not a file", from.display()))?;
    if !dir.is_dir() {
        return Err(format!("{}: not a folder", dir.display()));
    }
    let to = dir.join(name);
    if to == from {
        return Err(format!(
            "{}: this book is already in that folder",
            from.display()
        ));
    }
    if to.exists() {
        if physical_same_file(&to, from)? {
            return Err(format!(
                "{}: this book is already in that folder",
                from.display()
            ));
        }
        return Err(format!(
            "{}: there is already a file with this book's name in that folder",
            to.display()
        ));
    }
    refuse_destination_logs(&to).map_err(|error| format!("{}: {error}", to.display()))?;
    let pictures = crate::pictures::dir_for(&to);
    if pictures.exists() {
        return Err(format!(
            "{}: there is already a pictures folder with this book's name in that folder",
            pictures.display()
        ));
    }
    let research = crate::research::dir_for(&to);
    if research.exists() {
        return Err(format!("{}: there is already a research folder with this book's name in that folder", research.display()));
    }
    Ok(to)
}

/// Whether two existing paths name the same physical file.
///
/// A failed comparison is not evidence that the files differ: the filesystem
/// may have refused metadata for either path. Callers must handle that refusal
/// rather than treating it as `false` and accepting an ambiguous alias.
pub fn physical_same_file(a: &Path, b: &Path) -> Result<bool, String> {
    same_file::is_same_file(a, b).map_err(|e| format!("{} and {}: {e}", a.display(), b.display()))
}

/// A failed move retains every component and records whether the whole book
/// is still together. A caller must not reopen a database with missing assets.
#[derive(Debug)]
pub(crate) struct MoveBookError {
    message: String,
    pub(crate) reopen_at: Option<PathBuf>,
}

impl std::fmt::Display for MoveBookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn refuse_destination_logs(to: &Path) -> std::io::Result<()> {
    for path in [to.with_extension("db-wal"), to.with_extension("db-shm")] {
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "{}: there is already a database sidecar at this location",
                        path.display()
                    ),
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Exclusive publication also protects rollback from a new file at the old
/// path. Unsupported filesystems fail closed; there is no copying fallback.
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
pub(crate) fn rename_without_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}

#[cfg(windows)]
pub(crate) fn rename_without_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    if [from, to]
        .iter()
        .any(|path| path.as_os_str().encode_wide().any(|unit| unit == 0))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "a move path contains a null character",
        ));
    }
    // MoveFileExW with neither REPLACE_EXISTING nor COPY_ALLOWED.
    renamore::rename_exclusive(from, to)
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
)))]
pub(crate) fn rename_without_replace(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "exclusive moves are unavailable on this platform",
    ))
}

/// Move a closed, checkpointed book within one filesystem. A nonempty WAL
/// refuses the move. Every forward and rollback rename refuses replacement.
/// If rollback is blocked, report all retained locations and leave the book
/// closed until its components can be reunited without overwriting anything.
pub(crate) fn move_book_files(from: &Path, to: &Path) -> Result<(), MoveBookError> {
    move_book_files_with(from, to, rename_without_replace)
}

pub(crate) fn move_book_files_with(
    from: &Path,
    to: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), MoveBookError> {
    let wal = from.with_extension("db-wal");
    if wal.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Err(MoveBookError {
            message: format!(
                "{}: the book is still being written; try again in a moment",
                from.display()
            ),
            reopen_at: Some(from.to_path_buf()),
        });
    }
    let _ = fs::remove_file(&wal);
    let _ = fs::remove_file(from.with_extension("db-shm"));
    let mut parts = vec![("database", from.to_path_buf(), to.to_path_buf(), false)];
    for (label, source, destination) in [
        (
            "pictures folder",
            crate::pictures::dir_for(from),
            crate::pictures::dir_for(to),
        ),
        (
            "research folder",
            crate::research::dir_for(from),
            crate::research::dir_for(to),
        ),
    ] {
        if source.is_dir() {
            parts.push((label, source, destination, false));
        }
    }
    for index in 0..parts.len() {
        let (_, source, destination, _) = &parts[index];
        let result = if index == 0 {
            refuse_destination_logs(destination).and_then(|()| rename(source, destination))
        } else {
            rename(source, destination)
        };
        if let Err(error) = result {
            let mut message = move_error(source, destination, &error);
            for (label, source, destination, moved) in parts[..index].iter_mut().rev() {
                let result = if *label == "database" {
                    refuse_destination_logs(source).and_then(|()| rename(destination, source))
                } else {
                    rename(destination, source)
                };
                if let Err(back) = result {
                    message.push_str(&format!(
                        ". Rollback failed: {}",
                        move_error(destination, source, &back)
                    ));
                } else {
                    *moved = false;
                }
            }
            let together = parts.iter().all(|(_, _, _, moved)| !moved);
            for (label, source, destination, moved) in &parts {
                let retained = if *moved { destination } else { source };
                message.push_str(&format!(". The {label} is at {}", retained.display()));
            }
            if !together {
                message.push_str(
                    ". The book's files are in different folders; the book has been left closed",
                );
            }
            return Err(MoveBookError {
                message,
                reopen_at: together.then(|| from.to_path_buf()),
            });
        }
        parts[index].3 = true;
    }
    Ok(())
}

fn move_error(from: &Path, to: &Path, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::CrossesDevices {
        return format!(
            "{}: that folder is on another drive. This application moves a book only within one drive; close the book, copy its database file and adjacent pictures and research folders, then open it from its new place",
            to.display()
        );
    }
    format!("{} -> {}: {e}", from.display(), to.display())
}

/// What `settings.json` learns from a move: the old path leaves `books`, the
/// new one enters it when it is outside the library (a library book is found
/// by the scan), and `last_project` follows when the launch was not told which
/// book to open. The checked form reports a durable move whose registry update
/// failed so callers cannot claim the old location is still current.
pub fn record_move_checked(
    data_home: &Path,
    from: &Path,
    to: &Path,
    follow_last: bool,
) -> Result<(), String> {
    let library = library_dir(data_home);
    let from_s = from.to_string_lossy().into_owned();
    let to_s = to.to_string_lossy().into_owned();
    let outside = !in_library(&library, to);
    update_settings(data_home, |s| {
        s.books.retain(|b| b != &from_s);
        if outside && !s.books.iter().any(|b| b == &to_s) {
            s.books.push(to_s.clone());
        }
        if follow_last {
            s.last_project = Some(to_s.clone());
        }
        for location in &mut s.book_locations {
            if location.path == from_s {
                location.path = to_s.clone();
            }
        }
    })
}

/// Compatibility wrapper for callers that cannot report a settings failure.
#[cfg(test)]
pub fn record_move(data_home: &Path, from: &Path, to: &Path, follow_last: bool) {
    let _ = record_move_checked(data_home, from, to, follow_last);
}

/// Every known book, described. What the library panel renders.
///
/// The ordering is `list`'s and for its reason: newest first, name breaking the
/// tie so two projects written in the same second do not swap places between
/// calls.
pub fn list_known(data_home: &Path) -> Vec<ProjectSummary> {
    let mut out: Vec<ProjectSummary> = known(data_home).iter().map(|p| summarize(p)).collect();
    out.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// `create_in` with the test's library as its chosen folder.
#[cfg(test)]
pub fn create(library: &Path, name: &str) -> Result<ProjectSummary, String> {
    create_in(library, name, &crate::strings::Strings::english())
}

/// Build a named book with a starter scene and publish it exclusively into the
/// folder the writer chose. Does NOT make it the current
/// project: creation and opening are separate acts, so a failed open cannot
/// lose a just-created manuscript.
pub fn create_in(
    dir: &Path,
    name: &str,
    strings: &crate::strings::Strings,
) -> Result<ProjectSummary, String> {
    create_in_with(dir, name, strings, |_| {})
}

fn create_in_with(
    dir: &Path,
    name: &str,
    strings: &crate::strings::Strings,
    before_create: impl FnOnce(&Path),
) -> Result<ProjectSummary, String> {
    create_book_with(dir, name, before_create, |store, path| {
        store
            .ensure_starter_structure(strings)
            .map(|_| ())
            .map_err(|e| {
                format!(
                    "{}: cannot create the starter chapter and scene: {e}",
                    path.display()
                )
            })
    })
}

/// Build only in an owned directory, then publish a closed, complete database.
/// A competing destination is never opened, adopted, or removed on failure.
fn create_book_with(
    dir: &Path,
    name: &str,
    before_create: impl FnOnce(&Path),
    fill: impl FnOnce(&Store, &Path) -> Result<(), String>,
) -> Result<ProjectSummary, String> {
    create_book_with_cleanup(dir, name, before_create, fill, tempfile::TempDir::close)
}

fn create_book_with_cleanup(
    dir: &Path,
    name: &str,
    before_create: impl FnOnce(&Path),
    fill: impl FnOnce(&Store, &Path) -> Result<(), String>,
    cleanup: impl FnOnce(tempfile::TempDir) -> std::io::Result<()>,
) -> Result<ProjectSummary, String> {
    let slug = slugify(name)
        .ok_or_else(|| format!("\"{name}\" has no characters that can name a file"))?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{slug}.db"));
    if path.exists() {
        return Err(format!(
            "a project named \"{name}\" already exists at {}",
            path.display()
        ));
    }
    before_create(&path);
    let mut builder = tempfile::Builder::new();
    builder.prefix(".garret-create-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let stage = builder
        .tempdir_in(dir)
        .map_err(|e| format!("{}: cannot prepare a new book: {e}", path.display()))?;
    let retained_stage = stage.path().to_path_buf();
    let result = (|| {
        let staged = stage.path().join("project.db");
        let store = Store::open(&staged).map_err(|e| format!("{}: {e}", path.display()))?;
        store
            .set_meta(NAME_KEY, name)
            .map_err(|e| format!("{}: cannot record the project name: {e}", path.display()))?;
        fill(&store, &path)?;
        store
            .checkpoint()
            .map_err(|e| format!("{}: cannot finish the new book: {e}", path.display()))?;
        drop(store);
        match fs::metadata(staged.with_extension("db-wal")) {
            Ok(metadata) if metadata.len() > 0 => {
                return Err(format!(
                    "{}: the new book's log could not be folded into its database",
                    path.display()
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "{}: cannot check the new book's log: {error}",
                    path.display()
                ))
            }
        }
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staged)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("{}: cannot sync the new book: {e}", path.display()))?;
        refuse_destination_logs(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        rename_without_replace(&staged, &path).map_err(|e| {
            format!(
                "{}: cannot publish the new book without replacing an existing file: {e}",
                path.display()
            )
        })?;
        if let Ok(parent) = fs::File::open(dir) {
            let _ = parent.sync_all();
        }
        Ok(summarize(&path))
    })();
    match (result, cleanup(stage)) {
        (result, Ok(())) => result,
        (Err(error), Err(cleanup)) => Err(format!(
            "{error}. Temporary book files remain at {}: {cleanup}",
            retained_stage.display()
        )),
        (Ok(made), Err(cleanup)) => {
            // Publication succeeded; callers must still register the saved book.
            eprintln!(
                "the book was created at {}, but its temporary folder remains at {}: {cleanup}",
                path.display(),
                retained_stage.display()
            );
            Ok(made)
        }
    }
}

/// Copy a recovery point into the library as a NEW project.
///
/// NOTHING EXISTING IS TOUCHED. Not the point, not the project it was taken
/// from, not whatever the writer has open. That is the whole of the design's
/// section 5 and the reason this function cannot be handed a destination:
/// guessing which of two real states of a book is the live one silently
/// discards the newer, so the application puts both in the library and the
/// writer decides by looking at them.
///
/// IT VERIFIES THE POINT AGAIN, HERE, rather than trusting the manifest's
/// `verified` flag. That flag records that a read passed when the point was
/// TAKEN; what a restore needs to know is whether the bytes are sound NOW.
/// `checksum` is bitrot detection and explicitly never authentication -- what
/// authenticates a point is this structural read.
///
/// The restored project's NAME is read out of the copy rather than passed in:
/// the point file is the manuscript, the manifest beside it is a description of
/// the manuscript, and the two can disagree.
///
/// The destination is claimed with `create_new` BEFORE the copy. `VACUUM INTO`
/// refuses a destination with content but ADOPTS a zero-byte one, so the claim
/// is what makes "never over something that already exists" true rather than
/// usually true, and it is the kernel enforcing it rather than an `exists()`
/// check a race invalidates.
/// Copy a recovery point to `dest`, verbatim.
///
/// `open_readonly`, NEVER `open`. `open` migrates, and a restore that upgraded
/// the schema of the point it was reading would damage the one artifact this
/// whole feature exists to keep intact. Today every point is at the current
/// schema, so the two behave identically and no fixture at that version can
/// tell them apart -- this is a guard against the next migration, and
/// `copying_a_point_does_not_migrate_it` reaches it with a genuine v1 file.
///
/// Separated from `restore_point_into` so a test can make the copy FAIL. The
/// cleanup below it was otherwise unreachable: validation runs before the
/// destination is claimed, so no fixture could produce a failure with a file
/// already on disk. `recovery::attempt` injects its `take` for the same reason.
pub fn copy_point(point: &Path, dest: &Path) -> Result<(), String> {
    let reader = Store::open_readonly(point).map_err(|e| e.to_string())?;
    reader
        .vacuum_into(dest)
        .map_err(|e| format!("{}: {e}", dest.display()))
}

pub fn restore_point_into(
    point: &Path,
    library: &Path,
    stem: &str,
    now_ms: i64,
) -> Result<ProjectSummary, String> {
    if point.is_dir() {
        restore_point_with(point, library, stem, now_ms, crate::backup_bundle::copy_database)
    } else {
        restore_point_with(point, library, stem, now_ms, copy_point)
    }
}

/// `restore_point_into` with the copy injected. See `copy_point`.
pub fn restore_point_with(
    point: &Path,
    library: &Path,
    stem: &str,
    now_ms: i64,
    copy: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<ProjectSummary, String> {
    restore_point_impl(point, library, stem, now_ms, false, copy).map(|(summary, _)| summary)
}

pub fn restore_point_with_picture_gaps(
    point: &Path,
    library: &Path,
    stem: &str,
    now_ms: i64,
) -> Result<(ProjectSummary, Vec<String>), String> {
    if !point.is_dir() {
        return Err("picture-gap restore requires a whole point folder".into());
    }
    restore_point_impl(point, library, stem, now_ms, true, crate::backup_bundle::copy_database)
}

fn restore_point_impl(
    point: &Path,
    library: &Path,
    stem: &str,
    now_ms: i64,
    allow_picture_gaps: bool,
    copy: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(ProjectSummary, Vec<String>), String> {
    let bundled = point.is_dir();
    let research_bundle = bundled && crate::backup_bundle::restore_inventory_version(point)? == 2;
    let source_db = if bundled {
        crate::backup_bundle::db_path(point)
    } else {
        point.to_path_buf()
    };
    if bundled {
        let check = if allow_picture_gaps {
            crate::backup_bundle::verify_database_for_restore(point)
        } else {
            crate::backup_bundle::verify(point)
        };
        check.map_err(|e| format!("bundle cannot be restored: {e}"))?;
    }
    // Before anything is created: a refusal must leave the library exactly as
    // it found it.
    let validation = crate::cli::validate(&source_db)
        .map_err(|e| format!("{}: cannot be read: {e}", source_db.display()))?;
    if !validation.ok {
        return Err(format!(
            "{}: this recovery point does not read cleanly and was not restored",
            point.display()
        ));
    }
    if !bundled && crate::backup_bundle::marker_present(&source_db)? {
        return Err(
            "this database belongs to an asset-aware point; restore its whole folder".into(),
        );
    }

    fs::create_dir_all(library).map_err(|e| format!("cannot create {}: {e}", library.display()))?;
    // A sidecar occupies a name even when its database is missing. Claim only
    // a free name, then recheck before using any reserved destination.
    let mut ordinal: u32 = 1;
    let (path, mut claim) = loop {
        let restored = restored_stem(stem, ordinal);
        let candidate = library.join(format!("{restored}.db"));
        match refuse_destination_logs(&candidate) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                ordinal += 1;
                continue;
            }
            Err(e) => return Err(format!("{}: {e}", candidate.display())),
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(claim) => {
                if let Err(error) = refuse_destination_logs(&candidate) {
                    drop(claim);
                    fs::remove_file(&candidate).map_err(|cleanup| {
                        format!(
                            "{}: {error}; cannot remove the reserved database: {cleanup}",
                            candidate.display()
                        )
                    })?;
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        ordinal += 1;
                        continue;
                    }
                    return Err(format!("{}: {error}", candidate.display()));
                }
                if bundled {
                    match fs::create_dir(crate::pictures::dir_for(&candidate)) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                            drop(claim);
                            let _ = fs::remove_file(&candidate);
                            ordinal += 1;
                            continue;
                        }
                        Err(e) => {
                            drop(claim);
                            let _ = fs::remove_file(&candidate);
                            return Err(format!("cannot reserve restored pictures: {e}"));
                        }
                    }
                    if research_bundle {
                        let mut builder = fs::DirBuilder::new();
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::DirBuilderExt;
                            builder.mode(0o700);
                        }
                        match builder.create(crate::research::dir_for(&candidate)) {
                            Ok(()) => {}
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                                let _ = fs::remove_dir_all(crate::pictures::dir_for(&candidate));
                                drop(claim);
                                let _ = fs::remove_file(&candidate);
                                ordinal += 1;
                                continue;
                            }
                            Err(e) => {
                                let _ = fs::remove_dir_all(crate::pictures::dir_for(&candidate));
                                drop(claim);
                                let _ = fs::remove_file(&candidate);
                                return Err(format!("cannot reserve restored research: {e}"));
                            }
                        }
                    }
                }
                break (candidate, claim);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => ordinal += 1,
            Err(e) => return Err(format!("{}: {e}", candidate.display())),
        }
    };

    let mut picture_gaps = Vec::new();
    let mut stage = None;
    let filled = (|| -> Result<ProjectSummary, String> {
        // SQLite must never see the destination's unrelated WAL or SHM.
        let mut builder = tempfile::Builder::new();
        builder.prefix(".garret-restore-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        stage = Some(
            builder
                .tempdir_in(library)
                .map_err(|e| format!("cannot prepare the restored database: {e}"))?,
        );
        let staged = stage.as_ref().unwrap().path().join("project.db");
        fs::File::create(&staged).map_err(|e| format!("{}: {e}", staged.display()))?;
        copy(&source_db, &staged)?;
        if bundled {
            crate::backup_bundle::verify_database_copy(point, &staged)?;
            if allow_picture_gaps {
                picture_gaps = crate::backup_bundle::copy_assets_with_gaps(point, &path)?;
            } else {
                crate::backup_bundle::copy_assets(point, &path)?;
            }
            crate::backup_bundle::clear_marker(&staged)?;
        }
        // Read-write, on OUR OWN COPY. A point written by an older build
        // migrates forward here, which is correct: the migration lands on the
        // copy and never on the point.
        let store = Store::open(&staged).map_err(|e| format!("{}: {e}", path.display()))?;
        let copied_id = store
            .book_id()
            .map_err(|e| {
                format!(
                    "{}: cannot read the copied book identity: {e}",
                    path.display()
                )
            })?
            .ok_or_else(|| format!("{}: the copied book identity is missing", path.display()))?;
        store
            .fork_recovered_book_identity(&copied_id)
            .map_err(|e| {
                format!(
                    "{}: cannot create a new restored identity: {e}",
                    path.display()
                )
            })?;
        // Read out of the COPY, which is the manuscript being restored. The
        // manifest also carries a name, and it is a describing file that can
        // disagree with what it describes; `describe_dir` settled the same
        // argument one level up. Absent, the fallback is the stem, which is
        // what `summarize` would have shown anyway.
        let original = store
            .get_meta(NAME_KEY)
            .map_err(|e| format!("{}: cannot read the project name: {e}", path.display()))?
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| stem.to_string());
        store
            .set_meta(NAME_KEY, &restored_name(&original, ordinal))
            .map_err(|e| format!("{}: cannot record the project name: {e}", path.display()))?;
        store
            .set_meta(RECOVERED_FROM_KEY, &without_directory(point))
            .map_err(|e| format!("{}: cannot record the recovery source: {e}", path.display()))?;
        store
            .set_meta(RECOVERED_AT_KEY, &now_ms.to_string())
            .map_err(|e| format!("{}: cannot record the recovery time: {e}", path.display()))?;
        store
            .checkpoint()
            .map_err(|e| format!("cannot finish the restored database: {e}"))?;
        drop(store);
        match fs::metadata(staged.with_extension("db-wal")) {
            Ok(metadata) if metadata.len() > 0 => {
                return Err("the restored database still has an uncheckpointed log".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot check the restored database log: {error}")),
        }
        let mut summary = summarize(&staged);
        refuse_destination_logs(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut completed =
            fs::File::open(&staged).map_err(|e| format!("{}: {e}", staged.display()))?;
        std::io::copy(&mut completed, &mut claim)
            .and_then(|_| claim.sync_all())
            .map_err(|e| {
                format!(
                    "{}: cannot publish the restored database: {e}",
                    path.display()
                )
            })?;
        summary.path = path.to_string_lossy().into_owned();
        summary.modified_at = modified_at(&path);
        Ok(summary)
    })();

    drop(claim);
    let stage_cleanup = stage
        .map(|stage| {
            let retained = stage.path().to_path_buf();
            stage.close().map_err(|error| {
                format!(
                    "temporary restore files remain at {}: {error}",
                    retained.display()
                )
            })
        })
        .transpose();
    let summary = match filled {
        Ok(summary) => summary,
        Err(mut e) => {
            // Only the claimed database and exclusively created asset folders are
            // ours. Destination WAL/SHM files never belong to this restore.
            for owned in [
                Some(path.clone()),
                bundled.then(|| crate::pictures::dir_for(&path)),
                research_bundle.then(|| crate::research::dir_for(&path)),
            ]
            .into_iter()
            .flatten()
            {
                let cleanup = if owned == path {
                    fs::remove_file(&owned)
                } else {
                    fs::remove_dir_all(&owned)
                };
                if let Err(error) = cleanup {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        e.push_str(&format!(
                            ". Cannot clean restored files at {}: {error}",
                            owned.display()
                        ));
                    }
                }
            }
            if let Err(cleanup) = stage_cleanup {
                e.push_str(&format!(". {cleanup}"));
            }
            return Err(e);
        }
    };
    if let Err(cleanup) = stage_cleanup {
        // The saved book still needs to reach registration after publication.
        eprintln!("the restored book is at {}: {cleanup}", path.display());
    }
    Ok((summary, picture_gaps))
}

/// True when `path` is a direct child of `library` and ends in `.db`. Used to
/// refuse a page-supplied path pointing anywhere else.
pub fn in_library(library: &Path, path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("db") {
        return false;
    }
    let parent = match path.parent() {
        Some(p) => p,
        None => return false,
    };
    // A `..` anywhere makes the lexical parent a lie: `<library>/../escape.db`
    // has `<library>/..` for a parent, which is spelled like a child of the
    // library and resolves outside it. Refused outright rather than normalized,
    // because a file that does not exist yet cannot be canonicalized and
    // string-prefix normalization is exactly the check that keeps getting
    // bypassed.
    if path.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    match (fs::canonicalize(parent), fs::canonicalize(library)) {
        // The parent directory must exist for the file to be openable at all,
        // so this is the live path even when `path` itself is not there yet.
        // Canonicalizing both sides is what makes a symlinked library, a
        // doubled slash or a `.` component compare correctly.
        (Ok(a), Ok(b)) => a == b,
        // Nothing on disk to resolve against. With `..` already refused, the
        // remaining spellings differ only in `.` and separators, which
        // Path equality already handles component-wise.
        _ => parent == library,
    }
}

/// How many words a day the writer is aiming for. A property of the writer's
/// practice rather than of a manuscript, which is why it lives in this file and
/// not in the project's own `meta` table beside the day's baseline: "I write 500
/// words a day" survives starting a new book.
///
/// Stored as `off` or a canonical decimal string from 1 through 1,000,000.
/// The existing presets retain their variants and wire spellings.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DailyTarget {
    #[default]
    Off,
    W250,
    W500,
    W1000,
    W2000,
    Custom(u32),
}

impl DailyTarget {
    /// The spelling the settings file and the page both use.
    pub fn as_str(self) -> std::borrow::Cow<'static, str> {
        use std::borrow::Cow::{Borrowed, Owned};
        match self {
            DailyTarget::Off => Borrowed("off"),
            DailyTarget::W250 => Borrowed("250"),
            DailyTarget::W500 => Borrowed("500"),
            DailyTarget::W1000 => Borrowed("1000"),
            DailyTarget::W2000 => Borrowed("2000"),
            DailyTarget::Custom(words) => Owned(words.to_string()),
        }
    }

    /// Refuse noncanonical spellings so one preference has one encoding.
    pub fn parse(s: &str) -> Option<DailyTarget> {
        match s {
            "off" => Some(DailyTarget::Off),
            "250" => Some(DailyTarget::W250),
            "500" => Some(DailyTarget::W500),
            "1000" => Some(DailyTarget::W1000),
            "2000" => Some(DailyTarget::W2000),
            _ => {
                if s.starts_with('0') || !s.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                let words = s.parse::<u32>().ok()?;
                (1..=1_000_000)
                    .contains(&words)
                    .then_some(DailyTarget::Custom(words))
            }
        }
    }
}

impl Serialize for DailyTarget {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str().as_ref())
    }
}

impl<'de> Deserialize<'de> for DailyTarget {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| serde::de::Error::custom("invalid daily target"))
    }
}

/// Which palette the application uses, as an APP preference distinct from the
/// desktop's. `System` follows `prefers-color-scheme` and is what every build
/// before this slice did unconditionally.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    /// The spelling the settings file and the page both use.
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    /// None for anything else. The command boundary turns that into an error
    /// rather than a default, so the page cannot put a value in the preferences
    /// file that the next launch will not understand.
    pub fn parse(s: &str) -> Option<Theme> {
        match s {
            "system" => Some(Theme::System),
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }
}

// How the manuscript is set: which of three stacks, at which of four sizes,
// over which of three measures.
//
// Each axis is a CLOSED SET, and the design rests on that. The page never
// receives a font stack or a pixel figure from this file - it receives one of
// ten known words, and `style.css` maps each word to the actual typography. A
// free numeric size or an arbitrary family name would put a *value* in a
// preferences file where a *name* belongs, and would mean a string out of JSON
// reaching a CSS property.
//
// Three near-identical enums, written out rather than generated from a macro.
// They are three rules that happen to have the same shape today, not one rule
// used three times: a macro would make a single mutation kill all three at once
// and hide which of them a test actually covers.

/// Which of the three stacks `style.css` defines the prose is set in.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProseFamily {
    /// What every build before this slice used unconditionally.
    #[default]
    Serif,
    Sans,
    Mono,
}

impl ProseFamily {
    /// The spelling the settings file, the command boundary and the page's
    /// `data-prose-family` attribute all use. One word, three places.
    pub fn as_str(self) -> &'static str {
        match self {
            ProseFamily::Serif => "serif",
            ProseFamily::Sans => "sans",
            ProseFamily::Mono => "mono",
        }
    }

    /// None for anything else. The command boundary turns that into an error
    /// rather than a default, so the page cannot write a value into the
    /// preferences file that the next launch will not understand.
    pub fn parse(s: &str) -> Option<ProseFamily> {
        match s {
            "serif" => Some(ProseFamily::Serif),
            "sans" => Some(ProseFamily::Sans),
            "mono" => Some(ProseFamily::Mono),
            _ => None,
        }
    }
}

/// How large the prose is set. Four steps spanning 15px to 23px, which is the
/// whole range a person reads continuous prose at.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProseSize {
    /// 17px, what every build before this slice used unconditionally.
    #[default]
    Medium,
    Small,
    Large,
    Larger,
}

impl ProseSize {
    pub fn as_str(self) -> &'static str {
        match self {
            ProseSize::Medium => "medium",
            ProseSize::Small => "small",
            ProseSize::Large => "large",
            ProseSize::Larger => "larger",
        }
    }

    pub fn parse(s: &str) -> Option<ProseSize> {
        match s {
            "medium" => Some(ProseSize::Medium),
            "small" => Some(ProseSize::Small),
            "large" => Some(ProseSize::Large),
            "larger" => Some(ProseSize::Larger),
            _ => None,
        }
    }
}

/// How wide the text column runs. Named rather than numbered because the
/// stylesheet states it in `em`, so the pixel width follows the size above.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProseMeasure {
    /// 39em, what every build before this slice used unconditionally.
    #[default]
    Medium,
    Narrow,
    Wide,
}

impl ProseMeasure {
    pub fn as_str(self) -> &'static str {
        match self {
            ProseMeasure::Medium => "medium",
            ProseMeasure::Narrow => "narrow",
            ProseMeasure::Wide => "wide",
        }
    }

    pub fn parse(s: &str) -> Option<ProseMeasure> {
        match s {
            "medium" => Some(ProseMeasure::Medium),
            "narrow" => Some(ProseMeasure::Narrow),
            "wide" => Some(ProseMeasure::Wide),
            _ => None,
        }
    }
}

/// LENIENT AT BOTH LEVELS, and that is the whole subtlety of this type.
///
/// `read_settings` maps a failed parse of the FILE to the default, so a strict
/// field anywhere in it costs `last_project` and sends the next launch to a
/// different manuscript. The nested object makes that rule apply twice:
/// `typography: 7` must cost the typography and nothing else, and
/// `typography: {"size": 7}` must cost the size and nothing else - not the
/// family sitting beside it in the same object.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Typography {
    #[serde(default, deserialize_with = "lenient_family")]
    pub family: ProseFamily,
    #[serde(default, deserialize_with = "lenient_size")]
    pub size: ProseSize,
    #[serde(default, deserialize_with = "lenient_measure")]
    pub measure: ProseMeasure,
}

/// The window's size in LOGICAL pixels, as the writer last left it.
///
/// Size and not position. On Wayland a client cannot set its own position at
/// all - the compositor owns placement - so a stored position would work on X11
/// and silently do nothing on the display server this machine runs. A
/// preference that lies about itself half the time is worse than none, and the
/// compositor restores position better anyway, because it knows about the other
/// windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

/// Wide enough that the three measures still render as three, which is
/// arithmetic rather than taste: the editor pane is `width - 320 (navigator) -
/// 48 (padding)` = 832px at this default, and the medium size is
/// 19px, so the widest column (48em x 19px = 912px) no longer fits and caps --
/// but it still caps WIDER than medium (39em x 19px = 741px), so the three
/// stay distinct. A writer who wants the widest measure at its full size, or
/// simply wants more of everything, reaches for interface zoom instead.
///
/// At the old 900x900 the pane was 532px and the NARROWEST measure already
/// capped against it, so all three rendered identically and a shipped
/// preference nobody could see.
impl Default for WindowSize {
    fn default() -> Self {
        WindowSize {
            width: 1200,
            height: 800,
        }
    }
}

/// Below this the window has no application in it. `{"width": 1}` parses
/// perfectly well and produces a dot.
pub const MIN_WINDOW: WindowSize = WindowSize {
    width: 640,
    height: 480,
};

impl WindowSize {
    /// The recorded size, made usable: never smaller than `MIN_WINDOW`, never
    /// larger than what the screen can show.
    ///
    /// A pure function over both bounds so both are testable. `available` is the
    /// monitor's work area, and `None` means it could not be determined - in
    /// which case the recorded size is used as-is rather than guessed at.
    pub fn fit(self, available: Option<WindowSize>) -> WindowSize {
        let mut out = WindowSize {
            width: self.width.max(MIN_WINDOW.width),
            height: self.height.max(MIN_WINDOW.height),
        };
        if let Some(screen) = available {
            // The floor wins over the ceiling: a work area smaller than
            // MIN_WINDOW is a screen this application cannot fit on either way,
            // and shrinking to it would produce the unusable window the floor
            // exists to prevent while looking deliberate.
            out.width = out.width.min(screen.width).max(MIN_WINDOW.width);
            out.height = out.height.min(screen.height).max(MIN_WINDOW.height);
        }
        out
    }
}

/// A language tag in `settings.json`.
///
/// A NEWTYPE RATHER THAN A `String`, so that DEFAULT is English rather than the
/// empty string. `Settings` derives `Default` and eleven fields rely on it;
/// `#[serde(default = "...")]` covers the ABSENT key and not the derived value,
/// and a `Settings::default()` carrying `locale: ""` would have rendered
/// `⟦book.contents⟧` into every export the moment a caller used one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LocaleTag(String);

impl Default for LocaleTag {
    fn default() -> Self {
        Self(crate::strings::EN.tag().to_string())
    }
}

impl LocaleTag {
    /// The tag of a catalog this build ships, or English.
    pub fn of(tag: &str) -> Self {
        Self(crate::strings::locale_for(tag).tag().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The catalog this tag names.
    pub fn strings(&self) -> crate::strings::Strings {
        crate::strings::Strings::new(crate::strings::locale_for(&self.0))
    }
}

/// `mark_cast_names`'s absent-key default. A named function rather than a
/// literal in `#[serde(default = ...)]`, which the attribute requires, and
/// `true` rather than `bool::default()` because a writer who has never opened
/// Preferences should see the feature on -- the reason `Settings` no longer
/// derives `Default` (see the manual `impl` below): a struct-level derive
/// would give this field `false`, disagreeing with every settings.json that
/// simply lacks the key.
fn default_mark_cast_names() -> bool {
    true
}

/// A usable `HOME`, or nothing to contract or expand against: absolute,
/// UTF-8, and not root. ROOT IS REFUSED because under it every absolute path
/// contracts, and `books[]` -- the only record of where a manuscript was --
/// would then resolve against whatever home read the file next. A non-UTF-8
/// home would name no file once through `to_string_lossy`.
///
/// Read here and in nothing else: `contract_home` and `expand_home` take the
/// home as a parameter, so they test without touching the environment.
pub(crate) fn home_dir() -> Option<PathBuf> {
    let raw = std::env::var_os("HOME")?;
    let path = PathBuf::from(raw);
    let text = path.to_str()?;
    if !path.is_absolute() || trimmed_home(&path) == "/" || text.is_empty() {
        return None;
    }
    Some(path)
}

/// The home directory as a bare string with any trailing slashes trimmed off,
/// except that root itself stays `/` rather than becoming empty.
fn trimmed_home(home: &Path) -> String {
    let raw = home.to_string_lossy();
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn contract_against(path: &str, home: &Path) -> Option<String> {
    let trimmed = trimmed_home(home);
    if path == trimmed {
        return Some("~".to_string());
    }
    let prefix = if trimmed == "/" {
        "/".to_string()
    } else {
        format!("{trimmed}/")
    };
    path.strip_prefix(&prefix).map(|rest| format!("~/{rest}"))
}

/// `106` (which named this its residual): `settings.json`'s four path fields
/// (`last_project`, `books[]`, `new_book_dir`, `recent[].path`) are kept
/// absolute in memory but written `~`-relative, for the same reason
/// `without_directory` exists -- this file goes wherever a writer sends a
/// config or a diagnostic, and every absolute path on it begins with the
/// operating-system user's name.
///
/// A value equal to `home` becomes `~`; a value starting with `home` plus a
/// separator becomes `~/<rest>`; anything else -- outside `home`, or merely
/// sharing its prefix (`/home/writer2/x.db` under `/home/writer`) -- is
/// returned unchanged.
///
/// TEXTUAL on `/`, `without_directory`'s reason: Linux-only is the scope
/// decision that makes one separator enough, and a component-wise
/// `Path::starts_with` is not what this file holds on disk -- a `.`
/// component leaked once already through exactly that shortcut.
///
/// AGAINST `home` AS SPELLED AND NOTHING ELSE. A retry against the canonical
/// home (a symlinked `/home/writer` -> `/data/writer`) was reviewed out: it
/// has no inverse on read, so `/data/writer/x.db` came back as
/// `/home/writer/x.db`, and `record_recent`'s string dedup grew a second
/// entry per launch. A book recorded under the canonical spelling of a
/// symlinked home stays absolute; the record says so.
pub fn contract_home(path: &str, home: &Path) -> String {
    contract_against(path, home).unwrap_or_else(|| path.to_string())
}

/// The inverse of `contract_home`, run on read: exactly `~` becomes `home`; a
/// `~/` prefix becomes `home` plus the rest; anything else -- an absolute
/// path, a bare `~x`, an empty string -- is returned unchanged.
pub fn expand_home(value: &str, home: &Path) -> String {
    let trimmed = trimmed_home(home);
    if value == "~" {
        return trimmed;
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return if trimmed == "/" {
            format!("/{rest}")
        } else {
            format!("{trimmed}/{rest}")
        };
    }
    value.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookLocation {
    pub book_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtectionClaim {
    pub book_id: String,
    #[serde(default)]
    pub recovery_key: Option<String>,
    #[serde(default)]
    pub mirror_key: Option<String>,
}

/// The canonical path currently recorded for `book_id`, if this host has seen
/// the book's identity. The registry is separate from `books`, which remains
/// the page's path allowlist until opening is wired to identities.
pub fn canonical_book_path<'a>(settings: &'a Settings, book_id: &str) -> Option<&'a Path> {
    settings
        .book_locations
        .iter()
        .find(|location| location.book_id == book_id)
        .map(|location| Path::new(&location.path))
}

/// Record the canonical path supplied by the caller for one book identity.
/// This is pure registry maintenance: it neither opens a path nor changes the
/// separate `books` allowlist.
pub fn record_book_location(settings: &mut Settings, book_id: &str, path: &Path) {
    settings.book_locations.retain(|location| location.book_id != book_id);
    settings.book_locations.push(BookLocation {
        book_id: book_id.to_string(),
        path: path.to_string_lossy().into_owned(),
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarWordCounts {
    #[serde(default = "default_sidebar_scene", deserialize_with = "lenient_sidebar_scene")]
    pub scene: bool,
    #[serde(default, deserialize_with = "lenient_sidebar_container")]
    pub chapter: bool,
    #[serde(default, deserialize_with = "lenient_sidebar_container")]
    pub part: bool,
}

impl Default for SidebarWordCounts {
    fn default() -> Self {
        Self { scene: true, chapter: false, part: false }
    }
}

fn default_sidebar_scene() -> bool { true }

fn lenient_sidebar_scene<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(serde_json::Value::deserialize(d)?.as_bool().unwrap_or(true))
}

fn lenient_sidebar_container<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(serde_json::Value::deserialize(d)?.as_bool().unwrap_or(false))
}

fn lenient_sidebar_word_counts<'de, D: serde::Deserializer<'de>>(d: D) -> Result<SidebarWordCounts, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub last_project: Option<String>,
    /// LENIENT on purpose - see `lenient_theme`.
    #[serde(default, deserialize_with = "lenient_theme")]
    pub theme: Theme,
    /// LENIENT on purpose, at two levels - see `Typography`.
    #[serde(default, deserialize_with = "lenient_typography")]
    pub typography: Typography,
    /// LENIENT on purpose, at two levels, for the same reason again.
    #[serde(default, deserialize_with = "lenient_window")]
    pub window: WindowSize,
    /// How large the whole interface is drawn, as WebKit page zoom. A fact
    /// about the machine, beside `window` for the same reason. LENIENT.
    #[serde(default, deserialize_with = "crate::zoom::lenient_zoom")]
    pub zoom: crate::zoom::Zoom,
    #[serde(default, deserialize_with = "lenient_sidebar_word_counts")]
    pub sidebar_word_counts: SidebarWordCounts,
    /// LENIENT on purpose - see `lenient_daily_target`.
    #[serde(default, deserialize_with = "lenient_daily_target")]
    pub daily_target: DailyTarget,
    #[serde(default = "default_bible_rows", deserialize_with = "lenient_bible_rows")]
    pub bible_rows: u8,
    /// LENIENT on purpose, once per axis - see `WritingModes`.
    #[serde(default, deserialize_with = "lenient_writing_modes")]
    pub writing_modes: WritingModes,
    /// LENIENT on purpose - see `lenient_spelling`.
    #[serde(default, deserialize_with = "lenient_spelling")]
    pub spelling: Spelling,
    /// Whether minutes with an edit are counted at all. The off switch the
    /// product's own argument requires of any measurement of the writer; it
    /// lives beside the figure in the statistics panel. LENIENT on purpose.
    #[serde(default, deserialize_with = "lenient_time_tracking")]
    pub time_tracking: TimeTracking,
    /// LENIENT on purpose - see `lenient_theme_family`.
    #[serde(default, deserialize_with = "lenient_theme_family")]
    pub theme_family: ThemeFamily,
    /// The language the HOST writes in: its own messages, and the words it puts
    /// into a writer's file -- the generated contents heading and the language
    /// attribute of every exported book.
    ///
    /// A BCP-47 TAG AND NOT AN ENUM, because `strings::CATALOGS` is already the
    /// enumeration of the languages this build has, and a second list would be
    /// a second answer to which those are.
    ///
    /// LENIENT on purpose - see `lenient_locale`.
    #[serde(default, deserialize_with = "lenient_locale")]
    pub locale: LocaleTag,
    /// The project slugs the writer turned the readable mirror ON for.
    ///
    /// A LIST OF THE ENABLED, not a flag per project, because "never asked" and
    /// "asked and declined" must not be the same state as "on". Absent is
    /// empty, which is every writer who has not enabled it -- the mirror is a
    /// deliberate act and off is the only honest default for a feature that
    /// writes the whole manuscript somewhere new.
    #[serde(default)]
    pub mirrored: Vec<String>,
    /// The book identities whose readable mirror is enabled. This registry
    /// coexists with legacy slug entries until mirror lookup is migrated.
    #[serde(default)]
    pub mirrored_book_ids: Vec<String>,
    /// Legacy protection directories adopted by a single proven book identity.
    #[serde(default)]
    pub protection_claims: Vec<ProtectionClaim>,
    /// Paths of books that do NOT live in the default library: absolute in
    /// memory, `~/`-relative on disk under the home directory.
    ///
    /// THIS IS THE OPENABILITY GATE, not a convenience index. `may_open` used
    /// to ask "is this file directly inside the library directory", which was
    /// what stopped the page naming an arbitrary path to open. Once a book can
    /// live anywhere that question stops being answerable from the path alone,
    /// and this list is what replaces it: a project is a file the HOST knows
    /// about. Written by the host when it creates a book somewhere else, never
    /// by the page, so the page still cannot name a path the host has not
    /// already accepted.
    ///
    /// A path here whose file has moved or gone is KEPT and listed as missing,
    /// on `list`'s own rule: a manuscript that has become unreadable must be
    /// visible, not silently absent. The WRITER can remove such an entry
    /// (`forget_book`); the host never does it for them, because
    /// this list is the only record of where a manuscript was.
    #[serde(default)]
    pub books: Vec<String>,
    /// Canonical paths keyed by a store-owned book identity. This records
    /// identity without widening `books`, the current openability allowlist.
    #[serde(default)]
    pub book_locations: Vec<BookLocation>,
    /// The folder the last new book was put in, and the default the folder
    /// dialog opens at for the next one.
    ///
    /// A WRITER WHO KEEPS THEIR BOOKS SOMEWHERE CHOOSES ONCE. It is a default
    /// and never a destination: the resolved folder is shown before the writer
    /// commits, which is a deliberate enable act, and for its reason -- the destination
    /// is the thing being consented to.
    #[serde(default)]
    pub new_book_dir: Option<String>,
    /// Native-picker preference for encrypted archives only.
    #[serde(default, deserialize_with = "lenient_encrypted_backup_dir")]
    pub encrypted_backup_dir: Option<String>,
    /// Whether a cast member's name is marked, quietly, where it appears in the
    /// open scene's prose (the world design's W5). DEFAULT ON: the sample
    /// project ships with it visible, and a writer who has never touched
    /// Preferences should see the feature the design describes rather than a
    /// silent absence they have to discover a toggle to fix.
    #[serde(default = "default_mark_cast_names")]
    pub mark_cast_names: bool,
    /// What the window opens onto with no `APP_PROJECT`. LENIENT
    /// on purpose - see `lenient_start`. DEFAULTS TO `Last`.
    #[serde(default, deserialize_with = "lenient_start")]
    pub start: Start,
    /// Most-recently-opened books, most recent first, capped and deduplicated
    /// by `record_recent`. LENIENT PER ELEMENT - see `lenient_recent`.
    #[serde(default, deserialize_with = "lenient_recent")]
    pub recent: Vec<RecentBook>,
    /// Which pen name the library screen is filtered to. An id the
    /// vault no longer holds reads as All -- `commands::library` is what
    /// applies that filter, not this file, so a renamed or removed identity
    /// costs the writer one click rather than a dangling reference anywhere
    /// here. `new_book_dir`'s own shape: absent is None, and a value of the
    /// wrong JSON type costs this field alone under `read_settings`'s
    /// whole-file fallback, same as every other bare `Option<String>` here.
    #[serde(default)]
    pub home_identity: Option<String>,
}

fn lenient_encrypted_backup_dir<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(value.as_str().filter(|value| !value.trim().is_empty()).map(str::to_owned))
}

impl Default for Settings {
    /// WRITTEN BY HAND rather than derived, the one field it exists for:
    /// `mark_cast_names` must default to `true`, and `#[derive(Default)]` can
    /// only give a `bool` field `false`. Every other field is the type's own
    /// `Default`, unchanged from what the derive produced.
    fn default() -> Self {
        Self {
            last_project: None,
            theme: Theme::default(),
            typography: Typography::default(),
            window: WindowSize::default(),
            zoom: crate::zoom::Zoom::default(),
            sidebar_word_counts: SidebarWordCounts::default(),
            daily_target: DailyTarget::default(),
            bible_rows: default_bible_rows(),
            writing_modes: WritingModes::default(),
            spelling: Spelling::default(),
            time_tracking: TimeTracking::default(),
            theme_family: ThemeFamily::default(),
            locale: LocaleTag::default(),
            mirrored: Vec::new(),
            mirrored_book_ids: Vec::new(),
            protection_claims: Vec::new(),
            books: Vec::new(),
            book_locations: Vec::new(),
            new_book_dir: None,
            encrypted_backup_dir: None,
            mark_cast_names: default_mark_cast_names(),
            start: Start::default(),
            recent: Vec::new(),
            home_identity: None,
        }
    }
}

impl Settings {
    /// Expand the six path fields against `home`, in place. `read_settings`'s
    /// one caller, right after parse -- every other function in this file
    /// keeps working on absolute in-memory paths, unchanged.
    fn expand_paths(&mut self, home: &Path) {
        if let Some(p) = &mut self.last_project {
            *p = expand_home(p, home);
        }
        for b in &mut self.books {
            *b = expand_home(b, home);
        }
        for location in &mut self.book_locations {
            location.path = expand_home(&location.path, home);
        }
        if let Some(p) = &mut self.new_book_dir {
            *p = expand_home(p, home);
        }
        if let Some(p) = &mut self.encrypted_backup_dir {
            *p = expand_home(p, home);
        }
        for r in &mut self.recent {
            r.path = expand_home(&r.path, home);
        }
    }

    /// A clone with the six path fields contracted against `home`, for
    /// `write_settings` to serialise. `self` is untouched.
    fn contracted(&self, home: &Path) -> Settings {
        let mut copy = self.clone();
        if let Some(p) = &mut copy.last_project {
            *p = contract_home(p, home);
        }
        for b in &mut copy.books {
            *b = contract_home(b, home);
        }
        for location in &mut copy.book_locations {
            location.path = contract_home(&location.path, home);
        }
        if let Some(p) = &mut copy.new_book_dir {
            *p = contract_home(p, home);
        }
        if let Some(p) = &mut copy.encrypted_backup_dir {
            *p = contract_home(p, home);
        }
        for r in &mut copy.recent {
            r.path = contract_home(&r.path, home);
        }
        copy
    }
}

/// Which of the three curated palettes the theme is drawn from. Spec section 17
/// names them: Editorial (Linen and Ink), the default; Neutral (Paper and
/// Graphite); Atmospheric (Sage and Midnight).
///
/// ORTHOGONAL TO `Theme`, not a longer list of themes. Each family has a light
/// half and a dark half, so a writer chooses a palette AND whether to follow the
/// desktop - six combinations from two controls of three rather than one control
/// of six.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeFamily {
    #[default]
    Editorial,
    Neutral,
    Atmospheric,
}

impl ThemeFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            ThemeFamily::Editorial => "editorial",
            ThemeFamily::Neutral => "neutral",
            ThemeFamily::Atmospheric => "atmospheric",
        }
    }
    pub fn parse(s: &str) -> Option<ThemeFamily> {
        match s {
            "editorial" => Some(ThemeFamily::Editorial),
            "neutral" => Some(ThemeFamily::Neutral),
            "atmospheric" => Some(ThemeFamily::Atmospheric),
            _ => None,
        }
    }
}

/// What the window opens onto with no `APP_PROJECT`: `home` (nothing mounted,
/// the library screen up), `last` (today's behaviour, unchanged), `blank`
/// (nothing mounted, no library screen, the empty workspace).
///
/// DEFAULTS TO `Home`. An earlier version shipped this defaulting to
/// `Last` so a writer saw nothing different until there was a library screen
/// worth defaulting to; the design's own argument is that a FIRST launch
/// is what the default has to answer for, and a first launch with no screen
/// drops a writer into an unnamed book with no sign the application holds a
/// library at all. `APP_PROJECT` ignores this exactly as it ignores
/// `last_project` - see `main()`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Start {
    #[default]
    Home,
    Last,
    Blank,
}

impl Start {
    pub fn as_str(self) -> &'static str {
        match self {
            Start::Home => "home",
            Start::Last => "last",
            Start::Blank => "blank",
        }
    }
    pub fn parse(s: &str) -> Option<Start> {
        match s {
            "home" => Some(Start::Home),
            "last" => Some(Start::Last),
            "blank" => Some(Start::Blank),
            _ => None,
        }
    }
}

/// One book in `Settings.recent`, most-recent-first. `opened_at` is unix
/// milliseconds, the same clock `store::now_ms` reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentBook {
    pub path: String,
    pub opened_at: u64,
}

/// Longest the recent list is kept. 20 is a library a writer can still recall
/// by name; a longer list is the switcher's `list`, not this one.
const RECENT_CAP: usize = 20;

/// Record a book as just-opened: moved to the front, deduplicated by path,
/// truncated to `RECENT_CAP`. Called by `project_open` and by the startup open
/// - never under `APP_PROJECT`, which writes no settings at all.
pub fn record_recent(settings: &mut Settings, path: &Path, now_ms: u64) {
    let key = path.to_string_lossy().into_owned();
    settings.recent.retain(|r| r.path != key);
    settings.recent.insert(
        0,
        RecentBook {
            path: key,
            opened_at: now_ms,
        },
    );
    settings.recent.truncate(RECENT_CAP);
}

/// Remember what the HUMAN opened: `last_project` and the front of `recent`,
/// read-modify-written from the file rather than from a copy read earlier, so
/// a preference changed between the two reads is not clobbered.
///
/// UNDER `APP_PROJECT` THIS WRITES NOTHING, and that is the whole reason it is
/// one function with a flag rather than two `if` blocks at its two call sites
/// (`project_open` and the startup open): a measurement run must not change
/// what the human's next launch opens, and inline the rule survived a
/// mutation that dropped it, because nothing but a running host could see it.
///
/// A failed write is reported on stderr and not returned: the project is
/// already open, so the cost is one click next launch, and calling that a
/// failed open would be a lie.
pub fn remember_open(data_home: &Path, explicit: bool, path: &Path, now_ms: u64) {
    if explicit {
        return;
    }
    if let Err(e) = update_settings(data_home, |settings| {
        settings.last_project = Some(path.to_string_lossy().into_owned());
        record_recent(settings, path, now_ms);
    }) {
        eprintln!("cannot record the last project: {e}");
    }
}

/// Whether the web engine underlines misspellings.
///
/// ON BY DEFAULT, and the off switch is not a nicety. WebKitGTK draws the
/// underlines and offers suggestions, but its "Learn Spelling" and "Ignore
/// Spelling" menu items are INSENSITIVE here - measured, not assumed. So a
/// novelist's invented character names and places are underlined permanently
/// with no way to teach the dictionary about them, and for the writer who uses
/// the most invented words that is the worst case. Being able to turn the whole
/// thing off is what makes shipping it honest.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Spelling {
    #[default]
    On,
    Off,
}

impl Spelling {
    pub fn as_str(self) -> &'static str {
        match self {
            Spelling::On => "on",
            Spelling::Off => "off",
        }
    }
    pub fn parse(s: &str) -> Option<Spelling> {
        match s {
            "on" => Some(Spelling::On),
            "off" => Some(Spelling::Off),
            _ => None,
        }
    }
    pub fn enabled(self) -> bool {
        matches!(self, Spelling::On)
    }
}

/// How the writer wants to SIT with the manuscript. Two independent axes: focus
/// dims everything but the paragraph the caret is in, typewriter holds the
/// caret's line at a fixed height in the pane.
///
/// Independent because they are usually wanted at different times: a writer who
/// wants a quiet page does not necessarily want the scroll behaviour, and the
/// two are discovered separately.
///
/// A CLOSED SET per axis, so they parse exactly like the theme and the
/// typography and the panel stays one control type.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FocusMode {
    #[default]
    Off,
    Paragraph,
}

impl FocusMode {
    pub fn as_str(self) -> &'static str {
        match self {
            FocusMode::Off => "off",
            FocusMode::Paragraph => "paragraph",
        }
    }
    pub fn parse(s: &str) -> Option<FocusMode> {
        match s {
            "off" => Some(FocusMode::Off),
            "paragraph" => Some(FocusMode::Paragraph),
            _ => None,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TypewriterMode {
    #[default]
    Off,
    On,
}

impl TypewriterMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TypewriterMode::Off => "off",
            TypewriterMode::On => "on",
        }
    }
    pub fn parse(s: &str) -> Option<TypewriterMode> {
        match s {
            "off" => Some(TypewriterMode::Off),
            "on" => Some(TypewriterMode::On),
            _ => None,
        }
    }
}

/// Both axes, each lenient in its own right. `writing_modes: 7` costs the modes
/// and nothing else in the file; `writing_modes: {"focus": 7}` costs the focus
/// axis and not the typewriter one beside it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingModes {
    #[serde(default, deserialize_with = "lenient_focus")]
    pub focus: FocusMode,
    #[serde(default, deserialize_with = "lenient_typewriter")]
    pub typewriter: TypewriterMode,
}

/// Any JSON value that is not one of the three known strings reads as `system`,
/// and never fails the parse.
///
/// This file holds `last_project` too, and `read_settings` maps a failed parse
/// to the default. A strictly-deserialized `theme` would therefore make
/// `{"theme": 7}` silently discard the recorded project as well, and the next
/// launch would open a different manuscript. One unreadable preference must cost
/// exactly itself.
fn lenient_theme<'de, D>(d: D) -> std::result::Result<Theme, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Value accepts any JSON, so this cannot be the thing that fails.
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw.as_str().and_then(Theme::parse).unwrap_or_default())
}

/// A malformed target costs only this preference, never `last_project`.
/// JSON numbers remain invalid: the settings wire format is always a string.
fn lenient_daily_target<'de, D>(d: D) -> std::result::Result<DailyTarget, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_str()
        .and_then(DailyTarget::parse)
        .unwrap_or_default())
}

fn default_bible_rows() -> u8 {
    5
}

fn lenient_bible_rows<'de, D>(d: D) -> std::result::Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_u64()
        .and_then(|rows| u8::try_from(rows).ok())
        .filter(|rows| (1..=20).contains(rows))
        .unwrap_or_else(default_bible_rows))
}

/// The tag of a catalog this build actually ships, or English.
///
/// NORMALIZED ON READ rather than kept verbatim, which is every other axis of
/// this file's rule: a value no build here can honour is a preference that
/// LOOKS set and is not, and the writer would go on seeing English with `fr`
/// in the file saying otherwise. The cost is that a tag survives only while a
/// catalog for it does; the day a second language ships, that language's own
/// tag round-trips.
fn lenient_locale<'de, D>(d: D) -> std::result::Result<LocaleTag, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(LocaleTag::of(raw.as_str().unwrap_or_default()))
}

fn lenient_theme_family<'de, D>(d: D) -> std::result::Result<ThemeFamily, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_str()
        .and_then(ThemeFamily::parse)
        .unwrap_or_default())
}

fn lenient_start<'de, D>(d: D) -> std::result::Result<Start, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw.as_str().and_then(Start::parse).unwrap_or_default())
}

/// Each element of `recent` is parsed on its own so one malformed entry costs
/// itself and not the rest of the list - the per-element half of the same rule
/// `lenient_typography` states per-axis.
fn lenient_recent<'de, D>(d: D) -> std::result::Result<Vec<RecentBook>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    let items = match raw.as_array() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };
    Ok(items
        .iter()
        .filter_map(|v| serde_json::from_value::<RecentBook>(v.clone()).ok())
        .collect())
}

fn lenient_spelling<'de, D>(d: D) -> std::result::Result<Spelling, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw.as_str().and_then(Spelling::parse).unwrap_or_default())
}

fn lenient_time_tracking<'de, D>(d: D) -> std::result::Result<TimeTracking, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_str()
        .and_then(TimeTracking::parse)
        .unwrap_or_default())
}

/// Whether the application counts the minutes a writer edits in. `Spelling`'s
/// shape; on by default like the daily figure beside it, and the switch is in
/// the panel where the figure is read.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeTracking {
    #[default]
    On,
    Off,
}

impl TimeTracking {
    pub fn as_str(self) -> &'static str {
        match self {
            TimeTracking::On => "on",
            TimeTracking::Off => "off",
        }
    }
    pub fn parse(s: &str) -> Option<TimeTracking> {
        match s {
            "on" => Some(TimeTracking::On),
            "off" => Some(TimeTracking::Off),
            _ => None,
        }
    }
}

fn lenient_focus<'de, D>(d: D) -> std::result::Result<FocusMode, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw.as_str().and_then(FocusMode::parse).unwrap_or_default())
}

fn lenient_typewriter<'de, D>(d: D) -> std::result::Result<TypewriterMode, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_str()
        .and_then(TypewriterMode::parse)
        .unwrap_or_default())
}

/// The OUTER half of the nested leniency for the modes, matching the
/// typography's: a whole-object value that is not an object costs the modes and
/// nothing else.
fn lenient_writing_modes<'de, D>(d: D) -> std::result::Result<WritingModes, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

/// The OUTER half of the nested leniency: `typography: 7`, `typography: null`
/// and `typography: "large"` all read as the defaults and cost nothing else in
/// the file.
fn lenient_typography<'de, D>(d: D) -> std::result::Result<Typography, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    // from_value on an object still runs the three inner deserializers below, so
    // a good family survives a bad size. It can only fail for a non-object,
    // which is the case this unwrap_or_default is for.
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

// The INNER half, one per axis. Written out for the same reason the three enums
// are: a shared generic helper would make one mutation kill all three.

fn lenient_family<'de, D>(d: D) -> std::result::Result<ProseFamily, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_str()
        .and_then(ProseFamily::parse)
        .unwrap_or_default())
}

fn lenient_size<'de, D>(d: D) -> std::result::Result<ProseSize, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw.as_str().and_then(ProseSize::parse).unwrap_or_default())
}

/// Both levels again, and the inner one matters here as much as it does for the
/// typography: `{"width": 1400}` with no height must keep the recorded width and
/// take the default height, not discard both.
fn lenient_window<'de, D>(d: D) -> std::result::Result<WindowSize, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    let held = match raw.as_object() {
        Some(map) => map,
        None => return Ok(WindowSize::default()),
    };
    let axis = |key: &str, fallback: u32| -> u32 {
        held.get(key)
            .and_then(serde_json::Value::as_u64)
            // A width that does not fit a u32 is not a width. Saturating rather
            // than defaulting keeps the answer monotonic, and `fit` clamps it to
            // the screen a moment later anyway.
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
            .unwrap_or(fallback)
    };
    let fallback = WindowSize::default();
    Ok(WindowSize {
        width: axis("width", fallback.width),
        height: axis("height", fallback.height),
    })
}

fn lenient_measure<'de, D>(d: D) -> std::result::Result<ProseMeasure, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw
        .as_str()
        .and_then(ProseMeasure::parse)
        .unwrap_or_default())
}

/// `<data_home>/garret/settings.json`. A missing or unparseable file reads
/// as default: this is a preferences file, losing it costs the user one click,
/// and refusing to launch over it would be worse.
///
/// The six path fields are expanded against the real `HOME`; with none
/// usable a `~` value reads back literally, which lists as a missing book
/// rather than a deleted one.
pub fn read_settings(data_home: &Path) -> Settings {
    read_settings_with(data_home, home_dir().as_deref())
}

/// Read settings for a state-changing operation. A missing file is a fresh
/// profile; a damaged existing file is refused so an update cannot replace
/// canonical book or protection ownership with defaults.
pub fn read_settings_checked(data_home: &Path) -> Result<Settings, String> {
    read_settings_checked_with(data_home, home_dir().as_deref())
}

/// `read_settings`'s body, with the home directory taken as a parameter
/// rather than read from the environment -- the seam tests use, so no test
/// sets `HOME`.
fn read_settings_with(data_home: &Path, home: Option<&Path>) -> Settings {
    read_settings_checked_with(data_home, home).unwrap_or_default()
}

fn read_settings_checked_with(data_home: &Path, home: Option<&Path>) -> Result<Settings, String> {
    let path = settings_path(data_home);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut settings: Settings = serde_json::from_str(&text)
        .map_err(|error| format!("cannot parse {}: {error}", path.display()))?;
    if let Some(home) = home {
        settings.expand_paths(home);
    }
    Ok(settings)
}

/// Read, change, write — with every other writer of this file locked out for the
/// duration.
///
/// There are three writers now (the theme, the typography, and the window
/// recording its own size) and all three are read-modify-write of the WHOLE
/// file, because it holds `last_project` too. Without this, a resize settling at
/// the same instant as a theme click reads the file before the click landed and
/// writes it back after, silently undoing a preference the writer just set.
///
/// A process-wide lock rather than a file lock: this application is the only
/// writer of its own data directory, and two copies running against one home is
/// not a case anything else here supports either.
pub fn update_settings(data_home: &Path, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    update_settings_checked(data_home, |settings| {
        change(settings);
        Ok(())
    })
}

/// Read, validate, and write settings under the same lock as ordinary updates.
/// A refusal runs before `write_settings`, so the existing settings bytes stay
/// untouched when a caller's preflight cannot prove its registry change safe.
pub fn update_settings_checked(
    data_home: &Path,
    change: impl FnOnce(&mut Settings) -> Result<(), String>,
) -> Result<(), String> {
    // A poisoned lock means another writer panicked mid-update. The settings
    // file is written atomically, so what is on disk is still whole, and
    // refusing every later preference change over it would be worse.
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = read_settings_checked(data_home)?;
    change(&mut settings)?;
    write_settings(data_home, &settings)
}

/// write-temp + fsync + rename, the same discipline the store uses. A
/// half-written settings file that failed to parse on every launch would be
/// worse than none.
///
/// The six path fields are contracted against the real `HOME` before the
/// bytes are written; with none usable the file is written absolute, as
/// it always was.
pub fn write_settings(data_home: &Path, s: &Settings) -> Result<(), String> {
    write_settings_with(data_home, s, home_dir().as_deref())
}

/// `write_settings`'s body, with the home directory taken as a parameter --
/// `read_settings_with`'s reason.
fn write_settings_with(data_home: &Path, s: &Settings, home: Option<&Path>) -> Result<(), String> {
    let path = settings_path(data_home);
    let dir = path
        .parent()
        .ok_or_else(|| format!("{}: no parent directory", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let contracted;
    let to_write: &Settings = match home {
        Some(home) => {
            contracted = s.contracted(home);
            &contracted
        }
        None => s,
    };
    let body = serde_json::to_vec(to_write).map_err(|e| format!("cannot serialize settings: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.write_all(&body)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        // Before the rename, or the rename can land while the bytes have not.
        f.sync_all()
            .map_err(|e| format!("cannot sync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("cannot replace {}: {e}", path.display()))?;
    // The rename itself is a directory change, and it is what makes the new
    // file reachable. Best effort: the write is already durable, and a
    // filesystem that refuses a directory fsync must not fail the save.
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn english() -> crate::strings::Strings {
        crate::strings::Strings::english()
    }

    fn create_imported(
        library: &Path,
        name: &str,
        rows: &[crate::store::ImportRow<'_>],
    ) -> Result<ProjectSummary, String> {
        super::create_imported(library, name, rows, &english())
    }

    fn restore_point_into(
        point: &Path,
        library: &Path,
        stem: &str,
        now_ms: i64,
    ) -> Result<ProjectSummary, String> {
        super::restore_point_into(point, library, stem, now_ms)
    }

    fn create_in(dir: &Path, name: &str) -> Result<ProjectSummary, String> {
        super::create_in(dir, name, &english())
    }

    fn competing_creation_book(path: &Path) -> (Store, Vec<(PathBuf, Vec<u8>)>) {
        let other = Store::open(path).unwrap();
        other.set_meta(NAME_KEY, "Competing manuscript").unwrap();
        other.ensure_starter_structure(&english()).unwrap();
        other.checkpoint().unwrap();
        other
            .set_meta(
                "competition_marker",
                "Distinct uncheckpointed manuscript state",
            )
            .unwrap();
        let files = [
            path.to_path_buf(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ]
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
        (other, files)
    }

    #[test]
    fn exclusive_creation_preserves_a_book_arriving_after_preflight() {
        for (imported, with_sidecars) in
            [(false, true), (true, true), (false, false), (true, false)]
        {
            let dir = tempdir().unwrap();
            let mut competing = None;
            let mut before = Vec::new();
            let arrive = |path: &Path| {
                let (store, files) = competing_creation_book(path);
                if with_sidecars {
                    competing = Some(store);
                    before = files;
                } else {
                    store.checkpoint().unwrap();
                    drop(store);
                    before = vec![(path.to_path_buf(), fs::read(path).unwrap())];
                }
            };
            let result = if imported {
                super::create_imported_with(
                    dir.path(),
                    "Book",
                    &[(None, "scene", "Imported scene", Some("Imported prose"))],
                    &english(),
                    arrive,
                )
            } else {
                super::create_in_with(dir.path(), "Book", &english(), arrive)
            };
            assert!(
                result.is_err(),
                "a competing valid book must refuse creation instead of being adopted"
            );
            for (path, bytes) in before {
                assert_eq!(
                    fs::read(path).unwrap(),
                    bytes,
                    "creation touched a competing database or sidecar"
                );
            }
            let competing = competing
                .unwrap_or_else(|| Store::open_readonly(&dir.path().join("book.db")).unwrap());
            assert_eq!(
                competing.get_meta(NAME_KEY).unwrap().as_deref(),
                Some("Competing manuscript")
            );
        }
    }

    #[test]
    fn exclusive_creation_failed_import_never_cleans_a_competing_book() {
        let dir = tempdir().unwrap();
        let mut competing = None;
        let mut before = Vec::new();
        let rows = [
            (None, "chapter", "First", None),
            (Some(1usize), "scene", "Invalid parent", None),
        ];
        let result = super::create_imported_with(dir.path(), "Book", &rows, &english(), |path| {
            let (store, files) = competing_creation_book(path);
            competing = Some(store);
            before = files;
        });
        assert!(result.is_err());
        for (path, bytes) in before {
            assert_eq!(
                fs::read(&path).unwrap(),
                bytes,
                "failed import removed or changed the competing book at {}",
                path.display()
            );
        }
        assert_eq!(
            competing.unwrap().get_meta(NAME_KEY).unwrap().as_deref(),
            Some("Competing manuscript")
        );
    }

    #[test]
    fn exclusive_creation_cleans_only_owned_staging_after_fill_failure() {
        let dir = tempdir().unwrap();
        let result = super::create_book_with(
            dir.path(),
            "Book",
            |_| {},
            |store, path| {
                assert!(!path.exists(), "the incomplete book must not be published");
                let stage = fs::read_dir(dir.path())
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                assert!(stage
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".garret-create-"));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::metadata(&stage).unwrap().permissions().mode() & 0o777,
                        0o700
                    );
                }
                assert!(stage.join("project.db").is_file());
                store
                    .set_meta("partial_import", "owned temporary data")
                    .unwrap();
                Err("injected filling failure".into())
            },
        );
        assert!(result.unwrap_err().contains("injected filling failure"));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn exclusive_creation_cleanup_failure_does_not_hide_a_published_book() {
        let dir = tempdir().unwrap();
        let mut retained = None;
        let made = super::create_book_with_cleanup(
            dir.path(),
            "Book",
            |_| {},
            |store, _| {
                store
                    .ensure_starter_structure(&english())
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
            |stage| {
                retained = Some(stage.keep());
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected staging cleanup failure",
                ))
            },
        )
        .expect("a cleanup failure must not hide a saved book from registration");
        assert_eq!(Path::new(&made.path), dir.path().join("book.db"));
        let store = Store::open_readonly(Path::new(&made.path)).unwrap();
        assert_eq!(store.get_meta(NAME_KEY).unwrap().as_deref(), Some("Book"));
        assert_eq!(store.items().unwrap().len(), 2);
        let retained = retained.unwrap();
        assert!(retained.is_dir());
        assert!(!retained.join("project.db").exists());
    }

    #[test]
    fn exclusive_creation_preserves_orphan_destination_sidecars() {
        for extension in ["db-wal", "db-shm"] {
            for imported in [false, true] {
                let dir = tempdir().unwrap();
                let arrive = |path: &Path| {
                    fs::write(path.with_extension(extension), b"unrelated orphan").unwrap()
                };
                let result = if imported {
                    super::create_imported_with(
                        dir.path(),
                        "Book",
                        &[(None, "scene", "Imported", Some("Prose"))],
                        &english(),
                        arrive,
                    )
                } else {
                    super::create_in_with(dir.path(), "Book", &english(), arrive)
                };
                assert!(result.unwrap_err().contains("database sidecar"));
                assert!(!dir.path().join("book.db").exists());
                assert_eq!(
                    fs::read(dir.path().join(format!("book.{extension}"))).unwrap(),
                    b"unrelated orphan"
                );
                assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
            }
        }
    }

    #[test]
    fn a_failed_import_leaves_no_project_and_preserves_its_neighbor() {
        let dir = tempdir().unwrap();
        let prose = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Original prose."}]}]}"#;
        let neighbor = create_imported(
            dir.path(),
            "Existing manuscript",
            &[(None, "scene", "Keep this scene", Some(prose))],
        )
        .unwrap();
        let neighbor_path = Path::new(&neighbor.path);
        let before = fs::read(neighbor_path).unwrap();
        let rows = [
            (None, "chapter", "Already inserted", None),
            (Some(1usize), "scene", "Invalid self parent", None),
        ];

        let error = create_imported(dir.path(), "Failed import", &rows).unwrap_err();

        // This error follows Store::open and the project-name write, rather
        // than an early filename refusal that has no file to clean up.
        assert!(
            error.contains("cannot write the imported manuscript"),
            "{error}"
        );
        assert!(error.contains("row 1 names parent 1"), "{error}");
        for name in [
            "failed-import.db",
            "failed-import.db-wal",
            "failed-import.db-shm",
        ] {
            assert!(!dir.path().join(name).exists(), "failed import left {name}");
        }
        assert_eq!(fs::read(neighbor_path).unwrap(), before);
        assert!(
            fs::read_dir(dir.path()).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".garret-create-")),
            "failed import left its owned staging directory"
        );
        let store = Store::open_readonly(neighbor_path).unwrap();
        let scene = &store.items().unwrap()[0];
        assert_eq!(scene.title, "Keep this scene");
        assert_eq!(store.load_doc(&scene.id).unwrap().body, prose);
    }

    #[test]
    fn an_import_that_brought_no_scene_is_still_openable() {
        // A Markdown manuscript whose headings are all `#` and `##` - an outline
        // before any prose - produces parts and chapters and nothing that
        // carries a document. Such a project used to import without error and
        // then throw on mount, which before the page had a startup-failure
        // surface meant a blank window that said nothing.
        let dir = tempdir().expect("a temp dir");
        let rows = vec![
            (None, "part", "Part One", None),
            (Some(0usize), "chapter", "Chapter One", None),
            (Some(0usize), "chapter", "Chapter Two", None),
        ];
        let summary = create_imported(dir.path(), "Outline Only", &rows).expect("the import");

        let store = Store::open_readonly(Path::new(&summary.path)).expect("the imported store");
        let items = store.items().expect("the walk");
        let scenes: Vec<_> = items.iter().filter(|i| i.item_type == "scene").collect();
        assert_eq!(
            scenes.len(),
            1,
            "exactly one scene, so the project can be mounted"
        );
        // The manuscript keeps its own three items and its own order.
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].title, "Part One");
    }

    #[test]
    fn an_import_that_brought_its_own_scenes_gains_none() {
        // The failing direction, and the rule that keeps `create_imported` from
        // becoming "create plus a fill": a manuscript that arrived with its own
        // scenes must not carry an empty one nobody wrote.
        let dir = tempdir().expect("a temp dir");
        let rows = vec![
            (None, "part", "Part One", None),
            (Some(0usize), "chapter", "Chapter One", None),
            (
                Some(1usize),
                "scene",
                "A scene the writer wrote",
                Some("Prose."),
            ),
        ];
        let summary = create_imported(dir.path(), "Real Manuscript", &rows).expect("the import");

        let store = Store::open_readonly(Path::new(&summary.path)).expect("the imported store");
        let items = store.items().expect("the walk");
        assert_eq!(items.len(), 3, "no extra scene was added");
        let scenes: Vec<_> = items.iter().filter(|i| i.item_type == "scene").collect();
        assert_eq!(scenes.len(), 1);
        assert_eq!(scenes[0].title, "A scene the writer wrote");
    }

    #[test]
    fn an_importable_name_is_a_bare_markdown_or_docx_filename() {
        for ok in [
            "book.md",
            "Book.MD",
            "part 2.md",
            "a.b.md",
            "-.md",
            "book.docx",
            "Book.DOCX",
            "a.b.docx",
        ] {
            assert!(import_name_ok(ok), "{ok:?} should be importable");
        }
        for bad in [
            "",
            ".hidden.md",
            "../book.md",
            "sub/book.md",
            "sub\\book.md",
            "/abs.md",
            "book.txt",
            "book",
            "book.md\0x",
            "book.docx\0x",
            ".hidden.docx",
        ] {
            assert!(!import_name_ok(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn listing_imports_skips_what_is_not_importable_and_sorts() {
        let dir = tempdir().expect("a temp dir");
        for name in ["b.md", "a.md", "notes.txt", ".hidden.md"] {
            fs::write(dir.path().join(name), "x").expect("a file");
        }
        fs::create_dir(dir.path().join("sub.md")).expect("a directory named like a file");
        assert_eq!(list_imports(dir.path()), vec!["a.md", "b.md"]);
    }

    #[test]
    fn listing_a_drop_directory_that_does_not_exist_is_empty_not_an_error() {
        // Not having dropped a file in yet is the ordinary state.
        let dir = tempdir().expect("a temp dir");
        assert!(list_imports(&dir.path().join("absent")).is_empty());
    }

    #[test]
    fn slugify_lowercases_and_hyphenates_words() {
        assert_eq!(
            slugify("The Winter Harbour").as_deref(),
            Some("the-winter-harbour")
        );
    }

    #[test]
    fn a_run_of_separators_collapses_to_one_hyphen() {
        // Two spaces are one gap between words, not two.
        assert_eq!(slugify("a  b").as_deref(), Some("a-b"));
    }

    #[test]
    fn a_name_with_nothing_sluggable_is_none() {
        // "" is not a name, and a project the writer cannot find by the name
        // they typed is worse than a refused create.
        assert_eq!(slugify("!!!"), None);
    }

    #[test]
    fn unicode_only_titles_have_stable_distinct_safe_basenames() {
        for (title, expected) in [
            ("שלום", "book-b7ac0398ef74193ab738b21df0912329"),
            ("العربية", "book-d274159863057eb5c633116c3b54e4f8"),
            ("中文", "book-72726d8818f693066ceb69afa364218b"),
        ] {
            assert_eq!(slugify(title).as_deref(), Some(expected));
            assert_eq!(slugify(&format!("  {title}  ")).as_deref(), Some(expected));
        }
        for title in ["", "   ", "!!!", "。？！", "—"] {
            assert_eq!(slugify(title), None, "{title:?}");
        }
        for (title, expected) in [
            ("  The Winter Harbour!  ", "the-winter-harbour"),
            ("a - b", "a-b"),
            ("Straße", "stra-e"),
            ("中文 A", "a"),
        ] {
            assert_eq!(slugify(title).as_deref(), Some(expected));
        }
    }

    #[test]
    fn unicode_titles_create_and_import_without_replacing_existing_books() {
        let created_dir = tempdir().unwrap();
        let imported_dir = tempdir().unwrap();
        let prose = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Imported prose."}]}]}"#;
        let rows = [(None, "scene", "Imported scene", Some(prose))];
        for title in ["שלום", "العربية", "中文"] {
            let created = create_in(created_dir.path(), title).unwrap();
            let imported = create_imported(imported_dir.path(), title, &rows).unwrap();
            for summary in [&created, &imported] {
                assert_eq!(summary.name, title);
                let store = Store::open_readonly(Path::new(&summary.path)).unwrap();
                assert_eq!(store.get_meta(NAME_KEY).unwrap().as_deref(), Some(title));
            }
            let store = Store::open_readonly(Path::new(&imported.path)).unwrap();
            let scenes: Vec<_> = store
                .items()
                .unwrap()
                .into_iter()
                .filter(|item| item.item_type == "scene")
                .collect();
            assert_eq!(scenes.len(), 1);
            assert_eq!(scenes[0].title, "Imported scene");
            let created_before = fs::read(&created.path).unwrap();
            let imported_before = fs::read(&imported.path).unwrap();
            assert!(create_in(created_dir.path(), title)
                .unwrap_err()
                .contains("already exists"));
            assert!(create_imported(imported_dir.path(), title, &rows)
                .unwrap_err()
                .contains("already exists"));
            assert_eq!(fs::read(&created.path).unwrap(), created_before);
            assert_eq!(fs::read(&imported.path).unwrap(), imported_before);
        }
        for directory in [created_dir.path(), imported_dir.path()] {
            let books = fs::read_dir(directory)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "db"))
                .count();
            assert_eq!(books, 3);
        }
    }

    #[test]
    fn non_ascii_becomes_a_separator_without_leaving_edge_hyphens() {
        let slug = slugify("  Straße  ").expect("a name with letters must yield a slug");
        assert!(!slug.is_empty());
        assert!(!slug.starts_with('-'), "{slug}");
        assert!(!slug.ends_with('-'), "{slug}");
        assert!(
            slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "{slug}"
        );
    }

    #[test]
    fn a_long_name_is_capped_at_sixty_four_characters() {
        let slug = slugify(&"a".repeat(200)).unwrap();
        assert_eq!(slug.len(), 64);
    }

    /// A book somewhere that is not the library, with a name of its own.
    fn book_at(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let summary = create_in(dir, name).unwrap();
        PathBuf::from(summary.path)
    }

    #[test]
    fn known_unions_the_library_with_the_remembered_paths() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let lib = library_dir(home.path());
        create_in(&lib, "In The Library").unwrap();
        let outside = book_at(elsewhere.path(), "Somewhere Else");
        update_settings(home.path(), |s| {
            s.books.push(outside.to_string_lossy().into_owned())
        })
        .unwrap();

        let found = known(home.path());
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().any(|p| p.ends_with("in-the-library.db")));
        assert!(found.contains(&outside));
    }

    #[test]
    fn a_move_keeps_the_file_name_and_refuses_what_is_not_a_move() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        assert_eq!(
            move_target(&book, b.path()).unwrap(),
            b.path().join("harbour.db")
        );
        // The folder it is already in.
        assert!(move_target(&book, a.path())
            .unwrap_err()
            .contains("already in that folder"));
        // A folder that is not one.
        assert!(move_target(&book, &b.path().join("nowhere"))
            .unwrap_err()
            .contains("not a folder"));
        // A file of the same name already there.
        fs::write(b.path().join("harbour.db"), b"x").unwrap();
        assert!(move_target(&book, b.path())
            .unwrap_err()
            .contains("already a file"));
        fs::remove_file(b.path().join("harbour.db")).unwrap();
        // A pictures folder of the same name already there.
        fs::create_dir(b.path().join("harbour.pictures")).unwrap();
        assert!(move_target(&book, b.path())
            .unwrap_err()
            .contains("pictures folder"));
    }

    #[test]
    fn a_move_collision_after_preflight_preserves_both_books_and_sidecars() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        let before = fs::read(&book).unwrap();
        for dir in [
            crate::pictures::dir_for(&book),
            crate::research::dir_for(&book),
        ] {
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("original"), b"source original").unwrap();
        }
        let to = move_target(&book, b.path()).unwrap();
        let other = Store::open(&to).unwrap();
        other.set_meta(NAME_KEY, "Another manuscript").unwrap();
        other.checkpoint().unwrap();
        drop(other);
        let collision = fs::read(&to).unwrap();
        for extension in ["db-wal", "db-shm"] {
            fs::write(to.with_extension(extension), b"other book sidecar").unwrap();
        }
        let result = move_book_files(&book, &to);
        assert!(
            result.is_err(),
            "a destination created after preflight must refuse publication"
        );
        assert_eq!(fs::read(&book).unwrap(), before);
        assert_eq!(fs::read(&to).unwrap(), collision);
        for extension in ["db-wal", "db-shm"] {
            assert_eq!(
                fs::read(to.with_extension(extension)).unwrap(),
                b"other book sidecar"
            );
        }
        for dir in [
            crate::pictures::dir_for(&book),
            crate::research::dir_for(&book),
        ] {
            assert_eq!(fs::read(dir.join("original")).unwrap(), b"source original");
        }
    }

    #[test]
    fn move_collision_with_a_database_alone_refuses_the_exclusive_rename() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        let before = fs::read(&book).unwrap();
        let to = move_target(&book, b.path()).unwrap();
        let other = Store::open(&to).unwrap();
        other.set_meta(NAME_KEY, "Another manuscript").unwrap();
        other.checkpoint().unwrap();
        drop(other);
        let collision = fs::read(&to).unwrap();
        assert!(!to.with_extension("db-wal").exists());
        assert!(!to.with_extension("db-shm").exists());
        assert!(move_book_files(&book, &to).is_err());
        assert_eq!(fs::read(&book).unwrap(), before);
        assert_eq!(fs::read(&to).unwrap(), collision);
    }

    #[test]
    fn move_collision_with_orphan_destination_logs_preserves_the_orphans() {
        for extension in ["db-wal", "db-shm"] {
            let a = tempdir().unwrap();
            let b = tempdir().unwrap();
            let book = book_at(a.path(), "Harbour");
            let before = fs::read(&book).unwrap();
            let to = move_target(&book, b.path()).unwrap();
            let sidecar = to.with_extension(extension);
            fs::write(&sidecar, b"unrelated orphan").unwrap();
            assert!(move_target(&book, b.path()).is_err());
            let error = move_book_files(&book, &to).unwrap_err();
            assert!(error.to_string().contains("database sidecar"), "{error}");
            assert_eq!(fs::read(&book).unwrap(), before);
            assert!(!to.exists());
            assert_eq!(fs::read(&sidecar).unwrap(), b"unrelated orphan");
        }
    }

    #[test]
    fn move_collisions_with_empty_asset_directories_preserve_both_sides() {
        for collision_is_pictures in [true, false] {
            let a = tempdir().unwrap();
            let b = tempdir().unwrap();
            let book = book_at(a.path(), "Harbour");
            let before = fs::read(&book).unwrap();
            let pictures = crate::pictures::dir_for(&book);
            let research = crate::research::dir_for(&book);
            for dir in [&pictures, &research] {
                fs::create_dir(dir).unwrap();
                fs::write(dir.join("original"), b"retained original").unwrap();
            }
            let to = move_target(&book, b.path()).unwrap();
            let collision = if collision_is_pictures {
                crate::pictures::dir_for(&to)
            } else {
                crate::research::dir_for(&to)
            };
            fs::create_dir(&collision).unwrap();
            let result = move_book_files(&book, &to);
            assert!(
                result.is_err(),
                "even an empty destination directory must not be replaced"
            );
            assert_eq!(fs::read(&book).unwrap(), before);
            assert!(!to.exists());
            for dir in [&pictures, &research] {
                assert_eq!(
                    fs::read(dir.join("original")).unwrap(),
                    b"retained original"
                );
            }
            assert_eq!(fs::read_dir(&collision).unwrap().count(), 0);
        }
    }

    #[test]
    fn move_rollback_never_replaces_a_new_database_at_the_source() {
        for with_sidecars in [false, true] {
            let a = tempdir().unwrap();
            let b = tempdir().unwrap();
            let book = book_at(a.path(), "Harbour");
            let before = fs::read(&book).unwrap();
            let pictures = crate::pictures::dir_for(&book);
            let research = crate::research::dir_for(&book);
            for dir in [&pictures, &research] {
                fs::create_dir(dir).unwrap();
                fs::write(dir.join("original"), b"retained original").unwrap();
            }
            let to = move_target(&book, b.path()).unwrap();
            let pictures_to = crate::pictures::dir_for(&to);
            let mut collision_bytes = None;
            let error = move_book_files_with(&book, &to, |source, destination| {
                if source == pictures && destination == pictures_to {
                    let other = Store::open(&book).unwrap();
                    other.set_meta(NAME_KEY, "Another manuscript").unwrap();
                    other.checkpoint().unwrap();
                    drop(other);
                    collision_bytes = Some(fs::read(&book).unwrap());
                    fs::create_dir(&pictures_to).unwrap();
                    if with_sidecars {
                        fs::write(book.with_extension("db-wal"), b"other WAL").unwrap();
                        fs::write(book.with_extension("db-shm"), b"other SHM").unwrap();
                    }
                }
                rename_without_replace(source, destination)
            })
            .unwrap_err();
            assert!(
                error.reopen_at.is_none(),
                "a split book must not be reopened"
            );
            assert!(error.to_string().contains("Rollback failed"), "{error}");
            assert!(
                error
                    .to_string()
                    .contains(&format!("The database is at {}", to.display())),
                "{error}"
            );
            assert!(
                error
                    .to_string()
                    .contains(&format!("The pictures folder is at {}", pictures.display())),
                "{error}"
            );
            assert_eq!(fs::read(&to).unwrap(), before);
            assert_eq!(fs::read(&book).unwrap(), collision_bytes.unwrap());
            if with_sidecars {
                assert_eq!(
                    fs::read(book.with_extension("db-wal")).unwrap(),
                    b"other WAL"
                );
                assert_eq!(
                    fs::read(book.with_extension("db-shm")).unwrap(),
                    b"other SHM"
                );
            }
            for dir in [&pictures, &research] {
                assert_eq!(
                    fs::read(dir.join("original")).unwrap(),
                    b"retained original"
                );
            }
            assert_eq!(fs::read_dir(&pictures_to).unwrap().count(), 0);
        }
    }

    #[test]
    fn move_rollback_reports_pictures_retained_away_from_the_database() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        let before = fs::read(&book).unwrap();
        let pictures = crate::pictures::dir_for(&book);
        let research = crate::research::dir_for(&book);
        for dir in [&pictures, &research] {
            fs::create_dir(dir).unwrap();
            fs::write(dir.join("original"), b"retained original").unwrap();
        }
        let to = move_target(&book, b.path()).unwrap();
        let pictures_to = crate::pictures::dir_for(&to);
        let research_to = crate::research::dir_for(&to);
        let error = move_book_files_with(&book, &to, |source, destination| {
            if source == research && destination == research_to {
                fs::create_dir(&pictures).unwrap();
                fs::create_dir(&research_to).unwrap();
            }
            rename_without_replace(source, destination)
        })
        .unwrap_err();
        assert!(error.reopen_at.is_none());
        assert!(error.to_string().contains("Rollback failed"), "{error}");
        assert!(
            error
                .to_string()
                .contains(&format!("The database is at {}", book.display())),
            "{error}"
        );
        assert!(
            error.to_string().contains(&format!(
                "The pictures folder is at {}",
                pictures_to.display()
            )),
            "{error}"
        );
        assert_eq!(fs::read(&book).unwrap(), before);
        assert!(!to.exists());
        assert_eq!(
            fs::read(pictures_to.join("original")).unwrap(),
            b"retained original"
        );
        assert_eq!(
            fs::read(research.join("original")).unwrap(),
            b"retained original"
        );
        assert_eq!(fs::read_dir(&pictures).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&research_to).unwrap().count(), 0);
    }

    #[test]
    fn moving_carries_the_pictures_folder_and_leaves_nothing_behind() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        let pictures = crate::pictures::dir_for(&book);
        fs::create_dir(&pictures).unwrap();
        fs::write(pictures.join("face.jpg"), b"jpeg").unwrap();
        let research = crate::research::dir_for(&book);
        fs::create_dir(&research).unwrap();
        fs::write(research.join("source.pdf"), b"retained research").unwrap();
        let to = move_target(&book, b.path()).unwrap();

        move_book_files(&book, &to).unwrap();

        assert!(!book.exists());
        assert!(!pictures.exists());
        assert!(!research.exists());
        assert_eq!(
            fs::read(crate::research::dir_for(&to).join("source.pdf")).unwrap(),
            b"retained research"
        );
        assert!(to.is_file());
        assert_eq!(
            fs::read(crate::pictures::dir_for(&to).join("face.jpg")).unwrap(),
            b"jpeg"
        );
        // And the moved file is still a project.
        assert!(Store::open(&to).unwrap().items().unwrap().len() > 0);
    }
    #[test]
    fn a_move_without_pictures_moves_the_one_file() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        let to = move_target(&book, b.path()).unwrap();
        move_book_files(&book, &to).unwrap();
        assert!(!book.exists());
        assert!(to.is_file());
        assert!(!crate::pictures::dir_for(&to).exists());
    }

    #[test]
    fn a_log_with_content_left_behind_refuses_the_move() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        fs::write(book.with_extension("db-wal"), b"frames").unwrap();
        let to = move_target(&book, b.path()).unwrap();
        let err = move_book_files(&book, &to).unwrap_err();
        assert!(err.to_string().contains("still being written"), "{err}");
        assert!(book.exists());
        assert!(!to.exists());
    }

    #[test]
    fn a_failed_pictures_rename_puts_the_file_back() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let book = book_at(a.path(), "Harbour");
        let pictures = crate::pictures::dir_for(&book);
        fs::create_dir(&pictures).unwrap();
        let to = move_target(&book, b.path()).unwrap();
        // The pictures destination becomes a FILE between the check and the
        // rename, so the directory rename fails.
        fs::write(crate::pictures::dir_for(&to), b"in the way").unwrap();

        let err = move_book_files(&book, &to).unwrap_err();
        assert!(err.to_string().contains("pictures"), "{err}");
        assert!(book.is_file(), "the file must be back where it was");
        assert!(!to.exists());
        assert!(pictures.is_dir());
    }

    #[test]
    fn a_move_out_of_the_library_is_recorded_and_one_into_it_is_not() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let lib = library_dir(home.path());
        let in_lib = PathBuf::from(create_in(&lib, "Harbour").unwrap().path);
        let out = elsewhere.path().join("harbour.db");
        update_settings(home.path(), |s| {
            record_book_location(s, "book-1", &in_lib);
            record_book_location(s, "book-2", Path::new("/elsewhere/other.db"));
        })
        .unwrap();

        record_move(home.path(), &in_lib, &out, true);
        let s = read_settings(home.path());
        assert_eq!(s.books, vec![out.to_string_lossy().into_owned()]);
        assert_eq!(s.last_project.as_deref(), Some(out.to_str().unwrap()));
        assert_eq!(canonical_book_path(&s, "book-1"), Some(out.as_path()));
        assert_eq!(canonical_book_path(&s, "book-2"), Some(Path::new("/elsewhere/other.db")));

        // Back in: the record leaves, the scan will find it.
        record_move(home.path(), &out, &in_lib, false);
        let s = read_settings(home.path());
        assert!(s.books.is_empty(), "{:?}", s.books);
        assert_eq!(canonical_book_path(&s, "book-1"), Some(in_lib.as_path()));
        // last_project untouched when the launch was told what to open.
        assert_eq!(s.last_project.as_deref(), Some(out.to_str().unwrap()));
    }

    #[test]
    fn a_checked_move_refuses_to_replace_a_damaged_registry() {
        let home = tempdir().unwrap();
        let path = settings_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{").unwrap();
        let before = fs::read(&path).unwrap();

        let err = record_move_checked(
            home.path(),
            Path::new("/before.db"),
            Path::new("/after.db"),
            true,
        )
        .unwrap_err();

        assert!(err.contains("cannot parse"), "{err}");
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn old_settings_default_the_identity_registry_without_changing_legacy_fields() {
        let s: Settings = serde_json::from_str(r#"{"mirrored":["legacy"],"books":["/book.db"]}"#).unwrap();
        assert_eq!(s.mirrored, ["legacy"]);
        assert_eq!(s.books, ["/book.db"]);
        assert!(s.mirrored_book_ids.is_empty());
        assert!(s.protection_claims.is_empty());
        assert!(s.book_locations.is_empty());
    }

    #[test]
    fn recording_a_location_replaces_only_that_books_record() {
        let mut s = Settings::default();
        s.books = vec!["/allowed.db".into()];
        record_book_location(&mut s, "book-1", Path::new("/first.db"));
        record_book_location(&mut s, "book-2", Path::new("/other.db"));
        record_book_location(&mut s, "book-1", Path::new("/replacement.db"));

        assert_eq!(canonical_book_path(&s, "book-1"), Some(Path::new("/replacement.db")));
        assert_eq!(canonical_book_path(&s, "book-2"), Some(Path::new("/other.db")));
        assert_eq!(s.books, ["/allowed.db"]);
        assert_eq!(s.book_locations.len(), 2);
    }

    #[test]
    fn a_checked_settings_refusal_preserves_existing_bytes() {
        let dir = tempdir().unwrap();
        update_settings(dir.path(), |s| s.books.push("/allowed.db".into())).unwrap();
        let path = settings_path(dir.path());
        let before = fs::read(&path).unwrap();

        let err = update_settings_checked(dir.path(), |_| Err("cannot prove location".into()))
            .expect_err("a refused preflight wrote settings");

        assert_eq!(err, "cannot prove location");
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn a_damaged_settings_file_refuses_writes_without_running_the_callback() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{").unwrap();
        let before = fs::read(&path).unwrap();
        let called = std::cell::Cell::new(false);

        let error = update_settings_checked(dir.path(), |_| {
            called.set(true);
            Ok(())
        })
        .unwrap_err();

        assert!(error.contains("cannot parse"));
        assert!(!called.get());
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn checked_settings_accepts_missing_files_and_lenient_fields() {
        let missing = tempdir().unwrap();
        update_settings(missing.path(), |settings| settings.books.push("/book.db".into())).unwrap();
        assert_eq!(read_settings_checked(missing.path()).unwrap().books, ["/book.db"]);

        let lenient = tempdir().unwrap();
        let path = settings_path(lenient.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"theme":7,"last_project":"/book.db"}"#).unwrap();
        let settings = read_settings_checked(lenient.path()).unwrap();
        assert_eq!(settings.theme, Theme::default());
        assert_eq!(settings.last_project.as_deref(), Some("/book.db"));
    }

    #[test]
    fn physical_identity_accepts_hardlink_and_symlink_aliases_and_refuses_missing_paths() {
        let dir = tempdir().unwrap();
        let book = dir.path().join("book.db");
        let hardlink = dir.path().join("hardlink.db");
        fs::write(&book, b"book").unwrap();
        fs::hard_link(&book, &hardlink).unwrap();

        assert!(physical_same_file(&book, &hardlink).unwrap());
        #[cfg(unix)]
        {
            let symlink = dir.path().join("symlink.db");
            std::os::unix::fs::symlink(&book, &symlink).unwrap();
            assert!(physical_same_file(&book, &symlink).unwrap());
        }
        assert!(physical_same_file(&book, &dir.path().join("missing.db")).is_err());
    }

    #[test]
    fn a_book_that_is_BOTH_in_the_library_and_remembered_appears_once() {
        // The list is written by the host, and a host that recorded a library
        // book would otherwise make it appear twice in the writer's own
        // library panel.
        let home = tempdir().unwrap();
        let lib = library_dir(home.path());
        let made = create_in(&lib, "Only Once").unwrap();
        update_settings(home.path(), |s| s.books.push(made.path.clone())).unwrap();

        assert_eq!(known(home.path()).len(), 1);
    }

    #[test]
    fn a_remembered_book_whose_file_is_GONE_is_still_known() {
        // `list`'s own rule: a manuscript that has become unreadable must be
        // visible, not silently absent. A book the writer moved in their file
        // manager is that case, and dropping it here would delete the only
        // record of where it was.
        let home = tempdir().unwrap();
        let ghost = home.path().join("moved-away").join("gone.db");
        update_settings(home.path(), |s| {
            s.books.push(ghost.to_string_lossy().into_owned())
        })
        .unwrap();

        assert_eq!(known(home.path()), vec![ghost]);
    }

    #[test]
    fn a_missing_book_says_so_and_a_present_one_does_not() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let present = book_at(elsewhere.path(), "Here");
        let ghost = home.path().join("moved-away").join("gone.db");
        update_settings(home.path(), |s| {
            s.books.push(present.to_string_lossy().into_owned());
            s.books.push(ghost.to_string_lossy().into_owned());
        })
        .unwrap();

        let listed = list_known(home.path());
        let by_name = |n: &str| listed.iter().find(|p| p.name == n).unwrap();
        assert!(!by_name("Here").missing);
        assert!(by_name("gone").missing);
        assert!(by_name("gone").error.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_book_behind_a_permission_error_is_retained_in_both_library_views() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let present = book_at(elsewhere.path(), "Still Here");
        let key = present.to_string_lossy().into_owned();
        update_settings(home.path(), |settings| settings.books.push(key.clone())).unwrap();
        let settings_before = fs::read(settings_path(home.path())).unwrap();
        let book_before = fs::read(&present).unwrap();
        let permissions = fs::metadata(elsewhere.path()).unwrap().permissions();
        fs::set_permissions(elsewhere.path(), fs::Permissions::from_mode(0)).unwrap();
        let lookup = fs::metadata(&present);
        let listed = list_known(home.path());
        let shelf = crate::commands::library::overview(home.path());
        let forgotten = forget_book(home.path(), &key);
        fs::set_permissions(elsewhere.path(), permissions).unwrap();

        assert_eq!(lookup.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].missing, "lookup failure is not confirmed absence");
        assert!(listed[0].error.is_some());
        assert_eq!(shelf.books.len(), 1);
        assert!(!shelf.books[0].missing, "the shelf must preserve the same boundary");
        assert!(shelf.books[0].error.is_some());
        assert!(forgotten.is_err(), "an unknown file state must refuse Forget");
        assert_eq!(fs::read(settings_path(home.path())).unwrap(), settings_before);
        assert_eq!(fs::read(&present).unwrap(), book_before);
        assert_eq!(read_settings(home.path()).books, [key]);
    }

    #[cfg(unix)]
    #[test]
    fn a_book_behind_an_invalid_parent_is_retained_after_lookup_failure() {
        let home = tempdir().unwrap();
        let parent = home.path().join("former-folder");
        fs::write(&parent, "folder replaced by a file").unwrap();
        let path = parent.join("remembered.db");
        let key = path.to_string_lossy().into_owned();
        update_settings(home.path(), |settings| settings.books.push(key.clone())).unwrap();
        let before = fs::read(settings_path(home.path())).unwrap();
        assert_ne!(fs::metadata(&path).unwrap_err().kind(), std::io::ErrorKind::NotFound);

        assert!(!summarize(&path).missing);
        let shelf = crate::commands::library::overview(home.path());
        assert_eq!(shelf.books.len(), 1);
        assert!(!shelf.books[0].missing);
        assert!(forget_book(home.path(), &key).is_err());
        assert_eq!(fs::read(settings_path(home.path())).unwrap(), before);
        assert_eq!(read_settings(home.path()).books, [key]);
    }

    #[test]
    fn forgetting_a_missing_book_removes_only_its_line() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let present = book_at(elsewhere.path(), "Here");
        let ghost = home.path().join("moved-away").join("gone.db");
        let ghost_s = ghost.to_string_lossy().into_owned();
        update_settings(home.path(), |s| {
            s.books.push(present.to_string_lossy().into_owned());
            s.books.push(ghost_s.clone());
        })
        .unwrap();

        forget_book(home.path(), &ghost_s).unwrap();
        let books = read_settings(home.path()).books;
        assert_eq!(books, vec![present.to_string_lossy().into_owned()]);
        assert_eq!(known(home.path()), vec![present.clone()]);
        assert!(present.exists(), "forgetting touches no file");
    }

    #[test]
    fn a_book_that_is_still_there_cannot_be_forgotten() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let present = book_at(elsewhere.path(), "Here");
        let present_s = present.to_string_lossy().into_owned();
        update_settings(home.path(), |s| s.books.push(present_s.clone())).unwrap();

        let err = forget_book(home.path(), &present_s).unwrap_err();
        assert!(err.contains("still there"), "{err}");
        assert_eq!(read_settings(home.path()).books, vec![present_s]);
    }

    #[test]
    fn a_path_the_host_never_recorded_is_refused_and_the_file_is_left_alone() {
        // A library book is found by the scan and is not in the list; a path
        // the page made up is not in it either. Both are "not remembered".
        let home = tempdir().unwrap();
        let err = forget_book(home.path(), "/nowhere/made-up.db").unwrap_err();
        assert!(err.contains("not a remembered book"), "{err}");
    }

    #[test]
    fn a_book_outside_the_library_lists_under_its_OWN_name() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let outside = book_at(elsewhere.path(), "The Harbour");
        update_settings(home.path(), |s| {
            s.books.push(outside.to_string_lossy().into_owned())
        })
        .unwrap();

        let listed = list_known(home.path());
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].name, "The Harbour");
        assert_eq!(listed[0].path, outside.to_string_lossy());
        assert!(listed[0].error.is_none(), "{:?}", listed[0].error);
    }

    #[test]
    fn a_book_created_elsewhere_lands_THERE_and_not_in_the_library() {
        let home = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        let made = create_in(elsewhere.path(), "Somewhere Else").unwrap();

        assert!(
            PathBuf::from(&made.path).starts_with(elsewhere.path()),
            "{} is not under the chosen folder",
            made.path
        );
        assert!(list(&library_dir(home.path())).is_empty());
    }

    #[test]
    fn same_named_books_in_separate_folders_keep_the_first_manuscript_and_get_distinct_ids() {
        let one = tempdir().unwrap();
        let two = tempdir().unwrap();
        let first = book_at(one.path(), "Draft");
        let first_before = fs::read(&first).unwrap();
        let first_id = Store::open_readonly(&first).unwrap().book_id().unwrap().unwrap();

        let second = create_in(two.path(), "Draft").expect("a same-named book in another folder");
        let second_path = PathBuf::from(second.path);
        let second_id = Store::open_readonly(&second_path).unwrap().book_id().unwrap().unwrap();

        assert_eq!(fs::read(&first).unwrap(), first_before);
        assert_ne!(first_id, second_id);
        assert_eq!(second_path, two.path().join("draft.db"));
    }

    #[test]
    fn imported_same_named_book_keeps_the_first_manuscript_and_gets_a_distinct_id() {
        let library_parent = tempdir().unwrap();
        let library = library_parent.path().join("projects");
        let elsewhere = tempdir().unwrap();
        let remembered = book_at(elsewhere.path(), "Draft");
        let remembered_before = fs::read(&remembered).unwrap();
        let remembered_id = Store::open_readonly(&remembered).unwrap().book_id().unwrap().unwrap();
        let rows = [(None, "scene", "One", None)];

        let imported = create_imported(&library, "Draft", &rows).expect("a same-named import");
        let imported_id = Store::open_readonly(Path::new(&imported.path)).unwrap().book_id().unwrap().unwrap();

        assert_eq!(fs::read(&remembered).unwrap(), remembered_before);
        assert_ne!(remembered_id, imported_id);
        assert_eq!(PathBuf::from(imported.path), library.join("draft.db"));
    }

    #[test]
    fn creating_the_same_name_twice_is_refused() {
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        create(&lib, "The Winter Harbour").unwrap();

        let second = create(&lib, "The Winter Harbour");

        assert!(
            second.is_err(),
            "the second create must not overwrite the first"
        );
        assert_eq!(list(&lib).len(), 1);
    }

    #[test]
    fn a_created_project_lists_under_its_typed_name_and_holds_a_chapter_and_a_scene() {
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        let made = create(&lib, "The Winter Harbour").unwrap();
        assert!(
            made.path.ends_with("the-winter-harbour.db"),
            "{}",
            made.path
        );

        let listed = list(&lib);

        assert_eq!(listed.len(), 1);
        // The slug is a file name; the writer's name is the project's own.
        assert_eq!(listed[0].name, "The Winter Harbour");
        assert!(listed[0].error.is_none(), "{:?}", listed[0].error);

        let store = crate::store::Store::open(Path::new(&listed[0].path)).unwrap();
        let items = store.items().unwrap();
        // A CHAPTER AND A SCENE INSIDE IT. A chapter is not optional
        // in this product, and a book that opened as one bare scene is what
        // left the writer's first press with nowhere to indent to.
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_type, "chapter");
        assert_eq!(items[1].item_type, "scene");
        assert_eq!(items[1].parent_id.as_deref(), Some(items[0].id.as_str()));
    }

    #[test]
    fn an_unreadable_project_is_listed_carrying_its_error_not_hidden() {
        // A manuscript that has become unreadable must be visible. Silently
        // omitting it reads to the writer as "my book is gone".
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("broken.db"), b"not a database").unwrap();

        let listed = list(&lib);

        assert_eq!(listed.len(), 1);
        assert!(listed[0].error.is_some(), "{listed:?}");
        // No meta table to read a name from, so the file stem is all there is.
        assert_eq!(listed[0].name, "broken");
    }

    #[test]
    fn listing_a_library_does_not_write_to_it() {
        // Store::open creates schema v1 on a blank file, so summarizing with it
        // would adopt every empty .db in the library and drop -wal/-shm beside
        // each one. A listing must not modify what it lists, and an empty file
        // is not a project: it is listed carrying an error.
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        fs::create_dir_all(&lib).unwrap();
        let blank = lib.join("blank.db");
        fs::write(&blank, b"").unwrap();

        let listed = list(&lib);

        assert_eq!(listed.len(), 1);
        assert!(listed[0].error.is_some(), "{listed:?}");
        assert_eq!(
            fs::metadata(&blank).unwrap().len(),
            0,
            "the listing wrote to the file"
        );
        assert!(
            !lib.join("blank.db-wal").exists(),
            "the listing left a write-ahead log"
        );
        assert!(
            !lib.join("blank.db-shm").exists(),
            "the listing left shared memory"
        );
    }

    #[test]
    fn list_ignores_non_db_files_and_subdirectories() {
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        create(&lib, "Real").unwrap();
        fs::write(lib.join("notes.txt"), b"hello").unwrap();
        fs::create_dir_all(lib.join("nested.db")).unwrap();

        let listed = list(&lib);

        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].name, "Real");
    }

    #[test]
    fn in_library_accepts_a_direct_db_child() {
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        fs::create_dir_all(&lib).unwrap();
        assert!(in_library(&lib, &lib.join("a.db")));
    }

    #[test]
    fn in_library_refuses_a_parent_directory_escape() {
        // The case that matters: a page-supplied path naming a file outside the
        // directory the application owns.
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        fs::create_dir_all(&lib).unwrap();
        let escape = lib.join("..").join("escape.db");
        assert!(!in_library(&lib, &escape), "{}", escape.display());

        // Also refused when the target exists, so the answer cannot depend on
        // whether the file happens to be there yet.
        fs::write(dir.path().join("garret").join("escape.db"), b"x").unwrap();
        assert!(!in_library(&lib, &escape), "{}", escape.display());
    }

    #[test]
    fn in_library_refuses_a_parent_directory_escape_that_no_comparison_can_see() {
        // The case the ParentDir guard actually carries alone. Where both sides
        // canonicalize, `<library>/../escape.db` has `<library>/..` for a parent
        // and resolves elsewhere, so the parent comparison already refuses it.
        // Here nothing exists to canonicalize AND the library is itself spelled
        // through a `..`, so the lexical parent compares EQUAL to the library
        // while the path resolves to <dir>/escape.db, outside it.
        let dir = tempdir().unwrap();
        let library = dir.path().join("nope").join("..");
        let escape = library.join("escape.db");
        assert_eq!(escape.parent(), Some(library.as_path()));
        assert!(!in_library(&library, &escape), "{}", escape.display());
    }

    #[test]
    fn in_library_refuses_a_file_in_a_subdirectory() {
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        fs::create_dir_all(lib.join("sub")).unwrap();
        assert!(!in_library(&lib, &lib.join("sub").join("a.db")));
    }

    #[test]
    fn in_library_refuses_a_non_db_file() {
        let dir = tempdir().unwrap();
        let lib = library_dir(dir.path());
        fs::create_dir_all(&lib).unwrap();
        assert!(!in_library(&lib, &lib.join("notes.txt")));
    }

    #[test]
    fn the_default_language_is_english_and_a_tag_this_build_has_no_catalog_for_reads_as_english() {
        // BOTH DIRECTIONS. A resolver that answered English for everything
        // satisfies the second half alone, and the day a second catalog ships
        // the first half is what stops the default moving with it.
        assert_eq!(Settings::default().locale.as_str(), "en");
        assert_eq!(LocaleTag::default().as_str(), "en");
        assert_eq!(LocaleTag::of("fr").as_str(), "en");
        assert_eq!(LocaleTag::of("").as_str(), "en");
        assert_eq!(LocaleTag::of("en").as_str(), "en");
    }

    #[test]
    fn lenient_locale_keeps_a_tag_this_build_actually_ships() {
        // THE FOURTH EQUIVALENT MUTANT from the single-catalog record, pinned:
        // with only `en` shipping, `lenient_locale` replaced by the default
        // and the real deserializer agreed on every settings file there was.
        // `de` now shipping is what makes this line falsifiable.
        let s: Settings = serde_json::from_str(r#"{"locale":"de"}"#).unwrap();
        assert_eq!(s.locale.as_str(), "de");
    }

    #[test]
    fn an_unreadable_language_costs_the_language_and_nothing_else() {
        // The rule every axis of this file carries: one unreadable preference
        // must cost exactly itself, never `last_project` as well. A NUMBER is
        // not a tag, and reads as English rather than as an error.
        let s: Settings = serde_json::from_str(r#"{"last_project":"/x/y.db","locale":7}"#).unwrap();
        assert_eq!(s.locale.as_str(), "en");
        assert_eq!(s.last_project.as_deref(), Some("/x/y.db"));

        let s: Settings =
            serde_json::from_str(r#"{"last_project":"/x/y.db","locale":"fr"}"#).unwrap();
        assert_eq!(s.locale.as_str(), "en");
        assert_eq!(s.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_settings_tag_resolves_to_that_catalog() {
        // The seam this slice exists for: the value in `settings.json` is what
        // decides which words the host writes into the writer's file.
        assert_eq!(LocaleTag::of("en").strings().tag(), "en");
        assert_eq!(LocaleTag::of("en").strings().t("book.contents"), "Contents");
        // A REAL second catalog, not the pseudo-locale earlier tests used to
        // prove the seam without one: `de` selects German, all the way through
        // to the words a headless export would write.
        assert_eq!(LocaleTag::of("de").strings().tag(), "de");
        assert_eq!(LocaleTag::of("de").strings().t("book.contents"), "Inhalt");
        // A regional subtag this build has no exact catalog for: `LocaleTag::of`
        // matches `strings::locale_for` exactly, with no language-subtag
        // extraction, so "de-AT" falls back to English the same as any other
        // unrecognized tag.
        assert_eq!(LocaleTag::of("de-AT").as_str(), "en");
    }

    #[test]
    fn encrypted_backup_dir_is_lenient_without_losing_other_preferences() {
        for value in ["null", "7", "true", "[]", "{}", "\"\"", "\"  \""] {
            let settings: Settings = serde_json::from_str(&format!(
                r#"{{"last_project":"/books/a.db","theme":"dark","encrypted_backup_dir":{value}}}"#
            )).unwrap();
            assert_eq!(settings.last_project.as_deref(), Some("/books/a.db"));
            assert_eq!(settings.theme, Theme::Dark);
            assert_eq!(settings.encrypted_backup_dir, None);
        }
        let settings: Settings = serde_json::from_str(r#"{"encrypted_backup_dir":"/backups"}"#).unwrap();
        assert_eq!(settings.encrypted_backup_dir.as_deref(), Some("/backups"));
        assert_eq!(Settings::default().encrypted_backup_dir, None);
    }

    #[test]
    fn settings_round_trip() {
        let dir = tempdir().unwrap();
        write_settings(
            dir.path(),
            &Settings {
                last_project: Some("/x/y.db".into()),
                locale: LocaleTag::default(),
                mirrored: Vec::new(),
                mirrored_book_ids: Vec::new(),
                protection_claims: Vec::new(),
                books: Vec::new(),
                book_locations: Vec::new(),
                new_book_dir: None,
                encrypted_backup_dir: None,
                theme: Theme::Dark,
                typography: Typography {
                    family: ProseFamily::Mono,
                    size: ProseSize::Larger,
                    measure: ProseMeasure::Narrow,
                },
                window: WindowSize {
                    width: 1150,
                    height: 700,
                },
                zoom: crate::zoom::Zoom::Z150,
                sidebar_word_counts: SidebarWordCounts::default(),
                daily_target: DailyTarget::W1000,
                bible_rows: 9,
                writing_modes: WritingModes {
                    focus: FocusMode::Paragraph,
                    typewriter: TypewriterMode::On,
                },
                spelling: Spelling::Off,
                time_tracking: TimeTracking::Off,
                theme_family: ThemeFamily::Atmospheric,
                mark_cast_names: false,
                start: Start::Blank,
                recent: vec![RecentBook {
                    path: "/x/y.db".into(),
                    opened_at: 42,
                }],
                home_identity: Some("i1".into()),
            },
        )
        .unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
        assert_eq!(read.home_identity.as_deref(), Some("i1"));
        assert_eq!(read.theme, Theme::Dark);
        assert_eq!(read.typography.family, ProseFamily::Mono);
        assert_eq!(read.typography.size, ProseSize::Larger);
        assert_eq!(read.typography.measure, ProseMeasure::Narrow);
        assert_eq!(read.daily_target, DailyTarget::W1000);
        assert_eq!(read.bible_rows, 9);
        // The window was written by this test and never read back until now: a
        // round-trip test that omits a field round-trips everything except the
        // field, silently, from the day it is added.
        assert_eq!(
            read.window,
            WindowSize {
                width: 1150,
                height: 700
            }
        );
        assert_eq!(read.zoom, crate::zoom::Zoom::Z150);
        assert_eq!(read.mark_cast_names, false);
        assert_eq!(read.start, Start::Blank);
        assert_eq!(read.recent.len(), 1);
        assert_eq!(read.recent[0].path, "/x/y.db");
        assert_eq!(read.recent[0].opened_at, 42);
    }

    #[test]
    fn daily_target_deserializes_leniently_without_losing_the_project() {
        for value in [
            serde_json::json!(null),
            serde_json::json!(750),
            serde_json::json!(true),
            serde_json::json!([]),
            serde_json::json!({"Custom":750}),
            serde_json::json!(""),
            serde_json::json!("0"),
            serde_json::json!("0750"),
            serde_json::json!(" 750"),
            serde_json::json!("750 "),
            serde_json::json!("+750"),
            serde_json::json!("-750"),
            serde_json::json!("7.5"),
            serde_json::json!("1e3"),
            serde_json::json!("1000001"),
            serde_json::json!("4294967296"),
            serde_json::json!("999999999999999999999999999999999999"),
            serde_json::json!("７５０"),
        ] {
            let dir = tempdir().unwrap();
            fs::create_dir_all(dir.path().join(APP_DIR)).unwrap();
            fs::write(
                settings_path(dir.path()),
                serde_json::json!({
                    "last_project":"/books/a.db", "theme":"dark", "zoom":"150", "daily_target":value
                })
                .to_string(),
            )
            .unwrap();
            let settings = read_settings(dir.path());
            assert_eq!(settings.daily_target, DailyTarget::Off, "{value}");
            assert_eq!(
                settings.last_project.as_deref(),
                Some("/books/a.db"),
                "{value}"
            );
            assert_eq!(settings.theme, Theme::Dark, "{value}");
            assert_eq!(settings.zoom, crate::zoom::Zoom::Z150, "{value}");
        }
    }

    #[test]
    fn bible_rows_deserializes_leniently_without_losing_the_project() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for value in ["null", "-1", "0", "21", "256", "\"five\""] {
            fs::write(&path, format!("{{\"last_project\":\"/x/y.db\",\"bible_rows\":{value}}}")).unwrap();
            let settings = read_settings(dir.path());
            assert_eq!(settings.bible_rows, default_bible_rows(), "{value}");
            assert_eq!(settings.last_project.as_deref(), Some("/x/y.db"));
        }
        for rows in [1, 20] {
            fs::write(&path, format!("{{\"bible_rows\":{rows}}}")).unwrap();
            assert_eq!(read_settings(dir.path()).bible_rows, rows);
        }
    }

    #[test]
    fn contract_and_expand_home_round_trip() {
        let home = Path::new("/home/writer");
        for value in ["~", "~/x.db", "~/a/b/c.db"] {
            let expanded = expand_home(value, home);
            assert_eq!(contract_home(&expanded, home), value, "{value}");
        }
    }

    #[test]
    fn contract_home_leaves_a_path_outside_home_unchanged() {
        let home = Path::new("/home/writer");
        assert_eq!(contract_home("/srv/books/x.db", home), "/srv/books/x.db");
    }

    // ---- resolve_new_book_dir --------------------------------------

    #[test]
    fn an_absolute_remembered_folder_wins_over_every_default() {
        let library = PathBuf::from("/home/writer/.local/share/garret/projects");
        let custom = "/home/writer/Manuscripts";
        assert_eq!(
            resolve_new_book_dir(
                Some(custom),
                &library,
                Some(PathBuf::from("/home/writer/Documents")),
                Some(PathBuf::from("/home/writer")),
            )
            .unwrap(),
            PathBuf::from(custom),
        );
    }

    #[test]
    fn the_remembered_hidden_library_is_treated_as_unset() {
        // `create_into_dir` writes `new_book_dir` on every plain create, the
        // hidden library included -- a profile from before this slice can hold
        // it as a "remembered" folder, and that is the legacy default, not a
        // choice.
        let library = PathBuf::from("/home/writer/.local/share/garret/projects");
        let documents = PathBuf::from("/home/writer/Documents");
        assert_eq!(
            resolve_new_book_dir(
                Some(library.to_str().unwrap()),
                &library,
                Some(documents.clone()),
                Some(PathBuf::from("/home/writer")),
            )
            .unwrap(),
            documents.join("Books"),
        );
    }

    #[test]
    fn with_documents_available_the_default_is_documents_books() {
        let library = PathBuf::from("/home/writer/.local/share/garret/projects");
        let documents = PathBuf::from("/home/writer/Dokumente");
        assert_eq!(
            resolve_new_book_dir(None, &library, Some(documents.clone()), None).unwrap(),
            documents.join("Books"),
            "the resolved name must not assume an English Documents folder",
        );
    }

    #[test]
    fn with_no_documents_folder_the_default_falls_back_to_home_books() {
        let library = PathBuf::from("/home/writer/.local/share/garret/projects");
        let home = PathBuf::from("/home/writer");
        assert_eq!(
            resolve_new_book_dir(None, &library, None, Some(home.clone())).unwrap(),
            home.join("Books"),
        );
    }

    #[test]
    fn with_neither_documents_nor_home_the_resolver_refuses() {
        let library = PathBuf::from("/home/writer/.local/share/garret/projects");
        let error = resolve_new_book_dir(None, &library, None, None).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn a_relative_remembered_value_is_not_a_custom_choice() {
        // Every writer of `new_book_dir` in this file stores an absolute path
        // (106's own discipline); a relative survivor from a hand-edited or
        // damaged settings file must not be handed to the writer as a folder
        // to create a book in.
        let library = PathBuf::from("/home/writer/.local/share/garret/projects");
        let documents = PathBuf::from("/home/writer/Documents");
        assert_eq!(
            resolve_new_book_dir(
                Some("Books"),
                &library,
                Some(documents.clone()),
                None,
            )
            .unwrap(),
            documents.join("Books"),
        );
    }

    #[test]
    fn resolve_new_book_dir_creates_nothing_and_touches_no_settings() {
        // PURE, the doc comment's own word: a lookup must not have side
        // effects a caller did not ask for.
        let dir = tempdir().unwrap();
        let library = library_dir(dir.path());
        let documents = dir.path().join("Documents");
        let resolved = resolve_new_book_dir(None, &library, Some(documents.clone()), None).unwrap();
        assert_eq!(resolved, documents.join("Books"));
        assert!(!documents.exists(), "the lookup must not create the Documents folder");
        assert!(!resolved.exists(), "the lookup must not create the resolved folder");
        assert!(
            !settings_path(dir.path()).exists(),
            "a pure lookup must not create a settings file"
        );
    }

    #[test]
    fn contract_home_does_not_match_a_directory_that_merely_shares_the_prefix() {
        // /home/writer2 is not inside /home/writer, and a component-wise check
        // would get this right too -- this is the string check's own case.
        let home = Path::new("/home/writer");
        assert_eq!(
            contract_home("/home/writer2/x.db", home),
            "/home/writer2/x.db"
        );
    }

    #[test]
    fn contract_home_trims_a_trailing_slash_on_home() {
        let home = Path::new("/home/writer/");
        assert_eq!(contract_home("/home/writer/x.db", home), "~/x.db");
        assert_eq!(contract_home("/home/writer", home), "~");
    }

    #[test]
    fn contract_and_expand_home_treat_root_as_home() {
        let home = Path::new("/");
        assert_eq!(contract_home("/x.db", home), "~/x.db");
        assert_eq!(contract_home("/", home), "~");
        assert_eq!(expand_home("~/x.db", home), "/x.db");
        assert_eq!(expand_home("~", home), "/");
    }

    #[test]
    fn contract_home_does_not_follow_a_symlinked_home() {
        // Reviewed out, not forgotten: a canonical-home retry has no inverse
        // on read, so the contracted value came back under the OTHER
        // spelling and `record_recent`'s dedup grew a duplicate per launch.
        // The canonical spelling stays absolute, and this pins that it does.
        let backing = tempdir().unwrap();
        let real_home = backing.path().join("data-writer");
        fs::create_dir_all(&real_home).unwrap();
        let link_parent = tempdir().unwrap();
        let home = link_parent.path().join("writer");
        std::os::unix::fs::symlink(&real_home, &home).unwrap();
        let book = fs::canonicalize(&real_home).unwrap().join("x.db");
        let book = book.to_string_lossy().into_owned();
        assert_eq!(contract_home(&book, &home), book);
        assert_eq!(contract_home(&home.join("y.db").to_string_lossy(), &home), "~/y.db");
    }

    #[test]
    fn a_remembered_book_that_is_not_absolute_is_not_in_the_openability_set() {
        // No usable HOME leaves a `~/` entry literal; `known` must not hand
        // a relative path to `may_open`, which would resolve it against the
        // working directory.
        // Planted as bytes with a plain relative path: `known` reads through
        // the process HOME, which would expand a `~/` entry, and no test sets
        // HOME.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"books":["relative/a.db"]}"#).unwrap();
        assert!(!known(dir.path()).iter().any(|p| p.to_string_lossy().contains("a.db")));
    }

    #[test]
    fn read_settings_expands_all_six_path_fields() {
        let dir = tempdir().unwrap();
        let home = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"last_project":"~/a.db","books":["~/b.db"],"book_locations":[{"book_id":"book-1","path":"~/location.db"}],"mirrored_book_ids":["book-1"],"new_book_dir":"~/dir","encrypted_backup_dir":"~/backup","recent":[{"path":"~/c.db","opened_at":1}]}"#,
        )
        .unwrap();
        let read = read_settings_with(dir.path(), Some(home.path()));
        let want = |rest: &str| home.path().join(rest).to_string_lossy().into_owned();
        assert_eq!(read.last_project.as_deref(), Some(want("a.db")).as_deref());
        assert_eq!(read.books, vec![want("b.db")]);
        assert_eq!(read.book_locations[0].book_id, "book-1");
        assert_eq!(read.book_locations[0].path, want("location.db"));
        assert_eq!(read.mirrored_book_ids, ["book-1"]);
        assert_eq!(read.new_book_dir.as_deref(), Some(want("dir")).as_deref());
        assert_eq!(read.recent[0].path, want("c.db"));
        assert_eq!(read.encrypted_backup_dir.as_deref(), Some(want("backup")).as_deref());
    }

    #[test]
    fn write_settings_contracts_all_six_path_fields_and_leaves_no_trace_of_home() {
        let dir = tempdir().unwrap();
        let home = tempdir().unwrap();
        let mut s = Settings::default();
        let under = |rest: &str| home.path().join(rest).to_string_lossy().into_owned();
        s.last_project = Some(under("a.db"));
        s.books = vec![under("b.db")];
        s.book_locations = vec![BookLocation {
            book_id: "book-1".into(),
            path: under("location.db"),
        }];
        s.new_book_dir = Some(under("dir"));
        s.encrypted_backup_dir = Some(under("backup"));
        s.recent = vec![RecentBook {
            path: under("c.db"),
            opened_at: 1,
        }];
        write_settings_with(dir.path(), &s, Some(home.path())).unwrap();
        let body = fs::read_to_string(settings_path(dir.path())).unwrap();
        let home_str = home.path().to_string_lossy().into_owned();
        assert!(!body.contains(home_str.as_str()), "{body}");
        assert!(body.contains("~/"), "{body}");
    }

    #[test]
    fn a_legacy_absolute_settings_file_reads_unchanged_and_contracts_on_the_next_write() {
        let dir = tempdir().unwrap();
        let home = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let absolute = home.path().join("a.db").to_string_lossy().into_owned();
        fs::write(&path, format!(r#"{{"last_project":"{absolute}"}}"#)).unwrap();

        let read = read_settings_with(dir.path(), Some(home.path()));
        assert_eq!(read.last_project.as_deref(), Some(absolute.as_str()));

        // One read-modify-write, `update_settings`'s own shape, done through
        // the `_with` forms so this test never sets `HOME`.
        write_settings_with(dir.path(), &read, Some(home.path())).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(!body.contains(absolute.as_str()), "{body}");
        assert!(body.contains("~/a.db"), "{body}");
    }

    #[test]
    fn with_no_home_write_is_absolute_and_a_tilde_value_reads_back_literally() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        let s = Settings {
            last_project: Some("/srv/books/a.db".into()),
            ..Settings::default()
        };
        write_settings_with(dir.path(), &s, None).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("/srv/books/a.db"), "{body}");

        fs::write(&path, br#"{"last_project":"~/a.db"}"#).unwrap();
        let read = read_settings_with(dir.path(), None);
        // No home to expand against: the value reads back exactly as written,
        // which lists as a missing book rather than a deleted one.
        assert_eq!(read.last_project.as_deref(), Some("~/a.db"));
    }

    #[test]
    fn recent_path_survives_lenient_recent_and_then_expands() {
        let dir = tempdir().unwrap();
        let home = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"recent":[{"path":"~/c.db","opened_at":7},{"path":"bad"}]}"#,
        )
        .unwrap();
        let read = read_settings_with(dir.path(), Some(home.path()));
        // The element with no opened_at is dropped by lenient_recent at parse
        // time; the survivor's path is what expand_paths then runs on.
        assert_eq!(read.recent.len(), 1);
        assert_eq!(
            read.recent[0].path,
            home.path().join("c.db").to_string_lossy()
        );
    }

    #[test]
    fn every_path_field_of_settings_is_in_the_seam() {
        // The tripwire for a NEW path field added to `Settings` without
        // joining `expand_paths`/`contracted`. `mirrored` (project slugs),
        // `mirrored_book_ids`, and `home_identity` (a pen-name id, 100) are
        // NOT paths, on purpose, and
        // stay out of the seam.
        // EXHAUSTIVE LITERAL, no `..Default::default()`: a field added to
        // `Settings` fails to compile here, which is what makes the reader
        // decide whether it is a path. `settings_round_trip`'s own shape.
        let home = tempdir().unwrap();
        let sentinel = home.path().join("SENTINEL").to_string_lossy().into_owned();
        let s = Settings {
            last_project: Some(sentinel.clone()),
            theme: Theme::default(),
            typography: Typography::default(),
            window: WindowSize::default(),
            zoom: crate::zoom::Zoom::default(),
            sidebar_word_counts: SidebarWordCounts::default(),
            daily_target: DailyTarget::default(),
            bible_rows: default_bible_rows(),
            writing_modes: WritingModes::default(),
            spelling: Spelling::default(),
            time_tracking: TimeTracking::default(),
            theme_family: ThemeFamily::default(),
            locale: LocaleTag::default(),
            mirrored: Vec::new(),
            mirrored_book_ids: Vec::new(),
            protection_claims: Vec::new(),
            books: vec![sentinel.clone()],
            book_locations: vec![BookLocation {
                book_id: "book-1".into(),
                path: sentinel.clone(),
            }],
            new_book_dir: Some(sentinel.clone()),
            encrypted_backup_dir: Some(sentinel.clone()),
            mark_cast_names: true,
            start: Start::default(),
            recent: vec![RecentBook {
                path: sentinel.clone(),
                opened_at: 1,
            }],
            home_identity: None,
        };
        let contracted = s.contracted(home.path());
        let body = serde_json::to_string(&contracted).unwrap();
        assert_eq!(body.matches("~/SENTINEL").count(), 6, "{body}");
        assert_eq!(body.matches(sentinel.as_str()).count(), 0, "{body}");
    }

    #[test]
    fn a_settings_file_written_before_typography_reads_as_the_defaults() {
        // Absent, not wrong: every settings.json on disk today is this shape.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"last_project":"/x/y.db","theme":"dark"}"#).unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.typography, Typography::default());
        assert_eq!(read.theme, Theme::Dark);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
        // The absent-key default, and the reason Settings no longer derives
        // Default: a plain `bool` field derives to `false`, which would read a
        // file written before this slice as the feature turned off.
        assert!(read.mark_cast_names);
    }

    #[test]
    fn mark_cast_names_round_trips_and_defaults_on() {
        let dir = tempdir().unwrap();
        assert!(Settings::default().mark_cast_names);
        assert!(read_settings(dir.path()).mark_cast_names);

        update_settings(dir.path(), |s| s.mark_cast_names = false)
            .expect("a plain bool write cannot fail");
        assert!(!read_settings(dir.path()).mark_cast_names);

        update_settings(dir.path(), |s| s.mark_cast_names = true)
            .expect("a plain bool write cannot fail");
        assert!(read_settings(dir.path()).mark_cast_names);
    }

    #[test]
    fn an_unreadable_typography_object_costs_the_typography_and_nothing_else() {
        // The OUTER half of the nested leniency. read_settings maps a failed
        // parse of the whole file to the default, so a strict field here would
        // discard last_project and send the next launch to another manuscript.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for body in [
            br#"{"last_project":"/x/y.db","theme":"dark","typography":7}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"dark","typography":null}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"dark","typography":"large"}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"dark","typography":[1,2]}"#.to_vec(),
        ] {
            fs::write(&path, &body).unwrap();
            let read = read_settings(dir.path());
            let why = String::from_utf8_lossy(&body).to_string();
            assert_eq!(read.typography, Typography::default(), "{why}");
            assert_eq!(read.theme, Theme::Dark, "{why}");
            assert_eq!(read.last_project.as_deref(), Some("/x/y.db"), "{why}");
        }
    }

    #[test]
    fn an_unreadable_spelling_costs_the_spelling_and_nothing_else() {
        // Same exposure every field in this file has: read_settings maps a
        // failed parse of the WHOLE file to defaults, so a strictly typed field
        // makes one bad value discard last_project and send the next launch to
        // another manuscript.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for body in [
            br#"{"last_project":"/x/y.db","spelling":7}"#.to_vec(),
            br#"{"last_project":"/x/y.db","spelling":null}"#.to_vec(),
            br#"{"last_project":"/x/y.db","spelling":"yes"}"#.to_vec(),
        ] {
            fs::write(&path, &body).unwrap();
            let read = read_settings(dir.path());
            let why = String::from_utf8_lossy(&body).to_string();
            assert_eq!(read.spelling, Spelling::default(), "{why}");
            assert_eq!(read.last_project.as_deref(), Some("/x/y.db"), "{why}");
        }
    }

    #[test]
    fn spelling_is_on_unless_the_writer_turned_it_off() {
        // ON by default, and the default is what an absent field reads as - a
        // writer who has never opened the preferences panel gets underlines.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"last_project":"/x/y.db"}"#).unwrap();
        assert_eq!(read_settings(dir.path()).spelling, Spelling::On);
        assert!(Spelling::default().enabled());

        fs::write(&path, br#"{"spelling":"off"}"#).unwrap();
        assert_eq!(read_settings(dir.path()).spelling, Spelling::Off);
        assert!(!Spelling::Off.enabled());
    }

    #[test]
    fn an_unknown_spelling_spelling_does_not_parse() {
        assert_eq!(Spelling::parse("on"), Some(Spelling::On));
        assert_eq!(Spelling::parse("off"), Some(Spelling::Off));
        assert_eq!(Spelling::parse("true"), None);
        assert_eq!(Spelling::parse("On"), None);
    }

    #[test]
    fn an_unreadable_writing_modes_object_costs_the_modes_and_nothing_else() {
        // The OUTER half of the same nested leniency the typography has, and it
        // matters for the same reason: read_settings maps a failed parse of the
        // WHOLE file to the default, so a strict field here would discard
        // last_project and send the next launch to another manuscript.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for body in [
            br#"{"last_project":"/x/y.db","theme":"dark","writing_modes":7}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"dark","writing_modes":null}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"dark","writing_modes":"paragraph"}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"dark","writing_modes":[1,2]}"#.to_vec(),
        ] {
            fs::write(&path, &body).unwrap();
            let read = read_settings(dir.path());
            let why = String::from_utf8_lossy(&body).to_string();
            assert_eq!(read.writing_modes, WritingModes::default(), "{why}");
            assert_eq!(read.theme, Theme::Dark, "{why}");
            assert_eq!(read.last_project.as_deref(), Some("/x/y.db"), "{why}");
        }
    }

    #[test]
    fn an_unreadable_focus_costs_the_focus_and_not_the_typewriter_beside_it() {
        // The INNER half, which a single outer lenient_writing_modes does not
        // cover: the object parses, one axis in it does not, and the other is
        // perfectly good. Two independent axes are exactly where this goes
        // wrong.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"last_project":"/x/y.db","writing_modes":{"focus":7,"typewriter":"on"}}"#,
        )
        .unwrap();

        let read = read_settings(dir.path());

        assert_eq!(read.writing_modes.focus, FocusMode::Off);
        assert_eq!(read.writing_modes.typewriter, TypewriterMode::On);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn an_unknown_writing_mode_spelling_does_not_parse() {
        // The page cannot write a value into the file that the next launch will
        // not understand, which is what keeps a preference from silently
        // reverting a launch later.
        assert_eq!(FocusMode::parse("off"), Some(FocusMode::Off));
        assert_eq!(FocusMode::parse("paragraph"), Some(FocusMode::Paragraph));
        assert_eq!(FocusMode::parse("sentence"), None);
        assert_eq!(FocusMode::parse("Paragraph"), None);
        assert_eq!(TypewriterMode::parse("on"), Some(TypewriterMode::On));
        assert_eq!(TypewriterMode::parse("true"), None);
    }

    #[test]
    fn an_unreadable_size_costs_the_size_and_not_the_family_beside_it() {
        // The INNER half. This is the case a single outer lenient_typography
        // does not cover: the object parses, one field in it does not, and the
        // other two are perfectly good.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"last_project":"/x/y.db","typography":{"family":"mono","size":7,"measure":"wide"}}"#,
        )
        .unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.typography.size, ProseSize::Medium);
        assert_eq!(read.typography.family, ProseFamily::Mono);
        assert_eq!(read.typography.measure, ProseMeasure::Wide);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn the_default_window_shows_three_different_measures() {
        // What this arithmetic actually protects: at the old 900x900 the
        // pane was 532px and even the NARROWEST measure capped against it, so
        // all three rendered identically and a preference nobody could see
        // shipped. The medium size is 19px and the widest column
        // (48em = 912px) no longer fits the 832px default pane; it caps, but
        // it still caps WIDER than medium (741px), so the three remain three.
        // Interface zoom is the answer for a writer who wants more.
        let pane = WindowSize::default().width - 320 - 48;
        let px = 19;
        let narrow = 32 * px;
        let medium = 39 * px;
        let wide = (48 * px).min(pane);
        assert!(narrow < medium && medium < wide, "{narrow} {medium} {wide} in {pane}");
    }

    #[test]
    fn zoom_reads_and_writes_beside_the_window() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(APP_DIR)).unwrap();
        fs::write(
            settings_path(dir.path()),
            br#"{"last_project":"/x/y.db","zoom":"150"}"#,
        )
        .unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.zoom, crate::zoom::Zoom::Z150);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
        // Absent key: default, and the rest of the file survives.
        fs::write(settings_path(dir.path()), br#"{"last_project":"/x/y.db"}"#).unwrap();
        assert_eq!(read_settings(dir.path()).zoom, crate::zoom::Zoom::Z100);
    }

    #[test]
    fn an_unusable_recorded_size_is_ignored_rather_than_obeyed() {
        let dot = WindowSize {
            width: 1,
            height: 1,
        };
        assert_eq!(dot.fit(None), MIN_WINDOW);
    }

    #[test]
    fn a_size_larger_than_the_screen_is_clamped_to_it() {
        // Recorded on a 4K monitor, reopened on a laptop. Obeying it puts half
        // the manuscript off the edge.
        let big = WindowSize {
            width: 3840,
            height: 2160,
        };
        let laptop = WindowSize {
            width: 1366,
            height: 740,
        };
        assert_eq!(big.fit(Some(laptop)), laptop);
    }

    #[test]
    fn a_size_that_already_fits_is_left_exactly_alone() {
        // The clamp must not be a resize. A version that always returned the
        // work area would satisfy both tests above.
        let chosen = WindowSize {
            width: 1150,
            height: 700,
        };
        assert_eq!(
            chosen.fit(Some(WindowSize {
                width: 1920,
                height: 1080
            })),
            chosen
        );
        assert_eq!(chosen.fit(None), chosen);
    }

    #[test]
    fn the_floor_wins_over_a_screen_smaller_than_it() {
        // A work area under MIN_WINDOW is a screen this application does not fit
        // on either way. Shrinking to it produces exactly the unusable window
        // the floor exists to prevent, while looking deliberate.
        let fitted = WindowSize::default().fit(Some(WindowSize {
            width: 320,
            height: 200,
        }));
        assert_eq!(fitted, MIN_WINDOW);
    }

    #[test]
    fn a_settings_file_written_before_window_sizes_reads_as_the_default() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"last_project":"/x/y.db","theme":"dark"}"#).unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.window, WindowSize::default());
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn an_unreadable_window_costs_the_window_and_nothing_else() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for body in [
            br#"{"last_project":"/x/y.db","window":7}"#.to_vec(),
            br#"{"last_project":"/x/y.db","window":null}"#.to_vec(),
            br#"{"last_project":"/x/y.db","window":"big"}"#.to_vec(),
            br#"{"last_project":"/x/y.db","window":{"width":"wide"}}"#.to_vec(),
        ] {
            fs::write(&path, &body).unwrap();
            let read = read_settings(dir.path());
            let why = String::from_utf8_lossy(&body).to_string();
            assert_eq!(read.window, WindowSize::default(), "{why}");
            assert_eq!(read.last_project.as_deref(), Some("/x/y.db"), "{why}");
        }
    }

    #[test]
    fn one_recorded_axis_survives_a_missing_sibling() {
        // The INNER half. A file holding a width and no height must keep the
        // width: discarding both would silently undo half of what the writer
        // did, and the window would come back a size they never chose.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"window":{"width":1400}}"#).unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.window.width, 1400);
        assert_eq!(read.window.height, WindowSize::default().height);
    }

    #[test]
    fn a_typography_value_round_trips_through_its_own_spelling() {
        for family in [ProseFamily::Serif, ProseFamily::Sans, ProseFamily::Mono] {
            assert_eq!(ProseFamily::parse(family.as_str()), Some(family));
        }
        for size in [
            ProseSize::Small,
            ProseSize::Medium,
            ProseSize::Large,
            ProseSize::Larger,
        ] {
            assert_eq!(ProseSize::parse(size.as_str()), Some(size));
        }
        for measure in [
            ProseMeasure::Narrow,
            ProseMeasure::Medium,
            ProseMeasure::Wide,
        ] {
            assert_eq!(ProseMeasure::parse(measure.as_str()), Some(measure));
        }
    }

    #[test]
    fn an_unknown_typography_spelling_does_not_parse() {
        // What makes the command boundary able to REFUSE rather than default.
        // Each axis is asked for a word that is legal on one of the others, so
        // a parse that fell through to a shared table would be caught here.
        assert_eq!(ProseFamily::parse("large"), None);
        assert_eq!(ProseFamily::parse("Serif"), None);
        assert_eq!(ProseSize::parse("mono"), None);
        assert_eq!(ProseSize::parse("wide"), None);
        assert_eq!(ProseMeasure::parse("larger"), None);
        assert_eq!(ProseMeasure::parse(""), None);
    }

    #[test]
    fn a_settings_file_written_before_themes_reads_as_system() {
        // The field is absent, not wrong. Every settings.json on disk today is
        // this shape, and none of them may fail to load.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"last_project":"/x/y.db"}"#).unwrap();
        let read = read_settings(dir.path());
        assert_eq!(read.theme, Theme::System);
        assert_eq!(read.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn an_unreadable_theme_costs_the_theme_and_nothing_else() {
        // read_settings maps a failed parse to the default, so a strictly
        // deserialized theme would make this file discard last_project too and
        // the next launch would open a different manuscript. The lenient reader
        // is what keeps one bad preference from taking the other one with it.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for body in [
            br#"{"last_project":"/x/y.db","theme":7}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":"chartreuse"}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":null}"#.to_vec(),
            br#"{"last_project":"/x/y.db","theme":{"a":1}}"#.to_vec(),
        ] {
            fs::write(&path, &body).unwrap();
            let read = read_settings(dir.path());
            assert_eq!(
                read.theme,
                Theme::System,
                "{}",
                String::from_utf8_lossy(&body)
            );
            assert_eq!(
                read.last_project.as_deref(),
                Some("/x/y.db"),
                "{}",
                String::from_utf8_lossy(&body)
            );
        }
    }

    #[test]
    fn a_theme_round_trips_through_its_own_spelling() {
        // as_str is what the settings file and the page both carry, so it has to
        // be the same string parse accepts. A rename on one side only would
        // write a file the next launch reads as system.
        for theme in [Theme::System, Theme::Light, Theme::Dark] {
            assert_eq!(Theme::parse(theme.as_str()), Some(theme));
        }
        assert_eq!(Theme::parse("Dark"), None);
        assert_eq!(Theme::parse(""), None);
    }

    #[test]
    fn an_unparseable_settings_file_reads_as_default() {
        // A preferences file is not worth refusing to launch over: losing it
        // costs the writer one click.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not json").unwrap();
        assert_eq!(read_settings(dir.path()).last_project, None);
    }

    #[test]
    fn a_missing_settings_file_reads_as_default() {
        let dir = tempdir().unwrap();
        assert_eq!(read_settings(dir.path()).last_project, None);
    }

    #[test]
    fn an_unreadable_start_costs_the_start_and_nothing_else() {
        // The rule every axis of this file carries, restated for `start`: a
        // NUMBER is not one of the three words and reads as the default
        // rather than as an error, and `last_project` beside it survives.
        let s: Settings =
            serde_json::from_str(r#"{"last_project":"/x/y.db","start":7}"#).unwrap();
        assert_eq!(s.start, Start::Home);
        assert_eq!(s.last_project.as_deref(), Some("/x/y.db"));
    }

    #[test]
    fn a_start_round_trips_through_its_own_spelling() {
        for word in ["home", "last", "blank"] {
            let s: Settings =
                serde_json::from_str(&format!(r#"{{"start":"{word}"}}"#)).unwrap();
            assert_eq!(s.start.as_str(), word);
        }
    }

    #[test]
    fn a_malformed_recent_entry_costs_only_itself() {
        // 5 is not an object at all; {"path":"b"} is missing `opened_at`. Both
        // are dropped and the one well-formed entry survives - the per-element
        // half of the leniency rule, not the whole-field half.
        let s: Settings = serde_json::from_str(
            r#"{"recent":[{"path":"a","opened_at":1},5,{"path":"b"}]}"#,
        )
        .unwrap();
        assert_eq!(s.recent.len(), 1);
        assert_eq!(s.recent[0].path, "a");
        assert_eq!(s.recent[0].opened_at, 1);
    }

    #[test]
    fn record_recent_moves_an_existing_path_to_the_front_without_duplicating_it() {
        let mut s = Settings::default();
        record_recent(&mut s, Path::new("/a"), 1);
        record_recent(&mut s, Path::new("/b"), 2);
        record_recent(&mut s, Path::new("/a"), 3);
        assert_eq!(s.recent.len(), 2);
        assert_eq!(s.recent[0].path, "/a");
        assert_eq!(s.recent[0].opened_at, 3);
        assert_eq!(s.recent[1].path, "/b");
    }

    #[test]
    fn remember_open_writes_last_project_and_recent_for_a_human_open() {
        let dir = tempfile::tempdir().unwrap();
        remember_open(dir.path(), false, Path::new("/lib/a.db"), 7);
        let read = read_settings(dir.path());
        assert_eq!(read.last_project.as_deref(), Some("/lib/a.db"));
        assert_eq!(read.recent.len(), 1);
        assert_eq!(read.recent[0].path, "/lib/a.db");
        assert_eq!(read.recent[0].opened_at, 7);
    }

    #[test]
    fn remember_open_writes_nothing_under_app_project() {
        let dir = tempfile::tempdir().unwrap();
        // The positive control above proves the same call writes when it may.
        remember_open(dir.path(), true, Path::new("/lib/a.db"), 7);
        assert!(!settings_path(dir.path()).exists());
        let read = read_settings(dir.path());
        assert_eq!(read.last_project, None);
        assert!(read.recent.is_empty());
    }

    #[test]
    fn remember_open_waits_for_a_settings_update_and_preserves_both_changes() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let mut completed_while_locked = false;

        std::thread::scope(|scope| {
            update_settings(home, |settings| {
                scope.spawn(move || {
                    started_tx.send(()).unwrap();
                    remember_open(home, false, Path::new("/lib/a.db"), 7);
                    done_tx.send(()).unwrap();
                });
                started_rx.recv().unwrap();
                // The ordinary update owns the lock until this callback returns.
                completed_while_locked = done_rx
                    .recv_timeout(std::time::Duration::from_millis(100))
                    .is_ok();
                settings.theme = Theme::Dark;
                settings.window = WindowSize {
                    width: 1200,
                    height: 800,
                };
            })
            .unwrap();
        });

        assert!(!completed_while_locked, "the open bypassed the settings lock");
        let read = read_settings_checked(home).unwrap();
        assert_eq!(read.last_project.as_deref(), Some("/lib/a.db"));
        assert_eq!(read.recent.len(), 1);
        assert_eq!(read.recent[0].path, "/lib/a.db");
        assert_eq!(read.recent[0].opened_at, 7);
        assert_eq!(read.theme, Theme::Dark);
        assert_eq!(
            read.window,
            WindowSize {
                width: 1200,
                height: 800,
            }
        );
    }

    #[test]
    fn remember_open_preserves_damaged_settings() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{").unwrap();

        remember_open(dir.path(), false, Path::new("/lib/a.db"), 7);

        assert_eq!(fs::read(path).unwrap(), b"{");
    }

    #[test]
    fn record_recent_drops_the_oldest_past_the_cap() {
        let mut s = Settings::default();
        for i in 0..21u64 {
            record_recent(&mut s, Path::new(&format!("/book-{i}")), i);
        }
        assert_eq!(s.recent.len(), RECENT_CAP);
        assert_eq!(s.recent[0].path, "/book-20");
        assert!(!s.recent.iter().any(|r| r.path == "/book-0"));
    }

    #[test]
    fn exports_dir_sits_beside_the_library() {
        let d = Path::new("/data");
        assert_eq!(exports_dir(d), PathBuf::from("/data/garret/exports"));
        assert_eq!(exports_dir(d).parent(), library_dir(d).parent());
    }

    #[test]
    fn pick_export_path_takes_the_bare_name_when_it_is_free() {
        let dir = tempdir().unwrap();
        assert_eq!(
            pick_export_path(dir.path(), "my-novel"),
            dir.path().join("my-novel.md")
        );
    }

    #[test]
    fn pick_export_path_increments_past_every_existing_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("my-novel.md"), "x").unwrap();
        assert_eq!(
            pick_export_path(dir.path(), "my-novel"),
            dir.path().join("my-novel-2.md")
        );
        fs::write(dir.path().join("my-novel-2.md"), "x").unwrap();
        assert_eq!(
            pick_export_path(dir.path(), "my-novel"),
            dir.path().join("my-novel-3.md")
        );
    }

    #[test]
    fn pick_export_path_skips_a_gap_rather_than_filling_it() {
        // -2 missing but -3 present: taking -2 would put an older export after a
        // newer one in a sorted listing. Go past everything.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "x").unwrap();
        fs::write(dir.path().join("n-3.md"), "x").unwrap();
        assert_eq!(pick_export_path(dir.path(), "n"), dir.path().join("n-4.md"));
    }

    #[test]
    fn pick_export_path_counts_a_numbered_file_whose_bare_name_is_absent() {
        // The gap case with the bare name missing too: the increment is driven
        // by the maximum ordinal on disk, not by whether `n.md` is there.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("n-3.md"), "x").unwrap();
        assert_eq!(pick_export_path(dir.path(), "n"), dir.path().join("n-4.md"));
    }

    #[test]
    fn a_suffix_is_read_against_the_slug_it_was_asked_about() {
        // `n-3.md` is ordinal 3 for slug `n` and the BARE NAME for slug `n-3`.
        // Both readings are correct; what must not happen is one file meaning
        // two things at once, or `pick_export_path("n-3")` returning a name that
        // already exists.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("n-3.md"), "x").unwrap();
        assert_eq!(pick_export_path(dir.path(), "n"), dir.path().join("n-4.md"));
        assert_eq!(
            pick_export_path(dir.path(), "n-3"),
            dir.path().join("n-3-2.md")
        );
    }

    #[test]
    fn a_suffix_this_function_never_writes_is_not_an_ordinal() {
        // Ordinals start at 2 -- 1 is spelled by the bare name -- so `n-0.md`
        // and `n-1.md` are somebody else's files that happen to look close, as
        // is a leading zero. Counting them would push the next export past a
        // free name for no reason, and reading `n-0` as an ordinal would make
        // the successor `n-1.md`, a name this function never claims.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("n-0.md"), "x").unwrap();
        fs::write(dir.path().join("n-1.md"), "x").unwrap();
        fs::write(dir.path().join("n-02.md"), "x").unwrap();
        fs::write(dir.path().join("n-abc.md"), "x").unwrap();
        // `u64::from_str` accepts a leading `+`, so the digit check is not
        // redundant with the parse it guards.
        fs::write(dir.path().join("n-+5.md"), "x").unwrap();
        fs::write(dir.path().join("n-.md"), "x").unwrap();
        fs::write(dir.path().join("n-9.txt"), "x").unwrap();
        fs::write(dir.path().join("other-7.md"), "x").unwrap();
        assert_eq!(pick_export_path(dir.path(), "n"), dir.path().join("n.md"));
    }

    #[test]
    fn a_directory_wearing_the_name_still_counts() {
        // The name is what the export must claim, and create_new(true) fails on
        // a directory exactly as it fails on a file. Skipping non-files here
        // would hand the caller a path it cannot create.
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("n-2.md")).unwrap();
        assert_eq!(pick_export_path(dir.path(), "n"), dir.path().join("n-3.md"));
    }

    #[test]
    fn pick_export_path_on_a_missing_directory_is_the_bare_name() {
        // The caller create_dir_all's, but a directory that is not there yet
        // must be an empty answer rather than a panic.
        let dir = tempdir().unwrap();
        let missing = dir.path().join("not-yet");
        assert_eq!(pick_export_path(&missing, "n"), missing.join("n.md"));
    }

    #[test]
    fn an_ordinal_too_large_to_increment_is_not_an_ordinal() {
        // Twenty digits overflow every integer this function could parse into.
        // Treating it as unparseable keeps the answer a free name; a saturating
        // read would return a path that already exists.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("n-99999999999999999999.md"), "x").unwrap();
        assert_eq!(pick_export_path(dir.path(), "n"), dir.path().join("n.md"));
    }

    /// A recovery point: an ordinary project file, which is what makes a
    /// restore a copy rather than a conversion. Carries a NAME_KEY because
    /// every project the application creates does.
    fn a_point(at: &Path) {
        let store = crate::test_support::seeded_project(at);
        store.set_meta(NAME_KEY, "My Book").unwrap();
    }

    /// A point that never recorded a name -- a project opened by path rather
    /// than created in the library.
    fn a_nameless_point(at: &Path) {
        drop(crate::test_support::seeded_project(at));
    }

    fn library_dbs(library: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(library)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.ends_with(".db"))
                    .collect()
            })
            .unwrap_or_default();
        out.sort();
        out
    }

    #[test]
    fn a_portable_point_restores_its_original_picture_without_changing_source() {
        let root = tempdir().unwrap();
        let source = root.path().join("book.db");
        let store = crate::test_support::seeded_project(&source);
        let member = store.cast_create("character", "Ada").unwrap();
        store.cast_set_picture(&member.id, Some("face.png")).unwrap();
        let source_pictures = crate::pictures::dir_for(&source);
        fs::create_dir(&source_pictures).unwrap();
        let original = include_bytes!("../fixtures/two-halves.png");
        fs::write(source_pictures.join("face.png"), original).unwrap();
        drop(store);
        let point = crate::recovery::take_point(&source, "book", "Book", &root.path().join("points"), 1_700_000_000_000).unwrap();
        assert!(point.verified, "{:?}", point.errors);
        let bundle = crate::backup_bundle::path_for(&root.path().join("points"), &point.id);
        let bundle_before = fs::read(crate::backup_bundle::db_path(&bundle)).unwrap();
        let library = root.path().join("library");
        let restored = restore_point_into(&bundle, &library, "book", 1_700_000_100_000).unwrap();
        let restored_db = Path::new(&restored.path);
        assert_eq!(fs::read(crate::pictures::dir_for(restored_db).join("face.png")).unwrap(), original);
        assert!(!crate::backup_bundle::marker_present(restored_db).unwrap());
        assert_eq!(fs::read(crate::backup_bundle::db_path(&bundle)).unwrap(), bundle_before);
        assert_eq!(fs::read(source_pictures.join("face.png")).unwrap(), original);
    }

    #[test]
    fn a_portable_restore_skips_an_occupied_picture_name_and_cleans_only_its_own_failure() {
        let root = tempdir().unwrap();
        let source = root.path().join("book.db");
        a_point(&source);
        let point = crate::recovery::take_point(&source, "book", "Book", &root.path().join("points"), 1_700_000_000_000).unwrap();
        let bundle = crate::backup_bundle::path_for(&root.path().join("points"), &point.id);
        let library = root.path().join("library");
        fs::create_dir(&library).unwrap();
        let occupied = library.join("book-recovered.pictures");
        fs::write(&occupied, b"keep").unwrap();
        let restored = restore_point_into(&bundle, &library, "book", 1_700_000_100_000).unwrap();
        assert!(restored.path.ends_with("book-recovered-2.db"));
        assert_eq!(fs::read(&occupied).unwrap(), b"keep");
        let err = restore_point_with(&bundle, &library, "other", 1_700_000_200_000, |_, dest| {
            fs::write(dest, b"partial").unwrap();
            Err("copy failed".into())
        }).unwrap_err();
        assert!(err.contains("copy failed"));
        assert!(!library.join("other-recovered.db").exists());
        assert!(!library.join("other-recovered.pictures").exists());
        assert_eq!(fs::read(&occupied).unwrap(), b"keep");

        let different = root.path().join("different.db");
        a_point(&different);
        let other = crate::store::Store::open(&different).unwrap();
        other.set_meta(NAME_KEY, "Different Book").unwrap();
        drop(other);
        let err = restore_point_with(&bundle, &library, "changed", 1_700_000_300_000, |_, dest| {
            fs::copy(&different, dest).unwrap();
            Ok(())
        }).unwrap_err();
        assert!(err.contains("differs from the verified point"), "{err}");
        assert!(!library.join("changed-recovered.db").exists());
        assert!(!library.join("changed-recovered.pictures").exists());
    }

    #[test]
    fn a_restore_creates_a_new_project_and_leaves_the_source_alone() {
        // The design's central refusal, asserted rather than described: the
        // point is not touched, and what appears is a NEW entry in the library.
        let dir = tempdir().unwrap();
        let point = dir.path().join("2026-08-21T09-00-00Z.db");
        a_point(&point);
        let before = fs::read(&point).unwrap();
        let library = dir.path().join("projects");

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000)
            .expect("a healthy point failed to restore");

        assert_eq!(
            fs::read(&point).unwrap(),
            before,
            "the restore wrote to the point it was reading"
        );
        assert_eq!(library_dbs(&library), vec!["my-book-recovered.db"]);
        assert!(summary.error.is_none(), "{:?}", summary.error);
        // It opens. A restore that produced a file no reader accepts would
        // satisfy every assertion above.
        assert!(crate::cli::validate(Path::new(&summary.path)).unwrap().ok);
    }

    #[test]
    fn a_restore_forks_its_identity_without_changing_the_copied_history() {
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        let store = crate::test_support::seeded_project(&point);
        let item = store.items().unwrap().remove(0);
        let entry = crate::store::FlushEntry {
            item_id: item.id.clone(),
            body: crate::test_support::body("A restored light remains."),
            base_rev: store.document_revs().unwrap()[&item.id],
            comments: None,
        };
        store.flush(&[entry.clone()]).unwrap();
        assert_eq!(store.record_versions(&[entry]).unwrap(), 1);
        store.snapshot_create("Before recovery").unwrap();
        let source_id = store.book_id().unwrap().unwrap();
        let source_body = store.load_doc(&item.id).unwrap().body;
        let source_versions = store.doc_versions(&item.id).unwrap().len();
        let source_snapshots = store.snapshots().unwrap().len();
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        let restored_words = store
            .word_index()
            .unwrap()
            .count_excluding(&excluded)
            .words;
        drop(store);

        let library = dir.path().join("projects");
        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000).unwrap();
        let source = Store::open_readonly(&point).unwrap();
        let restored = Store::open_readonly(Path::new(&summary.path)).unwrap();

        assert_eq!(source.book_id().unwrap().as_deref(), Some(source_id.as_str()));
        assert_ne!(restored.book_id().unwrap().as_deref(), Some(source_id.as_str()));
        assert_eq!(restored.load_doc(&item.id).unwrap().body, source_body);
        assert_eq!(restored.doc_versions(&item.id).unwrap().len(), source_versions);
        assert_eq!(restored.snapshots().unwrap().len(), source_snapshots);
        let source_words = restored.source_word_summary("2026-09-20").unwrap();
        assert_eq!(source_words.totals.restored.added, restored_words);
        assert_eq!(source_words.totals.unattributed.added, 0);
    }

    #[test]
    fn restore_sidecars_survive_an_injected_copy_failure() {
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");
        fs::create_dir(&library).unwrap();
        let candidate = library.join("my-book-recovered.db");
        let donor_path = dir.path().join("donor.db");
        let (_donor, files) = competing_creation_book(&donor_path);
        let mut originals = Vec::new();
        for (source, bytes) in files.into_iter().skip(1) {
            let target = candidate.with_extension(source.extension().unwrap());
            fs::write(&target, &bytes).unwrap();
            originals.push((target, bytes));
        }
        let error =
            restore_point_with(&point, &library, "my-book", 1_700_000_000_000, |_, dest| {
                fs::write(dest, b"partial owned copy").unwrap();
                Err("injected copy failure".into())
            })
            .unwrap_err();
        assert!(error.contains("injected copy failure"), "{error}");
        for (path, bytes) in originals {
            assert_eq!(
                fs::read(&path).unwrap(),
                bytes,
                "restore removed or changed {}",
                path.display()
            );
        }
        assert!(!candidate.exists());
        assert!(!library.join("my-book-recovered-2.db").exists());
        assert_eq!(fs::read_dir(&library).unwrap().count(), 2);
    }

    #[test]
    fn restore_sidecars_arriving_during_copy_are_preserved() {
        for fails in [false, true] {
            let dir = tempdir().unwrap();
            let point = dir.path().join("point.db");
            a_point(&point);
            let library = dir.path().join("projects");
            let candidate = library.join("my-book-recovered.db");
            let error = restore_point_with(
                &point,
                &library,
                "my-book",
                1_700_000_000_000,
                |source, dest| {
                    assert_ne!(dest, candidate, "SQLite must only copy into owned staging");
                    for extension in ["db-wal", "db-shm"] {
                        fs::write(candidate.with_extension(extension), extension.as_bytes())
                            .unwrap();
                    }
                    if fails {
                        fs::write(dest, b"partial copy").unwrap();
                        Err("injected copy failure".into())
                    } else {
                        copy_point(source, dest)
                    }
                },
            )
            .unwrap_err();
            assert!(
                error.contains(if fails {
                    "injected copy failure"
                } else {
                    "database sidecar"
                }),
                "{error}"
            );
            assert!(!candidate.exists());
            for extension in ["db-wal", "db-shm"] {
                assert_eq!(
                    fs::read(candidate.with_extension(extension)).unwrap(),
                    extension.as_bytes()
                );
            }
            assert_eq!(fs::read_dir(&library).unwrap().count(), 2);
        }
    }

    #[test]
    fn restore_sidecars_occupy_a_candidate_without_a_database() {
        for extension in ["db-wal", "db-shm"] {
            let dir = tempdir().unwrap();
            let point = dir.path().join("point.db");
            a_point(&point);
            let library = dir.path().join("projects");
            fs::create_dir(&library).unwrap();
            let candidate = library.join("my-book-recovered.db");
            let sidecar = candidate.with_extension(extension);
            fs::write(&sidecar, b"unrelated retained sidecar").unwrap();
            let restored =
                restore_point_into(&point, &library, "my-book", 1_700_000_000_000).unwrap();
            assert!(
                restored.path.ends_with("my-book-recovered-2.db"),
                "{}",
                restored.path
            );
            assert!(!candidate.exists());
            assert_eq!(fs::read(sidecar).unwrap(), b"unrelated retained sidecar");
            assert!(crate::cli::validate(Path::new(&restored.path)).unwrap().ok);
        }
    }

    #[test]
    fn a_restore_never_writes_over_an_existing_library_file() {
        // A REAL, READABLE PROJECT at the name the restore wants -- not an empty
        // file, which would also be refused by every path that merely fails to
        // open. This repo has the recorded rule that a refusal test whose input
        // would be refused anyway tests nothing.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");
        fs::create_dir_all(&library).unwrap();
        let occupied = library.join("my-book-recovered.db");
        a_point(&occupied);
        let untouched = fs::read(&occupied).unwrap();

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000)
            .expect("the restore refused instead of taking the next free name");

        assert_eq!(
            fs::read(&occupied).unwrap(),
            untouched,
            "the restore overwrote a project already in the library"
        );
        assert!(
            summary.path.ends_with("my-book-recovered-2.db"),
            "{}",
            summary.path
        );
    }

    #[test]
    fn a_restore_uses_the_local_free_ordinal_despite_external_matching_stems_and_forks_its_id() {
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let point_before = fs::read(&point).unwrap();
        let point_id = Store::open_readonly(&point).unwrap().book_id().unwrap().unwrap();
        let library = dir.path().join("projects");
        let elsewhere = tempdir().unwrap();
        let missing = elsewhere.path().join("my-book-recovered.db");
        let present = elsewhere.path().join("my-book-recovered-2.db");
        a_point(&present);
        let present_before = fs::read(&present).unwrap();

        let summary = restore_point_into(
            &point,
            &library,
            "my-book",
            1_700_000_000_000,
        )
        .expect("a local free recovery name to be restored");

        assert!(missing.ends_with("my-book-recovered.db"));
        assert!(summary.path.ends_with("my-book-recovered.db"), "{}", summary.path);
        assert_eq!(fs::read(&point).unwrap(), point_before);
        assert_eq!(fs::read(&present).unwrap(), present_before);
        let restored_id = Store::open_readonly(Path::new(&summary.path)).unwrap().book_id().unwrap().unwrap();
        assert_ne!(restored_id, point_id);
    }

    #[test]
    fn a_zero_byte_file_at_the_destination_does_not_become_the_restore() {
        // SQLite adopts a zero-byte destination rather than refusing it
        // (`vacuum_into_adopts_a_zero_byte_destination_rather_than_refusing_it`),
        // so this is the one shape where the copy primitive alone would write
        // over something the application did not put there.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");
        fs::create_dir_all(&library).unwrap();
        let claimed = library.join("my-book-recovered.db");
        fs::write(&claimed, b"").unwrap();

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000)
            .expect("a zero-byte neighbour blocked the restore entirely");

        assert_eq!(
            fs::metadata(&claimed).unwrap().len(),
            0,
            "the restore adopted a zero-byte file it did not create"
        );
        assert!(
            summary.path.ends_with("my-book-recovered-2.db"),
            "{}",
            summary.path
        );
    }

    #[test]
    fn a_restore_refuses_a_point_that_does_not_read() {
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        fs::write(&point, b"this is not a database").unwrap();
        let library = dir.path().join("projects");

        let err = restore_point_into(&point, &library, "my-book", 1_700_000_000_000)
            .expect_err("a file that is not a database restored successfully");

        assert!(!err.is_empty());
        assert!(
            library_dbs(&library).is_empty(),
            "a refused restore left a file in the library: {:?}",
            library_dbs(&library)
        );
    }

    #[test]
    fn a_restore_refuses_a_point_whose_structural_read_finds_damage() {
        // DISTINCT from the case above and the reason the check is
        // `cli::validate` rather than "did it open": this file opens fine. An
        // orphaned `doc` row is what `validate` reports as `orphan_doc`, and the
        // design is explicit that a point which opens but does not read clean is
        // reported as failed.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        {
            // `cli.rs`'s own `damage` helper, copied rather than reached for --
            // it lives in that file's `mod tests` and is not importable.
            let conn = rusqlite::Connection::open(&point).unwrap();
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            conn.execute_batch(
                "INSERT INTO doc VALUES ('nobody', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
            )
            .unwrap();
        }
        assert!(
            crate::store::Store::open_readonly(&point).is_ok(),
            "the fixture stopped opening, so this test no longer tests validation"
        );
        let library = dir.path().join("projects");

        restore_point_into(&point, &library, "my-book", 1_700_000_000_000)
            .expect_err("a point with an orphaned doc row restored as though healthy");

        assert!(library_dbs(&library).is_empty());
    }

    #[test]
    fn a_failed_restore_leaves_no_wal_or_shm_behind() {
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        fs::write(&point, b"not a database").unwrap();
        let library = dir.path().join("projects");

        let _ = restore_point_into(&point, &library, "my-book", 1_700_000_000_000);

        let leftovers: Vec<String> = fs::read_dir(&library)
            .map(|e| {
                e.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "a refused restore left {leftovers:?}");
    }

    #[test]
    fn the_restored_project_records_what_it_came_from_and_when() {
        // The design names this location specifically: the project's own `meta`
        // table, beside NAME_KEY/DAY_KEY. It is the authoritative answer to
        // "which point is this", which the file name only approximates.
        let dir = tempdir().unwrap();
        let point = dir.path().join("2026-08-21T09-00-00Z.db");
        a_point(&point);
        let library = dir.path().join("projects");

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000).unwrap();

        let store = crate::store::Store::open_readonly(Path::new(&summary.path)).unwrap();
        let from = store.get_meta(RECOVERED_FROM_KEY).unwrap().unwrap();
        assert_eq!(from, "2026-08-21T09-00-00Z.db", "{from}");
        assert_eq!(
            store.get_meta(RECOVERED_AT_KEY).unwrap().as_deref(),
            Some("1700000000000")
        );
    }

    /// The point below is a REAL absolute path under a temporary directory, so
    /// the assertion has something to fail against: before this fix, this row
    /// held `point.display()` whole, and `dir.path()` begins
    /// with the operating-system user's own directory.
    #[test]
    fn the_restored_project_does_not_record_the_directory_the_point_sat_in() {
        let dir = tempdir().unwrap();
        let recovery = dir.path().join("recovery").join("my-book");
        fs::create_dir_all(&recovery).unwrap();
        let point = recovery.join("2026-08-21T09-00-00Z.db");
        a_point(&point);
        let library = dir.path().join("projects");
        // The control: the fixture must genuinely carry a directory, or an
        // assertion about its absence is a fact about the fixture.
        assert!(
            point.parent().unwrap().is_absolute(),
            "the fixture point has no absolute directory to leave behind"
        );

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000).unwrap();

        let store = crate::store::Store::open_readonly(Path::new(&summary.path)).unwrap();
        let from = store.get_meta(RECOVERED_FROM_KEY).unwrap().unwrap();
        let directory = point.parent().unwrap().to_string_lossy().into_owned();
        assert!(
            !from.contains(&directory),
            "the recorded source names the directory it came from: {from}"
        );
        assert!(!from.starts_with('/'), "{from}");
    }

    #[test]
    fn a_recorded_recovery_source_is_a_file_name_and_never_a_directory() {
        // A path that genuinely carries a home directory, so the assertion can
        // fail: this is the exact shape the row held before the fix.
        let leaky = Path::new(
            "/home/writer/.local/share/garret/recovery/my-book/2026-08-21T09-00-00Z.db",
        );
        assert!(
            leaky.to_string_lossy().contains("/home/writer"),
            "the fixture carries no directory, so nothing here could fail"
        );
        assert_eq!(without_directory(leaky), "2026-08-21T09-00-00Z.db");
        // An ARCHIVE keeps the slug it was named with. That is the project's
        // own name, which this same file already holds under NAME_KEY, so the
        // file name discloses nothing the row beside it does not.
        assert_eq!(
            without_directory(Path::new("/mnt/usb/my-book-2026-08-21T09-00-00Z.db")),
            "my-book-2026-08-21T09-00-00Z.db"
        );
        // Idempotent, which is what lets the sweep run on every open.
        assert_eq!(
            without_directory(Path::new("2026-08-21T09-00-00Z.db")),
            "2026-08-21T09-00-00Z.db"
        );
    }

    #[test]
    fn recovery_sources_remove_windows_unc_and_mixed_directories() {
        for value in [
            r"C:\Users\writer\recovery\point.db",
            r"\\server\share\writer\recovery\point.db",
            r"C:\Users/writer\recovery/point.db",
            r"C:\Users\writer\recovery\point.db\",
        ] {
            assert_eq!(without_directory(Path::new(value)), "point.db", "{value}");
        }
        for value in [
            r"C:\Users\writer\.",
            r"C:\Users\writer\..",
            r"\\server\share\writer\.\",
            r"C:\Users/writer\../",
            r"\\",
        ] {
            assert_eq!(without_directory(Path::new(value)), "", "{value}");
        }
    }

    #[test]
    fn opening_for_writing_normalizes_windows_recovery_metadata() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        for recorded in [
            r"C:\Users\writer\recovery\point.db",
            r"\\server\share\writer\recovery\point.db",
            r"C:\Users/writer\recovery/point.db",
        ] {
            for existing_only in [false, true] {
                {
                    let store = Store::open(&db).unwrap();
                    store.set_meta(RECOVERED_FROM_KEY, recorded).unwrap();
                }
                let store = if existing_only {
                    open_existing_for_writing(&db).unwrap()
                } else {
                    open_for_writing(&db).unwrap()
                };
                assert_eq!(
                    store.get_meta(RECOVERED_FROM_KEY).unwrap().as_deref(),
                    Some("point.db")
                );
                assert!(!forget_recovery_directory(&store));
                drop(store);
                let store = Store::open_readonly(&db).unwrap();
                assert_eq!(
                    store.get_meta(RECOVERED_FROM_KEY).unwrap().as_deref(),
                    Some("point.db")
                );
            }
        }
    }

    #[test]
    fn a_recorded_source_ending_in_a_separator_is_still_one_component() {
        // `salvage` takes its destination from a command line, where
        // `recovered/` is what a shell's own completion offers. Taking the LAST
        // segment rather than the last NON-EMPTY one answers the empty string
        // for every such value, so the manifest would name no directory at all
        // -- and the one key whose whole job is to say which run this was would
        // be blank.
        assert_eq!(
            without_directory(Path::new("/home/writer/recovered/")),
            "recovered"
        );
        assert_eq!(without_directory(Path::new("recovered//")), "recovered");
    }

    #[test]
    fn a_sweep_that_cannot_write_says_so() {
        // The one input that tells `is_ok()` from `true`. A read-only handle
        // reads the row and refuses the write, which is exactly what a project
        // on a mounted-read-only disk does, and the answer must be "nothing was
        // rewritten" rather than a claim that it was.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            store
                .set_meta(RECOVERED_FROM_KEY, "/home/writer/recovery/point.db")
                .unwrap();
        }
        let store = Store::open_readonly(&db).unwrap();
        // The control: the row IS there and IS one this sweep wants to rewrite,
        // so a false answer here can only be the failed write.
        assert_eq!(
            store.get_meta(RECOVERED_FROM_KEY).unwrap().as_deref(),
            Some("/home/writer/recovery/point.db")
        );

        assert!(!forget_recovery_directory(&store));
    }

    #[test]
    fn a_recorded_source_with_no_final_component_names_nothing() {
        // `/home/writer/..` has no file name at all, and answering with the
        // input would put the home directory back through the one branch that
        // has no name to return. Nothing is the honest answer: a value naming
        // no file names no file.
        for value in ["/home/writer/..", "/home/writer/.", "/", ""] {
            assert_eq!(without_directory(Path::new(value)), "", "{value}");
        }
    }

    #[test]
    fn opening_a_project_restored_by_an_older_build_forgets_the_directory() {
        // The already-live leak: a project restored before the fix carries
        // the absolute path forever unless something rewrites it, and the fix
        // applying only to new writes would leave every existing copy leaking.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let store = Store::open(&db).unwrap();
        let leaky =
            "/home/writer/.local/share/garret/recovery/my-book/2026-08-21T09-00-00Z.db";
        store.set_meta(RECOVERED_FROM_KEY, leaky).unwrap();

        assert!(forget_recovery_directory(&store), "nothing was rewritten");

        assert_eq!(
            store.get_meta(RECOVERED_FROM_KEY).unwrap().as_deref(),
            Some("2026-08-21T09-00-00Z.db")
        );
    }

    #[test]
    fn opening_a_project_for_writing_forgets_the_directory() {
        // THE SEAM, and the reason there is one: both open paths call this, so
        // a project restored by an older build is swept by being opened and the
        // writer does nothing at all.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            store
                .set_meta(
                    RECOVERED_FROM_KEY,
                    "/home/writer/.local/share/garret/recovery/my-book/2026-08-21T09-00-00Z.db",
                )
                .unwrap();
        }

        let store = open_for_writing(&db).unwrap();

        assert_eq!(
            store.get_meta(RECOVERED_FROM_KEY).unwrap().as_deref(),
            Some("2026-08-21T09-00-00Z.db")
        );
    }

    #[test]
    fn the_sweep_writes_nothing_when_there_is_nothing_to_forget() {
        // Two states, and NEITHER may be written to: a row this build already
        // wrote, and a project that was never restored at all. A sweep that
        // wrote unconditionally would put a `recovered_from` row holding ""
        // into every project in the library on its next open.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let store = Store::open(&db).unwrap();

        assert!(
            !forget_recovery_directory(&store),
            "a project never restored"
        );
        assert_eq!(store.get_meta(RECOVERED_FROM_KEY).unwrap(), None);

        store
            .set_meta(RECOVERED_FROM_KEY, "2026-08-21T09-00-00Z.db")
            .unwrap();
        assert!(!forget_recovery_directory(&store), "a row already swept");
        assert_eq!(
            store.get_meta(RECOVERED_FROM_KEY).unwrap().as_deref(),
            Some("2026-08-21T09-00-00Z.db")
        );
    }

    #[test]
    fn the_restored_project_does_not_carry_the_original_name() {
        // The switcher renders NAME_KEY. Copying the point verbatim would put
        // two rows reading "My Book" in the library, and the writer choosing
        // between two real states of their book could not tell which is which.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000).unwrap();

        assert_eq!(summary.name, "My Book (recovered)");
    }

    /// A GENUINE older-schema project: v1's DDL and `user_version = 1`, not a
    /// current file with the pragma lowered. Copied from `cli.rs`'s own v1
    /// fixture, which exists to prove the read subcommands do not migrate.
    fn a_v1_point(at: &Path) {
        let conn = rusqlite::Connection::open(at).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE item (
               id TEXT PRIMARY KEY, parent_id TEXT REFERENCES item(id),
               type TEXT NOT NULL, title TEXT NOT NULL, position TEXT NOT NULL,
               rev INTEGER NOT NULL DEFAULT 1);
             CREATE UNIQUE INDEX item_sibling ON item(parent_id, position);
             CREATE UNIQUE INDEX item_root_sibling ON item(position) WHERE parent_id IS NULL;
             CREATE TABLE doc (
               item_id TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
               body TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO meta VALUES ('project_name', 'Old Book');
             INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('i1', NULL, 'scene', 'Only', '0000', 1);
             INSERT INTO doc VALUES ('i1', '{\"type\":\"doc\",\"content\":[]}', 1, 0);
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }

    fn user_version(db: &Path) -> i64 {
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn copying_a_point_does_not_migrate_it() {
        // A FORWARD GUARD, and it needs an old schema to have anything to say.
        // Every recovery point in existence today is v5, because points began
        // with the schema already there -- so `Store::open` and
        // `Store::open_readonly` behave identically on every real one, and no
        // fixture at the current version can tell them apart. The day a v6
        // migration lands, `open` here would silently upgrade the one artifact
        // this whole feature exists to keep intact.
        let dir = tempdir().unwrap();
        let point = dir.path().join("old-point.db");
        a_v1_point(&point);
        assert_eq!(user_version(&point), 1, "the fixture must start at v1");
        let dest = dir.path().join("copy.db");

        copy_point(&point, &dest).unwrap();

        assert_eq!(
            user_version(&point),
            1,
            "the copy migrated the point it was reading"
        );
        // The copy is verbatim. Migrating it is the job of the read-write open
        // that follows, and it lands on the copy alone.
        assert_eq!(user_version(&dest), 1);
    }

    #[test]
    fn a_copy_that_fails_leaves_nothing_in_the_library() {
        // The cleanup path was UNREACHABLE from any test: validation runs before
        // the claim, so every failure a fixture could produce happened before
        // there was a file to clean up. A guard nothing can reach is worse than
        // none, and the failure it defends against -- ENOSPC part-way through a
        // copy -- is exactly the one that left a truncated manuscript in the
        // exports directory once already.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");

        let err = restore_point_with(&point, &library, "my-book", 1_700_000_000_000, |_, dest| {
            fs::write(dest, b"partial owned database").unwrap();
            fs::write(dest.with_extension("db-wal"), b"owned partial log").unwrap();
            fs::write(
                dest.with_extension("db-shm"),
                b"owned partial shared memory",
            )
            .unwrap();
            Err("no space left on device".to_string())
        })
        .expect_err("a failed copy reported success");

        assert!(err.contains("no space left on device"), "{err}");
        let leftovers: Vec<String> = fs::read_dir(&library)
            .map(|e| {
                e.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "a failed copy left {leftovers:?} in the library"
        );
    }

    #[test]
    fn the_restored_name_comes_from_the_point_itself() {
        // The manifest is a describing file, read leniently, and can disagree
        // with the manuscript it describes. `describe_dir` settled the same
        // argument one level up -- the artifact on disk wins over the memory of
        // it -- and here the point file is the artifact.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");

        let summary = restore_point_into(
            &point,
            &library,
            "whatever-the-caller-thinks",
            1_700_000_000_000,
        )
        .unwrap();

        assert_eq!(summary.name, "My Book (recovered)");
    }

    #[test]
    fn a_point_that_never_recorded_a_name_falls_back_to_its_stem() {
        // `summarize` already falls back to the file stem for a project with no
        // NAME_KEY. A restore must not invent a name that says less than that.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_nameless_point(&point);
        let library = dir.path().join("projects");

        let summary = restore_point_into(&point, &library, "my-book", 1_700_000_000_000).unwrap();

        assert_eq!(summary.name, "my-book (recovered)");
    }

    #[test]
    fn the_first_restore_takes_the_bare_recovered_name() {
        assert_eq!(restored_stem("my-novel", 1), "my-novel-recovered");
    }

    #[test]
    fn an_ordinal_lands_after_the_suffix_not_inside_it() {
        assert_eq!(restored_stem("my-novel", 2), "my-novel-recovered-2");
        assert_eq!(restored_stem("my-novel", 11), "my-novel-recovered-11");
    }

    #[test]
    fn a_stem_at_the_slug_cap_is_truncated_before_the_suffix() {
        // THE STEM YIELDS, NEVER THE SUFFIX. A name that has lost its
        // "-recovered" is a lie about what the file is, and the whole point of
        // the naming rule is that a writer can tell the two entries apart.
        // LONGER THAN THE CAP, not exactly at it. At exactly SLUG_MAX the
        // correct rule and a rule that truncates AFTER appending produce the
        // same 64 characters, so the fixture agreed with its own mutation --
        // this repo's recorded shape for a test named after a property it does
        // not test.
        let long = "a".repeat(SLUG_MAX + 40);
        let stem = restored_stem(&long, 1);
        assert!(
            stem.ends_with("-recovered"),
            "the suffix was truncated instead of the stem: {stem}"
        );
        assert!(
            stem.len() <= SLUG_MAX,
            "the first restored name is over the cap: {} chars",
            stem.len()
        );
    }

    #[test]
    fn a_truncated_stem_does_not_end_in_a_hyphen_before_the_suffix() {
        // `slugify` carries the same correction and for the same reason: the
        // cap can land mid-gap, and "my-novel--recovered" is a name nobody
        // wrote.
        let long = format!("{}-x", "a".repeat(SLUG_MAX - "-recovered".len() - 1));
        let stem = restored_stem(&long, 1);
        assert!(
            !stem.contains("--"),
            "the truncation left a doubled hyphen: {stem}"
        );
    }

    #[test]
    fn a_multibyte_stem_over_the_cap_is_cut_at_a_character_boundary() {
        // A stem reaching this through APP_PROJECT is whatever the filesystem
        // accepted. Truncating at a raw byte index would panic and take the
        // command with it.
        let long = "\u{00e9}".repeat(SLUG_MAX);
        let stem = restored_stem(&long, 1);
        assert!(stem.ends_with("-recovered"), "{stem}");
    }

    #[test]
    fn the_first_restored_name_says_recovered_once() {
        assert_eq!(restored_name("My Novel", 1), "My Novel (recovered)");
    }

    #[test]
    fn the_ordinal_and_the_displayed_name_agree() {
        // The switcher renders NAME_KEY and not the file stem, so a name that
        // did not track the path's ordinal would put two rows reading "My Novel
        // (recovered)" in the library -- which is exactly the confusion "the
        // writer decides, looking at both" cannot survive.
        assert_eq!(restored_name("My Novel", 2), "My Novel (recovered 2)");
        assert_eq!(restored_name("My Novel", 7), "My Novel (recovered 7)");
    }

    #[test]
    fn a_gap_in_the_ordinals_is_reused_and_that_is_fine() {
        // The OPPOSITE of `pick_export_path`, deliberately. Exports sort by
        // filename, so filling a gap would put an older export after a newer
        // one; the library sorts by MODIFICATION TIME, so a reused ordinal
        // misorders nothing. Driven through the real restore because the claim
        // loop is where the ordinals are walked.
        let dir = tempdir().unwrap();
        let point = dir.path().join("point.db");
        a_point(&point);
        let library = dir.path().join("projects");
        fs::create_dir_all(&library).unwrap();
        a_point(&library.join("n-recovered.db"));
        a_point(&library.join("n-recovered-3.db"));

        let summary = restore_point_into(&point, &library, "n", 1_700_000_000_000).unwrap();

        assert!(
            summary.path.ends_with("n-recovered-2.db"),
            "{}",
            summary.path
        );
        assert_eq!(summary.name, "My Book (recovered 2)");
    }

    #[test]
    fn the_recovery_directory_sits_beside_the_library() {
        let home = Path::new("/home/w/.local/share");
        assert_eq!(
            recovery_dir(home, "my-book"),
            home.join("garret").join("recovery").join("my-book")
        );
        // Per project, not one shared directory: retention is per book and a
        // shared directory would thin one manuscript's points against
        // another's.
        assert_ne!(recovery_dir(home, "a"), recovery_dir(home, "b"));
    }

    #[test]
    fn the_mirror_directory_is_the_applications_own_unless_it_is_overridden() {
        let home = Path::new("/home/w/.local/share");
        assert_eq!(
            mirror_dir(home, None, "my-book"),
            Path::new("/home/w/.local/share/garret/mirror/my-book")
        );
        // BESIDE the recovery area, never inside it: `recovery/` is an
        // application-owned area the writer is not invited into, and a mirror
        // is a folder of their own manuscript.
        assert!(!mirror_dir(home, None, "my-book").starts_with(recovery_dir(home, "my-book")));
    }

    #[test]
    fn an_override_still_gets_the_slug_appended() {
        // Without the slug, an operator pointing two projects at one directory
        // has them overwrite each other's files one item at a time, silently --
        // and the ids in the front matter would make the result look coherent.
        let home = Path::new("/home/w/.local/share");
        let over = Path::new("/home/w/Sync/manuscripts");
        assert_eq!(
            mirror_dir(home, Some(over), "my-book"),
            Path::new("/home/w/Sync/manuscripts/my-book")
        );
        assert_ne!(
            mirror_dir(home, Some(over), "my-book"),
            mirror_dir(home, Some(over), "other-book")
        );
    }

    #[test]
    fn the_archive_directory_is_a_child_of_the_recovery_one_and_not_the_same_directory() {
        // BOTH halves of this are load-bearing. Inside `recovery/<slug>/`,
        // because the design puts the archive in "the same `recovery/` area".
        // NOT the same directory, because `manifest_path` is one fixed
        // `manifest.json` per directory: an archive described in the recovery
        // manifest would be offered by `verified_points` as a restorable
        // recovery point and counted by `describe_dir` as same-device
        // coverage, which is the exact blur the design's section 6 forbids.
        let home = Path::new("/home/w/.local/share");
        assert_eq!(
            archives_dir(home, "my-book"),
            recovery_dir(home, "my-book").join("archives")
        );
        assert_ne!(archives_dir(home, "my-book"), recovery_dir(home, "my-book"));
        assert_ne!(archives_dir(home, "a"), archives_dir(home, "b"));
    }
}
