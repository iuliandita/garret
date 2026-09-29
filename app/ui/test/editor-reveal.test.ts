// revealMatch against a REAL EditorView. The locating rule is tested purely in
// find-locate.test.ts; what is tested here is the part that needs a view: that
// the selection actually moves, and that moving it does not mark the document
// dirty.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, type DocInput } from "../src/editor";

const input: DocInput = {
  kind: "blocks",
  blocks: [
    { type: "paragraph", text: "The archivist numbered every crate." },
    { type: "paragraph", text: "The harbourmaster kept two sets of books." },
  ],
};

function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  let changes = 0;
  const editor = createEditor(el, input, { onChange: () => changes++ });
  return { el, editor, changes: () => changes };
}

describe("editor.revealMatch", () => {
  test("selects the found word and reports that it landed", () => {
    // Through editor.selection(), NOT document.getSelection(): happy-dom does
    // no layout, so the browser selection is empty whatever ProseMirror did and
    // an assertion on it would pass with revealMatch's dispatch deleted. The
    // "a writer sees it selected" claim is the graded find run's, off AT-SPI.
    const { editor } = mount();

    expect(editor.revealMatch("harbourmaster")).toBe(true);

    const { from, to } = editor.selection();
    // "The archivist numbered every crate." is 35 characters in a paragraph
    // opening at 0, so the second paragraph's text starts at 38.
    expect(to - from).toBe("harbourmaster".length);
    expect(from).toBe(42);
    editor.destroy();
  });

  test("does NOT mark the document dirty", () => {
    // A selection-only transaction has tr.docChanged === false, so onChange
    // cannot fire. That is the standing rule "a caret jump must never mark the
    // document dirty" - a flush armed by a search would write a store record
    // with no edit behind it, and flush_count is a graded number.
    const { editor, changes } = mount();

    editor.revealMatch("crate");

    expect(changes()).toBe(0);
    editor.destroy();
  });

  test("leaves the document byte-identical", () => {
    const { editor } = mount();
    const before = editor.serialize();

    editor.revealMatch("crate");

    expect(editor.serialize()).toBe(before);
    editor.destroy();
  });

  test("reports false and moves nothing when the word is absent", () => {
    const { editor } = mount();
    editor.revealMatch("crate");
    const landed = editor.selection();

    expect(editor.revealMatch("lighthouse")).toBe(false);

    // The caret is where the previous reveal left it, not reset to the top.
    expect(editor.selection()).toEqual(landed);
    // ...and it is not the top, or the assertion above would hold for a
    // revealMatch that never moves anything.
    expect(landed.from).toBeGreaterThan(1);
    editor.destroy();
  });

  test("reports false for an empty query", () => {
    const { editor } = mount();

    expect(editor.revealMatch("")).toBe(false);
    editor.destroy();
  });

  test("searches the document the editor CURRENTLY holds", () => {
    // The reveal is fired after an open resolves, so it must read the swapped-in
    // document and not a snapshot taken when the editor was built. A version
    // that closed over the boot document would keep finding words in the scene
    // the writer just left.
    const { editor } = mount();

    editor.replaceDoc({
      kind: "blocks",
      blocks: [{ type: "paragraph", text: "A lighthouse and nothing else." }],
    });

    expect(editor.revealMatch("crate")).toBe(false);
    expect(editor.revealMatch("lighthouse")).toBe(true);
    editor.destroy();
  });
});
