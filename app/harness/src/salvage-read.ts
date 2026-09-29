// app/harness/src/salvage-read.ts
// The harness's OWN restatement of the shape `salvage` writes, and the rig's
// only reader of a recovered file.
//
// WRITTEN FROM THE DECISION RECORDS, NOT FROM `salvage.rs`. Every sample this
// parses is quoted verbatim in the four records that specified the format --
// 046 ("What a writer sees"), 048 (Decision 3's cast section), 049 (Decision 4's
// `comments.md`) and 050 (Decision 2's `snapshots.md`) -- and the tests parse
// those samples, not output taken from a run. `markdown-read.ts` carries the
// same rule and its header gives the reason: a reader built out of the emitter
// checks the emitter against itself, and every gate standing on it grades a
// tautology.
//
// It is NOT a CommonMark implementation and does not try to be. It knows the
// six shapes salvage emits and refuses to guess at anything else.

/** One heading and the lines under it, up to the next heading of ANY level. */
export interface Block {
  level: number;
  heading: string;
  lines: string[];
}

/** A recovered file, split into its title and its headed blocks.
 *
 *  The title is the `# <project> - <kind>` line every one of the six carries.
 *  `null` when the file does not open with one, which is a defect and never a
 *  shape this reader invents a default for. */
export interface Document {
  title: string | null;
  blocks: Block[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
/** The id line: a single backticked token alone on its line. */
const ID_LINE = /^`([^`]+)`$/;

export function parseDocument(text: string): Document {
  let title: string | null = null;
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(HEADING);
    if (m === null) {
      if (blocks.length > 0) blocks[blocks.length - 1]!.lines.push(line);
      continue;
    }
    const level = m[1]!.length;
    const heading = m[2]!.trim();
    if (level === 1 && title === null && blocks.length === 0) {
      title = heading;
      continue;
    }
    blocks.push({ level, heading, lines: [] });
  }
  return { title, blocks };
}

/** The lines of a block with blank ones at both ends removed. */
export function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/** The backticked id salvage prints under every heading, or null when the block
 *  carries none.
 *
 *  Read from the line IMMEDIATELY under the heading and nowhere else: a note's
 *  `> quote` and a member's detail bullets may hold backticks of the writer's
 *  own, and a scan of the whole block would take one of those for an identity. */
export function idOf(block: Block): string | null {
  for (const line of trimBlank(block.lines)) {
    const m = line.trim().match(ID_LINE);
    if (m !== null) return m[1]!;
    if (line.trim() !== "") return null;
  }
  return null;
}

/** Paragraph text of a block: everything after the id line, blank-trimmed, less
 *  whatever the caller has already claimed. */
function paragraphs(block: Block, claimed: (line: string) => boolean): string[] {
  const out: string[] = [];
  let sawId = false;
  for (const line of trimBlank(block.lines)) {
    const t = line.trim();
    if (!sawId && ID_LINE.test(t)) {
      sawId = true;
      continue;
    }
    if (t === "" || claimed(t)) continue;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- synopses.md

export interface RecoveredSynopsis {
  /** The item's title when it survived, its id when it did not. */
  heading: string;
  id: string | null;
  body: string;
}

export function readSynopses(text: string): RecoveredSynopsis[] {
  return parseDocument(text)
    .blocks.filter((b) => b.level === 2)
    .map((b) => ({
      heading: b.heading,
      id: idOf(b),
      body: paragraphs(b, () => false).join("\n"),
    }));
}

// -------------------------------------------------------------------- cast.md

export interface RecoveredMember {
  /** The `## Characters` / `## Places` / `## weather` group it sits in. */
  group: string;
  name: string;
  id: string | null;
  summary: string;
  details: { label: string; value: string }[];
  /** The `pictures/<file>` line, or null when no photograph was copied. */
  picture: string | null;
  appearsIn: { title: string | null; id: string }[];
}

const DETAIL = /^- \*\*(.+?)\*\*:\s?(.*)$/;
const PICTURE = /^pictures\/(\S+)$/;
const APPEARS_MARKER = "Appears in:";
/** `- <title> \`<id>\`` and `- \`<id>\``: the title is absent when the item did
 *  not survive, which 048 states as "the title when the item survived and the id
 *  when it did not, and the id either way". */
const REFERENCE = /^- (?:(.*?)\s)?`([^`]+)`\s*(.*)$/;

export function readCast(text: string): RecoveredMember[] {
  const out: RecoveredMember[] = [];
  let group = "";
  for (const block of parseDocument(text).blocks) {
    if (block.level === 2) {
      group = block.heading;
      continue;
    }
    if (block.level !== 3) continue;
    const details: { label: string; value: string }[] = [];
    const appearsIn: { title: string | null; id: string }[] = [];
    let picture: string | null = null;
    let inAppears = false;
    for (const raw of trimBlank(block.lines)) {
      const line = raw.trim();
      if (line === APPEARS_MARKER) {
        inAppears = true;
        continue;
      }
      const d = line.match(DETAIL);
      if (d !== null) {
        details.push({ label: d[1]!, value: d[2]! });
        continue;
      }
      if (PICTURE.test(line)) {
        picture = line;
        continue;
      }
      if (inAppears) {
        const r = line.match(REFERENCE);
        if (r !== null) appearsIn.push({ title: r[1] ?? null, id: r[2]! });
      }
    }
    out.push({
      group,
      name: block.heading,
      id: idOf(block),
      summary: paragraphs(
        block,
        (line) =>
          line === APPEARS_MARKER ||
          DETAIL.test(line) ||
          PICTURE.test(line) ||
          REFERENCE.test(line),
      ).join("\n"),
      details,
      picture,
      appearsIn,
    });
  }
  return out;
}

// ---------------------------------------------------------------- comments.md

export interface RecoveredNote {
  /** The document's title when the item survived, its id when it did not. */
  document: string;
  documentId: string | null;
  from: number;
  to: number;
  /** `orphaned`, `resolved`, or neither. Both may be present at once. */
  flags: string[];
  quote: string;
  body: string;
}

const RANGE = /^(\d+)-(\d+)(.*)$/;

export function readComments(text: string): RecoveredNote[] {
  const out: RecoveredNote[] = [];
  let document = "";
  let documentId: string | null = null;
  for (const block of parseDocument(text).blocks) {
    if (block.level === 2) {
      document = block.heading;
      documentId = idOf(block);
      continue;
    }
    if (block.level !== 3) continue;
    const m = block.heading.trim().match(RANGE);
    if (m === null) continue;
    const flags = [...m[3]!.matchAll(/\(([a-z]+)\)/g)].map((f) => f[1]!);
    const lines = trimBlank(block.lines);
    out.push({
      document,
      documentId,
      from: Number(m[1]),
      to: Number(m[2]),
      flags,
      quote: lines
        .filter((l) => l.trimStart().startsWith("> "))
        .map((l) => l.trimStart().slice(2).trim())
        .join("\n"),
      body: lines
        .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("> "))
        .map((l) => l.trim())
        .join("\n"),
    });
  }
  return out;
}

// ---------------------------------------------------------------- wordlist.md

/** One word per bullet, in the order the file lists them.
 *
 *  THE ORDER IS RETURNED AND NEVER SORTED HERE. `salvage_wordlist_recovered`
 *  grades that the recovery came back alphabetical, and a reader that sorted on
 *  the way in would make that gate compare a sorted list with a sorted list. */
export function readWordlist(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

// ------------------------------------------------------------------ covers.md

export interface RecoveredCovers {
  front: string | null;
  back: string | null;
}

export function readCovers(text: string): RecoveredCovers {
  const covers: RecoveredCovers = { front: null, back: null };
  for (const block of parseDocument(text).blocks) {
    if (block.level !== 2) continue;
    const path = trimBlank(block.lines)
      .map((l) => l.trim())
      .find((l) => PICTURE.test(l));
    if (path === undefined) continue;
    if (/^front\b/i.test(block.heading)) covers.front = path;
    if (/^back\b/i.test(block.heading)) covers.back = path;
  }
  return covers;
}

// --------------------------------------------------------------- snapshots.md

export interface RecoveredSnapshot {
  label: string;
  id: string | null;
  /** Milliseconds since the epoch, verbatim, as 050 decided: rendering a date
   *  needs a timezone this command was never given. null when the `created` line
   *  is absent. */
  created: number | null;
  documents: {
    title: string | null;
    itemId: string;
    /** The written path, or null when the line says the bytes are not stored. */
    path: string | null;
  }[];
}

const CREATED = /^created\s+(-?\d+)$/;

export function readSnapshots(text: string): RecoveredSnapshot[] {
  const out: RecoveredSnapshot[] = [];
  for (const block of parseDocument(text).blocks) {
    if (block.level !== 2) continue;
    let created: number | null = null;
    const documents: RecoveredSnapshot["documents"] = [];
    for (const raw of trimBlank(block.lines)) {
      const line = raw.trim();
      const c = line.match(CREATED);
      if (c !== null) {
        created = Number(c[1]);
        continue;
      }
      const r = line.match(REFERENCE);
      if (r !== null) {
        const tail = r[3]!.trim();
        documents.push({
          title: r[1] ?? null,
          itemId: r[2]!,
          path: tail.endsWith(".md") ? tail : null,
        });
      }
    }
    out.push({ label: block.heading, id: idOf(block), created, documents });
  }
  return out;
}

// ------------------------------------------------- the manifest names no path

/** One string in a manifest that names a place on the machine it was recovered
 *  on, with the JSON path it was found at. */
export interface NamedPath {
  /** Dotted JSON path, e.g. `losses[0].detail` or `meta.recovered_from`. */
  at: string;
  value: string;
}

/** Every string anywhere in a salvage manifest that names an absolute
 *  filesystem path, or that names `holding`.
 *
 *  THE CLAIM A RIG CAN HOLD FOREVER. `manifest.json` is plain text
 *  whose whole purpose is to be read by somebody other than the person who ran
 *  the command -- a helper, a maintainer, a forum -- and until an earlier fix
 *  it opened with the operating-system user's home directory twice, in `source` and
 *  `out_dir`. Nothing about that is a threshold, so it is not a number: it is a
 *  list, and a non-empty one is the gate failing with the offending strings in
 *  the value line.
 *
 *  TWO CLAUSES, because one of them is not enough. A value STARTING with `/` is
 *  an absolute path outright. A value merely CONTAINING `holding` -- the
 *  directory the run happened in -- catches a value that was made relative to
 *  something and still names the machine.
 *
 *  It walks the parsed JSON rather than grepping the bytes, so a directory name
 *  that happens to occur inside a recovered SENTENCE is reported with the key
 *  that carries it and a reader can tell the two apart. */
export function namedPathsIn(manifest: string, holding: string): NamedPath[] {
  const found: NamedPath[] = [];
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") {
      if (value.startsWith("/") || (holding.length > 1 && value.includes(holding))) {
        found.push({ at, value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${at}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, at === "" ? k : `${at}.${k}`);
      }
    }
  };
  walk(JSON.parse(manifest), "");
  return found;
}

/** How many `manifest.json` files a salvage run is owed, given what its corpus
 *  entries answered.
 *
 *  THE RIG'S OWN WIRING IS UNMUTATABLE and this is the rule pulled out of it
 *  (054). `salvage_manifest_names_no_path` grades a list of offending strings,
 *  and a rig that quietly stopped collecting some of its manifests would shrink
 *  that gate's subject while leaving it green -- so the count is checked, and it
 *  is checked here rather than in the gate: a break in one corpus file changes
 *  how many manifests exist, and a gate keyed on that would redden alongside the
 *  gate that owns the break.
 *
 *  Two salvages always write one each -- the rig aborts before this if either
 *  did not -- plus one per corpus entry that ANSWERED, which is exactly what a
 *  non-null `complete` says. */
export function manifestsOwed(corpus: { complete: boolean | null }[]): number {
  return 2 + corpus.filter((entry) => entry.complete !== null).length;
}
