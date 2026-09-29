// app/ui/test/editor-comments.test.ts
// The mapping rule against a REAL EditorView and a real transaction.
//
// `comments.test.ts` proves the rule against a fake mapping, which is what makes
// each case readable. This file proves the wiring: that `tr.mapping` is what
// reaches it, that a `setCommentAnchors` transaction is not an edit, and that
// the anchors the flush reads are the mapped ones. An EditorView DOES construct
// under happy-dom - the recorded finding, first used by editor-onchange.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, type DocInput, type Editor } from "../src/editor";
import { MAX_MAPPED_COMMENTS } from "../src/comments";

/** "alpha beta gamma" as one paragraph. Positions: the paragraph opens at 0, so
 *  its text runs 1..17 and "beta" is 7..11. */
const input: DocInput = {
  kind: "blocks",
  blocks: [{ type: "paragraph", text: "alpha beta gamma" }],
};

function editorWith(anchors: { id: number; from: number; to: number; resolved?: boolean }[]): {
  editor: Editor;
  changes: () => number;
} {
  const mount = document.createElement("div");
  let changes = 0;
  const editor = createEditor(mount, input, { onChange: () => changes++ });
  editor.setCommentAnchors(anchors.map((a) => ({ resolved: false, ...a })));
  return { editor, changes: () => changes };
}

describe("anchors through a real transaction", () => {
  test("the passage a note is on can be read back out of the document", () => {
    const { editor } = editorWith([{ id: 1, from: 7, to: 11 }]);

    expect(editor.textIn(7, 11)).toBe("beta");

    editor.destroy();
  });

  test("typing before the passage moves the note with it", () => {
    const { editor } = editorWith([{ id: 1, from: 7, to: 11 }]);

    // `typeChar` inserts at the selection's `from`, so this puts one character
    // at position 1 - above the anchor, which is the case under test.
    editor.selectRange(1, 6);
    editor.typeChar("Z");

    expect(editor.commentAnchors()[0]?.from).toBe(8);
    // And it is still on the same word, which is the claim the number stands
    // for: an assertion on the position alone would pass for an anchor that
    // moved to the wrong place by the right amount.
    expect(editor.textIn(8, 12)).toBe("beta");

    editor.destroy();
  });

  test("deleting the passage ORPHANS the note rather than moving it", () => {
    const { editor } = editorWith([{ id: 1, from: 7, to: 11 }]);

    // A real shipped deletion, through the operation a writer would use.
    expect(editor.replaceAll("beta", "").replaced).toBe(1);
    const anchor = editor.commentAnchors()[0];

    expect(anchor?.from).toBe(anchor?.to);
    // And the note is not sitting on "gamma" or on "alpha".
    expect(editor.textIn(anchor?.from ?? 0, anchor?.to ?? 0)).toBe("");

    editor.destroy();
  });

  test("setting anchors is NOT an edit", () => {
    // It carries transaction meta and changes no document, so `docChanged` is
    // false and nothing marks the scene dirty. A note is not prose.
    const { editor, changes } = editorWith([{ id: 1, from: 7, to: 11 }]);

    editor.setCommentAnchors([{ id: 2, from: 1, to: 6, resolved: false }]);

    expect(changes()).toBe(0);
    expect(editor.commentAnchors().map((a) => a.id)).toEqual([2]);

    editor.destroy();
  });

  test("a fresh list clears an earlier cap", () => {
    // Positions arriving from the store describe the document as it now is, so
    // there is nothing stale left to refuse.
    const many = Array.from({ length: MAX_MAPPED_COMMENTS + 1 }, (_, i) => ({
      id: i + 1,
      from: 1,
      to: 2,
    }));
    const { editor } = editorWith(many);
    editor.typeChar("x");
    expect(editor.commentsCapped()).toBe(true);

    editor.setCommentAnchors([{ id: 1, from: 7, to: 11, resolved: false }]);

    expect(editor.commentsCapped()).toBe(false);

    editor.destroy();
  });

  test("past the ceiling the positions stop moving and the editor says so", () => {
    const many = Array.from({ length: MAX_MAPPED_COMMENTS + 1 }, (_, i) => ({
      id: i + 1,
      from: 7,
      to: 11,
    }));
    const { editor } = editorWith(many);

    editor.selectRange(1, 6);
    editor.typeChar("Z");

    expect(editor.commentsCapped()).toBe(true);
    // UNCHANGED. The last positions written are the last ones known to be right.
    expect(editor.commentAnchors()[0]?.from).toBe(7);

    editor.destroy();
  });

  test("under the ceiling nothing is capped", () => {
    // The boundary from the passing side, so the comparison is tested and not
    // only the arithmetic.
    const many = Array.from({ length: MAX_MAPPED_COMMENTS }, (_, i) => ({
      id: i + 1,
      from: 7,
      to: 11,
    }));
    const { editor } = editorWith(many);

    editor.selectRange(1, 6);
    editor.typeChar("Z");

    expect(editor.commentsCapped()).toBe(false);
    expect(editor.commentAnchors()[0]?.from).toBe(8);

    editor.destroy();
  });

  test("replacing the document leaves no anchors behind", () => {
    // `replaceDoc` builds a fresh EditorState, so the plugin starts empty. If it
    // did not, the previous scene's notes would underline whatever prose happens
    // to sit at those positions in the new one.
    const { editor } = editorWith([{ id: 1, from: 7, to: 11 }]);

    editor.replaceDoc({ kind: "blocks", blocks: [{ type: "paragraph", text: "elsewhere" }] });

    expect(editor.commentAnchors()).toEqual([]);

    editor.destroy();
  });
});

describe("selecting a passage from the panel", () => {
  test("a live range is selected", () => {
    const { editor } = editorWith([]);

    expect(editor.selectRange(7, 11)).toBe(true);
    expect(editor.selection()).toEqual({ from: 7, to: 11 });

    editor.destroy();
  });

  test("a collapsed range is refused rather than dropping the caret somewhere", () => {
    const { editor } = editorWith([]);

    expect(editor.selectRange(7, 7)).toBe(false);

    editor.destroy();
  });

  test("a range past the end of the document is refused", () => {
    // A panel row can outlive the prose it points at, and an out-of-range
    // TextSelection.create throws - from inside a click handler.
    const { editor } = editorWith([]);

    expect(editor.selectRange(5, 9000)).toBe(false);
    expect(editor.textIn(5, 9000)).toBe("");

    editor.destroy();
  });
});
