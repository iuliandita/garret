// app/harness/src/prefs-cli.ts
// Graded typography-preferences run. Nine boots, ONE AT-SPI walk each.
//
// The panel is reached through the APPLICATION MENU (File > Preferences…), not
// through a bar button: the retirement slice deleted #prefs-toggle and the menu
// is the only route in. The keystrokes come from the shared `menu-drive` module,
// whose index is parsed out of `menu-bar.ts` rather than restated — an item
// inserted above Preferences moves this rig with it.
//
// That route costs NO walk, which is what took the click phase from two walks to
// one: the toggle used to be located by extents before it could be pressed.
//
// What this rig can see that a screenshot cannot: that the preference survives a
// restart, and that the RENDERING ENGINE actually reflowed. Both extent gates
// read the editable's box off a live AT-SPI tree, which is a different subsystem
// from the CSSOM — a page that reported its intended styles while rendering none
// of them would satisfy any getComputedStyle check and fail these.
//
// What it cannot see, and the screenshots beside the slice carry instead:
// whether 23px Mono over a narrow column is a page a person can read.
//
// ONE WALK PER WINDOW. Several walks in one window kill the application outright
// — cleanly, with nothing on stderr, taking the X server with it. That is why
// this is nine boots rather than one run that changes a preference and re-reads:
// the same shape find-cli uses, and for the same recorded reason.
//
// The editor is focused by clicking a point computed from the window geometry
// the rig itself sets, NOT from the editable's extents. Reading the extents
// first would be a second walk, and the corner-click other rigs use is unsafe
// here by construction: this rig deliberately makes the page OVERFLOW, which is
// exactly when `entry.y + entry.h - 4` falls outside the window.
//
// Usage: APP_GUI=1 bun app/harness/src/prefs-cli.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { evaluatePrefsGates, type PrefsMetrics, type ProseBox } from "./gates";
import { buildResult, writeResult } from "./results";
import { menuDriver } from "./menu-drive";
import { centreOf, locateNodes } from "./nodes";
import { type PrefsInputEvidence, waitForExactBootSceneText } from "./prefs-input";
import { BIN, SHELL_PROC_NAME, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

// The one geometry constant this rig OWNS rather than restates, the same move
// outline-cli made. 1400 because the measure gate is dead at the default 900:
// the editor pane is then about 532px and every measure caps against it, so the
// gate would compare a number to itself. At 1400 the pane is wide enough for the
// widest column to be limited by the MEASURE.
const WINDOW_W = 1400;
const WINDOW_H = 900;
// The shared SERVER_ARGS give Xvfb a 1280px screen, which is wider than the
// shell's own default window and has been enough for every rig so far. It is NOT
// enough for this one: a 1400px window extends past the screen, and the pointer
// is CLAMPED TO THE SCREEN, so anything living on the right-hand side of the
// window could never be clicked. The click lands off the right edge and reads
// exactly like the control being broken.
//
// STILL REQUIRED after the menu port, for a different control than before. The
// original reason was #prefs-toggle at x=1339, and that button no longer exists
// — the panel is opened by keystroke now, which is clamped by nothing. But
// #prefs-panel is `position: absolute; right: 12px` against #project-bar, so in
// a 1400px window its buttons sit far past 1280 and the three clicks that choose
// the preference would all land off-screen. The window itself must stay 1400
// wide for the measure gate (below), so the screen must stay wider than it.
//
// -s 0 and -noreset are carried over unchanged; only the screen is wider.
const SERVER_ARGS_WIDE = "-screen 0 1600x1024x24 -s 0 -noreset";
// Restated from style.css: --nav-width, and #editor's 24px padding on both
// sides. Used only by the cap guard below, never to place a click.
const NAV_W = 320;
const EDITOR_PADDING = 24;
const PANE_W = WINDOW_W - NAV_W - 2 * EDITOR_PADDING;

/** xdotool type/click returns when X has the events, not when WebKitGTK has
 *  acted on them. hand-cli.ts found 500 ms silently truncating; 2500 ms held
 *  for the 40-repeat passage at 15px -- and then silently truncated the
 *  56-repeat passage at 17px, reading 814px where the full text is
 *  1398px. So the passage is no longer read after a fixed wait: the box is
 *  polled until two readings a second apart agree (see `settledBox`), and
 *  this constant is what the resize and the click still wait. */
const SETTLE_MS = 2500;
/** After exact persisted input is verified, wait for layout to stop changing.
 *  Two equal readings in a row, and a ceiling that turns a wedged page into
 *  an abort rather than a plausible number. The ceiling is generous because
 *  a READING IS A WALK: `locateNodes` took ~18 s per call on the measurement machine
 *  under a load of 3, so two readings are ~40 s, and a 30 s ceiling aborted
 *  the mono boot after exactly one. Typing itself is ~7 s of xdotool for the
 *  56-repeat passage before WebKit has consumed any of it. */
const STABLE_POLL_MS = 1000;
const STABLE_CEILING_MS = 120_000;
// The long mono passage can still be reaching WebKit after a short write wait.
const COMMIT_TIMEOUT_MS = STABLE_CEILING_MS;
const COMMIT_POLL_MS = 100;

/** Long enough that the page overflows a 900px window at the SMALLEST size,
 *  which is what makes the height comparison a measurement rather than two
 *  readings of `min-height: 100%`. Measured: 1082px at small when small was
 *  15px and 40 repeats; 1398px at 17px and 56 repeats. The figure the
 *  run prints is the measurement. Deterministic and identical in every boot,
 *  because two boxes are compared for exact equality below. */
// End at the final period: WebKit stores a trailing typed space as NBSP.
const PASSAGE = "The harbour kept its own accounts and settled them nightly with the tide. "
  .repeat(56)
  .trimEnd();

interface Preference {
  family: string;
  size: string;
  measure: string;
}

const DEFAULTS: Preference = { family: "serif", size: "medium", measure: "medium" };
const spell = (p: Preference): string => `${p.family}/${p.size}/${p.measure}`;

/** What the panel is clicked to, and therefore what the restart must render.
 *  Every axis differs from its default, so an axis that never left the panel is
 *  visible in the recorded string rather than hidden behind a value it already
 *  had. */
const CHOSEN: Preference = { family: "mono", size: "larger", measure: "medium" };

function xdo(display: string, args: string[]): string {
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

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function fail(why: string): never {
  console.error(`${why}; nothing was written.`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

/** Resize and VERIFY. A resize that silently did not take would leave every
 *  measurement below describing a 900px window, and the cap guard would then be
 *  reading the wrong pane width. */
function resize(display: string, wid: string): void {
  xdo(display, ["windowsize", wid, String(WINDOW_W), String(WINDOW_H)]);
  const geometry = xdo(display, ["getwindowgeometry", wid]);
  if (!geometry.includes(`${WINDOW_W}x${WINDOW_H}`)) {
    throw new Error(`window did not resize to ${WINDOW_W}x${WINDOW_H}: ${geometry.trim()}`);
  }
}

/** The editable's box, after replacing the scene's prose with a fixed passage.
 *  One boot, one walk, one reading. */
async function measureBox(label: string, preference: Preference | null, dataHome: string): Promise<{
  box: ProseBox;
  peakRssMb: number;
  input: PrefsInputEvidence;
}> {
  if (preference !== null) writePreference(dataHome, preference);
  const projectPath = join(root, `${label}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) fail(`seeding ${label} failed (exit ${seeded.exitCode})`);

  // A rig local assigned only inside a closure narrows to `null` for the rest of
  // the file, so `if (box === null) fail()` type-checks while asserting nothing
  // -- `never` is assignable to anything. A mutable record resets the narrowing.
  const captured: { box: ProseBox | null; input: PrefsInputEvidence | null } = { box: null, input: null };
  const outcome = await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    serverArgs: SERVER_ARGS_WIDE,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      XDG_DATA_HOME: dataHome,
      // Load-bearing: a developer's ambient session sets WAYLAND_DISPLAY and
      // GTK prefers Wayland, so the webview would open on the real desktop
      // instead of the Xvfb display xdotool targets.
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("prefs rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      await Bun.sleep(SETTLE_MS);
      resize(display, wid);
      await Bun.sleep(1200);
      xdo(display, ["windowfocus", wid]);

      // A point inside the page, computed from the window geometry this rig
      // just set rather than from the editable's extents — reading those would
      // be a second walk in this window. x is past the navigator and inside the
      // narrowest column the rig ever renders; y is below both bars and inside
      // the page's first lines.
      xdo(display, ["mousemove", "--window", wid, "700", "300"]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(500);
      // Replaced, not appended: two boots are compared for exact equality, so
      // the prose has to be the rig's and only the rig's.
      xdo(display, ["key", "ctrl+a"]);
      xdo(display, ["type", "--delay", "1", PASSAGE]);
      // Geometry can settle while WebKit has committed a prefix, or while the
      // input landed in another scene. Read the seeded file's normal boot scene
      // until its parsed text is byte-for-byte the passage, trailing spaces too.
      captured.input = await waitForExactBootSceneText(projectPath, PASSAGE, {
        timeoutMs: COMMIT_TIMEOUT_MS,
        pollMs: COMMIT_POLL_MS,
      });
      captured.box = await settledBox(label, rootPid);
    },
  }).catch((error: unknown) => {
    // runShell has released its process group before temporary data is removed.
    rmSync(root, { recursive: true, force: true });
    throw error;
  });

  if (captured.box === null || captured.input === null) fail(`${label} produced no verified reading`);
  const got: ProseBox = captured.box;
  console.log(`  ${label.padEnd(20)} ${got.w}x${got.h}`);
  return { box: got, peakRssMb: outcome.peakRssMb, input: captured.input };
}

/** The editable's box once it has stopped changing: WebKit is still consuming
 *  the typed passage for seconds after xdotool returns, and a reading taken
 *  mid-way is a shorter page that looks exactly like a real one. */
async function settledBox(label: string, rootPid: number): Promise<ProseBox> {
  let previous: ProseBox | null = null;
  const deadline = Date.now() + STABLE_CEILING_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(STABLE_POLL_MS);
    const nodes = locateNodes(rootPid);
    const editable = nodes.find((n) => n.role === "entry" || n.role === "text");
    if (editable === undefined) {
      throw new Error(
        `no editable in the accessibility tree for ${label}. Roles seen: ` +
          `${nodes.map((n) => n.role).join(", ") || "none"}`,
      );
    }
    const box: ProseBox = { w: editable.w, h: editable.h };
    if (previous !== null && previous.w === box.w && previous.h === box.h) return box;
    previous = box;
  }
  throw new Error(`${label}: the page was still growing after ${STABLE_CEILING_MS} ms`);
}

function settingsPath(dataHome: string): string {
  return join(dataHome, "cc.local.app", "settings.json");
}

function writePreference(dataHome: string, preference: Preference): void {
  mkdirSync(join(dataHome, "cc.local.app"), { recursive: true });
  writeFileSync(settingsPath(dataHome), JSON.stringify({ typography: preference }));
}

function readPreference(dataHome: string): Preference {
  const path = settingsPath(dataHome);
  if (!existsSync(path)) return DEFAULTS;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const held = (parsed as { typography?: Partial<Preference> }).typography ?? {};
  return {
    family: held.family ?? DEFAULTS.family,
    size: held.size ?? DEFAULTS.size,
    measure: held.measure ?? DEFAULTS.measure,
  };
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; preferences run skipped (needs a display and a built shell).");
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

const root = mkdtempSync(join(tmpdir(), "app-prefs-"));
// One data home per boot, so a reading can never be answered by a preference
// another phase left behind. The restart pair below deliberately SHARES one,
// which is the whole point of that pair.
const homeFor = (label: string): string => {
  const dir = join(root, `home-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

console.log("[1/5] the type size, at one measure and one font");
const small = await measureBox("size-small", { ...DEFAULTS, size: "small" }, homeFor("small"));
const larger = await measureBox("size-larger", { ...DEFAULTS, size: "larger" }, homeFor("larger"));

// With `min-height: 100%` a page that fits its pane is exactly the pane's height
// at every size, so two clamped figures would compare equal and the gate would
// report a defect that is the rig's. The passage is sized to overflow at the
// SMALLER of the two, which is the harder case.
if (small.box.h <= WINDOW_H || larger.box.h <= WINDOW_H) {
  fail(
    `the prose did not overflow the ${WINDOW_H}px window (small ${small.box.h}px, ` +
      `larger ${larger.box.h}px), so the height comparison would be two readings of min-height`,
  );
}

console.log("[2/5] the font, at one size and one measure");
const serif = await measureBox("family-serif", { ...DEFAULTS, family: "serif" }, homeFor("serif"));
const mono = await measureBox("family-mono", { ...DEFAULTS, family: "mono" }, homeFor("mono"));

console.log("[3/5] the measure, at one size");
const narrow = await measureBox("measure-narrow", { ...DEFAULTS, measure: "narrow" }, homeFor("narrow"));
const wide = await measureBox("measure-wide", { ...DEFAULTS, measure: "wide" }, homeFor("wide"));

// A column capped by the pane rather than by its own max-width is a reading of
// the window. This is the failure the 1400px resize exists to avoid, and it is
// checked rather than assumed.
// EVERY box, not just the widest one: `larger` at the default measure is 897px
// and would cap against a pane only a little narrower than this one. A capped
// column is a reading of the window, and grading one silently is exactly the
// shape of defect the two extent gates exist to avoid.
for (const [label, box] of [
  ["size-small", small.box],
  ["size-larger", larger.box],
  ["family-serif", serif.box],
  ["family-mono", mono.box],
  ["measure-narrow", narrow.box],
  ["measure-wide", wide.box],
] as const) {
  if (box.w >= PANE_W - 1) {
    fail(
      `${label} came back ${box.w}px wide against a ${PANE_W}px pane, so the column is capped by ` +
        `the window rather than by its own measure`,
    );
  }
}

console.log(`[4/5] File > Preferences…, then clicking the SHIPPED panel through to ${spell(CHOSEN)}`);
const restartHome = homeFor("restart");
const clickProject = join(root, "clicked.db");
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, clickProject], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) fail(`seeding the click phase failed (exit ${seeded.exitCode})`);
}

await runShell({
  mode: "virtual",
  soakMs: 0,
  staged: DIST,
  serverArgs: SERVER_ARGS_WIDE,
  env: {
    APP_RUN: "interactive",
    APP_PROJECT: clickProject,
    XDG_DATA_HOME: restartHome,
    GDK_BACKEND: "x11",
  },
  probeA11y: false,
  onReady: async ({ displayNum, rootPid }) => {
    if (displayNum === null) throw new Error("prefs rig requires a fixed X display");
    const display = `:${displayNum}`;
    const wid = findWindowId(display);
    await Bun.sleep(SETTLE_MS);
    resize(display, wid);
    await Bun.sleep(1200);
    xdo(display, ["windowfocus", wid]);

    // The panel is closed at boot, so its buttons do not exist yet — and as of
    // the retirement slice there is no bar button to press either. File >
    // Preferences… opens it, driven entirely by keystrokes, so this costs NO
    // walk at all: this window used to spend one locating #prefs-toggle before
    // it could press it, and that is the walk the port removes.
    //
    // The item's index is READ from `menu-bar.ts` by `menu-drive`, never
    // restated: an item inserted above Preferences would otherwise press Return
    // on the item above it, silently, and the rig would report whatever that
    // item did.
    const driver = menuDriver(display, wid, xdo);
    await driver.activate("menu-preferences");
    await Bun.sleep(SETTLE_MS);

    // The one and only walk in this window, once the panel's buttons exist.
    const open = locateNodes(rootPid);
    for (const [group, value] of [
      ["family", CHOSEN.family],
      ["size", CHOSEN.size],
      ["measure", CHOSEN.measure],
    ]) {
      const id = `prefs-${group}-${value}`;
      const button = open.find((n) => n.id === id);
      if (button === undefined) {
        const seen = open.filter((n) => n.id.startsWith("prefs-")).map((n) => n.id);
        throw new Error(`no button #${id} in the open panel. Panel buttons seen: ${seen.join(", ") || "none"}`);
      }
      const point = centreOf(button);
      xdo(display, ["mousemove", "--window", wid, String(point.x), String(point.y)]);
      xdo(display, ["click", "1"]);
      // Each click is a settings write, and they are three separate commands.
      await Bun.sleep(800);
    }
    await Bun.sleep(SETTLE_MS);
    xdo(display, ["windowclose", wid]);
    await Bun.sleep(2000);
  },
});

const recorded = readPreference(restartHome);
if (spell(recorded) === spell(DEFAULTS)) {
  // Every axis of CHOSEN differs from its default, so an unchanged file means
  // no click landed at all — and every gate below would then be describing the
  // rig's aim rather than the application.
  fail("the panel clicks left settings.json at its defaults, so nothing was actually clicked");
}
console.log(`  settings.json holds ${spell(recorded)}`);

console.log("[5/5] relaunching on the recorded preference, and on the same one seeded");
// The restart run passes `null`: it must read the file the CLICKS wrote, and
// writing the preference here would be the rig answering its own question.
const restarted = await measureBox("restart-clicked", null, restartHome);
const seededEquivalent = await measureBox("restart-seeded", CHOSEN, homeFor("seeded"));

const metrics: PrefsMetrics = {
  small: small.box,
  larger: larger.box,
  serif: serif.box,
  mono: mono.box,
  narrow: narrow.box,
  wide: wide.box,
  chosen: spell(CHOSEN),
  recorded: spell(recorded),
  restarted: restarted.box,
  seeded_equivalent: seededEquivalent.box,
  peak_rss_mb: Math.max(
    small.peakRssMb,
    larger.peakRssMb,
    serif.peakRssMb,
    mono.peakRssMb,
    narrow.peakRssMb,
    wide.peakRssMb,
    restarted.peakRssMb,
    seededEquivalent.peakRssMb,
  ),
};

const verdicts = evaluatePrefsGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

writeResult(
  buildResult({
    runId: "app-prefs-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-prefs",
    verdicts,
    metrics: {
      ...metrics,
      window: `${WINDOW_W}x${WINDOW_H}`,
      server_args: SERVER_ARGS_WIDE,
      pane_width_px: PANE_W,
      passage_chars: PASSAGE.length,
      input_verification: {
        size_small: small.input,
        size_larger: larger.input,
        family_serif: serif.input,
        family_mono: mono.input,
        measure_narrow: narrow.input,
        measure_wide: wide.input,
        restart_clicked: restarted.input,
        restart_seeded: seededEquivalent.input,
      },
      scope:
        "every box is the editable's AT-SPI extents in window coordinates, over one fixed passage " +
        "typed into a freshly seeded tiny project. The window is resized to 1400px because at the " +
        "default 900 the editor pane is narrower than every measure and all three would cap " +
        "against it.",
      omitted_gates:
        "no latency, stall, cliff or a11y_exposure: this rig types one passage and reads one box " +
        "per boot, which has nothing true to say about frame cadence or about the navigator's " +
        "exposure. No legibility gate either - whether a chosen combination can be READ is what " +
        "the screenshots beside this slice carry, and nothing here measures contrast.",
    },
    seed: "n/a",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

rmSync(root, { recursive: true, force: true });
process.exit(verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0);
