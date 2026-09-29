use super::{
    xml::{self, Element, W},
    Manifest,
};
use std::collections::{BTreeMap, BTreeSet};
pub(super) const CUSTOM: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const VT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const PREFIX: &str = "WritingReviewManifest";
const CHUNK: usize = 16 * 1024;
const MAX: usize = 16 * 1024 * 1024;
pub(super) fn write(manifest: &Manifest) -> Result<String, String> {
    let json = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    if json.len() > MAX {
        return Err("review manifest exceeds limit".into());
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < json.len() {
        let mut end = (start + CHUNK).min(json.len());
        while !json.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&json[start..end]);
        start = end;
    }
    let mut result = format!("<Properties xmlns=\"{CUSTOM}\" xmlns:vt=\"{VT}\">");
    for (index, (name, value)) in
        std::iter::once((format!("{PREFIX}Count"), chunks.len().to_string()))
            .chain(
                chunks
                    .into_iter()
                    .enumerate()
                    .map(|(n, text)| (format!("{PREFIX}{n:04}"), text.to_string())),
            )
            .enumerate()
    {
        result.push_str(&format!("<property fmtid=\"{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}\" pid=\"{}\" name=\"{name}\"><vt:lpwstr>{}</vt:lpwstr></property>",index+2,xml::escape(&value)?));
    }
    result.push_str("</Properties>");
    Ok(result)
}
pub(super) fn read(root: &Element) -> Result<Manifest, String> {
    if !root.is(CUSTOM, "Properties") {
        return Err("missing standard review properties".into());
    }
    root.only_attrs(&[])?;
    root.structural()?;
    let mut values = BTreeMap::new();
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut size = 0;
    for prop in &root.children {
        if !prop.is(CUSTOM, "property") {
            return Err("invalid custom property".into());
        }
        prop.only_attrs(&[("", "fmtid"), ("", "pid"), ("", "name")])?;
        prop.structural()?;
        let name = prop.required("", "name")?;
        let id = prop
            .required("", "pid")?
            .parse::<u32>()
            .map_err(|_| "invalid property id")?;
        if id < 2 || !ids.insert(id) || !names.insert(name) {
            return Err("duplicate custom property".into());
        }
        if !name.starts_with(PREFIX) {
            continue;
        }
        if prop.children.len() != 1
            || !prop.children[0].is(VT, "lpwstr")
            || !prop.children[0].children.is_empty()
        {
            return Err("review property is not a string".into());
        }
        prop.children[0].only_attrs(&[])?;
        let text = &prop.children[0].text;
        size += text.len();
        if size > MAX + 32 {
            return Err("review manifest exceeds limit".into());
        }
        values.insert(name, text.as_str());
    }
    let count = values
        .remove(format!("{PREFIX}Count").as_str())
        .ok_or("missing review manifest count")?
        .parse::<usize>()
        .map_err(|_| "invalid manifest count")?;
    if count == 0 || count > 1024 || values.len() != count {
        return Err("missing or extra manifest chunk".into());
    }
    let mut json = String::with_capacity(size);
    for n in 0..count {
        let key = format!("{PREFIX}{n:04}");
        let value = values
            .remove(key.as_str())
            .ok_or("missing manifest chunk")?;
        if value.len() > CHUNK {
            return Err("oversized manifest chunk".into());
        }
        json.push_str(value);
    }
    serde_json::from_str(&json).map_err(|_| "invalid strict review manifest".into())
}
fn empty(name: &str) -> Element {
    Element {
        ns: W.into(),
        name: name.into(),
        attrs: BTreeMap::new(),
        children: Vec::new(),
        text: String::new(),
    }
}
fn opaque(e: &Element, allowed: &[&str]) -> Result<(), String> {
    e.leaf()?;
    e.only_attrs(&allowed.iter().map(|a| (W, *a)).collect::<Vec<_>>())
}
fn layout(e: &Element) -> Result<bool, String> {
    if e.ns != W {
        return Ok(false);
    }
    let allowed: &[&str] = match e.name.as_str() {
        "rFonts" => &[
            "ascii",
            "hAnsi",
            "eastAsia",
            "cs",
            "asciiTheme",
            "hAnsiTheme",
            "eastAsiaTheme",
            "cstheme",
            "hint",
        ],
        "lang" => &["val", "eastAsia", "bidi"],
        "color" => &["val", "themeColor", "themeTint", "themeShade"],
        "spacing" => &[
            "val",
            "before",
            "after",
            "beforeAutospacing",
            "afterAutospacing",
            "line",
            "lineRule",
        ],
        "ind" => &["left", "right", "firstLine", "hanging", "start", "end"],
        "sz"
        | "szCs"
        | "kern"
        | "position"
        | "bidi"
        | "jc"
        | "keepNext"
        | "keepLines"
        | "widowControl"
        | "contextualSpacing"
        | "snapToGrid"
        | "suppressAutoHyphens"
        | "overflowPunct" => &["val"],
        _ => return Ok(false),
    };
    opaque(e, allowed)?;
    Ok(true)
}
fn neutral_rpr(e: &Element) -> Result<(), String> {
    e.only_attrs(&[])?;
    e.structural()?;
    for child in &e.children {
        if child.ns == W && matches!(child.name.as_str(), "b" | "i" | "u" | "bCs" | "iCs") {
            opaque(child, &["val"])?;
            if !matches!(child.attr(W, "val"), Some("0" | "false" | "off" | "none")) {
                return Err("style-derived review marks are unsupported".into());
            }
        } else if !layout(child)? {
            return Err("unsupported inherited run semantics".into());
        }
    }
    Ok(())
}
struct Styles<'a> {
    styles: BTreeMap<&'a str, &'a Element>,
}
impl<'a> Styles<'a> {
    fn new(root: Option<&'a Element>) -> Result<Self, String> {
        let mut result = Self {
            styles: BTreeMap::new(),
        };
        let Some(root) = root else { return Ok(result) };
        if !root.is(W, "styles") {
            return Err("invalid styles part".into());
        }
        for child in &root.children {
            if child.is(W, "style") {
                let id = child.required(W, "styleId")?;
                if result.styles.insert(id, child).is_some() {
                    return Err("duplicate style identity".into());
                }
            } else if child.is(W, "docDefaults") {
                for defaults in &child.children {
                    for properties in &defaults.children {
                        if properties.is(W, "rPr") {
                            neutral_rpr(properties)?;
                        } else if properties.is(W, "pPr") {
                            for item in &properties.children {
                                if !layout(item)? {
                                    return Err("unsupported default paragraph semantics".into());
                                }
                            }
                        } else {
                            return Err("unsupported document defaults".into());
                        }
                    }
                }
            } else if !child.is(W, "latentStyles") {
                return Err("unsupported styles metadata".into());
            }
        }
        for (id, style) in &result.styles {
            if matches!(style.attr(W, "type"), Some("paragraph" | "character"))
                && matches!(style.attr(W, "default"), Some("1" | "true" | "on"))
            {
                result.check(id, &mut BTreeSet::new())?;
            }
        }
        Ok(result)
    }
    fn check(&self, id: &str, seen: &mut BTreeSet<String>) -> Result<(), String> {
        if seen.len() > 64 || !seen.insert(id.into()) {
            return Err("cyclic or excessive style inheritance".into());
        }
        let style = self.styles.get(id).ok_or("missing referenced style")?;
        for child in &style.children {
            if child.is(W, "basedOn") {
                self.check(child.required(W, "val")?, seen)?;
            } else if child.is(W, "rPr") {
                neutral_rpr(child)?;
            } else if child.is(W, "pPr") {
                for item in &child.children {
                    if !layout(item)? {
                        return Err("unsupported inherited paragraph semantics".into());
                    }
                }
            } else if child.ns != W
                || !matches!(
                    child.name.as_str(),
                    "name"
                        | "next"
                        | "link"
                        | "aliases"
                        | "uiPriority"
                        | "qFormat"
                        | "semiHidden"
                        | "unhideWhenUsed"
                        | "rsid"
                        | "personal"
                        | "personalCompose"
                        | "personalReply"
                        | "autoRedefine"
                        | "locked"
                )
            {
                return Err("unsupported referenced style semantics".into());
            }
        }
        seen.remove(id);
        Ok(())
    }
}
/// Remove only documented layout/metadata that cannot change the host's text
/// or three marks. Unknown prose markup and inherited marks remain refusals.
pub(super) fn document(
    root: &Element,
    styles: Option<&Element>,
    tag: &str,
) -> Result<Element, String> {
    let styles = Styles::new(styles)?;
    let mut root = root.clone();
    root.attrs.remove(&(MC.into(), "Ignorable".into()));
    fn clean(e: &mut Element, styles: &Styles, tag: &str) -> Result<(), String> {
        if e.ns == W && matches!(e.name.as_str(), "pPr" | "rPr") {
            e.only_attrs(&[])?;
            e.structural()?;
            let mut children = Vec::new();
            for mut child in std::mem::take(&mut e.children) {
                if child.is(W, "pStyle") || child.is(W, "rStyle") {
                    opaque(&child, &["val"])?;
                    styles.check(child.required(W, "val")?, &mut BTreeSet::new())?;
                } else if layout(&child)? {
                } else {
                    clean(&mut child, styles, tag)?;
                    if !child.is(W, "rPr") || !child.children.is_empty() {
                        children.push(child);
                    }
                }
            }
            e.children = children;
        } else {
            let mut children = Vec::new();
            for mut child in std::mem::take(&mut e.children) {
                if child.is(W, "sdt") {
                    child.only_attrs(&[])?;
                    child.structural()?;
                    if child.children.len() != 2
                        || !child.children[0].is(W, "sdtPr")
                        || !child.children[1].is(W, "sdtContent")
                    {
                        return Err("unsupported content control".into());
                    }
                    child.children[0].only_attrs(&[])?;
                    child.children[0].structural()?;
                    child.children[1].only_attrs(&[])?;
                    child.children[1].structural()?;
                    for prop in &child.children[0].children {
                        if prop.is(W, "tag") {
                            opaque(prop, &["val"])?;
                            if prop.attr(W, "val") != Some(tag) {
                                return Err("scene control tag changed".into());
                            }
                        } else if prop.is(W, "text") || prop.is(W, "richText") {
                            prop.leaf()?;
                            prop.only_attrs(&[])?;
                        } else {
                            return Err("unsupported content control properties".into());
                        }
                    }
                    let mut content = child.children.pop().unwrap();
                    clean(&mut content, styles, tag)?;
                    children.extend(content.children);
                } else if child.is(W, "sectPr") && e.is(W, "body") {
                    child.only_attrs(&[])?;
                    child.structural()?;
                    for prop in &child.children {
                        if prop.ns != W
                            || !matches!(
                                prop.name.as_str(),
                                "type"
                                    | "pgSz"
                                    | "pgMar"
                                    | "pgNumType"
                                    | "formProt"
                                    | "textDirection"
                                    | "docGrid"
                                    | "cols"
                            )
                        {
                            return Err("unsupported section semantics".into());
                        }
                        prop.leaf()?;
                        if prop.attrs.keys().any(|(ns, _)| ns != W) {
                            return Err("unsupported section relationship".into());
                        }
                    }
                } else {
                    clean(&mut child, styles, tag)?;
                    if !(child.is(W, "pPr") || child.is(W, "rPr")) || !child.children.is_empty() {
                        children.push(child);
                    }
                }
            }
            e.children = children;
            if e.is(W, "rPrChange") && e.children.is_empty() {
                e.children.push(empty("rPr"));
            }
        }
        Ok(())
    }
    clean(&mut root, &styles, tag)?;
    if root.children.len() != 1 || !root.children[0].is(W, "body") {
        return Err("document needs one scene body".into());
    }
    // The complete body is the scene; the synthetic wrapper only adapts the
    // strict event parser and supplies no authority from the returned package.
    let body = &mut root.children[0];
    let mut content = empty("sdtContent");
    content.children = std::mem::take(&mut body.children);
    let mut prop = empty("tag");
    prop.attrs.insert((W.into(), "val".into()), tag.into());
    let mut props = empty("sdtPr");
    props.children.push(prop);
    let mut sdt = empty("sdt");
    sdt.children = vec![props, content];
    body.children.push(sdt);
    Ok(root)
}

pub(super) fn comment(root: &Element, styles: Option<&Element>) -> Result<String, String> {
    let mut body = empty("body");
    body.children = root.children.clone();
    fn indicators(e: &mut Element) -> Result<(), String> {
        let mut children = Vec::new();
        for mut child in std::mem::take(&mut e.children) {
            if child.is(W, "annotationRef") && e.is(W, "r") {
                child.leaf()?;
                child.only_attrs(&[])?;
            } else {
                indicators(&mut child)?;
                children.push(child);
            }
        }
        e.children = children;
        Ok(())
    }
    indicators(&mut body)?;
    let mut doc = empty("document");
    doc.children.push(body);
    let normalized = document(&doc, styles, "comment")?;
    let parsed = super::document::parse(&normalized, "comment")?;
    if !parsed.revisions.is_empty() {
        return Err("revised discussion text is unsupported".into());
    }
    let projection = super::document::project(&parsed.events, &BTreeSet::new())?;
    if !projection.anchors.is_empty() || !projection.comments.is_empty() {
        return Err("nested discussion anchors are unsupported".into());
    }
    let mut paragraphs = Vec::new();
    let mut text = String::new();
    for token in projection.tokens {
        match token {
            super::FragmentToken::Open => {}
            super::FragmentToken::Close => {
                paragraphs.push(std::mem::take(&mut text));
            }
            super::FragmentToken::Text { text: part, marks } => {
                if !marks.is_empty() {
                    return Err("only plain immutable comments are supported".into());
                }
                text.push_str(&part);
            }
        }
    }
    Ok(paragraphs.join("\n"))
}
