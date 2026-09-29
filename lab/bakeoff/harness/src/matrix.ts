// lab/bakeoff/harness/src/matrix.ts
// Track 2 matrix runner. Pure planning + metric computation are unit-tested; the
// GUI run is gated behind BAKEOFF_GUI=1 (needs built shells + Xvfb). Without the
// gate the CLI prints the plan and exits, keeping `bun test`/CI GUI-free.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { percentiles } from "../../editor-core/src/stats";
import { materializeFixture } from "../../editor-core/src/loader";
import { probeAtspi } from "./atspi";
import { startContention } from "./contention";
import {
  evaluateGates, evaluateSoakGates,
  type A11yProbe, type Metrics, type SoakMetrics,
} from "./gates";
import { sumTreeRssKb, leakSlopeMbPerHour, type RssSample } from "./rss";
import { buildResult, writeResult, type Candidate, type GateResult } from "./results";
import { renderReport } from "./report";
import type { Sample, SinkPayload, SoakCycle } from "../../editor-core/src/bridge";

// One-variable page variants under A/B test. Recorded in every result record so
// a measurement can never be read as the baseline it is not.
export const VARIANTS = ["lazy-docs", "contain-nav", "nav-cap"] as const;
export type Variant = (typeof VARIANTS)[number];

// nav-cap renders this many navigator rows instead of one per scene. Chosen to
// match the scene count of the `normal` fixture, whose soak passed, so the only
// difference from a passing configuration is the thing under test.
export const NAV_CAP_ROWS = 1500;

export function parseVariants(spec: string | undefined): Variant[] {
  if (!spec) return [];
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!(VARIANTS as readonly string[]).includes(p)) {
      throw new Error(`unknown variant "${p}" (known: ${VARIANTS.join(", ")})`);
    }
  }
  // Sorted so the same set always yields the same run id, whatever the order.
  return [...new Set(parts)].sort() as Variant[];
}

// Run-id suffix: baseline stays unsuffixed so existing evidence keeps its name.
export function variantSuffix(variants: Variant[]): string {
  return variants.length ? `-${variants.join("+")}` : "";
}

export interface MatrixOpts {
  fixture: string;
  candidates: Candidate[];
}

export interface PlanEntry {
  candidate: Candidate;
  fixture: string;
}

export function planMatrix(opts: MatrixOpts): PlanEntry[] {
  return opts.candidates.map((c) => ({ candidate: c, fixture: opts.fixture }));
}

export interface RunAux {
  coldStartMs: number;
  warmStartMs: number;
  peakRssKb: number;
}

export function computeMetrics(
  samples: Sample[],
  aux: RunAux,
  a11y: A11yProbe,
): Metrics {
  const typing = samples.filter((s) => s.workload === "typing").map((s) => s.ms);
  const nav = samples.filter((s) => s.workload === "navigation").map((s) => s.ms);
  const t = percentiles(typing);
  const n = percentiles(nav);
  return {
    typing_p95: t.p95,
    typing_p99: t.p99,
    nav_p95: n.p95,
    cold_start_ms: aux.coldStartMs,
    warm_start_ms: aux.warmStartMs,
    peak_rss_mb: Math.round(aux.peakRssKb / 1024),
    a11y,
  };
}

export interface RunEval {
  fixture: string;
  metrics: Record<string, unknown>;
  verdicts: GateResult[];
}

// Turn a run's sink payload into a record's fixture/metrics/verdicts. A crashed
// or timed-out run (run.ts sinks fixture "error" with empty samples and -1
// timings; the Electron watchdog sinks "timeout" likewise) must NOT flow through
// the numeric gates, where -1 < threshold and percentiles([]) === 0 would read
// as PASS. Such a run is recorded as a single failing "run" gate with the real
// payload fixture marker, so a crash can never be mistaken for a clean pass.
export function evalRun(
  payload: SinkPayload,
  peakRssKb: number,
  a11y: A11yProbe,
): RunEval {
  const incomplete =
    payload.samples.length === 0 ||
    payload.coldStartMs < 0 ||
    payload.warmStartMs < 0;
  if (incomplete) {
    return {
      fixture: payload.fixture || "error",
      metrics: {
        note: "run did not complete",
        coldStartMs: payload.coldStartMs,
        warmStartMs: payload.warmStartMs,
        sampleCount: payload.samples.length,
      },
      verdicts: [
        {
          gate: "run",
          value: `incomplete (${payload.fixture})`,
          threshold: "completes with samples",
          verdict: "FAIL",
        },
      ],
    };
  }
  const metrics = computeMetrics(
    payload.samples,
    { coldStartMs: payload.coldStartMs, warmStartMs: payload.warmStartMs, peakRssKb },
    a11y,
  );
  // Full p50/p95/p99 per workload (spec: "Report p50, p95, p99 per workload").
  const typingStats = percentiles(
    payload.samples.filter((s) => s.workload === "typing").map((s) => s.ms),
  );
  const navStats = percentiles(
    payload.samples.filter((s) => s.workload === "navigation").map((s) => s.ms),
  );
  return {
    fixture: payload.fixture,
    metrics: { ...metrics, typing: typingStats, navigation: navStats } as Record<
      string,
      unknown
    >,
    verdicts: evaluateGates(metrics),
  };
}

const BAKEOFF_ROOT = join(import.meta.dir, "../..");
const REPO_ROOT = join(BAKEOFF_ROOT, "../..");

// The exact executable each candidate runs. Always an absolute path under this
// repo, so a pattern match can never hit an unrelated process on the machine.
function shellPattern(candidate: Candidate): string {
  return candidate === "electron"
    ? join(BAKEOFF_ROOT, "shell-electron")
    : join(BAKEOFF_ROOT, "shell-tauri/src-tauri/target/debug/bakeoff-shell-tauri");
}

function findStragglers(candidate: Candidate): number[] {
  const out = Bun.spawnSync(["pgrep", "-f", shellPattern(candidate)]).stdout.toString();
  return out.split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
}

// Killing the xvfb-run wrapper does NOT kill the app beneath it: a 30-minute
// soak left a 203 MB Tauri process running for 37 minutes after its run had
// "finished". A straggler competes for the same four pinned cores and the same
// memory as the next run, so it silently corrupts whatever is measured next.
function killStragglers(candidate: Candidate): number {
  const pids = findStragglers(candidate);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return pids.length;
}

// A straggler from an EARLIER run contaminates this one, and nothing downstream
// could tell. Refuse to measure rather than record a polluted number.
function assertNoStragglers(candidate: Candidate): void {
  const pids = findStragglers(candidate);
  if (pids.length > 0) {
    throw new Error(
      `${candidate}: ${pids.length} leftover shell process(es) still running ` +
      `(${pids.join(", ")}). They would contend for the same pinned cores; ` +
      "kill them before measuring.",
    );
  }
}

function sh(cmd: string[], cwd?: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

function gitSha(): string {
  try {
    return sh(["git", "rev-parse", "--short", "HEAD"], REPO_ROOT) || "unknown";
  } catch {
    return "unknown";
  }
}

function env() {
  let cpu = "unknown";
  try {
    const m = readFileSync("/proc/cpuinfo", "utf8").match(/model name\s*:\s*(.+)/);
    if (m) cpu = m[1]!.trim();
  } catch {
    /* keep unknown */
  }
  return {
    kernel: sh(["uname", "-r"]) || "unknown",
    cpu,
    throttleScope: process.env.BAKEOFF_THROTTLE ?? "0-3 / 8G (see throttle-run.sh)",
    biasNotes:
      "cgroup-throttled approximation of reference hardware (4 threads, 8G); " +
      "modern single-core speed exceeds a five-year-old laptop core. Gates " +
      "remain hypotheses until a real-hardware pass. macOS unmeasured.",
  };
}

// Spawn one shell under Xvfb, poll RSS, read the sink payload it writes.
async function runShell(
  candidate: Candidate,
  fixtureDir: string,
  fixtureName: string,
  soakMs = 0,
  variants: Variant[] = [],
): Promise<{
  payload: SinkPayload;
  peakRssKb: number;
  a11y: A11yProbe;
  rssSeries: RssSample[];
  stderrTail: string;
}> {
  assertNoStragglers(candidate);
  const work = mkdtempSync(join(tmpdir(), `bakeoff-${candidate}-`));
  const sink = join(work, "sink.json");
  const dist = join(BAKEOFF_ROOT, "dist");

  // Stage the shared bundle + materialized fixture where the shell loads it.
  const shellDist =
    candidate === "electron"
      ? join(BAKEOFF_ROOT, "shell-electron", "dist")
      : join(BAKEOFF_ROOT, "shell-tauri", "dist");
  cpSync(dist, shellDist, { recursive: true });
  materializeFixture(
    fixtureDir, join(shellDist, "scene-data.json"), fixtureName, 0,
    variants.includes("lazy-docs"),
  );

  const spawnEnv = {
    ...process.env,
    BAKEOFF_SINK: sink,
    // Electron reads the staged index.html directly (loadFile). Tauri serves the
    // same staged dir at runtime via its bakeoff:// custom protocol from this dir.
    BAKEOFF_INDEX: join(shellDist, "index.html"),
    BAKEOFF_DIST: shellDist,
    // Enable GTK/WebKitGTK accessibility so the AT-SPI tree is populated. The app
    // inherits DBUS_SESSION_BUS_ADDRESS (the real session a11y bus), so the probe
    // (same env) sees it. Electron enables Chromium a11y in main.ts.
    GTK_A11Y: "atspi",
    // The page's soak length is baked into the bundle at build time, but the
    // Electron shell's watchdog is a runtime timer and needs it too.
    BAKEOFF_SOAK_MS: String(soakMs),
  };
  // Both wrapped by xvfb-run for headless GTK/Chromium.
  const cmd =
    candidate === "electron"
      ? ["xvfb-run", "-a", "bunx", "electron", join(BAKEOFF_ROOT, "shell-electron")]
      : [
          "xvfb-run",
          "-a",
          join(BAKEOFF_ROOT, "shell-tauri/src-tauri/target/debug/bakeoff-shell-tauri"),
        ];

  const contention = startContention(work);
  const proc = Bun.spawn(cmd, { env: spawnEnv, stdout: "pipe", stderr: "pipe" });
  // stderr was piped and never read: a page that threw sent its console error
  // straight to a discarded buffer, leaving a crash indistinguishable from a
  // misconfiguration. Collected concurrently so a full pipe cannot block the run.
  const stderrText = new Response(proc.stderr).text().catch(() => "");

  // Poll process-tree RSS until the sink file appears or the deadline passes.
  // The soak must outlive its own duration, so the deadline is the soak length
  // plus the normal 6-minute budget for startup, the measured pass and teardown.
  let peakRssKb = 0;
  const rssSeries: RssSample[] = [];
  const started = Date.now();
  // The page now bounds its own soak within a cycle, so this is a backstop
  // rather than the thing that ends a run. It was 6 minutes, and a soak whose
  // final cycle had degraded to minutes long blew through it and sank nothing.
  const deadline = started + soakMs + 10 * 60_000;
  // 200 ms is right for a ~30 s run but would be 9,000 points over a 30-minute
  // soak; the series only needs enough resolution to fit a trend.
  const sampleEveryMs = soakMs > 0 ? 5_000 : 200;
  let nextSampleAt = 0;
  while (!existsSync(sink) && Date.now() < deadline) {
    const rss = sumTreeRssKb(proc.pid);
    peakRssKb = Math.max(peakRssKb, rss);
    const atMs = Date.now() - started;
    if (atMs >= nextSampleAt) {
      rssSeries.push({ atMs, rssKb: rss });
      nextSampleAt = atMs + sampleEveryMs;
    }
    await Bun.sleep(200);
  }
  // The shell lingers after sinking; snapshot the AT-SPI tree while it is still up
  // (probe and app share the session a11y bus), then kill it.
  if (existsSync(sink)) await Bun.sleep(800); // let the a11y tree settle
  const a11y = probeAtspi("bakeoff");
  proc.kill();
  await proc.exited.catch(() => {});
  // proc is the xvfb-run wrapper; the app it launched survives its death.
  const orphans = killStragglers(candidate);
  if (orphans > 0) console.warn(`${candidate}: killed ${orphans} orphaned shell process(es)`);
  contention.stop();
  rmSync(shellDist, { recursive: true, force: true });

  const stderrTail = (await stderrText).trim().split("\n").slice(-15).join("\n");
  if (!existsSync(sink)) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `${candidate}: shell produced no sink payload\n--- shell stderr ---\n${stderrTail}`,
    );
  }
  const payload = JSON.parse(readFileSync(sink, "utf8")) as SinkPayload;
  rmSync(work, { recursive: true, force: true });
  return { payload, peakRssKb, a11y, rssSeries, stderrTail };
}

// Fold a completed soak run into metrics + gates. Returns null when the run
// carried no soak payload, so a non-soak run is never given soak verdicts.
export function evalSoak(
  payload: SinkPayload,
  rssSeries: RssSample[],
  peakRssKb: number,
): {
  metrics: SoakMetrics;
  verdicts: GateResult[];
  cycles: SoakCycle[];
} | null {
  const soak = payload.soak;
  if (!soak || soak.cycles.length === 0) return null;
  const finalRssKb = rssSeries.length ? rssSeries[rssSeries.length - 1]!.rssKb : peakRssKb;
  // The last cycle may have been cut short by the soak deadline, leaving its p95
  // over a handful of samples. Gate on the last cycle that actually completed;
  // the partial one is still kept in soak_cycles.
  const complete = soak.cycles.filter((c) => !c.partial);
  const gateCycle = (complete.length ? complete : soak.cycles).at(-1)!;
  const metrics: SoakMetrics = {
    soak_minutes: Math.round(soak.actualMs / 60_000),
    cycles: soak.cycles.length,
    chars_typed: soak.charsTyped,
    peak_rss_mb: Math.round(peakRssKb / 1024),
    final_rss_mb: Math.round(finalRssKb / 1024),
    leak_slope_mb_per_hr: Number(leakSlopeMbPerHour(rssSeries).toFixed(1)),
    typing_p95_first_cycle_ms: soak.cycles[0]!.typingP95Ms,
    typing_p95_last_cycle_ms: gateCycle.typingP95Ms,
  };
  // The per-cycle series is the only thing that distinguishes a steady climb
  // from a cliff late in the session. Summarising it to first/last and dropping
  // the rest throws away the evidence needed to interpret a soak failure.
  return { metrics, verdicts: evaluateSoakGates(metrics), cycles: soak.cycles };
}

async function main(): Promise<void> {
  const fixture =
    process.argv.find((a) => a.startsWith("--fixture="))?.split("=")[1] ?? "tiny";
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] as
    | Candidate
    | undefined;
  const candidates: Candidate[] = only ? [only] : ["tauri", "electron"];
  const plan = planMatrix({ fixture, candidates });
  const soakMin = Number(
    process.argv.find((a) => a.startsWith("--soak-min="))?.split("=")[1] ?? "0",
  );
  if (!Number.isFinite(soakMin) || soakMin < 0) {
    throw new Error(`--soak-min must be a non-negative number, got ${soakMin}`);
  }
  const soakMs = Math.round(soakMin * 60_000);
  const variants = parseVariants(
    process.argv.find((a) => a.startsWith("--variant="))?.split("=")[1],
  );

  if (process.env.BAKEOFF_GUI !== "1") {
    console.log(
      JSON.stringify(
        { dryRun: true, reason: "set BAKEOFF_GUI=1 to run shells", plan, soakMin, variants },
        null,
        2,
      ),
    );
    return;
  }

  // Build the shared bundle once. Fail loud: a swallowed build error would leave
  // an empty dist/ and every candidate would hang to its deadline before dying
  // with an unhelpful "no sink payload".
  const build = Bun.spawnSync(["bun", "build.ts"], {
    cwd: BAKEOFF_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    // The soak duration is a build-time constant in the page bundle, so the
    // build must be re-run per soak length. Both shells load the same bundle.
    env: {
      ...process.env,
      BAKEOFF_SOAK_MS: String(soakMs),
      BAKEOFF_LAZY_DOCS: variants.includes("lazy-docs") ? "1" : "0",
      BAKEOFF_CONTAIN_NAV: variants.includes("contain-nav") ? "1" : "0",
      BAKEOFF_NAV_CAP: variants.includes("nav-cap") ? String(NAV_CAP_ROWS) : "0",
    },
  });
  if (build.exitCode !== 0) {
    throw new Error(`shared bundle build failed (exit ${build.exitCode})`);
  }

  const fixtureDir = join(REPO_ROOT, "lab/fixtures/out", fixture);
  if (!existsSync(fixtureDir)) {
    throw new Error(
      `fixture not generated: ${fixtureDir} (run: bun fixtures/gen/src/cli.ts ${fixture})`,
    );
  }

  const resultsDir = join(REPO_ROOT, "lab/results");
  const records = [];
  for (const entry of plan) {
    const { payload, peakRssKb, a11y, rssSeries, stderrTail } = await runShell(
      entry.candidate, fixtureDir, fixture, soakMs, variants,
    );
    const { fixture: recFixture, metrics, verdicts } = evalRun(payload, peakRssKb, a11y);
    const soakEval = evalSoak(payload, rssSeries, peakRssKb);
    // A run asked to soak that produced no soak payload has not been soaked;
    // recording it under a soak run id would claim a measurement that never
    // happened, so it fails loudly rather than emitting a short-run result.
    if (soakMs > 0 && !soakEval) {
      throw new Error(
        `${entry.candidate}: soak requested (${soakMin} min) but the run ` +
        `returned no soak payload. Payload fixture="${payload.fixture}", ` +
        `samples=${payload.samples.length}, coldStartMs=${payload.coldStartMs} ` +
        `(fixture "error" and -1 timings mean the PAGE threw, not a build ` +
        `misconfiguration).\n--- shell stderr ---\n${stderrTail}`,
      );
    }
    const rec = buildResult({
      runId:
        `bakeoff-${entry.candidate}-${fixture}` +
        (soakEval ? "-soak" : "") + variantSuffix(variants),
      candidate: entry.candidate,
      fixture: recFixture,
      verdicts: soakEval ? [...verdicts, ...soakEval.verdicts] : verdicts,
      metrics: soakEval
        ? {
            ...metrics,
            variants,
            soak: soakEval.metrics,
            soak_cycles: soakEval.cycles,
            rss_series: rssSeries,
          }
        : { ...metrics, variants },
      seed: payload.seed,
      rigCommit: gitSha(),
      environment: env(),
    });
    writeResult(rec, resultsDir);
    records.push(rec);
    // Count the verdicts actually recorded, soak gates included. Counting only
    // the short-run gates printed "0 fails" for a soak that failed two of them.
    const failed = rec.verdicts.filter((v) => v.verdict === "FAIL");
    console.log(
      `${entry.candidate}: ${failed.length} fails` +
      (failed.length ? ` (${failed.map((v) => v.gate).join(", ")})` : ""),
    );
  }

  // The candidate is part of the name whenever --only narrows the run: without
  // it, a tauri run and an electron run of the same config silently overwrite
  // each other's report.
  const reportPath = join(
    resultsDir,
    `report-bakeoff-${fixture}` + (soakMs > 0 ? "-soak" : "") +
    (only ? `-${only}` : "") + variantSuffix(variants) + ".md",
  );
  await Bun.write(reportPath, renderReport(records));
  console.log(`report -> ${reportPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
