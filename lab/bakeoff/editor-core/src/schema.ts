// lab/bakeoff/editor-core/src/schema.ts
// A deliberately small semantic schema: block = paragraph|heading, inline text
// with strong/em marks. Constructed from prosemirror-model only (no DOM), so it
// unit-tests headlessly and is identical in both shells.
import { Schema, type Node as PMNode } from "prosemirror-model";
import type { SceneDoc } from "./model";

export const bakeoffSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { script: { default: "latin" } },
      toDOM: (n) => [
        "p",
        { dir: n.attrs.script === "rtl" ? "rtl" : "ltr", "data-script": n.attrs.script },
        0,
      ],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { script: { default: "latin" } },
      toDOM: (n) => [
        "h2",
        { dir: n.attrs.script === "rtl" ? "rtl" : "ltr", "data-script": n.attrs.script },
        0,
      ],
    },
    text: { group: "inline" },
  },
  marks: {
    strong: { toDOM: () => ["strong", 0] },
    em: { toDOM: () => ["em", 0] },
  },
});

// Build a ProseMirror doc node from a scene. Pure: uses schema.node / schema.text
// with no editor view, so it is safe in the node test runner. The doc requires
// `block+`, so an empty scene gets a single empty paragraph (Schema.node does not
// auto-fill required content the way createAndFill would).
export function sceneToDoc(scene: SceneDoc): PMNode {
  const blocks = scene.blocks.map((b) => {
    const content = b.text.length ? [bakeoffSchema.text(b.text)] : [];
    return bakeoffSchema.node(b.type, { script: b.script }, content);
  });
  if (blocks.length === 0) {
    blocks.push(bakeoffSchema.node("paragraph", { script: "latin" }, []));
  }
  return bakeoffSchema.node("doc", null, blocks);
}
