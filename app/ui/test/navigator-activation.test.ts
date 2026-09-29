import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";

/** A two-part tree: part-0 with scene-0/scene-1, part-1 with scene-2. Depth
 *  first, which is the order the store's walk produces. */
function source(): TreeSource {
  const items = [
    { id: "part-0", parent_id: null, depth: 0, title: "Part One" },
    { id: "scene-0", parent_id: "part-0", depth: 1, title: "Arrival" },
    { id: "scene-1", parent_id: "part-0", depth: 1, title: "Departure" },
    { id: "part-1", parent_id: null, depth: 0, title: "Part Two" },
    { id: "scene-2", parent_id: "part-1", depth: 1, title: "Return" },
  ];
  return {
    count: items.length,
    seed: "test",
    titleAt: (i) => items[i]!.title,
    idAt: (i) => items[i]!.id,
    depthAt: (i) => items[i]!.depth,
    items: items.map((i) => ({ id: i.id, parent_id: i.parent_id })),
  };
}

function mount(onActivate?: (id: string) => void) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: source(),
    rowHeight: 20,
    overscan: 4,
    mode: "virtual",
    onActivate,
  });
  return { container, nav };
}

const rowOf = (container: HTMLElement, itemId: string): HTMLElement => {
  const el = container.querySelector(`[data-item-id="${itemId}"]`);
  if (el === null) throw new Error(`row ${itemId} is not mounted`);
  return el as HTMLElement;
};

describe("navigator selection state", () => {
  test("the selected row carries aria-selected and no other row does", () => {
    const { container, nav } = mount();
    expect(rowOf(container, "part-0").getAttribute("aria-selected")).toBe("true");
    nav.handleKey("ArrowDown");
    expect(rowOf(container, "scene-0").getAttribute("aria-selected")).toBe("true");
    expect(rowOf(container, "part-0").getAttribute("aria-selected")).toBeNull();
    nav.destroy();
    container.remove();
  });

  test("selectById moves the selection", () => {
    const { container, nav } = mount();
    nav.selectById("scene-2");
    expect(nav.activeIndex()).toBe(4);
    expect(rowOf(container, "scene-2").getAttribute("aria-selected")).toBe("true");
    nav.destroy();
    container.remove();
  });

  test("selectById on an unknown id leaves the selection alone", () => {
    const { container, nav } = mount();
    nav.selectById("nope");
    expect(nav.activeIndex()).toBe(0);
    nav.destroy();
    container.remove();
  });

  test("setOpen marks exactly one row with aria-current", () => {
    const { container, nav } = mount();
    nav.setOpen("scene-1");
    expect(rowOf(container, "scene-1").getAttribute("aria-current")).toBe("true");
    nav.setOpen("scene-2");
    expect(rowOf(container, "scene-1").getAttribute("aria-current")).toBeNull();
    expect(rowOf(container, "scene-2").getAttribute("aria-current")).toBe("true");
    nav.destroy();
    container.remove();
  });

  test("activate reports the selected row's item id", () => {
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    nav.selectById("scene-1");
    nav.activate();
    expect(seen).toEqual(["scene-1"]);
    nav.destroy();
    container.remove();
  });
});

describe("navigator input", () => {
  test("a click on a row activates that row's item", () => {
    // Dispatched as a real event, not by calling activate(). A test that calls
    // the method directly passes with no listener installed at all - that is
    // exactly how a keymap shipped broken in the previous slice.
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    rowOf(container, "scene-1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual(["scene-1"]);
    nav.destroy();
    container.remove();
  });

  test("a click also moves the selection to the clicked row", () => {
    const { container, nav } = mount();
    rowOf(container, "scene-2").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(nav.activeIndex()).toBe(4);
    nav.destroy();
    container.remove();
  });

  test("a click on the background activates nothing", () => {
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual([]);
    nav.destroy();
    container.remove();
  });

  test("Enter activates the selected row", () => {
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    nav.selectById("scene-1");
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(seen).toEqual(["scene-1"]);
    nav.destroy();
    container.remove();
  });

  test("Space activates the selected row", () => {
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    nav.selectById("scene-0");
    container.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(seen).toEqual(["scene-0"]);
    nav.destroy();
    container.remove();
  });

  test("ArrowDown moves the selection and opens nothing", () => {
    // Select-follows-focus would make one PageDown a document load, and at
    // stress would put 15,200 store round trips behind a held arrow key.
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(nav.activeIndex()).toBe(1);
    expect(seen).toEqual([]);
    nav.destroy();
    container.remove();
  });

  test("a modified key neither navigates nor activates", () => {
    // Without the modifier guard a shortcut is a single printable character
    // and type-ahead swallows it, jumping to the first row with that prefix.
    //
    // The key MUST be one this fixture can actually match. An earlier version
    // pressed Ctrl+Z, and no title here starts with "z", so type-ahead
    // returned the current index and the test passed with the guard deleted -
    // it was asserting a property of the fixture, not of the code. "r" hits
    // "Return" at index 4, so the guard is the only thing holding the
    // selection at 0.
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true }),
    );
    expect(nav.activeIndex()).toBe(0);
    expect(seen).toEqual([]);
    nav.destroy();
    container.remove();
  });

  test("an unmodified printable key still reaches type-ahead", () => {
    // The control for the test above: without it, a guard that swallowed
    // every printable key would satisfy the modifier test too.
    const { container, nav } = mount();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    expect(nav.activeIndex()).toBe(4);
    nav.destroy();
    container.remove();
  });

  test("destroy removes the listeners", () => {
    const seen: string[] = [];
    const { container, nav } = mount((id) => seen.push(id));
    nav.destroy();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(seen).toEqual([]);
    container.remove();
  });
});
