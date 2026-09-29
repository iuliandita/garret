// lab/fault-rig/test/refmodel.test.ts
import { describe, expect, test } from "bun:test";
import { emptyState, applyPure, hashState } from "../src/refmodel";
import type { EditOp, ProjectState } from "../src/model";

const seed = (): ProjectState => ({
  scenes: { s1: "", s2: "" },
  order: ["s1", "s2"],
  assets: {},
  version: 0,
});

describe("applyPure", () => {
  test("type appends text to the target scene, immutably", () => {
    const before = seed();
    const op: EditOp = { seq: 0, kind: "type", sceneId: "s1", text: "hello" };
    const after = applyPure(before, op);
    expect(after.scenes.s1).toBe("hello");
    expect(before.scenes.s1).toBe(""); // input not mutated
  });

  test("reorder moves a scene in the order array", () => {
    const op: EditOp = { seq: 0, kind: "reorder", fromOrder: 0, toOrder: 1 };
    const after = applyPure(seed(), op);
    expect(after.order).toEqual(["s2", "s1"]);
  });

  test("import-asset records name -> hash", () => {
    const op: EditOp = {
      seq: 0, kind: "import-asset", assetName: "a.bin", assetHash: "deadbeef",
    };
    const after = applyPure(seed(), op);
    expect(after.assets["a.bin"]).toBe("deadbeef");
  });

  test("migrate bumps version; snapshot is a no-op on state", () => {
    const migrated = applyPure(seed(), { seq: 0, kind: "migrate" });
    expect(migrated.version).toBe(1);
    const snapped = applyPure(seed(), { seq: 0, kind: "snapshot" });
    expect(snapped).toEqual(seed());
  });

  test("hashState is stable across key insertion order", () => {
    const a: ProjectState = {
      scenes: { s1: "x", s2: "y" }, order: ["s1", "s2"], assets: {}, version: 0,
    };
    const b: ProjectState = {
      scenes: { s2: "y", s1: "x" }, order: ["s1", "s2"], assets: {}, version: 0,
    };
    expect(hashState(a)).toBe(hashState(b));
  });

  test("emptyState is a valid zero project", () => {
    const e = emptyState();
    expect(e.order).toEqual([]);
    expect(e.version).toBe(0);
  });
});
