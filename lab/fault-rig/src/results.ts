// lab/fault-rig/src/results.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { archiveIfPresent } from "../../shared/archive";
import type { BackendId, Verdict } from "./model";
import type { CommitMetrics } from "./measure";
import type { SalvageEvidence } from "./salvage";
import type { DurabilityCase } from "./durability";
import type { SpotcheckEvidence } from "./spotcheck";

export interface Environment {
  kernel: string;
  cpu: string;
  throttleScope: string;
  biasNotes: string;
}

export interface CaseVerdict { case: string; verdict: Verdict; }

// The spec fixes the top-level result schema, so the deferred Q5 numbers and the
// salvage evidence ride inside `metrics` rather than adding new top-level keys.
export interface RigMetrics {
  commit?: CommitMetrics;
  durability?: DurabilityCase[];
  durability_control?: DurabilityCase;
  commit_at_scale?: CommitMetrics;
  salvage?: SalvageEvidence[];
  spotcheck?: SpotcheckEvidence;
}

export interface ResultInput {
  runId: string;
  backendId: BackendId;
  fixture: string;
  verdicts: CaseVerdict[];
  metrics: RigMetrics;
  seed: string;
  rigCommit: string;
  environment: Environment;
  // Fault classes with different scope limits carry their own method text; the
  // SIGKILL default below would be a false claim for the durability path.
  method?: string;
}

// Serialized to the spec schema (snake_case in the JSON file).
export interface ResultRecord {
  run_id: string;
  track: "fault-rig";
  candidate: BackendId;
  fixture: string;
  workload: "scripted-edit";
  environment: Environment;
  method: string;
  metrics: RigMetrics;
  verdicts: CaseVerdict[];
  seed: string;
  rig_commit: string;
}

export function buildResult(input: ResultInput): ResultRecord {
  return {
    run_id: input.runId,
    track: "fault-rig",
    candidate: input.backendId,
    fixture: input.fixture,
    workload: "scripted-edit",
    environment: input.environment,
    method: input.method ??
      "SIGKILL at durability phase markers and random delays; reopen + " +
      "integrity check + refmodel state comparison. Any lost acked op = " +
      "REGRESSION; unknown-but-intact state = CORRUPT. SCOPE: process-kill " +
      "tests atomicity/crash-consistency only; the kernel and page cache " +
      "survive, so this does NOT prove fsync durability against power loss. " +
      "A missing-fsync regression would not surface here; power-loss-class " +
      "evidence requires the root-gated loopback path.",
    metrics: input.metrics,
    verdicts: input.verdicts,
    seed: input.seed,
    rig_commit: input.rigCommit,
  };
}

// Never clobbers: a previous run of the same configuration is moved into
// results/superseded/ first. `sqlite-<fixture>.json` in particular is the
// baseline the rusqlite spot-check compares against, so overwriting it in place
// would silently change what a "11/11 agreed" verdict was measured against.
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
