// lab/fixtures/gen/test/prng.test.ts
import { describe, expect, test } from "bun:test";
import { makePrng } from "../src/prng";

describe("makePrng", () => {
  test("same seed yields identical sequence", () => {
    const a = makePrng("fixture-normal-v1");
    const b = makePrng("fixture-normal-v1");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  test("different seeds diverge", () => {
    const a = makePrng("seed-a");
    const b = makePrng("seed-b");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  test("next() in [0,1); int(n) in [0,n); pick returns member", () => {
    const p = makePrng("range");
    for (let i = 0; i < 1000; i++) {
      const v = p.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const n = p.int(7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
    const arr = ["x", "y", "z"];
    expect(arr).toContain(p.pick(arr));
  });
});
