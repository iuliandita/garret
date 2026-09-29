import { expect, test } from "bun:test";
import { visibleWindow } from "../src/virtualize";

// Ten scenes, 100px each: cumulative tops 0,100,...,900.
const heights = Array.from({ length: 10 }, () => 100);

test("mounts only scenes intersecting the viewport plus overscan", () => {
  // Viewport [250, 450): intersects scenes 2,3,4. Overscan 1 => 1..5.
  const w = visibleWindow(250, 200, heights, 1);
  expect(w.start).toBe(1);
  expect(w.end).toBe(5);
  expect(w.mounted).toEqual([1, 2, 3, 4, 5]);
});

test("clamps at the top with no negative indices", () => {
  const w = visibleWindow(0, 150, heights, 2);
  expect(w.start).toBe(0);
  expect(w.mounted[0]).toBe(0);
});

test("clamps at the bottom to the last scene", () => {
  const w = visibleWindow(10_000, 200, heights, 1);
  expect(w.end).toBe(9);
  expect(w.mounted[w.mounted.length - 1]).toBe(9);
});

test("empty heights yields an empty window", () => {
  const w = visibleWindow(0, 200, [], 1);
  expect(w.mounted).toEqual([]);
  expect(w.start).toBe(0);
  expect(w.end).toBe(-1);
});
