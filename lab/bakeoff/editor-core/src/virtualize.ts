// lab/bakeoff/editor-core/src/virtualize.ts
// Pure mount-window calculation for virtualized scene stitching: given scroll
// offset, viewport height, and per-scene heights, return the contiguous range
// of scene indices to keep mounted (plus overscan). This is the design bet under
// test, isolated from the DOM so it is deterministically unit-tested.

export interface MountWindow {
  start: number; // first mounted scene index (inclusive), 0 when empty
  end: number; // last mounted scene index (inclusive), -1 when empty
  mounted: number[]; // [start..end]
}

export function visibleWindow(
  scrollTop: number,
  viewportH: number,
  heights: number[],
  overscan: number,
): MountWindow {
  if (heights.length === 0) return { start: 0, end: -1, mounted: [] };

  const viewTop = Math.max(0, scrollTop);
  const viewBottom = viewTop + viewportH;

  let top = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < heights.length; i++) {
    const bottom = top + heights[i]!;
    // Scene intersects the viewport if it overlaps [viewTop, viewBottom).
    if (bottom > viewTop && top < viewBottom) {
      if (first === -1) first = i;
      last = i;
    }
    top = bottom;
  }

  // If the viewport is entirely below all content, pin to the last scene.
  if (first === -1) {
    first = heights.length - 1;
    last = heights.length - 1;
  }

  const start = Math.max(0, first - overscan);
  const end = Math.min(heights.length - 1, last + overscan);
  const mounted: number[] = [];
  for (let i = start; i <= end; i++) mounted.push(i);
  return { start, end, mounted };
}
