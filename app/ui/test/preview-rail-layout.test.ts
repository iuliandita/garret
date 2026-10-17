import { describe, expect, test } from "bun:test";
import {
  canSnapHalf,
  clampPage,
  clampWidth,
  keyWidth,
  maxWidth,
  pageCount,
  parsePref,
  readDevice,
  resolveWidth,
  serializePref,
  snapWidth,
  writeDevice,
} from "../src/preview-rail-layout";

describe("rail width bounds", () => {
  test.each([
    [100, 1400, 420],
    [420, 1400, 420],
    [555.4, 1400, 555],
    [900, 1400, 700],
    [900, 1920, 900],
    [2000, 1920, 960],
    // Never below the minimum even where half the window is smaller.
    [600, 1000, 500],
    [600, 700, 420],
    [Number.NaN, 1400, 420],
  ])("clamp %p in a %p px window is %p", (px, window, expected) => {
    expect(clampWidth(px, window)).toBe(expected);
  });

  test("the maximum is about half the window and never under the minimum", () => {
    expect(maxWidth(1920)).toBe(960);
    expect(maxWidth(1001)).toBe(500);
    expect(maxWidth(600)).toBe(420);
  });
});

describe("half-window snap", () => {
  test("is offered from 1200px up", () => {
    expect(canSnapHalf(1199)).toBe(false);
    expect(canSnapHalf(1200)).toBe(true);
  });

  test("pulls a near release onto half and leaves a far one alone", () => {
    expect(snapWidth(700 - 20, 1400)).toBe(700);
    expect(snapWidth(700 + 20, 1400)).toBe(700);
    expect(snapWidth(700 - 60, 1400)).toBe(640);
  });

  test("does not snap in a window too narrow to offer it", () => {
    expect(snapWidth(550, 1100)).toBe(550);
  });
});

describe("what is asked for versus what fits", () => {
  test("no preference keeps the historical 420", () => {
    expect(resolveWidth(null, 1920)).toBe(420);
  });

  test("a pixel request is clamped to the window as it is now", () => {
    expect(resolveWidth({ kind: "width", px: 900 }, 1920)).toBe(900);
    expect(resolveWidth({ kind: "width", px: 900 }, 1400)).toBe(700);
  });

  test("half follows the window, never below the minimum", () => {
    expect(resolveWidth({ kind: "half" }, 1400)).toBe(700);
    expect(resolveWidth({ kind: "half" }, 1920)).toBe(960);
    expect(resolveWidth({ kind: "half" }, 1000)).toBe(500);
    expect(resolveWidth({ kind: "half" }, 700)).toBe(420);
  });
});

describe("keys", () => {
  test.each([
    ["ArrowLeft", 500, false, 524],
    ["ArrowLeft", 500, true, 596],
    ["ArrowRight", 500, false, 476],
    ["ArrowRight", 430, false, 420],
    ["ArrowLeft", 690, false, 700],
    ["Home", 600, false, 420],
    ["End", 500, false, 700],
  ])("%s from %p (large=%p) gives %p in a 1400 window", (key, from, large, expected) => {
    expect(keyWidth(key, from, large, 1400)).toBe(expected);
  });

  test("another key is not the divider's", () => {
    expect(keyWidth("a", 500, false, 1400)).toBeNull();
  });
});

describe("the stored preference", () => {
  test("round-trips", () => {
    expect(parsePref(serializePref({ kind: "half" }))).toEqual({ kind: "half" });
    expect(parsePref(serializePref({ kind: "width", px: 612 }))).toEqual({ kind: "width", px: 612 });
  });

  test.each([null, "", "wide", "-5", "419", "1e3", "12.5", "9999999"])("%p is no preference", (raw) => {
    expect(parsePref(raw)).toBeNull();
  });

  test("a storage that throws neither reads nor writes loudly", () => {
    const broken = {
      getItem: (): string | null => { throw new Error("blocked"); },
      setItem: (): void => { throw new Error("full"); },
    };
    expect(readDevice(broken, "k")).toBeNull();
    expect(() => writeDevice(broken, "k", "v")).not.toThrow();
    expect(readDevice(null, "k")).toBeNull();
  });
});

describe("paging arithmetic", () => {
  test.each([
    [500, 500, 1],
    [501, 500, 1],
    [1000, 500, 2],
    [1001, 500, 2],
    [1002, 500, 3],
    [0, 500, 1],
    [900, 0, 1],
  ])("%p wide in %p px pages is %p page(s)", (scroll, page, expected) => {
    expect(pageCount(scroll, page)).toBe(expected);
  });

  test("a page index stays inside the book", () => {
    expect(clampPage(-3, 5)).toBe(0);
    expect(clampPage(9, 5)).toBe(4);
    expect(clampPage(2.9, 5)).toBe(2);
    expect(clampPage(Number.NaN, 5)).toBe(0);
  });
});
