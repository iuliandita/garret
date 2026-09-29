//! Pure, exact proposal application for the editor's current document schema.
//! A stored hunk names ProseMirror UTF-16 positions and exact flat content;
//! only this host function constructs the accepted body.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOKENS: usize = 100_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReviewHunk {
    pub from: usize,
    pub to: usize,
    pub before: Vec<FragmentToken>,
    pub after: Vec<FragmentToken>,
}

/// Open and close have width one; text has its JavaScript UTF-16 width.
/// An isolated fragment may be open at either end, but the result must be a doc.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum FragmentToken {
    Open,
    Close,
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        marks: Vec<Mark>,
    },
}

impl<'de> Deserialize<'de> for FragmentToken {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("missing fragment kind"))?;
        let allowed = match kind {
            "open" | "close" => &["kind"][..],
            "text" => &["kind", "text", "marks"][..],
            _ => return Err(serde::de::Error::custom("unsupported fragment kind")),
        };
        let object = object_with(&value, allowed).map_err(serde::de::Error::custom)?;
        match kind {
            "open" => Ok(Self::Open),
            "close" => Ok(Self::Close),
            "text" => {
                let text = object
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("invalid fragment text"))?;
                let marks = object
                    .get("marks")
                    .map(|raw| {
                        serde_json::from_value::<Vec<Mark>>(raw.clone())
                            .map_err(serde::de::Error::custom)
                    })
                    .transpose()?
                    .unwrap_or_default();
                Ok(Self::Text {
                    text: text.into(),
                    marks,
                })
            }
            _ => unreachable!(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mark {
    Em,
    Strong,
    Underline,
}

pub(crate) fn apply_hunk(body: &str, hunk: &ReviewHunk) -> Result<String, String> {
    let source = parse_review_body(body)?;
    apply_hunk_to_tokens(&source, hunk)
}

pub(crate) fn parse_review_body(body: &str) -> Result<Vec<FragmentToken>, String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("document exceeds review limit".into());
    }
    parse_document(body)
}

pub(crate) fn apply_hunk_to_tokens(
    source: &[FragmentToken],
    hunk: &ReviewHunk,
) -> Result<String, String> {
    let before = canonical_fragment(&hunk.before)?;
    let after = canonical_fragment(&hunk.after)?;
    if fragment_size(&before) != hunk.to.saturating_sub(hunk.from) || hunk.from > hunk.to {
        return Err("proposal range and before content disagree".into());
    }
    let (left, remainder) = cut(source, hunk.from)?;
    let (actual, right) = cut(&remainder, hunk.to - hunk.from)?;
    if canonical_fragment(&actual)? != before {
        return Err("proposal before content is stale".into());
    }
    if before == after {
        return Err("proposal makes no change".into());
    }
    let mut joined = left;
    joined.extend(after);
    joined.extend(right);
    let joined = canonical_fragment(&joined)?;
    let result = document_from_tokens(&joined)?;
    let encoded = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    if encoded.len() > MAX_BODY_BYTES {
        return Err("result exceeds review limit".into());
    }
    Ok(encoded)
}

pub(crate) fn fragment_width(tokens: &[FragmentToken]) -> usize {
    fragment_size(tokens)
}

/// Marks alone changed; comment ranges still name the same prose and boundaries.
pub(crate) fn same_unmarked_content(before: &[FragmentToken], after: &[FragmentToken]) -> bool {
    #[derive(PartialEq, Eq)]
    enum Unit {
        Open,
        Close,
        Character(char),
    }
    fn units(tokens: &[FragmentToken]) -> Vec<Unit> {
        let mut result = Vec::new();
        for token in tokens {
            match token {
                FragmentToken::Open => result.push(Unit::Open),
                FragmentToken::Close => result.push(Unit::Close),
                FragmentToken::Text { text, .. } => {
                    result.extend(text.chars().map(Unit::Character));
                }
            }
        }
        result
    }
    units(before) == units(after)
}

/// The one changed interval after removing equal canonical prefix and suffix.
/// Comparing whole Unicode scalars keeps both returned positions off surrogates.
pub(crate) fn changed_interval(
    old: &str,
    new: &str,
) -> Result<Option<(usize, usize, usize)>, String> {
    #[derive(PartialEq, Eq)]
    enum Unit {
        Open,
        Close,
        Character(char, u8),
    }
    fn units(body: &str) -> Result<Vec<Unit>, String> {
        if body.len() > MAX_BODY_BYTES {
            return Err("document exceeds review limit".into());
        }
        let mut units = Vec::new();
        for token in parse_document(body)? {
            match token {
                FragmentToken::Open => units.push(Unit::Open),
                FragmentToken::Close => units.push(Unit::Close),
                FragmentToken::Text { text, marks } => {
                    let mask = marks.iter().fold(0u8, |mask, mark| {
                        mask | match mark {
                            Mark::Em => 1,
                            Mark::Strong => 2,
                            Mark::Underline => 4,
                        }
                    });
                    units.extend(text.chars().map(|ch| Unit::Character(ch, mask)));
                }
            }
        }
        Ok(units)
    }
    fn width(unit: &Unit) -> usize {
        match unit {
            Unit::Character(ch, _) => ch.len_utf16(),
            _ => 1,
        }
    }
    let old = units(old)?;
    let new = units(new)?;
    let mut prefix = 0;
    while prefix < old.len() && prefix < new.len() && old[prefix] == new[prefix] {
        prefix += 1;
    }
    if prefix == old.len() && prefix == new.len() {
        return Ok(None);
    }
    let mut suffix = 0;
    while suffix < old.len() - prefix
        && suffix < new.len() - prefix
        && old[old.len() - suffix - 1] == new[new.len() - suffix - 1]
    {
        suffix += 1;
    }
    let start = old[..prefix].iter().map(width).sum();
    let old_end = old[..old.len() - suffix].iter().map(width).sum();
    let new_end = new[..new.len() - suffix].iter().map(width).sum();
    Ok(Some((start, old_end, new_end)))
}

fn parse_document(body: &str) -> Result<Vec<FragmentToken>, String> {
    let value: Value = serde_json::from_str(body).map_err(|_| "invalid document JSON")?;
    let root = object_with(&value, &["type", "content"])?;
    if root.get("type").and_then(Value::as_str) != Some("doc") {
        return Err("expected doc root".into());
    }
    let paragraphs = root
        .get("content")
        .and_then(Value::as_array)
        .ok_or("document needs paragraphs")?;
    if paragraphs.is_empty() || paragraphs.len() > MAX_TOKENS / 2 {
        return Err("invalid paragraph count".into());
    }
    let mut tokens = Vec::new();
    for paragraph in paragraphs {
        let node = object_with(paragraph, &["type", "content"])?;
        if node.get("type").and_then(Value::as_str) != Some("paragraph") {
            return Err("unsupported paragraph node".into());
        }
        tokens.push(FragmentToken::Open);
        if let Some(content) = node.get("content") {
            for child in content.as_array().ok_or("invalid paragraph content")? {
                let text_node = object_with(child, &["type", "text", "marks"])?;
                if text_node.get("type").and_then(Value::as_str) != Some("text") {
                    return Err("unsupported inline node".into());
                }
                let text = text_node
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("invalid text node")?;
                if text.is_empty() {
                    return Err("empty text node".into());
                }
                let mut marks = Vec::new();
                if let Some(raw_marks) = text_node.get("marks") {
                    for raw_mark in raw_marks.as_array().ok_or("invalid marks")? {
                        let mark = object_with(raw_mark, &["type"])?;
                        let name = mark
                            .get("type")
                            .and_then(Value::as_str)
                            .ok_or("invalid mark")?;
                        marks.push(match name {
                            "em" => Mark::Em,
                            "strong" => Mark::Strong,
                            "underline" => Mark::Underline,
                            _ => return Err("unsupported mark".into()),
                        });
                    }
                }
                normalize_marks(&mut marks)?;
                tokens.push(FragmentToken::Text {
                    text: text.into(),
                    marks,
                });
                if tokens.len() > MAX_TOKENS {
                    return Err("too many document nodes".into());
                }
            }
        }
        tokens.push(FragmentToken::Close);
    }
    canonical_fragment(&tokens)
}

fn object_with<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value.as_object().ok_or("expected object")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("unsupported document property".into());
    }
    Ok(object)
}

fn normalize_marks(marks: &mut Vec<Mark>) -> Result<(), String> {
    marks.sort();
    if marks.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("duplicate mark".into());
    }
    Ok(())
}

fn canonical_fragment(tokens: &[FragmentToken]) -> Result<Vec<FragmentToken>, String> {
    if tokens.len() > MAX_TOKENS {
        return Err("too many fragment tokens".into());
    }
    let mut output: Vec<FragmentToken> = Vec::new();
    let mut text_bytes = 0usize;
    for token in tokens {
        match token {
            FragmentToken::Text { text, marks } => {
                if text.is_empty() {
                    return Err("empty text token".into());
                }
                text_bytes = text_bytes
                    .checked_add(text.len())
                    .ok_or("fragment too large")?;
                if text_bytes > MAX_BODY_BYTES {
                    return Err("fragment too large".into());
                }
                let mut marks = marks.clone();
                normalize_marks(&mut marks)?;
                if let Some(FragmentToken::Text {
                    text: last,
                    marks: last_marks,
                }) = output.last_mut()
                {
                    if *last_marks == marks {
                        last.push_str(text);
                        continue;
                    }
                }
                output.push(FragmentToken::Text {
                    text: text.clone(),
                    marks,
                });
            }
            other => output.push(other.clone()),
        }
    }
    Ok(output)
}

fn fragment_size(tokens: &[FragmentToken]) -> usize {
    tokens
        .iter()
        .map(|token| match token {
            FragmentToken::Text { text, .. } => text.encode_utf16().count(),
            _ => 1,
        })
        .sum()
}

fn cut(
    tokens: &[FragmentToken],
    at: usize,
) -> Result<(Vec<FragmentToken>, Vec<FragmentToken>), String> {
    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut pos = 0usize;
    for token in tokens {
        let width = fragment_size(std::slice::from_ref(token));
        if at <= pos {
            right.push(token.clone());
        } else if at >= pos + width {
            left.push(token.clone());
        } else if let FragmentToken::Text { text, marks } = token {
            let offset = utf16_byte_offset(text, at - pos)?;
            left.push(FragmentToken::Text {
                text: text[..offset].into(),
                marks: marks.clone(),
            });
            right.push(FragmentToken::Text {
                text: text[offset..].into(),
                marks: marks.clone(),
            });
        } else {
            return Err("position splits paragraph boundary".into());
        }
        pos += width;
    }
    if at > pos {
        return Err("proposal position exceeds document".into());
    }
    Ok((left, right))
}

fn utf16_byte_offset(text: &str, at: usize) -> Result<usize, String> {
    let mut width = 0;
    for (byte, ch) in text.char_indices() {
        if width == at {
            return Ok(byte);
        }
        width += ch.len_utf16();
        if width > at {
            return Err("position splits surrogate pair".into());
        }
    }
    if width == at {
        Ok(text.len())
    } else {
        Err("position exceeds text".into())
    }
}

fn document_from_tokens(tokens: &[FragmentToken]) -> Result<Value, String> {
    let mut paragraphs = Vec::new();
    let mut content = None::<Vec<Value>>;
    for token in tokens {
        match token {
            FragmentToken::Open if content.is_none() => content = Some(Vec::new()),
            FragmentToken::Close => {
                let children = content.take().ok_or("unbalanced paragraph close")?;
                if children.is_empty() {
                    paragraphs.push(json!({"type":"paragraph"}));
                } else {
                    paragraphs.push(json!({"type":"paragraph","content":children}));
                }
            }
            FragmentToken::Text { text, marks } => {
                let children = content.as_mut().ok_or("text outside paragraph")?;
                if marks.is_empty() {
                    children.push(json!({"type":"text","text":text}));
                } else {
                    children.push(json!({"type":"text","text":text,
                        "marks":marks.iter().map(|mark| json!({"type":mark})).collect::<Vec<_>>() }));
                }
            }
            _ => return Err("nested paragraph open".into()),
        }
    }
    if content.is_some() || paragraphs.is_empty() {
        return Err("result is not a complete document".into());
    }
    Ok(json!({"type":"doc","content":paragraphs}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        id: String,
        body: Value,
        hunk: ReviewHunk,
        expected: Option<Value>,
    }

    #[test]
    fn shared_prosemirror_cases() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../harness/fixtures/review-documents.json"
        ))
        .unwrap();
        for case in cases {
            let result = apply_hunk(&case.body.to_string(), &case.hunk);
            match case.expected {
                Some(expected) => assert_eq!(
                    serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
                    expected,
                    "{}",
                    case.id
                ),
                None => assert!(result.is_err(), "{} unexpectedly succeeded", case.id),
            }
        }
    }

    #[test]
    fn unrecognized_hunk_properties_and_marks_refuse() {
        for raw in [
            r#"{"from":1,"to":1,"before":[],"after":[],"accepted_body":{}}"#,
            r#"{"from":1,"to":1,"before":[],"after":[{"kind":"open","attrs":{}}]}"#,
            r#"{"from":1,"to":1,"before":[],"after":[{"kind":"text","text":"x","marks":["code"]}]}"#,
        ] {
            assert!(serde_json::from_str::<ReviewHunk>(raw).is_err(), "{raw}");
        }
    }
}
