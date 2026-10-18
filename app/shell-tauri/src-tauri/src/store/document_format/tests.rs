use super::*;
use crate::store::{FlushEntry, SCHEMA_VERSION};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Case {
    id: String,
    body: Value,
    assets: HashSet<String>,
    valid: bool,
    legacy: bool,
}

fn corpus() -> Vec<Case> {
    serde_json::from_str(include_str!(
        "../../../../../harness/fixtures/document-format.json"
    ))
    .unwrap()
}

fn new_bodies() -> Vec<String> {
    corpus()
        .into_iter()
        .filter(|f| ["endnote", "figure", "scene-break"].contains(&f.id.as_str()))
        .map(|f| f.body.to_string())
        .collect()
}

fn prose(text: &str) -> String {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
        .to_string()
}

fn entry(id: &str, rev: i64, body: &str) -> FlushEntry {
    FlushEntry {
        item_id: id.into(),
        base_rev: rev,
        body: body.into(),
        comments: None,
    }
}

fn setup(path: &std::path::Path) -> (Store, Vec<String>) {
    std::fs::create_dir_all(path.with_extension("pictures")).unwrap();
    std::fs::write(
        path.with_extension("pictures").join("retained.png"),
        b"retained picture",
    )
    .unwrap();
    std::fs::create_dir_all(path.with_extension("research")).unwrap();
    std::fs::write(
        path.with_extension("research").join("retained.pdf"),
        b"retained research",
    )
    .unwrap();
    let store = crate::store::historical_test_store(path, 17);
    let ids: Vec<String> = ["First", "Second"]
        .into_iter()
        .map(|title| store.item_create(None, "scene", title).unwrap().id)
        .collect();
    store
        .flush(&[
            entry(&ids[0], 1, &prose("First prose")),
            entry(&ids[1], 1, &prose("Second prose")),
        ])
        .unwrap();
    store
        .set_meta(crate::projects::DAY_BASELINE_KEY, "4")
        .unwrap();
    store
        .comment_create(&ids[0], "Keep this comment", 1, 3, "Fi")
        .unwrap();
    (store, ids)
}

fn state(store: &Store) -> Vec<String> {
    let mut result = vec![store.user_version().unwrap().to_string()];
    let db = std::path::Path::new(store.conn.path().unwrap());
    for extension in ["pictures", "research"] {
        let path = db.with_extension(extension);
        if path.exists() {
            let mut files: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            files.sort();
            for file in files {
                result.push(format!(
                    "{:?}: {:?}",
                    file.file_name().unwrap(),
                    std::fs::read(&file).unwrap()
                ));
            }
        }
    }
    let mut tables = store
        .conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap();
    let names: Vec<String> = tables
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    for name in names {
        let mut stmt = store
            .conn
            .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
            .unwrap();
        let columns = stmt.column_count();
        let rows = stmt
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                    .collect::<Vec<_>>())
            })
            .unwrap();
        result.push(name);
        for row in rows {
            result.push(format!("{:?}", row.unwrap()));
        }
    }
    result
}

fn refused<T>(result: Result<T>) {
    assert!(
        matches!(result, Err(StoreError::InvalidDocument(_))),
        "expected format refusal"
    );
}

#[test]
fn format_gate_shared_corpus() {
    assert_eq!(SCHEMA_VERSION, 18);
    let cases = corpus();
    assert!(cases.len() > 40);
    for case in cases {
        assert_eq!(
            validate(&case.body, true, &case.assets).is_ok(),
            case.valid,
            "{}",
            case.id
        );
        assert_eq!(
            validate(&case.body, false, &HashSet::new()).is_ok(),
            case.legacy,
            "{}",
            case.id
        );
    }
    let mut body = serde_json::from_str::<Value>(&new_bodies()[0]).unwrap();
    for (text, valid) in [
        ("é".repeat(MAX_ATTRIBUTE_BYTES / 2), true),
        ("é".repeat(MAX_ATTRIBUTE_BYTES / 2) + "a", false),
    ] {
        body["content"][0]["content"][1]["attrs"]["body"] = json!(text);
        assert_eq!(validate(&body, true, &HashSet::new()).is_ok(), valid);
    }
}

#[test]
fn format_retained_corpus_refuses_every_nonlegacy_document() {
    let cases: Vec<_> = corpus().into_iter().filter(|case| case.valid && !case.legacy).collect();
    assert!(!cases.is_empty());
    for case in cases {
        for history in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (store, ids) = setup(&dir.path().join("book.db"));
            if history {
                let snapshot = store.snapshot_create("Retained draft").unwrap();
                store.conn.execute("UPDATE blob SET body=?1 WHERE key=(SELECT blob_key FROM doc_version WHERE item_id=?2 AND snapshot_id=?3)",
                    rusqlite::params![case.body.to_string(), ids[1], snapshot.id]).unwrap();
            } else {
                store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2",
                    rusqlite::params![case.body.to_string(), ids[1]]).unwrap();
            }
            let before = state(&store);
            let error = store.validate_retained_formats().unwrap_err();
            assert!(matches!(error, StoreError::InvalidDocument(_)), "{}: {error}", case.id);
            assert!(error.to_string().contains(&ids[1]), "{}: {error}", case.id);
            assert_eq!(state(&store), before, "{} (history: {history})", case.id);
        }
    }
}

#[test]
fn format_gate_save_desktop_mobile_and_mirror_batches_store_nothing() {
    for body in new_bodies() {
        for path in ["save", "desktop", "mobile", "mirror"] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join("book.db");
            let (store, ids) = setup(&db);
            let entries = [
                entry(&ids[0], 2, &prose("Changed first prose")),
                entry(&ids[1], 2, &body),
            ];
            let before = state(&store);
            match path {
                "save" => refused(store.flush(&entries)),
                "mobile" => {
                    let error = crate::mobile_core::flush(&store, 1, 1, &entries, &[]).unwrap_err();
                    assert!(error.contains("document format refused"));
                }
                "desktop" => {
                    let mut project = crate::OpenProject {
                        book_id: store.book_id().unwrap().unwrap(),
                        registry_home: None,
                        path: db.clone(),
                        name: "Book".into(),
                        generation: 1,
                        analytics: None,
                        tracking_on: false,
                        words: store.word_index().unwrap(),
                        excluded: HashSet::new(),
                        store,
                    };
                    let counts = project.word_counts();
                    let error = crate::flush_into(&mut project, &entries, 1).unwrap_err();
                    assert!(error.contains("document format refused"));
                    assert_eq!(project.word_counts(), counts);
                    assert_eq!(state(&project.store), before);
                    continue;
                }
                "mirror" => refused(store.accept_from_mirror(
                    &[
                        (ids[0].clone(), 2, entries[0].body.clone()),
                        (ids[1].clone(), 2, body.clone()),
                    ],
                    "Before accepting",
                )),
                _ => unreachable!(),
            }
            assert_eq!(state(&store), before, "{path}");
        }
    }
}

#[test]
fn format_gate_import_batches_and_publication_store_nothing() {
    for body in new_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::historical_test_store(&dir.path().join("empty.db"), 17);
        let valid = prose("First imported scene");
        let rows = [
            (None, "scene", "First", Some(valid.as_str())),
            (None, "scene", "Second", Some(body.as_str())),
        ];
        let before = state(&store);
        refused(store.import_tree(&rows));
        assert_eq!(state(&store), before);
        // Markdown, DOCX and salvage reimport all publish through this boundary.
        for name in ["Markdown import", "DOCX import", "Salvage reimport"] {
            let library = dir.path().join(name);
            let result = crate::projects::create_imported(
                &library,
                name,
                &rows,
                &crate::strings::Strings::english(),
            );
            if body.contains("\"figure\"") {
                assert!(result.unwrap_err().contains("document format refused"));
                assert!(!library.exists());
            } else {
                let project = result.unwrap();
                let imported = Store::open_readonly(std::path::Path::new(&project.path)).unwrap();
                assert_eq!(imported.user_version().unwrap(), READ_SCHEMA_VERSION);
                assert!(imported.documents().unwrap().values().any(|stored| stored == &body));
            }
        }
    }
}

#[test]
fn format_gate_history_restores_store_nothing() {
    for body in new_bodies() {
        for path in ["document", "snapshot", "mirror undo"] {
            let dir = tempfile::tempdir().unwrap();
            let (store, ids) = setup(&dir.path().join("book.db"));
            let snapshot = store.snapshot_create("Retained draft").unwrap();
            let version: i64 = store
                .conn
                .query_row(
                    "SELECT id FROM doc_version WHERE item_id=?1 AND snapshot_id=?2",
                    rusqlite::params![ids[1], snapshot.id],
                    |r| r.get(0),
                )
                .unwrap();
            store.conn.execute("UPDATE blob SET body=?1 WHERE key=(SELECT blob_key FROM doc_version WHERE id=?2)",
                rusqlite::params![body, version]).unwrap();
            let before = state(&store);
            match path {
                "document" => refused(store.doc_restore(&ids[1], version, 2)),
                "snapshot" => refused(store.snapshot_restore(snapshot.id)),
                "mirror undo" => {
                    refused(store.undo_mirror_accept(&ids[1], version, snapshot.id, 2))
                }
                _ => unreachable!(),
            }
            assert_eq!(state(&store), before, "{path}");
        }
    }
}

#[test]
fn format_gate_review_acceptance_and_return_store_nothing() {
    use crate::review_document::{FragmentToken, ReviewHunk};
    use crate::store::review::{ReviewDecision, ReviewReturnAuthors, ReviewAuthorChoice};
    for body in new_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ids) = setup(&dir.path().join("book.db"));
        let author = store.review_author_create("Editor").unwrap();
        let group = store
            .review_group_create(
                &ids[1],
                2,
                author.id,
                &[ReviewHunk {
                    from: 1,
                    to: 2,
                    before: vec![FragmentToken::Text {
                        text: "S".into(),
                        marks: vec![],
                    }],
                    after: vec![FragmentToken::Text {
                        text: "s".into(),
                        marks: vec![],
                    }],
                }],
            )
            .unwrap();
        let snapshot = store.review_scene_snapshot(&ids[1]).unwrap();
        let expected = crate::review_docx::manifest(&snapshot).unwrap();
        let plan = crate::review_docx::ReviewPlan {
            expected: expected.clone(),
            decisions: vec![crate::review_docx::OldDecision::Accept(group.hunks[0].id)],
            new_hunks: vec![],
            new_messages: vec![],
            rejected_projection: body.clone(),
            accepted_projection: snapshot.body.clone(),
        };
        let before = state(&store);
        let authors = ReviewReturnAuthors { sources: vec![], deciding_actor: Some(ReviewAuthorChoice::Existing(author.id)) };
        refused(store.review_return_apply(&plan, &authors));
        assert_eq!(state(&store), before);
        let candidate_plan = crate::review_docx::ReviewPlan { rejected_projection: snapshot.body.clone(), ..plan };
        crate::review_document::with_test_candidate(&body, || {
            refused(store.review_return_apply(&candidate_plan, &authors));
        });
        assert_eq!(state(&store), before);
        crate::review_document::with_test_candidate(&body, || refused(store.review_decide(
            group.id,
            group.rev,
            2,
            &[group.hunks[0].id],
            ReviewDecision::Accept,
            author.id,
        )));
        assert_eq!(state(&store), before);
    }
}

#[test]
fn format_gate_database_restore_and_newer_open_leave_files_unchanged() {
    for placement in ["live", "history", "newer schema"] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("point.db");
        let (store, ids) = setup(&db);
        if placement == "newer schema" {
            store.conn.pragma_update(None, "user_version", crate::store::READ_SCHEMA_VERSION + 1).unwrap();
        } else {
            let body = &new_bodies()[0];
            if placement == "live" {
                store
                    .conn
                    .execute(
                        "UPDATE doc SET body=?1 WHERE item_id=?2",
                        rusqlite::params![body, ids[1]],
                    )
                    .unwrap();
            } else {
                let snapshot = store.snapshot_create("Retained draft").unwrap();
                store.conn.execute("UPDATE blob SET body=?1 WHERE key=(SELECT blob_key FROM doc_version WHERE item_id=?2 AND snapshot_id=?3)",
                    rusqlite::params![body, ids[1], snapshot.id]).unwrap();
            }
        }
        store.checkpoint().unwrap();
        drop(store);
        let before = std::fs::read(&db).unwrap();
        let library = dir.path().join("library");
        let error = crate::projects::restore_point_into(&db, &library, "book", 1).unwrap_err();
        assert!(
            error.contains(if placement == "newer schema" {
                "schema v19"
            } else {
                "document format refused"
            }),
            "{error}"
        );
        assert!(!library.exists());
        assert_eq!(std::fs::read(&db).unwrap(), before);
        if placement == "newer schema" {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
            drop(conn);
            let before = std::fs::read(&db).unwrap();
            assert!(matches!(
                Store::open_existing(&db),
                Err(StoreError::NewerSchema { .. })
            ));
            assert_eq!(std::fs::read(&db).unwrap(), before);
            assert!(!std::path::PathBuf::from(format!("{}-wal", db.display())).exists());
        }
    }
}

#[test]
fn format_gate_restore_rechecks_the_staged_copy_before_publication() {
    for newer in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("point.db");
        let (store, ids) = setup(&db);
        store.checkpoint().unwrap();
        drop(store);
        let before = std::fs::read(&db).unwrap();
        let library = dir.path().join("library");
        let result =
            crate::projects::restore_point_with(&db, &library, "book", 1, |source, target| {
                crate::projects::copy_point(source, target)?;
                let conn = rusqlite::Connection::open(target).unwrap();
                if newer {
                    conn.pragma_update(None, "user_version", crate::store::READ_SCHEMA_VERSION + 1).unwrap();
                } else {
                    conn.execute(
                        "UPDATE doc SET body=?1 WHERE item_id=?2",
                        rusqlite::params![new_bodies()[0], ids[1]],
                    )
                    .unwrap();
                }
                Ok(())
            });
        let error = result.unwrap_err();
        assert!(
            error.contains(if newer {
                "schema v19"
            } else {
                "document format refused"
            }),
            "{error}"
        );
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);
        assert_eq!(std::fs::read(&db).unwrap(), before);
    }
}

#[test]
fn format_gate_mobile_database_imports_store_nothing() {
    use crate::{backup_bundle, encrypted_archive, mobile_transfer, transfer_copy};
    use sha2::{Digest, Sha256};

    for body in new_bodies() {
        for history in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join("source.db");
            let (store, ids) = setup(&db);
            let mut body = body.clone();
            let mut value: Value = serde_json::from_str(&body).unwrap();
            if value["content"][0]["type"] == "figure" {
                crate::store::figure_assets::test_support::install(&store);
                let image = dir.path().join("figure.png");
                std::fs::write(&image, include_bytes!("../../../fixtures/two-halves.png")).unwrap();
                let asset = crate::figures::test_support::import(&db, &store, &image);
                value["content"][0]["attrs"]["asset_id"] = asset.id.into();
                body = value.to_string();
            }
            if history {
                let snapshot = store.snapshot_create("Retained draft").unwrap();
                store.conn.execute("UPDATE blob SET body=?1 WHERE key=(SELECT blob_key FROM doc_version WHERE item_id=?2 AND snapshot_id=?3)",
                    rusqlite::params![body, ids[1], snapshot.id]).unwrap();
            } else {
                store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2",
                    rusqlite::params![body, ids[1]]).unwrap();
            }
            let export = mobile_transfer::stage(
                &dir.path().join("export"), &uuid::Uuid::now_v7().to_string(),
            ).unwrap();
            let bundle = export.join("snapshot.point");
            assert!(backup_bundle::write(&db, &store, &bundle).unwrap().verified);
            let book_id = store.book_id().unwrap().unwrap();
            let source = transfer_copy::Source {
                lineage: transfer_copy::lineage(&store).unwrap(),
                book_id,
                title: None,
                snapshot: format!("{:x}", Sha256::digest(
                    std::fs::read(bundle.join(backup_bundle::INVENTORY_NAME)).unwrap(),
                )),
            };
            store.checkpoint().unwrap();
            let before = state(&store);
            let original = std::fs::read(&db).unwrap();
            let bundle_before = mobile_transfer::tests::contents(&bundle);
            let error = transfer_copy::inspect(&bundle).unwrap_err();
            assert!(error.contains("document format refused"));
            assert!(error.contains(&ids[1]));
            let private = dir.path().join("private");
            std::fs::create_dir(&private).unwrap();
            let error = transfer_copy::stage(&bundle, &private, &source).err().unwrap();
            assert!(error.contains("document format refused"));
            assert_eq!(std::fs::read_dir(&private).unwrap().count(), 0);

            let key = export.join("key.in");
            encrypted_archive::generate_key(&key).unwrap();
            mobile_transfer::encrypt(&bundle, &export, &key).unwrap();
            let incoming = mobile_transfer::stage(
                &dir.path().join("incoming"), &uuid::Uuid::now_v7().to_string(),
            ).unwrap();
            std::fs::copy(&key, incoming.join("key.in")).unwrap();
            std::fs::copy(export.join("archive.out"), incoming.join("archive.in")).unwrap();
            let books = dir.path().join("books");
            std::fs::create_dir(&books).unwrap();
            let (retained, _) = setup(&books.join("retained.db"));
            retained.checkpoint().unwrap();
            drop(retained);
            let books_before = mobile_transfer::tests::contents(&books);
            assert_eq!(mobile_transfer::preview(&incoming, &books).unwrap_err(), format!("transfer_format:{}", ids[1]));
            backup_bundle::verify(&incoming.join("point")).unwrap();
            let (archive_bytes, archive_sha256) = mobile_transfer::fingerprint(
                &incoming.join("archive.in"), mobile_transfer::ARCHIVE_LIMIT,
            ).unwrap();
            let expected = mobile_transfer::Preview {
                title: None, related: vec![], unreadable_books: 0,
                source, archive_bytes, archive_sha256,
            };
            assert_eq!(mobile_transfer::publish(&incoming, &books, &expected).unwrap_err(), format!("transfer_format:{}", ids[1]));
            assert!(!incoming.join("owned-copy").exists());
            assert_eq!(mobile_transfer::tests::contents(&books), books_before);
            assert_eq!(mobile_transfer::tests::contents(&bundle), bundle_before);
            assert_eq!(std::fs::read(&db).unwrap(), original);
            assert_eq!(state(&store), before);
        }
    }
}

#[test]
fn format_gate_seed_replace_and_timeline_store_nothing() {
    for body in new_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = dir.path().join("fixture");
        std::fs::create_dir(&fixture).unwrap();
        std::fs::write(fixture.join("project.json"), r#"{"meta":{"seed":"gate"},"items":[{"id":"scene","type":"scene","title":"Scene","parentId":null}]}"#).unwrap();
        std::fs::write(
            fixture.join("scenes.ndjson"),
            json!({"id":"scene","body":serde_json::from_str::<Value>(&body).unwrap()}).to_string(),
        )
        .unwrap();
        let db = dir.path().join("new.db");
        let seeded = crate::store::seed::seed_project(&fixture, &db);
        if body.contains("\"figure\"") {
            refused(seeded);
            assert!(!db.exists());
        } else {
            seeded.unwrap();
            let store = Store::open_readonly(&db).unwrap();
            assert_eq!(store.load_doc("scene").unwrap().body, body);
            drop(store);
            std::fs::remove_file(&db).unwrap();
        }
        std::fs::write(fixture.join("scenes.ndjson"), json!({"id":"scene","body":serde_json::from_str::<Value>(crate::store::EMPTY_DOC_BODY).unwrap()}).to_string()).unwrap();
        std::fs::write(fixture.join("timelines.ndjson"), json!({"id":"timeline","title":"Timeline","body":serde_json::from_str::<Value>(&body).unwrap()}).to_string()).unwrap();
        refused(crate::store::seed::seed_project(&fixture, &db));
        assert!(!db.exists());
        let (store, ids) = setup(&dir.path().join("book.db"));
        store
            .conn
            .execute(
                "UPDATE doc SET body=?1 WHERE item_id=?2",
                rusqlite::params![{
                    let mut value: Value = serde_json::from_str(&body).unwrap();
                    value["content"].as_array_mut().unwrap().push(json!({"type":"paragraph","content":[{"type":"text","text":"prose"}]}));
                    value.to_string()
                }, ids[1]],
            )
            .unwrap();
        let before = state(&store);
        refused(store.replace_everywhere(&HashSet::new(), "prose", "changed", "Before replacing"));
        assert_eq!(state(&store), before);
        let timeline = store.item_create(None, TIMELINE_TYPE, "Timeline").unwrap();
        let before = state(&store);
        refused(store.flush(&[entry(&timeline.id, 1, &body)]));
        assert_eq!(state(&store), before);
    }
}

#[test]
fn format_legacy_empty_runs_recover_through_backup_transfer_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("old.db");
    let (store, ids) = setup(&db);
    let legacy = json!({"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":""},{"type":"text","text":"moon"}
    ]}]}).to_string();
    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![legacy, ids[1]]).unwrap();
    let retained = store.snapshot_create("Old draft").unwrap();
    let bundle = dir.path().join("old.point");
    assert!(crate::backup_bundle::write(&db, &store, &bundle).unwrap().verified);
    let source = crate::transfer_copy::inspect(&bundle).unwrap();
    let private = dir.path().join("private");
    std::fs::create_dir(&private).unwrap();
    let copy = crate::transfer_copy::stage(&bundle, &private, &source).unwrap();
    let copied = Store::open_readonly(&copy.database).unwrap();
    assert_eq!(copied.load_doc(&ids[1]).unwrap().body, legacy);
    let restored = crate::projects::restore_point_into(&bundle, &dir.path().join("library"), "old", 1).unwrap();
    let restored = Store::open_readonly(std::path::Path::new(&restored.path)).unwrap();
    assert_eq!(restored.load_doc(&ids[1]).unwrap().body, legacy);

    let report = store.replace_everywhere(&HashSet::new(), "moon", "changed", "Before replacing").unwrap();
    assert_eq!(report.documents, 1);
    assert_eq!(store.snapshot_restore(report.snapshot.id).unwrap().documents, 1);
    let recovered = store.load_doc(&ids[1]).unwrap();
    validate_write(&recovered.body).unwrap();
    assert_eq!(recovered.body, prose("moon"));

    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![legacy, ids[1]]).unwrap();
    let version: i64 = store.conn.query_row("SELECT id FROM doc_version WHERE item_id=?1 AND snapshot_id=?2", rusqlite::params![ids[1], retained.id], |row| row.get(0)).unwrap();
    assert_eq!(store.doc_restore(&ids[1], version, recovered.rev).unwrap().body, prose("moon"));
    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![legacy, ids[1]]).unwrap();
    let rev = store.load_doc(&ids[1]).unwrap().rev;
    let accepted = store.accept_from_mirror(&[(ids[1].clone(), rev, prose("incoming"))], "Before accepting").unwrap();
    let version: i64 = store.conn.query_row("SELECT id FROM doc_version WHERE item_id=?1 AND snapshot_id=?2", rusqlite::params![ids[1], accepted.snapshot.id], |row| row.get(0)).unwrap();
    assert_eq!(store.undo_mirror_accept(&ids[1], version, accepted.snapshot.id, rev + 1).unwrap().body, prose("moon"));
}

#[test]
fn format_replace_skips_untouched_invalid_documents_and_snapshot_rows() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ids) = setup(&dir.path().join("book.db"));
    let invalid = new_bodies()[0].clone();
    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![invalid, ids[0]]).unwrap();
    let report = store.replace_everywhere(&HashSet::new(), "second", "Changed", "Before replacing").unwrap();
    assert_eq!(report.documents, 1);
    assert_eq!(store.snapshot_restore(report.snapshot.id).unwrap().documents, 1);
    assert_eq!(store.load_doc(&ids[0]).unwrap().body, invalid);
}

#[test]
fn format_import_parsers_keep_activated_notes_and_breaks_without_dropping_them() {
    let markdown = crate::import::parse("# Book\n\n## Scene\n\nProse[^note]\n\n[^note]: A note\n\n![Figure](image.png)\n\n---\n", "book");
    let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Prose</w:t><w:endnoteReference w:id="1"/><w:drawing/></w:r></w:p></w:body></w:document>"#;
    let bytes = crate::epub::zip(&[crate::epub::Entry::text("word/document.xml", xml)]);
    let docx = crate::docx_import::parse(&bytes, "book").unwrap();
    assert_eq!(docx.losses, crate::docx_import::Losses { missing_note_bodies: 1, pictures: 1, ..Default::default() });
    let parsed: Value = serde_json::from_str(docx.imported.items[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(parsed["content"][0]["content"][0]["text"], "Prose");
    assert_eq!(parsed["content"][0]["content"][1]["type"], "endnote");
    assert_eq!(parsed["content"][0]["content"][1]["attrs"]["body"], "");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("damaged.db");
    let (store, ids) = setup(&db);
    let mut future: Value = serde_json::from_str(&new_bodies()[0]).unwrap();
    future["content"].as_array_mut().unwrap().push(json!({"type":"paragraph","content":[{"type":"text","text":"Salvaged prose"}]}));
    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![future.to_string(), ids[1]]).unwrap();
    store.checkpoint().unwrap();
    drop(store);
    let out = dir.path().join("salvaged");
    crate::salvage::salvage(&db, &out).unwrap();
    let recovered = std::fs::read_to_string(out.join(crate::salvage::MANUSCRIPT_NAME)).unwrap();
    assert!(recovered.contains("Salvaged prose"));
    let salvage = crate::import::parse(&recovered, "salvaged");
    for imported in [markdown, docx.imported, salvage] {
        let bodies: Vec<_> = imported.items.iter().filter_map(|item| item.body.as_deref()).collect();
        assert!(!bodies.is_empty());
        for body in bodies { validate_write(body).unwrap(); }
        let rows: Vec<_> = imported.items.iter().map(|item| (item.parent, item.item_type, item.title.as_str(), item.body.as_deref())).collect();
        let library = tempfile::tempdir().unwrap();
        let summary = crate::projects::create_imported(library.path(), &imported.name, &rows, &crate::strings::Strings::english()).unwrap();
        let stored = Store::open_readonly(std::path::Path::new(&summary.path)).unwrap().documents().unwrap();
        for body in stored.values() { validate_write(body).unwrap(); }
        let mut expected: Vec<_> = rows.iter().filter_map(|row| row.3).collect();
        let mut actual: Vec<_> = stored.values().map(String::as_str).collect();
        expected.sort_unstable();
        actual.sort_unstable();
        assert_eq!(actual, expected);
    }
}


#[test]
fn schema18_reader_first_save_of_new_scene_keeps_existing_atoms() {
    let dir = tempfile::tempdir().unwrap();
    let (store, retained, body) = crate::store::test_support::reader_fixture(&dir.path().join("reader.db"));
    let scene = store.item_create(None, "scene", "New prose").unwrap().id;
    // Exercise the supported base-rev-zero path without a starter doc row.
    store.conn.execute("DELETE FROM doc WHERE item_id=?1", [&scene]).unwrap();
    store.flush(&[entry(&scene, 0, &prose("First save"))]).unwrap();
    assert_eq!(store.load_doc(&scene).unwrap().rev, 1);
    assert_eq!(store.load_doc(&retained).unwrap().body, body);
    assert_eq!(store.user_version().unwrap(), 18);
    let another = store.item_create(None, "scene", "No new atoms").unwrap().id;
    store.conn.execute("DELETE FROM doc WHERE item_id=?1", [&another]).unwrap();
    store.flush(&[entry(&another, 0, &body)]).unwrap();
}

#[test]
fn schema18_authoring_opens_preserves_history_and_changes_atoms() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("reader.db");
    let (store, id, body) = crate::store::test_support::reader_fixture(&db);
    let assets = store.figure_assets().unwrap();
    let preview = crate::figures::preview(&db, &store, &id, "01900000-0000-7000-8000-000000000002", &assets[0].id).unwrap();
    assert_eq!(preview.state, "present");
    assert!(preview.data_uri.unwrap().starts_with("data:image/"));
    assert!(crate::figures::preview(&db, &store, &id, "wrong placement", &assets[0].id).is_err());
    let versions = store.doc_versions(&id).unwrap();
    drop(store);
    let readonly = Store::open_readonly(&db).unwrap();
    assert_eq!(readonly.user_version().unwrap(), 18);
    assert_eq!(readonly.load_doc(&id).unwrap().body, body);
    readonly.validate_retained_formats().unwrap();
    drop(readonly);
    let store = Store::open_existing(&db).unwrap();
    let edited = body.replace("Surrounding prose", "Edited surrounding prose");
    store.flush(&[entry(&id, 1, &edited)]).unwrap();
    assert_eq!(atoms(&edited).unwrap(), atoms(&body).unwrap());
    assert_eq!(store.load_doc(&id).unwrap().body, edited);
    assert_eq!(store.figure_assets().unwrap(), assets);
    for changed in [edited.replace("Retained note", "Changed note"), edited.replace("Retained caption", "Changed caption"), prose("Lost atoms"), edited.replacen("\"content\":[", "\"content\":[{\"type\":\"scene_break\"},", 1)] {
        let rev = store.load_doc(&id).unwrap().rev;
        assert!(crate::mobile_core::flush(&store, 1, 1, &[entry(&id, rev, &changed)], &[]).is_err());
        assert_eq!(store.load_doc(&id).unwrap().rev, rev);
        store.flush(&[entry(&id, rev, &changed)]).unwrap();
        assert_eq!(store.load_doc(&id).unwrap().body, changed);
    }
    let rev = store.load_doc(&id).unwrap().rev;
    store.doc_restore(&id, versions[0].id, rev).unwrap();
    assert_eq!(store.load_doc(&id).unwrap().body, body);
    // A retained version may legitimately contain a different atom payload.
    let original_version = store.doc_versions(&id).unwrap()[0].id;
    store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![prose("Legacy revision"), id]).unwrap();
    let rev = store.load_doc(&id).unwrap().rev;
    store.doc_restore(&id, original_version, rev).unwrap();
    assert!(!atoms(&store.load_doc(&id).unwrap().body).unwrap().is_empty());
    assert_eq!(store.user_version().unwrap(), 18);
    let fresh = Store::open(&dir.path().join("fresh.db")).unwrap();
    assert_eq!(fresh.user_version().unwrap(), 18);
    assert!(fresh.figure_registry().unwrap().present);
}

#[test]
fn schema18_reader_complete_copy_restore_transfer_and_salvage() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("reader.db");
    let (store, id, body) = crate::store::test_support::reader_fixture(&db);
    let point = dir.path().join("reader.point");
    assert!(crate::backup_bundle::write(&db, &store, &point).unwrap().verified);
    crate::transfer_copy::inspect(&point).unwrap();
    let target = dir.path().join("copies");
    std::fs::create_dir(&target).unwrap();
    let copied = crate::transfer_copy::stage(&point, &target, &crate::transfer_copy::inspect(&point).unwrap()).unwrap();
    let reader = Store::open_existing(&copied.database).unwrap();
    assert_eq!(reader.user_version().unwrap(), 18);
    assert_eq!(reader.load_doc(&id).unwrap().body, body);
    assert_eq!(reader.figure_assets().unwrap(), store.figure_assets().unwrap());
    reader.validate_retained_formats().unwrap();
    let library = dir.path().join("library");
    let restored = crate::projects::restore_point_into(&point, &library, "copy", 1_700_000_000_000).unwrap();
    let restored = Store::open_existing(std::path::Path::new(&restored.path)).unwrap();
    assert_eq!(restored.user_version().unwrap(), 18);
    assert_eq!(restored.load_doc(&id).unwrap().body, body);
    assert_eq!(restored.version_body(restored.doc_versions(&id).unwrap()[0].id).unwrap(), body);
    let salvage_dir = dir.path().join("salvage");
    crate::salvage::salvage(&db, &salvage_dir).unwrap();
    fn files(path: &std::path::Path) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() { out.extend(files(&path)); } else { out.push(std::fs::read(path).unwrap()); }
        }
        out
    }
    let salvaged = files(&salvage_dir);
    assert!(salvaged.iter().any(|bytes| bytes == body.as_bytes()));
    assert!(salvaged.iter().any(|bytes| bytes == include_bytes!("../../../fixtures/two-halves.png")));
    for asset in reader.figure_assets().unwrap() {
        crate::figures::verify_original(&crate::pictures::dir_for(&copied.database).join(&asset.stored_name), &asset).unwrap();
    }
}

#[test]
fn schema18_reader_refuses_19_and_missing_registry_before_writable_setup() {
    for version in [18, 19] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("book.db");
        let store = crate::store::historical_test_store(&db, 17);
        store.checkpoint().unwrap();
        drop(store);
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        drop(conn);
        let before = std::fs::read(&db).unwrap();
        for opened in [Store::open_readonly(&db), Store::open_existing(&db)] {
            if version == 18 {
                assert!(matches!(opened, Err(StoreError::Corrupt(reason)) if reason.contains("registry")));
            } else {
                assert!(matches!(opened, Err(StoreError::NewerSchema { found: 19, supported: 18 })));
            }
        }
        assert_eq!(std::fs::read(&db).unwrap(), before);
        assert!(!db.with_extension("db-wal").exists());
    }
}
