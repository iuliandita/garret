// The navigator's half of the context menu: the two routes that open it, the
// selection it moves first, and the native menu it suppresses.
//
// The menu's own items are tested in nav-context-menu.test.ts. What lives here
// is everything the navigator decides.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";

const ITEMS = [
  { id: "part-0", parent_id: null, depth: 0, title: "Part One" },
  { id: "scene-0", parent_id: "part-0", depth: 1, title: "Arrival" },
  { id: "scene-1", parent_id: "part-0", depth: 1, title: "Departure" },
];

function source(): TreeSource {
  return {
    count: ITEMS.length,
    seed: "test",
    titleAt: (i) => ITEMS[i]!.title,
    idAt: (i) => ITEMS[i]!.id,
    depthAt: (i) => ITEMS[i]!.depth,
    items: ITEMS.map((i) => ({ id: i.id, parent_id: i.parent_id })),
  };
}

interface Opened {
  itemId: string;
  x: number;
  y: number;
}

function mount() {
  const opened: Opened[] = [];
  const selected: Array<string | null> = [];
  const container = document.createElement("div");
  container.id = "nav";
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: source(),
    rowHeight: 20,
    overscan: 4,
    mode: "naive",
    onSelect: (id) => selected.push(id),
    onContextMenu: (itemId, x, y) => opened.push({ itemId, x, y }),
  });
  return { container, nav, opened, selected };
}

function teardown(rig: ReturnType<typeof mount>): void {
  rig.nav.destroy();
  rig.container.remove();
}

function rowFor(container: HTMLElement, itemId: string): HTMLElement {
  for (const el of container.querySelectorAll("[data-item-id]")) {
    if (el instanceof HTMLElement && el.dataset.itemId === itemId) return el;
  }
  throw new Error(`no painted row for ${itemId}`);
}

function rightClick(target: HTMLElement, at: { x: number; y: number } = { x: 0, y: 0 }): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
  });
  target.dispatchEvent(event);
  return event;
}

function press(container: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  container.dispatchEvent(event);
  return event;
}

describe("a right-click SELECTS the row before it opens", () => {
  test("the selection moves onto the row under the pointer", () => {
    // RULE ONE, and it is a recorded defect exactly: quick open marked a scene open
    // without moving the navigator selection, so Outline > Delete binned the
    // scene the writer had LEFT. A menu opening on a row it has not selected has
    // the identical failure and hides it better, because the row under the
    // pointer looks selected.
    const rig = mount();
    try {
      expect(rig.nav.activeIndex()).toBe(0);
      rightClick(rowFor(rig.container, "scene-1"));
      expect(rig.nav.activeIndex()).toBe(2);
      expect(rig.nav.activeTitle()).toBe("Departure");
    } finally {
      teardown(rig);
    }
  });

  test("the selection has ALREADY moved when the menu is told to open", () => {
    // The order, not just the end state. A menu told to open before the
    // selection follows is a menu whose deps - every one of which reads or acts
    // on a row - can be handed the wrong one, and no end-state assertion can see
    // the difference. Read from INSIDE the callback, which is the only vantage
    // point that can tell the two orders apart.
    const seenAtOpen: number[] = [];
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    document.body.appendChild(container);
    let nav: { activeIndex(): number; destroy(): void } | null = null;
    nav = createNavigator({
      container,
      source: source(),
      rowHeight: 20,
      overscan: 4,
      mode: "naive",
      onContextMenu: () => seenAtOpen.push(nav?.activeIndex() ?? -1),
    });
    try {
      rightClick(rowFor(container, "scene-1"));
      expect(seenAtOpen).toEqual([2]);
    } finally {
      nav.destroy();
      container.remove();
    }
  });

  test("it announces the move, like a click does", () => {
    // The outline bar reads onSelect to decide whether its one context control
    // says Delete or Restore. A selection that moved without announcing leaves
    // that label describing the row the writer moved away from.
    const rig = mount();
    try {
      rightClick(rowFor(rig.container, "scene-1"));
      expect(rig.selected).toEqual(["scene-1"]);
    } finally {
      teardown(rig);
    }
  });

  test("it reports the pointer's own coordinates", () => {
    const rig = mount();
    try {
      rightClick(rowFor(rig.container, "scene-0"), { x: 137, y: 412 });
      expect(rig.opened).toEqual([{ itemId: "scene-0", x: 137, y: 412 }]);
    } finally {
      teardown(rig);
    }
  });
});

describe("the native menu is suppressed in #nav and NOWHERE else", () => {
  test("a right-click inside the navigator is taken", () => {
    const rig = mount();
    try {
      expect(rightClick(rowFor(rig.container, "scene-0")).defaultPrevented).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("a right-click on the pane's blank space is taken too, and opens nothing", () => {
    // Half a suppression reads as a bug in the other half: the engine's menu
    // over the navigator's empty space offers a writer nothing this application
    // means.
    const rig = mount();
    try {
      const event = rightClick(rig.container);
      expect(event.defaultPrevented).toBe(true);
      expect(rig.opened).toEqual([]);
    } finally {
      teardown(rig);
    }
  });

  test("a right-click anywhere else keeps its native menu", () => {
    // THE EDITOR'S NATIVE MENU CARRIES WebKitGTK'S SPELLING SUGGESTIONS, which
    // is the whole of what the spelling slice delivered - and there is no user
    // dictionary, so those suggestions are all a writer gets. A handler on the
    // document rather than on #nav would remove them, and nothing in this suite
    // or in any graded rig would notice: no test and no gate looks at a menu the
    // engine draws.
    const rig = mount();
    const outside = document.createElement("div");
    document.body.append(outside);
    try {
      expect(rightClick(outside).defaultPrevented).toBe(false);
      expect(rig.opened).toEqual([]);
    } finally {
      outside.remove();
      teardown(rig);
    }
  });

  test("and it stops being suppressed once the navigator is destroyed", () => {
    const rig = mount();
    const container = rig.container;
    teardown(rig);
    document.body.append(container);
    expect(rightClick(container).defaultPrevented).toBe(false);
    container.remove();
  });
});

describe("the keyboard reaches the same menu", () => {
  test("Shift+F10 opens it on the selected row", () => {
    const rig = mount();
    try {
      press(rig.container, "ArrowDown");
      expect(rig.nav.activeTitle()).toBe("Arrival");
      const event = press(rig.container, "F10", { shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(rig.opened.map((o) => o.itemId)).toEqual(["scene-0"]);
    } finally {
      teardown(rig);
    }
  });

  test("the Menu key does too", () => {
    const rig = mount();
    try {
      press(rig.container, "ContextMenu");
      expect(rig.opened.map((o) => o.itemId)).toEqual(["part-0"]);
    } finally {
      teardown(rig);
    }
  });

  test("a bare F10 is not it", () => {
    const rig = mount();
    try {
      press(rig.container, "F10");
      expect(rig.opened).toEqual([]);
    } finally {
      teardown(rig);
    }
  });

  test("the synthetic workload cannot reach it", () => {
    // handleKey is what the measurement soak drives directly, tens of thousands
    // of times. A soak that opened menus would be measuring a surface no writer
    // asked for - the same rule that keeps activation, Alt+Arrow and Delete out
    // of handleKeyInternal.
    const rig = mount();
    try {
      rig.nav.handleKey("F10");
      rig.nav.handleKey("ContextMenu");
      expect(rig.opened).toEqual([]);
    } finally {
      teardown(rig);
    }
  });
});
