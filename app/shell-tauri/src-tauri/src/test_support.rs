use crate::{create_into, move_within, unit_count_at, word_count_at, OpenProject};
use std::path::Path;

/// A project holding one scene of four words, and the open `Store` handle
/// for it -- the one a live host would be holding behind the mutex.
pub(crate) fn seeded_project(path: &Path) -> crate::store::Store {
    let store = crate::store::Store::open(path).unwrap();
    let created = store.item_create(None, "scene", "Only scene").unwrap();
    store
        .flush(&[crate::store::FlushEntry {
            item_id: created.id,
            body: r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"four words go here"}]}]}"#
                .to_string(),
            base_rev: created.doc_rev.unwrap(),
            comments: None,
        }])
        .unwrap();
    store
}

/// A body of `text` as one paragraph, which is what a flush carries.
pub(crate) fn body(text: &str) -> String {
    format!(
        r#"{{"type":"doc","content":[{{"type":"paragraph","content":[
             {{"type":"text","text":"{text}"}}]}}]}}"#
    )
}

/// An OpenProject over a fresh file, index built the way a real open builds
/// it. Generation 1.
pub(crate) fn opened(path: &Path) -> OpenProject {
    let store = crate::store::Store::open(path).unwrap();
    let words = store.word_index().unwrap();
    // Built from the walk, exactly as a real open builds it: a helper that
    // hardcoded an empty set would make every test here blind to the bin and to
    // the bible.
    let excluded = crate::store::excluded_from_book(&store.items().unwrap());
    OpenProject {
        book_id: crate::project_book_id(&store).unwrap(),
        registry_home: None,
        store,
        path: path.to_path_buf(),
        name: "counted".to_string(),
        generation: 1,
        words,
        excluded,
        analytics: None,
        tracking_on: false,
    }
}

/// THE GUARD, in one place: what the index says against what a full scan of
/// the same file says. Every incremental test ends here, because a cached
/// total that has drifted is indistinguishable to a writer from a right one.
pub(crate) fn assert_index_matches_a_full_recount(project: &OpenProject) {
    assert_eq!(
        project.words.count(),
        word_count_at(&project.path).unwrap(),
        "the incremental total has drifted from a full recount"
    );
    assert_eq!(
        project.words.units_excluding(&Default::default()),
        unit_count_at(&project.path).unwrap(),
        "the incremental sentence and paragraph totals have drifted from a full recount"
    );
}

/// A body of one paragraph per entry, for the sentence and paragraph tests.
pub(crate) fn paragraphs(texts: &[&str]) -> String {
    let blocks: Vec<String> = texts
        .iter()
        .map(|t| {
            format!(
                r#"{{"type":"paragraph","content":[{{"type":"text","text":{}}}]}}"#,
                serde_json::to_string(t).unwrap()
            )
        })
        .collect();
    format!(r#"{{"type":"doc","content":[{}]}}"#, blocks.join(","))
}

/// Moves `id` into the project's bin, creating the bin if there is none,
/// through the same commands the page uses. Returns the bin's id.
pub(crate) fn delete_into_bin(project: &mut OpenProject, id: &str, rev: i64) -> String {
    let bin = match project
        .store
        .items()
        .unwrap()
        .into_iter()
        .find(|i| i.item_type == crate::store::TRASH_TYPE)
    {
        Some(existing) => existing.id,
        None => {
            create_into(
                project,
                None,
                crate::store::TRASH_TYPE,
                // The literal the PAGE sends. The store has no runtime
                // constant for it, deliberately - see TRASH_TITLE.
                "Trash",
            )
            .unwrap()
            .id
        }
    };
    // Through `move_within`, NOT `store.item_move` plus a hand-rolled
    // refresh: a helper that refreshed the cache itself would be testing
    // its own restatement of the delete instead of the one the command
    // performs, and a mutation of the real refresh would survive untouched.
    move_within(project, id, Some(&bin), None, rev).unwrap();
    bin
}
