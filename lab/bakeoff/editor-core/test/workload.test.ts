import { expect, test } from "bun:test";
import { buildWorkload } from "../src/workload";
import type { SceneRef } from "../src/model";

const refs: SceneRef[] = Array.from({ length: 50 }, (_, i) => ({
  id: `it-${String(i).padStart(6, "0")}`,
  title: `Scene ${i}`,
  order: i,
  parentId: null,
}));

const opts = { typingChars: 30, navJumps: 10, viewSwitches: 5 };

test("action count equals the sum of requested action counts", () => {
  const script = buildWorkload("seed-a", refs, opts);
  expect(script.length).toBe(45);
});

test("same seed produces an identical script", () => {
  const a = buildWorkload("seed-a", refs, opts);
  const b = buildWorkload("seed-a", refs, opts);
  expect(b).toEqual(a);
});

test("different seed diverges", () => {
  const a = buildWorkload("seed-a", refs, opts);
  const c = buildWorkload("seed-b", refs, opts);
  expect(c).not.toEqual(a);
});

test("seq is strictly increasing and kinds are valid", () => {
  const script = buildWorkload("seed-a", refs, opts);
  for (let i = 0; i < script.length; i++) {
    expect(script[i]!.seq).toBe(i);
    expect(["type", "quick-open", "view-switch"]).toContain(script[i]!.kind);
  }
  const jumps = script.filter((a) => a.kind === "quick-open");
  for (const j of jumps) expect(refs.some((r) => r.id === j.targetId)).toBe(true);
});

test("type actions carry a single character", () => {
  const script = buildWorkload("seed-a", refs, opts);
  for (const a of script.filter((x) => x.kind === "type")) {
    expect(typeof a.char).toBe("string");
    expect(a.char!.length).toBe(1);
  }
});
