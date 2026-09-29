use super::{now_ms, source_words, Result, Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SCHEMA_V15: &str = "
CREATE TABLE analytics_session (
  id TEXT PRIMARY KEY,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  start_day TEXT NOT NULL,
  start_offset_min INTEGER NOT NULL,
  metric_version INTEGER NOT NULL,
  gap INTEGER NOT NULL DEFAULT 0,
  last_observed_ms INTEGER
);
CREATE TABLE analytics_segment (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES analytics_session(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  gap INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX analytics_segment_session ON analytics_segment(session_id, started_ms);
CREATE TABLE analytics_minute (
  session_id TEXT NOT NULL REFERENCES analytics_session(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES analytics_segment(id) ON DELETE CASCADE,
  utc_minute INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  offset_min INTEGER NOT NULL,
  PRIMARY KEY(session_id, utc_minute)
);
CREATE INDEX analytics_minute_segment ON analytics_minute(segment_id, utc_minute);
CREATE TABLE analytics_movement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id TEXT NOT NULL REFERENCES analytics_segment(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  utc_ms INTEGER NOT NULL,
  utc_minute INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  offset_min INTEGER NOT NULL,
  source TEXT NOT NULL,
  added INTEGER NOT NULL,
  deleted INTEGER NOT NULL
);
CREATE INDEX analytics_movement_segment ON analytics_movement(segment_id, utc_minute);
CREATE TABLE analytics_adjustment (
  segment_id TEXT PRIMARY KEY REFERENCES analytics_segment(id) ON DELETE CASCADE,
  category_id TEXT,
  category_name TEXT,
  minutes INTEGER,
  source_totals TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  changed_ms INTEGER NOT NULL
);
CREATE TABLE analytics_category (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0
);
";

pub const METRIC_VERSION: i64 = 1;
const CONSENT_KEY: &str = "analytics_recording_enabled";
const CATEGORY_KEY: &str = "analytics_selected_category";
const MOTIVATION_KEY: &str = "analytics_motivation_since";
const MOTIVATION_VISIBLE_KEY: &str = "analytics_motivation_visible";
const FORECAST_GOAL_KEY: &str = "analytics_forecast_goal_words";
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_MINUTES: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Category {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Runtime {
    pub session_id: String,
    pub segment_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stamp {
    pub utc_ms: i64,
    pub utc_minute: i64,
    pub offset_min: i64,
    pub local_day: [u8; 10],
}

impl Stamp {
    pub fn day(&self) -> &str {
        std::str::from_utf8(&self.local_day).expect("validated host day")
    }
}

fn bad(reason: &str) -> StoreError {
    StoreError::InvalidPlanning(reason.into())
}

pub fn category_checked(category: &Category) -> Result<()> {
    let built_in = matches!(
        category.id.as_str(),
        "drafting" | "revision" | "planning" | "review"
    );
    if !built_in && !valid_id(&category.id) {
        return Err(bad("analytics category ID is invalid"));
    }
    let name = category.name.trim();
    if (!built_in && name.is_empty())
        || name.chars().count() > 80
        || name.chars().any(char::is_control)
    {
        return Err(bad(
            "analytics category name must contain 1–80 printable characters",
        ));
    }
    if built_in
        && !matches!(category.name.as_str(), "")
        && category.name != built_in_name(&category.id).unwrap()
    {
        return Err(bad("a built-in analytics category cannot be renamed"));
    }
    Ok(())
}

fn built_in_name(id: &str) -> Option<&'static str> {
    match id {
        "drafting" => Some("Drafting"),
        "revision" => Some("Revision"),
        "planning" => Some("Planning"),
        "review" => Some("Review"),
        _ => None,
    }
}

fn canonical(category: &Category) -> Category {
    Category {
        id: category.id.clone(),
        name: built_in_name(&category.id)
            .unwrap_or(&category.name)
            .to_string(),
    }
}

fn stored_category_checked(category: &Category) -> Result<()> {
    category_checked(category)?;
    if canonical(category) != *category {
        return Err(bad("analytics stored category is not canonical"));
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn fresh() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

pub fn stamp_at(conn: &Connection, utc_ms: i64) -> Result<Stamp> {
    if utc_ms < 0 {
        return Err(bad("analytics clock is before the Unix epoch"));
    }
    let (day, offset): (String, i64) = conn.query_row(
        "SELECT strftime('%Y-%m-%d', ?1 / 1000, 'unixepoch', 'localtime'),
                CAST(ROUND((julianday(?1 / 1000, 'unixepoch', 'localtime') -
                            julianday(?1 / 1000, 'unixepoch')) * 1440) AS INTEGER)",
        [utc_ms],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if day.len() != 10 || offset.abs() > 840 {
        return Err(bad("analytics local clock could not be read"));
    }
    let mut local_day = [0; 10];
    local_day.copy_from_slice(day.as_bytes());
    Ok(Stamp {
        utc_ms,
        utc_minute: utc_ms / 60_000,
        offset_min: offset,
        local_day,
    })
}

fn consent(conn: &Connection) -> Result<bool> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [CONSENT_KEY],
            |row| row.get(0),
        )
        .optional()?;
    match raw.as_deref() {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => Err(StoreError::Corrupt(
            "analytics consent value is malformed".into(),
        )),
    }
}

fn selected_category(conn: &Connection) -> Result<Option<Category>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [CATEGORY_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.len() > 512 {
        return Err(StoreError::Corrupt(
            "analytics category value is too large".into(),
        ));
    }
    let category: Category = serde_json::from_str(&raw)
        .map_err(|_| StoreError::Corrupt("analytics category is malformed".into()))?;
    stored_category_checked(&category)
        .map_err(|_| StoreError::Corrupt("analytics category is malformed".into()))?;
    Ok(Some(category))
}

fn put_category(conn: &Connection, category: &Category) -> Result<()> {
    category_checked(category)?;
    let raw = serde_json::to_string(&canonical(category))
        .map_err(|_| bad("analytics category could not be saved"))?;
    conn.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![CATEGORY_KEY,raw])?;
    Ok(())
}

fn category_available(conn: &Connection, category: &Category) -> Result<()> {
    category_known(conn, category, false)
}

fn category_known(conn: &Connection, category: &Category, allow_retired: bool) -> Result<()> {
    category_checked(category)?;
    if built_in_name(&category.id).is_some() {
        return Ok(());
    }
    let stored: Option<(String, i64)> = conn
        .query_row(
            "SELECT name,retired FROM analytics_category WHERE id=?1",
            [&category.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match stored {
        Some((name, retired))
            if name == category.name && (retired == 0 || (allow_retired && retired == 1)) =>
        {
            Ok(())
        }
        _ => Err(bad("analytics category is unknown or retired")),
    }
}

fn begin(conn: &Connection, category: &Category, stamp: Stamp) -> Result<Runtime> {
    let session_id = fresh();
    let segment_id = fresh();
    conn.execute("INSERT INTO analytics_session(id,started_ms,start_day,start_offset_min,metric_version) VALUES(?1,?2,?3,?4,?5)",
        params![session_id,stamp.utc_ms,stamp.day(),stamp.offset_min,METRIC_VERSION])?;
    conn.execute("INSERT INTO analytics_segment(id,session_id,category_id,category_name,started_ms) VALUES(?1,?2,?3,?4,?5)",
        params![segment_id,session_id,category.id,canonical(category).name,stamp.utc_ms])?;
    Ok(Runtime {
        session_id,
        segment_id,
    })
}

impl Store {
    pub fn analytics_consent(&self) -> Result<bool> {
        consent(&self.conn)
    }
    pub fn analytics_selected_category(&self) -> Result<Option<Category>> {
        selected_category(&self.conn)
    }

    pub fn analytics_mark_gap(&self, runtime: &Runtime) -> Result<()> {
        gap(&self.conn, runtime)
    }

    pub fn analytics_start_on_open(&self) -> Result<Option<Runtime>> {
        if !consent(&self.conn)? {
            return Ok(None);
        }
        let category = selected_category(&self.conn)?.ok_or_else(|| {
            StoreError::Corrupt("analytics consent has no selected category".into())
        })?;
        category_available(&self.conn, &category)?;
        let stamp = stamp_at(&self.conn, now_ms())?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.conn.execute(
                "UPDATE analytics_session SET gap=1 WHERE ended_ms IS NULL",
                [],
            )?;
            self.conn.execute("UPDATE analytics_segment SET gap=1 WHERE ended_ms IS NULL AND session_id IN (SELECT id FROM analytics_session WHERE gap=1 AND ended_ms IS NULL)", [])?;
            begin(&self.conn, &category, stamp)
        })();
        match result {
            Ok(runtime) => {
                super::commit(&self.conn)?;
                Ok(Some(runtime))
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn analytics_enable(
        &self,
        category: &Category,
        current: Option<&Runtime>,
    ) -> Result<Runtime> {
        category_available(&self.conn, category)?;
        let stamp = stamp_at(&self.conn, now_ms())?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            put_category(&self.conn, category)?;
            self.conn.execute("INSERT INTO meta(key,value) VALUES(?1,'1') ON CONFLICT(key) DO UPDATE SET value='1'", [CONSENT_KEY])?;
            if let Some(current) = current {
                self.analytics_change_category_inner(current, category, stamp)
            } else {
                begin(&self.conn, category, stamp)
            }
        })();
        match result {
            Ok(runtime) => {
                super::commit(&self.conn)?;
                Ok(runtime)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn analytics_disable(&self, runtime: Option<&Runtime>) -> Result<()> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.conn.execute("INSERT INTO meta(key,value) VALUES(?1,'0') ON CONFLICT(key) DO UPDATE SET value='0'", [CONSENT_KEY])?;
            if let Some(runtime) = runtime {
                gap(&self.conn, runtime)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => super::commit(&self.conn),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn analytics_change_category(
        &self,
        runtime: &Runtime,
        category: &Category,
    ) -> Result<Runtime> {
        category_available(&self.conn, category)?;
        let stamp = stamp_at(&self.conn, now_ms())?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            put_category(&self.conn, category)?;
            self.analytics_change_category_inner(runtime, category, stamp)
        })();
        match result {
            Ok(next) => {
                super::commit(&self.conn)?;
                Ok(next)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn analytics_change_category_inner(
        &self,
        runtime: &Runtime,
        category: &Category,
        stamp: Stamp,
    ) -> Result<Runtime> {
        let ended = self.conn.execute("UPDATE analytics_segment SET ended_ms=?1 WHERE id=?2 AND session_id=?3 AND ended_ms IS NULL",
            params![stamp.utc_ms,runtime.segment_id,runtime.session_id])?;
        if ended != 1 {
            return Err(bad("analytics segment ended or changed; nothing was saved"));
        }
        let segment_id = fresh();
        self.conn.execute("INSERT INTO analytics_segment(id,session_id,category_id,category_name,started_ms) VALUES(?1,?2,?3,?4,?5)",
            params![segment_id,runtime.session_id,category.id,canonical(category).name,stamp.utc_ms])?;
        Ok(Runtime {
            session_id: runtime.session_id.clone(),
            segment_id,
        })
    }

    pub fn analytics_end(&self, runtime: &Runtime) -> Result<()> {
        let ended = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.conn.execute("UPDATE analytics_segment SET ended_ms=?1 WHERE id=?2 AND session_id=?3 AND ended_ms IS NULL", params![ended,runtime.segment_id,runtime.session_id])?;
            self.conn.execute(
                "UPDATE analytics_session SET ended_ms=?1 WHERE id=?2 AND ended_ms IS NULL",
                params![ended, runtime.session_id],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => super::commit(&self.conn),
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
    use crate::store::{
        source_words::{FlushAttribution, SourceMovement, WordSource},
        FlushEntry,
    };

    fn body(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":{}}}]}}]}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn entry(item_id: &str, text: &str, base_rev: i64) -> FlushEntry {
        FlushEntry {
            item_id: item_id.into(),
            body: body(text),
            base_rev,
            comments: None,
        }
    }

    fn typed(item_id: &str, count: u64) -> Vec<FlushAttribution> {
        vec![FlushAttribution {
            item_id: item_id.into(),
            day: "2026-09-25".into(),
            changes: vec![SourceMovement {
                source: WordSource::Typing,
                added: count,
                deleted: 0,
            }],
        }]
    }

    fn setup() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let item = store.item_create(None, "scene", "First").unwrap().id;
        (dir, store, item)
    }

    fn drafting() -> Category {
        Category {
            id: "drafting".into(),
            name: "Drafting".into(),
        }
    }

    #[test]
    fn migration_defaults_off_and_an_opted_in_save_records_one_observed_minute() {
        let (_dir, store, item) = setup();
        assert!(!store.analytics_consent().unwrap());
        assert!(store.analytics_start_on_open().unwrap().is_none());
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        store
            .flush_with_sources_and_session(
                &[entry(&item, "one two", 1)],
                &typed(&item, 2),
                Some(&runtime),
                true,
            )
            .unwrap();
        let report = store.analytics_report(None).unwrap();
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].segments[0].minutes.len(), 1);
        assert_eq!(report.sessions[0].segments[0].movements.len(), 1);
        assert_eq!(report.sessions[0].segments[0].movements[0].item_id, item);
        assert_eq!(report.sessions[0].segments[0].movements[0].added, 2);
        assert!(report.sessions[0].ended_ms.is_none());
        assert!(report.source_definition.contains("net checked"));
        assert!(report
            .coverage_definition
            .contains("elapsed book-open spans"));
    }

    #[test]
    fn a_version_fourteen_book_migrates_to_current_with_empty_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.db");
        let store = super::super::historical_test_store(&path, 14);
        let item = "legacy-scene";
        store
            .conn
            .execute_batch(
                "INSERT INTO item (id, type, title, position, rev)
                 VALUES ('legacy-scene', 'scene', 'Scene', 'V', 1);",
            )
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, 1)",
                params![item, crate::store::EMPTY_DOC_BODY],
            )
            .unwrap();
        drop(store);
        let old = Store::open_readonly(&path).unwrap();
        let old_snapshot = old.analytics_library_snapshot().unwrap();
        assert!(old_snapshot.report.is_none());
        drop(old);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.user_version().unwrap(),
            super::super::SCHEMA_VERSION
        );
        assert!(!reopened.analytics_consent().unwrap());
        assert!(reopened.analytics_report(None).unwrap().sessions.is_empty());
        assert_eq!(reopened.analytics_structure().unwrap().scenes, 1);
        assert_eq!(
            reopened.load_doc(item).unwrap().body,
            crate::store::EMPTY_DOC_BODY
        );
    }

    #[test]
    fn failed_primary_batch_does_not_publish_an_observation() {
        let (_dir, store, item) = setup();
        let other = store.item_create(None, "scene", "Second").unwrap().id;
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        let result = store.flush_with_sources_and_session(
            &[entry(&item, "one two", 1), entry(&other, "three", 99)],
            &typed(&item, 2),
            Some(&runtime),
            true,
        );
        assert!(matches!(result, Err(StoreError::Conflict { .. })));
        assert!(
            store.analytics_report(None).unwrap().sessions[0].segments[0]
                .movements
                .is_empty()
        );
        assert_eq!(
            store.load_doc(&item).unwrap().body,
            crate::store::EMPTY_DOC_BODY
        );
    }

    #[test]
    fn optional_capture_failure_leaves_the_saved_body_and_an_explicit_gap() {
        let (_dir, store, item) = setup();
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        store.conn.execute_batch("CREATE TRIGGER refuse_analytics BEFORE INSERT ON analytics_movement BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();
        store
            .flush_with_sources_and_session(
                &[entry(&item, "one two", 1)],
                &typed(&item, 2),
                Some(&runtime),
                true,
            )
            .unwrap();
        assert_eq!(store.load_doc(&item).unwrap().body, body("one two"));
        let report = store.analytics_report(None).unwrap();
        assert!(report.sessions[0].gap);
        assert!(report.sessions[0].segments[0].gap);
        assert!(report.sessions[0].segments[0].minutes.is_empty());
    }

    #[test]
    fn clock_reversal_and_ended_session_never_add_minutes() {
        let (_dir, store, item) = setup();
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        let day = *b"2026-09-25";
        let actual = vec![(item, 1, 0)];
        let movements = vec![];
        capture(
            &store.conn,
            &runtime,
            &actual,
            &movements,
            Stamp {
                utc_ms: 120_000,
                utc_minute: 2,
                offset_min: 0,
                local_day: day,
            },
        )
        .unwrap();
        capture(
            &store.conn,
            &runtime,
            &actual,
            &movements,
            Stamp {
                utc_ms: 120_000,
                utc_minute: 2,
                offset_min: 0,
                local_day: day,
            },
        )
        .unwrap();
        capture(
            &store.conn,
            &runtime,
            &actual,
            &movements,
            Stamp {
                utc_ms: 60_000,
                utc_minute: 1,
                offset_min: 60,
                local_day: day,
            },
        )
        .unwrap();
        let report = store.analytics_report(None).unwrap();
        assert_eq!(report.sessions[0].segments[0].minutes.len(), 1);
        assert!(report.sessions[0].gap);
        store.analytics_end(&runtime).unwrap();
        assert!(capture(
            &store.conn,
            &runtime,
            &actual,
            &movements,
            Stamp {
                utc_ms: 180_000,
                utc_minute: 3,
                offset_min: 0,
                local_day: day
            }
        )
        .is_err());
    }

    #[test]
    fn correction_exclusion_and_purge_preserve_original_words_and_manuscript() {
        let (_dir, store, item) = setup();
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        store
            .flush_with_sources_and_session(
                &[entry(&item, "one two", 1)],
                &typed(&item, 2),
                Some(&runtime),
                true,
            )
            .unwrap();
        let input = AdjustmentInput {
            category: Some(Category {
                id: "revision".into(),
                name: "Revision".into(),
            }),
            minutes: Some(8),
            source_totals: None,
            excluded: false,
            reason: Some("timer correction".into()),
        };
        store.analytics_adjust(&runtime.segment_id, input).unwrap();
        store
            .analytics_exclude_session(&runtime.session_id, true)
            .unwrap();
        let report = store.analytics_report(None).unwrap();
        let segment = &report.sessions[0].segments[0];
        assert_eq!(segment.category, drafting());
        assert_eq!(segment.movements[0].added, 2);
        assert!(segment.adjustment.as_ref().unwrap().excluded);
        let raw = serde_json::to_value(&report).unwrap();
        assert_eq!(
            raw["sessions"][0]["segments"][0]["adjustment"]["excluded"],
            true
        );
        assert_eq!(
            raw["sessions"][0]["segments"][0]["movements"][0]["item_id"],
            item
        );
        assert!(raw["sessions"][0]["segments"][0]["minutes"][0]["offset_min"].is_number());
        store
            .analytics_adjust(
                &runtime.segment_id,
                AdjustmentInput {
                    category: None,
                    minutes: None,
                    source_totals: None,
                    excluded: false,
                    reason: None,
                },
            )
            .unwrap();
        assert!(
            store.analytics_report(None).unwrap().sessions[0].segments[0]
                .adjustment
                .is_none()
        );
        store.analytics_purge().unwrap();
        assert!(store.analytics_report(None).unwrap().sessions.is_empty());
        assert_eq!(
            store
                .conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        for table in [
            "analytics_session",
            "analytics_segment",
            "analytics_minute",
            "analytics_movement",
            "analytics_adjustment",
        ] {
            let count: i64 = store
                .conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} still contains data after purge");
        }
        assert_eq!(store.load_doc(&item).unwrap().body, body("one two"));
        assert_eq!(
            store
                .source_word_summary("2026-09-25")
                .unwrap()
                .totals
                .typing
                .added,
            2
        );
    }

    #[test]
    fn complete_backup_keeps_session_observations_and_corrections() {
        let (dir, store, item) = setup();
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        store
            .flush_with_sources_and_session(
                &[entry(&item, "one two", 1)],
                &typed(&item, 2),
                Some(&runtime),
                true,
            )
            .unwrap();
        store
            .analytics_adjust(
                &runtime.segment_id,
                AdjustmentInput {
                    category: None,
                    minutes: Some(3),
                    source_totals: None,
                    excluded: false,
                    reason: None,
                },
            )
            .unwrap();
        let bundle = dir.path().join("complete.wbackup");
        crate::backup_bundle::write(&dir.path().join("book.db"), &store, &bundle).unwrap();
        let copy = Store::open_readonly(&crate::backup_bundle::db_path(&bundle)).unwrap();
        let report = copy.analytics_report(None).unwrap();
        assert_eq!(report.sessions[0].segments[0].movements[0].added, 2);
        assert_eq!(
            report.sessions[0].segments[0]
                .adjustment
                .as_ref()
                .unwrap()
                .minutes,
            Some(3)
        );
    }

    #[test]
    fn library_snapshot_pairs_identity_membership_and_observations() {
        let (_dir, store, _) = setup();
        store
            .set_meta(crate::identity::PIN_KEY, "opaque pin")
            .unwrap();
        store.analytics_enable(&drafting(), None).unwrap();
        let snapshot = store.analytics_library_snapshot().unwrap();
        assert_eq!(snapshot.book_id, store.book_id().unwrap());
        assert_eq!(snapshot.raw_pin.as_deref(), Some("opaque pin"));
        assert_eq!(snapshot.membership, store.membership().unwrap());
        assert_eq!(snapshot.report.unwrap().sessions.len(), 1);
    }

    #[test]
    fn active_custom_names_are_unique_after_trim_and_case_fold() {
        let (_dir, store, _) = setup();
        let first = store.analytics_custom_category_add("  Harbour  ").unwrap();
        assert_eq!(first.name, "Harbour");
        assert!(store.analytics_custom_category_add("harBOUR").is_err());
        assert!(store
            .analytics_enable(
                &Category {
                    id: first.id.clone(),
                    name: "Renamed".into()
                },
                None
            )
            .is_err());
        store.analytics_custom_category_retire(&first.id).unwrap();
        let second = store.analytics_custom_category_add("HARBOUR").unwrap();
        assert_ne!(first.id, second.id);
        let names = store.analytics_custom_categories().unwrap();
        assert_eq!(names.len(), 2);
        assert!(names
            .iter()
            .any(|(category, retired)| category.id == first.id && *retired));
        assert!(names
            .iter()
            .any(|(category, retired)| category.id == second.id && !retired));
    }

    #[test]
    fn including_an_uncorrected_session_does_not_create_a_correction() {
        let (_dir, store, _) = setup();
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        store
            .analytics_exclude_session(&runtime.session_id, false)
            .unwrap();
        assert!(
            store.analytics_report(None).unwrap().sessions[0].segments[0]
                .adjustment
                .is_none()
        );
        store
            .analytics_exclude_session(&runtime.session_id, true)
            .unwrap();
        assert!(
            store.analytics_report(None).unwrap().sessions[0].segments[0]
                .adjustment
                .as_ref()
                .unwrap()
                .excluded
        );
        store
            .analytics_exclude_session(&runtime.session_id, false)
            .unwrap();
        assert!(
            store.analytics_report(None).unwrap().sessions[0].segments[0]
                .adjustment
                .is_none()
        );
    }

    #[test]
    fn reopening_marks_a_crashed_session_as_a_gap_without_fabricating_an_end() {
        let (dir, store, _) = setup();
        let runtime = store.analytics_enable(&drafting(), None).unwrap();
        drop(store);
        let reopened = Store::open(&dir.path().join("book.db")).unwrap();
        let next = reopened.analytics_start_on_open().unwrap().unwrap();
        assert_ne!(runtime.session_id, next.session_id);
        let report = reopened.analytics_report(None).unwrap();
        let crashed = report
            .sessions
            .iter()
            .find(|session| session.id == runtime.session_id)
            .unwrap();
        assert!(crashed.gap);
        assert_eq!(crashed.ended_ms, None);
        assert!(crashed.segments[0].gap);
    }
}

fn gap(conn: &Connection, runtime: &Runtime) -> Result<()> {
    conn.execute(
        "UPDATE analytics_session SET gap=1 WHERE id=?1",
        [&runtime.session_id],
    )?;
    conn.execute(
        "UPDATE analytics_segment SET gap=1 WHERE id=?1",
        [&runtime.segment_id],
    )?;
    Ok(())
}

fn source_name(source: source_words::WordSource) -> &'static str {
    match source {
        source_words::WordSource::Typing => "typing",
        source_words::WordSource::Pasted => "pasted",
        source_words::WordSource::Imported => "imported",
        source_words::WordSource::Restored => "restored",
        source_words::WordSource::Unattributed => "unattributed",
    }
}

fn capture(
    conn: &Connection,
    runtime: &Runtime,
    actual: &[(String, u64, u64)],
    movements: &[(String, source_words::DatedMovement)],
    stamp: Stamp,
) -> Result<()> {
    if !consent(conn)? || !source_words::collecting(conn)? {
        gap(conn, runtime)?;
        return Ok(());
    }
    let active: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM analytics_segment segment
         JOIN analytics_session session ON session.id=segment.session_id
         WHERE segment.id=?1 AND session.id=?2 AND segment.ended_ms IS NULL AND session.ended_ms IS NULL)",
        params![runtime.segment_id,runtime.session_id], |row| row.get(0),
    )?;
    if !active {
        return Err(bad("analytics session has ended"));
    }
    let last: Option<i64> = conn.query_row(
        "SELECT last_observed_ms FROM analytics_session WHERE id=?1",
        [&runtime.session_id],
        |row| row.get(0),
    )?;
    if last.is_some_and(|millis| stamp.utc_ms <= millis) {
        gap(conn, runtime)?;
        return Ok(());
    }
    if movements
        .iter()
        .any(|(_, movement)| movement.added > MAX_SAFE || movement.deleted > MAX_SAFE)
    {
        return Err(bad("analytics movement exceeds the supported word bound"));
    }
    if !actual.is_empty() {
        conn.execute("INSERT OR IGNORE INTO analytics_minute(session_id,segment_id,utc_minute,local_day,offset_min)
                     VALUES(?1,?2,?3,?4,?5)",
            params![runtime.session_id,runtime.segment_id,stamp.utc_minute,stamp.day(),stamp.offset_min])?;
    }
    for (item_id, movement) in movements {
        conn.execute("INSERT INTO analytics_movement(segment_id,item_id,utc_ms,utc_minute,local_day,offset_min,source,added,deleted)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![runtime.segment_id,item_id,stamp.utc_ms,stamp.utc_minute,stamp.day(),stamp.offset_min,
                source_name(movement.source),movement.added as i64,movement.deleted as i64])?;
    }
    conn.execute(
        "UPDATE analytics_session SET last_observed_ms=?1 WHERE id=?2",
        params![stamp.utc_ms, runtime.session_id],
    )?;
    Ok(())
}

/// Optional observation is inside the manuscript transaction. A recoverable
/// capture error rolls back only its savepoint; a failed primary commit still
/// rolls back both the manuscript and any successful observation.
pub(crate) fn capture_optional(
    conn: &Connection,
    runtime: &Runtime,
    tracking_on: bool,
    actual: &[(String, u64, u64)],
    movements: &[(String, source_words::DatedMovement)],
) -> Result<()> {
    conn.execute_batch("SAVEPOINT analytics_optional")?;
    let result = (|| {
        if !tracking_on {
            return gap(conn, runtime);
        }
        let stamp = stamp_at(conn, now_ms())?;
        capture(conn, runtime, actual, movements, stamp)
    })();
    match result {
        Ok(()) => conn
            .execute_batch("RELEASE analytics_optional")
            .map_err(Into::into),
        Err(error) => {
            conn.execute_batch("ROLLBACK TO analytics_optional; RELEASE analytics_optional")?;
            if let Err(gap_error) = gap(conn, runtime) {
                eprintln!(
                    "analytics: capture failed ({error}); gap could not be recorded: {gap_error}"
                );
            } else {
                eprintln!("analytics: capture unavailable for this save: {error}");
            }
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Minute {
    pub utc_minute: i64,
    pub local_day: String,
    pub offset_min: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Movement {
    pub item_id: String,
    pub utc_ms: i64,
    pub utc_minute: i64,
    pub local_day: String,
    pub offset_min: i64,
    pub source: source_words::WordSource,
    pub added: u64,
    pub deleted: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Adjustment {
    pub category: Option<Category>,
    pub minutes: Option<u64>,
    pub source_totals: Option<source_words::SourceTotals>,
    pub excluded: bool,
    pub reason: Option<String>,
    pub changed_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdjustmentInput {
    pub category: Option<Category>,
    pub minutes: Option<u64>,
    pub source_totals: Option<source_words::SourceTotals>,
    pub excluded: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Segment {
    pub id: String,
    pub category: Category,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub gap: bool,
    pub minutes: Vec<Minute>,
    pub movements: Vec<Movement>,
    pub adjustment: Option<Adjustment>,
}

#[derive(Debug, Serialize)]
pub struct Session {
    pub id: String,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub start_day: String,
    pub start_offset_min: i64,
    pub metric_version: i64,
    pub gap: bool,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub recording_enabled: bool,
    pub metric_version: i64,
    pub motivation_since_ms: Option<i64>,
    pub motivation_visible: bool,
    pub forecast_goal_words: Option<u64>,
    pub sessions: Vec<Session>,
    pub more_sessions: u64,
    pub source_definition: &'static str,
    pub coverage_definition: &'static str,
}

pub struct LibrarySnapshot {
    pub book_id: Option<String>,
    pub raw_pin: Option<String>,
    pub membership: super::series::Membership,
    pub report: Option<Report>,
}

#[derive(Debug, Serialize)]
pub struct Structure {
    pub parts: u64,
    pub chapters: u64,
    pub scenes: u64,
    pub revision_states: std::collections::BTreeMap<String, u64>,
    pub revision_passes: u64,
    pub tasks_open: u64,
    pub tasks_done: u64,
    pub comments_open: u64,
    pub comments_resolved: u64,
}

fn source_from_name(name: &str) -> Result<source_words::WordSource> {
    match name {
        "typing" => Ok(source_words::WordSource::Typing),
        "pasted" => Ok(source_words::WordSource::Pasted),
        "imported" => Ok(source_words::WordSource::Imported),
        "restored" => Ok(source_words::WordSource::Restored),
        "unattributed" => Ok(source_words::WordSource::Unattributed),
        _ => Err(StoreError::Corrupt(
            "analytics movement source is unknown".into(),
        )),
    }
}

fn check_totals(totals: &source_words::SourceTotals) -> Result<()> {
    for count in [
        &totals.typing,
        &totals.pasted,
        &totals.imported,
        &totals.restored,
        &totals.unattributed,
    ] {
        if count.added > MAX_SAFE || count.deleted > MAX_SAFE {
            return Err(bad("analytics correction exceeds the supported word bound"));
        }
    }
    Ok(())
}

fn read_adjustment(conn: &Connection, segment_id: &str) -> Result<Option<Adjustment>> {
    let row: Option<(
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        i64,
        Option<String>,
        i64,
    )> = conn
        .query_row(
            "SELECT category_id,category_name,minutes,source_totals,excluded,reason,changed_ms
         FROM analytics_adjustment WHERE segment_id=?1",
            [segment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((category_id, category_name, minutes, source_totals, excluded, reason, changed_ms)) =
        row
    else {
        return Ok(None);
    };
    let category = match (category_id, category_name) {
        (Some(id), Some(name)) => {
            let category = Category { id, name };
            stored_category_checked(&category).map_err(|_| {
                StoreError::Corrupt("analytics category correction is malformed".into())
            })?;
            Some(category)
        }
        (None, None) => None,
        _ => {
            return Err(StoreError::Corrupt(
                "analytics category correction is incomplete".into(),
            ))
        }
    };
    let minutes = match minutes {
        Some(value) if value >= 0 && value as u64 <= MAX_MINUTES => Some(value as u64),
        None => None,
        _ => {
            return Err(StoreError::Corrupt(
                "analytics minute correction is malformed".into(),
            ))
        }
    };
    let source_totals = source_totals
        .map(|raw| {
            if raw.len() > 2048 {
                return Err(StoreError::Corrupt(
                    "analytics word correction is too large".into(),
                ));
            }
            let totals: source_words::SourceTotals = serde_json::from_str(&raw).map_err(|_| {
                StoreError::Corrupt("analytics word correction is malformed".into())
            })?;
            check_totals(&totals).map_err(|_| {
                StoreError::Corrupt("analytics word correction is malformed".into())
            })?;
            Ok(totals)
        })
        .transpose()?;
    if !matches!(excluded, 0 | 1)
        || reason
            .as_ref()
            .is_some_and(|text| text.chars().count() > 500)
    {
        return Err(StoreError::Corrupt(
            "analytics correction is malformed".into(),
        ));
    }
    Ok(Some(Adjustment {
        category,
        minutes,
        source_totals,
        excluded: excluded == 1,
        reason,
        changed_ms,
    }))
}

impl Store {
    pub fn analytics_library_snapshot(&self) -> Result<LibrarySnapshot> {
        self.conn.execute_batch("BEGIN")?;
        let result = (|| {
            Ok(LibrarySnapshot {
                book_id: self.book_id()?,
                raw_pin: self.get_meta(crate::identity::PIN_KEY)?,
                membership: self.membership()?,
                report: (self.user_version()? >= 15)
                    .then(|| self.analytics_report(Some(200)))
                    .transpose()?,
            })
        })();
        match result {
            Ok(snapshot) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(snapshot)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn analytics_structure(&self) -> Result<Structure> {
        let items = super::manuscript_items(self.items()?);
        let mut structure = Structure {
            parts: 0,
            chapters: 0,
            scenes: 0,
            revision_states: std::collections::BTreeMap::new(),
            revision_passes: 0,
            tasks_open: 0,
            tasks_done: 0,
            comments_open: 0,
            comments_resolved: 0,
        };
        for item in items {
            match item.item_type.as_str() {
                "part" => structure.parts += 1,
                "chapter" => structure.chapters += 1,
                "scene" => structure.scenes += 1,
                _ => {}
            }
            if let Some(state) = item.state {
                *structure.revision_states.entry(state).or_default() += 1;
            }
        }
        structure.revision_passes = self.revision_passes()?.len() as u64;
        for task in self.revision_tasks()? {
            if task.done {
                structure.tasks_done += 1;
            } else {
                structure.tasks_open += 1;
            }
        }
        let (open, resolved): (i64, i64) = self.conn.query_row(
            "SELECT count(*)-count(resolved_at),count(resolved_at) FROM comment",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        structure.comments_open = open as u64;
        structure.comments_resolved = resolved as u64;
        Ok(structure)
    }

    pub fn analytics_report(&self, limit: Option<usize>) -> Result<Report> {
        let enabled = consent(&self.conn)?;
        let baseline = self
            .get_meta(MOTIVATION_KEY)?
            .map(|raw| {
                raw.parse::<i64>().map_err(|_| {
                    StoreError::Corrupt("analytics motivation baseline is malformed".into())
                })
            })
            .transpose()?;
        let motivation_visible = match self.get_meta(MOTIVATION_VISIBLE_KEY)?.as_deref() {
            None | Some("0") => false,
            Some("1") => true,
            _ => {
                return Err(StoreError::Corrupt(
                    "analytics motivation display is malformed".into(),
                ))
            }
        };
        let forecast_goal_words = self
            .get_meta(FORECAST_GOAL_KEY)?
            .map(|raw| {
                raw.parse::<u64>()
                    .map_err(|_| StoreError::Corrupt("analytics forecast goal is malformed".into()))
            })
            .transpose()?;
        if forecast_goal_words.is_some_and(|goal| goal > MAX_SAFE) {
            return Err(StoreError::Corrupt(
                "analytics forecast goal is too large".into(),
            ));
        }
        let total: i64 =
            self.conn
                .query_row("SELECT count(*) FROM analytics_session", [], |row| {
                    row.get(0)
                })?;
        let bound = limit.unwrap_or(usize::MAX).min(i64::MAX as usize) as i64;
        let mut sessions = Vec::new();
        let mut stmt = self.conn.prepare(
            "SELECT id,started_ms,ended_ms,start_day,start_offset_min,metric_version,gap
            FROM analytics_session ORDER BY started_ms DESC,id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([bound], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        for row in rows {
            let (id, started_ms, ended_ms, start_day, start_offset_min, metric_version, gap) = row?;
            if metric_version != METRIC_VERSION
                || !matches!(gap, 0 | 1)
                || start_day.len() != 10
                || start_offset_min.abs() > 840
            {
                return Err(StoreError::Corrupt(
                    "analytics session has unsupported or malformed observation data".into(),
                ));
            }
            let mut segments = Vec::new();
            let mut segments_stmt = self.conn.prepare(
                "SELECT id,category_id,category_name,started_ms,ended_ms,gap
                FROM analytics_segment WHERE session_id=?1 ORDER BY started_ms,id",
            )?;
            let segment_rows = segments_stmt.query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?;
            for segment_row in segment_rows {
                let (
                    segment_id,
                    category_id,
                    category_name,
                    segment_started,
                    segment_ended,
                    segment_gap,
                ) = segment_row?;
                let category = Category {
                    id: category_id,
                    name: category_name,
                };
                stored_category_checked(&category).map_err(|_| {
                    StoreError::Corrupt("analytics segment category is malformed".into())
                })?;
                if !matches!(segment_gap, 0 | 1) {
                    return Err(StoreError::Corrupt(
                        "analytics segment gap is malformed".into(),
                    ));
                }
                let mut minutes = Vec::new();
                let mut minute_stmt = self.conn.prepare("SELECT utc_minute,local_day,offset_min FROM analytics_minute WHERE segment_id=?1 ORDER BY utc_minute")?;
                for minute in minute_stmt.query_map([&segment_id], |row| {
                    Ok(Minute {
                        utc_minute: row.get(0)?,
                        local_day: row.get(1)?,
                        offset_min: row.get(2)?,
                    })
                })? {
                    let minute = minute?;
                    if minute.local_day.len() != 10 || minute.offset_min.abs() > 840 {
                        return Err(StoreError::Corrupt("analytics minute is malformed".into()));
                    }
                    minutes.push(minute);
                }
                let mut movements = Vec::new();
                let mut movement_stmt = self.conn.prepare(
                    "SELECT item_id,utc_ms,utc_minute,local_day,offset_min,source,added,deleted
                    FROM analytics_movement WHERE segment_id=?1 ORDER BY id",
                )?;
                let movement_rows = movement_stmt.query_map([&segment_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                })?;
                for movement in movement_rows {
                    let (
                        item_id,
                        utc_ms,
                        utc_minute,
                        local_day,
                        offset_min,
                        source,
                        added,
                        deleted,
                    ) = movement?;
                    if local_day.len() != 10
                        || offset_min.abs() > 840
                        || added < 0
                        || deleted < 0
                        || added as u64 > MAX_SAFE
                        || deleted as u64 > MAX_SAFE
                    {
                        return Err(StoreError::Corrupt(
                            "analytics movement is malformed".into(),
                        ));
                    }
                    movements.push(Movement {
                        item_id,
                        utc_ms,
                        utc_minute,
                        local_day,
                        offset_min,
                        source: source_from_name(&source)?,
                        added: added as u64,
                        deleted: deleted as u64,
                    });
                }
                segments.push(Segment {
                    id: segment_id.clone(),
                    category,
                    started_ms: segment_started,
                    ended_ms: segment_ended,
                    gap: segment_gap == 1,
                    minutes,
                    movements,
                    adjustment: read_adjustment(&self.conn, &segment_id)?,
                });
            }
            sessions.push(Session {
                id,
                started_ms,
                ended_ms,
                start_day,
                start_offset_min,
                metric_version,
                gap: gap == 1,
                segments,
            });
        }
        Ok(Report {
            recording_enabled:enabled,metric_version:METRIC_VERSION,motivation_since_ms:baseline,
            motivation_visible,forecast_goal_words,
            more_sessions:(total as u64).saturating_sub(sessions.len() as u64),sessions,
            source_definition:"Attributed added/deleted words; net checked against saved word-count change. Gross text edits are not independently measured.",
            coverage_definition:"Only successful eligible doc_flush saves while session recording, time tracking and source collection were on. Imported/restored operations outside doc_flush and legacy counters are not attributed to sessions. Session start/end timestamps are elapsed book-open spans, not active writing duration; pauses and gaps may occur inside them.",
        })
    }

    pub fn analytics_adjust(&self, segment_id: &str, input: AdjustmentInput) -> Result<()> {
        if !valid_id(segment_id) {
            return Err(bad("analytics segment ID is invalid"));
        }
        if input.minutes.is_some_and(|n| n > MAX_MINUTES) {
            return Err(bad("analytics minute correction is too large"));
        }
        if let Some(totals) = &input.source_totals {
            check_totals(totals)?;
        }
        if let Some(category) = &input.category {
            category_known(&self.conn, category, true)?;
        }
        let reason = input
            .reason
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty());
        if reason
            .as_ref()
            .is_some_and(|text| text.chars().count() > 500 || text.chars().any(char::is_control))
        {
            return Err(bad(
                "analytics correction reason is too long or contains control characters",
            ));
        }
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM analytics_segment WHERE id=?1)",
            [segment_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(bad("analytics segment does not exist"));
        }
        if input.category.is_none()
            && input.minutes.is_none()
            && input.source_totals.is_none()
            && !input.excluded
            && reason.is_none()
        {
            self.conn.execute(
                "DELETE FROM analytics_adjustment WHERE segment_id=?1",
                [segment_id],
            )?;
            return Ok(());
        }
        let totals = input
            .source_totals
            .map(|value| {
                serde_json::to_string(&value)
                    .map_err(|_| bad("analytics correction could not be serialized"))
            })
            .transpose()?;
        let (category_id, category_name) = input
            .category
            .map(|category| {
                let category = canonical(&category);
                (Some(category.id), Some(category.name))
            })
            .unwrap_or((None, None));
        self.conn.execute("INSERT INTO analytics_adjustment(segment_id,category_id,category_name,minutes,source_totals,excluded,reason,changed_ms)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
            ON CONFLICT(segment_id) DO UPDATE SET category_id=excluded.category_id,category_name=excluded.category_name,
              minutes=excluded.minutes,source_totals=excluded.source_totals,excluded=excluded.excluded,
              reason=excluded.reason,changed_ms=excluded.changed_ms",
            params![segment_id,category_id,category_name,input.minutes.map(|n|n as i64),totals,i64::from(input.excluded),reason,now_ms()])?;
        Ok(())
    }

    pub fn analytics_exclude_session(&self, session_id: &str, excluded: bool) -> Result<()> {
        if !valid_id(session_id) {
            return Err(bad("analytics session ID is invalid"));
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM analytics_session WHERE id=?1)",
                [session_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(bad("analytics session does not exist"));
            }
            if excluded {
                self.conn.execute("INSERT INTO analytics_adjustment(segment_id,excluded,changed_ms)
                    SELECT id,1,?2 FROM analytics_segment WHERE session_id=?1
                    ON CONFLICT(segment_id) DO UPDATE SET excluded=1,changed_ms=excluded.changed_ms",
                    params![session_id,now_ms()])?;
            } else {
                self.conn.execute(
                    "UPDATE analytics_adjustment SET excluded=0,changed_ms=?2
                    WHERE segment_id IN (SELECT id FROM analytics_segment WHERE session_id=?1)",
                    params![session_id, now_ms()],
                )?;
                self.conn.execute(
                    "DELETE FROM analytics_adjustment
                    WHERE segment_id IN (SELECT id FROM analytics_segment WHERE session_id=?1)
                      AND excluded=0 AND category_id IS NULL AND category_name IS NULL
                      AND minutes IS NULL AND source_totals IS NULL AND reason IS NULL",
                    [session_id],
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => super::commit(&self.conn),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn analytics_reset_motivation(&self) -> Result<i64> {
        let now = now_ms();
        self.set_meta(MOTIVATION_KEY, &now.to_string())?;
        Ok(now)
    }

    pub fn analytics_set_motivation(&self, visible: bool, goal_words: Option<u64>) -> Result<()> {
        if goal_words.is_some_and(|goal| goal > MAX_SAFE) {
            return Err(bad("analytics goal is too large"));
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.set_meta(MOTIVATION_VISIBLE_KEY, if visible { "1" } else { "0" })?;
            match goal_words {
                Some(goal) => self.set_meta(FORECAST_GOAL_KEY, &goal.to_string())?,
                None => {
                    self.conn
                        .execute("DELETE FROM meta WHERE key=?1", [FORECAST_GOAL_KEY])?;
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => super::commit(&self.conn),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn analytics_purge(&self) -> Result<()> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.conn.execute("DELETE FROM analytics_session", [])?;
            self.conn
                .execute("DELETE FROM meta WHERE key=?1", [MOTIVATION_KEY])?;
            self.conn.execute("INSERT INTO meta(key,value) VALUES(?1,'0') ON CONFLICT(key) DO UPDATE SET value='0'",[CONSENT_KEY])?;
            Ok(())
        })();
        match result {
            Ok(()) => super::commit(&self.conn),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn analytics_custom_category_add(&self, name: &str) -> Result<Category> {
        let category = Category {
            id: fresh(),
            name: name.trim().to_string(),
        };
        category_checked(&category)?;
        let folded = category.name.to_lowercase();
        if self
            .analytics_custom_categories()?
            .iter()
            .any(|(existing, retired)| !retired && existing.name.trim().to_lowercase() == folded)
        {
            return Err(bad("analytics_category_name_taken"));
        }
        let count: i64 =
            self.conn
                .query_row("SELECT count(*) FROM analytics_category", [], |row| {
                    row.get(0)
                })?;
        if count >= 64 {
            return Err(bad(
                "this book has the maximum number of custom analytics categories",
            ));
        }
        self.conn.execute(
            "INSERT INTO analytics_category(id,name) VALUES(?1,?2)",
            params![category.id, category.name],
        )?;
        Ok(category)
    }

    pub fn analytics_custom_categories(&self) -> Result<Vec<(Category, bool)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,name,retired FROM analytics_category ORDER BY name,id")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                Category {
                    id: row.get(0)?,
                    name: row.get(1)?,
                },
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (category, retired) = row?;
            category_checked(&category).map_err(|_| {
                StoreError::Corrupt("analytics custom category is malformed".into())
            })?;
            if !matches!(retired, 0 | 1) {
                return Err(StoreError::Corrupt(
                    "analytics custom category is malformed".into(),
                ));
            }
            Ok((category, retired == 1))
        })
        .collect()
    }

    pub fn analytics_custom_category_retire(&self, id: &str) -> Result<()> {
        if !valid_id(id) {
            return Err(bad("analytics category ID is invalid"));
        }
        if selected_category(&self.conn)?.is_some_and(|category| category.id == id) {
            return Err(bad(
                "choose another activity before retiring the current one",
            ));
        }
        let changed = self
            .conn
            .execute("UPDATE analytics_category SET retired=1 WHERE id=?1", [id])?;
        if changed == 0 {
            return Err(bad("analytics category does not exist"));
        }
        Ok(())
    }
}
