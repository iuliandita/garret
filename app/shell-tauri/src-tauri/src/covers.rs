// app/shell-tauri/src-tauri/src/covers.rs
// THE BOOK'S OWN TWO PICTURES: the front cover and the back cover.
//
// EVERY BYTE OF THIS IS 038's, REUSED AND NOT RESTATED. The directory is
// `pictures::dir_for`, the names are the uuids `pictures::attach` generates, the
// formats are its content sniff, the three bounds are its bounds, the decode
// happens in the host and the page is handed a thumbnail, and a name read back
// out of the file goes through `pictures::is_stored_name` before it is joined to
// anything. What is new here is WHOSE picture it is: a cast member is a row and
// a book is not, so the reference lives somewhere else and the checks are
// different ones.
//
// WHERE THE REFERENCE LIVES: two rows in the store's `meta` key/value table,
// `design.cover.front` and `design.cover.back`, each holding a BARE FILENAME
// inside `<stem>.pictures/` and nothing else.
//
// `meta` and not a column, because a book has no row to hang a column on. The
// alternatives were a one-row table or a second column on `meta` itself, and
// both are a migration for two scalars in a table that has held per-project
// scalars since v1 -- which is exactly the argument made for putting the
// font, the page and the margins there, and this is the same book's design.
//
// `meta` and not A FIXED FILENAME in the picture directory, which is the
// tempting third answer and fails three ways. It cannot carry the format the
// sniff decided, so a JPEG would be stored as `front-cover.png` -- the lie 038
// refuses by name. It makes "has this book a cover" a FILESYSTEM PROBE, so a
// file that has gone missing and a cover nobody chose become one answer, which
// destroys the four-state distinction 038 built a panel around. And it would be
// the only file in that directory not named by a uuid, so `is_stored_name` and
// the thumbnail derivation would each need a second rule.
//
// A COVER IS NOT PART OF `BookDesign`, and that is the containment. Every axis
// of `book_design_set` is a value the PAGE composed and sent; a cover name in it
// would be a filename the webview composed landing in a value that names a file
// on disk, which is exactly what 038's "the page never names a path, in either
// direction" forbids. `cast_set` does not carry the picture and the reason is
// the same one surface further in. So the cover has commands of its own and a
// Save of the book design cannot lose it or invent it.
//
// NO SCHEMA VERSION. `meta` is v1 and a key is data. `covers_need_no_schema_
// version_of_their_own` asserts the literal 9, so a later bump has to come back
// here and say why -- 041's rule, met again.
use crate::design::PageSize;
use crate::store::Store;

/// The two `meta` keys. `design.` because a cover IS the book's design and
/// sits beside `design.font`, `design.page` and `design.margins` -- read by the
/// same reader, carried by the same file, lost by the same damage.
pub const FRONT_KEY: &str = "design.cover.front";
pub const BACK_KEY: &str = "design.cover.back";
pub const FRONT_FIT_KEY: &str = "design.cover-fit.front";
pub const BACK_FIT_KEY: &str = "design.cover-fit.back";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverFit {
    Contain,
    Fill,
}

impl CoverFit {
    pub fn from_id(value: &str) -> Option<Self> {
        match value {
            "contain" => Some(Self::Contain),
            "fill" => Some(Self::Fill),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Contain => "contain",
            Self::Fill => "fill",
        }
    }
}

pub fn fit_key_for(side: &str) -> Option<&'static str> {
    match side {
        SIDE_FRONT => Some(FRONT_FIT_KEY),
        SIDE_BACK => Some(BACK_FIT_KEY),
        _ => None,
    }
}

pub fn fit_of(store: &Store, side: &str) -> Result<CoverFit, String> {
    let key = fit_key_for(side).ok_or_else(|| format!("{side:?} is not a cover this book has"))?;
    Ok(store.get_meta(key).map_err(|e| e.to_string())?
        .as_deref().and_then(CoverFit::from_id).unwrap_or(CoverFit::Contain))
}

pub fn set_fit(store: &Store, side: &str, fit: &str) -> Result<CoverFit, String> {
    let key = fit_key_for(side).ok_or_else(|| format!("{side:?} is not a cover this book has"))?;
    let selected = CoverFit::from_id(fit).ok_or_else(|| format!("{fit:?} is not a cover placement"))?;
    store.set_meta(key, selected.id()).map_err(|e| e.to_string())?;
    Ok(selected)
}

/// The two sides, as they cross the IPC boundary and as the catalog names them.
pub const SIDE_FRONT: &str = "front";
pub const SIDE_BACK: &str = "back";

/// In the order a panel paints them, which is the order a book has them.
pub const SIDES: [&str; 2] = [SIDE_FRONT, SIDE_BACK];

/// The resolution a printed cover is asked for.
///
/// 300 dpi is Amazon KDP's published minimum for a print cover and is the figure
/// every print-on-demand service quotes; below it a cover that looked sharp on
/// screen prints soft, and a writer finds out from the proof copy. It is a
/// WARNING and never a refusal -- an ebook cover has no dpi at all, and a writer
/// who is not printing is entitled to a 1000-pixel picture.
pub const PRINT_DPI: u32 = 300;

/// One micrometre count of an inch. Restated from `design.rs`'s reason: an inch
/// is exactly 25 400 um, so every trim size quoted in inch fractions is an exact
/// integer and no float enters this arithmetic.
const UM_PER_INCH: u64 = 25_400;

/// How far a cover's proportions may sit from the page's before the panel says
/// so, as a percentage of the page's own proportion.
///
/// ONE PERCENT, which is tight on purpose. A cover made to a trim size matches
/// it exactly; the case this exists to catch is a writer bringing an EBOOK cover
/// (KDP recommends 1.6:1) to a 6 x 9 print book (1.5:1), which is 6.7% out and
/// loses about half an inch off the top and bottom of their artwork. A tolerance
/// wide enough to swallow that would not be a check.
pub const SHAPE_TOLERANCE_PERCENT: u64 = 1;

/// Which `meta` key a side names, or None for a word this build does not know.
///
/// BY NAME AND NOT BY AN ENUM CROSSING THE BOUNDARY, exactly as
/// `store::cast_create` refuses a kind: the page sends a string, a string this
/// build has no key for is refused here, and there is one place that decides it.
pub fn key_for(side: &str) -> Option<&'static str> {
    match side {
        SIDE_FRONT => Some(FRONT_KEY),
        SIDE_BACK => Some(BACK_KEY),
        _ => None,
    }
}

fn key_or_error(side: &str) -> Result<&'static str, String> {
    key_for(side).ok_or_else(|| format!("{side:?} is not a cover this book has"))
}

/// What this book's `side` cover is called, or None when there is none.
///
/// IT DOES NOT VALIDATE THE NAME and that is deliberate. A value a foreign tool
/// or a damaged file put in that row is answered as it stands and reaches
/// `pictures::view`, which tags it `unreadable` -- the one answer that is true
/// whether or not anything exists at the end of it. Refusing it here would turn
/// a broken claim into no claim at all, which is 038's recorded reason a missing
/// picture does not clear the column.
pub fn cover_of(store: &Store, side: &str) -> Result<Option<String>, String> {
    store
        .get_meta(key_or_error(side)?)
        .map_err(|e| e.to_string())
}

/// Record `name` as this book's `side` cover, and hand back the name it
/// replaced.
///
/// THE ANSWER IS THE CALLER'S ONLY CHANCE TO DELETE THE OLD FILE, which is
/// `cast_set_picture`'s rule verbatim: after this call nothing in the file names
/// the previous picture, so nothing else can ever find it.
pub fn set_cover(store: &Store, side: &str, name: &str) -> Result<Option<String>, String> {
    let key = key_or_error(side)?;
    let previous = store.get_meta(key).map_err(|e| e.to_string())?;
    store.set_meta(key, name).map_err(|e| e.to_string())?;
    Ok(previous)
}

/// Take the cover off, and hand back the name it held.
///
/// THE ROW IS REMOVED AND THE EMPTY STRING IS NEVER STORED -- `item.state`'s
/// rule and `synopsis_set`'s, met again in `meta`. "Nobody has chosen a cover"
/// and "there was one and the writer took it off" are the same fact about the
/// book, so they are one state and there is one spelling of it.
pub fn clear_cover(store: &Store, side: &str) -> Result<Option<String>, String> {
    let key = key_or_error(side)?;
    let previous = store.get_meta(key).map_err(|e| e.to_string())?;
    store.delete_meta(key).map_err(|e| e.to_string())?;
    Ok(previous)
}

/// How many covers this file NAMES: nought, one or two.
///
/// `pictures_named`'s parallel, and a SECOND figure rather than a widening of
/// it. The two are stored differently, lost differently and repaired
/// differently: a cast photograph is a column on a row that can be deleted, and
/// a cover is a `meta` row that outlives everything in the book. Folding them
/// into one number would tell a person that four pictures are missing without
/// saying whether one of them is the thing on the front of their book.
pub fn covers_named(store: &Store) -> Result<u64, String> {
    let mut n = 0;
    for side in SIDES {
        if cover_of(store, side)?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

/// What is true about a cover held against the page the book is set on.
///
/// NUMBERS AND FLAGS, NEVER SENTENCES. The words are the page's, because the
/// catalog lives there and this crate holds no writer-facing prose; the
/// arithmetic and both thresholds are the host's, because 040's rule is that the
/// page owns no measurement and a second statement of a threshold is how two
/// statements of one rule end up disagreeing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct CoverCheck {
    pub width_px: u32,
    pub height_px: u32,
    /// Effective resolution on this page at the chosen contain or fill scale.
    pub dpi: u32,
    /// What a printed cover is asked for -- `PRINT_DPI`, carried so the page
    /// can say the figure without holding it.
    pub dpi_wanted: u32,
    /// What this page wants at `dpi_wanted`. The one number a writer can hand
    /// to whoever made their cover.
    pub wanted_width_px: u32,
    pub wanted_height_px: u32,
    pub low_resolution: bool,
    pub wrong_shape: bool,
    pub fit: CoverFit,
}

/// The two findings, or None for a picture with no pixels on one axis.
///
/// None rather than a check full of zeros: every figure below is a ratio against
/// a dimension, so a zero is not a bad cover but a picture there is nothing true
/// to say about -- and it cannot arrive from `pictures::attach`, whose decode
/// would have refused it, only from a file some other tool wrote.
#[cfg(test)]
pub fn check(page: &PageSize, width_px: u32, height_px: u32) -> Option<CoverCheck> {
    check_with_fit(page, width_px, height_px, CoverFit::Contain)
}

pub fn check_with_fit(page: &PageSize, width_px: u32, height_px: u32, fit: CoverFit) -> Option<CoverCheck> {
    if width_px == 0 || height_px == 0 || page.width_um <= 0 || page.height_um <= 0 {
        return None;
    }
    let (w, h) = (u64::from(width_px), u64::from(height_px));
    let (pw, ph) = (page.width_um as u64, page.height_um as u64);

    // Contain scales until the first image edge meets the trim; fill scales
    // until the last edge meets it, cropping the excess on the other axis.
    let across = w * UM_PER_INCH / pw;
    let down = h * UM_PER_INCH / ph;
    let dpi = match fit {
        CoverFit::Contain => across.max(down),
        CoverFit::Fill => across.min(down),
    } as u32;

    // Rounded UP: a cover one pixel short of the requirement does not meet it,
    // and the figure exists to be handed to a designer.
    let wanted = |um: u64| (um * u64::from(PRINT_DPI)).div_ceil(UM_PER_INCH) as u32;

    // CROSS-MULTIPLIED, so the comparison is exact integers and the same pair
    // of proportions cannot compare differently depending which way round it is
    // written. `w/h` against `pw/ph` is `w*ph` against `h*pw`.
    let a = w * ph;
    let b = h * pw;
    let (hi, lo) = if a > b { (a, b) } else { (b, a) };
    let wrong_shape = hi * 100 > lo * (100 + SHAPE_TOLERANCE_PERCENT);

    Some(CoverCheck {
        width_px,
        height_px,
        dpi,
        dpi_wanted: PRINT_DPI,
        wanted_width_px: wanted(pw),
        wanted_height_px: wanted(ph),
        low_resolution: dpi < PRINT_DPI,
        wrong_shape,
        fit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::default_design;
    use tempfile::tempdir;

    fn store(dir: &tempfile::TempDir) -> Store {
        Store::open(&dir.path().join("p.db")).unwrap()
    }

    /// 6 x 9 in, the fiction preset's page and the one every figure below is
    /// worked against.
    fn trade() -> PageSize {
        default_design().page
    }

    #[test]
    fn covers_need_no_schema_version_of_their_own() {
        // `meta` has existed since v1 and a key is DATA, so nothing here is a
        // shape an older file cannot already hold. Cover choices add no schema.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let before = s.user_version().unwrap();
        set_cover(&s, SIDE_FRONT, "0198c0de-dead.jpg").unwrap();
        assert_eq!(
            s.user_version().unwrap(),
            before,
            "recording a cover moved the schema version"
        );
    }

    #[test]
    fn a_book_nobody_has_given_a_cover_names_neither_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        assert_eq!(cover_of(&s, SIDE_FRONT).unwrap(), None);
        assert_eq!(cover_of(&s, SIDE_BACK).unwrap(), None);
        assert_eq!(covers_named(&s).unwrap(), 0);
        // READS ONLY, `design_of`'s rule: asking leaves the file as it was.
        assert_eq!(s.get_meta(FRONT_KEY).unwrap(), None);
        assert_eq!(s.get_meta(BACK_KEY).unwrap(), None);
    }

    #[test]
    fn the_two_sides_are_two_rows_and_neither_can_reach_the_other() {
        // The whole of "front and back": setting one must not be readable as
        // the other, and a mutation returning one key for both sides is what
        // this exists to kill.
        let dir = tempdir().unwrap();
        let s = store(&dir);

        set_cover(&s, SIDE_FRONT, "a.jpg").unwrap();

        assert_eq!(cover_of(&s, SIDE_FRONT).unwrap().as_deref(), Some("a.jpg"));
        assert_eq!(cover_of(&s, SIDE_BACK).unwrap(), None);
        assert_eq!(covers_named(&s).unwrap(), 1);

        set_cover(&s, SIDE_BACK, "b.png").unwrap();

        assert_eq!(cover_of(&s, SIDE_FRONT).unwrap().as_deref(), Some("a.jpg"));
        assert_eq!(cover_of(&s, SIDE_BACK).unwrap().as_deref(), Some("b.png"));
        assert_eq!(covers_named(&s).unwrap(), 2);
        // The two KEYS, asserted as literals: they are in a writer's file
        // forever and a rename of one is a cover nobody can find again.
        assert_eq!(
            s.get_meta("design.cover.front").unwrap().as_deref(),
            Some("a.jpg")
        );
        assert_eq!(
            s.get_meta("design.cover.back").unwrap().as_deref(),
            Some("b.png")
        );
    }

    #[test]
    fn cover_fit_is_per_side_and_defaults_to_showing_all_art() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        assert_eq!(fit_of(&s, SIDE_FRONT).unwrap(), CoverFit::Contain);
        assert_eq!(s.get_meta(FRONT_FIT_KEY).unwrap(), None);
        assert_eq!(set_fit(&s, SIDE_FRONT, "fill").unwrap(), CoverFit::Fill);
        assert_eq!(fit_of(&s, SIDE_FRONT).unwrap(), CoverFit::Fill);
        assert_eq!(fit_of(&s, SIDE_BACK).unwrap(), CoverFit::Contain);
        assert!(set_fit(&s, SIDE_FRONT, "stretch").is_err());
        assert_eq!(s.get_meta(FRONT_FIT_KEY).unwrap().as_deref(), Some("fill"));
    }

    #[test]
    fn replacing_a_cover_hands_back_the_name_it_replaced() {
        // The caller's ONLY chance to delete the file, `cast_set_picture`'s
        // rule: after this call nothing in the book names `a.jpg`.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        assert_eq!(set_cover(&s, SIDE_FRONT, "a.jpg").unwrap(), None);

        let replaced = set_cover(&s, SIDE_FRONT, "b.jpg").unwrap();

        assert_eq!(replaced.as_deref(), Some("a.jpg"));
        assert_eq!(cover_of(&s, SIDE_FRONT).unwrap().as_deref(), Some("b.jpg"));
    }

    #[test]
    fn clearing_a_cover_removes_the_row_and_hands_back_what_it_held() {
        // THE ROW GOES, and the empty string is never stored: "nobody chose
        // one" and "there was one and it was taken off" are the same fact.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        set_cover(&s, SIDE_BACK, "b.png").unwrap();

        let held = clear_cover(&s, SIDE_BACK).unwrap();

        assert_eq!(held.as_deref(), Some("b.png"));
        assert_eq!(s.get_meta(BACK_KEY).unwrap(), None);
        assert_eq!(covers_named(&s).unwrap(), 0);
        // And clearing a cover that is not there is not an error -- the writer
        // asked for a state the book is already in.
        assert_eq!(clear_cover(&s, SIDE_BACK).unwrap(), None);
    }

    #[test]
    fn a_side_this_build_does_not_know_is_refused_by_name_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        assert_eq!(key_for("spine"), None);
        assert!(cover_of(&s, "spine").is_err());
        assert!(set_cover(&s, "spine", "a.jpg").is_err());
        assert!(clear_cover(&s, "spine").is_err());
        assert_eq!(s.get_meta("design.cover.spine").unwrap(), None);
    }

    #[test]
    fn a_cover_row_holding_something_this_build_would_never_write_is_answered_as_it_stands() {
        // IT IS NOT REFUSED HERE and it is not cleared. `pictures::view` tags
        // it `unreadable`, which is the one answer true whether or not
        // something exists at the end of it -- and a writer whose row was
        // damaged has not asked to forget that their book had a cover.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        s.set_meta(FRONT_KEY, "../../secrets.png").unwrap();

        assert_eq!(
            cover_of(&s, SIDE_FRONT).unwrap().as_deref(),
            Some("../../secrets.png")
        );
        assert_eq!(covers_named(&s).unwrap(), 1);
        assert_eq!(
            crate::pictures::view(dir.path(), Some("../../secrets.png")).state,
            crate::pictures::VIEW_UNREADABLE
        );
    }

    #[test]
    fn a_cover_made_for_this_page_at_print_resolution_has_nothing_said_about_it() {
        // 6 x 9 in at 300 dpi is exactly 1800 x 2700, and that is the cover
        // this application asks for. Both flags false, which is the control for
        // every fixture below: without it a check that ALWAYS complained would
        // satisfy all of them.
        let c = check(&trade(), 1800, 2700).unwrap();
        assert_eq!((c.dpi, c.dpi_wanted), (300, 300));
        assert_eq!((c.wanted_width_px, c.wanted_height_px), (1800, 2700));
        assert!(!c.low_resolution, "{c:?}");
        assert!(!c.wrong_shape, "{c:?}");
    }

    #[test]
    fn the_resolution_follows_the_chosen_scale() {
        // Filling the trim enlarges this wide picture until it covers the
        // page, so its short axis limits sharpness. Containing it scales by
        // the long axis and leaves bands instead of claiming pixels it lacks.
        let c = check_with_fit(&trade(), 1800, 1350, CoverFit::Fill).unwrap();
        assert_eq!(c.dpi, 150);
        assert!(c.low_resolution);
        let contained = check_with_fit(&trade(), 1800, 1350, CoverFit::Contain).unwrap();
        assert_eq!(contained.dpi, 300);
        assert!(!contained.low_resolution);
        assert!(contained.wrong_shape);

        let c = check_with_fit(&trade(), 900, 2700, CoverFit::Fill).unwrap();
        assert_eq!(c.dpi, 150);
        assert!(c.low_resolution);
    }

    #[test]
    fn the_resolution_threshold_is_tested_at_its_own_boundary() {
        // A threshold test far from the boundary tests the arithmetic, not the
        // comparison -- the recorded reason five gates had untested edges. One
        // dpi under and exactly at.
        assert!(check(&trade(), 1800, 2700).unwrap().low_resolution == false);
        // 1794 x 2691 is 299 dpi on both axes and the same proportion, so this
        // fixture moves ONLY the resolution.
        let under = check(&trade(), 1794, 2691).unwrap();
        assert_eq!(under.dpi, 299);
        assert!(under.low_resolution);
        assert!(
            !under.wrong_shape,
            "the fixture moved two things: {under:?}"
        );
    }

    #[test]
    fn a_low_resolution_cover_of_the_right_shape_is_not_called_the_wrong_shape() {
        // ONE FIXTURE PER FINDING. 900 x 1350 is exactly half of 1800 x 2700,
        // so the proportion is exact and only the resolution is short. A check
        // whose two flags were one would pass every other test here.
        let c = check(&trade(), 900, 1350).unwrap();
        assert!(c.low_resolution);
        assert!(!c.wrong_shape, "{c:?}");
    }

    #[test]
    fn a_wrong_shaped_cover_with_pixels_to_spare_is_not_called_low_resolution() {
        // The other half of the pair: 3000 x 3000 on a 6 x 9 page is 333 dpi on
        // its worse axis -- over the bar -- and square, which a 2:3 page is not.
        let c = check_with_fit(&trade(), 3000, 3000, CoverFit::Fill).unwrap();
        assert_eq!(c.dpi, 333);
        assert!(!c.low_resolution, "{c:?}");
        assert!(c.wrong_shape, "{c:?}");
    }

    #[test]
    fn the_shape_check_is_the_same_answer_whichever_way_the_cover_is_out() {
        // A cover TALLER than the page and one WIDER than it are both wrong,
        // and a comparison written one way round answers only one of them.
        // 1800 x 3000 is too tall for 2:3; 3000 x 2700 is too wide.
        assert!(check(&trade(), 1800, 3000).unwrap().wrong_shape);
        assert!(check(&trade(), 3000, 2700).unwrap().wrong_shape);
    }

    #[test]
    fn the_shape_tolerance_is_tested_at_its_own_boundary_from_both_sides() {
        // The page is 152400 x 228600. A cover 1800 wide is right at 2700 tall;
        // 2727 is exactly 1% taller, which the tolerance ADMITS, and 2728 is
        // past it. Anything further from the edge tests the arithmetic rather
        // than the comparison.
        let page = trade();
        assert!(!check(&page, 1800, 2727).unwrap().wrong_shape);
        assert!(check(&page, 1800, 2728).unwrap().wrong_shape);
        // And the same boundary on the other side of the ratio.
        assert!(!check(&page, 1800, 2674).unwrap().wrong_shape);
        assert!(check(&page, 1800, 2673).unwrap().wrong_shape);
    }

    #[test]
    fn the_ebook_cover_a_writer_actually_brings_is_the_case_this_catches() {
        // An ebook cover at 1600 x 2560 is taller than the 6 x 9 trim.
        let c = check(&trade(), 1600, 2560).unwrap();
        assert!(c.wrong_shape, "{c:?}");
        assert_eq!(c.dpi, 284);
        assert!(c.low_resolution);
    }

    #[test]
    fn the_check_follows_the_page_the_book_is_actually_set_on() {
        // THE CHECK IS STATE AND NOT A VERDICT TAKEN AT IMPORT. The same cover
        // is right for one page and wrong for another, so a notice raised once
        // when the file was chosen would be stale the moment a writer pressed a
        // design preset. 1800 x 2700 is exact on 6 x 9 and wrong on 7 x 10.
        let large = crate::design::preset(crate::design::PRESET_NON_FICTION)
            .unwrap()
            .page;
        assert!(!check(&trade(), 1800, 2700).unwrap().wrong_shape);
        assert!(check(&large, 1800, 2700).unwrap().wrong_shape);
        // And what that page wants instead, which is what the writer is told.
        let c = check(&large, 1800, 2700).unwrap();
        assert_eq!((c.wanted_width_px, c.wanted_height_px), (2100, 3000));
    }

    #[test]
    fn the_size_a_page_wants_is_rounded_UP_and_a_metric_page_is_where_that_shows() {
        // EVERY INCH PAGE IS EXACT at 300 dpi -- 6 in is 1800 px and 7 in is
        // 2100 -- so on those the rounding is invisible and a floor and a
        // ceiling agree. A5 is 148 x 210 mm, where 300 dpi is 1748.03 x 2480.3:
        // the only fixture here that can tell them apart. A cover one pixel
        // short of the requirement does not meet it, and this figure exists to
        // be handed to whoever is making the cover.
        let a5 = PageSize {
            width_um: 148_000,
            height_um: 210_000,
            name: Some("a5".to_string()),
        };
        let c = check(&a5, 1800, 2700).unwrap();
        assert_eq!((c.wanted_width_px, c.wanted_height_px), (1749, 2481));
    }

    #[test]
    fn a_picture_with_no_pixels_on_one_axis_has_nothing_said_about_it() {
        // None rather than a check full of zeros: every figure is a ratio
        // against a dimension. It cannot arrive from `pictures::attach`, whose
        // decode refuses it; it can arrive from a file another tool wrote.
        assert_eq!(check(&trade(), 0, 2700), None);
        assert_eq!(check(&trade(), 1800, 0), None);
    }

    #[test]
    fn a_cover_survives_the_file_being_closed_and_reopened() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        {
            let s = Store::open(&path).unwrap();
            set_cover(&s, SIDE_FRONT, "0198c0de-dead.jpg").unwrap();
        }
        let s = Store::open_readonly(&path).unwrap();
        assert_eq!(
            cover_of(&s, SIDE_FRONT).unwrap().as_deref(),
            Some("0198c0de-dead.jpg")
        );
    }

    #[test]
    fn a_cover_is_not_part_of_the_book_design_the_page_can_write() {
        // THE CONTAINMENT, asserted rather than left to a comment. A cover name
        // is a filename on disk and `book_design_set` carries values the
        // WEBVIEW composed; if the two ever met, a page could name a file. So a
        // whole design written over a book with covers must leave both rows
        // exactly as they were, BY CONSTRUCTION -- there is no cover in the
        // arguments to get wrong.
        let dir = tempdir().unwrap();
        let s = store(&dir);
        set_cover(&s, SIDE_FRONT, "a.jpg").unwrap();
        set_cover(&s, SIDE_BACK, "b.png").unwrap();

        crate::design::write_design(
            &s,
            &crate::design::preset(crate::design::PRESET_NON_FICTION).unwrap(),
        )
        .unwrap();

        assert_eq!(cover_of(&s, SIDE_FRONT).unwrap().as_deref(), Some("a.jpg"));
        assert_eq!(cover_of(&s, SIDE_BACK).unwrap().as_deref(), Some("b.png"));
    }
}
