// app/ui/test/editor-focus.test.ts
// selectionRect() and the onFocus/onBlur hooks the bubble toolbar reads.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, unionSelectionRect, type Editor, type EditorOptions } from "../src/editor";

/** Mounts under a real `#editor` pane, attached to the document: the bubble's
 *  focus test needs to dispatch a DOM event at the view's own element, and
 *  selectionRect's null-under-happy-dom case is only real when the view is
 *  actually in the tree rather than a detached div. */
function mountEditor(text: string, opts: EditorOptions = {}): Editor {
  document.body.replaceChildren();
  const pane = document.createElement("div");
  pane.id = "editor";
  const mount = document.createElement("div");
  pane.appendChild(mount);
  document.body.appendChild(pane);
  return createEditor(mount, { kind: "blocks", blocks: [{ type: "paragraph", text }] }, opts);
}

test("selectionRect is null for a collapsed selection and under happy-dom", () => {
  const editor = mountEditor("one two three");
  expect(editor.selectionRect()).toBeNull();
  editor.selectRange(1, 4);
  // happy-dom lays nothing out: coordsAtPos throws, and the method answers
  // null rather than throwing, which is what the bubble relies on.
  expect(editor.selectionRect()).toBeNull();
  editor.destroy();
});

test("onFocus and onBlur fire from the view's own element, with the event", () => {
  const events: string[] = [];
  const editor = mountEditor("one", {
    onFocus: () => events.push("focus"),
    onBlur: (event) => events.push(`blur:${event.relatedTarget === null ? "null" : "el"}`),
  });
  const dom = document.querySelector("#editor .ProseMirror") as HTMLElement;
  dom.dispatchEvent(new FocusEvent("focus"));
  dom.dispatchEvent(new FocusEvent("blur", { relatedTarget: document.body }));
  dom.dispatchEvent(new FocusEvent("blur"));
  expect(events).toEqual(["focus", "blur:el", "blur:null"]);
  editor.destroy();
});

test("unionSelectionRect: collapsed asks nothing, a throw is null, one line unions, no extent is null", () => {
  const asked: number[] = [];
  const line = (pos: number) => {
    asked.push(pos);
    return { left: pos * 10, top: 100, right: pos * 10 + 8, bottom: 120 };
  };
  expect(unionSelectionRect(4, 4, line)).toBeNull();
  expect(asked).toEqual([]);
  expect(unionSelectionRect(1, 4, line)).toEqual({ left: 10, top: 100, right: 48, bottom: 120 });
  expect(asked).toEqual([1, 4]);
  expect(
    unionSelectionRect(1, 4, () => {
      throw new Error("no layout");
    }),
  ).toBeNull();
  expect(unionSelectionRect(1, 4, () => ({ left: 0, top: 0, right: 0, bottom: 0 }))).toBeNull();
});


test("the shared editor is a named multiline text box, including an empty scene", () => {
  const editor = mountEditor("");
  const dom = document.querySelector("#editor .ProseMirror") as HTMLElement;
  expect(dom.getAttribute("role")).toBe("textbox");
  expect(dom.getAttribute("aria-label")).toBe("Manuscript editor");
  expect(dom.getAttribute("aria-multiline")).toBe("true");
  expect(dom.getAttribute("lang")).toBe("");
  editor.destroy();
});

test("restoreSelection restores a caret, clamps stale endpoints and changes no prose or scroll", () => {
  let changes = 0;
  const editor = mountEditor("one two three", { onChange: () => changes++ });
  const pane = document.querySelector("#editor") as HTMLElement;
  pane.scrollTop = 80;
  editor.restoreSelection(5, 5);
  expect(editor.selection()).toEqual({ from: 5, to: 5 });
  editor.restoreSelection(-10, 9000);
  expect(editor.selection()).toEqual({ from: 1, to: 14 });
  editor.restoreSelection(Number.NaN, Number.POSITIVE_INFINITY);
  expect(editor.selection()).toEqual({ from: 1, to: 1 });
  expect(pane.scrollTop).toBe(80);
  expect(changes).toBe(0);
  expect(editor.textIn(1, 14)).toBe("one two three");
  editor.destroy();
});
