// app/shell-tauri/src-tauri/src/docx_import.rs
// DOCX -> outline, the import half of the export. Product spec section 12:
// "DOCX import/export for editor handoff, supported by round-trip fixtures
// and explicit loss reports".
//
// PURE, exactly as `import.rs` and `docx.rs` are: no I/O, no `Store`, no
// `Path`. Bytes in, a structure out.
//
// A MINIMAL XML WALKER OF ITS OWN, NO DEPENDENCY. `epub.rs` and `docx.rs`
// set the zero-dependency precedent for this crate; this module's own reason
// is the same one `epub::read_zip` gives for hand-rolling a zip reader
// rather than pulling one in for a few kilobytes of test fixture. The walker
// is a stack-based tree builder over `<tag attr="val">text</tag>` and
// nothing else: no DTD, no namespaces beyond matching an element by its
// LOCAL NAME after any colon (a writer's file may prefix `w:` differently,
// or not at all), no CDATA (Word never writes it; met as text if it ever
// is), comments and the XML declaration skipped outright.
//
// HEADINGS ARE RESOLVED THROUGH `styles.xml`, NEVER THROUGH THE STYLE ID
// ALONE. Word LOCALIZES style ids -- German Word writes `Überschrift1` for
// what English Word calls `Heading1` -- so only the style's own `w:name`
// (English, lowercased, spaces collapsed) or an explicit `w:outlineLvl`
// says what a paragraph is. `docx.rs`'s own `Heading1..5` resolve the same
// way, which is what makes the round trip in decision 10 work at all.
//
// THE BOOK'S NAME, AND WHY IT IS NOT JUST "THE FIRST HEADING'S LEVEL MINUS
// ONE". `docx.rs` always writes a `Title`-styled paragraph, so this
// module's own exports resolve unambiguously. A FOREIGN file need not carry
// one: pandoc writes a Markdown `#` title as a plain `Heading1` paragraph
// (no `Title` style exists in a pandoc-generated `styles.xml` at all), so
// treating `heading N` as depth `N-1` unconditionally would make that title
// a PART and shift every real heading down one level. The rule, amended
// into the plan after reading a real pandoc file: a `Title`-styled
// paragraph wins outright; failing that, when the FIRST heading in the
// document is a `heading 1` and it is the ONLY `heading 1` in the whole
// file, that heading names the book and every OTHER heading's level is
// reduced by one before the depth rule runs; failing that, the name is the
// caller's `stem` and levels are taken as they are. This is `import.rs`'s
// own "does the file name itself" question, answered for a format that can
// also just SAY so through a style.
//
// `other_styles` was deliberately omitted from the loss kinds. It was in the
// plan's first draft and was cut after reading a real pandoc file: pandoc
// styles every prose paragraph `BodyText`, `FirstParagraph` or `Compact`,
// so counting non-heading styles would report roughly eighty "losses" on a
// perfectly ordinary manuscript. A paragraph that is not a heading is prose
// whatever its style is called; the style name is not a loss, because
// nothing about the writer's words depended on it.
use crate::import;
use serde_json::json;
use std::collections::HashMap;

/// What this build could not carry from a DOCX, by kind, every field a
/// `u64` so a huge foreign file cannot overflow it into a wrapped count that
/// reads as small. Reaches the writer through `main::ImportOutcome`.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Losses {
    /// `w:tbl`: the subtree is skipped whole and counted ONCE per table,
    /// however many rows or nested tables it holds. Its text is LOST rather
    /// than flattened into prose -- a table read as a run of paragraphs
    /// would invent a manuscript nobody wrote.
    pub tables: u64,
    /// `w:drawing` / `w:pict`.
    pub pictures: u64,
    /// `w:footnoteReference` / `w:endnoteReference`: the reference mark is
    /// dropped; the note's own text lives in a part this build does not
    /// read.
    pub notes: u64,
    /// `w:commentRangeStart`: the anchor is dropped. Word comments becoming
    /// this application's comments is its own slice.
    pub comments: u64,
    /// `w:hyperlink`: the text is KEPT (it is a transparent wrapper around
    /// ordinary runs); the target is lost.
    pub links: u64,
    /// `w:fldSimple` / `w:instrText`: the cached result text is kept, the
    /// field itself is lost.
    pub fields: u64,
    /// `w:numPr`: a list paragraph. The text is kept as an ordinary
    /// paragraph; the numbering is lost.
    pub lists: u64,
    /// Tracked edit wrappers and property changes in `word/document.xml`.
    /// Imported prose reflects the current text, without review history.
    pub revisions: u64,
}

/// What `parse` answers: the same shape `import::parse` produces, plus the
/// loss report DOCX alone can carry. Both parsers report derived contents.
#[derive(Debug, PartialEq, Eq)]
pub struct DocxImported {
    pub imported: import::Imported,
    pub losses: Losses,
}

// -------------------------------------------------------------- the walker

/// One node of the tree the walker builds: an element (its LOCAL name, its
/// attributes by local name, its children) or a run of decoded text.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Element {
        name: String,
        attrs: Vec<(String, String)>,
        children: Vec<Node>,
    },
    Text(String),
}

/// The local name of a possibly-prefixed tag or attribute: everything after
/// the first colon, or the whole string when there is none. Matching by
/// local name is what lets a writer's file prefix `w:` differently, or not
/// at all, and still be read.
fn local_name(name: &str) -> &str {
    match name.find(':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

/// No named or numeric entity this function recognises is anywhere near
/// this long, and capping the `;` search here keeps a run of ampersands
/// with no terminator (`&&&&&&...`) linear rather than quadratic: without
/// it, every `&` re-scans the rest of the string looking for a `;` that
/// never comes.
const MAX_ENTITY_LOOKAHEAD: usize = 12;

/// The five predefined XML entities and a numeric character reference
/// (`&#123;` or `&#x7B;`), decoded. An entity this function does not
/// recognise is left as the literal `&...;` text it was written as, which
/// is the safe fallback for a byte stream this build does not fully own.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let window_end = (i + MAX_ENTITY_LOOKAHEAD).min(bytes.len());
            if let Some(rel_semi) = s[i..window_end].find(';') {
                let entity = &s[i + 1..i + rel_semi];
                let replaced = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ if entity.starts_with('#') => {
                        let digits = &entity[1..];
                        if let Some(hex) = digits.strip_prefix('x').or_else(|| digits.strip_prefix('X')) {
                            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                        } else {
                            digits.parse::<u32>().ok().and_then(char::from_u32)
                        }
                    }
                    _ => None,
                };
                if let Some(c) = replaced {
                    out.push(c);
                    i += rel_semi + 1;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// One tag's attributes, `name="value"` pairs with local names and decoded
/// values. Malformed pairs (a name with no `=`) are skipped rather than
/// aborting the whole parse -- a foreign file's oddity in one attribute must
/// not take the rest of the document out with it.
fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let name_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = local_name(&s[name_start..i]).to_string();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let quote = bytes[i];
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        i += 1;
        let val_start = i;
        while i < bytes.len() && bytes[i] != quote {
            i += 1;
        }
        let val = decode_entities(&s[val_start..i.min(bytes.len())]);
        i = (i + 1).min(bytes.len());
        if !name.is_empty() {
            out.push((name, val));
        }
    }
    out
}

/// Deeper than any real DOCX ever nests (Word's own deepest structural
/// nesting -- tables inside table cells inside a body -- runs to a handful
/// of levels). A hostile file that nests past this is refused with an Err
/// naming the depth rather than recursing the rest of this module's walkers
/// (`collect_styles`, `walk_body`, `walk_para_content`) into a stack
/// overflow.
const MAX_XML_DEPTH: usize = 256;

/// The whole tree under the (implicit) document root: a stack-based build
/// over a flat scan of `<tag>`, `</tag>` and text between them. The XML
/// declaration and comments are skipped outright; a CDATA section's text is
/// read out and kept.
fn build_tree(xml: &str) -> Result<Vec<Node>, String> {
    let mut root: Vec<Node> = Vec::new();
    let mut stack: Vec<(String, Vec<(String, String)>, Vec<Node>)> = Vec::new();
    let mut i = 0usize;
    let bytes = xml.as_bytes();

    let push_node = |stack: &mut Vec<(String, Vec<(String, String)>, Vec<Node>)>,
                      root: &mut Vec<Node>,
                      node: Node| {
        match stack.last_mut() {
            Some((_, _, children)) => children.push(node),
            None => root.push(node),
        }
    };

    while i < bytes.len() {
        if bytes[i] == b'<' {
            if xml[i..].starts_with("<!--") {
                i = xml[i..].find("-->").map(|e| i + e + 3).unwrap_or(bytes.len());
                continue;
            }
            if xml[i..].starts_with("<?") {
                i = xml[i..].find("?>").map(|e| i + e + 2).unwrap_or(bytes.len());
                continue;
            }
            if let Some(rest) = xml[i..].strip_prefix("<![CDATA[") {
                let (text, advance) = match rest.find("]]>") {
                    Some(e) => (&rest[..e], "<![CDATA[".len() + e + "]]>".len()),
                    None => (rest, "<![CDATA[".len() + rest.len()),
                };
                if !text.is_empty() {
                    push_node(&mut stack, &mut root, Node::Text(text.to_string()));
                }
                i += advance;
                continue;
            }
            let Some(end) = xml[i..].find('>').map(|e| i + e) else {
                break;
            };
            let inner = &xml[i + 1..end];
            i = end + 1;
            if let Some(name) = inner.strip_prefix('/') {
                let closing = local_name(name.trim()).to_string();
                if let Some(pos) = stack.iter().rposition(|(n, _, _)| *n == closing) {
                    while stack.len() > pos + 1 {
                        // An unbalanced foreign file: close whatever is
                        // still open above the match so the tree stays
                        // well-formed rather than losing everything below
                        // the true close tag.
                        let (n, a, c) = stack.pop().unwrap();
                        push_node(&mut stack, &mut root, Node::Element { name: n, attrs: a, children: c });
                    }
                    let (n, a, c) = stack.pop().unwrap();
                    push_node(&mut stack, &mut root, Node::Element { name: n, attrs: a, children: c });
                }
                continue;
            }
            let self_close = inner.trim_end().ends_with('/');
            let body = if self_close {
                inner.trim_end().trim_end_matches('/')
            } else {
                inner
            };
            let body = body.trim_start();
            let (name_part, rest) = match body.find(|c: char| c.is_whitespace()) {
                Some(p) => (&body[..p], &body[p..]),
                None => (body, ""),
            };
            let name = local_name(name_part).to_string();
            let attrs = parse_attrs(rest);
            if self_close {
                push_node(&mut stack, &mut root, Node::Element { name, attrs, children: Vec::new() });
            } else {
                if stack.len() >= MAX_XML_DEPTH {
                    return Err(format!("XML nesting exceeds {MAX_XML_DEPTH} levels; refusing to parse further"));
                }
                stack.push((name, attrs, Vec::new()));
            }
        } else {
            let end = xml[i..].find('<').map(|p| i + p).unwrap_or(bytes.len());
            let text = decode_entities(&xml[i..end]);
            if !text.is_empty() {
                push_node(&mut stack, &mut root, Node::Text(text));
            }
            i = end;
        }
    }
    // Anything still open at end of input closes here, defensively, on the
    // same reasoning as the mismatched-close-tag branch above.
    while let Some((n, a, c)) = stack.pop() {
        push_node(&mut stack, &mut root, Node::Element { name: n, attrs: a, children: c });
    }
    Ok(root)
}

fn attr_val<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// `w:outlineLvl`'s own OOXML range is 0..=9, but 9 means "body text, no
/// outline level" (ECMA-376's own reserved value for it) rather than a
/// tenth heading depth -- so it must not resolve to a heading at all, on
/// either the style or the paragraph.
fn parse_outline_lvl(v: &str) -> Option<u32> {
    v.parse::<u32>().ok().filter(|n| (0..=8).contains(n))
}

/// `<w:b/>` (no `w:val` at all) is true. ST_OnOff spells false as `"0"`,
/// `"false"` or `"off"`, and true as `"1"`, `"true"` or `"on"` -- an
/// unrecognised value is read as true, on the same not-off default. The two
/// boolean run properties (`w:b`, `w:i`) share this reading.
fn bool_prop(attrs: &[(String, String)]) -> bool {
    match attr_val(attrs, "val") {
        None => true,
        Some(v) => !matches!(v, "0" | "false" | "off"),
    }
}

// ------------------------------------------------------------- styles.xml

/// One paragraph style: its human name (for the `heading N` / `title`
/// match) and its own `w:outlineLvl`, when the style carries one rather
/// than every paragraph using it repeating it.
#[derive(Debug, Default, Clone)]
struct StyleInfo {
    name: String,
    outline_lvl: Option<u32>,
}

type StyleMap = HashMap<String, StyleInfo>;

fn parse_styles(xml: &str) -> Result<StyleMap, String> {
    let mut out = StyleMap::new();
    collect_styles(&build_tree(xml)?, &mut out);
    Ok(out)
}

fn collect_styles(nodes: &[Node], out: &mut StyleMap) {
    for node in nodes {
        let Node::Element { name, attrs, children } = node else {
            continue;
        };
        if name == "style" {
            if let Some(id) = attr_val(attrs, "styleId") {
                let mut info = StyleInfo::default();
                for child in children {
                    let Node::Element { name: n2, attrs: a2, children: c2 } = child else {
                        continue;
                    };
                    match n2.as_str() {
                        "name" => {
                            if let Some(v) = attr_val(a2, "val") {
                                info.name = v.to_string();
                            }
                        }
                        "pPr" => {
                            for pc in c2 {
                                if let Node::Element { name: n3, attrs: a3, .. } = pc {
                                    if n3 == "outlineLvl" {
                                        info.outline_lvl = attr_val(a3, "val").and_then(parse_outline_lvl);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                out.insert(id.to_string(), info);
            }
        }
        collect_styles(children, out);
    }
}

/// A style's `w:name`, lowercased and with runs of whitespace collapsed to
/// one space -- so `"Heading  1"` and `"heading 1"` resolve identically,
/// which is the form both Word's own English styles and pandoc's use.
fn normalize_style_name(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn heading_n_from_name(name: &str) -> Option<usize> {
    let rest = name.strip_prefix("heading ")?;
    rest.parse::<usize>().ok().filter(|n| (1..=9).contains(n))
}

/// What a paragraph's own style, plus its own `w:outlineLvl`, resolve to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeadingKind {
    Title,
    Level(usize),
}

/// Decision 3's resolution order: the style's NAME first (`title` or
/// `heading N`), the style's own `outlineLvl` next, the paragraph's own
/// `outlineLvl` last. The id itself never decides -- it is what Word
/// localizes.
fn resolve_heading(style_id: Option<&str>, own_outline: Option<u32>, styles: &StyleMap) -> Option<HeadingKind> {
    if let Some(id) = style_id {
        if let Some(info) = styles.get(id) {
            let name = normalize_style_name(&info.name);
            if name == "title" {
                return Some(HeadingKind::Title);
            }
            if let Some(n) = heading_n_from_name(&name) {
                return Some(HeadingKind::Level(n));
            }
            if let Some(lvl) = info.outline_lvl {
                return Some(HeadingKind::Level(lvl as usize + 1));
            }
        }
    }
    own_outline.map(|lvl| HeadingKind::Level(lvl as usize + 1))
}

// ------------------------------------------------------------- run content

/// One run of text carrying the marks in force where it was read, or a hard
/// break -- the same shape `import::Run` gives Markdown, plus underline,
/// which is DOCX's own third mark (decision 5).
#[derive(Debug, Clone, PartialEq, Eq)]
enum RunOut {
    Text { text: String, strong: bool, em: bool, underline: bool },
    Break,
}

/// A run's marks, from its own `w:rPr` (`w:b`, `w:i`, `w:u`), each read
/// independently: an `<w:rPr>` with no `w:b` at all leaves bold false,
/// exactly as a plain run's absent `<w:rPr>` does in `docx.rs`'s own
/// output.
fn run_marks(children: &[Node]) -> (bool, bool, bool) {
    let mut strong = false;
    let mut em = false;
    let mut underline = false;
    for c in children {
        let Node::Element { name, children: rpr, .. } = c else {
            continue;
        };
        if name != "rPr" {
            continue;
        }
        for rc in rpr {
            if let Node::Element { name: n2, attrs, .. } = rc {
                match n2.as_str() {
                    "b" => strong = bool_prop(attrs),
                    "i" => em = bool_prop(attrs),
                    "u" => underline = attr_val(attrs, "val").map(|v| v != "none").unwrap_or(true),
                    _ => {}
                }
            }
        }
    }
    (strong, em, underline)
}

fn text_of(node: &Node) -> Option<&str> {
    match node {
        Node::Text(t) => Some(t.as_str()),
        _ => None,
    }
}

/// A whole paragraph's content, walked once: runs (their marks and their
/// `w:t`/`w:br`/`w:tab`), transparent wrappers (`w:hyperlink`,
/// `w:fldSimple`, `w:ins`, and anything this walker does not name, on
/// decision 2's rule), and the LOSS elements, counted where they are
/// actually met -- `w:drawing`/`w:pict`/`w:footnoteReference`/
/// `w:endnoteReference`/`w:instrText` inside a run, `w:hyperlink`/
/// `w:fldSimple`/`w:commentRangeStart` beside one. `w:pPr` is skipped
/// outright: it is metadata the caller has already read, never content.
/// `w:del` is skipped WHOLE, not walked through: it is text Word tracked as
/// deleted, and a rejected edit coming back on import would hand the writer
/// words they struck out. `mc:AlternateContent`'s `mc:Fallback` child is
/// skipped the same way its `mc:Choice` sibling already carries the real
/// content (a drawing, most often) that the fallback restates for an older
/// reader -- walking both would count one picture, hyperlink or field
/// twice for the one thing Word actually put on the page.
fn walk_para_content(nodes: &[Node], out: &mut Vec<RunOut>, losses: &mut Losses) {
    for node in nodes {
        let Node::Element { name, children, .. } = node else {
            continue;
        };
        match name.as_str() {
            "pPr" => {}
            "r" => {
                let (strong, em, underline) = run_marks(children);
                for c in children {
                    let Node::Element { name: n2, children: cc, .. } = c else {
                        continue;
                    };
                    match n2.as_str() {
                        "rPr" => {}
                        "t" => {
                            let text: String = cc.iter().filter_map(text_of).collect();
                            if !text.is_empty() {
                                out.push(RunOut::Text { text, strong, em, underline });
                            }
                        }
                        "br" => out.push(RunOut::Break),
                        "tab" => out.push(RunOut::Text {
                            text: " ".to_string(),
                            strong,
                            em,
                            underline,
                        }),
                        "drawing" | "pict" => losses.pictures += 1,
                        "footnoteReference" | "endnoteReference" => losses.notes += 1,
                        "instrText" => losses.fields += 1,
                        _ => {}
                    }
                }
            }
            "hyperlink" => {
                losses.links += 1;
                walk_para_content(children, out, losses);
            }
            "fldSimple" => {
                losses.fields += 1;
                walk_para_content(children, out, losses);
            }
            "ins" => walk_para_content(children, out, losses),
            "del" => {}
            "Fallback" => {}
            "commentRangeStart" => losses.comments += 1,
            _ => walk_para_content(children, out, losses),
        }
    }
}

/// Adjacent runs with identical marks, merged into one text node -- Word
/// splits runs at every spell-check boundary, and the mirror's
/// byte-comparable bodies (decision 10) want one node per styled span.
/// `RunOut::Break` never merges with anything either side of it.
fn merge_runs(runs: Vec<RunOut>) -> Vec<RunOut> {
    let mut out: Vec<RunOut> = Vec::new();
    for r in runs {
        if let RunOut::Text { text, strong, em, underline } = &r {
            if let Some(RunOut::Text {
                text: pt,
                strong: ps,
                em: pe,
                underline: pu,
            }) = out.last_mut()
            {
                if *ps == *strong && *pe == *em && *pu == *underline {
                    pt.push_str(text);
                    continue;
                }
            }
        }
        out.push(r);
    }
    out
}

/// A run list as one ProseMirror paragraph node, in the FIXED mark order
/// `strong`, `em`, `underline` (decision 5), or None when it carries no
/// real content -- whitespace-only text and no break -- the same emptiness
/// rule `docx.rs::block_docx` states for the write direction.
fn build_pm_paragraph(merged: &[RunOut]) -> Option<serde_json::Value> {
    let mut content = Vec::new();
    let mut has_content = false;
    for r in merged {
        match r {
            RunOut::Text { text, strong, em, underline } => {
                if text.is_empty() {
                    continue;
                }
                if !text.trim().is_empty() {
                    has_content = true;
                }
                let mut marks = Vec::new();
                if *strong {
                    marks.push(json!({"type": "strong"}));
                }
                if *em {
                    marks.push(json!({"type": "em"}));
                }
                if *underline {
                    marks.push(json!({"type": "underline"}));
                }
                let mut node = json!({"type": "text", "text": text});
                if !marks.is_empty() {
                    node["marks"] = json!(marks);
                }
                content.push(node);
            }
            RunOut::Break => {
                has_content = true;
                content.push(json!({"type": "hard_break"}));
            }
        }
    }
    (has_content && !content.is_empty()).then(|| json!({"type": "paragraph", "content": content}))
}

/// Plain concatenated text of a run list, marks and breaks both dropped to
/// a single space -- a heading's title, which the store holds as a bare
/// string exactly as `import::title_text` reads one back for Markdown.
fn plain_text(runs: &[RunOut]) -> String {
    let mut out = String::new();
    for r in runs {
        match r {
            RunOut::Text { text, .. } => out.push_str(text),
            RunOut::Break => out.push(' '),
        }
    }
    out
}

// -------------------------------------------------------------- paragraphs

/// One `w:p`, classified: its heading kind if it has one, its own text (for
/// a heading) or its ProseMirror paragraph node (for prose).
struct ParaClass {
    kind: Option<HeadingKind>,
    heading_text: Option<String>,
    prose: Option<serde_json::Value>,
    /// `w:numPr` was on the paragraph, and its text: what
    /// `drop_generated_contents` needs to recognise a table of contents this
    /// application (or pandoc, from this application's Markdown) generated.
    list_text: Option<String>,
}

fn parse_p(children: &[Node], styles: &StyleMap, losses: &mut Losses) -> ParaClass {
    let mut style_id: Option<String> = None;
    let mut own_outline: Option<u32> = None;
    let mut is_list = false;
    for c in children {
        let Node::Element { name, children: pc, .. } = c else {
            continue;
        };
        if name != "pPr" {
            continue;
        }
        for p in pc {
            if let Node::Element { name: n2, attrs, .. } = p {
                match n2.as_str() {
                    "pStyle" => style_id = attr_val(attrs, "val").map(str::to_string),
                    "outlineLvl" => own_outline = attr_val(attrs, "val").and_then(parse_outline_lvl),
                    "numPr" => is_list = true,
                    _ => {}
                }
            }
        }
    }
    if is_list {
        losses.lists += 1;
    }
    let kind = resolve_heading(style_id.as_deref(), own_outline, styles);
    let mut runs = Vec::new();
    walk_para_content(children, &mut runs, losses);
    let merged = merge_runs(runs);
    match kind {
        Some(_) => ParaClass {
            kind,
            // Trimmed exactly as `import::title_text` reads a Markdown
            // heading back: a run of leading/trailing spaces a writer left
            // around a heading's text is not part of the title.
            heading_text: Some(plain_text(&merged).trim().to_string()),
            prose: None,
            list_text: None,
        },
        None => ParaClass {
            kind: None,
            heading_text: None,
            prose: build_pm_paragraph(&merged),
            list_text: is_list.then(|| plain_text(&merged)),
        },
    }
}

/// The document body's paragraphs, in order. `w:tbl` at body level is
/// skipped WHOLE and counted once (decision 6); every other wrapper --
/// `w:body` itself, `w:sdt`, `w:sectPr`'s siblings -- is walked through, on
/// decision 2's rule.
fn walk_body(nodes: &[Node], styles: &StyleMap, losses: &mut Losses, out: &mut Vec<ParaClass>) {
    for node in nodes {
        let Node::Element { name, children, .. } = node else {
            continue;
        };
        match name.as_str() {
            "p" => out.push(parse_p(children, styles, losses)),
            "tbl" => losses.tables += 1,
            "sectPr" => {}
            _ => walk_body(children, styles, losses, out),
        }
    }
}

/// Count review markup independently of the prose walk. That walk skips
/// deleted text and tables, but their revision markers still need disclosure.
/// AlternateContent fallback repeats its choice and must not count twice.
fn count_revisions(nodes: &[Node]) -> u64 {
    nodes.iter().map(|node| match node {
        Node::Element { name, .. } if name == "Fallback" => 0,
        Node::Element { name, children, .. } => {
            let here = matches!(name.as_str(),
                "ins" | "del" | "moveFrom" | "moveTo" |
                "pPrChange" | "rPrChange" | "sectPrChange" |
                "tblPrChange" | "tblPrExChange" | "trPrChange" |
                "tcPrChange" | "tblGridChange" | "numberingChange" |
                "cellIns" | "cellDel" | "cellMerge" |
                "customXmlIns" | "customXmlDel" |
                "customXmlMoveFrom" | "customXmlMoveTo") as u64;
            here.saturating_add(count_revisions(children))
        }
        Node::Text(_) => 0,
    }).fold(0u64, u64::saturating_add)
}

// ---------------------------------------------------------------- sections

/// Paragraphs grouped the way `import.rs::sections` groups Markdown lines:
/// one section per heading (or the preamble, `kind: None`, always first),
/// carrying every prose paragraph that followed it up to the next heading.
struct DocxSection {
    kind: Option<HeadingKind>,
    heading_text: Option<String>,
    paragraphs: Vec<serde_json::Value>,
    /// The texts of the section's list paragraphs, when EVERY prose
    /// paragraph in it is one. None as soon as one ordinary paragraph is in
    /// the section -- a contents section holds a list and nothing else.
    list_entries: Option<Vec<String>>,
}

fn group_sections(paras: Vec<ParaClass>) -> Vec<DocxSection> {
    let mut out = vec![DocxSection {
        kind: None,
        heading_text: None,
        paragraphs: Vec::new(),
        list_entries: Some(Vec::new()),
    }];
    for p in paras {
        match p.kind {
            Some(kind) => out.push(DocxSection {
                kind: Some(kind),
                heading_text: p.heading_text,
                paragraphs: Vec::new(),
                list_entries: Some(Vec::new()),
            }),
            None => {
                let last = out.last_mut().expect("sections starts with the preamble");
                if let Some(node) = p.prose {
                    last.paragraphs.push(node);
                    match (&mut last.list_entries, p.list_text) {
                        (Some(entries), Some(text)) => entries.push(text),
                        (entries, _) => *entries = None,
                    }
                }
            }
        }
    }
    out
}

/// Drop the table of contents this application GENERATES, so that the DOCX
/// trip stays stable the way `import::drop_generated_contents` keeps the
/// Markdown one stable -- and so a pandoc DOCX made from this application's
/// Markdown (which turns the generated bullet list into `w:numPr` paragraphs
/// under a "Contents" heading) does not come back with a chapter nobody
/// wrote and forty list losses. The rule is the Markdown one restated,
/// self-verifying: a heading section whose paragraphs are ALL list
/// paragraphs, whose entries are in order and in full the titles of every
/// heading after it, with at most one heading before it (the file's title).
/// The list paragraphs it drops were counted as list losses; they are not
/// losses, so the count is given back.
fn drop_generated_contents(sections: &mut Vec<DocxSection>, losses: &mut Losses) -> Option<String> {
    let Some(at) = sections.iter().enumerate().position(|(i, s)| {
        i > 0 && s.kind.is_some() && s.list_entries.as_ref().is_some_and(|e| !e.is_empty())
    }) else {
        return None;
    };
    if sections[1..at].len() > 1 {
        return None;
    }
    let following: Vec<&str> = sections[at + 1..]
        .iter()
        .filter_map(|s| s.heading_text.as_deref())
        .collect();
    let entries = sections[at].list_entries.as_deref().unwrap_or(&[]);
    if entries.len() != following.len() || entries.iter().zip(&following).any(|(e, f)| e != f) {
        return None;
    }
    losses.lists = losses.lists.saturating_sub(entries.len() as u64);
    sections.remove(at).heading_text
}

fn body_of(paragraphs: &[serde_json::Value]) -> Option<String> {
    if paragraphs.is_empty() {
        return None;
    }
    serde_json::to_string(&json!({"type": "doc", "content": paragraphs})).ok()
}

/// Whether, and how, the document names itself -- decision 3, amended.
enum Naming {
    /// A `Title`-styled paragraph won outright; its own text.
    Title,
    /// No `Title`, but the first heading is the file's only `heading 1`;
    /// the section index that heading sits at in `sections`.
    Promoted(usize),
    /// Neither: the name is the caller's `stem`, and levels are taken as
    /// they are.
    None,
}

fn determine_naming(sections: &[DocxSection]) -> Naming {
    if sections.iter().any(|s| s.kind == Some(HeadingKind::Title)) {
        return Naming::Title;
    }
    let headings: Vec<(usize, usize)> = sections
        .iter()
        .enumerate()
        .filter_map(|(i, s)| match s.kind {
            Some(HeadingKind::Level(n)) => Some((i, n)),
            _ => None,
        })
        .collect();
    // Mirrors `import.rs`'s own `preamble_blank`: the promotion names the
    // WHOLE book after its first heading, which is only right when nothing
    // came before that heading. Prose ahead of it is the writer's own
    // opening, not overflow from a title the format happens to omit.
    let preamble_blank = sections[0].paragraphs.is_empty();
    if let Some(&(first_i, first_n)) = headings.first() {
        let level1s = headings.iter().filter(|&&(_, n)| n == 1).count();
        if preamble_blank && first_n == 1 && level1s == 1 {
            return Naming::Promoted(first_i);
        }
    }
    Naming::None
}

/// The structural pass: `sections[0]` is always the preamble (prose before
/// any heading, `import.rs`'s own rule, mirrored exactly); every section
/// after it is a heading, closed back to its nearest strictly shallower
/// open ancestor -- the same stack `import.rs::parse` keeps, fed the DEPTH
/// this format computes directly (decision 4) rather than a relative
/// nesting level, since DOCX headings name their own absolute level.
fn build_items(sections: Vec<DocxSection>, stem: &str) -> (String, Vec<import::ImportedItem>) {
    let naming = determine_naming(&sections);
    let named = !matches!(naming, Naming::None);
    let mut name: Option<String> = None;
    let mut items: Vec<import::ImportedItem> = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new();

    if let Some(body) = body_of(&sections[0].paragraphs) {
        items.push(import::ImportedItem {
            parent: None,
            item_type: "scene",
            title: if named { String::new() } else { stem.to_string() },
            body: Some(body),
        });
    }

    for (i, s) in sections.into_iter().enumerate().skip(1) {
        match s.kind {
            Some(HeadingKind::Title) => {
                // Mirrors `import.rs`'s own names-itself branch (its own
                // heading that names the book still gets its prose back as
                // a scene): a `Title`-styled paragraph's OWN section can
                // carry prose too -- the writer's opening lines before the
                // first real heading, or a second `Title` paragraph's own
                // words -- and losing it would silently drop text that was
                // never inside any chapter to begin with.
                let title_text = s.heading_text.unwrap_or_default();
                if name.is_none() {
                    name = Some(title_text.clone());
                }
                if let Some(body) = body_of(&s.paragraphs) {
                    items.push(import::ImportedItem {
                        parent: None,
                        item_type: "scene",
                        title: title_text,
                        body: Some(body),
                    });
                }
            }
            Some(HeadingKind::Level(n)) => {
                if matches!(naming, Naming::Promoted(pi) if pi == i) {
                    name = Some(s.heading_text.unwrap_or_default().clone());
                    if let Some(body) = body_of(&s.paragraphs) {
                        items.push(import::ImportedItem {
                            parent: None,
                            item_type: "scene",
                            title: name.clone().unwrap_or_default(),
                            body: Some(body),
                        });
                    }
                    continue;
                }
                let level = if matches!(naming, Naming::Promoted(_)) {
                    n.saturating_sub(1).max(1)
                } else {
                    n
                };
                let depth = level.saturating_sub(1).min(4);
                while stack.last().is_some_and(|&(open, _)| open >= depth) {
                    stack.pop();
                }
                let parent = stack.last().map(|&(_, at)| at);
                let body = body_of(&s.paragraphs);
                let has_prose = body.is_some();
                items.push(import::ImportedItem {
                    parent,
                    item_type: import::type_for(has_prose, depth),
                    title: s.heading_text.unwrap_or_default(),
                    body,
                });
                stack.push((depth, items.len() - 1));
            }
            None => unreachable!("only index 0 is the preamble"),
        }
    }

    (name.unwrap_or_else(|| stem.to_string()), items)
}

// -------------------------------------------------------------------- parse

/// Parse a DOCX package into a project, plus what it could not carry.
/// `stem` is the file's own name without its extension, used exactly as
/// `import::parse`'s is: when the document does not name itself.
pub fn parse(bytes: &[u8], stem: &str) -> Result<DocxImported, String> {
    let entries = crate::epub::read_zip(bytes)?;
    let document = entries
        .iter()
        .find(|(name, _)| name == "word/document.xml")
        .ok_or_else(|| "word/document.xml is missing from this package".to_string())?;
    let document_text = String::from_utf8_lossy(&document.1).into_owned();
    let styles = entries
        .iter()
        .find(|(name, _)| name == "word/styles.xml")
        .map(|(_, bytes)| parse_styles(&String::from_utf8_lossy(bytes)))
        .transpose()?
        .unwrap_or_default();

    let tree = build_tree(&document_text)?;
    let mut losses = Losses::default();
    losses.revisions = count_revisions(&tree);
    let mut paras: Vec<ParaClass> = Vec::new();
    walk_body(&tree, &styles, &mut losses, &mut paras);

    let mut sections = group_sections(paras);
    let derived_contents = drop_generated_contents(&mut sections, &mut losses);
    let (name, items) = build_items(sections, stem);

    Ok(DocxImported {
        imported: import::Imported { name, items, derived_contents },
        losses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;

    /// One-entry `[Content_Types].xml` and `_rels` are not needed to make a
    /// package `read_zip` accepts and this module reads: only the two named
    /// parts matter here.
    fn package(document_xml: &str, styles_xml: Option<&str>) -> Vec<u8> {
        let mut entries = vec![crate::epub::Entry::text("word/document.xml", document_xml)];
        if let Some(styles) = styles_xml {
            entries.push(crate::epub::Entry::text("word/styles.xml", styles));
        }
        crate::epub::zip(&entries)
    }

    const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    fn doc(body: &str) -> String {
        format!("<?xml version=\"1.0\"?><w:document xmlns:w=\"{W_NS}\"><w:body>{body}</w:body></w:document>")
    }

    #[test]
    fn tracked_edits_are_reported_without_changing_imported_final_text() {
        let bytes = package(&doc(r#"
            <w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Scene</w:t></w:r></w:p>
            <w:p><w:r><w:t>Before </w:t></w:r>
              <w:ins w:author="Editor"><w:r><w:t>new</w:t></w:r></w:ins>
              <w:del w:author="Editor"><w:r><w:delText>old</w:delText></w:r></w:del>
              <w:r><w:t> after</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:ins><w:r><w:t>table edit</w:t></w:r></w:ins></w:p></w:tc></w:tr></w:tbl>
            <mc:AlternateContent><mc:Choice><w:p><w:r><w:rPr><w:rPrChange/></w:rPr></w:r></w:p></mc:Choice>
              <mc:Fallback><w:p><w:r><w:rPr><w:rPrChange/></w:rPr></w:r></w:p></mc:Fallback></mc:AlternateContent>
        "#), None);
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.revisions, 4);
        let body = out.imported.items[0].body.as_deref().unwrap();
        assert!(body.contains("Before new after"), "{body}");
        assert!(!body.contains("old"), "{body}");
        assert!(!body.contains("table edit"), "{body}");
    }

    #[test]
    fn an_untracked_document_has_no_revision_loss() {
        let bytes = package(&doc("<w:p><w:r><w:t>Plain prose</w:t></w:r></w:p>"), None);
        assert_eq!(parse(&bytes, "stem").unwrap().losses.revisions, 0);
    }

    /// A `styles.xml` naming one style, with an optional `outlineLvl`.
    fn styles_xml(entries: &[(&str, &str, Option<u32>)]) -> String {
        let mut out = format!("<?xml version=\"1.0\"?><w:styles xmlns:w=\"{W_NS}\">");
        for (id, name, outline) in entries {
            out.push_str(&format!(
                "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/>"
            ));
            if let Some(lvl) = outline {
                out.push_str(&format!("<w:pPr><w:outlineLvl w:val=\"{lvl}\"/></w:pPr>"));
            }
            out.push_str("</w:style>");
        }
        out.push_str("</w:styles>");
        out
    }

    fn titles(imported: &import::Imported) -> Vec<(&str, Option<usize>, &str)> {
        imported.items.iter().map(|i| (i.title.as_str(), i.parent, i.item_type)).collect()
    }

    /// LOCALIZED STYLE IDS RESOLVE THROUGH THE NAME. `berschrift1` is
    /// German Word's own id for `Heading1`; only its `w:name` says what it
    /// is.
    #[test]
    fn a_localized_style_id_with_name_heading_1_resolves() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:pStyle w:val="Titel"/></w:pPr><w:r><w:t>Buch</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr><w:r><w:t>Eins</w:t></w:r></w:p>
                   <w:p><w:r><w:t>Prosa.</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Titel", "Title", None), ("berschrift1", "heading 1", None)])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.name, "Buch");
        assert_eq!(titles(&out.imported), vec![("Eins", None, "scene")]);
    }

    /// AN `outlineLvl` ALONE RESOLVES A HEADING, with no style name at all.
    #[test]
    fn outline_lvl_alone_resolves_a_heading() {
        let bytes = package(
            &doc(r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                    <w:p><w:r><w:t>text</w:t></w:r></w:p>"#),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(titles(&out.imported), vec![("A", None, "scene")]);
    }

    /// `w:b w:val="0"` IS NOT BOLD.
    #[test]
    fn w_b_val_0_is_not_bold() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>plain</w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        let node = &body["content"][0]["content"][0];
        assert_eq!(node["text"], "plain");
        assert!(node.get("marks").is_none(), "{node}");
    }

    /// `w:u w:val="none"` IS NOT UNDERLINE.
    #[test]
    fn w_u_val_none_is_not_underline() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:r><w:rPr><w:u w:val="none"/></w:rPr><w:t>plain</w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body["content"][0]["content"][0].get("marks").is_none());
    }

    /// ADJACENT RUNS WITH IDENTICAL MARKS MERGE into one text node.
    #[test]
    fn adjacent_identical_runs_merge() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>lou</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>d</w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        let content = body["content"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "{content:?}");
        assert_eq!(content[0]["text"], "loud");
    }

    /// A TABLE IS COUNTED AND ITS TEXT IS ABSENT -- not flattened into
    /// prose nobody wrote.
    #[test]
    fn a_table_is_counted_and_its_text_is_absent() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
                   <w:p><w:r><w:t>real prose</w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.tables, 1);
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(!body.to_string().contains("cell text"), "{body}");
        assert!(body.to_string().contains("real prose"));
    }

    /// A HYPERLINK KEEPS ITS TEXT AND COUNTS A LINK.
    #[test]
    fn a_hyperlink_keeps_its_text_and_counts_a_link() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:hyperlink r:id="rId1"><w:r><w:t>the site</w:t></w:r></w:hyperlink></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.links, 1);
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("the site"), "{body}");
    }

    /// A NUMBERED PARAGRAPH KEEPS ITS TEXT AND COUNTS A LIST.
    #[test]
    fn a_numbered_paragraph_keeps_text_and_counts_a_list() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
                   <w:r><w:t>first item</w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.lists, 1);
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("first item"), "{body}");
    }

    /// THE GENERATED CONTENTS IS DROPPED, as `import.rs` drops it from
    /// Markdown: pandoc turns this application's own "## Contents" bullet
    /// list into `w:numPr` paragraphs under a heading, and without this rule
    /// the pandoc round trip came back with 41 items for 40 and forty list
    /// losses. Self-verifying: the entries must be, in order and in full,
    /// the headings that follow.
    #[test]
    fn a_generated_contents_section_is_dropped_and_its_lists_are_not_losses() {
        let list = |t: &str| {
            format!(
                r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>{t}</w:t></w:r></w:p>"#
            )
        };
        let h = |lvl: u32, t: &str| {
            format!(r#"<w:p><w:pPr><w:outlineLvl w:val="{lvl}"/></w:pPr><w:r><w:t>{t}</w:t></w:r></w:p>"#)
        };
        let body = format!(
            "{}{}{}{}{}{}{}",
            h(0, "The Book"),
            h(1, "Contents"),
            list("One"),
            list("Two"),
            h(1, "One"),
            "<w:p><w:r><w:t>prose</w:t></w:r></w:p>",
            h(1, "Two"),
        );
        let out = parse(&package(&doc(&body), None), "stem").unwrap();
        let titles: Vec<&str> = out.imported.items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(out.imported.name, "The Book");
        assert_eq!(out.imported.derived_contents.as_deref(), Some("Contents"));
        assert_eq!(titles, vec!["One", "Two"]);
        assert_eq!(out.losses.lists, 0);
    }

    /// The same shape with one entry that names no heading is a real list a
    /// writer typed: kept, and counted as the list losses it is.
    #[test]
    fn a_list_that_is_not_the_contents_is_kept_and_counted() {
        let list = |t: &str| {
            format!(
                r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>{t}</w:t></w:r></w:p>"#
            )
        };
        let h = |lvl: u32, t: &str| {
            format!(r#"<w:p><w:pPr><w:outlineLvl w:val="{lvl}"/></w:pPr><w:r><w:t>{t}</w:t></w:r></w:p>"#)
        };
        let body = format!("{}{}{}{}{}", h(0, "The Book"), h(1, "Notes"), list("One"), list("Elsewhere"), h(1, "One"));
        let out = parse(&package(&doc(&body), None), "stem").unwrap();
        let titles: Vec<&str> = out.imported.items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, vec!["Notes", "One"]);
        assert_eq!(out.imported.derived_contents, None);
        assert_eq!(out.losses.lists, 2);
    }

    /// A PICTURE, A NOTE REFERENCE AND A COMMENT ANCHOR ARE EACH COUNTED
    /// ONCE, and none of them takes the paragraph's real prose with it.
    #[test]
    fn a_picture_a_note_and_a_comment_are_each_counted() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:commentRangeStart w:id="1"/><w:r><w:t>prose</w:t></w:r>
                   <w:r><w:drawing/></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.pictures, 1);
        assert_eq!(out.losses.notes, 1);
        assert_eq!(out.losses.comments, 1);
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("prose"), "{body}");
    }

    /// A `w:fldSimple` FIELD KEEPS ITS CACHED RESULT TEXT AND IS COUNTED.
    #[test]
    fn a_field_keeps_its_result_and_is_counted() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>3</w:t></w:r></w:fldSimple></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.fields, 1);
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains('3'), "{body}");
    }

    /// A MISSING `word/document.xml` IS AN ERR NAMING IT.
    #[test]
    fn a_missing_document_xml_is_an_err_naming_it() {
        let bytes = crate::epub::zip(&[crate::epub::Entry::text("word/styles.xml", "<w:styles/>")]);
        let err = parse(&bytes, "stem").unwrap_err();
        assert!(err.contains("word/document.xml"), "{err}");
    }

    /// A NON-ZIP IS AN ERR.
    #[test]
    fn a_non_zip_is_an_err() {
        let err = parse(b"not a zip at all", "stem").unwrap_err();
        assert!(!err.is_empty());
    }

    /// THE FIVE ENTITIES AND A NUMERIC CHARACTER REFERENCE DECODE, on real
    /// text content read out of a `<w:t>`.
    #[test]
    fn entities_and_a_numeric_reference_decode() {
        let bytes = package(
            &doc(r#"<w:p><w:r><w:t>Tom &amp; Jerry &lt;shout&gt; &quot;go&quot; &apos;now&apos; &#x2014; end</w:t></w:r></w:p>"#),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        let text = body["content"][0]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "Tom & Jerry <shout> \"go\" 'now' \u{2014} end");
    }

    /// A `Title`-styled paragraph names the book outright, even when a
    /// `heading 1` also exists -- Title always wins.
    #[test]
    fn a_title_style_names_the_book_outright() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>My Novel</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
                   <w:p><w:r><w:t>prose</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Title", "Title", None), ("Heading1", "heading 1", None)])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.name, "My Novel");
        assert_eq!(titles(&out.imported), vec![("Chapter One", None, "scene")]);
    }

    /// NO `Title` STYLE AT ALL, and the document opens with a LONE
    /// `heading 1`, as a pandoc export of a Markdown `#` title does: it
    /// names the book and every OTHER heading's level is reduced by one.
    #[test]
    fn a_lone_leading_heading_1_names_the_book_and_shifts_the_rest() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Harbour Lights</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
                   <w:p><w:r><w:t>prose</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Heading1", "heading 1", None), ("Heading2", "heading 2", None)])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.name, "Harbour Lights");
        // heading 2 reduced to heading 1, so depth 0 -- a "part", since it
        // holds prose and therefore is a scene; asserted via type below.
        assert_eq!(titles(&out.imported), vec![("One", None, "scene")]);
    }

    /// TWO `heading 1` PARAGRAPHS: the promotion rule does not fire (the
    /// level-1 heading is not unique), so the name falls back to `stem` and
    /// both headings keep their own level.
    #[test]
    fn two_heading_1s_do_not_promote_either_and_the_name_is_the_stem() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
                   <w:p><w:r><w:t>a</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>
                   <w:p><w:r><w:t>b</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Heading1", "heading 1", None)])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.name, "stem");
        assert_eq!(
            titles(&out.imported),
            vec![("One", None, "scene"), ("Two", None, "scene")]
        );
    }

    /// DECISION 10'S ROUND TRIP: `docx::render` of a book, read back
    /// through `docx_import::parse`, equals `import::parse` of
    /// `export::manuscript` of the SAME book -- item for item -- for a
    /// fixture carrying a front item, parts, chapters, scenes with all
    /// three marks, a hard break, an empty chapter, and a title with `&`,
    /// `<` and `*`. Underline SURVIVES the DOCX trip where the SAME
    /// fixture through Markdown loses it -- the two formats must differ
    /// exactly where they must. `losses` is all zero for the crate's own
    /// export.
    #[test]
    fn the_docx_round_trip_matches_the_markdown_one_and_underline_survives_only_there() {
        let front = [("d".to_string(), "A & B < C".to_string(), 0i64)];
        let chapters = [
            ("p1".to_string(), "Part One".to_string(), 0i64),
            ("c1".to_string(), "Chapter One".to_string(), 1i64),
            ("s1".to_string(), "Opening".to_string(), 2i64),
            ("c2".to_string(), "Empty Chapter".to_string(), 1i64),
        ];
        let back: [(String, String, i64); 0] = [];

        let mut bodies: StdHashMap<String, String> = StdHashMap::new();
        bodies.insert(
            "s1".to_string(),
            json!({"type":"doc","content":[
                {"type":"paragraph","content":[
                    {"type":"text","text":"plain "},
                    {"type":"text","text":"loud","marks":[{"type":"strong"}]},
                    {"type":"text","text":" line one"},
                    {"type":"hard_break"},
                    {"type":"text","text":"line two "},
                    {"type":"text","text":"soft and under","marks":[{"type":"em"},{"type":"underline"}]},
                ]}
            ]})
            .to_string(),
        );

        let book = crate::export::Book {
            name: "A & B < C *",
            contents_title: "Contents",
            front: &front,
            chapters: &chapters,
            back: &back,
        };
        let docx = crate::docx::render(&book, &bodies, "en");
        let via_docx = parse(&docx.bytes, "stem").unwrap();
        assert_eq!(via_docx.losses, Losses::default());

        let markdown = crate::export::manuscript(&book, &bodies);
        let via_markdown = import::parse(markdown.text(), "stem");

        assert_eq!(via_docx.imported.name, via_markdown.name);
        assert_eq!(via_docx.imported.items.len(), via_markdown.items.len());
        for (a, b) in via_docx.imported.items.iter().zip(via_markdown.items.iter()) {
            assert_eq!(a.parent, b.parent, "{a:?} vs {b:?}");
            assert_eq!(a.item_type, b.item_type, "{a:?} vs {b:?}");
            assert_eq!(a.title, b.title, "{a:?} vs {b:?}");
        }

        // The scene's own body: underline survived the DOCX trip and did
        // not survive the Markdown one, for the SAME source body.
        let docx_body = via_docx.imported.items.iter().find(|i| i.title == "Opening").unwrap();
        let md_body = via_markdown.items.iter().find(|i| i.title == "Opening").unwrap();
        let docx_json: serde_json::Value = serde_json::from_str(docx_body.body.as_deref().unwrap()).unwrap();
        let md_json: serde_json::Value = serde_json::from_str(md_body.body.as_deref().unwrap()).unwrap();
        assert!(
            docx_json.to_string().contains("underline"),
            "{docx_json}"
        );
        assert!(
            !md_json.to_string().contains("underline"),
            "{md_json}"
        );
        assert!(docx_json.to_string().contains("hard_break"), "{docx_json}");
    }

    /// A `Title`-STYLED SECTION'S OWN PARAGRAPHS ARE EMITTED, not silently
    /// dropped: prose that sits between the `Title` paragraph and the
    /// document's first real heading is the writer's own opening lines and
    /// was never inside any chapter to begin with.
    #[test]
    fn a_title_sections_own_prose_becomes_a_root_scene() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>My Novel</w:t></w:r></w:p>
                   <w:p><w:r><w:t>opening line</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
                   <w:p><w:r><w:t>chapter prose</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Title", "Title", None), ("Heading1", "heading 1", None)])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.name, "My Novel");
        assert_eq!(out.imported.items.len(), 2, "{:?}", out.imported.items);
        let first = &out.imported.items[0];
        assert_eq!(first.item_type, "scene");
        assert!(first.body.as_deref().unwrap_or("").contains("opening line"), "{first:?}");
        assert_eq!(out.imported.items[1].title, "One");
    }

    /// `<w:b w:val="off"/>` IS NOT BOLD -- ST_OnOff's other false spelling.
    #[test]
    fn w_b_val_off_is_not_bold() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:r><w:rPr><w:b w:val="off"/></w:rPr><w:t>plain</w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body["content"][0]["content"][0].get("marks").is_none());
    }

    /// `w:outlineLvl` OF 9 IS BODY TEXT, not a tenth heading depth -- OOXML
    /// reserves 9 to mean "no outline level" and this build must not
    /// resolve it into `HeadingKind::Level(10)`. Checked both on the
    /// paragraph's own `outlineLvl` and on the style's.
    #[test]
    fn outline_lvl_9_is_not_a_heading() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:pPr><w:outlineLvl w:val="9"/></w:pPr><w:r><w:t>not a heading</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="Body9"/></w:pPr><w:r><w:t>also not a heading</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Body9", "body text", Some(9))])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(titles(&out.imported), vec![("A", None, "scene")]);
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("not a heading"), "{body}");
        assert!(body.to_string().contains("also not a heading"), "{body}");
    }

    /// PROSE BEFORE A LONE LEADING `heading 1` BLOCKS THE PROMOTION: with a
    /// non-empty preamble the book keeps its `stem` name and the heading
    /// keeps its own level, exactly as `import.rs`'s `preamble_blank` blocks
    /// the same promotion for Markdown.
    #[test]
    fn prose_before_the_lone_heading_1_blocks_promotion() {
        let bytes = package(
            &doc(
                r#"<w:p><w:r><w:t>an opening line</w:t></w:r></w:p>
                   <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Harbour Lights</w:t></w:r></w:p>
                   <w:p><w:r><w:t>prose</w:t></w:r></w:p>"#,
            ),
            Some(&styles_xml(&[("Heading1", "heading 1", None)])),
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.name, "stem");
        assert_eq!(
            titles(&out.imported),
            vec![("stem", None, "scene"), ("Harbour Lights", None, "scene")]
        );
    }

    /// `w:del` IS SKIPPED WHOLE: text Word tracked as deleted does not come
    /// back on import.
    #[test]
    fn deleted_tracked_text_is_not_imported() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:r><w:t>kept </w:t></w:r><w:del w:id="1"><w:r><w:delText>struck out</w:delText></w:r></w:del></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("kept"), "{body}");
        assert!(!body.to_string().contains("struck out"), "{body}");
    }

    /// `w:ins` IS WALKED THROUGH: inserted tracked text is kept, exactly as
    /// an ordinary run would be.
    #[test]
    fn inserted_tracked_text_is_kept() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:ins w:id="1"><w:r><w:t>added text</w:t></w:r></w:ins></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("added text"), "{body}");
    }

    /// `mc:AlternateContent`'s `mc:Fallback` CHILD IS SKIPPED: a drawing in
    /// `mc:Choice` and its pre-2010-Word `mc:Fallback` restatement are the
    /// SAME picture, and without skipping the fallback subtree it is
    /// counted twice.
    #[test]
    fn alternate_content_fallback_is_not_double_counted() {
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><mc:AlternateContent xmlns:mc="x">
                       <mc:Choice Requires="wps"><w:r><w:drawing/></w:r></mc:Choice>
                       <mc:Fallback><w:r><w:pict/></w:r></mc:Fallback>
                   </mc:AlternateContent></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.losses.pictures, 1, "{:?}", out.losses);
    }

    /// XML NESTING PAST 256 LEVELS IS REFUSED, naming the depth, rather than
    /// recursing this module's walkers into a stack overflow on a hostile
    /// file.
    #[test]
    fn deeply_nested_xml_is_refused() {
        let mut body = String::new();
        for _ in 0..300 {
            body.push_str("<w:sdt><w:sdtContent>");
        }
        body.push_str("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
        for _ in 0..300 {
            body.push_str("</w:sdtContent></w:sdt>");
        }
        let bytes = package(&doc(&body), None);
        let err = parse(&bytes, "stem").unwrap_err();
        assert!(err.contains("256"), "{err}");
    }

    /// A HEADING'S TEXT IS TRIMMED, exactly as `import::title_text` reads a
    /// Markdown heading back: whitespace a writer left around the title is
    /// not part of it.
    #[test]
    fn a_headings_text_is_trimmed() {
        // Levels 2 and 3, not 1: a lone leading `heading 1` would promote
        // and take a different path through `build_items` that does not
        // exercise this assertion.
        let bytes = package(
            &doc(
                r#"<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>
                   <w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>  Padded  </w:t></w:r></w:p>"#,
            ),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        assert_eq!(out.imported.items[1].title, "Padded");
    }

    /// A CDATA SECTION'S TEXT IS READ, not lost by being consumed as a bogus
    /// tag name.
    #[test]
    fn cdata_text_is_read() {
        let bytes = package(
            &doc(r#"<w:p><w:r><w:t>before <![CDATA[cdata text]]> after</w:t></w:r></w:p>"#),
            None,
        );
        let out = parse(&bytes, "stem").unwrap();
        let body: serde_json::Value = serde_json::from_str(out.imported.items[0].body.as_deref().unwrap()).unwrap();
        assert!(body.to_string().contains("cdata text"), "{body}");
    }
}
