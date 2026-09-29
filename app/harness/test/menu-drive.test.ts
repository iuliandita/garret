import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogText,
  menuChord,
  menuDriver,
  menuItemCount,
  menuRoute,
  navContextIndex,
  navContextItemCount,
  resetMenuCache,
  resetNavContextCache,
} from "../src/menu-drive";

const REAL = "app/ui/src/menu-bar.ts";

function fixture(source: string, name = "menu-bar.ts"): string {
  const dir = mkdtempSync(join(tmpdir(), "menu-drive-"));
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

/** A table with the shape the parser depends on and none of the surrounding
 *  module. Twelve items, because the vacuity guard refuses fewer. `key` is
 *  the catalog key the menu reads its letter from, or a literal when a
 *  test wants the refused shape. */
function table(items: { menu: string; key: string; ids: string[] }[]): string {
  const blocks = items.map(
    (m) =>
      `    {\n      id: "${m.menu}",\n      label: "X",\n      key: ${m.key},\n      items: [\n` +
      m.ids.map((id) => `        { id: "${id}", label: () => "L", run: () => {} },`).join("\n") +
      `\n      ],\n    },`,
  );
  return `const MENUS = [\n${blocks.join("\n")}\n];\n`;
}

const FULL = [
  { menu: "menu-file", key: 't("menu.file.key")', ids: ["menu-a", "menu-b", "menu-c", "menu-d"] },
  { menu: "menu-edit", key: 't("menu.edit.key")', ids: ["menu-e", "menu-f", "menu-g"] },
  { menu: "menu-outline", key: 't("menu.outline.key")', ids: ["menu-h", "menu-i", "menu-j", "menu-k"] },
  { menu: "menu-help", key: 't("menu.help.key")', ids: ["menu-l"] },
];

beforeEach(() => {
  resetMenuCache();
});

describe("the menu source parses into routes", () => {
  test("the shipped menu yields a route for every item a rig drives", () => {
    // These four are the ids the graded rigs activate. A rename in menu-bar.ts
    // must move them here, and this is where that is noticed.
    for (const id of ["menu-export", "menu-preferences", "menu-project-open", "menu-find"]) {
      const route = menuRoute(id, REAL);
      expect(route.chord).toMatch(/^alt\+[a-z]$/);
      expect(route.index).toBeGreaterThanOrEqual(0);
    }
  });

  test("Export sits in the File menu and Find in the Edit menu", () => {
    expect(menuRoute("menu-export", REAL).menu).toBe("menu-file");
    expect(menuRoute("menu-export", REAL).chord).toBe("alt+f");
    expect(menuRoute("menu-find", REAL).menu).toBe("menu-edit");
    expect(menuRoute("menu-find", REAL).chord).toBe("alt+e");
  });

  test("the first item of a menu is zero ArrowDowns", () => {
    // Opening a menu highlights its first item, so the index is a press count
    // and not an ordinal. Getting this off by one moves every rig's Return onto
    // its neighbour.
    expect(menuRoute("menu-project-new", REAL).index).toBe(0);
    expect(menuRoute("menu-undo", REAL).index).toBe(0);
  });

  test("indices are consecutive within a menu", () => {
    // One change added Quit at the END, another added Rename project… at
    // index 2, another added Book design… at index 4, and another added
    // Export for an editor (Word)… at index 8, immediately after Export
    // as… -- each shifted every item below it. This list is the ONE place
    // that order is written down for the rigs, and a shift showing up here
    // is the guard working: `menu-cli` presses ArrowDown a counted number of
    // times and would otherwise silently activate a neighbour.
    //
    // `menu-export`'s OWN index (6) is UNCHANGED by that later addition: the
    // new item sits below it, which is the whole point of the placement rule
    // -- the debounce gate's headroom is `export-cli`'s walk DOWN to
    // `menu-export`, and nothing above it moved.
    //
    // A later change took the two statistics exports out (they are the
    // Statistics panel's footer now) and drew separators between five
    // groups. A separator is not an id, so it moved nothing; the two
    // removals moved every item below Export for an editor up by two.
    const file = ["menu-project-new", "menu-project-open", "menu-project-rename", "menu-import", "menu-book-design", "menu-covers", "menu-export", "menu-export-as", "menu-export-docx", "menu-epub-preview", "menu-pdf-preview", "menu-identities", "menu-backup-now", "menu-mirror-changes", "menu-library", "menu-preferences", "menu-privacy-lock", "menu-quit"];
    expect(file.map((id) => menuRoute(id, REAL).index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(menuRoute("menu-export", REAL).index).toBe(6);
  });

  test("the shipped menu is not parsed as a handful of stray matches", () => {
    // The guard inside the parser refuses fewer than 12; this asserts the real
    // file is comfortably past it, so a future guard failure means the source
    // changed rather than the threshold being marginal.
    expect(menuItemCount(REAL)).toBeGreaterThanOrEqual(15);
  });

  test("an unknown id is refused, naming what the menu does hold", () => {
    expect(() => menuRoute("menu-nonesuch", REAL)).toThrow(/no menu item "menu-nonesuch"/);
  });
});

describe("the parser refuses a source it cannot trust", () => {
  test("a missing menu is named rather than silently skipped", () => {
    const path = fixture(table(FULL.slice(0, 3)));
    expect(() => menuRoute("menu-a", path)).toThrow(/missing menu-help/);
  });

  test("a duplicated id is refused, because its index would be ambiguous", () => {
    const dup = FULL.map((m) => ({ ...m, ids: [...m.ids] }));
    dup[1].ids[0] = "menu-a";
    const path = fixture(table(dup));
    expect(() => menuRoute("menu-a", path)).toThrow(/appears twice/);
  });

  test("too few items is refused", () => {
    const thin = FULL.map((m) => ({ ...m, ids: m.ids.slice(0, 1) }));
    const path = fixture(table(thin));
    expect(() => menuRoute("menu-a", path)).toThrow(/parsed only 4 menu items/);
  });

  test("a file holding no table at all is refused, not answered with nothing", () => {
    const path = fixture("export const nothing = 1;\n");
    expect(() => menuRoute("menu-a", path)).toThrow(/parsed 0 of 4 menus/);
  });

  test("an item before any menu is refused", () => {
    const path = fixture(`const MENUS = [{ id: "menu-orphan" }];\n` + table(FULL));
    expect(() => menuRoute("menu-a", path)).toThrow(/precedes any menu id/);
  });

  test("menuChord answers the menu's own chord, and a German-shaped catalog moves it", () => {
    expect(menuChord("menu-help", REAL)).toBe("alt+h");
    expect(menuChord("menu-outline", REAL)).toBe("alt+o");
    const catalog = fixture('export const EN = {\n  "menu.file.key": "D",\n  "menu.edit.key": "B",\n  "menu.outline.key": "G",\n  "menu.help.key": "H",\n};\n', "en.ts");
    resetMenuCache();
    expect(menuChord("menu-outline", fixture(table(FULL)), catalog)).toBe("alt+g");
  });

  test("a commented example of the key line does not win over the entry", () => {
    const catalog = fixture('// e.g. "menu.file.key": "X"\nexport const EN = {\n  "menu.file.key": "D",\n  "menu.edit.key": "B",\n  "menu.outline.key": "G",\n  "menu.help.key": "H",\n};\n', "en.ts");
    expect(menuChord("menu-file", fixture(table(FULL)), catalog)).toBe("alt+d");
  });

  test("a literal letter in the source is refused: the bar must read the catalog", () => {
    const literal = FULL.map((m) => ({ ...m, key: '"f"' }));
    const path = fixture(table(literal));
    expect(() => menuRoute("menu-a", path)).toThrow(/precedes any menu id and key/);
  });

  test("the chord is the catalog's letter, lowercased, not a restated one", () => {
    // A German-shaped catalog: the parser must answer alt+d for File, which is
    // what would drive a page booted under `locale: "de"`.
    const catalog = fixture('export const EN = {\n  "menu.file.key": "D",\n  "menu.edit.key": "B",\n  "menu.outline.key": "G",\n  "menu.help.key": "H",\n};\n', "en.ts");
    const path = fixture(table(FULL));
    expect(menuRoute("menu-a", path, catalog).chord).toBe("alt+d");
    expect(menuRoute("menu-e", path, catalog).chord).toBe("alt+b");
  });

  test("the shipped German catalog drives its own menu accelerators", () => {
    expect(menuChord("menu-file", REAL, "app/ui/src/i18n/de.ts")).toBe("alt+d");
    expect(menuRoute("menu-new-chapter", REAL, "app/ui/src/i18n/de.ts").chord).toBe("alt+g");
  });

  test("the selected catalog supplies the untitled timeline label", () => {
    expect(catalogText("timeline.untitled", "app/ui/src/i18n/en.ts")).toBe("Timeline");
    expect(catalogText("timeline.untitled", "app/ui/src/i18n/de.ts")).toBe("Zeitleiste");
  });

  test("the German driver sends the localized outline accelerator", async () => {
    const sent: string[][] = [];
    const driver = menuDriver(":99", "123", (_display, args) => sent.push(args),
      REAL, "app/ui/src/i18n/de.ts");
    await driver.activate("menu-new-timeline");
    expect(sent.some((args) => args[0] === "key" && args.at(-1) === "alt+g")).toBeTrue();
    expect(sent.some((args) => args[0] === "key" && args.at(-1) === "alt+o")).toBeFalse();
  });

  test("the driver takes the shorter wrap route to a fixture menu's last item", async () => {
    const sent: string[] = [];
    const driver = menuDriver(":99", "123", (_display, args) => sent.push(args.at(-1) ?? ""), fixture(table(FULL)));
    await driver.activate("menu-k");
    expect(sent).toEqual(["alt+o", "Up", "Return"]);
  });

  test("the shipped outline views use the shorter wrapped route", async () => {
    // Creation comes first in the grouped menu. Labels and separators are
    // not keyboard stops: table and cards remain actions 28 and 29 of 38.
    expect(menuRoute("menu-review-proposals", REAL).index).toBe(37);
    const sent: string[] = [];
    const driver = menuDriver(":99", "123", (_display, args) => sent.push(args.at(-1) ?? ""), REAL);
    await driver.activate("menu-view-table");
    expect(sent).toEqual(["alt+o", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Return"]);
    sent.length = 0;
    await driver.activate("menu-view-cards");
    expect(sent).toEqual(["alt+o", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Return"]);
  });

  test("a German route is not served from the English catalog cache", () => {
    expect(menuChord("menu-file", REAL)).toBe("alt+f");
    expect(menuChord("menu-file", REAL, "app/ui/src/i18n/de.ts")).toBe("alt+d");
  });

  test("a catalog without the letter is refused, not answered with a guess", () => {
    const catalog = fixture('export const EN = {\n  "menu.file": "File",\n};\n', "en.ts");
    const path = fixture(table(FULL));
    expect(() => menuRoute("menu-a", path, catalog)).toThrow(/no one-letter value for menu\.file\.key/);
  });

  test("a fixture's answers are not served from a previous file's parse", () => {
    // The module memoises, so without resetMenuCache a second path is answered
    // from the first. This is the test that would go red if the cache key were
    // ever assumed to be the path.
    const path = fixture(table(FULL));
    expect(menuRoute("menu-a", path).index).toBe(0);
    resetMenuCache();
    expect(menuRoute("menu-export", REAL).menu).toBe("menu-file");
  });
});

describe("project-cli's restated row height still matches the stylesheet", () => {
  // A RESTATED CONSTANT IS A CLAIM ABOUT ANOTHER FILE, and this one had stopped
  // being true: the rig said `padding: 4px 8px` while style.css had said 5px
  // since the visual redesign. The error is 0 for the first row and grows 2px
  // per row, so it stayed inside the row for the two projects the rig seeds and
  // would have mis-clicked at three. Nothing noticed for several slices.
  //
  // Here rather than in a UI test because the constant is the HARNESS's, and it
  // is the harness that goes wrong when the stylesheet moves under it.
  test("the option padding the rig assumes is the padding the stylesheet sets", async () => {
    const css = await Bun.file("app/ui/style.css").text();
    const at = css.indexOf('#project-list [role="option"] {');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    const padding = block.match(/padding:\s*(\d+)px\s+(\d+)px/);
    expect(padding).not.toBeNull();

    const rig = await Bun.file("app/harness/src/project-cli.ts").text();
    const assumed = rig.match(/const OPTION_HEIGHT = Math\.floor\(LINE_HEIGHT \+ (\d+) \+ (\d+)\)/);
    expect(assumed).not.toBeNull();
    expect(assumed?.[1]).toBe(padding?.[1]);
    expect(assumed?.[2]).toBe(padding?.[1]);
  });
});

// ------------------------------------------------- the navigator context menu

function contextFile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nav-context-"));
  const path = join(dir, "nav-context-menu.ts");
  writeFileSync(path, source, "utf8");
  return path;
}

/** The shape the parser depends on: the panel's id, written exactly like an
 *  item's, and eight item ids in paint order (Synopsis... and Who
 *  appears here... were added above Rename). */
function contextSource(ids: string[], panel = true): string {
  const head = panel ? `const panel = createMenuPanel({ id: "nav-context-menu" });\n` : "";
  return head + ids.map((id) => `      { id: "${id}", label: () => "L", run: () => {} },`).join("\n");
}

const CONTEXT_IDS = [
  "nav-context-new-part",
  "nav-context-new-chapter",
  "nav-context-new-scene",
  "nav-context-synopsis",
  "nav-context-appears",
  "nav-context-rename",
  "nav-context-remove",
  "nav-context-state",
];

beforeEach(() => {
  resetNavContextCache();
});

test("an item's index is its position in the source's paint order, on a row that carries a body", () => {
  const path = contextFile(contextSource(CONTEXT_IDS));
  expect(navContextIndex("nav-context-new-part", "scene", path)).toBe(0);
  expect(navContextIndex("nav-context-remove", "scene", path)).toBe(6);
  expect(navContextIndex("nav-context-state", "scene", path)).toBe(7);
});

test("Rename's index on a part is two lower than on a scene, note or matter", () => {
  // Synopsis... and Who-appears-here... only paint above Rename for a row that
  // carries a body: a rig that pressed the scene's index on a part would
  // land on Who-appears-here instead of Rename.
  const path = contextFile(contextSource(CONTEXT_IDS));
  const onScene = navContextIndex("nav-context-rename", "scene", path);
  const onPart = navContextIndex("nav-context-rename", "part", path);
  expect(onScene - onPart).toBe(2);
  expect(onPart).toBe(3);
  expect(navContextIndex("nav-context-rename", "note", path)).toBe(onScene);
  expect(navContextIndex("nav-context-rename", "matter", path)).toBe(onScene);
});

test("a create item's index is unaffected by row type: it paints before the body-only pair either way", () => {
  const path = contextFile(contextSource(CONTEXT_IDS));
  expect(navContextIndex("nav-context-new-part", "scene", path)).toBe(0);
  expect(navContextIndex("nav-context-new-part", "part", path)).toBe(0);
});

test("asking for a body-only item's index on a row without a body is refused", () => {
  const path = contextFile(contextSource(CONTEXT_IDS));
  expect(() => navContextIndex("nav-context-synopsis", "part", path)).toThrow(/not painted on a "part" row/);
});

test("the panel's own id is not an item, though it is written like one", () => {
  // The panel is created FIRST in the module, so counting it would shift every
  // index below it by one and the rig would press Return on the wrong item.
  const path = contextFile(contextSource(CONTEXT_IDS));
  expect(navContextItemCount(path)).toBe(CONTEXT_IDS.length);
  expect(() => navContextIndex("nav-context-menu", "scene", path)).toThrow(/no context item/);
});

test("a source with no panel id is refused, because the module's shape changed", () => {
  const path = contextFile(contextSource(CONTEXT_IDS, false));
  expect(() => navContextItemCount(path)).toThrow(/panel id/);
});

test("a parse that matched too few items is refused rather than answered", () => {
  // A parse that silently matches nothing hands every caller index 0 of a menu
  // that may not even have opened, and the rig then reports whatever the first
  // item did.
  const path = contextFile(contextSource(CONTEXT_IDS.slice(0, 3)));
  expect(() => navContextItemCount(path)).toThrow(/parsed only 3/);
});

test("a duplicated id is refused, because an index parsed from it is ambiguous", () => {
  const path = contextFile(contextSource([...CONTEXT_IDS, "nav-context-remove"]));
  expect(() => navContextItemCount(path)).toThrow(/appears twice/);
});

test("the shipped module parses, and the removal item is where the rig expects", () => {
  expect(navContextItemCount("app/ui/src/nav-context-menu.ts")).toBe(8);
  expect(navContextIndex("nav-context-remove", "scene", "app/ui/src/nav-context-menu.ts")).toBe(6);
  expect(navContextIndex("nav-context-remove", "part", "app/ui/src/nav-context-menu.ts")).toBe(4);
});
