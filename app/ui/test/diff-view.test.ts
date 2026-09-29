import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderPieces } from "../src/diff-view";
import type { DiffPiece } from "../src/diff";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function paint(pieces: DiffPiece[]): HTMLElement {
  const target = document.createElement("div");
  renderPieces(target, pieces);
  return target;
}

describe("renderPieces", () => {
  test("a removal is a <del> and an addition is an <ins>", () => {
    // ASSERTS THE ELEMENT NAMES, not the classes. The class is styling; the
    // element is what an assistive client is told, and swapping the two hands
    // a screen reader a diff with its sides reversed while the page still
    // looks right.
    const el = paint([
      { op: "removed", text: "old " },
      { op: "added", text: "new " },
    ]);
    const kinds = [...el.children].map((c) => c.tagName.toLowerCase());
    expect(kinds).toEqual(["del", "ins"]);
  });

  test("the classes follow the elements", () => {
    const el = paint([
      { op: "removed", text: "old " },
      { op: "added", text: "new " },
    ]);
    expect([...el.children].map((c) => c.className)).toEqual(["diff-removed", "diff-added"]);
  });

  test("unchanged text is a TEXT NODE and not an element", () => {
    // A `same` run wrapped in an element would be one more thing for an
    // assistive client to announce, in a surface that is mostly unchanged
    // prose. It also makes the two marked runs stop standing out.
    const el = paint([
      { op: "same", text: "kept " },
      { op: "added", text: "new" },
    ]);
    expect(el.children.length).toBe(1);
    expect(el.textContent).toBe("kept new");
  });

  test("document order is preserved", () => {
    // The reading order IS the claim: removed then added is "what was there,
    // then what is there now", which is the order `diff.ts` builds and the
    // order the legend describes.
    const el = paint([
      { op: "added", text: "A" },
      { op: "removed", text: "B" },
      { op: "added", text: "C" },
    ]);
    expect([...el.children].map((c) => c.tagName.toLowerCase())).toEqual(["ins", "del", "ins"]);
  });

  test("painting again REPLACES rather than appends", () => {
    // The panel repaints on every comparison. Appending would grow the region
    // with every press and show the writer two diffs at once.
    const target = document.createElement("div");
    renderPieces(target, [{ op: "added", text: "first" }]);
    renderPieces(target, [{ op: "added", text: "second" }]);
    expect(target.textContent).toBe("second");
    expect(target.children.length).toBe(1);
  });

  test("nothing to paint leaves an empty region", () => {
    const target = document.createElement("div");
    target.textContent = "stale";
    renderPieces(target, []);
    expect(target.textContent).toBe("");
  });
});
