import { DOMSerializer } from "prosemirror-model";
import { readableBody, schema } from "./editor";

/** Render a saved document without constructing an editor or accepting writes. */
export function savedProse(body: string, owner: Document): DocumentFragment | null {
  const json = readableBody(body);
  if (json === null) return null;
  const node = schema.nodeFromJSON(json);
  if (node.type !== schema.topNodeType) return null;
  try { node.check(); } catch { return null; }
  const fragment = owner.createDocumentFragment();
  DOMSerializer.fromSchema(schema).serializeFragment(node.content, { document: owner }, fragment);
  return fragment;
}

export function proseItem(type: string): boolean {
  return type === "scene" || type === "note" || type === "matter";
}
