// app/shell-tauri/src-tauri/src/export.rs
// The Markdown export format. Pure: no I/O, no `Store`, no
// `Path`. Strings and JSON in, strings out.
//
// This is a SECOND walk of the tree `store::document_text` walks, not a copy of
// it. The counter discards `marks` (emphasis cannot change a word count) and
// collapses every block boundary to one space; export needs both. They are two
// rules over one data structure, in one language and one crate -- but they share
// the precondition stated on `document_text`: every non-text node in the page's
// schema is a block. An inline leaf (a hard_break, an image) would run its
// neighbours together here exactly as it would undercount there. The forward
// guard is `app/ui/test/editor-marks.test.ts`'s "every non-text node in the
// schema is a block", which names this walk as well as the counter.
//
// ACCEPTED LIMIT: a paragraph beginning with four spaces or a tab is a
// CommonMark indented code block, and nothing here prevents that. Escapes are
// inert inside a code block, so the exporter's own backslashes become visible
// there. It is a rendering loss and not a text loss -- every character survives,
// the block ends at the next blank line, and a reader recovers the prose -- and
// there is no fix that keeps both the writer's indentation and the rendering.
// Also recorded in the spec's Limits section.

use std::collections::HashMap;

/// Characters that can open inline markup or be misread as it. `&` is
/// deliberately absent, and so is the rest of the CommonMark ASCII-punctuation
/// set: escaping all of it makes a manuscript unreadable as plain text, which is
/// the entire reason the export is Markdown. The accepted loss is stated in the
/// spec's escaping section and pinned by a test.
///
/// `~` earns its place the way `` ` `` does, and for both of that character's
/// meanings at once: three of them open a code fence that runs to the end of the
/// containing block, and two of them are a GFM strikethrough delimiter.
const INLINE_METACHARACTERS: &[char] = &['\\', '*', '_', '[', ']', '`', '<', '~'];

/// Markers that only mean something at the start of a line.
const BLOCK_MARKERS: &[char] = &['#', '-', '+', '>'];

/// CommonMark allows up to three spaces of indentation before a block marker
/// still counts as one. A fourth space -- or a tab, which is four columns --
/// makes the line an indented code block instead, which is the accepted limit
/// recorded at the top of this file rather than a marker to escape.
const MAX_MARKER_INDENT: usize = 3;

/// Text escaped for a Markdown inline context. `line_start` enables the
/// additional block-marker escapes that only matter at the start of a line.
///
/// Applied PER LINE, not per call: one text node's text can hold newlines, and
/// every one of them starts a line a marker binds at. `line_start` governs only
/// the first, since only the first can be mid-line.
pub fn escape(text: &str, line_start: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for (n, line) in text.split('\n').enumerate() {
        if n > 0 {
            out.push('\n');
        }
        escape_line(line, line_start || n > 0, &mut out);
    }
    out
}

fn escape_line(line: &str, line_start: bool, out: &mut String) {
    // At most one character owes its backslash to the line-start rules: a block
    // marker is the first character after the indent, and an ordered-list marker
    // is the `.` or `)` closing the digit run that follows it.
    let mut block_marker: Option<usize> = None;
    if line_start {
        // Spaces are one byte each, so this byte count is also a column count.
        let indent = line.len() - line.trim_start_matches(' ').len();
        let rest = &line[indent..];
        if indent <= MAX_MARKER_INDENT {
            match rest.chars().next() {
                Some(c) if BLOCK_MARKERS.contains(&c) => block_marker = Some(indent),
                Some(c) if c.is_ascii_digit() => {
                    if let Some((i, c)) = rest.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
                        if c == '.' || c == ')' {
                            block_marker = Some(indent + i);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    for (i, c) in line.char_indices() {
        // One pass, so the backslash is escaped as input and never as output --
        // a second pass over the result would double-escape its own additions.
        if INLINE_METACHARACTERS.contains(&c) || block_marker == Some(i) {
            out.push('\\');
        }
        out.push(c);
    }
}

/// The number of `#` in the heading marker for an item at `depth` in the store's
/// walk. The project name is the H1, so items start at H2; beyond H6 the level
/// collapses and the item still appears, in order, with its title.
pub fn heading_level(depth: i64) -> usize {
    depth.saturating_add(2).clamp(2, 6) as usize
}

/// One stored body rendered as Markdown blocks, or None if it is not a document
/// this build can read. The acceptance rule is `store::document_text`'s: the
/// root must be a `doc`, not merely an object, because `{"foo":1}` is not a
/// document to the page either.
pub fn document_markdown(body: &str) -> Option<String> {
    document_markdown_counted(body).map(|(text, _)| text)
}

/// The same, plus the number of UNDERLINED RUNS the render dropped.
///
/// Markdown has no underline, so `wrap_marks` drops the mark on the
/// fall-through every unrecognised mark takes -- the text survives and the
/// emphasis does not. That behaviour is unchanged and deliberate: emitting
/// `<u>` would break the escaper, the importer and the readable mirror at
/// once. What this adds is the TALLY: a loss the writer is never told about is
/// the class of silent loss this repo deliberately avoids, so the figure rides
/// back with the export and lands in the notice.
///
/// Counted the way `mirror::pass` counts `unreadable_bodies`: a plain
/// accumulator threaded through the walk that already visits every node, never
/// a second pass over the tree.
///
/// A RUN, not a passage and not a document. A text node is the unit the store
/// holds and the unit this walk sees; two adjacent underlined runs a writer
/// reads as one phrase count twice, and the message says "run" for that reason.
/// Runs inside a block that renders to nothing are not counted -- nothing of
/// that block reached the file, so nothing of it was lost here.
pub fn document_markdown_counted(body: &str) -> Option<(String, u64)> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    if root.get("type").and_then(|t| t.as_str()) != Some(ROOT_TYPE) {
        return None;
    }
    let mut underlined = 0u64;
    let mut blocks: Vec<String> = Vec::new();
    if let Some(children) = root.get("content").and_then(|c| c.as_array()) {
        for child in children {
            let mut in_block = 0u64;
            if let Some(block) = block_markdown(child, &mut in_block) {
                blocks.push(block);
                underlined += in_block;
            }
        }
    }
    Some((blocks.join(BLOCK_SEPARATOR), underlined))
}

/// The root node type of a ProseMirror document, and the only one this build
/// will export.
const ROOT_TYPE: &str = "doc";

/// The mark this exporter drops and counts. RESTATED from the page's schema
/// (`app/ui/src/editor.ts`), never shared: these are two programs, and the same
/// rule holds here as for every gate threshold the harness restates.
const UNDERLINE_MARK: &str = "underline";

/// A blank line between blocks -- the one separator CommonMark reads as a
/// paragraph break without any other markup.
const BLOCK_SEPARATOR: &str = "\n\n";

/// One block's Markdown, or None if it renders to nothing. An empty block
/// contributes NO line: a line of whitespace is something a reader takes for
/// content, and a blank paragraph in the store is not content.
fn block_markdown(node: &serde_json::Value, underlined: &mut u64) -> Option<String> {
    let mut out = String::new();
    append_inline(node, &mut out, underlined);
    // Trailing whitespace on a Markdown line is significant (two spaces is a
    // hard break), so a trailing space the writer never sees must not become
    // markup they never asked for.
    let trimmed = out.trim_end();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn append_inline(node: &serde_json::Value, out: &mut String, underlined: &mut u64) {
    if node.get("type").and_then(|t| t.as_str()) == Some("text") {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            // The block markers bind at the start of a line: the start of the
            // block, or after a newline an earlier node in this block emitted.
            let line_start = out.is_empty() || out.ends_with('\n');
            out.push_str(&wrap_marks(&escape(text, line_start), node, underlined));
        }
        return;
    }
    // A node this build does not recognise still emits its descendants, on the
    // same principle as `document_text`: being strict deeper would let one
    // unknown node take a whole scene out of the writer's manuscript. A nested
    // block therefore flattens into its parent rather than vanishing.
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            append_inline(child, out, underlined);
        }
    }
}

/// `text` wrapped in the delimiters for whichever of `em` and `strong` the node
/// carries. Marks are a SET on a text node, so this is a membership test and not
/// a fold over the array -- `["em","strong"]` and `["strong","em"]` are the same
/// node and must produce the same bytes. Strong goes outside, em inside.
/// An unrecognised mark is ignored; its text is still emitted.
///
/// `underline` is the one dropped mark that is COUNTED rather than merely
/// ignored, because it is a mark this application's own editor writes: the
/// writer pressed a control for it and would otherwise never learn the export
/// does not carry it. Every other unrecognised mark is still ignored in
/// silence, which is right -- nothing in this build can produce one.
/// The marks this format can carry, named so a reader elsewhere can enumerate
/// them rather than infer them from the match arms below.
///
/// A THIRD MARK IS A DECISION, not an addition: it has to be answered on the
/// export path, on the import path, and on the mirror's accept path, where an
/// unanswered one is prose the writer loses the shape of without being told.
/// `mirror.rs`' round-trip test asserts this list, so a fourth mark added to
/// the page's schema without that answer fails there.
#[cfg(test)]
pub const MARKS_THE_FORMAT_CARRIES: [&str; 2] = ["strong", "em"];

fn wrap_marks(text: &str, node: &serde_json::Value, underlined: &mut u64) -> String {
    let mut em = false;
    let mut strong = false;
    if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
        for mark in marks {
            match mark.get("type").and_then(|t| t.as_str()) {
                Some("em") => em = true,
                Some("strong") => strong = true,
                Some(UNDERLINE_MARK) => *underlined += 1,
                _ => {}
            }
        }
    }
    let delimiter = match (strong, em) {
        (true, true) => "***",
        (true, false) => "**",
        (false, true) => "*",
        (false, false) => return text.to_string(),
    };
    format!("{delimiter}{text}{delimiter}")
}

/// The heading level the generated table of contents is given: the same level
/// a top-level chapter gets, because it IS one of the book's top-level
/// divisions and setting it deeper would file it under whatever preceded it.
const CONTENTS_LEVEL: usize = 2;

/// One line of the generated table of contents.
///
/// DATA, NOT A STRING, and that is 043's requirement rather than tidiness: an
/// EPUB `nav` document needs the same structure as XHTML with an `href` per
/// entry, and a Markdown path that baked the list into text would leave the next
/// renderer either parsing Markdown back or building a second, drifting copy of
/// the rule. `id` is carried for the same reason -- Markdown has nothing to do
/// with it and a link target needs it.
pub struct TocEntry {
    pub id: String,
    pub title: String,
    /// The heading level of the item this entry points at, 2..6. The list's
    /// indentation is derived from it, so an entry and its heading cannot
    /// disagree about where they sit.
    pub level: usize,
}

/// The book a renderer is handed: its name and its THREE runs, in the order they
/// are emitted.
///
/// THREE RUNS RATHER THAN ONE WALK PLUS A TYPE, and it is the whole of how 041
/// gives this module the fact it needs without giving it `store::Item`. Heading
/// level still comes from DEPTH ALONE (`heading_level`) and item type still
/// never reaches here; what reaches here is the SPLIT the store already made
/// (`store::book_walk`), which is a statement about order and not about types.
/// A renderer that had to ask "is this row front matter?" would be a second
/// place where that question is answered.
pub struct Book<'a> {
    pub name: &'a str,
    /// The heading the generated contents is given. Passed in, like `name`,
    /// because this module is pure and holds no writer-facing words of its own.
    pub contents_title: &'a str,
    /// Printed BEFORE the chapters and listed in the contents: the dedication,
    /// the foreword. Depths are already re-based by `store::book_walk`.
    pub front: &'a [(String, String, i64)],
    /// The chapter sequence, exactly the walk this module has always taken.
    pub chapters: &'a [(String, String, i64)],
    /// Printed AFTER the chapters: the acknowledgements, the afterword.
    pub back: &'a [(String, String, i64)],
}

/// Typed chapter styling is separate from the generic book's heading tuples.
/// A part starts a page but is not a decorated chapter opening.
#[derive(Default)]
pub struct ChapterOpenings {
    pub styled: std::collections::HashSet<String>,
    pub page: std::collections::HashSet<String>,
}

impl<'a> Book<'a> {
    /// The three runs in emission order. One place states it, so the contents
    /// and the body cannot disagree about what comes first.
    fn runs(&self) -> [&'a [(String, String, i64)]; 3] {
        [self.front, self.chapters, self.back]
    }
}

/// Every heading the file will carry, in file order, excluding the H1 and the
/// contents' own heading.
///
/// Built from the SAME runs and the SAME `heading_level` the body uses, so a
/// contents entry cannot name a level the heading below it does not have.
pub fn contents_of(book: &Book) -> Vec<TocEntry> {
    let mut out = Vec::new();
    for run in book.runs() {
        for (id, title, depth) in run {
            out.push(TocEntry {
                id: id.clone(),
                title: heading_title(title),
                level: heading_level(*depth),
            });
        }
    }
    out
}

/// The contents as one Markdown block: a nested bullet list, and NOTHING ELSE.
///
/// NO PAGE NUMBERS, because Markdown has no pages and a contents that promised
/// them would be a lie in every reader.
///
/// NO LINKS either, and that one is a decision rather than an absence. A
/// Markdown link needs an anchor, and heading anchors are not in CommonMark at
/// all -- every reader that has them invents its own slug. A link that resolves
/// in one reader and dangles in the next is worse than a plain line, and this
/// application's own reader (`import::parse`) has no anchors to resolve.
///
/// Two spaces per level, which is the column a parent's `- ` marker opens its
/// content at, so a nested entry is a nested list item and not an indented code
/// block.
fn contents_block(entries: &[TocEntry]) -> String {
    let mut out = String::new();
    for entry in entries {
        if !out.is_empty() {
            out.push('\n');
        }
        for _ in 0..entry.level.saturating_sub(CONTENTS_LEVEL) {
            out.push_str("  ");
        }
        // `trim_end` for the reason a heading is trimmed: an item with an empty
        // title would otherwise leave a trailing space, which is a CommonMark
        // hard break and markup nobody asked for.
        out.push_str(format!("- {}", entry.title).trim_end());
    }
    out
}

/// The whole book. Each run of `Book` is the store's depth-first walk as
/// `(id, title, depth)`; `bodies` maps item id -> stored body. Items with no
/// body, and items whose body this build cannot read, contribute a heading only
/// -- losing a chapter silently is the worst thing this feature can do.
///
/// The tuple is deliberate: this module must not depend on `store::Item`.
///
/// THE CONTENTS GOES DIRECTLY UNDER THE H1, above everything else including the
/// front matter. Three reasons, argued in the write-back: a Markdown file is
/// scrolled rather than paged, so the map is only useful before the thing it
/// maps; it is the one position that does not depend on WHICH kinds of front
/// matter a book has, which is what a per-kind ordering rule would cost; and
/// everything it lists is below it, so "the contents covers the whole file" is a
/// property a reader can check without knowing the format.
///
/// Assembled into ONE string rather than a `Vec<String>` joined at the end: the
/// join holds the whole manuscript twice at once, and at the `stress` fixture
/// that is ~12 MB of avoidable peak against 59 MB of headroom under the RSS
/// gate. Whether the remaining single copy needs streaming is what the graded
/// `export_ms` run at `stress` decides.
pub fn manuscript(book: &Book, bodies: &HashMap<String, String>) -> Manuscript {
    let mut underlined_runs = 0u64;
    let mut out = String::new();
    push_block(
        &mut out,
        format!("# {}", heading_title(book.name)).trim_end(),
    );
    let contents = contents_of(book);
    // A book with no items at all gets NO contents section rather than an empty
    // one: a heading over nothing is a section the writer did not ask for and
    // cannot fill from this screen.
    if !contents.is_empty() {
        push_block(
            &mut out,
            format!(
                "{} {}",
                "#".repeat(CONTENTS_LEVEL),
                heading_title(book.contents_title)
            )
            .trim_end(),
        );
        push_block(&mut out, &contents_block(&contents));
    }
    for run in book.runs() {
        for (id, title, depth) in run {
            push_block(
                &mut out,
                format!(
                    "{} {}",
                    "#".repeat(heading_level(*depth)),
                    heading_title(title)
                )
                .trim_end(),
            );
            if let Some((prose, underlined)) =
                bodies.get(id).and_then(|b| document_markdown_counted(b))
            {
                underlined_runs += underlined;
                if !prose.is_empty() {
                    push_block(&mut out, &prose);
                }
            }
        }
    }
    out.push('\n');
    Manuscript {
        bytes: out.into_bytes(),
        format: Format::Markdown,
        underlined_runs,
    }
}

/// Which file a render IS. Everything about the format that the bytes
/// themselves do not carry: what to call it, what to name the file, what a save
/// dialog should offer.
///
/// FOUR VARIANTS. The publishing track's design paid for the shape change
/// once, up front, rather than smeared across four -- so
/// this enum existed with one variant before EPUB, PDF and DOCX
/// (the editor handoff, not a publishing format) filled it.
///
/// The user-facing words a format needs -- the dialog title and the file-filter
/// label -- deliberately do NOT live here. This module is pure and has no
/// business holding host chrome; `commands::dialogs::export_save_dialog` matches
/// on the format and keeps those strings beside the dialog they configure.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Markdown,
    Epub,
    /// 044. A PROOF COPY -- a readable copy a novelist sends a beta reader --
    /// and deliberately not production print: no bleed, no imposition, no
    /// spreads, no CMYK. The alpha exclusion was amended for the writer-facing
    /// half of that and for nothing else.
    Pdf,
    /// 092. THE EDITOR HANDOFF -- an OOXML package a word processor opens,
    /// not the publishing track's business (that is EPUB and PDF, what a
    /// READER gets): a novelist's editor gets this one, and it comes back.
    /// Carries underline, which neither of the two above ever had a reason
    /// to.
    Docx,
}

impl Format {
    /// Every format this build writes, in the order a save dialog would offer
    /// them. ONE LIST, so `from_id` cannot go stale against `id` -- which is
    /// exactly how a word the page may send becomes a word the host refuses.
    pub const ALL: [Format; 4] = [Format::Markdown, Format::Epub, Format::Pdf, Format::Docx];

    /// The identifier that crosses the IPC boundary to the page, which words
    /// its own notice from it. A stable machine word, never a display name: the
    /// page's catalog owns what a writer reads.
    pub fn id(self) -> &'static str {
        match self {
            Format::Markdown => "markdown",
            Format::Epub => "epub",
            Format::Pdf => "pdf",
            Format::Docx => "docx",
        }
    }

    /// The format a stable machine word names, or None for a word this build
    /// does not write.
    ///
    /// THE ONE PLACE A REQUEST BECOMES A FORMAT. The page composes the word --
    /// which is a narrow enum and not a path, so it is nothing like
    /// `project_export_as`' refused destination argument -- and a word this
    /// build has no renderer for is refused here rather than defaulted to
    /// Markdown. Defaulting would write a manuscript in a format nobody asked
    /// for and report it as the one they did.
    pub fn from_id(id: &str) -> Option<Format> {
        Format::ALL.into_iter().find(|f| f.id() == id)
    }

    /// The filename extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Markdown => "md",
            Format::Epub => "epub",
            Format::Pdf => "pdf",
            Format::Docx => "docx",
        }
    }
}

/// A rendered manuscript, what it IS, and what rendering it cost.
///
/// A struct rather than a bare `String` because neither of the other two fields
/// is decoration: the command reports the count, the page says it in the export
/// notice, and the graded run gates on it.
///
/// BYTES, NOT A STRING, since 040. Markdown is text and every other format on
/// the publishing track is not -- an EPUB is a zip container and a PDF is
/// binary -- so a renderer that could only answer in `String` would have to be
/// rewritten by whichever slice added the first one, along with every caller.
/// The Markdown renderer still builds a `String` internally and hands over its
/// UTF-8: nothing about the emitted bytes changed when this type did.
pub struct Manuscript {
    pub bytes: Vec<u8>,
    /// What `bytes` is. Carried rather than assumed, because the caller writes
    /// the file, names it and reports it, and all three answers differ per
    /// format.
    pub format: Format,
    /// Underlined runs the render dropped. See `document_markdown_counted`.
    pub underlined_runs: u64,
}

fn push_block(out: &mut String, block: &str) {
    if !out.is_empty() {
        out.push_str(BLOCK_SEPARATOR);
    }
    out.push_str(block);
}

/// A title rendered as heading text.
///
/// Heading text is not at the start of a line -- the marker is -- so the
/// block-marker escapes would only add backslashes a reader has to read past.
/// The inline set still applies.
///
/// A newline becomes a space. A heading is one line, so a newline would end it
/// and leave the remainder as a stray paragraph: prose the store never held, and
/// one more heading in the file than the walk has items, which is exactly what
/// `export_structure` counts.
pub(crate) fn heading_title(title: &str) -> String {
    let one_line: String = title
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    escape(&one_line, false)
}

/// The rendered bytes as text.
///
/// TEST-ONLY, deliberately. Markdown is UTF-8 and every assertion in this file
/// and in `import.rs` is about the characters; a production caller must reach
/// for `bytes`, because the next two formats on the publishing track have no
/// such answer and a convenience that only works for one format is a trap for
/// whoever adds the second.
#[cfg(test)]
impl Manuscript {
    pub(crate) fn text(&self) -> &str {
        std::str::from_utf8(&self.bytes).expect("the Markdown render is UTF-8")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A book that is nothing but its chapters -- what every book was before
    /// 041, and what most of the tests below are about. The tests that are about
    /// the three runs build a `Book` themselves.
    fn book<'a>(name: &'a str, chapters: &'a [(String, String, i64)]) -> Book<'a> {
        Book {
            name,
            contents_title: "Contents",
            front: &[],
            chapters,
            back: &[],
        }
    }

    /// The manuscript this file's byte-for-byte guard renders. Deliberately
    /// awkward: a title carrying inline metacharacters, a title carrying a
    /// newline, block markers at the start of a line, a tilde fence, every mark
    /// combination the schema can produce plus one it drops, a whitespace-only
    /// block, a nested block that flattens, an item with no body, a body this
    /// build cannot read, and a depth past the heading clamp. A fixture whose
    /// blocks are all ordinary prose would agree with almost any renderer.
    fn golden_fixture() -> (Vec<(String, String, i64)>, HashMap<String, String>) {
        let items: Vec<(String, String, i64)> = vec![
            ("p1".into(), "Part One: *Salt*".into(), 0),
            ("c1".into(), "Chapter\nOne".into(), 1),
            ("s1".into(), "The Harbour".into(), 2),
            ("s2".into(), "No body at all".into(), 2),
            ("s3".into(), "Unreadable".into(), 3),
            ("s4".into(), "Deep".into(), 9),
        ];
        let mut bodies = HashMap::new();
        bodies.insert(
            "s1".to_string(),
            r##"{"type":"doc","content":[
                {"type":"paragraph","content":[
                  {"type":"text","text":"# not a heading, 1. not a list"}]},
                {"type":"paragraph","content":[
                  {"type":"text","text":"plain "},
                  {"type":"text","text":"emphatic","marks":[{"type":"em"}]},
                  {"type":"text","text":" and "},
                  {"type":"text","text":"loud","marks":[{"type":"strong"}]},
                  {"type":"text","text":" and "},
                  {"type":"text","text":"both","marks":[{"type":"strong"},{"type":"em"}]},
                  {"type":"text","text":" and "},
                  {"type":"text","text":"under","marks":[{"type":"underline"}]},
                  {"type":"text","text":"."}]},
                {"type":"paragraph","content":[
                  {"type":"text","text":"~~~ fence a_b a*b a\\b <tag> [link]"}]},
                {"type":"paragraph","content":[{"type":"text","text":"   "}]},
                {"type":"blockquote","content":[
                  {"type":"paragraph","content":[
                    {"type":"text","text":"nested flattens","marks":[{"type":"underline"}]}]}]}
              ]}"##
                .to_string(),
        );
        bodies.insert("s3".to_string(), "{\"type\":\"note\"}".to_string());
        bodies.insert(
            "s4".to_string(),
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"past six levels"}]}]}"#
                .to_string(),
        );
        (items, bodies)
    }

    /// THE BYTE-FOR-BYTE GUARD over the Markdown render.
    ///
    /// The expected value was captured from the build just
    /// before `Manuscript` carried bytes and a format -- and is pinned here so
    /// that reshaping, and everything the publishing track does to this path
    /// after it, has to leave Markdown alone or fail the build.
    ///
    /// **THE GENERATED CONTENTS CHANGED IT, DELIBERATELY AND FOR THE FIRST TIME.** The generated
    /// contents is a new block between the H1 and the first item, and every
    /// other byte is unchanged -- which is what this assertion is for. The list
    /// also shows the heading clamp coming through consistently: `Deep` sits at
    /// depth 9 and takes level 6 in the heading and indent 8 in the list, so an
    /// entry can never name a level its heading does not have. Every other test
    /// in this file asserts one rule with `contains`; this one asserts the whole
    /// file, which is the only assertion a silent change to block separation,
    /// trailing newlines or ordering cannot slip past.
    #[test]
    fn the_markdown_render_is_byte_for_byte_what_it_was() {
        let (items, bodies) = golden_fixture();
        let out = manuscript(&book("Ash & *Ember*", &items), &bodies);
        assert_eq!(out.text(), GOLDEN_MARKDOWN);
        // Not decoration: a render that dropped the count would still match the
        // bytes, because the dropped mark leaves no trace in them. That is the
        // whole reason the figure is carried separately.
        assert_eq!(out.underlined_runs, 2);
    }

    const GOLDEN_MARKDOWN: &str = "# Ash & \\*Ember\\*\n\n## Contents\n\n- Part One: \\*Salt\\*\n  - Chapter One\n    - The Harbour\n    - No body at all\n      - Unreadable\n        - Deep\n\n## Part One: \\*Salt\\*\n\n### Chapter One\n\n#### The Harbour\n\n\\# not a heading, 1. not a list\n\nplain *emphatic* and **loud** and ***both*** and under.\n\n\\~\\~\\~ fence a\\_b a\\*b a\\\\b \\<tag> \\[link\\]\n\nnested flattens\n\n#### No body at all\n\n##### Unreadable\n\n###### Deep\n\npast six levels\n";

    /// THE THREE RUNS, in the order the file carries them. A fixture with only
    /// front matter cannot tell an ordered emission from a concatenation that
    /// happens to agree.
    #[test]
    fn front_matter_prints_before_the_chapters_and_back_matter_after() {
        let front = vec![("d".to_string(), "Dedication".to_string(), 0)];
        let chapters = vec![("c".to_string(), "Chapter One".to_string(), 0)];
        let back = vec![("a".to_string(), "Acknowledgements".to_string(), 0)];
        let out = manuscript(
            &Book {
                name: "N",
                contents_title: "Contents",
                front: &front,
                chapters: &chapters,
                back: &back,
            },
            &HashMap::new(),
        );
        assert_eq!(
            out.text(),
            "# N\n\n## Contents\n\n- Dedication\n- Chapter One\n- Acknowledgements\n\n\
             ## Dedication\n\n## Chapter One\n\n## Acknowledgements\n"
        );
    }

    /// A dedication is prose, and the renderer reaches its body through the same
    /// map the chapters use. Without this a front-matter document would export
    /// as a heading with nothing under it.
    #[test]
    fn a_front_matter_document_carries_its_prose_into_the_file() {
        let front = vec![("d".to_string(), "Dedication".to_string(), 0)];
        let mut bodies = HashMap::new();
        bodies.insert(
            "d".to_string(),
            r#"{"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"For E."}]}]}"#
                .to_string(),
        );
        let out = manuscript(
            &Book {
                name: "N",
                contents_title: "Contents",
                front: &front,
                chapters: &[],
                back: &[],
            },
            &bodies,
        );
        assert!(
            out.text().contains("## Dedication\n\nFor E.\n"),
            "{}",
            out.text()
        );
    }

    /// THE CONTENTS IS STRUCTURE, and 043 consumes it as a `nav` document
    /// through `contents_of` (091: the `Manuscript` field that carried a
    /// second copy was read by nothing but this test, and is gone).
    #[test]
    fn the_contents_carries_the_id_title_and_level_of_every_heading() {
        let front = vec![("d".to_string(), "Dedication".to_string(), 0)];
        let chapters = vec![
            ("c".to_string(), "Chapter One".to_string(), 0),
            ("s".to_string(), "Opening".to_string(), 1),
        ];
        let book = Book {
            name: "N",
            contents_title: "Contents",
            front: &front,
            chapters: &chapters,
            back: &[],
        };
        let contents = contents_of(&book);
        let got: Vec<(&str, &str, usize)> = contents
            .iter()
            .map(|e| (e.id.as_str(), e.title.as_str(), e.level))
            .collect();
        assert_eq!(
            got,
            vec![
                ("d", "Dedication", 2),
                ("c", "Chapter One", 2),
                ("s", "Opening", 3)
            ]
        );
    }

    /// NO PAGE NUMBERS AND NO LINKS. Markdown has no pages, and heading anchors
    /// are not in CommonMark at all -- every reader invents its own slug, so a
    /// link would resolve in one and dangle in the next.
    #[test]
    fn the_contents_promises_no_page_numbers_and_links_to_nothing() {
        let chapters = vec![
            ("c".to_string(), "Chapter One".to_string(), 0),
            ("s".to_string(), "Opening".to_string(), 1),
        ];
        let out = manuscript(&book("N", &chapters), &HashMap::new());
        let block = out
            .text()
            .split("\n\n")
            .find(|b| b.starts_with("- "))
            .expect("the contents list is a block of its own");
        assert_eq!(block, "- Chapter One\n  - Opening");
    }

    /// A title's Markdown spelling is the SAME in the contents as in its
    /// heading, so a reader resolves one entry and one heading to one string.
    #[test]
    fn a_contents_entry_is_escaped_exactly_as_its_heading_is() {
        let chapters = vec![("c".to_string(), "Salt *and* Ember".to_string(), 0)];
        let out = manuscript(&book("N", &chapters), &HashMap::new());
        assert!(
            out.text().contains("- Salt \\*and\\* Ember\n"),
            "{}",
            out.text()
        );
        assert!(
            out.text().contains("## Salt \\*and\\* Ember\n"),
            "{}",
            out.text()
        );
    }

    /// A heading over nothing is a section the writer did not ask for.
    #[test]
    fn a_book_with_no_items_gets_no_contents_at_all() {
        let out = manuscript(&book("N", &[]), &HashMap::new());
        assert_eq!(out.text(), "# N\n");
        assert!(contents_of(&book("N", &[])).is_empty());
    }

    #[test]
    fn a_markdown_render_says_it_is_markdown() {
        let out = manuscript(&book("N", &[]), &HashMap::new());
        assert_eq!(out.format, Format::Markdown);
    }

    #[test]
    fn the_markdown_format_names_itself_and_its_extension() {
        // Both cross a boundary and neither may drift: `id` is what the page
        // words its notice from, and `extension` is what the save dialog offers
        // and what the default filename ends in. A test on one of them would
        // leave the other free.
        assert_eq!(Format::Markdown.id(), "markdown");
        assert_eq!(Format::Markdown.extension(), "md");
    }

    #[test]
    fn the_pdf_format_names_itself_and_its_extension() {
        // 044. The same pair the Markdown test pins and for its reason: `id` is
        // the machine word the page words its notice from, `extension` is what
        // the save dialog offers and what the default filename ends in.
        assert_eq!(Format::Pdf.id(), "pdf");
        assert_eq!(Format::Pdf.extension(), "pdf");
    }

    #[test]
    fn the_docx_format_names_itself_and_its_extension() {
        // 092, the same pair pinned above and for the same reason.
        assert_eq!(Format::Docx.id(), "docx");
        assert_eq!(Format::Docx.extension(), "docx");
    }

    #[test]
    fn every_format_this_build_writes_is_reachable_by_its_own_word_and_no_other() {
        // THE ROUND TRIP OVER THE WHOLE SET, not one variant at a time. A third
        // format added to `id` and forgotten in `from_id` is a word the page can
        // send and the host cannot answer, and the failure would be a refusal
        // that reads exactly like a page bug. Written over `ALL` so a fourth
        // costs nothing here and is covered anyway.
        for format in Format::ALL {
            assert_eq!(Format::from_id(format.id()), Some(format), "{format:?}");
        }
        // And the ids are distinct, or two formats share a word and one of them
        // is unreachable.
        let mut ids: Vec<&str> = Format::ALL.iter().map(|f| f.id()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before, "two formats share an id");
        assert_eq!(Format::from_id("postscript"), None);
    }

    #[test]
    fn escapes_inline_metacharacters() {
        assert_eq!(escape(r"a*b", false), r"a\*b");
        assert_eq!(escape("a_b", false), r"a\_b");
        assert_eq!(escape("a[b]c", false), r"a\[b\]c");
        assert_eq!(escape("a`b", false), r"a\`b");
        assert_eq!(escape("a<b", false), r"a\<b");
        // The backslash goes first, or escaping would double-escape its own output.
        assert_eq!(escape(r"a\b", false), r"a\\b");
        assert_eq!(escape(r"a\*b", false), r"a\\\*b");
    }

    #[test]
    fn leaves_ampersand_and_ordinary_punctuation_alone() {
        // Accepted fidelity loss, stated in the spec. Pinned so a later change
        // to the set is a deliberate one.
        assert_eq!(
            escape("Tom & Jerry, 3.14; \"quoted\"!", false),
            "Tom & Jerry, 3.14; \"quoted\"!"
        );
    }

    #[test]
    fn escapes_block_markers_only_at_line_start() {
        assert_eq!(escape("# not a heading", true), r"\# not a heading");
        assert_eq!(escape("- not a list", true), r"\- not a list");
        assert_eq!(escape("+ not a list", true), r"\+ not a list");
        assert_eq!(escape("> not a quote", true), r"\> not a quote");
        assert_eq!(escape("1. not a list", true), r"1\. not a list");
        assert_eq!(escape("12) not a list", true), r"12\) not a list");
        // The same text mid-line is untouched.
        assert_eq!(escape("# not a heading", false), "# not a heading");
        assert_eq!(escape("1. not a list", false), "1. not a list");
        // A digit run NOT followed by a marker is untouched even at line start.
        assert_eq!(escape("1984 was a year", true), "1984 was a year");
    }

    #[test]
    fn a_digit_run_at_line_start_escapes_only_its_marker() {
        // The escape belongs to the `.`, not to the digits: `1\. x` still reads
        // as "1." to a human, where `\1. x` would show a stray backslash.
        assert_eq!(escape("1. x", true), r"1\. x");
        // Only the FIRST such marker on the line, since only the first can open
        // a list.
        assert_eq!(escape("1. x 2. y", true), r"1\. x 2. y");
    }

    #[test]
    fn escapes_the_tilde_so_a_fence_cannot_open() {
        // Three tildes open a CommonMark code fence exactly as three backticks
        // do, and it is closed only by a matching fence or the end of the
        // containing block -- so an unescaped `~~~` in one scene swallows every
        // heading and every scene after it.
        assert_eq!(escape("~~~ fence", false), r"\~\~\~ fence");
        // The same escape covers GFM strikethrough, which would otherwise eat
        // the delimiters and render the text struck through.
        assert_eq!(escape("~~struck~~", false), r"\~\~struck\~\~");
    }

    #[test]
    fn leading_spaces_do_not_defeat_the_block_marker_escape() {
        // CommonMark allows up to three spaces before any block marker, so
        // inspecting index 0 alone lets a genuine heading through.
        assert_eq!(escape("  # Chapter Seven", true), r"  \# Chapter Seven");
        assert_eq!(escape(" # x", true), r" \# x");
        assert_eq!(escape("   - x", true), r"   \- x");
        assert_eq!(escape("  1. x", true), r"  1\. x");
        // Four spaces is an indented code block, not a marker position, and a
        // tab is four columns.
        assert_eq!(escape("    # x", true), "    # x");
        assert_eq!(escape("\t# x", true), "\t# x");
    }

    #[test]
    fn the_line_start_rule_applies_to_every_line_not_only_the_first() {
        // `escape` is called once per text node, but a node's text can hold
        // newlines, and every one of them starts a line the markers bind at.
        assert_eq!(escape("one\n# two", true), "one\n\\# two");
        assert_eq!(escape("one\n# two", false), "one\n\\# two");
        assert_eq!(escape("one\n  1. two", false), "one\n  1\\. two");
    }

    #[test]
    fn a_newline_inside_a_text_node_cannot_inject_a_heading() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"one\n# two"}]},
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "one\n\\# two");
    }

    #[test]
    fn a_marker_after_a_newline_in_an_earlier_node_is_still_escaped() {
        // The second node is not the start of the block, but it IS the start of
        // a line, because the node before it ended with one.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[
                {"type":"text","text":"one\n"},
                {"type":"text","text":"# two"},
            ]},
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "one\n\\# two");
    }

    #[test]
    fn a_newline_in_a_title_becomes_a_space() {
        // A heading is one line: the newline would end it and leave the rest as
        // a stray paragraph, which is one heading more than the walk has items.
        let items = vec![("c1".to_string(), "Line\nBreak".to_string(), 0i64)];
        let out = manuscript(&book("My\nNovel", &items), &HashMap::new());
        assert_eq!(
            out.text(),
            "# My Novel\n\n## Contents\n\n- Line Break\n\n## Line Break\n"
        );
    }

    #[test]
    fn a_heading_carries_no_trailing_whitespace() {
        // Two trailing spaces are a hard break, and the space before an empty
        // title is markup nobody asked for.
        let items = vec![
            ("a".to_string(), String::new(), 0i64),
            ("b".to_string(), "  ".to_string(), 0i64),
        ];
        assert_eq!(
            manuscript(&book("N", &items), &HashMap::new()).text(),
            "# N\n\n## Contents\n\n-\n-\n\n##\n\n##\n"
        );
        assert_eq!(manuscript(&book("", &[]), &HashMap::new()).text(), "#\n");
    }

    fn text_node(text: &str, marks: &[&str]) -> serde_json::Value {
        let m: Vec<_> = marks
            .iter()
            .map(|n| serde_json::json!({"type": n}))
            .collect();
        serde_json::json!({"type": "text", "text": text, "marks": m})
    }

    #[test]
    fn emphasis_wraps_once_per_mark() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[
                text_node("plain ", &[]),
                text_node("italic", &["em"]),
                text_node(" and ", &[]),
                text_node("bold", &["strong"]),
            ]}
        ]});
        assert_eq!(
            document_markdown(&doc.to_string()).unwrap(),
            "plain *italic* and **bold**"
        );
    }

    #[test]
    fn both_marks_nest_strong_outside() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("shout", &["em","strong"])]}
        ]});
        // Order in the marks array must not change the output.
        let rev = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("shout", &["strong","em"])]}
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "***shout***");
        assert_eq!(document_markdown(&rev.to_string()).unwrap(), "***shout***");
    }

    #[test]
    fn text_inside_a_mark_is_still_escaped() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("a*b", &["em"])]}
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), r"*a\*b*");
    }

    #[test]
    fn an_unknown_mark_is_ignored_but_its_text_is_kept() {
        // Same principle as document_text: an unrecognised node must never take
        // prose out of the writer's manuscript.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("kept", &["underline"])]}
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "kept");
    }

    #[test]
    fn an_underlined_run_is_counted_as_it_is_dropped() {
        // THE WHOLE OF THIS SLICE'S EXPORT SIDE. `underline` is a real mark in
        // the page's schema and Markdown has no underline, so `wrap_marks` drops
        // it on the same fall-through every unknown mark takes. What is new is
        // that the drop is COUNTED, so the writer can be told. A build that
        // emitted the text and reported nothing would pass the test above and
        // ship a silent loss.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[
                text_node("plain ", &[]),
                text_node("under", &["underline"]),
            ]}
        ]});
        let (text, underlined) = document_markdown_counted(&doc.to_string()).unwrap();
        assert_eq!(text, "plain under");
        assert_eq!(underlined, 1);
    }

    #[test]
    fn an_underline_carried_beside_another_mark_is_still_counted() {
        // The mark is a SET on a text node, so a run can be bold AND underlined.
        // The bold survives, the underline does not, and the run is counted once
        // rather than being missed because the node produced delimiters.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("both", &["strong","underline"])]}
        ]});
        let (text, underlined) = document_markdown_counted(&doc.to_string()).unwrap();
        assert_eq!(text, "**both**");
        assert_eq!(underlined, 1);
    }

    #[test]
    fn a_document_with_no_underline_counts_none() {
        // The control. A count that was really "did this document have any
        // marks" would answer 1 here, and the notice would tell a writer they
        // had lost something they never wrote.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[
                text_node("italic", &["em"]),
                text_node(" and ", &[]),
                text_node("bold", &["strong"]),
            ]}
        ]});
        assert_eq!(
            document_markdown_counted(&doc.to_string()).unwrap(),
            ("*italic* and **bold**".to_string(), 0)
        );
    }

    #[test]
    fn a_block_that_renders_to_nothing_contributes_no_underline_count() {
        // A paragraph holding only whitespace emits NO line -- a line of
        // whitespace is something a reader takes for content -- so nothing of
        // it reached the file and nothing of it was lost. Counting it would
        // tell a writer that a passage lost its underline when no passage was
        // written at all, which is the same class of lie as not telling them.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("   ", &["underline"])]},
            {"type":"paragraph","content":[text_node("kept", &["underline"])]},
        ]});
        let (text, underlined) = document_markdown_counted(&doc.to_string()).unwrap();
        assert_eq!(text, "kept");
        assert_eq!(underlined, 1);
    }

    #[test]
    fn underlined_runs_are_counted_across_blocks_and_documents() {
        // Per RUN, not per document and not per block: `manuscript` walks every
        // item, and the figure the writer is shown is the whole manuscript's.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("one", &["underline"])]},
            {"type":"paragraph","content":[
                text_node("two", &["underline"]),
                text_node(" and three", &[]),
            ]},
        ]});
        let mut bodies = HashMap::new();
        bodies.insert("a".to_string(), doc.to_string());
        let other = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[text_node("four", &["underline"])]}
        ]});
        bodies.insert("b".to_string(), other.to_string());
        let items = vec![
            ("a".to_string(), "First".to_string(), 0),
            ("b".to_string(), "Second".to_string(), 0),
        ];
        let written = manuscript(&book("N", &items), &bodies);
        assert_eq!(written.underlined_runs, 3);
        // And every character still reached the file: the count is a report, not
        // a refusal.
        assert!(written.text().contains("one"), "{}", written.text());
        assert!(
            written.text().contains("two and three"),
            "{}",
            written.text()
        );
        assert!(written.text().contains("four"), "{}", written.text());
    }

    #[test]
    fn an_unreadable_body_contributes_no_underline_count() {
        // A body this build cannot read contributes a heading and nothing else,
        // and it must not contribute a figure either: "3 passages lost their
        // underline" about a document that was never walked is a lie about the
        // one case where something really did go missing.
        let mut bodies = HashMap::new();
        bodies.insert("a".to_string(), "{not json at all".to_string());
        let items = vec![("a".to_string(), "First".to_string(), 0)];
        assert_eq!(manuscript(&book("N", &items), &bodies).underlined_runs, 0);
    }

    #[test]
    fn blocks_are_separated_by_a_blank_line() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"one"}]},
            {"type":"paragraph","content":[{"type":"text","text":"two"}]},
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "one\n\ntwo");
    }

    #[test]
    fn an_empty_paragraph_contributes_no_stray_markup() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"one"}]},
            {"type":"paragraph"},
            {"type":"paragraph","content":[{"type":"text","text":"two"}]},
        ]});
        // An empty block must not produce a line of whitespace that a reader
        // would take for content.
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "one\n\ntwo");
    }

    #[test]
    fn an_unrecognised_block_still_emits_its_text() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"blockquote","content":[
                {"type":"paragraph","content":[{"type":"text","text":"nested"}]}]},
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "nested");
    }

    #[test]
    fn a_body_that_is_not_a_document_is_rejected() {
        assert!(document_markdown(r#"{"foo":1}"#).is_none());
        assert!(document_markdown("not json").is_none());
        assert!(document_markdown(r#"{"type":"paragraph"}"#).is_none());
    }

    #[test]
    fn block_markers_are_escaped_at_the_start_of_each_block() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"# chapter one"}]},
        ]});
        assert_eq!(
            document_markdown(&doc.to_string()).unwrap(),
            r"\# chapter one"
        );
    }

    #[test]
    fn a_block_keeps_no_trailing_whitespace() {
        // Two trailing spaces are a hard break in CommonMark, so a space the
        // writer cannot see would become markup they never asked for.
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"one  "}]},
            {"type":"paragraph","content":[{"type":"text","text":"two"}]},
        ]});
        assert_eq!(document_markdown(&doc.to_string()).unwrap(), "one\n\ntwo");
    }

    #[test]
    fn an_empty_document_is_readable_and_contributes_nothing() {
        let empty = r#"{"type":"doc","content":[]}"#;
        assert_eq!(document_markdown(empty).unwrap(), "");
        let items = vec![("s1".to_string(), "Opening".to_string(), 0i64)];
        let mut bodies = HashMap::new();
        bodies.insert("s1".to_string(), empty.to_string());
        // A readable but empty scene must not open a blank block, which would
        // put three newlines between two headings.
        assert_eq!(
            manuscript(&book("N", &items), &bodies).text(),
            "# N\n\n## Contents\n\n- Opening\n\n## Opening\n"
        );
    }

    #[test]
    fn manuscript_puts_the_project_name_first_and_items_under_it() {
        let items = vec![
            ("p1".to_string(), "Part One".to_string(), 0i64),
            ("c1".to_string(), "Chapter One".to_string(), 1i64),
            ("s1".to_string(), "Opening".to_string(), 2i64),
        ];
        let mut bodies = HashMap::new();
        bodies.insert("s1".to_string(),
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"It began."}]}]}"#.to_string());
        let out = manuscript(&book("My Novel", &items), &bodies);
        assert_eq!(
            out.text(),
            "# My Novel\n\n## Contents\n\n- Part One\n  - Chapter One\n    - Opening\n\n## Part One\n\n### Chapter One\n\n#### Opening\n\nIt began.\n"
        );
    }

    #[test]
    fn an_item_with_no_body_contributes_a_heading_only() {
        let items = vec![("c1".to_string(), "Chapter One".to_string(), 0i64)];
        let out = manuscript(&book("N", &items), &HashMap::new());
        assert_eq!(
            out.text(),
            "# N\n\n## Contents\n\n- Chapter One\n\n## Chapter One\n"
        );
    }

    #[test]
    fn a_title_containing_markup_is_escaped_in_its_heading() {
        let items = vec![("c1".to_string(), "A *starred* title".to_string(), 0i64)];
        let out = manuscript(&book("N", &items), &HashMap::new());
        assert!(out.text().contains(r"## A \*starred\* title"));
    }

    #[test]
    fn heading_level_collapses_but_never_rises_above_h6() {
        assert_eq!(heading_level(0), 2);
        assert_eq!(heading_level(4), 6);
        assert_eq!(heading_level(5), 6);
        assert_eq!(heading_level(63), 6);
        // The store's walk never emits a negative depth, but the marker must
        // never be shorter than H2 -- `#` alone would make an item collide with
        // the project name.
        assert_eq!(heading_level(-1), 2);
        assert_eq!(heading_level(i64::MAX), 6);
    }

    #[test]
    fn an_unreadable_body_does_not_take_the_scene_out_of_the_manuscript() {
        // The heading must still appear. Losing a chapter silently is the worst
        // thing this feature can do.
        let items = vec![("s1".to_string(), "Opening".to_string(), 0i64)];
        let mut bodies = HashMap::new();
        bodies.insert("s1".to_string(), "corrupt".to_string());
        let out = manuscript(&book("N", &items), &bodies);
        assert!(out.text().contains("## Opening"));
    }
}
