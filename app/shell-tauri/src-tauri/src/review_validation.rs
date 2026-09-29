//! Read-only review integrity checks. Historical ranges are ancestry, not
//! claims about today's prose; only pending hunks must still apply exactly.
use crate::validation::Finding;
use crate::review_document::{self, FragmentToken, ReviewHunk};
use crate::row_scan;
use rusqlite::{types::ValueRef, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) const TABLES: [&str; 4] = [
    "review_author",
    "review_group",
    "review_hunk",
    "review_message",
];
pub(crate) const INVALID: &str = "invalid_review_record";
pub(crate) const UNREADABLE: &str = "unreadable_review_record";

pub(crate) fn has_review_tables(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table'
          AND name IN ('review_author','review_group','review_hunk','review_message'))",
        [],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|error| error.to_string())
}

#[derive(Debug, Default, Serialize)]
pub struct Counts {
    pub authors: u64,
    pub groups: u64,
    pub hunks: u64,
    pub messages: u64,
    pub pending: u64,
    pub conflicted: u64,
    pub accepted: u64,
    pub rejected: u64,
}

pub(crate) fn counts(conn: &Connection, version: i64) -> Result<Counts, String> {
    if version < 17 && !has_review_tables(conn)? {
        return Ok(Counts::default());
    }
    let count = |sql: &str| {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .map(|count| count as u64)
            .map_err(|e| e.to_string())
    };
    Ok(Counts {
        authors: count("SELECT count(*) FROM review_author")?,
        groups: count("SELECT count(*) FROM review_group")?,
        hunks: count("SELECT count(*) FROM review_hunk")?,
        messages: count("SELECT count(*) FROM review_message")?,
        pending: count("SELECT count(*) FROM review_hunk WHERE state='pending'")?,
        conflicted: count("SELECT count(*) FROM review_hunk WHERE state='conflicted'")?,
        accepted: count("SELECT count(*) FROM review_hunk WHERE state='accepted'")?,
        rejected: count("SELECT count(*) FROM review_hunk WHERE state='rejected'")?,
    })
}

#[derive(Serialize)]
pub(crate) struct RawRow {
    pub rowid: i64,
    pub values: BTreeMap<String, Value>,
}
pub(crate) type Tables = BTreeMap<String, Vec<RawRow>>;
fn issue(kind: &str, detail: String, item_id: Option<String>) -> Finding {
    Finding {
        kind: kind.into(),
        detail,
        item_id,
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn raw(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(n) => json!({"sqlite_real_bits_hex": format!("{:016x}", n.to_bits())}),
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => json!(text),
            Err(_) => json!({"sqlite_text_hex": hex(bytes)}),
        },
        ValueRef::Blob(bytes) => json!({"sqlite_blob_hex": hex(bytes)}),
    }
}

/// Raw cells survive type damage. Query each row independently so one bad row
/// cannot make the rest of a table disappear from recovery or validation.
pub(crate) fn read(conn: &Connection) -> (Tables, Vec<Finding>) {
    let mut tables = Tables::new();
    let mut issues = Vec::new();
    for table in TABLES {
        let mut records = Vec::new();
        let ids = match row_scan::rowids(conn, table) {
            Ok((ids, detail)) => {
                if let Some(detail) = detail {
                    issues.push(issue(UNREADABLE, detail, None));
                }
                ids
            }
            Err(e) => {
                issues.push(issue(
                    UNREADABLE,
                    format!("{table} could not be read: {e}"),
                    None,
                ));
                tables.insert(table.into(), records);
                continue;
            }
        };
        match conn.prepare(&format!("SELECT * FROM {table} WHERE rowid=?1")) {
            Err(e) => issues.push(issue(
                UNREADABLE,
                format!("{table} could not be prepared: {e}"),
                None,
            )),
            Ok(mut stmt) => {
                let columns: Vec<String> = stmt
                    .column_names()
                    .iter()
                    .map(|name| (*name).into())
                    .collect();
                let required: &[&str] = match table {
                    "review_author" => &["id", "display_name", "created_at"],
                    "review_group" => &[
                        "id",
                        "item_id",
                        "author_id",
                        "author_name",
                        "rev",
                        "created_at",
                    ],
                    "review_hunk" => &[
                        "id",
                        "group_id",
                        "ordinal",
                        "original_from",
                        "original_to",
                        "before_json",
                        "after_json",
                        "mapped_from",
                        "mapped_to",
                        "state",
                        "conflicted_at",
                        "decided_at",
                        "decision_author_id",
                        "decision_author_name",
                    ],
                    _ => &[
                        "id",
                        "group_id",
                        "author_id",
                        "author_name",
                        "body",
                        "created_at",
                    ],
                };
                if required
                    .iter()
                    .any(|name| !columns.iter().any(|column| column == name))
                {
                    issues.push(issue(
                        INVALID,
                        format!("{table} is missing required columns; available cells retained"),
                        None,
                    ));
                }
                for rowid in ids {
                    match stmt.query_row([rowid], |row| {
                        let mut values = BTreeMap::new();
                        for (index, name) in columns.iter().enumerate() {
                            values.insert(name.clone(), raw(row.get_ref(index)?));
                        }
                        Ok(RawRow { rowid, values })
                    }) {
                        Ok(row) => records.push(row),
                        Err(e) => issues.push(issue(
                            UNREADABLE,
                            format!("row {rowid} of {table} could not be read: {e}"),
                            None,
                        )),
                    }
                }
            }
        }
        records.sort_by_key(|row| row.rowid);
        tables.insert(table.into(), records);
    }
    (tables, issues)
}

#[derive(Deserialize)]
struct Author {
    id: i64,
    display_name: String,
    created_at: i64,
}
#[derive(Deserialize)]
struct Group {
    id: i64,
    item_id: String,
    author_id: i64,
    author_name: String,
    rev: i64,
    created_at: i64,
}
#[derive(Deserialize)]
struct Hunk {
    id: i64,
    group_id: i64,
    ordinal: i64,
    original_from: i64,
    original_to: i64,
    before_json: String,
    after_json: String,
    mapped_from: i64,
    mapped_to: i64,
    state: String,
    conflicted_at: Option<i64>,
    decided_at: Option<i64>,
    decision_author_id: Option<i64>,
    decision_author_name: Option<String>,
}
#[derive(Deserialize)]
struct Message {
    id: i64,
    group_id: i64,
    author_id: i64,
    author_name: String,
    body: String,
    created_at: i64,
}

fn decoded<T: serde::de::DeserializeOwned>(
    tables: &Tables,
    table: &str,
    issues: &mut Vec<Finding>,
) -> Vec<T> {
    tables.get(table).into_iter().flatten().filter_map(|row| {
        match serde_json::from_value(serde_json::to_value(&row.values).expect("raw values serialize")) {
            Ok(value) => Some(value),
            Err(e) => { issues.push(issue(INVALID, format!("row {} of {table} has malformed fields: {e}; raw cells retained by salvage", row.rowid), None)); None }
        }
    }).collect()
}
fn text_ok(text: &str, max: usize, multiline: bool) -> bool {
    !text.trim().is_empty()
        && text.len() <= max
        && !text
            .chars()
            .any(|ch| ch.is_control() && !(multiline && matches!(ch, '\n' | '\r' | '\t')))
}
fn fragment(raw: &str) -> Result<Vec<FragmentToken>, String> {
    // JSON overhead can be large for mark-rich fragments, but allocations must
    // still be bounded when validating a file written by a foreign tool.
    if raw.len() > 64 * 1024 * 1024 {
        return Err("fragment JSON exceeds limit".into());
    }
    let tokens: Vec<FragmentToken> = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if tokens.len() > 100_000 {
        return Err("too many fragment tokens".into());
    }
    let mut bytes = 0usize;
    for token in &tokens {
        if let FragmentToken::Text { text, marks } = token {
            if text.is_empty() {
                return Err("empty fragment text".into());
            }
            bytes += text.len();
            let mut sorted = marks.clone();
            sorted.sort();
            if sorted.windows(2).any(|pair| pair[0] == pair[1]) {
                return Err("duplicate fragment mark".into());
            }
        }
    }
    if bytes > 16 * 1024 * 1024 {
        return Err("fragment text exceeds limit".into());
    }
    Ok(tokens)
}

// A fragment may start/end inside a paragraph, but cannot contain nested
// paragraphs, two closes in a row, or text outside any possible paragraph.
fn contexts(tokens: &[FragmentToken]) -> u8 {
    let mut result = 0;
    for initial in 0..=1 {
        let mut depth = initial;
        let mut valid = true;
        for token in tokens {
            match token {
                FragmentToken::Open if depth == 0 => depth = 1,
                FragmentToken::Close if depth == 1 => depth = 0,
                FragmentToken::Text { .. } if depth == 1 => {}
                _ => {
                    valid = false;
                    break;
                }
            }
        }
        if valid {
            result |= 1 << (initial * 2 + depth);
        }
    }
    result
}

pub(crate) fn check(conn: &Connection, tables: &Tables, issues: &mut Vec<Finding>) {
    let authors: Vec<Author> = decoded(tables, "review_author", issues);
    let groups: Vec<Group> = decoded(tables, "review_group", issues);
    let hunks: Vec<Hunk> = decoded(tables, "review_hunk", issues);
    let messages: Vec<Message> = decoded(tables, "review_message", issues);
    let author_ids: HashSet<i64> = authors.iter().map(|row| row.id).collect();
    let group_map: HashMap<i64, &Group> = groups.iter().map(|row| (row.id, row)).collect();
    if authors.len() > 100 {
        issues.push(issue(
            INVALID,
            "review_author exceeds the author limit".into(),
            None,
        ));
    }
    for author in &authors {
        if author.id <= 0 || !text_ok(&author.display_name, 80, false) || author.created_at < 0 {
            issues.push(issue(
                INVALID,
                format!(
                    "review author {} has invalid name, ID or timestamp",
                    author.id
                ),
                None,
            ));
        }
    }
    let mut bodies = HashMap::new();
    let mut groups_per_doc = BTreeMap::<&str, usize>::new();
    for group in &groups {
        *groups_per_doc.entry(&group.item_id).or_default() += 1;
        if group.id <= 0
            || group.rev < 1
            || group.created_at < 0
            || !text_ok(&group.author_name, 80, false)
            || !author_ids.contains(&group.author_id)
        {
            issues.push(issue(
                INVALID,
                format!(
                    "review group {} has invalid metadata or a missing author",
                    group.id
                ),
                Some(group.item_id.clone()),
            ));
        }
        match conn
            .query_row(
                "SELECT d.body,i.type FROM doc d JOIN item i ON i.id=d.item_id WHERE d.item_id=?1",
                [&group.item_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
        {
            Ok(Some((body, kind))) if kind != crate::store::TIMELINE_TYPE => {
                bodies.insert(group.item_id.clone(), body);
            }
            _ => issues.push(issue(
                INVALID,
                format!("review group {} has no readable prose document", group.id),
                Some(group.item_id.clone()),
            )),
        }
    }
    for (id, count) in groups_per_doc {
        if count > 500 {
            issues.push(issue(
                INVALID,
                "document exceeds review group limit".into(),
                Some(id.into()),
            ));
        }
    }
    let mut ordinals = HashMap::<i64, Vec<i64>>::new();
    let mut pending = BTreeMap::<&str, usize>::new();
    for hunk in &hunks {
        ordinals
            .entry(hunk.group_id)
            .or_default()
            .push(hunk.ordinal);
        let group = group_map.get(&hunk.group_id);
        let item = group.map(|group| group.item_id.clone());
        if hunk.id <= 0 || group.is_none() {
            issues.push(issue(
                INVALID,
                format!("review hunk {} has invalid ID or missing group", hunk.id),
                item.clone(),
            ));
        }
        let decided = matches!(hunk.state.as_str(), "accepted" | "rejected");
        let decision_ok = if decided {
            hunk.decided_at.is_some_and(|at| at >= 0)
                && hunk
                    .decision_author_id
                    .is_some_and(|id| author_ids.contains(&id))
                && hunk
                    .decision_author_name
                    .as_ref()
                    .is_some_and(|name| text_ok(name, 80, false))
        } else {
            hunk.decided_at.is_none()
                && hunk.decision_author_id.is_none()
                && hunk.decision_author_name.is_none()
        };
        let conflict_ok = match hunk.state.as_str() {
            "pending" | "accepted" => hunk.conflicted_at.is_none(),
            "conflicted" => hunk.conflicted_at.is_some_and(|at| at >= 0),
            "rejected" => hunk.conflicted_at.is_none_or(|at| at >= 0),
            _ => false,
        };
        if !decision_ok || !conflict_ok {
            issues.push(issue(
                INVALID,
                format!(
                    "review hunk {} has invalid state or decision attribution",
                    hunk.id
                ),
                item.clone(),
            ));
        }
        let before = fragment(&hunk.before_json);
        let after = fragment(&hunk.after_json);
        match (before, after) {
            (Ok(before), Ok(after)) => {
                let width = review_document::fragment_width(&before) as i64;
                if hunk.original_from < 0
                    || hunk.original_to.checked_sub(hunk.original_from) != Some(width)
                    || hunk.mapped_from < 0
                    || hunk.mapped_to.checked_sub(hunk.mapped_from) != Some(width)
                    || before == after
                    || contexts(&before) & contexts(&after) == 0
                {
                    issues.push(issue(
                        INVALID,
                        format!(
                            "review hunk {} has inconsistent ranges or unchanged fragments",
                            hunk.id
                        ),
                        item.clone(),
                    ));
                } else if hunk.state == "pending" {
                    if let Some(group) = group {
                        *pending.entry(&group.item_id).or_default() += 1;
                        if let Some(body) = bodies.get(&group.item_id) {
                            let proposal = ReviewHunk {
                                from: hunk.mapped_from as usize,
                                to: hunk.mapped_to as usize,
                                before,
                                after,
                            };
                            if let Err(error) = review_document::apply_hunk(body, &proposal) {
                                issues.push(issue(
                                    INVALID,
                                    format!(
                                        "pending review hunk {} cannot apply: {error}",
                                        hunk.id
                                    ),
                                    item.clone(),
                                ));
                            }
                        }
                    }
                }
            }
            _ => issues.push(issue(
                INVALID,
                format!("review hunk {} has malformed fragments", hunk.id),
                item,
            )),
        }
    }
    for group in &groups {
        let mut ranges: Vec<_> = hunks
            .iter()
            .filter(|hunk| hunk.group_id == group.id)
            .map(|hunk| (hunk.original_from, hunk.original_to))
            .collect();
        ranges.sort();
        if ranges.windows(2).any(|pair| {
            pair[0].1 > pair[1].0
                || (pair[0].1 == pair[1].0 && (pair[0].0 == pair[0].1 || pair[1].0 == pair[1].1))
        }) {
            issues.push(issue(
                INVALID,
                format!("review group {} has overlapping original hunks", group.id),
                Some(group.item_id.clone()),
            ));
        }
        let mut values = ordinals.remove(&group.id).unwrap_or_default();
        values.sort();
        if values.is_empty()
            || values.len() > 64
            || values
                .iter()
                .enumerate()
                .any(|(index, value)| *value != index as i64)
        {
            issues.push(issue(
                INVALID,
                format!(
                    "review group {} has missing, duplicate or invalid hunk ordinals",
                    group.id
                ),
                Some(group.item_id.clone()),
            ));
        }
    }
    for (id, count) in pending {
        if count > 500 {
            issues.push(issue(
                INVALID,
                "document exceeds pending review limit".into(),
                Some(id.into()),
            ));
        }
    }
    let mut message_counts = BTreeMap::<i64, usize>::new();
    for message in &messages {
        *message_counts.entry(message.group_id).or_default() += 1;
        let group = group_map.get(&message.group_id);
        if message.id <= 0
            || message.created_at < 0
            || group.is_none()
            || !author_ids.contains(&message.author_id)
            || !text_ok(&message.author_name, 80, false)
            || !text_ok(&message.body, 4_000, true)
        {
            issues.push(issue(
                INVALID,
                format!(
                    "review message {} has invalid fields or a missing group/author",
                    message.id
                ),
                group.map(|group| group.item_id.clone()),
            ));
        }
    }
    for (id, count) in message_counts {
        if count > 500 {
            issues.push(issue(
                INVALID,
                format!("review group {id} exceeds discussion limit"),
                None,
            ));
        }
    }
}

pub(crate) fn validate(conn: &Connection, version: i64) -> Vec<Finding> {
    let present = match has_review_tables(conn) {
        Ok(present) => present,
        Err(error) => {
            return vec![issue(
                UNREADABLE,
                format!("review table inventory could not be read: {error}"),
                None,
            )];
        }
    };
    if version < 17 && !present {
        return Vec::new();
    }
    let (tables, mut issues) = read(conn);
    if version < 17 {
        issues.push(issue(
            INVALID,
            format!("review tables exist below schema version 17 (found version {version})"),
            None,
        ));
    }
    check(conn, &tables, &mut issues);
    issues
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::review_document::{FragmentToken, ReviewHunk};
    use crate::store::{review::ReviewDecision, FlushEntry, Store};
    use std::path::Path;
    pub(crate) fn doc(text: &str) -> String {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}).to_string()
    }
    pub(crate) fn seed(path: &Path) -> (Store, String) {
        let store = Store::open(path).unwrap();
        let scene = store.item_create(None, "scene", "Scene").unwrap();
        let rev = store
            .flush(&[FlushEntry {
                item_id: scene.id.clone(),
                base_rev: scene.doc_rev.unwrap(),
                body: doc("abcdefgh"),
                comments: None,
            }])
            .unwrap()[0]
            .rev;
        let author = store.review_author_create("Reviewer Alice").unwrap();
        let deciding = store.review_author_create("Editor Ben").unwrap();
        let token = |text: &str| FragmentToken::Text {
            text: text.into(),
            marks: vec![],
        };
        let mut groups = Vec::new();
        for (from, before, after) in [(2, "b", "B"), (4, "d", "D"), (5, "e", "E"), (8, "h", "H")] {
            groups.push(
                store
                    .review_group_create(
                        &scene.id,
                        rev,
                        author.id,
                        &[ReviewHunk {
                            from,
                            to: from + 1,
                            before: vec![token(before)],
                            after: vec![token(after)],
                        }],
                    )
                    .unwrap(),
            );
        }
        store
            .review_message_add(
                groups[0].id,
                groups[0].rev,
                deciding.id,
                "Keep this reason.\nSecond line.",
            )
            .unwrap();
        let first = store.review_group(groups[0].id).unwrap();
        let accepted = store
            .review_decide(
                first.id,
                first.rev,
                rev,
                &[first.hunks[0].id],
                ReviewDecision::Accept,
                deciding.id,
            )
            .unwrap();
        let second = store.review_group(groups[1].id).unwrap();
        store
            .review_decide(
                second.id,
                second.rev,
                accepted.doc_rev,
                &[second.hunks[0].id],
                ReviewDecision::Reject,
                deciding.id,
            )
            .unwrap();
        store
            .flush(&[FlushEntry {
                item_id: scene.id.clone(),
                base_rev: accepted.doc_rev,
                body: doc("aBcdxfgh"),
                comments: None,
            }])
            .unwrap();
        (store, scene.id)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::seed;
    use super::*;
    #[cfg(not(target_os = "android"))]
    use crate::store::Store;
    use tempfile::tempdir;

    #[test]
    fn review_integrity_preserves_historical_states_and_checks_pending_against_prose() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (_store, item) = seed(&path);
        let conn = Connection::open(&path).unwrap();
        let healthy = validate(&conn, 17);
        assert!(healthy.is_empty(), "{healthy:?}");
        let count = counts(&conn, 17).unwrap();
        assert_eq!(
            (count.authors, count.groups, count.hunks, count.messages),
            (2, 4, 4, 1)
        );
        assert_eq!(
            (
                count.accepted,
                count.rejected,
                count.conflicted,
                count.pending
            ),
            (1, 1, 1, 1)
        );
        conn.execute(
            "UPDATE doc SET body=?1 WHERE item_id=?2",
            rusqlite::params![test_support::doc("nothing like the original"), item],
        )
        .unwrap();
        let findings = validate(&conn, 17);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(findings[0].detail.contains("pending review hunk"));
    }

    #[test]
    fn review_integrity_reports_independent_damage_and_keeps_reading_siblings() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (_store, _) = seed(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;
            UPDATE review_author SET display_name='' WHERE id=1;
            UPDATE review_message SET author_id=999;
            UPDATE review_hunk SET decision_author_name=NULL WHERE state='accepted';
            UPDATE review_hunk SET original_from=-1 WHERE state='rejected';
            UPDATE review_hunk SET after_json='[{\"kind\":\"unsupported\"}]' WHERE state='conflicted';").unwrap();
        let findings = validate(&conn, 17);
        for expected in [
            "author 1",
            "message",
            "decision attribution",
            "inconsistent ranges",
            "malformed fragments",
        ] {
            assert!(
                findings
                    .iter()
                    .any(|finding| finding.detail.contains(expected)),
                "missing {expected}: {findings:?}"
            );
        }
        assert!(!findings
            .iter()
            .any(|finding| finding.detail.contains("cannot apply")));
    }

    #[test]
    fn review_integrity_checks_historical_fragment_structure_and_ordinal_bounds() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (_store, _) = seed(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE review_hunk SET after_json=?1, ordinal=7 WHERE state='accepted'",
            [r#"[{"kind":"open"},{"kind":"open"}]"#],
        )
        .unwrap();
        let issues = validate(&conn, 17);
        assert!(issues
            .iter()
            .any(|issue| issue.detail.contains("inconsistent ranges")));
        assert!(issues.iter().any(|issue| issue.detail.contains("ordinals")));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn review_integrity_handles_missing_tables_and_schema16_without_migration() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (store, _) = seed(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("DROP TABLE review_message").unwrap();
        assert!(
            validate(&conn, 17)
                .iter()
                .any(|finding| finding.kind == UNREADABLE
                    && finding.detail.contains("review_message"))
        );
        conn.execute_batch("DROP TABLE review_hunk; DROP TABLE review_group; DROP TABLE review_author; PRAGMA user_version=16;").unwrap();
        drop(conn);
        drop(store);
        let before = std::fs::read(&path).unwrap();
        let inspection = crate::cli::inspect(&path).unwrap();
        assert_eq!(inspection.review.hunks, 0);
        assert!(crate::cli::validate(&path).unwrap().ok);
        assert_eq!(
            Store::open_readonly(&path).unwrap().user_version().unwrap(),
            16
        );
        let salvage = crate::salvage::salvage(&path, &dir.path().join("old-schema")).unwrap();
        assert!(salvage.review.is_none());
        assert_eq!(salvage.review_recovered.hunks, 0);
        assert!(salvage.complete, "{:?}", salvage.losses);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn lowered_schema_header_cannot_hide_retained_review_rows_from_inspection_or_backup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (store, _) = seed(&path);
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA user_version=16")
            .unwrap();
        let inspected = crate::cli::inspect(&path).unwrap();
        assert_eq!(inspected.schema_version, 16);
        assert_eq!(
            (
                inspected.review.authors,
                inspected.review.groups,
                inspected.review.hunks
            ),
            (2, 4, 4)
        );
        let validation = crate::cli::validate(&path).unwrap();
        assert!(!validation.ok);
        assert!(validation
            .findings
            .iter()
            .any(|finding| finding
                .detail
                .contains("review tables exist below schema version 17")));
        let bundle = dir.path().join("mismarked.point");
        let written = crate::backup_bundle::write(&path, &store, &bundle).unwrap();
        assert!(!written.database_verified);
        assert!(!written.verified);
        assert!(crate::backup_bundle::verify_database_for_restore(&bundle).is_err());
    }
}
