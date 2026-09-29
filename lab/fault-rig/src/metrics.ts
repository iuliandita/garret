// lab/fault-rig/src/metrics.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Pcts { p50: number; p95: number; p99: number; }

// Nearest-rank percentiles over a numeric sample set.
export function percentiles(samples: number[]): Pcts {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => {
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
  };
  return { p50: at(50), p95: at(95), p99: at(99) };
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

// Debounced mirror: coalesces notes arriving within `windowMs` into one flush,
// counting the total bytes it would have mirrored (write amplification proxy).
export class MirrorStub {
  flushes = 0;
  bytesWritten = 0;
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private windowMs: number) {}

  note(bytes: number): void {
    this.pending += bytes;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  private flush(): void {
    if (this.pending > 0) {
      this.flushes += 1;
      this.bytesWritten += this.pending;
      this.pending = 0;
    }
    this.timer = null;
  }
}
