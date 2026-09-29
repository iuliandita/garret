import { describe, expect, test } from "bun:test";
import { degradationStep } from "../src/step";
import type { Cycle } from "../src/gates";

const cycle = (n: number, p95: number, partial = false): Cycle => ({
  cycle: n,
  atMs: n * 15_000,
  typingP95Ms: p95,
  charsTyped: 400 * n,
  partial,
});

describe("degradationStep", () => {
  test("a flat run has no step", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => cycle(i + 1, 34));
    expect(degradationStep(cycles)).toBeNull();
  });

  // The case the 100 ms onset rule missed: 34 -> 50 ms is a permanent 1.5x
  // step that never trips a slow-frame threshold, and the CLI reported the run
  // as healthy while its cycle table showed the plateau plainly.
  test("finds a 34 -> 50 ms step that no slow-frame threshold would catch", () => {
    const cycles = [
      ...Array.from({ length: 39 }, (_, i) => cycle(i + 1, 34)),
      ...Array.from({ length: 13 }, (_, i) => cycle(i + 40, 50)),
    ];
    const step = degradationStep(cycles);
    expect(step?.cycle).toBe(40);
    expect(step?.p95Ms).toBe(50);
    expect(step?.baselineP95Ms).toBe(34);
  });

  test("ignores a single spike that recovers", () => {
    const cycles = [
      ...Array.from({ length: 20 }, (_, i) => cycle(i + 1, 34)),
      cycle(21, 900),
      ...Array.from({ length: 20 }, (_, i) => cycle(i + 22, 34)),
    ];
    expect(degradationStep(cycles)).toBeNull();
  });

  test("excludes partial cycles, which are the slowest of a few samples", () => {
    const cycles = [
      ...Array.from({ length: 39 }, (_, i) => cycle(i + 1, 34)),
      cycle(40, 1001, true),
    ];
    expect(degradationStep(cycles)).toBeNull();
  });

  test("too few cycles to establish a baseline is null, not a fabricated step", () => {
    expect(degradationStep([cycle(1, 34), cycle(2, 900)])).toBeNull();
  });
});
