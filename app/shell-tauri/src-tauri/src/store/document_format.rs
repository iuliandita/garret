use super::{Result, Store, StoreError, TIMELINE_TYPE};
use serde_json::{Map, Value};
use std::collections::HashSet;

#[cfg(test)]
mod tests;

/// Reserved document boundary, shared by the reader and registry migration.
pub const SCHEMA_VERSION: i64 = 18;

pub const MAX_ATTRIBUTE_BYTES: usize = 64 * 1024;

pub fn new_nodes_allowed() -> bool {
    false
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidDocument(reason.into())
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("expected document object"))?;
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(invalid("unknown document field"));
    }
    Ok(object)
}

fn uuid(value: &Value) -> Result<&str> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid("invalid instance or asset ID"))?;
    let bytes = text.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => (b'1'..=b'8').contains(c),
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
    {
        return Err(invalid("invalid instance or asset ID"));
    }
    Ok(text)
}

fn bounded_text(value: &Value) -> Result<()> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid("invalid attribute text"))?;
    if text.len() > MAX_ATTRIBUTE_BYTES {
        return Err(invalid("attribute text exceeds limit"));
    }
    Ok(())
}

pub fn validate(value: &Value, allow_new: bool, assets: &HashSet<String>) -> Result<()> {
    let root = object(value, &["type", "content"])?;
    if root.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(invalid("expected doc root"));
    }
    let blocks = root
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("expected document content"))?;
    let mut ids = HashSet::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("paragraph") => {
                let paragraph = object(block, &["type", "content"])?;
                if let Some(content) = paragraph.get("content") {
                    for node in content
                        .as_array()
                        .ok_or_else(|| invalid("invalid paragraph content"))?
                    {
                        match node.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                let text = object(node, &["type", "text", "marks"])?;
                                if text
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .is_none_or(str::is_empty)
                                {
                                    return Err(invalid("empty or invalid text node"));
                                }
                                if let Some(marks) = text.get("marks") {
                                    let mut seen = HashSet::new();
                                    for mark in
                                        marks.as_array().ok_or_else(|| invalid("invalid marks"))?
                                    {
                                        let mark = object(mark, &["type"])?;
                                        let name =
                                            mark.get("type").and_then(Value::as_str).unwrap_or("");
                                        if !["em", "strong", "underline"].contains(&name)
                                            || !seen.insert(name)
                                        {
                                            return Err(invalid("unknown or duplicate mark"));
                                        }
                                    }
                                }
                            }
                            Some("endnote") => {
                                if !allow_new {
                                    return Err(invalid("new document nodes are disabled"));
                                }
                                object(node, &["type", "attrs"])?;
                                let attrs = object(&node["attrs"], &["id", "fmt", "body"])?;
                                if !ids.insert(uuid(&node["attrs"]["id"])?) {
                                    return Err(invalid("duplicate instance ID"));
                                }
                                if attrs.get("fmt").and_then(Value::as_str) != Some("text") {
                                    return Err(invalid("unsupported endnote format"));
                                }
                                bounded_text(&node["attrs"]["body"])?;
                            }
                            _ => return Err(invalid("unsupported inline node")),
                        }
                    }
                }
            }
            Some("figure") => {
                if !allow_new {
                    return Err(invalid("new document nodes are disabled"));
                }
                object(block, &["type", "attrs"])?;
                object(
                    &block["attrs"],
                    &["id", "asset_id", "width", "caption", "alt"],
                )?;
                if !ids.insert(uuid(&block["attrs"]["id"])?) {
                    return Err(invalid("duplicate instance ID"));
                }
                let asset = uuid(&block["attrs"]["asset_id"])?;
                if !assets.contains(asset) {
                    return Err(invalid("unregistered figure asset"));
                }
                if !matches!(
                    block["attrs"]["width"].as_str(),
                    Some("full" | "half" | "page")
                ) {
                    return Err(invalid("invalid figure width"));
                }
                bounded_text(&block["attrs"]["caption"])?;
                bounded_text(&block["attrs"]["alt"])?;
            }
            Some("scene_break") => {
                if !allow_new {
                    return Err(invalid("new document nodes are disabled"));
                }
                object(block, &["type"])?;
            }
            _ => return Err(invalid("unsupported block node")),
        }
    }
    Ok(())
}

pub fn validate_write(body: &str) -> Result<()> {
    let value = serde_json::from_str(body).map_err(|_| invalid("invalid document JSON"))?;
    validate(&value, new_nodes_allowed(), &HashSet::new())
}

pub fn validate_import(rows: &[super::ImportRow<'_>]) -> Result<()> {
    for (_, _, _, body) in rows {
        if let Some(body) = body {
            validate_write(body)?;
        }
    }
    Ok(())
}

pub(crate) fn validate_timeline(value: &Value) -> Result<()> {
    if value.get("type").and_then(Value::as_str) == Some("doc") {
        return Err(invalid("a timeline cannot hold a prose document"));
    }
    Ok(())
}

impl Store {
    pub(crate) fn validate_body_write(&self, item_id: &str, body: &str) -> Result<()> {
        if self.item_type(item_id)?.as_deref() == Some(TIMELINE_TYPE) {
            let value: Value =
                serde_json::from_str(body).map_err(|_| invalid("invalid timeline JSON"))?;
            return validate_timeline(&value);
        }
        self.validate_body_read(item_id, body)?;
        if self.user_version()? >= SCHEMA_VERSION {
            let value = serde_json::from_str(body).map_err(|_| invalid("invalid document JSON"))?;
            let assets = self.figure_assets()?.into_iter().map(|asset| asset.id).collect();
            validate(&value, true, &assets)?;
        }
        if self.user_version()? >= SCHEMA_VERSION && !new_nodes_allowed() {
            let current = self.load_doc(item_id)?.body;
            if atoms(&current)? != atoms(body)? {
                return Err(invalid(&format!("{item_id}: existing document atoms are read-only in this build")));
            }
        }
        Ok(())
    }

    pub(crate) fn validate_body_read(&self, item_id: &str, body: &str) -> Result<()> {
        if self.item_type(item_id)?.as_deref() == Some(TIMELINE_TYPE) {
            let value: Value = serde_json::from_str(body).map_err(|_| invalid("invalid timeline JSON"))?;
            return validate_timeline(&value);
        }
        let result = if self.user_version()? >= SCHEMA_VERSION {
            let assets = self.figure_assets()?.into_iter().map(|asset| asset.id).collect();
            let value = super::document_fields::read(body).ok_or_else(|| invalid("unsupported retained document"))?;
            if atoms(body)?.is_empty() {
                Ok(())
            } else {
                validate(&value, true, &assets)
            }
        } else {
            validate_write(body)
        };
        result.map_err(|error| match error {
            StoreError::InvalidDocument(reason) => invalid(&format!("{item_id}: {reason}")),
            other => other,
        })
    }

    pub(crate) fn validate_retained_formats(&self) -> Result<()> {
        for (id, body) in self.documents()? {
            if self.user_version()? >= SCHEMA_VERSION {
                self.validate_body_read(&id, &body)?;
            } else {
                refuse_new_nodes(&id, &body)?;
            }
        }
        if self.user_version()? >= 2 {
            let mut stmt = self.conn.prepare(
                "SELECT v.item_id, b.body FROM doc_version v JOIN blob b ON b.key = v.blob_key",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (id, body) = row?;
                if self.user_version()? >= SCHEMA_VERSION {
                    self.validate_body_read(&id, &body)?;
                } else {
                    refuse_new_nodes(&id, &body)?;
                }
            }
        }
        Ok(())
    }
}

fn refuse_new_nodes(item_id: &str, body: &str) -> Result<()> {
    fn contains_new(value: &Value) -> bool {
        match value {
            Value::Object(object) => {
                matches!(object.get("type").and_then(Value::as_str), Some("endnote" | "figure" | "scene_break"))
                    || object.values().any(contains_new)
            }
            Value::Array(values) => values.iter().any(contains_new),
            _ => false,
        }
    }
    if !new_nodes_allowed() && serde_json::from_str::<Value>(body).is_ok_and(|value| contains_new(&value)) {
        return Err(invalid(&format!("{item_id}: new document nodes are disabled")));
    }
    Ok(())
}

// Keep atom payloads, order and multiplicity; prose edits may move their positions.
fn atoms(body: &str) -> Result<Vec<String>> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        if matches!(value["type"].as_str(), Some("endnote" | "figure" | "scene_break")) {
            out.push(value.to_string());
        }
        if let Some(children) = value["content"].as_array() {
            for child in children { walk(child, out); }
        }
    }
    let value: Value = serde_json::from_str(body).map_err(|_| invalid("invalid document JSON"))?;
    let mut out = Vec::new();
    walk(&value, &mut out);
    Ok(out)
}
