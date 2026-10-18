use super::*;

/// Copy fixture data into a historical schema without calling Store::open,
/// which would migrate it to the current version.
pub(crate) fn legacy_fixture(path: &Path, version: i64) {
    assert!((1..=9).contains(&version));
    let dir = tempfile::tempdir_in(path.parent().unwrap()).unwrap();
    let historical = dir.path().join("historical.db");
    let conn = historical_test_store(&historical, version).conn;
    conn.execute("ATTACH DATABASE ?1 AS source", [path.to_str().unwrap()])
        .unwrap();
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for table in tables {
        let columns: Vec<String> = conn
            .prepare(&format!("PRAGMA main.table_info(\"{table}\")"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|column| column.map(|name| format!("\"{name}\"")))
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let columns = columns.join(", ");
        conn.execute_batch(&format!(
            "INSERT INTO main.\"{table}\" ({columns}) SELECT {columns} FROM source.\"{table}\";"
        ))
        .unwrap();
    }
    conn.execute_batch("DELETE FROM meta WHERE key IN ('book_id', 'book_identity_origin');")
        .unwrap();
    conn.close().unwrap();
    std::fs::rename(historical, path).unwrap();
}
