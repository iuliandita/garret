import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../shell-tauri/src-tauri/src/pdf/dpi.js", import.meta.url), "utf8");
const dpi = new Function(`${source}; return proofFigureDpi;`)() as (
  width: number, height: number, orientation: number, placedWidth: number, placedHeight: number,
) => { dpi: number; warning: boolean; flag: boolean };

test("print resolution uses oriented pixels at the actual placed size and strict thresholds", () => {
  for (const [width, height, orientation, inchesW, inchesH, expected, warning, flag] of [
    [1200, 1800, 1, 4, 6, 300, false, false],
    [1200, 1800, 1, 6, 9, 200, true, false],
    [1200, 1800, 1, 8, 12, 150, true, true],
    [1196, 1794, 1, 4, 6, 299, true, false],
    [1194, 1791, 1, 6, 9, 199, true, true],
    [1200, 1800, 2, 4, 6, 300, false, false],
    [1200, 1800, 3, 4, 6, 300, false, false],
    [1200, 1800, 4, 4, 6, 300, false, false],
    [1800, 1200, 5, 4, 6, 300, false, false],
    [1800, 1200, 6, 6, 9, 200, true, false],
    [1800, 1200, 7, 8, 12, 150, true, true],
    [1800, 1200, 8, 4, 6, 300, false, false],
    [1200, 1800, 1, 4, 9, 200, true, false],
  ] as const) {
    expect(dpi(width, height, orientation, inchesW, inchesH)).toEqual({ dpi: expected, warning, flag });
  }
});

test("unusable pixel, orientation, and placement geometry refuses instead of reporting DPI", () => {
  for (const args of [
    [0, 1800, 1, 4, 6], [1200, 0, 1, 4, 6], [1200, 1800, 0, 4, 6],
    [1200, 1800, 9, 4, 6], [1200, 1800, 1.5, 4, 6],
    [1200, 1800, 1, 0, 6], [1200, 1800, 1, 4, -1],
    [Infinity, 1800, 1, 4, 6], [1200, 1800, 1, NaN, 6],
  ]) expect(() => dpi(...args as [number, number, number, number, number])).toThrow("invalid figure print geometry");
});
