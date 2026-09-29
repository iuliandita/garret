//! Book-wide and item-linked tasks, grouped into named revision passes.

use super::{fold_for_sort, now_ms, trashed_ids, Result, Store, StoreError};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

pub const MAX_TASK_TEXT: usize = 4_000;
pub const MAX_PASS_NAME: usize = 120;
pub const MAX_PASS_PURPOSE: usize = 1_000;

pub const SCHEMA_V13: &str = "
CREATE TABLE revision_pass (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  purpose TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE revision_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  item_id TEXT REFERENCES item(id) ON DELETE SET NULL,
  target_caption TEXT,
  pass_id INTEGER REFERENCES revision_pass(id) ON DELETE SET NULL,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX revision_task_item ON revision_task(item_id);
CREATE INDEX revision_task_pass ON revision_task(pass_id);
CREATE TRIGGER revision_task_keep_caption BEFORE DELETE ON item
BEGIN
  UPDATE revision_task SET target_caption = OLD.title WHERE item_id = OLD.id;
END;
";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RevisionPass {
    pub id: i64,
    pub name: String,
    pub purpose: Option<String>,
    pub open_count: i64,
    pub done_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RevisionTask {
    pub id: i64,
    pub body: String,
    pub item_id: Option<String>,
    pub target_caption: Option<String>,
    pub target_title: Option<String>,
    pub binned: bool,
    pub pass_id: Option<i64>,
    pub done: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn required(value: &str, limit: usize, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(StoreError::InvalidPlanning(format!(
            "{label} cannot be empty"
        )));
    }
    if value.chars().count() > limit {
        return Err(StoreError::InvalidPlanning(format!(
            "{label} is longer than {limit} characters"
        )));
    }
    Ok(value.to_string())
}

fn optional(value: Option<&str>, limit: usize, label: &str) -> Result<Option<String>> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| required(v, limit, label))
        .transpose()
}

impl Store {
    pub fn revision_passes(&self) -> Result<Vec<RevisionPass>> {
        if self.user_version()? < 13 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.name, p.purpose, p.created_at, p.updated_at,
                    count(CASE WHEN t.done_at IS NULL THEN t.id END),
                    count(CASE WHEN t.done_at IS NOT NULL THEN t.id END)
               FROM revision_pass p LEFT JOIN revision_task t ON t.pass_id = p.id
              GROUP BY p.id ORDER BY p.created_at, p.id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RevisionPass {
                id: r.get(0)?,
                name: r.get(1)?,
                purpose: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                open_count: r.get(5)?,
                done_count: r.get(6)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn check_pass(&self, pass_id: Option<i64>) -> Result<()> {
        if let Some(id) = pass_id {
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM revision_pass WHERE id = ?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(StoreError::InvalidPlanning(format!(
                    "revision pass {id} no longer exists"
                )));
            }
        }
        Ok(())
    }

    fn check_item(&self, item_id: Option<&str>) -> Result<Option<String>> {
        let Some(id) = item_id else { return Ok(None) };
        let found: Option<(String, String)> = self
            .conn
            .query_row("SELECT type, title FROM item WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((kind, title)) = found else {
            return Err(StoreError::UnknownItem { item_id: id.into() });
        };
        if [
            super::TRASH_TYPE,
            super::BIBLE_TYPE,
            super::FRONT_MATTER_TYPE,
            super::BACK_MATTER_TYPE,
        ]
        .contains(&kind.as_str())
        {
            return Err(StoreError::InvalidPlanning(
                "tasks can link to writing items, not section headings".into(),
            ));
        }
        Ok(Some(title))
    }

    fn check_pass_name(&self, name_key: &str, except_id: Option<i64>) -> Result<()> {
        let existing: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM revision_pass WHERE name_key = ?1 AND id IS NOT ?2",
                params![name_key, except_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(StoreError::InvalidPlanning(
                "a revision pass already has that name".into(),
            ));
        }
        Ok(())
    }

    pub fn revision_pass_create(&self, name: &str, purpose: Option<&str>) -> Result<i64> {
        let name = required(name, MAX_PASS_NAME, "pass name")?;
        let purpose = optional(purpose, MAX_PASS_PURPOSE, "pass purpose")?;
        let key = fold_for_sort(&name);
        self.check_pass_name(&key, None)?;
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO revision_pass(name,name_key,purpose,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?4)",
            params![name, key, purpose, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn revision_pass_update(&self, id: i64, name: &str, purpose: Option<&str>) -> Result<()> {
        let name = required(name, MAX_PASS_NAME, "pass name")?;
        let purpose = optional(purpose, MAX_PASS_PURPOSE, "pass purpose")?;
        let key = fold_for_sort(&name);
        self.check_pass_name(&key, Some(id))?;
        let changed = self.conn.execute(
            "UPDATE revision_pass SET name=?1,name_key=?2,purpose=?3,updated_at=?4 WHERE id=?5",
            params![name, key, purpose, now_ms(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::InvalidPlanning(format!(
                "revision pass {id} no longer exists"
            )));
        }
        Ok(())
    }

    pub fn revision_pass_delete(&self, id: i64) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM revision_pass WHERE id=?1", [id])?;
        if changed == 0 {
            return Err(StoreError::InvalidPlanning(format!(
                "revision pass {id} no longer exists"
            )));
        }
        Ok(())
    }

    pub fn revision_tasks(&self) -> Result<Vec<RevisionTask>> {
        if self.user_version()? < 13 {
            return Ok(Vec::new());
        }
        let binned = trashed_ids(&self.items()?);
        let mut stmt = self.conn.prepare(
            "SELECT t.id,t.body,t.item_id,t.target_caption,i.title,t.pass_id,t.done_at,
                    t.created_at,t.updated_at
               FROM revision_task t LEFT JOIN item i ON i.id=t.item_id
              ORDER BY t.created_at,t.id",
        )?;
        let rows = stmt.query_map([], |r| {
            let item_id: Option<String> = r.get(2)?;
            Ok(RevisionTask {
                id: r.get(0)?,
                body: r.get(1)?,
                binned: item_id.as_ref().is_some_and(|id| binned.contains(id)),
                item_id,
                target_caption: r.get(3)?,
                target_title: r.get(4)?,
                pass_id: r.get(5)?,
                done: r.get::<_, Option<i64>>(6)?.is_some(),
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn revision_task_create(
        &self,
        body: &str,
        item_id: Option<&str>,
        pass_id: Option<i64>,
    ) -> Result<i64> {
        let body = required(body, MAX_TASK_TEXT, "task text")?;
        let caption = self.check_item(item_id)?;
        self.check_pass(pass_id)?;
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO revision_task(body,item_id,target_caption,pass_id,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?5)",
            params![body, item_id, caption, pass_id, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn revision_task_update(&self, id: i64, body: &str, pass_id: Option<i64>) -> Result<()> {
        let body = required(body, MAX_TASK_TEXT, "task text")?;
        self.check_pass(pass_id)?;
        let changed = self.conn.execute(
            "UPDATE revision_task SET body=?1,pass_id=?2,updated_at=?3 WHERE id=?4",
            params![body, pass_id, now_ms(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::InvalidPlanning(format!(
                "task {id} no longer exists"
            )));
        }
        Ok(())
    }

    pub fn revision_task_set_done(&self, id: i64, done: bool) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE revision_task SET done_at=?1,updated_at=?2 WHERE id=?3",
            params![done.then(now_ms), now_ms(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::InvalidPlanning(format!(
                "task {id} no longer exists"
            )));
        }
        Ok(())
    }

    pub fn revision_task_delete(&self, id: i64) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM revision_task WHERE id=?1", [id])?;
        if changed == 0 {
            return Err(StoreError::InvalidPlanning(format!(
                "task {id} no longer exists"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_keep_links_until_item_removal_and_pass_deletion_keeps_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let item = store.item_create(None, "chapter", "Original").unwrap().id;
        let pass = store
            .revision_pass_create("First pass", Some("Structure"))
            .unwrap();
        let task = store
            .revision_task_create("Fix opening", Some(&item), Some(pass))
            .unwrap();
        assert_eq!(store.revision_passes().unwrap()[0].open_count, 1);
        store.revision_task_set_done(task, true).unwrap();
        assert_eq!(store.revision_passes().unwrap()[0].done_count, 1);
        store.revision_pass_delete(pass).unwrap();
        let kept = &store.revision_tasks().unwrap()[0];
        assert_eq!(kept.pass_id, None);
        assert_eq!(kept.item_id.as_deref(), Some(item.as_str()));
        assert!(kept.done);
        store
            .conn
            .execute("DELETE FROM item WHERE id=?1", [&item])
            .unwrap();
        let detached = &store.revision_tasks().unwrap()[0];
        assert_eq!(detached.item_id, None);
        assert_eq!(detached.target_caption.as_deref(), Some("Original"));
    }

    #[test]
    fn invalid_planning_edits_leave_rows_unchanged_and_names_fold() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let pass = store.revision_pass_create(" Étape ", None).unwrap();
        assert!(store.revision_pass_create("etape", None).is_err());
        let task = store
            .revision_task_create("Keep", None, Some(pass))
            .unwrap();
        assert!(store.revision_task_update(task, " ", Some(pass)).is_err());
        assert!(store
            .revision_task_update(task, "Bad", Some(pass + 500))
            .is_err());
        assert_eq!(store.revision_tasks().unwrap()[0].body, "Keep");
        assert_eq!(store.revision_passes().unwrap()[0].name, "Étape");
    }

    #[test]
    fn binned_links_and_database_backup_keep_tasks_and_passes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let backup = dir.path().join("backup.db");
        let store = Store::open(&source).unwrap();
        let bin = store
            .item_create(None, super::super::TRASH_TYPE, "Bin")
            .unwrap()
            .id;
        let scene = store.item_create(None, "scene", "Old scene").unwrap();
        let pass = store
            .revision_pass_create("Structure", Some("Check arc"))
            .unwrap();
        let task = store
            .revision_task_create("Keep the ending", Some(&scene.id), Some(pass))
            .unwrap();
        store
            .item_move(&scene.id, Some(&bin), None, scene.rev)
            .unwrap();
        let live = store.revision_tasks().unwrap();
        assert_eq!(live[0].id, task);
        assert!(live[0].binned);
        assert_eq!(live[0].item_id.as_deref(), Some(scene.id.as_str()));
        store.vacuum_into(&backup).unwrap();
        let recovered = Store::open_readonly(&backup).unwrap();
        assert_eq!(recovered.revision_tasks().unwrap(), live);
        assert_eq!(
            recovered.revision_passes().unwrap(),
            store.revision_passes().unwrap()
        );
    }

    #[test]
    fn schema_upgrade_preserves_existing_item_state_and_body_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.db");
        {
            let store = super::super::historical_test_store(&path, 12);
            store
                .conn
                .execute_batch(
                    "INSERT INTO item (id, type, title, position, rev, state)
                     VALUES ('legacy-scene', 'scene', 'Scene', 'V', 1, 'revising');
                     INSERT INTO doc (item_id, body, rev, updated_at)
                     VALUES ('legacy-scene', '{\"type\":\"doc\",\"content\":[]}', 1, 1);",
                )
                .unwrap();
        }
        let before = Store::open_readonly(&path).unwrap();
        let body: String = before
            .conn
            .query_row("SELECT body FROM doc", [], |r| r.get(0))
            .unwrap();
        let state: String = before
            .conn
            .query_row("SELECT state FROM item WHERE type='scene'", [], |r| {
                r.get(0)
            })
            .unwrap();
        drop(before);
        let migrated = Store::open(&path).unwrap();
        assert_eq!(
            migrated.user_version().unwrap(),
            super::super::SCHEMA_VERSION
        );
        assert_eq!(
            migrated
                .conn
                .query_row("SELECT body FROM doc", [], |r| r.get::<_, String>(0))
                .unwrap(),
            body
        );
        assert_eq!(
            migrated
                .conn
                .query_row("SELECT state FROM item WHERE type='scene'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            state
        );
        assert!(migrated.revision_tasks().unwrap().is_empty());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn salvage_extracts_planning_text_without_moving_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        let out = dir.path().join("salvaged");
        let store = Store::open(&path).unwrap();
        let item = store.item_create(None, "scene", "Opening").unwrap();
        let pass = store
            .revision_pass_create("Éléments", Some("Check continuity"))
            .unwrap();
        let task_id = store
            .revision_task_create("Repair this turn", Some(&item.id), Some(pass))
            .unwrap();
        store.revision_task_set_done(task_id, true).unwrap();
        let stored_pass = store.revision_passes().unwrap().remove(0);
        let stored_task = store.revision_tasks().unwrap().remove(0);
        drop(store);
        let report = crate::salvage::salvage(&path, &out).unwrap();
        assert!(report.complete, "{:?}", report.losses);
        let recovered =
            std::fs::read_to_string(out.join(crate::salvage::REVISION_PLANNING_NAME)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&recovered).unwrap();
        assert_eq!(json["passes"][0]["name"], "Éléments");
        assert_eq!(json["passes"][0]["purpose"], "Check continuity");
        assert_eq!(json["tasks"][0]["body"], "Repair this turn");
        assert_eq!(json["tasks"][0]["target_title"], "Opening");
        assert_eq!(json["tasks"][0]["target_caption"], "Opening");
        assert_eq!(json["tasks"][0]["item_id"], item.id);
        assert_eq!(json["tasks"][0]["done"], true);
        assert!(json["tasks"][0]["done_at"].as_i64().is_some());
        assert_eq!(json["tasks"][0]["created_at"], stored_task.created_at);
        assert_eq!(json["tasks"][0]["updated_at"], stored_task.updated_at);
        assert_eq!(json["passes"][0]["created_at"], stored_pass.created_at);
        assert_eq!(json["passes"][0]["updated_at"], stored_pass.updated_at);
        assert!(path.exists());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn cli_counts_planning_and_reports_broken_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        let store = Store::open(&path).unwrap();
        let pass = store.revision_pass_create("Line pass", None).unwrap();
        let id = store
            .revision_task_create("Check voice", None, Some(pass))
            .unwrap();
        store.revision_task_set_done(id, true).unwrap();
        let inspection = crate::cli::inspect(&path).unwrap();
        assert_eq!(
            (
                inspection.revision_passes,
                inspection.revision_tasks_open,
                inspection.revision_tasks_done
            ),
            (1, 0, 1)
        );
        store.conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        store
            .conn
            .execute("UPDATE revision_task SET pass_id=999 WHERE id=?1", [id])
            .unwrap();
        let report = crate::cli::validate(&path).unwrap();
        assert!(report
            .findings
            .iter()
            .any(|f| f.kind == "invalid_revision_task"));
    }

    #[test]
    fn planning_order_uses_created_time_then_stable_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let a = store.revision_pass_create("A", None).unwrap();
        let b = store.revision_pass_create("B", None).unwrap();
        let c = store.revision_pass_create("C", None).unwrap();
        store
            .conn
            .execute("UPDATE revision_pass SET created_at=30 WHERE id=?1", [a])
            .unwrap();
        store
            .conn
            .execute(
                "UPDATE revision_pass SET created_at=10 WHERE id IN (?1,?2)",
                params![b, c],
            )
            .unwrap();
        let ordered: Vec<i64> = store
            .revision_passes()
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ordered, [b, c, a]);
        let x = store.revision_task_create("X", None, None).unwrap();
        let y = store.revision_task_create("Y", None, None).unwrap();
        let z = store.revision_task_create("Z", None, None).unwrap();
        store
            .conn
            .execute("UPDATE revision_task SET created_at=30 WHERE id=?1", [x])
            .unwrap();
        store
            .conn
            .execute(
                "UPDATE revision_task SET created_at=10 WHERE id IN (?1,?2)",
                params![y, z],
            )
            .unwrap();
        let ordered: Vec<i64> = store
            .revision_tasks()
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ordered, [y, z, x]);
    }
}
