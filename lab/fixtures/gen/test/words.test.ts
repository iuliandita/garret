// lab/fixtures/gen/test/words.test.ts
import { describe, expect, test } from "bun:test";
import { makePrng } from "../src/prng";
import { paragraph, countWords } from "../src/words";

describe("paragraph", () => {
  test("deterministic for same seed", () => {
    const a = paragraph(makePrng("p1"), "latin", 50);
    const b = paragraph(makePrng("p1"), "latin", 50);
    expect(a).toBe(b);
  });

  test("hits requested word count", () => {
    const p = paragraph(makePrng("wc"), "latin", 120);
    expect(countWords(p, "latin")).toBe(120);
  });

  test("cjk paragraph contains CJK codepoints", () => {
    const p = paragraph(makePrng("c"), "cjk", 40);
    expect(/[一-鿿]/.test(p)).toBe(true);
  });

  test("rtl paragraph contains Hebrew or Arabic codepoints", () => {
    const p = paragraph(makePrng("r"), "rtl", 40);
    expect(/[֐-ۿ]/.test(p)).toBe(true);
  });

  test("countWords counts cjk chars as words", () => {
    expect(countWords("春は曙", "cjk")).toBe(3);
  });
});
