import { describe, expect, test } from "bun:test";
import { diffWords, summarize, MAX_LCS_CELLS, type DiffPiece } from "../src/diff";

/** The `before` side, reassembled from the diff: everything the diff did not
 *  call an addition. */
function rebuiltBefore(pieces: readonly DiffPiece[]): string {
  return pieces.filter((p) => p.op !== "added").map((p) => p.text).join("");
}

/** The `after` side, reassembled: everything the diff did not call a removal. */
function rebuiltAfter(pieces: readonly DiffPiece[]): string {
  return pieces.filter((p) => p.op !== "removed").map((p) => p.text).join("");
}

/** Both halves of the round trip, asserted separately - a diff can lose one
 *  side and keep the other, and which one it lost is the useful half of the
 *  failure. */
function expectRoundTrip(before: string, after: string): DiffPiece[] {
  const pieces = diffWords(before, after);
  expect(rebuiltBefore(pieces)).toBe(before);
  expect(rebuiltAfter(pieces)).toBe(after);
  return pieces;
}

function textOf(pieces: readonly DiffPiece[], op: DiffPiece["op"]): string[] {
  return pieces.filter((p) => p.op === op).map((p) => p.text);
}

describe("diffing two versions of a scene", () => {
  test("identical texts are all same, and the round trip holds", () => {
    const text = "The lamp went out before anyone had spoken.";
    const pieces = expectRoundTrip(text, text);
    expect(pieces.map((p) => p.op)).toEqual(["same"]);
    expect(pieces[0]?.text).toBe(text);
  });

  test("a word replaced in the middle leaves its neighbours alone", () => {
    const pieces = expectRoundTrip("the cat sat on the mat", "the cat lay on the mat");
    expect(textOf(pieces, "removed")).toEqual(["sat "]);
    expect(textOf(pieces, "added")).toEqual(["lay "]);
    expect(textOf(pieces, "same")).toEqual(["the cat ", "on the mat"]);
  });

  test("a paragraph inserted in the middle does not mark the tail as changed", () => {
    // The test a naive positional or line-by-line comparison fails: everything
    // after the insertion has moved, and every word of it is unchanged.
    const before = "Alpha beta\n\nGamma delta\n\nEpsilon zeta";
    const after = "Alpha beta\n\nInserted sentence here.\n\nGamma delta\n\nEpsilon zeta";
    const pieces = expectRoundTrip(before, after);
    expect(textOf(pieces, "removed")).toEqual([]);
    expect(textOf(pieces, "added")).toEqual(["Inserted sentence here.\n\n"]);
    // The tail survives as ONE unchanged run, which is the claim: no part of it
    // was attributed to either side.
    expect(pieces[pieces.length - 1]).toEqual({
      op: "same",
      text: "Gamma delta\n\nEpsilon zeta",
    });
  });

  test("a run of words removed from the middle is one removed piece", () => {
    const pieces = expectRoundTrip("one two three four five", "one four five");
    expect(textOf(pieces, "removed")).toEqual(["two three "]);
    expect(textOf(pieces, "added")).toEqual([]);
  });

  test("an empty before is entirely an addition", () => {
    const pieces = expectRoundTrip("", "a whole new scene");
    expect(pieces).toEqual([{ op: "added", text: "a whole new scene" }]);
  });

  test("an empty after is entirely a removal", () => {
    const pieces = expectRoundTrip("a scene the writer cut", "");
    expect(pieces).toEqual([{ op: "removed", text: "a scene the writer cut" }]);
  });

  test("two empty texts produce no pieces at all", () => {
    expect(expectRoundTrip("", "")).toEqual([]);
  });

  test("the round trip holds over mixed scripts and leading whitespace", () => {
    // The fixtures this application is measured against are Hebrew and Arabic,
    // so RTL prose is the ordinary case here rather than an edge one. The
    // leading newline is deliberate: it is a whitespace-only token, and a
    // tokenizer that dropped it would reproduce neither side.
    const before = "\n  שלום עולם كتاب جديد end";
    const after = "\n  שלום יקר עולם كتاب end";
    const pieces = expectRoundTrip(before, after);
    expect(pieces.length).toBeGreaterThan(1);
  });

  test("the round trip holds when only the whitespace between two words changed", () => {
    // Tokens carry their trailing whitespace and are compared whole, so this is
    // reported as a removal and an addition rather than as unchanged. Recorded
    // as a test because it is the stated cost of an exact round trip.
    const pieces = expectRoundTrip("first second", "first\n\nsecond");
    expect(textOf(pieces, "same")).toEqual(["second"]);
  });
});

describe("the size budget", () => {
  /** A pair whose two sides agree on every other word, so a real LCS has plenty
   *  to find and reports many pieces. The first and last words differ on both
   *  sides, so the common prefix and suffix take nothing off and the whole
   *  length reaches the table. */
  function interleavedPair(words: number): [string, string] {
    const side = (unique: string) =>
      Array.from({ length: words }, (_, i) =>
        i % 2 === 0 ? `${unique}${i}` : `shared${i}`,
      ).join(" ");
    return [side("alpha"), side("beta")];
  }

  test("a middle over the budget falls back to one removal and one addition", () => {
    const words = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 1;
    expect(words * words).toBeGreaterThan(MAX_LCS_CELLS);
    const [before, after] = interleavedPair(words);
    const pieces = expectRoundTrip(before, after);
    expect(pieces.map((p) => p.op)).toEqual(["removed", "added"]);
  });

  test("the same pair just under the budget is diffed properly", () => {
    // The control: without it the test above would pass against an
    // implementation that always fell back, which is a diff that never diffs.
    // The only difference between the two is which side of the budget the
    // middle lands on.
    const words = Math.floor(Math.sqrt(MAX_LCS_CELLS)) - 1;
    expect(words * words).toBeLessThan(MAX_LCS_CELLS);
    const [before, after] = interleavedPair(words);
    const pieces = expectRoundTrip(before, after);
    expect(pieces.length).toBeGreaterThan(words);
  });

  test("the common ends come off before the budget is consulted", () => {
    // A long scene with a one-word edit must never reach the fallback, however
    // many words it holds - which is what makes the budget affordable.
    const body = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
    const pieces = expectRoundTrip(`${body} tail`, `${body} coda`);
    expect(textOf(pieces, "removed")).toEqual(["tail"]);
    expect(textOf(pieces, "added")).toEqual(["coda"]);
  });
});

describe("summarizing a diff", () => {
  test("it counts words, not pieces", () => {
    const pieces = diffWords("one two three four", "one two five six three four");
    expect(summarize(pieces)).toEqual({ added: 2, removed: 0, unchanged: 4 });
  });

  test("whitespace-only pieces count as nothing", () => {
    const summary = summarize([
      { op: "same", text: "\n  " },
      { op: "added", text: "   " },
      { op: "removed", text: "\t\n" },
      { op: "added", text: "two words " },
    ]);
    expect(summary).toEqual({ added: 2, removed: 0, unchanged: 0 });
  });

  test("an empty diff summarizes to zeros", () => {
    expect(summarize([])).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });

  test("a replacement is counted on both sides", () => {
    expect(summarize(diffWords("the cat sat", "the dog sat"))).toEqual({
      added: 1,
      removed: 1,
      unchanged: 2,
    });
  });
});
