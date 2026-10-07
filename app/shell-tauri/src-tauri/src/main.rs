// app/shell-tauri/src-tauri/src/main.rs
// Tauri 2 host. Assets are served at RUNTIME from APP_DIST over a custom
// `appdist://` scheme: a frontendDist path would embed a build-time directory
// and ignore per-run staging. The window is built in code so its
// initialization_script installs host values before any page script runs.
// WebKitGTK webview => no CDP, matching the measured scope.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

mod data_migration;
mod command_error;
mod core_constants;
mod book_open;
mod backup_bundle;
mod cli;
mod close_state;
mod commands;
mod covers;
mod design;
mod design_transfer;
mod docx;
mod docx_import;
mod encrypted_archive;
mod epub;
mod export;
mod find;
mod identity;
mod import;
#[cfg(unix)]
mod instance;
#[cfg(any(windows, test))]
mod instance_file;
mod mirror;
mod mirror_wordlist;
mod mirror_identity;
mod package_format;
mod pdf;
mod pictures;
mod printer;
#[cfg(windows)]
mod printer_windows;
mod privacy;
mod privacy_host;
#[cfg(target_os = "linux")]
mod privacy_native;
#[cfg(windows)]
mod privacy_windows;
#[cfg(windows)]
mod privacy_windows_file;
#[cfg(target_os = "linux")]
mod privacy_lifecycle;
mod projects;
mod protection;
mod recovery;
mod research;
mod review_document;
mod review_docx;
mod review_validation;
mod review_salvage;
mod row_scan;
mod replace;
mod salvage;
mod store;
mod strings;
mod validation;
mod transfer_copy;
mod transfer_publish;
#[cfg(test)]
mod test_support;
mod words;
mod warning_history;
mod zoom;

#[command_boundary::command]
fn sink(payload: serde_json::Value) {
    let path = std::env::var("APP_SINK").unwrap_or_else(|_| "sink.json".into());
    let _ = fs::write(&path, serde_json::to_string(&payload).unwrap_or_default());
    // Stay alive so the harness can snapshot the AT-SPI tree while the window
    // is up; the harness kills us once it has the snapshot. Self-exit is a
    // safety net if it never does.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(120));
        process::exit(0);
    });
}

struct OpenProject {
    store: store::Store,
    book_id: String,
    registry_home: Option<PathBuf>,
    path: PathBuf,
    name: String,
    /// Monotonic, bumped on every open. Carried by the page and checked by
    /// doc_flush, so a flush that belongs to a superseded project is refused
    /// rather than applied to a same-named row in a different file.
    generation: u64,
    /// Optional observation lifetime belongs to this particular open.
    analytics: Option<store::analytics::Runtime>,
    tracking_on: bool,
    /// This project's word counts, per document, with the running total.
    ///
    /// A FIELD OF THE OPEN PROJECT, deliberately, and not a separate piece of
    /// managed state: it is built when this value is built and dropped when this
    /// value is replaced, so a switch cannot carry the previous manuscript's
    /// total into the next one's project bar. Two things in this codebase have
    /// already outlived a teardown they belonged to -- a flush scheduler holding
    /// a callback into a store whose rows its ids no longer described, and an
    /// outline operation resolving into a dead project's row index -- and both
    /// were separate lifetimes that had to be torn down by hand. This one has no
    /// teardown to forget.
    words: store::WordIndex,
    /// The ids of everything that is NOT the book, cached from the last walk:
    /// the Trash bin's subtree and the bible's, as ONE set.
    ///
    /// ONE SET RATHER THAN TWO. Every reader of this asks the same question, and
    /// the answer is read after every accepted flush -- so two sets would mean
    /// either a union allocated on the keystroke path or two `contains` calls at
    /// each call site, and the second is how one of them gets forgotten. The
    /// distinction the product does make (search keeps the bible and labels it;
    /// export and the mirror do not) is drawn at those call sites, from the
    /// walk, not here.
    ///
    /// A FIELD for the same lifetime reason `words` is, and CACHED rather than
    /// recomputed per count because the count is read after every accepted
    /// flush. Recomputing it there would put a walk of the whole tree back on
    /// the keystroke path, which is the exact shape of the recorded regression
    /// where a per-flush O(manuscript) scan cost measurable typing latency and
    /// every scalar gate stayed green.
    ///
    /// Refreshed only when the TREE changes -- and tree mutations are already
    /// off the keystroke path.
    excluded: std::collections::HashSet<String>,
}

impl OpenProject {
    /// Recompute the excluded set from the store. Called after a tree mutation,
    /// never after a flush: a flush cannot move an item.
    fn refresh_excluded(&mut self) {
        // A walk that fails leaves the previous set in place rather than
        // clearing it. Clearing would silently return every deleted word to the
        // project total on a transient read error, and a wrong number a writer
        // cannot distinguish from a right one is worse than a stale one.
        if let Ok(items) = self.store.items() {
            self.excluded = store::excluded_from_book(&items);
        }
    }

    /// The project total, with deleted and bible documents excluded.
    fn word_count(&self) -> store::WordCount {
        self.words.count_excluding(&self.excluded)
    }

    /// The same figures per item, with the same documents excluded, so the two
    /// answers cannot disagree about what the manuscript holds.
    fn word_counts(&self) -> std::collections::HashMap<String, u64> {
        self.words.counts_excluding(&self.excluded)
    }

    /// The statistics panel's sparse per-document projection. Unlike the
    /// periodic word map, this is read only after an explicit panel or export
    /// drain, so its three fields travel together in one host read.
    fn document_counts(&self) -> std::collections::HashMap<String, store::DocumentCounts> {
        self.words.document_counts_excluding(&self.excluded)
    }
}

struct StoreState(Mutex<Option<OpenProject>>);

/// The library directory this process owns, resolved once at startup.
struct Library(PathBuf);

/// `<data_home>`, kept for settings reads and writes.
struct DataHome(PathBuf);

/// Writer-facing host strings are resolved once at startup. Preferences say a
/// locale change takes effect on the next start, so command routes must not
/// re-read mutable settings while this process is running.
pub(crate) struct HostStrings(pub(crate) strings::Strings);

/// A mirror pass is owed and its pending state has been surfaced to the page.
///
/// `.0` is the work a scheduler may claim. `.1` holds the `updating` state
/// until the current pass completes, coalescing repeated saves while a pass is
/// owed or in flight.
struct MirrorDirty(std::sync::atomic::AtomicBool, std::sync::atomic::AtomicBool);

/// What the last mirror pass did, so the indicator can report it.
///
/// A Mutex rather than an atomic (which is what `MirrorDirty` gets away with)
/// because this is three fields that must agree: reporting `last_ok = false`
/// beside a cleared `last_error` would give the `failing` state nothing to
/// name, and the design requires it to name the cause.
struct MirrorState(std::sync::Mutex<mirror::PassOutcome>);

struct MirrorPreviewTicket {
    token: String,
    path: PathBuf,
    book_id: String,
    generation: u64,
    dir: PathBuf,
    digest: [u8; 32],
}

struct MirrorPreviewState(std::sync::Mutex<Option<MirrorPreviewTicket>>);

fn preview_owner_matches(ticket: &MirrorPreviewTicket, current: &MirrorContext, token: Option<&str>) -> bool {
    token == Some(ticket.token.as_str())
        && current.generation == ticket.generation
        && current.path == ticket.path
        && current.book_id == ticket.book_id
}

fn preview_content_matches(ticket: &MirrorPreviewTicket, dir: &Path, digest: [u8; 32]) -> bool {
    ticket.dir == dir && ticket.digest == digest
}

/// Entry ids with a pending inbound change, which the mirror pass must not
/// overwrite.
///
/// PER ENTRY, never per project (C2). A writer who edits one scene outside the
/// application keeps getting mirror updates for every other scene they type;
/// modelling this as "stop the mirror" would read as a broken mirror rather
/// than a paused one, and would be a different sentence in the indicator.
///
/// Populated by the scan. EMPTY until then, and an empty set means the pass
/// behaves exactly as it did before this existed.
type PauseIds = std::collections::HashSet<String>;
type PauseHandle = std::sync::Arc<std::sync::Mutex<PauseIds>>;

struct MirrorPauseState {
    current: PauseHandle,
    /// Weak entries only. A project remains here while it is current or work
    /// captured for it is still alive; dead entries are pruned on every switch,
    /// so this cannot grow into a library-sized project map.
    live: std::collections::HashMap<String, std::sync::Weak<std::sync::Mutex<PauseIds>>>,
}

impl MirrorPauseState {
    fn new(book_id: Option<&str>) -> Self {
        let current = std::sync::Arc::new(std::sync::Mutex::new(PauseIds::new()));
        let mut live = std::collections::HashMap::new();
        if let Some(book_id) = book_id {
            live.insert(book_id.to_string(), std::sync::Arc::downgrade(&current));
        }
        Self { current, live }
    }

    fn select(&mut self, book_id: &str) -> PauseHandle {
        self.live.retain(|_, handle| handle.strong_count() > 0);
        let next = self
            .live
            .get(book_id)
            .and_then(std::sync::Weak::upgrade)
            .unwrap_or_else(|| std::sync::Arc::new(std::sync::Mutex::new(PauseIds::new())));
        self.live
            .insert(book_id.to_string(), std::sync::Arc::downgrade(&next));
        self.current = next.clone();
        next
    }
}

/// The pause lifetime selected for the open project.
struct MirrorPaused(std::sync::Mutex<MirrorPauseState>);

/// Held for the whole of a mirror pass, so the watcher cannot scan mid-write.
///
/// A pass writes every changed file and THEN the manifest. A scan that ran
/// between the two would compare the new files against the old manifest, decide
/// the application's own writes were external edits, and pause the entries it
/// had just written -- which stops those scenes being maintained, silently,
/// until the next open.
///
/// A `Mutex<()>` rather than a flag because the exclusion is what is wanted,
/// not the reading of it: the watcher `try_lock`s and waits its turn, and the
/// pass path never contends with anything but that.
struct MirrorPassing(std::sync::Mutex<()>);

/// Read the outcome, treating a poisoned lock as "nothing recorded".
///
/// `locked`'s rule: a panicked writer must not make the status surface
/// unrenderable. A default outcome reads as "never run", which is the honest
/// answer when the record is unreadable.
fn last_outcome(state: &State<'_, MirrorState>) -> mirror::PassOutcome {
    state.0.lock().map(|g| g.clone()).unwrap_or_default()
}

#[derive(Clone)]
struct MirrorContext {
    path: PathBuf,
    book_id: String,
    registry_home: Option<PathBuf>,
    name: String,
    generation: u64,
    paused: PauseHandle,
}

/// Capture one project's path and pause lifetime under the same short store
/// guard. Callers may then wait for `MirrorPassing` and walk the directory
/// without blocking saves or accidentally borrowing the next project's set.
fn mirror_context(state: &StoreState, paused: &MirrorPaused) -> Option<MirrorContext> {
    let guard = locked(state);
    let project = guard.as_ref()?;
    let paused = paused_handle(paused)?;
    Some(MirrorContext {
        path: project.path.clone(),
        book_id: project.book_id.clone(),
        registry_home: project.registry_home.clone(),
        name: project.name.clone(),
        generation: project.generation,
        paused,
    })
}

/// Claim the current project's pending pass. `doc_flush` sets dirty while it
/// holds `StoreState`, and project open clears it under that same guard, so the
/// captured path and the cleared bit always describe one project.
fn take_dirty_mirror_context(
    state: &StoreState,
    paused: &MirrorPaused,
    dirty: &MirrorDirty,
) -> Option<MirrorContext> {
    let guard = locked(state);
    if !dirty.0.swap(false, Ordering::Relaxed) {
        return None;
    }
    let project = guard.as_ref()?;
    let paused = paused_handle(paused)?;
    Some(MirrorContext {
        path: project.path.clone(),
        book_id: project.book_id.clone(),
        registry_home: project.registry_home.clone(),
        name: project.name.clone(),
        generation: project.generation,
        paused,
    })
}

/// Mark a committed change pending. Called while `StoreState` is held; the
/// caller emits after dropping that guard only when this returns true.
fn mark_mirror_dirty(dirty: &MirrorDirty) -> bool {
    dirty.0.store(true, Ordering::Relaxed);
    !dirty.1.swap(true, Ordering::Relaxed)
}

fn mirror_pending(dirty: &MirrorDirty) -> bool {
    dirty.0.load(Ordering::Relaxed) || dirty.1.load(Ordering::Relaxed)
}

/// Reset a toggle or project switch only while its captured project still owns
/// the state. A same-path reopen retains work already owed; if a prior pass
/// had claimed it, the latch re-arms that work for the new generation.
fn reset_mirror_dirty_if_current(
    state: &StoreState,
    paused: &MirrorPaused,
    dirty: &MirrorDirty,
    context: &MirrorContext,
) -> bool {
    let guard = locked(state);
    let same_open = guard
        .as_ref()
        .is_some_and(|project| project.generation == context.generation);
    let same_pauses = paused_handle(paused)
        .is_some_and(|handle| std::sync::Arc::ptr_eq(&handle, &context.paused));
    if same_open && same_pauses {
        dirty.0.store(false, Ordering::Relaxed);
        dirty.1.store(false, Ordering::Relaxed);
        true
    } else {
        false
    }
}

/// Start a current book's visible interval; emit only if it was not pending.
fn begin_mirror_pass_if_current(
    state: &StoreState,
    paused: &MirrorPaused,
    dirty: &MirrorDirty,
    context: &MirrorContext,
) -> bool {
    let guard = locked(state);
    let same_open = guard
        .as_ref()
        .is_some_and(|project| project.generation == context.generation);
    let same_pauses = paused_handle(paused)
        .is_some_and(|handle| std::sync::Arc::ptr_eq(&handle, &context.paused));
    if same_open && same_pauses {
        !dirty.1.swap(true, Ordering::Relaxed)
    } else {
        false
    }
}

/// Finish an enabled pass while `MirrorPassing` is still held. A stale pass
/// cannot alter either the current outcome or the new project's latch.
fn finish_mirror_pass(
    state: &StoreState,
    paused: &MirrorPaused,
    dirty: &MirrorDirty,
    outcome: &MirrorState,
    context: &MirrorContext,
    result: std::result::Result<(), String>,
    now: i64,
) -> bool {
    let guard = locked(state);
    let same_open = guard
        .as_ref()
        .is_some_and(|project| project.generation == context.generation);
    let same_pauses = paused_handle(paused)
        .is_some_and(|handle| std::sync::Arc::ptr_eq(&handle, &context.paused));
    if !same_open || !same_pauses {
        return false;
    }
    if let Ok(mut recorded) = outcome.0.lock() {
        recorded.record(result, now);
    }
    dirty.1.store(dirty.0.load(Ordering::Relaxed), Ordering::Relaxed);
    true
}

/// Read the paused set, treating a poisoned lock as EMPTY.
///
/// `last_outcome`'s leniency, and the direction is chosen deliberately: an
/// unreadable pause set must not stop the mirror, because a mirror that stopped
/// silently is the staleness this feature exists to prevent. The cost of the
/// other direction -- overwriting a pending edit -- is why the lock is only
/// ever held to clone, so a panic while holding it is not a path that exists.
fn paused_handle(state: &MirrorPaused) -> Option<PauseHandle> {
    state.0.lock().ok().map(|state| state.current.clone())
}

fn paused_ids(handle: &PauseHandle) -> PauseIds {
    handle.lock().map(|g| g.clone()).unwrap_or_default()
}

/// Install what a scan found as the pause set, reporting whether it moved.
///
/// REPLACES, never merges. The pause set describes files in ONE project's
/// mirror folder, and a switch that carried the previous project's ids would
/// pause scenes nobody touched -- silently, and for as long as the window stays
/// open, because a paused entry stops being maintained.
///
/// `changed` ONLY. `deleted_outside` is reported so 021 can show it and is
/// deliberately not paused: overwriting an external edit is the failure this
/// exists to prevent, and rewriting a file the writer deleted destroys nothing.
///
/// The bool is what decides the emit. An open over a mirror nobody touched must
/// be silent, or the page is told a state changed on every open and cannot tell
/// that apart from a real change.
fn install_paused(
    paused: &std::sync::Mutex<std::collections::HashSet<String>>,
    found: &mirror::DetectReport,
) -> bool {
    let next: std::collections::HashSet<String> = found.changed.iter().cloned().collect();
    let Ok(mut guard) = paused.lock() else {
        // `paused_ids`' direction, for its reason: an unreadable pause set must
        // not stop the mirror, and it must not stop the scan from being
        // reported as "nothing to say" either.
        return false;
    };
    if *guard == next {
        return false;
    }
    *guard = next;
    true
}

/// Install every finding before surfacing a durable-record failure.
///
/// A scan may discover an external edit and then fail to write its pause
/// record. Dropping that report on the error path would leave both RAM and disk
/// unaware of the edit, so a following writer could overwrite it.
fn install_detect_result(
    paused: &PauseHandle,
    result: std::result::Result<mirror::DetectReport, mirror::DetectFailure>,
) -> (mirror::DetectReport, Option<String>, bool) {
    let (found, error) = match result {
        Ok(found) => (found, None),
        Err(failure) => (failure.found, Some(failure.error)),
    };
    let moved = install_paused(paused, &found);
    (found, error, moved)
}

fn detect_mirror(
    dir: &Path,
    paused: &PauseHandle,
) -> (mirror::DetectReport, Option<String>, bool) {
    install_detect_result(paused, mirror::detect_and_persist(dir, &paused_ids(paused)))
}

/// The resolved `APP_MIRROR_DIR`, read ONCE at startup.
///
/// `APP_RECOVERY_MODE`'s discipline: reading the environment from a command
/// handler would be too late and would make every path here untestable without
/// mutating process-global state.
struct MirrorRoot(Option<PathBuf>);

/// APP_PROJECT as captured at startup. Captured rather than re-read per command
/// so a command cannot see a different value than the one that was opened.
struct ExplicitProject(Option<PathBuf>);

/// Whether a clean close takes a recovery point, decided once at startup.
///
/// Captured for the reason `ExplicitProject` is: the schedule thread read the
/// knob at launch, and a close that re-read the environment could disagree with
/// the timer it is meant to share a rule with.
struct ClosePoint(bool);

#[derive(serde::Serialize)]
struct ProjectOpened {
    path: String,
    name: String,
    generation: u64,
}

const NO_PROJECT: &str = "no project is open";

// A poisoned lock means a previous command panicked mid-Store operation, so
// the connection's transaction state is untrusted. Tauri catches command
// panics, so relying on unwind to stop the process would instead leave a
// dead persistence layer behind a live window.
fn locked(state: &StoreState) -> std::sync::MutexGuard<'_, Option<OpenProject>> {
    match state.0.lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("store mutex poisoned by an earlier panic; exiting rather than serving a store in unknown state");
            process::exit(1);
        }
    }
}

/// Every store-touching command goes through this, so "nothing is open" is an
/// error the page can render rather than a panic behind a live window.
fn open_project(guard: &Option<OpenProject>) -> std::result::Result<&OpenProject, String> {
    guard.as_ref().ok_or_else(|| NO_PROJECT.to_string())
}

/// The same, for the two commands that also have to move the word index forward.
fn open_project_mut(
    guard: &mut Option<OpenProject>,
) -> std::result::Result<&mut OpenProject, String> {
    guard.as_mut().ok_or_else(|| NO_PROJECT.to_string())
}

/// A flush carries item ids and base_rev values that only mean something inside
/// the project they were read from. Two projects seeded from the same generator
/// share item ids outright, so a stale flush would land on a real row in the
/// wrong manuscript with no type error and no store error.
fn accepts_generation(current: u64, claimed: u64) -> bool {
    current == claimed
}

#[command_boundary::command]
fn project_items(state: State<'_, StoreState>) -> std::result::Result<Vec<store::Item>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .items()
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
fn doc_load(
    state: State<'_, StoreState>,
    item_id: String,
) -> std::result::Result<store::Doc, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .load_doc(&item_id)
        .map_err(|e| e.to_string())
}

/// A flush against one open project: the generation check, the store write, and
/// the word index's delta, in that order and only in that order.
///
/// Split out of the command so the ORDER is testable without a Tauri runtime,
/// because the order is the whole correctness argument:
///
///  - A refused generation returns before the store is touched, so the index is
///    not touched either. An index moved by a flush the store rejected would
///    describe a manuscript that does not exist.
///  - `Store::flush` is one transaction and rolls the entire batch back on any
///    conflict, so a mid-batch failure leaves the store as it was -- and `?`
///    here leaves the index as it was, on the same line.
///  - The delta is applied from the SAME entries the store committed, after it
///    committed them.
#[cfg(test)]
fn flush_into(
    project: &mut OpenProject,
    entries: &[store::FlushEntry],
    generation: u64,
) -> std::result::Result<Vec<store::FlushAck>, String> {
    flush_into_with_sources(project, entries, generation, &[])
}

fn flush_into_with_sources(
    project: &mut OpenProject,
    entries: &[store::FlushEntry],
    generation: u64,
    sources: &[store::source_words::FlushAttribution],
) -> std::result::Result<Vec<store::FlushAck>, String> {
    if !accepts_generation(project.generation, generation) {
        return Err(format!(
            "flush belongs to project generation {generation}; generation {} is open",
            project.generation
        ));
    }
    let acks = project.store.flush_with_sources_and_session(
        entries, sources, project.analytics.as_ref(), project.tracking_on,
    ).map_err(|e| e.to_string())?;
    // A timeline's flushed body is JSON but never a ProseMirror document, so
    // handing it to `record` would fail the parse and count a healthy
    // document as a corrupt one -- `word_index`'s own fresh scan already
    // excludes the type by a SQL join; this is the incremental path's
    // equivalent, since `apply_flush` sees only bodies, never types. Carried
    // in from an earlier review: a flusher over a timeline did not exist yet when
    // that scan-side exclusion was written, so nothing had exercised this arm.
    let counted: Vec<store::FlushEntry> = entries
        .iter()
        .filter(|e| {
            !matches!(
                project.store.item_type(&e.item_id),
                Ok(Some(t)) if t == store::TIMELINE_TYPE
            )
        })
        .cloned()
        .collect();
    project.words.apply_flush(&counted);
    // History is recorded AFTER the prose is durable, and a failure here is
    // reported on stderr rather than returned. The flush succeeded: the
    // writer's words are in the file. Turning a lost version into a failed save
    // would raise the one banner that means "editing is paused" over a save
    // that actually happened, which is worse than the thing it reports.
    //
    // The cheap path -- every flush not at a version boundary -- is one indexed
    // SELECT per entry with no transaction and no fsync. See
    // store::history::record_versions.
    if let Err(e) = project.store.record_versions(entries) {
        eprintln!("history: could not record a version: {e}");
    }
    Ok(acks)
}

#[command_boundary::command]
fn doc_flush(
    window: tauri::Window,
    state: State<'_, StoreState>,
    dirty: State<'_, MirrorDirty>,
    entries: Vec<store::FlushEntry>,
    sources: Option<serde_json::Value>,
    generation: u64,
) -> std::result::Result<Vec<store::FlushAck>, String> {
    let sources: Vec<store::source_words::FlushAttribution> = sources
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let (acks, emit) = {
        let mut guard = locked(&state);
        let acks = flush_into_with_sources(open_project_mut(&mut guard)?, &entries, generation, &sources)?;
        // SCHEDULED, NEVER RUN HERE. The mirror pass happens on a background
        // thread, off this mutex, at most once per `STALENESS_BOUND_MS`.
        // After the flush COMMITTED, so a rejected generation does not schedule
        // a pass over a book that did not change.
        let emit = mark_mirror_dirty(&dirty);
        (acks, emit)
    };
    if emit {
        let _ = window.emit(MIRROR_EVENT, ());
    }
    Ok(acks)
}

/// The label a manuscript-wide replace saves itself under.
///
/// COMPOSED BY THE HOST, never taken from the page. It is the writer's only
/// handle on the inverse of the largest operation this application performs, so
/// it has to say what happened rather than whatever a caller passed. Quoted, so
/// a term with a space in it still reads as one thing.
pub fn replace_snapshot_label(query: &str, replacement: &str) -> String {
    format!("Before replacing \"{query}\" with \"{replacement}\"")
}

/// The testable core of `project_replace`.
///
/// Rebuilds the whole word index rather than moving it per document, for the
/// same reason `snapshot_restore_into` does: a replace can touch every document
/// in the manuscript, and the incremental path would need a second rule for
/// which rows changed -- which is exactly where a cached total drifts.
fn replace_across(
    project: &mut OpenProject,
    query: &str,
    replacement: &str,
) -> std::result::Result<store::history::ReplaceReport, String> {
    let folded =
        find::normalize_query(query).ok_or_else(|| "there is nothing to replace".to_string())?;
    // A newline cannot live inside a ProseMirror text node: the schema has no
    // inline break and a literal one would be a character the editor cannot
    // render or serialize back. Refused BEFORE the transaction opens, so the
    // manuscript is never half-rewritten by a replacement that cannot exist.
    if replacement.contains('\n') || replacement.contains('\r') {
        return Err("a replacement cannot contain a line break".to_string());
    }
    let label = replace_snapshot_label(query.trim(), replacement);
    let report = project
        .store
        .replace_everywhere(&project.excluded, &folded, replacement, &label)
        .map_err(|e| e.to_string())?;
    project.words = project.store.word_index().map_err(|e| e.to_string())?;
    Ok(report)
}

/// The label an acceptance saves itself under.
///
/// COMPOSED BY THE HOST, never taken from the page, on
/// `replace_snapshot_label`'s rule and for its reason: it is the writer's only
/// handle on the inverse of a body rewrite, so it has to say what happened.
/// The design gives the sentence and the singular
/// (`readable-mirror-design.md` section 5).
pub fn accept_snapshot_label(changes: usize) -> String {
    if changes == 1 {
        "Before accepting 1 change from the readable folder".to_string()
    } else {
        format!("Before accepting {changes} changes from the readable folder")
    }
}

/// What an acceptance did, as the page is told it.
#[derive(Debug, Clone, serde::Serialize)]
struct AcceptOutcome {
    report: store::history::AcceptReport,
    /// The mirror-relative paths taken, so the manifest can be settled after
    /// the store lock is dropped.
    paths: Vec<String>,
    /// Underlined runs the folder had already dropped from the bodies replaced.
    /// Restated here so the notice after the press says what the row said
    /// before it.
    underlined: u64,
}

/// The testable core of `mirror_accept`: plan, write, and move the index.
///
/// **PULLED OUT OF THE COMMAND** on the recorded `preferences_js` shape: a
/// `#[tauri::command]` body cannot be called from a test, and a rule nobody can
/// drive is a rule nobody is checking.
///
/// **THE DOCUMENT REVISIONS ARE READ HERE, UNDER THE LOCK**, and not carried in
/// from the change set that was built without it. A keystroke that landed
/// between the writer reading the row and pressing the button moves the
/// revision, and `accept_from_mirror` refuses the whole batch on it -- which is
/// the outcome that cannot silently discard the keystroke.
///
/// **THE INDEX MOVES PER DOCUMENT, NOT BY A REBUILD.** `replace_across` rebuilds
/// because a replace can touch every document and would need a second rule for
/// which ones changed; an acceptance knows exactly which, so design section 6's
/// "recomputed for exactly the accepted documents" is a `record` per body. A
/// full recount here would be the recorded 58 ms regression wearing a hat.
fn accept_into(
    project: &mut OpenProject,
    rows: &[mirror::Change],
    ids: &[String],
) -> std::result::Result<AcceptOutcome, String> {
    let doc_revs = project.store.document_revs().map_err(|e| e.to_string())?;
    let plan = mirror::accept_plan(rows, &doc_revs, ids)?;
    let label = accept_snapshot_label(plan.accepts.len());
    let report = project
        .store
        .accept_from_mirror(&plan.accepts, &label)
        .map_err(|e| e.to_string())?;
    for landed in &report.documents {
        project.words.record(&landed.item_id, &landed.body);
    }
    Ok(AcceptOutcome {
        report,
        paths: plan.paths,
        underlined: plan.underlined,
    })
}

fn undo_mirror_accept_into(
    project: &mut OpenProject,
    generation: u64,
    item_id: &str,
    version_id: i64,
    snapshot_id: i64,
    accepted_rev: i64,
) -> std::result::Result<store::history::RestoredDoc, String> {
    if !accepts_generation(project.generation, generation) {
        return Err("the open project changed while waiting to undo the accepted mirror change".to_string());
    }
    let restored = project
        .store
        .undo_mirror_accept(item_id, version_id, snapshot_id, accepted_rev)
        .map_err(|e| e.to_string())?;
    project.words.record(item_id, &restored.body);
    Ok(restored)
}

/// Rewrite a word across the whole manuscript.
///
/// Takes a query and a replacement and NOTHING ELSE -- no scope, no document
/// list, no "and also the trash". The one thing a caller could ask for that
/// this refuses is the operation without its snapshot, and that is the point.
#[command_boundary::command]
fn project_replace(
    state: State<'_, StoreState>,
    query: String,
    replacement: String,
) -> std::result::Result<store::history::ReplaceReport, String> {
    let mut guard = locked(&state);
    replace_across(open_project_mut(&mut guard)?, &query, &replacement)
}

/// A create against one open project, with the index registration a new scene
/// needs. A scene is created with an empty document, and an empty document is a
/// PRESENT zero in the index rather than an absent entry: absent, the scene's
/// first flush would find no previous count to subtract, which is correct only
/// by accident (nothing minus nothing), and would leave the total right for the
/// wrong reason. It also makes the index's document count disagree with the
/// store's, which is what the guard test compares.
#[cfg(test)]
fn create_into(
    project: &mut OpenProject,
    parent_id: Option<&str>,
    item_type: &str,
    title: &str,
) -> std::result::Result<store::ItemCreated, String> {
    create_into_after(project, parent_id, item_type, title, None)
}

/// The same, landing the new item after a named sibling. A wrapper pair for
/// `Store::item_create`'s reason: every existing caller appends, and widening
/// the appending signature would have edited a dozen test call sites to prove
/// one argument.
fn create_into_after(
    project: &mut OpenProject,
    parent_id: Option<&str>,
    item_type: &str,
    title: &str,
    after_id: Option<&str>,
) -> std::result::Result<store::ItemCreated, String> {
    let created = project
        .store
        .item_create_after(parent_id, item_type, title, after_id)
        .map_err(|e| e.to_string())?;
    // Keyed on doc_rev, not on the type string: doc_rev is Some exactly when the
    // store wrote a doc row, so the two cannot drift if scenes stop being the
    // only item type that gets one.
    //
    // NEVER FOR A TIMELINE. `word_index()` excludes the type at the SQL level
    // (101, `TIMELINE_TYPE`'s own comment), so a freshly opened project never
    // has an entry for one; recording `EMPTY_DOC_BODY` here would give a
    // just-created timeline a present zero-word entry this session and no
    // entry at all after the next reopen -- the same document answering
    // `words()` two different ways depending on when you ask.
    if created.doc_rev.is_some() && item_type != store::TIMELINE_TYPE {
        project.words.record(&created.id, store::EMPTY_DOC_BODY);
    }
    // Creating one of the two non-book roots is a tree change the cached set has
    // to see -- and so is creating anything INSIDE one, which is the arm the bin
    // never needed. Nothing is ever created into the bin: an item enters it by a
    // move, which `move_within` covers. A bible document is created into the
    // bible directly, so without the second clause the note's own words would
    // stay in the project total until the next unrelated tree change happened to
    // refresh the set -- excluded by a rule that was true and a cache that was
    // not.
    //
    // STILL NARROWED, and the narrowing is measured rather than assumed (see
    // `move_within`): a walk per new scene would put an O(tree) step on an
    // operation a writer performs while drafting. Both clauses are exact --
    // a create in the manuscript satisfies neither.
    if item_type == store::TRASH_TYPE
        || item_type == store::BIBLE_TYPE
        || parent_id.is_some_and(|p| project.excluded.contains(p))
    {
        project.refresh_excluded();
    }
    Ok(created)
}

#[command_boundary::command]
fn item_create(
    state: State<'_, StoreState>,
    parent_id: Option<String>,
    item_type: String,
    title: String,
    // camelCase `afterId` from the page, like `item_move`'s. An Option arg, so a
    // page that omits it appends -- which is what every caller did before slice
    // 027 and what the navigator's context menu still wants.
    after_id: Option<String>,
) -> std::result::Result<store::ItemCreated, String> {
    let mut guard = locked(&state);
    create_into_after(
        open_project_mut(&mut guard)?,
        parent_id.as_deref(),
        &item_type,
        &title,
        after_id.as_deref(),
    )
}

#[command_boundary::command]
fn item_rename(
    state: State<'_, StoreState>,
    id: String,
    title: String,
    base_rev: i64,
) -> std::result::Result<i64, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .item_rename(&id, &title, base_rev)
        .map_err(|e| e.to_string())
}

/// Set or clear the selected item's revision state.
///
/// `state` is an Option arg and `None` MEANS SOMETHING HERE -- it is the
/// default, `none`. So a missing or misspelled `state` key does not error: it
/// deserializes to None and CLEARS the item's state, which is legal, wrong, and
/// indistinguishable from the call that was intended. Same recorded hazard as
/// `parentId` on item_create; the page sends the key explicitly, always.
#[command_boundary::command]
fn item_set_state(
    store: State<'_, StoreState>,
    id: String,
    state: Option<String>,
    base_rev: i64,
) -> std::result::Result<i64, String> {
    let guard = locked(&store);
    open_project(&guard)?
        .store
        .item_set_state(&id, state.as_deref(), base_rev)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
fn item_move(
    state: State<'_, StoreState>,
    id: String,
    new_parent_id: Option<String>,
    after_id: Option<String>,
    base_rev: i64,
) -> std::result::Result<store::ItemMoved, String> {
    let mut guard = locked(&state);
    move_within(
        open_project_mut(&mut guard)?,
        &id,
        new_parent_id.as_deref(),
        after_id.as_deref(),
        base_rev,
    )
}

/// A move against one open project, with the cached bin contents brought back
/// into agreement with the tree.
///
/// A free function for the same reason `create_into` and `flush_into` are: a
/// `#[tauri::command]` cannot be unit-tested, so the command must be a wrapper
/// over something that can. Written the other way round, the refresh below sat
/// in the command, and a mutation replacing it with a single-id insert survived
/// the whole suite -- not because the tests were weak about subtrees, but
/// because nothing they ran could reach the line at all.
fn move_within(
    project: &mut OpenProject,
    id: &str,
    new_parent_id: Option<&str>,
    after_id: Option<&str>,
    base_rev: i64,
) -> std::result::Result<store::ItemMoved, String> {
    let moved = project
        .store
        .item_move(id, new_parent_id, after_id, base_rev)
        .map_err(|e| e.to_string())?;
    // A move is the ONLY way an item enters or leaves the bin or the bible, so
    // this is the only place the cached set can go stale. Refreshed after the store has
    // committed, never before: a refusal must not change what the project total
    // excludes.
    //
    // A FULL refresh from the walk, not `trashed.insert(id)`: moving a chapter
    // into the bin takes every scene under it, and inserting the one moved id
    // would leave those scenes' words in the project total forever.
    //
    // NARROWED, and measured rather than assumed: refreshing on EVERY move put
    // a whole-tree walk on the mutation path and moved the graded outline run's
    // move sample from 28.6 ms to 48-53 ms at a FORTY-row fixture, straddling
    // the 50 ms gate. A single-variable probe with this line removed brought it
    // back to 38 ms. The cost is O(tree), so at the 20,060-row stress fixture it
    // is not a rounding error.
    //
    // The condition is exact rather than a heuristic. The excluded set changes
    // only if this subtree ENTERED the bin or the bible -- which means the
    // destination is one of those roots or something already inside one -- or
    // LEFT, which means the moved item was in the set. Because the set is the
    // UNION, both sections are covered by the same two reads. A plain reorder within the manuscript is neither, and
    // that is the case a writer performs constantly.
    let entered = new_parent_id.is_some_and(|p| project.excluded.contains(p));
    let left = project.excluded.contains(id);
    if entered || left {
        project.refresh_excluded();
    }
    Ok(moved)
}

/// The project's own record of its name, falling back to the file stem for a
/// project written before names were recorded.
fn project_name(store: &store::Store, path: &Path) -> String {
    let stem = || {
        path.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    match store.get_meta(projects::NAME_KEY) {
        Ok(Some(n)) if !n.is_empty() => n,
        _ => stem(),
    }
}

fn summary_of(project: &OpenProject) -> projects::ProjectSummary {
    projects::ProjectSummary {
        path: project.path.to_string_lossy().into_owned(),
        name: project.name.clone(),
        modified_at: fs::metadata(&project.path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        error: None,
        missing: false,
    }
}

/// Drop a remembered book whose file is gone from the list. `forget_book`
/// refuses a present file and an unrecorded path, so the page cannot use this
/// to make a manuscript unopenable; see its note.
#[command_boundary::command]
fn project_forget(data_home: State<'_, DataHome>, path: String) -> std::result::Result<(), String> {
    projects::forget_book(&data_home.0, &path)
}

#[command_boundary::command]
fn project_list(data_home: State<'_, DataHome>) -> Vec<projects::ProjectSummary> {
    // KNOWN, not the library scan. Since 031 a book can live in a folder the
    // writer chose, and a listing that only walked one directory would hide
    // the writer's own manuscripts from their own library panel.
    projects::list_known(&data_home.0)
}

/// Where a new book goes when the writer has not chosen a folder.
///
/// The remembered folder if there is one, `<Documents>/Books` otherwise:
/// `projects::resolve_new_book_dir` is the pure decision, and this supplies it
/// the real environment. A writer who keeps their books somewhere chooses
/// once; a writer who never chooses gets a visible default instead of the
/// hidden library an earlier build put them in.
///
/// FALLIBLE, where the old library-backed default never was: a machine with
/// no Documents folder and no usable `$HOME` has nowhere to default to, and
/// that is told to the writer rather than papered over with a hidden path.
pub(crate) fn new_book_dir(data_home: &Path) -> std::result::Result<PathBuf, String> {
    new_book_dir_with(data_home, dirs::document_dir(), dirs::home_dir())
}

/// `new_book_dir`'s body, with the two environment lookups taken as
/// parameters -- the seam tests use, so no test depends on the real
/// `Documents` folder or `$HOME` of the machine running the suite.
fn new_book_dir_with(
    data_home: &Path,
    documents_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
) -> std::result::Result<PathBuf, String> {
    let settings = projects::read_settings(data_home);
    projects::resolve_new_book_dir(
        settings.new_book_dir.as_deref(),
        &projects::library_dir(data_home),
        documents_dir,
        home_dir,
    )
}

/// Create a book in `dir`, and remember where it went.
///
/// PULLED OUT OF THE COMMANDS, because a `#[tauri::command]` body cannot be
/// called from a test and this is where every rule of the slice meets: the
/// known set that makes the stem refusal possible, the recording that makes the
/// book openable afterwards, and the folder that becomes the next default.
///
/// **RECORDED ONLY WHEN IT IS OUTSIDE THE LIBRARY.** A library book is already
/// known by the scan, and putting it in the list too would make it appear twice
/// -- `known` deduplicates, so this is belt and braces rather than a load-bearing
/// branch, and it keeps the list meaning what its name says.
///
/// The recording is best effort and its failure does NOT fail the create: the
/// manuscript exists on disk and telling the writer their book was not made
/// would be a lie. What they lose is the book being listed, which the next
/// create in the same folder repairs.
pub(crate) fn create_into_dir(
    data_home: &Path,
    dir: &Path,
    name: &str,
    strings: &strings::Strings,
) -> std::result::Result<projects::ProjectSummary, String> {
    let made = projects::create_in(dir, name, strings)?;
    remember_created_in(data_home, dir, &made.path);
    Ok(made)
}

/// `create_into_dir`'s registration, on its own: an outside-the-library path
/// is added to `Settings.books` (once), and `dir` becomes the remembered
/// `new_book_dir`. Shared with `create_imported_into_dir` so an import
/// or a restore that lands outside the hidden library is exactly as openable
/// afterwards as a book created there through a folder dialog.
///
/// Best effort, `create_into_dir`'s own reason: the manuscript already exists
/// on disk, and telling the writer their book was not made would be a lie.
fn remember_created_in(data_home: &Path, dir: &Path, made_path: &str) {
    let path = PathBuf::from(made_path);
    let library = projects::library_dir(data_home);
    let outside = !projects::in_library(&library, &path);
    let _ = projects::update_settings(data_home, |s| {
        if outside && !s.books.iter().any(|b| b == made_path) {
            s.books.push(made_path.to_string());
        }
        s.new_book_dir = Some(dir.to_string_lossy().into_owned());
    });
}

#[command_boundary::command]
fn project_create(
    data_home: State<'_, DataHome>,
    strings: State<'_, HostStrings>,
    name: String,
) -> std::result::Result<projects::ProjectSummary, String> {
    // Deliberately does not switch to it: creation and opening are separate
    // acts, so a failed open cannot lose a just-created manuscript.
    //
    // INTO THE REMEMBERED FOLDER, which is `<Documents>/Books` until a writer
    // chooses otherwise. The plain create is still one act with no
    // dialog.
    let dir = new_book_dir(&data_home.0)?;
    create_into_dir(&data_home.0, &dir, &name, &strings.0)
}

/// Where the next new book would go, so the panel can show it before the writer
/// commits.
///
/// This command's enable act, for its reason: the resolved destination is the thing being
/// consented to, and a writer who cannot see it cannot consent to it. FALLIBLE:
/// a resolver error is exactly the thing the writer has to be told
/// before consenting to anything, not a path silently swallowed into a blank
/// panel.
#[command_boundary::command]
fn project_new_dir(data_home: State<'_, DataHome>) -> std::result::Result<String, String> {
    new_book_dir(&data_home.0).map(|dir| dir.display().to_string())
}

#[command_boundary::command]
fn project_current(state: State<'_, StoreState>) -> Option<projects::ProjectSummary> {
    locked(&state).as_ref().map(summary_of)
}

/// Record a new NAME for the open project. The whole of `project_rename` except
/// unwrapping Tauri's `State`, which is the only part a `#[tauri::command]`
/// signature makes untestable.
///
/// A NAME IS NOT A FILE NAME. `summarize` reads this meta row and falls back to
/// the file stem only when a project carries no name; the `<slug>` the recovery,
/// archive and mirror directories are derived from is the file STEM and is a
/// different thing. So this moves no file, breaks no recovery point and
/// relocates no mirror. The identity of a project is its file and the name is a
/// label on it -- which was already the design, and is why a rename is one row.
///
/// The rule is NOT `projects::create_in`'s. That one is `slugify`, because it has a
/// file to name, and `slugify` answers `None` for Hebrew and Arabic titles
/// (the reason the mirror carries a segment rule of
/// its own). A rename creates no file, so borrowing that rule would refuse a
/// legitimate book title to protect a filename that is not being written.
/// Trimmed-empty is the whole rule, and the refusal writes nothing.
fn rename_open(store: &store::Store, name: &str) -> std::result::Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("a project needs a name".to_string());
    }
    store
        .set_meta(projects::NAME_KEY, trimmed)
        .map_err(|e| format!("cannot record the project name: {e}"))?;
    Ok(trimmed.to_string())
}

/// Rename the open project, and repaint the window title with what was STORED
/// rather than with what was typed -- the two differ by the trim, and a title
/// composed from the argument would be the page's second answer to a question
/// the host just answered.
#[command_boundary::command]
fn project_rename(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    name: String,
) -> std::result::Result<projects::ProjectSummary, String> {
    let mut guard = locked(&state);
    let project = guard
        .as_mut()
        .ok_or_else(|| "no project is open".to_string())?;
    let stored = rename_open(&project.store, &name)?;
    project.name = stored.clone();
    let summary = summary_of(project);
    drop(guard);
    set_window_title(&app, &stored);
    Ok(summary)
}

/// The drop directory and what is in it.
///
/// THE DIRECTORY IS PART OF THE ANSWER, not decoration. The panel's empty state
/// tells a writer to put a file in the import folder, and until this slice it
/// named no folder while the archive and mirror sections beside it both named
/// theirs. The page cannot compose the path itself: `imports_dir` honours
/// `APP_IMPORT_DIR`, so a page-side `<data_home>/imports` would be a second
/// implementation of a rule the host owns and would be wrong in exactly the case
/// the override exists for.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
struct ImportReport {
    /// The RESOLVED drop directory, after any override -- the same contract as
    /// `MirrorReport::dir`.
    dir: String,
    files: Vec<String>,
}

/// The whole of `project_import_list` except unwrapping Tauri's `State`.
///
/// A directory that cannot be read reports its NAME and no files, rather than
/// failing: on a first run nothing has created it yet, and the path is the only
/// actionable thing there is to say. `list_imports` already answers an empty
/// list there, and this preserves that rather than adding a second error state
/// the panel would have to render.
fn import_report(dir: &Path) -> ImportReport {
    ImportReport {
        dir: dir.display().to_string(),
        files: projects::list_imports(dir),
    }
}

/// The importable files the writer has dropped in, by name, and where they go.
#[command_boundary::command]
fn project_import_list(data_home: State<'_, DataHome>) -> ImportReport {
    import_report(&imports_dir(&data_home.0))
}

/// A successful import, plus omitted source content and derived sections.
#[derive(Debug, serde::Serialize)]
pub(crate) struct ImportOutcome {
    pub(crate) derived_contents: Option<String>,
    pub(crate) summary: projects::ProjectSummary,
    pub(crate) losses: docx_import::Losses,
}

/// Import one of them as a NEW project. Does not switch to it, for the same
/// reason `project_create` does not.
///
/// The argument is a bare FILENAME, never a path. Export declines an argument
/// altogether and records why; import cannot, since something has to say which
/// file, so it takes the smallest argument that answers that and nothing else.
/// What a page could do with this if it were compromised is read a manuscript
/// the writer themselves put in the drop directory — and nothing outside it.
///
/// INTO THE SAME REMEMBERED FOLDER `project_create` uses, not the
/// hidden library `Library` state still names for `may_open`'s reason: an
/// imported book is a new book, and the OPEN DECISION this slice's contract
/// records is that it must land where a new book lands rather than staying
/// hidden by default.
#[command_boundary::command]
fn project_import(
    data_home: State<'_, DataHome>,
    strings: State<'_, HostStrings>,
    filename: String,
) -> std::result::Result<ImportOutcome, String> {
    let dest = new_book_dir(&data_home.0)?;
    import_named(&data_home.0, &dest, &imports_dir(&data_home.0), &filename, &strings.0)
}

/// `APP_EXPORT_DIR` overrides the destination directory: an operator escape
/// hatch, read in Rust only and never interpolated into the page's init script,
/// so it needs no `js_string`. It is also where the Export as… dialog opens, so
/// a rig can put that dialog somewhere deterministic without naming a path from
/// the page.
fn export_dir(data_home: &Path) -> PathBuf {
    std::env::var_os("APP_EXPORT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| projects::exports_dir(data_home))
}

/// `APP_IMPORT_DIR` overrides the drop directory, in the same spirit as
/// `APP_EXPORT_DIR`: an operator escape hatch, read in Rust only and never
/// interpolated into the page's init script, so it needs no `js_string`.
fn imports_dir(data_home: &Path) -> PathBuf {
    std::env::var_os("APP_IMPORT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| projects::imports_dir(data_home))
}

/// The whole of `project_import` except unwrapping Tauri's `State`, which is the
/// only part a `#[tauri::command]` signature makes untestable.
///
/// `dest_dir` is the resolved destination (`new_book_dir`'s answer, or a
/// test's own); `drop_dir` is where `filename` is looked up. `data_home` is
/// for `remember_created_in` alone -- the registration the book needs when
/// `dest_dir` sits outside the hidden library.
fn import_named(
    data_home: &Path,
    dest_dir: &Path,
    drop_dir: &Path,
    filename: &str,
    strings: &strings::Strings,
) -> std::result::Result<ImportOutcome, String> {
    if !projects::import_name_ok(filename) {
        return Err(format!(
            "{filename:?} is not the name of a manuscript file (.md or .docx) in the import folder"
        ));
    }
    import_path(data_home, dest_dir, &drop_dir.join(filename), strings)
}

/// The zip local-file-header signature. A DOCX is an OOXML package, which is
/// a zip; a `.docx` that does not start with it is not one, whatever its
/// name claims, and is refused with the read error rather than misread as
/// Markdown (decision 8).
const ZIP_SIGNATURE: &[u8; 4] = b"PK\x03\x04";

/// Read a manuscript at `path` and create a project from it, MARKDOWN or
/// DOCX decided by the file's own first bytes rather than its extension
/// (decision 8) -- `import_name_ok` already narrowed the name to the two
/// extensions this build accepts, but a page bug or an operator's own typo
/// could still hand this a `.docx` that is plain text, and the CONTENT is
/// what a parser actually needs to be right about.
///
/// Everything `import_named` does EXCEPT deciding whether the name was
/// allowed. That split is the point: the bare-filename rule exists to
/// constrain a path the PAGE names, and the dialog route's path is named by
/// the writer in the host, so there is no rule for it to pass. Sharing the
/// read, the size bound and the parse keeps the two routes from drifting
/// into two importers.
fn import_path(
    data_home: &Path,
    dest_dir: &Path,
    path: &Path,
    strings: &strings::Strings,
) -> std::result::Result<ImportOutcome, String> {
    let shown = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("that file");
    // Size before contents. A refusal that has already read the file has not
    // refused anything, and this is the only bound on what the parse holds.
    let size = fs::metadata(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?
        .len();
    if size > MAX_IMPORT_BYTES {
        return Err(format!(
            "{shown} is {} MB; the limit is {} MB",
            size / 1_000_000,
            MAX_IMPORT_BYTES / 1_000_000
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    // The `.docx` extension's own promise, kept: a file named `.docx` that
    // is not a zip at all is refused here rather than falling through to
    // the Markdown branch below and being misread as prose, exactly as the
    // `ZIP_SIGNATURE` doc comment already claims. A `.md` (or anything
    // else) that happens to start with the zip signature still gets
    // decided by its bytes, on decision 8 -- this check only ever adds a
    // refusal, never widens what parses as DOCX.
    let named_docx = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("docx"));
    if named_docx && !bytes.starts_with(ZIP_SIGNATURE) {
        return Err(format!("{shown} is not a DOCX: it does not start with a zip header"));
    }
    // The stem, for a file that does not name itself. `file_stem` and not a
    // split on '.', so "part 2.md" keeps its space and "a.b.md" keeps "a.b".
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(shown);
    let (imported, losses) = if bytes.starts_with(ZIP_SIGNATURE) {
        let parsed = docx_import::parse(&bytes, stem).map_err(|e| format!("{}: {e}", path.display()))?;
        (parsed.imported, parsed.losses)
    } else {
        let source = String::from_utf8(bytes)
            .map_err(|_| format!("{}: not valid UTF-8 text", path.display()))?;
        (import::parse(&source, stem), docx_import::Losses::default())
    };
    let rows: Vec<store::ImportRow<'_>> = imported
        .items
        .iter()
        .map(|i| (i.parent, i.item_type, i.title.as_str(), i.body.as_deref()))
        .collect();
    create_imported_into_dir(data_home, dest_dir, &imported.name, &rows, strings)
        .map(|summary| ImportOutcome { summary, losses, derived_contents: imported.derived_contents })
}

/// `create_into_dir`'s counterpart for an import: create in `dir` and
/// register exactly as a plain create would (159's open decision) -- an
/// imported book must be as openable as one made through the folder dialog,
/// not left findable only by scanning a directory nothing points at once
/// `dir` is outside the hidden library.
fn create_imported_into_dir(
    data_home: &Path,
    dir: &Path,
    name: &str,
    rows: &[store::ImportRow<'_>],
    strings: &strings::Strings,
) -> std::result::Result<projects::ProjectSummary, String> {
    let made = projects::create_imported(dir, name, rows, strings)?;
    remember_created_in(data_home, dir, &made.path);
    Ok(made)
}

/// Refused by size before the file is read. The `stress` fixture exports to
/// 10.5 MB, so this is roughly six manuscripts — far above anything a writer
/// arrives with and far below the point where one parse costs the process.
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// The one place the openability restriction is decided. Without it a page bug
/// could open an arbitrary file as a manuscript.
///
/// **A PROJECT IS A FILE THE HOST KNOWS ABOUT**, which is a
/// wider set than "a file inside the library directory" and is still a set the
/// page cannot add to. Three ways in, and each is the host's own knowledge:
///
///  - it sits directly in the library the application owns (`in_library`, whose
///    `..` refusal and canonicalize-both-sides rule are unchanged and are what
///    make a path comparison sound at all);
///  - the host recorded it in `Settings.books` when IT created the book there,
///    after the writer chose the folder in an operating-system dialog;
///  - it is the `APP_PROJECT` path this process started with, which the harness
///    stages under /tmp and must be able to reopen.
///
/// `known` is passed in rather than read here, so this stays a pure function a
/// test can drive -- the recorded shape that keeps a rule falsifiable.
fn may_open(library: &Path, explicit: Option<&Path>, known: &[PathBuf], requested: &Path) -> bool {
    if explicit == Some(requested) {
        return true;
    }
    if projects::in_library(library, requested) {
        return true;
    }
    // BY CANONICAL PATH where both resolve, so two spellings of one book are
    // one book -- and never by string prefix, which is the comparison
    // `in_library`'s own header records as the one that keeps getting bypassed.
    let resolved = std::fs::canonicalize(requested);
    known
        .iter()
        .any(|k| match (&resolved, std::fs::canonicalize(k)) {
            (Ok(a), Ok(b)) => *a == b,
            _ => k == requested,
        })
}

/// The window carries the open project's name and follows a switch.
///
/// Set from RUST, inside the command that already performs the open, rather
/// than from the page: Tauri 2 gates core-plugin APIs behind capability files
/// and this app grants event listen/unlisten to window "main", so a
/// page-side `getCurrentWindow().setTitle()` would need a further grant. It
/// would also be a second thing to keep in step with the open.
///
/// A failure is swallowed deliberately: a window whose title did not change is
/// a cosmetic defect, and reporting it as a failed open would be a lie.
fn set_window_title(app: &tauri::AppHandle, name: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&privacy_host::title(app, name));
    }
}

/// A second launch asked for the window. Best effort, like the title: a
/// compositor that refuses focus stealing leaves the writer where they were,
/// which is the compositor's call and not an error the host can act on.
fn focus_main(app: &tauri::AppHandle) {
    if privacy_host::locked(app) {
        #[cfg(target_os = "linux")]
        privacy_native::focus(app);
        #[cfg(windows)]
        privacy_windows::focus(app);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
fn set_open_project(
    state: &StoreState,
    paused: &MirrorPaused,
    dirty: &MirrorDirty,
    project: OpenProject,
) -> u64 {
    let mut guard = locked(state);
    set_open_project_locked(&mut guard, paused, dirty, project)
}

fn set_open_project_locked(
    guard: &mut Option<OpenProject>,
    paused: &MirrorPaused,
    dirty: &MirrorDirty,
    mut project: OpenProject,
) -> u64 {
    if let Some(previous) = guard.as_ref() {
        if let Some(runtime) = previous.analytics.as_ref() {
            if let Err(error) = previous.store.analytics_end(runtime) {
                eprintln!("analytics: could not end the previous book session: {error}");
            }
        }
    }
    project.analytics = match project.store.analytics_start_on_open() {
        Ok(runtime) => runtime,
        Err(error) => { eprintln!("analytics: could not start the book session: {error}"); None }
    };
    let generation = guard.as_ref().map(|p| p.generation).unwrap_or(0) + 1;
    let same_book = guard.as_ref().is_some_and(|open| open.book_id == project.book_id);
    let switched = guard
        .as_ref()
        .is_none_or(|open| open.path != project.path || open.book_id != project.book_id);
    let book_id = project.book_id.clone();
    project.generation = generation;
    *guard = Some(project);
    if switched {
        if let Ok(mut pauses) = paused.0.lock() {
            pauses.select(&book_id);
        }
        // Another physical copy may have different prose at equal revisions.
        dirty.0.store(same_book, Ordering::Relaxed);
        dirty.1.store(same_book, Ordering::Relaxed);
    } else if dirty.1.load(Ordering::Relaxed) {
        // A pass claimed this book before its same-path reopen. Its completion
        // is now stale by generation, so make the new generation run it again.
        dirty.0.store(true, Ordering::Relaxed);
    }
    generation
}

#[command_boundary::command]
fn project_open_check(
    library: State<'_, Library>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
    path: String,
) -> Result<Option<book_open::CopyConflict>, String> {
    let requested = PathBuf::from(&path);
    if !may_open(&library.0, explicit.0.as_deref(), &projects::known(&data_home.0), &requested) {
        return Err(format!("{path}: not a project this application knows about"));
    }
    let store = store::Store::open_readonly(&requested).map_err(|error| format!("{path}: {error}"))?;
    if explicit.0.is_some() {
        return Ok(None);
    }
    book_open::conflict(&store, &requested, &projects::read_settings_checked(&data_home.0)?)
}

#[command_boundary::command]
fn project_open(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    paused: State<'_, MirrorPaused>,
    dirty: State<'_, MirrorDirty>,
    library: State<'_, Library>,
    data_home: State<'_, DataHome>,
    strings: State<'_, HostStrings>,
    explicit: State<'_, ExplicitProject>,
    passing: State<'_, MirrorPassing>,
    mirror_root: State<'_, MirrorRoot>,
    path: String,
    decision: Option<book_open::Decision>,
) -> std::result::Result<ProjectOpened, String> {
    let requested = PathBuf::from(&path);
    if !may_open(
        &library.0,
        explicit.0.as_deref(),
        &projects::known(&data_home.0),
        &requested,
    ) {
        return Err(format!(
            "{path}: not a project this application knows about"
        ));
    }
    let outgoing_generation = locked(&state).as_ref().map(|project| project.generation);
    // `open_for_writing`, for `try_open`'s reason: this is the other path a
    // writer opens a project through.
    let store = projects::open_existing_for_writing(&requested).map_err(|e| format!("{path}: {e}"))?;
    let mut book_id = project_book_id(&store)?;
    store
        .ensure_starter_structure(&strings.0)
        .map_err(|e| format!("{path}: cannot create the starter chapter and scene: {e}"))?;
    let name = project_name(&store, &requested);
    // BEFORE the lock. This is the one O(manuscript) step in the counting path
    // and it must not be taken with the store mutex held, or every open would
    // stall the save path for the length of a full scan.
    let words = store
        .word_index()
        .map_err(|e| format!("{path}: cannot count the project: {e}"))?;
    // Also before the lock, and from the walk this open already has to be able
    // to perform. An open whose walk fails has bigger problems than its bin.
    let excluded = store
        .items()
        .map(|items| store::excluded_from_book(&items))
        .unwrap_or_default();
    let mirror_guard = passing.0.lock().map_err(|_| "the readable folder is busy")?;
    let recovery_guard = recovery::PASSING.lock().map_err(|_| "recovery is busy")?;
    let mut store_guard = locked(&state);
    if store_guard.as_ref().map(|project| project.generation) != outgoing_generation {
        return Err("a different book was opened while this one was being prepared; choose it again".into());
    }
    if explicit.0.is_none() {
        book_id = book_open::register(&store, &requested, &data_home.0, mirror_root.0.as_deref(), decision.as_ref())?;
    }
    // Replace the previous project's words in ENCHANT_CONFIG_DIR. Testing
    // verified recognition follows A/B/A switches in the same WebKit process
    // with en_US/aspell on Linux. Other providers/platforms remain unverified.
    #[cfg(target_os = "linux")]
    commands::spell::sync_project_dictionary(
        &data_home.0,
        &store,
        &commands::spell::configured_languages(),
    );

    // `unwrap_or(0) + 1`: the first open from an empty guard (a switch out of
    // the no-project boot) is generation 1. The page's own fallback for
    // `window.__appGeneration` agrees (grep `?? 1` in main.ts), and `main()`
    // omits that global entirely when nothing is mounted, for the same
    // reason -- there is no generation yet for either side to disagree
    // about. Asserted here in prose rather than in a test that would only
    // retype this line: calling this command from a test needs a
    // `tauri::AppHandle`, which this crate has no test-mock feature for.
    // Replaces the previous project, dropping its store. Any flush still in
    // flight from it is refused by the generation check above.
    let generation = set_open_project_locked(&mut store_guard, &paused, &dirty, OpenProject {
        store,
        book_id,
        registry_home: explicit.0.is_none().then(|| data_home.0.clone()),
        path: requested.clone(),
        name: name.clone(),
        generation: 0,
        analytics: None,
        tracking_on: projects::read_settings(&data_home.0).time_tracking == projects::TimeTracking::On,
        words,
        excluded,
    });
    drop(store_guard);
    drop(recovery_guard);
    drop(mirror_guard);

    set_window_title(&app, &name);

    // AFTER the store is in place and the title is set, and it returns
    // immediately: the scan is a background task and this command must not
    // grow a directory walk between the writer and their open book.
    spawn_mirror_scan(&app);

    // A measurement run must not change what the human's next launch opens;
    // `remember_open` holds that rule and its test.
    projects::remember_open(&data_home.0, explicit.0.is_some(), &requested, store::now_ms() as u64);

    Ok(ProjectOpened {
        path,
        name,
        generation,
    })
}

/// The saved word count of the project at `path`, by FULL SCAN, on its own
/// read-only connection and touching no shared state at all.
///
/// THE REFERENCE IMPLEMENTATION. No command calls it: `project_word_count`
/// answers from `OpenProject::words`, which is built once at open and moved by
/// each accepted flush, because a full scan per flush is a pass over the whole
/// manuscript roughly once a second while someone types -- measured at the
/// stress fixture as 116 frames in the 40-100 ms bucket and frame p99 at 43 ms
/// against a pre-slice 0 and 34.
///
/// It stays because the cache needs a guard, and a guard has to be an
/// INDEPENDENT second implementation: `the_incremental_total_equals_a_full_
/// recount` and its siblings drive creates and flushes through the incremental
/// path and then compare the result against this. `#[cfg(test)]` so a release
/// build carries no scan nothing calls.
///
/// A path rather than the open `Store` on purpose: the open store lives behind
/// the mutex `doc_flush` needs, and counting through it would put the save path
/// behind a display element for as long as the scan takes.
///
/// `open_readonly`, never `open`: `open` creates schema v1 on a blank file and
/// migrates, and a report must not write to the thing it reports on. A WAL
/// reader sees every committed flush, which is exactly the "as saved" figure the
/// bar claims to show.
#[cfg(test)]
fn word_count_at(path: &Path) -> std::result::Result<store::WordCount, String> {
    store::Store::open_readonly(path)
        .map_err(|e| e.to_string())?
        .word_count()
        .map_err(|e| e.to_string())
}

/// `word_count_at` for sentences and paragraphs: the same independent scan,
/// read by the same guard.
#[cfg(test)]
fn unit_count_at(path: &Path) -> std::result::Result<store::Units, String> {
    store::Store::open_readonly(path)
        .map_err(|e| e.to_string())?
        .unit_count()
        .map_err(|e| e.to_string())
}

/// The project's word count, as saved -- read from the index in O(1) rather than
/// scanned. A bare u64 rather than the store's `WordCount`: the page renders one
/// number and, on any failure, an em-dash -- it has nowhere to put a
/// skipped-document figure and no banner to raise, since the count is
/// informational and the manuscript is unaffected. The figure is not dropped: it
/// goes to host stderr, where an unreadable body is a diagnostic for the
/// operator rather than a number the writer cannot act on.
#[command_boundary::command]
fn project_word_count(state: State<'_, StoreState>) -> std::result::Result<u64, String> {
    let guard = locked(&state);
    let count = open_project(&guard)?.word_count();
    // Held only for the field read above; the eprintln is not worth the mutex.
    drop(guard);
    if count.skipped > 0 {
        eprintln!(
            "word count: {} document(s) could not be read; the total of {} is an undercount",
            count.skipped, count.words
        );
    }
    Ok(count.words)
}

/// The saved word count of every live document, keyed by item id -- what a
/// novelist needs to see how long a chapter is without opening its scenes.
///
/// A JSON object of `{ itemId: words }`. TWO ENTRIES ARE ABSENT ON PURPOSE and
/// the page must treat a missing key as "no figure", never as zero:
///
/// - A body that could not be read as a document. Zero is already taken -- a
///   scene created and never typed into is a genuine, present zero -- so a
///   parse failure reported as 0 would be a claim ("empty") standing in for the
///   truth ("uncounted"). The total command reports the same condition as its
///   `skipped` figure on stderr; this one reports it by absence.
/// - A document in the Trash bin, excluded exactly as `project_word_count`
///   subtracts it, so that summing this map gives that command's answer. A
///   caller that sums a chapter's scenes and a caller that reads the project bar
///   must not be able to disagree. The page filters the bin out of the outline
///   itself (`liveItemsIn`), so those keys would never be looked up; what the
///   exclusion buys is that the sum is right.
///
/// COST, because the page calls this after every flush ack: O(documents), a walk
/// of the index the host already maintains plus one map build -- 15,200 entries
/// at the stress fixture -- with no body parsed and no store query. It is NOT
/// the per-flush O(manuscript) rescan this project already paid for once. It is
/// not free either: unlike `project_word_count`, which is O(1) from the same
/// index, this one allocates per call, and the mutex is held for the walk. A
/// caller that repaints on every keystroke's flush is buying a map a second.
#[command_boundary::command]
fn project_word_counts(
    state: State<'_, StoreState>,
) -> std::result::Result<std::collections::HashMap<String, u64>, String> {
    let guard = locked(&state);
    let counts = open_project(&guard)?.word_counts();
    // Held for the index walk and nothing else. Serialization happens after
    // this returns, outside the lock, which is what keeps a display element off
    // the save path -- the recorded incident is a scan holding this mutex and
    // blocking every doc_flush for its duration.
    drop(guard);
    Ok(counts)
}

/// Every live document's words, sentences and paragraphs for statistics.
/// Read on demand after the panel or export drains, never on the flush path.
#[command_boundary::command]
fn project_document_counts(
    state: State<'_, StoreState>,
) -> std::result::Result<std::collections::HashMap<String, store::DocumentCounts>, String> {
    let guard = locked(&state);
    let counts = open_project(&guard)?.document_counts();
    drop(guard);
    Ok(counts)
}

/// The saved manuscript total and signed typing-only progress.
/// A missing daily figure means attribution is unavailable, not zero work.
/// `collecting` false means saves are not being measured, so the daily figure
/// is frozen rather than current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
struct Progress {
    total: u64,
    today: Option<i64>,
    collecting: bool,
}

/// `YYYY-MM-DD`, and nothing else, because the value comes from the page.
///
/// The page is the only thing here that knows the writer's clock: Rust's std has
/// no local timezone, and pulling in `chrono` to learn what day it is would be a
/// large dependency for a string the application already has. That makes the date
/// untrusted in the ordinary sense -- the worst a bad one can do is re-anchor the
/// baseline, which costs today's figure and nothing else -- but a value that
/// cannot be a date must not become a stored `day`, or the next launch compares
/// against something no clock will ever produce again and the figure resets
/// forever.
///
/// Shape only, not validity: `2026-02-31` passes. Rejecting it would need a
/// calendar, and a page that sends a real date on the wrong day is not a case
/// this can tell apart anyway.
fn looks_like_a_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| b[i].is_ascii_digit())
}

/// The saved total and typed net for the page's captured local day.
/// Legacy baseline differences are never reclassified as typing.
fn progress_for(
    store: &store::Store,
    total: u64,
    today: &str,
) -> std::result::Result<Progress, String> {
    let sources = store.source_word_summary(today).map_err(|e| e.to_string())?;
    Ok(Progress { total, today: sources.today_typing, collecting: sources.collecting })
}

/// Minutes of `today` in which the manuscript changed, counting this `minute`
/// when `note` is set. `progress_for`'s discipline: a free function so the rule
/// is testable, the day re-anchored on the first call that finds it turned, a
/// row that is missing or unparseable rebuilt rather than trusted.
///
/// THE RULE IS ONE SENTENCE: a minute counts when an edit landed in it. Not a
/// timer, not idle detection, no threshold anybody would have to be told. The
/// page calls with `note` once per minute at most (and never when tracking is
/// off), the host still refuses to count the same minute twice, so the write
/// here is at most one `meta` row per minute of writing.
fn writing_time_for(
    store: &store::Store,
    today: &str,
    minute: u64,
    note: bool,
) -> std::result::Result<u64, String> {
    if !looks_like_a_date(today) {
        return Err(format!("{today:?} is not a date"));
    }
    let meta = |key: &str| store.get_meta(key).map_err(|e| e.to_string());
    let stored_day = meta(projects::TIME_DAY_KEY)?;
    let minutes = meta(projects::TIME_MINUTES_KEY)?.and_then(|v| v.parse::<u64>().ok());
    let last = meta(projects::TIME_LAST_MINUTE_KEY)?.and_then(|v| v.parse::<u64>().ok());

    let (mut minutes, mut last) = match (stored_day.as_deref(), minutes) {
        (Some(day), Some(minutes)) if day == today => (minutes, last),
        _ => {
            // A new day, or nothing trustworthy: anchor today at zero. Only
            // written when something is about to be counted or the row is
            // absent, so a read on a quiet day does not write.
            (0, None)
        }
    };
    let day_turned = stored_day.as_deref() != Some(today);
    let counts = note && last != Some(minute);
    if counts {
        minutes += 1;
        last = Some(minute);
    }
    if counts || day_turned {
        let set = |key: &str, value: &str| store.set_meta(key, value).map_err(|e| e.to_string());
        set(projects::TIME_DAY_KEY, today)?;
        set(projects::TIME_MINUTES_KEY, &minutes.to_string())?;
        set(
            projects::TIME_LAST_MINUTE_KEY,
            &last.map(|m| m.to_string()).unwrap_or_default(),
        )?;
    }
    Ok(minutes)
}

/// The current minute on this computer's clock, as epoch minutes. Timezone-free
/// on purpose: the DAY is the page's local date, the minute only has to differ
/// from the last one counted.
fn epoch_minute() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0)
}

/// The manuscript changed just now: count this minute, once. Answers today's
/// minutes.
#[command_boundary::command]
fn writing_time_note(
    state: State<'_, StoreState>,
    today: String,
) -> std::result::Result<u64, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    writing_time_for(&project.store, &today, epoch_minute(), true)
}

/// Today's minutes, counting nothing. Re-anchors when the day has turned, the
/// way `project_progress` does.
#[command_boundary::command]
fn writing_time_today(
    state: State<'_, StoreState>,
    today: String,
) -> std::result::Result<u64, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    writing_time_for(&project.store, &today, epoch_minute(), false)
}

/// The cached manuscript total and today's typed contribution.
#[command_boundary::command]
fn project_progress(
    state: State<'_, StoreState>,
    today: String,
) -> std::result::Result<Progress, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let total = project.word_count().words;
    progress_for(&project.store, total, &today)
}

#[command_boundary::command]
fn project_source_words(
    state: State<'_, StoreState>,
    today: String,
) -> std::result::Result<store::source_words::SourceWordSummary, String> {
    let guard = locked(&state);
    open_project(&guard)?.store.source_word_summary(&today).map_err(|e| e.to_string())
}

/// Pause or resume measuring saved words in the book the page believed was
/// open. A stale generation touches nothing: the request was about a book
/// that has since been closed.
fn source_words_collecting_into(
    project: &OpenProject,
    generation: u64,
    collecting: bool,
) -> std::result::Result<(), String> {
    if !accepts_generation(project.generation, generation) {
        return Err("the open book changed before the word statistics could be updated".to_string());
    }
    project.store.set_source_words_collecting(collecting).map_err(|e| e.to_string())
}

fn source_words_reset_into(project: &OpenProject, generation: u64) -> std::result::Result<(), String> {
    if !accepts_generation(project.generation, generation) {
        return Err("the open book changed before the word statistics could be reset".to_string());
    }
    project.store.reset_source_words().map_err(|e| e.to_string())
}

#[command_boundary::command]
fn project_source_words_collecting(
    state: State<'_, StoreState>,
    generation: u64,
    collecting: bool,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    source_words_collecting_into(open_project(&guard)?, generation, collecting)
}

#[command_boundary::command]
fn project_source_words_reset(
    state: State<'_, StoreState>,
    generation: u64,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    source_words_reset_into(open_project(&guard)?, generation)
}

/// The writer's preferences, as the globals the page reads on startup.
///
/// The first four are read by index.html's head script, before the stylesheet is
/// applied, because their whole job is to prevent a flash. `__appDailyTarget` is
/// NOT: nothing about it can flash. It rides along because the preferences panel
/// needs its current value to render, and a round trip for one string the host
/// has already read is a round trip.
///
/// Extracted from `main()` so it can be tested at all. Inline, it was the one
/// rule in this slice a mutation survived: dropping the recorded size and
/// injecting the default renders every manuscript at 17px, and only the graded
/// run could see it. A rule written where no test can reach it is the shape this
/// repo has recorded as "an instrument nobody can falsify".
///
/// EVERY value goes through `js_string`. They come from a validated enum rather
/// than from the environment, so none of them can currently close the literal --
/// but the one time this file interpolated a value bare, an operator-supplied
/// APP_SEED could run arbitrary JavaScript in the page holding the manuscript.
fn preferences_js(settings: &projects::Settings) -> String {
    format!(
        "window.__appTheme={};\
         window.__appProseFamily={};\
         window.__appProseSize={};\
         window.__appProseMeasure={};\
         window.__appDailyTarget={};\
         window.__appBibleRows={};\
         window.__appFocusMode={};\
         window.__appTypewriter={};\
         window.__appSpelling={};\
         window.__appThemeFamily={};\
         window.__appLocale={};\
         window.__appTimeTracking={};\
         window.__appZoom={};\
         window.__appMarkCastNames={};\
         window.__appStart={};",
        js_string(settings.theme.as_str()),
        js_string(settings.typography.family.as_str()),
        js_string(settings.typography.size.as_str()),
        js_string(settings.typography.measure.as_str()),
        js_string(settings.daily_target.as_str()),
        settings.bible_rows,
        js_string(settings.writing_modes.focus.as_str()),
        js_string(settings.writing_modes.typewriter.as_str()),
        js_string(settings.spelling.as_str()),
        js_string(settings.theme_family.as_str()),
        js_string(settings.locale.as_str()),
        js_string(settings.time_tracking.as_str()),
        js_string(settings.zoom.as_str()),
        settings.mark_cast_names,
        js_string(settings.start.as_str()),
    )
}

/// `armed` is whether a settle timer is already running; `last` is the size
/// most recently written, so a settle that changes nothing writes nothing.
pub(crate) struct PendingWindow {
    armed: AtomicBool,
    last: Mutex<Option<projects::WindowSize>>,
}

/// The most results this command will return however many the page asks for.
///
/// Not a security boundary -- a query is inbound data, not a path, and nothing
/// here writes. It bounds the IPC payload: a page bug asking for every hit at
/// `stress` would serialize 15,200 snippets across the bridge and freeze the
/// window it was trying to help. `total` still reports the true count, so a
/// clamped answer is a visibly partial one rather than a wrong one.
const FIND_MAX_LIMIT: usize = find::DEFAULT_LIMIT;

/// Search the open manuscript's prose and titles.
///
/// `query` and `limit` both arrive camelCase from the page and are both
/// non-`Option`, deliberately: a misspelled `Option` argument deserializes to
/// `None` with no error, which this codebase has already recorded as a silent
/// and destructive failure mode for `parentId`. A typo in either of these is a
/// loud deserialization error instead.
#[command_boundary::command]
fn project_find(
    state: State<'_, StoreState>,
    query: String,
    limit: usize,
) -> std::result::Result<find::FindResults, String> {
    find_open_project(&state, &query, limit.min(FIND_MAX_LIMIT), find_in)
}

/// The whole of `project_find` except unwrapping Tauri's `State`.
///
/// Same lock discipline as `export_open_project`, and copied from it KNOWINGLY:
/// the path comes out under the guard, the guard drops with that block, and the
/// O(manuscript) scan runs off-mutex on a second read-only connection. A scan
/// holding the mutex would block every `doc_flush` for its duration, and the
/// flush path is on the writer's keystroke budget.
///
/// `scan` is injected so the ordering is asserted rather than asserted-about.
/// The export slice recorded that the first version of that test held the lock
/// and then called a function that never touches the mutex, so it could not
/// fail; what is copied here is the FIXED shape, and
/// `the_find_scan_runs_off_the_store_mutex` proves it the same way -- by a
/// `try_lock` probe at the instant the scan begins.
fn find_open_project(
    state: &StoreState,
    query: &str,
    limit: usize,
    scan: impl FnOnce(&Path, &str, usize) -> std::result::Result<find::FindResults, String>,
) -> std::result::Result<find::FindResults, String> {
    let path = {
        let guard = locked(state);
        open_project(&guard)?.path.clone()
    };
    scan(&path, query, limit)
}

/// The scan itself, over a path. A free function for the same reason
/// `word_count_at` and `export_to` are: a `#[tauri::command]` cannot be unit
/// tested, so the testable core must not live inside one.
fn find_in(
    path: &Path,
    query: &str,
    limit: usize,
) -> std::result::Result<find::FindResults, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    // Search does not reach into the bin: a hit in deleted prose offers the
    // writer a result that opens something they removed. `texts` below is keyed
    // by item id and read through these items, so a trashed body is unreachable
    // rather than merely unlisted.
    let items = store::without_trashed(store.items().map_err(|e| e.to_string())?);
    let (texts, scanned, skipped) = store.document_texts().map_err(|e| e.to_string())?;
    let search_items: Vec<find::SearchItem<'_>> = items
        .iter()
        .map(|i| find::SearchItem {
            id: &i.id,
            kind: &i.item_type,
            title: &i.title,
        })
        .collect();
    let corpus = find::Corpus {
        texts,
        scanned,
        skipped,
    };
    Ok(find::search(&search_items, &corpus, query, limit))
}

#[derive(serde::Serialize)]
struct LegacyProtection {
    surface: &'static str,
    dir: String,
}

#[command_boundary::command]
fn legacy_protection(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
) -> Result<Vec<LegacyProtection>, String> {
    let (path, id, eligible) = {
        let guard = locked(&state);
        let Some(project) = guard.as_ref() else { return Ok(Vec::new()) };
        (project.path.clone(), project.book_id.clone(),
            project.store.may_adopt_legacy_protection().map_err(|error| error.to_string())?)
    };
    let settings = projects::read_settings_checked(&data_home.0)?;
    let plan = protection::plan(&settings, &path, &id, &projects::known(&data_home.0),
        &data_home.0, root.0.as_deref(), eligible)?;
    let slug = recovery::target_slug(Some(&path), None, None).ok_or("book has no usable file name")?;
    Ok(plan.unresolved.into_iter().map(|surface| {
        let (surface, dir) = match surface {
            protection::Surface::Recovery => ("recovery", projects::recovery_dir(&data_home.0, &slug)),
            protection::Surface::Mirror => ("mirror", projects::mirror_dir(&data_home.0, root.0.as_deref(), &slug)),
        };
        LegacyProtection { surface, dir: dir.to_string_lossy().into_owned() }
    }).collect())
}

fn protection_subject(
    state: &StoreState,
    data_home: &Path,
    explicit: Option<&Path>,
) -> Option<(PathBuf, String)> {
    let settings = projects::read_settings_checked(data_home).ok()?;
    let opened = {
        let guard = locked(state);
        guard.as_ref().map(|project| (project.path.clone(), project.book_id.clone()))
    };
    let (path, id) = match opened {
        Some(target) => target,
        None => {
            let path = explicit.map(Path::to_path_buf)
                .or_else(|| settings.last_project.as_ref().map(PathBuf::from))?;
            // A damaged or missing manuscript can still have a registered history.
            let remembered: Vec<_> = settings.book_locations.iter()
                .filter(|location| Path::new(&location.path) == path)
                .collect();
            let readable_id = store::Store::open_readonly(&path).ok()
                .and_then(|store| store.book_id().ok().flatten());
            let id = match (readable_id, remembered.as_slice()) {
                (Some(id), _) => id,
                (None, [location]) => location.book_id.clone(),
                _ => return None,
            };
            (path, id)
        }
    };
    Some((path, id))
}

fn recovery_target(state: &StoreState, data_home: &Path, explicit: Option<&Path>) -> Option<(String, PathBuf)> {
    let (path, id) = protection_subject(state, data_home, explicit)?;
    let settings = projects::read_settings_checked(data_home).ok()?;
    let slug = recovery::target_slug(Some(&path), None, None)?;
    let key = protection::key_for(&settings, &id, protection::Surface::Recovery).ok()?;
    Some((slug, projects::recovery_dir(data_home, &key)))
}

/// What the recovery directory for this window's project currently holds.
///
/// ANSWERS WITH NO PROJECT OPEN, deliberately: the startup-failure screen runs
/// precisely because the mount failed, and a status sentence that could not be
/// composed there is the requirement not met. `target_slug` picks the subject,
/// `describe_dir` reads it; every rule in this body is a call to one of them.
///
/// Never an error. A directory that does not exist, a manifest that will not
/// parse and no resolvable project at all are all reports, because a surface
/// whose job is to explain a failure must not be able to fail itself.
#[command_boundary::command]
fn recovery_status(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
) -> recovery::Report {
    match recovery_target(&state, &data_home.0, explicit.0.as_deref()) {
        Some((slug, dir)) => recovery::describe_dir(&dir, &slug),
        None => recovery::Report::default(),
    }

}

/// Recovery points with a sound database, newest first. Picture-incomplete
/// points require an explicit second restore step.
///
/// Resolved exactly as `recovery_status` is, and like it NEVER AN ERROR: a
/// directory that does not exist, a manifest that will not parse and no
/// resolvable project at all are all empty lists. A panel offering a way out of
/// a damaged project must not itself be able to fail to render.
#[command_boundary::command]
fn recovery_points(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
) -> Vec<recovery::Point> {
    match recovery_target(&state, &data_home.0, explicit.0.as_deref()) {
        Some((_, dir)) => recovery::restorable_points(&dir),
        None => Vec::new(),
    }

}

/// How old the copy that could leave this computer is, and where it sits.
///
/// Resolved exactly as `recovery_status` is, and like it NEVER AN ERROR: the
/// panel that offers a writer their way out of a damaged project must not
/// itself be able to fail to render.
#[command_boundary::command]
fn archive_status(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
) -> recovery::ArchiveReport {
    match recovery_target(&state, &data_home.0, explicit.0.as_deref()) {
        Some((slug, dir)) => recovery::describe_archives(&dir.join("archives"), &slug),
        None => recovery::ArchiveReport::default(),
    }

}

/// The verified archives a writer could carry off this computer, newest first.
#[command_boundary::command]
fn archives(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
) -> Vec<recovery::Archive> {
    match recovery_target(&state, &data_home.0, explicit.0.as_deref()) {
        Some((_, dir)) => recovery::verified_archives(&dir.join("archives")),
        None => Vec::new(),
    }

}

fn capture_archive_source(state: &StoreState, generation: Option<u64>) -> Result<recovery::Source, String> {
    let guard = locked(state);
    let project = open_project(&guard)?;
    if generation.is_some_and(|expected| expected != project.generation) {
        return Err("the open project changed before archiving".into());
    }
    Ok(recovery::Source {
        path: project.path.clone(),
        name: project.name.clone(),
        book_id: project.book_id.clone(),
        registry_home: project.registry_home.clone(),
    })
}

/// Write an archive the writer will move off this computer themselves.
///
/// ON DEMAND ONLY. There is no schedule here and there is not meant to be: the
/// destination is not one this application owns, so it is invoked the way
/// export is -- an explicit action with a visible result.
///
/// It is allowed to fail and it says why. A backup failure is NOT a save
/// failure -- the manuscript is untouched -- so the page reports this through
/// its notice channel and never through the save-failure banner.
///
/// NOT gated on APP_RECOVERY_MODE, for `project_backup_now`'s reason: that knob
/// turns off the triggers a rig boot fires by itself, and refusing a request
/// the writer typed would be the application overruling the person in front of
/// it.
#[command_boundary::command]
fn project_archive_now(
    window: tauri::Window,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    generation: Option<u64>,
) -> std::result::Result<recovery::Archive, String> {
    let source = capture_archive_source(&state, generation)?;
    let _passing = recovery::PASSING.lock().map_err(|_| "recovery is busy")?;
    let (slug, dir) = source.destination(&data_home.0)?;
    let outcome = recovery::take_archive_for_book(
        &source.path, &source.book_id, &slug, &source.name, &dir.join("archives"), store::now_ms(),
    );
    // The recovery area moved -- `archives/` is inside it -- so every surface
    // reading that directory is now stale. On BOTH outcomes, because a failed
    // attempt may still have created the directory.
    let _ = window.emit(RECOVERY_EVENT, ());
    outcome
}

/// Where the readable manuscript is, whether it is on, and how much is there.
///
/// Resolved exactly as `archive_status` is, and like it NEVER AN ERROR.
#[command_boundary::command]
fn mirror_status(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    explicit: State<'_, ExplicitProject>,
    outcome: State<'_, MirrorState>,
    paused: State<'_, MirrorPaused>,
    dirty: State<'_, MirrorDirty>,
    passing: State<'_, MirrorPassing>,
) -> mirror::MirrorReport {
    let Ok(_passing) = passing.0.lock() else { return mirror::MirrorReport::default() };
    let Some((_, id)) = protection_subject(&state, &data_home.0, explicit.0.as_deref()) else {
        return mirror::MirrorReport::default();
    };
    let Ok(settings) = projects::read_settings_checked(&data_home.0) else {
        return mirror::MirrorReport::default();
    };
    let Ok(key) = protection::key_for(&settings, &id, protection::Surface::Mirror) else {
        return mirror::MirrorReport::default();
    };
    let context = mirror_context(&state, &paused);
    let dir = projects::mirror_dir(&data_home.0, root.0.as_deref(), &key);
    let enabled = settings.mirrored_book_ids.contains(&id);
    let digest = context.as_ref().filter(|context| enabled && context.book_id == id)
        .and_then(|context| mirror_identity::capture(
            &context.path, &context.book_id, &context.name, &dir, &data_home.0,
        ).ok().map(|captured| captured.digest));
    mirror::describe_checked(
        &dir,
        enabled,
        &last_outcome(&outcome),
        &context.as_ref().map(|context| paused_ids(&context.paused)).unwrap_or_default(),
        mirror_pending(&dirty),
        digest,
    )
}

/// The change set for one mirror directory against one project file.
///
/// PULLED OUT OF THE COMMAND, because a `#[tauri::command]` body cannot be
/// called from a test and a rule nobody can drive is a rule nobody is checking
/// -- the recorded `preferences_js` shape.
///
/// TAKES A PATH, NEVER THE STORE GUARD. `pass`'s rule, and the recorded
/// deadlock is what makes it one: this opens the project read-only and then
/// walks a directory reading files, and doing that under the mutex would put
/// every save behind it.
///
/// NEVER AN ERROR. A project that will not open read-only and a manifest that
/// will not parse are the same answer as a mirror nobody has touched: there is
/// nothing to say about what changed.
fn changes_in(
    dir: &Path,
    source: &Path,
    found: &mirror::DetectReport,
) -> Vec<mirror::Change> {
    let Ok(store) = store::Store::open_readonly(source) else {
        return Vec::new();
    };
    let (Ok(items), Ok(bodies), Ok(doc_revs)) =
        (store.items(), store.documents(), store.document_revs())
    else {
        return Vec::new();
    };
    drop(store);
    // The pass's filter, restated for the same walk. A change set built over a
    // wider walk than the pass writes would offer the writer rows for files the
    // mirror never made.
    let items = store::manuscript_items(items);
    let entries: Vec<mirror::MirrorEntry> = recovery::read_manifest(dir)
        .map(|m: recovery::Manifest<mirror::MirrorEntry>| m.entries)
        .unwrap_or_default();
    mirror::change_set(dir, &entries, &items, &bodies, &doc_revs, found)
}

/// The testable core of the thorough-check command. A failed check preserves
/// both earlier pauses and every changed or unreadable entry it reached before
/// the failure. Installation happens before this function returns.
fn check_mirror(
    dir: &Path,
    paused: &PauseHandle,
) -> (std::result::Result<mirror::CheckReport, String>, bool) {
    let mut existing = paused_ids(paused);
    let persisted = mirror::persisted_pauses(dir);
    if let Ok(on_disk) = &persisted {
        existing.extend(on_disk.iter().cloned());
    }
    let (report, found, error) = match mirror::check(dir) {
        Ok(result) => (result.report, result.found, None),
        Err(failure) => {
            let mut changed = failure.paused;
            changed.extend(existing);
            changed.sort();
            changed.dedup();
            (
                failure.report,
                mirror::DetectReport {
                    changed,
                    ..Default::default()
                },
                Some(failure.error),
            )
        }
    };
    let moved = install_paused(paused, &found);
    let next: PauseIds = found.changed.iter().cloned().collect();
    let persist_error = persisted
        .err()
        .or_else(|| mirror::persist_pauses(dir, &next).err());
    match error.or(persist_error) {
        Some(error) => (Err(error), moved),
        None => (Ok(report), moved),
    }
}

/// What the writer changed in their folder, as rows the page can render.
///
/// NEVER AN ERROR, on `mirror_status`' rule and for its reason: a mirror that
/// is off, absent or unreadable has nothing to say about what changed, which is
/// exactly an empty change set. A panel offering a writer a view of their own
/// edits must not itself be able to fail to render.
///
/// READS NOTHING BACK INTO THE STORE. There is no accept path in this build and
/// no command here that could become one by accident.
#[command_boundary::command]
fn mirror_changes(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    paused: State<'_, MirrorPaused>,
    passing: State<'_, MirrorPassing>,
) -> Vec<mirror::Change> {
    let Some(context) = mirror_context(&state, &paused) else {
        return Vec::new();
    };
    let Ok(_passing) = passing.0.lock() else {
        return Vec::new();
    };
    let Ok(Some(dir)) = mirror_dir_for(&context, &data_home.0, root.0.as_deref()) else {
        return Vec::new();
    };
    let (found, error, _) = detect_mirror(&dir, &context.paused);
    if error.is_some() {
        return Vec::new();
    }
    changes_in(&dir, &context.path, &found)
}

/// Hash every mirrored file on demand, including files whose size and mtime
/// match the manifest. The numeric response is emitted only after the pause
/// set has been installed under the pass lock, so a following writer cannot
/// overwrite a finding the command has already observed.
#[command_boundary::command]
fn mirror_check(
    window: tauri::Window,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    paused: State<'_, MirrorPaused>,
    passing: State<'_, MirrorPassing>,
) -> std::result::Result<mirror::CheckReport, String> {
    let context = mirror_context(&state, &paused)
        .ok_or_else(|| "no project is open".to_string())?;
    let Ok(_passing) = passing.0.lock() else {
        return Err("the readable folder check is unavailable".to_string());
    };
    let Some(dir) = mirror_dir_for(&context, &data_home.0, root.0.as_deref())?
    else {
        return Err("the readable folder is off for this project".to_string());
    };
    let (result, moved) = check_mirror(&dir, &context.paused);
    if moved || result.is_err() {
        let _ = window.emit(MIRROR_EVENT, ());
    }
    result
}

/// Take the words the writer changed in their folder INTO their book.
///
/// **THE ONE COMMAND IN THIS APPLICATION THAT WRITES A BODY THE WRITER DID NOT
/// TYPE.** It is the fourth body-rewrite path, which plan 001's write-back
/// names in advance as where its defect class returns, and every guard on it is
/// there because of that:
///
///  - The page names IDS and nothing else. There is no argument that carries a
///    body, a path or a revision, so nothing the webview sends can decide what
///    is written -- only which of the rows the host itself derived is taken.
///  - The change set is rebuilt HERE rather than trusted from the panel's last
///    read, and `accept_plan` refuses any id whose row is not applicable.
///  - The store guard is taken AFTER the directory work and dropped BEFORE it.
///    `pass`'s rule and the recorded deadlock behind it: this reads files.
///
/// After the write the manifest is settled and the pauses are dropped, so the
/// next pass writes nothing for what it has just taken in.
#[command_boundary::command]
fn mirror_accept(
    window: tauri::Window,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    paused: State<'_, MirrorPaused>,
    passing: State<'_, MirrorPassing>,
    ids: Vec<String>,
) -> std::result::Result<AcceptOutcome, String> {
    let context = mirror_context(&state, &paused)
        .ok_or_else(|| "no project is open".to_string())?;
    // NO LOCK HELD. This opens the project read-only and then walks a directory
    // reading files; doing it under the mutex would put every save behind it.
    let Ok(_passing) = passing.0.lock() else {
        return Err("the readable folder is busy".to_string());
    };
    let dir = mirror_dir_for(&context, &data_home.0, root.0.as_deref())?
        .ok_or_else(|| "the readable folder is off for this project".to_string())?;
    let (found, error, _) = detect_mirror(&dir, &context.paused);
    if let Some(error) = error {
        return Err(error);
    }
    let rows = changes_in(&dir, &context.path, &found);

    let outcome = {
        let mut guard = locked(&state);
        if !guard
            .as_ref()
            .is_some_and(|project| project.generation == context.generation)
        {
            return Err("the open project changed while reading the readable folder".to_string());
        }
        accept_into(open_project_mut(&mut guard)?, &rows, &ids)?
    };

    // AFTER THE COMMIT AND OUTSIDE THE LOCK. The words are in the book either
    // way; a failure to bring the manifest into step costs one redundant pass,
    // and reporting it as a failed accept would tell the writer their words did
    // not land when they did.
    let settled = mirror::settle_accepted(
        &dir,
        &outcome.paths,
        &outcome.report.documents,
        store::now_ms(),
    );
    match settled {
        Err(error) => eprintln!("mirror: could not settle the accepted files: {error}"),
        Ok(()) => {
            let resolved: PauseIds = outcome
                .report
                .documents
                .iter()
                .map(|landed| landed.item_id.clone())
                .collect();
            match mirror::clear_persisted_pauses(&dir, &resolved) {
                Ok(()) => {
                    if let Ok(mut set) = context.paused.lock() {
                        set.retain(|id| !resolved.contains(id));
                    }
                }
                Err(error) => eprintln!("mirror: could not clear accepted pauses: {error}"),
            }
        }
    }
    let _ = window.emit(MIRROR_EVENT, ());
    Ok(outcome)
}

#[command_boundary::command]
fn mirror_undo_accept(
    window: tauri::Window,
    state: State<'_, StoreState>,
    dirty: State<'_, MirrorDirty>,
    generation: u64,
    item_id: String,
    version_id: i64,
    snapshot_id: i64,
    accepted_rev: i64,
) -> std::result::Result<store::history::RestoredDoc, String> {
    let (restored, emit) = {
        let mut guard = locked(&state);
        let restored = undo_mirror_accept_into(
            open_project_mut(&mut guard)?,
            generation,
            &item_id,
            version_id,
            snapshot_id,
            accepted_rev,
        )?;
        let emit = mark_mirror_dirty(&dirty);
        (restored, emit)
    };
    if emit {
        let _ = window.emit(MIRROR_EVENT, ());
    }
    Ok(restored)
}

#[cfg(test)]
fn pass_mirror(
    context: &MirrorContext,
    data_home: &Path,
    root: Option<&Path>,
    passing: &std::sync::Mutex<()>,
    now: i64,
) -> std::result::Result<mirror::PassReport, String> {
    let _passing = passing
        .lock()
        .map_err(|_| "the readable folder is busy".to_string())?;
    pass_mirror_while_held(context, data_home, root, now)
}

fn pass_mirror_while_held(
    context: &MirrorContext,
    data_home: &Path,
    root: Option<&Path>,
    now: i64,
) -> std::result::Result<mirror::PassReport, String> {
    held_wordlist_fails(pass_scenes_while_held(context, data_home, root, now)?)
}

/// The scenes and the manifest are already current. A held wordlist still
/// fails the pass, so the status names it rather than reporting the folder as
/// fully up to date.
fn held_wordlist_fails(
    report: mirror::PassReport,
) -> std::result::Result<mirror::PassReport, String> {
    match report.wordlist.problem() {
        Some(problem) => Err(problem.to_string()),
        None => Ok(report),
    }
}

/// What the enable act records for the status, and what it returns to the
/// writer who pressed it. A held wordlist is the status's to name: the setting
/// is saved and the scenes are written, so the act itself succeeded.
fn enable_outcome(
    pass: std::result::Result<mirror::PassReport, String>,
) -> (std::result::Result<(), String>, std::result::Result<(), String>) {
    match pass {
        Ok(report) => (held_wordlist_fails(report).map(|_| ()), Ok(())),
        Err(error) => (Err(error.clone()), Err(error)),
    }
}

fn pass_scenes_while_held(
    context: &MirrorContext,
    data_home: &Path,
    root: Option<&Path>,
    now: i64,
) -> std::result::Result<mirror::PassReport, String> {
    let dir = mirror_dir_for(context, data_home, root)?
        .ok_or_else(|| "the readable folder is off for this project".to_string())?;
    // AFTER the pass lock. A thorough check may have discovered an edit while
    // this writer waited, and this snapshot must see the installed pause.
    let paused = paused_ids(&context.paused);
    let report = mirror::pass_for_book(
        &context.path,
        &context.book_id,
        &recovery::target_slug(Some(&context.path), None, None).ok_or("book has no usable file name")?,
        &context.name,
        &dir,
        now,
        &paused,
    )?;
    let captured = if report.wordlist.problem().is_some() || report.paused {
        Err("the mirror contents were not fully checked".to_string())
    } else {
        mirror_identity::capture(&context.path, &context.book_id, &context.name, &dir, data_home)
    };
    if mirror_identity::record_after_pass(&dir, now, captured.as_ref().map_err(Clone::clone), &report).is_err() {
        eprintln!("mirror identity disclosure record could not be updated");
    }
    Ok(report)
}

/// Turn the readable mirror on or off for the open project.
///
/// THE ENABLE ACT, and it is deliberate on purpose. The design puts the gate
/// here -- after the layout that says what will be written and before the bound
/// that says how often -- because those are the two facts the writer is
/// consenting to. Enabling runs the first pass immediately rather than waiting
/// out the bound, so the writer who says yes can go and look.
///
/// Turning on requires a matching host preview. The private vault is never
/// serialized into the page token; every projected byte is rechecked here.
///
/// Disabling LEAVES THE FILES. They are the writer's manuscript in their own
/// folder; deleting a directory of prose because a preference was switched off
/// is not a thing this application gets to do.
#[command_boundary::command]
fn mirror_preview(
    expected_generation: u64,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    paused: State<'_, MirrorPaused>,
    passing: State<'_, MirrorPassing>,
    previews: State<'_, MirrorPreviewState>,
) -> std::result::Result<mirror_identity::Preview, String> {
    let context = mirror_context(&state, &paused).ok_or_else(|| NO_PROJECT.to_string())?;
    if context.generation != expected_generation {
        return Err("the open book changed; preview the readable folder again".into());
    }
    let _passing = passing.0.lock().map_err(|_| "the readable folder is busy")?;
    let settings = projects::read_settings_checked(&data_home.0)?;
    require_mirror_canonical(&context, &settings)?;
    let key = protection::key_for(&settings, &context.book_id, protection::Surface::Mirror)?;
    let dir = projects::mirror_dir(&data_home.0, root.0.as_deref(), &key);
    let mut captured = mirror_identity::capture(
        &context.path, &context.book_id, &context.name, &dir, &data_home.0,
    )?;
    let current = mirror_context(&state, &paused).ok_or_else(|| NO_PROJECT.to_string())?;
    if current.generation != context.generation || current.path != context.path
        || current.book_id != context.book_id || current.name != context.name {
        return Err("the open book changed; preview the readable folder again".into());
    }
    let token = uuid::Uuid::now_v7().to_string();
    *previews.0.lock().map_err(|_| "mirror preview is busy")? = Some(MirrorPreviewTicket {
        token: token.clone(), path: context.path, book_id: context.book_id,
        generation: context.generation, dir, digest: captured.digest,
    });
    captured.preview.token = Some(token);
    Ok(captured.preview)
}

#[command_boundary::command]
fn mirror_enable(
    window: tauri::Window,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    dirty: State<'_, MirrorDirty>,
    outcome: State<'_, MirrorState>,
    paused: State<'_, MirrorPaused>,
    passing: State<'_, MirrorPassing>,
    previews: State<'_, MirrorPreviewState>,
    on: bool,
    token: Option<String>,
) -> std::result::Result<mirror::MirrorReport, String> {
    let context = mirror_context(&state, &paused).ok_or_else(|| NO_PROJECT.to_string())?;
    // A pass owns `MirrorPassing` through its completion state too. Resetting
    // under that lock keeps an older pass from clearing this toggle's interval.
    let _passing = passing
        .0
        .lock()
        .map_err(|_| "the readable folder is busy".to_string())?;
    let verified_dir = if on {
        let ticket = previews.0.lock().map_err(|_| "mirror preview is busy")?.take()
            .ok_or("preview the readable folder before enabling it")?;
        let current = mirror_context(&state, &paused).ok_or_else(|| NO_PROJECT.to_string())?;
        if !preview_owner_matches(&ticket, &current, token.as_deref())
            || current.name != context.name {
            return Err("the open book changed; preview the readable folder again".into());
        }
        let settings = projects::read_settings_checked(&data_home.0)?;
        require_mirror_canonical(&current, &settings)?;
        let key = protection::key_for(&settings, &current.book_id, protection::Surface::Mirror)?;
        let current_dir = projects::mirror_dir(&data_home.0, root.0.as_deref(), &key);
        let captured = mirror_identity::capture(&current.path, &current.book_id, &current.name, &current_dir, &data_home.0)?;
        if !preview_content_matches(&ticket, &current_dir, captured.digest) {
            return Err("the readable folder preview is stale; preview it again".into());
        }
        Some(ticket.dir)
    } else { None };
    let mut dir = None;
    projects::update_settings_checked(&data_home.0, |settings| {
        require_mirror_canonical(&context, settings)?;
        let key = protection::key_for(settings, &context.book_id, protection::Surface::Mirror)?;
        if on {
            let candidate = projects::mirror_dir(&data_home.0, root.0.as_deref(), &key);
            if verified_dir.as_deref() != Some(candidate.as_path()) {
                return Err("the readable folder preview is stale; preview it again".into());
            }
        }
        settings.mirrored_book_ids.retain(|id| id != &context.book_id);
        if on {
            settings.mirrored_book_ids.push(context.book_id.clone());
        }
        dir = Some(projects::mirror_dir(&data_home.0, root.0.as_deref(), &key));
        Ok(())
    })?;
    let dir = dir.expect("mirror directory is set with settings");
    // The act still belongs to the captured book if the writer switched while
    // it waited. Only the current book's pending state may be reset or reported.
    let current = reset_mirror_dirty_if_current(&state, &paused, &dirty, &context);
    if on {
        // RECORDED THROUGH THE SAME OUTCOME the background pass writes, and
        // then still returned as an error. The writer who just pressed the
        // button gets told directly; the indicator gets told the same thing, so
        // the two surfaces cannot disagree about whether the mirror is failing.
        // A held wordlist alone is recorded and not returned: `enable_outcome`.
        let now = store::now_ms();
        if begin_mirror_pass_if_current(&state, &paused, &dirty, &context) {
            let _ = window.emit(MIRROR_EVENT, ());
        }
        let (result, act) =
            enable_outcome(pass_scenes_while_held(&context, &data_home.0, root.0.as_deref(), now));
        let completed = finish_mirror_pass(
            &state, &paused, &dirty, &outcome, &context, result, now,
        );
        if completed {
            let _ = window.emit(MIRROR_EVENT, ());
        }
        act?;
    }
    let digest = on.then(|| mirror_identity::capture(
        &context.path, &context.book_id, &context.name, &dir, &data_home.0,
    ).ok().map(|captured| captured.digest)).flatten();
    let report = mirror::describe_checked(
        &dir,
        on,
        &last_outcome(&outcome),
        &paused_ids(&context.paused),
        mirror_pending(&dirty),
        digest,
    );
    if !on && current {
        let _ = window.emit(MIRROR_EVENT, ());
    }
    Ok(report)
}

/// Restore a recovery point as a NEW project in the library.
///
/// NOTHING EXISTING IS TOUCHED -- not the point, not the project it came from,
/// not whatever this window has open. Guessing which of two real states of a
/// book is the live one silently discards the newer, so both sit in the library
/// and the writer decides by looking at them. This command cannot overwrite a
/// project and there is no argument that would let it.
///
/// THE PAGE NAMES A POINT BY ID, NEVER BY PATH, and the id is resolved against
/// the manifest inside the recovery directory this window's project owns.
/// `project_import` refuses anything but a bare filename and `project_export`
/// declines a destination argument outright; a path supplied by the webview
/// holding the manuscript is the crossing neither of them would make.
///
/// OFF THE MUTEX, the same discipline as the schedule and the manual backup:
/// the open project's path comes out under the guard, the guard drops with that
/// block, and `restore_point_into` takes paths and structurally cannot re-take
/// the lock. Neither file it touches is the open project.
///
/// It does NOT emit `app://recovery-changed`. That event means the recovery
/// directory moved, and a restore reads it without writing to it; the surface
/// that changed is the library, and the panel that asked for the restore
/// reloads it. One event with one meaning.
///
/// INTO THE SAME REMEMBERED FOLDER `project_create` uses, not the hidden
/// library (159's open decision, `project_import`'s reason restated): a
/// restored point is a new project, and this slice's contract is that a new
/// project is not hidden by default.
#[command_boundary::command]
fn project_restore_point(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
    point_id: String,
    allow_picture_gaps: Option<bool>,
) -> std::result::Result<projects::ProjectSummary, String> {
    let (slug, recovery_dir) = recovery_target(&state, &data_home.0, explicit.0.as_deref())
        .ok_or_else(|| "there is no registered book to restore a recovery point for".to_string())?;
    let allow_picture_gaps = allow_picture_gaps.unwrap_or(false);
    let point = recovery::restorable_point_path(&recovery_dir, &point_id, allow_picture_gaps)
        .ok_or_else(|| format!("{point_id} is not a restorable recovery point"))?;
    let dest = new_book_dir(&data_home.0)?;
    let restored = if allow_picture_gaps {
        let (summary, gaps) = projects::restore_point_with_picture_gaps(&point, &dest, &slug, store::now_ms())?;
        if !gaps.is_empty() {
            eprintln!("recovery: restored project with picture gaps: {}", gaps.join(", "));
        }
        summary
    } else {
        projects::restore_point_into(&point, &dest, &slug, store::now_ms())?
    };
    remember_created_in(&data_home.0, &dest, &restored.path);
    Ok(restored)
}

/// The writer asked for a recovery point now.
///
/// OFF THE MUTEX, the same discipline as the schedule: the path and name come
/// out under the guard, the guard drops with that block, and `recovery::attempt`
/// takes a path and structurally cannot re-take the lock.
///
/// It is allowed to fail and it says why. A backup failure is NOT a save
/// failure -- the manuscript is untouched -- so the page reports this through
/// its notice channel and never through the save-failure banner.
///
/// NOT gated on APP_RECOVERY_MODE. That knob turns off the triggers a rig boot
/// fires by itself; refusing a request the writer typed would be the
/// application overruling the person in front of it.
#[command_boundary::command]
fn project_backup_now(
    window: tauri::Window,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
) -> std::result::Result<recovery::Point, String> {
    let source = recovery::Source::capture(&state).ok_or(NO_PROJECT)?;
    let _passing = recovery::PASSING.lock().map_err(|_| "recovery is busy")?;
    let (slug, dir) = source.destination(&data_home.0)?;
    let outcome = recovery::attempt_in_dir(
        &source.path, &source.name, &slug, &dir, store::now_ms(),
        |path, slug, name, dir, now| recovery::take_point_for_book(path, &source.book_id, slug, name, dir, now),
    );
    // On BOTH outcomes: a failed attempt moved the status file too, and the
    // surface describing it is now stale either way.
    let _ = window.emit(RECOVERY_EVENT, ());
    outcome
}

/// The page has flushed everything it had. Take the last recovery point and let
/// the window go.
///
/// SYNCHRONOUS, BEFORE THE CLOSE, and not on a background thread. A thread
/// would race process exit and could leave an unverified partial `.db` in the
/// one directory whose entire value is that everything in it has been read
/// back -- and no manifest would describe it.
///
/// The cost, stated rather than hidden: the close is delayed by one
/// `VACUUM INTO`, measured at 23.6-24.5 ms against the 15,200-document stress
/// fixture under a concurrent writer, and unbounded in principle on a slow
/// disk. Accepted, because the alternative is a partial artifact in the
/// recovery directory.
///
/// The point is taken through `recovery::tick`, which is the schedule's own
/// path: same target resolution, same lock discipline (the guard is taken and
/// dropped inside it, and the copy runs off-mutex), same status file. An error
/// is printed and never surfaced -- a backup failure is not a save failure and
/// must not stand between a writer and a closed window.
#[command_boundary::command]
fn confirm_close(
    window: tauri::Window,
    attempt: u64,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    root: State<'_, MirrorRoot>,
    close_point: State<'_, ClosePoint>,
    paused: State<'_, MirrorPaused>,
    passing: State<'_, MirrorPassing>,
) {
    window.state::<close_state::CloseState>().confirm(
        attempt,
        || {
            let guard = locked(&state);
            if let Some(project) = guard.as_ref() {
                if let Some(runtime) = project.analytics.as_ref() {
                    if let Err(error) = project.store.analytics_end(runtime) {
                        eprintln!("analytics: could not end the closing session: {error}");
                    }
                }
            }
            drop(guard);
            close_cleanly(close_point.0, || {
                recovery::tick(&state, &data_home.0, store::now_ms(), recovery::take_point_for_book);
                // "The mirror is exactly current at a clean project close" is half
                // of the design's staleness promise, and it is the half a bound
                // cannot deliver: a writer who types a sentence and quits inside
                // the ten seconds would otherwise leave with a folder that is
                // missing it.
                //
                // BEFORE `window.close()` for `take_point`'s reason -- closing
                // tears down the webview and lets the process go, so a pass started
                // beside it races exit and leaves a half-written manuscript in the
                // one directory the writer was told to trust.
                //
                // Gated on the same `close_point` knob as the recovery point so a
                // measurement run cannot be written into by the close, and skipped
                // entirely unless the writer enabled the mirror for this project.
                // THE PAUSED SET IS HONOURED ON THE WAY OUT TOO. A close pass
                // that ignored it would overwrite the writer's external edit at
                // exactly the moment they can no longer see it happen.
                mirror_at_close(
                    &state,
                    &data_home.0,
                    root.0.as_deref(),
                    &paused,
                    &passing.0,
                );
            }, || {});
        },
        || {
            let _ = window.close();
        },
    );
}

/// The open-time scan, on its own thread.
///
/// NEVER A PRECONDITION FOR OPENING THE PROJECT (design `:487-491`). The
/// project is already open and the window already up when this starts; the
/// cold-cache cost of a first stat pass over a mirror the kernel has never seen
/// is explicitly unmeasured, and this shape is what makes that cost land on the
/// mirror status line rather than on the writer waiting for their book.
///
/// SPAWNED ON EVERY OPEN, including a switch, and it clears the pause set even
/// when the mirror is off for the project being opened -- otherwise the
/// previous project's paused ids would outlive it.
fn spawn_mirror_scan(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let (Some(state), Some(home), Some(root), Some(pause), Some(passing)) = (
            handle.try_state::<StoreState>(),
            handle.try_state::<DataHome>(),
            handle.try_state::<MirrorRoot>(),
            handle.try_state::<MirrorPaused>(),
            handle.try_state::<MirrorPassing>(),
        ) else {
            return;
        };
        // The path comes off the store and the guard is DROPPED before the
        // scan, which is `pass`'s rule and holds here for the same reason:
        // stage 2 reads files, and a scan holding the store mutex would put
        // every save behind a directory walk.
        let Some(context) = mirror_context(&state, &pause) else {
            return;
        };
        let Ok(_passing) = passing.0.lock() else { return };
        let dir = match mirror_dir_for(&context, &home.0, root.0.as_deref()) {
            Ok(dir) => dir,
            Err(error) => { eprintln!("mirror scan: {error}"); return; }
        };
        let found = if let Some(dir) = dir {
            let (found, error, moved) = detect_mirror(&dir, &context.paused);
            if moved {
                let _ = handle.emit(MIRROR_EVENT, ());
            }
            if error.is_some() {
                return;
            }
            found
        } else {
            // Off for this project: there is nothing on disk to compare against
            // and nothing to pause. Installed anyway, so a switch away from a
            // mirrored project does not leave its pauses standing.
            mirror::DetectReport::default()
        };
        // Installs into the captured project's handle. A switch may have
        // replaced the current handle while the directory walk ran, but it
        // cannot redirect this result into the new project.
        let installed = install_paused(&context.paused, &found);
        if installed {
            let _ = handle.emit(MIRROR_EVENT, ());
        }
    });
}

/// The mirror directory of the open project, if the mirror is on for it.
///
/// Every caller holds `MirrorPassing` before resolving this. The settings and
/// canonical source are therefore checked immediately before a scan or write.
fn open_mirror_dir(
    state: &State<'_, StoreState>,
    paused: &MirrorPaused,
    data_home: &Path,
    root: Option<&Path>,
    passing: &std::sync::Mutex<()>,
) -> Option<PathBuf> {
    let context = mirror_context(state, paused)?;
    let _passing = passing.lock().ok()?;
    mirror_dir_for(&context, data_home, root).ok().flatten()
}

fn require_mirror_canonical(
    context: &MirrorContext,
    settings: &projects::Settings,
) -> Result<(), String> {
    if context.registry_home.is_some() {
        book_open::require_canonical(settings, &context.book_id, &context.path)?;
    }
    let reader = store::Store::open_readonly(&context.path).map_err(|error| error.to_string())?;
    if project_book_id(&reader)? != context.book_id {
        return Err("the readable folder source identity changed; reopen the book".into());
    }
    Ok(())
}

fn mirror_dir_for(
    context: &MirrorContext,
    data_home: &Path,
    root: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let settings = projects::read_settings_checked(data_home)?;
    require_mirror_canonical(context, &settings)?;
    if !settings.mirrored_book_ids.contains(&context.book_id) {
        return Ok(None);
    }
    let key = protection::key_for(&settings, &context.book_id, protection::Surface::Mirror)?;
    Ok(Some(projects::mirror_dir(data_home, root, &key)))
}

/// Stage 3: notice an external edit while the window is open, sooner than the
/// next open would.
///
/// AN OPTIMIZATION AND NEVER THE GUARANTEE, and the reason no tuning fixes:
/// the case that matters is a writer who edited the file while the application
/// was CLOSED, and a watcher sees nothing then. Everything here may fail --
/// no inotify instance, a watch that could not be added, a directory created
/// after the walk -- and the mirror is still correct, because the scan at open
/// is what makes a change noticed at all.
///
/// One instance, one watch per directory: 3,778 watches for the `stress`
/// fixture against 524,288 available, so 0.7% of the budget.
///
/// The whole instance is REBUILT rather than unwatched piecemeal, on a switch
/// and after every scan. Dropping watch descriptors individually is bookkeeping
/// that buys nothing: an inotify instance is one file descriptor, the walk that
/// re-arms it is the 20 ms one the design already measured, and it runs at most
/// once per settled batch. That choice is also what handles the directory
/// creation race the design flags -- a container that appeared unwatched is
/// watched from the next scan on, and until then the scan covers it.
#[cfg(target_os = "linux")]
fn spawn_mirror_watcher(app: &tauri::AppHandle) {
    use inotify::WatchMask;

    /// How often the watcher asks whether the project or the preference moved.
    /// A switch noticed a second late costs nothing: the scan at open has
    /// already run by then, and the pass bound is ten times longer.
    const ARM_RECHECK_MS: i64 = 1_000;

    let handle = app.clone();
    std::thread::spawn(move || {
        let Ok(mut instance) = inotify::Inotify::init() else {
            // Never fatal. A machine out of inotify instances still gets a
            // mirror that notices external edits at open, which is the
            // guarantee; it just does not notice them sooner.
            eprintln!("mirror: no watcher available; the scan at open still covers this");
            return;
        };
        // What an editor's save looks like from outside: the write itself, the
        // rename-into-place many editors use, and the delete of the file it
        // replaced. CREATE and DELETE also cover directories, which is what
        // tells the re-arm that the tree's shape moved.
        let mask = WatchMask::MODIFY
            | WatchMask::CLOSE_WRITE
            | WatchMask::MOVED_TO
            | WatchMask::MOVED_FROM
            | WatchMask::CREATE
            | WatchMask::DELETE;
        let mut buffer = [0u8; 4096];
        let mut armed: Option<PathBuf> = None;
        let mut want: Option<PathBuf> = None;
        let mut checked_at: Option<i64> = None;
        let mut pending_since: Option<i64> = None;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let (Some(state), Some(home), Some(root), Some(pause), Some(passing)) = (
                handle.try_state::<StoreState>(),
                handle.try_state::<DataHome>(),
                handle.try_state::<MirrorRoot>(),
                handle.try_state::<MirrorPaused>(),
                handle.try_state::<MirrorPassing>(),
            ) else {
                return;
            };
            let now = store::now_ms();
            // `open_mirror_dir` reads `settings.json`, and the tick is a
            // quarter second: asking it every time would put four small reads a
            // second on the writer's disk forever, to notice a switch or a
            // preference change that a whole second late is indistinguishable
            // from at once. Events are still drained every tick.
            if checked_at.is_none_or(|at| now < at || now - at >= ARM_RECHECK_MS) {
                checked_at = Some(now);
                want = open_mirror_dir(&state, &pause, &home.0, root.0.as_deref(), &passing.0);
            }
            let want = want.clone();

            if armed != want {
                let Ok(fresh) = inotify::Inotify::init() else {
                    continue;
                };
                instance = fresh;
                pending_since = None;
                if let Some(dir) = want.as_deref() {
                    for d in mirror::watch_dirs(dir) {
                        // A watch that could not be added is a directory this
                        // thread is blind to and NOTHING ELSE. Reporting it
                        // would tell the writer their mirror is broken when the
                        // scan still covers it exactly as before.
                        let _ = instance.watches().add(&d, mask);
                    }
                }
                armed = want.clone();
            }
            let Some(dir) = want else { continue };

            // Drained, never acted on individually. The events say only THAT
            // something under the mirror moved; what moved is the scan's
            // answer, and taking it from the event stream would make the
            // watcher the thing that decides what changed -- which is the
            // design's stated failure mode, working perfectly in every test and
            // blind in the ordinary case.
            match instance.read_events(&mut buffer) {
                Ok(events) => {
                    if events.count() > 0 {
                        pending_since.get_or_insert(now);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => continue,
            }

            if !mirror::settled(pending_since, now) {
                continue;
            }
            let Some(context) = mirror_context(&state, &pause) else {
                continue;
            };
            // HELD ACROSS THE SCAN, and this is the load-bearing half. A pass
            // writes every changed file and THEN the manifest; a scan that ran
            // in between would compare the new files against the old manifest,
            // call the application's own writes external edits, and pause the
            // very entries it had just written -- silently, until the next
            // open. The pass takes this lock for its whole duration, so a
            // watcher that cannot take it has nothing valid to compare against
            // yet and waits.
            let Ok(_guard) = passing.0.try_lock() else {
                continue;
            };
            let Ok(Some(current_dir)) = mirror_dir_for(&context, &home.0, root.0.as_deref()) else {
                pending_since = None;
                armed = None;
                checked_at = None;
                continue;
            };
            if current_dir != dir {
                pending_since = None;
                armed = None;
                checked_at = None;
                continue;
            }
            let (_found, error, installed) = detect_mirror(&current_dir, &context.paused);
            if installed {
                let _ = handle.emit(MIRROR_EVENT, ());
            }
            if error.is_some() {
                pending_since = None;
                armed = None;
                checked_at = None;
                continue;
            }
            pending_since = None;
            // Re-armed after the scan, because the shape of the tree may have
            // moved under it. Forces the `armed != want` branch on the next
            // tick rather than duplicating the walk here.
            armed = None;
            checked_at = None;
        }
    });
}

/// One exact pass on the way out, or nothing.
///
/// A free function for `close_cleanly`'s reason: a `#[tauri::command]` body
/// cannot be called from a test.
fn mirror_at_close(
    state: &State<'_, StoreState>,
    data_home: &Path,
    root: Option<&Path>,
    paused: &MirrorPaused,
    passing: &std::sync::Mutex<()>,
) {
    let Some(context) = mirror_context(state, paused) else {
        return;
    };
    let result = (|| {
        let _passing = passing.lock().map_err(|_| "the readable folder is busy".to_string())?;
        if mirror_dir_for(&context, data_home, root)?.is_none() { return Ok(()); }
        pass_mirror_while_held(&context, data_home, root, store::now_ms()).map(|_| ())
    })();
    if let Err(e) = result {
        // Printed, never surfaced: a mirror failure is not a save failure and
        // must not stand between a writer and a closed window.
        eprintln!("mirror: close pass failed: {e}");
    }
}

/// The ORDER a clean close runs in, pulled out of `confirm_close` because a
/// `#[tauri::command]` body cannot be called from a test and an ordering nobody
/// can drive is an ordering nobody is checking.
///
/// Taking the point first is the whole point of the sequence: `window.close()`
/// tears down the webview and lets the process go, so a copy started beside it
/// races exit and leaves an unverified half-file in the one directory whose
/// value is that everything in it has been read back.
fn close_cleanly(wanted: bool, take_point: impl FnOnce(), close: impl FnOnce()) {
    if wanted {
        take_point();
    }
    close();
}

/// The page is asking the writer what to do about unsaved work and is
/// deliberately holding the close open. This prevents the 2 s fallback.
///
/// The cost, stated rather than hidden: a page that calls this and then
/// crashes, or never resolves the prompt, leaves a window that will not close
/// on its own until the writer answers or force-quits some other way. The
/// wedged-webview guarantee still holds for a page that never calls this at
/// all.
#[command_boundary::command]
fn holding_close(window: tauri::Window, attempt: u64) {
    window.state::<close_state::CloseState>().hold(attempt);
}

/// The writer asked to leave, from the File menu or with Ctrl+Q.
///
/// The whole body is `window.close()`, and that is the correct implementation
/// rather than a stub. Tauri delivers `CloseRequested` for a programmatic close,
/// so this enters the SAME path a click on the title bar's X enters: the window
/// size is recorded, the close is prevented, `CLOSE_EVENT` goes to the page, and
/// the 2 s fallback is armed. Nothing about the flush, the unsaved-work prompt,
/// the close state or clean-close point is restated here.
///
/// NOT `confirm_close`, which only approves an existing close attempt.
///
/// Until this command existed there was NO route out of this application from
/// inside it, and the unsaved-work prompt built by plans 011 and 012 could be
/// reached only through the window manager.
#[command_boundary::command]
fn request_quit(window: tauri::Window) {
    let _ = window.close();
}

/// The writer declined the close at the unsaved-work prompt. The next request
/// starts a new attempt and asks again.
#[command_boundary::command]
fn release_close(window: tauri::Window, attempt: u64) {
    window.state::<close_state::CloseState>().release(attempt);
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html",
        Some("js") | Some("mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}

// This source is compiled into the host; a replaced APP_DIST document cannot
// authorize its own scripts. The UI build copies index.html without rewriting it.
const APPDIST_INDEX: &str = include_str!("../../../ui/index.html");
const APPDIST_DENY_CSP: &str = "default-src 'none'; script-src 'none'; style-src 'none'";

fn appdist_theme_hash() -> String {
    use sha2::{Digest, Sha256};
    let head = APPDIST_INDEX.split_once("</head>").expect("interface head").0;
    let script = head.split_once("<script>").expect("theme boot script").1
        .split_once("</script>").expect("theme boot script end").0;
    format!("'sha256-{}'", pictures::base64(&Sha256::digest(script.as_bytes())))
}

fn appdist_csp(configured: Option<&tauri::utils::config::Csp>) -> Option<tauri::http::HeaderValue> {
    use tauri::utils::config::{Csp, CspDirectiveSources};
    let mut directives: std::collections::HashMap<String, CspDirectiveSources> =
        configured?.clone().into();
    let fallback = directives.get("default-src")?.clone();
    let script = directives.entry("script-src".into()).or_insert(fallback);
    // Never silently turn an unrestricted inline policy into a trusted one.
    let sources: Vec<String> = script.clone().into();
    if sources.iter().any(|source| source == "'unsafe-inline'") {
        return None;
    }
    let hash = appdist_theme_hash();
    script.push(&hash);
    if let Some(elements) = directives.get_mut("script-src-elem") {
        let sources: Vec<String> = elements.clone().into();
        if sources.iter().any(|source| source == "'unsafe-inline'") {
            return None;
        }
        elements.push(&hash);
    }
    tauri::http::HeaderValue::from_str(&Csp::from(directives).to_string()).ok()
}

fn appdist_response(
    assets: &AssetRoot,
    path: &str,
    configured: Option<&tauri::utils::config::Csp>,
) -> tauri::http::Response<Vec<u8>> {
    let policy = appdist_csp(configured);
    let rel = if path == "/" { "index.html" } else { path.strip_prefix('/').unwrap_or(path) };
    let (status, mime, body) = match assets {
        AssetRoot::Found(dir) => match appdist_asset_path(dir, rel)
            .and_then(|full| fs::read(&full).ok().map(|bytes| (full, bytes))) {
            Some((full, bytes)) => (200, Some(mime_for(&full)), bytes),
            None => (404, None, Vec::new()),
        },
        AssetRoot::Missing(tried) if rel == "index.html" =>
            (200, Some("text/html"), missing_assets_page(tried).into_bytes()),
        AssetRoot::Missing(_) => (404, None, Vec::new()),
    };
    // A missing or malformed configured policy must never serve an HTML page
    // without protection. Empty failures also deny all document content.
    let (status, mime, body) = if mime == Some("text/html") && policy.is_none() {
        (500, None, Vec::new())
    } else {
        (status, mime, body)
    };
    let mut response = tauri::http::Response::builder().status(status)
        .header("Content-Security-Policy", policy.unwrap_or_else(||
            tauri::http::HeaderValue::from_static(APPDIST_DENY_CSP)));
    if let Some(mime) = mime {
        response = response.header("Content-Type", mime);
    }
    response.body(body).expect("valid appdist response")
}

fn appdist_asset_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty() || relative.contains('\\') || relative.contains(':')
        || path.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let full = root.join(path).canonicalize().ok()?;
    (full.starts_with(&root) && full.is_file()).then_some(full)
}

#[derive(Debug, PartialEq, Eq)]
enum AssetRoot {
    Found(PathBuf),
    /// Every path tried, in order. Carried rather than discarded because the
    /// only useful thing to say about a build with no assets is where it looked.
    Missing(Vec<PathBuf>),
}

/// Where the built page lives. Resolved ONCE at startup and never per request:
/// the previous version re-read APP_DIST on every asset fetch and fell back to
/// the literal "dist", relative to the CURRENT WORKING DIRECTORY. Launched from
/// anywhere but the repo root, every asset 404'd and the window came up blank
/// with nothing on stderr -- the worst failure available, because it looks like
/// a broken application rather than a mislaunched one.
///
/// Pure and fully argued, `current_exe` included, so a test can drive every
/// branch without being the process it is testing.
///
/// An explicit `env_dist` does NOT fall through when it holds no build. The
/// harness names a per-run staged copy; answering from a different build that
/// happens to lie beside the binary would mean a graded run measuring something
/// other than what it staged.
fn resolve_asset_root(env_dist: Option<&Path>, exe: Option<&Path>) -> AssetRoot {
    let is_build = |dir: &Path| dir.join("index.html").is_file();

    if let Some(dir) = env_dist {
        return if is_build(dir) {
            AssetRoot::Found(dir.to_path_buf())
        } else {
            AssetRoot::Missing(vec![dir.to_path_buf()])
        };
    }

    let Some(exe_dir) = exe.and_then(Path::parent) else {
        return AssetRoot::Missing(Vec::new());
    };
    let mut candidates = vec![
        exe_dir.join("dist"),
        // The repo layout, so a `cargo build` binary at
        // app/shell-tauri/src-tauri/target/release/ finds app/ui/dist with no
        // env var. Four levels up, counted: release -> target -> src-tauri ->
        // shell-tauri -> app. A development convenience, and only that.
        exe_dir.join("../../../../ui/dist"),
    ];
    // macOS seals resources separately from executable code inside app bundles.
    if exe_dir.ends_with("Contents/MacOS") {
        candidates.insert(1, exe_dir.join("../Resources/dist"));
    }
    match candidates.iter().find(|c| is_build(c)) {
        Some(found) => AssetRoot::Found(found.clone()),
        None => AssetRoot::Missing(candidates.to_vec()),
    }
}

/// Text as HTML, so a path containing markup cannot close the document it is
/// being reported in.
fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The page served when no asset root resolved. A window that says what is
/// wrong, rather than a blank one: a panic before the window exists would leave
/// the user with nothing to look at, which is the state this whole slice exists
/// to end.
fn missing_assets_page(tried: &[PathBuf]) -> String {
    let list = if tried.is_empty() {
        "<p>There was no candidate path to try: the location of the running \
         executable could not be determined and APP_DIST is unset.</p>"
            .to_string()
    } else {
        let items: String = tried
            .iter()
            .map(|p| {
                format!(
                    "<li><code>{}</code></li>",
                    html_escape(&p.to_string_lossy())
                )
            })
            .collect();
        format!("<p>Tried:</p><ul>{items}</ul>")
    };
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>No assets</title>\
         <style>body{{font:14px system-ui;margin:3rem;line-height:1.6}}\
         code{{word-break:break-all}}</style>\
         <h1>The interface was not found</h1>\
         <p>This build could not locate its <code>index.html</code>.</p>{list}\
         <p>Build it with <code>cd app/ui &amp;&amp; bun run build</code>, or start \
         the app through <code>scripts/run-app</code>, which does that first.</p>"
    )
}

/// Desktop application storage, separate from the stable application identifier.
const APP_DIR: &str = "garret";

/// Must match CLOSE_EVENT in app/ui/src/lifecycle.ts.
const CLOSE_EVENT: &str = "app://close-requested";

/// The recovery directory changed. NO PAYLOAD, on purpose: the page re-reads
/// `recovery_status`, so the files stay the one source of truth instead of a
/// message that can disagree with them.
const RECOVERY_EVENT: &str = "app://recovery-changed";

/// The mirror directory changed. NO PAYLOAD, like `RECOVERY_EVENT`: the page
/// re-reads rather than trusting a number that travelled.
const MIRROR_EVENT: &str = "app://mirror-changed";

/// Pure so it is testable: reading process environment inside a unit test is a
/// data race against every other test in the binary.
fn data_home_from(xdg_data_home: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
    xdg_data_home
        .map(PathBuf::from)
        // The XDG basedir spec requires a relative value to be ignored.
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| {
            home.map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        })
}

#[cfg(any(target_os = "macos", test))]
fn portable_privacy_refusal_key(state: privacy::LockState) -> Option<&'static str> {
    match state {
        privacy::LockState::Locked | privacy::LockState::Verifying => Some("privacy.portable_locked"),
        privacy::LockState::Recovery => Some("privacy.portable_recovery"),
        privacy::LockState::Disabled | privacy::LockState::Unlocked => None,
    }
}

/// Where a Windows launch keeps the library. Pure for the same reason
/// `data_home_from` is, and ALWAYS COMPILED for a second reason: a rule behind
/// `#[cfg(windows)]` is a rule no `cargo test` on the development machine can
/// execute, which is the instrument-nobody-can-falsify shape this project has
/// been caught in repeatedly. Only the choice between the two resolvers is
/// gated; both rules are tested on every platform.
///
/// `%APPDATA%` is the roaming per-user data directory and is the closest
/// equivalent of `XDG_DATA_HOME`; it is what `dirs::data_dir` resolves to on
/// Windows, so the library lands where every other application's does.
///
/// There is deliberately NO is_absolute filter here. That rule comes from the
/// XDG basedir spec, which does not govern Windows, and it cannot even be
/// evaluated correctly off-platform: `Path::is_absolute` is false for
/// `C:\Users\u\AppData\Roaming` when the test runs on Linux, so the filter
/// would discard a perfectly good value in exactly the test that is supposed
/// to prove the value is honoured. An empty variable is treated as unset.
fn windows_data_home_from(appdata: Option<&OsStr>, userprofile: Option<&OsStr>) -> PathBuf {
    appdata
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| {
            userprofile
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| PathBuf::from("."))
                .join("AppData")
                .join("Roaming")
        })
}

/// The project a launch creates when the library is empty. It lives IN the
/// library, not beside it, so the listing shows it like any other manuscript.
const DEFAULT_PROJECT: &str = "default.db";

/// Windows sets neither `XDG_DATA_HOME` nor `HOME`, so resolving the library
/// the XDG way there falls all the way through to `PathBuf::from(".")` and puts
/// the manuscript under the process's WORKING DIRECTORY -- a different book per
/// shortcut, silently, with `last_project` recorded in whichever copy was
/// opened. That is the same failure the recorded `last_project` hazard
/// describes, except it splits the whole library rather than one setting.
pub(crate) fn data_home() -> PathBuf {
    if cfg!(windows) {
        windows_data_home_from(
            std::env::var_os("APPDATA").as_deref(),
            std::env::var_os("USERPROFILE").as_deref(),
        )
    } else {
        data_home_from(
            std::env::var_os("XDG_DATA_HOME").as_deref(),
            std::env::var_os("HOME").as_deref(),
        )
    }
}

/// A JavaScript single-quoted string literal, escaped. The page's globals are
/// installed by interpolating into an initialization script, so an unescaped
/// value containing a quote closes the literal and everything after it runs as
/// code, in a page that holds the writer's manuscript. These values come from
/// the operator's own environment rather than from a document, so this is not a
/// remote hole -- but a run configured by a script or a shared shell profile
/// must not be able to rewrite the application.
///
/// U+2028 and U+2029 are escaped because JavaScript treats them as line
/// terminators inside a string literal, which is a SyntaxError rather than an
/// injection but breaks the page just as thoroughly.
fn js_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A numeric knob from the environment, or its default. Never the raw string:
/// these are interpolated bare into the init script.
fn env_number(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// How often to take a recovery point, or None for never.
///
/// OFF IS EXPLICIT AND EVERYTHING ELSE IS ON. An unrecognised value must not
/// silently disable the second copy: this feature exists because the
/// application once told writers a backup existed that never did.
fn recovery_interval(mode: &str, interval_ms: u64) -> Option<std::time::Duration> {
    if mode == "off" || interval_ms == 0 {
        return None;
    }
    Some(std::time::Duration::from_millis(interval_ms))
}

/// Whether a clean close should take a recovery point.
///
/// THE SCHEDULE'S OWN RULE, called rather than restated. The two must agree
/// about what "off" means: `APP_RECOVERY_MODE=off` is how a measurement run
/// stops the application writing into the directory it is grading, and a close
/// point that read the knob its own way would take one anyway, on every rig
/// boot, into the fixture the rig had just set up.
fn close_point_wanted(mode: &str, interval_ms: u64) -> bool {
    recovery_interval(mode, interval_ms).is_some()
}

#[derive(Debug, PartialEq, Eq)]
enum Choice {
    Last(PathBuf),
    /// The most recently modified readable project in the library. Named for
    /// what it means, not for the single-project case it began as.
    Newest(PathBuf),
    Default,
}

/// Which project a launch with no APP_PROJECT opens. Deliberately does NOT
/// consult the filesystem: the caller checks existence and passes only paths
/// that exist, which is what makes this testable without a fixture on disk.
///
/// `library_db_files` must arrive NEWEST FIRST. With no record of a last
/// project, the most recently modified manuscript is the best available guess
/// and creating a fresh empty one instead would be the worst: a writer who has
/// two books and loses a preferences file would be met by a third, blank one
/// and no sign of the other two until they opened the switcher.
fn startup_choice(last: Option<&Path>, library_db_files: &[PathBuf]) -> Choice {
    if let Some(p) = last {
        return Choice::Last(p.to_path_buf());
    }
    match library_db_files.first() {
        Some(newest) => Choice::Newest(newest.clone()),
        None => Choice::Default,
    }
}

/// Store::open creates schema v1 on a blank file, so a first launch needs no
/// separate creation path.
fn try_open(path: &Path, strings: &strings::Strings, create: bool) -> Option<store::Store> {
    // `projects::open_for_writing`, never `Store::open`: opening a project FOR
    // THE WRITER is also where a `recovered_from` row an older build wrote as an
    // absolute path stops naming their home directory.
    let opened = if create { projects::open_for_writing(path) }
        else { projects::open_existing_for_writing(path) };
    let store = match opened {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}: {e}", path.display());
            return None;
        }
    };
    if let Err(e) = store.ensure_starter_structure(strings) {
        eprintln!(
            "{}: cannot create the starter chapter and scene: {e}",
            path.display()
        );
        return None;
    }
    Some(store)
}

fn open_or_exit(path: &Path, strings: &strings::Strings, create: bool) -> store::Store {
    match try_open(path, strings, create) {
        Some(s) => s,
        None => process::exit(1),
    }
}

/// What a book is called when nobody has called it anything.
///
/// Host-side English, in the family of the starter scene's `Untitled scene`.
/// Localizing the host's writer-facing strings is a separate open item; this is
/// one more string on that list rather than a new kind of problem.
const STARTER_NAME: &str = "Untitled book";

/// Give a project a name if it carries none.
///
/// ONLY IF IT CARRIES NONE, and that condition is what makes this safe to run on
/// a launch. `summarize` treats a nameless project as a true answer -- the file
/// stem -- rather than an error, and a writer who renamed the starter must never
/// have that overwritten by starting the application.
///
/// A failure is swallowed for `set_window_title`'s reason: a book that opened
/// under the wrong label is a cosmetic defect, and refusing to launch over it
/// would trade a manuscript for a caption.
fn name_if_unnamed(store: &store::Store) {
    match store.get_meta(projects::NAME_KEY) {
        Ok(Some(name)) if !name.is_empty() => {}
        Ok(_) => {
            let _ = store.set_meta(projects::NAME_KEY, STARTER_NAME);
        }
        Err(_) => {}
    }
}

fn project_book_id(store: &store::Store) -> Result<String, String> {
    store.book_id().map_err(|error| error.to_string())?
        .ok_or_else(|| "the opened book has no identity".to_string())
}

/// The word index, the excluded set, the dictionary sync and the `OpenProject`
/// itself, shared by every path that opens a project before the window exists
/// (`APP_PROJECT`, and the `Start::Last` startup open). Borrowed from
/// `project_open`'s own shape, which already performs the same three steps for
/// a switch; the no-project boot borrows nothing it does not have.
fn open_and_prepare(store: store::Store, project_path: &Path, data_home: &Path, registered: bool) -> OpenProject {
    let book_id = project_book_id(&store).unwrap_or_else(|error| {
        eprintln!("{}: {error}", project_path.display());
        process::exit(1);
    });
    // Same reason the store is opened before the window: a project whose
    // documents cannot be read at all is a broken file, and a window over one
    // looks exactly like a healthy run that measured nothing.
    let words = match store.word_index() {
        Ok(index) => index,
        Err(e) => {
            eprintln!("{}: cannot count the project: {e}", project_path.display());
            process::exit(1);
        }
    };
    let excluded = store
        .items()
        .map(|items| store::excluded_from_book(&items))
        .unwrap_or_default();
    // Rendered into ENCHANT_CONFIG_DIR (set above, before the window) so the
    // checker in the web process about to be created reads THIS project's
    // words rather than whatever the previous launch left behind.
    #[cfg(target_os = "linux")]
    commands::spell::sync_project_dictionary(
        data_home,
        &store,
        &commands::spell::configured_languages(),
    );
    let analytics = match store.analytics_start_on_open() {
        Ok(runtime) => runtime,
        Err(error) => { eprintln!("analytics: could not start the book session: {error}"); None }
    };
    OpenProject {
        name: project_name(&store, project_path),
        store,
        book_id,
        registry_home: registered.then(|| data_home.to_path_buf()),
        path: project_path.to_path_buf(),
        generation: 1,
        analytics,
        tracking_on: projects::read_settings(data_home).time_tracking == projects::TimeTracking::On,
        words,
        excluded,
    }
}

fn startup_needs_choice(path: &Path, data_home: &Path) -> bool {
    let Ok(reader) = store::Store::open_readonly(path) else { return false };
    match projects::read_settings_checked(data_home)
        .and_then(|settings| book_open::conflict(&reader, path, &settings))
    {
        Ok(conflict) => conflict.is_some(),
        Err(error) => {
            eprintln!("{}: {error}", path.display());
            true
        }
    }
}

/// The human's launch: the last project, else the library's only one, else a
/// default created in the library.
fn open_from_library(
    data_home: &Path,
    library: &Path,
    strings: &strings::Strings,
) -> (PathBuf, Option<store::Store>) {
    let last = projects::read_settings(data_home)
        .last_project
        .map(PathBuf::from)
        // startup_choice consults no filesystem, so existence is decided here.
        .filter(|p| p.exists());
    // Newest first, and only the ones that actually open. `list` deliberately
    // INCLUDES unreadable projects so the switcher can show them, but launching
    // straight into one would be a window with no manuscript and no explanation.
    let db_files: Vec<PathBuf> = projects::list(library)
        .into_iter()
        .filter(|s| s.error.is_none())
        .map(|s| PathBuf::from(s.path))
        .collect();

    if let Choice::Last(path) = startup_choice(last.as_deref(), &db_files) {
        if startup_needs_choice(&path, data_home) {
            return (path, None);
        }
        if let Some(store) = try_open(&path, strings, false) {
            return (path, Some(store));
        }
        // Recorded but unopenable. Falling through to the library beats
        // refusing to launch over a stale preference.
        eprintln!("{}: falling back to the library", path.display());
    }

    let choice = startup_choice(None, &db_files);
    let creating_default = matches!(choice, Choice::Default);
    let path = match choice {
        Choice::Newest(p) => p,
        _ => {
            if let Err(e) = fs::create_dir_all(library) {
                eprintln!("cannot create {}: {e}", library.display());
                process::exit(1);
            }
            library.join(DEFAULT_PROJECT)
        }
    };
    if path.exists() && startup_needs_choice(&path, data_home) {
        return (path, None);
    }
    let store = open_or_exit(&path, strings, creating_default);
    // ONLY on the Default branch. `try_open` also serves `Choice::Last` and
    // `Choice::Newest`, and naming there would relabel a project that has been
    // nameless since before names were recorded -- which `summarize` treats
    // deliberately as a true answer and not as a gap to fill.
    if creating_default {
        name_if_unnamed(&store);
    }
    (path, Some(store))
}

#[cfg(any(windows, test))]
fn content_invocation_allowed(label: &str) -> bool {
    const CONTENT_WINDOWS: &[&str] = &["main"];
    CONTENT_WINDOWS.contains(&label)
}

fn main() {
    // Before tauri::Builder: seeding needs no window, no webview and no event
    // loop, and building one would only add ways for it to fail.
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("--seed") {
        let (fixture, db) = match (argv.get(2), argv.get(3)) {
            (Some(f), Some(d)) => (f, d),
            _ => {
                eprintln!("usage: garret --seed <fixture-dir> <project-path>");
                process::exit(2);
            }
        };
        match store::seed::seed_project(Path::new(fixture), Path::new(db)) {
            Ok(n) => {
                println!("seeded {n} items into {db}");
                process::exit(0);
            }
            Err(e) => {
                eprintln!("seed failed: {e}");
                process::exit(1);
            }
        }
    }

    // The noninteractive CLI, dispatched BEFORE tauri::Builder for the reason
    // seeding is: a subcommand needs no window, no webview and no event loop,
    // and building one would only add ways for it to fail -- and would make the
    // CLI need a display it is the whole point of not needing. The window is
    // opened only when NO subcommand was given, which is this one condition.
    if let Some(command) = argv.get(1) {
        if cli::is_subcommand(command) {
            if cli::uses_profile(command) {
                let home = data_home();
                if let Err(error) = data_migration::check_cli(&home) {
                    eprintln!("{}", data_migration::refusal(&home, &error));
                    process::exit(1);
                }
            }
            process::exit(cli::run(&argv[1..]));
        }
    }

    if argv.get(1).map(String::as_str) == Some("--crash-child") {
        let db = argv.get(2).expect("--crash-child <db> <mode> <count>");
        let mode = argv.get(3).expect("--crash-child <db> <mode> <count>");
        let count: usize = argv.get(4).and_then(|s| s.parse().ok()).unwrap_or(200);
        store::crash_child::run(Path::new(db), mode, count);
    }

    let seed = std::env::var("APP_SEED").unwrap_or_else(|_| "app-v1".into());
    let mode = std::env::var("APP_MODE").unwrap_or_else(|_| "virtual".into());
    // Every numeric knob is PARSED, not interpolated raw. Two reasons, and the
    // second is the serious one: a non-numeric value would become a
    // ReferenceError mid-init-script and silently drop every global assigned
    // after it, and a value like "0;anything()" would run as JavaScript in the
    // page that holds the writer's manuscript, because these are interpolated
    // bare rather than inside a quoted literal.
    let soak_ms = env_number("APP_SOAK_MS", 60_000);
    let typing_chars = env_number("APP_TYPING_CHARS", 400);
    let nav_jumps = env_number("APP_NAV_JUMPS", 60);
    // Milliseconds of idle after each action. 0 keeps the historical rate, at
    // which action count and elapsed time are the same axis.
    let action_delay_ms = env_number("APP_ACTION_DELAY_MS", 0);
    // Bounded create/rename/move mutations after the soak. 0 means the page
    // skips the phase, keeping every corpus-path and prior-slice run unchanged.
    let mutations = env_number("APP_MUTATIONS", 0);
    // interactive by default: a bare launch must be an application, not a
    // benchmark. Every harness spawn sets APP_RUN=measure in shell.ts.
    let run = std::env::var("APP_RUN").unwrap_or_else(|_| "interactive".into());
    // Installed only when the harness asked for it. Without this a human's
    // launch would drop a sink.json into whatever directory they started from.
    let sink_js = match std::env::var("APP_SINK") {
        Ok(_) => "window.__appSink=(p)=>window.__TAURI__.core.invoke('sink',{payload:p});",
        Err(_) => "",
    };

    // APP_PROJECT set: the harness's contract, unchanged — a missing file is a
    // staging bug and must not be papered over by creating one. Unset: the
    // human's path, where the application owns a library of its own.
    let explicit = std::env::var("APP_PROJECT").ok().map(PathBuf::from);
    let data_home = data_home();
    let mirror_root = std::env::var_os("APP_MIRROR_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    // Before the store is opened: a second launch on this library must not
    // touch the writer's file at all, only ask the first window forward.
    #[cfg(unix)]
    let owned_socket = match instance::claim(&data_home) {
        instance::Claim::Owned(listener, path) => Some((listener, path)),
        instance::Claim::Forwarded => {
            eprintln!("another window is already open on this library; asked it to come forward");
            process::exit(0);
        }
        instance::Claim::Unavailable(why) => {
            eprintln!(
                "cannot guard against a second window on this library, running without: {why}"
            );
            None
        }
    };
    #[cfg(windows)]
    let owned_file = match instance_file::claim(&data_home) {
        instance_file::Claim::Owned(guard) => guard,
        instance_file::Claim::Forwarded => {
            eprintln!("another window is already open on this library; asked it to come forward");
            process::exit(0);
        }
        instance_file::Claim::Unavailable(why) => {
            report_migration_failure(&data_home, &format!("cannot guard this library: {why}"));
            process::exit(1);
        }
    };
    #[cfg(unix)]
    let migration = if owned_socket.is_some() {
        data_migration::prepare(&data_home)
    } else {
        data_migration::check_cli(&data_home)
    };
    #[cfg(windows)]
    let migration = data_migration::prepare(&data_home, &owned_file);
    if let Err(error) = migration {
        // Reporting must not create a destination that would block a retry.
        report_migration_failure(&data_home, &error);
        #[cfg(unix)]
        if let Some((_, path)) = &owned_socket { instance::release(path); }
        process::exit(1);
    }
    let library = projects::library_dir(&data_home);

    // MUST be set before the window (and its webview's web process) exists.
    // WebKitGTK spell-checks in the web process, which inherits the host's
    // environment at spawn -- setting this from a command handler would be too
    // late for the process already up. Pointed at an application-owned
    // directory, never at the project: it cannot be changed once the web
    // process is running, and the project's own list is rendered into it below
    // and again on every open-project path. See commands/spell.rs.
    #[cfg(target_os = "linux")]
    std::env::set_var("ENCHANT_CONFIG_DIR", commands::spell::dict_dir(&data_home));

    // Read once, here, BEFORE the store is opened, so both the choice below
    // and `preferences_js` further down answer from the same file: reading it
    // twice could disagree with itself if the writer edited settings.json
    // between the two reads. This is also earlier than every prior launch
    // read it, which is what makes `startup_settings.start` available for the
    // match immediately below.
    let startup_settings = projects::read_settings(&data_home);
    let startup_strings = startup_settings.locale.strings();
    let startup_privacy = privacy::Privacy::load(&data_home);
    let privacy_locked = startup_privacy.locked();
    #[cfg(target_os = "macos")]
    if let Some(key) = portable_privacy_refusal_key(startup_privacy.status().state) {
        refuse_portable_privacy_startup(&data_home, &startup_strings, key);
    }
    let recorded_window = startup_settings.window;
    let recorded_spelling = startup_settings.spelling;
    let recorded_zoom = startup_settings.zoom;

    // Opened BEFORE the window exists. A store that fails to open must not
    // produce a window: a window with no data looks exactly like a healthy run
    // that measured nothing, which is the failure mode that has cost this
    // project five instrument retractions.
    //
    // `None` here is the no-project boot: `start` is `home` or `blank`
    // and no `APP_PROJECT` was given, so nothing is opened at all.
    // `APP_PROJECT` IGNORES `start` ENTIRELY, exactly as it ignores
    // `last_project` -- the harness's contract, unchanged, and no graded rig
    // sets `start`.
    let mut pending_project = None;
    let opened: Option<OpenProject> = match explicit.as_deref() {
        Some(p) => {
            if !p.exists() {
                eprintln!(
                    "APP_PROJECT={}: no such project file; seed one with --seed <fixture-dir> <project-path>",
                    p.display()
                );
                process::exit(1);
            }
            Some(open_and_prepare(open_or_exit(p, &startup_strings, false), p, &data_home, false))
        }
        None => match startup_settings.start {
            projects::Start::Last => {
                let (path, store) = open_from_library(&data_home, &library, &startup_strings);
                match store {
                    None => { pending_project = Some(path); None }
                    Some(store) => match book_open::register(&store, &path, &data_home, mirror_root.as_deref(), None) {
                    Ok(_) => Some(open_and_prepare(store, &path, &data_home, true)),
                    Err(error) => {
                        eprintln!("{}: {error}", path.display());
                        pending_project = Some(path);
                        None
                    }
                },
                }
            }
            // `home` and `blank` both mount nothing here; the library screen
            // that tells them apart is 100's.
            projects::Start::Home | projects::Start::Blank => None,
        },
    };

    // AFTER the open: the human's launch records what it opened, the same
    // pair `project_open` writes for a switch. Startup wrote NEITHER before
    // this slice. `remember_open` re-reads the file rather than using
    // `startup_settings` above, and writes nothing under `APP_PROJECT`.
    if let Some(project) = &opened {
        projects::remember_open(&data_home, explicit.is_some(), &project.path, store::now_ms() as u64);
    }

    let project_path = opened
        .as_ref()
        .map(|p| p.path.clone())
        .unwrap_or_default();
    let generation = opened.as_ref().map(|p| p.generation);
    // The open project's name, or with nothing open the one non-book title
    // this application has, followed by the application's name.
    let initial_title = if privacy_locked {
        startup_settings.locale.strings().t("privacy.locked")
    } else if startup_privacy.status().policy.neutral_title {
        startup_settings.locale.strings().t("privacy.neutral")
    } else { match &opened {
        Some(project) => privacy_host::app_title(&project.name),
        None => privacy_host::app_title(&startup_settings.locale.strings().t("library")),
    }};

    let project_js = js_string(&project_path.to_string_lossy());
    let pending_project_js = pending_project.as_ref()
        .map(|path| format!("window.__appPendingProject={};", js_string(&path.to_string_lossy())))
        .unwrap_or_default();
    let persist_mode = std::env::var("APP_PERSIST_MODE").unwrap_or_else(|_| "write".into());
    let recovery_mode = std::env::var("APP_RECOVERY_MODE").unwrap_or_else(|_| "on".into());
    let recovery_interval_ms = env_number("APP_RECOVERY_INTERVAL_MS", 900_000);
    let close_point = close_point_wanted(&recovery_mode, recovery_interval_ms);

    // EVERY string here goes through js_string. Only APP_PROJECT used to, and
    // the rest were interpolated raw inside single quotes, so
    // `APP_SEED="x';<anything>//"` closed the literal and ran arbitrary
    // JavaScript in a page that holds the writer's manuscript. These values
    // come from the operator's own environment rather than from a document, so
    // it is not a remote hole, but a run configured from a script or a shared
    // shell profile should not be able to rewrite the application.
    //
    // The numeric values are parsed to numbers before they get here, which is
    // why they are interpolated bare; a non-numeric APP_MUTATIONS would
    // otherwise become a ReferenceError mid-script and silently drop every
    // global assigned after it.
    // The writer's palette preference, read from the same settings file that
    // holds last_project. Injected rather than fetched over IPC so index.html's
    // head script can put it on the root element BEFORE first paint.
    let preferences_js = preferences_js(&startup_settings);
    // Omitted with nothing open: the page's own fallback is 1 (grep
    // `__appGeneration ?? 1`), which agrees with what the FIRST open from an
    // empty boot computes -- `project_open`'s
    // `guard.as_ref().map(..).unwrap_or(0) + 1` is 1 when the guard is `None`.
    let generation_js = match generation {
        Some(g) => format!("window.__appGeneration={g};"),
        None => String::new(),
    };

    let seed_js = js_string(&seed);
    let mode_js = js_string(&mode);
    let run_js = js_string(&run);
    let persist_mode_js = js_string(&persist_mode);
    let library_diagnostics = std::env::var("APP_LIBRARY_DIAGNOSTICS").as_deref() == Ok("1");

    let init = format!(
        "window.__appPrivacyLocked={privacy_locked};\
         window.__appLibraryDiagnostics={library_diagnostics};\
         window.__appCandidate='tauri';\
         window.__appSeed={seed_js};\
         window.__appMode={mode_js};\
         window.__appRun={run_js};\
         window.__appSoakMs={soak_ms};\
         window.__appTypingChars={typing_chars};\
         window.__appNavJumps={nav_jumps};\
         window.__appActionDelayMs={action_delay_ms};\
         window.__appMutations={mutations};\
         window.__appCorpusUrl='./corpus.json';\
         window.__appProject={project_js};\
         {pending_project_js}\
         {generation_js}\
         window.__appPersistMode={persist_mode_js};\
         {preferences_js}\
         {sink_js}"
    );

    // Resolved once, here, so every request answers from the same directory and
    // a failure is reported at startup instead of as a silent 404 per asset.
    let assets = resolve_asset_root(
        std::env::var_os("APP_DIST").map(PathBuf::from).as_deref(),
        std::env::current_exe().ok().as_deref(),
    );
    if let AssetRoot::Missing(tried) = &assets {
        eprintln!("no interface assets found; tried:");
        for p in tried {
            eprintln!("  {}", p.display());
        }
        if tried.is_empty() {
            eprintln!("  (nothing: APP_DIST is unset and the executable path is unknown)");
        }
        eprintln!("build them with: cd app/ui && bun run build");
    }

    // Taken before the setup closure moves `data_home` into managed state: a
    // startup that fails still has to be able to say where it failed.
    let error_report_home = data_home.clone();
    #[cfg(unix)]
    let (owned_socket, socket_path) = match owned_socket {
        Some((listener, path)) => (Some(listener), Some(path)),
        None => (None, None),
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("appdist", move |ctx, request| {
            appdist_response(
                &assets,
                request.uri().path(),
                ctx.app_handle().config().app.security.csp.as_ref(),
            )
        });
    #[cfg(windows)]
    let builder = builder.register_uri_scheme_protocol("proof", |ctx, request| {
        printer_windows::serve(ctx.webview_label(), request)
    });
    let run = builder.invoke_handler({
            let commands: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            privacy_host::__wire_privacy_status,
            privacy_host::__wire_privacy_activity,
            privacy_host::__wire_privacy_lock,
            privacy_host::__wire_privacy_settings,
            privacy_host::__wire_privacy_drain_result,
            privacy_host::__wire_privacy_close_failed,
            privacy_host::__wire_privacy_ready,
            __wire_sink,
            __wire_project_items,
            __wire_doc_load,
            __wire_doc_flush,
            commands::history::__wire_doc_versions,
            commands::history::__wire_doc_version_body,
            commands::history::__wire_doc_restore,
            commands::review::__wire_review_state,
            commands::review::__wire_review_group,
            commands::review::__wire_review_author_create,
            commands::review::__wire_review_group_create,
            commands::review::__wire_review_messages,
            commands::review::__wire_review_message_add,
            commands::review::__wire_review_decide,
            commands::review_transport::__wire_review_export_preview,
            commands::review_transport::__wire_review_export_save,
            commands::review_transport::__wire_review_return_preview,
            commands::review_transport::__wire_review_return_apply,
            commands::review_transport::__wire_review_transport_cancel,
            commands::history::__wire_snapshot_list,
            commands::history::__wire_snapshot_create,
            commands::history::__wire_snapshot_restore,
            commands::comments::__wire_comment_list,
            commands::comments::__wire_comment_create,
            commands::comments::__wire_comment_set_body,
            commands::comments::__wire_comment_set_resolved,
            commands::revision_planning::__wire_revision_pass_list,
            commands::revision_planning::__wire_revision_pass_create,
            commands::revision_planning::__wire_revision_pass_update,
            commands::revision_planning::__wire_revision_pass_delete,
            commands::revision_planning::__wire_revision_task_list,
            commands::revision_planning::__wire_revision_task_create,
            commands::revision_planning::__wire_revision_task_update,
            commands::revision_planning::__wire_revision_task_set_done,
            commands::knowledge::__wire_knowledge_links,
            commands::knowledge::__wire_knowledge_link_create,
            commands::knowledge::__wire_knowledge_link_remove,
            commands::knowledge::__wire_research_list,
            commands::knowledge::__wire_research_import_pick,
            commands::knowledge::__wire_research_remove,
            commands::knowledge::__wire_research_restore,
            commands::knowledge::__wire_research_save_copy,
            commands::knowledge::__wire_craft_watchlist_get,
            commands::knowledge::__wire_craft_watchlist_set,
            commands::knowledge::__wire_craft_report_export_as,
            commands::revision_planning::__wire_revision_task_delete,
            commands::synopsis::__wire_synopsis_get,
            commands::synopsis::__wire_synopsis_batch,
            commands::synopsis::__wire_synopsis_set,
            commands::synopsis::__wire_synopsis_ids,
            commands::cast::__wire_cast_list,
            commands::cast::__wire_cast_deleted,
            commands::cast::__wire_cast_restore,
            commands::cast::__wire_cast_create,
            commands::cast::__wire_cast_set,
            commands::cast::__wire_cast_remove,
            commands::cast::__wire_cast_picture_view,
            commands::cast::__wire_cast_picture_clear,
            commands::cast::__wire_cast_picture_full,
            commands::appearances::__wire_appearances_list,
            commands::appearances::__wire_appearances_set,
            commands::dialogs::__wire_cast_picture_pick,
            commands::design::__wire_book_design_get,
            commands::design::__wire_book_design_set,
            commands::design::__wire_book_layout_set,
            commands::design::__wire_chapter_style_get,
            commands::design::__wire_chapter_style_set,
            commands::dialogs::__wire_design_export_as,
            commands::dialogs::__wire_design_import_preview,
            commands::dialogs::__wire_design_import_apply,
            commands::identity::__wire_identities_get,
            commands::identity::__wire_identity_save,
            commands::identity::__wire_identity_remove,
            commands::identity::__wire_identity_pin_preview,
            commands::identity::__wire_identity_pin,
            commands::identity::__wire_identity_unpin,
            commands::identity::__wire_preflight_get,
            commands::identity::__wire_preflight_reason_add,
            commands::library::__wire_library_overview,
            commands::library::__wire_library_book_words,
            commands::library::__wire_library_book_stats,
            commands::library::__wire_library_membership_get,
            commands::library::__wire_library_membership_set,
            commands::analytics::__wire_analytics_get,
            commands::analytics::__wire_analytics_book_report,
            commands::analytics::__wire_analytics_set_recording,
            commands::analytics::__wire_analytics_set_category,
            commands::analytics::__wire_analytics_adjust,
            commands::analytics::__wire_analytics_exclude_session,
            commands::analytics::__wire_analytics_custom_add,
            commands::analytics::__wire_analytics_custom_retire,
            commands::analytics::__wire_analytics_reset_motivation,
            commands::analytics::__wire_analytics_set_motivation,
            commands::analytics::__wire_analytics_purge,
            commands::analytics::__wire_analytics_raw_export,
            commands::covers::__wire_covers_get,
            commands::covers::__wire_covers_clear,
            commands::covers::__wire_covers_fit_set,
            commands::covers::__wire_cover_full,
            commands::dialogs::__wire_covers_pick,
            commands::dict::__wire_dict_list,
            commands::dict::__wire_dict_add,
            commands::dict::__wire_dict_remove,
            __wire_project_replace,
            __wire_item_create,
            __wire_item_rename,
            __wire_item_set_state,
            __wire_item_move,
            __wire_project_list,
            __wire_project_forget,
            __wire_project_new_dir,
            __wire_project_create,
            __wire_project_open,
            __wire_project_open_check,
            __wire_project_current,
            __wire_project_rename,
            __wire_project_word_count,
            __wire_project_word_counts,
            __wire_project_document_counts,
            __wire_project_progress,
            __wire_project_source_words,
            __wire_project_source_words_collecting,
            __wire_project_source_words_reset,
            commands::export::__wire_project_export,
            commands::export::__wire_epub_preview,
            #[cfg(any(target_os = "linux", windows))]
            commands::export::__wire_pdf_preview,
            __wire_project_find,
            commands::settings::__wire_settings_set_theme,
            commands::settings::__wire_settings_set_typography,
            commands::settings::__wire_settings_set_daily_target,
            commands::settings::__wire_settings_set_bible_rows,
            commands::settings::__wire_settings_set_writing_modes,
            commands::settings::__wire_settings_set_mark_cast_names,
            commands::spell::__wire_settings_set_spelling,
            commands::settings::__wire_settings_set_time_tracking,
            commands::settings::__wire_settings_set_zoom,
            __wire_writing_time_note,
            __wire_writing_time_today,
            commands::settings::__wire_settings_set_theme_family,
            commands::settings::__wire_settings_set_start,
            commands::settings::__wire_settings_set_home_identity,
            commands::settings::__wire_settings_set_locale,
            __wire_project_import_list,
            __wire_project_import,
            commands::dialogs::__wire_project_export_as,
            commands::dialogs::__wire_statistics_export_as,
            commands::dialogs::__wire_project_create_pick,
            commands::dialogs::__wire_project_move,
            commands::dialogs::__wire_project_import_pick,
            commands::dialogs::__wire_encrypted_backup_destination,
            commands::dialogs::__wire_encrypted_backup_destination_pick,
            commands::dialogs::__wire_encrypted_key_generate,
            commands::dialogs::__wire_encrypted_archive_create,
            commands::dialogs::__wire_encrypted_archive_verify,
            commands::dialogs::__wire_encrypted_archive_restore,
            __wire_legacy_protection,
            __wire_recovery_status,
            __wire_recovery_points,
            __wire_project_backup_now,
            __wire_project_restore_point,
            __wire_archive_status,
            __wire_archives,
            __wire_project_archive_now,
            __wire_mirror_status,
            __wire_mirror_changes,
            __wire_mirror_check,
            __wire_mirror_accept,
            __wire_mirror_undo_accept,
            __wire_mirror_enable,
            __wire_mirror_preview,
            __wire_confirm_close,
            __wire_holding_close,
            __wire_release_close,
            __wire_request_quit
            ];
            move |invoke: tauri::ipc::Invoke| {
                #[cfg(windows)]
                if !content_invocation_allowed(invoke.message.webview_ref().label()) {
                    invoke.resolver.reject("this window cannot invoke application commands");
                    return true;
                }
                let app = invoke.message.webview_ref().app_handle();
                if privacy_host::locked(app) && !privacy_host::allowed_while_locked(invoke.message.command()) {
                    let error = command_error::CommandFailure::locked(invoke.message.command());
                    invoke.resolver.reject(error);
                    return true;
                }
                commands(invoke)
            }
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            // A resize SETTLING, not a resize. `Resized` fires continuously
            // while a window is dragged and `write_settings` is
            // write-temp + fsync + rename, so recording per event would be
            // dozens of durable writes a second for a number nobody has
            // finished choosing.
            //
            // Recorded here as well as on close, and that is not belt and
            // braces: under a WM-less X server `windowclose` DESTROYS the
            // window rather than delivering a close request, so CloseRequested
            // never runs — and neither does it after a SIGKILL. Close-only
            // would be a preference that survives one of the three ways this
            // application actually stops.
            if let tauri::WindowEvent::Resized(_) = event {
                // ONE thread in flight, not one per event: a drag produces
                // hundreds of events and hundreds of sleeping threads is a
                // strange way to write a file once. Whichever event arms it
                // wins; every event after that rides the same timer, and a
                // further drag after it fires arms a new one.
                if let Some(pending) = window.try_state::<PendingWindow>() {
                    if pending.armed.swap(true, Ordering::SeqCst) {
                        return;
                    }
                }
                let settling = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(commands::settings::WINDOW_SETTLE);
                    if let Some(pending) = settling.try_state::<PendingWindow>() {
                        pending.armed.store(false, Ordering::SeqCst);
                    }
                    commands::settings::record_window_size(&settling);
                });
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The document body lives in the webview; the host cannot
                // serialize it. So closing is a round trip: prevent, ask the
                // page to flush, and let its confirm_close through.
                let locked = privacy_host::locked(window.app_handle());
                let shown = window
                    .state::<privacy_host::ContentShown>()
                    .0
                    .load(Ordering::SeqCst);
                let attempt = match window.state::<close_state::CloseState>().request(locked, shown) {
                    close_state::Request::Allow => return,
                    close_state::Request::Prevent => {
                        api.prevent_close();
                        return;
                    }
                    close_state::Request::Begin(attempt) => attempt,
                };
                // Recorded HERE and not on `Resized`, which fires continuously
                // while a window is dragged: write_settings is
                // write-temp + fsync + rename, so that would be dozens of
                // durable writes a second to record a number nobody has
                // finished choosing.
                //
                // The cost, stated rather than hidden: a SIGKILL loses the last
                // resize. Acceptable for a preference and not for a manuscript,
                // which is why the manuscript has a debounced flush and this
                // does not.
                commands::settings::record_window_size(window);
                api.prevent_close();
                let _ = window.emit(CLOSE_EVENT, attempt);
                // Silence is not permission to discard the editor's dirty
                // buffer. Allow another close attempt, but keep the window.
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    w.state::<close_state::CloseState>().timeout_release(attempt);
                });
            }
        })
        .setup(move |app| {
            #[cfg(unix)]
            if let Some(listener) = owned_socket {
                let handle = app.handle().clone();
                instance::serve(listener, move || focus_main(&handle));
            }
            #[cfg(windows)]
            app.manage(owned_file);
            let initial_pauses = MirrorPauseState::new(
                opened.as_ref().map(|project| project.book_id.as_str()),
            );
            app.manage(startup_privacy);
            app.manage(privacy_host::Barrier(AtomicBool::new(privacy_locked)));
            app.manage(privacy_host::Epoch(AtomicU64::new(0)));
            app.manage(privacy_host::PageReady(AtomicBool::new(false)));
            app.manage(privacy_host::ContentShown(AtomicBool::new(!privacy_locked)));
            app.manage(close_state::CloseState::default());
            app.manage(StoreState(Mutex::new(opened)));
            app.manage(Library(library));
            app.manage(DataHome(data_home));
            app.manage(HostStrings(startup_strings));
            app.manage(ExplicitProject(explicit));
            app.manage(ClosePoint(close_point));
            app.manage(PendingWindow {
                armed: AtomicBool::new(false),
                last: Mutex::new(None),
            });
            app.manage(MirrorDirty(AtomicBool::new(false), AtomicBool::new(false)));
            app.manage(MirrorState(std::sync::Mutex::new(
                mirror::PassOutcome::default(),
            )));
            app.manage(MirrorPaused(std::sync::Mutex::new(initial_pauses)));
            app.manage(MirrorPassing(std::sync::Mutex::new(())));
            app.manage(MirrorPreviewState(std::sync::Mutex::new(None)));
            app.manage(commands::dialogs::DesignTransferPending::default());
            app.manage(commands::review_transport::Pending::default());
            app.manage(MirrorRoot(mirror_root));

            // The mirror's schedule. A background thread, off the store mutex,
            // waking often and passing rarely: `mirror::due` is the rule, and
            // it says a pass is owed only when a flush COMMITTED since the last
            // one and the bound has elapsed.
            //
            // NO MEASUREMENT KNOB, unlike the recovery clock, and none is
            // needed: the mirror is off for every project until a writer
            // deliberately enables it, and no rig does. A knob would be a
            // second way to answer a question `settings.mirrored` already
            // answers.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut last_run: Option<i64> = None;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        let (
                            Some(state),
                            Some(home),
                            Some(root),
                            Some(dirty),
                            Some(outcome),
                            Some(pause),
                            Some(passing),
                        ) = (
                            handle.try_state::<StoreState>(),
                            handle.try_state::<DataHome>(),
                            handle.try_state::<MirrorRoot>(),
                            handle.try_state::<MirrorDirty>(),
                            handle.try_state::<MirrorState>(),
                            handle.try_state::<MirrorPaused>(),
                            handle.try_state::<MirrorPassing>(),
                        )
                        else {
                            return;
                        };
                        let now = store::now_ms();
                        if !mirror::due(dirty.0.load(Ordering::Relaxed), last_run, now) {
                            continue;
                        }
                        // Capture the project and its pause lifetime, and clear
                        // that same project's dirty bit, under one short store
                        // guard. A switch or flush after this point belongs to
                        // the next scheduled pass and cannot be consumed here.
                        let Some(context) = take_dirty_mirror_context(&state, &pause, &dirty) else {
                            continue;
                        };
                        // Capture before waiting so switching books cannot lose
                        // the claimed old book's work. Re-read the setting under
                        // the pass lock so a completed disable is honored.
                        let passing_guard = passing.0.lock();
                        let destination = match &passing_guard {
                            Ok(_) => mirror_dir_for(&context, &home.0, root.0.as_deref()),
                            Err(_) => Err("the readable folder is busy".to_string()),
                        };
                        if matches!(destination, Ok(None)) { continue; }
                        if begin_mirror_pass_if_current(&state, &pause, &dirty, &context) {
                            let _ = handle.emit(MIRROR_EVENT, ());
                        }
                        last_run = Some(now);
                        let result = match destination {
                            Ok(_) => pass_mirror_while_held(&context, &home.0, root.0.as_deref(), now),
                            Err(error) => Err(error),
                        };
                        let completed = finish_mirror_pass(
                            &state,
                            &pause,
                            &dirty,
                            &outcome,
                            &context,
                            result.as_ref().map(|_| ()).map_err(|e| e.clone()),
                            now,
                        );
                        match result {
                            Ok(_) => {}
                            // Never fatal and never a save failure: the
                            // manuscript is untouched, and a mirror that could
                            // not be written is a stale folder, which is what
                            // the staleness surface exists to report.
                            Err(e) => {
                                eprintln!("mirror: pass failed: {e}");
                            }
                        }
                        if completed {
                            let _ = handle.emit(MIRROR_EVENT, ());
                        }
                    }
                });
            }

            // The startup open never goes through `project_open`, so without
            // this the ONE case the design says matters most -- a writer who
            // edited a mirror file while the application was closed -- would be
            // the one case nothing scanned.
            spawn_mirror_scan(app.handle());

            // Stage 3, and it is spawned AFTER the scan for the reason the
            // design gives: the watcher makes a change noticed sooner, and the
            // scan is what makes it noticed at all.
            #[cfg(target_os = "linux")]
            spawn_mirror_watcher(app.handle());

            // The same-device schedule. A background thread, off the write
            // mutex, on a clock rather than on flush count: a writer who is
            // reorganizing an outline and not typing still accumulates recovery
            // points. NOT on the keystroke path and not on any flush.
            //
            // The design's other trigger, the point on a clean close, lives in
            // `confirm_close` and shares this knob through
            // `close_point_wanted` -- one rule, so a measurement run cannot
            // silence the timer and still be written into by the close.
            if let Some(interval) = recovery_interval(&recovery_mode, recovery_interval_ms) {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(interval);
                    let (Some(state), Some(home)) = (
                        handle.try_state::<StoreState>(),
                        handle.try_state::<DataHome>(),
                    ) else {
                        return;
                    };
                    if recovery::tick(&state, &home.0, store::now_ms(), recovery::take_point_for_book)
                        .is_some()
                    {
                        let _ = handle.emit(RECOVERY_EVENT, ());
                    }
                });
            }
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    "appdist://localhost/index.html".parse().expect("valid url"),
                ),
            )
            .title(initial_title.as_str())
            .visible(false)
            // The recorded size, floored but not yet fitted to the screen: the
            // monitor is not knowable before there is a window on it.
            .inner_size(
                f64::from(recorded_window.fit(None).width),
                f64::from(recorded_window.fit(None).height),
            )
            .initialization_script(init.as_str())
            .build()?;

            #[cfg(target_os = "linux")]
            privacy_native::install(app.handle())?;
            #[cfg(windows)]
            privacy_windows::install(app.handle())?;
            #[cfg(target_os = "linux")]
            privacy_lifecycle::install(app.handle());
            #[cfg(target_os = "macos")]
            if !privacy_locked {
                if let Some(window) = app.get_webview_window("main") { window.show()?; }
            }
            #[cfg(windows)]
            if !privacy_locked {
                if let Some(window) = app.get_webview_window("main") { window.show()?; }
            }
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                instance_file::serve(&app.state::<DataHome>().0, move || focus_main(&handle))?;
            }

            commands::spell::apply_spell_checking(
                &app.handle().clone(),
                recorded_spelling.enabled(),
            );
            commands::settings::apply_zoom(&app.handle().clone(), recorded_zoom);

            // Now that the window exists, it knows which monitor it is on. A
            // size recorded on a 4K display and reopened on a laptop would
            // otherwise put half the manuscript off the edge.
            //
            // Every step is best effort. A window that is merely too big is a
            // far better outcome than a startup that fails while tidying up.
            if let Some(window) = app.get_webview_window("main") {
                let screen = window.current_monitor().ok().flatten().map(|monitor| {
                    // work_area, not size: it excludes a panel or a dock, which
                    // is the difference between the screen and the space a
                    // window can actually occupy. Logical pixels, to match what
                    // the builder was given.
                    let area = monitor.work_area().size.to_logical(monitor.scale_factor());
                    projects::WindowSize {
                        width: area.width,
                        height: area.height,
                    }
                });
                let built = recorded_window.fit(None);
                let fitted = recorded_window.fit(screen);
                // Only when the screen actually changed the answer. Setting the
                // size unconditionally would be a resize on every launch, which
                // a tiling compositor and a rig reading geometry back would both
                // have something to say about.
                if fitted != built {
                    let _ = window.set_size(tauri::LogicalSize::new(
                        f64::from(fitted.width),
                        f64::from(fitted.height),
                    ));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    let run = run.map(|app| {
        // `App::run` never returns; the process exits from inside it. So the
        // socket file is removed on the Exit event, which fires on every path
        // through the event loop (Ctrl+Q, the last window closing) and on none
        // of the paths that bypass it (SIGKILL, a rig's reaper), where the next
        // launch takes the stale file over instead.
        app.run(move |_, event| {
            #[cfg(unix)]
            if let tauri::RunEvent::Exit = event {
                if let Some(path) = socket_path.as_deref() {
                    instance::release(path);
                }
            }
        })
    });

    if let Err(e) = run {
        // NOT `.expect`. On Windows this binary is a GUI-subsystem executable
        // with nothing attached to stderr, so a panic here is invisible and the
        // writer sees a double-click do nothing whatsoever. The overwhelmingly
        // likeliest cause on a fresh machine is a missing WebView2 runtime,
        // which they can install in two minutes once something tells them so.
        report_startup_failure(&error_report_home, &e.to_string());
        process::exit(1);
    }
}

/// Writes the failure somewhere the writer can actually find it, and to stderr
/// for whoever does have one. Takes the directory rather than reading the
/// environment so it is testable.
///
/// Every step is best-effort and NOTHING here panics: this runs on the path
/// where startup has already failed, and a panic while reporting a failure
/// replaces a diagnosable problem with an undiagnosable one.
fn report_migration_failure(data_home: &Path, error: &str) {
    let body = data_migration::refusal(data_home, error);
    eprintln!("{body}");
    #[cfg(any(windows, target_os = "macos"))]
    let _ = rfd::MessageDialog::new()
        .set_title("garret")
        .set_description(body)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn report_startup_failure(data_home: &Path, error: &str) {
    let strings = projects::read_settings(data_home).locale.strings();
    let body = format!("{}\n\n{}\n{error}\n", strings.t("startup.help"), strings.t("startup.detail"));
    eprintln!("{body}");
    let path = projects::startup_error_path(data_home);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, &body);
}

#[cfg(target_os = "macos")]
fn refuse_portable_privacy_startup(
    data_home: &Path,
    strings: &strings::Strings,
    key: &str,
) -> ! {
    let body = strings.t(key);
    let path = projects::startup_error_path(data_home);
    eprintln!("{body}");
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, &body);
    let _ = rfd::MessageDialog::new()
        .set_title(strings.t("privacy.locked"))
        .set_description(body)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    process::exit(1);
}

#[cfg(test)]
mod portable_privacy_startup_tests {
    use super::*;

    #[test]
    fn only_locked_or_recovery_records_refuse_portable_startup() {
        use privacy::LockState::*;
        assert_eq!(portable_privacy_refusal_key(Disabled), None);
        assert_eq!(portable_privacy_refusal_key(Unlocked), None);
        assert_eq!(portable_privacy_refusal_key(Locked), Some("privacy.portable_locked"));
        assert_eq!(portable_privacy_refusal_key(Verifying), Some("privacy.portable_locked"));
        assert_eq!(portable_privacy_refusal_key(Recovery), Some("privacy.portable_recovery"));
        for locale in [&strings::EN, &strings::DE] {
            let catalog = strings::Strings::new(locale);
            for state in [Locked, Recovery] {
                let message = catalog.t(portable_privacy_refusal_key(state).unwrap());
                assert!(message.contains("privacy.json"));
                assert!(!message.starts_with('⟦'));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_content_window_can_invoke_app_commands() {
        assert!(super::content_invocation_allowed("main"));
        assert!(!super::content_invocation_allowed("proof-018f"));
        assert!(!super::content_invocation_allowed("main-copy"));
    }

    use super::{project_book_id, projects, recovery_target, startup_needs_choice};
    use super::{
        accept_into, accept_snapshot_label, accepts_generation, changes_in, check_mirror, close_cleanly,
        close_point_wanted, create_into, data_home_from, find_in,
        find_open_project, flush_into, import_named as import_named_with,
        import_path as import_path_with, import_report,
        begin_mirror_pass_if_current, finish_mirror_pass, install_detect_result, install_paused,
        js_string, locked, looks_like_a_date, may_open, mime_for, mirror_context, missing_assets_page, move_within,
        name_if_unnamed, new_book_dir_with, preferences_js, progress_for, recovery_interval,
        enable_outcome, mark_mirror_dirty, mirror_pending, pass_mirror, pass_scenes_while_held, rename_open, replace_across, replace_snapshot_label,
        report_startup_failure, reset_mirror_dirty_if_current, resolve_asset_root, set_open_project, startup_choice,
        take_dirty_mirror_context, undo_mirror_accept_into, windows_data_home_from, word_count_at, AssetRoot, Choice,
        MirrorDirty, MirrorPaused, MirrorState, OpenProject, PauseIds, StoreState, DEFAULT_PROJECT,
        FIND_MAX_LIMIT, STARTER_NAME,
    };
    use crate::commands::export::export_to;
    use crate::commands::history::snapshot_restore_into;
    use crate::find;
    use crate::store::{FlushEntry, WordCount};
    use crate::test_support::{
        assert_index_matches_a_full_recount, body, delete_into_bin, opened, paragraphs,
        seeded_project,
    };
    use crate::{mirror, recovery, store};
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tempfile::tempdir;

    fn english() -> crate::strings::Strings {
        crate::strings::Strings::english()
    }

    fn enable_test_mirror(data_home: &Path, book_id: &str) {
        crate::projects::update_settings(data_home, |settings| {
            settings.mirrored_book_ids.push(book_id.to_string());
            settings.protection_claims.push(crate::projects::ProtectionClaim {
                book_id: book_id.to_string(),
                recovery_key: None,
                mirror_key: Some("my-book".to_string()),
            });
        })
        .unwrap();
    }


    fn create_into_dir(
        data_home: &Path,
        dir: &Path,
        name: &str,
    ) -> std::result::Result<crate::projects::ProjectSummary, String> {
        super::create_into_dir(data_home, dir, name, &english())
    }

    fn import_named(
        data_home: &Path,
        library: &Path,
        dir: &Path,
        filename: &str,
    ) -> std::result::Result<super::ImportOutcome, String> {
        import_named_with(data_home, library, dir, filename, &english())
    }

    fn import_path(
        data_home: &Path,
        library: &Path,
        path: &Path,
    ) -> std::result::Result<super::ImportOutcome, String> {
        import_path_with(data_home, library, path, &english())
    }

    /// A mirrored book and the directory it was written to, for the change-set
    /// wiring tests below.
    fn mirrored_project(tmp: &Path) -> (PathBuf, PathBuf) {
        let src = tmp.join("my-book.db");
        {
            let store = store::Store::open(&src).unwrap();
            let scene = store.item_create(None, "scene", "Letter Storm").unwrap();
            store
                .flush(&[store::FlushEntry {
                    item_id: scene.id,
                    body: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"four words go here"}]}]}"#.to_string(),
                    base_rev: 1,
                    comments: None,
                }])
                .unwrap();
        }
        let dir = tmp.join("mirror").join("my-book");
        mirror::pass(
            &src,
            "my-book",
            "My Book",
            &dir,
            store::now_ms(),
            &Default::default(),
        )
        .unwrap();
        (src, dir)
    }

    #[test]
    fn startup_defers_copied_books_without_writing_the_candidate() {
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("original.db");
        let copy = home.path().join("copy.db");
        let store = store::Store::open(&original).unwrap();
        let id = project_book_id(&store).unwrap();
        store.checkpoint().unwrap();
        std::fs::copy(&original, &copy).unwrap();
        projects::update_settings(home.path(), |settings| {
            projects::record_book_location(settings, &id, &original);
        }).unwrap();
        let before = std::fs::read(&copy).unwrap();
        assert!(startup_needs_choice(&copy, home.path()));
        assert!(!startup_needs_choice(&original, home.path()));
        assert_eq!(before, std::fs::read(&copy).unwrap());
    }

    #[test]
    fn recovery_target_retains_missing_book_identity_but_checks_replacement_files() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("book.db");
        let old_id = "0123456789abcdef0123456789abcdef";
        projects::update_settings(home.path(), |settings| {
            projects::record_book_location(settings, old_id, &path);
            settings.last_project = Some(path.to_string_lossy().into_owned());
        }).unwrap();
        let state = StoreState(std::sync::Mutex::new(None));
        let (_, missing_dir) = recovery_target(&state, home.path(), None).unwrap();
        assert_eq!(missing_dir, projects::recovery_dir(home.path(), &format!("by-id/{old_id}")));
        let replacement = store::Store::open(&path).unwrap();
        let replacement_id = project_book_id(&replacement).unwrap();
        let (_, replacement_dir) = recovery_target(&state, home.path(), None).unwrap();
        assert_eq!(replacement_dir, projects::recovery_dir(home.path(), &format!("by-id/{replacement_id}")));
        assert_ne!(missing_dir, replacement_dir);
    }

    #[test]
    fn mirror_preview_refuses_a_same_path_reopen_or_changed_destination_or_content() {
        let home = tempdir().unwrap();
        let path = home.path().join("book.db");
        let dir = home.path().join("mirror");
        let context = super::MirrorContext {
            path: path.clone(), book_id: "book-id".into(), registry_home: None,
            name: "Book".into(), generation: 7,
            paused: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
        };
        let ticket = super::MirrorPreviewTicket {
            token: "opaque".into(), path, book_id: context.book_id.clone(),
            generation: 7, dir: dir.clone(), digest: [1; 32],
        };
        assert!(super::preview_owner_matches(&ticket, &context, Some("opaque")));
        assert!(super::preview_content_matches(&ticket, &dir, [1; 32]));
        let reopened = super::MirrorContext { generation: 8, ..context.clone() };
        assert!(!super::preview_owner_matches(&ticket, &reopened, Some("opaque")));
        assert!(!super::preview_owner_matches(&ticket, &context, Some("wrong")));
        assert!(!super::preview_content_matches(&ticket, &home.path().join("elsewhere"), [1; 32]));
        assert!(!super::preview_content_matches(&ticket, &dir, [2; 32]));
    }

    #[test]
    fn mirror_routing_rechecks_canonical_source_and_the_file_identity() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("original.db");
        let copy = tmp.path().join("copy.db");
        let project = open_for_test(&src);
        let id = project.book_id.clone();
        project.store.checkpoint().unwrap();
        std::fs::copy(&src, &copy).unwrap();
        let home = tmp.path().join("data");
        enable_test_mirror(&home, &id);
        projects::update_settings(&home, |settings| {
            projects::record_book_location(settings, &id, &src);
        }).unwrap();
        let mut context = super::MirrorContext {
            path: src.clone(), book_id: id.clone(), registry_home: Some(home.clone()),
            name: "Book".into(), generation: 1,
            paused: Arc::new(Mutex::new(PauseIds::new())),
        };
        assert!(super::mirror_dir_for(&context, &home, None).unwrap().is_some());
        projects::update_settings(&home, |settings| {
            projects::record_book_location(settings, &id, &copy);
        }).unwrap();
        assert!(super::mirror_dir_for(&context, &home, None).is_err());
        context.path = copy.clone();
        assert!(super::mirror_dir_for(&context, &home, None).unwrap().is_some());
        store::Store::open(&copy).unwrap().fork_book_identity(&id).unwrap();
        assert!(super::mirror_dir_for(&context, &home, None).is_err());
    }

    #[test]
    fn mirror_routing_uses_the_enabled_book_id_not_the_file_stem() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("renamed-book.db");
        let store = store::Store::open(&src).unwrap();
        let book_id = super::project_book_id(&store).unwrap();
        let data_home = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        enable_test_mirror(&data_home, &book_id);
        let context = super::MirrorContext {
            path: src,
            book_id,
            registry_home: None,
            name: "My Book".to_string(),
            generation: 1,
            paused: Arc::new(Mutex::new(PauseIds::new())),
        };

        assert_eq!(
            super::mirror_dir_for(&context, &data_home, Some(&root)).unwrap(),
            Some(root.join("my-book")),
        );
    }

    #[test]
    fn a_change_set_over_a_directory_that_is_not_a_mirror_is_EMPTY() {
        // The never-an-error rule. A panel that offers the writer a view of
        // their own edits must not be able to fail to render, and "there is no
        // mirror here" is an answer rather than a fault.
        let tmp = tempdir().unwrap();
        let (src, _) = mirrored_project(tmp.path());
        assert_eq!(changes_in(&tmp.path().join("nowhere"), &src, &mirror::DetectReport::default()), Vec::new());
    }

    #[test]
    fn a_change_set_over_a_project_that_will_not_open_is_EMPTY() {
        let tmp = tempdir().unwrap();
        let (_, dir) = mirrored_project(tmp.path());
        assert_eq!(
            changes_in(&dir, &tmp.path().join("not-a-book.db"), &mirror::detect(&dir)),
            Vec::new()
        );
    }

    #[test]
    fn a_change_set_reaches_the_writers_edit_through_this_function() {
        // The wiring, end to end: the manifest, the detection and the rule all
        // meet here, and a command body nobody can call would leave that
        // meeting untested.
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());

        // Age the manifest so stage 1 flags the entry; a rewrite inside the
        // same millisecond leaves `mtime_ms` untouched. The recorded trap.
        let manifest: recovery::Manifest<mirror::MirrorEntry> =
            recovery::read_manifest(&dir).unwrap();
        let mut manifest = manifest;
        for entry in &mut manifest.entries {
            entry.mtime_ms -= 1;
        }
        recovery::write_manifest(&dir, &manifest).unwrap();

        let entry = manifest.entries.iter().find(|e| e.words > 0).unwrap();
        let current = std::fs::read_to_string(dir.join(&entry.path)).unwrap();
        let heading = current.lines().find(|l| l.starts_with("# ")).unwrap();
        let head: Vec<&str> = current
            .lines()
            .take_while(|l| !l.starts_with("# "))
            .collect();
        std::fs::write(
            dir.join(&entry.path),
            format!(
                "{}\n{}\n\nthe writer rewrote this somewhere else entirely\n",
                head.join("\n"),
                heading
            ),
        )
        .unwrap();

        let rows = changes_in(&dir, &src, &mirror::detect(&dir));
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, mirror::PROSE);
        assert_eq!(rows[0].id, entry.id);
    }

    /// A SCENE MOVED INTO THE BIBLE, WITH AN EXTERNAL EDIT STILL PENDING. The
    /// next pass will remove its file, because the item has left the book; the
    /// change set has to say so from the book's side rather than describing the
    /// row as a live scene the writer can accept an edit into. Reached only
    /// through the WALK this function filters -- the manifest still names the
    /// entry and the file is still on disk.
    #[test]
    fn a_scene_moved_into_the_bible_is_no_longer_a_row_the_change_set_can_accept() {
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());

        let manifest: recovery::Manifest<mirror::MirrorEntry> =
            recovery::read_manifest(&dir).unwrap();
        let mut manifest = manifest;
        for entry in &mut manifest.entries {
            entry.mtime_ms -= 1;
        }
        recovery::write_manifest(&dir, &manifest).unwrap();
        let entry = manifest
            .entries
            .iter()
            .find(|e| e.words > 0)
            .unwrap()
            .clone();

        // The writer's edit, in the folder, exactly as the sibling test makes
        // one -- so the two differ in ONE thing and this fixture cannot pass by
        // failing to produce a change at all.
        let current = std::fs::read_to_string(dir.join(&entry.path)).unwrap();
        let heading = current.lines().find(|l| l.starts_with("# ")).unwrap();
        let head: Vec<&str> = current
            .lines()
            .take_while(|l| !l.starts_with("# "))
            .collect();
        std::fs::write(
            dir.join(&entry.path),
            format!(
                "{}\n{}\n\nthe writer rewrote this somewhere else entirely\n",
                head.join("\n"),
                heading
            ),
        )
        .unwrap();

        // And then, in the application, moved that scene out of the book.
        {
            let store = store::Store::open(&src).unwrap();
            let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
            let rev = store
                .items()
                .unwrap()
                .into_iter()
                .find(|i| i.id == entry.id)
                .expect("the mirrored scene")
                .rev;
            store
                .item_move(&entry.id, Some(&bible.id), None, rev)
                .unwrap();
        }

        let rows = changes_in(&dir, &src, &mirror::detect(&dir));
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(
            rows[0].state,
            mirror::ADDED,
            "the book has nothing for this file any more"
        );
        assert_eq!(
            rows[0].title, "",
            "a row the book does not hold has no title"
        );
    }

    #[test]
    fn a_scan_REPLACES_the_pause_set_rather_than_adding_to_it() {
        // A switch is the case. Project A's paused ids describe files in A's
        // mirror folder and mean nothing in B's; carried across, they would
        // pause scenes in B that nobody has touched -- and a paused scene stops
        // being maintained, silently, for as long as the window stays open.
        let paused = Mutex::new(std::collections::HashSet::from([
            "from-project-a".to_string()
        ]));
        let found = crate::mirror::DetectReport {
            changed: vec!["in-project-b".to_string()],
            ..Default::default()
        };

        assert!(install_paused(&paused, &found));
        assert_eq!(
            paused.lock().unwrap().clone(),
            std::collections::HashSet::from(["in-project-b".to_string()])
        );
    }

    #[test]
    fn a_scan_that_found_nothing_leaves_no_pause_behind() {
        let paused = Mutex::new(std::collections::HashSet::from(["stale".to_string()]));

        assert!(install_paused(
            &paused,
            &crate::mirror::DetectReport::default()
        ));
        assert!(paused.lock().unwrap().is_empty());
    }

    #[test]
    fn a_scan_that_changed_nothing_reports_so_and_the_page_is_not_told() {
        // The emit is what makes the indicator re-read, and an emit per open
        // that says nothing new is a state change the page cannot distinguish
        // from a real one. The ordinary case -- a mirror nobody touched -- must
        // be silent.
        let paused = Mutex::new(std::collections::HashSet::from(["same".to_string()]));
        let found = crate::mirror::DetectReport {
            changed: vec!["same".to_string()],
            ..Default::default()
        };

        assert!(!install_paused(&paused, &found));
        assert_eq!(
            paused.lock().unwrap().clone(),
            std::collections::HashSet::from(["same".to_string()])
        );
    }

    #[test]
    fn a_detect_persist_failure_installs_its_findings_before_returning_error() {
        let paused = Arc::new(Mutex::new(PauseIds::from(["already-held".to_string()])));
        let result = Err(mirror::DetectFailure {
            found: mirror::DetectReport {
                changed: vec!["newly-found".to_string()],
                ..Default::default()
            },
            error: "injected pause-record failure".to_string(),
        });

        let (found, error, moved) = install_detect_result(&paused, result);

        assert!(moved);
        assert_eq!(found.changed, vec!["newly-found".to_string()]);
        assert_eq!(error.as_deref(), Some("injected pause-record failure"));
        assert_eq!(
            paused.lock().unwrap().clone(),
            PauseIds::from(["newly-found".to_string()])
        );
    }

    #[test]
    fn a_DELETED_file_is_never_paused_however_the_scan_reports_it() {
        // `changed` is the pause set and `deleted_outside` is not, and the
        // wiring must not quietly union them: pausing a deletion would leave
        // the writer's folder short a scene with nothing able to put it back.
        let paused = Mutex::new(std::collections::HashSet::new());
        let found = crate::mirror::DetectReport {
            deleted_outside: vec!["gone".to_string()],
            unmatched: vec!["stray.md".to_string()],
            ..Default::default()
        };

        assert!(!install_paused(&paused, &found));
        assert!(paused.lock().unwrap().is_empty());
    }

    #[test]
    fn thorough_only_prose_reaches_the_real_compare_and_accept_path() {
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());
        let mut manifest: recovery::Manifest<mirror::MirrorEntry> =
            recovery::read_manifest(&dir).unwrap();
        let entry = manifest.entries.iter().find(|entry| entry.words > 0).unwrap().clone();
        let path = dir.join(&entry.path);
        let current = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, current.replace("four words", "five words")).unwrap();
        let modified = std::fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        manifest
            .entries
            .iter_mut()
            .find(|candidate| candidate.id == entry.id)
            .unwrap()
            .mtime_ms = modified;
        recovery::write_manifest(&dir, &manifest).unwrap();
        assert!(mirror::detect(&dir).changed.is_empty());

        let paused = Arc::new(Mutex::new(PauseIds::new()));
        let (checked, moved) = check_mirror(&dir, &paused);
        assert!(moved);
        assert_eq!(checked.unwrap().changed, 1);
        let found = mirror::detect_with_paused(&dir, &paused.lock().unwrap().clone());
        let rows = changes_in(&dir, &src, &found);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, mirror::PROSE);

        let mut project = open_for_test(&src);
        let outcome = accept_into(&mut project, &rows, std::slice::from_ref(&entry.id)).unwrap();
        assert_eq!(outcome.report.documents.len(), 1);
        assert!(store::document_text(&project.store.load_doc(&entry.id).unwrap().body)
            .unwrap()
            .contains("five words"));
    }

    #[test]
    fn failed_checks_keep_existing_partial_and_unreadable_pauses() {
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());
        {
            let store = store::Store::open(&src).unwrap();
            let other = store.item_create(None, "scene", "Other").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: other.id,
                    body: body("another scene has words"),
                    base_rev: 1,
                    comments: None,
                }])
                .unwrap();
        }
        mirror::pass(
            &src,
            "my-book",
            "My Book",
            &dir,
            store::now_ms(),
            &PauseIds::new(),
        )
        .unwrap();
        let manifest: recovery::Manifest<mirror::MirrorEntry> =
            recovery::read_manifest(&dir).unwrap();
        let mut entries = manifest.entries.iter().filter(|entry| entry.words > 0);
        let changed = entries.next().unwrap();
        let unreadable = entries.next().unwrap();
        let mut bytes = std::fs::read(dir.join(&changed.path)).unwrap();
        bytes[0] ^= 1;
        std::fs::write(dir.join(&changed.path), bytes).unwrap();
        std::fs::remove_file(dir.join(&unreadable.path)).unwrap();
        std::fs::create_dir(dir.join(&unreadable.path)).unwrap();

        let paused = Arc::new(Mutex::new(PauseIds::from(["existing".to_string()])));
        let (result, _) = check_mirror(&dir, &paused);
        assert!(result.is_err());
        let held = paused.lock().unwrap().clone();
        assert!(held.contains("existing"));
        assert!(held.contains(&changed.id));
        assert!(held.contains(&unreadable.id));

        std::fs::write(dir.join(recovery::MANIFEST_NAME), b"not json").unwrap();
        let (result, _) = check_mirror(&dir, &paused);
        assert!(result.is_err());
        assert_eq!(paused.lock().unwrap().clone(), held);
    }

    #[test]
    fn a_waiting_writer_takes_its_pause_snapshot_after_the_pass_lock() {
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());
        let manifest: recovery::Manifest<mirror::MirrorEntry> =
            recovery::read_manifest(&dir).unwrap();
        let entry = manifest.entries.iter().find(|entry| entry.words > 0).unwrap().clone();
        let path = dir.join(&entry.path);
        let outside = std::fs::read_to_string(&path)
            .unwrap()
            .replace("four words go here", "outside words stay here");
        std::fs::write(&path, &outside).unwrap();
        {
            let store = store::Store::open(&src).unwrap();
            let doc = store.load_doc(&entry.id).unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: entry.id.clone(),
                    body: body("the application changed this scene"),
                    base_rev: doc.rev,
                    comments: None,
                }])
                .unwrap();
        }

        let paused = Arc::new(Mutex::new(PauseIds::new()));
        let book_id = super::project_book_id(&store::Store::open_readonly(&src).unwrap()).unwrap();
        let data_home = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        enable_test_mirror(&data_home, &book_id);
        let context = super::MirrorContext {
            book_id,
            registry_home: None,
            path: src,
            name: "My Book".to_string(),
            generation: 1,
            paused: paused.clone(),
        };
        let passing = Arc::new(Mutex::new(()));
        let held = passing.lock().unwrap();
        let worker_passing = passing.clone();
        let writer = std::thread::spawn(move || {
            pass_mirror(
                &context,
                &data_home,
                Some(&root),
                &worker_passing,
                store::now_ms(),
            )
        });
        assert!(install_paused(
            &paused,
            &mirror::DetectReport {
                changed: vec![entry.id],
                ..Default::default()
            },
        ));
        drop(held);
        writer.join().unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), outside);
    }

    #[test]
    fn switching_to_a_same_identity_copy_keeps_pauses_and_schedules_its_prose() {
        let tmp = tempdir().unwrap();
        let original = tmp.path().join("original.db");
        let copy = tmp.path().join("copy.db");
        let project = open_for_test(&original);
        project.store.checkpoint().unwrap();
        std::fs::copy(&original, &copy).unwrap();
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(Some(&project.book_id))));
        let state = StoreState(Mutex::new(Some(project)));
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        let old = mirror_context(&state, &paused).unwrap();
        old.paused.lock().unwrap().insert("externally-edited-scene".into());

        set_open_project(&state, &paused, &dirty, open_for_test(&copy));

        let next = mirror_context(&state, &paused).unwrap();
        assert_eq!(old.book_id, next.book_id);
        assert_ne!(old.generation, next.generation);
        assert!(Arc::ptr_eq(&old.paused, &next.paused));
        assert!(next.paused.lock().unwrap().contains("externally-edited-scene"));
        assert!(dirty.0.load(Ordering::Relaxed));
        assert!(dirty.1.load(Ordering::Relaxed));
    }

    #[test]
    fn repeated_project_switches_keep_one_live_handle_and_new_work_pending() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a.db");
        let b = tmp.path().join("b.db");
        let state = StoreState(Mutex::new(Some(open_for_test(&a))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let dirty = MirrorDirty(AtomicBool::new(true), AtomicBool::new(true));

        let pending = take_dirty_mirror_context(&state, &paused, &dirty).unwrap();
        assert!(dirty.1.load(Ordering::Relaxed), "claiming work must keep updating armed");
        let old = pending.paused.clone();
        let old_locked = old.lock().unwrap();
        set_open_project(&state, &paused, &dirty, open_for_test(&b));
        let current_b = mirror_context(&state, &paused).unwrap();
        assert!(!mirror_pending(&dirty), "an actual switch clears both pending bits");
        assert!(!Arc::ptr_eq(&current_b.paused, &old));
        assert!(current_b.paused.lock().unwrap().is_empty());
        set_open_project(&state, &paused, &dirty, open_for_test(&a));
        let reopened_a = mirror_context(&state, &paused).unwrap();
        assert!(Arc::ptr_eq(&reopened_a.paused, &old));
        drop(old_locked);

        assert!(install_paused(
            &pending.paused,
            &mirror::DetectReport {
                changed: vec!["late-old".to_string()],
                ..Default::default()
            },
        ));
        {
            let _guard = locked(&state);
            dirty.0.store(true, Ordering::Relaxed);
        }
        assert!(dirty.0.load(Ordering::Relaxed));
        assert_eq!(
            reopened_a.paused.lock().unwrap().clone(),
            PauseIds::from(["late-old".to_string()])
        );
    }

    #[test]
    fn committed_mirror_marks_coalesce_through_a_disabled_claim() {
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        assert!(mark_mirror_dirty(&dirty));
        assert!(!mark_mirror_dirty(&dirty));
        assert!(mirror_pending(&dirty));

        // A disabled scheduler claim consumes only work, leaving the one
        // visible pending interval armed for a later enable.
        dirty.0.store(false, Ordering::Relaxed);
        assert!(mirror_pending(&dirty));
        assert!(!mark_mirror_dirty(&dirty));
    }

    #[test]
    fn mirror_completion_keeps_a_flush_that_landed_during_the_pass_pending() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a.db");
        let state = StoreState(Mutex::new(Some(open_for_test(&a))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        let outcome = MirrorState(Mutex::new(mirror::PassOutcome::default()));

        assert!(mark_mirror_dirty(&dirty));
        let context = take_dirty_mirror_context(&state, &paused, &dirty).unwrap();
        assert!(mirror_pending(&dirty), "the claimed pass remains updating");
        assert!(!mark_mirror_dirty(&dirty), "the later flush is coalesced");
        assert!(finish_mirror_pass(
            &state, &paused, &dirty, &outcome, &context, Ok(()), store::now_ms(),
        ));
        assert!(dirty.0.load(Ordering::Relaxed));
        assert!(dirty.1.load(Ordering::Relaxed));

        let next = take_dirty_mirror_context(&state, &paused, &dirty).unwrap();
        assert!(finish_mirror_pass(
            &state, &paused, &dirty, &outcome, &next, Ok(()), store::now_ms(),
        ));
        assert!(!mirror_pending(&dirty), "a quiet completion returns current");
    }

    #[test]
    fn a_held_wordlist_is_named_by_the_mirror_status_after_the_scenes_are_current() {
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());
        let state = StoreState(Mutex::new(Some(open_for_test(&src))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let context = mirror_context(&state, &paused).unwrap();
        let data_home = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        enable_test_mirror(&data_home, &context.book_id);
        let list = dir.join(crate::mirror_wordlist::WORDLIST_NAME);
        std::fs::write(&list, "the writer's list\n").unwrap();
        {
            let store = store::Store::open(&src).unwrap();
            store.dict_add("Mireth").unwrap();
            let item = store.items().unwrap().remove(0);
            store.item_rename(&item.id, "Renamed Storm", item.rev).unwrap();
        }

        let now = store::now_ms();
        let passing = Mutex::new(());
        let error = pass_mirror(&context, &data_home, Some(&root), &passing, now).unwrap_err();
        assert!(error.contains("wordlist.txt"), "{error}");
        assert_eq!(std::fs::read_to_string(&list).unwrap(), "the writer's list\n");
        let manifest: recovery::Manifest<mirror::MirrorEntry> = recovery::read_manifest(&dir).unwrap();
        assert!(manifest.entries[0].path.contains("Renamed"));
        assert!(dir.join(&manifest.entries[0].path).is_file());

        let mut outcome = mirror::PassOutcome::default();
        outcome.record(Err(error), now);
        let report = mirror::describe(&dir, true, &outcome, &PauseIds::new(), false);
        assert!(!report.last_ok);
        assert!(report.last_error.unwrap().contains("wordlist.txt"));
        assert_eq!(report.generated_at, Some(now));
    }

    #[test]
    fn enabling_the_mirror_succeeds_when_only_the_wordlist_is_held() {
        let tmp = tempdir().unwrap();
        let (src, dir) = mirrored_project(tmp.path());
        let state = StoreState(Mutex::new(Some(open_for_test(&src))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let context = mirror_context(&state, &paused).unwrap();
        let data_home = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        enable_test_mirror(&data_home, &context.book_id);

        let (status, act) = enable_outcome(pass_scenes_while_held(&context, &data_home, Some(&root), store::now_ms()));
        assert_eq!((status, act), (Ok(()), Ok(())));

        std::fs::write(dir.join(crate::mirror_wordlist::WORDLIST_NAME), "the writer's list\n").unwrap();
        store::Store::open(&src).unwrap().dict_add("Mireth").unwrap();
        let (status, act) = enable_outcome(pass_scenes_while_held(&context, &data_home, Some(&root), store::now_ms()));
        assert_eq!(act, Ok(()), "the act succeeded; the status names the list");
        assert!(status.unwrap_err().contains("wordlist.txt"));

        let (status, act) = enable_outcome(Err("the folder is unavailable".to_string()));
        assert_eq!(status, Err("the folder is unavailable".to_string()));
        assert_eq!(act, Err("the folder is unavailable".to_string()));
    }

    #[test]
    fn a_noop_enabled_pass_completes_the_visible_pending_interval() {
        let tmp = tempdir().unwrap();
        let (src, _) = mirrored_project(tmp.path());
        let state = StoreState(Mutex::new(Some(open_for_test(&src))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(true));
        let outcome = MirrorState(Mutex::new(mirror::PassOutcome::default()));
        let context = mirror_context(&state, &paused).unwrap();
        let data_home = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        enable_test_mirror(&data_home, &context.book_id);
        let passing = Mutex::new(());
        let report = pass_mirror(&context, &data_home, Some(&root), &passing, store::now_ms()).unwrap();

        assert_eq!(report.written, 0);
        assert_eq!(report.removed, 0);
        assert!(finish_mirror_pass(
            &state, &paused, &dirty, &outcome, &context, Ok(()), store::now_ms(),
        ));
        assert!(!mirror_pending(&dirty));
        assert!(begin_mirror_pass_if_current(&state, &paused, &dirty, &context));
        assert!(finish_mirror_pass(
            &state, &paused, &dirty, &outcome, &context,
            Err("folder unavailable".to_string()), store::now_ms(),
        ));
        assert!(!mirror_pending(&dirty));
        assert_eq!(outcome.0.lock().unwrap().last_error.as_deref(), Some("folder unavailable"));
    }

    #[test]
    fn a_stale_completion_cannot_clear_a_reopened_books_rearmed_work() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a.db");
        let state = StoreState(Mutex::new(Some(open_for_test(&a))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        let outcome = MirrorState(Mutex::new(mirror::PassOutcome::default()));

        assert!(mark_mirror_dirty(&dirty));
        let old = take_dirty_mirror_context(&state, &paused, &dirty).unwrap();
        set_open_project(&state, &paused, &dirty, open_for_test(&a));
        assert!(dirty.0.load(Ordering::Relaxed), "same-path reopen re-arms claimed work");
        assert!(dirty.1.load(Ordering::Relaxed));
        assert!(!finish_mirror_pass(
            &state, &paused, &dirty, &outcome, &old, Ok(()), store::now_ms(),
        ));
        assert!(mirror_pending(&dirty), "the stale pass did not clear the new generation");
        assert!(outcome.0.lock().unwrap().last_run_ms.is_none(), "a stale pass rewrote the outcome");
    }

    #[test]
    fn mirror_toggle_reset_is_owned_by_the_current_project() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a.db");
        let state = StoreState(Mutex::new(Some(open_for_test(&a))));
        let paused = MirrorPaused(Mutex::new(super::MirrorPauseState::new(locked(&state).as_ref().map(|p| p.book_id.as_str()))));
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        assert!(mark_mirror_dirty(&dirty));
        let context = mirror_context(&state, &paused).unwrap();
        assert!(reset_mirror_dirty_if_current(&state, &paused, &dirty, &context));
        assert!(!mirror_pending(&dirty));
        assert!(begin_mirror_pass_if_current(&state, &paused, &dirty, &context));
        assert!(mirror_pending(&dirty));
        assert!(!begin_mirror_pass_if_current(&state, &paused, &dirty, &context));
        set_open_project(&state, &paused, &dirty, open_for_test(&a));
        assert!(
            !reset_mirror_dirty_if_current(&state, &paused, &dirty, &context),
            "a stale toggle reset the reopened project"
        );
        assert!(mirror_pending(&dirty));
        let b = tmp.path().join("b.db");
        set_open_project(&state, &paused, &dirty, open_for_test(&b));
        assert!(!mirror_pending(&dirty));
        assert!(!begin_mirror_pass_if_current(&state, &paused, &dirty, &context));
        assert!(!mirror_pending(&dirty), "a stale pass marked the new book pending");
    }

    /// The only executable evidence stage 3's mechanism works at all: the
    /// watcher thread itself cannot be driven from a test, and the two things
    /// it assumes about the crate are exactly the two things that would fail
    /// SILENTLY if a version bump changed them.
    ///
    /// A blocking read would park the thread forever on the directory it armed
    /// first, so a switch would never be noticed and the watcher would go on
    /// watching a project nobody has open -- with every test in this file still
    /// green, because the scan is what they check.
    #[test]
    fn the_watchers_read_does_not_block_and_its_mask_sees_a_write() {
        use inotify::WatchMask;
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join("a.md"), "one").unwrap();
        let mut i = inotify::Inotify::init().unwrap();
        i.watches()
            .add(
                tmp.path(),
                WatchMask::MODIFY | WatchMask::CLOSE_WRITE | WatchMask::CREATE,
            )
            .unwrap();
        let mut buf = [0u8; 4096];
        // Non-blocking before anything happened.
        let empty = i.read_events(&mut buf);
        assert_eq!(empty.unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        std::fs::write(tmp.path().join("a.md"), "two").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(i.read_events(&mut buf).unwrap().count() > 0);
    }

    #[test]
    fn a_deleted_scene_leaves_the_project_total() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let keep = create_into(&mut project, None, "scene", "Keep").unwrap();
        let drop = create_into(&mut project, None, "scene", "Drop").unwrap();
        flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("four words go here"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: drop.id.clone(),
                    body: body("three more words"),
                    base_rev: drop.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 7);

        delete_into_bin(&mut project, &drop.id, 1);

        assert_eq!(
            project.word_count().words,
            4,
            "the deleted words still count"
        );
        // The index itself is untouched: the words are excluded, not forgotten.
        // This is what makes the next test possible at all.
        assert_eq!(project.words.count().words, 7);
    }

    /// A bible document in a project holding a bible root, built through the
    /// same commands the page uses. Returns `(bible root id, note id)`.
    fn note_in_bible(project: &mut OpenProject, title: &str, text: &str) -> (String, String) {
        let bible = match project
            .store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.item_type == crate::store::BIBLE_TYPE && i.depth == 0)
        {
            Some(existing) => existing.id,
            // The literal the PAGE sends, exactly as `delete_into_bin` sends the
            // bin's. The store names no title for either.
            None => {
                create_into(project, None, crate::store::BIBLE_TYPE, "Bible")
                    .unwrap()
                    .id
            }
        };
        let note = create_into(project, Some(&bible), crate::store::NOTE_TYPE, title).unwrap();
        flush_into(
            project,
            &[FlushEntry {
                item_id: note.id.clone(),
                body: body(text),
                base_rev: note.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        (bible, note.id)
    }

    /// FIND KEEPS THE BIBLE AND LABELS IT. A product choice, argued in the
    /// design record: a writer searching a project means the project, and
    /// `SearchItem.kind` already carries the type, so a bible hit arrives
    /// distinguishable rather than missing. The bin is the opposite case and
    /// stays hidden -- a hit there offers the writer a result that opens
    /// something they removed.
    #[test]
    fn find_returns_bible_prose_labelled_by_its_type_and_no_binned_prose() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let mut project = opened(&path);

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        let binned = create_into(&mut project, None, "scene", "Deleted").unwrap();
        flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: scene.id.clone(),
                    body: body("the harbour at dawn"),
                    base_rev: scene.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: binned.id.clone(),
                    body: body("the harbour once stood here"),
                    base_rev: binned.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();
        let (_, note) = note_in_bible(&mut project, "Places", "the harbour was built twice");
        delete_into_bin(&mut project, &binned.id, 1);
        drop(project);

        let hits = find_in(&path, "harbour", 50).unwrap();
        let ids: Vec<&str> = hits.results.iter().map(|r| r.item_id.as_str()).collect();
        assert!(
            ids.contains(&scene.id.as_str()),
            "the manuscript hit is missing"
        );
        assert!(
            ids.contains(&note.as_str()),
            "the bible hit was hidden, not labelled"
        );
        assert!(
            !ids.contains(&binned.id.as_str()),
            "a binned hit reached the panel"
        );
        let labelled = hits
            .results
            .iter()
            .find(|r| r.item_id == note)
            .expect("the bible hit");
        assert_eq!(
            labelled.kind,
            crate::store::NOTE_TYPE,
            "the hit carries no label saying it is not the book"
        );
    }

    /// A timeline under the bible, flushed with a body a naive search would
    /// match on. Returns `(bible root id, timeline id)`. Mirrors
    /// `note_in_bible`'s shape; the difference is the body it flushes is a
    /// timeline's opaque JSON, never a ProseMirror document.
    fn timeline_in_bible(project: &mut OpenProject, title: &str, event_title: &str) -> (String, String) {
        let bible = match project
            .store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.item_type == crate::store::BIBLE_TYPE && i.depth == 0)
        {
            Some(existing) => existing.id,
            None => {
                create_into(project, None, crate::store::BIBLE_TYPE, "Bible")
                    .unwrap()
                    .id
            }
        };
        let timeline =
            create_into(project, Some(&bible), crate::store::TIMELINE_TYPE, title).unwrap();
        flush_into(
            project,
            &[FlushEntry {
                item_id: timeline.id.clone(),
                body: format!(
                    r#"{{"kind":"timeline","version":1,"scale":{{"unit":"day","zero":"","calendar":null,"eras":[]}},"tracks":[],"branches":[],"events":[{{"id":"v1","title":"{event_title}","at":1,"until":null,"tracks":[],"branch":null,"scene":null,"cast":[],"note":""}}]}}"#
                ),
                base_rev: timeline.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        (bible, timeline.id)
    }

    /// A TIMELINE IS NEVER A HIT, even when the query is a substring of an
    /// event title stored inside its body. `document_texts`' join excludes it
    /// before `find::search` ever sees the item at all -- a fixture that could
    /// not fail the query, per the found-eight-times rule: the event title
    /// here IS "harbour survey", not a coincidence borrowed from the scene's
    /// prose, so removing the join makes this FAIL.
    #[test]
    fn a_timeline_body_is_never_a_search_hit_even_when_it_contains_the_query() {
        // MAJOR review finding: asserting only "no hit" here is unfalsifiable
        // -- `document_texts` never inserts a text entry for a timeline
        // EITHER WAY, because its opaque body is not a ProseMirror document
        // and `document_text` returns `None` for it whether or not the join
        // excludes the row; what the join changes is `scanned`/`skipped`,
        // never `results`. A SCENE is added so `scanned` has a real prose
        // document to count, and `skipped` is asserted at 0: without the
        // join the timeline's row would still be scanned (bumping `scanned`
        // to 2) and its unparseable body would land in `skipped` (1), which
        // is what fails this test if the exclusion is removed.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let mut project = opened(&path);
        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the harbour at dawn"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let (_, timeline) = timeline_in_bible(&mut project, "Timeline", "harbour survey");
        drop(project);

        let hits = find_in(&path, "harbour", 50).unwrap();
        let ids: Vec<&str> = hits.results.iter().map(|r| r.item_id.as_str()).collect();
        assert!(
            !ids.contains(&timeline.as_str()),
            "a hit landed inside a timeline's body"
        );
        assert_eq!(hits.scanned, 1, "the timeline was scanned as a document");
        assert_eq!(
            hits.skipped, 0,
            "a healthy timeline was counted as a document that could not be read"
        );
    }

    /// MAJOR review finding: the create-time guard in `create_into_after`
    /// (`&& item_type != store::TIMELINE_TYPE`) was untested, because the
    /// test beside this one reads `word_count()`, which SUBTRACTS the raw
    /// index by id for anything in the bible subtree -- so a spurious
    /// present entry the guard exists to prevent gets subtracted right back
    /// out and the figure comes out right either way. This reads the RAW
    /// index instead, before any subtraction, which is the only place the
    /// guard's absence is visible at all.
    #[test]
    fn creating_a_timeline_never_enters_the_raw_word_index() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        let before = project.words.len();
        let bible = create_into(&mut project, None, store::BIBLE_TYPE, "Bible").unwrap();
        create_into(&mut project, Some(&bible.id), store::TIMELINE_TYPE, "Timeline").unwrap();
        assert_eq!(
            project.words.len(),
            before,
            "a just-created timeline gained a present entry in the raw index"
        );
        // AGREES WITH A FRESH OPEN, which never calls `record` for a timeline
        // id at all -- `word_index`'s own SQL join excludes the row before
        // the scan ever reaches it. A session's incremental index and a
        // reopen's fresh scan must describe the same set of known documents.
        let reopened = project.store.word_index().unwrap();
        assert_eq!(project.words.len(), reopened.len());
    }

    /// A TIMELINE IS NEVER COUNTED AND NEVER SKIPPED. Its body is not prose,
    /// so `word_index`'s join must keep it from `document_lines`' parse
    /// entirely -- reaching that parse at all would count a healthy timeline
    /// as a corrupt document (`skipped`) and print it to stderr, which is
    /// exactly the false alarm `TIMELINE_TYPE`'s own comment names.
    #[test]
    fn a_timeline_is_never_counted_and_never_reported_skipped() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        timeline_in_bible(&mut project, "Timeline", "publishes a survey of the harbour");

        assert_eq!(
            project.word_count(),
            WordCount {
                words: 4,
                skipped: 0
            },
            "the timeline's own words must not appear, and must not count as \
             a document that could not be read"
        );
    }

    /// CARRIED IN FROM 101's REVIEW. `word_count()` (the exclusion-masked
    /// figure the test above checks) already hid this: a timeline sits under
    /// the bible, and the bible is excluded, so the raw index's `skipped`
    /// bump above cancelled out before a writer could see it. This test
    /// reads the RAW index instead -- `project.words.count()`, no
    /// exclusion -- which is what a flusher over a timeline (this slice)
    /// would otherwise bump on the FIRST flush of a fresh timeline, before
    /// `flush_into`'s type check landed.
    #[test]
    fn flushing_a_timeline_body_never_bumps_the_raw_skipped_count() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        let before = project.words.count();
        timeline_in_bible(&mut project, "Timeline", "publishes a survey of the harbour");
        assert_eq!(
            project.words.count(),
            before,
            "a flushed timeline body must not reach the raw word index at all"
        );
    }

    /// THE COMPLETENESS FIGURES COUNT THE BIBLE, DELIBERATELY. They describe
    /// what a recovery point HOLDS -- whether the copy is whole -- not what the
    /// book is. A bible document is in the file and is restored with it, so a
    /// figure that left it out would report a complete copy as short.
    #[test]
    fn a_recovery_point_counts_the_bible_because_it_restores_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let mut project = opened(&path);
        create_into(&mut project, None, "scene", "Scene").unwrap();
        note_in_bible(&mut project, "Synopsis", "three more words");
        drop(project);

        let store = crate::store::Store::open_readonly(&path).unwrap();
        let documents = store.documents().unwrap().len();
        let items = store.items().unwrap().len();
        assert_eq!(documents, 2, "the note's document is in the file");
        assert_eq!(items, 3, "the scene, the bible root and the note");
    }

    /// THE MAIN ONE. `word_index` scans the `doc` table blind, so a bible
    /// document IS in the index -- it has to be, it is prose the writer flushes
    /// and the history versions. What keeps it out of the book is the exclusion
    /// by id, and nothing else.
    #[test]
    fn a_bible_document_is_indexed_and_excluded_from_the_project_total() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let keep = create_into(&mut project, None, "scene", "Keep").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: keep.id.clone(),
                body: body("four words go here"),
                base_rev: keep.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let (_, note) = note_in_bible(&mut project, "Synopsis", "three more words");

        assert_eq!(project.word_count().words, 4, "the bible is not the book");
        // The index HOLDS them. Excluded, not absent -- which is what makes the
        // document restorable to the manuscript by a move and nothing else.
        assert_eq!(project.words.count().words, 7);
        let counts = project.word_counts();
        assert_eq!(counts.get(&keep.id), Some(&4));
        assert!(
            !counts.contains_key(&note),
            "a bible document is not a scene of the book"
        );
    }

    #[test]
    fn document_counts_withhold_the_bible_and_keep_each_live_documents_figures() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let keep = create_into(&mut project, None, "scene", "Keep").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: keep.id.clone(),
                body: paragraphs(&["One. Two.", "Three"]),
                base_rev: keep.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let (_, note) = note_in_bible(&mut project, "Synopsis", "Four. Five.");

        let counts = project.document_counts();
        assert_eq!(
            counts.get(&keep.id),
            Some(&store::DocumentCounts {
                words: 3,
                sentences: 3,
                paragraphs: 2,
            })
        );
        assert!(
            !counts.contains_key(&note),
            "a bible document is not a scene of the book"
        );
        // The index HOLDS the bible's figures, excluded rather than absent.
        assert_eq!(
            project.words.units_excluding(&Default::default()),
            store::Units {
                sentences: 5,
                paragraphs: 3,
            }
        );
    }

    /// The bible root can be created AFTER the words it will come to hold are
    /// already counted -- a writer moves a scene of notes into it. The cached
    /// set has to follow the move, which is the arm `create_into`'s narrowed
    /// refresh cannot reach.
    #[test]
    fn moving_a_scene_into_the_bible_takes_its_words_out_of_the_book() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let notes = create_into(&mut project, None, "scene", "Notes").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: notes.id.clone(),
                body: body("three more words"),
                base_rev: notes.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 3);

        let bible = create_into(&mut project, None, crate::store::BIBLE_TYPE, "Bible").unwrap();
        move_within(&mut project, &notes.id, Some(&bible.id), None, 1).unwrap();

        assert_eq!(project.word_count().words, 0, "moved out of the book");
    }

    /// THE SECOND DEFECT. A manuscript-wide replace would rewrite the writer's
    /// world building -- prose they never saw in a result list, with only a
    /// snapshot to get it back.
    #[test]
    fn a_replace_across_the_book_does_not_rewrite_bible_prose() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the harbour at dawn"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let (_, note) = note_in_bible(&mut project, "Places", "the harbour was built twice");

        let report = replace_across(&mut project, "harbour", "wharf").unwrap();
        assert_eq!(report.documents, 1, "one document, and it is the scene");
        assert!(
            project
                .store
                .load_doc(&scene.id)
                .unwrap()
                .body
                .contains("wharf"),
            "the manuscript was not rewritten"
        );
        assert!(
            project
                .store
                .load_doc(&note)
                .unwrap()
                .body
                .contains("harbour"),
            "the bible was rewritten by a replace across the BOOK"
        );
    }

    /// A SYNOPSIS IS NOT PROSE AND NEVER REACHES THE WORD COUNT, and it is free
    /// rather than filtered: `word_index` scans the `doc` table, and a synopsis
    /// is a row in a table of its own that the scan never names. VERIFIED here
    /// rather than assumed, because "free" is exactly the claim that stops being
    /// true the day somebody relaxes `doc.item_id` to a compound key.
    ///
    /// The scene's four words are asserted as well, so the test cannot be
    /// satisfied by a count that reports nothing at all.
    #[test]
    fn a_synopsis_is_not_prose_and_does_not_reach_the_word_count() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 4);

        project
            .store
            .synopsis_set(&scene.id, "She finds the letter and burns it before dawn")
            .unwrap();

        assert_eq!(
            project.word_count().words,
            4,
            "a synopsis reached the manuscript's total"
        );
        // The RAW index too, not only the excluded view: the bible is kept out
        // by an id set, and a synopsis must never need one.
        assert_eq!(project.words.count().words, 4);
        assert_eq!(project.word_counts().get(&scene.id), Some(&4));
        assert_index_matches_a_full_recount(&project);
    }

    /// A CONTAINER CARRIES ONE AND IT STILL COUNTS NOTHING. The chapter has no
    /// `doc` row at all, so this is the case where a synopsis stored as a second
    /// document would have created words for an item that has none.
    #[test]
    fn a_synopsis_on_a_chapter_creates_no_words_for_a_row_that_has_none() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let chapter = create_into(&mut project, None, "chapter", "Chapter 1").unwrap();
        project
            .store
            .synopsis_set(&chapter.id, "the letter arrives and is burned")
            .unwrap();

        assert_eq!(project.word_count().words, 0);
        assert!(!project.word_counts().contains_key(&chapter.id));
        assert_index_matches_a_full_recount(&project);
    }

    /// FIND AND REPLACE ACROSS THE BOOK DOES NOT REACH A SYNOPSIS.
    /// `replace_everywhere` walks `FROM doc`, so this is free for the same
    /// reason the count is -- and it is the consequence that would hurt most, a
    /// silent rewrite of notes the writer never saw in a result list.
    #[test]
    fn a_replace_across_the_book_does_not_rewrite_a_synopsis() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the harbour at dawn"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        project
            .store
            .synopsis_set(&scene.id, "they meet at the harbour")
            .unwrap();

        let report = replace_across(&mut project, "harbour", "wharf").unwrap();

        assert_eq!(report.documents, 1, "one document, and it is the scene");
        assert!(
            project
                .store
                .load_doc(&scene.id)
                .unwrap()
                .body
                .contains("wharf"),
            "the manuscript was not rewritten, so this test proves nothing"
        );
        assert_eq!(
            project.store.synopsis(&scene.id).unwrap().unwrap().body,
            "they meet at the harbour",
            "the synopsis was rewritten by a replace across the BOOK"
        );
    }

    /// A RECOVERY POINT CARRIES SYNOPSES, and it is `VACUUM INTO`'s doing: the
    /// point is a whole standalone copy of the file, so a table nobody taught it
    /// about travels anyway. That is the argument for leaving `recovery::counts`
    /// alone -- the copy is complete without a fourth figure describing it.
    #[test]
    fn a_recovery_point_restores_the_synopsis_that_was_in_the_file() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.db");
        let point = dir.path().join("point.db");
        let scene = {
            let mut project = opened(&source);
            let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
            project
                .store
                .synopsis_set(&scene.id, "as it stood at the point")
                .unwrap();
            project.store.vacuum_into(&point).unwrap();
            // Changed AFTER the copy, so restoring has something to undo.
            project
                .store
                .synopsis_set(&scene.id, "rewritten afterwards")
                .unwrap();
            scene.id
        };

        let restored = crate::store::Store::open_readonly(&point).unwrap();

        assert_eq!(
            restored.synopsis(&scene).unwrap().unwrap().body,
            "as it stood at the point"
        );
    }

    /// A SNAPSHOT IS OF THE BOOK'S PROSE AND A SYNOPSIS IS NOT IN IT.
    /// `snapshot_take` reads `SELECT item_id, body FROM doc`, so a restore
    /// rewrites bodies and touches nothing here. DELIBERATE, and stated as a
    /// test so the next reader finds the decision rather than the silence.
    #[test]
    fn a_snapshot_restore_rewrites_prose_and_leaves_the_synopsis_where_it_is() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the first words"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        project.store.synopsis_set(&scene.id, "as it was").unwrap();
        let snapshot = project.store.snapshot_create("before").unwrap();

        let rev = project.store.load_doc(&scene.id).unwrap().rev;
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the second words"),
                base_rev: rev,
                comments: None,
            }],
            1,
        )
        .unwrap();
        project
            .store
            .synopsis_set(&scene.id, "as it is now")
            .unwrap();

        project.store.snapshot_restore(snapshot.id).unwrap();

        assert!(
            project
                .store
                .load_doc(&scene.id)
                .unwrap()
                .body
                .contains("first"),
            "the snapshot did not restore the prose, so this test proves nothing"
        );
        assert_eq!(
            project.store.synopsis(&scene.id).unwrap().unwrap().body,
            "as it is now",
            "a snapshot restore reached the synopsis"
        );
    }

    /// THE CAST IS NOT PROSE AND NEVER REACHES THE WORD COUNT. Free rather than
    /// filtered, for the reason a synopsis is: `word_index` scans the `doc`
    /// table and a cast member is a row in two tables the scan never names. The
    /// RAW index is asserted as well as the excluded view -- the bible is kept
    /// out by an id set, and the cast must never need one.
    ///
    /// A SUMMARY *AND* A FIELD, because the two are stored in different tables
    /// and a fixture with only one of them could not tell a leak in the other.
    #[test]
    fn the_cast_is_not_prose_and_does_not_reach_the_word_count() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 4);

        let made = project
            .store
            .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
            .unwrap();
        project
            .store
            .cast_set(
                &made.id,
                crate::store::cast::KIND_CHARACTER,
                "Ilse Vandermeer",
                "She finds the letter and burns it before dawn",
                &[crate::store::cast::CastField {
                    label: "accent".into(),
                    value: "a flat northern vowel".into(),
                }],
                &[],
            )
            .unwrap();

        assert_eq!(
            project.word_count().words,
            4,
            "the cast reached the manuscript's total"
        );
        assert_eq!(project.words.count().words, 4);
        assert_eq!(project.word_counts().get(&scene.id), Some(&4));
        assert_index_matches_a_full_recount(&project);
    }

    /// FIND AND REPLACE ACROSS THE BOOK DOES NOT REACH THE CAST.
    /// `replace_everywhere` walks `FROM doc`, so this is free for the reason the
    /// count is -- and it is the consequence that would hurt most: a silent
    /// rewrite of a character sheet the writer never saw in a result list.
    ///
    /// The SUMMARY and the FIELD VALUE both carry the needle, because they are
    /// two tables and one of them could leak alone.
    #[test]
    fn a_replace_across_the_book_does_not_rewrite_the_cast() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the harbour at dawn"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let made = project
            .store
            .cast_create(crate::store::cast::KIND_PLACE, "The harbour")
            .unwrap();
        project
            .store
            .cast_set(
                &made.id,
                crate::store::cast::KIND_PLACE,
                "The harbour",
                "they meet at the harbour",
                &[crate::store::cast::CastField {
                    label: "seen from".into(),
                    value: "the harbour road".into(),
                }],
                &[],
            )
            .unwrap();

        let report = replace_across(&mut project, "harbour", "wharf").unwrap();

        assert_eq!(report.documents, 1, "one document, and it is the scene");
        assert!(
            project
                .store
                .load_doc(&scene.id)
                .unwrap()
                .body
                .contains("wharf"),
            "the manuscript was not rewritten, so this test proves nothing"
        );
        let held = project.store.cast_member(&made.id).unwrap().unwrap();
        assert_eq!(
            held.summary, "they meet at the harbour",
            "the cast summary was rewritten by a replace across the BOOK"
        );
        assert_eq!(
            held.fields[0].value, "the harbour road",
            "a cast field was rewritten by a replace across the BOOK"
        );
        assert_eq!(held.name, "The harbour", "a cast name was rewritten");
    }

    /// A RECOVERY POINT CARRIES THE CAST, and it is `VACUUM INTO`'s doing: the
    /// point is a whole standalone copy of the file, so two tables nobody taught
    /// it about travel anyway. That is the argument for leaving
    /// `recovery::counts` alone -- the copy is complete without a figure
    /// describing it, and this test is the evidence.
    #[test]
    fn a_recovery_point_restores_the_cast_that_was_in_the_file() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.db");
        let point = dir.path().join("point.db");
        let member = {
            let project = opened(&source);
            let made = project
                .store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            project
                .store
                .cast_set(
                    &made.id,
                    crate::store::cast::KIND_CHARACTER,
                    "Ilse",
                    "as she stood at the point",
                    &[crate::store::cast::CastField {
                        label: "accent".into(),
                        value: "flat northern".into(),
                    }],
                    &[],
                )
                .unwrap();
            project.store.vacuum_into(&point).unwrap();
            // Changed AFTER the copy, so restoring has something to undo.
            project
                .store
                .cast_set(
                    &made.id,
                    crate::store::cast::KIND_POI,
                    "Rewritten",
                    "after",
                    &[],
                    &[],
                )
                .unwrap();
            made.id
        };

        let restored = crate::store::Store::open_readonly(&point).unwrap();

        let held = restored.cast_member(&member).unwrap().unwrap();
        assert_eq!(held.name, "Ilse");
        assert_eq!(held.summary, "as she stood at the point");
        assert_eq!(held.fields[0].value, "flat northern");
    }

    /// A SNAPSHOT IS OF THE BOOK'S PROSE AND THE CAST IS NOT IN IT.
    /// `snapshot_take` reads `SELECT item_id, body FROM doc`, so a restore
    /// rewrites bodies and touches nothing here. DELIBERATE, and stated as a
    /// test so the next reader finds the decision rather than the silence: a
    /// writer who restores a snapshot of last Tuesday's prose has not asked to
    /// un-name a character they invented on Wednesday.
    #[test]
    fn a_snapshot_restore_rewrites_prose_and_leaves_the_cast_where_it_is() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the first words"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let made = project
            .store
            .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
            .unwrap();
        let snapshot = project.store.snapshot_create("before").unwrap();

        let rev = project.store.load_doc(&scene.id).unwrap().rev;
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the second words"),
                base_rev: rev,
                comments: None,
            }],
            1,
        )
        .unwrap();
        project
            .store
            .cast_set(
                &made.id,
                crate::store::cast::KIND_CHARACTER,
                "Ilse",
                "as she is now",
                &[],
                &[],
            )
            .unwrap();
        let after = project
            .store
            .cast_create(crate::store::cast::KIND_PLACE, "The Kelp Quay")
            .unwrap();

        project.store.snapshot_restore(snapshot.id).unwrap();

        assert!(
            project
                .store
                .load_doc(&scene.id)
                .unwrap()
                .body
                .contains("first"),
            "the snapshot did not restore the prose, so this test proves nothing"
        );
        assert_eq!(
            project
                .store
                .cast_member(&made.id)
                .unwrap()
                .unwrap()
                .summary,
            "as she is now",
            "a snapshot restore reached a cast member"
        );
        assert!(
            project.store.cast_member(&after.id).unwrap().is_some(),
            "a snapshot restore removed a cast member created after the snapshot"
        );
    }

    /// AN APPEARANCE IS NOT PROSE AND NEVER REACHES THE WORD COUNT. Free rather
    /// than filtered, and free by a wider margin than the cast is: the join
    /// table holds two ID COLUMNS and no text at all, so there is nothing in it
    /// a scan of `doc` could pick up even if it named the table. Asserted
    /// anyway, because "there is nothing to leak" is exactly the kind of claim
    /// a later schema change quietly falsifies -- an appearance that grew a
    /// note field would be prose in a table nobody excludes.
    #[test]
    fn an_appearance_is_not_prose_and_does_not_reach_the_word_count() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 4);
        let made = project
            .store
            .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse Vandermeer")
            .unwrap();

        project
            .store
            .appearances_set(&scene.id, &[made.id.clone()])
            .unwrap();

        assert_eq!(
            project.word_count().words,
            4,
            "an appearance reached the manuscript\'s total"
        );
        assert_eq!(project.word_counts().get(&scene.id), Some(&4));
        assert_index_matches_a_full_recount(&project);
    }

    /// A RECOVERY POINT CARRIES THE APPEARANCES, free, because a point is
    /// `VACUUM INTO` -- a whole physical copy -- so a table nobody taught it
    /// about travels anyway. `recovery::counts` is UNCHANGED for 037\'s reason:
    /// its three figures describe whether the COPY IS WHOLE, and the copy is
    /// whole without a fourth.
    #[test]
    fn a_recovery_point_restores_the_appearances_that_were_in_the_file() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.db");
        let point = dir.path().join("point.db");
        let (scene, member) = {
            let mut project = opened(&source);
            let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
            let made = project
                .store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            project
                .store
                .appearances_set(&scene.id, &[made.id.clone()])
                .unwrap();
            project.store.vacuum_into(&point).unwrap();
            // Untagged AFTER the copy, so restoring has something to undo.
            project.store.appearances_set(&scene.id, &[]).unwrap();
            assert_eq!(project.store.appearance_count().unwrap(), 0);
            (scene.id, made.id)
        };

        let restored = crate::store::Store::open_readonly(&point).unwrap();

        assert_eq!(
            restored.appearances().unwrap().get(&scene).unwrap(),
            &vec![member]
        );
    }

    /// A SNAPSHOT IS OF THE BOOK\'S PROSE AND THE APPEARANCES ARE NOT IN IT.
    /// `snapshot_take` reads `SELECT item_id, body FROM doc`. DELIBERATE, and
    /// stated as a test for the reason 037 states its twin: a writer restoring
    /// last Tuesday\'s draft has not asked to un-say who was in the room.
    #[test]
    fn a_snapshot_restore_rewrites_prose_and_leaves_the_appearances_where_they_are() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the first words"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let made = project
            .store
            .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
            .unwrap();
        let snapshot = project.store.snapshot_create("before").unwrap();

        let rev = project.store.load_doc(&scene.id).unwrap().rev;
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("the second words"),
                base_rev: rev,
                comments: None,
            }],
            1,
        )
        .unwrap();
        project
            .store
            .appearances_set(&scene.id, &[made.id.clone()])
            .unwrap();

        project.store.snapshot_restore(snapshot.id).unwrap();

        assert!(
            project
                .store
                .load_doc(&scene.id)
                .unwrap()
                .body
                .contains("first"),
            "the snapshot did not restore the prose, so this test proves nothing"
        );
        assert_eq!(
            project.store.appearances().unwrap().get(&scene.id),
            Some(&vec![made.id]),
            "a snapshot restore reached an appearance recorded after it was taken"
        );
    }

    #[test]
    fn the_per_item_counts_carry_the_live_scenes_and_not_the_binned_one() {
        // Covers the DELEGATION, which the store's own tests cannot see: an
        // `OpenProject::word_counts` that passed an empty exclusion set instead
        // of `self.excluded` satisfies every test in the store module.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let keep = create_into(&mut project, None, "scene", "Keep").unwrap();
        let drop = create_into(&mut project, None, "scene", "Drop").unwrap();
        flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("four words go here"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: drop.id.clone(),
                    body: body("three more words"),
                    base_rev: drop.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();

        delete_into_bin(&mut project, &drop.id, 1);
        let counts = project.word_counts();

        assert_eq!(counts.get(&keep.id), Some(&4));
        assert!(
            !counts.contains_key(&drop.id),
            "a binned scene is not the manuscript"
        );
        // The identity the page may rely on: this map sums to the bar's figure.
        let summed: u64 = counts.values().sum();
        assert_eq!(summed, project.word_count().words);
    }

    #[test]
    fn deleting_a_chapter_takes_the_scenes_inside_it() {
        // Found by mutation: replacing the refresh with `trashed.insert(id)`
        // survived the whole suite, because every delete tested was a LEAF. A
        // writer deleting a chapter means the chapter and everything in it, and
        // the single-id version would leave those scenes' words in the project
        // total permanently, with the scenes themselves still in the export.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let mut project = opened(&path);

        let chapter = create_into(&mut project, None, "chapter", "Chapter").unwrap();
        let inside = create_into(&mut project, Some(&chapter.id), "scene", "Inside").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: inside.id.clone(),
                body: body("three words inside"),
                base_rev: inside.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 3);

        delete_into_bin(&mut project, &chapter.id, 1);

        assert_eq!(
            project.word_count().words,
            0,
            "the scene inside the deleted chapter still counts"
        );
        let dest = dir.path().join("out.md");
        export_to(
            &path,
            "Book",
            &dest,
            &crate::identity::Vault::default(),
            crate::strings::Strings::english(),
        )
        .unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(!text.contains("three words inside"), "{text}");
        assert!(!text.contains("Inside"), "{text}");
    }

    #[test]
    fn moving_an_item_back_out_of_the_bin_returns_its_words() {
        // The `left` half of the narrowed refresh condition. Nothing in the UI
        // performs this yet -- restore is not in this slice -- but `item_move`
        // accepts it, and a condition that only looked at the DESTINATION would
        // leave a restored scene excluded from the project total forever, with
        // its prose back in the manuscript and its words missing from the count.
        // The narrowing is a latency fix; it must not become a correctness bug
        // the day restore is added.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let scene = create_into(&mut project, None, "scene", "Scene").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 4);

        delete_into_bin(&mut project, &scene.id, 1);
        assert_eq!(project.word_count().words, 0);

        // Back to the root, through the same command path.
        let rev = project
            .store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.id == scene.id)
            .unwrap()
            .rev;
        move_within(&mut project, &scene.id, None, None, rev).unwrap();

        assert_eq!(
            project.word_count().words,
            4,
            "a restored scene's words never came back to the total"
        );
    }

    #[test]
    fn a_reorder_outside_the_bin_leaves_the_excluded_set_alone() {
        // The control for the narrowing. A plain reorder skips the refresh, so
        // this asserts the skip is CORRECT rather than merely cheap: the set
        // still describes the bin afterwards.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let a = create_into(&mut project, None, "scene", "A").unwrap();
        let b = create_into(&mut project, None, "scene", "B").unwrap();
        flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: a.id.clone(),
                    body: body("two words"),
                    base_rev: a.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: b.id.clone(),
                    body: body("three more words"),
                    base_rev: b.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();
        delete_into_bin(&mut project, &b.id, 1);
        assert_eq!(project.word_count().words, 2);
        let before = project.excluded.clone();

        // Move A after nothing at the root: a reorder that touches neither the
        // bin nor anything in it.
        let rev = project
            .store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.id == a.id)
            .unwrap()
            .rev;
        move_within(&mut project, &a.id, None, None, rev).unwrap();

        assert_eq!(
            project.excluded, before,
            "the excluded set drifted on a plain reorder"
        );
        assert_eq!(project.word_count().words, 2);
    }

    #[test]
    fn typing_into_a_deleted_scene_does_not_return_its_words_to_the_total() {
        // THE REASON the exclusion is applied at count time rather than by
        // forgetting the entry on delete. A deleted scene stays open and keeps
        // taking keystrokes -- that is the product decision -- so every flush
        // calls `record`, and an implementation that dropped the entry would let
        // the words climb silently back into the project total one flush later.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        let keep = create_into(&mut project, None, "scene", "Keep").unwrap();
        let drop = create_into(&mut project, None, "scene", "Drop").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: keep.id.clone(),
                body: body("four words go here"),
                base_rev: keep.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();

        delete_into_bin(&mut project, &drop.id, 1);
        assert_eq!(project.word_count().words, 4);

        // The writer, still looking at the deleted scene, keeps typing.
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: drop.id.clone(),
                body: body("many more words typed after the delete"),
                base_rev: drop.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();

        assert_eq!(
            project.word_count().words,
            4,
            "words typed into a deleted scene came back into the total"
        );
    }

    #[test]
    fn a_deleted_scene_leaves_the_export_and_the_search() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let mut project = opened(&path);

        let keep = create_into(&mut project, None, "scene", "Keep").unwrap();
        let drop = create_into(&mut project, None, "scene", "Drop").unwrap();
        flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("kept prose zzkeepnonce"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: drop.id.clone(),
                    body: body("deleted prose zzdropnonce"),
                    base_rev: drop.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();

        // Both reachable before the delete, or the assertions after it would
        // pass against a search and an export that never found either.
        assert_eq!(find_in(&path, "zzdropnonce", 50).unwrap().total, 1);
        let before = dir.path().join("before.md");
        export_to(
            &path,
            "Book",
            &before,
            &crate::identity::Vault::default(),
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert!(std::fs::read_to_string(&before)
            .unwrap()
            .contains("zzdropnonce"));

        delete_into_bin(&mut project, &drop.id, 1);

        assert_eq!(
            find_in(&path, "zzdropnonce", 50).unwrap().total,
            0,
            "search still reaches into the bin"
        );
        assert_eq!(
            find_in(&path, "zzkeepnonce", 50).unwrap().total,
            1,
            "the delete took the rest of the manuscript with it"
        );

        let after = dir.path().join("after.md");
        export_to(
            &path,
            "Book",
            &after,
            &crate::identity::Vault::default(),
            crate::strings::Strings::english(),
        )
        .unwrap();
        let text = std::fs::read_to_string(&after).unwrap();
        assert!(
            !text.contains("zzdropnonce"),
            "the bin reached the manuscript"
        );
        assert!(
            text.contains("zzkeepnonce"),
            "the delete emptied the export"
        );
        assert!(
            !text.contains("Trash"),
            "the bin's own heading reached the manuscript"
        );

        // The prose is NOT destroyed. This is the recovery path until restore
        // exists, and a delete that quietly dropped the body would look
        // identical to this one everywhere above.
        assert!(project
            .store
            .load_doc(&drop.id)
            .unwrap()
            .body
            .contains("zzdropnonce"));
    }

    #[test]
    fn the_incremental_total_equals_a_full_recount() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));

        // A TIMELINE, PRESENT FOR THE WHOLE TEST -- CREATED, NEVER FLUSHED.
        // MAJOR review finding: this guard used to compare the FILTERED
        // index against the store's UNFILTERED full scan, so it was wrong by
        // construction the moment a timeline existed -- `word_count`'s
        // reference scan would have counted its unparseable body as one
        // `skipped` document the index had never claimed to see. Both sides
        // are filtered now (see `word_count`'s own comment).
        //
        // NEVER FLUSHED, deliberately: `OpenProject.words.apply_flush` calls
        // `record` unconditionally by design in this slice (101's own "NOT
        // NOW" -- 102 gives a timeline a flusher and adds the type guard
        // where THAT record happens), so flushing one here would exercise a
        // path this slice does not reach through the page at all and fail
        // against a gap that is deliberately still open. `create_into`
        // already carries the guard that matters for 101: it never records
        // a timeline's starter body at all.
        let bible = create_into(&mut project, None, store::BIBLE_TYPE, "Bible").unwrap();
        create_into(&mut project, Some(&bible.id), store::TIMELINE_TYPE, "Timeline").unwrap();
        assert_index_matches_a_full_recount(&project);

        // Creates and flushes interleaved, which is the shape of a real session:
        // a scene appears, gets typed into, another appears, both get typed into
        // again in one batch.
        let one = create_into(&mut project, None, "scene", "One").unwrap();
        assert_index_matches_a_full_recount(&project);

        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: one.id.clone(),
                body: body("four words go here"),
                base_rev: one.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_index_matches_a_full_recount(&project);

        let two = create_into(&mut project, None, "scene", "Two").unwrap();
        let acks = flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: one.id.clone(),
                    body: body("now it says six words instead"),
                    base_rev: 2,
                    comments: None,
                },
                FlushEntry {
                    item_id: two.id.clone(),
                    body: body("two words"),
                    base_rev: two.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();
        assert_eq!(acks.len(), 2);

        // The absolute figure too, not only the agreement: two implementations
        // that had drifted the same way would agree with each other and be
        // wrong, and 6 + 2 is a number this test can state.
        assert_eq!(
            project.words.count(),
            WordCount {
                words: 8,
                skipped: 0
            }
        );
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn flushing_one_document_twice_does_not_double_its_words() {
        // The defect a naive cache ships: `total += count(body)` on every flush.
        // Typing into one scene flushes it about once a second, so the total
        // would run away within a minute of a real session.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        let scene = create_into(&mut project, None, "scene", "One").unwrap();

        for (rev, text) in [(1, "four words go here"), (2, "four words go there")] {
            flush_into(
                &mut project,
                &[FlushEntry {
                    item_id: scene.id.clone(),
                    body: body(text),
                    base_rev: rev,
                    comments: None,
                }],
                1,
            )
            .unwrap();
        }

        assert_eq!(
            project.words.count(),
            WordCount {
                words: 4,
                skipped: 0
            }
        );
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn a_flush_refused_by_the_generation_guard_leaves_the_index_untouched() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        let scene = create_into(&mut project, None, "scene", "One").unwrap();
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();

        // A flush from a superseded project generation. The store refuses it, so
        // the index must refuse it too: an index that counted it would report a
        // total for prose no manuscript holds.
        let refused = flush_into(
            &mut project,
            &[FlushEntry {
                item_id: scene.id.clone(),
                body: body("a b c d e f g h i j"),
                base_rev: 2,
                comments: None,
            }],
            2,
        );
        assert!(refused.is_err(), "a stale generation must not be accepted");

        assert_eq!(
            project.words.count(),
            WordCount {
                words: 4,
                skipped: 0
            }
        );
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn a_batch_the_store_rolls_back_leaves_the_index_untouched() {
        // Store::flush is one transaction: a conflict on the SECOND entry rolls
        // the first one back too. An index applied entry by entry, or applied
        // before the store answered, would keep a change the file does not have.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        let one = create_into(&mut project, None, "scene", "One").unwrap();
        let two = create_into(&mut project, None, "scene", "Two").unwrap();

        let rejected = flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: one.id.clone(),
                    body: body("four words go here"),
                    base_rev: one.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: two.id.clone(),
                    // Stale: the row is at rev 1, so this conflicts and the whole
                    // batch rolls back, first entry included.
                    body: body("seven eight nine"),
                    base_rev: 99,
                    comments: None,
                },
            ],
            1,
        );
        assert!(rejected.is_err(), "a stale base_rev must conflict");

        assert_eq!(
            project.words.count(),
            WordCount {
                words: 0,
                skipped: 0
            }
        );
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn a_created_scene_is_in_the_index_at_zero_rather_than_missing() {
        // Present-at-zero, not absent. Absent is right only by accident here
        // (nothing minus nothing), and it makes the index describe fewer
        // documents than the store holds.
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        assert_eq!(project.words.len(), 0);

        create_into(&mut project, None, "scene", "One").unwrap();
        assert_eq!(
            project.words.len(),
            1,
            "the new scene's document is missing"
        );
        assert_eq!(
            project.words.count(),
            WordCount {
                words: 0,
                skipped: 0
            }
        );
        assert_index_matches_a_full_recount(&project);

        // A part gets no document row, so it must not get an index entry either.
        create_into(&mut project, None, "part", "Part One").unwrap();
        assert_eq!(project.words.len(), 1, "a part took a document entry");
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn a_corrupt_body_is_skipped_by_both_the_index_and_a_recount() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("counted.db"));
        let good = create_into(&mut project, None, "scene", "Good").unwrap();
        let bad = create_into(&mut project, None, "scene", "Bad").unwrap();

        flush_into(
            &mut project,
            &[
                FlushEntry {
                    item_id: good.id.clone(),
                    body: body("four words go here"),
                    base_rev: good.doc_rev.unwrap(),
                    comments: None,
                },
                FlushEntry {
                    item_id: bad.id.clone(),
                    body: "{not json at all".to_string(),
                    base_rev: bad.doc_rev.unwrap(),
                    comments: None,
                },
            ],
            1,
        )
        .unwrap();

        // Skipped, and SAID to be skipped: the figure is what tells the operator
        // the total is an undercount.
        assert_eq!(
            project.words.count(),
            WordCount {
                words: 4,
                skipped: 1
            }
        );
        assert_index_matches_a_full_recount(&project);

        // And it recovers: a later flush that replaces the unreadable body must
        // clear the skip rather than leave the document permanently uncounted.
        flush_into(
            &mut project,
            &[FlushEntry {
                item_id: bad.id.clone(),
                body: body("two words"),
                base_rev: 2,
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(
            project.words.count(),
            WordCount {
                words: 6,
                skipped: 0
            }
        );
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn the_word_count_scan_runs_with_the_store_mutex_held() {
        // The defect this pinned: the command took the store lock and held it
        // for the whole scan -- every document read, parsed and walked -- while
        // doc_flush needs that same lock. The command no longer scans at all,
        // but the property is now what makes the GUARD possible: the tests above
        // recount a project's file while its OpenProject is alive, and they can
        // only do that because the scan reaches the file on its own connection.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let store = seeded_project(&path);
        let words = store.word_index().unwrap();
        // Built from the walk, exactly as a real open builds it: a helper that
        // hardcoded an empty set would make every test here blind to the bin.
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        let state = StoreState(Mutex::new(Some(OpenProject {
            book_id: super::project_book_id(&store).unwrap(),
            registry_home: None,
            store,
            path: path.clone(),
            name: "counted".to_string(),
            generation: 1,
            analytics: None,
            tracking_on: true,
            words,
            excluded,
        })));

        // Held across the whole scan, exactly as an in-flight doc_flush would.
        let held = locked(&state);

        let (tx, rx) = mpsc::channel();
        let scanned = path.clone();
        let worker = std::thread::spawn(move || {
            let _ = tx.send(word_count_at(&scanned));
        });
        // A bounded failure rather than a hung suite: counting through the open
        // store cannot finish here, and must not.
        let answer = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the scan did not finish while the store mutex was held");

        drop(held);
        worker.join().unwrap();
        // And the figure is real, not an error swallowed into a zero: a scan
        // that could not open the file would satisfy the timing claim alone.
        assert_eq!(answer.unwrap().words, 4);
    }

    #[test]
    fn the_find_scan_runs_off_the_store_mutex() {
        // The same probe as the export's, for the same reason and by the same
        // mechanism: `try_lock` at the instant the scan begins, so widening the
        // guard to span the scan turns this red on one thread with no timing.
        //
        // Copied knowingly from a shape that was WRONG the first time it was
        // written -- it held the lock and then called a function that never
        // touched the mutex, so it could not fail. The fixed shape is what is
        // being copied, and this test was proven the same way the fixed one
        // was: by moving the scan inside the guard and watching it fail.
        //
        // A scan that held the mutex would block every doc_flush for its
        // duration, and the flush path is on the writer's keystroke budget.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let store = seeded_project(&path);
        let words = store.word_index().unwrap();
        // Built from the walk, exactly as a real open builds it: a helper that
        // hardcoded an empty set would make every test here blind to the bin.
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        let state = StoreState(Mutex::new(Some(OpenProject {
            book_id: super::project_book_id(&store).unwrap(),
            registry_home: None,
            store,
            path: path.clone(),
            name: "counted".to_string(),
            generation: 1,
            analytics: None,
            tracking_on: true,
            words,
            excluded,
        })));

        let mut free_at_scan = None;
        let results = find_open_project(&state, "words", find::DEFAULT_LIMIT, |p, q, l| {
            free_at_scan = Some(state.0.try_lock().is_ok());
            find_in(p, q, l)
        })
        .unwrap();

        assert_eq!(
            free_at_scan,
            Some(true),
            "the store mutex was still held when the scan began"
        );
        // And a real scan happened. A probe that never ran leaves the flag
        // None; a scan that found nothing would satisfy the timing claim alone,
        // which is the failure this pairing exists to exclude.
        assert_eq!(results.total, 1);
        assert_eq!(results.results[0].matches, 1);
    }

    #[test]
    fn find_reads_the_file_rather_than_the_open_store() {
        // The scan opens its own read-only connection, which is what lets it run
        // off-mutex at all. The visible consequence is that it sees what has
        // been FLUSHED -- which is why the page drains before it invokes, and
        // why that drain is not an optimisation.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let store = seeded_project(&path);
        let created = store.item_create(None, "scene", "Second").unwrap();

        // Created but never flushed: the row exists, its body does not.
        let before = find_in(&path, "unflushed", find::DEFAULT_LIMIT).unwrap();
        assert_eq!(before.total, 0);

        store
            .flush(&[crate::store::FlushEntry {
                item_id: created.id.clone(),
                body: body("an unflushed sentence"),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();

        let after = find_in(&path, "unflushed", find::DEFAULT_LIMIT).unwrap();
        assert_eq!(after.total, 1);
        assert_eq!(after.results[0].item_id, created.id);
    }

    #[test]
    fn find_counts_every_readable_document_and_reports_the_unreadable() {
        // `skipped` is the only figure saying the answer is an undercount, and
        // a body that is not a document must reach it rather than be counted as
        // an empty one. Same rule the word index already follows.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let store = seeded_project(&path);
        let created = store.item_create(None, "scene", "Broken").unwrap();
        store
            .flush(&[crate::store::FlushEntry {
                item_id: created.id,
                body: r#"{"foo":1}"#.to_string(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();

        let out = find_in(&path, "words", find::DEFAULT_LIMIT).unwrap();
        assert_eq!(out.scanned, 2);
        assert_eq!(out.skipped, 1, "a non-document body must be reported");
        assert_eq!(out.total, 1);
    }

    #[test]
    fn the_page_cannot_ask_for_more_results_than_the_ceiling() {
        // Not a security boundary. It bounds the IPC payload: a page bug asking
        // for every hit at stress would serialize 15,200 snippets across the
        // bridge and freeze the window it was trying to help.
        assert_eq!(
            find::DEFAULT_LIMIT.min(FIND_MAX_LIMIT),
            FIND_MAX_LIMIT,
            "the clamp must not raise a smaller request"
        );
        assert_eq!(usize::MAX.min(FIND_MAX_LIMIT), FIND_MAX_LIMIT);
        assert_eq!(1usize.min(FIND_MAX_LIMIT), 1, "a smaller ask is honoured");
    }

    #[test]
    fn find_on_no_open_project_is_an_error_the_page_can_render() {
        // Every store-touching command goes through open_project for this
        // reason: "nothing is open" must not be a panic behind a live window.
        let state = StoreState(Mutex::new(None));
        let err = find_open_project(&state, "anything", find::DEFAULT_LIMIT, |_, _, _| {
            panic!("the scan must not run when nothing is open");
        })
        .unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn the_injected_preferences_carry_every_recorded_axis() {
        // The page cannot ASK for these: they have to be on the root before the
        // stylesheet is applied, or a writer who chose 23px watches their
        // manuscript reflow on every launch. So this string is the only channel,
        // and each axis is checked separately -- a single "contains mono" would
        // pass on a build that injected the family three times.
        let settings = crate::projects::Settings {
            last_project: None,
            mirrored: Vec::new(),
            mirrored_book_ids: Vec::new(),
            protection_claims: Vec::new(),
            books: Vec::new(),
            book_locations: Vec::new(),
            new_book_dir: None,
            encrypted_backup_dir: None,
            theme: crate::projects::Theme::Dark,
            typography: crate::projects::Typography {
                family: crate::projects::ProseFamily::Mono,
                size: crate::projects::ProseSize::Larger,
                measure: crate::projects::ProseMeasure::Narrow,
            },
            window: crate::projects::WindowSize::default(),
            daily_target: crate::projects::DailyTarget::default(),
            bible_rows: 13,
            writing_modes: crate::projects::WritingModes {
                focus: crate::projects::FocusMode::Paragraph,
                typewriter: crate::projects::TypewriterMode::On,
            },
            zoom: crate::zoom::Zoom::Z150,
            spelling: crate::projects::Spelling::Off,
            time_tracking: crate::projects::TimeTracking::On,
            theme_family: crate::projects::ThemeFamily::Atmospheric,
            locale: crate::projects::LocaleTag::default(),
            mark_cast_names: false,
            start: crate::projects::Start::Blank,
            recent: Vec::new(),
            home_identity: None,
        };
        let js = preferences_js(&settings);
        assert!(js.contains("window.__appZoom='150'"), "{js}");
        assert!(js.contains("window.__appBibleRows=13"), "{js}");
        assert!(js.contains("window.__appStart='blank'"), "{js}");
        assert!(js.contains("window.__appTheme='dark'"), "{js}");
        assert!(js.contains("window.__appProseFamily='mono'"), "{js}");
        assert!(js.contains("window.__appProseSize='larger'"), "{js}");
        assert!(js.contains("window.__appProseMeasure='narrow'"), "{js}");
        // Both writing modes ride the same channel and for the same reason: a
        // focus mode applied after mount is one the writer sees flash off and on
        // at every launch, and typewriter's bottom padding reflows the page.
        assert!(js.contains("window.__appFocusMode='paragraph'"), "{js}");
        assert!(js.contains("window.__appTypewriter='on'"), "{js}");
        // The spelling preference rides the same channel, but NOT because it can
        // flash: the underlines are the web engine's and appear when it decides.
        // It is here because the preferences panel needs its current value to
        // render, which is the same reason __appDailyTarget is.
        assert!(js.contains("window.__appSpelling='off'"), "{js}");
        // The family MUST ride this channel: it repaints every surface in the
        // application, so applied after mount a writer who chose one watches the
        // default flash first at every launch.
        assert!(js.contains("window.__appThemeFamily='atmospheric'"), "{js}");
        // NO QUOTES: a bare JS boolean, not a validated enum spelling, since
        // there is nothing here for a stray value to misspell.
        assert!(js.contains("window.__appMarkCastNames=false"), "{js}");
    }

    #[test]
    fn the_injected_preferences_carry_the_language_the_host_writes_in() {
        // WHERE THE LANGUAGE IS CHOSEN, and it is the same channel as the theme
        // and the typography: the host reads `settings.json` and tells the
        // page. Not the other way round -- an export, a salvage and a validate
        // all run from the command line with no page to ask, so a locale the
        // page owned would be a locale half the application could not see.
        let js = preferences_js(&crate::projects::Settings::default());
        assert!(js.contains("window.__appLocale='en'"), "{js}");
    }

    #[test]
    fn the_injected_preferences_default_to_what_every_build_before_them_rendered() {
        // A page that lost this injection must be the page originally shipped, not an
        // unstyled one. The head script and style.css both restate these; this
        // is the third statement, and the one the other two are checked against.
        let js = preferences_js(&crate::projects::Settings::default());
        assert!(js.contains("window.__appTheme='system'"), "{js}");
        assert!(js.contains("window.__appProseFamily='serif'"), "{js}");
        assert!(js.contains("window.__appProseSize='medium'"), "{js}");
        assert!(js.contains("window.__appProseMeasure='medium'"), "{js}");
        // A writer who has never opened Preferences sees the feature on.
        assert!(js.contains("window.__appMarkCastNames=true"), "{js}");
        // 100 flips the default: a first launch is what this default answers
        // for, and the library screen is now what a first launch shows.
        assert!(js.contains("window.__appStart='home'"), "{js}");
    }

    /// What a launch with no APP_PROJECT and an empty library would open.
    fn default_project_path_from(xdg_data_home: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
        crate::projects::library_dir(&data_home_from(xdg_data_home, home)).join(DEFAULT_PROJECT)
    }

    /// The Windows counterpart. Expectations are built with `join` rather than
    /// written as one literal on purpose: a literal would bake in a separator,
    /// and these tests run on Linux, where `join` writes `/`. The claim being
    /// made is about WHICH variable is honoured and WHAT is appended to it, not
    /// about how a separator renders.
    fn windows_default_project_path_from(
        appdata: Option<&OsStr>,
        userprofile: Option<&OsStr>,
    ) -> PathBuf {
        crate::projects::library_dir(&windows_data_home_from(appdata, userprofile))
            .join(DEFAULT_PROJECT)
    }

    #[test]
    fn a_flush_from_the_open_generation_is_accepted() {
        assert!(accepts_generation(3, 3));
    }

    #[test]
    fn a_flush_from_a_superseded_generation_is_refused() {
        // The hazard: two projects seeded from the same generator share item
        // ids, so a stale flush lands on a real row in the wrong manuscript.
        assert!(!accepts_generation(3, 2));
    }

    #[test]
    fn a_flush_claiming_a_future_generation_is_refused() {
        // Not merely stale, impossible. The page is wrong either way.
        assert!(!accepts_generation(3, 4));
    }

    #[test]
    fn the_last_project_wins_over_a_single_library_file() {
        let only = PathBuf::from("/lib/only.db");
        let last = PathBuf::from("/elsewhere/last.db");
        assert_eq!(
            startup_choice(Some(&last), &[only]),
            Choice::Last(last.clone())
        );
    }

    #[test]
    fn the_only_library_file_wins_when_there_is_no_last_project() {
        let only = PathBuf::from("/lib/only.db");
        assert_eq!(
            startup_choice(None, std::slice::from_ref(&only)),
            Choice::Newest(only)
        );
    }

    #[test]
    fn an_empty_library_falls_back_to_the_default_project() {
        assert_eq!(startup_choice(None, &[]), Choice::Default);
    }

    #[test]
    fn several_library_files_and_no_last_project_take_the_newest() {
        // The alternative is worse than picking: falling back to the default
        // would create a THIRD, blank manuscript for a writer who has two and
        // lost a preferences file, with no sign of the other two until they
        // opened the switcher. list() returns newest first, so the first entry
        // is the most recently modified.
        let files = [
            PathBuf::from("/lib/newest.db"),
            PathBuf::from("/lib/older.db"),
        ];
        assert_eq!(
            startup_choice(None, &files),
            Choice::Newest(PathBuf::from("/lib/newest.db"))
        );
    }

    #[test]
    fn a_book_made_in_a_chosen_folder_is_RECORDED_so_it_can_be_opened_again() {
        // Without the recording the book exists on disk and `may_open` refuses
        // it forever: the writer would create a manuscript and then be told it
        // is not a project.
        let home = tempdir().unwrap();
        let elsewhere = home.path().join("Documents").join("Books");
        let made = create_into_dir(home.path(), &elsewhere, "The Harbour").unwrap();

        let settings = crate::projects::read_settings(home.path());
        assert_eq!(settings.books, vec![made.path.clone()]);
        assert!(may_open(
            &crate::projects::library_dir(home.path()),
            None,
            &crate::projects::known(home.path()),
            &PathBuf::from(&made.path),
        ));
    }

    #[test]
    fn creation_keeps_the_startups_locale_after_settings_change_until_restart() {
        let home = tempdir().unwrap();
        crate::projects::update_settings(home.path(), |settings| {
            settings.locale = crate::projects::LocaleTag::of("de");
        })
        .unwrap();
        let captured = crate::projects::read_settings(home.path()).locale.strings();
        crate::projects::update_settings(home.path(), |settings| {
            settings.locale = crate::projects::LocaleTag::of("en");
        })
        .unwrap();

        let made = super::create_into_dir(
            home.path(),
            &crate::projects::library_dir(home.path()),
            "Deutsch",
            &captured,
        )
        .unwrap();
        let store = crate::store::Store::open_readonly(Path::new(&made.path)).unwrap();
        let titles: Vec<String> = store
            .items()
            .unwrap()
            .into_iter()
            .map(|item| item.title)
            .collect();
        assert_eq!(titles, ["Kapitel 1", "Szene 1"]);
    }

    #[test]
    fn a_book_made_in_the_LIBRARY_is_not_recorded_twice() {
        // The scan already knows it. `known` deduplicates, so this is belt and
        // braces -- and it keeps `books` meaning what its name says.
        let home = tempdir().unwrap();
        let library = crate::projects::library_dir(home.path());
        create_into_dir(home.path(), &library, "In The Library").unwrap();

        assert!(crate::projects::read_settings(home.path()).books.is_empty());
        assert_eq!(crate::projects::known(home.path()).len(), 1);
    }

    #[test]
    fn the_chosen_folder_becomes_the_default_for_the_NEXT_book() {
        // A writer who keeps their books somewhere chooses once.
        let home = tempdir().unwrap();
        let documents = home.path().join("Documents");
        let elsewhere = home.path().join("Books");
        assert_eq!(
            new_book_dir_with(home.path(), Some(documents.clone()), None).unwrap(),
            documents.join("Books"),
        );

        create_into_dir(home.path(), &elsewhere, "First").unwrap();
        assert_eq!(
            new_book_dir_with(home.path(), Some(documents.clone()), None).unwrap(),
            elsewhere,
        );

        // And the plain create follows it, which is the whole point: the second
        // book needs no dialog at all.
        create_into_dir(
            home.path(),
            &new_book_dir_with(home.path(), Some(documents), None).unwrap(),
            "Second",
        )
        .unwrap();
        assert!(elsewhere.join("second.db").exists());
    }

    #[test]
    fn an_existing_destination_records_nothing() {
        // A refusal must not move the default folder or leave a path behind for
        // a book that was never made.
        let home = tempdir().unwrap();
        let documents = home.path().join("Documents");
        let one = home.path().join("one");
        let two = home.path().join("two");
        create_into_dir(home.path(), &one, "Draft").unwrap();
        std::fs::create_dir_all(&two).unwrap();
        let existing = two.join("draft.db");
        drop(store::Store::open(&existing).unwrap());
        let before = std::fs::read(&existing).unwrap();

        let second = create_into_dir(home.path(), &two, "Draft");

        assert!(second.is_err(), "an existing destination must be refused");
        assert_eq!(
            new_book_dir_with(home.path(), Some(documents), None).unwrap(),
            one,
            "the default followed a refusal"
        );
        assert_eq!(crate::projects::read_settings(home.path()).books.len(), 1);
        assert_eq!(std::fs::read(&existing).unwrap(), before);
    }

    #[test]
    fn same_named_books_in_two_folders_are_both_remembered() {
        let home = tempdir().unwrap();
        let documents = home.path().join("Documents");
        let one = home.path().join("one");
        let two = home.path().join("two");
        let first = create_into_dir(home.path(), &one, "Draft").unwrap();
        let second = create_into_dir(home.path(), &two, "Draft").unwrap();
        let known = crate::projects::known(home.path());
        assert!(known.contains(&PathBuf::from(first.path)));
        assert!(known.contains(&PathBuf::from(second.path)));
        assert_eq!(known.len(), 2);
        assert_eq!(
            new_book_dir_with(home.path(), Some(documents), None).unwrap(),
            two,
        );
    }

    #[test]
    fn with_nothing_remembered_the_default_is_visible_not_the_hidden_library() {
        // 159's own claim: a writer who has never chosen a folder gets
        // `<Documents>/Books`, not the hidden library a pre-159 build put
        // them in.
        let home = tempdir().unwrap();
        let documents = home.path().join("Documents");
        assert_eq!(
            new_book_dir_with(home.path(), Some(documents.clone()), None).unwrap(),
            documents.join("Books"),
        );
        assert_ne!(
            new_book_dir_with(home.path(), Some(documents), None).unwrap(),
            crate::projects::library_dir(home.path()),
        );
    }

    #[test]
    fn a_settings_file_holding_the_hidden_library_as_new_book_dir_is_a_legacy_default() {
        // `create_into_dir` writes `new_book_dir` unconditionally, including
        // for a plain create that landed in the hidden library -- so a
        // profile from before this slice can have the library recorded as a
        // "remembered" folder, and reading it back as a choice would strand
        // every such writer on the hidden default forever.
        let home = tempdir().unwrap();
        let documents = home.path().join("Documents");
        let library = crate::projects::library_dir(home.path());
        create_into_dir(home.path(), &library, "In The Library").unwrap();
        assert_eq!(
            crate::projects::read_settings(home.path())
                .new_book_dir
                .as_deref(),
            Some(library.to_string_lossy().as_ref()),
        );

        assert_eq!(
            new_book_dir_with(home.path(), Some(documents.clone()), None).unwrap(),
            documents.join("Books"),
        );
    }

    #[test]
    fn with_no_documents_folder_the_default_falls_back_to_home_books() {
        let home = tempdir().unwrap();
        let fake_home = home.path().join("home-dir");
        assert_eq!(
            new_book_dir_with(home.path(), None, Some(fake_home.clone())).unwrap(),
            fake_home.join("Books"),
        );
    }

    #[test]
    fn with_neither_documents_nor_home_the_command_reports_the_refusal() {
        let home = tempdir().unwrap();
        let error = new_book_dir_with(home.path(), None, None).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn may_open_accepts_a_library_child() {
        let dir = tempdir().unwrap();
        let lib = crate::projects::library_dir(dir.path());
        std::fs::create_dir_all(&lib).unwrap();
        assert!(may_open(&lib, None, &[], &lib.join("a.db")));
    }

    #[test]
    fn may_open_refuses_a_path_outside_the_library() {
        // A page bug must not be able to open an arbitrary file as a manuscript.
        let dir = tempdir().unwrap();
        let lib = crate::projects::library_dir(dir.path());
        std::fs::create_dir_all(&lib).unwrap();
        let outside = dir.path().join("elsewhere.db");
        std::fs::write(&outside, b"x").unwrap();
        // WITH AN EMPTY KNOWN SET. A file the host has never recorded is a
        // file the page may not name, which is the whole property this gate
        // protects.
        assert!(
            !may_open(&lib, None, &[], &outside),
            "{}",
            outside.display()
        );
        // Still refused when an unrelated APP_PROJECT path is in force.
        let explicit = dir.path().join("harness.db");
        assert!(
            !may_open(&lib, Some(&explicit), &[], &outside),
            "{}",
            outside.display()
        );
    }

    #[test]
    fn may_open_accepts_a_book_the_host_RECORDED_outside_the_library() {
        // The host writes `Settings.books` when IT creates a book in
        // a folder the writer chose through an operating-system dialog, so this
        // widens the gate without letting the PAGE widen it.
        let dir = tempdir().unwrap();
        let lib = crate::projects::library_dir(dir.path());
        std::fs::create_dir_all(&lib).unwrap();
        let elsewhere = dir.path().join("books");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let book = elsewhere.join("harbour.db");
        std::fs::write(&book, b"x").unwrap();

        assert!(!may_open(&lib, None, &[], &book), "unknown must be refused");
        assert!(may_open(&lib, None, std::slice::from_ref(&book), &book));
    }

    #[test]
    fn may_open_still_refuses_a_NEIGHBOUR_of_a_known_book() {
        // A known book does not make its FOLDER openable. Without this the
        // gate would degrade from "a file the host knows about" to "anything
        // beside one", which is a directory-prefix rule wearing a list's
        // clothes.
        let dir = tempdir().unwrap();
        let lib = crate::projects::library_dir(dir.path());
        std::fs::create_dir_all(&lib).unwrap();
        let elsewhere = dir.path().join("books");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let known = elsewhere.join("harbour.db");
        let neighbour = elsewhere.join("someone-elses.db");
        std::fs::write(&known, b"x").unwrap();
        std::fs::write(&neighbour, b"x").unwrap();

        assert!(!may_open(
            &lib,
            None,
            std::slice::from_ref(&known),
            &neighbour
        ));
    }

    #[test]
    fn may_open_matches_a_known_book_through_a_DIFFERENT_SPELLING() {
        // Two spellings of one path are one book. A raw string comparison would
        // refuse the writer's own book because the recorded path had a `.` in
        // it, and the failure would read as "this is not a project".
        let dir = tempdir().unwrap();
        let lib = crate::projects::library_dir(dir.path());
        std::fs::create_dir_all(&lib).unwrap();
        let elsewhere = dir.path().join("books");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let book = elsewhere.join("harbour.db");
        std::fs::write(&book, b"x").unwrap();
        let spelled = dir.path().join("books").join(".").join("harbour.db");

        assert!(may_open(&lib, None, std::slice::from_ref(&book), &spelled));
    }

    #[test]
    fn may_open_accepts_the_app_project_path_this_process_started_with() {
        // The harness stages projects under /tmp and must be able to reopen the
        // file it seeded.
        let dir = tempdir().unwrap();
        let lib = crate::projects::library_dir(dir.path());
        let explicit = Path::new("/tmp/staged/project.db");
        assert!(may_open(&lib, Some(explicit), &[], explicit));
    }

    #[test]
    fn prefers_an_absolute_xdg_data_home() {
        let got =
            default_project_path_from(Some(OsStr::new("/x/data")), Some(OsStr::new("/home/u")));
        assert_eq!(
            got,
            PathBuf::from("/x/data/garret/projects/default.db")
        );
    }

    #[test]
    fn falls_back_to_home_when_xdg_is_unset() {
        let got = default_project_path_from(None, Some(OsStr::new("/home/u")));
        assert_eq!(
            got,
            PathBuf::from("/home/u/.local/share/garret/projects/default.db")
        );
    }

    #[test]
    fn ignores_a_relative_xdg_data_home() {
        // The XDG basedir spec says a relative XDG_DATA_HOME is invalid and must
        // be ignored. Honouring one would put the project somewhere that depends
        // on the process's working directory.
        let got = default_project_path_from(
            Some(OsStr::new("relative/data")),
            Some(OsStr::new("/home/u")),
        );
        assert_eq!(
            got,
            PathBuf::from("/home/u/.local/share/garret/projects/default.db")
        );
    }

    #[test]
    fn falls_back_to_the_working_directory_when_nothing_is_set() {
        let got = default_project_path_from(None, None);
        assert_eq!(
            got,
            PathBuf::from("./.local/share/garret/projects/default.db")
        );
    }

    #[test]
    fn a_failed_startup_preserves_the_error_and_gives_conditional_runtime_advice() {
        // The whole point is a channel that survives when stderr does not, so
        // the assertion is on the FILE, not on what was printed.
        let dir = tempdir().unwrap();
        report_startup_failure(dir.path(), "WebView2Error: not installed");
        let body =
            std::fs::read_to_string(crate::projects::startup_error_path(dir.path())).unwrap();
        // The advice, so a writer knows what to do...
        assert!(body.contains("WebView2"), "no advice in: {body}");
        assert!(
            body.contains("developer.microsoft.com"),
            "no link in: {body}"
        );
        // ...and the underlying error, so a developer can diagnose a cause that
        // is NOT the likely one. Reporting only the guess would make every
        // other startup failure look like a missing runtime.
        assert!(
            body.contains("WebView2Error: not installed"),
            "no cause in: {body}"
        );
    }

    #[test]
    fn startup_report_uses_german_settings_without_changing_diagnostic_evidence() {
        let dir = tempdir().unwrap();
        projects::update_settings(dir.path(), |settings| settings.locale = crate::projects::LocaleTag::of("de".into())).unwrap();
        report_startup_failure(dir.path(), "original technical diagnostic");
        let report = std::fs::read_to_string(projects::startup_error_path(dir.path())).unwrap();
        assert!(report.contains("Die Anwendung konnte ihr Fenster nicht öffnen."));
        assert!(report.contains("Technische Details:"));
        assert!(report.contains("original technical diagnostic"));
        assert!(!report.contains("almost always"));
    }

    #[test]
    fn the_startup_report_creates_its_directory() {
        // On a first run that fails before anything else has been written,
        // <data_home>/cc.local.app does not exist yet. Without the create_dir_all
        // the write silently fails and the writer is back to a double-click that
        // does nothing -- which is the entire defect this exists to remove.
        let dir = tempdir().unwrap();
        let nested = dir.path().join("never").join("created");
        report_startup_failure(&nested, "boom");
        assert!(crate::projects::startup_error_path(&nested).exists());
    }

    #[test]
    fn windows_prefers_appdata() {
        let got = windows_default_project_path_from(
            Some(OsStr::new(r"C:\Users\u\AppData\Roaming")),
            Some(OsStr::new(r"C:\Users\u")),
        );
        assert_eq!(
            got,
            PathBuf::from(r"C:\Users\u\AppData\Roaming")
                .join("garret")
                .join("projects")
                .join(DEFAULT_PROJECT)
        );
    }

    #[test]
    fn windows_falls_back_to_the_user_profile_when_appdata_is_unset() {
        let got = windows_default_project_path_from(None, Some(OsStr::new(r"C:\Users\u")));
        assert_eq!(
            got,
            PathBuf::from(r"C:\Users\u")
                .join("AppData")
                .join("Roaming")
                .join("garret")
                .join("projects")
                .join(DEFAULT_PROJECT)
        );
    }

    #[test]
    fn windows_treats_an_empty_variable_as_unset() {
        // An empty APPDATA is not a request to write to the current directory.
        // Without this, PathBuf::from("") is a non-None value that wins the
        // fallback chain and puts the library under the working directory --
        // the exact defect this resolver exists to remove.
        let got = windows_default_project_path_from(
            Some(OsStr::new("")),
            Some(OsStr::new(r"C:\Users\u")),
        );
        assert_eq!(
            got,
            PathBuf::from(r"C:\Users\u")
                .join("AppData")
                .join("Roaming")
                .join("garret")
                .join("projects")
                .join(DEFAULT_PROJECT)
        );
    }

    #[test]
    fn windows_honours_an_appdata_that_linux_would_call_relative() {
        // The load-bearing test. `Path::is_absolute` is FALSE for a drive-letter
        // path when this runs on Linux, so an is_absolute filter copied from the
        // XDG resolver would discard %APPDATA% and silently send the library to
        // the user profile instead. This test fails the moment such a filter is
        // added; the assertion above cannot see it, because both branches would
        // still produce a path under C:\Users\u.
        assert!(!Path::new(r"C:\Users\u\AppData\Roaming").is_absolute());
        let got = windows_data_home_from(
            Some(OsStr::new(r"C:\Users\u\AppData\Roaming")),
            Some(OsStr::new(r"C:\Users\u")),
        );
        assert_eq!(got, PathBuf::from(r"C:\Users\u\AppData\Roaming"));
    }

    #[test]
    fn js_string_escapes_a_value_that_would_close_the_literal() {
        // Before this, APP_SEED and friends were interpolated raw inside single
        // quotes, so a value like this closed the literal and everything after
        // it ran as JavaScript in the page holding the manuscript.
        let got = js_string("x';window.evil=1;//");
        // The quote survives, but escaped, so it no longer terminates the
        // literal. Asserting the exact rendering is the point: a check for
        // "contains no quote" would pass on an escape that dropped the
        // character entirely and silently corrupted the value.
        assert_eq!(got, "'x\\';window.evil=1;//'");
    }

    #[test]
    fn js_string_escapes_backslashes_before_quotes() {
        // A lone backslash-escape of the quote would itself be escaped away if
        // backslashes were not handled first.
        assert_eq!(js_string("a\\'b"), "'a\\\\\\'b'");
    }

    #[test]
    fn js_string_escapes_line_terminators() {
        assert_eq!(
            js_string("a\nb\r\u{2028}\u{2029}"),
            "'a\\nb\\r\\u2028\\u2029'"
        );
    }

    /// A directory holding an index.html, so it counts as an asset root.
    fn built_dist(at: PathBuf) -> PathBuf {
        std::fs::create_dir_all(&at).unwrap();
        std::fs::write(at.join("index.html"), "<!doctype html>").unwrap();
        at
    }

    /// The path a `cargo build --release` binary sits at, inside `root`.
    fn release_exe(root: &Path) -> PathBuf {
        root.join("app/shell-tauri/src-tauri/target/release/garret")
    }

    #[test]
    fn page_images_are_served_as_png() {
        assert_eq!(mime_for(Path::new("dist/garret-favicon.png")), "image/png");
    }

    fn configured_appdist_csp() -> tauri::utils::config::Csp {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        serde_json::from_value(config["app"]["security"]["csp"].clone()).unwrap()
    }

    fn appdist_csp_directives(
        response: &tauri::http::Response<Vec<u8>>,
    ) -> std::collections::HashMap<String, tauri::utils::config::CspDirectiveSources> {
        tauri::utils::config::Csp::Policy(
            response.headers()["Content-Security-Policy"].to_str().unwrap().to_owned(),
        ).into()
    }

    #[test]
    fn appdist_csp_html_preserves_config_and_adds_only_trusted_theme_hash() {
        use sha2::{Digest, Sha256};
        let dir = tempdir().unwrap();
        let root = built_dist(dir.path().join("dist"));
        std::fs::write(root.join("index.html"), super::APPDIST_INDEX).unwrap();
        let configured = configured_appdist_csp();
        let response = super::appdist_response(&AssetRoot::Found(root), "/", Some(&configured));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Type"], "text/html");
        assert_eq!(response.body(), super::APPDIST_INDEX.as_bytes());
        let html = std::str::from_utf8(response.body()).unwrap();
        let theme = html.split_once("<script>").unwrap().1.split_once("</script>").unwrap().0;
        let trusted_hash = format!("'sha256-{}'", crate::pictures::base64(&Sha256::digest(theme.as_bytes())));
        assert_eq!(super::appdist_theme_hash(), trusted_hash);
        let mut expected: std::collections::HashMap<_, _> = configured.into();
        expected.get_mut("script-src").unwrap().push(super::appdist_theme_hash());
        let actual = appdist_csp_directives(&response);
        assert_eq!(actual, expected);
        let sources: Vec<String> = actual["script-src"].clone().into();
        assert_eq!(sources.iter().filter(|source| source.starts_with("'sha256-")).count(), 1);
        assert!(!sources.iter().any(|source| source == "'unsafe-inline'"));
        let connect: Vec<String> = actual["connect-src"].clone().into();
        assert!(connect.iter().any(|source| source == "ipc:"));
        assert!(connect.iter().any(|source| source == "http://ipc.localhost"));
    }

    #[test]
    fn appdist_csp_replaced_html_cannot_authorize_changed_or_injected_scripts() {
        use sha2::{Digest, Sha256};
        let dir = tempdir().unwrap();
        let root = built_dist(dir.path().join("dist"));
        let assets = AssetRoot::Found(root.clone());
        let configured = configured_appdist_csp();
        std::fs::write(root.join("index.html"), super::APPDIST_INDEX).unwrap();
        let original = super::appdist_response(&assets, "/index.html", Some(&configured));
        let script = super::APPDIST_INDEX.split_once("<script>").unwrap().1
            .split_once("</script>").unwrap().0;
        let altered = script.replace("var t = window.__appTheme;", "window.injected = true;");
        let injected = "window.additionalScript = true;";
        let document = super::APPDIST_INDEX.replace(script, &altered)
            .replace("</head>", &format!("<script>{injected}</script></head>"));
        std::fs::write(root.join("index.html"), &document).unwrap();
        let response = super::appdist_response(&assets, "/index.html", Some(&configured));
        assert_eq!(response.body(), document.as_bytes());
        assert_eq!(appdist_csp_directives(&response), appdist_csp_directives(&original));
        let sources: Vec<String> = appdist_csp_directives(&response)["script-src"].clone().into();
        assert!(sources.contains(&super::appdist_theme_hash()));
        for unauthorized in [altered.as_str(), injected] {
            let hash = format!("'sha256-{}'", crate::pictures::base64(&Sha256::digest(unauthorized.as_bytes())));
            assert!(!sources.contains(&hash));
        }
    }

    #[test]
    fn appdist_csp_diagnosis_and_failures_remain_protected() {
        let configured = configured_appdist_csp();
        let missing = AssetRoot::Missing(vec![PathBuf::from("missing<&>")]);
        let response = super::appdist_response(&missing, "/", Some(&configured));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Type"], "text/html");
        assert!(String::from_utf8(response.body().clone()).unwrap().contains("missing&lt;&amp;&gt;"));
        assert!(appdist_csp_directives(&response).contains_key("script-src"));
        for configured in [
            None,
            Some(tauri::utils::config::Csp::Policy("default-src 'self'; script-src 'self'\ninvalid".into())),
            Some(tauri::utils::config::Csp::Policy("default-src 'self'; script-src 'unsafe-inline'".into())),
        ] {
            let response = super::appdist_response(&missing, "/", configured.as_ref());
            assert_eq!(response.status(), 500);
            assert!(response.body().is_empty());
            assert!(!response.headers().contains_key("Content-Type"));
            assert_eq!(response.headers()["Content-Security-Policy"], super::APPDIST_DENY_CSP);
        }
        let response = super::appdist_response(&missing, "/missing.js", None);
        assert_eq!(response.status(), 404);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()["Content-Security-Policy"], super::APPDIST_DENY_CSP);
    }

    #[test]
    fn appdist_csp_assets_keep_mime_bytes_and_path_refusals() {
        let dir = tempdir().unwrap();
        let root = built_dist(dir.path().join("dist"));
        std::fs::write(root.join("page.js"), b"window.external = true;").unwrap();
        std::fs::write(dir.path().join("outside.html"), "outside").unwrap();
        let assets = AssetRoot::Found(root);
        let configured = configured_appdist_csp();
        let response = super::appdist_response(&assets, "/page.js", Some(&configured));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Type"], "text/javascript");
        assert_eq!(response.body(), b"window.external = true;");
        for path in ["/absent.js", "/../outside.html", "/C:/outside.html"] {
            let response = super::appdist_response(&assets, path, Some(&configured));
            assert_eq!(response.status(), 404);
            assert!(response.body().is_empty());
            assert!(!response.headers().contains_key("Content-Type"));
            assert!(response.headers().contains_key("Content-Security-Policy"));
        }
    }

    #[test]
    fn appdist_asset_paths_accept_index_nested_files_and_root_search_paths() {
        let dir = tempdir().unwrap();
        let root = built_dist(dir.path().join("dist"));
        std::fs::create_dir(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/page.js"), "page").unwrap();
        for name in ["index.html", "assets/page.js"] {
            assert_eq!(
                super::appdist_asset_path(&root.join("../dist"), name),
                Some(root.join(name).canonicalize().unwrap())
            );
        }
        assert_eq!(super::appdist_asset_path(&root, "absent.js"), None);
        assert_eq!(super::appdist_asset_path(&root, "assets"), None);
    }

    #[test]
    fn appdist_asset_paths_refuse_traversal_roots_and_platform_prefixes() {
        let dir = tempdir().unwrap();
        let root = built_dist(dir.path().join("dist"));
        std::fs::write(dir.path().join("outside.js"), "outside").unwrap();
        std::fs::create_dir(root.join("assets")).unwrap();
        let refused = [
            "", "../outside.js", "assets/../../outside.js", "/index.html",
            "//index.html", "C:/index.html", "C:index.html", "index.html:stream",
            "..\\outside.js", "assets\\..\\index.html", "\\\\server\\share\\index.html",
        ];
        #[cfg(unix)]
        for name in refused.iter().filter(|name| name.contains(':') || name.contains('\\')) {
            let file = root.join(name);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "platform-sensitive name").unwrap();
        }
        for name in refused {
            assert_eq!(super::appdist_asset_path(&root, name), None, "{name:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn appdist_asset_paths_refuse_symlinks_that_escape_the_root() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let root = built_dist(dir.path().join("dist"));
        let sibling = built_dist(dir.path().join("dist-sibling"));
        symlink(sibling.join("index.html"), root.join("outside.html")).unwrap();
        symlink(&sibling, root.join("outside")).unwrap();
        symlink(root.join("index.html"), root.join("inside.html")).unwrap();
        assert_eq!(super::appdist_asset_path(&root, "outside.html"), None);
        assert_eq!(super::appdist_asset_path(&root, "outside/index.html"), None);
        assert_eq!(
            super::appdist_asset_path(&root, "inside.html"),
            Some(root.join("index.html").canonicalize().unwrap())
        );
    }

    #[test]
    fn app_dist_wins_over_both_fallbacks() {
        let dir = tempdir().unwrap();
        let exe = release_exe(dir.path());
        let staged = built_dist(dir.path().join("staged"));
        built_dist(exe.parent().unwrap().join("dist"));
        built_dist(dir.path().join("app/ui/dist"));

        // The harness stages a per-run copy and points APP_DIST at it. If a
        // fallback could win, a run would silently measure whichever build
        // happened to be lying beside the binary.
        assert_eq!(
            resolve_asset_root(Some(&staged), Some(&exe)),
            AssetRoot::Found(staged)
        );
    }

    #[test]
    fn an_app_dist_without_an_index_does_not_fall_through() {
        let dir = tempdir().unwrap();
        let exe = release_exe(dir.path());
        let empty = dir.path().join("staged");
        std::fs::create_dir_all(&empty).unwrap();
        built_dist(dir.path().join("app/ui/dist"));

        // An explicit APP_DIST that is not a build is a staging bug. Falling
        // through to the repo's own dist would answer with a DIFFERENT build
        // than the one the operator named, which is the failure this project
        // has already paid for twice with a stale app/ui/dist.
        assert_eq!(
            resolve_asset_root(Some(&empty), Some(&exe)),
            AssetRoot::Missing(vec![empty])
        );
    }

    #[test]
    fn falls_back_to_the_dist_beside_the_executable() {
        let dir = tempdir().unwrap();
        let exe = release_exe(dir.path());
        let beside = built_dist(exe.parent().unwrap().join("dist"));
        built_dist(dir.path().join("app/ui/dist"));

        assert_eq!(
            resolve_asset_root(None, Some(&exe)),
            AssetRoot::Found(beside)
        );
    }

    #[test]
    fn the_page_is_found_in_macos_bundle_resources() {
        let dir = tempdir().unwrap();
        let exe = dir.path().join("garret.app/Contents/MacOS/garret");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let resources = built_dist(dir.path().join("garret.app/Contents/Resources/dist"));
        match resolve_asset_root(None, Some(&exe)) {
            AssetRoot::Found(found) => assert_eq!(found.canonicalize().unwrap(), resources.canonicalize().unwrap()),
            other => panic!("expected bundle resources, got {other:?}"),
        }
        let override_dir = built_dist(dir.path().join("staged"));
        assert_eq!(resolve_asset_root(Some(&override_dir), Some(&exe)), AssetRoot::Found(override_dir));
    }

    #[test]
    fn falls_back_to_the_repo_layout_from_the_executable() {
        let dir = tempdir().unwrap();
        let exe = release_exe(dir.path());
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let ui = built_dist(dir.path().join("app/ui/dist"));

        // Four levels up from target/release reaches app/: release -> target ->
        // src-tauri -> shell-tauri -> app. The design document says three, which
        // lands in app/shell-tauri and finds nothing.
        match resolve_asset_root(None, Some(&exe)) {
            AssetRoot::Found(p) => {
                assert_eq!(p.canonicalize().unwrap(), ui.canonicalize().unwrap())
            }
            other => panic!("expected the repo layout to resolve, got {other:?}"),
        }
    }

    #[test]
    fn skips_a_candidate_directory_that_holds_no_index() {
        let dir = tempdir().unwrap();
        let exe = release_exe(dir.path());
        // Exists, and is empty - a `cargo build` on a tree whose UI has never
        // been built, or a dist wiped between builds.
        std::fs::create_dir_all(exe.parent().unwrap().join("dist")).unwrap();
        let ui = built_dist(dir.path().join("app/ui/dist"));

        match resolve_asset_root(None, Some(&exe)) {
            AssetRoot::Found(p) => {
                assert_eq!(p.canonicalize().unwrap(), ui.canonicalize().unwrap())
            }
            other => panic!("expected the empty directory to be skipped, got {other:?}"),
        }
    }

    #[test]
    fn reports_every_path_it_tried_when_nothing_resolves() {
        let dir = tempdir().unwrap();
        let exe = release_exe(dir.path());

        let tried = match resolve_asset_root(None, Some(&exe)) {
            AssetRoot::Missing(paths) => paths,
            other => panic!("expected no asset root, got {other:?}"),
        };
        assert_eq!(tried.len(), 2, "both fallbacks must be named: {tried:?}");
        assert_eq!(tried[0], exe.parent().unwrap().join("dist"));
        assert!(
            tried[1].ends_with("ui/dist"),
            "the repo-layout candidate must be named: {tried:?}"
        );
    }

    #[test]
    fn resolves_nothing_when_the_executable_path_is_unknown() {
        // std::env::current_exe can fail. Without it there is no candidate at
        // all, and the window must say so rather than serve a blank page.
        assert_eq!(
            resolve_asset_root(None, None),
            AssetRoot::Missing(Vec::new())
        );
    }

    #[test]
    fn the_missing_assets_page_names_every_path_and_escapes_them() {
        let page = missing_assets_page(&[PathBuf::from("/a/<b>&c/dist")]);
        assert!(page.contains("/a/&lt;b&gt;&amp;c/dist"), "{page}");
        assert!(
            !page.contains("<b>"),
            "an unescaped path closes the markup: {page}"
        );
    }

    #[test]
    fn the_missing_assets_page_says_so_when_there_were_no_candidates() {
        let page = missing_assets_page(&[]);
        assert!(page.contains("no candidate"), "{page}");
    }

    /// A library and a drop directory holding one file.
    fn import_fixture(source: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempdir().expect("a temp dir");
        let library = dir.path().join("projects");
        let drop_dir = dir.path().join("imports");
        std::fs::create_dir_all(&library).expect("a library");
        std::fs::create_dir_all(&drop_dir).expect("a drop directory");
        std::fs::write(drop_dir.join("book.md"), source).expect("a source file");
        (dir, library, drop_dir)
    }

    #[test]
    fn both_import_routes_disclose_derived_contents_without_modifying_the_source() {
        let source = "# Book\n\n## My contents\n\n- Chapter\n\n## Chapter\n\nWords remain.\n";
        for picked in [false, true] {
            let (dir, library, drop_dir) = import_fixture(source);
            let path = drop_dir.join("book.md");
            let outcome = if picked {
                import_path(dir.path(), &library, &path)
            } else {
                import_named(dir.path(), &library, &drop_dir, "book.md")
            }.unwrap();
            assert_eq!(outcome.derived_contents.as_deref(), Some("My contents"));
            assert_eq!(outcome.losses, crate::docx_import::Losses::default());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
            assert_eq!(serde_json::to_value(&outcome).unwrap()["derived_contents"], "My contents");
        }
    }

    #[test]
    fn the_starter_project_is_named() {
        // Until this slice a first launch met a book called `default` -- the
        // window title, the project bar and the project list all said it,
        // because the file was created nameless and `summarize` falls back to
        // the file stem.
        let dir = tempdir().expect("a temp dir");
        let path = dir.path().join("default.db");
        let store = crate::store::Store::open(&path).expect("a store");
        name_if_unnamed(&store);
        assert_eq!(
            store.get_meta(crate::projects::NAME_KEY).expect("a read"),
            Some(STARTER_NAME.to_string())
        );
    }

    #[test]
    fn the_starter_name_is_not_the_file_stem() {
        // The whole point. A test asserting only that SOME name was written
        // passes for one that writes the stem back, which is the state this
        // fixes.
        assert_ne!(STARTER_NAME, "default");
    }

    #[test]
    fn a_project_that_already_has_a_name_keeps_it() {
        // The condition that makes this safe. A writer who renames the starter
        // and whose library then briefly looks empty -- an unreadable file is
        // filtered out of the launch list -- must not have their title
        // overwritten by a launch.
        let dir = tempdir().expect("a temp dir");
        let store = crate::store::Store::open(&dir.path().join("default.db")).expect("a store");
        store
            .set_meta(crate::projects::NAME_KEY, "The Harbour")
            .expect("a name");
        name_if_unnamed(&store);
        assert_eq!(
            store.get_meta(crate::projects::NAME_KEY).expect("a read"),
            Some("The Harbour".to_string())
        );
    }

    #[test]
    fn a_rename_records_the_typed_name() {
        let dir = tempdir().expect("a temp dir");
        let path = dir.path().join("default.db");
        let store = crate::store::Store::open(&path).expect("a store");
        assert_eq!(
            rename_open(&store, "The Harbour"),
            Ok("The Harbour".to_string())
        );
        assert_eq!(
            store.get_meta(crate::projects::NAME_KEY).expect("a read"),
            Some("The Harbour".to_string())
        );
    }

    #[test]
    fn a_rename_trims_what_it_stores() {
        let dir = tempdir().expect("a temp dir");
        let store = crate::store::Store::open(&dir.path().join("default.db")).expect("a store");
        assert_eq!(
            rename_open(&store, "  The Harbour  "),
            Ok("The Harbour".to_string())
        );
    }

    #[test]
    fn a_blank_rename_is_refused_and_stores_nothing() {
        // The refusal has to be checked against the STORE as well as the return
        // value: a rule that reports an error after writing has not refused
        // anything, which is the recorded shape of every path refusal here.
        let dir = tempdir().expect("a temp dir");
        let path = dir.path().join("default.db");
        let store = crate::store::Store::open(&path).expect("a store");
        store
            .set_meta(crate::projects::NAME_KEY, "The Harbour")
            .expect("a name");
        assert!(rename_open(&store, "   ").is_err());
        assert_eq!(
            store.get_meta(crate::projects::NAME_KEY).expect("a read"),
            Some("The Harbour".to_string())
        );
    }

    #[test]
    fn a_rename_accepts_a_title_no_filename_could_carry() {
        // NOT `projects::create_in`'s rule, and this is the reason. `slugify`
        // answers None for Hebrew and Arabic titles (which is why the mirror
        // has a segment rule of its own), and a rename
        // CREATES NO FILE -- so sharing that rule would refuse a legitimate book
        // title for an operation that has no filename to protect.
        let dir = tempdir().expect("a temp dir");
        let store = crate::store::Store::open(&dir.path().join("default.db")).expect("a store");
        assert_eq!(
            crate::projects::slugify("\u{5e1}\u{5e4}\u{5e8}"),
            None,
            "the premise of this test"
        );
        assert_eq!(
            rename_open(&store, "\u{5e1}\u{5e4}\u{5e8}"),
            Ok("\u{5e1}\u{5e4}\u{5e8}".to_string())
        );
    }

    #[test]
    fn the_import_report_names_the_directory_it_read() {
        // The whole point of the report shape. Until this slice the panel said
        // "Drop a .md file in the import folder." and named no folder, while the
        // archive and mirror sections beside it both named theirs -- and the
        // code comment above that string CLAIMED it named the directory.
        let (_dir, _library, drop_dir) = import_fixture("# Book\n");
        let report = import_report(&drop_dir);
        assert_eq!(report.dir, drop_dir.display().to_string());
    }

    #[test]
    fn the_import_report_carries_the_files() {
        let (_dir, _library, drop_dir) = import_fixture("# Book\n");
        std::fs::write(drop_dir.join("another.md"), "# Another\n").expect("a second file");
        let report = import_report(&drop_dir);
        assert_eq!(
            report.files,
            vec!["another.md".to_string(), "book.md".to_string()]
        );
    }

    #[test]
    fn a_directory_that_does_not_exist_is_still_named() {
        // The state a first run is actually in: nothing has created the drop
        // folder yet. "Nothing to import" is useless there and the PATH is the
        // only actionable thing the panel can say, so a report that dropped the
        // name on an unreadable directory would fail exactly the writer this
        // string exists for.
        let dir = tempdir().expect("a temp dir");
        let missing = dir.path().join("no-such-imports");
        let report = import_report(&missing);
        assert_eq!(report.dir, missing.display().to_string());
        assert!(report.files.is_empty(), "{:?}", report.files);
    }

    #[test]
    fn an_import_into_the_visible_default_is_registered_and_known() {
        // 159: an import lands where a new book lands, and a book outside the
        // hidden library is only findable through the registration.
        let (dir, _library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        let dest = new_book_dir_with(dir.path(), Some(dir.path().join("Documents")), None).unwrap();
        let summary = import_named(dir.path(), &dest, &drop_dir, "book.md").expect("the import to land").summary;
        assert!(Path::new(&summary.path).starts_with(&dest), "{}", summary.path);
        assert!(crate::projects::known(dir.path()).contains(&PathBuf::from(&summary.path)));
    }

    #[test]
    fn an_import_creates_a_project_holding_the_files_prose() {
        let (dir, library, drop_dir) =
            import_fixture("# The Harbour\n\n## One\n\nShe went down.\n");
        let summary = import_named(dir.path(), &library, &drop_dir, "book.md").expect("the import to land").summary;
        assert_eq!(summary.name, "The Harbour");

        let store = crate::store::Store::open_readonly(Path::new(&summary.path))
            .expect("the imported project to open");
        let items = store.items().expect("a walk");
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].title, "One");
        let doc = store.load_doc(&items[0].id).expect("the scene's document");
        assert!(doc.body.contains("She went down."), "{}", doc.body);
    }

    #[test]
    fn an_imported_project_has_no_starter_scene() {
        // `projects::create_in` writes one. A manuscript that arrived with its own
        // scenes must not also carry an empty one nobody wrote, which is why
        // `create_imported` exists rather than create-then-fill.
        let (dir, library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        let summary = import_named(dir.path(), &library, &drop_dir, "book.md").expect("the import to land").summary;
        let store = crate::store::Store::open_readonly(Path::new(&summary.path)).expect("open");
        let items = store.items().expect("a walk");
        assert_eq!(items.len(), 1, "{items:?}");
    }

    #[test]
    fn the_stores_walk_comes_back_in_the_files_order_and_shape() {
        // The load-bearing test for `import_tree`'s positions. Sibling ordinals
        // are per PARENT GROUP; a global index over all rows looks identical on
        // a flat file and interleaves the moment two branches exist, which is
        // exactly the fixture-generator trap this repo already recorded once.
        let (dir, library, drop_dir) = import_fixture(
            "# Book\n\n## Part One\n\n### Ch A\n\na\n\n### Ch B\n\nb\n\n## Part Two\n\n### Ch C\n\nc\n",
        );
        let summary = import_named(dir.path(), &library, &drop_dir, "book.md").expect("the import to land").summary;
        let store = crate::store::Store::open_readonly(Path::new(&summary.path)).expect("open");
        let walk: Vec<(String, i64)> = store
            .items()
            .expect("a walk")
            .into_iter()
            .map(|i| (i.title, i.depth))
            .collect();
        assert_eq!(
            walk,
            vec![
                ("Part One".to_string(), 0),
                ("Ch A".to_string(), 1),
                ("Ch B".to_string(), 1),
                ("Part Two".to_string(), 0),
                ("Ch C".to_string(), 1),
            ]
        );
    }

    #[test]
    fn a_row_naming_a_parent_that_is_not_yet_written_is_refused() {
        // The parser guarantees a backward reference. The store is what that
        // guarantee is worth nothing without: a forward index would silently
        // read some other item's id, or panic on an empty vector.
        let dir = tempdir().expect("a temp dir");
        let path = dir.path().join("p.db");
        let store = crate::store::Store::open(&path).expect("a store");
        let err = store
            .import_tree(&[(Some(1), "scene", "a", None), (None, "part", "b", None)])
            .unwrap_err();
        assert!(format!("{err}").contains("names parent"), "{err}");
        assert!(
            store.items().expect("a walk").is_empty(),
            "the refused import must roll back rather than leave row 0 behind"
        );
    }

    #[test]
    fn a_body_on_something_that_is_not_a_scene_is_refused() {
        // The schema gives a `doc` row to scenes and to nothing else, so any
        // other pairing is a body with nowhere to live. Refused rather than
        // silently dropped: silently dropping it loses the writer's prose.
        let dir = tempdir().expect("a temp dir");
        let store = crate::store::Store::open(&dir.path().join("p.db")).expect("a store");
        let err = store
            .import_tree(&[(None, "chapter", "a", Some("{}"))])
            .unwrap_err();
        assert!(format!("{err}").contains("cannot carry a body"), "{err}");
    }

    #[test]
    fn a_name_that_is_not_a_bare_markdown_filename_is_refused() {
        // The whole security position of this command. Refused on the NAME,
        // before any filesystem call, so there is nothing for a race to
        // invalidate.
        let (dir, library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        for name in [
            "../book.md",
            "sub/book.md",
            "/etc/passwd",
            "book.txt",
            ".hidden.md",
            "",
        ] {
            let err = import_named(dir.path(), &library, &drop_dir, name).unwrap_err();
            assert!(
                err.contains("import folder"),
                "{name:?} was refused for the wrong reason: {err}"
            );
        }
    }

    #[test]
    fn a_traversing_name_cannot_reach_a_file_that_exists() {
        // The refusals above would also be produced by the file simply not
        // being there, which would make that test pass against no check at all.
        // This one puts a real, readable, correctly-named Markdown file exactly
        // where the traversal points.
        let (dir, library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        std::fs::write(dir.path().join("outside.md"), "# Outside\n\n## X\n\np\n")
            .expect("a file outside the drop directory");
        assert!(dir.path().join("outside.md").exists());
        let err = import_named(dir.path(), &library, &drop_dir, "../outside.md").unwrap_err();
        assert!(err.contains("import folder"), "{err}");
    }

    #[test]
    fn the_dialog_route_imports_a_file_from_outside_the_drop_directory() {
        // The whole point of the dialog: a path the WRITER chose, which
        // `import_named` refuses by name and must go on refusing. The file sits
        // exactly where the traversal test proves the page cannot reach.
        let (dir, library, drop_dir) = import_fixture("# Ignored\n\n## X\n\np\n");
        let outside = dir.path().join("Chosen Book.md");
        std::fs::write(&outside, "# The Harbour\n\n## One\n\nShe went down.\n")
            .expect("a file outside the drop directory");

        let summary = import_path(dir.path(), &library, &outside).expect("the import to land").summary;
        assert_eq!(summary.name, "The Harbour");
        // And the page's route still cannot name it.
        assert!(import_named(dir.path(), &library, &drop_dir, "../Chosen Book.md").is_err());
    }

    #[test]
    fn the_dialog_route_names_an_unnamed_manuscript_from_its_file_stem() {
        // `file_stem` on the PATH, not on a bare filename. A source with no
        // title of its own would otherwise be named after the whole path.
        let (dir, library, _drop) = import_fixture("# Ignored\n\n## X\n\np\n");
        let outside = dir.path().join("part 2.md");
        std::fs::write(&outside, "She went down to the harbour.\n").expect("an untitled source");

        let summary = import_path(dir.path(), &library, &outside).expect("the import to land").summary;
        assert_eq!(summary.name, "part 2");
    }

    #[test]
    fn both_import_routes_accept_a_remembered_external_stem() {
        let (dir, library, drop_dir) =
            import_fixture("# The Harbour\n\n## One\n\nShe went down.\n");
        let outside = dir.path().join("chosen.md");
        std::fs::write(&outside, "# The Harbour\n\n## One\n\nShe went down.\n")
            .expect("an outside manuscript");
        let remembered = dir.path().join("elsewhere").join("the-harbour.db");
        std::fs::create_dir_all(remembered.parent().unwrap()).expect("the remembered folder");
        let remembered_store = store::Store::open(&remembered).expect("a remembered manuscript");
        let remembered_id = remembered_store.book_id().unwrap().unwrap();
        drop(remembered_store);
        let remembered_before = std::fs::read(&remembered).unwrap();
        let picked_library = dir.path().join("picked-library");

        let named = import_named(dir.path(), &library, &drop_dir, "book.md")
            .expect("the drop-folder route accepted the import");
        let picked = import_path(dir.path(), &picked_library, &outside)
            .expect("the dialog route accepted the import");

        assert_eq!(std::fs::read(&remembered).unwrap(), remembered_before);
        let named_id = store::Store::open_readonly(Path::new(&named.summary.path)).unwrap().book_id().unwrap().unwrap();
        let picked_id = store::Store::open_readonly(Path::new(&picked.summary.path)).unwrap().book_id().unwrap().unwrap();
        assert_ne!(named_id, remembered_id);
        assert_ne!(picked_id, remembered_id);
    }

    #[test]
    fn the_dialog_route_enforces_the_same_size_bound() {
        // The bound belongs to the parse, not to the naming rule, so moving the
        // read out from behind `import_name_ok` must not have left it behind.
        let (dir, library, _drop) = import_fixture("# Ignored\n\n## X\n\np\n");
        let huge = dir.path().join("huge.md");
        // Sparse, via set_len: the bound is checked from the metadata, so a
        // 64 MB allocation would only make the suite slower to say the same
        // thing. That it is never read is the point — the refusal must come
        // before the read.
        std::fs::File::create(&huge)
            .and_then(|f| f.set_len(super::MAX_IMPORT_BYTES + 1))
            .expect("an oversized file");

        let err = import_path(dir.path(), &library, &huge).unwrap_err();
        assert!(err.contains("the limit is"), "{err}");
        assert!(
            crate::projects::list(&library).is_empty(),
            "a refused import must leave no project behind"
        );
    }

    #[test]
    fn a_missing_file_is_reported_rather_than_creating_an_empty_project() {
        let (dir, library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        let err = import_named(dir.path(), &library, &drop_dir, "absent.md").unwrap_err();
        assert!(err.contains("cannot read"), "{err}");
        assert!(
            crate::projects::list(&library).is_empty(),
            "a failed import must leave no project behind"
        );
    }

    #[test]
    fn importing_the_same_file_twice_is_refused_rather_than_merged() {
        let (dir, library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        import_named(dir.path(), &library, &drop_dir, "book.md").expect("the first import");
        let err = import_named(dir.path(), &library, &drop_dir, "book.md").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(crate::projects::list(&library).len(), 1);
    }

    #[test]
    fn a_file_that_does_not_name_itself_is_named_after_the_file() {
        let (dir, library, drop_dir) = import_fixture("# One\n\na\n\n# Two\n\nb\n");
        let summary = import_named(dir.path(), &library, &drop_dir, "book.md").expect("the import to land").summary;
        assert_eq!(summary.name, "book");
    }

    #[test]
    fn a_source_over_the_size_limit_is_refused_before_it_is_read() {
        let (dir, library, drop_dir) = import_fixture("# Book\n\n## One\n\nprose\n");
        let big = drop_dir.join("big.md");
        let f = std::fs::File::create(&big).expect("a file");
        // Sparse: the point is the recorded length, and writing 64 MB to make
        // that point would make this test the slowest in the suite.
        f.set_len(super::MAX_IMPORT_BYTES + 1).expect("a length");
        std::mem::drop(f);
        let err = import_named(dir.path(), &library, &drop_dir, "big.md").unwrap_err();
        assert!(err.contains("the limit is"), "{err}");
        assert!(crate::projects::list(&library).is_empty());
    }

    /// A DOCX BYTE STREAM WRITTEN UNDER A `.md` NAME STILL IMPORTS AS DOCX --
    /// decision 8's whole point: the format is decided by the bytes, not the
    /// extension, so a writer's misnamed export is not misread as prose.
    #[test]
    fn docx_bytes_under_an_md_name_import_as_docx() {
        let (dir, library, _drop) = import_fixture("# Ignored\n\n## X\n\np\n");
        let book = crate::export::Book {
            name: "The Harbour",
            contents_title: "Contents",
            front: &[],
            chapters: &[("s1".to_string(), "One".to_string(), 0i64)],
            back: &[],
        };
        let bodies = std::collections::HashMap::new();
        let docx = crate::docx::render(&book, &bodies, "en");
        let path = dir.path().join("misnamed.md");
        std::fs::write(&path, &docx.bytes).expect("a docx-bytes source");

        let summary = import_path(dir.path(), &library, &path).expect("the import to land").summary;
        assert_eq!(summary.name, "The Harbour");
    }

    /// A `.docx` FILE THAT IS NOT A ZIP IS REFUSED, matching the extension's
    /// own promise: the code must not fall through and misread it as
    /// Markdown just because the bytes happen to be valid UTF-8 text.
    #[test]
    fn a_docx_named_file_holding_plain_text_is_refused() {
        let (dir, library, _drop) = import_fixture("# Ignored\n\n## X\n\np\n");
        let path = dir.path().join("not-really.docx");
        std::fs::write(&path, "just plain text, no zip header here").expect("a fake docx");

        let err = import_path(dir.path(), &library, &path).unwrap_err();
        assert!(err.contains("not a DOCX"), "{err}");
        assert!(err.contains("zip header"), "{err}");
        assert!(crate::projects::list(&library).is_empty());
    }

    /// A PLAIN `.md` FILE STILL IMPORTS AS MARKDOWN -- the new extension
    /// check must only ever ADD a refusal for a misnamed `.docx`, never
    /// touch the ordinary Markdown route.
    #[test]
    fn a_plain_md_file_still_imports_as_markdown() {
        let (dir, library, drop_dir) = import_fixture("# The Harbour\n\n## One\n\nShe went down.\n");
        let summary = import_named(dir.path(), &library, &drop_dir, "book.md").expect("the import to land").summary;
        assert_eq!(summary.name, "The Harbour");
    }

    // ---- writing time ---------------------------------------------------

    fn stored_minutes(store: &crate::store::Store) -> Option<String> {
        store.get_meta(crate::projects::TIME_MINUTES_KEY).unwrap()
    }

    #[test]
    fn a_minute_with_an_edit_counts_once_and_the_next_minute_counts_again() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        assert_eq!(
            super::writing_time_for(&store, "2026-09-02", 1000, true).unwrap(),
            1
        );
        assert_eq!(
            super::writing_time_for(&store, "2026-09-02", 1000, true).unwrap(),
            1
        );
        assert_eq!(
            super::writing_time_for(&store, "2026-09-02", 1001, true).unwrap(),
            2
        );
        assert_eq!(
            stored_minutes(&store),
            Some("2".to_string()),
            "the count has to reach the file, or the next launch starts the day at zero"
        );
    }

    #[test]
    fn a_read_counts_nothing_and_writes_nothing_on_a_quiet_day() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        super::writing_time_for(&store, "2026-09-02", 1000, true).unwrap();
        assert_eq!(
            super::writing_time_for(&store, "2026-09-02", 1005, false).unwrap(),
            1
        );
        assert_eq!(
            super::writing_time_for(&store, "2026-09-02", 1006, false).unwrap(),
            1
        );
        assert_eq!(
            store
                .get_meta(crate::projects::TIME_LAST_MINUTE_KEY)
                .unwrap(),
            Some("1000".to_string()),
            "a read must not move the last counted minute"
        );
    }

    #[test]
    fn a_new_day_starts_at_zero_and_is_anchored_by_the_read_that_finds_it() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        super::writing_time_for(&store, "2026-09-02", 1000, true).unwrap();
        assert_eq!(
            super::writing_time_for(&store, "2026-09-03", 2000, false).unwrap(),
            0
        );
        assert_eq!(
            store.get_meta(crate::projects::TIME_DAY_KEY).unwrap(),
            Some("2026-09-03".to_string())
        );
        assert_eq!(stored_minutes(&store), Some("0".to_string()));
        // And the old day's last minute cannot suppress the new day's first.
        assert_eq!(
            super::writing_time_for(&store, "2026-09-03", 1000, true).unwrap(),
            1
        );
    }

    #[test]
    fn a_broken_minutes_row_is_rebuilt_rather_than_trusted() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        store
            .set_meta(crate::projects::TIME_DAY_KEY, "2026-09-02")
            .unwrap();
        store
            .set_meta(crate::projects::TIME_MINUTES_KEY, "lots")
            .unwrap();
        assert_eq!(
            super::writing_time_for(&store, "2026-09-02", 1000, true).unwrap(),
            1
        );
    }

    #[test]
    fn a_string_that_is_not_a_date_is_refused_before_anything_is_written() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        assert!(super::writing_time_for(&store, "today", 1000, true).is_err());
        assert_eq!(stored_minutes(&store), None);
    }

    // ---- writing goals -------------------------------------------------

    #[test]
    fn progress_ignores_legacy_baselines_and_unattributed_changes() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        store.set_meta(crate::projects::DAY_KEY, "2026-08-16").unwrap();
        store.set_meta(crate::projects::DAY_BASELINE_KEY, "1").unwrap();
        assert_eq!(progress_for(&store, 4, "2026-08-16").unwrap(),
            super::Progress { total: 4, today: Some(0), collecting: true });
        assert_eq!(store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn progress_counts_only_committed_typing_and_turns_at_local_midnight() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let item = project.store.item_create(None, "scene", "Scene").unwrap();
        let sources: Vec<crate::store::source_words::FlushAttribution> = serde_json::from_value(serde_json::json!([{
            "item_id": item.id, "day": "2026-08-16", "changes": [
                {"source": "typing", "added": 2, "deleted": 0},
                {"source": "pasted", "added": 3, "deleted": 0}
            ]
        }])).unwrap();
        super::flush_into_with_sources(&mut project, &[crate::store::FlushEntry {
            item_id: item.id.clone(), body: body("one two three four five"),
            base_rev: item.doc_rev.unwrap(), comments: None,
        }], 1, &sources).unwrap();
        assert_eq!(progress_for(&project.store, 5, "2026-08-16").unwrap().today, Some(2));
        assert_eq!(progress_for(&project.store, 5, "2026-08-17").unwrap().today, Some(0));
        let sources: Vec<crate::store::source_words::FlushAttribution> = serde_json::from_value(serde_json::json!([{
            "item_id": item.id, "day": "2026-08-16", "changes": [
                {"source": "typing", "added": 0, "deleted": 4}
            ]
        }])).unwrap();
        super::flush_into_with_sources(&mut project, &[crate::store::FlushEntry {
            item_id: item.id, body: body("one"), base_rev: 2, comments: None,
        }], 1, &sources).unwrap();
        assert_eq!(progress_for(&project.store, 1, "2026-08-16").unwrap().today, Some(-2));
    }

    #[test]
    fn progress_says_when_saved_words_are_not_being_measured() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        store.set_source_words_collecting(false).unwrap();
        assert_eq!(progress_for(&store, 4, "2026-08-16").unwrap(),
            super::Progress { total: 4, today: Some(0), collecting: false });
    }

    #[test]
    fn source_word_commands_refuse_a_stale_generation() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let item = project.store.item_create(None, "scene", "Scene").unwrap();
        let sources: Vec<crate::store::source_words::FlushAttribution> = serde_json::from_value(serde_json::json!([{
            "item_id": item.id, "day": "2026-08-16", "changes": [
                {"source": "typing", "added": 2, "deleted": 0}
            ]
        }])).unwrap();
        super::flush_into_with_sources(&mut project, &[crate::store::FlushEntry {
            item_id: item.id, body: body("one two"),
            base_rev: item.doc_rev.unwrap(), comments: None,
        }], 1, &sources).unwrap();

        assert!(super::source_words_collecting_into(&project, 2, false).is_err());
        assert!(super::source_words_reset_into(&project, 2).is_err());
        let summary = project.store.source_word_summary("2026-08-16").unwrap();
        assert!(summary.collecting);
        assert_eq!(summary.today_typing, Some(2));

        super::source_words_collecting_into(&project, 1, false).unwrap();
        super::source_words_reset_into(&project, 1).unwrap();
        let summary = project.store.source_word_summary("2026-08-16").unwrap();
        assert!(!summary.collecting);
        assert_eq!(summary.today_typing, Some(0));
    }

    #[test]
    fn progress_refuses_invalid_dates() {
        let dir = tempdir().unwrap();
        let store = seeded_project(&dir.path().join("book.db"));
        for bad in ["", "today", "2026-8-16", "2026-08-16T00:00", "20260816", "2026/08/16"] {
            assert!(progress_for(&store, 4, bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn the_date_check_is_a_shape_and_says_so() {
        assert!(looks_like_a_date("2026-08-16"));
        // Documented cost: no calendar, so an impossible day passes. Stated as
        // a test rather than only a comment, so a later tightening is a
        // decision someone makes rather than a surprise.
        assert!(looks_like_a_date("2026-02-31"));
        assert!(!looks_like_a_date("2026-08-1"));
        assert!(!looks_like_a_date("2026-08-160"));
        assert!(!looks_like_a_date("2026_08_16"));
        assert!(!looks_like_a_date("20a6-08-16"));
    }

    #[test]
    fn the_target_reaches_the_page_as_a_startup_global() {
        let mut settings = crate::projects::Settings::default();
        settings.daily_target = crate::projects::DailyTarget::W1000;
        let js = preferences_js(&settings);
        assert!(js.contains("window.__appDailyTarget='1000'"), "{js}");
    }

    #[test]
    fn a_flush_records_history_and_a_history_failure_does_not_fail_the_flush() {
        // The ordering claim: the prose is durable first. Sabotaging history is
        // not reachable from here, so what this pins is the positive half --
        // that flush_into records at all - plus the shape that makes the
        // negative half true, which is that the ack is built from the flush.
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let mut project = opened(&path);
        let created = project.store.item_create(None, "scene", "One").unwrap();

        let acks = flush_into(
            &mut project,
            &[crate::store::FlushEntry {
                item_id: created.id.clone(),
                body: body("hello"),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();

        assert_eq!(acks.len(), 1);
        assert_eq!(project.store.doc_versions(&created.id).unwrap().len(), 1);
    }

    // ---- manuscript-wide replace ----

    #[test]
    fn a_manuscript_replace_rewrites_every_live_scene_and_takes_a_snapshot_first() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let mut project = opened(&path);
        let mut ids = Vec::new();
        for i in 0..3 {
            let c = project
                .store
                .item_create(None, "scene", &format!("S{i}"))
                .unwrap();
            flush_into(
                &mut project,
                &[crate::store::FlushEntry {
                    item_id: c.id.clone(),
                    body: body("the moon and the moon again"),
                    base_rev: c.doc_rev.unwrap(),
                    comments: None,
                }],
                1,
            )
            .unwrap();
            ids.push(c.id);
        }

        let report = replace_across(&mut project, "moon", "sun").unwrap();

        assert_eq!(report.replaced, 6);
        assert_eq!(report.documents, 3);
        assert_eq!(report.snapshot.documents, 3);
        assert_eq!(
            report.snapshot.label,
            "Before replacing \"moon\" with \"sun\""
        );
        for id in &ids {
            assert!(project.store.load_doc(id).unwrap().body.contains("sun"));
            assert!(!project.store.load_doc(id).unwrap().body.contains("moon"));
        }
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn the_snapshot_a_manuscript_replace_takes_restores_the_manuscript() {
        // The whole safety argument, exercised rather than asserted: this
        // operation was refused because it had no inverse.
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let mut project = opened(&path);
        let c = project.store.item_create(None, "scene", "S").unwrap();
        flush_into(
            &mut project,
            &[crate::store::FlushEntry {
                item_id: c.id.clone(),
                body: body("the moon over the water"),
                base_rev: c.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let before = project.store.load_doc(&c.id).unwrap().body;

        let report = replace_across(&mut project, "moon", "sun").unwrap();
        assert_ne!(project.store.load_doc(&c.id).unwrap().body, before);

        snapshot_restore_into(&mut project, report.snapshot.id).unwrap();

        assert_eq!(project.store.load_doc(&c.id).unwrap().body, before);
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn a_manuscript_replace_does_not_touch_the_bin() {
        // Rewriting deleted work would hand the writer text they never wrote
        // the moment they restored it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let mut project = opened(&path);
        let live = create_into(&mut project, None, "scene", "Live").unwrap();
        let bin = create_into(&mut project, None, crate::store::TRASH_TYPE, "Trash").unwrap();
        let gone = create_into(&mut project, Some(&bin.id), "scene", "Gone").unwrap();
        for c in [&live, &gone] {
            flush_into(
                &mut project,
                &[crate::store::FlushEntry {
                    item_id: c.id.clone(),
                    body: body("the moon"),
                    base_rev: c.doc_rev.unwrap(),
                    comments: None,
                }],
                1,
            )
            .unwrap();
        }
        project.refresh_excluded();
        assert!(
            project.excluded.contains(&gone.id),
            "the fixture's bin is not a bin"
        );

        let report = replace_across(&mut project, "moon", "sun").unwrap();

        assert_eq!(report.documents, 1);
        assert!(project
            .store
            .load_doc(&live.id)
            .unwrap()
            .body
            .contains("sun"));
        assert!(
            project
                .store
                .load_doc(&gone.id)
                .unwrap()
                .body
                .contains("moon"),
            "the binned scene was rewritten",
        );
    }

    #[test]
    fn a_replacement_with_a_line_break_is_refused_before_anything_is_written() {
        // A literal newline cannot live in a ProseMirror text node. Refusing
        // before the transaction opens is what keeps a manuscript from being
        // half-rewritten by a replacement that cannot exist.
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let mut project = opened(&path);
        let c = project.store.item_create(None, "scene", "S").unwrap();
        flush_into(
            &mut project,
            &[crate::store::FlushEntry {
                item_id: c.id.clone(),
                body: body("the moon"),
                base_rev: c.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let before = project.store.load_doc(&c.id).unwrap().body;

        let err = replace_across(&mut project, "moon", "sun\nrise").unwrap_err();

        assert!(err.contains("line break"), "got {err}");
        assert_eq!(project.store.load_doc(&c.id).unwrap().body, before);
        assert!(
            project.store.snapshots().unwrap().is_empty(),
            "a snapshot was taken anyway"
        );
    }

    #[test]
    fn an_empty_query_is_refused_rather_than_matching_everything() {
        let dir = tempdir().unwrap();
        let mut project = opened(&dir.path().join("p.db"));
        assert!(replace_across(&mut project, "   ", "x").is_err());
        assert!(project.store.snapshots().unwrap().is_empty());
    }

    #[test]
    fn the_snapshot_label_says_what_is_about_to_happen() {
        // The writer's only handle on the inverse of the largest operation this
        // application performs. Quoted, so a term with a space still reads as
        // one thing.
        assert_eq!(
            replace_snapshot_label("old man", "young woman"),
            "Before replacing \"old man\" with \"young woman\"",
        );
    }

    /// The schedule is a rule, and a rule built inline in `main()` cannot be
    /// tested -- a mutation dropping the recorded window size survived the whole
    /// suite for exactly that reason. Second instance of the recorded shape, so
    /// the decision is a function.
    #[test]
    fn the_recovery_schedule_is_off_in_a_measurement_run_and_on_otherwise() {
        assert_eq!(
            recovery_interval("on", 900_000),
            Some(std::time::Duration::from_millis(900_000))
        );
        assert_eq!(recovery_interval("off", 900_000), None);
        // An unrecognised value is ON, not off. A typo in an operator's profile
        // must not silently disable the writer's only second copy -- the
        // failure mode this whole feature exists to prevent is believing you
        // are protected when you are not.
        assert_eq!(
            recovery_interval("", 900_000),
            Some(std::time::Duration::from_millis(900_000))
        );
        assert_eq!(
            recovery_interval("of", 900_000),
            Some(std::time::Duration::from_millis(900_000))
        );
        // A zero interval is off rather than a spin loop.
        assert_eq!(recovery_interval("on", 0), None);
    }

    #[test]
    fn an_unrecognised_mode_still_takes_the_close_point() {
        // The same fail-safe direction as the schedule, and it has to be the
        // SAME rule rather than a second statement of it: a close point that
        // disagreed with the timer about what "off" means would take one in a
        // measurement run and pollute the timings that run exists to record.
        assert!(close_point_wanted("", 900_000));
        assert!(close_point_wanted("of", 900_000));
        assert!(close_point_wanted("on", 900_000));
    }

    #[test]
    fn the_close_point_is_off_when_the_schedule_is() {
        // APP_RECOVERY_MODE=off must reach EVERY trigger, or a rig boot takes a
        // point of its own fixture and the directory it grades is not the one
        // it set up.
        assert!(!close_point_wanted("off", 900_000));
        assert!(!close_point_wanted("on", 0));
    }

    #[test]
    fn the_point_is_taken_BEFORE_the_window_is_let_go() {
        // The ordering, driven rather than asserted about. A copy started
        // beside `window.close()` races process exit.
        let order = std::cell::RefCell::new(Vec::new());
        close_cleanly(
            true,
            || order.borrow_mut().push("point"),
            || order.borrow_mut().push("close"),
        );
        assert_eq!(*order.borrow(), vec!["point", "close"]);
    }

    #[test]
    fn a_close_with_no_point_wanted_still_closes() {
        let order = std::cell::RefCell::new(Vec::new());
        close_cleanly(
            false,
            || order.borrow_mut().push("point"),
            || order.borrow_mut().push("close"),
        );
        assert_eq!(*order.borrow(), vec!["close"]);
    }

    /// A book, mirrored to `out`, with one scene carrying prose. Returns that
    /// scene's id and its mirror-relative path.
    fn seed_a_mirrored_book(src: &Path, out: &Path) -> (String, String) {
        let store = store::Store::open(src).unwrap();
        let part = store.item_create(None, "part", "Winter Cafe").unwrap();
        let scene = store
            .item_create(Some(&part.id), "scene", "Letter Storm")
            .unwrap();
        store
            .flush(&[store::FlushEntry {
                item_id: scene.id.clone(),
                body: body("four words go here"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        drop(store);
        let report = mirror::pass(
            src,
            "book",
            "Book",
            out,
            store::now_ms(),
            &std::collections::HashSet::new(),
        )
        .unwrap();
        let entry = report.entries.iter().find(|e| e.words > 0).unwrap();
        // The recorded mirror rule: a scan cannot see a rewrite that lands in
        // the same millisecond, so the BASELINE is moved rather than the file.
        let mut manifest: recovery::Manifest<mirror::MirrorEntry> =
            recovery::read_manifest(out).unwrap();
        for e in &mut manifest.entries {
            e.mtime_ms -= 1;
        }
        recovery::write_manifest(out, &manifest).unwrap();
        (entry.id.clone(), entry.path.clone())
    }

    /// Rewrite one mirror file's prose, keeping the front matter and heading.
    fn rewrite_one_file(out: &Path, path: &str, prose: &str) {
        let current = std::fs::read_to_string(out.join(path)).unwrap();
        let head: Vec<&str> = current
            .lines()
            .take_while(|l| !l.starts_with("# "))
            .collect();
        let heading = current.lines().find(|l| l.starts_with("# ")).unwrap();
        std::fs::write(
            out.join(path),
            format!("{}\n{}\n\n{}\n", head.join("\n"), heading, prose),
        )
        .unwrap();
    }

    /// An `OpenProject` over a file on disk, built exactly as a real open
    /// builds one: the index and the excluded set both from the walk.
    fn open_for_test(src: &Path) -> OpenProject {
        let store = store::Store::open(src).unwrap();
        let words = store.word_index().unwrap();
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        OpenProject {
            book_id: super::project_book_id(&store).unwrap(),
            registry_home: None,
            store,
            path: src.to_path_buf(),
            name: "Book".to_string(),
            generation: 1,
            analytics: None,
            tracking_on: true,
            words,
            excluded,
        }
    }

    #[test]
    fn ordinary_archive_refuses_a_superseded_opening_of_the_same_path() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("book.db");
        let state = StoreState(Mutex::new(Some(open_for_test(&path))));
        assert_eq!(super::capture_archive_source(&state, Some(1)).unwrap().path, path);
        assert!(super::capture_archive_source(&state, Some(2)).err().unwrap().contains("changed"));
        locked(&state).as_mut().unwrap().generation = 2;
        assert!(super::capture_archive_source(&state, Some(1)).err().unwrap().contains("changed"));
        assert_eq!(super::capture_archive_source(&state, Some(2)).unwrap().path, path);
    }

    // ---- accepting from the readable folder --------------------------

    #[test]
    fn the_acceptance_label_says_what_happened_and_counts_in_words() {
        // COMPOSED BY THE HOST, never taken from the page: it is the writer's
        // only handle on the inverse of a body rewrite, so it has to say what
        // happened rather than whatever a caller passed. `replace_snapshot_label`
        // is the precedent and this is the same rule.
        assert_eq!(
            accept_snapshot_label(1),
            "Before accepting 1 change from the readable folder"
        );
        assert_eq!(
            accept_snapshot_label(12),
            "Before accepting 12 changes from the readable folder"
        );
    }

    #[test]
    fn accepting_and_undoing_move_the_word_index_for_exactly_the_documents_they_wrote() {
        // Design section 6: the per-document index already supports this, so an
        // acceptance updates twelve entries and the project total follows. A
        // full recount here would be the recorded 58 ms regression in a
        // different hat -- and it would also be UNFALSIFIABLE against a
        // per-document update, which is why the assertion is the total.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book.db");
        let out = tmp.path().join("mirror");
        let (id, path) = seed_a_mirrored_book(&src, &out);
        rewrite_one_file(&out, &path, "she rewrote the whole scene in another editor");

        let mut project = open_for_test(&src);
        let before = project.word_count().words;
        let rows = changes_in(&out, &src, &mirror::detect(&out));
        let outcome = accept_into(&mut project, &rows, &[id.clone()]).unwrap();

        assert_eq!(outcome.report.documents.len(), 1);
        assert_eq!(
            project.word_count().words,
            before - 4 + 8,
            "the index must follow the accepted body and nothing else"
        );
        let accepted = outcome.report.documents[0].clone();
        let restored = undo_mirror_accept_into(
            &mut project,
            1,
            &id,
            accepted.version_id,
            outcome.report.snapshot.id,
            accepted.rev,
        )
        .unwrap();
        assert_eq!(
            store::document_text(&restored.body).unwrap(),
            "four words go here",
            "undo must restore only the accepted document's pre-accept words"
        );
        assert_eq!(project.word_count().words, before);
        assert_eq!(project.word_count(), word_count_at(&src).unwrap());
    }

    #[test]
    fn mirror_undo_refuses_a_handle_from_another_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book.db");
        let out = tmp.path().join("mirror");
        let (id, path) = seed_a_mirrored_book(&src, &out);
        rewrite_one_file(&out, &path, "she rewrote the whole scene in another editor");
        let mut project = open_for_test(&src);
        let rows = changes_in(&out, &src, &mirror::detect(&out));
        let outcome = accept_into(&mut project, &rows, &[id.clone()]).unwrap();
        let accepted = outcome.report.documents[0].clone();
        let before = project.store.load_doc(&id).unwrap();

        let refusal = undo_mirror_accept_into(
            &mut project,
            2,
            &id,
            accepted.version_id,
            outcome.report.snapshot.id,
            accepted.rev,
        );

        assert!(refusal.is_err());
        let after = project.store.load_doc(&id).unwrap();
        assert_eq!(after.body, before.body);
        assert_eq!(after.rev, before.rev);
    }

    #[test]
    fn accepting_a_row_the_change_set_refuses_writes_nothing_at_all() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book.db");
        let out = tmp.path().join("mirror");
        let (id, path) = seed_a_mirrored_book(&src, &out);
        // A renamed heading: `title`, which outranks prose.
        let current = std::fs::read_to_string(out.join(&path)).unwrap();
        std::fs::write(
            out.join(&path),
            current.replace("# Letter Storm", "# Letter Storm, revised"),
        )
        .unwrap();

        let mut project = open_for_test(&src);
        let before = project.store.load_doc(&id).unwrap();
        let rows = changes_in(&out, &src, &mirror::detect(&out));
        assert!(accept_into(&mut project, &rows, &[id.clone()]).is_err());
        assert_eq!(project.store.load_doc(&id).unwrap().body, before.body);
        assert_eq!(project.store.load_doc(&id).unwrap().rev, before.rev);
        assert!(project.store.snapshots().unwrap().is_empty());
    }
}
