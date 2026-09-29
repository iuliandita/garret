// lab/throttle/capture-env.ts
import { cpus, release, totalmem } from "node:os";

export interface Throttle {
  allowedCpus: string;
  memoryMax: string;
}

export interface EnvCapture {
  kernel: string;
  cpuModel: string;
  hostTotalMemBytes: number;
  throttle: Throttle;
  biasNotes: string;
  capturedAt: string;
}

export function captureEnv(throttle: Throttle): EnvCapture {
  return {
    kernel: release(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    hostTotalMemBytes: totalmem(),
    throttle,
    biasNotes:
      "cgroup-throttled approximation of reference hardware (4 threads, 8G); " +
      "modern single-core speed exceeds a five-year-old laptop core. Gates " +
      "remain hypotheses until a real-hardware pass.",
    capturedAt: new Date().toISOString(),
  };
}

if (import.meta.main) {
  const allowedCpus = process.argv[2] ?? "0-3";
  const memoryMax = process.argv[3] ?? "8G";
  console.log(JSON.stringify(captureEnv({ allowedCpus, memoryMax }), null, 2));
}
