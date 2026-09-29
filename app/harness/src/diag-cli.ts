// app/harness/src/diag-cli.ts
// One arm, no gates, no structural check: a diagnostic that varies a workload
// knob and reports where the run stopped being healthy.
//
// Why this is separate from nav-cli. nav-cli grades a COMPARISON — it runs both
// modes and refuses to write anything unless they differ the way virtualization
// predicts. That is right for evidence and wrong for a hypothesis test, where
// the second arm doubles the wall-clock cost to answer a question that does not
// involve the navigator at all. Results land in app/results/diagnostics/ so a
// probe can never be mistaken for graded evidence.
//
// Usage:
//   APP_GUI=1 [APP_MODE=virtual|naive] [APP_TYPING_CHARS=n] [APP_NAV_JUMPS=n]
//   [APP_ACTION_DELAY_MS=n] [APP_SERVER_ARGS=...] [APP_INPUT_PULSE_MS=n]
//   bun app/harness/src/diag-cli.ts <label> [soakMinutes]
//
// The question it was built for: total actions and elapsed time are the same
// axis in every run recorded so far, because each action awaits a double-rAF at
// ~33 ms. APP_ACTION_DELAY_MS changes ms/action without changing what an action
// does, so the two hypotheses predict different onsets for the first time.
//
// It seeds a project and boots with APP_PROJECT, like every other rig. It used
// to stage a corpus.json, and a change on 2026-08-10 removed the page's corpus
// boot path — after which every diagnostic booted an empty library, the host's
// ensure_starter_scene made one item, and the run recorded `rows: 1` against
// 15,200-row baselines while looking entirely plausible. It grades nothing and
// has no cross-arm check, so nothing here could have contradicted it; the
// fixture floor below is what does.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import { buildResult, scriptOf, writeResult } from "./results";
import { BIN, SERVER_ARGS, SHELL_PROC_NAME, runShell, survivingShellPids } from "./shell";
import { degradationStep } from "./step";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/stress";
const FIXTURE_LABEL = "stress";
const RESULTS = "app/results/diagnostics";

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; diagnostic run skipped (needs a display and a built shell).");
  process.exit(0);
}

const label = process.argv[2];
if (label === undefined || label.length === 0 || !/^[a-z0-9-]+$/.test(label)) {
  console.error("usage: diag-cli.ts <label> [soakMinutes]   (label: lowercase, digits, dashes)");
  process.exit(1);
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
        `A survivor from an earlier run competes for CPU with this one, which corrupts every ` +
        `latency number the run produces.\nClear it and re-run.`,
    );
    process.exit(1);
  }
}

const soakMinutes = Number(process.argv[3] ?? 30);
const soakMs = Math.round(soakMinutes * 60_000);
const mode = process.env.APP_MODE === "naive" ? "naive" : "virtual";
const typingChars = Number(process.env.APP_TYPING_CHARS ?? 400);
const navJumps = Number(process.env.APP_NAV_JUMPS ?? 60);
const actionDelayMs = Number(process.env.APP_ACTION_DELAY_MS ?? 0);
const serverArgs = process.env.APP_SERVER_ARGS ?? SERVER_ARGS;
const inputPulseMs = Number(process.env.APP_INPUT_PULSE_MS ?? 0);
// APP_SESSION=1 runs on the caller's live desktop instead of a private Xvfb.
// Everything measured so far comes from a headless server with no compositor.
const session = process.env.APP_SESSION === "1";

const fixtureFloor = fixtureItemFloor(FIXTURE);
const projectDir = mkdtempSync(join(tmpdir(), "app-project-"));
const projectPath = join(projectDir, "project.db");

function cleanup(): void {
  rmSync(projectDir, { recursive: true, force: true });
}

const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
  stdout: "inherit",
  stderr: "inherit",
});
if (seeded.exitCode !== 0) {
  console.error(`seeding failed (exit ${seeded.exitCode}); nothing was written.`);
  cleanup();
  process.exit(1);
}

const rigCommit = gitShortSha();

console.log(
  `diagnostic "${label}": ${mode}, ${soakMinutes} min, ${typingChars} chars + ${navJumps} jumps ` +
    `per cycle, ${actionDelayMs} ms delay per action`,
);
console.log(
  session
    ? `  LIVE SESSION (${process.env.XDG_SESSION_TYPE ?? "unknown"}, GDK_BACKEND=${process.env.GDK_BACKEND ?? "default"}). ` +
        `A real window will open and must stay VISIBLE for the whole run: compositors stop ` +
        `delivering frame callbacks to occluded surfaces, which looks exactly like the pathology ` +
        `under test.`
    : `  X server args: ${serverArgs}`,
);

// AT-SPI probing walks the live tree from outside the process every 10 s. This
// run measures the app's own frame cadence, so the probe is off: a diagnostic
// that includes the instrument in the thing being measured answers a question
// about the instrument.
const outcome = await runShell({
  mode,
  soakMs,
  staged: DIST,
  probeA11y: false,
  serverArgs,
  inputPulseMs,
  session,
  env: {
    APP_PROJECT: projectPath,
    APP_TYPING_CHARS: String(typingChars),
    APP_NAV_JUMPS: String(navJumps),
    APP_ACTION_DELAY_MS: String(actionDelayMs),
  },
});
try {
  assertFixtureFloor(FIXTURE_LABEL, outcome.payload.rows, fixtureFloor);
} catch (e) {
  console.error(`\n${(e as Error).message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}
cleanup();

const p = outcome.payload;
const onset = p.onset;
const msPerAction = p.actions > 0 ? (p.cycles.at(-1)?.atMs ?? 0) / p.actions : 0;

console.log(`  actions:        ${p.actions} (${msPerAction.toFixed(1)} ms/action)`);
console.log(`  peak_rss_mb:    ${outcome.peakRssMb}`);
console.log(`  typing frame:   p50 ${p.typing.frame.p50} / p95 ${p.typing.frame.p95} / p99 ${p.typing.frame.p99}`);
console.log(`  slow actions:   ${p.slow_actions} of ${p.actions}`);
console.log(
  onset === null
    ? "  onset:          none — the run stayed healthy for its whole budget"
    : `  onset:          action ${onset.actionIndex} at ${(onset.atMs / 1000).toFixed(1)} s ` +
      `(${onset.charsTyped} chars typed, kind ${onset.kind}, frame ${onset.frameMs} ms)`,
);

const step = degradationStep(p.cycles);
console.log(
  step === null
    ? "  step:           none — no sustained rise in cycle p95"
    : `  step:           cycle ${step.cycle} at ${(step.atMs / 1000).toFixed(1)} s ` +
      `(p95 ${Math.round(step.p95Ms)} ms vs ${Math.round(step.baselineP95Ms)} ms baseline)`,
);

const environment = captureEnv();
const path = writeResult(
  buildResult({
    workload: "app-diagnostic",
    runId: `diag-${label}`,
    candidate: "tauri",
    fixture: "stress",
    // A diagnostic asserts nothing about the product. Recording an empty
    // verdict list keeps it on the result schema without inventing a PASS.
    verdicts: [],
    metrics: {
      mode,
      soak_minutes: soakMinutes,
      typing_chars_per_cycle: typingChars,
      nav_jumps_per_cycle: navJumps,
      action_delay_ms: actionDelayMs,
      workload_script: scriptOf(p.workload_script),
      display: session ? "session" : "xvfb",
      // Which stack actually rendered: a GTK app on a Wayland session may run
      // native or through XWayland, and those are different rendering paths.
      session_type: session ? (process.env.XDG_SESSION_TYPE ?? "unknown") : "xvfb",
      gdk_backend: session ? (process.env.GDK_BACKEND ?? "default") : "x11",
      server_args: session ? "n/a (live session)" : serverArgs,
      input_pulse_ms: inputPulseMs,
      ms_per_action: Number(msPerAction.toFixed(2)),
      peak_rss_mb: outcome.peakRssMb,
      startup_ms: p.startup_ms,
      actions: p.actions,
      onset,
      first_slow: p.first_slow,
      // Idle, DPMS and workspace transitions during the run. Any of them stops
      // frame callbacks and mimics the event under test, so an uninstrumented
      // live run cannot distinguish them.
      session_states: outcome.sessionStates,
      // Cycle-level, so a degradation too small to trip the page's slow-frame
      // threshold still reaches the record.
      step,
      slow_actions: p.slow_actions,
      typing: p.typing,
      nav: p.nav,
      cycles: p.cycles,
      rows: p.rows,
    },
    seed: "app-v1",
    rigCommit,
    environment,
  }),
  RESULTS,
);
if (session) {
  console.log(
    outcome.sessionStates.length <= 1
      ? "  session state:  no idle / DPMS / workspace transitions during the run"
      : `  session state:  ${outcome.sessionStates.length} transition(s) — see metrics.session_states`,
  );
}
console.log(`\nrecorded: ${path}`);
