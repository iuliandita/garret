// lab/fault-rig/src/spotcheck-cli.ts
// Q3 hedge entrypoint: `cd lab && bun fault-rig/src/spotcheck-cli.ts <fixture>`.
// Requires the Rust child to be built first (see childcmd.RUST_CHILD_BUILD).
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMatrixCases } from "./matrix";
import { buildResult, writeResult, type CaseVerdict } from "./results";
import { renderReport } from "./report";
import { spotcheckCases, buildSpotcheckEvidence } from "./spotcheck";
import { RUST_CHILD, RUST_CHILD_BUILD } from "./childcmd";
import { MATRIX_OP_COUNT } from "./workload";
import { captureEnv } from "../../throttle/capture-env";
import type { ResultRecord } from "./results";

function scenesFromFixture(fixtureDir: string): string[] {
  const projectPath = join(fixtureDir, "project.json");
  if (!existsSync(projectPath)) return ["s1", "s2", "s3", "s4", "s5"];
  const proj = JSON.parse(readFileSync(projectPath, "utf8"));
  const ids = (proj.items ?? [])
    .filter((it: any) => it.type === "scene")
    .map((it: any) => it.id)
    .slice(0, 200);
  return ids.length ? ids : ["s1", "s2", "s3", "s4", "s5"];
}

function rigCommit(): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

function bunSqliteVersion(): string {
  const d = new Database(":memory:");
  try {
    return (d.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
  } finally {
    d.close();
  }
}

function rusqliteSqliteVersion(): string {
  const r = Bun.spawnSync([RUST_CHILD, "--sqlite-version"]);
  if (r.exitCode !== 0) {
    throw new Error(`rust child failed to report its SQLite version: ${r.stderr}`);
  }
  return r.stdout.toString().trim();
}

const fixture = process.argv[2] ?? "normal";
const resultsDir = join(import.meta.dir, "..", "..", "results");
const fixtureDir = join(import.meta.dir, "..", "..", "fixtures", "out", fixture);

if (!existsSync(RUST_CHILD)) {
  console.error(`rust child binary missing: ${RUST_CHILD}\nbuild it: ${RUST_CHILD_BUILD}`);
  process.exit(2);
}

// The baseline is the committed bun:sqlite run for the same fixture. Without it
// there is nothing to compare against, so this is fatal rather than a warning.
const baselinePath = join(resultsDir, `sqlite-${fixture}.json`);
if (!existsSync(baselinePath)) {
  console.error(
    `no bun:sqlite baseline at ${baselinePath}\n` +
    `run it first: bun fault-rig/src/cli.ts ${fixture} 3`,
  );
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as ResultRecord;

const scenes = scenesFromFixture(fixtureDir);
const env = captureEnv({ allowedCpus: "0-3", memoryMax: "8G" });
const seed = `${fixture}-seed`;

// Same seed, same op count, same case names as the baseline run: the workloads
// must be byte-identical or the verdicts are not comparable.
if (baseline.seed !== seed) {
  console.error(`baseline seed ${baseline.seed} != ${seed}; verdicts not comparable`);
  process.exit(2);
}

const cases = spotcheckCases();
const root = mkdtempSync(join(tmpdir(), "spotcheck-sqlite-rs-"));
const outcome = await runMatrixCases(
  "sqlite-rs", root, seed, scenes, MATRIX_OP_COUNT, cases,
);
const verdicts: CaseVerdict[] = outcome.verdicts;

const evidence = buildSpotcheckEvidence({
  baselineRunId: baseline.run_id,
  baselineRigCommit: baseline.rig_commit,
  readerBinding: "bun:sqlite",
  writerBinding: "rusqlite 0.40 (system libsqlite3)",
  sqliteVersionReader: bunSqliteVersion(),
  sqliteVersionWriter: rusqliteSqliteVersion(),
  baseline: baseline.verdicts,
  candidate: verdicts,
});

const rec = buildResult({
  runId: `sqlite-rs-${fixture}-spotcheck`,
  backendId: "sqlite-rs",
  fixture,
  verdicts,
  metrics: { salvage: outcome.salvage, spotcheck: evidence },
  seed,
  rigCommit: rigCommit(),
  environment: {
    kernel: env.kernel,
    cpu: env.cpuModel,
    throttleScope: `${env.throttle.allowedCpus}/${env.throttle.memoryMax}`,
    biasNotes: env.biasNotes,
  },
  method:
    "Q3 binding hedge: the worst subset of the SIGKILL matrix plus both " +
    "offline corruption cases, re-run with a rusqlite child writer using the " +
    "same schema, pragmas (WAL, synchronous=FULL, wal_checkpoint(FULL) per " +
    "commit) and per-op delta writes. Verification, corruption injection and " +
    "salvage use the same bun:sqlite paths as the baseline, so only the WRITE " +
    "path differs. SCOPE: confirms the durability result is independent of the " +
    "binding; it re-measures no latency and cannot re-decide the encoding. " +
    "Process-kill still tests atomicity only, not fsync durability.",
});
writeResult(rec, resultsDir);

const md = renderReport([rec]);
await Bun.write(join(resultsDir, `report-spotcheck-${fixture}.md`), md);
console.log(md);

if (evidence.divergences.length > 0) {
  console.error(
    `DIVERGENCE on ${evidence.divergences.length}/${evidence.cases_compared} ` +
    "cases: the hedge fails and the encoding decision stays blocked.",
  );
  process.exit(1);
}
