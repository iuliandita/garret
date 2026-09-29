// app/harness/src/context-cli.ts
// Graded navigator-context-menu run. SIX boots, at most TWO AT-SPI walks each.
//
// The context menu shipped with unit tests and no graded evidence, and its
// headline claim is one no unit test can reach: that the row the writer
// right-clicked is the row the menu acts on. That is a defect that shipped
// once exactly (quick open marked a scene open without moving the selection, so
// Outline > Delete binned the scene the writer had LEFT), with a better
// disguise, because the row under the pointer LOOKS selected. So the gate for it
// is graded BY EFFECT: right-click a row that is not the boot selection, run
// Delete, and read the bin out of SQLite. Asking the page which row its menu is
// about is asking the defect whether it is present.
//
// THE WALK BUDGET DECIDES THE SHAPE, as it did for `menu-cli`. Several AT-SPI
// walks in one window kill the application outright -- cleanly, nothing on
// stderr, taking xvfb-run's server with it. The naive rig opens the menu five
// times and walks either side of each. So every claim that keystrokes can drive
// and the store can verify spends ZERO walks, and a walk is spent only where the
// claim is genuinely about the accessibility tree. Two per boot, never more.
//
// The probe is this rig's OWN unfiltered walk rather than `nodes.ts`'s
// `locateNodes`, for the reason `menu-cli` carries one: that filter's WANTED set
// was chosen for buttons and list rows, and what this panel maps to is part of
// what the run is measuring. A filter built from an answer cannot be used to ask
// the question, and widening the shared one grows the walk of every rig on it.
//
// Usage: APP_GUI=1 bun app/harness/src/context-cli.ts
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { expectedPlacement, landedAsExpected } from "./context-placement";
import { type ContextMetrics, evaluateContextGates } from "./gates";
import { navContextIndex } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import {
  BIN,
  SHELL_WINDOW_CLASS_PATTERN,
  findWindowId,
  runShell,
  survivingShellPids,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** The panel's id, restated from `nav-context-menu.ts`. Every item's id is
 *  under the same prefix, so the panel has to be named to be excluded. */
const PANEL_ID = "nav-context-menu";
const ITEM_PREFIX = "nav-context-";
const REMOVE_ID = "nav-context-remove";
const NEW_SCENE_ID = "nav-context-new-scene";

/** Deliberately restated from `store::TRASH_TYPE` / `outline.ts`. */
const TRASH_TYPE = "trash";

/** The navigator's row pitch and column width, restated from `style.css` and
 *  `project.ts`. The pane TOP is MEASURED rather than restated: a box is not the
 *  sum of its content heights, and an 11px error there is invisible on a low row
 *  and lands on the NEXT row further down. */
const ROW_HEIGHT = 24;
const NAV_WIDTH = 320;

/** The binned-row boot needs a taller window AND a taller screen, for the
 *  structural reason `menu-cli` records: a removed row moves to the END of the
 *  walk, because the Trash root is the last root. The pointer is CLAMPED to the
 *  X screen, so a window taller than the screen buys nothing. */
const TALL_SERVER_ARGS = "-screen 0 1600x1200x24 -s 0 -noreset";
const TALL_W = 1400;
const TALL_H = 1150;

/** xdotool returns when X has the events, not when WebKitGTK has acted on
 *  them. */
const SETTLE_MS = 2500;
const MENU_OPEN_MS = 700;
const KEY_STEP_MS = 120;
const MAX_DEPTH = 64;

const root = mkdtempSync(join(tmpdir(), "app-context-"));

function fail(why: string): never {
  console.error(`${why}; nothing was written.`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
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

/** Every visible X window carrying the shell's WM_CLASS.
 *
 *  `findWindowId` refuses anything but exactly one and is therefore useless for
 *  counting; this is the same search without the guard. A GTK popup inherits the
 *  application's class -- measured for the export dialog, which takes the count
 *  to 2 -- so a right-click that raises the engine's own menu should show up
 *  here. Returns ids rather than a number so the caller can name what appeared.
 *
 *  NO exit-code check: `xdotool search` exits non-zero when nothing matches,
 *  which is an answer rather than an error. */
function visibleShellWindows(display: string): string[] {
  const proc = Bun.spawnSync(
    ["xdotool", "search", "--onlyvisible", "--class", SHELL_WINDOW_CLASS_PATTERN],
    { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" },
  );
  return proc.stdout.toString().trim().split("\n").filter(Boolean);
}

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------
export const PY_ALL = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

def walk(node, out):
    try:
        role = node.getRoleName()
        ident = ""
        try:
            for pair in node.getAttributes():
                if pair.startswith("id:"):
                    ident = pair[3:]
        except Exception:
            pass
        x = y = w = h = -1
        try:
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            x, y, w, h = e.x, e.y, e.width, e.height
        except Exception:
            pass
        out.append("\t".join([role, ident, node.name or "", str(x), str(y), str(w), str(h)]))
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

interface AnyNode {
  role: string;
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function walkAll(rootPid: number): AnyNode[] {
  const proc = Bun.spawnSync(["python3", "-c", PY_ALL, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    // "not exactly one matching application" and "the bridge wedged" are
    // different problems with different owners; the surviving pid count is the
    // one line that tells them apart.
    const alive = survivingShellPids();
    throw new Error(
      `could not walk the accessibility tree (exit ${proc.exitCode}; ` +
        `${alive.length} shell process(es) alive): ${proc.stderr.toString().trim()}`,
    );
  }
  const out: AnyNode[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    const [role = "", id = "", name = "", x = "", y = "", w = "", h = ""] = line.split("\t");
    if (role.length === 0) continue;
    out.push({ role, id, name, x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
  }
  return out;
}

/** The context menu's ITEMS: everything under the panel's id prefix except the
 *  panel itself, which is written the same way and is not an item. */
function contextItems(nodes: readonly AnyNode[]): AnyNode[] {
  return nodes.filter((n) => n.id.startsWith(ITEM_PREFIX) && n.id !== PANEL_ID);
}

function roleOf(nodes: readonly AnyNode[], id: string): string {
  return nodes.find((n) => n.id === id)?.role ?? "not exposed";
}

/** The navigator row carrying a given title, located in the tree the page has
 *  actually PAINTED.
 *
 *  Deliberately not arithmetic off the store's walk index. A removed row moves
 *  under the Trash root, and the navigator projects only rows whose ancestors
 *  are EXPANDED -- so a store index and a visible index diverge the moment a
 *  branch is collapsed, and a click computed from the former lands past the end
 *  of the list, changes no selection, and leaves the menu correctly reporting
 *  the row that was already selected. That is indistinguishable from the defect
 *  this rig exists to catch.
 *
 *  The ORACLE is still the store: this only decides where to press. */
function rowNamed(nodes: readonly AnyNode[], title: string): AnyNode {
  const rows = nodes.filter((n) => n.id.startsWith("nav-row-") && n.name.trim() === title.trim());
  if (rows.length === 0) {
    const painted = nodes.filter((n) => n.id.startsWith("nav-row-")).length;
    throw new Error(
      `no navigator row is painted with the title ${JSON.stringify(title)} (${painted} row(s) in the tree); ` +
        `the branch holding it is collapsed, or the row is scrolled out of the virtual list`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} navigator rows share the title ${JSON.stringify(title)}, so a click cannot be attributed`,
    );
  }
  return rows[0] as AnyNode;
}

/** The EDITABLE's top edge, measured, and used only to pick a point inside
 *  `#editor` to right-click.
 *
 *  Deliberately not called the pane's top: `#editor` carries 24px of padding, so
 *  the editable starts one ROW_HEIGHT below the edge `#nav` shares with it. That
 *  does not matter here - anything inside the editor will do - and it matters
 *  enormously to a rig computing navigator row coordinates, which is why
 *  `outline-cli` reads #nav's own box instead. */
function editableTop(nodes: readonly AnyNode[]): number {
  const editable = nodes.find((n) => (n.role === "entry" || n.role === "text") && n.h > 0);
  if (editable === undefined) {
    // THROWS rather than calling `fail`: this runs inside `onReady`, and a
    // process.exit from there skips runShell's kill-and-reap entirely. The
    // surviving shell would poison the NEXT boot's walk, which refuses any tree
    // it cannot attribute to exactly one application -- so an abort here would
    // present as a bridge failure two boots later.
    throw new Error(
      `no editable in the accessibility tree; saw roles: ${[...new Set(nodes.map((n) => n.role))].join(", ")}`,
    );
  }
  return editable.y;
}

// ---------------------------------------------------------------------------
// The oracle: the store, read directly.
// ---------------------------------------------------------------------------
interface WalkRow {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  /** The store's fractional-index key: TEXT, sorted as a string -- see
   *  context-placement.ts's PlacedRow, which this shape matches. */
  position: string;
}

function storeWalk(projectPath: string): WalkRow[] {
  const db = new Database(projectPath, { readonly: true });
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
         SELECT id, parent_id, type, title, position FROM walk ORDER BY path`,
      )
      .all() as WalkRow[];
  } finally {
    db.close();
  }
}

/** The store's own answer to "is this row in the bin", walked upward from the
 *  row rather than asked of the page. */
function trashedInStore(rows: readonly WalkRow[], id: string): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let cursor = byId.get(id);
  let hops = 0;
  while (cursor !== undefined && hops < MAX_DEPTH) {
    if (cursor.type === TRASH_TYPE) return true;
    if (cursor.parent_id === null) return false;
    cursor = byId.get(cursor.parent_id);
    hops += 1;
  }
  return false;
}

/** Every row the store has in the bin, the bin's own root excluded. */
function binnedIn(rows: readonly WalkRow[]): string[] {
  return rows.filter((r) => r.type !== TRASH_TYPE && trashedInStore(rows, r.id)).map((r) => r.id);
}

function seed(label: string): string {
  const path = join(root, `${label}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, path], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) fail(`seeding ${label} failed (exit ${seeded.exitCode})`);
  return path;
}

function homeFor(label: string): string {
  const dir = join(root, `home-${label}`);
  mkdirSync(join(dir, "cc.local.app"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// The boot wrapper.
// ---------------------------------------------------------------------------
interface BootContext {
  display: string;
  wid: string;
  walk: () => AnyNode[];
  key: (chord: string) => void;
  /** Left-click, for moving the selection. */
  clickAt: (x: number, y: number) => void;
  /** Right-click: the whole subject of this rig. */
  rightClickAt: (x: number, y: number) => void;
  /** Step down to `index` in an already-open context menu and press Return. */
  activateOpenItem: (index: number) => Promise<void>;
  centreOf: (row: AnyNode) => { x: number; y: number };
}

interface BootOptions {
  label: string;
  projectPath: string;
  dataHome: string;
  tall?: boolean;
  drive: (ctx: BootContext) => Promise<void>;
}

async function boot(options: BootOptions): Promise<number> {
  const outcome = await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: options.projectPath,
      XDG_DATA_HOME: options.dataHome,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    serverArgs: options.tall === true ? TALL_SERVER_ARGS : undefined,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("the context rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      await Bun.sleep(SETTLE_MS);
      if (options.tall === true) {
        xdo(display, ["windowsize", wid, String(TALL_W), String(TALL_H)]);
        await Bun.sleep(1500);
        // Verified rather than assumed: a resize that silently did not take
        // leaves every row coordinate below the fold, and the click would land
        // somewhere else and still report success.
        const geometry = xdo(display, ["getwindowgeometry", wid]);
        const seen = /Geometry: (\d+)x(\d+)/.exec(geometry);
        if (seen === null || Number(seen[2]) < TALL_H - 40) {
          throw new Error(
            `the window did not take the resize to ${TALL_W}x${TALL_H}: ${geometry.trim()}`,
          );
        }
      }
      // A key or click send not preceded by this guard has no evidence behind
      // it: an unfocused window swallows the chord, which reads exactly like the
      // page ignoring it.
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(`focus is on window ${focused}, not the shell's ${wid}; refusing to drive`);
      }
      const key = (chord: string): void => {
        xdo(display, ["key", "--window", wid, chord]);
      };
      // `mousemove --window` is window-relative and lands the pointer; the click
      // that follows is deliberately NOT `--window`. With the flag, xdotool
      // sends a synthetic button event through XSendEvent, which GTK and WebKit
      // discard as untrusted -- no error, no effect, and a selection that never
      // moves while every call reports success. Bare `click` drives XTEST, which
      // is a real pointer event. This is `outline-cli`'s mechanism, copied
      // verbatim rather than reinvented.
      const press = (x: number, y: number, button: string): void => {
        xdo(display, ["mousemove", "--window", wid, String(x), String(y)]);
        xdo(display, ["click", button]);
      };
      const ctx: BootContext = {
        display,
        wid,
        walk: () => walkAll(rootPid),
        key,
        clickAt: (x, y) => press(x, y, "1"),
        rightClickAt: (x, y) => press(x, y, "3"),
        activateOpenItem: async (index) => {
          for (let i = 0; i < index; i++) {
            key("Down");
            await Bun.sleep(KEY_STEP_MS);
          }
          key("Return");
          await Bun.sleep(SETTLE_MS);
        },
        centreOf: (row) => ({
          x: Math.round(row.x + row.w / 2),
          y: Math.round(row.y + row.h / 2),
        }),
      };
      await options.drive(ctx);
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(1500);
    },
  });
  return outcome.peakRssMb;
}

async function main(): Promise<void> {
  if (process.env.APP_GUI !== "1") {
    console.log("context-cli: APP_GUI is not 1; skipping (this rig needs a real shell window).");
    return;
  }
  const peaks: number[] = [];

  // The two indices come from the SOURCE, never from a literal here. A rig
  // holding `REMOVE_INDEX = 4` is correct right up until an item is inserted
  // above it, and then it presses Return on the item above the one it named and
  // reports whatever that item did. Both are computed against "scene" because
  // every use below opens the menu on `target`, which is always a scene.
  const removeIndex = navContextIndex(REMOVE_ID, "scene");
  const newSceneIndex = navContextIndex(NEW_SCENE_ID, "scene");

  // -- The target row, chosen from the store ---------------------------------
  // THE SECOND scene, never the first, and that is the difference between a
  // guard and a decoration. The application opens the first scene at boot, so it
  // is already the selection -- targeting it makes every claim below true of the
  // resting state, and the "the row that went into the bin is the row we
  // right-clicked" check passes having tested nothing.
  const reference = storeWalk(seed("reference"));
  const scenes = reference.filter((r) => r.type === "scene");
  const bootSelection = scenes[0];
  const target = scenes[1];
  if (bootSelection === undefined || target === undefined) {
    fail("the fixture holds fewer than two scenes, so no right-click can differ from the selection");
  }
  if (target.title.trim() === bootSelection.title.trim()) {
    fail("the first two scenes share a title, so the clicked row cannot be told from the selection");
  }
  for (const row of [bootSelection, target]) {
    if (reference.filter((r) => r.title.trim() === row.title.trim()).length !== 1) {
      fail(`the title ${JSON.stringify(row.title)} is not unique in the walk`);
    }
  }
  const targetIndex = reference.indexOf(target);
  if (targetIndex >= 24) {
    fail(`the second scene sits at walk index ${targetIndex}, too far down the pane to click`);
  }

  const captured: {
    baseline: AnyNode[] | null;
    open: AnyNode[] | null;
    labelLive: string | null;
    labelTrashed: string | null;
    keyboardOpen: AnyNode[] | null;
    afterEscape: AnyNode[] | null;
    windowsBefore: number;
    windowsAfter: number;
    editorWindowNames: string[];
  } = {
    baseline: null,
    open: null,
    labelLive: null,
    labelTrashed: null,
    keyboardOpen: null,
    afterEscape: null,
    windowsBefore: -1,
    windowsAfter: -1,
    editorWindowNames: [],
  };

  // -- Boot 1: does a right-click expose anything, and does #editor keep its
  //            own menu? ------------------------------------------------------
  // The CLOSED walk comes FIRST, and that ordering is the gate. Walking open
  // then closed would pass on a page that painted its items at boot and merely
  // cleared them afterwards.
  console.log("[1/6] expose");
  peaks.push(
    await boot({
      label: "expose",
      projectPath: seed("expose"),
      dataHome: homeFor("expose"),
      drive: async (ctx) => {
        const walked = ctx.walk();
        captured.baseline = walked;
        const row = rowNamed(walked, target.title);
        const at = ctx.centreOf(row);
        ctx.rightClickAt(at.x, at.y);
        await Bun.sleep(MENU_OPEN_MS);
        captured.open = ctx.walk();

        // -- the editor's own menu, with no walk at all ---------------------
        // Dismiss ours first, or the two menus are one picture.
        ctx.key("Escape");
        await Bun.sleep(MENU_OPEN_MS);
        // A point inside #editor: the navigator column is NAV_WIDTH wide and the
        // pane's top edge was measured from the baseline walk. Deliberately NOT
        // the editable's own extents -- AT-SPI reports LAYOUT extents, and a
        // document longer than the pane puts its centre outside the window,
        // where X clamps the pointer rather than erroring.
        const editorX = NAV_WIDTH + 200;
        const editorY = editableTop(walked) + 4 * ROW_HEIGHT;
        captured.windowsBefore = visibleShellWindows(ctx.display).length;
        ctx.rightClickAt(editorX, editorY);
        await Bun.sleep(MENU_OPEN_MS * 2);
        const after = visibleShellWindows(ctx.display);
        captured.windowsAfter = after.length;
        // NAME AND SIZE, because the name alone cannot settle it. GTK publishes
        // a group-leader window named after the BINARY, and the recorded note
        // says it is a 10x10 unmapped one -- so an extra window called
        // "app-shell-tauri" is exactly what a leader that had somehow become
        // visible would look like. A menu-sized box is not.
        captured.editorWindowNames = after.map((id) => {
          try {
            const name = xdo(ctx.display, ["getwindowname", id]);
            const geometry = xdo(ctx.display, ["getwindowgeometry", id]);
            const seen = /Geometry: (\d+x\d+)/.exec(geometry);
            return `${name} @ ${seen?.[1] ?? "?"}`;
          } catch {
            return "(unreadable)";
          }
        });
        ctx.key("Escape");
        await Bun.sleep(MENU_OPEN_MS);
      },
    }),
  );
  const baseline = captured.baseline ?? fail("boot 1 produced no closed walk");
  const openWalk = captured.open ?? fail("boot 1 produced no open walk");
  const openItems = contextItems(openWalk);
  if (openItems.length === 0) {
    fail(
      "the walk taken after right-clicking a navigator row exposed no context-menu items at all, " +
        "so nothing about this surface can be graded",
    );
  }

  // -- Boot 2: the captured row, graded by effect, and the live label --------
  console.log("[2/6] the clicked row is the acted-on row");
  const removeProject = seed("remove");
  const removeHome = homeFor("remove");
  if (binnedIn(storeWalk(removeProject)).length !== 0) {
    fail("the freshly seeded project already holds a binned row, so a delete cannot be attributed");
  }
  peaks.push(
    await boot({
      label: "remove",
      projectPath: removeProject,
      dataHome: removeHome,
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        const at = ctx.centreOf(row);
        ctx.rightClickAt(at.x, at.y);
        await Bun.sleep(MENU_OPEN_MS);
        // The label is read from the SAME open menu the removal then runs from,
        // so the item graded and the item read are the same paint.
        captured.labelLive = ctx.walk().find((n) => n.id === REMOVE_ID)?.name ?? null;
        await ctx.activateOpenItem(removeIndex);
      },
    }),
  );
  const liveLabel =
    captured.labelLive ?? fail("the context menu exposed no removal item on the live row");
  const afterRemove = storeWalk(removeProject);
  const binned = binnedIn(afterRemove);
  if (binned.length === 0) {
    fail(
      "nothing reached the bin, so the removal item never ran and the Restore half has no subject",
    );
  }
  const trashedIndex = afterRemove.findIndex((r) => r.id === target.id);
  if (trashedIndex < 0) fail("the removed row left the store's walk entirely");
  // What the TALL window can reach, computed from the same two constants the
  // click uses rather than restated as a third number.
  const reachableRows = Math.floor((TALL_H - 80) / ROW_HEIGHT);
  if (trashedIndex >= reachableRows) {
    fail(
      `the binned row sits at index ${trashedIndex}, past the ${reachableRows} rows a ${TALL_H}px ` +
        `window can show; it could not be right-clicked without scrolling`,
    );
  }

  // -- Boot 3: the label on a binned row ------------------------------------
  console.log("[3/6] the label on a binned row");
  peaks.push(
    await boot({
      label: "restore-label",
      projectPath: removeProject,
      dataHome: removeHome,
      tall: true,
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        const at = ctx.centreOf(row);
        ctx.rightClickAt(at.x, at.y);
        await Bun.sleep(MENU_OPEN_MS);
        captured.labelTrashed = ctx.walk().find((n) => n.id === REMOVE_ID)?.name ?? null;
      },
    }),
  );
  const trashedLabel =
    captured.labelTrashed ?? fail("the context menu exposed no removal item on the binned row");

  // -- Boot 4: a create lands where placement type-awareness puts it --------
  console.log("[4/6] create where placement type-awareness puts it");
  const createProject = seed("create");
  const rowsBeforeCreate = storeWalk(createProject);
  // Placement is type-aware; this is the rig's restatement of that rule
  // (context-placement.ts), computed BEFORE the create runs so the fixture's
  // tree, not the create's own effect, decides the expectation. The fixture
  // clicks a scene under a chapter, so the "build a missing container" arm is
  // out of scope here: ABORT rather than grade a case never staged.
  const expected =
    expectedPlacement(rowsBeforeCreate, target.id, "scene") ??
    fail(
      `027's rule has no answer for a scene from row ${target.id}: no chapter-or-part ` +
        "ancestor-or-self, so the fixture never staged this arm",
    );
  peaks.push(
    await boot({
      label: "create",
      projectPath: createProject,
      dataHome: homeFor("create"),
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        const at = ctx.centreOf(row);
        ctx.rightClickAt(at.x, at.y);
        await Bun.sleep(MENU_OPEN_MS);
        await ctx.activateOpenItem(newSceneIndex);
      },
    }),
  );
  const rowsAfterCreate = storeWalk(createProject);
  if (rowsAfterCreate.length === rowsBeforeCreate.length) {
    fail("the store's walk did not change after the create item ran, so nothing was created");
  }
  const beforeIds = new Set(rowsBeforeCreate.map((r) => r.id));
  const created = rowsAfterCreate.find((r) => !beforeIds.has(r.id)) ?? null;

  // -- Boots 5 and 6: the keyboard route ------------------------------------
  // Two boots rather than one because the open walk and the post-Escape walk
  // would be the second and third of the same window, and the third is where the
  // application dies.
  //
  // CLICK, THEN Shift+Tab, THEN the chord -- and the middle step is a finding
  // rather than a flourish. A click on a navigator row NEVER focuses #nav: it
  // activates the row, and activating a scene focuses the EDITOR. So the rig's
  // first attempt clicked a row and sent Shift+F10 into the prose, got nothing,
  // and reported `context_keyboard_opens` FAIL against an application that binds
  // the chord perfectly. #nav is the tab stop immediately before #editor, so one
  // Shift+Tab lands on the tree with the clicked row still selected - and it
  // still is now that the outline bar between them has been retired, because the
  // bar was never a tab stop of its own that mattered here. Measured against the
  // `Menu` key too: both routes expose the same six items.
  //
  // The click is not part of the claim -- the claim is that the chord opens the
  // menu on the FOCUSED row -- it only decides which row that is.
  console.log("[5/6] Shift+F10 opens it");
  peaks.push(
    await boot({
      label: "keyboard",
      projectPath: seed("keyboard"),
      dataHome: homeFor("keyboard"),
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        const at = ctx.centreOf(row);
        ctx.clickAt(at.x, at.y);
        await Bun.sleep(MENU_OPEN_MS);
        ctx.key("shift+Tab");
        await Bun.sleep(KEY_STEP_MS * 3);
        ctx.key("shift+F10");
        await Bun.sleep(MENU_OPEN_MS);
        captured.keyboardOpen = ctx.walk();
      },
    }),
  );

  console.log("[6/6] Escape closes it");
  peaks.push(
    await boot({
      label: "escape",
      projectPath: seed("escape"),
      dataHome: homeFor("escape"),
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        const at = ctx.centreOf(row);
        ctx.clickAt(at.x, at.y);
        await Bun.sleep(MENU_OPEN_MS);
        ctx.key("shift+Tab");
        await Bun.sleep(KEY_STEP_MS * 3);
        ctx.key("shift+F10");
        await Bun.sleep(MENU_OPEN_MS);
        ctx.key("Escape");
        await Bun.sleep(MENU_OPEN_MS);
        captured.afterEscape = ctx.walk();
      },
    }),
  );
  const keyboardOpen = captured.keyboardOpen ?? fail("boot 5 produced no walk");
  const afterEscape = captured.afterEscape ?? fail("boot 6 produced no walk");

  const metrics: ContextMetrics = {
    baseline_item_nodes: contextItems(baseline).length,
    open_item_nodes: openItems.length,
    open_item_names: openItems.map((n) => n.name),
    unnamed_item_nodes: openItems.filter((n) => n.name.trim().length === 0).length,
    panel_role: roleOf(openWalk, PANEL_ID),
    item_role: openItems[0]?.role ?? "not exposed",
    boot_selection_title: bootSelection.title,
    clicked_row_title: target.title,
    clicked_row_id: target.id,
    binned_row_ids: binned,
    create_clicked_row_id: target.id,
    created_row_id: created?.id ?? null,
    created_row_parent_id: created?.parent_id ?? null,
    created_row_type: created?.type ?? null,
    expected_parent_id: expected.parentId,
    expected_after_id: expected.afterId,
    created_row_landed_as_expected:
      created !== null && landedAsExpected(rowsAfterCreate, created, expected),
    store_rows_before_create: rowsBeforeCreate.length,
    store_rows_after_create: rowsAfterCreate.length,
    label_when_live: liveLabel,
    label_when_trashed: trashedLabel,
    live_row_trashed_in_store: trashedInStore(reference, target.id),
    trashed_row_trashed_in_store: trashedInStore(afterRemove, target.id),
    keyboard_item_nodes: contextItems(keyboardOpen).length,
    items_after_escape: contextItems(afterEscape).length,
    editor_windows_before: captured.windowsBefore,
    editor_windows_after: captured.windowsAfter,
    peak_rss_mb: Math.max(...peaks),
  };

  const verdicts = evaluateContextGates(metrics);
  const written = writeResult(
    buildResult({
      runId: "app-context-tiny",
      candidate: "tauri",
      fixture: "tiny",
      workload: "app-context",
      verdicts,
      metrics: {
        ...metrics,
        editor_menu_windows: captured.editorWindowNames,
        scope:
          "Six boots, two AT-SPI walks maximum each. Every figure about the store is SQLite read " +
          "directly with bun:sqlite. The menu is opened with a real XTEST right-click and driven " +
          "with keystrokes; the two item indices come from nav-context-menu.ts, parsed, never " +
          "restated. The target row is the SECOND scene, so it is never the boot selection.",
        omitted_gates:
          "no latency, stall, cliff or a11y_exposure figures: a run that opens a menu six times " +
          "and types nothing has nothing true to say about frame cadence, and row exposure is the " +
          "hierarchy rig's claim. context_items_named RECORDS the ATK roles " +
          "rather than asserting them - there is no prior measurement of this panel's mapping to " +
          "assert against - and asserts instead the thing a collapsed role costs: an item exposed " +
          "under a role that carries no name.",
      },
      seed: "n/a",
      rigCommit: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim(),
      environment: captureEnv(),
    }),
    RESULTS,
  );

  for (const v of verdicts) console.log(`${v.verdict.padEnd(7)} ${v.gate}: ${v.value}`);
  console.log(
    `\neditor right-click: ${metrics.editor_windows_before} -> ${metrics.editor_windows_after} ` +
      `visible window(s) [${captured.editorWindowNames.join(" | ")}]`,
  );
  console.log(`wrote ${written}`);
  rmSync(root, { recursive: true, force: true });
  if (verdicts.some((v) => v.verdict === "FAIL")) process.exitCode = 1;
}

await main();
