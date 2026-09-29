// app/harness/src/nav-cli.ts
// Graded navigator run: naive control, then the virtualized navigator, then a
// validation that the two runs actually differ the way virtualization is
// supposed to make them differ. Both phases run before validation (unlike an
// earlier version that gated the second phase on the first), because the
// comparison needs both.
//
// The control is NOT required to reproduce discovery's typing cliff. That
// cliff is progressive and environment-sensitive (discovery's baseline was
// healthy at 34 ms on its first cycle and reached 1001 ms only after ~39
// cycles across 30 minutes) and it did not reproduce in 15- or 30-minute runs
// here, so gating on it made every attempt cost an hour and could fail for
// reasons unrelated to the navigator. What IS required is a structural
// difference: the control actually mounted the whole list, the virtualized
// run actually windowed it, and windowing actually bought lower peak RSS. If
// the two modes did not differ that way, the run cannot support a claim about
// virtualization, so nothing is written.
//
// Both arms boot the SQLite store, seeded once from the stress fixture, exactly
// as persist-cli and hier-cli do. They used to stage a corpus.json into a copy
// of dist, and a change on 2026-08-10 deleted the host's `null` branch for
// window.__appProject — which took the page's corpus boot path with it. From
// that day the rig booted an empty library, ensure_starter_scene made one item,
// and the structural check below refused a 1-row run for eleven days. Reviving
// the corpus path would have graded a screen the product does not have: it
// builds no export bar, no find, no save indicator, no word count and no rename
// panel.
//
// Budget: capped at 5 minutes, like persist-cli and hier-cli. Any Xvfb run long
// enough to straddle ~600 s has its latency gates measuring the rig's
// unexplained event rather than the application.
//
// Usage: APP_GUI=1 [APP_TYPING_CHARS=n] bun app/harness/src/nav-cli.ts [soakMinutes]
// APP_TYPING_CHARS overrides the default 400 chars/cycle typing workload; a
// non-default value gets its own run_id (see below) so it can't displace the
// stress-soak ladder's evidence.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import { evaluateGates, type Metrics } from "./gates";
import { refuseSoak, validateStructuralDifference } from "./nav-rules";
import { buildResult, scriptOf, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  runShell,
  survivingShellPids,
  type RunOutcome,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/stress";
const FIXTURE_LABEL = "stress";
const RESULTS = "app/results";
const MAX_MINUTES = 5;
// a11y_exposure reads the one aria-setsize every row agrees on, which is a flat
// list's concept. The store path paints a TREE, whose rows advertise their own
// sibling group's setsize, so the gate collapses to 0 and reports UNKNOWN on
// every run this rig can now produce. hier-cli's a11y_tree_structure is the gate
// that can fail on a tree, and it is NOT reusable here: it reads the page's
// `tree.pre_mutation_rows` block, which only a HierSinkPayload carries, and it
// arrives bundled with tree_shape_match and the two mutation gates, for which
// this rig has no data at all. So the gate is omitted and the omission recorded,
// rather than a third accessibility rule invented for one rig.
const OMITTED_GATE = "a11y_exposure";

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function metricsOf(o: RunOutcome): Metrics {
  return {
    peak_rss_mb: o.peakRssMb,
    // Frame percentiles, not dispatch: the spec thresholds describe
    // user-perceived latency.
    typing_p95_ms: o.payload.typing.frame.p95,
    typing_p99_ms: o.payload.typing.frame.p99,
    nav_p95_ms: o.payload.nav.frame.p95,
    typing: o.payload.typing,
    nav: o.payload.nav,
    cycles: o.payload.cycles,
    rows: o.payload.rows,
    workload_script: scriptOf(o.payload.workload_script),
    a11y: o.a11y,
  };
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; navigator run skipped (needs a display and a built shell).");
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
        `window (it refuses any dump it can't attribute to a single app), so the accessibility ` +
        `gate can't be measured — and a 30-minute soak would be wasted discovering that at the end.\n` +
        `Clear it (kill the stray process) and re-run.`,
    );
    process.exit(1);
  }
}

const soakMinutes = Number(process.argv[2] ?? MAX_MINUTES);
{
  const refusal = refuseSoak(soakMinutes, MAX_MINUTES);
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }
}
const soakMs = Math.round(soakMinutes * 60_000);
const typingChars = Number(process.env.APP_TYPING_CHARS ?? 400);
const navJumps = Number(process.env.APP_NAV_JUMPS ?? 60);
const actionDelayMs = Number(process.env.APP_ACTION_DELAY_MS ?? 0);
// From the fixture's own manifest, so a regenerated fixture moves the floor with
// it and a vanished one is loud in both arms.
const fixtureFloor = fixtureItemFloor(FIXTURE);
const rigCommit = gitShortSha();

const projectDir = mkdtempSync(join(tmpdir(), "app-project-"));
const projectPath = join(projectDir, "project.db");

function cleanup(): void {
  rmSync(projectDir, { recursive: true, force: true });
}

// ONE seed, both arms. The arms differ in how the navigator mounts the walk and
// in nothing else; seeding twice would put two generated projects behind a
// comparison whose whole claim is that only the mounting changed.
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

console.log(`\n[2/3] naive control, ${soakMinutes} min`);
const control = await runShell({
  mode: "naive",
  soakMs,
  staged: DIST,
  env: { APP_PROJECT: projectPath },
});
try {
  assertFixtureFloor(FIXTURE_LABEL, control.payload.rows, fixtureFloor);
} catch (e) {
  console.error(`\n${(e as Error).message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}
const controlMetrics = metricsOf(control);
const controlGates = evaluateGates(controlMetrics);
for (const g of controlGates) console.log(`  ${g.gate}: ${g.value} (${g.threshold}) ${g.verdict}`);
console.log(`  startup_ms: ${control.payload.startup_ms} (not gated)`);
console.log(`  mountedRows: ${control.a11y.mountedRows} of ${control.payload.rows}`);

console.log(`\n[3/3] virtualized navigator, ${soakMinutes} min`);
const test = await runShell({
  mode: "virtual",
  soakMs,
  staged: DIST,
  env: { APP_PROJECT: projectPath },
});
try {
  assertFixtureFloor(FIXTURE_LABEL, test.payload.rows, fixtureFloor);
} catch (e) {
  console.error(`\n${(e as Error).message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}
const testMetrics = metricsOf(test);
const verdicts = evaluateGates(testMetrics).filter((g) => g.gate !== OMITTED_GATE);
for (const g of verdicts) console.log(`  ${g.gate}: ${g.value} (${g.threshold}) ${g.verdict}`);
console.log(`  startup_ms: ${test.payload.startup_ms} (not gated)`);
console.log(`  mountedRows: ${test.a11y.mountedRows} of ${test.payload.rows}`);

// Runs after BOTH phases, not gating the second on the first: the comparison
// needs both, and the control no longer has to reproduce a latency cliff (see
// header comment for why that requirement was dropped).
// The rule reads three numbers, so it is handed three numbers rather than two
// whole run outcomes -- see `nav-rules.ts`.
const armFacts = (r: typeof control) => ({
  rows: r.payload.rows,
  mountedRows: r.a11y.mountedRows,
  peakRssMb: r.peakRssMb,
});
const structuralFailure = validateStructuralDifference(armFacts(control), armFacts(test));
if (structuralFailure) {
  console.error(
    `\nSTRUCTURAL CHECK FAILED: ${structuralFailure.check}\n` +
      `  ${structuralFailure.detail}\n` +
      `The run cannot support a claim about virtualization because the two modes did not differ ` +
      `the way virtualization is supposed to make them differ.\n` +
      `Nothing was written.`,
  );
  cleanup();
  process.exit(2);
}
console.log("\nstructural check passed: the two modes differ as virtualization predicts.\n");

const env = captureEnv();
const path = writeResult(
  buildResult({
    workload: "app-navigator",
    // `w2` is the workload generation, the same clean break hier-cli made. The
    // five `app-navigator-stress*` results were recorded against a flat 15,200-row
    // corpus the application can no longer boot; overwriting them with a
    // 20,000-row tree's numbers would present two different measurements as one
    // series, which is exactly the "did this change" blindness the superseded-diff
    // rule exists to prevent.
    //
    // The budget is part of the configuration, so it belongs in the run_id:
    // run_id names a configuration, not a run, and two budgets are two
    // configurations. Without this a ladder of budgets displaces each rung into
    // superseded/ and only the last one survives as current evidence. Same
    // reasoning for typingChars: a non-default value is a different experiment
    // and must not displace the ladder's evidence at the default chars/cycle.
    runId:
      `app-navigator-w2-stress-${soakMinutes}m` +
      (typingChars !== 400 ? `-${typingChars}c` : "") +
      (navJumps !== 60 ? `-${navJumps}n` : "") +
      (actionDelayMs !== 0 ? `-${actionDelayMs}d` : ""),
    candidate: "tauri",
    fixture: "stress",
    verdicts,
    metrics: {
      ...testMetrics,
      startup_ms: test.payload.startup_ms,
      soak_minutes: soakMinutes,
      typing_chars_per_cycle: typingChars,
      nav_jumps_per_cycle: navJumps,
      action_delay_ms: actionDelayMs,
      // Cycle records place onset within a 15 s, 460-action window. These place
      // it exactly, which is what separates hypotheses that all fit the cycle
      // table (document size, cycle count, elapsed time, total actions).
      actions: test.payload.actions,
      onset: test.payload.onset,
      slow_actions: test.payload.slow_actions,
      // The control arm is a NEGATIVE control, and its verdicts are recorded
      // ungraded for that reason. Naive mounts every one of the 20,000 rows, so
      // a red peak_rss_mb here is the rig working: it is the memory cost
      // virtualization exists to avoid, not a regression in the product.
      control: {
        ...controlMetrics,
        startup_ms: control.payload.startup_ms,
        actions: control.payload.actions,
        onset: control.payload.onset,
        slow_actions: control.payload.slow_actions,
        verdicts: controlGates,
      },
      omitted_gates: [
        {
          gate: OMITTED_GATE,
          reason:
            "flat-list concept: it reads the single consistent aria-setsize the rows advertise, " +
            "else 0. The store path paints a tree, whose rows advertise per-sibling-group setsize, " +
            "so it collapses to 0 and reports UNKNOWN on every run. hier-cli's a11y_tree_structure " +
            "is the gate that can fail on a tree; it is not reusable here because it reads the " +
            "page's tree.pre_mutation_rows block, which only a HierSinkPayload carries, and it " +
            "arrives bundled with tree_shape_match and the two mutation gates this rig cannot feed.",
        },
      ],
    },
    seed: "app-v1",
    rigCommit,
    environment: env,
  }),
  RESULTS,
);

cleanup();
console.log(`\nrecorded: ${path}`);
for (const v of verdicts) console.log(`  ${v.gate}: ${v.value} (${v.threshold}) ${v.verdict}`);
console.log(`  ${OMITTED_GATE}: omitted (see metrics.omitted_gates)`);
console.log(`  startup_ms: ${test.payload.startup_ms} (not gated)`);
