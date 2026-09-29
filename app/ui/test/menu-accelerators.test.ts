import { describe, expect, test } from "bun:test";
import { CATALOGS, DE, EN } from "../src/i18n";

// the Alt letter that opens each menu is a catalog value, so German
// opens Datei with Alt+D and the Help panel says so. These invariants hold
// per catalog; the German letters are also asserted literally, because a
// catalog copied from English satisfies every relational check below.

const MENUS = ["file", "edit", "outline", "help"] as const;

describe("every catalog's menu accelerators are the letters the writer sees", () => {
  for (const [tag, catalog] of Object.entries(CATALOGS)) {
    test(`${tag}: each key is one uppercase letter, the first of its own title`, () => {
      for (const menu of MENUS) {
        const key = catalog[`menu.${menu}.key`];
        const title = catalog[`menu.${menu}`];
        expect(key).toMatch(/^[A-Z]$/);
        expect(title?.[0]?.toUpperCase()).toBe(key);
      }
    });

    test(`${tag}: the four letters are distinct`, () => {
      const keys = MENUS.map((menu) => catalog[`menu.${menu}.key`]);
      expect(new Set(keys).size).toBe(MENUS.length);
    });

    test(`${tag}: the Help panel names the same chord`, () => {
      for (const menu of MENUS) {
        expect(catalog[`help.keys.menu.${menu}`]).toBe(`Alt+${catalog[`menu.${menu}.key`]}`);
      }
    });
  }

  test("English is F/E/O/H and German is D/B/G/H", () => {
    expect(MENUS.map((m) => EN[`menu.${m}.key`])).toEqual(["F", "E", "O", "H"]);
    expect(MENUS.map((m) => DE[`menu.${m}.key`])).toEqual(["D", "B", "G", "H"]);
  });
});
