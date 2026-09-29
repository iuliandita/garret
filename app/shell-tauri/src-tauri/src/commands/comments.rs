use crate::{locked, open_project, store, StoreState};
use tauri::State;

/// Every note on one document, resolved ones included.
///
/// The panel owns the toggle that hides the settled ones; hiding them here would
/// make "kept, never deleted" a claim with nothing on the page to check it
/// against.
#[command_boundary::command]
pub(crate) fn comment_list(
    state: State<'_, StoreState>,
    item_id: String,
) -> std::result::Result<Vec<store::comments::Comment>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .comments(&item_id)
        .map_err(|e| e.to_string())
}

/// Attach a note to a range of one document.
///
/// TAKES THE QUOTE FROM THE PAGE, and that is not a path argument in disguise:
/// the passage is the page's own projection of the document it is rendering,
/// which the host cannot compute without restating ProseMirror's position model
/// in Rust -- a fifth statement of a rule that already exists in four places.
/// What it costs is that a page could store a quote that never appeared in the
/// prose. What it buys is that an ORPHAN still names its subject, which is the
/// one thing an orphan has, and the store is the writer's own file rather than
/// anyone else's.
///
/// `anchorFrom`/`anchorTo` are camelCase from the page and snake_case coming
/// back, which is the recorded Tauri rule rather than an inconsistency.
#[command_boundary::command]
pub(crate) fn comment_create(
    state: State<'_, StoreState>,
    item_id: String,
    body: String,
    anchor_from: i64,
    anchor_to: i64,
    quote: String,
) -> std::result::Result<store::comments::Comment, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .comment_create(&item_id, &body, anchor_from, anchor_to, &quote)
        .map_err(|e| e.to_string())
}

/// Rewrite what a note says. No `base_rev`: a comment is not part of the item's
/// revision and has no concurrent writer -- there is one window, one page, and
/// one panel, and the note's text is not something any other operation touches.
/// Inventing a revision for it would be a discipline with nothing to guard.
#[command_boundary::command]
pub(crate) fn comment_set_body(
    state: State<'_, StoreState>,
    id: i64,
    body: String,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .comment_set_body(id, &body)
        .map_err(|e| e.to_string())
}

/// Settle a note, or bring one back. Never deletes; see comments.rs.
#[command_boundary::command]
pub(crate) fn comment_set_resolved(
    state: State<'_, StoreState>,
    id: i64,
    resolved: bool,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .comment_set_resolved(id, resolved)
        .map_err(|e| e.to_string())
}
