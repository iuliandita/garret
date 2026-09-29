// lab/fault-rig/test/enospc.test.ts
import { describe, expect, test } from "bun:test";
import { makeByteBudget, EnospcError } from "../src/enospc";

describe("byte budget", () => {
  test("allows writes under budget, throws ENOSPC over it", () => {
    const budget = makeByteBudget(100);
    budget.charge(60);
    budget.charge(40);
    expect(() => budget.charge(1)).toThrow(EnospcError);
  });

  test("EnospcError carries code ENOSPC", () => {
    const budget = makeByteBudget(0);
    try {
      budget.charge(1);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as EnospcError).code).toBe("ENOSPC");
    }
  });
});
