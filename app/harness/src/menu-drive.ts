/** Driving the application menu from a rig, and deciding which keystroke lands
 *  on which item.
 *
 *  Every graded rig that reaches Export, Preferences, Find or the project panel
 *  goes through the menu as of the retirement slice, because the bar buttons
 *  those rigs used to click no longer exist. Six copies of a menu drive is six
 *  chances to drift, which is the rule `findWindowId` already lives in
 *  `shell.ts` for.
 *
 *  The INDEX is the part worth centralising. `menu-cli` carried
 *  `FILE_EXPORT_INDEX = 3` as a literal, which is correct until an item is
 *  inserted above Export - and then every rig holding that literal presses
 *  Return on the item above the one it named, silently, and reports whatever
 *  that item did. So the index is not restated here at all: it is READ from
 *  `app/ui/src/menu-bar.ts`, the one place the order is actually decided. The
 *  same parse-the-source technique the theme, typography and help guards use.
 *
 *  What this deliberately does NOT do is verify that the right item ran. A
 *  parse can only promise the keystroke matches the source; a rig still has to
 *  check the EFFECT, which is why `menu-cli` asserts on the store and the
 *  export file rather than on the menu.
 */
import { readFileSync } from "node:fs";

/** Long enough for the dropdown to paint. Measured in `menu-cli`, where the
 *  same value drives six boots. */
export const MENU_OPEN_MS = 700;
/** Between ArrowDowns. The menu moves its own highlight synchronously, but the
 *  keystrokes are delivered by the X server and a burst can coalesce. */
export const KEY_STEP_MS = 120;
/** After Return, for whatever the item opened to appear. */
export const MENU_SETTLE_MS = 900;

/** The four menus, by the id `menu-bar.ts` gives them. Restated here only as a
 *  SET - the parser uses it to tell a menu's id from an item's id, since both
 *  are written `id: "menu-..."` in the same table. The `key` each one opens
 *  with is read from the source, not restated. */
const MENU_IDS = ["menu-file", "menu-edit", "menu-outline", "menu-help"] as const;

export type MenuId = (typeof MENU_IDS)[number];

export interface MenuItemRoute {
  /** The menu that holds it, e.g. `menu-file`. */
  menu: MenuId;
  /** The chord that opens that menu, e.g. `alt+f`. */
  chord: string;
  /** Zero-based position in the menu. The driver chooses the shorter wrapped
   *  ArrowUp or ArrowDown route from the initially highlighted first item. */
  index: number;
}

interface ParsedMenus {
  routes: Map<string, MenuItemRoute>;
  /** The chord that opens each menu, by menu id. */
  chords: Map<MenuId, string>;
  counts: Map<MenuId, number>;
  itemCount: number;
}

let cached: { sourcePath: string; catalogPath: string; menus: ParsedMenus } | null = null;

function cachedMenus(sourcePath: string, catalogPath: string): ParsedMenus {
  if (cached?.sourcePath !== sourcePath || cached.catalogPath !== catalogPath) {
    cached = { sourcePath, catalogPath, menus: parseMenus(sourcePath, catalogPath) };
  }
  return cached.menus;
}

/** The menu source, parsed into a route per item id.
 *
 *  Sequential by construction: an id in MENU_IDS opens a new menu, and every
 *  id after it belongs to that menu until the next one. That holds because the
 *  table is a literal written in paint order, which is also the only reason the
 *  index means anything.
 */
function parseMenus(sourcePath: string, catalogPath: string): ParsedMenus {
  const source = readFileSync(sourcePath, "utf8");
  const routes = new Map<string, MenuItemRoute>();
  const chords = new Map<MenuId, string>();
  const counts = new Map<MenuId, number>();
  const seen = new Set<string>();
  let itemCount = 0;
  let menu: MenuId | null = null;
  let chord: string | null = null;
  let index = 0;

  // `id: "menu-x"` for both menus and items; `key: t("menu.x.key")` only ever
  // appears on a menu, on the line after its own id. Since 088 the letter is
  // a catalog value (German opens Datei with Alt+D); the rigs drive the
  // English page, so the key is resolved through `en.ts`. A literal letter in
  // the source is no longer a shape this accepts: it would be a bar that
  // ignores the catalog.
  const pattern = /\bid:\s*"(menu-[a-z-]+)"|\bkey:\s*t\("(menu\.[a-z]+\.key)"\)/g;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    const keyName = match[2];
    if (keyName !== undefined) {
      if (menu === null) {
        throw new Error(`${sourcePath}: found key ${keyName} before any menu id; the table's shape changed`);
      }
      chord = `alt+${catalogLetter(keyName, catalogPath)}`;
      chords.set(menu, chord);
      continue;
    }
    if (id === undefined) continue;
    if (seen.has(id)) {
      throw new Error(`${sourcePath}: the id "${id}" appears twice, so an index parsed from it is ambiguous`);
    }
    seen.add(id);
    if ((MENU_IDS as readonly string[]).includes(id)) {
      menu = id as MenuId;
      chord = null;
      index = 0;
      continue;
    }
    if (menu === null || chord === null) {
      throw new Error(`${sourcePath}: the item "${id}" precedes any menu id and key; the table's shape changed`);
    }
    routes.set(id, { menu, chord, index });
    index += 1;
    counts.set(menu, index);
    itemCount += 1;
  }

  // Vacuity guards. A parse that silently matches nothing hands every caller
  // index 0 of a menu that never opened, and the rig then reports whatever the
  // first item did - which is a plausible number, not an error.
  const menusFound = MENU_IDS.filter((m) => seen.has(m));
  if (menusFound.length !== MENU_IDS.length) {
    const missing = MENU_IDS.filter((m) => !seen.has(m));
    throw new Error(`${sourcePath}: parsed ${menusFound.length} of ${MENU_IDS.length} menus, missing ${missing.join(", ")}`);
  }
  if (itemCount < 12) {
    throw new Error(`${sourcePath}: parsed only ${itemCount} menu items, which is fewer than the menu has ever had`);
  }
  return { routes, chords, counts, itemCount };
}

/** A catalog string read from the selected source. Kept here with the menu
 * parser so a harness route can read a locale-owned label without importing
 * the page runtime. */
export function catalogText(keyName: string, catalogPath: string): string {
  const catalog = readFileSync(catalogPath, "utf8");
  // Anchored to a line start so a commented example of the same shape cannot
  // win over the entry.
  const match = new RegExp(`^\\s*"${keyName.replaceAll(".", "\\.")}":\\s*"([^"\\n]+)"`, "m").exec(catalog);
  if (match === null) {
    throw new Error(`${catalogPath}: no string value for ${keyName}; the catalog moved`);
  }
  return match[1]!;
}

/** The selected catalog's letter for `menu.<x>.key`, lowercased for xdotool.
 *  Read from the catalog source the same way the menu table is. */
function catalogLetter(keyName: string, catalogPath: string): string {
  let value: string;
  try {
    value = catalogText(keyName, catalogPath);
  } catch {
    throw new Error(`${catalogPath}: no one-letter value for ${keyName}; the accelerator moved`);
  }
  if (!/^[A-Za-z]$/.test(value)) {
    throw new Error(`${catalogPath}: no one-letter value for ${keyName}; the accelerator moved`);
  }
  return value.toLowerCase();
}

/** Where in the menu an item lives, read from the source that decides it. */
export function menuRoute(
  itemId: string,
  sourcePath = "app/ui/src/menu-bar.ts",
  catalogPath = "app/ui/src/i18n/en.ts",
): MenuItemRoute {
  const menus = cachedMenus(sourcePath, catalogPath);
  const route = menus.routes.get(itemId);
  if (route === undefined) {
    const known = [...menus.routes.keys()].join(", ");
    throw new Error(`no menu item "${itemId}" in ${sourcePath}; the menu holds: ${known}`);
  }
  return route;
}

/** The chord that opens a menu, e.g. `alt+f` for `menu-file`, read from the
 *  same parse. Every rig that presses a menu open goes through this rather
 *  than a literal: since 088 the letter is a catalog value, and a restated
 *  letter would deliver the chord and every key after it into the editor
 *  without a word. */
export function menuChord(
  menuId: MenuId,
  sourcePath = "app/ui/src/menu-bar.ts",
  catalogPath = "app/ui/src/i18n/en.ts",
): string {
  const chord = cachedMenus(sourcePath, catalogPath).chords.get(menuId);
  if (chord === undefined) throw new Error(`${sourcePath}: no chord parsed for ${menuId}`);
  return chord;
}

/** For tests: how many items the parse found, so a guard can fail on a parse
 *  that matched a handful of lines by accident. */
export function menuItemCount(
  sourcePath = "app/ui/src/menu-bar.ts",
  catalogPath = "app/ui/src/i18n/en.ts",
): number {
  return cachedMenus(sourcePath, catalogPath).itemCount;
}

/** For tests: drop the memoised parse so a fixture path is not answered from a
 *  previous file's results. */
export function resetMenuCache(): void {
  cached = null;
}

export interface MenuDriver {
  /** Send a chord to the shell's window. */
  key(chord: string): void;
  /** Open a menu and wait for its dropdown to paint. */
  openMenu(chord: string): Promise<void>;
  /** Open the menu holding `itemId` and activate it by the shortest arrow
   *  route. Its position and menu length both come from the source. */
  activate(itemId: string): Promise<void>;
}

/** How a rig runs `xdotool`. Taken as a dependency rather than imported,
 *  because every rig already carries its own `xdo` and they do not agree on the
 *  return type - one returns void, the others a string. Consolidating those is
 *  a cleanup of its own; borrowing the caller's is what keeps this module from
 *  becoming a seventh copy. */
export type Xdo = (display: string, args: string[]) => unknown;

/** A driver bound to one window.
 *
 *  Takes the window id rather than looking it up: `findWindowId` refuses any
 *  result that is not exactly one window, and a GTK dialog inherits the
 *  application's WM_CLASS - so a lookup while a dialog is open fires that guard
 *  and reads as a MISSING window. The caller resolves the id once, before it
 *  opens anything.
 */
export function menuDriver(
  display: string,
  wid: string,
  xdo: Xdo,
  sourcePath = "app/ui/src/menu-bar.ts",
  catalogPath = "app/ui/src/i18n/en.ts",
): MenuDriver {
  const key = (chord: string): void => {
    xdo(display, ["key", "--window", wid, chord]);
  };
  const openMenu = async (chord: string): Promise<void> => {
    key(chord);
    await Bun.sleep(MENU_OPEN_MS);
  };
  return {
    key,
    openMenu,
    activate: async (itemId: string): Promise<void> => {
      const route = menuRoute(itemId, sourcePath, catalogPath);
      const count = cachedMenus(sourcePath, catalogPath).counts.get(route.menu);
      if (count === undefined) throw new Error(`no items parsed for ${route.menu}`);
      const upward = count - route.index;
      const keyName = upward < route.index ? "Up" : "Down";
      const steps = Math.min(route.index, upward);
      await openMenu(route.chord);
      for (let i = 0; i < steps; i++) {
        key(keyName);
        await Bun.sleep(KEY_STEP_MS);
      }
      key("Return");
      await Bun.sleep(MENU_SETTLE_MS);
    },
  };
}

// ---------------------------------------------------------------------------
// The navigator's context menu.
//
// A SECOND TABLE, PARSED THE SAME WAY, for the same reason: `nav-context-menu.ts`
// paints three creates, Synopsis... and Who appears here... (for a row that
// carries a body, since 095), Rename, Delete-or-Restore and Revision state in
// that order, and the only thing that decides the order is the source. A rig
// holding `REMOVE_INDEX = 4` is correct until an item is inserted above it, and
// then it presses Return on the item above the one it named and reports
// whatever that item did — the recorded `FILE_EXPORT_INDEX` failure, in a
// second menu.
//
// Unlike the menu bar there is no chord to parse: a context menu is OPENED on a
// row (right-click, or Shift+F10 on the focused one) and opening it focuses item
// zero, so an index is the whole route.
// ---------------------------------------------------------------------------

/** The dropdown's own id, which is written `id: "nav-context-menu"` in exactly
 *  the same shape as an item's and is not an item. Restated as the ONE exclusion
 *  rather than the parser trying to tell a panel from an item by position. */
const NAV_CONTEXT_PANEL_ID = "nav-context-menu";

let navCached: Map<string, number> | null = null;

function parseNavContext(sourcePath: string): Map<string, number> {
  const source = readFileSync(sourcePath, "utf8");
  const order = new Map<string, number>();
  const seen = new Set<string>();
  let panelSeen = false;
  for (const match of source.matchAll(/\bid:\s*"(nav-context-[a-z-]+)"/g)) {
    const id = match[1];
    if (id === undefined) continue;
    if (id === NAV_CONTEXT_PANEL_ID) {
      panelSeen = true;
      continue;
    }
    if (seen.has(id)) {
      throw new Error(`${sourcePath}: the id "${id}" appears twice, so an index parsed from it is ambiguous`);
    }
    seen.add(id);
    order.set(id, order.size);
  }
  // Vacuity guards, for the reason the menu bar's parse carries them: a parse
  // that matched nothing hands every caller index 0 of a menu that may not even
  // have opened, and the rig then reports whatever the first item did.
  if (!panelSeen) {
    throw new Error(`${sourcePath}: the panel id "${NAV_CONTEXT_PANEL_ID}" is absent; the module's shape changed`);
  }
  if (order.size < 8) {
    throw new Error(`${sourcePath}: parsed only ${order.size} context items, fewer than the menu has ever had`);
  }
  return order;
}

/** The two ids the menu paints only for a row that carries a body, and the
 *  three types that carry one -- RESTATED from `nav-context-menu.ts`'s
 *  `carriesABody` (scene, note, matter) rather than imported, for the same
 *  reason every other constant in this module is restated: the parser and the
 *  page are two programs, and an import would agree with the page even on the
 *  day the two drift apart. Since 095 a part, a chapter or a section root does
 *  not get these two items, so an index below them is unaffected by rowType
 *  but an index at or below one that is dropped shifts up. */
const BODY_ONLY_IDS = ["nav-context-synopsis", "nav-context-appears"];
const BODY_TYPES = ["scene", "note", "matter"];

/** How many ArrowDowns from the top of the navigator's context menu reach
 *  `itemId`, on a row of type `rowType`. Read from the source that decides the
 *  order, then adjusted for the two items that only paint on a row that
 *  carries a body: a rig asking for Rename's index on a part must get an
 *  answer two lower than the same question on a scene, or it presses Return on
 *  Synopsis and Who-appears-here instead. */
export function navContextIndex(
  itemId: string,
  rowType: string,
  sourcePath = "app/ui/src/nav-context-menu.ts",
): number {
  navCached ??= parseNavContext(sourcePath);
  const index = navCached.get(itemId);
  if (index === undefined) {
    throw new Error(
      `no context item "${itemId}" in ${sourcePath}; it holds: ${[...navCached.keys()].join(", ")}`,
    );
  }
  if (BODY_TYPES.includes(rowType)) return index;
  if (BODY_ONLY_IDS.includes(itemId)) {
    throw new Error(`"${itemId}" is not painted on a "${rowType}" row, so it has no index there`);
  }
  const skipped = BODY_ONLY_IDS.filter((id) => (navCached!.get(id) ?? Infinity) < index).length;
  return index - skipped;
}

/** For tests: how many items the parse found. */
export function navContextItemCount(sourcePath = "app/ui/src/nav-context-menu.ts"): number {
  navCached ??= parseNavContext(sourcePath);
  return navCached.size;
}

/** For tests: drop the memoised parse. */
export function resetNavContextCache(): void {
  navCached = null;
}
