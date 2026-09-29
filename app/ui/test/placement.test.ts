import { describe, expect, test } from "bun:test";
import {
  BACK_MATTER_TYPE,
  BIBLE_TYPE,
  FRONT_MATTER_TYPE,
  MATTER_TYPE,
  NOTE_TYPE,
  TRASH_TYPE,
} from "../src/item-types";
import { chapterItemsIn } from "../src/outline";
import { adoptionPreservesOrder, lastManuscriptRootId, planAdoption, planPlacement } from "../src/placement";
import type { ProjectItem } from "../src/store/source";

const item = (
  id: string,
  parent: string | null,
  depth: number,
  type: string,
): ProjectItem => ({
  id,
  parent_id: parent,
  type,
  title: id,
  position: "0000",
  rev: 1,
  state: null,
  depth,
});

/** The shape the design's own example describes.
 *
 *   Part One
 *     Chapter 2
 *       scene 1
 *   Part Two
 */
const book = (): ProjectItem[] => [
  item("p1", null, 0, "part"),
  item("c2", "p1", 1, "chapter"),
  item("s1", "c2", 2, "scene"),
  item("p2", null, 0, "part"),
];

/** The tree in the bug report, which is the case that matters most: a SCENE at
 *  depth 0 with structure beneath it. A fixture whose types agree with its
 *  depths cannot falsify a rule that reads depth instead of type - the recorded
 *  trap that bit the navigator's type tests.
 *
 *   scene 1
 *     UNTITLED PART
 *     Untitled chapter
 *   scene 2
 */
const reported = (): ProjectItem[] => [
  item("sc1", null, 0, "scene"),
  item("pt", "sc1", 1, "part"),
  item("ch", "sc1", 1, "chapter"),
  item("sc2", null, 0, "scene"),
];

describe("planPlacement: a book with nothing in it yet", () => {
  // THE REPORTED DEFECT, 2026-08-27. A new book holds one scene and no part, so
  // the type-aware rule had nowhere to put a chapter and dropped it at the root
  // beside the starter scene -- and the part created next was then placed after
  // THAT, so it appeared below the chapter it was meant to contain. Every step
  // correct by the rule, and three flat siblings in an order that reads
  // backwards.
  //
  // NONE OF THE FIXTURES ABOVE START FROM AN EMPTY BOOK. Every one of them opens
  // with a part, which is exactly why a mutation pass could not see this.
  const newBook = (): ProjectItem[] => [item("s1", null, 0, "scene")];

  test("a chapter with no part to live in MAKES one", () => {
    expect(planPlacement(newBook(), "s1", "chapter")).toEqual({
      holders: ["part"],
      parentId: null,
      afterId: "s1",
    });
  });

  test("a scene in a bare book stays flat and gains NO ancestors", () => {
    // A flat book of scenes is a book a writer is allowed to have, and the
    // product spec makes the hierarchy arbitrary on purpose. Two rows from one
    // press is the most this rule will ever do, and a scene is not the press
    // that earns it.
    expect(planPlacement(newBook(), "s1", "scene")).toEqual({
      holders: [],
      parentId: null,
      afterId: "s1",
    });
  });

  test("a part in a bare book is still just a part", () => {
    expect(planPlacement(newBook(), "s1", "part")).toEqual({
      holders: [],
      parentId: null,
      afterId: "s1",
    });
  });

  test("nothing selected in a bare book still makes the part", () => {
    expect(planPlacement(newBook(), null, "chapter")).toEqual({
      holders: ["part"],
      parentId: null,
      afterId: null,
    });
  });

  test("a chapter that HAS a part does not make a second one", () => {
    // The control, and the mutation this test exists for: a rule that always
    // built a holder would double every part in the book.
    expect(planPlacement(book(), "s1", "chapter")).toEqual({
      holders: [],
      parentId: "p1",
      afterId: "c2",
    });
  });

  test("the reported tree makes a part for its chapter too", () => {
    // `reported()` has a chapter INSIDE a scene and no part anywhere, which is
    // the same shortage in a book that is not empty.
    expect(planPlacement(reported(), "sc1", "chapter")).toEqual({
      holders: ["part"],
      parentId: null,
      afterId: "sc1",
    });
  });
});

describe("planPlacement: a new part", () => {
  test("goes to the root, after the top-level item the writer is inside", () => {
    expect(planPlacement(book(), "s1", "part")).toEqual({ holders: [], parentId: null, afterId: "p1" });
  });

  test("goes to the root even when the selection is a part", () => {
    // A part inside a part is legal in this product and is not what pressing
    // New part means.
    expect(planPlacement(book(), "p1", "part")).toEqual({ holders: [], parentId: null, afterId: "p1" });
  });

  test("appends at the root with nothing selected", () => {
    expect(planPlacement(book(), null, "part")).toEqual({ holders: [], parentId: null, afterId: null });
  });
});

describe("planPlacement: a new chapter", () => {
  test("goes inside the nearest part, after the group the writer is in", () => {
    expect(planPlacement(book(), "s1", "chapter")).toEqual({ holders: [], parentId: "p1", afterId: "c2" });
  });

  test("appends inside the part when the part itself is selected", () => {
    expect(planPlacement(book(), "p1", "chapter")).toEqual({ holders: [], parentId: "p1", afterId: null });
  });

  test("MAKES a part when nothing above the selection is one", () => {
    // The reported tree. `ch` is a chapter inside a SCENE; a new chapter must
    // not be swallowed by that scene.
    //
    // RENAMED AND REWRITTEN. It used to assert the chapter fell
    // to the root, which is exactly the reported defect: a chapter at the
    // root beside the starter scene, with no indentation and nowhere to belong.
    // It now builds the part it needs. The claim the old name made -- that the
    // selected scene does not swallow it -- is unchanged and is still asserted
    // by `parentId: null`.
    expect(planPlacement(reported(), "sc1", "chapter")).toEqual({
      holders: ["part"],
      parentId: null,
      afterId: "sc1",
    });
  });
});

describe("planPlacement: a new scene", () => {
  test("lands beside the selected scene, inside its chapter", () => {
    expect(planPlacement(book(), "s1", "scene")).toEqual({ holders: [], parentId: "c2", afterId: "s1" });
  });

  test("appends inside the chapter when the chapter itself is selected", () => {
    expect(planPlacement(book(), "c2", "scene")).toEqual({ holders: [], parentId: "c2", afterId: null });
  });

  test("falls back to the nearest PART when there is no chapter", () => {
    // Distinct from the root fallback, and the arm most likely to be dropped by
    // someone simplifying the rule: a scene under a part with no chapter in
    // between belongs in that part, not at the root.
    const noChapter: ProjectItem[] = [
      item("p1", null, 0, "part"),
      item("s1", "p1", 1, "scene"),
    ];
    expect(planPlacement(noChapter, "s1", "scene")).toEqual({ holders: [], parentId: "p1", afterId: "s1" });
  });

  test("falls back to the root when there is neither", () => {
    // The exact act in the bug report: one scene at the root, press New scene.
    expect(planPlacement(reported(), "sc1", "scene")).toEqual({
      holders: [],
      parentId: null,
      afterId: "sc1",
    });
  });
});

describe("planPlacement: the reported tree, every type", () => {
  // All three at once, because the report was that all three behaved the same
  // way and all three were wrong. Asserting one of them would leave the other
  // two free to regress.
  test("nothing is created inside the selected scene", () => {
    // THE CLAIM IS `parentId`, asserted per type rather than as a whole object:
    // a chapter also carries a holder to build, and an equality
    // assertion would have made this test about that instead of about the
    // swallowing it exists to forbid.
    for (const type of ["part", "chapter", "scene"]) {
      const place = planPlacement(reported(), "sc1", type);
      expect(place.parentId, `${type} was created inside the selected scene`).toBeNull();
      expect(place.afterId, `${type} did not follow the selection`).toBe("sc1");
    }
  });
});

describe("planPlacement: refusals and edges", () => {
  test("a selection the walk does not contain appends at the root", () => {
    // Not an error: the caller asked about a row that has since gone, and
    // appending at the root is the same answer as no selection at all.
    expect(planPlacement(book(), "gone", "scene")).toEqual({ holders: [], parentId: null, afterId: null });
  });

  test("an empty walk appends at the root", () => {
    expect(planPlacement([], "anything", "scene")).toEqual({ holders: [], parentId: null, afterId: null });
  });

  test("a broken parent chain stops at the root rather than looping", () => {
    // A row naming a parent the walk does not hold. The ancestor climb must
    // terminate; a `while (parent)` that trusts the walk would spin.
    const orphan: ProjectItem[] = [item("s1", "missing", 1, "scene")];
    expect(planPlacement(orphan, "s1", "chapter")).toEqual({
      holders: ["part"],
      parentId: null,
      afterId: null,
    });
  });

  test("a cycle in the walk terminates, with an answer", () => {
    // Cannot reach the page through the store's walk, which is anchored at
    // parent_id IS NULL - but this function is handed a list, and a list is not
    // a promise.
    //
    // ASSERTS THE ANSWER, not merely that it returns. `not.toThrow()` was the
    // first version and it was a trap: a mutation removing the guard makes this
    // HANG rather than fail, and a mutation pass cannot tell a hang from a pass
    // - the recorded failure, hit from the other side, at the cost of a
    // twenty-minute stall.
    //
    // THIS TEST CANNOT KILL THE TERMINATION GUARD and does not claim to. The
    // answer on a cyclic walk is the same whether the climb stops at the cycle
    // or one step later, because the extra pass only appends a duplicate to the
    // tail. What catches a removed bound is the harness timeout. What this pins
    // is that a cycle produces the root answer rather than a crash.
    const cycle: ProjectItem[] = [
      item("a", "b", 0, "scene"),
      item("b", "a", 0, "scene"),
    ];
    expect(planPlacement(cycle, "a", "chapter")).toEqual({
      holders: ["part"],
      parentId: null,
      afterId: null,
    });
  });

  test("an unknown item type is placed like a scene", () => {
    // The store accepts any type string and a newer build's fourth type must
    // arrive as data, not as a crash. Treated as the leaf case, which is the
    // conservative answer: it lands beside the selection rather than swallowing
    // anything.
    expect(planPlacement(book(), "s1", "note")).toEqual({ holders: [], parentId: "c2", afterId: "s1" });
  });
});

describe("planAdoption: the book's first part takes the chapters in", () => {
  // THE SECOND HALF OF THE OWNER'S RULE OF 2026-08-27: "chapters inside parts,
  // scenes inside chapters". With a chapter in every new book (that move is
  // into the host), the first New part in any book meets root-level chapters --
  // and a part created beside them reads as an empty part misfiled below the
  // work it was meant to hold, which is the exact screenshot this answers.
  //
  // SEPARATE FROM `planPlacement`, and deliberately: placement answers where
  // the new row goes, adoption answers what moves into it. They are computed
  // from different halves of the walk (the selection's ancestry; the root
  // group) and one of them is a create while the other is a move.

  /** A book in its usual shape, plus a second chapter the writer added.
   *
   *   Chapter 1
   *     Scene 1
   *   Chapter 2
   */
  const unorganized = (): ProjectItem[] => [
    item("ch1", null, 0, "chapter"),
    item("s1", "ch1", 1, "scene"),
    item("ch2", null, 0, "chapter"),
  ];

  test("a first part adopts the root chapters, in walk order", () => {
    expect(planAdoption(unorganized(), ["part"])).toEqual(["ch1", "ch2"]);
  });

  test("a part in a book that HAS one adopts nothing", () => {
    // THE BRIGHT LINE, and the whole of what bounds this rule's blast radius.
    // A writer with a part in their book has shown they know what parts are;
    // a second one is an empty container they are about to fill themselves,
    // and sweeping every loose chapter into it would restructure a book that
    // is already structured. Adoption can therefore happen at most once in the
    // life of a manuscript.
    const halfOrganized: ProjectItem[] = [
      item("p1", null, 0, "part"),
      item("cin", "p1", 1, "chapter"),
      item("ch2", null, 0, "chapter"),
    ];
    expect(planAdoption(halfOrganized, ["part"])).toEqual([]);
  });

  test("a part anywhere counts, not only one at the root", () => {
    // The reported tree has a part INSIDE a scene. It is a part the
    // writer put there, so this book is not the untouched one this rule is for.
    const nested: ProjectItem[] = [
      item("sc1", null, 0, "scene"),
      item("pt", "sc1", 1, "part"),
      item("ch1", null, 0, "chapter"),
    ];
    expect(planAdoption(nested, ["part"])).toEqual([]);
  });

  test("chapters that already live inside something are left alone", () => {
    // Only the HOMELESS ones move. A chapter inside a scene is where a writer
    // put it, and the product spec makes that legal.
    const housed: ProjectItem[] = [
      item("sc1", null, 0, "scene"),
      item("inner", "sc1", 1, "chapter"),
      item("ch1", null, 0, "chapter"),
    ];
    expect(planAdoption(housed, ["part"])).toEqual(["ch1"]);
  });

  test("root scenes are NOT adopted", () => {
    // Scenes are optional and a flat book of scenes is one a writer is allowed
    // to have. A part is not a scene's conventional holder in the first
    // instance -- a chapter is -- so sweeping loose scenes into a part would be
    // this rule inventing containment nobody asked for.
    const mixed: ProjectItem[] = [
      item("s0", null, 0, "scene"),
      item("ch1", null, 0, "chapter"),
      item("note", null, 0, "note"),
    ];
    expect(planAdoption(mixed, ["part"])).toEqual(["ch1"]);
  });

  test("a chapter press that BUILDS its part adopts too", () => {
    // The holder is a part like any other, and the press that creates it is
    // the commonest way a book gets its first one. Keying on the TYPES BEING
    // CREATED rather than on the type the writer asked for is what makes the
    // two paths agree: New chapter in an unorganized book yields one part
    // holding every chapter, not a part holding only the new one.
    expect(planAdoption(unorganized(), ["part", "chapter"])).toEqual(["ch1", "ch2"]);
  });

  test("a chapter press with no part to build adopts nothing", () => {
    // The control for the test above: the same book, the same requested type,
    // and no part in the list of things being created because one already
    // exists. Without this a rule reading the REQUESTED type would pass both.
    const organized: ProjectItem[] = [
      item("p1", null, 0, "part"),
      item("ch1", null, 0, "chapter"),
    ];
    expect(planAdoption(organized, ["chapter"])).toEqual([]);
  });

  test("a new scene adopts nothing", () => {
    expect(planAdoption(unorganized(), ["scene"])).toEqual([]);
  });

  test("an empty walk adopts nothing", () => {
    expect(planAdoption([], ["part"])).toEqual([]);
  });
});

describe("a selection inside a section that is not the manuscript", () => {
  /** A book with a bible after it, which is where a lazily created second root
   *  lands: roots append, so the bible sits at the end of the root group. */
  const withBible = (): ProjectItem[] => [
    item("ch1", null, 0, "chapter"),
    item("s1", "ch1", 1, "scene"),
    item("bible", null, 0, BIBLE_TYPE),
    item("synopsis", "bible", 1, NOTE_TYPE),
  ];

  test("a new scene created from a bible row lands in the manuscript, not after the bible", () => {
    const place = planPlacement(withBible(), "synopsis", "scene");
    // The bible is not an ancestor a manuscript row can follow. Following it
    // puts the writer's new scene BELOW their whole world-building section, at
    // the bottom of the navigator, which is the same screenshot with a different
    // root in it.
    expect(place.parentId).toBe(null);
    expect(place.afterId).toBe("ch1");
  });

  test("a new chapter created from a bible row does not build its part after the bible", () => {
    const place = planPlacement(withBible(), "synopsis", "chapter");
    expect(place.holders).toEqual(["part"]);
    expect(place.parentId).toBe(null);
    expect(place.afterId).toBe("ch1");
  });

  test("appending at the root lands before the bible and the bin, never after them", () => {
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("bible", null, 0, BIBLE_TYPE),
      item("bin", null, 0, TRASH_TYPE),
    ];
    // Nothing selected: the answer used to be "append", which puts a manuscript
    // row after both reserved sections.
    expect(planPlacement(walk, null, "part").afterId).toBe("ch1");
  });

  test("a book with nothing but a bible appends at the root", () => {
    const walk: ProjectItem[] = [item("bible", null, 0, BIBLE_TYPE)];
    expect(planPlacement(walk, null, "scene").afterId).toBe(null);
  });

  test("a note is placed beside the note it was created from, inside the bible", () => {
    // `HOLDERS` has never heard of a note, and its unknown-type answer -- the
    // next sibling of the selection -- is the right one here: it keeps the new
    // document in the section the writer is looking at.
    const place = planPlacement(withBible(), "synopsis", NOTE_TYPE);
    expect(place.holders).toEqual([]);
    expect(place.parentId).toBe("bible");
    expect(place.afterId).toBe("synopsis");
  });
});

describe("planAdoption and the bible", () => {
  test("a chapter parked in the bible is not adopted by the book's first part", () => {
    // The caller passes the MANUSCRIPT walk for exactly this reason, and the
    // fixture is the one that can tell the two filters apart: a chapter at the
    // root of the BIBLE is `parent_id === null`-adjacent in shape only.
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("bible", null, 0, BIBLE_TYPE),
      item("ch-notes", "bible", 1, "chapter"),
    ];
    expect(planAdoption(walk, ["part"])).toEqual(["ch1"]);
  });

  test("the bible root is never adopted, whatever it holds", () => {
    const walk: ProjectItem[] = [item("bible", null, 0, BIBLE_TYPE)];
    expect(planAdoption(walk, ["part"])).toEqual([]);
  });
});

describe("planAdoption and the matter sections", () => {
  /** THE THIRD RESERVED ROOT BROKE THIS FILTER, and this is the fixture that
   *  says so. `manuscriptItemsIn` -- what the caller passed before -- KEEPS
   *  front matter, because front matter is in the book. So a `part` a writer
   *  parked in their front matter would satisfy "this book already has a part"
   *  and suppress adoption forever, leaving every root chapter homeless: a
   *  screenshot, restored by a filter that was one root type short for
   *  the second time. The caller reads `chapterItemsIn` now. */
  test("a part inside the front matter does not suppress the book's first adoption", () => {
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("front", null, 0, FRONT_MATTER_TYPE),
      item("p-front", "front", 1, "part"),
    ];
    expect(planAdoption(chapterItemsIn(walk), ["part"])).toEqual(["ch1"]);
  });

  test("a chapter parked in the back matter is not adopted by the book's first part", () => {
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("back", null, 0, BACK_MATTER_TYPE),
      item("ch-thanks", "back", 1, "chapter"),
    ];
    expect(planAdoption(chapterItemsIn(walk), ["part"])).toEqual(["ch1"]);
  });
});

describe("a selection inside a matter section", () => {
  /** A book with both matter sections after it. They append like every other
   *  reserved root, so they sit at the end of the root group -- where they print
   *  is decided by their TYPE, not by where the navigator shows them. */
  const withMatter = (): ProjectItem[] => [
    item("ch1", null, 0, "chapter"),
    item("s1", "ch1", 1, "scene"),
    item("front", null, 0, FRONT_MATTER_TYPE),
    item("dedication", "front", 1, MATTER_TYPE),
    item("back", null, 0, BACK_MATTER_TYPE),
    item("thanks", "back", 1, MATTER_TYPE),
  ];

  test("a new scene created from a dedication lands in the manuscript, not after the section", () => {
    const place = planPlacement(withMatter(), "dedication", "scene");
    expect(place.parentId).toBe(null);
    expect(place.afterId).toBe("ch1");
  });

  test("a new chapter created from an acknowledgements page does not build its part after it", () => {
    const place = planPlacement(withMatter(), "thanks", "chapter");
    expect(place.holders).toEqual(["part"]);
    expect(place.parentId).toBe(null);
    expect(place.afterId).toBe("ch1");
  });

  test("appending at the root lands above every reserved section, all four of them", () => {
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("front", null, 0, FRONT_MATTER_TYPE),
      item("back", null, 0, BACK_MATTER_TYPE),
      item("bible", null, 0, BIBLE_TYPE),
      item("bin", null, 0, TRASH_TYPE),
    ];
    expect(planPlacement(walk, null, "part").afterId).toBe("ch1");
  });

  test("a book with nothing but a matter section appends at the root", () => {
    const walk: ProjectItem[] = [item("front", null, 0, FRONT_MATTER_TYPE)];
    expect(planPlacement(walk, null, "scene").afterId).toBe(null);
  });

  test("a matter document is placed beside the one it was created from", () => {
    const place = planPlacement(withMatter(), "dedication", MATTER_TYPE);
    expect(place.holders).toEqual([]);
    expect(place.parentId).toBe("front");
    expect(place.afterId).toBe("dedication");
  });
});

describe("a reserved type that is not a root", () => {
  test("a bible row inside a scene is a row, not a section", () => {
    // ROOT-LEVEL ONLY, matching the host's `root_subtree_ids`. Keying on the
    // type alone would let one hand-moved row change where every later create
    // lands, and would make the append point skip past the writer's own work.
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("s1", "ch1", 1, "scene"),
      item("decoy", "s1", 2, BIBLE_TYPE),
    ];
    // The chain ends at `ch1`, a real manuscript root, so the part follows it.
    expect(planPlacement(walk, "decoy", "part").afterId).toBe("ch1");
    // And a create with nothing selected still appends, because the last root
    // is the manuscript's own.
    expect(planPlacement(walk, null, "part").afterId).toBe(null);
  });
});

describe("a reserved type on a row that is not a root because its parent is gone", () => {
  test("an orphaned bible row is not a section, and the create still appends", () => {
    // `planPlacement` is handed a LIST, and the module's own note says a list is
    // not a promise -- which is why it already carries a branch for a chain that
    // ended because a parent was MISSING rather than because it reached a root.
    // `isReservedRoot` has to make the same distinction: a `bible` row with a
    // parent the walk does not hold is a row whose place nobody knows, not a
    // section a manuscript create must be filed before.
    //
    // The fixture needs all three rows. Without the real bible root the append
    // point is `null` either way, and the two implementations agree.
    const walk: ProjectItem[] = [
      item("ch1", null, 0, "chapter"),
      item("bible", null, 0, BIBLE_TYPE),
      { ...item("orphan", "gone", 1, BIBLE_TYPE) },
    ];
    expect(planPlacement(walk, "orphan", "part").afterId).toBe(null);
    // The control, one row along: the real section IS one, and a create from
    // inside it lands after the manuscript rather than after the bible.
    expect(planPlacement(walk, "bible", "part").afterId).toBe("ch1");
  });
});

describe("lastManuscriptRootId", () => {
  test("a walk ending in the bible and the bin returns the last part", () => {
    const walk: ProjectItem[] = [
      item("p1", null, 0, "part"),
      item("p2", null, 0, "part"),
      item("bible", null, 0, BIBLE_TYPE),
      item("bin", null, 0, TRASH_TYPE),
    ];
    expect(lastManuscriptRootId(walk)).toBe("p2");
  });

  test("a walk of only reserved roots returns null", () => {
    const walk: ProjectItem[] = [
      item("bible", null, 0, BIBLE_TYPE),
      item("bin", null, 0, TRASH_TYPE),
    ];
    expect(lastManuscriptRootId(walk)).toBe(null);
  });

  test("an empty walk returns null", () => {
    expect(lastManuscriptRootId([])).toBe(null);
  });
});


describe("automatic adoption preserves the existing root order", () => {
  const roots = (types: string[]): ProjectItem[] => types.map((type, i) => item(String(i), null, 0, type));
  const safe = (items: ProjectItem[], afterId: string | null): boolean =>
    adoptionPreservesOrder(items, planAdoption(items, ["part"]), { holders: [], parentId: null, afterId });

  test("interleaved scenes cannot move across either chapter at any insertion gap", () => {
    const items = roots(["chapter", "scene", "chapter"]);
    for (const after of ["0", "1", "2", null]) expect(safe(items, after)).toBe(false);
  });

  test("a contiguous block is safe only at its own insertion gaps", () => {
    const items = roots(["scene", "chapter", "chapter", "note", "scene"]);
    for (const after of ["0", "1", "2"]) expect(safe(items, after)).toBe(true);
    for (const after of ["3", "4", null]) expect(safe(items, after)).toBe(false);
  });

  test("append keeps a trailing chapter block and its descendants in order", () => {
    const items = roots(["scene", "chapter", "chapter"]);
    items.splice(2, 0, item("inside", "1", 1, "scene"));
    expect(safe(items, null)).toBe(true);
    expect(safe(items, "0")).toBe(true);
  });

  test("append must not mean first, and an early insertion must not mean append", () => {
    const items = roots(["scene", "note", "chapter"]);
    expect(safe(items, null)).toBe(true);
    expect(safe(items, "0")).toBe(false);
  });

  test("reserved root rows cannot be crossed", () => {
    const items = roots(["chapter", BIBLE_TYPE]);
    expect(safe(items, "0")).toBe(true);
    expect(safe(items, null)).toBe(false);
  });

  test("unknown anchors and non-root destinations refuse adoption", () => {
    const items = roots(["chapter"]);
    expect(safe(items, "missing")).toBe(false);
    expect(adoptionPreservesOrder(items, ["0"], { holders: [], parentId: "0", afterId: null })).toBe(false);
    expect(adoptionPreservesOrder(items, [], { holders: [], parentId: "0", afterId: null })).toBe(true);
  });
});
