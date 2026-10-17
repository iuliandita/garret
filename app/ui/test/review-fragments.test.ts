import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Schema, type Node as PmNode, type NodeSpec, type MarkSpec } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { schema } from "../src/editor";
import { parseReviewBody, proposalBetween, type FragmentToken, type ReviewHunk, type ReviewAtom } from "../src/review-fragments";

const doc = (...paragraphs: string[]): PmNode => schema.node("doc", null,
  paragraphs.map((text) => schema.node("paragraph", null, text ? schema.text(text) : undefined)));
const text = (value: string): FragmentToken => ({ kind: "text", text: value });

// Independent wire replay through character units is confined to tiny fixtures.
function units(document: PmNode): FragmentToken[] {
  const out: FragmentToken[] = [];
  document.forEach((p) => {
    if (p.type.name !== "paragraph") { out.push({ kind: "atom", node: p.toJSON() as ReviewAtom }); return; }
    out.push({ kind: "open" });
    p.forEach((n) => {
      if (!n.isText) { out.push({ kind: "atom", node: n.toJSON() as ReviewAtom }); return; }
      const marks = n.marks.map((m) => m.type.name).sort();
      for (let i = 0; i < n.text!.length; i++) {
        out.push({ kind: "text", text: n.text![i], ...(marks.length ? { marks: marks as ("em" | "strong" | "underline")[] } : {}) });
      }
    });
    out.push({ kind: "close" });
  });
  return out;
}
function expand(tokens: FragmentToken[]): FragmentToken[] {
  return tokens.flatMap<FragmentToken>((token) => token.kind === "text"
    ? token.text.split("").map((ch) => ({ ...token, text: ch })) : [token]);
}
function verify(before: PmNode, after: PmNode): ReviewHunk {
  const saved = JSON.stringify(before.toJSON());
  const draft = JSON.stringify(after.toJSON());
  const hunk = proposalBetween(before, after)!;
  expect(hunk).not.toBeNull();
  const original = units(before);
  expect(expand(hunk.before)).toEqual(original.slice(hunk.from, hunk.to));
  expect([...original.slice(0, hunk.from), ...expand(hunk.after), ...original.slice(hunk.to)]).toEqual(units(after));
  for (const token of [...hunk.before, ...hunk.after]) {
    if (token.kind === "text") expect(new TextDecoder().decode(new TextEncoder().encode(token.text))).toBe(token.text);
  }
  expect(JSON.stringify(before.toJSON())).toBe(saved);
  expect(JSON.stringify(after.toJSON())).toBe(draft);
  return hunk;
}

describe("proposalBetween", () => {
  test("minimal insertion, deletion, repeated content and no-op", () => {
    const before = doc("abc");
    expect(verify(before, EditorState.create({ doc: before }).tr.insertText("X", 2).doc))
      .toEqual({ from: 2, to: 2, before: [], after: [text("X")] });
    expect(verify(before, EditorState.create({ doc: before }).tr.delete(2, 3).doc))
      .toEqual({ from: 2, to: 3, before: [text("b")], after: [] });
    verify(doc("aaaa"), doc("aaaaa"));
    verify(doc("😀😀"), doc("😀😀😀"));
    expect(proposalBetween(before, schema.nodeFromJSON(before.toJSON()))).toBeNull();
  });

  test("emoji sharing a high or low surrogate stay whole", () => {
    expect(verify(doc("a😀z"), doc("a😁z")))
      .toEqual({ from: 2, to: 4, before: [text("😀")], after: [text("😁")] });
    verify(doc("a😀z"), doc("a🨀z"));
  });

  test("formatting retains all supported marks", () => {
    const before = doc("abcdef");
    const tr = EditorState.create({ doc: before }).tr;
    for (const name of ["strong", "underline", "em"]) tr.addMark(2, 5, schema.marks[name].create());
    expect(verify(before, tr.doc)).toEqual({ from: 2, to: 5, before: [text("bcd")],
      after: [{ kind: "text", text: "bcd", marks: ["em", "strong", "underline"] }] });
  });

  test("paragraph split, merge and empty paragraphs retain exact edges", () => {
    const before = doc("abcd");
    const split = EditorState.create({ doc: before }).tr.split(3).doc;
    expect(verify(before, split)).toEqual({ from: 3, to: 3, before: [], after: [{ kind: "close" }, { kind: "open" }] });
    verify(split, EditorState.create({ doc: split }).tr.join(4).doc);
    verify(doc("", ""), doc(""));
    verify(doc(""), doc("", ""));
    verify(doc("", "x", ""), doc("", "y", ""));
  });

  test("disjoint transactions produce one enclosing hunk", () => {
    const before = doc("abcdefgh");
    const after = EditorState.create({ doc: before }).tr.insertText("G", 7, 8).insertText("B", 2, 3).doc;
    expect(verify(before, after)).toEqual({ from: 2, to: 8, before: [text("bcdefg")], after: [text("BcdefG")] });
  });

  const fixtures = JSON.parse(readFileSync(new URL("../../harness/fixtures/review-documents.json", import.meta.url), "utf8")) as {
    id: string; body: Record<string, unknown>; expected: Record<string, unknown> | null;
  }[];
  for (const fixture of fixtures.filter((entry) => entry.expected)) {
    test(`shared host fixture: ${fixture.id}`, () => {
      const before = parseReviewBody(JSON.stringify(fixture.body), schema);
      const after = parseReviewBody(JSON.stringify(fixture.expected), schema);
      if (before.eq(after)) expect(proposalBetween(before, after)).toBeNull();
      else verify(before, after);
    });
  }

  test("unsupported nodes, attributes, marks and ill-formed text refuse", () => {
    const extras: { nodes?: Record<string, NodeSpec>; marks?: Record<string, MarkSpec> }[] = [
      { nodes: { heading: { content: "text*" } } },
      { marks: { code: {} } },
    ];
    for (const extra of extras) {
      const foreign = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {}, ...extra.nodes },
        marks: { em: {}, strong: {}, underline: {}, ...extra.marks } });
      const node = foreign.node("doc", null, foreign.node("paragraph"));
      expect(() => proposalBetween(node, node)).toThrow();
    }
    const attrs = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", attrs: { secret: { default: "x" } } }, text: {} }, marks: { em: {}, strong: {}, underline: {} } });
    const node = attrs.node("doc", null, attrs.node("paragraph"));
    expect(() => proposalBetween(node, node)).toThrow();
    expect(() => proposalBetween(doc("\ud800"), doc("x"))).toThrow();
    expect(() => proposalBetween(schema.node("doc"), doc(""))).toThrow();
  });

  test("large text uses run fragments and host size bounds", () => {
    const before = doc("x".repeat(200_000));
    const hunk = proposalBetween(before, EditorState.create({ doc: before }).tr.insertText("y", 100_001).doc)!;
    expect(hunk.after).toEqual([text("y")]);
    expect(hunk.before).toEqual([]);
    const oversized = doc("x".repeat(16 * 1024 * 1024));
    expect(() => proposalBetween(oversized, oversized)).toThrow();
  });
});

describe("parseReviewBody", () => {
  const wrap = (node: unknown): unknown => ({ type: "doc", content: [{ type: "paragraph", content: [node] }] });
  test("rejects properties that ProseMirror silently discards", () => {
    const base = doc("x").toJSON();
    for (const raw of [
      { ...base, secret: "lost" },
      { ...base, accepted_body: {} },
      { ...base, from: 1, to: 2, before: [], after: [] },
      { type: "doc", content: [{ type: "paragraph", attrs: { align: "right" }, content: [{ type: "text", text: "x" }] }] },
      wrap({ type: "text", text: "x", hidden: "lost" }),
      wrap({ type: "text", text: "x", marks: [{ type: "em", attrs: { secret: "lost" } }] }),
      wrap({ type: "text", text: "x", marks: [{ type: "em", extra: true }] }),
    ]) {
      expect(() => schema.nodeFromJSON(raw)).not.toThrow();
      expect(() => parseReviewBody(JSON.stringify(raw), schema)).toThrow();
    }
  });
  test("valid optional empty content and marks parse faithfully", () => {
    for (const paragraph of [{ type: "paragraph" }, { type: "paragraph", content: [] },
      { type: "paragraph", content: [{ type: "text", text: "😀", marks: [] }] },
      { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "underline" }, { type: "em" }] }] }]) {
      const raw = { type: "doc", content: [paragraph] };
      expect(parseReviewBody(JSON.stringify(raw), schema).eq(schema.nodeFromJSON(raw))).toBe(true);
    }
  });
  test("malformed shapes, duplicate marks and invalid Unicode refuse", () => {
    for (const raw of [null, [], { type: "doc" }, { type: "doc", content: [] },
      { type: "doc", content: [{ type: "paragraph", content: null }] },
      wrap({ type: "text", text: 7 }), wrap({ type: "text", text: "" }),
      wrap({ type: "text", text: "\ud800" }), wrap({ type: "text", text: "\udc00" }),
      wrap({ type: "text", text: "x", marks: null }),
      wrap({ type: "text", text: "x", marks: [{ type: "em" }, { type: "em" }] }),
      wrap({ type: "text", text: "x", marks: [{ type: "code" }] }),
      wrap({ type: "heading", text: "x" }),
    ]) expect(() => parseReviewBody(JSON.stringify(raw), schema)).toThrow();
  });
  test("raw bounds run before JSON parsing, including UTF-8 byte width", () => {
    expect(() => parseReviewBody("!".repeat(16 * 1024 * 1024 + 1), schema)).toThrow("exceeds limit");
    expect(() => parseReviewBody("界".repeat(6 * 1024 * 1024), schema)).toThrow("exceeds limit");
    expect(() => parseReviewBody("{", schema)).toThrow(SyntaxError);
  });
});

// A fixture schema exercises the reader without enabling document authoring.
const atomSchema = new Schema({ nodes: {
  doc: { content: "(paragraph|figure|scene_break)+" },
  paragraph: { content: "(text|endnote)*" }, text: {},
  endnote: { inline: true, atom: true, marks: "", attrs: { id: {}, fmt: {}, body: {} } },
  figure: { atom: true, marks: "", attrs: { id: {}, asset_id: {}, width: {}, caption: {}, alt: {} } },
  scene_break: { atom: true, marks: "" },
}, marks: schema.spec.marks });
const note: ReviewAtom = { type: "endnote", attrs: { id: "11111111-1111-4111-8111-111111111111", fmt: "text", body: "note 😀\n<script>" } };
const figure: ReviewAtom = { type: "figure", attrs: { id: "22222222-2222-4222-8222-222222222222",
  asset_id: "33333333-3333-4333-8333-333333333333", width: "full", caption: "caption", alt: "alt" } };
const atomBody = (n: unknown = note, f: unknown = figure) => ({ type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "😀" }, n, { type: "text", text: "🦊" }] }, f,
  { type: "scene_break" }, { type: "paragraph", content: [{ type: "text", text: "tail" }] },
] });

test("whole atom proposals preserve every attribute and one UTF-16 position beside astral text", () => {
  const before = parseReviewBody(JSON.stringify(atomBody()), atomSchema);
  expect(before.content.size).toBe(15);
  expect(proposalBetween(before, before)).toBeNull();
  for (const [which, field, value] of [
    ["note", "body", "changed 🦊"], ["note", "id", "44444444-4444-4444-8444-444444444444"],
    ["figure", "id", "44444444-4444-4444-8444-444444444444"],
    ["figure", "asset_id", "55555555-5555-4555-8555-555555555555"],
    ["figure", "width", "half"], ["figure", "caption", "new caption"], ["figure", "alt", "new alt"],
  ]) {
    const old = which === "note" ? note : figure;
    const next = { ...old, attrs: { ...old.attrs, [field]: value } } as ReviewAtom;
    const after = parseReviewBody(JSON.stringify(which === "note" ? atomBody(next) : atomBody(note, next)), atomSchema);
    expect(verify(before, after)).toEqual({ from: which === "note" ? 3 : 7, to: which === "note" ? 4 : 8,
      before: [{ kind: "atom", node: old }], after: [{ kind: "atom", node: next }] });
  }
  for (const [from, to] of [[3, 4], [7, 8], [8, 9], [1, 10]]) {
    const after = EditorState.create({ doc: before }).tr.delete(from, to).doc;
    verify(before, after); verify(after, before);
  }
});

test("strict review atom reader rejects lossy attributes, formats, IDs, marks and placements", () => {
  for (const n of [
    { ...note, content: [] }, { ...note, marks: [{ type: "em" }] },
    { ...note, attrs: { ...note.attrs, extra: "lost" } },
    { ...note, attrs: { ...note.attrs, fmt: "html" } },
    { ...note, attrs: { ...note.attrs, body: "\ud800" } },
    { ...note, attrs: { ...note.attrs, body: "界".repeat(22_000) } },
    { ...note, attrs: { ...note.attrs, id: "not-an-id" } }, figure,
  ]) expect(() => parseReviewBody(JSON.stringify(atomBody(n)), atomSchema)).toThrow();
  for (const f of [note, { type: "scene_break", attrs: {} },
    { ...figure, attrs: { ...figure.attrs, id: note.attrs.id } },
    { ...figure, attrs: { ...figure.attrs, width: ["full"] } },
    { ...figure, attrs: { ...figure.attrs, asset_id: "missing" } },
    { ...figure, attrs: { ...figure.attrs, alt: undefined } },
  ]) expect(() => parseReviewBody(JSON.stringify(atomBody(note, f)), atomSchema)).toThrow();
});
