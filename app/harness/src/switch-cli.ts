// app/harness/src/switch-cli.ts
// Graded document-switching run. Types into two scenes through real pointer and
// keyboard input, closes the window, reopens the file, and asserts each scene
// holds its own text and neither holds the other's.
//
// The isolation gate is the point. session.switchTo's whole design exists to
// make one interleaving impossible — the outgoing document's body written under
// the incoming document's id — and this is the only test in the repo that can
// observe it end to end.
//
// Clicks, not keystrokes, for the navigation: clicking is the affordance most
// likely to be broken and least likely to be caught by a unit test. Row
// coordinates are COMPUTED from the store's own walk, not read from the page —
// a rig that asked the page where its rows are would be checking the page
// against itself. The fits-without-scrolling guard below is what makes that
// computation safe.
//
// Usage: APP_GUI=1 bun app/harness/src/switch-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { evaluateSwitchGates, type SwitchMetrics } from "./gates";
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

/** Must match ROW_HEIGHT in app/ui/src/main.ts, `--nav-width` in
 *  app/ui/style.css, and the window size the shell builds in
 *  app/shell-tauri/src-tauri/src/main.rs. Restated rather than imported for the
 *  same reason gates.ts restates thresholds: these are two programs, and a
 *  shared constant would hide a drift instead of failing on it.
 *
 *  WINDOW_HEIGHT minus the footer stands in for the navigator pane's
 *  clientHeight. The two agree only because there is no window manager under
 *  Xvfb, so the window carries no decorations and the pane starts at the
 *  window origin — which is also what makes the window-relative click
 *  coordinates below land. */
const ROW_HEIGHT = 24;
/** The height this rig RESIZES the window to, which is NOT the 900 the shell
 *  builds.
 *
 *  Until the visual redesign this rig took the shell's window as it came, and
 *  40 fixture rows at 20px fitted under it. At 24px they do not, and this rig's
 *  own fit guard below would abort every run - the guard working, not failing.
 *  Resizing is the rig adapting to the application rather than the reverse, and
 *  it is the same move outline-cli already makes, including reading the geometry
 *  back afterwards. The Xvfb screen is 1280x1024, so this fits. */
const WINDOW_HEIGHT = 1150;
/** Unchanged from what the shell builds: this rig clicks navigator rows and the
 *  prose column, and neither cares how wide the window is. Stated only because
 *  `xdotool windowsize` takes both axes and passing the height alone would
 *  silently narrow the window to it. */
const WINDOW_WIDTH = 900;
/** Everything above the navigator's first row, which since the outline bar was
 *  retired is the project bar alone. Since 067 the bar DECLARES `height: 39px`
 *  (border-box) rather than summing to it; before that it was `padding: 6px`
 *  top and bottom around a 16px/1.6 line plus a 1px bottom border, which
 *  landed on the same number. Every y here is offset by it.
 *
 *  THERE WAS A SECOND BAR until 2026-08-19 - a 34px strip holding three
 *  creates, Rename and Delete - and this constant was the two added up. Both
 *  panes are grid-row 2 now and the navigator starts 34px higher. A rig that
 *  kept the old number would press 34px low and report a plausible result
 *  rather than an error, which is the whole hazard of restating this at all.
 *
 *  Measured against a live window at this commit: the pane's top edge is 38, so
 *  a click lands one pixel below a row's centre. `outline-cli` reads the same
 *  edge out of #nav's own AT-SPI box rather than restating it; this rig takes
 *  no AT-SPI walk at all and is not going to grow one for a single pixel. Its
 *  fit guard below and its structural checks are what catch a drift.
 *
 *  Added when the project lifecycle slice introduced the bar, which moved every
 *  row down and made this rig's clicks land one row high - caught by its own
 *  structural guard, which is what that guard is for. */
const BAR_HEIGHT = 39;
/** #nav-header, the strip carrying the book's name above the outline. Added
 *  earlier and 39px by design, matching the bar. Every navigator row moved
 *  down by it; a rig that kept the old number clicks a row a writer does not see
 *  and grades whatever it happens to hit. */
const NAV_HEADER_HEIGHT = 39;
const NAV_TOP = BAR_HEIGHT + NAV_HEADER_HEIGHT;
/** #footer { height: 34px }. The navigator's rows still start at
 *  NAV_TOP, but the pane ends this much before the window does, so the
 *  "every row is on screen" guard subtracts it. */
const FOOTER_HEIGHT = 34;
/** The middle of the navigator pane, which app/ui/style.css sizes at
 *  `--nav-width: 320px`. Restated here too. */
const NAV_CLICK_X = 160;
/** store/mod.rs MAX_DEPTH. Without it the CTE below recurses forever on a
 *  parent_id cycle where the store's own walk bounds it and reports Corrupt —
 *  the rig would hang instead of failing. */
const MAX_DEPTH = 64;

const SENTENCE_A = "The lighthouse keeper counted seven ships.";
const SENTENCE_B = "The cartographer refused to name the island.";
const SUFFIX_A = " He counted them again at dawn.";

/** xdotool type returns when X has the key events, not when WebKitGTK has
 *  turned them into document state. hand-cli.ts found 500 ms silently
 *  truncating typed text; 2500 ms is what held. */
const SETTLE_MS = 2500;
/** prosemirror-history starts a new undo group after 500 ms of quiet. */
const UNDO_GROUP_GAP_MS = 900;

/** The interactive-mode sink payload (app/ui/src/main.ts, `run === "interactive"`).
 *  NOT a SinkPayload: interactive mode types nothing and sinks no
 *  typing/nav/cycles at all. */
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
}

interface WalkRow {
  id: string;
  type: string;
  title: string;
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

/** The store's own depth-first walk, restated here from store/mod.rs items()
 *  and run against the file directly. This is the order the navigator projects,
 *  so a row's index in this list is its visible index while nothing is
 *  collapsed — which is what makes a click coordinate computable. */
function walk(projectPath: string): WalkRow[] {
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
         SELECT id, type, title FROM walk ORDER BY path`,
      )
      .all() as WalkRow[];
  } finally {
    db.close();
  }
}

/** Every scene body, keyed by item. Read from the file, so this is the store's
 *  own account and not the application's — the process that wrote it is dead by
 *  the time the post-run call happens. */
function bodies(projectPath: string): Map<string, string> {
  const db = new Database(projectPath, { readonly: true });
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

function xdoRead(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

function xdo(display: string, args: string[]): void {
  xdoRead(display, args);
}

/** Ask for the window size this rig's coordinates assume, then READ IT BACK.
 *  An unhonoured resize leaves every click below computed against a window that
 *  does not exist, landing on rows the rig never chose and reporting whatever
 *  they happen to do. Same shape as outline-cli's. */
function resizeWindow(display: string, wid: string): void {
  xdo(display, ["windowsize", wid, String(WINDOW_WIDTH), String(WINDOW_HEIGHT)]);
  const geometry = xdoRead(display, ["getwindowgeometry", "--shell", wid]);
  const height = Number(geometry.match(/\bHEIGHT=(\d+)/)?.[1] ?? 0);
  if (height !== WINDOW_HEIGHT) {
    throw new Error(
      `the window is ${height}px tall after asking for ${WINDOW_HEIGHT}: the navigator would ` +
        `scroll, and every click coordinate here assumes it does not.`,
    );
  }
}


if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; switch run skipped (needs a display and a built shell).");
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

const projectDir = mkdtempSync(join(tmpdir(), "app-switch-"));
const projectPath = join(projectDir, "project.db");
function cleanup(): void {
  rmSync(projectDir, { recursive: true, force: true });
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

const rows = walk(projectPath);
// The click coordinates below are computed, so a scrolled pane would silently
// click the wrong row and still produce a plausible-looking result.
if (NAV_TOP + rows.length * ROW_HEIGHT > WINDOW_HEIGHT - FOOTER_HEIGHT) {
  console.error(
    `${rows.length} rows at ${ROW_HEIGHT}px below a ${NAV_TOP}px bar+header exceed the ${WINDOW_HEIGHT}px window ` +
      `less its ${FOOTER_HEIGHT}px footer: the navigator would scroll, and every click coordinate here assumes it does not.`,
  );
  cleanup();
  process.exit(2);
}

const scenes = rows.map((r, i) => ({ ...r, index: i })).filter((r) => r.type === "scene");
if (scenes.length < 3) {
  console.error(`fixture has ${scenes.length} scene(s); this rig needs at least 3.`);
  cleanup();
  process.exit(2);
}
// scenes[0] is the one main.ts opens at boot, so switching to it would be
// `same` and nothing would be exercised. Take the next two: both switches are
// real, and the third click back to A is a second real switch.
const sceneA = scenes[1]!;
const sceneB = scenes[2]!;
const seedBodies = bodies(projectPath);
console.log(
  `  ${rows.length} rows; A = ${sceneA.id} (row ${sceneA.index}), B = ${sceneB.id} (row ${sceneB.index})`,
);

function clickRow(display: string, wid: string, index: number): void {
  xdo(display, [
    "mousemove",
    "--window",
    wid,
    String(NAV_CLICK_X),
    String(NAV_TOP + index * ROW_HEIGHT + ROW_HEIGHT / 2),
  ]);
  xdo(display, ["click", "1"]);
}

console.log("\n[2/3] interactive run");
// GDK_BACKEND=x11 is load-bearing: a developer's ambient session sets
// WAYLAND_DISPLAY, and GTK prefers Wayland when it is available, so the webview
// would open on the real desktop instead of the Xvfb display xdotool targets.
// Wrapped, not bare: any throw inside onReady (an xdotool non-zero exit, a
// window search that finds the wrong number of windows) would otherwise leave
// the temporary project directory behind.
async function drive(): Promise<RunOutcome<InteractiveSinkPayload>> {
  return runShell<InteractiveSinkPayload>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", APP_PROJECT: projectPath, GDK_BACKEND: "x11" },
    probeA11y: false,
    onReady: async ({ displayNum }) => {
      if (displayNum === null) throw new Error("switch rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      resizeWindow(display, wid);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["windowfocus", wid]);

      clickRow(display, wid, sceneA.index);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["type", "--delay", "40", SENTENCE_A]);
      await Bun.sleep(SETTLE_MS);

      clickRow(display, wid, sceneB.index);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["type", "--delay", "40", SENTENCE_B]);
      await Bun.sleep(SETTLE_MS);

      // Back to A. If the undo history had crossed documents, the ctrl+z below
      // would remove B's sentence instead of A's suffix.
      clickRow(display, wid, sceneA.index);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["type", "--delay", "40", SUFFIX_A]);
      await Bun.sleep(UNDO_GROUP_GAP_MS);
      xdo(display, ["key", "ctrl+z"]);
      await Bun.sleep(SETTLE_MS);

      // No window manager under Xvfb: this raises BadDrawable and kills the
      // process rather than delivering a graceful close (hand-cli.ts records
      // the instrumentation that established it). The run still needs the
      // process gone before the file can be read, and the debounce autosave is
      // what puts the text in the store. The close ROUND TRIP is hand-cli's
      // question, not this rig's.
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(3000);
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

// The rig picks A and B on the assumption that main.ts opens scenes[0] at boot.
// If that ever changes, the first click becomes a `same` and the run silently
// stops testing a switch — so assert it rather than assume it.
if (outcome.payload.item_id === sceneA.id || outcome.payload.item_id === sceneB.id) {
  console.error(
    `\nthe page opened ${outcome.payload.item_id} at boot, which this rig chose as a click ` +
      `target: the first click would be a no-op switch. Nothing was written.`,
  );
  cleanup();
  process.exit(2);
}

console.log("\n[3/3] reading the reopened file");
const after = bodies(projectPath);
const bodyA = after.get(sceneA.id) ?? "";
const bodyB = after.get(sceneB.id) ?? "";

let changed = 0;
for (const [itemId, body] of after) {
  if (body !== seedBodies.get(itemId)) changed++;
}

const metrics: SwitchMetrics = {
  a_holds_own: bodyA.includes(SENTENCE_A),
  a_holds_other: bodyA.includes(SENTENCE_B),
  b_holds_own: bodyB.includes(SENTENCE_B),
  b_holds_other: bodyB.includes(SENTENCE_A) || bodyB.includes(SUFFIX_A),
  survived_restart: bodyA.length > 0 && bodyB.length > 0,
  // One ctrl+z after a 900 ms gap is its own undo group, so it removes the
  // suffix and nothing else. Had the history carried over from B, it would
  // have removed something else and the suffix would still be here.
  undo_scoped: bodyA.includes(SENTENCE_A) && !bodyA.includes(SUFFIX_A),
  docs_changed: changed,
};

// Structural checks BEFORE the gates. A vacuous pass must not be recorded.
if (metrics.docs_changed < 2) {
  console.error(
    `\nSTRUCTURAL CHECK FAILED\n  ${metrics.docs_changed} document(s) diverged from the seed.\n` +
      `With fewer than two, no switch happened and every gate below would be asserting ` +
      `something about a single scene.\nNothing was written.`,
  );
  cleanup();
  process.exit(2);
}
if (!metrics.a_holds_own && !metrics.b_holds_own) {
  console.error(
    "\nSTRUCTURAL CHECK FAILED\n  neither sentence reached the store: the clicks or the " +
      "keystrokes never landed. Nothing here is a switching result.\nNothing was written.",
  );
  cleanup();
  process.exit(2);
}
console.log(`\nstructural check passed: ${metrics.docs_changed} documents diverged.\n`);

const verdicts = evaluateSwitchGates(metrics);
const path = writeResult(
  buildResult({
    workload: "app-switch",
    runId: "app-switch-tiny",
    candidate: "tauri",
    fixture: "tiny",
    verdicts,
    metrics: {
      workload_script: "switch-v1",
      peak_rss_mb: outcome.peakRssMb,
      startup_ms: outcome.payload.startup_ms,
      rows: outcome.payload.rows,
      opened_at_boot: outcome.payload.item_id,
      scene_a: sceneA.id,
      scene_b: sceneB.id,
      switch: metrics,
      // A few seconds of typing has nothing true to say about any of these,
      // and a11y probing is off.
      omitted_gates:
        "latency, stall, cliff, a11y_exposure: the run is seconds long and a11y probing is disabled",
      close_path: "unverified: no window manager under Xvfb; windowclose kills the process",
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
