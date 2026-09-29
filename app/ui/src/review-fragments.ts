import type { Node as PmNode, Schema } from "prosemirror-model";

export type ReviewMark = "em" | "strong" | "underline";
export type FragmentToken =
  | { kind: "open" | "close" }
  | { kind: "text"; text: string; marks?: ReviewMark[] };
export interface ReviewHunk {
  from: number;
  to: number;
  before: FragmentToken[];
  after: FragmentToken[];
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOKENS = 100_000;
const encoder = new TextEncoder();

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Unsupported review property");
  }
  return value as Record<string, unknown>;
}

/** Validate the stored representation before ProseMirror can discard properties. */
export function parseReviewBody(body: string, schema: Schema): PmNode {
  if (body.length > MAX_BYTES || encoder.encode(body).length > MAX_BYTES) {
    throw new Error("Review document exceeds limit");
  }
  const root = object(JSON.parse(body) as unknown, ["type", "content"]);
  if (root.type !== "doc" || !Array.isArray(root.content) || !root.content.length) {
    throw new Error("Review document needs paragraphs");
  }
  let tokens = 0;
  for (const value of root.content) {
    const paragraph = object(value, ["type", "content"]);
    if (paragraph.type !== "paragraph"
      || ("content" in paragraph && !Array.isArray(paragraph.content))) {
      throw new Error("Unsupported review paragraph");
    }
    tokens += 2;
    if (tokens > MAX_TOKENS) throw new Error("Review document exceeds limit");
    for (const child of (paragraph.content ?? []) as unknown[]) {
      const node = object(child, ["type", "text", "marks"]);
      if (node.type !== "text" || typeof node.text !== "string" || !node.text
        || ("marks" in node && !Array.isArray(node.marks))) {
        throw new Error("Unsupported review text");
      }
      const names = new Set<string>();
      for (const entry of (node.marks ?? []) as unknown[]) {
        const mark = object(entry, ["type"]);
        if (typeof mark.type !== "string" || !["em", "strong", "underline"].includes(mark.type)
          || names.has(mark.type)) throw new Error("Unsupported review mark");
        names.add(mark.type);
      }
      if (++tokens > MAX_TOKENS) throw new Error("Review document exceeds limit");
    }
  }
  const doc = schema.nodeFromJSON(root);
  validate(doc);
  return doc;
}

function validate(doc: PmNode): void {
  const schema = doc.type.schema;
  if (Object.keys(schema.nodes).sort().join() !== "doc,paragraph,text"
    || Object.keys(schema.marks).sort().join() !== "em,strong,underline") {
    throw new Error("Unsupported review schema");
  }
  let tokens = 0;
  let bytes = 0;
  const check = (node: PmNode, kind: string): void => {
    if (node.type.name !== kind || Object.keys(node.attrs).length
      || (kind !== "text" && node.marks.length)) throw new Error("Unsupported review node");
  };
  check(doc, "doc");
  if (!doc.childCount) throw new Error("Review document needs paragraphs");
  doc.forEach((paragraph) => {
    check(paragraph, "paragraph");
    tokens += 2;
    paragraph.forEach((node) => {
      check(node, "text");
      const text = node.text;
      if (!text || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
        throw new Error("Invalid review text");
      }
      const names = new Set<string>();
      for (const mark of node.marks) {
        if (!["em", "strong", "underline"].includes(mark.type.name)
          || Object.keys(mark.attrs).length || names.has(mark.type.name)) {
          throw new Error("Unsupported review mark");
        }
        names.add(mark.type.name);
      }
      tokens++;
      bytes += encoder.encode(text).length;
      if (bytes > MAX_BYTES || tokens > MAX_TOKENS) throw new Error("Review document exceeds limit");
    });
    if (tokens > MAX_TOKENS) throw new Error("Review document exceeds limit");
  });
  // The host bounds serialized bodies, including JSON escaping and node overhead.
  if (encoder.encode(JSON.stringify(doc.toJSON())).length > MAX_BYTES) {
    throw new Error("Review document exceeds limit");
  }
}

function fragment(doc: PmNode, from: number, to: number): FragmentToken[] {
  const result: FragmentToken[] = [];
  if (from === to) return result;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "paragraph") {
      if (pos >= from) result.push({ kind: "open" });
      // nodesBetween visits a paragraph before its children, so append its
      // close after collecting the overlapping text directly.
      node.forEach((text, offset) => {
        const start = pos + 1 + offset;
        const value = text.text!.slice(Math.max(0, from - start), Math.min(text.nodeSize, to - start));
        if (start < to && start + text.nodeSize > from && value) {
          const marks = text.marks.map((mark) => mark.type.name as ReviewMark).sort();
          result.push({ kind: "text", text: value, ...(marks.length ? { marks } : {}) });
        }
      });
      if (pos + node.nodeSize - 1 < to) result.push({ kind: "close" });
    }
    return false;
  });
  return result;
}

/** One enclosing proposal; positions count UTF-16 units and paragraph edges.
 * Throws for unsupported or oversized drafts. It never changes either node.
 */
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
