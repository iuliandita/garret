// app/shell-tauri/src-tauri/src/store/comments.rs
// Notes a writer leaves on a passage of their own manuscript, and the hardest
// thing about them is that the passage keeps moving.
//
// AN ANCHOR IS A PAIR OF PROSEMIRROR DOCUMENT POSITIONS, and this module does
// not know what one is. It stores two integers, hands them back, and lets the
// page map them through every transaction -- which is the only place the
// mapping can happen, because ProseMirror owns the transform and the store
// never sees one. What the store owns is the rule that a written anchor and the
// body it describes reach the file TOGETHER: positions ride the flush (see
// `Store::flush`), never a schedule of their own, because two schedules are two
// states of one fact and they are free to disagree about where a note is.
//
// AN ORPHAN IS DERIVED, NEVER STORED. A comment whose range the writer deleted
// has `anchor_from >= anchor_to` and that IS the definition -- there is no
// `orphaned` column to fall out of step with the pair it would describe, the
// same argument `snapshot_id IS NULL` makes for an automatic version and NULL
// makes for the `none` revision state. `create` refuses an empty range, so the
// collapsed pair can only ever mean "this was destroyed by an edit".
//
// RESOLVED IS KEPT, NEVER DELETED. Same rule as history: this application does
// not destroy the writer's material. `resolved_at` is NULL while a note is
// open, and the timestamp is the fact rather than a flag beside one.
use super::{commit, now_ms, Result, Store, StoreError, TIMELINE_TYPE};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

/// The most notes one document may carry.
///
/// RESTATED, deliberately, in `app/ui/src/comments.ts` as `MAX_MAPPED_COMMENTS`
/// -- the two cannot import each other and they answer for different costs. The
/// page's is a bound on work done INSIDE a transaction, i.e. on the keystroke
/// path: every comment on the open document is mapped through `tr.mapping` on
/// every document change, so the ceiling is what stops a pathological file
/// turning typing into O(comments) per character. This one is a bound on what
/// can reach the file at all, so the page's ceiling is not normally reachable
/// through the application -- but a project is a file, and the store is not the
/// only thing that can write one, which is why the page bounds itself rather
/// than trusting this.
///
/// 500 is chosen against the manuscript rather than against the arithmetic: a
/// heavily annotated scene in a revision pass carries tens of notes, and five
/// hundred on ONE scene is a file nobody typed. `app/ui/test/comments.test.ts`
/// parses this constant and fails when the two numbers disagree.
pub const MAX_COMMENTS_PER_DOCUMENT: i64 = 500;

/// One note, as the page reads it. snake_case by the recorded rule: command
/// ARGUMENTS are camelCase, returned struct fields are not.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Comment {
    pub id: i64,
    pub item_id: String,
    /// What the writer wrote. Plain text: a note about prose is not prose, and a
    /// second rich-text surface is a second schema, a second serializer and a
    /// second thing to migrate.
    pub body: String,
    pub anchor_from: i64,
    pub anchor_to: i64,
    /// The passage as it read when the note was made. Kept because it is the
    /// ONLY thing an orphan has left: once the range is gone there is nothing in
    /// the document to quote, and a note whose subject cannot be named is a note
    /// the writer cannot act on.
    pub quote: String,
    /// Derived from the pair above, never stored. See the module header.
    pub orphaned: bool,
    pub resolved: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Where one note currently sits, as the page reports it back on a flush.
///
/// Deserialize only: this is an argument, and it arrives inside a `FlushEntry`.
#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
pub struct CommentAnchor {
    pub id: i64,
    pub from: i64,
    pub to: i64,
}

/// v4 adds comments. ADDITIVE ONLY -- one table and one index, nothing in v1,
/// v2 or v3 changes shape, so a project carries its prose, its history and its
/// revision states forward untouched.
///
/// `resolved_at` rather than a `resolved` flag, and `anchor_from`/`anchor_to`
/// rather than a pair plus an `orphaned` flag: both are the same rule, which is
/// that a fact gets one statement in the file. See the module header.
///
/// NO CHECK CONSTRAINT on the range, for the reason SCHEMA_V3 records for the
/// state set: `create` is the only writer that may refuse, it refuses before any
/// row moves, and SQLite cannot alter a CHECK -- so a constraint here would make
/// the next rule change a whole-table rebuild.
pub const SCHEMA_V4: &str = "
CREATE TABLE comment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  anchor_from INTEGER NOT NULL,
  anchor_to   INTEGER NOT NULL,
  quote       TEXT NOT NULL,
  resolved_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX comment_item ON comment(item_id, anchor_from);
";

impl Store {
    /// Every note on one document, in the order their passages appear in it.
    ///
    /// Prose order rather than time order, because the panel is read beside the
    /// scene: a writer scanning their notes is walking down the page. An orphan
    /// sorts where its passage used to be, which is the most useful thing left
    /// to say about where it belonged.
    ///
    /// RESOLVED ONES ARE INCLUDED. Hiding them here would make "kept" a claim
    /// with no way to check it, and the panel -- which owns the toggle -- would
    /// have nothing to toggle.
    pub fn comments(&self, item_id: &str) -> Result<Vec<Comment>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, item_id, body, anchor_from, anchor_to, quote, resolved_at,
                    created_at, updated_at
               FROM comment
              WHERE item_id = ?1
              ORDER BY anchor_from ASC, id ASC",
        )?;
        let rows = stmt.query_map([item_id], |r| {
            let anchor_from: i64 = r.get(3)?;
            let anchor_to: i64 = r.get(4)?;
            let resolved_at: Option<i64> = r.get(6)?;
            Ok(Comment {
                id: r.get(0)?,
                item_id: r.get(1)?,
                body: r.get(2)?,
                anchor_from,
                anchor_to,
                quote: r.get(5)?,
                orphaned: anchor_from >= anchor_to,
                resolved: resolved_at.is_some(),
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Attach a note to a range of one document.
    ///
    /// REFUSES AN EMPTY RANGE, and that refusal is what makes the orphan rule
    /// legible: with it, `anchor_from >= anchor_to` in the file can only have
    /// been produced by an edit that destroyed the passage. Without it the same
    /// pair would also mean "the writer commented on nothing", and the panel
    /// would tell them a passage was deleted that never existed.
    ///
    /// REFUSES AN EMPTY BODY. A note with no text is indistinguishable from a
    /// mis-press, and it would decorate the writer's prose forever saying
    /// nothing.
    ///
    /// REFUSES PAST `MAX_COMMENTS_PER_DOCUMENT`, in the same transaction that
    /// would insert, so the count cannot be beaten by two calls in flight.
    ///
    /// REFUSES A TIMELINE (101): a STORE-API INVARIANT with no path a writer
    /// can reach in this build. There is no editor over a timeline yet (the
    /// page never offers Add comment while one is open, and activating one
    /// opens nothing at all -- see `open.ts`), so this refusal exists for the
    /// commands and CLIs that call `comment_create` directly, and for 102/103,
    /// which are expected to open that door. Checked OUTSIDE the transaction
    /// below and against `item.type` alone, not `WHERE EXISTS`: an id naming
    /// NO row and an id naming a timeline are different refusals, and this is
    /// what tells them apart before either one reaches the insert.
    pub fn comment_create(
        &self,
        item_id: &str,
        body: &str,
        anchor_from: i64,
        anchor_to: i64,
        quote: &str,
    ) -> Result<Comment> {
        let body = body.trim();
        if body.is_empty() {
            return Err(StoreError::EmptyComment);
        }
        if anchor_from >= anchor_to {
            return Err(StoreError::EmptyRange);
        }
        let item_type: Option<String> = self
            .conn
            .query_row("SELECT type FROM item WHERE id = ?1", [item_id], |r| r.get(0))
            .optional()?;
        if item_type.as_deref() == Some(TIMELINE_TYPE) {
            return Err(StoreError::TimelineComment);
        }
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        // Counted INSIDE the transaction it would insert in, so two calls in
        // flight cannot both read `limit - 1` and both write.
        let existing = match self.comment_count(item_id) {
            Ok(n) => n,
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        };
        if existing >= MAX_COMMENTS_PER_DOCUMENT {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(StoreError::TooManyComments {
                item_id: item_id.to_string(),
                limit: MAX_COMMENTS_PER_DOCUMENT,
            });
        }
        let inserted = self.conn.execute(
            "INSERT INTO comment
               (item_id, body, anchor_from, anchor_to, quote, resolved_at, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6
              WHERE EXISTS (SELECT 1 FROM item WHERE id = ?1)",
            rusqlite::params![item_id, body, anchor_from, anchor_to, quote, now],
        );
        let inserted = match inserted {
            Ok(n) => n,
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
        };
        if inserted == 0 {
            // The WHERE EXISTS rather than the foreign key, so the answer names
            // the item instead of arriving as a constraint violation the page
            // would have to parse.
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(StoreError::UnknownItem {
                item_id: item_id.to_string(),
            });
        }
        let id = self.conn.last_insert_rowid();
        commit(&self.conn)?;
        Ok(Comment {
            id,
            item_id: item_id.to_string(),
            body: body.to_string(),
            anchor_from,
            anchor_to,
            quote: quote.to_string(),
            orphaned: false,
            resolved: false,
            created_at: now,
            updated_at: now,
        })
    }

    /// Rewrite what a note says. The anchor is untouched: editing the words of a
    /// note is not a claim about where it points.
    pub fn comment_set_body(&self, id: i64, body: &str) -> Result<()> {
        let body = body.trim();
        if body.is_empty() {
            return Err(StoreError::EmptyComment);
        }
        let changed = self.conn.execute(
            "UPDATE comment SET body = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![body, now_ms(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::UnknownComment { id });
        }
        Ok(())
    }

    /// Settle a note, or reopen one.
    ///
    /// Reopening exists because resolving is one press and a writer who
    /// mis-presses must not have destroyed the note -- which, since nothing here
    /// deletes, is exactly what an irreversible resolve would amount to in
    /// practice.
    ///
    /// The anchor is untouched in BOTH directions, so a resolved note is still
    /// mapped by the page and comes back pointing at the passage it was always
    /// about. Freezing it while resolved would make reopening a note that points
    /// somewhere it never pointed.
    pub fn comment_set_resolved(&self, id: i64, resolved: bool) -> Result<()> {
        let at: Option<i64> = if resolved { Some(now_ms()) } else { None };
        let changed = self.conn.execute(
            "UPDATE comment SET resolved_at = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![at, now_ms(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::UnknownComment { id });
        }
        Ok(())
    }

    /// Move a document's notes to where the page says they now are.
    ///
    /// PRIVATE TO THE FLUSH, and it takes no transaction of its own: `flush`
    /// calls it inside the one it already opened, which is the whole design.
    /// Positions and the body they describe are one write or they are two states
    /// that can disagree about where a note is -- and the disagreement would be
    /// invisible until the writer reopened the scene and found a note underlining
    /// a sentence it was never about.
    ///
    /// SCOPED BY item_id as well as by comment id. Without that a flush of scene
    /// A could move a note belonging to scene B, and the page would only have to
    /// be wrong about which document it was flushing.
    ///
    /// A comment id that matches NO ROW AT ALL is ignored, not an error. The
    /// note may have been resolved away by another surface, and the writer's
    /// prose must not fail to save because a note went missing.
    ///
    /// A comment id that matches a row belonging to ANOTHER DOCUMENT is
    /// refused, and the two cases are told apart deliberately: both update zero
    /// rows, but they mean different things. The first is a note that is gone;
    /// the second is the page wrong about which document it is flushing, which
    /// is the same boundary the flush already refuses a whole batch at on a
    /// revision conflict -- and refusing there exists precisely so notes cannot
    /// end up describing prose nobody wrote. The extra lookup runs only on a
    /// miss, which no correct flush produces.
    pub(super) fn apply_comment_anchors(
        &self,
        item_id: &str,
        anchors: &[CommentAnchor],
    ) -> Result<()> {
        if anchors.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        let mut stmt = self.conn.prepare_cached(
            "UPDATE comment SET anchor_from = ?1, anchor_to = ?2, updated_at = ?3
              WHERE id = ?4 AND item_id = ?5",
        )?;
        for anchor in anchors {
            let changed = stmt.execute(rusqlite::params![
                anchor.from,
                anchor.to,
                now,
                anchor.id,
                item_id
            ])?;
            if changed == 0 {
                let owner: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT item_id FROM comment WHERE id = ?1",
                        [anchor.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if owner.is_some() {
                    return Err(StoreError::ForeignComment {
                        id: anchor.id,
                        item_id: item_id.to_string(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Collapse a document's live anchors, because its body was REPLACED
    /// wholesale by something the store cannot map the old positions through.
    ///
    /// PRIVATE TO history.rs, and it takes no transaction of its own: every
    /// caller runs it inside the transaction that writes the body, for the same
    /// reason `apply_comment_anchors` does. The body and what its notes point at
    /// are one write or they are two states free to disagree.
    ///
    /// COLLAPSING IS THE HONEST ANSWER, and the alternatives are both worse.
    /// Keeping the offsets leaves each note underlining whatever prose now
    /// happens to sit at those positions -- silently re-anchoring, which this
    /// module's header names as the worst thing this feature could do. Deleting
    /// the rows destroys what the writer wrote about their own book. A collapsed
    /// pair already MEANS "an edit destroyed this passage" (see the header), and
    /// a restore is exactly that: the row keeps its text and still quotes what
    /// the passage used to say.
    ///
    /// Only LIVE anchors are touched. One already collapsed is already an
    /// orphan, and rewriting it would move its `updated_at` for nothing.
    /// Resolved notes are collapsed like any other: resolved is not deleted, and
    /// reopening one must not bring it back pointing where it never pointed.
    pub(super) fn orphan_comment_anchors(&self, item_id: &str, now: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE comment SET anchor_to = anchor_from, updated_at = ?2
              WHERE item_id = ?1 AND anchor_from < anchor_to",
            rusqlite::params![item_id, now],
        )?)
    }

    /// How many notes one document carries. One statement of the count, used by
    /// the ceiling check above and by the tests that prove it fires; the page
    /// counts the list it already holds.
    pub fn comment_count(&self, item_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM comment WHERE item_id = ?1",
            [item_id],
            |r| r.get(0),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{FlushEntry, Store};
    use tempfile::tempdir;

    fn seeded() -> (tempfile::TempDir, Store, String) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "scene", "A scene").unwrap();
        let id = created.id.clone();
        store
            .flush(&[FlushEntry {
                item_id: id.clone(),
                body: r#"{"type":"doc","content":[]}"#.to_string(),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        (dir, store, id)
    }

    #[test]
    fn a_comment_is_created_and_listed() {
        let (_dir, store, item) = seeded();

        let made = store
            .comment_create(&item, "check this line", 4, 11, "the moon")
            .unwrap();

        let listed = store.comments(&item).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, made.id);
        assert_eq!(listed[0].body, "check this line");
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (4, 11));
        assert_eq!(listed[0].quote, "the moon");
        assert!(!listed[0].orphaned);
        assert!(!listed[0].resolved);
    }

    #[test]
    fn an_empty_range_is_refused() {
        // Load-bearing, not hygiene: it is what makes a collapsed pair in the
        // file mean "an edit destroyed this" and nothing else.
        let (_dir, store, item) = seeded();

        assert!(matches!(
            store.comment_create(&item, "note", 7, 7, ""),
            Err(StoreError::EmptyRange)
        ));
        assert!(matches!(
            store.comment_create(&item, "note", 9, 7, ""),
            Err(StoreError::EmptyRange)
        ));
        assert_eq!(store.comment_count(&item).unwrap(), 0);
    }

    /// MUTATION TARGET 4. There is no editor over a timeline in this build, so
    /// no writer ever selected a range inside one, and a comment landing on
    /// (1, 4) anyway would be created already orphaned.
    #[test]
    fn a_comment_on_a_timeline_is_refused() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let bible = store.item_create(None, super::super::BIBLE_TYPE, "Bible").unwrap();
        let timeline = store
            .item_create(Some(&bible.id), TIMELINE_TYPE, "Timeline")
            .unwrap();

        assert!(matches!(
            store.comment_create(&timeline.id, "note", 1, 4, "quote"),
            Err(StoreError::TimelineComment)
        ));
        assert_eq!(store.comment_count(&timeline.id).unwrap(), 0);
    }

    #[test]
    fn an_empty_body_is_refused_and_a_padded_one_is_trimmed() {
        let (_dir, store, item) = seeded();

        assert!(matches!(
            store.comment_create(&item, "   ", 1, 4, "a"),
            Err(StoreError::EmptyComment)
        ));

        let made = store
            .comment_create(&item, "  spaced  ", 1, 4, "a")
            .unwrap();
        assert_eq!(made.body, "spaced");
        assert_eq!(store.comments(&item).unwrap()[0].body, "spaced");
    }

    #[test]
    fn a_comment_on_an_unknown_item_is_refused_by_name() {
        let (_dir, store, _item) = seeded();

        assert!(matches!(
            store.comment_create("no-such-item", "note", 1, 4, "a"),
            Err(StoreError::UnknownItem { .. })
        ));
    }

    #[test]
    fn comments_come_back_in_prose_order() {
        let (_dir, store, item) = seeded();
        store.comment_create(&item, "third", 90, 95, "c").unwrap();
        store.comment_create(&item, "first", 4, 9, "a").unwrap();
        store.comment_create(&item, "second", 40, 45, "b").unwrap();

        let listed = store.comments(&item).unwrap();

        let bodies: Vec<&str> = listed.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(bodies, vec!["first", "second", "third"]);
    }

    #[test]
    fn a_document_cannot_hold_more_than_the_ceiling() {
        let (_dir, store, item) = seeded();
        for i in 0..MAX_COMMENTS_PER_DOCUMENT {
            store
                .comment_create(&item, "note", i * 4 + 1, i * 4 + 3, "q")
                .unwrap();
        }

        let refused = store.comment_create(&item, "one too many", 9000, 9002, "q");

        assert!(matches!(refused, Err(StoreError::TooManyComments { .. })));
        assert_eq!(
            store.comment_count(&item).unwrap(),
            MAX_COMMENTS_PER_DOCUMENT
        );
    }

    #[test]
    fn the_ceiling_is_per_document_not_per_project() {
        // A cap that counted the whole project would stop a writer annotating a
        // second scene because they annotated a first one.
        let (dir, store, item) = seeded();
        let other = store.item_create(None, "scene", "Another").unwrap();
        drop(dir);
        for i in 0..MAX_COMMENTS_PER_DOCUMENT {
            store
                .comment_create(&item, "note", i * 4 + 1, i * 4 + 3, "q")
                .unwrap();
        }

        assert!(store.comment_create(&other.id, "fine", 1, 3, "q").is_ok());
    }

    #[test]
    fn a_body_is_rewritten_and_the_anchor_is_not() {
        let (_dir, store, item) = seeded();
        let made = store
            .comment_create(&item, "first draft", 4, 11, "q")
            .unwrap();

        store.comment_set_body(made.id, "second draft").unwrap();

        let listed = store.comments(&item).unwrap();
        assert_eq!(listed[0].body, "second draft");
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (4, 11));
    }

    #[test]
    fn rewriting_an_unknown_comment_is_refused() {
        let (_dir, store, _item) = seeded();

        assert!(matches!(
            store.comment_set_body(4242, "hello"),
            Err(StoreError::UnknownComment { id: 4242 })
        ));
    }

    #[test]
    fn a_comment_resolves_and_reopens_keeping_everything_else() {
        let (_dir, store, item) = seeded();
        let made = store.comment_create(&item, "note", 4, 11, "q").unwrap();

        store.comment_set_resolved(made.id, true).unwrap();
        let resolved = store.comments(&item).unwrap();
        assert!(resolved[0].resolved);
        assert_eq!(resolved[0].body, "note");
        assert_eq!((resolved[0].anchor_from, resolved[0].anchor_to), (4, 11));

        store.comment_set_resolved(made.id, false).unwrap();
        let reopened = store.comments(&item).unwrap();
        assert!(!reopened[0].resolved);
        // The anchor survived BOTH directions. A resolve that froze the anchor
        // would bring the note back pointing where it never pointed.
        assert_eq!((reopened[0].anchor_from, reopened[0].anchor_to), (4, 11));
    }

    #[test]
    fn resolving_never_removes_the_row() {
        // The whole claim of "kept, never deleted", asserted rather than
        // believed: the count is what a delete would move.
        let (_dir, store, item) = seeded();
        let made = store.comment_create(&item, "note", 4, 11, "q").unwrap();

        store.comment_set_resolved(made.id, true).unwrap();

        assert_eq!(store.comment_count(&item).unwrap(), 1);
        assert_eq!(store.comments(&item).unwrap().len(), 1);
    }

    #[test]
    fn a_collapsed_anchor_reads_as_orphaned_and_keeps_its_text() {
        let (_dir, store, item) = seeded();
        let made = store
            .comment_create(&item, "was this needed?", 4, 11, "the moon")
            .unwrap();

        store
            .apply_comment_anchors(
                &item,
                &[CommentAnchor {
                    id: made.id,
                    from: 4,
                    to: 4,
                }],
            )
            .unwrap();

        let listed = store.comments(&item).unwrap();
        assert!(listed[0].orphaned);
        assert_eq!(listed[0].body, "was this needed?");
        // And what it was about, which is all an orphan has left.
        assert_eq!(listed[0].quote, "the moon");
    }

    #[test]
    fn an_anchor_belonging_to_another_document_is_refused_and_moves_nothing() {
        // The scoping by item_id already stopped the write. What was missing is
        // that it stopped it SILENTLY: the page is wrong about which document
        // it is flushing, and the flush must find that out. This test asserted
        // only the non-move, so it passed against the silent version too.
        let (_dir, store, item) = seeded();
        let other = store.item_create(None, "scene", "Another").unwrap();
        let mine = store.comment_create(&item, "mine", 4, 11, "q").unwrap();

        let err = store
            .apply_comment_anchors(
                &other.id,
                &[CommentAnchor {
                    id: mine.id,
                    from: 900,
                    to: 950,
                }],
            )
            .expect_err("an anchor for another document must be refused");
        assert!(
            matches!(err, StoreError::ForeignComment { id, .. } if id == mine.id),
            "expected ForeignComment, got {err:?}"
        );

        let listed = store.comments(&item).unwrap();
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (4, 11));
    }

    #[test]
    fn an_unknown_anchor_is_ignored_rather_than_failing_the_save() {
        // This runs inside the flush transaction, so an error here would roll
        // back the writer's prose because a note went missing.
        let (_dir, store, item) = seeded();

        let out = store.apply_comment_anchors(
            &item,
            &[CommentAnchor {
                id: 999_999,
                from: 1,
                to: 2,
            }],
        );

        assert!(out.is_ok());
    }

    #[test]
    fn a_flush_carrying_another_document_s_anchor_is_refused_whole() {
        // The consequence of refusing rather than discarding, asserted rather
        // than assumed: this runs inside the flush transaction, so the body
        // does not land either. That is the same answer the flush already gives
        // a revision conflict, and for the same reason -- a page that is wrong
        // about which document it is writing must not have HALF of what it sent
        // accepted.
        let (_dir, store, item) = seeded();
        let other = store.item_create(None, "scene", "Another").unwrap();
        let mine = store.comment_create(&item, "mine", 4, 11, "q").unwrap();
        let rev = store.load_doc(&other.id).unwrap().rev;
        let before = store.load_doc(&other.id).unwrap().body;

        let out = store.flush(&[FlushEntry {
            item_id: other.id.clone(),
            body: r#"{"type":"doc","content":[{"type":"paragraph"}]}"#.to_string(),
            base_rev: rev,
            comments: Some(vec![CommentAnchor {
                id: mine.id,
                from: 20,
                to: 27,
            }]),
        }]);

        assert!(out.is_err(), "the flush must be refused");
        assert_eq!(store.load_doc(&other.id).unwrap().body, before);
        let listed = store.comments(&item).unwrap();
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (4, 11));
    }

    #[test]
    fn a_flush_carries_the_new_positions_in_its_own_transaction() {
        let (_dir, store, item) = seeded();
        let made = store.comment_create(&item, "note", 4, 11, "q").unwrap();
        let rev = store.load_doc(&item).unwrap().rev;

        store
            .flush(&[FlushEntry {
                item_id: item.clone(),
                body: r#"{"type":"doc","content":[{"type":"paragraph"}]}"#.to_string(),
                base_rev: rev,
                comments: Some(vec![CommentAnchor {
                    id: made.id,
                    from: 20,
                    to: 27,
                }]),
            }])
            .unwrap();

        let listed = store.comments(&item).unwrap();
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (20, 27));
    }

    #[test]
    fn a_refused_flush_moves_no_anchor() {
        // The point of one transaction: a body that did not land must not leave
        // its notes pointing into a document that never existed.
        let (_dir, store, item) = seeded();
        let made = store.comment_create(&item, "note", 4, 11, "q").unwrap();

        let refused = store.flush(&[FlushEntry {
            item_id: item.clone(),
            body: "{}".to_string(),
            // Deliberately stale, so the UPDATE matches nothing.
            base_rev: 9999,
            comments: Some(vec![CommentAnchor {
                id: made.id,
                from: 20,
                to: 27,
            }]),
        }]);

        assert!(refused.is_err());
        let listed = store.comments(&item).unwrap();
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (4, 11));
    }

    #[test]
    fn comments_survive_a_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        let (item, made) = {
            let store = Store::open(&path).unwrap();
            let created = store.item_create(None, "scene", "A scene").unwrap();
            let made = store
                .comment_create(&created.id, "look again", 4, 11, "the moon")
                .unwrap();
            (created.id, made)
        };

        let store = Store::open(&path).unwrap();

        let listed = store.comments(&item).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, made.id);
        assert_eq!(listed[0].body, "look again");
        assert_eq!((listed[0].anchor_from, listed[0].anchor_to), (4, 11));
        assert_eq!(listed[0].quote, "the moon");
    }

    #[test]
    fn deleting_the_item_takes_its_comments_with_it() {
        // ON DELETE CASCADE, asserted rather than assumed: `foreign_keys` is a
        // per-connection pragma and a cascade that is not switched on is a
        // cascade that does nothing.
        let (_dir, store, item) = seeded();
        store.comment_create(&item, "note", 4, 11, "q").unwrap();

        store
            .conn
            .execute("DELETE FROM item WHERE id = ?1", [&item])
            .unwrap();

        assert_eq!(store.comment_count(&item).unwrap(), 0);
    }
}
