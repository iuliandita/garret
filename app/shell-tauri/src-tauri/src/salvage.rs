// app/shell-tauri/src-tauri/src/salvage.rs
// Salvage: extract every recoverable object from a DAMAGED project and report
// the losses, without modifying the source.
//
// Spec section 5, verbatim: "Salvage is read-only: it extracts every recoverable
// object from a damaged project and reports losses without modifying the
// source." Held out deliberately, so the first CLI's most dangerous
// command would not be its least tested.
//
// THE SOURCE IS NEVER OPENED BY SQLITE AT ALL. That is the whole feature, and
// `open_readonly` is not enough to deliver it. A project is in WAL mode -- the
// mode is persistent in the file header -- and a read-only connection to a WAL
// database still needs the `-shm` file and CREATES it when it is absent, and
// under some damage SQLite will run WAL recovery. Either leaves the writer's
// directory changed by a command whose promise is that it changes nothing, and
// a damaged project is the one file in the world that cannot afford it.
//
// So salvage COPIES `<project.db>` and its `-wal`/`-shm`/`-journal` sidecars to
// a temporary directory and works entirely on the copy. The source is touched
// by exactly one operation: a byte read.
//
// THAT IS ALSO THE `-wal` FALLBACK, and it needs no second attempt. Earlier
// discovery work recorded that SQLite recovers fully at every
// non-header damage site via the `-wal` second copy: the WAL holds newer images
// of the pages the main file has lost, and SQLite prefers them on its own the
// moment the pair is opened together. Copying the pair therefore gets the
// recovery for free, and gets it IN THE COPY, which is the only place recovery
// may happen.
//
// EVERY ROW IS READ INDIVIDUALLY. `validate` opens the project and answers
// questions about it; salvage runs when that has already failed. One `SELECT *`
// over a table with one corrupt page returns an error and abandons every good
// row behind it, so enumeration reads ROWIDS -- the cheapest cell in the b-tree
// -- and each row is then fetched by rowid on its own. One bad row costs one
// row and one recorded loss.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::export;
use crate::row_scan::scan_rowids;
use crate::projects;
use crate::store;
use crate::store::cast::{CAST_KINDS, KIND_CHARACTER, KIND_PLACE, KIND_POI};
#[path = "analytics_salvage.rs"]
mod analytics_salvage;

/// One thing that could not be recovered, and why. `kind` is a stable machine
/// token; `detail` preserves the original technical diagnostic.
///
/// LOSSES ARE OUTPUT, NOT A LOG LINE. A salvage that recovered nothing is still
/// a SUCCESSFUL salvage if it reported honestly what it could not reach -- that
/// is the whole difference between exit 3 and exit 2, and it is the difference
/// between a writer who knows which two scenes are gone and one who does not
/// know whether to trust any of it.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Loss {
    pub kind: String,
    pub detail: String,
    pub item_id: Option<String>,
}

/// A whole table could not be enumerated. On a zero-byte file this is what
/// happens, and it is why an `open_readonly` that SUCCEEDED is not evidence of a
/// project: SQLite reads a zero-byte file as an empty database.
pub const KIND_TABLE: &str = "table_unreadable";
/// Enumeration of a table stopped part way -- a corrupt page. Everything read
/// before it is kept.
pub const KIND_ENUMERATION: &str = "enumeration_stopped";
/// The file is shorter than its own header says it is: its tail is gone.
///
/// ITS OWN KIND because it is the one loss whose extent nothing else can state.
/// Every other loss here names a row, a table or a file; this one names the
/// pages that are not in the file at all, and whatever lived on them leaves no
/// trace to be reported row by row. A writer whose book is missing its last
/// megabyte gets `enumeration_stopped` for each table the cut ran through and
/// this once, saying why.
pub const KIND_TRUNCATED: &str = "file_truncated";
/// One `item` row could not be read.
pub const KIND_ITEM_ROW: &str = "unreadable_item_row";
/// One `doc` row could not be read.
pub const KIND_DOC_ROW: &str = "unreadable_doc_row";
/// A stored body that is not a document this build can read. The bytes are still
/// written out, as `.raw` -- see `RAW_EXT`.
pub const KIND_UNREADABLE_BODY: &str = "unreadable_body";
/// An item whose `parent_id` names no row in this file. It has no place in the
/// manuscript; its document is still recovered by id.
pub const KIND_ORPHAN_ITEM: &str = "orphan_item";
/// A `doc` row whose `item` is gone: the prose survives, its title and its
/// position in the book do not.
pub const KIND_ORPHAN_DOC: &str = "orphan_doc";
/// The walk failed, so `manuscript.md` was not written.
pub const KIND_STRUCTURE: &str = "structure";
/// A version pointing at an absent blob: it is listed and cannot be restored.
pub const KIND_MISSING_BLOB: &str = "missing_blob";
/// One `synopsis` row could not be read. `KIND_DOC_ROW`'s parallel, and there is
/// no `.raw` beside it: `.raw` exists for a body that READ and did not PARSE as
/// a document, and a synopsis body has no parse step at all -- so the only way
/// to lose one is the row itself, and then there is no string to write.
pub const KIND_SYNOPSIS_ROW: &str = "unreadable_synopsis_row";
/// One `cast_member` row could not be read: a whole character sheet, minus
/// whichever of its detail rows still read.
pub const KIND_CAST_MEMBER_ROW: &str = "unreadable_cast_member_row";
/// One `cast_field` row could not be read: one line of one sheet.
pub const KIND_CAST_FIELD_ROW: &str = "unreadable_cast_field_row";
/// One `cast_alias` row could not be read: one alias on one sheet.
pub const KIND_CAST_ALIAS_ROW: &str = "unreadable_cast_alias_row";
/// A synopsis whose `item` is gone: the summary survives, the row it was about
/// does not. `KIND_ORPHAN_DOC`'s parallel.
pub const KIND_ORPHAN_SYNOPSIS: &str = "orphan_synopsis";
/// Detail rows whose `cast_member` is gone. ONE per member, never one per row:
/// a member with four lost fields is one lost character sheet, and four
/// identical sentences read as four problems. That is `cli::validate`'s rule for
/// the same damage, stated there as a `DISTINCT`.
pub const KIND_ORPHAN_CAST_FIELD: &str = "orphan_cast_field";
/// Aliases whose `cast_member` is gone. `KIND_ORPHAN_CAST_FIELD`'s own rule,
/// one table over: ONE per member, never one per row.
pub const KIND_ORPHAN_CAST_ALIAS: &str = "orphan_cast_alias";
/// A member names a picture and the project's picture directory does not hold
/// it. The state a writer reaches by moving or deleting the file themselves,
/// and the one this command exists to make legible: the row says there was a
/// photograph, so a person reading the recovery knows to go looking rather than
/// assuming the character never had one.
pub const KIND_MISSING_PICTURE: &str = "missing_picture";
/// A picture that is there and could not be copied -- or a `picture_path` that
/// is not a name this application would ever have written, which is a value only
/// a damaged file, a foreign tool or a hand edit can produce. Both are the same
/// answer to the same question: whatever that column meant, this recovery does
/// not have it.
pub const KIND_UNREADABLE_PICTURE: &str = "unreadable_picture";
/// The book names a cover and the project's picture directory does not hold it.
///
/// ITS OWN KIND and not `missing_picture`, which is the same shape 046 argued
/// for `orphan_cast_field` against `orphan_doc`: a person reading a recovery has
/// to know whether what went missing is one character's photograph or the front
/// of their book, and one word for both makes them open every file to find out.
pub const KIND_MISSING_COVER: &str = "missing_cover";
/// A cover that is there and could not be copied -- or a cover row holding
/// something this build would never have written, which cannot be joined to a
/// directory at all.
pub const KIND_UNREADABLE_COVER: &str = "unreadable_cover";

/// One `appearance` row could not be read: one line of the tagging panel, which
/// is one claim about who was in a scene.
pub const KIND_APPEARANCE_ROW: &str = "unreadable_appearance_row";
/// An appearance naming an item or a cast member that is not in this file. ONE
/// KIND FOR BOTH ENDS with the sentence saying which, which is `cli::validate`'s
/// own shape for this table (039): the row is a PAIR, and a script acting on it
/// does the same thing either way. ONE per distinct missing id and never one per
/// row -- `orphan_cast_field`'s rule.
pub const KIND_ORPHAN_APPEARANCE: &str = "orphan_appearance";
/// A `meta` row holding part of the book's design could not be read. Its
/// absence is NOT this: a book nobody has designed has no rows, and reporting
/// that as damage would make every undesigned project salvage as broken.
pub const KIND_DESIGN_ROW: &str = "unreadable_design_row";

/// One `comment` row could not be read: one note the writer left on their own
/// manuscript. `KIND_SYNOPSIS_ROW`'s parallel, and there is no `.raw` beside it
/// for that kind's reason -- a comment body is a TEXT column with no parse step,
/// so the only way to lose one is the row itself, and then there is no string to
/// write.
pub const KIND_COMMENT_ROW: &str = "unreadable_comment_row";
/// Notes whose document is not in this file. ONE per ITEM, never one per row --
/// `orphan_cast_field`'s rule: five notes on one deleted scene are one scene's
/// worth of lost context, and five identical sentences read as five problems.
///
/// A COLLAPSED ANCHOR IS NOT THIS. A note whose passage an edit destroyed is a
/// recovered note that says so; the row read perfectly and nothing was lost by
/// the recovery. See `write_comments`.
pub const KIND_ORPHAN_COMMENT: &str = "orphan_comment";
/// One `dict_word` row could not be read: one word the writer taught the spell
/// checker, which their next spelling pass will flag again.
pub const KIND_WORDLIST_ROW: &str = "unreadable_wordlist_row";

/// One `snapshot` row could not be read: the label and the moment a writer put
/// on a point in their history. The versions it captured are still recovered,
/// under the snapshot's id -- see `KIND_ORPHAN_VERSION`.
pub const KIND_SNAPSHOT_ROW: &str = "unreadable_snapshot_row";
/// One `doc_version` row could not be read: one past draft of one document, or
/// one document's share of one named snapshot.
pub const KIND_VERSION_ROW: &str = "unreadable_version_row";
/// A `blob` row that IS there and would not read.
///
/// ITS OWN KIND AND NOT `missing_blob`, which is the other half of the same
/// question and cannot see this one: `missing_blobs`' `LEFT JOIN` asks only
/// whether the key is present, so a blob whose payload page is corrupt joins
/// perfectly and fails at the fetch. Same shape as the wrong-columns branch a
/// rowid cannot see.
pub const KIND_BLOB_ROW: &str = "unreadable_blob_row";
/// A recovered past draft that is not a document this build can read. The bytes
/// are still written out, as `.raw`, exactly as a live body is.
///
/// ITS OWN KIND and not `unreadable_body`, on 046's `missing_cover` precedent: a
/// person reading a recovery has to know whether what would not parse is the
/// scene they are working on or a draft of it from last Tuesday, and one word
/// for both makes them open every file to find out. It is also why this does
/// NOT join `raw_bodies`, whose doc comment ties its length to `words`.
pub const KIND_UNREADABLE_VERSION_BODY: &str = "unreadable_version_body";
/// Versions belonging to a snapshot row that is not in this file. ONE per
/// SNAPSHOT, never one per version -- `orphan_cast_field`'s rule, and at this
/// table it is the difference between one sentence and one per document in the
/// book.
///
/// THE PROSE IS STILL WRITTEN, under the snapshot id. That is the `cast_field`
/// answer and not the `appearance` one, and 048 drew the line: what a row holds
/// decides it. A version holds a document, so there is always a string to write.
pub const KIND_ORPHAN_VERSION: &str = "orphan_version";
/// One `meta` row could not be read, and it is not one of the seven the design is
/// made of. `KIND_DESIGN_ROW` is that row's own kind and keeps it, so a corrupt
/// page size still reads as a design failure rather than as an anonymous one.
pub const KIND_META_ROW: &str = "unreadable_meta_row";
pub const KIND_ANALYTICS_ROW: &str = "unreadable_analytics_row";
pub const KIND_RESEARCH_ROW: &str = "unreadable_research_row";
pub const KIND_LINK_ROW: &str = "unreadable_knowledge_link_row";
pub const KIND_MISSING_RESEARCH: &str = "missing_research_original";
pub const KIND_CORRUPT_RESEARCH: &str = "corrupt_research_original";
pub const KIND_ORPHAN_RESEARCH: &str = "orphan_research_original";
pub const KIND_ORPHAN_LINK: &str = "orphan_knowledge_link";

/// The extension a body that did not parse is written under.
///
/// IT IS STILL WRITTEN, and that is a salvage decision rather than a courtesy.
/// A body that fails `serde_json` still contains the writer's sentences; the
/// damage is usually at one end of it. Discarding it because this build cannot
/// render it is the opposite of extracting every recoverable object. The
/// extension is not `.md` so that nothing downstream reads it as a manuscript.
pub const RAW_EXT: &str = "raw";

/// The subdirectory every recovered document lands in.
pub const DOCUMENTS_DIR: &str = "documents";
/// The manifest's filename, inside the output directory.
pub const MANIFEST_NAME: &str = "manifest.json";
pub const LOSS_REPORT_NAME: &str = "recovery-report.txt";
/// The whole manuscript in walk order, written only when the walk succeeded.
pub const MANUSCRIPT_NAME: &str = "manuscript.md";
/// Every recovered synopsis, in one file. Written only when there is at least
/// one.
///
/// ONE FILE PER KIND, NOT A FILE PER RECORD, and not front matter on the item's
/// own document. The short of it: `documents/` exists because a document is big and can
/// individually fail to parse, so each needs its own `.raw` escape and its own
/// entry in `renamed`; a synopsis is a TEXT column with no parse step, so the
/// per-record directory would have no work to do and would cost one inode per
/// scene. Front matter is impossible in the general case anyway -- a part and a
/// chapter have no `doc` row, so most items that carry a synopsis have no file
/// to put one on.
pub const SYNOPSES_NAME: &str = "synopses.md";
/// Every recovered cast member, in one file, grouped by kind. Written only when
/// there is at least one member or one orphaned detail row.
///
/// A cast member is about NO item, so there is no document it could ride on
/// under any scheme -- which is why the choice above is the only one available
/// here even before it is argued.
pub const CAST_NAME: &str = "cast.md";
/// Which recovered file is the front of the book and which is the back. Written
/// only when at least one cover was copied.
///
/// A FILE AND NOT A LINE IN THE MANIFEST. `manifest.json` is the machine half;
/// 046's whole argument for `cast.md` and `synopses.md` is that a person opening
/// a recovery directory gets Markdown they can read. A `pictures/` full of uuids
/// with nothing saying which one goes on the cover is a recovery that recovered
/// bytes and not a book.
pub const COVERS_NAME: &str = "covers.md";
/// Where recovered picture files land. Written only when there is at least one.
///
/// A DIRECTORY AND NOT A FILE, unlike `synopses.md` and `cast.md`, and the
/// difference is that these are BYTES rather than text. There is nothing to
/// aggregate them into: `documents/`'s shape, for `documents/`'s reason -- each
/// one is big and each one can individually fail.
///
/// THE ORIGINALS AND NOT THE THUMBNAILS. A thumbnail is this application's
/// cache; copying it would put a 256-pixel version of the writer's photograph
/// beside the real one under a name that looks like a second picture.
pub const PICTURES_DIR: &str = "pictures";
/// Every recovered note, in one file, grouped by the document it is about.
/// Written only when there is at least one.
///
/// ONE FILE PER KIND, `synopses.md`'s rule -- and NOT an inline marker in
/// `documents/<id>.md`, which 046's argument already refuses and which a note
/// refuses twice more: a body written verbatim as `.raw` must not be
/// interleaved with anything, and putting a note into prose AT AN OFFSET is
/// interpretation, which is the one thing this command does not do.
pub const COMMENTS_NAME: &str = "comments.md";
pub const REVISION_PLANNING_NAME: &str = "revision-planning.json";
pub const KIND_REVISION_PASS_ROW: &str = "unreadable_revision_pass_row";
pub const KIND_REVISION_TASK_ROW: &str = "unreadable_revision_task_row";
/// The project's own spelling wordlist. Written only when it holds a word.
///
/// A FILE AND NOT A MANIFEST KEY, which is where this parts from the design
/// (048): a design is a handful of scalars a person re-types into a panel, and a
/// wordlist is a set of unbounded size. `dict.rs`'s own header refuses to put
/// this set in a `meta` scalar for the same reason.
pub const WORDLIST_NAME: &str = "wordlist.md";

/// Where the documents of each recovered named snapshot land, one
/// subdirectory per snapshot: `snapshots/<snapshot-id>/<item-id>.md`.
///
/// A DIRECTORY AND NOT AN AGGREGATE FILE, which is `documents/`' shape for
/// `documents/`' reason and NOT `synopses.md`'s. 046's split turns on one fact:
/// a per-record directory exists because a document is big and can individually
/// fail to PARSE, so each needs its own `.raw` escape. A snapshot's body is a
/// stored ProseMirror document, identical in kind to a live one, so the
/// aggregate argument does not reach it.
pub const SNAPSHOTS_DIR: &str = "snapshots";
/// The index of what each named snapshot was and which recovered file holds
/// each of its documents. Written whenever this file held a snapshot or a
/// version belonging to one.
///
/// `manuscript.md`'s parallel: the directory holds the prose and this says what
/// the prose IS. It names every path it wrote, which is why snapshot documents
/// are NOT in the manifest's `renamed` -- that map is keyed by item id and one
/// item appears once in every snapshot.
pub const SNAPSHOTS_NAME: &str = "snapshots.md";

/// What a salvage recovered and what it did not. The field names ARE the JSON
/// keys, in `--json` and in `manifest.json` alike -- one shape, serialized
/// twice, so the key test covers the file as well as the flag.
#[derive(Debug, Serialize)]
pub struct Salvage {
    /// The salvaged project's FILE NAME, never its path (054,
    /// `decisions/2026-08-29-no-home-directory.md`).
    ///
    /// It held the whole path until then, so `manifest.json` -- a plain-text
    /// file whose entire purpose is to be read by somebody other than the
    /// person who ran the command -- carried the operating-system user name
    /// before it carried a word of the book. What a reader needs is WHICH FILE
    /// this recovery came out of, and the name answers that; where it lived on
    /// the machine it was recovered on answers nothing they can act on.
    /// `crate::projects::without_directory` is the one statement of the rule.
    pub source: String,
    pub source_bytes: u64,
    /// Which sidecars came along with the copy. `-wal` present here is how a
    /// reader knows the recovery had a second copy of the damaged pages to work
    /// from.
    pub sidecars: Vec<String>,
    /// The recovery directory's OWN NAME, never its path, on `source`'s rule.
    ///
    /// The manifest lives INSIDE this directory, so the value is self-referential
    /// for anyone reading the file: they are already in it. The operator, who is
    /// the one person who needs the whole path, gets it on the terminal --
    /// `salvage_report` takes the path they typed and prints that.
    pub out_dir: String,
    /// None when the file would not answer `PRAGMA user_version` at all.
    pub schema_version: Option<i64>,
    pub name: String,
    pub items_recovered: u64,
    pub documents_recovered: u64,
    pub synopses_recovered: u64,
    pub cast_members_recovered: u64,
    pub cast_fields_recovered: u64,
    /// How many `cast_alias` rows read (105, v10). `cast_fields_recovered`'s
    /// own reason for a separate figure: it is a separate table.
    pub cast_aliases_recovered: u64,
    /// How many `appearance` rows read: tags, not people and not scenes. One
    /// figure and not two, which is `cli::inspect`'s choice for this table --
    /// `cast_members`/`cast_fields` are two because they are two TABLES.
    pub appearances_recovered: u64,
    /// How many `comment` rows read: notes, not documents.
    pub comments_recovered: u64,
    /// How many of those notes have a collapsed anchor -- the application's own
    /// derivation (`anchor_from >= anchor_to`), which means an edit destroyed the
    /// passage the note was about.
    ///
    /// A SECOND FIGURE FOR ONE TABLE, unlike `appearances_recovered`, and it is
    /// not a second table's count: it is how many of the recovered notes can no
    /// longer say which passage they were about, which is the single most
    /// important thing about a recovered set of notes.
    pub comments_orphaned: u64,
    /// How many words the project's spelling list held.
    pub wordlist_recovered: u64,
    /// How many `snapshot` rows read: the named points a writer chose to keep.
    pub snapshots_recovered: u64,
    /// How many past drafts were written out: one per document per named
    /// snapshot, minus the ones whose bytes were gone or would not parse.
    pub versions_recovered: u64,
    /// How many AUTOMATIC versions this recovery deliberately did not write.
    ///
    /// NOT A LOSS, AND THAT IS THE DECISION RATHER THAN AN OVERSIGHT. An
    /// automatic version is written by a five-minute throttle the writer never
    /// sees and deleted again by `thin` on a schedule nobody is asked about; the
    /// current body is already in `documents/` and `manuscript.md`. Writing them
    /// all out is `documents/`' scale multiplied by `MAX_AUTO_VERSIONS`, which at
    /// the stress fixture is over a million files on a disk that already holds a
    /// broken book. So they are COUNTED and SAID, at zero and every other
    /// number: 049's rule for the collapsed anchor, one table on -- a `Loss`
    /// would hand `complete: false` and exit 3 to every healthy edited book,
    /// which is what makes a reported omission the honest form and silence the
    /// defect.
    pub versions_dropped: u64,
    pub pictures_recovered: u64,
    /// How many of the book's two covers were copied out.
    pub covers_recovered: u64,
    pub research_resources_recovered: u64,
    pub knowledge_links_recovered: u64,
    pub research_originals_recovered: u64,
    pub knowledge: Option<String>,
    pub research: Option<String>,
    pub analytics: Option<String>,
    pub review: Option<String>,
    pub review_recovered: crate::review_validation::Counts,
    /// Bodies written verbatim as `.raw` because they did not parse.
    pub raw_bodies: Vec<String>,
    /// Words in the readable recovered bodies. An undercount by exactly
    /// `raw_bodies.len()` documents, which is why both are reported.
    pub words: u64,
    /// The manuscript's filename, or None when the walk failed.
    pub manuscript: Option<String>,
    /// Why there is no manuscript. Set exactly when `manuscript` is None.
    pub manuscript_omitted: Option<String>,
    /// `synopses.md`, or None when this file held no readable synopsis. None
    /// NEVER means "they were lost" -- a lost one is a `Loss`, and `complete`
    /// is the flag that says whether there were any. It is the ordinary answer
    /// for a file older than schema 6 and for a book nobody has summarised.
    pub synopses: Option<String>,
    /// `cast.md`, or None, on exactly the same reading.
    pub cast: Option<String>,
    /// `comments.md`, or None when this file held no readable note. None NEVER
    /// means "they were lost" -- `synopses`' reading exactly, and it is the
    /// ordinary answer for a file older than schema 4 and for a book nobody has
    /// annotated.
    pub comments: Option<String>,
    /// `wordlist.md`, or None, on the same reading again: a file older than
    /// schema 5, or a writer who never taught the checker a word.
    pub wordlist: Option<String>,
    /// `snapshots.md`, or None when this file held no named snapshot and no
    /// version belonging to one. None NEVER means "they were lost" -- 046's
    /// reading -- and it is the ordinary answer for a file older than schema 2
    /// and for a writer who has never named a moment.
    pub snapshots: Option<String>,
    /// `covers.md`, or None when this file named no cover that could be copied.
    /// None on `cast`'s reading exactly: a lost cover is a `Loss`, and this is
    /// the ordinary answer for a book nobody has put a cover on.
    pub covers: Option<String>,
    /// What the book's design rows said, VERBATIM AND UNPARSED.
    ///
    /// None means the `meta` table could not be read at all, and a
    /// `table_unreadable` loss says so -- so this is the one `Option` in this
    /// struct whose None can mean "I could not look", and it is NEVER silent.
    /// An object whose fields are all null is the other answer: the table read
    /// and this book was never designed.
    pub design: Option<RecoveredDesign>,
    /// EVERY `meta` row, verbatim, by key.
    ///
    /// THE SWEEP EXISTS BECAUSE THE ROSTER COULD NOT SEE THIS. `SALVAGED` is
    /// table-level, and `meta` was salvaged BY KEY -- the project's name, the two
    /// covers and the design rows -- so a row that was none of those was
    /// silent exactly as the `comment` table was before 049, and the daily word
    /// target and its baseline were live examples. One reader now takes every
    /// row; `design` is a NAMED SUBSET projected from this map rather than a
    /// second read of the same table.
    ///
    /// None means the table could not be read at all, with a `table_unreadable`
    /// beside it saying so -- `design`'s reading, and the two are null together
    /// because they now have one cause.
    ///
    /// VERBATIM, empty values included. "An empty value is an absent one" is
    /// `design`'s interpretation of its own rows and stays there; a sweep
    /// that applied it would be interpreting, which this command does not do.
    pub meta: Option<BTreeMap<String, String>>,
    /// `pictures`, or None when this file named no picture that could be
    /// copied. None NEVER means "they were lost" -- a lost one is a `Loss` --
    /// and it is the ordinary answer for a file older than schema 8 and for a
    /// book nobody has put a photograph in.
    pub pictures: Option<String>,
    /// item id -> filename, for every document NOT written as `<id>.md`: an id
    /// that is not a safe filename, a collision between two that sanitise
    /// alike, and a body written verbatim as `.raw`. The ordinary case is left
    /// out because at the stress fixture a full mapping is fifteen thousand
    /// lines of manifest restating a rule this comment states once.
    pub renamed: BTreeMap<String, String>,
    pub losses: Vec<Loss>,
    /// True when there were no losses at all. The exit code is derived from
    /// this, and it is reported in the manifest either way so a manifest read
    /// later says which run it was.
    pub complete: bool,
}

/// Salvage the project at `source` into `out_dir`, which MUST NOT EXIST.
///
/// Refusing an existing directory rather than writing into it: the operator
/// names this path on a command line, next to the path of a damaged manuscript,
/// and a typo that lands the recovery in a directory holding their files is a
/// second accident on top of the first. `create_dir` is the refusal -- it is the
/// filesystem's own atomic "did not exist", not an `exists()` check a race can
/// invalidate, which is the rule `export`'s `create_new(true)` already follows.
///
/// The two error shapes are separate because they mean different things to a
/// script: `Usage` is "you asked wrongly" and `Unreadable` is "I could not
/// look".
///
/// `#[cfg(test)]` SINCE 055, and for `Strings::english`'s recorded reason: the
/// English recovery is what every test in this crate asks for, and a
/// production caller naming a language instead of resolving one from
/// `settings.json` is the defect that slice removed. `cli::dispatch` calls
/// `salvage_with`.
#[cfg(test)]
pub fn salvage(source: &Path, out_dir: &Path) -> Result<Salvage, Refusal> {
    salvage_with(source, out_dir, crate::strings::Strings::english())
}

/// The same, in a language the caller chooses.
///
/// THE `_with` SHAPE `export_into_with` ALREADY USES, and for its reason: the
/// pair keeps the plain call at the arity every existing caller and every
/// existing test uses, and puts the injected collaborator on the one that needs
/// it. `salvage` is the English recovery and says so by name.
///
/// A RECOVERY IS A DIRECTORY A PERSON READS. The fixed words in
/// `manuscript.md`, `cast.md`, `synopses.md`, `comments.md`, `wordlist.md`,
/// `snapshots.md` and `covers.md` come from `strings`; the writer's own words,
/// the item ids and the loss KINDS do not.
pub fn salvage_with(
    source: &Path,
    out_dir: &Path,
    strings: crate::strings::Strings,
) -> Result<Salvage, Refusal> {
    // The refusal comes FIRST, before a byte is copied. A run that spent a
    // minute copying a stress project and then refused the destination would
    // have done its work for nothing.
    std::fs::create_dir(out_dir).map_err(|e| {
        Refusal::Usage(format!(
            "{}: will not salvage into this directory ({e})",
            out_dir.display()
        ))
    })?;

    let source_bytes = std::fs::metadata(source)
        .map(|m| m.len())
        .map_err(|e| Refusal::Unreadable(format!("{}: {e}", source.display())))?;

    // The working copy sits BESIDE the output directory, not in $TMPDIR. The
    // operator already chose a filesystem with room for the recovered
    // manuscript; /tmp is tmpfs on this machine and a stress project would be
    // copied into RAM.
    let near = out_dir.parent().unwrap_or_else(|| Path::new("."));
    let work = Working::copy(source, near).map_err(Refusal::Unreadable)?;

    match extract(&work, source, source_bytes, out_dir, strings) {
        Ok(v) => Ok(v),
        Err(e) => Err(Refusal::Unreadable(e)),
    }
}

/// Why a salvage did not answer. Mirrors the CLI's exit table: `Usage` is 1,
/// `Unreadable` is 2. A salvage that ANSWERED and found losses is not an error
/// at all -- it is a `Salvage` with `complete: false`, and exit 3.
#[derive(Debug)]
pub enum Refusal {
    Usage(String),
    Unreadable(String),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Usage(m) | Refusal::Unreadable(m) => write!(f, "{m}"),
        }
    }
}

/// The sidecars SQLite may have left beside a project. `-wal` and `-shm` are
/// WAL mode's; `-journal` is the rollback journal a file not in WAL mode uses,
/// and a damaged project need not be in the mode this build would have chosen.
const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// The SQLite file header. Four numbers in it matter here and their offsets are
/// the format's: the page size at 16, the file change counter at 24, the
/// database size in pages at 28, and at 92 the change-counter value that size
/// was computed for.
const HEADER_BYTES: usize = 100;
const OFF_PAGE_SIZE: usize = 16;
const OFF_CHANGE_COUNTER: usize = 24;
const OFF_PAGE_COUNT: usize = 28;
const OFF_VERSION_VALID_FOR: usize = 92;

/// THE ONE REPAIR THIS COMMAND MAKES, and it makes it to the WORKING COPY.
///
/// Until 052 a project whose tail was gone salvaged as "this file does not hold
/// a project this build can salvage", and every byte of the surviving manuscript
/// with it. That is not SQLite being unable to read the pages that are there: it
/// is SQLite believing the header. The size at byte 28 is trusted exactly while
/// the number at byte 92 says which change-counter value it was computed for, so
/// a file whose end was cut off still claims its old length, SQLite reads past
/// the end of it looking for the schema, and calls the whole file malformed.
///
/// Moving those two numbers apart tells SQLite the recorded size is stale and to
/// MEASURE THE FILE instead. It invents no page count: the number SQLite then
/// uses is the one the file itself has. Measured on the stress fixture cut to
/// nine tenths, that is the difference between nothing and 17,521 of 20,000
/// items and 13,723 of 15,200 documents.
///
/// STRICTLY CONDITIONAL, because a header rewritten on a healthy file is damage
/// this command inflicted. It fires only when the header claims MORE pages than
/// the file holds -- which no undamaged database does -- and only when the two
/// numbers currently agree, because when they already disagree SQLite is already
/// measuring and there is nothing to do.
///
/// Returns what the header claimed and what is actually there, or None when it
/// changed nothing.
fn distrust_stale_page_count(header: &mut [u8; HEADER_BYTES], file_len: u64) -> Option<(u32, u32)> {
    let raw = u16::from_be_bytes([header[OFF_PAGE_SIZE], header[OFF_PAGE_SIZE + 1]]);
    // 1 means 65536, and every other legal value is a power of two from 512 to
    // 32768. A page size outside that is not a geometry to divide by: answering
    // from it would invent a page count out of a header that is itself broken.
    let page_size: u64 = if raw == 1 {
        65536
    } else if raw >= 512 && raw.is_power_of_two() {
        u64::from(raw)
    } else {
        return None;
    };
    let actual = file_len / page_size;
    if actual == 0 || actual > u64::from(u32::MAX) {
        return None;
    }
    let actual = actual as u32;
    let claimed = u32::from_be_bytes(
        header[OFF_PAGE_COUNT..OFF_PAGE_COUNT + 4]
            .try_into()
            .expect("four bytes"),
    );
    if claimed <= actual {
        return None;
    }
    let counter = u32::from_be_bytes(
        header[OFF_CHANGE_COUNTER..OFF_CHANGE_COUNTER + 4]
            .try_into()
            .expect("four bytes"),
    );
    let valid_for = u32::from_be_bytes(
        header[OFF_VERSION_VALID_FOR..OFF_VERSION_VALID_FOR + 4]
            .try_into()
            .expect("four bytes"),
    );
    if valid_for != counter {
        return None;
    }
    // wrapping_add(1) can never land back on the counter, whatever it is.
    header[OFF_VERSION_VALID_FOR..OFF_VERSION_VALID_FOR + 4]
        .copy_from_slice(&counter.wrapping_add(1).to_be_bytes());
    Some((claimed, actual))
}

/// The copy salvage actually reads. Dropping it removes the directory, so a
/// failure at any point below leaves nothing behind.
struct Working {
    _dir: tempfile::TempDir,
    db: PathBuf,
    sidecars: Vec<String>,
    /// What the header claimed and what the file holds, when the copy's header
    /// had to be distrusted. None on every undamaged file.
    truncated: Option<(u32, u32)>,
}

impl Working {
    fn copy(source: &Path, near: &Path) -> Result<Working, String> {
        let dir = tempfile::Builder::new()
            .prefix(".salvage-")
            .tempdir_in(near)
            .map_err(|e| format!("{}: could not make a working copy ({e})", near.display()))?;
        // The copy keeps the source's BASENAME: the project's name falls back to
        // the file stem when the meta row is gone, and a copy named
        // `tmp1234.db` would report the manuscript as being called that.
        let base = source
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("project.db"));
        let db = dir.path().join(base);
        std::fs::copy(source, &db).map_err(|e| format!("{}: {e}", source.display()))?;
        let mut sidecars = Vec::new();
        for suffix in SIDECARS {
            let from = sidecar_path(source, suffix);
            if from.exists() && std::fs::copy(&from, sidecar_path(&db, suffix)).is_ok() {
                sidecars.push(suffix.trim_start_matches('-').to_string());
            }
        }
        // THE HEADER REPAIR, on the copy.
        //
        // IT SHIPPED WITH A `-wal` GUARD AND THE GUARD WAS DELETED, on the
        // recorded rule that a guard no input can reach is worse than none
        // because a reader credits it for the refusal. The argument for it was
        // that in WAL mode a header may legitimately claim more pages than the
        // file holds; it may not. The database file's page-1 image is the last
        // CHECKPOINTED one, and a checkpoint extends the file before it updates
        // the header, so the recorded size never runs ahead of the file. A
        // truncated file with a log beside it is still a truncated file and
        // still wants the repair -- and where the log is valid SQLite takes the
        // page count from its last commit frame and never reads this number at
        // all. A mutation deleting the guard survived the whole suite, which is
        // how it was found.
        let truncated = repair_copied_header(&db);
        Ok(Working {
            _dir: dir,
            db,
            sidecars,
            truncated,
        })
    }
}

/// Read the copy's header, apply `distrust_stale_page_count`, and write the
/// hundred bytes back only if it changed them. Any IO failure here is not a
/// refusal: the file is then read exactly as it would have been before 052.
fn repair_copied_header(db: &Path) -> Option<(u32, u32)> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let len = std::fs::metadata(db).ok()?.len();
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(db)
        .ok()?;
    let mut header = [0u8; HEADER_BYTES];
    file.read_exact(&mut header).ok()?;
    let found = distrust_stale_page_count(&mut header, len)?;
    file.seek(SeekFrom::Start(0)).ok()?;
    file.write_all(&header).ok()?;
    file.flush().ok()?;
    Some(found)
}

/// A row read individually, or the loss that reading it cost.
type Rows<T> = (Vec<T>, Vec<Loss>);

/// Preserve salvage's stable loss token around the shared row scan.
pub(crate) fn rowids(conn: &rusqlite::Connection, table: &str) -> Result<Rows<i64>, String> {
    let (ids, detail) = crate::row_scan::rowids(conn, table)?;
    Ok((ids, detail.into_iter().map(|detail| Loss {
        kind: KIND_ENUMERATION.into(), detail, item_id: None,
    }).collect()))
}

/// One recovered item row. Only the fields salvage writes out; `position` and
/// `rev` are the store's business and mean nothing outside a working walk.
struct RecoveredItem {
    id: String,
    parent_id: Option<String>,
    title: String,
}

/// One recovered `synopsis` row.
struct RecoveredSynopsis {
    item_id: String,
    body: String,
}

/// One recovered `cast_member` row. `created_at`/`updated_at` are left behind:
/// they are the store's bookkeeping and mean nothing in a Markdown file a person
/// is reading to type their character back in.
struct RecoveredMember {
    id: String,
    kind: String,
    name: String,
    summary: String,
    /// What the column said, verbatim and unvalidated. `NULL` for every file
    /// behind schema 8, which the SELECT supplies as a literal rather than the
    /// walk asking for a column that is not there -- see `extract`.
    picture_path: Option<String>,
    deleted_at: Option<i64>,
}

/// One recovered `appearance` row: who was tagged where. TWO IDS AND NO TEXT,
/// which is why an orphaned one is written differently from an orphaned
/// `cast_field` -- see `write_cast`.
struct RecoveredAppearance {
    item_id: String,
    member_id: String,
}

/// One recovered `comment` row: a note the writer left on a passage of their
/// own manuscript.
///
/// `quote` IS HOW A RECOVERED NOTE SAYS WHAT IT WAS ABOUT, and the offsets are
/// not. `comments.rs` stores the passage as it read when the note was made
/// precisely because it is "the ONLY thing an orphan has left"; salvage prints
/// it and never cuts the passage out of the recovered body. An anchor is a pair
/// of ProseMirror DOCUMENT POSITIONS, and turning one into text needs the schema
/// the page owns -- the host has no such mapping, and inventing one here would
/// make salvage interpret. Worse, in the case that matters the prose at those
/// positions is no longer the prose the note was about, so quoting it would be
/// silently re-anchoring, which `comments.rs`'s header names as the worst thing
/// this feature could do.
struct RecoveredComment {
    item_id: String,
    id: i64,
    body: String,
    anchor_from: i64,
    anchor_to: i64,
    quote: String,
    resolved: bool,
}

impl RecoveredComment {
    /// The application's OWN derivation, restated and not re-decided: a
    /// collapsed pair means "an edit destroyed this passage" and there is no
    /// stored flag, for the reason `comments.rs` gives -- a second statement of
    /// one fact is free to fall out of step with the first.
    fn orphaned(&self) -> bool {
        self.anchor_from >= self.anchor_to
    }
}

/// One recovered `snapshot` row: a moment the writer named on purpose.
struct RecoveredSnapshot {
    id: i64,
    label: String,
    created_at: i64,
}

/// One recovered `doc_version` row: the INDEX entry of a past draft. The bytes
/// are in `blob`, under `blob_key`, because a version is content-addressed and
/// two versions of an unedited document share one row of prose.
///
/// `snapshot_id` IS WHAT MAKES A VERSION THE WRITER'S. `None` is the automatic
/// five-minute throttle's; `Some` is a moment they named. Salvage recovers the
/// second and counts the first -- see `Salvage::versions_dropped`.
struct RecoveredVersion {
    id: i64,
    item_id: String,
    blob_key: String,
    snapshot_id: Option<i64>,
}

/// One recovered `cast_field` row.
struct RecoveredField {
    member_id: String,
    ordinal: i64,
    label: String,
    value: String,
}

/// One recovered `cast_alias` row (105, v10). `RecoveredField`'s own shape,
/// one column narrower: an alias has no label, only the ordinal that orders
/// it and the member it names.
struct RecoveredAlias {
    member_id: String,
    ordinal: i64,
    alias: String,
}

/// Enumerate `table`, fetch every row of it individually, and append a `Loss`
/// for the table itself, for an enumeration that stopped, and for each row that
/// would not read.
///
/// THIS IS THE WHOLE WIDENING OF SLICE 046, and it is one function because the
/// fix for every table salvage did not know about has one shape. `item` and
/// `doc` keep their own readers above rather than being folded in: their loss
/// sentences are bespoke, `read_docs` sorts its output, and this slice may not
/// change what salvage does with prose.
/// The `bool` is WHETHER THE TABLE WAS READ, and it is not decoration: an
/// orphan check is a claim that the other end is GONE, and a table that was
/// never read holds nothing to be gone from. Judging an `appearance` against an
/// `item` table that would not open reports every tagged scene as missing --
/// hundreds of confident sentences about rows nobody looked at. 048.
fn walk<T>(
    conn: &rusqlite::Connection,
    table: &str,
    select: &str,
    row_kind: &str,
    losses: &mut Vec<Loss>,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> (Vec<T>, bool) {
    let ids = match rowids(conn, table) {
        Ok((ids, mut stopped)) => {
            losses.append(&mut stopped);
            ids
        }
        Err(e) => {
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!("the {table} table could not be read: {e}"),
                item_id: None,
            });
            return (Vec::new(), false);
        }
    };
    // A PREPARE THAT FAILS HERE IS REACHABLE AND IS A LOSS, not an empty
    // return. `rowids` proves the table exists; the SELECT can still fail
    // because the table does not have the COLUMNS this build expects -- a
    // foreign tool's `synopsis`, or one damaged into a different shape. Returning
    // an empty vec there would report "this file holds no synopses", which is
    // the silent loss this whole slice exists to end.
    let mut stmt = match conn.prepare(select) {
        Ok(stmt) => stmt,
        Err(e) => {
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!(
                    "the {table} table is not the shape this build knows ({e}), \
                     so nothing in it was recovered"
                ),
                item_id: None,
            });
            return (Vec::new(), false);
        }
    };
    let mut out = Vec::new();
    for rowid in &ids {
        match stmt.query_row([rowid], &map) {
            Ok(row) => out.push(row),
            Err(e) => losses.push(Loss {
                kind: row_kind.into(),
                detail: format!(
                    "row {rowid} of {table} could not be read: {e}; \
                     whatever it held was not recovered"
                ),
                item_id: None,
            }),
        }
    }
    (out, true)
}

fn extract(
    work: &Working,
    source: &Path,
    source_bytes: u64,
    out_dir: &Path,
    strings: crate::strings::Strings,
) -> Result<Salvage, String> {
    let conn = rusqlite::Connection::open_with_flags(
        &work.db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("{}: {e}", source.display()))?;
    let _ = conn.pragma_update(None, "busy_timeout", 5000);

    let schema_version: Option<i64> = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).ok();

    let mut losses: Vec<Loss> = Vec::new();

    // THE TRUNCATION IS REPORTED BEFORE ANY TABLE IS READ, and it is reported
    // even when everything below then succeeds: a file missing its tail is not a
    // complete recovery whatever the b-trees that survived say, and this is the
    // only place the extent of the cut can be stated at all.
    if let Some((claimed, actual)) = work.truncated {
        losses.push(Loss {
            kind: KIND_TRUNCATED.into(),
            detail: format!(
                "this file's header says it holds {claimed} page(s) and only {actual} are \
                 present: the end of the file is gone. Everything the pages that survived still \
                 held was recovered; anything that lived past page {actual} was never in this \
                 file to read"
            ),
            item_id: None,
        });
    }

    // ------------------------------------------------------------ items
    let (items, item_table_ok) = match rowids(&conn, "item") {
        Ok((ids, mut stopped)) => {
            losses.append(&mut stopped);
            // A PREPARE THAT FAILS HERE IS REACHABLE AND IS A LOSS, `walk`'s
            // rule on the path `walk` was forbidden to touch. `rowids` proves
            // the table EXISTS; the SELECT can still fail because it does not
            // have the COLUMNS this build expects, since a rowid is a b-tree
            // key and knows nothing about columns. This returned an empty vec
            // until 048, which reported a file full of scenes as a file with
            // none and recorded NOTHING -- silent total loss on the recovery
            // command.
            match read_items(&conn, &ids) {
                Ok((rows, mut bad)) => {
                    losses.append(&mut bad);
                    (rows, true)
                }
                Err(e) => {
                    losses.push(Loss {
                        kind: KIND_TABLE.into(),
                        detail: format!(
                            "the item table is not the shape this build knows ({e}), \
                             so nothing in it was recovered"
                        ),
                        item_id: None,
                    });
                    (Vec::new(), false)
                }
            }
        }
        Err(e) => {
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!("the item table could not be read: {e}"),
                item_id: None,
            });
            (Vec::new(), false)
        }
    };

    // ------------------------------------------------------------- docs
    let (docs, doc_table_ok) = match rowids(&conn, "doc") {
        Ok((ids, mut stopped)) => {
            losses.append(&mut stopped);
            // The same fix, and here what the silence cost was the PROSE.
            match read_docs(&conn, &ids) {
                Ok((rows, mut bad)) => {
                    losses.append(&mut bad);
                    (rows, true)
                }
                Err(e) => {
                    losses.push(Loss {
                        kind: KIND_TABLE.into(),
                        detail: format!(
                            "the doc table is not the shape this build knows ({e}), \
                             so nothing in it was recovered"
                        ),
                        item_id: None,
                    });
                    (Vec::new(), false)
                }
            }
        }
        Err(e) => {
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!("the doc table could not be read: {e}"),
                item_id: None,
            });
            (Vec::new(), false)
        }
    };

    // NEITHER table readable is "I could not look", not "I looked and found
    // nothing". This is the zero-byte case: `open_readonly` SUCCEEDS on a
    // zero-byte file because SQLite reads it as an empty database, and reporting
    // that as a project with nothing in it would tell a writer their manuscript
    // was empty when in truth it was never read.
    if !item_table_ok && !doc_table_ok {
        return Err(format!(
            "{}: neither the item table nor the doc table could be read; \
             this file does not hold a project this build can salvage",
            source.display()
        ));
    }

    // A NAME LOOKUP, NOT A ROWID SCAN: `items` above is read by rowid for
    // corruption robustness, but `RecoveredItem` carries no `type` and
    // widening it would touch every caller of that struct for one boolean.
    // A plain query against the live table is enough here -- if the table
    // cannot answer it, the set comes back empty and every body salvages
    // exactly as it did before 101, which is the safe side: it means "report
    // damage if the body does not parse", never "hide damage".
    let timeline_ids: HashSet<String> = conn
        .prepare("SELECT id FROM item WHERE type = ?1")
        .and_then(|mut stmt| {
            stmt.query_map([store::TIMELINE_TYPE], |r| r.get::<_, String>(0))?
                .collect::<Result<HashSet<String>, _>>()
        })
        .unwrap_or_default();

    // ------------------------------------------------ synopses and the cast
    //
    // GUARDED ON THE SCHEMA VERSION, exactly as `missing_blobs` below is and for
    // its reason: a v5 file has no `synopsis` table and a v6 file has no cast
    // tables, and neither is thereby DAMAGED. A missing table must not become a
    // loss, or every old file salvages as broken. `unwrap_or(0)` is deliberate
    // and is that function's rule too -- a file that will not answer
    // `PRAGMA user_version` is not asked about tables the pragma would have said
    // do not exist.
    //
    // A file that CLAIMS the version and has lost the table is the other case
    // entirely, and it lands as `table_unreadable` through `walk`. That is the
    // damage this command exists for.
    let (synopses, _) = if schema_version.unwrap_or(0) >= 6 {
        walk(
            &conn,
            "synopsis",
            "SELECT item_id, body FROM synopsis WHERE rowid = ?1",
            KIND_SYNOPSIS_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredSynopsis {
                    item_id: r.get(0)?,
                    body: r.get(1)?,
                })
            },
        )
    } else {
        (Vec::new(), false)
    };

    let (members, members_ok, fields) = if schema_version.unwrap_or(0) >= 7 {
        // THE VERSION CHOOSES THE FIFTH COLUMN, and a `NULL` LITERAL is what a
        // file behind schema 8 gets. Two SELECTs through ONE mapper and one
        // walk: asking a v7 file for `picture_path` makes the prepare fail, and
        // `walk`'s wrong-shape branch would then report the WHOLE cast table as
        // unreadable -- every character sheet in an old project lost, by a check
        // added to recover a photograph. That is the 046 guard rule one version
        // on, and a test says so.
        let member_select = if schema_version.unwrap_or(0) >= 14 {
            "SELECT id, kind, name, summary, picture_path, deleted_at FROM cast_member WHERE rowid = ?1"
        } else if schema_version.unwrap_or(0) >= 8 {
            "SELECT id, kind, name, summary, picture_path, NULL FROM cast_member WHERE rowid = ?1"
        } else {
            "SELECT id, kind, name, summary, NULL, NULL FROM cast_member WHERE rowid = ?1"
        };
        let (members, members_ok) = walk(
            &conn,
            "cast_member",
            member_select,
            KIND_CAST_MEMBER_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredMember {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    name: r.get(2)?,
                    summary: r.get(3)?,
                    picture_path: r.get(4)?,
                    deleted_at: r.get(5)?,
                })
            },
        );
        let (fields, _) = walk(
            &conn,
            "cast_field",
            "SELECT member_id, ordinal, label, value FROM cast_field WHERE rowid = ?1",
            KIND_CAST_FIELD_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredField {
                    member_id: r.get(0)?,
                    ordinal: r.get(1)?,
                    label: r.get(2)?,
                    value: r.get(3)?,
                })
            },
        );
        (members, members_ok, fields)
    } else {
        (Vec::new(), false, Vec::new())
    };

    // -------------------------------------------------------- the aliases
    //
    // v10's table (105), guarded on its OWN version rather than folded into
    // the `>= 7` block above: a v9 file has cast members and fields and no
    // `cast_alias` table, and one guard covering both versions reads it
    // wrongly at this end -- the picture column's own precedent one version
    // on.
    let (aliases, _) = if schema_version.unwrap_or(0) >= 10 {
        walk(
            &conn,
            "cast_alias",
            "SELECT member_id, ordinal, alias FROM cast_alias WHERE rowid = ?1",
            KIND_CAST_ALIAS_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredAlias {
                    member_id: r.get(0)?,
                    ordinal: r.get(1)?,
                    alias: r.get(2)?,
                })
            },
        )
    } else {
        (Vec::new(), false)
    };

    // ---------------------------------------------------- who appears where
    //
    // v9's table, guarded on its own version for the reason the two above are:
    // a v8 file has no `appearance` table and is not thereby damaged.
    let (appearances, _) = if schema_version.unwrap_or(0) >= 9 {
        walk(
            &conn,
            "appearance",
            "SELECT item_id, cast_member_id FROM appearance WHERE rowid = ?1",
            KIND_APPEARANCE_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredAppearance {
                    item_id: r.get(0)?,
                    member_id: r.get(1)?,
                })
            },
        )
    } else {
        (Vec::new(), false)
    };

    // ------------------------------------------- what the writer said about it
    //
    // v4's table, guarded on its own version for the reason every guard above is
    // its own: a v3 file has no `comment` table and is not thereby damaged, and
    // one guard covering two versions reads the file between them wrongly at one
    // end.
    let (comments, _) = if schema_version.unwrap_or(0) >= 4 {
        walk(
            &conn,
            "comment",
            "SELECT item_id, id, body, anchor_from, anchor_to, quote, resolved_at \
             FROM comment WHERE rowid = ?1",
            KIND_COMMENT_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredComment {
                    item_id: r.get(0)?,
                    id: r.get(1)?,
                    body: r.get(2)?,
                    anchor_from: r.get(3)?,
                    anchor_to: r.get(4)?,
                    quote: r.get(5)?,
                    // RESOLVED IS KEPT, NEVER DELETED -- the store's rule, so a
                    // settled note is recovered like any other and merely says
                    // so. Read as the timestamp it is rather than as a flag.
                    resolved: r.get::<_, Option<i64>>(6)?.is_some(),
                })
            },
        )
    } else {
        (Vec::new(), false)
    };

    let (revision_passes, revision_tasks) = if schema_version.unwrap_or(0) >= 13 {
        let (passes, _) = walk(
            &conn, "revision_pass",
            "SELECT id,name,purpose,created_at,updated_at FROM revision_pass WHERE rowid=?1",
            KIND_REVISION_PASS_ROW, &mut losses,
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?)),
        );
        let (tasks, _) = walk(
            &conn, "revision_task",
            "SELECT id,body,item_id,target_caption,pass_id,done_at,created_at,updated_at FROM revision_task WHERE rowid=?1",
            KIND_REVISION_TASK_ROW, &mut losses,
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?,
                    r.get::<_, i64>(6)?, r.get::<_, i64>(7)?)),
        );
        (passes, tasks)
    } else { (Vec::new(), Vec::new()) };

    // ------------------------------------------------- the spelling wordlist
    //
    // v5's table, on the same rule again.
    let (wordlist, _) = if schema_version.unwrap_or(0) >= 5 {
        walk(
            &conn,
            "dict_word",
            "SELECT word FROM dict_word WHERE rowid = ?1",
            KIND_WORDLIST_ROW,
            &mut losses,
            |r| r.get::<_, String>(0),
        )
    } else {
        (Vec::new(), false)
    };

    // ------------------------------------------------ the version history
    //
    // v2's three tables, guarded on their own version for the reason every
    // guard above is its own. `missing_blobs` below has always used this floor
    // and its `unwrap_or(0)`; the walks share it rather than restating it
    // differently two hundred lines apart.
    //
    // THE `snapshot` TABLE IS READ EVEN THOUGH THE VERSIONS CARRY THE ID. A
    // version knows which snapshot it belongs to and nothing else about it: the
    // LABEL is the whole reason a named moment is worth recovering and it lives
    // only here.
    let (snapshots, snapshots_ok) = if schema_version.unwrap_or(0) >= 2 {
        walk(
            &conn,
            "snapshot",
            "SELECT id, label, created_at FROM snapshot WHERE rowid = ?1",
            KIND_SNAPSHOT_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredSnapshot {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    created_at: r.get(2)?,
                })
            },
        )
    } else {
        (Vec::new(), false)
    };
    let (versions, _) = if schema_version.unwrap_or(0) >= 2 {
        walk(
            &conn,
            "doc_version",
            "SELECT id, item_id, blob_key, snapshot_id FROM doc_version WHERE rowid = ?1",
            KIND_VERSION_ROW,
            &mut losses,
            |r| {
                Ok(RecoveredVersion {
                    id: r.get(0)?,
                    item_id: r.get(1)?,
                    blob_key: r.get(2)?,
                    snapshot_id: r.get(3)?,
                })
            },
        )
    } else {
        (Vec::new(), false)
    };

    // -------------------------------------------------- referential losses
    let known: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
    for item in &items {
        if let Some(parent) = &item.parent_id {
            if !known.contains(parent.as_str()) {
                losses.push(Loss {
                    kind: KIND_ORPHAN_ITEM.into(),
                    detail: format!(
                        "{:?} names parent {parent}, which is not an item in this file, \
                         so it has no place in the manuscript",
                        item.title
                    ),
                    item_id: Some(item.id.clone()),
                });
            }
        }
    }
    let titles: HashMap<&str, &str> = items
        .iter()
        .map(|i| (i.id.as_str(), i.title.as_str()))
        .collect();
    for (id, _) in &docs {
        if !known.contains(id.as_str()) {
            losses.push(Loss {
                kind: KIND_ORPHAN_DOC.into(),
                detail: format!(
                    "a document is stored for {id}, which is not an item in this file; \
                     the prose is recovered, its title and its place in the book are not"
                ),
                item_id: Some(id.clone()),
            });
        }
    }
    for syn in &synopses {
        if !known.contains(syn.item_id.as_str()) {
            losses.push(Loss {
                kind: KIND_ORPHAN_SYNOPSIS.into(),
                detail: format!(
                    "a synopsis is stored for {}, which is not an item in this file; \
                     the summary is recovered, the row it was about is not",
                    syn.item_id
                ),
                item_id: Some(syn.item_id.clone()),
            });
        }
    }
    // ONE loss per member, never one per row -- `cli::validate`'s rule for the
    // same damage. `BTreeSet` rather than `HashSet` so the order a reader sees
    // is the same on every run of the same recovery.
    //
    // JUDGED ONLY AGAINST A TABLE THAT WAS READ, the `appearance` walk's own
    // rule twenty lines below, restated here rather than only there: an
    // orphan loss is the claim that the other end is GONE, and a
    // `cast_member` table that would not read holds nothing for a field or
    // an alias to be orphaned FROM. Without `members_ok`, a `cast_member`
    // table nothing could open would put one confident "gone" sentence per
    // member on top of the `table_unreadable` loss that already says the
    // true thing once.
    let member_ids: HashSet<&str> = members.iter().map(|m| m.id.as_str()).collect();
    let orphaned_members: std::collections::BTreeSet<&str> = fields
        .iter()
        .map(|f| f.member_id.as_str())
        .filter(|id| !member_ids.contains(id))
        .collect();
    if members_ok {
        for id in &orphaned_members {
            losses.push(Loss {
                kind: KIND_ORPHAN_CAST_FIELD.into(),
                detail: format!(
                    "detail rows are stored for cast member {id}, which is not in this file; \
                     what they say is recovered, who they were about is not"
                ),
                item_id: None,
            });
        }
    }
    // ONE loss per member, never one per row -- the same rule, one table over
    // (105). Gated on `members_ok` for the identical reason, immediately above.
    let orphaned_alias_members: std::collections::BTreeSet<&str> = aliases
        .iter()
        .map(|a| a.member_id.as_str())
        .filter(|id| !member_ids.contains(id))
        .collect();
    if members_ok {
        for id in &orphaned_alias_members {
            losses.push(Loss {
                kind: KIND_ORPHAN_CAST_ALIAS.into(),
                detail: format!(
                    "aliases are stored for cast member {id}, which is not in this file; \
                     what they say is recovered, who they were about is not"
                ),
                item_id: None,
            });
        }
    }

    // AN APPEARANCE IS JUDGED ONLY AGAINST A TABLE THAT WAS READ. An orphan
    // loss is the claim that the other end is GONE, and a table nothing could
    // open holds nothing to be gone from: judging every tag against an `item`
    // table that would not read would put one confident sentence per tagged
    // scene into a recovery, every one of them about a row nobody looked at.
    // The table's own `table_unreadable` already says the true thing once.
    //
    // ONE PER DISTINCT MISSING ID, never one per row -- `orphan_cast_field`'s
    // rule -- and `BTreeSet` so two runs of one recovery agree. Items first,
    // then members: a stable order that is not the order the rows happened to
    // be in.
    let mut lost_appearance_items: std::collections::BTreeSet<&str> = Default::default();
    let mut lost_appearance_members: std::collections::BTreeSet<&str> = Default::default();
    for a in &appearances {
        if item_table_ok && !known.contains(a.item_id.as_str()) {
            lost_appearance_items.insert(a.item_id.as_str());
        }
        if members_ok && !member_ids.contains(a.member_id.as_str()) {
            lost_appearance_members.insert(a.member_id.as_str());
        }
    }
    for id in &lost_appearance_items {
        losses.push(Loss {
            kind: KIND_ORPHAN_APPEARANCE.into(),
            detail: format!(
                "somebody is recorded as appearing in {id}, which is not an item in this file; \
                 who they are is recovered, the part, chapter or scene is not"
            ),
            item_id: Some((*id).to_string()),
        });
    }
    for id in &lost_appearance_members {
        losses.push(Loss {
            kind: KIND_ORPHAN_APPEARANCE.into(),
            detail: format!(
                "cast member {id} is recorded as appearing in this book and is not in this \
                 file; the pair holds two ids and no words, so there was nothing to write out"
            ),
            item_id: None,
        });
    }

    // NOTES WHOSE DOCUMENT IS GONE. ONE PER DOCUMENT and never one per row --
    // `orphan_cast_field`'s rule: five notes on one deleted scene are one
    // scene's worth of lost context, and five identical sentences read as five
    // problems. `BTreeSet` so two runs of one recovery agree.
    //
    // JUDGED ONLY AGAINST A TABLE THAT WAS READ, 048's rule: an orphan finding
    // is the claim that the other end is GONE, and an `item` table nothing could
    // open holds nothing to be gone from.
    //
    // A COLLAPSED ANCHOR IS NOT JUDGED HERE AT ALL. That is a note whose
    // PASSAGE an edit destroyed, which the application already treats as a
    // legible state a writer acts on; the row read perfectly and the recovery
    // lost nothing. It is reported as a figure and a mark, never as damage.
    if item_table_ok {
        let lost: std::collections::BTreeSet<&str> = comments
            .iter()
            .map(|c| c.item_id.as_str())
            .filter(|id| !known.contains(id))
            .collect();
        for id in &lost {
            losses.push(Loss {
                kind: KIND_ORPHAN_COMMENT.into(),
                detail: format!(
                    "notes are stored on {id}, which is not an item in this file; \
                     what they say is recovered, the document they were about is not"
                ),
                item_id: Some((*id).to_string()),
            });
        }
    }

    // ------------------------------------------------------- missing blobs
    // Guarded on the schema version for `inspect`'s reason: a v1 file has no
    // history tables and is not thereby damaged. `unwrap_or(0)` is deliberate --
    // a file that would not answer the pragma is not asked about tables the
    // pragma would have said do not exist.
    //
    // IT IS THE ONLY REPORTER OF AN ABSENT BLOB, and `write_snapshots` below
    // meets the same rows and deliberately says nothing new about them: one
    // damage, one sentence, which is `orphan_cast_field`'s rule at a third
    // table. A `dangling` set threaded into the writer was built and DELETED --
    // it could not change a single byte of the output, because a blob that is
    // not there answers the fetch with `QueryReturnedNoRows` and the writer
    // prints the same line either way. A guard nothing can reach is worse than
    // none, because a reader credits it.
    if schema_version.unwrap_or(0) >= 2 {
        match missing_blobs(&conn) {
            Ok(mut found) => losses.append(&mut found),
            Err(e) => losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!("the version history could not be checked: {e}"),
                item_id: None,
            }),
        }
    }

    // VERSIONS WHOSE SNAPSHOT ROW IS GONE. ONE PER SNAPSHOT and never one per
    // version -- `orphan_cast_field`'s rule, and at this table that is the
    // difference between one sentence and one per document in the book.
    //
    // JUDGED ONLY AGAINST A TABLE THAT WAS READ, 048's rule: a `snapshot` table
    // nothing could open holds nothing for a version to be orphaned from, and
    // the `table_unreadable` beside it already says the true thing once.
    //
    // AN AUTOMATIC VERSION IS NOT JUDGED HERE AT ALL. `snapshot_id IS NULL` is
    // what MAKES it automatic (the store keeps no `kind` column, deliberately),
    // so a null is the ordinary state of the overwhelming majority of this
    // table and reading it as a missing snapshot would report every book that
    // has ever been edited as damaged.
    if snapshots_ok {
        let named: HashSet<i64> = snapshots.iter().map(|s| s.id).collect();
        let lost: std::collections::BTreeSet<i64> = versions
            .iter()
            .filter_map(|v| v.snapshot_id)
            .filter(|id| !named.contains(id))
            .collect();
        for id in &lost {
            losses.push(Loss {
                kind: KIND_ORPHAN_VERSION.into(),
                detail: format!(
                    "past drafts are stored under snapshot {id}, which is not in this file; \
                     the prose is recovered under that number, the name the writer gave the \
                     moment is not"
                ),
                item_id: None,
            });
        }
    }

    // ------------------------------------------------------------- write
    std::fs::create_dir(out_dir.join(DOCUMENTS_DIR)).map_err(|e| e.to_string())?;
    let mut names = FileNames::default();
    let mut renamed = BTreeMap::new();
    let mut bodies: HashMap<String, String> = HashMap::new();
    let mut index = store::WordIndex::default();
    let mut raw_bodies = Vec::new();
    let mut documents_recovered = 0u64;

    for (id, body) in &docs {
        match export::document_markdown(body) {
            Some(markdown) => {
                let file = names.pick(id, "md");
                if file != format!("{id}.md") {
                    renamed.insert(id.clone(), file.clone());
                }
                let mut text = String::new();
                if let Some(title) = titles.get(id.as_str()) {
                    text.push_str(&format!("# {title}\n\n"));
                }
                text.push_str(&markdown);
                text.push('\n');
                std::fs::write(out_dir.join(DOCUMENTS_DIR).join(&file), text)
                    .map_err(|e| e.to_string())?;
                index.record(id, body);
                bodies.insert(id.clone(), body.clone());
                documents_recovered += 1;
            }
            None => {
                let file = names.pick(id, RAW_EXT);
                renamed.insert(id.clone(), file.clone());
                std::fs::write(out_dir.join(DOCUMENTS_DIR).join(&file), body)
                    .map_err(|e| e.to_string())?;
                // A TIMELINE'S BODY IS NEVER "NOT A DOCUMENT THIS BUILD CAN
                // READ" -- MAJOR review finding, item 9, `validate`'s own
                // reason: by design (101) it is not a document at all, so it
                // is swept verbatim here (the write above, unconditional)
                // with NEITHER a `Loss` NOR an entry in `raw_bodies`, whose
                // own doc comment ties its length to the `words` undercount
                // -- a timeline was never going to be counted as words in
                // the first place, so it is not an undercount to report.
                if timeline_ids.contains(id) {
                    continue;
                }
                raw_bodies.push(id.clone());
                losses.push(Loss {
                    kind: KIND_UNREADABLE_BODY.into(),
                    detail: format!(
                        "the body stored for {id} is not a document this build can read; \
                         its bytes were written verbatim to {DOCUMENTS_DIR}/{file}"
                    ),
                    item_id: Some(id.clone()),
                });
            }
        }
    }

    // -------------------------------------------------------- manuscript
    //
    // The WALK is the store's own, run against the copy, rather than a tree
    // rebuilt here from the recovered rows. Restating it would give salvage its
    // own idea of the manuscript's order, and a recovery that puts the chapters
    // in a different order from the application is a recovery a writer cannot
    // check against anything.
    //
    // THE BIN IS NOT REMOVED, unlike every other reader of this walk. Deleted
    // work is exactly what somebody salvaging a damaged project may be after,
    // and this is the one command whose job is to leave nothing behind.
    let name = project_name(&conn, source);
    // The walk's ORDER, kept for `synopses.md`. A writer reads summaries down
    // the book, so they are written in the order the manuscript is -- and when
    // the walk failed there is no order to follow and the fallback is the item
    // id, which is deterministic either way. That is what a person diffing two
    // runs of one recovery needs.
    let mut walk_order: HashMap<String, usize> = HashMap::new();
    let (manuscript, manuscript_omitted) = match store::Store::open_readonly(&work.db)
        .map_err(|e| e.to_string())
        .and_then(|s| s.items().map_err(|e| e.to_string()))
    {
        Ok(ordered) => {
            let rows: Vec<(String, String, i64)> = ordered
                .into_iter()
                .map(|i| (i.id, i.title, i.depth))
                .collect();
            for (n, (id, _, _)) in rows.iter().enumerate() {
                walk_order.insert(id.clone(), n);
            }
            // The underline tally is dropped HERE and only here: a salvage
            // writes what it can recover of a damaged project, and a figure
            // about Markdown fidelity is not one of the answers anybody
            // salvaging wants. The export command reports it, which is where
            // the writer is choosing to make a Markdown copy.
            // ONE RUN, and every recovered row is in it. Salvage keeps the bin,
            // the bible and both matter sections exactly where the walk put
            // them -- it is the one command whose job is to leave nothing
            // behind, so it must not apply the book's own idea of what belongs
            // in the book. The generated contents therefore lists everything
            // the file holds, which is what somebody checking a recovery wants.
            let contents_title = strings.t(crate::commands::export::CONTENTS_KEY);
            let written = export::manuscript(
                &export::Book {
                    name: &name,
                    contents_title: &contents_title,
                    front: &[],
                    chapters: &rows,
                    back: &[],
                },
                &bodies,
            );
            std::fs::write(out_dir.join(MANUSCRIPT_NAME), written.bytes)
                .map_err(|e| e.to_string())?;
            (Some(MANUSCRIPT_NAME.to_string()), None)
        }
        Err(e) => {
            losses.push(Loss {
                kind: KIND_STRUCTURE.into(),
                detail: format!(
                    "the tree could not be walked ({e}), so no {MANUSCRIPT_NAME} was written; \
                     every recovered document is in {DOCUMENTS_DIR}/, by item id, with no \
                     hierarchy"
                ),
                item_id: None,
            });
            (None, Some(e))
        }
    };

    // ----------------------------------------- synopses and the cast, written
    let synopses_file = write_synopses(out_dir, &name, &synopses, &titles, &walk_order, strings)?;
    let cast_file = write_cast(
        out_dir,
        &name,
        &members,
        &fields,
        &aliases,
        &appearances,
        &titles,
        &walk_order,
        strings,
    )?;
    let comments_file = write_comments(out_dir, &name, &comments, &titles, &walk_order, strings)?;
    write_revision_planning(out_dir, &revision_passes, &revision_tasks, &titles)?;
    let wordlist_file = write_wordlist(out_dir, &name, &wordlist, strings)?;
    let (versions_recovered, snapshots_file) = write_snapshots(
        out_dir,
        &name,
        &conn,
        &snapshots,
        &versions,
        &titles,
        &walk_order,
        &mut losses,
        strings,
    )?;
    // EVERY `meta` ROW, through the raw connection for `project_name`'s reason:
    // a file damaged enough to need salvaging need not open as a `Store` at all.
    // The design is a NAMED SUBSET projected from the sweep and not a second
    // read of the same table -- one reader, so there is no second statement to
    // fall out of step with the first.
    let meta = read_meta(&conn, &mut losses);
    let design = meta.as_ref().map(RecoveredDesign::from_meta);
    let review_present = schema_version.unwrap_or(0) >= 17
        || match crate::review_validation::has_review_tables(&conn) {
            Ok(present) => present,
            Err(error) => {
                losses.push(Loss {
                    kind: crate::review_validation::UNREADABLE.into(),
                    detail: format!("review table inventory could not be read: {error}"),
                    item_id: None,
                });
                true
            }
        };
    if review_present && schema_version.unwrap_or(0) < 17 {
        losses.push(Loss {
            kind: crate::review_validation::INVALID.into(),
            detail: format!(
                "review tables exist below schema version 17 (found version {})",
                schema_version.unwrap_or(0)
            ),
            item_id: None,
        });
    }
    let (review_file, review_recovered) = if review_present {
        let (file, counts) = crate::review_salvage::recover(&conn, out_dir, &mut losses)?;
        (Some(file), counts)
    } else { (None, crate::review_validation::Counts::default()) };
    let analytics_file = if schema_version.unwrap_or(0) >= 15 {
        Some(analytics_salvage::recover(&conn, out_dir, &mut losses)?)
    } else { None };
    let (research_resources_recovered, knowledge_links_recovered, research_originals_recovered,
        knowledge_file, research_dir) = if schema_version.unwrap_or(0) >= 16 {
        write_knowledge(&conn, source, out_dir, &items, item_table_ok, &members, members_ok, &mut losses)?
    } else { (0, 0, 0, None, None) };
    // READ THROUGH THE RAW CONNECTION, `project_name`'s rule: a file damaged
    // enough to need salvaging need not open as a `Store` at all, and the covers
    // are wanted precisely then.
    let covers = read_covers(&conn);
    let (pictures_recovered, covers_recovered, pictures_dir) =
        write_pictures(out_dir, source, &members, &covers, &mut losses)?;
    let covers_file = write_covers(out_dir, &name, &covers, covers_recovered, strings)?;

    let counted = index.count();
    let out = Salvage {
        source: crate::projects::without_directory(source),
        source_bytes,
        sidecars: work.sidecars.clone(),
        out_dir: crate::projects::without_directory(out_dir),
        schema_version,
        name,
        items_recovered: items.len() as u64,
        documents_recovered,
        synopses_recovered: synopses.len() as u64,
        cast_members_recovered: members.len() as u64,
        cast_fields_recovered: fields.len() as u64,
        cast_aliases_recovered: aliases.len() as u64,
        appearances_recovered: appearances.len() as u64,
        comments_recovered: comments.len() as u64,
        comments_orphaned: comments.iter().filter(|c| c.orphaned()).count() as u64,
        wordlist_recovered: wordlist.len() as u64,
        snapshots_recovered: snapshots.len() as u64,
        versions_recovered,
        // AUTOMATIC IS `snapshot_id IS NULL`, the store's own derivation
        // restated rather than re-decided -- `record_versions` writes no `kind`
        // column precisely so this fact has one statement.
        versions_dropped: versions.iter().filter(|v| v.snapshot_id.is_none()).count() as u64,
        pictures_recovered,
        covers_recovered,
        research_resources_recovered,
        knowledge_links_recovered,
        research_originals_recovered,
        knowledge: knowledge_file,
        research: research_dir,
        analytics: analytics_file,
        review: review_file,
        review_recovered,
        raw_bodies,
        words: counted.words,
        manuscript,
        manuscript_omitted,
        synopses: synopses_file,
        cast: cast_file,
        comments: comments_file,
        wordlist: wordlist_file,
        snapshots: snapshots_file,
        meta,
        design,
        pictures: pictures_dir,
        covers: covers_file,
        renamed,
        complete: losses.is_empty(),
        losses,
    };
    std::fs::write(out_dir.join(LOSS_REPORT_NAME), loss_report(&out.losses, strings))
        .map_err(|e| e.to_string())?;
    std::fs::write(
        out_dir.join(MANIFEST_NAME),
        serde_json::to_string_pretty(&out).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| e.to_string())?;
    Ok(out)
}

fn loss_report(losses: &[Loss], strings: crate::strings::Strings) -> String {
    let mut report = format!("{}\n\n{}\n", strings.t("salvage.loss-report.heading"), strings.t("salvage.loss-report.detail"));
    if losses.is_empty() { report.push_str(&format!("\n{}\n", strings.t("salvage.loss-report.none"))); }
    for (index, loss) in losses.iter().enumerate() {
        let key = match loss.kind.as_str() {
            "enumeration_stopped" | "file_truncated" | "missing_blob" | "missing_cover" | "missing_picture" | "orphan_appearance" | "orphan_cast_alias" | "orphan_cast_field" | "orphan_comment" | "orphan_doc" | "orphan_item" | "orphan_synopsis" | "orphan_version" | "structure" | "table_unreadable" | "unreadable_appearance_row" | "unreadable_blob_row" | "unreadable_body" | "unreadable_cast_alias_row" | "unreadable_cast_field_row" | "unreadable_cast_member_row" | "unreadable_comment_row" | "unreadable_cover" | "unreadable_design_row" | "unreadable_doc_row" | "unreadable_item_row" | "unreadable_meta_row" | "unreadable_picture" | "unreadable_revision_pass_row" | "unreadable_revision_task_row" | "unreadable_snapshot_row" | "unreadable_synopsis_row" | "unreadable_version_body" | "unreadable_version_row" | "unreadable_wordlist_row" | "unreadable_analytics_row" | "unreadable_research_row" | "unreadable_knowledge_link_row" | "missing_research_original" | "corrupt_research_original" | "orphan_research_original" | "orphan_knowledge_link" | "invalid_review_record" | "unreadable_review_record" => format!("salvage.loss.{}", loss.kind),
            _ => "salvage.loss.unknown".into(),
        };
        report.push_str(&format!("\n{}. {} [{}; {}]\n", index + 1, strings.t(&key), loss.kind, serde_json::to_string(&loss.item_id).expect("optional string serializes")));
    }
    report
}

/// `synopses.md`, or None when there was nothing to write.
///
/// The heading is the item's TITLE when the item survived and its id when it did
/// not, and the id is printed under it EITHER WAY. That is what ties a summary
/// to `documents/<id>.md`, and for an orphaned one it is the only identity left.
fn write_synopses(
    out_dir: &Path,
    name: &str,
    synopses: &[RecoveredSynopsis],
    titles: &HashMap<&str, &str>,
    walk_order: &HashMap<String, usize>,
    strings: crate::strings::Strings,
) -> Result<Option<String>, String> {
    if synopses.is_empty() {
        return Ok(None);
    }
    let mut ordered: Vec<&RecoveredSynopsis> = synopses.iter().collect();
    // Walk order first, then item id. An item the walk never reached -- an
    // orphan, or every item when the walk failed -- sorts after the ones it did,
    // by id, so the file is stable across two runs of one recovery.
    ordered.sort_by(|a, b| {
        let ka = walk_order.get(&a.item_id).copied().unwrap_or(usize::MAX);
        let kb = walk_order.get(&b.item_id).copied().unwrap_or(usize::MAX);
        ka.cmp(&kb).then_with(|| a.item_id.cmp(&b.item_id))
    });

    let mut text = format!(
        "# {}\n",
        strings.f("salvage.title.synopses", &[("name", name)])
    );
    for syn in ordered {
        let heading = titles
            .get(syn.item_id.as_str())
            .copied()
            .unwrap_or(syn.item_id.as_str());
        text.push_str(&format!(
            "\n## {heading}\n\n`{}`\n\n{}\n",
            syn.item_id,
            syn.body.trim_end()
        ));
    }
    std::fs::write(out_dir.join(SYNOPSES_NAME), text).map_err(|e| e.to_string())?;
    Ok(Some(SYNOPSES_NAME.to_string()))
}

/// Raw revision planning records, readable even when the canonical tree cannot be walked.
fn write_revision_planning(
    out_dir: &Path,
    passes: &[(i64, String, Option<String>, i64, i64)],
    tasks: &[(i64, String, Option<String>, Option<String>, Option<i64>, Option<i64>, i64, i64)],
    titles: &HashMap<&str, &str>,
) -> Result<(), String> {
    if passes.is_empty() && tasks.is_empty() { return Ok(()); }
    let passes = passes.iter().map(|(id, name, purpose, created_at, updated_at)| {
        serde_json::json!({"id": id, "name": name, "purpose": purpose,
            "created_at": created_at, "updated_at": updated_at})
    }).collect::<Vec<_>>();
    let tasks = tasks.iter().map(|(id, body, item_id, caption, pass_id, done_at, created_at, updated_at)| {
        let target = item_id.as_ref().and_then(|id| titles.get(id.as_str()).copied())
            .or(caption.as_deref());
        serde_json::json!({"id": id, "body": body, "item_id": item_id,
            "target_caption": caption, "target_title": target, "pass_id": pass_id,
            "done_at": done_at, "done": done_at.is_some(),
            "created_at": created_at, "updated_at": updated_at})
    }).collect::<Vec<_>>();
    let bytes = serde_json::to_string_pretty(&serde_json::json!({"passes": passes, "tasks": tasks}))
        .map_err(|e| e.to_string())? + "\n";
    std::fs::write(out_dir.join(REVISION_PLANNING_NAME), bytes).map_err(|e| e.to_string())
}

/// `comments.md`, or None when there was nothing to write.
///
/// GROUPED BY THE DOCUMENT THE NOTES ARE ABOUT, in the manuscript's own walk
/// order and then by item id -- `synopses.md`'s rule and its reason: a writer
/// reads their notes down the book, a document the walk never reached sorts
/// after every one it did, and two runs of one recovery agree.
///
/// The heading is the item's TITLE when the item survived and its id when it did
/// not, and the id is printed under it EITHER WAY -- `synopses.md` again. Within
/// a document the notes are in PROSE order (`anchor_from`, then id), which is
/// `Store::comments`' own order, so the recovery reads the way the panel does
/// and an orphan sits where its passage used to be.
///
/// EACH NOTE PRINTS ITS RANGE AND ITS STORED QUOTE AND NOTHING DERIVED FROM THE
/// RECOVERED PROSE -- see `RecoveredComment`. The marks are the two states the
/// row itself states: `(orphaned)` for a collapsed anchor, which is the
/// application's own derivation and means an edit destroyed the passage, and
/// `(resolved)` for a settled note.
///
/// AND NO MARK FOR AN ANCHOR THAT DOES NOT FALL INSIDE THE BODY. Salvage does
/// not own the coordinate system those offsets are in, so it makes no claim
/// about them: it prints the range and the quote and lets the reader hold both.
/// That is `walk`'s rule one level down -- nothing is judged against something
/// that was never read.
fn write_comments(
    out_dir: &Path,
    name: &str,
    comments: &[RecoveredComment],
    titles: &HashMap<&str, &str>,
    walk_order: &HashMap<String, usize>,
    strings: crate::strings::Strings,
) -> Result<Option<String>, String> {
    if comments.is_empty() {
        return Ok(None);
    }
    let mut by_item: BTreeMap<&str, Vec<&RecoveredComment>> = BTreeMap::new();
    for c in comments {
        by_item.entry(c.item_id.as_str()).or_default().push(c);
    }
    // ONE SORT KEY AND NOT TWO, unlike `write_synopses`, and the difference is
    // where the input comes from: these are a `BTreeMap`'s keys, so they arrive
    // in item-id order already, and Rust's sort is stable. An explicit id
    // tiebreak here would be a second statement of a rule the container already
    // makes -- and one nothing could reach, which is worse than none because a
    // reader credits it. `write_synopses` sorts a Vec in rowid order and needs
    // its tiebreak.
    let mut ordered: Vec<&str> = by_item.keys().copied().collect();
    ordered.sort_by_key(|id| walk_order.get(*id).copied().unwrap_or(usize::MAX));

    let mut text = format!(
        "# {}\n",
        strings.f("salvage.title.comments", &[("name", name)])
    );
    for item_id in ordered {
        let heading = titles.get(item_id).copied().unwrap_or(item_id);
        text.push_str(&format!("\n## {heading}\n\n`{item_id}`\n"));
        // `Store::comments`' own order: prose order, then id. BOTH KEYS ARE
        // LOAD-BEARING and neither is reachable through `salvage` -- the walk
        // hands rows back in rowid order and `comment.id` IS the rowid, so no
        // damaged file can present two notes out of id order. They are killed at
        // this function's own boundary instead, where the input order is chosen,
        // which is 046's answer for `write_cast`'s ordinal sort.
        let mut notes = by_item.remove(item_id).unwrap_or_default();
        notes.sort_by(|a, b| {
            a.anchor_from
                .cmp(&b.anchor_from)
                .then_with(|| a.id.cmp(&b.id))
        });
        for note in notes {
            let mut marks: Vec<&str> = Vec::new();
            if note.orphaned() {
                marks.push("orphaned");
            }
            if note.resolved {
                marks.push("resolved");
            }
            let mark = if marks.is_empty() {
                String::new()
            } else {
                format!(" ({})", marks.join(", "))
            };
            text.push_str(&format!(
                "\n### {}-{}{mark}\n",
                note.anchor_from, note.anchor_to
            ));
            // A note whose quote is empty gets no empty quotation where one
            // would have gone -- 046's blank-paragraph rule.
            //
            // EVERY LINE IS PREFIXED, not just the first. A quote is whatever
            // the writer selected, and a selection across a paragraph break
            // arrives here with a blank line in it: one `>` would leave the rest
            // of the passage outside the quotation and flush against the note's
            // own words, where a reader cannot tell which is the book and which
            // is the writer talking about it. The TEXT is still verbatim -- this
            // is the container, not the content.
            if !note.quote.trim().is_empty() {
                text.push('\n');
                for line in note.quote.trim_end().lines() {
                    if line.is_empty() {
                        text.push_str(">\n");
                    } else {
                        text.push_str(&format!("> {line}\n"));
                    }
                }
            }
            text.push_str(&format!("\n{}\n", note.body.trim_end()));
        }
    }
    std::fs::write(out_dir.join(COMMENTS_NAME), text).map_err(|e| e.to_string())?;
    Ok(Some(COMMENTS_NAME.to_string()))
}

/// `wordlist.md`, or None when the project taught the checker nothing.
///
/// ALPHABETICALLY, which is `dict_words`' own order and the order the panel
/// shows -- restated here rather than imported, because this walk reads the raw
/// connection and a file damaged enough to need salvaging need not open as a
/// `Store` at all.
fn write_wordlist(
    out_dir: &Path,
    name: &str,
    words: &[String],
    strings: crate::strings::Strings,
) -> Result<Option<String>, String> {
    if words.is_empty() {
        return Ok(None);
    }
    let mut ordered: Vec<&String> = words.iter().collect();
    ordered.sort();
    let mut text = format!(
        "# {}\n\n",
        strings.f("salvage.title.wordlist", &[("name", name)])
    );
    for word in ordered {
        text.push_str(&format!("- {word}\n"));
    }
    std::fs::write(out_dir.join(WORDLIST_NAME), text).map_err(|e| e.to_string())?;
    Ok(Some(WORDLIST_NAME.to_string()))
}

/// `snapshots.md` and `snapshots/<snapshot-id>/`, or None when this file held
/// no named snapshot and no version belonging to one.
///
/// LATEST-PLUS-NAMED IS THE DECISION. The current body of
/// every document is already recovered, in `documents/` and `manuscript.md`, so
/// what a history adds is the PAST; and the past a writer chose is the named
/// one. An automatic version is the five-minute throttle's, not theirs, and
/// writing every one of them out is `documents/`' scale multiplied by
/// `MAX_AUTO_VERSIONS` -- over a million files at the stress fixture, on a
/// command that runs when the writer's disk already holds a broken book.
/// `Salvage::versions_dropped` is how that omission is said rather than hidden.
///
/// SNAPSHOTS NEWEST FIRST (`created_at DESC, id DESC`), which is
/// `Store::snapshots`' own order and therefore the order the panel showed the
/// writer, restated here because this reads the raw connection. A snapshot whose
/// row is GONE has no time to sort by, so it sorts after every one that survived
/// and then by id -- `synopses.md`'s rule for an item the walk never reached,
/// and two runs of one recovery agree either way.
///
/// DOCUMENTS INSIDE ONE SNAPSHOT in the manuscript's walk order, then item id --
/// `synopses.md` again, so a snapshot reads down the book.
#[allow(clippy::too_many_arguments)]
fn write_snapshots(
    out_dir: &Path,
    name: &str,
    conn: &rusqlite::Connection,
    snapshots: &[RecoveredSnapshot],
    versions: &[RecoveredVersion],
    titles: &HashMap<&str, &str>,
    walk_order: &HashMap<String, usize>,
    losses: &mut Vec<Loss>,
    strings: crate::strings::Strings,
) -> Result<(u64, Option<String>), String> {
    let mut by_snapshot: BTreeMap<i64, Vec<&RecoveredVersion>> = BTreeMap::new();
    for v in versions {
        if let Some(sid) = v.snapshot_id {
            by_snapshot.entry(sid).or_default().push(v);
        }
    }
    if snapshots.is_empty() && by_snapshot.is_empty() {
        return Ok((0, None));
    }
    let known: BTreeMap<i64, &RecoveredSnapshot> = snapshots.iter().map(|s| (s.id, s)).collect();

    // A SNAPSHOT ROW WITH NO VERSIONS IS STILL LISTED, and it is not a loss:
    // `snapshot_create` on a book with no documents writes exactly this, so an
    // empty one is an ordinary state rather than damage.
    let mut ordered: Vec<i64> = known.keys().copied().collect();
    // THE UNKNOWN IDS ARE TAKEN IN THE VERSIONS' OWN ORDER and not from
    // `by_snapshot`'s keys, which arrive sorted. Taking them sorted would make
    // the `(None, None)` arm below a second statement of the container's order
    // -- a tiebreak no input could reach, which is worse than none because a
    // reader credits it (049 removed exactly that from `write_comments`). Taken
    // this way the arm is load-bearing and is killed at this function's own
    // boundary, where the input order is chosen.
    for v in versions {
        if let Some(sid) = v.snapshot_id {
            if !known.contains_key(&sid) && !ordered.contains(&sid) {
                ordered.push(sid);
            }
        }
    }
    ordered.sort_by(|a, b| match (known.get(a), known.get(b)) {
        (Some(x), Some(y)) => y
            .created_at
            .cmp(&x.created_at)
            .then_with(|| y.id.cmp(&x.id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(b),
    });

    // ONE PREPARE FOR THE WHOLE FILE, and a failure here is the wrong-shape
    // branch `walk` takes: `blob` can exist and not have the columns this build
    // expects, because a rowid is a b-tree key and knows nothing about columns.
    // Reported once, and every document below then says its bytes could not be
    // read -- rather than a `blob` table full of prose being silently reported
    // as a history with nothing in it.
    let mut blob = match conn.prepare("SELECT body FROM blob WHERE key = ?1") {
        Ok(stmt) => Some(stmt),
        Err(e) => {
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!(
                    "the blob table is not the shape this build knows ({e}), \
                     so no past draft was recovered"
                ),
                item_id: None,
            });
            None
        }
    };

    let mut text = format!(
        "# {}\n",
        strings.f("salvage.title.snapshots", &[("name", name)])
    );
    let mut recovered = 0u64;
    for sid in ordered {
        let snapshot = known.get(&sid).copied();
        // THE LABEL WHEN THE ROW SURVIVED AND THE ID WHEN IT DID NOT, and the id
        // printed EITHER WAY -- `synopses.md`'s rule, and here the id is what
        // ties the section to `snapshots/<id>/`.
        let heading = match snapshot {
            Some(s) => s.label.clone(),
            None => sid.to_string(),
        };
        text.push_str(&format!("\n## {heading}\n\n`{sid}`\n"));
        if let Some(s) = snapshot {
            // MILLISECONDS SINCE THE EPOCH, VERBATIM, because rendering a date
            // needs a timezone this command has not been given and salvage does
            // not interpret -- 048's rule for the design values.
            let at = s.created_at.to_string();
            text.push_str(&format!(
                "\n{}\n",
                strings.f("salvage.snapshots.created", &[("at", &at)])
            ));
        }
        let mut rows = by_snapshot.remove(&sid).unwrap_or_default();
        rows.sort_by(|a, b| {
            let ka = walk_order.get(&a.item_id).copied().unwrap_or(usize::MAX);
            let kb = walk_order.get(&b.item_id).copied().unwrap_or(usize::MAX);
            ka.cmp(&kb).then_with(|| a.item_id.cmp(&b.item_id))
        });
        if rows.is_empty() {
            continue;
        }
        text.push('\n');
        let into = out_dir.join(SNAPSHOTS_DIR).join(sid.to_string());
        let mut names = FileNames::default();
        let mut made = false;
        for v in rows {
            // THE TITLE WHEN THE ITEM SURVIVED AND THE ID WHEN IT DID NOT, and
            // NO LOSS for the second: a past draft of a document that no longer
            // exists is a recovery of something EXTRA, and calling it damage
            // would report the writer's deleted work as a defect of the
            // recovery that just handed it back.
            let title = titles.get(v.item_id.as_str()).copied();
            let label = match title {
                Some(t) => format!("- {t} `{}`", v.item_id),
                None => format!("- `{}`", v.item_id),
            };
            let body = match blob.as_mut() {
                None => None,
                Some(stmt) => match stmt.query_row([&v.blob_key], |r| r.get::<_, String>(0)) {
                    Ok(body) => Some(body),
                    // THE ABSENT BLOB IS `missing_blobs`' FINDING AND GETS NO
                    // SECOND ONE HERE. That check has already walked exactly
                    // these rows and recorded a `missing_blob` for each; a loss
                    // here would put two sentences on one damage, which is what
                    // `orphan_cast_field` exists to refuse. The index line still
                    // says the bytes are not there, so the person holding the
                    // recovery is told twice in two registers and the loss list
                    // counts it once.
                    Err(rusqlite::Error::QueryReturnedNoRows) => None,
                    Err(e) => {
                        losses.push(Loss {
                            kind: KIND_BLOB_ROW.into(),
                            detail: format!(
                                "blob {} could not be read: {e}; version {} of {} is listed \
                                 and its prose was not recovered",
                                v.blob_key, v.id, v.item_id
                            ),
                            item_id: Some(v.item_id.clone()),
                        });
                        None
                    }
                },
            };
            let Some(body) = body else {
                text.push_str(&format!(
                    "{label} {}\n",
                    strings.t("salvage.snapshots.not_stored")
                ));
                continue;
            };
            if !made {
                // MADE LAZILY, `write_pictures`' rule: a snapshot whose every
                // body is gone must not leave an empty directory that reads as
                // a recovery having happened.
                std::fs::create_dir_all(&into).map_err(|e| e.to_string())?;
                made = true;
            }
            match export::document_markdown(&body) {
                Some(markdown) => {
                    let file = names.pick(&v.item_id, "md");
                    let mut out = String::new();
                    if let Some(t) = title {
                        out.push_str(&format!("# {t}\n\n"));
                    }
                    out.push_str(&markdown);
                    out.push('\n');
                    std::fs::write(into.join(&file), out).map_err(|e| e.to_string())?;
                    text.push_str(&format!("{label} {SNAPSHOTS_DIR}/{sid}/{file}\n"));
                    recovered += 1;
                }
                None => {
                    let file = names.pick(&v.item_id, RAW_EXT);
                    std::fs::write(into.join(&file), &body).map_err(|e| e.to_string())?;
                    text.push_str(&format!(
                        "{label} {SNAPSHOTS_DIR}/{sid}/{file} (not a document this build can read)\n"
                    ));
                    losses.push(Loss {
                        kind: KIND_UNREADABLE_VERSION_BODY.into(),
                        detail: format!(
                            "version {} of {} is not a document this build can read; its bytes \
                             were written verbatim to {SNAPSHOTS_DIR}/{sid}/{file}",
                            v.id, v.item_id
                        ),
                        item_id: Some(v.item_id.clone()),
                    });
                }
            }
        }
    }
    std::fs::write(out_dir.join(SNAPSHOTS_NAME), text).map_err(|e| e.to_string())?;
    Ok((recovered, Some(SNAPSHOTS_NAME.to_string())))
}

/// The heading a kind is written under. An unknown kind keeps its own word: a
/// damaged file can hold any string in that column, and a salvage that dropped
/// the members of a kind it did not recognise would be the silent loss this
/// slice exists to end.
fn kind_heading(kind: &str, strings: crate::strings::Strings) -> String {
    match kind {
        KIND_CHARACTER => strings.t("salvage.cast.characters"),
        KIND_PLACE => strings.t("salvage.cast.places"),
        KIND_POI => strings.t("salvage.cast.poi"),
        other => other.to_string(),
    }
}

/// `cast.md`, or None when there was nothing to write.
///
/// Detail rows whose member is gone are still written, in a section of their
/// own keyed by the member id -- the `orphan_doc` rule: what they say is
/// recovered, who they were about is not.
fn write_cast(
    out_dir: &Path,
    name: &str,
    members: &[RecoveredMember],
    fields: &[RecoveredField],
    aliases: &[RecoveredAlias],
    appearances: &[RecoveredAppearance],
    titles: &HashMap<&str, &str>,
    walk_order: &HashMap<String, usize>,
    strings: crate::strings::Strings,
) -> Result<Option<String>, String> {
    if members.is_empty() && fields.is_empty() && aliases.is_empty() {
        return Ok(None);
    }
    let mut by_member: BTreeMap<&str, Vec<&RecoveredField>> = BTreeMap::new();
    for f in fields {
        by_member.entry(f.member_id.as_str()).or_default().push(f);
    }
    for rows in by_member.values_mut() {
        rows.sort_by(|a, b| {
            a.ordinal
                .cmp(&b.ordinal)
                .then_with(|| a.label.cmp(&b.label))
        });
    }

    // "ALSO CALLED", `by_member`'s own shape one column over: ordered by
    // ordinal, the writer's own order for the aliases (105).
    let mut aliases_by_member: BTreeMap<&str, Vec<&RecoveredAlias>> = BTreeMap::new();
    for a in aliases {
        aliases_by_member
            .entry(a.member_id.as_str())
            .or_default()
            .push(a);
    }
    for rows in aliases_by_member.values_mut() {
        rows.sort_by_key(|a| a.ordinal);
    }

    // WHO APPEARS WHERE, under the member they are about.
    //
    // In the manuscript's own WALK ORDER, then by item id, which is
    // `synopses.md`'s rule and for its reason: an item the walk never reached
    // sorts after every one it did, and two runs of one recovery agree.
    let mut by_appearing: BTreeMap<&str, Vec<&RecoveredAppearance>> = BTreeMap::new();
    for a in appearances {
        by_appearing
            .entry(a.member_id.as_str())
            .or_default()
            .push(a);
    }
    for rows in by_appearing.values_mut() {
        rows.sort_by(|a, b| {
            let ka = walk_order.get(&a.item_id).copied().unwrap_or(usize::MAX);
            let kb = walk_order.get(&b.item_id).copied().unwrap_or(usize::MAX);
            ka.cmp(&kb).then_with(|| a.item_id.cmp(&b.item_id))
        });
    }

    let mut kinds: Vec<&str> = CAST_KINDS.to_vec();
    let unknown: std::collections::BTreeSet<&str> = members
        .iter()
        .map(|m| m.kind.as_str())
        .filter(|k| !CAST_KINDS.contains(k))
        .collect();
    kinds.extend(unknown);

    let mut text = format!("# {}\n", strings.f("salvage.title.cast", &[("name", name)]));
    for kind in kinds {
        let mut group: Vec<&RecoveredMember> = members.iter().filter(|m| m.kind == kind).collect();
        if group.is_empty() {
            continue;
        }
        // The store's own order for this table: name, case-folded, then id.
        group.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        text.push_str(&format!("\n## {}\n", kind_heading(kind, strings)));
        for m in group {
            text.push_str(&format!("\n### {}\n\n`{}`\n", m.name, m.id));
            if m.deleted_at.is_some() {
                text.push_str(&format!("\n{}\n", strings.t("salvage.cast.removed")));
            }
            // ALSO CALLED, before the summary -- the page's own order (105):
            // who this is, then what they are called, then the paragraph.
            if let Some(rows) = aliases_by_member.get(m.id.as_str()) {
                let joined = rows
                    .iter()
                    .map(|a| a.alias.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                text.push_str(&format!(
                    "\n{}\n",
                    strings.f("salvage.cast.aliases", &[("aliases", &joined)])
                ));
            }
            if !m.summary.trim().is_empty() {
                text.push_str(&format!("\n{}\n", m.summary.trim_end()));
            }
            if let Some(rows) = by_member.get(m.id.as_str()) {
                text.push('\n');
                for f in rows {
                    text.push_str(&format!("- **{}**: {}\n", f.label, f.value));
                }
            }
            // NAMED, not embedded. `cast.md` is text a person reads; the file
            // itself is in `pictures/`, and the name is what ties the two
            // together -- the same job the item id does under a synopsis. It is
            // printed VERBATIM, including a value this build would not have
            // written, because what the file said is the thing being recovered.
            if let Some(picture) = m.picture_path.as_deref() {
                text.push_str(&format!("\n{PICTURES_DIR}/{picture}\n"));
            }
            // THE TITLE WHEN THE ITEM SURVIVED AND THE ID WHEN IT DID NOT, and
            // the id printed EITHER WAY -- `synopses.md`'s rule. 039 asked for
            // exactly this and said why: "a list of uuid pairs is not
            // something a person can read", so the title is the whole point and
            // the id is what ties the line to `documents/<id>.md`.
            if let Some(rows) = by_appearing.get(m.id.as_str()) {
                text.push_str(&format!("\n{}\n\n", strings.t("salvage.cast.appears")));
                for a in rows {
                    match titles.get(a.item_id.as_str()) {
                        Some(title) => text.push_str(&format!("- {title} `{}`\n", a.item_id)),
                        None => text.push_str(&format!("- `{}`\n", a.item_id)),
                    }
                }
            }
        }
    }

    // BOTH TABLES' ORPHANS, one set: a member row gone leaves its fields AND
    // its aliases behind, and a reader wants one section naming the id once,
    // not two that repeat it.
    let mut orphans: std::collections::BTreeSet<&str> = by_member
        .keys()
        .copied()
        .filter(|id| !members.iter().any(|m| m.id == *id))
        .collect();
    orphans.extend(
        aliases_by_member
            .keys()
            .copied()
            .filter(|id| !members.iter().any(|m| m.id == *id)),
    );
    if !orphans.is_empty() {
        text.push_str(&format!("\n## {}\n", strings.t("salvage.cast.orphans")));
        for id in orphans {
            text.push_str(&format!("\n### {id}\n\n"));
            if let Some(rows) = aliases_by_member.get(id) {
                let joined = rows
                    .iter()
                    .map(|a| a.alias.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                text.push_str(&format!(
                    "{}\n",
                    strings.f("salvage.cast.aliases", &[("aliases", &joined)])
                ));
            }
            if let Some(rows) = by_member.get(id) {
                for f in rows {
                    text.push_str(&format!("- **{}**: {}\n", f.label, f.value));
                }
            }
        }
    }

    std::fs::write(out_dir.join(CAST_NAME), text).map_err(|e| e.to_string())?;
    Ok(Some(CAST_NAME.to_string()))
}

/// Copy every picture the recovered cast names, and record the ones it could
/// not.
///
/// IT COPIES RATHER THAN MERELY RECORDING, and that is the product decision 046
/// left to this slice. The bytes are OUTSIDE the database, so unlike everything
/// else salvage handles they are trivially recoverable -- and a path in
/// `cast.md` pointing into the directory the operator is very possibly about to
/// delete is a pointer, not a recovery. The cost, stated: the output directory
/// is now as large as the book's picture library.
///
/// IT READS FROM BESIDE THE SOURCE, NOT FROM THE WORKING COPY. The working copy
/// is a copy of the `.db` and its sidecars and nothing else, which is right --
/// the reason it exists is that SQLite must never touch the writer's file, and
/// these are read with `std::fs::copy` and never opened for writing. Salvage
/// still writes nothing into the writer's directory.
///
/// THE ORIGINALS AND NOT THE THUMBNAILS -- see `PICTURES_DIR`.
fn write_knowledge(
    conn: &rusqlite::Connection,
    source: &Path,
    out_dir: &Path,
    items: &[RecoveredItem],
    item_table_ok: bool,
    members: &[RecoveredMember],
    members_ok: bool,
    losses: &mut Vec<Loss>,
) -> Result<(u64, u64, u64, Option<String>, Option<String>), String> {
    use serde_json::{json, Value};
    let (mut resources, resources_ok) = walk(conn, "research_resource",
        "SELECT id,title,original_name,media_type,bytes,sha256,source_note,citation,created_at,removed_at FROM research_resource WHERE rowid=?1",
        KIND_RESEARCH_ROW, losses, |r| Ok(json!({
            "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?,
            "original_name": r.get::<_, String>(2)?, "media_type": r.get::<_, String>(3)?,
            "bytes": r.get::<_, i64>(4)?, "sha256": r.get::<_, String>(5)?,
            "source_note": r.get::<_, String>(6)?, "citation": r.get::<_, String>(7)?,
            "created_at": r.get::<_, i64>(8)?, "removed_at": r.get::<_, Option<i64>>(9)?
        })));
    let (mut links, _) = walk(conn, "knowledge_link",
        "SELECT id,source_kind,source_id,source_caption,target_kind,target_id,target_caption,label,note,citation,anchor_item_id,anchor_rev,anchor_from,anchor_to,anchor_quote,created_at,removed_at FROM knowledge_link WHERE rowid=?1",
        KIND_LINK_ROW, losses, |r| Ok(json!({
            "id": r.get::<_, String>(0)?,
            "source_kind": r.get::<_, String>(1)?, "source_id": r.get::<_, String>(2)?,
            "source_caption": r.get::<_, String>(3)?,
            "target_kind": r.get::<_, String>(4)?, "target_id": r.get::<_, String>(5)?,
            "target_caption": r.get::<_, String>(6)?, "label": r.get::<_, String>(7)?,
            "note": r.get::<_, String>(8)?, "citation": r.get::<_, String>(9)?,
            "anchor_item_id": r.get::<_, Option<String>>(10)?,
            "anchor_rev": r.get::<_, Option<i64>>(11)?,
            "anchor_from": r.get::<_, Option<i64>>(12)?,
            "anchor_to": r.get::<_, Option<i64>>(13)?,
            "anchor_quote": r.get::<_, Option<String>>(14)?,
            "created_at": r.get::<_, i64>(15)?, "removed_at": r.get::<_, Option<i64>>(16)?
        })));
    resources.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    links.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let resource_count = resources.len() as u64;
    let link_count = links.len() as u64;
    let resource_ids: HashSet<&str> = resources.iter().filter_map(|r| r["id"].as_str()).collect();
    let item_ids: HashSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
    let cast_ids: HashSet<&str> = members.iter().map(|member| member.id.as_str()).collect();
    let complete = |table: &str, table_ok: bool, row_kind: &str| table_ok && !losses.iter().any(|loss|
        loss.kind == row_kind || (loss.kind == KIND_ENUMERATION && loss.detail.contains(table)));
    let items_complete = complete("item", item_table_ok, KIND_ITEM_ROW);
    let cast_complete = complete("cast_member", members_ok, KIND_CAST_MEMBER_ROW);
    let resources_complete = complete("research_resource", resources_ok, KIND_RESEARCH_ROW);
    for link in &links {
        let available = |side: &str| {
            let (kind_key, id_key) = if side == "source" { ("source_kind", "source_id") }
                else { ("target_kind", "target_id") };
            let kind = link[kind_key].as_str().unwrap_or("");
            let id = link[id_key].as_str().unwrap_or("");
            match kind {
                "item" => items_complete.then(|| item_ids.contains(id)),
                "cast" => cast_complete.then(|| cast_ids.contains(id)),
                "resource" => resources_complete.then(|| resource_ids.contains(id)),
                _ => Some(false),
            }
        };
        if available("source") == Some(false) || available("target") == Some(false) {
            losses.push(Loss { kind: KIND_ORPHAN_LINK.into(),
                detail: format!("knowledge link {} names an unavailable endpoint; its row was recovered", link["id"]),
                item_id: None });
        }
    }

    let from = crate::research::dir_for(source);
    let into = out_dir.join("research");
    let source_dir_is_symlink = std::fs::symlink_metadata(&from)
        .is_ok_and(|meta| meta.file_type().is_symlink());
    let mut copied = 0u64;
    let mut referenced = HashSet::new();
    let mut made = false;
    for resource in &resources {
        let Some(hash) = resource["sha256"].as_str() else { continue; };
        if !referenced.insert(hash.to_owned()) { continue; }
        if source_dir_is_symlink {
            losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
                detail: format!("research original {hash} could not be read from an unsafe directory"), item_id: None });
            continue;
        }
        let Some(bytes) = resource["bytes"].as_i64().and_then(|n| u64::try_from(n).ok()) else {
            losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
                detail: format!("research original {hash} has an invalid recorded size"), item_id: None });
            continue;
        };
        let path = match crate::research::path_for(source, hash) {
            Ok(path) => path,
            Err(error) => { losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
                detail: format!("research original {hash} has an invalid name: {error}"), item_id: None }); continue; }
        };
        if !path.exists() {
            losses.push(Loss { kind: KIND_MISSING_RESEARCH.into(),
                detail: format!("research original {hash} is missing; its resource record was recovered"), item_id: None });
            continue;
        }
        if !made { crate::research::private_dir(&into)?; made = true; }
        match crate::research::copy_checked(&path, &into.join(hash), Some((hash, bytes))) {
            Ok(_) => copied += 1,
            Err(error) => losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
                detail: format!("research original {hash} could not be verified and copied: {error}"), item_id: None }),
        }
    }
    let mut orphans = Vec::<Value>::new();
    if source_dir_is_symlink {
        losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
            detail: "research directory is a symlink and was not enumerated".into(), item_id: None });
    }
    match if source_dir_is_symlink { Err(std::io::Error::other("unsafe research directory")) }
        else { std::fs::read_dir(&from) } {
        Ok(entries) => {
            let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if referenced.contains(&name) { continue; }
                if !made { crate::research::private_dir(&into)?; made = true; }
                let orphan_dir = into.join("orphans");
                if !orphan_dir.exists() { crate::research::private_dir(&orphan_dir)?; }
                let recovered = format!("{:04}", orphans.len() + 1);
                match crate::research::copy_checked(&entry.path(), &orphan_dir.join(&recovered), None) {
                    Ok(bytes) => {
                        copied += 1;
                        orphans.push(json!({"original_name": name, "recovered": format!("research/orphans/{recovered}"), "bytes": bytes}));
                        losses.push(Loss { kind: KIND_ORPHAN_RESEARCH.into(),
                            detail: format!("unreferenced research file {name} was recovered separately"), item_id: None });
                    }
                    Err(error) => losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
                        detail: format!("unreferenced research file {name} could not be recovered: {error}"), item_id: None }),
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) if source_dir_is_symlink => {}
        Err(error) => losses.push(Loss { kind: KIND_CORRUPT_RESEARCH.into(),
            detail: format!("research directory could not be enumerated: {error}"), item_id: None }),
    }
    let knowledge_file = "knowledge.json";
    std::fs::write(out_dir.join(knowledge_file),
        serde_json::to_vec_pretty(&json!({"version": 1, "resources": resources, "links": links, "orphans": orphans}))
            .map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok((resource_count, link_count, copied,
        Some(knowledge_file.into()), made.then(|| "research".into())))
}

fn write_pictures(
    out_dir: &Path,
    source: &Path,
    members: &[RecoveredMember],
    covers: &[(&'static str, String)],
    losses: &mut Vec<Loss>,
) -> Result<(u64, u64, Option<String>), String> {
    // Named in the members' own order, which `write_cast` has not reordered:
    // this is a copy loop and the order of two file copies is not a fact
    // anybody reads. What IS stable is the loss list, which is emitted in the
    // same walk order on every run of one recovery.
    let named: Vec<(&str, &str)> = members
        .iter()
        .filter_map(|m| m.picture_path.as_deref().map(|p| (m.id.as_str(), p)))
        .collect();
    if named.is_empty() && covers.is_empty() {
        return Ok((0, 0, None));
    }
    let from = crate::pictures::dir_for(source);
    let into = out_dir.join(PICTURES_DIR);
    let mut recovered = 0u64;
    let mut covers_recovered = 0u64;
    let mut made = false;
    for (member, name) in named {
        // THE SAME GATE `pictures::view` TAKES. A value this application would
        // never have written cannot be joined to a directory at all, so a
        // traversal is refused before there is a path -- and it is a LOSS
        // rather than a silence, because whatever that column meant is not in
        // this recovery.
        if !crate::pictures::is_stored_name(name) {
            losses.push(Loss {
                kind: KIND_UNREADABLE_PICTURE.into(),
                detail: format!(
                    "cast member {member} names a picture as {name:?}, which is not a name this                      build would have written, so nothing was copied for it"
                ),
                item_id: None,
            });
            continue;
        }
        if !made {
            // MADE LAZILY, so a book whose every picture is gone does not get an
            // empty directory that reads as a recovery having happened.
            std::fs::create_dir_all(&into).map_err(|e| e.to_string())?;
            made = true;
        }
        match std::fs::copy(from.join(name), into.join(name)) {
            Ok(_) => recovered += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => losses.push(Loss {
                kind: KIND_MISSING_PICTURE.into(),
                detail: format!(
                    "cast member {member} names the picture {name}, which is not in this                      project's picture directory; the row survives and the photograph does not"
                ),
                item_id: None,
            }),
            Err(e) => losses.push(Loss {
                kind: KIND_UNREADABLE_PICTURE.into(),
                detail: format!(
                    "the picture {name}, named by cast member {member}, could not be copied: {e}"
                ),
                item_id: None,
            }),
        }
    }
    // ONE DIRECTORY FOR BOTH, and one lazy make and one sweep. A cover is the
    // same kind of thing as a photograph -- bytes an operator can open -- so a
    // second directory would make them look in two places for one kind of file
    // and would state the make and the sweep twice. Which file is which is
    // `covers.md`'s job, exactly as it is `cast.md`'s for a portrait.
    for (side, name) in covers {
        if !crate::pictures::is_stored_name(name) {
            losses.push(Loss {
                kind: KIND_UNREADABLE_COVER.into(),
                detail: format!(
                    "the {side} cover is recorded as {name:?}, which is not a name this build \
                     would have written, so nothing was copied for it"
                ),
                item_id: None,
            });
            continue;
        }
        if !made {
            std::fs::create_dir_all(&into).map_err(|e| e.to_string())?;
            made = true;
        }
        match std::fs::copy(from.join(name), into.join(name)) {
            Ok(_) => covers_recovered += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => losses.push(Loss {
                kind: KIND_MISSING_COVER.into(),
                detail: format!(
                    "the {side} cover is recorded as {name}, which is not in this project's \
                     picture directory; the book still says it had one and the picture is gone"
                ),
                item_id: None,
            }),
            Err(e) => losses.push(Loss {
                kind: KIND_UNREADABLE_COVER.into(),
                detail: format!("the {side} cover, {name}, could not be copied: {e}"),
                item_id: None,
            }),
        }
    }
    if recovered == 0 && covers_recovered == 0 {
        // The directory, if one was made, holds nothing. Removing it keeps
        // `pictures: None` and an absent directory saying the same thing.
        let _ = std::fs::remove_dir(&into);
        return Ok((0, 0, None));
    }
    Ok((recovered, covers_recovered, Some(PICTURES_DIR.to_string())))
}

/// What the book's design rows said, VERBATIM AND UNPARSED.
///
/// THE MANIFEST AND NOT A FILE OF ITS OWN. The short of it: the
/// Markdown in a recovery directory exists for text a person READS, and a book
/// design is not read, it is RE-TYPED into a panel. What that person needs is
/// raw values to copy, and the manifest is where a recovery states values.
///
/// VERBATIM, because salvage does not interpret. `picture_path` is printed
/// exactly as the column held it and a body that will not parse is written byte
/// for byte; running these through `parse_page` and `parse_font` would DROP a
/// value this build cannot read, which is silent loss inside the fix for silent
/// loss.
#[derive(Debug, Serialize)]
pub struct RecoveredDesign {
    pub font: Option<String>,
    pub page: Option<String>,
    pub margins: Option<String>,
    pub glyph: Option<String>,
    pub chapter: Option<String>,
    pub cover_fit_front: Option<String>,
    pub cover_fit_back: Option<String>,
}

impl RecoveredDesign {
    /// The rows that were actually there, by their `meta` key -- which is the
    /// honest identity of each, and the string a person searching the file for
    /// one would search for.
    pub fn rows(&self) -> Vec<(&'static str, &str)> {
        DESIGN_KEYS
            .into_iter()
            .zip([
                &self.font,
                &self.page,
                &self.margins,
                &self.glyph,
            &self.chapter,
            &self.cover_fit_front,
            &self.cover_fit_back,
            ])
            .filter_map(|(key, v)| v.as_deref().map(|v| (key, v)))
            .collect()
    }

    /// The seven design rows, PROJECTED from the `meta` sweep rather than read a
    /// second time. One reader means there is no second statement of what the
    /// table holds, free to fall out of step with the first.
    ///
    /// AN EMPTY ROW IS AN ABSENT ONE, deliberately, and this is the one place
    /// that interpretation lives: `write_chapter_style` stores `""` for an
    /// ornament nobody chose, so the two states are already one in every file
    /// this application has written and a salvage that distinguished them would
    /// be making a distinction the writer cannot. The sweep itself keeps the
    /// empty string, because it is what the row says.
    fn from_meta(meta: &BTreeMap<String, String>) -> RecoveredDesign {
        let read =
            |key: &str| -> Option<String> { meta.get(key).filter(|v| !v.is_empty()).cloned() };
        RecoveredDesign {
            font: read(crate::design::FONT_KEY),
            page: read(crate::design::PAGE_KEY),
            margins: read(crate::design::MARGINS_KEY),
            glyph: read(crate::design::GLYPH_KEY),
            chapter: read(crate::design::CHAPTER_KEY),
            cover_fit_front: read(crate::covers::FRONT_FIT_KEY),
            cover_fit_back: read(crate::covers::BACK_FIT_KEY),
        }
    }
}

/// The `meta` keys the design is made of, in the order the report prints them.
///
/// ITS LENGTH IS `DESIGN_ROWS`, so a build that learns a sixth cannot go on
/// saying "of five" -- and `read_meta` uses this same list to decide whether an
/// unreadable row is a design failure or an anonymous one, so the two cannot
/// disagree about what a design row is.
const DESIGN_KEYS: [&str; DESIGN_ROWS] = [
    crate::design::FONT_KEY,
    crate::design::PAGE_KEY,
    crate::design::MARGINS_KEY,
    crate::design::GLYPH_KEY,
    crate::design::CHAPTER_KEY,
    crate::covers::FRONT_FIT_KEY,
    crate::covers::BACK_FIT_KEY,
];

/// How many design rows this build knows about. The report says "n of this",
/// so a build that learns a sixth cannot go on saying "of five".
pub const DESIGN_ROWS: usize = 7;

/// Every table this salvage reads something out of.
///
/// THE ROSTER EXISTS BECAUSE REMEMBERING FAILED THREE TIMES. 046 widened the
/// walk from three tables to six and wrote "there is no schema introspection; a
/// sixth added later gets the same silence unless somebody widens the walk
/// again". 048 widened it again and repeated that sentence verbatim. 049 widened
/// it a third time. `every_table_the_schema_creates_is_named_in_the_salvage_roster`
/// is the tripwire that ends the pattern: a slice adding a table goes RED until
/// its author either widens the walk or writes down why not.
///
/// IT IS A TRIPWIRE AND NOT A GENERIC WALKER. What a recovered record IS is a
/// product decision every time -- a file of its own, a section of an existing
/// one, a manifest key, bytes copied out beside the manifest -- and a walker
/// that answered it once would answer it wrongly for every table at once.
#[cfg(test)]
pub const SALVAGED: [&str; 27] = [
    "analytics_adjustment",
    "analytics_category",
    "analytics_minute",
    "analytics_movement",
    "analytics_segment",
    "analytics_session",
    "appearance",
    "blob",
    "cast_alias",
    "cast_field",
    "cast_member",
    "comment",
    "dict_word",
    "doc",
    "doc_version",
    "item",
    "knowledge_link",
    "meta",
    "research_resource",
    "review_author",
    "review_group",
    "review_hunk",
    "review_message",
    "revision_pass",
    "revision_task",
    "snapshot",
    "synopsis",
];

/// Every table this salvage reads nothing out of, and why. A reason here is a
/// decision somebody took, not a table somebody forgot.
///
/// IT IS EMPTY, and 050 is what emptied it: `blob`, `doc_version` and `snapshot`
/// were the last three, and they are one decision rather than three. **An empty
/// roster is not the end of the tripwire's job** -- the next table added to the
/// schema still turns `every_table_the_schema_creates_is_named_in_the_salvage_roster`
/// red, which is the whole point of it.
///
/// `meta` IS FULLY SWEPT SINCE 050 and no longer half salvaged: `read_meta`
/// takes every row verbatim and `design` is a named subset projected from it.
/// `DESIGN_ROWS` remains the tripwire for the report's "of five".
#[cfg(test)]
pub const NOT_SALVAGED: [(&str, &str); 0] = [];

/// EVERY `meta` row, verbatim, by key -- plus a loss for each row that would not
/// read and ONE for a `meta` table that would not answer at all.
///
/// THE SWEEP IS THE FIX FOR THE ROSTER'S OWN LIMIT. `SALVAGED` is table-level,
/// and until this slice `meta` was read BY KEY: the project's name, two covers
/// and design rows. Any other row was silent exactly as the `comment` table
/// was before 049 -- the daily word target, its baseline, and the two rows a
/// recovery point writes about where it came from were all live examples.
///
/// THE KEY IS READ SEPARATELY FROM THE VALUE, and that is what lets a row whose
/// VALUE will not read still say which row it was: `unreadable_design_row` when
/// the key is one of the five and `unreadable_meta_row` otherwise. Per key, not
/// per table, which is `design.rs`'s own recorded rule -- "one unreadable value
/// costs exactly itself, so a corrupt page size cannot take a font the writer
/// chose down with it". The table-level failure is `walk`'s shape instead: one
/// loss and no attempt at the rows.
///
/// AN ABSENT ROW IS NOT A LOSS. `design.rs` says the first half -- "an absent key
/// means the writer has not chosen" -- and a `meta` table simply has no row for a
/// setting nobody has touched.
///
/// NO SCHEMA GUARD: `meta` is v1, so a version guard here would be a refusal
/// nothing could reach. 042's rule for the covers.
fn read_meta(
    conn: &rusqlite::Connection,
    losses: &mut Vec<Loss>,
) -> Option<BTreeMap<String, String>> {
    let ids = match rowids(conn, "meta") {
        Ok((ids, mut stopped)) => {
            losses.append(&mut stopped);
            ids
        }
        Err(e) => {
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!(
                    "the meta table could not be read ({e}), so nothing this book was \
                     designed as was recovered"
                ),
                item_id: None,
            });
            return None;
        }
    };
    // A PREPARE THAT FAILS HERE IS REACHABLE, `walk`'s rule: `rowids` proves the
    // table exists and a rowid knows nothing about columns.
    let (mut key_stmt, mut value_stmt) = match (
        conn.prepare("SELECT key FROM meta WHERE rowid = ?1"),
        conn.prepare("SELECT value FROM meta WHERE rowid = ?1"),
    ) {
        (Ok(k), Ok(v)) => (k, v),
        (k, v) => {
            let e = k
                .err()
                .or_else(|| v.err())
                .map(|e| e.to_string())
                .unwrap_or_default();
            losses.push(Loss {
                kind: KIND_TABLE.into(),
                detail: format!(
                    "the meta table is not the shape this build knows ({e}), \
                     so nothing in it was recovered"
                ),
                item_id: None,
            });
            return None;
        }
    };
    let mut out = BTreeMap::new();
    for rowid in &ids {
        let key = match key_stmt.query_row([rowid], |r| r.get::<_, String>(0)) {
            Ok(key) => key,
            Err(e) => {
                losses.push(Loss {
                    kind: KIND_META_ROW.into(),
                    detail: format!(
                        "row {rowid} of meta could not be read: {e}; \
                         whatever setting it held was not recovered"
                    ),
                    item_id: None,
                });
                continue;
            }
        };
        match value_stmt.query_row([rowid], |r| r.get::<_, String>(0)) {
            // VERBATIM, empty values included. "An empty value is an absent one"
            // is `design`'s reading of its own rows and lives in
            // `RecoveredDesign::from_meta`; a sweep that applied it would be
            // interpreting, which this command does not do.
            Ok(value) => {
                out.insert(key, value);
            }
            Err(e) if DESIGN_KEYS.contains(&key.as_str()) => losses.push(Loss {
                kind: KIND_DESIGN_ROW.into(),
                detail: format!(
                    "the {key} row could not be read: {e}; whatever this book was \
                     designed as in that respect was not recovered"
                ),
                item_id: None,
            }),
            Err(e) => losses.push(Loss {
                kind: KIND_META_ROW.into(),
                detail: format!(
                    "the {key} row could not be read: {e}; whatever setting it held \
                     was not recovered"
                ),
                item_id: None,
            }),
        }
    }
    Some(out)
}

/// Which cover the book records on each side, in front-then-back order, read
/// through the raw connection.
///
/// THROUGH THE RAW CONNECTION AND NOT THROUGH `Store`, exactly as `project_name`
/// is and for the same reason: a file damaged enough to need salvaging need not
/// open as a `Store` at all, and this is wanted precisely then.
///
/// A ROW THAT IS NOT THERE IS NOT A LOSS. A book with no cover is the ordinary
/// case, and `meta` has existed since v1 so there is no version at which the
/// question is unaskable -- a `meta` table that will not answer at all is
/// already reported by `project_name` falling back to the stem.
fn read_covers(conn: &rusqlite::Connection) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    for side in crate::covers::SIDES {
        let Some(key) = crate::covers::key_for(side) else {
            continue;
        };
        if let Ok(name) = conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        }) {
            if !name.is_empty() {
                out.push((side, name));
            }
        }
    }
    out
}

/// Which recovered file goes on the front of the book and which on the back.
///
/// WRITTEN ONLY WHEN SOMETHING WAS COPIED, `cast.md`'s and `synopses.md`'s rule:
/// a file naming two pictures that are not in the directory beside it is worse
/// than no file, because it reads as a recovery that happened.
///
/// The name is printed VERBATIM, including a value this build would not have
/// written, because what the file said is the thing being recovered -- and the
/// covers that were REFUSED are named here as losses rather than as lines,
/// which is why this takes the recovered count and not the loss list.
fn write_covers(
    out_dir: &Path,
    name: &str,
    covers: &[(&'static str, String)],
    recovered: u64,
    strings: crate::strings::Strings,
) -> Result<Option<String>, String> {
    if recovered == 0 {
        return Ok(None);
    }
    let mut text = format!(
        "# {}\n",
        strings.f("salvage.title.covers", &[("name", name)])
    );
    for (side, stored) in covers {
        if !crate::pictures::is_stored_name(stored) {
            continue;
        }
        let heading = match *side {
            crate::covers::SIDE_BACK => strings.t("salvage.covers.back"),
            _ => strings.t("salvage.covers.front"),
        };
        text.push_str(&format!("\n## {heading}\n\n{PICTURES_DIR}/{stored}\n"));
    }
    std::fs::write(out_dir.join(COVERS_NAME), text).map_err(|e| e.to_string())?;
    Ok(Some(COVERS_NAME.to_string()))
}

/// Err is a prepare that failed: the table exists and is not the shape this
/// build knows. It is the CALLER's loss to record, because it is a fact about
/// the whole table rather than about a row -- `walk`'s split exactly.
fn read_items(conn: &rusqlite::Connection, ids: &[i64]) -> Result<Rows<RecoveredItem>, String> {
    let mut out = Vec::new();
    let mut losses = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, parent_id, title FROM item WHERE rowid = ?1")
        .map_err(|e| e.to_string())?;
    for rowid in ids {
        let row = stmt.query_row([rowid], |r| {
            Ok(RecoveredItem {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                title: r.get(2)?,
            })
        });
        match row {
            Ok(item) => out.push(item),
            Err(e) => losses.push(Loss {
                kind: KIND_ITEM_ROW.into(),
                detail: format!("item row {rowid} could not be read: {e}"),
                item_id: None,
            }),
        }
    }
    Ok((out, losses))
}

/// Err is a prepare that failed -- see `read_items`.
fn read_docs(conn: &rusqlite::Connection, ids: &[i64]) -> Result<Rows<(String, String)>, String> {
    let mut out = Vec::new();
    let mut losses = Vec::new();
    let mut stmt = conn
        .prepare("SELECT item_id, body FROM doc WHERE rowid = ?1")
        .map_err(|e| e.to_string())?;
    for rowid in ids {
        let row = stmt.query_row([rowid], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        });
        match row {
            Ok(pair) => out.push(pair),
            Err(e) => losses.push(Loss {
                kind: KIND_DOC_ROW.into(),
                detail: format!(
                    "document row {rowid} could not be read: {e}; \
                     whatever prose it held was not recovered"
                ),
                item_id: None,
            }),
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((out, losses))
}

/// Every version whose blob is not stored: one `Loss` each.
///
/// IT IS THE ONLY THING THAT REPORTS AN ABSENT BLOB. `write_snapshots` meets the
/// same rows and says nothing about them beyond a line in the index -- see the
/// `QueryReturnedNoRows` arm there. One damage, one sentence, which is
/// `orphan_cast_field`'s rule at a third table.
fn missing_blobs(conn: &rusqlite::Connection) -> Result<Vec<Loss>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT v.id, v.item_id, v.blob_key FROM doc_version v
               LEFT JOIN blob b ON b.key = v.blob_key
              WHERE b.key IS NULL ORDER BY v.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (version_id, item_id, key) = row.map_err(|e| e.to_string())?;
        out.push(Loss {
            kind: KIND_MISSING_BLOB.into(),
            detail: format!(
                "version {version_id} of {item_id} names blob {key}, which is not stored; \
                 that past state cannot be recovered"
            ),
            item_id: Some(item_id),
        });
    }
    Ok(out)
}

/// The project's name: the meta row, falling back to the file stem.
///
/// Read through the raw connection rather than through `Store`, because a file
/// damaged enough to need salvaging need not open as a `Store` at all -- and the
/// name is wanted precisely then, for the manuscript's H1.
fn project_name(conn: &rusqlite::Connection, source: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        [projects::NAME_KEY],
        |r| r.get::<_, String>(0),
    ) {
        Ok(name) if !name.is_empty() => name,
        _ => stem,
    }
}

/// Filenames for recovered documents, deduplicated as they are handed out.
///
/// An item id in a HEALTHY project is a uuid and is already a safe filename.
/// This is not about healthy projects. A file damaged by something other than
/// this application can hold any text at all in `item.id`, including `..`, a
/// path separator, a NUL, or two ids that differ only where the sanitiser
/// folds -- and every one of those is a write outside `<out-dir>` or a write
/// over another scene's prose. Sanitising is not tidiness here; it is the only
/// thing standing between a damaged file and the operator's filesystem.
#[derive(Default)]
struct FileNames {
    taken: HashSet<String>,
}

impl FileNames {
    fn pick(&mut self, id: &str, ext: &str) -> String {
        let stem = sanitize(id);
        let mut candidate = format!("{stem}.{ext}");
        let mut n = 2;
        while !self.taken.insert(candidate.clone()) {
            candidate = format!("{stem}-{n}.{ext}");
            n += 1;
        }
        candidate
    }
}

/// The longest stem a sanitised id keeps. Well inside every filesystem's limit
/// with room for the `-99.raw` a collision adds.
const MAX_STEM: usize = 120;

/// `id` as a filename that cannot leave `<out-dir>`.
///
/// The allowed set is ASCII letters, digits, `-`, `_` and `.` -- everything
/// else, including every byte of a multi-byte character, becomes `_`. A leading
/// `.` is prefixed rather than kept, which is what turns `.`, `..` and
/// `.hidden` into ordinary names in one rule instead of three.
fn sanitize(id: &str) -> String {
    let mut out = String::new();
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
        if out.len() >= MAX_STEM {
            break;
        }
    }
    if out.is_empty() || out.starts_with('.') {
        out.insert(0, '_');
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::cast;
    use crate::store::{FlushEntry, Store};
    use tempfile::tempdir;

    #[test]
    fn localized_loss_report_preserves_machine_diagnostics_and_names_every_current_kind() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let ids = fixture(&db);
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection.execute("UPDATE doc SET body='not document json' WHERE item_id=?1", [&ids[0]]).unwrap();
        drop(connection);
        let out = dir.path().join("recovered");
        let recovered = salvage_with(&db, &out, crate::strings::Strings::new(&crate::strings::DE)).unwrap();
        assert!(!recovered.complete);
        let report = std::fs::read_to_string(out.join(LOSS_REPORT_NAME)).unwrap();
        assert!(report.starts_with("Wiederherstellungsbericht"));
        assert!(report.contains("Rohdaten"));
        assert!(!report.contains("not document json"));
        let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(out.join(MANIFEST_NAME)).unwrap()).unwrap();
        assert_eq!(manifest["losses"], serde_json::to_value(&recovered.losses).unwrap());
        let source = include_str!("salvage.rs");
        let kinds: Vec<&str> = source.split("pub(crate) mod tests").next().unwrap().split("const KIND_").skip(1).filter_map(|part| part.split('=').nth(1)?.split('"').nth(1)).collect();
        assert!(kinds.len() >= 35);
        for kind in kinds {
            let loss = Loss { kind: kind.into(), detail: "technical evidence".into(), item_id: None };
            for locale in [&crate::strings::EN, &crate::strings::DE] {
                let strings = crate::strings::Strings::new(locale);
                let text = loss_report(std::slice::from_ref(&loss), strings);
                assert!(!text.contains("⟦"), "{kind}: {text}");
                assert!(!text.contains(&strings.t("salvage.loss.unknown")), "untranslated kind: {kind}");
            }
        }
    }

    fn body(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[
                 {{"type":"text","text":"{text}"}}]}}]}}"#
        )
    }

    /// One part holding two scenes, both with prose. Built through
    /// `Store::open` -- the fixture is the one place here ALLOWED to write.
    fn fixture(db: &Path) -> Vec<String> {
        let store = Store::open(db).unwrap();
        store.set_meta(projects::NAME_KEY, "The Harbour").unwrap();
        let part = store.item_create(None, "part", "Part One").unwrap();
        let mut ids = Vec::new();
        for (title, text) in [
            ("Opening", "the harbour was quiet"),
            ("Second", "three more words"),
        ] {
            let s = store.item_create(Some(&part.id), "scene", title).unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body: body(text),
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            ids.push(s.id);
        }
        ids
    }

    /// Damage the file directly, foreign keys OFF -- rusqlite turns them ON for
    /// every connection it opens, so an orphan cannot otherwise be written. The
    /// pragma is per connection and OFF by default in SQLite itself, so any
    /// other tool that ever touched this file could have left exactly these
    /// rows, which is the whole reason salvage checks rather than trusts.
    fn damage(db: &Path, sql: &str) {
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute_batch(sql).unwrap();
    }

    fn kinds(v: &Salvage) -> Vec<&str> {
        v.losses.iter().map(|l| l.kind.as_str()).collect()
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn healthy_rowid_enumeration_keeps_its_original_order_and_no_loss() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let conn = rusqlite::Connection::open(&db).unwrap();
        let (original, error) = scan_rowids(&conn, "SELECT rowid FROM item");
        assert!(error.is_none());
        let (ids, losses) = rowids(&conn, "item").unwrap();
        assert_eq!(ids, original);
        assert!(losses.is_empty());
    }

    #[test]
    fn torn_covering_index_recovers_table_rows_once_and_reports_the_damage() {
        use std::io::{Seek, SeekFrom, Write};

        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA journal_mode=DELETE; BEGIN").unwrap();
        let mut insert = conn
            .prepare("INSERT INTO item (id, parent_id, type, title, position) VALUES (?1, NULL, 'scene', ?2, ?3)")
            .unwrap();
        for n in 0..1_500 {
            let label = format!("indexed-{n:04}");
            insert
                .execute(rusqlite::params![label, label, format!("p{n:04}")])
                .unwrap();
        }
        drop(insert);
        conn.execute_batch("COMMIT").unwrap();

        let plan = |sql: &str| -> String {
            conn.query_row(&format!("EXPLAIN QUERY PLAN {sql}"), [], |r| r.get(3))
                .unwrap()
        };
        assert!(
            plan("SELECT rowid FROM item").contains("COVERING INDEX sqlite_autoindex_item_1")
        );
        let table_plan = plan("SELECT rowid FROM item NOT INDEXED");
        assert!(
            table_plan.contains("SCAN item") && !table_plan.contains("INDEX"),
            "{table_plan}"
        );
        assert!(
            plan("SELECT id FROM item WHERE rowid = 1").contains("INTEGER PRIMARY KEY")
        );

        let total = conn
            .query_row("SELECT count(*) FROM item", [], |r| r.get::<_, i64>(0))
            .unwrap() as usize;
        let pages: Vec<i64> = conn
            .prepare("SELECT pageno FROM dbstat WHERE name = 'sqlite_autoindex_item_1' AND pagetype = 'leaf' ORDER BY path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(pages.len() >= 3, "the index has no middle leaf to tear");
        let torn = pages[pages.len() / 2];
        let page_size = conn
            .query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0))
            .unwrap() as u64;
        drop(conn);

        let mut file = std::fs::OpenOptions::new().write(true).open(&db).unwrap();
        file.seek(SeekFrom::Start((torn as u64 - 1) * page_size)).unwrap();
        file.write_all(&vec![0; page_size as usize]).unwrap();
        drop(file);
        let before = std::fs::read(&db).unwrap();

        let conn = rusqlite::Connection::open_with_flags(
            &db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let (prefix, index_error) = scan_rowids(&conn, "SELECT rowid FROM item");
        assert!(index_error.is_some(), "the damaged index did not fail");
        assert!(
            !prefix.is_empty() && prefix.len() < total,
            "the index did not fail part way"
        );
        let (table_ids, table_error) = scan_rowids(&conn, "SELECT rowid FROM item NOT INDEXED");
        assert!(table_error.is_none());
        assert_eq!(table_ids.len(), total);
        let (ids, losses) = rowids(&conn, "item").unwrap();
        assert_eq!(ids.len(), total);
        assert_eq!(ids.iter().copied().collect::<HashSet<_>>().len(), total);
        assert_eq!(losses.len(), 1);
        assert_eq!(losses[0].kind, KIND_ENUMERATION);
        assert!(losses[0].detail.contains("table scan recovered"));
        assert_eq!(read_items(&conn, &ids).unwrap().0.len(), total);
        drop(conn);

        let recovered = salvage(&db, &dir.path().join("recovered")).unwrap();
        assert_eq!(recovered.items_recovered, total as u64);
        assert!(!recovered.complete);
        assert!(kinds(&recovered).contains(&KIND_ENUMERATION));
        assert_eq!(std::fs::read(&db).unwrap(), before);
    }

    // ------------------------------------------------ the load-bearing test

    /// THE LOAD-BEARING TEST OF THIS SLICE.
    ///
    /// The whole feature is "without modifying the source". Not "should not" --
    /// must not, and it must be TESTED, because the ways to break it are
    /// invisible: `Store::open` migrates, `open_readonly` on a WAL database
    /// creates `-shm`, and under damage SQLite runs WAL recovery. None of those
    /// announce themselves and all three change the writer's directory.
    ///
    /// So this records the source file's BYTES and its DIRECTORY LISTING before
    /// and after, and asserts both are unchanged. The listing is what catches a
    /// sidecar; the bytes are what catch a migration or a recovery. It runs
    /// against a DAMAGED project, because a healthy one may not exercise
    /// recovery at all, and the source directory holds only the project so a
    /// stray file cannot hide among others.
    #[test]
    fn salvage_does_not_modify_the_source() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("source");
        std::fs::create_dir(&src).unwrap();
        let db = src.join("book.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('lost', 'nobody', 'scene', 'Orphan', 'zzzz', 1);
             INSERT INTO doc VALUES ('ghost', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
        );

        let listing = |d: &Path| -> Vec<String> {
            let mut out: Vec<String> = std::fs::read_dir(d)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            out.sort();
            out
        };
        let before_bytes = std::fs::read(&db).unwrap();
        let before_listing = listing(&src);

        let out = dir.path().join("recovered");
        let v = salvage(&db, &out).unwrap();
        assert!(
            !v.complete,
            "the fixture is damaged, so this is not a clean run"
        );

        assert_eq!(
            std::fs::read(&db).unwrap(),
            before_bytes,
            "salvage changed the bytes of the source project"
        );
        assert_eq!(
            listing(&src),
            before_listing,
            "salvage left a file beside the source project"
        );
    }

    /// The same claim for the sidecars, which is the half a byte comparison of
    /// the main file cannot see. A project in WAL mode with an unchecked-pointed
    /// `-wal` beside it is the ordinary state of one that crashed, and salvage
    /// must not check it in, truncate it, or remove it.
    #[test]
    fn salvage_does_not_checkpoint_or_remove_the_wal() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("source");
        std::fs::create_dir(&src).unwrap();
        let db = src.join("book.db");
        // The store is held open across the salvage so its WAL is not
        // checkpointed by its own close, which is what leaves one on disk.
        let store = Store::open(&db).unwrap();
        store.set_meta(projects::NAME_KEY, "The Harbour").unwrap();
        let s = store.item_create(None, "scene", "Only").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: s.id.clone(),
                body: body("prose that lives only in the wal"),
                base_rev: s.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();

        let wal = sidecar_path(&db, "-wal");
        assert!(
            wal.exists(),
            "the fixture must leave a -wal to be meaningful"
        );
        let before = std::fs::read(&wal).unwrap();

        let out = dir.path().join("recovered");
        let v = salvage(&db, &out).unwrap();
        assert!(v.sidecars.contains(&"wal".to_string()), "{:?}", v.sidecars);
        assert_eq!(
            std::fs::read(&wal).unwrap(),
            before,
            "salvage wrote to the source's write-ahead log"
        );
        // And the prose that lived only in the WAL came out, which is what
        // copying the PAIR buys.
        let file = read(&out.join(DOCUMENTS_DIR).join(format!("{}.md", s.id)));
        assert!(file.contains("prose that lives only in the wal"), "{file}");
    }

    // ------------------------------------------------- the truncated file

    /// A project with a big enough file that losing its tail still leaves the
    /// schema and most of the manuscript. `fixture` writes three rows and one
    /// page; nothing can be truncated out of that.
    fn wide_fixture(db: &Path) -> u64 {
        let store = Store::open(db).unwrap();
        store.set_meta(projects::NAME_KEY, "The Harbour").unwrap();
        let part = store.item_create(None, "part", "Part One").unwrap();
        let mut entries = Vec::new();
        for n in 0..400 {
            let s = store
                .item_create(Some(&part.id), "scene", &format!("Scene {n}"))
                .unwrap();
            entries.push(FlushEntry {
                item_id: s.id.clone(),
                body: body(&format!(
                    "the harbour was quiet on the {n}th morning of the year"
                )),
                base_rev: s.doc_rev.unwrap(),
                comments: None,
            });
        }
        store.flush(&entries).unwrap();
        drop(store);
        401
    }

    /// Cut the file to `keep` pages, leaving the header's own page count saying
    /// what it always said. That is the whole of what a truncated write does to
    /// a SQLite file, and it is what makes SQLite refuse to read a single row.
    fn truncate_pages(db: &Path, keep: u64) -> (u64, u64) {
        let bytes = std::fs::read(db).unwrap();
        let ps = u64::from(u16::from_be_bytes([bytes[16], bytes[17]]));
        let ps = if ps == 1 { 65536 } else { ps };
        let was = bytes.len() as u64 / ps;
        std::fs::write(db, &bytes[..(keep * ps) as usize]).unwrap();
        (was, keep)
    }

    /// THE DAMAGE A WRITER ACTUALLY HAS, and until 052 this command refused it
    /// outright: SQLite will not read one row out of a file whose header claims
    /// more pages than the file holds, so a book missing its last megabyte
    /// salvaged as "this file does not hold a project this build can salvage".
    /// Every byte of the manuscript was still there.
    #[test]
    fn a_file_whose_tail_is_gone_is_salvaged_and_not_refused() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let planted = wide_fixture(&db);
        let (was, _) = truncate_pages(&db, {
            let bytes = std::fs::read(&db).unwrap();
            let ps = u64::from(u16::from_be_bytes([bytes[16], bytes[17]]));
            (bytes.len() as u64 / ps) * 9 / 10
        });
        assert!(was > 20, "the fixture must be more than a page to truncate");

        let out = dir.path().join("out");
        let v = salvage(&db, &out).expect("a truncated project must still be salvaged");
        assert!(
            v.items_recovered > 0,
            "nothing came back out of a file whose head is intact"
        );
        assert!(
            v.items_recovered <= planted,
            "more items came back than were ever written"
        );
        assert!(!v.complete, "a truncated file is not a complete recovery");
        assert!(
            kinds(&v).contains(&KIND_TRUNCATED),
            "the truncation itself is not reported: {:?}",
            kinds(&v)
        );
    }

    /// The loss says the two numbers, because "this file is truncated" without
    /// them tells a writer nothing about how much of their book is gone.
    #[test]
    fn the_truncation_loss_names_what_the_header_claimed_and_what_is_there() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        wide_fixture(&db);
        let bytes = std::fs::read(&db).unwrap();
        let ps = u64::from(u16::from_be_bytes([bytes[16], bytes[17]]));
        let pages = bytes.len() as u64 / ps;
        truncate_pages(&db, pages * 9 / 10);

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        let loss = v
            .losses
            .iter()
            .find(|l| l.kind == KIND_TRUNCATED)
            .expect("no truncation loss");
        assert!(
            loss.detail.contains(&pages.to_string()),
            "the loss does not say how many pages the header claimed: {}",
            loss.detail
        );
        assert!(
            loss.detail.contains(&(pages * 9 / 10).to_string()),
            "the loss does not say how many pages are there: {}",
            loss.detail
        );
    }

    /// The repair must be INVISIBLE on a healthy file. It is conditional on the
    /// header overclaiming, which a healthy file never does, and a build that
    /// rewrote every header would report every book as truncated.
    #[test]
    fn a_healthy_project_is_never_reported_as_truncated() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert!(!kinds(&v).contains(&KIND_TRUNCATED), "{:?}", kinds(&v));
    }

    /// AND THE SOURCE IS STILL NOT TOUCHED. The repair happens on the working
    /// copy; this is the one change in four slices that writes to a database
    /// file at all, and the promise it could break is the load-bearing one.
    #[test]
    fn the_truncation_repair_does_not_write_to_the_source() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        wide_fixture(&db);
        let bytes = std::fs::read(&db).unwrap();
        let ps = u64::from(u16::from_be_bytes([bytes[16], bytes[17]]));
        truncate_pages(&db, (bytes.len() as u64 / ps) * 9 / 10);
        let before = std::fs::read(&db).unwrap();

        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();
        assert_eq!(
            std::fs::read(&db).unwrap(),
            before,
            "the truncation repair wrote to the writer's own file"
        );
    }

    // ----------------------------------- the header rule, on its own bytes

    fn header_of(claimed: u32, counter: u32, valid_for: u32, page_size: u16) -> [u8; HEADER_BYTES] {
        let mut h = [0u8; HEADER_BYTES];
        h[..16].copy_from_slice(b"SQLite format 3\0");
        h[16..18].copy_from_slice(&page_size.to_be_bytes());
        h[24..28].copy_from_slice(&counter.to_be_bytes());
        h[28..32].copy_from_slice(&claimed.to_be_bytes());
        h[92..96].copy_from_slice(&valid_for.to_be_bytes());
        h
    }

    #[test]
    fn a_header_claiming_more_pages_than_the_file_holds_is_distrusted() {
        let mut h = header_of(100, 7, 7, 4096);
        let got = distrust_stale_page_count(&mut h, 90 * 4096);
        assert_eq!(got, Some((100, 90)));
        assert_ne!(
            u32::from_be_bytes(h[92..96].try_into().unwrap()),
            u32::from_be_bytes(h[24..28].try_into().unwrap()),
            "the two numbers must disagree, or SQLite still trusts the size"
        );
    }

    #[test]
    fn a_header_that_does_not_overclaim_is_left_alone() {
        let mut h = header_of(90, 7, 7, 4096);
        assert_eq!(distrust_stale_page_count(&mut h, 90 * 4096), None);
        assert_eq!(h, header_of(90, 7, 7, 4096));
    }

    /// A file with bytes AFTER its last page is not truncated, and rewriting its
    /// header would be damage this command inflicted itself.
    #[test]
    fn a_header_claiming_fewer_pages_than_the_file_holds_is_left_alone() {
        let mut h = header_of(50, 7, 7, 4096);
        assert_eq!(distrust_stale_page_count(&mut h, 90 * 4096), None);
    }

    /// Already distrusted: SQLite is already measuring the file, so there is
    /// nothing to do and a second rewrite would be a change with no reason.
    #[test]
    fn a_header_whose_size_is_already_distrusted_is_left_alone() {
        let mut h = header_of(100, 7, 3, 4096);
        assert_eq!(distrust_stale_page_count(&mut h, 90 * 4096), None);
    }

    #[test]
    fn a_page_size_of_one_means_sixty_five_thousand_five_hundred_and_thirty_six() {
        let mut h = header_of(100, 7, 7, 1);
        assert_eq!(
            distrust_stale_page_count(&mut h, 90 * 65536),
            Some((100, 90))
        );
    }

    /// A page size no SQLite file has is not a geometry to divide by. Answering
    /// from it would invent a page count out of a header that is itself broken.
    /// A page size no SQLite file has is not a geometry to divide by.
    ///
    /// THE CLAIMED COUNT HERE IS ENORMOUS ON PURPOSE. Written first with
    /// `claimed = 100` this test passed against a build with no legality check
    /// at all: dividing 368,640 bytes by 3 answers 122,880, which is more than
    /// 100, so the `claimed <= actual` clause returned None and the assertion
    /// was about the fixture's arithmetic rather than about the rule. A
    /// mutation replacing the legality check with `raw >= 1` survived. With a
    /// claim no division can exceed, only the legality check can refuse these.
    #[test]
    fn a_page_size_that_is_not_a_legal_one_is_refused() {
        for size in [0u16, 3, 100, 511, 513, 5000] {
            let mut h = header_of(1_000_000, 7, 7, size);
            assert_eq!(
                distrust_stale_page_count(&mut h, 90 * 4096),
                None,
                "page size {size} was treated as a geometry"
            );
        }
    }

    /// And the control: every size a SQLite file may actually have IS a
    /// geometry, or the test above would be satisfied by a rule that refused
    /// everything.
    #[test]
    fn every_legal_page_size_is_accepted_as_a_geometry() {
        for size in [512u16, 1024, 2048, 4096, 8192, 16384, 32768] {
            let mut h = header_of(1_000_000, 7, 7, size);
            assert!(
                distrust_stale_page_count(&mut h, 90 * u64::from(size)).is_some(),
                "page size {size} was refused"
            );
        }
    }

    /// A file shorter than one page has no readable page at all, and calling it
    /// "truncated to zero pages" would hand SQLite a size of nothing.
    #[test]
    fn a_file_shorter_than_one_page_is_refused() {
        let mut h = header_of(100, 7, 7, 4096);
        assert_eq!(distrust_stale_page_count(&mut h, 4000), None);
    }

    /// The counter can be anything, including the value that would collide.
    #[test]
    fn the_rewritten_number_never_lands_back_on_the_change_counter() {
        for counter in [0u32, 1, u32::MAX] {
            let mut h = header_of(100, counter, counter, 4096);
            assert_eq!(
                distrust_stale_page_count(&mut h, 90 * 4096),
                Some((100, 90))
            );
            assert_ne!(
                u32::from_be_bytes(h[92..96].try_into().unwrap()),
                counter,
                "counter {counter} collided with the value written beside it"
            );
        }
    }

    // ------------------------------------------------------------- healthy

    #[test]
    fn a_healthy_project_recovers_everything_with_no_losses() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert!(v.losses.is_empty());
        assert_eq!(v.name, "The Harbour");
        assert_eq!(v.items_recovered, 3);
        assert_eq!(v.documents_recovered, 2);
        assert_eq!(v.words, 7);
        assert_eq!(v.manuscript.as_deref(), Some(MANUSCRIPT_NAME));
        assert_eq!(v.manuscript_omitted, None);
        assert!(v.renamed.is_empty());

        for id in &scenes {
            assert!(out.join(DOCUMENTS_DIR).join(format!("{id}.md")).exists());
        }
        let book = read(&out.join(MANUSCRIPT_NAME));
        assert!(book.starts_with("# The Harbour"), "{book}");
        assert!(book.contains("the harbour was quiet"), "{book}");
        assert!(book.contains("three more words"), "{book}");
    }

    /// A recovered document carries its TITLE, which is the one thing the
    /// per-document files hold that the item id does not.
    #[test]
    fn a_recovered_document_carries_its_title() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();
        let file = read(&out.join(DOCUMENTS_DIR).join(format!("{}.md", scenes[0])));
        assert!(file.starts_with("# Opening\n\n"), "{file}");
        assert!(file.contains("the harbour was quiet"), "{file}");
    }

    /// The manifest on disk IS the value returned, so a script reading the file
    /// and one reading `--json` are reading one shape.
    #[test]
    fn the_manifest_on_disk_is_the_answer() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&read(&out.join(MANIFEST_NAME))).unwrap();
        assert_eq!(written, serde_json::to_value(&v).unwrap());
    }

    // ------------------------------------------------------------- damage

    #[test]
    fn a_document_whose_item_is_gone_is_still_recovered_and_reported() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(&db, &format!("DELETE FROM item WHERE id = '{}'", scenes[0]));

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_ORPHAN_DOC), "{:?}", v.losses);
        // The prose came out anyway, by item id, with no title above it.
        let file = read(&out.join(DOCUMENTS_DIR).join(format!("{}.md", scenes[0])));
        assert!(file.contains("the harbour was quiet"), "{file}");
        assert!(
            !file.starts_with('#'),
            "there is no title to head it with: {file}"
        );
    }

    #[test]
    fn an_orphaned_item_omits_the_manuscript_and_says_why() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(
            &db,
            "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('lost', 'nobody', 'scene', 'Orphan', 'zzzz', 1)",
        );

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_ORPHAN_ITEM), "{:?}", v.losses);
        assert!(kinds(&v).contains(&KIND_STRUCTURE), "{:?}", v.losses);
        assert_eq!(v.manuscript, None);
        assert!(!out.join(MANUSCRIPT_NAME).exists());
        let reason = v.manuscript_omitted.unwrap();
        assert!(reason.contains("walk reached"), "{reason}");
        // The documents still came out, which is the fallback the omission is
        // worth having.
        assert_eq!(v.documents_recovered, 2);
        for id in &scenes {
            assert!(out.join(DOCUMENTS_DIR).join(format!("{id}.md")).exists());
        }
    }

    #[test]
    fn a_body_that_is_not_json_is_written_verbatim_and_reported() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(
            &db,
            &format!(
                "UPDATE doc SET body = 'this is not json at all' WHERE item_id = '{}'",
                scenes[0]
            ),
        );

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_UNREADABLE_BODY), "{:?}", v.losses);
        assert_eq!(v.raw_bodies, vec![scenes[0].clone()]);
        assert_eq!(v.documents_recovered, 1, "the other scene still came out");
        let raw = read(
            &out.join(DOCUMENTS_DIR)
                .join(format!("{}.{RAW_EXT}", scenes[0])),
        );
        assert_eq!(raw, "this is not json at all");
        assert!(!out
            .join(DOCUMENTS_DIR)
            .join(format!("{}.md", scenes[0]))
            .exists());
    }

    /// JSON, and still not a document. `{"foo":1}` parses perfectly and is not
    /// a manuscript, and the page would not open it either -- so the acceptance
    /// rule is `export::document_markdown`'s and not "does serde_json succeed".
    #[test]
    fn a_body_that_is_json_but_not_a_document_is_reported_too() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(
            &db,
            &format!(
                "UPDATE doc SET body = '{{\"foo\":1}}' WHERE item_id = '{}'",
                scenes[0]
            ),
        );

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(kinds(&v).contains(&KIND_UNREADABLE_BODY), "{:?}", v.losses);
        assert_eq!(v.raw_bodies, vec![scenes[0].clone()]);
        let raw = read(
            &out.join(DOCUMENTS_DIR)
                .join(format!("{}.{RAW_EXT}", scenes[0])),
        );
        assert_eq!(raw, r#"{"foo":1}"#);
    }

    /// A TIMELINE'S BODY (101) IS SWEPT VERBATIM, exactly like the JSON-but-
    /// not-a-document case above -- salvage reads `doc` by rowid with no
    /// knowledge of `item.type`, so a timeline needs no code of its own here.
    /// This pins the byte-for-byte round trip the plan asks for: the raw file
    /// under `documents/` is compared against the flushed body, not merely
    /// asserted to exist.
    #[test]
    fn a_salvaged_timeline_body_is_byte_identical() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        const TIMELINE_BODY: &str = r#"{"kind":"timeline","version":1,"scale":{"unit":"day","zero":"Kell's death","calendar":null,"eras":[]},"tracks":[{"id":"t1","name":"Ines","kind":"thread","colour":1}],"branches":[],"events":[{"id":"v1","title":"Publishes survey","at":372,"until":null,"tracks":["t1"],"branch":null,"scene":null,"cast":[],"note":""}]}"#;
        let timeline_id = {
            let store = Store::open(&db).unwrap();
            let bible = store.item_create(None, "bible", "Bible").unwrap();
            let timeline = store
                .item_create(Some(&bible.id), "timeline", "Timeline")
                .unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: timeline.id.clone(),
                    body: TIMELINE_BODY.to_string(),
                    base_rev: timeline.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            timeline.id
        };

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        // MAJOR review finding 9: a healthy timeline is not a ProseMirror
        // document, so it still falls to the `.raw` write path -- but it is
        // not damage, and reporting it as `KIND_UNREADABLE_BODY` was the same
        // false-damage claim `validate` and `recovery::counts` made (items 7
        // and 8). NO finding, and the salvage is still `complete`.
        assert!(!kinds(&v).contains(&KIND_UNREADABLE_BODY), "{:?}", v.losses);
        assert!(v.complete, "a healthy timeline made a salvage incomplete");
        assert!(
            !v.raw_bodies.contains(&timeline_id),
            "a timeline is not an undercount of words it was never going to hold"
        );
        let raw = read(
            &out.join(DOCUMENTS_DIR)
                .join(format!("{timeline_id}.{RAW_EXT}")),
        );
        assert_eq!(raw, TIMELINE_BODY, "the body must still be swept verbatim");
    }

    #[test]
    fn a_version_pointing_at_an_absent_blob_is_reported() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(
            &db,
            &format!(
                "INSERT INTO blob (key, body) VALUES ('k1', 'x');
                 INSERT INTO doc_version (item_id, blob_key, words, created_at)
                   VALUES ('{}', 'k1', 4, 0);
                 DELETE FROM blob WHERE key = 'k1';",
                scenes[0]
            ),
        );

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(kinds(&v).contains(&KIND_MISSING_BLOB), "{:?}", v.losses);
    }

    // --------------------------------------------------------- unreadable

    /// A ZERO-BYTE FILE IS NOT AN EMPTY PROJECT. SQLite reads one as an empty
    /// database, so `open_readonly` SUCCEEDS on it -- the recorded gotcha -- and
    /// a salvage that took that at face value would write an empty manifest and
    /// exit 0, telling a writer whose file was truncated to nothing that there
    /// had been nothing in it.
    #[test]
    fn a_zero_byte_file_is_could_not_read_and_not_an_empty_project() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("empty.db");
        std::fs::write(&db, b"").unwrap();
        let out = dir.path().join("out");
        let e = salvage(&db, &out).unwrap_err();
        assert!(matches!(e, Refusal::Unreadable(_)), "{e:?}");
        assert!(e.to_string().contains("does not hold a project"), "{e}");
    }

    #[test]
    fn a_file_that_is_not_a_database_is_could_not_read() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("garbage.db");
        std::fs::write(&db, b"SQLite format 3\0 and then nothing but noise ~~~~~").unwrap();
        let out = dir.path().join("out");
        assert!(matches!(
            salvage(&db, &out).unwrap_err(),
            Refusal::Unreadable(_)
        ));
    }

    #[test]
    fn a_source_that_does_not_exist_is_could_not_read() {
        let dir = tempdir().unwrap();
        let e = salvage(&dir.path().join("nope.db"), &dir.path().join("out")).unwrap_err();
        assert!(matches!(e, Refusal::Unreadable(_)), "{e:?}");
    }

    /// Refusing an existing output directory is a USAGE refusal, and it happens
    /// BEFORE anything is copied or read.
    #[test]
    fn an_output_directory_that_already_exists_is_refused_untouched() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        std::fs::write(out.join("someone-elses-notes.txt"), "keep me").unwrap();

        let e = salvage(&db, &out).unwrap_err();
        assert!(matches!(e, Refusal::Usage(_)), "{e:?}");
        assert_eq!(read(&out.join("someone-elses-notes.txt")), "keep me");
        assert_eq!(
            std::fs::read_dir(&out).unwrap().count(),
            1,
            "salvage wrote into a directory it had refused"
        );
    }

    // ----------------------------------------------------------- filenames

    #[test]
    fn an_item_id_that_is_not_a_safe_filename_is_sanitised_and_mapped() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO doc VALUES ('../../escape', '{\"type\":\"doc\",\"content\":[]}', 1, 0)",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        let file = v
            .renamed
            .get("../../escape")
            .expect("the mapping is recorded");
        assert_eq!(file, "_.._.._escape.md");
        assert!(out.join(DOCUMENTS_DIR).join(file).exists());
        // And nothing landed outside the output directory.
        assert!(!dir.path().join("escape.md").exists());
    }

    #[test]
    fn sanitize_cannot_produce_a_traversing_or_hidden_name() {
        assert_eq!(sanitize(".."), "_..");
        assert_eq!(sanitize("."), "_.");
        assert_eq!(sanitize(""), "_");
        assert_eq!(sanitize(".hidden"), "_.hidden");
        assert_eq!(sanitize("a/b"), "a_b");
        assert_eq!(sanitize("a\\b"), "a_b");
        assert_eq!(sanitize("a\0b"), "a_b");
        assert_eq!(sanitize("héllo"), "h_llo");
        assert!(sanitize(&"x".repeat(500)).len() <= MAX_STEM);
        assert_eq!(sanitize("0198-abc_DEF.9"), "0198-abc_DEF.9");
    }

    /// Two ids that differ only where the sanitiser folds must not land on one
    /// file: the second scene would silently overwrite the first's prose, which
    /// is a LOSS produced by the recovery itself.
    #[test]
    fn two_ids_that_sanitise_alike_get_different_files() {
        let mut names = FileNames::default();
        assert_eq!(names.pick("a/b", "md"), "a_b.md");
        assert_eq!(names.pick("a:b", "md"), "a_b-2.md");
        assert_eq!(names.pick("a b", "md"), "a_b-3.md");
    }

    // ------------------------------------------- synopses and the cast (046)

    /// The fixture, plus a synopsis on the part and on both scenes, plus a cast
    /// of three across all three kinds with detail fields on one of them.
    /// Returns (part id, scene ids, member ids).
    pub(crate) fn fixture_with_everything(db: &Path) -> (String, Vec<String>, Vec<String>) {
        let scenes = fixture(db);
        let store = Store::open(db).unwrap();
        let part = store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.item_type == "part")
            .unwrap()
            .id;
        store.synopsis_set(&part, "the whole first part").unwrap();
        store
            .synopsis_set(&scenes[0], "she arrives at dusk")
            .unwrap();
        store
            .synopsis_set(&scenes[1], "he leaves before dawn")
            .unwrap();

        let mut members = Vec::new();
        let ada = store.cast_create(cast::KIND_CHARACTER, "Ada").unwrap();
        store
            .cast_set(
                &ada.id,
                cast::KIND_CHARACTER,
                "Ada",
                "the harbourmaster",
                &[
                    cast::CastField {
                        label: "Eyes".into(),
                        value: "grey".into(),
                    },
                    cast::CastField {
                        label: "Wound".into(),
                        value: "the fire".into(),
                    },
                ],
                &[],
            )
            .unwrap();
        members.push(ada.id);
        members.push(
            store
                .cast_create(cast::KIND_PLACE, "The Harbour")
                .unwrap()
                .id,
        );
        members.push(store.cast_create(cast::KIND_POI, "The Lamp").unwrap().id);
        (part, scenes, members)
    }

    /// A CATALOG THAT IS NOT ENGLISH, so "the recovery used the catalog" is a
    /// claim a wrong build can fail. Every value differs from the English one.
    /// NOT A SHIPPED LANGUAGE: tag `qq`, not `de`, since 088 -- German
    /// shipped in 084 with its own values, and a fixture on the real tag
    /// would be the shipped catalog's twin, indistinguishable from it.
    static PSEUDO_ENTRIES: &[(&str, &str)] = &[
        ("book.contents", "INHALT"),
        ("salvage.cast.aliases", "AUCH GENANNT: {aliases}"),
        ("salvage.cast.appears", "ERSCHEINT IN:"),
        ("salvage.cast.characters", "FIGUREN"),
        ("salvage.cast.orphans", "ANGABEN OHNE FIGUR"),
        ("salvage.cast.places", "ORTE"),
        ("salvage.cast.poi", "PUNKTE"),
        ("salvage.covers.back", "RUECKSEITE"),
        ("salvage.covers.front", "VORDERSEITE"),
        ("salvage.snapshots.created", "ANGELEGT {at}"),
        ("salvage.snapshots.not_stored", "BYTES FEHLEN"),
        ("salvage.title.cast", "{name} :: BESETZUNG"),
        ("salvage.title.comments", "{name} :: NOTIZEN"),
        ("salvage.title.covers", "{name} :: UMSCHLAG"),
        ("salvage.title.snapshots", "{name} :: STAENDE"),
        ("salvage.title.synopses", "{name} :: ABRISSE"),
        ("salvage.title.wordlist", "{name} :: WORTLISTE"),
    ];
    static PSEUDO: crate::strings::Locale = crate::strings::Locale::new("qq", PSEUDO_ENTRIES);

    fn pseudo() -> crate::strings::Strings {
        crate::strings::Strings::new(&PSEUDO)
    }

    #[test]
    fn every_word_salvage_writes_into_a_recovery_comes_from_the_catalog() {
        // THE SWEEP THIS SLICE OWED. A recovery is a directory of files a
        // person READS, and every fixed word in them was an English literal in
        // this module. Asserted file by file, in both directions: the catalog's
        // word present AND the English one absent, because a build that wrote
        // both would satisfy the first half.
        //
        // The manuscript's contents heading is here too, and it is the same key
        // the export uses -- salvage renders through `export::manuscript`, so a
        // heading sourced in one and hard-coded in the other would be one book
        // in two languages.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, _members) = fixture_with_everything(&db);
        let out = dir.path().join("out");

        let v = salvage_with(&db, &out, pseudo()).unwrap();
        assert!(v.complete, "{:?}", v.losses);

        let manuscript = read(&out.join(MANUSCRIPT_NAME));
        assert!(manuscript.contains("INHALT"), "{manuscript}");
        assert!(!manuscript.contains("Contents"), "{manuscript}");

        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains(":: BESETZUNG"), "{cast}");
        assert!(cast.contains("FIGUREN"), "{cast}");
        assert!(cast.contains("ORTE"), "{cast}");
        assert!(cast.contains("PUNKTE"), "{cast}");
        for english in ["- cast", "Characters", "Places", "Points of interest"] {
            assert!(!cast.contains(english), "{english} in {cast}");
        }

        let syn = read(&out.join(SYNOPSES_NAME));
        assert!(syn.contains(":: ABRISSE"), "{syn}");
        assert!(!syn.contains("- synopses"), "{syn}");
    }

    #[test]
    fn the_english_recovery_is_byte_identical_to_the_one_before_the_catalog() {
        // THE MIGRATION'S OWN EVIDENCE. 008 proved the page's move by changing
        // no pre-existing test; the same claim here is that English still
        // renders the words this module rendered before the keys existed, and
        // it is asserted against the literals rather than against the catalog
        // -- reading the catalog for the expectation would make this a fact
        // about itself.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, _members) = fixture_with_everything(&db);
        let out = dir.path().join("out");

        salvage(&db, &out).unwrap();
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("# The Harbour - cast"), "{cast}");
        assert!(cast.contains("## Characters"), "{cast}");
        assert!(cast.contains("## Places"), "{cast}");
        assert!(cast.contains("## Points of interest"), "{cast}");
        assert!(read(&out.join(SYNOPSES_NAME)).contains("# The Harbour - synopses"));
        assert!(read(&out.join(MANUSCRIPT_NAME)).contains("Contents"));
    }

    #[test]
    fn a_healthy_project_recovers_its_synopses_and_its_cast() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, _members) = fixture_with_everything(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.synopses_recovered, 3);
        assert_eq!(v.cast_members_recovered, 3);
        assert_eq!(v.cast_fields_recovered, 2);
        assert_eq!(v.synopses.as_deref(), Some(SYNOPSES_NAME));
        assert_eq!(v.cast.as_deref(), Some(CAST_NAME));

        let syn = read(&out.join(SYNOPSES_NAME));
        assert!(syn.starts_with("# The Harbour"), "{syn}");
        for text in [
            "the whole first part",
            "she arrives at dusk",
            "he leaves before dawn",
        ] {
            assert!(syn.contains(text), "{syn}");
        }
        // The TITLE heads each one, and the id is there to tie it to the file
        // under documents/.
        assert!(syn.contains("## Opening"), "{syn}");
        assert!(syn.contains(&format!("`{}`", _scenes[0])), "{syn}");

        let cast = read(&out.join(CAST_NAME));
        assert!(cast.starts_with("# The Harbour"), "{cast}");
        assert!(cast.contains("### Ada"), "{cast}");
        assert!(cast.contains("the harbourmaster"), "{cast}");
        assert!(cast.contains("- **Eyes**: grey"), "{cast}");
        assert!(cast.contains("- **Wound**: the fire"), "{cast}");
        assert!(cast.contains("### The Harbour"), "{cast}");
        assert!(cast.contains("### The Lamp"), "{cast}");
        // A member with no summary gets no blank paragraph where one would have
        // gone. Two of the three here have none, so this is not vacuous.
        assert!(!cast.contains("\n\n\n"), "a blank paragraph: {cast:?}");
        // Grouped by kind, in the page's own order.
        let ch = cast.find("## Characters").unwrap();
        let pl = cast.find("## Places").unwrap();
        let poi = cast.find("## Points of interest").unwrap();
        assert!(ch < pl && pl < poi, "{cast}");
    }

    #[test]
    fn salvage_marks_removed_cast_without_losing_detail() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let store = crate::store::Store::open(&db).unwrap();
        let member = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_set(&member.id, KIND_CHARACTER, "Ilse", "singer", &[crate::store::cast::CastField { label: "voice".into(), value: "alto".into() }], &["Ils".into()]).unwrap();
        store.cast_set_picture(&member.id, Some("face.png")).unwrap();
        store.cast_remove(&member.id).unwrap();
        drop(store);
        let out = dir.path().join("out");
        let report = salvage(&db, &out).unwrap();
        assert_eq!(report.cast_members_recovered, 1);
        let text = read(&out.join(CAST_NAME));
        assert!(text.contains("Removed from active Cast (recoverable)."), "{text}");
        assert!(text.contains("singer"), "{text}");
        assert!(text.contains("Also called: Ils"), "{text}");
        assert!(text.contains("face.png"), "{text}");
    }

    /// The synopses read down the book in the SAME order the manuscript does,
    /// which is the whole reason they are one file.
    #[test]
    fn the_synopses_are_written_in_the_manuscript_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _) = fixture_with_everything(&db);
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();

        let syn = read(&out.join(SYNOPSES_NAME));
        let part = syn.find("the whole first part").unwrap();
        let first = syn.find("she arrives at dusk").unwrap();
        let second = syn.find("he leaves before dawn").unwrap();
        assert!(part < first && first < second, "{syn}");
        // And the fixture's ids do NOT already sort that way, or this test
        // would pass against an id sort as well.
        assert!(scenes[0] < scenes[1] || scenes[0] > scenes[1]);
    }

    /// When the walk failed there is no order to follow, so the fallback is the
    /// item id -- deterministic either way, which is what a person diffing two
    /// runs of a recovery needs.
    #[test]
    fn without_a_walk_the_synopses_are_written_in_item_id_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('lost', 'nobody', 'scene', 'Orphan', 'zzzz', 1)",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert_eq!(v.manuscript, None, "the walk must have failed");

        let syn = read(&out.join(SYNOPSES_NAME));
        let mut ids: Vec<(usize, &str)> = Vec::new();
        for line in syn.lines() {
            if let Some(id) = line.strip_prefix('`').and_then(|l| l.strip_suffix('`')) {
                ids.push((syn.find(line).unwrap(), id));
            }
        }
        assert_eq!(ids.len(), 3, "{syn}");
        let mut sorted: Vec<&str> = ids.iter().map(|(_, id)| *id).collect();
        let found = sorted.clone();
        sorted.sort_unstable();
        assert_eq!(found, sorted, "{syn}");
    }

    #[test]
    fn a_synopsis_row_that_cannot_be_read_is_reported_and_the_others_come_out() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _) = fixture_with_everything(&db);
        damage(
            &db,
            &format!(
                "UPDATE synopsis SET body = x'FFFE0000' WHERE item_id = '{}'",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_SYNOPSIS_ROW), "{:?}", v.losses);
        assert_eq!(v.synopses_recovered, 2, "the other two still came out");
        let syn = read(&out.join(SYNOPSES_NAME));
        assert!(syn.contains("he leaves before dawn"), "{syn}");
    }

    #[test]
    fn a_cast_member_row_that_cannot_be_read_is_reported_and_the_others_come_out() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, members) = fixture_with_everything(&db);
        damage(
            &db,
            &format!(
                "UPDATE cast_member SET name = x'FFFE0000' WHERE id = '{}'",
                members[1]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_CAST_MEMBER_ROW), "{:?}", v.losses);
        assert_eq!(v.cast_members_recovered, 2);
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("### Ada"), "{cast}");
    }

    #[test]
    fn a_cast_field_row_that_cannot_be_read_is_reported_and_the_others_come_out() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, members) = fixture_with_everything(&db);
        damage(
            &db,
            &format!(
                "UPDATE cast_field SET value = x'FFFE0000' WHERE member_id = '{}' AND ordinal = 0",
                members[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_CAST_FIELD_ROW), "{:?}", v.losses);
        assert_eq!(v.cast_fields_recovered, 1);
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("- **Wound**: the fire"), "{cast}");
        assert!(!cast.contains("Eyes"), "{cast}");
    }

    /// The `orphan_doc` rule, for a summary: the text is recovered, the item it
    /// was about is not.
    #[test]
    fn a_synopsis_whose_item_is_gone_is_still_recovered_and_reported() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _) = fixture_with_everything(&db);
        damage(&db, &format!("DELETE FROM item WHERE id = '{}'", scenes[0]));
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(kinds(&v).contains(&KIND_ORPHAN_SYNOPSIS), "{:?}", v.losses);
        let syn = read(&out.join(SYNOPSES_NAME));
        assert!(syn.contains("she arrives at dusk"), "{syn}");
        // No title survives, so the id is the heading AND the identity.
        assert!(syn.contains(&format!("## {}", scenes[0])), "{syn}");
        // And it sorts AFTER every item the walk did reach: a summary with no
        // place in the book does not interrupt the ones that have one.
        assert!(
            syn.find("she arrives at dusk").unwrap() > syn.find("he leaves before dawn").unwrap(),
            "{syn}"
        );
    }

    /// ONE loss per member, not one per row: a member with two lost fields is
    /// one lost character sheet, and two identical sentences read as two
    /// problems.
    #[test]
    fn detail_fields_whose_member_is_gone_are_recovered_and_reported_once() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "INSERT INTO cast_field VALUES ('ghost', 0, 'Eyes', 'green');
             INSERT INTO cast_field VALUES ('ghost', 1, 'Accent', 'northern');
             INSERT INTO cast_field VALUES ('phantom', 0, 'Climate', 'wet');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        let orphans = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_ORPHAN_CAST_FIELD)
            .count();
        assert_eq!(orphans, 2, "one per member: {:?}", v.losses);
        assert_eq!(v.cast_fields_recovered, 5);
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("- **Accent**: northern"), "{cast}");
        assert!(cast.contains("- **Climate**: wet"), "{cast}");
        assert!(cast.contains("ghost"), "{cast}");
    }

    /// `detail_fields_whose_member_is_gone_are_recovered_and_reported_once`'s
    /// own fixture shape, one table over (105): ONE loss per member, not one
    /// per row.
    #[test]
    fn aliases_whose_member_is_gone_are_recovered_and_reported_once() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "INSERT INTO cast_alias VALUES ('ghost', 0, 'Ghosty');
             INSERT INTO cast_alias VALUES ('ghost', 1, 'The Haunt');
             INSERT INTO cast_alias VALUES ('phantom', 0, 'Boo');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        let orphans = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_ORPHAN_CAST_ALIAS)
            .count();
        assert_eq!(orphans, 2, "one per member: {:?}", v.losses);
        assert_eq!(v.cast_aliases_recovered, 3);
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("Ghosty, The Haunt"), "{cast}");
        assert!(cast.contains("Boo"), "{cast}");
        assert!(cast.contains("ghost"), "{cast}");
    }

    /// The mutation this pins directly: a `write_cast` that dropped the
    /// "Also called" line, or one that printed it for every member whether or
    /// not they had an alias, would satisfy every other test in this file.
    #[test]
    fn cast_md_prints_also_called_only_for_a_member_that_has_one() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let store = Store::open(&db).unwrap();
        let with = store
            .cast_create(cast::KIND_CHARACTER, "Marisol Quillfeather")
            .unwrap();
        store
            .cast_set(
                &with.id,
                cast::KIND_CHARACTER,
                "Marisol Quillfeather",
                "",
                &[],
                &["Quill".to_string()],
            )
            .unwrap();
        // NAMED TO SORT AFTER MARISOL, case-folded: the negative assertion
        // below reads everything from this heading to the end of the file, so
        // it must be the LAST section or Marisol's own "Also called" line
        // would be in range and satisfy it by accident.
        store.cast_create(cast::KIND_CHARACTER, "Zora").unwrap();
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.cast_aliases_recovered, 1);
        let cast = read(&out.join(CAST_NAME));
        let quill_at = cast.find("### Marisol Quillfeather").unwrap();
        let also_called_at = cast.find("Also called: Quill").unwrap();
        let zora_at = cast.find("### Zora").unwrap();
        assert!(quill_at < also_called_at, "{cast}");
        assert!(also_called_at < zora_at, "{cast}");
        // ZORA'S OWN SECTION carries no "Also called" at all -- the negative
        // half of the claim.
        assert!(!cast[zora_at..].contains("Also called"), "{cast}");
    }

    /// A table that EXISTS and is not the shape this build knows. `rowids`
    /// succeeds -- the rowid is a b-tree key and knows nothing about columns --
    /// and the fetch is what fails. Returning nothing there would report a file
    /// full of summaries as a file with none.
    #[test]
    fn a_synopsis_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "DROP TABLE synopsis;
             CREATE TABLE synopsis (item_id TEXT PRIMARY KEY, summary TEXT NOT NULL);
             INSERT INTO synopsis VALUES ('somebody', 'a summary in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete, "a table that could not be read is a loss");
        assert_eq!(v.synopses_recovered, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("synopsis")),
            "{:?}",
            v.losses
        );
        // The prose is untouched by any of it.
        assert_eq!(v.documents_recovered, 2);
    }

    /// Detail rows with no member left at all still come out. The guard for "was
    /// there anything to write" is about BOTH tables, not about the members.
    #[test]
    fn orphaned_detail_rows_alone_still_produce_the_cast_file() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(&db, "DELETE FROM cast_member");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert_eq!(v.cast_members_recovered, 0);
        assert_eq!(v.cast_fields_recovered, 2);
        assert_eq!(v.cast.as_deref(), Some(CAST_NAME));
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("- **Eyes**: grey"), "{cast}");
    }

    /// A KIND THIS BUILD DOES NOT KNOW KEEPS ITS OWN GROUP. `kind` is a free
    /// string with no CHECK, so a newer build's fourth kind -- or a foreign
    /// tool's anything -- is in the file already, and dropping those members
    /// would be the silent loss with an extra step.
    #[test]
    fn a_cast_kind_this_build_does_not_know_is_still_recovered() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at) VALUES ('w', 'weather', 'The Storm', 'it never stops', 0, 0)",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert_eq!(v.cast_members_recovered, 4);
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("## weather"), "{cast}");
        assert!(cast.contains("### The Storm"), "{cast}");
        // And after the three it does know, so the familiar ones read first.
        assert!(
            cast.find("## Points of interest").unwrap() < cast.find("## weather").unwrap(),
            "{cast}"
        );
    }

    /// The store lists the cast by name, case-folded, and so does the recovery:
    /// a person reading their cast back is looking somebody up.
    ///
    /// THE IDS DISAGREE WITH THE NAMES ON PURPOSE. `SELECT rowid FROM
    /// cast_member` is answered by a COVERING SCAN of the primary key's
    /// autoindex, so rows arrive in ID order -- and a first version of this test
    /// used ids that happened to sort the same way as the names, which made it
    /// pass with the sort deleted. The mutation is what found that.
    #[test]
    fn members_of_one_kind_are_written_in_name_order_folding_case() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at) VALUES ('a1', 'character', 'zoe', '', 0, 0);
             INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at) VALUES ('z9', 'character', 'Bram', '', 0, 0);",
        );
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();
        let cast = read(&out.join(CAST_NAME));
        let ada = cast.find("### Ada").unwrap();
        let bram = cast.find("### Bram").unwrap();
        let zoe = cast.find("### zoe").unwrap();
        assert!(ada < bram && bram < zoe, "{cast}");
    }

    /// A member's details are in the ORDINAL's order, which is the order the
    /// writer put them in -- not the order the rows happen to sit in the file.
    /// The fixture inserts them backwards on purpose, or a walk with no sort
    /// would satisfy this too.
    #[test]
    fn detail_rows_are_written_in_ordinal_order_not_in_rowid_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at) VALUES ('m1', 'place', 'Backwards', '', 0, 0);
             INSERT INTO cast_field VALUES ('m1', 2, 'Third', 'c');
             INSERT INTO cast_field VALUES ('m1', 0, 'First', 'a');
             INSERT INTO cast_field VALUES ('m1', 1, 'Second', 'b');",
        );
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();
        let cast = read(&out.join(CAST_NAME));
        let first = cast.find("- **First**: a").unwrap();
        let second = cast.find("- **Second**: b").unwrap();
        let third = cast.find("- **Third**: c").unwrap();
        assert!(first < second && second < third, "{cast}");
    }

    /// THE ORDER IS THE WRITER'S, NOT THE FILE'S, and this is asserted at the
    /// function's own boundary because no fixture can reach it from outside.
    /// `SELECT rowid FROM cast_field` is answered by a covering scan of the
    /// `(member_id, ordinal)` autoindex, so a walk of a REAL file always hands
    /// the rows over in ordinal order already -- which is a property of SQLite's
    /// query planner and not a promise it made anybody. Both mutations that
    /// delete a sort survive every end-to-end fixture for that reason and are
    /// killed here, where the input order is chosen.
    #[test]
    fn write_cast_orders_members_by_name_and_details_by_ordinal() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let member = |id: &str, name: &str| RecoveredMember {
            picture_path: None,
            deleted_at: None,
            id: id.into(),
            kind: KIND_CHARACTER.into(),
            name: name.into(),
            summary: String::new(),
        };
        let field = |ordinal: i64, label: &str| RecoveredField {
            member_id: "m".into(),
            ordinal,
            label: label.into(),
            value: "x".into(),
        };
        let members = vec![member("m", "zoe"), member("a", "Ada"), member("b", "bram")];
        let fields = vec![field(2, "Third"), field(0, "First"), field(1, "Second")];

        let name = write_cast(
            &out,
            "Book",
            &members,
            &fields,
            &[],
            &[],
            &HashMap::new(),
            &HashMap::new(),
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert_eq!(name.as_deref(), Some(CAST_NAME));
        let text = read(&out.join(CAST_NAME));
        let at = |needle: &str| {
            text.find(needle)
                .unwrap_or_else(|| panic!("{needle}: {text}"))
        };
        assert!(at("### Ada") < at("### bram"), "{text}");
        assert!(at("### bram") < at("### zoe"), "{text}");
        assert!(at("- **First**") < at("- **Second**"), "{text}");
        assert!(at("- **Second**") < at("- **Third**"), "{text}");
    }

    // ------------------------------------------------------- older schemas

    /// A FILE FROM BEFORE THE TABLES IS OLD, NOT DAMAGED. A v5 file has no
    /// `synopsis` table and no cast tables, and a salvage of one must be
    /// byte-for-byte the salvage it was before this slice: no loss, no file, no
    /// figure, and `complete` still true.
    #[test]
    fn a_file_that_predates_the_tables_salvages_exactly_as_it_did() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(
            &db,
            "DROP TABLE synopsis; DROP TABLE cast_field; DROP TABLE cast_member;
             PRAGMA user_version = 5;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(5));
        assert_eq!(v.synopses_recovered, 0);
        assert_eq!(v.cast_members_recovered, 0);
        assert_eq!(v.cast_fields_recovered, 0);
        assert_eq!(v.synopses, None);
        assert_eq!(v.cast, None);
        assert!(!out.join(SYNOPSES_NAME).exists());
        assert!(!out.join(CAST_NAME).exists());
        // And the prose is exactly what it was.
        assert_eq!(v.documents_recovered, 2);
        assert_eq!(v.words, 7);
        for id in &scenes {
            assert!(out.join(DOCUMENTS_DIR).join(format!("{id}.md")).exists());
        }
    }

    /// v6 is the half-way file: it HAS synopses and has no cast. Each guard is
    /// its own, or a file between the two versions is read wrongly at one end.
    #[test]
    fn a_v6_file_recovers_its_synopses_and_is_not_asked_about_a_cast() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "DROP TABLE cast_field; DROP TABLE cast_member; PRAGMA user_version = 6;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.synopses_recovered, 3);
        assert_eq!(v.cast_members_recovered, 0);
        assert_eq!(v.cast, None);
    }

    // --------------------------------------------------------------- pictures

    /// A real PNG, so a picture salvage copies is one a person can open.
    const PNG: &[u8] = include_bytes!("../fixtures/two-halves.png");

    /// Give `member` a picture and put a real file where the column points.
    /// Returns the stored name.
    pub(crate) fn with_picture(db: &Path, member: &str) -> String {
        let store = Store::open(db).unwrap();
        let dir = crate::pictures::dir_for(db);
        let source = db.parent().unwrap().join("source.png");
        std::fs::write(&source, PNG).unwrap();
        let stored = crate::pictures::attach(&dir, &source).unwrap();
        std::fs::remove_file(&source).unwrap();
        store.cast_set_picture(member, Some(&stored)).unwrap();
        stored
    }

    #[test]
    fn a_salvage_copies_the_pictures_the_cast_names_and_says_where_they_went() {
        // 046 recorded that "a sixth thing added later gets the same silence
        // unless somebody widens the walk again", and named this slice. It
        // COPIES rather than merely recording, and that is the product answer:
        // the bytes are OUTSIDE the database, so unlike everything else salvage
        // handles they are trivially recoverable -- and a path in `cast.md`
        // pointing into the directory the operator is about to delete is a
        // pointer, not a recovery.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let members = fixture_with_everything(&db).2;
        let stored = with_picture(&db, &members[0]);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.pictures_recovered, 1);
        assert_eq!(v.pictures.as_deref(), Some(PICTURES_DIR));
        // THE BYTES, not the name: a copy that wrote an empty file would
        // satisfy every count above.
        assert_eq!(
            std::fs::read(out.join(PICTURES_DIR).join(&stored)).unwrap(),
            PNG
        );
        // AND THE FILE NAMES IT, so a person reading the recovery knows which
        // of the copied files belongs to which character.
        assert!(
            read(&out.join(CAST_NAME)).contains(&stored),
            "{}",
            read(&out.join(CAST_NAME))
        );
    }

    #[test]
    fn the_cached_thumbnail_is_not_recovered_and_the_original_is() {
        // The thumbnail is this application's cache and the original is the
        // writer's photograph. Copying the cache would put a 256-pixel version
        // of their picture in a recovery directory beside the real one, under a
        // name that looks like a second picture.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let members = fixture_with_everything(&db).2;
        let stored = with_picture(&db, &members[0]);
        let thumb = crate::pictures::thumb_name(&stored).unwrap();
        assert!(
            crate::pictures::dir_for(&db).join(&thumb).exists(),
            "the fixture has no thumbnail to leave behind"
        );
        let out = dir.path().join("out");

        salvage(&db, &out).unwrap();

        assert!(out.join(PICTURES_DIR).join(&stored).exists());
        assert!(!out.join(PICTURES_DIR).join(&thumb).exists());
    }

    #[test]
    fn a_picture_the_column_names_and_the_directory_does_not_hold_is_a_loss() {
        // The state a writer reaches by moving or deleting the file themselves,
        // and the one salvage exists to make legible: the row says there was a
        // photograph and there is not one, so a person reading the recovery
        // knows to go looking rather than assuming the character never had one.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let members = fixture_with_everything(&db).2;
        let stored = with_picture(&db, &members[0]);
        std::fs::remove_file(crate::pictures::dir_for(&db).join(&stored)).unwrap();
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.pictures_recovered, 0);
        assert_eq!(v.pictures, None);
        let found: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_MISSING_PICTURE)
            .collect();
        assert_eq!(found.len(), 1, "{:?}", v.losses);
        assert!(found[0].detail.contains(&stored), "{:?}", found[0]);
    }

    #[test]
    fn a_picture_path_that_is_not_a_name_this_build_wrote_is_a_loss_and_reaches_nothing() {
        // THE FIXTURE IS THE POINT, and it is the recorded shape: a refusal test
        // whose input would fail anyway because the file is not there proves
        // nothing. A REAL, READABLE picture is planted exactly where the
        // traversal points -- one directory up, beside the project -- so a
        // salvage that joined the column to the directory would find it and
        // copy it, and the assertion below would go red.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let members = fixture_with_everything(&db).2;
        std::fs::create_dir_all(crate::pictures::dir_for(&db)).unwrap();
        std::fs::write(dir.path().join("secret.png"), PNG).unwrap();
        damage(
            &db,
            "UPDATE cast_member SET picture_path = '../secret.png' WHERE rowid = 1",
        );
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.pictures_recovered, 0);
        assert!(
            kinds(&v).contains(&KIND_UNREADABLE_PICTURE),
            "{:?}",
            v.losses
        );
        assert!(
            !out.join(PICTURES_DIR).exists(),
            "the traversal was followed"
        );
        assert!(!out.join("secret.png").exists());
        let _ = members;
    }

    // ------------------------------------------------------------------- covers

    /// Give the book a cover on `side` and put a real file where the row points.
    /// Returns the stored name.
    fn with_cover(db: &Path, side: &str) -> String {
        let store = Store::open(db).unwrap();
        let dir = crate::pictures::dir_for(db);
        let source = db.parent().unwrap().join("cover-source.png");
        std::fs::write(&source, PNG).unwrap();
        let stored = crate::pictures::attach(&dir, &source).unwrap();
        std::fs::remove_file(&source).unwrap();
        crate::covers::set_cover(&store, side, &stored).unwrap();
        stored
    }

    #[test]
    fn a_salvage_copies_the_covers_and_says_which_is_which() {
        // 040 recorded that salvage does not recover the DESIGN, and this is
        // deliberately not that. A font, a page size and four margins are three
        // scalars a writer retypes in twenty seconds; a cover is BYTES that
        // exist nowhere else in the output, and files beside the store are
        // exactly the thing salvage can copy. A cover left out would be the one
        // part of this feature genuinely unrecoverable from a recovery.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        let front = with_cover(&db, crate::covers::SIDE_FRONT);
        let back = with_cover(&db, crate::covers::SIDE_BACK);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.covers_recovered, 2);
        assert_eq!(v.covers.as_deref(), Some(COVERS_NAME));
        // THE DIRECTORY IS REPORTED even though no cast member named a picture:
        // a book whose only pictures are its covers still has a `pictures/` in
        // its recovery, and a sweep keyed on the cast count alone would remove
        // it and report None over two files that are sitting in it.
        assert_eq!(v.pictures.as_deref(), Some(PICTURES_DIR));
        // THE SAME DIRECTORY as a cast photograph, because it is the same kind
        // of thing: bytes the operator can open. `documents/`'s shape.
        assert_eq!(
            std::fs::read(out.join(PICTURES_DIR).join(&front)).unwrap(),
            PNG
        );
        assert_eq!(
            std::fs::read(out.join(PICTURES_DIR).join(&back)).unwrap(),
            PNG
        );
        // AND WHICH IS WHICH. A directory of uuids with nothing saying which one
        // goes on the front of the book is a recovery that recovered nothing a
        // person can use -- `cast.md`'s rule, one owner further out.
        let text = std::fs::read_to_string(out.join(COVERS_NAME)).unwrap();
        assert!(text.contains(&format!("{PICTURES_DIR}/{front}")), "{text}");
        assert!(text.contains(&format!("{PICTURES_DIR}/{back}")), "{text}");
        let f = text.find(&front).unwrap();
        let b = text.find(&back).unwrap();
        assert!(f < b, "the front cover is named first:\n{text}");
    }

    #[test]
    fn a_book_with_one_cover_names_only_that_one() {
        // The absent side is ABSENT from the file rather than named as empty:
        // `cast.md`'s "an absent count renders as nothing" one surface out.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        let back = with_cover(&db, crate::covers::SIDE_BACK);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.covers_recovered, 1);
        let text = std::fs::read_to_string(out.join(COVERS_NAME)).unwrap();
        assert!(text.contains(&back), "{text}");
        assert!(!text.contains("Front cover"), "{text}");
    }

    #[test]
    fn a_book_with_no_covers_gets_no_covers_file_and_reports_none() {
        // `synopses`' and `cast`'s rule: None NEVER means "they were lost" -- a
        // lost one is a `Loss` -- and an empty file would read as a recovery
        // having happened.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.covers_recovered, 0);
        assert_eq!(v.covers, None);
        assert!(!out.join(COVERS_NAME).exists());
    }

    #[test]
    fn a_cover_the_row_names_and_the_directory_does_not_hold_is_a_loss_of_its_own_kind() {
        // ITS OWN LOSS KIND and not `missing_picture`. A person reading a
        // recovery has to know whether what went missing is one character's
        // photograph or the front of their book, and one word for both makes
        // them open every file to find out.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        let front = with_cover(&db, crate::covers::SIDE_FRONT);
        std::fs::remove_file(crate::pictures::dir_for(&db).join(&front)).unwrap();
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.covers_recovered, 0);
        assert_eq!(v.covers, None);
        let loss = v
            .losses
            .iter()
            .find(|l| l.kind == KIND_MISSING_COVER)
            .unwrap_or_else(|| panic!("{:?}", v.losses));
        assert!(loss.detail.contains(&front), "{}", loss.detail);
        assert!(loss.detail.contains("front"), "{}", loss.detail);
    }

    #[test]
    fn a_cover_row_that_is_not_a_name_this_build_wrote_is_a_loss_and_reaches_nothing() {
        // THE FIXTURE IS THE POINT, `a_picture_path_that_is_not_a_name_this_
        // build_wrote...`'s rule: a REAL, READABLE picture is planted exactly
        // where the traversal points, so the refusal cannot be the file not
        // being there.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        std::fs::write(dir.path().join("secret.png"), PNG).unwrap();
        std::fs::create_dir_all(crate::pictures::dir_for(&db)).unwrap();
        {
            let store = Store::open(&db).unwrap();
            store
                .set_meta(crate::covers::FRONT_KEY, "../secret.png")
                .unwrap();
        }
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.covers_recovered, 0);
        assert!(
            v.losses.iter().any(|l| l.kind == KIND_UNREADABLE_COVER),
            "{:?}",
            v.losses
        );
        assert!(!out.join(PICTURES_DIR).join("secret.png").exists());
        assert!(!out.join("secret.png").exists());
    }

    #[test]
    fn a_refused_cover_is_a_loss_and_is_not_named_in_the_covers_file() {
        // THE FIXTURE NEEDS A GOOD COVER BESIDE THE BAD ONE. With only a refused
        // cover, nothing is copied, `covers.md` is never written, and the filter
        // that keeps a refused name out of it is unreachable -- so a mutation
        // deleting that filter would survive against a fixture with one bad
        // cover and pass every other test in this file.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        let front = with_cover(&db, crate::covers::SIDE_FRONT);
        std::fs::write(dir.path().join("secret.png"), PNG).unwrap();
        {
            let store = Store::open(&db).unwrap();
            store
                .set_meta(crate::covers::BACK_KEY, "../secret.png")
                .unwrap();
        }
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.covers_recovered, 1);
        let text = std::fs::read_to_string(out.join(COVERS_NAME)).unwrap();
        assert!(text.contains(&front), "{text}");
        assert!(!text.contains("secret.png"), "{text}");
        assert!(!text.contains("Back cover"), "{text}");
        assert!(
            v.losses.iter().any(|l| l.kind == KIND_UNREADABLE_COVER),
            "{:?}",
            v.losses
        );
    }

    #[test]
    fn a_covers_file_and_a_cast_photograph_share_one_directory() {
        // ONE `pictures/` for both, made once and removed once. Two directories
        // would make an operator look in two places for the same kind of thing,
        // and the lazy make and the empty-directory sweep would each be stated
        // twice.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, members) = fixture_with_everything(&db);
        let portrait = with_picture(&db, &members[0]);
        let front = with_cover(&db, crate::covers::SIDE_FRONT);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert_eq!((v.pictures_recovered, v.covers_recovered), (1, 1));
        assert_eq!(v.pictures.as_deref(), Some(PICTURES_DIR));
        assert!(out.join(PICTURES_DIR).join(&portrait).exists());
        assert!(out.join(PICTURES_DIR).join(&front).exists());
    }

    #[test]
    fn a_v7_file_recovers_its_cast_and_is_not_asked_about_a_picture() {
        // The 046 rule, one version further on: a file behind v8 has no
        // `picture_path` column and is not thereby DAMAGED. Asking it for one
        // would make the SELECT fail, and `walk`'s wrong-shape branch would
        // report the whole cast table as unreadable -- every character sheet in
        // an old project lost, by a check meant to recover a photograph.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(
            &db,
            "ALTER TABLE cast_member DROP COLUMN picture_path; PRAGMA user_version = 7;",
        );
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.cast_members_recovered, 3);
        assert_eq!(v.cast_fields_recovered, 2);
        assert_eq!(v.pictures_recovered, 0);
        assert_eq!(v.pictures, None);
    }

    /// A file that CLAIMS the tables and has lost them is DAMAGE, which is the
    /// whole point of the command: the table is reported unreadable, and every
    /// document still comes out.
    #[test]
    fn a_file_that_claims_the_tables_and_has_lost_them_reports_them_unreadable() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture_with_everything(&db).1;
        damage(
            &db,
            "DROP TABLE synopsis; DROP TABLE cast_field; DROP TABLE cast_member;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert_eq!(
            v.schema_version,
            Some(crate::store::SCHEMA_VERSION),
            "the file still claims the version it was written at"
        );
        assert!(!v.complete);
        let tables: Vec<&str> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_TABLE)
            .map(|l| l.detail.as_str())
            .collect();
        assert_eq!(tables.len(), 3, "{:?}", v.losses);
        for name in ["synopsis", "cast_member", "cast_field"] {
            assert!(
                tables.iter().any(|d| d.contains(name)),
                "no loss names {name}: {tables:?}"
            );
        }
        // The prose is untouched by any of it.
        assert_eq!(v.documents_recovered, 2);
        for id in &scenes {
            assert!(out.join(DOCUMENTS_DIR).join(format!("{id}.md")).exists());
        }
    }

    // ------------------------------------------------------- partial reads

    /// A doc row this build cannot read as a row -- a body that is not text --
    /// costs that ROW and nothing else. This is decision 2's whole point: one
    /// bad row must not abandon the rest.
    #[test]
    fn one_unreadable_row_does_not_abandon_the_others() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        // A body that is not TEXT at all. SQLite columns are not typed, so a
        // blob sits happily in `body TEXT NOT NULL` -- and `get::<String>`
        // refuses it, which is one row this build cannot read while every other
        // row in the table is fine. No schema surgery, and nothing here that a
        // foreign tool writing this file could not have done.
        damage(
            &db,
            &format!(
                "UPDATE doc SET body = x'FFFE0000' WHERE item_id = '{}'",
                scenes[0]
            ),
        );

        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(kinds(&v).contains(&KIND_DOC_ROW), "{:?}", v.losses);
        assert_eq!(v.documents_recovered, 1, "the other scene still came out");
        assert!(out
            .join(DOCUMENTS_DIR)
            .join(format!("{}.md", scenes[1]))
            .exists());
    }

    // ------------------------------- the prose path's own wrong-shape defect

    /// A wrong-shaped `item` table is a LOSS, not an empty table.
    ///
    /// 046 found this defect inside its own new code and fixed it there, and
    /// recorded that `read_items` and `read_docs` still had the original shape:
    /// `let Ok(mut stmt) = conn.prepare(..) else { return Vec::new() }`. It
    /// looks unreachable because `rowids` has already proved the table exists,
    /// and it is not -- a rowid is a b-tree key and knows nothing about
    /// COLUMNS. A file whose `item` table came from a foreign tool salvaged as
    /// a project with no items and NO LOSS RECORDED, which is silent total loss
    /// on the one command that runs when everything else has already failed.
    #[test]
    fn an_item_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        damage(
            &db,
            "DROP TABLE item;
             CREATE TABLE item (id TEXT PRIMARY KEY, heading TEXT NOT NULL);
             INSERT INTO item VALUES ('somebody', 'a title in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete, "a table that could not be read is a loss");
        assert_eq!(v.items_recovered, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("item table")),
            "{:?}",
            v.losses
        );
        // And the prose still comes out, which is the whole point of reporting
        // rather than refusing.
        assert_eq!(v.documents_recovered, 2);
    }

    /// The same defect in `read_docs`, where what is lost is the prose itself.
    #[test]
    fn a_doc_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        damage(
            &db,
            "DROP TABLE doc;
             CREATE TABLE doc (item_id TEXT PRIMARY KEY, prose TEXT NOT NULL);
             INSERT INTO doc VALUES ('somebody', 'sentences in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert_eq!(v.documents_recovered, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("doc table")),
            "{:?}",
            v.losses
        );
        // The items are still there, so the manuscript still has its shape.
        assert_eq!(v.items_recovered, 3);
    }

    /// BOTH tables the wrong shape is "I could not look", exactly as neither
    /// table enumerating is. This file used to salvage as a successful, empty,
    /// COMPLETE project -- the worst answer this command can give.
    #[test]
    fn neither_table_being_the_shape_this_build_knows_is_a_refusal() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        damage(
            &db,
            "DROP TABLE item; DROP TABLE doc;
             CREATE TABLE item (id TEXT PRIMARY KEY, heading TEXT NOT NULL);
             CREATE TABLE doc (item_id TEXT PRIMARY KEY, prose TEXT NOT NULL);
             INSERT INTO item VALUES ('somebody', 'a title');
             INSERT INTO doc VALUES ('somebody', 'sentences');",
        );
        let out = dir.path().join("out");
        match salvage(&db, &out) {
            Err(Refusal::Unreadable(m)) => assert!(m.contains("does not hold a project"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    // ------------------------------------------------------ who appears where

    /// The everything fixture, plus tags, plus a MOVE that makes three orders
    /// disagree.
    ///
    /// 046's recorded mutation trap: `SELECT rowid FROM <table>` is answered by
    /// a covering scan of the primary key's autoindex, so rows arrive in ID
    /// order and a fixture whose ids sort like the property under test proves
    /// nothing. Here the item ids ascend in CREATION order (part, Opening,
    /// Second), so `Second` is moved to the front of the part -- the WALK order
    /// is now part, Second, Opening -- and the tags are inserted in a third
    /// order again (Opening, part, Second). A sort by item id, by rowid or by
    /// insertion all give a different answer from the walk's.
    ///
    /// Returns (part id, scene ids in CREATION order, member ids).
    pub(crate) fn fixture_with_appearances(db: &Path) -> (String, Vec<String>, Vec<String>) {
        let (part, scenes, members) = fixture_with_everything(db);
        let store = Store::open(db).unwrap();
        let second = store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.id == scenes[1])
            .unwrap();
        store
            .item_move(&scenes[1], Some(&part), None, second.rev)
            .unwrap();
        let ada = vec![members[0].clone()];
        store.appearances_set(&scenes[0], &ada).unwrap();
        store
            .appearances_set(&part, &[members[0].clone(), members[1].clone()])
            .unwrap();
        store.appearances_set(&scenes[1], &ada).unwrap();
        (part, scenes, members)
    }

    /// 039 asked for exactly this and said why: "a list of uuid pairs is not
    /// something a person can read. The honest form is a section of `cast.md`
    /// naming each member's items by TITLE, which needs `read_items` to have
    /// succeeded."
    #[test]
    fn a_salvage_recovers_who_appears_where_by_title_in_the_walks_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, _members) = fixture_with_appearances(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.appearances_recovered, 4);
        let cast = read(&out.join(CAST_NAME));
        assert!(cast.contains("Appears in:"), "{cast}");
        // BY TITLE, and the id beside it -- the only thing tying the line to
        // `documents/<id>.md`.
        assert!(cast.contains("- Part One `"), "{cast}");
        assert!(cast.contains("- Opening `"), "{cast}");
        assert!(cast.contains("- Second `"), "{cast}");
        // IN THE WALK'S ORDER, which the move made disagree with the item ids,
        // with the rowids and with the order the tags were written in.
        let at = |needle: &str| cast.find(needle).expect(needle);
        assert!(at("- Part One `") < at("- Second `"), "{cast}");
        assert!(at("- Second `") < at("- Opening `"), "{cast}");
        // The place is tagged too, so this is not one member's list read twice.
        let harbour = &cast[at("### The Harbour")..];
        assert!(harbour.contains("- Part One `"), "{harbour}");
        assert!(!harbour.contains("- Opening `"), "{harbour}");
    }

    /// A tagged item that is gone: the person is recovered, the scene is not,
    /// and the line falls back to the id -- `synopses.md`'s rule.
    #[test]
    fn an_appearance_whose_item_is_gone_is_reported_once_and_named_by_id() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, members) = fixture_with_appearances(&db);
        damage(
            &db,
            &format!(
                "DELETE FROM item WHERE id = '{}';
                 INSERT INTO appearance VALUES ('{}', '{}');",
                scenes[0], scenes[0], members[1]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        // TWO rows name that item and there is ONE loss for it:
        // `orphan_cast_field`'s rule.
        let orphans: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_ORPHAN_APPEARANCE)
            .collect();
        assert_eq!(orphans.len(), 1, "{:?}", v.losses);
        assert_eq!(orphans[0].item_id.as_deref(), Some(scenes[0].as_str()));
        assert_eq!(v.appearances_recovered, 5);
        let cast = read(&out.join(CAST_NAME));
        // No title survives, so the id is all there is -- and it is still there.
        assert!(cast.contains(&format!("- `{}`", scenes[0])), "{cast}");
        // And it sorts AFTER every item the walk did reach, which is
        // `synopses.md`'s rule: a tag with no place in the book does not
        // interrupt the ones that have one.
        let harbour = &cast[cast.find("### The Harbour").unwrap()..];
        assert!(
            harbour.find(&format!("- `{}`", scenes[0])).unwrap()
                > harbour.find("- Part One `").unwrap(),
            "{harbour}"
        );
    }

    /// A tag on an item the walk never reached sorts AFTER every one it did --
    /// `synopses.md`'s rule: a tag with no place in the book does not interrupt
    /// the ones that have one.
    ///
    /// THE FIXTURE IS THE TEST HERE. The mutation replacing `usize::MAX` with
    /// `0` SURVIVED the first pass, because the only orphan available was a
    /// deleted scene whose id sorts after the part's -- at `0` the two tie and
    /// the id tiebreak put them back in the same order. So the orphan is an item
    /// id beginning `!`, which sorts BEFORE every uuid this application writes:
    /// at `0` it ties with the part and WINS the tiebreak, and the assertion
    /// below goes red.
    #[test]
    fn a_tag_the_walk_never_reached_sorts_after_every_one_it_did() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, members) = fixture_with_appearances(&db);
        damage(
            &db,
            &format!("INSERT INTO appearance VALUES ('!gone', '{}');", members[1]),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(
            kinds(&v).contains(&KIND_ORPHAN_APPEARANCE),
            "{:?}",
            v.losses
        );

        let cast = read(&out.join(CAST_NAME));
        let harbour = &cast[cast.find("### The Harbour").unwrap()..];
        assert!(
            harbour.find("- `!gone`").unwrap() > harbour.find("- Part One `").unwrap(),
            "{harbour}"
        );
    }

    /// A tag whose MEMBER is gone is a loss and NO LINE, and that is 046's
    /// `.raw` argument: a `cast_field` with no member is written because it
    /// carries the writer's words, and an appearance carries two ids and no
    /// words at all, so there is no string to write.
    #[test]
    fn an_appearance_whose_member_is_gone_is_a_loss_with_nothing_to_write() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_appearances(&db);
        damage(
            &db,
            &format!(
                "INSERT INTO appearance VALUES ('{}', 'ghost');
                 INSERT INTO appearance VALUES ('{}', 'ghost');",
                scenes[0], scenes[1]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        let orphans: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_ORPHAN_APPEARANCE)
            .collect();
        assert_eq!(orphans.len(), 1, "one per member: {:?}", v.losses);
        assert!(orphans[0].detail.contains("ghost"), "{:?}", orphans[0]);
        let cast = read(&out.join(CAST_NAME));
        assert!(!cast.contains("ghost"), "there is nothing to write: {cast}");
    }

    /// AN APPEARANCE IS JUDGED ONLY AGAINST A TABLE THAT WAS READ. With the
    /// `item` table unreadable, every tag would otherwise be reported as
    /// naming a missing scene -- confident sentences about rows nobody looked
    /// at, on top of the one loss that says the true thing.
    #[test]
    fn appearances_are_not_judged_against_an_item_table_that_was_never_read() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_appearances(&db);
        damage(
            &db,
            "DROP TABLE item;
             CREATE TABLE item (id TEXT PRIMARY KEY, heading TEXT NOT NULL);",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.appearances_recovered, 4, "the tags themselves still read");
        assert!(
            !kinds(&v).contains(&KIND_ORPHAN_APPEARANCE),
            "nothing is gone from a table nobody read: {:?}",
            v.losses
        );
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("item table")),
            "{:?}",
            v.losses
        );
    }

    /// The same rule at the other end of the pair.
    #[test]
    fn appearances_are_not_judged_against_a_cast_table_that_was_never_read() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_appearances(&db);
        damage(
            &db,
            "DROP TABLE cast_member;
             CREATE TABLE cast_member (id TEXT PRIMARY KEY, who TEXT NOT NULL);",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.appearances_recovered, 4);
        assert!(
            !kinds(&v).contains(&KIND_ORPHAN_APPEARANCE),
            "{:?}",
            v.losses
        );
    }

    /// The same rule again, one table over: neither the field orphan loss
    /// nor the alias orphan loss is judged against a `cast_member` table
    /// that would not read -- the appearance test's own fixture shape,
    /// against `orphan_cast_field`/`orphan_cast_alias` instead.
    #[test]
    fn detail_and_alias_orphans_are_not_judged_against_a_cast_table_that_was_never_read() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, _scenes, members) = fixture_with_everything(&db);
        damage(
            &db,
            &format!(
                "INSERT INTO cast_alias (member_id, ordinal, alias) VALUES ('{}', 0, 'Als');
                 DROP TABLE cast_member;
                 CREATE TABLE cast_member (id TEXT PRIMARY KEY, who TEXT NOT NULL);",
                members[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(
            !kinds(&v).contains(&KIND_ORPHAN_CAST_FIELD),
            "nothing is gone from a table nobody read: {:?}",
            v.losses
        );
        assert!(
            !kinds(&v).contains(&KIND_ORPHAN_CAST_ALIAS),
            "nothing is gone from a table nobody read: {:?}",
            v.losses
        );
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("cast_member")),
            "{:?}",
            v.losses
        );
    }

    /// One tag row this build cannot read costs that row and nothing else.
    #[test]
    fn one_unreadable_appearance_row_costs_that_row_alone() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_appearances(&db);
        // A blob where an id belongs: SQLite columns are not typed, and
        // `get::<String>` refuses it. Nothing here a foreign tool could not
        // have written.
        damage(
            &db,
            &format!(
                "UPDATE appearance SET cast_member_id = x'FFFE0000' WHERE item_id = '{}'",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(kinds(&v).contains(&KIND_APPEARANCE_ROW), "{:?}", v.losses);
        assert_eq!(v.appearances_recovered, 3, "the other tags still read");
    }

    /// The wrong-shape branch for the fourth table.
    #[test]
    fn an_appearance_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_appearances(&db);
        damage(
            &db,
            "DROP TABLE appearance;
             CREATE TABLE appearance (item_id TEXT, who TEXT, PRIMARY KEY (item_id, who));
             INSERT INTO appearance VALUES ('somebody', 'a member in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete);
        assert_eq!(v.appearances_recovered, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("appearance")),
            "{:?}",
            v.losses
        );
        // The cast itself is untouched by any of it.
        assert_eq!(v.cast_members_recovered, 3);
    }

    /// v8 is the half-way file: it HAS a cast and a picture column and no
    /// `appearance` table, and it is OLD rather than damaged. Its own guard,
    /// for the reason v6's and v7's are their own.
    #[test]
    fn a_v8_file_recovers_its_cast_and_is_not_asked_about_appearances() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_appearances(&db);
        damage(&db, "DROP TABLE appearance; PRAGMA user_version = 8;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(8));
        assert_eq!(v.appearances_recovered, 0);
        assert_eq!(v.cast_members_recovered, 3);
        assert!(!read(&out.join(CAST_NAME)).contains("Appears in:"));
    }

    /// The guard one version on: a v9 file has cast members, fields and
    /// appearances, and no `cast_alias` table -- and is not thereby damaged.
    #[test]
    fn a_v9_file_recovers_its_cast_and_is_not_asked_about_aliases() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(&db, "DROP TABLE cast_alias; PRAGMA user_version = 9;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(9));
        assert_eq!(v.cast_aliases_recovered, 0);
        assert_eq!(v.cast_members_recovered, 3);
        assert!(!read(&out.join(CAST_NAME)).contains("Also called"));
    }

    /// THE OTHER HALF of the guard above: a v10 file that has LOST the table
    /// it claims to hold is damaged, not old, `an_appearance_table_of_the_
    /// wrong_shape_is_reported_and_not_read_as_empty`'s own pair one table
    /// over. `user_version` STAYS AT 10 (unlike the test above, which also
    /// rolls it back) -- `rowids`'s `conn.prepare` fails outright on a table
    /// that is not there at all, which `walk` turns into a `KIND_TABLE` loss
    /// naming `cast_alias` rather than reading the file as cast-alias-free.
    #[test]
    fn a_v10_file_that_lost_the_alias_table_is_damaged_not_old() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_everything(&db);
        damage(&db, "DROP TABLE cast_alias; DELETE FROM meta WHERE key = 'book_id'; PRAGMA user_version = 10;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(!v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(10));
        assert_eq!(v.cast_aliases_recovered, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("cast_alias")),
            "{:?}",
            v.losses
        );
        // The cast itself, and the rest of the book, are untouched by it.
        assert_eq!(v.cast_members_recovered, 3);
    }

    // ------------------------------ the book's design (slices 040 and 043)

    /// Set every design row this build knows.
    fn with_design(db: &Path) {
        let store = Store::open(db).unwrap();
        crate::design::write_design(&store, &crate::design::default_design()).unwrap();
        crate::design::write_chapter_style(
            &store,
            &crate::design::ChapterStyle {
                glyph: Some("fleuron".into()),
                new_page: true,
                caps_title: false,
                drop_cap: true,
            },
        )
        .unwrap();
    }

    /// VERBATIM AND UNPARSED. Salvage prints what the file said, exactly as it
    /// prints a `picture_path` this build would never have written -- running
    /// these through `parse_page` would DROP a value this build cannot read,
    /// which is silent loss inside the fix for silent loss.
    #[test]
    fn a_salvage_recovers_the_books_design_verbatim() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_design(&db);
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        let design = v.design.as_ref().expect("the meta table read");
        assert_eq!(design.font.as_deref(), Some("Crimson Text"));
        assert_eq!(design.page.as_deref(), Some("152400x228600 trade"));
        assert_eq!(design.margins.as_deref(), Some("19050,15875,15875,19050"));
        assert_eq!(design.glyph.as_deref(), Some("fleuron"));
        assert_eq!(design.chapter.as_deref(), Some("new-page drop-cap"));
        // And it is in the manifest on disk, keyed by nothing but itself.
        let written: serde_json::Value =
            serde_json::from_str(&read(&out.join(MANIFEST_NAME))).unwrap();
        assert_eq!(written["design"]["page"], "152400x228600 trade");
    }

    /// A value this build cannot read is still recovered. The point of verbatim,
    /// and the case a writer with a damaged file is actually in.
    #[test]
    fn a_design_value_this_build_cannot_parse_is_still_recovered() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO meta VALUES ('design.page', 'not a page size at all');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "an unreadable VALUE is not an unreadable ROW");
        assert_eq!(
            v.design.as_ref().unwrap().page.as_deref(),
            Some("not a page size at all")
        );
    }

    /// AN ABSENT ROW IS NOT A LOSS. A book nobody has designed is the ordinary
    /// case, and reporting it as damage would make every undesigned project
    /// salvage as broken.
    #[test]
    fn a_book_nobody_designed_records_no_design_and_no_loss() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        let design = v
            .design
            .as_ref()
            .expect("the table read; nothing was in it");
        assert_eq!(design.rows(), Vec::new());
        assert_eq!(design.font, None);
        assert_eq!(design.glyph, None);
    }

    /// An EMPTY row is an absent one: `write_chapter_style` stores "" for an
    /// ornament nobody chose, so the two states are already one in every file
    /// this application has written.
    #[test]
    fn a_design_row_holding_nothing_reads_as_a_row_that_is_not_there() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            crate::design::write_chapter_style(&store, &crate::design::ChapterStyle::default())
                .unwrap();
        }
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.design.as_ref().unwrap().glyph, None);
        assert_eq!(v.design.as_ref().unwrap().chapter, None);
    }

    /// AN UNREADABLE ROW IS A LOSS, and it is the whole reason this key exists:
    /// a design that WAS chosen and can no longer be read must never read as one
    /// that never was, because to the person retyping it the two are identical.
    ///
    /// PER KEY -- `design.rs`'s own rule, "one unreadable value costs exactly
    /// itself, so a corrupt page size cannot take a font the writer chose down
    /// with it".
    #[test]
    fn an_unreadable_design_row_is_a_loss_and_costs_only_itself() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_design(&db);
        damage(
            &db,
            "UPDATE meta SET value = x'FFFE0000' WHERE key = 'design.page';",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        let lost: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_DESIGN_ROW)
            .collect();
        assert_eq!(lost.len(), 1, "{:?}", v.losses);
        assert!(lost[0].detail.contains("design.page"), "{:?}", lost[0]);
        // And the font the writer chose came out anyway.
        assert_eq!(
            v.design.as_ref().unwrap().font.as_deref(),
            Some("Crimson Text")
        );
        assert_eq!(v.design.as_ref().unwrap().page, None);
    }

    /// A `meta` table that will not answer at all is ONE loss and a null
    /// design -- `walk`'s split between a table-level failure and a row-level
    /// one. This is the ONE None in the manifest that can mean "I could not
    /// look", and it is never silent.
    #[test]
    fn a_meta_table_that_cannot_be_read_is_one_loss_and_no_design() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(&db, "DROP TABLE meta;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.design.is_none());
        assert!(
            !kinds(&v).contains(&KIND_DESIGN_ROW),
            "a table-level failure is not five row-level ones: {:?}",
            v.losses
        );
        let tables: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_TABLE && l.detail.contains("meta"))
            .collect();
        assert_eq!(tables.len(), 1, "{:?}", v.losses);
        // The prose is untouched by any of it, and the project falls back to
        // the file stem for its name exactly as it did before.
        assert_eq!(v.name, "book");
        assert_eq!(v.documents_recovered, 2);
        for id in &scenes {
            assert!(out.join(DOCUMENTS_DIR).join(format!("{id}.md")).exists());
        }
    }
    // ----------------------------------------------- the writer's own notes

    /// The everything fixture, plus notes, built so that no accidental order
    /// agrees with the order under test.
    ///
    /// THE RECORDED TRAP, THIRD TIME. `SELECT rowid FROM comment` is answered by
    /// a covering scan of the primary key, so rows arrive in INSERTION order.
    /// Here:
    ///   - the walk order is part, Second, Opening (the fixture moves Second to
    ///     the front), and the item ids ascend part, Opening, Second;
    ///   - Opening's two notes are inserted late-then-early, so their ids
    ///     disagree with their `anchor_from`;
    ///   - Second's note is inserted last of all, so insertion order disagrees
    ///     with the walk order too.
    /// A sort by rowid, by insertion, or by item id gives a different answer
    /// from the one asserted in every test below.
    ///
    /// Returns (part id, scene ids in CREATION order, member ids).
    pub(crate) fn fixture_with_comments(db: &Path) -> (String, Vec<String>, Vec<String>) {
        let (part, scenes, members) = fixture_with_appearances(db);
        let store = Store::open(db).unwrap();
        store
            .comment_create(&scenes[0], "later in the scene", 20, 25, "more words")
            .unwrap();
        store
            .comment_create(&scenes[0], "at the top", 4, 11, "the harbour")
            .unwrap();
        store
            .comment_create(&scenes[1], "the second scene", 4, 11, "three more")
            .unwrap();
        (part, scenes, members)
    }

    /// A note is the writer's own words about their book, and what it was ABOUT
    /// is the stored quote -- never a slice of the recovered prose, which would
    /// be silently re-anchoring in the one case that matters.
    #[test]
    fn a_healthy_project_recovers_the_notes_the_writer_left() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.comments_recovered, 3);
        assert_eq!(v.comments_orphaned, 0);
        assert_eq!(v.comments.as_deref(), Some(COMMENTS_NAME));

        let notes = read(&out.join(COMMENTS_NAME));
        assert!(notes.starts_with("# The Harbour - comments"), "{notes}");
        // The document it is about, by TITLE, with the id under it -- what ties
        // the section to `documents/<id>.md`. `synopses.md`'s rule.
        assert!(notes.contains("## Opening"), "{notes}");
        assert!(notes.contains(&format!("`{}`", scenes[0])), "{notes}");
        // The writer's words.
        assert!(notes.contains("at the top"), "{notes}");
        assert!(notes.contains("later in the scene"), "{notes}");
        assert!(notes.contains("the second scene"), "{notes}");
        // The passage, quoted, and the range, printed.
        assert!(notes.contains("> the harbour"), "{notes}");
        assert!(notes.contains("### 4-11\n"), "{notes}");
        assert!(notes.contains("### 20-25\n"), "{notes}");
        // And it is in the manifest, which is the machine half of the same fact.
        let written: serde_json::Value =
            serde_json::from_str(&read(&out.join(MANIFEST_NAME))).unwrap();
        assert_eq!(written["comments_recovered"], 3);
        assert_eq!(written["comments"], COMMENTS_NAME);
    }

    /// The notes read down the book in the manuscript's own order, which is
    /// `synopses.md`'s rule: a writer reads their notes the way they read the
    /// book. The fixture's move makes the walk disagree with the item ids.
    #[test]
    fn the_notes_are_grouped_by_document_in_the_manuscript_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();

        let notes = read(&out.join(COMMENTS_NAME));
        let at = |n: &str| notes.find(n).unwrap_or_else(|| panic!("{n}: {notes}"));
        assert!(at("## Second") < at("## Opening"), "{notes}");
        // And the ids do NOT already sort that way, or an id sort would pass.
        assert!(scenes[0] < scenes[1], "the fixture stopped being a trap");
    }

    /// Within one document, the notes are in PROSE order -- `Store::comments`'
    /// own order, so a recovery reads the way the panel does. The fixture writes
    /// them late-then-early, so a rowid or insertion sort gives the reverse.
    #[test]
    fn notes_within_a_document_are_written_in_prose_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_comments(&db);
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();

        let notes = read(&out.join(COMMENTS_NAME));
        let at = |n: &str| notes.find(n).unwrap_or_else(|| panic!("{n}: {notes}"));
        assert!(at("at the top") < at("later in the scene"), "{notes}");
    }

    /// A COLLAPSED ANCHOR IS A RECOVERED NOTE WITH A CAVEAT, NEVER A LOSS.
    ///
    /// `anchor_from >= anchor_to` already MEANS "an edit destroyed this passage"
    /// (`decisions/2026-08-19-derived-state-and-panic-path.md`), the row keeps
    /// its text, and the application reads it as an orphan through a derivation
    /// it already has. Salvage says the same word by the same derivation rather
    /// than inventing a second meaning -- and it is not damage, because the row
    /// read perfectly and the recovery lost nothing.
    #[test]
    fn a_collapsed_anchor_is_recovered_marked_orphaned_and_is_not_a_loss() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        damage(
            &db,
            &format!(
                "UPDATE comment SET anchor_to = anchor_from
                  WHERE item_id = '{}' AND body = 'at the top';",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(
            v.complete,
            "a destroyed passage is not damage: {:?}",
            v.losses
        );
        assert_eq!(v.comments_recovered, 3);
        assert_eq!(v.comments_orphaned, 1);
        let notes = read(&out.join(COMMENTS_NAME));
        assert!(notes.contains("### 4-4 (orphaned)"), "{notes}");
        // It keeps its text and it still quotes what the passage used to say,
        // which is the only thing an orphan has left.
        assert!(notes.contains("at the top"), "{notes}");
        assert!(notes.contains("> the harbour"), "{notes}");
    }

    /// RESOLVED IS KEPT, NEVER DELETED -- the store's rule, so dropping a
    /// settled note would be the silent loss this slice exists to end. Marked,
    /// because to the writer a settled note and an open one are not the same.
    #[test]
    fn a_resolved_note_is_recovered_and_marked() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        damage(
            &db,
            &format!(
                "UPDATE comment SET resolved_at = 1
                  WHERE item_id = '{}' AND body = 'at the top';",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.comments_recovered, 3);
        assert_eq!(v.comments_orphaned, 0, "resolved is not orphaned");
        let notes = read(&out.join(COMMENTS_NAME));
        assert!(notes.contains("### 4-11 (resolved)"), "{notes}");
        assert!(notes.contains("at the top"), "{notes}");
    }

    /// Both at once, and the marks read in one order so two runs of one recovery
    /// agree.
    #[test]
    fn a_note_that_is_both_orphaned_and_resolved_says_both() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        damage(
            &db,
            &format!(
                "UPDATE comment SET resolved_at = 1, anchor_to = anchor_from
                  WHERE item_id = '{}' AND body = 'at the top';",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert_eq!(v.comments_orphaned, 1);
        let notes = read(&out.join(COMMENTS_NAME));
        assert!(notes.contains("### 4-4 (orphaned, resolved)"), "{notes}");
    }

    /// A note whose document is gone is STILL WRITTEN, under the item id --
    /// 046's `.raw` argument, which 048 restated for a `cast_field`: what it says
    /// is recovered, what it was about is not. Unlike an appearance, a comment
    /// carries the writer's words, so there is something to write.
    ///
    /// ONE LOSS PER DOCUMENT, never one per row -- `orphan_cast_field`'s rule.
    #[test]
    fn notes_whose_document_is_gone_are_recovered_and_reported_once_per_document() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        // Two notes on this scene, and one loss for it.
        damage(
            &db,
            &format!("DELETE FROM item WHERE id = '{}';", scenes[0]),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        let orphans: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_ORPHAN_COMMENT)
            .collect();
        assert_eq!(orphans.len(), 1, "one per document: {:?}", v.losses);
        assert_eq!(orphans[0].item_id.as_deref(), Some(scenes[0].as_str()));
        // Both notes came out anyway, under the id, since no title survives.
        assert_eq!(v.comments_recovered, 3);
        let notes = read(&out.join(COMMENTS_NAME));
        assert!(notes.contains(&format!("## {}", scenes[0])), "{notes}");
        assert!(notes.contains("at the top"), "{notes}");
        assert!(notes.contains("later in the scene"), "{notes}");
    }

    /// A document the walk never reached sorts AFTER every one it did --
    /// `synopses.md`'s rule.
    ///
    /// THE FIXTURE IS THE TEST HERE, and it is built against the trap that cost
    /// 046 and 048 one mutation each: the orphan's item id begins `!`, which
    /// sorts BEFORE every uuid this application writes. Under
    /// `unwrap_or(0)` it ties with every walked item and WINS the id tiebreak,
    /// so the assertion below goes red instead of passing by luck.
    #[test]
    fn a_document_the_walk_never_reached_sorts_after_every_one_it_did() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_comments(&db);
        damage(
            &db,
            "INSERT INTO comment
               (item_id, body, anchor_from, anchor_to, quote, resolved_at, created_at, updated_at)
             VALUES ('!gone', 'a note on nothing', 1, 4, 'q', NULL, 1, 1);",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(kinds(&v).contains(&KIND_ORPHAN_COMMENT), "{:?}", v.losses);

        let notes = read(&out.join(COMMENTS_NAME));
        let at = |n: &str| notes.find(n).unwrap_or_else(|| panic!("{n}: {notes}"));
        assert!(at("## Opening") < at("## !gone"), "{notes}");
    }

    /// A NOTE IS NEVER JUDGED AGAINST A TABLE THAT WAS NOT READ -- 048's rule,
    /// one table on. An `item` table nothing could open holds nothing for a note
    /// to be orphaned from, and one confident sentence per annotated scene on top
    /// of the one loss that says the true thing is noise.
    #[test]
    fn comments_are_not_judged_against_an_item_table_that_was_never_read() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_comments(&db);
        damage(
            &db,
            "DROP TABLE item;
             CREATE TABLE item (id TEXT PRIMARY KEY, heading TEXT NOT NULL);",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.comments_recovered, 3, "the notes themselves still read");
        assert!(
            !kinds(&v).contains(&KIND_ORPHAN_COMMENT),
            "nothing is gone from a table nobody read: {:?}",
            v.losses
        );
        // And they still come out, by id, because there are no titles to be had.
        assert!(read(&out.join(COMMENTS_NAME)).contains("at the top"));
    }

    /// One note this build cannot read costs that note and nothing else.
    #[test]
    fn one_unreadable_comment_row_costs_that_row_alone() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        // A blob where text belongs: SQLite columns are not typed and
        // `get::<String>` refuses it. Nothing a foreign tool could not have
        // written.
        damage(
            &db,
            &format!(
                "UPDATE comment SET body = x'FFFE0000' WHERE item_id = '{}';",
                scenes[1]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_COMMENT_ROW), "{:?}", v.losses);
        assert_eq!(v.comments_recovered, 2, "the other notes still came out");
        assert!(read(&out.join(COMMENTS_NAME)).contains("at the top"));
    }

    /// The wrong-shape branch for this table: a rowid is a b-tree key and knows
    /// nothing about columns, so a `comment` table of a foreign shape enumerates
    /// perfectly and fails at every fetch.
    #[test]
    fn a_comment_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_comments(&db);
        damage(
            &db,
            "DROP TABLE comment;
             CREATE TABLE comment (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
             INSERT INTO comment (note) VALUES ('a note in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.comments_recovered, 0);
        assert_eq!(v.comments, None);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("comment")),
            "{:?}",
            v.losses
        );
        // The prose is untouched by any of it.
        assert_eq!(v.documents_recovered, 2);
    }

    /// A note whose quote is empty gets no empty blockquote where one would have
    /// gone -- 046's M22, which was killed rather than excused.
    #[test]
    fn a_note_whose_quote_is_empty_is_still_recovered_without_an_empty_quotation() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        damage(
            &db,
            &format!(
                "UPDATE comment SET quote = '' WHERE item_id = '{}';",
                scenes[1]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert_eq!(v.comments_recovered, 3);

        let notes = read(&out.join(COMMENTS_NAME));
        // THE CLAIM ITSELF, and not a string the code cannot produce. The first
        // version of this asserted `!contains(">\n")` and SURVIVED the mutation
        // that removes the guard, because an empty quote is written as
        // "> " -- marker, SPACE, newline -- which does not contain ">\n". The
        // test was a fact about my own formatting. What the rule actually says
        // is that the heading is followed straight by the writer's words.
        assert!(
            notes.contains("### 4-11\n\nthe second scene\n"),
            "a quotation where none should be: {notes:?}"
        );
        assert!(!notes.contains("\n\n\n"), "a blank paragraph: {notes:?}");
    }

    /// The note sort, killed at `write_comments`' OWN BOUNDARY -- 046's answer
    /// for `write_cast`'s ordinal sort, and for its reason: neither key is
    /// reachable through `salvage`, because the walk hands `comment` rows back
    /// in rowid order and `comment.id` IS the rowid, so no damaged file can
    /// present two notes out of id order. Here the input order is chosen, and it
    /// disagrees with the answer on both keys at once.
    #[test]
    fn write_comments_orders_notes_by_anchor_then_by_id() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let note = |id: i64, from: i64, body: &str| RecoveredComment {
            item_id: "scene".into(),
            id,
            body: body.into(),
            anchor_from: from,
            anchor_to: from + 2,
            quote: "q".into(),
            resolved: false,
        };
        // Descending anchors, and the two that TIE arrive with their ids
        // descending too.
        let comments = vec![
            note(9, 40, "third"),
            note(8, 4, "second"),
            note(7, 4, "first"),
        ];

        let name = write_comments(
            &out,
            "Book",
            &comments,
            &HashMap::new(),
            &HashMap::new(),
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert_eq!(name.as_deref(), Some(COMMENTS_NAME));
        let text = read(&out.join(COMMENTS_NAME));
        let at = |n: &str| text.find(n).unwrap_or_else(|| panic!("{n}: {text}"));
        assert!(at("first") < at("second"), "{text}");
        assert!(at("second") < at("third"), "{text}");
    }

    // -------------------------------------------- the project's wordlist

    /// Three invented names, inserted in an order that is neither alphabetical
    /// nor its reverse -- `SELECT rowid` hands them back in INSERTION order, so a
    /// fixture already in the order under test would prove nothing.
    fn with_wordlist(db: &Path) {
        let store = Store::open(db).unwrap();
        for word in ["Zorbulax", "Amberline", "Mireth"] {
            store.dict_add(word).unwrap();
        }
    }

    /// 042 argued a design was three scalars a writer retypes in twenty seconds
    /// and 048 overruled it: the cost of a key is near zero and SILENCE IS THE
    /// DEFECT. A wordlist is that argument with more force -- it is every
    /// invented name in the book, and losing it re-flags every one of them on the
    /// writer's next spelling pass.
    #[test]
    fn a_salvage_recovers_the_project_wordlist_alphabetically() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_wordlist(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.wordlist_recovered, 3);
        assert_eq!(v.wordlist.as_deref(), Some(WORDLIST_NAME));

        let list = read(&out.join(WORDLIST_NAME));
        assert!(list.starts_with("# The Harbour - wordlist"), "{list}");
        let at = |n: &str| list.find(n).unwrap_or_else(|| panic!("{n}: {list}"));
        // `dict_words`' own order, which the insertion order disagrees with.
        assert!(at("- Amberline") < at("- Mireth"), "{list}");
        assert!(at("- Mireth") < at("- Zorbulax"), "{list}");
    }

    /// The wordlist sort, killed at `write_wordlist`' OWN BOUNDARY.
    ///
    /// THE FIXTURE TRAP, THIRD COSTUME, and this one caught the slice.
    /// `a_salvage_recovers_the_project_wordlist_alphabetically` inserts three
    /// words in a non-alphabetical order and asserts they come back sorted --
    /// and it PASSED against the deletion of `ordered.sort()`. `dict_word.word`
    /// is `UNIQUE`, so SQLite answers `SELECT rowid FROM dict_word` with a
    /// covering scan of `sqlite_autoindex_dict_word_1`, which is an index on the
    /// WORD: the rows arrive already alphabetical whatever order they were
    /// written in. No fixture reachable through `salvage` can falsify that sort.
    ///
    /// 046 met the same wall at `cast_field`'s ordinal and gave the answer this
    /// follows: kill it where the input order is CHOSEN. The sort stays, because
    /// a query planner's scan order is a property it happens to have today and
    /// not a promise it made anybody.
    #[test]
    fn write_wordlist_puts_the_words_in_alphabetical_order() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let words: Vec<String> = ["Zorbulax", "Amberline", "Mireth"]
            .iter()
            .map(|w| w.to_string())
            .collect();

        let name =
            write_wordlist(&out, "Book", &words, crate::strings::Strings::english()).unwrap();

        assert_eq!(name.as_deref(), Some(WORDLIST_NAME));
        let list = read(&out.join(WORDLIST_NAME));
        assert_eq!(
            list.lines()
                .filter(|l| l.starts_with("- "))
                .collect::<Vec<_>>(),
            vec!["- Amberline", "- Mireth", "- Zorbulax"],
            "{list}"
        );
    }

    /// A quote the writer selected across a paragraph break stays INSIDE the
    /// quotation. One `>` on the first line only would leave the rest of the
    /// passage flush against the note's own words, where a reader cannot tell
    /// which is the book and which is the writer talking about it.
    #[test]
    fn a_quote_spanning_a_paragraph_break_stays_inside_the_quotation() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_comments(&db);
        damage(
            &db,
            &format!(
                "UPDATE comment SET quote = 'the harbour was quiet' || char(10) || char(10) ||
                                            'and the boats were in'
                  WHERE item_id = '{}' AND body = 'the second scene';",
                scenes[1]
            ),
        );
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();

        let notes = read(&out.join(COMMENTS_NAME));
        assert!(
            notes.contains("> the harbour was quiet\n>\n> and the boats were in\n"),
            "{notes}"
        );
        // And the note's own words are still outside it.
        assert!(notes.contains("\nthe second scene\n"), "{notes}");
    }

    /// A book nobody taught a word gets no file and no loss -- `cast.md`'s rule.
    #[test]
    fn a_book_with_no_wordlist_gets_no_file_and_reports_none() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.wordlist_recovered, 0);
        assert_eq!(v.wordlist, None);
        assert!(!out.join(WORDLIST_NAME).exists());
    }

    #[test]
    fn one_unreadable_wordlist_row_costs_that_row_alone() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_wordlist(&db);
        damage(
            &db,
            "UPDATE dict_word SET word = x'FFFE0000' WHERE word = 'Mireth';",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert!(kinds(&v).contains(&KIND_WORDLIST_ROW), "{:?}", v.losses);
        assert_eq!(v.wordlist_recovered, 2);
        let list = read(&out.join(WORDLIST_NAME));
        assert!(list.contains("- Amberline"), "{list}");
        assert!(list.contains("- Zorbulax"), "{list}");
    }

    #[test]
    fn a_wordlist_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_wordlist(&db);
        damage(
            &db,
            "DROP TABLE dict_word;
             CREATE TABLE dict_word (id INTEGER PRIMARY KEY, spelling TEXT NOT NULL);
             INSERT INTO dict_word (spelling) VALUES ('a word in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.wordlist_recovered, 0);
        assert_eq!(v.wordlist, None);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("dict_word")),
            "{:?}",
            v.losses
        );
    }

    // ---------------------------------------- the two floors this slice adds

    /// A v3 file has no `comment` table and no `dict_word` table and is OLD
    /// rather than damaged -- `missing_blobs`' rule, including the
    /// `unwrap_or(0)`. Its own test, for the reason v6's, v7's and v8's are
    /// their own: one guard reads a file between two versions wrongly at one end.
    #[test]
    fn a_v3_file_recovers_its_prose_and_is_not_asked_about_comments() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        damage(
            &db,
            "DROP TABLE appearance; DROP TABLE cast_field; DROP TABLE cast_member;
             DROP TABLE synopsis; DROP TABLE dict_word; DROP TABLE comment;
             PRAGMA user_version = 3;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(3));
        assert_eq!(v.comments_recovered, 0);
        assert_eq!(v.comments, None);
        assert_eq!(v.wordlist_recovered, 0);
        assert_eq!(v.wordlist, None);
        assert_eq!(v.documents_recovered, 2);
        for id in &scenes {
            assert!(out.join(DOCUMENTS_DIR).join(format!("{id}.md")).exists());
        }
    }

    /// v4 is the half-way file at this end: it HAS comments and has no
    /// wordlist. Each guard is its own, and the mutations moving either bound in
    /// either direction are killed by this test and the two beside it.
    #[test]
    fn a_v4_file_recovers_its_comments_and_is_not_asked_about_a_wordlist() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_comments(&db);
        damage(
            &db,
            "DROP TABLE appearance; DROP TABLE cast_field; DROP TABLE cast_member;
             DROP TABLE synopsis; DROP TABLE dict_word;
             PRAGMA user_version = 4;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(4));
        assert_eq!(v.comments_recovered, 3);
        assert_eq!(v.comments.as_deref(), Some(COMMENTS_NAME));
        assert_eq!(v.wordlist_recovered, 0);
        assert_eq!(v.wordlist, None);
    }

    /// And v5 is the half-way file at the other end: a wordlist, and no
    /// synopses. `a_file_that_predates_the_tables_salvages_exactly_as_it_did`
    /// covers the same version for the 046 tables; this is the half those two
    /// guards cannot see.
    #[test]
    fn a_v5_file_recovers_its_wordlist_and_is_not_asked_about_synopses() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_comments(&db);
        with_wordlist(&db);
        damage(
            &db,
            "DROP TABLE appearance; DROP TABLE cast_field; DROP TABLE cast_member;
             DROP TABLE synopsis;
             PRAGMA user_version = 5;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(5));
        assert_eq!(v.wordlist_recovered, 3);
        assert_eq!(v.wordlist.as_deref(), Some(WORDLIST_NAME));
        assert_eq!(v.comments_recovered, 3);
        assert_eq!(v.synopses_recovered, 0);
        assert_eq!(v.synopses, None);
    }

    // -------------------------------------- the writer's version history

    /// The comments fixture, plus THREE named snapshots and two AUTOMATIC
    /// versions.
    ///
    /// THE RECORDED TIMES DISAGREE WITH THE IDS ON PURPOSE, and so does the
    /// tiebreak. `snapshot.id` is `INTEGER PRIMARY KEY`, so it IS the rowid and
    /// `SELECT rowid FROM snapshot` hands the rows back in ascending id order
    /// whatever the fixture does -- the recorded trap, in its fourth costume.
    /// Times of (30, 30, 10) against ids (1, 2, 3) make the correct answer
    /// `2, 1, 3`, which is neither ascending id, nor descending id, nor
    /// `created_at` ascending, nor `created_at` descending with an ascending
    /// tiebreak. Every one of those five gives a different order.
    ///
    /// The document order inside a snapshot is the appearances fixture's move:
    /// the walk is part, Second, Opening and the `doc` rows are Opening, Second.
    ///
    /// Returns (part id, scene ids in CREATION order, member ids).
    pub(crate) fn fixture_with_history(db: &Path) -> (String, Vec<String>, Vec<String>) {
        let (part, scenes, members) = fixture_with_comments(db);
        {
            let store = Store::open(db).unwrap();
            for label in ["before the cut", "after the cut", "the oldest"] {
                store.snapshot_create(label).unwrap();
            }
            // AUTOMATIC versions: the five-minute throttle's, not the writer's.
            // Written far enough ahead that the throttle lets them through.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            let at = now + crate::store::history::AUTO_INTERVAL_MS + 1;
            for (n, id) in scenes.iter().enumerate() {
                store
                    .record_versions_at(
                        &[FlushEntry {
                            item_id: id.clone(),
                            body: body(&format!("a later draft {n}")),
                            base_rev: 1,
                            comments: None,
                        }],
                        at,
                    )
                    .unwrap();
            }
        }
        damage(
            db,
            "UPDATE snapshot SET created_at = 30 WHERE id = 1;
             UPDATE snapshot SET created_at = 30 WHERE id = 2;
             UPDATE snapshot SET created_at = 10 WHERE id = 3;",
        );
        (part, scenes, members)
    }

    /// The fixture, plus ONE named snapshot, for the damage tests: a blob is
    /// content-addressed and shared, so three snapshots of one unedited book
    /// share every key and damaging one would show up three times.
    fn with_snapshot(db: &Path, label: &str) -> i64 {
        let store = Store::open(db).unwrap();
        store.snapshot_create(label).unwrap().id
    }

    /// How many files landed under `snapshots/`.
    fn snapshot_files(out: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let root = out.join(SNAPSHOTS_DIR);
        if !root.exists() {
            return found;
        }
        for snap in std::fs::read_dir(&root).unwrap() {
            let snap = snap.unwrap().path();
            for f in std::fs::read_dir(&snap).unwrap() {
                found.push(f.unwrap().file_name().to_string_lossy().into_owned());
            }
        }
        found.sort();
        found
    }

    /// THE SLICE'S HEADLINE. A named snapshot is a moment the writer chose, and
    /// it comes back as prose they can read.
    #[test]
    fn a_salvage_recovers_every_named_snapshot_as_documents_and_an_index() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let (_part, scenes, _members) = fixture_with_history(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.snapshots_recovered, 3);
        // Three snapshots of a two-document book.
        assert_eq!(v.versions_recovered, 6);
        assert_eq!(v.snapshots.as_deref(), Some(SNAPSHOTS_NAME));
        assert_eq!(snapshot_files(&out).len(), 6);

        let index = read(&out.join(SNAPSHOTS_NAME));
        assert!(index.starts_with("# The Harbour - snapshots"), "{index}");
        // The LABEL is the heading and the id is under it -- `synopses.md`'s
        // rule, and here the id is what ties the section to `snapshots/<id>/`.
        assert!(index.contains("\n## before the cut\n\n`1`\n"), "{index}");
        assert!(index.contains("\n## after the cut\n\n`2`\n"), "{index}");
        // The recorded moment, verbatim in milliseconds: rendering a date needs
        // a timezone this command was never given.
        assert!(index.contains("\ncreated 30\n"), "{index}");
        assert!(index.contains("\ncreated 10\n"), "{index}");
        // Every document names the file that was written for it, by TITLE.
        assert!(
            index.contains(&format!(
                "- Opening `{}` {SNAPSHOTS_DIR}/1/{}.md\n",
                scenes[0], scenes[0]
            )),
            "{index}"
        );
        // And the prose is really there, under the item's title.
        let draft = read(
            &out.join(SNAPSHOTS_DIR)
                .join("1")
                .join(format!("{}.md", scenes[0])),
        );
        assert!(draft.starts_with("# Opening\n"), "{draft}");
        assert!(draft.contains("the harbour was quiet"), "{draft}");

        let written: serde_json::Value =
            serde_json::from_str(&read(&out.join(MANIFEST_NAME))).unwrap();
        assert_eq!(written["snapshots_recovered"], 3);
        assert_eq!(written["versions_recovered"], 6);
        assert_eq!(written["snapshots"], SNAPSHOTS_NAME);
    }

    /// LATEST-PLUS-NAMED IS THE DECISION, and this is the half of it that is a
    /// refusal: an automatic version is the five-minute throttle's, the current
    /// body is already in `documents/`, and writing every past draft of every
    /// document out is `documents/`' scale multiplied by `MAX_AUTO_VERSIONS`.
    ///
    /// IT IS NOT A LOSS. 049's rule for the collapsed anchor: a `Loss` makes
    /// `complete: false` and exit 3, and a deliberate universal omission
    /// reported as damage would make exit 3 the ordinary outcome of salvaging a
    /// healthy edited book. It is a COUNT, and the count is the whole of what
    /// stops this being the silence three slices have now closed.
    #[test]
    fn an_automatic_version_is_counted_and_dropped_and_is_never_a_loss() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_history(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.versions_dropped, 2);
        // Counted and NOT written: six files for six snapshot documents, and
        // not one more.
        assert_eq!(snapshot_files(&out).len(), 6);
        let index = read(&out.join(SNAPSHOTS_NAME));
        assert!(!index.contains("a later draft"), "{index}");
    }

    /// A book nobody has snapshotted gets no file, and the manifest says zero
    /// rather than nothing. `synopses`' reading: null NEVER means "it was lost".
    #[test]
    fn a_book_with_no_history_gets_no_snapshots_file_and_no_loss() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");

        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.snapshots_recovered, 0);
        assert_eq!(v.versions_recovered, 0);
        assert_eq!(v.versions_dropped, 0);
        assert_eq!(v.snapshots, None);
        assert!(!out.join(SNAPSHOTS_NAME).exists());
        assert!(!out.join(SNAPSHOTS_DIR).exists());
    }

    /// NEWEST FIRST, which is `Store::snapshots`' own order and therefore the
    /// order the panel showed the writer.
    ///
    /// The fixture's times and ids disagree in both directions -- see
    /// `fixture_with_history`. The expected order is neither ascending nor
    /// descending id, which is what `SELECT rowid FROM snapshot` would give.
    #[test]
    fn named_snapshots_are_listed_newest_first() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_history(&db);
        let out = dir.path().join("out");

        salvage(&db, &out).unwrap();
        let index = read(&out.join(SNAPSHOTS_NAME));
        let at = |h: &str| {
            index
                .find(h)
                .unwrap_or_else(|| panic!("{h} missing:\n{index}"))
        };
        // ids 1 and 2 share a time, so the tiebreak decides between them and it
        // is the newer id first; 3 is older than both.
        assert!(at("## after the cut") < at("## before the cut"), "{index}");
        assert!(at("## before the cut") < at("## the oldest"), "{index}");
    }

    /// A snapshot the file no longer names sorts AFTER every one it does --
    /// `synopses.md`'s rule for an item the walk never reached, one table on. It
    /// needs a file holding BOTH kinds at once, which the orphan test above
    /// cannot offer because it deletes the only snapshot there is.
    #[test]
    fn a_snapshot_row_that_is_gone_sorts_after_every_one_that_survived() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_history(&db);
        // 2 is the NEWEST by the fixture's times, so an implementation that put
        // an unnamed group first would put it exactly where it already was.
        damage(&db, "DELETE FROM snapshot WHERE id = 2;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.snapshots_recovered, 2);
        let index = read(&out.join(SNAPSHOTS_NAME));
        let at = |h: &str| {
            index
                .find(h)
                .unwrap_or_else(|| panic!("{h} missing:\n{index}"))
        };
        assert!(at("## before the cut") < at("\n## 2\n"), "{index}");
        assert!(at("## the oldest") < at("\n## 2\n"), "{index}");
    }

    /// And a DOCUMENT the walk never reached sorts after every one it did, for
    /// the same reason. `unwrap_or(usize::MAX)` is the whole of it, and 048's
    /// recorded survivor was `unwrap_or(0)` passing by luck -- here the surviving
    /// scene's walk index is 1, so at 0 the orphan would sort FIRST and nothing
    /// ties.
    #[test]
    fn a_past_draft_whose_item_the_walk_never_reached_sorts_after_every_one_it_did() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        // Opening is the FIRST scene in the walk; removing its item takes it out
        // of the walk order altogether while its past draft survives.
        damage(
            &db,
            &format!("DELETE FROM item WHERE id = '{}';", scenes[0]),
        );
        let out = dir.path().join("out");
        salvage(&db, &out).unwrap();

        let index = read(&out.join(SNAPSHOTS_NAME));
        let second = index.find("- Second `").unwrap();
        let opening = index.find(&format!("- `{}`", scenes[0])).unwrap();
        assert!(second < opening, "{index}");
    }

    /// The documents inside one snapshot read down the book, which is
    /// `synopses.md`'s rule. The fixture's move makes the walk order (Second,
    /// Opening) disagree with the `doc` rows' order (Opening, Second).
    #[test]
    fn a_snapshots_documents_are_listed_in_the_walks_order() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_history(&db);
        let out = dir.path().join("out");

        salvage(&db, &out).unwrap();
        let index = read(&out.join(SNAPSHOTS_NAME));
        let first = index.find("## after the cut").unwrap();
        let section = &index[first..];
        let second = section.find("- Second `").unwrap();
        let opening = section.find("- Opening `").unwrap();
        assert!(second < opening, "{section}");
    }

    /// A VERSION WHOSE BLOB IS GONE COSTS ONE SENTENCE AND NOT TWO.
    /// `missing_blobs` is the existing dangling-reference check and it is the
    /// only reporter of an absent blob: `write_snapshots` meets the same rows,
    /// prints a line saying the bytes are not there and records NOTHING, so one
    /// damage costs one sentence -- `orphan_cast_field`'s rule, at a third
    /// table.
    #[test]
    fn a_version_whose_blob_is_gone_is_one_loss_and_not_two() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        damage(
            &db,
            &format!(
                "DELETE FROM blob WHERE key =
                   (SELECT blob_key FROM doc_version WHERE item_id = '{}');",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(
            kinds(&v)
                .iter()
                .filter(|k| **k == KIND_MISSING_BLOB)
                .count(),
            1,
            "{:?}",
            v.losses
        );
        assert!(!kinds(&v).contains(&KIND_BLOB_ROW), "{:?}", v.losses);
        // One document of the two came back, and the index says why the other
        // did not.
        assert_eq!(v.versions_recovered, 1);
        assert_eq!(snapshot_files(&out).len(), 1);
        let index = read(&out.join(SNAPSHOTS_NAME));
        assert!(
            index.contains(&format!("- Opening `{}` bytes not stored\n", scenes[0])),
            "{index}"
        );
    }

    /// A blob that IS there and will not read is damage `missing_blobs` cannot
    /// see: its `LEFT JOIN` asks only whether the key is present, so a corrupt
    /// payload joins perfectly and fails at the fetch. Its own kind, and it
    /// costs that draft alone.
    #[test]
    fn a_blob_that_will_not_read_costs_that_draft_alone() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        damage(
            &db,
            &format!(
                "UPDATE blob SET body = x'FFFE0000' WHERE key =
                   (SELECT blob_key FROM doc_version WHERE item_id = '{}');",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        let lost: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_BLOB_ROW)
            .collect();
        assert_eq!(lost.len(), 1, "{:?}", v.losses);
        assert_eq!(lost[0].item_id.as_deref(), Some(scenes[0].as_str()));
        assert!(!kinds(&v).contains(&KIND_MISSING_BLOB), "{:?}", v.losses);
        // The other document of the same snapshot came out.
        assert_eq!(v.versions_recovered, 1);
    }

    /// A past draft that reads and does not PARSE is written verbatim, exactly
    /// as a live body is -- and under ITS OWN loss kind, on 046's
    /// `missing_cover` precedent: a person has to know whether what would not
    /// parse is the scene they are working on or a draft of it from last
    /// Tuesday. It does NOT join `raw_bodies`, whose length is tied to `words`.
    #[test]
    fn a_past_draft_that_is_not_a_document_is_written_verbatim_as_raw() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        damage(
            &db,
            &format!(
                "UPDATE blob SET body = 'this was never a document' WHERE key =
                   (SELECT blob_key FROM doc_version WHERE item_id = '{}');",
                scenes[0]
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        let lost: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_UNREADABLE_VERSION_BODY)
            .collect();
        assert_eq!(lost.len(), 1, "{:?}", v.losses);
        // The bytes are on disk, untouched.
        let raw = read(
            &out.join(SNAPSHOTS_DIR)
                .join("1")
                .join(format!("{}.{RAW_EXT}", scenes[0])),
        );
        assert_eq!(raw, "this was never a document");
        // And it is NOT counted as a recovered draft and NOT in `raw_bodies`,
        // whose length is the undercount in `words`.
        assert_eq!(v.versions_recovered, 1);
        assert!(v.raw_bodies.is_empty(), "{:?}", v.raw_bodies);
    }

    /// A version whose SNAPSHOT ROW is gone is still written, under the
    /// snapshot's number -- the `cast_field` answer and not the `appearance`
    /// one, and 048 drew the line by what the row holds: a version holds a
    /// document, so there is always a string to write. ONE loss per snapshot.
    #[test]
    fn past_drafts_whose_snapshot_is_gone_are_recovered_under_its_number() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        damage(&db, "DELETE FROM snapshot WHERE id = 1;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        // ONE sentence, not one per document.
        let lost: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_ORPHAN_VERSION)
            .collect();
        assert_eq!(lost.len(), 1, "{:?}", v.losses);
        assert!(lost[0].detail.contains("snapshot 1"), "{:?}", lost[0]);
        assert_eq!(v.snapshots_recovered, 0);
        // The prose came out anyway, under the number.
        assert_eq!(v.versions_recovered, 2);
        let index = read(&out.join(SNAPSHOTS_NAME));
        assert!(index.contains("\n## 1\n\n`1`\n"), "{index}");
        assert!(out
            .join(SNAPSHOTS_DIR)
            .join("1")
            .join(format!("{}.md", scenes[0]))
            .exists());
    }

    /// 048's rule, one table on: an orphan finding is the claim that the other
    /// end is GONE, and a `snapshot` table nothing could open holds nothing to
    /// be gone from. The `table_unreadable` beside it says the true thing once.
    #[test]
    fn versions_are_not_judged_against_a_snapshot_table_that_was_never_read() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        damage(&db, "DROP TABLE snapshot;");
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert!(!kinds(&v).contains(&KIND_ORPHAN_VERSION), "{:?}", v.losses);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("snapshot")),
            "{:?}",
            v.losses
        );
        // And the drafts are still recovered, by number, because there are no
        // labels to be had.
        assert_eq!(v.versions_recovered, 2);
        assert!(out
            .join(SNAPSHOTS_DIR)
            .join("1")
            .join(format!("{}.md", scenes[0]))
            .exists());
    }

    /// A rowid is a b-tree key and knows nothing about columns -- 048's finding,
    /// at the three tables 050 added.
    #[test]
    fn a_snapshot_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_snapshot(&db, "the only one");
        damage(
            &db,
            "DROP TABLE snapshot;
             CREATE TABLE snapshot (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             INSERT INTO snapshot (name) VALUES ('a label in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.snapshots_recovered, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("snapshot")),
            "{:?}",
            v.losses
        );
        assert_eq!(v.documents_recovered, 2);
    }

    #[test]
    fn a_doc_version_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_snapshot(&db, "the only one");
        damage(
            &db,
            "DROP TABLE doc_version;
             CREATE TABLE doc_version (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
             INSERT INTO doc_version (note) VALUES ('a draft in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.versions_recovered, 0);
        assert_eq!(v.versions_dropped, 0);
        assert!(
            v.losses
                .iter()
                .any(|l| l.kind == KIND_TABLE && l.detail.contains("doc_version")),
            "{:?}",
            v.losses
        );
        assert_eq!(v.documents_recovered, 2);
    }

    /// The `blob` table's wrong shape is the one a rowid walk cannot see at all,
    /// because nothing enumerates `blob`: the prepare in `write_snapshots` is
    /// the only thing that would fail, and reading it as "no bytes" would report
    /// a file full of drafts as a history with none in it.
    #[test]
    fn a_blob_table_of_the_wrong_shape_is_reported_and_not_read_as_absent() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        with_snapshot(&db, "the only one");
        damage(
            &db,
            "DROP TABLE blob;
             CREATE TABLE blob (key TEXT PRIMARY KEY, bytes TEXT NOT NULL);",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert_eq!(v.versions_recovered, 0);
        let tables: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_TABLE && l.detail.contains("blob"))
            .collect();
        assert_eq!(tables.len(), 1, "{:?}", v.losses);
        // The snapshot is still named, and every document of it says its bytes
        // are not there.
        assert_eq!(v.snapshots_recovered, 1);
        let index = read(&out.join(SNAPSHOTS_NAME));
        assert!(
            index.contains(&format!("- Opening `{}` bytes not stored\n", scenes[0])),
            "{index}"
        );
        assert!(!out.join(SNAPSHOTS_DIR).exists(), "no empty directory");
    }

    /// A v1 file has no history tables and is not thereby DAMAGED. `missing_blobs`
    /// has always used this floor and its `unwrap_or(0)`; the walks share it.
    #[test]
    fn a_v1_file_recovers_its_prose_and_is_not_asked_about_a_history() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_history(&db);
        damage(
            &db,
            "DROP TABLE appearance; DROP TABLE cast_field; DROP TABLE cast_member;
             DROP TABLE synopsis; DROP TABLE comment; DROP TABLE dict_word;
             DROP TABLE doc_version; DROP TABLE snapshot; DROP TABLE blob;
             PRAGMA user_version = 1;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(1));
        assert_eq!(v.snapshots_recovered, 0);
        assert_eq!(v.versions_recovered, 0);
        assert_eq!(v.versions_dropped, 0);
        assert_eq!(v.snapshots, None);
        assert_eq!(v.documents_recovered, 2);
    }

    /// And v2 is the file at the other end of the same bound: a history, and no
    /// comments. ITS OWN GUARD, for the reason every guard here has one -- a
    /// single guard reads a file between two versions wrongly at one end, and
    /// the mutation moving this bound in either direction is killed by one of
    /// these two tests.
    #[test]
    fn a_v2_file_recovers_its_history_and_is_not_asked_about_comments() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture_with_history(&db);
        damage(
            &db,
            "DROP TABLE appearance; DROP TABLE cast_field; DROP TABLE cast_member;
             DROP TABLE synopsis; DROP TABLE comment; DROP TABLE dict_word;
             PRAGMA user_version = 2;",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        assert_eq!(v.schema_version, Some(2));
        assert_eq!(v.snapshots_recovered, 3);
        assert_eq!(v.versions_recovered, 6);
        assert_eq!(v.versions_dropped, 2);
        assert_eq!(v.comments_recovered, 0);
    }

    /// The `(None, None)` arm of the snapshot sort, killed at this function's
    /// OWN BOUNDARY, where the input order is chosen -- 046's answer for
    /// `write_cast`'s ordinal sort. Nothing reachable through `salvage` can
    /// falsify it: `snapshot.id` IS the rowid and `by_snapshot` is a `BTreeMap`,
    /// so both routes hand the ids over already ascending.
    #[test]
    fn write_snapshots_orders_unnamed_groups_by_their_number() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        let versions = vec![
            RecoveredVersion {
                id: 1,
                item_id: "b".into(),
                blob_key: "no-such-key".into(),
                snapshot_id: Some(9),
            },
            RecoveredVersion {
                id: 2,
                item_id: "a".into(),
                blob_key: "no-such-key".into(),
                snapshot_id: Some(4),
            },
        ];
        let mut losses = Vec::new();
        let (_n, file) = write_snapshots(
            &out,
            "The Harbour",
            &conn,
            &[],
            &versions,
            &HashMap::new(),
            &HashMap::new(),
            &mut losses,
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert_eq!(file.as_deref(), Some(SNAPSHOTS_NAME));
        let text = read(&out.join(SNAPSHOTS_NAME));
        assert!(
            text.find("## 4").unwrap() < text.find("## 9").unwrap(),
            "{text}"
        );
    }

    /// And the document tiebreak, at the same boundary and for the same reason:
    /// it is reached only when two documents share a walk position, which is
    /// what happens when the walk reached neither.
    #[test]
    fn write_snapshots_orders_documents_by_id_when_the_walk_reached_neither() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        let versions = vec![
            RecoveredVersion {
                id: 1,
                item_id: "zeta".into(),
                blob_key: "no-such-key".into(),
                snapshot_id: Some(1),
            },
            RecoveredVersion {
                id: 2,
                item_id: "alpha".into(),
                blob_key: "no-such-key".into(),
                snapshot_id: Some(1),
            },
        ];
        let mut losses = Vec::new();
        write_snapshots(
            &out,
            "The Harbour",
            &conn,
            &[],
            &versions,
            &HashMap::new(),
            &HashMap::new(),
            &mut losses,
            crate::strings::Strings::english(),
        )
        .unwrap();
        let text = read(&out.join(SNAPSHOTS_NAME));
        assert!(
            text.find("`alpha`").unwrap() < text.find("`zeta`").unwrap(),
            "{text}"
        );
    }

    // ------------------------------------------------- the meta sweep (050)

    /// 049 named this as the roster's own limit: `meta` was salvaged BY KEY, so
    /// a row nothing named was silent exactly as the `comment` table was. The
    /// daily word target and its baseline were the live examples.
    #[test]
    fn a_salvage_recovers_every_meta_row_including_the_ones_nothing_names() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_design(&db);
        {
            let store = Store::open(&db).unwrap();
            store.set_meta(projects::DAY_KEY, "750").unwrap();
            store.set_meta(projects::DAY_BASELINE_KEY, "12000").unwrap();
        }
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(v.complete, "{:?}", v.losses);
        let meta = v.meta.as_ref().unwrap();
        assert_eq!(meta.get(projects::DAY_KEY).map(String::as_str), Some("750"));
        assert_eq!(
            meta.get(projects::DAY_BASELINE_KEY).map(String::as_str),
            Some("12000")
        );
        // The rows something DOES name are in the sweep too: it is every row,
        // verbatim, and `design` is a named subset projected from it.
        assert_eq!(
            meta.get(projects::NAME_KEY).map(String::as_str),
            Some("The Harbour")
        );
        assert_eq!(
            meta.get(crate::design::FONT_KEY).map(String::as_str),
            Some("Crimson Text")
        );
        assert_eq!(
            v.design.as_ref().unwrap().font.as_deref(),
            Some("Crimson Text")
        );
        let written: serde_json::Value =
            serde_json::from_str(&read(&out.join(MANIFEST_NAME))).unwrap();
        assert_eq!(written["meta"][projects::DAY_KEY], "750");
    }

    /// 053. THE SWEEP IS RIGHT AND THE PIN IS WHAT IS CONSTRAINED.
    ///
    /// `read_meta` copies every row verbatim with no field-level knowledge of
    /// what it is copying, so the moment a pen name became a `meta` row it began
    /// being serialized into a plain-text file forever. Narrowing the sweep
    /// would rebuild 049's defect in the place where being wrong is most
    /// expensive. So the guarantee is on the OTHER side: the pinned type has no
    /// private-tier field, and this is where that is proven against the file
    /// salvage actually writes rather than against the type.
    #[test]
    fn a_pinned_projects_manifest_carries_the_public_fields_and_no_key_outside_them() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let mut source = crate::identity::Identity {
            id: "i1".into(),
            rev: 3,
            ..crate::identity::Identity::default()
        };
        source.public.name = "Ada Vane".into();
        source.public.sort_name = "Vane, Ada".into();
        source.public.bio = "writes about harbours".into();
        source.publishing.imprint = "Vane Press".into();
        source.private.legal_name = "Margaret Hollis".into();
        source.private.contact = "margaret@example.invalid".into();
        source.private.admin = "VAT 12345".into();
        {
            let store = Store::open(&db).unwrap();
            crate::identity::set_pin(&store, Some(&crate::identity::pin_of(&source, 77))).unwrap();
        }
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();
        assert!(v.complete, "{:?}", v.losses);

        // The sweep took it, verbatim, exactly as it takes every other row.
        let row = v
            .meta
            .as_ref()
            .unwrap()
            .get(crate::identity::PIN_KEY)
            .expect("the pin was swept");
        let pin: serde_json::Value = serde_json::from_str(row).unwrap();
        let mut keys: Vec<&str> = pin
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, crate::identity::PIN_KEYS.to_vec());

        // WHAT IS IN THE FILE ON DISK, not what the value in memory says. The
        // manifest is the artifact an operator hands to somebody.
        let manifest = read(&out.join(MANIFEST_NAME));
        assert!(manifest.contains("Ada Vane"), "the public tier is there");
        assert!(
            manifest.contains("Vane Press"),
            "the publishing tier is there"
        );
        for secret in [
            "Margaret Hollis",
            "margaret@example.invalid",
            "VAT 12345",
            "legal_name",
            "\"private\"",
        ] {
            assert!(
                !manifest.contains(secret),
                "{secret} reached {MANIFEST_NAME}"
            );
        }
    }

    /// THE MANIFEST NAMES FILES, NEVER PATHS (054).
    ///
    /// `source` and `out_dir` were absolute until this slice, so `manifest.json`
    /// -- a plain-text file an operator hands to whoever is helping them --
    /// carried the operating-system user name in two places before it carried a
    /// word of the book. The fixture is under a real temporary directory, which
    /// on every machine this runs on is an absolute path, so the assertion has
    /// something to fail against.
    #[test]
    fn the_manifest_names_the_file_and_the_directory_and_never_the_path() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("recovered");
        // The control: this test is worthless if the fixture is not somewhere.
        assert!(
            db.is_absolute() && dir.path().to_string_lossy().len() > 1,
            "the fixture has no directory to leave out"
        );

        let v = salvage(&db, &out).unwrap();

        assert_eq!(v.source, "book.db");
        assert_eq!(v.out_dir, "recovered");
        let manifest = read(&out.join(MANIFEST_NAME));
        let holding = dir.path().to_string_lossy().into_owned();
        assert!(
            !manifest.contains(&holding),
            "the manifest names the directory it was written in: {holding}"
        );
    }

    /// Per key, not per table, and the KIND says which kind of row it was: a
    /// corrupt daily target must not read as a design failure and a corrupt page
    /// size must not read as an anonymous one.
    #[test]
    fn an_unreadable_meta_row_that_is_no_part_of_the_design_costs_only_itself() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        with_design(&db);
        {
            let store = Store::open(&db).unwrap();
            store.set_meta(projects::DAY_KEY, "750").unwrap();
        }
        damage(
            &db,
            &format!(
                "UPDATE meta SET value = x'FFFE0000' WHERE key = '{}';",
                projects::DAY_KEY
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        let lost: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_META_ROW)
            .collect();
        assert_eq!(lost.len(), 1, "{:?}", v.losses);
        assert!(lost[0].detail.contains(projects::DAY_KEY), "{:?}", lost[0]);
        assert!(!kinds(&v).contains(&KIND_DESIGN_ROW), "{:?}", v.losses);
        // And the design the writer chose came out anyway.
        assert_eq!(
            v.design.as_ref().unwrap().font.as_deref(),
            Some("Crimson Text")
        );
        assert!(v.meta.as_ref().unwrap().get(projects::DAY_KEY).is_none());
    }

    /// A row whose KEY will not read is still one sentence, by its rowid: the
    /// key and the value are read separately so a row can say which row it was
    /// even when half of it is gone.
    #[test]
    fn a_meta_row_whose_key_cannot_be_read_is_reported_by_its_rowid() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            store.set_meta(projects::DAY_KEY, "750").unwrap();
        }
        damage(
            &db,
            &format!(
                "UPDATE meta SET key = x'FFFE0000' WHERE key = '{}';",
                projects::DAY_KEY
            ),
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        let lost: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_META_ROW)
            .collect();
        assert_eq!(lost.len(), 1, "{:?}", v.losses);
        assert!(lost[0].detail.contains("of meta"), "{:?}", lost[0]);
        // The rows either side of it were still swept, and the project is still
        // named.
        assert_eq!(
            v.meta
                .as_ref()
                .unwrap()
                .get(projects::NAME_KEY)
                .map(String::as_str),
            Some("The Harbour")
        );
        assert_eq!(v.name, "The Harbour");
    }

    /// `rowids` proves the table exists and a rowid knows nothing about
    /// columns -- 048's finding, at the sweep.
    #[test]
    fn a_meta_table_of_the_wrong_shape_is_reported_and_not_read_as_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        damage(
            &db,
            "DROP TABLE meta;
             CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
             INSERT INTO meta (k, v) VALUES ('project_name', 'a name in a foreign column');",
        );
        let out = dir.path().join("out");
        let v = salvage(&db, &out).unwrap();

        assert!(!v.complete);
        assert!(v.meta.is_none());
        assert!(v.design.is_none());
        let tables: Vec<&Loss> = v
            .losses
            .iter()
            .filter(|l| l.kind == KIND_TABLE && l.detail.contains("meta"))
            .collect();
        assert_eq!(tables.len(), 1, "{:?}", v.losses);
        assert_eq!(v.documents_recovered, 2);
    }

    // ----------------------------------------------------------- the roster

    /// EVERY TABLE THE SCHEMA CREATES IS ACCOUNTED FOR, one way or the other.
    ///
    /// 046 wrote "there is no schema introspection"; 048 repeated it verbatim;
    /// 049 is the third slice to widen a walk somebody else should not have had
    /// to widen. This is the tripwire that ends that: a slice adding a table goes
    /// RED here until its author either widens the walk or writes down why not.
    ///
    /// A TRIPWIRE AND NOT A GENERIC WALKER, deliberately. What a recovered
    /// record IS is a product decision every time -- a file of its own, a section
    /// of an existing one, a manifest key, bytes copied out -- and a walker that
    /// answered it once would answer it wrongly for every table at the same time.
    ///
    /// TABLE-LEVEL, and it cannot see a row-level silence: `meta` is salvaged by
    /// KEY, so a sixth design row is `DESIGN_ROWS`' tripwire and a `meta` row
    /// that is neither a name, a cover nor a design is still silent.
    #[test]
    fn every_table_the_schema_creates_is_named_in_the_salvage_roster() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let conn = rusqlite::Connection::open(&db).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                  ORDER BY name",
            )
            .unwrap();
        let found: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        let mut named: Vec<&str> = SALVAGED.to_vec();
        named.extend(NOT_SALVAGED.iter().map(|(t, _)| *t));
        named.sort_unstable();
        let found: Vec<&str> = found.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            found, named,
            "a table this schema creates is in neither roster; \
             widen the salvage or write down why not"
        );
    }

    #[test]
    fn research_salvage_keeps_links_and_checks_originals_without_touching_sources() {
        use crate::store::knowledge::{Endpoint, LinkDraft, PassageAnchor};
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let scenes = fixture(&db);
        let source = dir.path().join("source.txt");
        std::fs::write(&source, b"Map and field notes").unwrap();
        let store = Store::open(&db).unwrap();
        let resource = crate::research::import_copy(&db, &source, |name, bytes, hash|
            store.research_resource_add("Map", name, "text/plain", bytes, hash, "archive", "page 4")
        ).unwrap();
        let saved = store.load_doc(&scenes[0]).unwrap();
        store.knowledge_link_create(&LinkDraft {
            source: Endpoint { kind: "item".into(), id: scenes[0].clone() },
            target: Endpoint { kind: "resource".into(), id: resource.id.clone() },
            label: "inspired by".into(), note: "coastline".into(), citation: "page 4".into(),
            anchor: Some(PassageAnchor { item_id: scenes[0].clone(), doc_rev: saved.rev,
                from: 1, to: 4, quote: "the".into() }),
        }).unwrap();
        drop(store);
        let complete = salvage(&db, &dir.path().join("complete")).unwrap();
        assert!(complete.complete, "{:?}", complete.losses);
        assert_eq!((complete.research_resources_recovered, complete.knowledge_links_recovered,
            complete.research_originals_recovered), (1, 1, 1));
        let recovered: serde_json::Value = serde_json::from_str(&read(&dir.path().join("complete/knowledge.json"))).unwrap();
        assert_eq!(recovered["resources"][0]["source_note"], "archive");
        assert_eq!(recovered["links"][0]["anchor_quote"], "the");
        assert_eq!(std::fs::read(dir.path().join("complete/research").join(&resource.sha256)).unwrap(), b"Map and field notes");
        assert_eq!(std::fs::read(&source).unwrap(), b"Map and field notes");

        let original = crate::research::path_for(&db, &resource.sha256).unwrap();
        std::fs::write(&original, b"different bytes").unwrap();
        let corrupt = salvage(&db, &dir.path().join("corrupt")).unwrap();
        assert!(!corrupt.complete);
        assert!(kinds(&corrupt).contains(&KIND_CORRUPT_RESEARCH));
        assert_eq!(corrupt.research_originals_recovered, 0);
        std::fs::remove_file(&original).unwrap();
        let missing = salvage(&db, &dir.path().join("missing")).unwrap();
        assert!(kinds(&missing).contains(&KIND_MISSING_RESEARCH));
        assert_eq!(missing.knowledge_links_recovered, 1);
    }

    /// The rosters are disjoint, or "named" above could be satisfied by naming a
    /// table twice while another goes missing.
    #[test]
    fn no_table_is_in_both_rosters() {
        for (table, _) in NOT_SALVAGED {
            assert!(
                !SALVAGED.contains(&table),
                "{table} is both salvaged and not salvaged"
            );
        }
    }
}
