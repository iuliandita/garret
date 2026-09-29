// app/ui/test/word-at.test.ts
import { describe, expect, test } from "bun:test";
import { isOneWord, wordAround } from "../src/word-at";

describe("wordAround", () => {
  test("the caret inside a word answers the whole word", () => {
    expect(wordAround("Say, Carahlo!", 7)).toEqual({ from: 5, to: 12, text: "Carahlo" });
  });

  test("the caret just after a word answers it, which is where typing leaves the caret", () => {
    expect(wordAround("Say, Carahlo!", 12)?.text).toBe("Carahlo");
    expect(wordAround("Carahlo", 7)?.text).toBe("Carahlo");
  });

  test("the caret between two separators answers nothing", () => {
    expect(wordAround("one  two", 4)).toBeNull();
    expect(wordAround("", 0)).toBeNull();
  });

  test("an apostrophe inside a name stays in the word and a trailing quote does not", () => {
    expect(wordAround("O'Neil's", 3)?.text).toBe("O'Neil's");
    expect(wordAround("d\u2019Artagnan", 4)?.text).toBe("d\u2019Artagnan");
    expect(wordAround("'quoted'", 2)?.text).toBe("quoted");
  });

  test("a hyphen and a digit end a word, letters with marks do not", () => {
    expect(wordAround("half-remembered", 2)?.text).toBe("half");
    expect(wordAround("half-remembered", 9)?.text).toBe("remembered");
    expect(wordAround("Ma\u0308dchen", 3)?.text).toBe("Ma\u0308dchen");
    expect(wordAround("abc123", 1)?.text).toBe("abc");
  });
});

describe("isOneWord", () => {
  test("one word, with the trailing space a double-click brings, is one word", () => {
    expect(isOneWord("Carahlo")).toBe(true);
    expect(isOneWord("Carahlo ")).toBe(true);
  });

  test("two words, a word with punctuation, or nothing is not", () => {
    expect(isOneWord("two words")).toBe(false);
    expect(isOneWord("Carahlo!")).toBe(false);
    expect(isOneWord("  ")).toBe(false);
  });
});
