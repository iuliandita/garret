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

/// The exact future schema installed only in disposable reader fixtures.
pub(crate) fn reader_fixture(path: &Path) -> (Store, String, String) {
    reader_fixture_with_image(path, include_bytes!("../../fixtures/two-halves.png"))
}

pub(crate) fn reader_fixture_with_image(path: &Path, image: &[u8]) -> (Store, String, String) {
    let store = Store::open(path).unwrap();
    let id = store.item_create(None, "scene", "Reader fixture").unwrap().id;
    figure_assets::test_support::install(&store);
    let selected = path.with_extension("png");
    std::fs::write(&selected, image).unwrap();
    let asset = crate::figures::test_support::import(path, &store, &selected);
    let body = serde_json::json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"Surrounding prose"},
        {"type":"endnote","attrs":{"id":"01900000-0000-7000-8000-000000000001","fmt":"text","body":"Retained note\nSecond line"}}]},
        {"type":"figure","attrs":{"id":"01900000-0000-7000-8000-000000000002","asset_id":asset.id,"width":"half","caption":"Retained caption","alt":"Retained alternative"}},
        {"type":"scene_break"}, {"type":"paragraph","content":[{"type":"text","text":"After break"}]}
    ]}).to_string();
    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![body, id]).unwrap();
    store.conn.pragma_update(None, "user_version", document_format::READ_SCHEMA_VERSION).unwrap();
    store.snapshot_create("Before reader edits").unwrap();
    (store, id, body)
}
