use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, types::ValueRef, Connection};
use serde::Serialize;
use serde_json::{json, Value};

use crate::salvage::{rowids, Loss, KIND_ANALYTICS_ROW, KIND_TABLE};

pub(super) const NAME: &str = "analytics.json";
const TABLES: [&str; 6] = [
    "analytics_session",
    "analytics_segment",
    "analytics_minute",
    "analytics_movement",
    "analytics_adjustment",
    "analytics_category",
];

#[derive(Serialize)]
struct RecoveredRow {
    rowid: i64,
    values: BTreeMap<String, Value>,
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => {
            json!({ "sqlite_real_bits_hex": format!("{:016x}", number.to_bits()) })
        }
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => json!(text),
            Err(_) => json!({ "sqlite_text_hex": hex(bytes) }),
        },
        ValueRef::Blob(bytes) => json!({ "sqlite_blob_hex": hex(bytes) }),
    }
}

/// Preserve recoverable cells, including orphan rows, without interpreting a
/// damaged session as complete. The caller records this file in the manifest.
pub(super) fn recover(
    conn: &Connection,
    out_dir: &Path,
    losses: &mut Vec<Loss>,
) -> Result<String, String> {
    let mut tables = BTreeMap::<String, Vec<RecoveredRow>>::new();
    for table in TABLES {
        let ids = match rowids(conn, table) {
            Ok((ids, mut stopped)) => {
                losses.append(&mut stopped);
                ids
            }
            Err(error) => {
                losses.push(Loss {
                    kind: KIND_TABLE.into(),
                    detail: format!("the {table} table could not be read: {error}"),
                    item_id: None,
                });
                tables.insert(table.into(), Vec::new());
                continue;
            }
        };
        let mut stmt = match conn.prepare(&format!("SELECT * FROM {table} WHERE rowid=?1")) {
            Ok(stmt) => stmt,
            Err(error) => {
                losses.push(Loss {
                    kind: KIND_TABLE.into(),
                    detail: format!("the {table} table could not be prepared: {error}"),
                    item_id: None,
                });
                tables.insert(table.into(), Vec::new());
                continue;
            }
        };
        let columns: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|name| (*name).into())
            .collect();
        let mut recovered = Vec::new();
        for rowid in ids {
            let read = stmt.query_row(params![rowid], |row| {
                let mut values = BTreeMap::new();
                for (index, name) in columns.iter().enumerate() {
                    values.insert(name.clone(), value(row.get_ref(index)?));
                }
                Ok(RecoveredRow { rowid, values })
            });
            match read {
                Ok(row) => recovered.push(row),
                Err(error) => losses.push(Loss {
                    kind: KIND_ANALYTICS_ROW.into(),
                    detail: format!("row {rowid} of {table} could not be read: {error}"),
                    item_id: None,
                }),
            }
        }
        tables.insert(table.into(), recovered);
    }
    let output = json!({
        "format": "raw-analytics-v1",
        "note": "These are recoverable SQLite rows, not a complete or validated session history. See manifest.json and loss-report.txt for losses.",
        "tables": tables,
    });
    std::fs::write(
        out_dir.join(NAME),
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())? + "\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(NAME.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recover_keeps_raw_rows_and_reports_a_missing_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::store::analytics::SCHEMA_V15)
            .unwrap();
        conn.execute("INSERT INTO analytics_session(id,started_ms,start_day,start_offset_min,metric_version) VALUES('s',1,'2026-09-25',0,1)", []).unwrap();
        conn.execute("INSERT INTO analytics_segment(id,session_id,category_id,category_name,started_ms) VALUES('g','s','drafting','Drafting',1)", []).unwrap();
        conn.execute(
            "INSERT INTO analytics_adjustment(segment_id,excluded,changed_ms) VALUES('g',1,2)",
            [],
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut losses = Vec::new();
        assert_eq!(recover(&conn, dir.path(), &mut losses).unwrap(), NAME);
        assert!(losses.is_empty());
        let json: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(NAME)).unwrap()).unwrap();
        assert_eq!(json["tables"]["analytics_session"][0]["values"]["id"], "s");
        assert_eq!(
            json["tables"]["analytics_adjustment"][0]["values"]["excluded"],
            1
        );
        assert!(json["note"].as_str().unwrap().contains("not a complete"));
        conn.execute_batch("DROP TABLE analytics_category").unwrap();
        losses.clear();
        recover(&conn, dir.path(), &mut losses).unwrap();
        assert!(losses
            .iter()
            .any(|loss| loss.kind == KIND_TABLE && loss.detail.contains("analytics_category")));
    }
}
