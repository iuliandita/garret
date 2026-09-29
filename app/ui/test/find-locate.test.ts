// The rule this module restates lives in store/mod.rs::append_node, and the
// folding it has to agree with lives in find.rs::fold. Both are stated again
// here in prose so a reader can check the code against the sentence rather than
// against the other language.
import { describe, expect, test } from "bun:test";
import { schema } from "../src/editor";
import { foldForFind, locateFirstMatch } from "../src/find-locate";
import type { Node as PmNode } from "prosemirror-model";

/** A document of paragraphs, the shape the store actually holds. */
function doc(...paragraphs: string[][]): PmNode {
  return schema.nodeFromJSON({
    type: "doc",
    content: paragraphs.map((runs) => ({
      type: "paragraph",
      content: runs
        .filter((t) => t.length > 0)
        .map((text) => ({ type: "text", text })),
    })),
  });
}

/** What the editor would show as selected. */
function selected(node: PmNode, at: { from: number; to: number } | null): string | null {
  return at === null ? null : node.textBetween(at.from, at.to);
}

describe("foldForFind", () => {
  test("lowercases", () => {
    expect(foldForFind("Harbour")).toBe("harbour");
  });

  test("folds a word-final capital sigma to the MEDIAL form", () => {
    // The one that matters, and the reason this is not `text.toLowerCase()`.
    // String.prototype.toLowerCase implements Unicode SpecialCasing, so it
    // applies the Final_Sigma condition and yields the final form for a
    // word-final sigma. The host folds with Rust's char::to_lowercase, which is
    // context-free and always yields the medial form.
    //
    // Fold the whole string here and a Greek word matches in the results panel
    // and then cannot be located in the document at all.
    expect("ΟΔΟΣ".toLowerCase()).toBe("οδος"); // what the trap looks like
    expect(foldForFind("ΟΔΟΣ")).toBe("οδοσ"); // what the host will have folded
  });

  test("keeps a surrogate pair whole", () => {
    // [...text] iterates code points. Iterating UTF-16 units instead folds each
    // half of an astral character separately, and a lone surrogate has no case
    // mapping - so the fold silently does nothing.
    //
    // DESERET CAPITAL LETTER LONG I, which actually HAS a lowercase, is what
    // makes this falsifiable: a mathematical bold capital A has no case mapping
    // either way, so the per-unit version passes on it.
    expect(foldForFind("\u{10400}")).toBe("\u{10428}");
  });

  test("is idempotent on text that is already folded", () => {
    expect(foldForFind(foldForFind("Harbour"))).toBe(foldForFind("Harbour"));
  });
});

describe("locateFirstMatch", () => {
  test("finds a word and reports the range that covers exactly it", () => {
    const d = doc(["The harbourmaster kept two sets of books."]);

    expect(selected(d, locateFirstMatch(d, "harbourmaster"))).toBe("harbourmaster");
  });

  test("matches regardless of case, on either side", () => {
    const d = doc(["The Harbourmaster kept books."]);

    expect(selected(d, locateFirstMatch(d, "HARBOURMASTER"))).toBe("Harbourmaster");
  });

  test("finds the FIRST occurrence, not any occurrence", () => {
    const d = doc(["crate one", "crate two"]);
    const at = locateFirstMatch(d, "crate");

    // Position 1 is inside the first paragraph, whose node opens at 0.
    expect(at).toEqual({ from: 1, to: 6 });
  });

  test("finds a word split across marks", () => {
    // Italicising mid-word splits one text node into three. A per-text-node
    // search would miss this and the writer would be dropped at the top of the
    // scene with no idea why - the same splitting that made the word count
    // count "bewitched" as two words until it was fixed.
    //
    // The mark is what forces the split: ProseMirror MERGES adjacent text nodes
    // carrying identical marks, so two bare runs would be one node and this
    // test would assert nothing. Checked - `childCount` is 2 here and 1
    // without the mark.
    const d = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "be" },
            { type: "text", text: "witched", marks: [{ type: "em" }] },
          ],
        },
      ],
    });
    expect(d.child(0).childCount).toBe(2);

    expect(selected(d, locateFirstMatch(d, "bewitched"))).toBe("bewitched");
  });

  test("finds a word in a later paragraph", () => {
    const d = doc(["first"], ["second"], ["the crate"]);

    expect(selected(d, locateFirstMatch(d, "crate"))).toBe("crate");
  });

  test("separates paragraphs by ONE space, matching the host's projection", () => {
    // store::append_node: a text node contributes its text; any other node
    // contributes one space before its content, unless nothing has been emitted
    // yet. So "one" and "two" in adjacent paragraphs read as "one two" - and a
    // module that concatenated them would report a match for "onetwo" that the
    // host never found.
    const d = doc(["one"], ["two"]);

    expect(locateFirstMatch(d, "onetwo")).toBeNull();
    expect(locateFirstMatch(d, "one two")).not.toBeNull();
  });

  test("emits NO separator before the first block", () => {
    // The host's rule is `if !out.is_empty()`. A page that always emitted the
    // separator would carry a leading space the host's projection does not,
    // which is a drift from the rule even where it happens to be harmless.
    const d = doc(["one"]);

    expect(locateFirstMatch(d, " one")).toBeNull();
    expect(locateFirstMatch(d, "one")).not.toBeNull();
  });

  test("a match beginning at a paragraph boundary starts at a real character", () => {
    // The separator is synthetic: it is not in the document and holds no
    // position. Both of its bounds are where the block's content starts, so the
    // selection begins at the first character a caret can actually sit before.
    const d = doc(["one"], ["two"]);
    const at = locateFirstMatch(d, " two");

    expect(at).not.toBeNull();
    expect(selected(d, at)).toBe("two");
  });

  test("returns null for a word that is not there", () => {
    const d = doc(["The harbourmaster kept books."]);

    expect(locateFirstMatch(d, "lighthouse")).toBeNull();
  });

  test("returns null for an empty query rather than matching at position 0", () => {
    // indexOf("") is 0, so without the guard every activation would select an
    // empty range at the top of the document - which reads as "it jumped
    // somewhere" and is worse than not jumping.
    const d = doc(["anything"]);

    expect(locateFirstMatch(d, "")).toBeNull();
  });

  test("locates a match after a fold that CHANGES LENGTH", () => {
    // Capital dotted I folds to two code units, so every folded index after it
    // is one ahead of the document position it came from.
    const d = doc(["aİb crate"]);

    expect(selected(d, locateFirstMatch(d, "crate"))).toBe("crate");
  });

  test("ends a match whose OWN folding changes length at the right character", () => {
    // The case above only exercises the start. Here the length change is inside
    // the match: "aİb" is 3 characters and folds to 4 code units, so an
    // implementation that derived the end by adding the query's folded length
    // to the start would select one character too many - and, on a word at the
    // end of a paragraph, would run past the paragraph and throw.
    const d = doc(["aİbc"]);

    expect(selected(d, locateFirstMatch(d, "aİb"))).toBe("aİb");
  });

  test("locates a match that FOLLOWS an astral character", () => {
    // A surrogate pair is two UTF-16 units and one code point. Stepping the
    // document position by code points instead of units puts everything after
    // it one position early.
    const d = doc(["\u{1D400} crate"]);

    expect(selected(d, locateFirstMatch(d, "crate"))).toBe("crate");
  });

  test("an empty document is null, not a throw", () => {
    const d = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] });

    expect(locateFirstMatch(d, "anything")).toBeNull();
  });
});
