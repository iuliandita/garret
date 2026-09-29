use super::{commit, now_ms, source_words, Result, Store, StoreError};
use rusqlite::{Connection, OptionalExtension};

pub const KEY: &str = "book_id";
const ORIGIN_KEY: &str = "book_identity_origin";
pub const TRANSFER_LINEAGE_KEY: &str = "transfer_lineage_book_id";
pub const TRANSFER_SOURCE_KEY: &str = "transfer_source_book_id";
pub const TRANSFER_SNAPSHOT_KEY: &str = "transfer_source_inventory_sha256";

fn valid(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn fresh() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

fn checked(conn: &Connection, required: bool) -> Result<Option<String>> {
    let id: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [KEY], |row| {
            row.get(0)
        })
        .optional()?;
    match id {
        Some(id) if valid(&id) => Ok(Some(id)),
        Some(_) => Err(StoreError::Corrupt("book identity is malformed".into())),
        None if required => Err(StoreError::Corrupt("book identity is missing".into())),
        None => Ok(None),
    }
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    if checked(conn, false)?.is_none() {
        let id = fresh();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            [KEY, id.as_str()],
        )?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, 'legacy')",
        [ORIGIN_KEY],
    )?;
    Ok(())
}

pub(crate) fn mark_created(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, 'new')",
        [ORIGIN_KEY],
    )?;
    Ok(())
}

impl Store {
    /// Reads never migrate: valid older projects have no identity yet.
    pub fn book_id(&self) -> Result<Option<String>> {
        checked(&self.conn, self.user_version()? >= 11)
    }

    pub fn may_adopt_legacy_protection(&self) -> Result<bool> {
        Ok(self.get_meta(ORIGIN_KEY)?.as_deref() == Some("legacy"))
    }

    pub fn fork_book_identity(&self, expected: &str) -> Result<String> {
        self.fork_book_identity_with(expected, false, None)
    }

    pub fn fork_recovered_book_identity(&self, expected: &str) -> Result<String> {
        self.fork_book_identity_with(expected, true, None)
    }

    pub fn fork_transferred_book_identity(
        &self,
        expected: &str,
        lineage: &str,
        snapshot: &str,
    ) -> Result<String> {
        if !valid(lineage)
            || snapshot.len() != 64
            || !snapshot
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(StoreError::Corrupt(
                "transfer provenance is malformed".into(),
            ));
        }
        self.fork_book_identity_with(expected, true, Some((lineage, snapshot)))
    }

    fn fork_book_identity_with(
        &self,
        expected: &str,
        recovered: bool,
        transfer: Option<(&str, &str)>,
    ) -> Result<String> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<String> {
            let current = checked(&self.conn, true)?.expect("required identity missing");
            if current != expected {
                return Err(StoreError::BookIdentityChanged);
            }
            let next = fresh();
            self.conn
                .execute("UPDATE meta SET value = ?1 WHERE key = ?2", [&next, KEY])?;
            self.conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, 'new') ON CONFLICT(key) DO UPDATE SET value = 'new'",
                [ORIGIN_KEY],
            )?;
            if recovered {
                let words = source_words::recovered_word_count(&self.conn)?;
                source_words::reset_with_restored(&self.conn, now_ms(), words)?;
            } else {
                source_words::reset(&self.conn, now_ms())?;
            }
            if let Some((lineage, snapshot)) = transfer {
                for (key, value) in [
                    (TRANSFER_LINEAGE_KEY, lineage),
                    (TRANSFER_SOURCE_KEY, expected),
                    (TRANSFER_SNAPSHOT_KEY, snapshot),
                ] {
                    self.conn.execute(
                        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        [key, value],
                    )?;
                }
            }
            Ok(next)
        })();
        match result {
            Ok(id) => {
                commit(&self.conn)?;
                Ok(id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{cast, FlushEntry, SCHEMA_V1, SCHEMA_V2, SCHEMA_V3};
    use tempfile::tempdir;

    const BODY: &str = "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"A lighthouse burns through rain.\"}]}]}";

    #[test]
    fn transfer_identity_and_provenance_commit_or_rollback_together() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let original = store.book_id().unwrap().unwrap();
        let snapshot = "a".repeat(64);
        store.conn.execute_batch("CREATE TRIGGER refuse_transfer BEFORE INSERT ON meta WHEN NEW.key = 'transfer_source_inventory_sha256' BEGIN SELECT RAISE(ABORT, 'no receipt'); END;").unwrap();
        assert!(store
            .fork_transferred_book_identity(&original, &original, &snapshot)
            .is_err());
        assert_eq!(store.book_id().unwrap().as_deref(), Some(original.as_str()));
        assert_eq!(store.get_meta(TRANSFER_LINEAGE_KEY).unwrap(), None);
        assert_eq!(store.get_meta(TRANSFER_SOURCE_KEY).unwrap(), None);
        store
            .conn
            .execute_batch("DROP TRIGGER refuse_transfer")
            .unwrap();
        let fork = store
            .fork_transferred_book_identity(&original, &original, &snapshot)
            .unwrap();
        assert_ne!(fork, original);
        assert_eq!(
            store.get_meta(TRANSFER_LINEAGE_KEY).unwrap().as_deref(),
            Some(original.as_str())
        );
        assert_eq!(
            store.get_meta(TRANSFER_SOURCE_KEY).unwrap().as_deref(),
            Some(original.as_str())
        );
        assert_eq!(
            store.get_meta(TRANSFER_SNAPSHOT_KEY).unwrap().as_deref(),
            Some(snapshot.as_str())
        );
    }

    fn v10(path: &std::path::Path) {
        Connection::open(path).unwrap().execute_batch(&format!(
            "BEGIN; {SCHEMA_V1} {SCHEMA_V2} {SCHEMA_V3} {} {} {} {} {} {} {} PRAGMA user_version = 10; COMMIT;",
            crate::store::comments::SCHEMA_V4, crate::store::dict::SCHEMA_V5,
            crate::store::synopsis::SCHEMA_V6, cast::SCHEMA_V7, cast::SCHEMA_V8,
            crate::store::appearances::SCHEMA_V9, cast::SCHEMA_V10,
        )).unwrap();
    }

    #[test]
    fn opening_a_selected_book_never_recreates_a_missing_or_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.db");
        assert!(Store::open_existing(&missing).is_err());
        assert!(!missing.exists());
        let empty = dir.path().join("empty.db");
        std::fs::write(&empty, b"").unwrap();
        assert!(Store::open_existing(&empty).is_err());
        assert_eq!(std::fs::metadata(&empty).unwrap().len(), 0);
        let real = dir.path().join("real.db");
        let id = Store::open(&real).unwrap().book_id().unwrap();
        assert_eq!(Store::open_existing(&real).unwrap().book_id().unwrap(), id);
    }

    #[test]
    fn new_books_keep_one_identity_and_different_books_get_different_ones() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.db");
        let second = dir.path().join("second.db");
        let id = Store::open(&first).unwrap().book_id().unwrap().unwrap();
        assert!(valid(&id));
        assert_eq!(
            Store::open(&first).unwrap().book_id().unwrap().as_deref(),
            Some(id.as_str())
        );
        assert_ne!(
            id,
            Store::open(&second).unwrap().book_id().unwrap().unwrap()
        );
        assert!(!Store::open(&first)
            .unwrap()
            .may_adopt_legacy_protection()
            .unwrap());
    }

    #[test]
    fn separate_identity_durably_drops_legacy_ownership_even_before_settings_are_written() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        v10(&path);
        let store = Store::open(&path).unwrap();
        assert!(store.may_adopt_legacy_protection().unwrap());
        let before = store.book_id().unwrap().unwrap();
        let fork = store.fork_book_identity(&before).unwrap();
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.book_id().unwrap().as_deref(), Some(fork.as_str()));
        assert!(!reopened.may_adopt_legacy_protection().unwrap());
    }

    #[test]
    fn fresh_creation_origin_survives_an_interrupted_migration() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("partial.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        mark_created(&conn).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        drop(conn);
        assert!(!Store::open(&path)
            .unwrap()
            .may_adopt_legacy_protection()
            .unwrap());
    }

    #[test]
    fn fork_changes_only_the_identity_and_refuses_a_stale_source() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        store.set_meta("name", "Harbour").unwrap();
        let item = store.item_create(None, "scene", "One").unwrap();
        let entry = FlushEntry {
            item_id: item.id.clone(),
            body: BODY.into(),
            base_rev: item.doc_rev.unwrap(),
            comments: None,
        };
        store.flush(&[entry.clone()]).unwrap();
        assert_eq!(store.record_versions(&[entry]).unwrap(), 1);
        store.snapshot_create("Before fork").unwrap();
        let before_rows = (
            store.items().unwrap()[0].id.clone(),
            store.load_doc(&item.id).unwrap().body,
            store.doc_versions(&item.id).unwrap().len(),
            store.snapshots().unwrap()[0].label.clone(),
        );
        let before = store.book_id().unwrap().unwrap();
        let after = store.fork_book_identity(&before).unwrap();
        assert_ne!(before, after);
        assert_eq!(store.get_meta("name").unwrap().as_deref(), Some("Harbour"));
        assert_eq!(
            (
                store.items().unwrap()[0].id.clone(),
                store.load_doc(&item.id).unwrap().body,
                store.doc_versions(&item.id).unwrap().len(),
                store.snapshots().unwrap()[0].label.clone(),
            ),
            before_rows,
        );
        assert!(matches!(
            store.fork_book_identity(&before),
            Err(StoreError::BookIdentityChanged)
        ));
        assert_eq!(store.book_id().unwrap().as_deref(), Some(after.as_str()));
    }

    #[test]
    fn readonly_old_books_remain_old_and_migration_keeps_prose_history_and_state() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("old.db");
        v10(&path);
        let raw = Store {
            conn: Connection::open(&path).unwrap(),
        };
        let item = raw.item_create(None, "scene", "One").unwrap();
        let entry = FlushEntry {
            item_id: item.id.clone(),
            body: BODY.into(),
            base_rev: item.doc_rev.unwrap(),
            comments: None,
        };
        raw.flush(&[entry.clone()]).unwrap();
        assert_eq!(raw.record_versions(&[entry]).unwrap(), 1);
        raw.snapshot_create("Before migration").unwrap();
        raw.item_set_state(&item.id, Some("revising"), item.rev)
            .unwrap();
        drop(raw);
        let readonly = Store::open_readonly(&path).unwrap();
        assert_eq!(readonly.book_id().unwrap(), None);
        assert_eq!(readonly.user_version().unwrap(), 10);
        drop(readonly);
        let migrated = Store::open(&path).unwrap();
        assert!(migrated.book_id().unwrap().is_some());
        assert_eq!(migrated.load_doc(&item.id).unwrap().body, BODY);
        assert_eq!(migrated.doc_versions(&item.id).unwrap().len(), 2);
        assert_eq!(migrated.snapshots().unwrap()[0].label, "Before migration");
        assert_eq!(
            migrated.items().unwrap()[0].state.as_deref(),
            Some("revising")
        );
    }

    #[test]
    fn malformed_v11_is_rejected_and_failed_migration_rolls_back() {
        let dir = tempdir().unwrap();
        let bad = dir.path().join("bad.db");
        let store = Store::open(&bad).unwrap();
        store.set_meta(KEY, "not-an-id").unwrap();
        drop(store);
        assert!(matches!(Store::open(&bad), Err(StoreError::Corrupt(_))));

        let missing = dir.path().join("missing.db");
        let store = Store::open(&missing).unwrap();
        store.delete_meta(KEY).unwrap();
        drop(store);
        assert!(matches!(Store::open(&missing), Err(StoreError::Corrupt(_))));

        let malformed = dir.path().join("malformed-v10.db");
        v10(&malformed);
        let conn = Connection::open(&malformed).unwrap();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            [KEY, "bad-id"],
        )
        .unwrap();
        drop(conn);
        assert!(matches!(
            Store::open(&malformed),
            Err(StoreError::Corrupt(_))
        ));
        let conn = Connection::open(&malformed).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            conn.query_row("SELECT value FROM meta WHERE key = ?1", [KEY], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "bad-id"
        );
        drop(conn);

        let path = dir.path().join("trigger.db");
        v10(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_identity BEFORE INSERT ON meta WHEN NEW.key = 'book_id' BEGIN SELECT RAISE(ABORT, 'no id'); END;").unwrap();
        drop(conn);
        assert!(Store::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM meta WHERE key = 'book_id'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
