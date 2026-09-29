// app/harness/src/menu-cli.ts
// Graded application-menu run. SIX boots.
//
// The menu shipped with no graded evidence at all, and the retirement change
// that follows makes it the ONLY route to four operations. This rig is
// what has to exist first.
//
// THE WALK BUDGET DECIDES THE SHAPE. Several AT-SPI walks in one window kill
// the application outright — cleanly, with nothing on stderr, taking
// xvfb-run's server with it. The naive rig opens four menus and walks either
// side of each: eight walks, dead on the third. So every claim that can be
// driven by KEYSTROKES and verified against the STORE or the FILESYSTEM spends
// zero walks, and walks are spent only where the claim is genuinely about the
// accessibility tree or the panel's rendered state. Two walks per boot, never
// more.
//
// The oracles are SQLite read directly and the export directory read off disk.
// Asking the page whether its own menu worked is the page marking its own
// homework, and `menu_context_label` is exactly the derived-state shape that
// shipped wrong once already in the restore slice.
//
// Usage: APP_GUI=1 bun app/harness/src/menu-cli.ts
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateMenuGates, type MenuMetrics } from "./gates";
import { menuChord, menuRoute } from "./menu-drive";
import { readManuscript } from "./markdown-read";
import { buildResult, writeResult } from "./results";
import { BIN, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** The menubar's container, and its four titles. Restated from `menu-bar.ts`
 *  and `index.html` rather than imported: there is no import across the
 *  harness/page boundary, and a restated constant fails loudly when the two
 *  drift instead of silently tracking a rename. */
const MENUBAR_ID = "menu-controls";
const TITLE_IDS = ["menu-file", "menu-edit", "menu-outline", "menu-help"] as const;
const PANEL_ID = "menu-panel";

/** How many ArrowDowns from the top of each menu to the item wanted. Opening a
 *  menu focuses item 0, so activating index N is N presses.
 *
 *  These are hard-coded, and that is only sound because NO menu item in this
 *  application is ever conditionally hidden, disabled or absent — `menu-remove`
 *  changes its TEXT between Delete and Restore and never its position. Read out
 *  of `menu-bar.ts`, not assumed. THE DAY AN ITEM BECOMES CONDITIONAL, every
 *  index below it shifts and this rig drives the wrong command while reporting
 *  a plausible number. */
// THE INDICES ARE PARSED, NEVER RESTATED. These were three literals with
// comments naming the items above them, and they were correct right up until an
// item was inserted above one of them - which happened the day Outline gained
// "Go to...". The rig then pressed Return on the item ABOVE the one it named,
// and the run aborted on its "the selected row was not in the bin" guard, which
// is that guard working. `menuRoute` reads the order out of `menu-bar.ts`, the
// one place it is actually decided.
const FILE_EXPORT = "menu-export";
const OUTLINE_NEW_SCENE = "menu-new-scene";
const OUTLINE_REMOVE = "menu-remove";

/** Deliberately restated from `store::TRASH_TYPE` / `outline.ts`. */
const TRASH_TYPE = "trash";

/** The navigator's row pitch and column width, restated from `style.css` and
 *  `project.ts`. The pane TOP is measured rather than restated: a box is not
 *  the sum of its content heights, and an 11px error there is invisible on a
 *  low row and lands on the NEXT row further down. */
const ROW_HEIGHT = 24;
const NAV_WIDTH = 320;

/** The label boots need a TALLER window and a taller screen than every other
 *  rig here, and the reason is structural rather than cosmetic: a removed row
 *  moves to the END of the walk, because the Trash root is the last root. So
 *  the row whose label is under test is always the furthest one down the pane,
 *  and at the shell's default 800px window on the shared 1280x1024 screen it
 *  cannot be reached at all. The pointer is CLAMPED to the screen, so a window
 *  taller than it buys nothing — the screen has to grow too. `prefs-cli` owns
 *  its own `serverArgs` for the same reason on the other axis. */
const TALL_SERVER_ARGS = "-screen 0 1600x1200x24 -s 0 -noreset";
const TALL_W = 1400;
const TALL_H = 1150;

/** xdotool returns when X has the events, not when WebKitGTK has acted on
 *  them. */
const SETTLE_MS = 2500;
const MENU_OPEN_MS = 600;
const KEY_STEP_MS = 120;
const MAX_DEPTH = 64;

const root = mkdtempSync(join(tmpdir(), "app-menu-"));

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

// ---------------------------------------------------------------------------
// The walk.
//
// This rig carries its OWN probe rather than calling `locateNodes`, because
// that one filters to a small set of roles chosen for buttons and list rows —
// and what a `role="menubar"` / `role="menuitem"` maps to on WebKitGTK is
// precisely the thing this rig exists to find out. A filter built from an
// answer cannot be used to ask the question. The traversal is identical and so
// is its cost; only the output is wider.
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

/** A node is a menu ITEM when its DOM id is under the menu namespace and is
 *  neither the bar, a title, nor the panel itself. Identified by id rather
 *  than by role for the same reason the probe is unfiltered — the role is the
 *  unknown. */
function menuItems(nodes: readonly AnyNode[]): AnyNode[] {
  const known = new Set<string>([MENUBAR_ID, PANEL_ID, ...TITLE_IDS]);
  return nodes.filter((n) => n.id.startsWith("menu-") && !known.has(n.id));
}

function roleOf(nodes: readonly AnyNode[], id: string): string {
  return nodes.find((n) => n.id === id)?.role ?? "not exposed";
}

// ---------------------------------------------------------------------------
// The oracles: the store, read directly.
// ---------------------------------------------------------------------------
interface WalkRow {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
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
         SELECT id, parent_id, type, title FROM walk ORDER BY path`,
      )
      .all() as WalkRow[];
  } finally {
    db.close();
  }
}

/** The store's own answer to "is this row in the bin", walked upward from the
 *  row rather than asked of the page. This is what makes `menu_context_label`
 *  worth having: the label under test is derived state, and comparing it
 *  against the same page's idea of the same derived state would compare a
 *  rendering to itself. */
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

function seed(label: string): string {
  const path = join(root, `${label}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, path], { stdout: "ignore", stderr: "inherit" });
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
  clickAt: (x: number, y: number) => void;
  /** Open a menu and step to an item, entirely from the keyboard. */
  /** Open the menu holding `itemId` and press Return on it. The chord and the
   *  step count both come from `menu-bar.ts` through `menuRoute`. */
  activate: (itemId: string) => Promise<void>;
  openMenu: (chord: string) => Promise<void>;
}

interface BootOptions {
  label: string;
  projectPath: string;
  dataHome: string;
  env?: Record<string, string>;
  /** Grow the window and the screen under it. Only the label boots need this. */
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
      ...options.env,
    },
    probeA11y: false,
    serverArgs: options.tall === true ? TALL_SERVER_ARGS : undefined,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("the menu rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      await Bun.sleep(SETTLE_MS);
      // A key send not preceded by this guard is a key send with no evidence
      // behind it: an unfocused window swallows the chord, which reads exactly
      // like the page ignoring it.
      if (options.tall === true) {
        xdo(display, ["windowsize", wid, String(TALL_W), String(TALL_H)]);
        await Bun.sleep(1500);
        // Verified rather than assumed: a resize that silently did not take
        // leaves every row coordinate below the fold, and the click would land
        // somewhere else and still report success.
        const geometry = xdo(display, ["getwindowgeometry", wid]);
        const seen = /Geometry: (\d+)x(\d+)/.exec(geometry);
        if (seen === null || Number(seen[2]) < TALL_H - 40) {
          throw new Error(`the window did not take the resize to ${TALL_W}x${TALL_H}: ${geometry.trim()}`);
        }
      }
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(`focus is on window ${focused}, not the shell's ${wid}; refusing to type`);
      }
      const key = (chord: string): void => {
        xdo(display, ["key", "--window", wid, chord]);
      };
      const openMenu = async (chord: string): Promise<void> => {
        key(chord);
        await Bun.sleep(MENU_OPEN_MS);
      };
      const ctx: BootContext = {
        display,
        wid,
        walk: () => walkAll(rootPid),
        key,
        clickAt: (x, y) => {
          // `mousemove --window` is window-relative and lands the pointer;
          // the click that follows is deliberately NOT `--window`. With the
          // flag, xdotool sends a synthetic button event through XSendEvent,
          // which GTK and WebKit discard as untrusted — no error, no effect,
          // and a selection that never moves while every call reports success.
          // Bare `click` drives XTEST, which is a real pointer event. This is
          // the mechanism outline-cli uses, and copying it verbatim is the
          // point.
          xdo(display, ["mousemove", "--window", wid, String(x), String(y)]);
          xdo(display, ["click", "1"]);
        },
        openMenu,
        activate: async (itemId) => {
          const route = menuRoute(itemId);
          await openMenu(route.chord);
          for (let i = 0; i < route.index; i++) {
            key("Down");
            await Bun.sleep(KEY_STEP_MS);
          }
          key("Return");
          await Bun.sleep(SETTLE_MS);
        },
      };
      await options.drive(ctx);
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(1500);
    },
  });
  return outcome.peakRssMb;
}

/** The pane's top edge, measured. `#editor` and `#nav` share a grid row, so
 *  they share a top edge, and the editable is the one box certain to be in the
 *  tree. Clamped when read, because AT-SPI reports LAYOUT extents and a
 *  document longer than the pane puts its corner outside the window — where X
 *  clamps the pointer rather than erroring, so the click lands somewhere else
 *  and still reports success. */
/** The navigator row carrying a given title, located in the tree the page has
 *  actually PAINTED.
 *
 *  Deliberately not arithmetic off the store's walk index. A removed row moves
 *  under the Trash root, and the navigator projects only rows whose ancestors
 *  are EXPANDED — so a store index and a visible index diverge the moment a
 *  branch is collapsed, and a click computed from the former lands past the end
 *  of the list, changes no selection, and leaves the menu correctly reporting
 *  the row that was already selected. That is indistinguishable from the defect
 *  this gate exists to catch.
 *
 *  The ORACLE is still the store: this only decides where to press. Which row
 *  is trashed is answered by walking parents in SQLite, never by the page. */
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


async function main(): Promise<void> {
  if (process.env.APP_GUI !== "1") {
    console.log("menu-cli: APP_GUI is not 1; skipping (this rig needs a real shell window).");
    return;
  }
  const peaks: number[] = [];

  // -- Boot A: does opening a menu expose anything, and under what role? -----
  // The CLOSED walk comes FIRST, and that ordering is the gate. Walking open
  // then closed would pass on a page that painted its items at boot and merely
  // cleared them on Escape — the menu would be proving it can close while
  // `menu_opens` claimed it can open.
  console.log("[1/6] open and expose");
  const aProject = seed("expose");
  const captured: {
    baseline: AnyNode[] | null;
    open: AnyNode[] | null;
    afterEscape: AnyNode[] | null;
    afterActivation: AnyNode[] | null;
    labelLive: string | null;
    labelTrashed: string | null;
  } = {
    baseline: null,
    open: null,
    afterEscape: null,
    afterActivation: null,
    labelLive: null,
    labelTrashed: null,
  };

  peaks.push(
    await boot({
      label: "expose",
      projectPath: aProject,
      dataHome: homeFor("expose"),
      drive: async (ctx) => {
        captured.baseline = ctx.walk();
        await ctx.openMenu(menuChord("menu-file"));
        captured.open = ctx.walk();
      },
    }),
  );
  const baseline = captured.baseline ?? fail("boot A produced no closed walk");
  const openWalk = captured.open ?? fail("boot A produced no open walk");
  const titlesFound = TITLE_IDS.filter((id) => openWalk.some((n) => n.id === id)).length;
  if (titlesFound === 0) {
    fail("no menu title was found in the accessibility tree, so nothing about the menu can be graded");
  }
  const openItems = menuItems(openWalk);
  if (openItems.length === menuItems(baseline).length) {
    fail("the walk after opening a menu exposed no more items than the walk before it");
  }

  // -- Boot B: Escape closes it, and activating an item closes it -----------
  console.log("[2/6] escape, and close-after-activation");
  peaks.push(
    await boot({
      label: "close",
      projectPath: seed("close"),
      dataHome: homeFor("close"),
      drive: async (ctx) => {
        await ctx.openMenu(menuChord("menu-file"));
        ctx.key("Escape");
        await Bun.sleep(MENU_OPEN_MS);
        captured.afterEscape = ctx.walk();
        // Help > Keyboard shortcuts: the one item that runs without touching
        // the store, the filesystem or the tree, so what is measured after it
        // is the menu closing and nothing else.
        await ctx.activate("menu-shortcuts");
        captured.afterActivation = ctx.walk();
      },
    }),
  );
  const afterEscape = captured.afterEscape ?? fail("boot B produced no post-Escape walk");
  const afterActivation = captured.afterActivation ?? fail("boot B produced no post-activation walk");

  // -- Boot C: Outline > New scene, graded against the store ----------------
  console.log("[3/6] create");
  const cProject = seed("create");
  const rowsBeforeCreate = storeWalk(cProject);
  peaks.push(
    await boot({
      label: "create",
      projectPath: cProject,
      dataHome: homeFor("create"),
      drive: async (ctx) => {
        await ctx.activate(OUTLINE_NEW_SCENE);
      },
    }),
  );
  const rowsAfterCreate = storeWalk(cProject);
  const beforeIds = new Set(rowsBeforeCreate.map((r) => r.id));
  const createdRow = rowsAfterCreate.find((r) => !beforeIds.has(r.id)) ?? null;

  // -- Boot D: File > Export manuscript, graded against the file ------------
  console.log("[4/6] export");
  const dProject = seed("export");
  const exportDir = join(root, "exports");
  mkdirSync(exportDir, { recursive: true });
  const filesBefore = readdirSync(exportDir);
  if (filesBefore.length !== 0) {
    fail(`the export directory already held ${filesBefore.length} file(s), so a write cannot be attributed`);
  }
  peaks.push(
    await boot({
      label: "export",
      projectPath: dProject,
      dataHome: homeFor("export"),
      env: { APP_EXPORT_DIR: exportDir },
      drive: async (ctx) => {
        await ctx.activate(FILE_EXPORT);
      },
    }),
  );
  const filesAfter = readdirSync(exportDir);
  const storeItems = storeWalk(dProject).length;
  let exportedSections = -1;
  if (filesAfter.length === 1) {
    const written = readFileSync(join(exportDir, filesAfter[0] as string), "utf8");
    exportedSections = readManuscript(written).sections.length;
  }

  // -- Boots E and F: the context label, against the store's bin state ------
  // Two boots rather than one because establishing the selection needs a walk
  // for the pane top, reading the label needs a walk with the menu open, and
  // the trashed half needs both again. Four walks is a dead application; two
  // boots of two is not.
  console.log("[5/6] context label, live row");
  const eProject = seed("label");
  const eHome = homeFor("label");
  const liveRows = storeWalk(eProject);
  // THE SECOND scene, never the first, and that is the difference between a
  // guard and a decoration. The application opens the first scene on boot, so
  // it is already the selection — targeting it makes the delete succeed
  // whether or not the click ever landed, and the "was the clicked row the one
  // that went into the bin" check below passes having tested nothing. Against
  // the second scene that check becomes a real proof that the pointer works,
  // and it is what caught a click being delivered to X and discarded by the
  // toolkit.
  const scenes = liveRows.filter((r) => r.type === "scene");
  const target = scenes[1];
  if (target === undefined) fail("the fixture holds fewer than two scenes, so no click can change the selection");
  const targetIndex = liveRows.indexOf(target);
  if (targetIndex >= 24) {
    fail(`the second scene sits at walk index ${targetIndex}, too far down the pane to click`);
  }
  // Located by title in the painted tree, so a duplicate would make the click
  // unattributable. Refused here rather than at click time, where the boot is
  // already running and the message arrives buried in a walk error.
  if (liveRows.filter((r) => r.title.trim() === target.title.trim()).length !== 1) {
    fail(`the second scene's title ${JSON.stringify(target.title)} is not unique in the walk`);
  }

  peaks.push(
    await boot({
      label: "label-live",
      projectPath: eProject,
      dataHome: eHome,
      tall: true,
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        ctx.clickAt(Math.round(row.x + row.w / 2), Math.round(row.y + row.h / 2));
        await Bun.sleep(MENU_OPEN_MS);
        await ctx.openMenu(menuChord("menu-outline"));
        const opened = ctx.walk();
        captured.labelLive = opened.find((n) => n.id === "menu-remove")?.name ?? null;
        // Same open menu, so no further walk: step to the item and run it. The
        // step count comes from the menu source, not from a literal.
        for (let i = 0; i < menuRoute(OUTLINE_REMOVE).index; i++) {
          ctx.key("Down");
          await Bun.sleep(KEY_STEP_MS);
        }
        ctx.key("Return");
        await Bun.sleep(SETTLE_MS);
      },
    }),
  );
  const liveLabel = captured.labelLive ?? fail("the Outline menu exposed no removal item on the live row");
  const afterDelete = storeWalk(eProject);
  if (!trashedInStore(afterDelete, target.id)) {
    fail("the selected row was not in the bin after the removal item ran, so the Restore half has no subject");
  }
  const trashedIndex = afterDelete.findIndex((r) => r.id === target.id);
  if (trashedIndex < 0) fail("the removed row left the store's walk entirely");
  // What the TALL window can reach, computed from the same two constants the
  // click uses rather than restated as a third number.
  const reachableRows = Math.floor((TALL_H - 80) / ROW_HEIGHT);
  if (trashedIndex >= reachableRows) {
    fail(
      `the binned row sits at index ${trashedIndex}, past the ${reachableRows} rows a ${TALL_H}px ` +
        `window can show; it could not be clicked without scrolling`,
    );
  }

  console.log("[6/6] context label, binned row");
  peaks.push(
    await boot({
      label: "label-trashed",
      projectPath: eProject,
      dataHome: eHome,
      tall: true,
      drive: async (ctx) => {
        const row = rowNamed(ctx.walk(), target.title);
        ctx.clickAt(Math.round(row.x + row.w / 2), Math.round(row.y + row.h / 2));
        await Bun.sleep(MENU_OPEN_MS);
        await ctx.openMenu(menuChord("menu-outline"));
        const opened = ctx.walk();
        captured.labelTrashed = opened.find((n) => n.id === "menu-remove")?.name ?? null;
      },
    }),
  );
  const trashedLabel = captured.labelTrashed ?? fail("the Outline menu exposed no removal item on the binned row");

  const metrics: MenuMetrics = {
    menu_titles_found: titlesFound,
    baseline_item_nodes: menuItems(baseline).length,
    open_item_nodes: openItems.length,
    open_item_names: openItems.map((n) => n.name),
    unnamed_item_nodes: openItems.filter((n) => n.name.trim().length === 0).length,
    menubar_role: roleOf(openWalk, MENUBAR_ID),
    title_role: roleOf(openWalk, "menu-file"),
    item_role: openItems[0]?.role ?? "not exposed",
    items_after_escape: menuItems(afterEscape).length,
    items_after_activation: menuItems(afterActivation).length,
    store_rows_before_create: rowsBeforeCreate.length,
    store_rows_after_create: rowsAfterCreate.length,
    created_row_type: createdRow?.type ?? null,
    export_files_before: filesBefore.length,
    export_files_after: filesAfter.length,
    exported_sections: exportedSections,
    store_items: storeItems,
    label_when_live: liveLabel,
    label_when_trashed: trashedLabel,
    live_row_trashed_in_store: trashedInStore(liveRows, target.id),
    trashed_row_trashed_in_store: trashedInStore(afterDelete, target.id),
    peak_rss_mb: Math.max(...peaks),
  };

  const verdicts = evaluateMenuGates(metrics);
  const written = writeResult(
    buildResult({
      runId: "app-menu-tiny",
      candidate: "tauri",
      fixture: "tiny",
      workload: "app-menu",
      verdicts,
      metrics: {
        ...metrics,
        scope:
          "Six boots, two AT-SPI walks maximum each. Every figure about the store is SQLite read " +
          "directly with bun:sqlite; every figure about the export is the file read off disk with " +
          "the harness's own restatement of the format. The menu is driven entirely by keystrokes " +
          "except the two navigator clicks, whose coordinates come from the store's own walk " +
          "against a MEASURED pane top.",
        omitted_gates:
          "no latency, stall, cliff or a11y_exposure figures: a run that opens four menus and " +
          "types nothing has nothing true to say about frame cadence, and the navigator's row " +
          "exposure is the hierarchy rig's claim, not this one's. menu_roles_exposed RECORDS the " +
          "ATK roles rather than asserting them - there is no prior measurement of menubar or " +
          "menuitem mapping on WebKitGTK to assert against - and asserts instead the thing a " +
          "collapsed role actually costs: an item exposed under a role that carries no name.",
      },
      seed: "n/a",
      rigCommit: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim(),
      environment: captureEnv(),
    }),
    RESULTS,
  );

  for (const v of verdicts) console.log(`${v.verdict.padEnd(7)} ${v.gate}: ${v.value}`);
  console.log(`\nwrote ${written}`);
  rmSync(root, { recursive: true, force: true });
  if (verdicts.some((v) => v.verdict === "FAIL")) process.exitCode = 1;
}

await main();
