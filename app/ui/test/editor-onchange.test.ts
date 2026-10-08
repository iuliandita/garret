import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, readableBody, schema, type DocInput } from "../src/editor";

const input: DocInput = {
  kind: "blocks",
  blocks: [
    { type: "paragraph", text: "alpha" },
    { type: "paragraph", text: "beta" },
  ],
};

describe("createEditor onChange", () => {
  test("fires only on a document change, not on a caret move", () => {
    const mount = document.createElement("div");
    let changes = 0;
    const editor = createEditor(mount, input, { onChange: () => changes++ });
    expect(changes).toBe(0);

    editor.caretToParagraph(1);
    expect(changes).toBe(0);

    editor.typeChar("x");
    expect(changes).toBe(1);

    editor.destroy();
  });

  test("rejects document changes while a host replacement holds the editor lock", () => {
    const mount = document.createElement("div");
    let changes = 0;
    const editor = createEditor(mount, input, { onChange: () => changes++ });
    const before = editor.serialize();

    editor.setEditable(false);
    editor.typeChar("x");
    expect(editor.serialize()).toBe(before);
    expect(changes).toBe(0);

    editor.setEditable(true);
    editor.typeChar("x");
    expect(editor.serialize()).not.toBe(before);
    expect(changes).toBe(1);
    editor.destroy();
  });
});

describe("imported manual breaks", () => {
  test("renders, edits, serializes and reopens marked text newlines", () => {
    const body = JSON.stringify({ type: "doc", content: [
      { type: "paragraph", content: [
        { type: "text", text: "\nplain" },
        { type: "text", text: "\n\nstyled\n", marks: [
          { type: "strong" }, { type: "em" }, { type: "underline" },
        ] },
        { type: "text", text: "tail\n" },
      ] },
      { type: "paragraph", content: [
        { type: "text", text: "\n\n", marks: [{ type: "underline" }] },
      ] },
    ] });
    const parsed = readableBody(body);
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("Manual breaks must be readable by the production schema");
    const mount = document.createElement("div");
    const editor = createEditor(mount, { kind: "pmjson", json: parsed });
    try {
      expect(mount.querySelectorAll("p")).toHaveLength(2);
      expect(mount.querySelectorAll("br.ProseMirror-trailingBreak")).toHaveLength(2);
      expect(mount.querySelector("p")?.textContent).toBe("\nplain\n\nstyled\ntail\n");
      expect(mount.querySelector("strong em u, em strong u")?.textContent).toBe("\n\nstyled\n");
      editor.caretToParagraph(0);
      editor.typeChar("x");
      const saved = editor.serialize();
      const reopened = readableBody(saved);
      expect(reopened).not.toBeNull();
      if (reopened === null) throw new Error("Saved manual breaks must reopen");
      editor.replaceDoc({ kind: "pmjson", json: reopened });
      expect(editor.serialize()).toBe(saved);
      const doc = schema.nodeFromJSON(reopened as unknown as Record<string, unknown>);
      expect(doc.child(0).textContent).toBe("\nplain\n\nstyled\ntail\nx");
      expect(doc.child(0).child(1).marks.map((mark) => mark.type.name)).toEqual(["em", "strong", "underline"]);
      expect(doc.child(1).textContent).toBe("\n\n");
      expect(doc.child(1).child(0).marks.map((mark) => mark.type.name)).toEqual(["underline"]);
    } finally {
      editor.destroy();
    }
  });
});
