// lab/fault-rig/src/workload.ts
import { createHash } from "node:crypto";
import { makePrng } from "../../fixtures/gen/src/prng";
import type { EditOp } from "./model";

// Ops per matrix run. Shared because the binding spot-check compares its
// verdicts against a recorded run: a different op count silently produces a
// different workload from the same seed, and the comparison becomes a lie.
export const MATRIX_OP_COUNT = 40;

// Weighted op mix: mostly typing, periodic structural + durability ops.
export function buildWorkload(
  seed: string,
  sceneIds: string[],
  count: number,
): EditOp[] {
  const rng = makePrng(`faultrig:${seed}`);
  const ops: EditOp[] = [];
  for (let i = 0; i < count; i++) {
    // Force full kind coverage in the first five ops, then weight by roll.
    let kind: EditOp["kind"];
    if (i === 0) kind = "type";
    else if (i === 1) kind = "reorder";
    else if (i === 2) kind = "import-asset";
    else if (i === 3) kind = "snapshot";
    else if (i === 4) kind = "migrate";
    else {
      const roll = rng.next();
      kind =
        roll < 0.7 ? "type"
        : roll < 0.82 ? "reorder"
        : roll < 0.92 ? "import-asset"
        : roll < 0.98 ? "snapshot"
        : "migrate";
    }
    const op: EditOp = { seq: i, kind };
    if (kind === "type") {
      op.sceneId = rng.pick(sceneIds);
      op.text = ` w${i}`; // small deterministic burst
    } else if (kind === "reorder") {
      op.fromOrder = rng.int(sceneIds.length);
      op.toOrder = rng.int(sceneIds.length);
    } else if (kind === "import-asset") {
      op.assetName = `asset-${i}.bin`;
      op.assetHash = createHash("sha256")
        .update(`${seed}:${i}`)
        .digest("hex")
        .slice(0, 16);
    }
    ops.push(op);
  }
  return ops;
}
