// lab/bakeoff/harness/src/results.ts
// Mirrors lab/fault-rig/src/results.ts shape for the bake-off track. Serialized
// to the spec schema (snake_case). Numbers come only from measurement.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { archiveIfPresent } from "../../../shared/archive";

export type Candidate = "tauri" | "electron";
// ADVISORY: measured and recorded, but does not eliminate. Added by the A2
// pre-commitment gate revision of 2026-07-26 (see gates.ts ADVISORY_GATES).
export type GateVerdict = "PASS" | "FAIL" | "UNKNOWN" | "ADVISORY";

export interface Environment {
  kernel: string;
  cpu: string;
  throttleScope: string;
  biasNotes: string;
}

export interface GateResult {
  gate: string;
  value: number | string;
  threshold: string;
  verdict: GateVerdict;
}

export interface ResultInput {
  runId: string;
  candidate: Candidate;
  fixture: string;
  verdicts: GateResult[];
  metrics: Record<string, unknown>;
  seed: string;
  rigCommit: string;
  environment: Environment;
}

export interface ResultRecord {
  run_id: string;
  track: "bakeoff";
  candidate: Candidate;
  fixture: string;
  workload: "bakeoff-suite";
  environment: Environment;
  method: string;
  metrics: Record<string, unknown>;
  verdicts: GateResult[];
  seed: string;
  rig_commit: string;
}

export function buildResult(input: ResultInput): ResultRecord {
  return {
    run_id: input.runId,
    track: "bakeoff",
    candidate: input.candidate,
    fixture: input.fixture,
    workload: "bakeoff-suite",
    environment: input.environment,
    method:
      "In-page keydown->next-frame latency (double requestAnimationFrame), " +
      "identical bundled run.js in both shells; no CDP or Chromium-only " +
      "tracing (WebKitGTK exposes none). Summed process-tree RSS sampled from " +
      "/proc during the run. AT-SPI exposure probed via pyatspi when available. " +
      "SCOPE: cgroup-throttled approximation of reference hardware; gates are " +
      "hypotheses until a real-hardware pass. macOS unmeasured.",
    metrics: input.metrics,
    verdicts: input.verdicts,
    seed: input.seed,
    rig_commit: input.rigCommit,
  };
}

// Never clobbers: a previous run of the same configuration is moved into
// results/superseded/ first. run_id is a configuration key, so re-running any
// matrix cell targets a filename that may already hold a different run.
export function writeResult(rec: ResultRecord, resultsDir: string): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, `${rec.run_id}.json`);
  const displaced = archiveIfPresent(path);
  writeFileSync(path, JSON.stringify(rec, null, 2));
  if (displaced) {
    console.warn(
      `note: ${rec.run_id} already had a result; the previous run was kept at ` +
      `${displaced} rather than overwritten.`,
    );
  }
  return path;
}
