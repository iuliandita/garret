use super::*;
use crate::figures::tests::{body, fixture};

#[test]
fn legacy_unknown_marks_remain_readable_without_a_registry() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("legacy.db");
    let store = Store::open(&db).unwrap();
    let item = store.item_create(None, "scene", "Legacy").unwrap();
    let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Legacy prose","marks":[{"type":"future-mark"}]}]}]}"#;
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("UPDATE doc SET body=?1", [body]).unwrap();
    let point = root.path().join("legacy.point");
    let result = backup_bundle::write(&db, &store, &point).unwrap();
    assert!(result.verified, "{:?}", result.errors);
    let out = root.path().join("salvage");
    let result = crate::salvage::salvage(&db, &out).unwrap();
    assert!(result.raw_bodies.is_empty());
    assert!(
        fs::read_to_string(out.join("documents").join(format!("{}.md", item.id)))
            .unwrap()
            .contains("Legacy prose")
    );
}

#[test]
fn named_snapshot_figure_links_resolve_inside_the_salvage() {
    let f = fixture();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    conn.execute(
        "INSERT INTO snapshot(label,created_at) VALUES('Figure',100)",
        [],
    )
    .unwrap();
    let snapshot = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO blob(key,body) VALUES('named-figure',?1)",
        [body(&f.assets[0])],
    )
    .unwrap();
    conn.execute("INSERT INTO doc_version(item_id,blob_key,created_at,words,snapshot_id) VALUES(?1,'named-figure',100,0,?2)", rusqlite::params![f.items[0],snapshot]).unwrap();
    let out = f.root.path().join("salvage");
    crate::salvage::salvage(&f.db, &out).unwrap();
    let doc = out
        .join("snapshots")
        .join(snapshot.to_string())
        .join(format!("{}.md", f.items[0]));
    let text = fs::read_to_string(&doc).unwrap();
    let link = text
        .lines()
        .find_map(|line| {
            line.strip_prefix("[Original](")
                .and_then(|s| s.strip_suffix(')'))
        })
        .unwrap();
    assert_eq!(
        fs::read(doc.parent().unwrap().join(link)).unwrap(),
        tests::PNG
    );
    assert!(doc
        .parent()
        .unwrap()
        .join(link)
        .canonicalize()
        .unwrap()
        .starts_with(out.canonicalize().unwrap()));
}

#[test]
fn salvage_keeps_corrupt_original_bytes_and_the_recorded_hash() {
    let f = fixture();
    let asset = &f.assets[2];
    fs::write(
        pictures::dir_for(&f.db).join(&asset.stored_name),
        b"damaged original",
    )
    .unwrap();
    let out = f.root.path().join("salvage");
    let result = crate::salvage::salvage(&f.db, &out).unwrap();
    assert_eq!(
        fs::read(out.join("pictures").join(&asset.stored_name)).unwrap(),
        b"damaged original"
    );
    assert_eq!(result.figure_originals_recovered, 4);
    let diagnostic = result
        .losses
        .iter()
        .find(|l| l.kind == "corrupt_figure_original")
        .unwrap();
    assert!(diagnostic.detail.contains(&format!("figure {}:", asset.id)));
    assert!(diagnostic.detail.contains(&asset.sha256));
}

#[cfg(unix)]
#[test]
fn unreadable_directory_listing_does_not_abort_registered_original_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let dir = pictures::dir_for(&f.db);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o111)).unwrap();
    assert_eq!(
        fs::read_dir(&dir).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let out = f.root.path().join("salvage");
    let result = crate::salvage::salvage(&f.db, &out);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    let result = result.unwrap();
    assert_eq!(result.figure_originals_recovered, 4);
    assert!(result
        .losses
        .iter()
        .any(|l| l.kind == "unreadable_figure_directory"));
    assert!(out.join("manuscript.md").is_file());
}

#[test]
fn figure_copies_do_not_share_mutable_bytes_on_any_platform() {
    let f = fixture();
    let dir = pictures::dir_for(&f.db);
    fs::write(dir.join(&f.assets[0].stored_name), b"changed first copy").unwrap();
    assert_eq!(
        fs::read(dir.join(&f.assets[1].stored_name)).unwrap(),
        tests::PNG
    );
    assert_eq!(
        fs::read(f.root.path().join("selected.png")).unwrap(),
        tests::PNG
    );
}

#[test]
fn cast_assignment_refuses_figure_ownership() {
    let f = fixture();
    let member = f.store.cast_create("character", "Ada").unwrap();
    assert_eq!(
        f.store
            .cast_set_picture(&member.id, Some(&f.assets[0].stored_name))
            .unwrap_err()
            .to_string(),
        "project structure is corrupt: figure originals cannot be assigned to cast pictures"
    );
    assert_eq!(f.store.cast_all().unwrap()[0].picture_path, None);
}

#[test]
fn cover_assignment_refuses_figure_ownership() {
    let f = fixture();
    assert_eq!(
        crate::covers::set_cover(
            &f.store,
            crate::covers::SIDE_FRONT,
            &f.assets[0].stored_name
        )
        .unwrap_err(),
        "figure originals cannot be assigned to covers"
    );
    assert_eq!(
        crate::covers::cover_of(&f.store, crate::covers::SIDE_FRONT).unwrap(),
        None
    );
}

#[test]
fn cast_attachment_bytes_are_independent_of_registered_figures() {
    let f = fixture();
    let dir = pictures::dir_for(&f.db);
    let cast = pictures::attach(&dir, &f.root.path().join("selected.png")).unwrap();
    fs::write(dir.join(cast), b"changed cast attachment").unwrap();
    for asset in &f.assets {
        assert_eq!(fs::read(dir.join(&asset.stored_name)).unwrap(), tests::PNG);
    }
}

#[test]
fn history_only_missing_mapping_keeps_legacy_pictures_and_reports_the_figure() {
    let f = fixture();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    crate::store::figure_assets::test_support::allow_corruption(&conn);
    conn.execute("DELETE FROM figure_asset WHERE id=?1", [&f.assets[2].id])
        .unwrap();
    let member = f.store.cast_create("character", "Ada").unwrap();
    f.store
        .cast_set_picture(&member.id, Some("legacy.png"))
        .unwrap();
    crate::covers::set_cover(&f.store, crate::covers::SIDE_FRONT, "legacy.png").unwrap();
    fs::write(pictures::dir_for(&f.db).join("legacy.png"), tests::PNG).unwrap();
    let bundle = f.root.path().join("incomplete.point");
    let result = backup_bundle::write(&f.db, &f.store, &bundle).unwrap();
    assert!(!result.verified);
    assert!(result.database_verified);
    assert!(
        result.errors.iter().any(|error| error.contains(&format!(
            "asset {} has no readable registry mapping",
            f.assets[2].id
        ))),
        "{:?}",
        result.errors
    );
    assert_eq!(
        fs::read(bundle.join(backup_bundle::PICTURES_NAME).join("legacy.png")).unwrap(),
        tests::PNG
    );
}

#[test]
fn unreadable_registry_row_is_a_gap_and_keeps_other_originals() {
    let f = fixture();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    crate::store::figure_assets::test_support::allow_corruption(&conn);
    conn.execute(
        "UPDATE figure_asset SET bytes='unreadable' WHERE id=?1",
        [&f.assets[2].id],
    )
    .unwrap();
    let point = f.root.path().join("incomplete.point");
    let written = backup_bundle::write(&f.db, &f.store, &point).unwrap();
    assert!(written.database_verified);
    let target = f.root.path().join("restored.db");
    fs::copy(backup_bundle::db_path(&point), &target).unwrap();
    fs::create_dir(pictures::dir_for(&target)).unwrap();
    crate::research::private_dir(&crate::research::dir_for(&target)).unwrap();
    let gaps = backup_bundle::copy_assets_with_gaps(&point, &target).unwrap();
    assert!(
        gaps.iter().any(|gap| gap.contains(&format!(
            "figure {}: unreadable registry record",
            f.assets[2].id
        ))),
        "{gaps:?}"
    );
    for i in [0, 1, 3] {
        assert_eq!(
            fs::read(pictures::dir_for(&target).join(&f.assets[i].stored_name)).unwrap(),
            tests::PNG
        );
    }
}

#[test]
fn proposed_sql_enforces_registry_integrity_and_immutability() {
    let f = fixture();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    for sql in [
        "UPDATE figure_asset SET bytes=bytes",
        "DELETE FROM figure_asset",
    ] {
        assert_eq!(
            conn.execute(sql, []).unwrap_err().to_string(),
            "figure registry rows are immutable"
        );
    }
    for (column, invalid) in [
        (0, "''"),
        (1, "''"),
        (2, "''"),
        (3, "0"),
        (3, "16777217"),
        (4, "''"),
        (4, "'invalid'"),
        (5, "0"),
        (5, "50000001"),
        (5, "50000000"),
        (6, "0"),
        (7, "0"),
    ] {
        let mut fields = [
            "?1",
            "?2",
            "mime",
            "bytes",
            "sha256",
            "width_px",
            "height_px",
            "orientation",
        ];
        fields[column] = invalid;
        let id = uuid::Uuid::now_v7().to_string();
        let sql = format!(
            "INSERT INTO figure_asset SELECT {} FROM figure_asset LIMIT 1",
            fields.join(",")
        );
        let mut statement = conn.prepare(&sql).unwrap();
        // Bind only placeholders present in this deliberate invalid row.
        if column != 0 {
            statement
                .raw_bind_parameter(statement.parameter_index("?1").unwrap().unwrap(), &id)
                .unwrap();
        }
        if column != 1 {
            statement
                .raw_bind_parameter(
                    statement.parameter_index("?2").unwrap().unwrap(),
                    format!("fig-{id}.png"),
                )
                .unwrap();
        }
        assert!(
            statement
                .raw_execute()
                .unwrap_err()
                .to_string()
                .contains("CHECK constraint failed"),
            "{sql}"
        );
    }
    assert_eq!(f.store.figure_assets().unwrap(), f.assets);
}
