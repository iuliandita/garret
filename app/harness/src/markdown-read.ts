// app/harness/src/markdown-read.ts
// A reader for the Markdown syntax this project's exporter emits.
//
// THE RIG'S OWN RESTATEMENT, and that is the whole point. It is written from
// the FORMAT as the design spec states it
// -- escaping set, emphasis delimiters, blank line between blocks, one heading
// per walked item), never from `export.rs`'s code, and it imports nothing from
// the host. A reader derived from the emitter would check the exporter against
// itself and `export_text_fidelity` would grade a tautology.
//
// WHAT IT IS NOT: a CommonMark implementation. It handles the syntax this
// exporter emits and nothing else -- no links, no lists, no code fences, no
// entity references. That limit is stated on the fidelity gate's threshold
// string, because the verdict line is what gets read and quoted, and
// "export_text_fidelity PASS" would otherwise sound like a claim about every
// Markdown reader in the world. It is a necessary condition: the exporter can
// read back what it wrote.

/** One item's heading and the prose under it, in the file's order. */
export interface Section {
  /** Number of `#`. The exporter emits 2..6 for items; the H1 is the project. */
  level: number;
  /** The heading text, unescaped. */
  title: string;
  /** The prose blocks under it, unescaped and stripped of emphasis. */
  blocks: string[];
  /** `blocks` joined with ONE space, which is `document_text`'s own joining
   *  rule -- so this is directly comparable to the text the store holds. */
  text: string;
  /** Every run that was wrapped in emphasis delimiters, unescaped. */
  emphasized: string[];
}

export interface Manuscript {
  /** The H1's text, or null when the file does not open with one. Null is a
   *  finding, not a default: inventing a title would hide a malformed file. */
  title: string | null;
  /** The GENERATED table of contents: its entries' texts in file order, or null
   *  when the file carries none.
   *
   *  ITS OWN FIELD AND NOT A SECTION, because it is not an item. Left in
   *  `sections` it would be one heading more than the walk has items --
   *  `export_structure` compares those counts -- and its bullet list would be
   *  counted as prose, which is `export_word_count_agrees`' figure. Both gates
   *  would report a defect against a correct exporter.
   *
   *  Recognised STRUCTURALLY, never by its heading's words: the rig restates the
   *  FORMAT, and "Contents" is a string the host owns and a later build may
   *  translate. A block whose every line is an unescaped list marker is
   *  something prose cannot be -- `-` at the start of a line is escaped as `\-`
   *  by the exporter -- and its position directly under the H1 is the other
   *  half. */
  contents: string[] | null;
  sections: Section[];
  /** Prose blocks that appeared before any item heading. Counted rather than
   *  silently dropped -- prose belonging to no section is text the walk cannot
   *  account for, and a reader that swallowed it would let the fidelity
   *  comparison pass over a manuscript missing a scene's worth of words. */
  orphanBlocks: number;
}

/** The deepest heading the format has. Depth beyond this collapses onto
 *  `######`: a recorded limit, not a defect. */
const MAX_HEADING_LEVEL = 6;

/**
 * The heading level the item at a given walk depth belongs at.
 *
 * THE RIG'S OWN RESTATEMENT of `min(depth + 2, 6)`, taken from the format as
 * the design spec states it, never imported from `export.rs`.
 * `export_structure` grades the exported levels
 * against this; a rule taken from the emitter would check the exporter against
 * itself and that half of the gate would be a tautology.
 *
 * `+ 2` rather than `+ 1` because H1 is the manuscript's title. No item ever
 * gets one, which is also why the H1 is excluded from the heading count.
 */
export function expectedHeadingLevel(depth: number): number {
  return Math.min(depth + 2, MAX_HEADING_LEVEL);
}

/** Unicode's whitespace set, not JavaScript's `\s`. They differ: `\s` omits
 *  U+0085 (which Rust's `char::is_whitespace` counts) and includes U+FEFF
 *  (which it does not), and this rig compares its own word count against the
 *  host's. */
const WHITESPACE = /\p{White_Space}+/gu;

/** Every run of whitespace collapsed to one space, then trimmed.
 *
 *  Applied to BOTH sides of the fidelity comparison, and the reason is an
 *  asymmetry in the format rather than a convenience: the exporter `trim_end`s
 *  every block (two trailing spaces are a CommonMark hard break) while the
 *  store keeps whatever the writer typed, and it separates blocks with a blank
 *  line where `document_text` separates them with one space. A scene whose
 *  stored text ends in a space is not an export defect. The cost is that a
 *  whitespace-only difference cannot be detected, which the gate's threshold
 *  string states. */
export function normalizeText(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/** Words as this project defines them: maximal runs of non-whitespace. */
export function countWords(text: string): number {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? 0 : normalized.split(" ").length;
}

/** The emphasis delimiter this exporter emits, and the only inline markup it
 *  emits at all. Read as RUNS: `***` is one delimiter, not three. */
const EMPHASIS = "*";

export interface StrippedBlock {
  text: string;
  emphasized: string[];
}

/**
 * One block with its escapes undone and its emphasis delimiters removed.
 *
 * ORDER IS LOAD-BEARING: the backslash is honoured first, so `\*` is a literal
 * asterisk the writer typed and never a delimiter. A reader that stripped `*`
 * first would delete a character out of the manuscript and the fidelity gate
 * would report the loss as the exporter's.
 *
 * The delimiters are AMBIGUOUS and the text is not. Two adjacent text nodes
 * carrying the same mark emit `*a**b*`, whose middle `**` is one run to any
 * reader; `emphasized` therefore records what it can, and an unclosed run is
 * still reported rather than dropped. `text` is unaffected either way, and
 * `text` is what `export_text_fidelity` compares.
 */
export function stripInline(block: string): StrippedBlock {
  let text = "";
  const emphasized: string[] = [];
  let open = false;
  let captured = "";

  for (let i = 0; i < block.length; i++) {
    const c = block[i]!;
    if (c === "\\" && i + 1 < block.length) {
      const literal = block[i + 1]!;
      text += literal;
      if (open) captured += literal;
      i++;
      continue;
    }
    if (c === EMPHASIS) {
      while (i + 1 < block.length && block[i + 1] === EMPHASIS) i++;
      if (open) {
        emphasized.push(captured);
        captured = "";
      }
      open = !open;
      continue;
    }
    text += c;
    if (open) captured += c;
  }
  if (open) emphasized.push(captured);

  return { text, emphasized };
}

/** One line of the generated contents: any indent, a `-`, then optionally a
 *  space and the entry. `null` for anything else.
 *
 *  Prose can never match. The exporter escapes a `-` at the start of a line (up
 *  to three columns of indent) as `\-`, so an unescaped one at index 0 of a
 *  line is markup this exporter wrote. */
const CONTENTS_LINE = /^ *-(?: (.*))?$/;

/** Where the generated contents is, or null if the file carries none.
 *
 *  THE RULE IS SELF-VERIFYING, and that is what makes it safe: the entries must
 *  be, in order and in full, the titles of every heading that follows. That is
 *  the definition of a table of contents for this file, so a chapter whose prose
 *  happens to open with a list keeps it. Position is pinned too -- at most the
 *  file's own H1 may precede it.
 *
 *  Written from the FORMAT, and it is deliberately the same rule `import::parse`
 *  applies. Two independent statements of it are the point: they are what fail
 *  when the emitter and the reader stop agreeing. */
function findContents(chunks: string[]): { at: number; entries: string[] } | null {
  const headings: { at: number; level: number; text: string }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const match = chunks[i]!.match(HEADING);
    if (match !== null) {
      headings.push({ at: i, level: match[1]!.length, text: stripInline(match[2] ?? "").text });
    }
  }
  const candidate =
    headings[0]?.level === 1 ? headings[1] : headings.length > 0 ? headings[0] : undefined;
  if (candidate === undefined) return null;
  const entries = contentsEntries(chunks[candidate.at + 1] ?? "");
  if (entries === null) return null;
  const following = headings.filter((h) => h.at > candidate.at).map((h) => h.text);
  return entries.length === following.length && entries.every((e, n) => e === following[n])
    ? { at: candidate.at, entries }
    : null;
}

/** A block read as the contents' bullet list, or null if it is anything else. */
function contentsEntries(chunk: string): string[] | null {
  const lines = chunk.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(CONTENTS_LINE);
    if (match === null) return null;
    out.push(stripInline(match[1] ?? "").text);
  }
  return out.length === 0 ? null : out;
}

/** A heading is a whole block on one line: 1..6 `#` then optionally a space and
 *  the title. A bare `##` is legal -- the exporter emits it for an item with an
 *  empty title, because the trailing space would be markup nobody asked for.
 *
 *  Prose can never match, for two separate reasons. A `#` at the start of a
 *  line is escaped as `\#`, and behind four or more spaces it is not at index
 *  0. And a multi-line block cannot match at all: `.` does not cross a newline
 *  and there is no `s` flag, so `## Title\nmore` is prose, not a heading with a
 *  stray line under it. */
const HEADING = /^(#{1,6})(?: (.*))?$/;

/**
 * The whole file, as sections in the order the store's walk produced them.
 *
 * Sections are aligned to walk items BY INDEX by the caller, never by title:
 * 2,292 of the 20,000 stress items share a title. `export_structure` compares
 * the counts, which is what makes the index alignment sound.
 */
export function readManuscript(markdown: string): Manuscript {
  // The exporter ends the file with exactly one newline, which would otherwise
  // make the final block look like it carries a trailing blank line.
  const body = markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown;
  const chunks = body.split("\n\n").filter((c) => c.length > 0);
  const sections: Section[] = [];
  let title: string | null = null;
  let contents: string[] | null = null;
  let orphanBlocks = 0;
  const found = findContents(chunks);

  for (let at = 0; at < chunks.length; at++) {
    const chunk = chunks[at]!;
    const heading = chunk.match(HEADING);
    if (heading !== null) {
      const level = heading[1]!.length;
      const headingText = stripInline(heading[2] ?? "").text;
      // The project's own H1 is not an item, and the exporter never emits one
      // for an item (`heading_level` clamps to 2..6). A second H1 would be a
      // finding, and is recorded as a section so the count gate can see it.
      if (level === 1 && title === null && sections.length === 0) {
        title = headingText;
        continue;
      }
      // THE GENERATED CONTENTS, taken out of the section list entirely. Located
      // before the loop, because deciding it needs every heading in the file.
      if (found !== null && at === found.at) {
        contents = found.entries;
        at++;
        continue;
      }
      sections.push({ level, title: headingText, blocks: [], text: "", emphasized: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current === undefined) {
      orphanBlocks++;
      continue;
    }
    const stripped = stripInline(chunk);
    current.blocks.push(stripped.text);
    current.emphasized.push(...stripped.emphasized);
  }

  for (const section of sections) section.text = section.blocks.join(" ");
  return { title, contents, sections, orphanBlocks };
}
