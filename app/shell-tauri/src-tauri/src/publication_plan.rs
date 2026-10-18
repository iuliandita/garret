//! Publication-only numbering and verified relative media, independent of writes.
use crate::store::{self, figure_assets::FigureAsset, BookWalk, Item};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Numbering {
    Book,
    Chapter,
    Story,
}

impl Numbering {
    pub(crate) fn parse(value: Option<&str>, collection: bool) -> Result<Self, String> {
        match value {
            None if collection => Ok(Self::Story),
            None | Some("book") => Ok(Self::Book),
            Some("chapter") => Ok(Self::Chapter),
            Some("story") => Ok(Self::Story),
            Some(_) => Err("unsupported note numbering".into()),
        }
    }
}

#[derive(Default)]
pub(crate) struct Scopes {
    pub(crate) by_item: HashMap<String, usize>,
    pub(crate) rows: Vec<Scope>,
}

pub(crate) struct Scope {
    pub(crate) label: String,
    pub(crate) end: String,
}

impl Scopes {
    pub(crate) fn of(walk: &BookWalk, numbering: Numbering, collection: bool) -> Self {
        let stories = if collection {
            crate::collection::story_ids(&walk.chapters)
        } else {
            Default::default()
        };
        let mut result = Self::default();
        let mut keys = HashMap::new();
        let book_end = walk
            .back
            .last()
            .or(walk.chapters.last())
            .or(walk.front.last())
            .map(|row| row.id.clone())
            .unwrap_or_default();
        for (run_index, run) in [&walk.front, &walk.chapters, &walk.back]
            .into_iter()
            .enumerate()
        {
            let mut ends = HashMap::new();
            let mut pending: Vec<&Item> = Vec::new();
            let mut previous = "";
            for item in run {
                while pending
                    .last()
                    .is_some_and(|parent| parent.depth >= item.depth)
                {
                    ends.insert(pending.pop().unwrap().id.as_str(), previous);
                }
                pending.push(item);
                previous = &item.id;
            }
            for parent in pending {
                ends.insert(parent.id.as_str(), previous);
            }
            let mut ancestors: Vec<&Item> = Vec::new();
            for item in run {
                while ancestors
                    .last()
                    .is_some_and(|parent| parent.depth >= item.depth)
                {
                    ancestors.pop();
                }
                ancestors.push(item);
                let story = ancestors
                    .iter()
                    .find(|parent| stories.contains(&parent.id))
                    .copied();
                let chapter = ancestors
                    .iter()
                    .rev()
                    .find(|parent| parent.item_type == "chapter" && !stories.contains(&parent.id))
                    .copied();
                let (key, label, end) = if numbering == Numbering::Book {
                    ("book".to_string(), String::new(), book_end.clone())
                } else if collection && run_index != 1 {
                    (
                        format!("matter-{run_index}"),
                        run.first().map(|row| row.title.clone()).unwrap_or_default(),
                        previous.to_string(),
                    )
                } else {
                    let owner = if numbering == Numbering::Chapter {
                        chapter.or(story)
                    } else {
                        story
                    };
                    owner
                        .map(|row| {
                            (
                                format!("item-{}", row.id),
                                row.title.clone(),
                                ends[row.id.as_str()].to_string(),
                            )
                        })
                        .unwrap_or_else(|| ("book".into(), String::new(), book_end.clone()))
                };
                let next = result.rows.len();
                let scope = *keys.entry(key).or_insert_with(|| {
                    result.rows.push(Scope { label, end });
                    next
                });
                result.by_item.insert(item.id.clone(), scope);
            }
        }
        result
    }

    pub(crate) fn book(book: &crate::export::Book) -> Self {
        let ids: Vec<_> = book
            .front
            .iter()
            .chain(book.chapters)
            .chain(book.back)
            .map(|row| row.0.clone())
            .collect();
        Self {
            rows: ids
                .last()
                .map(|end| {
                    vec![Scope {
                        label: String::new(),
                        end: end.clone(),
                    }]
                })
                .unwrap_or_default(),
            by_item: ids.into_iter().map(|id| (id, 0)).collect(),
        }
    }
}

pub(crate) struct Asset {
    pub(crate) href: String,
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
}

impl Asset {
    pub(crate) fn verified(record: &FigureAsset, bytes: Vec<u8>) -> Result<Self, String> {
        if bytes.len() as u64 != record.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
        {
            return Err(format!(
                "figure {}: original hash or size mismatch",
                record.id
            ));
        }
        let (format, width, height) =
            crate::pictures::inspect_original(&bytes).map_err(|e| e.to_string())?;
        if format.mime() != record.mime || (width, height) != (record.width_px, record.height_px) {
            return Err(format!("figure {}: original media mismatch", record.id));
        }
        Ok(Self {
            href: format!("assets/{}.{}", record.sha256, format.extension()),
            mime: record.mime.clone(),
            bytes,
        })
    }
}

pub(crate) struct Note {
    pub(crate) item: String,
    pub(crate) body: String,
    pub(crate) number: usize,
    pub(crate) scope: usize,
}

pub(crate) struct Plan {
    pub(crate) documents: HashMap<String, Value>,
    pub(crate) notes: Vec<Note>,
    pub(crate) references: HashMap<String, HashMap<String, usize>>,
    pub(crate) endnotes: HashMap<String, BTreeMap<usize, Vec<usize>>>,
    pub(crate) assets: BTreeMap<String, Asset>,
    pub(crate) scopes: Scopes,
    pub(crate) has_new: bool,
}

fn xml_text(text: &str, item: &str, field: &str) -> Result<(), String> {
    if let Some(invalid) = text.chars().find(|c| {
        !matches!(c,
        '\u{9}' | '\u{a}' | '\u{d}' | '\u{20}'..='\u{d7ff}'
        | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
    }) {
        return Err(format!(
            "item {item}: {field} contains XML 1.0-forbidden character U+{:04X}",
            invalid as u32
        ));
    }
    Ok(())
}

impl Plan {
    pub(crate) fn build(
        book: &crate::export::Book,
        bodies: &HashMap<String, String>,
        scopes: Scopes,
        mut resolve: impl FnMut(&str) -> Result<Asset, String>,
    ) -> Result<Self, String> {
        let mut result = Self {
            documents: HashMap::new(),
            notes: Vec::new(),
            references: HashMap::new(),
            endnotes: HashMap::new(),
            assets: BTreeMap::new(),
            scopes,
            has_new: false,
        };
        let selected: std::collections::HashSet<_> = book
            .front
            .iter()
            .chain(book.chapters)
            .chain(book.back)
            .map(|row| row.0.as_str())
            .collect();
        let last = book
            .back
            .last()
            .or(book.chapters.last())
            .or(book.front.last());
        for scope in &mut result.scopes.rows {
            if !selected.contains(scope.end.as_str()) {
                scope.end = last.map(|row| row.0.clone()).unwrap_or_default();
            }
        }
        let mut counts = HashMap::new();
        for (id, _, _) in book.front.iter().chain(book.chapters).chain(book.back) {
            let Some(body) = bodies.get(id) else {
                continue;
            };
            if !crate::figure_salvage::has_new_nodes(body) {
                continue;
            }
            let document = store::document_fields::read(body)
                .ok_or_else(|| format!("item {id}: unsupported document content"))?;
            let scope = *result
                .scopes
                .by_item
                .get(id)
                .ok_or_else(|| format!("item {id}: missing note scope"))?;
            for block in document["content"].as_array().expect("validated blocks") {
                match block["type"].as_str() {
                    Some("paragraph") => {
                        for node in block
                            .get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                        {
                            if node["type"] == "endnote" {
                                result.has_new = true;
                                xml_text(node["attrs"]["body"].as_str().unwrap(), id, "note body")?;
                                let number = counts.entry(scope).or_insert(0);
                                *number += 1;
                                let index = result.notes.len();
                                let instance = node["attrs"]["id"].as_str().unwrap();
                                result
                                    .references
                                    .entry(id.clone())
                                    .or_default()
                                    .insert(instance.into(), index);
                                result
                                    .endnotes
                                    .entry(result.scopes.rows[scope].end.clone())
                                    .or_default()
                                    .entry(scope)
                                    .or_default()
                                    .push(index);
                                result.notes.push(Note {
                                    item: id.clone(),
                                    body: node["attrs"]["body"].as_str().unwrap().into(),
                                    number: *number,
                                    scope,
                                });
                            }
                        }
                    }
                    Some("figure") => {
                        result.has_new = true;
                        xml_text(block["attrs"]["caption"].as_str().unwrap(), id, "caption")?;
                        xml_text(
                            block["attrs"]["alt"].as_str().unwrap(),
                            id,
                            "alternative text",
                        )?;
                        if block["attrs"]["alt"].as_str().unwrap().trim().is_empty() {
                            return Err(format!("item {id}: figure needs alternative text"));
                        }
                        let asset = block["attrs"]["asset_id"].as_str().unwrap();
                        if !result.assets.contains_key(asset) {
                            result.assets.insert(asset.into(), resolve(asset)?);
                        }
                    }
                    Some("scene_break") => result.has_new = true,
                    _ => {}
                }
            }
            result.documents.insert(id.clone(), document);
        }
        Ok(result)
    }

    pub(crate) fn from_store(
        book: &crate::export::Book,
        bodies: &HashMap<String, String>,
        scopes: Scopes,
        store: &store::Store,
        db: &std::path::Path,
    ) -> Result<Self, String> {
        let records: HashMap<_, _> = store
            .figure_assets()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();
        Self::build(book, bodies, scopes, |id| {
            let record = records
                .get(id)
                .ok_or_else(|| format!("figure {id}: unregistered asset"))?;
            let dir = crate::pictures::dir_for(db);
            if !std::fs::symlink_metadata(&dir)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
            {
                return Err(format!("figure {id}: unsafe or missing original directory"));
            }
            let mut input = crate::backup_bundle::open_regular_with_limit(
                &dir.join(&record.stored_name),
                crate::pictures::MAX_PICTURE_BYTES,
            )
            .map_err(|error| format!("figure {id}: {error}"))?;
            let mut bytes = Vec::new();
            use std::io::Read;
            input
                .by_ref()
                .take(crate::pictures::MAX_PICTURE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            Asset::verified(record, bytes)
        })
    }
}

#[cfg(test)]
mod tests;
