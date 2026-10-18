import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, test } from "bun:test";
import { EditorState, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { undo, redo } from "prosemirror-history";
import { createEditor, editorPlugins, schema, type Editor } from "../src/editor";
import { createDocumentAuthoring } from "../src/document-authoring";
import { t } from "../src/i18n";

if (typeof document === "undefined") GlobalRegistrator.register();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });
function rig(committed = async () => true) {
  const mount = document.createElement("div"); document.body.append(mount);
  const editor = createEditor(mount, { kind: "pmjson", json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Prose" }] }] } }, {
    authoring: true, onAtomCommit: committed,
  });
  editors.push(editor);
  return { editor, mount };
}
function field() { return document.querySelector<HTMLTextAreaElement>("#endnote-body")!; }
function press(key: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("#endnote-editor button")].find(button => button.textContent === t(key));
  expect(button).toBeDefined(); button!.click();
}
function notes(editor: Editor) {
  return JSON.parse(editor.serialize()).content.flatMap((block: { content?: { type: string; attrs: { id: string; fmt: string; body: string } }[] }) => block.content ?? [])
    .filter((node: { type: string }) => node.type === "endnote") as { attrs: { id: string; fmt: string; body: string } }[];
}

test("note Save is isolated from typing; edit, delete, undo and redo retain identity and body", async () => {
  const { editor, mount } = rig();
  editor.typeChar("X");
  const typed = editor.serialize();
  editor.editEndnote();
  field().value = "Plain note\nSecond line";
  press("authoring.save"); await tick();
  const saved = editor.serialize();
  const id = notes(editor)[0].attrs.id;
  expect(notes(editor)[0].attrs.body).toBe("Plain note\nSecond line");
  editor.undo(); expect(editor.serialize()).toBe(typed);
  editor.redo(); expect(editor.serialize()).toBe(saved);
  editor.setNoteOffset(7);
  const reference = mount.querySelector<HTMLButtonElement>("button[data-endnote-id]")!;
  expect(reference.getAttribute("aria-label")).toMatch(/8$/);
  reference.click(); field().value = "Changed note";
  press("authoring.save"); await tick();
  expect(notes(editor)[0].attrs).toEqual({ id, fmt: "text", body: "Changed note" });
  editor.undo(); expect(editor.serialize()).toBe(saved);
  expect(editor.revealMatch("Plain note", { instance_id: id, field: "note", from: 0, to: 10 })).toBe(true);
  editor.deleteSelectedAtom(); expect(notes(editor)).toHaveLength(0);
  editor.undo(); expect(notes(editor)[0].attrs.id).toBe(id);
  editor.redo(); expect(notes(editor)).toHaveLength(0);
});

test("Cancel inserts nothing; leaving offers Save, Discard and Cancel without losing a draft", async () => {
  const { editor } = rig();
  const original = editor.serialize();
  editor.editEndnote(); field().value = "Uncommitted";
  press("authoring.cancel");
  expect(editor.serialize()).toBe(original);
  editor.editEndnote(); field().value = "Keep this draft";
  const first = editor.confirmAtomDraft();
  press("authoring.cancel"); expect(await first).toBe(false);
  expect(field().value).toBe("Keep this draft");
  expect(editor.atomDraftPending()).toBe(true);
  const escape = editor.confirmAtomDraft();
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(await escape).toBe(false);
  expect(field().value).toBe("Keep this draft");
  expect(editor.atomDraftPending()).toBe(true);
  const second = editor.confirmAtomDraft();
  press("authoring.discard"); expect(await second).toBe(true);
  expect(editor.serialize()).toBe(original);
  editor.editEndnote(); field().value = "Save on leaving";
  const third = editor.confirmAtomDraft();
  press("authoring.save"); expect(await third).toBe(true);
  expect(notes(editor)[0].attrs.body).toBe("Save on leaving");
});

test("a failed save keeps the draft; retry updates the same note and document replacement refuses", async () => {
  let succeeds = false;
  const { editor } = rig(async () => succeeds);
  editor.editEndnote(); field().value = "Recover this text";
  expect(() => editor.replaceDoc({ kind: "blocks", blocks: [] })).toThrow("draft");
  press("authoring.save"); await tick();
  expect(editor.atomDraftPending()).toBe(true);
  expect(field().value).toBe("Recover this text");
  expect(document.querySelector("#endnote-editor [role=alert]")!.textContent).toBe(t("authoring.failed"));
  const id = notes(editor)[0].attrs.id;
  succeeds = true;
  press("authoring.save"); await tick();
  expect(editor.atomDraftPending()).toBe(false);
  expect(notes(editor)).toHaveLength(1);
  expect(notes(editor)[0].attrs.id).toBe(id);
});

test("scene breaks insert and delete explicitly with undo/redo; literal asterisks remain prose", () => {
  const mount = document.createElement("div"); document.body.append(mount);
  const doc = schema.node("doc", null, schema.node("paragraph", null, schema.text("* * *")));
  const view = new EditorView(mount, { state: EditorState.create({ doc, plugins: editorPlugins() }) });
  const authoring = createDocumentAuthoring(view, { canEdit: () => true, committed: async () => true, draftChanged() {}, noteOffset: () => 0 });
  try {
    expect(view.state.doc.toJSON()).toEqual(doc.toJSON());
    authoring.sceneBreak();
    let pos = -1;
    view.state.doc.descendants((node, at) => { if (node.type.name === "scene_break") pos = at; });
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(view.state.doc.textContent).toBe("* * *");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    authoring.remove();
    expect(view.state.doc.toJSON().content.some((node: { type: string }) => node.type === "scene_break")).toBe(false);
    expect(undo(view.state, tr => view.dispatch(tr))).toBe(true);
    expect(view.state.doc.nodeAt(pos)!.type.name).toBe("scene_break");
    expect(redo(view.state, tr => view.dispatch(tr))).toBe(true);
    expect(view.state.doc.textContent).toBe("* * *");
  } finally { authoring.destroy(); view.destroy(); }
});
