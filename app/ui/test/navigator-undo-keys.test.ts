import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";

/** The same fixture the delete-key and move-key tests use. */
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
  const undone: number[] = [];
  const redone: number[] = [];
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: source(),
    rowHeight: 20,
    overscan: 4,
    mode: "virtual",
    onUndo: () => undone.push(1),
    onRedo: () => redone.push(1),
  });
  return { container, nav, undone, redone };
}

function press(
  container: HTMLElement,
  key: string,
  modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  container.dispatchEvent(event);
  return event;
}

describe("navigator Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y", () => {
  test("Ctrl+Z calls onUndo once and prevents default", () => {
    const { container, nav, undone, redone } = mountRecording();
    nav.selectById("scene-1");
    const event = press(container, "z", { ctrlKey: true });
    expect(undone).toEqual([1]);
    expect(redone).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    nav.destroy();
    container.remove();
  });

  test("Ctrl+Shift+Z calls onRedo, not onUndo", () => {
    const { container, nav, undone, redone } = mountRecording();
    nav.selectById("scene-1");
    press(container, "z", { ctrlKey: true, shiftKey: true });
    expect(undone).toEqual([]);
    expect(redone).toEqual([1]);
    nav.destroy();
    container.remove();
  });

  test("Ctrl+Shift+Z with the browser's own uppercase key still calls onRedo", () => {
    // A REAL Shift+Z keydown reports `key: "Z"`, not "z" -- lower-casing the
    // fixture in the test above proves nothing about that shape, which is
    // what a browser actually delivers for a shifted letter.
    const { container, nav, undone, redone } = mountRecording();
    nav.selectById("scene-1");
    press(container, "Z", { ctrlKey: true, shiftKey: true });
    expect(undone).toEqual([]);
    expect(redone).toEqual([1]);
    nav.destroy();
    container.remove();
  });

  test("Ctrl+Y calls onRedo", () => {
    const { container, nav, redone } = mountRecording();
    nav.selectById("scene-1");
    press(container, "y", { ctrlKey: true });
    expect(redone).toEqual([1]);
    nav.destroy();
    container.remove();
  });

  test("handleKey never reaches onUndo or onRedo", () => {
    // THE load-bearing test, same reason Alt+Arrow and Delete are pinned here:
    // the synthetic measurement workload drives handleKey directly, and a
    // measured soak must not be able to undo the tree it is measuring.
    const { nav, undone, redone } = mountRecording();
    nav.selectById("scene-1");
    nav.handleKey("z");
    expect(undone).toEqual([]);
    expect(redone).toEqual([]);
    nav.destroy();
  });

  for (const key of ["a", "s"]) {
    test(`Ctrl+${key} still falls through to the modifier guard`, () => {
      // Ctrl+Z and Ctrl+Y are the only chords this handler claims; every other
      // Ctrl combination must reach neither onUndo nor onRedo.
      const { container, nav, undone, redone } = mountRecording();
      nav.selectById("scene-1");
      press(container, key, { ctrlKey: true });
      expect(undone).toEqual([]);
      expect(redone).toEqual([]);
      nav.destroy();
      container.remove();
    });
  }

  test("Alt+Z does nothing", () => {
    const { container, nav, undone, redone } = mountRecording();
    nav.selectById("scene-1");
    press(container, "z", { altKey: true });
    expect(undone).toEqual([]);
    expect(redone).toEqual([]);
    nav.destroy();
    container.remove();
  });
});
