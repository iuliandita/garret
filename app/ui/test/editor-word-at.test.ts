// app/ui/test/editor-word-at.test.ts
// `wordAtCaret` through a real ProseMirror view: the selection when it is
// one word, the word around a collapsed caret, nothing for a span of words.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, type DocInput } from "../src/editor";

/** "alpha beta gamma": the paragraph opens at 0, "beta" is 7..11. */
const input: DocInput = {
  kind: "blocks",
  blocks: [{ type: "paragraph", text: "alpha beta gamma" }],
};

function editor() {
  const mount = document.createElement("div");
  return createEditor(mount, input, { onChange: () => undefined });
}

describe("wordAtCaret", () => {
  test("a one-word selection answers that word", () => {
    const e = editor();
    expect(e.selectRange(7, 11)).toBe(true);
    expect(e.wordAtCaret()).toEqual({ from: 7, to: 11, text: "beta" });
    e.destroy();
  });

  test("a selection over two words answers nothing", () => {
    const e = editor();
    expect(e.selectRange(1, 11)).toBe(true);
    expect(e.wordAtCaret()).toBeNull();
    e.destroy();
  });

  test("a collapsed caret answers the word it touches, read off the textblock", () => {
    const e = editor();
    // caretToParagraph puts a collapsed caret at the paragraph's END, after
    // "gamma" -- the position typing leaves a caret in; typeChar inserts
    // there and the caret follows, so it then sits after "gammaQ".
    e.caretToParagraph(0);
    expect(e.selection().from).toBe(e.selection().to);
    expect(e.wordAtCaret()).toEqual({ from: 12, to: 17, text: "gamma" });
    e.typeChar("Q");
    expect(e.wordAtCaret()?.text).toBe("gammaQ");
    e.destroy();
  });
});

describe("redrawSpelling", () => {
  test("it changes no document and leaves no decoration behind", () => {
    const e = editor();
    let changes = 0;
    const mount = document.createElement("div");
    const watched = createEditor(mount, input, { onChange: () => changes++ });
    watched.redrawSpelling(7, 11);
    expect(changes).toBe(0);
    expect(mount.querySelector(".spell-redraw")).toBeNull();
    expect(watched.textIn(7, 11)).toBe("beta");
    watched.destroy();
    e.destroy();
  });
});
