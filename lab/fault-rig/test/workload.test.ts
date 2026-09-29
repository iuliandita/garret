// lab/fault-rig/test/workload.test.ts
import { describe, expect, test } from "bun:test";
import { buildWorkload } from "../src/workload";

const scenes = ["s1", "s2", "s3", "s4", "s5"];

describe("buildWorkload", () => {
  test("deterministic for same seed and scenes", () => {
    const a = buildWorkload("w-seed", scenes, 60);
    const b = buildWorkload("w-seed", scenes, 60);
    expect(a).toEqual(b);
  });

  test("emits exactly the requested op count with sequential seqs", () => {
    const ops = buildWorkload("w1", scenes, 40);
    expect(ops.length).toBe(40);
    ops.forEach((op, i) => expect(op.seq).toBe(i));
  });

  test("covers every op kind across a long workload", () => {
    const kinds = new Set(buildWorkload("w2", scenes, 200).map((o) => o.kind));
    expect(kinds).toEqual(
      new Set(["type", "reorder", "import-asset", "snapshot", "migrate"]),
    );
  });

  test("type/reorder ops reference known scenes and valid indices", () => {
    const ops = buildWorkload("w3", scenes, 120);
    for (const op of ops) {
      // EditOp is flat with optional payload fields, so `kind` narrows nothing.
      // "references a known scene" means both that sceneId is present and that
      // it is one of the scenes — assert the first, or the second passes vacuously.
      if (op.kind === "type") {
        expect(op.sceneId).toBeString();
        expect(scenes).toContain(op.sceneId as string);
      }
      if (op.kind === "reorder") {
        expect(op.fromOrder).toBeGreaterThanOrEqual(0);
        expect(op.fromOrder).toBeLessThan(scenes.length);
        expect(op.toOrder).toBeGreaterThanOrEqual(0);
        expect(op.toOrder).toBeLessThan(scenes.length);
      }
    }
  });

  test("asset ops carry a deterministic hash", () => {
    const a = buildWorkload("w4", scenes, 80).find((o) => o.kind === "import-asset");
    const b = buildWorkload("w4", scenes, 80).find((o) => o.kind === "import-asset");
    expect(a?.assetHash).toBeDefined();
    expect(a?.assetHash).toBe(b?.assetHash);
  });
});
