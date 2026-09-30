import { describe, expect, test } from "bun:test";

import { bibleParentFor } from "../src/bible-rows";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, type: string, depth: number, title = id): ProjectItem => ({
  id, type, depth, title, parent_id: null, position: id, rev: 1, state: null,
});
const under = (row: ProjectItem, parent: string): ProjectItem => ({ ...row, parent_id: parent });

describe("Bible placement", () => {
  test("new bible rows use the selected folder, a document's parent, or the bible root", () => {
    const rows = [
      item("manuscript", "scene", 0),
      item("bible", "bible", 0),
      under(item("folder", "bible-folder", 1), "bible"),
      under(item("note", "note", 2), "folder"),
      under(item("clock", "timeline", 2), "folder"),
      under(item("outside", "bible-folder", 1), "manuscript"),
    ];
    expect(bibleParentFor(rows, "folder", "bible")).toBe("folder");
    expect(bibleParentFor(rows, "note", "bible")).toBe("folder");
    expect(bibleParentFor(rows, "clock", "bible")).toBe("folder");
    expect(bibleParentFor(rows, "outside", "bible")).toBe("bible");
    expect(bibleParentFor(rows, "manuscript", "bible")).toBe("bible");
    expect(bibleParentFor(rows, null, "bible")).toBe("bible");
  });

});
