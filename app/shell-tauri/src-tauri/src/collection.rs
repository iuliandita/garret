use crate::store::{self, Item, Store};
use std::collections::{HashMap, HashSet};

pub fn story_ids(items: &[Item]) -> HashSet<String> {
    let mut story_depth = None;
    let mut ids = HashSet::new();
    for item in items {
        if story_depth.is_some_and(|depth| item.depth <= depth) {
            story_depth = None;
        }
        if story_depth.is_none() && item.item_type == "chapter" {
            story_depth = Some(item.depth);
            ids.insert(item.id.clone());
        }
    }
    ids
}

pub fn author(store: &Store, id: &str) -> Result<Option<String>, String> {
    Ok(store
        .get_meta(&format!("collection.author.{id}"))
        .map_err(|e| e.to_string())?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

pub fn authors(store: &Store, ids: &HashSet<String>) -> Result<HashMap<String, String>, String> {
    ids.iter()
        .filter_map(|id| match author(store, id) {
            Ok(Some(value)) => Some(Ok((id.clone(), value))),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

#[derive(serde::Serialize)]
pub struct Story {
    pub id: String,
    pub title: String,
    pub state: Option<String>,
    pub author: Option<String>,
    pub rev: i64,
}

pub fn story(store: &Store, id: &str) -> Result<Story, String> {
    if store.project_preset().map_err(|e| e.to_string())? != "collection" {
        return Err("this book is not a collection".into());
    }
    let walk = store::book_walk(store.items().map_err(|e| e.to_string())?);
    if !story_ids(&walk.chapters).contains(id) {
        return Err("this item is not a story in the manuscript".into());
    }
    let item = walk
        .chapters
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "the story is no longer available".to_string())?;
    Ok(Story {
        author: author(store, id)?,
        id: item.id,
        title: item.title,
        state: item.state,
        rev: item.rev,
    })
}

pub fn save(
    store: &Store,
    id: &str,
    title: &str,
    byline: &str,
    state: Option<&str>,
    rev: i64,
) -> Result<(), String> {
    if title.trim().is_empty()
        || title.chars().count() > 1000
        || byline.chars().count() > 1000
        || title.chars().any(char::is_control)
        || byline.chars().any(char::is_control)
    {
        return Err("use a title and author on one line, up to 1000 characters each".into());
    }
    store.with_immediate(|store| {
        story(store, id)?;
        let next = store
            .item_rename(id, title.trim(), rev)
            .map_err(|e| e.to_string())?;
        store
            .item_set_state(id, state, next)
            .map_err(|e| e.to_string())?;
        let key = format!("collection.author.{id}");
        if byline.trim().is_empty() {
            store.delete_meta(&key)
        } else {
            store.set_meta(&key, byline.trim())
        }
        .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_fields_are_atomic_and_follow_live_story_containers() {
        let root = tempfile::tempdir().unwrap();
        let made = crate::projects::create_in_preset(
            root.path(),
            "Collected",
            &crate::strings::Strings::english(),
            Some("collection"),
        )
        .unwrap();
        let store = Store::open(std::path::Path::new(&made.path)).unwrap();
        let items = store.items().unwrap();
        let id = items
            .iter()
            .find(|item| item.item_type == "chapter")
            .unwrap()
            .id
            .clone();
        assert!(items.iter().any(|item| item.title == "Story 1"));
        let before = story(&store, &id).unwrap();
        save(
            &store,
            &id,
            " The Harbour ",
            " Ada Lane ",
            Some("draft"),
            before.rev,
        )
        .unwrap();
        let edited = story(&store, &id).unwrap();
        assert_eq!(
            (
                &*edited.title,
                edited.author.as_deref(),
                edited.state.as_deref()
            ),
            ("The Harbour", Some("Ada Lane"), Some("draft"))
        );
        for (rev, status) in [(before.rev, Some("done")), (edited.rev, Some("invalid"))] {
            assert!(save(&store, &id, "Overwritten", "Other Author", status, rev).is_err());
            let after = story(&store, &id).unwrap();
            assert_eq!(
                (after.title, after.author, after.state, after.rev),
                (
                    edited.title.clone(),
                    edited.author.clone(),
                    edited.state.clone(),
                    edited.rev
                )
            );
        }
        let nested = store.item_create(Some(&id), "chapter", "Section").unwrap();
        assert!(story(&store, &nested.id).is_err());
        let trash = store
            .item_create(None, store::TRASH_TYPE, "Deleted")
            .unwrap();
        store
            .item_move(&id, Some(&trash.id), None, edited.rev)
            .unwrap();
        assert!(story(&store, &id).is_err());
        store.item_move(&id, None, None, edited.rev + 1).unwrap();
        assert_eq!(
            story(&store, &id).unwrap().author.as_deref(),
            Some("Ada Lane")
        );
        let current = story(&store, &id).unwrap();
        save(&store, &id, &current.title, "", None, current.rev).unwrap();
        assert!(store
            .get_meta(&format!("collection.author.{id}"))
            .unwrap()
            .is_none());
    }
}
