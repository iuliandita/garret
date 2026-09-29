// app/shell-tauri/src-tauri/src/store/appearances.rs
// Who appears where: which cast members a part, a chapter or a scene is tagged
// with.
//
// A JOIN TABLE, AND THE ROLLUP IS NOT IN THIS FILE. The design
// settles the split and it
// is `outline-counts.ts`'s, already stated in this tree: "The host owns the
// index because it owns the store; the page owns the TREE. The host answers
// 'how many words is this document', the page answers 'and what is it inside'."
// So the host answers "who is tagged on this item" and nothing else. Rolling a
// chapter's scenes up into the chapter would mean re-deriving parent chains
// here, which is a second implementation of a walk the page already holds --
// and it would have to decide, in Rust, whether the bin and the bible are part
// of the book, which is a PRODUCT question the page's two filters already
// answer in two different ways for two different surfaces.
//
// NOTHING IS STORED PER CONTAINER, and that is the point rather than a saving.
// A cached chapter list would need invalidating on `item_move`, on create, on
// delete, on restore and on 033's adoption -- five paths, where
// `decisions/2026-08-19-derived-state-and-the-panic-path.md` records a defect
// that survived a fix applied to two paths out of three.
//
// BINNING WRITES NOTHING HERE. A delete in this application is an `item_move`
// into a root item, so the rows stay, the ids stay stable, and a restore brings
// a scene's cast back with it. What a binned scene leaves is the page's WALK,
// which is read fresh -- exactly as its words leave the word count. The cascade
// below is therefore about the FILE, not about the bin: it fires when a row
// genuinely goes, which nothing in the shipped application does to an item.
use super::{commit, Result, Store, StoreError};
use std::collections::{BTreeMap, BTreeSet};

/// v9 adds the appearances. ADDITIVE ONLY -- one table, and nothing in v1
/// through v8 changes shape, so a project carries its prose, its history, its
/// revision states, its comments, its wordlist, its synopses, its whole cast
/// AND its pictures forward untouched.
///
/// A COMPOUND PRIMARY KEY AND NO SURROGATE ID. The row IS the pair, so "is this
/// character in this scene" is a question the file cannot be asked twice, and
/// tagging somebody who is already tagged is not a second row to reconcile.
/// That is `cast_field`'s `(member_id, ordinal)` argument on a set rather than
/// on a list.
///
/// NO `ordinal` AND NO `position`. A cast list is not an outline a writer
/// arranges -- 037's argument for the members themselves, and stronger here:
/// this is a SET, and the order a writer ticked two names in is not a fact
/// about their book. The page presents them in the cast's own order.
///
/// NO `rev` AND NO `updated_at`. `cast_member` has neither for the reason
/// recorded there -- a synopsis has a consumer waiting for a revision (the
/// mirror) and nothing will ever compare one of these. A column nobody reads is
/// a number pretending otherwise.
///
/// BOTH FOREIGN KEYS CASCADE for physical row deletion. Normal cast removal
/// retains tags and hides them until restoration. `foreign_keys` is a per-connection pragma this
/// crate sets on `open` and NOT on `open_readonly`, so the cascade is a
/// property of the handle as much as of the schema -- which is why it is PINNED
/// BY A TEST from both sides rather than assumed, exactly as `cast_field`'s is.
pub const SCHEMA_V9: &str = "
CREATE TABLE appearance (
  item_id        TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  cast_member_id TEXT NOT NULL REFERENCES cast_member(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, cast_member_id)
);
CREATE INDEX appearance_by_member ON appearance(cast_member_id);
";

impl Store {
    /// Every tag in the project, grouped by item.
    ///
    /// THE WHOLE PROJECT IN ONE GO, which is `cast_list`'s own rule -- "TWO
    /// QUERIES AND NOT ONE PER MEMBER" -- with one query instead of two. The
    /// page rolls a chapter's scenes up into the chapter, so it needs every row
    /// at once and a per-item command would be one round trip per row of a
    /// 20,060-row walk.
    ///
    /// AN ITEM WITH NO TAGS IS SIMPLY ABSENT, never a key holding an empty
    /// list. That is `synopsis`'s rule -- an absent synopsis is no row, never a
    /// row holding "" -- and it keeps this answer proportional to what the
    /// writer has actually said rather than to the size of their manuscript.
    ///
    /// SORTED, at both levels, by the `BTreeMap` and `BTreeSet` this collects
    /// into: two reads of an unchanged file give the same answer, which is what
    /// lets a test compare one.
    pub fn appearances(&self) -> Result<BTreeMap<String, Vec<String>>> {
        let sql = if self.user_version()? >= 14 {
            "SELECT a.item_id, a.cast_member_id FROM appearance a JOIN cast_member c ON c.id = a.cast_member_id WHERE c.deleted_at IS NULL"
        } else {
            "SELECT item_id, cast_member_id FROM appearance"
        };
        let mut stmt = self
            .conn
            .prepare(sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut grouped: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for row in rows {
            let (item_id, member_id) = row?;
            grouped.entry(item_id).or_default().insert(member_id);
        }
        Ok(grouped
            .into_iter()
            .map(|(item, members)| (item, members.into_iter().collect()))
            .collect())
    }

    /// Replace everything this item is tagged with.
    ///
    /// THE WHOLE RECORD IN ONE ACT, which is `cast_set`'s shape: the panel is a
    /// form and Save is one press, so a tag-and-untag pair of commands would
    /// make one press N transactions with N chances to half-apply. Sending a
    /// SHORTER list is how a tag is removed, and sending an empty one is how the
    /// last is -- there is no delete command for the same reason `cast_set` has
    /// none for a field.
    ///
    /// EVERY REFUSAL IS DECIDED BEFORE ANY ROW MOVES, and BY NAME rather than by
    /// letting the foreign key speak. `foreign_keys` is a per-connection pragma
    /// `open_readonly` does not set, so a refusal that leaned on it would be a
    /// property of which handle happened to be in hand -- `synopsis_set`'s
    /// recorded reason. An unknown item is `UnknownItem` and an unknown cast
    /// member is `UnknownCastMember`, which are the two the page can act on
    /// differently: the first means the row is gone and the panel must close,
    /// the second means the cast list it painted is stale.
    ///
    /// DUPLICATES IN THE ARGUMENT ARE NOT AN ERROR. The page sends the ticked
    /// boxes and cannot tick one twice, so a duplicate is a caller this store
    /// has no opinion about; the primary key already says the pair is a set, and
    /// refusing would be a rule with no failure to prevent. It returns what the
    /// file now holds, sorted, so the caller never has to guess.
    ///
    /// NO `base_rev`, for the reason `comment_set_body`, `synopsis_set` and
    /// `cast_set` all take none: one row-set, one writer, one window, one panel.
    pub fn appearances_set(&self, item_id: &str, member_ids: &[String]) -> Result<Vec<String>> {
        let wanted: BTreeSet<&str> = member_ids.iter().map(|s| s.as_str()).collect();

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<Vec<String>> {
            let item_exists: bool = self
                .conn
                .query_row("SELECT 1 FROM item WHERE id = ?1", [item_id], |_| Ok(()))
                .is_ok();
            if !item_exists {
                return Err(StoreError::UnknownItem {
                    item_id: item_id.to_string(),
                });
            }
            // EVERY MEMBER CHECKED BEFORE THE DELETE, not as each insert is
            // attempted. A loop that wrote as it went would leave the rollback
            // to undo a half-written record, which works -- and it would also
            // mean the refusal a writer sees depends on which name the set
            // happened to reach first.
            for member in &wanted {
                let known: bool = self
                    .conn
                    .query_row("SELECT 1 FROM cast_member WHERE id = ?1 AND deleted_at IS NULL", [member], |_| {
                        Ok(())
                    })
                    .is_ok();
                if !known {
                    return Err(StoreError::UnknownCastMember {
                        id: (*member).to_string(),
                    });
                }
            }
            // Replace only the active set the page can see. A removed member's
            // association stays in the file so restoring that member restores
            // the tag, even if this item's other tags were edited meanwhile.
            self.conn.execute(
                "DELETE FROM appearance WHERE item_id = ?1 AND cast_member_id IN
                   (SELECT id FROM cast_member WHERE deleted_at IS NULL)",
                [item_id],
            )?;
            for member in &wanted {
                self.conn.execute(
                    "INSERT INTO appearance (item_id, cast_member_id) VALUES (?1, ?2)",
                    rusqlite::params![item_id, member],
                )?;
            }
            Ok(wanted.iter().map(|m| (*m).to_string()).collect())
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

    /// How many tags this file holds. `cli::inspect`'s figure.
    ///
    /// ONE FIGURE AND NOT TWO, unlike the cast's `cast_members` and
    /// `cast_fields`: this is one table, and "how many items carry a tag" is
    /// derivable from a file somebody is already holding open.
    pub fn appearance_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM appearance", [], |r| r.get(0))?;
        Ok(n as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::cast::{KIND_CHARACTER, KIND_PLACE};
    use crate::store::Store;
    use tempfile::tempdir;

    struct Seeded {
        _dir: tempfile::TempDir,
        store: Store,
        scene: String,
        ada: String,
        harbour: String,
    }

    fn seeded() -> Seeded {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let scene = store.item_create(None, "scene", "Scene 1").unwrap().id;
        let ada = store.cast_create(KIND_CHARACTER, "Ada").unwrap().id;
        let harbour = store.cast_create(KIND_PLACE, "The harbour").unwrap().id;
        Seeded {
            _dir: dir,
            store,
            scene,
            ada,
            harbour,
        }
    }

    #[test]
    fn a_project_nobody_has_tagged_holds_no_appearances() {
        let s = seeded();
        assert!(s.store.appearances().unwrap().is_empty());
        assert_eq!(s.store.appearance_count().unwrap(), 0);
    }

    #[test]
    fn a_tag_is_written_and_read_back_under_its_item() {
        let s = seeded();

        let stored = s
            .store
            .appearances_set(&s.scene, &[s.ada.clone(), s.harbour.clone()])
            .unwrap();

        assert_eq!(
            stored,
            vec![min(&s.ada, &s.harbour), max(&s.ada, &s.harbour)]
        );
        let all = s.store.appearances().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(
            all.get(&s.scene).unwrap(),
            &vec![min(&s.ada, &s.harbour), max(&s.ada, &s.harbour)]
        );
        assert_eq!(s.store.appearance_count().unwrap(), 2);
    }

    /// The two ids are uuids, so which sorts first is not knowable from the
    /// fixture. Asserting the SORTED pair rather than the order they were sent
    /// in is what makes the determinism claim testable at all.
    fn min<'a>(a: &'a str, b: &'a str) -> String {
        if a < b {
            a.to_string()
        } else {
            b.to_string()
        }
    }
    fn max<'a>(a: &'a str, b: &'a str) -> String {
        if a < b {
            b.to_string()
        } else {
            a.to_string()
        }
    }

    #[test]
    fn a_second_save_REPLACES_the_whole_record() {
        // A shorter list is how a tag is removed and there is no delete command,
        // which is `cast_set`'s rule. A merge would make untagging impossible.
        let s = seeded();
        s.store
            .appearances_set(&s.scene, &[s.ada.clone(), s.harbour.clone()])
            .unwrap();

        let stored = s
            .store
            .appearances_set(&s.scene, &[s.harbour.clone()])
            .unwrap();

        assert_eq!(stored, vec![s.harbour.clone()]);
        assert_eq!(
            s.store.appearances().unwrap().get(&s.scene).unwrap(),
            &vec![s.harbour.clone()]
        );
        assert_eq!(s.store.appearance_count().unwrap(), 1);
    }

    #[test]
    fn an_empty_list_leaves_no_row_behind() {
        // The last tag comes off the same way the others did. An item with
        // nothing on it is ABSENT from the map, never a key holding an empty
        // list -- `synopsis`'s rule, so "is anybody in this scene" has one
        // spelling.
        let s = seeded();
        s.store.appearances_set(&s.scene, &[s.ada.clone()]).unwrap();

        assert_eq!(
            s.store.appearances_set(&s.scene, &[]).unwrap(),
            Vec::<String>::new()
        );

        assert!(s.store.appearances().unwrap().is_empty());
        assert_eq!(s.store.appearance_count().unwrap(), 0);
    }

    #[test]
    fn a_duplicate_in_the_argument_is_one_row_and_not_an_error() {
        // The primary key already says the pair is a set. Refusing would be a
        // rule with no failure to prevent, and the page cannot tick a box twice.
        let s = seeded();

        let stored = s
            .store
            .appearances_set(&s.scene, &[s.ada.clone(), s.ada.clone()])
            .unwrap();

        assert_eq!(stored, vec![s.ada.clone()]);
        assert_eq!(s.store.appearance_count().unwrap(), 1);
    }

    #[test]
    fn every_kind_of_item_can_be_tagged_and_each_reads_back_its_OWN_cast() {
        // The fixture no other test here has: FOUR items carrying DIFFERENT
        // sets. A read that ignored the item id and returned every row under
        // the first key passes every other test in this file.
        //
        // NOTHING HERE IS TYPE-AWARE, deliberately. The hierarchy is arbitrary
        // by product decision and `item.type` is a free string, so a part and a
        // chapter carry a tag exactly as a scene does -- which is what lets a
        // writer say who is in a chapter before they have written its scenes.
        let s = seeded();
        let mut made = Vec::new();
        for kind in ["part", "chapter", "scene", "note"] {
            made.push(s.store.item_create(None, kind, kind).unwrap().id);
        }
        s.store.appearances_set(&made[0], &[s.ada.clone()]).unwrap();
        s.store
            .appearances_set(&made[1], &[s.harbour.clone()])
            .unwrap();
        s.store
            .appearances_set(&made[2], &[s.ada.clone(), s.harbour.clone()])
            .unwrap();

        let all = s.store.appearances().unwrap();
        assert_eq!(all.get(&made[0]).unwrap(), &vec![s.ada.clone()]);
        assert_eq!(all.get(&made[1]).unwrap(), &vec![s.harbour.clone()]);
        assert_eq!(all.get(&made[2]).unwrap().len(), 2);
        // And the one nobody tagged is absent while three keys exist, which is
        // the other half of the same claim.
        assert!(!all.contains_key(&made[3]));
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn a_tag_on_an_item_that_is_not_there_is_refused_by_name() {
        // BY NAME, not by the foreign key: `foreign_keys` is a per-connection
        // pragma `open_readonly` does not set, so a refusal that leaned on it
        // would depend on which handle was in hand.
        let s = seeded();

        assert!(matches!(
            s.store.appearances_set("no-such-item", &[s.ada.clone()]),
            Err(StoreError::UnknownItem { .. })
        ));
        assert_eq!(s.store.appearance_count().unwrap(), 0);
    }

    #[test]
    fn a_tag_naming_a_cast_member_that_is_not_there_is_refused_by_name() {
        let s = seeded();

        assert!(matches!(
            s.store
                .appearances_set(&s.scene, &[s.ada.clone(), "no-such-member".to_string()]),
            Err(StoreError::UnknownCastMember { .. })
        ));
        assert_eq!(s.store.appearance_count().unwrap(), 0);
    }

    #[test]
    fn a_refused_write_leaves_the_previous_record_whole() {
        // The refusals above happen INSIDE the transaction and AFTER the item
        // check but BEFORE the delete, so this is the assertion that the
        // rollback is real rather than decorative -- and that a bad name in the
        // middle of a list does not take the good ones with it.
        let s = seeded();
        s.store
            .appearances_set(&s.scene, &[s.ada.clone(), s.harbour.clone()])
            .unwrap();

        assert!(s
            .store
            .appearances_set(&s.scene, &["no-such-member".to_string()])
            .is_err());

        assert_eq!(s.store.appearance_count().unwrap(), 2);
        assert_eq!(
            s.store.appearances().unwrap().get(&s.scene).unwrap().len(),
            2
        );
    }

    #[test]
    fn deleting_the_ITEM_takes_its_tags_with_it() {
        // THE CASCADE, PINNED RATHER THAN ASSUMED. `foreign_keys` is a
        // per-connection pragma, so this is a property of the handle in hand as
        // much as of the schema -- and `open_readonly` does not set it.
        //
        // Not reachable through the application: a delete is a MOVE into the
        // bin and the rows stay. This is what the FILE does when a row goes.
        let s = seeded();
        s.store
            .appearances_set(&s.scene, &[s.ada.clone(), s.harbour.clone()])
            .unwrap();
        let other = s.store.item_create(None, "scene", "Scene 2").unwrap().id;
        s.store.appearances_set(&other, &[s.ada.clone()]).unwrap();

        s.store
            .conn
            .execute("DELETE FROM item WHERE id = ?1", [&s.scene])
            .unwrap();

        assert_eq!(s.store.appearance_count().unwrap(), 1);
        // The OTHER item's tag survived, which is what stops a cascade that
        // emptied the table from passing.
        assert_eq!(
            s.store.appearances().unwrap().get(&other).unwrap(),
            &vec![s.ada.clone()]
        );
    }

    #[test]
    fn removing_a_CAST_MEMBER_hides_tags_until_restore() {
        let s = seeded();
        s.store
            .appearances_set(&s.scene, &[s.ada.clone(), s.harbour.clone()])
            .unwrap();
        let other = s.store.item_create(None, "scene", "Scene 2").unwrap().id;
        s.store.appearances_set(&other, &[s.ada.clone()]).unwrap();

        s.store.cast_remove(&s.ada).unwrap();

        assert_eq!(s.store.appearance_count().unwrap(), 3);
        let all = s.store.appearances().unwrap();
        // The place is still in the scene it was in, and the second scene --
        // whose only tag was the deleted member -- has left the map entirely.
        assert_eq!(all.get(&s.scene).unwrap(), &vec![s.harbour.clone()]);
        assert!(!all.contains_key(&other));
        assert!(matches!(s.store.appearances_set(&other, &[s.ada.clone()]), Err(StoreError::UnknownCastMember { .. })));
        s.store.cast_restore(&s.ada).unwrap();
        assert_eq!(s.store.appearances().unwrap().get(&other), Some(&vec![s.ada.clone()]));
    }

    #[test]
    fn editing_visible_tags_preserves_removed_member_association() {
        let s = seeded();
        let letter = s.store.cast_create(crate::store::cast::KIND_POI, "Letter").unwrap();
        s.store.appearances_set(&s.scene, &[s.ada.clone(), s.harbour.clone()]).unwrap();
        s.store.cast_remove(&s.ada).unwrap();

        // The page sees only Harbour and replaces it with Letter. Ada is
        // hidden, so the writer cannot remove her by editing these checkboxes.
        assert_eq!(s.store.appearances().unwrap().get(&s.scene), Some(&vec![s.harbour.clone()]));
        assert_eq!(s.store.appearances_set(&s.scene, &[letter.id.clone()]).unwrap(), vec![letter.id.clone()]);
        assert_eq!(s.store.appearance_count().unwrap(), 2);
        assert_eq!(s.store.appearances().unwrap().get(&s.scene), Some(&vec![letter.id.clone()]));

        s.store.cast_restore(&s.ada).unwrap();
        let visible = s.store.appearances().unwrap();
        let actual = visible.get(&s.scene).unwrap();
        assert_eq!(actual.len(), 2);
        assert!(actual.contains(&s.ada));
        assert!(actual.contains(&letter.id));
        assert!(!actual.contains(&s.harbour));
    }

    #[test]
    fn a_binned_scene_keeps_its_tags() {
        // THE DECISION, WRITTEN AS A TEST. Deleting in this application is an
        // `item_move` into a root item, so nothing here fires -- and a restore
        // brings the scene's cast back with it. What a binned scene leaves is
        // the PAGE's walk, which is read fresh; the same way its words leave the
        // word count.
        let s = seeded();
        s.store.appearances_set(&s.scene, &[s.ada.clone()]).unwrap();
        let bin = s.store.item_create(None, "trash", "Trash").unwrap();

        let moved = s.store.items().unwrap();
        let rev = moved.iter().find(|i| i.id == s.scene).unwrap().rev;
        s.store
            .item_move(&s.scene, Some(&bin.id), None, rev)
            .unwrap();

        assert_eq!(s.store.appearance_count().unwrap(), 1);
        assert_eq!(
            s.store.appearances().unwrap().get(&s.scene).unwrap(),
            &vec![s.ada.clone()]
        );
    }
}
