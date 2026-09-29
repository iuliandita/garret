use garret_lib::{mobile_core, store, strings};

#[cfg(target_os = "linux")]
#[test]
fn publication_refuses_collision_and_preserves_the_stage() {
    let dir = tempfile::tempdir().unwrap();
    let stage = dir.path().join("book.stage");
    let target = dir.path().join("book.db");
    std::fs::write(&stage, b"new book").unwrap();
    std::fs::write(&target, b"existing book").unwrap();
    assert_eq!(
        mobile_core::move_new(&stage, &target).unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(std::fs::read(&stage).unwrap(), b"new book");
    assert_eq!(std::fs::read(&target).unwrap(), b"existing book");
    let fresh = dir.path().join("fresh.db");
    mobile_core::move_new(&stage, &fresh).unwrap();
    assert!(!stage.exists());
    assert_eq!(std::fs::read(&fresh).unwrap(), b"new book");
    mobile_core::move_new(&fresh, &stage).unwrap();
    assert_eq!(std::fs::read(&stage).unwrap(), b"new book");
}

#[test]
fn stale_session_cannot_write_and_acknowledged_prose_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book.db");
    let store = store::Store::open(&path).unwrap();
    store
        .ensure_starter_structure(&strings::Strings::new(&strings::EN))
        .unwrap();
    let scene = store
        .items()
        .unwrap()
        .into_iter()
        .find(|item| item.item_type == "scene")
        .unwrap();
    let before = store.load_doc(&scene.id).unwrap();
    let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"saved on phone"}]}]}"#;
    let entries = [store::FlushEntry {
        item_id: scene.id.clone(),
        body: body.into(),
        base_rev: before.rev,
        comments: None,
    }];
    assert!(mobile_core::flush(&store, 4, 3, &entries, &[]).is_err());
    assert_eq!(store.load_doc(&scene.id).unwrap().body, before.body);
    let ack = mobile_core::flush(&store, 4, 4, &entries, &[]).unwrap();
    assert_eq!(ack.len(), 1);
    assert_eq!(ack[0].rev, before.rev + 1);
    drop(store);
    let reopened = store::Store::open_existing(&path).unwrap();
    assert_eq!(reopened.load_doc(&scene.id).unwrap().body, body);
}
