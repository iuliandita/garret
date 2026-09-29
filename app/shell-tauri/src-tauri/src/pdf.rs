// app/shell-tauri/src-tauri/src/pdf.rs
// THE PROOF DOCUMENT: the book as one HTML page that knows how to cut itself
// into leaves, and the reader that counts the leaves back out of the PDF.
//
// WHAT THIS IS FOR, said before anything else. A PROOF COPY -- the readable
// copy a novelist sends a beta reader. Not production print: no bleed, no
// imposition, no spreads, no CMYK, no retailer package. The alpha exclusion was
// amended for the writer-facing half of that and for nothing else, and every
// decision below is inside that line.
//
// PURE, exactly as `epub.rs` and `export.rs` are: no I/O, no `Store`, no
// `Path`, no GTK. What this module produces is a STRING. Turning that string
// into PDF bytes is `printer.rs`'s job and it is the only part of this feature
// that needs a display.
//
// WHY AN HTML STRING RATHER THAN PDF OPERATORS. The publishing track's design
// record (section (d)) says to try `webkit2gtk::PrintOperation` before adding a
// PDF crate, because WebKitGTK is already a direct dependency and nothing else
// in the lock rasterizes text. It was tried, headlessly, before a line of this
// was written, and it works. The consequence for this module is the whole
// of its shape: laying a book out means breaking lines, which means font
// metrics, which means the only thing in this build that owns any is the web
// engine.
//
// AND THE PAGINATION IS OURS, WHICH IS NOT THE SAME THING. WebKitGTK's own
// paged-media implementation IGNORES `@page` margin boxes -- probed directly,
// `@top-center`/`@bottom-center` with `counter(page)` produce nothing at all --
// so a book paginated by the engine can carry no folio and no running head. A
// proof copy a beta reader cannot cite a page of is not a proof copy. So the
// script below cuts the flow into page-sized boxes itself, and the engine's
// paginator then has one box per sheet and nothing left to decide. Measured:
// 21 boxes in, 21 PDF pages out, folios 1..21, a running head on every one.
//
// ONE SCRIPT, TWO CONSUMERS, WHICH IS HOW THE PREVIEW AND THE FILE AGREE. The
// same document, with the same script, is loaded into the same engine for the
// preview and for the save; the preview is the paginated DOM read back out of
// that run. It is 043's unzip in another costume: the rail paints the leaves
// the printer was handed, not a second opinion about where they fall.

use crate::design::{glyph_ornament, BookDesign, ChapterStyle};
use crate::epub::{css_string, xml_escape};
use crate::export::{Book, ChapterOpenings};
use std::collections::HashMap;

/// A block of the flow that is a LEAF rather than prose, and which kind.
/// `plate` is a cover; `title` is the title page. The two differ in exactly one
/// thing and it is the folio: a cover is not a page of the book, and a number
/// on the front of somebody's novel is a defect. A title page IS a page of the
/// book -- it is simply one whose number is not printed.
pub const OWN_PAGE_ATTR: &str = "data-proof-leaf";
pub const KIND_PLATE: &str = "plate";
pub const KIND_TITLE: &str = "title";

/// A block that always opens a leaf, whatever the writer chose. The generated
/// contents is the only one: a map of the book folded into the bottom of
/// another page is a map nobody finds.
pub const BREAK_ATTR: &str = "data-proof-break";

/// A typed part or chapter heading that can start a proof leaf.
pub const START_CLASS: &str = "start";
/// The paragraph a typed chapter opening begins with, for the drop cap.
pub const OPENING_CLASS: &str = "opening";
/// The ornament between divisions.
pub const ORNAMENT_CLASS: &str = "ornament";
/// The underline the writer applied. XHTML carries one and so does this.
pub const UNDERLINE_CLASS: &str = "u";

/// How many leaves of MARKUP a preview carries back.
///
/// THE ANSWER TO "what happens for a book too large to render in one go", and
/// the bound is on what CROSSES rather than on what is laid out. The whole book
/// is always paginated -- otherwise the leaf count would be a fraction and the
/// rail would tell a writer their 300-page book is 48 pages, and the gutter
/// minimum that count decides would be the wrong band. What is bounded is the
/// markup: serialising thousands of leaves and putting them in the web process
/// costs the writer memory for pages they are not looking at, and
/// `peak_rss_mb` sums the whole tree.
///
/// The leaves it does carry are the leaves the FILE has, exactly: pagination is
/// sequential, so leaf 12 does not depend on leaf 400.
pub const PREVIEW_LEAVES: u32 = 48;

/// A cover, as bytes somebody else read. The same shape `epub::Cover` has, and
/// deliberately a separate type: an EPUB has ONE cover slot and this format has
/// as many leaves as it likes, so the two formats do not agree about what a
/// cover is.
pub struct Cover {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub fit: crate::covers::CoverFit,
}

/// Everything a proof render needs, and nothing it can go and fetch.
pub struct Proof<'a> {
    pub book: &'a Book<'a>,
    pub bodies: &'a HashMap<String, String>,
    /// The BCP-47 tag on the proof document's `<html lang>`. Originally a
    /// constant, made a parameter -- see `epub::Epub::language`.
    pub language: &'a str,
    /// The font, the page and the margins together, and THIS is where all three become real. The EPUB
    /// takes only the font, because a reflowable format has no page; a proof
    /// copy is a page, and the trim and the margins are its whole geometry.
    pub design: &'a BookDesign,
    pub style: ChapterStyle,
    /// IDs selected from typed chapter-run rows by the export path.
    pub openings: ChapterOpenings,
    /// The front cover, as the first leaf.
    pub front_cover: Option<Cover>,
    /// The back cover, as the LAST leaf. 043 recorded that an EPUB has nowhere
    /// to put one; a bound book plainly does, and it is the back.
    pub back_cover: Option<Cover>,
    /// How many leaves of markup to carry back, or None for all of them. The
    /// whole book is paginated either way.
    pub markup_limit: Option<u32>,
    /// The identity this book is pinned to, or None.
    ///
    /// **A PROOF COPY'S ONLY IDENTITY CHANNEL IS INK.** The PDF's own document
    /// metadata is not this application's: what WebKitGTK's printer writes into
    /// the info dictionary is `/Title` (from the document's `<title>`, so the
    /// book's name) and `/Producer`, plus two dates. There is no `/Author` and
    /// no XMP stream, and an `<meta name="author">` in the head reaches neither
    /// -- measured against a real proof, not assumed. So the byline goes where a
    /// printed book has always put it, on the title page, and
    /// `identity::disclosed` is what says whether there is one.
    pub pin: Option<&'a crate::identity::Pin>,
}

/// Micrometres as a CSS millimetre length.
///
/// EXACT, WITH NO FLOAT ANYWHERE. 040 stores micrometres as integers precisely
/// so that every inch fraction a printer quotes is exact; formatting through an
/// `f64` would put a rounding step between the value a writer chose and the
/// page it is set on. Three decimals is all a micrometre needs.
pub fn mm(um: i64) -> String {
    let whole = um / 1000;
    let frac = (um % 1000).abs();
    if frac == 0 {
        return format!("{whole}mm");
    }
    let decimals = format!("{frac:03}");
    format!("{whole}.{}mm", decimals.trim_end_matches('0'))
}

/// The width of the text column: the trim less both side margins.
pub fn measure_um(design: &BookDesign) -> i64 {
    design.page.width_um - design.margins.inner_um - design.margins.outer_um
}

/// The stylesheet the leaves are set with.
///
/// THIS IS THE ONE THAT DECIDES THE LAYOUT and it is shared by the preview and
/// the file, byte for byte. `print_stylesheet` is this plus the one rule that
/// only a printer can use.
pub fn stylesheet(design: &BookDesign, style: &ChapterStyle) -> String {
    let page = &design.page;
    let m = &design.margins;
    let mut css = format!(
        "html, body {{ margin: 0; padding: 0; background: #fff; color: #000; }}\n\
         #proof-flow {{ position: absolute; top: 0; left: -20000mm; \
         width: {measure}; visibility: hidden; }}\n\
         .proof-leaf {{ width: {w}; height: {h}; box-sizing: border-box; \
         overflow: hidden; background: #fff; display: flex; flex-direction: column; \
         break-after: page; page-break-after: always; }}\n\
         .proof-leaf:last-child {{ break-after: auto; page-break-after: auto; }}\n\
         .proof-leaf[data-side=\"recto\"] {{ padding: {top} {outer} {bottom} {inner}; }}\n\
         .proof-leaf[data-side=\"verso\"] {{ padding: {top} {inner} {bottom} {outer}; }}\n\
         .proof-leaf[data-kind=\"plate\"] {{ padding: 0; }}\n\
         .proof-text {{ flex: 1 1 auto; min-height: 0; overflow: hidden; }}\n\
         .proof-runhead, .proof-folio {{ flex: 0 0 auto; height: 2.4em; \
         font-size: 0.82em; text-align: center; letter-spacing: 0.08em; \
         font-variant: small-caps; }}\n\
         .proof-folio {{ letter-spacing: 0; font-variant: normal; }}\n\
         .proof-leaf[data-kind] .proof-runhead, \
         .proof-leaf[data-kind] .proof-folio {{ visibility: hidden; }}\n\
         .proof-leaf[data-kind=\"plate\"] .proof-runhead, \
         .proof-leaf[data-kind=\"plate\"] .proof-folio {{ display: none; }}\n\
         body {{ font-family: {family}; font-size: 11pt; line-height: 1.45; \
         text-rendering: optimizeLegibility; }}\n\
         p {{ margin: 0; text-indent: 1.4em; text-align: justify; hyphens: auto; overflow-wrap: anywhere; }}\n\
         p.{OPENING_CLASS}, p.proof-continued, .{ORNAMENT_CLASS} + p, \
         h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p {{ text-indent: 0; }}\n\
         h1, h2, h3, h4, h5, h6 {{ font-weight: normal; text-align: center; \
         margin: 0 0 1.4em; }}\n\
         h2 {{ font-size: 1.5em; margin-top: 2.6em; }}\n\
         h3 {{ font-size: 1.2em; margin-top: 1.8em; }}\n\
         h4, h5, h6 {{ font-size: 1em; margin-top: 1.4em; }}\n\
         .{ORNAMENT_CLASS} {{ text-align: center; text-indent: 0; margin: 1.2em 0 1.6em; }}\n\
         .{UNDERLINE_CLASS} {{ text-decoration: underline; }}\n\
         .proof-title {{ display: flex; flex-direction: column; \
         justify-content: center; height: 100%; text-align: center; }}\n\
         .proof-title h1 {{ font-size: 2.1em; margin: 0; }}\n\
         .proof-title .proof-byline {{ font-size: 1.1em; margin: 1.6em 0 0; \
         text-indent: 0; }}\n\
         .proof-plate {{ height: 100%; display: flex; }}\n\
         .proof-plate img {{ width: 100%; height: 100%; object-fit: contain; }}\n\
         .proof-plate[data-fit=\"fill\"] img {{ object-fit: cover; }}\n\
         p.proof-toc {{ display: flex; align-items: baseline; \
         text-indent: 0; margin: 0.35em 0; }}\n\
         .proof-toc .proof-toc-title {{ flex: 0 1 auto; }}\n\
         .proof-toc .proof-toc-leader {{ flex: 1 1 auto; margin: 0 0.4em; \
         border-bottom: 1px dotted currentColor; opacity: 0.5; }}\n\
         .proof-toc .proof-toc-folio {{ flex: 0 0 3.2em; text-align: right; \
         font-variant-numeric: tabular-nums; }}\n",
        measure = mm(measure_um(design)),
        w = mm(page.width_um),
        h = mm(page.height_um),
        top = mm(m.top_um),
        bottom = mm(m.bottom_um),
        inner = mm(m.inner_um),
        outer = mm(m.outer_um),
        family = css_string(&design.font) + ", " + crate::design::FONT_FALLBACK,
    );
    // The three options that are nothing but a stylesheet, on 043's rule and in
    // its words: the markup says what a thing IS, unconditionally, and an
    // option nobody chose writes NO RULE AT ALL -- which is what makes "absent
    // means the plainest book" a property of the bytes rather than a claim.
    // `new_page` IS NOT A RULE HERE AND MUST NOT BECOME ONE. In the EPUB it is
    // one line of CSS because a reading system paginates; here the paginator
    // does, and a `break-before: page` inside a leaf would split that leaf
    // across two sheets -- a page break the writer asked for landing in the
    // middle of a page they did not. The option reaches the script instead.
    if style.caps_title {
        css.push_str(
            ".book-body-heading { text-transform: uppercase; letter-spacing: 0.07em; }\n",
        );
    }
    if style.drop_cap {
        css.push_str(&format!(
            "p.{OPENING_CLASS}::first-letter {{ float: left; font-size: 3.1em; \
             line-height: 0.82; padding: 0.02em 0.08em 0 0; }}\n"
        ));
    }
    css
}

/// The stylesheet plus the sheet size, which is the only rule the preview has
/// no use for.
///
/// THE SPLIT IS WHY THE RAIL CAN PAINT THE FILE'S OWN CSS. 043's
/// `scopeStylesheet` REFUSES an at-rule rather than mangling one, and `@page`
/// is an at-rule; separating it means the preview gets every rule that decides
/// a line break and none that it cannot scope. Nothing about the layout lives
/// here: the leaf's own box already states the trim.
pub fn print_stylesheet(design: &BookDesign, style: &ChapterStyle) -> String {
    format!(
        "@page {{ size: {w} {h}; margin: 0; }}\n{}",
        stylesheet(design, style),
        w = mm(design.page.width_um),
        h = mm(design.page.height_um),
    )
}

/// One stored body as proof-document blocks, one per line.
///
/// A FOURTH WALK OF THE TREE, after `store::document_text`,
/// `export::document_markdown` and `epub::document_xhtml` -- and it is NOT a
/// fourth rule. What a proof copy needs from a paragraph is exactly what an
/// XHTML document needs: the marks kept, the underline carried, the text
/// escaped for markup. So this DELEGATES to `epub::document_xhtml` rather than
/// restating it, which is the one case in this crate where the two questions
/// really are the same question. Restatement is this repo's decision where two
/// rules DISAGREE; here they do not, and a second copy would be a second place
/// to drop an underline.
pub fn document_blocks(body: &str) -> Option<String> {
    crate::epub::document_xhtml(body)
}

/// The whole book as one HTML document that paginates itself.
pub fn proof_document(proof: &Proof) -> String {
    let contents = crate::export::contents_of(proof.book);
    let ornament = proof.style.glyph.as_deref().and_then(glyph_ornament);
    let mut flow = String::new();

    // THE FRONT COVER IS THE FIRST LEAF. 042 recorded that nothing consumed a
    // cover yet and named this slice; a bound book opens on its cover and a
    // proof copy of a bound book does too.
    if let Some(cover) = &proof.front_cover {
        flow.push_str(&plate(cover, proof.book.name));
    }
    // The title page. Always, even for a book with nothing in it: every book
    // has a title, so every book has a first page. 043's answer, in its words.
    // THE BYLINE COMES OUT OF THE ONE TABLE, exactly as the EPUB's metadata
    // does. A title page that composed its own would be the second list the
    // design forbids, and the disclosure check would be printing a row nothing
    // emits.
    let byline = crate::identity::emitted(crate::export::Format::Pdf, proof.pin, "title-page")
        .map(|name| format!("<p class=\"proof-byline\">{}</p>", xml_escape(name)))
        .unwrap_or_default();
    flow.push_str(&format!(
        "<section {OWN_PAGE_ATTR}=\"{KIND_TITLE}\" class=\"proof-title\"><h1>{}</h1>{byline}</section>\n",
        xml_escape(proof.book.name)
    ));

    // THE CONTENTS, WITH PAGE NUMBERS, which is the one thing this format does
    // that neither of the other two can. 041 built the contents as DATA and
    // said in as many words that "044 attaches page numbers to it"; this is
    // that. The folio cell is emitted EMPTY and at its final width, so stamping
    // the numbers in after pagination cannot move a single line -- if the cell
    // grew when the number arrived, the contents would repaginate and the
    // numbers would be about the previous layout.
    if !contents.is_empty() {
        flow.push_str(&format!(
            "<h2 {BREAK_ATTR}=\"page\">{}</h2>\n",
            xml_escape(proof.book.contents_title)
        ));
        // ONE BLOCK PER ENTRY, never one list. The paginator moves a block it
        // cannot fit and splits only a paragraph, so a contents wrapped in a
        // single `<ul>` is one block taller than a page for any book with more
        // chapters than a leaf holds -- which is most books. Found by looking
        // at a real proof: the list moved whole, left an empty leaf behind it,
        // and would have been clipped at forty entries.
        for entry in &contents {
            flow.push_str(&format!(
                "<p class=\"proof-toc\" style=\"padding-left: {}em\">\
                 <span class=\"proof-toc-title\">{}</span>\
                 <span class=\"proof-toc-leader\"></span>\
                 <span class=\"proof-toc-folio\" data-proof-folio-of=\"{}\"></span></p>\n",
                (entry.level.saturating_sub(crate::export::heading_level(0))) as f32 * 1.2,
                xml_escape(&entry.title),
                xml_escape(&entry.id),
            ));
        }
    }

    let runs: [&[(String, String, i64)]; 3] =
        [proof.book.front, proof.book.chapters, proof.book.back];
    let mut first_division = true;
    for (run_index, run) in runs.into_iter().enumerate() {
        let mut opening_pending = false;
        for (id, title, depth) in run {
            let level = crate::export::heading_level(*depth);
            let opens = *depth <= 0;
            let styled = run_index == 1 && proof.openings.styled.contains(id);
            let page = run_index == 1 && proof.openings.page.contains(id);
            // The first division does not request an extra break: that once
            // produced a blank initial leaf. Later typed parts and chapters
            // can request one without forcing a break before scene headings.
            let mut classes = Vec::new();
            if page && !first_division { classes.push(START_CLASS); }
            if run_index == 1 { classes.push("book-body-heading"); }
            let class = if classes.is_empty() { String::new() }
                else { format!(" class=\"{}\"", classes.join(" ")) };
            if opens {
                first_division = false;
            }
            if opens || styled || page { opening_pending = styled; }
            // The running head this heading installs. A top-level division
            // names the recto's head; anything under it leaves it alone, so a
            // scene title does not become the head of the chapter it is in.
            let running = if opens {
                format!(" data-proof-running=\"{}\"", xml_escape(title))
            } else {
                String::new()
            };
            flow.push_str(&format!(
                "<h{level} id=\"{anchor}\"{class}{running}>{}</h{level}>\n",
                xml_escape(title),
                anchor = anchor_id(id),
            ));
            // THE ORNAMENT MARKS A DIVISION, not every heading under it --
            // 043's rule and its reason, unchanged: a dinkus under every scene
            // title is a page of dinkuses.
            if styled {
                if let Some(ornament) = ornament {
                    flow.push_str(&format!(
                        "<p class=\"{ORNAMENT_CLASS}\">{}</p>\n",
                        xml_escape(ornament)
                    ));
                }
            }
            let prose = proof
                .bodies
                .get(id)
                .and_then(|b| document_blocks(b))
                .unwrap_or_default();
            for block in prose.lines() {
                // Keep the opening pending through containers whose prose is in a child.
                let class = if opening_pending && !block.trim().is_empty() {
                    opening_pending = false;
                    format!(" class=\"{OPENING_CLASS}\"")
                } else {
                    String::new()
                };
                flow.push_str(&format!("<p{class}>{block}</p>\n"));
            }
        }
    }

    if let Some(cover) = &proof.back_cover {
        flow.push_str(&plate(cover, proof.book.name));
    }

    // The paginator's only input besides the DOM. A JSON island rather than
    // interpolated JavaScript: a book's title is the writer's text, and the one
    // place it must never land is inside a program.
    let meta = json_island(&serde_json::json!({
        "book": proof.book.name,
        "font": proof.design.font,
        "newPage": proof.style.new_page,
        "markupLimit": proof.markup_limit,
    }));

    format!(
        "<!DOCTYPE html>\n<html lang=\"{language}\">\n<head>\n\
         <meta charset=\"utf-8\">\n<title>{title}</title>\n\
         <style>{css}</style>\n\
         <script type=\"application/json\" id=\"proof-meta\">{meta}</script>\n\
         </head>\n<body>\n\
         <div id=\"proof-flow\">\n{flow}</div>\n\
         <div id=\"proof-leaves\"></div>\n\
         <script>{PAGINATOR_JS}</script>\n\
         </body>\n</html>\n",
        title = xml_escape(proof.book.name),
        language = xml_escape(proof.language),
        css = print_stylesheet(proof.design, &proof.style),
        meta = meta,
    )
}

/// JSON safe inside a `<script>` element.
///
/// FOUND BY THE TEST THAT ASSERTED THE ESCAPE, and it is a real hole rather
/// than a hypothetical one: `serde_json` does not escape `<`, and an HTML
/// parser ends a `<script>` element at the first `</script` it sees no matter
/// what that character is nested inside. A book called `</script>` would have
/// closed the island, and everything after it -- the writer's own title -- would
/// have been parsed as markup. Escaping the `<` is the fix the whole web uses
/// and it changes nothing a JSON parser sees.
fn json_island(value: &serde_json::Value) -> String {
    value.to_string().replace('<', "\\u003c")
}

/// A cover, as a leaf of its own.
fn plate(cover: &Cover, name: &str) -> String {
    format!(
        "<section {OWN_PAGE_ATTR}=\"{KIND_PLATE}\" class=\"proof-plate\" data-fit=\"{fit}\">\
         <img src=\"data:{mime};base64,{data}\" alt=\"{alt}\"></section>\n",
        fit = cover.fit.id(),
        mime = cover.media_type,
        data = crate::pictures::base64(&cover.bytes),
        alt = xml_escape(name),
    )
}

/// An item id as a document fragment id.
///
/// PREFIXED, never the bare id. A stored id is a uuid today and the contents
/// stamps its folio by looking the target up, so a value that could collide
/// with an id this module writes itself would put a chapter's page number on
/// the wrong line.
pub fn anchor_id(id: &str) -> String {
    format!("proof-{id}")
}

/// The paginator, and the whole reason a proof copy can carry a folio.
///
/// IT RUNS IN THE ENGINE THAT WILL PRINT IT. Every measurement here is the
/// engine's own layout of the engine's own fonts, which is why the leaf
/// boundaries the preview shows are the leaf boundaries the file gets rather
/// than a second opinion that happens to agree.
///
/// A JavaScript string constant rather than a file: `resolve_asset_root` finds
/// the PAGE's bundle and this document is not the page, so reading it from
/// `dist` would make a book depend on a build directory. It is small, it is
/// tested through the rendered document and through the rigs, and it has one
/// home.
pub const PAGINATOR_JS: &str = r#"
(function () {
  "use strict";
  var flow = document.getElementById("proof-flow");
  var sheet = document.getElementById("proof-leaves");
  var meta = JSON.parse(document.getElementById("proof-meta").textContent);
  var markupLimit =
    meta.markupLimit === null || meta.markupLimit === undefined ? 0 : meta.markupLimit;
  var index = 0;
  var running = "";

  function leaf(kind) {
    index += 1;
    var page = document.createElement("div");
    page.className = "proof-leaf";
    // THE SIDE IS THE PARITY, and it is what makes the inner margin the inner
    // margin: facing pages mirror, so the binding edge is the left of a recto
    // and the right of a verso. A design stated as left and right would be
    // wrong on every other leaf of the book.
    page.setAttribute("data-side", index % 2 === 1 ? "recto" : "verso");
    if (kind) page.setAttribute("data-kind", kind);
    var head = document.createElement("div");
    head.className = "proof-runhead";
    var text = document.createElement("div");
    text.className = "proof-text";
    var folio = document.createElement("div");
    folio.className = "proof-folio";
    page.appendChild(head);
    page.appendChild(text);
    page.appendChild(folio);
    sheet.appendChild(page);
    return page;
  }

  function textOf(page) { return page.querySelector(".proof-text"); }
  function overflows(box) {
    return box.scrollHeight > box.clientHeight + 0.5 ||
      box.scrollWidth > box.clientWidth + 0.5;
  }
  function full(page) { return overflows(textOf(page)); }
  function lineHeight(page) {
    var h = parseFloat(getComputedStyle(textOf(page)).lineHeight);
    return isNaN(h) ? 16 : h;
  }
  try {
  var current = leaf("");
  current.querySelector(".proof-runhead").textContent = meta.book;

  function next() {
    var page = leaf("");
    page.querySelector(".proof-runhead").textContent =
      page.getAttribute("data-side") === "verso" ? meta.book : running;
    return page;
  }

  var blocks = [];
  while (flow.firstElementChild) blocks.push(flow.removeChild(flow.firstElementChild));

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var own = block.getAttribute("data-proof-leaf");
    if (block.hasAttribute("data-proof-running")) {
      running = block.getAttribute("data-proof-running");
    }
    if (own !== null) {
      // Its own leaf. A cover and a title page are not prose and share nothing
      // with it: no folio, no running head, no measure.
      if (textOf(current).childNodes.length) current = next();
      current.setAttribute("data-kind", own);
      current.querySelector(".proof-runhead").textContent = "";
      textOf(current).appendChild(block);
      if (full(current)) throw new Error("a proof leaf exceeds the page");
      if (i + 1 < blocks.length) current = next();
      continue;
    }
    var opensLeaf =
      block.getAttribute("data-proof-break") === "page" ||
      (meta.newPage && block.classList.contains("start"));
    if (opensLeaf && textOf(current).childNodes.length) {
      current = next();
      current.querySelector(".proof-runhead").textContent =
        current.getAttribute("data-side") === "verso" ? meta.book : running;
    }
    textOf(current).appendChild(block);
    if (!full(current)) continue;
    current = place(current, block);
  }

  // A heading travels with the block after it when neither fits here.
  function place(page, block) {
    // Each successful split consumes text. The cap also turns a pathological
    // manuscript into a refusal rather than a web process that never answers.
    for (var fragments = 0; fragments < 10000; fragments++) {
      var split = trySplit(page, block);
      if (split !== null) {
        page = next();
        block = split;
        textOf(page).appendChild(block);
        if (!full(page)) return page;
        continue;
      }
      var text = textOf(page);
      if (text.childNodes.length === 1) {
        throw new Error("a proof " + block.tagName.toLowerCase() + " exceeds the page");
      }
      var heading = /^H[1-6]$/.test(block.tagName) ? null : previousHeading(block);
      if (heading !== null && text.childNodes.length === 2) {
        throw new Error("a proof heading and following block exceed the page");
      }
      text.removeChild(block);
      page = next();
      if (heading !== null && heading.parentNode === text) {
        text.removeChild(heading);
        textOf(page).appendChild(heading);
      }
      textOf(page).appendChild(block);
      if (!full(page)) return page;
    }
    throw new Error("a proof paragraph needs too many pages");
  }

  function previousHeading(block) {
    var prev = block.previousElementSibling;
    return prev !== null && /^H[1-6]$/.test(prev.tagName) ? prev : null;
  }

  // Range.cloneContents keeps marks and every whitespace character intact.
  // Prefer a boundary after whitespace; fall back to Unicode code points when
  // a single token cannot fit. Never split a surrogate pair.
  function trySplit(page, block) {
    if (block.tagName !== "P") return null;
    var source = block.cloneNode(true);
    var nodes = [], whole = "";
    var walk = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      nodes.push({ node: walk.currentNode, start: whole.length });
      whole += walk.currentNode.data;
    }
    if (!whole.length) return null;
    function point(offset) {
      for (var n = nodes.length - 1; n >= 0; n--) {
        if (offset >= nodes[n].start) {
          return [nodes[n].node, offset - nodes[n].start];
        }
      }
      return [nodes[0].node, 0];
    }
    function fragment(start, end) {
      var range = document.createRange();
      if (start === 0) range.setStart(source, 0);
      else {
        var a = point(start);
        range.setStart(a[0], a[1]);
      }
      if (end === whole.length) range.setEnd(source, source.childNodes.length);
      else {
        var b = point(end);
        range.setEnd(b[0], b[1]);
      }
      return range.cloneContents();
    }
    function headAt(offset) {
      block.replaceChildren(fragment(0, offset));
      return !full(page);
    }
    function fit(points) {
      var lo = -1, hi = points.length;
      while (lo + 1 < hi) {
        var mid = (lo + hi) >> 1;
        if (headAt(points[mid])) lo = mid; else hi = mid;
      }
      return lo;
    }
    var words = [], match;
    var whitespace = /\s+\S/g;
    while ((match = whitespace.exec(whole)) !== null) {
      words.push(match.index + match[0].length - 1);
    }
    function codepoints() {
      var breaks = [], offset = 0;
      for (var character of whole) {
        offset += character.length;
        if (offset < whole.length) breaks.push(offset);
      }
      return breaks;
    }
    var points = words, best = fit(points), forcedCodepoint = false;
    if (best >= 0) headAt(points[best]);
    if (best < 0 || block.offsetHeight < lineHeight(page) * 1.8) {
      forcedCodepoint = true;
      points = codepoints();
      best = fit(points);
    }
    if (best < 0) {
      block.replaceChildren.apply(block, Array.from(source.childNodes));
      return null;
    }
    headAt(points[best]);
    if (block.offsetHeight < lineHeight(page) * 1.8 &&
        (!forcedCodepoint || textOf(page).childNodes.length > 1)) {
      block.replaceChildren.apply(block, Array.from(source.childNodes));
      return null;
    }
    var tail = block.cloneNode(false);
    tail.classList.remove("opening");
    tail.classList.add("proof-continued");
    var testPage = next();
    textOf(testPage).appendChild(tail);
    function tailAt(candidate) {
      tail.replaceChildren(fragment(candidate, whole.length));
      return tail.offsetHeight >= lineHeight(testPage) * 1.8;
    }
    function widowCandidate(breaks, upper) {
      var low = -1, high = upper + 1;
      while (low + 1 < high) {
        var middle = (low + high) >> 1;
        if (tailAt(breaks[middle])) low = middle; else high = middle;
      }
      return low >= 0 && headAt(breaks[low]) &&
        block.offsetHeight >= lineHeight(page) * 1.8 ? low : -1;
    }
    if (!tailAt(points[best])) {
      var earlier = widowCandidate(points, best);
      if (earlier >= 0) {
        best = earlier;
      } else if (!forcedCodepoint) {
        var finer = codepoints();
        var fitted = fit(finer);
        var fine = widowCandidate(finer, fitted);
        if (fine >= 0) {
          points = finer;
          best = fine;
        }
      }
    }
    headAt(points[best]);
    tail.replaceChildren(fragment(points[best], whole.length));
    textOf(testPage).removeChild(tail);
    sheet.removeChild(testPage);
    index -= 1;
    return tail;
  }

  // THE FOLIOS, STAMPED AFTER THE FACT. A leaf carrying a cover carries none: a
  // number on the front of somebody's book is not a page number, it is a
  // defect. Numbering starts at the first leaf that is not a plate, which is
  // the title page, so the folio a reader sees and the leaf they are holding
  // agree from the first one they can see.
  var leaves = sheet.children;
  var folio = 0;
  for (var p = 0; p < leaves.length; p++) {
    if (leaves[p].getAttribute("data-kind") === "plate") continue;
    folio += 1;
    leaves[p].querySelector(".proof-folio").textContent = String(folio);
    leaves[p].setAttribute("data-folio", String(folio));
  }

  // THE CONTENTS' PAGE NUMBERS, from where the headings actually landed. This
  // is what a paginated book has and the other two formats cannot: 041 emitted
  // the contents as DATA for exactly this, and the number here is read off the
  // leaf rather than counted a second time.
  var cells = sheet.querySelectorAll("[data-proof-folio-of]");
  for (var c = 0; c < cells.length; c++) {
    var target = document.getElementById("proof-" + cells[c].getAttribute("data-proof-folio-of"));
    if (target === null) continue;
    var host = target.closest(".proof-leaf");
    if (host === null) continue;
    cells[c].textContent = host.getAttribute("data-folio") || "";
  }

  // Folios and contents are stamped after splitting. Check every painted box
  // once more so a running head or late page number cannot be clipped either.
  for (var v = 0; v < leaves.length; v++) {
    var boxes = leaves[v].children;
    for (var b = 0; b < boxes.length; b++) {
      if (overflows(boxes[b])) throw new Error("a proof leaf exceeds the page");
    }
  }

  // DID THE BOOK'S FONT ACTUALLY RESOLVE? 040 recorded that this application
  // ships no font files and a writer whose machine lacks the face "gets
  // something else and is told nothing". Measured rather than assumed: the same
  // string is set in the named family with a monospace fallback and in bare
  // monospace, and identical widths mean the name resolved to nothing.
  function resolved(name) {
    var probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;left:-30000mm;top:0;white-space:pre;font-size:96px";
    probe.textContent = "mmmmmmmmmmlliWWWW0Ogq";
    document.body.appendChild(probe);
    probe.style.fontFamily = "monospace";
    var base = probe.getBoundingClientRect().width;
    probe.style.fontFamily = '"' + name.replace(/["\\]/g, "") + '", monospace';
    var got = probe.getBoundingClientRect().width;
    document.body.removeChild(probe);
    return Math.abs(got - base) > 0.5;
  }

  var shown = markupLimit > 0 ? Math.min(markupLimit, leaves.length) : leaves.length;
  var report = {
    leaves: leaves.length,
    truncated: shown < leaves.length,
    fontResolved: resolved(meta.font),
    pages: []
  };
  for (var q = 0; q < shown; q++) report.pages.push(leaves[q].outerHTML);

  flow.parentNode.removeChild(flow);
  var self = document.currentScript;
  if (self && self.parentNode) self.parentNode.removeChild(self);
  document.documentElement.setAttribute("data-proof-leaves", String(leaves.length));
  window.__proof = report;
  } catch (error) {
    window.__proofError = String(error && error.message || error).slice(0, 160);
  }
})();
"#;

/// What the paginator reports, once it has run.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProofReport {
    /// How many leaves it cut. THE WHOLE BOOK, always, whatever the markup
    /// limit was: a fraction here would be the rail telling a writer their
    /// 300-page book is 48 pages, and the gutter band it decides would be
    /// wrong.
    pub leaves: u32,
    /// Whether `pages` carries fewer leaves than the book has.
    pub truncated: bool,
    /// Whether the family 040 stored actually resolved to a face on this
    /// machine. FALSE IS THE INTERESTING ANSWER and it is why this is measured:
    /// a proof copy set in a face the writer did not choose, with nothing
    /// saying so, is a proof copy that lies about itself.
    #[serde(rename = "fontResolved")]
    pub font_resolved: bool,
    /// Each leaf, as the markup the printer was handed.
    pub pages: Vec<String>,
}

/// How many pages a PDF holds, read out of the file.
///
/// THIS IS 043'S UNZIP FOR THIS FORMAT. The preview says the book is 312 leaves;
/// this is what asks the FILE. A preview that agreed with the renderer and not
/// with the file is exactly the instrument this repo has been caught building
/// before, and one number read back out of the bytes is what stops it.
///
/// It counts leaf page objects rather than reading `/Count`, because a page
/// tree is nested -- Skia's output for a 21-page proof carries FOUR `/Pages`
/// nodes -- so the first `/Count` in the file is a subtree's and reading it
/// would report a fraction of the book with no sign anything was wrong.
///
/// STREAM BODIES ARE SKIPPED. Everything between `stream` and `endstream` is
/// compressed content, and a `/Type /Page` appearing in it by chance would be
/// counted. The skip is what makes the count a fact rather than a likelihood.
pub fn pdf_page_count(bytes: &[u8]) -> Option<u32> {
    if !bytes.starts_with(b"%PDF-") {
        return None;
    }
    let mut count = 0u32;
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"stream") {
            match find(bytes, at, b"endstream") {
                Some(end) => {
                    at = end + b"endstream".len();
                    continue;
                }
                // An unterminated stream is a truncated file, and a page count
                // taken from one would describe a document nobody can open.
                None => return None,
            }
        }
        if bytes[at..].starts_with(b"/Type") {
            let mut cursor = at + b"/Type".len();
            while cursor < bytes.len()
                && (bytes[cursor] == b' '
                    || bytes[cursor] == b'\n'
                    || bytes[cursor] == b'\r'
                    || bytes[cursor] == b'\t')
            {
                cursor += 1;
            }
            if bytes[cursor..].starts_with(b"/Page") && !bytes[cursor..].starts_with(b"/Pages") {
                count += 1;
            }
        }
        at += 1;
    }
    if count == 0 {
        None
    } else {
        Some(count)
    }
}

fn find(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// KDP's published gutter minimum for a book of `pages` pages, in micrometres,
/// or None for a page count outside the range they print.
///
/// THE HALF OF 040'S GAP THIS SLICE CAN CLOSE. 040 recorded that the design
/// panel "does not warn when a margin is below a printer's minimum" because
/// "KDP's gutter minimum depends on the page count, which this application does
/// not know until the book is laid out". It knows now, and the answer is a
/// property of a rendered proof rather than of a design -- so it belongs here,
/// beside the count, and NOT in the design panel, which has no page count to
/// ask and never will.
///
/// The table is KDP's, verbatim. The exact conversion of the
/// INCH figure is stored, because the inch figure is the published one and
/// KDP's own millimetre column is rounded.
pub fn gutter_minimum_um(pages: u32) -> Option<i64> {
    match pages {
        0..=23 => None,
        24..=150 => Some(9_525),   // 0.375 in
        151..=300 => Some(12_700), // 0.5 in
        301..=500 => Some(15_875), // 0.625 in
        501..=700 => Some(19_050), // 0.75 in
        701..=828 => Some(22_225), // 0.875 in
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::{default_design, ChapterStyle};
    use crate::export::Book;

    fn design() -> BookDesign {
        default_design()
    }

    fn plain() -> ChapterStyle {
        ChapterStyle {
            glyph: None,
            new_page: false,
            caps_title: false,
            drop_cap: false,
        }
    }

    fn book<'a>(name: &'a str, chapters: &'a [(String, String, i64)]) -> Book<'a> {
        Book {
            name,
            contents_title: "Contents",
            front: &[],
            chapters,
            back: &[],
        }
    }

    fn test_openings(book: &Book<'_>) -> ChapterOpenings {
        // Old pure-renderer fixtures have only headings and depths. Production
        // supplies typed IDs; the mixed-type test below overrides this proxy.
        let top: std::collections::HashSet<String> = book.chapters.iter()
            .filter(|row| row.2 == 0).map(|row| row.0.clone()).collect();
        ChapterOpenings { styled: top.clone(), page: top }
    }

    /// The flow, without the stylesheet above it. Every "is this in the book"
    /// assertion is about the flow: the stylesheet names every class at every
    /// setting, so a search of the whole document answers a different question.
    fn flow_of(html: &str) -> String {
        let start = html.find("<div id=\"proof-flow\">").expect("a flow");
        let end = html
            .find("<div id=\"proof-leaves\">")
            .expect("a leaf container");
        html[start..end].to_string()
    }

    /// The opening tag of the heading anchored at `id`.
    fn heading_for(html: &str, id: &str) -> String {
        let anchor = format!("id=\"{}\"", anchor_id(id));
        let at = html
            .find(&anchor)
            .unwrap_or_else(|| panic!("{anchor}: {html}"));
        let open = html[..at].rfind('<').expect("an opening tag");
        let close = html[at..].find('>').expect("a closing bracket") + at;
        html[open..=close].to_string()
    }

    /// The title leaf's own `<section>`, so an assertion about the byline is
    /// about the page a printed book puts one on rather than about the document.
    fn title_leaf(html: &str) -> String {
        let anchor = format!("{OWN_PAGE_ATTR}=\"{KIND_TITLE}\"");
        let at = html.find(&anchor).unwrap_or_else(|| panic!("{anchor}: {html}"));
        let open = html[..at].rfind('<').expect("an opening tag");
        let end = html[at..].find("</section>").expect("a closing section") + at;
        html[open..end].to_string()
    }

    fn item(id: &str, title: &str, depth: i64) -> (String, String, i64) {
        (id.to_string(), title.to_string(), depth)
    }

    fn render(chapters: &[(String, String, i64)], bodies: HashMap<String, String>) -> String {
        let d = design();
        let b = book("The Harbour", chapters);
        proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        })
    }

    #[test]
    fn micrometres_render_as_exact_millimetres() {
        // 0.75 in is 19 050 um is 19.05 mm, EXACTLY, and that is the whole
        // reason 040 stores integers. A float anywhere on this path would put a
        // rounding step between the value a writer chose and the page it is set
        // on.
        assert_eq!(mm(19_050), "19.05mm");
        assert_eq!(mm(152_400), "152.4mm");
        assert_eq!(mm(148_000), "148mm");
        assert_eq!(mm(1), "0.001mm");
        assert_eq!(mm(0), "0mm");
    }

    #[test]
    fn the_measure_is_the_trim_less_both_side_margins() {
        // The width the paginator measures at, and the width the leaf sets in.
        // They are one number, because a flow measured at a different width
        // than it is set at breaks its lines in a place the leaf does not.
        let d = design();
        assert_eq!(
            measure_um(&d),
            d.page.width_um - d.margins.inner_um - d.margins.outer_um
        );
        // 6 in less 0.75 and 0.625.
        assert_eq!(measure_um(&d), 152_400 - 19_050 - 15_875);
    }

    #[test]
    fn the_leaf_is_the_trim_and_the_margins_mirror() {
        // A PAGE SIZE AND A SET OF MARGINS FINALLY MEAN SOMETHING, which is
        // what 043 said this slice was for. Both sides are asserted, because
        // recto and verso taking the SAME padding is precisely the defect
        // "inner and outer rather than left and right" exists to prevent and it
        // is invisible in any single-page picture.
        let css = stylesheet(&design(), &plain());
        assert!(css.contains("width: 152.4mm; height: 228.6mm;"), "{css}");
        assert!(
            css.contains("[data-side=\"recto\"] { padding: 15.875mm 15.875mm 19.05mm 19.05mm; }"),
            "{css}"
        );
        assert!(
            css.contains("[data-side=\"verso\"] { padding: 15.875mm 19.05mm 19.05mm 15.875mm; }"),
            "{css}"
        );
        assert!(css.contains("width: 117.475mm"), "the measure: {css}");
    }

    #[test]
    fn the_book_font_is_named_with_the_same_fallback_the_epub_gives_it() {
        // ONE STATEMENT OF THE FALLBACK STACK, shared with `epub.rs` rather
        // than copied. This application ships no font files, so what both
        // formats can do is name the face and fall back -- and two books of the
        // same manuscript falling back to two different faces would be two
        // answers to what the writer's book looks like.
        let css = stylesheet(&design(), &plain());
        assert!(
            css.contains(&format!(
                "\"Crimson Text\", {}",
                crate::design::FONT_FALLBACK
            )),
            "{css}"
        );
    }

    #[test]
    fn a_font_name_carrying_a_quote_cannot_end_the_css_string() {
        // `epub::css_string`'s rule, met here rather than restated: 040's
        // `parse_font` stops a control character ending the DECLARATION and
        // this is what stops a quote ending the STRING.
        let mut d = design();
        d.font = "Bad\"Name".to_string();
        let css = stylesheet(&d, &plain());
        assert!(css.contains("\"Bad\\\"Name\""), "{css}");
    }

    #[test]
    fn a_legacy_font_name_cannot_end_the_proof_stylesheet() {
        let mut d = design();
        d.font = "x</style><script>alert(1)</script>{}@;".to_string();
        let chapters = [item("chapter", "A Chapter", 0)];
        let b = book("The Harbour", &chapters);
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &HashMap::new(),
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: Some(100_000),
            pin: None,
        });
        assert!(
            !html.contains("</style><script>alert(1)</script>"),
            "{html}"
        );
        assert_eq!(html.matches("<script>").count(), 1, "{html}");
        assert!(html.contains("\\3c /style\\3e "), "{html}");
    }

    #[test]
    fn an_option_nobody_chose_writes_no_rule_at_all() {
        // 043's rule and its argument, in this format's stylesheet: each of the
        // four is a decoration somebody has to CHOOSE, not one they have to
        // find and turn off, and "absent means the plainest book" is a property
        // of the bytes rather than a claim about them.
        let css = stylesheet(&design(), &plain());
        assert!(!css.contains("text-transform"), "{css}");
        assert!(!css.contains("first-letter"), "{css}");
    }

    #[test]
    fn each_chosen_option_writes_exactly_its_own_rule() {
        for (style, needle, other) in [
            (
                ChapterStyle {
                    glyph: None,
                    new_page: false,
                    caps_title: true,
                    drop_cap: false,
                },
                "text-transform: uppercase",
                "first-letter",
            ),
            (
                ChapterStyle {
                    glyph: None,
                    new_page: false,
                    caps_title: false,
                    drop_cap: true,
                },
                "::first-letter",
                "text-transform",
            ),
        ] {
            let css = stylesheet(&design(), &style);
            assert!(css.contains(needle), "{needle} missing: {css}");
            assert!(!css.contains(other), "{other} present: {css}");
        }
    }

    #[test]
    fn the_page_break_option_reaches_the_paginator_and_never_the_stylesheet() {
        // THE ONE OPTION THAT IS NOT CSS IN THIS FORMAT, and the difference is
        // not cosmetic. In an EPUB `new-page` is one rule because a reading
        // system paginates; here the script does, and a `break-before: page`
        // inside a leaf would split that leaf across two sheets -- the writer
        // asks for a chapter to start a page and gets a page break in the
        // middle of one.
        let on = ChapterStyle {
            glyph: None,
            new_page: true,
            caps_title: false,
            drop_cap: false,
        };
        let css = stylesheet(&design(), &on);
        assert!(!css.contains("break-before"), "{css}");
        let d = design();
        let b = book("N", &[]);
        let bodies = HashMap::new();
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: on,
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        });
        assert!(html.contains("\"newPage\":true"), "{html}");
        let off = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        });
        assert!(off.contains("\"newPage\":false"), "{off}");
    }

    #[test]
    fn the_title_page_is_a_page_of_the_book_and_a_cover_is_not() {
        // THE ONE THING THE TWO KINDS DIFFER IN IS THE FOLIO. A number on the
        // front of somebody's novel is a defect; a title page is a page of the
        // book whose number is simply not printed. The first draft gave both
        // the same kind and the folios in the proof came out one short, which is
        // how this was found.
        let d = design();
        let b = book("N", &[]);
        let bodies = HashMap::new();
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: Some(Cover {
                bytes: vec![1],
                media_type: "image/png",
                fit: crate::covers::CoverFit::Contain,
            }),
            back_cover: None,
            markup_limit: None,
            pin: None,
        });
        assert!(
            html.contains(&format!("{OWN_PAGE_ATTR}=\"{KIND_TITLE}\"")),
            "{html}"
        );
        assert!(
            html.contains(&format!("{OWN_PAGE_ATTR}=\"{KIND_PLATE}\"")),
            "{html}"
        );
        assert_ne!(KIND_TITLE, KIND_PLATE);
    }

    #[test]
    fn the_contents_opens_a_leaf_whatever_the_writer_chose() {
        // It is not the chapter option and must not ride on it: a map of the
        // book folded into the bottom of the title page is a map nobody finds.
        let html = render(&[item("a", "One", 0)], HashMap::new());
        assert!(
            html.contains(&format!("<h2 {BREAK_ATTR}=\"page\">Contents</h2>")),
            "{html}"
        );
    }

    #[test]
    fn only_the_printer_gets_the_sheet_size_and_the_preview_gets_every_other_rule() {
        // THE SPLIT THE RAIL DEPENDS ON. 043's `scopeStylesheet` refuses an
        // at-rule rather than mangling one, so the preview must be handed a
        // stylesheet with no `@page` in it -- and it must be handed EVERY rule
        // that decides a line break, or the preview is a second layout.
        let d = design();
        let s = plain();
        let screen = stylesheet(&d, &s);
        let print = print_stylesheet(&d, &s);
        assert!(!screen.contains("@page"), "{screen}");
        assert!(
            print.starts_with("@page { size: 152.4mm 228.6mm; margin: 0; }\n"),
            "{print}"
        );
        assert_eq!(
            print.strip_prefix(&format!("@page {{ size: 152.4mm 228.6mm; margin: 0; }}\n")),
            Some(screen.as_str())
        );
    }

    #[test]
    fn every_book_has_a_title_page_even_with_nothing_in_it() {
        // 043's answer to the empty book, in this format. Not an empty rail and
        // not a blank leaf: every book has a title, so every book has a first
        // page.
        let html = render(&[], HashMap::new());
        assert!(
            html.contains("class=\"proof-title\"><h1>The Harbour</h1>"),
            "{html}"
        );
        // And no contents, because 041's rule is that a heading over nothing is
        // a section the writer did not ask for. Asserted over the FLOW and not
        // over the whole document: the stylesheet carries the contents' rules
        // at every setting, so a search of the file finds the word either way.
        assert!(!flow_of(&html).contains("proof-toc"), "{html}");
    }

    #[test]
    fn the_contents_reserves_an_empty_folio_cell_per_entry() {
        // THE ONE THING THIS FORMAT DOES THAT THE OTHER TWO CANNOT, and the
        // reason the cell is emitted EMPTY: it is already at its final width,
        // so stamping a number in after pagination cannot move a line. A cell
        // that grew when the number arrived would repaginate the contents and
        // every number would then be about the previous layout.
        let html = render(&[item("a", "Chapter One", 0)], HashMap::new());
        assert!(
            html.contains("<span class=\"proof-toc-folio\" data-proof-folio-of=\"a\"></span>"),
            "{html}"
        );
        assert!(
            html.contains("<span class=\"proof-toc-title\">Chapter One</span>"),
            "{html}"
        );
        // THE ANCHOR IS ASSERTED AS A LITERAL, and the first draft did not:
        // `format!("id=\"{}\"", anchor_id("a"))` compares a constant with
        // itself, so a mutation returning the BARE id survived the whole suite
        // -- the recorded `STARTER_*` shape. The prefix is the rule and it is
        // load-bearing: the contents cell carries the BARE id and the paginator
        // prepends `proof-`, so a heading id that lost the prefix puts every
        // chapter's page number nowhere.
        assert!(html.contains("id=\"proof-a\""), "{html}");
        assert_eq!(anchor_id("a"), "proof-a");
        assert!(html.contains("data-proof-folio-of=\"a\""), "{html}");
    }

    #[test]
    fn the_first_division_carries_no_page_break_and_every_later_one_does() {
        // A BLANK FIRST LEAF IS WHAT THIS PREVENTS, and it was measured rather
        // than reasoned about: the first probe put `page-break-before: always`
        // on every division and the PDF came back with a blank page one.
        let html = render(
            &[
                item("a", "One", 0),
                item("b", "Two", 0),
                item("c", "Scene", 1),
            ],
            HashMap::new(),
        );
        assert!(!heading_for(&html, "a").contains(START_CLASS), "{html}");
        assert!(heading_for(&html, "b").contains(START_CLASS), "{html}");
        // A scene inside a chapter is not a division and never breaks.
        assert!(!heading_for(&html, "c").contains(START_CLASS), "{html}");
    }

    #[test]
    fn a_division_names_the_running_head_and_a_scene_inside_it_does_not() {
        // The head says which chapter the reader is in. A scene title there
        // would make the head change under them three times a chapter and stop
        // meaning anything.
        let html = render(
            &[item("a", "One", 0), item("b", "Scene", 1)],
            HashMap::new(),
        );
        assert!(html.contains("data-proof-running=\"One\""), "{html}");
        assert!(!html.contains("data-proof-running=\"Scene\""), "{html}");
    }

    #[test]
    fn a_title_that_could_open_a_tag_cannot() {
        let html = render(&[item("a", "<script>alert(1)</script>", 0)], HashMap::new());
        assert!(!html.contains("<script>alert"), "{html}");
        assert!(
            html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{html}"
        );
    }

    #[test]
    fn the_book_name_reaches_the_paginator_as_json_and_never_as_a_program() {
        // A JSON island rather than interpolated JavaScript. A book's title is
        // the writer's text, and the one place it must never land is inside a
        // program -- `js_string`'s rule, one document further out.
        let d = design();
        let b = book("He said \"</script>\" and \\ left", &[]);
        let bodies = HashMap::new();
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        });
        // serde_json escapes the quote and the backslash; the `/` of the close
        // tag is what a naive interpolation would have let through.
        assert!(
            html.contains(r#""book":"He said \"\u003c/script>\" and \\ left""#),
            "{html}"
        );
    }

    #[test]
    fn the_prose_carries_the_underline_this_format_can_hold() {
        // Markdown drops it and counts the loss; a proof copy has an underline
        // and so must carry it. Delegated to `epub::document_xhtml`, which is
        // the one place in this crate where the two questions really are the
        // same question.
        let body = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"under","marks":[{"type":"underline"}]}]}]})
        .to_string();
        let mut bodies = HashMap::new();
        bodies.insert("a".to_string(), body);
        let html = render(&[item("a", "One", 0)], bodies);
        assert!(
            html.contains(&format!("<span class=\"{UNDERLINE_CLASS}\">under</span>")),
            "{html}"
        );
    }

    #[test]
    fn drop_cap_follows_empty_containers_to_the_first_prose() {
        let rows = [
            item("part", "Part", 0),
            item("empty", "Empty", 1),
            item("scene", "Scene", 2),
            item("later", "Later", 1),
            item("next", "Next", 0),
        ];
        let mut bodies = HashMap::new();
        for (id, text) in [("scene", "first"), ("later", "later"), ("next", "next")] {
            bodies.insert(
                id.to_string(),
                serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[{"type":"text","text":text}]}]})
                .to_string(),
            );
        }
        let html = flow_of(&render(&rows, bodies));
        assert!(html.contains("<p class=\"opening\">next</p>"), "{html}");
        assert!(html.contains("<p class=\"opening\">first</p>"), "{html}");
        assert!(html.contains("<p>later</p>"), "{html}");
    }

    #[test]
    fn typed_chapter_styling_excludes_parts_and_matter() {
        let front = [item("front", "Dedication", 0)];
        let chapters = [item("part", "Part", 0), item("chapter", "Chapter", 1)];
        let back = [item("back", "Afterword", 0)];
        let b = Book {
            name: "Book", contents_title: "Contents", front: &front,
            chapters: &chapters, back: &back,
        };
        let bodies: HashMap<String, String> = [
            ("front", "front prose"), ("chapter", "chapter prose"), ("back", "back prose"),
        ].into_iter().map(|(id, text)| (
            id.to_string(),
            serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":text}]}]}).to_string(),
        )).collect();
        let d = design();
        let html = proof_document(&Proof {
            language: "en", book: &b, bodies: &bodies, design: &d,
            style: ChapterStyle {
                glyph: Some("diamond".to_string()), new_page: true,
                caps_title: true, drop_cap: true,
            },
            openings: ChapterOpenings {
                styled: ["chapter".to_string()].into(),
                page: ["part".to_string(), "chapter".to_string()].into(),
            },
            front_cover: None, back_cover: None, markup_limit: None, pin: None,
        });
        let flow = flow_of(&html);
        assert_eq!(flow.matches("class=\"ornament\"").count(), 1, "{flow}");
        assert_eq!(flow.matches("class=\"opening\"").count(), 1, "{flow}");
        assert!(flow.contains("<p>front prose</p>"), "{flow}");
        assert!(flow.contains("<p class=\"opening\">chapter prose</p>"), "{flow}");
        assert!(flow.contains("<p>back prose</p>"), "{flow}");
        assert!(!heading_for(&html, "front").contains("book-body-heading"), "{html}");
        assert!(heading_for(&html, "chapter").contains("book-body-heading"), "{html}");
        assert!(!heading_for(&html, "back").contains("book-body-heading"), "{html}");
    }

    #[test]
    fn the_paragraph_a_division_opens_with_is_marked_and_the_next_is_not() {
        // The drop cap's hook, written unconditionally: the markup says what
        // the paragraph IS and the stylesheet says whether that means anything.
        let mut bodies = HashMap::new();
        bodies.insert(
            "a".to_string(),
            serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[{"type":"text","text":"first"}]},
                {"type":"paragraph","content":[{"type":"text","text":"second"}]}]})
            .to_string(),
        );
        let html = render(&[item("a", "One", 0)], bodies);
        assert!(
            html.contains(&format!("<p class=\"{OPENING_CLASS}\">first</p>")),
            "{html}"
        );
        assert!(html.contains("<p>second</p>"), "{html}");
    }

    #[test]
    fn both_covers_are_leaves_of_their_own_and_the_back_one_is_last() {
        // 043 RECORDED THAT AN EPUB HAS NOWHERE TO PUT A BACK COVER. A bound
        // book plainly does and it is the back, so the gap that format left is
        // closed here rather than inherited.
        let d = design();
        let b = book("The Harbour", &[]);
        let bodies = HashMap::new();
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: Some(Cover {
                bytes: vec![1, 2, 3],
                media_type: "image/png",
                fit: crate::covers::CoverFit::Contain,
            }),
            back_cover: Some(Cover {
                bytes: vec![4, 5, 6],
                media_type: "image/jpeg",
                fit: crate::covers::CoverFit::Fill,
            }),
            markup_limit: None,
            pin: None,
        });
        let flow = flow_of(&html);
        let front = flow.find("data:image/png;base64,").expect("a front cover");
        let title = flow.find("proof-title").expect("a title page");
        let back = flow.find("data:image/jpeg;base64,").expect("a back cover");
        assert!(front < title, "the front cover is the first leaf: {flow}");
        assert!(title < back, "the back cover is the last leaf: {flow}");
        assert!(flow.contains("data-fit=\"contain\""));
        assert!(flow.contains("data-fit=\"fill\""));
        assert!(html.contains(".proof-leaf[data-kind=\"plate\"] { padding: 0; }"));
        assert!(html.contains("object-fit: cover"));
        // The bytes are the archive's own, not a path the page could ask for.
        assert!(
            html.contains(&crate::pictures::base64(&[1u8, 2, 3])),
            "{html}"
        );
    }

    #[test]
    fn the_document_carries_the_paginator_and_its_two_containers() {
        // The three things the script cannot run without. A document missing
        // one of them renders as a blank window with no error anywhere, which
        // is the failure this asserts against.
        let html = render(&[], HashMap::new());
        assert!(html.contains("id=\"proof-flow\""), "{html}");
        assert!(html.contains("id=\"proof-leaves\""), "{html}");
        assert!(html.contains("id=\"proof-meta\""), "{html}");
        assert!(html.contains("window.__proof"), "{html}");
    }

    #[test]
    fn a_markup_limit_reaches_the_paginator_and_an_unbounded_render_sends_null() {
        let d = design();
        let b = book("N", &[]);
        let bodies = HashMap::new();
        let bounded = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: Some(PREVIEW_LEAVES),
            pin: None,
        });
        assert!(bounded.contains("\"markupLimit\":48"), "{bounded}");
        let whole = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        });
        assert!(whole.contains("\"markupLimit\":null"), "{whole}");
    }

    #[test]
    fn the_page_count_is_read_out_of_the_pdf_and_not_out_of_the_renderer() {
        // 043'S UNZIP FOR THIS FORMAT. The preview says how many leaves it cut;
        // this is what asks the FILE, and a build whose printer dropped a leaf
        // says so here rather than in a beta reader's inbox.
        let pdf = b"%PDF-1.4\n1 0 obj\n<</Type /Pages\n/Count 2\n/Kids [2 0 R 3 0 R]>>\nendobj\n\
                    2 0 obj\n<</Type /Page\n/Parent 1 0 R>>\nendobj\n\
                    3 0 obj\n<</Type /Page\n/Parent 1 0 R>>\nendobj\n%%EOF\n";
        assert_eq!(pdf_page_count(pdf), Some(2));
    }

    #[test]
    fn a_page_object_inside_a_compressed_stream_is_not_a_page() {
        // THE FIXTURE THAT TELLS THE TWO IMPLEMENTATIONS APART. A count that
        // scanned the whole file would read this as three pages, and nothing
        // about a real book would ever show it -- the recorded shape where a
        // fixture both implementations agree on makes the test about the
        // fixture.
        let pdf = b"%PDF-1.4\n1 0 obj\n<</Type /Page>>\nendobj\n\
                    4 0 obj\n<</Length 30>>\nstream\n/Type /Page /Type /Page\nendstream\nendobj\n\
                    %%EOF\n";
        assert_eq!(pdf_page_count(pdf), Some(1));
    }

    #[test]
    fn a_pages_node_is_not_a_page_and_neither_is_a_file_that_is_not_a_pdf() {
        assert_eq!(
            pdf_page_count(b"%PDF-1.4\n<</Type /Pages /Count 9>>\n%%EOF"),
            None
        );
        assert_eq!(pdf_page_count(b"not a pdf at all"), None);
        // A FILE THAT IS NOT A PDF AND CARRIES THE BYTES ANYWAY. Without this
        // the header check is a guard NO INPUT CAN REACH -- every non-PDF the
        // first draft tried also happened to hold no page object, so deleting
        // the check survived the whole suite. An HTML error page saved under a
        // `.pdf` name is exactly the case, and it is what the proof render
        // would produce if the print failed and something wrote the document
        // out instead.
        assert_eq!(pdf_page_count(b"<html>/Type /Page</html>"), None);
        // A truncated file: the stream never ends, so the count would be taken
        // over bytes nobody can open.
        assert_eq!(
            pdf_page_count(b"%PDF-1.4\n<</Type /Page>>\nstream\nabc"),
            None
        );
        // Whitespace between the key and the name is legal PDF.
        assert_eq!(
            pdf_page_count(b"%PDF-1.4\n<</Type\n  /Page>>\n%%EOF"),
            Some(1)
        );
    }

    #[test]
    fn the_gutter_minimum_is_kdps_table_and_it_is_banded_by_page_count() {
        // 040 LEFT THIS OPEN BECAUSE NOTHING KNEW THE PAGE COUNT. It does now.
        // Every boundary is asserted on both sides, because a threshold test
        // far from its boundary tests the arithmetic and not the comparison --
        // the recorded finding from the older `evaluateGates`.
        assert_eq!(gutter_minimum_um(23), None);
        assert_eq!(gutter_minimum_um(24), Some(9_525));
        assert_eq!(gutter_minimum_um(150), Some(9_525));
        assert_eq!(gutter_minimum_um(151), Some(12_700));
        assert_eq!(gutter_minimum_um(300), Some(12_700));
        assert_eq!(gutter_minimum_um(301), Some(15_875));
        assert_eq!(gutter_minimum_um(500), Some(15_875));
        assert_eq!(gutter_minimum_um(501), Some(19_050));
        assert_eq!(gutter_minimum_um(700), Some(19_050));
        assert_eq!(gutter_minimum_um(701), Some(22_225));
        assert_eq!(gutter_minimum_um(828), Some(22_225));
        // Past what KDP prints there is no minimum to quote, and inventing one
        // would be this application making up a printer's rule.
        assert_eq!(gutter_minimum_um(829), None);
    }

    #[test]
    fn the_fiction_presets_gutter_clears_the_band_a_novel_lands_in() {
        // The claim 040's own preset table makes, checked against the table
        // this module now owns rather than against a number retyped beside it.
        let d = design();
        assert!(d.margins.inner_um >= gutter_minimum_um(200).unwrap());
    }

    #[test]
    fn the_title_pages_byline_comes_out_of_the_one_table() {
        // A PROOF COPY'S ONLY IDENTITY CHANNEL IS INK, and it was measured: what
        // WebKitGTK's printer puts in a PDF's info dictionary is `/Title` (the
        // book's name) and `/Producer`, plus two dates. There is no `/Author`
        // and an `<meta name="author">` in the head reaches nothing. So this is
        // the row, and it is the table's row rather than a second list.
        let d = design();
        let b = book("The Harbour", &[]);
        let mut source = crate::identity::Identity {
            id: "i1".into(),
            rev: 1,
            ..crate::identity::Identity::default()
        };
        source.public.name = "Ada Vane".into();
        source.private.legal_name = "Margaret Hollis".into();
        let pin = crate::identity::pin_of(&source, 10);
        let bodies = HashMap::new();
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: Some(&pin),
        });
        let expected = crate::identity::emitted(
            crate::export::Format::Pdf,
            Some(&pin),
            "title-page",
        )
        .unwrap();
        assert!(
            html.contains(&format!("<p class=\"proof-byline\">{expected}</p>")),
            "{html}"
        );
        // On the TITLE LEAF and nowhere else: a byline on a cover plate or in
        // the running head is not what a printed book does.
        let title_leaf = title_leaf(&html);
        assert!(title_leaf.contains("proof-byline"), "{title_leaf}");
        assert_eq!(html.matches("proof-byline").count(), 2, "{html}");
        assert!(!html.contains("Margaret Hollis"), "{html}");
    }

    #[test]
    fn a_book_with_no_pin_has_no_byline_and_the_title_leaf_is_unchanged() {
        let html = render(&[], HashMap::new());
        assert!(!html.contains("proof-byline") || html.matches("proof-byline").count() == 1);
        let title_leaf = title_leaf(&html);
        assert!(!title_leaf.contains("proof-byline"), "{title_leaf}");
        // The control: the title itself is still on that leaf, so this cannot
        // pass against a leaf that lost everything.
        assert!(title_leaf.contains("The Harbour"), "{title_leaf}");
    }

    #[test]
    fn a_byline_with_markup_in_it_is_escaped_onto_the_leaf() {
        let d = design();
        let b = book("The Harbour", &[]);
        let mut source = crate::identity::Identity {
            id: "i1".into(),
            rev: 1,
            ..crate::identity::Identity::default()
        };
        source.public.name = "A & <script>".into();
        let pin = crate::identity::pin_of(&source, 10);
        let bodies = HashMap::new();
        let html = proof_document(&Proof {
            language: "en",
            book: &b,
            openings: test_openings(&b),
            bodies: &bodies,
            design: &d,
            style: plain(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: Some(&pin),
        });
        // ASSERTED ON THE LEAF AND NOT ON THE DOCUMENT: a proof document ends
        // with the paginator, so `!html.contains("<script>")` is a fact about
        // this file's own markup rather than about the escape.
        let leaf = title_leaf(&html);
        assert!(
            leaf.contains("<p class=\"proof-byline\">A &amp; &lt;script&gt;</p>"),
            "{leaf}"
        );
        assert!(!leaf.contains("<script>"), "{leaf}");
    }
}
