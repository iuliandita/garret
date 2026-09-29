//! A fail-closed, single-scene review transport. Plans carry stored-hunk
//! decisions, never authority to replace manuscript prose with package text.
mod document;
mod metadata;
mod package;
#[cfg(test)]
mod tests;
mod xml;
mod zip;

use crate::review_document::{self, FragmentToken, Mark, ReviewHunk};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub(crate) struct SceneSnapshot {
    pub book_id: String,
    pub item_id: String,
    pub doc_rev: i64,
    pub body: String,
    pub groups: Vec<GroupSnapshot>,
    pub ordinary_comments: Vec<NoteSnapshot>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct GroupSnapshot {
    pub id: i64,
    pub rev: i64,
    pub author_name: String,
    pub created_at: i64,
    pub hunks: Vec<HunkSnapshot>,
    pub messages: Vec<MessageSnapshot>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct HunkSnapshot {
    pub id: i64,
    pub state: String,
    pub from: usize,
    pub to: usize,
    pub original: ReviewHunk,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MessageSnapshot {
    pub id: i64,
    pub author_name: String,
    pub body: String,
    pub created_at: i64,
}
#[derive(Debug, Clone)]
pub(crate) struct NoteSnapshot {
    pub id: i64,
    pub from: usize,
    pub to: usize,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub book_id: String,
    pub item_id: String,
    pub doc_rev: i64,
    pub body_hash: String,
    pub tag: String,
    pub groups: Vec<GroupSnapshot>,
    pub anchors: Vec<Anchor>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Anchor {
    pub name: String,
    pub group_id: i64,
    pub hunk_id: i64,
    pub from: usize,
    pub to: usize,
    pub before_hash: String,
    pub after_hash: String,
}
#[derive(Debug)]
pub(crate) struct ReviewPackage {
    pub bytes: Vec<u8>,
    pub manifest: Manifest,
    pub disclosure: Disclosure,
}
#[derive(Debug)]
pub(crate) struct Disclosure {
    pub authors: Vec<String>,
    pub messages: Vec<MessageSnapshot>,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OldDecision {
    Accept(i64),
    Reject(i64),
}
#[derive(Debug)]
pub(crate) struct AuthoredHunk {
    pub author_name: String,
    pub hunk: ReviewHunk,
}
#[derive(Debug)]
pub(crate) struct NewMessage {
    pub group_id: i64,
    pub author_name: String,
    pub body: String,
}
#[derive(Debug)]
pub(crate) struct ReviewPlan {
    pub expected: Manifest,
    pub decisions: Vec<OldDecision>,
    pub new_hunks: Vec<AuthoredHunk>,
    pub new_messages: Vec<NewMessage>,
    pub rejected_projection: String,
    pub accepted_projection: String,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn json_hash(value: &impl Serialize) -> Result<String, String> {
    Ok(hash(&serde_json::to_vec(value).map_err(|e| e.to_string())?))
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 80 && !name.chars().any(char::is_control)
}
fn canonical(tokens: &[FragmentToken]) -> Vec<FragmentToken> {
    let mut out = Vec::new();
    for token in tokens {
        match token {
            FragmentToken::Text { text, marks } => {
                if text.is_empty() {
                    continue;
                }
                let mut marks = marks.clone();
                marks.sort();
                if let Some(FragmentToken::Text {
                    text: last,
                    marks: previous,
                }) = out.last_mut()
                {
                    if *previous == marks {
                        last.push_str(text);
                        continue;
                    }
                }
                out.push(FragmentToken::Text {
                    text: text.clone(),
                    marks,
                });
            }
            _ => out.push(token.clone()),
        }
    }
    out
}
fn body(tokens: &[FragmentToken]) -> Result<String, String> {
    let mut paragraphs = Vec::new();
    let mut current: Option<Vec<serde_json::Value>> = None;
    for token in canonical(tokens) {
        match token {
            FragmentToken::Open if current.is_none() => current = Some(Vec::new()),
            FragmentToken::Close => {
                let content = current.take().ok_or("unbalanced review paragraph")?;
                paragraphs.push(if content.is_empty() {
                    serde_json::json!({"type":"paragraph"})
                } else {
                    serde_json::json!({"type":"paragraph","content":content})
                });
            }
            FragmentToken::Text { text, marks } => {
                let mut value = serde_json::json!({"type":"text","text":text});
                if !marks.is_empty() {
                    value["marks"] = serde_json::json!(marks
                        .iter()
                        .map(|mark| serde_json::json!({"type":mark}))
                        .collect::<Vec<_>>());
                }
                current
                    .as_mut()
                    .ok_or("text outside paragraph")?
                    .push(value);
            }
            _ => return Err("nested review paragraph".into()),
        }
    }
    if current.is_some() || paragraphs.is_empty() {
        return Err("incomplete review document".into());
    }
    let encoded = serde_json::json!({"type":"doc","content":paragraphs}).to_string();
    review_document::parse_review_body(&encoded)?;
    Ok(encoded)
}
fn slice(tokens: &[FragmentToken], from: usize, to: usize) -> Result<Vec<FragmentToken>, String> {
    if from > to {
        return Err("review range is reversed".into());
    }
    let mut pos = 0;
    let mut out = Vec::new();
    for token in tokens {
        let width = review_document::fragment_width(std::slice::from_ref(token));
        if pos < to && pos + width > from {
            match token {
                FragmentToken::Text { text, marks } => {
                    let start = from.saturating_sub(pos);
                    let end = (to - pos).min(width);
                    let byte = |unit| -> Result<usize, &str> {
                        let mut units = 0;
                        for (at, ch) in text.char_indices() {
                            if units == unit {
                                return Ok(at);
                            }
                            units += ch.len_utf16();
                            if units > unit {
                                return Err("review position splits a surrogate");
                            }
                        }
                        if units == unit {
                            Ok(text.len())
                        } else {
                            Err("review position exceeds text")
                        }
                    };
                    out.push(FragmentToken::Text {
                        text: text[byte(start)?..byte(end)?].into(),
                        marks: marks.clone(),
                    });
                }
                _ => out.push(token.clone()),
            }
        }
        pos += width;
    }
    if from > to || to > pos {
        return Err("review position exceeds document".into());
    }
    Ok(canonical(&out))
}

pub(crate) fn manifest(snapshot: &SceneSnapshot) -> Result<Manifest, String> {
    if snapshot.book_id.is_empty()
        || snapshot.book_id.len() > 128
        || snapshot.item_id.is_empty()
        || snapshot.item_id.len() > 128
        || snapshot.doc_rev < 1
    {
        return Err("invalid review source identity".into());
    }
    if !snapshot.ordinary_comments.is_empty() {
        return Err(
            "ordinary scene comment anchors are not supported in this strict subset".into(),
        );
    }
    let source = review_document::parse_review_body(&snapshot.body)?;
    let canonical_body = body(&source)?;
    if snapshot.groups.len() > 500 {
        return Err("too many review groups".into());
    }
    let mut payload = 0usize;
    let mut message_count = 0usize;
    for group in &snapshot.groups {
        payload = payload.saturating_add(group.author_name.len() + 128);
        message_count = message_count.saturating_add(group.messages.len());
        for message in &group.messages {
            payload = payload.saturating_add(message.body.len() + message.author_name.len() + 128);
        }
        for hunk in &group.hunks {
            for token in hunk.original.before.iter().chain(&hunk.original.after) {
                payload = payload.saturating_add(
                    96 + match token {
                        FragmentToken::Text { text, .. } => text.len(),
                        _ => 0,
                    },
                );
            }
        }
    }
    if message_count > 2000 || payload > 16 * 1024 * 1024 {
        return Err("review snapshot exceeds transport message or manifest budget".into());
    }
    let mut groups = snapshot.groups.clone();
    groups.sort_by_key(|g| g.id);
    let mut ids = BTreeSet::new();
    let mut hunk_ids = BTreeSet::new();
    let mut message_ids = BTreeSet::new();
    let mut anchors = Vec::new();
    for group in &groups {
        if group.id < 1
            || group.rev < 1
            || !ids.insert(group.id)
            || !valid_name(&group.author_name)
            || group.created_at < 0
            || group.hunks.is_empty()
            || group.hunks.len() > 64
            || group.messages.len() > 500
        {
            return Err("invalid review group snapshot".into());
        }
        for message in &group.messages {
            if message.id < 1
                || !message_ids.insert(message.id)
                || !valid_name(&message.author_name)
                || message.body.trim().is_empty()
                || message.body.len() > 4000
                || message.created_at < 0
                || !xml::valid_chars(&message.body)
            {
                return Err("invalid review message snapshot".into());
            }
        }
        for hunk in &group.hunks {
            if hunk.id < 1 || !hunk_ids.insert(hunk.id) || hunk.state != "pending" {
                return Err("only explicitly scoped pending hunks can be exported".into());
            }
            let mapped = ReviewHunk {
                from: hunk.from,
                to: hunk.to,
                before: hunk.original.before.clone(),
                after: hunk.original.after.clone(),
            };
            review_document::apply_hunk_to_tokens(&source, &mapped)?;
            anchors.push(Anchor {
                name: format!(
                    "wr_{}",
                    &hash(
                        format!("{}:{}:{}", snapshot.book_id, snapshot.item_id, hunk.id).as_bytes()
                    )[..32]
                ),
                group_id: group.id,
                hunk_id: hunk.id,
                from: hunk.from,
                to: hunk.to,
                before_hash: json_hash(&canonical(&mapped.before))?,
                after_hash: json_hash(&canonical(&mapped.after))?,
            });
        }
    }
    if anchors.len() > 500 {
        return Err("too many pending hunks".into());
    }
    anchors.sort_by_key(|a| (a.from, a.to, a.hunk_id));
    if anchors.windows(2).any(|a| {
        a[0].to > a[1].from
            || a[0].to == a[1].from && (a[0].from == a[0].to || a[1].from == a[1].to)
    }) {
        return Err("overlapping review hunks cannot be exported".into());
    }
    let tag = format!(
        "wr-scene:{}",
        &hash(
            format!(
                "{}:{}:{}",
                snapshot.book_id, snapshot.item_id, snapshot.doc_rev
            )
            .as_bytes()
        )[..32]
    );
    Ok(Manifest {
        version: 2,
        book_id: snapshot.book_id.clone(),
        item_id: snapshot.item_id.clone(),
        doc_rev: snapshot.doc_rev,
        body_hash: hash(canonical_body.as_bytes()),
        tag,
        groups,
        anchors,
    })
}

pub(crate) fn export(snapshot: &SceneSnapshot) -> Result<ReviewPackage, String> {
    package::export(snapshot)
}
pub(crate) fn inspect_return(bytes: &[u8], current: &SceneSnapshot) -> Result<ReviewPlan, String> {
    package::inspect_return(bytes, current)
}
