// lab/bakeoff/harness/src/contention.ts
// Starts the autosave + indexing sibling processes for a shell run and returns a
// handle to stop them. They inherit the throttled cgroup from the matrix run, so
// they contend with the shell for the same 4 CPUs / 8G, per spec.
import { join } from "node:path";

export interface Contention {
  stop(): void;
}

export function contentionScripts(): { autosave: string; index: string } {
  const here = import.meta.dir;
  return {
    autosave: join(here, "contention-autosave.ts"),
    index: join(here, "contention-index.ts"),
  };
}

export function startContention(workDir: string): Contention {
  const s = contentionScripts();
  const auto = Bun.spawn(["bun", s.autosave, join(workDir, "autosave.sqlite")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const idx = Bun.spawn(["bun", s.index], { stdout: "ignore", stderr: "ignore" });
  return {
    stop() {
      auto.kill();
      idx.kill();
    },
  };
}
