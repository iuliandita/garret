import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  caretTr,
  docJsonFrom,
  erasePrevTr,
  paragraphTarget,
  schema,
  splitTr,
  type PmNodeJson,
} from "../src/editor";

// EditorState with no view and no DOM: prosemirror-view is never constructed in
// this repo's tests, and the transaction builders are pure so it does not need
// to be.
function stateOf(paragraphs: string[]): EditorState {
  const doc = schema.nodeFromJSON(
    docJsonFrom({
      kind: "blocks",
      blocks: paragraphs.map((text) => ({ type: "paragraph", text })),
    }) as unknown as Record<string, unknown>,
  );
  return EditorState.create({ doc });
}

function caretAt(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe("docJsonFrom", () => {
  test("builds a ProseMirror document from corpus blocks", () => {
    const json = docJsonFrom({
      kind: "blocks",
      blocks: [{ type: "paragraph", text: "hello" }],
    });
    expect(json.type).toBe("doc");
    expect(json.content?.[0]?.content?.[0]?.text).toBe("hello");
  });

  test("passes stored ProseMirror JSON through unchanged", () => {
    const stored = { type: "doc", content: [{ type: "paragraph" }] };
    expect(docJsonFrom({ kind: "pmjson", json: stored })).toEqual(stored);
  });

  test("blocks with no text do not produce empty text nodes", () => {
    const json = docJsonFrom({ kind: "blocks", blocks: [{ type: "paragraph", text: "" }] });
    expect(json.content).toEqual([{ type: "paragraph" }]);
  });
});

describe("schema.nodeFromJSON round-trip", () => {
  test("accepts blocks-derived JSON and preserves text content", () => {
    const json = docJsonFrom({
      kind: "blocks",
      blocks: [{ type: "paragraph", text: "hello" }],
    });
    const node = schema.nodeFromJSON(json as unknown as Record<string, unknown>);
    expect(node.textContent).toBe("hello");

    const roundTripped = node.toJSON() as PmNodeJson;
    const again = docJsonFrom({ kind: "pmjson", json: roundTripped });
    const node2 = schema.nodeFromJSON(again as unknown as Record<string, unknown>);
    expect(node2.textContent).toBe("hello");
    expect(node2.toJSON()).toEqual(roundTripped);
  });

  test("accepts the bare empty-paragraph fallback shape (no content key)", () => {
    const json = docJsonFrom({ kind: "blocks", blocks: [{ type: "paragraph", text: "" }] });
    expect(() => schema.nodeFromJSON(json as unknown as Record<string, unknown>)).not.toThrow();
    const node = schema.nodeFromJSON(json as unknown as Record<string, unknown>);
    expect(node.textContent).toBe("");
  });
});

describe("paragraphTarget", () => {
  test("an in-range ordinal is itself", () => {
    expect(paragraphTarget(5, 3)).toBe(3);
  });

  test("an ordinal past the end wraps", () => {
    expect(paragraphTarget(5, 7)).toBe(2);
    expect(paragraphTarget(5, 4095)).toBe(0);
  });

  test("a negative ordinal wraps forward, never negative", () => {
    // A raw `n % childCount` returns -2 here, and -2 is a valid argument to
    // doc.child() nowhere: it throws deep inside ProseMirror at soak time.
    expect(paragraphTarget(5, -2)).toBe(3);
    expect(paragraphTarget(5, -5)).toBe(0);
  });

  test("a document with no blocks is a caller bug, not a clamp", () => {
    expect(() => paragraphTarget(0, 1)).toThrow("paragraphTarget: childCount 0");
  });
});

describe("splitTr", () => {
  test("splitting at the caret adds exactly one paragraph", () => {
    const state = stateOf(["alpha", "beta"]);
    const after = state.apply(splitTr(state));
    expect(after.doc.childCount).toBe(3);
  });

  test("splitting mid-paragraph divides its text and loses none of it", () => {
    const state = caretAt(stateOf(["alpha"]), 3); // between "al" and "pha"
    const after = state.apply(splitTr(state));
    expect(after.doc.childCount).toBe(2);
    expect(after.doc.child(0).textContent).toBe("al");
    expect(after.doc.child(1).textContent).toBe("pha");
  });
});

describe("erasePrevTr", () => {
  test("deletes the character before the caret", () => {
    const state = caretAt(stateOf(["alpha"]), 6); // end of "alpha"
    const tr = erasePrevTr(state);
    expect(tr).not.toBeNull();
    if (tr === null) return; // narrows for tsc; unreachable given the assertion
    expect(state.apply(tr).doc.child(0).textContent).toBe("alph");
  });

  test("at a paragraph start there is nothing to erase and it returns null", () => {
    // Deliberately NOT a paragraph join: merging makes childCount non-monotonic
    // mid-soak, so a seeded caret ordinal would land somewhere the draw did not
    // predict and two runs at the same seed would diverge.
    const state = caretAt(stateOf(["alpha", "beta"]), 8); // start of "beta"
    expect(erasePrevTr(state)).toBeNull();
  });

  test("at the very start of the document it returns null", () => {
    const state = caretAt(stateOf(["alpha"]), 1);
    expect(erasePrevTr(state)).toBeNull();
  });
});

describe("caretTr", () => {
  test("puts the caret at the end of the requested paragraph", () => {
    const state = stateOf(["alpha", "beta", "gamma"]);
    const after = state.apply(caretTr(state, 1));
    // A paragraph's nodeSize is content.size + 2 (open and close tokens), so
    // "alpha" is 7 and "beta" starts at 7. Its content ends at 7 + 1 + 4 = 12.
    expect(after.selection.from).toBe(12);
    expect(after.selection.$from.parent.textContent).toBe("beta");
  });

  test("an out-of-range ordinal wraps instead of throwing", () => {
    const state = stateOf(["alpha", "beta", "gamma"]);
    const after = state.apply(caretTr(state, 4095));
    expect(after.selection.$from.parent.textContent).toBe("alpha");
  });

  test("typing after the jump lands in the targeted paragraph", () => {
    // The point of the action: the next `type` must go where the caret went, not
    // where it was. A caretTr that returned an unchanged transaction would pass
    // both tests above on paragraph 0 and fail this one.
    const state = stateOf(["alpha", "beta"]);
    const moved = state.apply(caretTr(state, 1));
    const typed = moved.apply(moved.tr.insertText("!", moved.selection.from));
    expect(typed.doc.child(1).textContent).toBe("beta!");
    expect(typed.doc.child(0).textContent).toBe("alpha");
  });
});
