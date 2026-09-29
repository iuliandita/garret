// lab/bakeoff/harness/src/rss.ts
// Summed resident memory across a process tree, read from /proc. Linux-only,
// which is the Track 2 target OS. Used to sum a shell's main + webview/renderer
// + GPU-helper RSS for the < 750 MB gate. VmRSS in /proc/<pid>/status is KB.
import { readFileSync, readdirSync } from "node:fs";

export function readRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0; // process gone or not readable
  }
}

function childrenOf(pid: number): number[] {
  const kids: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return kids;
  }
  for (const p of pids) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      // comm (field 2) may contain spaces/parens; parse fields after the last
      // ')'. Then state=[0], ppid=[1].
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      if (ppid === pid) kids.push(Number(p));
    } catch {
      // race: process exited mid-scan, skip
    }
  }
  return kids;
}

// One point in a soak's resident-memory time series.
export interface RssSample {
  atMs: number;   // ms since sampling started
  rssKb: number;
}

// Least-squares slope of RSS over time, in MB per hour.
//
// `warmupFraction` drops the leading part of the series before fitting: startup
// allocation and first-touch page faults are not a leak, and including them
// makes every process look like it leaks. Fewer than two points after the trim
// yields 0 — no trend can be claimed from one sample.
export function leakSlopeMbPerHour(
  series: RssSample[],
  warmupFraction = 0.2,
): number {
  const start = Math.floor(series.length * warmupFraction);
  const pts = series.slice(start);
  if (pts.length < 2) return 0;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = p.atMs;
    const y = p.rssKb;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;  // every sample at the same instant
  const kbPerMs = (n * sxy - sx * sy) / denom;
  return (kbPerMs * 3_600_000) / 1024;
}

export function sumTreeRssKb(rootPid: number): number {
  const seen = new Set<number>();
  const stack = [rootPid];
  let total = 0;
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += readRssKb(pid);
    for (const c of childrenOf(pid)) if (!seen.has(c)) stack.push(c);
  }
  return total;
}
