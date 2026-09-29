// app/harness/src/words-cli.ts
// Graded drafting-essentials run. Types a known sentence into the open scene,
// italicises a word of it with Mod-i through REAL keyboard input, reads the two
// figures the project bar shows, compares the host's project total against the
// sum of the page's own per-scene counts over the same saved state, kills the
// window, and reopens the project to see whether the mark is still there.
//
// The comparison is the reason this slice is graded. One rule -- a word is a
// maximal run of non-whitespace -- is implemented twice, in app/ui/src/words.ts
// and app/shell-tauri/src-tauri/src/words.rs, deliberately restated rather than
// shared. A shared case table pins the RULE in unit tests. It cannot pin what
// each side counts OVER: the page walks a live ProseMirror document, the host
// walks serialized JSON out of SQLite, and those traversals are separate code.
// A drift there reaches the writer as a project total that is not the sum of
// their scenes, which is a number they would notice and could not explain.
//
// HOW THE HOST'S NUMBER IS READ: off the platform accessibility tree, the same
// channel a screen reader uses. project_word_count is reachable only through the
// page and the page reports neither the figure nor the latency in its sink
// payload, so the rig has to read the display -- and the display is now exposed,
// with an accessible name carrying both figures.
//
// It did not used to be. Until 2026-08-12 the word count was invisible to
// assistive technology (a full AT-SPI walk showed `document web` with four
// children and #word-count among none of them), and this rig read it by
// TRIPLE-CLICKING the project bar and scraping the X PRIMARY selection with
// xclip. That made xclip a hard prerequisite, and it stole keyboard focus from
// the editor before every read -- which aborted a run once. Exposing the element
// removed the defect and the dependency together, which is why
// a11y_word_count_exposed is graded here: the gate is what stops the rig
// silently regrowing a scrape.
//
// Usage: APP_GUI=1 bun app/harness/src/words-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countWordsIn, schema } from "../../ui/src/editor";
import { bodyHash } from "../../ui/src/store/hash";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateWordsGates, type GateResult, type WordsMetrics } from "./gates";
import { buildResult, writeResult } from "./results";
import { COMMIT_POLL_MS, WATCH_POLL_MS, scanFloorMs } from "./words-floor";
import {
  BIN,
  SHELL_PROC_NAME,
  findWindowId,
  runShell,
  survivingShellPids,
  type SinkPayload,
  type WritePersistBlock,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

// The project bar's height and the window's width used to be restated here, to
// compute a point on the bar that was safe to triple-click. Nothing clicks the
// bar any more, so they are gone; outline-cli.ts and switch-cli.ts still hold
// their own copies, because those rigs still click navigator rows.

/** How far inside the editable's bottom-right corner to click. The element is
 *  only as tall as its prose, so a click below it lands on #editor's padding and
 *  focus stays wherever it was -- which types the next word into nothing. */
const EDGE_INSET_PX = 4;

/** Typed into the scene the page opens at boot. Spaces are safe here and only
 *  here: the mount focuses the editor, and the run verifies by effect that the
 *  sentence reached that scene's stored body before it does anything else. If it
 *  had not, focus would be on the navigator, where SPACE IS ACTIVATION rather
 *  than type-ahead, and the run aborts instead of recording the scatter. */
const SENTENCE = "The archivist marked one crate and set the ledger down.";
/** A distinctive fragment of it, for the by-effect check. */
const SENTENCE_MARKER = "archivist marked one crate";
/** One word, typed fast, for the scan-latency phase. Short enough that the whole
 *  word lands well inside the page's 1000 ms flush debounce, so exactly ONE
 *  commit and therefore exactly one project rescan follows it. A longer string
 *  would straddle the debounce, the display would repaint from the first commit,
 *  and the interval measured would be against the wrong t0. */
const TIMING_WORD = " zzqqzz";

/** xdotool type returns when X has the key events, not when WebKitGTK has turned
 *  them into document state. hand-cli.ts found 500 ms silently truncating typed
 *  text; 2500 ms is what held. */
const SETTLE_MS = 2500;
/** Store polling granularity while timing a commit. Each poll opens a fresh
 *  read-only connection, so this period is a floor and the read cost is measured
 *  (`commitReadCosts`) rather than assumed. Both live in words-floor.ts, where
 *  the gates test can reach them without importing this CLI's side effects. */
const POLL_MS = COMMIT_POLL_MS;
/** How long one store write may take to appear before the rig calls it lost. */
const COMMIT_TIMEOUT_MS = 15_000;
/** How long the project bar may take to repaint before the rig calls it never. */
const REPAINT_TIMEOUT_MS = 15_000;
// WATCH_POLL_MS -- how often the repaint watcher re-reads the exposed name, in
// its own process -- lives in words-floor.ts beside the commit-side period,
// because together they are what bounds the scan measurement's resolution.
/** How long the watcher may take to connect to the bus and resolve the node.
 *  Generous because an AT-SPI walk of this app's tree costs seconds; the rig
 *  waits for the watcher to SAY it is armed rather than assuming, so this bound
 *  only has to be longer than a walk, not tuned to one. */
const WATCH_ARM_TIMEOUT_MS = 120_000;
/** Between two AT-SPI clients where nothing else already separates them. */
const PROBE_SPACING_MS = 2000;
/** The store must be unchanged for this long before the display and the file are
 *  read as one consistent state. The flush debounce is 1000 ms, so a shorter
 *  window can catch the gap between two flushes and call it quiet. */
const QUIET_MS = 2000;
/** Long enough for a run of flushes to have been armed, fired and answered. */
const QUIET_TIMEOUT_MS = 30_000;
/** The DOM id the exposed element carries into the accessibility tree as its
 *  `id` object attribute. How the rig finds it; the ROLE is then read off the
 *  node and graded, never used to find it. */
const COUNT_ID = "word-count";

/** The accessible NAME of the word count, from app/ui/src/word-count.ts:
 *  "Word count: N words in this scene, M saved in the project", where M is a
 *  horizontal ellipsis before the first answer and an em dash when the host
 *  could not answer. Both of those are states, not numbers, and neither may be
 *  read as 0. The figures are parsed out of the name because the name is the
 *  channel certain to survive: the two spans holding the visible text are
 *  generic nodes WebKitGTK is free to prune. */
//
//  The trailing clause is the DAY's figure, added by the writing-goals slice,
//  and it is optional here because it is absent until the first answer lands.
//  This rig grades the first two figures and says nothing about the third --
//  goals-cli owns that claim. What matters here is that a third figure must not
//  make the count read as ABSENT from the tree, which is what a pattern
//  anchored straight to `$` after "project" would have reported.
const NAME_PATTERN =
  /^Word count: ([\d,]+) words? in this scene, ([\d,]+|…|—) saved in the project(?:, .+)?$/u;

/** The VISIBLE text, as the node's Text interface reports it. Not where the
 *  figures are parsed from -- it is the corroborating half of the exposure gate,
 *  which asserts that what a screen reader can read matches what is on screen.
 *
 *  IT IS A DIFFERENT SENTENCE FROM THE NAME, and deliberately so as of the
 *  visual redesign. The readout says "47 words · 2,000 in the book" (236), then
 *  the day's figure after a plain space (239: one middle dot per line), because it sits
 *  beside other controls in a strip whose height three rigs restate (#footer
 *  since 067, #project-bar before); the name keeps the full sentence because a
 *  screen reader user has no strip to look at
 *  and "47 words" followed by "2,000 in the book" does not say the figure lags.
 *  Before the split the name was built by reading these spans back out of the
 *  DOM, which made the bar's wording load-bearing for accessibility.
 *
 *  The split is what a11y_word_count_agrees polices: two renderings of one pair
 *  of numbers can drift in a way nothing inside the page can see, because in the
 *  page they come from the same two variables. */
const TEXT_PATTERN = /^([\d,]+) words? · ([\d,]+|…|—) in the book(?: .+)?$/u;

/** The two figures out of a channel, as WRITTEN - not parsed to numbers. The
 *  comparison is between two renderings of the same value, so "2,000" against
 *  "2000" is a real disagreement (one of them is being formatted differently
 *  from the other) and normalizing it away would hide exactly that. */
function figuresOf(pattern: RegExp, text: string): readonly [string, string] | null {
  const m = pattern.exec(text);
  return m === null ? null : [m[1]!, m[2]!];
}

/** The word count as the accessibility tree holds it. `null` for any field means
 *  the tree was walked and the thing was not there, which is a FAIL of
 *  a11y_word_count_exposed and never an abort: detecting that is the point. */
interface CountNode {
  /** The ATK role. Graded. */
  role: string;
  name: string;
  text: string;
}

interface BarReading {
  raw: string;
  node: CountNode;
  sceneWords: number;
  /** null when the figure is the pending ellipsis or the failed em dash.
   *  Collapsing either onto 0 would make a display that never answered agree
   *  with an empty manuscript. */
  projectWords: number | null;
}

function parseName(node: CountNode): BarReading | null {
  const m = NAME_PATTERN.exec(node.name);
  if (m === null) return null;
  const figure = m[2]!;
  return {
    raw: node.name,
    node,
    sceneWords: Number(m[1]!.replaceAll(",", "")),
    projectWords: /^[\d,]+$/.test(figure) ? Number(figure.replaceAll(",", "")) : null,
  };
}

/** The clause of the accessible name that changes exactly when the PROJECT
 *  figure repaints. The watcher below fires on this and not on the whole name,
 *  because the scene figure repaints on the keystroke -- long before the flush
 *  the scan is being timed from.
 *
 *  IT IS NO LONGER A SUFFIX, and the watcher matches on CONTAINMENT for that
 *  reason. The writing-goals slice appended a third figure to the name, so this
 *  clause sits in the middle of it; the watcher's old `endswith` test was false
 *  from its very first poll, fired before the flush had even landed, and the
 *  rig reported `no repaint observed` -- a gate silently degraded from PASS to
 *  UNKNOWN by a wording change three files away. That is the recorded hazard
 *  about this pair of patterns, and moving only the two regexes above was
 *  moving half of it. */
function projectSuffix(node: CountNode): string {
  const m = NAME_PATTERN.exec(node.name);
  return m === null ? node.name : `${m[2]!} saved in the project`;
}

interface WalkRow {
  id: string;
  type: string;
}

/** store/mod.rs MAX_DEPTH. Without it the CTE recurses forever on a parent_id
 *  cycle where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;
const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, position, depth, path) AS (
     SELECT id, parent_id, type, position, 0, position FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.position, w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ${MAX_DEPTH}
   )
   SELECT id, type FROM walk ORDER BY path`;

function openRead(projectPath: string): Database {
  return new Database(projectPath, { readonly: true });
}

function walkOnce(projectPath: string): WalkRow[] {
  const db = openRead(projectPath);
  try {
    return db.query(WALK_SQL).all() as WalkRow[];
  } finally {
    db.close();
  }
}

function bodiesOnce(projectPath: string): Map<string, string> {
  const db = openRead(projectPath);
  try {
    const rows = db.query("SELECT item_id, body FROM doc").all() as {
      item_id: string;
      body: string;
    }[];
    return new Map(rows.map((r) => [r.item_id, r.body]));
  } finally {
    db.close();
  }
}

/** Every stored body in one comparable string, so "did anything change" is one
 *  read rather than a document-by-document diff. */
function signatureOf(bodies: ReadonlyMap<string, string>): string {
  return [...bodies]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** The page's OWN per-scene word count, over a body as the store holds it.
 *
 *  countWordsIn and schema are IMPORTED from app/ui/src/editor.ts rather than
 *  restated, and that is the opposite of this harness's usual rule for a reason:
 *  the gate's claim is that the host's total equals the sum of THE PAGE'S
 *  counts. A restatement here would be a third implementation, and the three
 *  could then disagree in a way that hides which two were being compared. The
 *  thresholds gates.ts restates are specifications; this is not a specification,
 *  it is one of the two things under comparison. */
function pageWordsOf(body: string): number {
  return countWordsIn(schema.nodeFromJSON(JSON.parse(body) as Record<string, unknown>));
}

interface PmJson {
  type: string;
  text?: string;
  marks?: { type: string }[];
  content?: PmJson[];
}

/** Every text run in `body` carrying `mark`. */
function markedRuns(body: string, mark: string): string[] {
  const out: string[] = [];
  const walk = (node: PmJson): void => {
    if (node.type === "text" && (node.marks ?? []).some((m) => m.type === mark)) {
      out.push(node.text ?? "");
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(JSON.parse(body) as PmJson);
  return out;
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

// ONE AT-SPI client, answering everything this rig needs from the accessibility
// tree in a single walk: widget geometry (the toggle bounds the bar's own
// controls, the editable's bounds are where the caret can be put), the word
// count node itself, and the editable's current text selection. Batched rather
// than three probes on purpose -- repeated pyatspi clients a few hundred
// milliseconds apart wedge the WebKitGTK bridge, and one run has already hung
// 300 s that way.
//
// JSON out, not TSV: an accessible name and a selected run of prose are
// arbitrary text, and a manuscript containing a tab would silently shift every
// field after it.
export const PY_PROBE = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
count_id = sys.argv[2]
GEOM = ("push button", "button", "toggle button", "entry", "text")

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

nodes = []
found = {"count": None, "selection": ""}

def walk(node):
    try:
        role = node.getRoleName()
        i = ident(node)
        if role in GEOM:
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            nodes.append({"role": role, "id": i, "name": node.name or "",
                          "x": e.x, "y": e.y, "w": e.width, "h": e.height})
            if role in ("entry", "text") and not found["selection"]:
                try:
                    t = node.queryText()
                    s, e2 = t.getSelection(0)
                    if e2 > s:
                        found["selection"] = t.getText(s, e2)
                except Exception:
                    pass
        if i == count_id and found["count"] is None:
            text = ""
            try:
                t = node.queryText()
                text = t.getText(0, t.characterCount)
            except Exception:
                text = ""
            found["count"] = {"role": role, "name": node.name or "", "text": text}
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps({"nodes": nodes, "count": found["count"],
                             "selection": found["selection"]}))
`;

// The repaint watcher. Resolves the word count ONCE and then polls the object it
// already holds, in its own process, so timing the repaint costs one AT-SPI
// client rather than one per poll. The predecessor polled by triple-clicking the
// bar and scraping PRIMARY as fast as it could; doing that with pyatspi clients
// would wedge the bridge inside a second.
export const PY_WATCH = String.raw`
import json
import sys
import time
try:
    import pyatspi
    from gi.repository import GLib
except Exception:
    sys.exit(3)
count_id, suffix, ready_path = sys.argv[2], sys.argv[3], sys.argv[4]
timeout_ms, poll_ms = float(sys.argv[5]), float(sys.argv[6])

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

found = []

def walk(node):
    # Short-circuits the WHOLE walk once the node is in hand, not just the
    # subtree: every AT-SPI property is a round trip and a full walk of this
    # app's tree costs about twelve seconds.
    if found:
        return
    try:
        if ident(node) == count_id:
            found.append(node)
            return
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
            if found:
                return
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
if not found:
    sys.stdout.write(json.dumps({"status": "notfound"}))
    sys.exit(0)
node = found[0]
# Only now is this process actually watching. The caller waits for this file
# before it types: a fixed arming delay measured the WALK instead of the repaint
# -- 12092 ms on two runs whose predecessor measured 85 -- because the keystroke
# landed while the watcher was still resolving the node, and the first poll it
# ever took already saw the new value.
with open(ready_path, "w") as f:
    f.write("ready")
costs = []
# The AT-SPI client library caches an accessible's name and invalidates it from
# a D-Bus property-change signal. Nothing here runs a main loop, so without
# pumping the default context by hand the held proxy answers the name it was
# first asked for: the first version of this watcher reported the repaint 12093
# ms after the commit, on a run whose predecessor measured 85 ms. pyatspi's
# setCacheLevel and clearCache both raise NotImplementedError on this build, so
# draining the pending events IS the cache invalidation.
ctx = GLib.MainContext.default()
deadline = time.monotonic() + timeout_ms / 1000.0
while time.monotonic() < deadline:
    at = time.monotonic()
    try:
        while ctx.pending():
            ctx.iteration(False)
        name = node.name or ""
    except Exception:
        name = ""
    costs.append((time.monotonic() - at) * 1000.0)
    if suffix not in name:
        costs.sort()
        sys.stdout.write(json.dumps({"status": "changed", "at_ms": time.time() * 1000.0,
                                     "read_ms": costs[len(costs) // 2], "name": name}))
        sys.exit(0)
    time.sleep(poll_ms / 1000.0)
costs.sort()
sys.stdout.write(json.dumps({"status": "timeout",
                             "read_ms": costs[len(costs) // 2] if costs else 0.0}))
`;

interface Node {
  role: string;
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Probe {
  nodes: Node[];
  /** null means the tree was walked and no node carried the word count's id. A
   *  FINDING, not a rig failure: it is the defect a11y_word_count_exposed
   *  exists to catch, so it is recorded and graded rather than aborted on. */
  count: CountNode | null;
  /** The editable's selected text, "" when nothing is selected. */
  selection: string;
}

/** One AT-SPI walk. Throws when the PROBE fails -- no python, no pyatspi, no
 *  bus, or not exactly one matching app -- because then nothing was measured and
 *  a written result would be a claim about a tree that was never read. */
function probeTree(rootPid: number): Probe {
  const proc = Bun.spawnSync(["python3", "-c", PY_PROBE, pidListArg(rootPid), COUNT_ID], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `could not read the accessibility tree (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(proc.stdout.toString()) as Probe;
}

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


function abort(message: string, cleanup: () => void): never {
  console.error(`\n${message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; words run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} - build it or generate the fixture before running.`);
    process.exit(1);
  }
}
{
  const preexisting = survivingShellPids();
  if (preexisting.length > 0) {
    console.error(
      `refusing to start: ${SHELL_PROC_NAME} already running (pid(s) ${preexisting.join(", ")}).\n` +
        `A pre-existing instance makes the AT-SPI widget lookup unable to attribute geometry to ` +
        `exactly one window, and its window could receive the keystrokes.`,
    );
    process.exit(1);
  }
}

const projectDir = mkdtempSync(join(tmpdir(), "app-words-"));
const projectPath = join(projectDir, "project.db");
/** The repaint watcher creates this once it holds the node. A file rather than a
 *  line on its stdout because the result is read off stdout after it exits, and
 *  two readers of one pipe is a race to debug for no gain. */
const readyPath = join(projectDir, "watcher-armed");
function cleanup(): void {
  rmSync(projectDir, { recursive: true, force: true });
}

console.log(`[1/4] seeding project from ${FIXTURE}`);
const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
  stdout: "inherit",
  stderr: "inherit",
});
if (seeded.exitCode !== 0) {
  console.error(`seeding failed (exit ${seeded.exitCode}); nothing was written.`);
  cleanup();
  process.exit(1);
}

const walk0 = walkOnce(projectPath);
// The scene the page opens at boot: app/ui/src/project.ts takes the first scene
// of the depth-first walk. Everything below is typed into it, so the reopen boot
// LOADS the marked document rather than merely leaving it on disk - which is
// what makes marks_persist cover the page's parse of an em mark and not only
// SQLite's ability to keep bytes.
const bootScene = walk0.find((r) => r.type === "scene");
if (bootScene === undefined) {
  console.error("fixture has no scene: there is nothing to open, type into or mark.");
  cleanup();
  process.exit(2);
}
const sceneId = bootScene.id;
const seedBodies = bodiesOnce(projectPath);
console.log(`  ${walk0.length} items, ${seedBodies.size} document(s); boot scene = ${sceneId}`);

/** Median cost of ONE name read inside the watcher, in ms. Half of the rig's
 *  resolution floor; on its own it is not the floor and must not be reported as
 *  one. */
let watchReadMs = 0;
/** Median cost of ONE commit-side store read: open a read-only connection, read
 *  every stored body, close. The other half. */
let commitReadMs = 0;
/** What the interactive phase observed of the display.
 *
 *  A mutable record rather than a handful of `let`s, and that is not a style
 *  choice: TypeScript's flow analysis cannot see assignments made inside the run
 *  hook, so a `let` initialised to `null` narrows to `null` for the rest of the
 *  file and every guard below would be typed against `never`. That is exactly
 *  how the predecessor's `finalBar === null` check compiled - `never` is
 *  assignable to anything, so the check type-checked while asserting nothing.
 *  Property narrowing is reset by the intervening calls, so these read as the
 *  unions they are.
 *
 *  `finalCount` is separate from `finalBar` because it is what
 *  a11y_word_count_exposed is graded from, and it has to survive a name the rig
 *  cannot parse: "exposed under an unusable name" and "not exposed at all" are
 *  both failures, and a reader of a FAIL needs to know which one happened. */
const seen: {
  baselineBar: BarReading | null;
  typedBar: BarReading | null;
  finalBar: BarReading | null;
  finalCount: CountNode | null;
} = { baselineBar: null, typedBar: null, finalBar: null, finalCount: null };
let markWord = "";
let markAppliedLive = false;
let scanMs: number | null = null;
/** Every reading of the word count in order, with what each was taken around.
 *  The accessible name is the rig's only view of the host's figure, so it is
 *  recorded verbatim. */
const barReadings: { label: string; raw: string }[] = [];

console.log("\n[2/4] interactive run");
// GDK_BACKEND=x11 is load-bearing: a developer's ambient session sets
// WAYLAND_DISPLAY and GTK prefers Wayland, so the webview would open on the real
// desktop instead of the Xvfb display xdotool targets.
async function drive(): Promise<
  Awaited<ReturnType<typeof runShell<SinkPayload & { item_id: string | null }>>>
> {
  return runShell<SinkPayload & { item_id: string | null }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", APP_PROJECT: projectPath, GDK_BACKEND: "x11" },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("words rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);

      // windowfocus / getwindowfocus, never windowactivate / getactivewindow:
      // the developer's XWayland does not answer EWMH active-window queries, and
      // typing into whatever happens to be focused once put test sentences into
      // the operator's live terminal.
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(
          `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}. ` +
            `Whatever is focused would receive the keystrokes.`,
        );
      }

      /** Read the word count off the accessibility tree, the way a screen reader
       *  does. One AT-SPI walk, no click and no focus change: reading the
       *  display no longer disturbs the thing being measured. `null` means the
       *  tree was walked and the count was not usable - either absent, or
       *  present under a name that does not read as a word count. Both are
       *  gradeable findings, so neither throws. */
      function readBar(label: string, from: Probe): BarReading | null {
        barReadings.push({
          label,
          raw: from.count === null ? "<absent from the accessibility tree>" : from.count.name,
        });
        return from.count === null ? null : parseName(from.count);
      }

      /** Wait until the store has been unchanged for QUIET_MS, so the file and
       *  whatever the bar last painted describe the same state. Without it the
       *  agreement gate could compare a total scanned before the last flush
       *  against a file read after it, and report a drift that is really a race
       *  in the rig. */
      async function settle(): Promise<void> {
        const deadline = Date.now() + QUIET_TIMEOUT_MS;
        let last = signatureOf(bodiesOnce(projectPath));
        let unchangedSince = Date.now();
        while (Date.now() < deadline) {
          await Bun.sleep(100);
          const now = signatureOf(bodiesOnce(projectPath));
          if (now !== last) {
            last = now;
            unchangedSince = Date.now();
            continue;
          }
          if (Date.now() - unchangedSince >= QUIET_MS) return;
        }
        throw new Error(
          `the store never went quiet for ${QUIET_MS} ms: something is still writing, and the ` +
            "displayed total and the file would describe different states.",
        );
      }

      /** Put the caret at the end of the open document, by clicking the last
       *  line of the contenteditable itself. NOT a click at a fixed point low
       *  in the editor pane: the editable is only as tall as its prose, so a
       *  click below it lands on #editor's padding and focus stays wherever it
       *  was. `from` is a geometry read the caller already took, so a caller
       *  can reuse one AT-SPI walk rather than spending another - repeated
       *  pyatspi clients a few hundred milliseconds apart wedge the WebKitGTK
       *  bridge.
       *
       *  Called ONCE, for the caret and not for focus. The predecessor called it
       *  again before the sentence, because reading the bar meant triple-clicking
       *  it and every read took keyboard focus away from the editor; nothing
       *  takes focus any more. */
      function clickEditorEnd(from: readonly Node[]): void {
        const entry = from.find((n) => n.role === "entry" || n.role === "text");
        if (entry === undefined) {
          throw new Error("no editable text node in the accessibility tree: nothing to type into");
        }
        xdo(display, [
          "mousemove",
          "--window",
          wid,
          String(entry.x + entry.w - EDGE_INSET_PX),
          String(entry.y + entry.h - EDGE_INSET_PX),
        ]);
        xdo(display, ["click", "1"]);
      }

      // One walk, answering both opening questions: where the editable is, and
      // what the word count currently reads. The predecessor spent one walk on
      // geometry and then six triple-click-and-scrape reads for the second.
      const opening = probeTree(rootPid);
      seen.baselineBar = readBar("baseline", opening);
      console.log(
        `  baseline: ${
          seen.baselineBar === null
            ? "the word count is NOT in the accessibility tree"
            : JSON.stringify(seen.baselineBar.raw)
        }`,
      );

      // 1. Scan latency, FIRST, and that order is load-bearing: whatever this
      //    phase types lands next to the caret, and text typed next to a marked
      //    run inherits its stored marks. Run after the mark, it extended the
      //    marked run to "down. zzqqzz" and marks_persist FAILed on a rig
      //    artifact with the application behaving correctly - which is exactly
      //    the false FAIL this project has to keep out of its evidence. Nothing
      //    is typed after the mark now.
      //
      //    One short word, typed fast enough to fit inside the page's 1000 ms
      //    flush debounce, so exactly one commit and exactly one rescan follow.
      //    t0 is that commit as a second read-only connection sees it; t1 is
      //    when the exposed name's project half stops reading what it read at
      //    baseline, as a watcher holding the node reports it.
      clickEditorEnd(opening.nodes);
      await Bun.sleep(800);

      // The watcher is armed BEFORE the keystroke and resolves the node itself,
      // so the interval below is not paced by anything this process does. It is
      // also the only AT-SPI client alive while the timing word is typed.
      const watcher =
        seen.baselineBar === null
          ? null
          : Bun.spawn(
              [
                "python3",
                "-c",
                PY_WATCH,
                pidListArg(rootPid),
                COUNT_ID,
                projectSuffix(seen.baselineBar.node),
                readyPath,
                String(REPAINT_TIMEOUT_MS),
                String(WATCH_POLL_MS),
              ],
              { stdout: "pipe", stderr: "pipe" },
            );
      // Wait for the watcher to SAY it is watching. A fixed delay here measured
      // the walk instead of the repaint: 12092 ms on two runs, deterministic,
      // because the keystroke landed while the watcher was still resolving the
      // node and its first poll already saw the new value.
      if (watcher !== null) {
        const deadline = Date.now() + WATCH_ARM_TIMEOUT_MS;
        while (!existsSync(readyPath) && watcher.exitCode === null && Date.now() < deadline) {
          await Bun.sleep(50);
        }
        if (!existsSync(readyPath) && watcher.exitCode === null) {
          throw new Error(
            `the repaint watcher never armed within ${WATCH_ARM_TIMEOUT_MS} ms. Timing the scan ` +
              "against an unarmed watcher measures its tree walk, not the application.",
          );
        }
      }

      const beforeTiming = signatureOf(bodiesOnce(projectPath));
      xdo(display, ["type", "--delay", "20", TIMING_WORD]);
      let t0 = 0;
      {
        // Each read is timed, because a fresh SQLite connection per poll is the
        // commit endpoint's real granularity and POLL_MS alone understates it.
        const commitReadCosts: number[] = [];
        const deadline = Date.now() + COMMIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const at = performance.now();
          const sig = signatureOf(bodiesOnce(projectPath));
          commitReadCosts.push(performance.now() - at);
          if (sig !== beforeTiming) {
            t0 = Date.now();
            break;
          }
          await Bun.sleep(POLL_MS);
        }
        commitReadCosts.sort((a, b) => a - b);
        commitReadMs = Number(
          (commitReadCosts[Math.floor(commitReadCosts.length / 2)] ?? 0).toFixed(1),
        );
      }
      if (watcher !== null) {
        await watcher.exited;
        const repaint = JSON.parse(await new Response(watcher.stdout).text()) as {
          status: string;
          at_ms?: number;
          read_ms?: number;
          name?: string;
        };
        watchReadMs = Number((repaint.read_ms ?? 0).toFixed(1));
        if (t0 === 0) {
          console.log("  the timing word never committed; scan latency is UNKNOWN for this run.");
        } else if (repaint.status === "changed" && repaint.at_ms !== undefined) {
          const observed = Math.round(repaint.at_ms - t0);
          // A repaint that appears to precede the commit it is timed from is not
          // a fast scan, it is two clocks disagreeing. Left UNKNOWN rather than
          // recorded, because a negative interval passes any `< threshold` test.
          scanMs = observed < 0 ? null : observed;
          barReadings.push({ label: "scan-repaint", raw: repaint.name ?? "" });
          const floor = scanFloorMs(watchReadMs, commitReadMs);
          console.log(
            scanMs === null
              ? `  the repaint timed ${observed} ms BEFORE the commit; scan latency is UNKNOWN.`
              : `  project total repainted ${scanMs} ms after the commit` +
                `${scanMs < floor ? ", which is BELOW" : ", against"} the rig's ~${floor} ms floor ` +
                `(${WATCH_POLL_MS} ms watcher period / ${watchReadMs} ms name read; ` +
                `${POLL_MS} ms commit period / ${commitReadMs} ms store read)`,
          );
        } else {
          console.log(
            `  the project total never repainted (watcher: ${repaint.status}); scan latency is ` +
              "UNKNOWN for this run.",
          );
        }
      }

      // 2. Type the sentence into the scene the page already has open. No row
      //    click: using the boot document means the reopen boot loads and parses
      //    THIS body rather than some other one.
      //
      //    No second caret click. Nothing above moved focus or the caret, so the
      //    caret is still where the timing word left it - which is also why the
      //    sentence is typed with a leading space rather than abutting it.
      await Bun.sleep(PROBE_SPACING_MS);
      xdo(display, ["type", "--delay", "40", ` ${SENTENCE}`]);
      await Bun.sleep(SETTLE_MS);
      // Verified by effect, never by asking the screen. If the sentence is not
      // in that scene's stored body the keystrokes went somewhere else - the
      // navigator, most likely, where Space is activation - and every figure
      // below would be about a manuscript this rig scattered.
      {
        const deadline = Date.now() + COMMIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if ((bodiesOnce(projectPath).get(sceneId) ?? "").includes(SENTENCE_MARKER)) break;
          await Bun.sleep(POLL_MS);
        }
      }
      if (!(bodiesOnce(projectPath).get(sceneId) ?? "").includes(SENTENCE_MARKER)) {
        throw new Error(
          `the typed sentence never reached ${sceneId}'s stored body. Keyboard focus was not in ` +
            "the editor, so the keystrokes landed elsewhere and nothing below describes this run.",
        );
      }

      // 3. Select the word just typed and italicise it. ctrl+shift+Left with the
      //    caret still sitting where the typing left it, so no click is needed
      //    and focus cannot move between the two. The selected text is READ from
      //    the editable's own Text interface rather than assumed: the rig does
      //    not choose the word, the editor's word-boundary rules do, and a gate
      //    that named the wrong word would be unfalsifiable. It used to be read
      //    from the X PRIMARY selection, which had the failure mode of quietly
      //    handing back the PREVIOUS selection when the chord selected nothing;
      //    an empty AT-SPI selection is empty.
      xdo(display, ["key", "--clearmodifiers", "ctrl+shift+Left"]);
      await Bun.sleep(800);
      markWord = probeTree(rootPid).selection;
      barReadings.push({ label: "selection-before-mark", raw: markWord });
      if (markWord.length === 0 || /\s/u.test(markWord) || !SENTENCE.includes(markWord)) {
        throw new Error(
          `the selection before Mod-i reads ${JSON.stringify(markWord)}, which is not a single ` +
            "word of the sentence this run typed. Either the chord selected nothing or it " +
            "selected across a boundary, and the mark would be asserted about text the rig " +
            "cannot identify.",
        );
      }
      console.log(`  italicising ${JSON.stringify(markWord)}`);
      xdo(display, ["key", "--clearmodifiers", "ctrl+i"]);
      await Bun.sleep(SETTLE_MS);
      await settle();
      markAppliedLive = markedRuns(bodiesOnce(projectPath).get(sceneId) ?? "", "em").includes(
        markWord,
      );

      seen.typedBar = readBar("after-typing-and-mark", probeTree(rootPid));
      console.log(`  after typing: ${JSON.stringify(seen.typedBar?.raw ?? null)}`);

      // 4. One consistent state: nothing else is typed from here, so once the
      //    store is quiet the file and the bar describe the same manuscript and
      //    the agreement gate compares like with like. This is the read
      //    a11y_word_count_exposed is graded from, and settle() has already put
      //    seconds between it and the one above.
      await settle();
      const closing = probeTree(rootPid);
      seen.finalCount = closing.count;
      seen.finalBar = readBar("final", closing);
      console.log(
        `  final: ${
          seen.finalBar === null
            ? "the word count is NOT readable from the accessibility tree"
            : JSON.stringify(seen.finalBar.raw)
        }`,
      );

      // No window manager under Xvfb: this raises BadDrawable and kills the
      // process rather than delivering a graceful close (hand-cli.ts records the
      // instrumentation that established it). The run needs the process gone
      // before the file is read, and settle() above has already established that
      // every flush has landed.
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(3000);
    },
  });
}

let outcome: Awaited<ReturnType<typeof drive>>;
try {
  outcome = await drive();
} catch (err: unknown) {
  cleanup();
  throw err;
}

if (outcome.payload.item_id !== sceneId) {
  abort(
    `the page opened ${String(outcome.payload.item_id)} at boot, not ${sceneId} as the store's ` +
      "walk predicts. Everything typed went into a document this rig did not choose, and the " +
      "reopen boot would not be the one that loads the marked body.",
    cleanup,
  );
}

console.log("\n[3/4] reading the file the killed process left behind");
const preKillBodies = bodiesOnce(projectPath);

// Vacuity guards, before any gate is evaluated. Each of these would let a gate
// below pass against something nothing touched.
if (!markAppliedLive) {
  abort(
    `VACUITY GUARD: no em mark on ${JSON.stringify(markWord)} reached the store during the live ` +
      "session. The chord never applied one, so marks_persist would be reporting the application " +
      "losing a mark it was never given.",
    cleanup,
  );
}
if (signatureOf(preKillBodies) === signatureOf(seedBodies)) {
  abort(
    "VACUITY GUARD: every stored body is byte-identical to the seed. Whatever the window showed, " +
      "nothing typed or marked reached the store, and marks_persist would be asserting against " +
      "the fixture.",
    cleanup,
  );
}
// NOT a vacuity guard, deliberately: an unreadable word count is the DEFECT
// a11y_word_count_exposed exists to catch, so it is recorded and graded rather
// than aborted on. What would abort is the probe itself failing (no pyatspi, no
// bus, not exactly one matching app), and probeTree throws for that, which
// reaches the top-level catch below without writing anything.
const finalReading: BarReading | null = seen.finalBar;
if (finalReading !== null && finalReading.projectWords === 0) {
  abort(
    "VACUITY GUARD: the host reports a project total of 0 words over a seeded manuscript. A sum " +
      "of zero agrees with an empty page-side sum, so word_count_agrees would record a PASS on a " +
      "run that counted nothing.",
    cleanup,
  );
}
if (finalReading !== null && finalReading.sceneWords === 0) {
  abort(
    "VACUITY GUARD: the open scene displays 0 words after a sentence was typed into it. The " +
      "figures in the footer do not describe the document this run edited.",
    cleanup,
  );
}

const perScene = [...preKillBodies]
  .map(([itemId, body]) => ({ item_id: itemId, words: pageWordsOf(body) }))
  .sort((a, b) => a.item_id.localeCompare(b.item_id));
if (perScene.length === 0) {
  abort(
    "VACUITY GUARD: the project holds no documents, so the page-side sum is 0 and would agree " +
      "with any host total of 0.",
    cleanup,
  );
}
const sceneSum = perScene.reduce((a, d) => a + d.words, 0);
console.log(
  `  host ${String(finalReading?.projectWords)} vs page ${sceneSum} over ${perScene.length} document(s)`,
);

console.log("\n[4/4] reopen boot against the same project");
// soakMs 0, APP_MUTATIONS 0: the boot LOADS and parses the marked document -
// which is the round trip marks_persist is about - and then writes nothing, so
// the file read afterwards is the file the killed process left. A soak here
// would type into this very scene and could erode the marked word, turning a
// workload draw into a FAIL. write, not verify: the verify payload returns
// before the tree block is built.
const reopen = await runShell<SinkPayload & { persist: WritePersistBlock }>({
  mode: "virtual",
  soakMs: 0,
  staged: DIST,
  env: { APP_PROJECT: projectPath, APP_PERSIST_MODE: "write", APP_MUTATIONS: "0" },
  probeA11y: false,
});
const reopenedBodies = bodiesOnce(projectPath);
const reopenedRuns = markedRuns(reopenedBodies.get(sceneId) ?? "", "em");
const markPersisted = reopenedRuns.includes(markWord);
// The page's own re-serialization of the document it just parsed, against the
// bytes it parsed. GRADED as of 2026-08-12 (reopen_parse_intact); it used to be
// recorded only, on the reasoning that a hash gate "would fail loudly for
// reasons that have nothing to do with this slice". The cost of leaving it
// ungated was worse: the reopen boot writes NOTHING back (soakMs 0,
// APP_MUTATIONS 0, and the page flushes only on a docChanged transaction), so
// the reopened bodies are byte-identical to the pre-kill ones by construction
// and every store-side reopen check is a tautology. This comparison is the only
// thing in the run that can see the page's parse at all.
//
// bodyHash is IMPORTED from the page for the same reason countWordsIn is: it is
// one of the two things being compared, and a restatement here could disagree
// with the page's own hashing and hide which side drifted.
const reopenLoadedHash = reopen.payload.persist.body_hash;
const storedHash = bodyHash(preKillBodies.get(sceneId) ?? "");

const metrics: WordsMetrics = {
  // The word this run marked when it is there, and otherwise the first marked
  // run that IS there, so a FAIL says what the body carries instead of only
  // what it lost.
  marked_text: markPersisted ? markWord : (reopenedRuns[0] ?? ""),
  mark_persisted: markPersisted,
  mark_applied_live: markAppliedLive,
  stored_body_hash: storedHash,
  reopen_loaded_body_hash: reopenLoadedHash,
  project_total: finalReading?.projectWords ?? null,
  scene_sum: sceneSum,
  scene_docs: perScene.length,
  scene_words: finalReading?.sceneWords ?? null,
  scan_ms: scanMs,
  scan_granularity_ms: scanFloorMs(watchReadMs, commitReadMs),
  scan_watch_read_ms: watchReadMs,
  scan_commit_read_ms: commitReadMs,
  // The exposure claim, from the LAST read of the tree. Three separate facts
  // because the three failures are different repairs: not there at all, there
  // under a role no assistive technology can use, and there but nameless.
  a11y_role: seen.finalCount?.role ?? null,
  a11y_name: seen.finalCount?.name ?? "",
  a11y_text: seen.finalCount?.text ?? "",
  a11y_text_has_both_figures: TEXT_PATTERN.test(seen.finalCount?.text ?? ""),
  a11y_text_figures: figuresOf(TEXT_PATTERN, seen.finalCount?.text ?? ""),
  a11y_name_figures: figuresOf(NAME_PATTERN, seen.finalCount?.name ?? ""),
};

const verdicts: GateResult[] = evaluateWordsGates(metrics);

const path = writeResult(
  buildResult({
    workload: "app-words",
    runId: "app-words-tiny",
    candidate: "tauri",
    fixture: "tiny",
    verdicts,
    metrics: {
      workload_script: "words-v1",
      peak_rss_mb: outcome.peakRssMb,
      startup_ms: outcome.payload.startup_ms,
      rows: outcome.payload.rows,
      opened_at_boot: outcome.payload.item_id,
      scene: sceneId,
      words: metrics,
      selected_before_mark: markWord,
      marked_runs_in_reopened_scene: reopenedRuns,
      bar_readings: barReadings,
      per_scene_page_words: perScene,
      // The two hashes reopen_parse_intact compares live in metrics.words, where
      // every other graded figure is. Not restated here: two copies of one
      // measured number is one copy that can go stale.
      reopen_peak_rss_mb: reopen.peakRssMb,
      omitted_gates: [
        {
          gate: "a11y_exposure, a11y_tree_structure",
          reason:
            "this run makes no structural claim about the NAVIGATOR: it never clicks a row and " +
            "never mutates the tree. The hierarchy and outline runs are where the navigator's " +
            "accessibility contract is graded. a11y_word_count_exposed, which this run does " +
            "grade, is a claim about one element of the project bar and nothing else.",
        },
        {
          gate: "latency, stall, cliff, peak RSS trend",
          reason:
            "the run is a minute of real keyboard input, not a soak; it has nothing true to say " +
            "about frame cadence or a leak slope.",
        },
      ],
      scope: {
        input:
          "Real X input throughout: xdotool keystrokes into the shipped editor, and one xdotool " +
          "click to put the caret at the end of the open document. The page's own JavaScript is " +
          "never called. Reading the display costs no input at all any more, so the rig no " +
          "longer disturbs the focus of the thing it is measuring.",
        how_the_host_figure_is_read:
          "THE PLATFORM ACCESSIBILITY TREE - the same channel a screen reader uses. " +
          "project_word_count is reachable only through the page and the page reports neither " +
          "the figure nor the latency in its sink payload, so the display is the only observable; " +
          "the display is exposed, with an accessible name carrying both figures, and the rig " +
          "parses the figures out of that name. Every name read is recorded verbatim in " +
          "bar_readings so a reader can check the parse. Matching is on the node's `id` attribute " +
          "to FIND it and on its ATK ROLE to grade it, never on `xml-roles`.",
        a11y_word_count_exposed:
          "This gate exists because the element used to be invisible. Until 2026-08-12 a full " +
          "AT-SPI walk of the running app showed `document web` with exactly four children - the " +
          "#project-controls banner, the #nav tree and the #editor " +
          "landmark - with #project-bar and #word-count nowhere, and no ancestor exposing their " +
          "text through the Text interface either. A screen reader user could not read their own " +
          "word count. The fix is role=group plus an aria-label carrying both figures; " +
          "role=group rather than role=status because the scene figure repaints on every " +
          "keystroke and a live region would announce the count continuously while the writer " +
          "types. role=status with aria-live=off was measured too and is also exposed (ATK " +
          "`status bar`, live:off) - but it keeps the whole live-region apparatus attached, " +
          "including container-live-role:status, and a guarantee by construction beats one by " +
          "override.",
        why_this_is_graded_here:
          "The exposure and the rig's read are ONE change. The predecessor read the figure by " +
          "triple-clicking the project bar and scraping the X PRIMARY selection with xclip, " +
          "because that was the only channel out of the page that existed. That made xclip a " +
          "hard prerequisite and made every read steal keyboard focus from the editor, which " +
          "aborted a run. Exposing the element removed both. Grading the exposure is what stops " +
          "the scrape growing back: a regression in the markup now FAILs a gate rather than " +
          "quietly costing the rig its channel.",
        page_side_sum:
          "countWordsIn and the ProseMirror schema are IMPORTED from app/ui/src/editor.ts, not " +
          "restated. That is the opposite of this harness's usual rule and it is deliberate: the " +
          "gate's claim is that the host's total equals the sum of THE PAGE'S counts, so a " +
          "restatement would be a third implementation and a disagreement could no longer say " +
          "which two of the three drifted. The thresholds gates.ts restates are specifications; " +
          "this is one of the two things being compared.",
        word_count_agrees:
          "One number against one number, over a store the rig has confirmed quiet: every " +
          "reading is taken after the stored bodies have been unchanged for 2000 ms, twice the " +
          "page's flush debounce, so the total on screen and the file on disk describe the same " +
          "manuscript. PER-DOCUMENT ATTRIBUTION IS IMPOSSIBLE from outside: the host answers " +
          "with a single u64 and never says which document contributed what. " +
          "per_scene_page_words carries the page side document by document so a future reader of " +
          "a FAIL has one half of the picture; the other half would need a host-side change.",
        word_count_scan_ms:
          "AN UPPER BOUND, not the command's latency, and the gate's threshold string says so. " +
          "The interval runs from a commit becoming visible to a second read-only connection to " +
          "the exposed name's project half no longer reading what it read at baseline, so it " +
          "covers the flush ack, the page's un-awaited refreshProject, the IPC both ways, the " +
          "full scan of every document, the repaint AND the rig's own RESOLUTION FLOOR, recorded " +
          "beside it as scan_granularity_ms. BOTH ENDPOINTS ARE POLLED, so both bound the " +
          "resolution: the repaint side sleeps 20 ms between name reads, and the commit side " +
          "opens a fresh read-only SQLite connection every 2 ms. scan_granularity_ms used to hold " +
          "the median NAME READ ALONE (0.4 ms) while the gate called it the finest interval the " +
          "rig could resolve, understating the floor by roughly fifty times and letting a " +
          "recorded scan_ms of 2 read as a measurement; it is now max(period, cost) at each " +
          "endpoint, summed, with the two measured costs recorded beside it as " +
          "scan_watch_read_ms and scan_commit_read_ms. The watcher still resolves the node once " +
          "and polls the object it holds, in its own process, so the read is a property fetch " +
          "rather than a whole AT-SPI connection - the predecessor's floor was a triple-click and " +
          "an xclip. At the tiny fixture the scan lands at or below that floor, so the gate " +
          "reports it as bounded and NOT RESOLVED rather than printing it bare. The " +
          "figure that would matter - a full scan at the stress fixture, where the design's cost " +
          "actually lives - is UNMEASURED, and measuring it separably needs the host or the page " +
          "to report the latency itself.",
        marks_persist:
          "The word is chosen by the EDITOR's word boundaries, not by the rig: ctrl+shift+Left " +
          "makes the selection and the rig reads back what got selected from the editable's own " +
          "AT-SPI Text interface, aborting unless it is a single whitespace-free word of the " +
          "sentence this run typed. Read that way rather than from the X PRIMARY selection, " +
          "which quietly hands back the PREVIOUS selection when a chord selects nothing; an " +
          "empty AT-SPI selection is empty. The scene " +
          "is the one the page opens at boot, deliberately, so the reopen boot LOADS and parses " +
          "the marked body. WHAT THIS GATE DOES NOT COVER: the reopen boot writes nothing back - " +
          "soakMs 0, APP_MUTATIONS 0, and the page flushes only on a docChanged transaction - so " +
          "the body it reads is the body the killed process left, and a schema that dropped em ON " +
          "THE WAY IN would not disturb it. marks_persist is a claim about the STORE keeping the " +
          "mark across a SIGKILL and a reopen. The page's parse is reopen_parse_intact's claim, " +
          "measured by comparing the boot's own re-serialization against those same bytes. Until " +
          "2026-08-12 that comparison was recorded and not graded, and this scope text asserted " +
          "the opposite of the truth: it said a dropped em 'would fail there'.",
        reopen_parse_intact:
          "The reopen half of the round trip, and the only part of this run that can see the " +
          "page's parse. FNV-1a over the marked scene's stored body against the hash the reopen " +
          "boot reports for its own re-serialization of it (app/ui/src/store/hash.ts, imported " +
          "rather than restated for the same reason countWordsIn is). A hash is sensitive to more " +
          "than marks and that is accepted: a boot that re-serializes a manuscript differently " +
          "from how it was stored is a finding whatever caused it, and both hashes are recorded " +
          "so a FAIL can be diffed. Verified by sabotage on 2026-08-12: with `em` stripped from " +
          "the page's schema in a throwaway build, this gate FAILed and marks_persist FAILed " +
          "beside it while every other gate stayed PASS.",
      },
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

cleanup();
console.log(`\nrecorded: ${path}`);
for (const v of verdicts) console.log(`  ${v.gate}: ${v.value} (${v.threshold}) ${v.verdict}`);
