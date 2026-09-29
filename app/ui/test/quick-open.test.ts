import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { afterEach, describe, expect, test } from "bun:test";
import { createQuickOpen, matchItems, type QuickOpen, type QuickOpenItem } from "../src/quick-open";

const ITEMS: QuickOpenItem[] = [
  { id: "p1", title: "Harbour Lights", type: "part" },
  { id: "c1", title: "The Old Harbour", type: "chapter" },
  { id: "s1", title: "Winter Nocturne", type: "scene" },
  { id: "s2", title: "Harbourside", type: "scene" },
  { id: "s3", title: "A quiet harbour at dusk", type: "scene" },
];

interface Rig {
  container: HTMLElement;
  panel: QuickOpen;
  opened: string[];
  selected: string[];
  /** Both callbacks in one sequence, so the ORDER can be asserted: an end state
   *  cannot tell "selected, then opened" from "opened, then selected". */
  order: string[];
  dismissals: number;
  items: QuickOpenItem[];
  el<T extends Element>(selector: string): T;
  rows(): HTMLElement[];
  status(): string;
  query(): HTMLInputElement;
  type(text: string): void;
  press(key: string): void;
}

let live: Rig | null = null;

function mount(items: QuickOpenItem[] = ITEMS): Rig {
  const container = document.createElement("span");
  document.body.append(container);
  const rig: Rig = {
    container,
    panel: null as unknown as QuickOpen,
    opened: [],
    selected: [],
    order: [],
    dismissals: 0,
    items: [...items],
    el<T extends Element>(selector: string): T {
      const found = container.querySelector(selector);
      if (found === null) throw new Error(`no ${selector} in the panel`);
      return found as T;
    },
    rows: () => [...container.querySelectorAll("[role='option']")] as HTMLElement[],
    status: () => rig.el<HTMLElement>("#quick-open-status").textContent ?? "",
    query: () => rig.el<HTMLInputElement>("#quick-open-query"),
    type(text: string): void {
      rig.query().value = text;
      rig.query().dispatchEvent(new Event("input", { bubbles: true }));
    },
    press(key: string): void {
      rig
        .query()
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
  };
  rig.panel = createQuickOpen({
    container,
    items: () => rig.items,
    openItem: (id) => {
      rig.opened.push(id);
      rig.order.push(`open:${id}`);
    },
    selectItem: (id) => {
      rig.selected.push(id);
      rig.order.push(`select:${id}`);
    },
    onDismiss: () => {
      rig.dismissals += 1;
    },
  });
  live = rig;
  return rig;
}

afterEach(() => {
  // The unit binds TWO document-level listeners. The suite shares one document
  // across every file, so a rig left alive answers another file's Ctrl+P.
  live?.panel.destroy();
  live?.container.remove();
  live = null;
});

describe("matchItems", () => {
  test("an empty query offers everything, in walk order", () => {
    // A panel that opens empty looks broken. The writer has not typed yet; the
    // manuscript is the answer.
    const { shown, total } = matchItems(ITEMS, "");
    expect(shown.map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "s3"]);
    expect(total).toBe(5);
  });

  test("whitespace is not a query", () => {
    expect(matchItems(ITEMS, "   ").total).toBe(5);
  });

  test("matches a SUBSTRING anywhere in the title", () => {
    const { shown } = matchItems(ITEMS, "harbour");
    expect(shown.map((i) => i.id).sort()).toEqual(["c1", "p1", "s2", "s3"]);
  });

  test("PREFIX matches come first, each group keeping walk order", () => {
    // A writer typing "harb" wants "Harbour Lights" before "The Old Harbour",
    // and within each group the manuscript's own order is the only one that
    // means anything - alphabetical would scatter a book's chapters.
    expect(matchItems(ITEMS, "harb").shown.map((i) => i.id)).toEqual(["p1", "s2", "c1", "s3"]);
  });

  test("is case-insensitive in both directions", () => {
    expect(matchItems(ITEMS, "HARBOUR").total).toBe(4);
    expect(matchItems(ITEMS, "winter").total).toBe(1);
  });

  test("a query matching nothing returns nothing", () => {
    const { shown, total } = matchItems(ITEMS, "zeppelin");
    expect(shown.length).toBe(0);
    expect(total).toBe(0);
  });

  test("the cap limits what is SHOWN but not what is COUNTED", () => {
    // The status line is the only place the cap is visible, so `total` has to
    // be the real figure. A cap folded into the count is a panel quietly
    // answering a different question than the one asked.
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `s${i}`,
      title: `Scene ${i}`,
      type: "scene",
    }));
    const { shown, total } = matchItems(many, "scene");
    expect(total).toBe(120);
    expect(shown.length).toBeLessThan(120);
    expect(shown.length).toBeGreaterThan(0);
  });

  test("the cap applies to an empty query too", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `s${i}`,
      title: `Scene ${i}`,
      type: "scene",
    }));
    expect(matchItems(many, "").shown.length).toBeLessThan(120);
  });
});

describe("the panel", () => {
  test("mounts hidden, with a field, a status line and a listbox", () => {
    const rig = mount();
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(true);
    expect(rig.el<HTMLElement>("#quick-open-results").getAttribute("role")).toBe("listbox");
    expect(rig.query().getAttribute("role")).toBe("combobox");
  });

  test("open() shows it, paints every item and focuses the field", () => {
    const rig = mount();
    rig.panel.open();
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(false);
    expect(rig.rows().length).toBe(ITEMS.length);
    expect(document.activeElement?.id).toBe("quick-open-query");
  });

  test("open() CLEARS the previous query", () => {
    // Quick open is a jump, not a search: the writer is going somewhere new and
    // the previous destination is not a starting point.
    const rig = mount();
    rig.panel.open();
    rig.type("winter");
    expect(rig.rows().length).toBe(1);
    rig.panel.open();
    expect(rig.query().value).toBe("");
    expect(rig.rows().length).toBe(ITEMS.length);
  });

  test("typing filters the rows", () => {
    const rig = mount();
    rig.panel.open();
    rig.type("winter");
    expect(rig.rows().map((r) => r.dataset.itemId)).toEqual(["s1"]);
  });

  test("the LIVE walk is read on every open, never cached", () => {
    // A scene created a moment ago exists in the outline's walk and nowhere
    // else. A Map built at mount answers `undefined` for it - the defect the
    // outline slice shipped once, where a created row appeared and clicking it
    // did nothing.
    const rig = mount();
    rig.panel.open();
    expect(rig.rows().length).toBe(ITEMS.length);
    rig.items.push({ id: "s9", title: "Brand New Scene", type: "scene" });
    rig.panel.open();
    expect(rig.rows().length).toBe(ITEMS.length + 1);
  });
});

describe("choosing", () => {
  test("Return opens the highlighted scene and closes the panel", () => {
    // Closed BEFORE the scene is reached: opening moves focus into the editor,
    // and a panel still up over the prose the writer just asked for is the find
    // panel's recorded mistake.
    const rig = mount();
    rig.panel.open();
    rig.type("winter");
    rig.press("Enter");
    expect(rig.opened).toEqual(["s1"]);
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(true);
  });

  test("choosing a SCENE moves the selection too, before it opens", () => {
    // The selection is what Outline > Delete, a create and Alt+Arrow act on.
    // Leaving it behind meant "go to that scene, then delete it" binned the
    // scene the writer had left - measured by mreplace-cli, which binned the
    // boot scene rather than the one it had jumped to.
    const rig = mount();
    rig.panel.open();
    rig.type("winter");
    rig.press("Enter");
    expect(rig.selected).toEqual(["s1"]);
    expect(rig.order).toEqual(["select:s1", "open:s1"]);
  });

  test("a part or a chapter is SELECTED, never opened", () => {
    // Neither holds a document. Selecting is the whole of what can honestly
    // happen, and it is more than doing nothing would be.
    const rig = mount();
    rig.panel.open();
    rig.type("harbour lights");
    rig.press("Enter");
    expect(rig.opened).toEqual([]);
    expect(rig.selected).toEqual(["p1"]);
  });

  test("clicking a row chooses it", () => {
    const rig = mount();
    rig.panel.open();
    rig.type("winter");
    rig.rows()[0]?.click();
    expect(rig.opened).toEqual(["s1"]);
  });

  test("Return with no matches does nothing at all", () => {
    const rig = mount();
    rig.panel.open();
    rig.type("zeppelin");
    rig.press("Enter");
    expect(rig.opened).toEqual([]);
    expect(rig.selected).toEqual([]);
    // Still open: there is nothing to have gone to, so closing would look like
    // something happened.
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(false);
  });
});

describe("the keyboard", () => {
  test("the first row is highlighted as soon as there are rows", () => {
    const rig = mount();
    rig.panel.open();
    expect(rig.rows()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rig.query().getAttribute("aria-activedescendant")).toBe(rig.rows()[0]?.id);
  });

  test("ArrowDown and ArrowUp move the highlight and WRAP", () => {
    const rig = mount();
    rig.panel.open();
    rig.press("ArrowDown");
    expect(rig.rows()[1]?.getAttribute("aria-selected")).toBe("true");
    rig.press("ArrowUp");
    expect(rig.rows()[0]?.getAttribute("aria-selected")).toBe("true");
    rig.press("ArrowUp");
    expect(rig.rows().at(-1)?.getAttribute("aria-selected")).toBe("true");
  });

  test("focus STAYS in the field while the arrows move the highlight", () => {
    // Moving focus onto the rows would mean Shift+Tab to correct a typo and
    // would put forty rows in the page's tab order. aria-activedescendant is
    // what tells a screen reader which row is current.
    const rig = mount();
    rig.panel.open();
    rig.press("ArrowDown");
    expect(document.activeElement?.id).toBe("quick-open-query");
    expect(rig.query().getAttribute("aria-activedescendant")).toBe(rig.rows()[1]?.id);
  });

  test("Return opens the row the arrows landed on, not the first", () => {
    // Without this, an implementation ignoring `active` entirely passes every
    // other test in this block.
    const rig = mount();
    rig.panel.open();
    rig.type("harb");
    rig.press("ArrowDown");
    const second = rig.rows()[1]?.dataset.itemId;
    rig.press("Enter");
    // Every chosen row is selected; a scene is opened as well. Both are about
    // the SECOND row, which is the whole claim.
    expect(new Set(rig.order)).toEqual(new Set([`select:${second!}`, `open:${second!}`]));
  });

  test("typing resets the highlight to the first row", () => {
    // The old index means nothing against a new list, and a stale one opens a
    // scene the writer never looked at.
    const rig = mount();
    rig.panel.open();
    rig.press("ArrowDown");
    rig.press("ArrowDown");
    rig.type("harb");
    expect(rig.rows()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  test("Escape closes and hands the dismissal to the page, once", () => {
    const rig = mount();
    rig.panel.open();
    rig.press("Escape");
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(true);
    expect(rig.dismissals).toBe(1);
  });

  test("a key that is not Escape neither closes nor dismisses", () => {
    // Without this, a handler firing onDismiss on every keystroke satisfies the
    // test above.
    const rig = mount();
    rig.panel.open();
    rig.press("x");
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(false);
    expect(rig.dismissals).toBe(0);
  });
});

describe("Ctrl+P", () => {
  function chord(init: KeyboardEventInit): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  }

  test("opens the panel from anywhere in the page", () => {
    const rig = mount();
    chord({ key: "p", ctrlKey: true });
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(false);
  });

  test("is preventDefault'd, because WebKit prints on it", () => {
    mount();
    const event = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a bare p does not open it", () => {
    const rig = mount();
    chord({ key: "p" });
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(true);
  });

  test("Ctrl+Alt+P does not open it", () => {
    const rig = mount();
    chord({ key: "p", ctrlKey: true, altKey: true });
    expect(rig.el<HTMLElement>("#quick-open-panel").hidden).toBe(true);
  });

  test("destroy() removes BOTH document listeners", () => {
    // COUNTED, not observed. A leaked document listener changes no DOM state
    // and no behaviour a test can reach - the handler runs against detached
    // elements and does nothing visible - while accumulating one live closure
    // per project switch. A mutation deleting the removal SURVIVED an earlier
    // version of this test, which only asserted the panel element was gone;
    // that was true either way.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const rig = mount();
      rig.panel.destroy();
      expect(added.length).toBeGreaterThan(0);
      expect([...removed].sort()).toEqual([...added].sort());
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });

  test("the panel is unreachable after destroy", () => {
    const rig = mount();
    rig.panel.destroy();
    chord({ key: "p", ctrlKey: true });
    expect(rig.container.querySelector("#quick-open-panel")).toBeNull();
  });
});

describe("the bible in Go to", () => {
  test("a bible document is listed and OPENS, not merely selected", () => {
    // The panel reads the LIVE walk, which keeps the bible: a writer who cannot
    // reach their synopsis by keyboard has a section they can only scroll to.
    // What must not happen is the 2026-08-19 defect -- selected without being
    // opened -- which left every selection-driven command acting on the row the
    // writer had left.
    const rig = mount([
      { id: "s1", title: "Harbour Lights", type: "scene" },
      { id: "n1", title: "Harbour, the place", type: "note" },
    ]);
    rig.panel.open();
    rig.type("harbour,");
    rig.press("Enter");
    expect(rig.opened).toEqual(["n1"]);
    expect(rig.selected).toEqual(["n1"]);
  });
});

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`composition does not navigate or dismiss quick open (${JSON.stringify(composition)})`, () => {
    const r = mount(); r.panel.open(); r.type("harbour");
    const active = r.query().getAttribute("aria-activedescendant");
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, ...composition, bubbles: true, cancelable: true });
      r.query().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(r.query().getAttribute("aria-activedescendant")).toBe(active);
      expect(r.el<HTMLElement>("#quick-open-panel").hidden).toBe(false);
      expect(r.selected).toEqual([]); expect(r.dismissals).toBe(0);
    }
    r.press("Enter"); expect(r.selected).toEqual(["p1"]);
  });
}
