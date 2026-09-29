//! Shared partial row-id enumeration for validation and salvage.

use std::collections::HashSet;

/// Every rowid in `table`, plus a loss if either enumeration stopped.
///
/// ROWIDS, not rows. The rowid is the b-tree cell's key, so enumerating it
/// touches the least of a page that a corrupt payload could kill. When the
/// covering index fails, scan the table b-tree too. Both scans keep their
/// partial reads, and a row found by both is fetched only once.
pub(crate) fn rowids(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<(Vec<i64>, Option<String>), String> {
    let (mut out, first_error) = scan_rowids(conn, &format!("SELECT rowid FROM {table}"));
    let Some(first_error) = first_error else {
        return Ok((out, None));
    };
    let first_count = out.len();
    let (from_table, table_error) =
        scan_rowids(conn, &format!("SELECT rowid FROM {table} NOT INDEXED"));
    if out.is_empty() && from_table.is_empty() {
        if let Some(table_error) = &table_error {
            return Err(format!(
                "index scan failed ({first_error}); table scan failed ({table_error})"
            ));
        }
    }
    let mut seen: HashSet<i64> = out.iter().copied().collect();
    for id in from_table {
        if seen.insert(id) {
            out.push(id);
        }
    }
    let detail = match table_error {
        Some(e) => format!(
            "reading {table} through its index stopped after {first_count} row(s): {first_error}; \
             the table scan also stopped ({e}); rows neither scan reached may be missing"
        ),
        None => format!(
            "reading {table} through its index stopped after {first_count} row(s): {first_error}; \
             the table scan recovered the rowids it could read"
        ),
    };
    Ok((out, Some(detail)))
}

/// Keep rowids returned before a cursor error, including one during iteration.
/// A failed prepare or first query returns an empty prefix and the error.
pub(crate) fn scan_rowids(conn: &rusqlite::Connection, sql: &str) -> (Vec<i64>, Option<String>) {
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(e) => return (Vec::new(), Some(e.to_string())),
    };
    let rows = match stmt.query_map([], |r| r.get::<_, i64>(0)) {
        Ok(rows) => rows,
        Err(e) => return (Vec::new(), Some(e.to_string())),
    };
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(id) => out.push(id),
            Err(e) => return (out, Some(e.to_string())),
        }
    }
    (out, None)
}
