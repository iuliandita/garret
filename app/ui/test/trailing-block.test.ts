import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";
import { createEditor, editorPlugins, schema, type Editor } from "../src/editor";
import { trailingTextblockPlugin } from "../src/trailing-block";

if (typeof document === "undefined") GlobalRegistrator.register();
const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

const figure = { type: "figure", attrs: { id: "01900000-0000-7000-8000-000000000002", asset_id: "01900000-0000-7000-8000-000000000003", width: "full", caption: "", alt: "x" } };
const endsInFigure = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }, figure] };
const types = (editor: Editor): string[] => JSON.parse(editor.serialize()).content.map((node: { type: string }) => node.type);

function open(authoring: boolean): Editor {
  const mount = document.createElement("div"); document.body.append(mount);
  const editor = createEditor(mount, { kind: "pmjson", json: endsInFigure }, { authoring });
  editors.push(editor);
  return editor;
}

test("only the writing editor keeps a paragraph after a trailing figure", () => {
  const writing = open(true);
  const shown = open(false);
  expect(types(writing)).toEqual(["paragraph", "figure", "paragraph"]);
  expect(types(shown)).toEqual(["paragraph", "figure"]);
  for (const editor of [writing, shown]) { editor.restoreSelection(2, 2); editor.typeChar("b"); }
  expect(types(writing)).toEqual(["paragraph", "figure", "paragraph"]);
  expect(types(shown)).toEqual(["paragraph", "figure"]);
  shown.replaceDoc({ kind: "pmjson", json: endsInFigure });
  expect(types(shown)).toEqual(["paragraph", "figure"]);
});

test("deleting only the kept paragraph is refused instead of being put straight back", () => {
  const doc = schema.nodeFromJSON({ ...endsInFigure, content: [...endsInFigure.content, { type: "paragraph" }] });
  const state = EditorState.create({ doc, plugins: [...editorPlugins(), trailingTextblockPlugin()] });
  const end = doc.content.size;
  expect(state.apply(state.tr.delete(end - 2, end))).toBe(state);
  const typed = state.apply(state.tr.insertText("z", end - 1));
  expect(typed.doc.lastChild!.textContent).toBe("z");
});
