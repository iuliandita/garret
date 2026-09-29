// app/ui/src/measure/onset.ts
// Where the run stopped being healthy, to the exact action.
//
// Cycle records put onset within a cycle, which is 15 s and 460 actions wide at
// the default workload. Every attribution so far — document size, cycle count,
// wall-clock time, total actions — has been argued from that granularity, and
// several of them fit the same data. One exact index, with the clock and the
// character count beside it, is what tells those hypotheses apart.
import { SLOW_FRAME_MS } from "./summary";
import type { Sample } from "./recorder";
import type { ActionKind } from "./workload";

export interface OnsetMeta {
  /** Index in the whole run's action stream, across cycles. */
  actionIndex: number;
  kind: ActionKind;
  charsTyped: number;
  /** Milliseconds since the soak clock started. */
  atMs: number;
}

export type OnsetRecord = OnsetMeta & Sample;

export interface OnsetTracker {
  record(sample: Sample, meta: OnsetMeta): void;
  /** The first slow sample of the run, streak or not. */
  first(): OnsetRecord | null;
  /** Start of the first streak of `sustainMin` consecutive slow samples. */
  sustained(): OnsetRecord | null;
  slowCount(): number;
}

/** Consecutive slow samples before slowness counts as the collapse rather than
 *  a blip. Page warmup produced one 721 ms frame at action 1 of a run that was
 *  healthy for another 599 s, and first() dutifully called that the onset. */
export const DEFAULT_SUSTAIN_MIN = 5;

export function createOnsetTracker(
  slowMs: number = SLOW_FRAME_MS,
  sustainMin: number = DEFAULT_SUSTAIN_MIN,
): OnsetTracker {
  let first: OnsetRecord | null = null;
  let sustained: OnsetRecord | null = null;
  let streakStart: OnsetRecord | null = null;
  let streak = 0;
  let slowCount = 0;

  return {
    record(sample: Sample, meta: OnsetMeta): void {
      // A stall is the same pathology reported through the timeout race, so it
      // counts regardless of where its frameMs landed relative to slowMs.
      if (!sample.stalled && sample.frameMs <= slowMs) {
        streak = 0;
        streakStart = null;
        return;
      }
      slowCount++;
      const record: OnsetRecord = { ...meta, ...sample };
      first ??= record;
      streak++;
      streakStart ??= record;
      if (streak >= sustainMin && sustained === null) sustained = streakStart;
    },
    first: () => first,
    sustained: () => sustained,
    slowCount: () => slowCount,
  };
}
