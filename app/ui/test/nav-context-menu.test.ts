// The navigator's context menu: the items it offers, and the row it offers them
// ON.
//
// Everything here is about the captured row. The operations themselves are the
// outline unit's and are tested there; what this surface can get wrong is acting
// on a DIFFERENT row from the one the writer opened it on, which is quick open's
// recorded defect with a better disguise.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createNavContextMenu,
  isContextMenuChord,
  type NavContextMenu,
} from "../src/nav-context-menu";

interface Calls {
  created: Array<{ relativeTo: string; itemType: string }>;
  renamed: string[];
  removed: string[];
  restored: string[];
  state: string[];
  synopsis: string[];
  appears: string[];
  focusReturns: number;
}

interface Rig {
  menu: NavContextMenu;
  calls: Calls;
  /** What `trashed` and `typeOf` answer. Mutable so a test can move the world
   *  between the paint and the click, which is the one case the captured
   *  answer exists for. */
  world: { trashed: boolean; type: string };
  item(id: string): HTMLButtonElement | null;
  panel(): HTMLElement;
}

function mount(): Rig {
  const calls: Calls = {
    created: [],
    renamed: [],
    removed: [],
    restored: [],
    state: [],
    synopsis: [],
    appears: [],
    focusReturns: 0,
  };
  // "scene" by default: the common row, and the one every test that does not
  // care about the type distinction opens on.
  const world = { trashed: false, type: "scene" };
  const menu = createNavContextMenu({
    container: document.body,
    create: (relativeTo, itemType) => calls.created.push({ relativeTo, itemType }),
    beginRename: (id) => calls.renamed.push(id),
    remove: (id) => calls.removed.push(id),
    restore: (id) => calls.restored.push(id),
    trashed: () => world.trashed,
    typeOf: () => world.type,
    openRevisionState: (id) => calls.state.push(id),
    openSynopsis: (id) => calls.synopsis.push(id),
    openAppears: (id) => calls.appears.push(id),
    returnFocus: () => (calls.focusReturns += 1),
    viewport: () => ({ width: 1200, height: 800 }),
  });
  return {
    menu,
    calls,
    world,
    item: (id) => document.querySelector<HTMLButtonElement>(`#${id}`),
    panel() {
      const element = document.getElementById("nav-context-menu");
      if (element === null) throw new Error("no #nav-context-menu");
      return element;
    },
  };
}

function teardown(rig: Rig): void {
  rig.menu.destroy();
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe("what the menu offers", () => {
  test("eight items on a scene, in the order a writer builds a manuscript in", () => {
    // 095: Synopsis... and Who appears here... joined the six, ABOVE Rename -
    // a scene is one of the three types that carries a body.
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      const ids = [...rig.panel().querySelectorAll("[role='menuitem']")].map((el) => el.id);
      expect(ids).toEqual([
        "nav-context-new-part",
        "nav-context-new-chapter",
        "nav-context-new-scene",
        "nav-context-synopsis",
        "nav-context-appears",
        "nav-context-rename",
        "nav-context-remove",
        "nav-context-state",
      ]);
    } finally {
      teardown(rig);
    }
  });

  test("a part carries neither: six items, none of them about a body", () => {
    const rig = mount();
    rig.world.type = "part";
    try {
      rig.menu.open("part-1", 10, 10);
      const ids = [...rig.panel().querySelectorAll("[role='menuitem']")].map((el) => el.id);
      expect(ids).not.toContain("nav-context-synopsis");
      expect(ids).not.toContain("nav-context-appears");
      expect(ids.length).toBe(6);
    } finally {
      teardown(rig);
    }
  });

  test("a note and a matter document carry a body too", () => {
    for (const type of ["note", "matter"]) {
      const rig = mount();
      rig.world.type = type;
      try {
        rig.menu.open("row-1", 10, 10);
        const ids = [...rig.panel().querySelectorAll("[role='menuitem']")].map((el) => el.id);
        expect(ids).toContain("nav-context-synopsis");
        expect(ids).toContain("nav-context-appears");
      } finally {
        teardown(rig);
      }
    }
  });

  test("each create names the row it opened on as the parent", () => {
    const rig = mount();
    try {
      rig.menu.open("chapter-3", 10, 10);
      rig.item("nav-context-new-scene")?.click();
      // RELATIVE TO the row the menu opened on, not "as a child of" it. The
      // context menu and the Outline menu now run one placement rule against
      // different anchors; this pins that the anchor is the row and not the
      // selection, which is what the menu's whole no-target design is for.
      expect(rig.calls.created).toEqual([{ relativeTo: "chapter-3", itemType: "scene" }]);
    } finally {
      teardown(rig);
    }
  });

  test("Synopsis, Who appears here, Rename, Delete and Revision state all name that same row", () => {
    for (const [id, read] of [
      ["nav-context-synopsis", (c: Calls) => c.synopsis],
      ["nav-context-appears", (c: Calls) => c.appears],
      ["nav-context-rename", (c: Calls) => c.renamed],
      ["nav-context-remove", (c: Calls) => c.removed],
      ["nav-context-state", (c: Calls) => c.state],
    ] as const) {
      const rig = mount();
      try {
        rig.menu.open("scene-9", 10, 10);
        rig.item(id)?.click();
        expect(read(rig.calls)).toEqual(["scene-9"]);
      } finally {
        teardown(rig);
      }
    }
  });

  test("Revision state says it opens a dialog", () => {
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      expect(rig.item("nav-context-state")?.getAttribute("aria-haspopup")).toBe("dialog");
      // And the five that do not, do not: an item that promises a panel and
      // opens none is a promise a screen-reader user acts on.
      expect(rig.item("nav-context-rename")?.getAttribute("aria-haspopup")).toBe(null);
    } finally {
      teardown(rig);
    }
  });
});

describe("Delete or Restore is decided when the menu is PAINTED", () => {
  const labelOf = (rig: Rig): string | undefined =>
    rig.item("nav-context-remove")?.querySelector(".menu-item-label")?.textContent ?? undefined;

  test("a live row is offered Delete and a binned one Restore", () => {
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      expect(labelOf(rig)).toBe("Delete");
      rig.world.trashed = true;
      rig.menu.open("scene-1", 10, 10);
      expect(labelOf(rig)).toBe("Restore");
    } finally {
      teardown(rig);
    }
  });

  test("the action taken is the one the writer READ, whatever changed since", () => {
    // The world moving under an open menu is not hypothetical here: an outline
    // operation already in flight re-reads the whole walk when it lands, and
    // `trashed` answers from that walk. Reading it again inside the handler is
    // the bug, not the safeguard.
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      expect(labelOf(rig)).toBe("Delete");
      rig.world.trashed = true;
      rig.item("nav-context-remove")?.click();
      expect(rig.calls.removed).toEqual(["scene-1"]);
      expect(rig.calls.restored).toEqual([]);
    } finally {
      teardown(rig);
    }
  });

  test("it is asked once per open, not once per item", () => {
    const asked: string[] = [];
    const menu = createNavContextMenu({
      container: document.body,
      create: () => undefined,
      beginRename: () => undefined,
      remove: () => undefined,
      restore: () => undefined,
      trashed: (id) => {
        asked.push(id);
        return false;
      },
      typeOf: () => "scene",
      openRevisionState: () => undefined,
      openSynopsis: () => undefined,
      openAppears: () => undefined,
      returnFocus: () => undefined,
      viewport: () => ({ width: 1200, height: 800 }),
    });
    try {
      menu.open("scene-1", 10, 10);
      expect(asked).toEqual(["scene-1"]);
    } finally {
      menu.destroy();
    }
  });
});

describe("opening on a second row", () => {
  test("acts on the row it was opened on LAST, not the first", () => {
    // A second right-click is a request to open on whatever is under it now. If
    // the first open's items survived, the menu the writer is looking at would
    // be about a row they have moved away from - the failure this whole surface
    // is guarded against, arriving through the reopen path instead.
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      rig.menu.open("scene-2", 20, 20);
      rig.item("nav-context-remove")?.click();
      expect(rig.calls.removed).toEqual(["scene-2"]);
    } finally {
      teardown(rig);
    }
  });
});

describe("Escape", () => {
  test("closes the menu and hands focus back", () => {
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      expect(rig.menu.isOpen()).toBe(true);
      const event = press("Escape");
      expect(rig.menu.isOpen()).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      // A recorded defect: a panel with no toggle to return to leaves focus
      // on <body>, and a keyboard-first application has nowhere to continue
      // from.
      expect(rig.calls.focusReturns).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("a closed menu hears nothing", () => {
    const rig = mount();
    try {
      const event = press("Escape");
      expect(event.defaultPrevented).toBe(false);
      expect(rig.calls.focusReturns).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("an item that runs does NOT pull focus back", () => {
    // Rename puts the caret in the outline bar's field and Revision state opens
    // a panel that focuses itself. Returning focus to the navigator on the way
    // out would take it off the surface the writer just asked for.
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      rig.item("nav-context-rename")?.click();
      expect(rig.calls.focusReturns).toBe(0);
    } finally {
      teardown(rig);
    }
  });
});

describe("arrow keys reach the panel through the document", () => {
  test("Down moves through the items while it is open", () => {
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      expect(document.activeElement?.id).toBe("nav-context-new-part");
      press("ArrowDown");
      expect(document.activeElement?.id).toBe("nav-context-new-chapter");
    } finally {
      teardown(rig);
    }
  });

  test("a closed menu leaves ArrowDown to the navigator", () => {
    // Its listener is on the DOCUMENT, so a menu that consumed arrows while
    // closed would take the outline's own selection key away everywhere.
    const rig = mount();
    try {
      const event = press("ArrowDown");
      expect(event.defaultPrevented).toBe(false);
    } finally {
      teardown(rig);
    }
  });
});

describe("a click outside closes it", () => {
  test("and a click on an item does not close it twice", () => {
    const rig = mount();
    try {
      rig.menu.open("scene-1", 10, 10);
      const elsewhere = document.createElement("div");
      document.body.append(elsewhere);
      elsewhere.click();
      expect(rig.menu.isOpen()).toBe(false);
      elsewhere.remove();
    } finally {
      teardown(rig);
    }
  });
});

describe("destroy leaks nothing", () => {
  test("the document listeners it registers are the document listeners it removes", () => {
    // COUNTING, because a leaked listener here is unobservable: both handlers
    // return immediately when the menu is closed, so leaking them changes no DOM
    // state and no behaviour any test can reach - while accumulating one live
    // closure per project switch. The recorded shape that only counting finds.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
      added.push(`${type}:${String(opts)}`);
      realAdd(type, fn, opts as boolean);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
      removed.push(`${type}:${String(opts)}`);
      realRemove(type, fn, opts as boolean);
    }) as typeof document.removeEventListener;
    try {
      const rig = mount();
      rig.menu.open("scene-1", 10, 10);
      rig.menu.destroy();
      expect(added.length).toBeGreaterThan(0);
      expect([...added].sort()).toEqual([...removed].sort());
    } finally {
      document.addEventListener = realAdd as typeof document.addEventListener;
      document.removeEventListener = realRemove as typeof document.removeEventListener;
    }
  });

  test("it is idempotent and takes the panel out of the page", () => {
    const rig = mount();
    rig.menu.open("scene-1", 10, 10);
    rig.menu.destroy();
    rig.menu.destroy();
    expect(document.getElementById("nav-context-menu")).toBe(null);
  });
});

describe("isContextMenuChord", () => {
  const chord = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
    new KeyboardEvent("keydown", { key, ...init });

  test("Shift+F10 and the Menu key both open it", () => {
    expect(isContextMenuChord(chord("F10", { shiftKey: true }))).toBe(true);
    expect(isContextMenuChord(chord("ContextMenu"))).toBe(true);
  });

  test("a bare F10 does not", () => {
    // F10 alone is the menu-bar convention on several desktops and is not this.
    expect(isContextMenuChord(chord("F10"))).toBe(false);
  });

  test("a chord carrying Ctrl, Alt or Meta does not", () => {
    // Alt in particular: the navigator's Alt+Arrow moves are structural
    // commands, and an Alt chord this UI does not define must reach nothing.
    expect(isContextMenuChord(chord("ContextMenu", { ctrlKey: true }))).toBe(false);
    expect(isContextMenuChord(chord("ContextMenu", { altKey: true }))).toBe(false);
    expect(isContextMenuChord(chord("ContextMenu", { metaKey: true }))).toBe(false);
    expect(isContextMenuChord(chord("F10", { shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  test("an ordinary key does not", () => {
    expect(isContextMenuChord(chord("f"))).toBe(false);
    expect(isContextMenuChord(chord("Enter"))).toBe(false);
  });
});

describe("the page wires every dep to the row, not to the selection", () => {
  // A SOURCE PARSE, because the wiring is in project.ts, which no test can
  // import: it is assembled inside `mountProject` against a store, a shell and a
  // real editor. The rule it can lose is the one this whole surface exists for -
  // a dep re-reading `selectedId()` instead of using the id it was handed acts
  // on whatever the writer moved to, and every unit test above would still pass
  // because they drive the menu directly.
  const project = async (): Promise<string> => await Bun.file("app/ui/src/project.ts").text();

  function block(source: string): string {
    const at = source.indexOf("navContextMenu = createNavContextMenu({");
    expect(at).toBeGreaterThan(-1);
    const end = source.indexOf("\n    });", at);
    expect(end).toBeGreaterThan(at);
    return source.slice(at, end);
  }

  test("no dep in the block reads the live selection", async () => {
    // `selectedId()` is what the application menu's own actions read, correctly:
    // its items are ABOUT the selection. A context menu's are about the row it
    // opened on, and the two are different rows the moment anything moves.
    const wiring = block(await project());
    expect(wiring).not.toContain("selectedId()");
  });

  test("each mutation is handed the id the menu captured", async () => {
    const wiring = block(await project());
    for (const call of [
      "unit.create(itemType, relativeTo)",
      "unit.remove(itemId)",
      "unit.restore(itemId)",
      "isTrashedIn(latestItems, itemId)",
      "synopsisPanel?.open(itemId, navigator.activeTitle())",
      "appearancesPanel?.open(itemId, navigator.activeTitle())",
    ]) {
      expect(`${call} is wired: ${wiring.includes(call)}`).toBe(`${call} is wired: true`);
    }
  });

  test("the revision panel is pointed at the captured row before it opens", async () => {
    // That panel reads the selection LIVE and deliberately keeps doing so while
    // it is up. So the captured row is made the selection first; without the
    // line, the panel opens on whatever was selected and the captured id decides
    // nothing.
    const wiring = block(await project());
    const at = wiring.indexOf("navigator.selectById(itemId)");
    expect(at).toBeGreaterThan(-1);
    expect(wiring.indexOf("revisionPanel?.open()")).toBeGreaterThan(at);
  });

  test("synopsis and appears each select the captured row before opening", async () => {
    // Same shape as revision state: both panels read the SELECTION and the
    // navigator's own `activeTitle()`, so a call that skipped `selectById`
    // would open the panel on whatever was selected before the right-click.
    const wiring = block(await project());
    const synopsisRun = wiring.indexOf("openSynopsis: (itemId)");
    expect(synopsisRun).toBeGreaterThan(-1);
    const synopsisSelect = wiring.indexOf("navigator.selectById(itemId)", synopsisRun);
    expect(synopsisSelect).toBeGreaterThan(synopsisRun);
    expect(wiring.indexOf("synopsisPanel?.open(itemId", synopsisSelect)).toBeGreaterThan(
      synopsisSelect,
    );

    const appearsRun = wiring.indexOf("openAppears: (itemId)");
    expect(appearsRun).toBeGreaterThan(-1);
    const appearsSelect = wiring.indexOf("navigator.selectById(itemId)", appearsRun);
    expect(appearsSelect).toBeGreaterThan(appearsRun);
    expect(wiring.indexOf("appearancesPanel?.open(itemId", appearsSelect)).toBeGreaterThan(
      appearsSelect,
    );
  });

  test("the mount tears it down before the navigator it acts on", async () => {
    const source = await project();
    const menu = source.indexOf("navContextMenu?.destroy()");
    expect(menu).toBeGreaterThan(-1);
    // It holds two DOCUMENT-level listeners, which are the ones that outlive
    // every element this mount owns.
    expect(source.indexOf("navigator.destroy()")).toBeGreaterThan(menu);
  });
});

describe("the stylesheet gives the panel the shared control treatment", () => {
  // A new panel that is not in the four enumerated selector lists gets
  // BROWSER-DEFAULT buttons - the recorded #comments-panel defect, found by a
  // capture rather than by any test. This panel is not even a descendant of
  // #project-bar, so it cannot inherit the treatment the way #menu-panel does.
  test("its buttons are in all four lists", async () => {
    const css = await Bun.file("app/ui/style.css").text();
    for (const selector of [
      "#nav-context-menu button {",
      "#nav-context-menu button:hover",
      "#nav-context-menu button:active",
      "#nav-context-menu button:focus-visible",
    ]) {
      expect(`${selector} is in style.css: ${css.includes(selector)}`).toBe(
        `${selector} is in style.css: true`,
      );
    }
  });

  test("it is positioned in VIEWPORT coordinates", async () => {
    // `absolute` would resolve the left/top the unit writes against #nav's
    // scroll box, so the menu would land somewhere else the moment the pane is
    // scrolled - which is precisely when a writer is most likely to right-click.
    const css = await Bun.file("app/ui/style.css").text();
    const at = css.indexOf("#nav-context-menu {");
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf("}", at))).toContain("position: fixed");
  });
});
