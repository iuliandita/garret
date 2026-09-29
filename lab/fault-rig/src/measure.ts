// lab/fault-rig/src/measure.ts
import { mkdirSync } from "node:fs";
import { buildWorkload } from "./workload";
import { makeBackendFor } from "./backend";
import { percentiles, dirSizeBytes, MirrorStub, type Pcts } from "./metrics";
import type { BackendId, EditOp } from "./model";

export interface CommitMetrics {
  ops: number;
  preloaded_bytes: number;   // manuscript already in the project before timing
  commit_latency_ms: Pcts & { mean: number; max: number; samples: number };
  size: {
    bytes_after: number;      // durable footprint of the project on disk
    bytes_per_op: number;     // growth per durable commit
    logical_bytes: number;    // bytes the workload actually authored
    overhead_ratio: number;   // footprint / authored bytes
  };
  mirror: {
    window_ms: number;
    flushes: number;              // debounced flushes over the run
    bytes_written: number;        // whole-artifact traffic, no coalescing credit
    coalesced_bytes_estimate: number; // what a debounced whole-file mirror ships
    amplification: number;        // bytes_written / logical_bytes
  };
}

export interface MeasureSpec {
  backendId: BackendId;
  projectDir: string;
  seed: string;
  scenes: string[];
  opCount: number;
  mirrorWindowMs: number;
  // Scene text applied (untimed) before measurement, so commits are charged
  // against a realistically sized project rather than an empty one.
  preload?: Record<string, string>;
}

// Bytes the author actually produced, as opposed to bytes the encoding wrote.
function logicalBytes(ops: EditOp[]): number {
  let total = 0;
  for (const op of ops) {
    if (op.text) total += Buffer.byteLength(op.text);
    if (op.assetHash) total += Buffer.byteLength(op.assetHash);
  }
  return total;
}

// Clean (unkilled) run of the same scripted workload the fault matrix uses,
// measuring the Q5 numbers the spec defers here: commit-latency distribution at
// the durability cadence, project size growth, and mirror write amplification.
export async function measureCommits(spec: MeasureSpec): Promise<CommitMetrics> {
  mkdirSync(spec.projectDir, { recursive: true });
  const ops = buildWorkload(spec.seed, spec.scenes, spec.opCount);
  const backend = makeBackendFor(spec.backendId, spec.projectDir);
  const mirror = new MirrorStub(spec.mirrorWindowMs);
  const noop = () => {};

  const samples: number[] = [];
  await backend.open();
  let preloadedBytes = 0;
  let seq = -1;
  for (const [sceneId, text] of Object.entries(spec.preload ?? {})) {
    await backend.apply({ seq: seq--, kind: "type", sceneId, text }, noop);
    preloadedBytes += Buffer.byteLength(text);
  }
  for (const op of ops) {
    const t0 = performance.now();
    await backend.apply(op, noop);
    samples.push(performance.now() - t0);
    // A folder mirror re-ships whole changed artifacts, so each durable commit
    // offers the full current footprint to the debouncer.
    mirror.note(dirSizeBytes(spec.projectDir));
  }
  await backend.close();
  // Let the final debounce window elapse so the trailing flush is counted.
  await new Promise((r) => setTimeout(r, spec.mirrorWindowMs * 2 + 5));

  const bytesAfter = dirSizeBytes(spec.projectDir);
  const authored = logicalBytes(ops);
  const pcts = percentiles(samples);

  return {
    ops: ops.length,
    preloaded_bytes: preloadedBytes,
    commit_latency_ms: {
      ...pcts,
      mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      max: Math.max(...samples),
      samples: samples.length,
    },
    size: {
      bytes_after: bytesAfter,
      bytes_per_op: bytesAfter / ops.length,
      logical_bytes: authored,
      overhead_ratio: bytesAfter / authored,
    },
    mirror: {
      window_ms: spec.mirrorWindowMs,
      flushes: mirror.flushes,
      bytes_written: mirror.bytesWritten,
      coalesced_bytes_estimate: mirror.flushes * bytesAfter,
      amplification: mirror.bytesWritten / authored,
    },
  };
}
