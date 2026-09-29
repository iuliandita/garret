import { describe, expect, test } from "bun:test";
import { assertOutlineViewShown, outlineRows } from "../src/outline-shot-check";

describe("outline screenshot postcondition", () => {
  test("accepts only the requested visible view", () => {
    expect(() => assertOutlineViewShown({ view: true, headings: ["Table"] }, "table", "Table")).not.toThrow();
    expect(() => assertOutlineViewShown({ view: true, headings: ["Cards"] }, "cards", "Cards")).not.toThrow();
    expect(() => assertOutlineViewShown({ view: true, headings: ["Read through"] }, "reading", "Read through")).not.toThrow();
    expect(() => assertOutlineViewShown({ view: true, headings: ["Cards"] }, "table", "Table")).toThrow(/expected visible heading "Table"/);
  });

  test("refuses the regular editor instead of writing a mislabeled screenshot", () => {
    expect(() => assertOutlineViewShown({ view: false, headings: [] }, "table", "Table")).toThrow(/no outline view/);
    expect(() => assertOutlineViewShown({ view: true }, "table", "Table")).toThrow(/invalid accessibility probe result/);
  });

  test("--outline-act takes row geometry only from a probe that has enough of it", () => {
    const row = { row: [0, 10, 800, 40], first: [0, 10, 200, 40], move: [700, 16, 60, 30] };
    expect(outlineRows({ view: true, headings: [], rows: [row, row] }, 2)).toHaveLength(2);
    expect(() => outlineRows({ view: true, headings: [], rows: [row] }, 2)).toThrow(/needs 2 table rows/);
    expect(() => outlineRows({ view: true, headings: [], rows: [{ ...row, move: [1, 2] }, row] }, 2)).toThrow(/found 1/);
    expect(() => outlineRows({ view: true, headings: [] }, 1)).toThrow(/found 0/);
  });
});
