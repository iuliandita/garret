// app/shell-tauri/src-tauri/src/design.rs
// HOW THE BOOK IS SET WHEN IT LEAVES THIS APPLICATION: the body font, the page
// it is set on, and the four margins around it. Per BOOK, stored in the
// project's own file.
//
// NOTHING CONSUMES THIS YET. 043 (EPUB) needs the font; 044 (PDF) needs all
// three. It is built first and alone because the publishing track's design
// record says so: a setting mechanism invented halfway through a renderer is a
// setting mechanism shaped by that renderer.
//
// THIS IS NOT `typography.ts` AND MUST NEVER BECOME IT. That module's rule is
// load-bearing and stated three times over -- every actual value lives in
// style.css, only ten known words ever cross from settings into the page, and
// `applyTypography` writes its attributes ON THE LIVE EDITOR ROOT. Editor
// typography is per WRITER and is about reading on this screen; book design is
// per BOOK and is about a printed page nobody is looking at. They have no
// values in common, no enum in common, and a setting from this module must
// never reach the element the writer is typing into.
//
// WHERE IT LIVES: the store's `meta` key/value table, already per-project,
// already surviving a rename of the file, already answering "absent" cleanly,
// and needing no migration. Rejected: a typed `export_design` table, which is a
// migration for no gain at this size; rejected harder, a slug-keyed list in the
// global `settings.json`, which would put a book's page size in a file that is
// not the book -- a manuscript carried to another machine would arrive without
// its own design.
//
// UNITS ARE MICROMETRES, INTEGERS. One inch is exactly 25 400 um, so every inch
// fraction a trim size or a margin is actually quoted in -- halves, quarters,
// eighths, sixteenths -- is an exact integer here, and so is every millimetre
// value to three decimals. Tenths of a millimetre cannot hold 0.75 in
// (19.05 mm); a float in a stored string would reintroduce formatting drift
// between two builds of the same value. The page converts for display and never
// stores what it displayed.
//
// AN ABSENT KEY MEANS THE WRITER HAS NOT CHOSEN, and is answered with
// `default_design()`. Nothing is written on first open: a store that recorded
// its defaults the moment a panel was looked at would make "never chosen" and
// "chose exactly this" indistinguishable forever after. The cost is recorded
// and accepted -- a later build that changed the default would change every
// book nobody had designed, and pressing a preset is what makes a choice
// immune to that.

use crate::store::Store;

/// The project's chosen body font, as a family name.
pub const FONT_KEY: &str = "design.font";
/// The project's page size: `"<width>x<height>"` in micrometres, optionally
/// followed by a space and the name of a size this application offers.
pub const PAGE_KEY: &str = "design.page";
/// The project's margins: `"<inner>,<outer>,<top>,<bottom>"` in micrometres.
pub const MARGINS_KEY: &str = "design.margins";

/// The longest family name this application will store. A bound rather than a
/// list, because a writer whose machine has a face this application never heard
/// of should be able to set their book in it -- but the value ends up inside a
/// stylesheet declaration, and an unbounded string out of a store
/// nobody validated is not a font name.
pub const FONT_MAX_CHARS: usize = 100;

/// What a book's font falls back to when the machine rendering it has no such
/// face.
///
/// ONE STATEMENT, SHARED BY BOTH BOOK FORMATS. This application ships no font
/// files (040's recorded gap), so what a renderer can do is name the family and
/// put a stack behind it -- and two formats of one manuscript falling back to
/// two different faces would be two answers to what the writer's book looks
/// like. `epub.rs` and `pdf.rs` both write this and neither owns it.
pub const FONT_FALLBACK: &str = "Georgia, \"Times New Roman\", serif";

/// The smallest and largest page this application will store, in micrometres.
/// 10 mm is smaller than any book anybody prints and 1 m is larger; the bounds
/// exist so a corrupt value is refused rather than laid out.
const PAGE_MIN_UM: i64 = 10_000;
const PAGE_MAX_UM: i64 = 1_000_000;

/// The body fonts this application offers.
///
/// All four are libre text faces under the SIL Open Font License whose own
/// projects describe them as made for setting long-form text; the decision
/// record cites each. NOT BUNDLED -- this application ships no font files, so
/// what is stored is a NAME and whether the machine rendering the book has it is
/// 043's and 044's problem, with a generic fallback. That gap is recorded rather
/// than papered over.
pub const FONTS: [&str; 4] = [
    "Crimson Text",
    "EB Garamond",
    "Libre Baskerville",
    "Source Serif 4",
];

/// A page size this application offers by name.
///
/// The NAME is a label and the MEASUREMENTS are the value. A stored design keeps
/// both (see `format_page`) so that a later build changing what `trade` measures
/// cannot silently resize a book somebody already set -- the measurements
/// travel with the book, and the name is only how a panel lights a button.
#[derive(serde::Serialize)]
pub struct PageSizeSpec {
    pub name: &'static str,
    pub width_um: i64,
    pub height_um: i64,
}

/// In ascending order of area, the reading order of the page-size dropdown.
///
/// Inch sizes follow published paperback trims; A4, A5 and B5 use ISO sizes.
/// The decision record carries the citations.
pub const PAGE_SIZES: [PageSizeSpec; 8] = [
    PageSizeSpec {
        name: "five-by-eight",
        width_um: 127_000,
        height_um: 203_200,
    },
    PageSizeSpec {
        name: "digest",
        width_um: 139_700,
        height_um: 215_900,
    },
    PageSizeSpec {
        name: "a5",
        width_um: 148_000,
        height_um: 210_000,
    },
    PageSizeSpec {
        name: "trade",
        width_um: 152_400,
        height_um: 228_600,
    },
    PageSizeSpec {
        name: "b5",
        width_um: 176_000,
        height_um: 250_000,
    },
    PageSizeSpec {
        name: "large",
        width_um: 177_800,
        height_um: 254_000,
    },
    PageSizeSpec {
        name: "letter",
        width_um: 215_900,
        height_um: 279_400,
    },
    PageSizeSpec {
        name: "a4",
        width_um: 210_000,
        height_um: 297_000,
    },
];

pub const PRESET_FICTION: &str = "fiction";
pub const PRESET_NON_FICTION: &str = "non-fiction";

/// The presets, in the order the panel offers them.
pub const PRESETS: [&str; 2] = [PRESET_FICTION, PRESET_NON_FICTION];

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PageSize {
    pub width_um: i64,
    pub height_um: i64,
    /// The name of a size this application offers, when the stored value named
    /// one. `None` is a legal, complete answer: a design can name measurements
    /// no preset has a word for, and the renderer never needed the word.
    pub name: Option<String>,
}

/// INNER, OUTER, TOP, BOTTOM -- not left and right.
///
/// Facing pages mirror: the margin against the binding is the same physical
/// margin on both, and it is the one that has to absorb the curve of a
/// perfect-bound spine. A design stated as left and right would be wrong on
/// every other page of the book.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Margins {
    pub inner_um: i64,
    pub outer_um: i64,
    pub top_um: i64,
    pub bottom_um: i64,
}

/// The ornament a chapter division is marked with, and the three ways a chapter
/// opening can be set.
///
/// THE BOOK'S DESIGN, NOT THE EPUB'S, which is why the keys are `design.glyph`
/// and `design.chapter` and not `design.epub.*`. An ornament, a page break, a
/// capitalised title and a drop cap are print typography that predates the
/// format by four centuries; 044 reads these same two rows and neither slice
/// owns them.
pub const GLYPH_KEY: &str = "design.glyph";
/// The chapter-opening flags, as a SPACE-SEPARATED SET of the ones that are on.
///
/// A set rather than three rows, and rather than a JSON object. Leniency then
/// falls out per WORD instead of per key -- a value carrying a flag this build
/// does not know still yields the two it does -- which is 040's per-key rule at
/// the next resolution down and is what makes the row safe for 044 to widen.
/// An absent row and an empty row are the same book, deliberately: there is
/// nothing a writer could mean by "styled, with nothing on" that differs from
/// "not styled".
pub const CHAPTER_KEY: &str = "design.chapter";

pub const NEW_PAGE: &str = "new-page";
pub const CAPS_TITLE: &str = "caps-title";
pub const DROP_CAP: &str = "drop-cap";

/// An ornament this application offers, and the word a stored row names it by.
///
/// THE ID IS STORED AND THE ORNAMENT IS NOT. A row holding the character itself
/// would put an arbitrary string out of a file straight into a writer's book;
/// a row holding a word this build has a character for cannot. A word this
/// build does not know reads as no ornament at all.
pub struct GlyphSpec {
    pub id: &'static str,
    /// The characters printed. Every one is in the Unicode ranges a reading
    /// system's default serif face carries, which is the whole reason this list
    /// is four ornaments and not forty: this application ships no fonts, so an
    /// ornament nothing can draw is a box in somebody's book.
    pub ornament: &'static str,
}

/// In the order the rail offers them.
pub const GLYPHS: [GlyphSpec; 4] = [
    // The typesetter's dinkus, and the one a manuscript is normally typed with.
    GlyphSpec {
        id: "asterisks",
        ornament: "* * *",
    },
    // ASTERISM, U+2042.
    GlyphSpec {
        id: "asterism",
        ornament: "\u{2042}",
    },
    // FLORAL HEART, U+2766 -- the fleuron.
    GlyphSpec {
        id: "fleuron",
        ornament: "\u{2766}",
    },
    // BLACK DIAMOND SUIT, U+2666.
    GlyphSpec {
        id: "diamond",
        ornament: "\u{2666}",
    },
];

/// The ornament a stored word names, or None for absence and for a word this
/// build does not offer.
pub fn glyph_ornament(id: &str) -> Option<&'static str> {
    GLYPHS.iter().find(|g| g.id == id).map(|g| g.ornament)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ChapterStyle {
    /// The id of an ornament this application offers, or None for none.
    pub glyph: Option<String>,
    pub new_page: bool,
    pub caps_title: bool,
    pub drop_cap: bool,
}

/// This project's chapter styling, with absence meaning the plainest book.
///
/// READS ONLY, exactly as `design_of` does.
pub fn chapter_style_of(store: &Store) -> std::result::Result<ChapterStyle, String> {
    let read = |key: &str| store.get_meta(key).map_err(|e| e.to_string());
    let glyph = read(GLYPH_KEY)?.filter(|v| glyph_ornament(v).is_some());
    let flags = read(CHAPTER_KEY)?.unwrap_or_default();
    let has = |flag: &str| flags.split_whitespace().any(|w| w == flag);
    Ok(ChapterStyle {
        glyph,
        new_page: has(NEW_PAGE),
        caps_title: has(CAPS_TITLE),
        drop_cap: has(DROP_CAP),
    })
}

/// Record this project's chapter styling.
///
/// A GLYPH THIS BUILD DOES NOT OFFER IS REFUSED rather than stored, which is
/// the one asymmetry with the read: absence is a legal value a reader must
/// tolerate from a foreign file, and it is not a value this application may
/// write. `covers::key_for`'s rule.
pub fn write_chapter_style(store: &Store, style: &ChapterStyle) -> std::result::Result<(), String> {
    if let Some(id) = &style.glyph {
        if glyph_ornament(id).is_none() {
            return Err(format!("{id:?} is not an ornament this application offers"));
        }
    }
    let mut flags: Vec<&str> = Vec::new();
    if style.new_page {
        flags.push(NEW_PAGE);
    }
    if style.caps_title {
        flags.push(CAPS_TITLE);
    }
    if style.drop_cap {
        flags.push(DROP_CAP);
    }
    store
        .set_meta(GLYPH_KEY, style.glyph.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    store
        .set_meta(CHAPTER_KEY, &flags.join(" "))
        .map_err(|e| e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct BookDesign {
    pub font: String,
    pub page: PageSize,
    pub margins: Margins,
}

fn size(name: &str) -> &'static PageSizeSpec {
    PAGE_SIZES
        .iter()
        .find(|p| p.name == name)
        .expect("every preset names a size this application offers")
}

fn named(spec: &PageSizeSpec) -> PageSize {
    PageSize {
        width_um: spec.width_um,
        height_um: spec.height_um,
        name: Some(spec.name.to_string()),
    }
}

/// One of the two proposals, or None.
///
/// THE NUMBERS ARE ARGUED IN THE DECISION RECORD and every one of them is
/// sourced there. In short: the trim sizes are KDP's published list; the
/// margins sit above KDP's page-count-banded gutter minimum and above
/// IngramSpark's 0.5 in recommendation on every edge; and the foot is deeper
/// than the head, which is the one thing the classical 2:3:4:6 canon survives
/// contact with a perfect-bound gutter for.
pub fn preset(id: &str) -> Option<BookDesign> {
    match id {
        PRESET_FICTION => Some(BookDesign {
            // "a font family for book production in the tradition of beautiful
            // oldstyle typefaces" -- the project's own description.
            font: "Crimson Text".to_string(),
            page: named(size("trade")),
            margins: Margins {
                // 0.75 in: KDP's 0.5 in gutter minimum for a 151-300 page book,
                // plus a quarter inch that is not swallowed by the spine.
                inner_um: 19_050,
                // 0.625 in.
                outer_um: 15_875,
                top_um: 15_875,
                // 0.75 in. Deeper than the head.
                bottom_um: 19_050,
            },
        }),
        PRESET_NON_FICTION => Some(BookDesign {
            // "will shine when used for extended text on paper or screen", with
            // simplified shapes that hold up in captions and tables.
            font: "Source Serif 4".to_string(),
            page: named(size("large")),
            margins: Margins {
                // 0.875 in: KDP's 0.625 in gutter minimum for a 301-500 page
                // book, plus a quarter inch. Reference non-fiction runs longer.
                inner_um: 22_225,
                // 0.75 in.
                outer_um: 19_050,
                top_um: 19_050,
                // 0.875 in.
                bottom_um: 22_225,
            },
        }),
        _ => None,
    }
}

/// What a book nobody has designed is set as.
///
/// The fiction preset, because a novel is what this application is for. Stated
/// as a call rather than as a second copy of the numbers, so the default and
/// the button claiming to match it cannot drift.
pub fn default_design() -> BookDesign {
    preset(PRESET_FICTION).expect("the fiction preset exists")
}

/// A family name, trimmed, or None.
///
/// Refuses controls and characters that can end the proof's HTML style element
/// or confuse the EPUB preview's stylesheet scoping. Existing stored values are
/// still escaped at the renderer boundary.
pub fn parse_font(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > FONT_MAX_CHARS {
        return None;
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | '{' | '}' | '@' | ';'))
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn measurement(value: &str) -> Option<i64> {
    // `parse` accepts a leading `+` and rejects everything else non-numeric; the
    // positivity check below is what refuses `0` and any negative.
    let n: i64 = value.parse().ok()?;
    (n > 0).then_some(n)
}

fn size_name(value: &str) -> Option<&str> {
    let ok = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then_some(value)
}

/// A stored page size, or None when this build cannot read it.
///
/// None rather than an error, and per key: the recorded `settings.json` rule
/// met again in the store. One unreadable value costs exactly itself, so a
/// corrupt page size cannot take a font the writer chose down with it.
pub fn parse_page(value: &str) -> Option<PageSize> {
    let (measurements, name) = match value.split_once(' ') {
        Some((m, n)) => (m, Some(size_name(n)?)),
        None => (value, None),
    };
    let (w, h) = measurements.split_once('x')?;
    let width_um = measurement(w)?;
    let height_um = measurement(h)?;
    if !(PAGE_MIN_UM..=PAGE_MAX_UM).contains(&width_um)
        || !(PAGE_MIN_UM..=PAGE_MAX_UM).contains(&height_um)
    {
        return None;
    }
    Some(PageSize {
        width_um,
        height_um,
        name: name.map(str::to_string),
    })
}

pub fn format_page(page: &PageSize) -> String {
    match &page.name {
        Some(name) => format!("{}x{} {}", page.width_um, page.height_um, name),
        None => format!("{}x{}", page.width_um, page.height_um),
    }
}

/// Stored margins, or None when this build cannot read them.
pub fn parse_margins(value: &str) -> Option<Margins> {
    let parts: Vec<&str> = value.split(',').collect();
    let [inner, outer, top, bottom] = parts.as_slice() else {
        return None;
    };
    Some(Margins {
        inner_um: measurement(inner)?,
        outer_um: measurement(outer)?,
        top_um: measurement(top)?,
        bottom_um: measurement(bottom)?,
    })
}

pub fn format_margins(m: &Margins) -> String {
    format!("{},{},{},{}", m.inner_um, m.outer_um, m.top_um, m.bottom_um)
}

/// Whether a design is one this application will store.
///
/// The margin-fit rule is the only one that is about the design as a WHOLE, and
/// it is the reason this function exists rather than three independent
/// validators: a page and a set of margins can each be perfectly legal and leave
/// no page left to set the book on.
pub fn check(design: &BookDesign) -> std::result::Result<(), String> {
    if parse_font(&design.font).as_deref() != Some(design.font.as_str()) {
        return Err(format!("{:?} is not a font name", design.font));
    }
    let page = format_page(&design.page);
    if parse_page(&page).as_ref() != Some(&design.page) {
        return Err(format!("{page:?} is not a page size"));
    }
    let margins = format_margins(&design.margins);
    if parse_margins(&margins).as_ref() != Some(&design.margins) {
        return Err(format!("{margins:?} is not a set of margins"));
    }
    if design.margins.inner_um + design.margins.outer_um >= design.page.width_um {
        return Err("the side margins leave no width to set the book in".to_string());
    }
    if design.margins.top_um + design.margins.bottom_um >= design.page.height_um {
        return Err("the head and foot margins leave no height to set the book in".to_string());
    }
    Ok(())
}

/// This project's design, with the built-in default standing in for anything
/// nobody has chosen or this build cannot read.
///
/// READS ONLY. A project that has never been designed is left exactly as it was.
pub fn design_of(store: &Store) -> std::result::Result<BookDesign, String> {
    let read = |key: &str| store.get_meta(key).map_err(|e| e.to_string());
    let fallback = default_design();
    Ok(BookDesign {
        font: read(FONT_KEY)?
            .and_then(|v| parse_font(&v))
            .unwrap_or(fallback.font),
        page: read(PAGE_KEY)?
            .and_then(|v| parse_page(&v))
            .unwrap_or(fallback.page),
        margins: read(MARGINS_KEY)?
            .and_then(|v| parse_margins(&v))
            .unwrap_or(fallback.margins),
    })
}

/// Record this project's design.
///
/// CHECKED BEFORE ANYTHING IS WRITTEN, which is `set_typography`'s rule met
/// again: a call naming a good font and margins that do not fit must change
/// nothing rather than half of what it asked for.
pub fn write_design(store: &Store, design: &BookDesign) -> std::result::Result<(), String> {
    check(design)?;
    store
        .set_meta(FONT_KEY, &design.font)
        .map_err(|e| e.to_string())?;
    store
        .set_meta(PAGE_KEY, &format_page(&design.page))
        .map_err(|e| e.to_string())?;
    store
        .set_meta(MARGINS_KEY, &format_margins(&design.margins))
        .map_err(|e| e.to_string())
}

/// Record page setup while preserving this book's stored font.
///
/// The proof rail cannot see or send the font. Validate against its effective
/// value but leave its raw key untouched, including absent or unreadable values.
pub fn write_layout(
    store: &Store,
    page: PageSize,
    margins: Margins,
) -> std::result::Result<(), String> {
    let current = design_of(store)?;
    let design = BookDesign {
        font: current.font,
        page,
        margins,
    };
    check(&design)?;
    store
        .set_meta(PAGE_KEY, &format_page(&design.page))
        .map_err(|e| e.to_string())?;
    store
        .set_meta(MARGINS_KEY, &format_margins(&design.margins))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store(dir: &tempfile::TempDir) -> crate::store::Store {
        crate::store::Store::open(&dir.path().join("p.db")).unwrap()
    }

    #[test]
    fn a_book_nobody_has_styled_gets_the_plainest_one() {
        // ABSENCE MEANS THE PLAINEST BOOK, and it is the answer with the
        // sharper argument: a writer who has never opened the rail gets a book
        // with no ornament, no forced page break, its titles as typed and no
        // drop cap. Every one of the four is a decoration somebody has to CHOOSE
        // rather than one they have to find and turn off.
        let dir = tempdir().unwrap();
        assert_eq!(
            chapter_style_of(&store(&dir)).unwrap(),
            ChapterStyle {
                glyph: None,
                new_page: false,
                caps_title: false,
                drop_cap: false
            }
        );
    }

    #[test]
    fn opening_the_style_of_a_fresh_project_writes_nothing() {
        // 040's rule met again: reading must not destroy the distinction
        // between "never chosen" and "chose exactly this".
        let dir = tempdir().unwrap();
        let s = store(&dir);
        chapter_style_of(&s).unwrap();
        assert_eq!(s.get_meta(GLYPH_KEY).unwrap(), None);
        assert_eq!(s.get_meta(CHAPTER_KEY).unwrap(), None);
    }

    #[test]
    fn a_style_written_is_a_style_read_back() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let wanted = ChapterStyle {
            glyph: Some("asterism".to_string()),
            new_page: true,
            caps_title: false,
            drop_cap: true,
        };
        write_chapter_style(&s, &wanted).unwrap();
        assert_eq!(chapter_style_of(&s).unwrap(), wanted);
    }

    #[test]
    fn a_glyph_this_build_does_not_offer_is_read_as_no_glyph() {
        // The list is the value's whole vocabulary: a stored word this build
        // has no ornament for renders nothing, rather than putting an unknown
        // string into the writer's book.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        s.set_meta(GLYPH_KEY, "not-an-ornament").unwrap();
        assert_eq!(chapter_style_of(&s).unwrap().glyph, None);
    }

    #[test]
    fn an_unknown_word_in_the_chapter_row_costs_only_itself() {
        // The chapter row is a SET, so leniency is per WORD and not merely per
        // key -- one word this build does not know cannot take the two beside
        // it down with it. That is the per-key rule at the next resolution
        // down, and it is what makes the row safe to widen.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        s.set_meta(CHAPTER_KEY, "new-page hyphenate drop-cap")
            .unwrap();
        let style = chapter_style_of(&s).unwrap();
        assert!(style.new_page);
        assert!(style.drop_cap);
        assert!(!style.caps_title);
    }

    #[test]
    fn an_ornament_this_application_does_not_offer_is_refused_rather_than_written() {
        // FOUND BY MUTATION. Reading is LENIENT and writing is not, and the
        // asymmetry is the point: absence is a value a reader must tolerate from
        // a file some other tool wrote, and it is not a value this application
        // may put there. Without the refusal a page one version ahead could
        // store a word no build has an ornament for, and the book would silently
        // lose its ornament for ever after. `covers::key_for`'s rule.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let refusal = write_chapter_style(
            &s,
            &ChapterStyle {
                glyph: Some("pilcrow".to_string()),
                ..ChapterStyle::default()
            },
        )
        .unwrap_err();
        assert!(refusal.contains("pilcrow"), "{refusal}");
        // AND NOTHING WAS WRITTEN. A refusal that had already set the flags
        // would be half of a call the caller was told did not happen.
        assert_eq!(s.get_meta(GLYPH_KEY).unwrap(), None);
        assert_eq!(s.get_meta(CHAPTER_KEY).unwrap(), None);
    }

    #[test]
    fn a_word_that_merely_contains_a_flag_is_not_that_flag() {
        // FOUND BY MUTATION: a substring test passes every fixture whose unknown
        // words happen to share no letters with a known one, which is every
        // fixture anybody writes by hand. The row is a SET and the unit is a
        // WORD, and 044 will widen this vocabulary -- so `new-page-never` must
        // not turn the page break on for a book that asked for the opposite.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        s.set_meta(CHAPTER_KEY, "new-page-never caps-titled")
            .unwrap();
        let style = chapter_style_of(&s).unwrap();
        assert!(!style.new_page);
        assert!(!style.caps_title);
    }

    #[test]
    fn every_glyph_this_application_offers_has_an_ornament_and_a_distinct_id() {
        let mut ids: Vec<&str> = GLYPHS.iter().map(|g| g.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
        assert!(GLYPHS.iter().all(|g| !g.ornament.is_empty()));
    }

    #[test]
    fn a_style_is_not_part_of_the_book_design_the_page_can_write() {
        // THE CONTAINMENT, and it is 042's argument for a different reason. The
        // rail shows the four options and shows NEITHER the font, the page nor
        // the margins; if a style were an axis of `BookDesign`, saving one from
        // the rail would write back three values the writer was never looking
        // at. There is no style in the arguments to get wrong.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let style = ChapterStyle {
            glyph: Some("fleuron".to_string()),
            new_page: true,
            caps_title: true,
            drop_cap: true,
        };
        write_chapter_style(&s, &style).unwrap();
        write_design(&s, &preset(PRESET_NON_FICTION).unwrap()).unwrap();
        assert_eq!(chapter_style_of(&s).unwrap(), style);
    }

    #[test]
    fn a_project_nobody_has_designed_reports_the_built_in_default() {
        let dir = tempdir().unwrap();
        assert_eq!(design_of(&store(&dir)).unwrap(), default_design());
    }

    #[test]
    fn opening_the_design_of_a_fresh_project_writes_nothing() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        design_of(&s).unwrap();
        assert_eq!(s.get_meta(FONT_KEY).unwrap(), None);
        assert_eq!(s.get_meta(PAGE_KEY).unwrap(), None);
        assert_eq!(s.get_meta(MARGINS_KEY).unwrap(), None);
    }

    #[test]
    fn a_design_written_is_a_design_read_back() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let wanted = preset(PRESET_NON_FICTION).unwrap();
        write_design(&s, &wanted).unwrap();
        assert_eq!(design_of(&s).unwrap(), wanted);
    }

    #[test]
    fn a_design_survives_the_file_being_closed_and_reopened() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let wanted = preset(PRESET_NON_FICTION).unwrap();
        {
            let s = crate::store::Store::open(&path).unwrap();
            write_design(&s, &wanted).unwrap();
        }
        let s = crate::store::Store::open_readonly(&path).unwrap();
        assert_eq!(design_of(&s).unwrap(), wanted);
    }

    #[test]
    fn one_unreadable_key_costs_itself_and_not_the_other_two() {
        // `settings.json`'s recorded rule, met again in the store: a strictly
        // all-or-nothing read would make a corrupt page size discard a font the
        // writer chose, and they would have to set two things to get one back.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let wanted = preset(PRESET_NON_FICTION).unwrap();
        write_design(&s, &wanted).unwrap();
        s.set_meta(PAGE_KEY, "not a page size").unwrap();

        let read = design_of(&s).unwrap();
        assert_eq!(read.font, wanted.font);
        assert_eq!(read.margins, wanted.margins);
        assert_eq!(read.page, default_design().page);
    }

    #[test]
    fn a_page_size_is_measurements_and_optionally_a_name() {
        let named = parse_page("152400x228600 trade").expect("a named size");
        assert_eq!(named.width_um, 152_400);
        assert_eq!(named.height_um, 228_600);
        assert_eq!(named.name.as_deref(), Some("trade"));

        // A size no preset names is a legal stored value, and the MEASUREMENTS
        // are what a renderer needs. Nothing here invents a name for it.
        let bare = parse_page("100000x150000").expect("an unnamed size");
        assert_eq!((bare.width_um, bare.height_um), (100_000, 150_000));
        assert_eq!(bare.name, None);
    }

    #[test]
    fn a_page_size_round_trips_through_the_stored_string() {
        for value in ["152400x228600 trade", "100000x150000"] {
            assert_eq!(format_page(&parse_page(value).unwrap()), value);
        }
    }

    #[test]
    fn a_page_size_that_is_not_two_positive_measurements_is_absent() {
        for bad in [
            "",
            "152400",
            "152400x",
            "x228600",
            "0x228600",
            "152400x0",
            "-152400x228600",
            "152400.5x228600",
            "152400x228600x1",
            "152400 x 228600",
            "9x9",                 // below the floor: 9 um is not a page
            "9999999999x228600",   // above the ceiling
            "152400x228600 Trade", // a name is lower-case and bare
            "152400x228600 tra de",
            "152400x228600 ",
        ] {
            assert_eq!(parse_page(bad), None, "{bad:?} parsed");
        }
    }

    #[test]
    fn margins_are_four_measurements_in_one_order() {
        let m = parse_margins("19050,15875,15875,19050").expect("margins");
        assert_eq!(m.inner_um, 19_050);
        assert_eq!(m.outer_um, 15_875);
        assert_eq!(m.top_um, 15_875);
        assert_eq!(m.bottom_um, 19_050);
        // The order is inner, outer, top, bottom and it is not symmetrical --
        // a parser that read them in any other order would satisfy a fixture
        // whose four values were equal.
        let asymmetric = parse_margins("1,2,3,4").unwrap();
        assert_eq!(
            (
                asymmetric.inner_um,
                asymmetric.outer_um,
                asymmetric.top_um,
                asymmetric.bottom_um
            ),
            (1, 2, 3, 4)
        );
    }

    #[test]
    fn margins_round_trip_through_the_stored_string() {
        assert_eq!(
            format_margins(&parse_margins("1,2,3,4").unwrap()),
            "1,2,3,4"
        );
    }

    #[test]
    fn margins_that_are_not_four_positive_measurements_are_absent() {
        for bad in [
            "",
            "1,2,3",
            "1,2,3,4,5",
            "0,2,3,4",
            "1,-2,3,4",
            "1,2,3,x",
            "1, 2,3,4",
        ] {
            assert_eq!(parse_margins(bad), None, "{bad:?} parsed");
        }
    }

    #[test]
    fn a_font_is_a_family_name_and_nothing_that_could_be_markup_or_a_line() {
        assert_eq!(parse_font("Crimson Text").as_deref(), Some("Crimson Text"));
        assert_eq!(
            parse_font("  Crimson Text  ").as_deref(),
            Some("Crimson Text")
        );
        for bad in [
            "",
            "   ",
            "Crimson\nText",
            "Crimson\tText",
            "Crimson\u{0}Text",
            "x</style><script>alert(1)</script>",
            "Bad{font}",
            "Bad@font",
            "Bad;font",
        ] {
            assert_eq!(parse_font(bad), None, "{bad:?} parsed");
        }
        // Bounded, because it goes into a stylesheet declaration and
        // an unbounded value from a store nobody validated is not a font name.
        assert_eq!(parse_font(&"x".repeat(FONT_MAX_CHARS + 1)), None);
        assert!(parse_font(&"x".repeat(FONT_MAX_CHARS)).is_some());
    }

    #[test]
    fn a_design_whose_margins_do_not_fit_the_page_is_refused() {
        // The one rule that is about the design as a WHOLE rather than about a
        // value: each half can be legal on its own and leave no page to set the
        // book on.
        // AT THE BOUNDARY, both axes. Margins that come to EXACTLY the page
        // leave a text block of zero width, which is not a book -- and a test
        // set well past the edge passes against `>` as happily as against
        // `>=`, which is how the width rule survived its first mutation.
        let mut d = default_design();
        d.margins.inner_um = d.page.width_um - d.margins.outer_um;
        assert_eq!(d.margins.inner_um + d.margins.outer_um, d.page.width_um);
        assert!(check(&d).is_err(), "side margins exactly filling the page");

        let mut d = default_design();
        d.margins.top_um = d.page.height_um - d.margins.bottom_um;
        assert_eq!(d.margins.top_um + d.margins.bottom_um, d.page.height_um);
        assert!(check(&d).is_err(), "head and foot exactly filling the page");

        // One micrometre inside the boundary is legal, so the rule is a
        // comparison and not a refusal of anything close to the edge.
        let mut d = default_design();
        d.margins.inner_um = d.page.width_um - d.margins.outer_um - 1;
        assert!(check(&d).is_ok(), "one micrometre of text is still text");

        // Well past it, which is the ordinary case.
        let mut d = default_design();
        d.margins.inner_um = d.page.width_um;
        assert!(check(&d).is_err());

        assert!(check(&default_design()).is_ok());
    }

    #[test]
    fn a_refused_design_is_not_half_written() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let mut bad = default_design();
        bad.margins.inner_um = bad.page.width_um;
        assert!(write_design(&s, &bad).is_err());
        assert_eq!(s.get_meta(FONT_KEY).unwrap(), None);
        assert_eq!(s.get_meta(PAGE_KEY).unwrap(), None);
        assert_eq!(s.get_meta(MARGINS_KEY).unwrap(), None);
    }

    #[test]
    fn a_layout_write_preserves_the_font_and_refuses_without_changing_the_book() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let mut before = preset(PRESET_FICTION).unwrap();
        before.font = "EB Garamond".to_string();
        write_design(&s, &before).unwrap();

        let page = PageSize {
            width_um: 210_000,
            height_um: 297_000,
            name: Some("a4".to_string()),
        };
        let margins = Margins {
            inner_um: 20_000,
            outer_um: 15_000,
            top_um: 15_000,
            bottom_um: 20_000,
        };
        write_layout(&s, page.clone(), margins.clone()).unwrap();
        let landed = design_of(&s).unwrap();
        assert_eq!(landed.font, "EB Garamond");
        assert_eq!(landed.page, page);
        assert_eq!(landed.margins, margins);

        let saved = landed.clone();
        let bad = Margins {
            inner_um: page.width_um,
            ..margins
        };
        assert!(write_layout(&s, page, bad).is_err());
        assert_eq!(design_of(&s).unwrap(), saved);
    }

    #[test]
    fn a_layout_write_leaves_absent_and_unreadable_font_keys_untouched() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let design = default_design();
        write_layout(&s, design.page.clone(), design.margins.clone()).unwrap();
        assert_eq!(s.get_meta(FONT_KEY).unwrap(), None);
        s.set_meta(FONT_KEY, "").unwrap();
        write_layout(&s, design.page, design.margins).unwrap();
        assert_eq!(s.get_meta(FONT_KEY).unwrap(), Some(String::new()));
    }

    #[test]
    fn the_new_trim_sizes_have_the_recorded_dimensions() {
        let expected = [
            ("five-by-eight", 127_000, 203_200),
            ("letter", 215_900, 279_400),
            ("b5", 176_000, 250_000),
            ("a4", 210_000, 297_000),
        ];
        for (name, width_um, height_um) in expected {
            let size = PAGE_SIZES.iter().find(|size| size.name == name).unwrap();
            assert_eq!((size.width_um, size.height_um), (width_um, height_um));
        }
    }

    #[test]
    fn both_presets_exist_and_are_legal_designs() {
        assert_eq!(PRESETS.len(), 2);
        for id in PRESETS {
            let d = preset(id).unwrap_or_else(|| panic!("no preset {id}"));
            check(&d).unwrap_or_else(|e| panic!("{id}: {e}"));
            // Every preset names a page size this application offers, or the
            // panel would paint a preset that lights no page-size control.
            assert!(
                PAGE_SIZES
                    .iter()
                    .any(|p| p.name == d.page.name.as_deref().unwrap_or("")),
                "{id} names a page size that is not on offer"
            );
            assert!(
                FONTS.contains(&d.font.as_str()),
                "{id} names a font not on offer"
            );
        }
    }

    #[test]
    fn the_default_is_the_fiction_preset() {
        // Stated once, so a build that changed the default and left the preset
        // alone -- or the reverse -- fails here rather than silently setting
        // every undesigned book differently from the button that claims to
        // match it.
        assert_eq!(default_design(), preset(PRESET_FICTION).unwrap());
    }

    #[test]
    fn every_preset_margin_clears_the_print_minimums_it_was_chosen_against() {
        // The figures the decision record cites: KDP's 0.25 in outside minimum
        // and its 0.5 in gutter minimum for a 151-300 page book, and
        // IngramSpark's 0.5 in recommendation on every edge. A preset that
        // stopped clearing them would be a proposal this application should not
        // be making.
        const OUTSIDE_MIN_UM: i64 = 12_700; // 0.5 in, the larger of the two
        const GUTTER_MIN_UM: i64 = 12_700; // 0.5 in
        for id in PRESETS {
            let m = preset(id).unwrap().margins;
            assert!(m.inner_um >= GUTTER_MIN_UM, "{id} gutter");
            assert!(m.outer_um >= OUTSIDE_MIN_UM, "{id} outer");
            assert!(m.top_um >= OUTSIDE_MIN_UM, "{id} top");
            assert!(m.bottom_um >= OUTSIDE_MIN_UM, "{id} bottom");
        }
    }

    #[test]
    fn the_foot_is_deeper_than_the_head_in_every_preset() {
        // The one thing the presets take from the classical canon, which
        // otherwise cannot survive a perfect-bound gutter. A preset with equal
        // head and foot would set the text block dead centre, which is the look
        // the canon exists to avoid.
        for id in PRESETS {
            let m = preset(id).unwrap().margins;
            assert!(m.bottom_um > m.top_um, "{id}");
        }
    }

    #[test]
    fn an_unknown_preset_is_none() {
        assert_eq!(preset("cookbook"), None);
    }

    #[test]
    fn every_page_size_on_offer_is_a_distinct_named_size() {
        assert!(PAGE_SIZES.len() >= 2);
        for p in PAGE_SIZES {
            assert!(parse_page(&format!("{}x{} {}", p.width_um, p.height_um, p.name)).is_some());
        }
        let mut names: Vec<&str> = PAGE_SIZES.iter().map(|p| p.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "two page sizes share a name");
    }
}
