// app/ui/src/navigator/virtual-list.ts
// Windowed rendering: mount only the visible slice plus overscan. Row height is
// fixed in this slice on purpose — variable height needs a measurement cache
// whose behaviour would confound the first latency result.
//
// visibleRange is pure and separately tested because window math is where an
// off-by-one silently skips a row, and a skipped row is an accessibility defect
// that a latency gate would never notice.

/** The one gap the list ever inserts: above the first reserved root's row
 *  (the separator, fixed after the initial ship drew the line
 *  by clipping into the row's own 24px box instead). Fixed rather than a
 *  parameter, because there is exactly one thing in this list that is not a
 *  row and needs room -- "where the book stops" -- and a second one would need
 *  its own design question answered, not a wider gap API. */
export const SECTION_GAP = 16;

export interface RangeInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan: number;
  /** The item index (in the same numbering as every other index here) that
   *  SECTION_GAP sits above, or null when the walk has no reserved root.
   *  Every row from this index on is SECTION_GAP px lower than
   *  `index * rowHeight` would put it. */
  gapIndex?: number | null;
}

export interface Range {
  start: number; // inclusive
  end: number; // exclusive
}

/** Where row `index`'s box starts, in scroll-content pixels. The single
 *  source both `render()` and `scrollToIndex` use, so the gap can never be
 *  applied on one path and not the other. */
function rowTop(index: number, rowHeight: number, gapIndex: number | null): number {
  return index * rowHeight + (gapIndex !== null && index >= gapIndex ? SECTION_GAP : 0);
}

/** The scrollbar's full extent: every row plus the one gap, when the gap sits
 *  before the end of the set. A gapIndex at or past `count` has nothing after
 *  it to push down, so it adds nothing - the same edge `rowTop` already
 *  handles by never matching an index that does not exist. */
function totalHeight(count: number, rowHeight: number, gapIndex: number | null): number {
  const gap = gapIndex !== null && gapIndex < count ? SECTION_GAP : 0;
  return count * rowHeight + gap;
}

export function visibleRange(input: RangeInput): Range {
  const { viewportHeight, rowHeight, count, overscan } = input;
  const gapIndex = input.gapIndex ?? null;
  if (count <= 0) return { start: 0, end: 0 };

  const scrollTop = Math.max(0, input.scrollTop);
  const gapStart = gapIndex === null ? Number.POSITIVE_INFINITY : gapIndex * rowHeight;
  const gapEnd = gapStart + SECTION_GAP;

  // A scrollTop past the gap is offset by the whole 16px it introduces, so the
  // row-index arithmetic below the gap cannot just divide by rowHeight the way
  // it does above it. A scrollTop that lands INSIDE the gap itself belongs to
  // no row at all; the row just below it (gapIndex) is what a reader scrolled
  // to that position would see first, and `extraOverscan` below is what keeps
  // the row just ABOVE the gap mounted too, regardless of how small `overscan`
  // is - the pair the design calls out explicitly.
  let first: number;
  let extraOverscan = 0;
  if (scrollTop < gapStart) {
    first = Math.floor(scrollTop / rowHeight);
  } else if (scrollTop < gapEnd) {
    first = gapIndex as number;
    extraOverscan = 1;
  } else {
    first = (gapIndex as number) + Math.floor((scrollTop - gapEnd) / rowHeight);
  }
  const visible = Math.ceil(viewportHeight / rowHeight);

  const start = Math.min(count, Math.max(0, first - overscan - extraOverscan));
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

export interface VirtualListOptions {
  container: HTMLElement;
  count: number;
  rowHeight: number;
  overscan: number;
  /** The item index SECTION_GAP sits above at mount time, or null/omitted for
   *  a walk with no reserved root. Kept current afterwards through
   *  `setGapIndex` - the navigator recomputes it on every reproject, because a
   *  collapse elsewhere in the tree moves the first reserved root's VISIBLE
   *  index even though the walk itself has not changed. */
  gapIndex?: number | null;
  renderRow(index: number, el: HTMLElement): void;
}

export interface VirtualList {
  /** Expand and collapse change the visible row count on every toggle. The
   *  spacer's height is the scrollbar's only source of truth for the set's
   *  extent, so it has to move with it. Surviving rows are repainted, so
   *  renderRow must be safe to call twice on the same element. */
  setCount(next: number): void;
  /** Move SECTION_GAP to sit above a different index, or remove it (null).
   *  Repositions every currently mounted row and the spacer's height in the
   *  same call - a caller that forgot either would leave rows drawn either
   *  overlapping the gap or short of the scrollbar's real extent. */
  setGapIndex(next: number | null): void;
  /** Re-render one row in place. Selection state lives in the row's ARIA
   *  attributes, and a selection move changes exactly two rows - reprojecting
   *  the whole window to repaint two of them would be the expensive way to do
   *  it. A no-op for an index that is not mounted, which is the common case at
   *  stress. */
  repaint(index: number): void;
  scrollToIndex(index: number): void;
  mountedRange(): Range;
  refresh(): void;
  destroy(): void;
}

export function createVirtualList(opts: VirtualListOptions): VirtualList {
  const { container, rowHeight, overscan, renderRow } = opts;
  let count = opts.count;
  let gapIndex: number | null = opts.gapIndex ?? null;

  // A full-height spacer gives the scrollbar the real extent of the set, so the
  // scroll position means the same thing it would in a naive list.
  //
  // role=presentation is load-bearing, not decoration. An untyped div between a
  // role=tree and its role=treeitem rows breaks the ARIA ownership chain, and
  // WebKitGTK rejects BOTH roles as a result: the container and every row map to
  // ATK `section` / computed-role `generic`, and the rows lose their accessible
  // name because `generic` does not take its name from contents. Measured
  // against a live AT-SPI tree; the same markup mounted without a spacer (naive
  // mode) maps to `tree` / `tree item` with names.
  const spacer = document.createElement("div");
  spacer.setAttribute("role", "presentation");
  spacer.style.cssText = `height:${totalHeight(count, rowHeight, gapIndex)}px;position:relative;`;
  container.appendChild(spacer);

  const mounted = new Map<number, HTMLElement>();
  let range: Range = { start: 0, end: 0 };

  function render(): void {
    const next = visibleRange({
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight || rowHeight,
      rowHeight,
      count,
      overscan,
      gapIndex,
    });
    if (next.start === range.start && next.end === range.end && mounted.size > 0) return;

    for (const [index, el] of mounted) {
      if (index < next.start || index >= next.end) {
        el.remove();
        mounted.delete(index);
      }
    }
    for (let i = next.start; i < next.end; i++) {
      if (mounted.has(i)) continue;
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;top:${rowTop(i, rowHeight, gapIndex)}px;height:${rowHeight}px;left:0;right:0;`;
      renderRow(i, el);
      spacer.appendChild(el);
      mounted.set(i, el);
    }
    range = next;
  }

  const onScroll = (): void => render();
  container.addEventListener("scroll", onScroll, { passive: true });

  // THE PANE'S HEIGHT IS AN INPUT AND IT CHANGES. render() reads
  // container.clientHeight fresh every call, which reads as sufficient and is
  // not: until 2026-08-17 nothing CALLED render() when that height changed, so
  // the mounted range stayed frozen at whatever the pane measured when the list
  // was built. Enlarge the window and the navigator keeps painting the old
  // number of rows: the space below them is blank, and a row that has no
  // element cannot be clicked, focused or read by a screen reader.
  //
  // Reachable in ordinary use since the window became resizable and its size
  // remembered. Found by outline-cli, which resizes to 1200px at boot and then
  // clicked row 39 of a 42-row walk: rows 0..35 were mounted (a range computed
  // for the 800px default), the click landed on the spacer, and NOTHING
  // HAPPENED - no error, no selection, no open document.
  //
  // A ResizeObserver rather than a window `resize` listener: the pane is a grid
  // cell, so it can change height without the window doing so - a bar wrapping
  // to two lines would do it - and the observer sees the thing that actually
  // matters. Guarded because happy-dom does not have to provide one; the list
  // is then exactly as correct as it was before this, which is the right
  // fallback.
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => render()) : null;
  observer?.observe(container);

  render();

  return {
    setCount(next: number): void {
      count = Math.max(0, next);
      spacer.style.height = `${totalHeight(count, rowHeight, gapIndex)}px`;
      for (const [index, el] of mounted) {
        if (index >= count) {
          el.remove();
          mounted.delete(index);
        }
      }
      // A surviving row's index now names a different item, so its content is
      // stale even where the range is numerically unchanged. Repainting in
      // place beats an unmount/remount and keeps the element identity that
      // aria-activedescendant points at.
      for (const [index, el] of mounted) renderRow(index, el);
      // Clamp rather than jump to the top: collapsing a part near the end of
      // the manuscript must not teleport the reader to the beginning.
      const maxScroll = Math.max(
        0,
        totalHeight(count, rowHeight, gapIndex) - (container.clientHeight || rowHeight),
      );
      if (container.scrollTop > maxScroll) container.scrollTop = maxScroll;
      // Defensive, not load-bearing: the drop loop above is what empties the
      // list. This only stops render()'s early return from trusting a stale
      // range across a count change.
      range = { start: 0, end: 0 };
      render();
    },
    setGapIndex(next: number | null): void {
      if (next === gapIndex) return;
      gapIndex = next;
      spacer.style.height = `${totalHeight(count, rowHeight, gapIndex)}px`;
      // Every mounted row's own top has to move with the gap it now sits above
      // or below - a stale `top` here is exactly the separator drifting out
      // from under the row it marks the moment a writer collapses something
      // above it.
      for (const [index, el] of mounted) {
        el.style.top = `${rowTop(index, rowHeight, gapIndex)}px`;
      }
      range = { start: 0, end: 0 };
      render();
    },
    repaint(index: number): void {
      const el = mounted.get(index);
      if (el !== undefined) renderRow(index, el);
    },
    scrollToIndex(index: number): void {
      const clamped = Math.max(0, Math.min(count - 1, index));
      const top = rowTop(clamped, rowHeight, gapIndex);
      const bottom = top + rowHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;
      if (top < viewTop) container.scrollTop = top;
      else if (bottom > viewBottom) container.scrollTop = bottom - container.clientHeight;
      render(); // synchronous: callers rely on the row being mounted on return
    },
    mountedRange: () => ({ ...range }),
    refresh: render,
    destroy(): void {
      observer?.disconnect();
      container.removeEventListener("scroll", onScroll);
      for (const el of mounted.values()) el.remove();
      mounted.clear();
      spacer.remove();
    },
  };
}
