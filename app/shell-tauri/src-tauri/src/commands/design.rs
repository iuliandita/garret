// app/shell-tauri/src-tauri/src/commands/design.rs
// The book design settings, as the page reaches them.
//
// THIN, DELIBERATELY, the same as `commands/synopsis.rs`: a `#[tauri::command]`
// cannot be unit-tested, so everything worth a test -- the parsing, the
// validation, the presets, the default, the read that writes nothing -- lives in
// `crate::design`, over a plain `&Store`.
//
// THE OFFERINGS TRAVEL WITH THE ANSWER. The page is given the fonts, the named
// page sizes and both presets along with the current design, and holds no
// measurement of its own: a panel that restated 6 x 9 in would be a second
// statement of every number in `design.rs`, and the two would drift the first
// time a preset was revised. What the page owns is the WORDS -- the catalog
// names each font, size and preset by its id.
use crate::design::{self, BookDesign, Margins, PageSize, PageSizeSpec};
use crate::{locked, open_project, StoreState};
use tauri::State;

#[derive(serde::Serialize)]
pub(crate) struct Preset {
    id: &'static str,
    design: BookDesign,
}

#[derive(serde::Serialize)]
pub(crate) struct BookDesignView {
    /// What this book is set as, with the built-in default standing in for
    /// anything nobody has chosen.
    design: BookDesign,
    fonts: Vec<&'static str>,
    page_sizes: Vec<&'static PageSizeSpec>,
    presets: Vec<Preset>,
}

/// How the OPEN project is set, and what else it could be set as.
///
/// READS ONLY, and that is the whole of the "absent means absent" rule as the
/// page can see it: opening this panel on a book nobody has designed must leave
/// the file exactly as it was, or "never chosen" and "chose the default" become
/// the same thing forever after.
#[command_boundary::command]
pub(crate) fn book_design_get(
    state: State<'_, StoreState>,
) -> std::result::Result<BookDesignView, String> {
    let guard = locked(&state);
    let design = design::design_of(&open_project(&guard)?.store)?;
    Ok(BookDesignView {
        design,
        fonts: design::FONTS.to_vec(),
        page_sizes: design::PAGE_SIZES.iter().collect(),
        presets: design::PRESETS
            .into_iter()
            .filter_map(|id| design::preset(id).map(|design| Preset { id, design }))
            .collect(),
    })
}

/// Record how the OPEN project is set, and answer with what landed.
///
/// EVERY AXIS, ALWAYS, which is `settings_set_typography`'s shape and its
/// reason: the host checks the whole design before writing any of it, so a call
/// carrying margins that do not fit the page changes nothing rather than the
/// font and nothing else.
///
/// Answers with the stored design rather than with nothing, so the panel
/// repaints from the file it just wrote instead of from what it hoped it wrote.
#[command_boundary::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn book_design_set(
    state: State<'_, StoreState>,
    font: String,
    page_width_um: i64,
    page_height_um: i64,
    page_name: Option<String>,
    margin_inner_um: i64,
    margin_outer_um: i64,
    margin_top_um: i64,
    margin_bottom_um: i64,
) -> std::result::Result<BookDesign, String> {
    let wanted = BookDesign {
        font,
        page: PageSize {
            width_um: page_width_um,
            height_um: page_height_um,
            name: page_name,
        },
        margins: Margins {
            inner_um: margin_inner_um,
            outer_um: margin_outer_um,
            top_um: margin_top_um,
            bottom_um: margin_bottom_um,
        },
    };
    let guard = locked(&state);
    let store = &open_project(&guard)?.store;
    design::write_design(store, &wanted)?;
    design::design_of(store)
}

/// Change only the physical page setup. The font is read under the same store
/// lock, so a proof-rail edit cannot overwrite a font change made elsewhere.
#[command_boundary::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn book_layout_set(
    state: State<'_, StoreState>,
    page_width_um: i64,
    page_height_um: i64,
    page_name: Option<String>,
    margin_inner_um: i64,
    margin_outer_um: i64,
    margin_top_um: i64,
    margin_bottom_um: i64,
) -> std::result::Result<BookDesign, String> {
    let guard = locked(&state);
    let store = &open_project(&guard)?.store;
    design::write_layout(
        store,
        PageSize {
            width_um: page_width_um,
            height_um: page_height_um,
            name: page_name,
        },
        Margins {
            inner_um: margin_inner_um,
            outer_um: margin_outer_um,
            top_um: margin_top_um,
            bottom_um: margin_bottom_um,
        },
    )?;
    design::design_of(store)
}

/// The four options the rail offers, and what this book has chosen.
///
/// THE OFFERINGS TRAVEL WITH THE ANSWER, as they do for the design above: the
/// page holds the WORDS for the ornaments and the host holds the ORNAMENTS. A
/// rail that carried the characters would be a second copy of `design::GLYPHS`,
/// and the two would disagree the first time one was revised.
#[derive(serde::Serialize)]
pub(crate) struct ChapterStyleView {
    style: design::ChapterStyle,
    glyphs: Vec<Glyph>,
}

#[derive(serde::Serialize)]
pub(crate) struct Glyph {
    id: &'static str,
    ornament: &'static str,
}

/// How the OPEN project's chapters are set, and what else they could be.
///
/// READS ONLY, exactly as `book_design_get` is.
#[command_boundary::command]
pub(crate) fn chapter_style_get(
    state: State<'_, StoreState>,
) -> std::result::Result<ChapterStyleView, String> {
    let guard = locked(&state);
    let style = design::chapter_style_of(&open_project(&guard)?.store)?;
    Ok(ChapterStyleView {
        style,
        glyphs: design::GLYPHS
            .iter()
            .map(|g| Glyph {
                id: g.id,
                ornament: g.ornament,
            })
            .collect(),
    })
}

/// Record how the OPEN project's chapters are set, and answer with what landed.
///
/// THE WHOLE STYLE, ALWAYS, which is `book_design_set`'s shape: the rail paints
/// four controls and every one of them is the act, so a press sends the state
/// of all four rather than a delta nothing could validate as a whole.
///
/// SEPARATE FROM `book_design_set`, and that is the containment. The rail shows
/// neither the font, the page nor the margins; a Save carrying a whole
/// `BookDesign` would write back three values the writer was never looking at.
/// 042's argument for keeping a cover out of the design, for a different
/// reason.
#[command_boundary::command]
pub(crate) fn chapter_style_set(
    state: State<'_, StoreState>,
    glyph: Option<String>,
    new_page: bool,
    caps_title: bool,
    drop_cap: bool,
) -> std::result::Result<design::ChapterStyle, String> {
    let wanted = design::ChapterStyle {
        // An empty word is how a `<select>` says "none"; it is not an ornament
        // this build offers, and `write_chapter_style` would refuse it. Mapped
        // here rather than there, because absence is the STORE's vocabulary and
        // an empty string is the PAGE's.
        glyph: glyph.filter(|g| !g.is_empty()),
        new_page,
        caps_title,
        drop_cap,
    };
    let guard = locked(&state);
    let store = &open_project(&guard)?.store;
    design::write_chapter_style(store, &wanted)?;
    design::chapter_style_of(store)
}
