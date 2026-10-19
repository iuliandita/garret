import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { createEditor, editorPlugins, schema } from "../src/editor";
import { atomSignature, preserveAtoms } from "../src/document-reader";
import { t } from "../src/i18n";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
const note = schema.nodes.endnote.create({ id: "01900000-0000-7000-8000-000000000001", fmt: "text", body: "Saved note\nMore" });
const figure = schema.nodes.figure.create({ id: "01900000-0000-7000-8000-000000000002", asset_id: "01900000-0000-7000-8000-000000000003", width: "half", caption: "Caption", alt: "Description" });
const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Prose"), note]), figure, schema.nodes.scene_break.create(), schema.node("paragraph", null, schema.text("After"))]);

test.each([false, true])("prose edits preserve atoms and ordinary replacement refuses, authoring=%s", authoring => {
  let state = EditorState.create({ doc, plugins: [...editorPlugins(), preserveAtoms(authoring)] });
  const original = atomSignature(state.doc);
  const dispatch = (tr: Parameters<typeof state.apply>[0]) => { state = state.apply(tr); };
  dispatch(state.tr.insertText("Edited ", 1));
  expect(state.doc.textContent).toContain("Edited Prose");
  expect(atomSignature(state.doc)).toBe(original);
  expect(undo(state, dispatch)).toBe(true);
  expect(state.doc.eq(doc)).toBe(true);
  expect(redo(state, dispatch)).toBe(true);
  const before = state;
  dispatch(state.tr.insert(1, note));
  expect(state).toBe(before);
  dispatch(state.tr.replaceWith(0, state.doc.content.size, [figure, doc.child(0), doc.child(2), doc.child(3)]));
  expect(state).toBe(before);
  dispatch(state.tr.delete(1, state.doc.content.size));
  expect(state).toBe(before);
  state.doc.descendants((node, pos) => {
    if (node.type.name === "endnote") dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, body: "changed" }));
  });
  expect(state).toBe(before);
});

test("desktop authoring refuses ordinary Delete and Select All removal of existing figures", () => {
  const mount = document.createElement("div"); document.body.append(mount);
  let refused = 0;
  const editor = createEditor(mount, { kind: "pmjson", json: doc.toJSON() }, {
    authoring: true, onAtomEditRefused: () => refused++,
  });
  try {
    const original = editor.serialize();
    editor.restoreSelection(0, doc.content.size);
    mount.querySelector(".ProseMirror")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8, bubbles: true, cancelable: true }));
    expect(editor.serialize()).toBe(original);
    editor.restoreSelection(7, 7);
    editor.erasePrev();
    expect(editor.serialize()).toBe(original);
    expect(refused).toBe(2);
  } finally { editor.destroy(); mount.remove(); }
});

test("reader displays note body and bounded figure preview; late previews stay retired", async () => {
  const mount = document.createElement("div"); document.body.append(mount);
  let resolve!: (value: { state: string; data_uri: string }) => void;
  const observer = globalThis.IntersectionObserver;
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  let refused = 0;
  const editor = createEditor(mount, { kind: "pmjson", json: doc.toJSON() }, {
    onAtomEditRefused: () => refused++,
    figurePreview: async () => new Promise(r => { resolve = r; }),
  });
  const original = editor.serialize();
  editor.restoreSelection(7, 7);
  editor.erasePrev();
  expect(editor.serialize()).toBe(original);
  expect(refused).toBe(1);
  const button = mount.querySelector<HTMLButtonElement>(".document-endnote-reader button")!;
  expect(button.getAttribute("aria-label")).toMatch(/1$/);
  button.click();
  expect(mount.querySelector<HTMLElement>(".document-endnote-body")!.hidden).toBe(false);
  expect(mount.textContent).toContain("Saved note\nMore");
  const oldFigure = mount.querySelector("figure")!;
  editor.replaceDoc({ kind: "pmjson", json: schema.node("doc", null, schema.node("paragraph", null, schema.text("Other"))).toJSON() });
  resolve({ state: "present", data_uri: "data:image/png;base64,AAAA" });
  await Promise.resolve(); await Promise.resolve();
  expect(oldFigure.querySelector("img")).toBeNull();
  editor.destroy();
  const current = createEditor(mount, { kind: "pmjson", json: doc.toJSON() }, {
    figurePreview: async (instance, asset) => {
      expect(instance).toBe(figure.attrs.id);
      expect(asset).toBe(figure.attrs.asset_id);
      return { state: "present", data_uri: "data:image/png;base64,AAAA" };
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mount.querySelector("figure img")?.getAttribute("alt")).toBe("Description");
  current.destroy(); mount.remove();
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: observer });
});

test("figure alternative text sits on the picture and never as a second visible line", async () => {
  const mount = document.createElement("div"); document.body.append(mount);
  const observer = globalThis.IntersectionObserver;
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: undefined });
  const editor = createEditor(mount, { kind: "pmjson", json: doc.toJSON() }, {
    figurePreview: async () => ({ state: "present", data_uri: "data:image/png;base64,AAAA" }),
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const figureDom = mount.querySelector("figure")!;
    const image = figureDom.querySelector("img")!;
    expect(image.getAttribute("alt")).toBe("Description");
    expect(image.getAttribute("title")).toBe("Description");
    expect(figureDom.textContent).not.toContain("Description");
    expect(figureDom.querySelector(".document-figure-alt-missing")).toBeNull();
    expect(figureDom.querySelector("figcaption")!.textContent).toBe("Caption");
  } finally {
    editor.destroy(); mount.remove();
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: observer });
  }
});

test.each(["", "  "])("a figure without alternative text shows a quiet marker (%j)", alt => {
  const mount = document.createElement("div"); document.body.append(mount);
  const bare = schema.node("doc", null, [figure.type.create({ ...figure.attrs, alt }), schema.node("paragraph")]);
  const editor = createEditor(mount, { kind: "pmjson", json: bare.toJSON() });
  try {
    expect(mount.querySelector(".document-figure-alt-missing")!.textContent).toBe(t("figure.alt-missing"));
    expect(JSON.parse(editor.serialize()).content[0].attrs.alt).toBe(alt);
  } finally { editor.destroy(); mount.remove(); }
});
