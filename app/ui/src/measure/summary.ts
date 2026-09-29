// app/ui/src/measure/summary.ts
// Turns raw Samples into the distribution the sink payload reports: not just
// percentiles (which are blind to a rare-but-severe tail, see gates.ts) but a
// stall/slow-frame count and a histogram, so "are frame times quantized onto
// cadence boundaries" is something the data shows rather than something
// inferred from two suspiciously identical p95s.
import { percentiles, type Percentiles } from "./stats";
import type { Sample } from "./recorder";

export const SLOW_FRAME_MS = 100;

const HISTOGRAM_BUCKETS = ["<20", "20-40", "40-100", "100-500", "500-2000", ">=2000"] as const;

function bucketOf(frameMs: number): (typeof HISTOGRAM_BUCKETS)[number] {
  if (frameMs < 20) return "<20";
  if (frameMs < 40) return "20-40";
  if (frameMs < 100) return "40-100";
  if (frameMs < 500) return "100-500";
  if (frameMs < 2000) return "500-2000";
  return ">=2000";
}

export interface Distribution {
  count: number;
  dispatch: Percentiles;
  frame: Percentiles;
  stalls: number;
  slowFrames: number;
  histogram: Record<string, number>;
}

export function summarize(samples: Sample[]): Distribution {
  const histogram: Record<string, number> = Object.fromEntries(
    HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0]),
  );
  let stalls = 0;
  let slowFrames = 0;
  for (const s of samples) {
    histogram[bucketOf(s.frameMs)]++;
    if (s.stalled) {
      stalls++;
    } else if (s.frameMs > SLOW_FRAME_MS) {
      // Disjoint from stalls on purpose: a stalled sample's frameMs is
      // however long the timeout waited, which is always > SLOW_FRAME_MS, so
      // counting it in both would double-count the same sample against the
      // stall-rate gate downstream.
      slowFrames++;
    }
  }
  return {
    count: samples.length,
    dispatch: percentiles(samples.map((s) => s.dispatchMs)),
    frame: percentiles(samples.map((s) => s.frameMs)),
    stalls,
    slowFrames,
    histogram,
  };
}
