import { describe, expect, test } from "bun:test";
import { appearancesForBook, rollUpAppearances } from "../src/appearances";
import { BIBLE_TYPE, NOTE_TYPE, TRASH_TYPE } from "../src/item-types";
import type { ProjectItem } from "../src/store/source";

/** A depth-first walk, the shape `items()` returns. `parent` is an index into
 *  the rows already declared, which is what keeps the fixtures readable.
 *  Copied from `outline-counts.test.ts`, deliberately: the two modules roll up
 *  the same walk and a shared helper in a third file would be a fixture nobody
 *  reading either test can see. */
function walk(rows: [type: string, parent: number | null][]): ProjectItem[] {
  return rows.map(([type, parent], i) => ({
    id: `i${i}`,
    parent_id: parent === null ? null : `i${parent}`,
    type,
    title: `${type} ${i}`,
    position: String(i).padStart(4, "0"),
    rev: 1,
    state: null,
    depth: 0,
  }));
}

function names(totals: Map<string, ReadonlySet<string>>, id: string): string[] {
  return [...(totals.get(id) ?? [])].sort();
}

describe("rolling who appears up the tree", () => {
  test("a scene shows whoever is tagged on it", () => {
    const items = walk([["scene", null]]);
    expect(names(rollUpAppearances(items, { i0: ["ada", "bo"] }), "i0")).toEqual(["ada", "bo"]);
  });

  test("a chapter shows the UNION of its scenes, not the sum", () => {
    // The whole difference from `rollUpCounts`: two scenes with the same
    // character in both give the chapter ONE name, where the count would give
    // it two. A fixture with disjoint casts cannot tell union from
    // concatenation.
    const items = walk([["part", null], ["chapter", 0], ["scene", 1], ["scene", 1]]);
    const totals = rollUpAppearances(items, { i2: ["ada", "bo"], i3: ["ada", "cy"] });
    expect(names(totals, "i1")).toEqual(["ada", "bo", "cy"]);
    expect(names(totals, "i0")).toEqual(["ada", "bo", "cy"]);
  });

  test("a part unions across several chapters and depths", () => {
    const items = walk([
      ["part", null],
      ["chapter", 0],
      ["scene", 1],
      ["chapter", 0],
      ["scene", 3],
      ["scene", 3],
      ["part", null],
      ["scene", 6],
    ]);
    const totals = rollUpAppearances(items, {
      i2: ["ada"],
      i4: ["bo"],
      i5: ["ada"],
      i7: ["zed"],
    });
    expect(names(totals, "i1")).toEqual(["ada"]);
    expect(names(totals, "i3")).toEqual(["ada", "bo"]);
    expect(names(totals, "i0")).toEqual(["ada", "bo"]);
    // The second part is not the first one's business.
    expect(names(totals, "i6")).toEqual(["zed"]);
  });

  test("an item nobody appears in gets an EMPTY set, never no entry", () => {
    // THE ONE PLACE THIS DELIBERATELY DIFFERS FROM `rollUpCounts`, which gives
    // an item with nothing countable underneath it no entry at all because
    // "printing 0 beside it would be a claim nobody can support". An empty cast
    // is a TRUE answer -- nobody appears -- and a caller that had to tell
    // `undefined` from an empty set would be deciding that for itself.
    const items = walk([["chapter", null], ["scene", 0]]);
    const totals = rollUpAppearances(items, {});
    expect(totals.has("i0")).toBe(true);
    expect(totals.has("i1")).toBe(true);
    expect(names(totals, "i0")).toEqual([]);
  });

  test("a container tagged DIRECTLY carries its own names as well as the ones below", () => {
    const items = walk([["chapter", null], ["scene", 0]]);
    const totals = rollUpAppearances(items, { i0: ["narrator"], i1: ["ada"] });
    expect(names(totals, "i0")).toEqual(["ada", "narrator"]);
    expect(names(totals, "i1")).toEqual(["ada"]);
  });

  test("the walk is read ONCE, backwards, and a deep chain still reaches the root", () => {
    // Five levels, tagged only at the bottom. An implementation that added a
    // child's own tags into its parent but not the subtree it had already
    // accumulated passes every fixture above, where the tagged row is one hop
    // from the row asserted.
    const items = walk([
      ["part", null],
      ["chapter", 0],
      ["scene", 1],
      ["part", 2],
      ["scene", 3],
    ]);
    const totals = rollUpAppearances(items, { i4: ["ada"] });
    expect(names(totals, "i0")).toEqual(["ada"]);
  });
});

describe("the book is the walk minus the bin and the bible", () => {
  /** A chapter whose only scene has been BINNED, plus a `trash`-typed row a
   *  writer nested inside a LIVE chapter.
   *
   *  THE DECOY IS THE POINT. An implementation that filtered by TYPE rather
   *  than by ROOT drops the writer's own row out of the book on the strength of
   *  one hand-moved item, and the store's own trashed-ids tests use this exact
   *  fixture for that reason. */
  const book = (): ProjectItem[] => [
    { ...walk([["chapter", null]])[0]!, id: "ch", title: "Chapter 1" },
    { id: "live", parent_id: "ch", type: "chapter", title: "Chapter 2", position: "0001", rev: 1, state: null, depth: 1 },
    { id: "decoy", parent_id: "live", type: TRASH_TYPE, title: "Trash", position: "0002", rev: 1, state: null, depth: 2 },
    { id: "bin", parent_id: null, type: TRASH_TYPE, title: "Trash", position: "0003", rev: 1, state: null, depth: 0 },
    { id: "binned", parent_id: "bin", type: "scene", title: "Scene 1", position: "0004", rev: 1, state: null, depth: 1 },
  ];

  test("a binned scene's cast has left the chapter above it", () => {
    const totals = appearancesForBook(book(), { binned: ["ada"], decoy: ["bo"] });
    expect(names(totals, "ch")).toEqual(["bo"]);
    expect(totals.has("bin")).toBe(false);
    expect(totals.has("binned")).toBe(false);
  });

  test("a trash-typed row a writer nested inside a live chapter is a ROW, not the bin", () => {
    const totals = appearancesForBook(book(), { binned: ["ada"], decoy: ["bo"] });
    expect(names(totals, "decoy")).toEqual(["bo"]);
    expect(names(totals, "live")).toEqual(["bo"]);
  });

  test("the bible's cast is not the book's either", () => {
    const walked: ProjectItem[] = [
      { id: "ch", parent_id: null, type: "chapter", title: "Chapter 1", position: "0000", rev: 1, state: null, depth: 0 },
      { id: "bible", parent_id: null, type: BIBLE_TYPE, title: "Bible", position: "0001", rev: 1, state: null, depth: 0 },
      { id: "n1", parent_id: "bible", type: NOTE_TYPE, title: "Note", position: "0002", rev: 1, state: null, depth: 1 },
    ];
    const totals = appearancesForBook(walked, { n1: ["ada"] });
    expect(totals.has("bible")).toBe(false);
    expect(totals.has("n1")).toBe(false);
    // The control: without it a filter that dropped everything would pass.
    expect(names(appearancesForBook(walked, { ch: ["bo"] }), "ch")).toEqual(["bo"]);
  });
});
