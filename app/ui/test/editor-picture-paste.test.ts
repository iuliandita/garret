import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { createEditor, schema } from "../src/editor";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function transfer(plain = "", html = "", types: string[] = []): DataTransfer {
  return { types, files: [], getData: (type: string) => type === "text/plain" ? plain : type === "text/html" ? html : "" } as unknown as DataTransfer;
}

function send(mount: HTMLElement, kind: "paste" | "drop", data: DataTransfer): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, kind === "paste" ? "clipboardData" : "dataTransfer", { value: data });
  mount.querySelector(".ProseMirror")!.dispatchEvent(event);
  return event;
}

const blob = "aB3/".repeat(4096);
const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${blob}"/></svg>`;

test.each([
  ["image type", transfer("", "", ["image/png"])],
  ["Files type", transfer("", "", ["Files"])],
  ["file list", { ...transfer(), files: [new File(["image"], "picture.png", { type: "image/png" })] } as unknown as DataTransfer],
  ["SVG text", transfer(svg)],
  ["HTML image", transfer("", `<html><body><!--StartFragment--><img src="data:image/png;base64,${blob}"><!--EndFragment--></body></html>`)],
  ["SVG HTML", transfer("", svg)],
  ["data URI", transfer(`data:image/png;base64,${blob}`)],
  ["base64 data URI", transfer(`data:application/octet-stream;base64,${blob}`)],
  ["base64 blob", transfer(blob)],
  ["letters-only base64", transfer("A".repeat(4096))],
  ["wrapped base64", transfer(`${blob.slice(0, 8000)}\n${blob.slice(8000)}`)],
] as const)("refuses %s before changing the document on paste or drop", (_name, data) => {
  const mount = document.createElement("div"); document.body.append(mount);
  let changes = 0;
  const reasons: (string | undefined)[] = [];
  const editor = createEditor(mount, { kind: "blocks", blocks: [{ type: "paragraph", text: "Keep this prose." }] }, {
    onChange: () => changes++, onClipboardRefused: reason => reasons.push(reason),
  });
  try {
    editor.selectRange(1, 5);
    const before = editor.serialize();
    const selection = editor.selection();
    for (const kind of ["paste", "drop"] as const) {
      expect(send(mount, kind, data).defaultPrevented).toBe(true);
      expect(editor.serialize()).toBe(before);
      expect(editor.selection()).toEqual(selection);
      expect(changes).toBe(0);
    }
    expect(reasons).toEqual(["picture", "picture"]);
    editor.undo();
    expect(editor.serialize()).toBe(before);
    expect(changes).toBe(0);
  } finally { editor.destroy(); mount.remove(); }
});

test("ordinary long prose still pastes, including rich text offering an image", () => {
  const text = "The writer kept 12 pages, and revised the next chapter. ".repeat(4096).trim();
  for (const rich of [false, true]) {
    const mount = document.createElement("div"); document.body.append(mount);
    let changes = 0;
    let refused = 0;
    const editor = createEditor(mount, { kind: "blocks", blocks: [] }, {
      onChange: () => changes++, onClipboardRefused: () => refused++,
    });
    try {
      send(mount, "paste", transfer(text, rich ? `<p><strong>${text}</strong><img src="picture.png"></p>` : "", rich ? ["text/plain", "text/html", "image/png", "Files"] : ["text/plain"]));
      const doc = schema.nodeFromJSON(JSON.parse(editor.serialize()));
      expect(doc.textContent).toBe(text);
      expect(doc.child(0).child(0).marks.map(mark => mark.type.name)).toEqual(rich ? ["strong"] : []);
      expect(changes).toBe(1);
      expect(refused).toBe(0);
      editor.undo();
      expect(schema.nodeFromJSON(JSON.parse(editor.serialize())).textContent).toBe("");
    } finally { editor.destroy(); mount.remove(); }
  }
});
