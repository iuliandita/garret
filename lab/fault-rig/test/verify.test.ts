// lab/fault-rig/test/verify.test.ts
import { describe, expect, test } from "bun:test";
import { classify } from "../src/verify";
import { refStates, emptyState } from "../src/refmodel";
import { buildWorkload } from "../src/workload";

const scenes = ["s1", "s2", "s3"];
const ops = buildWorkload("v", scenes, 20);
const states = refStates(emptyState(), ops); // states[0..20]
const okChk = { ok: true, detail: "ok" };

describe("classify", () => {
  test("CORRUPT when integrity fails", () => {
    const v = classify(states[5]!, { ok: false, detail: "boom" }, states, 4);
    expect(v).toBe("CORRUPT");
  });

  test("CORRUPT when state matches no known ref-state", () => {
    const alien = { ...states[3]!, version: 999 };
    expect(classify(alien, okChk, states, 3)).toBe("CORRUPT");
  });

  test("OLD_INTACT when nothing acked and state is the start", () => {
    expect(classify(states[0]!, okChk, states, -1)).toBe("OLD_INTACT");
  });

  test("NEW_COMPLETE when recovered includes all acked ops", () => {
    // acked through op index 6 => ref-state states[7]
    expect(classify(states[7]!, okChk, states, 6)).toBe("NEW_COMPLETE");
  });

  test("NEW_COMPLETE when one extra commit landed past the last read ack", () => {
    expect(classify(states[8]!, okChk, states, 6)).toBe("NEW_COMPLETE");
  });

  test("REGRESSION when recovered is older than the highest ack", () => {
    // acked through op 6 (states[7]) but recovered only states[5]
    expect(classify(states[5]!, okChk, states, 6)).toBe("REGRESSION");
  });
});
