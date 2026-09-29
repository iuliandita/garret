// app/harness/src/window-cli.ts
// Graded window-geometry run. Three boots, NO AT-SPI walk at all.
//
// Every figure here comes from `xdotool getwindowgeometry`, which is the X
// server's answer about a window it owns, not the application's answer about
// itself. That is the whole reason this rig can say anything: the shell asking
// its own webview how big it is would be checking the page against the page.
//
// The first gate is the one that matters. It is arithmetic — the editor pane is
// `width - 320 (navigator) - 48 (padding)` and the widest measure this
// application offers is `48em x 17px = 816px` — and it FAILS on every build
// before this fix, where the pane was 532px and even the narrowest measure
// capped against it. An earlier build shipped a preference nobody could see.
//
// Usage: APP_GUI=1 bun app/harness/src/window-cli.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { evaluateWindowGates, type WindowMetrics } from "./gates";
import { buildResult, writeResult } from "./results";
import { BIN, SHELL_PROC_NAME, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** Restated from style.css, and used only to turn a window width into a pane
 *  width. `--nav-width` and #editor's 24px of padding on each side. */
const NAV_W = 320;
const EDITOR_PADDING = 24;
/** The widest measure, in px at the default type size: 48em x 17px. Restated
 *  from the same stylesheet, deliberately -- see gates.ts on thresholds. */
const WIDEST_MEASURE_PX = 48 * 17;

/** What the writer resizes to, mid-run. Deliberately not a round number and not
 *  the default in either axis, so a "remembered" size that is really the default
 *  is visible rather than plausible. */
const RESIZED = { w: 1147, h: 703 };

/** xdotool returns when X has the events, not when the toolkit has acted. */
const SETTLE_MS = 2500;

/** Longer than the host's own WINDOW_SETTLE (1500ms), restated rather than
 *  imported for the reason every threshold here is restated. Too short and the
 *  run measures the rig's patience rather than the application. */
const SETTLE_RECORD_MS = 3000;

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

interface Size {
  w: number;
  h: number;
}

function geometryOf(display: string, wid: string): Size {
  const out = xdo(display, ["getwindowgeometry", wid]);
  const found = out.match(/Geometry:\s*(\d+)x(\d+)/);
  if (found === null) throw new Error(`could not read a geometry out of: ${out.trim()}`);
  return { w: Number(found[1]), h: Number(found[2]) };
}

function fail(why: string): never {
  console.error(`${why}; nothing was written.`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; window run skipped (needs a display and a built shell).");
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

const root = mkdtempSync(join(tmpdir(), "app-window-"));
const projectPath = join(root, "book.db");
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) fail(`seeding failed (exit ${seeded.exitCode})`);
}

function homeWith(label: string, settings: unknown | null): string {
  const dir = join(root, `home-${label}`);
  mkdirSync(join(dir, "cc.local.app"), { recursive: true });
  if (settings !== null) {
    writeFileSync(join(dir, "cc.local.app", "settings.json"), JSON.stringify(settings));
  }
  return dir;
}

function recordedSize(dataHome: string): Size | null {
  const path = join(dataHome, "cc.local.app", "settings.json");
  if (!existsSync(path)) return null;
  const held = (JSON.parse(readFileSync(path, "utf8")) as { window?: { width?: number; height?: number } })
    .window;
  if (held?.width === undefined || held.height === undefined) return null;
  return { w: held.width, h: held.height };
}

/** One boot. `resizeTo` is what the writer does to the window before closing it;
 *  the returned geometry is read BEFORE that, so it is what the launch chose. */
async function boot(
  label: string,
  dataHome: string,
  resizeTo: Size | null,
): Promise<Size> {
  const opened: { size: Size | null } = { size: null };
  await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      // Explicit, so it survives shell.ts's own isolation default: this rig's
      // whole subject is what the application writes into this directory.
      XDG_DATA_HOME: dataHome,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum }) => {
      if (displayNum === null) throw new Error("window rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      await Bun.sleep(SETTLE_MS);
      opened.size = geometryOf(display, wid);
      if (resizeTo !== null) {
        xdo(display, ["windowsize", wid, String(resizeTo.w), String(resizeTo.h)]);
        await Bun.sleep(1200);
        const after = geometryOf(display, wid);
        if (after.w !== resizeTo.w || after.h !== resizeTo.h) {
          throw new Error(
            `the resize did not take: asked for ${resizeTo.w}x${resizeTo.h}, got ${after.w}x${after.h}`,
          );
        }
        // Longer than the host's 1500ms settle. The size is recorded when the
        // window stops moving, NOT when it closes: under a WM-less X server
        // `windowclose` destroys the window rather than delivering a close
        // request, so CloseRequested never runs here at all.
        await Bun.sleep(SETTLE_RECORD_MS);
      }
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(1500);
    },
  });
  if (opened.size === null) fail(`${label} produced no geometry`);
  const got: Size = opened.size;
  console.log(`  ${label.padEnd(18)} opened ${got.w}x${got.h}`);
  return got;
}

console.log("[1/3] a first launch, with nothing recorded");
const freshHome = homeWith("fresh", null);
const fresh = await boot("default", freshHome, null);

console.log(`[2/3] resized to ${RESIZED.w}x${RESIZED.h}, closed, and relaunched`);
// The SAME data home: what the first boot recorded when its resize settled is
// the input to the second, which is the whole claim.
const rememberHome = homeWith("remember", null);
await boot("before-resize", rememberHome, RESIZED);
const recorded = recordedSize(rememberHome);
if (recorded === null) {
  fail("the closed window recorded no size at all, so the relaunch below would prove nothing");
}
if (recorded.w === fresh.w && recorded.h === fresh.h) {
  // Otherwise "remembered" and "opened at the default" are the same picture.
  fail(`the recorded size ${recorded.w}x${recorded.h} is the default, so the resize was not seen`);
}
const remembered = await boot("after-relaunch", rememberHome, null);

console.log("[3/3] a recorded size that would produce a window with nothing in it");
const dotHome = homeWith("dot", { window: { width: 1, height: 1 } });
const dot = await boot("absurd", dotHome, null);

const metrics: WindowMetrics = {
  default_w: fresh.w,
  default_h: fresh.h,
  pane_w: fresh.w - NAV_W - 2 * EDITOR_PADDING,
  widest_measure_px: WIDEST_MEASURE_PX,
  resized_w: RESIZED.w,
  resized_h: RESIZED.h,
  remembered_w: remembered.w,
  remembered_h: remembered.h,
  absurd_w: dot.w,
  absurd_h: dot.h,
};

const verdicts = evaluateWindowGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

writeResult(
  buildResult({
    runId: "app-window-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-window",
    verdicts,
    metrics: {
      ...metrics,
      scope:
        "every figure is xdotool's reading of the X window, never the application's account of " +
        "itself. Xvfb has no window manager, so nothing here says how a tiling compositor will " +
        "treat the same request -- on Hyprland the recorded size is advisory and the gates below " +
        "would describe the compositor rather than the application.",
      omitted_gates:
        "no position: on Wayland a client cannot set its own position at all, so a stored " +
        "position would work on X11 and silently do nothing on the display server this " +
        "harness runs under. Nothing is measured because nothing is claimed.",
    },
    seed: "n/a",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

rmSync(root, { recursive: true, force: true });
process.exit(verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0);
