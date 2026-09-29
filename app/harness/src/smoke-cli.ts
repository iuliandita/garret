// app/harness/src/smoke-cli.ts
// GUI-gated boot check: boot the Tauri host headless over a staged tiny corpus,
// wait for the page's payload, sample process-tree RSS, probe AT-SPI, and
// report. This is a "does it still come up" check, not a graded run — it soaks
// for seconds, so it has nothing true to grade against the latency/cliff/
// exposure gates and writes no result. Gated behind APP_GUI=1 so `bun test`
// stays GUI-free.
//
// It spawns through shell.ts like every other CLI. It used to spawn its own
// xvfb-run with its own env, and diverged: no staged corpus (so the page's
// corpus.json fetch 404'd and threw), no APP_SOAK_MS (so it waited 30 s for a
// payload the page emits at 60 s), and no GTK_A11Y (so AT-SPI read unavailable
// on a machine where it works). A probe that spawns the host slightly
// differently answers a question about the probe.
//
// It seeds a project and boots with APP_PROJECT, like every other rig. It used
// to stage a corpus.json, and a change on 2026-08-10 removed the page's corpus
// boot path — after which this check booted an empty library, the host's
// ensure_starter_scene made one item, and it reported `rows=1` as a healthy
// boot. It grades nothing, which is exactly why it stayed silent for eleven
// days; the fixture floor below is what makes that impossible now.
//
// Usage: APP_GUI=1 bun app/harness/src/smoke-cli.ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import { BIN, runShell } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const FIXTURE_LABEL = "tiny";
// Long enough for one AT-SPI prober tick (shell.ts probes every 10 s, and its
// first probe fires before the window exists). Short enough that a boot check
// stays a boot check.
const SOAK_MS = 12_000;

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; smoke run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — build it before running the smoke.`);
    process.exit(1);
  }
}
if (!existsSync(FIXTURE)) {
  console.error(`missing ${FIXTURE} — regenerate it: cd lab && bun fixtures/gen/src/cli.ts tiny`);
  process.exit(1);
}

const fixtureFloor = fixtureItemFloor(FIXTURE);
const projectDir = mkdtempSync(join(tmpdir(), "app-project-"));
const projectPath = join(projectDir, "project.db");
try {
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) {
    console.error(`seeding failed (exit ${seeded.exitCode}).`);
    process.exit(1);
  }
  const run = await runShell({
    mode: "virtual",
    soakMs: SOAK_MS,
    staged: DIST,
    env: { APP_PROJECT: projectPath },
  });
  assertFixtureFloor(FIXTURE_LABEL, run.payload.rows, fixtureFloor);
  console.log(`boot ok: mode=${run.payload.mode} rows=${run.payload.rows}`);
  console.log(`  startup_ms: ${run.payload.startup_ms}`);
  console.log(`  peak_rss_mb: ${run.peakRssMb}`);
  console.log(
    run.a11y.available
      ? `  atspi: available, ${run.a11y.exposedRows} row(s) advertised, ${run.a11y.mountedRows} mounted`
      : "  atspi: unavailable",
  );
} finally {
  rmSync(projectDir, { recursive: true, force: true });
}
