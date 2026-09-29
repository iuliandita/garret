import { describe, expect, test } from "bun:test";
import { countWords } from "../src/words";

// The shared case table. Its twin lives
// in `app/shell-tauri/src-tauri/src/words.rs`; a case added here MUST be added
// there. The table is the contract between the two implementations -- it is
// the only thing that fails when they drift.
//
// Whitespace separators are written as escapes, not as literal characters, so
// a reader can see which codepoint a case is actually about and an editor
// cannot silently normalise one into a plain space.
const CASES: ReadonlyArray<readonly [label: string, input: string, expected: number]> = [
  ["empty", "", 0],
  ["whitespace only", "   ", 0],
  ["one word", "word", 1],
  ["two words", "two words", 2],
  ["no empty runs at the ends", "  leading and trailing  ", 3],
  ["newline is whitespace", "line\nbreak", 2],
  ["tab is whitespace", "tab\tsep", 2],
  ["NBSP is Unicode whitespace", "non\u00A0breaking", 2],
  ["apostrophe does not split", "don't", 1],
  ["hyphen does not split", "mother-in-law", 1],
  ["em-dash is the deliberate undercount", "em\u2014dash", 1],
  ["numerals count", "3.14", 1],
  ["punctuation alone still counts", "*", 1],
  ["runs collapse", "a  b", 2],
  ["line separator is whitespace", "line\u2028sep", 2],
  ["thin space is whitespace", "thin\u2009space", 2],
  [
    "a realistic sentence",
    "She set the lamp down, said nothing for a moment, and then asked him to leave.",
    16,
  ],
];

describe("countWords", () => {
  for (const [label, input, expected] of CASES) {
    test(`${label}: ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(countWords(input)).toBe(expected);
    });
  }

  // Not a table case, but the property the table is sampling: NBSP is the most
  // likely place for the two runtimes to disagree about what "whitespace"
  // means, so assert the separator alone rather than only a string using it.
  test("NBSP alone is not a word", () => {
    expect(countWords("\u00A0")).toBe(0);
  });
});
