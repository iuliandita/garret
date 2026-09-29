//! A page token selects one host-owned review copy or plan, never a page-supplied path or body.
use super::dialogs::{ask_for_export_path, ask_for_named_open, SaveDialog};
use crate::review_document::{FragmentToken, ReviewHunk};
use crate::review_docx::{self, Manifest, OldDecision, ReviewPackage, ReviewPlan};
use crate::store::review::{ReviewAuthorChoice, ReviewReturnAuthors};
use crate::{
    locked, open_project, open_project_mut, privacy_host, DataHome, MirrorDirty, OpenProject,
    StoreState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
};
use tauri::{Emitter, Manager, State};

const MAX_FILE: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Pending(Mutex<Option<Ticket>>);
struct Ticket {
    token: String,
    generation: u64,
    epoch: u64,
    item_id: String,
    operation: Operation,
}
enum Operation {
    Preparing,
    Export(ReviewPackage),
    Return(ReviewPlan),
    Saving(ReviewPackage),
}

impl Pending {
    fn begin(&self, generation: u64, epoch: u64, item_id: String) -> Result<String, String> {
        let mut slot = self.0.lock().map_err(|_| "review preview unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|t| matches!(t.operation, Operation::Preparing | Operation::Saving(_)))
        {
            return Err("a review file operation is already running".into());
        }
        let token = uuid::Uuid::now_v7().to_string();
        *slot = Some(Ticket {
            token: token.clone(),
            generation,
            epoch,
            item_id,
            operation: Operation::Preparing,
        });
        Ok(token)
    }
    fn discard(&self, token: &str) {
        if let Ok(mut slot) = self.0.lock() {
            if slot.as_ref().is_some_and(|t| t.token == token) {
                *slot = None;
            }
        }
    }
    fn install(&self, token: &str, operation: Operation) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| "review preview unavailable")?;
        let ticket = slot
            .as_mut()
            .filter(|t| t.token == token)
            .ok_or("review preview was canceled")?;
        ticket.operation = operation;
        Ok(())
    }
}
// Conceal, epoch changes and lock admission use the native main loop. Keep the
// final authority check and durable mutation in one callback, without event pumping.
async fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.blocking_send(operation(&handle));
    })
    .map_err(|_| "review operation could not reach the native window")?;
    receiver
        .recv()
        .await
        .ok_or("review operation was interrupted")?
}

fn epoch(app: &tauri::AppHandle) -> u64 {
    app.state::<privacy_host::Epoch>().0.load(Ordering::SeqCst)
}
fn access(
    app: &tauri::AppHandle,
    project: &OpenProject,
    generation: u64,
    owner_epoch: u64,
) -> Result<(), String> {
    ownership(
        project.generation,
        generation,
        epoch(app),
        owner_epoch,
        privacy_host::locked(app),
    )
}
fn ownership(
    actual_generation: u64,
    generation: u64,
    actual_epoch: u64,
    owner_epoch: u64,
    locked: bool,
) -> Result<(), String> {
    if locked || actual_epoch != owner_epoch || actual_generation != generation {
        Err("review preview expired; reopen it before continuing".into())
    } else {
        Ok(())
    }
}
fn current(project: &OpenProject, expected: &Manifest) -> Result<(), String> {
    let snapshot = project
        .store
        .review_scene_snapshot(&expected.item_id)
        .map_err(|e| e.to_string())?;
    if review_docx::manifest(&snapshot)? != *expected {
        return Err("review source changed; reopen the preview; no changes were applied".into());
    }
    Ok(())
}
fn title(project: &OpenProject, item: &str) -> Result<String, String> {
    project
        .store
        .items()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|i| i.id == item)
        .map(|i| i.title)
        .ok_or_else(|| "review scene no longer exists".into())
}
#[derive(Serialize)]
pub(crate) struct MessagePreview {
    author_name: String,
    body: String,
}
#[derive(Serialize)]
pub(crate) struct ExportPreview {
    token: String,
    item_id: String,
    scene_title: String,
    doc_rev: i64,
    authors: Vec<String>,
    messages: Vec<MessagePreview>,
}
#[derive(Serialize)]
pub(crate) struct DecisionPreview {
    hunk_id: i64,
    decision: &'static str,
    proposal_author: String,
    before: Vec<FragmentToken>,
    after: Vec<FragmentToken>,
}
#[derive(Serialize)]
pub(crate) struct HunkPreview {
    author_name: String,
    hunk: ReviewHunk,
}
#[derive(Serialize)]
pub(crate) struct NewMessagePreview {
    group_id: i64,
    author_name: String,
    body: String,
}
#[derive(Serialize)]
pub(crate) struct ReturnPreview {
    token: String,
    item_id: String,
    scene_title: String,
    doc_rev: i64,
    decisions: Vec<DecisionPreview>,
    new_hunks: Vec<HunkPreview>,
    new_messages: Vec<NewMessagePreview>,
    source_authors: Vec<String>,
}
fn returned_preview(
    token: &str,
    scene_title: String,
    plan: &ReviewPlan,
) -> Result<ReturnPreview, String> {
    let mut decisions = Vec::new();
    for decision in &plan.decisions {
        let (id, action) = match decision {
            OldDecision::Accept(id) => (*id, "accept"),
            OldDecision::Reject(id) => (*id, "reject"),
        };
        let (group, hunk) = plan
            .expected
            .groups
            .iter()
            .find_map(|g| g.hunks.iter().find(|h| h.id == id).map(|h| (g, h)))
            .ok_or("returned decision has no source proposal")?;
        decisions.push(DecisionPreview {
            hunk_id: id,
            decision: action,
            proposal_author: group.author_name.clone(),
            before: hunk.original.before.clone(),
            after: hunk.original.after.clone(),
        });
    }
    Ok(ReturnPreview {
        token: token.into(),
        item_id: plan.expected.item_id.clone(),
        scene_title,
        doc_rev: plan.expected.doc_rev,
        decisions,
        source_authors: plan
            .new_hunks
            .iter()
            .map(|h| h.author_name.clone())
            .chain(plan.new_messages.iter().map(|m| m.author_name.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        new_hunks: plan
            .new_hunks
            .iter()
            .map(|h| HunkPreview {
                author_name: h.author_name.clone(),
                hunk: h.hunk.clone(),
            })
            .collect(),
        new_messages: plan
            .new_messages
            .iter()
            .map(|m| NewMessagePreview {
                group_id: m.group_id,
                author_name: m.author_name.clone(),
                body: m.body.clone(),
            })
            .collect(),
    })
}

#[command_boundary::command]
pub(crate) fn review_export_preview(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    pending: State<'_, Pending>,
    generation: u64,
    item_id: String,
) -> Result<ExportPreview, String> {
    let owner_epoch = epoch(&app);
    let guard = locked(&state);
    let project = open_project(&guard)?;
    access(&app, project, generation, owner_epoch)?;
    let token = pending.begin(generation, owner_epoch, item_id.clone())?;
    let result = (|| {
        let snapshot = project
            .store
            .review_scene_snapshot(&item_id)
            .map_err(|e| e.to_string())?;
        let package = review_docx::export(&snapshot)?;
        if package.bytes.len() as u64 > MAX_FILE {
            return Err("review copy exceeds the file limit".into());
        }
        let preview = ExportPreview {
            token: token.clone(),
            item_id,
            scene_title: title(project, &snapshot.item_id)?,
            doc_rev: snapshot.doc_rev,
            authors: package.disclosure.authors.clone(),
            messages: package
                .disclosure
                .messages
                .iter()
                .map(|m| MessagePreview {
                    author_name: m.author_name.clone(),
                    body: m.body.clone(),
                })
                .collect(),
        };
        access(&app, project, generation, owner_epoch)?;
        pending.install(&token, Operation::Export(package))?;
        Ok(preview)
    })();
    if result.is_err() {
        pending.discard(&token);
    }
    result
}

/// Resolve the parent before appending the name, so symlinked directories cannot hide protected roots.
fn destination(dest: &Path, project: &Path, data_home: &Path) -> Result<PathBuf, String> {
    if !dest
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("docx"))
    {
        return Err("choose a DOCX filename".into());
    }
    let parent = fs::canonicalize(dest.parent().ok_or("review destination has no parent")?)
        .map_err(|e| e.to_string())?;
    let resolved = parent.join(
        dest.file_name()
            .ok_or("review destination has no filename")?,
    );
    if let Ok(meta) = fs::symlink_metadata(&resolved) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("review destination is not an ordinary file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() > 1 {
                return Err("review destination is a linked file".into());
            }
        }
    }
    let book = fs::canonicalize(project).map_err(|e| e.to_string())?;
    let protected = [
        book.clone(),
        PathBuf::from(format!("{}-wal", book.display())),
        PathBuf::from(format!("{}-shm", book.display())),
        crate::pictures::dir_for(&book),
        crate::research::dir_for(&book),
        crate::projects::recovery_dir(data_home, ""),
    ];
    for path in protected {
        let path = if path.exists() {
            fs::canonicalize(&path).map_err(|e| e.to_string())?
        } else {
            let mut ancestor = path.as_path();
            let mut names = Vec::new();
            while !ancestor.exists() {
                names.push(
                    ancestor
                        .file_name()
                        .ok_or("invalid protected path")?
                        .to_owned(),
                );
                ancestor = ancestor.parent().ok_or("invalid protected parent")?;
            }
            let mut canonical = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
            for name in names.into_iter().rev() {
                canonical.push(name);
            }
            canonical
        };
        if resolved.starts_with(path) {
            return Err(
                "review destination belongs to the active book or its recovery files".into(),
            );
        }
    }
    Ok(resolved)
}

#[command_boundary::command]
pub(crate) async fn review_export_save(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    pending: State<'_, Pending>,
    data_home: State<'_, DataHome>,
    token: String,
) -> Result<bool, String> {
    let name = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        let mut slot = pending.0.lock().map_err(|_| "review preview unavailable")?;
        let ticket = slot
            .as_mut()
            .filter(|t| t.token == token)
            .ok_or("review preview expired")?;
        access(&app, project, ticket.generation, ticket.epoch)?;
        let Operation::Export(package) = &ticket.operation else {
            return Err("review export is not ready".into());
        };
        current(project, &package.manifest)?;
        let name = title(project, &ticket.item_id)?;
        let old = std::mem::replace(&mut ticket.operation, Operation::Preparing);
        if let Operation::Export(package) = old {
            ticket.operation = Operation::Saving(package);
        }
        name
    };
    let result = async {
        let dir = crate::projects::exports_dir(&data_home.0);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let strings = privacy_host::strings(&app);
        let title = strings.t("review.transport.save");
        let label = strings.t("review.transport.filter");
        let dialog = SaveDialog {
            title: &title,
            filter_label: &label,
            extensions: &["docx"],
            default_name: format!("{}.review.docx", super::export::export_slug(&name)),
        };
        let chosen = ask_for_export_path(&app, &dir, &dialog).await;
        let (dest, stage) = {
            let guard = locked(&state);
            let project = open_project(&guard)?;
            let mut slot = pending.0.lock().map_err(|_| "review preview unavailable")?;
            let ticket = slot
                .as_mut()
                .filter(|t| t.token == token)
                .ok_or("review preview expired")?;
            access(&app, project, ticket.generation, ticket.epoch)?;
            let Operation::Saving(package) = &ticket.operation else {
                return Err("review export is not ready".into());
            };
            current(project, &package.manifest)?;
            let Some(chosen) = chosen else {
                let old = std::mem::replace(&mut ticket.operation, Operation::Preparing);
                if let Operation::Saving(package) = old {
                    ticket.operation = Operation::Export(package);
                }
                return Ok(false);
            };
            let dest = destination(&chosen, &project.path, &data_home.0)?;
            let stage = stage_copy(&dest, &package.bytes)?;
            (dest, stage)
        };
        let cleanup = stage.clone();
        let owner_token = token.clone();
        let home = data_home.0.clone();
        let publication = on_main(&app, move |app| {
            let state = app.state::<StoreState>();
            let pending = app.state::<Pending>();
            let guard = locked(&state);
            let project = open_project(&guard)?;
            let mut slot = pending.0.lock().map_err(|_| "review preview unavailable")?;
            let ticket = slot
                .as_ref()
                .filter(|t| t.token == owner_token)
                .ok_or("review preview expired")?;
            finish_copy(&stage, &dest, || {
                access(app, project, ticket.generation, ticket.epoch)?;
                let Operation::Saving(package) = &ticket.operation else {
                    return Err("review export is not ready".into());
                };
                current(project, &package.manifest)?;
                destination(&dest, &project.path, &home).map(|_| ())
            })?;
            *slot = None;
            Ok(true)
        })
        .await;
        cleanup_failed(&cleanup, publication)
    }
    .await;
    // Any failed publication requires a fresh disclosure; never retry against changed authority.
    if result.is_err() {
        pending.discard(&token);
    }
    result
}

fn stage_copy(dest: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let stage = dest.with_file_name(format!(".review-{}.stage", uuid::Uuid::now_v7()));
    super::export::replace_file(&stage, bytes)?;
    Ok(stage)
}
fn finish_copy(
    stage: &Path,
    dest: &Path,
    still_owned: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    still_owned()?;
    fs::rename(stage, dest).map_err(|e| e.to_string())
}
fn cleanup_failed<T>(stage: &Path, result: Result<T, String>) -> Result<T, String> {
    if result.is_err() {
        fs::remove_file(stage).map_err(|e| {
            format!("review publication refused; staged copy could not be removed: {e}")
        })?;
    }
    result
}

fn read_package(path: &Path) -> Result<Vec<u8>, String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > MAX_FILE {
        return Err("review source must be an ordinary file of at most 64 MiB".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000 | 0o4000);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err("review source changed or exceeds 64 MiB".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.dev() != before.dev() || meta.ino() != before.ino() {
            return Err("review source changed before reading".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("review source exceeds 64 MiB".into());
    }
    Ok(bytes)
}

#[command_boundary::command]
pub(crate) async fn review_return_preview(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    pending: State<'_, Pending>,
    data_home: State<'_, DataHome>,
    generation: u64,
    item_id: String,
) -> Result<Option<ReturnPreview>, String> {
    let owner_epoch = epoch(&app);
    let token = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        access(&app, project, generation, owner_epoch)?;
        pending.begin(generation, owner_epoch, item_id.clone())?
    };
    let result = async {
        let strings = privacy_host::strings(&app);
        let title_text = strings.t("review.transport.open");
        let label = strings.t("review.transport.filter");
        let chosen = ask_for_named_open(
            &app,
            &crate::projects::exports_dir(&data_home.0),
            &title_text,
            &label,
            "docx",
        )
        .await;
        let Some(source) = chosen else {
            return Ok(None);
        };
        let guard = locked(&state);
        let project = open_project(&guard)?;
        access(&app, project, generation, owner_epoch)?;
        let bytes = read_package(&source)?;
        let snapshot = project
            .store
            .review_scene_snapshot(&item_id)
            .map_err(|e| e.to_string())?;
        let plan = review_docx::inspect_return(&bytes, &snapshot)?;
        let preview = returned_preview(&token, title(project, &item_id)?, &plan)?;
        access(&app, project, generation, owner_epoch)?;
        pending.install(&token, Operation::Return(plan))?;
        Ok(Some(preview))
    }
    .await;
    if !matches!(&result, Ok(Some(_))) {
        pending.discard(&token);
    }
    result
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AuthorChoice {
    Existing { id: i64 },
    Create { display_name: String },
}
impl AuthorChoice {
    fn stored(self) -> ReviewAuthorChoice {
        match self {
            Self::Existing { id } => ReviewAuthorChoice::Existing(id),
            Self::Create { display_name } => ReviewAuthorChoice::Create(display_name),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceChoice {
    source_name: String,
    choice: AuthorChoice,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApplyRequest {
    token: String,
    sources: Vec<SourceChoice>,
    deciding_actor: Option<AuthorChoice>,
}
#[derive(Serialize)]
pub(crate) struct ApplyResult {
    item_id: String,
    doc_rev: i64,
    body: Option<String>,
}
fn apply_into(
    project: &mut OpenProject,
    dirty: &MirrorDirty,
    plan: &ReviewPlan,
    authors: &ReviewReturnAuthors,
) -> Result<(ApplyResult, bool), String> {
    let result = project
        .store
        .review_return_apply(plan, authors)
        .map_err(|e| e.to_string())?;
    let emit = if let Some(body) = &result.body {
        project.words.record(&result.item_id, body);
        crate::mark_mirror_dirty(dirty)
    } else {
        false
    };
    Ok((
        ApplyResult {
            item_id: result.item_id,
            doc_rev: result.doc_rev,
            body: result.body,
        },
        emit,
    ))
}
#[command_boundary::command]
pub(crate) async fn review_return_apply(
    app: tauri::AppHandle,
    request: ApplyRequest,
) -> Result<ApplyResult, String> {
    on_main(&app, move |app| {
        let state = app.state::<StoreState>();
        let pending = app.state::<Pending>();
        let dirty = app.state::<MirrorDirty>();
        let (result, emit) = {
            let mut guard = locked(&state);
            let project = open_project_mut(&mut guard)?;
            let mut slot = pending.0.lock().map_err(|_| "review preview unavailable")?;
            let ticket = slot
                .as_ref()
                .filter(|t| t.token == request.token)
                .ok_or("review preview expired")?;
            access(app, project, ticket.generation, ticket.epoch)?;
            let Operation::Return(plan) = &ticket.operation else {
                return Err("returned review is not ready".into());
            };
            if request.sources.len() > 2500 {
                return Err("too many review author choices".into());
            }
            let authors = ReviewReturnAuthors {
                sources: request
                    .sources
                    .into_iter()
                    .map(|s| (s.source_name, s.choice.stored()))
                    .collect(),
                deciding_actor: request.deciding_actor.map(AuthorChoice::stored),
            };
            let result = apply_into(project, &dirty, plan, &authors)?;
            *slot = None;
            result
        };
        if emit {
            let _ = app.emit(crate::MIRROR_EVENT, ());
        }
        Ok(result)
    })
    .await
}

#[command_boundary::command]
pub(crate) fn review_transport_cancel(pending: State<'_, Pending>, token: String) {
    pending.discard(&token);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{assert_index_matches_a_full_recount, body, opened};
    use std::sync::atomic::AtomicBool;

    fn empty_package() -> ReviewPackage {
        let dir = tempfile::tempdir().unwrap();
        let project = opened(&dir.path().join("book.db"));
        let scene = project.store.item_create(None, "scene", "Scene").unwrap();
        review_docx::export(&project.store.review_scene_snapshot(&scene.id).unwrap()).unwrap()
    }
    #[test]
    fn review_transport_ticket_replacement_cancel_replay_and_busy_are_bounded() {
        let pending = Pending::default();
        let first = pending.begin(1, 2, "scene".into()).unwrap();
        assert!(pending.begin(1, 2, "other".into()).is_err());
        pending
            .install(&first, Operation::Export(empty_package()))
            .unwrap();
        let second = pending.begin(1, 2, "scene".into()).unwrap();
        assert_ne!(first, second);
        assert!(pending
            .install(&first, Operation::Export(empty_package()))
            .is_err());
        pending.discard(&first);
        assert_eq!(pending.0.lock().unwrap().as_ref().unwrap().token, second);
        pending.discard(&second);
        assert!(pending
            .install(&second, Operation::Export(empty_package()))
            .is_err());
        assert!(pending.0.lock().unwrap().is_none());
        assert!(ownership(1, 1, 2, 2, false).is_ok());
        assert!(ownership(2, 1, 2, 2, false).is_err());
        assert!(ownership(1, 1, 3, 2, false).is_err());
        assert!(ownership(1, 1, 2, 2, true).is_err());
    }
    #[test]
    fn review_transport_file_bounds_and_failed_publication_preserve_destination() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("review.docx");
        fs::write(&source, b"original").unwrap();
        assert_eq!(read_package(&source).unwrap(), b"original");
        let large = dir.path().join("large.docx");
        fs::File::create(&large)
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        assert!(read_package(&large).is_err());
        assert!(read_package(dir.path()).is_err());
        let stage = stage_copy(&source, b"replacement").unwrap();
        assert!(cleanup_failed(
            &stage,
            finish_copy(&stage, &source, || ownership(1, 1, 3, 2, false))
        )
        .is_err());
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        assert!(stage_copy(&dir.path().join("absent/review.docx"), b"copy").is_err());
        let stage = stage_copy(&source, b"replacement").unwrap();
        cleanup_failed(&stage, finish_copy(&stage, &source, || Ok(()))).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"replacement");
    }
    #[test]
    fn review_transport_protected_destinations_and_aliases_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir(&home).unwrap();
        let book = dir.path().join("active.docx");
        fs::write(&book, b"database").unwrap();
        assert!(destination(&book, &book, &home).is_err());
        let pictures = crate::pictures::dir_for(&book);
        fs::create_dir(&pictures).unwrap();
        assert!(destination(&pictures.join("review.docx"), &book, &home).is_err());
        let recovery = crate::projects::recovery_dir(&home, "old");
        fs::create_dir_all(&recovery).unwrap();
        assert!(destination(&recovery.join("review.docx"), &book, &home).is_err());
        assert!(destination(&dir.path().join("copy.docx"), &book, &home).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&pictures, dir.path().join("alias")).unwrap();
            assert!(destination(&dir.path().join("alias/review.docx"), &book, &home).is_err());
            let link = dir.path().join("link.docx");
            std::os::unix::fs::symlink(&book, &link).unwrap();
            assert!(destination(&link, &book, &home).is_err());
            assert!(read_package(&link).is_err());
            let hard = dir.path().join("hard.docx");
            fs::hard_link(&book, &hard).unwrap();
            assert!(destination(&hard, &book, &home).is_err());
        }
    }
    #[test]
    fn review_transport_apply_installs_only_store_body_and_updates_index_after_commit() {
        let dir = tempfile::tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let scene = project.store.item_create(None, "scene", "Scene").unwrap();
        crate::flush_into(
            &mut project,
            &[crate::store::FlushEntry {
                item_id: scene.id.clone(),
                body: body("one"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let doc = project.store.load_doc(&scene.id).unwrap();
        let author = project.store.review_author_create("Mara").unwrap();
        let hunk = ReviewHunk {
            from: 4,
            to: 4,
            before: vec![],
            after: vec![FragmentToken::Text {
                text: " two".into(),
                marks: vec![],
            }],
        };
        let group = project
            .store
            .review_group_create(&scene.id, doc.rev, author.id, &[hunk.clone()])
            .unwrap();
        let snapshot = project.store.review_scene_snapshot(&scene.id).unwrap();
        let changed = crate::review_document::apply_hunk(&doc.body, &hunk).unwrap();
        let plan = ReviewPlan {
            expected: review_docx::manifest(&snapshot).unwrap(),
            decisions: vec![OldDecision::Accept(group.hunks[0].id)],
            new_hunks: vec![],
            new_messages: vec![],
            rejected_projection: changed.clone(),
            accepted_projection: "untrusted diagnostic projection".into(),
        };
        let preview = returned_preview("token", "Scene".into(), &plan).unwrap();
        assert_eq!(preview.decisions[0].proposal_author, "Mara");
        assert_eq!(preview.decisions[0].after, hunk.after);
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        assert!(apply_into(&mut project, &dirty, &plan, &ReviewReturnAuthors::default()).is_err());
        assert!(!crate::mirror_pending(&dirty));
        assert_eq!(project.store.load_doc(&scene.id).unwrap().body, doc.body);
        let authors = ReviewReturnAuthors {
            sources: vec![],
            deciding_actor: Some(ReviewAuthorChoice::Existing(author.id)),
        };
        let (result, emit) = apply_into(&mut project, &dirty, &plan, &authors).unwrap();
        assert!(emit);
        assert_eq!(result.body, Some(changed));
        assert_eq!(project.word_count().words, 2);
        assert_index_matches_a_full_recount(&project);
        assert!(apply_into(&mut project, &dirty, &plan, &authors).is_err());
        assert!(current(&project, &plan.expected).is_err());
    }
    #[test]
    fn review_transport_wire_input_never_accepts_a_plan_or_implicit_author() {
        assert!(serde_json::from_str::<ApplyRequest>(
            r#"{"token":"t","sources":[],"deciding_actor":null,"plan":{}}"#
        )
        .is_err());
        assert!(serde_json::from_str::<AuthorChoice>(
            r#"{"kind":"existing","id":1,"display_name":"Other"}"#
        )
        .is_err());
        let parsed:ApplyRequest=serde_json::from_str(r#"{"token":"t","sources":[{"source_name":"Word name","choice":{"kind":"create","display_name":"Local name"}}],"deciding_actor":null}"#).unwrap();
        assert_eq!(parsed.sources[0].source_name, "Word name");
    }
}
