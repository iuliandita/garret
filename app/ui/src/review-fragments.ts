import type { Node as PmNode, Schema } from "prosemirror-model";

export type ReviewMark = "em" | "strong" | "underline";
export type ReviewAtom =
  | { type: "endnote"; attrs: { id: string; fmt: "text"; body: string } }
  | { type: "figure"; attrs: { id: string; asset_id: string; width: "full" | "half" | "page"; caption: string; alt: string } }
  | { type: "scene_break" };
export type FragmentToken =
  | { kind: "open" | "close" }
  | { kind: "text"; text: string; marks?: ReviewMark[] }
  | { kind: "atom"; node: ReviewAtom };
export interface ReviewHunk {
  from: number;
  to: number;
  before: FragmentToken[];
  after: FragmentToken[];
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOKENS = 100_000;
const MAX_ATTRIBUTE_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Unsupported review property");
  }
  return value as Record<string, unknown>;
}

function unicode(value: unknown, limit = MAX_BYTES): string {
  if (typeof value !== "string" || encoder.encode(value).length > limit
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error("Invalid review text");
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Invalid review instance or asset ID");
  }
  return value;
}

/** Validate before ProseMirror can discard properties. Assets resolve at the host. */
function validateRaw(value: unknown): void {
  const root = object(value, ["type", "content"]);
  if (root.type !== "doc" || !Array.isArray(root.content) || !root.content.length) {
    throw new Error("Review document needs blocks");
  }
  let tokens = 0;
  const ids = new Set<string>();
  const atom = (raw: unknown, inline: boolean): void => {
    const node = object(raw, ["type", "attrs"]);
    if (node.type === "scene_break" && !inline) object(raw, ["type"]);
    else {
      const endnote = node.type === "endnote" && inline;
      if (!endnote && !(node.type === "figure" && !inline)) throw new Error("Unsupported review atom");
      const attrs = object(node.attrs, endnote ? ["id", "fmt", "body"] : ["id", "asset_id", "width", "caption", "alt"]);
      const id = uuid(attrs.id);
      if (ids.has(id)) throw new Error("Duplicate review instance ID");
      ids.add(id);
      if (endnote) {
        if (attrs.fmt !== "text") throw new Error("Unsupported review endnote format");
        unicode(attrs.body, MAX_ATTRIBUTE_BYTES);
      } else {
        uuid(attrs.asset_id);
        if (typeof attrs.width !== "string" || !["full", "half", "page"].includes(attrs.width)) throw new Error("Unsupported review figure width");
        unicode(attrs.caption, MAX_ATTRIBUTE_BYTES); unicode(attrs.alt, MAX_ATTRIBUTE_BYTES);
      }
    }
    tokens++;
  };
  for (const raw of root.content) {
    if ((raw as { type?: unknown } | null)?.type !== "paragraph") atom(raw, false);
    else {
      const paragraph = object(raw, ["type", "content"]);
      if ("content" in paragraph && !Array.isArray(paragraph.content)) throw new Error("Unsupported review paragraph");
      tokens += 2;
      for (const child of (paragraph.content ?? []) as unknown[]) {
        if ((child as { type?: unknown } | null)?.type !== "text") atom(child, true);
        else {
          const node = object(child, ["type", "text", "marks"]);
          if (!unicode(node.text) || ("marks" in node && !Array.isArray(node.marks))) throw new Error("Unsupported review text");
          const names = new Set<string>();
          for (const entry of (node.marks ?? []) as unknown[]) {
            const mark = object(entry, ["type"]);
            if (typeof mark.type !== "string" || !["em", "strong", "underline"].includes(mark.type)
              || names.has(mark.type)) throw new Error("Unsupported review mark");
            names.add(mark.type);
          }
          tokens++;
        }
        if (tokens > MAX_TOKENS) throw new Error("Review document exceeds limit");
      }
    }
    if (tokens > MAX_TOKENS) throw new Error("Review document exceeds limit");
  }
}

export function parseReviewBody(body: string, schema: Schema): PmNode {
  if (body.length > MAX_BYTES || encoder.encode(body).length > MAX_BYTES) throw new Error("Review document exceeds limit");
  const raw: unknown = JSON.parse(body);
  validateRaw(raw);
  const doc = schema.nodeFromJSON(raw);
  validate(doc);
  return doc;
}

function validate(doc: PmNode): void {
  const schema = doc.type.schema;
  if (Object.keys(schema.nodes).some((name) => !["doc", "paragraph", "text", "endnote", "figure", "scene_break"].includes(name))
    || Object.keys(schema.marks).sort().join() !== "em,strong,underline") throw new Error("Unsupported review schema");
  doc.check();
  const raw: unknown = doc.toJSON();
  validateRaw(raw);
  doc.descendants((node) => {
    if (["endnote", "figure", "scene_break"].includes(node.type.name) && (!node.isLeaf || node.nodeSize !== 1)) {
      throw new Error("Review atoms must have width one");
    }
  });
  if (encoder.encode(JSON.stringify(raw)).length > MAX_BYTES) throw new Error("Review document exceeds limit");
}

function atomToken(node: PmNode): FragmentToken {
  return { kind: "atom", node: node.toJSON() as ReviewAtom };
}

function fragment(doc: PmNode, from: number, to: number): FragmentToken[] {
  const result: FragmentToken[] = [];
  if (from === to) return result;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "paragraph") {
      if (pos >= from) result.push({ kind: "open" });
      node.forEach((child, offset) => {
        const start = pos + 1 + offset;
        if (start >= to || start + child.nodeSize <= from) return;
        if (!child.isText) result.push(atomToken(child));
        else {
          const value = child.text!.slice(Math.max(0, from - start), Math.min(child.nodeSize, to - start));
          const marks = child.marks.map((mark) => mark.type.name as ReviewMark).sort();
          if (value) result.push({ kind: "text", text: value, ...(marks.length ? { marks } : {}) });
        }
      });
      if (pos + node.nodeSize - 1 < to) result.push({ kind: "close" });
    } else result.push(atomToken(node));
    return false;
  });
  return result;
}

/** One enclosing proposal; UTF-16 text, paragraph edges and whole atoms retain positions. */
export function proposalBetween(before: PmNode, after: PmNode): ReviewHunk | null {
  validate(before);
  validate(after);
  if (before.type.schema !== after.type.schema) throw new Error("Review schemas differ");
  const from = before.content.findDiffStart(after.content);
  if (from === null) return null;
  const end = before.content.findDiffEnd(after.content)!;
  // Repeated text can make the independently found prefix and suffix overlap.
  const overlap = Math.max(0, from - Math.min(end.a, end.b));
  const to = end.a + overlap;
  return { from, to, before: fragment(before, from, to), after: fragment(after, from, end.b + overlap) };
}
