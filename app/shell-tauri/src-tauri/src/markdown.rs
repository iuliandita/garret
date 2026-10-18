use crate::publication_plan::{Note, Plan};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) const MARKER: &str = "<!-- garret-document-format: 18 -->\n\n";
const FIGURE: &str = "<!-- garret-figure: ";

fn label(note: &Note) -> String {
    format!("s{}-{}", note.scope + 1, note.number)
}

pub(crate) fn definition(note: &Note) -> String {
    let lines: Vec<_> = note
        .body
        .split('\n')
        .map(|line| crate::export::escape(line, true))
        .collect();
    format!("[^{}]: {}", label(note), lines.join("\n    "))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Figure {
    path: String,
    width: String,
    caption: String,
    alt: String,
}

fn figure_text(figure: &Figure) -> String {
    let metadata = serde_json::to_string(figure)
        .expect("figure strings")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    let image = format!(
        "![{}]({})",
        crate::export::escape(&figure.alt.replace(['\n', '\r'], " "), false),
        figure.path
    );
    let caption = crate::export::escape(&figure.caption.replace(['\n', '\r'], " "), false);
    format!("{FIGURE}{metadata} -->\n{image}\n*{caption}*")
}

pub(crate) fn document(id: &str, doc: &Value, plan: &Plan) -> (String, u64) {
    let mut blocks = Vec::new();
    let mut underlined = 0;
    for block in doc["content"].as_array().expect("planned document") {
        match block["type"].as_str().unwrap() {
            "paragraph" => {
                let mut text = String::new();
                for node in block
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if node["type"] == "endnote" {
                        let index = plan.references[id][node["attrs"]["id"].as_str().unwrap()];
                        text.push_str(&format!("[^{}]", label(&plan.notes[index])));
                    } else {
                        crate::export::append_inline(node, &mut text, &mut underlined);
                    }
                }
                if !text.trim_end().is_empty() {
                    blocks.push(text.trim_end().to_string());
                }
            }
            "figure" => {
                let attrs = &block["attrs"];
                blocks.push(figure_text(&Figure {
                    path: plan.assets[attrs["asset_id"].as_str().unwrap()]
                        .href
                        .clone(),
                    width: attrs["width"].as_str().unwrap().into(),
                    caption: attrs["caption"].as_str().unwrap().into(),
                    alt: attrs["alt"].as_str().unwrap().into(),
                }));
            }
            "scene_break" => blocks.push("---".into()),
            _ => unreachable!("planned block"),
        }
    }
    (blocks.join("\n\n"), underlined)
}

pub(crate) struct Parsed {
    pub imported: crate::import::Imported,
    pub assets: BTreeMap<String, Vec<u8>>,
    pub inspected_assets: BTreeMap<String, crate::store::figure_assets::FigureAsset>,
}

pub(crate) const MAX_PACKAGE_ASSETS: usize = 128;
pub(crate) const MAX_PACKAGE_BYTES: usize = 256 * 1024 * 1024;

pub(crate) fn admit_assets(count: usize, total: usize) -> Result<(), String> {
    if count > MAX_PACKAGE_ASSETS || total > MAX_PACKAGE_BYTES { return Err("Markdown package asset limit exceeded".into()); }
    Ok(())
}

pub(crate) fn is_dialect(source: &str) -> bool {
    source
        .trim_start_matches('\u{feff}')
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("<!-- garret-document-format:"))
}

fn uuid() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub(crate) fn parse(
    source: &str,
    stem: &str,
    mut resolve: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<Parsed, String> {
    let source = source.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let source = source
        .strip_prefix(MARKER)
        .ok_or("unsupported Markdown document format marker")?;
    let mut definitions = HashMap::new();
    let mut lines = source.lines().peekable();
    let mut remaining = Vec::new();
    while let Some(line) = lines.next() {
        if let Some((key, first)) = line.strip_prefix("[^").and_then(|s| s.split_once("]: ")) {
            if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
                return Err("invalid footnote label".into());
            }
            let mut body = vec![crate::import::title_text(first)];
            while let Some(next) = lines.peek().and_then(|line| line.strip_prefix("    ")) {
                body.push(crate::import::title_text(next));
                lines.next();
            }
            let body = body.join("\n");
            if body.len() > crate::store::document_format::MAX_ATTRIBUTE_BYTES
                || definitions.insert(key.to_string(), body).is_some()
            {
                return Err("duplicate or oversized footnote definition".into());
            }
        } else {
            remaining.push(line);
        }
    }
    let mut assets = BTreeMap::new();
    let mut inspected_assets: BTreeMap<String, crate::store::figure_assets::FigureAsset> = BTreeMap::new();
    let mut asset_bytes = 0usize;
    let mut blocks = HashMap::new();
    let mut clean = String::new();
    let mut lines = remaining.into_iter().peekable();
    while let Some(line) = lines.next() {
        let node = if let Some(metadata) = line.strip_prefix(FIGURE) {
            if metadata.len() > 12 * crate::store::document_format::MAX_ATTRIBUTE_BYTES + 1024 {
                return Err("figure metadata exceeds limit".into());
            }
            let figure: Figure = serde_json::from_str(
                metadata
                    .strip_suffix(" -->")
                    .ok_or("invalid figure metadata")?,
            )
            .map_err(|e| e.to_string())?;
            if !matches!(figure.width.as_str(), "full" | "half" | "page")
                || figure.caption.len() > crate::store::document_format::MAX_ATTRIBUTE_BYTES
                || figure.alt.len() > crate::store::document_format::MAX_ATTRIBUTE_BYTES
            {
                return Err("invalid figure placement or text".into());
            }
            let visible = format!(
                "{line}\n{}\n{}",
                lines.next().ok_or("missing figure image")?,
                lines.next().ok_or("missing figure caption")?
            );
            if visible != figure_text(&figure) {
                return Err("figure metadata and readable caption or image disagree".into());
            }
            let id = if let Some(asset) = inspected_assets.get(&figure.path) {
                asset.id.clone()
            } else {
                let id = uuid();
                admit_assets(assets.len() + 1, asset_bytes)?;
                let bytes = resolve(&figure.path)?;
                asset_bytes = asset_bytes.checked_add(bytes.len()).ok_or("Markdown package asset limit exceeded")?;
                admit_assets(assets.len() + 1, asset_bytes)?;
                inspected_assets.insert(figure.path.clone(), crate::figures::prepare_asset(&bytes, id.clone())?);
                assets.insert(figure.path, bytes);
                id
            };
            Some(
                json!({"type":"figure","attrs":{"id":uuid(),"asset_id":id,"width":figure.width,"caption":figure.caption,"alt":figure.alt}}),
            )
        } else if line == "---" {
            Some(json!({"type":"scene_break"}))
        } else if line.starts_with("<!-- garret-") {
            return Err("unknown Markdown metadata".into());
        } else {
            None
        };
        if let Some(node) = node {
            let token = format!("GARRET{}", uuid().replace('-', ""));
            blocks.insert(token.clone(), node);
            clean.push_str(&format!("\n\n{token}\n\n"));
        } else {
            clean.push_str(line);
            clean.push('\n');
        }
    }
    let mut used = HashSet::new();
    let imported = crate::import::parse_with(&clean, stem, |paragraphs| {
        let mut content = Vec::new();
        for paragraph in paragraphs {
            if let Some(block) = blocks.get(paragraph) {
                content.push(block.clone());
                continue;
            }
            let mut nodes = Vec::new();
            let bytes = paragraph.as_bytes();
            let mut start = 0;
            let mut at = 0;
            while at < bytes.len() {
                if bytes[at] == b'\\' {
                    at += 1;
                    if at < bytes.len() {
                        at += paragraph[at..].chars().next().unwrap().len_utf8();
                    }
                    continue;
                }
                if paragraph[at..].starts_with("[^") {
                    let end = paragraph[at + 2..]
                        .find(']')
                        .map(|n| n + at + 2)
                        .ok_or("unclosed footnote reference")?;
                    let key = &paragraph[at + 2..end];
                    let body = definitions
                        .get(key)
                        .ok_or("unresolved footnote reference")?;
                    if let Some(p) = crate::import::paragraph_node(&paragraph[start..at]) {
                        nodes.extend(p["content"].as_array().unwrap().clone());
                    }
                    used.insert(key.to_string());
                    nodes.push(
                        json!({"type":"endnote","attrs":{"id":uuid(),"fmt":"text","body":body}}),
                    );
                    at = end + 1;
                    start = at;
                } else {
                    at += paragraph[at..].chars().next().unwrap().len_utf8();
                }
            }
            if let Some(p) = crate::import::paragraph_node(&paragraph[start..]) {
                nodes.extend(p["content"].as_array().unwrap().clone());
            }
            if !nodes.is_empty() {
                content.push(json!({"type":"paragraph","content":nodes}));
            }
        }
        if content.is_empty() {
            return Ok(None);
        }
        let doc = json!({"type":"doc","content":content});
        crate::store::document_format::validate(&doc, true, &inspected_assets.values().map(|asset| asset.id.clone()).collect())
            .map_err(|e| e.to_string())?;
        Ok(Some(doc.to_string()))
    })?;
    if definitions.keys().any(|key| !used.contains(key)) {
        return Err("unreferenced footnote definition".into());
    }
    Ok(Parsed {
        imported,
        assets,
        inspected_assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import_source(source: &str) -> crate::import::Imported {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("book.md");
        std::fs::write(&path, source).unwrap();
        let library = root.path().join("books");
        std::fs::create_dir(&library).unwrap();
        let outcome = crate::import_path(root.path(), &library, &path, &crate::strings::Strings::english()).unwrap();
        let store = crate::store::Store::open_readonly(std::path::Path::new(&outcome.summary.path)).unwrap();
        let items = store.items().unwrap();
        let imported = items.iter().map(|item| crate::import::ImportedItem {
            parent: item.parent_id.as_ref().map(|id| items.iter().position(|item| &item.id == id).unwrap()),
            item_type: match item.item_type.as_str() { "part" => "part", "chapter" => "chapter", "scene" => "scene", _ => panic!("unexpected imported item") },
            title: item.title.clone(),
            body: (item.item_type == "scene").then(|| store.load_doc(&item.id).unwrap().body),
        }).collect();
        crate::import::Imported { name: outcome.summary.name, items: imported, derived_contents: outcome.derived_contents }
    }

    #[test]
    fn unmarked_garret_comments_import_as_ordinary_prose() {
        for comment in ["<!-- garret-figure: arbitrary comment -->", "<!-- garret-document-format: 18 -->"] {
            let source = format!("# Book\n\n## Scene\n\nprose\n{comment}\n");
            assert!(!is_dialect(&source));
            assert_eq!(import_source(&source), crate::import::parse(&source, "book"));
        }
        assert!(is_dialect("<!-- garret-document-format: 19 -->\n# Book"));
    }

    #[test]
    fn dialect_refuses_unknown_metadata_unresolved_notes_and_unbounded_placements() {
        assert!(admit_assets(MAX_PACKAGE_ASSETS, MAX_PACKAGE_BYTES).is_ok());
        assert!(admit_assets(MAX_PACKAGE_ASSETS + 1, 0).is_err());
        assert!(admit_assets(1, MAX_PACKAGE_BYTES + 1).is_err());
        let read =
            |source: &str| parse(source, "book", |_| Ok(crate::figures::tests::PNG.to_vec()));
        let valid = format!("{MARKER}# Book\n\n## Scene\n\nliteral \\[^1\\] [^s1-1]\n\n[^s1-1]: note\\*\n    next\n");
        assert!(read(&valid).is_ok());
        for source in [
            valid.clone(),
            format!("\u{feff}{valid}"),
            valid.replace('\n', "\r\n"),
            format!("\u{feff}{}", valid.replace('\n', "\r\n")),
        ] {
            assert!(is_dialect(&source));
            let parsed = read(&source).unwrap();
            assert_eq!(parsed.imported.name, "Book");
            assert_eq!(parsed.imported.items.len(), 1);
            let doc: Value =
                serde_json::from_str(parsed.imported.items[0].body.as_ref().unwrap()).unwrap();
            assert_eq!(
                doc["content"][0]["content"][1]["attrs"]["body"],
                "note*\nnext"
            );
            let activated = import_source(&source);
            assert!(activated.items[0].body.as_ref().unwrap().contains("endnote"));
        }
        let ordinary = "# Book\n\n## Scene\n\nordinary [^1]\n\n---\n\n![image](assets/image.png)\n";
        for source in [
            ordinary.to_string(),
            format!("\u{feff}{ordinary}"),
            ordinary.replace('\n', "\r\n"),
            format!("\u{feff}{}", ordinary.replace('\n', "\r\n")),
        ] {
            assert!(!is_dialect(&source));
            assert_eq!(
                import_source(&source),
                crate::import::parse(&source, "book")
            );
        }
        for source in [
            valid.replace("18", "19"),
            valid.replace("s1-1", "bad!"),
            valid.replace("[^s1-1]:", "[^other]:"),
            format!("{valid}\n[^s1-1]: duplicate\n"),
            format!("{valid}\n[^extra]: unused\n"),
            format!("{MARKER}# Book\n\n## Scene\n\ntext[^missing]\n"),
            format!("{MARKER}# Book\n\n<!-- garret-unknown: x -->\n"),
            format!(
                "{MARKER}# Book\n\nx[^s1-1]\n\n[^s1-1]: {}",
                "x".repeat(crate::store::document_format::MAX_ATTRIBUTE_BYTES + 1)
            ),
        ] {
            assert!(read(&source).is_err());
        }
        let figure = Figure {
            path: "assets/image.png".into(),
            width: "half".into(),
            caption: "caption\n<!-- strange -->".into(),
            alt: "view [^1] \"quoted\"".into(),
        };
        let text = format!("{MARKER}# Book\n\n## Scene\n\n{}\n", figure_text(&figure));
        assert!(read(&text).is_ok());
        let oversized = format!("{MARKER}# Book\n\n## Scene\n\n{}", (0..=MAX_PACKAGE_ASSETS)
            .map(|i| figure_text(&Figure { path: format!("assets/{i}.png"), width: "half".into(), caption: "".into(), alt: "View".into() }))
            .collect::<Vec<_>>().join("\n\n"));
        let mut resolved = 0;
        assert!(parse(&oversized, "book", |_| {
            resolved += 1;
            Ok(crate::figures::tests::PNG.to_vec())
        }).is_err());
        assert_eq!(resolved, MAX_PACKAGE_ASSETS);
        assert!(parse(&text, "book", |_| Ok(b"not an image".to_vec())).is_err());
        let resolved = std::cell::Cell::new(false);
        let invalid = parse(&text.replace("half", "float"), "book", |_| {
            resolved.set(true);
            Ok(crate::figures::tests::PNG.to_vec())
        });
        assert!(invalid.is_err());
        assert!(
            !resolved.get(),
            "invalid placement must refuse before opening assets"
        );
        assert!(read(&text.replace("*caption", "*altered")).is_err());
        assert!(read(&text.replace("\"width\":", "\"unknown\":0,\"width\":")).is_err());
        let long_path = Figure {
            path: "x".repeat(12 * crate::store::document_format::MAX_ATTRIBUTE_BYTES + 1024),
            width: "full".into(),
            caption: String::new(),
            alt: "view".into(),
        };
        assert!(read(&format!("{MARKER}# Book\n\n{}\n", figure_text(&long_path))).is_err());
        let large = Figure {
            caption: "x".repeat(crate::store::document_format::MAX_ATTRIBUTE_BYTES + 1),
            ..figure
        };
        assert!(read(&format!("{MARKER}# Book\n\n{}\n", figure_text(&large))).is_err());
    }
}
