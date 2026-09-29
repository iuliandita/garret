import { expect, test } from "bun:test";
import { percentiles, frameDelta } from "../src/stats";

test("nearest-rank percentiles on 1..100", () => {
  const s = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
  expect(s.count).toBe(100);
  expect(s.p50).toBe(50);
  expect(s.p95).toBe(95);
  expect(s.p99).toBe(99);
  expect(s.max).toBe(100);
});

test("single sample reports that value for every percentile", () => {
  const s = percentiles([42]);
  expect(s.p50).toBe(42);
  expect(s.p95).toBe(42);
  expect(s.p99).toBe(42);
});

test("empty sample reports zeros and count 0", () => {
  const s = percentiles([]);
  expect(s.count).toBe(0);
  expect(s.p95).toBe(0);
});

test("frameDelta is frame time minus key time, clamped at zero", () => {
  expect(frameDelta(100, 116.7)).toBeCloseTo(16.7, 5);
  expect(frameDelta(200, 200)).toBe(0);
  expect(frameDelta(200, 199)).toBe(0);
});
