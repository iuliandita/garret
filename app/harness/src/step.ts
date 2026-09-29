// app/harness/src/step.ts
// Where a run's cycle p95 steps up and stays up.
//
// Why this exists alongside the page's onset tracker. That tracker keys on
// SLOW_FRAME_MS (100 ms), which is right for the 1 Hz collapse and blind to a
// 34 -> 50 ms step. A live-session run degraded permanently at ~615 s, and the
// CLI printed "onset: none — the run stayed healthy" while the cycle table in
// the same payload showed the plateau. A summary that can only see one
// magnitude of degradation reports the other as health.
import { MIN_TREND_CYCLES, type Cycle } from "./gates";

export interface DegradationStep {
  cycle: number;
  atMs: number;
  p95Ms: number;
  baselineP95Ms: number;
}

/** Sustained, not a spike: a step must hold across this many complete cycles. */
export const STEP_HOLD_CYCLES = 3;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * First complete cycle whose p95 exceeds `factor` x the baseline and stays
 * above it for STEP_HOLD_CYCLES cycles. Baseline is the median of the first
 * `baselineN` complete cycles — median, not mean, so one slow warmup cycle
 * cannot raise the bar and hide the step it was supposed to reveal.
 */
export function degradationStep(
  cycles: Cycle[],
  factor = 1.3,
  baselineN = MIN_TREND_CYCLES,
): DegradationStep | null {
  // Partial cycles carry a handful of samples, so their p95 is "the slowest of
  // a few" — the artifact that once produced a cliff ratio of 8.11 on a flat run.
  const complete = cycles.filter((c) => !c.partial);
  if (complete.length < baselineN + STEP_HOLD_CYCLES) return null;

  const baseline = median(complete.slice(0, baselineN).map((c) => c.typingP95Ms));
  if (baseline <= 0) return null;
  const limit = baseline * factor;

  for (let i = baselineN; i <= complete.length - STEP_HOLD_CYCLES; i++) {
    const held = complete
      .slice(i, i + STEP_HOLD_CYCLES)
      .every((c) => c.typingP95Ms > limit);
    if (held) {
      const at = complete[i]!;
      return {
        cycle: at.cycle,
        atMs: at.atMs,
        p95Ms: at.typingP95Ms,
        baselineP95Ms: baseline,
      };
    }
  }
  return null;
}
