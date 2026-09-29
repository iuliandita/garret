// app/shell-tauri/src-tauri/src/store/synopsis.rs
// What a part, a chapter or a scene is ABOUT, in the writer's own words, kept
// beside the item and outside the book.
//
// ITS OWN TABLE, and the two alternatives were both structurally worse.
//
// A SECOND `doc` ROW IS IMPOSSIBLE: `doc.item_id` IS the primary key. Relaxing
// it to `(item_id, slot)` would make every unfiltered `SELECT ... FROM doc` in
// this crate -- the word index, `replace_everywhere`, `snapshot_take`, the
// mirror's bodies, `validate`'s unreadable-body scan -- silently ingest
// synopsis text as though it were the manuscript, and `document_revs()` would
// need a slot key, which breaks the key space the mirror's skip is built on.
//
// A COLUMN ON `item` IS WORSE STILL. It would move under `item.rev`, and the
// mirror's incremental skip compares `item.rev` -- so every keystroke of a field
// the mirror does not render would rewrite that item's file. It would also
// collide with rename and with the revision state on one revision.
//
// AN ABSENT SYNOPSIS IS NO ROW, never a row holding "". Same rule as NULL
// meaning the `none` revision state, as `data-theme="system"` being removed
// rather than written, and as an absent word count rendering as nothing: a
// default written as a value is a default free to drift from the code's idea of
// the default. So `synopsis_set` with nothing in it DELETES, and "has this item
// a synopsis" has one spelling.
//
// IT IS NOT IN THE MIRROR, and that is a decision taken deliberately rather
// than deferred. The
// consequence for a reader here is that `rev` below has no consumer in this
// build; it is what a mirrored synopsis would compare, and it is DATA in the
// file rather than a branch nothing reaches.
use super::{commit, now_ms, Result, Store, StoreError};
use serde::Serialize;

/// v6 adds the synopsis. ADDITIVE ONLY -- one table, nothing in v1 through v5
/// changes shape, so a project carries its prose, its history, its revision
/// states, its comments and its wordlist forward untouched.
///
/// `item_id` is the PRIMARY KEY, not merely a foreign key with an index the way
/// `comment.item_id` is: an item has at most one synopsis, and saying so in the
/// key means "which one is current" is a question the file cannot be asked.
///
/// `ON DELETE CASCADE`, so a synopsis leaves with the item it describes. That is
/// the bin's behaviour too, and correctly: deleting into the bin is a MOVE, and
/// a move touches no row here.
///
/// NO CHECK CONSTRAINT on the body, for the reason SCHEMA_V3, SCHEMA_V4 and
/// SCHEMA_V5 all record: `synopsis_set` is the only writer, it decides before
/// any row moves, and SQLite cannot alter a CHECK -- so a constraint here would
/// make the next rule change a whole-table rebuild.
pub const SCHEMA_V6: &str = "
CREATE TABLE synopsis (
  item_id    TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// One item's synopsis, as the page reads it. snake_case by the recorded rule:
/// command ARGUMENTS are camelCase, returned struct fields are not.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct Synopsis {
    pub item_id: String,
    /// Plain text. A synopsis about prose is not prose: a second rich-text
    /// surface is a second schema, a second serializer and a second thing to
    /// migrate, which is the argument `comment.body` already makes.
    pub body: String,
    /// How many times this synopsis has been written, starting at 1.
    ///
    /// NOTHING IN THIS BUILD READS IT to make a decision, and that is recorded
    /// rather than hidden. It is the field a mirrored synopsis would compare --
    /// the design record names it `syn_rev` -- and the mirror is deliberately
    /// not given one in this slice. Carried out to the page so it is at least
    /// observable, and asserted by a test, rather than being a column only the
    /// schema knows about.
    pub rev: i64,
    pub updated_at: i64,
}

impl Store {
    /// One bounded read for the outline's visible page. Missing synopses are
    /// absent, and unknown item ids are refused rather than silently dropped.
    pub fn synopsis_batch(&self, ids: &[String]) -> Result<Vec<Synopsis>> {
        let mut rows = Vec::with_capacity(ids.len());
        for id in ids {
            if self.item_type(id)?.is_none() {
                return Err(StoreError::UnknownItem {
                    item_id: id.clone(),
                });
            }
            if let Some(synopsis) = self.synopsis(id)? {
                rows.push(synopsis);
            }
        }
        Ok(rows)
    }

    /// What this item is about, or None when nobody has said.
    pub fn synopsis(&self, item_id: &str) -> Result<Option<Synopsis>> {
        Ok(self
            .conn
            .query_row(
                "SELECT item_id, body, rev, updated_at FROM synopsis WHERE item_id = ?1",
                [item_id],
                |r| {
                    Ok(Synopsis {
                        item_id: r.get(0)?,
                        body: r.get(1)?,
                        rev: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                },
            )
            .ok())
    }

    /// Write what this item is about. Returns what the file now holds, or None
    /// when the synopsis was cleared.
    ///
    /// REFUSES AN UNKNOWN ITEM, by name rather than by letting the foreign key
    /// speak. `foreign_keys` is a per-connection pragma this crate sets on
    /// `open` and NOT on `open_readonly`, so leaning on it would make the
    /// refusal a property of which handle happened to be in hand. `UnknownItem`
    /// is the recorded meaning: nothing was written and reloading will not help.
    ///
    /// AN EMPTY BODY DELETES, trimmed first. See the module header: an absent
    /// synopsis is the absence of a row, so there is one spelling of it and the
    /// panel's Save on an emptied field is a real way back rather than a row
    /// holding nothing.
    ///
    /// NO `base_rev`, for the reason `comment_set_body` takes none: a synopsis
    /// is its own row with one writer, one window and one panel, so a revision
    /// discipline here would have nothing to guard. The `rev` it keeps is a
    /// record of change, not a lock.
    pub fn synopsis_set(&self, item_id: &str, body: &str) -> Result<Option<Synopsis>> {
        let body = body.trim();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<Option<Synopsis>> {
            let exists: bool = self
                .conn
                .query_row("SELECT 1 FROM item WHERE id = ?1", [item_id], |_| Ok(()))
                .is_ok();
            if !exists {
                return Err(StoreError::UnknownItem {
                    item_id: item_id.to_string(),
                });
            }
            if body.is_empty() {
                self.conn
                    .execute("DELETE FROM synopsis WHERE item_id = ?1", [item_id])?;
                return Ok(None);
            }
            let now = now_ms();
            // The rev is read from the row being replaced rather than computed
            // by the caller, so two saves in one second are two revisions even
            // though `updated_at` cannot tell them apart.
            let previous: Option<i64> = self
                .conn
                .query_row(
                    "SELECT rev FROM synopsis WHERE item_id = ?1",
                    [item_id],
                    |r| r.get(0),
                )
                .ok();
            let rev = previous.unwrap_or(0) + 1;
            self.conn.execute(
                "INSERT INTO synopsis (item_id, body, rev, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(item_id) DO UPDATE SET body = ?2, rev = ?3, updated_at = ?4",
                rusqlite::params![item_id, body, rev, now],
            )?;
            Ok(Some(Synopsis {
                item_id: item_id.to_string(),
                body: body.to_string(),
                rev,
                updated_at: now,
            }))
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

    /// Every item that carries one. The navigator's marker: one query at open
    /// and one after each save, instead of a row per item on the walk.
    pub fn synopsis_item_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT item_id FROM synopsis ORDER BY item_id")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// How many items in this file carry one. Reached by this module's tests
    /// only: `cli::inspect` never took the figure.
    #[cfg(test)]
    pub fn synopsis_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM synopsis", [], |r| r.get(0))?;
        Ok(n as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use tempfile::tempdir;

    fn seeded() -> (tempfile::TempDir, Store, String) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "chapter", "Chapter 1").unwrap();
        let id = created.id.clone();
        (dir, store, id)
    }

    #[test]
    fn an_item_with_nothing_written_about_it_has_no_synopsis() {
        let (_dir, store, item) = seeded();
        assert_eq!(store.synopsis(&item).unwrap(), None);
        assert_eq!(store.synopsis_count().unwrap(), 0);
    }

    #[test]
    fn a_synopsis_is_written_and_read_back() {
        let (_dir, store, item) = seeded();

        let saved = store
            .synopsis_set(&item, "She finds the letter and burns it.")
            .unwrap()
            .unwrap();

        assert_eq!(saved.item_id, item);
        assert_eq!(saved.body, "She finds the letter and burns it.");
        assert_eq!(saved.rev, 1);
        let read = store.synopsis(&item).unwrap().unwrap();
        assert_eq!(read, saved);
        assert_eq!(store.synopsis_count().unwrap(), 1);
    }

    #[test]
    fn the_ids_list_names_exactly_the_items_that_carry_one() {
        // The navigator paints a mark from this list, so an id it names must
        // hold a row and a cleared synopsis must leave it. Two items, so the
        // list is not "the one item" by construction.
        let (_dir, store, item) = seeded();
        let other = store.item_create(None, "scene", "Scene 1").unwrap().id;
        assert_eq!(store.synopsis_item_ids().unwrap(), Vec::<String>::new());

        store.synopsis_set(&other, "they meet").unwrap();
        assert_eq!(store.synopsis_item_ids().unwrap(), vec![other.clone()]);

        store.synopsis_set(&item, "the letter").unwrap();
        let mut both = vec![item.clone(), other.clone()];
        both.sort();
        assert_eq!(store.synopsis_item_ids().unwrap(), both);

        store.synopsis_set(&other, "   ").unwrap();
        assert_eq!(store.synopsis_item_ids().unwrap(), vec![item]);
    }

    #[test]
    fn a_second_save_replaces_the_body_and_moves_the_revision() {
        // ONE ROW PER ITEM is the primary key's claim, and a second row would
        // make "which one is current" a question. The rev moving is the only
        // observable difference between two saves inside one millisecond.
        let (_dir, store, item) = seeded();

        store.synopsis_set(&item, "first").unwrap();
        let second = store.synopsis_set(&item, "second").unwrap().unwrap();

        assert_eq!(second.body, "second");
        assert_eq!(second.rev, 2);
        assert_eq!(store.synopsis_count().unwrap(), 1);
        assert_eq!(store.synopsis(&item).unwrap().unwrap().body, "second");
    }

    #[test]
    fn an_emptied_synopsis_leaves_no_row_behind() {
        let (_dir, store, item) = seeded();
        store.synopsis_set(&item, "something").unwrap();

        assert_eq!(store.synopsis_set(&item, "   ").unwrap(), None);

        assert_eq!(store.synopsis(&item).unwrap(), None);
        assert_eq!(store.synopsis_count().unwrap(), 0);
    }

    #[test]
    fn a_padded_body_is_trimmed_and_a_cleared_one_starts_the_revision_over() {
        // The trim is what makes "   " the empty case at all, so it is asserted
        // on the stored body too rather than only through the delete above.
        let (_dir, store, item) = seeded();

        let saved = store.synopsis_set(&item, "  padded  ").unwrap().unwrap();
        assert_eq!(saved.body, "padded");

        store.synopsis_set(&item, "").unwrap();
        // The row is gone, so the next one is the first again. Recorded rather
        // than defended: nothing in this build reads the rev, and a rev that
        // survived a delete would need a row to survive in.
        assert_eq!(store.synopsis_set(&item, "again").unwrap().unwrap().rev, 1);
    }

    #[test]
    fn a_synopsis_for_an_item_that_is_not_there_is_refused_by_name() {
        // BY NAME, not by the foreign key: `foreign_keys` is a per-connection
        // pragma `open_readonly` does not set, so a refusal that leaned on it
        // would depend on which handle was in hand.
        let (_dir, store, _item) = seeded();

        assert!(matches!(
            store.synopsis_set("no-such-item", "about nothing"),
            Err(StoreError::UnknownItem { .. })
        ));
        assert_eq!(store.synopsis_count().unwrap(), 0);
    }

    #[test]
    fn a_batch_reads_requested_rows_in_order_and_refuses_unknown_ids() {
        let (_dir, store, first) = seeded();
        let second = store.item_create(None, "scene", "Second").unwrap().id;
        let absent = store.item_create(None, "scene", "Absent").unwrap().id;
        store.synopsis_set(&first, "first body").unwrap();
        store.synopsis_set(&second, "second body").unwrap();
        let rows = store
            .synopsis_batch(&[second.clone(), absent, first.clone()])
            .unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row.item_id.as_str())
                .collect::<Vec<_>>(),
            vec![second.as_str(), first.as_str()]
        );
        assert!(matches!(
            store.synopsis_batch(&[first, "missing".into()]),
            Err(StoreError::UnknownItem { .. })
        ));
    }

    #[test]
    fn a_refused_write_leaves_an_existing_synopsis_alone() {
        // The refusal above is inside the transaction, so this is the assertion
        // that the rollback is real rather than decorative.
        let (_dir, store, item) = seeded();
        store.synopsis_set(&item, "kept").unwrap();

        assert!(store.synopsis_set("no-such-item", "lost").is_err());

        assert_eq!(store.synopsis(&item).unwrap().unwrap().body, "kept");
        assert_eq!(store.synopsis_count().unwrap(), 1);
    }

    #[test]
    fn deleting_the_item_takes_its_synopsis_with_it() {
        // The cascade. Not reachable through the application -- a delete is a
        // move into the bin -- but the file is the writer's and this is what it
        // does when a row goes.
        let (_dir, store, item) = seeded();
        store.synopsis_set(&item, "about a chapter").unwrap();

        store
            .conn
            .execute("DELETE FROM item WHERE id = ?1", [&item])
            .unwrap();

        assert_eq!(store.synopsis_count().unwrap(), 0);
    }

    #[test]
    fn each_item_reads_back_its_OWN_synopsis() {
        // The fixture no other test here has: TWO items carrying DIFFERENT
        // bodies. A read that ignored the id and returned the first row passes
        // every other test in this file, because none of them holds two.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let first = store.item_create(None, "chapter", "Chapter 1").unwrap();
        let second = store.item_create(None, "chapter", "Chapter 2").unwrap();
        store.synopsis_set(&first.id, "about the first").unwrap();
        store.synopsis_set(&second.id, "about the second").unwrap();

        assert_eq!(
            store.synopsis(&first.id).unwrap().unwrap().body,
            "about the first"
        );
        assert_eq!(
            store.synopsis(&second.id).unwrap().unwrap().body,
            "about the second"
        );
        // And an item with none reads as none while two rows exist, which is
        // the other half of the same claim.
        let third = store.item_create(None, "chapter", "Chapter 3").unwrap();
        assert_eq!(store.synopsis(&third.id).unwrap(), None);
    }

    #[test]
    fn every_kind_of_item_can_carry_one() {
        // The design names all three, and nothing here is type-aware: the
        // hierarchy is arbitrary by product decision and `item.type` is a free
        // string. A container with no `doc` row carries a synopsis exactly as a
        // scene does, which is the whole point of not making it a `doc` row.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        for kind in ["part", "chapter", "scene", "note"] {
            let made = store.item_create(None, kind, kind).unwrap();
            store.synopsis_set(&made.id, "about it").unwrap();
            assert_eq!(store.synopsis(&made.id).unwrap().unwrap().body, "about it");
        }
        assert_eq!(store.synopsis_count().unwrap(), 4);
    }
}
