import { describe, expect, test } from "bun:test";
import type { Sample } from "../src/measure/recorder";
import { SLOW_FRAME_MS, summarize } from "../src/measure/summary";

const sample = (dispatchMs: number, frameMs: number, stalled = false): Sample => ({
  dispatchMs,
  frameMs,
  stalled,
});

describe("summarize", () => {
  test("empty input is all zeros, not a throw", () => {
    const d = summarize([]);
    expect(d.count).toBe(0);
    expect(d.stalls).toBe(0);
    expect(d.slowFrames).toBe(0);
    expect(d.frame.p50).toBe(0);
    expect(Object.values(d.histogram).every((n) => n === 0)).toBe(true);
  });

  test("buckets frame times into the documented ranges", () => {
    const d = summarize([
      sample(1, 10),
      sample(1, 30),
      sample(1, 60),
      sample(1, 200),
      sample(1, 1000),
      sample(1, 3000),
    ]);
    expect(d.histogram["<20"]).toBe(1);
    expect(d.histogram["20-40"]).toBe(1);
    expect(d.histogram["40-100"]).toBe(1);
    expect(d.histogram["100-500"]).toBe(1);
    expect(d.histogram["500-2000"]).toBe(1);
    expect(d.histogram[">=2000"]).toBe(1);
  });

  test("counts slow frames strictly above the threshold", () => {
    const d = summarize([sample(1, SLOW_FRAME_MS), sample(1, SLOW_FRAME_MS + 1)]);
    expect(d.slowFrames).toBe(1);
  });

  test("a stalled sample counts as a stall, not also as a slow frame", () => {
    const d = summarize([sample(1, 5000, true)]);
    expect(d.stalls).toBe(1);
    expect(d.slowFrames).toBe(0);
  });

  test("dispatch and frame percentiles are computed independently", () => {
    const d = summarize([sample(1, 34), sample(2, 34), sample(3, 1000)]);
    expect(d.dispatch.p50).toBeLessThan(d.frame.p50);
  });
});
