// lab/bakeoff/editor-core/src/stats.ts
// Pure latency statistics. Nearest-rank percentiles so a small sample reports a
// real observed value, not an interpolation. Shared by page and harness.

export interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function nearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // rank = ceil(p/100 * N), 1-indexed.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function percentiles(samples: number[]): Stats {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

// Frame commit latency: next-frame timestamp minus the keydown timestamp.
// Clamped at zero so a same-tick frame never reports negative.
export function frameDelta(keyTs: number, frameTs: number): number {
  return Math.max(0, frameTs - keyTs);
}
