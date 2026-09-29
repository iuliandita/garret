// app/shell-tauri/src-tauri/src/store/cast.rs
// The people, the places and the points of interest a book is about.
//
// THEIR OWN TABLES, AND NOT ITEMS, and that is the whole shape --
// argued from a full survey elsewhere, and this module does not restate the argument.
// The short of it: a cast member has no position in a book, no depth, no
// revision state and no `doc` row, so making one an item would force every
// walker in the tree to learn a THIRD exclusion after the bin and the bible,
// and would drag it into the mirror's `layout`, into `export::manuscript`'s
// headings and into the outline's count rollup.
//
// ONE TABLE WITH A KIND, NOT THREE TABLES. A character, a place and a point of
// interest differ in their FIELDS and in nothing else: each is a name, a
// description and a set of things the writer wants to remember. Three tables
// would be three copies of one CRUD surface, three `inspect` figures, three
// `validate` checks and three lists on the page, to express a difference one
// column already carries.
//
// THE DETAIL IS FREE-FORM NAMED FIELDS, NOT A FIXED SET OF COLUMNS, and this is
// the decision a later reader is most likely to want to "simplify". A fixed set
// FORBIDS THE ASK. A novelist's character sheet is eye colour, accent, the
// wound, the want, the lie they believe; a place is climate, who holds it, what
// it smells like; a point of interest may be a single line about why it matters.
// No enumeration this application writes is the one a given writer needs, and
// every column it guesses wrong at sits empty in every project forever.
//
// WHAT THE FLEXIBLE MODEL COSTS, stated rather than discovered later: nothing
// can be queried BY field, no field can be validated, two members can spell one
// idea two ways ("Eyes" and "eye colour") and nothing notices, and renaming a
// field is per member. WHAT IT FORBIDS: any store-enforced guarantee that a
// named field exists on a member, so no consumer may ever key on one.
//
// A JSON BLOB COLUMN IS REJECTED on a precedent already in this tree. The
// project's spelling wordlist is a TABLE and not a `meta` row because "a `meta`
// row holding a joined string would need its own escaping and its own parser for
// what a PRIMARY KEY gives free". A field list is the same object, and a blob
// would additionally be invisible to `cli::validate`, which is where a damaged
// file is meant to become legible.
//
// THERE IS NO `position` COLUMN AND ORDERING IS BY NAME. That keeps
// `position.rs`'s key space -- its panics, its exhausted front-insert room and
// its malformed-key hazards -- out of this table entirely. It FORBIDS manual
// ordering of the cast, which is accepted: a cast list is a reference a writer
// looks things up in, not an outline they arrange.
//
// A PICTURE IS A COLUMN AND MUST NEVER BECOME A FIELD (schema v8).
// `picture_path` holds a BARE FILENAME
// inside `pictures::dir_for(<project file>)` and the bytes live there as an
// ordinary file. A free-form field is opaque text this store never interprets,
// so a path smuggled into one would be invisible to the recovery `exclusions`
// entry, to the mirror-walk exclusion and to the thumbnail rule that keys on it.
//
// AND IT IS NOT PART OF `cast_set`. The panel calls that on every Save, and its
// UPDATE names four columns; the picture is written only by `cast_set_picture`,
// which is a separate act with a separate command behind it. That separation is
// what makes "saving a character sheet cannot lose their photograph" true by
// construction rather than by remembering to carry a field through a form.
use super::{commit, now_ms, Result, Store, StoreError};
use serde::{Deserialize, Serialize};

/// v7 adds the cast. ADDITIVE ONLY -- two tables and an index, and nothing in
/// v1 through v6 changes shape, so a project carries its prose, its history, its
/// revision states, its comments, its wordlist and its synopses forward
/// untouched.
///
/// `cast_field`'s primary key is `(member_id, ordinal)`, which is what gives the
/// field list an order without a `position` column and without any arithmetic:
/// the ordinals are assigned 0..n by the one writer, `cast_set`, which rewrites
/// the whole list in one transaction. Two rows of one member cannot share a
/// place, and "which order are these in" is a question the file cannot be asked
/// twice.
///
/// `ON DELETE CASCADE` protects referential integrity if a row is externally
/// purged. Normal removal marks it deleted and retains these fields.
///
/// NO CHECK CONSTRAINT on `kind`, for the reason SCHEMA_V3 and SCHEMA_V6 both
/// record: `cast_create` and `cast_set` are the only writers, both decide before
/// any row moves, and SQLite cannot alter a CHECK -- so a constraint here would
/// make a fourth kind a whole-table rebuild rather than one entry in the array
/// below.
pub const SCHEMA_V7: &str = "
CREATE TABLE cast_member (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cast_member_order ON cast_member(kind, name);
CREATE TABLE cast_field (
  member_id TEXT NOT NULL REFERENCES cast_member(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  label     TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (member_id, ordinal)
);
";

/// v8 adds the picture. ONE ADDITIVE ALTER and nothing else changes shape, so a
/// v7 file carries its prose, its history, its revision states, its comments,
/// its wordlist, its synopses AND its whole cast forward untouched.
///
/// A COLUMN, NEVER A FREE-FORM FIELD, and 037's write-back is explicit about
/// why: a `cast_field` row is opaque text this store never interprets, so a path
/// smuggled into one would be invisible to the recovery `exclusions` entry, to
/// the mirror-walk exclusion and to the thumbnail rule that keys on it.
///
/// IT HOLDS A BARE FILENAME, relative to `pictures::dir_for(<project file>)`,
/// and nothing else -- not an absolute path, not a path with a directory part.
/// `pictures::is_stored_name` is the rule and it is applied on the way OUT
/// rather than on the way in, because the page never names one: a picture is
/// attached from a file the writer chose in an OS dialog, under a uuid the host
/// generated. What can hold anything is a damaged file, a foreign tool or a
/// hand-edited row, and those are read, not written.
///
/// NULL IS THE ABSENCE and the empty string is never stored -- `item.state`'s
/// rule, and NULL is also what makes the column arrive correct on every project
/// that predates it without a backfill.
pub const SCHEMA_V8: &str = "
ALTER TABLE cast_member ADD COLUMN picture_path TEXT;
";

/// The floor below which an alias is too likely to be an ordinary word to use
/// as one, restated on the page as `MIN_CAST_NAME_LENGTH` -- the wire contract
/// between the two, `CAST_KINDS`'s own reason for being restated rather than
/// shared: there is no build step joining the page and the host.
pub const MIN_ALIAS_LENGTH: usize = 3;

/// v10 adds the aliases (105, spec section 10, "including aliases"). ADDITIVE
/// ONLY -- one table, and nothing in v1 through v9 changes shape, so a project
/// carries its prose, its history, its revision states, its comments, its
/// wordlist, its synopses, its whole cast (fields and picture paths included)
/// AND its appearances forward untouched.
///
/// `(member_id, ordinal)`, `cast_field`'s own primary key shape and for the
/// same reason: the ordinals are assigned 0..n by the one writer, `cast_set`,
/// which rewrites the whole list in one transaction, so "which order are
/// these in" is a question the file cannot be asked twice.
///
/// `ON DELETE CASCADE`, `cast_field`'s own rule for an external row purge.
/// Normal removal retains aliases with the member.
pub const SCHEMA_V10: &str = "
CREATE TABLE cast_alias (
  member_id TEXT NOT NULL REFERENCES cast_member(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  alias     TEXT NOT NULL,
  PRIMARY KEY (member_id, ordinal)
);
";

/// Retain removed members and their dependent rows without changing their
/// original creation or last-edit timestamps.
pub const SCHEMA_V14: &str = "
ALTER TABLE cast_member ADD COLUMN deleted_at INTEGER;
CREATE INDEX cast_member_active ON cast_member(deleted_at, kind, name);
";

/// Somebody in the book.
pub const KIND_CHARACTER: &str = "character";
/// Somewhere in the book.
pub const KIND_PLACE: &str = "place";
/// Something in the book that is neither: a ship, a sword, a treaty, a scar.
/// The chosen word, kept because "point of interest" is what a writer
/// already calls the drawer everything else goes in.
pub const KIND_POI: &str = "poi";

/// The closed set, in the order the page presents it. RESTATED on the page in
/// `cast-kinds.ts` rather than shared, exactly as the item types are and for the
/// same reason: there is no build step joining the page and the host, and these
/// strings are the wire contract between them.
pub const CAST_KINDS: [&str; 3] = [KIND_CHARACTER, KIND_PLACE, KIND_POI];

/// One named thing a writer wants to remember about a cast member.
///
/// `Deserialize` as well as `Serialize` because this is the one type that
/// crosses the boundary INWARD: the page sends the whole field list on a save.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct CastField {
    pub label: String,
    pub value: String,
}

/// A character, a place or a point of interest, with everything the writer has
/// said about it.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct CastMember {
    pub id: String,
    /// One of `CAST_KINDS`. Typed as a `String` rather than as an enum because
    /// it is what the FILE said, and a newer build's fourth kind must arrive
    /// here as data rather than as a parse failure that closes the project.
    pub kind: String,
    pub name: String,
    /// The paragraph a writer would read first. Plain text, for the reason
    /// `comment.body` and `synopsis.body` are: a second rich-text surface is a
    /// second schema, a second serializer and a second thing to migrate.
    pub summary: String,
    /// In the order the writer put them, which is the order they were sent.
    pub fields: Vec<CastField>,
    /// Other names the prose may call this member by (105, "including
    /// aliases"). In the order the writer put them, which is the order they
    /// were sent -- `fields`' own rule and for the same reason.
    pub aliases: Vec<String>,
    /// The picture's filename inside this project's picture directory, or None.
    ///
    /// A NAME, NOT A PATH, and not the bytes. See `SCHEMA_V8` and
    /// `crate::pictures`. It is what the FILE said, so it is `String` rather
    /// than a validated type: a value this build would never have written must
    /// arrive here as data and be reported as unreadable, not close the project.
    pub picture_path: Option<String>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// An alias list as it will be stored: trimmed, with the form's trailing
/// blank row gone, refused when any survivor is too short, equal to the
/// member's own (trimmed) name, or repeated within the list.
///
/// EVERY REFUSAL DECIDED HERE, before any row moves -- `normalise`'s own rule
/// for the fields, and `cast_set` calls this before opening its transaction
/// for the identical reason.
///
/// AN EMPTY STRING IS DROPPED, NOT REFUSED, same as a blank field-label row:
/// the panel always shows one empty row so there is somewhere to type.
pub(crate) fn normalise_aliases(aliases: &[String], name: &str) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::with_capacity(aliases.len());
    for alias in aliases {
        let alias = alias.trim();
        if alias.is_empty() {
            continue;
        }
        if alias.chars().count() < MIN_ALIAS_LENGTH {
            return Err(StoreError::AliasTooShort {
                alias: alias.to_string(),
            });
        }
        if alias == name {
            return Err(StoreError::AliasIsName {
                alias: alias.to_string(),
            });
        }
        if out.iter().any(|a: &String| a == alias) {
            return Err(StoreError::AliasRepeated {
                alias: alias.to_string(),
            });
        }
        out.push(alias.to_string());
    }
    Ok(out)
}

/// A field list as it will be stored: trimmed, with the form's trailing blank
/// rows gone.
///
/// SEPARATE FROM THE WRITE, and called before any transaction opens, which is
/// the rule `item_set_state` and `synopsis_set` both follow: decide, then write.
///
/// A ROW THAT IS BLANK ON BOTH SIDES IS DROPPED rather than refused. The panel
/// always shows one empty pair at the end so there is somewhere to type, so
/// refusing it would make Save fail on the ordinary path.
///
/// A ROW WITH A VALUE AND NO LABEL IS REFUSED rather than dropped. Dropping it
/// would silently discard something the writer typed, which is the failure this
/// application spends its whole design avoiding; a blank VALUE under a real
/// label is kept, because a writer noting a field they have not filled in yet is
/// saying something.
fn normalise(fields: &[CastField]) -> Result<Vec<CastField>> {
    let mut out = Vec::with_capacity(fields.len());
    for f in fields {
        let label = f.label.trim();
        let value = f.value.trim();
        if label.is_empty() {
            if value.is_empty() {
                continue;
            }
            return Err(StoreError::UnlabelledCastField {
                value: value.to_string(),
            });
        }
        out.push(CastField {
            label: label.to_string(),
            value: value.to_string(),
        });
    }
    Ok(out)
}

/// One of the three, or a refusal by name.
///
/// BY NAME rather than through a CHECK constraint, for SCHEMA_V7's stated
/// reason, and refused BEFORE anything is written, exactly as `item_set_state`
/// refuses an unknown revision state.
fn checked_kind(kind: &str) -> Result<&str> {
    if CAST_KINDS.contains(&kind) {
        Ok(kind)
    } else {
        Err(StoreError::UnknownCastKind {
            kind: kind.to_string(),
        })
    }
}

/// A name with something in it, trimmed, or a refusal.
///
/// REFUSED rather than stored, for the reason `EmptyWord` and `EmptyComment`
/// are: a nameless row would sit in the list forever saying nothing, and it is
/// the one thing about a cast member the writer cannot avoid choosing.
fn checked_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        Err(StoreError::EmptyCastName)
    } else {
        Ok(name)
    }
}

impl Store {
    /// Everyone and everywhere, with their fields, in one pass.
    ///
    /// TWO QUERIES AND NOT ONE PER MEMBER. A list of fifty members with five
    /// fields each is one statement plus one statement, not fifty-one, and the
    /// panel reads this whole list every time it opens.
    ///
    /// ORDERED BY KIND THEN NAME so two reads of an unchanged file give the same
    /// list. `COLLATE NAME_FOLD` is this crate's own collation (`store::
    /// fold_for_sort`), registered on every connection `Store` opens: until
    /// 2026-09-01 this was SQLite's `NOCASE`, an ASCII fold under which "Ärger"
    /// sorted after "Zorn". A raw `rusqlite::Connection` that has not called
    /// `register_collations` cannot run this statement, which is the point --
    /// it fails loudly rather than sorting differently.
    ///
    /// The kind order here is the FILE's, for determinism only. What a writer
    /// sees is the page's declared order in `cast-kinds.ts`, which groups the
    /// list itself.
    pub fn cast_list(&self) -> Result<Vec<CastMember>> {
        self.cast_list_where("WHERE deleted_at IS NULL")
    }

    /// Retained members hidden from active writing surfaces.
    pub fn cast_deleted(&self) -> Result<Vec<CastMember>> {
        if self.user_version()? < 14 {
            return Ok(Vec::new());
        }
        self.cast_list_where("WHERE deleted_at IS NOT NULL")
    }

    /// All retained rows, including removed ones, for recovery and assets.
    pub fn cast_all(&self) -> Result<Vec<CastMember>> {
        self.cast_list_where("")
    }

    fn cast_list_where(&self, filter: &str) -> Result<Vec<CastMember>> {
        let version = self.user_version()?;
        let modern = version >= 14;
        let deleted_column = if modern { "deleted_at" } else { "NULL" };
        let filter = if modern { filter } else { "" };
        let mut stmt = self.conn.prepare(
            &format!("SELECT id, kind, name, summary, created_at, updated_at, picture_path, {deleted_column}
               FROM cast_member
              {filter} ORDER BY kind, name COLLATE NAME_FOLD, id"),
        )?;
        let mut members: Vec<CastMember> = stmt
            .query_map([], |r| {
                Ok(CastMember {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    name: r.get(2)?,
                    summary: r.get(3)?,
                    fields: Vec::new(),
                    aliases: Vec::new(),
                    picture_path: r.get(6)?,
                    deleted_at: r.get(7)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);

        let mut fields = self.conn.prepare(
            "SELECT member_id, label, value FROM cast_field ORDER BY member_id, ordinal",
        )?;
        let rows = fields.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                CastField {
                    label: r.get(1)?,
                    value: r.get(2)?,
                },
            ))
        })?;
        let mut by_member: std::collections::HashMap<String, Vec<CastField>> =
            std::collections::HashMap::new();
        for row in rows {
            let (id, field) = row?;
            by_member.entry(id).or_default().push(field);
        }
        for m in &mut members {
            if let Some(list) = by_member.remove(&m.id) {
                m.fields = list;
            }
        }

        if version >= 10 {
            let mut aliases = self
                .conn
                .prepare("SELECT member_id, alias FROM cast_alias ORDER BY member_id, ordinal")?;
            let alias_rows =
                aliases.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut aliases_by_member: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::new();
            for row in alias_rows {
                let (id, alias) = row?;
                aliases_by_member.entry(id).or_default().push(alias);
            }
            for m in &mut members {
                if let Some(list) = aliases_by_member.remove(&m.id) {
                    m.aliases = list;
                }
            }
        }
        Ok(members)
    }

    /// One member, or None when the id names nothing.
    ///
    /// `#[cfg(test)]`, and that is the honest place for it: the page reads the
    /// WHOLE list every time the panel opens, so a shipped single-member read
    /// would be a second way to say `cast_list` and a second thing to keep in
    /// step with it. It survives here for the reason `word_count_at` does --
    /// as the reference the consumer tests assert against.
    ///
    /// Reads through `cast_list` rather than with a query of its own, because a
    /// second assembly of a member from its two tables is a second chance for
    /// the two to disagree about ordering. The list is small by construction --
    /// a cast is a reference, not a corpus.
    #[cfg(test)]
    pub fn cast_member(&self, id: &str) -> Result<Option<CastMember>> {
        Ok(self.cast_list()?.into_iter().find(|m| m.id == id))
    }

    /// Add somebody, somewhere, or something. The detail comes afterwards
    /// through `cast_set`: a writer knows the name first and everything else
    /// later, and a create that demanded a whole sheet would be a form nobody
    /// finishes.
    pub fn cast_create(&self, kind: &str, name: &str) -> Result<CastMember> {
        let kind = checked_kind(kind)?;
        let name = checked_name(name)?;
        let now = now_ms();
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', ?4, ?4)",
            rusqlite::params![&id, kind, name, now],
        )?;
        Ok(CastMember {
            id,
            kind: kind.to_string(),
            name: name.to_string(),
            summary: String::new(),
            fields: Vec::new(),
            // A new member has no aliases: `cast_create` writes none (105).
            aliases: Vec::new(),
            // A new member has no picture, and the row's column is NULL because
            // the INSERT does not name it.
            picture_path: None,
            deleted_at: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Write the whole member: its kind, its name, its summary and its entire
    /// field list.
    ///
    /// THE WHOLE RECORD IN ONE ACT, not a command per field. The panel is a form
    /// and Save is one press, so a per-field command would make one press N
    /// transactions with N chances to half-apply -- and a writer who deleted a
    /// field would need a delete command, which is a second way to say what
    /// sending a shorter list already says.
    ///
    /// THE FIELDS ARE REPLACED, NOT MERGED. `sync_project_dictionary` renders
    /// rather than appends for the same reason: an incremental write needs a
    /// diff, and a diff of an ordered list keyed by position is exactly the
    /// thing that goes wrong quietly.
    ///
    /// REFUSES AN UNKNOWN MEMBER BY NAME rather than letting the row count
    /// speak, and for the reason `synopsis_set` refuses an unknown item by name:
    /// an UPDATE that matched nothing would report success for a member that is
    /// gone, and the page would show the writer their edit as saved.
    ///
    /// NO `base_rev`, for the reason `comment_set_body` and `synopsis_set` take
    /// none: one row, one writer, one window, one panel, so a revision
    /// discipline would have nothing to guard. There is no `rev` COLUMN either,
    /// unlike the synopsis, and the difference is that a synopsis has a
    /// consumer waiting for one -- the mirror, the day it learns to write a
    /// summary into a file. Nothing will ever compare a cast member's revision,
    /// so a column for it would be a number nobody reads pretending otherwise.
    ///
    /// NO BOUND ON THE NUMBER OF FIELDS, deliberately, and the contrast is
    /// `MAX_COMMENTS_PER_DOCUMENT`. That bound exists because comment anchors
    /// are MAPPED on the typing path, so an unbounded list costs a writer
    /// latency per keystroke. A field list is read when a panel opens and
    /// written when Save is pressed, and never once between them, so a ceiling
    /// here would be a rule with no cost to prevent.
    pub fn cast_set(
        &self,
        id: &str,
        kind: &str,
        name: &str,
        summary: &str,
        fields: &[CastField],
        aliases: &[String],
    ) -> Result<CastMember> {
        // Every refusal decided here, before any row moves.
        let kind = checked_kind(kind)?;
        let name = checked_name(name)?;
        let summary = summary.trim();
        let fields = normalise(fields)?;
        let aliases = normalise_aliases(aliases, name)?;
        let now = now_ms();

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<CastMember> {
            // The picture comes back out of the ROW rather than from the
            // caller, which is the whole of "a save cannot lose a photograph":
            // there is no picture in the arguments to get wrong, and the record
            // this returns is what the file now holds rather than what the form
            // said.
            let (created_at, picture_path): (i64, Option<String>) = self
                .conn
                .query_row(
                    "SELECT created_at, picture_path FROM cast_member WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| StoreError::UnknownCastMember { id: id.to_string() })?;
            self.conn.execute(
                "UPDATE cast_member SET kind = ?2, name = ?3, summary = ?4, updated_at = ?5
                  WHERE id = ?1",
                rusqlite::params![id, kind, name, summary, now],
            )?;
            self.conn
                .execute("DELETE FROM cast_field WHERE member_id = ?1", [id])?;
            for (ordinal, field) in fields.iter().enumerate() {
                self.conn.execute(
                    "INSERT INTO cast_field (member_id, ordinal, label, value)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![id, ordinal as i64, &field.label, &field.value],
                )?;
            }
            self.conn
                .execute("DELETE FROM cast_alias WHERE member_id = ?1", [id])?;
            for (ordinal, alias) in aliases.iter().enumerate() {
                self.conn.execute(
                    "INSERT INTO cast_alias (member_id, ordinal, alias)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, ordinal as i64, alias],
                )?;
            }
            Ok(CastMember {
                id: id.to_string(),
                kind: kind.to_string(),
                name: name.to_string(),
                summary: summary.to_string(),
                fields,
                aliases,
                picture_path,
                deleted_at: None,
                created_at,
                updated_at: now,
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

    /// Hide a member from active surfaces, retaining every dependent record
    /// and the original picture file for explicit restoration.
    pub fn cast_remove(&self, id: &str) -> Result<()> {
        let changed = self
            .conn
            .execute("UPDATE cast_member SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL", rusqlite::params![id, now_ms()])?;
        if changed == 0 {
            return Err(StoreError::UnknownCastMember { id: id.to_string() });
        }
        Ok(())
    }

    pub fn cast_restore(&self, id: &str) -> Result<CastMember> {
        let changed = self.conn.execute(
            "UPDATE cast_member SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
        )?;
        if changed == 0 {
            return Err(StoreError::UnknownCastMember { id: id.to_string() });
        }
        self.cast_list()?.into_iter().find(|member| member.id == id)
            .ok_or_else(|| StoreError::UnknownCastMember { id: id.to_string() })
    }

    /// Point a member at a picture, or at none, and hand back the one it was
    /// pointing at.
    ///
    /// THE PREVIOUS NAME IS THE POINT OF THE RETURN. Once this commits, nothing
    /// in the file names the old file: a caller that could not learn it would
    /// leave a photograph nobody can name or delete in the writer's folder
    /// forever. Replacing and clearing are the same act here for exactly that
    /// reason -- one rule, one call site, no way to handle one and forget the
    /// other.
    ///
    /// IT TAKES A NAME AND DOES NO FILE WORK. The store owns rows; `pictures`
    /// owns bytes. Copying, thumbnailing and deleting are the caller's, so this
    /// stays testable without a filesystem and the store keeps no opinion about
    /// where a project's directory is.
    ///
    /// REFUSES AN UNKNOWN MEMBER BY NAME, for `cast_set`'s reason.
    ///
    /// NO TRANSACTION, and that is a real difference from `cast_set`: this is
    /// one SELECT and one UPDATE of one column of one row, so there is no
    /// second statement for a partial failure to leave half applied. `cast_set`
    /// earns its transaction by rewriting a whole field list.
    pub fn cast_set_picture(
        &self,
        id: &str,
        picture: Option<&str>,
    ) -> Result<(Option<String>, CastMember)> {
        let previous: Option<String> = self
            .conn
            .query_row(
                "SELECT picture_path FROM cast_member WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| StoreError::UnknownCastMember { id: id.to_string() })?;
        self.conn.execute(
            "UPDATE cast_member SET picture_path = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id, picture, now_ms()],
        )?;
        let member = self
            .cast_list()?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| StoreError::UnknownCastMember { id: id.to_string() })?;
        Ok((previous, member))
    }

    /// How many members name a picture.
    ///
    /// `recovery::Completeness`'s figure, and what it MEANS is the point: a
    /// recovery point is a copy of the project FILE, and the pictures are not in
    /// it, so this is how many pictures a snapshot names and therefore how many
    /// it does not contain. Read off whatever handle the caller has, including
    /// `open_readonly`'s, which is what a snapshot is read through.
    pub fn pictures_named(&self) -> Result<u64> {
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM cast_member WHERE picture_path IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        Ok(n as u64)
    }

    /// How many members and how many fields this file holds. `cli::inspect`'s
    /// two figures, and two rather than one because `cast_field` is a table of
    /// its own: a table nothing names is a table nobody can find.
    ///
    /// HERE rather than as two `count_of` strings in `cli.rs`, so the table
    /// names are stated once. `inspect` reads it off its own `open_readonly`
    /// handle, which is what a CLI reading somebody's project must never
    /// migrate.
    pub fn cast_counts(&self) -> Result<(u64, u64)> {
        let members: i64 = self
            .conn
            .query_row("SELECT count(*) FROM cast_member", [], |r| r.get(0))?;
        let fields: i64 = self
            .conn
            .query_row("SELECT count(*) FROM cast_field", [], |r| r.get(0))?;
        Ok((members as u64, fields as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use tempfile::tempdir;

    fn opened() -> (tempfile::TempDir, Store) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        (dir, store)
    }

    fn field(label: &str, value: &str) -> CastField {
        CastField {
            label: label.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn the_list_sorts_names_across_accents_and_case() {
        // NOCASE put "Ärger" after "Zorn" and "ada" after "Zorn" too. Same
        // kind, so the kind key cannot do the sorting for the names.
        let (_dir, store) = opened();
        for name in ["Zorn", "ada", "Ärger", "Éloise", "Bea"] {
            store.cast_create(KIND_CHARACTER, name).unwrap();
        }
        let names: Vec<String> = store
            .cast_list()
            .unwrap()
            .into_iter()
            .filter(|m| m.kind == KIND_CHARACTER)
            .map(|m| m.name)
            .collect();
        assert_eq!(names, vec!["ada", "Ärger", "Bea", "Éloise", "Zorn"]);
    }

    #[test]
    fn a_new_project_has_no_cast() {
        let (_dir, store) = opened();
        assert!(store.cast_list().unwrap().is_empty());
        assert_eq!(store.cast_counts().unwrap(), (0, 0));
    }

    #[test]
    fn a_member_is_created_and_read_back() {
        let (_dir, store) = opened();

        let made = store
            .cast_create(KIND_CHARACTER, "Ilse Vandermeer")
            .unwrap();

        assert_eq!(made.kind, KIND_CHARACTER);
        assert_eq!(made.name, "Ilse Vandermeer");
        assert_eq!(made.summary, "");
        assert!(made.fields.is_empty());
        assert_eq!(made.created_at, made.updated_at);
        assert_eq!(store.cast_list().unwrap(), vec![made]);
        assert_eq!(store.cast_counts().unwrap(), (1, 0));
    }

    #[test]
    fn all_three_kinds_live_in_one_table() {
        // The whole argument for a kind column rather than three tables: the
        // three differ in what a writer puts in them and in nothing the store
        // can see.
        let (_dir, store) = opened();

        store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();
        store.cast_create(KIND_POI, "The burnt letter").unwrap();

        let kinds: Vec<String> = store
            .cast_list()
            .unwrap()
            .into_iter()
            .map(|m| m.kind)
            .collect();
        assert_eq!(kinds, vec![KIND_CHARACTER, KIND_PLACE, KIND_POI]);
    }

    #[test]
    fn a_kind_outside_the_closed_set_is_refused_and_writes_nothing() {
        let (_dir, store) = opened();

        assert!(matches!(
            store.cast_create("dragon", "Smaug"),
            Err(StoreError::UnknownCastKind { .. })
        ));

        assert_eq!(store.cast_counts().unwrap(), (0, 0));
    }

    #[test]
    fn a_member_with_no_name_is_refused() {
        let (_dir, store) = opened();

        assert!(matches!(
            store.cast_create(KIND_PLACE, "   "),
            Err(StoreError::EmptyCastName)
        ));

        assert_eq!(store.cast_counts().unwrap(), (0, 0));
    }

    #[test]
    fn a_name_is_trimmed_on_the_way_in() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_PLACE, "  The Kelp Quay  ").unwrap();
        assert_eq!(made.name, "The Kelp Quay");
    }

    #[test]
    fn the_detail_is_written_and_read_back_in_order() {
        // The fields are an ORDERED list and the order is the writer's, which
        // is what `(member_id, ordinal)` buys. A fixture of one field could not
        // tell an ordered read from an arbitrary one.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse Vandermeer",
                "Keeps the letter she was told to burn.",
                &[
                    field("accent", "flat northern"),
                    field("wants", "to be believed"),
                    field("wound", "the winter her father left"),
                ],
                &[],
            )
            .unwrap();

        assert_eq!(saved.name, "Ilse Vandermeer");
        assert_eq!(saved.summary, "Keeps the letter she was told to burn.");
        let labels: Vec<&str> = saved.fields.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, vec!["accent", "wants", "wound"]);
        assert_eq!(store.cast_member(&made.id).unwrap().unwrap(), saved);
        assert_eq!(store.cast_counts().unwrap(), (1, 3));
    }

    #[test]
    fn each_member_reads_back_its_OWN_fields() {
        // The fixture no other test here has: TWO members carrying DIFFERENT
        // field lists. An assembly that ignored `member_id` and handed every
        // member every field passes every other test in this file, because none
        // of them holds two.
        let (_dir, store) = opened();
        let first = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        let second = store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();
        store
            .cast_set(
                &first.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("accent", "flat")],
                &[],
            )
            .unwrap();
        store
            .cast_set(
                &second.id,
                KIND_PLACE,
                "The Kelp Quay",
                "",
                &[
                    field("smells of", "tar and salt"),
                    field("held by", "the guild"),
                ],
                &[],
            )
            .unwrap();

        let list = store.cast_list().unwrap();
        let ilse = list.iter().find(|m| m.id == first.id).unwrap();
        let quay = list.iter().find(|m| m.id == second.id).unwrap();
        assert_eq!(ilse.fields, vec![field("accent", "flat")]);
        assert_eq!(
            quay.fields,
            vec![
                field("smells of", "tar and salt"),
                field("held by", "the guild")
            ]
        );
        // And a member with none reads as none while two lists exist, which is
        // the other half of the same claim.
        let third = store.cast_create(KIND_POI, "The letter").unwrap();
        assert!(store
            .cast_member(&third.id)
            .unwrap()
            .unwrap()
            .fields
            .is_empty());
    }

    #[test]
    fn a_second_save_REPLACES_the_field_list_rather_than_adding_to_it() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("accent", "flat"), field("wants", "to be believed")],
                &[],
            )
            .unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("wants", "out")],
                &[],
            )
            .unwrap();

        assert_eq!(saved.fields, vec![field("wants", "out")]);
        assert_eq!(store.cast_counts().unwrap(), (1, 1));
    }

    #[test]
    fn a_blank_field_row_is_dropped_and_a_value_with_no_label_is_refused() {
        // The two halves of `normalise`, and they must be told apart: the panel
        // always carries one empty pair so there is somewhere to type, and
        // refusing that would make Save fail on the ordinary path -- while
        // DROPPING a value the writer typed would discard their work silently.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("accent", "flat"), field("  ", "   ")],
                &[],
            )
            .unwrap();
        assert_eq!(saved.fields, vec![field("accent", "flat")]);

        assert!(matches!(
            store.cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("", "flat northern")],
                &[]
            ),
            Err(StoreError::UnlabelledCastField { .. })
        ));
        // And the refusal wrote nothing: the earlier list is still there.
        assert_eq!(
            store.cast_member(&made.id).unwrap().unwrap().fields,
            vec![field("accent", "flat")]
        );
    }

    #[test]
    fn a_field_with_a_label_and_no_value_is_KEPT() {
        // A writer noting a field they have not filled in yet is saying
        // something, so this is the one blank half that survives.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("eyes", "  ")],
                &[],
            )
            .unwrap();

        assert_eq!(saved.fields, vec![field("eyes", "")]);
    }

    #[test]
    fn a_save_against_a_member_that_is_not_there_is_refused_by_name() {
        // BY NAME, not by a row count of zero: an UPDATE matching nothing
        // succeeds, and the page would show the writer their edit as saved.
        let (_dir, store) = opened();

        assert!(matches!(
            store.cast_set("no-such-member", KIND_CHARACTER, "Ilse", "", &[], &[]),
            Err(StoreError::UnknownCastMember { .. })
        ));
    }

    #[test]
    fn a_refused_save_leaves_the_member_it_names_alone() {
        // The refusal is inside the transaction, so this is the assertion that
        // the rollback is real rather than decorative. The kind is checked
        // BEFORE the transaction and the member's existence INSIDE it, so this
        // fixture uses the second: it is the one a rollback can be wrong about.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "kept",
                &[field("accent", "flat")],
                &[],
            )
            .unwrap();

        assert!(store
            .cast_set("no-such-member", KIND_PLACE, "lost", "lost", &[], &[])
            .is_err());

        let held = store.cast_member(&made.id).unwrap().unwrap();
        assert_eq!(held.summary, "kept");
        assert_eq!(held.fields, vec![field("accent", "flat")]);
    }

    #[test]
    fn a_member_can_change_kind() {
        // A writer who filed a ship under places and then decided it was a
        // point of interest must not have to retype the sheet.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();

        let saved = store
            .cast_set(&made.id, KIND_POI, "The Kelp Quay", "", &[], &[])
            .unwrap();

        assert_eq!(saved.kind, KIND_POI);
        assert_eq!(store.cast_member(&made.id).unwrap().unwrap().kind, KIND_POI);
    }

    #[test]
    fn a_save_keeps_the_created_time_and_moves_the_updated_one() {
        // `created_at` is read from the row being replaced rather than
        // recomputed, so an edit cannot make a member look new.
        //
        // THE SLEEP IS LOAD-BEARING. Both stamps are `now_ms()`, so inside one
        // millisecond the correct implementation and one that recomputed
        // `created_at` give the same answer -- the recorded shape where a
        // fixture agrees with the mutation it was written to catch.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));

        let saved = store
            .cast_set(&made.id, KIND_CHARACTER, "Ilse", "changed", &[], &[])
            .unwrap();

        assert_eq!(saved.created_at, made.created_at);
        assert!(
            saved.updated_at > made.updated_at,
            "updated_at did not move: {} then {}",
            made.updated_at,
            saved.updated_at
        );
        // And the file agrees with what the call returned.
        let held = store.cast_member(&made.id).unwrap().unwrap();
        assert_eq!(held.created_at, made.created_at);
        assert_eq!(held.updated_at, saved.updated_at);
    }

    #[test]
    fn removing_a_member_retains_its_fields_for_restore() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[field("accent", "flat")],
                &[],
            )
            .unwrap();
        let other = store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();
        store
            .cast_set(
                &other.id,
                KIND_PLACE,
                "The Kelp Quay",
                "",
                &[field("held by", "the guild")],
                &[],
            )
            .unwrap();

        store.cast_remove(&made.id).unwrap();

        assert_eq!(store.cast_counts().unwrap(), (2, 2));
        assert_eq!(store.cast_member(&made.id).unwrap(), None);
        assert_eq!(store.cast_deleted().unwrap()[0].fields, vec![field("accent", "flat")]);
        assert_eq!(store.cast_restore(&made.id).unwrap().fields, vec![field("accent", "flat")]);
        assert_eq!(
            store.cast_member(&other.id).unwrap().unwrap().fields,
            vec![field("held by", "the guild")]
        );
    }

    #[test]
    fn v13_cast_migrates_without_losing_detail_or_picture() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let store = super::super::historical_test_store(&path, 13);
        let member_id = "legacy-member";
        store
            .conn
            .execute_batch(
                "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at, picture_path)
             VALUES ('legacy-member', 'character', 'Ilse', 'singer', 1, 1, 'face.png');
             INSERT INTO cast_field (member_id, ordinal, label, value)
             VALUES ('legacy-member', 0, 'voice', 'alto');
             INSERT INTO cast_alias (member_id, ordinal, alias)
             VALUES ('legacy-member', 0, 'Ils');",
            )
            .unwrap();
        drop(store);

        let migrated = Store::open(&path).unwrap();
        let member = migrated.cast_list().unwrap().remove(0);
        assert_eq!(
            migrated.user_version().unwrap(),
            super::super::SCHEMA_VERSION
        );
        assert_eq!(member.id, member_id);
        assert_eq!(member.summary, "singer");
        assert_eq!(member.fields, vec![field("voice", "alto")]);
        assert_eq!(member.aliases, vec!["Ils"]);
        assert_eq!(member.picture_path.as_deref(), Some("face.png"));
        assert_eq!(member.deleted_at, None);
    }

    #[test]
    fn removing_a_member_that_is_not_there_is_refused_by_name() {
        let (_dir, store) = opened();
        assert!(matches!(
            store.cast_remove("no-such-member"),
            Err(StoreError::UnknownCastMember { .. })
        ));
    }

    #[test]
    fn the_list_is_ordered_by_kind_then_by_name_ignoring_case() {
        // Two reads of an unchanged file must give one list. The fixture is
        // deliberately inserted in an order that is neither the answer nor its
        // reverse, and carries a lower-case name that would sort after every
        // capital under a byte comparison.
        let (_dir, store) = opened();
        store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();
        store.cast_create(KIND_CHARACTER, "Zoya").unwrap();
        store.cast_create(KIND_CHARACTER, "ilse").unwrap();
        store.cast_create(KIND_POI, "The burnt letter").unwrap();
        store.cast_create(KIND_CHARACTER, "Anders").unwrap();

        let names: Vec<String> = store
            .cast_list()
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();

        assert_eq!(
            names,
            vec![
                "Anders",
                "ilse",
                "Zoya",
                "The Kelp Quay",
                "The burnt letter"
            ]
        );
    }

    #[test]
    fn the_closed_set_is_the_three_the_owner_asked_for() {
        // A guard on the wire contract rather than on behaviour: the page
        // restates these three strings in `cast-kinds.ts`, and a fourth added
        // on one side only must break a test rather than pass silently.
        assert_eq!(CAST_KINDS, ["character", "place", "poi"]);
    }

    // ------------------------------------------------------- v8, the picture

    #[test]
    fn a_new_member_has_no_picture_and_the_absence_is_null() {
        let (_dir, store) = opened();

        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        assert_eq!(made.picture_path, None);
        assert_eq!(
            store.cast_member(&made.id).unwrap().unwrap().picture_path,
            None
        );
        assert_eq!(store.pictures_named().unwrap(), 0);
        // NULL, never the empty string. `item.state`'s rule: a default written
        // as a value is free to drift from the code's idea of the default, and
        // it makes "no picture" and "a picture called nothing" two states of
        // one fact.
        let raw: Option<String> = store
            .conn
            .query_row(
                "SELECT picture_path FROM cast_member WHERE id = ?1",
                [&made.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw, None);
    }

    #[test]
    fn a_picture_is_named_on_the_member_and_read_back() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();

        let (previous, updated) = store.cast_set_picture(&made.id, Some("a.jpg")).unwrap();

        assert_eq!(previous, None);
        assert_eq!(updated.picture_path.as_deref(), Some("a.jpg"));
        assert_eq!(
            store.cast_list().unwrap()[0].picture_path.as_deref(),
            Some("a.jpg")
        );
        assert_eq!(store.pictures_named().unwrap(), 1);
    }

    #[test]
    fn replacing_a_picture_hands_back_the_one_it_replaced() {
        // LOAD-BEARING, not bookkeeping: the previous name is the only handle
        // anything has on the file that is now unreachable, and a caller that
        // could not learn it would leave a photograph nobody can name or delete
        // in the writer's folder forever.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_set_picture(&made.id, Some("old.png")).unwrap();

        let (previous, updated) = store.cast_set_picture(&made.id, Some("new.jpg")).unwrap();

        assert_eq!(previous.as_deref(), Some("old.png"));
        assert_eq!(updated.picture_path.as_deref(), Some("new.jpg"));
    }

    #[test]
    fn clearing_a_picture_hands_back_the_one_it_removed() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_set_picture(&made.id, Some("old.png")).unwrap();

        let (previous, updated) = store.cast_set_picture(&made.id, None).unwrap();

        assert_eq!(previous.as_deref(), Some("old.png"));
        assert_eq!(updated.picture_path, None);
        assert_eq!(store.pictures_named().unwrap(), 0);
    }

    #[test]
    fn a_picture_set_on_a_member_that_is_gone_is_refused_by_name() {
        // `cast_set`'s rule and `synopsis_set`'s: an UPDATE that matched nothing
        // would report success for a member that is not there, and the page
        // would show the writer a picture as attached to nobody.
        let (_dir, store) = opened();

        assert!(matches!(
            store.cast_set_picture("nobody", Some("a.png")),
            Err(StoreError::UnknownCastMember { .. })
        ));
    }

    #[test]
    fn saving_the_record_leaves_the_picture_exactly_where_it_was() {
        // THE ONE THING A LATER READER WILL BREAK. `cast_set` writes the whole
        // record and the panel calls it on every Save; if it ever names
        // `picture_path` in its UPDATE, every save of a character sheet throws
        // their photograph away. It is preserved BY CONSTRUCTION -- the UPDATE
        // names four columns and this is a fifth -- and that construction is
        // what this test exists to keep.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_set_picture(&made.id, Some("face.jpg")).unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_POI,
                "Ilse Vandermeer",
                "she keeps the letter",
                &[field("accent", "flat northern")],
                &[],
            )
            .unwrap();

        assert_eq!(saved.picture_path.as_deref(), Some("face.jpg"));
        assert_eq!(
            store
                .cast_member(&made.id)
                .unwrap()
                .unwrap()
                .picture_path
                .as_deref(),
            Some("face.jpg")
        );
    }

    #[test]
    fn removing_a_member_retains_its_picture() {
        let (_dir, store) = opened();
        let with = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_set_picture(&with.id, Some("face.jpg")).unwrap();
        let without = store.cast_create(KIND_PLACE, "The Quay").unwrap();

        store.cast_remove(&with.id).unwrap();
        store.cast_remove(&without.id).unwrap();
        assert_eq!(store.cast_counts().unwrap(), (2, 0));
        assert_eq!(store.pictures_named().unwrap(), 1);
        assert_eq!(store.cast_deleted().unwrap().len(), 2);
        assert!(matches!(store.cast_set_picture(&with.id, None), Err(StoreError::UnknownCastMember { .. })));
        assert_eq!(store.cast_restore(&with.id).unwrap().picture_path.as_deref(), Some("face.jpg"));
    }

    #[test]
    fn the_picture_count_is_the_members_that_name_one() {
        // `recovery::Completeness`'s figure: how many pictures a snapshot NAMES
        // and therefore how many it does not contain. Three members and two
        // pictures, so the number cannot be the member count by accident.
        let (_dir, store) = opened();
        let a = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        let b = store.cast_create(KIND_PLACE, "The Quay").unwrap();
        store.cast_create(KIND_POI, "The letter").unwrap();
        store.cast_set_picture(&a.id, Some("a.png")).unwrap();
        store.cast_set_picture(&b.id, Some("b.jpg")).unwrap();

        assert_eq!(store.pictures_named().unwrap(), 2);
        assert_eq!(store.cast_counts().unwrap(), (3, 0));
    }

    // -------------------------------------------------------- v10, aliases

    fn alias(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn a_new_member_has_no_aliases() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        assert!(made.aliases.is_empty());
        assert!(store
            .cast_member(&made.id)
            .unwrap()
            .unwrap()
            .aliases
            .is_empty());
    }

    #[test]
    fn aliases_are_written_and_read_back_in_order() {
        let (_dir, store) = opened();
        let made = store
            .cast_create(KIND_CHARACTER, "Marisol Quillfeather")
            .unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Marisol Quillfeather",
                "",
                &[],
                &[alias("Quill"), alias("Marisol")],
            )
            .unwrap();

        assert_eq!(saved.aliases, vec!["Quill", "Marisol"]);
        assert_eq!(
            store.cast_member(&made.id).unwrap().unwrap().aliases,
            vec!["Quill", "Marisol"]
        );
    }

    /// THE ORDER IS THE ORDINAL'S, NOT THE ROW'S. `cast_set` always inserts
    /// 0..n in sequence, so a plain scan with no `ORDER BY` at all would
    /// still answer 0,1 for a file it wrote itself -- `aliases_are_written_
    /// and_read_back_in_order` above cannot tell a working `ORDER BY` from a
    /// deleted one for exactly that reason, `salvage.rs`'s own recorded
    /// shape ("a fixture can be a fact about itself") in a new costume. This
    /// writes the rows OUT OF ROWID ORDER through raw SQL -- ordinal 1
    /// first, ordinal 0 second -- so a plain scan answers 1,0 and only the
    /// `ORDER BY` in `cast_list` can still answer 0,1.
    #[test]
    fn cast_list_orders_aliases_by_ordinal_not_by_row() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .conn
            .execute(
                "INSERT INTO cast_alias (member_id, ordinal, alias) VALUES (?1, 1, 'Second')",
                [&made.id],
            )
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO cast_alias (member_id, ordinal, alias) VALUES (?1, 0, 'First')",
                [&made.id],
            )
            .unwrap();

        let aliases = store.cast_member(&made.id).unwrap().unwrap().aliases;

        assert_eq!(aliases, vec!["First", "Second"]);
    }

    #[test]
    fn each_member_reads_back_its_OWN_aliases() {
        // `each_member_reads_back_its_OWN_fields`'s own fixture, one table
        // over: an assembly that ignored `member_id` and handed every member
        // every alias passes every other test in this file.
        let (_dir, store) = opened();
        let first = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        let second = store.cast_create(KIND_PLACE, "The Kelp Quay").unwrap();
        store
            .cast_set(&first.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Ils")])
            .unwrap();
        store
            .cast_set(
                &second.id,
                KIND_PLACE,
                "The Kelp Quay",
                "",
                &[],
                &[alias("Kelp"), alias("The Quay")],
            )
            .unwrap();

        let list = store.cast_list().unwrap();
        let ilse = list.iter().find(|m| m.id == first.id).unwrap();
        let quay = list.iter().find(|m| m.id == second.id).unwrap();
        assert_eq!(ilse.aliases, vec!["Ils"]);
        assert_eq!(quay.aliases, vec!["Kelp", "The Quay"]);
    }

    #[test]
    fn a_second_save_REPLACES_the_alias_list_rather_than_adding_to_it() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[],
                &[alias("Ils"), alias("Els")],
            )
            .unwrap();

        let saved = store
            .cast_set(&made.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Vee")])
            .unwrap();

        assert_eq!(saved.aliases, vec!["Vee"]);
    }

    #[test]
    fn a_blank_alias_row_is_dropped() {
        // The panel always shows one empty row so there is somewhere to type;
        // refusing it would make Save fail on the ordinary path -- `normalise`'s
        // own rule for a field row blank on both sides.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        let saved = store
            .cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[],
                &[alias("Ils"), alias("   ")],
            )
            .unwrap();

        assert_eq!(saved.aliases, vec!["Ils"]);
    }

    #[test]
    fn an_alias_under_three_characters_is_refused_and_writes_nothing() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        // A prior save that must survive the refused one below untouched.
        store
            .cast_set(&made.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Ils")])
            .unwrap();

        assert!(matches!(
            store.cast_set(&made.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Il")]),
            Err(StoreError::AliasTooShort { alias }) if alias == "Il"
        ));
        assert_eq!(
            store.cast_member(&made.id).unwrap().unwrap().aliases,
            vec!["Ils"]
        );
    }

    #[test]
    fn an_alias_equal_to_the_members_own_name_is_refused() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        assert!(matches!(
            store.cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[],
                &[alias("Ilse")]
            ),
            Err(StoreError::AliasIsName { alias }) if alias == "Ilse"
        ));
    }

    #[test]
    fn a_repeated_alias_within_one_member_is_refused() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();

        assert!(matches!(
            store.cast_set(
                &made.id,
                KIND_CHARACTER,
                "Ilse",
                "",
                &[],
                &[alias("Ils"), alias("Ils")]
            ),
            Err(StoreError::AliasRepeated { alias }) if alias == "Ils"
        ));
    }

    #[test]
    fn an_alias_identical_to_another_members_name_is_allowed() {
        // The decision record's own words: the tie-break on the matcher's side
        // decides deterministically, and the store says nothing about it.
        let (_dir, store) = opened();
        let ilse = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store.cast_create(KIND_CHARACTER, "Quay").unwrap();

        let saved = store
            .cast_set(&ilse.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Quay")])
            .unwrap();

        assert_eq!(saved.aliases, vec!["Quay"]);
    }

    #[test]
    fn cast_create_writes_no_aliases() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        assert!(made.aliases.is_empty());
    }

    #[test]
    fn removing_a_member_retains_its_aliases() {
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .cast_set(&made.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Ils")])
            .unwrap();

        store.cast_remove(&made.id).unwrap();

        let raw: i64 = store
            .conn
            .query_row("SELECT count(*) FROM cast_alias", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, 1);
        assert_eq!(store.cast_restore(&made.id).unwrap().aliases, vec!["Ils"]);
    }

    #[test]
    fn a_refused_alias_save_leaves_the_members_earlier_aliases_alone() {
        // The refusal is inside the transaction, `a_refused_save_leaves_the_
        // member_it_names_alone`'s own fixture shape for the alias table.
        let (_dir, store) = opened();
        let made = store.cast_create(KIND_CHARACTER, "Ilse").unwrap();
        store
            .cast_set(&made.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Ils")])
            .unwrap();

        assert!(store
            .cast_set(&made.id, KIND_CHARACTER, "Ilse", "", &[], &[alias("Il")])
            .is_err());

        assert_eq!(
            store.cast_member(&made.id).unwrap().unwrap().aliases,
            vec!["Ils"]
        );
    }
}
