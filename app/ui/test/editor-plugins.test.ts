import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { docJsonFrom, editorPlugins, schema } from "../src/editor";

// No EditorView anywhere: prosemirror-view needs a real browser, and every
// command under test is a pure (state, dispatch) => boolean.
function stateOf(paragraphs: string[]): EditorState {
  const doc = schema.nodeFromJSON(
    docJsonFrom({
      kind: "blocks",
      blocks: paragraphs.map((text) => ({ type: "paragraph", text })),
    }) as unknown as Record<string, unknown>,
  );
  return EditorState.create({ doc, plugins: editorPlugins() });
}

/** Sends a key through the plugins EXACTLY as the editor would: to each
 *  plugin's handleKeyDown prop, in plugin order, stopping at the first that
 *  handles it. This is what makes the test sensitive to the keymap wiring —
 *  calling a command from baseKeymap directly would pass even if
 *  editorPlugins() returned nothing at all.
 *
 *  The cast is real but narrow: keydownHandler touches only `state` and
 *  `dispatch` on the view it is given. */
function pressKey(state: EditorState, event: Partial<KeyboardEvent>): EditorState | null {
  let next: EditorState | null = null;
  const view = {
    state,
    dispatch: (tr: Transaction) => {
      next = state.apply(tr);
    },
  } as unknown as EditorView;
  for (const plugin of editorPlugins()) {
    const handler = plugin.props?.handleKeyDown;
    if (handler === undefined) continue;
    if (handler.call(plugin, view, event as KeyboardEvent) === true) return next;
  }
  return null;
}

describe("editorPlugins", () => {
  test("the Enter key reaches splitBlock through the keymap plugin", () => {
    const state = stateOf(["alpha"]);
    expect(state.doc.childCount).toBe(1);
    const next = pressKey(state, { key: "Enter", keyCode: 13 });
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(2);
  });

  test("Mod-z reaches undo through the keymap plugin", () => {
    const state = stateOf(["alpha"]);
    const typed = state.apply(state.tr.insertText("X", 1));
    expect(typed.doc.textContent).toBe("Xalpha");
    const next = pressKey(typed, { key: "z", keyCode: 90, ctrlKey: true });
    expect(next).not.toBeNull();
    expect(next!.doc.textContent).toBe("alpha");
  });

  test("Mod-z is a no-op with no history to undo", () => {
    expect(pressKey(stateOf(["alpha"]), { key: "z", keyCode: 90, ctrlKey: true })).toBeNull();
  });

  test("a selection-only transaction does not report docChanged", () => {
    // Checks the ProseMirror premise the createEditor onChange guard relies
    // on (`if (tr.docChanged) opts.onChange?.()` in ../src/editor.ts). It does
    // NOT cover the guard itself -- deleting that guard leaves this test
    // green. The guard is pinned by the mutation-tested EditorView test in
    // editor-onchange.test.ts.
    const state = stateOf(["alpha"]);
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 3));
    expect(tr.docChanged).toBe(false);
    expect(state.tr.insertText("z", 1).docChanged).toBe(true);
  });
});
