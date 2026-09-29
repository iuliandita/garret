import { describe, expect, test } from "bun:test";
import { formatDateTime } from "../src/i18n";
import {
  computeStatistics,
  createSessionWords,
  medianOf,
  statisticRows,
  STATISTICS_EMPTY,
  STATISTICS_NOTE,
  type StatGroup,
  type SourceWordSummary,
  type StatisticsInput,
} from "../src/statistics";
import type { ProjectItem } from "../src/store/source";

/** A walk row. Written in DEPTH-FIRST order by the caller, because that is what
 *  the store's own walk emits and what `rollUpCounts` reads backwards. */
function item(
  id: string,
  type: string,
  parent_id: string | null,
  title = id,
): ProjectItem {
  return { id, parent_id, type, title, position: id, rev: 1, state: null, depth: 0 };
}

/**
 * One part, one chapter under it, three scenes under the chapter, plus a loose
 * scene at the root and a chapter with no scenes.
 *
 *     part-one
 *       chapter-one
 *         s1
 *         s2  (30)
 *         s3  (0)      <- empty, a real reading
 *     chapter-loose
 *     s-loose
 */
function manuscript(): ProjectItem[] {
  return [
    item("part-one", "part", null, "Part One"),
    item("chapter-one", "chapter", "part-one", "Chapter One"),
    item("s1", "scene", "chapter-one", "Arrival"),
    item("s2", "scene", "chapter-one", "Departure"),
    item("s3", "scene", "chapter-one", "Blank"),
    item("chapter-loose", "chapter", null, "Chapter Loose"),
    item("s-loose", "scene", null, "Loose"),
  ];
}

const count = (words: number, sentences: number, paragraphs: number) => ({ words, sentences, paragraphs });
const COUNTS = {
  s1: count(120, 8, 2),
  s2: count(30, 2, 1),
  s3: count(0, 0, 0),
  "s-loose": count(500, 31, 6),
};

function input(over: Partial<StatisticsInput> = {}): StatisticsInput {
  return {
    items: manuscript(),
    perDoc: COUNTS,
    openItemId: "s1",
    session: { added: 0, deleted: 0, net: 0 },
    today: { writingMinutes: 12, tracking: "on" },
    ...over,
  };
}

function rowsOf(groups: readonly StatGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of groups) for (const row of group.rows) out.set(row.key, row.value);
  return out;
}

describe("the revision-state distribution", () => {
  const marked = (): ProjectItem[] => {
    const rows = manuscript();
    const set = (id: string, state: string): void => {
      const at = rows.findIndex((r) => r.id === id);
      rows[at] = { ...rows[at]!, state };
    };
    set("part-one", "revising");
    set("chapter-one", "draft");
    set("s1", "draft");
    set("s2", "done");
    return rows;
  };

  test("it counts every item type, not only scenes", () => {
    // A writer marks a whole chapter `revising` and that is the ordinary use, so
    // counting scenes alone would report a book nobody had marked. `part-one` and
    // `chapter-one` are both marked here and both must land.
    const stats = computeStatistics(input({ items: marked() }));
    expect(stats.states.counts).toEqual({ outline: 0, draft: 2, revising: 1, done: 1 });
    expect(stats.states.none).toBe(3);
    expect(stats.states.total).toBe(7);
  });

  test("the bin is excluded, item and subtree alike", () => {
    // Deleted work is not part of how far the manuscript has got. It is the same
    // `live` walk every other figure here is computed from, so the exclusion
    // cannot be forgotten in one place and applied in another.
    const binned = marked();
    binned.push({ ...item("bin", "trash", null, "Trash"), state: "done" });
    binned.push({ ...item("gone", "scene", "bin", "Gone"), state: "done" });
    const stats = computeStatistics(input({ items: binned }));
    expect(stats.states.counts.done).toBe(1);
    expect(stats.states.total).toBe(7);
  });

  test("a manuscript nobody has marked is all `none` and no zeros are hidden", () => {
    const stats = computeStatistics(input());
    expect(stats.states.none).toBe(7);
    expect(stats.states.counts).toEqual({ outline: 0, draft: 0, revising: 0, done: 0 });
  });

  test("every state has a row, and the counts read as written", () => {
    const rows = rowsOf(statisticRows(computeStatistics(input({ items: marked() }))));
    expect(rows.get("state-draft")).toBe("2");
    expect(rows.get("state-outline")).toBe("0");
    expect(rows.get("state-none")).toBe("3");
  });

  test("the state rows do NOT claim to exclude unreadable scenes", () => {
    // They read the TREE and never a word count: a scene whose body this build
    // cannot parse still has a title, a type and a state. Copying the shared
    // exclusion clause onto them would be a definition that is simply false, and
    // the whole argument for printing definitions is that a reader can check
    // them.
    const groups = statisticRows(computeStatistics(input({ items: marked() })));
    const states = groups.find((g) => g.heading === "Revision states");
    expect(states).toBeDefined();
    for (const row of states?.rows ?? []) {
      expect(row.definition).toContain("Excludes the bin.");
      expect(row.definition).not.toContain("could not be read");
    }
  });
});

describe("per-scope totals", () => {
  test("the open scene reports its own count and names itself", () => {
    const stats = computeStatistics(input());
    expect(stats.scene).toEqual({ state: "counted", words: 120, title: "Arrival" });
  });

  test("a chapter is the sum of the scenes under it, however deeply", () => {
    const deep = manuscript();
    // A scene under a PART that is under the chapter. Product spec section 6
    // makes the hierarchy free-form, so this shape is legal and must roll up.
    deep.splice(5, 0, item("part-inner", "part", "chapter-one", "Inner Part"));
    deep.splice(6, 0, item("s4", "scene", "part-inner", "Nested"));
    const stats = computeStatistics(
      input({ items: deep, perDoc: { ...COUNTS, s4: count(7, 1, 1) } }),
    );
    expect(stats.chapter).toEqual({ state: "counted", words: 157, title: "Chapter One" });
  });

  test("a part is the sum of everything beneath it", () => {
    const stats = computeStatistics(input());
    expect(stats.part).toEqual({ state: "counted", words: 150, title: "Part One" });
  });

  test("unit scopes keep a scene's own document and roll nested chapter and part documents", () => {
    const deep = manuscript();
    deep.splice(3, 0, item("part-inner", "part", "s1", "Inner Part"));
    deep.splice(4, 0, item("s4", "scene", "part-inner", "Nested"));
    const stats = computeStatistics(input({
      items: deep,
      perDoc: {
        ...COUNTS,
        "chapter-one": count(1, 10, 4),
        "part-one": count(1, 20, 8),
        "part-inner": count(1, 30, 12),
        s4: count(1, 40, 16),
      },
    }));
    expect(stats.units.scene).toEqual({ sentences: 8, paragraphs: 2 });
    expect(stats.units.chapter).toEqual({ sentences: 90, paragraphs: 35 });
    expect(stats.units.part).toEqual({ sentences: 110, paragraphs: 43 });

    const nested = computeStatistics({
      ...input({ items: deep }),
      perDoc: {
        ...COUNTS,
        "chapter-one": count(1, 10, 4),
        "part-one": count(1, 20, 8),
        "part-inner": count(1, 30, 12),
        s4: count(1, 40, 16),
      },
      openItemId: "s4",
    });
    expect(nested.units.scene).toEqual({ sentences: 40, paragraphs: 16 });
    expect(nested.units.chapter).toEqual({ sentences: 90, paragraphs: 35 });
    expect(nested.units.part).toEqual({ sentences: 70, paragraphs: 28 });
  });

  test("the manuscript is every live document, loose scenes included", () => {
    const stats = computeStatistics(input());
    expect(stats.manuscript.words).toBe(650);
  });

  test("a scene with no chapter above it says so rather than reporting zero", () => {
    const stats = computeStatistics(input({ openItemId: "s-loose" }));
    expect(stats.chapter).toEqual({ state: "absent", words: null, title: null });
    expect(stats.part).toEqual({ state: "absent", words: null, title: null });
    // The scene scope is still a real reading.
    expect(stats.scene.words).toBe(500);
  });

  test("with nothing open, every scope but the manuscript is absent", () => {
    const stats = computeStatistics(input({ openItemId: null }));
    expect(stats.scene.state).toBe("absent");
    expect(stats.chapter.state).toBe("absent");
    expect(stats.part.state).toBe("absent");
    expect(stats.manuscript.words).toBe(650);
  });

  test("a chapter whose every scene is unreadable is uncounted, not zero", () => {
    // THE DISTINCTION THE WHOLE MODULE TURNS ON. A chapter of three scenes none
    // of which could be read has an UNKNOWN length; printing 0 beside it is a
    // claim nobody can support.
    const stats = computeStatistics(input({ perDoc: { "s-loose": count(500, 31, 6) } }));
    expect(stats.chapter).toEqual({ state: "uncounted", words: null, title: "Chapter One" });
    expect(stats.part.state).toBe("uncounted");
    expect(stats.scene.state).toBe("uncounted");
  });

  test("a manuscript nothing could be counted in reports no total at all", () => {
    const stats = computeStatistics(input({ perDoc: {} }));
    expect(stats.manuscript).toEqual({ state: "uncounted", words: null, title: null });
  });

  test("a prototype-like item id stays uncounted when the sparse map does not own it", () => {
    const stats = computeStatistics(input({
      items: [item("constructor", "scene", null, "Odd scene")],
      perDoc: {},
      openItemId: "constructor",
    }));
    expect(stats.scene).toEqual({ state: "uncounted", words: null, title: "Odd scene" });
    expect(stats.units.scene).toBeNull();
    expect(stats.manuscript.state).toBe("uncounted");
  });

  test("an item that is itself a chapter is its own chapter scope", () => {
    const stats = computeStatistics(input({ openItemId: "chapter-one" }));
    expect(stats.chapter.title).toBe("Chapter One");
    expect(stats.chapter.words).toBe(150);
  });
});

describe("structural distribution", () => {
  test("parts, chapters and scenes are counted by their own type", () => {
    const stats = computeStatistics(input());
    expect(stats.structure).toEqual({ parts: 1, chapters: 2, scenes: 4 });
  });

  test("a part nested inside a scene is still a part", () => {
    // The type comes from the row, never from the depth. A depth-derived rule
    // passes the fixture above and fails this one.
    const odd = manuscript();
    odd.splice(3, 0, item("part-deep", "part", "s1", "Deep Part"));
    const stats = computeStatistics(input({ items: odd }));
    expect(stats.structure.parts).toBe(2);
  });

  test("longest, shortest and empty come from the scenes that could be counted", () => {
    const stats = computeStatistics(input());
    expect(stats.lengths.longest).toBe(500);
    // Zero is the shortest and it is a real reading, not a missing one.
    expect(stats.lengths.shortest).toBe(0);
    expect(stats.lengths.empty).toBe(1);
    expect(stats.lengths.uncounted).toBe(0);
  });

  test("an empty scene and an unreadable one are counted separately", () => {
    // s2 loses its entry entirely; s3 keeps its genuine zero. The two must not
    // collapse into one figure, in either direction.
    const { s2: _dropped, ...withoutS2 } = COUNTS;
    const stats = computeStatistics(input({ perDoc: withoutS2 }));
    expect(stats.lengths.empty).toBe(1);
    expect(stats.lengths.uncounted).toBe(1);
    // And the unreadable scene is out of the length figures rather than in them
    // as a zero.
    expect(stats.lengths.shortest).toBe(0);
    expect(stats.lengths.longest).toBe(500);
  });
});

describe("the bin is excluded from every figure", () => {
  test("a trashed scene leaves the structure, the lengths and every total", () => {
    const binned = manuscript();
    binned.push(item("bin", "trash", null, "Trash"));
    binned.push(item("s-gone", "scene", "bin", "Deleted"));
    // The host already withholds a trashed document's count, so the honest
    // fixture withholds it here too - and the STRUCTURE figures would still
    // count the row if `liveItemsIn` were not applied, which is the half a
    // count-only fixture cannot test.
    const stats = computeStatistics(input({ items: binned }));
    expect(stats.structure.scenes).toBe(4);
    expect(stats.manuscript.words).toBe(650);
    expect(stats.lengths.uncounted).toBe(0);
  });

  test("a trashed scene the host still has a count for is excluded anyway", () => {
    // Belt and braces: `counts_excluding` withholds it, but a build that
    // stopped doing so must not be able to put deleted words back in the total
    // through this module.
    const binned = manuscript();
    binned.push(item("bin", "trash", null, "Trash"));
    binned.push(item("s-gone", "scene", "bin", "Deleted"));
    const stats = computeStatistics(
      input({ items: binned, perDoc: { ...COUNTS, "s-gone": count(9999, 1, 1) } }),
    );
    expect(stats.manuscript.words).toBe(650);
    expect(stats.structure.scenes).toBe(4);
    expect(stats.lengths.longest).toBe(500);
  });

  test("a whole trashed branch goes, not just the row that was binned", () => {
    const binned = manuscript();
    binned.push(item("bin", "trash", null, "Trash"));
    binned.push(item("chapter-gone", "chapter", "bin", "Deleted chapter"));
    binned.push(item("s-gone", "scene", "chapter-gone", "Deleted scene"));
    const stats = computeStatistics(input({ items: binned }));
    expect(stats.structure).toEqual({ parts: 1, chapters: 2, scenes: 4 });
  });
});

describe("medianOf", () => {
  test("an odd number of scenes takes the middle value", () => {
    expect(medianOf([1, 2, 9])).toBe(2);
    expect(medianOf([5])).toBe(5);
  });

  test("an even number takes the mean of the two central values", () => {
    expect(medianOf([1, 2, 3, 10])).toBe(2.5);
    expect(medianOf([10, 20])).toBe(15);
  });

  test("nothing to measure has no median rather than a zero one", () => {
    expect(medianOf([])).toBeNull();
  });

  test("the median comes from the sorted counts, not from walk order", () => {
    // s1 120, s2 30, s3 0, s-loose 500 -> sorted 0, 30, 120, 500 -> 75.
    const stats = computeStatistics(input());
    expect(stats.lengths.median).toBe(75);
  });

  test("an odd count of scenes gives an exact middle", () => {
    const { s3: _dropped, ...three } = COUNTS;
    // Three counted scenes: 30, 120, 500.
    const stats = computeStatistics(input({ perDoc: three }));
    expect(stats.lengths.median).toBe(120);
  });
});

describe("the session accumulator", () => {
  test("the first sighting of a document sets a baseline and moves nothing", () => {
    const session = createSessionWords();
    session.observe("s1", 80_000);
    expect(session.totals()).toEqual({ added: 0, deleted: 0, net: 0 });
  });

  test("added and deleted are kept apart across several edits", () => {
    const session = createSessionWords();
    session.observe("s1", 100);
    session.observe("s1", 140); // +40
    session.observe("s1", 110); // -30
    session.observe("s1", 160); // +50
    expect(session.totals()).toEqual({ added: 90, deleted: 30, net: 60 });
  });

  test("a session that only cut reports the loss rather than a floor of zero", () => {
    const session = createSessionWords();
    session.observe("s1", 900);
    session.observe("s1", 0);
    expect(session.totals()).toEqual({ added: 0, deleted: 900, net: -900 });
  });

  test("two documents accumulate independently", () => {
    const session = createSessionWords();
    session.observeAll({ s1: 10, s2: 10 });
    session.observeAll({ s1: 30, s2: 4 });
    expect(session.totals()).toEqual({ added: 20, deleted: 6, net: 14 });
  });

  test("the open document is skipped, so a lagging saved count is not a loss", () => {
    // THE DEFECT THIS EXISTS TO PREVENT. The scene throttle reports the LIVE
    // count; the map reports what the store holds, which trails it by up to a
    // flush debounce. Observing both reads the lag as words deleted and then
    // written again.
    const session = createSessionWords();
    session.observe("s1", 100);
    session.observe("s1", 160); // typed, not yet saved
    session.observeAll({ s1: 100, s2: 5 }, "s1");
    expect(session.totals()).toEqual({ added: 60, deleted: 0, net: 60 });
  });

  test("skipping nothing is what an unopened project asks for", () => {
    const session = createSessionWords();
    session.observeAll({ s1: 10 }, null);
    session.observeAll({ s1: 12 }, null);
    expect(session.totals().added).toBe(2);
  });

  test("a document that disappears from the map is not charged as a deletion", () => {
    // Absence means "withheld" - trashed, or unreadable - and neither is a
    // writer cutting words. Charging it would report a failed parse as a lost
    // chapter.
    const session = createSessionWords();
    session.observeAll({ s1: 500, s2: 10 });
    session.observeAll({ s2: 10 });
    expect(session.totals()).toEqual({ added: 0, deleted: 0, net: 0 });
  });

  test("a document that comes back is measured against where it left off", () => {
    const session = createSessionWords();
    session.observeAll({ s1: 500 });
    session.observeAll({});
    session.observeAll({ s1: 520 });
    expect(session.totals().added).toBe(20);
  });
});

describe("every figure carries its definition", () => {
  const groups = statisticRows(computeStatistics(input()));

  test("the thirty-two figures the panel promises are all there", () => {
    const keys = groups.flatMap((g) => g.rows.map((r) => r.key));
    expect(keys).toEqual([
      "scene",
      "chapter",
      "part",
      "manuscript",
      "scene-sentences",
      "scene-paragraphs",
      "chapter-sentences",
      "chapter-paragraphs",
      "part-sentences",
      "part-paragraphs",
      "manuscript-sentences",
      "manuscript-paragraphs",
      "chapters-words",
      "front",
      "back",
      "parts",
      "chapters",
      "scenes",
      "longest",
      "shortest",
      "median",
      "empty",
      "uncounted",
      "state-outline",
      "state-draft",
      "state-revising",
      "state-done",
      "state-none",
      "added",
      "deleted",
      "net",
      "writing-time",
    ]);
  });

  test("no definition is missing, empty or a single word", () => {
    // The requirement is a SENTENCE saying what the figure counts, and a metric
    // whose rule is a label is a metric a reader still has to take on trust.
    for (const group of groups) {
      for (const row of group.rows) {
        expect(row.definition.length).toBeGreaterThan(40);
        expect(row.definition.trim().endsWith(".")).toBe(true);
      }
    }
  });

  test("every figure that can be thrown off by the bin says so, in one clause", () => {
    const byKey = new Map(groups.flatMap((g) => g.rows.map((r) => [r.key, r] as const)));
    for (const key of ["chapter", "part", "manuscript", "parts", "chapters", "scenes", "longest", "shortest", "median"]) {
      expect(byKey.get(key)?.definition).toContain("bin");
    }
  });

  test("the two figures a reader could confuse each name the other", () => {
    const byKey = new Map(groups.flatMap((g) => g.rows.map((r) => [r.key, r] as const)));
    expect(byKey.get("empty")?.definition).toContain("could not be counted");
    expect(byKey.get("uncounted")?.definition).toContain("rather than treating them as zero");
  });

  test("the shared note states scope, the word rule and the timezone", () => {
    expect(STATISTICS_NOTE).toContain("this book alone");
    expect(STATISTICS_NOTE).toContain("word rule 1");
    expect(STATISTICS_NOTE).toContain("timezone");
  });

  test("figures are grouped and every group is named", () => {
    expect(groups.map((g) => g.heading)).toEqual([
      "Words",
      "Sentences and paragraphs",
      "By section",
      "Structure",
      "Revision states",
      "This session",
      "Today",
    ]);
  });

  test("the sentence and paragraph rows carry the host's figures, and a word where there is none", () => {
    const rows = rowsOf(groups);
    expect(rows.get("scene-sentences")).toBe("8");
    expect(rows.get("scene-paragraphs")).toBe("2");
    expect(rows.get("chapter-sentences")).toBe("10");
    expect(rows.get("chapter-paragraphs")).toBe("3");
    expect(rows.get("part-sentences")).toBe("10");
    expect(rows.get("part-paragraphs")).toBe("3");
    expect(rows.get("manuscript-sentences")).toBe("41");
    expect(rows.get("manuscript-paragraphs")).toBe("9");
    const byKey = new Map(groups.flatMap((g) => g.rows.map((r) => [r.key, r] as const)));
    expect(byKey.get("manuscript-sentences")?.raw).toBe(41);
    expect(byKey.get("scene-sentences")?.definition).toContain("'Dr. Smith' is two");

    const noScene = rowsOf(statisticRows(computeStatistics(input({ openItemId: null }))));
    expect(noScene.get("scene-sentences")).toBe("none");
    expect(noScene.get("scene-paragraphs")).toBe("none");
    expect(noScene.get("manuscript-sentences")).toBe("41");

    const zero = computeStatistics(input({ openItemId: "s3" }));
    expect(zero.units.scene).toEqual({ sentences: 0, paragraphs: 0 });
    const absent = computeStatistics(input({ openItemId: null }));
    expect(absent.units.scene).toBeNull();
    expect(absent.units.chapter).toBeNull();
    expect(absent.units.part).toBeNull();
  });

  test("the manuscript's sentences are withheld exactly when its words are", () => {
    // Every body unreadable: the host answered no word count, so the manuscript
    // is uncounted, and 41 sentences beside an uncounted manuscript would be a
    // measurement of nothing.
    const stats = computeStatistics(input({ perDoc: {} }));
    expect(stats.manuscript.state).toBe("uncounted");
    expect(stats.units.manuscript).toBeNull();
    const rows = rowsOf(statisticRows(stats));
    expect(rows.get("manuscript-paragraphs")).toBe("not counted");
  });

  test("the writing-time row changes its definition with the switch, and never lies about a minute", () => {
    const on = rowsOf(statisticRows(computeStatistics(input({ today: { writingMinutes: 75, tracking: "on" } }))));
    expect(on.get("writing-time")).toBe("1 h 15 min");
    const off = statisticRows(computeStatistics(input({ today: { writingMinutes: 75, tracking: "off" } })))
      .flatMap((g) => g.rows)
      .find((r) => r.key === "writing-time");
    expect(off?.value).toBe("1 h 15 min");
    expect(off?.definition).toContain("Not counted");
    const unknown = rowsOf(statisticRows(computeStatistics(input({ today: { writingMinutes: null, tracking: "on" } }))));
    expect(unknown.get("writing-time")).toBe("not counted");
  });
});

describe("what the rows read as", () => {
  test("no two rows share a label, and every sub-line starts with a capital", () => {
    // "Chapters" named both the chapters' words and their number, and the
    // absent sub-lines began in lower case.
    const rows = statisticRows(computeStatistics(input({ openItemId: null }))).flatMap((g) => g.rows);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const r of rows) if (r.detail !== null) expect(r.detail).toMatch(/^\p{Lu}/u);
  });

  test("counts are grouped for reading", () => {
    const stats = computeStatistics(
      input({ perDoc: { ...COUNTS, "s-loose": count(12_345, 31, 6) } }),
    );
    expect(rowsOf(statisticRows(stats)).get("manuscript")).toBe((12_495).toLocaleString());
  });

  test("an absent scope reads as none, never as zero or as not counted", () => {
    const rows = statisticRows(computeStatistics(input({ openItemId: null })));
    expect(rowsOf(rows).get("scene")).toBe("none");
    const detail = rows[0]?.rows.find((r) => r.key === "scene")?.detail;
    expect(detail).toBe("No scene is open");
  });

  test("an uncounted scope says which item it could not count", () => {
    const rows = statisticRows(computeStatistics(input({ perDoc: { "s-loose": count(5, 1, 1) } })));
    const chapter = rows[0]?.rows.find((r) => r.key === "chapter");
    expect(chapter?.value).toBe("not counted");
    expect(chapter?.detail).toBe("Chapter One, not counted");
  });

  test("a length nothing could be measured reads as not counted, never as zero", () => {
    // Scenes exist, so this is not the empty state - the host simply could not
    // read any of them. Zero would be a measurement.
    const rows = rowsOf(statisticRows(computeStatistics(input({ perDoc: {} }))));
    expect(rows.get("longest")).toBe("not counted");
    expect(rows.get("shortest")).toBe("not counted");
    expect(rows.get("median")).toBe("not counted");
    // And the two figures that ARE real counts still read as numbers.
    expect(rows.get("uncounted")).toBe("4");
    expect(rows.get("empty")).toBe("0");
  });

  test("a net loss carries a real minus sign, not a hyphen", () => {
    const rows = statisticRows(
      computeStatistics(input({ session: { added: 100, deleted: 900, net: -800 } })),
    );
    expect(rowsOf(rows).get("net")).toBe("−800");
    expect(rowsOf(rows).get("net")).not.toContain("-");
  });

  test("a net of zero reads as zero, because that is a real answer", () => {
    const rows = statisticRows(computeStatistics(input()));
    expect(rowsOf(rows).get("net")).toBe("0");
    expect(rowsOf(rows).get("added")).toBe("0");
  });

  test("a net of zero from equal work is not a quiet session", () => {
    // A test that only checked `net` would pass just as well against a session
    // where nothing was written at all - the whole reason `added` and `deleted`
    // are kept apart from `net` is that 4,000 words drafted and cut is not the
    // same afternoon as an idle one, even though both net to zero.
    const rows = rowsOf(
      statisticRows(
        computeStatistics(input({ session: { added: 4000, deleted: 4000, net: 0 } })),
      ),
    );
    expect(rows.get("net")).toBe("0");
    expect(rows.get("added")).toBe("4,000");
    expect(rows.get("deleted")).toBe("4,000");
  });

  test("the empty state is a sentence, not a table of zeros", () => {
    expect(STATISTICS_EMPTY).toContain("no scenes");
  });
});

describe("the bible is excluded from every figure", () => {
  test("a bible document leaves the structure, the lengths and every total", () => {
    const withBible = manuscript();
    withBible.push(item("bible", "bible", null, "Bible"));
    withBible.push(item("synopsis", "note", "bible", "Synopsis"));
    // A note IS a document and the host DOES hold a count for it in the index --
    // it is excluded by id, not absent. So the fixture supplies one: a build
    // that stopped excluding it would otherwise fail nothing here.
    const stats = computeStatistics(
      input({ items: withBible, perDoc: { ...COUNTS, synopsis: count(9999, 1, 1) } }),
    );
    expect(stats.structure.scenes).toBe(4);
    expect(stats.manuscript.words).toBe(650);
    expect(stats.lengths.uncounted).toBe(0);
  });

  test("a chapter a writer keeps in the bible is not one of the book's chapters", () => {
    // The whole SUBTREE, not the root row. A fixture holding only the `bible`
    // row passes against a filter that drops that one type and nothing under it.
    const withBible = manuscript();
    withBible.push(item("bible", "bible", null, "Bible"));
    withBible.push(item("ch-notes", "chapter", "bible", "Timeline"));
    const before = computeStatistics(input({ items: manuscript() }));
    const after = computeStatistics(input({ items: withBible }));
    expect(after.structure.chapters).toBe(before.structure.chapters);
  });
});

describe("by section", () => {
  // This accepts that a dedication's words count toward the daily goal, because
  // the whole-manuscript figure describes the FILE. This is the breakdown that
  // argument asked for instead of a filter: the total is untouched and the
  // three sections add up to it.
  function withMatter(): ProjectItem[] {
    return [
      ...manuscript(),
      item("front", "front", null, "Front matter"),
      item("dedication", "matter", "front", "Dedication"),
      item("back", "back", null, "Back matter"),
      item("thanks", "matter", "back", "Acknowledgements"),
    ];
  }
  const WITH = { ...COUNTS, dedication: count(12, 1, 1), thanks: count(40, 1, 1) };

  test("chapters, front and back add up to the whole manuscript", () => {
    const stats = computeStatistics(input({ items: withMatter(), perDoc: WITH }));
    expect(stats.manuscript.words).toBe(650 + 12 + 40);
    expect(stats.sections.chapters.words).toBe(650);
    expect(stats.sections.front.words).toBe(12);
    expect(stats.sections.back.words).toBe(40);
  });

  test("a book with no matter reports the sections as absent, not zero", () => {
    const stats = computeStatistics(input());
    expect(stats.sections.chapters.words).toBe(650);
    expect(stats.sections.front).toEqual({ state: "absent", words: null, title: null });
    expect(stats.sections.back).toEqual({ state: "absent", words: null, title: null });
  });

  test("a matter root the host could not count is uncounted, not zero", () => {
    const stats = computeStatistics(input({ items: withMatter(), perDoc: { ...COUNTS, thanks: count(40, 1, 1) } }));
    expect(stats.sections.front.state).toBe("uncounted");
    expect(stats.sections.back.words).toBe(40);
  });

  test("a matter row a writer moved inside a chapter is a chapter row, not a section", () => {
    // Root-level only, the same rule every other reserved root follows.
    const rows = [...manuscript(), item("stray", "front", "chapter-one", "Stray")];
    const stats = computeStatistics(input({ items: rows, perDoc: { ...COUNTS, stray: count(5, 1, 1) } }));
    expect(stats.sections.front.state).toBe("absent");
    expect(stats.sections.chapters.words).toBe(655);
  });

  test("the panel rows carry the section group with the absence spelled out", () => {
    const groups = statisticRows(computeStatistics(input()));
    const section = groups.find((g) => g.rows.some((r) => r.key === "front"));
    expect(section).toBeDefined();
    const front = section!.rows.find((r) => r.key === "front")!;
    expect(front.detail).toContain("no front matter");
    expect(section!.rows.map((r) => r.key)).toEqual(["chapters-words", "front", "back"]);
  });
});


describe("saved word sources", () => {
  const sources: SourceWordSummary = {
    available: true, collecting: true, interrupted: false, started_at: 1_600_000_000_000, today_typing: -2, warning: null,
    totals: { typing: { added: 8, deleted: 10 }, pasted: { added: 200, deleted: 20 },
      imported: { added: 50, deleted: 0 }, restored: { added: 0, deleted: 5 },
      unattributed: { added: 0, deleted: 0 } },
  };
  test("keeps sources distinct, discloses saved movement and leaves session figures intact", () => {
    const groups = statisticRows(computeStatistics(input({ today: { writingMinutes: 1, tracking: "on", sources } })));
    const rows = groups.flatMap((group) => group.rows);
    const typing = rows.find((row) => row.key === "source-typing")!;
    expect(typing.raw).toBe(-2);
    expect(typing.detail).toBe("Added 8; removed 10.");
    expect(typing.definition).toContain(`Measurement started ${formatDateTime(1_600_000_000_000)};`);
    expect(typing.definition).not.toContain("T12:26:40");
    expect(typing.definition).toContain("not a keystroke count");
    expect(rows.find((row) => row.key === "source-pasted")?.raw).toBe(180);
    expect(rows.find((row) => row.key === "typing-today")?.raw).toBe(-2);
    expect(rows.some((row) => row.key === "source-unattributed")).toBe(false);
    expect(rows.find((row) => row.key === "net")?.raw).toBe(0);
  });
  test("unavailable statistics show a warning without inventing zero source totals", () => {
    const groups = statisticRows(computeStatistics(input({ today: { writingMinutes: 1, tracking: "on",
      sources: { ...sources, available: false, today_typing: null, warning: "invalid ledger" } } })));
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.key === "sources-unavailable")?.raw).toBeNull();
    expect(rows.some((row) => row.key === "source-typing")).toBe(false);
  });
});
