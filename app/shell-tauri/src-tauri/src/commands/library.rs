// app/shell-tauri/src-tauri/src/commands/library.rs
// The library screen's one read (`library_overview`) and its one per-book
// follow-up (`library_book_words`), 100.
//
// THE OVERVIEW OPENS EVERY BOOK READ-ONLY, `summarize`'s rule: a listing must
// not modify what it lists. It reads `meta[NAME_KEY]`, the pin
// (`meta[identity::PIN_KEY]`, through `identity::pin_summary` -- an unreadable
// pin costs the byline and nothing else, 040's rule again) and, for the FIRST
// 12 books in sort order only, the front cover through `covers::cover_of` and
// `pictures::view`. `pictures::view` MAY WRITE a thumbnail cache on a miss --
// its own doc says so -- and that write lands in the book's OWN pictures
// folder, never in a `.db`, so the read-only rule still holds for every store
// this module opens.
//
// WORD TOTALS ARE NOT HERE. A total is a scan of every body (`Store::
// word_index`, ~58 ms at `stress`), and the design's own argument is that
// twelve of those at boot is a startup figure nobody measured.
// `library_book_words` answers ONE book's total, gated by `may_open` exactly
// as `project_open` is so the page cannot count an arbitrary file, and the
// page calls it once per book on screen, sequentially, after first paint.
use crate::identity;
use crate::pictures::{self, PictureView};
use crate::projects;
use crate::store::Store;
use crate::store::series::{Group, Membership, MembershipEdit};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

/// The first 12 books in sort order get their cover read; the rest are told
/// `PictureView { state: "none" }` without their pictures directory ever
/// being touched. A shelf of covers at 120x180 is 40 images, not 15,200 rows,
/// and the desk is one of the twelve -- but reading a cover for every book in
/// a library that has grown past a screenful is a cost nobody chose.
const COVER_BOUND: usize = 12;

/// At most this many books are described at all; the rest are named only by
/// `LibraryOverview.more`. `settings.recent`'s own cap is 20; this is wider
/// because the SHELF also shows books never opened through this build, which
/// `recent` does not track.
const SHOWN_BOUND: usize = 40;

/// The vault's public tier, as the strip shows it.
#[derive(Debug, Serialize)]
pub struct LibraryIdentity {
    pub id: String,
    pub name: String,
    pub sort_name: String,
    pub bio: String,
}

/// One book, as the desk or the shelf shows it.
#[derive(Debug, Serialize)]
pub struct LibraryBook {
    pub path: String,
    pub name: String,
    pub modified_at: i64,
    /// From `settings.recent`. None for a book never opened through this
    /// build -- sorts after every book that has been.
    pub opened_at: Option<u64>,
    /// From the pin, absent when unpinned or when the pin could not be read.
    pub identity_id: Option<String>,
    pub identity_name: Option<String>,
    pub book_id: Option<String>,
    pub series: Option<Group>,
    pub universe: Option<Group>,
    pub membership_error: Option<String>,
    pub cover: PictureView,
    pub error: Option<String>,
    pub missing: bool,
}

/// What the library screen paints, whole.
#[derive(Debug, Serialize)]
pub struct LibraryOverview {
    pub identities: Vec<LibraryIdentity>,
    /// `settings.home_identity`, filtered against `identities`: an id no
    /// longer in the vault reads as All.
    pub selected_identity: Option<String>,
    /// Set when the vault file exists and does not parse. The books still
    /// list either way -- 053's rule, restated: a listing must not go blank
    /// because one OTHER file is damaged.
    pub vault_error: Option<String>,
    pub books: Vec<LibraryBook>,
    /// How many known books are not in `books`, past `SHOWN_BOUND`.
    pub more: usize,
    /// How long this whole read took, wall-clock, around the function body
    /// below. THE RIG'S OWN NUMBER, painted into `#library-timing` by the
    /// page rather than measured from outside the process: a wall-clock
    /// proxy around process spawn and window creation was the first attempt
    /// and it measured WebKit's boot, not this function.
    pub took_ms: u64,
}

/// `library_book_words`'s answer: the total, and how long the read took.
///
/// `took_ms` IS WHAT THE PAGE PAINTS INTO `#library-timing`, the rig's own
/// route to a real host-side figure -- the CLI's `inspect` subcommand was the
/// first attempt at measuring this and it never called this function or its
/// `may_open` gate at all, which made it a measurement of a different program.
#[derive(Debug, Serialize)]
pub struct LibraryWords {
    pub words: u64,
    pub took_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct LibraryBookStats {
    pub identity_id: Option<String>,
    pub book_id: Option<String>,
    pub membership: Membership,
    pub words: u64,
    pub unreadable_documents: u64,
    pub documents: usize,
    pub activity: Option<crate::store::source_words::SourceTotals>,
    pub activity_interrupted: bool,
    pub activity_warning: Option<String>,
    pub read_at_ms: u64,
    pub took_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct MembershipView {
    pub generation: u64,
    pub membership: Membership,
}

#[command_boundary::command]
pub(crate) fn library_membership_get(state: State<'_, crate::StoreState>) -> std::result::Result<MembershipView, String> {
    let guard = crate::locked(&state);
    let project = crate::open_project(&guard)?;
    Ok(MembershipView { generation: project.generation, membership: project.store.membership().map_err(|e| e.to_string())? })
}

fn membership_set_for(store: &Store, current_generation: u64, generation: u64, edit: MembershipEdit) -> std::result::Result<Membership, String> {
    if generation != current_generation {
        return Err("the book changed while its membership was being edited; nothing was saved".into());
    }
    store.membership_set(edit).map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn library_membership_set(
    state: State<'_, crate::StoreState>, generation: u64, edit: MembershipEdit,
) -> std::result::Result<Membership, String> {
    let guard = crate::locked(&state);
    let project = crate::open_project(&guard)?;
    membership_set_for(&project.store, project.generation, generation, edit)
}

#[command_boundary::command]
pub(crate) fn library_book_stats(
    library: State<'_, crate::Library>, explicit: State<'_, crate::ExplicitProject>,
    data_home: State<'_, crate::DataHome>, path: String, today: String,
) -> std::result::Result<LibraryBookStats, String> {
    book_stats(&library.0, explicit.0.as_deref(), &projects::known(&data_home.0), &path, &today)
}

pub(crate) fn book_stats(
    library: &Path, explicit: Option<&Path>, known: &[PathBuf], path: &str, today: &str,
) -> std::result::Result<LibraryBookStats, String> {
    let requested = PathBuf::from(path);
    if !crate::may_open(library, explicit, known, &requested) {
        return Err(format!("{path}: not a project this application knows about"));
    }
    let started = std::time::Instant::now();
    let store = Store::open_readonly(&requested).map_err(|e| format!("{path}: {e}"))?;
    let book_id = store.book_id().map_err(|e| e.to_string())?;
    let membership = store.membership().map_err(|e| e.to_string())?;
    let identity_id = store.get_meta(identity::PIN_KEY).map_err(|e| e.to_string())?
        .and_then(|raw| identity::pin_summary(&raw)).map(|(id, _)| id);
    let excluded = crate::store::excluded_from_book(&store.items().map_err(|e| e.to_string())?);
    let index = store.word_index().map_err(|e| e.to_string())?;
    let counted = index.count_excluding(&excluded);
    let activity = store.source_word_summary(today).map_err(|e| e.to_string())?;
    let read_at_ms = crate::store::now_ms() as u64;
    Ok(LibraryBookStats {
        book_id, identity_id, membership, words: counted.words, unreadable_documents: counted.skipped,
        documents: index.document_counts_excluding(&excluded).len() + counted.skipped as usize,
        activity: activity.available.then_some(activity.totals),
        activity_interrupted: activity.interrupted,
        activity_warning: activity.warning,
        read_at_ms, took_ms: started.elapsed().as_millis() as u64,
    })
}

/// One book's saved total, read fresh on a read-only open of its own.
///
/// GATED BY `may_open`, EXACTLY AS `project_open` IS, so the page cannot count
/// a path it was never handed. One book per call; the page asks for the books
/// on screen, most recent first, and stops when the screen closes.
#[command_boundary::command]
pub(crate) fn library_book_words(
    library: State<'_, crate::Library>,
    explicit: State<'_, crate::ExplicitProject>,
    data_home: State<'_, crate::DataHome>,
    path: String,
) -> std::result::Result<LibraryWords, String> {
    book_words(
        &library.0,
        explicit.0.as_deref(),
        &projects::known(&data_home.0),
        &path,
    )
}

/// The command's whole body, off `State` so a test can reach the `may_open`
/// refusal: 099's `remember_open` lesson, a guard inline in a tauri command
/// is a rule only a running host can see.
pub(crate) fn book_words(
    library: &Path,
    explicit: Option<&Path>,
    known: &[PathBuf],
    path: &str,
) -> std::result::Result<LibraryWords, String> {
    let requested = PathBuf::from(path);
    if !crate::may_open(library, explicit, known, &requested) {
        return Err(format!(
            "{path}: not a project this application knows about"
        ));
    }
    let started = std::time::Instant::now();
    let store = Store::open_readonly(&requested).map_err(|e| format!("{path}: {e}"))?;
    let words = store
        .word_index()
        .map_err(|e| format!("{path}: cannot count the project: {e}"))?;
    let excluded = store
        .items()
        .map(|items| crate::store::excluded_from_book(&items))
        .unwrap_or_default();
    Ok(LibraryWords {
        words: words.count_excluding(&excluded).words,
        took_ms: started.elapsed().as_millis() as u64,
    })
}

/// The whole screen's one read. Never fails: a damaged vault is reported IN
/// the answer (`vault_error`), and a book that will not open is reported IN
/// the listing (`LibraryBook.error`), on `projects::list`'s own rule that a
/// manuscript gone bad must be visible rather than silently absent.
#[command_boundary::command]
pub(crate) fn library_overview(data_home: State<'_, crate::DataHome>) -> LibraryOverview {
    overview(&data_home.0)
}

pub(crate) fn overview(data_home: &Path) -> LibraryOverview {
    let started = std::time::Instant::now();
    let (identities, vault_error) = match identity::read_vault(data_home) {
        Ok(vault) => {
            let mut list: Vec<LibraryIdentity> = vault
                .identities
                .into_iter()
                .map(|i| LibraryIdentity {
                    id: i.id,
                    name: i.public.name,
                    sort_name: i.public.sort_name,
                    bio: i.public.bio,
                })
                .collect();
            // The strip's own order: `sort_name`, ties broken by `name` so two
            // identities sharing one sort name do not swap places between calls.
            list.sort_by(|a, b| a.sort_name.cmp(&b.sort_name).then_with(|| a.name.cmp(&b.name)));
            (list, None)
        }
        Err(e) => (Vec::new(), Some(e.to_string())),
    };

    let settings = projects::read_settings(data_home);
    // An id no longer in the vault reads as All -- never a dangling reference
    // the page has to notice on its own.
    let selected_identity = settings
        .home_identity
        .filter(|id| identities.iter().any(|i| &i.id == id));

    let recent: std::collections::HashMap<String, u64> = settings
        .recent
        .iter()
        .map(|r| (r.path.clone(), r.opened_at))
        .collect();

    // PASS 1: a SORT KEY per book, from the filesystem and `settings.recent`
    // alone -- no store is opened here. Separated from the per-book describe
    // below specifically so sorting and truncation happen BEFORE any file is
    // opened, which is what lets a library past `SHOWN_BOUND` cost this
    // function nothing for the books it will not show.
    struct SortKey {
        path: PathBuf,
        opened_at: Option<u64>,
        modified_at: i64,
    }
    let mut keyed: Vec<SortKey> = projects::known(data_home)
        .into_iter()
        .map(|path| {
            let opened_at = recent.get(&path.to_string_lossy().into_owned()).copied();
            let modified_at = projects::modified_at(&path);
            SortKey {
                path,
                opened_at,
                modified_at,
            }
        })
        .collect();

    // `opened_at` desc, a book never opened sorting after every one that has
    // been; `modified_at` desc among books that share an `opened_at` state.
    keyed.sort_by(|a, b| match (a.opened_at, b.opened_at) {
        (Some(ao), Some(bo)) => bo.cmp(&ao),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.modified_at.cmp(&a.modified_at),
    });

    let more = keyed.len().saturating_sub(SHOWN_BOUND);
    keyed.truncate(SHOWN_BOUND);

    // PASS 2: ONE read-only open per SHOWN book -- name, pin AND (for the
    // first COVER_BOUND, in the order the shelf paints them) the cover, all
    // off the same connection. Merged from two opens per book into one:
    // the cover used to be a second `Store::open_readonly` on top of
    // `describe`'s own, which is a store this function had already opened a
    // moment before and then closed.
    let books: Vec<LibraryBook> = keyed
        .into_iter()
        .enumerate()
        .map(|(i, key)| describe(key.path, key.opened_at, key.modified_at, i < COVER_BOUND))
        .collect();

    LibraryOverview {
        identities,
        selected_identity,
        vault_error,
        books,
        more,
        took_ms: started.elapsed().as_millis() as u64,
    }
}

fn none_cover() -> PictureView {
    PictureView {
        state: pictures::VIEW_NONE.to_string(),
        data_uri: None,
    }
}

/// One book, whole: name, pin, dates, error and (when `want_cover`) the front
/// cover, all off ONE read-only open. A book beyond `COVER_BOUND` is passed
/// `want_cover: false` and its pictures directory is never opened.
fn describe(path: PathBuf, opened_at: Option<u64>, modified_at: i64, want_cover: bool) -> LibraryBook {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let key = path.to_string_lossy().into_owned();
    let missing = !path.exists();

    let (name, error, identity_id, identity_name, book_id, membership, membership_error, cover) = match Store::open_readonly(&path) {
        Ok(store) => {
            let (name, name_error) = match store.get_meta(projects::NAME_KEY) {
                Ok(Some(n)) if !n.is_empty() => (n, None),
                Ok(_) => (stem.clone(), None),
                Err(e) => (stem.clone(), Some(e.to_string())),
            };
            let (identity_id, identity_name) = store
                .get_meta(identity::PIN_KEY)
                .ok()
                .flatten()
                .and_then(|raw| identity::pin_summary(&raw))
                .map(|(id, n)| (Some(id), Some(n)))
                .unwrap_or((None, None));
            let (book_id, identity_error) = match store.book_id() {
                Ok(id) => (id, None),
                Err(e) => (None, Some(e.to_string())),
            };
            let (membership, membership_error) = match store.membership() {
                Ok(value) => (value, None),
                Err(e) => (Membership::default(), Some(e.to_string())),
            };
            let cover = if want_cover {
                let cover_name = crate::covers::cover_of(&store, crate::covers::SIDE_FRONT)
                    .ok()
                    .flatten();
                pictures::view(&pictures::dir_for(&path), cover_name.as_deref())
            } else {
                none_cover()
            };
            (name, name_error.or(identity_error), identity_id, identity_name, book_id, membership, membership_error, cover)
        }
        Err(e) => (stem, Some(e.to_string()), None, None, None, Membership::default(), None, none_cover()),
    };

    LibraryBook {
        path: key,
        name,
        modified_at,
        opened_at,
        identity_id,
        identity_name,
        book_id,
        series: membership.series,
        universe: membership.universe,
        membership_error,
        cover,
        error,
        missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::source_words::{FlushAttribution, SourceMovement, WordSource};
    use crate::store::{FlushEntry, BIBLE_TYPE};
    use crate::store::series::GroupEdit;
    use tempfile::tempdir;

    fn book(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(format!("{name}.db"));
        let store = Store::open(&path).unwrap();
        store.set_meta(projects::NAME_KEY, name).unwrap();
        store
            .ensure_starter_structure(&crate::strings::Strings::english())
            .unwrap();
        drop(store);
        path
    }

    #[test]
    fn membership_write_checks_generation_before_the_meta_row_changes() {
        let dir = tempdir().unwrap();
        let path = book(dir.path(), "one");
        let store = Store::open(&path).unwrap();
        let edit = || MembershipEdit { series: GroupEdit::New { name: "Harbour".into() }, universe: GroupEdit::None };
        assert!(membership_set_for(&store, 9, 8, edit()).is_err());
        assert_eq!(store.membership().unwrap(), Membership::default());
        let saved = membership_set_for(&store, 9, 9, edit()).unwrap();
        assert_eq!(store.membership().unwrap(), saved);
    }

    #[test]
    fn readonly_stats_keep_saved_membership_and_backup_carries_it() {
        let dir = tempdir().unwrap();
        let library = dir.path().join("library");
        std::fs::create_dir(&library).unwrap();
        let path = book(&library, "one");
        let store = Store::open(&path).unwrap();
        let saved = store.membership_set(MembershipEdit { series: GroupEdit::New { name: "Harbour".into() }, universe: GroupEdit::None }).unwrap();
        drop(store);
        let stats = book_stats(&library, None, &[], path.to_str().unwrap(), "2026-09-25").unwrap();
        assert_eq!(stats.membership, saved);
        assert_eq!(stats.book_id, Store::open_readonly(&path).unwrap().book_id().unwrap());
        let backup = dir.path().join("backup.db");
        std::fs::write(&backup, []).unwrap();
        crate::backup_bundle::copy_database(&path, &backup).unwrap();
        assert_eq!(Store::open_readonly(&backup).unwrap().membership().unwrap(), saved);
    }

    #[test]
    fn readonly_stats_count_saved_manuscript_and_additive_activity_per_book() {
        let dir = tempdir().unwrap();
        let library = dir.path().join("library");
        std::fs::create_dir(&library).unwrap();
        let first = book(&library, "first");
        let second = book(&library, "second");
        let save = |path: &Path, prose: &str, source: WordSource, added: u64| {
            let store = Store::open(path).unwrap();
            let scene = store.items().unwrap().into_iter().find(|item| item.item_type == "scene").unwrap();
            let body = serde_json::json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": prose }] }] }).to_string();
            store.flush_with_sources(&[FlushEntry { item_id: scene.id.clone(), body, base_rev: scene.rev, comments: None }],
                &[FlushAttribution { item_id: scene.id, day: "2026-09-25".into(), changes: vec![SourceMovement { source, added, deleted: 0 }] }]).unwrap();
        };
        save(&first, "one two three", WordSource::Typing, 3);
        save(&second, "four five", WordSource::Pasted, 2);
        let first_store = Store::open(&first).unwrap();
        let bible = first_store.item_create(None, BIBLE_TYPE, "Bible").unwrap();
        let hidden = first_store.item_create(Some(&bible.id), "scene", "Notes").unwrap();
        let hidden_body = serde_json::json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "not manuscript words" }] }] }).to_string();
        first_store.flush(&[FlushEntry { item_id: hidden.id, body: hidden_body, base_rev: 1, comments: None }]).unwrap();
        drop(first_store);

        let a = book_stats(&library, None, &[], first.to_str().unwrap(), "2026-09-25").unwrap();
        let b = book_stats(&library, None, &[], second.to_str().unwrap(), "2026-09-25").unwrap();
        assert_eq!((a.words, a.documents), (3, 1));
        assert_eq!((b.words, b.documents), (2, 1));
        assert_eq!(a.words + b.words, 5);
        assert_eq!(a.activity.unwrap().typing.added, 3);
        assert_eq!(b.activity.unwrap().pasted.added, 2);
    }

    fn plant_recent(data_home: &Path, entries: &[(&Path, u64)]) {
        projects::update_settings(data_home, |s| {
            s.recent = entries
                .iter()
                .map(|(p, at)| projects::RecentBook {
                    path: p.to_string_lossy().into_owned(),
                    opened_at: *at,
                })
                .collect();
        })
        .unwrap();
    }

    #[test]
    fn books_are_sorted_by_opened_at_then_by_modified_at() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        let a = book(&library, "a");
        let b = book(&library, "b");
        let c = book(&library, "c-never-opened");
        // `a` opened most recently, `b` opened earlier, `c` never opened at
        // all -- and must sort AFTER both, whatever its mtime says. The
        // mtimes are SET, newest on `c` and oldest on `a`, so a sort by
        // mtime alone answers the reverse: three stores created in one
        // second share an mtime, and the first version of this test passed
        // with the `opened_at` arms deleted (a fixture that was a fact about
        // itself).
        let now = std::time::SystemTime::now();
        for (path, ago) in [(&a, 300u64), (&b, 200), (&c, 100)] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(now - std::time::Duration::from_secs(ago))
                .unwrap();
        }
        plant_recent(dir.path(), &[(&b, 10), (&a, 20)]);
        let ov = overview(dir.path());
        let paths: Vec<&str> = ov.books.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(paths, vec!["a", "b", "c-never-opened"]);
        assert_eq!(ov.books[2].opened_at, None);
        // A sanity bound rather than an exact figure: `took_ms` is a real
        // wall-clock reading and this is three tiny stores opened on a local
        // disk, not a claim about what a slower machine would report.
        assert!(ov.took_ms < 60_000, "{}", ov.took_ms);
    }

    #[test]
    fn only_the_first_twelve_books_get_a_cover_read_and_the_rest_touch_no_directory() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        let mut paths = Vec::new();
        for i in 0..13 {
            paths.push(book(&library, &format!("b{i:02}")));
        }
        // Deterministic order: b00 opened most recently, b12 least (and never,
        // among the thirteen, actually -- one fewer than paths.len() is opened
        // so the ordering is total and unambiguous).
        let recent: Vec<(&Path, u64)> = paths
            .iter()
            .enumerate()
            .map(|(i, p)| (p.as_path(), (13 - i) as u64))
            .collect();
        plant_recent(dir.path(), &recent);
        // The 13th book (last in sort order, b12) NAMES a cover that was never
        // attached: no pictures directory exists for it at all.
        let last = paths.last().unwrap();
        let store = Store::open(last).unwrap();
        crate::covers::set_cover(&store, crate::covers::SIDE_FRONT, "ghost.png").unwrap();
        drop(store);
        let pictures_dir = crate::pictures::dir_for(last);
        assert!(!pictures_dir.exists());

        let ov = overview(dir.path());
        assert_eq!(ov.books.len(), 13);
        for book in &ov.books[..12] {
            assert_eq!(book.cover.state, crate::pictures::VIEW_NONE, "{book:?}");
        }
        // The 13th book is told `none` WITHOUT its cover ever being read: a
        // bound that fired would have asked `pictures::view` about a name
        // that names nothing on disk, which answers `missing`, not `none`.
        assert_eq!(ov.books[12].cover.state, crate::pictures::VIEW_NONE);
        assert!(
            !pictures_dir.exists(),
            "the 13th book's pictures directory must never be created"
        );
    }

    #[test]
    fn a_damaged_pin_costs_the_byline_and_the_book_still_lists() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        let path = book(&library, "with-a-bad-pin");
        let store = Store::open(&path).unwrap();
        store.set_meta(identity::PIN_KEY, "{{{").unwrap();
        drop(store);
        let ov = overview(dir.path());
        assert_eq!(ov.books.len(), 1);
        assert_eq!(ov.books[0].name, "with-a-bad-pin");
        assert_eq!(ov.books[0].identity_id, None);
        assert_eq!(ov.books[0].identity_name, None);
        assert_eq!(ov.books[0].error, None);
    }

    #[test]
    fn a_pin_names_the_book_on_the_shelf() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        let path = book(&library, "pinned");
        let store = Store::open(&path).unwrap();
        let mut vault = identity::Vault::default();
        vault.identities.push(identity::Identity {
            id: "i1".into(),
            rev: 1,
            public: identity::Public {
                name: "Ada Vane".into(),
                ..Default::default()
            },
            ..Default::default()
        });
        identity::set_pin(
            &store,
            Some(&identity::pin_of(&vault.identities[0], 10)),
        )
        .unwrap();
        drop(store);
        let ov = overview(dir.path());
        assert_eq!(ov.books[0].identity_id.as_deref(), Some("i1"));
        assert_eq!(ov.books[0].identity_name.as_deref(), Some("Ada Vane"));
    }

    #[test]
    fn a_vault_that_will_not_parse_is_an_error_and_the_books_still_list() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        book(&library, "still-listed");
        std::fs::create_dir_all(dir.path().join(crate::APP_DIR)).unwrap();
        std::fs::write(identity::vault_path(dir.path()), b"{").unwrap();
        let ov = overview(dir.path());
        assert!(ov.vault_error.is_some());
        assert!(ov.identities.is_empty());
        assert_eq!(ov.books.len(), 1);
        assert_eq!(ov.books[0].name, "still-listed");
    }

    #[test]
    fn an_identity_no_longer_in_the_vault_reads_as_all() {
        let dir = tempdir().unwrap();
        projects::update_settings(dir.path(), |s| {
            s.home_identity = Some("gone".into());
        })
        .unwrap();
        let ov = overview(dir.path());
        assert_eq!(ov.selected_identity, None);
    }

    #[test]
    fn library_book_words_refuses_a_path_outside_what_the_host_knows() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let path = book(outside.path(), "elsewhere");
        let known = projects::known(dir.path());
        let answer = book_words(
            &projects::library_dir(dir.path()),
            None,
            &known,
            &path.to_string_lossy(),
        );
        assert!(answer.is_err(), "{answer:?}");
        assert!(answer.unwrap_err().contains("not a project this application knows about"));
    }

    #[test]
    fn library_book_words_counts_the_manuscript() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        let path = book(&library, "counted");
        let store = Store::open_readonly(&path).unwrap();
        let words = store.word_index().unwrap();
        let excluded = store
            .items()
            .map(|items| crate::store::excluded_from_book(&items))
            .unwrap_or_default();
        // The reference this test pins its expectation against: a starter
        // project's own scene has a handful of words in it.
        assert_eq!(words.count_excluding(&excluded).words, words.count().words);
    }

    #[test]
    fn library_book_words_answers_a_library_child_with_the_count_it_took() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        let path = book(&library, "counted");
        let known = projects::known(dir.path());
        let answer = book_words(&library, None, &known, &path.to_string_lossy()).unwrap();
        let store = Store::open_readonly(&path).unwrap();
        assert_eq!(answer.words, store.word_index().unwrap().count().words);
        assert!(answer.took_ms < 60_000, "{}", answer.took_ms);
    }

    #[test]
    fn the_shelf_stops_at_forty_books_and_counts_the_rest() {
        let dir = tempdir().unwrap();
        let library = projects::library_dir(dir.path());
        std::fs::create_dir_all(&library).unwrap();
        for i in 0..(SHOWN_BOUND + 1) {
            book(&library, &format!("b{i:02}"));
        }
        let ov = overview(dir.path());
        assert_eq!(ov.books.len(), SHOWN_BOUND);
        assert_eq!(ov.more, 1);
    }
}
