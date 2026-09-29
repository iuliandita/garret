// app/harness/src/outline-cli.ts
// Graded outline-editing run. Creates, renames, reorders, deletes and restores
// manuscript items through REAL pointer and keyboard input against the shipped
// navigator, kills the window, and asserts every edit is in the file the next
// process reads.
//
// THE RESTART ROUND TRIP IS THIS RIG'S WHOLE VALUE, and it is what keeps it
// alongside `context-cli`. That rig grades the context menu's ROUTING - the row
// the writer right-clicked is the row the menu acts on - inside one window.
// This one grades that the operations SURVIVE A SIGKILL AND A REOPEN: the
// deleted scene keeps its prose, the restored one keeps its prose, the rename
// and the reorder are in the file a second process reads. Neither is the other.
//
// THE OUTLINE BAR IS RETIRED, so every affordance this rig used to click is
// gone: #new-scene, #rename-item and #delete-item were five buttons in a 34px
// strip above the navigator. The operations are unchanged and the routes are
// the navigator's CONTEXT MENU (right-click, then keystrokes) and the rename
// PANEL anchored in the project bar. The click mechanism is copied from
// `context-cli` verbatim rather than reinvented: `mousemove --window` then a
// BARE `click 3`, because `xdotool click --window` sends a synthetic event the
// toolkit discards while reporting success.
//
// Real input is the whole point. Every unit below this rig is already tested,
// and app/ui/src/project.ts even exposes the outline unit so a harness could
// drive it directly - which would prove the unit works and say nothing about
// whether a writer can reach it. So the rig right-clicks rows and presses keys,
// and the only thing it is allowed to know about the page is what the platform
// accessibility tree and the store file tell it.
//
// Usage: APP_GUI=1 bun app/harness/src/outline-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg, probeAtspi, unavailable } from "./atspi";
import { captureEnv } from "./env";
import {
  evaluateHierGates,
  evaluateOutlineGates,
  type A11yProbe,
  type GateResult,
  type HierMetrics,
  type OutlineMetrics,
} from "./gates";
import { navContextIndex } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  findWindowId,
  runShell,
  survivingShellPids,
  type RunOutcome,
  type SinkPayload,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** Must match ROW_HEIGHT in app/ui/src/project.ts, `--nav-width` in
 *  app/ui/style.css, and the window size the shell builds in
 *  app/shell-tauri/src-tauri/src/main.rs. Restated rather than imported, for
 *  the same reason gates.ts restates thresholds: these are two programs, and a
 *  shared constant would hide a drift instead of failing on it. switch-cli.ts
 *  restates the same numbers; the two are deliberately independent copies. */
const ROW_HEIGHT = 24;
/** The one gap the navigator's virtual list ever inserts: 16px above the first
 *  reserved root's row (095's separator). RESTATED from `SECTION_GAP` in
 *  app/ui/src/navigator/virtual-list.ts for the reason every constant here is
 *  restated: this rig and the page are two programs. Every row from the first
 *  reserved root on sits this much lower than `index * ROW_HEIGHT` puts it, and
 *  the binned-row right-click is exactly a row past that boundary. */
const SECTION_GAP = 16;
/** The window the shell builds. */
const WINDOW_WIDTH = 900;
/** The height this rig RESIZES the window to, which is not the 900 the shell
 *  builds - one of the two constants here the rig owns rather than restates.
 *
 *  Every click coordinate below assumes an un-scrolled navigator, and by the
 *  end of the run the walk is the fixture's 40 rows plus two created items plus
 *  the bin: 43 rows, 933 px below the bars, in a 900 px window. It scrolls. The
 *  guard below did not catch it because it allowed for ONE created row, and
 *  nothing noticed because nothing clicked a row after the step that scrolled -
 *  until the restore step did, and hit the row two below the one it aimed at.
 *
 *  Resizing is the rig adapting to the application rather than the reverse. The
 *  Xvfb screen is 1280x1024, so this fits.
 *
 *  Raised from 1000 to 1200 by the visual redesign, which took ROW_HEIGHT from
 *  20 to 24: the same 43 rows now need 1032 px below the bars. */
const WINDOW_HEIGHT = 1200;
/** The X screen this rig asks for, and the second constant it owns.
 *
 *  The shared `SERVER_ARGS` give a 1280x1024 screen, and X CLAMPS THE POINTER
 *  TO THE SCREEN rather than erroring. The restore step right-clicks a row that
 *  has moved INTO THE BIN, and the Trash root is the last root, so that row is
 *  the last of 43 and centres near y=1058 - off a 1024 screen. A taller window
 *  alone buys nothing; the screen has to grow with it. `menu-cli` and
 *  `context-cli` already own the same lever for the same row. */
const SERVER_ARGS_TALL = "-screen 0 1280x1200x24 -s 0 -noreset";
const SCREEN_HEIGHT = 1200;
/** The project bar, which DECLARES `height: 39px` (border-box).
 *  Before that it was `padding: 6px` around a 16px/1.6 line plus a 1px border,
 *  which summed to the same number.
 *
 *  Used ONLY as the fit guard's upper bound on what sits above the navigator.
 *  Every click reads the pane's real top out of the accessibility tree instead
 *  - see `paneTop`. Measured against a live window before that change the bar
 *  was 38px, so this was one pixel pessimistic, which is the direction a fit
 *  guard should err in; now it is exact. */
const PROJECT_BAR_HEIGHT = 39;
/** #nav-header, the strip carrying the book's name above the outline. Added
 *  earlier, and 39px BY DESIGN -- the same as the bar, so the navigator's
 *  first row starts at exactly twice it. Every y below is offset by both.
 *
 *  This is the second time a strip has moved every navigator row: the outline
 *  bar's 34px went the other way when it was retired, and a rig that kept the
 *  old number pressed 34px off and reported a plausible result rather than an
 *  error. That is the whole hazard of restating a height at all. */
const NAV_HEADER_HEIGHT = 39;
/** The top of the navigator's first row. One name for the sum, so a third strip
 *  is one edit rather than three. */
const NAV_TOP = PROJECT_BAR_HEIGHT + NAV_HEADER_HEIGHT;
/** #footer { height: 34px }. The navigator's rows still start at
 *  NAV_TOP, but the pane ends this much before the window does, so the
 *  "every row is on screen" guard subtracts it, and so does the clamp that
 *  keeps the editable's corner click inside the pane. */
const FOOTER_HEIGHT = 34;
/** The middle of the navigator pane (`--nav-width: 320px`). */
const NAV_CLICK_X = 160;
/** The navigator column's width. `#nav` and `#editor` are both grid-row 2 and
 *  the second column starts here, so an editable node whose box starts left of
 *  it is not the editor. */
const NAV_WIDTH = 320;
/** How far inside a widget's bottom-right corner to click. Far enough to be
 *  unambiguously inside it, close enough to the end of the last line that the
 *  caret lands after the prose rather than inside the sentence the
 *  document_intact gate is about to assert on. */
const EDGE_INSET_PX = 4;
/** A probe walks the whole accessibility tree over D-Bus and the application
 *  services it on its main loop, so the app is busy for as long as it takes.
 *  Timing a mutation immediately afterwards measures the tail of the probe: the
 *  first run of this rig recorded 106 ms for a create that way, against an
 *  in-page cost the hierarchy run measures at ~1 ms. */
//
//  RAISED 1500 -> 4000 on 2026-08-16. The recorded mechanism for this
//  application EXITING mid-run is repeated AT-SPI clients a few hundred
//  milliseconds apart, and at 1500 this rig lost its fifth and last client: the
//  first two probes read 40 of 40 and 41 of 41 rows and the third came back
//  empty because the shell was gone. Every second here is bought back in
//  confidence, and the run is not on anyone's latency budget.
const PROBE_SETTLE_MS = 4000;
/** Long enough for a click's selection repaint to reach the accessibility tree
 *  before it is read. Two rows repaint, not a reprojection. */
const SELECTION_SETTLE_MS = 600;
/** How many times to ask the registry for the row states before giving up. */
const ROW_STATE_ATTEMPTS = 12;
/** store/mod.rs MAX_DEPTH. Without it the CTE below recurses forever on a
 *  parent_id cycle where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;
/** How long the context menu takes to paint after a right-click, and the step
 *  between ArrowDowns inside it. Both restated from `menu-drive.ts`, which owns
 *  them for the application menu; the dropdown machinery is shared, so the
 *  numbers are the same numbers. */
const MENU_OPEN_MS = 700;
const KEY_STEP_MS = 120;
/** The removal item's id, restated from `nav-context-menu.ts` because a node
 *  has to be named to be found. Its LABEL is not restated - it is read off the
 *  live tree, which is the point of reading it at all. */
const REMOVE_ID = "nav-context-remove";
/** How many ArrowDowns each item is from the top of the context menu, READ from
 *  `nav-context-menu.ts` rather than restated. A rig holding `REMOVE_INDEX = 4`
 *  is correct right up until an item is inserted above it, and then it presses
 *  Return on the item above the one it named and reports whatever that item
 *  did. Same rule `menu-drive.ts` exists for.
 *
 *  Since 095 the menu's length also depends on the row's TYPE (Synopsis... and
 *  Who-appears-here... paint only for a row that carries a body), so the index
 *  is not one number per item any more - `navContextIndex` takes the type of
 *  the row the menu is about. REMOVE_INDEX is computed against "scene" because
 *  every use of it below opens the menu on a scene row (the delete and restore
 *  targets, and the binned row they become); NEW_SCENE_INDEX and RENAME_INDEX
 *  are computed further down, once `targetRow` - a container, never a scene -
 *  is known. */
const REMOVE_INDEX = navContextIndex(REMOVE_ID, "scene");

const SENTENCE_1 = "The archivist numbered every crate before the flood.";
const SENTENCE_2 = "She numbered them again when the water fell.";
/** Typed into the CREATED scene, after clicking its row. Finding it under the
 *  created item's id in the reopened file is what makes
 *  outline_created_scene_opens more than "the navigator painted an attribute".
 *
 *  NO SPACES, and that is load-bearing. If the created row does not open, focus
 *  stays on the navigator and these keystrokes reach its keydown handler, where
 *  a printable character is type-ahead but SPACE IS ACTIVATION. A spaced
 *  sentence therefore walks the selection around and then opens whatever it has
 *  landed on, and the rest of the sentence lands in that scene - which reads
 *  exactly like a mis-aimed click and made the rig abort on a build whose only
 *  defect was the dead activation it was written to catch. Without spaces a
 *  dead activation types into nothing at all, which is the FAIL it should be. */
const SENTENCE_3 = "TheNewCrateHeldNothingButOneLedger.";
/** Typed into the scene this run DELETES, and into nothing else.
 *
 *  A sentence of its own is what makes outline_delete_keeps_the_prose an
 *  independent gate. Reusing SENTENCE_3 would have pointed it at the same body
 *  outline_created_scene_opens already reads, so a destructive delete would
 *  fail both together and the delete gate could never fail alone - an
 *  instrument reporting a verdict it did not earn. */
const SENTENCE_4 = "TheLedgerListedACrateNobodyCouldFind.";
/** Typed into the scene this run deletes and then restores. No spaces, like the
 *  others: Space is activation in the navigator, so a sentence containing one
 *  can activate a row if focus is not where the rig thinks it is. */
const SENTENCE_5 = "TheHarbourmasterKeptTwoSetsOfBooks.";
const NEW_TITLE = "Renamed by the outline rig";
/** The title the first create produces.
 *
 *  RESTATED from `item.numbered.scene`, and the number is the rule from
 *  `numbering.ts`: the lowest positive integer no scene in the project already
 *  carries. The `tiny` fixture's scenes are generated titles like
 *  "Harbor Storm 728", none of which is `Scene <n>` -- so the first create in
 *  this run takes 1. **`createdTitleIsFree` below asserts that premise against
 *  the staged project** rather than trusting it: a fixture generator that
 *  starts naming scenes `Scene 1` would otherwise make this gate quietly
 *  assert something else, which is the vacuity shape this harness has been
 *  bitten by five times. */
const CREATED_TITLE = "Scene 1";

/** xdotool type returns when X has the key events, not when WebKitGTK has
 *  turned them into document state. hand-cli.ts found 500 ms silently
 *  truncating typed text; 2500 ms is what held. */
const SETTLE_MS = 2500;
/** How long a single mutation may take to reach the store before the rig calls
 *  it lost. Two orders of magnitude above the 50 ms gate: this is a liveness
 *  bound, not a latency one. */
const MUTATION_TIMEOUT_MS = 5000;
/** Store polling granularity while timing a mutation. */
const POLL_MS = 2;
/** The reopen boot: long enough to load, short enough not to be a soak. */
const REOPEN_SOAK_MS = 1000;

interface WalkRow {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  position: string;
  depth: number;
}

/** What a row must advertise to assistive technology, derived from the store's
 *  walk alone. The AT-SPI dump is derived from the live ATK bridge. Two
 *  independent derivations: reading one source twice would make a mismatch
 *  impossible and the gate theatre. */
interface ExpectedRow {
  id: string;
  level: number;
  setsize: number;
  posinset: number;
}

interface TreeRowPayload {
  id: string;
  level: number;
  setsize: number;
  posinset: number;
}

/** The reopen boot runs in measure mode with zero mutations, so its
 *  `pre_mutation_rows` IS its whole projection of the reopened store. */
type ReopenPayload = SinkPayload & {
  tree: { pre_mutation_nodes: number; pre_mutation_rows: TreeRowPayload[] };
};

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
     SELECT id, parent_id, type, title, position, 0, position
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.title, i.position,
            w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ${MAX_DEPTH}
   )
   SELECT id, parent_id, type, title, position, depth FROM walk ORDER BY path`;

/** The store's own depth-first walk, restated here from store/mod.rs items()
 *  and run against the file directly. This is the order the navigator projects,
 *  so a row's index in this list is its visible index while nothing is
 *  collapsed - which is what makes a click coordinate computable, and what
 *  makes `nav-row-<walkIndex>` an exact join key. */
function walkOf(db: Database): WalkRow[] {
  return db.query(WALK_SQL).all() as WalkRow[];
}

/** Is `id` the bin, or anything inside it, in this walk?
 *
 *  RESTATED here from store::trashed_ids rather than imported, for the reason
 *  app/harness deliberately restates every gate threshold: these are two
 *  programs. A rig that asked the host's own rule whether the host had put the
 *  item in the bin would be checking the host against itself.
 *
 *  Written as an ancestor walk rather than the host's contiguous-depth scan, so
 *  the two are not even the same algorithm - agreement between them is then
 *  evidence rather than a shared assumption. Bounded by the walk's length: a
 *  cycle would otherwise hang the rig instead of failing it. */
function inBin(walk: WalkRow[], id: string): boolean {
  let cursor: string | null = id;
  for (let step = 0; step <= walk.length && cursor !== null; step++) {
    const row = walk.find((r) => r.id === cursor);
    if (!row) return false;
    if (row.type === "trash") return true;
    cursor = row.parent_id;
  }
  return false;
}

/** Every root type Restore must land BEFORE: the bin, the bible, and the two
 *  matter sections. RESTATED from `app/ui/src/item-types.ts`'s
 *  `RESERVED_ROOT_TYPES` rather than imported, for the reason every gate
 *  threshold here is restated: this rig and the page are two programs, and a
 *  shared constant would hide the day their strings drift. */
const RESERVED_ROOT_TYPES = ["trash", "bible", "front", "back"];

/** The id of the last root-level row that is not a reserved type, or null when
 *  there is none. Where a Restore must have landed. */
function lastManuscriptRootId(walk: WalkRow[]): string | null {
  let last: string | null = null;
  for (const row of walk) {
    if (row.parent_id !== null) continue;
    if (!RESERVED_ROOT_TYPES.includes(row.type)) last = row.id;
  }
  return last;
}

/** Is `id` the last root-level row in the walk, of any type? */
function isLastRoot(walk: WalkRow[], id: string): boolean {
  const roots = walk.filter((r) => r.parent_id === null);
  return roots.length > 0 && roots[roots.length - 1]!.id === id;
}

/** The visible index of the first reserved root in `walk`, or null when the
 *  walk holds none. This is where the navigator draws SECTION_GAP, and it
 *  moves every time a create, delete or restore changes how many rows sit
 *  above the reserved section - so it is read fresh from whatever walk is
 *  current at the moment a row is clicked, never cached across a mutation. */
function firstReservedIndex(walk: readonly WalkRow[]): number | null {
  const at = walk.findIndex((r) => r.parent_id === null && RESERVED_ROOT_TYPES.includes(r.type));
  return at < 0 ? null : at;
}

function openRead(projectPath: string): Database {
  return new Database(projectPath, { readonly: true });
}

function walkOnce(projectPath: string): WalkRow[] {
  const db = openRead(projectPath);
  try {
    return walkOf(db);
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

/** Everything a mutation could have changed, in one comparable string. Used to
 *  detect that a store write landed, so it must cover titles (rename), parents
 *  and positions (move) and the row set (create). */
function signatureOf(walk: readonly WalkRow[]): string {
  return walk.map((r) => `${r.id}|${r.parent_id ?? ""}|${r.title}|${r.position}`).join("\n");
}

/** level / setsize / posinset per row, from the walk and nothing else. */
function expectedRows(walk: readonly WalkRow[]): ExpectedRow[] {
  const groups = new Map<string, number>();
  for (const r of walk) {
    const key = r.parent_id ?? "";
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return walk.map((r) => {
    const key = r.parent_id ?? "";
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { id: r.id, level: r.depth + 1, setsize: groups.get(key) ?? 0, posinset: n };
  });
}

/** 1-based ordinal within the parent's sibling group. `position` itself is an
 *  internal fractional-index key the reopened boot never reports, so the
 *  ordinal it induces is the comparable form of the same fact. */
function ordinalOf(walk: readonly WalkRow[], id: string): number | null {
  const row = walk.find((r) => r.id === id);
  if (row === undefined) return null;
  let n = 0;
  for (const r of walk) {
    if (r.parent_id !== row.parent_id) continue;
    n++;
    if (r.id === id) return n;
  }
  return null;
}

const NAV_ROW_ID = /^nav-row-(\d+)$/;

interface ProbeSample {
  label: string;
  probed_rows: number;
  aligned_rows: number;
  unattributable_rows: number;
  level_mismatches: number;
  setsize_mismatches: number;
  posinset_mismatches: number;
}

/**
 * Compare one AT-SPI dump against the walk read from the store file.
 *
 * The join is the row's DOM id, `nav-row-<walkIndex>`, never the title: 2,292
 * of the 20,000 stress titles are shared, and WebKitGTK gives these rows an
 * empty accessible name anyway. Matching is on the ATK role only, which
 * atspi.ts already enforces - a row carrying `xml-roles:treeitem` while mapping
 * to ATK `section` is invisible to a screen reader and must not count.
 */
function compareProbe(
  label: string,
  probe: A11yProbe,
  expected: readonly ExpectedRow[],
): ProbeSample {
  let aligned = 0;
  let unattributable = 0;
  let levelMismatches = 0;
  let setsizeMismatches = 0;
  let posinsetMismatches = 0;
  const claimed = new Set<number>();

  for (const row of probe.treeRows) {
    const matched = row.id.match(NAV_ROW_ID);
    const at = matched === null ? -1 : Number(matched[1]);
    const want = at >= 0 ? expected[at] : undefined;
    // A repeat means two mounted rows claim the same item: a defect, not a
    // sample. Count it, and do not let it vote twice.
    if (want === undefined || claimed.has(at)) {
      unattributable++;
      continue;
    }
    claimed.add(at);
    aligned++;
    if (row.level !== want.level) levelMismatches++;
    if (row.setsize !== want.setsize) setsizeMismatches++;
    if (row.posinset !== want.posinset) posinsetMismatches++;
  }

  return {
    label,
    probed_rows: probe.treeRows.length,
    aligned_rows: aligned,
    unattributable_rows: unattributable,
    level_mismatches: levelMismatches,
    setsize_mismatches: setsizeMismatches,
    posinset_mismatches: posinsetMismatches,
  };
}

// Where the navigator pane, the editable and the context menu's items actually
// are, asked of the platform accessibility tree rather than computed from a
// stylesheet.
//
// THIS RIG'S OWN WANTED SET, not `nodes.ts`'s. It carries two roles that filter
// does not: `tree`, which is #nav itself and is the ONLY exact statement of
// where the navigator's first row starts, and `menu item`, which is what a
// context-menu item maps to on WebKitGTK (measured by `context-cli`; it is NOT
// `push button`). Widening the shared filter would grow the walk of every rig
// built on it, and this rig cannot afford the ones it already takes.
//
// `tree item` is deliberately ABSENT. Adding it would put forty row nodes into
// every walk to answer a question one node already answers exactly.
//
// This is not "asking the page where its rows are": the page's own JavaScript is
// never consulted, the accessibility tree is a different subsystem from the
// CSSOM, and every click is verified by its EFFECT on the store below.
export const PY_NODES = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
WANTED = ("push button", "button", "toggle button", "entry", "text", "tree", "menu item")

def walk(node, out):
    try:
        role = node.getRoleName()
        if role in WANTED:
            ident = ""
            try:
                for pair in node.getAttributes():
                    if pair.startswith("id:"):
                        ident = pair[3:]
            except Exception:
                pass
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            out.append("\t".join([role, ident, node.name or "", str(e.x), str(e.y), str(e.width), str(e.height)]))
        for i in range(node.childCount):
            walk(node.getChildAtIndex(i), out)
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
out = []
walk(matched[0], out)
sys.stdout.write("\n".join(out))
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

function locateNodes(rootPid: number): Node[] {
  const proc = Bun.spawnSync(["python3", "-c", PY_NODES, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `could not read widget geometry from AT-SPI (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    );
  }
  const out: Node[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    const [role = "", id = "", name = "", x = "", y = "", w = "", h = ""] = line.split("\t");
    if (role.length === 0) continue;
    out.push({ role, id, name, x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
  }
  return out;
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
  console.log("APP_GUI=1 not set; outline run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — build it or generate the fixture before running.`);
    process.exit(1);
  }
}
{
  const preexisting = survivingShellPids();
  if (preexisting.length > 0) {
    console.error(
      `refusing to start: ${SHELL_PROC_NAME} already running (pid(s) ${preexisting.join(", ")}).\n` +
        `A pre-existing instance makes the AT-SPI probe unable to attribute rows to exactly one ` +
        `window, so neither the button geometry nor the structural gate can be measured.`,
    );
    process.exit(1);
  }
}

const projectDir = mkdtempSync(join(tmpdir(), "app-outline-"));
const projectPath = join(projectDir, "project.db");
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
// Click coordinates are computed, so a scrolled pane would silently click the
// wrong row and still produce a plausible-looking result. +1 for the row the
// create is about to add.
// +3, not +1: this run creates two items and the first delete creates the bin.
// The +1 version passed on a walk that overflowed by two rows.
if (NAV_TOP + (walk0.length + 3) * ROW_HEIGHT > WINDOW_HEIGHT - FOOTER_HEIGHT) {
  console.error(
    `${walk0.length} rows (+3 added by this run) at ${ROW_HEIGHT}px below a ${NAV_TOP}px bar+header ` +
      `exceed the ` +
      `${WINDOW_HEIGHT}px window less its ${FOOTER_HEIGHT}px footer: the navigator would scroll, ` +
      `and every click coordinate here assumes it does not.`,
  );
  cleanup();
  process.exit(2);
}

// The premise CREATED_TITLE rests on, checked against the project this run
// actually staged. A fixture generator that began naming scenes `Scene 1` would
// make `create_title_in_walk` assert the fixture rather than the create, which
// is the vacuity shape this harness has been bitten by repeatedly.
if (walk0.some((r) => r.title === CREATED_TITLE)) {
  console.error(
    `the staged fixture already contains a row titled ${CREATED_TITLE}, so the create gate below ` +
      `would pass without anything being created. Either the fixture generator changed or the ` +
      `numbering rule did; CREATED_TITLE has to follow it.`,
  );
  cleanup();
  process.exit(2);
}

const indexed = walk0.map((r, i) => ({ ...r, index: i }));
const scenes = indexed.filter((r) => r.type === "scene");
if (scenes.length < 3) {
  console.error(`fixture has ${scenes.length} scene(s); this rig needs at least 3.`);
  cleanup();
  process.exit(2);
}
// scenes[0] is what project.ts opens at boot, so clicking it would be a no-op
// switch. scenes[1] is a real open, and it is the document every prose gate
// below is about.
const sceneX = scenes[1]!;
// The delete-and-restore target. A SEEDED scene, so the prose the restore gate
// is about was written by the fixture and not by this rig - and no typing step
// is needed to give it a body. Distinct from scenes[0] (opened at boot) and
// scenes[1] (every prose gate above is about it).
const sceneR = scenes[2]!;

// The row the create parents onto, the rename renames, and the reorder moves.
// One row for all three, deliberately: three separate targets would need three
// separate clicks whose landing this rig cannot independently confirm, and the
// three edits are already distinguishable in the store.
//
// A CONTAINER, not a scene: clicking a scene row opens it, which would change
// the document under the editor before the create and muddle the
// create_opened_doc observation below. And it must have a next sibling, or
// Alt+Down is inert.
const target = indexed.find((r) => {
  if (r.type === "scene") return false;
  const sibs = walk0.filter((s) => s.parent_id === r.parent_id);
  const at = sibs.findIndex((s) => s.id === r.id);
  return at >= 0 && at < sibs.length - 1;
});
if (target === undefined) {
  console.error("fixture has no non-scene row with a next sibling; the reorder would be inert.");
  cleanup();
  process.exit(2);
}
// Re-bound after the guard: `target` is `... | undefined` at its declaration
// and the narrowing does not survive into the run hook's closure.
const targetRow = target;
console.log(
  `  ${walk0.length} rows; scene = ${sceneX.id} (row ${sceneX.index}), ` +
    `target = ${target.id} "${target.title}" (row ${target.index}, ${target.type})`,
);

// Both opened on targetRow, so both are computed against ITS type - see
// REMOVE_INDEX's comment above for why that constant is computed separately,
// against "scene".
const NEW_SCENE_INDEX = navContextIndex("nav-context-new-scene", targetRow.type);
const RENAME_INDEX = navContextIndex("nav-context-rename", targetRow.type);

const seedBodies = bodiesOnce(projectPath);
const seedTitles = new Map(walk0.map((r) => [r.id, r.title]));

/** One structural edit, timed from the input event to the store commit.
 *
 *  `input` is load-bearing, not a label. The SAME item_create measured 103 ms
 *  when a mouse click activated the outline bar's button and 16 ms when Return
 *  activated the same focused button - so a percentile mixing the two would be
 *  reporting WebKitGTK's pointer-event delivery under the name of the outline
 *  command. Only keyboard samples feed the latency gate.
 *
 *  EVERY SAMPLE IS KEYBOARD NOW, and that is a loss this result has to carry
 *  openly rather than a tidy-up. The bar is retired, and the routes that
 *  replaced it are a context menu opened by a right-click and driven by
 *  keystrokes: the mutation is always the Return, and the pointer event that
 *  preceded it only opened a menu. Timing a POINTER-driven mutation now means
 *  clicking a menu item, whose coordinates cost an AT-SPI walk this rig cannot
 *  spend (three clients per window is already the recorded ceiling). So the
 *  ~87 ms Xvfb pointer-delivery finding is not re-measured here; it stands in
 *  the superseded results and is unchanged by this slice. */
interface Mutation {
  label: string;
  input: "pointer" | "keyboard";
  ms: number;
}
const mutations: Mutation[] = [];
const mutationErrors: string[] = [];
let walkAfterCreate: WalkRow[] = [];
let walkFinal: WalkRow[] = [];
const probes: ProbeSample[] = [];
let probeBeforeCreate = 0;
let probeAfterCreate = 0;
// Seeded with an unavailable probe rather than null: this is assigned inside
// the run hook, and a nullable read afterwards narrows to `null` at the top
// level regardless, which turns the guard below into dead code.
let postProbe: A11yProbe = unavailable();
/** The item the CLICKED create added, and whether the navigator marked its row
 *  as the open document once it was clicked. Assigned inside the run hook. */
let createdId: string | null = null;
/** The scene this run deletes: the one the KEYBOARD create made, which no other
 *  step touches. */
let deleteTargetId: string | null = null;
/** The scene this run deletes and then puts BACK: a seeded one, so its prose
 *  was written by the fixture rather than by this rig, and the restore gate is
 *  about text nothing in this process typed.
 *
 *  A second target, not the one above: the delete gates read the REOPENED file,
 *  so restoring the item they are about would make them fail describing an item
 *  that is no longer deleted. */
let restoreTargetId: string | null = null;
/** The reordered row's ordinal among its siblings, read from the live store at
 *  three instants: before the first Alt+Down, after it, and after Ctrl+Z.
 *  Assigned inside the run hook. */
let undoOrdinalBefore: number | null = null;
let undoOrdinalAfterMove: number | null = null;
let undoOrdinalAfterUndo: number | null = null;
/** create, create-for-delete, rename, move, undo, move (again), delete,
 *  delete-for-restore, restore. */
const MUTATIONS_ATTEMPTED = 9;
/** Every document whose body changed while SENTENCE_3 was being typed. */
const typedInto: string[] = [];

console.log("\n[2/4] interactive run");
// GDK_BACKEND=x11 is load-bearing: a developer's ambient session sets
// WAYLAND_DISPLAY and GTK prefers Wayland, so the webview would open on the
// real desktop instead of the Xvfb display xdotool targets.
/** ONE PHASE OF THE INTERACTIVE RUN, IN ITS OWN WINDOW.
 *
 *  Split in two on 2026-08-16 because the single window took FIVE AT-SPI
 *  clients -- a boot walk, two tree probes, a button walk and a final tree
 *  probe -- against a recorded three-to-five boundary at which this application
 *  EXITS: cleanly, with nothing on its stderr, taking xvfb-run's X server with
 *  it. It did exit, reproducibly, and the symptom is `could not read widget
 *  geometry from AT-SPI (exit 4)`, which reads as a bridge failure and is
 *  really the shell being gone (confirmed by polling `pgrep -x
 *  app-shell-tauri` through a run).
 *
 *  MORE SPACING DID NOT HELP. Raising the settle from 1500 ms to 4000 ms moved
 *  the death EARLIER on the next run, which is what a race looks like: the
 *  lever is the number of clients per window, not the interval between them.
 *
 *  Phase "a" is steps 1-8 -- create by click, create by keyboard, type, open,
 *  rename, reorder -- and takes three clients. Phase "b" reopens the same
 *  project and does steps 9-11, delete and restore, and takes three. NO CLAIM
 *  MOVES: everything phase A asserts about the page not remounting is asserted
 *  inside phase A, and everything phase B asserts is about the store and the
 *  reopened file, which is where the delete and restore evidence already lived.
 */
async function drive(phase: "a" | "b"): Promise<RunOutcome<{ ready: boolean; error?: string; item_id: string | null; rows: number; startup_ms: number }>> {
  return runShell<{ ready: boolean; error?: string; item_id: string | null; rows: number; startup_ms: number }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", APP_PROJECT: projectPath, GDK_BACKEND: "x11" },
    probeA11y: false,
    serverArgs: SERVER_ARGS_TALL,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("outline rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);

      // Make the window tall enough that the whole walk fits without scrolling.
      // XResizeWindow, which needs no window manager - there is none under
      // Xvfb. Verified rather than assumed: a resize that silently did nothing
      // would put every click coordinate below two rows out, which is a wrong
      // number rather than an error.
      xdo(display, ["windowsize", wid, String(WINDOW_WIDTH), String(WINDOW_HEIGHT)]);
      await Bun.sleep(500);
      const geometry = xdo(display, ["getwindowgeometry", "--shell", wid]);
      const height = Number(geometry.match(/\bHEIGHT=(\d+)/)?.[1] ?? 0);
      if (height !== WINDOW_HEIGHT) {
        throw new Error(
          `the window is ${height}px tall after asking for ${WINDOW_HEIGHT}: the navigator would ` +
            `scroll and every click coordinate in this rig assumes it does not.`,
        );
      }

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

      const db = openRead(projectPath);
      /** Drive one mutation and time it from the input event to the store
       *  commit. See metrics.scope.mutation_latency for what that does and does
       *  not include. */
      async function mutate(
        label: string,
        input: "pointer" | "keyboard",
        act: () => void,
      ): Promise<void> {
        const before = signatureOf(walkOf(db));
        const started = Bun.nanoseconds();
        act();
        const deadline = Date.now() + MUTATION_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (signatureOf(walkOf(db)) !== before) {
            mutations.push({ label, input, ms: (Bun.nanoseconds() - started) / 1e6 });
            return;
          }
          await Bun.sleep(POLL_MS);
        }
        mutationErrors.push(`${label}: the store did not change within ${MUTATION_TIMEOUT_MS} ms`);
      }

      /** Where a navigator row's centre is, measured rather than restated.
       *
       *  THE EDITABLE'S BOX IS NOT THE ANSWER, and reading it as one would be
       *  wrong by EXACTLY ONE ROW. It used to be right by accident: #editor was
       *  `grid-row: 2 / span 2` and started at the project bar's bottom edge
       *  while #nav started below the outline bar, so #editor's own 24px
       *  padding put the editable 10px ABOVE the pane's true top - inside the
       *  first row's band, and every click landed. With the bar retired both
       *  panes are grid-row 2 and share a top edge, so the same reading is now
       *  the pane top PLUS 24px, which is ROW_HEIGHT, which is row index + 1.
       *  Measured against a live window: pane 38, editable 62.
       *
       *  #nav itself is in the tree as `tree` and its extents ARE the pane's
       *  box, so it answers the top and the height together and neither has to
       *  be restated. Restate what the design fixes, read what the run fixes.
       *
       *  Declared as functions because clickRow is defined before the walk that
       *  answers them. */
      function paneBox(): Node {
        if (navPane === undefined) {
          throw new Error("the navigator pane's box was not resolved before a row was clicked");
        }
        return navPane;
      }

      function rowCentre(index: number): number {
        const pane = paneBox();
        // SECTION_GAP, read fresh from the live walk: a row at or after the
        // first reserved root sits 16px lower than `index * ROW_HEIGHT` would
        // put it, and a walk taken before this click's own mutations is the
        // wrong one to ask - the binned-row right-click is exactly this row.
        const gapAt = firstReservedIndex(walkOf(db));
        const gap = gapAt !== null && index >= gapAt ? SECTION_GAP : 0;
        // A row below the un-scrolled viewport is only reachable if the pane
        // has scrolled, and then this arithmetic is describing a different row.
        if ((index + 1) * ROW_HEIGHT + gap > pane.h) {
          throw new Error(
            `row ${index} sits below the ${pane.h}px navigator viewport: reaching it needs a ` +
              `scrolled pane, and every coordinate here assumes an un-scrolled one.`,
          );
        }
        const y = pane.y + index * ROW_HEIGHT + gap + ROW_HEIGHT / 2;
        // X CLAMPS THE POINTER TO THE SCREEN rather than erroring, so a press
        // below it lands somewhere else and still reports success. That is the
        // whole failure mode this rig exists inside: a plausible number instead
        // of an error.
        if (y >= SCREEN_HEIGHT) {
          throw new Error(
            `row ${index} centres at y=${y}, off the ${SCREEN_HEIGHT}px X screen: the pointer ` +
              `would be clamped and the press would land on another row.`,
          );
        }
        return y;
      }

      function clickRow(index: number): void {
        xdo(display, ["mousemove", "--window", wid, String(NAV_CLICK_X), String(rowCentre(index))]);
        xdo(display, ["click", "1"]);
      }

      /** Right-click a row: this is how every structural operation is reached
       *  now that the outline bar is retired.
       *
       *  `mousemove --window` is window-relative and lands the pointer; the
       *  click that follows is deliberately NOT `--window`. With the flag,
       *  xdotool sends a synthetic button event through XSendEvent, which GTK
       *  and WebKit discard as untrusted - no error, no effect, and a menu that
       *  never opens while every call reports success. Copied from
       *  `context-cli`, which copied it from this file. */
      function rightClickRow(index: number): void {
        xdo(display, ["mousemove", "--window", wid, String(NAV_CLICK_X), String(rowCentre(index))]);
        xdo(display, ["click", "3"]);
      }

      /** Step down to `index` in an already-open context menu. The Return that
       *  runs the item is left to the caller, because it is the timed half. */
      async function stepTo(index: number): Promise<void> {
        for (let i = 0; i < index; i++) {
          xdo(display, ["key", "Down"]);
          await Bun.sleep(KEY_STEP_MS);
        }
      }

      /** Open the context menu on a row and step onto one of its items. */
      async function openContextOn(index: number, itemIndex: number): Promise<void> {
        rightClickRow(index);
        await Bun.sleep(MENU_OPEN_MS);
        await stepTo(itemIndex);
      }

      /** Put DOM focus on #nav with `index` selected, deterministically and
       *  without spending a walk.
       *
       *  A left click will not do it: clicking a row ACTIVATES it, and
       *  activating a scene focuses the editor while activating a container
       *  focuses nothing at all - so focus stays wherever it happened to be and
       *  a navigator chord sent afterwards goes into the prose. The context
       *  menu's Escape path is specified to return focus to #nav with the row
       *  it opened on still named by aria-activedescendant, so opening and
       *  dismissing it is an exact answer to "focus the tree on this row". */
      async function focusNavOnRow(index: number): Promise<void> {
        rightClickRow(index);
        await Bun.sleep(MENU_OPEN_MS);
        xdo(display, ["key", "Escape"]);
        await Bun.sleep(KEY_STEP_MS * 3);
      }

      // ONE WALK, TWO ANSWERS, and it is the only client this phase spends
      // before its probes. Eight AT-SPI clients in one window once killed this
      // application outright - cleanly, nothing on stderr, taking xvfb-run's X
      // server with it, against a recorded three-to-five boundary. The failure
      // reads as `could not read widget geometry from AT-SPI (exit 4)`, which
      // looks like a bridge problem and is really the shell being gone
      // (confirmed by polling `pgrep -x app-shell-tauri` through a run).
      const boot = locateNodes(rootPid);
      // #nav's own box: the pane's top edge and its height, exactly, from the
      // one node that states them. Everything about a row coordinate comes from
      // here - see rowCentre for why the editable's box is the wrong answer by
      // exactly one row.
      const navPane = boot.find((n) => n.role === "tree" && n.h > 0);
      if (navPane === undefined) {
        throw new Error(
          `no tree node in the accessibility tree, so the navigator pane's box cannot be read. ` +
            `Roles seen: ${[...new Set(boot.map((n) => n.role))].join(", ") || "none"}`,
        );
      }
      //
      // Resolved ONCE, from the boot walk above, and reused by all three calls.
      // Safe because the box does not usefully move: `.ProseMirror` carries
      // `min-height: 100%`, so the editable is at least the pane's height
      // whatever document is open, and the corner clicked below is inside it.
      // A shorter document cannot pull that corner out from under the pointer.
      const editableNodes = boot.filter(
        (n) => (n.role === "entry" || n.role === "text") && n.h > 0,
      );
      // Chosen by POSITION, not by order. The rename field is an editable too;
      // it lives in a panel that is hidden at boot, but it is anchored in the
      // project bar and would sort ahead of the editor if it were ever open.
      // Selecting the one outside the navigator column names the editor
      // directly instead of relying on a traversal order.
      const editorEntry = editableNodes.find((n) => n.x >= NAV_WIDTH);
      if (editorEntry === undefined) {
        if (editableNodes.length === 0) {
          throw new Error("no editable text node in the accessibility tree: nothing to type into");
        }
        throw new Error(
          `every editable node starts inside the ${NAV_WIDTH}px navigator column ` +
            `(x = ${editableNodes.map((n) => n.x).join(", ")}): none of them is the editor.`,
        );
      }
      console.log(
        `  nav pane at y=${navPane.y} h=${navPane.h}; editable at y=${editorEntry.y} ` +
          `(the ${editorEntry.y - navPane.y}px difference is #editor's padding, not the pane top)`,
      );

      /** Put the caret at the end of the open document, by clicking the last
       *  line of the contenteditable itself.
       *
       *  NOT a click at a fixed point low in the editor pane: the editable
       *  element is only as tall as its prose (measured at 75 px for a seeded
       *  scene inside an 862 px pane), so a click below it lands on #editor's
       *  padding, focus stays wherever it was - on the button just clicked -
       *  and the sentence that follows is typed into nothing at all. That is
       *  what the first run of this rig did, and it read as a failed
       *  create_opened_doc rather than as a rig defect. */

      function clickEditorEnd(): void {
        const entry = editorEntry!;
        // CLAMPED TO THE WINDOW. AT-SPI reports LAYOUT extents, not clipped
        // ones -- prefs-cli measured an editable 1082px tall at y=-143 inside a
        // 900px window -- so a document longer than the pane puts this corner
        // OUTSIDE the window and the click lands on the desktop. The pointer is
        // clamped to the screen by X, so it does not even error: it moves
        // somewhere else and presses there.
        //
        // Clamping keeps the intent (a point low and right INSIDE the editable)
        // and drops only the part of the box nobody can click anyway. The
        // bottom is the PANE's, not the window's: the footer owns the
        // last 34px, and a click clamped to the window would press its status
        // dot instead of the prose.
        const x = Math.min(entry.x + entry.w, WINDOW_WIDTH) - EDGE_INSET_PX;
        const y = Math.min(entry.y + entry.h, WINDOW_HEIGHT - FOOTER_HEIGHT) - EDGE_INSET_PX;
        if (x <= entry.x || y <= Math.max(entry.y, NAV_TOP)) {
          throw new Error(
            `the editable's visible box is empty (${entry.x},${entry.y} ${entry.w}x${entry.h} ` +
              `against a ${WINDOW_WIDTH}x${WINDOW_HEIGHT} window): there is nowhere in it to click.`,
          );
        }
        xdo(display, ["mousemove", "--window", wid, String(x), String(y)]);
        xdo(display, ["click", "1"]);
      }

      if (phase === "a") {
      // 1. Open a scene that is NOT the one the page opened at boot, and put a
      //    known sentence in it. Everything the prose gates assert is about this
      //    document.
      clickRow(sceneX.index);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["type", "--delay", "40", SENTENCE_1]);
      await Bun.sleep(SETTLE_MS);
      // Verified by effect, not by asking the screen: if this click missed, the
      // sentence is in some other scene or nowhere, and document_intact would
      // FAIL for the rig's aim rather than the application's behaviour.
      if (!(bodiesOnce(projectPath).get(sceneX.id) ?? "").includes(SENTENCE_1)) {
        throw new Error(
          `the opening click did not reach ${sceneX.id}: the sentence typed after it is not in ` +
            `that scene's body. The row coordinates are wrong or the pane scrolled.`,
        );
      }

      // 2. Select the container the create will parent onto. A container, so
      //    the editor keeps holding sceneX.
      clickRow(targetRow.index);
      await Bun.sleep(500);

      const before = probeAtspi(rootPid);
      probeBeforeCreate = before.treeRows.length;
      probes.push(compareProbe("before-create", before, expectedRows(walk0)));
      await Bun.sleep(PROBE_SETTLE_MS);

      // 3. Create, through the SHIPPED context menu. This is the affordance
      //    proof and the only create the outline_create_visible gate sees:
      //    every probe below is taken around THIS one.
      //
      //    The right-click and the ArrowDowns are outside the clock; the timed
      //    action is the Return that runs the item, which is one xdotool spawn.
      //    The right-click also re-selects the row, so the create parents onto
      //    the container this step is about whatever step 2's click did.
      await openContextOn(targetRow.index, NEW_SCENE_INDEX);
      await mutate("create", "keyboard", () => xdo(display, ["key", "Return"]));
      await Bun.sleep(1000);
      walkAfterCreate = walkOf(db);
      const after = probeAtspi(rootPid);
      probeAfterCreate = after.treeRows.length;
      probes.push(compareProbe("after-create", after, expectedRows(walkAfterCreate)));
      await Bun.sleep(PROBE_SETTLE_MS);

      // 3b. Which item the click created. Read from the store, not from a
      //     title -- and still read from the store now that placement logic
      //     numbers the two creates in this run differently: an id is what
      //     the later steps act on, and deriving it from a title would put the numbering
      //     rule in the rig.
      const seededIds = new Set(walk0.map((r) => r.id));
      const born = walkAfterCreate.filter((r) => !seededIds.has(r.id));
      if (born.length !== 1) {
        throw new Error(
          `the create added ${born.length} item(s) to the store, expected exactly 1; there is no ` +
            `single created row to open.`,
        );
      }
      createdId = born[0]!.id;

      // 4. Keep typing, in the editor, without clicking anything. The create
      //    OPENED its row (owner ruling 2026-09-01), so this sentence must land
      //    in the CREATED scene; a create that only selected, or a rebuilt page
      //    holding the boot-time document, would put it elsewhere. BEFORE the
      //    second create below, which opens its own row in turn.
      clickEditorEnd();
      await Bun.sleep(500);
      xdo(display, ["type", "--delay", "40", SENTENCE_2]);
      await Bun.sleep(SETTLE_MS);

      // 3c. A second create, for the delete step to act on. Same route, same
      //     row: the menu is reopened rather than reused, because activating an
      //     item closes it and a rig that assumed otherwise would be pressing
      //     Return into the page.
      await openContextOn(targetRow.index, NEW_SCENE_INDEX);
      await mutate("create-for-delete", "keyboard", () => xdo(display, ["key", "Return"]));
      await Bun.sleep(1000);

      // 3d. Which item THAT create made. It is the scene this run deletes, and
      //     it is deliberately not the one the create gates follow: the delete
      //     must be measurable without disturbing them, and a gate whose target
      //     is another gate's target cannot fail on its own.
      const afterKeyboardCreate = walkOf(db);
      const seenAfterClick = new Set(walkAfterCreate.map((r) => r.id));
      const bornAgain = afterKeyboardCreate.filter((r) => !seenAfterClick.has(r.id));
      if (bornAgain.length !== 1) {
        throw new Error(
          `the keyboard create added ${bornAgain.length} item(s), expected exactly 1; there is no ` +
            `single row for the delete step to act on.`,
        );
      }
      deleteTargetId = bornAgain[0]!.id;

      // 5. Now go to the new row and open it. This is the half of the create's
      //    story that every other gate was blind to: the opener's type lookup
      //    read a boot-time walk, so a scene created in the session had no known
      //    type, and an unknown type took the same silent early return as a
      //    part. The row appeared, the click did nothing, and nothing said so.
      //
      //    The row index comes from the store's walk, never from the screen,
      //    and which document the next sentence lands in tells the rig whether
      //    the click landed at all - see below. That discrimination is the
      //    whole reason this step reads the store twice: a missed click leaves
      //    the open document unchanged, which is exactly what the defect looks
      //    like from outside.
      // From the walk AS IT IS NOW, not from walkAfterCreate: a second create
      // has landed since, and an index into a stale walk is an index into a
      // different manuscript.
      const walkNow = walkOf(db);
      const createdIndex = walkNow.findIndex((r) => r.id === createdId);
      if (createdIndex < 0) throw new Error(`created item ${createdId} is not in the live walk`);
      console.log(
        `  created ${createdId} at row ${createdIndex} of ${walkNow.length} ` +
          `(stale index would have been ${walkAfterCreate.findIndex((r) => r.id === createdId)})`,
      );
      const beforeOpen = bodiesOnce(projectPath);
      clickRow(createdIndex);
      await Bun.sleep(SETTLE_MS);
      // Typed whether or not the row went current: if the activation is dead
      // these keystrokes reach the navigator as type-ahead and the sentence
      // simply never appears under the created id, which is the FAIL.
      xdo(display, ["type", "--delay", "40", SENTENCE_3]);
      await Bun.sleep(SETTLE_MS);
      // Which document actually received it. Three outcomes, and they are not
      // the same thing:
      //   the created scene  -> the click landed AND the row opened: PASS.
      //   another document   -> the click landed somewhere else, so nothing
      //                         here is about the created row: ABORT.
      //   no document at all -> the row was selected but never opened, so the
      //                         keystrokes reached the navigator as type-ahead
      //                         and went nowhere. That IS the defect: FAIL.
      const afterOpen = bodiesOnce(projectPath);
      for (const [itemId, body] of afterOpen) {
        if (body === beforeOpen.get(itemId)) continue;
        typedInto.push(itemId);
        if (itemId !== createdId) {
          console.log(
            `  stray: ${itemId} is walk row ${walkNow.findIndex((r) => r.id === itemId)}, ` +
              `aimed at row ${createdIndex}`,
          );
        }
      }


      // 7. Rename, through the context menu and the SHIPPED rename panel. The
      //    selection is on the created row after step 5; the right-click moves
      //    it back onto the container and the menu captures that row, so the
      //    rename cannot land on whatever the previous step left selected.
      //
      //    No ctrl+a: the panel selects the prefilled title on open, so typing
      //    replaces it. That is a change from the outline bar's field, which
      //    focused at the end and needed one.
      await openContextOn(targetRow.index, RENAME_INDEX);
      xdo(display, ["key", "Return"]);
      await Bun.sleep(1000);
      xdo(display, ["type", "--delay", "40", NEW_TITLE]);
      await Bun.sleep(300);
      await mutate("rename", "keyboard", () => xdo(display, ["key", "Return"]));
      await Bun.sleep(1000);
      // Which item actually got the new title. A missed row click renames a
      // different one, and outline_rename_persists would then report the
      // application failing to do something it was never asked to do.
      const renamed = walkOf(db).filter((r) => r.title === NEW_TITLE).map((r) => r.id);
      if (renamed.length !== 1 || renamed[0] !== targetRow.id) {
        throw new Error(
          `the rename landed on ${renamed.join(", ") || "nothing"}, not on ${targetRow.id}: the ` +
            `row click before it selected the wrong row.`,
        );
      }

      // 8. Reorder. Alt+Down is the NAVIGATOR's chord, so it needs DOM focus on
      //    #nav - which a left click on a row does not give (it activates the
      //    row, and a container activates nothing). Opening the context menu and
      //    pressing Escape does, by the panel's own focus-return rule, with the
      //    row it opened on still selected.
      await focusNavOnRow(targetRow.index);
      const beforeMove = new Map(walkOf(db).map((r) => [r.id, `${r.parent_id ?? ""}|${r.position}`]));
      undoOrdinalBefore = ordinalOf(walkOf(db), targetRow.id);
      await mutate("move", "keyboard", () => xdo(display, ["key", "alt+Down"]));
      await Bun.sleep(1000);
      // Which item actually moved. This one is the reason all four of these
      // guards exist: a missed click moves some OTHER row, the target's own
      // ordinal is then identical before the kill and after the reopen, and
      // outline_reorder_persists PASSES having tested nothing at all.
      const moved = walkOf(db)
        .filter((r) => beforeMove.get(r.id) !== `${r.parent_id ?? ""}|${r.position}`)
        .map((r) => r.id);
      if (!moved.includes(targetRow.id)) {
        throw new Error(
          `the reorder moved ${moved.join(", ") || "nothing"}, not ${targetRow.id}: the row click ` +
            `before it selected the wrong row, and the gate would pass on an untouched item.`,
        );
      }
      undoOrdinalAfterMove = ordinalOf(walkOf(db), targetRow.id);

      // 8a. Undo. #nav still has DOM focus - Alt+Down leaves it exactly where
      //    it put it - so Ctrl+Z reaches the navigator's own undo, which
      //    writes the inverse of the last outline change (this move) to the
      //    store. NOT asserted to succeed here: a build where Ctrl+Z does
      //    nothing is the FAIL outline_undo_restores_order exists to report,
      //    and throwing on that would turn the FAIL into an aborted run with
      //    no evidence at all.
      await mutate("undo", "keyboard", () => xdo(display, ["key", "ctrl+z"]));
      await Bun.sleep(1000);
      undoOrdinalAfterUndo = ordinalOf(walkOf(db), targetRow.id);

      // 8b. A second Alt+Down, displacing the row again exactly as 8 did, so
      //    outline_reorder_persists below still compares the ordinal the store
      //    held before the kill against the reopened file, unaffected by
      //    whether the undo above worked. Without it, a working undo would
      //    leave the row at its pre-reorder ordinal across the kill and
      //    outline_reorder_persists would PASS on a project this run never
      //    actually reordered.
      const beforeSecondMove = new Map(
        walkOf(db).map((r) => [r.id, `${r.parent_id ?? ""}|${r.position}`]),
      );
      await mutate("move", "keyboard", () => xdo(display, ["key", "alt+Down"]));
      await Bun.sleep(1000);
      const movedAgain = walkOf(db)
        .filter((r) => beforeSecondMove.get(r.id) !== `${r.parent_id ?? ""}|${r.position}`)
        .map((r) => r.id);
      if (!movedAgain.includes(targetRow.id)) {
        throw new Error(
          `the second reorder moved ${movedAgain.join(", ") || "nothing"}, not ${targetRow.id}: ` +
            `outline_reorder_persists would grade the wrong item.`,
        );
      }

      }

      if (phase === "b") {
      // 9. Delete, through the SHIPPED context menu, on a scene with prose of
      //    its own.
      //
      //    Opened and typed into first: a newly created scene has an empty
      //    body, and "the prose survived" over an empty body is a sentence
      //    about nothing.
      const walkBeforeDelete = walkOf(db);
      const deleteIndex = walkBeforeDelete.findIndex((r) => r.id === deleteTargetId);
      if (deleteIndex < 0) {
        throw new Error(`the delete target ${deleteTargetId} is not in the live walk`);
      }
      clickRow(deleteIndex);
      await Bun.sleep(SETTLE_MS);
      clickEditorEnd();
      await Bun.sleep(500);
      xdo(display, ["type", "--delay", "40", SENTENCE_4]);
      await Bun.sleep(SETTLE_MS);
      // The prose has to be IN THE STORE before the delete, or the gate after
      // the restart is reading a body this run never wrote and would fail while
      // the application behaved correctly.
      if (!(bodiesOnce(projectPath).get(deleteTargetId!) ?? "").includes(SENTENCE_4)) {
        throw new Error(
          `the delete target ${deleteTargetId} does not hold its sentence, so the click missed it ` +
            `or the row never opened; the prose gate would grade a body this run never wrote.`,
        );
      }
      // Right-click the row: the menu captures the row it opens on, so no
      // separate selecting click is needed and the delete cannot act on the
      // selection clickEditorEnd left behind. Re-read the walk first - nothing
      // has moved it, and an index from a stale walk is the defect every other
      // step here guards against.
      const walkForDelete = walkOf(db);
      const reIndex = walkForDelete.findIndex((r) => r.id === deleteTargetId);
      if (reIndex < 0) throw new Error(`the delete target ${deleteTargetId} left the walk`);
      await openContextOn(reIndex, REMOVE_INDEX);
      await mutate("delete", "keyboard", () => xdo(display, ["key", "Return"]));
      await Bun.sleep(1000);
      // Which item actually went, checked live for the same reason the reorder
      // is: a missed click deletes some OTHER row, and both delete gates would
      // then pass or fail describing an item this run never chose.
      const afterDelete = walkOf(db);
      if (!inBin(afterDelete, deleteTargetId!)) {
        throw new Error(
          `${deleteTargetId} is not in the bin after the Delete click: the click missed, or the ` +
            `delete landed on another row, and both delete gates would grade the wrong item.`,
        );
      }

      // 10. Delete a SEEDED scene and put it straight back, through the same
      //     shipped menu item - which has to be reading "Restore" by then.
      //
      //     Seeded, so its prose came from the fixture: "the restored item
      //     still has its words" is then a claim about text this process never
      //     typed. No typing step, and one fewer thing that can miss.
      restoreTargetId = sceneR.id;

      //     Reachable without scrolling only because the window was resized at
      //     boot: the delete above left the selection on the row it binned
      //     (reload preserves it by id and scrolls to it), and in the 900 px
      //     window the shell builds that pushed the pane down two rows and this
      //     click landed on the wrong scene.
      //
      const walkBeforeR = walkOf(db);
      const rIndex = walkBeforeR.findIndex((r) => r.id === restoreTargetId);
      if (rIndex < 0) throw new Error(`the restore target ${restoreTargetId} is not in the walk`);
      clickRow(rIndex);
      await Bun.sleep(SETTLE_MS);
      clickEditorEnd();
      await Bun.sleep(500);
      xdo(display, ["type", "--delay", "40", SENTENCE_5]);
      await Bun.sleep(SETTLE_MS);
      //     The sentence has to reach the STORE before the delete. It is what
      //     proves the click landed on this row and not on whichever row the
      //     scroll reset left under the pointer - and it is the text the
      //     restore gate is about, so grading it against a body this run never
      //     wrote would fail while the application behaved.
      const afterTyping = bodiesOnce(projectPath);
      if (!(afterTyping.get(restoreTargetId) ?? "").includes(SENTENCE_5)) {
        // Naming where it DID land turns "the click missed" into "the click hit
        // this row instead", which is the difference between a rig defect and
        // an application one.
        const landed = [...afterTyping]
          .filter(([, b]) => b.includes(SENTENCE_5))
          .map(([id]) => `${id} (row ${walkBeforeR.findIndex((r) => r.id === id)})`);
        throw new Error(
          `the restore target ${restoreTargetId} does not hold its sentence; it landed in ` +
            `${landed.join(", ") || "no document at all"}, aimed at row ${rIndex} of ` +
            `${walkBeforeR.length}. ` +
            `The scroll reset above did not take, or the row never opened.`,
        );
      }
      const walkForR = walkOf(db);
      const reRIndex = walkForR.findIndex((r) => r.id === restoreTargetId);
      if (reRIndex < 0) throw new Error(`the restore target ${restoreTargetId} left the walk`);
      await openContextOn(reRIndex, REMOVE_INDEX);
      await mutate("delete-for-restore", "keyboard", () => xdo(display, ["key", "Return"]));
      await Bun.sleep(1000);
      const afterSecondDelete = walkOf(db);
      if (!inBin(afterSecondDelete, restoreTargetId)) {
        throw new Error(
          `${restoreTargetId} is not in the bin after its Delete click: the click missed, and the ` +
            `restore below would put back an item that was never removed.`,
        );
      }

      //     THE ROW HAS MOVED INTO THE BIN, which is the last root, so it is
      //     now the LAST row of the walk - and it is right-clicked where the
      //     store says it now is, not where it was. That is why this rig asks
      //     for a 1200px screen: at 43 rows the binned row centres near y=1058,
      //     off the shared rig's 1024px screen, and X clamps the pointer rather
      //     than erroring.
      //
      //     The item must now READ Restore. Checked against the accessibility
      //     tree rather than against the stylesheet or the source: this project
      //     has twice shipped a control that was correct in every unit test and
      //     wrong on screen, and both times a look at the running app is what
      //     found it. The walk is taken with the menu OPEN and the same open
      //     menu is then driven, so the item graded and the item run are one
      //     paint.
      //
      //     SPACED from the walk before it. The recorded mechanism for the
      //     application exiting is repeated AT-SPI clients a few hundred
      //     milliseconds apart, and this is the one client in the run that
      //     follows a click rather than a settle.
      const walkForRestore = walkOf(db);
      const binnedIndex = walkForRestore.findIndex((r) => r.id === restoreTargetId);
      if (binnedIndex < 0) throw new Error(`the binned row ${restoreTargetId} left the walk`);
      rightClickRow(binnedIndex);
      await Bun.sleep(PROBE_SETTLE_MS);
      const opened = locateNodes(rootPid);
      const removeItem = opened.find((n) => n.id === REMOVE_ID);
      if (removeItem === undefined) {
        throw new Error(
          `#${REMOVE_ID} is absent from the accessibility tree with the menu open on the binned ` +
            `row; the right-click at row ${binnedIndex} opened nothing. Ids seen: ` +
            `${opened.map((n) => n.id).filter(Boolean).join(", ") || "none"}`,
        );
      }
      if (removeItem.name !== "Restore") {
        throw new Error(
          `#${REMOVE_ID} advertises "${removeItem.name}" on a binned row, expected "Restore": ` +
            `the writer is being offered Delete on an item that is already deleted.`,
        );
      }
      await stepTo(REMOVE_INDEX);
      await mutate("restore", "keyboard", () => xdo(display, ["key", "Return"]));
      await Bun.sleep(1000);
      const afterRestore = walkOf(db);
      if (inBin(afterRestore, restoreTargetId)) {
        throw new Error(
          `${restoreTargetId} is still in the bin after the Restore click, so the reopened-file ` +
            `gate would grade an item this run failed to restore.`,
        );
      }
      // The other delete must NOT have come back with it. A restore that
      // emptied the bin would satisfy every gate below and be a different
      // feature.
      if (deleteTargetId !== null && !inBin(afterRestore, deleteTargetId)) {
        throw new Error(
          `restoring ${restoreTargetId} also took ${deleteTargetId} out of the bin: the restore ` +
            `acted on the bin rather than on the selected row.`,
        );
      }

      walkFinal = walkOf(db);
      // 11. Probe AFTER the mutations, against the walk the store now holds.
      //     Spaced from the walk at step 10 for the same reason that one is
      //     spaced: repeated AT-SPI clients a few hundred milliseconds apart
      //     are what makes this application exit.
      await Bun.sleep(PROBE_SETTLE_MS);
      postProbe = probeAtspi(rootPid);
      probes.push(compareProbe("after-mutations", postProbe, expectedRows(walkFinal)));
      }
      db.close();

      // No window manager under Xvfb: this raises BadDrawable and kills the
      // process rather than delivering a graceful close (hand-cli.ts records the
      // instrumentation that established it). The run needs the process gone
      // before the file is read; the debounce autosave is what put the prose in
      // the store, and DEBOUNCE_MS is 1000 against the settles above.
      //
      // TOLERANT OF THE SERVER BEING GONE, and only of that. The application
      // has been observed exiting after the final probe -- cleanly, taking
      // xvfb-run's X server with it, which makes this call fail with `Failed
      // creating new xdo instance`. Its whole purpose is to leave no process
      // holding the store, and a vanished server means there is none. Any other
      // xdotool failure still throws, because it means the close did not happen
      // and the file is about to be read from under a live writer.
      try {
        xdo(display, ["windowclose", wid]);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Failed creating new xdo instance")) throw error;
        console.log("  note: the X server was already gone at the close; the shell had exited.");
      }
      await Bun.sleep(3000);
    },
  });
}

let outcome: Awaited<ReturnType<typeof drive>>;
try {
  outcome = await drive("a");
  // The second window reads the file the first one left. Everything it needs
  // to find -- the created scene, the delete target -- it reads back out of the
  // store by id, which is what it already did within one window.
  console.log("\n[2b/4] interactive run, second window: delete and restore");
  await drive("b");
} catch (err: unknown) {
  cleanup();
  throw err;
}

if (outcome.payload.item_id === sceneX.id) {
  abort(
    `the page opened ${outcome.payload.item_id} at boot, which this rig chose as its click target: ` +
      `the first click would be a no-op switch and nothing would have been opened.`,
    cleanup,
  );
}

console.log(
  // Attempts counted, not hardcoded: the literal said 4 after the delete step
  // made it 5, so a run that LOST a mutation would have printed "4 landed of 4".
  `  mutations: ${mutations.length} landed of ${MUTATIONS_ATTEMPTED} attempted` +
    (mutationErrors.length > 0 ? `; ${mutationErrors.join("; ")}` : ""),
);
for (const m of mutations) {
  console.log(`    ${m.label} (${m.input}): ${m.ms.toFixed(1)} ms`);
}
for (const p of probes) {
  console.log(
    `  probe ${p.label}: ${p.probed_rows} rows, ${p.aligned_rows} aligned, ` +
      `${p.unattributable_rows} unattributable, ${p.level_mismatches} level / ` +
      `${p.setsize_mismatches} setsize / ${p.posinset_mismatches} posinset mismatch(es)`,
  );
}

console.log("\n[3/4] reading the file the killed process left behind");
const reopenedWalk = walkOnce(projectPath);
const reopenedBodies = bodiesOnce(projectPath);
const reopenedTitles = new Map(reopenedWalk.map((r) => [r.id, r.title]));

// Vacuity guards, before any gate is evaluated. Each of these would let the
// gates below pass against something nothing touched.
if (mutations.length === 0) {
  abort(
    `VACUITY GUARD: no mutation reached the store.\n  ${mutationErrors.join("\n  ")}\n` +
      "Every gate below would be asserting something about an untouched file, and " +
      "outline_mutation_p95_ms would be a percentile over zero samples.",
    cleanup,
  );
}
// The created row is what outline_created_scene_opens is about; with no id for
// it there is nothing to assert, and a FAIL would be reporting the rig.
if (createdId === null) {
  abort(
    "VACUITY GUARD: the run never identified the item the create added, so the created row was " +
      "never opened and outline_created_scene_opens would be FAILing the application for the " +
      "rig's own blindness.",
    cleanup,
  );
}
// A missed click is NOT this gate's FAIL. If the sentence meant for the created
// scene landed in some other document, the click went somewhere else and
// nothing here is about the created row; if it landed nowhere, the row was
// selected and never opened, which IS the defect and is graded below.
const strays = typedInto.filter((id) => id !== createdId);
if (strays.length > 0) {
  abort(
    `STRUCTURAL CHECK FAILED: the sentence typed after clicking the created row landed in ` +
      `${strays.join(", ")} rather than in ${createdId}. The click reached a different row, so ` +
      `outline_created_scene_opens would be reporting the rig's aim as an application defect.`,
    cleanup,
  );
}
if (walkFinal.length === 0) {
  abort(
    "VACUITY GUARD: no post-mutation walk was read, so there is no post-mutation shape to assert " +
      "anything about.",
    cleanup,
  );
}
const walkChanged = signatureOf(walkFinal) !== signatureOf(walk0);
if (!walkChanged) {
  abort(
    "VACUITY GUARD: the walk is identical before and after the mutation phase (same ids, parents, " +
      "titles and positions). The reopen gates would pass against a store the edits never reached.",
    cleanup,
  );
}
if (signatureOf(reopenedWalk) === signatureOf(walk0)) {
  abort(
    "VACUITY GUARD: the reopened walk is identical to the pre-mutation walk. Whatever the live " +
      "process showed, nothing durable changed, and outline_rename_persists and " +
      "outline_reorder_persists would be asserting against the seed.",
    cleanup,
  );
}
const probedRows = probes.reduce((a, p) => a + p.probed_rows, 0);
if (probedRows === 0 || postProbe.treeRows.length === 0) {
  abort(
    "VACUITY GUARD: no tree rows were probed after the mutations. a11y_tree_structure would " +
      "report UNKNOWN and the run would prove nothing about the accessibility contract.\n" +
      `  AT-SPI roles seen: ${Object.entries(postProbe.roleCounts ?? {})
        .map(([r, n]) => `${r} x${n}`)
        .join(", ")}`,
    cleanup,
  );
}
// The whole tiny projection fits the window, which is what lets a mounted-row
// count stand in for a projection row count in create_row_delta. If it ever
// stops holding, that metric silently becomes "rows the window happened to
// mount" and must not be graded.
if (probeBeforeCreate !== walk0.length) {
  abort(
    `VACUITY GUARD: the pre-create probe mounted ${probeBeforeCreate} of ${walk0.length} rows. ` +
      "create_row_delta reads mounted rows as the projection's row count, which is only true " +
      "while the whole projection fits the window.",
    cleanup,
  );
}

console.log("\n[4/4] reopen boot against the same project");
const reopen = await runShell<ReopenPayload>({
  mode: "virtual",
  soakMs: REOPEN_SOAK_MS,
  staged: DIST,
  env: {
    APP_PROJECT: projectPath,
    // write, not verify: the verify payload returns before the tree block is
    // built, so it carries no walk at all to compare against.
    APP_PERSIST_MODE: "write",
    APP_MUTATIONS: "0",
  },
  probeA11y: false,
});
const reopenRows = reopen.payload.tree.pre_mutation_rows;
const reopenOrdinal = reopenRows.find((r) => r.id === target.id)?.posinset ?? null;
const liveOrdinal = ordinalOf(walkFinal, target.id);

const sceneBody = reopenedBodies.get(sceneX.id) ?? "";
const createdBody = createdId === null ? "" : (reopenedBodies.get(createdId) ?? "");
// Keyboard only. See the Mutation type: a pointer-driven sample would report
// WebKitGTK's mouse-event delivery under the outline command's name. Every
// sample this rig can take is keyboard-driven since the outline bar was
// retired, so the filter selects all of them - it is kept because the rule is
// what matters, not the current count.
const graded = mutations.filter((m) => m.input === "keyboard");
const samples = graded.map((m) => m.ms).sort((a, b) => a - b);
const pick = (q: number): number =>
  Number((samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0).toFixed(3));

const metrics: OutlineMetrics = {
  create_row_delta: probeAfterCreate - probeBeforeCreate,
  create_title_in_walk: walkAfterCreate.some((r) => r.title === CREATED_TITLE),
  // The editor never reports which document it holds, so this is read from the
  // store: the sentence typed AFTER the create, with nothing clicked in between,
  // is in the CREATED item's body. Before 2026-09-01 this field asserted the
  // opposite (the sentence stayed in the previously open scene).
  create_opened_doc: createdBody.includes(SENTENCE_2),
  // Both halves, and both are needed. aria-current alone says the navigator
  // painted an attribute; the sentence alone would still be true if the row had
  // been open all along. Together they say a click on the new row opened it and
  // the writer could then type into it.
  created_scene_opens: createdBody.includes(SENTENCE_3),
  // Both read the REOPENED file, so both are claims about what survived a
  // restart rather than about what the page displayed before it.
  deleted_item_in_bin: deleteTargetId !== null && inBin(reopenedWalk, deleteTargetId),
  deleted_body_survives:
    deleteTargetId !== null &&
    (reopenedBodies.get(deleteTargetId) ?? "").includes(SENTENCE_4),
  restored_item_out_of_bin: restoreTargetId !== null && !inBin(reopenedWalk, restoreTargetId),
  restored_body_survives:
    restoreTargetId !== null &&
    (reopenedBodies.get(restoreTargetId) ?? "").includes(SENTENCE_5),
  restored_item_is_last_root:
    restoreTargetId !== null && lastManuscriptRootId(reopenedWalk) === restoreTargetId,
  bin_is_last_root: (() => {
    const bin = reopenedWalk.find((r) => r.parent_id === null && r.type === "trash");
    return bin !== undefined && isLastRoot(reopenedWalk, bin.id);
  })(),
  rename_title_persisted: reopenedTitles.get(target.id) === NEW_TITLE,
  reorder_position_match:
    reopenOrdinal !== null && liveOrdinal !== null && reopenOrdinal === liveOrdinal,
  undo_ordinal_before: undoOrdinalBefore,
  undo_ordinal_after_move: undoOrdinalAfterMove,
  undo_ordinal_after_undo: undoOrdinalAfterUndo,
  // The move has to have actually changed the ordinal, or a Ctrl+Z that does
  // nothing would still show "after" equal to "before" and PASS on a no-op.
  undo_restores_order:
    undoOrdinalBefore !== null &&
    undoOrdinalAfterMove !== null &&
    undoOrdinalAfterUndo !== null &&
    undoOrdinalAfterUndo === undoOrdinalBefore &&
    undoOrdinalAfterMove !== undoOrdinalBefore,
  document_intact: sceneBody.includes(SENTENCE_1),
  walk_changed: walkChanged,
  // The number of samples the percentiles below are over, which is what the
  // gate's zero-samples-is-UNKNOWN rule is about.
  mutations: graded.length,
  mutation_p50_ms: pick(0.5),
  mutation_p95_ms: pick(0.95),
};

// a11y_tree_structure only. The other three gates evaluateHierGates returns
// describe the hierarchy slice's own two-boot shape comparison and its in-page
// mutation timing, neither of which this run performs; reporting them here
// would put two differently-measured mutation percentiles in one result. The
// fields they read are filled from this run's real numbers anyway, so a future
// reader diffing the two functions finds no invented values.
const postSample = probes[probes.length - 1]!;
const hierMetrics: HierMetrics = {
  tree_shape_match: metrics.reorder_position_match,
  tree_changed: walkChanged,
  store_nodes: postSample.probed_rows,
  exposed_nodes: postSample.aligned_rows,
  level_mismatches: postSample.level_mismatches,
  setsize_mismatches: postSample.setsize_mismatches,
  probed_rows: postSample.probed_rows,
  mutations: metrics.mutations,
  mutation_errors: mutationErrors.length,
  mutation_p50_ms: metrics.mutation_p50_ms,
  mutation_p95_ms: metrics.mutation_p95_ms,
};
const A11Y_GATE = "a11y_tree_structure";
const verdicts: GateResult[] = [
  ...evaluateOutlineGates(metrics),
  ...evaluateHierGates(hierMetrics).filter((g) => g.gate === A11Y_GATE),
];

const path = writeResult(
  buildResult({
    workload: "app-outline",
    runId: "app-outline-tiny",
    candidate: "tauri",
    fixture: "tiny",
    verdicts,
    metrics: {
      workload_script: "outline-v1",
      peak_rss_mb: outcome.peakRssMb,
      startup_ms: outcome.payload.startup_ms,
      rows: outcome.payload.rows,
      opened_at_boot: outcome.payload.item_id,
      scene: sceneX.id,
      target: target.id,
      created_item: createdId,
      typed_into_while_opening_created_row: typedInto,
      target_type: target.type,
      seed_title: seedTitles.get(target.id),
      outline: metrics,
      mutation_errors: mutationErrors,
      mutation_samples_ms: mutations,
      graded_mutation_samples: graded.length,
      a11y_probes: probes,
      walk_nodes: {
        seeded: walk0.length,
        after_create: walkAfterCreate.length,
        final: walkFinal.length,
        reopened: reopenedWalk.length,
        reopen_boot_projection: reopenRows.length,
      },
      reorder: { live_ordinal: liveOrdinal, reopened_ordinal: reopenOrdinal },
      seeded_scene_body_bytes: (seedBodies.get(sceneX.id) ?? "").length,
      reopen_peak_rss_mb: reopen.peakRssMb,
      omitted_gates: [
        {
          gate: "a11y_exposure",
          reason:
            "flat-list concept: it reads the single consistent aria-setsize the rows advertise, " +
            "else 0. A tree advertises per-sibling-group setsize, so it collapses to 0 and would " +
            "contradict a11y_tree_structure on the same dump. Superseded by a11y_tree_structure.",
        },
        {
          gate: "latency, stall, cliff, peak RSS trend",
          reason:
            "the run is a couple of minutes of real input, not a soak; it " +
            "has nothing true to say about frame cadence or a leak slope.",
        },
      ],
      scope: {
        input:
          "Real X input throughout: xdotool right-clicks on the shipped navigator rows to open " +
          "the shipped context menu, left-clicks to open documents, and xdotool keystrokes to " +
          "drive both the menu and the shipped rename panel. The outline bar this rig used to " +
          "click is retired. The page's own JavaScript is never called, and app/ui/src/project.ts's " +
          "exported outline unit is never touched. The two context-menu item indices are PARSED " +
          "from nav-context-menu.ts, never restated.",
        atspi_probe_spacing:
          "The three accessibility probes are seconds apart, and that is a constraint rather " +
          "than a choice. Measured on this rig: repeated pyatspi clients a few hundred " +
          "milliseconds apart wedge the WebKitGTK bridge - the application stops appearing in " +
          "the AT-SPI desktop list entirely and does NOT come back, through further input or " +
          "20 s of waiting. Reproduced on the build before this slice's fixes as well, so it is " +
          "not a regression, and it is why per-click verification here reads the store rather " +
          "than the accessibility tree.",
        row_geometry:
          "Row coordinates are the pane's MEASURED top plus the store walk's index times " +
          "ROW_HEIGHT. The pane's box is read from #nav's own `tree` node in the accessibility " +
          "tree, which states the top edge and the height exactly. It is NOT read from the " +
          "editable, which this rig did until the outline bar was retired: #editor carries 24px " +
          "of padding and both panes are now grid-row 2, so the editable's y is the pane top plus " +
          "one whole ROW_HEIGHT - every click would have landed on the row below, silently, " +
          "reporting a plausible number. Measured at this commit: pane 38, editable 62. Every " +
          "computed y is also refused if it falls off the X screen, because X clamps the pointer " +
          "there rather than erroring.",
        create_row_delta:
          "Mounted AT-SPI tree rows before and after the create. At the tiny fixture the whole " +
          `projection (${walk0.length} rows) fits the ${WINDOW_HEIGHT}px window, so mounted == ` +
          "projected; the run aborts if the pre-create probe does not mount every row, because " +
          "the metric would otherwise be counting the window rather than the projection.",
        create_opened_doc:
          "Nothing reports which document the editor holds. Read instead as: the sentence typed " +
          "AFTER the create, with nothing clicked in between, is in the CREATED item's body. A " +
          "create that only selected its row (the pre-2026-09-01 behaviour) leaves that sentence " +
          "in the previously open scene; a rebuilt page reopens the boot-time document and puts it " +
          "there. Either reads as FAIL.",
        mutation_latency:
          "Measured from the input event returning to the store file showing the change, polled " +
          `every ${POLL_MS} ms against a second read-only connection. It therefore INCLUDES X ` +
          "event delivery and the page's handler, and EXCLUDES the walk re-read and reprojection " +
          "that follow the command - the gate's threshold text names the whole round trip, and " +
          "no external observer can see its tail at this resolution (an AT-SPI probe costs " +
          "hundreds of milliseconds). The hierarchy run's in-page mutation_p95_ms is the " +
          "comparable number for the command itself. Three graded samples, so p50 and p95 are " +
          "order statistics over three values, not percentiles.",
        mutation_latency_input_class:
          "EVERY SAMPLE IS KEYBOARD-DRIVEN, and the comparison that used to sit beside them is " +
          "GONE rather than re-measured. Against the retired outline bar, the same item_create " +
          "measured 103.1/103.2/103.2/103.4/103.6 ms when a mouse click activated the button and " +
          "16.3/16.6 ms when Return activated the same focused button - about 87 ms of " +
          "WebKitGTK pointer-event delivery under Xvfb, not the outline command. The routes that " +
          "replaced the bar reach every operation through a context menu whose items are stepped " +
          "onto with ArrowDown and run with Return, so the mutation is always a keystroke; timing " +
          "a pointer-driven one would mean clicking a menu item, whose coordinates cost an AT-SPI " +
          "walk this rig has no room for. The pointer figure is unchanged by this slice and " +
          "stands in the superseded results. Whether a real writer on a real compositor pays that " +
          "87 ms is UNMEASURED and worth measuring - Xvfb has no compositor, and every latency " +
          "number this project has recorded headless has needed that caveat. NOTE that the " +
          "percentile now spans FIVE samples where it spanned THREE: the delete and the restore " +
          "were pointer-driven against the bar and are keyboard-driven against the menu, so a " +
          "figure moving against the superseded copy is the input class changing, not the " +
          "command.",
        mutation_latency_on_a_real_desktop:
          "UNMEASURED, and it cannot be settled by another headless run. Xvfb has no compositor, " +
          "and this project has already measured the rig distorting input cost in the other " +
          "direction - a keystroke's dispatch cost is understated about 6x headless (2-3 ms) " +
          "against XWayland (8 ms) and Wayland native (12 ms). Whether a writer clicking \"New " +
          "scene\" on a real desktop pays the ~87 ms this rig attributes to Xvfb's pointer path, " +
          "pays more, or pays almost none of it, needs a live-session run (the APP_SESSION=1 " +
          "path in shell.ts, which samples logind idle, DPMS and workspace visibility so a " +
          "blanked screen cannot be mistaken for the app). Until then no claim about pointer " +
          "latency in this result describes the product.",
        created_scene_opens:
          "The created row is clicked and a sentence is typed; the gate is whether that " +
          "sentence is under the CREATED item's id in the reopened file. Three outcomes, and " +
          "the rig separates all three from the store alone: in the created scene is a PASS; in " +
          "another document means the click landed elsewhere and the run ABORTS rather than " +
          "blame the application for the rig's aim; in no document at all is the FAIL, because " +
          "a selected row that never opened leaves focus on the navigator and the keystrokes " +
          "are swallowed as type-ahead - which is why that sentence carries no spaces, Space " +
          "being activation rather than type-ahead in the navigator's keymap. Every other row click in this run is verified the same " +
          "way, by its effect on the store - the opening click by the sentence that follows it, " +
          "the rename by which item carries the new title, the reorder by which item's position " +
          "changed. The reorder guard is the load-bearing one: a missed click there moves some " +
          "other row, the target's own ordinal is then unchanged both before the kill and after " +
          "the reopen, and outline_reorder_persists passes having tested nothing.",
        create_gate_sequence:
          "outline_create_visible and outline_created_scene_opens are two instants of one " +
          "sequence: click New scene -> measure the row delta, the title and that the CREATED " +
          "item now holds what is typed next -> type into it -> click the created row -> type " +
          "again. The click is the opener's 'same' outcome and must keep the writer in the row.",
        rename_and_reorder:
          "Both read from the file the killed process left behind, so they say the edit reached " +
          "the store and survived the kill, not merely that the screen redrew. " +
          "reorder_position_match compares the ordinal the store held before the kill against " +
          "the reopen boot's OWN projection of the same file, which is a second process's " +
          "derivation rather than a second read of the first's. Between the first Alt+Down and " +
          "the kill, this run also presses Ctrl+Z (the navigator's own undo, structural undo/redo " +
          "on the outline tree) and reads outline_undo_restores_order from the ordinal that comes " +
          "back, live, in the same process - a claim about the session, not about what survives a " +
          "restart. It then presses Alt+Down a SECOND time so the row is displaced again " +
          "regardless of whether the undo worked, which is what lets outline_reorder_persists " +
          "keep comparing 'the ordinal the store held before the kill' against the reopened file " +
          "unaffected by the new step in between.",
        reopen_boot:
          "APP_PERSIST_MODE=write with APP_MUTATIONS=0, because the verify payload returns before " +
          "the tree block is built and carries no walk. Its 1 s soak types into whichever scene " +
          "it opens, which is why every title and body above is read from the file BEFORE this " +
          "boot runs.",
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
