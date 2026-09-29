// app/harness/src/persist-cli.ts
// Graded persistence run: seed a fresh project through the host binary, boot
// against it and type, kill the shell, reboot against the same project, and
// require that what was written is what comes back.
//
// The structural check is the point. A restart assertion passes VACUOUSLY if
// nothing was ever written — the seeded body would match itself — so a run with
// zero flushes, or a body that never diverged from the seed, writes nothing at
// all. This is the same rule nav-cli applies to its control.
//
// Budget: capped at 5 minutes. Any Xvfb run long enough to straddle ~600 s has
// its latency gates measuring the rig's unexplained event rather than the
// application (see the 2026-08-02 write-back).
//
// No staged dist: both phases run with APP_PROJECT set and the page has one
// boot path, so APP_DIST points at the built dist directly.
//
// Usage: APP_GUI=1 bun app/harness/src/persist-cli.ts [minutes]
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import { evaluateGates, evaluatePersistGates, type Metrics, type PersistMetrics } from "./gates";
import { buildResult, scriptOf, writeResult } from "./results";
import { bucketRss, summarizeRss } from "./rss-series";
import {
  BIN,
  SHELL_PROC_NAME,
  runShell,
  survivingShellPids,
  type RunOutcome,
  type VerifySinkPayload,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/stress";
const FIXTURE_LABEL = "stress";
const RESULTS = "app/results";
const MAX_MINUTES = 5;
// Measured, not guessed: on the first three series recorded (2026-09-01,
// 1m/3m/5m at stress) the boot transient peaks at 34 s in every run and has
// settled by 40 s. A 30 s window labelled that peak as steady state. A peak in
// here is a transient; a peak after it is the application holding more.
const BOOT_WINDOW_MS = 45_000;
const RSS_BUCKET_MS = 1000;

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function metricsOf(o: RunOutcome): Metrics {
  return {
    peak_rss_mb: o.peakRssMb,
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
  console.log("APP_GUI=1 not set; persistence run skipped (needs a display and a built shell).");
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

const requested = Number(process.argv[2] ?? 5);
if (requested > MAX_MINUTES) {
  console.error(
    `refusing a ${requested}-minute run: budgets over ${MAX_MINUTES} minutes straddle the ~600 s ` +
      `headless event, so their latency gates measure the rig rather than the application.`,
  );
  process.exit(1);
}
const soakMs = Math.round(requested * 60_000);
const fixtureFloor = fixtureItemFloor(FIXTURE);

const projectDir = mkdtempSync(join(tmpdir(), "app-project-"));
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

console.log(`\n[2/3] write run, ${requested} min`);
const write = await runShell({
  mode: "virtual",
  soakMs,
  staged: DIST,
  env: { APP_PROJECT: projectPath, APP_PERSIST_MODE: "write" },
});
try {
  assertFixtureFloor(FIXTURE_LABEL, write.payload.rows, fixtureFloor);
} catch (e) {
  console.error(`\n${(e as Error).message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}
const writePersist = write.payload.persist;
if (!writePersist || !writePersist.flush) {
  console.error("the write run reported no persist block; the page did not take the store path.");
  cleanup();
  process.exit(2);
}
console.log(
  `  flushes: ${writePersist.flush.count}, p50 ${writePersist.flush.p50} ms, p95 ${writePersist.flush.p95} ms, ` +
    `conflicts ${writePersist.flush.conflicts}, errors ${writePersist.flush.errors}`,
);

console.log(`\n[3/3] verify run against the same project`);
// VerifySinkPayload, not SinkPayload: verify mode types nothing and sinks no
// typing/nav/cycles at all. Naming the type param here (rather than casting)
// is the honest version of what the draft plan glossed over.
const verify = await runShell<VerifySinkPayload>({
  mode: "virtual",
  soakMs: 1000,
  staged: DIST,
  env: { APP_PROJECT: projectPath, APP_PERSIST_MODE: "verify" },
  probeA11y: false,
});
const verifyPersist = verify.payload.persist;
if (!verifyPersist) {
  console.error("the verify run reported no persist block.");
  cleanup();
  process.exit(2);
}

const persistMetrics: PersistMetrics = {
  restart_body_match: verifyPersist.body_hash === writePersist.body_hash,
  body_diverged_from_seed: writePersist.body_hash !== writePersist.seeded_body_hash,
  flush_count: writePersist.flush.count,
  flush_conflicts: writePersist.flush.conflicts,
  flush_errors: writePersist.flush.errors,
  flush_p50_ms: writePersist.flush.p50,
  flush_p95_ms: writePersist.flush.p95,
};

// Structural check BEFORE the gates: a vacuous pass must not be recorded at all.
if (persistMetrics.flush_count === 0 || !persistMetrics.body_diverged_from_seed) {
  console.error(
    `\nSTRUCTURAL CHECK FAILED\n` +
      `  flushes: ${persistMetrics.flush_count}, body diverged from seed: ${persistMetrics.body_diverged_from_seed}\n` +
      `The restart assertion would pass vacuously: with nothing written, the seeded body matches ` +
      `itself and a store that never wrote would record a PASS.\n` +
      `Nothing was written.`,
  );
  cleanup();
  process.exit(2);
}
console.log("\nstructural check passed: the run wrote, and the body changed.\n");

// The series is the point of the run's memory figure; a sampler that never
// ran would leave `peak_rss_mb` at 0 and the gate green. Abort instead.
if (write.rssSeries.length === 0) {
  console.error("the write run took no RSS samples; nothing was written.");
  cleanup();
  process.exit(2);
}
const rss = summarizeRss(write.rssSeries, BOOT_WINDOW_MS);
console.log(
  `memory: peak ${rss.peak_mb} MB at ${Math.round(rss.peak_at_ms / 1000)} s` +
    `${rss.peak_in_boot_window ? " (inside the boot window)" : ""}; ` +
    `boot-window peak ${rss.boot_window_peak_mb} MB; post-boot median ${rss.post_boot_median_mb} MB, ` +
    `max ${rss.post_boot_max_mb} MB, slope ${rss.post_boot_slope_mb_per_min?.toFixed(2) ?? "n/a"} MB/min ` +
    `over ${rss.post_boot_samples} samples`,
);
for (const [comm, series] of Object.entries(write.rssByProcess)) {
  const s = summarizeRss(series, BOOT_WINDOW_MS);
  console.log(
    `  ${comm.padEnd(16)} post-boot median ${s.post_boot_median_mb} MB, max ${s.post_boot_max_mb} MB, ` +
      `slope ${s.post_boot_slope_mb_per_min?.toFixed(2) ?? "n/a"} MB/min`,
  );
}
console.log();

const verdicts = [...evaluateGates(metricsOf(write)), ...evaluatePersistGates(persistMetrics)];

const path = writeResult(
  buildResult({
    workload: "app-persist",
    runId: `app-persist-stress-${requested}m`,
    candidate: "tauri",
    fixture: "stress",
    verdicts,
    metrics: {
      ...metricsOf(write),
      startup_ms: write.payload.startup_ms,
      soak_minutes: requested,
      fixture_floor: fixtureFloor,
      actions: write.payload.actions,
      onset: write.payload.onset,
      slow_actions: write.payload.slow_actions,
      persist: persistMetrics,
      persist_error: writePersist.error,
      rss,
      rss_series: bucketRss(write.rssSeries, RSS_BUCKET_MS),
      // Per process name, same summary and buckets as the sum. This is the
      // figure that attributed the 2026-09-01 climb to WebKitWebProcess in one
      // run after the summed series had hidden it for a week.
      rss_by_process: Object.fromEntries(
        Object.entries(write.rssByProcess).map(([comm, series]) => [
          comm,
          { rss: summarizeRss(series, BOOT_WINDOW_MS), rss_series: bucketRss(series, RSS_BUCKET_MS) },
        ]),
      ),
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
