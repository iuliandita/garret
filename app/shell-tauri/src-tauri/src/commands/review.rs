use crate::review_document::ReviewHunk;
use crate::store::review::{
    ReviewAuthor, ReviewDecision, ReviewDecisionResult, ReviewGroup, ReviewMessage,
};
use crate::{
    locked, open_project, open_project_mut, privacy_host, store, MirrorDirty, OpenProject,
    StoreState,
};
use serde::Serialize;
use tauri::{Emitter, State};

fn check_generation(project: &OpenProject, generation: u64) -> Result<(), String> {
    if project.generation != generation {
        return Err("review belongs to a different open project".into());
    }
    Ok(())
}

fn check_access(
    app: &tauri::AppHandle,
    project: &OpenProject,
    generation: u64,
) -> Result<(), String> {
    if privacy_host::locked(app) {
        return Err("privacy locked".into());
    }
    check_generation(project, generation)
}

#[derive(Serialize)]
struct ReviewDocument {
    item_id: String,
    body: String,
    rev: i64,
}

#[derive(Serialize)]
pub(crate) struct ReviewState {
    document: ReviewDocument,
    authors: Vec<ReviewAuthor>,
    page: store::review_query::ReviewPage,
}

#[command_boundary::command]
pub(crate) fn review_state(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    generation: u64,
    item_id: String,
    before_id: Option<i64>,
    pending_only: Option<bool>,
) -> Result<ReviewState, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    check_access(&app, project, generation)?;
    read_state(project, &item_id, before_id, pending_only.unwrap_or(true))
}

fn read_state(
    project: &OpenProject,
    item_id: &str,
    before_id: Option<i64>,
    pending_only: bool,
) -> Result<ReviewState, String> {
    let document = project.store.load_doc(item_id).map_err(|e| e.to_string())?;
    Ok(ReviewState {
        document: ReviewDocument {
            item_id: item_id.into(),
            body: document.body,
            rev: document.rev,
        },
        authors: project.store.review_authors().map_err(|e| e.to_string())?,
        page: project
            .store
            .review_page(item_id, before_id, pending_only, 50)
            .map_err(|e| e.to_string())?,
    })
}

#[command_boundary::command]
pub(crate) fn review_group(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    generation: u64,
    group_id: i64,
) -> Result<ReviewGroup, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    check_access(&app, project, generation)?;
    project
        .store
        .review_group(group_id)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn review_author_create(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    generation: u64,
    display_name: String,
) -> Result<ReviewAuthor, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    check_access(&app, project, generation)?;
    project
        .store
        .review_author_create(&display_name)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn review_group_create(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    generation: u64,
    item_id: String,
    expected_doc_rev: i64,
    author_id: i64,
    hunks: Vec<ReviewHunk>,
) -> Result<ReviewGroup, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    check_access(&app, project, generation)?;
    project
        .store
        .review_group_create(&item_id, expected_doc_rev, author_id, &hunks)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn review_messages(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    generation: u64,
    group_id: i64,
) -> Result<Vec<ReviewMessage>, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    check_access(&app, project, generation)?;
    project
        .store
        .review_messages(group_id)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn review_message_add(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    generation: u64,
    group_id: i64,
    expected_group_rev: i64,
    author_id: i64,
    body: String,
) -> Result<ReviewMessage, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    check_access(&app, project, generation)?;
    project
        .store
        .review_message_add(group_id, expected_group_rev, author_id, &body)
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionRequest {
    generation: u64,
    item_id: String,
    group_id: i64,
    expected_group_rev: i64,
    expected_doc_rev: i64,
    selected_ids: Vec<i64>,
    decision: ReviewDecision,
    author_id: i64,
}

fn decide_into(
    project: &mut OpenProject,
    dirty: &MirrorDirty,
    request: &DecisionRequest,
) -> Result<(ReviewDecisionResult, bool), String> {
    check_generation(project, request.generation)?;
    let group = project
        .store
        .review_group(request.group_id)
        .map_err(|e| e.to_string())?;
    if group.item_id != request.item_id {
        return Err("review belongs to a different document".into());
    }
    let result = project
        .store
        .review_decide(
            request.group_id,
            request.expected_group_rev,
            request.expected_doc_rev,
            &request.selected_ids,
            request.decision,
            request.author_id,
        )
        .map_err(|e| e.to_string())?;
    let emit = if let Some(body) = &result.body {
        project.words.record(&request.item_id, body);
        crate::mark_mirror_dirty(dirty)
    } else {
        false
    };
    Ok((result, emit))
}

#[command_boundary::command]
pub(crate) fn review_decide(
    window: tauri::Window,
    state: State<'_, StoreState>,
    dirty: State<'_, MirrorDirty>,
    request: DecisionRequest,
) -> Result<ReviewDecisionResult, String> {
    use tauri::Manager;
    let (result, emit) = {
        let mut guard = locked(&state);
        let project = open_project_mut(&mut guard)?;
        check_access(window.app_handle(), project, request.generation)?;
        decide_into(project, &dirty, &request)?
    };
    if emit {
        let _ = window.emit(crate::MIRROR_EVENT, ());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_document::FragmentToken;
    use crate::test_support::{assert_index_matches_a_full_recount, body, opened};
    use std::sync::atomic::AtomicBool;

    fn proposal(project: &mut OpenProject) -> DecisionRequest {
        let scene = project.store.item_create(None, "scene", "One").unwrap();
        crate::flush_into(
            project,
            &[store::FlushEntry {
                item_id: scene.id.clone(),
                body: body("one"),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let author = project.store.review_author_create("Mara").unwrap();
        let doc = project.store.load_doc(&scene.id).unwrap();
        let group = project
            .store
            .review_group_create(
                &scene.id,
                doc.rev,
                author.id,
                &[ReviewHunk {
                    from: 4,
                    to: 4,
                    before: vec![],
                    after: vec![FragmentToken::Text {
                        text: " two".into(),
                        marks: vec![],
                    }],
                }],
            )
            .unwrap();
        DecisionRequest {
            generation: 1,
            item_id: scene.id,
            group_id: group.id,
            expected_group_rev: group.rev,
            expected_doc_rev: doc.rev,
            selected_ids: vec![group.hunks[0].id],
            decision: ReviewDecision::Accept,
            author_id: author.id,
        }
    }

    #[test]
    fn state_serializes_the_captured_document_identity_with_its_prose() {
        let dir = tempfile::tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let request = proposal(&mut project);
        let snapshot = read_state(&project, &request.item_id, None, true).unwrap();
        let wire = serde_json::to_value(snapshot).unwrap();
        assert_eq!(wire["document"]["item_id"], request.item_id);
        assert_eq!(wire["document"]["body"], body("one"));
        assert_eq!(wire["document"]["rev"], request.expected_doc_rev);
        assert_eq!(wire["page"]["groups"][0]["id"], request.group_id);
        assert!(read_state(&project, "missing", None, true).is_err());
    }

    #[test]
    fn acceptance_updates_counts_and_schedules_mirror_after_commit() {
        let dir = tempfile::tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let request = proposal(&mut project);
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        assert_eq!(project.word_count().words, 1);
        let (result, emit) = decide_into(&mut project, &dirty, &request).unwrap();
        assert!(emit);
        assert!(crate::mirror_pending(&dirty));
        assert_eq!(project.word_count().words, 2);
        assert_eq!(
            project.store.load_doc(&request.item_id).unwrap().body,
            result.body.unwrap()
        );
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn stale_or_wrong_target_decisions_do_not_touch_prose_counts_or_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let mut request = proposal(&mut project);
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        let item = request.item_id.clone();
        let original = project.store.load_doc(&item).unwrap();
        request.generation = 2;
        assert!(decide_into(&mut project, &dirty, &request).is_err());
        request.generation = 1;
        request.item_id = "another scene".into();
        assert!(decide_into(&mut project, &dirty, &request).is_err());
        request.item_id = item.clone();
        request.expected_doc_rev += 1;
        assert!(decide_into(&mut project, &dirty, &request).is_err());
        request.expected_doc_rev -= 1;
        request.expected_group_rev += 1;
        assert!(decide_into(&mut project, &dirty, &request).is_err());
        assert_eq!(project.store.load_doc(&item).unwrap().body, original.body);
        assert_eq!(
            project.store.review_group(request.group_id).unwrap().hunks[0].state,
            "pending"
        );
        assert!(!crate::mirror_pending(&dirty));
        assert_eq!(project.word_count().words, 1);
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn rejection_preserves_prose_counts_and_mirror_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut project = opened(&dir.path().join("book.db"));
        let mut request = proposal(&mut project);
        request.decision = ReviewDecision::Reject;
        let dirty = MirrorDirty(AtomicBool::new(false), AtomicBool::new(false));
        let original = project.store.load_doc(&request.item_id).unwrap();
        let (result, emit) = decide_into(&mut project, &dirty, &request).unwrap();
        assert!(result.body.is_none());
        assert!(!emit);
        assert!(!crate::mirror_pending(&dirty));
        assert_eq!(
            project.store.load_doc(&request.item_id).unwrap().body,
            original.body
        );
        assert_eq!(
            project.store.review_group(request.group_id).unwrap().hunks[0].state,
            "rejected"
        );
        assert_index_matches_a_full_recount(&project);
    }
}
