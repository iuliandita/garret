// lab/bakeoff/editor-core/src/workload.ts
// Deterministic seeded action script shared by both shells. Reuses the fixture
// PRNG so the sequence is reproducible cross-platform. The script interleaves a
// typing burst at the cursor, quick-open jumps across the project, and view
// switches, matching the spec's contention workloads.
import { makePrng } from "../../../fixtures/gen/src/prng";
import type { Action, SceneRef } from "./model";

export interface WorkloadOpts {
  typingChars: number;
  navJumps: number;
  viewSwitches: number;
}

const TYPE_CHARS = "abcdefghijklmnopqrstuvwxyz ,.".split("");

export function buildWorkload(
  seed: string,
  refs: SceneRef[],
  opts: WorkloadOpts,
): Action[] {
  const rng = makePrng(`workload:${seed}`);
  // Build the pool of actions, then shuffle deterministically so typing,
  // navigation, and view switches interleave rather than run in blocks.
  const pool: Action[] = [];
  for (let i = 0; i < opts.typingChars; i++) {
    pool.push({ seq: 0, kind: "type", char: rng.pick(TYPE_CHARS) });
  }
  for (let i = 0; i < opts.navJumps; i++) {
    pool.push({ seq: 0, kind: "quick-open", targetId: rng.pick(refs).id });
  }
  for (let i = 0; i < opts.viewSwitches; i++) {
    pool.push({ seq: 0, kind: "view-switch", targetId: rng.pick(refs).id });
  }
  // Fisher-Yates with the same PRNG stream.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.map((a, i) => ({ ...a, seq: i }));
}
