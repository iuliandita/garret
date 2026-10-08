use crate::commands::export::{export_into, export_slug, replace_file, Dest, ExportResult};
use crate::export::Format;
use crate::{
    create_into_dir, export_dir, import_path, imports_dir, locked, new_book_dir, open_project,
    projects, store, DataHome, ExplicitProject, HostStrings, OpenProject, StoreState,
    NO_PROJECT,
};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};
use std::sync::atomic::Ordering;
use std::sync::Mutex;

/// The title the MARKDOWN export dialog carries. Named by this application
/// rather than left to GTK's default ("Save File"), because `dialog-cli` finds
/// the window by title — the dialog inherits the app's own `WM_CLASS`, so a
/// class search returns two windows while it is open and the rigs' exactly-one
/// guard fires. A default chosen by the toolkit can change under us; this one
/// cannot. `dialog-cli.ts` restates it and locates the window by it, so it is a
/// rig-visible string: changing it changes what a graded run can find.
const EXPORT_DIALOG_TITLE: &str = "Export manuscript";

/// The name the file-type filter carries, beside `Format::extension`.
const MARKDOWN_FILTER_LABEL: &str = "Markdown";

/// The title the EPUB save dialog carries, and its filter's label.
///
/// A TITLE OF ITS OWN, not `EXPORT_DIALOG_TITLE` shared. `dialog-cli` finds the
/// Markdown dialog by its title and asserts there is exactly one window with
/// it; two operations sharing one title would make that guard unable to say
/// which dialog it found, and a rig that cannot tell two windows apart is the
/// recorded shape of a run that reports a plausible number about the wrong
/// thing. Rig-visible for the same reason the Markdown one is.
const EPUB_DIALOG_TITLE: &str = "Save EPUB";
const EPUB_FILTER_LABEL: &str = "EPUB";

/// 044's, and a title of its own for `EPUB_DIALOG_TITLE`'s recorded reason:
/// `dialog-cli` finds a dialog by TITLE, so two dialogs sharing one would be
/// two dialogs the rig cannot tell apart.
const PDF_DIALOG_TITLE: &str = "Save PDF proof";
const PDF_FILTER_LABEL: &str = "PDF";

/// 092's, and a title of its own for `EPUB_DIALOG_TITLE`'s recorded reason.
const DOCX_DIALOG_TITLE: &str = "Save DOCX";
const DOCX_FILTER_LABEL: &str = "DOCX";

/// The statistics file's dialog. A title of its own for the recorded reason,
/// and one title for both kinds: the two are never open at once, and the kind
/// is in the filter and the default name.
const STATISTICS_DIALOG_TITLE: &str = "Export statistics";

/// The open dialog's title, for the same reason.
const IMPORT_DIALOG_TITLE: &str = "Import manuscript";
const KEY_SAVE_DIALOG_TITLE: &str = "Save recovery key";
const KEY_OPEN_DIALOG_TITLE: &str = "Choose recovery key";
const ENCRYPTED_SAVE_DIALOG_TITLE: &str = "Save encrypted archive";
const ENCRYPTED_OPEN_DIALOG_TITLE: &str = "Open encrypted archive";
const DESIGN_SAVE_DIALOG_TITLE: &str = "Save book design";
const DESIGN_OPEN_DIALOG_TITLE: &str = "Preview book design or salvage manifest";

#[derive(Clone)]
struct PendingDesign {
    source: PathBuf,
    generation: u64,
    epoch: u64,
    token: String,
}

#[derive(Default)]
pub(crate) struct DesignTransferPending(Mutex<Option<PendingDesign>>);

/// `"Manuscripts"` over two extensions, beside the label -- see
/// `ask_for_import_path`'s own note for why one filter names both formats.
/// Named apart from that (untestable, async) call so a test can pin the
/// label and the extension list without driving a dialog at all.
const IMPORT_FILTER_LABEL: &str = "Manuscripts";
const IMPORT_FILTER_EXTENSIONS: &[&str] = &["md", "docx"];

/// The folder dialog's title, for the same reason again.
const FOLDER_DIALOG_TITLE: &str = "Where to keep this book";

/// The folder dialog a MOVE opens. Its own title, for `dialog-cli`'s reason.
const MOVE_DIALOG_TITLE: &str = "Move this book to";

/// The picture dialog's title, for the same reason again.
const PICTURE_DIALOG_TITLE: &str = "Choose a picture";

/// Everything about a save dialog that depends on WHICH FORMAT is being
/// written, decided away from the toolkit so a test can read it.
///
/// The dialog itself is untestable — a `#[tauri::command]` is not callable from
/// a test and the window is the toolkit's — which is exactly why the part that
/// can be wrong on its own is a plain value: a filter offering the wrong
/// extension, or a default filename ending in one format while the file holds
/// another, is a defect no unit test could otherwise reach and `dialog-cli` only
/// sees for the format it happens to drive.
pub(crate) struct SaveDialog<'a> {
    /// The window title. Rig-visible: `dialog-cli` locates the dialog by it.
    pub(crate) title: &'a str,
    /// The name of the file-type filter, e.g. `Markdown`.
    pub(crate) filter_label: &'a str,
    /// The extensions that filter accepts, without dots.
    pub(crate) extensions: &'static [&'static str],
    /// What the name field starts at.
    pub(crate) default_name: String,
}

/// The save dialog for exporting `name` as `format`.
///
/// The match is the parameterisation the publishing track's design record asks
/// for: the title, the filter and the default name were three literals wired to
/// Markdown, and 043 and 044 each need all three to say something else. The
/// extension comes from `Format` because the FILE's name and the RESULT's
/// reported format must not be able to disagree; the words beside it live here
/// because `export.rs` is pure and holds no host chrome.
pub(crate) fn export_save_dialog(name: &str, format: Format) -> SaveDialog<'static> {
    let (title, filter_label, extensions): (&'static str, &'static str, &'static [&'static str]) =
        match format {
            Format::Markdown => (EXPORT_DIALOG_TITLE, MARKDOWN_FILTER_LABEL, &["md"]),
            Format::Epub => (EPUB_DIALOG_TITLE, EPUB_FILTER_LABEL, &["epub"]),
            Format::Pdf => (PDF_DIALOG_TITLE, PDF_FILTER_LABEL, &["pdf"]),
            Format::Docx => (DOCX_DIALOG_TITLE, DOCX_FILTER_LABEL, &["docx"]),
        };
    SaveDialog {
        title,
        filter_label,
        extensions,
        default_name: format!("{}.{}", export_slug(name), format.extension()),
    }
}

/// Which data file the page composed. Narrow on purpose: the page names one
/// of two words and the host refuses anything else, as `Format::from_id` does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StatisticsKind {
    Csv,
    Json,
}

impl StatisticsKind {
    pub(crate) fn from_id(id: &str) -> Option<Self> {
        match id {
            "csv" => Some(Self::Csv),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }

    fn filter_label(self) -> &'static str {
        match self {
            Self::Csv => "CSV",
            Self::Json => "JSON",
        }
    }
}

/// The save dialog for the statistics of `name` as `kind`. `-statistics` in
/// the default name so the file cannot be mistaken for the manuscript's own
/// export sitting beside it in the same directory.
pub(crate) fn statistics_save_dialog(name: &str, kind: StatisticsKind) -> SaveDialog<'static> {
    SaveDialog {
        title: STATISTICS_DIALOG_TITLE,
        filter_label: kind.filter_label(),
        extensions: match kind {
            StatisticsKind::Csv => &["csv"],
            StatisticsKind::Json => &["json"],
        },
        default_name: format!("{}-statistics.{}", export_slug(name), kind.extension()),
    }
}

/// Ask the writer where to put a file, through the operating system.
///
/// ASYNC, over the CALLBACK API, and that is not a style choice — see the design
/// note. `blocking_save_file()` from a synchronous `#[tauri::command]` never
/// opens a window at all: the command thread parks forever, the application
/// stays alive, the webview stays responsive, and the feature silently does
/// nothing with no error anywhere. The callback shape works because the callback
/// is delivered on the thread already pumping the GTK loop, which is what a
/// dialog needs in order to map.
pub(crate) async fn ask_for_export_path(
    app: &tauri::AppHandle,
    dir: &Path,
    dialog: &SaveDialog<'_>,
) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    { crate::privacy_native::pick(app, gtk::FileChooserAction::Save, dialog.title.into(), dir.to_path_buf(), Some(dialog.default_name.clone()), Some((dialog.filter_label.into(), dialog.extensions.iter().map(|s| s.to_string()).collect()))).await }
    #[cfg(windows)]
    { crate::privacy_windows::pick(app, crate::privacy_windows::PickAction::Save, dialog.title.into(), dir.to_path_buf(), Some(dialog.default_name.clone()), Some((dialog.filter_label.into(), dialog.extensions.iter().map(|s| s.to_string()).collect()))).await }
    #[cfg(target_os = "macos")]
    {

    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title(dialog.title)
        .set_directory(dir)
        .set_file_name(&dialog.default_name)
        .add_filter(dialog.filter_label, dialog.extensions)
        .save_file(move |picked| {
            // The receiver is alive until this fires; a send error would mean the
            // command was dropped, in which case there is nobody to tell.
            let _ = tx.blocking_send(picked);
        });
    rx.recv().await.flatten().and_then(|p| p.into_path().ok())

    }
}

/// Ask the writer which manuscript to read, through the operating system.
///
/// `"Manuscripts"` OVER TWO EXTENSIONS, not a Markdown filter and a DOCX
/// filter as two entries: the writer is picking a manuscript to import, not
/// deciding which format it is in, and `import_path` sniffs the content
/// regardless of what this filter offered (decision 8).
async fn ask_for_import_path(app: &tauri::AppHandle, dir: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    { crate::privacy_native::pick(app, gtk::FileChooserAction::Open, IMPORT_DIALOG_TITLE.into(), dir.to_path_buf(), None, Some((IMPORT_FILTER_LABEL.into(), IMPORT_FILTER_EXTENSIONS.iter().map(|s| s.to_string()).collect()))).await }
    #[cfg(windows)]
    { crate::privacy_windows::pick(app, crate::privacy_windows::PickAction::Open, IMPORT_DIALOG_TITLE.into(), dir.to_path_buf(), None, Some((IMPORT_FILTER_LABEL.into(), IMPORT_FILTER_EXTENSIONS.iter().map(|s| s.to_string()).collect()))).await }
    #[cfg(target_os = "macos")]
    {

    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title(IMPORT_DIALOG_TITLE)
        .set_directory(dir)
        .add_filter(IMPORT_FILTER_LABEL, IMPORT_FILTER_EXTENSIONS)
        .pick_file(move |picked| {
            let _ = tx.blocking_send(picked);
        });
    rx.recv().await.flatten().and_then(|p| p.into_path().ok())

    }
}

pub(crate) async fn ask_for_named_open(app: &tauri::AppHandle, dir: &Path, title: &str, label: &str, extension: &str) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    { crate::privacy_native::pick(app, gtk::FileChooserAction::Open, title.into(), dir.to_path_buf(), None, Some((label.into(), vec![extension.into()]))).await }
    #[cfg(windows)]
    { crate::privacy_windows::pick(app, crate::privacy_windows::PickAction::Open, title.into(), dir.to_path_buf(), None, Some((label.into(), vec![extension.into()]))).await }
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::DialogExt;
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        app.dialog().file().set_title(title).set_directory(dir).add_filter(label, &[extension])
            .pick_file(move |picked| { let _ = tx.blocking_send(picked); });
        rx.recv().await.flatten().and_then(|p| p.into_path().ok())
    }
}

fn dialog_epoch(app: &tauri::AppHandle) -> u64 {
    app.state::<crate::privacy_host::Epoch>().0.load(Ordering::SeqCst)
}

fn dialog_still_owned(app: &tauri::AppHandle, epoch: u64) -> Result<(), String> {
    if crate::privacy_host::locked(app) || dialog_epoch(app) != epoch {
        Err("application locked or changed while choosing a file".into())
    } else { Ok(()) }
}

#[command_boundary::command]
pub(crate) async fn design_export_as(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
) -> Result<Option<String>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let (name, generation) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (project.name.clone(), project.generation)
    };
    let dir = export_dir(&data_home.0);
    fs::create_dir_all(&dir).map_err(|e| format!("design export directory unavailable: {e}"))?;
    let dialog = SaveDialog {
        title: DESIGN_SAVE_DIALOG_TITLE,
        filter_label: "Book design",
        extensions: &["json"],
        default_name: format!("{}.book-design.json", export_slug(&name)),
    };
    let Some(dest) = ask_for_export_path(&app, &dir, &dialog).await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation { return Err("project changed while choosing a design destination".into()); }
    dialog_still_owned(&app, epoch)?;
    crate::design_transfer::export(&project.store, &dest)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[command_boundary::command]
pub(crate) async fn design_import_preview(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    pending: State<'_, DesignTransferPending>,
    data_home: State<'_, DataHome>,
) -> Result<Option<crate::design_transfer::Preview>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let generation = {
        let guard = locked(&state);
        open_project(&guard)?.generation
    };
    let dir = export_dir(&data_home.0);
    let Some(source) = ask_for_named_open(&app, &dir, DESIGN_OPEN_DIALOG_TITLE, "JSON design or salvage manifest", "json").await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation { return Err("project changed while choosing design source".into()); }
    dialog_still_owned(&app, epoch)?;
    let preview = crate::design_transfer::preview(&project.store, &project.path, &source, generation)?;
    dialog_still_owned(&app, epoch)?;
    *pending.0.lock().map_err(|_| "design preview state unavailable")? = Some(PendingDesign {
        source, generation, epoch, token: preview.token.clone(),
    });
    Ok(Some(preview))
}

#[command_boundary::command]
pub(crate) fn design_import_apply(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    pending: State<'_, DesignTransferPending>,
    token: String,
) -> Result<crate::design_transfer::Preview, String> {
    let chosen = pending.0.lock().map_err(|_| "design preview state unavailable")?
        .clone().ok_or("preview a design source before applying it")?;
    dialog_still_owned(&app, chosen.epoch)?;
    if chosen.token != token { return Err("design preview token changed".into()); }
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != chosen.generation { return Err("project changed after design preview".into()); }
    dialog_still_owned(&app, chosen.epoch)?;
    let applied = crate::design_transfer::apply(&project.store, &project.path, &chosen.source, chosen.generation, &token)?;
    *pending.0.lock().map_err(|_| "design preview state unavailable after apply")? = None;
    Ok(applied)
}

fn canonical_backup_destination(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("encrypted backup folder must be an absolute path".into());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| "encrypted backup folder unavailable; reconnect it or choose another folder")?;
    if !canonical.is_dir() {
        return Err("encrypted backup destination is not a folder".into());
    }
    Ok(canonical)
}

fn encrypted_backup_start(data_home: &Path) -> Result<PathBuf, String> {
    match projects::read_settings_checked(data_home)?.encrypted_backup_dir {
        Some(path) => canonical_backup_destination(Path::new(&path)),
        None => {
            let dir = export_dir(data_home);
            fs::create_dir_all(&dir).map_err(|e| format!("archive destination unavailable: {e}"))?;
            Ok(dir)
        }
    }
}

fn encrypted_archive_default_name(dir: &Path, now_ms: i64) -> String {
    let timestamp = crate::recovery::point_id(now_ms);
    let stem = format!("archive-{}.{:03}Z", timestamp.trim_end_matches('Z'), now_ms.rem_euclid(1000));
    let mut name = format!("{stem}.age");
    let mut ordinal = 2;
    while dir.join(&name).exists() {
        name = format!("{stem}-{ordinal}.age");
        ordinal += 1;
    }
    name
}

#[command_boundary::command]
pub(crate) fn encrypted_backup_destination(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
) -> Result<Option<String>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let destination = projects::read_settings_checked(&data_home.0)?.encrypted_backup_dir;
    dialog_still_owned(&app, epoch)?;
    Ok(destination)
}

#[command_boundary::command]
pub(crate) async fn encrypted_backup_destination_pick(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
    strings: State<'_, HostStrings>,
) -> Result<Option<String>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let remembered = projects::read_settings_checked(&data_home.0)?.encrypted_backup_dir;
    let start = remembered.as_deref().map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| export_dir(&data_home.0));
    let title = strings.0.t("backup.dialog.destination");
    let picked = ask_for_folder(&app, &start, &title).await;
    dialog_still_owned(&app, epoch)?;
    let Some(picked) = picked else { return Ok(None); };
    let dir = canonical_backup_destination(&picked)?;
    let destination = dir.to_str().ok_or("encrypted backup folder is not a Unicode path")?.to_string();
    projects::update_settings_checked(&data_home.0, |settings| {
        canonical_backup_destination(&dir)?;
        dialog_still_owned(&app, epoch)?;
        settings.encrypted_backup_dir = Some(destination.clone());
        Ok(())
    })?;
    Ok(Some(destination))
}

#[command_boundary::command]
pub(crate) async fn encrypted_key_generate(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
) -> Result<Option<crate::encrypted_archive::KeyInfo>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let dir = export_dir(&data_home.0);
    fs::create_dir_all(&dir).map_err(|e| format!("key destination unavailable: {e}"))?;
    let dialog = SaveDialog { title: KEY_SAVE_DIALOG_TITLE, filter_label: "Recovery key", extensions: &["txt"], default_name: "recovery-key.txt".into() };
    let Some(dest) = ask_for_export_path(&app, &dir, &dialog).await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    crate::encrypted_archive::generate_key(&dest).map(Some)
}

#[command_boundary::command]
pub(crate) async fn encrypted_archive_create(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    expected_generation: u64,
) -> Result<Option<crate::encrypted_archive::ArchiveInfo>, String> {
    let (source, generation) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != expected_generation {
            return Err("the open project changed before encrypting".into());
        }
        (project.path.clone(), project.generation)
    };
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let dir = encrypted_backup_start(&data_home.0)?;
    let key_dir = export_dir(&data_home.0);
    let Some(key_path) = ask_for_named_open(&app, &key_dir, KEY_OPEN_DIALOG_TITLE, "Recovery key", "txt").await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let key = crate::encrypted_archive::key_from_path(&key_path)?;
    if !dir.is_dir() {
        return Err("encrypted backup folder unavailable; reconnect it or choose another folder".into());
    }
    let dialog = SaveDialog { title: ENCRYPTED_SAVE_DIALOG_TITLE, filter_label: "Encrypted archive", extensions: &["age"], default_name: encrypted_archive_default_name(&dir, crate::store::now_ms()) };
    let Some(dest) = ask_for_export_path(&app, &dir, &dialog).await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        if project.generation != generation || project.path != source {
            return Err("the open project changed while choosing the archive".into());
        }
    }
    if dest == key_path { return Err("archive destination is the recovery key".into()); }
    let stage_home = data_home.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _passing = crate::recovery::PASSING.lock().map_err(|_| "backup is busy")?;
        crate::encrypted_archive::create_from_project(&source, &dest, &key, &stage_home)
    }).await.map_err(|_| "encrypted archive task failed")??;
    Ok(Some(result))
}

#[command_boundary::command]
pub(crate) async fn encrypted_archive_verify(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
) -> Result<Option<crate::encrypted_archive::ArchiveInfo>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let dir = export_dir(&data_home.0);
    let Some(cipher) = ask_for_named_open(&app, &dir, ENCRYPTED_OPEN_DIALOG_TITLE, "Encrypted archive", "age").await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let Some(key_path) = ask_for_named_open(&app, &dir, KEY_OPEN_DIALOG_TITLE, "Recovery key", "txt").await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let key = crate::encrypted_archive::key_from_path(&key_path)?;
    let info = crate::encrypted_archive::ArchiveInfo { file: cipher.file_name().unwrap_or_default().to_string_lossy().into_owned(), bytes: fs::metadata(&cipher).map_err(|_| "encrypted archive unreadable")?.len(), recipient: key.to_public().to_string(), encrypted: true };
    let stage_home = data_home.0.clone();
    tauri::async_runtime::spawn_blocking(move || crate::encrypted_archive::verify(&cipher, &key, &stage_home))
        .await.map_err(|_| "encrypted archive verification task failed")??;
    Ok(Some(info))
}

#[command_boundary::command]
pub(crate) async fn encrypted_archive_restore(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
) -> Result<Option<crate::projects::ProjectSummary>, String> {
    let epoch = dialog_epoch(&app);
    dialog_still_owned(&app, epoch)?;
    let dir = export_dir(&data_home.0);
    let Some(cipher) = ask_for_named_open(&app, &dir, ENCRYPTED_OPEN_DIALOG_TITLE, "Encrypted archive", "age").await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let Some(key_path) = ask_for_named_open(&app, &dir, KEY_OPEN_DIALOG_TITLE, "Recovery key", "txt").await else { return Ok(None); };
    dialog_still_owned(&app, epoch)?;
    let key = crate::encrypted_archive::key_from_path(&key_path)?;
    let library = new_book_dir(&data_home.0)?;
    let stage_home = data_home.0.clone();
    let destination = library.clone();
    let result = tauri::async_runtime::spawn_blocking(move ||
        crate::encrypted_archive::restore(&cipher, &key, &library, "recovered", crate::store::now_ms(), &stage_home))
        .await.map_err(|_| "encrypted archive restore task failed")??;
    Ok(Some(crate::book_registration::remember(&data_home.0, &destination, result)))
}

/// Ask the writer which FOLDER a new book should live in.
///
/// `pick_folder` is `pick_file`'s sibling and takes the same callback shape --
/// and the same hard-won note applies: the BLOCKING form never opens a window
/// at all from a synchronous command, because the command thread parks forever
/// while the GTK loop it needs is the one it is blocking.
async fn ask_for_book_folder(app: &tauri::AppHandle, dir: &Path) -> Option<PathBuf> {
    ask_for_folder(app, dir, FOLDER_DIALOG_TITLE).await
}

async fn ask_for_folder(app: &tauri::AppHandle, dir: &Path, title: &str) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    { crate::privacy_native::pick(app, gtk::FileChooserAction::SelectFolder, title.into(), dir.to_path_buf(), None, None).await }
    #[cfg(windows)]
    { crate::privacy_windows::pick(app, crate::privacy_windows::PickAction::Folder, title.into(), dir.to_path_buf(), None, None).await }
    #[cfg(target_os = "macos")]
    {

    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title(title)
        .set_directory(dir)
        .pick_folder(move |picked| {
            let _ = tx.blocking_send(picked);
        });
    rx.recv().await.flatten().and_then(|p| p.into_path().ok())

    }
}

/// Create a book in a folder the WRITER picks, through the operating system's
/// own folder dialog.
///
/// THE PAGE NAMES NO PATH, which is the property `may_open` exists to protect
/// and which this slice widens the gate without weakening. The writer chooses
/// the folder in the host; the host creates the book there and records it; the
/// page is told where it landed afterwards.
///
/// `Ok(None)` is the writer cancelling, and it is an ANSWER rather than a
/// failure: it must raise no notice, latch no banner and report no error.
#[command_boundary::command]
pub(crate) async fn project_create_pick(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
    strings: State<'_, HostStrings>,
    name: String,
) -> std::result::Result<Option<projects::ProjectSummary>, String> {
    let start = new_book_dir(&data_home.0)?;
    fs::create_dir_all(&start).map_err(|e| format!("{}: {e}", start.display()))?;
    let Some(dir) = ask_for_book_folder(&app, &start).await else {
        return Ok(None);
    };
    create_into_dir(&data_home.0, &dir, &name, &strings.0).map(Some)
}

/// Move the OPEN book into a folder the writer picks, through the operating
/// system's folder dialog. The file keeps its name (`projects::move_target`
/// says why); the pictures folder beside it goes with it; the recovery
/// directory, the archives and the mirror are keyed by book identity and do not
/// move because they do not need to.
///
/// THE STORE IS CLOSED FOR THE MOVE and reopened at the new path, under the
/// store mutex the whole way, so no command sees the book half-moved: a flush
/// that arrives meanwhile waits on the lock and lands in the reopened store,
/// which is the same book at the same revisions -- the generation is kept for
/// exactly that reason. Failed moves attempt an exclusive rollback. A blocked
/// rollback reports every retained component and leaves a split book closed;
/// only the original book may be reopened.
///
/// `Ok(None)` is the writer cancelling, an answer rather than a failure.
#[command_boundary::command]
pub(crate) async fn project_move(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    explicit: State<'_, ExplicitProject>,
    passing: State<'_, crate::MirrorPassing>,
) -> std::result::Result<Option<projects::ProjectSummary>, String> {
    // Taken and dropped before the dialog, for `project_export_as`'s reason.
    let from = {
        let guard = locked(&state);
        open_project(&guard)?.path.clone()
    };
    let start = match from.parent() {
        Some(p) => p.to_path_buf(),
        None => new_book_dir(&data_home.0)?,
    };
    let Some(dir) = ask_for_folder(&app, &start, MOVE_DIALOG_TITLE).await else {
        return Ok(None);
    };
    let to = projects::move_target(&from, &dir)?;

    let _mirror = passing
        .0
        .lock()
        .map_err(|_| "the readable folder is busy")?;
    let _recovery = crate::recovery::PASSING
        .lock()
        .map_err(|_| "recovery is busy")?;
    if explicit.0.is_none() {
        projects::read_settings_checked(&data_home.0)?;
    }
    let mut guard = locked(&state);
    let project = guard.take().ok_or(NO_PROJECT)?;
    if project.path != from {
        // The writer switched books while the dialog stood open. The book they
        // chose a folder for is not the one that is open; move nothing.
        *guard = Some(project);
        return Err(format!(
            "{}: a different book was opened while the folder was being chosen",
            from.display()
        ));
    }
    let OpenProject {
        store,
        name,
        book_id,
        generation,
        registry_home,
        analytics,
        tracking_on,
        ..
    } = project;
    let _ = store.checkpoint();
    drop(store);

    if let Err(e) = projects::move_book_files(&from, &to) {
        *guard = Some(reopen_after_move_error(
            &e,
            &name,
            generation,
            registry_home.as_deref(),
            analytics.clone(),
            tracking_on,
            &book_id,
        )?);
        return Err(e.to_string());
    }
    match reopen(
        &to,
        &name,
        generation,
        registry_home.as_deref(),
        analytics.clone(),
        tracking_on,
        &book_id,
    ) {
        Ok(reopened) => *guard = Some(reopened),
        Err(e) => {
            // Try an exclusive move back. A failed rollback reports all
            // retained components and permits reopening only a complete book.
            match projects::move_book_files(&to, &from) {
                Ok(()) => {
                    *guard = Some(reopen(
                        &from,
                        &name,
                        generation,
                        registry_home.as_deref(),
                        analytics,
                        tracking_on,
                        &book_id,
                    )?);
                    return Err(format!(
                        "{}: could not be opened after the move, so it was moved back: {e}",
                        to.display()
                    ));
                }
                Err(back) => {
                    let recovered = reopen_after_move_error(
                        &back,
                        &name,
                        generation,
                        registry_home.as_deref(),
                        analytics,
                        tracking_on,
                        &book_id,
                    )
                    .map_err(|recovery| {
                        format!("could not open the book after its move: {e}. {recovery}")
                    })?;
                    let retained = recovered.path.clone();
                    *guard = Some(recovered);
                    projects::record_move_checked(&data_home.0, &from, &retained, explicit.0.is_none())
                        .map_err(|registry| format!("could not open the book after its move: {e}. {back}. The book was reopened at {}, but its saved location could not be updated: {registry}", retained.display()))?;
                    return Err(format!("could not open the book after its move: {e}. {back}. The book was reopened at {}", retained.display()));
                }
            }
        }
    }
    projects::record_move_checked(&data_home.0, &from, &to, explicit.0.is_none())
        .map_err(|error| format!("the book moved to {}, but its saved location could not be updated: {error}. Reopen it from its new location", to.display()))?;
    drop(guard);
    Ok(Some(projects::summarize(&to)))
}

fn reopen_after_move_error(
    error: &projects::MoveBookError,
    name: &str,
    generation: u64,
    registry_home: Option<&Path>,
    analytics: Option<crate::store::analytics::Runtime>,
    tracking_on: bool,
    book_id: &str,
) -> Result<OpenProject, String> {
    let path = error
        .reopen_at
        .as_deref()
        .ok_or_else(|| error.to_string())?;
    reopen(
        path,
        name,
        generation,
        registry_home,
        analytics,
        tracking_on,
        book_id,
    )
    .map_err(|recovery| format!("{error}. The book could not be reopened: {recovery}"))
}

/// The open state `project_open` builds, rebuilt for a book that changed path
/// and nothing else: same name, same generation.
fn reopen(
    path: &Path,
    name: &str,
    generation: u64,
    registry_home: Option<&Path>,
    analytics: Option<crate::store::analytics::Runtime>,
    tracking_on: bool,
    book_id: &str,
) -> std::result::Result<OpenProject, String> {
    // Reject a replacement file before any writable open or migration.
    let existing =
        store::Store::open_readonly(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if crate::project_book_id(&existing)? != book_id {
        return Err(format!(
            "{}: a different book is now at this location",
            path.display()
        ));
    }
    drop(existing);
    let store = projects::open_existing_for_writing(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if crate::project_book_id(&store)? != book_id {
        return Err(format!(
            "{}: a different book is now at this location",
            path.display()
        ));
    }
    let words = store
        .word_index()
        .map_err(|e| format!("{}: cannot count the project: {e}", path.display()))?;
    let excluded = store
        .items()
        .map(|items| store::excluded_from_book(&items))
        .unwrap_or_default();
    Ok(OpenProject {
        book_id: crate::project_book_id(&store)?,
        registry_home: registry_home.map(Path::to_path_buf),
        store,
        path: path.to_path_buf(),
        name: name.to_string(),
        generation,
        words,
        excluded,
        analytics,
        tracking_on,
    })
}

/// Export to a destination the WRITER chooses, through the operating system's
/// own save dialog.
///
/// TAKES NO ARGUMENT FROM THE PAGE, exactly as `project_export` does, and this
/// does NOT reverse that decision. The export slice declined a destination
/// argument because a path named by the WEBVIEW would be the first outbound
/// crossing of the `may_open`/`in_library` line — a write, to a destination
/// chosen by the page holding the manuscript. A host-side OS dialog is the
/// opposite: the user chooses the path, in the host, and nothing crosses from
/// the page. The dialog plugin is called from Rust and no `dialog:` capability
/// is granted, so `plugin:dialog|save` is not reachable from the webview at all.
///
/// `Ok(None)` is the writer cancelling, and it is an ANSWER rather than a
/// failure: it must raise no notice, latch no banner and report no error. They
/// did exactly what they intended.
///
/// `format` IS AN ARGUMENT AND IT IS NOT A CROSSING. It is a word out of a
/// narrow enum this build owns (`export::Format::from_id`), and a word this
/// build has no renderer for is REFUSED here rather than defaulted -- writing
/// Markdown for a request naming something else would report a format the file
/// does not have. What the export slice refused was a PATH the webview
/// composed; nothing about that decision is weakened by naming which of two
/// renderers to run.
#[command_boundary::command]
pub(crate) async fn project_export_as(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    format: String,
) -> std::result::Result<Option<ExportResult>, String> {
    let format = Format::from_id(&format)
        .ok_or_else(|| format!("{format:?} is not a format this build writes"))?;
    // The guard is taken and dropped BEFORE the dialog opens. Holding it across
    // the await would hold the store mutex — and therefore block every
    // `doc_flush`, which is on the writer's keystroke budget — for as long as
    // someone stands there deciding on a filename.
    let (path, name) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (project.path.clone(), project.name.clone())
    };

    // Read before the dialog opens: an unreadable vault must stop the export,
    // and asking a writer for a filename first and refusing afterwards would
    // waste the one decision they were asked to make.
    let vault = crate::commands::export::vault_for(&data_home.0)?;
    let strings = crate::commands::export::strings_for(&data_home.0);

    let dir = export_dir(&data_home.0);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let dialog = export_save_dialog(&name, format);
    let Some(dest) = ask_for_export_path(&app, &dir, &dialog).await else {
        return Ok(None);
    };
    // THE ONE FORMAT WHOSE RENDER IS NOT THE FILE. `pdf::proof_document` answers
    // with HTML; the PDF is what a web engine makes of it, and the web engine
    // needs the platform webview's UI thread. Everything below the conversion -- the sibling
    // temp file, the rename over the writer's existing file, the reclaim -- is
    // `export_into`'s and is unchanged, which is why this goes through
    // `export_into_with` rather than writing a file of its own. The printer's
    // own scratch file is not the destination and never becomes it.
    #[cfg(target_os = "linux")]
    if format == Format::Pdf {
        let page = {
            let store = crate::store::Store::open_readonly(&path).map_err(|e| e.to_string())?;
            let design = crate::design::design_of(&store)?;
            (design.page.width_um, design.page.height_um)
        };
        let scratch = tempfile::Builder::new()
            .prefix("proof")
            .suffix(".pdf")
            .tempfile()
            .map_err(|e| e.to_string())?;
        let scratch_path = scratch.path().to_path_buf();
        let app = app.clone();
        return crate::commands::export::export_into_with(
            &path,
            &name,
            &dest,
            Dest::Replace,
            format,
            &vault,
            strings,
            move |html| {
                let text = String::from_utf8(html).map_err(|e| e.to_string())?;
                let printed = crate::printer::render_via(&app, &text, Some(&scratch_path), page)?;
                printed
                    .bytes
                    .ok_or_else(|| "the proof produced no file".to_string())
            },
        )
        .map(Some);
    }
    #[cfg(windows)]
    if format == Format::Pdf {
        let page = {
            let store = crate::store::Store::open_readonly(&path).map_err(|e| e.to_string())?;
            let design = crate::design::design_of(&store)?;
            (design.page.width_um, design.page.height_um)
        };
        let app = app.clone();
        return crate::commands::export::export_into_with(
            &path,
            &name,
            &dest,
            Dest::Replace,
            format,
            &vault,
            strings,
            move |html| {
                let text = String::from_utf8(html).map_err(|e| e.to_string())?;
                crate::printer_windows::render_via(&app, &text, true, page)?
                    .bytes
                    .ok_or_else(|| "the proof produced no file".to_string())
            },
        )
        .map(Some);
    }
    export_into(&path, &name, &dest, Dest::Replace, format, &vault, strings).map(Some)
}

/// Put the statistics file the PAGE composed where the writer chooses.
///
/// The text arrives from the webview and the path does not. The figures exist
/// only in the page (it holds the tree the counts roll up through), so the
/// bytes have to come from there; the destination is the host's, through the
/// OS dialog, exactly as for a manuscript. `replace_file` is the manuscript's
/// own write, so a statistics file gets the same sibling-temp-and-rename
/// safety rather than a second, weaker one.
#[command_boundary::command]
pub(crate) async fn statistics_export_as(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    kind: String,
    text: String,
) -> std::result::Result<Option<StatisticsWritten>, String> {
    let kind = StatisticsKind::from_id(&kind)
        .ok_or_else(|| format!("{kind:?} is not a statistics file this build writes"))?;
    // Taken and dropped before the dialog, for `project_export_as`'s reason.
    let name = {
        let guard = locked(&state);
        open_project(&guard)?.name.clone()
    };
    let dir = export_dir(&data_home.0);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let dialog = statistics_save_dialog(&name, kind);
    let Some(dest) = ask_for_export_path(&app, &dir, &dialog).await else {
        return Ok(None);
    };
    replace_file(&dest, text.as_bytes())?;
    Ok(Some(StatisticsWritten {
        path: dest.to_string_lossy().into_owned(),
    }))
}

#[derive(serde::Serialize)]
pub(crate) struct StatisticsWritten {
    pub(crate) path: String,
}

/// Import a manuscript the WRITER picks, through the operating system's own open
/// dialog. Creates a NEW project, exactly as the drop-folder route does, and
/// never merges into the open one.
///
/// `project_import`'s bare-filename rule is NOT relaxed by this existing. That
/// rule governs a path the PAGE names; this path is named by the writer in the
/// host, so there is nothing for it to constrain.
#[command_boundary::command]
pub(crate) async fn project_import_pick(
    app: tauri::AppHandle,
    data_home: State<'_, DataHome>,
    strings: State<'_, HostStrings>,
) -> std::result::Result<Option<crate::ImportOutcome>, String> {
    let dir = imports_dir(&data_home.0);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let Some(source) = ask_for_import_path(&app, &dir).await else {
        return Ok(None);
    };
    // Into the same remembered folder `project_create` uses, not the hidden
    // library (159's open decision, `project_import`'s reason restated).
    let dest = new_book_dir(&data_home.0)?;
    import_path(&data_home.0, &dest, &source, &strings.0).map(Some)
}

/// Ask the writer which picture to attach, through the operating system.
///
/// THE FILTER IS A CONVENIENCE AND NOT THE CHECK. It narrows what the dialog
/// offers; what decides whether a file is a picture is
/// `pictures::attach`'s sniff of the CONTENT, because a filter keyed on an
/// extension is exactly the thing this slice must not trust.
async fn ask_for_picture_path(app: &tauri::AppHandle, dir: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    { crate::privacy_native::pick(app, gtk::FileChooserAction::Open, PICTURE_DIALOG_TITLE.into(), dir.to_path_buf(), None, Some(("Pictures".into(), vec!["png".into(), "jpg".into(), "jpeg".into()]))).await }
    #[cfg(windows)]
    { crate::privacy_windows::pick(app, crate::privacy_windows::PickAction::Open, PICTURE_DIALOG_TITLE.into(), dir.to_path_buf(), None, Some(("Pictures".into(), vec!["png".into(), "jpg".into(), "jpeg".into()]))).await }
    #[cfg(target_os = "macos")]
    {

    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title(PICTURE_DIALOG_TITLE)
        .set_directory(dir)
        .add_filter("Pictures", &["png", "jpg", "jpeg"])
        .pick_file(move |picked| {
            let _ = tx.blocking_send(picked);
        });
    rx.recv().await.flatten().and_then(|p| p.into_path().ok())

    }
}

// A chooser belongs to the opening instance, including reopening the same path.
struct PictureOwner {
    path: PathBuf,
    generation: u64,
    privacy_epoch: u64,
}

impl PictureOwner {
    fn capture(project: &OpenProject, app: &tauri::AppHandle) -> Self {
        Self {
            path: project.path.clone(),
            generation: project.generation,
            privacy_epoch: app.state::<crate::privacy_host::Epoch>().0.load(std::sync::atomic::Ordering::SeqCst),
        }
    }

    fn check<'a>(&self, project: Option<&'a OpenProject>, epoch: u64, concealed: bool) -> Result<&'a OpenProject, String> {
        if concealed || epoch != self.privacy_epoch {
            return Err("picture selection was interrupted by privacy locking".into());
        }
        match project {
            Some(project) if project.path == self.path && project.generation == self.generation => Ok(project),
            _ => Err("picture selection belongs to a book that is no longer open".into()),
        }
    }

    fn check_app<'a>(&self, project: Option<&'a OpenProject>, app: &tauri::AppHandle) -> Result<&'a OpenProject, String> {
        self.check(project,
            app.state::<crate::privacy_host::Epoch>().0.load(std::sync::atomic::Ordering::SeqCst),
            crate::privacy_host::locked(app))
    }
}

// Cleanup owns only this call's fresh filename. A successful row update must
// not be undone merely because a subsequent thumbnail/read response fails.
fn commit_picked_picture<T>(
    owner: &PictureOwner,
    project: Result<&OpenProject, String>,
    stored: &str,
    write: impl FnOnce(&OpenProject) -> Result<(Option<String>, T), String>,
) -> Result<T, String> {
    let dir = crate::pictures::dir_for(&owner.path);
    match project.and_then(write) {
        Ok((previous, value)) => {
            if let Some(previous) = previous { crate::pictures::remove(&dir, &previous); }
            Ok(value)
        }
        Err(error) => {
            crate::pictures::remove(&dir, stored);
            Err(error)
        }
    }
}

/// Attach a picture the WRITER picks, through the operating system's own open
/// dialog.
///
/// THE PAGE NAMES NO PATH, in either direction. It sends a member id; the writer
/// chooses a file in the host; the host copies it under a uuid it generated and
/// stores that name. So `picture_path` can never hold a path the webview
/// composed, and there is nothing inbound for a traversal rule to guard --
/// `project_export_as`'s argument, on a value that goes into the database rather
/// than onto the disk.
///
/// `Ok(None)` is the writer cancelling, and it is an ANSWER rather than a
/// failure: it must raise no notice and latch no banner.
///
/// THE STORE MUTEX IS TAKEN TWICE AND HELD ACROSS NEITHER THE DIALOG NOR THE
/// DECODE. Holding it across the dialog would block every `doc_flush` -- which
/// is on the writer's keystroke budget -- for as long as somebody stands there
/// choosing a photograph, and holding it across the decode would do the same for
/// as long as a 50-megapixel picture takes. `project_export_as`'s rule, with a
/// second reason.
#[command_boundary::command]
pub(crate) async fn cast_picture_pick(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> std::result::Result<Option<store::cast::CastMember>, String> {
    let owner = {
        let guard = locked(&state);
        PictureOwner::capture(open_project(&guard)?, &app)
    };
    let dir = crate::pictures::dir_for(&owner.path);

    // The writer's own pictures directory is where the dialog opens once there
    // is one, and their home directory before that. Never a directory this
    // application invents beside the book: a first picture comes from wherever
    // photographs live on the machine running it.
    let start = if dir.is_dir() {
        dir.clone()
    } else {
        dirs::home_dir().unwrap_or_else(|| dir.clone())
    };
    let Some(source) = ask_for_picture_path(&app, &start).await else {
        return Ok(None);
    };

    // COPIED AND THUMBNAILED BEFORE THE ROW MOVES. A row naming a file that was
    // never written is the one state this must not produce, and doing the work
    // first makes that impossible rather than unlikely.
    {
        let guard = locked(&state);
        owner.check_app(guard.as_ref(), &app)?;
    }
    let stored = crate::pictures::attach(&dir, &source).map_err(|e| e.to_string())?;

    let guard = locked(&state);
    commit_picked_picture(&owner, owner.check_app(guard.as_ref(), &app), &stored, |project| {
        project.store.cast_set_picture(&id, Some(&stored)).map_err(|error| error.to_string())
    }).map(Some)
}

/// Attach a COVER the writer picks, through the operating system's own open
/// dialog.
///
/// THE SAME DIALOG, THE SAME COPY AND THE SAME BOUNDS as a cast photograph --
/// `ask_for_picture_path` and `pictures::attach`, not a second route. A cover is
/// not a different kind of file and the three refusals that protect the host
/// from one protect it from the other; a second attach path would be a second
/// place to forget the pixel ceiling.
///
/// `Ok(None)` is the writer cancelling, and it is an ANSWER rather than a
/// failure: `project_export_as`'s rule.
///
/// THE STORE MUTEX IS TAKEN TWICE AND HELD ACROSS NEITHER THE DIALOG NOR THE
/// DECODE, exactly as `cast_picture_pick` does and for both of its reasons: a
/// held mutex blocks every `doc_flush`, which is on the writer's keystroke
/// budget, and a writer choosing a cover may stand there for a minute.
#[command_boundary::command]
pub(crate) async fn covers_pick(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    side: String,
) -> std::result::Result<Option<crate::commands::covers::CoversView>, String> {
    // REFUSED BEFORE THE DIALOG OPENS, not after the file is copied: a writer
    // who chose a picture must not be told afterwards that the side this build
    // was asked for does not exist, with a file already written for it.
    crate::covers::key_for(&side)
        .ok_or_else(|| format!("{side:?} is not a cover this book has"))?;

    let owner = {
        let guard = locked(&state);
        PictureOwner::capture(open_project(&guard)?, &app)
    };
    let dir = crate::pictures::dir_for(&owner.path);
    let start = if dir.is_dir() {
        dir.clone()
    } else {
        dirs::home_dir().unwrap_or_else(|| dir.clone())
    };
    let Some(source) = ask_for_picture_path(&app, &start).await else {
        return Ok(None);
    };

    // COPIED AND THUMBNAILED BEFORE THE ROW MOVES, `cast_picture_pick`'s rule: a
    // row naming a file that was never written is the one state this must not
    // produce, and doing the work first makes that impossible rather than
    // unlikely.
    {
        let guard = locked(&state);
        owner.check_app(guard.as_ref(), &app)?;
    }
    let stored = crate::pictures::attach(&dir, &source).map_err(|e| e.to_string())?;

    let guard = locked(&state);
    let project = owner.check_app(guard.as_ref(), &app);
    commit_picked_picture(&owner, project, &stored, |project| {
        crate::covers::set_cover(&project.store, &side, &stored).map(|previous| (previous, ()))
    })?;
    crate::commands::covers::read_covers(open_project(&guard)?).map(Some)
}

#[cfg(test)]
mod tests {
    #[test]
    fn encrypted_backup_destination_requires_an_existing_absolute_directory() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("backups");
        assert!(super::canonical_backup_destination(&folder).is_err());
        assert!(!folder.exists());
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(super::canonical_backup_destination(&folder).unwrap(), std::fs::canonicalize(&folder).unwrap());
        let file = root.path().join("file");
        std::fs::write(&file, "existing").unwrap();
        assert!(super::canonical_backup_destination(&file).is_err());
        assert!(super::canonical_backup_destination(std::path::Path::new(".")).is_err());
    }

    #[test]
    fn encrypted_backup_start_never_recreates_or_falls_back_from_a_missing_destination() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("unmounted/backups");
        crate::projects::update_settings(root.path(), |settings| {
            settings.encrypted_backup_dir = Some(missing.to_string_lossy().into_owned());
        }).unwrap();
        assert!(super::encrypted_backup_start(root.path()).is_err());
        assert!(!missing.exists());
        assert!(!crate::export_dir(root.path()).exists());
        let valid = root.path().join("backups");
        std::fs::create_dir(&valid).unwrap();
        crate::projects::update_settings(root.path(), |settings| {
            settings.encrypted_backup_dir = Some(valid.to_string_lossy().into_owned());
        }).unwrap();
        assert_eq!(super::encrypted_backup_start(root.path()).unwrap(), std::fs::canonicalize(valid).unwrap());
    }

    #[test]
    fn encrypted_archive_default_name_is_dated_and_skips_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let first = super::encrypted_archive_default_name(root.path(), 123);
        assert_eq!(first, "archive-1970-01-01T00-00-00.123Z.age");
        std::fs::write(root.path().join(&first), "existing").unwrap();
        let second = super::encrypted_archive_default_name(root.path(), 123);
        assert_eq!(second, "archive-1970-01-01T00-00-00.123Z-2.age");
        std::fs::write(root.path().join(&second), "existing").unwrap();
        assert_eq!(super::encrypted_archive_default_name(root.path(), 123), "archive-1970-01-01T00-00-00.123Z-3.age");
        assert_ne!(super::encrypted_archive_default_name(root.path(), 124), first);
    }

    use super::{export_save_dialog, EXPORT_DIALOG_TITLE};
    use crate::export::Format;

    fn picture_project(path: std::path::PathBuf, generation: u64) -> crate::OpenProject {
        let store = crate::store::Store::open(&path).unwrap();
        crate::OpenProject {
            book_id: crate::project_book_id(&store).unwrap(),
            registry_home: None,
            words: store.word_index().unwrap(),
            excluded: Default::default(),
            store, path, name: "Book".into(), generation,
            analytics: None, tracking_on: false,
        }
    }

    #[test]
    fn move_recovery_reopens_only_the_original_book_and_keeps_its_generation() {
        let temp = tempfile::tempdir().unwrap();
        let project = picture_project(temp.path().join("original.db"), 31);
        let path = project.path.clone();
        let id = project.book_id.clone();
        project.store.checkpoint().unwrap();
        drop(project);
        let missing_destination = temp.path().join("absent").join("original.db");
        let failure = crate::projects::move_book_files(&path, &missing_destination).unwrap_err();
        let reopened =
            super::reopen_after_move_error(&failure, "Book", 31, None, None, false, &id).unwrap();
        assert_eq!(reopened.path, path);
        assert_eq!(reopened.generation, 31);
        assert_eq!(reopened.book_id, id);
        drop(reopened);
        let replacement = picture_project(temp.path().join("replacement.db"), 41);
        replacement.store.checkpoint().unwrap();
        let replacement_path = replacement.path.clone();
        drop(replacement);
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(replacement_path, &path).unwrap();
        let before = std::fs::read(&path).unwrap();
        let error = super::reopen_after_move_error(&failure, "Book", 31, None, None, false, &id)
            .err()
            .unwrap();
        assert!(error.contains("a different book"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn move_recovery_leaves_a_split_book_closed() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let project = picture_project(a.path().join("original.db"), 31);
        let path = project.path.clone();
        let id = project.book_id.clone();
        project.store.checkpoint().unwrap();
        drop(project);
        let pictures = crate::pictures::dir_for(&path);
        std::fs::create_dir(&pictures).unwrap();
        std::fs::write(pictures.join("original"), b"retained picture").unwrap();
        let to = crate::projects::move_target(&path, b.path()).unwrap();
        let failure = crate::projects::move_book_files_with(&path, &to, |source, destination| {
            if source == pictures {
                let replacement = picture_project(path.clone(), 41);
                replacement.store.checkpoint().unwrap();
                drop(replacement);
                std::fs::create_dir(crate::pictures::dir_for(&to)).unwrap();
                return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
            }
            crate::projects::rename_without_replace(source, destination)
        })
        .unwrap_err();
        let before = std::fs::read(&path).unwrap();
        let error = super::reopen_after_move_error(&failure, "Book", 31, None, None, false, &id)
            .err()
            .unwrap();
        assert!(error.contains("left closed"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            std::fs::read(pictures.join("original")).unwrap(),
            b"retained picture"
        );
        assert!(to.is_file());
    }

    #[test]
    fn stale_picture_picker_never_mutates_another_book_and_cleans_only_its_new_copy() {
        let temp = tempfile::tempdir().unwrap();
        let original = picture_project(temp.path().join("original.db"), 3);
        let other = picture_project(temp.path().join("other.db"), 3);
        let owner = super::PictureOwner { path: original.path.clone(), generation: 3, privacy_epoch: 9 };
        let dir = crate::pictures::dir_for(&original.path);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("previous.png"), b"previous").unwrap();
        crate::covers::set_cover(&other.store, "front", "other.png").unwrap();
        for (project, epoch, concealed) in [(Some(&other), 9, false), (None, 9, false), (Some(&original), 10, false), (Some(&original), 9, true)] {
            std::fs::write(dir.join("picked.png"), b"new copy").unwrap();
            let result = super::commit_picked_picture(&owner, owner.check(project, epoch, concealed), "picked.png", |project| {
                crate::covers::set_cover(&project.store, "front", "picked.png").map(|old| (old, ()))
            });
            assert!(result.is_err());
            assert!(!dir.join("picked.png").exists());
            assert_eq!(std::fs::read(dir.join("previous.png")).unwrap(), b"previous");
            assert_eq!(crate::covers::cover_of(&other.store, "front").unwrap().as_deref(), Some("other.png"));
            assert_eq!(crate::covers::cover_of(&original.store, "front").unwrap(), None);
        }
        let mut reopened = original;
        reopened.generation = 4;
        assert!(owner.check(Some(&reopened), 9, false).is_err(), "reopening the same path retires its old picker");
    }

    #[test]
    fn matching_picture_picker_updates_the_row_before_removing_the_previous_original() {
        let temp = tempfile::tempdir().unwrap();
        let project = picture_project(temp.path().join("book.db"), 3);
        let owner = super::PictureOwner { path: project.path.clone(), generation: 3, privacy_epoch: 9 };
        let dir = crate::pictures::dir_for(&project.path);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("previous.png"), b"previous").unwrap();
        std::fs::write(dir.join("picked.png"), b"new copy").unwrap();
        crate::covers::set_cover(&project.store, "front", "previous.png").unwrap();
        super::commit_picked_picture(&owner, owner.check(Some(&project), 9, false), "picked.png", |project| {
            assert!(dir.join("previous.png").exists());
            crate::covers::set_cover(&project.store, "front", "picked.png").map(|old| (old, ()))
        }).unwrap();
        assert_eq!(crate::covers::cover_of(&project.store, "front").unwrap().as_deref(), Some("picked.png"));
        assert_eq!(std::fs::read(dir.join("picked.png")).unwrap(), b"new copy");
        assert!(!dir.join("previous.png").exists());
        std::fs::write(dir.join("failed.png"), b"failed new copy").unwrap();
        let result: Result<(), String> = super::commit_picked_picture(&owner, owner.check(Some(&project), 9, false), "failed.png", |_| Err("write failed".into()));
        assert!(result.is_err());
        assert!(!dir.join("failed.png").exists());
        assert!(dir.join("picked.png").exists());
    }

    #[test]
    fn the_markdown_save_dialog_offers_markdown_and_nothing_else() {
        let dialog = export_save_dialog("The Harbour", Format::Markdown);
        // The whole value, field by field. `dialog-cli` finds the window by the
        // title and a writer picks the file by the filter, and neither is
        // reachable from any other test in this crate.
        assert_eq!(dialog.title, "Export manuscript");
        assert_eq!(dialog.filter_label, "Markdown");
        assert_eq!(dialog.extensions, &["md"]);
        assert_eq!(dialog.default_name, "the-harbour.md");
    }

    #[test]
    fn the_title_is_the_one_the_rig_locates_the_window_by() {
        // Restated by `app/harness/src/dialog-cli.ts`. A rename here that the
        // rig did not learn about turns a graded dialog run into "no dialog
        // appeared", which reads as a broken feature rather than a renamed one.
        assert_eq!(EXPORT_DIALOG_TITLE, "Export manuscript");
    }

    #[test]
    fn the_default_name_ends_in_the_formats_own_extension() {
        // The filename and the reported format come from ONE answer, so a file
        // called `.md` holding something else is not constructible here.
        let dialog = export_save_dialog("The Harbour", Format::Markdown);
        assert!(
            dialog
                .default_name
                .ends_with(&format!(".{}", Format::Markdown.extension())),
            "{}",
            dialog.default_name
        );
    }

    #[test]
    fn a_name_that_slugifies_to_nothing_still_gets_a_findable_filename() {
        // `export_slug`'s fallback, seen through the dialog: a name field
        // pre-filled with `.md` is a hidden file with no name.
        let dialog = export_save_dialog("***", Format::Markdown);
        assert_eq!(dialog.default_name, "manuscript.md");
    }

    #[test]
    fn the_statistics_dialog_names_the_kind_and_not_the_manuscript() {
        use super::{statistics_save_dialog, StatisticsKind};
        let csv = statistics_save_dialog("The Harbour", StatisticsKind::Csv);
        assert_eq!(csv.title, "Export statistics");
        assert_eq!(csv.filter_label, "CSV");
        assert_eq!(csv.extensions, &["csv"]);
        assert_eq!(csv.default_name, "the-harbour-statistics.csv");
        let json = statistics_save_dialog("***", StatisticsKind::Json);
        assert_eq!(json.filter_label, "JSON");
        assert_eq!(json.extensions, &["json"]);
        assert_eq!(json.default_name, "manuscript-statistics.json");
    }

    #[test]
    fn the_import_dialogs_filter_accepts_markdown_and_docx() {
        // Decision 8's own dialog surface: one filter naming both formats,
        // since `import_path` sniffs the content and the writer is picking
        // a manuscript rather than deciding its format.
        use super::{IMPORT_FILTER_EXTENSIONS, IMPORT_FILTER_LABEL};
        assert_eq!(IMPORT_FILTER_LABEL, "Manuscripts");
        assert_eq!(IMPORT_FILTER_EXTENSIONS, &["md", "docx"]);
    }

    #[test]
    fn a_kind_the_build_does_not_write_is_refused_by_name() {
        use super::StatisticsKind;
        assert_eq!(StatisticsKind::from_id("csv"), Some(StatisticsKind::Csv));
        assert_eq!(StatisticsKind::from_id("json"), Some(StatisticsKind::Json));
        assert_eq!(StatisticsKind::from_id("xlsx"), None);
        assert_eq!(StatisticsKind::from_id("CSV"), None);
    }
}
