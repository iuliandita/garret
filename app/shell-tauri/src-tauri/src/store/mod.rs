// app/shell-tauri/src-tauri/src/store/mod.rs
// The canonical project store. The host owns the connection; the webview
// reaches it only through commands. Schema v1 is carried by PRAGMA
// user_version, not by a row, so there is one place to read it.

pub mod appearances;
pub mod analytics;
pub mod book_identity;
pub mod cast;
pub mod comments;
pub mod crash_child;
pub mod dict;
pub mod history;
pub mod knowledge;
pub mod position;
pub mod revision_planning;
pub mod review;
pub mod review_query;
pub mod seed;
pub mod series;
pub mod source_words;
pub mod synopsis;
pub mod watchlist;

use crate::words;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const SCHEMA_VERSION: i64 = 17;

/// Nesting far beyond anything the product describes (part -> chapter ->
/// scene is 3). A chain this deep means a corrupt file, not a deep book.
const MAX_DEPTH: i64 = 64;

const SCHEMA_V1: &str = "
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE item (
  id        TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES item(id),
  type      TEXT NOT NULL,
  title     TEXT NOT NULL,
  position  TEXT NOT NULL,
  rev       INTEGER NOT NULL DEFAULT 1
);
-- UNIQUE is load-bearing, not hygiene: two siblings sharing a position give
-- their subtrees identical path prefixes, so items() interleaves them while
-- the row count still reconciles and the file reads as healthy.
CREATE UNIQUE INDEX item_sibling ON item(parent_id, position);
-- SQLite treats NULLs as distinct in a unique index, so item_sibling does not
-- constrain root items at all. Roots are exactly what item_create and item_move
-- write when parent_id is None, so without this the backstop is missing at the
-- one level that has no parent row to fall back on.
CREATE UNIQUE INDEX item_root_sibling ON item(position) WHERE parent_id IS NULL;
CREATE TABLE doc (
  item_id    TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// v2 adds history: past states of a document, and the named moments a writer
/// chose to keep. ADDITIVE ONLY -- nothing in v1 changes shape, so the step is
/// three CREATEs and a version bump, and a v1 file carries its prose forward
/// untouched.
///
/// A version holds a KEY, not a body. Content addressing is what makes a
/// manuscript-wide snapshot affordable: taken a minute after the last one it
/// costs one row per document and one blob for the document that changed,
/// rather than a second copy of the whole book. See history.rs for why the key
/// is verified rather than trusted.
///
/// `snapshot_id IS NULL` is what makes a version automatic. A `kind` column
/// beside it would be a second statement of the same fact, free to disagree.
/// v3 adds the revision state: where the writer says each part of the
/// manuscript stands. ADDITIVE ONLY, and one column rather than a table, for
/// two reasons that are the same reason. The state belongs to the item the way
/// its title does, so it must move under the SAME `rev` -- a state written
/// against a stale revision would discard a concurrent rename, and a separate
/// table would have no revision of its own to check without inventing one. And
/// the walk already selects the item's columns, so the state rides out to the
/// page with the row rather than through a join the recursive CTE would have to
/// grow.
///
/// NULL IS `none`, and the word "none" is never stored. Same rule as
/// `data-theme="system"` being removed rather than written, and as an absent
/// word count rendering as nothing rather than 0: a default written as a value
/// is a default free to drift from the code's idea of the default, and it makes
/// "the writer chose none" and "the writer chose nothing" two states of one
/// fact.
///
/// NO CHECK CONSTRAINT, deliberately. The closed set is enforced in
/// `item_set_state`, which is the only writer, and refuses an unknown state
/// before any row moves. A CHECK here would be a second statement of the set --
/// and SQLite cannot alter one, so the day a fifth state is added the ladder
/// step would be a whole-table rebuild of the item table rather than four
/// characters in a Rust array.
const SCHEMA_V3: &str = "
ALTER TABLE item ADD COLUMN state TEXT;
";

const SCHEMA_V2: &str = "
CREATE TABLE blob (
  key  TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE doc_version (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  blob_key    TEXT NOT NULL REFERENCES blob(key),
  created_at  INTEGER NOT NULL,
  words       INTEGER NOT NULL,
  snapshot_id INTEGER REFERENCES snapshot(id) ON DELETE CASCADE
);
CREATE INDEX doc_version_item ON doc_version(item_id, created_at DESC);
CREATE INDEX doc_version_blob ON doc_version(blob_key);
CREATE INDEX doc_version_snap ON doc_version(snapshot_id);
";

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    /// The project was written by a newer build. Refusing is the whole point.
    NewerSchema {
        found: i64,
        supported: i64,
    },
    Conflict {
        item_id: String,
    },
    NotFound {
        item_id: String,
    },
    UnknownItem {
        item_id: String,
    },
    /// A revision state the closed set does not contain. Its own variant rather
    /// than a Corrupt or a Sqlite error because it is the caller's mistake and
    /// nothing was written -- the same distinction Conflict and UnknownItem draw
    /// between "reload and retry" and "stop".
    UnknownState {
        state: String,
    },
    /// A comment id naming no row. Its own variant for the reason UnknownItem
    /// has one: nothing was written and reloading will not help, so the caller
    /// must stop rather than retry.
    UnknownComment {
        id: i64,
    },
    InvalidPlanning(String),
    InvalidReview(String),
    ReviewConflict { group_id: i64 },
    /// An anchor naming a comment that belongs to a DIFFERENT document. Its own
    /// variant rather than UnknownComment because it is not a note that went
    /// missing: the page is wrong about which document it is flushing, and a
    /// note moved onto prose it was never about is the one failure this feature
    /// must not have. Nothing was written, so the caller must stop.
    ForeignComment {
        id: i64,
        item_id: String,
    },
    /// A comment with no text. Refused rather than stored: it would decorate the
    /// writer's prose forever saying nothing.
    EmptyComment,
    /// A comment anchored to nothing. Refused so that a collapsed anchor in the
    /// file can only ever mean an edit destroyed the passage -- see
    /// comments.rs.
    EmptyRange,
    /// One document already holds every note this build will map on the typing
    /// path. See comments::MAX_COMMENTS_PER_DOCUMENT.
    TooManyComments {
        item_id: String,
        limit: i64,
    },
    /// The item is a `timeline`. There is no editor over one in this build, so
    /// no writer ever selected a range inside it to comment on -- an anchor
    /// here would be created collapsed and orphaned the instant it existed.
    TimelineComment,
    /// A cast kind the closed set does not contain. Its own variant for the
    /// reason `UnknownState` has one: it is the caller's mistake, nothing was
    /// written, and reloading will not help.
    UnknownCastKind {
        kind: String,
    },
    /// A cast member id naming no row. Its own variant for the reason
    /// `UnknownItem` has one: nothing was written and the caller must stop
    /// rather than retry.
    UnknownCastMember {
        id: String,
    },
    /// A cast member with no name, after trimming. Refused rather than stored:
    /// a nameless row would sit in the list forever saying nothing, and the name
    /// is the one thing about a cast member a writer cannot avoid choosing.
    EmptyCastName,
    /// A detail field carrying a value under no label. REFUSED rather than
    /// dropped, because dropping it discards something the writer typed. Carries
    /// the value so the message can quote what would have been lost.
    UnlabelledCastField {
        value: String,
    },
    /// An alias under `cast::MIN_ALIAS_LENGTH` characters, after trimming. The
    /// same floor the matcher restates as `MIN_CAST_NAME_LENGTH` on the page:
    /// below it a "name" is too likely to be an ordinary word to mark every
    /// occurrence of it in a manuscript's prose.
    AliasTooShort {
        alias: String,
    },
    /// An alias equal to the member's own name, after trimming. Refused rather
    /// than stored: a name and one of its own aliases naming the same text
    /// would be two rows saying one thing.
    AliasIsName {
        alias: String,
    },
    /// The same alias twice under one member, after trimming. Refused rather
    /// than stored: a repeated alias is one row of information typed twice,
    /// not two facts.
    AliasRepeated {
        alias: String,
    },
    /// A word with nothing in it, after trimming. Refused rather than stored:
    /// it would sit in the panel and in every rendered `.dic` file saying
    /// nothing.
    EmptyWord,
    /// A word already on the project's list. Its own variant rather than a raw
    /// UNIQUE constraint error, so the writer hears "already there" instead of
    /// a SQLite string.
    DuplicateWord {
        word: String,
    },
    /// A word named for removal that is not on the project's list.
    UnknownWord {
        word: String,
    },
    Seed(String),
    /// Two neighbours in a sibling group are adjacent in the key alphabet with
    /// nothing expressible between them, so the item has nowhere to land. The
    /// move is refused whole; the message reaches the writer, so it says what
    /// happened rather than naming an internal remedy.
    NoRoom {
        parent_id: Option<String>,
    },
    /// The file's rows do not form a tree: an orphan, a cycle, or an
    /// impossible depth. Distinguished from Sqlite because it means the data
    /// is wrong, not the query.
    Corrupt(String),
    /// The local day supplied by the page is caller input, not ledger damage.
    /// Keep it distinct so an invalid request cannot masquerade as unavailable
    /// stored statistics.
    InvalidSourceWordDay {
        day: String,
    },
    BookIdentityChanged,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "sqlite: {e}"),
            StoreError::NewerSchema { found, supported } => write!(
                f,
                "project schema v{found} is newer than supported v{supported}; \
                 refusing to open rather than risk data loss"
            ),
            StoreError::Conflict { item_id } => {
                write!(f, "conflict: {item_id} changed underneath this flush")
            }
            StoreError::NotFound { item_id } => write!(f, "no document for item {item_id}"),
            StoreError::UnknownItem { item_id } => {
                write!(f, "no item {item_id} to attach a document to")
            }
            StoreError::UnknownState { state } => write!(
                f,
                "{state} is not a revision state this build knows; nothing was changed"
            ),
            StoreError::UnknownComment { id } => {
                write!(f, "no comment {id}; nothing was changed")
            }
            StoreError::InvalidPlanning(reason) => write!(f, "{reason}"),
            StoreError::InvalidReview(reason) => write!(f, "{reason}"),
            StoreError::ReviewConflict { group_id } => {
                write!(f, "review group {group_id} changed; reload it")
            }
            StoreError::ForeignComment { id, item_id } => write!(
                f,
                "comment {id} does not belong to {item_id}; nothing was changed"
            ),
            StoreError::EmptyComment => {
                write!(f, "a comment needs something written in it")
            }
            StoreError::EmptyRange => write!(
                f,
                "select the passage you want to comment on first; nothing was changed"
            ),
            StoreError::TooManyComments { item_id, limit } => write!(
                f,
                "{item_id} already holds {limit} comments, which is all this build \
                 will keep track of while you type; nothing was added"
            ),
            StoreError::TimelineComment => {
                write!(f, "a timeline cannot carry a comment; nothing was changed")
            }
            StoreError::UnknownCastKind { kind } => {
                write!(
                    f,
                    "{kind:?} is not a character, a place or a point of interest"
                )
            }
            StoreError::UnknownCastMember { id } => {
                write!(f, "no character, place or point of interest with id {id}")
            }
            StoreError::EmptyCastName => {
                write!(f, "a character, place or point of interest needs a name")
            }
            StoreError::UnlabelledCastField { value } => write!(
                f,
                "the detail {value:?} has no name, so nothing was saved -- name it or clear it"
            ),
            StoreError::AliasTooShort { alias } => write!(
                f,
                "{alias:?} is too short to use as an alias; nothing was saved"
            ),
            StoreError::AliasIsName { alias } => write!(
                f,
                "{alias:?} is already this member's name; nothing was saved"
            ),
            StoreError::AliasRepeated { alias } => {
                write!(f, "{alias:?} is listed twice; nothing was saved")
            }
            StoreError::EmptyWord => write!(f, "a dictionary word needs something in it"),
            StoreError::DuplicateWord { word } => {
                write!(f, "{word:?} is already on this project's dictionary")
            }
            StoreError::UnknownWord { word } => {
                write!(
                    f,
                    "{word:?} is not on this project's dictionary; nothing was changed"
                )
            }
            StoreError::Seed(msg) => write!(f, "seed: {msg}"),
            StoreError::NoRoom { parent_id } => match parent_id {
                Some(p) => write!(
                    f,
                    "there is no room left between two items under {p}; nothing was moved"
                ),
                None => write!(
                    f,
                    "there is no room left between two top-level items; nothing was moved"
                ),
            },
            StoreError::Corrupt(msg) => write!(f, "project structure is corrupt: {msg}"),
            StoreError::InvalidSourceWordDay { day } => {
                write!(f, "{day:?} is not a calendar date")
            }
            StoreError::BookIdentityChanged => {
                write!(f, "this book changed identity; nothing was changed")
            }
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A failing COMMIT leaves the transaction OPEN, so without the rollback the
/// next BEGIN IMMEDIATE fails with "cannot start a transaction within a
/// transaction" and every later write on this connection fails too. The store
/// has no reopen path, so that poisons it for the life of the process.
fn commit(conn: &Connection) -> Result<()> {
    if let Err(e) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e.into());
    }
    Ok(())
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before UNIX_EPOCH")
        .as_millis() as i64
}

#[derive(Debug)]
pub struct Store {
    conn: Connection,
}

/// The collation the cast list sorts names with. Registered on EVERY connection
/// this crate opens, `open_readonly`'s included, because a collation is a
/// per-connection function and a query naming an unregistered one fails outright
/// rather than falling back to bytes. `COLLATE NOCASE` was SQLite's ASCII fold:
/// "Ärger" sorted after "Zorn". This folds case across Unicode and strips the
/// Latin diacritics a European cast is likely to carry -- see `fold_for_sort`.
pub const NAME_COLLATION: &str = "NAME_FOLD";

fn register_collations(conn: &Connection) -> Result<()> {
    conn.create_collation(NAME_COLLATION, |a, b| {
        fold_for_sort(a).cmp(&fold_for_sort(b))
    })?;
    Ok(())
}

/// Lower-case across Unicode, then map the Latin-1 Supplement and Latin
/// Extended-A letters to their base letters, so "É" sorts as "e" and "ß" as "ss".
/// NOT a Unicode collation: Greek, Cyrillic and CJK names compare by code point
/// after lower-casing, which keeps them grouped and stable but not
/// alphabetised by their own rules. Recorded rather than hidden.
pub fn fold_for_sort(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars().flat_map(char::to_lowercase) {
        match ch {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
            'æ' => out.push_str("ae"),
            'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => out.push('c'),
            'ď' | 'đ' | 'ð' => out.push('d'),
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => out.push('e'),
            'ĝ' | 'ğ' | 'ġ' | 'ģ' => out.push('g'),
            'ĥ' | 'ħ' => out.push('h'),
            'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => out.push('i'),
            'ĳ' => out.push_str("ij"),
            'ĵ' => out.push('j'),
            'ķ' | 'ĸ' => out.push('k'),
            'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => out.push('l'),
            'ñ' | 'ń' | 'ņ' | 'ň' | 'ŉ' | 'ŋ' => out.push('n'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => out.push('o'),
            'œ' => out.push_str("oe"),
            'ŕ' | 'ŗ' | 'ř' => out.push('r'),
            'ś' | 'ŝ' | 'ş' | 'š' => out.push('s'),
            'ß' => out.push_str("ss"),
            'ţ' | 'ť' | 'ŧ' | 'þ' => out.push('t'),
            'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => out.push('u'),
            'ŵ' => out.push('w'),
            'ý' | 'ÿ' | 'ŷ' => out.push('y'),
            'ź' | 'ż' | 'ž' => out.push('z'),
            other => out.push(other),
        }
    }
    out
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        Self::prepare_writable(Connection::open(path)?)
    }

    pub fn open_existing(path: &Path) -> Result<Store> {
        let conn = Connection::open_with_flags(path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            return Err(StoreError::Corrupt("the selected file is not an initialized book".into()));
        }
        Self::prepare_writable(conn)
    }

    fn prepare_writable(conn: Connection) -> Result<Store> {
        register_collations(&conn)?;
        // journal_mode is persistent in the file; synchronous and foreign_keys
        // are per-connection and must be set on every open.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        let store = Store { conn };
        store.migrate()?;
        store.book_id()?;
        Ok(store)
    }

    /// Read-only, and deliberately does NOT migrate. `open` creates schema v1 on
    /// a blank file, so using it merely to READ a project's name -- which is what
    /// listing a library does -- writes to every file it looks at and leaves
    /// `-wal`/`-shm` beside them. A listing must not modify the thing it lists.
    ///
    /// A file that is absent or not a database fails HERE. An EMPTY file does
    /// not: SQLite reads a zero-byte file as an empty database, so this succeeds
    /// on one and the refusal comes later, from the first query -- `items()`
    /// reporting `no such table: item`. Either way it is never adopted and never
    /// written to, which is what a library listing needs; but a caller must not
    /// read a successful `open_readonly` as "this is a project".
    /// Fold the write-ahead log back into the main file and truncate it, so
    /// that the `.db` alone is the whole book. For the one path that moves the
    /// file (`project_move`); a flush never needs it. Best effort by nature:
    /// a reader on another connection makes TRUNCATE stop short, which is why
    /// the caller looks at the `-wal` file afterwards rather than trusting this.
    pub fn checkpoint(&self) -> Result<()> {
        self.conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn open_readonly(path: &Path) -> Result<Store> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        register_collations(&conn)?;
        let store = Store { conn };
        // Not a migration, just a refusal: a project written by a newer build
        // must not be listed as though this build understood it.
        let version = store.user_version()?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::NewerSchema {
                found: version,
                supported: SCHEMA_VERSION,
            });
        }
        store.book_id()?;
        Ok(store)
    }

    /// Write a compacted, standalone copy of this project to `dest`.
    ///
    /// `VACUUM INTO`, and the choice is MEASURED rather than reasoned.
    /// The online backup API livelocked under a concurrent writer (162,336
    /// steps, 7,037 restarts, a zero-byte output) because it restarts from
    /// page 1 whenever the source is written between steps. `VACUUM INTO`
    /// takes its snapshot inside ONE read transaction, so a writer neither
    /// blocks it nor is blocked by it, and its cost scales with book size
    /// rather than with someone else's write rate. A naive `.db` + `-wal` copy
    /// passed 200/200 trials and was still rejected: the writes never provably
    /// crossed the auto-checkpoint threshold, so the torn-main-file case
    /// SQLite documents was never exercised.
    ///
    /// The output is an ordinary project file at the current schema, which is
    /// what makes verification free: `open_readonly` and `cli::validate` read a
    /// recovery point exactly as they read a live project.
    ///
    /// `dest` MUST NOT EXIST, and SQLite refuses one that HAS CONTENT itself --
    /// the same never-clobber discipline `export` gets from `create_new(true)`,
    /// a refusal nothing can race rather than an `exists()` probe. A ZERO-BYTE
    /// file is the documented hole in that: SQLite reads one as an empty
    /// database and writes into it, exactly as `open_readonly` accepts one.
    /// Harmless, since a zero-byte file holds nothing to lose, and pinned by
    /// `vacuum_into_adopts_a_zero_byte_destination_rather_than_refusing_it` so
    /// nobody credits the refusal for more than it does.
    pub fn vacuum_into(&self, dest: &Path) -> Result<()> {
        // BOUND, never formatted: a project slug reaches this path.
        self.conn
            .execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])?;
        Ok(())
    }

    pub fn user_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    /// A LADDER, one step per version, each step applied only to a file behind
    /// it. A blank file is version 0 and takes every step, so there is exactly
    /// one description of each table and no second copy of v1's DDL to drift
    /// from the first.
    ///
    /// Every step runs in ONE `BEGIN IMMEDIATE` transaction with its own
    /// version bump, so a failure part way leaves the file at the last version
    /// that fully applied rather than at a version whose tables are half
    /// there. `BEGIN IMMEDIATE`, not a deferred `BEGIN`, and `user_version` is
    /// re-read INSIDE each transaction rather than trusted from the read
    /// before the loop: two instances opening the same behind-schedule file
    /// together both pass the outer check, and without the immediate lock and
    /// the re-read, both run the same `CREATE TABLE` and the loser gets a raw
    /// SQLite string instead of an open project. The immediate lock serializes
    /// them; the re-read lets the loser see the winner's work and skip the
    /// step as already done rather than failing on it.
    fn migrate(&self) -> Result<()> {
        let version = self.user_version()?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::NewerSchema {
                found: version,
                supported: SCHEMA_VERSION,
            });
        }
        // (target version, the DDL that reaches it from the version below).
        const LADDER: [(i64, &str); 17] = [
            (1, SCHEMA_V1),
            (2, SCHEMA_V2),
            (3, SCHEMA_V3),
            (4, comments::SCHEMA_V4),
            (5, dict::SCHEMA_V5),
            (6, synopsis::SCHEMA_V6),
            (7, cast::SCHEMA_V7),
            (8, cast::SCHEMA_V8),
            (9, appearances::SCHEMA_V9),
            (10, cast::SCHEMA_V10),
            (11, ""),
            (12, ""),
            (13, revision_planning::SCHEMA_V13),
            (14, cast::SCHEMA_V14),
            (15, analytics::SCHEMA_V15),
            (16, knowledge::SCHEMA_V16),
            (17, review::SCHEMA_V17),
        ];
        for (target, ddl) in LADDER {
            if version >= target {
                continue;
            }
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let result = (|| -> Result<()> {
                let current = self.user_version()?;
                if current >= target {
                    // Another instance reached this step while we waited for
                    // the immediate lock. Nothing to do; not an error.
                    return Ok(());
                }
                if target == 11 {
                    book_identity::migrate(&self.conn)?;
                } else if target == 12 {
                    source_words::migrate(&self.conn, now_ms())?;
                } else {
                    self.conn.execute_batch(ddl)?;
                    if target == 1 {
                        // Commit the fresh-file origin with its first schema
                        // step so concurrent/retried opens cannot call it legacy.
                        book_identity::mark_created(&self.conn)?;
                    }
                }
                self.conn.pragma_update(None, "user_version", target)?;
                Ok(())
            })();
            match result {
                Ok(()) => commit(&self.conn)?,
                Err(e) => {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    /// Depth-first order with depth, by a recursive CTE over
    /// (parent_id, position). This replaces an `ORDER BY parent_id, position`
    /// that grouped siblings but was NOT a tree walk — a grandchild could sort
    /// ahead of its own parent.
    ///
    /// Three failure modes are checked rather than assumed:
    ///  - an orphan (parent_id naming no row) never appears in a walk anchored
    ///    at the roots, so the walk would silently return fewer chapters than
    ///    the file holds;
    ///  - a parent cycle is unreachable from those same roots, since every node
    ///    in one has a non-NULL parent inside it. MAX_DEPTH does NOT catch that
    ///    — it bounds a legitimately deep chain, which is reachable and would
    ///    otherwise recurse to the row count;
    ///  - a chain deeper than MAX_DEPTH is truncated by the bound.
    /// All three surface as Corrupt, via the row count the walk failed to reach.
    ///
    /// A duplicate sibling position would ALSO break the order, silently and
    /// with a matching row count. That one is not detected here; it is made
    /// unwritable by the UNIQUE item_sibling index, and for roots -- where
    /// item_sibling's NULL parent_id makes every row distinct -- by the partial
    /// item_root_sibling index.
    ///
    /// Loads every row into a Vec at boot: ~3-6 MB for 20,000 rows of
    /// ids/titles/positions, versus the 95 MB a body join would cost.
    pub fn items(&self) -> Result<Vec<Item>> {
        // The walk and the count must see one snapshot: a row landing between
        // them would report Corrupt on a healthy file.
        let tx = self.conn.unchecked_transaction()?;
        // The state column arrived in v3, and `open_readonly` deliberately does
        // NOT migrate: the CLI's read-only subcommands walk a v1 or v2 file in
        // place, and a walk naming a column that file does not have fails with
        // "no such column" -- which reads as a damaged project rather than as an
        // old one. So the EXPRESSION is substituted and the walk is stated once;
        // two whole queries under an `if` would be two rules free to drift,
        // which is what this file already says about the export's walk and the
        // word counter's.
        //
        // Two spellings, because the recursive arm qualifies the column with the
        // joined table's alias and NULL cannot be qualified at all.
        let (state, i_state) = if self.user_version()? >= 3 {
            ("state", "i.state")
        } else {
            ("NULL", "NULL")
        };
        let mut stmt = tx.prepare(&format!(
            "WITH RECURSIVE walk(id, parent_id, type, title, position, rev, state, depth, path) AS (
               SELECT id, parent_id, type, title, position, rev, {state}, 0, position
                 FROM item
                WHERE parent_id IS NULL
               UNION ALL
               SELECT i.id, i.parent_id, i.type, i.title, i.position, i.rev, {i_state},
                      w.depth + 1, w.path || '/' || i.position
                 FROM item i
                 JOIN walk w ON i.parent_id = w.id
                WHERE w.depth + 1 < ?1
             )
             SELECT id, parent_id, type, title, position, rev, state, depth
               FROM walk
              ORDER BY path"
        ))?;
        let rows = stmt.query_map([MAX_DEPTH], |r| {
            Ok(Item {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                item_type: r.get(2)?,
                title: r.get(3)?,
                position: r.get(4)?,
                rev: r.get(5)?,
                state: r.get(6)?,
                depth: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }

        let total: i64 = tx.query_row("SELECT count(*) FROM item", [], |r| r.get(0))?;
        if out.len() as i64 != total {
            return Err(StoreError::Corrupt(format!(
                "walk reached {} of {total} item(s): an orphaned parent_id, a cycle, \
                 or nesting deeper than {MAX_DEPTH}",
                out.len()
            )));
        }
        Ok(out)
    }

    /// Appends a child at the end of `parent_id`'s sibling group. A scene also
    /// gets an empty document in the SAME transaction: a scene without one
    /// fails load_doc the first time the writer clicks it.
    ///
    /// A WRAPPER, over the form that also takes a neighbour.
    /// Every existing caller appends, and a wrapper is how they stay untouched:
    /// changing this signature would have moved every seeded fixture in the
    /// repository to prove one new argument.
    pub fn item_create(
        &self,
        parent_id: Option<&str>,
        item_type: &str,
        title: &str,
    ) -> Result<ItemCreated> {
        self.item_create_after(parent_id, item_type, title, None)
    }

    /// The same, landing the new row immediately after sibling `after_id`.
    ///
    /// `after_id` is `None` to append, which is what `item_create` passes.
    ///
    /// THE REASON THIS EXISTS: with
    /// only an appending create, any placement other than "last child of the
    /// selection" is create-then-`item_move`, which is two commands and not
    /// atomic -- a failed move leaves a real item at the end of the wrong group.
    /// A type-aware placement was needed, so the store gained the argument
    /// rather than the page gaining a two-step.
    ///
    /// The key arithmetic is `item_move`'s and is deliberately the same shape:
    /// left is the neighbour's position, right is the next sibling above it,
    /// `between` when there are both, `after` when there is no right, `NoRoom`
    /// when the two are immediate successors. The page never computes a
    /// position, and that rule is not relaxed here.
    pub fn item_create_after(
        &self,
        parent_id: Option<&str>,
        item_type: &str,
        title: &str,
        after_id: Option<&str>,
    ) -> Result<ItemCreated> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ItemCreated> {
            if let Some(p) = parent_id {
                let known: i64 =
                    self.conn
                        .query_row("SELECT count(*) FROM item WHERE id = ?1", [p], |r| r.get(0))?;
                if known == 0 {
                    return Err(StoreError::UnknownItem {
                        item_id: p.to_string(),
                    });
                }
            }
            // ORDER BY position DESC LIMIT 1 is what satisfies `after`'s
            // precondition: positions are compared with the default BINARY
            // collation, the same lexical order the walk sorts siblings by, so
            // this row IS the group maximum even when keys differ in length.
            let last: Option<String> = self
                .conn
                .query_row(
                    "SELECT position FROM item
                      WHERE parent_id IS ?1
                      ORDER BY position DESC LIMIT 1",
                    rusqlite::params![parent_id],
                    |r| r.get(0),
                )
                .optional()?;
            // A key read straight out of SQLite: the column is TEXT NOT NULL
            // with no CHECK, so a malformed byte is data corruption and must
            // reach the caller as an error. Panicking here poisons the store
            // mutex, and `locked` exits the process on a poisoned mutex --
            // taking the webview's unflushed edits with it.
            let position = match after_id {
                // Append: the group maximum, or the seed when the group is empty.
                None => match last {
                    Some(k) => position::after(&k).map_err(StoreError::Corrupt)?,
                    None => position::seeded_position(0).map_err(StoreError::Seed)?,
                },
                Some(a) => {
                    // The neighbour must be IN this group. A page acting on a
                    // tree that has since changed names a sibling that has
                    // moved, and must be told which one rather than having the
                    // row appended somewhere it did not ask for -- `item_move`
                    // reports the identical case identically.
                    let left: String = self
                        .conn
                        .query_row(
                            "SELECT position FROM item WHERE id = ?1 AND parent_id IS ?2",
                            rusqlite::params![a, parent_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .ok_or_else(|| StoreError::UnknownItem {
                            item_id: a.to_string(),
                        })?;
                    // No `id != ` exclusion here, unlike `item_move`: the row
                    // being placed does not exist yet, so it cannot be its own
                    // right neighbour.
                    let right: Option<String> = self
                        .conn
                        .query_row(
                            "SELECT position FROM item
                              WHERE parent_id IS ?1 AND position > ?2
                              ORDER BY position ASC LIMIT 1",
                            rusqlite::params![parent_id, left],
                            |r| r.get(0),
                        )
                        .optional()?;
                    match right.as_deref() {
                        None => position::after(&left).map_err(StoreError::Corrupt)?,
                        Some(r) if position::is_immediate_successor(Some(&left), r) => {
                            return Err(StoreError::NoRoom {
                                parent_id: parent_id.map(str::to_string),
                            })
                        }
                        Some(r) => {
                            position::between(Some(&left), Some(r)).map_err(StoreError::Corrupt)?
                        }
                    }
                }
            };
            let id = uuid::Uuid::now_v7().to_string();
            let mut doc_rev = None;
            self.conn.execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                rusqlite::params![id, parent_id, item_type, title, position],
            )?;
            if carries_document(item_type) {
                self.conn.execute(
                    "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, ?3)",
                    rusqlite::params![id, starter_body(item_type), now_ms()],
                )?;
                doc_rev = Some(1);
            }
            Ok(ItemCreated {
                id,
                position,
                rev: 1,
                doc_rev,
            })
        })();
        match result {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Insert a whole tree in ONE transaction, for import.
    ///
    /// Not a loop over `item_create`, and the difference is not tidiness:
    /// `item_create` opens its own `BEGIN IMMEDIATE` and commits per item, so a
    /// manuscript the size of the `stress` fixture would be twenty thousand
    /// commits. It is also the only way the insert is atomic — a failure part
    /// way through a loop would leave a half-imported project on disk that
    /// looks like a whole one.
    ///
    /// Each row is `(parent index, type, title, body)`. The parent is an index
    /// EARLIER in `rows`; the tuple is deliberate, so that `store` does not
    /// depend on `import`, the same way `export` takes a tuple rather than
    /// `store::Item`.
    ///
    /// A `body` may only accompany a `scene`: the schema gives a `doc` row to
    /// scenes and to nothing else, so any other pairing is refused here rather
    /// than silently dropped.
    pub fn import_tree(&self, rows: &[ImportRow<'_>]) -> Result<Vec<String>> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<Vec<String>> {
            let mut ids: Vec<String> = Vec::with_capacity(rows.len());
            let mut source_movements = Vec::new();
            // Sibling ordinals per parent group.
            //
            // NOT for ordering. `rows` is depth-first, so a single global
            // counter would still hand every sibling group increasing keys and
            // the walk would come back identical — that mutation was run and
            // survives, correctly. What per-group ordinals buy is COMPACTNESS:
            // each group starts near the bottom of the key space, so a writer
            // inserting into an imported chapter later has room, and no group's
            // keys are pushed toward the four-digit capacity by the size of the
            // manuscript around it.
            let mut ordinals: std::collections::HashMap<Option<usize>, u64> =
                std::collections::HashMap::new();
            let now = now_ms();
            for (n, (parent, item_type, title, body)) in rows.iter().enumerate() {
                if body.is_some() && *item_type != "scene" {
                    return Err(StoreError::UnknownItem {
                        item_id: format!("row {n}: a {item_type} cannot carry a body"),
                    });
                }
                let parent_id = match parent {
                    Some(at) => {
                        // A forward or self reference would name a row that does
                        // not exist yet. The parser guarantees this; the store
                        // is what the guarantee is worth nothing without.
                        if *at >= n {
                            return Err(StoreError::UnknownItem {
                                item_id: format!("row {n} names parent {at}"),
                            });
                        }
                        Some(ids[*at].clone())
                    }
                    None => None,
                };
                let ordinal = ordinals.entry(*parent).or_insert(0);
                let position = position::seeded_position(*ordinal).map_err(StoreError::Seed)?;
                *ordinal += 1;
                let id = uuid::Uuid::now_v7().to_string();
                self.conn.execute(
                    "INSERT INTO item (id, parent_id, type, title, position, rev)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                    rusqlite::params![id, parent_id, item_type, title, position],
                )?;
                if *item_type == "scene" {
                    let stored_body = body.unwrap_or(EMPTY_DOC_BODY);
                    self.conn.execute(
                        "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, ?3)",
                        rusqlite::params![id, stored_body, now],
                    )?;
                    if source_words::eligible(&self.conn, &id)? {
                        source_movements.push(source_words::directional(
                            source_words::WordSource::Imported,
                            None,
                            stored_body,
                        ));
                    }
                }
                ids.push(id);
            }
            source_words::record(&self.conn, &source_movements)?;
            Ok(ids)
        })();
        match result {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// The project's own record of itself. A name kept here rather than in the
    /// library's file name survives a rename of the file and is the only copy
    /// that can carry characters a slug cannot.
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    /// Keep a fresh check and its metadata append in one SQLite write
    /// transaction. An external writer cannot change the checked rows between
    /// the two; a failed check rolls back without touching the old meta value.
    pub fn with_immediate<T>(
        &self,
        work: impl FnOnce(&Self) -> std::result::Result<T, String>,
    ) -> std::result::Result<T, String> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        match work(self) {
            Ok(value) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    return match self.conn.execute_batch("ROLLBACK") {
                        Ok(()) => Err(error.to_string()),
                        Err(rollback) => {
                            Err(format!("commit failed: {error}; rollback failed: {rollback}"))
                        }
                    };
                }
                Ok(value)
            }
            Err(error) => {
                match self.conn.execute_batch("ROLLBACK") {
                    Ok(()) => Err(error),
                    Err(rollback) => Err(format!("{error}; rollback failed: {rollback}")),
                }
            }
        }
    }

    /// Take a `meta` row out entirely.
    ///
    /// REMOVED, NEVER SET TO THE EMPTY STRING -- `item.state`'s rule and
    /// `synopsis_set`'s, met again here: "the key was never written" and "the
    /// writer took the value off" are the same fact about the project, so there
    /// is one spelling of it and `get_meta` has one absent answer. A key that is
    /// not there is not an error; the caller asked for a state the file is
    /// already in.
    pub fn delete_meta(&self, key: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM meta WHERE key = ?1", rusqlite::params![key])?;
        Ok(())
    }

    /// None when the key was never written. A project predating this slice has
    /// no name row, which is a missing value, not a broken file.
    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    /// Gives a brand-new project what the page requires -- something to open --
    /// and, in a book with nothing in it at all, the chapter that holds it.
    /// Returns whether it created anything.
    ///
    /// A CHAPTER IS NOT OPTIONAL, by design: parts are optional and scenes
    /// are optional, chapters are not. A book that opened as one bare scene at
    /// the root is the
    /// emptiness that produced the flat-outline defect reported with
    /// a screenshot -- twice -- because the page's
    /// placement rule had nothing above the selection to hang a new row on and
    /// every first press landed at the root beside the scene.
    ///
    /// It is fixed HERE rather than in `placement.ts` because the page was
    /// answering correctly about a book that was wrong. An earlier fix taught the chapter
    /// press to build its own part, which is the same defect met one press
    /// later; a starter with a chapter in it means the very first press already
    /// has somewhere to go.
    ///
    /// Idempotent, and still keyed on "no scene anywhere" rather than "no items
    /// at all": a manuscript whose only items are parts and chapters is a
    /// project the writer built.
    pub fn ensure_starter_structure(&self, strings: &crate::strings::Strings) -> Result<bool> {
        // A SCENE, not merely an item. The condition used to be "the store is
        // empty", which is the same thing for a project being created and NOT
        // the same thing for one being imported: a Markdown manuscript whose
        // headings are all `#` and `##` produces parts and chapters and no
        // scene at all, and only a scene carries a document. Such a project
        // imported without error and then threw on mount - "project has no
        // scene: nothing to open in the editor" - which, before the page had a
        // startup-failure surface, meant a blank window that said nothing,
        // forever.
        //
        // Appended AFTER whatever is already there, so an imported manuscript
        // keeps its own order and the new scene is the last root. It is written
        // only when the manuscript brought none of its own, which is what keeps
        // `create_imported` from becoming "create plus a fill" - a manuscript
        // that arrived with its own scenes must not carry an empty one nobody
        // wrote.
        if self.items()?.iter().any(|i| i.item_type == "scene") {
            return Ok(false);
        }
        // `Scene 1`, not `Untitled scene`. The page names every
        // scene it creates `Scene <n>` from the next free number, and a starter
        // called something else makes the writer's very first two scenes read as
        // two different conventions. This is the ONLY scene the host names, and
        // it is `1` because it is the only one there is.
        // THE CHAPTER ONLY FOR A BOOK WITH NOTHING IN IT. The other caller of
        // this rule is an import that brought parts and chapters and no scene,
        // and that manuscript already has the structure a writer wrote --
        // wrapping its new scene in a chapter of our own would be the
        // application adding a row to somebody's outline, which is the same
        // objection that keeps `create_imported` from becoming "create plus a
        // fill". A brand-new book has no outline to disturb.
        let holder = if self.items()?.is_empty() {
            Some(
                self.item_create(
                    None,
                    "chapter",
                    &strings.f("item.numbered.chapter", &[("n", "1")]),
                )?
                .id,
            )
        } else {
            None
        };
        self.item_create(
            holder.as_deref(),
            "scene",
            &strings.f("item.numbered.scene", &[("n", "1")]),
        )?;
        Ok(true)
    }

    /// Moves `id` into `new_parent_id`, immediately after `after_id` (or first
    /// if None). Refuses to move an item into its own subtree: that would
    /// detach the subtree from every root, so the walk would lose it.
    ///
    /// Reparenting and repositioning are one transaction under base_rev
    /// discipline. Repositioning alone still bumps rev, so a caller cannot read
    /// "nothing happened" out of an unchanged revision.
    pub fn item_move(
        &self,
        id: &str,
        new_parent_id: Option<&str>,
        after_id: Option<&str>,
        base_rev: i64,
    ) -> Result<ItemMoved> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ItemMoved> {
            // Every check runs inside the write transaction. Outside it, an
            // insert landing between the check and the UPDATE would let the
            // refused move through anyway.
            if let Some(target) = new_parent_id {
                let known: i64 = self.conn.query_row(
                    "SELECT count(*) FROM item WHERE id = ?1",
                    [target],
                    |r| r.get(0),
                )?;
                if known == 0 {
                    return Err(StoreError::UnknownItem {
                        item_id: target.to_string(),
                    });
                }
                // The walk anchors on `id` itself, so target == id is caught
                // here as the depth-0 case and needs no branch of its own.
                // The depth bound is what keeps this from recursing forever over
                // a file that already holds a cycle; a tree deeper than
                // MAX_DEPTH is one items() reports as Corrupt anyway.
                let in_subtree: i64 = self.conn.query_row(
                    "WITH RECURSIVE sub(id, depth) AS (
                       SELECT id, 0 FROM item WHERE id = ?1
                       UNION ALL
                       SELECT i.id, s.depth + 1 FROM item i JOIN sub s ON i.parent_id = s.id
                        WHERE s.depth + 1 < ?3
                     )
                     SELECT count(*) FROM sub WHERE id = ?2",
                    rusqlite::params![id, target, MAX_DEPTH],
                    |r| r.get(0),
                )?;
                if in_subtree > 0 {
                    return Err(StoreError::Corrupt(format!(
                        "{target} is a descendant of {id}; moving it there would detach the subtree"
                    )));
                }
            }

            let left: Option<String> = match after_id {
                None => None,
                Some(a) => Some(
                    self.conn
                        .query_row(
                            "SELECT position FROM item WHERE id = ?1 AND parent_id IS ?2",
                            rusqlite::params![a, new_parent_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        // Not a sqlite error: a page acting on a tree that has
                        // since changed names a neighbour that is no longer in
                        // this group, and must be told which one.
                        .ok_or_else(|| StoreError::UnknownItem {
                            item_id: a.to_string(),
                        })?,
                ),
            };
            // The right neighbour is the next sibling after `left`, excluding
            // the moved item itself -- otherwise moving an item one step down
            // computes a key between itself and its neighbour.
            let right: Option<String> = self
                .conn
                .query_row(
                    "SELECT position FROM item
                      WHERE parent_id IS ?1 AND id != ?2
                        AND (?3 IS NULL OR position > ?3)
                      ORDER BY position ASC LIMIT 1",
                    rusqlite::params![new_parent_id, id, left],
                    |r| r.get(0),
                )
                .optional()?;

            let position = match (left.as_deref(), right.as_deref()) {
                // `after`'s precondition holds: `right` being None means no
                // sibling other than the moved row sorts above `l`.
                (Some(l), None) => position::after(l).map_err(StoreError::Corrupt)?,
                (l, Some(r)) if position::is_immediate_successor(l, r) => {
                    return Err(StoreError::NoRoom {
                        parent_id: new_parent_id.map(str::to_string),
                    })
                }
                (l, r) => position::between(l, r).map_err(StoreError::Corrupt)?,
            };

            let changed = self.conn.execute(
                "UPDATE item SET parent_id = ?1, position = ?2, rev = rev + 1
                  WHERE id = ?3 AND rev = ?4",
                rusqlite::params![new_parent_id, position, id, base_rev],
            )?;
            if changed == 0 {
                let exists: i64 =
                    self.conn
                        .query_row("SELECT count(*) FROM item WHERE id = ?1", [id], |r| {
                            r.get(0)
                        })?;
                return Err(if exists == 0 {
                    StoreError::UnknownItem {
                        item_id: id.to_string(),
                    }
                } else {
                    StoreError::Conflict {
                        item_id: id.to_string(),
                    }
                });
            }
            Ok(ItemMoved {
                parent_id: new_parent_id.map(str::to_string),
                position,
                rev: base_rev + 1,
            })
        })();
        match result {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Same conflict discipline as doc_flush: a stale base_rev is a Conflict,
    /// never a silent overwrite.
    pub fn item_rename(&self, id: &str, title: &str, base_rev: i64) -> Result<i64> {
        let changed = self.conn.execute(
            "UPDATE item SET title = ?1, rev = rev + 1 WHERE id = ?2 AND rev = ?3",
            rusqlite::params![title, id, base_rev],
        )?;
        if changed == 0 {
            // A missing item and a lost race both write nothing. Only the second
            // is recoverable by reloading a revision, so they must not share a
            // variant.
            let exists: i64 =
                self.conn
                    .query_row("SELECT count(*) FROM item WHERE id = ?1", [id], |r| {
                        r.get(0)
                    })?;
            return Err(if exists == 0 {
                StoreError::UnknownItem {
                    item_id: id.to_string(),
                }
            } else {
                StoreError::Conflict {
                    item_id: id.to_string(),
                }
            });
        }
        Ok(base_rev + 1)
    }

    /// Set or clear an item's revision state.
    ///
    /// `state` is `None` for the default, and that is the ONLY way the default
    /// is expressed: the column goes back to NULL rather than to the word
    /// "none". See SCHEMA_V3.
    ///
    /// SAME base_rev DISCIPLINE AS item_rename, and for a sharper reason than
    /// symmetry: the state shares the item's ROW and the item's revision, so a
    /// state written against a stale rev is a state written over a title the
    /// writer changed in between. Two writers is not the case that matters here
    /// -- there is one window -- a page holding an old walk is, and that is
    /// ordinary rather than exotic.
    ///
    /// The set is checked BEFORE the UPDATE, so a refused state leaves the row
    /// at the revision it had rather than at a bumped one with nothing to show
    /// for it.
    pub fn item_set_state(&self, id: &str, state: Option<&str>, base_rev: i64) -> Result<i64> {
        if let Some(name) = state {
            if !ITEM_STATES.contains(&name) {
                return Err(StoreError::UnknownState {
                    state: name.to_string(),
                });
            }
        }
        let changed = self.conn.execute(
            "UPDATE item SET state = ?1, rev = rev + 1 WHERE id = ?2 AND rev = ?3",
            rusqlite::params![state, id, base_rev],
        )?;
        if changed == 0 {
            // A missing item and a lost race both write nothing, and only the
            // second is recoverable by reloading a revision. Same split as
            // item_rename.
            let exists: i64 =
                self.conn
                    .query_row("SELECT count(*) FROM item WHERE id = ?1", [id], |r| {
                        r.get(0)
                    })?;
            return Err(if exists == 0 {
                StoreError::UnknownItem {
                    item_id: id.to_string(),
                }
            } else {
                StoreError::Conflict {
                    item_id: id.to_string(),
                }
            });
        }
        Ok(base_rev + 1)
    }

    pub fn load_doc(&self, item_id: &str) -> Result<Doc> {
        self.conn
            .query_row(
                "SELECT body, rev FROM doc WHERE item_id = ?1",
                [item_id],
                |r| {
                    Ok(Doc {
                        body: r.get(0)?,
                        rev: r.get(1)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => StoreError::NotFound {
                    item_id: item_id.to_string(),
                },
                other => StoreError::Sqlite(other),
            })
    }

    /// The project's word count by full scan: `words::count_words` over the text
    /// of every stored body.
    ///
    /// THE REFERENCE IMPLEMENTATION, and nothing else. No production path calls
    /// it any more: the host answers `project_word_count` from `WordIndex`,
    /// which is built once per open and adjusted per flush, because a scan per
    /// flush is a pass over the whole manuscript about once a second while
    /// someone types. What the scan is still FOR is the guard on that cache --
    /// `the_incremental_total_equals_a_full_recount` and its siblings compare
    /// the index against this, so it has to stay an independent second
    /// implementation rather than a wrapper around the thing it checks. Hence
    /// `#[cfg(test)]`: compiled where it is used, and a release build carries no
    /// dead scan.
    ///
    /// A body that does not parse, or whose root is not a document object, is
    /// SKIPPED and counted in `skipped` rather than aborting the scan. One
    /// unreadable row must not take the whole manuscript's total away from the
    /// writer -- the number is informational and every other scene's prose is
    /// intact. Skipping silently would be the wrong half of that trade, which is
    /// why the figure is returned rather than logged and forgotten.
    ///
    /// SAME LEFT JOIN AND EXCLUSION AS `word_index`, added when the guard this
    /// scan exists FOR was found comparing a filtered index against an
    /// unfiltered reference: a project holding a timeline made
    /// `assert_index_matches_a_full_recount` wrong by construction, since this
    /// scan counted the timeline's body as one more corrupt document that
    /// `word_index` had never claimed to see at all.
    #[cfg(test)]
    pub fn word_count(&self) -> Result<WordCount> {
        let mut stmt = self.conn.prepare(
            "SELECT doc.body
               FROM doc
               LEFT JOIN item ON item.id = doc.item_id
              WHERE item.type IS NULL OR item.type != ?1",
        )?;
        let rows = stmt.query_map([TIMELINE_TYPE], |r| r.get::<_, String>(0))?;
        let mut out = WordCount {
            words: 0,
            skipped: 0,
        };
        for row in rows {
            match document_text(&row?) {
                Some(text) => out.words += words::count_words(&text),
                None => out.skipped += 1,
            }
        }
        Ok(out)
    }

    /// The sentence and paragraph totals by full scan, `word_count`'s twin and
    /// for the same reason: the guard on `WordIndex::units_excluding` has to be
    /// a second implementation. Test-only like the scan it mirrors.
    ///
    /// SAME LEFT JOIN AND EXCLUSION AS `word_count` above, and the identical
    /// reason: this is the reference `unit_counts_answer_...`-style guards
    /// compare `WordIndex::units_excluding` against.
    #[cfg(test)]
    pub fn unit_count(&self) -> Result<Units> {
        let mut stmt = self.conn.prepare(
            "SELECT doc.body
               FROM doc
               LEFT JOIN item ON item.id = doc.item_id
              WHERE item.type IS NULL OR item.type != ?1",
        )?;
        let rows = stmt.query_map([TIMELINE_TYPE], |r| r.get::<_, String>(0))?;
        let mut out = Units::default();
        for row in rows {
            if let Some(text) = document_lines(&row?) {
                out.add(count_lines(&text).units);
            }
        }
        Ok(out)
    }

    /// The item type for one id, or None when the id is not in the tree.
    ///
    /// A single-row lookup, not `items()`'s full scan: `flush_into` and
    /// `restore_into` (commands/history.rs) need this once per DIRTY document
    /// to keep a flushed or restored timeline body out of the incremental
    /// word index (see the type check in both callers, and `word_index`'s own
    /// comment below for why a timeline's body must never reach `record`). A
    /// manuscript-wide scan for that one row would turn a per-keystroke flush
    /// into an O(items) cost; this is O(1) against the primary key.
    pub fn item_type(&self, item_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT type FROM item WHERE id = ?1", [item_id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(Into::into)
    }

    /// The per-document word index for this project, built by one full pass over
    /// `doc`. THE ONE O(manuscript) operation left in the counting path, and it
    /// happens once, at open. Everything after it is a delta.
    ///
    /// JOINS `item` AND EXCLUDES `timeline`, unlike the bible: a bible note's
    /// body is prose and parses, so it can sit IN the index and be subtracted by
    /// id (`count_excluding`). A timeline's body is not prose at all, and
    /// handing it to `record` would fail `document_lines`' parse and count a
    /// healthy document as a corrupt one -- `skipped` and stderr both exist to
    /// report damage, and a timeline is not that. See `TIMELINE_TYPE`.
    ///
    /// LEFT JOIN, NOT INNER -- an inner join silently drops a `doc` row whose
    /// `item` row is gone (`open_readonly` does not set `foreign_keys`, so
    /// this is real corruption `cli.rs`'s `KIND_ORPHAN_DOC` already names,
    /// not a state this build cannot produce). `item.type IS NULL` is that
    /// row's answer to the join, and it must still be counted -- an inner
    /// join here would take an orphan's words out of the total with no
    /// `skipped` entry to say so, silently, which is worse than the corrupt
    /// body case this function already guards against by name.
    pub fn word_index(&self) -> Result<WordIndex> {
        let mut stmt = self.conn.prepare(
            "SELECT doc.item_id, doc.body
               FROM doc
               LEFT JOIN item ON item.id = doc.item_id
              WHERE item.type IS NULL OR item.type != ?1",
        )?;
        let rows = stmt.query_map([TIMELINE_TYPE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut index = WordIndex::default();
        for row in rows {
            let (item_id, body) = row?;
            index.record(&item_id, &body);
        }
        Ok(index)
    }

    /// Every stored body, keyed by item id. One pass, the shape `word_index`
    /// already uses -- a per-scene `load_doc` loop over 15,200 documents is
    /// 15,200 statements where one suffices.
    ///
    /// Bodies are returned verbatim: parsing is the caller's rule, and export
    /// and counting read the same JSON to different ends.
    pub fn documents(&self) -> Result<std::collections::HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT item_id, body FROM doc")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (item_id, body) = row?;
            out.insert(item_id, body);
        }
        Ok(out)
    }

    /// Every stored document's REVISION, keyed by item id.
    ///
    /// Separate from `documents()` because the caller that needs it -- the
    /// mirror's incremental skip -- needs the number and not the megabytes, and
    /// a caller that wants both already pays for the bodies. Integers only, so
    /// this stays cheap enough to run beside a pass that also reads every body.
    ///
    /// AN ITEM WITH NO `doc` ROW IS ABSENT FROM THE MAP rather than present at
    /// zero: a container has no document, and giving it a revision would invent
    /// a fact the store does not hold.
    pub fn document_revs(&self) -> Result<std::collections::HashMap<String, i64>> {
        let mut stmt = self.conn.prepare("SELECT item_id, rev FROM doc")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (item_id, rev) = row?;
            out.insert(item_id, rev);
        }
        Ok(out)
    }

    /// Every readable document's PROSE, keyed by item id, with how many bodies
    /// were read and how many were not readable documents.
    ///
    /// This is `documents()` put through `document_text`, and it is the same
    /// question the word count asks -- *what is the prose of this document, as
    /// plain text?* -- so it reuses that rule rather than restating it. That is
    /// not a violation of the standing "two rules, not two copies" note on
    /// `document_text`: the rule there is that the COUNTER and the EXPORTER
    /// answer different questions, because the exporter needs marks and block
    /// boundaries and the counter must discard both. Search needs exactly what
    /// the counter needs.
    ///
    /// Two consequences ride along and are recorded on the search gates rather
    /// than hidden: a match can span a block boundary, since blocks are joined
    /// by a single space; and marks are invisible to search, since `em` is an
    /// attribute of a text node rather than a wrapper.
    ///
    /// `skipped` is the one figure saying the answer is an undercount.
    ///
    /// EXCLUDES `timeline` AT THE SAME JOIN `word_index` uses, and for the
    /// identical reason: this is what feeds `project_find`'s corpus, and a
    /// timeline's body is not prose a substring search should ever match
    /// inside, nor a document that "could not be read" -- see `TIMELINE_TYPE`.
    ///
    /// LEFT JOIN, `word_index`'s own reason: an inner join would drop an
    /// orphaned `doc` row (no matching `item`) out of the corpus entirely
    /// rather than counting it in `skipped`, which is the undercount this
    /// function's own doc comment already promises to report honestly.
    pub fn document_texts(
        &self,
    ) -> Result<(std::collections::HashMap<String, String>, usize, usize)> {
        let mut stmt = self.conn.prepare(
            "SELECT doc.item_id, doc.body
               FROM doc
               LEFT JOIN item ON item.id = doc.item_id
              WHERE item.type IS NULL OR item.type != ?1",
        )?;
        let rows = stmt.query_map([TIMELINE_TYPE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = std::collections::HashMap::new();
        let mut scanned = 0usize;
        let mut skipped = 0usize;
        for row in rows {
            let (item_id, body) = row?;
            scanned += 1;
            match document_text(&body) {
                Some(text) => {
                    out.insert(item_id, text);
                }
                None => skipped += 1,
            }
        }
        Ok((out, scanned, skipped))
    }

    /// One transaction for the whole batch, so N dirty documents cost one
    /// fsync rather than N, and a conflict anywhere rolls back everywhere.
    pub fn flush(&self, entries: &[FlushEntry]) -> Result<Vec<FlushAck>> {
        self.flush_with_sources(entries, &[])
    }

    pub fn flush_with_sources(
        &self,
        entries: &[FlushEntry],
        attribution: &[source_words::FlushAttribution],
    ) -> Result<Vec<FlushAck>> {
        self.flush_with_sources_and_session(entries, attribution, None, false)
    }

    pub fn flush_with_sources_and_session(
        &self,
        entries: &[FlushEntry],
        attribution: &[source_words::FlushAttribution],
        session: Option<&analytics::Runtime>,
        tracking_on: bool,
    ) -> Result<Vec<FlushAck>> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<Vec<FlushAck>> {
            let mut acks = Vec::with_capacity(entries.len());
            let mut actual_movements = Vec::with_capacity(entries.len());
            for e in entries {
                let old_body: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT body FROM doc WHERE item_id = ?1",
                        [&e.item_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let eligible = source_words::eligible(&self.conn, &e.item_id)?;
                let result = if e.base_rev == 0 {
                    // base_rev 0 against a doc row that already exists (a second
                    // window on this project, or stale in-memory state after a
                    // reload) also reports Conflict here, deliberately: "you are
                    // behind" and "you never knew where you stood" both recover
                    // by reloading the stored rev.
                    self.conn.execute(
                        "INSERT INTO doc (item_id, body, rev, updated_at)
                         SELECT ?1, ?2, 1, ?3
                          WHERE NOT EXISTS (SELECT 1 FROM doc WHERE item_id = ?1)",
                        rusqlite::params![e.item_id, e.body, now],
                    )
                } else {
                    self.conn.execute(
                        "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3
                          WHERE item_id = ?1 AND rev = ?4",
                        rusqlite::params![e.item_id, e.body, now, e.base_rev],
                    )
                };
                let changed = match result {
                    Ok(n) => n,
                    Err(rusqlite::Error::SqliteFailure(err, _))
                        if err.code == rusqlite::ErrorCode::ConstraintViolation =>
                    {
                        return Err(StoreError::UnknownItem {
                            item_id: e.item_id.clone(),
                        });
                    }
                    Err(err) => return Err(err.into()),
                };
                if changed == 0 {
                    return Err(StoreError::Conflict {
                        item_id: e.item_id.clone(),
                    });
                }
                // INSIDE THE SAME TRANSACTION as the body that moved them, and
                // after the body write succeeded. A flush the store refused above
                // has already returned, so a document that did not land cannot
                // leave its notes pointing into prose that was never written.
                if let Some(anchors) = &e.comments {
                    self.apply_comment_anchors(&e.item_id, anchors)?;
                }
                if let Some(old) = &old_body {
                    self.review_map_flush(&e.item_id, old, &e.body, now)?;
                }
                if eligible {
                    let movement = source_words::directional(
                        source_words::WordSource::Unattributed,
                        old_body.as_deref(),
                        &e.body,
                    );
                    actual_movements.push((
                        e.item_id.clone(),
                        movement.added,
                        movement.deleted,
                    ));
                }
                acks.push(FlushAck {
                    item_id: e.item_id.clone(),
                    rev: if e.base_rev == 0 { 1 } else { e.base_rev + 1 },
                });
            }
            let movements = source_words::flush_movements_by_item(&actual_movements, attribution);
            let ledger_movements: Vec<source_words::DatedMovement> = movements.iter().map(|(_, movement)| movement.clone()).collect();
            source_words::record(&self.conn, &ledger_movements)?;
            if let Some(session) = session {
                analytics::capture_optional(&self.conn, session, tracking_on, &actual_movements, &movements)?;
            }
            Ok(acks)
        })();
        match outcome {
            Ok(acks) => {
                commit(&self.conn)?;
                Ok(acks)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn source_word_summary(&self, day: &str) -> Result<source_words::SourceWordSummary> {
        source_words::summary(&self.conn, day)
    }
}

/// The text of one stored body, or None if it is not a document this build can
/// read. Matches ProseMirror's `doc.textBetween(0, size, " ")`, which is what
/// the page counts with -- the two numbers are compared by a graded gate, so the
/// JOINING rule matters as much as the counting one.
///
/// THE MATCH IS CONDITIONAL ON THE PAGE'S SCHEMA, and the precondition is:
/// *every non-text node in `app/ui/src/editor.ts`'s schema is a block*. That is
/// true today (`doc`, `paragraph`, `text`, and marks, which are not nodes) and
/// it is what makes the separator rule below equivalent to ProseMirror's.
/// `Fragment.textBetween` inserts the separator only for a BLOCK node;
/// `append_node` inserts one before every non-text node. So an INLINE non-text
/// node -- a hard_break, an image, any inline leaf -- diverges: `"hello"`,
/// `<hard_break>`, `"world"` is one word to ProseMirror and two here.
/// `app/ui/test/editor-marks.test.ts`'s "every non-text node in the schema is a
/// block" fails the day such a node is added to the schema, which is the signal
/// to come back and split this rule by node type. It is the signal for TWO
/// rules: `export::document_markdown` walks the same tree on the same
/// precondition and would break a paragraph mid-sentence in the exported
/// manuscript, so fix both or neither -- the test's message names both. A
/// block allowlist here would NOT be that signal: it would silently stop
/// separating the next BLOCK someone adds (a heading, a blockquote) and run two
/// of them into one word, trading a loud precondition for a quiet undercount.
///
/// Text nodes are concatenated with NOTHING between them: a mark boundary splits
/// one word into several text nodes, so italicising the middle of "bewitched"
/// gives `"be"`, `"witch"`, `"ed"`, which is one word and not three. Separators
/// go before a BLOCK node's content instead, so two paragraphs count as two
/// words rather than running together into one. Doubled separators are harmless
/// -- the counting rule splits on runs of whitespace.
///
/// Nothing below a well-formed root is rejected: an unrecognised node simply
/// contributes its descendants' text. Being strict deeper would let a node type
/// this build has not met take a whole scene out of the writer's total.
pub(crate) fn document_text(body: &str) -> Option<String> {
    document_joined(body, ' ')
}

/// `document_text` with blocks joined by a NEWLINE instead of a space, so a
/// paragraph boundary survives into the text for the sentence and paragraph
/// rules. The word count is identical over either -- both separators are
/// whitespace, and the words table pins "newline is whitespace" -- which is
/// why the index reads THIS projection for all three figures and every other
/// caller of `document_text` is untouched.
pub(crate) fn document_lines(body: &str) -> Option<String> {
    document_joined(body, '\n')
}

fn document_joined(body: &str, separator: char) -> Option<String> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    // A document, not merely an object. `is_object()` alone admitted `{"foo":1}`
    // as a readable zero-word document, so it never reached `skipped` -- the one
    // figure that says the total is an undercount. The page throws on the same
    // body in `schema.nodeFromJSON`, so nothing else in this app calls it a
    // document either.
    if root.get("type").and_then(|t| t.as_str()) != Some(ROOT_TYPE) {
        return None;
    }
    let mut out = String::new();
    append_node(&root, &mut out, separator);
    Some(out)
}

/// The root node type of a ProseMirror document, and the only one this build
/// will count.
const ROOT_TYPE: &str = "doc";

fn append_node(node: &serde_json::Value, out: &mut String, separator: char) {
    if node.get("type").and_then(|t| t.as_str()) == Some("text") {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            out.push_str(text);
        }
        return;
    }
    // Every non-text node in the page's schema is a block, so its content begins
    // a new run. That is a PRECONDITION, not a property of this function -- see
    // the divergence spelled out on document_text. `marks` never gets here: it
    // is an attribute of a text node, not a child, which is exactly why marks
    // cannot change the count.
    if !out.is_empty() {
        out.push(separator);
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            append_node(child, out, separator);
        }
    }
}

/// The project total, and how much of the project it could not read. Not
/// serialized: `project_word_count` answers the page with a bare u64 and reports
/// the skipped figure on host stderr, so this never crosses a serde boundary.
#[derive(Debug, PartialEq, Eq)]
pub struct WordCount {
    pub words: u64,
    /// Bodies skipped because they did not parse as a document. Non-zero means
    /// the total is an undercount and says by how many scenes.
    pub skipped: u64,
}

/// Sentences and paragraphs, the two figures beside words that spec section 11
/// asks for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Units {
    pub sentences: u64,
    pub paragraphs: u64,
}

/// One readable document's statistics projection. An absent map entry means
/// the document could not be read; zero is a measured value in every field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct DocumentCounts {
    pub words: u64,
    pub sentences: u64,
    pub paragraphs: u64,
}

impl Units {
    fn add(&mut self, other: Units) {
        self.sentences += other.sentences;
        self.paragraphs += other.paragraphs;
    }

    fn subtract(&mut self, other: Units) {
        self.sentences -= other.sentences;
        self.paragraphs -= other.paragraphs;
    }
}

/// One readable document's three figures, counted from one projection of its
/// body (`document_lines`) so the three cannot describe different texts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counted {
    words: u64,
    units: Units,
}

fn count_lines(text: &str) -> Counted {
    Counted {
        words: words::count_words(text),
        units: Units {
            sentences: words::count_sentences(text),
            paragraphs: words::count_paragraphs(text),
        },
    }
}

/// Every stored document's word count, plus the running total over them.
///
/// WHY IT EXISTS. The page asks for the project total after every successful
/// flush, and flushes land about once a second while someone is typing -- 289 of
/// them in a five-minute graded run. Answering each one with a full scan of a
/// 15,200-document manuscript put 116 frames into the 40-100 ms bucket and moved
/// frame p99 from 34 ms to 43 ms, measured at the stress fixture. The scan is
/// not made cheaper here; it is made RARE. A flush already says exactly which
/// documents changed, so the total is adjusted by their delta and the answer is
/// O(1).
///
/// WHY IT IS PER-DOCUMENT rather than a bare total. A flush carries the new body
/// only. Subtracting the old count needs the old count, and the only place it
/// still exists after the store has been written is here.
///
/// LIFETIME. It belongs to ONE open project and is dropped with it: it lives in
/// `OpenProject`, so a project switch, which replaces that whole value, cannot
/// leave the previous manuscript's total behind for the next one to display.
///
/// A cached figure that drifts from the truth is worse than a slow one, because
/// a writer cannot tell a wrong number from a right one. The guard is
/// `Store::word_count`, the full scan, compared against this in the store's
/// tests and in main.rs's.
#[derive(Debug, Default)]
pub struct WordIndex {
    /// item_id -> that body's count, or None for a body that could not be read
    /// as a document. None is a PRESENT entry on purpose: an unreadable document
    /// is one this index knows about and cannot count, which is what `skipped`
    /// reports, and it becomes countable again the moment a flush replaces it.
    per_doc: std::collections::HashMap<String, Option<Counted>>,
    words: u64,
    units: Units,
    skipped: u64,
}

impl WordIndex {
    /// The project total as this index holds it. Same shape as the full scan's
    /// answer, so the two can be compared directly.
    pub fn count(&self) -> WordCount {
        WordCount {
            words: self.words,
            skipped: self.skipped,
        }
    }

    /// The project total with the deleted documents taken back out.
    ///
    /// Subtracting AT COUNT TIME rather than forgetting the entries on delete is
    /// load-bearing, and the reason is that a deleted scene stays open and
    /// keeps taking keystrokes: every `doc_flush` calls `record`, so an entry
    /// dropped on delete would climb silently back into the total. Reading the
    /// count the index already holds is correct however many times the trashed
    /// document is flushed afterwards.
    ///
    /// Iterates the EXCLUDED ids, not the whole index: the bin holds what one
    /// writer has deleted, the index holds the whole manuscript, and this is
    /// read after every accepted flush.
    pub fn count_excluding(&self, excluded: &std::collections::HashSet<String>) -> WordCount {
        let mut out = self.count();
        for id in excluded {
            // A trashed item that is not a document -- a part, a chapter, the
            // bin itself -- has no entry, and contributes nothing either way.
            match self.per_doc.get(id) {
                Some(Some(counted)) => out.words -= counted.words,
                Some(None) => out.skipped -= 1,
                None => {}
            }
        }
        out
    }

    /// The manuscript's sentences and paragraphs, under the same exclusion as
    /// `count_excluding` and for the same reason: a trashed scene keeps taking
    /// keystrokes, so its entry is withheld at count time rather than dropped.
    #[cfg(test)]
    pub fn units_excluding(&self, excluded: &std::collections::HashSet<String>) -> Units {
        let mut out = self.units;
        for id in excluded {
            if let Some(Some(counted)) = self.per_doc.get(id) {
                out.subtract(counted.units);
            }
        }
        out
    }

    /// One document's sentences and paragraphs, or None when it is absent,
    /// unreadable or excluded -- the three states `counts_excluding` withholds
    /// an entry for, so the two answers agree about which scenes have figures.
    #[cfg(test)]
    pub fn units_of(
        &self,
        id: &str,
        excluded: &std::collections::HashSet<String>,
    ) -> Option<Units> {
        if excluded.contains(id) {
            return None;
        }
        self.per_doc
            .get(id)
            .copied()
            .flatten()
            .map(|counted| counted.units)
    }

    /// Every LIVE document's own count, keyed by item id.
    ///
    /// The per-item view of `count_excluding`, and deliberately the same
    /// exclusion rule, so that `counts_excluding(x).values().sum()` is exactly
    /// `count_excluding(x).words`. A caller summing a chapter's scenes and a
    /// caller reading the project bar must not be able to disagree about what
    /// the manuscript holds; the store's tests pin that identity.
    ///
    /// AN UNREADABLE BODY IS ABSENT, NOT ZERO. Zero is already a taken value --
    /// `EMPTY_DOC_BODY` is what `item_create` writes, so a scene nobody has
    /// typed into is a genuine, present zero -- and a body that failed to parse
    /// is not an empty scene. Absent says "this could not be counted", which is
    /// what `skipped` reports in the total, and it is the only answer the map
    /// can give that a caller cannot mistake for a measurement.
    ///
    /// A TRASHED DOCUMENT IS ABSENT for the same reason it is subtracted from
    /// the total: it is not part of the manuscript. Deleted work still takes
    /// keystrokes -- a binned scene stays open and keeps flushing -- so its
    /// entry is still maintained here and still correct; it is withheld from
    /// the answer rather than forgotten, exactly as `count_excluding` withholds
    /// its words rather than dropping the entry.
    ///
    /// COST: O(documents), and no document is read. It is a walk of the index
    /// this project already maintains plus one map allocation -- 15,200 entries
    /// at the stress fixture -- with no JSON parse and no store query. It is NOT
    /// the O(manuscript) rescan that put 116 frames into the 40-100 ms bucket;
    /// it is also not free, and a caller that repaints per flush ack pays a map
    /// build per second. Nothing here holds the store mutex beyond the walk.
    pub fn counts_excluding(
        &self,
        excluded: &std::collections::HashSet<String>,
    ) -> std::collections::HashMap<String, u64> {
        self.per_doc
            .iter()
            .filter(|(id, _)| !excluded.contains(id.as_str()))
            .filter_map(|(id, count)| count.map(|counted| (id.clone(), counted.words)))
            .collect()
    }

    /// Every live document's three statistics figures, keyed by item id.
    ///
    /// This is the statistics panel's on-demand projection. It follows the
    /// same sparse and exclusion rules as `counts_excluding`, so callers cannot
    /// turn an unreadable body into a zero-valued measurement.
    pub fn document_counts_excluding(
        &self,
        excluded: &std::collections::HashSet<String>,
    ) -> std::collections::HashMap<String, DocumentCounts> {
        self.per_doc
            .iter()
            .filter(|(id, _)| !excluded.contains(id.as_str()))
            .filter_map(|(id, count)| {
                count.map(|counted| {
                    (
                        id.clone(),
                        DocumentCounts {
                            words: counted.words,
                            sentences: counted.units.sentences,
                            paragraphs: counted.units.paragraphs,
                        },
                    )
                })
            })
            .collect()
    }

    /// Recount one document from its body, replacing whatever this index held
    /// for it. Idempotent by construction: the previous count is subtracted
    /// before the new one is added, so recording the same body twice cannot
    /// double it -- which is what a naive `total += count(body)` would do on the
    /// second flush of a document, and flushing one document repeatedly is the
    /// normal case while someone types into it.
    pub fn record(&mut self, item_id: &str, body: &str) {
        let counted = document_lines(body).map(|text| count_lines(&text));
        match self.per_doc.insert(item_id.to_string(), counted) {
            Some(Some(previous)) => {
                self.words -= previous.words;
                self.units.subtract(previous.units);
            }
            Some(None) => self.skipped -= 1,
            None => {}
        }
        match counted {
            Some(n) => {
                self.words += n.words;
                self.units.add(n.units);
            }
            None => self.skipped += 1,
        }
    }

    /// The delta for one accepted flush. MUST be called only after the store has
    /// committed the batch: `Store::flush` is one transaction and rolls the whole
    /// batch back on any conflict, so applying entries the store rejected would
    /// leave the index describing a manuscript that does not exist.
    pub fn apply_flush(&mut self, entries: &[FlushEntry]) {
        for e in entries {
            self.record(&e.item_id, &e.body);
        }
    }

    /// How many documents the index knows about. Read by the tests that check a
    /// newly created scene is PRESENT at zero rather than missing.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.per_doc.len()
    }
}

/// The body a newly created scene gets. Shared with the host so the word index
/// can register the new document without re-reading it: an empty document counts
/// zero, and zero is a value the index must HOLD rather than lack, or the first
/// flush of that scene would find no previous count to subtract.
pub const EMPTY_DOC_BODY: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

/// The body a brand-new timeline gets: schema at version 1, with no
/// zero label, no tracks, no branches and no events. NOT `EMPTY_DOC_BODY` --
/// a timeline's body is never a ProseMirror document, and the one place that
/// shape exists is here, because nothing on the host side ever parses past
/// `"kind"` and `"version"`. The page mints the rest as the writer works.
pub const EMPTY_TIMELINE_BODY: &str = r#"{"kind":"timeline","version":1,"scale":{"unit":"day","zero":"","calendar":null,"eras":[]},"tracks":[],"branches":[],"events":[]}"#;

/// The starter body for a fresh `doc` row of `item_type`. ONE BRANCH, here and
/// nowhere else: `item_create_after` is the single seam that mints a new
/// document, and a second call site choosing between the two constants would
/// be a second place that could pick the wrong one for a new type later.
fn starter_body(item_type: &str) -> &'static str {
    if item_type == TIMELINE_TYPE {
        EMPTY_TIMELINE_BODY
    } else {
        EMPTY_DOC_BODY
    }
}

/// One row for `import_tree`: `(parent index, type, title, body)`.
pub type ImportRow<'a> = (Option<usize>, &'a str, &'a str, Option<&'a str>);

#[derive(Debug, Deserialize, Clone)]
pub struct FlushEntry {
    pub item_id: String,
    pub body: String,
    /// 0 means "no stored revision yet".
    pub base_rev: i64,
    /// Where this document's comments now sit, if the page is tracking them.
    ///
    /// RIDES THE BODY rather than travelling on a schedule of its own, and that
    /// is the whole rule: a position and the prose it describes are one write or
    /// they are two states free to disagree about where a note is. See
    /// comments::apply_comment_anchors.
    ///
    /// `None` is "do not touch them", not "there are none". The page sends None
    /// for every document that is not the open one -- only the open one can have
    /// been edited -- and for the open one when its mapping has been capped, so
    /// the last positions known to be right are the ones that stay.
    #[serde(default)]
    pub comments: Option<Vec<comments::CommentAnchor>>,
}

#[derive(Debug, Serialize)]
pub struct FlushAck {
    pub item_id: String,
    pub rev: i64,
}

#[derive(Debug, Serialize)]
pub struct Item {
    pub id: String,
    pub parent_id: Option<String>,
    /// `type` is a Rust keyword, so the field is renamed for the page.
    #[serde(rename = "type")]
    pub item_type: String,
    pub title: String,
    pub position: String,
    pub rev: i64,
    /// Where the writer says this part of the manuscript stands: one of
    /// `ITEM_STATES`, or None for the default.
    ///
    /// None IS `none`. The word is never stored and never sent -- see SCHEMA_V3
    /// for why a default written as a value is a default free to drift.
    pub state: Option<String>,
    /// 0 for a root item. Produced by the walk, not stored.
    pub depth: i64,
}

/// The revision states a writer can mark an item with, and the whole of them.
///
/// CLOSED, and closed by decision rather than by convenience: an open set is a
/// tagging system, with its own management surface, its own renaming and merging
/// questions, and a statistics panel that cannot name the things it is counting.
/// Four words plus the default answer "where does this stand" without any of
/// that.
///
/// `none` is NOT in this list. It is the absence of a value, not a fifth word --
/// see SCHEMA_V3.
///
/// ORDER IS THE PROGRESSION a manuscript makes, and the page restates it in the
/// same order. Nothing enforces moving along it: a writer may put a finished
/// chapter back to `revising`, which is most of what revising is.
pub const ITEM_STATES: [&str; 4] = ["outline", "draft", "revising", "done"];

/// The item type of the reserved bin deleted items are moved into.
///
/// Identified by TYPE and never by title: a writer may legitimately name a
/// chapter "Trash", and this type is not something the outline can produce --
/// its three create buttons emit `part`, `chapter` and `scene` only.
pub const TRASH_TYPE: &str = "trash";

/// The title the bin is created with. Only ever read by a human.
///
/// `#[cfg(test)]`, because THE STORE DOES NOT OWN IT: the page creates the bin
/// and supplies the title (`TRASH_TITLE` in app/ui/src/outline.ts), and every
/// rule here keys on the TYPE. Outside tests it was dead code -- a second home
/// for a string with one owner.
#[cfg(test)]
pub const TRASH_TITLE: &str = "Trash";

/// The ids of every item inside the bin, the bin itself included.
///
/// `items()` is DEPTH-FIRST, which is the whole reason this is a scan and not a
/// query: a subtree occupies a contiguous run of the walk, from the bin's row
/// until depth returns to the bin's own level. Stating it once here is what
/// keeps export, search and the word count from growing three subtly different
/// versions of the same rule.
///
/// The FIRST root of `TRASH_TYPE` wins. A file holding two is not something the
/// application can produce; defining the behaviour beats leaving it incidental.
///
/// Returns an empty set when there is no bin, which is every project that has
/// never had anything deleted -- so every caller's filter is a no-op until the
/// writer deletes something, rather than a branch that is normally skipped.
pub fn trashed_ids(items: &[Item]) -> std::collections::HashSet<String> {
    root_subtree_ids(items, TRASH_TYPE)
}

/// The item type of the reserved section holding what belongs to the project and
/// is not the book: the synopsis, the world building, the notes.
///
/// TRASH WITH THE SIGN FLIPPED, and identified the same way - by TYPE, at depth
/// 0, never by title. A writer may legitimately name a chapter "Bible"; they
/// cannot produce this type, because the outline's create items emit `part`,
/// `chapter`, `scene` and `note` only.
pub const BIBLE_TYPE: &str = "bible";

/// A bodyless container within the bible's canonical item tree.
#[cfg(test)]
pub const BIBLE_FOLDER_TYPE: &str = "bible-folder";

/// A free-form document inside the bible. It carries a `doc` row and is
/// therefore written, flushed, versioned and snapshotted exactly like a scene -
/// which is the whole of what makes the bible usable, and the whole of why the
/// word index has to exclude it BY ID rather than by not holding it.
pub const NOTE_TYPE: &str = "note";

/// A story clock under the bible: tracks, branches and events, held as one
/// opaque JSON body the host never parses. It carries a `doc` row exactly like a
/// bible note - rename, bin, restore, snapshots, history and the flush's
/// revision discipline all apply with no new store command - but its body is
/// not prose, so unlike a note it is excluded from the word index and every
/// other prose-reading consumer BY TYPE, at the SQL level, never merely by id:
/// a bible note's body still parses as a document and only needs subtracting
/// from the total, while a timeline's body would fail that parse and count
/// itself as a corrupt document on stderr if it were ever handed to one.
pub const TIMELINE_TYPE: &str = "timeline";

/// The item type of the reserved section whose documents print BEFORE the
/// chapters: the dedication, the foreword, the epigraph.
///
/// `"front"`, not `"front-matter"`, and the shortening is not cosmetic:
/// `mirror::FRONT_MATTER` is already the string `"front-matter"` and means a
/// change reason for the YAML block at the top of a mirror file. Two unrelated
/// concepts spelled the same way in one crate is how a reader learns the wrong
/// thing from a grep.
pub const FRONT_MATTER_TYPE: &str = "front";

/// The item type of the reserved section whose documents print AFTER the
/// chapters: the acknowledgements, the afterword, the appendix.
///
/// TWO SECTIONS RATHER THAN ONE WITH A FLAG, and the argument is in the write-back:
/// where a document prints
/// is a property of the SECTION it is in, which the writer can see and change
/// with the moves they already have, and it costs nothing new -- both are
/// `root_subtree_ids` again.
pub const BACK_MATTER_TYPE: &str = "back";

/// A document inside either matter section. It carries a `doc` row, so it is
/// written, flushed, versioned and snapshotted exactly like a scene.
///
/// ONE TYPE FOR ALL FOUR KINDS. A dedication, a foreword, an
/// afterword and an acknowledgements page differ in their TITLE and in which
/// section they sit in, and in nothing the store can see -- four types would be
/// four numbering series, four placement rules and four answers to what the
/// containment rule is, which is exactly the reach the write-back warns
/// against.
pub const MATTER_TYPE: &str = "matter";

/// Does an item of this type get a `doc` row when it is created?
///
/// A FUNCTION, not a comparison repeated at each call site, because "which types
/// carry prose" is now a set rather than the word `scene` - and `ItemCreated`'s
/// `doc_rev` is already documented as the thing callers key on so that "scenes
/// stop being the only item type that gets one" costs nothing downstream.
///
/// `import_tree` deliberately does NOT use this: a Markdown import produces
/// parts, chapters and scenes, and a body arriving on any other row there is a
/// parser bug rather than a bible document.
///
/// A `timeline` carries one too, a JSON body rather than prose - see
/// `TIMELINE_TYPE`'s own comment for why every prose-reading consumer excludes
/// it BY TYPE rather than treating it as a fourth kind of document.
pub fn carries_document(item_type: &str) -> bool {
    item_type == "scene"
        || item_type == NOTE_TYPE
        || item_type == MATTER_TYPE
        || item_type == TIMELINE_TYPE
}

/// The ids of the first depth-0 root of `item_type` and everything under it.
///
/// `items()` is DEPTH-FIRST, which is the whole reason this is a scan and not a
/// query: a subtree occupies a contiguous run of the walk, from the root's row
/// until depth returns to that root's own level.
///
/// The FIRST such root wins, and a row of that type that is NOT a root is not
/// one at all. Both rules are `trashed_ids`' and are stated once here rather
/// than twice: the bin and the bible are the same shape with opposite signs, and
/// two copies of this scan would be free to disagree about a nested decoy.
fn root_subtree_ids(items: &[Item], item_type: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Some(root) = items
        .iter()
        .position(|i| i.item_type == item_type && i.depth == 0)
    else {
        return out;
    };
    let floor = items[root].depth;
    out.insert(items[root].id.clone());
    for item in &items[root + 1..] {
        // The first row back at or above the root's own level ends the subtree.
        if item.depth <= floor {
            break;
        }
        out.insert(item.id.clone());
    }
    out
}

/// The ids of everything in the bible, the bible root included.
pub fn bible_ids(items: &[Item]) -> std::collections::HashSet<String> {
    root_subtree_ids(items, BIBLE_TYPE)
}

/// Everything that is NOT the book: the bin's subtree and the bible's, together.
///
/// ONE SET, not two handed around in a pair. Every consumer of this - the word
/// index, the per-item counts, the manuscript-wide replace - asks the same
/// question ("is this row part of the book?"), and `OpenProject` caches the
/// answer because it is read after every accepted flush. Two cached sets would
/// mean either a union allocated on the keystroke path or two `contains` calls
/// at every call site, and the second is how one of them gets forgotten.
pub fn excluded_from_book(items: &[Item]) -> std::collections::HashSet<String> {
    let mut out = trashed_ids(items);
    out.extend(bible_ids(items));
    out
}

/// The walk with the bin and everything in it removed. What the manuscript is,
/// as opposed to what the writer can see.
pub fn without_trashed(items: Vec<Item>) -> Vec<Item> {
    without(items, trashed_ids)
}

/// The walk with the bin AND the bible removed. What the BOOK is.
///
/// The distinction from `without_trashed` is a product one and it is why both
/// exist: search keeps the bible and labels it, because a writer searching a
/// project means the project. Export, the readable mirror and the statistics
/// panel are about the manuscript, and a synopsis is not a chapter of it.
pub fn manuscript_items(items: Vec<Item>) -> Vec<Item> {
    without(items, excluded_from_book)
}

/// The book split into the three runs every renderer emits in order.
///
/// THIS IS THE THIRD STATE, and it is written down here because
/// `excluded_from_book` cannot hold it. That set is two-valued -- a row is part
/// of the book or it is not -- and front matter is neither answer: it is IN the
/// export, IN the mirror and IN the word count, and OUTSIDE the chapter
/// sequence. Putting it in the excluded set would take a dedication out of the
/// book; leaving it only in `manuscript_items` would print `FRONT MATTER` as a
/// chapter heading between two chapters. So the third state is a SPLIT rather
/// than a flag:
///
/// - EXCLUDED  -- the bin and the bible. `excluded_from_book`, unchanged.
/// - MATTER    -- the two section subtrees. In the book, out of the sequence.
/// - CHAPTERS  -- everything else.
///
/// The two SECTION ROOTS are dropped: a root is a marker the writer moves
/// documents into, not a heading, and nothing downstream should have to know
/// its type in order to skip it. Their children are RE-BASED by one level, so a
/// top-level dedication sits at the depth a top-level chapter does -- without
/// that, every front-matter heading is one level deeper than the book it
/// introduces, for no reason a reader of the file could recover.
///
/// A `front` or `back` row that is not a depth-0 root is an ordinary row of the
/// book, exactly as a nested `bible` row is: `root_subtree_ids` states that rule
/// once and this reuses it rather than keying on the type alone.
pub struct BookWalk {
    pub front: Vec<Item>,
    pub chapters: Vec<Item>,
    pub back: Vec<Item>,
}

pub fn book_walk(items: Vec<Item>) -> BookWalk {
    let excluded = excluded_from_book(&items);
    let front_ids = root_subtree_ids(&items, FRONT_MATTER_TYPE);
    let back_ids = root_subtree_ids(&items, BACK_MATTER_TYPE);
    let mut out = BookWalk {
        front: Vec::new(),
        chapters: Vec::new(),
        back: Vec::new(),
    };
    for mut item in items {
        if excluded.contains(&item.id) {
            continue;
        }
        let section = if front_ids.contains(&item.id) {
            Some(&mut out.front)
        } else if back_ids.contains(&item.id) {
            Some(&mut out.back)
        } else {
            None
        };
        match section {
            // THE ROOT ITSELF IS THE MARKER and never a heading, and DEPTH
            // ALONE identifies it: `root_subtree_ids` collects a depth-0 root
            // plus the contiguous run strictly beneath it, so the only depth-0
            // row in either set is that root. The first draft also compared the
            // TYPE, and the mutation pass found that nothing could reach the
            // refusal -- deleted on the `import_name_ok` precedent, because a
            // reader credits a guard for a refusal it never performs.
            Some(_) if item.depth == 0 => {}
            Some(run) => {
                item.depth -= 1;
                run.push(item);
            }
            None => out.chapters.push(item),
        }
    }
    out
}

fn without(items: Vec<Item>, set: fn(&[Item]) -> std::collections::HashSet<String>) -> Vec<Item> {
    let excluded = set(&items);
    if excluded.is_empty() {
        return items;
    }
    items
        .into_iter()
        .filter(|i| !excluded.contains(&i.id))
        .collect()
}

#[derive(Debug, Serialize)]
pub struct ItemCreated {
    pub id: String,
    pub position: String,
    pub rev: i64,
    /// The created document's revision, or None for a non-scene item that got
    /// no document row. A caller that opens the new scene straight into the
    /// editor must seed its flush base_rev from this: flush treats base_rev 0
    /// against an existing row as a Conflict, so a create-then-save with no
    /// intervening load_doc would conflict on the first save.
    pub doc_rev: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ItemMoved {
    pub parent_id: Option<String>,
    pub position: String,
    pub rev: i64,
}

#[derive(Debug, Serialize)]
pub struct Doc {
    pub body: String,
    pub rev: i64,
}

#[cfg(test)]
pub(crate) fn historical_test_store(path: &Path, version: i64) -> Store {
    let conn = rusqlite::Connection::open(path).unwrap();
    register_collations(&conn).unwrap();
    let steps = [
        (1, SCHEMA_V1),
        (2, SCHEMA_V2),
        (3, SCHEMA_V3),
        (4, comments::SCHEMA_V4),
        (5, dict::SCHEMA_V5),
        (6, synopsis::SCHEMA_V6),
        (7, cast::SCHEMA_V7),
        (8, cast::SCHEMA_V8),
        (9, appearances::SCHEMA_V9),
        (10, cast::SCHEMA_V10),
        (11, ""),
        (12, ""),
        (13, revision_planning::SCHEMA_V13),
        (14, cast::SCHEMA_V14),
    ];
    assert!((1..=14).contains(&version));
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    for (step, ddl) in steps {
        if step > version {
            break;
        }
        if step == 11 {
            book_identity::migrate(&conn).unwrap();
        } else if step == 12 {
            source_words::migrate(&conn, now_ms()).unwrap();
        } else {
            conn.execute_batch(ddl).unwrap();
        }
    }
    conn.pragma_update(None, "user_version", version).unwrap();
    conn.execute_batch("COMMIT").unwrap();
    Store { conn }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_for_sort_lowers_case_and_strips_latin_diacritics() {
        assert_eq!(fold_for_sort("Ada"), "ada");
        assert_eq!(fold_for_sort("Ärger"), "arger");
        assert_eq!(fold_for_sort("Éloise"), "eloise");
        assert_eq!(fold_for_sort("Øystein Straße"), "oystein strasse");
        assert_eq!(fold_for_sort("Łukasz Čapek"), "lukasz capek");
        // Not a Unicode collation: a Greek name lower-cases and stays Greek.
        assert_eq!(fold_for_sort("Ωμέγα"), "ωμέγα");
    }

    #[test]
    fn the_name_collation_is_registered_on_a_readonly_connection_too() {
        // A collation is per connection. `open_readonly` is the CLI's and the
        // library listing's path, and a cast list over it failed outright
        // before this was registered there.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.db");
        {
            let store = Store::open(&path).unwrap();
            store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Zorn")
                .unwrap();
            store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ärger")
                .unwrap();
        }
        let ro = Store::open_readonly(&path).unwrap();
        let names: Vec<String> = ro
            .cast_list()
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(names, vec!["Ärger", "Zorn"]);
    }
    use tempfile::tempdir;

    /// A walk row. Only the fields `trashed_ids` reads carry meaning; the rest
    /// are filled so the shape is a real `Item` rather than a special case.
    fn row(id: &str, item_type: &str, depth: i64) -> Item {
        Item {
            id: id.into(),
            parent_id: None,
            item_type: item_type.into(),
            title: id.into(),
            position: "0000".into(),
            rev: 1,
            state: None,
            depth,
        }
    }

    #[test]
    fn a_project_with_no_bible_excludes_nothing_extra() {
        let walk = vec![row("a", "part", 0), row("b", "scene", 1)];
        assert!(bible_ids(&walk).is_empty());
        assert!(excluded_from_book(&walk).is_empty());
    }

    #[test]
    fn the_bible_and_its_whole_subtree_are_excluded() {
        let walk = vec![
            row("keep", "part", 0),
            row("keep-child", "scene", 1),
            row("bible", BIBLE_TYPE, 0),
            row("synopsis", NOTE_TYPE, 1),
            row("magic", BIBLE_FOLDER_TYPE, 1),
            row("magic-detail", NOTE_TYPE, 2),
            row("after", "part", 0),
        ];
        let ids = bible_ids(&walk);
        assert_eq!(ids.len(), 4, "the bible root and its three descendants");
        for id in ["bible", "synopsis", "magic", "magic-detail"] {
            assert!(ids.contains(id), "{id} is inside the bible");
        }
        for id in ["keep", "keep-child", "after"] {
            assert!(!ids.contains(id), "{id} is manuscript");
        }
    }

    /// A NESTED `bible` row is not a second section. `bible_ids` takes the first
    /// root of that type, exactly as `trashed_ids` does, so a row a writer moved
    /// into a scene excludes nothing.
    #[test]
    fn a_bible_row_that_is_not_a_root_excludes_nothing() {
        let walk = vec![row("s", "scene", 0), row("decoy", BIBLE_TYPE, 1)];
        assert!(bible_ids(&walk).is_empty());
    }

    /// THE TWO SETS ARE ONE ANSWER. The union is what every count reads, and a
    /// fixture holding only one of them cannot tell a union from either half.
    #[test]
    fn the_excluded_set_is_the_bin_and_the_bible_together() {
        let walk = vec![
            row("keep", "scene", 0),
            row("bin", TRASH_TYPE, 0),
            row("gone", "scene", 1),
            row("bible", BIBLE_TYPE, 0),
            row("synopsis", NOTE_TYPE, 1),
        ];
        let ids = excluded_from_book(&walk);
        assert_eq!(ids.len(), 4);
        assert!(!ids.contains("keep"));
        for id in ["bin", "gone", "bible", "synopsis"] {
            assert!(ids.contains(id), "{id} is not part of the book");
        }
    }

    #[test]
    fn the_manuscript_walk_drops_the_bible_and_the_bin_and_keeps_their_order() {
        let walk = vec![
            row("keep", "part", 0),
            row("bible", BIBLE_TYPE, 0),
            row("synopsis", NOTE_TYPE, 1),
            row("bin", TRASH_TYPE, 0),
            row("gone", "scene", 1),
            row("last", "part", 0),
        ];
        let kept: Vec<String> = manuscript_items(walk).into_iter().map(|i| i.id).collect();
        assert_eq!(kept, vec!["keep".to_string(), "last".to_string()]);
    }

    /// THE THIRD STATE, and the whole reason `book_walk` exists. Front matter is
    /// IN the book and OUTSIDE the chapter sequence, which the two-valued
    /// `excluded_from_book` set cannot say: it holds "out of the book", and
    /// putting front matter in it would take a dedication out of the export.
    #[test]
    fn front_matter_is_in_the_book_and_not_in_the_excluded_set() {
        let walk = vec![
            row("front", FRONT_MATTER_TYPE, 0),
            row("dedication", MATTER_TYPE, 1),
            row("ch", "chapter", 0),
            row("back", BACK_MATTER_TYPE, 0),
            row("thanks", MATTER_TYPE, 1),
        ];
        assert!(excluded_from_book(&walk).is_empty());
        let kept: Vec<String> = manuscript_items(walk).into_iter().map(|i| i.id).collect();
        assert_eq!(
            kept,
            vec![
                "front".to_string(),
                "dedication".to_string(),
                "ch".to_string(),
                "back".to_string(),
                "thanks".to_string()
            ]
        );
    }

    #[test]
    fn book_walk_orders_front_matter_then_the_chapters_then_back_matter() {
        let walk = vec![
            row("ch", "chapter", 0),
            row("sc", "scene", 1),
            row("front", FRONT_MATTER_TYPE, 0),
            row("dedication", MATTER_TYPE, 1),
            row("back", BACK_MATTER_TYPE, 0),
            row("thanks", MATTER_TYPE, 1),
        ];
        let book = book_walk(walk);
        let ids = |v: &Vec<Item>| v.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&book.front), vec!["dedication".to_string()]);
        assert_eq!(
            ids(&book.chapters),
            vec!["ch".to_string(), "sc".to_string()]
        );
        assert_eq!(ids(&book.back), vec!["thanks".to_string()]);
    }

    /// THE SECTION ROOT IS A MARKER, NOT A HEADING. It never reaches a renderer,
    /// and its children are re-based so a top-level dedication sits at the depth
    /// a top-level chapter does -- otherwise every front-matter heading would be
    /// one level deeper than the book it introduces.
    #[test]
    fn book_walk_drops_the_section_roots_and_rebases_the_depths_beneath_them() {
        let walk = vec![
            row("front", FRONT_MATTER_TYPE, 0),
            row("foreword", MATTER_TYPE, 1),
            row("part-two", MATTER_TYPE, 2),
        ];
        let book = book_walk(walk);
        assert!(book.front.iter().all(|i| i.item_type == MATTER_TYPE));
        assert_eq!(
            book.front.iter().map(|i| i.depth).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn book_walk_leaves_out_the_bin_and_the_bible() {
        let walk = vec![
            row("ch", "chapter", 0),
            row("bible", BIBLE_TYPE, 0),
            row("synopsis", NOTE_TYPE, 1),
            row("bin", TRASH_TYPE, 0),
            row("gone", "scene", 1),
        ];
        let book = book_walk(walk);
        assert_eq!(
            book.chapters
                .iter()
                .map(|i| i.id.clone())
                .collect::<Vec<_>>(),
            vec!["ch".to_string()]
        );
        assert!(book.front.is_empty());
        assert!(book.back.is_empty());
    }

    /// A ROW OF THE SECTION'S OWN TYPE, INSIDE THE SECTION. It is an ordinary
    /// page of the book -- the writer put it there and the store enforces no
    /// types -- so it must be re-based and rendered like any other, not dropped
    /// with the root. Nothing else in the fixtures could tell the root apart
    /// from a row at depth 1, which is what let the first draft's type check
    /// look load-bearing.
    #[test]
    fn only_the_ROOT_of_a_section_is_dropped_and_not_a_row_of_the_same_type_inside_it() {
        let walk = vec![
            row("front", FRONT_MATTER_TYPE, 0),
            row("odd", FRONT_MATTER_TYPE, 1),
            row("dedication", MATTER_TYPE, 1),
        ];
        let book = book_walk(walk);
        assert_eq!(
            book.front.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            vec!["odd".to_string(), "dedication".to_string()]
        );
        assert!(book.front.iter().all(|i| i.depth == 0));
    }

    /// A `front` row a writer moved inside a scene is a row, not a section --
    /// `root_subtree_ids`' rule, and the reason `book_walk` reuses it rather
    /// than keying on the type alone.
    #[test]
    fn a_matter_root_that_is_not_a_root_is_an_ordinary_row_of_the_book() {
        let walk = vec![
            row("ch", "chapter", 0),
            row("decoy", FRONT_MATTER_TYPE, 1),
            row("under", MATTER_TYPE, 2),
        ];
        let book = book_walk(walk);
        assert!(book.front.is_empty());
        assert_eq!(book.chapters.len(), 3);
    }

    /// A MATTER DOCUMENT IS PROSE. Without a `doc` row a dedication is a title
    /// with nothing under it: unopenable, unflushable, and absent from every
    /// export.
    #[test]
    fn a_matter_document_is_created_with_a_document_and_its_section_is_not() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let front = store
            .item_create(None, FRONT_MATTER_TYPE, "Front matter")
            .unwrap();
        assert_eq!(front.doc_rev, None, "a section holds no prose of its own");
        let matter = store
            .item_create(Some(&front.id), MATTER_TYPE, "Dedication")
            .unwrap();
        assert_eq!(matter.doc_rev, Some(1));
    }

    /// NO MIGRATION. An item type is a free string in a column with no CHECK,
    /// so the two section types and the document type are data a v9 file already
    /// accepts -- and a build that added a version for them would refuse every
    /// project the previous build wrote for nothing.
    #[test]
    fn front_matter_needs_no_schema_version_of_its_own() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let store = Store::open(&path).unwrap();
        let front = store
            .item_create(None, FRONT_MATTER_TYPE, "Front matter")
            .unwrap();
        store
            .item_create(Some(&front.id), MATTER_TYPE, "Dedication")
            .unwrap();
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert!(store.conn.prepare("SELECT deleted_at FROM cast_member LIMIT 0").is_ok());
    }

    /// A NOTE CARRIES A DOCUMENT. Without this the bible has nothing to write
    /// in: only a row that gets a `doc` row is openable, flushable and
    /// snapshottable, and the whole of section (a) rests on a bible document
    /// being prose in every way except what it counts toward.
    #[test]
    fn a_note_is_created_with_a_document_and_a_container_is_not() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let bible = store.item_create(None, BIBLE_TYPE, "Bible").unwrap();
        assert_eq!(
            bible.doc_rev, None,
            "the bible root holds no prose of its own"
        );
        let note = store
            .item_create(Some(&bible.id), NOTE_TYPE, "Synopsis")
            .unwrap();
        assert_eq!(note.doc_rev, Some(1), "a note must be writable");
        assert_eq!(store.load_doc(&note.id).unwrap().body, EMPTY_DOC_BODY);
        let folder = store
            .item_create(Some(&bible.id), BIBLE_FOLDER_TYPE, "Characters")
            .unwrap();
        assert_eq!(folder.doc_rev, None, "a bible folder has no document body");
        let nested = store
            .item_create(Some(&folder.id), NOTE_TYPE, "Name")
            .unwrap();
        assert_eq!(nested.doc_rev, Some(1), "nested notes remain writable");
    }

    /// A TIMELINE CARRIES A DOCUMENT TOO, but NOT `EMPTY_DOC_BODY`: mutation
    /// target 6 is exactly this line, and the plan asks for a body that PARSES
    /// and NAMES ITS OWN KIND rather than one that merely differs by string
    /// equality -- so this parses the stored body as JSON and reads `kind`
    /// back out of it, the same shape the page's own `timeline-model.ts` will
    /// use.
    #[test]
    fn a_timeline_is_created_with_a_timeline_document_not_a_prosemirror_one() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let bible = store.item_create(None, BIBLE_TYPE, "Bible").unwrap();
        let timeline = store
            .item_create(Some(&bible.id), TIMELINE_TYPE, "Timeline")
            .unwrap();
        assert_eq!(timeline.doc_rev, Some(1), "a timeline must be writable");
        let body = store.load_doc(&timeline.id).unwrap().body;
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("a fresh timeline's body must be valid JSON");
        assert_eq!(parsed["kind"], "timeline");
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["tracks"], serde_json::json!([]));
        assert_eq!(parsed["events"], serde_json::json!([]));
    }

    /// AN INNER JOIN WOULD SILENTLY DROP THIS ROW'S WORDS, and that is a worse
    /// failure than the one the timeline exclusion exists to avoid: an orphaned
    /// `doc` row (its `item` row gone -- `open_readonly` sets no `foreign_keys`,
    /// so this is real corruption `cli.rs`'s `KIND_ORPHAN_DOC` already names,
    /// not a state this build cannot produce) must still be counted, not
    /// vanish with no `skipped` entry to say so. Proves the LEFT JOIN.
    #[test]
    fn word_index_counts_an_orphaned_docs_words_rather_than_dropping_them() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        store
            .conn
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, 0)",
                rusqlite::params![
                    "orphan-doc",
                    r#"{"type":"doc","content":[{"type":"paragraph","content":[
                         {"type":"text","text":"four good words here"}]}]}"#,
                ],
            )
            .unwrap();
        let index = store.word_index().unwrap();
        assert_eq!(index.count().words, 4, "the orphan's words were dropped");
        assert_eq!(
            index.count().skipped,
            0,
            "the body parsed fine; it is not damage"
        );
    }

    /// `document_texts`' own copy of the same guard, over the same fixture
    /// shape: an orphaned `doc` row must still be searchable, not silently
    /// missing from `project_find`'s corpus.
    #[test]
    fn document_texts_includes_an_orphaned_docs_prose() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        store
            .conn
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, 0)",
                rusqlite::params![
                    "orphan-doc",
                    r#"{"type":"doc","content":[{"type":"paragraph","content":[
                         {"type":"text","text":"a searchable harbour"}]}]}"#,
                ],
            )
            .unwrap();
        let (texts, scanned, skipped) = store.document_texts().unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(scanned, 1);
        assert_eq!(
            texts.get("orphan-doc").map(String::as_str),
            Some("a searchable harbour")
        );
    }

    #[test]
    fn a_project_with_no_bin_trashes_nothing() {
        let walk = vec![row("a", "part", 0), row("b", "scene", 1)];
        assert!(trashed_ids(&walk).is_empty());
    }

    #[test]
    fn the_bin_and_its_whole_subtree_are_trashed() {
        let walk = vec![
            row("keep", "part", 0),
            row("keep-child", "scene", 1),
            row("bin", TRASH_TYPE, 0),
            row("gone", "chapter", 1),
            row("gone-deep", "scene", 2),
        ];
        let got = trashed_ids(&walk);
        assert_eq!(got.len(), 3);
        for id in ["bin", "gone", "gone-deep"] {
            assert!(got.contains(id), "{id} should be trashed");
        }
    }

    #[test]
    fn a_sibling_after_the_bin_survives_it() {
        // The load-bearing case for the depth test. A bin that is not last means
        // the scan must STOP at the first row back down to the bin's level; a
        // scan that ran to the end of the walk would swallow the rest of the
        // book, and every earlier fixture here puts the bin last, where that
        // mistake is invisible.
        let walk = vec![
            row("bin", TRASH_TYPE, 0),
            row("gone", "scene", 1),
            row("after", "part", 0),
            row("after-child", "scene", 1),
        ];
        let got = trashed_ids(&walk);
        assert_eq!(got.len(), 2);
        assert!(got.contains("bin") && got.contains("gone"));
        assert!(!got.contains("after"), "a later root must survive");
        assert!(!got.contains("after-child"));
    }

    #[test]
    fn an_empty_bin_trashes_only_itself() {
        let walk = vec![row("bin", TRASH_TYPE, 0), row("after", "part", 0)];
        let got = trashed_ids(&walk);
        assert_eq!(got.len(), 1);
        assert!(got.contains("bin"));
    }

    #[test]
    fn the_bin_is_found_by_type_not_by_title() {
        // A writer may name a chapter "Trash". Nothing about that is the bin.
        let mut decoy = row("decoy", "chapter", 0);
        decoy.title = TRASH_TITLE.into();
        let walk = vec![decoy, row("child", "scene", 1)];
        assert!(trashed_ids(&walk).is_empty());
    }

    #[test]
    fn a_trash_typed_row_nested_inside_a_live_chapter_is_not_the_bin() {
        // The comment above `trashed_ids` claims "the FIRST root of
        // TRASH_TYPE wins" -- so a nested one, earlier in the depth-first
        // walk than the real root bin, must lose. Without the depth == 0
        // condition, this nested row wins instead: the live chapter around it
        // is wrongly excluded from the manuscript, and the real bin's
        // contents are wrongly kept in it.
        let walk = vec![
            row("chapter", "chapter", 0),
            row("nested-trash-decoy", TRASH_TYPE, 1),
            row("live-scene", "scene", 1),
            row("bin", TRASH_TYPE, 0),
            row("really-gone", "scene", 1),
        ];
        let got = trashed_ids(&walk);
        assert_eq!(got.len(), 2);
        assert!(got.contains("bin"));
        assert!(got.contains("really-gone"));
        assert!(!got.contains("chapter"), "the live chapter must survive");
        assert!(
            !got.contains("nested-trash-decoy"),
            "a non-root trash-typed row is not the bin"
        );
        assert!(!got.contains("live-scene"), "the live scene must survive");
    }

    #[test]
    fn without_trashed_keeps_the_manuscript_in_walk_order() {
        let walk = vec![
            row("a", "part", 0),
            row("a1", "scene", 1),
            row("bin", TRASH_TYPE, 0),
            row("gone", "scene", 1),
            row("z", "part", 0),
        ];
        let kept: Vec<String> = without_trashed(walk).into_iter().map(|i| i.id).collect();
        assert_eq!(kept, vec!["a", "a1", "z"]);
    }

    #[test]
    fn a_new_book_starts_with_a_chapter_holding_the_starter_scene() {
        // A CHAPTER IS NOT OPTIONAL, by design. A book
        // that opened as one bare scene is the emptiness that produced the
        // flat-outline defect twice: the page's placement rule had no part and
        // no chapter to hang anything on, so the first press could not indent.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("fresh.db")).unwrap();
        assert!(store.items().unwrap().is_empty());

        let created = store
            .ensure_starter_structure(&crate::strings::Strings::english())
            .unwrap();

        assert!(created);
        let items = store.items().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_type, "chapter");
        assert!(items[0].parent_id.is_none());
        assert_eq!(items[1].item_type, "scene");
        // INSIDE the chapter, asserted by id rather than by depth: a walk that
        // reported the right depth for a root scene would pass a depth check.
        assert_eq!(items[1].parent_id.as_deref(), Some(items[0].id.as_str()));
        // A scene with no document row would open as a crash, not as a blank page.
        assert!(store.load_doc(&items[1].id).is_ok());
    }

    #[test]
    fn the_starter_chapter_and_scene_are_named_by_the_page_s_own_convention() {
        // The reason `Untitled scene` was retired, applied to the
        // chapter: a starter named by a different convention makes a writer's
        // first two rows read as two systems.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("named.db")).unwrap();
        store
            .ensure_starter_structure(&crate::strings::Strings::english())
            .unwrap();
        let items = store.items().unwrap();
        // THE LITERALS, not the constants. Asserting `title == STARTER_*_TITLE`
        // compares the constant with itself and passes for any value either of
        // them is ever given -- a mutation renaming the chapter to
        // `Untitled chapter` survived exactly that. What is being pinned is the
        // page's `item.numbered.*` pattern at n = 1, which lives in another
        // language in another tree and is kept in step with these by hand.
        assert_eq!(items[0].title, "Chapter 1");
        assert_eq!(items[1].title, "Scene 1");
    }

    #[test]
    fn the_german_catalog_names_the_first_chapter_and_scene() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("german.db")).unwrap();

        store
            .ensure_starter_structure(&crate::strings::Strings::new(&crate::strings::DE))
            .unwrap();

        let items = store.items().unwrap();
        assert_eq!(items[0].title, "Kapitel 1");
        assert_eq!(items[1].title, "Szene 1");
    }

    #[test]
    fn ensure_starter_structure_is_a_no_op_on_a_project_that_has_items() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("fresh.db")).unwrap();
        store
            .ensure_starter_structure(&crate::strings::Strings::english())
            .unwrap();
        let first = store.items().unwrap();

        let created = store
            .ensure_starter_structure(&crate::strings::Strings::new(&crate::strings::DE))
            .unwrap();

        assert!(!created);
        let second = store.items().unwrap();
        assert_eq!(second.len(), 2);
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(first[1].id, second[1].id);
        assert_eq!(second[0].title, "Chapter 1");
        assert_eq!(second[1].title, "Scene 1");
    }

    #[test]
    fn ensure_starter_structure_fires_on_a_project_that_has_items_but_no_scene() {
        // THE CASE THE OLD EMPTINESS CHECK MISSED. A Markdown manuscript whose
        // headings are all `#` and `##` - an outline before any prose, which is
        // a legitimate thing to export and re-import - produces parts and
        // chapters and nothing openable. Only a scene carries a document, so
        // such a project imported without error and then could not be mounted
        // at all.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("outline.db")).unwrap();
        let part = store.item_create(None, "part", "Part One").unwrap();
        store
            .item_create(Some(&part.id), "chapter", "Chapter One")
            .unwrap();
        assert!(!store.items().unwrap().is_empty());

        let created = store
            .ensure_starter_structure(&crate::strings::Strings::english())
            .unwrap();

        assert!(created);
        let items = store.items().unwrap();
        assert_eq!(items.len(), 3);
        let scenes: Vec<_> = items.iter().filter(|i| i.item_type == "scene").collect();
        assert_eq!(scenes.len(), 1);
        // A root item, appended AFTER what was already there, so an imported
        // manuscript keeps its own order.
        assert!(scenes[0].parent_id.is_none());
        assert!(store.load_doc(&scenes[0].id).is_ok());
    }

    #[test]
    fn ensure_starter_structure_is_a_no_op_when_a_scene_exists_at_any_depth() {
        // The failing direction, and it is what keeps `create_imported` from
        // becoming "create plus a fill": a manuscript that arrived with its own
        // scenes must not carry an empty one nobody wrote. The scene here is
        // NESTED, so a check that only looked at root items would still add one.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("nested.db")).unwrap();
        let part = store.item_create(None, "part", "Part One").unwrap();
        let chapter = store
            .item_create(Some(&part.id), "chapter", "Chapter One")
            .unwrap();
        store
            .item_create(Some(&chapter.id), "scene", "A scene the writer wrote")
            .unwrap();
        let before = store.items().unwrap().len();

        let created = store
            .ensure_starter_structure(&crate::strings::Strings::english())
            .unwrap();

        assert!(!created);
        assert_eq!(store.items().unwrap().len(), before);
    }

    #[test]
    fn open_creates_the_current_schema() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project.db");
        let store = Store::open(&path).unwrap();
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);

        let tables: Vec<String> = store
            .conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            tables,
            vec![
                "analytics_adjustment",
                "analytics_category",
                "analytics_minute",
                "analytics_minute_segment",
                "analytics_movement",
                "analytics_movement_segment",
                "analytics_segment",
                "analytics_segment_session",
                "analytics_session",
                "appearance",
                "appearance_by_member",
                "blob",
                "cast_alias",
                "cast_field",
                "cast_member",
                "cast_member_active",
                "cast_member_order",
                "comment",
                "comment_item",
                "dict_word",
                "doc",
                "doc_version",
                "doc_version_blob",
                "doc_version_item",
                "doc_version_snap",
                "item",
                "item_root_sibling",
                "item_sibling",
                "knowledge_link",
                "knowledge_link_source",
                "knowledge_link_target",
                "meta",
                "research_resource",
                "research_resource_hash",
                "review_author",
                "review_group",
                "review_group_item",
                "review_hunk",
                "review_hunk_group",
                "review_message",
                "review_message_group",
                "revision_pass",
                "revision_task",
                "revision_task_item",
                "revision_task_pass",
                "snapshot",
                "synopsis"
            ]
        );
        // v3 adds no table and no index -- it is one column on `item`, so the
        // list above is unchanged and asserting it alone would pass on a build
        // whose ladder step never ran.
        let columns: Vec<String> = store
            .conn
            .prepare("SELECT name FROM pragma_table_info('item') ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            columns,
            vec![
                "id",
                "parent_id",
                "position",
                "rev",
                "state",
                "title",
                "type"
            ]
        );
    }

    #[test]
    fn a_v1_file_migrates_forward_keeping_its_prose() {
        // The case every existing project is in, including the ones the test
        // group is running. The ladder must ADD the history tables and leave
        // the manuscript exactly where it was - a migration that reached the
        // right schema by rewriting rows would be the worst defect this
        // application could ship.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v1.db");
        {
            // A genuine v1 file: the v1 DDL and nothing else.
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"
            ))
            .unwrap();
        }
        let seeded = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: created.id.clone(),
                    body: "{\"type\":\"doc\",\"content\":[]}".to_string(),
                    base_rev: created.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            created.id
        };

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        // The prose survived, byte for byte.
        assert_eq!(
            store.load_doc(&seeded).unwrap().body,
            "{\"type\":\"doc\",\"content\":[]}"
        );
        // And the new tables are usable, not merely present.
        assert!(store.doc_versions(&seeded).unwrap().is_empty());
        assert!(store.snapshots().unwrap().is_empty());
    }

    #[test]
    fn a_v2_file_migrates_forward_keeping_its_prose_and_its_history() {
        // The case every project the version-history slice touched is in. The
        // step is one ALTER, so the manuscript must arrive untouched AND the
        // history it accumulated must still be there -- a migration that reached
        // v3 by rebuilding the item table would take the doc_version rows'
        // foreign keys with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v2.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} PRAGMA user_version = 2; COMMIT;"
            ))
            .unwrap();
        }
        let (seeded, body) = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            (created.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        // And the column the step exists for is there, defaulted to the absence
        // that means `none` rather than to a word.
        assert_eq!(store.items().unwrap()[0].state, None);
    }

    #[test]
    fn a_v3_file_migrates_forward_keeping_prose_history_and_states() {
        // The case every project the revision-states slice touched is in. The
        // step is one CREATE TABLE, so all three things a v3 file already holds
        // must arrive untouched: the manuscript, the history it accumulated, and
        // the marks the writer put on their outline. A migration that reached v4
        // by rebuilding the item table would take the doc_version rows' foreign
        // keys AND the state column with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v3.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} PRAGMA user_version = 3; COMMIT;"
            ))
            .unwrap();
        }
        let (seeded, body) = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            (created.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        // And the table the step exists for is usable, not merely present.
        assert!(store.comments(&seeded).unwrap().is_empty());
        assert!(store.comment_create(&seeded, "note", 1, 4, "q").is_ok());
    }

    #[test]
    fn a_v4_file_migrates_forward_keeping_prose_history_states_and_comments() {
        // The case every project the comments slice touched is in. The step is
        // one CREATE TABLE, so all four things a v4 file already holds must
        // arrive untouched: the manuscript, the history it accumulated, the
        // marks the writer put on their outline, and the notes they left on
        // their own prose. A migration that reached v5 by rebuilding the item
        // table would take the doc_version rows' foreign keys, the state
        // column AND the comment rows' foreign key with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v4.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} PRAGMA user_version = 4; COMMIT;",
                comments::SCHEMA_V4,
            ))
            .unwrap();
        }
        let (seeded, body) = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            store
                .comment_create(&created.id, "note", 1, 4, "q")
                .unwrap();
            (created.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        assert_eq!(store.comments(&seeded).unwrap().len(), 1);
        // And the table the step exists for is usable, not merely present.
        assert!(store.dict_words().unwrap().is_empty());
        assert!(store.dict_add("Zorbulax").is_ok());
    }

    #[test]
    fn a_v5_file_migrates_forward_keeping_prose_history_states_comments_and_the_wordlist() {
        // The case every project the bible slice touched is in. The step is one
        // CREATE TABLE, so all five things a v5 file already holds must arrive
        // untouched: the manuscript, the history it accumulated, the marks on
        // the outline, the notes on the prose, and the project's own spelling
        // list. A migration that reached v6 by rebuilding the item table would
        // take the doc_version rows' foreign keys, the state column AND the
        // comment rows' foreign key with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v5.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} {} PRAGMA user_version = 5; COMMIT;",
                comments::SCHEMA_V4,
                dict::SCHEMA_V5,
            ))
            .unwrap();
        }
        let (seeded, body) = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            store
                .comment_create(&created.id, "note", 1, 4, "q")
                .unwrap();
            store.dict_add("Zorbulax").unwrap();
            (created.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        assert_eq!(store.comments(&seeded).unwrap().len(), 1);
        assert_eq!(store.dict_words().unwrap().len(), 1);
        // And the table the step exists for is usable, not merely present.
        assert_eq!(store.synopsis(&seeded).unwrap(), None);
        assert!(store.synopsis_set(&seeded, "she burns it").is_ok());
    }

    #[test]
    fn a_v6_file_migrates_forward_keeping_everything_v6_already_held() {
        // The case every project the synopsis slice touched is in. The step is
        // two CREATEs and an index, so all six things a v6 file already holds
        // must arrive untouched: the manuscript, the history it accumulated,
        // the marks on the outline, the notes on the prose, the project's own
        // spelling list, and the summaries. A migration that reached v7 by
        // rebuilding the item table would take the doc_version rows' foreign
        // keys, the state column, the comment rows' foreign key AND the
        // synopsis rows' foreign key with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v6.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} {} {} PRAGMA user_version = 6; COMMIT;",
                comments::SCHEMA_V4,
                dict::SCHEMA_V5,
                synopsis::SCHEMA_V6,
            ))
            .unwrap();
        }
        let (seeded, body) = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            store
                .comment_create(&created.id, "note", 1, 4, "q")
                .unwrap();
            store.dict_add("Zorbulax").unwrap();
            store
                .synopsis_set(&created.id, "she burns the letter")
                .unwrap();
            (created.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        assert_eq!(store.comments(&seeded).unwrap().len(), 1);
        assert_eq!(store.dict_words().unwrap().len(), 1);
        assert_eq!(
            store.synopsis(&seeded).unwrap().unwrap().body,
            "she burns the letter"
        );
        // And the tables the step exists for are usable, not merely present.
        assert!(store.cast_list().unwrap().is_empty());
        let made = store.cast_create(cast::KIND_CHARACTER, "Ilse").unwrap();
        assert!(store
            .cast_set(
                &made.id,
                cast::KIND_CHARACTER,
                "Ilse",
                "keeps the letter",
                &[cast::CastField {
                    label: "accent".into(),
                    value: "flat northern".into()
                }],
                &[],
            )
            .is_ok());
    }

    #[test]
    fn a_v7_file_migrates_forward_keeping_everything_v7_already_held() {
        // The case every project the cast slice touched is in. The step is ONE
        // ALTER, so all seven things a v7 file already holds must arrive
        // untouched: the manuscript, its history, the marks on the outline, the
        // notes on the prose, the spelling list, the summaries and the cast
        // itself -- including its detail fields, which hang off `cast_member`
        // by a foreign key a table rebuild would take with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v7.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} {} {} {} PRAGMA user_version = 7; COMMIT;",
                comments::SCHEMA_V4,
                dict::SCHEMA_V5,
                synopsis::SCHEMA_V6,
                cast::SCHEMA_V7,
            ))
            .unwrap();
        }
        let (seeded, member, body) = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            store
                .comment_create(&created.id, "note", 1, 4, "q")
                .unwrap();
            store.dict_add("Zorbulax").unwrap();
            store
                .synopsis_set(&created.id, "she burns the letter")
                .unwrap();
            let made = store.cast_create(cast::KIND_CHARACTER, "Ilse").unwrap();
            // WRITTEN AS SQL, not through `cast_set`. This connection is at v7
            // and `cast_set` reads `picture_path`, so calling it here would
            // exercise this build's v8 code against a v7 file -- which is a
            // state the ladder makes unreachable and a fixture must not invent.
            // What is being migrated is the v7 file a v7 BUILD wrote.
            store
                .conn
                .execute(
                    "UPDATE cast_member SET summary = 'keeps the letter' WHERE id = ?1",
                    [&made.id],
                )
                .unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO cast_field (member_id, ordinal, label, value)
                     VALUES (?1, 0, 'accent', 'flat northern')",
                    [&made.id],
                )
                .unwrap();
            (created.id, made.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        assert_eq!(store.comments(&seeded).unwrap().len(), 1);
        assert_eq!(store.dict_words().unwrap().len(), 1);
        assert_eq!(
            store.synopsis(&seeded).unwrap().unwrap().body,
            "she burns the letter"
        );
        let carried = store.cast_member(&member).unwrap().unwrap();
        assert_eq!(carried.name, "Ilse");
        assert_eq!(carried.summary, "keeps the letter");
        assert_eq!(carried.fields.len(), 1);
        // And the column the step exists for is usable, not merely present --
        // and it arrives EMPTY on a file that predates it, which is what makes
        // "no picture" the same answer for an old book and a new one.
        assert_eq!(carried.picture_path, None);
        assert_eq!(store.pictures_named().unwrap(), 0);
        assert!(store.cast_set_picture(&member, Some("face.jpg")).is_ok());
    }

    #[test]
    fn a_v8_file_migrates_forward_keeping_everything_v8_already_held() {
        // The case every project the pictures slice touched is in. The step is
        // ONE new table, so all eight things a v8 file already holds must
        // arrive untouched: the manuscript, its history, the marks on the
        // outline, the notes on the prose, the spelling list, the summaries,
        // the cast with its detail fields, and the picture name on a member --
        // the last two hanging off `cast_member`, which a step that reached v9
        // by rebuilding a table would take the foreign keys of.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v8.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} {} {} {} {} PRAGMA user_version = 8; COMMIT;",
                comments::SCHEMA_V4,
                dict::SCHEMA_V5,
                synopsis::SCHEMA_V6,
                cast::SCHEMA_V7,
                cast::SCHEMA_V8,
            ))
            .unwrap();
        }
        let (seeded, member, body) = {
            // Raw, so the file stays at v8, but with the collation every
            // connection this crate opens carries: the cast list sorts with it.
            let conn = rusqlite::Connection::open(&path).unwrap();
            register_collations(&conn).unwrap();
            let store = Store { conn };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            store
                .comment_create(&created.id, "note", 1, 4, "q")
                .unwrap();
            store.dict_add("Zorbulax").unwrap();
            store
                .synopsis_set(&created.id, "she burns the letter")
                .unwrap();
            let made = store.cast_create(cast::KIND_CHARACTER, "Ilse").unwrap();
            // WRITTEN AS SQL, not through `cast_set`/`cast_set_picture`. This
            // connection is at v8 and both now read or write `cast_alias`
            // (`cast_set_picture` through `cast_list`), so calling either here
            // would exercise this build's v10 code against a v8 file -- the
            // v7 test's own reason, one version up.
            store
                .conn
                .execute(
                    "UPDATE cast_member SET summary = 'keeps the letter', picture_path = 'face.jpg' WHERE id = ?1",
                    [&made.id],
                )
                .unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO cast_field (member_id, ordinal, label, value)
                     VALUES (?1, 0, 'accent', 'flat northern')",
                    [&made.id],
                )
                .unwrap();
            (created.id, made.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        assert_eq!(store.comments(&seeded).unwrap().len(), 1);
        assert_eq!(store.dict_words().unwrap().len(), 1);
        assert_eq!(
            store.synopsis(&seeded).unwrap().unwrap().body,
            "she burns the letter"
        );
        let carried = store.cast_member(&member).unwrap().unwrap();
        assert_eq!(carried.name, "Ilse");
        assert_eq!(carried.summary, "keeps the letter");
        assert_eq!(carried.fields.len(), 1);
        assert_eq!(carried.picture_path.as_deref(), Some("face.jpg"));
        // And the table the step exists for is USABLE, not merely present --
        // and it arrives EMPTY on a file that predates it, which is what makes
        // "nobody has been tagged" the same answer for an old book and a new
        // one.
        assert_eq!(store.appearance_count().unwrap(), 0);
        assert!(store.appearances().unwrap().is_empty());
        store.appearances_set(&seeded, &[member.clone()]).unwrap();
        assert_eq!(store.appearance_count().unwrap(), 1);
    }

    #[test]
    fn a_v9_file_migrates_forward_keeping_everything_v9_already_held() {
        // The case every project the appearances slice touched is in. The step
        // is ONE new table, so all nine things a v9 file already holds must
        // arrive untouched: the manuscript, its history, the marks on the
        // outline, the notes on the prose, the spelling list, the summaries,
        // the cast with its detail fields, the picture name on a member, AND
        // the appearance rows -- the last hanging off both `item` and
        // `cast_member` by foreign keys a table rebuild would take with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v9.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} {} {} {} {} {} PRAGMA user_version = 9; COMMIT;",
                comments::SCHEMA_V4,
                dict::SCHEMA_V5,
                synopsis::SCHEMA_V6,
                cast::SCHEMA_V7,
                cast::SCHEMA_V8,
                appearances::SCHEMA_V9,
            ))
            .unwrap();
        }
        let (seeded, member, body) = {
            let conn = rusqlite::Connection::open(&path).unwrap();
            register_collations(&conn).unwrap();
            let store = Store { conn };
            let created = store.item_create(None, "scene", "Chapter One").unwrap();
            let body = "{\"type\":\"doc\",\"content\":[]}".to_string();
            let entries = [FlushEntry {
                item_id: created.id.clone(),
                body: body.clone(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }];
            store.flush(&entries).unwrap();
            store.record_versions(&entries).unwrap();
            store.snapshot_create("before the second act").unwrap();
            store
                .item_set_state(&created.id, Some("revising"), created.rev)
                .unwrap();
            store
                .comment_create(&created.id, "note", 1, 4, "q")
                .unwrap();
            store.dict_add("Zorbulax").unwrap();
            store
                .synopsis_set(&created.id, "she burns the letter")
                .unwrap();
            let made = store.cast_create(cast::KIND_CHARACTER, "Ilse").unwrap();
            // WRITTEN AS SQL, not through `cast_set`/`cast_set_picture`. This
            // connection is at v9 and both now read or write `cast_alias`
            // (`cast_set_picture` through `cast_list`), so calling either here
            // would exercise this build's v10 code against a v9 file -- the
            // v7 and v8 tests' own reason, one version up each time.
            store
                .conn
                .execute(
                    "UPDATE cast_member SET summary = 'keeps the letter', picture_path = 'face.jpg' WHERE id = ?1",
                    [&made.id],
                )
                .unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO cast_field (member_id, ordinal, label, value)
                     VALUES (?1, 0, 'accent', 'flat northern')",
                    [&made.id],
                )
                .unwrap();
            // A v9 fixture cannot use the current writer: it now checks the
            // v14 soft-delete column before accepting a cast member.
            store
                .conn
                .execute(
                    "INSERT INTO appearance (item_id, cast_member_id) VALUES (?1, ?2)",
                    rusqlite::params![created.id, made.id],
                )
                .unwrap();
            (created.id, made.id, body)
        };
        let versions_before = {
            let store = Store {
                conn: rusqlite::Connection::open(&path).unwrap(),
            };
            store.doc_versions(&seeded).unwrap().len()
        };
        assert!(
            versions_before > 0,
            "the fixture must carry history to be worth migrating"
        );

        let store = Store::open(&path).unwrap();

        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.load_doc(&seeded).unwrap().body, body);
        assert_eq!(store.doc_versions(&seeded).unwrap().len(), versions_before);
        assert_eq!(store.snapshots().unwrap().len(), 1);
        assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("revising"));
        assert_eq!(store.comments(&seeded).unwrap().len(), 1);
        assert_eq!(store.dict_words().unwrap().len(), 1);
        assert_eq!(
            store.synopsis(&seeded).unwrap().unwrap().body,
            "she burns the letter"
        );
        let carried = store.cast_member(&member).unwrap().unwrap();
        assert_eq!(carried.name, "Ilse");
        assert_eq!(carried.summary, "keeps the letter");
        assert_eq!(carried.fields.len(), 1);
        assert_eq!(carried.picture_path.as_deref(), Some("face.jpg"));
        assert_eq!(store.appearance_count().unwrap(), 1);
        // And the column the step exists for is usable, not merely present --
        // and it arrives EMPTY on a file that predates it, which is what makes
        // "nobody has an alias" the same answer for an old book and a new one.
        assert!(carried.aliases.is_empty());
        assert!(store
            .cast_set(
                &member,
                cast::KIND_CHARACTER,
                "Ilse",
                "keeps the letter",
                &[],
                &["Ils".to_string()],
            )
            .is_ok());
        assert_eq!(
            store.cast_member(&member).unwrap().unwrap().aliases,
            vec!["Ils".to_string()]
        );
    }

    #[test]
    fn an_older_file_walks_without_the_state_column() {
        // `open_readonly` does not migrate, deliberately: the CLI's read-only
        // subcommands walk a v1 file in place. The walk names `state`, so
        // without the substitution in items() this fails with "no such column"
        // -- which a reader would take for a damaged project rather than an old
        // one.
        let dir = tempdir().unwrap();
        let path = dir.path().join("v1.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"
            ))
            .unwrap();
            let store = Store { conn };
            store.item_create(None, "scene", "Only").unwrap();
        }

        let store = Store::open_readonly(&path).unwrap();
        let items = store.items().unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state, None);
        assert_eq!(
            store.user_version().unwrap(),
            1,
            "reading migrated the project"
        );
    }

    #[test]
    fn a_state_is_set_and_reported_by_the_walk() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "chapter", "One").unwrap();

        let rev = store
            .item_set_state(&created.id, Some("revising"), created.rev)
            .unwrap();

        assert_eq!(rev, created.rev + 1);
        let items = store.items().unwrap();
        assert_eq!(items[0].state.as_deref(), Some("revising"));
        assert_eq!(items[0].rev, rev);
    }

    #[test]
    fn every_state_in_the_closed_set_is_accepted() {
        // One test naming one state would pass with a member misspelled in
        // exactly one place, which is the shape a closed set restated in three
        // languages fails in.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "scene", "One").unwrap();

        let mut rev = created.rev;
        for state in ITEM_STATES {
            rev = store.item_set_state(&created.id, Some(state), rev).unwrap();
            assert_eq!(
                store.items().unwrap()[0].state.as_deref(),
                Some(state),
                "{state} was accepted and then not reported"
            );
        }
    }

    #[test]
    fn clearing_a_state_stores_null_and_not_the_word_none() {
        // The whole of the absent-default decision. A file holding the string
        // would make "the writer chose none" and "the writer chose nothing" two
        // states of one fact, and every reader would have to know both.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "scene", "One").unwrap();
        let rev = store
            .item_set_state(&created.id, Some("draft"), created.rev)
            .unwrap();

        store.item_set_state(&created.id, None, rev).unwrap();

        assert_eq!(store.items().unwrap()[0].state, None);
        let raw: Option<String> = store
            .conn
            .query_row("SELECT state FROM item WHERE id = ?1", [&created.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            raw, None,
            "the column holds a word where it should hold NULL"
        );
    }

    #[test]
    fn an_unknown_state_is_refused_and_nothing_is_written() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "scene", "One").unwrap();
        store
            .item_set_state(&created.id, Some("draft"), created.rev)
            .unwrap();
        let before = store.items().unwrap()[0].rev;

        let err = store
            .item_set_state(&created.id, Some("finished"), before)
            .unwrap_err();

        assert!(matches!(err, StoreError::UnknownState { ref state } if state == "finished"));
        let after = &store.items().unwrap()[0];
        // The rev did NOT move: a refusal that bumped it would invalidate the
        // page's base_rev for a call the store declined to perform.
        assert_eq!(after.rev, before);
        assert_eq!(after.state.as_deref(), Some("draft"));
    }

    #[test]
    fn a_stale_base_rev_is_a_conflict_and_the_rename_survives() {
        // The case this discipline exists for: a page holding an old walk sets a
        // state against a rev a rename has already spent, and without the check
        // the UPDATE writes the state over the new title's revision.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "scene", "One").unwrap();
        store
            .item_rename(&created.id, "Renamed", created.rev)
            .unwrap();

        let err = store
            .item_set_state(&created.id, Some("done"), created.rev)
            .unwrap_err();

        assert!(matches!(err, StoreError::Conflict { .. }));
        let after = &store.items().unwrap()[0];
        assert_eq!(after.state, None);
        assert_eq!(after.title, "Renamed", "the rename was overwritten");
    }

    #[test]
    fn setting_a_state_on_an_item_that_is_gone_is_not_a_conflict() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();

        let err = store
            .item_set_state("no-such-item", Some("draft"), 1)
            .unwrap_err();

        assert!(matches!(err, StoreError::UnknownItem { .. }));
    }

    #[test]
    fn a_state_survives_a_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let id = {
            let store = Store::open(&path).unwrap();
            let created = store.item_create(None, "part", "One").unwrap();
            store
                .item_set_state(&created.id, Some("outline"), created.rev)
                .unwrap();
            created.id
        };

        let store = Store::open(&path).unwrap();

        let items = store.items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id);
        assert_eq!(items[0].state.as_deref(), Some("outline"));
    }

    #[test]
    fn two_threads_migrating_the_same_old_file_both_succeed() {
        // Two instances opening the same behind-schedule project together:
        // both read version 1 before either has written anything, both try to
        // reach v4. Without BEGIN IMMEDIATE and the re-read inside the
        // transaction, the loser's CREATE TABLE runs against a table the
        // winner already created and fails with a raw SQLite string. A real
        // barrier is used so this genuinely races rather than merely
        // asserting the sequential no-op case `migrating_twice_is_a_no_op`
        // already covers.
        let dir = tempdir().unwrap();
        let path = dir.path().join("race.db");
        {
            // A genuine v1 file, same shape as `a_v1_file_migrates_forward`.
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"
            ))
            .unwrap();
        }

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let conn = rusqlite::Connection::open(&path).unwrap();
                    conn.pragma_update(None, "busy_timeout", 5000).unwrap();
                    let store = Store { conn };
                    barrier.wait();
                    store.migrate()
                })
            })
            .collect();

        for h in handles {
            h.join().expect("thread panicked").expect("migrate failed");
        }

        let check = rusqlite::Connection::open(&path).unwrap();
        let version: i64 = check
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        // The ladder must be re-entrant: `open` runs it on every launch, and a
        // step that ran again would fail on `CREATE TABLE` and take the
        // project with it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("twice.db");
        let first = Store::open(&path).unwrap();
        let created = first.item_create(None, "scene", "One").unwrap();
        drop(first);

        let second = Store::open(&path).unwrap();

        assert_eq!(second.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(second.items().unwrap().len(), 1);
        assert!(second.doc_versions(&created.id).unwrap().is_empty());
    }

    #[test]
    fn wal_and_full_sync_are_set_on_the_live_connection() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();

        let journal: String = store
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal.to_lowercase(), "wal");

        // 2 == FULL. NORMAL (1) defers the fsync to checkpoint, so a power cut
        // can lose a transaction SQLite already reported as committed.
        let sync: i64 = store
            .conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 2);

        let fk: i64 = store
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn reopen_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project.db");
        Store::open(&path).unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project.db");
        {
            let store = Store::open(&path).unwrap();
            store
                .conn
                .execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
                .unwrap();
        }
        match Store::open(&path) {
            Err(StoreError::NewerSchema { found, supported }) => {
                assert_eq!((found, supported), (SCHEMA_VERSION + 1, SCHEMA_VERSION));
            }
            other => panic!("expected NewerSchema, got {other:?}"),
        }
    }

    fn seed_two(store: &Store) {
        store
            .conn
            .execute_batch(
                "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES
                   ('i2', NULL, 'scene', 'Bravo', '0010', 1),
                   ('i1', NULL, 'scene', 'Alpha', '0000', 1);
                 INSERT INTO doc (item_id, body, rev, updated_at) VALUES
                   ('i1', '{\"type\":\"doc\"}', 1, 0);",
            )
            .unwrap();
    }

    #[test]
    fn items_come_back_in_position_order_not_insert_order() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        let items = store.items().unwrap();
        assert_eq!(
            items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["i1", "i2"]
        );
        assert_eq!(items[0].title, "Alpha");
        assert_eq!(items[0].item_type, "scene");
    }

    #[test]
    fn doc_load_returns_body_and_rev() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        let doc = store.load_doc("i1").unwrap();
        assert_eq!(doc.body, "{\"type\":\"doc\"}");
        assert_eq!(doc.rev, 1);
    }

    #[test]
    fn a_doc_with_no_item_is_rejected_by_foreign_keys() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        let err = store.conn.execute(
            "INSERT INTO doc (item_id, body, rev, updated_at) VALUES ('ghost', '{}', 1, 0)",
            [],
        );
        assert!(err.is_err(), "foreign_keys must reject an orphan doc");
        let err = err.unwrap_err();
        eprintln!("foreign-key rejection error: {err}");
        match &err {
            rusqlite::Error::SqliteFailure(e, _) => {
                assert_eq!(
                    e.code,
                    rusqlite::ErrorCode::ConstraintViolation,
                    "expected a constraint violation, got: {err}"
                );
            }
            other => panic!("expected SqliteFailure(ConstraintViolation), got: {other}"),
        }
    }

    #[test]
    fn deleting_an_item_cascades_to_its_doc() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        store
            .conn
            .execute("DELETE FROM item WHERE id = 'i1'", [])
            .unwrap();
        let count: i64 = store
            .conn
            .query_row("SELECT count(*) FROM doc WHERE item_id = 'i1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn items_never_carry_document_bodies() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        // Serialized shape is what crosses to the page. If a body ever joins
        // this query, the navigator silently retains the manuscript again —
        // the exact regression `lazy-docs` measured at 95 MB of peak RSS.
        let json = serde_json::to_string(&store.items().unwrap()).unwrap();
        assert!(
            !json.contains("body"),
            "items() leaked a document body: {json}"
        );
        assert!(
            json.contains("\"type\":\"scene\""),
            "serde rename to `type` is missing: {json}"
        );
    }

    #[test]
    fn siblings_are_position_ordered_and_a_subtree_splits_its_parents_group() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES
               ('rootA', NULL,    'part',    'Root A', '0000', 1),
               ('rootB', NULL,    'part',    'Root B', '0010', 1),
               ('a2',    'rootA', 'chapter', 'A2',     '0010', 1),
               ('a1',    'rootA', 'chapter', 'A1',     '0000', 1),
               ('a1a',   'a1',    'scene',   'A1a',    '0000', 1);",
            )
            .unwrap();
        let items = store.items().unwrap();
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();

        // Insert order is deliberately not position order, so this also proves
        // siblings come back position-ordered rather than as stored.
        assert_eq!(ids, vec!["rootA", "a1", "a1a", "a2", "rootB"]);

        // The property this test used to assert — contiguous sibling groups —
        // is what a tree walk must BREAK: a1's subtree lands between a1 and its
        // own sibling a2. Asserting it explicitly so a regrouping regression
        // fails here rather than silently reordering the navigator.
        let groups: Vec<Option<&str>> = items.iter().map(|i| i.parent_id.as_deref()).collect();
        assert_eq!(
            groups,
            vec![None, Some("rootA"), Some("a1"), Some("rootA"), None],
            "a grandchild must interrupt its parent's sibling group"
        );

        let a_children: Vec<&str> = items
            .iter()
            .filter(|i| i.parent_id.as_deref() == Some("rootA"))
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(
            a_children,
            vec!["a1", "a2"],
            "siblings must be position-ordered"
        );
    }

    #[test]
    fn a_subtree_stays_ahead_of_a_longer_sibling_key() {
        // The walk's ordering rests on '/' (0x2F) sorting below every base-62
        // digit (0x30 and up): a child's path must beat a sibling key that
        // extends the parent's, which is what `between` produces on insert.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES
               ('a',      NULL, 'part',    'A',      '0V',   1),
               ('b',      NULL, 'part',    'B',      '0V5',  1),
               ('a-kid',  'a',  'chapter', 'A kid',  '0000', 1);",
            )
            .unwrap();
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["a", "a-kid", "b"]);
    }

    fn nested_store(dir: &std::path::Path) -> Store {
        let store = Store::open(&dir.join("p.db")).unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES
                   ('p-1', NULL,  'part',    'Part One', '0000', 1),
                   ('p-2', NULL,  'part',    'Part Two', '0010', 1),
                   ('c-1', 'p-1', 'chapter', 'Ch A',     '0000', 1),
                   ('c-2', 'p-1', 'chapter', 'Ch B',     '0010', 1),
                   ('s-1', 'c-1', 'scene',   'Sc 1',     '0000', 1),
                   ('c-3', 'p-2', 'chapter', 'Ch C',     '0000', 1);",
            )
            .unwrap();
        store
    }

    #[test]
    fn the_walk_is_depth_first_not_grouped_by_parent() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn the_walk_carries_depth() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let items = store.items().unwrap();
        let depth = |id: &str| items.iter().find(|i| i.id == id).unwrap().depth;
        assert_eq!(depth("p-1"), 0);
        assert_eq!(depth("c-1"), 1);
        assert_eq!(depth("s-1"), 2);
    }

    #[test]
    fn an_orphaned_row_is_an_error_not_a_silently_shorter_walk() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        // foreign_keys is ON, so insert the orphan with it off: this simulates a
        // corrupt file, which is exactly the case that must not silently lose rows.
        store
            .conn
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES ('orphan', 'missing', 'scene', 'Lost', '0000', 1)",
                [],
            )
            .unwrap();
        match store.items() {
            // Only the count can fail: "orphan" is boilerplate in every Corrupt
            // message, so asserting on it would assert nothing.
            Err(StoreError::Corrupt(msg)) => assert!(msg.contains("6 of 7"), "{msg}"),
            other => panic!("expected Corrupt, got {other:?}"),
        }
    }

    #[test]
    fn a_parent_cycle_errors_rather_than_looping() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES
                   ('x', 'y', 'scene', 'X', '0000', 1),
                   ('y', 'x', 'scene', 'Y', '0000', 1);",
            )
            .unwrap();
        // Must return, not hang. A cycle is unreachable from a NULL-parent root,
        // so this surfaces as the row-count mismatch rather than as recursion.
        assert!(store.items().is_err());
    }

    #[test]
    fn a_chain_deeper_than_max_depth_is_truncated_and_reported() {
        // The case MAX_DEPTH actually defends: reachable from a root, so the
        // recursion would otherwise run to the row count. A cycle cannot
        // exercise this — every node in one has a non-NULL parent.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("deep.db")).unwrap();
        let rows = MAX_DEPTH + 1;
        store.conn.execute_batch("BEGIN").unwrap();
        for n in 0..rows {
            let parent = if n == 0 {
                "NULL".to_string()
            } else {
                format!("'i{}'", n - 1)
            };
            store
                .conn
                .execute_batch(&format!(
                    "INSERT INTO item (id, parent_id, type, title, position, rev)
                     VALUES ('i{n}', {parent}, 'scene', 'D{n}', '0000', 1)"
                ))
                .unwrap();
        }
        store.conn.execute_batch("COMMIT").unwrap();

        match store.items() {
            Err(StoreError::Corrupt(msg)) => {
                assert!(msg.contains(&format!("{MAX_DEPTH} of {rows}")), "{msg}")
            }
            other => panic!("expected Corrupt, got {other:?}"),
        }

        // One shallower must walk cleanly, or the bound is off by one and the
        // error above would be proving nothing about MAX_DEPTH.
        store
            .conn
            .execute("DELETE FROM item WHERE id = ?1", [format!("i{}", rows - 1)])
            .unwrap();
        assert_eq!(store.items().unwrap().len() as i64, MAX_DEPTH);
    }

    #[test]
    fn two_siblings_cannot_share_a_position() {
        // Not tidiness: identical sibling keys give the two subtrees identical
        // path prefixes, so the walk interleaves them and the row count still
        // reconciles. Unwritable beats undetectable.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let err = store.conn.execute(
            "INSERT INTO item (id, parent_id, type, title, position, rev)
             VALUES ('c-dup', 'p-1', 'chapter', 'Dup', '0000', 1)",
            [],
        );
        match err {
            Err(rusqlite::Error::SqliteFailure(e, _)) => {
                assert_eq!(e.code, rusqlite::ErrorCode::ConstraintViolation)
            }
            other => panic!("expected a constraint violation, got {other:?}"),
        }
        // Same position under a DIFFERENT parent is legitimate and must stay
        // writable: every first child in the project shares the first key.
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES ('s-2', 'c-2', 'scene', 'Sc 2', '0000', 1)",
                [],
            )
            .unwrap();
    }

    #[test]
    fn two_root_items_cannot_share_a_position_either() {
        // A unique index treats NULLs as distinct, so item_sibling constrains
        // nothing when parent_id IS NULL -- it accepted a duplicate root key and
        // items() then returned a full row count in a nondeterministic order,
        // which is precisely the silent interleave the index exists to prevent.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let err = store.conn.execute(
            "INSERT INTO item (id, parent_id, type, title, position, rev)
             VALUES ('p-dup', NULL, 'part', 'Dup', '0000', 1)",
            [],
        );
        match err {
            Err(rusqlite::Error::SqliteFailure(e, _)) => {
                assert_eq!(e.code, rusqlite::ErrorCode::ConstraintViolation)
            }
            other => panic!("expected a constraint violation, got {other:?}"),
        }
        assert_eq!(store.items().unwrap().len(), 6, "the reject must not land");
        // A root key that is merely free stays writable.
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES ('p-3', NULL, 'part', 'Part Three', '0020', 1)",
                [],
            )
            .unwrap();
    }

    #[test]
    fn creating_a_scene_writes_an_empty_document_in_the_same_transaction() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store.item_create(Some("c-1"), "scene", "Sc 2").unwrap();
        // Without the doc row, the first click on the new scene is a NotFound
        // that presents as a load bug rather than a create bug.
        let doc = store.load_doc(&made.id).unwrap();
        assert_eq!(doc.rev, 1);
        let parsed: serde_json::Value = serde_json::from_str(&doc.body).unwrap();
        assert_eq!(parsed["type"], "doc");
    }

    #[test]
    fn creating_a_chapter_writes_no_document() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store.item_create(Some("p-1"), "chapter", "Ch D").unwrap();
        assert!(store.load_doc(&made.id).is_err());
        assert_eq!(made.doc_rev, None);
    }

    #[test]
    fn a_new_scene_can_be_saved_from_doc_rev_without_loading_it_first() {
        // The seam this field exists to close: item_create writes the doc row at
        // rev 1, and flush treats base_rev 0 against an existing row as a
        // Conflict, so create -> type -> save with no load_doc in between would
        // conflict on the writer's very first save.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store.item_create(Some("c-1"), "scene", "Sc 2").unwrap();
        let base_rev = made
            .doc_rev
            .expect("a scene must report its document revision");

        let acks = store
            .flush(&[FlushEntry {
                item_id: made.id.clone(),
                body: "typed".into(),
                base_rev,
                comments: None,
            }])
            .unwrap();
        assert_eq!(acks[0].rev, 2);
        assert_eq!(store.load_doc(&made.id).unwrap().body, "typed");

        // The negative half: without doc_rev a caller would send 0, and that is
        // the conflict the field prevents.
        match store.flush(&[FlushEntry {
            item_id: made.id.clone(),
            body: "blind".into(),
            base_rev: 0,
            comments: None,
        }]) {
            Err(StoreError::Conflict { item_id }) => assert_eq!(item_id, made.id),
            other => panic!("expected Conflict on a base_rev 0 blind write, got {other:?}"),
        }
        assert_eq!(store.load_doc(&made.id).unwrap().body, "typed");
    }

    #[test]
    fn a_created_item_appends_after_its_last_sibling() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store.item_create(Some("p-1"), "chapter", "Ch D").unwrap();
        let items = store.items().unwrap();
        let ids: Vec<&str> = items
            .iter()
            .filter(|i| i.parent_id.as_deref() == Some("p-1"))
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(ids, vec!["c-1", "c-2", made.id.as_str()]);
    }

    #[test]
    fn creating_under_a_missing_parent_is_refused() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_create(Some("nope"), "scene", "X") {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "nope"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
    }

    #[test]
    fn a_run_of_creates_stays_ordered_with_no_duplicate_positions() {
        // Exercises `after` repeatedly against the live UNIQUE item_sibling
        // index: a step onto a non-maximal key would land on an existing
        // sibling and fail the write rather than reorder silently.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made: Vec<String> = (0..20)
            .map(|n| {
                store
                    .item_create(Some("p-1"), "chapter", &format!("Ch {n}"))
                    .unwrap()
                    .id
            })
            .collect();

        let items = store.items().unwrap();
        let group: Vec<&Item> = items
            .iter()
            .filter(|i| i.parent_id.as_deref() == Some("p-1"))
            .collect();

        let mut expected = vec!["c-1".to_string(), "c-2".to_string()];
        expected.extend(made);
        assert_eq!(
            group.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            expected,
            "creates must come back in creation order"
        );

        let mut positions: Vec<&str> = group.iter().map(|i| i.position.as_str()).collect();
        let count = positions.len();
        positions.sort_unstable();
        positions.dedup();
        assert_eq!(positions.len(), count, "positions must be distinct");
    }

    #[test]
    fn creating_into_an_emptied_group_reuses_the_first_key() {
        // The group is empty, so seeded_position(0) cannot collide with a
        // sibling; the freed key is genuinely free.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .execute("DELETE FROM item WHERE parent_id = 'p-2'", [])
            .unwrap();
        let made = store.item_create(Some("p-2"), "chapter", "Ch E").unwrap();
        assert_eq!(made.position, position::seeded_position(0).unwrap());
        // Off the alphabet floor, so a later drag-to-top has somewhere to go.
        assert!(made.position.as_str() > "0000", "{}", made.position);
        let next = store.item_create(Some("p-2"), "chapter", "Ch F").unwrap();
        assert!(
            next.position > made.position,
            "{} < {}",
            made.position,
            next.position
        );
    }

    #[test]
    fn a_malformed_position_in_the_file_is_an_error_rather_than_a_process_exit() {
        // Raw SQL because no legitimate path can write this: the column is
        // TEXT NOT NULL with no CHECK, so the only way in is a damaged file or
        // another build. The claim is that it comes back as Err -- a panic here
        // poisons the store mutex, and `locked` exits the process on a poisoned
        // mutex, taking the webview's debounced edits with it.
        //
        // The bad byte sorts ABOVE the alphabet ('~' is 0x7E, past 'z'), so
        // this row is the group maximum and is the key `after` steps from. A
        // malformed key that sorts below its siblings is never read by a create
        // at all, so it would prove nothing here.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES ('c-bad', 'p-1', 'chapter', 'Bad', '00~0', 1)",
                [],
            )
            .unwrap();
        let err = store
            .item_create(Some("p-1"), "chapter", "Ch D")
            .expect_err("a malformed sibling key must refuse the create");
        assert!(
            matches!(err, StoreError::Corrupt(_)),
            "expected Corrupt, got {err:?}"
        );
        assert!(
            err.to_string().contains("00~0"),
            "the message must name the bad key: {err}"
        );
    }

    #[test]
    fn a_malformed_neighbour_refuses_a_move_rather_than_exiting() {
        // The other side of the same defect: `between` is handed both
        // neighbours straight from SQLite. This key sorts BELOW the group, so
        // it is the right-hand bound of a move to the front.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES ('c-bad', 'p-1', 'chapter', 'Bad', '00-0', 1)",
                [],
            )
            .unwrap();
        let err = store
            .item_move("c-2", Some("p-1"), None, 1)
            .expect_err("a malformed neighbour must refuse the move");
        assert!(
            matches!(err, StoreError::Corrupt(_)),
            "expected Corrupt, got {err:?}"
        );
    }

    #[test]
    fn the_last_sibling_is_found_when_the_group_holds_keys_of_different_lengths() {
        // `between` produces keys that extend a neighbour's, so a group can
        // hold "0010" and "0010V". ORDER BY position DESC must pick the longer
        // one, or `after` steps from a non-maximal key into the stride gap.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let long = position::between(Some("0010"), Some("0011")).unwrap();
        assert!(long.len() > 4, "expected an extended key, got {long}");
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES ('c-long', 'p-1', 'chapter', 'Long', ?1, 1)",
                [&long],
            )
            .unwrap();
        let made = store.item_create(Some("p-1"), "chapter", "Ch D").unwrap();
        // Pins WHICH key was stepped from. Asserting only order is vacuous: a
        // step from the shorter "0010" also sorts above every existing sibling,
        // so the test passed with the query picking the non-maximal key.
        assert_eq!(made.position, position::after(&long).unwrap());
        let ids: Vec<String> = store
            .items()
            .unwrap()
            .into_iter()
            .filter(|i| i.parent_id.as_deref() == Some("p-1"))
            .map(|i| i.id)
            .collect();
        assert_eq!(
            ids,
            vec!["c-1".into(), "c-2".into(), "c-long".into(), made.id]
        );
    }

    #[test]
    fn a_created_root_item_appends_after_the_last_root() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store.item_create(None, "part", "Part Three").unwrap();
        let ids: Vec<String> = store
            .items()
            .unwrap()
            .into_iter()
            .filter(|i| i.parent_id.is_none())
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, vec!["p-1".into(), "p-2".into(), made.id]);
    }

    #[test]
    fn renaming_bumps_the_revision() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let rev = store.item_rename("c-1", "Chapter One", 1).unwrap();
        assert_eq!(rev, 2);
        let items = store.items().unwrap();
        let title = &items.iter().find(|i| i.id == "c-1").unwrap().title;
        assert_eq!(title, "Chapter One");
    }

    #[test]
    fn renaming_with_a_stale_revision_is_a_conflict_not_an_overwrite() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store.item_rename("c-1", "First", 1).unwrap();
        match store.item_rename("c-1", "Second", 1) {
            Err(StoreError::Conflict { item_id }) => assert_eq!(item_id, "c-1"),
            other => panic!("expected Conflict, got {other:?}"),
        }
        let items = store.items().unwrap();
        assert_eq!(items.iter().find(|i| i.id == "c-1").unwrap().title, "First");
    }

    #[test]
    fn renaming_an_item_that_does_not_exist_is_not_a_conflict() {
        // The distinction is the whole reason for the second query: a missing
        // item is not a lost race, and telling the page to reload a revision it
        // can never obtain would loop it.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_rename("ghost", "X", 1) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "ghost"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
    }

    #[test]
    fn moving_reparents_and_repositions() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        // c-1 becomes the second child of p-2, after c-3.
        store.item_move("c-1", Some("p-2"), Some("c-3"), 1).unwrap();
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-2", "p-2", "c-3", "c-1", "s-1"]);
    }

    #[test]
    fn moving_to_the_front_uses_a_null_left_neighbour() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store.item_move("c-2", Some("p-1"), None, 1).unwrap();
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-2", "c-1", "s-1", "p-2", "c-3"]);
    }

    #[test]
    fn moving_an_item_under_its_own_descendant_is_refused() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        // p-1 -> c-1 -> s-1. Moving p-1 under s-1 would detach the whole
        // subtree from every root and lose it from the walk.
        match store.item_move("p-1", Some("s-1"), None, 1) {
            Err(StoreError::Corrupt(msg)) => assert!(msg.contains("descendant"), "{msg}"),
            other => panic!("expected Corrupt, got {other:?}"),
        }
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn moving_an_item_under_itself_is_refused() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_move("c-1", Some("c-1"), None, 1) {
            Err(StoreError::Corrupt(msg)) => {
                assert!(msg.contains("descendant"), "{msg}");
                assert!(msg.contains("c-1"), "{msg}");
            }
            other => panic!("expected Corrupt, got {other:?}"),
        }
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn a_self_move_of_a_missing_item_names_the_missing_item() {
        // The dead `target == id` guard used to answer this one Corrupt, ahead
        // of the existence check that every other path reports.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_move("ghost", Some("ghost"), None, 1) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "ghost"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
    }

    #[test]
    fn moving_with_a_stale_revision_is_a_conflict() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store.item_rename("c-1", "Renamed", 1).unwrap();
        match store.item_move("c-1", Some("p-2"), None, 1) {
            Err(StoreError::Conflict { item_id }) => assert_eq!(item_id, "c-1"),
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    fn the_descendant_check_reaches_the_deepest_legal_row() {
        // A chain exactly MAX_DEPTH long walks cleanly, so its deepest row is a
        // legitimate item. The subtree probe's own depth bound must still see it
        // as a descendant, or the deepest tree the store accepts is also the one
        // where a cycle can be written.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("deep.db")).unwrap();
        store.conn.execute_batch("BEGIN").unwrap();
        for n in 0..MAX_DEPTH {
            let parent = if n == 0 {
                "NULL".to_string()
            } else {
                format!("'i{}'", n - 1)
            };
            store
                .conn
                .execute_batch(&format!(
                    "INSERT INTO item (id, parent_id, type, title, position, rev)
                     VALUES ('i{n}', {parent}, 'scene', 'D{n}', '0000', 1)"
                ))
                .unwrap();
        }
        store.conn.execute_batch("COMMIT").unwrap();
        assert_eq!(store.items().unwrap().len() as i64, MAX_DEPTH);

        let deepest = format!("i{}", MAX_DEPTH - 1);
        match store.item_move("i0", Some(&deepest), None, 1) {
            Err(StoreError::Corrupt(msg)) => assert!(msg.contains("descendant"), "{msg}"),
            other => panic!("expected Corrupt, got {other:?}"),
        }
    }

    #[test]
    fn moving_after_a_neighbour_in_another_group_names_the_neighbour() {
        // A stale after_id is the ordinary case of a page acting on a tree that
        // has since changed. It must not surface as a raw sqlite error.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_move("c-1", Some("p-2"), Some("c-2"), 1) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "c-2"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn moving_under_a_parent_that_does_not_exist_names_the_parent() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_move("c-1", Some("ghost"), None, 1) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "ghost"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
    }

    #[test]
    fn moving_an_item_that_does_not_exist_is_not_a_conflict() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        match store.item_move("ghost", Some("p-2"), None, 1) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "ghost"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
    }

    #[test]
    fn moving_an_item_to_where_it_already_sits_still_bumps_the_revision() {
        // A caller must not be able to read "nothing happened" out of an
        // unchanged rev, so the write runs even when the order does not move.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let moved = store.item_move("c-1", Some("p-1"), None, 1).unwrap();
        assert_eq!(moved.rev, 2);
        assert_eq!(moved.parent_id.as_deref(), Some("p-1"));
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn moving_an_item_after_itself_is_not_a_collision() {
        // after_id == id makes the moved row its own left neighbour, so the
        // computed key can equal the one it already holds -- the same row, not
        // a UNIQUE violation.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let moved = store.item_move("c-1", Some("p-1"), Some("c-1"), 1).unwrap();
        assert_eq!(moved.rev, 2);
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn moving_one_step_down_within_a_group_reorders_the_pair() {
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store.item_move("c-1", Some("p-1"), Some("c-2"), 1).unwrap();
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-2", "c-1", "s-1", "p-2", "c-3"]);
    }

    #[test]
    fn the_moved_row_is_not_its_own_right_neighbour() {
        // The exclusion in the right-neighbour query only bites when the moved
        // row IS the minimum position strictly above `left`, which it never is
        // in the plain fixture -- so the reorder tests above pass with or
        // without it. Placing c-2 immediately above c-1 creates that case: kept
        // in, c-2 is skipped and the move appends cleanly; taken out, the query
        // returns c-2's own key as the right bound, and a legal no-op reorder
        // fails as an exhausted group.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .execute("UPDATE item SET position = '00000' WHERE id = 'c-2'", [])
            .unwrap();
        assert!(store.item_move("c-2", Some("p-1"), Some("c-1"), 1).is_ok());
        let ids: Vec<String> = store.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
    }

    #[test]
    fn a_cross_group_move_leaves_every_row_reachable() {
        // items() reports Corrupt on any row the walk cannot reach, so walking
        // the whole tree afterwards is the assertion: the vacated group must not
        // be left holding a dangling parent_id or a lost child.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .item_move("c-1", Some("p-2"), Some("c-3"), 2)
            .unwrap_err();
        store.item_move("c-1", Some("p-2"), Some("c-3"), 1).unwrap();
        let items = store.items().unwrap();
        assert_eq!(items.len(), 6, "the walk must still reach every row");
        let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["c-1", "c-2", "c-3", "p-1", "p-2", "s-1"]);
        // s-1 travelled with its parent rather than being orphaned at p-1.
        let depth = |id: &str| items.iter().find(|i| i.id == id).unwrap().depth;
        assert_eq!(depth("c-1"), 1);
        assert_eq!(depth("s-1"), 2);
        let c1_parent = &items.iter().find(|i| i.id == "c-1").unwrap().parent_id;
        assert_eq!(c1_parent.as_deref(), Some("p-2"));
    }

    #[test]
    fn a_created_item_lands_after_the_named_sibling() {
        // The whole of step 1. Without `after_id` the page's only way to put a
        // new scene beside the current one is create-then-move: two commands,
        // not atomic, and a failed move leaves a real item at the end of the
        // wrong group.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store
            .item_create_after(Some("p-1"), "chapter", "Ch A-and-a-half", Some("c-1"))
            .unwrap();
        let ids: Vec<String> = store
            .items()
            .unwrap()
            .into_iter()
            .filter(|i| i.parent_id.as_deref() == Some("p-1"))
            .map(|i| i.id)
            .collect();
        assert_eq!(
            ids,
            vec!["c-1".to_string(), made.id.clone(), "c-2".to_string()]
        );
    }

    #[test]
    fn a_created_item_after_the_last_sibling_goes_last() {
        // The branch where there is no right neighbour, which takes `after`
        // rather than `between`. A test that only ever lands in the middle
        // leaves it uncovered.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store
            .item_create_after(Some("p-1"), "chapter", "Ch C", Some("c-2"))
            .unwrap();
        let ids: Vec<String> = store
            .items()
            .unwrap()
            .into_iter()
            .filter(|i| i.parent_id.as_deref() == Some("p-1"))
            .map(|i| i.id)
            .collect();
        assert_eq!(
            ids,
            vec!["c-1".to_string(), "c-2".to_string(), made.id.clone()]
        );
    }

    #[test]
    fn creating_without_a_neighbour_still_appends() {
        // Every existing caller passes None and must be unaffected. `item_create`
        // is now a wrapper, and a wrapper that changed behaviour would move
        // every seeded fixture in this repo.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let made = store.item_create(Some("p-1"), "chapter", "Ch C").unwrap();
        let ids: Vec<String> = store
            .items()
            .unwrap()
            .into_iter()
            .filter(|i| i.parent_id.as_deref() == Some("p-1"))
            .map(|i| i.id)
            .collect();
        assert_eq!(
            ids,
            vec!["c-1".to_string(), "c-2".to_string(), made.id.clone()]
        );
    }

    #[test]
    fn a_neighbour_in_another_group_is_refused_and_nothing_is_created() {
        // `c-3` is a real item, in `p-2`. A page acting on a tree that has since
        // changed names a neighbour that is no longer in the group it is
        // creating into, and must be TOLD which one -- `item_move` reports the
        // same case the same way. The row count is asserted because an error
        // returned after the INSERT has refused nothing.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        let before = store.items().unwrap().len();
        match store.item_create_after(Some("p-1"), "chapter", "Nope", Some("c-3")) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "c-3"),
            other => panic!("expected UnknownItem(c-3), got {other:?}"),
        }
        assert_eq!(
            store.items().unwrap().len(),
            before,
            "nothing may have been created"
        );
    }

    #[test]
    fn creating_after_a_neighbour_with_no_room_is_refused_loudly() {
        // `between` cannot invent a key where two siblings are immediate
        // successors, and the same arm exists in `item_move`. A create that
        // hung, or that silently appended instead, would both be worse than the
        // refusal.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .execute("UPDATE item SET position = '0' WHERE id = 'c-1'", [])
            .unwrap();
        store
            .conn
            .execute("UPDATE item SET position = '00' WHERE id = 'c-2'", [])
            .unwrap();
        let before = store.items().unwrap().len();
        match store.item_create_after(Some("p-1"), "chapter", "Nope", Some("c-1")) {
            Err(e @ StoreError::NoRoom { .. }) => {
                let msg = e.to_string();
                assert!(msg.contains("no room left"), "{msg}");
            }
            other => panic!("expected NoRoom, got {other:?}"),
        }
        assert_eq!(
            store.items().unwrap().len(),
            before,
            "nothing may have been created"
        );
    }

    #[test]
    fn front_inserts_run_out_of_room_loudly_rather_than_hanging() {
        // Nothing sorts below "0" at all, and `between` cannot invent room that
        // does not exist, so the store must report it instead of looping.
        // Seeding one stride off the floor keeps a real project far from here.
        let dir = tempdir().unwrap();
        let store = nested_store(dir.path());
        store
            .conn
            .execute("UPDATE item SET position = '0' WHERE id = 'c-1'", [])
            .unwrap();
        match store.item_move("c-2", Some("p-1"), None, 1) {
            Err(e @ StoreError::NoRoom { .. }) => {
                // The page shows this verbatim, so it must not name a routine
                // nobody wrote.
                let msg = e.to_string();
                assert!(msg.contains("no room left"), "{msg}");
                assert!(msg.contains("nothing was moved"), "{msg}");
                assert!(!msg.contains("renumber"), "{msg}");
            }
            other => panic!("expected NoRoom, got {other:?}"),
        }
    }

    #[test]
    fn loading_a_document_that_does_not_exist_is_not_reported_as_a_database_error() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        match store.load_doc("i2") {
            Err(StoreError::NotFound { item_id }) => assert_eq!(item_id, "i2"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn flush_writes_the_body_and_bumps_rev() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project.db");
        {
            let store = Store::open(&path).unwrap();
            seed_two(&store);
            let acks = store
                .flush(&[FlushEntry {
                    item_id: "i1".into(),
                    body: "{\"type\":\"doc\",\"v\":2}".into(),
                    base_rev: 1,
                    comments: None,
                }])
                .unwrap();
            assert_eq!(acks[0].rev, 2);
        }
        // Reopened: proves it reached the file, not just the cache.
        let store = Store::open(&path).unwrap();
        let doc = store.load_doc("i1").unwrap();
        assert_eq!(doc.body, "{\"type\":\"doc\",\"v\":2}");
        assert_eq!(doc.rev, 2);
    }

    #[test]
    fn a_stale_base_rev_writes_nothing_in_the_batch() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        store
            .conn
            .execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES ('i2', 'orig2', 1, 0)",
                [],
            )
            .unwrap();

        let err = store.flush(&[
            FlushEntry {
                item_id: "i2".into(),
                body: "new2".into(),
                base_rev: 1,
                comments: None,
            },
            FlushEntry {
                item_id: "i1".into(),
                body: "new1".into(),
                base_rev: 99,
                comments: None,
            },
        ]);

        match err {
            Err(StoreError::Conflict { item_id }) => assert_eq!(item_id, "i1"),
            other => panic!("expected Conflict, got {other:?}"),
        }
        // The GOOD entry must have rolled back too. A partial write here is
        // silent data divergence: the page would think neither landed.
        assert_eq!(store.load_doc("i2").unwrap().body, "orig2");
        assert_eq!(store.load_doc("i2").unwrap().rev, 1);

        // A second flush after a conflict must still work: if the rollback
        // were missed, sqlite would refuse to start a nested transaction.
        let acks = store
            .flush(&[FlushEntry {
                item_id: "i2".into(),
                body: "after-conflict".into(),
                base_rev: 1,
                comments: None,
            }])
            .unwrap();
        assert_eq!(acks[0].rev, 2);
        assert_eq!(store.load_doc("i2").unwrap().body, "after-conflict");
    }

    #[test]
    fn flushing_an_unknown_document_inserts_it() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        let acks = store
            .flush(&[FlushEntry {
                item_id: "i2".into(),
                body: "fresh".into(),
                base_rev: 0,
                comments: None,
            }])
            .unwrap();
        assert_eq!(acks[0].rev, 1);
        assert_eq!(store.load_doc("i2").unwrap().body, "fresh");
    }

    #[test]
    fn acked_rev_matches_stored_rev_across_repeated_flushes() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        let mut base_rev = 1; // i1 already has a doc row at rev 1.
        for n in 2..=4 {
            let acks = store
                .flush(&[FlushEntry {
                    item_id: "i1".into(),
                    body: format!("body-{n}"),
                    base_rev,
                    comments: None,
                }])
                .unwrap();
            let acked_rev = acks[0].rev;
            let stored = store.load_doc("i1").unwrap();
            assert_eq!(
                acked_rev, stored.rev,
                "acked rev must match what is actually stored"
            );
            assert_eq!(acked_rev, n);
            base_rev = acked_rev;
        }
        assert_eq!(store.load_doc("i1").unwrap().rev, 4);
    }

    #[test]
    fn empty_batch_is_a_clean_no_op() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        let acks = store.flush(&[]).unwrap();
        assert!(acks.is_empty());
        // Connection must still be usable afterward.
        let acks = store
            .flush(&[FlushEntry {
                item_id: "i1".into(),
                body: "x".into(),
                base_rev: 1,
                comments: None,
            }])
            .unwrap();
        assert_eq!(acks[0].rev, 2);
    }

    #[test]
    fn duplicate_item_id_in_one_batch_conflicts_on_the_second_entry() {
        // The page's dirty map is keyed by item_id, so it cannot currently
        // produce a batch with a duplicate item_id. This documents the actual
        // behavior if it ever did: the first entry bumps rev 1 -> 2, so the
        // second entry's base_rev (still 1) is now stale and conflicts.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        let err = store.flush(&[
            FlushEntry {
                item_id: "i1".into(),
                body: "first".into(),
                base_rev: 1,
                comments: None,
            },
            FlushEntry {
                item_id: "i1".into(),
                body: "second".into(),
                base_rev: 1,
                comments: None,
            },
        ]);
        match err {
            Err(StoreError::Conflict { item_id }) => assert_eq!(item_id, "i1"),
            other => panic!("expected Conflict on the duplicate entry, got {other:?}"),
        }
        // Whole batch rolled back, including the first entry's write.
        assert_eq!(store.load_doc("i1").unwrap().rev, 1);
    }

    #[test]
    fn flushing_a_document_for_an_unknown_item_names_the_item() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_two(&store);
        match store.flush(&[FlushEntry {
            item_id: "ghost".into(),
            body: "x".into(),
            base_rev: 0,
            comments: None,
        }]) {
            Err(StoreError::UnknownItem { item_id }) => assert_eq!(item_id, "ghost"),
            other => panic!("expected UnknownItem, got {other:?}"),
        }
        // The connection must still be usable: the rollback ran.
        store
            .flush(&[FlushEntry {
                item_id: "i2".into(),
                body: "ok".into(),
                base_rev: 0,
                comments: None,
            }])
            .unwrap();
    }

    /// A scene whose stored body is exactly `body`. Written through SQL rather
    /// than item_create + flush so the test says what the body IS -- the walk is
    /// what is under test, and a body assembled by the page's serializer would
    /// be testing the serializer.
    fn seed_scene_with_body(store: &Store, id: &str, position: &str, body: &str) {
        store
            .conn
            .execute(
                "INSERT INTO item (id, parent_id, type, title, position, rev)
                 VALUES (?1, NULL, 'scene', ?1, ?2, 1)",
                rusqlite::params![id, position],
            )
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, 0)",
                rusqlite::params![id, body],
            )
            .unwrap();
    }

    #[test]
    fn an_empty_project_counts_no_words() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        assert_eq!(
            store.word_count().unwrap(),
            WordCount {
                words: 0,
                skipped: 0
            }
        );
    }

    #[test]
    fn the_project_total_is_the_sum_of_its_documents() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_scene_with_body(
            &store,
            "i1",
            "0000",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"She set the lamp down."}]}]}"#,
        );
        seed_scene_with_body(
            &store,
            "i2",
            "0010",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"He did not answer"}]}]}"#,
        );
        assert_eq!(
            store.word_count().unwrap(),
            WordCount {
                words: 9,
                skipped: 0
            }
        );
    }

    #[test]
    fn marks_do_not_change_the_count() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        // The same six words as an unmarked body, with one of them italicised
        // into its own text node.
        seed_scene_with_body(
            &store,
            "i1",
            "0000",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"she was "},
                 {"type":"text","marks":[{"type":"em"}],"text":"quite"},
                 {"type":"text","text":" done with it"}]}]}"#,
        );
        assert_eq!(store.word_count().unwrap().words, 6);
    }

    #[test]
    fn a_word_split_by_a_mark_boundary_is_still_one_word() {
        // Italicising the middle of a word splits one text node into three.
        // Joining fragments with a space -- the obvious implementation -- counts
        // this as three words, and the page, which uses ProseMirror's own
        // textBetween, counts one. That disagreement is what the graded gate
        // comparing the two totals exists to catch.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_scene_with_body(
            &store,
            "i1",
            "0000",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"be"},
                 {"type":"text","marks":[{"type":"em"}],"text":"witch"},
                 {"type":"text","text":"ed"}]}]}"#,
        );
        assert_eq!(store.word_count().unwrap().words, 1);
    }

    #[test]
    fn two_paragraphs_are_two_words_not_one() {
        // The other half of the joining rule: nothing between text nodes, but a
        // separator between blocks. Without it "one" and "two" run together.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_scene_with_body(
            &store,
            "i1",
            "0000",
            r#"{"type":"doc","content":[
                 {"type":"paragraph","content":[{"type":"text","text":"one"}]},
                 {"type":"paragraph","content":[{"type":"text","text":"two"}]}]}"#,
        );
        assert_eq!(store.word_count().unwrap().words, 2);
    }

    #[test]
    fn a_corrupt_body_is_skipped_and_reported_rather_than_aborting_the_count() {
        // One unreadable row must not take the whole manuscript's total away
        // from the writer; it must also not vanish from the answer.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_scene_with_body(&store, "i0", "0000", "not json at all");
        seed_scene_with_body(&store, "i1", "0010", "[\"json, but not a document\"]");
        seed_scene_with_body(
            &store,
            "i2",
            "0020",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"three good words"}]}]}"#,
        );
        assert_eq!(
            store.word_count().unwrap(),
            WordCount {
                words: 3,
                skipped: 2
            }
        );
    }

    #[test]
    fn a_json_object_that_is_not_a_document_is_skipped() {
        // `is_object()` alone admitted this: it counted as a readable zero-word
        // document, so the total was right by luck and `skipped` -- the figure
        // that says the total is an undercount -- was wrong. The page throws on
        // the same body in schema.nodeFromJSON, so it is not a document by
        // anyone's reckoning.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_scene_with_body(&store, "i0", "0000", r#"{"foo":1}"#);
        seed_scene_with_body(
            &store,
            "i1",
            "0010",
            r#"{"type":"paragraph","content":[{"type":"text","text":"not a root"}]}"#,
        );
        assert_eq!(
            store.word_count().unwrap(),
            WordCount {
                words: 0,
                skipped: 2
            }
        );
    }

    #[test]
    fn a_real_document_is_still_counted_beside_one_that_is_not() {
        // The control for the case above: a rule that rejected everything would
        // satisfy it on its own.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_scene_with_body(&store, "i0", "0000", r#"{"foo":1}"#);
        seed_scene_with_body(
            &store,
            "i1",
            "0010",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"three good words"}]}]}"#,
        );
        assert_eq!(
            store.word_count().unwrap(),
            WordCount {
                words: 3,
                skipped: 1
            }
        );
    }

    #[test]
    fn an_item_with_no_document_contributes_nothing() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        store
            .item_create(None, "chapter", "A chapter has no body")
            .unwrap();
        assert_eq!(
            store.word_count().unwrap(),
            WordCount {
                words: 0,
                skipped: 0
            }
        );
    }

    /// A project holding a countable document, an unreadable one and an item
    /// with no document at all -- the three cases the index has to agree with
    /// the scan about.
    fn seed_for_the_index(store: &Store) {
        seed_scene_with_body(
            store,
            "i0",
            "0000",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"three good words"}]}]}"#,
        );
        seed_scene_with_body(store, "i1", "0010", r#"{"foo":1}"#);
        store.item_create(None, "chapter", "No body here").unwrap();
    }

    #[test]
    fn a_freshly_built_index_agrees_with_a_full_scan() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_for_the_index(&store);
        assert_eq!(
            store.word_index().unwrap().count(),
            store.word_count().unwrap()
        );
        assert_eq!(
            store.word_index().unwrap().count(),
            WordCount {
                words: 3,
                skipped: 1
            }
        );
    }

    #[test]
    fn the_index_sentences_and_paragraphs_agree_with_a_full_scan() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_for_the_index(&store);
        seed_scene_with_body(
            &store,
            "i2",
            "0020",
            r#"{"type":"doc","content":[
                 {"type":"paragraph","content":[{"type":"text","text":"One. Two."}]},
                 {"type":"paragraph"},
                 {"type":"paragraph","content":[{"type":"text","text":"Three"}]}]}"#,
        );
        let index = store.word_index().unwrap();
        let none = std::collections::HashSet::new();
        assert_eq!(index.units_excluding(&none), store.unit_count().unwrap());
        assert_eq!(
            index.units_excluding(&none),
            Units {
                sentences: 4,
                paragraphs: 3
            }
        );
        // Recording again replaces rather than adds, for units as for words.
        let mut index = index;
        index.record(
            "i2",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Just one"}]}]}"#,
        );
        assert_eq!(
            index.units_excluding(&none),
            Units {
                sentences: 2,
                paragraphs: 2
            }
        );
        assert_eq!(
            index.units_of("i2", &none),
            Some(Units {
                sentences: 1,
                paragraphs: 1
            })
        );
        let excluded: std::collections::HashSet<String> = ["i2".to_string()].into_iter().collect();
        assert_eq!(index.units_of("i2", &excluded), None, "trashed is withheld");
        assert_eq!(index.units_of("i1", &none), None, "unreadable is withheld");
        assert_eq!(
            index.units_excluding(&excluded),
            Units {
                sentences: 1,
                paragraphs: 1
            }
        );
    }

    #[test]
    fn the_index_holds_one_entry_per_document_and_no_more() {
        // The chapter has no doc row, so it must not take an entry: the index's
        // size is compared against the store's document count by the host's
        // guard tests, and an item without a body would put the two apart.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("project.db")).unwrap();
        seed_for_the_index(&store);
        assert_eq!(store.word_index().unwrap().len(), 2);
    }

    #[test]
    fn recording_the_same_document_twice_replaces_rather_than_adds() {
        // The property the whole cache rests on. A `total +=` implementation
        // passes every other test here and fails this one.
        let mut index = WordIndex::default();
        let four = r#"{"type":"doc","content":[{"type":"paragraph","content":[
             {"type":"text","text":"four words go here"}]}]}"#;
        index.record("i0", four);
        index.record("i0", four);
        assert_eq!(
            index.count(),
            WordCount {
                words: 4,
                skipped: 0
            }
        );
    }

    #[test]
    fn a_body_that_becomes_unreadable_moves_from_the_total_to_skipped() {
        let mut index = WordIndex::default();
        index.record(
            "i0",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"four words go here"}]}]}"#,
        );
        index.record("i0", "{not json");
        assert_eq!(
            index.count(),
            WordCount {
                words: 0,
                skipped: 1
            }
        );
        // And back: an unreadable body is not a permanent condemnation of the
        // document, only of the bytes that were there.
        index.record(
            "i0",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"two words"}]}]}"#,
        );
        assert_eq!(
            index.count(),
            WordCount {
                words: 2,
                skipped: 0
            }
        );
    }

    #[test]
    fn an_empty_new_scenes_body_is_a_present_zero() {
        // EMPTY_DOC_BODY is what item_create writes and what the host records
        // for a created scene without re-reading it. If those two ever diverge,
        // a new scene's first flush subtracts a count the store never had.
        let mut index = WordIndex::default();
        index.record("i0", EMPTY_DOC_BODY);
        assert_eq!(
            index.count(),
            WordCount {
                words: 0,
                skipped: 0
            }
        );
        assert_eq!(index.len(), 1);
    }

    fn excluding(ids: &[&str]) -> std::collections::HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// Three words, a body that will not parse, an empty scene, and a scene in
    /// the bin. Every case the per-item view has to tell apart, in one index.
    fn index_of_four() -> WordIndex {
        let mut index = WordIndex::default();
        index.record(
            "counted",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"three good words"}]}]}"#,
        );
        index.record("unreadable", "{not json");
        index.record("empty", EMPTY_DOC_BODY);
        index.record(
            "binned",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                 {"type":"text","text":"two words"}]}]}"#,
        );
        index
    }

    #[test]
    fn the_per_item_counts_carry_each_live_document() {
        let counts = index_of_four().counts_excluding(&excluding(&["binned"]));
        assert_eq!(counts.get("counted"), Some(&3));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn an_empty_scene_is_present_at_zero() {
        // The reason an unreadable body cannot BE zero: zero is taken. A scene
        // created and never typed into holds EMPTY_DOC_BODY and is genuinely
        // empty, and the page must be able to say so.
        let counts = index_of_four().counts_excluding(&excluding(&["binned"]));
        assert_eq!(counts.get("empty"), Some(&0));
    }

    #[test]
    fn statistics_projection_keeps_zero_and_withholds_unknown_or_excluded_documents() {
        let mut index = index_of_four();
        index.record(
            "counted",
            r#"{"type":"doc","content":[
                 {"type":"paragraph","content":[{"type":"text","text":"One. Two."}]},
                 {"type":"paragraph","content":[{"type":"text","text":"Three"}]}]}"#,
        );
        let counts = index.document_counts_excluding(&excluding(&["binned"]));
        assert_eq!(
            counts.get("counted"),
            Some(&DocumentCounts {
                words: 3,
                sentences: 3,
                paragraphs: 2,
            })
        );
        assert_eq!(
            counts.get("empty"),
            Some(&DocumentCounts {
                words: 0,
                sentences: 0,
                paragraphs: 0,
            })
        );
        assert!(!counts.contains_key("unreadable"));
        assert!(!counts.contains_key("binned"));
    }

    #[test]
    fn an_unreadable_body_is_absent_rather_than_zero() {
        // Absent is the truth ("could not be counted"); zero would be a claim
        // ("this scene is empty"), and the test above shows that claim is one
        // the map already makes about a different document.
        let counts = index_of_four().counts_excluding(&excluding(&["binned"]));
        assert!(!counts.contains_key("unreadable"));
    }

    #[test]
    fn a_trashed_document_is_absent_from_the_per_item_counts() {
        let counts = index_of_four().counts_excluding(&excluding(&["binned"]));
        assert!(!counts.contains_key("binned"));
        // And it is WITHHELD, not forgotten: the entry is still there and still
        // correct, which is what makes restoring it a read rather than a
        // recount.
        let restored = index_of_four().counts_excluding(&excluding(&[]));
        assert_eq!(restored.get("binned"), Some(&2));
    }

    #[test]
    fn the_per_item_counts_sum_to_the_project_total() {
        // The identity the two commands rest on: a page summing a chapter's
        // scenes and a page reading the bar must not be able to disagree.
        let index = index_of_four();
        for excluded in [
            excluding(&[]),
            excluding(&["binned"]),
            excluding(&["counted", "binned"]),
        ] {
            let summed: u64 = index.counts_excluding(&excluded).values().sum();
            assert_eq!(summed, index.count_excluding(&excluded).words);
        }
    }

    #[test]
    fn an_empty_index_yields_an_empty_map() {
        let index = WordIndex::default();
        assert!(index.counts_excluding(&excluding(&[])).is_empty());
        // And an exclusion naming something the index never held is not an
        // error: the bin holds parts and chapters, which have no doc row.
        assert!(index
            .counts_excluding(&excluding(&["no-such-item"]))
            .is_empty());
    }

    #[test]
    fn excluding_a_non_document_leaves_every_count_alone() {
        // The bin itself and any container inside it are excluded ids with no
        // entry here. They must not remove anything.
        let counts = index_of_four().counts_excluding(&excluding(&["a-chapter", "the-bin"]));
        assert_eq!(counts.len(), 3);
        assert_eq!(counts.get("binned"), Some(&2));
    }

    #[test]
    fn documents_returns_every_body_keyed_by_item() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let a = store.item_create(None, "scene", "A").unwrap();
        let b = store.item_create(None, "scene", "B").unwrap();

        let docs = store.documents().unwrap();

        assert_eq!(docs.len(), 2);
        assert_eq!(docs.get(&a.id).map(String::as_str), Some(EMPTY_DOC_BODY));
        assert_eq!(docs.get(&b.id).map(String::as_str), Some(EMPTY_DOC_BODY));
    }

    #[test]
    fn documents_returns_the_flushed_body_not_the_seeded_one() {
        // Keyed-and-populated is the whole claim; a map built from item ids with
        // a constant value would satisfy the test above.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let a = store.item_create(None, "scene", "A").unwrap();
        let b = store.item_create(None, "scene", "B").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: a.id.clone(),
                body: "AAA".to_string(),
                base_rev: a.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();

        let docs = store.documents().unwrap();

        assert_eq!(docs.get(&a.id).map(String::as_str), Some("AAA"));
        assert_eq!(docs.get(&b.id).map(String::as_str), Some(EMPTY_DOC_BODY));
    }

    #[test]
    fn documents_is_empty_when_nothing_has_a_body() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        store.item_create(None, "chapter", "C").unwrap();
        assert!(store.documents().unwrap().is_empty());
    }

    #[test]
    fn documents_reads_through_a_readonly_handle() {
        // Export opens READONLY -- `open` creates schema v1 on a blank file, so
        // it must never be used to merely read. A batch reader that only worked
        // on a writable handle would push the export back onto `open`.
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let id = {
            let store = Store::open(&path).unwrap();
            let a = store.item_create(None, "scene", "A").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: a.id.clone(),
                    body: "AAA".to_string(),
                    base_rev: a.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            a.id
        };

        let store = Store::open_readonly(&path).unwrap();
        let docs = store.documents().unwrap();

        assert_eq!(docs.get(&id).map(String::as_str), Some("AAA"));
    }

    /// The design's mechanism, against THIS crate's bundled SQLite rather than
    /// the system one its prototype was measured on. Both halves matter: a
    /// read-only source (the reader must never migrate or adopt the file) and a
    /// BOUND destination (a slug reaches this path and a quote in one would
    /// otherwise close the literal).
    #[test]
    fn vacuum_into_runs_on_a_read_only_connection_with_a_bound_destination() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("p.db");
        let dest = dir.path().join("it's a copy.db");
        {
            let store = Store::open(&src).unwrap();
            store.item_create(None, "scene", "Only scene").unwrap();
        }
        let before = std::fs::read(&src).unwrap();
        let reader = Store::open_readonly(&src).unwrap();
        reader.vacuum_into(&dest).unwrap();

        let copy = Store::open_readonly(&dest).unwrap();
        assert_eq!(copy.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(copy.items().unwrap().len(), 1);
        // THE SOURCE DATABASE IS BYTE-FOR-BYTE UNCHANGED, which is the claim
        // that matters: the reader neither migrated it nor adopted it.
        //
        // Asserted over the FILE'S BYTES and not over the absence of a `-wal`,
        // because `open_readonly` DOES create `p.db-wal` and `p.db-shm` beside
        // a WAL-mode database -- a read-only connection still needs the shared
        // memory index, and SQLite creates both when the directory is writable.
        // "Read-only" means no write LANDS in the database, not that the
        // directory is untouched; same shape as the recorded fact that
        // `open_readonly` accepts a zero-byte file.
        assert_eq!(
            std::fs::read(&src).unwrap(),
            before,
            "the reader wrote to the source database"
        );
    }

    /// SQLite's own refusal, which is the never-clobber guard this slice relies
    /// on instead of an `exists()` probe a race can invalidate -- the same
    /// argument `pick_export_path` records for `create_new(true)`.
    ///
    /// MEASURED, not assumed. SQLite refuses a destination that HAS CONTENT and
    /// adopts one that does not; both halves are asserted, here and below, so a
    /// later reader credits the guard for exactly what it does.
    #[test]
    fn vacuum_into_refuses_a_destination_that_already_holds_something() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("p.db");
        {
            Store::open(&src).unwrap();
        }
        let reader = Store::open_readonly(&src).unwrap();

        // A real project file at the destination: the case that would cost a
        // writer a recovery point, and the one SQLite names.
        let occupied = dir.path().join("occupied.db");
        reader.vacuum_into(&occupied).unwrap();
        let err = reader.vacuum_into(&occupied).unwrap_err();
        assert!(
            err.to_string().contains("already exists"),
            "expected SQLite's own refusal, got: {err}"
        );

        // A file that is not a database is refused too, by a different message.
        let junk = dir.path().join("junk.db");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(reader.vacuum_into(&junk).is_err());
    }

    /// THE HOLE IN THAT GUARD, ASSERTED RATHER THAN ASSUMED: a ZERO-BYTE file
    /// is not "an existing output file" to SQLite -- it reads one as an empty
    /// database and writes straight into it. Exactly the asymmetry
    /// `Store::open_readonly` already has, where an empty file opens fine and
    /// the refusal comes from the first query instead.
    ///
    /// Harmless here, and recorded so it stays harmless: a zero-byte leftover
    /// holds nothing to clobber. What must never be assumed is that this
    /// refusal covers every existing path -- anything relying on it for a file
    /// with CONTENT is relying on the test above, not on this one.
    #[test]
    fn vacuum_into_adopts_a_zero_byte_destination_rather_than_refusing_it() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("p.db");
        {
            Store::open(&src).unwrap();
        }
        let dest = dir.path().join("empty.db");
        std::fs::write(&dest, b"").unwrap();
        Store::open_readonly(&src)
            .unwrap()
            .vacuum_into(&dest)
            .unwrap();
        assert!(std::fs::metadata(&dest).unwrap().len() > 0);
    }
}
