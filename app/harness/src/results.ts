// app/harness/src/results.ts
// Result records on the fixed top-level schema set by the technical-discovery
// spec. Numbers come only from measurement and are never hand-edited.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveIfPresent } from "./archive";
import type { Environment } from "./env";
import type { GateResult } from "./gates";

export type Candidate = "tauri";

export interface ResultInput {
  runId: string;
  candidate: Candidate;
  fixture: string;
  workload: WorkloadLabel;
  verdicts: GateResult[];
  metrics: Record<string, unknown>;
  seed: string;
  rigCommit: string;
  environment: Environment;
}

/** What the run actually drove. This was hardcoded to "app-smoke" for every
 *  result the project has written, so navigator, persistence and hierarchy
 *  evidence all describe themselves as a smoke run. Committed evidence has to
 *  say what it is; the already-written files keep their wrong label because a
 *  measured file is never hand-edited. */
export type WorkloadLabel =
  | "app-smoke"
  | "app-bible"
  | "app-navigator"
  | "app-persist"
  | "app-hier"
  | "app-hand"
  | "app-switch"
  | "app-project"
  | "app-outline"
  | "app-words"
  | "app-export"
  | "app-find"
  | "app-import"
  | "app-import-docx"
  | "app-prefs"
  | "app-window"
  | "app-goals"
  | "app-dialog"
  | "app-first"
  | "app-home"
  | "app-menu"
  | "app-replace"
  | "app-history"
  | "app-mreplace"
  | "app-context"
  | "app-salvage"
  | "app-mirror"
  | "app-timeline"
  | "app-preflight"
  | "app-pictures"
  | "app-preview"
  | "app-mirror-acts"
  | "app-diagnostic";

export interface ResultRecord {
  run_id: string;
  track: "app";
  candidate: Candidate;
  fixture: string;
  workload: WorkloadLabel;
  environment: Environment;
  method: string;
  metrics: Record<string, unknown>;
  verdicts: GateResult[];
  seed: string;
  rig_commit: string;
}

/** The workload script a payload reports, or the sentinel for the seven results
 *  recorded before the field existed. Not defaulted to the current script: a
 *  result that cannot say what it ran must not claim to have run this. */
export function scriptOf(reported: string | undefined): string {
  return reported ?? "pre-versioning";
}

export function buildResult(input: ResultInput): ResultRecord {
  return {
    run_id: input.runId,
    track: "app",
    candidate: input.candidate,
    fixture: input.fixture,
    workload: input.workload,
    environment: input.environment,
    method:
      "Tauri 2 host on WebKitGTK, UI served at runtime over a custom URI " +
      "scheme; readiness reported by the page through the sink command. " +
      "Summed process-tree RSS sampled from /proc. AT-SPI exposure probed via " +
      "pyatspi when available, UNKNOWN when not. SCOPE: Linux/ext4 only; " +
      "latency and startup gates are hypotheses until a real-hardware pass.",
    metrics: input.metrics,
    verdicts: input.verdicts,
    seed: input.seed,
    rig_commit: input.rigCommit,
  };
}

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
