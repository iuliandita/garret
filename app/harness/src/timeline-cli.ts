// app/harness/src/timeline-cli.ts
// Graded run over the timeline: does zooming a 2,000-event document
// stay fast, does the cull keep the DOM bounded, does an event created by
// double-click survive to the file, and does Open scene reach the linked
// scene.
//
// THE bible-cli / home-cli SHAPE: one seeded project, one boot, oracles that
// are the FILE wherever the file can answer (`timeline_event_round_trip`
// reads `doc.body` with a second `bun:sqlite` handle, never the page), and
// AT-SPI only where the file cannot say anything at all (a figure the page
// itself computed and painted, or that a scene is genuinely on screen).
//
// AN ANCHOR EVENT, NOT A BLIND COORDINATE. The corpus is 1,999 events spread
// over [0, 3000) plus ONE event at `at: 6000`, alone on its own track and the
// only one carrying a `scene` link -- far enough past the main cluster that
// `Fit`'s own 5% margin cannot pull a neighbour within `collapse`'s 24px
// gap, so it always renders as its own pill and never a dot. It is what
// `timeline_open_scene` presses, and its measured geometry (not a computed
// pixel) is what the round-trip test's double-click aims INTO THE GAP
// beside it -- the empty span between the cluster and the anchor, which the
// corpus never puts an event into by construction. Both reads are therefore
// anchored to REAL geometry the accessibility tree reports, not to a
// restated CSS constant this rig could drift from.
//
// Usage: APP_GUI=1 bun app/harness/src/timeline-cli.ts
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { evaluateTimelineGates, type TimelineMetrics } from "./gates";
import { locateNodes, type Node } from "./nodes";
import { nodeToPress, parsePressSelector, pressPoint } from "./press-selector";
import { buildResult, writeResult } from "./results";
import { generateTimelineCorpus } from "./timeline-corpus";
import { parseGeometry } from "./window-size";
import { BIN, SHELL_PROC_NAME, findWindowId, runShell, survivingShellPids, type RunOutcome } from "./shell";
import { PY_READ_NODES, PY_SELECT_APPS, pidListArg } from "./atspi";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

const MAX_DEPTH = 64;
/** Quick Open's own settle, the value `shot-cli` types against. */
const TYPE_SETTLE_MS = 2500;

const WINDOW = { w: 1200, h: 800 };
const SETTLE_MS = 2000;
const SAVE_MS = 1500;
/** After the 200 Ctrl+wheel notches, for the last paint's rAF and the status
 *  node's own repaint to land. */
const ZOOM_SETTLE_MS = 500;

/** The corpus's own shape (102's plan item 7): 1,999 background events over
 *  a 3,000-unit spread plus the one anchor at `at: 6000`, on `t1`, the only
 *  event carrying a scene link. */
const BACKGROUND_COUNT = 1999;
const SPREAD_UNITS = 3000;
const ANCHOR_AT = 6000;
const ANCHOR_TITLE = "Open scene target";
const ANCHOR_ID = "v-anchor";
/** 103's own additions: a branch to swap and an event to drag, both alone on
 *  `t1`, far from the background spread [0, 3000) and the scene anchor at
 *  6000 -- named uniquely so `nodeToPress` never has to disambiguate against
 *  the corpus. */
const BRANCH_ID = "b-swap";
const BRANCH_NAME = "Swap branch";
const BRANCH_FORK_AT = 0;
const DRAG_AT = -2000;
const DRAG_TITLE = "Drag target";
const DRAG_ID = "v-drag";
/** Where the empty-gap presses aim: this many units left of the anchor, half
 *  way across the 3,000-unit gap between the cluster and the anchor. */
const GAP_UNITS_LEFT_OF_ANCHOR = 1500;

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

if (process.env.APP_GUI !== "1") {
  console.log("timeline-cli: skipped (set APP_GUI=1 to run it)");
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

const workDir = mkdtempSync(join(tmpdir(), "app-timeline-"));
const fixtureCopy = join(workDir, "fixture");
const projectPath = join(workDir, "book.db");
function cleanup(): void {
  rmSync(workDir, { recursive: true, force: true });
}

// -------------------------------------------------------- the corpus

interface FixtureItem {
  id: string;
  type: string;
  title: string;
}

const fixtureProject = JSON.parse(readFileSync(join(FIXTURE, "project.json"), "utf8")) as {
  items: FixtureItem[];
};
const sceneItems = fixtureProject.items.filter((i) => i.type === "scene");
if (sceneItems.length === 0) {
  console.error(`${FIXTURE}/project.json holds no scene; timeline_open_scene has nothing to link to.`);
  cleanup();
  process.exit(1);
}
const linkedScene = sceneItems[0]!;

const corpus = generateTimelineCorpus({
  eventCount: BACKGROUND_COUNT,
  trackCount: 6,
  spreadUnits: SPREAD_UNITS,
  rangeFraction: 0.1,
  meetingFraction: 0.05,
  sceneLinkFraction: 0, // the anchor is the ONLY scene link; see the header.
  sceneIds: [],
  seed: 102, // the slice number, for a seed a reader can explain.
});
const events = corpus.events as Record<string, unknown>[];
const firstTrackId = (corpus.tracks as { id: string }[])[0]!.id;
events.push({
  id: ANCHOR_ID,
  title: ANCHOR_TITLE,
  at: ANCHOR_AT,
  until: null,
  tracks: [firstTrackId],
  branch: null,
  scene: linkedScene.id,
  cast: [],
  note: "",
});
events.push({
  id: DRAG_ID,
  title: DRAG_TITLE,
  at: DRAG_AT,
  until: null,
  tracks: [firstTrackId],
  branch: null,
  scene: null,
  cast: [],
  note: "",
});
const branches = corpus.branches as Record<string, unknown>[];
branches.push({ id: BRANCH_ID, name: BRANCH_NAME, forkAt: BRANCH_FORK_AT, forkTrack: firstTrackId, writing: false });

console.log(`[1/8] seeding ${BACKGROUND_COUNT + 2} events, 1 branch (${FIXTURE} + a generated timeline)`);
cpSync(FIXTURE, fixtureCopy, { recursive: true });
writeFileSync(
  join(fixtureCopy, "timelines.ndjson"),
  `${JSON.stringify({ id: "tl-1", title: "Timeline", body: corpus })}\n`,
);
{
  const seeded = Bun.spawnSync([BIN, "--seed", fixtureCopy, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) {
    console.error(`seeding failed (exit ${seeded.exitCode}); nothing was written.`);
    cleanup();
    process.exit(1);
  }
}

// -------------------------------------------------------- the store oracle

interface WalkRow {
  id: string;
  type: string;
  title: string;
  parent_id: string | null;
}

function walk(path: string): WalkRow[] {
  const db = new Database(path, { readonly: true });
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
         SELECT id, type, title, parent_id FROM walk ORDER BY path`,
      )
      .all() as WalkRow[];
  } finally {
    db.close();
  }
}

function docBody(path: string, itemId: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT body FROM doc WHERE item_id = ?1").get(itemId) as
      | { body: string }
      | undefined;
    return row?.body ?? null;
  } finally {
    db.close();
  }
}

const seedWalk = walk(projectPath);
const timelineRow = seedWalk.find((r) => r.type === "timeline");
if (timelineRow === undefined) {
  console.error("the seeded project holds no timeline row; nothing to open.");
  cleanup();
  process.exit(1);
}
const timelineIndex = seedWalk.findIndex((r) => r.id === timelineRow.id);

// -------------------------------------------------------- the small id probe

/** `#timeline-status` and `#scene-heading`: plain text containers `nodes.ts`'s
 *  role-restricted walk does not reach, `home-cli`'s own `PY_READ_NODES`
 *  shape, restated here per this harness's rule that a probe belongs to the
 *  rig that reads it. */

function readNodeTexts(rootPid: number, ids: readonly string[]): Record<string, string> {
  try {
    const proc = Bun.spawnSync(["python3", "-c", PY_READ_NODES, pidListArg(rootPid), ids.join(",")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return {};
    return JSON.parse(proc.stdout.toString()) as Record<string, string>;
  } catch {
    return {};
  }
}

/** `#timeline-status`'s exact wording (`timeline.status`, en.ts): "zoom p95
 *  {p95} ms, visible {visible}". */
function parseStatus(text: string): { p95: number; visible: number; pxPerUnit: number } {
  const p95 = /zoom p95 (\d+) ms/.exec(text);
  const visible = /visible (\d+)/.exec(text);
  // `timeline.status`'s third figure (103, plan item 7): the page's own
  // live scale, so `timeline_drag_moves` never restates a pixel-to-unit
  // constant this rig could drift from as the view zooms.
  const pxPerUnit = /px per unit ([\d.]+)/.exec(text);
  return {
    p95: p95 !== null ? Number(p95[1]) : 999_999,
    visible: visible !== null ? Number(visible[1]) : 999_999,
    pxPerUnit: pxPerUnit !== null ? Number(pxPerUnit[1]) : -1,
  };
}

function xdo(display: string, args: string[]): void {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
}

// -------------------------------------------------------- the boot

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

let zoomP95Ms = 999_999;
let visibleAfterFit = 999_999;
let visibleAfterFitAtspi = 999_999;
let roundTrip = false;
let openScene = false;
let branchSwap = false;
let dragMoves = false;
/** Recorded in `metrics` (coordinator follow-up) so a run that PASSED on a
 *  tolerance wide enough to accept a zero-move drag is visible in the file
 *  itself, not just in this rig's own reasoning. */
let dragToleranceUnits = 0;
let diagnostic = "";

const createdTitle = "Round-trip event";

console.log(`[2/8] booting on ${projectPath} (${seedWalk.length} rows, timeline row ${timelineIndex})`);
let outcome: RunOutcome<InteractiveSinkPayload>;
try {
  outcome = await runShell<InteractiveSinkPayload>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", APP_PROJECT: projectPath, GDK_BACKEND: "x11" },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("timeline-cli requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowsize", wid, String(WINDOW.w), String(WINDOW.h)]);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["windowfocus", wid]);
      // Read back and honoured, `bible-cli`'s own reason: every coordinate
      // below assumes the window it asked for.
      const geometryText = new TextDecoder().decode(
        Bun.spawnSync(["xdotool", "getwindowgeometry", "--shell", wid], {
          env: { ...process.env, DISPLAY: display },
          stdout: "pipe",
        }).stdout,
      );
      const geometry = parseGeometry(geometryText);
      if (geometry.height !== WINDOW.h || geometry.width !== WINDOW.w) {
        throw new Error(
          `the window is ${geometry.width}x${geometry.height} after asking for ${WINDOW.w}x${WINDOW.h}`,
        );
      }

      // THROUGH QUICK OPEN, NOT A COMPUTED ROW COORDINATE (shot-cli's own
      // rule for a specific row): the timeline is the 41st row of this
      // fixture, below the pane of an 800px window, and the first version of
      // this rig aborted on exactly that arithmetic. Ctrl+P, the title,
      // Return is the route a writer takes and does not drift with the
      // navigator's row height or the bible's position among the roots.
      // "Timeline" (`timeline.untitled`) is unique in the seeded fixture.
      console.log("[3/8] opening the timeline row through Quick Open");
      xdo(display, ["key", "--window", wid, "ctrl+p"]);
      await Bun.sleep(TYPE_SETTLE_MS);
      xdo(display, ["type", "--window", wid, "--delay", "20", "Timeline"]);
      await Bun.sleep(TYPE_SETTLE_MS);
      xdo(display, ["key", "--window", wid, "Return"]);
      await Bun.sleep(SETTLE_MS);

      console.log("[4/8] Fit, then reading #timeline-status");
      let nodes: readonly Node[] = locateNodes(rootPid);
      const fitBtn = nodeToPress(nodes, parsePressSelector("name:Fit"), "timeline-cli");
      const fitAt = pressPoint(fitBtn, { width: WINDOW.w, height: WINDOW.h });
      xdo(display, ["mousemove", "--window", wid, String(fitAt.x), String(fitAt.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(SAVE_MS);

      const afterFitStatus = readNodeTexts(rootPid, ["timeline-status"])["timeline-status"] ?? "";
      visibleAfterFit = parseStatus(afterFitStatus).visible;
      nodes = locateNodes(rootPid);
      // Event buttons by title, dot buttons by their `timeline.dot.count`
      // label: after Fit the 2,000-event corpus is mostly dots, and a count
      // of titled events alone read 0.
      const isLaneButton = (n: Node): boolean =>
        (n.role === "push button" || n.role === "button") &&
        (/^Event \d+$/.test(n.name) || n.name === ANCHOR_TITLE || / events? here$/.test(n.name));
      visibleAfterFitAtspi = nodes.filter(isLaneButton).length;
      console.log(`  [probe] after Fit: status "${afterFitStatus}", lane buttons in the tree ${visibleAfterFitAtspi}`);

      console.log("[5/8] the anchor's geometry: zoom p95 stress, the round-trip create");
      const anchorBtn = nodeToPress(nodes, parsePressSelector(`name:${ANCHOR_TITLE}`), "timeline-cli");
      // 200 Ctrl+wheel notches, aimed at the empty gap beside the anchor
      // rather than into the dense cluster -- the point measured is the
      // PAINT cost, and an empty target still culls and repaints exactly
      // as a full one does. 100 IN THEN 100 OUT (NIT, review item 13), not
      // 200 all one direction: ZOOM_FACTOR is 1.15 per notch and
      // MAX_PX_PER_UNIT clamps at 64, which a run of 200 notches all
      // zooming in reaches after about 40 -- the remaining ~160 notches
      // would each repaint the SAME clamped view, measuring a p95 over a
      // mostly-unchanging scale rather than over the range Ctrl+wheel
      // actually covers in use. Splitting the run crosses the clamp on
      // BOTH ends (in near button 4's own count, out near button 5's),
      // so every notch after the first ~40 still changes the view.
      const pointerAt = pressPoint(anchorBtn, { width: WINDOW.w, height: WINDOW.h });
      // IN UNITS, NOT A FIXED 200px: the gap between the cluster's end
      // (SPREAD_UNITS) and the anchor is 3,000 units wide, and its width in
      // pixels is whatever Fit made it. With 103's drag target at -2,000 the
      // span doubled and a fixed 200px left of the anchor landed INSIDE the
      // cluster, on a dot, which the layer's dblclick handler ignores.
      const pxPerUnitAtFit = parseStatus(afterFitStatus).pxPerUnit;
      const gapOffsetPx = Math.max(24, Math.round(GAP_UNITS_LEFT_OF_ANCHOR * pxPerUnitAtFit));
      // From the box's LEFT edge (its `at`), not its centre: the anchor's
      // label is ~130px wide, and an offset from the centre put the created
      // event within collapse's 24px of the anchor, into one dot.
      const gapX = Math.max(0, anchorBtn.x - gapOffsetPx);
      xdo(display, ["mousemove", "--window", wid, String(gapX), String(pointerAt.y)]);
      xdo(display, ["keydown", "ctrl"]);
      xdo(display, ["click", "--repeat", "100", "--delay", "20", "4"]);
      xdo(display, ["click", "--repeat", "100", "--delay", "20", "5"]);
      xdo(display, ["keyup", "ctrl"]);
      await Bun.sleep(ZOOM_SETTLE_MS);
      const afterZoomStatus = readNodeTexts(rootPid, ["timeline-status"])["timeline-status"] ?? "";
      zoomP95Ms = parseStatus(afterZoomStatus).p95;

      // Fit again: the 200 notches left the view zoomed onto the gap, and
      // both remaining checks need the anchor and the empty space beside it
      // back on screen.
      nodes = locateNodes(rootPid);
      const fitAgain = nodeToPress(nodes, parsePressSelector("name:Fit"), "timeline-cli");
      const fitAgainAt = pressPoint(fitAgain, { width: WINDOW.w, height: WINDOW.h });
      xdo(display, ["mousemove", "--window", wid, String(fitAgainAt.x), String(fitAgainAt.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(SAVE_MS);

      nodes = locateNodes(rootPid);
      const anchorAgain = nodeToPress(nodes, parsePressSelector(`name:${ANCHOR_TITLE}`), "timeline-cli");
      const anchorPoint = pressPoint(anchorAgain, { width: WINDOW.w, height: WINDOW.h });
      const clickX = Math.max(0, anchorAgain.x - gapOffsetPx);
      xdo(display, ["mousemove", "--window", wid, String(clickX), String(anchorPoint.y)]);
      xdo(display, ["click", "--repeat", "2", "--delay", "150", "1"]);
      await Bun.sleep(SETTLE_MS);
      {
        const probeNodes = locateNodes(rootPid);
        const untitled = probeNodes.filter((n) => n.name === "Untitled event").length;
        const cardFields = probeNodes.filter((n) => n.role === "text" || n.role === "entry").map((n) => `${n.role}:${n.name}`);
        const statusNow = readNodeTexts(rootPid, ["timeline-status"])["timeline-status"] ?? "";
        console.log(`  [probe] after double-click at ${clickX},${anchorPoint.y}: status "${statusNow}", "Untitled event" nodes ${untitled}, text fields ${JSON.stringify(cardFields)}`);
      }
      xdo(display, ["key", "ctrl+a"]);
      xdo(display, ["type", "--delay", "40", createdTitle]);
      xdo(display, ["key", "Return"]);
      await Bun.sleep(SAVE_MS);

      const body = docBody(projectPath, timelineRow.id);
      if (body === null) {
        diagnostic = "the timeline row has no doc body after the round-trip create";
      } else {
        try {
          const parsed = JSON.parse(body) as { events: { title: string; at: number }[] };
          roundTrip = parsed.events.some((e) => e.title === createdTitle);
          if (!roundTrip) {
            // Say WHICH half failed: a double-click that created nothing
            // leaves the seeded count; one that created but did not title
            // leaves an extra event, whose title and `at` name the card's
            // state at Return.
            const extra = parsed.events.filter((e) => !/^Event \d+$/.test(e.title) && e.title !== ANCHOR_TITLE);
            diagnostic =
              `the file's events carry no title "${createdTitle}"; ${parsed.events.length} events in the file` +
              (extra.length === 0 ? "" : `, unseeded: ${extra.map((e) => `"${e.title}" at ${e.at}`).join(", ")}`);
          }
        } catch (err) {
          diagnostic = `the timeline body did not parse as JSON: ${String(err)}`;
        }
      }

      console.log("[6/8] pressing the seeded branch's 'Make this the one I am writing'");
      nodes = locateNodes(rootPid);
      const writeBtn = nodeToPress(nodes, parsePressSelector("name:Make this the one I am writing"), "timeline-cli");
      const writeAt = pressPoint(writeBtn, { width: WINDOW.w, height: WINDOW.h });
      xdo(display, ["mousemove", "--window", wid, String(writeAt.x), String(writeAt.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(SAVE_MS);
      {
        const afterSwapBody = docBody(projectPath, timelineRow.id);
        if (afterSwapBody === null) {
          diagnostic += `${diagnostic === "" ? "" : "; "}no doc body after the branch swap`;
        } else {
          try {
            const parsed = JSON.parse(afterSwapBody) as { branches: { id: string; writing: boolean }[] };
            const branch = parsed.branches.find((b) => b.id === BRANCH_ID);
            branchSwap = branch?.writing === true;
            if (!branchSwap) {
              diagnostic += `${diagnostic === "" ? "" : "; "}branch "${BRANCH_ID}" writing reads ${JSON.stringify(branch?.writing)}, wanted true`;
            }
          } catch (err) {
            diagnostic += `${diagnostic === "" ? "" : "; "}the timeline body did not parse as JSON after the branch swap: ${String(err)}`;
          }
        }
      }

      console.log("[7/8] dragging the drag-target event 100px right");
      nodes = locateNodes(rootPid);
      const dragBtn = nodeToPress(nodes, parsePressSelector(`name:${DRAG_TITLE}`), "timeline-cli");
      const dragStart = pressPoint(dragBtn, { width: WINDOW.w, height: WINDOW.h });
      const statusBeforeDrag = readNodeTexts(rootPid, ["timeline-status"])["timeline-status"] ?? "";
      const pxPerUnitBeforeDrag = parseStatus(statusBeforeDrag).pxPerUnit;
      const DRAG_PX = 100;
      // BOUNDED AGAINST THE WINDOW BEFORE THE DRAG RUNS (review, MINOR):
      // `pressPoint` only guards the PRESS point, not the 100px the drag
      // moves it by. A later change putting the drag target near the right
      // edge would otherwise move the mouse outside the window mid-drag and
      // fail the gate for the wrong reason (a stray click, not a broken
      // drag) -- caught here, with the coordinates, instead.
      if (dragStart.x + DRAG_PX >= WINDOW.w) {
        cleanup();
        throw new Error(
          `the drag target's press point (${dragStart.x}, ${dragStart.y}) plus DRAG_PX (${DRAG_PX}) reaches ` +
            `${dragStart.x + DRAG_PX}, at or past the window's own width (${WINDOW.w}); move DRAG_AT or ANCHOR_AT.`,
        );
      }
      xdo(display, ["mousemove", "--window", wid, String(dragStart.x), String(dragStart.y)]);
      xdo(display, ["mousedown", "1"]);
      // A FEW INTERMEDIATE MOVES, not one jump: `PAN_THRESHOLD_PX` (4px)
      // only arms the drag once movement is SEEN, and this WebKitGTK's own
      // pointermove coalescing has dropped a single synthetic jump before.
      xdo(display, ["mousemove", "--window", wid, String(dragStart.x + 20), String(dragStart.y)]);
      xdo(display, ["mousemove", "--window", wid, String(dragStart.x + 60), String(dragStart.y)]);
      xdo(display, ["mousemove", "--window", wid, String(dragStart.x + DRAG_PX), String(dragStart.y)]);
      xdo(display, ["mouseup", "1"]);
      await Bun.sleep(SAVE_MS);
      {
        const afterDragBody = docBody(projectPath, timelineRow.id);
        if (afterDragBody === null || pxPerUnitBeforeDrag <= 0) {
          diagnostic += `${diagnostic === "" ? "" : "; "}no doc body, or no readable px-per-unit (${pxPerUnitBeforeDrag}), after the drag`;
        } else {
          try {
            const parsed = JSON.parse(afterDragBody) as { events: { id: string; at: number }[] };
            const dragged = parsed.events.find((e) => e.id === DRAG_ID);
            if (dragged === undefined) {
              diagnostic += `${diagnostic === "" ? "" : "; "}event "${DRAG_ID}" is missing after the drag`;
            } else {
              const expectedDeltaUnits = Math.round(DRAG_PX / pxPerUnitBeforeDrag);
              const actualDeltaUnits = dragged.at - DRAG_AT;
              // The tolerance is what the status node's precision allows,
              // not a bare 1: it prints px-per-unit to four decimals, and at
              // 0.0536 half of the last digit (0.00005) is worth
              // 100 * 0.00005 / 0.0536^2 = 1.7 units over a 100px drag. Plus
              // one for the page's own snap-to-unit rounding. The first run
              // read 1,864 for an expected 1,866 and failed on the bare 1.
              const statusHalfDigit = 0.00005;
              const tolerance = Math.ceil((DRAG_PX * statusHalfDigit) / (pxPerUnitBeforeDrag * pxPerUnitBeforeDrag)) + 1;
              dragToleranceUnits = tolerance;
              // UNFALSIFIABLE PAST THIS POINT (review, MINOR): once
              // `expectedDeltaUnits` itself is only 1 or 2, "within one
              // unit" (or a tolerance built from it) also accepts a drag
              // that moved nothing at all -- safe at the corpus's current
              // Fit (~0.12 px/unit, expecting ~833), but the gate must not
              // quietly depend on that staying true. Fails loudly instead
              // of passing on a tolerance wide enough to hide a broken drag.
              if (expectedDeltaUnits <= 2) {
                diagnostic += `${diagnostic === "" ? "" : "; "}expectedDeltaUnits is only ${expectedDeltaUnits} (px-per-unit ${pxPerUnitBeforeDrag} too coarse for a ${DRAG_PX}px drag to prove anything); the gate cannot be falsified at this scale`;
              } else {
                dragMoves = Math.abs(actualDeltaUnits - expectedDeltaUnits) <= tolerance;
                if (!dragMoves) {
                  diagnostic += `${diagnostic === "" ? "" : "; "}drag moved "at" by ${actualDeltaUnits} units, expected ${expectedDeltaUnits} within ${tolerance} (${DRAG_PX}px / ${pxPerUnitBeforeDrag} px-per-unit)`;
                }
              }
            }
          } catch (err) {
            diagnostic += `${diagnostic === "" ? "" : "; "}the timeline body did not parse as JSON after the drag: ${String(err)}`;
          }
        }
      }

      // LAST among the presses: Open scene replaces the view with the scene,
      // so the swap and the drag above must run while the lanes still exist
      // (the first run of this rig found no timeline control in the tree at
      // step 6, because step 5 had already opened the scene).
      nodes = locateNodes(rootPid);
      const anchorForScene = nodeToPress(nodes, parsePressSelector(`name:${ANCHOR_TITLE}`), "timeline-cli");
      const anchorScenePoint = pressPoint(anchorForScene, { width: WINDOW.w, height: WINDOW.h });
      xdo(display, ["mousemove", "--window", wid, String(anchorScenePoint.x), String(anchorScenePoint.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(SAVE_MS);
      nodes = locateNodes(rootPid);
      const openSceneBtn = nodeToPress(nodes, parsePressSelector("name:Open scene"), "timeline-cli");
      const openSceneAt = pressPoint(openSceneBtn, { width: WINDOW.w, height: WINDOW.h });
      xdo(display, ["mousemove", "--window", wid, String(openSceneAt.x), String(openSceneAt.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(SAVE_MS);
      const heading = readNodeTexts(rootPid, ["scene-heading"])["scene-heading"] ?? "";
      openScene = heading === linkedScene.title;
      if (!openScene) {
        diagnostic += `${diagnostic === "" ? "" : "; "}#scene-heading reads "${heading}", wanted "${linkedScene.title}"`;
      }

      console.log("[8/8] Open scene from the anchor's card, then closing the window");
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(2000);
    },
  });
} catch (err: unknown) {
  cleanup();
  throw err;
}

if (!outcome.payload.ready) {
  console.error(
    `\nSTRUCTURAL CHECK FAILED\n  never sank a ready payload: ${outcome.payload.error ?? "no reason given"}.\n` +
      "Nothing was written.",
  );
  cleanup();
  process.exit(2);
}
if (diagnostic !== "") console.log(`  [diagnostic] ${diagnostic}`);

const metrics: TimelineMetrics = {
  timeline_zoom_p95_ms: zoomP95Ms,
  timeline_visible_count: visibleAfterFitAtspi,
  timeline_event_round_trip: roundTrip,
  timeline_open_scene: openScene,
  timeline_branch_swap: branchSwap,
  timeline_drag_moves: dragMoves,
};

const verdicts = evaluateTimelineGates(metrics);
const written = writeResult(
  buildResult({
    workload: "app-timeline",
    runId: "app-timeline-tiny",
    candidate: "tauri",
    fixture: "tiny",
    verdicts,
    metrics: {
      ...metrics,
      timeline_visible_status_count: visibleAfterFit,
      timeline_event_count: BACKGROUND_COUNT + 1,
      timeline_diagnostic: diagnostic,
      timeline_drag_tolerance_units: dragToleranceUnits,
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

cleanup();
console.log(`\nrecorded: ${written}`);
for (const v of verdicts) console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
if (verdicts.some((v) => v.verdict === "FAIL")) process.exit(1);
