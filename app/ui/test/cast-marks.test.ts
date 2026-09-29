// app/ui/test/cast-marks.test.ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "../src/editor";
import {
  CAST_MARK_CLASS,
  castNamesFor,
  castMarksKey,
  castMarksPlugin,
  matchesInDoc,
  matchesInText,
  type CastNamePair,
} from "../src/cast-marks";

function doc(text: string) {
  return schema.node("doc", null, [schema.node("paragraph", null, schema.text(text))]);
}

describe("castNamesFor", () => {
  test("keeps full names and adds real first and last name parts", () => {
    const names = castNamesFor([
      { id: "marisol", name: "Marisol Quillfeather", aliases: [] },
    ]);
    expect(matchesInText("Marisol Quillfeather met Marisol and Quillfeather.", names)).toEqual([
      { from: 0, to: 20, memberId: "marisol" },
      { from: 25, to: 32, memberId: "marisol" },
      { from: 37, to: 49, memberId: "marisol" },
    ]);
  });

  test("drops shared inferred first names and surnames", () => {
    const names = castNamesFor([
      { id: "ada-venn", name: "Ada Venn", aliases: [] },
      { id: "ada-quill", name: "Ada Quill", aliases: [] },
      { id: "iris-venn", name: "Iris Venn", aliases: [] },
    ]);
    expect(names).toEqual([
      { text: "Ada Venn", memberId: "ada-venn" },
      { text: "Ada Quill", memberId: "ada-quill" },
      { text: "Iris Venn", memberId: "iris-venn" },
      { text: "Quill", memberId: "ada-quill" },
      { text: "Iris", memberId: "iris-venn" },
    ]);
  });

  test("an explicit alias wins over inferred and one-token canonical names, while shared aliases keep the id tie rule", () => {
    const names = castNamesFor([
      { id: "a", name: "Kell", aliases: [] },
      { id: "b", name: "Kell Baker", aliases: [] },
      { id: "c", name: "Tessa Vale", aliases: ["Kell", "Guide"] },
      { id: "a-guide", name: "Ari Nox", aliases: ["Guide"] },
    ]);
    expect(names.filter((name) => name.text === "Kell")).toEqual([
      { text: "Kell", memberId: "c" },
    ]);
    expect(matchesInText("Guide arrived.", names)).toEqual([
      { from: 0, to: 5, memberId: "a-guide" },
    ]);
  });

  test("an explicit alias wins even when one other member uniquely owns the inferred token", () => {
    const names = castNamesFor([
      { id: "a-baker", name: "Kell Baker", aliases: [] },
      { id: "z-vale", name: "Tessa Vale", aliases: ["Kell"] },
    ]);
    expect(matchesInText("Kell arrived.", names)).toEqual([
      { from: 0, to: 4, memberId: "z-vale" },
    ]);
  });

  test("a shared single-token canonical name and inferred part mark neither, but keep the full name", () => {
    const members = [
      { id: "kell", name: "Kell", aliases: [] },
      { id: "baker", name: "Kell Baker", aliases: [] },
    ];
    const names = castNamesFor(members);
    expect(names.filter((name) => name.text === "Kell")).toEqual([]);
    expect(matchesInText("Kell Baker met Kell.", names)).toEqual([
      { from: 0, to: 10, memberId: "baker" },
    ]);
    expect(matchesInText("Kell Baker met Kell.", castNamesFor([...members].reverse()))).toEqual([
      { from: 0, to: 10, memberId: "baker" },
    ]);
  });

  test("splits trimmed Unicode whitespace names, keeps hyphenated and non-Latin parts, and skips middle names", () => {
    const names = castNamesFor([
      { id: "maria", name: "  Мария\u2003Иванова-Петрова  ", aliases: [] },
      { id: "james", name: "James Earl Jones", aliases: [] },
    ]);
    expect(names).toContainEqual({ text: "Мария", memberId: "maria" });
    expect(names).toContainEqual({ text: "Иванова-Петрова", memberId: "maria" });
    expect(names).not.toContainEqual({ text: "Earl", memberId: "james" });
    expect(matchesInText("Мария met Иванова-Петрова.", names)).toHaveLength(2);
  });

  test("deduplicates canonical and explicit pairs, leaving the three-character matcher boundary unchanged", () => {
    const names = castNamesFor([
      { id: "amy", name: "Amy Ray", aliases: ["Amy", "Ray", "Amy"] },
      { id: "al", name: "Al Bo", aliases: [] },
    ]);
    expect(names.filter((name) => name.memberId === "amy" && name.text === "Amy")).toHaveLength(1);
    expect(matchesInText("Amy met Al.", names)).toEqual([
      { from: 0, to: 3, memberId: "amy" },
    ]);
  });
});

describe("matchesInText: the pure matcher", () => {
  test("matches a whole word only, not a name found inside a longer one", () => {
    const names: CastNamePair[] = [{ text: "Kell", memberId: "m1" }];
    // MUTATION TARGET 1. "Kellner" contains "Kell" but is not it.
    expect(matchesInText("Kellner arrived", names)).toEqual([]);
    expect(matchesInText("Kell arrived", names)).toEqual([
      { from: 0, to: 4, memberId: "m1" },
    ]);
  });

  test("prefers the longer name at a position where BOTH match, starting at the same offset", () => {
    // "Kell" and "Kell Baker" both start at position 0 and both end on a
    // word boundary (the space, then "Baker" itself) -- a genuine tie,
    // unlike two names that merely both occur somewhere in the text. Sorted
    // longest-first regardless of input order settles it.
    const names: CastNamePair[] = [
      { text: "Kell", memberId: "short" },
      { text: "Kell Baker", memberId: "long" },
    ];
    expect(matchesInText("Kell Baker said nothing.", names)).toEqual([
      { from: 0, to: 10, memberId: "long" },
    ]);
  });

  test("is case sensitive", () => {
    const names: CastNamePair[] = [{ text: "Kell", memberId: "m1" }];
    expect(matchesInText("kell said nothing.", names)).toEqual([]);
  });

  test("refuses a name under the minimum length", () => {
    const names: CastNamePair[] = [{ text: "Al", memberId: "m1" }];
    expect(matchesInText("Al said nothing.", names)).toEqual([]);
  });

  test("does not overlap two matches: the first consumes its whole span", () => {
    const names: CastNamePair[] = [{ text: "Ann", memberId: "m1" }];
    // "Anna" is not a match for "Ann" (boundary fails), but two separate
    // words each match once.
    expect(matchesInText("Ann and Ann.", names)).toEqual([
      { from: 0, to: 3, memberId: "m1" },
      { from: 8, to: 11, memberId: "m1" },
    ]);
  });

  test("an empty name list matches nothing", () => {
    expect(matchesInText("Kell said nothing.", [])).toEqual([]);
  });

  test("MINOR FIX: two members sharing an identical name resolve alphabetically by id, not by input order", () => {
    // Two cast members can plausibly carry the same name. Before, the sort
    // compared length alone, so a tie there fell through to whatever order
    // the caller happened to pass the names in -- reversing the array would
    // silently hand the same run of prose to a different member.
    const forward: CastNamePair[] = [
      { text: "Ann", memberId: "a-second" },
      { text: "Ann", memberId: "a-first" },
    ];
    const reversed = [...forward].reverse();
    const expected = [{ from: 0, to: 3, memberId: "a-first" }];
    expect(matchesInText("Ann said nothing.", forward)).toEqual(expected);
    expect(matchesInText("Ann said nothing.", reversed)).toEqual(expected);
  });
});

describe("matchesInDoc: positions across a whole document", () => {
  test("finds a name in the second paragraph at the right document position", () => {
    const d = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("Nothing here.")),
      schema.node("paragraph", null, schema.text("Kell arrived.")),
    ]);
    const names: CastNamePair[] = [{ text: "Kell", memberId: "m1" }];
    const hits = matchesInDoc(d, names);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.memberId).toBe("m1");
    // The first paragraph opens at 0, its content starts at 1 and runs 14
    // characters ("Nothing here."), and it closes at 15 -- so the second
    // paragraph's content starts at 16.
    expect(hits[0]?.from).toBe(16);
  });

  test("BUG FIX: an inline mark boundary does not make a whole name look like a match ('**Kell**ner')", () => {
    // "Kell" bold, "ner arrived." plain -- two sibling text nodes for one
    // word. Matching each node's own text in isolation used to find "Kell"
    // as a whole word, because the node holding it has nothing after it to
    // see the "ner" with.
    const strong = schema.marks.strong.create();
    const d = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("Kell", [strong]),
        schema.text("ner arrived."),
      ]),
    ]);
    expect(matchesInDoc(d, [{ text: "Kell", memberId: "m1" }])).toEqual([]);
  });

  test("BUG FIX: a name split by a mark boundary is still found, and still wins the longest-first tie ('Maestro *Kell*')", () => {
    // "Maestro " plain, "Kell" italic -- the longer name "Maestro Kell" spans
    // both nodes. Matching node-by-node could never see the whole name and
    // always lost the tie to the shorter "Kell", the one name a single node
    // ever contained.
    const em = schema.marks.em.create();
    const d = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("Maestro "),
        schema.text("Kell", [em]),
        schema.text(" said nothing."),
      ]),
    ]);
    const hits = matchesInDoc(d, [
      { text: "Maestro Kell", memberId: "long" },
      { text: "Kell", memberId: "short" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.memberId).toBe("long");
  });
});

describe("castMarksPlugin", () => {
  function mountView(names: CastNamePair[], text: string) {
    const calls: { fn: () => void; ms: number }[] = [];
    let cleared = 0;
    const plugin = castMarksPlugin({
      setTimer: (fn, ms) => {
        calls.push({ fn, ms });
        return calls.length;
      },
      clearTimer: () => {
        cleared += 1;
      },
    });
    const state = EditorState.create({ doc: doc(text), plugins: [plugin] });
    const mount = document.createElement("div");
    const view = new EditorView(mount, { state });
    view.dispatch(view.state.tr.setMeta(castMarksKey, { names }));
    return { view, calls, clearedCount: () => cleared };
  }

  test("a names transaction recomputes decorations at once", () => {
    const { view } = mountView([{ text: "Kell", memberId: "m1" }], "Kell said nothing.");
    const marked = view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute("data-member-id")).toBe("m1");
    view.destroy();
  });

  test("every occurrence of a repeated name is marked, none carrying a DOM id", () => {
    // `shot-cli --cast-card` used to anchor on a `cast-mark-first` id given
    // only to the first decoration; that id had no reader (WebKitGTK exposes
    // the whole editable as one AT-SPI `entry`, never a bare `<span>` inside
    // it) and could duplicate across a split decoration, so the rig now
    // finds its target through the entry's own text interface instead and
    // this plugin marks every match plainly.
    const { view } = mountView(
      [{ text: "Kell", memberId: "m1" }],
      "Kell met Kell again.",
    );
    const marked = view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`);
    expect(marked).toHaveLength(2);
    expect(marked[0]?.id).toBe("");
    expect(marked[1]?.id).toBe("");
    view.destroy();
  });

  test("an empty names list clears every mark", () => {
    const { view } = mountView([{ text: "Kell", memberId: "m1" }], "Kell said nothing.");
    expect(view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`)).toHaveLength(1);
    view.dispatch(view.state.tr.setMeta(castMarksKey, { names: [] }));
    expect(view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`)).toHaveLength(0);
    view.destroy();
  });

  test("a document change MAPS the mark rather than recomputing it", () => {
    const { view, calls } = mountView([{ text: "Kell", memberId: "m1" }], "Kell said nothing.");
    calls.length = 0;
    // Insert text before the mark. Mapping keeps the mark on "Kell" rather
    // than losing it until the debounce fires.
    view.dispatch(view.state.tr.insertText("Well. ", 1));
    const marked = view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toBe("Kell");
    // A recompute was ARMED (the debounce), but the mark above already moved
    // by mapping alone -- without ever calling the armed timer's callback.
    expect(calls.length).toBe(1);
    view.destroy();
  });

  test("MUTATION TARGET: the debounce recompute finds a name typed after the last mapping", () => {
    const { view, calls } = mountView([{ text: "Kell", memberId: "m1" }], "Nothing here yet.");
    expect(view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`)).toHaveLength(0);
    // Typing "Kell" in is a document change; the plugin only MAPS on it, so
    // no mark appears until the debounce recompute runs.
    view.dispatch(view.state.tr.insertText("Kell ", 1));
    expect(view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`)).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(0);
    // Fire the armed timer by hand -- the fake clock's whole point.
    calls[calls.length - 1]?.fn();
    expect(view.dom.querySelectorAll(`.${CAST_MARK_CLASS}`)).toHaveLength(1);
    view.destroy();
  });

  test("MINOR FIX: with no names, a document change arms no debounce at all", () => {
    // The preference off, or a book with no cast: `mountView` here passes an
    // empty names list, so every keystroke must be a no-op for this plugin
    // rather than arming a 300ms timer whose only job is a transaction that
    // re-arms the format bubble's own rest debounce for nothing.
    const { view, calls } = mountView([], "Kell said nothing.");
    calls.length = 0;
    view.dispatch(view.state.tr.insertText("x", 1));
    expect(calls.length).toBe(0);
    view.destroy();
  });

  test("the debounce timer is cleared on destroy", () => {
    const { view, clearedCount } = mountView([{ text: "Kell", memberId: "m1" }], "Kell.");
    view.dispatch(view.state.tr.insertText("x", 1));
    const before = clearedCount();
    view.destroy();
    expect(clearedCount()).toBeGreaterThan(before);
  });
});
