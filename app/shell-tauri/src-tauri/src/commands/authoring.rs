use crate::{locked, open_project, publication_plan::{Numbering, Scopes}, store, StoreState};
use tauri::State;

#[derive(serde::Serialize)]
pub(crate) struct NoteContext { offset: usize }

fn context(store: &store::Store, item_id: &str) -> Result<NoteContext, String> {
    let walk = store::book_walk(store.items().map_err(|error| error.to_string())?);
    let collection = store.project_preset().map_err(|error| error.to_string())? == "collection";
    let mode = store.get_meta("notes.numbering").map_err(|error| error.to_string())?;
    let scopes = Scopes::of(&walk, Numbering::parse(mode.as_deref(), collection)?, collection);
    let Some(scope) = scopes.by_item.get(item_id) else { return Ok(NoteContext { offset: 0 }); };
    let mut offset = 0;
    for item in walk.front.iter().chain(&walk.chapters).chain(&walk.back) {
        if item.id == item_id { break; }
        if scopes.by_item.get(&item.id) != Some(scope) { continue; }
        let doc = match store.load_doc(&item.id) {
            Ok(doc) => doc,
            Err(store::StoreError::NotFound { .. }) => continue,
            Err(error) => return Err(error.to_string()),
        };
        {
            let value = store::document_fields::read(&doc.body).ok_or("unsupported document in note numbering")?;
            if let Some(blocks) = value["content"].as_array() {
                for block in blocks {
                    if let Some(children) = block["content"].as_array() {
                        offset += children.iter().filter(|node| node["type"] == "endnote").count();
                    }
                }
            }
        }
    }
    Ok(NoteContext { offset })
}

#[command_boundary::command]
pub(crate) fn endnote_context(state: State<'_, StoreState>, generation: u64, item_id: String) -> Result<NoteContext, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation { return Err("note numbering belongs to another book".into()); }
    context(&project.store, &item_id)
}

#[command_boundary::command]
pub(crate) fn endnote_numbering_set(state: State<'_, StoreState>, generation: u64, numbering: String) -> Result<(), String> {
    Numbering::parse(Some(&numbering), false)?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation { return Err("note numbering belongs to another book".into()); }
    project.store.set_meta("notes.numbering", &numbering).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authoring_offsets_follow_typed_chapter_scope_and_refuse_unknown_modes() {
        let root = tempfile::tempdir().unwrap();
        let store = store::Store::open(&root.path().join("book.db")).unwrap();
        let chapter = store.item_create(None, "chapter", "One").unwrap();
        let first = store.item_create(Some(&chapter.id), "scene", "First").unwrap();
        let second = store.item_create(Some(&chapter.id), "scene", "Second").unwrap();
        let next_chapter = store.item_create(None, "chapter", "Two").unwrap();
        let third = store.item_create(Some(&next_chapter.id), "scene", "Third").unwrap();
        let body = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"endnote","attrs":{"id":uuid::Uuid::now_v7().to_string(),"fmt":"text","body":"Retained note"}}
        ]}]}).to_string();
        store.flush(&[store::FlushEntry { item_id: first.id.clone(), base_rev: 1, body, comments: None }]).unwrap();
        assert_eq!(context(&store, &second.id).unwrap().offset, 1);
        assert_eq!(context(&store, &third.id).unwrap().offset, 1);
        store.set_meta("notes.numbering", "chapter").unwrap();
        assert_eq!(context(&store, &second.id).unwrap().offset, 1);
        assert_eq!(context(&store, &third.id).unwrap().offset, 0);
        store.set_meta("notes.numbering", "story").unwrap();
        assert_eq!(context(&store, &third.id).unwrap().offset, 1);
        store.set_meta("notes.numbering", "unknown").unwrap();
        assert!(context(&store, &second.id).is_err());
    }
}
