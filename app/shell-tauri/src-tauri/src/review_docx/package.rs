use super::xml::{Budget, Element, CT, REL, W};
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const OFFICE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const MANIFEST_PATH: &str = "docProps/custom.xml";
fn entry(name: &str, text: String) -> crate::package_format::Entry {
    crate::package_format::Entry {
        name: name.into(),
        bytes: text.into_bytes(),
    }
}

pub(super) fn export(snapshot: &SceneSnapshot) -> Result<ReviewPackage, String> {
    let manifest = manifest(snapshot)?;
    let document = document::render(snapshot, &manifest)?;
    let messages: Vec<_> = manifest
        .groups
        .iter()
        .flat_map(|group| group.messages.clone())
        .collect();
    let mut comments = format!("<w:comments xmlns:w=\"{W}\">");
    for message in &messages {
        comments.push_str(&format!(
            "<w:comment w:id=\"{}\" w:author=\"{}\" w:date=\"{}\">",
            message.id,
            xml::escape(&message.author_name)?,
            crate::package_format::iso8601_utc(message.created_at / 1000)
        ));
        for paragraph in message.body.split('\n') {
            comments.push_str(&format!(
                "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                xml::escape(paragraph)?
            ));
        }
        comments.push_str("</w:comment>");
    }
    comments.push_str("</w:comments>");
    let types=format!("<Types xmlns=\"{CT}\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/><Override PartName=\"/word/comments.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml\"/><Override PartName=\"/docProps/custom.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.custom-properties+xml\"/></Types>");
    let entries=vec![entry("[Content_Types].xml",types),entry("_rels/.rels",format!("<Relationships xmlns=\"{REL}\"><Relationship Id=\"main\" Type=\"{OFFICE_REL}officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"review\" Type=\"{OFFICE_REL}custom-properties\" Target=\"{MANIFEST_PATH}\"/></Relationships>")),
        entry("word/document.xml",document),entry("word/_rels/document.xml.rels",format!("<Relationships xmlns=\"{REL}\"><Relationship Id=\"settings\" Type=\"{OFFICE_REL}settings\" Target=\"settings.xml\"/><Relationship Id=\"comments\" Type=\"{OFFICE_REL}comments\" Target=\"comments.xml\"/></Relationships>")),
        entry("word/settings.xml",format!("<w:settings xmlns:w=\"{W}\"><w:trackRevisions/></w:settings>")),entry("word/comments.xml",comments),
        entry(MANIFEST_PATH,metadata::write(&manifest)?)];
    let bytes = crate::package_format::zip(&entries);
    // Both projections are checked against independent host document semantics;
    // an unrepresentable structural hunk never escapes as a misleading package.
    let plan = inspect_return(&bytes, snapshot)?;
    if !plan.decisions.is_empty() || !plan.new_hunks.is_empty() || !plan.new_messages.is_empty() {
        return Err("export did not preserve pending review state".into());
    }
    let mut authors: BTreeSet<String> = manifest
        .groups
        .iter()
        .map(|group| group.author_name.clone())
        .collect();
    authors.extend(messages.iter().map(|message| message.author_name.clone()));
    Ok(ReviewPackage {
        bytes,
        manifest,
        disclosure: Disclosure {
            authors: authors.into_iter().collect(),
            messages,
        },
    })
}

fn parts() -> BTreeMap<&'static str, (&'static str, &'static str)> {
    BTreeMap::from([
        (
            "word/document.xml",
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                "officeDocument",
            ),
        ),
        (
            MANIFEST_PATH,
            (
                "application/vnd.openxmlformats-officedocument.custom-properties+xml",
                "custom-properties",
            ),
        ),
        (
            "word/settings.xml",
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
                "settings",
            ),
        ),
        (
            "word/comments.xml",
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
                "comments",
            ),
        ),
        (
            "word/styles.xml",
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
                "styles",
            ),
        ),
        (
            "word/fontTable.xml",
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
                "fontTable",
            ),
        ),
        (
            "word/theme/theme1.xml",
            (
                "application/vnd.openxmlformats-officedocument.theme+xml",
                "theme",
            ),
        ),
        (
            "docProps/core.xml",
            (
                "application/vnd.openxmlformats-package.core-properties+xml",
                "core-properties",
            ),
        ),
        (
            "docProps/app.xml",
            (
                "application/vnd.openxmlformats-officedocument.extended-properties+xml",
                "extended-properties",
            ),
        ),
    ])
}
fn package_metadata(roots: &BTreeMap<&str, Element>) -> Result<(), String> {
    let known = parts();
    let types = &roots["[Content_Types].xml"];
    types.only_attrs(&[])?;
    types.structural()?;
    if !types.is(CT, "Types") {
        return Err("invalid content types root".into());
    }
    let mut overrides = BTreeMap::new();
    let mut defaults = BTreeMap::new();
    for child in &types.children {
        child.leaf()?;
        if child.is(CT, "Override") {
            child.only_attrs(&[("", "PartName"), ("", "ContentType")])?;
            let name = child
                .required("", "PartName")?
                .strip_prefix('/')
                .ok_or("invalid part name")?;
            let kind = child.required("", "ContentType")?;
            if known.get(name).is_none_or(|(wanted, _)| *wanted != kind)
                || !roots.contains_key(name)
                || overrides.insert(name, kind).is_some()
            {
                return Err("unknown or duplicate content type".into());
            }
        } else if child.is(CT, "Default") {
            child.only_attrs(&[("", "Extension"), ("", "ContentType")])?;
            let ext = child.required("", "Extension")?;
            let kind = child.required("", "ContentType")?;
            if !matches!(
                (ext, kind),
                ("xml", "application/xml")
                    | ("jpeg", "image/jpeg")
                    | ("png", "image/png")
                    | ("fntdata", "application/x-fontdata")
                    | (
                        "rels",
                        "application/vnd.openxmlformats-package.relationships+xml"
                    )
            ) || defaults.insert(ext, kind).is_some()
            {
                return Err("unsupported content type default".into());
            }
        } else {
            return Err("unsupported content type declaration".into());
        }
    }
    for name in roots.keys().filter(|name| known.contains_key(**name)) {
        if !overrides.contains_key(name) {
            return Err("missing content type override".into());
        }
    }
    for (path, base) in [
        ("_rels/.rels", ""),
        ("word/_rels/document.xml.rels", "word/"),
    ] {
        let root = &roots[path];
        root.only_attrs(&[])?;
        root.structural()?;
        if !root.is(REL, "Relationships") {
            return Err("invalid relationship root".into());
        }
        let mut ids = BTreeSet::new();
        let mut targets = BTreeSet::new();
        for relation in &root.children {
            if !relation.is(REL, "Relationship") {
                return Err("unsupported relationship element".into());
            }
            relation.leaf()?;
            relation.only_attrs(&[("", "Id"), ("", "Type"), ("", "Target")])?;
            let target = relation.required("", "Target")?;
            let id = relation.required("", "Id")?;
            if id.is_empty() || !ids.insert(id) || !super::zip::safe_name(target) {
                return Err("external or duplicate relationship".into());
            }
            let name = format!("{base}{target}");
            let (_, suffix) = known
                .get(name.as_str())
                .ok_or("unsupported relationship target")?;
            let kind = if *suffix == "core-properties" {
                "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties".to_string()
            } else {
                format!("{OFFICE_REL}{suffix}")
            };
            if relation.required("", "Type")? != kind
                || !roots.contains_key(name.as_str())
                || !targets.insert(name.clone())
                || (base.is_empty() && name.starts_with("word/") && name != "word/document.xml")
                || (!base.is_empty() && name == "word/document.xml")
            {
                return Err("inconsistent package relationship".into());
            }
        }
        for required in if base.is_empty() {
            vec!["word/document.xml", MANIFEST_PATH]
        } else {
            vec!["word/settings.xml"]
        } {
            if !targets.contains(required) {
                return Err("required relationship missing".into());
            }
        }
        if !base.is_empty()
            && roots.contains_key("word/comments.xml")
            && !targets.contains("word/comments.xml")
        {
            return Err("comment relationship missing".into());
        }
    }
    let settings = &roots["word/settings.xml"];
    if !settings.is(W, "settings") {
        return Err("invalid settings".into());
    }
    settings.only_attrs(&[])?;
    settings.structural()?;
    let mut seen = BTreeSet::new();
    for setting in &settings.children {
        if setting.ns != W
            || !matches!(
                setting.name.as_str(),
                "trackRevisions"
                    | "zoom"
                    | "defaultTabStop"
                    | "autoHyphenation"
                    | "hyphenationZone"
                    | "compat"
                    | "themeFontLang"
            )
            || !seen.insert(&setting.name)
        {
            return Err("unsupported or duplicate review setting".into());
        }
        if setting.name == "trackRevisions" {
            setting.leaf()?;
            setting.only_attrs(&[(W, "val")])?;
        } else if setting.name != "compat" {
            setting.leaf()?;
            if setting.attrs.keys().any(|(ns, _)| ns != W) {
                return Err("unsupported settings relationship".into());
            }
        } else {
            for item in &setting.children {
                if item.ns != W
                    || !matches!(
                        item.name.as_str(),
                        "compatSetting"
                            | "doNotUseHTMLParagraphAutoSpacing"
                            | "balanceSingleByteDoubleByteWidth"
                            | "ulTrailSpace"
                            | "doNotExpandShiftReturn"
                    )
                {
                    return Err("unsupported compatibility setting".into());
                }
                item.leaf()?;
                if item.attrs.keys().any(|(ns, _)| ns != W) {
                    return Err("unsupported compatibility relationship".into());
                }
            }
        }
    }
    Ok(())
}
#[derive(Debug)]
struct Comment {
    author: String,
    body: String,
}
fn comments(root: &Element, styles: Option<&Element>) -> Result<BTreeMap<String, Comment>, String> {
    if !root.is(W, "comments") {
        return Err("invalid comments part".into());
    }
    root.only_attrs(&[(
        "http://schemas.openxmlformats.org/markup-compatibility/2006",
        "Ignorable",
    )])?;
    root.structural()?;
    let mut result = BTreeMap::new();
    for comment in &root.children {
        if !comment.is(W, "comment") {
            return Err("threaded or unsupported comment".into());
        }
        comment.only_attrs(&[(W, "id"), (W, "author"), (W, "date"), (W, "initials")])?;
        comment.structural()?;
        let id = comment
            .required(W, "id")?
            .parse::<u32>()
            .map_err(|_| "invalid comment id")?
            .to_string();
        let author = comment.required(W, "author")?;
        if !valid_name(author) {
            return Err("invalid comment author".into());
        }
        let text = metadata::comment(comment, styles)?;
        if text.trim().is_empty()
            || text.len() > 4000
            || result
                .insert(
                    id,
                    Comment {
                        author: author.into(),
                        body: text,
                    },
                )
                .is_some()
        {
            return Err("invalid or duplicate comment".into());
        }
    }
    Ok(result)
}

pub(super) fn inspect_return(bytes: &[u8], snapshot: &SceneSnapshot) -> Result<ReviewPlan, String> {
    let expected = manifest(snapshot)?;
    let entries = super::zip::read(bytes)?;
    let known = parts();
    if entries.keys().any(|name| {
        !known.contains_key(name.as_str())
            && ![
                "[Content_Types].xml",
                "_rels/.rels",
                "word/_rels/document.xml.rels",
            ]
            .contains(&name.as_str())
    }) {
        return Err("unsupported review package part".into());
    }
    for required in [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/settings.xml",
        MANIFEST_PATH,
    ] {
        if !entries.contains_key(required) {
            return Err("required review package part missing".into());
        }
    }
    let mut budget = Budget::default();
    let mut roots = BTreeMap::new();
    for (name, data) in &entries {
        roots.insert(
            name.as_str(),
            xml::parse(data, &mut budget).map_err(|e| format!("{name}: {e}"))?,
        );
    }
    package_metadata(&roots)?;
    let received = metadata::read(&roots[MANIFEST_PATH])?;
    if received != expected {
        return Err("review manifest is stale, modified or belongs to another scene".into());
    }
    let comment_count = roots
        .get("word/comments.xml")
        .map_or(0, |root| root.children.len());
    let style_bytes = entries.get("word/styles.xml").map_or(0, Vec::len);
    if style_bytes.saturating_mul(comment_count + 1) > 64 * 1024 * 1024 {
        return Err("style and comment reconciliation exceeds work limit".into());
    }
    let normalized = metadata::document(
        &roots["word/document.xml"],
        roots.get("word/styles.xml"),
        &expected.tag,
    )?;
    let mut parsed = document::parse(&normalized, &expected.tag)?;
    document::normalize_anchors(&mut parsed, &expected)?;
    let all: BTreeSet<usize> = parsed.revisions.iter().map(|r| r.key).collect();
    let rejected = document::project(&parsed.events, &BTreeSet::new())?;
    let accepted = document::project(&parsed.events, &all)?;
    let wanted_names: BTreeSet<_> = expected.anchors.iter().map(|a| a.name.clone()).collect();
    if rejected.anchors.keys().cloned().collect::<BTreeSet<_>>() != wanted_names {
        return Err("missing or unexpected bookmark mapping".into());
    }
    let mut decisions = Vec::new();
    let mut pending_keys = BTreeSet::new();
    let mut shift = 0isize;
    let mut accepted_source = body(&review_document::parse_review_body(&snapshot.body)?)?;
    let mut accepted_old = Vec::new();
    for anchor in &expected.anchors {
        let group = expected
            .groups
            .iter()
            .find(|g| g.id == anchor.group_id)
            .unwrap();
        let hunk = group.hunks.iter().find(|h| h.id == anchor.hunk_id).unwrap();
        let (from, to) = rejected.anchors[&anchor.name];
        let (new_from, new_to) = accepted.anchors[&anchor.name];
        let old = canonical(&hunk.original.before);
        let new = canonical(&hunk.original.after);
        let actual = slice(&rejected.tokens, from, to)?;
        let candidate = slice(&accepted.tokens, new_from, new_to)?;
        let mut inside = false;
        let mut keys = BTreeSet::new();
        for event in &parsed.events {
            match event {
                document::Event::Start(name) if name == &anchor.name => inside = true,
                document::Event::End(name) if name == &anchor.name => inside = false,
                document::Event::Token(_, Some(r))
                | document::Event::Format { revision: r, .. }
                    if inside =>
                {
                    keys.insert(r.key);
                }
                _ => {}
            }
        }
        let accepted_hunk = if actual == old && candidate == new && !keys.is_empty() {
            if keys
                .iter()
                .any(|key| parsed.revisions[*key].author != group.author_name)
            {
                return Err("pending revision author changed".into());
            }
            pending_keys.extend(keys);
            false
        } else if keys
            .iter()
            .any(|key| parsed.revisions[*key].author == group.author_name)
        {
            return Err("ambiguous original-author revisions remain in proposal".into());
        } else if actual == new {
            decisions.push(OldDecision::Accept(anchor.hunk_id));
            accepted_old.push(hunk);
            true
        } else if actual == old {
            decisions.push(OldDecision::Reject(anchor.hunk_id));
            false
        } else {
            return Err("anchored before/after content no longer matches stored proposal".into());
        };
        let expected_from = anchor
            .from
            .checked_add_signed(shift)
            .ok_or("invalid shifted anchor")?;
        let width = if accepted_hunk {
            review_document::fragment_width(&new)
        } else {
            anchor.to - anchor.from
        };
        if (from, to) != (expected_from, expected_from + width) {
            return Err("review bookmark moved or reordered".into());
        }
        if accepted_hunk {
            shift += width as isize - (anchor.to - anchor.from) as isize;
        }
    }
    for hunk in accepted_old.into_iter().rev() {
        accepted_source = review_document::apply_hunk(
            &accepted_source,
            &ReviewHunk {
                from: hunk.from,
                to: hunk.to,
                before: hunk.original.before.clone(),
                after: hunk.original.after.clone(),
            },
        )?;
    }
    if body(&rejected.tokens)? != accepted_source {
        return Err("untracked edit changed the accepted baseline".into());
    }
    let units: Vec<_> = document::units(&parsed)
        .into_iter()
        .filter(|keys| keys.iter().any(|key| !pending_keys.contains(key)))
        .collect();
    if units.len() > 500 || accepted_source.len().saturating_mul(units.len()) > 128 * 1024 * 1024 {
        return Err("new review reconciliation exceeds work limit".into());
    }
    let mut new_hunks = Vec::new();
    for keys in units {
        if keys.iter().any(|key| pending_keys.contains(key)) {
            return Err("new revision is inseparable from a pending proposal".into());
        }
        let revision = &parsed.revisions[*keys.first().unwrap()];
        let projection = document::project(&parsed.events, &keys)?;
        let candidate = body(&projection.tokens)?;
        let Some((from, to, new_to)) =
            review_document::changed_interval(&accepted_source, &candidate)?
        else {
            continue;
        };
        let hunk = ReviewHunk {
            from,
            to,
            before: slice(&rejected.tokens, from, to)?,
            after: slice(&projection.tokens, from, new_to)?,
        };
        if review_document::apply_hunk(&accepted_source, &hunk)? != candidate {
            return Err("revision fragment differs from validated projection".into());
        }
        for anchor in &expected.anchors {
            if !decisions.iter().any(|d|matches!(d,OldDecision::Accept(id)|OldDecision::Reject(id) if *id==anchor.hunk_id)) {
                let (a,b)=rejected.anchors[&anchor.name];
                if from<=b && to>=a{return Err("new revision intersects an undecided proposal".into());}
            }
        }
        new_hunks.push(AuthoredHunk {
            author_name: revision.author.clone(),
            hunk,
        });
    }
    new_hunks.sort_by_key(|h| (h.hunk.from, h.hunk.to));
    if new_hunks.len() > 500
        || new_hunks
            .windows(2)
            .any(|h| h[0].hunk.to > h[1].hunk.from || h[0].hunk.from == h[1].hunk.from)
    {
        return Err("new revisions overlap or cannot be separated faithfully".into());
    }
    let returned_comments = roots
        .get("word/comments.xml")
        .map(|root| comments(root, roots.get("word/styles.xml")))
        .transpose()?
        .unwrap_or_default();
    if returned_comments.keys().cloned().collect::<BTreeSet<_>>() != rejected.refs {
        return Err("comment references do not match comments part".into());
    }
    let mut existing = BTreeSet::new();
    for group in &expected.groups {
        let anchor = expected
            .anchors
            .iter()
            .find(|a| a.group_id == group.id)
            .ok_or("missing discussion anchor")?;
        for message in &group.messages {
            let matches: Vec<_> = returned_comments
                .iter()
                .filter(|(id, returned)| {
                    !existing.contains(*id)
                        && returned.author == message.author_name
                        && returned.body == message.body
                        && rejected.comments.get(*id) == rejected.anchors.get(&anchor.name)
                        && accepted.comments.get(*id) == accepted.anchors.get(&anchor.name)
                })
                .collect();
            if matches.len() != 1 {
                return Err("exported message or anchor missing, changed or ambiguous".into());
            }
            existing.insert(matches[0].0.clone());
        }
    }
    let mut new_messages = Vec::new();
    for (id, comment) in returned_comments {
        if existing.contains(&id) {
            continue;
        }
        let (from, to) = rejected.comments[&id];
        let candidates: Vec<_> = expected
            .anchors
            .iter()
            .filter(|a| {
                rejected.anchors[&a.name] == (from, to)
                    && accepted.comments.get(&id) == accepted.anchors.get(&a.name)
            })
            .collect();
        if candidates.len() != 1 {
            return Err("new comment does not identify one known hunk".into());
        }
        new_messages.push(NewMessage {
            group_id: candidates[0].group_id,
            author_name: comment.author,
            body: comment.body,
        });
    }
    Ok(ReviewPlan {
        expected,
        decisions,
        new_hunks,
        new_messages,
        rejected_projection: accepted_source,
        accepted_projection: body(&accepted.tokens)?,
    })
}
