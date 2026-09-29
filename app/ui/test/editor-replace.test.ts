import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createEditor, type DocInput, type Editor, type PmNodeJson } from "../src/editor";

// A REAL EditorView, deliberately. `replaceMatch` and `replaceAll` are the two
// places in this slice where a plan becomes a transaction, and everything worth
// asserting about them -- that back-to-front application lands the right text,
// that replace-all is ONE undoable step, that the next selection is computed in
// the document the replacement produced -- is a property of the transaction and
// not of the planner. `editor-onchange.test.ts` established that an EditorView
// constructs under happy-dom; the planners themselves are tested without one in
// `replace.test.ts`.

/** The JSON shape the editor serializes to, including marks -- which
 *  `PmNodeJson` deliberately does not model, because nothing in the application
 *  builds a marked document by hand. A test does. */
interface DocJson {
  type: string;
  text?: string;
  marks?: { type: string }[];
  content?: DocJson[];
}

const live: Editor[] = [];

/** An editor over one paragraph per string, plus the count of onChange calls it
 *  has made. The count is how "one transaction" is asserted: a loop of
 *  dispatches fires onChange once per occurrence whatever the undo history
 *  chooses to group. */
function open(texts: string[]): { editor: Editor; changes: () => number } {
  let changes = 0;
  const input: DocInput = {
    kind: "blocks",
    blocks: texts.map((text) => ({ type: "paragraph", text })),
  };
  const editor = createEditor(document.createElement("div"), input, {
    onChange: () => changes++,
  });
  live.push(editor);
  return { editor, changes: () => changes };
}

/** An editor over a document built as ProseMirror JSON, so a run can carry a
 *  mark. Cast because `PmNodeJson` has no `marks` field; `docJsonFrom` hands the
 *  object straight to `schema.nodeFromJSON`, which does. */
function openJson(doc: DocJson): { editor: Editor; changes: () => number } {
  let changes = 0;
  const editor = createEditor(
    document.createElement("div"),
    { kind: "pmjson", json: doc as unknown as PmNodeJson },
    { onChange: () => changes++ },
  );
  live.push(editor);
  return { editor, changes: () => changes };
}

const text = (value: string): DocJson => ({ type: "text", text: value });
const em = (value: string): DocJson => ({
  type: "text",
  text: value,
  marks: [{ type: "em" }],
});

/** The paragraphs of the open document, as plain strings. */
function paragraphs(editor: Editor): string[] {
  const doc = JSON.parse(editor.serialize()) as DocJson;
  return (doc.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? "").join(""));
}

/** The inline runs of paragraph `index`, with their mark names. Adjacent runs
 *  carrying the same marks are merged by ProseMirror, so this is exactly the
 *  shape a mark change shows up in. */
function runs(editor: Editor, index: number): { text: string; marks: string[] }[] {
  const doc = JSON.parse(editor.serialize()) as DocJson;
  const para = (doc.content ?? [])[index];
  return (para?.content ?? []).map((run) => ({
    text: run.text ?? "",
    marks: (run.marks ?? []).map((mark) => mark.type),
  }));
}

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy();
});

describe("replaceAll", () => {
  test("replaces every occurrence and returns how many", () => {
    const { editor } = open(["cat cat cat", "a cat here"]);

    expect(editor.replaceAll("cat", "dog").replaced).toBe(4);
    expect(paragraphs(editor)).toEqual(["dog dog dog", "a dog here"]);
  });

  test("is ONE transaction: a single undo restores the document exactly", () => {
    // THE LOAD-BEARING CLAIM OF THE SLICE. A writer who replaces forty
    // occurrences and regrets it must not press undo forty times, and must not
    // be able to stop half way through by accident -- which is a manuscript in
    // a state they never wrote and cannot describe.
    //
    // Asserted through the onChange COUNT as well as through undo, because
    // prosemirror-history groups transactions that arrive close together and
    // touch adjacent positions: a per-occurrence dispatch loop can therefore be
    // reversed by one undo anyway, and an undo-only assertion would pass
    // against exactly the implementation this test exists to refuse. onChange
    // fires once per document-changing transaction and cannot be grouped.
    const { editor, changes } = open(["cat one cat two cat three cat"]);
    const before = editor.serialize();

    expect(editor.replaceAll("cat", "dog").replaced).toBe(4);
    expect(changes()).toBe(1);

    editor.undo();

    expect(editor.serialize()).toBe(before);
    expect(paragraphs(editor)).toEqual(["cat one cat two cat three cat"]);
  });

  test("a redo after that single undo brings the whole replacement back", () => {
    // The other half of "one step". A replace-all reversed in one press and
    // restored in several would be the same defect seen from the other side.
    const { editor } = open(["cat one cat two cat"]);

    editor.replaceAll("cat", "dog");
    editor.undo();
    editor.redo();

    expect(paragraphs(editor)).toEqual(["dog one dog two dog"]);
  });

  test("applies BACK TO FRONT, so a longer replacement does not drift", () => {
    // The failure this is aimed at is silent and lands in the writer's prose.
    // Applied left to right against positions planned on the ORIGINAL document,
    // the first replacement shifts every later one by the length difference:
    // "cat cat cat" -> "kitten cat cat" leaves the second occurrence at 8, and a
    // replacement written at the planned 5 cuts through "en c" instead. The
    // resulting text is asserted exactly for that reason -- a count assertion
    // passes on the drifted document.
    const { editor } = open(["cat cat cat", "cat and cat"]);

    expect(editor.replaceAll("cat", "kitten").replaced).toBe(5);
    expect(paragraphs(editor)).toEqual(["kitten kitten kitten", "kitten and kitten"]);
  });

  test("a replacement SHORTER than the query lands correctly too", () => {
    // The other direction of the same drift, and it fails differently: a
    // left-to-right implementation overshoots backwards rather than forwards,
    // so a test using only a longer replacement covers one sign of the bug.
    const { editor } = open(["kitten kitten kitten"]);

    expect(editor.replaceAll("kitten", "cat").replaced).toBe(3);
    expect(paragraphs(editor)).toEqual(["cat cat cat"]);
  });

  test("an EMPTY replacement deletes every occurrence", () => {
    const { editor, changes } = open(["cat cat cat", "the cat sat"]);

    expect(editor.replaceAll("cat", "").replaced).toBe(4);
    expect(paragraphs(editor)).toEqual(["  ", "the  sat"]);
    // Still one transaction, and still a document change: the deletion has to
    // reach the flush scheduler like any other edit.
    expect(changes()).toBe(1);
  });

  test("an empty replacement leaves no stray empty text node", () => {
    // `replaceWith(from, to, [])` rather than `schema.text("")`, which
    // ProseMirror rejects. The visible symptom of getting this wrong is a throw
    // during the writer's replace-all; the assertion is on the serialized
    // shape, which is what the store would hold.
    const { editor } = open(["a cat b"]);

    editor.replaceAll("cat", "");

    expect(runs(editor, 0)).toEqual([{ text: "a  b", marks: [] }]);
  });

  test("matches occurrences in any case, and inserts the replacement AS TYPED", () => {
    // Case-insensitive matching with no case matching on the way back in. A
    // replacement that "restored" the case of what it replaced would be a
    // second rule the writer never asked for, and would make the field's
    // contents a lie about what is going into the manuscript.
    const { editor } = open(["Cat cat CAT cAt"]);

    expect(editor.replaceAll("cat", "dog").replaced).toBe(4);
    expect(paragraphs(editor)).toEqual(["dog dog dog dog"]);
  });

  test("a query in another case finds the occurrences too", () => {
    const { editor } = open(["cat CAT"]);

    expect(editor.replaceAll("CaT", "Dog").replaced).toBe(2);
    expect(paragraphs(editor)).toEqual(["Dog Dog"]);
  });

  test("a replacement inside a marked run carries the mark; one outside does not", () => {
    // The marks rule is `replace.ts`'s: a replacement inherits the marks at the
    // START of the match. "bewitched" with the whole word italicised puts the
    // match INSIDE the em text node, so the mark applies; the second occurrence
    // sits in plain prose and must not acquire one.
    //
    // A match starting exactly at the first character of a marked run is a
    // DIFFERENT case and is not this test's claim: `$pos.marks()` there reads
    // the node BEFORE the position, so such a replacement takes the preceding
    // run's marks. Asserted separately below rather than assumed either way.
    const { editor } = openJson({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [text("she was "), em("bewitched"), text(" then bewitched again")],
        },
      ],
    });

    expect(editor.replaceAll("witch", "sorcer").replaced).toBe(2);
    expect(runs(editor, 0)).toEqual([
      { text: "she was ", marks: [] },
      { text: "besorcered", marks: ["em"] },
      { text: " then besorcered again", marks: [] },
    ]);
  });

  test("an emphasised word surrounded by plain prose KEEPS its emphasis", () => {
    // The case `marksAt` reads `from + 1` for. `ResolvedPos.marks()` reports the
    // marks that would apply to text INSERTED at a position, taken from the node
    // BEFORE it -- so resolving the match's own start reads the plain run the
    // match is LEAVING, and "say |witch| now" comes back unemphasised. The
    // writer's italics disappear, in their manuscript, with nothing saying so.
    const { editor } = openJson({
      type: "doc",
      content: [{ type: "paragraph", content: [text("say "), em("witch"), text(" now")] }],
    });

    expect(editor.replaceAll("witch", "sorcerer").replaced).toBe(1);
    expect(runs(editor, 0)).toEqual([
      { text: "say ", marks: [] },
      { text: "sorcerer", marks: ["em"] },
      { text: " now", marks: [] },
    ]);
  });

  test("a match that STARTS in plain prose and runs into an emphasised run takes no marks", () => {
    // The rule is the marks at the START of the match, and a match spanning a
    // boundary has no answer that is right for every case. This is the failing
    // direction of the test above: an implementation reading the marks at the
    // match's END, or the union of the two, would emphasise a replacement whose
    // first character was never emphasised.
    const { editor } = openJson({
      type: "doc",
      content: [{ type: "paragraph", content: [text("the wi"), em("tch came")] }],
    });

    expect(editor.replaceAll("witch", "sorcerer").replaced).toBe(1);
    expect(runs(editor, 0)).toEqual([
      { text: "the sorcerer", marks: [] },
      { text: " came", marks: ["em"] },
    ]);
  });

  test("a match at the start of a PARAGRAPH keeps the run's own marks", () => {
    // There is no node before the match here at all, so `from` and `from + 1`
    // would agree. Kept because it is the boundary of the rule, not because it
    // discriminates between the two readings.
    const { editor } = openJson({
      type: "doc",
      content: [{ type: "paragraph", content: [em("witch"), text(" and out")] }],
    });

    expect(editor.replaceAll("witch", "sorcerer").replaced).toBe(1);
    expect(runs(editor, 0)).toEqual([
      { text: "sorcerer", marks: ["em"] },
      { text: " and out", marks: [] },
    ]);
  });

  test("returns 0 and changes nothing when the query does not occur", () => {
    const { editor, changes } = open(["cat cat"]);
    const before = editor.serialize();

    expect(editor.replaceAll("zebra", "dog").replaced).toBe(0);
    expect(editor.serialize()).toBe(before);
    // Nothing dispatched: a transaction with no steps would still be a document
    // change to the flush scheduler and would put an undo entry in front of the
    // writer's last real edit.
    expect(changes()).toBe(0);
  });

  test("returns 0 and changes nothing for an empty query", () => {
    const { editor, changes } = open(["cat cat"]);
    const before = editor.serialize();

    expect(editor.replaceAll("", "dog").replaced).toBe(0);
    expect(editor.serialize()).toBe(before);
    expect(changes()).toBe(0);
  });

  test("a no-op replaceAll leaves the undo history alone", () => {
    // The failing direction of the two assertions above: a dispatch of an empty
    // transaction is invisible in the serialized document, and shows up only
    // when the writer presses undo and their previous sentence disappears
    // instead of the replacement they thought they made.
    const { editor } = open(["cat cat"]);
    editor.typeChar("X");
    const typed = editor.serialize();

    expect(editor.replaceAll("zebra", "dog").replaced).toBe(0);
    editor.undo();

    expect(editor.serialize()).not.toBe(typed);
    expect(paragraphs(editor)).toEqual(["cat cat"]);
  });

  test("counts non-overlapping occurrences, left to right", () => {
    // "aa" in "aaaa" is two replacements, not three. What the count means is
    // what the panel reports to the writer.
    const { editor } = open(["aaaa"]);

    expect(editor.replaceAll("aa", "b").replaced).toBe(2);
    expect(paragraphs(editor)).toEqual(["bb"]);
  });

});

describe("replaceMatch", () => {
  test("the first press selects a match and replaces nothing", () => {
    // The ordinary first press: the writer has typed a word and hit Replace,
    // and the caret is wherever they left it. "Replace" on a fresh panel means
    // "find one and replace it", so the answer is to select rather than to
    // report a failure -- and `false` is the honest report, because no text
    // changed.
    const { editor, changes } = open(["one cat two cat"]);
    const before = editor.serialize();

    expect(editor.replaceMatch("cat", "dog")).toBe(false);

    expect(editor.selection()).toEqual({ from: 5, to: 8 });
    expect(editor.serialize()).toBe(before);
    // Selection-only, so `tr.docChanged` is false. The standing rule that a
    // caret move must never mark the document dirty is enforced by ProseMirror
    // here rather than restated.
    expect(changes()).toBe(0);
  });

  test("the second press replaces what the first selected", () => {
    const { editor, changes } = open(["one cat two cat"]);

    expect(editor.replaceMatch("cat", "dog")).toBe(false);
    expect(editor.replaceMatch("cat", "dog")).toBe(true);

    expect(paragraphs(editor)).toEqual(["one dog two cat"]);
    expect(changes()).toBe(1);
  });

  test("after replacing, the NEXT occurrence is selected in the NEW document", () => {
    // The positions moved: the replacement is three characters longer than what
    // it replaced, so an implementation locating the next match in the document
    // it PLANNED against selects a span three characters to the left -- inside
    // the replacement it just wrote, and reading as a mis-aimed selection to the
    // writer rather than as an off-by-three.
    const { editor } = open(["cat cat cat"]);

    expect(editor.replaceMatch("cat", "kitten")).toBe(false);
    expect(editor.selection()).toEqual({ from: 1, to: 4 });

    expect(editor.replaceMatch("cat", "kitten")).toBe(true);

    expect(paragraphs(editor)).toEqual(["kitten cat cat"]);
    // "kitten cat cat": the second occurrence now begins at 8, not at 5.
    expect(editor.selection()).toEqual({ from: 8, to: 11 });
  });

  test("stepping through with a replacement that CONTAINS the query does not re-match itself", () => {
    // The next match is looked for after the END of what was just written, so a
    // replacement containing the query cannot select the text it just produced
    // -- which would leave Replace stuck on one word forever, growing it by one
    // replacement per press.
    const { editor } = open(["cat cat"]);

    editor.replaceMatch("cat", "catnip");
    editor.replaceMatch("cat", "catnip");

    expect(paragraphs(editor)).toEqual(["catnip cat"]);
    expect(editor.selection()).toEqual({ from: 8, to: 11 });
  });

  test("the search WRAPS to the top when nothing follows the replacement", () => {
    // A writer working down a scene and reaching the end has finished with the
    // part after their caret, not with the scene. Reachable here because the
    // replacement contains the query, so occurrences remain above the caret
    // after the last one below it has been dealt with.
    const { editor } = open(["cat cat"]);

    editor.replaceMatch("cat", "catnip");
    editor.replaceMatch("cat", "catnip");
    editor.replaceMatch("cat", "catnip");

    expect(paragraphs(editor)).toEqual(["catnip catnip"]);
    // Back to the first occurrence, which is inside the first replacement.
    expect(editor.selection()).toEqual({ from: 1, to: 4 });
  });

  test("replacing the only occurrence leaves the selection where the text went", () => {
    // Nothing to select next, and that must not throw or leave a selection
    // pointing past the end of a document that just got shorter.
    const { editor } = open(["one cat two"]);

    editor.replaceMatch("cat", "dog");
    expect(editor.replaceMatch("cat", "dog")).toBe(true);

    expect(paragraphs(editor)).toEqual(["one dog two"]);
    expect(() => editor.selection()).not.toThrow();
  });

  test("returns false and changes nothing when the document holds no occurrence", () => {
    // False with nothing selected is the "this scene has none" answer, and the
    // panel says something different about it than about a first press.
    const { editor, changes } = open(["one two three"]);
    const before = editor.serialize();

    expect(editor.replaceMatch("zebra", "dog")).toBe(false);

    expect(editor.serialize()).toBe(before);
    expect(changes()).toBe(0);
  });

  test("an empty query replaces nothing and moves nothing", () => {
    const { editor, changes } = open(["one cat two"]);
    const before = editor.selection();

    expect(editor.replaceMatch("", "dog")).toBe(false);

    expect(editor.selection()).toEqual(before);
    expect(changes()).toBe(0);
  });

  test("a selection that is not a match selects the next one rather than replacing it", () => {
    // The writer opened the panel, then clicked into their prose. The selection
    // means something else now, and replacing it would destroy text they never
    // asked about.
    const { editor } = open(["one cat two cat"]);
    editor.replaceMatch("cat", "dog");
    expect(editor.selection()).toEqual({ from: 5, to: 8 });

    // Move the caret off the match, the way a click would.
    editor.caretToParagraph(0);

    expect(editor.replaceMatch("cat", "dog")).toBe(false);
    expect(paragraphs(editor)).toEqual(["one cat two cat"]);
    // Wrapped forward from the end of the paragraph to the first occurrence.
    expect(editor.selection()).toEqual({ from: 5, to: 8 });
  });

  test("a replacement inside a marked run carries the mark", () => {
    const { editor } = openJson({
      type: "doc",
      content: [{ type: "paragraph", content: [text("she was "), em("bewitched")] }],
    });

    editor.replaceMatch("witch", "sorcer");
    expect(editor.replaceMatch("witch", "sorcer")).toBe(true);

    expect(runs(editor, 0)).toEqual([
      { text: "she was ", marks: [] },
      { text: "besorcered", marks: ["em"] },
    ]);
  });

  test("an empty replacement deletes the selected occurrence", () => {
    const { editor, changes } = open(["one cat two"]);

    editor.replaceMatch("cat", "");
    expect(editor.replaceMatch("cat", "")).toBe(true);

    expect(paragraphs(editor)).toEqual(["one  two"]);
    expect(changes()).toBe(1);
  });

  test("each replacement is its own undo step", () => {
    // Unlike replaceAll, and correctly so: the writer is stepping through
    // occurrences one press at a time, so one press is one thing to reverse.
    const { editor } = open(["cat cat"]);

    editor.replaceMatch("cat", "dog");
    editor.replaceMatch("cat", "dog");
    editor.replaceMatch("cat", "dog");
    expect(paragraphs(editor)).toEqual(["dog dog"]);

    editor.undo();

    expect(paragraphs(editor)).toEqual(["dog cat"]);
  });
});
