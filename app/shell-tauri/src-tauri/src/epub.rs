// app/shell-tauri/src-tauri/src/epub.rs
// THE EPUB RENDER: an OCF container (a zip) of XHTML documents, a package
// document and a navigation document. Shared ZIP/date mechanics live in
// package_format so the mobile review transport does not import this renderer.
//
// NO NEW DEPENDENCY, and that is a decision rather than a coincidence. An EPUB
// is a zip and the OCF specification permits STORED (uncompressed) entries, so
// nothing here has to compress; the only piece of a zip that is not clerical is
// the CRC-32, and CRC-32/ISO-HDLC is a small bitwise loop in package_format
// with a published check value. `crc32fast` IS in this crate's lock file under
// `flate2` and was declined: a build-graph entry, a licence review and a line in
// `THIRD-PARTY-NOTICES.md` is a worse trade than twelve lines with a test
// vector, and this project's posture is offline and no-fetch by default.
//
// PURE, exactly as `export.rs` is: no I/O, no `Store`, no `Path`. Bytes in,
// bytes out. The cover arrives as bytes somebody else read.
//
// THE PREVIEW READS THESE BYTES BACK through the shared `read_zip` and `zip`.
// The publishing track's design record requires
// that the preview render the same bytes the file gets; the form taken here is
// stronger than "callable without writing a file" -- the preview renders the
// archive and then UNZIPS it, so it cannot be right while the file is wrong.

use crate::design::{glyph_ornament, ChapterStyle};
use crate::export::{Book, ChapterOpenings};
use std::collections::HashMap;

/// The one media type an OCF container declares, byte for byte.
pub const MIMETYPE: &str = "application/epub+zip";

pub use crate::package_format::{crc32, iso8601_utc, read_zip, zip, Entry};
#[cfg(test)]
use crate::package_format::MAX_ENTRY_BYTES;

// ---- the render ---------------------------------------------------------

/// Where the publication's own files live inside the container.
pub const OEBPS: &str = "OEBPS";
/// The directory holding EVERY document in the reading order, and nothing else.
///
/// THAT IS A RULE THE PREVIEW DEPENDS ON. `reading_order` selects the spine out
/// of a read-back archive by this prefix alone, so the preview needs no XML
/// parser and cannot show a document the book does not open to. Anything added
/// here that is not in the spine breaks it, and
/// `every_spine_document_is_an_entry_and_every_reading_order_entry_is_in_the_
/// spine` is what says so.
pub const TEXT_DIR: &str = "text";
pub const OPF_PATH: &str = "OEBPS/content.opf";
pub const CONTAINER_PATH: &str = "META-INF/container.xml";
/// Relative to `OEBPS`.
pub const CSS_HREF: &str = "style.css";
pub const NAV_HREF: &str = "text/nav.xhtml";
/// Relative to `TEXT_DIR`, because that is how a document links to a sibling.
pub const TITLE_HREF: &str = "title.xhtml";
pub const COVER_HREF: &str = "cover.xhtml";

/// The class an underlined run is wrapped in, and the class the stylesheet
/// gives an underline. RESTATED from nothing: XHTML has no underline element
/// worth the argument `<u>` starts, and a class is what the stylesheet can
/// reach.
pub const UNDERLINE_CLASS: &str = "u";
/// The class the chapter ornament is drawn as.
pub const ORNAMENT_CLASS: &str = "ornament";
/// A typed part or chapter heading that starts a new page within its document.
/// The first heading of a spine document already begins on a new page.
pub const START_CLASS: &str = "start";
/// The class the first paragraph of a typed chapter opening carries.
pub const OPENING_CLASS: &str = "opening";

/// The bytes of a book's front cover, and what they are.
pub struct Cover {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub extension: &'static str,
}

/// Everything a render needs, and nothing it can go and fetch.
pub struct Epub<'a> {
    pub book: &'a Book<'a>,
    pub bodies: &'a HashMap<String, String>,
    /// The store identity when this project has one. Legacy stores have none
    /// and retain the title-derived publication identifier.
    pub book_id: Option<&'a str>,
    /// The BCP-47 tag on `<package xml:lang>`, `dc:language` and every XHTML
    /// document.
    ///
    /// A PARAMETER SINCE 055, and it was `LANGUAGE = "en"` -- a constant that
    /// told every reading system, every screen reader and every shop that a
    /// book was in English whoever wrote it. It comes from the catalog the
    /// render was given, so a book's words and its declared language have ONE
    /// source and cannot disagree.
    pub language: &'a str,
    /// The family name 040 stored. A NAME and not a file: this application
    /// ships no font files, so the stylesheet names it and puts a stack behind
    /// it.
    pub font: &'a str,
    pub style: ChapterStyle,
    /// IDs selected from typed chapter-run rows by the export path.
    pub openings: ChapterOpenings,
    /// The FRONT cover only. An EPUB has one cover slot and it is the front;
    /// see the write-back for the back cover, which this format has nowhere to
    /// put.
    pub cover: Option<Cover>,
    /// `dcterms:modified`, as an ISO-8601 UTC instant. A PARAMETER and never
    /// the clock read in here, so a test can pin the bytes exactly and the one
    /// non-deterministic fact in the archive has exactly one source.
    pub modified: &'a str,
    /// The identity this book is pinned to, or None.
    ///
    /// WHAT IT EMITS IS NOT DECIDED HERE. `identity::disclosed` answers which
    /// fields go where, and `identity_metadata` below does nothing but turn its
    /// answer into the package document's own spelling. That is the design's
    /// one-table rule: the preflight prints the SAME list this writes, so
    /// "here is everything that will leave" is provable rather than
    /// hand-maintained. A row that stopped being emitted here while the check
    /// went on printing it would make the check theatre.
    pub pin: Option<&'a crate::identity::Pin>,
}

/// Text safe in an XHTML text node OR attribute value.
///
/// ONE FUNCTION FOR BOTH, and it escapes all five predefined entities rather
/// than the three a text node needs. Two functions is two places to use the
/// weaker one, and the cost of the stronger is `&quot;` where `"` would have
/// done -- which every reader renders as a quotation mark.
pub(crate) fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// A family name inside a CSS string.
///
/// Quotes and backslashes cannot end the CSS string. HTML-significant and
/// stylesheet-scoping characters are hex-escaped too: old stored values can
/// predate `parse_font`'s stricter input rule, and the PDF embeds this CSS in an
/// HTML `<style>` element.
pub(crate) fn css_string(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    out.push('"');
    for c in name.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '<' | '>' | '{' | '}' | '@' | ';' => {
                out.push_str(&format!("\\{:x} ", c as u32));
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One stored body as XHTML blocks, or None if it is not a document this build
/// can read.
///
/// A SECOND WALK OF THE TREE `export::document_markdown` walks, and the third
/// in this crate after `store::document_text`. Restatement is this repo's
/// recorded decision and it earns itself here: Markdown's rule DROPS the
/// underline and counts the loss, and this one CARRIES it. A shared walk
/// parameterised over an emitter would have made that difference an argument
/// rather than a program, and the two formats disagree about more than
/// delimiters -- one escapes for a line-oriented plain text and the other for a
/// markup language.
pub fn document_xhtml(body: &str) -> Option<String> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    if root.get("type").and_then(|t| t.as_str()) != Some("doc") {
        return None;
    }
    let mut blocks: Vec<String> = Vec::new();
    if let Some(children) = root.get("content").and_then(|c| c.as_array()) {
        for child in children {
            let mut inline = String::new();
            append_inline(child, &mut inline);
            // An empty block contributes NO paragraph, exactly as it
            // contributes no line to the Markdown.
            if !inline.trim().is_empty() {
                blocks.push(inline);
            }
        }
    }
    Some(blocks.join("\n"))
}

fn append_inline(node: &serde_json::Value, out: &mut String) {
    if node.get("type").and_then(|t| t.as_str()) == Some("text") {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            out.push_str(&wrap_marks(&xml_escape(text), node));
        }
        return;
    }
    // An unrecognised node still emits its descendants, on `document_text`'s
    // principle: being strict deeper would take a whole scene out of a writer's
    // book for one node this build has not met.
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            append_inline(child, out);
        }
    }
}

/// `text` wrapped in the elements for whichever marks the node carries.
///
/// A MEMBERSHIP TEST AND NOT A FOLD, for `export::wrap_marks`' reason: marks are
/// a SET on a text node, so `["em","strong"]` and `["strong","em"]` are the same
/// node and must produce the same bytes. Strong outside, then em, then the
/// underline innermost.
fn wrap_marks(text: &str, node: &serde_json::Value) -> String {
    let mut em = false;
    let mut strong = false;
    let mut underline = false;
    if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
        for mark in marks {
            match mark.get("type").and_then(|t| t.as_str()) {
                Some("em") => em = true,
                Some("strong") => strong = true,
                Some("underline") => underline = true,
                _ => {}
            }
        }
    }
    let mut out = text.to_string();
    if underline {
        out = format!("<span class=\"{UNDERLINE_CLASS}\">{out}</span>");
    }
    if em {
        out = format!("<em>{out}</em>");
    }
    if strong {
        out = format!("<strong>{out}</strong>");
    }
    out
}

/// The documents of the reading order, in it, out of a read-back archive.
///
/// THE PREVIEW'S OWN RULE, and it is a prefix test rather than a parse of the
/// package document. Every spine document lives under `OEBPS/text/` and nothing
/// else does, so archive order IS spine order by construction -- and the
/// preview is then the file, read back, with no second statement of what the
/// book opens to.
pub fn reading_order(entries: &[(String, Vec<u8>)]) -> Vec<(String, String)> {
    let prefix = format!("{OEBPS}/{TEXT_DIR}/");
    entries
        .iter()
        .filter(|(name, _)| name.starts_with(&prefix) && name.ends_with(".xhtml"))
        .map(|(name, bytes)| (name.clone(), String::from_utf8_lossy(bytes).into_owned()))
        .collect()
}

/// `xhtml` with the language taken off the render's own input, so no call site
/// can pass a different one from the package document's.
fn xhtml_of(epub: &Epub, title: &str, epub_type: &str, body: &str) -> String {
    xhtml(title, epub_type, body, epub.language)
}

fn xhtml(title: &str, epub_type: &str, body: &str, language: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\" \
         xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"{language}\" lang=\"{language}\">\n\
         <head><title>{title}</title>\
         <link rel=\"stylesheet\" type=\"text/css\" href=\"../{CSS_HREF}\"/></head>\n\
         <body epub:type=\"{epub_type}\">\n{body}\n</body>\n</html>\n",
        title = xml_escape(title),
        language = xml_escape(language),
    )
}

/// The stylesheet, and the three of the four options that are nothing but this.
///
/// THE OPTIONS ARE CSS THE WRITER PICKS RATHER THAN TYPES, and three of them
/// live here alone: the markup says what a thing IS (a heading that opens a
/// division, the paragraph a chapter starts with) unconditionally, and whether
/// that means a page break or a drop cap is one rule in one file. An absent
/// option writes NO RULE at all, which is what makes "absent means the plainest
/// book" a property of the bytes rather than a claim about them.
fn stylesheet(font: &str, style: &ChapterStyle) -> String {
    let mut css = format!(
        "html {{ margin: 0; padding: 0; }}\n\
         body {{ font-family: {family}, {fallback}; \
         margin: 0 5%; line-height: 1.5; }}\n\
         h1, h2, h3, h4, h5, h6 {{ font-weight: normal; text-align: center; \
         margin: 2em 0 1em; page-break-after: avoid; break-after: avoid; }}\n\
         p {{ margin: 0; text-indent: 1.2em; text-align: justify; }}\n\
         h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p, .{ORNAMENT_CLASS} + p \
         {{ text-indent: 0; }}\n\
         .{ORNAMENT_CLASS} {{ text-align: center; text-indent: 0; margin: 1.5em 0; }}\n\
         .{UNDERLINE_CLASS} {{ text-decoration: underline; }}\n\
         nav ol {{ list-style: none; padding-left: 1em; }}\n\
         a {{ color: inherit; text-decoration: none; }}\n",
        family = css_string(font),
        fallback = crate::design::FONT_FALLBACK,
    );
    if style.new_page {
        css.push_str(&format!(
            ".{START_CLASS} {{ page-break-before: always; break-before: page; }}\n"
        ));
    }
    if style.caps_title {
        css.push_str(
            ".book-body-heading { text-transform: uppercase; letter-spacing: 0.06em; }\n",
        );
    }
    if style.drop_cap {
        css.push_str(&format!(
            ".{OPENING_CLASS}::first-letter {{ float: left; font-size: 3.2em; \
             line-height: 0.82; padding: 0.02em 0.08em 0 0; }}\n"
        ));
    }
    css
}

/// The whole book as an OCF container, panicking on an identity error: the
/// tests' shorthand for `render_checked`, which `manuscript` calls.
#[cfg(test)]
pub fn render(epub: &Epub) -> Vec<u8> {
    render_checked(epub).unwrap_or_else(|error| panic!("EPUB identity: {error}"))
}

/// The whole book as an OCF container.
///
/// ONE RENDERER AND ONE SET OF BYTES. `commands::export` writes exactly what
/// comes back from here (through `manuscript`) and `epub_preview` reads exactly
/// that back, so there is no second path for the preview to be right on while
/// the file is wrong -- the design record's constraint, met by construction
/// rather than by discipline.
fn render_checked(epub: &Epub) -> Result<Vec<u8>, String> {
    let contents = crate::export::contents_of(epub.book);
    let ornament = epub.style.glyph.as_deref().and_then(glyph_ornament);

    // One document per TOP-LEVEL item, its descendants inside it. Not one per
    // item: a reading system starts every spine document on a new page, so a
    // document per scene would make the `new-page` option a thing that is
    // always on and can never be turned off. Not one document for the whole
    // book either -- the `stress` fixture is 20 000 items and a reader that
    // must lay out the entire manuscript to show its first page is a reader
    // that appears to hang.
    struct Doc {
        href: String,
        title: String,
        epub_type: &'static str,
        body: String,
    }
    let mut docs: Vec<Doc> = Vec::new();
    // Item id -> the link that reaches its heading. Built while the documents
    // are, so a contents entry cannot name a target no document carries.
    let mut targets: HashMap<String, String> = HashMap::new();
    let runs: [(&[(String, String, i64)], &'static str); 3] = [
        (epub.book.front, "frontmatter"),
        (epub.book.chapters, "bodymatter"),
        (epub.book.back, "backmatter"),
    ];
    let mut anchor = 0usize;
    for (run_index, (run, epub_type)) in runs.into_iter().enumerate() {
        let mut opening_pending = false;
        for (id, title, depth) in run {
            anchor += 1;
            let level = crate::export::heading_level(*depth);
            let opens = *depth <= 0 || docs.is_empty();
            let styled = run_index == 1 && epub.openings.styled.contains(id);
            let page = run_index == 1 && epub.openings.page.contains(id);
            if opens {
                docs.push(Doc {
                    href: format!("{:04}.xhtml", docs.len() + 1),
                    title: title.clone(),
                    epub_type,
                    body: String::new(),
                });
            }
            if opens || styled || page { opening_pending = styled; }
            let doc = docs.last_mut().expect("a document was opened above");
            let fragment = format!("h{anchor}");
            targets.insert(id.clone(), format!("{}#{fragment}", doc.href));
            // A spine document already begins on a new page, so only a typed
            // part or chapter within that document needs the break class.
            let mut classes = Vec::new();
            if page && !opens { classes.push(START_CLASS); }
            if run_index == 1 { classes.push("book-body-heading"); }
            let class = if classes.is_empty() { String::new() }
                else { format!(" class=\"{}\"", classes.join(" ")) };
            doc.body.push_str(&format!(
                "<h{level} id=\"{fragment}\"{class}>{}</h{level}>\n",
                xml_escape(title)
            ));
            // THE ORNAMENT MARKS A CHAPTER, not every heading under it. A
            // dinkus under every scene title is a page of dinkuses, and the
            // the design calls for a glyph at the chapter break.
            if styled {
                if let Some(ornament) = ornament {
                    doc.body.push_str(&format!(
                        "<p class=\"{ORNAMENT_CLASS}\">{}</p>\n",
                        xml_escape(ornament)
                    ));
                }
            }
            // An item with no body, and an item whose body this build cannot
            // read, contribute a heading only. `export::manuscript`'s rule:
            // losing a chapter silently is the worst thing either renderer can
            // do.
            let prose = epub
                .bodies
                .get(id)
                .and_then(|b| document_xhtml(b))
                .unwrap_or_default();
            for block in prose.lines() {
                // Containers commonly have no prose; their first scene opens the division.
                let class = if opening_pending && !block.trim().is_empty() {
                    opening_pending = false;
                    format!(" class=\"{OPENING_CLASS}\"")
                } else {
                    String::new()
                };
                doc.body.push_str(&format!("<p{class}>{block}</p>\n"));
            }
        }
    }

    let mut entries: Vec<Entry> = Vec::new();
    entries.push(Entry::text("mimetype", MIMETYPE));
    entries.push(Entry::text(
        CONTAINER_PATH,
        &format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
             <container version=\"1.0\" \
             xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n\
             <rootfiles><rootfile full-path=\"{OPF_PATH}\" \
             media-type=\"application/oebps-package+xml\"/></rootfiles>\n</container>\n"
        ),
    ));

    // Manifest and spine, built together with the entries so the three cannot
    // disagree about what the book holds.
    let mut manifest = String::new();
    let mut spine = String::new();
    let mut later: Vec<Entry> = Vec::new();

    manifest.push_str(&format!(
        "<item id=\"css\" href=\"{CSS_HREF}\" media-type=\"text/css\"/>"
    ));
    later.push(Entry::text(
        &format!("{OEBPS}/{CSS_HREF}"),
        &stylesheet(epub.font, &epub.style),
    ));

    if let Some(cover) = &epub.cover {
        let image = format!("cover.{}", cover.extension);
        manifest.push_str(&format!(
            "<item id=\"cover-image\" href=\"{image}\" media-type=\"{}\" \
             properties=\"cover-image\"/>",
            cover.media_type
        ));
        later.push(Entry {
            name: format!("{OEBPS}/{image}"),
            bytes: cover.bytes.clone(),
        });
        manifest.push_str(&format!(
            "<item id=\"cover\" href=\"{TEXT_DIR}/{COVER_HREF}\" \
             media-type=\"application/xhtml+xml\"/>"
        ));
        spine.push_str("<itemref idref=\"cover\"/>");
        later.push(Entry::text(
            &format!("{OEBPS}/{TEXT_DIR}/{COVER_HREF}"),
            &xhtml_of(
                epub,
                epub.book.name,
                "cover",
                &format!(
                    "<section class=\"cover\"><img src=\"../{image}\" alt=\"{}\"/></section>",
                    xml_escape(epub.book.name)
                ),
            ),
        ));
    }

    manifest.push_str(&format!(
        "<item id=\"title\" href=\"{TEXT_DIR}/{TITLE_HREF}\" \
         media-type=\"application/xhtml+xml\"/>"
    ));
    spine.push_str("<itemref idref=\"title\"/>");
    later.push(Entry::text(
        &format!("{OEBPS}/{TEXT_DIR}/{TITLE_HREF}"),
        &xhtml_of(
            epub,
            epub.book.name,
            "titlepage",
            &format!("<section><h1>{}</h1></section>", xml_escape(epub.book.name)),
        ),
    ));

    // THE NAVIGATION DOCUMENT, from 041's `contents` and from nothing else. It
    // is 041's own words: the list is carried out of the render as DATA
    // precisely so this needs no Markdown to parse and no second statement of
    // which heading sits under which.
    //
    // IT OPENS WITH THE TITLE PAGE, in the writer's own words. A package must
    // carry exactly one navigation document and its list may not be empty, so a
    // book with no items still needs one line -- and the honest line is the one
    // thing that book has. It also keeps 041's rule that a heading over nothing
    // is a section nobody asked for: there is never a heading here over an
    // empty list.
    let mut nav = format!(
        "<nav epub:type=\"toc\" id=\"toc\"><h1>{}</h1>\n<ol>\n<li><a href=\"{TITLE_HREF}\">{}</a>",
        xml_escape(epub.book.contents_title),
        xml_escape(epub.book.name),
    );
    // THE NESTING, and it is the one piece of this file with a state machine in
    // it. An EPUB `nav` is a nested `<ol>`, a nested list lives INSIDE its
    // parent's `<li>`, and `contents` is a flat run of levels -- so going
    // deeper opens list-and-item, coming back up closes item-and-list and
    // leaves the parent item open, and staying level closes one item and opens
    // the next. Written from the levels 041 carried out of the render and never
    // from the depths, so an entry and its heading cannot disagree.
    let mut open = 0usize;
    for entry in &contents {
        let want = entry.level.saturating_sub(crate::export::heading_level(0));
        if want > open {
            for _ in open..want {
                nav.push_str("\n<ol>\n<li>");
            }
            open = want;
        } else {
            while open > want {
                nav.push_str("</li>\n</ol>");
                open -= 1;
            }
            nav.push_str("</li>\n<li>");
        }
        let href = targets
            .get(&entry.id)
            .cloned()
            .unwrap_or_else(|| TITLE_HREF.to_string());
        nav.push_str(&format!(
            "<a href=\"{href}\">{}</a>",
            xml_escape(&entry.title)
        ));
    }
    while open > 0 {
        nav.push_str("</li>\n</ol>");
        open -= 1;
    }
    nav.push_str("</li>\n</ol>\n</nav>");
    manifest.push_str(&format!(
        "<item id=\"nav\" href=\"{NAV_HREF}\" media-type=\"application/xhtml+xml\" \
         properties=\"nav\"/>"
    ));
    spine.push_str("<itemref idref=\"nav\"/>");
    later.push(Entry::text(
        &format!("{OEBPS}/{NAV_HREF}"),
        &xhtml_of(epub, epub.book.contents_title, "frontmatter", &nav),
    ));

    for (n, doc) in docs.iter().enumerate() {
        let id = format!("d{}", n + 1);
        manifest.push_str(&format!(
            "<item id=\"{id}\" href=\"{TEXT_DIR}/{}\" media-type=\"application/xhtml+xml\"/>",
            doc.href
        ));
        spine.push_str(&format!("<itemref idref=\"{id}\"/>"));
        later.push(Entry::text(
            &format!("{OEBPS}/{TEXT_DIR}/{}", doc.href),
            &xhtml_of(
                epub,
                &doc.title,
                doc.epub_type,
                &format!(
                    "<section epub:type=\"{}\">\n{}</section>",
                    doc.epub_type, doc.body
                ),
            ),
        ));
    }

    entries.push(Entry::text(
        OPF_PATH,
        &format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
             <package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" \
             unique-identifier=\"pub-id\" xml:lang=\"{language}\">\n\
             <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
             <dc:identifier id=\"pub-id\">{identifier}</dc:identifier>\n\
             <dc:title>{title}</dc:title>\n\
             <dc:language>{language}</dc:language>\n\
             <meta property=\"dcterms:modified\">{modified}</meta>\n\
             {identity}</metadata>\n\
             <manifest>{manifest}</manifest>\n\
             <spine>{spine}</spine>\n\
             </package>\n",
            identifier = xml_escape(&identifier_for(epub.book.name, epub.book_id)?),
            title = xml_escape(epub.book.name),
            modified = xml_escape(epub.modified),
            language = xml_escape(epub.language),
            identity = identity_metadata(epub.pin),
        ),
    ));
    entries.extend(later);
    Ok(zip(&entries))
}

/// The book as a `Manuscript`, which is what every caller of a renderer in this
/// crate holds.
///
/// `underlined_runs` IS NOUGHT AND THAT IS A MEASUREMENT, not a default. The
/// field exists because Markdown has no underline and drops one; XHTML has one,
/// `wrap_marks` above emits it, and a build that reported a loss here would
/// tell a writer something untrue about a file that carries their emphasis
/// perfectly.
pub fn manuscript(epub: &Epub) -> Result<crate::export::Manuscript, String> {
    Ok(crate::export::Manuscript {
        bytes: render_checked(epub)?,
        format: crate::export::Format::Epub,
        underlined_runs: 0,
    })
}

/// The identity rows of the package document, from `identity::disclosed`.
///
/// IT ITERATES THE TABLE AND NEVER A LIST OF ITS OWN. Every `at` this build
/// knows has an arm; a row added to `EPUB_FIELDS` without one here emits
/// nothing, which is why `every_epub_field_in_the_table_is_actually_emitted`
/// exists and fails on exactly that. An unknown `at` is skipped rather than
/// guessed at: a package document is validated by other people's software and
/// an invented element is worse than an absent one.
///
/// `dc:creator` CARRIES AN ID because `file-as` refines it by that id. The
/// table's `requires` is what stops the refinement being written without it.
fn identity_metadata(pin: Option<&crate::identity::Pin>) -> String {
    let mut out = String::new();
    for (at, value) in crate::identity::disclosed(crate::export::Format::Epub, pin) {
        let value = xml_escape(value);
        match at {
            "dc:creator" => out.push_str(&format!(
                "<dc:creator id=\"{CREATOR_ID}\">{value}</dc:creator>\n"
            )),
            "file-as" => out.push_str(&format!(
                "<meta refines=\"#{CREATOR_ID}\" property=\"file-as\">{value}</meta>\n"
            )),
            "dc:publisher" => {
                out.push_str(&format!("<dc:publisher>{value}</dc:publisher>\n"))
            }
            "dc:rights" => out.push_str(&format!("<dc:rights>{value}</dc:rights>\n")),
            _ => {}
        }
    }
    out
}

/// The `id` the creator element carries, so a refinement can point at it.
const CREATOR_ID: &str = "creator";

/// The publication's `dc:identifier`.
///
/// DERIVED FROM THE TITLE, AND THAT IS A RECORDED GAP RATHER THAN A DESIGN. A
/// publication identifier is meant to be unique and permanent, and the honest
/// statement of what this one is is in the name: it is stable across every
/// export of one book, which is the property a reading system's library
/// actually uses, and two different books with the same title share it. Minting
/// a real one needs a value written into the project the first time it is
/// exported, and an export opens the store READONLY on purpose -- so it is a
/// slice, not a line.
fn identifier_for(name: &str, book_id: Option<&str>) -> Result<String, String> {
    if let Some(book_id) = book_id {
        let id = uuid::Uuid::parse_str(book_id)
            .map_err(|_| "the book identity is not a UUID".to_string())?;
        return Ok(format!("urn:uuid:{}", id.hyphenated()));
    }
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    Ok(format!("book:{}", slug.trim_matches('-')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_answers_the_published_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn an_archive_reads_back_as_the_entries_it_was_written_from() {
        let entries = vec![
            Entry::text("mimetype", MIMETYPE),
            Entry::text("META-INF/container.xml", "<x/>"),
            Entry {
                name: "OEBPS/cover.png".to_string(),
                bytes: vec![0u8, 1, 2, 255],
            },
        ];
        let archive = zip(&entries);
        let read = read_zip(&archive).unwrap();
        assert_eq!(read.len(), 3);
        for (n, entry) in entries.iter().enumerate() {
            assert_eq!(read[n].0, entry.name);
            assert_eq!(read[n].1, entry.bytes);
        }
    }

    #[test]
    fn a_rendered_book_declares_itself_an_epub_and_nothing_else() {
        // FOUND BY MUTATION, and it is the gap between a container writer and a
        // RENDERER: the test below builds its own archive and so says nothing
        // about the one `render` builds. Swapping the media type for
        // `application/zip` -- a file every reading system would refuse -- passed
        // the whole suite.
        let archive = render(&input(&plain("N", &[]), &bodies(&[])));
        assert_eq!(&archive[30..38], b"mimetype");
        assert_eq!(&archive[38..38 + MIMETYPE.len()], MIMETYPE.as_bytes());
    }

    #[test]
    fn the_mimetype_is_the_first_entry_and_is_stored_uncompressed() {
        let archive = zip(&[Entry::text("mimetype", MIMETYPE), Entry::text("a", "b")]);
        // Byte 30 is the first byte after a local header with no extra field,
        // so the name and then the payload sit at fixed offsets when the entry
        // is first and STORED. The OCF specification is exactly this
        // requirement, and it is the one thing about the container a reader may
        // check without unzipping.
        assert_eq!(&archive[30..38], b"mimetype");
        assert_eq!(&archive[38..38 + MIMETYPE.len()], MIMETYPE.as_bytes());
        // Method 0 at offset 8 of the local header.
        assert_eq!(u16::from_le_bytes([archive[8], archive[9]]), 0);
    }

    #[test]
    fn an_archive_whose_bytes_have_changed_under_it_is_refused() {
        // FOUND BY MUTATION. Deleting the checksum comparison in `read_zip`
        // passed the whole suite, because nothing in it had ever handed the
        // reader a corrupt archive -- and the checksum is the whole reason the
        // preview reads the file back rather than trusting the buffer it just
        // built.
        let mut archive = zip(&[Entry::text("mimetype", MIMETYPE), Entry::text("a", "hello")]);
        let at = archive
            .windows(5)
            .position(|w| w == b"hello")
            .expect("the payload is stored uncompressed");
        archive[at] = b'j';
        let refusal = read_zip(&archive).unwrap_err();
        assert!(refusal.contains("checksum"), "{refusal}");
    }

    /// A one-entry archive whose payload is DEFLATED (method 8), built by hand
    /// because `zip` above only ever writes stored entries. Sizes and method
    /// are written in BOTH the local header and the central directory, the
    /// way every real writer does.
    fn deflated_zip(name: &str, text: &str, method: u16) -> Vec<u8> {
        let packed = miniz_oxide::deflate::compress_to_vec(text.as_bytes(), 6);
        let crc = crc32(text.as_bytes());
        let mut out = Vec::new();
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0x21, 0]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&packed);
        let central = out.len() as u32;
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&[20, 0, 20, 0]);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0x21, 0]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0u8; 12]);
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        let central_len = out.len() as u32 - central;
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
        out.extend_from_slice(&central_len.to_le_bytes());
        out.extend_from_slice(&central.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn a_deflated_entry_is_inflated_and_its_checksum_verified() {
        // 093: pandoc, LibreOffice and Word all deflate; the stored-only reader
        // refused every real DOCX. The payload here is long enough that
        // DEFLATE actually shortens it, so a reader that copied the packed
        // bytes through would fail the size check before the CRC.
        let text = "hello ".repeat(40);
        let entries = read_zip(&deflated_zip("a", &text, 8)).unwrap();
        assert_eq!(entries, vec![("a".to_string(), text.as_bytes().to_vec())]);
    }

    #[test]
    fn a_deflated_entry_whose_bytes_were_corrupted_is_refused() {
        let text = "hello ".repeat(40);
        let mut archive = deflated_zip("a", &text, 8);
        // Somewhere inside the packed payload, after the 31-byte local header.
        archive[40] ^= 0xFF;
        let refusal = read_zip(&archive).unwrap_err();
        // Named rather than merely `is_err`: a corrupted DEFLATE stream can
        // fail two different ways -- the decoder itself rejects it, or it
        // decodes to bytes whose CRC no longer matches -- and either is the
        // refusal this test is for, but a bare `is_err` would also pass for
        // a refusal that landed here for an unrelated reason.
        assert!(
            refusal.contains("inflate") || refusal.contains("checksum"),
            "{refusal}"
        );
    }

    /// A CENTRAL DIRECTORY SIZE THAT DOES NOT MATCH WHAT THE STREAM ACTUALLY
    /// INFLATES TO -- the DEFLATE data is untouched and decodes cleanly, but
    /// the declared uncompressed size is a lie. The error must name both
    /// numbers rather than just failing.
    #[test]
    fn a_declared_size_larger_than_what_inflates_is_refused_naming_the_sizes() {
        let text = "hello ".repeat(40);
        let mut archive = deflated_zip("a", &text, 8);
        let lied_size = text.len() as u32 + 100;
        patch_central_uncompressed_size(&mut archive, lied_size);
        let refusal = read_zip(&archive).unwrap_err();
        assert!(refusal.contains(&text.len().to_string()), "{refusal}");
        assert!(refusal.contains(&lied_size.to_string()), "{refusal}");
    }

    /// A DECLARED SIZE OVER THE CAP IS REFUSED BEFORE INFLATING -- checked
    /// against the CENTRAL DIRECTORY's own claim, not against what the
    /// packed bytes actually decode to, since the whole point is refusing
    /// before that allocation is attempted.
    #[test]
    fn a_declared_size_over_the_cap_is_refused_before_inflating() {
        let text = "hello ".repeat(40);
        let mut archive = deflated_zip("a", &text, 8);
        patch_central_uncompressed_size(&mut archive, super::MAX_ENTRY_BYTES as u32 + 1);
        let refusal = read_zip(&archive).unwrap_err();
        assert!(refusal.contains(&super::MAX_ENTRY_BYTES.to_string()), "{refusal}");
    }

    /// Overwrites the CENTRAL DIRECTORY's own uncompressed-size field (at
    /// its own offset 24, `read_zip`'s own `at + 24`) -- found via the
    /// EOCD's directory offset exactly as `read_zip` itself locates it,
    /// leaving the local header and the packed bytes untouched.
    fn patch_central_uncompressed_size(archive: &mut [u8], new_size: u32) {
        let eocd = archive.len() - 22;
        let central = u32::from_le_bytes(archive[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        archive[central + 24..central + 28].copy_from_slice(&new_size.to_le_bytes());
    }

    #[test]
    fn a_method_other_than_stored_or_deflate_is_refused() {
        // Method 12 is bzip2, which no DOCX writer uses and this build does not
        // read. The refusal names the method.
        let refusal = read_zip(&deflated_zip("a", "hello", 12)).unwrap_err();
        assert!(refusal.contains("stored and deflated entries only"), "{refusal}");
        assert!(refusal.contains("method 12"), "{refusal}");
    }

    #[test]
    fn a_truncated_archive_is_refused_rather_than_half_read() {
        let archive = zip(&[Entry::text("a", "b")]);
        assert!(read_zip(&archive[..archive.len() - 4]).is_err());
    }

    // ---- the render -----------------------------------------------------

    fn chapters(rows: &[(&str, &str, i64)]) -> Vec<(String, String, i64)> {
        rows.iter()
            .map(|(i, t, d)| (i.to_string(), t.to_string(), *d))
            .collect()
    }

    fn plain<'a>(name: &'a str, runs: &'a [(String, String, i64)]) -> Book<'a> {
        Book {
            name,
            contents_title: "Contents",
            front: &[],
            chapters: runs,
            back: &[],
        }
    }

    fn bodies(rows: &[(&str, &str)]) -> HashMap<String, String> {
        rows.iter()
            .map(|(id, text)| {
                (
                    id.to_string(),
                    serde_json::json!({"type":"doc","content":[
                        {"type":"paragraph","content":[{"type":"text","text":text}]}]})
                    .to_string(),
                )
            })
            .collect()
    }

    fn input<'a>(book: &'a Book<'a>, bodies: &'a HashMap<String, String>) -> Epub<'a> {
        // Old pure-renderer fixtures have only headings and depths. Production
        // supplies typed IDs; the mixed-type test below overrides this proxy.
        let top: std::collections::HashSet<String> = book.chapters.iter()
            .filter(|row| row.2 == 0).map(|row| row.0.clone()).collect();
        Epub {
            book,
            bodies,
            book_id: None,
            font: "Crimson Text",
            style: ChapterStyle::default(),
            openings: ChapterOpenings { styled: top.clone(), page: top },
            cover: None,
            pin: None,
            modified: "2026-08-29T12:00:00Z",
            language: "en",
        }
    }

    fn entries_of(archive: &[u8]) -> Vec<(String, String)> {
        read_zip(archive)
            .unwrap()
            .into_iter()
            .map(|(n, b)| (n, String::from_utf8_lossy(&b).into_owned()))
            .collect()
    }

    fn named(archive: &[u8], name: &str) -> String {
        entries_of(archive)
            .into_iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("{name} is not in the archive"))
            .1
    }

    fn package_identifier(epub: &Epub) -> String {
        let manuscript = manuscript(epub).unwrap();
        let package = opf(&manuscript.bytes);
        package
            .split("<dc:identifier id=\"pub-id\">")
            .nth(1)
            .and_then(|rest| rest.split("</dc:identifier>").next())
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_book_identity_reaches_the_package_as_a_uuid_urn() {
        let book = plain("The Harbour", &[]);
        let bodies = bodies(&[]);
        let mut epub = input(&book, &bodies);
        epub.book_id = Some("018f8d7a-8c44-7d59-9c50-5f281752238b");
        assert_eq!(
            package_identifier(&epub),
            "urn:uuid:018f8d7a-8c44-7d59-9c50-5f281752238b"
        );
    }

    #[test]
    fn a_book_identity_survives_a_title_change_while_distinguishing_same_titles() {
        let bodies = bodies(&[]);
        let first = plain("Before", &[]);
        let renamed = plain("After", &[]);
        let same_title = plain("After", &[]);
        let mut a = input(&first, &bodies);
        a.book_id = Some("018f8d7a-8c44-7d59-9c50-5f281752238b");
        let mut b = input(&renamed, &bodies);
        b.book_id = a.book_id;
        let mut c = input(&same_title, &bodies);
        c.book_id = Some("018f8d7a-8c44-7d59-9c50-5f281752238c");
        assert_eq!(package_identifier(&a), package_identifier(&b));
        assert_ne!(package_identifier(&b), package_identifier(&c));
    }

    #[test]
    fn a_legacy_book_keeps_its_title_derived_identifier() {
        let book = plain("The Harbour", &[]);
        let bodies = bodies(&[]);
        assert_eq!(package_identifier(&input(&book, &bodies)), "book:the-harbour");
    }

    #[test]
    fn a_malformed_book_identity_refuses_the_render() {
        let book = plain("The Harbour", &[]);
        let bodies = bodies(&[]);
        let mut epub = input(&book, &bodies);
        epub.book_id = Some("not-a-uuid");
        assert!(manuscript(&epub).is_err());
    }

    #[test]
    fn every_spine_document_is_an_entry_and_every_reading_order_entry_is_in_the_spine() {
        // THE CROSS-REFERENCE, and it is what stands in for a validator this
        // machine does not have. A spine naming a document that is not in the
        // archive is an EPUB that opens to an error in every reader, and it is
        // exactly the failure a renderer acquires by growing a fifth kind of
        // document.
        let rows = chapters(&[("a", "One", 0), ("b", "Two", 0), ("c", "A scene", 1)]);
        let book = plain("My Novel", &rows);
        let archive = render(&input(&book, &bodies(&[("a", "alpha"), ("c", "gamma")])));
        let opf = named(&archive, OPF_PATH);
        let spine = spine_of(&opf);
        assert!(!spine.is_empty());
        let read = reading_order(&read_zip(&archive).unwrap());
        assert_eq!(
            spine
                .iter()
                .map(|h| format!("{OEBPS}/{h}"))
                .collect::<Vec<_>>(),
            read.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn every_manifest_item_is_an_entry_and_every_entry_but_the_container_is_in_the_manifest() {
        let rows = chapters(&[("a", "One", 0)]);
        let book = plain("My Novel", &rows);
        let archive = render(&input(&book, &bodies(&[("a", "alpha")])));
        let opf = named(&archive, OPF_PATH);
        let manifest: Vec<String> = hrefs_of(&opf, "<item ")
            .iter()
            .map(|h| format!("{OEBPS}/{h}"))
            .collect();
        let mut in_archive: Vec<String> = read_zip(&archive)
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .filter(|n| n != "mimetype" && n != CONTAINER_PATH && n != OPF_PATH)
            .collect();
        in_archive.sort();
        let mut listed = manifest.clone();
        listed.sort();
        assert_eq!(listed, in_archive);
    }

    #[test]
    fn every_contents_link_points_at_a_document_in_the_archive() {
        let rows = chapters(&[("a", "One", 0), ("c", "A scene", 1)]);
        let front = chapters(&[("d", "Dedication", 0)]);
        let book = Book {
            name: "My Novel",
            contents_title: "Contents",
            front: &front,
            chapters: &rows,
            back: &[],
        };
        let archive = render(&input(&book, &bodies(&[])));
        let nav = named(&archive, &format!("{OEBPS}/{NAV_HREF}"));
        let names: Vec<String> = read_zip(&archive)
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        let links = hrefs_of(&nav, "<a ");
        // The title page and three headings.
        assert_eq!(links.len(), 4);
        for link in links {
            let (file, fragment) = link.split_once('#').unwrap_or((link.as_str(), ""));
            let path = format!("{OEBPS}/{TEXT_DIR}/{file}");
            assert!(names.contains(&path), "{path} is not in the archive");
            if !fragment.is_empty() {
                assert!(
                    named(&archive, &path).contains(&format!("id=\"{fragment}\"")),
                    "{path} has no {fragment}"
                );
            }
        }
    }

    #[test]
    fn a_book_with_no_items_is_its_title_page_and_a_contents_naming_it() {
        // 041's rule -- a heading over nothing is a section the writer did not
        // ask for -- met in a format whose package MUST carry a navigation
        // document. So the contents is not empty and is not invented either: it
        // names the one thing the book has, in the writer's own words.
        let book = plain("My Novel", &[]);
        let archive = render(&input(&book, &bodies(&[])));
        let nav = named(&archive, &format!("{OEBPS}/{NAV_HREF}"));
        assert_eq!(hrefs_of(&nav, "<a "), vec![TITLE_HREF.to_string()]);
        assert!(nav.contains("My Novel"));
        assert_eq!(reading_order(&read_zip(&archive).unwrap()).len(), 2);
    }

    #[test]
    fn one_document_per_top_level_item_and_its_descendants_are_inside_it() {
        let rows = chapters(&[
            ("a", "One", 0),
            ("b", "First scene", 1),
            ("c", "Second scene", 1),
            ("d", "Two", 0),
        ]);
        let book = plain("N", &rows);
        let archive = render(&input(&book, &bodies(&[])));
        let read = reading_order(&read_zip(&archive).unwrap());
        // Title, contents, and two chapters.
        assert_eq!(read.len(), 4);
        let first = &read[2].1;
        assert!(
            first.contains("One")
                && first.contains("First scene")
                && first.contains("Second scene")
        );
        assert!(!first.contains("Two"));
    }

    #[test]
    fn the_reading_order_takes_only_what_is_under_the_text_directory() {
        // FOUND BY MUTATION, and it is the `import_name_ok` shape avoided rather
        // than repeated. Every `.xhtml` this build writes IS under `OEBPS/text/`,
        // so no RENDERED archive can tell the prefix test from its absence --
        // and the prefix is the whole reason the preview needs no XML parser.
        // Kept and made REACHABLE, by testing the function's contract over an
        // archive this build would not write, rather than deleted: the rule is
        // what a later slice adding a document outside `text/` has to obey, and
        // this is what tells it.
        let entries: Vec<(String, Vec<u8>)> = [
            "OEBPS/content.opf",
            "OEBPS/notes.xhtml",
            "OEBPS/text/0001.xhtml",
            "OEBPS/text/cover.png",
        ]
        .into_iter()
        .map(|n| (n.to_string(), Vec::new()))
        .collect();
        assert_eq!(
            reading_order(&entries)
                .into_iter()
                .map(|(n, _)| n)
                .collect::<Vec<_>>(),
            vec!["OEBPS/text/0001.xhtml".to_string()]
        );
    }

    #[test]
    fn the_prose_carries_its_emphasis_and_the_underline_is_not_dropped() {
        // THE ONE THING THIS FORMAT DOES THAT MARKDOWN CANNOT. `export.rs`
        // counts underlined runs precisely because Markdown has no underline;
        // XHTML has one, so nothing is lost and the count is nought. A build
        // that reported a loss here would tell a writer something untrue about
        // a file that carries their emphasis perfectly.
        let rows = chapters(&[("a", "One", 0)]);
        let book = plain("N", &rows);
        let mut b = HashMap::new();
        b.insert(
            "a".to_string(),
            serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"plain "},
                {"type":"text","text":"em","marks":[{"type":"em"}]},
                {"type":"text","text":"under","marks":[{"type":"underline"}]},
                {"type":"text","text":"both","marks":[{"type":"strong"},{"type":"em"}]}
            ]}]})
            .to_string(),
        );
        let archive = render(&input(&book, &b));
        let doc = &reading_order(&read_zip(&archive).unwrap())[2].1;
        assert!(doc.contains("<em>em</em>"), "{doc}");
        assert!(
            doc.contains(&format!("<span class=\"{UNDERLINE_CLASS}\">under</span>")),
            "{doc}"
        );
        assert!(doc.contains("<strong><em>both</em></strong>"), "{doc}");
    }

    #[test]
    fn a_title_a_reader_typed_cannot_open_a_tag() {
        let rows = chapters(&[("a", "<b>&amp; \"quoted\"", 0)]);
        let book = plain("N & <them>", &rows);
        let archive = render(&input(&book, &bodies(&[("a", "5 < 6 & 7 > 2")])));
        for (name, text) in entries_of(&archive) {
            if !name.ends_with(".xhtml") && !name.ends_with(".opf") {
                continue;
            }
            assert!(
                !text.contains("<b>"),
                "{name} carries a tag the writer typed"
            );
            assert!(!text.contains("& 7"), "{name} carries a bare ampersand");
        }
        let doc = &reading_order(&read_zip(&archive).unwrap())[2].1;
        assert!(
            doc.contains("&lt;b&gt;&amp;amp; &quot;quoted&quot;"),
            "{doc}"
        );
    }

    #[test]
    fn the_four_options_are_absent_from_the_stylesheet_until_they_are_chosen() {
        // WHAT AN ABSENT OPTION MEANS, asserted rather than described: the
        // plainest book carries no rule for any of the three CSS options and no
        // ornament at all.
        let rows = chapters(&[("a", "One", 0), ("b", "A scene", 1)]);
        let book = plain("N", &rows);
        let archive = render(&input(&book, &bodies(&[("a", "alpha")])));
        let css = named(&archive, &format!("{OEBPS}/{CSS_HREF}"));
        assert!(!css.contains("break-before"));
        assert!(!css.contains("text-transform"));
        assert!(!css.contains("first-letter"));
        assert!(
            !named(&archive, &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml")).contains(ORNAMENT_CLASS)
        );
    }

    #[test]
    fn each_option_writes_exactly_its_own_rule() {
        let rows = chapters(&[("a", "One", 0), ("b", "A scene", 1)]);
        let book = plain("N", &rows);
        let bodies = bodies(&[("a", "alpha")]);
        let with = |style: ChapterStyle| {
            let mut e = input(&book, &bodies);
            e.style = style;
            render(&e)
        };

        let paged = with(ChapterStyle {
            new_page: true,
            ..ChapterStyle::default()
        });
        let css = named(&paged, &format!("{OEBPS}/{CSS_HREF}"));
        assert!(css.contains("break-before"));
        assert!(!css.contains("text-transform") && !css.contains("first-letter"));

        let caps = with(ChapterStyle {
            caps_title: true,
            ..ChapterStyle::default()
        });
        let css = named(&caps, &format!("{OEBPS}/{CSS_HREF}"));
        assert!(css.contains("text-transform"));
        assert!(!css.contains("break-before") && !css.contains("first-letter"));

        let drop = with(ChapterStyle {
            drop_cap: true,
            ..ChapterStyle::default()
        });
        let css = named(&drop, &format!("{OEBPS}/{CSS_HREF}"));
        assert!(css.contains("first-letter"));
        assert!(!css.contains("break-before") && !css.contains("text-transform"));

        let glyph = with(ChapterStyle {
            glyph: Some("asterism".to_string()),
            ..ChapterStyle::default()
        });
        let doc = named(&glyph, &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"));
        assert!(
            doc.contains(ORNAMENT_CLASS) && doc.contains("\u{2042}"),
            "{doc}"
        );
    }

    #[test]
    fn drop_cap_follows_empty_containers_to_the_first_prose() {
        let rows = chapters(&[
            ("part", "Part", 0),
            ("empty", "Empty", 1),
            ("scene", "Scene", 2),
            ("later", "Later", 1),
            ("next", "Next", 0),
        ]);
        let book = plain("N", &rows);
        let mut bodies = HashMap::new();
        for (id, text) in [("scene", "first"), ("later", "later"), ("next", "next")] {
            bodies.insert(
                id.to_string(),
                serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[{"type":"text","text":text}]}]})
                .to_string(),
            );
        }
        let archive = render(&input(&book, &bodies));
        let html = named(&archive, &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"));
        let next = named(&archive, &format!("{OEBPS}/{TEXT_DIR}/0002.xhtml"));
        assert!(next.contains("<p class=\"opening\">next</p>"), "{next}");
        assert!(html.contains("<p class=\"opening\">first</p>"), "{html}");
        assert!(html.contains("<p>later</p>"), "{html}");
    }

    #[test]
    fn the_paragraph_a_chapter_opens_with_is_marked_and_the_others_are_not() {
        // FOUND BY MUTATION. The drop cap is a stylesheet rule on
        // `.opening::first-letter`, and the CLASS is what says which paragraph
        // it is about -- so deleting the class left the option with nothing to
        // select and every assertion in this file still passed, because they
        // all read the STYLESHEET.
        let rows = chapters(&[("a", "One", 0)]);
        let book = plain("N", &rows);
        let mut b = HashMap::new();
        b.insert(
            "a".to_string(),
            serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[{"type":"text","text":"first"}]},
                {"type":"paragraph","content":[{"type":"text","text":"second"}]}]})
            .to_string(),
        );
        let doc = named(
            &render(&input(&book, &b)),
            &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"),
        );
        assert!(
            doc.contains(&format!("<p class=\"{OPENING_CLASS}\">first</p>")),
            "{doc}"
        );
        assert!(doc.contains("<p>second</p>"), "{doc}");
        assert_eq!(doc.matches(OPENING_CLASS).count(), 1, "{doc}");
    }

    #[test]
    fn a_scene_heading_never_asks_for_a_page_break() {
        // FOUND BY MUTATION. A reading system already begins every spine
        // document on a new page, so a break before its first heading leaves a
        // BLANK PAGE in front of every chapter -- and nothing in the suite could
        // tell the two apart, because every test here asked only whether the
        // class was present SOMEWHERE.
        let rows = chapters(&[("a", "One", 0), ("b", "A scene", 1)]);
        let book = plain("N", &rows);
        let doc = named(
            &render(&input(&book, &bodies(&[]))),
            &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"),
        );
        assert_eq!(doc.matches(START_CLASS).count(), 0, "{doc}");
        let first = doc.find("<h2").expect("the chapter heading");
        let second = doc.find("<h3").expect("the scene heading");
        assert!(!doc[first..second].contains(START_CLASS), "{doc}");
    }

    #[test]
    fn a_nested_typed_chapter_can_start_a_page_without_decorating_a_part() {
        let rows = chapters(&[("part", "Part", 0), ("chapter", "Chapter", 1), ("scene", "Scene", 2)]);
        let book = plain("N", &rows);
        let body = bodies(&[("scene", "first")]);
        let mut e = input(&book, &body);
        e.openings = ChapterOpenings {
            styled: ["chapter".to_string()].into(),
            page: ["part".to_string(), "chapter".to_string()].into(),
        };
        e.style = ChapterStyle {
            glyph: Some("diamond".to_string()),
            drop_cap: true,
            new_page: true,
            caps_title: true,
        };
        let archive = render(&e);
        let doc = named(&archive, &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"));
        let css = named(&archive, &format!("{OEBPS}/{CSS_HREF}"));
        assert_eq!(doc.matches(ORNAMENT_CLASS).count(), 1, "{doc}");
        assert!(doc.contains("<h3 id=\"h2\" class=\"start book-body-heading\">Chapter</h3>"), "{doc}");
        assert!(doc.contains("<p class=\"opening\">first</p>"), "{doc}");
        assert!(css.contains(".book-body-heading { text-transform"), "{css}");
        assert!(!css.contains("h1, h2, h3, h4, h5, h6 { text-transform"), "{css}");
    }

    #[test]
    fn the_ornament_marks_a_chapter_and_not_every_heading_under_it() {
        let rows = chapters(&[("a", "One", 0), ("b", "A scene", 1)]);
        let book = plain("N", &rows);
        let bodies = bodies(&[]);
        let mut e = input(&book, &bodies);
        e.style = ChapterStyle {
            glyph: Some("diamond".to_string()),
            ..ChapterStyle::default()
        };
        let doc = named(&render(&e), &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"));
        assert_eq!(doc.matches(ORNAMENT_CLASS).count(), 1, "{doc}");
    }

    #[test]
    fn the_font_the_writer_chose_is_named_with_a_fallback_behind_it() {
        // 040 recorded that this application ships no font files, so what is
        // stored is a NAME and 043 owes a generic fallback. This is it: the
        // writer's face first, then a stack every reading system has.
        let book = plain("N", &[]);
        let bodies = bodies(&[]);
        let mut e = input(&book, &bodies);
        e.font = "EB Garamond";
        let css = named(&render(&e), &format!("{OEBPS}/{CSS_HREF}"));
        assert!(css.contains("\"EB Garamond\", Georgia"), "{css}");
    }

    #[test]
    fn a_font_name_carrying_a_quote_cannot_end_the_declaration() {
        let book = plain("N", &[]);
        let bodies = bodies(&[]);
        let mut e = input(&book, &bodies);
        e.font = "Ye \"Olde\" Face";
        let css = named(&render(&e), &format!("{OEBPS}/{CSS_HREF}"));
        assert!(css.contains("\"Ye \\\"Olde\\\" Face\""), "{css}");
    }

    #[test]
    fn a_front_cover_is_the_first_document_and_is_declared_as_the_cover_image() {
        let book = plain("N", &[]);
        let bodies = bodies(&[]);
        let mut e = input(&book, &bodies);
        e.cover = Some(Cover {
            bytes: vec![1, 2, 3],
            media_type: "image/png",
            extension: "png",
        });
        let archive = render(&e);
        let read = read_zip(&archive).unwrap();
        assert_eq!(
            reading_order(&read)[0].0,
            format!("{OEBPS}/{TEXT_DIR}/{COVER_HREF}")
        );
        let opf = named(&archive, OPF_PATH);
        assert!(opf.contains("properties=\"cover-image\""), "{opf}");
        assert_eq!(
            read.iter()
                .find(|(n, _)| n == &format!("{OEBPS}/cover.png"))
                .map(|(_, b)| b.clone()),
            Some(vec![1, 2, 3])
        );
    }

    #[test]
    fn a_book_with_no_cover_declares_none_and_carries_no_image() {
        let book = plain("N", &[]);
        let archive = render(&input(&book, &bodies(&[])));
        let opf = named(&archive, OPF_PATH);
        assert!(!opf.contains("cover-image"));
        assert!(read_zip(&archive)
            .unwrap()
            .iter()
            .all(|(n, _)| !n.contains("cover")));
    }

    #[test]
    fn the_three_runs_carry_the_epub_types_that_say_which_they_are() {
        let front = chapters(&[("d", "Dedication", 0)]);
        let body = chapters(&[("a", "One", 0)]);
        let back = chapters(&[("z", "Afterword", 0)]);
        let book = Book {
            name: "N",
            contents_title: "Contents",
            front: &front,
            chapters: &body,
            back: &back,
        };
        let no_bodies = bodies(&[]);
        let mut e = input(&book, &no_bodies);
        e.style.glyph = Some("diamond".to_string());
        let archive = render(&e);
        let read = reading_order(&read_zip(&archive).unwrap());
        // Title, contents, then the three runs in order.
        assert!(
            read[2].1.contains("epub:type=\"frontmatter\""),
            "{}",
            read[2].1
        );
        assert!(
            read[3].1.contains("epub:type=\"bodymatter\""),
            "{}",
            read[3].1
        );
        assert!(
            read[4].1.contains("epub:type=\"backmatter\""),
            "{}",
            read[4].1
        );
        assert!(!read[2].1.contains(ORNAMENT_CLASS), "{}", read[2].1);
        assert!(read[3].1.contains(ORNAMENT_CLASS), "{}", read[3].1);
        assert!(!read[4].1.contains(ORNAMENT_CLASS), "{}", read[4].1);
    }

    #[test]
    fn an_item_whose_body_this_build_cannot_read_still_gets_its_heading() {
        // `export::manuscript`'s rule, restated in this format because losing a
        // chapter silently is the worst thing either renderer can do.
        let rows = chapters(&[("a", "One", 0)]);
        let book = plain("N", &rows);
        let mut b = HashMap::new();
        b.insert("a".to_string(), "{not json at all".to_string());
        let doc = named(
            &render(&input(&book, &b)),
            &format!("{OEBPS}/{TEXT_DIR}/0001.xhtml"),
        );
        assert!(doc.contains("One"), "{doc}");
    }

    #[test]
    fn the_container_points_at_the_package_document() {
        let book = plain("N", &[]);
        let archive = render(&input(&book, &bodies(&[])));
        assert!(named(&archive, CONTAINER_PATH).contains(OPF_PATH));
    }

    #[test]
    fn the_modification_time_is_the_one_the_caller_was_given() {
        let book = plain("N", &[]);
        let archive = render(&input(&book, &bodies(&[])));
        assert!(named(&archive, OPF_PATH).contains("2026-08-29T12:00:00Z"));
    }

    #[test]
    fn iso8601_is_the_civil_date_at_every_month_boundary_of_six_years() {
        // FOUND BY MUTATION. Four instants cannot tell `(5 * doy + 2) / 153`
        // from `(5 * doy + 1) / 153`: the month arithmetic is a piecewise line
        // and a handful of points lands between its steps. Both ends of every
        // month of six years -- two of them leap, one of them the 1900-style
        // century rule, one past the signed-32-bit boundary -- is what actually
        // walks it. The table is computed OUTSIDE this program and pasted, which
        // is the rule the fixtures follow: a reference built from the code under
        // test checks it against itself.
        for (seconds, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (2678399, "1970-01-31T23:59:59Z"),
            (2678400, "1970-02-01T00:00:00Z"),
            (5097599, "1970-02-28T23:59:59Z"),
            (5097600, "1970-03-01T00:00:00Z"),
            (7775999, "1970-03-31T23:59:59Z"),
            (7776000, "1970-04-01T00:00:00Z"),
            (10367999, "1970-04-30T23:59:59Z"),
            (10368000, "1970-05-01T00:00:00Z"),
            (13046399, "1970-05-31T23:59:59Z"),
            (13046400, "1970-06-01T00:00:00Z"),
            (15638399, "1970-06-30T23:59:59Z"),
            (15638400, "1970-07-01T00:00:00Z"),
            (18316799, "1970-07-31T23:59:59Z"),
            (18316800, "1970-08-01T00:00:00Z"),
            (20995199, "1970-08-31T23:59:59Z"),
            (20995200, "1970-09-01T00:00:00Z"),
            (23587199, "1970-09-30T23:59:59Z"),
            (23587200, "1970-10-01T00:00:00Z"),
            (26265599, "1970-10-31T23:59:59Z"),
            (26265600, "1970-11-01T00:00:00Z"),
            (28857599, "1970-11-30T23:59:59Z"),
            (28857600, "1970-12-01T00:00:00Z"),
            (31535999, "1970-12-31T23:59:59Z"),
            (915148800, "1999-01-01T00:00:00Z"),
            (917827199, "1999-01-31T23:59:59Z"),
            (917827200, "1999-02-01T00:00:00Z"),
            (920246399, "1999-02-28T23:59:59Z"),
            (920246400, "1999-03-01T00:00:00Z"),
            (922924799, "1999-03-31T23:59:59Z"),
            (922924800, "1999-04-01T00:00:00Z"),
            (925516799, "1999-04-30T23:59:59Z"),
            (925516800, "1999-05-01T00:00:00Z"),
            (928195199, "1999-05-31T23:59:59Z"),
            (928195200, "1999-06-01T00:00:00Z"),
            (930787199, "1999-06-30T23:59:59Z"),
            (930787200, "1999-07-01T00:00:00Z"),
            (933465599, "1999-07-31T23:59:59Z"),
            (933465600, "1999-08-01T00:00:00Z"),
            (936143999, "1999-08-31T23:59:59Z"),
            (936144000, "1999-09-01T00:00:00Z"),
            (938735999, "1999-09-30T23:59:59Z"),
            (938736000, "1999-10-01T00:00:00Z"),
            (941414399, "1999-10-31T23:59:59Z"),
            (941414400, "1999-11-01T00:00:00Z"),
            (944006399, "1999-11-30T23:59:59Z"),
            (944006400, "1999-12-01T00:00:00Z"),
            (946684799, "1999-12-31T23:59:59Z"),
            (946684800, "2000-01-01T00:00:00Z"),
            (949363199, "2000-01-31T23:59:59Z"),
            (949363200, "2000-02-01T00:00:00Z"),
            (951868799, "2000-02-29T23:59:59Z"),
            (951868800, "2000-03-01T00:00:00Z"),
            (954547199, "2000-03-31T23:59:59Z"),
            (954547200, "2000-04-01T00:00:00Z"),
            (957139199, "2000-04-30T23:59:59Z"),
            (957139200, "2000-05-01T00:00:00Z"),
            (959817599, "2000-05-31T23:59:59Z"),
            (959817600, "2000-06-01T00:00:00Z"),
            (962409599, "2000-06-30T23:59:59Z"),
            (962409600, "2000-07-01T00:00:00Z"),
            (965087999, "2000-07-31T23:59:59Z"),
            (965088000, "2000-08-01T00:00:00Z"),
            (967766399, "2000-08-31T23:59:59Z"),
            (967766400, "2000-09-01T00:00:00Z"),
            (970358399, "2000-09-30T23:59:59Z"),
            (970358400, "2000-10-01T00:00:00Z"),
            (973036799, "2000-10-31T23:59:59Z"),
            (973036800, "2000-11-01T00:00:00Z"),
            (975628799, "2000-11-30T23:59:59Z"),
            (975628800, "2000-12-01T00:00:00Z"),
            (978307199, "2000-12-31T23:59:59Z"),
            (1704067200, "2024-01-01T00:00:00Z"),
            (1706745599, "2024-01-31T23:59:59Z"),
            (1706745600, "2024-02-01T00:00:00Z"),
            (1709251199, "2024-02-29T23:59:59Z"),
            (1709251200, "2024-03-01T00:00:00Z"),
            (1711929599, "2024-03-31T23:59:59Z"),
            (1711929600, "2024-04-01T00:00:00Z"),
            (1714521599, "2024-04-30T23:59:59Z"),
            (1714521600, "2024-05-01T00:00:00Z"),
            (1717199999, "2024-05-31T23:59:59Z"),
            (1717200000, "2024-06-01T00:00:00Z"),
            (1719791999, "2024-06-30T23:59:59Z"),
            (1719792000, "2024-07-01T00:00:00Z"),
            (1722470399, "2024-07-31T23:59:59Z"),
            (1722470400, "2024-08-01T00:00:00Z"),
            (1725148799, "2024-08-31T23:59:59Z"),
            (1725148800, "2024-09-01T00:00:00Z"),
            (1727740799, "2024-09-30T23:59:59Z"),
            (1727740800, "2024-10-01T00:00:00Z"),
            (1730419199, "2024-10-31T23:59:59Z"),
            (1730419200, "2024-11-01T00:00:00Z"),
            (1733011199, "2024-11-30T23:59:59Z"),
            (1733011200, "2024-12-01T00:00:00Z"),
            (1735689599, "2024-12-31T23:59:59Z"),
            (1767225600, "2026-01-01T00:00:00Z"),
            (1769903999, "2026-01-31T23:59:59Z"),
            (1769904000, "2026-02-01T00:00:00Z"),
            (1772323199, "2026-02-28T23:59:59Z"),
            (1772323200, "2026-03-01T00:00:00Z"),
            (1775001599, "2026-03-31T23:59:59Z"),
            (1775001600, "2026-04-01T00:00:00Z"),
            (1777593599, "2026-04-30T23:59:59Z"),
            (1777593600, "2026-05-01T00:00:00Z"),
            (1780271999, "2026-05-31T23:59:59Z"),
            (1780272000, "2026-06-01T00:00:00Z"),
            (1782863999, "2026-06-30T23:59:59Z"),
            (1782864000, "2026-07-01T00:00:00Z"),
            (1785542399, "2026-07-31T23:59:59Z"),
            (1785542400, "2026-08-01T00:00:00Z"),
            (1788220799, "2026-08-31T23:59:59Z"),
            (1788220800, "2026-09-01T00:00:00Z"),
            (1790812799, "2026-09-30T23:59:59Z"),
            (1790812800, "2026-10-01T00:00:00Z"),
            (1793491199, "2026-10-31T23:59:59Z"),
            (1793491200, "2026-11-01T00:00:00Z"),
            (1796083199, "2026-11-30T23:59:59Z"),
            (1796083200, "2026-12-01T00:00:00Z"),
            (1798761599, "2026-12-31T23:59:59Z"),
            (2145916800, "2038-01-01T00:00:00Z"),
            (2148595199, "2038-01-31T23:59:59Z"),
            (2148595200, "2038-02-01T00:00:00Z"),
            (2151014399, "2038-02-28T23:59:59Z"),
            (2151014400, "2038-03-01T00:00:00Z"),
            (2153692799, "2038-03-31T23:59:59Z"),
            (2153692800, "2038-04-01T00:00:00Z"),
            (2156284799, "2038-04-30T23:59:59Z"),
            (2156284800, "2038-05-01T00:00:00Z"),
            (2158963199, "2038-05-31T23:59:59Z"),
            (2158963200, "2038-06-01T00:00:00Z"),
            (2161555199, "2038-06-30T23:59:59Z"),
            (2161555200, "2038-07-01T00:00:00Z"),
            (2164233599, "2038-07-31T23:59:59Z"),
            (2164233600, "2038-08-01T00:00:00Z"),
            (2166911999, "2038-08-31T23:59:59Z"),
            (2166912000, "2038-09-01T00:00:00Z"),
            (2169503999, "2038-09-30T23:59:59Z"),
            (2169504000, "2038-10-01T00:00:00Z"),
            (2172182399, "2038-10-31T23:59:59Z"),
            (2172182400, "2038-11-01T00:00:00Z"),
            (2174774399, "2038-11-30T23:59:59Z"),
            (2174774400, "2038-12-01T00:00:00Z"),
            (2177452799, "2038-12-31T23:59:59Z"),
        ] {
            assert_eq!(iso8601_utc(seconds), expected, "at {seconds}");
        }
    }

    #[test]
    fn iso8601_is_the_civil_date_of_the_second_it_was_given() {
        // Three published epochs: the epoch itself, a leap day, and a date past
        // the 2038 signed-32-bit boundary this arithmetic must not care about.
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601_utc(2_147_483_647), "2038-01-19T03:14:07Z");
        assert_eq!(iso8601_utc(1_756_468_800), "2025-08-29T12:00:00Z");
    }

    /// The `href` of every element in `opf` opening with `tag`, in order. A
    /// substring scan and NOT an XML parser, deliberately: a test that used the
    /// renderer's own idea of the document would agree with a wrong one.
    fn hrefs_of(text: &str, tag: &str) -> Vec<String> {
        let mut out = Vec::new();
        for piece in text.split(tag).skip(1) {
            if let Some(rest) = piece.split_once("href=\"") {
                if let Some((href, _)) = rest.1.split_once('"') {
                    out.push(href.to_string());
                }
            }
        }
        out
    }

    /// The spine's documents, as hrefs, resolved through the manifest.
    fn spine_of(opf: &str) -> Vec<String> {
        let manifest: Vec<(String, String)> = opf
            .split("<item ")
            .skip(1)
            .filter_map(|piece| {
                let id = piece.split_once("id=\"")?.1.split_once('"')?.0.to_string();
                let href = piece
                    .split_once("href=\"")?
                    .1
                    .split_once('"')?
                    .0
                    .to_string();
                Some((id, href))
            })
            .collect();
        opf.split("<itemref ")
            .skip(1)
            .filter_map(|piece| {
                let idref = piece.split_once("idref=\"")?.1.split_once('"')?.0;
                manifest
                    .iter()
                    .find(|(id, _)| id == idref)
                    .map(|(_, href)| href.clone())
            })
            .collect()
    }

    #[test]
    fn the_contents_nests_a_deeper_entry_inside_the_one_above_it() {
        // THE NAV'S SHAPE, and it needed its own test because every assertion
        // about links passes against a list whose nesting is wrong: an `<a>`
        // outside any `<li>` still has an href, and an empty `<li>` still
        // counts as nothing. The first render of this file produced both and
        // the link tests were green. Structure, not membership.
        let rows = chapters(&[
            ("a", "One", 0),
            ("b", "A scene", 1),
            ("c", "Two", 0),
            ("d", "Another", 1),
        ]);
        let book = plain("N", &rows);
        let archive = render(&input(&book, &bodies(&[])));
        let nav = named(&archive, &format!("{OEBPS}/{NAV_HREF}"));
        let list = nav.split("<ol>").skip(1).collect::<Vec<_>>().join("<ol>");
        let list = format!("<ol>{}", list);
        let list = list.split("</nav>").next().unwrap().replace('\n', "");
        assert_eq!(
            list,
            "<ol><li><a href=\"title.xhtml\">N</a></li>\
             <li><a href=\"0001.xhtml#h1\">One</a>\
             <ol><li><a href=\"0001.xhtml#h2\">A scene</a></li></ol></li>\
             <li><a href=\"0002.xhtml#h3\">Two</a>\
             <ol><li><a href=\"0002.xhtml#h4\">Another</a></li></ol></li></ol>"
        );
    }

    #[test]
    fn the_contents_carries_no_empty_item_at_any_depth() {
        // The control for the test above, over a book that jumps two levels at
        // once and comes back. An intermediate item with no link of its own is
        // legal and is what a jump produces; an item with NOTHING in it is the
        // defect.
        let rows = chapters(&[("a", "One", 0), ("b", "Deep", 2), ("c", "Two", 0)]);
        let book = plain("N", &rows);
        let archive = render(&input(&book, &bodies(&[])));
        let nav = named(&archive, &format!("{OEBPS}/{NAV_HREF}")).replace('\n', "");
        assert!(!nav.contains("<li></li>"), "{nav}");
    }

    #[test]
    fn the_stylesheet_carries_no_at_rule_at_any_setting() {
        // THE PAGE'S HALF OF THIS RULE IS `scopeStylesheet`, which REFUSES an
        // at-rule rather than mangling one: `@media` and `@font-face` do not
        // survive a blind prefix. Two statements in two programs, which is this
        // repo's recorded shape for a rule that has to hold on both sides -- and
        // this is the one that fails if a later slice reaches for `@media print`
        // here without going and looking at the rail.
        for style in [
            ChapterStyle::default(),
            ChapterStyle {
                glyph: Some("fleuron".to_string()),
                new_page: true,
                caps_title: true,
                drop_cap: true,
            },
        ] {
            assert!(!stylesheet("Crimson Text", &style).contains('@'));
        }
    }

    #[test]
    fn a_legacy_font_name_cannot_break_epub_preview_scoping() {
        let encoded = css_string("x</style>{}@;");
        assert_eq!(encoded, "\"x\\3c /style\\3e \\7b \\7d \\40 \\3b \"");
        let css = stylesheet("x</style>{}@;", &ChapterStyle::default());
        assert!(!css.contains("</style>"), "{css}");
        assert!(!css.contains('@'), "{css}");
    }

    #[test]
    fn a_contents_link_is_set_as_book_text_and_not_as_a_web_link() {
        // FOUND BY LOOKING AT A CAPTURE, and by nothing else. Without this the
        // generated contents renders in the reading system's default link ink
        // -- blue and underlined -- and a book's own table of contents reads as
        // a web page. Every reading system applies the same defaults, so this
        // is about the FILE and not about the rail.
        let archive = render(&input(&plain("N", &[]), &bodies(&[])));
        let css = named(&archive, &format!("{OEBPS}/{CSS_HREF}"));
        assert!(
            css.contains("a { color: inherit; text-decoration: none; }"),
            "{css}"
        );
    }

    fn pinned() -> crate::identity::Pin {
        let mut source = crate::identity::Identity {
            id: "i1".into(),
            rev: 1,
            ..crate::identity::Identity::default()
        };
        source.public.name = "Ada Vane".into();
        source.public.sort_name = "Vane, Ada".into();
        source.publishing.imprint = "Vane Press".into();
        source.publishing.rights = "(c) Ada Vane".into();
        source.private.legal_name = "Margaret Hollis".into();
        crate::identity::pin_of(&source, 10)
    }

    fn opf(bytes: &[u8]) -> String {
        let entries = read_zip(bytes).unwrap();
        let (_, body) = entries.iter().find(|(n, _)| n == OPF_PATH).unwrap();
        String::from_utf8(body.clone()).unwrap()
    }

    #[test]
    fn every_field_the_table_names_is_actually_emitted_into_the_package_document() {
        // THE ONE-TABLE RULE, ASSERTED RATHER THAN ASSERTED-ABOUT. The
        // disclosure check prints `identity::disclosed`; this asserts the writer
        // emits every row of it. A row added to `EPUB_FIELDS` without an arm in
        // `identity_metadata` fails HERE, which is the only thing that stops the
        // check becoming a list of promises.
        let book = Book {
            name: "The Harbour",
            contents_title: "Contents",
            front: &[],
            chapters: &[],
            back: &[],
        };
        let bodies = HashMap::new();
        let pin = pinned();
        let mut epub = input(&book, &bodies);
        epub.pin = Some(&pin);
        let text = opf(&render(&epub));
        for (at, value) in crate::identity::disclosed(crate::export::Format::Epub, Some(&pin)) {
            assert!(text.contains(value), "{at} carries no value: {text}");
            let element = match at {
                "file-as" => "property=\"file-as\"".to_string(),
                other => format!("<{other}"),
            };
            assert!(text.contains(&element), "{at} is not emitted: {text}");
        }
        // The refinement points at the creator it refines, or a reading system
        // attaches the sort name to nothing.
        assert!(text.contains("<dc:creator id=\"creator\">Ada Vane</dc:creator>"), "{text}");
        assert!(text.contains("refines=\"#creator\""), "{text}");
        // And the private tier cannot arrive here, because a `Pin` has no field
        // for it. A positive control on the same string keeps this from passing
        // over an empty document.
        assert!(!text.contains("Margaret Hollis"), "{text}");
        assert!(text.contains("The Harbour"), "{text}");
    }

    #[test]
    fn a_book_with_no_pin_writes_no_identity_metadata_at_all() {
        // Every project in every library today. The package document must be
        // exactly what it was before this slice, or the graded EPUB evidence is
        // about a file nobody had.
        let book = Book {
            name: "The Harbour",
            contents_title: "Contents",
            front: &[],
            chapters: &[],
            back: &[],
        };
        let bodies = HashMap::new();
        let text = opf(&render(&input(&book, &bodies)));
        for absent in ["dc:creator", "dc:publisher", "dc:rights", "file-as"] {
            assert!(!text.contains(absent), "{absent} appeared: {text}");
        }
    }

    #[test]
    fn a_name_with_markup_in_it_is_escaped_into_the_package_document() {
        // A pen name is the writer's own text and the package document is XML.
        let book = Book {
            name: "The Harbour",
            contents_title: "Contents",
            front: &[],
            chapters: &[],
            back: &[],
        };
        let bodies = HashMap::new();
        let mut pin = pinned();
        pin.public.name = "A & <B>".into();
        pin.public.sort_name = String::new();
        let mut epub = input(&book, &bodies);
        epub.pin = Some(&pin);
        let text = opf(&render(&epub));
        assert!(text.contains("A &amp; &lt;B&gt;"), "{text}");
        assert!(!text.contains("<B>"), "{text}");
    }
}
