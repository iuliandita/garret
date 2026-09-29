// app/shell-tauri/src-tauri/src/commands/covers.rs
// The book's front and back covers, as the page reaches them.
//
// THIN, DELIBERATELY, exactly as `commands/design.rs` and `commands/cast.rs`
// are: a `#[tauri::command]` cannot be unit-tested, so everything worth a test
// -- where a cover is recorded, what a name may be, the resolution and the
// proportion, the decode and the four states -- lives in `crate::covers` and
// `crate::pictures`, over plain values. Nothing decides anything here.
//
// THE PAGE SENDS A SIDE AND NOTHING ELSE. It never sends a filename and it is
// never told one: what crosses back is a state word, a `data:` URI of a
// thumbnail, and numbers. That is 038's "the page never names a path, in either
// direction", and it is why a cover is not an argument to `book_design_set` --
// see `crate::covers`.
//
// THE CHECK RIDES ON THE READ AND IS NOT A NOTICE AT IMPORT. Whether a cover
// suits this book depends on the page size, which a writer changes in another
// panel at any time; a verdict computed once when the file was chosen would be
// stale exactly when it started to matter. So `covers_get` recomputes it every
// time the panel opens, and the panel paints it as a STATE beside the picture
// rather than raising it as a message that scrolls away.
use crate::pictures::PictureView;
use crate::{locked, open_project, StoreState};
use tauri::State;

/// One side of the book: what is there, and what is true about it.
#[derive(serde::Serialize)]
pub(crate) struct CoverSideView {
    /// `front` or `back`, echoed back so the page never has to match answers to
    /// requests by position.
    pub(crate) side: &'static str,
    /// The four states and a thumbnail, exactly as a cast member's picture.
    pub(crate) view: PictureView,
    /// The resolution and proportion findings, or None when there is no
    /// readable picture to measure. Never a check full of zeros: a book with no
    /// cover has nothing said about its cover's resolution.
    pub(crate) check: Option<crate::covers::CoverCheck>,
    pub(crate) fit: crate::covers::CoverFit,
}

/// Both sides, and the page they are held against.
///
/// THE PAGE SIZE TRAVELS WITH THE ANSWER, `book_design_get`'s rule: the panel
/// says what a cover is being judged against, and a panel that restated 6 x 9 in
/// would be a second statement of every number in `design.rs`.
#[derive(serde::Serialize)]
pub(crate) struct CoversView {
    pub(crate) page: crate::design::PageSize,
    pub(crate) sides: Vec<CoverSideView>,
}

/// Both covers of the OPEN project, read fresh.
///
/// READS ONLY. Opening this panel on a book nobody has given a cover leaves the
/// file exactly as it was -- `design_of`'s rule, and the same reason: "never
/// chosen" is a state that must stay tellable from "chose and it went missing".
#[command_boundary::command]
pub(crate) fn covers_get(state: State<'_, StoreState>) -> std::result::Result<CoversView, String> {
    let guard = locked(&state);
    read_covers(open_project(&guard)?)
}

/// Take a cover off, and delete the files it named.
///
/// ITS OWN COMMAND rather than an argument to `book_design_set`, for the reason
/// `cast_picture_clear` is its own rather than an argument to `cast_set`: the
/// design panel's controls must not be able to carry a cover, correctly or
/// otherwise.
///
/// Answers with BOTH sides rather than the one that changed, so the panel
/// repaints from the file instead of patching what it hoped it wrote.
#[command_boundary::command]
pub(crate) fn covers_clear(
    state: State<'_, StoreState>,
    side: String,
) -> std::result::Result<CoversView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let dir = crate::pictures::dir_for(&project.path);
    let previous = crate::covers::clear_cover(&project.store, &side)?;
    if let Some(name) = previous {
        // THE FILE GOES WITH THE ROW, and the order is row first --
        // `cast_picture_clear`'s rule. Nothing in the book names that file after
        // the row is gone, so this is the only chance to remove it, and the
        // removal is best effort and never fatal.
        crate::pictures::remove(&dir, &name);
    }
    read_covers(project)
}

#[command_boundary::command]
pub(crate) fn covers_fit_set(
    state: State<'_, StoreState>,
    side: String,
    fit: String,
) -> std::result::Result<CoversView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    crate::covers::set_fit(&project.store, &side, &fit)?;
    read_covers(project)
}

/// One cover at `pictures::FULL_MAX`, for the viewer.
///
/// ON DEMAND AND NEVER WITH THE PANEL. A full view is a few megabytes crossing
/// into the web process; the panel's thumbnail is kilobytes. Sending both at
/// once would put the cost of looking properly on every writer who merely
/// opened the panel, which is the list-shaped read 038 refused one surface in.
#[command_boundary::command]
pub(crate) fn cover_full(
    state: State<'_, StoreState>,
    side: String,
) -> std::result::Result<PictureView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let dir = crate::pictures::dir_for(&project.path);
    let stored = crate::covers::cover_of(&project.store, &side)?;
    Ok(crate::pictures::full(&dir, stored.as_deref()))
}

/// The one place a `CoversView` is built, so the read, the clear and the pick
/// cannot answer with three differently-shaped truths.
pub(crate) fn read_covers(project: &crate::OpenProject) -> std::result::Result<CoversView, String> {
    let dir = crate::pictures::dir_for(&project.path);
    let design = crate::design::design_of(&project.store)?;
    let mut sides = Vec::new();
    for side in crate::covers::SIDES {
        let fit = crate::covers::fit_of(&project.store, side)?;
        let stored = crate::covers::cover_of(&project.store, side)?;
        let view = crate::pictures::view(&dir, stored.as_deref());
        // MEASURED OFF THE ORIGINAL, never off the thumbnail: every thumbnail
        // here is 256 px on its long side and would report every cover in every
        // book as far too small to print.
        let check = stored
            .as_deref()
            .and_then(|name| crate::pictures::dimensions(&dir, name))
            .and_then(|(w, h)| crate::covers::check_with_fit(&design.page, w, h, fit));
        sides.push(CoverSideView { side, view, check, fit });
    }
    Ok(CoversView {
        page: design.page,
        sides,
    })
}
