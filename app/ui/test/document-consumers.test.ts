import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { DOMSerializer, Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { bodyText, countWordsIn, createEditor, plaintextLabels, readableBody, schema, toggleMark } from "../src/editor";
import { documentFields, plaintext, positionalText } from "../src/document-projections";
import { diffDocumentFields } from "../src/document-diff";
import { remintClipboard, validateClipboardHtml } from "../src/document-clipboard";
import { locateFieldMatches, locateMatches } from "../src/find-locate";
import { planReplacements } from "../src/replace";
import { matchesInDoc } from "../src/cast-marks";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

interface Fixture { id: string; body: object; assets: string[] }
const corpus = JSON.parse(readFileSync(new URL("../../harness/fixtures/document-format.json", import.meta.url), "utf8")) as Fixture[];
const mixed = schema.nodeFromJSON(corpus.find(fixture => fixture.id === "mixed")!.body);
const note = mixed.child(0).child(1);
const figure = mixed.child(1);
const atomDoc = () => schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("😀be"), note, schema.text("witched tail")]),
  figure, schema.node("scene_break"), schema.node("paragraph", null, schema.text("Next")),
]);
const id = (n: number) => `0199ed16-8c00-7000-8000-${String(n).padStart(12, "0")}`;

test("prose counts ignore references, attributes and zero-word block atoms", () => {
  const doc = atomDoc();
  expect(bodyText(JSON.stringify(doc))).toBe("😀bewitched tail Next");
  expect(countWordsIn(doc)).toBe(3);
  expect(countWordsIn(schema.node("doc", null, [figure, schema.node("scene_break")]))).toBe(0);
  expect(documentFields(doc).map(field => field.field)).toEqual(["prose", "note", "prose", "caption", "alt", "prose"]);
});

test("search keeps fields and atoms separate with exact UTF-16 locators", () => {
  const doc = atomDoc();
  expect(locateMatches(doc, "bewitched")).toEqual([]);
  expect(locateMatches(doc, "tail Next")).toEqual([]);
  expect(locateMatches(doc, "witched")).toEqual([{ from: 6, to: 13 }]);
  const source = locateFieldMatches(doc, "source")[0]!;
  expect(source.locator).toEqual({ instance_id: note.attrs.id, field: "note", from: 2, to: 8 });
  expect(locateFieldMatches(doc, "Figure").map(match => match.locator.field)).toEqual(["caption", "alt"]);
  expect(planReplacements(doc, "source").replacements).toEqual([]);
  expect(planReplacements(doc, "caption").replacements).toEqual([]);
  expect(matchesInDoc(doc, [{ text: "witched", memberId: "cast" }])).toEqual([{ from: 6, to: 13, memberId: "cast" }]);
  expect(matchesInDoc(doc, [{ text: "bewitched", memberId: "cast" }])).toEqual([]);
});

test("history compares note, caption and alt independently even with identical prose", () => {
  const before = atomDoc();
  const changed = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("😀be"), note.type.create({ ...note.attrs, body: "Changed source" }), schema.text("witched tail")]),
    figure.type.create({ ...figure.attrs, caption: "Changed caption", alt: "Changed description" }),
    schema.node("scene_break"), schema.node("paragraph", null, schema.text("Next")),
  ]);
  const fields = diffDocumentFields(JSON.stringify(before), JSON.stringify(changed));
  expect(fields.filter(field => field.added || field.removed).map(field => field.field)).toEqual(["note", "caption", "alt"]);
  for (const field of fields.filter(field => field.field !== "prose")) expect(field.pieces.some(piece => piece.op === "added")).toBe(true);
});

test("plaintext recovery preserves complete fields and labels losses", () => {
  expect(plaintext(atomDoc().content, plaintextLabels())).toBe(
    "😀be[1]witched tail\n\n[Figure original not included]\nCaption: Figure caption\nAlternative text: Figure description\n\n* * *\n\nNext\n\nEndnotes\n[1] A source.\nSecond line: café 😀.\n\nPlain text copy: formatting, structure, and figure originals are not included.",
  );
});

test("clipboard remints each instance, preserves shared assets, and rejects duplicate or unavailable IDs", () => {
  const slice = new Slice(atomDoc().content, 0, 0);
  let next = 10;
  const copied = remintClipboard(slice, () => id(next++), new Set([figure.attrs.asset_id as string]));
  expect(copied.content.child(0).child(1).attrs).toEqual({ ...note.attrs, id: id(10) });
  expect(copied.content.child(1).attrs).toEqual({ ...figure.attrs, id: id(11) });
  expect(() => remintClipboard(slice, () => id(10))).toThrow("asset unavailable");
  const duplicate = new Slice(Fragment.from(schema.node("paragraph", null, [note, note])), 0, 0);
  expect(() => remintClipboard(duplicate, () => id(next++))).toThrow("duplicate");
  expect(() => remintClipboard(slice, () => id(10), new Set([figure.attrs.asset_id as string]))).toThrow("collision");
  expect(() => validateClipboardHtml('<sup data-garret-endnote=\'{"id":"bad","fmt":"html","body":"lost"}\'>lost</sup>')).toThrow();
});

test("formatting and comment ranges preserve whole atoms beside astral characters", () => {
  const doc = atomDoc();
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 13) });
  toggleMark(schema.marks.strong)(state, tr => { state = state.apply(tr); });
  expect(state.doc.child(0).child(1).marks).toEqual([]);
  expect(state.doc.child(0).child(0).marks.map(mark => mark.type.name)).toEqual(["strong"]);
  expect(positionalText(doc, 1, 13)).toBe("😀be\ufffcwitched");
  const mount = document.createElement("div"); document.body.append(mount);
  const editor = createEditor(mount, { kind: "pmjson", json: readableBody(JSON.stringify(doc))! });
  try {
    editor.setCommentAnchors([{ id: 1, from: 1, to: 13, resolved: false }]);
    editor.restoreSelection(6, 6); editor.typeChar("😀");
    expect(editor.commentAnchors()).toEqual([{ id: 1, from: 1, to: 15, resolved: false }]);
    expect(editor.textIn(1, 15)).toBe("😀be\ufffc😀witched");
    editor.selectRange(1, 8);
    expect(editor.wordAtCaret()).toBeNull();
    expect(editor.revealMatch("source", locateFieldMatches(doc, "source")[0]!.locator)).toBe(true);
    expect(editor.selection()).toEqual({ from: 5, to: 6 });
  } finally { editor.destroy(); mount.remove(); }
});


test("editor paste remints note IDs and refuses malformed or duplicate atom HTML", () => {
  const mount = document.createElement("div"); document.body.append(mount);
  let refused = 0;
  const editor = createEditor(mount, { kind: "pmjson", json: readableBody(JSON.stringify(atomDoc()))! }, { onClipboardRefused: () => refused++ });
  const html = document.createElement("div");
  html.append(DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(schema.node("paragraph", null, note))));
  const paste = (value: string): void => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/html" ? value : "", files: [] } });
    mount.querySelector(".ProseMirror")!.dispatchEvent(event);
  };
  try {
    paste(html.innerHTML);
    const doc = schema.nodeFromJSON(JSON.parse(editor.serialize()));
    const notes: string[] = [];
    doc.descendants(node => { if (node.type.name === "endnote") notes.push(node.attrs.id as string); });
    expect(notes.length).toBe(2);
    expect(new Set(notes).size).toBe(2);
    expect(notes).toContain(note.attrs.id as string);
    const before = editor.serialize();
    paste(html.innerHTML + html.innerHTML);
    expect(editor.serialize()).toBe(before);
    paste(`<sup data-garret-endnote='{"id":"bad","fmt":"html","body":"lost"}'>lost</sup>`);
    expect(editor.serialize()).toBe(before);
    expect(refused).toBe(2);
  } finally { editor.destroy(); mount.remove(); }
});
