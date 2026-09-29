// onSelect: the channel the outline bar's one context control reads to know
// whether it is offering Delete or Restore.
//
// The whole point of this callback is WHERE it is called from. It fires from
// the real click and keydown listeners and from nowhere else - not from
// setActive, which handleKey reaches, and which the synthetic measurement
// workload drives directly for tens of thousands of navigation actions. A
// subscriber doing real work there would run on every measured key.
//
// Activation and Alt+Arrow live outside handleKey for the same reason. These
// tests are what keeps the third one there.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";

const mounted: Array<{ container: HTMLElement; nav: { destroy(): void } }> = [];

function source(): TreeSource {
  const items = [
    { id: "part-0", parent_id: null, depth: 0, title: "Part One" },
    { id: "scene-0", parent_id: "part-0", depth: 1, title: "Arrival" },
    { id: "scene-1", parent_id: "part-0", depth: 1, title: "Departure" },
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
  const selected: Array<string | null> = [];
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: source(),
    rowHeight: 20,
    overscan: 4,
    mode: "virtual",
    onSelect: (id) => selected.push(id),
  });
  const recording = { container, nav, selected };
  mounted.push(recording);
  return recording;
}

afterEach(() => {
  for (const recording of mounted.splice(0)) {
    recording.nav.destroy();
    recording.container.remove();
  }
});

function press(container: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  container.dispatchEvent(event);
  return event;
}

describe("navigator: onSelect", () => {
  test("is silent at construction", () => {
    // setActive(0) runs in the constructor. A subscriber has nothing to react
    // to there - nothing moved - and the bar syncs itself once anyway.
    const { selected } = mountRecording();

    expect(selected).toEqual([]);
  });

  test("reports the row a real arrow key moved to", () => {
    const { container, selected } = mountRecording();

    press(container, "ArrowDown");

    expect(selected).toEqual(["scene-0"]);
  });

  test("stays silent when a key moved nothing", () => {
    // ArrowUp at the top. The selection did not change, so there is nothing to
    // tell the bar and no reason to repaint a label.
    const { container, selected } = mountRecording();

    press(container, "ArrowUp");

    expect(selected).toEqual([]);
  });

  test("reports the row a real click landed on", () => {
    const { container, selected } = mountRecording();
    const row = container.querySelector('[data-item-id="scene-1"]');
    expect(row).not.toBeNull();

    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(selected).toEqual(["scene-1"]);
  });

  test("handleKey moves the selection and reports NOTHING", () => {
    // The load-bearing one. handleKey is what the measured soak calls, tens of
    // thousands of times; onSelect reaching it would put the subscriber's work
    // - an ancestor walk over 20,060 rows at the stress fixture - on the
    // measured path. Moving announceSelection() into setActive turns this red
    // and nothing else does.
    const { nav, selected } = mountRecording();

    nav.handleKey("ArrowDown");
    nav.handleKey("ArrowDown");

    // It really did move: without this the test passes on a navigator whose
    // arrow keys do nothing at all.
    expect(nav.activeIndex()).toBe(2);
    expect(selected).toEqual([]);
  });

  test("a reload that preserves the selection reports nothing", () => {
    // reload calls setActive to put the cursor back on the row it was on. That
    // is not the writer moving, and the bar has already been synced by the
    // outline's own reload path.
    const { nav, container, selected } = mountRecording();
    press(container, "ArrowDown");
    selected.length = 0;

    nav.reload(source());

    expect(selected).toEqual([]);
  });
});
