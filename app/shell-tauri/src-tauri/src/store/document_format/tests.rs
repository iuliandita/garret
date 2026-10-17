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
    let store = Store::open(path).unwrap();
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
    assert!(!new_nodes_allowed());
    assert_eq!(SCHEMA_VERSION, 17);
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
            validate_write(&case.body.to_string()).is_ok(),
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
        let store = Store::open(&dir.path().join("empty.db")).unwrap();
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
            let error = crate::projects::create_imported(
                &library,
                name,
                &rows,
                &crate::strings::Strings::english(),
            )
            .unwrap_err();
            assert!(error.contains("document format refused"));
            assert!(!library.exists());
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
    use crate::store::review::{ReviewDecision, ReviewReturnAuthors};
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
        for projection in ["accepted", "rejected"] {
            let plan = crate::review_docx::ReviewPlan {
                expected: expected.clone(),
                decisions: vec![],
                new_hunks: vec![],
                new_messages: vec![],
                rejected_projection: if projection == "rejected" {
                    body.clone()
                } else {
                    snapshot.body.clone()
                },
                accepted_projection: if projection == "accepted" {
                    body.clone()
                } else {
                    snapshot.body.clone()
                },
            };
            let before = state(&store);
            refused(store.review_return_apply(&plan, &ReviewReturnAuthors::default()));
            assert_eq!(state(&store), before);
        }
        store
            .conn
            .execute(
                "UPDATE doc SET body=?1 WHERE item_id=?2",
                rusqlite::params![body, ids[1]],
            )
            .unwrap();
        let before = state(&store);
        refused(store.review_decide(
            group.id,
            group.rev,
            2,
            &[group.hunks[0].id],
            ReviewDecision::Accept,
            author.id,
        ));
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
            store.conn.pragma_update(None, "user_version", 18).unwrap();
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
                "schema v18"
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
        refused(crate::store::seed::seed_project(&fixture, &db));
        assert!(!db.exists());
        let (store, ids) = setup(&dir.path().join("book.db"));
        store
            .conn
            .execute(
                "UPDATE doc SET body=?1 WHERE item_id=?2",
                rusqlite::params![body, ids[1]],
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
