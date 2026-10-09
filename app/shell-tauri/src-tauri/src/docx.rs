// app/shell-tauri/src-tauri/src/docx.rs
// THE DOCX RENDER: an OOXML package (a zip) of one document part and one
// styles part, built here and nowhere else. Product spec section 5 ("strong
// DOCX editor handoff") and section 12 (round-trip with the editor's own
// tools). This is the EXPORT half; import is a later slice.
//
// PURE, exactly as `export.rs` and `epub.rs` are: no I/O, no `Store`, no
// `Path`. Bytes in, bytes out. Reuses `epub::zip`/`epub::Entry` rather than a
// second STORED-zip writer -- a DOCX is a zip exactly as an EPUB is, and the
// OOXML spec permits STORED entries the same way OCF does.
//
// UNDERLINE IS CARRIED, which is the whole point of this format against
// Markdown: Word has a real `<w:u>` and this renderer emits it, so
// `underlined_runs` is always 0 -- a measurement, not a default, the same as
// `epub::manuscript`'s.
//
// NO `docProps/` AT ALL. `core.xml` is where `dc:creator` and
// `cp:lastModifiedBy` would carry a real name or an OS user name into a file
// that travels (053's leak enumeration, 054's rule); a package without
// `docProps` is valid, and `identity::fields_for` answers DOCX with an empty
// table for the same reason `MARKDOWN_FIELDS` is empty -- there is nowhere in
// this file identity metadata goes.

use crate::epub::{xml_escape, zip, Entry};
use crate::export::{heading_level, Book, Format, Manuscript};
use std::collections::HashMap;

/// `word/document.xml`'s namespace, restated here rather than assumed by every
/// literal that opens a `<w:...>` element.
const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/// A run's text, wrapped in `<w:rPr>` for whichever of `strong`, `em` and
/// `underline` the node carries, in that order. STABLE ORDER, for
/// `export::wrap_marks`'s reason: marks are a SET on a text node, so
/// `["em","strong"]` and `["strong","em"]` are the same node and must produce
/// the same bytes. A plain run carries no `<w:rPr>` at all rather than an
/// empty one, which is what
/// `a_plain_run_has_no_rpr` below is for.
fn run_xml(text: &str, node: &serde_json::Value) -> String {
    let mut bold = false;
    let mut italic = false;
    let mut underline = false;
    if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
        for mark in marks {
            match mark.get("type").and_then(|t| t.as_str()) {
                Some("strong") => bold = true,
                Some("em") => italic = true,
                Some("underline") => underline = true,
                _ => {}
            }
        }
    }
    let mut rpr = String::new();
    if bold {
        rpr.push_str("<w:b/>");
    }
    if italic {
        rpr.push_str("<w:i/>");
    }
    if underline {
        rpr.push_str("<w:u w:val=\"single\"/>");
    }
    let rpr = if rpr.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{rpr}</w:rPr>")
    };
    // Newlines are the editor's manual breaks. Keep them inside this marked
    // run so Word receives the same leading, trailing and repeated breaks.
    let content = text.split('\n')
        .map(|part| format!("<w:t xml:space=\"preserve\">{}</w:t>", xml_escape(part)))
        .collect::<Vec<_>>()
        .join("<w:br/>");
    format!("<w:r>{rpr}{content}</w:r>")
}

/// One block's run sequence, and whether it carries any real content.
///
/// A NODE THIS BUILD DOES NOT RECOGNISE STILL EMITS ITS DESCENDANTS, on
/// `export::append_inline`'s principle: being strict deeper would take a
/// whole scene out of a writer's book for one node this build has not met.
/// `hard_break` is the one inline leaf handled by name -- ProseMirror's line
/// break inside a paragraph -- and it becomes `<w:br/>`, which is what an
/// exported Markdown body cannot do at all (the page's schema has no
/// `hard_break` today; this still answers for one, exactly as `import.rs`'s
/// header notes the schema's current shape without assuming it never grows).
///
/// `has_content` IS TRACKED SEPARATELY FROM THE XML, because every run this
/// function emits is already wrapped in `<w:r>...<w:t>` tags -- unlike
/// Markdown's bare text or the EPUB's untagged span, a docx run is never
/// "just the words", so checking the built XML for emptiness would never
/// see one. A block whose only text is whitespace, or that has no children
/// at all, sets it to false and `block_docx` below drops the paragraph.
fn append_inline(node: &serde_json::Value, out: &mut String, has_content: &mut bool) {
    match node.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
                if !text.trim().is_empty() || text.contains('\n') {
                    *has_content = true;
                }
                out.push_str(&run_xml(text, node));
            }
        }
        Some("hard_break") => {
            *has_content = true;
            out.push_str("<w:r><w:br/></w:r>");
        }
        _ => {
            if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
                for child in children {
                    append_inline(child, out, has_content);
                }
            }
        }
    }
}

/// One block as a `<w:p>`, or None if it renders to nothing -- the same rule
/// `export::block_markdown` states for Markdown: a paragraph of only
/// whitespace, or with no children at all, contributes no paragraph, because
/// a blank paragraph in the store is not content.
fn block_docx(node: &serde_json::Value) -> Option<String> {
    let mut inline = String::new();
    let mut has_content = false;
    append_inline(node, &mut inline, &mut has_content);
    has_content.then(|| format!("<w:p>{inline}</w:p>"))
}

/// One stored body as `<w:p>` paragraphs, or None if it is not a document
/// this build can read -- `store::document_text`'s acceptance rule: the root
/// must be a `doc`, not merely an object.
fn document_paragraphs(body: &str) -> Option<Vec<String>> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    if root.get("type").and_then(|t| t.as_str()) != Some("doc") {
        return None;
    }
    let mut out = Vec::new();
    if let Some(children) = root.get("content").and_then(|c| c.as_array()) {
        for child in children {
            if let Some(p) = block_docx(child) {
                out.push(p);
            }
        }
    }
    Some(out)
}

/// A title as heading or title-run text: a newline becomes a space, exactly
/// as `export::heading_title` does for Markdown, then XML-escaped.
///
/// NOT `export::heading_title` ITSELF. That function escapes for a Markdown
/// inline context -- a title carrying `*` would come back `\*`, and a
/// literal backslash in a Word document is not an escape, it is a character
/// the writer never typed. XML escaping is `docx.rs`'s own job, the same way
/// XHTML escaping is `epub.rs`'s.
fn heading_text(title: &str) -> String {
    let one_line: String = title
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    xml_escape(&one_line)
}

/// A styled paragraph: `<w:pPr><w:pStyle w:val="{style}"/></w:pPr>` plus one
/// plain run holding `text` -- used for the book's name (`Title`) and every
/// item's heading (`Heading{1..5}`). A title carries no marks, so one run is
/// always enough.
fn styled_paragraph(style: &str, text: &str) -> String {
    format!(
        "<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>\
         <w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"
    )
}

/// The `Heading{n}` style id for a store depth, `n` = the item's Markdown
/// level minus one: `heading_level` clamps to 2..6 (Markdown H2..H6), so this
/// clamps to `Heading1`..`Heading5` -- the same six-level ceiling, restated
/// rather than shared, because `docx.rs` and `export.rs` are two renderers
/// and a third must not reach INTO the Markdown one for a number that is
/// really about this format's own style table.
fn heading_style(depth: i64) -> String {
    format!("Heading{}", heading_level(depth) - 1)
}

/// One heading style: its `w:styleId`, its `w:name` (the word Word's
/// navigation pane and TOC field recognise -- "heading 1".."heading 5"), and
/// its size in half-points (`w:sz`/`w:szCs`). `Title` is here too, its own
/// name and size, because it is built the same way -- bold, `w:keepNext`,
/// no indent -- and is not `Normal`.
///
/// SIZES ARE 28/20/16/14/13/12 PT, Title down through Heading5, which is
/// 56/40/32/28/26/24 in the half-points OOXML measures `w:sz` in.
const HEADING_STYLES: [(&str, &str, u32); 6] = [
    ("Title", "Title", 56),
    ("Heading1", "heading 1", 40),
    ("Heading2", "heading 2", 32),
    ("Heading3", "heading 3", 28),
    ("Heading4", "heading 4", 26),
    ("Heading5", "heading 5", 24),
];

/// `word/styles.xml`: `Normal` plus the six headings above.
///
/// THE LANGUAGE GOES HERE, on `w:docDefaults/w:rPrDefault`, so the editor's
/// spell checker gets the book's language the way the EPUB's `xml:lang`
/// does -- a document default a run can still override, which nothing in
/// this renderer does, so it is the language every run inherits.
fn styles_xml(lang: &str) -> String {
    let mut out = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <w:styles xmlns:w=\"{W_NS}\">\n\
         <w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val=\"{}\"/></w:rPr></w:rPrDefault></w:docDefaults>\n\
         <w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\">\
         <w:name w:val=\"Normal\"/>\
         <w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/>\
         <w:ind w:firstLine=\"720\"/></w:pPr>\
         <w:rPr><w:sz w:val=\"24\"/><w:szCs w:val=\"24\"/></w:rPr>\
         </w:style>\n",
        xml_escape(lang)
    );
    for (style_id, name, sz) in HEADING_STYLES {
        out.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{style_id}\">\
             <w:name w:val=\"{name}\"/>\
             <w:pPr><w:keepNext/></w:pPr>\
             <w:rPr><w:b/><w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/></w:rPr>\
             </w:style>\n"
        ));
    }
    out.push_str("</w:styles>\n");
    out
}

/// `[Content_Types].xml`: the two extension defaults every OOXML package
/// needs (`rels`, `xml`) plus the two parts this package actually has.
fn content_types_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
     <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n\
     <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n\
     <Default Extension=\"xml\" ContentType=\"application/xml\"/>\n\
     <Override PartName=\"/word/document.xml\" \
     ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\n\
     <Override PartName=\"/word/styles.xml\" \
     ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\n\
     </Types>\n"
        .to_string()
}

/// `_rels/.rels`: one relationship, the package to its one document part.
fn package_rels_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
     <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
     <Relationship Id=\"rId1\" \
     Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" \
     Target=\"word/document.xml\"/>\n\
     </Relationships>\n"
        .to_string()
}

/// `word/_rels/document.xml.rels`: one relationship, the document to its
/// styles part.
fn document_rels_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
     <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
     <Relationship Id=\"rId1\" \
     Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" \
     Target=\"styles.xml\"/>\n\
     </Relationships>\n"
        .to_string()
}

/// `word/document.xml`: the Title paragraph, then every item's heading and
/// prose in `Book::runs`' order (front, chapters, back -- restated here as
/// the three public fields, since that method is private to `export.rs`),
/// then one `<w:sectPr>`.
///
/// PAGE SIZE IS US LETTER AND MARGINS ARE 1IN, and that is not the book
/// design's page (`design.rs`'s -- the PROOF's business): an editor's own
/// Word document opens at their own default and this only has to be valid.
fn document_xml(book: &Book, bodies: &HashMap<String, String>) -> String {
    let mut body = styled_paragraph("Title", &heading_text(book.name));
    for run in [book.front, book.chapters, book.back] {
        for (id, title, depth) in run {
            body.push_str(&styled_paragraph(&heading_style(*depth), &heading_text(title)));
            // An item with no body, and an item whose body this build cannot
            // read, contribute a heading only -- `export::manuscript`'s
            // rule: losing a chapter silently is the worst thing either
            // renderer can do.
            if let Some(paragraphs) = bodies.get(id).and_then(|b| document_paragraphs(b)) {
                for p in paragraphs {
                    body.push_str(&p);
                }
            }
        }
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <w:document xmlns:w=\"{W_NS}\"><w:body>{body}\
         <w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>\
         <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" \
         w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr>\
         </w:body></w:document>\n"
    )
}

/// The whole book as an OOXML package: STORED entries through `epub::zip`,
/// which is valid for a DOCX exactly as it is for an EPUB. ORDER IS FIXED --
/// `[Content_Types].xml` first, the two relationship parts, then the two
/// document parts -- and pinned by a test, though nothing in the OOXML spec
/// requires it; a fixed order is what makes two exports of an unchanged book
/// diff cleanly, the reason `epub::zip`'s own order is load-bearing.
pub fn render(book: &Book, bodies: &HashMap<String, String>, lang: &str) -> Manuscript {
    let entries = [
        Entry::text("[Content_Types].xml", &content_types_xml()),
        Entry::text("_rels/.rels", &package_rels_xml()),
        Entry::text("word/_rels/document.xml.rels", &document_rels_xml()),
        Entry::text("word/styles.xml", &styles_xml(lang)),
        Entry::text("word/document.xml", &document_xml(book, bodies)),
    ];
    Manuscript {
        bytes: zip(&entries),
        format: Format::Docx,
        // CARRIED, NOT DROPPED. Word has a real `<w:u>` and `run_xml` above
        // emits it on every underlined run, so this is a measurement and not
        // a default -- the same nought `epub::manuscript` reports and for
        // the same reason.
        underlined_runs: 0,
    }
}

/// The `(pStyle, text)` of every STYLED paragraph in `document.xml`, in
/// document order -- Title and every heading, never a body paragraph, which
/// carries no `w:pStyle` at all. TEST-ONLY, deliberately hand-rolled rather
/// than a dependency: this crate declined `crc32fast` for the same reason
/// (`epub.rs`'s header), and a walker that runs over a few kilobytes of test
/// fixture in `cargo test` is not the place to start.
#[cfg(test)]
pub(crate) fn heading_walk(document_xml: &str) -> Vec<(String, String)> {
    const STYLE_OPEN: &str = "w:pStyle w:val=\"";
    const TEXT_OPEN: &str = "<w:t xml:space=\"preserve\">";
    const TEXT_CLOSE: &str = "</w:t>";
    let mut out = Vec::new();
    for para in document_xml.split("<w:p>").skip(1) {
        let para = match para.find("</w:p>") {
            Some(end) => &para[..end],
            None => para,
        };
        let Some(style_at) = para.find(STYLE_OPEN) else {
            continue;
        };
        let after_style = &para[style_at + STYLE_OPEN.len()..];
        let Some(style_end) = after_style.find('"') else {
            continue;
        };
        let style = after_style[..style_end].to_string();
        let mut text = String::new();
        let mut rest = para;
        while let Some(text_at) = rest.find(TEXT_OPEN) {
            let after_text = &rest[text_at + TEXT_OPEN.len()..];
            let Some(text_end) = after_text.find(TEXT_CLOSE) else {
                break;
            };
            text.push_str(&after_text[..text_end]);
            rest = &after_text[text_end + TEXT_CLOSE.len()..];
        }
        out.push((style, text));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book<'a>(
        name: &'a str,
        front: &'a [(String, String, i64)],
        chapters: &'a [(String, String, i64)],
        back: &'a [(String, String, i64)],
    ) -> Book<'a> {
        Book {
            name,
            contents_title: "Contents",
            front,
            chapters,
            back,
        }
    }

    fn text_node(text: &str, marks: &[&str]) -> serde_json::Value {
        let m: Vec<_> = marks.iter().map(|n| serde_json::json!({"type": n})).collect();
        serde_json::json!({"type": "text", "text": text, "marks": m})
    }

    /// THE PACKAGE HAS EXACTLY THE FIVE ENTRIES, IN THIS ORDER. Read back
    /// through `epub::read_zip`, which is a real parse and not an assumption
    /// about what `zip` wrote -- the same reason the EPUB tests read their
    /// archive back rather than inspecting the entries `render` built.
    #[test]
    fn the_package_has_exactly_the_five_entries_in_order() {
        let out = render(&book("N", &[], &[], &[]), &HashMap::new(), "en");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "[Content_Types].xml",
                "_rels/.rels",
                "word/_rels/document.xml.rels",
                "word/styles.xml",
                "word/document.xml",
            ]
        );
    }

    /// EVERY ENTRY'S BYTES COME BACK. `read_zip` verifies the CRC of each
    /// entry against what it wrote, so this is the round trip and not a
    /// length check.
    #[test]
    fn every_entry_round_trips_through_read_zip() {
        let out = render(&book("N", &[], &[], &[]), &HashMap::new(), "en");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        let doc = entries
            .iter()
            .find(|(n, _)| n == "word/document.xml")
            .unwrap();
        assert!(String::from_utf8_lossy(&doc.1).contains("<w:document"));
        let styles = entries
            .iter()
            .find(|(n, _)| n == "word/styles.xml")
            .unwrap();
        assert!(String::from_utf8_lossy(&styles.1).contains("<w:styles"));
    }

    /// THE WALK ORDER, front then chapters then back, and the heading
    /// levels: a chapter at depth 0 is `Heading1`, a scene under it at depth
    /// 1 is `Heading2`. Asserted on the PARSED SEQUENCE, never on the whole
    /// string -- a body paragraph carries no `w:pStyle` and the walker
    /// skips it, so this cannot pass by accident of a body containing the
    /// word "Heading1".
    #[test]
    fn a_book_renders_title_and_headings_in_walk_order() {
        let front = [("d".to_string(), "Dedication".to_string(), 0i64)];
        let chapters = [
            ("c1".to_string(), "Chapter One".to_string(), 0i64),
            ("s1".to_string(), "The Harbour".to_string(), 1i64),
            ("c2".to_string(), "Chapter Two".to_string(), 0i64),
            ("s2".to_string(), "The Sea".to_string(), 1i64),
            // Past the six-level ceiling: Markdown clamps to H6, so Heading5.
            ("s9".to_string(), "Deep".to_string(), 9i64),
        ];
        let back = [("a".to_string(), "Acknowledgements".to_string(), 0i64)];
        let mut bodies = HashMap::new();
        bodies.insert(
            "s1".to_string(),
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"It began."}]}]}"#
                .to_string(),
        );
        let out = render(&book("My Novel", &front, &chapters, &back), &bodies, "en");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        let doc = entries
            .iter()
            .find(|(n, _)| n == "word/document.xml")
            .unwrap();
        let xml = String::from_utf8_lossy(&doc.1);
        let walked = heading_walk(&xml);
        assert_eq!(
            walked,
            vec![
                ("Title".to_string(), "My Novel".to_string()),
                ("Heading1".to_string(), "Dedication".to_string()),
                ("Heading1".to_string(), "Chapter One".to_string()),
                ("Heading2".to_string(), "The Harbour".to_string()),
                ("Heading1".to_string(), "Chapter Two".to_string()),
                ("Heading2".to_string(), "The Sea".to_string()),
                ("Heading5".to_string(), "Deep".to_string()),
                ("Heading1".to_string(), "Acknowledgements".to_string()),
            ]
        );
        assert!(xml.contains("It began."), "{xml}");
    }

    /// `strong` -> `<w:b/>`, `em` -> `<w:i/>`, `underline` -> `<w:u
    /// w:val="single"/>`, all three on one run in the stable order b, i, u.
    #[test]
    fn every_mark_carries_and_a_plain_run_has_no_rpr() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[
                text_node("plain", &[]),
                text_node("loud", &["strong"]),
                text_node("all three", &["underline", "strong", "em"]),
            ]}
        ]});
        let paragraphs = document_paragraphs(&doc.to_string()).unwrap();
        assert_eq!(paragraphs.len(), 1);
        let p = &paragraphs[0];
        assert!(
            p.contains("<w:r><w:t xml:space=\"preserve\">plain</w:t></w:r>"),
            "{p}"
        );
        assert!(
            p.contains("<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">loud</w:t></w:r>"),
            "{p}"
        );
        // b, i, u -- STABLE regardless of the order the marks array holds
        // them, the same claim `export::wrap_marks` makes for strong/em.
        assert!(
            p.contains(
                "<w:r><w:rPr><w:b/><w:i/><w:u w:val=\"single\"/></w:rPr>\
                 <w:t xml:space=\"preserve\">all three</w:t></w:r>"
            ),
            "{p}"
        );
    }

    /// TEXT WITH `&`, `<`, `>` AND SURROUNDING SPACE IS ESCAPED AND
    /// PRESERVED. `xml:space="preserve"` is what keeps the leading/trailing
    /// space from being collapsed by a reader that follows XML whitespace
    /// rules on an element with no such attribute.
    #[test]
    fn text_is_escaped_and_space_preserved() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node(" Tom & Jerry <shout> ", &[])]}
        ]});
        let paragraphs = document_paragraphs(&doc.to_string()).unwrap();
        assert_eq!(
            paragraphs[0],
            "<w:p><w:r><w:t xml:space=\"preserve\"> Tom &amp; Jerry &lt;shout&gt; </w:t></w:r></w:p>"
        );
    }

    /// A HARD BREAK IS `<w:br/>` INSIDE THE RUN SEQUENCE. The page's schema
    /// has no `hard_break` today (`import.rs`'s header), so this is a body
    /// this build cannot produce yet and can still read -- the same stance
    /// every unrecognised-node fallthrough in this crate takes.
    #[test]
    fn a_hard_break_becomes_a_w_br() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[
                text_node("one", &[]),
                {"type":"hard_break"},
                text_node("two", &[]),
            ]}
        ]});
        let paragraphs = document_paragraphs(&doc.to_string()).unwrap();
        assert_eq!(
            paragraphs[0],
            "<w:p><w:r><w:t xml:space=\"preserve\">one</w:t></w:r><w:r><w:br/></w:r>\
             <w:r><w:t xml:space=\"preserve\">two</w:t></w:r></w:p>"
        );
    }

    #[test]
    fn marked_text_newlines_and_break_only_paragraphs_become_word_breaks() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("\none\n\ntwo\n", &["strong", "em", "underline"])]},
            {"type":"paragraph","content":[text_node("\n\n", &["underline"])]}
        ]});
        let paragraphs = document_paragraphs(&doc.to_string()).unwrap();
        assert_eq!(paragraphs.len(), 2);
        assert_eq!(paragraphs[0], concat!(
            "<w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val=\"single\"/></w:rPr>",
            "<w:t xml:space=\"preserve\"></w:t><w:br/>",
            "<w:t xml:space=\"preserve\">one</w:t><w:br/>",
            "<w:t xml:space=\"preserve\"></w:t><w:br/>",
            "<w:t xml:space=\"preserve\">two</w:t><w:br/>",
            "<w:t xml:space=\"preserve\"></w:t></w:r></w:p>"
        ));
        assert_eq!(paragraphs[1].matches("<w:br/>").count(), 2);
        assert!(paragraphs[1].contains("<w:u w:val=\"single\"/>"));
    }

    /// NO `docProps/` ENTRY AND NO `creator` BYTES ANYWHERE IN THE ZIP. A
    /// real name or an OS user name has exactly one door into an EPUB
    /// (`identity_metadata`'s `dc:creator`) and this format opens none at
    /// all.
    #[test]
    fn no_docprops_and_no_creator_leaves_in_the_package() {
        let out = render(&book("N", &[], &[], &[]), &HashMap::new(), "en");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        assert!(!entries.iter().any(|(n, _)| n.starts_with("docProps/")));
        assert!(!out.bytes.windows(7).any(|w| w == b"creator"));
    }

    /// THE LANG TAG CARRIES THE TAG PASSED IN, on the document defaults
    /// every run inherits -- the same source-of-truth rule put on
    /// `epub::Epub::language`: the render never invents one of its own.
    #[test]
    fn w_lang_carries_the_tag_passed_in() {
        let out = render(&book("N", &[], &[], &[]), &HashMap::new(), "de-DE");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        let styles = entries
            .iter()
            .find(|(n, _)| n == "word/styles.xml")
            .unwrap();
        assert!(String::from_utf8_lossy(&styles.1).contains("<w:lang w:val=\"de-DE\"/>"));
    }

    /// AN EMPTY BODY EMITS THE HEADING AND NOTHING ELSE -- `export.rs`'s
    /// rule, restated: a body this build can read but that holds no real
    /// content contributes no paragraph.
    #[test]
    fn an_empty_body_emits_only_the_heading() {
        let chapters = [("c".to_string(), "Chapter One".to_string(), 0i64)];
        let mut bodies = HashMap::new();
        bodies.insert(
            "c".to_string(),
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"   "}]}]}"#
                .to_string(),
        );
        let out = render(&book("N", &[], &chapters, &[]), &bodies, "en");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        let doc = entries
            .iter()
            .find(|(n, _)| n == "word/document.xml")
            .unwrap();
        let xml = String::from_utf8_lossy(&doc.1);
        assert_eq!(
            heading_walk(&xml),
            vec![
                ("Title".to_string(), "N".to_string()),
                ("Heading1".to_string(), "Chapter One".to_string()),
            ]
        );
        // No stray paragraph at all for the whitespace-only body: the walker
        // above already proves no HEADING slipped in, and this proves no
        // paragraph of any kind did either.
        assert_eq!(xml.matches("<w:p>").count(), 2);
    }

    /// SABOTAGE-SHAPED: `underlined_runs` IS 0 EVEN WHEN A BODY HAS
    /// UNDERLINE, and the Markdown renderer over the SAME body reports 1 --
    /// so a build that quietly dropped the underline mark here, the way
    /// Markdown does, would still pass every test above and only this one
    /// would catch it.
    #[test]
    fn underlined_runs_is_nought_where_markdown_reports_one_for_the_same_body() {
        let chapters = [("c".to_string(), "Chapter One".to_string(), 0i64)];
        let mut bodies = HashMap::new();
        bodies.insert(
            "c".to_string(),
            serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[text_node("under", &["underline"])]}
            ]})
            .to_string(),
        );
        let docx = render(&book("N", &[], &chapters, &[]), &bodies, "en");
        assert_eq!(docx.underlined_runs, 0);
        let markdown = crate::export::manuscript(&book("N", &[], &chapters, &[]), &bodies);
        assert_eq!(markdown.underlined_runs, 1);
        // And the mark really did carry: the run is in the file, not merely
        // uncounted.
        let entries = crate::epub::read_zip(&docx.bytes).unwrap();
        let doc = entries
            .iter()
            .find(|(n, _)| n == "word/document.xml")
            .unwrap();
        assert!(String::from_utf8_lossy(&doc.1).contains("<w:u w:val=\"single\"/>"));
    }

    /// A BODY THIS BUILD CANNOT READ CONTRIBUTES A HEADING ONLY -- losing a
    /// chapter silently is the worst thing this feature can do.
    #[test]
    fn an_unreadable_body_does_not_take_the_scene_out_of_the_manuscript() {
        let chapters = [("c".to_string(), "Chapter One".to_string(), 0i64)];
        let mut bodies = HashMap::new();
        bodies.insert("c".to_string(), "not json at all".to_string());
        let out = render(&book("N", &[], &chapters, &[]), &bodies, "en");
        let entries = crate::epub::read_zip(&out.bytes).unwrap();
        let doc = entries
            .iter()
            .find(|(n, _)| n == "word/document.xml")
            .unwrap();
        assert!(String::from_utf8_lossy(&doc.1).contains("Chapter One"));
    }
}
