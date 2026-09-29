import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";
import type { MoveDirection } from "../src/outline";

/** Same shape as navigator-activation's fixture, and deliberately the same
 *  titles: "Return" at index 4 is what makes the Alt+r type-ahead test capable
 *  of failing. A fixture with no row starting with "r" would pass with the
 *  guard deleted. */
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

interface MoveCall {
  id: string;
  direction: MoveDirection;
}

function mount(onMove?: (id: string, direction: MoveDirection) => void) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: source(),
    rowHeight: 20,
    overscan: 4,
    mode: "virtual",
    onMove,
  });
  return { container, nav };
}

function mountRecording() {
  const moves: MoveCall[] = [];
  const { container, nav } = mount((id, direction) => moves.push({ id, direction }));
  return { container, nav, moves };
}

/** Dispatched as a real cancelable event so `defaultPrevented` means something.
 *  A non-cancelable event reports false however many times preventDefault is
 *  called, which would make every preventDefault assertion inert. */
function press(
  container: HTMLElement,
  key: string,
  modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  container.dispatchEvent(event);
  return event;
}

describe("navigator Alt+Arrow moves", () => {
  const cases: [string, MoveDirection][] = [
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
    ["ArrowLeft", "outdent"],
    ["ArrowRight", "indent"],
  ];

  for (const [key, direction] of cases) {
    test(`Alt+${key} reports ${direction} for the selected row`, () => {
      const { container, nav, moves } = mountRecording();
      nav.selectById("scene-1");
      const event = press(container, key, { altKey: true });
      expect(moves).toEqual([{ id: "scene-1", direction }]);
      expect(event.defaultPrevented).toBe(true);
      nav.destroy();
      container.remove();
    });
  }

  test("handleKey never reaches onMove, for any arrow", () => {
    // THE load-bearing test of this slice. The synthetic measurement workload
    // calls handleKey directly for tens of thousands of actions; a soak that
    // could rewrite the tree it is measuring invalidates every gate it reports.
    // Selection is moved off the top row first so ArrowUp/ArrowLeft are not
    // clamped no-ops - a test that only ever pressed an inert direction would
    // pass with the mutation wired straight into handleKeyInternal.
    const { container, nav, moves } = mountRecording();
    nav.selectById("scene-1");
    for (const [key] of cases) nav.handleKey(key);
    expect(moves).toEqual([]);
    nav.destroy();
    container.remove();
  });

  test("Alt+ArrowUp does not move the selection", () => {
    // The move is applied by the store and arrives back through reload. A
    // navigator that also moved its own cursor would be guessing where the row
    // landed, and would be wrong whenever the store refused the move.
    const { container, nav, moves } = mountRecording();
    nav.selectById("scene-1");
    expect(nav.activeIndex()).toBe(2);
    press(container, "ArrowUp", { altKey: true });
    expect(nav.activeIndex()).toBe(2);
    expect(moves).toHaveLength(1);
    nav.destroy();
    container.remove();
  });

  test("Ctrl+Alt+ArrowUp is ignored", () => {
    const { container, nav, moves } = mountRecording();
    nav.selectById("scene-1");
    press(container, "ArrowUp", { altKey: true, ctrlKey: true });
    expect(moves).toEqual([]);
    expect(nav.activeIndex()).toBe(2);
    nav.destroy();
    container.remove();
  });

  test("Meta+Alt+ArrowUp is ignored", () => {
    const { container, nav, moves } = mountRecording();
    nav.selectById("scene-1");
    press(container, "ArrowUp", { altKey: true, metaKey: true });
    expect(moves).toEqual([]);
    expect(nav.activeIndex()).toBe(2);
    nav.destroy();
    container.remove();
  });

  test("Alt+r does not reach type-ahead", () => {
    // An Alt chord this UI does not define must reach neither activation nor
    // type-ahead, which is why the Alt branch returns unconditionally. "r"
    // matches "Return" at index 4, so a guard limited to the four arrow keys
    // would let this through and the selection would jump.
    const { container, nav, moves } = mountRecording();
    expect(nav.activeIndex()).toBe(0);
    press(container, "r", { altKey: true });
    expect(nav.activeIndex()).toBe(0);
    expect(moves).toEqual([]);
    nav.destroy();
    container.remove();
  });

  test("with no onMove supplied Alt+ArrowUp is inert and does not throw", () => {
    const { container, nav } = mount();
    nav.selectById("scene-1");
    expect(() => press(container, "ArrowUp", { altKey: true })).not.toThrow();
    expect(nav.activeIndex()).toBe(2);
    nav.destroy();
    container.remove();
  });
});
