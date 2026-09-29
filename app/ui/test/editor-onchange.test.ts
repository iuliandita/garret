import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, type DocInput } from "../src/editor";

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
