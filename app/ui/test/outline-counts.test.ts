import { describe, expect, test } from "bun:test";
import { formatCount, rollUpCounts, rollUpMetric } from "../src/outline-counts";
import type { ProjectItem } from "../src/store/source";

/** A depth-first walk, the shape `items()` returns. `parent` is an index into
 *  the rows already declared, which is what keeps the fixtures readable. */
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

describe("rolling a document index up the tree", () => {
  test("a scene shows its own count", () => {
    const items = walk([["scene", null]]);
    expect(rollUpCounts(items, { i0: 120 }).get("i0")).toBe(120);
  });

  test("a chapter shows the sum of its scenes", () => {
    // part / chapter / scene / scene
    const items = walk([["part", null], ["chapter", 0], ["scene", 1], ["scene", 1]]);
    const totals = rollUpCounts(items, { i2: 300, i3: 45 });
    expect(totals.get("i1")).toBe(345);
    expect(totals.get("i0")).toBe(345);
  });

  test("a part sums across several chapters and depths", () => {
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
    const totals = rollUpCounts(items, { i2: 100, i4: 20, i5: 5, i7: 1000 });
    expect(totals.get("i1")).toBe(100);
    expect(totals.get("i3")).toBe(25);
    expect(totals.get("i0")).toBe(125);
    expect(totals.get("i6")).toBe(1000);
  });

  test("an item with nothing countable below it has NO entry, not a zero", () => {
    // A chapter whose scenes are all unreadable has an unknown length, and
    // printing 0 beside it would be a claim nobody can support.
    const items = walk([["part", null], ["chapter", 0], ["scene", 1]]);
    const totals = rollUpCounts(items, {});
    expect(totals.has("i0")).toBe(false);
    expect(totals.has("i1")).toBe(false);
    expect(totals.has("i2")).toBe(false);
  });

  test("a scene the writer emptied IS zero, and rolls up as zero", () => {
    // The failing direction of the test above. An empty scene has a countable
    // body; an unreadable one does not, and the two must not render alike.
    const items = walk([["chapter", null], ["scene", 0]]);
    const totals = rollUpCounts(items, { i1: 0 });
    expect(totals.get("i1")).toBe(0);
    expect(totals.get("i0")).toBe(0);
  });

  test("an unreadable scene beside a readable one does not poison the parent", () => {
    const items = walk([["chapter", null], ["scene", 0], ["scene", 0]]);
    const totals = rollUpCounts(items, { i1: 40 });
    expect(totals.has("i2")).toBe(false);
    // The chapter reports what CAN be counted. An undercount is the honest
    // answer; refusing to count the chapter at all because one scene is
    // unreadable would hide the other scene's words too.
    expect(totals.get("i0")).toBe(40);
  });

  test("a container that carries a document of its own adds it to the subtree", () => {
    // Only scenes get documents today, but the store does not forbid a `doc`
    // row against another type and the walk is arbitrary by product spec. If it
    // ever happens the count must include it rather than silently drop it.
    const items = walk([["chapter", null], ["scene", 0]]);
    const totals = rollUpCounts(items, { i0: 7, i1: 3 });
    expect(totals.get("i0")).toBe(10);
  });

  test("a metric rolls a container's own document and descendants together", () => {
    const items = walk([["part", null], ["chapter", 0], ["scene", 1]]);
    const perDoc = {
      i0: { words: 2, sentences: 1 },
      i1: { words: 3, sentences: 2 },
      i2: { words: 5, sentences: 4 },
    };
    const totals = rollUpMetric(items, perDoc, (count) => count.sentences);
    expect(totals.get("i2")).toBe(4);
    expect(totals.get("i1")).toBe(6);
    expect(totals.get("i0")).toBe(7);
  });

  test("a prototype-like item id stays absent unless the sparse map owns it", () => {
    const items = [
      { ...walk([["scene", null]])[0]!, id: "constructor" },
      ...walk([["scene", null]]).map((item) => ({ ...item, id: "known" })),
    ];
    const totals = rollUpMetric(items, { known: { words: 5 } }, (count) => count.words);
    expect(totals.has("constructor")).toBe(false);
    expect(totals.get("known")).toBe(5);
  });

  test("a part nested inside a scene still rolls up", () => {
    // Legal by product spec, which makes the hierarchy arbitrary and forbids
    // type-based parent constraints. A roll-up keyed on type rather than on
    // parent_id would lose this.
    const items = walk([["scene", null], ["part", 0], ["scene", 1]]);
    const totals = rollUpCounts(items, { i0: 10, i2: 5 });
    expect(totals.get("i1")).toBe(5);
    expect(totals.get("i0")).toBe(15);
  });

  test("an empty walk yields nothing", () => {
    expect(rollUpCounts([], { i0: 5 }).size).toBe(0);
  });

  test("a count for an id absent from the walk is ignored", () => {
    // The index is the store's and the walk is the tree's; a document whose
    // item is not in the walk is an orphan, and adding it to no parent would
    // silently inflate nothing at all - but it must not throw either.
    const items = walk([["scene", null]]);
    const totals = rollUpCounts(items, { i0: 5, "not-in-the-walk": 999 });
    expect(totals.get("i0")).toBe(5);
    expect(totals.size).toBe(1);
  });
});

describe("formatting a count", () => {
  test("groups thousands", () => {
    // Five figures unseparated is a number a reader has to count the digits of.
    expect(formatCount(12345)).toBe((12345).toLocaleString());
    expect(formatCount(12345)).not.toBe("12345");
  });

  test("zero is a count and shows as one", () => {
    expect(formatCount(0)).toBe("0");
  });

  test("absent renders as nothing, not as a dash or a zero", () => {
    // A marker for "unknown" on every row of a manuscript whose index has not
    // arrived is noise, and the state lasts a few hundred milliseconds.
    expect(formatCount(undefined)).toBe("");
  });
});

describe("the navigator's counts and the bar's total agree by construction", () => {
  test("the roll-up of every root equals the sum of the host's map", () => {
    // The host guarantees `sum(project_word_counts) === project_word_count`,
    // and the bar shows the second. So the sum of the ROOTS' roll-ups has to
    // equal the sum of the map, or a writer adding up the parts gets a
    // different manuscript from the one the bar reports - and neither figure
    // says which is wrong.
    //
    // This holds only because every countable item is under exactly one root.
    // A walk with an orphan would break it, which is what the store's cycle and
    // orphan detection exists to prevent.
    const items = walk([
      ["part", null],
      ["chapter", 0],
      ["scene", 1],
      ["scene", 1],
      ["part", null],
      ["scene", 4],
      ["scene", 4],
    ]);
    const perDoc = { i2: 100, i3: 250, i5: 7, i6: 0 };
    const totals = rollUpCounts(items, perDoc);
    const roots = items.filter((i) => i.parent_id === null);
    const rolled = roots.reduce((sum, r) => sum + (totals.get(r.id) ?? 0), 0);
    expect(rolled).toBe(Object.values(perDoc).reduce((a, b) => a + b, 0));
  });

  test("a scene counted twice would break it, so nothing is added twice", () => {
    // The failing direction of the identity. An implementation that added a
    // subtree into every ANCESTOR rather than into its immediate parent would
    // double-count at every level above the first, and the single-parent test
    // above would still pass at depth two.
    const items = walk([["part", null], ["chapter", 0], ["chapter", 1], ["scene", 2]]);
    const totals = rollUpCounts(items, { i3: 40 });
    expect(totals.get("i2")).toBe(40);
    expect(totals.get("i1")).toBe(40);
    expect(totals.get("i0")).toBe(40);
  });
});
