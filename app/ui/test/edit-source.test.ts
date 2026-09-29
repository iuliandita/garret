import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { redo, undo } from "prosemirror-history";
import { EditorState, type Transaction } from "prosemirror-state";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { EditSourceTracker, type EditSourceChange } from "../src/edit-source";
import { countWordsIn, createEditor, docJsonFrom, editorPlugins, schema } from "../src/editor";

function stateOf(text: string): EditorState {
  const doc = schema.nodeFromJSON(
    docJsonFrom({ kind: "blocks", blocks: [{ type: "paragraph", text }] }) as unknown as Record<
      string,
      unknown
    >,
  );
  return EditorState.create({ doc, plugins: editorPlugins() });
}

function historyRig(text: string): {
  changes: EditSourceChange[];
  dispatch: (tr: Transaction) => void;
  state: () => EditorState;
} {
  let state = stateOf(text);
  const tracker = new EditSourceTracker();
  const changes: EditSourceChange[] = [];
  return {
    changes,
    dispatch(tr) {
      const before = state;
      tracker.prepare(tr);
      state = before.apply(tr);
      changes.push(tracker.record(tr, before, state, () => countWordsIn(before.doc)));
    },
    state: () => state,
  };
}

function append(state: EditorState, text: string): Transaction {
  return state.tr.insertText(text, state.doc.content.size - 1);
}

describe("edit source history", () => {
  test("paste then typing keep distinct sources through undo and redo", () => {
    const rig = historyRig("one");
    rig.dispatch(append(rig.state(), " two").setMeta("uiEvent", "paste"));
    rig.dispatch(append(rig.state(), " three"));

    undo(rig.state(), rig.dispatch);
    undo(rig.state(), rig.dispatch);
    redo(rig.state(), rig.dispatch);
    redo(rig.state(), rig.dispatch);

    expect(rig.changes).toEqual([
      { source: "pasted", beforeWords: 1 },
      { source: "typing", beforeWords: 2 },
      { source: "typing" },
      { source: "pasted", beforeWords: 2 },
      { source: "pasted" },
      { source: "typing", beforeWords: 2 },
    ]);
    expect(rig.state().doc.textContent).toBe("one two three");
  });

  test("paste and drop are pasted while cut and composition remain typing", () => {
    const rig = historyRig("one two");
    rig.dispatch(append(rig.state(), " three").setMeta("uiEvent", "drop"));
    rig.dispatch(append(rig.state(), "!").setMeta("uiEvent", "cut"));
    rig.dispatch(append(rig.state(), "?").setMeta("composition", 1));

    expect(rig.changes).toEqual([
      { source: "pasted", beforeWords: 2 },
      { source: "typing", beforeWords: 3 },
      { source: "typing" },
    ]);
  });

  test("an edit excluded from history does not relabel the prior undo event", () => {
    const rig = historyRig("one");
    rig.dispatch(append(rig.state(), " two").setMeta("uiEvent", "paste"));
    rig.dispatch(append(rig.state(), " three").setMeta("addToHistory", false));
    undo(rig.state(), rig.dispatch);

    expect(rig.changes).toEqual([
      { source: "pasted", beforeWords: 1 },
      { source: "typing", beforeWords: 2 },
      { source: "pasted", beforeWords: 3 },
    ]);
  });
});

test("replaceDoc resets the first-edit checkpoint without per-keystroke recounting", () => {
  const changes: EditSourceChange[] = [];
  const editor = createEditor(
    document.createElement("div"),
    { kind: "blocks", blocks: [{ type: "paragraph", text: "alpha beta" }] },
    { onChange: (change) => changes.push(change) },
  );

  editor.typeChar("x");
  editor.typeChar("y");
  editor.replaceDoc({
    kind: "blocks",
    blocks: [{ type: "paragraph", text: "one two three" }],
  });
  editor.typeChar("z");

  expect(changes).toEqual([
    { source: "typing", beforeWords: 2 },
    { source: "typing" },
    { source: "typing", beforeWords: 3 },
  ]);
  editor.destroy();
});

test("local find replacements and their undo do not count as typing", () => {
  const changes: EditSourceChange[] = [];
  const editor = createEditor(document.createElement("div"),
    { kind: "blocks", blocks: [{ type: "paragraph", text: "one one" }] },
    { onChange: (change) => changes.push(change) });
  editor.replaceMatch("one", "one two");
  editor.replaceMatch("one", "one two");
  editor.replaceAll("one", "three four");
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.every((change) => change.source === "unattributed")).toBe(true);
  editor.destroy();

  const rig = historyRig("one");
  rig.dispatch(append(rig.state(), " two").setMeta("wordSource", "unattributed"));
  undo(rig.state(), rig.dispatch);
  expect(rig.changes.map((change) => change.source)).toEqual(["unattributed", "unattributed"]);
});
