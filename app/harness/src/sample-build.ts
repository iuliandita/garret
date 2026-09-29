// app/harness/src/sample-build.ts
// Rebuilds `app/fixtures/sample/{project.json, scenes.ndjson, cast.ndjson,
// synopses.ndjson, appearances.ndjson, timelines.ndjson, manifest.json}` from
// the prose and JSON a person edits at `app/fixtures/sample/src/`.
//
// ONE MARKDOWN PARSER (094 decision 2). This does NOT read Markdown itself: it
// runs the SHIPPED `import` subcommand on `src/manuscript.md` and on each
// `src/bible/*.md`, and reads the store `import` produced with `bun:sqlite` --
// the same way `import-cli.ts` grades a GUI import, restated here rather than
// shared because that file is a runnable script with top-level side effects
// (it calls `process.exit` at import time) and not a module meant to be
// imported. A second Markdown reader in this file would be a second place the
// format is defined, which is the thing 094 exists to avoid.
//
// DETERMINISTIC IDS, `sc-000000` UPWARDS IN WALK ORDER, ASSIGNED HERE AND NOT
// BY THE IMPORTER. `import` hands back real (time-ordered) uuids, which would
// make every rebuild a diff even when nothing in `src/` changed -- and this
// generator's whole promise, exercised by `--check` below, is that a rebuild
// with nothing changed produces byte-identical output. Only ITEM ids are
// deterministic: a cast member's id is assigned by `Store::cast_create` at
// SEED time, in Rust, long after this file has run, so `cast.ndjson` carries
// no id at all and `appearances.ndjson` names a member by NAME for the seeder
// to resolve -- see `store/seed.rs`.
//
// Usage: `bun app/harness/src/sample-build.ts [--check] [--src <dir>] [--out <dir>]`
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN } from "./shell";

/** RESTATED from `store::cast::CAST_KINDS` rather than imported, for the
 *  reason the page's own `cast-kinds.ts` restates it: there is no build step
 *  joining this harness to the host, and these three strings are the wire
 *  contract between them. */
const CAST_KINDS = ["character", "place", "poi"] as const;

interface FixtureItem {
  id: string;
  type: string;
  title: string;
  parentId: string | null;
}

interface FixtureScene {
  id: string;
  body: unknown;
}

interface FixtureCastEntry {
  kind: string;
  name: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  /** Absent means none, `fields`' own rule. */
  aliases: string[];
}

interface SrcCastEntry {
  kind: string;
  name: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  appears?: string[];
  aliases?: string[];
}

/** One row of the store's own depth-first walk, restated from
 *  `import-cli.ts`'s `readStore` with `parent_id` added: this generator has to
 *  rebuild the tree shape, which a body-only read has no use for. */
interface WalkRow {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  body: string | null;
}

/** `store/position.rs` MAX_DEPTH, restated for the same reason
 *  `import-cli.ts` restates it: without a bound, a corrupt parent chain
 *  recurses forever here instead of failing loudly the way the store does. */
const MAX_DEPTH = 64;

function readWalk(dbPath: string): WalkRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
           SELECT id, parent_id, type, title, position, 0, position
             FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.type, i.title, i.position,
                  w.depth + 1, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
            WHERE w.depth + 1 < ${MAX_DEPTH}
         )
         SELECT w.id, w.parent_id AS parentId, w.type, w.title, d.body
           FROM walk w LEFT JOIN doc d ON d.item_id = w.id
          ORDER BY w.path`,
      )
      .all() as WalkRow[];
  } finally {
    db.close();
  }
}

/** Runs the shipped `import` subcommand on `source` into a throwaway library
 *  directory, hands the resulting walk to `use`, and removes the directory
 *  before returning -- one library per file imported, and none of them
 *  outlive this process. */
function withImportedWalk<T>(source: string, use: (walk: WalkRow[], name: string) => T): T {
  const library = mkdtempSync(join(tmpdir(), "sample-build-lib-"));
  try {
    const proc = Bun.spawnSync([BIN, "import", source, library, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `import of ${source} failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
      );
    }
    const result = JSON.parse(proc.stdout.toString()) as { path: string; name: string };
    return use(readWalk(result.path), result.name);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

/** A stored ProseMirror body reduced to its words, restated from
 *  `import-cli.ts`'s `bodyText`: inline text concatenated with nothing, one
 *  space before each block's content. Used only to total `manifest.json`'s
 *  word count. */
function bodyText(body: string): string {
  const root: unknown = JSON.parse(body);
  let out = "";
  const append = (node: unknown, isBlock: boolean): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; content?: unknown };
    if (n.type === "text") {
      if (typeof n.text === "string") out += n.text;
      return;
    }
    if (isBlock && out.length > 0) out += " ";
    if (Array.isArray(n.content)) for (const child of n.content) append(child, false);
  };
  const top = root as { content?: unknown };
  if (Array.isArray(top.content)) for (const block of top.content) append(block, true);
  return out;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Assigns the next deterministic id under `prefix` and advances that
 *  counter. ONE COUNTER ACROSS THE WHOLE TREE for `sc-` -- the manuscript's
 *  parts, chapters and scenes, then the bible root and its notes -- so an id
 *  says nothing about what KIND of item it names, exactly as the store's own
 *  uuids do not. A TIMELINE GETS ITS OWN `tl-` COUNTER rather than
 *  sharing `sc-`'s: the id is minted here, by this generator, never by the
 *  store (`store/seed.rs` takes it as given) -- so nothing enforces that it
 *  stays deterministic against `sc-`'s if a later item is added to the
 *  manuscript ahead of it in build order, the way a shared counter would. */
function idAssigner(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(n++).padStart(6, "0")}`;
}

interface BuiltSection {
  items: FixtureItem[];
  scenes: FixtureScene[];
  /** Scene TITLE -> its new deterministic id, for `synopses.json` and
   *  `cast.json`'s `appears` to resolve against. Manuscript scenes only: a
   *  bible note is not a scene and the fixture's own JSON shapes never name one. */
  sceneTitleToId: Map<string, string>;
  /** The book's name as the importer read it off the `#` line (094: it becomes
   *  the seeded project's name, so the outline header says the title). Only
   *  the manuscript section carries one; a bible note has no book. */
  name?: string;
}

function buildManuscript(manuscriptPath: string, nextId: () => string): BuiltSection {
  return withImportedWalk(manuscriptPath, (walk, name) => {
    const idMap = new Map<string, string>();
    const items: FixtureItem[] = [];
    const scenes: FixtureScene[] = [];
    const sceneTitleToId = new Map<string, string>();
    for (const row of walk) {
      const id = nextId();
      idMap.set(row.id, id);
      const parentId = row.parentId === null ? null : (idMap.get(row.parentId) ?? null);
      items.push({ id, type: row.type, title: row.title, parentId });
      if (row.body !== null) scenes.push({ id, body: JSON.parse(row.body) });
      if (row.type === "scene") sceneTitleToId.set(row.title, id);
    }
    return { items, scenes, sceneTitleToId, name };
  });
}

/** `src/bible/*.md`, one note each -- empty (missing directory, or one with no
 *  `.md` file in it) is a valid fixture with no bible section at all, which is
 *  094's own "treat the missing files as empty and still build" rule applied
 *  to a whole section rather than to a single optional file. */
function buildBible(srcDir: string, nextId: () => string): BuiltSection {
  const bibleDir = join(srcDir, "bible");
  const items: FixtureItem[] = [];
  const scenes: FixtureScene[] = [];
  if (!existsSync(bibleDir)) return { items, scenes, sceneTitleToId: new Map() };
  const files = readdirSync(bibleDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) return { items, scenes, sceneTitleToId: new Map() };

  const bibleRootId = nextId();
  items.push({ id: bibleRootId, type: "bible", title: "Bible", parentId: null });
  for (const file of files) {
    const path = join(bibleDir, file);
    withImportedWalk(path, (walk) => {
      // Each note is a title and body paragraphs, nothing nested -- decision
      // 2's "its SINGLE scene's body becomes the note's body". More than one
      // row means the file grew a `##` section 094 never promised to carry;
      // none at all means it named itself and wrote no prose.
      if (walk.length !== 1) {
        throw new Error(
          `bible note ${path} must be a title and prose with no sections; import produced ${walk.length} item(s)`,
        );
      }
      const [note] = walk;
      if (note === undefined || note.body === null) {
        throw new Error(`bible note ${path} has a title but no prose`);
      }
      const id = nextId();
      items.push({ id, type: "note", title: note.title, parentId: bibleRootId });
      scenes.push({ id, body: JSON.parse(note.body) });
    });
  }
  return { items, scenes, sceneTitleToId: new Map() };
}

function readSrcCast(srcDir: string): SrcCastEntry[] {
  const path = join(srcDir, "cast.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as SrcCastEntry[];
}

function readSrcSynopses(srcDir: string): Record<string, string> {
  const path = join(srcDir, "synopses.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

/** `src/timeline.json`'s shape when it names an actual timeline: the
 *  document's title and its body, which a person writes with a scene TITLE
 *  under `events[].scene` and cast member NAMES under `tracks[].memberId`
 *  (cast-kind tracks) and `events[].cast` -- never ids, exactly as
 *  `cast.json`'s own `appears` never names an id. Everything else in the
 *  body (scale, track/branch/event ids, `forkTrack`) is written as the
 *  timeline design's section 2 schema expects and passes through untouched. */
interface SrcTimeline {
  title: string;
  body: unknown;
}

/** `null` -- MISSING FILE, AND THE FILE'S OWN LITERAL `null` -- are the SAME
 *  ANSWER: no timeline. 101 ships `src/timeline.json` holding `null`
 *  (104 fills it), so the file exists and still means "nothing here yet",
 *  which is what the `--check` drift test pins against a real path rather
 *  than an absent one. */
function readSrcTimeline(srcDir: string): SrcTimeline | null {
  const path = join(srcDir, "timeline.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SrcTimeline | null;
}

/** `events[].scene` (a scene TITLE, or null) is resolved to the real item id
 *  here, since this generator -- and only this generator -- knows the map
 *  from a manuscript scene's title to its deterministic id. `tracks[].memberId`
 *  (cast-kind tracks) and `events[].cast` name cast members BY NAME instead:
 *  this generator does not know the ids `cast_create` will hand out at seed
 *  time (the same reason `appearances.ndjson`'s `members` stays names), so
 *  those are only VALIDATED against `cast.json` here and left as names for
 *  `store/seed.rs` to resolve the same way it resolves `appearances.ndjson`.
 *  An unknown scene title or cast name FAILS THE BUILD rather than seeding a
 *  timeline with a dangling reference nothing would ever catch. */
function resolveTimelineBody(
  raw: unknown,
  sceneTitleToId: Map<string, string>,
  knownCastNames: Set<string>,
): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const body = raw as Record<string, unknown>;
  const unknownScenes = new Set<string>();
  const unknownNames = new Set<string>();

  const tracks = Array.isArray(body.tracks)
    ? body.tracks.map((t) => {
        if (typeof t !== "object" || t === null) return t;
        const track = t as Record<string, unknown>;
        if (track.kind === "cast" && typeof track.memberId === "string") {
          if (!knownCastNames.has(track.memberId)) unknownNames.add(track.memberId);
        }
        return track;
      })
    : body.tracks;

  const events = Array.isArray(body.events)
    ? body.events.map((e) => {
        if (typeof e !== "object" || e === null) return e;
        const event = { ...(e as Record<string, unknown>) };
        if (typeof event.scene === "string") {
          const id = sceneTitleToId.get(event.scene);
          if (id === undefined) unknownScenes.add(event.scene);
          else event.scene = id;
        }
        if (Array.isArray(event.cast)) {
          for (const name of event.cast) {
            if (typeof name === "string" && !knownCastNames.has(name)) unknownNames.add(name);
          }
        }
        return event;
      })
    : body.events;

  if (unknownScenes.size > 0) {
    throw new Error(
      `timeline.json names scene(s) the manuscript does not have: ${[...unknownScenes].sort().join(", ")}`,
    );
  }
  if (unknownNames.size > 0) {
    throw new Error(
      `timeline.json names cast member(s) cast.json does not have: ${[...unknownNames].sort().join(", ")}`,
    );
  }

  return { ...body, tracks, events };
}

/** The six generated files plus the manifest, as strings ready to write --
 *  kept apart from writing them so `--check` can diff without touching disk. */
interface Built {
  projectJson: string;
  scenesNdjson: string;
  castNdjson: string;
  synopsesNdjson: string;
  appearancesNdjson: string;
  timelinesNdjson: string;
  manifestJson: string;
}

function build(srcDir: string): Built {
  const manuscriptPath = join(srcDir, "manuscript.md");
  if (!existsSync(manuscriptPath)) {
    throw new Error(`no manuscript at ${manuscriptPath}: the sample fixture has no book`);
  }
  const nextId = idAssigner("sc-");
  const manuscript = buildManuscript(manuscriptPath, nextId);
  const bible = buildBible(srcDir, nextId);
  const items = [...manuscript.items, ...bible.items];
  const scenes = [...manuscript.scenes, ...bible.scenes];

  const srcCast = readSrcCast(srcDir);
  for (const entry of srcCast) {
    if (!(CAST_KINDS as readonly string[]).includes(entry.kind)) {
      throw new Error(
        `cast.json: ${entry.name ?? "(unnamed)"} names kind ${JSON.stringify(entry.kind)}, not one of ${CAST_KINDS.join(", ")}`,
      );
    }
  }
  const castLines: FixtureCastEntry[] = srcCast.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    summary: entry.summary ?? "",
    fields: entry.fields ?? [],
    aliases: entry.aliases ?? [],
  }));

  const srcSynopses = readSrcSynopses(srcDir);

  // REFUSED BEFORE ANYTHING IS WRITTEN (094 decision 5): a typo'd scene title
  // in either source must not silently drop a synopsis or an appearance, so
  // every name is checked against the manuscript's own scene titles first.
  const unknownSceneNames = new Set<string>();
  for (const title of Object.keys(srcSynopses)) {
    if (!manuscript.sceneTitleToId.has(title)) unknownSceneNames.add(title);
  }
  for (const entry of srcCast) {
    for (const title of entry.appears ?? []) {
      if (!manuscript.sceneTitleToId.has(title)) unknownSceneNames.add(title);
    }
  }
  if (unknownSceneNames.size > 0) {
    throw new Error(
      `src/ names scene(s) the manuscript does not have: ${[...unknownSceneNames].sort().join(", ")}`,
    );
  }

  const synopsesLines = Object.entries(srcSynopses).map(([title, body]) => ({
    itemId: manuscript.sceneTitleToId.get(title),
    body,
  }));

  const appearsByScene = new Map<string, string[]>();
  for (const entry of srcCast) {
    for (const title of entry.appears ?? []) {
      const members = appearsByScene.get(title) ?? [];
      members.push(entry.name);
      appearsByScene.set(title, members);
    }
  }
  const appearancesLines = [...appearsByScene.entries()].map(([title, members]) => ({
    itemId: manuscript.sceneTitleToId.get(title),
    members,
  }));

  // ONE LINE OR NONE, never more: the sample book has one story clock, and
  // `readSrcTimeline`'s null covers "not yet written" exactly as it
  // will cover "the writer removed it" once that removal path exists.
  const srcTimeline = readSrcTimeline(srcDir);
  const nextTimelineId = idAssigner("tl-");
  const knownCastNames = new Set(srcCast.map((c) => c.name));
  const timelinesLines =
    srcTimeline === null
      ? []
      : [
          {
            id: nextTimelineId(),
            title: srcTimeline.title,
            body: resolveTimelineBody(srcTimeline.body, manuscript.sceneTitleToId, knownCastNames),
          },
        ];

  const totalWords = scenes.reduce((sum, s) => sum + wordCount(bodyText(JSON.stringify(s.body))), 0);

  const project = {
    meta: { name: manuscript.name ?? "sample", seed: "sample-v1" },
    items,
  };
  // A TIMELINE LINE IS A REAL ITEM ROW ONCE SEEDED (store/seed.rs), and so IS
  // THE BIBLE ROOT `timelines.ndjson`'s own reading makes when none already
  // exists -- exactly `extra_items` in that file. `fixtureItemFloor` reads
  // this as "the number of rows the seeded store walks", so leaving either
  // out understates the floor a rig compares its navigator against the
  // moment 104 fills `src/timeline.json` with something real.
  const timelineNeedsBibleRoot = timelinesLines.length > 0 && bible.items.length === 0;
  const manifest = {
    name: "sample",
    seed: "sample-v1",
    itemCount: items.length + timelinesLines.length + (timelineNeedsBibleRoot ? 1 : 0),
    noteCount: bible.items.filter((i) => i.type === "note").length,
    castCount: castLines.length,
    timelines: timelinesLines.length,
    totalWords,
  };

  const ndjson = (lines: unknown[]): string =>
    lines.length === 0 ? "" : lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

  return {
    projectJson: JSON.stringify(project, null, 2),
    scenesNdjson: ndjson(scenes),
    castNdjson: ndjson(castLines),
    synopsesNdjson: ndjson(synopsesLines),
    appearancesNdjson: ndjson(appearancesLines),
    timelinesNdjson: ndjson(timelinesLines),
    manifestJson: JSON.stringify(manifest, null, 2),
  };
}

const FILES: Record<keyof Built, string> = {
  projectJson: "project.json",
  scenesNdjson: "scenes.ndjson",
  castNdjson: "cast.ndjson",
  synopsesNdjson: "synopses.ndjson",
  appearancesNdjson: "appearances.ndjson",
  timelinesNdjson: "timelines.ndjson",
  manifestJson: "manifest.json",
};

function write(outDir: string, built: Built): void {
  mkdirSync(outDir, { recursive: true });
  for (const [key, name] of Object.entries(FILES) as Array<[keyof Built, string]>) {
    writeFileSync(join(outDir, name), built[key]);
  }
}

/** Regenerates into a throwaway directory and reports which committed files,
 *  if any, differ. `null` means the committed output already matches. */
function diff(outDir: string, built: Built): string[] {
  const mismatches: string[] = [];
  for (const [key, name] of Object.entries(FILES) as Array<[keyof Built, string]>) {
    const committedPath = join(outDir, name);
    const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : null;
    if (committed !== built[key]) mismatches.push(name);
  }
  return mismatches;
}

function parseArgs(argv: string[]): { check: boolean; srcDir: string; outDir: string } {
  let check = false;
  let srcDir = "app/fixtures/sample/src";
  let outDir = "app/fixtures/sample";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--src") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--src needs a directory");
      srcDir = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--out needs a directory");
      outDir = value;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { check, srcDir, outDir };
}

export {
  build,
  diff,
  write,
  buildManuscript,
  buildBible,
  idAssigner,
  wordCount,
  bodyText,
  resolveTimelineBody,
};

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(BIN)) {
    console.error(`missing ${BIN} — build the host with cargo build --release first.`);
    process.exit(1);
  }
  let built: Built;
  try {
    built = build(options.srcDir);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
  if (options.check) {
    const mismatches = diff(options.outDir, built);
    if (mismatches.length > 0) {
      console.error(
        `${options.outDir} is stale against ${options.srcDir}: ${mismatches.join(", ")} differ. Rebuild with \`bun app/harness/src/sample-build.ts\`.`,
      );
      process.exit(1);
    }
    console.log(`${options.outDir} matches ${options.srcDir}.`);
    process.exit(0);
  }
  write(options.outDir, built);
  console.log(`wrote ${options.outDir} from ${options.srcDir}.`);
}
