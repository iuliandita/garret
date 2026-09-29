// lab/fault-rig/src/durability-cli.ts
// Root-only entrypoint for the two fault classes SIGKILL cannot reach.
//   sudo bun fault-rig/src/durability-cli.ts <fixture> [workDir]
// Results are chowned back to the invoking user so the repo keeps clean
// ownership after a sudo run.
import { readFileSync, existsSync, mkdirSync, chownSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runPowerLossCase, runDiskFullCase, requireRoot } from "./durability";
import { buildResult, writeResult, type CaseVerdict } from "./results";
import { renderReport } from "./report";
import { captureEnv } from "../../throttle/capture-env";
import type { BackendId } from "./model";

const METHOD =
  "Block-layer fault injection on an ext4 loopback volume behind dm-flakey. " +
  "power-loss@drop-writes: the device is switched to drop_writes underneath a " +
  "live filesystem, discarding every block still in the page cache, then the " +
  "volume is remounted and compared against the ledger of acknowledged durable " +
  "writes. Unlike SIGKILL this DOES test fsync durability: a backend that acks " +
  "before its data reaches the platter loses acked ops here and is scored " +
  "REGRESSION. disk-full@enospc: the volume is pre-filled so a commit meets a " +
  "real ENOSPC; dropping later ops is acceptable, losing an acked op or " +
  "corrupting the project is not. SCOPE: one filesystem (ext4) on one kernel; " +
  "no barrier/FUA reordering is simulated, so this is a lower bound on " +
  "power-loss hostility, not a worst case.";

// Full scene text from the generated fixture, so disk-full commits have real
// mass instead of the few kilobytes an empty project writes.
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

// A sudo run would otherwise leave root-owned files in the working tree.
function restoreOwnership(dir: string): void {
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (!Number.isFinite(uid) || !Number.isFinite(gid)) return;
  chownSync(dir, uid, gid);
  for (const entry of readdirSync(dir)) {
    try { chownSync(join(dir, entry), uid, gid); } catch {}
  }
}

requireRoot();

const fixture = process.argv[2] ?? "tiny";
const labDir = join(import.meta.dir, "..", "..");
// Default work dir sits in the repo, which is on real disk. /tmp here is tmpfs,
// where a "durability" result would be meaningless.
const workDir = process.argv[3] ?? join(labDir, ".durability-work");
const resultsDir = join(labDir, "results");
const fixtureDir = join(labDir, "fixtures", "out", fixture);
const scenes = scenesFromFixture(fixtureDir);
const manuscript = manuscriptFromFixture(fixtureDir);
const env = captureEnv({ allowedCpus: "0-3", memoryMax: "8G" });

mkdirSync(workDir, { recursive: true });

// NEGATIVE CONTROL FIRST. A backend that never fsyncs must lose acked writes
// here. If it survives, the block-layer injection is not reaching the disk and
// every other verdict in this run is worthless — so the run says so and exits
// non-zero rather than reporting a PASS it cannot justify.
const controlSpec = {
  backendId: "nofsync-control" as BackendId,
  workDir, seed: `${fixture}-seed`, scenes, opCount: 40, imageMB: 32,
  preload: manuscript,
};
const control = await runPowerLossCase(controlSpec);
const controlDetected = control.verdict === "REGRESSION" || control.verdict === "CORRUPT";
console.log(
  `CONTROL nofsync-control ${control.case}: ${control.verdict} ` +
  `(acked ${control.acked_ops}) -> injection ` +
  `${controlDetected ? "WORKS" : "NOT DETECTED"}`,
);
if (!controlDetected) {
  console.error(
    "\nHARNESS INVALID: a backend that never calls fsync survived simulated " +
    "power loss. The drop_writes injection is not reaching the disk, so no " +
    "durability conclusion can be drawn from this run. Not writing results.",
  );
  process.exit(1);
}

const records = [];
for (const backendId of ["dir-manifest", "sqlite"] as BackendId[]) {
  const spec = {
    backendId,
    workDir,
    seed: `${fixture}-seed`,
    scenes,
    opCount: 40,
    imageMB: 32,
    // 8 MB holds the ~1 MB manuscript with room for a handful of 256 KB
    // commits, so the volume fills partway through the workload.
    diskFullImageMB: 8,
    preload: manuscript,
  };
  const cases = [
    await runPowerLossCase(spec),
    await runDiskFullCase(spec),
  ];
  for (const c of cases) {
    console.log(`${backendId} ${c.case}: ${c.verdict} (acked ${c.acked_ops}) ${c.detail}`);
  }
  const verdicts: CaseVerdict[] = cases.map((c) => ({
    case: c.case, verdict: c.verdict,
  }));
  records.push(buildResult({
    runId: `${backendId}-${fixture}-durability`,
    backendId,
    fixture,
    verdicts,
    metrics: { durability: cases, durability_control: control },
    seed: `${fixture}-seed`,
    rigCommit: rigCommit(),
    method: METHOD,
    environment: {
      kernel: env.kernel,
      cpu: env.cpuModel,
      throttleScope: `${env.throttle.allowedCpus}/${env.throttle.memoryMax}`,
      biasNotes: env.biasNotes,
    },
  }));
}
for (const rec of records) writeResult(rec, resultsDir);
const md = renderReport(records);
await Bun.write(join(resultsDir, `report-durability-${fixture}.md`), md);
restoreOwnership(resultsDir);
restoreOwnership(workDir);
console.log(md);
