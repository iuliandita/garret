// app/harness/src/env.ts
// Host facts for the result record, read directly from /proc. No shell
// pipelines: a measurement rig that interpolates strings into a shell is a
// habit worth not forming, and these files are trivial to parse directly.
// Result JSON must carry no private paths, hostnames, or identities beyond the
// recorded hardware environment.
import { readFileSync } from "node:fs";
import type { RendererRecord } from "./renderer";

export interface Environment {
  kernel: string;
  cpu: string;
  throttleScope: string;
  /** 1-minute load average when the rig started, from /proc/loadavg. A
   *  latency FAIL recorded at load 9 on a machine with a game running is a
   *  fact about the machine, and before this nothing in the result said so. */
  loadAvg1m: number | null;
  biasNotes: string;
  /** The renderer of the most recent shell `runShell` launched in this
   *  process, null before any launch or when the web process was gone
   *  before it was read; a rig that launches under two backends must read
   *  `RunOutcome.renderer` per run instead. */
  renderer: RendererRecord | null;
}

let lastRenderer: RendererRecord | null = null;
/** Called by runShell once per launch, after the page has reported. */
export function noteRenderer(rec: RendererRecord | null): void {
  lastRenderer = rec;
}

export function parseLoadAvg1m(loadavg: string): number | null {
  const m = loadavg.match(/^(\d+(?:\.\d+)?)\s/);
  return m ? Number(m[1]) : null;
}

export function parseCpuModel(cpuinfo: string): string {
  const m = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
  return m ? m[1]!.trim() : "unknown";
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function captureEnv(throttleScope = process.env.APP_THROTTLE_SCOPE ?? "none"): Environment {
  return {
    kernel: read("/proc/sys/kernel/osrelease").trim() || "unknown",
    cpu: parseCpuModel(read("/proc/cpuinfo")),
    throttleScope,
    loadAvg1m: parseLoadAvg1m(read("/proc/loadavg")),
    renderer: lastRenderer,
    biasNotes:
      "Linux/ext4 only, per the 2026-07-26 scope narrowing. Development " +
      "machine; latency and startup thresholds remain hypotheses until a " +
      "real-hardware pass.",
  };
}
