// lab/fault-rig/src/cli.ts
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMatrix } from "./matrix";
import { buildResult, writeResult, type CaseVerdict } from "./results";
import { renderReport } from "./report";
import { measureCommits } from "./measure";
import { runSalvageDemo } from "./salvage-demo";
import { MATRIX_OP_COUNT } from "./workload";
import { captureEnv } from "../../throttle/capture-env";
import type { BackendId } from "./model";

// Read scene ids from a generated fixture's project.json, if present.
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

// Full scene text from the generated fixture, used to charge commit latency
// against a manuscript-sized project instead of an empty one.
function manuscriptFromFixture(fixtureDir: string): Record<string, string> {
  const scenesPath = join(fixtureDir, "scenes.ndjson");
  if (!existsSync(scenesPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(scenesPath, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    out[row.id] = (row.blocks ?? []).map((b: any) => b.text ?? "").join("\n");
  }
  return out;
}

function rigCommit(): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

const fixture = process.argv[2] ?? "tiny";
const reps = Number(process.argv[3] ?? "3");
const resultsDir = join(import.meta.dir, "..", "..", "results");
const fixtureDir = join(import.meta.dir, "..", "..", "fixtures", "out", fixture);
const scenes = scenesFromFixture(fixtureDir);
const manuscript = manuscriptFromFixture(fixtureDir);
const env = captureEnv({ allowedCpus: "0-3", memoryMax: "8G" });

const OP_COUNT = MATRIX_OP_COUNT;
// One-second durable-write cadence, matching the spec's autosave stub.
const MIRROR_WINDOW_MS = 1000;

const records = [];
for (const backendId of ["dir-manifest", "sqlite"] as BackendId[]) {
  const root = mkdtempSync(join(tmpdir(), `matrix-${backendId}-`));
  const outcome = await runMatrix(
    backendId, root, `${fixture}-seed`, scenes, OP_COUNT, reps,
  );
  const verdicts: CaseVerdict[] = outcome.verdicts;
  // Clean unkilled pass over the same workload for the deferred Q5 numbers.
  const commit = await measureCommits({
    backendId,
    projectDir: mkdtempSync(join(tmpdir(), `measure-${backendId}-`)),
    seed: `${fixture}-seed`,
    scenes,
    opCount: OP_COUNT,
    mirrorWindowMs: MIRROR_WINDOW_MS,
  });
  // Deliberate damage sweep across the artifact, so salvage is demonstrated at
  // sites the matrix's header-only corruption never reaches.
  const demo = await runSalvageDemo({
    backendId, seed: `${fixture}-seed`, scenes, opCount: OP_COUNT,
  });
  // Same measurement charged against the loaded fixture: dir-manifest rewrites
  // the whole project per commit, so this is where that cost becomes visible.
  const commitAtScale = await measureCommits({
    backendId,
    projectDir: mkdtempSync(join(tmpdir(), `measure-scale-${backendId}-`)),
    seed: `${fixture}-seed`,
    scenes,
    opCount: OP_COUNT,
    mirrorWindowMs: MIRROR_WINDOW_MS,
    preload: manuscript,
  });
  const rec = buildResult({
    runId: `${backendId}-${fixture}`,
    backendId,
    fixture,
    verdicts,
    metrics: {
      commit, commit_at_scale: commitAtScale,
      salvage: [...outcome.salvage, ...demo],
    },
    seed: `${fixture}-seed`,
    rigCommit: rigCommit(),
    environment: {
      kernel: env.kernel,
      cpu: env.cpuModel,
      throttleScope: `${env.throttle.allowedCpus}/${env.throttle.memoryMax}`,
      biasNotes: env.biasNotes,
    },
  });
  writeResult(rec, resultsDir);
  records.push(rec);
}
const md = renderReport(records);
await Bun.write(join(resultsDir, `report-${fixture}.md`), md);
console.log(md);
