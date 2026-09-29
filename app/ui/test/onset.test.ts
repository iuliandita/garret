import { describe, expect, test } from "bun:test";
import { createOnsetTracker } from "../src/measure/onset";
import type { Sample } from "../src/measure/recorder";

const healthy: Sample = { dispatchMs: 2, frameMs: 33, stalled: false };
const slow: Sample = { dispatchMs: 3, frameMs: 1000, stalled: false };
const stalled: Sample = { dispatchMs: 3, frameMs: 5000, stalled: true };

describe("onset tracker", () => {
  test("a run with no slow sample has no onset", () => {
    const t = createOnsetTracker();
    t.record(healthy, { actionIndex: 0, kind: "type", charsTyped: 1, atMs: 30 });
    expect(t.first()).toBeNull();
    expect(t.slowCount()).toBe(0);
  });

  test("records the FIRST slow sample, not the last", () => {
    const t = createOnsetTracker();
    t.record(healthy, { actionIndex: 0, kind: "type", charsTyped: 1, atMs: 30 });
    t.record(slow, { actionIndex: 1, kind: "nav", charsTyped: 1, atMs: 1030 });
    t.record(slow, { actionIndex: 2, kind: "type", charsTyped: 2, atMs: 2030 });

    const first = t.first();
    expect(first?.actionIndex).toBe(1);
    expect(first?.kind).toBe("nav");
    expect(first?.atMs).toBe(1030);
    expect(first?.frameMs).toBe(1000);
    expect(t.slowCount()).toBe(2);
  });

  // A stalled sample is the same pathology reported through the timeout race
  // rather than a late frame; missing it would put onset at whatever sample
  // happened to come back slow-but-not-stalled afterwards.
  test("a stalled sample counts as onset even when its frameMs is below the threshold", () => {
    const t = createOnsetTracker(10_000);
    t.record(stalled, { actionIndex: 7, kind: "type", charsTyped: 8, atMs: 5030 });
    expect(t.first()?.actionIndex).toBe(7);
    expect(t.first()?.stalled).toBe(true);
  });

  // A 721 ms frame at action 1 (page warmup, measured) made first() report
  // onset at 0.7 s on a run that was healthy until 599 s. A single slow frame
  // is not the collapse; a streak of them is.
  test("a lone slow sample does not count as sustained onset", () => {
    const t = createOnsetTracker(100, 5);
    t.record(slow, { actionIndex: 1, kind: "type", charsTyped: 1, atMs: 700 });
    for (let i = 2; i < 100; i++) {
      t.record(healthy, { actionIndex: i, kind: "type", charsTyped: i, atMs: i * 33 });
    }
    expect(t.first()?.actionIndex).toBe(1);
    expect(t.sustained()).toBeNull();
  });

  test("sustained onset is the START of the streak, not the sample that completed it", () => {
    const t = createOnsetTracker(100, 3);
    t.record(healthy, { actionIndex: 1, kind: "type", charsTyped: 1, atMs: 33 });
    for (let i = 2; i <= 5; i++) {
      t.record(slow, { actionIndex: i, kind: "type", charsTyped: i, atMs: i * 1000 });
    }
    expect(t.sustained()?.actionIndex).toBe(2);
    expect(t.sustained()?.atMs).toBe(2000);
  });

  test("a healthy sample breaks the streak", () => {
    const t = createOnsetTracker(100, 3);
    t.record(slow, { actionIndex: 1, kind: "type", charsTyped: 1, atMs: 1000 });
    t.record(slow, { actionIndex: 2, kind: "type", charsTyped: 2, atMs: 2000 });
    t.record(healthy, { actionIndex: 3, kind: "type", charsTyped: 3, atMs: 2033 });
    t.record(slow, { actionIndex: 4, kind: "type", charsTyped: 4, atMs: 3000 });
    t.record(slow, { actionIndex: 5, kind: "type", charsTyped: 5, atMs: 4000 });
    expect(t.sustained()).toBeNull();

    t.record(slow, { actionIndex: 6, kind: "type", charsTyped: 6, atMs: 5000 });
    expect(t.sustained()?.actionIndex).toBe(4);
  });

  test("the threshold is honoured", () => {
    const t = createOnsetTracker(2000);
    t.record(slow, { actionIndex: 3, kind: "type", charsTyped: 4, atMs: 99 });
    expect(t.first()).toBeNull();
    expect(t.slowCount()).toBe(0);
  });
});
