import { describe, expect, test } from "bun:test";
import { bubbleWanted, placeBubble, BUBBLE_GAP, WINDOW_MARGIN } from "../src/bubble-placement";

const pane = { left: 320, top: 39, right: 1200, bottom: 766 };
const bubble = { width: 200, height: 32 };
const viewport = { width: 1200, height: 800 };
// Room around the pane, so the pane's own clamp is what a test sees.
const roomy = { width: 1600, height: 1000 };

describe("placeBubble", () => {
  test("sits BUBBLE_GAP above the selection, centred on it", () => {
    const at = placeBubble({ selection: { left: 600, top: 300, right: 700, bottom: 320 }, bubble, pane, viewport });
    expect(at).toEqual({ left: 550, top: 300 - BUBBLE_GAP - 32, below: false });
  });
  test("flips below when above would leave the pane", () => {
    const at = placeBubble({ selection: { left: 600, top: 50, right: 700, bottom: 70 }, bubble, pane, viewport });
    expect(at).toEqual({ left: 550, top: 70 + BUBBLE_GAP, below: true });
  });
  test("shifts to stay inside the pane horizontally, both edges", () => {
    expect(placeBubble({ selection: { left: 330, top: 300, right: 340, bottom: 320 }, bubble, pane, viewport: roomy }).left).toBe(320);
    expect(placeBubble({ selection: { left: 1180, top: 300, right: 1195, bottom: 320 }, bubble, pane, viewport: roomy }).left).toBe(1000);
    // A pane flush with the window's edge gives way to the window margin.
    expect(placeBubble({ selection: { left: 1180, top: 300, right: 1195, bottom: 320 }, bubble, pane, viewport }).left).toBe(992);
  });
  test("a bubble wider than the pane pins to the pane's left", () => {
    expect(placeBubble({ selection: { left: 600, top: 300, right: 700, bottom: 320 }, bubble: { width: 2000, height: 32 }, pane, viewport: { width: 4000, height: 1000 } }).left).toBe(320);
  });
  test("flipping below still clamps to the pane's foot", () => {
    // A selection on the pane's own last line flips below (there is no room
    // above it either) and, unclamped, would land past pane.bottom -- over
    // whatever sits under the pane, the footer on the editor's own pane.
    const shortPane = { left: 320, top: 39, right: 1200, bottom: 100 };
    const at = placeBubble({
      selection: { left: 600, top: 45, right: 700, bottom: 60 },
      bubble,
      pane: shortPane,
      viewport,
    });
    expect(at.top).toBe(68);
    expect(at.below).toBe(true);
  });
});

describe("the window clamp", () => {
  test("keeps WINDOW_MARGIN inside the window's right edge when the pane runs past it", () => {
    // An overlaying inspector or focus mode's transform can leave #editor's
    // box wider than what the window shows.
    const wide = { left: 320, top: 39, right: 1400, bottom: 766 };
    const at = placeBubble({ selection: { left: 1150, top: 300, right: 1190, bottom: 320 }, bubble, pane: wide, viewport });
    expect(at.left).toBe(1200 - WINDOW_MARGIN - 200);
  });
  test("and inside its left, top and bottom edges", () => {
    const loose = { left: -100, top: -100, right: 1400, bottom: 1000 };
    expect(placeBubble({ selection: { left: 0, top: 300, right: 10, bottom: 320 }, bubble, pane: loose, viewport }).left).toBe(WINDOW_MARGIN);
    expect(placeBubble({ selection: { left: 600, top: 20, right: 700, bottom: 30 }, bubble, pane: loose, viewport }).top).toBe(WINDOW_MARGIN);
    const low = placeBubble({ selection: { left: 600, top: 5, right: 700, bottom: 790 }, bubble, pane: { ...loose, top: 0 }, viewport });
    expect(low.below).toBe(true);
    expect(low.top).toBe(800 - WINDOW_MARGIN - 32);
  });
  test("a window narrower than the bubble pins it to the left margin", () => {
    const at = placeBubble({ selection: { left: 100, top: 300, right: 120, bottom: 320 }, bubble, pane, viewport: { width: 150, height: 800 } });
    expect(at.left).toBe(WINDOW_MARGIN);
  });
});

describe("bubbleWanted", () => {
  test("only a non-collapsed selection with the editor focused", () => {
    expect(bubbleWanted({ from: 1, to: 4, focused: true })).toBe(true);
    expect(bubbleWanted({ from: 4, to: 4, focused: true })).toBe(false);
    expect(bubbleWanted({ from: 1, to: 4, focused: false })).toBe(false);
  });
});
