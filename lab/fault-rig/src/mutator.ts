// lab/fault-rig/src/mutator.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MutatorHandle {
  stop(): Promise<void>;
}

// Simulates a cloud-sync client dropping temp/lock files into the project dir
// while a writer runs (A4 interference). Creates only `.sync-*` files so it
// never overwrites backend state, but exercises the writer's tolerance of a
// churning directory.
export function startMutator(projectDir: string, intervalMs: number): MutatorHandle {
  let n = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      writeFileSync(join(projectDir, `.sync-${n++}.tmp`), `interference ${n}`);
    } catch {
      // directory may vanish between projects; ignore.
    }
  }, intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
