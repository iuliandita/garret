use rusqlite::{types::ValueRef, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    commit, document_text, now_ms, Result, Store, StoreError, BIBLE_TYPE, MAX_DEPTH, TIMELINE_TYPE,
    TRASH_TYPE,
};

const META_KEY: &str = "source_words";
const STATUS_KEY: &str = "source_words_status";
/// PRESENCE IS THE STATE: absent means collecting, any row means paused. Kept
/// outside the ledger so a save can decide to skip the ledger without reading
/// it, and so a damaged ledger can still be paused.
const PAUSED_KEY: &str = "source_words_paused";
const VERSION: u8 = 1;
const MAX_DAYS: usize = 32;
const MAX_ATTRIBUTIONS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_JS_DATE_MS: u64 = 8_640_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WordSource {
    Typing,
    Pasted,
    Imported,
    Restored,
    Unattributed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceMovement {
    pub source: WordSource,
    pub added: u64,
    pub deleted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlushAttribution {
    pub item_id: String,
    pub day: String,
    pub changes: Vec<SourceMovement>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceCount {
    pub added: u64,
    pub deleted: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceTotals {
    pub typing: SourceCount,
    pub pasted: SourceCount,
    pub imported: SourceCount,
    pub restored: SourceCount,
    pub unattributed: SourceCount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceWordSummary {
    pub available: bool,
    pub collecting: bool,
    /// Collection was paused and resumed at least once since `started_at`, so
    /// the totals leave out whatever was saved in between.
    pub interrupted: bool,
    pub started_at: Option<i64>,
    pub totals: SourceTotals,
    pub today_typing: Option<i64>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DatedMovement {
    pub source: WordSource,
    pub added: u64,
    pub deleted: u64,
    pub day: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TypingDay {
    day: String,
    net: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Ledger {
    version: u8,
    started_at: i64,
    totals: SourceTotals,
    typing_days: Vec<TypingDay>,
    /// Absent in every ledger written before collection could pause, and
    /// omitted while false so those bytes stay what they were.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    interrupted: bool,
}

enum LedgerRead {
    Available(Ledger),
    Unavailable(String),
}

enum MetaValue {
    Text(Vec<u8>),
    Other,
}

impl SourceTotals {
    fn count_mut(&mut self, source: WordSource) -> &mut SourceCount {
        match source {
            WordSource::Typing => &mut self.typing,
            WordSource::Pasted => &mut self.pasted,
            WordSource::Imported => &mut self.imported,
            WordSource::Restored => &mut self.restored,
            WordSource::Unattributed => &mut self.unattributed,
        }
    }

    fn counts(&self) -> [&SourceCount; 5] {
        [
            &self.typing,
            &self.pasted,
            &self.imported,
            &self.restored,
            &self.unattributed,
        ]
    }
}

fn blank(started_at: i64) -> Ledger {
    Ledger {
        version: VERSION,
        started_at,
        totals: SourceTotals::default(),
        typing_days: Vec::new(),
        interrupted: false,
    }
}

fn encode(ledger: &Ledger) -> Result<String> {
    serde_json::to_string(ledger).map_err(|error| {
        super::StoreError::Corrupt(format!("cannot encode source word ledger: {error}"))
    })
}

pub(crate) fn migrate(conn: &Connection, started_at: i64) -> Result<()> {
    let value = encode(&blank(started_at))?;
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
        rusqlite::params![META_KEY, value],
    )?;
    Ok(())
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<MetaValue>> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [key],
            |row| match row.get_ref(0)? {
                ValueRef::Text(raw) => Ok(MetaValue::Text(raw.to_vec())),
                _ => Ok(MetaValue::Other),
            },
        )
        .optional()?)
}

fn read(conn: &Connection) -> Result<LedgerRead> {
    if let Some(status) = meta_value(conn, STATUS_KEY)? {
        return Ok(LedgerRead::Unavailable(match status {
            MetaValue::Text(reason) => String::from_utf8(reason)
                .unwrap_or_else(|_| "source word ledger status is malformed".to_string()),
            _ => "source word ledger status is malformed".to_string(),
        }));
    }
    let Some(value) = meta_value(conn, META_KEY)? else {
        return Ok(LedgerRead::Unavailable(
            "source word ledger is missing".to_string(),
        ));
    };
    let MetaValue::Text(raw) = value else {
        return Ok(LedgerRead::Unavailable(
            "source word ledger is not text".to_string(),
        ));
    };
    let ledger: Ledger = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(_) => {
            return Ok(LedgerRead::Unavailable(
                "source word ledger is malformed".to_string(),
            ))
        }
    };
    if ledger.version != VERSION {
        return Ok(LedgerRead::Unavailable(format!(
            "source word ledger version {} is unsupported",
            ledger.version
        )));
    }
    if ledger.started_at < 0 || ledger.started_at as u64 > MAX_JS_DATE_MS {
        return Ok(LedgerRead::Unavailable(
            "source word ledger start time is outside the safe range".to_string(),
        ));
    }
    if ledger
        .totals
        .counts()
        .iter()
        .any(|count| count.added > MAX_SAFE_INTEGER || count.deleted > MAX_SAFE_INTEGER)
    {
        return Ok(LedgerRead::Unavailable(
            "source word ledger counters are outside the safe range".to_string(),
        ));
    }
    if ledger.typing_days.len() > MAX_DAYS
        || ledger
            .typing_days
            .iter()
            .any(|entry| !valid_day(&entry.day) || entry.net.unsigned_abs() > MAX_SAFE_INTEGER)
        || ledger
            .typing_days
            .windows(2)
            .any(|pair| pair[0].day <= pair[1].day)
    {
        return Ok(LedgerRead::Unavailable(
            "source word ledger day buckets are malformed".to_string(),
        ));
    }
    Ok(LedgerRead::Available(ledger))
}

fn write(conn: &Connection, ledger: &Ledger) -> Result<()> {
    let value = encode(ledger)?;
    conn.execute(
        "UPDATE meta SET value = ?2 WHERE key = ?1",
        rusqlite::params![META_KEY, value],
    )?;
    Ok(())
}

fn disable_after_overflow(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![STATUS_KEY, "source word ledger counter overflow"],
    )?;
    Ok(())
}

pub(crate) fn reset(conn: &Connection, started_at: i64) -> Result<()> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [STATUS_KEY])?;
    let value = encode(&blank(started_at))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![META_KEY, value],
    )?;
    Ok(())
}

pub(crate) fn reset_with_restored(
    conn: &Connection,
    started_at: i64,
    restored_words: u64,
) -> Result<()> {
    reset(conn, started_at)?;
    if restored_words > MAX_SAFE_INTEGER {
        return disable_after_overflow(conn);
    }
    record(
        conn,
        &[DatedMovement {
            source: WordSource::Restored,
            added: restored_words,
            deleted: 0,
            day: None,
        }],
    )
}

pub(crate) fn collecting(conn: &Connection) -> Result<bool> {
    let paused: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)",
        [PAUSED_KEY],
        |row| row.get(0),
    )?;
    Ok(!paused)
}

/// Pausing never reads the ledger, so a damaged one can still be paused.
/// Resuming marks a readable ledger interrupted: its totals now have a hole.
fn set_collecting(conn: &Connection, collect: bool) -> Result<()> {
    if collect == collecting(conn)? {
        return Ok(());
    }
    if !collect {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![PAUSED_KEY, now_ms().to_string()],
        )?;
        return Ok(());
    }
    conn.execute("DELETE FROM meta WHERE key = ?1", [PAUSED_KEY])?;
    if let LedgerRead::Available(mut ledger) = read(conn)? {
        ledger.interrupted = true;
        write(conn, &ledger)?;
    }
    Ok(())
}

impl Store {
    /// Each runs in its own immediate transaction, so a save cannot land
    /// between the check and the write, and a failure leaves nothing behind.
    fn source_words_transaction(&self, change: impl FnOnce(&Connection) -> Result<()>) -> Result<()> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match change(&self.conn) {
            Ok(()) => commit(&self.conn),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn set_source_words_collecting(&self, collect: bool) -> Result<()> {
        self.source_words_transaction(|conn| set_collecting(conn, collect))
    }

    /// A new measurement interval: the ledger and its status only. The
    /// manuscript, history, snapshots, writing time and the pause stay.
    pub fn reset_source_words(&self) -> Result<()> {
        self.source_words_transaction(|conn| reset(conn, now_ms()))
    }
}

pub(crate) fn record(conn: &Connection, movements: &[DatedMovement]) -> Result<()> {
    if movements.is_empty() {
        return Ok(());
    }
    // BEFORE the ledger is read: a paused book saves whether or not its
    // ledger is readable, and a paused save is not measured at all.
    if !collecting(conn)? {
        return Ok(());
    }
    let LedgerRead::Available(mut ledger) = read(conn)? else {
        return Ok(());
    };
    for movement in movements {
        let count = ledger.totals.count_mut(movement.source);
        let Some(added) = count.added.checked_add(movement.added) else {
            return disable_after_overflow(conn);
        };
        let Some(deleted) = count.deleted.checked_add(movement.deleted) else {
            return disable_after_overflow(conn);
        };
        if added > MAX_SAFE_INTEGER || deleted > MAX_SAFE_INTEGER {
            return disable_after_overflow(conn);
        }
        count.added = added;
        count.deleted = deleted;

        if movement.source == WordSource::Typing {
            let Some(day) = movement.day.as_deref().filter(|day| valid_day(day)) else {
                continue;
            };
            let delta = i128::from(movement.added) - i128::from(movement.deleted);
            let current = ledger
                .typing_days
                .iter()
                .find(|entry| entry.day == day)
                .map(|entry| i128::from(entry.net))
                .unwrap_or(0);
            let next = current + delta;
            if next.unsigned_abs() > u128::from(MAX_SAFE_INTEGER) {
                return disable_after_overflow(conn);
            }
            if let Some(entry) = ledger.typing_days.iter_mut().find(|entry| entry.day == day) {
                entry.net = next as i64;
            } else {
                ledger.typing_days.push(TypingDay {
                    day: day.to_string(),
                    net: next as i64,
                });
            }
        }
    }
    ledger
        .typing_days
        .sort_by(|left, right| right.day.cmp(&left.day));
    ledger.typing_days.truncate(MAX_DAYS);
    write(conn, &ledger)
}

pub(crate) fn directional(
    source: WordSource,
    old_body: Option<&str>,
    new_body: &str,
) -> DatedMovement {
    let old = old_body.map(word_count).unwrap_or(0);
    let new = word_count(new_body);
    if new >= old {
        DatedMovement {
            source,
            added: new - old,
            deleted: 0,
            day: None,
        }
    } else {
        DatedMovement {
            source,
            added: 0,
            deleted: old - new,
            day: None,
        }
    }
}

fn word_count(body: &str) -> u64 {
    document_text(body)
        .map(|text| crate::words::count_words(&text))
        .unwrap_or(0)
}

pub(crate) fn eligible(conn: &Connection, item_id: &str) -> Result<bool> {
    let eligible = conn.query_row(
        "WITH RECURSIVE ancestors(id, parent_id, type, depth) AS (
           SELECT id, parent_id, type, 0 FROM item WHERE id = ?1
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.type, ancestors.depth + 1
             FROM item parent JOIN ancestors ON parent.id = ancestors.parent_id
            WHERE ancestors.depth < ?5
         ), reserved(id) AS (
           SELECT root.id FROM item root
            WHERE root.parent_id IS NULL
              AND root.type IN (?2, ?3)
              AND root.id = (
                SELECT first.id FROM item first
                 WHERE first.parent_id IS NULL AND first.type = root.type
                 ORDER BY first.position LIMIT 1
              )
         )
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM ancestors WHERE depth = 0 AND type = ?4) THEN 0
           WHEN EXISTS (SELECT 1 FROM ancestors JOIN reserved USING (id)) THEN 0
           ELSE 1
         END",
        rusqlite::params![item_id, TRASH_TYPE, BIBLE_TYPE, TIMELINE_TYPE, MAX_DEPTH],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(eligible != 0)
}

/// The eligible corpus in a recovery copy, read through the identity fork's
/// existing transaction. A call to `Store::items` here would try to open a
/// nested read transaction; this scan instead states the source ledger's own
/// exclusions once and counts each document from the same protected snapshot.
pub(crate) fn recovered_word_count(conn: &Connection) -> Result<u64> {
    let (reached, total): (i64, i64) = conn.query_row(
        "WITH RECURSIVE walk(id, depth) AS (
           SELECT id, 0 FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT child.id, walk.depth + 1
             FROM item child JOIN walk ON child.parent_id = walk.id
            WHERE walk.depth + 1 < ?1
         )
         SELECT (SELECT count(*) FROM walk), (SELECT count(*) FROM item)",
        [MAX_DEPTH],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if reached != total {
        return Err(StoreError::Corrupt(format!(
            "walk reached {reached} of {total} item(s): an orphaned parent_id, a cycle, \
             or nesting deeper than {MAX_DEPTH}"
        )));
    }
    let mut stmt = conn.prepare(
        "WITH RECURSIVE reserved(id, depth) AS (
           SELECT root.id, 0 FROM item root
            WHERE root.parent_id IS NULL
              AND root.type IN (?1, ?2)
              AND root.id = (
                SELECT first.id FROM item first
                 WHERE first.parent_id IS NULL AND first.type = root.type
                 ORDER BY first.position LIMIT 1
              )
           UNION ALL
           SELECT child.id, reserved.depth + 1
             FROM item child JOIN reserved ON child.parent_id = reserved.id
            WHERE reserved.depth < ?4
         )
         SELECT doc.body
           FROM doc
           LEFT JOIN item ON item.id = doc.item_id
          WHERE (item.type IS NULL OR item.type != ?3)
            AND NOT EXISTS (SELECT 1 FROM reserved WHERE reserved.id = doc.item_id)",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![TRASH_TYPE, BIBLE_TYPE, TIMELINE_TYPE, MAX_DEPTH],
        |row| row.get::<_, String>(0),
    )?;
    let mut words = 0u64;
    for body in rows {
        words = words.saturating_add(word_count(&body?));
    }
    Ok(words)
}

pub(crate) fn flush_movements_by_item(
    actual: &[(String, u64, u64)],
    attribution: &[FlushAttribution],
) -> Vec<(String, DatedMovement)> {
    let segments = attribution.iter().try_fold(0usize, |total, entry| {
        total.checked_add(entry.changes.len())
    });
    let bounded = attribution.len() <= MAX_ATTRIBUTIONS
        && matches!(segments, Some(total) if total <= MAX_ATTRIBUTIONS);
    let mut by_item = std::collections::HashMap::new();
    let mut duplicates = std::collections::HashSet::new();
    if bounded {
        for entry in attribution {
            if by_item.insert(entry.item_id.as_str(), entry).is_some() {
                duplicates.insert(entry.item_id.as_str());
            }
        }
    }
    let mut actual_items = std::collections::HashSet::new();
    let mut duplicate_actual = std::collections::HashSet::new();
    for (item_id, _, _) in actual {
        if !actual_items.insert(item_id.as_str()) {
            duplicate_actual.insert(item_id.as_str());
        }
    }

    let mut out = Vec::new();
    for (item_id, added, deleted) in actual {
        let supplied = bounded
            .then(|| by_item.get(item_id.as_str()).copied())
            .flatten()
            .filter(|entry| !duplicates.contains(entry.item_id.as_str()))
            .filter(|entry| !duplicate_actual.contains(entry.item_id.as_str()))
            .filter(|entry| valid_attribution(entry, *added, *deleted));
        if let Some(entry) = supplied {
            out.extend(entry.changes.iter().map(|change| (item_id.clone(), DatedMovement {
                source: change.source,
                added: change.added,
                deleted: change.deleted,
                day: (change.source == WordSource::Typing).then(|| entry.day.clone()),
            })));
        } else if *added != 0 || *deleted != 0 {
            out.push((item_id.clone(), DatedMovement {
                source: WordSource::Unattributed,
                added: *added,
                deleted: *deleted,
                day: None,
            }));
        }
    }
    out
}

fn valid_attribution(entry: &FlushAttribution, actual_added: u64, actual_deleted: u64) -> bool {
    if !valid_day(&entry.day) {
        return false;
    }
    let mut net = 0i128;
    for change in &entry.changes {
        if change.added > MAX_SAFE_INTEGER || change.deleted > MAX_SAFE_INTEGER {
            return false;
        }
        net += i128::from(change.added) - i128::from(change.deleted);
    }
    net == i128::from(actual_added) - i128::from(actual_deleted)
}

fn valid_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let parse = |start: usize, end: usize| -> Option<u32> {
        bytes[start..end].iter().try_fold(0u32, |value, byte| {
            byte.is_ascii_digit()
                .then(|| value * 10 + u32::from(*byte - b'0'))
        })
    };
    let (Some(year), Some(month), Some(day)) = (parse(0, 4), parse(5, 7), parse(8, 10)) else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&day)
}

pub(crate) fn summary(conn: &Connection, day: &str) -> Result<SourceWordSummary> {
    if !valid_day(day) {
        return Err(StoreError::InvalidSourceWordDay {
            day: day.to_string(),
        });
    }
    let collecting = collecting(conn)?;
    match read(conn)? {
        LedgerRead::Unavailable(reason) => Ok(unavailable(&reason, collecting)),
        LedgerRead::Available(ledger) => Ok(SourceWordSummary {
            available: true,
            collecting,
            interrupted: ledger.interrupted,
            started_at: Some(ledger.started_at),
            totals: ledger.totals,
            today_typing: Some(
                ledger
                    .typing_days
                    .iter()
                    .find(|entry| entry.day == day)
                    .map(|entry| entry.net)
                    .unwrap_or(0),
            ),
            warning: None,
        }),
    }
}

fn unavailable(reason: &str, collecting: bool) -> SourceWordSummary {
    SourceWordSummary {
        available: false,
        collecting,
        interrupted: false,
        started_at: None,
        totals: SourceTotals::default(),
        today_typing: None,
        warning: Some(reason.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{FlushEntry, Store};
    use std::collections::HashSet;
    use tempfile::tempdir;

    fn body(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":{}}}]}}]}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn scene(store: &Store, title: &str) -> String {
        store.item_create(None, "scene", title).unwrap().id
    }

    fn flush_entry(item_id: &str, text: &str, base_rev: i64) -> FlushEntry {
        FlushEntry {
            item_id: item_id.to_string(),
            body: body(text),
            base_rev,
            comments: None,
        }
    }

    fn typed(item_id: &str, added: u64) -> Vec<FlushAttribution> {
        vec![FlushAttribution {
            item_id: item_id.to_string(),
            day: "2026-09-20".into(),
            changes: vec![SourceMovement {
                source: WordSource::Typing,
                added,
                deleted: 0,
            }],
        }]
    }

    fn refuse_ledger_writes(store: &Store) {
        store
            .conn
            .execute_batch(
                "CREATE TRIGGER refuse_ledger BEFORE UPDATE ON meta WHEN NEW.key = 'source_words'
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
    }

    #[test]
    fn a_paused_save_writes_the_body_and_leaves_the_ledger_alone() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        let ledger = store.get_meta(META_KEY).unwrap();
        store.set_source_words_collecting(false).unwrap();

        store
            .flush_with_sources(&[flush_entry(&id, "one two", 1)], &typed(&id, 2))
            .unwrap();

        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
        assert_eq!(store.get_meta(META_KEY).unwrap(), ledger);
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(!summary.collecting);
        assert_eq!(summary.totals, SourceTotals::default());
        assert_eq!(summary.today_typing, Some(0));
    }

    #[test]
    fn a_paused_save_never_reads_the_ledger() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store.set_source_words_collecting(false).unwrap();
        // Reading the ledger row now FAILS rather than answering: a save that
        // looked at the ledger before the pause would be refused here.
        store
            .conn
            .execute_batch(
                "ALTER TABLE meta RENAME TO meta_real;
                 CREATE VIEW meta AS SELECT key, value FROM meta_real
                  WHERE CASE WHEN key = 'source_words'
                        THEN abs(length(value) * 0 - 9223372036854775807 - 1)
                        ELSE 1 END;",
            )
            .unwrap();
        assert!(store.get_meta(META_KEY).is_err());

        store
            .flush_with_sources(&[flush_entry(&id, "one two", 1)], &typed(&id, 2))
            .unwrap();

        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
    }

    #[test]
    fn a_paused_book_with_a_damaged_ledger_still_saves_and_keeps_the_damage() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        let damaged = "{ ledger bytes stay exactly like this";
        store.set_meta(META_KEY, damaged).unwrap();
        store.set_source_words_collecting(false).unwrap();

        store
            .flush_with_sources(&[flush_entry(&id, "one two", 1)], &typed(&id, 2))
            .unwrap();

        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
        assert_eq!(store.get_meta(META_KEY).unwrap().as_deref(), Some(damaged));
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(!summary.available);
        assert!(!summary.collecting);
    }

    #[test]
    fn resuming_measures_again_and_discloses_the_gap() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store.set_source_words_collecting(true).unwrap();
        assert!(!store.source_word_summary("2026-09-20").unwrap().interrupted);

        store.set_source_words_collecting(false).unwrap();
        store
            .flush_with_sources(&[flush_entry(&id, "one two", 1)], &typed(&id, 2))
            .unwrap();
        store.set_source_words_collecting(true).unwrap();
        store
            .flush_with_sources(&[flush_entry(&id, "one two three", 2)], &typed(&id, 1))
            .unwrap();

        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(summary.collecting);
        assert!(summary.interrupted);
        assert_eq!(summary.totals.typing, SourceCount { added: 1, deleted: 0 });
        assert_eq!(summary.today_typing, Some(1));
        assert_eq!(store.get_meta(PAUSED_KEY).unwrap(), None);
    }

    #[test]
    fn a_failed_resume_rolls_back_and_stays_paused() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        store.set_source_words_collecting(false).unwrap();
        refuse_ledger_writes(&store);

        assert!(store.set_source_words_collecting(true).is_err());

        assert!(store.get_meta(PAUSED_KEY).unwrap().is_some());
        assert!(!store.source_word_summary("2026-09-20").unwrap().collecting);
        // The transaction is closed: the next write is not refused as nested.
        store.set_meta("probe", "1").unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn reset_clears_only_the_measurement() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store
            .flush_with_sources(&[flush_entry(&id, "one two", 1)], &typed(&id, 2))
            .unwrap();
        store.record_versions_at(&[flush_entry(&id, "one two", 1)], 1).unwrap();
        let snapshot = store.snapshot_create("Kept").unwrap();
        for (key, value) in [
            (crate::projects::TIME_DAY_KEY, "2026-09-20"),
            (crate::projects::TIME_MINUTES_KEY, "12"),
            (crate::projects::TIME_LAST_MINUTE_KEY, "99"),
            (crate::projects::DAY_KEY, "2026-09-20"),
            (crate::projects::DAY_BASELINE_KEY, "7"),
        ] {
            store.set_meta(key, value).unwrap();
        }
        store.set_source_words_collecting(false).unwrap();
        store.set_meta(STATUS_KEY, "source word ledger counter overflow").unwrap();
        let items = serde_json::to_value(store.items().unwrap()).unwrap();
        let versions = store.doc_versions(&id).unwrap();
        let paused = store.get_meta(PAUSED_KEY).unwrap();

        store.reset_source_words().unwrap();

        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(summary.available);
        assert!(!summary.collecting);
        assert!(!summary.interrupted);
        assert_eq!(summary.totals, SourceTotals::default());
        assert_eq!(summary.today_typing, Some(0));
        assert_eq!(store.get_meta(STATUS_KEY).unwrap(), None);
        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
        assert_eq!(serde_json::to_value(store.items().unwrap()).unwrap(), items);
        assert_eq!(store.doc_versions(&id).unwrap(), versions);
        assert_eq!(store.snapshots().unwrap(), vec![snapshot]);
        assert_eq!(store.get_meta(PAUSED_KEY).unwrap(), paused);
        assert_eq!(store.get_meta(crate::projects::TIME_DAY_KEY).unwrap().as_deref(), Some("2026-09-20"));
        assert_eq!(store.get_meta(crate::projects::TIME_MINUTES_KEY).unwrap().as_deref(), Some("12"));
        assert_eq!(store.get_meta(crate::projects::TIME_LAST_MINUTE_KEY).unwrap().as_deref(), Some("99"));
        assert_eq!(store.get_meta(crate::projects::DAY_KEY).unwrap().as_deref(), Some("2026-09-20"));
        assert_eq!(store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap().as_deref(), Some("7"));
    }

    #[test]
    fn a_failed_reset_rolls_back_the_status_and_the_ledger() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store
            .flush_with_sources(&[flush_entry(&id, "one two", 1)], &typed(&id, 2))
            .unwrap();
        let ledger = store.get_meta(META_KEY).unwrap();
        store.set_meta(STATUS_KEY, "source word ledger counter overflow").unwrap();
        refuse_ledger_writes(&store);

        assert!(store.reset_source_words().is_err());

        assert_eq!(
            store.get_meta(STATUS_KEY).unwrap().as_deref(),
            Some("source word ledger counter overflow")
        );
        assert_eq!(store.get_meta(META_KEY).unwrap(), ledger);
        store.set_meta("probe", "1").unwrap();
    }

    #[test]
    fn dates_are_calendar_dates() {
        assert!(valid_day("2028-02-29"));
        assert!(!valid_day("2027-02-29"));
        assert!(!valid_day("2027-13-01"));
        assert!(!valid_day("2027-1-01"));
    }

    #[test]
    fn summary_refuses_an_invalid_query_day() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        assert!(matches!(
            store.source_word_summary("2027-02-29"),
            Err(StoreError::InvalidSourceWordDay { .. })
        ));
    }

    #[test]
    fn a_conflicted_batch_rolls_back_bodies_and_source_words() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let first = scene(&store, "First");
        let second = scene(&store, "Second");
        let error = store
            .flush_with_sources(
                &[
                    flush_entry(&first, "one two", 1),
                    flush_entry(&second, "three four", 99),
                ],
                &[FlushAttribution {
                    item_id: first.clone(),
                    day: "2026-09-20".into(),
                    changes: vec![SourceMovement {
                        source: WordSource::Typing,
                        added: 2,
                        deleted: 0,
                    }],
                }],
            )
            .unwrap_err();
        assert!(matches!(error, super::super::StoreError::Conflict { .. }));
        assert_eq!(
            store.load_doc(&first).unwrap().body,
            super::super::EMPTY_DOC_BODY
        );
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert_eq!(summary.totals, SourceTotals::default());
        assert_eq!(summary.today_typing, Some(0));
    }

    #[test]
    fn mismatched_provenance_falls_back_to_the_actual_unattributed_net() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store
            .flush_with_sources(
                &[flush_entry(&id, "one two three", 1)],
                &[FlushAttribution {
                    item_id: id,
                    day: "2026-09-20".into(),
                    changes: vec![SourceMovement {
                        source: WordSource::Typing,
                        added: 2,
                        deleted: 0,
                    }],
                }],
            )
            .unwrap();
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert_eq!(summary.totals.typing, SourceCount::default());
        assert_eq!(summary.totals.unattributed.added, 3);
        assert_eq!(summary.today_typing, Some(0));
    }

    #[test]
    fn mixed_sources_keep_gross_movements_and_the_typing_day() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store
            .flush_with_sources(
                &[flush_entry(&id, "one two three", 1)],
                &[FlushAttribution {
                    item_id: id,
                    day: "2026-09-20".into(),
                    changes: vec![
                        SourceMovement {
                            source: WordSource::Typing,
                            added: 5,
                            deleted: 1,
                        },
                        SourceMovement {
                            source: WordSource::Pasted,
                            added: 0,
                            deleted: 1,
                        },
                    ],
                }],
            )
            .unwrap();
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert_eq!(
            summary.totals.typing,
            SourceCount {
                added: 5,
                deleted: 1
            }
        );
        assert_eq!(
            summary.totals.pasted,
            SourceCount {
                added: 0,
                deleted: 1
            }
        );
        assert_eq!(summary.today_typing, Some(4));
    }

    #[test]
    fn a_corrupt_ledger_is_preserved_while_the_body_saves() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        let damaged = "{ ledger bytes stay exactly like this";
        store.set_meta(META_KEY, damaged).unwrap();
        store.flush(&[flush_entry(&id, "one two", 1)]).unwrap();
        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
        assert_eq!(store.get_meta(META_KEY).unwrap().as_deref(), Some(damaged));
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(!summary.available);
        assert!(summary.warning.unwrap().contains("malformed"));
    }

    #[test]
    fn a_blob_ledger_is_preserved_while_the_body_saves() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        let damaged: Vec<u8> = vec![0xff, 0x00, 0x7f];
        store
            .conn
            .execute(
                "UPDATE meta SET value = ?2 WHERE key = ?1",
                rusqlite::params![META_KEY, damaged],
            )
            .unwrap();

        store.flush(&[flush_entry(&id, "one two", 1)]).unwrap();

        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
        let raw: rusqlite::types::Value = store
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [META_KEY], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw, rusqlite::types::Value::Blob(vec![0xff, 0x00, 0x7f]));
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(!summary.available);
        assert!(summary.warning.unwrap().contains("not text"));
    }

    #[test]
    fn invalid_utf8_text_is_preserved_while_the_body_saves() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store
            .conn
            .execute(
                "UPDATE meta SET value = CAST(X'ff007f' AS TEXT) WHERE key = ?1",
                [META_KEY],
            )
            .unwrap();

        store.flush(&[flush_entry(&id, "one two", 1)]).unwrap();

        assert_eq!(store.load_doc(&id).unwrap().body, body("one two"));
        let raw = store
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [META_KEY], |row| {
                match row.get_ref(0)? {
                    ValueRef::Text(raw) => Ok(raw.to_vec()),
                    other => panic!("expected text, got {other:?}"),
                }
            })
            .unwrap();
        assert_eq!(raw, vec![0xff, 0x00, 0x7f]);
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(!summary.available);
        assert!(summary.warning.unwrap().contains("malformed"));
    }

    #[test]
    fn a_timestamp_outside_the_javascript_date_range_disables_statistics() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        store
            .set_meta(META_KEY, &encode(&blank((MAX_JS_DATE_MS + 1) as i64)).unwrap())
            .unwrap();

        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert!(!summary.available);
        assert!(summary.warning.unwrap().contains("start time"));
    }

    #[test]
    fn a_legacy_book_starts_at_zero_without_backfilling_its_prose() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let store = super::super::historical_test_store(&path, 11);
        let id = "legacy-scene";
        store
            .conn
            .execute(
                "INSERT INTO item (id, type, title, position, rev, state)
             VALUES (?1, 'scene', 'Scene', 'V', 1, NULL)",
                [id],
            )
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, 1)",
                rusqlite::params![id, body("one two three")],
            )
            .unwrap();
        drop(store);

        let migrated = Store::open(&path).unwrap();
        assert_eq!(migrated.load_doc(id).unwrap().body, body("one two three"));
        let summary = migrated.source_word_summary("2026-09-20").unwrap();
        assert!(summary.available);
        assert_eq!(summary.totals, SourceTotals::default());
    }

    #[test]
    fn identity_forks_reset_copied_measurement_and_recovery_starts_as_restored() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let id = scene(&store, "Scene");
        store
            .flush(&[flush_entry(&id, "one two three", 1)])
            .unwrap();
        let original = store.book_id().unwrap().unwrap();
        let separated = store.fork_book_identity(&original).unwrap();
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert_eq!(summary.totals, SourceTotals::default());

        store.fork_recovered_book_identity(&separated).unwrap();
        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert_eq!(summary.totals.restored.added, 3);
        assert_eq!(summary.totals.unattributed.added, 0);
    }

    #[test]
    fn import_replace_snapshot_and_mirror_writers_record_their_sources() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let imported = body("one two");
        let ids = store
            .import_tree(&[(None, "scene", "Scene", Some(imported.as_str()))])
            .unwrap();
        let id = &ids[0];
        let replaced = store
            .replace_everywhere(&HashSet::new(), "two", "two three", "Before replace")
            .unwrap();
        assert_eq!(replaced.documents, 1);
        store.snapshot_restore(replaced.snapshot.id).unwrap();

        let rev = store.load_doc(id).unwrap().rev;
        let accepted = store
            .accept_from_mirror(
                &[(id.clone(), rev, body("one two three four"))],
                "Before mirror accept",
            )
            .unwrap();
        let accepted_doc = &accepted.documents[0];
        store
            .undo_mirror_accept(
                id,
                accepted_doc.version_id,
                accepted.snapshot.id,
                accepted_doc.rev,
            )
            .unwrap();

        let summary = store.source_word_summary("2026-09-20").unwrap();
        assert_eq!(summary.totals.imported.added, 4);
        assert_eq!(summary.totals.unattributed.added, 1);
        assert_eq!(summary.totals.restored.deleted, 3);
    }
}
