import { describe, expect, test } from "bun:test";
import { coverTint } from "../src/library";

describe("coverTint", () => {
  test("is stable and pinned for two known paths", () => {
    // FNV-1a, 32-bit, over UTF-16 code units. Pinned against the function's
    // own output rather than a hand-computed hash: what this guards against
    // is the function changing under a later edit, not a specific formula.
    expect(coverTint("/library/the-harbour.db")).toBe(6);
    expect(coverTint("/library/ada-vane.db")).toBe(2);
  });

  test("always answers in 1..6", () => {
    for (const path of ["", "a", "book.db", "/very/long/path/to/a/book/file/name.db"]) {
      const tint = coverTint(path);
      expect(tint).toBeGreaterThanOrEqual(1);
      expect(tint).toBeLessThanOrEqual(6);
    }
  });

  test("the same path always picks the same tint", () => {
    const path = "/library/repeatable.db";
    expect(coverTint(path)).toBe(coverTint(path));
  });

  test("different paths spread across more than one tint", () => {
    // A vacuity guard: a mutant that always returns 1 would pass every test
    // above.
    const tints = new Set(Array.from({ length: 6 }, (_, i) => coverTint(`book${i + 1}.db`)));
    expect(tints.size).toBeGreaterThan(1);
  });
});
