// app/harness/src/rss-series.ts
// What a run's memory did over time, not only how high it got.
//
// Why this exists. `runShell` has always sampled the process tree's RSS every
// 250 ms and kept one number, the maximum. A boot transient that settles and a
// steady-state rise that never does therefore read as the same figure, which is
// what stopped the 2026-08-25 regression (753, then 571 with nothing done to
// memory) being root-caused: it was bisected to "creating one <span> costs
// 68 MB" and the evidence ran out there. Pure, so it can be tested and mutated
// outside a rig.
export interface RssSample {
  /** Milliseconds since the shell was spawned. */
  atMs: number;
  rssMb: number;
}

export interface RssSummary {
  samples: number;
  span_ms: number;
  peak_mb: number;
  /** The FIRST sample at the peak. */
  peak_at_ms: number;
  boot_window_ms: number;
  /** True when the peak fell inside [0, boot_window_ms). */
  peak_in_boot_window: boolean;
  /** Maximum over [0, boot_window_ms); 0 when no sample landed there. */
  boot_window_peak_mb: number;
  post_boot_samples: number;
  /** Null, not zero, when nothing was sampled after the boot window: a run
   *  shorter than its own boot window has no steady state to report. */
  post_boot_median_mb: number | null;
  post_boot_max_mb: number | null;
  /** Least-squares slope over the post-boot samples, MB per minute. Null with
   *  fewer than two samples: one point has no slope. */
  post_boot_slope_mb_per_min: number | null;
}

/** Maximum per bucket, stamped at the bucket start. Buckets nothing landed in
 *  are absent rather than zero: a gap in sampling is not a moment of no memory. */
export function bucketRss(samples: RssSample[], bucketMs: number): RssSample[] {
  const out: RssSample[] = [];
  for (const s of samples) {
    const atMs = Math.floor(s.atMs / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last !== undefined && last.atMs === atMs) {
      if (s.rssMb > last.rssMb) last.rssMb = s.rssMb;
    } else {
      out.push({ atMs, rssMb: s.rssMb });
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** Ordinary least squares, x in minutes. */
function slopePerMin(points: RssSample[]): number {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.atMs / 60_000;
    sy += p.rssMb;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.atMs / 60_000 - mx;
    num += dx * (p.rssMb - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

export function summarizeRss(samples: RssSample[], bootWindowMs: number): RssSummary {
  if (samples.length === 0) {
    throw new Error("no RSS samples: the sampler never ran, and that is not a flat series");
  }
  if (!(bootWindowMs > 0)) {
    throw new Error(`boot window must be positive, got ${bootWindowMs}`);
  }
  let peak = samples[0]!;
  for (const s of samples) if (s.rssMb > peak.rssMb) peak = s;

  const boot = samples.filter((s) => s.atMs < bootWindowMs);
  const post = samples.filter((s) => s.atMs >= bootWindowMs);
  const first = samples[0]!.atMs;
  const last = samples[samples.length - 1]!.atMs;

  return {
    samples: samples.length,
    span_ms: last - first,
    peak_mb: peak.rssMb,
    peak_at_ms: peak.atMs,
    boot_window_ms: bootWindowMs,
    peak_in_boot_window: peak.atMs < bootWindowMs,
    boot_window_peak_mb: boot.reduce((m, s) => Math.max(m, s.rssMb), 0),
    post_boot_samples: post.length,
    post_boot_median_mb: post.length > 0 ? median(post.map((s) => s.rssMb)) : null,
    post_boot_max_mb: post.length > 0 ? post.reduce((m, s) => Math.max(m, s.rssMb), 0) : null,
    post_boot_slope_mb_per_min: post.length >= 2 ? slopePerMin(post) : null,
  };
}
