use crate::{locked, open_project, open_project_mut, store, OpenProject, StoreState};
use tauri::State;

/// A restore against one open project, with the word-index move a body write
/// needs.
///
/// The shape `flush_into` establishes, and for the same reason: a body written
/// to the store without moving `OpenProject::words` leaves the project total
/// silently wrong, and a writer cannot tell a wrong number from a right one.
pub(crate) fn restore_into(
    project: &mut OpenProject,
    item_id: &str,
    version_id: i64,
    base_rev: i64,
) -> std::result::Result<store::history::RestoredDoc, String> {
    let restored = project
        .store
        .doc_restore(item_id, version_id, base_rev)
        .map_err(|e| e.to_string())?;
    // Same guard as `flush_into`'s (main.rs): a restored timeline body is not
    // prose and must never reach `record`, or a restore would count a healthy
    // document as one that could not be read.
    let is_timeline = matches!(
        project.store.item_type(item_id),
        Ok(Some(t)) if t == store::TIMELINE_TYPE
    );
    if !is_timeline {
        project.words.record(item_id, &restored.body);
    }
    Ok(restored)
}

/// A snapshot restore against one open project.
///
/// Rebuilds the whole index rather than moving it per document. A snapshot
/// restore can touch every document in the manuscript, so the incremental path
/// would be a scan's worth of work done one row at a time with a second rule
/// for which rows changed -- and that second rule is exactly where a cached
/// total drifts. The full rebuild is ~58 ms at the stress fixture, once, for an
/// operation the writer performed deliberately and confirmed twice.
pub(crate) fn snapshot_restore_into(
    project: &mut OpenProject,
    snapshot_id: i64,
) -> std::result::Result<store::history::RestoredSnapshot, String> {
    let out = project
        .store
        .snapshot_restore(snapshot_id)
        .map_err(|e| e.to_string())?;
    project.words = project.store.word_index().map_err(|e| e.to_string())?;
    Ok(out)
}

/// One document's past states, newest first. No bodies: a long-lived document
/// would otherwise carry every historical copy of itself across the IPC
/// boundary to render a column of times.
#[command_boundary::command]
pub(crate) fn doc_versions(
    state: State<'_, StoreState>,
    item_id: String,
) -> std::result::Result<Vec<store::history::VersionSummary>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .doc_versions(&item_id)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn doc_version_body(
    state: State<'_, StoreState>,
    version_id: i64,
) -> std::result::Result<String, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .version_body(version_id)
        .map_err(|e| e.to_string())
}

/// Put one document back to a past state, returning the body as well as the
/// rev so the page can swap the editor from ONE round trip rather than asking
/// for what the host just wrote.
#[command_boundary::command]
pub(crate) fn doc_restore(
    state: State<'_, StoreState>,
    item_id: String,
    version_id: i64,
    base_rev: i64,
) -> std::result::Result<store::history::RestoredDoc, String> {
    let mut guard = locked(&state);
    restore_into(
        open_project_mut(&mut guard)?,
        &item_id,
        version_id,
        base_rev,
    )
}

#[command_boundary::command]
pub(crate) fn snapshot_list(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<store::history::SnapshotSummary>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .snapshots()
        .map_err(|e| e.to_string())
}

/// Capture every document under a label. Refuses an empty label: a snapshot the
/// writer cannot tell from another snapshot is not a name, and the list is the
/// only surface that identifies them.
#[command_boundary::command]
pub(crate) fn snapshot_create(
    state: State<'_, StoreState>,
    label: String,
) -> std::result::Result<store::history::SnapshotSummary, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("a snapshot needs a name".to_string());
    }
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .snapshot_create(label)
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn snapshot_restore(
    state: State<'_, StoreState>,
    snapshot_id: i64,
) -> std::result::Result<store::history::RestoredSnapshot, String> {
    let mut guard = locked(&state);
    snapshot_restore_into(open_project_mut(&mut guard)?, snapshot_id)
}

#[cfg(test)]
mod tests {
    use super::{restore_into, snapshot_restore_into};
    use crate::flush_into;
    use crate::test_support::{assert_index_matches_a_full_recount, body, opened};
    use tempfile::tempdir;

    #[test]
    fn a_restore_moves_the_word_index_with_it() {
        // A body written to the store without moving OpenProject::words leaves
        // the project total silently wrong, and a writer cannot tell a wrong
        // number from a right one. Same guard as flush_into's.
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let mut project = opened(&path);
        let created = project.store.item_create(None, "scene", "One").unwrap();
        flush_into(
            &mut project,
            &[crate::store::FlushEntry {
                item_id: created.id.clone(),
                body: body("one two three"),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }],
            1,
        )
        .unwrap();
        let version = project.store.doc_versions(&created.id).unwrap()[0].id;
        let rev = project.store.load_doc(&created.id).unwrap().rev;
        flush_into(
            &mut project,
            &[crate::store::FlushEntry {
                item_id: created.id.clone(),
                body: body("one"),
                base_rev: rev,
                comments: None,
            }],
            1,
        )
        .unwrap();
        assert_eq!(project.word_count().words, 1);

        let rev = project.store.load_doc(&created.id).unwrap().rev;
        restore_into(&mut project, &created.id, version, rev).unwrap();

        assert_eq!(project.word_count().words, 3);
        assert_index_matches_a_full_recount(&project);
    }

    #[test]
    fn a_snapshot_restore_rebuilds_the_word_index() {
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
                    body: body("alpha beta gamma"),
                    base_rev: c.doc_rev.unwrap(),
                    comments: None,
                }],
                1,
            )
            .unwrap();
            ids.push(c.id);
        }
        let snapshot = project.store.snapshot_create("full").unwrap();
        for id in &ids {
            let rev = project.store.load_doc(id).unwrap().rev;
            flush_into(
                &mut project,
                &[crate::store::FlushEntry {
                    item_id: id.clone(),
                    body: body("one"),
                    base_rev: rev,
                    comments: None,
                }],
                1,
            )
            .unwrap();
        }
        assert_eq!(project.word_count().words, 3);

        let out = snapshot_restore_into(&mut project, snapshot.id).unwrap();

        assert_eq!(out.documents, 3);
        assert_eq!(project.word_count().words, 9);
        assert_index_matches_a_full_recount(&project);
    }
}
