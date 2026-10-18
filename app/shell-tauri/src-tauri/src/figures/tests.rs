use super::*;
use crate::{
    covers, research,
    store::{document_format, figure_assets, Store},
};
use std::path::PathBuf;

pub(crate) const PNG: &[u8] = include_bytes!("../../fixtures/two-halves.png");

pub(crate) struct Fixture {
    pub root: tempfile::TempDir,
    pub db: PathBuf,
    pub store: Store,
    pub assets: Vec<FigureAsset>,
    pub items: Vec<String>,
}

pub(crate) fn body(asset: &FigureAsset) -> String {
    serde_json::json!({"type":"doc","content":[{"type":"figure","attrs":{
        "id":uuid::Uuid::now_v7().to_string(),"asset_id":asset.id,"width":"full","caption":"caption text","alt":"alt text"
    }}]}).to_string()
}

pub(crate) fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = crate::store::historical_test_store(&db, 17);
    store.set_meta("name", "Figures").unwrap();
    figure_assets::test_support::install(&store);
    let source = root.path().join("selected.png");
    fs::write(&source, PNG).unwrap();
    let assets: Vec<_> = (0..4)
        .map(|_| test_support::import(&db, &store, &source))
        .collect();
    let bin = store
        .item_create(None, crate::store::TRASH_TYPE, "Bin")
        .unwrap();
    let mut items = Vec::new();
    for (i, asset) in assets[..3].iter().enumerate() {
        let item = store
            .item_create(if i == 1 { Some(&bin.id) } else { None }, "scene", "Scene")
            .unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        if i < 2 {
            conn.execute(
                "UPDATE doc SET body=?1 WHERE item_id=?2",
                rusqlite::params![body(asset), item.id],
            )
            .unwrap();
        } else {
            conn.execute(
                "INSERT INTO blob (key,body) VALUES ('automatic-figure',?1)",
                [body(asset)],
            )
            .unwrap();
            conn.execute("INSERT INTO doc_version (item_id,blob_key,created_at,words,snapshot_id) VALUES (?1,'automatic-figure',100,0,NULL)", [&item.id]).unwrap();
        }
        items.push(item.id);
    }
    Fixture {
        root,
        db,
        store,
        assets,
        items,
    }
}

#[test]
fn activation_migration_preserves_prose_history_and_states() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = crate::store::historical_test_store(&db, 17);
    let item = store.item_create(None, "scene", "Scene").unwrap();
    store.item_set_state(&item.id, Some("draft"), item.rev).unwrap();
    let before = store.load_doc(&item.id).unwrap();
    let snapshot = store.snapshot_create("Keep").unwrap();
    assert!(!store.figure_registry().unwrap().present);
    drop(store);
    let store = Store::open_existing(&db).unwrap();
    assert_eq!(store.user_version().unwrap(), 18);
    assert_eq!(crate::store::SCHEMA_VERSION, 18);
    assert!(document_format::new_nodes_allowed());
    assert_eq!(store.load_doc(&item.id).unwrap().body, before.body);
    assert_eq!(store.items().unwrap()[0].state.as_deref(), Some("draft"));
    assert_eq!(store.snapshots().unwrap()[0].id, snapshot.id);
    assert!(store.figure_registry().unwrap().present);
    assert!(store.figure_assets().unwrap().is_empty());
    drop(store);
    assert_eq!(Store::open_existing(&db).unwrap().user_version().unwrap(), 18);
}

#[test]
fn figure_names_are_strict_and_registration_is_disabled_before_any_file_write() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = crate::store::historical_test_store(&db, 17);
    assert!(store.figure_assets().unwrap().is_empty());
    let good = "fig-019b1234-5678-7abc-8def-123456789abc.png";
    assert!(figure_assets::is_figure_name(good));
    for bad in [
        "fig-../x.png",
        "fig-019b1234-5678-7abc-0def-123456789abc.png",
        "fig-019b1234-5678-4abc-8def-123456789abc.png",
        "fig-019B1234-5678-7abc-8def-123456789abc.png",
        "fig-019b1234-5678-7abc-8def-123456789abc.thumb.png",
        "x.png",
    ] {
        assert!(!figure_assets::is_figure_name(bad), "{bad}");
    }
    let source = root.path().join("photo.png");
    fs::write(&source, PNG).unwrap();
    assert_eq!(
        authoring_allowed(&store).unwrap_err(),
        "figure registration is disabled"
    );
    assert!(!pictures::dir_for(&db).exists());
    assert_eq!(store.user_version().unwrap(), 17);
    let conn = rusqlite::Connection::open(&db).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='figure_asset'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn same_byte_cast_and_cover_removal_preserves_independent_figure_bytes() {
    let f = fixture();
    let dir = pictures::dir_for(&f.db);
    let source = f.root.path().join("selected.png");
    let cast_name = pictures::attach(&dir, &source).unwrap();
    let cover_name = pictures::attach(&dir, &source).unwrap();
    let member = f.store.cast_create("character", "Ada").unwrap();
    f.store
        .cast_set_picture(&member.id, Some(&cast_name))
        .unwrap();
    covers::set_cover(&f.store, covers::SIDE_FRONT, &cover_name).unwrap();
    for asset in &f.assets {
        assert_eq!(
            f.store
                .cast_set_picture(&member.id, Some(&asset.stored_name))
                .unwrap_err()
                .to_string(),
            "project structure is corrupt: figure originals cannot be assigned to cast pictures"
        );
        assert_eq!(
            covers::set_cover(&f.store, covers::SIDE_FRONT, &asset.stored_name).unwrap_err(),
            "figure originals cannot be assigned to covers"
        );
        pictures::remove(&dir, &asset.stored_name);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(
                fs::metadata(dir.join(&asset.stored_name)).unwrap().ino(),
                fs::metadata(dir.join(&cast_name)).unwrap().ino()
            );
        }
    }
    f.store.cast_set_picture(&member.id, None).unwrap();
    pictures::remove(&dir, &cast_name);
    let previous = covers::clear_cover(&f.store, covers::SIDE_FRONT)
        .unwrap()
        .unwrap();
    pictures::remove(&dir, &previous);
    fs::write(&source, b"source replaced").unwrap();
    for asset in &f.assets {
        assert_eq!(fs::read(dir.join(&asset.stored_name)).unwrap(), PNG);
        assert_eq!(asset.sha256, format!("{:x}", Sha256::digest(PNG)));
        assert_eq!(asset.orientation, 1);
        assert_eq!((asset.width_px, asset.height_px), (6, 4));
        assert_eq!(asset.mime, "image/png");
        assert_eq!(asset.bytes, PNG.len() as u64);
    }
}

#[test]
fn failed_registration_keeps_original_for_salvage_and_never_reuses_it() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let source = root.path().join("selected.png");
    fs::write(&source, PNG).unwrap();
    let mut failed = None;
    assert_eq!(
        import_original(&db, &source, |asset| {
            assert_eq!(
                fs::read(pictures::dir_for(&db).join(&asset.stored_name)).unwrap(),
                PNG
            );
            failed = Some(asset.clone());
            Err("database refused".into())
        })
        .unwrap_err(),
        "database refused"
    );
    let failed = failed.unwrap();
    let next = import_original(&db, &source, |_| Ok(())).unwrap();
    assert_ne!(failed.id, next.id);
    assert_eq!(
        fs::read(pictures::dir_for(&db).join(failed.stored_name)).unwrap(),
        PNG
    );
}

#[test]
fn inventory_keeps_live_bin_automatic_history_and_abandoned_originals() {
    let f = fixture();
    assert_eq!(
        f.store
            .register_figure_asset(&f.assets[0])
            .unwrap_err()
            .to_string(),
        "document format refused: figure registration is disabled; nothing was changed"
    );
    let bundle = f.root.path().join("complete.point");
    let result = backup_bundle::write(&f.db, &f.store, &bundle).unwrap();
    assert!(result.verified, "{:?}", result.errors);
    for asset in &f.assets {
        assert_eq!(
            fs::read(
                bundle
                    .join(backup_bundle::PICTURES_NAME)
                    .join(&asset.stored_name)
            )
            .unwrap(),
            PNG
        );
    }
    let dest = f.root.path().join("copied.db");
    fs::copy(backup_bundle::db_path(&bundle), &dest).unwrap();
    fs::create_dir(pictures::dir_for(&dest)).unwrap();
    research::private_dir(&research::dir_for(&dest)).unwrap();
    backup_bundle::copy_assets(&bundle, &dest).unwrap();
    for asset in &f.assets {
        verify_original(&pictures::dir_for(&dest).join(&asset.stored_name), asset).unwrap();
    }
    // This same-byte mutation is invisible to byte-count-only checks.
    let mut changed = PNG.to_vec();
    changed[20] ^= 1;
    fs::write(
        pictures::dir_for(&f.db).join(&f.assets[2].stored_name),
        changed,
    )
    .unwrap();
    let bad = backup_bundle::write(&f.db, &f.store, &f.root.path().join("changed.point")).unwrap();
    assert!(!bad.verified);
    assert!(
        bad.errors
            .iter()
            .any(|e| e.contains("figure") && e.contains("mismatch")),
        "{:?}",
        bad.errors
    );
}

#[test]
fn deleting_a_history_only_original_fails_completeness_and_partial_copy_names_it() {
    let f = fixture();
    let missing = &f.assets[2];
    fs::remove_file(pictures::dir_for(&f.db).join(&missing.stored_name)).unwrap();
    let bundle = f.root.path().join("missing.point");
    let result = backup_bundle::write(&f.db, &f.store, &bundle).unwrap();
    assert!(!result.verified, "history-only originals must be required");
    assert!(result.database_verified);
    assert!(result
        .errors
        .iter()
        .any(|e| e.contains(&missing.stored_name)));
    assert!(backup_bundle::verify(&bundle)
        .unwrap_err()
        .contains(&format!("figure {}:", missing.id)));
    let dest = f.root.path().join("partial.db");
    fs::copy(backup_bundle::db_path(&bundle), &dest).unwrap();
    fs::create_dir(pictures::dir_for(&dest)).unwrap();
    research::private_dir(&research::dir_for(&dest)).unwrap();
    let gaps = backup_bundle::copy_assets_with_gaps(&bundle, &dest).unwrap();
    assert!(gaps.iter().any(|gap| gap.contains(&missing.stored_name)));
    assert!(!pictures::dir_for(&dest).join(&missing.stored_name).exists());
    assert!(pictures::dir_for(&dest)
        .join(&f.assets[0].stored_name)
        .exists());
}

#[test]
fn unreadable_or_unregistered_retained_references_never_enumerate_as_empty() {
    for (sql, parameter, refusal) in [
        (
            "UPDATE doc SET body=?1 WHERE item_id IN (SELECT item_id FROM doc LIMIT 1)",
            "{broken",
            "unreadable references in item",
        ),
        (
            "UPDATE blob SET body=?1 WHERE key='automatic-figure'",
            "{broken",
            "unreadable references in item",
        ),
        (
            "UPDATE blob SET body=?1 WHERE key='automatic-figure'",
            r#"{"type":"doc","content":[{"type":"figure","attrs":{"id":"missing-instance","asset_id":"missing-asset"}}]}"#,
            "figure missing-instance: asset missing-asset has no readable registry mapping",
        ),
        (
            "UPDATE figure_asset SET sha256=?1",
            "bad hash",
            "invalid registry record",
        ),
        (
            "UPDATE figure_asset SET stored_name=?1 WHERE id=(SELECT id FROM figure_asset LIMIT 1)",
            "../escape.png",
            "invalid registry record",
        ),
        (
            "DELETE FROM blob WHERE key=?1",
            "automatic-figure",
            "unreadable references in item",
        ),
        (
            "DELETE FROM figure_asset WHERE id=?1",
            "history-id",
            "has no readable registry mapping",
        ),
    ] {
        let f = fixture();
        let conn = rusqlite::Connection::open(&f.db).unwrap();
        figure_assets::test_support::allow_corruption(&conn);
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        conn.execute(
            sql,
            [if parameter == "history-id" {
                f.assets[2].id.as_str()
            } else {
                parameter
            }],
        )
        .unwrap();
        let member = f.store.cast_create("character", "Ada").unwrap();
        f.store
            .cast_set_picture(&member.id, Some("cast.png"))
            .unwrap();
        covers::set_cover(&f.store, covers::SIDE_FRONT, "cover.png").unwrap();
        for name in ["cast.png", "cover.png"] {
            fs::write(pictures::dir_for(&f.db).join(name), PNG).unwrap();
        }
        let result =
            backup_bundle::write(&f.db, &f.store, &f.root.path().join("broken.point")).unwrap();
        assert!(!result.verified, "{sql}");
        assert!(
            result.errors.iter().any(|e| e.contains(refusal)),
            "{sql}: {:?}",
            result.errors
        );
        for name in ["cast.png", "cover.png"] {
            assert_eq!(
                fs::read(
                    f.root
                        .path()
                        .join("broken.point")
                        .join(backup_bundle::PICTURES_NAME)
                        .join(name)
                )
                .unwrap(),
                PNG
            );
        }
    }
}

#[test]
fn salvage_keeps_history_only_and_uncertain_originals_and_renders_readable_fields() {
    let f = fixture();
    let original = &f.assets[0];
    let note_body = serde_json::json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"Prose"},{"type":"endnote","attrs":{"id":uuid::Uuid::now_v7().to_string(),"fmt":"text","body":"note body\nsecond line"}}]},
        {"type":"figure","attrs":{"id":uuid::Uuid::now_v7().to_string(),"asset_id":original.id,"width":"half","caption":"caption retained","alt":"alt retained"}},
        {"type":"scene_break"}
    ]}).to_string();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    conn.execute(
        "UPDATE doc SET body=?1 WHERE item_id=?2",
        rusqlite::params![note_body, f.items[0]],
    )
    .unwrap();
    let uncertain = import_original(&f.db, &f.root.path().join("selected.png"), |_| {
        Err("not registered".into())
    });
    assert_eq!(uncertain.unwrap_err(), "not registered");
    let out = f.root.path().join("salvage");
    let result = crate::salvage::salvage(&f.db, &out).unwrap();
    assert_eq!(result.versions_dropped, 1);
    for asset in &f.assets {
        assert_eq!(
            fs::read(out.join("pictures").join(&asset.stored_name)).unwrap(),
            PNG
        );
    }
    assert_eq!(fs::read_dir(out.join("pictures")).unwrap().count(), 5);
    let doc = fs::read_to_string(out.join("documents").join(format!("{}.md", f.items[0]))).unwrap();
    for text in [
        "Prose",
        "note body",
        "second line",
        "caption retained",
        "alt retained",
        "../pictures/",
        "---",
    ] {
        assert!(doc.contains(text), "missing {text}: {doc}");
    }
    let mut translated_losses = Vec::new();
    let figure_assets = crate::figure_salvage::registry(&conn, &mut translated_losses);
    let german = crate::figure_salvage::document_markdown(
        &figure_assets,
        &note_body,
        &f.items[0],
        "..",
        crate::strings::Strings::new(&crate::strings::DE),
        &mut translated_losses,
    )
    .unwrap();
    assert!(german.contains("Abbildung "));
    assert!(german.contains("Alternativtext: alt retained"));
    assert!(!german.contains('⟦'));
    let manuscript = fs::read_to_string(out.join("manuscript.md")).unwrap();
    for text in ["note body", "caption retained", "alt retained"] {
        assert!(manuscript.contains(text));
    }
    assert_eq!(result.figure_assets_recovered, 4);
    assert_eq!(result.figure_originals_recovered, 5);
    let registry: Vec<FigureAsset> =
        serde_json::from_slice(&fs::read(out.join(result.figures.as_ref().unwrap())).unwrap())
            .unwrap();
    assert_eq!(registry, f.assets);
    assert!(result
        .losses
        .iter()
        .any(|l| l.kind == "document_structure_flattened"));
    assert!(result
        .losses
        .iter()
        .any(|l| l.kind == "unregistered_figure_original"));
    // Unknown formats must survive verbatim, never pass the permissive legacy renderer.
    let mut value: serde_json::Value = serde_json::from_str(&note_body).unwrap();
    value["content"][0]["content"][1]["attrs"]["fmt"] = "future".into();
    let raw = value.to_string();
    conn.execute(
        "UPDATE doc SET body=?1 WHERE item_id=?2",
        rusqlite::params![raw, f.items[0]],
    )
    .unwrap();
    let second = f.root.path().join("raw-salvage");
    let result = crate::salvage::salvage(&f.db, &second).unwrap();
    let relative = result.renamed.get(&f.items[0]).unwrap();
    assert_eq!(
        fs::read_to_string(second.join("documents").join(relative)).unwrap(),
        raw
    );
    assert!(result.raw_bodies.contains(&f.items[0]));
}

#[test]
fn exif_orientation_is_retained_and_invalid_images_never_publish() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let source = root.path().join("photo.any");
    let jpeg = include_bytes!("../../fixtures/two-halves.jpg");
    for value in 1u8..=8 {
        let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend([value, 0, 0, 0, 0, 0, 0, 0]);
        let mut data = jpeg[..2].to_vec();
        data.extend([0xff, 0xe1]);
        data.extend(((exif.len() + 2) as u16).to_be_bytes());
        data.extend(exif);
        data.extend(&jpeg[2..]);
        fs::write(&source, &data).unwrap();
        let asset = import_original(&db, &source, |_| Ok(())).unwrap();
        assert_eq!(asset.orientation, value);
        assert_eq!(asset.mime, "image/jpeg");
        assert_eq!(
            fs::read(pictures::dir_for(&db).join(asset.stored_name)).unwrap(),
            data
        );
    }
    let count = fs::read_dir(pictures::dir_for(&db)).unwrap().count();
    for (data, reason) in [
        (b"not an image".as_slice(), "not a PNG or a JPEG"),
        (
            include_bytes!("../../fixtures/declares-a-bomb.png").as_slice(),
            "largest this book will read",
        ),
    ] {
        fs::write(&source, data).unwrap();
        assert!(import_original(&db, &source, |_| Ok(()))
            .unwrap_err()
            .contains(reason));
        assert_eq!(fs::read_dir(pictures::dir_for(&db)).unwrap().count(), count);
    }
}

#[test]
fn encrypted_archives_and_owned_transfer_copies_keep_registered_originals() {
    let f = fixture();
    let bundle = f.root.path().join("transfer.point");
    assert!(
        backup_bundle::write(&f.db, &f.store, &bundle)
            .unwrap()
            .verified
    );
    let key = age::x25519::Identity::generate();
    let cipher = f.root.path().join("portable.age");
    crate::encrypted_archive::create_from_bundle(&bundle, &cipher, &key, f.root.path()).unwrap();
    let stage = f.root.path().join("extract");
    fs::create_dir(&stage).unwrap();
    let extracted =
        crate::encrypted_archive::extract_verified_bundle(&cipher, &key, &stage).unwrap();
    for asset in &f.assets {
        verify_original(
            &extracted
                .join(backup_bundle::PICTURES_NAME)
                .join(&asset.stored_name),
            asset,
        )
        .unwrap();
    }
    let library = f.root.path().join("library");
    let error = crate::projects::restore_point_into(&bundle, &library, "copy", 1_700_000_000_000)
        .err()
        .unwrap();
    assert!(
        error.contains("document format refused:")
            && error.contains("new document nodes are disabled"),
        "{error}"
    );
    assert!(
        !library.exists(),
        "disabled-node restore must refuse before publication"
    );
    let error = crate::transfer_copy::inspect(&bundle).unwrap_err();
    assert!(
        error.contains("document format refused:")
            && error.contains("new document nodes are disabled"),
        "{error}"
    );
    // Registry-only books exercise the existing owned-copy path while new-node
    // publication remains disabled.
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    conn.execute("UPDATE doc SET body=?1", [r#"{"type":"doc","content":[]}"#])
        .unwrap();
    conn.execute("DELETE FROM doc_version", []).unwrap();
    conn.pragma_update(None, "user_version", 18).unwrap();
    let legacy = f.root.path().join("registry-only.point");
    assert!(
        backup_bundle::write(&f.db, &f.store, &legacy)
            .unwrap()
            .verified
    );
    let preview = crate::transfer_copy::inspect(&legacy).unwrap();
    let owned = crate::transfer_copy::stage(&legacy, f.root.path(), &preview).unwrap();
    for asset in &f.assets {
        verify_original(
            &pictures::dir_for(&owned.database).join(&asset.stored_name),
            asset,
        )
        .unwrap();
    }
    assert_eq!(
        Store::open_readonly(&owned.database)
            .unwrap()
            .figure_assets()
            .unwrap(),
        f.assets
    );
}

#[test]
fn recovery_points_and_moves_retain_all_registered_originals() {
    let f = fixture();
    let recovery = f.root.path().join("recovery");
    let point = crate::recovery::take_point(&f.db, "book", "Figures", &recovery, 1_700_000_000_000)
        .unwrap();
    assert!(point.verified);
    let point_path = backup_bundle::path_for(&recovery, &point.id);
    for asset in &f.assets {
        verify_original(
            &point_path
                .join(backup_bundle::PICTURES_NAME)
                .join(&asset.stored_name),
            asset,
        )
        .unwrap();
    }
    f.store.checkpoint().unwrap();
    drop(f.store);
    let moved_dir = f.root.path().join("moved");
    fs::create_dir(&moved_dir).unwrap();
    let moved = moved_dir.join("book.db");
    crate::projects::move_book_files(&f.db, &moved).unwrap();
    assert!(!f.db.exists());
    assert_eq!(
        Store::open_readonly(&moved)
            .unwrap()
            .figure_assets()
            .unwrap(),
        f.assets
    );
    for asset in &f.assets {
        verify_original(&pictures::dir_for(&moved).join(&asset.stored_name), asset).unwrap();
    }
    // Verification reads the captured DB, regardless of subsequent live metadata.
    let conn = rusqlite::Connection::open(&moved).unwrap();
    figure_assets::test_support::allow_corruption(&conn);
    conn.execute("UPDATE figure_asset SET sha256='invalid'", [])
        .unwrap();
    backup_bundle::verify(&point_path).unwrap();
}

#[test]
fn named_history_salvage_keeps_readable_notes_and_raw_unknown_encodings() {
    let f = fixture();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    let value = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"endnote","attrs":{"id":uuid::Uuid::now_v7().to_string(),"fmt":"text","body":"named note body"}}]}]});
    conn.execute(
        "INSERT INTO snapshot(label,created_at) VALUES('Named',100)",
        [],
    )
    .unwrap();
    let snapshot = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO blob(key,body) VALUES('named-note',?1)",
        [value.to_string()],
    )
    .unwrap();
    conn.execute("INSERT INTO doc_version(item_id,blob_key,created_at,words,snapshot_id) VALUES(?1,'named-note',100,0,?2)", rusqlite::params![f.items[0], snapshot]).unwrap();
    let mut unknown = value.clone();
    unknown["content"][0]["content"][0]["attrs"]["fmt"] = "future".into();
    conn.execute(
        "INSERT INTO blob(key,body) VALUES('unknown-note',?1)",
        [unknown.to_string()],
    )
    .unwrap();
    conn.execute("INSERT INTO doc_version(item_id,blob_key,created_at,words,snapshot_id) VALUES(?1,'unknown-note',101,0,?2)", rusqlite::params![f.items[1], snapshot]).unwrap();
    let out = f.root.path().join("named-salvage");
    let result = crate::salvage::salvage(&f.db, &out).unwrap();
    assert_eq!(result.versions_dropped, 1);
    let named = out.join("snapshots").join(snapshot.to_string());
    assert!(fs::read_to_string(named.join(format!("{}.md", f.items[0])))
        .unwrap()
        .contains("named note body"));
    let raw = fs::read_dir(&named)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|ext| ext == "raw"))
        .unwrap();
    assert_eq!(fs::read_to_string(raw).unwrap(), unknown.to_string());
    assert!(result
        .losses
        .iter()
        .any(|l| l.kind == "unreadable_version_body"));
}
