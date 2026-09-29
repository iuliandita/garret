import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { mountBibleSection } from "../src/bible-section";
import { bibleEntriesIn, bibleParentFor, visibleBibleEntries } from "../src/bible-rows";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, type: string, depth: number, title = id): ProjectItem => ({
  id, type, depth, title, parent_id: null, position: id, rev: 1, state: null,
});
const under = (row: ProjectItem, parent: string): ProjectItem => ({ ...row, parent_id: parent });

let container: HTMLElement | null = null;
afterEach(() => { container?.remove(); container = null; });

describe("Bible shortcuts", () => {
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

  test("folders remain visible when empty and hide descendants, not following siblings", () => {
    const rows = [item("bible", "bible", 0), under(item("folder", "bible-folder", 1), "bible"), under(item("note", "note", 2), "folder"), under(item("loose", "note", 1), "bible")];
    const entries = bibleEntriesIn(rows);
    expect(entries.map((entry) => entry.item.id)).toEqual(["folder", "note", "loose"]);
    expect(visibleBibleEntries(entries, new Set(["folder"])).map((entry) => entry.item.id)).toEqual(["folder", "loose"]);
    expect(visibleBibleEntries(bibleEntriesIn([item("bible", "bible", 0), under(item("empty", "bible-folder", 1), "bible")]), new Set()).map((entry) => entry.item.id)).toEqual(["empty"]);
  });

  test("folder toggle selects canonically, keeps focus by id, and active documents reopen ancestors", () => {
    container = document.createElement("div"); document.body.append(container);
    const selected: string[] = [];
    const opened: string[] = [];
    const rows = [item("bible", "bible", 0), under(item("folder", "bible-folder", 1), "bible"), under(item("note", "note", 2), "folder"), under(item("loose", "note", 1), "bible")];
    const section = mountBibleSection({ container, items: rows, bibleRows: 2, onSelect: (id) => selected.push(id), onOpen: (id) => opened.push(id) });
    const folder = container.querySelector<HTMLButtonElement>("[data-bible-id='folder']");
    folder?.focus(); folder?.click();
    expect(selected).toEqual(["folder"]);
    expect(opened).toEqual([]);
    expect(container.querySelectorAll("#bible-list button")).toHaveLength(2);
    expect(container.querySelector("[data-bible-id='folder']")?.getAttribute("aria-expanded")).toBe("false");
    expect((document.activeElement as HTMLElement).dataset.bibleId).toBe("folder");
    section.setActiveId("note");
    expect(container.querySelector("[data-bible-id='folder']")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-bible-id='note']")?.getAttribute("aria-current")).toBe("true");
    expect((document.activeElement as HTMLElement).dataset.bibleId).toBe("folder");
    section.setItems([rows[0]!, { ...rows[1]!, title: "Renamed folder" }, rows[2]!, rows[3]!]);
    expect((document.activeElement as HTMLElement).dataset.bibleId).toBe("folder");
    expect(container.querySelector("[data-bible-id='folder']")?.textContent).toBe("Renamed folder");
    container.querySelector<HTMLButtonElement>("[data-bible-id='note']")?.click();
    expect(selected.at(-1)).toBe("folder");
    expect(opened).toEqual(["note"]);
    section.destroy();
  });
  test("keeps nested documents from the first root-level Bible in walk order", () => {
    const nestedRoot = item("other", "bible", 2);
    nestedRoot.parent_id = "one";
    const rows = [item("bible", "bible", 0), item("one", "note", 1), item("two", "note", 2), nestedRoot, item("three", "note", 3)];
    expect(bibleEntriesIn(rows).map((entry) => entry.item.id)).toEqual(["one", "two", "three"]);
  });

  test("opens a native button, preserves scroll on activation, and rebuilds only on reload", () => {
    container = document.createElement("div");
    document.body.append(container);
    const opened: string[] = [];
    const section = mountBibleSection({
      container,
      items: [item("bible", "bible", 0), item("one", "note", 1, "Old title"), item("two", "note", 1)],
      bibleRows: 99,
      onSelect: () => undefined,
      onOpen: (id) => opened.push(id),
    });
    const list = container.querySelector<HTMLElement>("#bible-list");
    if (list === null) throw new Error("missing Bible list");
    list.scrollTop = 18;
    const first = container.querySelector<HTMLButtonElement>("[data-bible-id='one']");
    if (first === null) throw new Error("missing Bible button");
    first.click();
    section.setActiveId("two");
    expect(opened).toEqual(["one"]);
    expect(list.scrollTop).toBe(18);
    expect(container.querySelector("[data-bible-id='two']")?.getAttribute("aria-current")).toBe("true");
    section.setItems([item("bible", "bible", 0), item("two", "note", 1, "New title")]);
    expect(container.querySelectorAll("#bible-list button").length).toBe(1);
    expect(container.querySelector("[data-bible-id='two']")?.textContent).toBe("New title");
    expect(container.querySelector<HTMLElement>("#bible-section")?.style.getPropertyValue("--bible-visible-rows")).toBe("5");
    section.setBibleRows(20);
    expect(container.querySelector<HTMLElement>("#bible-section")?.style.getPropertyValue("--bible-visible-rows")).toBe("20");
    section.destroy();
  });

  test("stays hidden without a root-level Bible", () => {
    container = document.createElement("div");
    document.body.append(container);
    const nested = item("bible", "bible", 1);
    nested.parent_id = "scene";
    const section = mountBibleSection({ container, items: [nested, item("note", "note", 2)], bibleRows: 5, onSelect: () => undefined, onOpen: () => undefined });
    expect(container.querySelector<HTMLElement>("#bible-section")?.hidden).toBe(true);
    section.destroy();
  });
});
