// app/harness/src/replace-cli.ts
// Graded search-and-replace run. Drives the SHIPPED find panel's replace
// controls -- Ctrl+F, a query, Edit > Replace..., Tab, Return -- and asks
// whether what ends up in the store is what replacing that word should produce.
//
// THE ORACLE IS THE STORE, read directly with bun:sqlite and projected to plain
// text by THIS RIG'S OWN restatement of the walk (`projectText`), never imported
// from find-locate.ts, replace.ts or store/mod.rs. The rig computes the expected
// post-replace text ITSELF and compares. A rig that asked the panel how many
// occurrences it had replaced, and then believed it, would grade a tautology --
// which is exactly what `replace_all_count_agrees` exists to refuse.
//
// WALK BUDGET, stated here because two rig headers in this repo were recently
// found claiming counts they no longer had:
//
//   boot 1  replace all          ONE AT-SPI walk (the announced count)
//   boot 2  reopen after a kill  ZERO walks
//   boot 3  undo                 ZERO walks
//   boot 4  replace one          ZERO walks
//   boot 5  marks                ZERO walks
//
// ONE walk in the whole run. Several walks in one window kill this application
// -- cleanly, silently, taking the X server with it -- at a boundary that has
// been observed between the third and the fifth. Every claim here that
// keystrokes can drive and SQLite can verify spends zero walks; the single walk
// buys the one figure that exists only on screen.
//
// NO POINTER INPUT AT ALL. Every control is reached by keyboard: Ctrl+F opens
// the panel on the query field, the Edit menu's Replace... item opens it on the
// replace field, and Tab walks the two buttons after it. That sidesteps the
// recorded `xdotool click --window` hazard (synthetic button events are
// discarded by the toolkit while reporting success) rather than working around
// it, and it costs no geometry, which would cost a walk.
//
// Every child process is spawned as an argv ARRAY through Bun.spawnSync. No
// shell is involved anywhere in this file.
//
// Usage: APP_GUI=1 bun app/harness/src/replace-cli.ts <tiny|stress>
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateReplaceGates, type GateResult, type ReplaceMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import { BIN, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";

/** xdotool type returns when X has the key events, not when WebKitGTK has
 *  turned them into document state. 500 ms silently truncated typed text in
 *  hand-cli; 2500 ms is what held. */
const SETTLE_MS = 2500;
const TYPE_DELAY_MS = 20;
/** After Ctrl+F, for the panel to paint and take focus. */
const PANEL_OPEN_MS = 600;
/** A search is a round trip to the host and a scan of every stored body. */
const SEARCH_SETTLE_MS = 6000;
/** After a button press, before the store is polled. */
const ACTION_SETTLE_MS = 800;
/** How long the application is given, AFTER the target scene's write has
 *  landed, to perform any FURTHER write the same action set off.
 *
 *  Not caution. `replace_is_scoped_to_the_scene` reads another scene's stored
 *  BYTES, and a write to that scene is only visible once it has been flushed --
 *  so a rig that kills the shell as soon as the target's write lands grades the
 *  scoping claim against a store the widening write has not reached yet.
 *  MEASURED: a sabotage that opened the second result and replaced there was
 *  invisible to this gate with no settle at all, and turned it red at 12 s. The
 *  window has to cover a document switch plus the 1000 ms flush debounce, and it
 *  cannot be spent inside the walk: the walk takes ~10 s and starves the page's
 *  timers. */
const SCOPE_SETTLE_MS = 6000;
/** The flush debounce is 1000 ms; a write has this long to appear before the
 *  rig calls it lost. */
const COMMIT_TIMEOUT_MS = 25_000;
const STORE_POLL_MS = 25;

/** store/mod.rs MAX_DEPTH. Without it the CTE recurses forever on a parent_id
 *  cycle where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;

/** The replacement. A nonce, so `the replacement is in the store afterwards`
 *  cannot be satisfied by text that was already there. Guarded anyway, below.
 *  Upper case ASCII with no spaces: a space typed into the wrong surface is
 *  ACTIVATION in the navigator, and a query that reaches the navigator instead
 *  of the panel should type into nothing rather than open something. */
const REPLACEMENT = "QZREPLACEDX";

/** The marks phase's own pair. Typed with the shipped Ctrl+I on either side, so
 *  the emphasis comes from the application rather than from a fixture -- the
 *  seeded corpora carry no marks at all. */
const MARK_TERM = "QZMARKWORD";
const MARK_REPLACEMENT = "QZMARKDONE";

const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
     SELECT id, parent_id, type, title, position, 0, position
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.title, i.position,
            w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ?1
   )
   SELECT id, type, title, depth FROM walk ORDER BY path`;

interface WalkRow {
  id: string;
  type: string;
  title: string;
  depth: number;
}

/** THE RIG'S OWN plain-text projection of a stored ProseMirror body.
 *
 *  Restated from the format, deliberately, and not imported from
 *  `store::document_text` or `find-locate.ts`'s `project`. Same rule -- text
 *  nodes concatenated with nothing between them, one separator before each
 *  block node's content, none before the first -- but restating it is what
 *  makes the oracle independent of the thing it grades. */
function projectText(body: string): string | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;
  if ((root as { type?: unknown }).type !== "doc") return null;

  let out = "";
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; content?: unknown };
    if (n.type === "text") {
      if (typeof n.text === "string") out += n.text;
      return;
    }
    if (out.length > 0) out += " ";
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  };
  walk(root);
  return out;
}

/** Fold ONE CODE POINT AT A TIME, restated from find-locate.ts's rule and from
 *  the reason behind it: `String.prototype.toLowerCase` implements Final_Sigma,
 *  so folding a whole string makes a Greek word match in the panel and then be
 *  unlocatable in the document. Folding per code point removes the context the
 *  special casing needs, which is what makes the page and the host agree -- and
 *  this rig has to agree with both or its expected text is wrong. */
function foldForFind(text: string): string {
  let out = "";
  for (const codePoint of text) out += codePoint.toLowerCase();
  return out;
}

interface Span {
  from: number;
  to: number;
}

/** Every non-overlapping occurrence of `query` in `text`, left to right, as
 *  UTF-16 index spans into `text`.
 *
 *  The parallel start/end arrays are not decoration: folding is not
 *  length-preserving (`İ` folds to two code units), so an index into the folded
 *  string is not an index into the original and a match's end cannot be derived
 *  by adding the query's length to its start. Non-overlapping and advancing by
 *  the whole needle, because that is what replace-all has to mean: "aa" in
 *  "aaaa" is two replacements, not three. */
function occurrences(text: string, query: string): Span[] {
  const needle = foldForFind(query);
  if (needle.length === 0) return [];
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const codePoint of text) {
    const f = foldForFind(codePoint);
    folded += f;
    for (let i = 0; i < f.length; i++) {
      starts.push(offset);
      ends.push(offset + codePoint.length);
    }
    offset += codePoint.length;
  }
  const out: Span[] = [];
  let at = folded.indexOf(needle);
  while (at >= 0) {
    const from = starts[at];
    const to = ends[at + needle.length - 1];
    if (from !== undefined && to !== undefined) out.push({ from, to });
    at = folded.indexOf(needle, at + needle.length);
  }
  return out;
}

/** The text the rig expects after replacing the first `limit` occurrences.
 *
 *  Computed on the PROJECTED text rather than on the document, which is sound
 *  only because a query drawn from the fixture is a single word: it can never
 *  span the synthetic block separator, and the replacement introduces no block
 *  boundary of its own. Both halves are enforced by how the term is chosen. */
function replaceIn(text: string, query: string, replacement: string, limit = Infinity): string {
  const hits = occurrences(text, query);
  let out = "";
  let cursor = 0;
  let n = 0;
  for (const hit of hits) {
    if (n >= limit) break;
    out += text.slice(cursor, hit.from) + replacement;
    cursor = hit.to;
    n++;
  }
  return out + text.slice(cursor);
}

interface Corpus {
  walk: WalkRow[];
  /** item id -> raw stored body, exactly as the file holds it. */
  bodies: Map<string, string>;
  /** item id -> the rig's projection of that body. */
  texts: Map<string, string>;
}

function readCorpus(projectPath: string): Corpus {
  const db = new Database(projectPath, { readonly: true });
  try {
    const walk = db.query(WALK_SQL).all(MAX_DEPTH) as WalkRow[];
    const bodies = new Map<string, string>();
    const texts = new Map<string, string>();
    const rows = db.query("SELECT item_id, body FROM doc").all() as {
      item_id: string;
      body: string;
    }[];
    for (const row of rows) {
      bodies.set(row.item_id, row.body);
      const text = projectText(row.body);
      if (text !== null) texts.set(row.item_id, text);
    }
    return { walk, bodies, texts };
  } finally {
    db.close();
  }
}

function storeBodyOf(projectPath: string, itemId: string): string {
  const db = new Database(projectPath, { readonly: true });
  try {
    const row = db.query("SELECT body FROM doc WHERE item_id = ?1").get(itemId) as
      | { body: string }
      | null;
    return row?.body ?? "";
  } finally {
    db.close();
  }
}

function storeTextOf(projectPath: string, itemId: string): string | null {
  return projectText(storeBodyOf(projectPath, itemId));
}

/** Does any text node whose text contains `needle` carry an `em` mark?
 *
 *  Read out of the raw stored JSON rather than out of a projection: the whole
 *  claim is about marks, and the projection throws them away by construction. */
function emphasisedTextNodes(body: string, needle: string): { total: number; emphasised: number } {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return { total: 0, emphasised: 0 };
  }
  let total = 0;
  let emphasised = 0;
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; marks?: unknown; content?: unknown };
    if (n.type === "text" && typeof n.text === "string" && n.text.includes(needle)) {
      total++;
      const marks = Array.isArray(n.marks) ? n.marks : [];
      if (marks.some((m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "em")) {
        emphasised++;
      }
    }
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };
  walk(root);
  return { total, emphasised };
}

// ---------------------------------------------------------------- AT-SPI

/** The ONE walk of this run. Reads two elements by DOM id and nothing else.
 *
 *  `#open-error` is where the panel's announced count lands: the find bar's
 *  `onNotice` is wired to `raiseNotice`, which is the banner the project mount
 *  also uses for a failed open. The status line is read in the same walk
 *  because `replaceAll` re-runs the search and overwrites it, so which of the
 *  two carries the figure is a property of the build rather than a constant. */
export const PY_TEXT = String.raw`
import json, sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

found = {"find-status": None, "open-error": None}

def own_text(node):
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception:
        return ""

def subtree_text(node):
    # The WHOLE subtree, not the node's own text. The notice banner puts its
    # sentence in a child <span> beside a dismiss <button>, so the div itself
    # reports the empty string -- which reads exactly like a banner that never
    # appeared. Measured: the notice came back "" once the banner grew those
    # children, having read correctly before.
    out = own_text(node) or (node.name or "")
    try:
        for k in range(node.childCount):
            out += subtree_text(node.getChildAtIndex(k))
    except Exception:
        pass
    return out

def walk(node):
    try:
        i = ident(node)
        if i in found and found[i] is None:
            found[i] = subtree_text(node) or (node.name or "")
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps(found))
`;

interface PanelText {
  "find-status": string | null;
  "open-error": string | null;
}

function probePanelText(rootPid: number): PanelText {
  const proc = Bun.spawnSync(["python3", "-c", PY_TEXT, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    // Exit 4 is "not exactly one matching application", which has two very
    // different causes with two different owners: the bridge wedged (the app is
    // alive but off the bus) or the app DIED. The process table answers it.
    const alive = survivingShellPids();
    throw new Error(
      `could not read the accessibility tree (exit ${proc.exitCode}); ` +
        `${alive.length} shell process(es) alive (${alive.join(", ") || "none"}) — ` +
        `${alive.length > 0 ? "the app is running but off the AT-SPI bus" : "THE APP IS GONE"}` +
        `: ${proc.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(proc.stdout.toString()) as PanelText;
}

/** Restated from find-bar.ts's `onReplaceAll`. `toLocaleString` under the
 *  harness's LANG=C gives a comma-grouped figure, same as the find summary. */
const REPLACED_PATTERN = /Replaced ([\d,]+) occurrences?\b/u;

function parseReplacedCount(...texts: (string | null)[]): number | null {
  for (const text of texts) {
    if (text === null) continue;
    const m = text.match(REPLACED_PATTERN);
    if (m?.[1] !== undefined) return Number(m[1].replaceAll(",", ""));
  }
  return null;
}

// ---------------------------------------------------------------- driving

function xdo(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

// ---------------------------------------------------------------- main

const fixtureName = process.argv[2];
if (fixtureName !== "tiny" && fixtureName !== "stress") {
  console.error("usage: APP_GUI=1 bun app/harness/src/replace-cli.ts <tiny|stress>");
  process.exit(1);
}
const FIXTURE = `lab/fixtures/out/${fixtureName}`;

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; replace run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — build the shell and the UI, and generate the fixture.`);
    process.exit(1);
  }
}
{
  const survivors = survivingShellPids();
  if (survivors.length > 0) {
    console.error(
      `${survivors.length} shell process(es) already running (${survivors.join(", ")}). ` +
        "The AT-SPI probe refuses any dump it cannot attribute to exactly one window.",
    );
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "app-replace-"));
const cleanup = (): void => {
  rmSync(workDir, { recursive: true, force: true });
};

function abort(reason: string): never {
  console.error(`ABORTED, nothing written: ${reason}`);
  cleanup();
  process.exit(1);
}

/** A fresh copy of the fixture, seeded through the host binary itself. Each
 *  phase mutates a manuscript, so each phase gets its own. */
function seed(label: string): string {
  const path = join(workDir, `${label}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, path], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding ${label} failed (exit ${seeded.exitCode})`);
  return path;
}

console.log(`[1/7] seeding from ${FIXTURE} and reading the store as the rig's own oracle`);
const basePath = seed("phase-all");
const corpus = readCorpus(basePath);
if (corpus.walk.length === 0) {
  abort("VACUITY GUARD: the seeded project has no items, so every gate would compare 0 to 0.");
}

/** Every scene with prose, in book order -- which is the order `project_find`
 *  returns results in, and therefore the order the rig can predict. */
const scenes = corpus.walk.filter(
  (r) => r.type === "scene" && (corpus.texts.get(r.id)?.length ?? 0) > 0,
);
if (scenes.length < 2) {
  abort(
    "VACUITY GUARD: the fixture has fewer than two scenes with prose, so " +
      "replace_is_scoped_to_the_scene -- the load-bearing safety gate of this slice -- would " +
      "have nothing to check.",
  );
}

/** The scene the page opens at boot. Replace is scoped to whatever is OPEN, and
 *  at `tiny` this one's prose is Hebrew and Arabic -- so the rig does not
 *  replace in it. It opens the scene it wants through the shipped find-reveal
 *  path instead, which is the intended workflow ("find the term, walk the results,
 *  replace where it belongs") and costs no AT-SPI walk: ArrowDown and Return. */
const bootScene: WalkRow | undefined = scenes[0];
if (bootScene === undefined) abort("internal: no boot scene after the guard above.");

/** Folded titles of every item, joined. A term appearing in one would produce a
 *  title-match result row, and a part or a chapter row is NOT openable -- so
 *  "arrow onto the first result and press Return" could land on something that
 *  opens nothing, and the rig would replace in the boot scene while reporting
 *  about another. Excluding such terms is what makes the first result
 *  predictable. */
const ALL_TITLES = corpus.walk.map((r) => foldForFind(r.title)).join("   ");

/** The term, chosen from the fixture's own words rather than hard coded: a
 *  hard-coded term silently matches nothing in another fixture and every gate
 *  then reports UNKNOWN.
 *
 *  ASCII letters only, and no spaces, for two reasons that are not style: the
 *  query is typed with `xdotool type` into a field, and a single word can never
 *  span the synthetic block separator, which is what makes the rig's expected
 *  text (computed on the projection) equal to what the editor does (computed on
 *  document positions).
 *
 *  Deliberately NOT present in the boot scene. That is what makes the reveal
 *  load-bearing: if activating the first result fails to open anything, the
 *  scene still in the editor holds no occurrence, replace-all changes nothing,
 *  and the store guard aborts the run -- rather than the rig replacing in the
 *  wrong scene and reporting a plausible number. */
interface Choice {
  word: string;
  target: WalkRow;
  other: WalkRow;
  count: number;
  scenes: number;
}
const bootText = corpus.texts.get(bootScene.id) ?? "";
const words = new Set<string>();
for (const scene of scenes) {
  for (const word of foldForFind(corpus.texts.get(scene.id) ?? "").split(/[^a-z]+/u)) {
    if (word.length >= 4 && word.length <= 14) words.add(word);
  }
}
const choices: Choice[] = [];
for (const word of words) {
  if (ALL_TITLES.includes(word)) continue;
  if (occurrences(bootText, word).length > 0) continue;
  const hits = scenes
    .map((s) => ({ scene: s, n: occurrences(corpus.texts.get(s.id) ?? "", word).length }))
    .filter((h) => h.n > 0);
  const first = hits[0];
  const second = hits[1];
  if (first === undefined || second === undefined) continue;
  // At least two occurrences in the scene that will be open, so
  // replace_one_replaces_one can tell "one" from "all" at all.
  if (first.n < 2 || first.n > 60) continue;
  choices.push({ word, target: first.scene, other: second.scene, count: first.n, scenes: hits.length });
}
// Most occurrences in the target first, so replace-all is a real bulk
// operation; ties by the word, so the choice is deterministic across runs.
choices.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
const chosen = choices[0];
if (chosen === undefined) {
  abort(
    "VACUITY GUARD: no ASCII word of 4+ characters occurs twice in one scene, at least once in " +
      "another, in no item title, and not in the boot scene. Without one, either " +
      "replace_one_replaces_one or replace_is_scoped_to_the_scene would be graded against a " +
      "fixture that cannot fail it.",
  );
}
const QUERY = chosen.word;
const EXPECTED_OCCURRENCES = chosen.count;
const target: WalkRow = chosen.target;
const other: WalkRow = chosen.other;
const TARGET_TEXT: string = corpus.texts.get(target.id) ?? "";
const OTHER_BODY_BEFORE = corpus.bodies.get(other.id) ?? "";
if (target.id === bootScene.id) abort("internal: the chosen target is the boot scene.");

// The replacement must not already be in the manuscript, anywhere. Otherwise
// "the replacement is there afterwards" is satisfied by text nobody wrote, and
// the expected-text comparison would be graded against a string the rig cannot
// tell apart from the fixture's own.
for (const [id, text] of corpus.texts) {
  if (occurrences(text, REPLACEMENT).length > 0) {
    abort(
      `VACUITY GUARD: "${REPLACEMENT}" already occurs in ${id}, so finding it after the replace ` +
        "would prove nothing.",
    );
  }
}
for (const row of corpus.walk) {
  if (occurrences(row.title, REPLACEMENT).length > 0) {
    abort(`VACUITY GUARD: "${REPLACEMENT}" already occurs in the title of ${row.id}.`);
  }
}
if (occurrences(TARGET_TEXT, QUERY).length !== EXPECTED_OCCURRENCES || EXPECTED_OCCURRENCES === 0) {
  abort(`VACUITY GUARD: "${QUERY}" does not occur in the boot scene ${target.id}.`);
}

/** What the store should hold after a replace-all, and after a single replace.
 *  Computed by the RIG, from the seeded text, before anything runs. */
const EXPECTED_ALL = replaceIn(TARGET_TEXT, QUERY, REPLACEMENT);
const EXPECTED_ONE = replaceIn(TARGET_TEXT, QUERY, REPLACEMENT, 1);
if (EXPECTED_ALL === TARGET_TEXT || EXPECTED_ONE === TARGET_TEXT || EXPECTED_ALL === EXPECTED_ONE) {
  abort("internal: the expected texts do not differ from each other or from the seed.");
}

console.log(
  `  ${corpus.walk.length} items, ${corpus.texts.size} readable documents\n` +
    `  boot scene    = ${bootScene.id} (holds no occurrence, so the reveal is load-bearing)\n` +
    `  target scene  = ${target.id} ("${target.title}"), opened through the find panel\n` +
    `  other scene   = ${other.id} ("${other.title}")\n` +
    `  query "${QUERY}" -> ${EXPECTED_OCCURRENCES} occurrence(s) in the target, ` +
    `${occurrences(corpus.texts.get(other.id) ?? "", QUERY).length} in the other, ` +
    `${chosen.scenes} scene(s) overall\n` +
    `  replacement "${REPLACEMENT}"`,
);

const observed = {
  reportedCount: null as number | null,
  panelOpened: false,
  liveText: null as string | null,
  restartText: null as string | null,
  reopenReady: false,
  oneText: null as string | null,
  undoDiverged: false,
  undoText: null as string | null,
  marksProbed: false,
  marksKept: false,
  peakRssMb: 0,
  startupMs: 0,
  statusText: null as string | null,
  noticeText: null as string | null,
};

async function waitForStore(
  projectPath: string,
  itemId: string,
  ok: (text: string) => boolean,
): Promise<string | null> {
  const deadline = Date.now() + COMMIT_TIMEOUT_MS;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = storeTextOf(projectPath, itemId);
    if (last !== null && ok(last)) return last;
    await Bun.sleep(STORE_POLL_MS);
  }
  return last;
}

interface BootOutcome {
  peakRssMb: number;
  ready: boolean;
  startupMs: number;
}

/** One boot against `projectPath`, with `drive` doing whatever this phase does.
 *  Every phase goes through here for the reason `shell.ts` owns spawning: a
 *  phase that booted the host slightly differently would answer a question
 *  about itself. */
async function boot(
  projectPath: string,
  drive: (ctx: { display: string; wid: string; rootPid: number }) => Promise<void>,
): Promise<BootOutcome> {
  const run = await runShell<{ ready: boolean; error?: string; startup_ms: number }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      GDK_BACKEND: "x11",
    },
    // The shell's own periodic prober would add walks this rig did not ask for,
    // and walks are exactly what the app does not survive many of.
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("the replace rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      // windowfocus / getwindowfocus, never windowactivate: the developer's
      // XWayland does not answer EWMH active-window queries, and typing into
      // whatever happens to be focused once put test sentences into the
      // operator's live terminal.
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(
          `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`,
        );
      }
      await drive({ display, wid, rootPid });
    },
  });
  const peak = run.peakRssMb;
  observed.peakRssMb = Math.max(observed.peakRssMb, peak);
  return { peakRssMb: peak, ready: run.payload.ready === true, startupMs: run.payload.startup_ms };
}

/** Open the panel on the query field, type the query, run the search. */
async function openAndSearch(display: string, wid: string, query: string): Promise<void> {
  xdo(display, ["key", "--window", wid, "ctrl+f"]);
  await Bun.sleep(PANEL_OPEN_MS);
  // Ctrl+F selects whatever the field holds, so typing replaces it.
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), query]);
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(SEARCH_SETTLE_MS);
}

/** Arrow onto the first result and open it: the shipped reveal, which opens the scene
 *  AND selects the first occurrence in it. Keystrokes only, which is what keeps
 *  this at zero walks -- clicking a row would need widget geometry, and
 *  geometry is a walk.
 *
 *  The first row is a scene by construction: the chosen term appears in no item
 *  title, so no part or chapter can match it and every result row is openable. */
async function revealFirstResult(display: string, wid: string): Promise<void> {
  xdo(display, ["key", "--window", wid, "Down"]);
  await Bun.sleep(400);
  xdo(display, ["key", "--window", wid, "Return"]);
  // The open is a round trip to the store before the reveal can select.
  await Bun.sleep(SETTLE_MS);
}

/** Edit > Replace... puts the caret in the REPLACE field and leaves the query
 *  alone, which is the shipped route and the only one that does not need the
 *  rig to count Tab stops from the query field. Two Tabs then reach Replace and
 *  All in scene, in the order find-bar.ts appends them.
 *
 *  If any of that is wrong the replacement text lands in some other surface, no
 *  occurrence changes, and the store guard aborts the run -- which is the
 *  failure it should be, not a plausible number. */
async function typeReplacementAndPress(
  display: string,
  wid: string,
  replacement: string,
  button: "one" | "all",
  presses = 1,
): Promise<void> {
  const menu = menuDriver(display, wid, xdo);
  await menu.activate("menu-replace");
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), replacement]);
  await Bun.sleep(300);
  const tabs = button === "one" ? 1 : 2;
  for (let i = 0; i < tabs; i++) {
    xdo(display, ["key", "--window", wid, "Tab"]);
    await Bun.sleep(150);
  }
  for (let i = 0; i < presses; i++) {
    xdo(display, ["key", "--window", wid, "Return"]);
    await Bun.sleep(ACTION_SETTLE_MS);
  }
}

// -- phase 1: replace all, and the count the panel announced -----------------
console.log("[2/7] boot 1: replace all in the open scene (ONE AT-SPI walk)");
{
  const outcome = await boot(basePath, async ({ display, wid, rootPid }) => {
    await openAndSearch(display, wid, QUERY);
    await revealFirstResult(display, wid);
    await typeReplacementAndPress(display, wid, REPLACEMENT, "all");
    // BY EFFECT: the store, not the page's account of the store.
    observed.liveText = await waitForStore(basePath, target.id, (t) => t !== TARGET_TEXT);
    // THE ONLY WALK OF THIS RUN.
    const panel = probePanelText(rootPid);
    observed.panelOpened = panel["find-status"] !== null || panel["open-error"] !== null;
    observed.reportedCount = parseReplacedCount(panel["open-error"], panel["find-status"]);
    observed.statusText = panel["find-status"];
    observed.noticeText = panel["open-error"];
    console.log(
      `  status  ${JSON.stringify(panel["find-status"])}\n` +
        `  notice  ${JSON.stringify(panel["open-error"])}`,
    );
    // AFTER the walk, not before, and that ordering is forced from both sides.
    // An info banner removes itself after 6000 ms, so a settle in front of the
    // walk costs the announced count -- measured: the notice read `null` with a
    // 6 s pre-walk sleep and reads correctly without one. Behind the walk, the
    // timers a widening write armed fire as soon as the walk stops starving
    // them, and the flush lands inside this window.
    await Bun.sleep(SCOPE_SETTLE_MS);
  });
  observed.startupMs = outcome.startupMs;
  if (!outcome.ready) abort("the page never became ready on the replace-all boot.");
}
if (!observed.panelOpened) {
  abort(
    "VACUITY GUARD: neither #find-status nor the notice banner was in the accessibility tree, " +
      "so the panel never opened and nothing was driven.",
  );
}
if (observed.liveText === null || observed.liveText === TARGET_TEXT) {
  abort(
    `VACUITY GUARD: the target scene's stored body never changed, so every gate below would be ` +
      `comparing the seeded text to itself. The replace never reached the store.`,
  );
}
console.log(
  `  reported count ${observed.reportedCount ?? "NONE"}, rig counted ${EXPECTED_OCCURRENCES}`,
);

// -- phase 2: the same project, reopened after the kill ----------------------
console.log("[3/7] boot 2: reopening the killed project (no walk, no input)");
{
  const outcome = await boot(basePath, async () => {
    // Nothing to drive. The claim is that the file survived a SIGKILL and that
    // the application opens it again; both are answered by SQLite afterwards.
    await Bun.sleep(SETTLE_MS);
  });
  observed.reopenReady = outcome.ready;
  observed.restartText = storeTextOf(basePath, target.id);
}

// -- phase 3: undo ----------------------------------------------------------
console.log("[4/7] boot 3: replace all, then ONE undo (no walk)");
{
  const undoPath = seed("phase-undo");
  await boot(undoPath, async ({ display, wid }) => {
    await openAndSearch(display, wid, QUERY);
    await revealFirstResult(display, wid);
    await typeReplacementAndPress(display, wid, REPLACEMENT, "all");
    const changed = await waitForStore(undoPath, target.id, (t) => t !== TARGET_TEXT);
    observed.undoDiverged = changed !== null && changed !== TARGET_TEXT;
    // Through the Edit menu rather than Ctrl+Z, because focus is on a panel
    // button and the editor's keymap only fires while the editor holds focus.
    // Same command either way: menu-bar.ts calls `editor.undo()`.
    const menu = menuDriver(display, wid, xdo);
    await menu.activate("menu-undo");
    observed.undoText = await waitForStore(undoPath, target.id, (t) => t === TARGET_TEXT);
  });
}

// -- phase 4: a single Replace ----------------------------------------------
console.log("[5/7] boot 4: two presses of Replace, one occurrence (no walk)");
{
  const onePath = seed("phase-one");
  await boot(onePath, async ({ display, wid }) => {
    await openAndSearch(display, wid, QUERY);
    // The reveal SELECTS the first occurrence, so ONE press of Replace acts on
    // it. (Without a reveal the first press would only select and the second
    // would act -- correct behaviour, but then the gate would be reading two
    // presses and could not tell a build that replaces on every press from one
    // that replaces on the second.)
    await revealFirstResult(display, wid);
    await typeReplacementAndPress(display, wid, REPLACEMENT, "one", 1);
    observed.oneText = await waitForStore(onePath, target.id, (t) => t !== TARGET_TEXT);
  });
}

// -- phase 5: the marks claim ------------------------------------------------
console.log("[6/7] boot 5: a replacement inside an emphasised run (no walk)");
{
  const marksPath = seed("phase-marks");
  // THE BOOT SCENE, not the revealed one. This phase types the emphasised nonce
  // into whatever the page opened, and replace is scoped to that -- so no
  // reveal happens here and no result row is activated. Polling the revealed
  // scene instead is exactly the defect the first run of this rig had: the
  // nonce landed correctly, the store held it, and the phase reported that it
  // could not set up its own precondition.
  const markScene = bootScene;
  await boot(marksPath, async ({ display, wid }) => {
    // The editor holds focus at mount. Ctrl+I with an empty selection sets
    // ProseMirror's stored marks, so the nonce is typed INTO an em run rather
    // than typed and then selected -- selecting a word by keyboard would need
    // word-boundary chords whose behaviour is the toolkit's, not the app's.
    // The fixtures carry no marks at all, which is why this is built here.
    xdo(display, ["key", "--window", wid, "ctrl+i"]);
    xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), MARK_TERM]);
    xdo(display, ["key", "--window", wid, "ctrl+i"]);
    xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), " "]);
    await Bun.sleep(SETTLE_MS);
    const seeded = await waitForStore(marksPath, markScene.id, (t) => t.includes(MARK_TERM));
    if (seeded === null || !seeded.includes(MARK_TERM)) return;
    const before = emphasisedTextNodes(storeBodyOf(marksPath, markScene.id), MARK_TERM);
    // The precondition, not the claim: without an emphasised nonce in the
    // store there is no mark for a replacement to inherit or lose, and the
    // gate would pass on a build that never carried marks at all.
    if (before.emphasised === 0) return;
    observed.marksProbed = true;

    await openAndSearch(display, wid, MARK_TERM);
    await typeReplacementAndPress(display, wid, MARK_REPLACEMENT, "all");
    const done = await waitForStore(marksPath, markScene.id, (t) => t.includes(MARK_REPLACEMENT));
    if (done === null || !done.includes(MARK_REPLACEMENT)) {
      // Probed and it did not arrive: that is a FAILURE of the replace, not a
      // precondition the rig could not build. Leaving marksProbed true is what
      // makes the gate say so.
      observed.marksKept = false;
      return;
    }
    const after = emphasisedTextNodes(storeBodyOf(marksPath, markScene.id), MARK_REPLACEMENT);
    observed.marksKept = after.total > 0 && after.emphasised === after.total;
    console.log(
      `  emphasised nodes: ${before.emphasised}/${before.total} before, ` +
        `${after.emphasised}/${after.total} after`,
    );
  });
}

console.log("[7/7] grading");

const otherAfter = storeBodyOf(basePath, other.id);
const otherText = projectText(otherAfter) ?? "";

const metrics: ReplaceMetrics = {
  fixture: fixtureName,
  query: QUERY,
  replacement: REPLACEMENT,
  target_item: target.id,
  other_item: other.id,
  expected_occurrences: EXPECTED_OCCURRENCES,
  reported_count: observed.reportedCount,
  all_matches_oracle: observed.liveText === EXPECTED_ALL,
  restart_matches_oracle: observed.restartText === EXPECTED_ALL,
  reopen_ready: observed.reopenReady,
  other_body_unchanged: otherAfter === OTHER_BODY_BEFORE,
  other_still_contains_term: occurrences(otherText, QUERY).length > 0,
  one_matches_oracle: observed.oneText === EXPECTED_ONE,
  one_occurrences_left: occurrences(observed.oneText ?? "", QUERY).length,
  undo_diverged_first: observed.undoDiverged,
  undo_matches_original: observed.undoText === TARGET_TEXT,
  marks_probed: observed.marksProbed,
  marks_kept: observed.marksKept,
  peak_rss_mb: observed.peakRssMb,
};

const verdicts: GateResult[] = evaluateReplaceGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${String(v.value)}`);
}

const result = buildResult({
  workload: "app-replace",
  runId: `app-replace-${fixtureName}`,
  candidate: "tauri",
  fixture: fixtureName,
  verdicts,
  metrics: {
    workload_script: "replace-v1",
    peak_rss_mb: observed.peakRssMb,
    startup_ms: observed.startupMs,
    items: corpus.walk.length,
    readable_documents: corpus.texts.size,
    boots: 5,
    atspi_walks: 1,
    replace: metrics,
    panel_status_text: observed.statusText,
    panel_notice_text: observed.noticeText,
    omitted_gates: [
      {
        gate: "latency, stall, cliff, a11y_exposure, a11y_tree_structure",
        reason:
          "the run types one word per boot and presses Return a handful of times. It is not a " +
          "soak and it never mutates the tree, so it has nothing true to say about frame " +
          "cadence, a leak slope, or the navigator's accessibility contract. peak_rss_mb IS " +
          "graded: a replace-all holds the whole open document plus a plan of every match.",
      },
      {
        gate: "a11y exposure of the replace controls",
        reason:
          "would cost a second AT-SPI walk in the boot that already spends the run's only one. " +
          "Several walks in one window kill this application at a boundary observed between the " +
          "third and the fifth, and the controls' accessible names are pinned by unit tests in " +
          "app/ui/test/find-bar.test.ts. A walk budget is a measurement, not caution.",
      },
    ],
    scope: {
      input:
        "Keystrokes only, no pointer input at all: Ctrl+F, the query, Return, then Edit > " +
        "Replace... (driven by Alt+E and ArrowDown through menu-drive.ts, whose index is parsed " +
        "from menu-bar.ts rather than restated), the replacement, Tab, Return. That sidesteps " +
        "the recorded hazard that `xdotool click --window` sends synthetic button events the " +
        "toolkit discards while reporting success, and it costs no widget geometry -- geometry " +
        "would cost a walk.",
      the_oracle:
        "The store, read directly with bun:sqlite through a recursive CTE this rig restates, " +
        "with every body projected by projectText() -- the rig's OWN restatement, written from " +
        "the format and not imported from store::document_text, find-locate.ts or replace.ts. " +
        "The expected post-replace text is computed by the rig from the SEEDED body before any " +
        "boot, so no gate below is the application's account of itself.",
      folding:
        "The rig folds ONE CODE POINT AT A TIME, restated from find-locate.ts's rule: " +
        "String.prototype.toLowerCase implements Final_Sigma and would disagree with the host " +
        "on a Greek word. Every query is drawn from the fixture and restricted to ASCII, so the " +
        "difference is unreachable on this run and would surface as a loud failure rather than " +
        "a quiet one.",
      the_expected_text:
        "Computed on the PROJECTED text while the application computes on document positions. " +
        "Sound only because the query is a single ASCII word: it cannot span the synthetic " +
        "block separator, and the replacement introduces no block boundary. Both are enforced " +
        "by how the term is chosen, not assumed.",
      restart:
        "runShell kills the shell rather than closing it (SIGTERM to the wrapper, then pkill, " +
        "then -9), so nothing graceful runs and no CloseRequested handler can save the day. " +
        "replace_all_changes_the_store reads the store WHILE THE APP RUNS and " +
        "replace_survives_a_restart reads it after the kill and a reopen: two measurements, not " +
        "one taken twice.",
      the_announced_count:
        "Read off the live accessibility tree, which is the only channel it has: the panel writes " +
        "the figure to a notice banner and `search()` overwrites #find-status synchronously in " +
        "the same tick. The banner's SENTENCE is not exposed to AT-SPI -- the walk finds the " +
        "element by its DOM id and the only text in its subtree is the dismiss button's " +
        "accessible name -- so the gate reports UNKNOWN rather than a pass it did not earn. It " +
        "read 3 == 3 on the build of 2026-08-18 that put the message directly in the banner div, " +
        "four runs running; it went blind when the banner grew a <span> and a dismiss button.",
      marks:
        "The seeded corpora carry no marks at all, so the emphasis is built by the rig with the " +
        "shipped Ctrl+I and verified in the store BEFORE the replace. If that precondition " +
        "fails the gate reports UNKNOWN; a gate that cannot fail must not report a pass.",
    },
  },
  seed: "app-v1",
  rigCommit: gitShortSha(),
  environment: captureEnv(),
});

writeResult(result, RESULTS);
cleanup();

const failed = verdicts.filter((v) => v.verdict === "FAIL");
console.log(
  failed.length === 0
    ? `all ${verdicts.length} gate(s) PASS or UNKNOWN`
    : `${failed.length} gate(s) FAILED`,
);
process.exit(failed.length === 0 ? 0 : 1);
