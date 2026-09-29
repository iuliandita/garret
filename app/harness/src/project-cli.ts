// app/harness/src/project-cli.ts
// Graded project-lifecycle run. Seeds two projects into a private library,
// boots with no APP_PROJECT so the startup order picks one of them, types into
// it, switches to the other through the real project surface, types again,
// switches back, closes, reopens BOTH files and asserts each holds its own text
// and neither holds the other's.
//
// The isolation gate is the point, one level up from switch-cli's. doc_flush
// carries item ids and base_rev values that only mean something inside the
// project they came from, and two projects seeded from the same fixture
// generator share item ids outright - `it-000013` exists in both files. A flush
// crossing a project swap therefore lands on a real row in the WRONG manuscript,
// with no type error and no store error. This rig is the only thing in the repo
// that can observe that end to end.
//
// A CLICK is what picks the project, and that is the part a unit test cannot
// reach. Coordinates are COMPUTED from the stylesheet's box model (see the
// constants below) and then VETOED by an independent AT-SPI probe before each
// click - the probe never supplies a coordinate, it only refuses one that would
// miss. A rig that took its coordinates from the page would be checking the page
// against itself; a rig that took them from arithmetic alone would click into
// empty space and record a vacuous pass.
//
// OPENING the panel is keystrokes now, not a click. The retirement slice deleted
// #project-toggle from the project bar and File > Open project… is the only
// route left, so the one coordinate here that could never be computed - the
// toggle's hand-measured x=97, which depended on the rendered width of the
// project's name - is gone with it, and so is the AT-SPI walk that vetoed it.
//
// Usage: APP_GUI=1 bun app/harness/src/project-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateProjectGates, type ProjectMetrics } from "./gates";
import { menuDriver, type MenuDriver } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  findWindowId,
  runShell,
  survivingShellPids,
  type RunOutcome,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** Must match app/shell-tauri/src-tauri/src/projects.rs library_dir(). */
const APP_DIR = "cc.local.app";
const PROJECTS_DIR = "projects";

/* Click geometry, restated from app/ui/style.css rather than imported, for the
 * same reason gates.ts restates thresholds and switch-cli restates ROW_HEIGHT:
 * these are two programs, and a shared constant would hide a drift instead of
 * failing on it. Every value below is derived from the stylesheet; the numbers
 * in the comments are what a live WebKitGTK layout produced, recorded so a
 * future divergence is visible rather than silent.
 *
 * There is no window manager under Xvfb, so the window carries no decorations
 * and the page's origin is the window's origin - which is what makes
 * `xdotool mousemove --window` coordinates and CSS pixels the same thing. */

/** body { font: 16px/1.6 } => one line box. Still what an OPTION row is built
 *  on (its font is unchanged); no longer what the bar is built on. */
const LINE_HEIGHT = 25.6;
/** #project-bar is 39px by declaration since 067 (border-box), so its
 *  padding box ends at 38 and `#project-panel { top: 100% }` resolves there.
 *  Before 067 the bar was 6 + 25.6 + 6 + 1 and the panel sat at 37. */
const BAR_HEIGHT = 39;
const PANEL_TOP = BAR_HEIGHT - 1;
/** #project-panel { left: 12px; padding: 12px } plus its 1px border. */
const PANEL_LEFT = 12;
const PANEL_BORDER = 1;
const PANEL_PAD = 12;
/** #project-list [role="option"] { padding: 5px 8px } around one line box.
 *  25.6 + 5 + 5, floored by layout to 35.
 *
 *  IT SAID 4px UNTIL 2026-08-18 and the stylesheet had said 5px since the
 *  visual redesign. The drift was latent rather than harmless: it is 0 for the
 *  first row and grows by 2px per row, so with the two projects this rig seeds
 *  it stayed inside the row and `assertInside` would have refused rather than
 *  mis-clicked - but a third project would have put the click on the wrong
 *  option, and a fourth outside the panel. A restated constant is a claim about
 *  another file, and this one had stopped being true. */
const OPTION_HEIGHT = Math.floor(LINE_HEIGHT + 5 + 5);
/** Well inside the 294px-wide row, clear of its 8px padding. */
const OPTION_CLICK_INSET = 100;

/** Rounding drift is OPTION_HEIGHT's 0.6px per row, which stays far below a row
 *  boundary for a handful of rows and would not for dozens. This rig seeds
 *  exactly two projects; anything else means the library was not private. */
const EXPECTED_PROJECTS = 2;

const SENTENCE_A = "The harbor master logged every departure.";
const SENTENCE_B = "The cartographer refused to name the island.";
const SUFFIX_A = " She logged the last one twice.";

/** xdotool type returns when X has the key events, not when WebKitGTK has turned
 *  them into document state. hand-cli.ts found 500 ms silently truncating typed
 *  text; 2500 ms is what held. It also covers the flush debounce (1000 ms,
 *  store/flush.ts DEBOUNCE_MS), so every sentence is in the store before the
 *  next switch tears its project down. */
const SETTLE_MS = 2500;
/** Past the host's 2 s close fallback thread (main.rs on_window_event). */
const CLOSE_WAIT_MS = 3000;

/** The interactive-mode sink payload (app/ui/src/main.ts, `run === "interactive"`).
 *  NOT a SinkPayload: interactive mode types nothing and sinks no typing, nav or
 *  cycle data at all. */
interface InteractiveSinkPayload {
  ready: boolean;
  error?: string;
  candidate: string;
  seed: string;
  mode: string;
  run: "interactive";
  rows: number;
  startup_ms: number;
  item_id: string | null;
  project_path: string;
  project_name: string;
  generation: number;
}

interface AtspiNode {
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  attrs: Map<string, string>;
}

// A local dump rather than probeAtspi: that probe answers "how many rows does
// the navigator advertise", and this rig needs roles, names and on-screen
// rectangles for the project surface. Same refusal discipline (see the #apps
// header below) and the same match-on-the-ATK-role rule - `xml-roles` echoes the
// DOM attribute whether or not the platform accepted it.
export const PY_DUMP = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

def rect(node):
    try:
        e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
        return "%d,%d,%d,%d" % (e.x, e.y, e.width, e.height)
    except Exception:
        return "0,0,0,0"

def attrs(node):
    try:
        return ";".join(node.getAttributes())
    except Exception:
        return ""

def walk(node, out):
    try:
        n = node.childCount
        out.append("\t".join([node.getRoleName(), node.name or "", rect(node), attrs(node)]))
        for i in range(n):
            walk(node.getChildAtIndex(i), out)
    except Exception:
        pass

${PY_SELECT_APPS}
out = ["#apps\t" + str(len(matched))]
for app in matched:
    walk(app, out)
sys.stdout.write("\n".join(out))
`;

function parseAttrs(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(";")) {
    const colon = pair.indexOf(":");
    if (colon > 0) map.set(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim());
  }
  return map;
}

/** The live accessibility tree, or a throw. Never an empty list on failure: an
 *  unavailable probe must abort the run, not silently approve every click. */
function probe(rootPid: number): AtspiNode[] {
  const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      "AT-SPI probe failed (exit " + String(proc.exitCode) + "): " +
        proc.stderr.toString().trim() +
        ". This rig cannot verify a click without it.",
    );
  }
  const lines = proc.stdout
    .toString()
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const header = /^#apps\t(\d+)$/.exec(lines[0] ?? "");
  // Zero matched, or several did and got concatenated. Either way the rows below
  // cannot be attributed to one window, and picking one would reproduce exactly
  // the false PASS this guard exists to prevent.
  if (!header || Number(header[1]) !== 1) {
    throw new Error(
      "AT-SPI matched " + (header?.[1] ?? "no") + " apps under pid " + rootPid + "'s process tree, expected 1",
    );
  }
  return lines.slice(1).map((raw) => {
    const [role = "", name = "", rect = "", attrRaw = ""] = raw.split("\t");
    const [x = 0, y = 0, w = 0, h = 0] = rect.split(",").map(Number);
    return { role, name, x, y, w, h, attrs: parseAttrs(attrRaw) };
  });
}

function byId(nodes: AtspiNode[], id: string): AtspiNode | undefined {
  return nodes.find((n) => n.attrs.get("id") === id);
}

/** Refuses the click rather than making it. The computed point is the rig's
 *  claim about the layout; this is the independent witness that it lands on the
 *  thing it names. */
function assertInside(node: AtspiNode | undefined, what: string, x: number, y: number): void {
  if (node === undefined) {
    throw new Error(
      what + " is not in the accessibility tree; refusing to click (" + x + "," + y + ")",
    );
  }
  const inside = x >= node.x && x < node.x + node.w && y >= node.y && y < node.y + node.h;
  if (!inside) {
    throw new Error(
      "computed click (" + x + "," + y + ") falls outside " + what + " at (" +
        [node.x, node.y, node.w, node.h].join(",") +
        "): the restated geometry no longer matches the page",
    );
  }
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

/** Every scene body in one project, concatenated. Read from the file, so this is
 *  the store's own account and not the application's - the process that wrote it
 *  is dead by the time the post-run call happens. */
function bodies(projectPath: string): string {
  const db = new Database(projectPath, { readonly: true });
  try {
    const rows = db.query("SELECT item_id, body FROM doc ORDER BY item_id").all() as {
      item_id: string;
      body: string;
    }[];
    return rows.map((r) => r.body).join("\n");
  } finally {
    db.close();
  }
}

/** An unreadable project must be REPORTED, not fatal: survived_restart is the
 *  gate that exists to say so, and it is worthless if the read that would fail
 *  it kills the rig before any gate is evaluated. */
function readBodies(projectPath: string): { text: string; error: string | null } {
  try {
    return { text: bodies(projectPath), error: null };
  } catch (err: unknown) {
    return { text: "", error: String(err) };
  }
}

function xdo(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error("xdotool " + args.join(" ") + " failed: " + proc.stderr.toString().trim());
  }
  return proc.stdout.toString();
}


if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; project run skipped (needs a display and a built shell).");
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
      `refusing to start: ${SHELL_PROC_NAME} already running (pid(s) ${preexisting.join(", ")}).`,
    );
    process.exit(1);
  }
}

// A private XDG_DATA_HOME, so the library under test is two files this rig
// seeded and nothing of the operator's. The host resolves the library from it
// exactly as a real launch would.
const dataHome = mkdtempSync(join(tmpdir(), "app-project-"));
const library = join(dataHome, APP_DIR, PROJECTS_DIR);
function cleanup(): void {
  rmSync(dataHome, { recursive: true, force: true });
}

console.log(`[1/3] seeding two projects from ${FIXTURE}`);
mkdirSync(library, { recursive: true });
const paths = new Map<string, string>();
for (const name of ["alpha", "beta"]) {
  const path = join(library, `${name}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, path], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) {
    console.error(`seeding ${path} failed (exit ${seeded.exitCode}); nothing was written.`);
    cleanup();
    process.exit(1);
  }
  paths.set(name, path);
}
const pathAlpha = paths.get("alpha")!;
const pathBeta = paths.get("beta")!;
if (pathAlpha === pathBeta) {
  console.error(
    "\nSTRUCTURAL CHECK FAILED\n  both projects resolved to one path.\nNothing was written.",
  );
  cleanup();
  process.exit(2);
}
const seededBodies = new Map([...paths].map(([name, p]) => [name, bodies(p)]));
console.log(`  ${pathAlpha}\n  ${pathBeta}`);

/** Where row `index` of the open panel is, from the stylesheet alone. */
function rowPoint(index: number): { x: number; y: number } {
  const top = PANEL_TOP + PANEL_BORDER + PANEL_PAD + index * OPTION_HEIGHT;
  return {
    x: PANEL_LEFT + PANEL_BORDER + PANEL_PAD + OPTION_CLICK_INSET,
    y: Math.floor(top + OPTION_HEIGHT / 2),
  };
}

/** Open the project panel from File > Open project….
 *
 *  This used to be a click on #project-toggle at a hand-measured x of 97 - the
 *  one coordinate in this rig that could not be computed from the stylesheet,
 *  because the button's left edge was the rendered width of the project name.
 *  The retirement slice deleted the button, so the number and the AT-SPI probe
 *  that vetoed it are both gone; the panel is reached from the menu now.
 *
 *  "Open project…" rather than "New project…": the two menu items differ
 *  exactly in which control they focus, and every use here is about to pick an
 *  existing project out of the list. The item's index inside the File menu is
 *  PARSED out of menu-bar.ts by menu-drive.ts and never restated, so an item
 *  inserted above it moves this with it.
 *
 *  Costs no AT-SPI walk at all, where the click cost one per open. */
async function openPanel(menu: MenuDriver): Promise<void> {
  await menu.activate("menu-project-open");
}

/** The rows the panel is showing, and the name of the project it painted as
 *  open. Row ORDER is `list()`'s - newest mtime first, name ascending on a tie -
 *  and it CHANGES mid-run, because typing into a project rewrites its file. So
 *  rows are identified by the page's own `current` marker, never by index. */
interface PanelState {
  rows: AtspiNode[];
  currentName: string;
}

function readPanel(rootPid: number): PanelState {
  const nodes = probe(rootPid);
  if (byId(nodes, "project-panel") === undefined) {
    throw new Error(
      "the project panel did not open: File > Open project… did not reach it. Either the chord " +
        "never arrived at the window, or the item at that index is no longer the one that opens " +
        "the panel.",
    );
  }
  if (byId(nodes, "project-list") === undefined) {
    throw new Error("#project-list is not exposed");
  }
  // Match on the ATK role only. The navigator's rows are `tree item`, so this
  // cannot collide with them; `xml-roles` is diagnostic and echoes the DOM
  // attribute whether or not the platform accepted it.
  const rows = nodes.filter((n) => n.role === "list item");
  if (rows.length !== EXPECTED_PROJECTS) {
    throw new Error(
      "the panel lists " + String(rows.length) + " project(s); this rig seeded " +
        String(EXPECTED_PROJECTS) +
        " into a private library, so anything else means it is not the library under test",
    );
  }
  const disabled = rows.filter((r) => r.name.includes(" - "));
  if (disabled.length > 0) {
    throw new Error(
      "the panel shows an unopenable project: " + disabled.map((d) => d.name).join(", "),
    );
  }
  const current = rows.filter((r) => r.attrs.get("current") === "true");
  if (current.length !== 1) {
    throw new Error(
      String(current.length) + " rows claim to be the open project; expected exactly 1",
    );
  }
  return { rows, currentName: current[0]!.name };
}

/** Click the row that is NOT the open project. Returns the name it switched to.
 *  Chosen from the page's own `current` marker rather than from a name this rig
 *  decided in advance: which project the startup order opens is part of what is
 *  under test, and the payload that says so cannot be read until the run ends. */
function clickOtherProject(display: string, wid: string, panel: PanelState): string {
  const index = panel.rows.findIndex((r) => r.attrs.get("current") !== "true");
  const row = panel.rows[index]!;
  const { x, y } = rowPoint(index);
  assertInside(row, '#project-list row ' + String(index) + ' ("' + row.name + '")', x, y);
  xdo(display, ["mousemove", "--window", wid, String(x), String(y)]);
  xdo(display, ["click", "1"]);
  return row.name;
}

console.log("\n[2/3] interactive run");
// GDK_BACKEND=x11 is load-bearing: a developer's ambient session sets
// WAYLAND_DISPLAY, and GTK prefers Wayland when it is available, so the webview
// would open on the real desktop instead of the Xvfb display xdotool targets.
//
// No APP_PROJECT. The startup order and the library are part of what is under
// test, and handing the host a path would skip both.
//
// Wrapped, not bare: any throw inside onReady (an xdotool non-zero exit, a
// refused click, a window search that finds the wrong number of windows) would
// otherwise leave the temporary data home behind.
let bootName = "";
let otherName = "";
let backName = "";
let persistErrorSeen: string | null = null;

async function drive(): Promise<RunOutcome<InteractiveSinkPayload>> {
  return runShell<InteractiveSinkPayload>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", XDG_DATA_HOME: dataHome, GDK_BACKEND: "x11" },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("project rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowfocus", wid]);
      // A key send not preceded by this guard is a key send with no evidence
      // behind it: an unfocused window swallows the chord, which reads exactly
      // like the page ignoring it. Both the typing and the menu route below are
      // keystrokes.
      const focused = xdo(display, ["getwindowfocus"]).trim();
      if (focused !== wid) {
        throw new Error(
          "focus is on window " + focused + ", not the shell's " + wid + "; refusing to type",
        );
      }
      const menu = menuDriver(display, wid, xdo);
      await Bun.sleep(500);

      // The boot project. mountProject focuses the editor, so this lands in it.
      xdo(display, ["type", "--delay", "40", SENTENCE_A]);
      await Bun.sleep(SETTLE_MS);

      await openPanel(menu);
      await Bun.sleep(SETTLE_MS);
      const first = readPanel(rootPid);
      bootName = first.currentName;
      otherName = clickOtherProject(display, wid, first);
      console.log(`  boot project "${bootName}" -> switching to "${otherName}"`);
      await Bun.sleep(SETTLE_MS);

      xdo(display, ["type", "--delay", "40", SENTENCE_B]);
      await Bun.sleep(SETTLE_MS);

      await openPanel(menu);
      await Bun.sleep(SETTLE_MS);
      const second = readPanel(rootPid);
      if (second.currentName !== otherName) {
        throw new Error(
          'the panel says "' + second.currentName + '" is open; the row click claimed "' +
            otherName +
            '". The switch did not happen, so nothing after this would be a switching result.',
        );
      }
      backName = clickOtherProject(display, wid, second);
      console.log(`  switching back to "${backName}"`);
      await Bun.sleep(SETTLE_MS);

      // Back in the boot project. If a flush had crossed the swap, this suffix
      // is the text most likely to land in the wrong file.
      xdo(display, ["type", "--delay", "40", SUFFIX_A]);
      await Bun.sleep(SETTLE_MS);

      // A refused flush raises #persist-error (role=alert). Read it before the
      // window goes: it is the only host-side rejection this rig can observe,
      // and its ABSENCE is what the generation note below rests on.
      const banner = byId(probe(rootPid), "persist-error");
      persistErrorSeen = banner === undefined ? null : banner.name;

      // No window manager under Xvfb: this raises BadDrawable and kills the
      // process rather than delivering a graceful close (hand-cli.ts records the
      // instrumentation that established it). The run needs the process gone
      // before the files can be read; the debounce autosave above, not the close
      // round trip, is what put the text in the stores.
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(CLOSE_WAIT_MS);
    },
  });
}

let outcome: RunOutcome<InteractiveSinkPayload>;
try {
  outcome = await drive();
} catch (err: unknown) {
  cleanup();
  throw err;
}

// Which project opened is part of what is under test, so it is asserted, not
// assumed - and the payload carrying the answer cannot be read until now,
// because runShell parses it before calling onReady.
const openedPath = outcome.payload.project_path;
if (openedPath !== pathAlpha && openedPath !== pathBeta) {
  console.error(
    `\nthe host opened ${openedPath}, which is neither project this rig seeded. The library ` +
      "under test was not the one measured.\nNothing was written.",
  );
  cleanup();
  process.exit(2);
}
if (outcome.payload.project_name !== bootName) {
  console.error(
    `\nthe page reported "${outcome.payload.project_name}" at boot; the panel showed "${bootName}" ` +
      "as current. Two accounts of the same fact disagree, so neither can be graded.\n" +
      "Nothing was written.",
  );
  cleanup();
  process.exit(2);
}

// A is the project that was open at boot and got both SENTENCE_A and SUFFIX_A;
// B is the one the run switched to.
const pathA = openedPath;
const pathB = openedPath === pathAlpha ? pathBeta : pathAlpha;

console.log("\n[3/3] reading the reopened files");
const readA = readBodies(pathA);
const readB = readBodies(pathB);
for (const [p, r] of [[pathA, readA], [pathB, readB]] as const) {
  if (r.error !== null) console.error(`  ${p}: UNREADABLE: ${r.error}`);
}

let changed = 0;
for (const [p, r] of [[pathA, readA], [pathB, readB]] as const) {
  if (r.text !== seededBodies.get(basename(p, ".db"))) changed++;
}

const metrics: ProjectMetrics = {
  a_holds_own: readA.text.includes(SENTENCE_A),
  a_holds_other: readA.text.includes(SENTENCE_B),
  b_holds_own: readB.text.includes(SENTENCE_B),
  b_holds_other: readB.text.includes(SENTENCE_A) || readB.text.includes(SUFFIX_A),
  survived_restart: readA.error === null && readB.error === null,
  // NOT PROBED. null, never false: false would claim a stale flush was sent and
  // accepted, when none was ever sent. A stale-generation flush cannot be
  // produced through real input at all - project-switch.ts drains the outgoing
  // project before it destroys it, so nothing is ever in flight or armed across
  // the swap - and this rig cannot call doc_flush directly without changing the
  // page. What WAS observed is narrower and sits in metrics.generation_probe.
  // The comparison itself is covered by the host's own unit tests.
  stale_generation_rejected: null,
  projects_changed: changed,
};

// Structural checks BEFORE the gates. A vacuous pass must not be recorded.
if (metrics.projects_changed < 2) {
  console.error(
    `\nSTRUCTURAL CHECK FAILED\n  ${metrics.projects_changed} project(s) diverged from their seeds.\n` +
      "With fewer than two, no switch happened and every gate below would be asserting " +
      "something about a single manuscript.\nNothing was written.",
  );
  cleanup();
  process.exit(2);
}
if (!metrics.a_holds_own && !metrics.b_holds_own) {
  console.error(
    "\nSTRUCTURAL CHECK FAILED\n  neither sentence reached a store: the clicks or the " +
      "keystrokes never landed. Nothing here is a project-lifecycle result.\nNothing was written.",
  );
  cleanup();
  process.exit(2);
}
console.log(`\nstructural check passed: ${metrics.projects_changed} projects diverged.\n`);

const verdicts = evaluateProjectGates(metrics);
const written = writeResult(
  buildResult({
    workload: "app-project",
    runId: "app-project-tiny",
    candidate: "tauri",
    fixture: "tiny",
    verdicts,
    metrics: {
      workload_script: "project-v1",
      peak_rss_mb: outcome.peakRssMb,
      startup_ms: outcome.payload.startup_ms,
      rows: outcome.payload.rows,
      boot_project: bootName,
      boot_generation: outcome.payload.generation,
      switched_to: otherName,
      switched_back_to: backName,
      opened_at_boot: outcome.payload.item_id,
      project_a: basename(pathA),
      project_b: basename(pathB),
      project_a_readable: readA.error === null,
      project_b_readable: readB.error === null,
      project: metrics,
      // Exactly what stale_generation_rejected does and does not rest on.
      generation_probe:
        "NOT PROBED. No stale-generation flush can be produced through real input: " +
        "project-switch.ts drains the outgoing project before destroying it, and this rig " +
        "cannot call doc_flush directly. Observed instead: two switches completed and every " +
        "sentence reached its own store, so the page's flushes were accepted at the host's " +
        "current generation; and no persist-error alert was exposed at the end of the run" +
        (persistErrorSeen === null ? "." : ", except: " + persistErrorSeen + "."),
      // A few seconds of typing has nothing true to say about any of these, and
      // AT-SPI is used here as a click oracle, not as an exposure measurement.
      omitted_gates:
        "latency, stall, cliff, a11y_exposure: the run is seconds long and the AT-SPI probe " +
        "vetoes clicks rather than measuring exposure",
      close_path: "unverified: no window manager under Xvfb; windowclose kills the process",
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

cleanup();
console.log(`\nrecorded: ${written}`);
for (const v of verdicts) console.log(`  ${v.gate}: ${v.value} (${v.threshold}) ${v.verdict}`);
