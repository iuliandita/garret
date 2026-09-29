use super::{
    xml::{self, Element, W, XML},
    FragmentToken, Manifest, Mark, SceneSnapshot,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Revision {
    pub key: usize,
    pub author: String,
    pub kind: String,
    pub date: String,
}
#[derive(Debug, Clone)]
pub(super) enum Event {
    Token(FragmentToken, Option<Revision>),
    Format {
        text: String,
        old: Vec<Mark>,
        new: Vec<Mark>,
        revision: Revision,
    },
    Start(String),
    End(String),
    CommentStart(String),
    CommentEnd(String),
    CommentRef(String),
}
#[derive(Debug)]
pub(super) struct Parsed {
    pub events: Vec<Event>,
    pub revisions: Vec<Revision>,
}
#[derive(Debug)]
pub(super) struct Projection {
    pub tokens: Vec<FragmentToken>,
    pub anchors: BTreeMap<String, (usize, usize)>,
    pub comments: BTreeMap<String, (usize, usize)>,
    pub refs: BTreeSet<String>,
}

pub(super) fn project(events: &[Event], accepted: &BTreeSet<usize>) -> Result<Projection, String> {
    let mut out = Projection {
        tokens: Vec::new(),
        anchors: BTreeMap::new(),
        comments: BTreeMap::new(),
        refs: BTreeSet::new(),
    };
    let mut opened = BTreeMap::new();
    let mut comments = BTreeMap::new();
    let mut pos = 0;
    for event in events {
        let token = match event {
            Event::Token(token, revision) => {
                let keep = revision
                    .as_ref()
                    .is_none_or(|r| (r.kind == "ins") == accepted.contains(&r.key));
                keep.then(|| token.clone())
            }
            Event::Format {
                text,
                old,
                new,
                revision,
            } => Some(FragmentToken::Text {
                text: text.clone(),
                marks: if accepted.contains(&revision.key) {
                    new.clone()
                } else {
                    old.clone()
                },
            }),
            Event::Start(id) => {
                if out.anchors.contains_key(id) || opened.insert(id.clone(), pos).is_some() {
                    return Err("duplicate bookmark start".into());
                }
                None
            }
            Event::End(id) => {
                let from = opened.remove(id).ok_or("bookmark end has no start")?;
                if out.anchors.insert(id.clone(), (from, pos)).is_some() {
                    return Err("duplicate bookmark end".into());
                }
                None
            }
            Event::CommentStart(id) => {
                if out.comments.contains_key(id) || comments.insert(id.clone(), pos).is_some() {
                    return Err("duplicate comment start".into());
                }
                None
            }
            Event::CommentEnd(id) => {
                let from = comments.remove(id).ok_or("comment end has no start")?;
                if out.comments.insert(id.clone(), (from, pos)).is_some() {
                    return Err("duplicate comment end".into());
                }
                None
            }
            Event::CommentRef(id) => {
                if !out.refs.insert(id.clone()) {
                    return Err("duplicate comment reference".into());
                }
                None
            }
        };
        if let Some(token) = token {
            pos += crate::review_document::fragment_width(std::slice::from_ref(&token));
            out.tokens.push(token);
        }
    }
    if !opened.is_empty()
        || !comments.is_empty()
        || out.comments.keys().cloned().collect::<BTreeSet<_>>() != out.refs
    {
        return Err("unbalanced review markers".into());
    }
    out.tokens = super::canonical(&out.tokens);
    super::body(&out.tokens)?;
    Ok(out)
}

/// Connect only structurally inseparable edges and immediate deletion/insertion
/// pairs. Adjacent independent text revisions retain separate identities.
pub(super) fn units(parsed: &Parsed) -> Vec<BTreeSet<usize>> {
    let mut parents: Vec<usize> = (0..parsed.revisions.len()).collect();
    fn root(parents: &[usize], mut key: usize) -> usize {
        while parents[key] != key {
            key = parents[key];
        }
        key
    }
    for pair in parsed.events.windows(2) {
        if let [Event::Token(a, Some(left)), Event::Token(b, Some(right))] = pair {
            let structural = !matches!(a, FragmentToken::Text { .. })
                || !matches!(b, FragmentToken::Text { .. });
            if left.author == right.author
                && left.date == right.date
                && (left.kind == right.kind && structural
                    || left.kind == "del" && right.kind == "ins")
            {
                let a = root(&parents, left.key);
                let b = root(&parents, right.key);
                parents[b] = a;
            }
        }
    }
    let mut units: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    for key in 0..parents.len() {
        units.entry(root(&parents, key)).or_default().insert(key);
    }
    units.into_values().collect()
}

fn word_attrs(e: &Element, allowed: &[&str]) -> Result<(), String> {
    let allowed: Vec<_> = allowed.iter().map(|name| (W, *name)).collect();
    e.only_attrs(&allowed)
}
fn marks(
    e: &Element,
    allow_change: bool,
    revisions: &mut Vec<Revision>,
) -> Result<(Vec<Mark>, Option<(Vec<Mark>, Revision)>), String> {
    if !e.is(W, "rPr") {
        return Err("expected direct run properties".into());
    }
    e.only_attrs(&[])?;
    e.structural()?;
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    let mut previous = None;
    for child in &e.children {
        if child.is(W, "rPrChange") && allow_change {
            if previous.is_some() || child.children.len() != 1 {
                return Err("ambiguous formatting revision".into());
            }
            let revision = revision(child, "format", revisions)?;
            let (old, nested) = marks(&child.children[0], false, revisions)?;
            if nested.is_some() {
                return Err("nested formatting revision".into());
            }
            previous = Some((old, revision));
        } else {
            child.leaf()?;
            word_attrs(child, &["val"])?;
            let mark = match (child.ns.as_str(), child.name.as_str()) {
                (W, "i") => Mark::Em,
                (W, "b") => Mark::Strong,
                (W, "u") => Mark::Underline,
                _ => return Err("unsupported style-derived or direct run property".into()),
            };
            let val = child.attr(W, "val");
            if !seen.insert(mark) {
                return Err("duplicate run mark".into());
            }
            let off = matches!(val, Some("0" | "false" | "off"))
                || mark == Mark::Underline && val == Some("none");
            if off {
                continue;
            }
            if mark == Mark::Underline && val != Some("single")
                || mark != Mark::Underline && val.is_some_and(|v| !matches!(v, "1" | "true" | "on"))
            {
                return Err("unsupported mark value".into());
            }
            result.push(mark);
        }
    }
    result.sort();
    Ok((result, previous))
}
fn revision(e: &Element, kind: &str, revisions: &mut Vec<Revision>) -> Result<Revision, String> {
    word_attrs(e, &["id", "author", "date"])?;
    e.structural()?;
    let id = e.required(W, "id")?;
    if id.parse::<u32>().is_err() {
        return Err("invalid revision id".into());
    }
    let author = e.required(W, "author")?;
    if !super::valid_name(author) {
        return Err("invalid revision author".into());
    }
    if let Some(date) = e.attr(W, "date") {
        if date.len() > 40 || date.chars().any(char::is_control) {
            return Err("invalid revision date".into());
        }
    }
    let result = Revision {
        key: revisions.len(),
        author: author.into(),
        kind: kind.into(),
        date: e.attr(W, "date").unwrap_or("").into(),
    };
    revisions.push(result.clone());
    Ok(result)
}
fn run(
    e: &Element,
    outer: Option<&Revision>,
    events: &mut Vec<Event>,
    revisions: &mut Vec<Revision>,
) -> Result<(), String> {
    word_attrs(e, &["rsidR", "rsidRPr", "rsidDel"])?;
    e.structural()?;
    let mut direct = Vec::new();
    let mut change = None;
    let mut properties = false;
    let mut content = false;
    for child in &e.children {
        if child.is(W, "rPr") {
            if properties || content {
                return Err("misplaced or duplicate run properties".into());
            }
            (direct, change) = marks(child, outer.is_none(), revisions)?;
            properties = true;
        } else if child.is(W, "t") || child.is(W, "delText") {
            content = true;
            child.only_attrs(&[(XML, "space")])?;
            if !child.children.is_empty()
                || child
                    .attr(XML, "space")
                    .is_some_and(|v| v != "preserve" && v != "default")
            {
                return Err("unsupported text content".into());
            }
            if child.is(W, "delText") != outer.is_some_and(|r| r.kind == "del") {
                return Err(
                    "deleted text outside deletion or ordinary text inside deletion".into(),
                );
            }
            if child.text.is_empty() {
                continue;
            }
            if let Some((old, revision)) = &change {
                events.push(Event::Format {
                    text: child.text.clone(),
                    old: old.clone(),
                    new: direct.clone(),
                    revision: revision.clone(),
                });
            } else {
                events.push(Event::Token(
                    FragmentToken::Text {
                        text: child.text.clone(),
                        marks: direct.clone(),
                    },
                    outer.cloned(),
                ));
            }
        } else if child.is(W, "commentReference")
            && outer.is_none()
            && change.is_none()
            && direct.is_empty()
        {
            child.leaf()?;
            word_attrs(child, &["id"])?;
            events.push(Event::CommentRef(
                child
                    .required(W, "id")?
                    .parse::<u32>()
                    .map_err(|_| "invalid comment reference")?
                    .to_string(),
            ));
            content = true;
        } else {
            return Err(format!("unsupported run child {}", child.name));
        }
    }
    if !content && (outer.is_some() || change.is_some()) {
        return Err("empty revised run has no review semantics".into());
    }
    Ok(())
}
fn marker(
    e: &Element,
    events: &mut Vec<Event>,
    bookmarks: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    e.leaf()?;
    let id = e
        .required(W, "id")?
        .parse::<u32>()
        .map_err(|_| "invalid marker id")?
        .to_string();
    match e.name.as_str() {
        "bookmarkStart" => {
            word_attrs(e, &["id", "name"])?;
            let name = e.required(W, "name")?.to_string();
            if bookmarks.insert(id, name.clone()).is_some() {
                return Err("duplicate bookmark id".into());
            }
            events.push(Event::Start(name));
        }
        "bookmarkEnd" => {
            word_attrs(e, &["id"])?;
            let name = bookmarks.get(&id).ok_or("bookmark end precedes start")?;
            events.push(Event::End(name.clone()));
        }
        "commentRangeStart" => {
            word_attrs(e, &["id"])?;
            events.push(Event::CommentStart(id));
        }
        "commentRangeEnd" => {
            word_attrs(e, &["id"])?;
            events.push(Event::CommentEnd(id));
        }
        _ => return Err("unsupported paragraph marker".into()),
    }
    Ok(())
}
fn inline(
    e: &Element,
    events: &mut Vec<Event>,
    revisions: &mut Vec<Revision>,
    bookmarks: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    if e.ns != W {
        return Err("unsupported inline namespace".into());
    }
    match e.name.as_str() {
        "r" => run(e, None, events, revisions),
        "ins" | "del" => {
            let rev = revision(e, &e.name, revisions)?;
            if e.children.is_empty() {
                return Err("empty inline revision".into());
            }
            for child in &e.children {
                if !child.is(W, "r") {
                    return Err("nested or unsupported revision content".into());
                }
                run(child, Some(&rev), events, revisions)?;
            }
            Ok(())
        }
        _ => marker(e, events, bookmarks),
    }
}

pub(super) fn parse(root: &Element, tag: &str) -> Result<Parsed, String> {
    if !root.is(W, "document") {
        return Err("not a Word document".into());
    }
    root.only_attrs(&[])?;
    root.structural()?;
    if root.children.len() != 1 || !root.children[0].is(W, "body") {
        return Err("document needs one body".into());
    }
    let body = &root.children[0];
    body.only_attrs(&[])?;
    body.structural()?;
    if body.children.len() != 1 || !body.children[0].is(W, "sdt") {
        return Err("review needs exactly one scene content control".into());
    }
    let sdt = &body.children[0];
    sdt.only_attrs(&[])?;
    sdt.structural()?;
    if sdt.children.len() != 2
        || !sdt.children[0].is(W, "sdtPr")
        || !sdt.children[1].is(W, "sdtContent")
    {
        return Err("invalid scene control".into());
    }
    let props = &sdt.children[0];
    props.only_attrs(&[])?;
    props.structural()?;
    if props.children.len() != 1 || !props.children[0].is(W, "tag") {
        return Err("scene control needs unique tag".into());
    }
    let tag_element = &props.children[0];
    tag_element.leaf()?;
    word_attrs(tag_element, &["val"])?;
    if tag_element.attr(W, "val") != Some(tag) {
        return Err("scene control tag changed".into());
    }
    let content = &sdt.children[1];
    content.only_attrs(&[])?;
    content.structural()?;
    let mut events = Vec::new();
    let mut revisions = Vec::new();
    let mut bookmarks = BTreeMap::new();
    let mut previous = None;
    let mut paragraphs = 0;
    for e in &content.children {
        if !e.is(W, "p") {
            if e.ns != W {
                return Err("unsupported block namespace".into());
            }
            marker(e, &mut events, &mut bookmarks)?;
            continue;
        }
        word_attrs(e, &["rsidR", "rsidRPr", "rsidDel", "rsidP", "rsidRDefault"])?;
        e.structural()?;
        events.push(Event::Token(FragmentToken::Open, previous.clone()));
        paragraphs += 1;
        let mut ending = None;
        for (index, child) in e.children.iter().enumerate() {
            if child.is(W, "pPr") {
                if index != 0 || ending.is_some() {
                    return Err("misplaced paragraph properties".into());
                }
                child.only_attrs(&[])?;
                child.structural()?;
                if child.children.len() != 1 || !child.children[0].is(W, "rPr") {
                    return Err("unsupported paragraph properties".into());
                }
                let rpr = &child.children[0];
                rpr.only_attrs(&[])?;
                rpr.structural()?;
                if rpr.children.len() != 1
                    || !matches!(rpr.children[0].name.as_str(), "ins" | "del")
                    || rpr.children[0].ns != W
                {
                    return Err("unsupported paragraph mark properties".into());
                }
                let change = &rpr.children[0];
                change.leaf()?;
                ending = Some(revision(change, &change.name, &mut revisions)?);
            } else {
                inline(child, &mut events, &mut revisions, &mut bookmarks)?;
            }
        }
        events.push(Event::Token(FragmentToken::Close, ending.clone()));
        previous = ending;
    }
    if paragraphs == 0 || previous.is_some() {
        return Err("empty scene or tracked final paragraph mark is unsupported".into());
    }
    normalize_block_bookmarks(&mut events)?;
    Ok(Parsed { events, revisions })
}

/// Paragraph-mark revisions merge two containers. A bookmark around a whole
/// paragraph instead owns both of that paragraph's edges. Transfer the shared
/// boundary to those edges without changing either document projection.
/// Editors can move a paragraph bookmark from outside w:p to its text edges.
/// Expand only when the immutable fragment explicitly owns that structural edge
/// and the marker is immediately at that paragraph edge. Exact positions and
/// both fragment projections are still verified by reconciliation afterwards.
pub(super) fn normalize_anchors(parsed: &mut Parsed, manifest: &Manifest) -> Result<(), String> {
    for anchor in &manifest.anchors {
        let hunk = manifest
            .groups
            .iter()
            .find(|g| g.id == anchor.group_id)
            .and_then(|g| g.hunks.iter().find(|h| h.id == anchor.hunk_id))
            .ok_or("missing immutable hunk")?;
        let before = &hunk.original.before;
        let after = &hunk.original.after;
        if before.first() == Some(&FragmentToken::Open)
            || after.first() == Some(&FragmentToken::Open)
        {
            if let Some(start) = parsed
                .events
                .iter()
                .position(|e| matches!(e,Event::Start(name) if name==&anchor.name))
            {
                if start > 0
                    && matches!(
                        &parsed.events[start - 1],
                        Event::Token(FragmentToken::Open, _)
                    )
                {
                    parsed.events.swap(start - 1, start);
                }
            }
        }
        if before.last() == Some(&FragmentToken::Close)
            || after.last() == Some(&FragmentToken::Close)
        {
            if let Some(end) = parsed
                .events
                .iter()
                .position(|e| matches!(e,Event::End(name) if name==&anchor.name))
            {
                if matches!(
                    parsed.events.get(end + 1),
                    Some(Event::Token(FragmentToken::Close, _))
                ) {
                    parsed.events.swap(end, end + 1);
                }
            }
        }
    }
    normalize_block_bookmarks(&mut parsed.events)
}

fn normalize_block_bookmarks(events: &mut [Event]) -> Result<(), String> {
    let starts: Vec<_> = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            if let Event::Start(name) = event {
                Some((index, name.clone()))
            } else {
                None
            }
        })
        .collect();
    for (start, name) in starts {
        let end = events
            .iter()
            .enumerate()
            .skip(start + 1)
            .find_map(|(index, event)| {
                matches!(event,Event::End(other) if other==&name).then_some(index)
            })
            .ok_or("unclosed bookmark")?;
        if !matches!(
            events.get(start + 1),
            Some(Event::Token(FragmentToken::Open, _))
        ) || !matches!(
            events.get(end.wrapping_sub(1)),
            Some(Event::Token(FragmentToken::Close, _))
        ) {
            continue;
        }
        let revisions: Vec<_> = events[start + 1..end]
            .iter()
            .filter_map(|event| match event {
                Event::Token(_, Some(revision)) => Some(revision.clone()),
                _ => None,
            })
            .collect();
        let Some(revision) = revisions.first() else {
            continue;
        };
        if revisions
            .iter()
            .any(|other| other.kind != revision.kind || other.author != revision.author)
            || events[start + 1..end].iter().any(|event| {
                matches!(
                    event,
                    Event::Token(FragmentToken::Text { .. }, None)
                        | Event::Format { .. }
                        | Event::Start(_)
                        | Event::End(_)
                )
            })
        {
            continue;
        }
        let edge = match (&events[start + 1], &events[end - 1]) {
            (Event::Token(_, Some(revision)), _) | (_, Event::Token(_, Some(revision))) => {
                revision.clone()
            }
            _ => continue,
        };
        if let Event::Token(_, change) = &mut events[start + 1] {
            *change = Some(edge.clone());
        }
        if let Event::Token(_, change) = &mut events[end - 1] {
            *change = Some(edge.clone());
        }
        if let Some(Event::Token(FragmentToken::Close, change)) = events[..start]
            .iter_mut()
            .rev()
            .find(|e| matches!(e, Event::Token(_, _)))
        {
            if change.as_ref().is_some_and(|r| r.key == edge.key) {
                *change = None;
            }
        }
        if let Some(Event::Token(FragmentToken::Open, change)) = events[end + 1..]
            .iter_mut()
            .find(|e| matches!(e, Event::Token(_, _)))
        {
            if change.as_ref().is_some_and(|r| r.key == edge.key) {
                *change = None;
            }
        }
    }
    Ok(())
}

fn rpr(marks: &[Mark]) -> String {
    marks
        .iter()
        .map(|mark| match mark {
            Mark::Em => "<w:i/>",
            Mark::Strong => "<w:b/>",
            Mark::Underline => "<w:u w:val=\"single\"/>",
        })
        .collect()
}
fn revision_attrs(revision: &Revision, serial: &mut usize) -> Result<String, String> {
    let id = *serial;
    if id >= 4096 {
        return Err("export exceeds tracked revision element budget".into());
    }
    *serial += 1;
    Ok(format!(
        "w:id=\"{}\" w:author=\"{}\" w:date=\"{}\"",
        id,
        xml::escape(&revision.author)?,
        xml::escape(&revision.date)?
    ))
}

pub(super) fn render(snapshot: &SceneSnapshot, manifest: &Manifest) -> Result<String, String> {
    let source = crate::review_document::parse_review_body(&snapshot.body)?;
    let mut events = Vec::new();
    let mut cursor = 0usize;
    let mut revision_id = 0;
    for anchor in &manifest.anchors {
        for token in super::slice(&source, cursor, anchor.from)? {
            events.push(Event::Token(token, None));
        }
        let group = manifest
            .groups
            .iter()
            .find(|g| g.id == anchor.group_id)
            .unwrap();
        let hunk = group.hunks.iter().find(|h| h.id == anchor.hunk_id).unwrap();
        events.push(Event::Start(anchor.name.clone()));
        for message in group.messages.iter().filter(|_| {
            manifest
                .anchors
                .iter()
                .find(|a| a.group_id == group.id)
                .is_some_and(|a| a.hunk_id == anchor.hunk_id)
        }) {
            events.push(Event::CommentStart(message.id.to_string()));
        }
        let before = super::canonical(&hunk.original.before);
        let after = super::canonical(&hunk.original.after);
        // A direct formatting change is represented by previous run properties,
        // not by pretending the author's text was deleted and reinserted.
        let unmarked = |tokens: &[FragmentToken]| {
            super::canonical(
                &tokens
                    .iter()
                    .map(|token| match token {
                        FragmentToken::Text { text, .. } => FragmentToken::Text {
                            text: text.clone(),
                            marks: Vec::new(),
                        },
                        other => other.clone(),
                    })
                    .collect::<Vec<_>>(),
            )
        };
        if unmarked(&before) == unmarked(&after) {
            emit_formatting(&before, &after, group, &mut revision_id, &mut events)?;
        } else {
            emit_replacement(
                &before,
                &after,
                &group.author_name,
                group.created_at,
                &mut revision_id,
                &mut events,
            )?;
        }
        for message in group.messages.iter().filter(|_| {
            manifest
                .anchors
                .iter()
                .find(|a| a.group_id == group.id)
                .is_some_and(|a| a.hunk_id == anchor.hunk_id)
        }) {
            events.push(Event::CommentEnd(message.id.to_string()));
            events.push(Event::CommentRef(message.id.to_string()));
        }
        events.push(Event::End(anchor.name.clone()));
        cursor = anchor.to;
    }
    for token in super::slice(
        &source,
        cursor,
        crate::review_document::fragment_width(&source),
    )? {
        events.push(Event::Token(token, None));
    }
    render_events(&events)
}
fn emit_formatting(
    before: &[FragmentToken],
    after: &[FragmentToken],
    group: &super::GroupSnapshot,
    id: &mut usize,
    events: &mut Vec<Event>,
) -> Result<(), String> {
    let (mut a, mut b, mut offset_a, mut offset_b) = (0, 0, 0, 0);
    while a < before.len() && b < after.len() {
        match (&before[a], &after[b]) {
            (
                FragmentToken::Text {
                    text: old,
                    marks: old_marks,
                },
                FragmentToken::Text {
                    text: new,
                    marks: new_marks,
                },
            ) => {
                let count = (old.len() - offset_a).min(new.len() - offset_b);
                let text = old
                    .get(offset_a..offset_a + count)
                    .ok_or("format boundary splits Unicode")?;
                if Some(text) != new.get(offset_b..offset_b + count) {
                    return Err("formatting changes text".into());
                }
                if old_marks == new_marks {
                    events.push(Event::Token(
                        FragmentToken::Text {
                            text: text.into(),
                            marks: old_marks.clone(),
                        },
                        None,
                    ));
                } else {
                    events.push(Event::Format {
                        text: text.into(),
                        old: old_marks.clone(),
                        new: new_marks.clone(),
                        revision: Revision {
                            key: *id,
                            author: group.author_name.clone(),
                            kind: "format".into(),
                            date: crate::package_format::iso8601_utc(group.created_at / 1000),
                        },
                    });
                    *id += 1;
                }
                offset_a += count;
                offset_b += count;
                if offset_a == old.len() {
                    a += 1;
                    offset_a = 0;
                }
                if offset_b == new.len() {
                    b += 1;
                    offset_b = 0;
                }
            }
            (old, new) if old == new => {
                events.push(Event::Token(old.clone(), None));
                a += 1;
                b += 1;
            }
            _ => return Err("formatting has inconsistent paragraph structure".into()),
        }
    }
    if a != before.len() || b != after.len() {
        return Err("formatting has inconsistent lengths".into());
    }
    Ok(())
}
fn emit_replacement(
    before: &[FragmentToken],
    after: &[FragmentToken],
    author: &str,
    created_at: i64,
    id: &mut usize,
    events: &mut Vec<Event>,
) -> Result<(), String> {
    // Equal structural edges belong to the unchanged paragraph container.
    let mut prefix = 0;
    while prefix < before.len().min(after.len())
        && before[prefix] == after[prefix]
        && !matches!(before[prefix], FragmentToken::Text { .. })
    {
        events.push(Event::Token(before[prefix].clone(), None));
        prefix += 1;
    }
    let (mut end_before, mut end_after) = (before.len(), after.len());
    while end_before > prefix
        && end_after > prefix
        && before[end_before - 1] == after[end_after - 1]
        && !matches!(before[end_before - 1], FragmentToken::Text { .. })
    {
        end_before -= 1;
        end_after -= 1;
    }
    let tail = &before[end_before..];
    let before = &before[prefix..end_before];
    let after = &after[prefix..end_after];
    for (kind, tokens) in [("del", before), ("ins", after)] {
        if tokens.is_empty() {
            continue;
        }
        let revision = Revision {
            key: *id,
            author: author.into(),
            kind: kind.into(),
            date: crate::package_format::iso8601_utc(created_at / 1000),
        };
        *id += 1;
        for token in tokens {
            events.push(Event::Token(token.clone(), Some(revision.clone())));
        }
    }
    for token in tail {
        events.push(Event::Token(token.clone(), None));
    }
    Ok(())
}

fn render_events(events: &[Event]) -> Result<String, String> {
    let mut output =
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"{W}\"><w:body>");
    let mut paragraph = false;
    let mut serial = 0;
    let mut bookmarks = BTreeMap::new();
    let mut next_bookmark = 1;
    for (index, event) in events.iter().enumerate() {
        match event {
            Event::Token(FragmentToken::Open, _) => {
                if paragraph {
                    return Err("proposal has inseparable paragraph structure".into());
                }
                paragraph = true;
                output.push_str("<w:p>");
                let end = events[index + 1..]
                    .iter()
                    .position(|event| matches!(event, Event::Token(FragmentToken::Close, _)))
                    .map(|at| at + index + 1)
                    .ok_or("missing paragraph close")?;
                let Event::Token(_, close) = &events[end] else {
                    unreachable!()
                };
                let next_open = events
                    .iter()
                    .enumerate()
                    .skip(end + 1)
                    .find_map(|(at, event)| match event {
                        Event::Token(FragmentToken::Open, r) => Some((at, r)),
                        _ => None,
                    });
                let open = next_open.map(|(_, change)| change);
                let whole_next_nonfinal = next_open.is_some_and(|(at, change)| {
                    let next_close = events.iter().enumerate().skip(at + 1).find_map(
                        |(end, event)| match event {
                            Event::Token(FragmentToken::Close, close) => Some((end, close)),
                            _ => None,
                        },
                    );
                    next_close.is_some_and(|(end, close)| {
                        change.is_some()
                            && change == close
                            && events[end + 1..]
                                .iter()
                                .any(|e| matches!(e, Event::Token(FragmentToken::Open, _)))
                    })
                });
                let change = match (close, open) {
                    (Some(a), Some(Some(b))) if a != b => {
                        return Err("interleaved paragraph revisions".into())
                    }
                    (Some(a), Some(_)) => Some(a),
                    (None, Some(Some(b))) if !whole_next_nonfinal => Some(b),
                    _ => None,
                };
                if let Some(revision) = change {
                    output.push_str(&format!(
                        "<w:pPr><w:rPr><w:{} {}/></w:rPr></w:pPr>",
                        revision.kind,
                        revision_attrs(revision, &mut serial)?
                    ));
                }
            }
            Event::Token(FragmentToken::Close, _) => {
                if !paragraph {
                    return Err("unbalanced paragraph".into());
                }
                paragraph = false;
                output.push_str("</w:p>");
            }
            Event::Token(FragmentToken::Text { text, marks }, revision) => {
                if !paragraph {
                    return Err("text outside paragraph".into());
                }
                if let Some(revision) = revision {
                    output.push_str(&format!(
                        "<w:{} {}>",
                        revision.kind,
                        revision_attrs(revision, &mut serial)?
                    ));
                }
                let text_tag = if revision.as_ref().is_some_and(|r| r.kind == "del") {
                    "delText"
                } else {
                    "t"
                };
                output.push_str(&format!("<w:r><w:rPr>{}</w:rPr><w:{text_tag} xml:space=\"preserve\">{}</w:{text_tag}></w:r>",rpr(marks),xml::escape(text)?));
                if let Some(revision) = revision {
                    output.push_str(&format!("</w:{}>", revision.kind));
                }
            }
            Event::Format {
                text,
                old,
                new,
                revision,
            } => {
                if !paragraph {
                    return Err("formatting outside paragraph".into());
                }
                output.push_str(&format!("<w:r><w:rPr>{}<w:rPrChange {}><w:rPr>{}</w:rPr></w:rPrChange></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",rpr(new),revision_attrs(revision, &mut serial)?,rpr(old),xml::escape(text)?));
            }
            Event::Start(name) => {
                let id = next_bookmark;
                next_bookmark += 1;
                bookmarks.insert(name.clone(), id);
                output.push_str(&format!(
                    "<w:bookmarkStart w:id=\"{id}\" w:name=\"{}\"/>",
                    xml::escape(name)?
                ));
            }
            Event::End(name) => {
                let id = bookmarks.get(name).ok_or("bookmark end without start")?;
                output.push_str(&format!("<w:bookmarkEnd w:id=\"{id}\"/>"));
            }
            Event::CommentStart(id) => output.push_str(&format!(
                "<w:commentRangeStart w:id=\"{}\"/>",
                xml::escape(id)?
            )),
            Event::CommentEnd(id) => output.push_str(&format!(
                "<w:commentRangeEnd w:id=\"{}\"/>",
                xml::escape(id)?
            )),
            Event::CommentRef(id) => {
                if !paragraph {
                    return Err("comment reference outside paragraph is unsupported".into());
                }
                output.push_str(&format!(
                    "<w:r><w:commentReference w:id=\"{}\"/></w:r>",
                    xml::escape(id)?
                ));
            }
        }
    }
    if paragraph {
        return Err("unclosed paragraph".into());
    }
    output.push_str("</w:body></w:document>");
    Ok(output)
}
