use super::{now_ms, Store};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const SCHEMA_V16: &str = "
CREATE TABLE research_resource (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source_note TEXT NOT NULL,
  citation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX research_resource_hash ON research_resource(sha256);
CREATE TABLE knowledge_link (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_caption TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_caption TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT NOT NULL,
  citation TEXT NOT NULL,
  anchor_item_id TEXT,
  anchor_rev INTEGER,
  anchor_from INTEGER,
  anchor_to INTEGER,
  anchor_quote TEXT,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX knowledge_link_source ON knowledge_link(source_kind, source_id, removed_at);
CREATE INDEX knowledge_link_target ON knowledge_link(target_kind, target_id, removed_at);
";

pub const MAX_RESOURCES: i64 = 2_000;
pub const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_UNIQUE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_LINKS: i64 = 10_000;
const MAX_SHORT: usize = 200;
const MAX_TEXT: usize = 2_000;
const MAX_QUOTE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Endpoint {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PassageAnchor {
    pub item_id: String,
    pub doc_rev: i64,
    pub from: i64,
    pub to: i64,
    pub quote: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LinkDraft {
    pub source: Endpoint,
    pub target: Endpoint,
    pub label: String,
    pub note: String,
    pub citation: String,
    pub anchor: Option<PassageAnchor>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub source: Endpoint,
    pub target: Endpoint,
    pub source_caption: String,
    pub target_caption: String,
    pub source_available: bool,
    pub target_available: bool,
    pub label: String,
    pub note: String,
    pub citation: String,
    pub anchor: Option<PassageAnchor>,
    pub anchor_stale: bool,
    pub created_at: i64,
    pub removed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Resource {
    pub id: String,
    pub title: String,
    pub original_name: String,
    pub media_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub source_note: String,
    pub citation: String,
    pub created_at: i64,
    pub removed_at: Option<i64>,
}

fn bounded(value: &str, max: usize, name: &str, required: bool) -> Result<String, String> {
    let value = value.trim();
    if (required && value.is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(format!(
            "{name} must be plain text of at most {max} characters"
        ));
    }
    Ok(value.to_owned())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_endpoint(endpoint: &Endpoint) -> bool {
    matches!(endpoint.kind.as_str(), "cast" | "item" | "resource")
        && !endpoint.id.is_empty()
        && endpoint.id.len() <= 128
        && endpoint
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn trashed_ids(conn: &rusqlite::Connection) -> Result<HashSet<String>, String> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE trashed(id) AS (
           SELECT id FROM (SELECT id FROM item WHERE parent_id IS NULL AND type = ?1 ORDER BY position LIMIT 1)
           UNION SELECT item.id FROM item JOIN trashed ON item.parent_id = trashed.id
         ) SELECT id FROM trashed"
    ).map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([super::TRASH_TYPE], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

/// ProseMirror positions count UTF-16 units and one unit on either side of a
/// paragraph. Marks carry no size. Refuse a range crossing blocks or splitting
/// a surrogate, so a stored quote cannot silently describe another passage.
pub fn quote_at(body: &str, from: i64, to: i64) -> Option<String> {
    if from < 0 || to <= from {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if value.get("type")?.as_str()? != "doc" {
        return None;
    }
    let mut paragraph_start = 0i64;
    for block in value.get("content")?.as_array()? {
        if block.get("type")?.as_str()? != "paragraph" {
            return None;
        }
        let mut content = String::new();
        if let Some(nodes) = block.get("content") {
            for node in nodes.as_array()? {
                if node.get("type")?.as_str()? != "text" {
                    return None;
                }
                content.push_str(node.get("text")?.as_str()?);
            }
        }
        let units: Vec<u16> = content.encode_utf16().collect();
        let start = paragraph_start + 1;
        let end = start + units.len() as i64;
        if from >= start && to <= end {
            return String::from_utf16(&units[(from - start) as usize..(to - start) as usize]).ok();
        }
        paragraph_start = end + 1;
    }
    None
}

impl Store {
    fn knowledge_caption(
        &self,
        endpoint: &Endpoint,
        trashed: &HashSet<String>,
    ) -> Result<Option<String>, String> {
        if !valid_endpoint(endpoint) {
            return Err("link endpoint is invalid".into());
        }
        match endpoint.kind.as_str() {
            "cast" => self
                .conn
                .query_row(
                    "SELECT name FROM cast_member WHERE id = ?1 AND deleted_at IS NULL",
                    [&endpoint.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string()),
            "item" => {
                if trashed.contains(&endpoint.id) {
                    return Ok(None);
                }
                self.conn
                    .query_row(
                        "SELECT title FROM item WHERE id = ?1",
                        [&endpoint.id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())
            }
            "resource" => self
                .conn
                .query_row(
                    "SELECT title FROM research_resource WHERE id = ?1 AND removed_at IS NULL",
                    [&endpoint.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string()),
            _ => Err("link endpoint is invalid".into()),
        }
    }

    pub fn knowledge_links(
        &self,
        endpoint: Option<&Endpoint>,
        include_removed: bool,
    ) -> Result<Vec<Link>, String> {
        if let Some(endpoint) = endpoint {
            if !valid_endpoint(endpoint) {
                return Err("link endpoint is invalid".into());
            }
        }
        let trashed = trashed_ids(&self.conn)?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, source_kind, source_id, source_caption, target_kind, target_id,
                    target_caption, label, note, citation, anchor_item_id, anchor_rev,
                    anchor_from, anchor_to, anchor_quote, created_at, removed_at
               FROM knowledge_link ORDER BY created_at, id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let anchor_item_id: Option<String> = row.get(10)?;
                let anchor = if let Some(item_id) = anchor_item_id {
                    Some(PassageAnchor {
                        item_id,
                        doc_rev: row.get(11)?,
                        from: row.get(12)?,
                        to: row.get(13)?,
                        quote: row.get(14)?,
                    })
                } else {
                    None
                };
                Ok(Link {
                    id: row.get(0)?,
                    source: Endpoint {
                        kind: row.get(1)?,
                        id: row.get(2)?,
                    },
                    source_caption: row.get(3)?,
                    target: Endpoint {
                        kind: row.get(4)?,
                        id: row.get(5)?,
                    },
                    target_caption: row.get(6)?,
                    label: row.get(7)?,
                    note: row.get(8)?,
                    citation: row.get(9)?,
                    anchor,
                    anchor_stale: false,
                    source_available: false,
                    target_available: false,
                    created_at: row.get(15)?,
                    removed_at: row.get(16)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let mut link = row.map_err(|e| e.to_string())?;
            if !include_removed && link.removed_at.is_some() {
                continue;
            }
            if let Some(wanted) = endpoint {
                if &link.source != wanted && &link.target != wanted {
                    continue;
                }
            }
            if !valid_endpoint(&link.source) || !valid_endpoint(&link.target) {
                return Err("stored link endpoint is malformed; links were preserved".into());
            }
            if let Some(caption) = self.knowledge_caption(&link.source, &trashed)? {
                link.source_caption = caption;
                link.source_available = true;
            }
            if let Some(caption) = self.knowledge_caption(&link.target, &trashed)? {
                link.target_caption = caption;
                link.target_available = true;
            }
            if let Some(anchor) = &link.anchor {
                let saved: Option<(String, i64)> = self
                    .conn
                    .query_row(
                        "SELECT body, rev FROM doc WHERE item_id = ?1",
                        [&anchor.item_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                link.anchor_stale = saved.as_ref().is_none_or(|(body, rev)| {
                    *rev != anchor.doc_rev
                        || quote_at(body, anchor.from, anchor.to).as_deref()
                            != Some(anchor.quote.as_str())
                }) || trashed.contains(&anchor.item_id);
            }
            out.push(link);
            if out.len() > MAX_LINKS as usize {
                return Err("stored link count exceeds this build's limit".into());
            }
        }
        Ok(out)
    }

    pub fn knowledge_link_create(&self, draft: &LinkDraft) -> Result<Link, String> {
        if !valid_endpoint(&draft.source) || !valid_endpoint(&draft.target) {
            return Err("link endpoint is invalid".into());
        }
        let label = bounded(&draft.label, MAX_SHORT, "relationship label", true)?;
        let note = bounded(&draft.note, MAX_TEXT, "relationship note", false)?;
        let citation = bounded(&draft.citation, MAX_TEXT, "citation", false)?;
        let anchor = draft.anchor.as_ref();
        if let Some(anchor) = anchor {
            if anchor.from < 0
                || anchor.to <= anchor.from
                || anchor.quote.is_empty()
                || anchor.quote.chars().count() > MAX_QUOTE
                || !(draft.source.kind == "item" && draft.source.id == anchor.item_id
                    || draft.target.kind == "item" && draft.target.id == anchor.item_id)
            {
                return Err("passage anchor is invalid".into());
            }
        }
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let created = (|| {
            let count: i64 = self
                .conn
                .query_row("SELECT COUNT(*) FROM knowledge_link", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if count >= MAX_LINKS {
                return Err("this book has reached its retained link limit".into());
            }
            let trashed = trashed_ids(&self.conn)?;
            let source_caption = self
                .knowledge_caption(&draft.source, &trashed)?
                .ok_or("source is unavailable; no link was added")?;
            let target_caption = self
                .knowledge_caption(&draft.target, &trashed)?
                .ok_or("target is unavailable; no link was added")?;
            if let Some(anchor) = anchor {
                let saved: Option<(String, i64)> = self
                    .conn
                    .query_row(
                        "SELECT body, rev FROM doc WHERE item_id = ?1",
                        [&anchor.item_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if saved.as_ref().is_none_or(|(body, rev)| {
                    *rev != anchor.doc_rev
                        || quote_at(body, anchor.from, anchor.to).as_deref()
                            != Some(anchor.quote.as_str())
                }) || trashed.contains(&anchor.item_id)
                {
                    return Err(
                        "passage changed before the link was saved; no link was added".into(),
                    );
                }
            }
            let id = uuid::Uuid::now_v7().to_string();
            let now = now_ms();
            self.conn.execute(
                "INSERT INTO knowledge_link (id, source_kind, source_id, source_caption,
                 target_kind, target_id, target_caption, label, note, citation, anchor_item_id,
                 anchor_rev, anchor_from, anchor_to, anchor_quote, created_at, removed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL)",
                params![id, draft.source.kind, draft.source.id, source_caption,
                    draft.target.kind, draft.target.id, target_caption, label, note, citation,
                    anchor.map(|a| &a.item_id), anchor.map(|a| a.doc_rev), anchor.map(|a| a.from),
                    anchor.map(|a| a.to), anchor.map(|a| &a.quote), now],
            ).map_err(|e| e.to_string())?;
            Ok(id)
        })();
        match created {
            Ok(id) => {
                self.conn
                    .execute_batch("COMMIT")
                    .map_err(|e| e.to_string())?;
                self.knowledge_links(None, false)?
                    .into_iter()
                    .find(|link| link.id == id)
                    .ok_or("saved link could not be read back".into())
            }
            Err(error) => {
                self.conn
                    .execute_batch("ROLLBACK")
                    .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
                Err(error)
            }
        }
    }

    pub fn knowledge_link_remove(&self, id: &str) -> Result<(), String> {
        let changed = self
            .conn
            .execute(
                "UPDATE knowledge_link SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL",
                params![id, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("link is absent or already removed".into());
        }
        Ok(())
    }

    pub fn research_resources(&self) -> Result<Vec<Resource>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, original_name, media_type, bytes, sha256, source_note,
                    citation, created_at, removed_at FROM research_resource ORDER BY created_at, id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Resource {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    original_name: row.get(2)?,
                    media_type: row.get(3)?,
                    bytes: row.get::<_, i64>(4)? as u64,
                    sha256: row.get(5)?,
                    source_note: row.get(6)?,
                    citation: row.get(7)?,
                    created_at: row.get(8)?,
                    removed_at: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let resource = row.map_err(|e| e.to_string())?;
            if !valid_hash(&resource.sha256) || resource.bytes > MAX_RESOURCE_BYTES {
                return Err(
                    "stored research inventory is malformed; originals were preserved".into(),
                );
            }
            out.push(resource);
            if out.len() > MAX_RESOURCES as usize {
                return Err("stored research inventory exceeds this build's limit".into());
            }
        }
        Ok(out)
    }

    pub fn research_resource_add(
        &self,
        title: &str,
        original_name: &str,
        media_type: &str,
        bytes: u64,
        sha256: &str,
        source_note: &str,
        citation: &str,
    ) -> Result<Resource, String> {
        let title = bounded(title, MAX_SHORT, "resource title", true)?;
        let original_name = bounded(original_name, MAX_SHORT, "original filename", true)?;
        if original_name.contains('/') || original_name.contains('\\') {
            return Err("original filename must not include a directory".into());
        }
        let media_type = bounded(media_type, MAX_SHORT, "media type", true)?;
        let source_note = bounded(source_note, MAX_TEXT, "source note", false)?;
        let citation = bounded(citation, MAX_TEXT, "citation", false)?;
        if !valid_hash(sha256) || bytes == 0 || bytes > MAX_RESOURCE_BYTES {
            return Err("resource hash or size is invalid".into());
        }
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let created = (|| {
            let existing = self.research_resources()?;
            if existing.len() >= MAX_RESOURCES as usize {
                return Err("this book has reached its retained research file limit".into());
            }
            let mut unique = std::collections::HashMap::new();
            for resource in &existing {
                if let Some(prior) = unique.insert(resource.sha256.as_str(), resource.bytes) {
                    if prior != resource.bytes {
                        return Err("stored research hash has conflicting sizes".into());
                    }
                }
            }
            if let Some(prior) = unique.get(sha256) {
                if *prior != bytes {
                    return Err("resource hash has a conflicting size".into());
                }
            } else {
                let used: u64 = unique.values().sum();
                if used
                    .checked_add(bytes)
                    .is_none_or(|total| total > MAX_UNIQUE_BYTES)
                {
                    return Err("this book has reached its retained research byte limit".into());
                }
            }
            let id = uuid::Uuid::now_v7().to_string();
            self.conn
                .execute(
                    "INSERT INTO research_resource (id, title, original_name, media_type, bytes,
                 sha256, source_note, citation, created_at, removed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
                    params![
                        id,
                        title,
                        original_name,
                        media_type,
                        bytes as i64,
                        sha256,
                        source_note,
                        citation,
                        now_ms()
                    ],
                )
                .map_err(|e| e.to_string())?;
            Ok(id)
        })();
        match created {
            Ok(id) => {
                self.conn
                    .execute_batch("COMMIT")
                    .map_err(|e| e.to_string())?;
                self.research_resources()?
                    .into_iter()
                    .find(|resource| resource.id == id)
                    .ok_or("saved resource could not be read back".into())
            }
            Err(error) => {
                self.conn
                    .execute_batch("ROLLBACK")
                    .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
                Err(error)
            }
        }
    }

    pub fn research_resource_remove(&self, id: &str) -> Result<(), String> {
        let changed = self
            .conn
            .execute(
                "UPDATE research_resource SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL",
                params![id, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("research file is absent or already removed".into());
        }
        Ok(())
    }

    pub fn research_resource_restore(&self, id: &str) -> Result<(), String> {
        let changed = self.conn.execute(
            "UPDATE research_resource SET removed_at = NULL WHERE id = ?1 AND removed_at IS NOT NULL",
            [id],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("research file is absent or already available".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FlushEntry;

    #[test]
    fn passage_positions_are_utf16_and_marks_have_no_extra_size() {
        let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A😀"},{"type":"text","marks":[{"type":"em"}],"text":"éz"}]},{"type":"paragraph","content":[{"type":"text","text":"last"}]}]}"#;
        assert_eq!(quote_at(body, 2, 6).as_deref(), Some("😀é"));
        assert_eq!(quote_at(body, 9, 13).as_deref(), Some("last"));
        assert_eq!(quote_at(body, 2, 3), None); // half a surrogate pair
        assert_eq!(quote_at(body, 4, 9), None); // crosses paragraph boundary
    }

    #[test]
    fn links_keep_stable_endpoints_and_recheck_availability_and_passages() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let scene = store.item_create(None, "scene", "Coast").unwrap();
        let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Map sea"}]}]}"#;
        store
            .flush(&[FlushEntry {
                item_id: scene.id.clone(),
                body: body.into(),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        let doc = store.load_doc(&scene.id).unwrap();
        let resource = store
            .research_resource_add(
                "Map",
                "map.txt",
                "text/plain",
                3,
                &"a".repeat(64),
                "archive",
                "page 4",
            )
            .unwrap();
        let draft = LinkDraft {
            source: Endpoint {
                kind: "item".into(),
                id: scene.id.clone(),
            },
            target: Endpoint {
                kind: "resource".into(),
                id: resource.id.clone(),
            },
            label: "inspired by".into(),
            note: "coastline".into(),
            citation: "page 4".into(),
            anchor: Some(PassageAnchor {
                item_id: scene.id.clone(),
                doc_rev: doc.rev,
                from: 1,
                to: 4,
                quote: "Map".into(),
            }),
        };
        let link = store.knowledge_link_create(&draft).unwrap();
        assert_eq!(
            store.knowledge_links(Some(&draft.source), false).unwrap()[0].id,
            link.id
        );
        assert_eq!(
            store.knowledge_links(Some(&draft.target), false).unwrap()[0].id,
            link.id
        );
        store.research_resource_remove(&resource.id).unwrap();
        let unavailable = store.knowledge_links(None, false).unwrap();
        assert!(!unavailable[0].target_available);
        assert_eq!(unavailable[0].target_caption, "Map");
        store.research_resource_restore(&resource.id).unwrap();
        assert!(store.knowledge_links(None, false).unwrap()[0].target_available);
        let changed = body.replace("Map sea", "New map sea");
        store
            .flush(&[FlushEntry {
                item_id: scene.id.clone(),
                body: changed,
                base_rev: doc.rev,
                comments: None,
            }])
            .unwrap();
        assert!(store.knowledge_links(None, false).unwrap()[0].anchor_stale);
        store.knowledge_link_remove(&link.id).unwrap();
        assert!(store.knowledge_links(None, false).unwrap().is_empty());
        assert_eq!(store.knowledge_links(None, true).unwrap().len(), 1);
    }
}
