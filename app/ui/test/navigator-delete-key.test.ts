import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";

/** Deliberately the same fixture the move-key tests use: "Return" at index 4 is
 *  what lets the type-ahead control below actually match something. */
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

function mountRecording() {
  const removed: string[] = [];
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: source(),
    rowHeight: 20,
    overscan: 4,
    mode: "virtual",
    onRemove: (id) => removed.push(id),
  });
  return { container, nav, removed };
}

/** Cancelable, so `defaultPrevented` carries information. A non-cancelable
 *  event reports false however many times preventDefault was called, which
 *  makes every assertion about it vacuous. */
function press(
  container: HTMLElement,
  key: string,
  modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  container.dispatchEvent(event);
  return event;
}

describe("navigator Delete", () => {
  test("reports the selected row", () => {
    const { container, nav, removed } = mountRecording();
    nav.selectById("scene-1");
    const event = press(container, "Delete");
    expect(removed).toEqual(["scene-1"]);
    expect(event.defaultPrevented).toBe(true);
    nav.destroy();
    container.remove();
  });

  test("handleKey never reaches onRemove", () => {
    // THE load-bearing test. The synthetic measurement workload calls handleKey
    // directly for tens of thousands of actions, and a soak that could delete
    // rows out of the tree it is measuring invalidates every gate it reports.
    // This is the same rule Alt+Arrow follows and it is pinned the same way.
    const { container, nav, removed } = mountRecording();
    nav.selectById("scene-1");
    nav.handleKey("Delete");
    expect(removed).toEqual([]);
    nav.destroy();
    container.remove();
  });

  for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
    test(`${modifier}+Delete is not a delete`, () => {
      // A modified Delete is some other command, or the browser's. Deleting on
      // it would make an accidental chord destroy structure with no undo.
      const { container, nav, removed } = mountRecording();
      nav.selectById("scene-1");
      press(container, "Delete", { [modifier]: true });
      expect(removed).toEqual([]);
      nav.destroy();
      container.remove();
    });
  }

  test("an unmodified printable key still reaches type-ahead", () => {
    // The control for the modifier tests above. Without it, a guard that
    // swallowed EVERY key would satisfy all four of them: they only assert that
    // something did not happen. "Return" is a live prefix in this fixture, so
    // this one can actually fail.
    const { container, nav, removed } = mountRecording();
    nav.selectById("part-0");
    press(container, "r");
    expect(nav.activeTitle()).toBe("Return");
    expect(removed).toEqual([]);
    nav.destroy();
    container.remove();
  });
});
