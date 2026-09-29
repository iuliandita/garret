// lab/bakeoff/harness/src/contention-index.ts
// Indexing contention: a background FTS-ingest proxy that keeps a CPU core busy
// hashing text, yielding briefly so it does not fully starve the editor. Spawned
// as a sibling process during a shell run; killed when the run ends.
import { createHash } from "node:crypto";

function tick(): void {
  for (let i = 0; i < 2000; i++) {
    createHash("sha256").update(`ingest-${i}-${Date.now()}`).digest("hex");
  }
  setTimeout(tick, 5);
}
tick();
