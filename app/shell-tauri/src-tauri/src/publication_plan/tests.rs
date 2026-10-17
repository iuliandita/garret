use super::*;
use crate::store::Store;

#[test]
fn typed_scopes_restart_without_treating_depth_as_a_chapter() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("book.db")).unwrap();
    let part = store.item_create(None, "part", "Part").unwrap();
    let one = store.item_create(Some(&part.id), "chapter", "One").unwrap();
    let before = store.item_create(Some(&one.id), "scene", "Before").unwrap();
    let chapter = store
        .item_create(Some(&one.id), "chapter", "Chapter")
        .unwrap();
    let nested = store
        .item_create(Some(&chapter.id), "scene", "Nested")
        .unwrap();
    let two = store.item_create(Some(&part.id), "chapter", "Two").unwrap();
    let other = store.item_create(Some(&two.id), "scene", "Other").unwrap();
    let front = store.item_create(None, "front", "Front").unwrap();
    let dedication = store
        .item_create(Some(&front.id), "matter", "Dedication")
        .unwrap();
    let back = store.item_create(None, "back", "Back").unwrap();
    let afterword = store
        .item_create(Some(&back.id), "matter", "Afterword")
        .unwrap();
    let walk = store::book_walk(store.items().unwrap());
    let at = |scopes: &Scopes, id: &str| scopes.by_item[id];
    for collection in [false, true] {
        for numbering in [Numbering::Book, Numbering::Chapter, Numbering::Story] {
            let scopes = Scopes::of(&walk, numbering, collection);
            assert_eq!(at(&scopes, &chapter.id), at(&scopes, &nested.id));
            if numbering == Numbering::Chapter || (collection && numbering == Numbering::Story) {
                assert_ne!(at(&scopes, &before.id), at(&scopes, &other.id));
            } else {
                assert_eq!(at(&scopes, &before.id), at(&scopes, &other.id));
            }
            if collection && numbering != Numbering::Book {
                assert_ne!(at(&scopes, &dedication.id), at(&scopes, &afterword.id));
                assert_ne!(at(&scopes, &dedication.id), at(&scopes, &before.id));
            }
            if collection && numbering == Numbering::Chapter {
                assert_eq!(scopes.rows[at(&scopes, &before.id)].end, nested.id);
                assert_ne!(at(&scopes, &before.id), at(&scopes, &nested.id));
            }
        }
    }
    assert_eq!(Numbering::parse(None, true).unwrap(), Numbering::Story);
    assert_eq!(Numbering::parse(None, false).unwrap(), Numbering::Book);
    assert!(Numbering::parse(Some("future"), false).is_err());
}
