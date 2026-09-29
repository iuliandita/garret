import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { Node as PmNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { schema } from "../src/editor";

type Mark = "em" | "strong" | "underline";
type Token = { kind: "open" | "close" } | { kind: "text"; text: string; marks?: Mark[] };
type Operation =
  | { kind: "insert_text"; text: string }
  | { kind: "delete" }
  | { kind: "add_mark"; mark: Mark }
  | { kind: "replace_marked_text"; text: string; mark: Mark }
  | { kind: "split" }
  | { kind: "join"; at: number }
  | { kind: "insert_paragraph"; text: string };
type Case = {
  id: string;
  body: Record<string, unknown>;
  hunk: { from: number; to: number; before: Token[]; after: Token[] };
  expected: Record<string, unknown> | null;
  pm?: Operation;
};

const cases = JSON.parse(readFileSync(new URL("../../harness/fixtures/review-documents.json", import.meta.url), "utf8")) as Case[];

function flat(doc: PmNode): Token[] {
  const tokens: Token[] = [];
  doc.forEach((paragraph) => {
    tokens.push({ kind: "open" });
    paragraph.forEach((node) => {
      const marks = node.marks.map((mark) => mark.type.name as Mark);
      const last = tokens.at(-1);
      if (last?.kind === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) {
        last.text += node.text ?? "";
      } else {
        tokens.push({ kind: "text", text: node.text ?? "", ...(marks.length ? { marks } : {}) });
      }
    });
    tokens.push({ kind: "close" });
  });
  return tokens;
}

function cut(tokens: Token[], at: number): [Token[], Token[]] {
  const left: Token[] = [];
  const right: Token[] = [];
  let position = 0;
  for (const token of tokens) {
    const width = token.kind === "text" ? token.text.length : 1;
    if (at <= position) right.push(token);
    else if (at >= position + width) left.push(token);
    else {
      if (token.kind !== "text") throw new Error("split boundary");
      const prefix = token.text.slice(0, at - position);
      const suffix = token.text.slice(at - position);
      if (/[\ud800-\udbff]$/.test(prefix)) {
        throw new Error("surrogate split");
      }
      left.push({ ...token, text: prefix });
      right.push({ ...token, text: suffix });
    }
    position += width;
  }
  if (at > position) throw new Error("past document");
  return [left, right];
}

function merge(tokens: Token[]): Token[] {
  const result: Token[] = [];
  for (const token of tokens) {
    const last = result.at(-1);
    if (last?.kind === "text" && token.kind === "text"
      && JSON.stringify(last.marks ?? []) === JSON.stringify(token.marks ?? [])) {
      last.text += token.text;
    } else result.push({ ...token });
  }
  return result;
}

describe("review document shared contract", () => {
  for (const fixture of cases.filter((entry) => entry.pm)) {
    test(fixture.id, () => {
      const { from, to, before, after } = fixture.hunk;
      const doc = schema.nodeFromJSON(fixture.body);
      const operation = fixture.pm!;
      const tr = EditorState.create({ doc }).tr;
      expect(doc.slice(from, to).size).toBe(to - from);
      switch (operation.kind) {
        case "insert_text": tr.insertText(operation.text, from, to); break;
        case "delete": tr.delete(from, to); break;
        case "add_mark": tr.addMark(from, to, schema.marks[operation.mark].create()); break;
        case "replace_marked_text":
          tr.replaceWith(from, to, schema.text(operation.text, [schema.marks[operation.mark].create()]));
          break;
        case "split": tr.split(from); break;
        case "join": tr.join(operation.at); break;
        case "insert_paragraph":
          tr.insert(from, schema.nodes.paragraph.create(null, schema.text(operation.text)));
          break;
      }
      expect(tr.doc.toJSON()).toEqual(fixture.expected);
      const [left, rest] = cut(flat(doc), from);
      const [actual, right] = cut(rest, to - from);
      expect(merge(actual)).toEqual(before);
      expect(merge([...left, ...after, ...right])).toEqual(flat(tr.doc));
    });
  }
});
