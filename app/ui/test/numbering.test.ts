import { describe, expect, test } from "bun:test";
import { nextNumberedTitle, numberIn } from "../src/numbering";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, type: string, title: string): ProjectItem => ({
  id,
  parent_id: null,
  type,
  title,
  position: "0000",
  rev: 1,
  state: null,
  depth: 0,
});

describe("numberIn", () => {
  // The parser is built from the SAME catalog pattern the writer produces, so a
  // translated build reads back what it wrote. These drive it with the pattern
  // explicitly rather than through the catalog, so the rule is testable without
  // pinning English.
  test("reads the number out of a title the pattern produced", () => {
    expect(numberIn("Chapter {n}", "Chapter 4")).toBe(4);
  });

  test("a title the pattern did not produce has no number", () => {
    expect(numberIn("Chapter {n}", "The Harbour")).toBeNull();
  });

  test("a partial match is not a match", () => {
    // Anchored at both ends. Without that, "Chapter 4 revisited" frees no
    // number and consumes one.
    expect(numberIn("Chapter {n}", "Chapter 4 revisited")).toBeNull();
    expect(numberIn("Chapter {n}", "Draft of Chapter 4")).toBeNull();
  });

  test("a metacharacter BEFORE the number is matched literally", () => {
    // A catalog is translated text, not a regex. A locale whose word for a part
    // ends in a period would otherwise match every character in that position.
    //
    // The counter-example is `KapX 3`, NOT `KapX3`: an unescaped `Kap. ` reads
    // as "Kap, any character, space", which `KapX3` fails on the missing space
    // alone. The first version of this test used `KapX3` and passed against an
    // unescaped prefix -- it was asserting the space, not the escaping, and only
    // the mutation pass saw it.
    expect(numberIn("Kap. {n}", "Kap. 3")).toBe(3);
    expect(numberIn("Kap. {n}", "KapX 3")).toBeNull();
  });

  test("a metacharacter AFTER the number is matched literally too", () => {
    // Its own test, because the two sides are escaped by two calls and a build
    // that escaped only the prefix passed everything written for the prefix.
    expect(numberIn("{n}. rész", "4. rész")).toBe(4);
    expect(numberIn("{n}. rész", "4X rész")).toBeNull();
  });

  test("a pattern where the number leads still works", () => {
    // Several languages put the ordinal first. A parser that assumed a suffix
    // would silently number every item 1 in those builds.
    expect(numberIn("{n}. fejezet", "7. fejezet")).toBe(7);
  });

  test("zero and negatives are not numbers this rule produces", () => {
    expect(numberIn("Chapter {n}", "Chapter 0")).toBeNull();
    expect(numberIn("Chapter {n}", "Chapter -2")).toBeNull();
  });
});

describe("nextNumberedTitle", () => {
  const pattern = "Chapter {n}";

  test("an empty project starts at one", () => {
    expect(nextNumberedTitle([], "chapter", pattern)).toBe("Chapter 1");
  });

  test("it takes the next number after the ones in use", () => {
    const items = [item("a", "chapter", "Chapter 1"), item("b", "chapter", "Chapter 2")];
    expect(nextNumberedTitle(items, "chapter", pattern)).toBe("Chapter 3");
  });

  test("it fills a GAP rather than counting", () => {
    // The whole of "next free available number", and the case a count-the-items
    // implementation gets wrong. With 1 and 3 in use, a count answers 3 - a
    // title that already exists.
    const items = [item("a", "chapter", "Chapter 1"), item("b", "chapter", "Chapter 3")];
    expect(nextNumberedTitle(items, "chapter", pattern)).toBe("Chapter 2");
  });

  test("renaming a chapter frees its number", () => {
    // A writer's own phrasing. `Chapter 1` renamed to a real title leaves 1
    // available, and a rule keyed on the item COUNT would never offer it again.
    const items = [item("a", "chapter", "The Harbour"), item("b", "chapter", "Chapter 2")];
    expect(nextNumberedTitle(items, "chapter", pattern)).toBe("Chapter 1");
  });

  test("only items of THIS type are counted", () => {
    // A scene called "Chapter 2" is a title a writer is allowed to give a
    // scene, and it must not consume the chapters' number 2.
    const items = [item("a", "scene", "Chapter 2"), item("b", "chapter", "Chapter 1")];
    expect(nextNumberedTitle(items, "chapter", pattern)).toBe("Chapter 2");
  });

  test("a trashed item still holds its number", () => {
    // Deliberate, and the argument is recoverability: a deleted chapter can be
    // restored, and restoring it beside a live chapter of the same name is a
    // confusion the writer did not create. Recorded rather than assumed.
    const items = [item("a", "chapter", "Chapter 1")];
    expect(nextNumberedTitle(items, "chapter", pattern)).toBe("Chapter 2");
  });

  test("duplicates do not skip two", () => {
    const items = [item("a", "chapter", "Chapter 1"), item("b", "chapter", "Chapter 1")];
    expect(nextNumberedTitle(items, "chapter", pattern)).toBe("Chapter 2");
  });

  test("a pattern with no placeholder answers the pattern itself", () => {
    // A catalog can be edited, and a build whose pattern lost its {n} must not
    // produce "Chapter NaN" or throw while a writer is pressing a menu item.
    //
    // There is no GUARD for this and there should not be: `numberIn` answers
    // null with no slot, so nothing is used, and `replace` on a string without
    // the slot returns it unchanged. The behaviour is real and worth pinning;
    // the early return that used to produce it was unreachable and was deleted.
    expect(nextNumberedTitle([], "chapter", "Chapter")).toBe("Chapter");
  });
});
