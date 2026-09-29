// app/harness/src/mirror-read.ts
// The verifier's reader for ONE mirror file.
//
// AN INDEPENDENT RESTATEMENT, never the emitter and never the importer. That is
// the standing rule for every oracle here: a gate that checked the host's
// output with the host's own parser would agree with it about anything,
// including a shared mistake. `markdown-read.ts` is that reader for the single
// concatenated export; this is its sibling for the mirror.
//
// TWO FILE-LEVEL RULES, ONE INLINE RULE, which is the split the design names
// (`readable-mirror-design.md:549-559`). `readManuscript` treats the first H1
// as the PROJECT and everything under it as sections, because it reads a whole
// manuscript. A mirror file is ONE document: front matter, then an H1 that *is*
// the document, then its prose. The inline syntax genuinely is one format, so
// `stripInline` is shared -- restating THAT would be a second definition of
// emphasis and escaping, which is the thing this file exists to avoid.
//
// This is deliberately NOT a port of `mirror::read_file`. It refuses different
// things and it says so below: it is a reader for a gate, not a parser for a
// writer.
import { stripInline } from "./markdown-read";

export interface DocumentFile {
  /** The front matter's `id`, or null when there is none. */
  id: string | null;
  /** The front matter's `type`, or null when there is none. */
  itemType: string | null;
  /** Front-matter keys other than `id` and `type`, in the order they appear. */
  extra: string[];
  /** The `# ` heading, escapes undone and emphasis delimiters removed. */
  title: string;
  /** The prose blocks, in order, each with its escapes undone. */
  blocks: string[];
  /** The prose as one string, blocks joined by a single space.
   *
   *  ONE SPACE, matching `store::document_text` and ProseMirror's
   *  `textBetween(0, size, " ")`. The joining rule matters as much as the
   *  reading one: a gate that joined with a newline would disagree with every
   *  word count in this application. */
  text: string;
  /** Why the file is not a mirror document, or null when it is one. */
  problem: string | null;
}

const HEADING = /^# (.*)$/;
const BARE_H1 = "#";

const broken = (problem: string): DocumentFile => ({
  id: null,
  itemType: null,
  extra: [],
  title: "",
  blocks: [],
  text: "",
  problem,
});

/** Read one file the mirror wrote.
 *
 *  REFUSES rather than guesses. A file with no fence, an unclosed fence or no
 *  top-level heading is reported as a problem and never as an empty document:
 *  an empty document is what a scene the writer emptied looks like, and a gate
 *  that could not tell those apart would pass a mirror of blank files.
 */
export function readDocumentFile(source: string): DocumentFile {
  const lines = source.split("\n");
  if (lines[0] !== "---") return broken("no front-matter fence");

  let id: string | null = null;
  let itemType: string | null = null;
  const extra: string[] = [];
  let at = 1;
  let closed = false;
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    if (line === "---") {
      closed = true;
      at++;
      break;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      extra.push(line.trim());
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "id") id = value;
    else if (key === "type") itemType = value;
    else extra.push(key);
  }
  if (!closed) return broken("the front matter is never closed");

  // Only blank lines may precede the heading. Prose above it would be prose
  // this reader silently promoted into a title.
  while (at < lines.length && lines[at]!.trim() === "") at++;
  const headingLine = lines[at];
  if (headingLine === undefined) return broken("no top-level heading");
  let title: string;
  if (headingLine === BARE_H1) {
    // An untitled item mirrors as `# ` with the trailing space trimmed by
    // nobody -- the host writes `# ` and the empty title follows it. Both
    // spellings are the same document.
    title = "";
  } else {
    const match = headingLine.match(HEADING);
    if (match === null) return broken("no top-level heading");
    title = stripInline(match[1]!).text;
  }
  at++;

  const blocks: string[] = [];
  for (const chunk of lines.slice(at).join("\n").split("\n\n")) {
    const block = chunk.replace(/^\n+|\n+$/g, "");
    if (block.trim() === "") continue;
    // A block is joined by single spaces, matching the paragraph rule the host
    // reads with: a paragraph is a run of non-blank lines.
    blocks.push(stripInline(block.split("\n").map((l) => l.trim()).join(" ")).text);
  }

  return { id, itemType, extra, title, blocks, text: blocks.join(" "), problem: null };
}
