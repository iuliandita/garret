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

/// Edges and opaque whole atoms have width one; text has its UTF-16 width.
/// An isolated fragment may be open at either end, but the result must be a doc.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum FragmentToken {
    Open,
    Close,
    Atom {
        node: Value,
    },
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
            "atom" => &["kind", "node"][..],
            _ => return Err(serde::de::Error::custom("unsupported fragment kind")),
        };
        let object = object_with(&value, allowed).map_err(serde::de::Error::custom)?;
        match kind {
            "open" => Ok(Self::Open),
            "close" => Ok(Self::Close),
            "atom" => {
                let node = object
                    .get("node")
                    .ok_or_else(|| serde::de::Error::custom("missing atom node"))?;
                validate_atom(node).map_err(serde::de::Error::custom)?;
                Ok(Self::Atom { node: node.clone() })
            }
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
    #[cfg(test)]
    if let Some(candidate) = TEST_CANDIDATE.with(|value| value.borrow().clone()) {
        return Ok(candidate);
    }
    let source = parse_review_body(body)?;
    apply_hunk_to_tokens(&source, hunk)
}

#[cfg(test)]
thread_local! {
    static TEST_CANDIDATE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn with_test_candidate<T>(body: &str, run: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_CANDIDATE.with(|value| *value.borrow_mut() = None);
        }
    }
    TEST_CANDIDATE.with(|value| *value.borrow_mut() = Some(body.into()));
    let _reset = Reset;
    run()
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
        Atom(Value),
    }
    fn units(tokens: &[FragmentToken]) -> Vec<Unit> {
        let mut result = Vec::new();
        for token in tokens {
            match token {
                FragmentToken::Open => result.push(Unit::Open),
                FragmentToken::Close => result.push(Unit::Close),
                FragmentToken::Atom { node } => result.push(Unit::Atom(node.clone())),
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
        Atom(Value),
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
                FragmentToken::Atom { node } => units.push(Unit::Atom(node)),
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

// This reader validates structure without claiming that asset IDs are registered.
// Writers separately resolve assets and enforce the production format policy.
fn validate_shape(value: &Value) -> Result<(), String> {
    let assets = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| node["type"] == "figure")
        .filter_map(|node| node["attrs"]["asset_id"].as_str().map(str::to_owned))
        .collect();
    crate::store::document_format::validate(value, true, &assets).map_err(|e| e.to_string())
}

fn validate_atom(node: &Value) -> Result<(), String> {
    let block = match node.get("type").and_then(Value::as_str) {
        Some("endnote") => json!({"type":"paragraph","content":[node]}),
        Some("figure" | "scene_break") => node.clone(),
        _ => return Err("unsupported review atom".into()),
    };
    validate_shape(&json!({"type":"doc","content":[block]}))
}

fn parse_document(body: &str) -> Result<Vec<FragmentToken>, String> {
    let value: Value = serde_json::from_str(body).map_err(|_| "invalid document JSON")?;
    validate_shape(&value)?;
    let root = object_with(&value, &["type", "content"])?;
    if root.get("type").and_then(Value::as_str) != Some("doc") {
        return Err("expected doc root".into());
    }
    let paragraphs = root
        .get("content")
        .and_then(Value::as_array)
        .ok_or("document needs paragraphs")?;
    if paragraphs.is_empty() || paragraphs.len() > MAX_TOKENS {
        return Err("invalid block count".into());
    }
    let mut tokens = Vec::new();
    for paragraph in paragraphs {
        if matches!(paragraph["type"].as_str(), Some("figure" | "scene_break")) {
            tokens.push(FragmentToken::Atom {
                node: paragraph.clone(),
            });
            continue;
        }
        let node = object_with(paragraph, &["type", "content"])?;
        if node.get("type").and_then(Value::as_str) != Some("paragraph") {
            return Err("unsupported paragraph node".into());
        }
        tokens.push(FragmentToken::Open);
        if let Some(content) = node.get("content") {
            for child in content.as_array().ok_or("invalid paragraph content")? {
                if child["type"] == "endnote" {
                    tokens.push(FragmentToken::Atom {
                        node: child.clone(),
                    });
                    continue;
                }
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
            FragmentToken::Atom { node } => {
                validate_atom(node)?;
                text_bytes = text_bytes
                    .checked_add(node.to_string().len())
                    .ok_or("fragment too large")?;
                if text_bytes > MAX_BODY_BYTES {
                    return Err("fragment too large".into());
                }
                output.push(token.clone());
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
            FragmentToken::Atom { node } => {
                validate_atom(node)?;
                if node["type"] == "endnote" {
                    content
                        .as_mut()
                        .ok_or("endnote outside paragraph")?
                        .push(node.clone());
                } else if content.is_none() {
                    paragraphs.push(node.clone());
                } else {
                    return Err("block atom inside paragraph".into());
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
    let result = json!({"type":"doc","content":paragraphs});
    validate_shape(&result)?;
    Ok(result)
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

    fn atom_fixture() -> Value {
        json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"😀"},
                {"type":"endnote","attrs":{"id":"11111111-1111-4111-8111-111111111111","fmt":"text","body":"note 😀\n<script>"}},
                {"type":"text","text":"🦊"}]},
            {"type":"figure","attrs":{"id":"22222222-2222-4222-8222-222222222222","asset_id":"33333333-3333-4333-8333-333333333333","width":"full","caption":"caption","alt":"alt"}},
            {"type":"scene_break"}, {"type":"paragraph","content":[{"type":"text","text":"tail"}]}
        ]})
    }

    #[test]
    fn whole_atoms_apply_exactly_and_stale_attributes_refuse_beside_astral_text() {
        let original = atom_fixture();
        let encoded = original.to_string();
        let source = parse_review_body(&encoded).unwrap();
        assert_eq!(fragment_width(&source), 15);
        assert_eq!(changed_interval(&encoded, &encoded).unwrap(), None);
        for (is_note, field, value) in [
            (true, "body", "changed 🦊"),
            (true, "id", "44444444-4444-4444-8444-444444444444"),
            (false, "id", "44444444-4444-4444-8444-444444444444"),
            (false, "asset_id", "55555555-5555-4555-8555-555555555555"),
            (false, "width", "half"),
            (false, "caption", "new caption"),
            (false, "alt", "new alt"),
        ] {
            let old = if is_note {
                &original["content"][0]["content"][1]
            } else {
                &original["content"][1]
            };
            let mut new = old.clone();
            new["attrs"][field] = json!(value);
            let from = if is_note { 3 } else { 7 };
            let hunk = ReviewHunk {
                from,
                to: from + 1,
                before: vec![FragmentToken::Atom { node: old.clone() }],
                after: vec![FragmentToken::Atom { node: new.clone() }],
            };
            let wire = serde_json::to_string(&hunk).unwrap();
            let hunk: ReviewHunk = serde_json::from_str(&wire).unwrap();
            let result = apply_hunk(&encoded, &hunk).unwrap();
            let mut expected = original.clone();
            if is_note {
                expected["content"][0]["content"][1] = new;
            } else {
                expected["content"][1] = new;
            }
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap(),
                expected,
                "{field}"
            );
            assert_eq!(
                changed_interval(&encoded, &result).unwrap(),
                Some((from, from + 1, from + 1))
            );
            assert!(!same_unmarked_content(&hunk.before, &hunk.after));
            assert!(
                apply_hunk(&result, &hunk).unwrap_err().contains("stale"),
                "{field}"
            );
        }
        for from in [3, 7, 8] {
            let (left, rest) = cut(&source, from).unwrap();
            let (atom, _) = cut(&rest, 1).unwrap();
            assert_eq!(atom.len(), 1);
            assert!(matches!(atom[0], FragmentToken::Atom { .. }));
            let removed = apply_hunk(
                &encoded,
                &ReviewHunk {
                    from,
                    to: from + 1,
                    before: atom.clone(),
                    after: vec![],
                },
            )
            .unwrap();
            let restored = apply_hunk(
                &removed,
                &ReviewHunk {
                    from,
                    to: from,
                    before: vec![],
                    after: atom,
                },
            )
            .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&restored).unwrap(), original);
            assert_eq!(fragment_width(&left), from);
        }
        assert!(apply_hunk(
            &encoded,
            &ReviewHunk {
                from: 2,
                to: 3,
                before: vec![FragmentToken::Text {
                    text: "x".into(),
                    marks: vec![]
                }],
                after: vec![]
            }
        )
        .unwrap_err()
        .contains("surrogate"));
    }

    #[test]
    fn atom_wire_and_result_reject_unknown_or_lossy_shapes_and_duplicate_ids() {
        let original = atom_fixture();
        let note = original["content"][0]["content"][1].clone();
        for (field, value) in [
            ("fmt", json!("html")),
            ("id", json!("bad")),
            ("body", json!("界".repeat(22_000))),
            ("extra", json!("lost")),
        ] {
            let mut invalid = note.clone();
            invalid["attrs"][field] = value;
            assert!(
                serde_json::from_value::<FragmentToken>(json!({"kind":"atom","node":invalid}))
                    .is_err(),
                "{field}"
            );
        }
        for invalid in [
            json!({"type":"scene_break","attrs":{}}),
            json!({"type":"text","text":"x"}),
            json!({"type":"endnote","attrs":note["attrs"],"marks":[{"type":"em"}]}),
            json!({"type":"endnote","attrs":note["attrs"],"content":[]}),
        ] {
            assert!(
                serde_json::from_value::<FragmentToken>(json!({"kind":"atom","node":invalid}))
                    .is_err()
            );
        }
        let mut duplicate = original.clone();
        duplicate["content"][1]["attrs"]["id"] = note["attrs"]["id"].clone();
        assert!(parse_review_body(&duplicate.to_string()).is_err());
        let hunk = ReviewHunk {
            from: 4,
            to: 4,
            before: vec![],
            after: vec![FragmentToken::Atom { node: note.clone() }],
        };
        assert!(apply_hunk(&original.to_string(), &hunk).is_err());
        let hunk = ReviewHunk {
            from: 0,
            to: 0,
            before: vec![],
            after: vec![FragmentToken::Atom { node: note }],
        };
        assert!(apply_hunk(&original.to_string(), &hunk).is_err());
    }
}
