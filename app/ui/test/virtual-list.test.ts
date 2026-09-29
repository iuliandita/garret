import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

// The pure window math needs no DOM; setCount does, because the spacer height
// and the mounted set are the things it has to move.
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createVirtualList, visibleRange, SECTION_GAP } from "../src/navigator/virtual-list";

function makeContainer(clientHeight = 100): HTMLElement {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
  document.body.append(container);
  return container;
}

describe("visibleRange", () => {
  test("at the top, starts at 0 and mounts the viewport plus overscan", () => {
    const r = visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 });
    expect(r.start).toBe(0);
    expect(r.end).toBe(7); // 5 visible + 2 overscan, clamped at the top
  });

  test("overscan extends backwards once scrolled", () => {
    const r = visibleRange({ scrollTop: 200, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 });
    expect(r.start).toBe(8);  // 10 - 2
    expect(r.end).toBe(17);   // 10 + 5 + 2
  });

  test("clamps at the end without exceeding the count", () => {
    const r = visibleRange({ scrollTop: 19_900, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 });
    expect(r.end).toBe(1000);
    expect(r.start).toBeLessThan(r.end);
  });

  test("the last row is always reachable", () => {
    const count = 15_200;
    const rowHeight = 20;
    const viewportHeight = 640;
    const maxScroll = count * rowHeight - viewportHeight;
    const r = visibleRange({ scrollTop: maxScroll, viewportHeight, rowHeight, count, overscan: 3 });
    expect(r.end).toBe(count);
  });

  test("an empty set mounts nothing rather than one phantom row", () => {
    const r = visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 0, overscan: 2 });
    expect(r.start).toBe(0);
    expect(r.end).toBe(0);
  });

  test("negative scroll (rubber-banding) does not produce a negative start", () => {
    const r = visibleRange({ scrollTop: -50, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 });
    expect(r.start).toBe(0);
  });

  test("property: mounted count stays bounded and the range is well-formed", () => {
    const count = 15_200;
    const rowHeight = 20;
    const viewportHeight = 640;
    const overscan = 3;
    const maxMounted = Math.ceil(viewportHeight / rowHeight) + 2 * overscan + 1;
    const maxScroll = count * rowHeight - viewportHeight;

    for (let i = 0; i <= 400; i++) {
      const scrollTop = Math.round((maxScroll * i) / 400);
      const r = visibleRange({ scrollTop, viewportHeight, rowHeight, count, overscan });
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(count);
      expect(r.start).toBeLessThan(r.end);
      expect(r.end - r.start).toBeLessThanOrEqual(maxMounted);
    }
  });

  test("property: every index is mounted at some scroll position, none skipped", () => {
    const count = 500;
    const rowHeight = 20;
    const viewportHeight = 100;
    const seen = new Set<number>();
    for (let scrollTop = 0; scrollTop <= count * rowHeight; scrollTop += rowHeight) {
      const r = visibleRange({ scrollTop, viewportHeight, rowHeight, count, overscan: 0 });
      for (let i = r.start; i < r.end; i++) seen.add(i);
    }
    expect(seen.size).toBe(count);
  });
});

describe("setCount", () => {
  test("setCount shrinks the spacer and drops rows outside the new range", () => {
    const container = makeContainer();

    const list = createVirtualList({
      container,
      count: 1000,
      rowHeight: 20,
      overscan: 2,
      renderRow: (i, el) => {
        el.textContent = String(i);
      },
    });
    container.scrollTop = 19_000;
    list.refresh();
    expect(list.mountedRange().start).toBeGreaterThan(900);

    list.setCount(10);
    // 10 rows * 20px is 200px against a 100px viewport, so the clamped scroll
    // of 100 puts row 5 at the top: 5 - 2 overscan, through to the end.
    expect(list.mountedRange()).toEqual({ start: 3, end: 10 });
    const spacer = container.querySelector("div");
    expect(spacer?.style.height).toBe("200px");
    expect(spacer?.children.length).toBe(7);

    list.destroy();
    container.remove();
  });

  test("a shrink clamps the scroll to the new bottom instead of jumping to the top", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container,
      count: 1000,
      rowHeight: 20,
      overscan: 2,
      renderRow: () => {},
    });
    container.scrollTop = 19_000;
    list.refresh();

    list.setCount(10);
    // 10 rows * 20px - 100px of viewport. Collapsing a part near the bottom
    // must not teleport the reader to the top of the manuscript.
    expect(container.scrollTop).toBe(100);

    list.destroy();
    container.remove();
  });

  test("a grow extends the spacer and mounts the newly reachable rows without a manual refresh", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container,
      count: 3,
      rowHeight: 20,
      overscan: 2,
      renderRow: (i, el) => {
        el.textContent = String(i);
      },
    });
    expect(list.mountedRange().end).toBe(3);

    list.setCount(2000);
    expect(list.mountedRange().end).toBe(7); // 5 visible + 2 overscan
    expect(container.querySelector("div")?.style.height).toBe("40000px");

    list.destroy();
    container.remove();
  });

  test("rows surviving the change are repainted, because an index now means a different item", () => {
    const container = makeContainer();
    let generation = "a";
    const list = createVirtualList({
      container,
      count: 100,
      rowHeight: 20,
      overscan: 2,
      renderRow: (i, el) => {
        el.textContent = `${generation}${i}`;
      },
    });
    expect(container.textContent).toContain("a0");

    generation = "b";
    list.setCount(100);
    expect(container.textContent).toContain("b0");
    expect(container.textContent).not.toContain("a0");

    list.destroy();
    container.remove();
  });

  test("setCount(0) empties the list without a phantom row or a negative scroll", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container,
      count: 50,
      rowHeight: 20,
      overscan: 2,
      renderRow: (i, el) => {
        el.textContent = String(i);
      },
    });

    list.setCount(0);
    expect(list.mountedRange()).toEqual({ start: 0, end: 0 });
    expect(container.querySelector("div")?.style.height).toBe("0px");
    expect(container.scrollTop).toBe(0);
    expect(container.textContent).toBe("");
    expect(() => list.scrollToIndex(5)).not.toThrow();
    expect(container.scrollTop).toBe(0);

    list.destroy();
    container.remove();
  });

  test("rows outside the new count are dropped before the repaint, never repainted out of range", () => {
    const container = makeContainer();
    let currentCount = 1000;
    const list = createVirtualList({
      container,
      count: currentCount,
      rowHeight: 20,
      overscan: 2,
      renderRow: (i, el) => {
        // renderRow reads item i from a source of exactly currentCount rows.
        // Repainting a survivor before dropping it would index past the end.
        if (i >= currentCount) throw new RangeError(`renderRow(${i}) with count ${currentCount}`);
        el.textContent = String(i);
      },
    });
    container.scrollTop = 19_000;
    list.refresh();
    expect(list.mountedRange().start).toBeGreaterThan(900);

    currentCount = 10;
    expect(() => list.setCount(10)).not.toThrow();

    list.destroy();
    container.remove();
  });

  test("an unlaid-out container falls back to one row of viewport rather than dividing by zero", () => {
    const container = makeContainer(0);
    const list = createVirtualList({
      container,
      count: 1000,
      rowHeight: 20,
      overscan: 0,
      renderRow: () => {},
    });
    container.scrollTop = 19_980;
    list.refresh();

    // Without the fallback maxScroll is the full 200px extent, which leaves the
    // scroll past the last row and the list showing nothing.
    list.setCount(10);
    expect(container.scrollTop).toBe(180);
    expect(list.mountedRange()).toEqual({ start: 9, end: 10 });

    list.destroy();
    container.remove();
  });

  test("a negative count is clamped rather than sizing the spacer negatively", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container,
      count: 50,
      rowHeight: 20,
      overscan: 2,
      renderRow: () => {},
    });

    list.setCount(-5);
    expect(list.mountedRange()).toEqual({ start: 0, end: 0 });
    expect(container.querySelector("div")?.style.height).toBe("0px");

    list.destroy();
    container.remove();
  });
});

describe("repaint", () => {
  test("re-renders one mounted row without touching the others", () => {
    const container = makeContainer();
    const painted: number[] = [];
    const list = createVirtualList({
      container,
      count: 20,
      rowHeight: 10,
      overscan: 0,
      renderRow: (i, el) => {
        painted.push(i);
        el.textContent = `row ${i}`;
      },
    });
    painted.length = 0;
    list.repaint(3);
    expect(painted).toEqual([3]);
    list.destroy();
    container.remove();
  });

  test("repainting an unmounted index is a no-op", () => {
    const container = makeContainer();
    const painted: number[] = [];
    const list = createVirtualList({
      container,
      count: 2000,
      rowHeight: 10,
      overscan: 0,
      renderRow: (i) => {
        painted.push(i);
      },
    });
    painted.length = 0;
    list.repaint(1900);
    expect(painted).toEqual([]);
    list.destroy();
    container.remove();
  });
});

describe("a pane that changes size", () => {
  /** Stands in for the platform's ResizeObserver so the test can fire it.
   *
   *  The WIRING is what is under test, not render()'s arithmetic - which the
   *  visibleRange cases above already cover at every scroll position. A test
   *  that called list.refresh() by hand would pass against a list that observes
   *  nothing at all, which is the recorded "calls the command directly" shape.
   *  Here, a list that does not observe never registers a callback and this
   *  fails at the first assertion. */
  class FakeResizeObserver {
    static observed: Element[] = [];
    static callbacks: (() => void)[] = [];
    static disconnected = 0;
    constructor(callback: () => void) {
      FakeResizeObserver.callbacks.push(callback);
    }
    observe(element: Element): void {
      FakeResizeObserver.observed.push(element);
    }
    disconnect(): void {
      FakeResizeObserver.disconnected += 1;
    }
    unobserve(): void {}
  }

  function withFakeObserver<T>(body: () => T): T {
    const previous = (globalThis as Record<string, unknown>).ResizeObserver;
    FakeResizeObserver.observed = [];
    FakeResizeObserver.callbacks = [];
    FakeResizeObserver.disconnected = 0;
    (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
    try {
      return body();
    } finally {
      (globalThis as Record<string, unknown>).ResizeObserver = previous;
    }
  }

  test("a taller pane mounts the rows the extra height exposes", () => {
    withFakeObserver(() => {
      const container = makeContainer(100);
      const list = createVirtualList({
        container,
        count: 100,
        rowHeight: 20,
        overscan: 2,
        renderRow: (i, el) => {
          el.textContent = `row ${i}`;
        },
      });
      expect(FakeResizeObserver.observed).toEqual([container]);
      // 5 visible + 2 overscan.
      expect(list.mountedRange()).toEqual({ start: 0, end: 7 });

      // The pane grows. This is the window being enlarged, and until 2026-08-17
      // the range below stayed at 7 - so rows 7..21 sat in a blank strip with
      // no element to click.
      Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
      for (const fire of FakeResizeObserver.callbacks) fire();

      expect(list.mountedRange()).toEqual({ start: 0, end: 22 });
      // The elements, not just the bookkeeping: a range that says 22 over a
      // pane holding 7 elements is the same defect wearing a different number.
      expect(container.querySelector("[role='presentation']")?.children.length).toBe(22);
      list.destroy();
      container.remove();
    });
  });

  test("destroy disconnects the observer", () => {
    withFakeObserver(() => {
      const container = makeContainer(100);
      const list = createVirtualList({
        container,
        count: 100,
        rowHeight: 20,
        overscan: 2,
        renderRow: () => {},
      });
      expect(FakeResizeObserver.disconnected).toBe(0);
      list.destroy();
      expect(FakeResizeObserver.disconnected).toBe(1);
      container.remove();
    });
  });
});

// THE SECTION GAP (fix after the first ship): SECTION_GAP px of blank
// scroll-content space above the item at `gapIndex`, so the navigator's
// separator has real room to draw into instead of clipping into a fixed
// ROW_HEIGHT box. Every case here is pure `visibleRange` math except where a
// mounted row's own `top` or the spacer's height is what proves the gap moved
// real pixels, not just an index.
describe("visibleRange with a gap", () => {
  test("a scroll above the gap ignores it entirely", () => {
    const r = visibleRange({
      scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 50, overscan: 2, gapIndex: 10,
    });
    expect(r).toEqual({ start: 0, end: 7 });
  });

  test("a scroll past the gap subtracts SECTION_GAP before dividing by rowHeight", () => {
    // gapIndex 10, rowHeight 20: the gap occupies scroll pixels [200, 216).
    // scrollTop 256 is 40px past the gap's end, i.e. row 10 + 2 = row 12 -
    // NOT row 12 by 256/20 = 12.8 rounding down, which would be the same
    // number here only by coincidence at this particular scrollTop.
    const r = visibleRange({
      scrollTop: 256, viewportHeight: 20, rowHeight: 20, count: 50, overscan: 0, gapIndex: 10,
    });
    expect(r.start).toBe(12);
  });

  test("a scrollTop landing INSIDE the gap still mounts the row above it and the row below it, at overscan 0", () => {
    const r = visibleRange({
      scrollTop: 205, // inside [200, 216)
      viewportHeight: 20, rowHeight: 20, count: 50, overscan: 0, gapIndex: 10,
    });
    // Row 9 sits directly above the gap; row 10 sits directly below it. A
    // scroll position with no row of its own to round to must not strand
    // either of the two rows it sits between.
    expect(r.start).toBeLessThanOrEqual(9);
    expect(r.end).toBeGreaterThan(10);
  });

  test("a null gapIndex behaves exactly like no gap at all", () => {
    const withGap = visibleRange({
      scrollTop: 300, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2, gapIndex: null,
    });
    const withoutGap = visibleRange({
      scrollTop: 300, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2,
    });
    expect(withGap).toEqual(withoutGap);
  });
});

describe("createVirtualList with a gap", () => {
  test("the spacer grows by exactly SECTION_GAP when a gap index is given", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container, count: 10, rowHeight: 20, overscan: 2, gapIndex: 5, renderRow: () => {},
    });
    expect(container.querySelector("div")?.style.height).toBe(`${10 * 20 + SECTION_GAP}px`);
    list.destroy();
    container.remove();
  });

  test("no gap index means no extra height", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container, count: 10, rowHeight: 20, overscan: 2, renderRow: () => {},
    });
    expect(container.querySelector("div")?.style.height).toBe("200px");
    list.destroy();
    container.remove();
  });

  test("rows at or after the gap sit SECTION_GAP lower than index * rowHeight; rows before it do not move", () => {
    const container = makeContainer(200);
    const tops: Record<number, string> = {};
    const list = createVirtualList({
      container,
      count: 10,
      rowHeight: 20,
      overscan: 20,
      gapIndex: 5,
      renderRow: (i, el) => {
        tops[i] = el.style.top;
      },
    });
    expect(tops[4]).toBe("80px");
    expect(tops[5]).toBe(`${5 * 20 + SECTION_GAP}px`);
    expect(tops[9]).toBe(`${9 * 20 + SECTION_GAP}px`);
    list.destroy();
    container.remove();
  });

  test("setGapIndex repositions every mounted row and the spacer in one call", () => {
    const container = makeContainer(200);
    const elements: Record<number, HTMLElement> = {};
    const list = createVirtualList({
      container,
      count: 10,
      rowHeight: 20,
      overscan: 20,
      renderRow: (i, el) => {
        elements[i] = el;
      },
    });
    expect(elements[5]?.style.top).toBe("100px");

    // setGapIndex must reposition the SAME elements in place, not repaint
    // them - renderRow is never called again here, only style.top moves.
    list.setGapIndex(3);
    expect(elements[2]?.style.top).toBe("40px");
    expect(elements[3]?.style.top).toBe(`${3 * 20 + SECTION_GAP}px`);
    expect(elements[9]?.style.top).toBe(`${9 * 20 + SECTION_GAP}px`);
    expect(container.querySelector("div")?.style.height).toBe(`${10 * 20 + SECTION_GAP}px`);

    list.setGapIndex(null);
    expect(elements[3]?.style.top).toBe("60px");
    expect(container.querySelector("div")?.style.height).toBe("200px");

    list.destroy();
    container.remove();
  });

  test("a walk with no reserved root (gapIndex omitted) never inserts a gap at all", () => {
    const container = makeContainer(200);
    const tops: Record<number, string> = {};
    const list = createVirtualList({
      container,
      count: 5,
      rowHeight: 20,
      overscan: 20,
      renderRow: (i, el) => {
        tops[i] = el.style.top;
      },
    });
    for (let i = 0; i < 5; i++) expect(tops[i]).toBe(`${i * 20}px`);
    list.destroy();
    container.remove();
  });

  test("scrollToIndex on a row just after the gap still lands it fully within the viewport", () => {
    const container = makeContainer(40); // two rows tall
    const list = createVirtualList({
      container, count: 20, rowHeight: 20, overscan: 0, gapIndex: 5, renderRow: () => {},
    });
    list.scrollToIndex(5);
    const top = 5 * 20 + SECTION_GAP;
    expect(container.scrollTop).toBeLessThanOrEqual(top);
    expect(container.scrollTop + container.clientHeight).toBeGreaterThanOrEqual(top + 20);
    list.destroy();
    container.remove();
  });

  // gapIndex: 0 -- the reserved root is the very FIRST row of the walk (no
  // manuscript at all). Every row, including row 0, must sit SECTION_GAP lower
  // than a bare index * rowHeight, or the separator would draw above a row
  // that starts at scroll-content pixel 0 and has nothing to sit inside.
  test("gapIndex 0 pushes every row down by SECTION_GAP, including row 0", () => {
    const container = makeContainer(200);
    const tops: Record<number, string> = {};
    const list = createVirtualList({
      container,
      count: 5,
      rowHeight: 20,
      overscan: 20,
      gapIndex: 0,
      renderRow: (i, el) => {
        tops[i] = el.style.top;
      },
    });
    expect(tops[0]).toBe(`${SECTION_GAP}px`);
    expect(tops[4]).toBe(`${4 * 20 + SECTION_GAP}px`);
    expect(container.querySelector("div")?.style.height).toBe(`${5 * 20 + SECTION_GAP}px`);
    list.destroy();
    container.remove();
  });

  // gapIndex >= count -- the reserved root the gap would sit above no longer
  // exists in the set (e.g. it was the last row and the walk shrank under it).
  // totalHeight()'s own edge: nothing sits after the gap to push down, so the
  // spacer must not grow at all.
  test("a gapIndex at count adds no extra height, the totalHeight edge", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container, count: 10, rowHeight: 20, overscan: 2, gapIndex: 10, renderRow: () => {},
    });
    expect(container.querySelector("div")?.style.height).toBe("200px");
    list.destroy();
    container.remove();
  });

  test("a gapIndex past count also adds no extra height", () => {
    const container = makeContainer();
    const list = createVirtualList({
      container, count: 10, rowHeight: 20, overscan: 2, gapIndex: 50, renderRow: () => {},
    });
    expect(container.querySelector("div")?.style.height).toBe("200px");
    list.destroy();
    container.remove();
  });

  test("scrollToIndex onto the row AT the gap lands it fully within the viewport", () => {
    const container = makeContainer(40); // two rows tall
    const list = createVirtualList({
      container, count: 20, rowHeight: 20, overscan: 0, gapIndex: 5, renderRow: () => {},
    });
    list.scrollToIndex(5);
    const top = 5 * 20 + SECTION_GAP;
    expect(container.scrollTop).toBeLessThanOrEqual(top);
    expect(container.scrollTop + container.clientHeight).toBeGreaterThanOrEqual(top + 20);
    list.destroy();
    container.remove();
  });

  test("scrollToIndex onto the row just AFTER the gap lands it fully within the viewport", () => {
    const container = makeContainer(40); // two rows tall
    const list = createVirtualList({
      container, count: 20, rowHeight: 20, overscan: 0, gapIndex: 5, renderRow: () => {},
    });
    list.scrollToIndex(6);
    const top = 6 * 20 + SECTION_GAP;
    expect(container.scrollTop).toBeLessThanOrEqual(top);
    expect(container.scrollTop + container.clientHeight).toBeGreaterThanOrEqual(top + 20);
    list.destroy();
    container.remove();
  });
});
