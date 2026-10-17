//! Text fields and their coordinates are separate from prose word counts.
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub instance_id: Option<String>,
    pub field: &'static str,
    pub text: String,
    /// Absolute document position for prose; field-relative for attributes.
    pub from: usize,
    /// Absolute positions at each UTF-16 boundary of the searchable text.
    positions: Vec<usize>,
    starts: Vec<usize>,
}

impl Field {
    pub(crate) fn position(&self, byte: usize, end: bool) -> usize {
        let offset = self.text[..byte].encode_utf16().count();
        if end { self.positions[offset] } else { self.starts[offset] }
    }

    fn prose(position: usize) -> Self {
        Self {
            instance_id: None,
            field: "prose",
            text: String::new(),
            from: position,
            positions: vec![position],
            starts: Vec::new(),
        }
    }

    fn append(&mut self, text: &str, position: usize) {
        if self.text.is_empty() {
            self.from = position;
            self.positions[0] = position;
        }
        self.text.push_str(text);
        self.starts.extend((0..text.encode_utf16().count()).map(|offset| position + offset));
        self.positions.extend((1..=text.encode_utf16().count()).map(|offset| position + offset));
    }
}

/// Retained reader only. Asset existence is checked by the store/inventory.
/// Legacy prose permits empty runs and unfamiliar marks without rewriting them;
/// any document containing atoms still uses the strict structural validator.
pub(crate) fn read(body: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(body).ok()?;
    let assets: HashSet<String> = value
        .get("content")?
        .as_array()?
        .iter()
        .filter(|node| node["type"] == "figure")
        .filter_map(|node| node["attrs"]["asset_id"].as_str().map(str::to_owned))
        .collect();
    let mut projection = value.clone();
    let blocks = projection.get_mut("content")?.as_array_mut()?;
    if blocks.iter().all(|block| block["type"] == "paragraph"
        && block.get("content").is_none_or(|content| content.as_array().is_some_and(|nodes|
            nodes.iter().all(|node| node["type"] == "text"))))
    {
        for block in blocks {
            for node in block.get_mut("content").and_then(Value::as_array_mut).into_iter().flatten() {
                if let Some(marks) = node.get("marks") {
                    if !marks.as_array()?.iter().all(|mark| mark["type"].is_string()) {
                        return None;
                    }
                }
                let text = node.as_object_mut()?;
                text.remove("marks");
                if text.get("text").and_then(Value::as_str) == Some("") {
                    text.insert("text".into(), Value::String(" ".into()));
                }
            }
        }
    }
    super::document_format::validate(&projection, true, &assets).ok()?;
    Some(value)
}

pub fn fields(body: &str) -> Option<Vec<Field>> {
    let value = read(body)?;
    let mut fields = Vec::new();
    let mut position = 0;
    let mut run: Option<Field> = None;
    for block in value["content"].as_array()? {
        match block["type"].as_str()? {
            "paragraph" => {
                position += 1;
                if let Some(run) = run.as_mut().filter(|run| !run.text.is_empty()) {
                    // The displayed separator spans the closing and opening
                    // paragraph tokens, so its far boundary is not from + 1.
                    run.text.push(' ');
                    run.positions.push(position);
                    run.starts.push(position);
                }
                for node in block
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if node["type"] == "text" {
                        let text = node["text"].as_str()?;
                        run.get_or_insert_with(|| Field::prose(position))
                            .append(text, position);
                        position += text.encode_utf16().count();
                    } else {
                        if let Some(run) = run.take() {
                            fields.push(run);
                        }
                        fields.push(Field {
                            instance_id: Some(node["attrs"]["id"].as_str()?.into()),
                            field: "note",
                            text: node["attrs"]["body"].as_str()?.into(),
                            from: 0,
                            positions: (0..=node["attrs"]["body"].as_str()?.encode_utf16().count()).collect(),
                            starts: (0..node["attrs"]["body"].as_str()?.encode_utf16().count()).collect(),
                        });
                        position += 1;
                    }
                }
                position += 1;
            }
            "figure" => {
                if let Some(run) = run.take() {
                    fields.push(run);
                }
                for field in ["caption", "alt"] {
                    fields.push(Field {
                        instance_id: Some(block["attrs"]["id"].as_str()?.into()),
                        field,
                        text: block["attrs"][field].as_str()?.into(),
                        from: 0,
                        positions: (0..=block["attrs"][field].as_str()?.encode_utf16().count()).collect(),
                        starts: (0..block["attrs"][field].as_str()?.encode_utf16().count()).collect(),
                    });
                }
                position += 1;
            }
            "scene_break" => {
                if let Some(run) = run.take() {
                    fields.push(run);
                }
                position += 1;
            }
            _ => return None,
        }
    }
    if let Some(run) = run {
        fields.push(run);
    }
    Some(fields)
}

impl super::Store {
    pub fn document_search_fields(
        &self,
    ) -> super::Result<(HashMap<String, Vec<Field>>, usize, usize)> {
        let mut stmt = self.conn.prepare("SELECT doc.item_id, doc.body FROM doc LEFT JOIN item ON item.id=doc.item_id WHERE item.type IS NULL OR item.type != ?1")?;
        let rows = stmt.query_map([super::TIMELINE_TYPE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = HashMap::new();
        let (mut scanned, mut skipped) = (0, 0);
        for row in rows {
            let (id, body) = row?;
            scanned += 1;
            if let Some(fields) = fields(&body) {
                out.insert(id, fields);
            } else {
                skipped += 1;
            }
        }
        Ok((out, scanned, skipped))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn mixed() -> Value {
        json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"A😀be"},
                {"type":"endnote","attrs":{"id":"0199ed16-8c00-7000-8000-000000000001","fmt":"text","body":"secret source"}},
                {"type":"text","text":"witched"}]},
            {"type":"figure","attrs":{"id":"0199ed16-8c00-7000-8000-000000000002","asset_id":"0199ed16-8c00-7000-8000-000000000003","width":"full","caption":"secret caption","alt":"secret alt"}},
            {"type":"scene_break"},
            {"type":"paragraph","content":[{"type":"text","text":"last words"}]}
        ]})
    }

    #[test]
    fn retained_legacy_prose_search_replace_quote_and_validation_preserve_reads() {
        for marks in [json!([]), json!([{"type":"future","attrs":{"style":"keep"}}])] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("retained.db");
            let store = super::super::Store::open(&path).unwrap();
            let item = store.item_create(None, "scene", "Scene").unwrap();
            let value = json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":""},
                {"type":"text","text":"😀moon","marks":marks}
            ]}]});
            let body = format!(" {} ", value);
            store.conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![body, item.id]).unwrap();
            assert_eq!(read(&body), Some(value.clone()));
            assert!(super::super::document_format::validate_write(&body).is_err());
            let (fields, scanned, skipped) = store.document_search_fields().unwrap();
            let corpus = crate::find::Corpus { fields, scanned, skipped, ..Default::default() };
            let items = [crate::find::SearchItem { id: &item.id, kind: "scene", title: "Scene" }];
            let found = crate::find::search(&items, &corpus, "moon", 10);
            assert_eq!(found.results[0].matches, 1);
            assert_eq!((found.results[0].locators[0].from, found.results[0].locators[0].to), (3, 7));
            assert_eq!(super::super::knowledge::quote_at(&body, 1, 7).as_deref(), Some("😀moon"));
            assert!(crate::replace::replace_in_body(&body, "missing", "sun").unwrap().body.is_none());
            let next = crate::replace::replace_in_body(&body, "moon", "sun").unwrap();
            assert_eq!((next.replaced, next.spanning), (1, 0));
            let rewritten: Value = serde_json::from_str(&next.body.unwrap()).unwrap();
            assert_eq!(rewritten["content"][0]["content"].as_array().unwrap().len(), 1);
            assert_eq!(rewritten["content"][0]["content"][0]["text"], "😀sun");
            assert_eq!(rewritten["content"][0]["content"][0]["marks"], marks);
            // The shared integrity reader must accept retained prose without
            // granting the write path permission to store its legacy shape.
            assert!(crate::validation::validate(&path).unwrap().ok);
            assert_eq!(store.load_doc(&item.id).unwrap().body, body);
        }
        let mut atom = mixed();
        atom["content"][0]["content"][0]["text"] = json!("");
        assert!(read(&atom.to_string()).is_none());
        atom = mixed();
        atom["content"][0]["content"][0]["marks"] = json!([{"type":"future"}]);
        assert!(read(&atom.to_string()).is_none());
    }

    #[test]
    fn adjacent_paragraph_search_maps_positions_and_reports_spanning_replacements() {
        let body = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"İ😀cat"}]},
            {"type":"paragraph","content":[{"type":"text","text":"sat down"}]},
            {"type":"scene_break"},
            {"type":"paragraph","content":[{"type":"text","text":"cat"}]},
            {"type":"paragraph","content":[{"type":"text","text":"sat"}]}
        ]}).to_string();
        let corpus = crate::find::Corpus {
            fields: HashMap::from([("scene".into(), fields(&body).unwrap())]),
            ..Default::default()
        };
        let items = [crate::find::SearchItem { id: "scene", kind: "scene", title: "Scene" }];
        let found = crate::find::search(&items, &corpus, "cat sat", 10);
        assert_eq!(found.results[0].matches, 2);
        assert_eq!(found.results[0].locators.iter().map(|loc| (loc.from, loc.to)).collect::<Vec<_>>(), vec![(4, 12), (20, 28)]);
        assert_eq!(crate::find::search(&items, &corpus, "sat down", 10).results[0].locators[0].from, 9);
        let separator = crate::find::search(&items, &corpus, " sat", 10);
        assert_eq!((separator.results[0].locators[0].from, separator.results[0].locators[0].to), (9, 12));
        let capped = crate::find::search(&items, &corpus, "cat sat", 0);
        assert_eq!((capped.total, capped.truncated), (1, true));
        let unchanged = crate::replace::replace_in_body(&body, "cat sat", "dog lay").unwrap();
        assert_eq!((unchanged.replaced, unchanged.spanning, unchanged.body), (0, 2, None));
        assert_eq!(crate::find::search(&items, &corpus, "down cat", 10).total, 0);
        let unchanged = crate::replace::replace_in_body(&body, "down cat", "joined").unwrap();
        assert_eq!((unchanged.replaced, unchanged.spanning, unchanged.body), (0, 0, None));
    }

    #[test]
    fn atom_consumers_separate_fields_and_count_only_prose() {
        let body = mixed().to_string();
        assert_eq!(
            super::super::document_text(&body).unwrap(),
            "A😀bewitched last words"
        );
        assert_eq!(
            super::super::document_lines(&body).unwrap(),
            "A😀bewitched\nlast words"
        );
        assert_eq!(
            crate::words::count_words(&super::super::document_text(&body).unwrap()),
            3
        );
        let fields = fields(&body).unwrap();
        assert_eq!(
            fields
                .iter()
                .map(|field| (field.field, field.from, field.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("prose", 1, "A😀be"),
                ("note", 0, "secret source"),
                ("prose", 7, "witched"),
                ("caption", 0, "secret caption"),
                ("alt", 0, "secret alt"),
                ("prose", 18, "last words")
            ]
        );
        assert_eq!(
            super::super::knowledge::quote_at(&body, 7, 14).as_deref(),
            Some("witched")
        );
        assert_eq!(
            super::super::knowledge::quote_at(&body, 2, 9).as_deref(),
            Some("😀be\u{fffc}wi")
        );
        assert_eq!(super::super::knowledge::quote_at(&body, 2, 3), None);
        assert_eq!(
            super::super::knowledge::quote_at(&body, 18, 22).as_deref(),
            Some("last")
        );
        assert_eq!(super::super::knowledge::quote_at(&body, 14, 19), None);
        assert!(crate::export::document_markdown(&body).is_none());
        assert!(crate::epub::document_xhtml(&body).is_none());
        assert!(crate::pdf::document_blocks(&body).is_none());
        let breaks =
            json!({"type":"doc","content":[{"type":"scene_break"},{"type":"scene_break"}]})
                .to_string();
        assert_eq!(super::super::document_text(&breaks).as_deref(), Some(""));
    }

    #[test]
    fn atom_consumers_reject_unknown_formats_and_duplicate_ids_from_shared_corpus() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../harness/fixtures/document-format.json"
        ))
        .unwrap();
        for case in cases {
            // Registry membership is a separate inventory check.
            if case["id"] == "unregistered-figure" {
                continue;
            }
            // The format corpus pins strict writes. Retained text-only bodies
            // also accept the legacy empty-run and mark representations.
            assert_eq!(
                read(&case["body"].to_string()).is_some(),
                case["valid"].as_bool().unwrap()
                    || matches!(case["id"].as_str(), Some("empty-text" | "unknown-mark" | "mark-attributes" | "duplicate-mark" | "empty-text-unknown-mark")),
                "{}",
                case["id"]
            );
        }
    }

    #[test]
    fn atom_consumers_search_and_replacement_never_cross_atoms_or_fields() {
        let body = mixed().to_string();
        let corpus = crate::find::Corpus {
            fields: HashMap::from([("scene".into(), fields(&body).unwrap())]),
            ..Default::default()
        };
        let items = [crate::find::SearchItem {
            id: "scene",
            kind: "scene",
            title: "Scene",
        }];
        for query in ["bewitched", "sourcewitched", "captionsecret"] {
            assert_eq!(
                crate::find::search(&items, &corpus, query, 10).total,
                0,
                "{query}"
            );
        }
        let capped = crate::find::search(&items, &corpus, "secret", 0);
        assert_eq!((capped.total, capped.truncated, capped.results.len()), (1, true, 0));
        let result = crate::find::search(&items, &corpus, "secret", 10);
        assert_eq!(result.results[0].matches, 3);
        assert!(result.results[0]
            .locators
            .iter()
            .all(|loc| loc.item_id == "scene" && loc.instance_id.is_some()));
        assert_eq!(
            result.results[0]
                .locators
                .iter()
                .map(|loc| (loc.field, loc.from, loc.to))
                .collect::<Vec<_>>(),
            vec![("note", 0, 6), ("caption", 0, 6), ("alt", 0, 6)]
        );
        let result = crate::find::search(&items, &corpus, "witched", 10);
        assert_eq!(
            (
                result.results[0].locators[0].from,
                result.results[0].locators[0].to
            ),
            (7, 14)
        );
        let unchanged = crate::replace::replace_in_body(&body, "bewitched", "other").unwrap();
        assert_eq!((unchanged.replaced, unchanged.spanning), (0, 0));
        assert!(unchanged.body.is_none());
        assert!(crate::replace::replace_in_body(&body, "secret", "public")
            .unwrap()
            .body
            .is_none());
        assert!(crate::replace::replace_in_field(
            &body,
            "0199ed16-8c00-7000-8000-000000000002",
            "caption",
            "",
            "public"
        )
        .unwrap()
        .body
        .is_none());
        let next = crate::replace::replace_in_field(
            &body,
            "0199ed16-8c00-7000-8000-000000000002",
            "caption",
            "secret",
            "public",
        )
        .unwrap()
        .body
        .unwrap();
        let mut expected = mixed();
        expected["content"][1]["attrs"]["caption"] = json!("public caption");
        assert_eq!(serde_json::from_str::<Value>(&next).unwrap(), expected);
        let next = crate::replace::replace_in_body(&body, "witched", "spelled")
            .unwrap()
            .body
            .unwrap();
        let mut expected = mixed();
        expected["content"][0]["content"][2]["text"] = json!("spelled");
        assert_eq!(serde_json::from_str::<Value>(&next).unwrap(), expected);
    }
}
