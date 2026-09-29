// app/harness/src/export-cli.ts
// Graded manuscript-export run. Types a distinctive sentence into the open
// scene, italicises a word of it with Mod-i, exports through the SHIPPED
// application menu (File > Export manuscript) with no pause that would let the
// flush debounce fire on its own, exports a second time, and then asks whether
// the file on disk says what the store says.
//
// The bar's #export button was retired, so the menu is the only route left. The
// item's position in the menu is READ from app/ui/src/menu-bar.ts by
// menu-drive.ts and never restated here: an item inserted above Export moves
// the keystrokes with it, where a literal index would silently press whatever
// sits above the item it names.
//
// The oracle is the store, read directly with bun:sqlite, and the reader is the
// harness's own (app/harness/src/markdown-read.ts). Neither side is derived
// from `export.rs`: a reader built out of the emitter's logic would check the
// exporter against itself, and `export_text_fidelity` would grade a tautology.
// What the gate proves is a NECESSARY condition -- the exporter can read back
// what it wrote -- and its threshold string says so, because there is no
// CommonMark parser in this project and adding one to grade a run would make
// the run a test of that parser.
//
// Usage: APP_GUI=1 bun app/harness/src/export-cli.ts <tiny|stress>
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateExportGates, type ExportMetrics, type GateResult } from "./gates";
import { reportedUnderlinesIn } from "./notice-read";
import {
  countWords,
  expectedHeadingLevel,
  normalizeText,
  readManuscript,
  type Section,
} from "./markdown-read";
import { menuDriver, menuRoute } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import { BIN, SHELL_PROC_NAME, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";

/** Time for File to paint before the opening walk locates its exact Export
 * item. The second export still uses menuDriver.activate(). */
const MENU_PRELOCATION_MS = 200;

/** How far inside the editable's bottom-right corner to click. The element is
 *  only as tall as its prose, so a click below it lands on #editor's padding and
 *  focus stays wherever it was -- which types the sentence into nothing. */
const EDGE_INSET_PX = 4;

/** Typed into the scene the page opens at boot.
 *
 *  It carries `*`, `_` and `[` `]` DELIBERATELY: those are exactly the
 *  characters the exporter has to backslash-escape and the rig's reader has to
 *  unescape, so the fidelity comparison round-trips real markup rather than
 *  plain words. Spaces are safe here because the mount focuses the editor and
 *  the run verifies BY EFFECT that this sentence reached the boot scene's
 *  stored body before it does anything else; if it had not, focus would be on
 *  the navigator, where SPACE IS ACTIVATION rather than type-ahead, and the run
 *  aborts instead of recording the scatter. */
const SENTENCE = "The archivist marked crate *seven* and filed it under [ledger_ii] before dusk.";
/** A distinctive fragment, for the by-effect check against the store. */
const SENTENCE_MARKER = "archivist marked crate";

/** Typed in a fresh paragraph immediately before the Export item runs, and the whole
 *  point of `export_includes_last_keystroke`.
 *
 *  NO SPACES. If anything above has gone wrong and focus is on the navigator, a
 *  space is activation there: the selection would walk around under type-ahead
 *  and then open whichever row it landed on, scattering the rest of the
 *  keystrokes into a scene this rig never chose. Without spaces a misplaced
 *  focus types into nothing at all, which is the FAIL it should be.
 *
 *  SHORT, and that is load-bearing too: the flush debounce is armed by the
 *  FIRST unflushed edit and never re-armed, so the 1000 ms clock starts at the
 *  paragraph break before this and everything below has to fit inside it. The
 *  run re-reads the store between the last keystroke and the pointer click that
 *  runs the Export item, and aborts
 *  if the debounce won anyway. */
const LAST_SENTENCE = "CrateSevenLedgerShut.";

/** xdotool type returns when X has the key events, not when WebKitGTK has turned
 *  them into document state. hand-cli.ts found 500 ms silently truncating typed
 *  text; 2500 ms is what held. */
const SETTLE_MS = 2500;
/** Fast enough that LAST_SENTENCE fits well inside the flush debounce.
 *
 *  It was 20 ms while a single click ended the window. The menu route spends
 *  ~500 ms of it before Return, and at 20 ms the run aborted on the structural
 *  check every time -- 21 characters is 420 ms of the 1000 there is. The margin
 *  left is recorded as debounce_window_used_ms, so a future slice can see this
 *  budget tightening rather than discover it as an abort. */
const FAST_TYPE_DELAY_MS = 8;
/** Between two AT-SPI clients where nothing else already separates them.
 *  Repeated pyatspi clients a few hundred milliseconds apart wedge the
 *  WebKitGTK bridge -- the app leaves the desktop list and does not come back,
 *  and one probe run once hung 300 s. */
const PROBE_SPACING_MS = 2000;
/** Store polling granularity while waiting for a write to land. */
const POLL_MS = 5;
/** How long one store write may take to appear before the rig calls it lost. */
const COMMIT_TIMEOUT_MS = 15_000;
/** How long an export may take before the rig calls it never. Generous: this is
 *  a liveness bound, not the latency gate, and at `stress` the export parses
 *  15,200 documents. */
const EXPORT_TIMEOUT_MS = 180_000;
/** Long enough for the drain's flush to have landed and the project bar's total
 *  to have been refreshed before it is read. */
const REFRESH_MS = 3000;
/** store/mod.rs MAX_DEPTH. Without it the CTE recurses forever on a parent_id
 *  cycle where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;

/** The DOM id the word count carries into the accessibility tree. How the rig
 *  finds it; the figures are then parsed out of the accessible NAME, because
 *  the spans holding the visible text are generic nodes WebKitGTK is free to
 *  prune. Restated from app/ui/src/word-count.ts, as words-cli restates it. */
const COUNT_ID = "word-count";
/** The banner the page raises for good news, `project.ts`'s `announce`. The
 *  export's report lands here, underline tally included. */
const NOTICE_ID = "open-error";
//
//  The trailing clause is the DAY's figure, from the writing-goals slice, and it
//  is optional here because it is absent until the first answer lands. This rig
//  needs only the project total; without the tail this pattern matched nothing
//  and export_word_count_agrees went to UNKNOWN -- a graded oracle silently
//  demoted by a wording change in another file. THIRD rig with this exposure.
const NAME_PATTERN =
  /^Word count: ([\d,]+) words? in this scene, ([\d,]+|…|—) saved in the project(?:, .+)?$/u;

const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
     SELECT id, parent_id, type, title, position, 0, position
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.title, i.position,
            w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ${MAX_DEPTH}
   )
   SELECT id, parent_id, type, title, depth FROM walk ORDER BY path`;

interface WalkRow {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  depth: number;
}

function openRead(projectPath: string): Database {
  return new Database(projectPath, { readonly: true });
}

/** The store's own depth-first walk, restated from store/mod.rs items() and run
 *  against the file directly. This is the order the exporter emits headings in,
 *  which is what lets a section be aligned to an item BY INDEX. */
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

/** One document's body, on its own connection. Used on the hot path between the
 *  last keystroke and the Export item, where reading every body would spend
 *  the debounce window the gate depends on. */
function bodyOnce(projectPath: string, itemId: string): string {
  const db = openRead(projectPath);
  try {
    const row = db.query("SELECT body FROM doc WHERE item_id = ?").get(itemId) as
      | { body: string }
      | null;
    return row?.body ?? "";
  } finally {
    db.close();
  }
}

function signatureOf(walk: readonly WalkRow[]): string {
  return walk.map((r) => `${r.id}|${r.parent_id ?? ""}|${r.title}|${r.depth}`).join("\n");
}

interface PmJson {
  type: string;
  text?: string;
  marks?: { type: string }[];
  content?: PmJson[];
}

/** The text a stored body holds, by this rig's own walk of the ProseMirror JSON.
 *
 *  Restated here rather than taken from either side of the comparison. It is
 *  `store::document_text`'s rule: inline text concatenated with nothing, one
 *  space before a block node's content. Everything is whitespace-normalized
 *  afterwards anyway, so the only property that has to hold exactly is that no
 *  text is lost and no text is invented. */
function storedText(body: string): string {
  let out = "";
  const walk = (node: PmJson): void => {
    if (node.type === "text") {
      out += node.text ?? "";
      return;
    }
    if (out.length > 0) out += " ";
    for (const child of node.content ?? []) walk(child);
  };
  walk(JSON.parse(body) as PmJson);
  return out;
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

// ONE AT-SPI client answering everything the rig needs from the accessibility
// tree in a single walk: widget geometry (where the editable actually is), the
// word count node, and the editable's current text selection. Batched rather than three probes, because repeated pyatspi clients
// a few hundred milliseconds apart wedge the WebKitGTK bridge.
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
notice_id = sys.argv[3]
export_id = sys.argv[4]
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
found = {"count": None, "selection": "", "notice": None, "exports": []}

def own_text(node):
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception:
        return ""

def subtree_text(node):
    # The WHOLE subtree, not the node's own text. The notice banner puts its
    # sentence in a child span beside a dismiss button, so the div itself
    # reports the empty string -- which reads exactly like a banner that never
    # appeared. Learned by replace-cli, which had that reading once.
    out = own_text(node) or (node.name or "")
    try:
        for k in range(node.childCount):
            out += subtree_text(node.getChildAtIndex(k))
    except Exception:
        pass
    return out

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
            found["count"] = {"role": role, "name": node.name or ""}
        if i == notice_id and found["notice"] is None:
            found["notice"] = subtree_text(node) or (node.name or "")
        if export_id and i == export_id:
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            found["exports"].append({"role": role, "id": i, "name": node.name or "",
                                     "x": e.x, "y": e.y, "w": e.width, "h": e.height})
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps({"nodes": nodes, "count": found["count"],
                             "selection": found["selection"],
                             "notice": found["notice"], "exports": found["exports"]}))
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
  /** null means the tree was walked and no node carried the word count's id.
   *  Recorded, not aborted on: the host figure is then UNREAD, which
   *  export_word_count_agrees reports as UNKNOWN rather than a disagreement. */
  count: { role: string; name: string } | null;
  selection: string;
  /** The export notice's sentence, off the banner the page raises. null means
   *  the tree was walked and no node carried the banner's id -- which is a
   *  state, not a zero: an info banner removes itself after six seconds. */
  notice: string | null;
  exports: Node[];
}

/** One AT-SPI walk. Throws when the PROBE fails -- no python, no pyatspi, no
 *  bus, or not exactly one matching app -- because then nothing was measured and
 *  a written result would be a claim about a tree that was never read. */
function probeTree(rootPid: number, exportId = ""): Probe {
  const proc = Bun.spawnSync(["python3", "-c", PY_PROBE, pidListArg(rootPid), COUNT_ID, NOTICE_ID, exportId], {
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

/** The host's project total, out of the word count's accessible name. `null`
 *  when the name is absent or reads as the pending ellipsis or the failed em
 *  dash -- both are states, not numbers, and neither may be read as 0. */
function projectWordsOf(count: { name: string } | null): number | null {
  if (count === null) return null;
  const m = count.name.match(NAME_PATTERN);
  if (m === null) return null;
  const figure = m[2]!;
  return /^[\d,]+$/.test(figure) ? Number(figure.replaceAll(",", "")) : null;
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

function prelocatedExport(nodes: readonly Node[], display: string, wid: string): {
  id: string;
  role: string;
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  center: { x: number; y: number };
} {
  if (nodes.length !== 1 || nodes[0]?.id !== "menu-export") {
    throw new Error(`File menu exposed ${nodes.length} exact #menu-export target(s), expected one`);
  }
  const node = nodes[0];
  const geometry = xdo(display, ["getwindowgeometry", "--shell", wid]);
  const window = {
    w: Number(geometry.match(/\bWIDTH=(\d+)/)?.[1]),
    h: Number(geometry.match(/\bHEIGHT=(\d+)/)?.[1]),
  };
  const rect = { x: node.x, y: node.y, w: node.w, h: node.h };
  const values = [...Object.values(window), ...Object.values(rect)];
  if (
    !values.every(Number.isFinite) ||
    rect.w <= 0 ||
    rect.h <= 0 ||
    window.w <= 0 ||
    window.h <= 0 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.w > window.w ||
    rect.y + rect.h > window.h
  ) {
    throw new Error(`menu-export rectangle ${JSON.stringify(rect)} is outside window ${JSON.stringify(window)}`);
  }
  return {
    id: node.id,
    role: node.role,
    name: node.name,
    rect,
    center: { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) },
  };
}


function abort(message: string, cleanup: () => void): never {
  console.error(`\n${message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}

const FIXTURES = new Set(["tiny", "stress"]);
const fixture = process.argv[2] ?? "tiny";
if (!FIXTURES.has(fixture)) {
  console.error(`usage: APP_GUI=1 bun app/harness/src/export-cli.ts <${[...FIXTURES].join("|")}>`);
  process.exit(1);
}
const FIXTURE = `lab/fixtures/out/${fixture}`;

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; export run skipped (needs a display and a built shell).");
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
        "A pre-existing instance makes the AT-SPI widget lookup unable to attribute geometry to " +
        "exactly one window, and its window could receive the keystrokes.",
    );
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "app-export-"));
const projectPath = join(workDir, "project.db");
/** A FRESH directory, so the rig knows what the export wrote without asking the
 *  page where it went. APP_EXPORT_DIR is read in Rust only. */
const exportDir = join(workDir, "exports");
mkdirSync(exportDir, { recursive: true });
function cleanup(): void {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`[1/3] seeding project from ${FIXTURE}`);
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
if (walk0.length === 0) {
  abort(
    "VACUITY GUARD: the seeded project has no items, so the export has nothing to write and " +
      "export_structure would compare 0 headings against 0 items.",
    cleanup,
  );
}
// The scene the page opens at boot: app/ui/src/project.ts takes the first scene
// of the depth-first walk. Everything is typed into it.
const bootScene = walk0.find((r) => r.type === "scene");
if (bootScene === undefined) {
  abort("the fixture has no scene: there is nothing to open, type into or mark.", cleanup);
}
const sceneId = bootScene.id;
console.log(`  ${walk0.length} items; boot scene = ${sceneId}`);

/** What the interactive phase observed. A mutable record rather than a handful
 *  of `let`s, and that is not a style choice: TypeScript's flow analysis cannot
 *  see assignments made inside the run hook, so a `let` initialised to `null`
 *  narrows to `null` for the rest of the file and every guard below would be
 *  typed against `never` -- which type-checks while asserting nothing. */
const seen: {
  markWord: string;
  markAppliedLive: boolean;
  /** An `underline` mark reached the store during the live session. Same
   *  purpose as markAppliedLive: with nothing given, nothing can have been
   *  lost, and the gate must not blame the application for the rig. */
  underlineAppliedLive: boolean;
  /** The export notice as the accessibility tree carried it, for the record and
   *  for the figure parsed out of it. */
  noticeText: string | null;
  firstPath: string | null;
  secondPath: string | null;
  firstBytesBefore: string | null;
  firstBytesAfter: string | null;
  exportMs: number;
  keystrokeToClickMs: number;
  /** From the paragraph break that armed the debounce to the pointer click that
   * runs Export. */
  debounceUsedMs: number;
  exportTarget: ReturnType<typeof prelocatedExport> | null;
  countName: string;
  projectWords: number | null;
} = {
  markWord: "",
  markAppliedLive: false,
  underlineAppliedLive: false,
  noticeText: null,
  firstPath: null,
  secondPath: null,
  firstBytesBefore: null,
  firstBytesAfter: null,
  exportMs: 0,
  keystrokeToClickMs: 0,
  debounceUsedMs: 0,
  exportTarget: null,
  countName: "",
  projectWords: null,
};

/** Wait for exactly one file to appear in the export directory that was not
 *  there before, and for it to stop growing.
 *
 *  The host writes the manuscript with one `write_all` and an `fsync`, which is
 *  not atomic to an observer: a poll can catch a half-written file. Complete
 *  means the size stopped changing AND the last byte is the newline the format
 *  always ends with. */
async function awaitExport(known: ReadonlySet<string>): Promise<{ path: string; bytes: string }> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let lastSize = -1;
  while (Date.now() < deadline) {
    const fresh = readdirSync(exportDir).filter((n) => !known.has(n));
    if (fresh.length > 1) {
      throw new Error(`the export wrote ${fresh.length} new files at once: ${fresh.join(", ")}`);
    }
    const name = fresh[0];
    if (name !== undefined) {
      const path = join(exportDir, name);
      const bytes = readFileSync(path, "utf8");
      if (bytes.length > 0 && bytes.endsWith("\n") && bytes.length === lastSize) {
        return { path, bytes };
      }
      lastSize = bytes.length;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`no export appeared in ${exportDir} within ${EXPORT_TIMEOUT_MS} ms`);
}

console.log("\n[2/3] interactive run");
// GDK_BACKEND=x11 is load-bearing: a developer's ambient session sets
// WAYLAND_DISPLAY and GTK prefers Wayland, so the webview would open on the real
// desktop instead of the Xvfb display xdotool targets.
async function drive(): Promise<
  Awaited<
    ReturnType<
      typeof runShell<{
        ready: boolean;
        error?: string;
        item_id: string | null;
        rows: number;
        startup_ms: number;
      }>
    >
  >
> {
  return runShell<{
    ready: boolean;
    error?: string;
    item_id: string | null;
    rows: number;
    startup_ms: number;
  }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      APP_EXPORT_DIR: exportDir,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("export rig requires a fixed X display");
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
            "Whatever is focused would receive the keystrokes.",
        );
      }

      // The shared driver remains the second export's route.
      const driver = menuDriver(display, wid, xdo);
      const route = menuRoute("menu-export");
      console.log(`  File > Export manuscript = ${route.chord} + prelocated click`);
      driver.key(route.chord);
      await Bun.sleep(MENU_PRELOCATION_MS);

      // One walk, answering where the editable is, what the word count reads,
      // and which exact menu node receives the first export's pointer click.
      const opening = probeTree(rootPid, "menu-export");
      seen.exportTarget = prelocatedExport(opening.exports, display, wid);
      driver.key("Escape");

      /** Put the caret at the end of the open document, by clicking the last
       *  line of the contenteditable itself. NOT a click at a fixed point low in
       *  the editor pane: the editable is only as tall as its prose, so a click
       *  below it lands on #editor's padding and focus stays wherever it was. */
      const entry = opening.nodes.find((n) => n.role === "entry" || n.role === "text");
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
      await Bun.sleep(800);

      // 1. A sentence carrying the characters the exporter must escape.
      xdo(display, ["type", "--delay", "40", SENTENCE]);
      await Bun.sleep(SETTLE_MS);
      // Verified by effect, never by asking the screen. If the sentence is not
      // in that scene's stored body the keystrokes went somewhere else - the
      // navigator, most likely, where Space is activation - and every figure
      // below would be about a manuscript this rig scattered.
      {
        const deadline = Date.now() + COMMIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (bodyOnce(projectPath, sceneId).includes(SENTENCE_MARKER)) break;
          await Bun.sleep(POLL_MS);
        }
      }
      if (!bodyOnce(projectPath, sceneId).includes(SENTENCE_MARKER)) {
        throw new Error(
          `the typed sentence never reached ${sceneId}'s stored body. Keyboard focus was not in ` +
            "the editor, so the keystrokes landed elsewhere and nothing below describes this run.",
        );
      }

      // 2. Select the word just typed and italicise it. The rig does not choose
      //    the word - the editor's own boundary rules do - so it reads back what
      //    got selected from the editable's AT-SPI Text interface and aborts
      //    unless it is one whitespace-free word of this sentence. Read that way
      //    rather than from the X PRIMARY selection, which quietly hands back
      //    the PREVIOUS selection when a chord selects nothing.
      await Bun.sleep(PROBE_SPACING_MS);
      xdo(display, ["key", "--clearmodifiers", "ctrl+shift+Left"]);
      await Bun.sleep(800);
      seen.markWord = probeTree(rootPid).selection;
      if (
        seen.markWord.length === 0 ||
        /\p{White_Space}/u.test(seen.markWord) ||
        !SENTENCE.includes(seen.markWord)
      ) {
        throw new Error(
          `the selection before Mod-i reads ${JSON.stringify(seen.markWord)}, which is not a ` +
            "single word of the sentence this run typed. Either the chord selected nothing or it " +
            "selected across a boundary, and export_marks_survive would be asserting about text " +
            "the rig cannot identify.",
        );
      }
      console.log(`  italicising ${JSON.stringify(seen.markWord)}`);
      xdo(display, ["key", "--clearmodifiers", "ctrl+i"]);
      await Bun.sleep(SETTLE_MS);
      seen.markAppliedLive = markedRuns(bodyOnce(projectPath, sceneId), "em").includes(
        seen.markWord,
      );

      // 2b. UNDERLINE THE SAME RUN. The selection survives a mark toggle, so
      //     this costs no second selection dance -- and marks are a SET on a
      //     text node, so one run carrying both is the case that tells a
      //     correct exporter from one that loses the emphasis it CAN carry
      //     while dropping the one it cannot. Markdown has no underline: the
      //     drop is designed, and the tally is what makes it not silent.
      xdo(display, ["key", "--clearmodifiers", "ctrl+u"]);
      await Bun.sleep(SETTLE_MS);
      seen.underlineAppliedLive = markedRuns(
        bodyOnce(projectPath, sceneId),
        "underline",
      ).includes(seen.markWord);
      console.log(`  underlining ${JSON.stringify(seen.markWord)}`);

      // 3. Collapse the selection (Right, not End: with a backwards selection
      //    Right lands after the marked word), open a fresh paragraph so the
      //    last sentence does not inherit the em mark it abuts, and type it.
      //    The paragraph break is itself a document change, so THE DEBOUNCE
      //    CLOCK STARTS HERE - it is armed by the first unflushed edit and never
      //    re-armed.
      xdo(display, ["key", "--clearmodifiers", "Right"]);
      xdo(display, ["key", "--clearmodifiers", "Return"]);
      // The debounce clock starts at that Return, not at the typing below.
      const paragraphAt = Bun.nanoseconds();
      xdo(display, ["type", "--delay", String(FAST_TYPE_DELAY_MS), LAST_SENTENCE]);
      const typedAt = Bun.nanoseconds();

      // 4. Reopen File, then park the pointer on the exact target captured by
      //    the opening walk. No resize occurs, and nothing moves the reopened
      //    menu before this click.
      const known = new Set(readdirSync(exportDir));
      driver.key(route.chord);
      await Bun.sleep(MENU_PRELOCATION_MS);
      const exportTarget = seen.exportTarget;
      if (exportTarget === null) throw new Error("the export click target was not prelocated");
      xdo(display, ["mousemove", "--window", wid, String(exportTarget.center.x), String(exportTarget.center.y)]);

      // 5. THE STRUCTURAL CHECK THAT MAKES export_includes_last_keystroke MEAN
      //    ANYTHING. If the debounce has already committed the sentence, the
      //    file would contain it whether or not the page drains, and the gate
      //    would grade nothing. One document, on its own connection: reading
      //    every body here would spend the window being defended.
      if (bodyOnce(projectPath, sceneId).includes(LAST_SENTENCE)) {
        throw new Error(
          "STRUCTURAL CHECK FAILED: the flush debounce committed the last sentence before the " +
            "Export item ran. The exported file would hold it whether or not the page drained, " +
            "so export_includes_last_keystroke would be a tautology. " +
            `${((Bun.nanoseconds() - paragraphAt) / 1e6).toFixed(0)} ms of the 1000 ms window ` +
            "had been spent typing and delivering the pointer to the prelocated item.",
        );
      }

      // 6. Export. The clock starts immediately before the click; see the gate's
      //    threshold for what the interval covers beyond pointer delivery.
      const startedAt = Bun.nanoseconds();
      seen.keystrokeToClickMs = (startedAt - typedAt) / 1e6;
      seen.debounceUsedMs = (startedAt - paragraphAt) / 1e6;
      xdo(display, ["click", "1"]);
      // A menu click fails SILENTLY: a missing item or wrong target runs
      // something else, and either way nothing complains.
      // Only the file answers, so a missing one is an abort with the same force
      // as the retired "#export is absent" guard -- not a plausible number.
      const first = await awaitExport(known).catch((err: unknown) => {
        throw new Error(
          `no manuscript appeared after clicking File > Export manuscript (${route.chord}): ` +
            `${err instanceof Error ? err.message : String(err)}. The menu click runs silently ` +
            "when it misses, so nothing below describes an export that happened.",
        );
      });
      seen.exportMs = (Bun.nanoseconds() - startedAt) / 1e6;
      seen.firstPath = first.path;
      seen.firstBytesBefore = first.bytes;
      console.log(
        `  exported ${first.path} (${first.bytes.length} bytes) in ${seen.exportMs.toFixed(1)} ms`,
      );

      // 7. Export again. Nothing is typed between, so the second file describes
      //    the same manuscript - the claim is only that it took a different
      //    path and left the first file alone.
      await Bun.sleep(1000);
      const knownAfterFirst = new Set(readdirSync(exportDir));
      await driver.activate("menu-export");
      const second = await awaitExport(knownAfterFirst).catch((err: unknown) => {
        throw new Error(
          `the second File > Export manuscript produced no file: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
      seen.secondPath = second.path;
      seen.firstBytesAfter = readFileSync(first.path, "utf8");
      console.log(`  exported again to ${second.path}`);

      // 8. The host's project total, off the platform accessibility tree - the
      //    same channel a screen reader uses, and the only way out of the page
      //    for a figure the sink payload does not carry. Seconds after the last
      //    probe, and after the drain's flush has been answered and the bar
      //    refreshed.
      await Bun.sleep(REFRESH_MS);
      const closing = probeTree(rootPid);
      seen.countName = closing.count?.name ?? "<absent from the accessibility tree>";
      seen.projectWords = projectWordsOf(closing.count);
      // The banner the SECOND export raised. Both exports write the same
      // manuscript, so both notices carry the same tally; the second is simply
      // the one still on screen -- an info banner removes itself after 6000 ms
      // and this probe is REFRESH_MS after the file appeared.
      seen.noticeText = closing.notice;
      console.log(`  export notice reads ${JSON.stringify(seen.noticeText)}`);
      console.log(`  word count reads ${JSON.stringify(seen.countName)}`);

      // No window manager under Xvfb: this raises BadDrawable and kills the
      // process rather than delivering a graceful close. Everything the gates
      // read is already on disk.
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
      "walk predicts. Everything typed went into a document this rig did not choose.",
    cleanup,
  );
}

console.log("\n[3/3] reading the exported file against the store");

// Vacuity guards, before any gate is evaluated. Each of these would let a gate
// below pass against something nothing touched.
if (!seen.markAppliedLive) {
  abort(
    `VACUITY GUARD: no em mark on ${JSON.stringify(seen.markWord)} reached the store during the ` +
      "live session. export_marks_survive would be reporting the exporter losing a mark it was " +
      "never given.",
    cleanup,
  );
}
const firstPath = seen.firstPath;
const firstBytes = seen.firstBytesBefore;
if (firstPath === null || firstBytes === null || firstBytes.length === 0) {
  abort(
    "VACUITY GUARD: the first export produced no file, or an empty one. Every gate below would " +
      "be reading a manuscript that was never written.",
    cleanup,
  );
}
if (seen.secondPath === null) {
  abort(
    "VACUITY GUARD: the second Export produced no file at all, so there is nothing to " +
      "compare paths against and export_never_clobbers would be asserting about one export.",
    cleanup,
  );
}
if (seen.secondPath === firstPath) {
  abort(
    `VACUITY GUARD: both exports took the path ${firstPath}. The never-clobber discipline has ` +
      "failed outright and the second write may already have destroyed the first manuscript; " +
      "recording a gate verdict would be the least useful thing to do about it.",
    cleanup,
  );
}

const finalWalk = walkOnce(projectPath);
if (signatureOf(finalWalk) !== signatureOf(walk0)) {
  abort(
    "STRUCTURAL CHECK FAILED: the store's walk changed during the run. Sections are aligned to " +
      "items BY INDEX, so a walk that moved makes every fidelity comparison a comparison of two " +
      "different scenes.",
    cleanup,
  );
}
const bodies = bodiesOnce(projectPath);

const manuscript = readManuscript(firstBytes);
// THE GENERATED CONTENTS, checked as a STRUCTURAL FACT rather than graded.
// `readManuscript` takes it out of `sections`, so a build that stopped emitting
// it would leave every gate here green and every verdict unchanged -- the
// silent-regression shape this rig exists to refuse. Its entries must also be
// the walk's titles in order, which is what makes it a contents rather than a
// list that happens to be there.
//
// NOT A GATE, deliberately: a gate answers "is this over the line" and this is
// a yes or a no. Recorded as a known gap all the same -- an abort
// is invisible in `app/results/` when it does not fire.
if (walk0.length > 0) {
  const titles = walk0.map((item) => item.title);
  if (manuscript.contents === null) {
    abort(
      "STRUCTURAL CHECK FAILED: the exported file carries no generated table of contents, and " +
        `the walk holds ${walk0.length} item(s). Every gate below would still pass.`,
      cleanup,
    );
  }
  if (
    manuscript.contents.length !== titles.length ||
    manuscript.contents.some((entry, at) => entry !== titles[at])
  ) {
    abort(
      "STRUCTURAL CHECK FAILED: the generated contents does not list the walk's titles in " +
        `order (${manuscript.contents.length} entries against ${titles.length} items).`,
      cleanup,
    );
  }
}
const sections: Section[] = manuscript.sections;
// Alignment is by index and is only sound once the counts agree; export_structure
// is the gate that says so. When they do not, nothing is compared and the
// fidelity gate reports UNKNOWN rather than pairing arbitrary scenes.
const aligned = sections.length === walk0.length;
// The level half of export_structure. `expectedHeadingLevel` is the RIG'S OWN
// restatement of `min(depth + 2, 6)`, and it lives in markdown-read.ts with the
// rest of the format restatement because this file is a top-level script no test
// can import.
//
// Only over the overlap: with the counts disagreeing the pairing is arbitrary
// anyway, and export_structure already FAILs on the counts. Indexing past
// either array would compare an item against `undefined` and read as a level
// mismatch, which would put a second, invented defect on the verdict line.
const levelsMatched = walk0
  .slice(0, Math.min(walk0.length, sections.length))
  .filter((item, index) => sections[index]!.level === expectedHeadingLevel(item.depth)).length;
let compared = 0;
let matched = 0;
const mismatches: { index: number; item: string; expected: string; actual: string }[] = [];
if (aligned) {
  for (const [index, item] of walk0.entries()) {
    const body = bodies.get(item.id);
    if (body === undefined) continue;
    const expected = normalizeText(storedText(body));
    if (expected.length === 0) {
      abort(
        `VACUITY GUARD: ${item.id} has a stored body holding no text, and comparing empty to ` +
          "empty passes without testing anything. Exclude it or fix the fixture; do not record " +
          "a fidelity verdict it inflated.",
        cleanup,
      );
    }
    const actual = normalizeText(sections[index]!.text);
    compared++;
    if (expected === actual) {
      matched++;
    } else if (mismatches.length < 5) {
      mismatches.push({ index, item: item.id, expected, actual });
    }
  }
}

const exportWords = sections.reduce((a, s) => a + countWords(s.text), 0);
if (exportWords === 0) {
  abort(
    "VACUITY GUARD: the exported file holds no words at all. A zero would agree with any host " +
      "total of zero and export_word_count_agrees would record a PASS on a run that counted " +
      "nothing.",
    cleanup,
  );
}
const marksFound = sections.reduce(
  (a, s) => a + s.emphasized.filter((run) => run.includes(seen.markWord)).length,
  0,
);
const lastSentenceSection = sections.findIndex((s) => s.text.includes(LAST_SENTENCE));

// THE UNDERLINE HALF. Three readings, and they answer three different
// questions: what the store kept, what reached the file, and what the writer
// was told.
//
// The store's figure is read from the SCENE this run typed into, because that
// is the only document any underline could have reached: the fixture is seeded
// and the chord was pressed once, here. Counted by this rig's own walk of the
// stored JSON, restated from neither the page's schema nor export.rs.
const underlinedRuns = markedRuns(bodyOnce(projectPath, sceneId), "underline").length;
// Markup a well-meaning fix would have emitted instead of dropping the mark.
// `<` is escaped by the exporter, so a `<u>` in this file can only be the
// exporter's own; `_` is escaped too, so a `__` pair can only be markup.
const underlineMarkup = (firstBytes.match(/<\/?u>|__/g) ?? []).length;
// What the APPLICATION said. Parsed out of the export notice on the live
// accessibility tree rather than restated: the claim is that a writer was told,
// and a figure the rig computed would be the rig telling itself. null when the
// banner was not in the tree, which the gate reports as UNKNOWN and never as
// agreement.
const reportedUnderlines = reportedUnderlinesIn(seen.noticeText);

const metrics: ExportMetrics = {
  fixture,
  export_items: walk0.length,
  export_markdown_contents_verified: walk0.length > 0,
  export_markdown_contents_entries: manuscript.contents?.length ?? 0,
  export_headings: sections.length,
  export_levels_matched: levelsMatched,
  export_scenes_compared: compared,
  export_scenes_matched: matched,
  export_words: exportWords,
  project_words: seen.projectWords,
  export_marks_found: marksFound,
  marks_applied_live: seen.markAppliedLive,
  underlined_runs_in_scene: underlinedRuns,
  export_underline_markup_found: underlineMarkup,
  export_underline_reported: reportedUnderlines,
  export_last_sentence_present: lastSentenceSection >= 0,
  export_second_path_differs: seen.secondPath !== firstPath,
  export_first_unchanged: seen.firstBytesAfter === firstBytes,
  export_ms: Number(seen.exportMs.toFixed(1)),
};

const verdicts: GateResult[] = evaluateExportGates(metrics);

const path = writeResult(
  buildResult({
    workload: "app-export",
    runId: `app-export-${fixture}`,
    candidate: "tauri",
    fixture,
    verdicts,
    metrics: {
      workload_script: "export-v1",
      readiness_peak_rss_mb: outcome.peakRssMb,
      startup_ms: outcome.payload.startup_ms,
      rows: outcome.payload.rows,
      opened_at_boot: outcome.payload.item_id,
      scene: sceneId,
      export: metrics,
      exported_paths: [firstPath, seen.secondPath],
      exported_bytes: firstBytes.length,
      manuscript_title: manuscript.title,
      orphan_blocks: manuscript.orphanBlocks,
      sections_aligned_to_walk: aligned,
      fidelity_mismatches: mismatches,
      italicised: seen.markWord,
      underlined: seen.underlineAppliedLive ? seen.markWord : null,
      export_notice: seen.noticeText,
      last_sentence: LAST_SENTENCE,
      last_sentence_section_index: lastSentenceSection,
      last_keystroke_to_click_ms: Number(seen.keystrokeToClickMs.toFixed(1)),
      debounce_window_used_ms: Number(seen.debounceUsedMs.toFixed(1)),
      prelocated_export_target: seen.exportTarget,
      word_count_name: seen.countName,
      omitted_gates: [
        {
          gate: "latency, stall, cliff, a11y_exposure, a11y_tree_structure",
          reason:
            "the run is a minute of real keyboard and pointer input, not a soak, and it never " +
            "clicks a navigator row or mutates the tree. It has nothing true to say about frame " +
            "cadence, a leak slope or the navigator's accessibility contract.",
        },
      ],
      scope: {
        input:
          "Real X input throughout: xdotool keystrokes into the shipped editor, and both exports " +
          "driven through the SHIPPED application menu (File > Export manuscript). The first " +
          "export opens File with the route's chord, caches the exact #menu-export accessibility " +
          "node and clicks its recorded center; the second keeps menuDriver.activate(). The page's own JavaScript is never " +
          "called, and the export's effect is verified against the FILE and the STORE, never by " +
          "asking the accessibility layer whether the item ran.",
        the_reader:
          "app/harness/src/markdown-read.ts is the harness's own restatement of the syntax the " +
          "exporter emits, written from the spec's format section and not from export.rs. It " +
          "unescapes `\\x` to `x`, drops heading lines, strips `*`/`**`/`***` and joins blocks " +
          "with one space - which is document_text's own joining rule, so the result is directly " +
          "comparable to the store's text. IT IS NOT A CommonMark IMPLEMENTATION and the " +
          "fidelity gate's threshold says so: there is no CommonMark parser in this project and " +
          "adding one to grade a run would make the run a test of that parser.",
        whitespace_normalization:
          "BOTH SIDES of the fidelity comparison are normalized identically - every run of " +
          "Unicode whitespace collapsed to one space, then trimmed - and the gate's threshold " +
          "string says so rather than leaving it here, because the verdict line is what gets " +
          "read. The asymmetry it absorbs is the format's: the exporter trim_end's every block " +
          "(two trailing spaces are a CommonMark hard break) and separates blocks with a blank " +
          "line, while document_text keeps what was typed and separates blocks with one space. " +
          "The cost is that a whitespace-only difference cannot be detected.",
        alignment:
          "Sections are paired with walk items BY INDEX, never by title: 2,292 of the 20,000 " +
          "stress items share a title. export_structure compares the counts first, which is what " +
          "makes the index alignment sound; when the counts disagree nothing is compared and the " +
          "fidelity gate reports UNKNOWN rather than pairing arbitrary scenes.",
        export_includes_last_keystroke:
          "The claim is the page's drain(), and it only is one because the rig re-reads the " +
          "scene's stored body after the pointer reaches the prelocated Export item and before " +
          "the click that runs Export, and " +
          "ABORTS if the 1000 " +
          "ms flush debounce had already committed the sentence. The debounce is armed by the " +
          "FIRST unflushed edit and never re-armed, so the window starts at the paragraph break " +
          "before the sentence; last_keystroke_to_click_ms is elapsed time from the last keystroke " +
          "to the click, while debounce_window_used_ms is elapsed time from the paragraph break.",
        export_ms:
          "AN UPPER BOUND on project_export, not its latency. The interval runs from the one " +
          "pointer click on the prelocated menu item to the exported file being complete and stable " +
          "on disk, so it covers pointer delivery, the menu's activation, the page's flush drain, " +
          "the IPC both ways, the store " +
          "read, " +
          "the render, the write and the fsync, plus this rig's " +
          `${POLL_MS} ms file polling period. The host writes with one write_all and an fsync, ` +
          "which is not atomic to an observer, so completeness is 'the size stopped changing and " +
          "the last byte is the newline the format always ends with'.",
        export_working_memory:
          "UNAVAILABLE: runShell stops RSS sampling at readiness before this rig's interactive " +
          "File > Export manuscript action. metrics.readiness_peak_rss_mb records that startup " +
          "observation only; it does not cover export working memory.",
        project_word_count:
          "Read off the platform accessibility tree, out of the word count's accessible NAME - " +
          "the same channel a screen reader uses, and the only way out of the page for a figure " +
          "the sink payload does not carry. An absent or unparseable name leaves the figure " +
          "UNREAD, which the gate reports as UNKNOWN and never as agreement.",
        never_clobbers:
          "Both exports write into a FRESH temporary directory named by APP_EXPORT_DIR, so the " +
          "rig knows what appeared without asking the page. Nothing is typed between them, so " +
          "the second file describes the same manuscript; the claim is only that it took a " +
          "different path and left the first file's bytes alone.",
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
