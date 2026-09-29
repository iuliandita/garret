// app/shell-tauri/src-tauri/src/commands/appearances.rs
// Who appears where, as the page reaches it.
//
// THIN, DELIBERATELY, exactly as `commands/synopsis.rs` and `commands/cast.rs`
// are. A `#[tauri::command]` cannot be unit-tested, so everything worth a test
// lives in a free function the tests can reach -- here `Store::appearances` and
// `Store::appearances_set`, whose refusals and whole-record replacement are
// covered in `store/appearances.rs`. Nothing decides anything here.
//
// AND THE ROLLUP IS NOT HERE EITHER. The page owns the tree; see the store
// module's header and the design record. There is no `appearances_for_chapter`
// and there must not be one.
use crate::{locked, open_project, StoreState};
use std::collections::BTreeMap;
use tauri::State;

/// Every tag in the project, grouped by item, in ONE call.
///
/// THE WHOLE PROJECT AND NOT ONE ITEM, which is `cast_list`'s rule: the page
/// rolls a chapter's scenes up into the chapter, so it needs every row at once
/// and a per-item command would be one round trip per row of the walk.
#[command_boundary::command]
pub(crate) fn appearances_list(
    state: State<'_, StoreState>,
) -> std::result::Result<BTreeMap<String, Vec<String>>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .appearances()
        .map_err(|e| e.to_string())
}

/// Replace everything one item is tagged with. Returns what the file now holds.
///
/// `itemId` and `memberIds` are camelCase from the page, which is the recorded
/// Tauri rule rather than an inconsistency. NEITHER IS AN `Option`: a typo in an
/// optional argument is silently `None` and here that would mean "untag
/// everything", which is legal, destructive and indistinguishable from the
/// correct call.
#[command_boundary::command]
pub(crate) fn appearances_set(
    state: State<'_, StoreState>,
    item_id: String,
    member_ids: Vec<String>,
) -> std::result::Result<Vec<String>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .appearances_set(&item_id, &member_ids)
        .map_err(|e| e.to_string())
}
