// app/ui/src/bubble-placement.ts
// THE BUBBLE'S GEOMETRY, with no DOM in it. format-bubble.ts reads three
// rects (the selection from editor.selectionRect(), its own box, #editor's
// box) and writes left/top from this answer; happy-dom has no layout, so
// this is the only place the placement can be tested at all.

export const BUBBLE_GAP = 8;

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }
export interface Placed { left: number; top: number; below: boolean }

/** How far inside the window the bubble always stays (243). */
export const WINDOW_MARGIN = 8;

/** 8px above the selection, centred; below it when above would leave the
 *  pane; shifted so it stays inside the pane horizontally. All viewport
 *  coordinates, for a position: fixed element.
 *
 *  THEN KEPT 8px INSIDE THE WINDOW on both axes, last, so it wins (243): the
 *  pane is not always inside the window. #editor is recentred by a transform
 *  in focus mode and runs under an overlaying inspector, and a bubble clamped
 *  only to the pane was cut off by the window's right edge. A window smaller
 *  than the bubble pins it to the top-left margin. */
export function placeBubble(input: { selection: Rect; bubble: Size; pane: Rect; viewport: Size }): Placed {
  const { selection, bubble, pane, viewport } = input;
  const centre = (selection.left + selection.right) / 2;
  const maxLeft = Math.max(pane.left, pane.right - bubble.width);
  const inPane = Math.min(maxLeft, Math.max(pane.left, centre - bubble.width / 2));
  const above = selection.top - BUBBLE_GAP - bubble.height;
  const below = above < pane.top;
  // Clamped against the pane's foot too: a selection on the pane's own last
  // line flips below and would otherwise land past pane.bottom, over
  // whatever sits under the pane (the footer, on the editor's own pane).
  const inPaneTop = below ? Math.min(selection.bottom + BUBBLE_GAP, pane.bottom - bubble.height) : above;
  const left = clamp(inPane, WINDOW_MARGIN, viewport.width - WINDOW_MARGIN - bubble.width);
  const top = clamp(inPaneTop, WINDOW_MARGIN, viewport.height - WINDOW_MARGIN - bubble.height);
  return { left, top, below };
}

/** `value` inside [min, max]; `min` when the range is empty. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** The format bubble's predicate: a range, and the editor has focus. */
export function bubbleWanted(state: { from: number; to: number; focused: boolean }): boolean {
  return state.focused && state.to > state.from;
}
