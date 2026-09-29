// app/ui/src/measure/stats.ts
// Nearest-rank percentiles, matching the method discovery used so the numbers
// carry the same meaning (lab/bakeoff/editor-core/src/stats.ts). Restated, not
// imported: lab is frozen.
export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
}

function nearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export function percentiles(samples: number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
  };
}
