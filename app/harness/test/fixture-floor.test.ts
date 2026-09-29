import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFixtureFloor, fixtureItemFloor } from "../src/fixture-floor";

function fakeManifest(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "fx-manifest-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(body));
  return dir;
}

describe("assertFixtureFloor", () => {
  test("refuses a run that saw fewer rows than the fixture holds", () => {
    expect(() => assertFixtureFloor("stress", 1, 20_000)).toThrow(/stress/);
  });

  test("names both numbers, so the message says how far short the run fell", () => {
    expect(() => assertFixtureFloor("stress", 1, 20_000)).toThrow(/\b1\b[\s\S]*20000|20000[\s\S]*\b1\b/);
  });

  test("passes at exactly the floor", () => {
    expect(() => assertFixtureFloor("tiny", 40, 40)).not.toThrow();
  });

  test("passes above the floor", () => {
    expect(() => assertFixtureFloor("tiny", 41, 40)).not.toThrow();
  });

  test("refuses a floor no run could fall below", () => {
    expect(() => assertFixtureFloor("tiny", 40, 0)).toThrow(/floor/i);
  });

  test("refuses a missing runtime row count", () => {
    expect(() => Reflect.apply(assertFixtureFloor, null, ["tiny", undefined, 40]))
      .toThrow(/reported rows/i);
  });

  test.each([NaN, Infinity, 40.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an unusable advertised row count (%p)",
    (advertised) => {
      expect(() => assertFixtureFloor("tiny", advertised, 40)).toThrow(/reported rows/i);
    },
  );

  test.each([NaN, Infinity, 40.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an unusable floor (%p)",
    (floor) => {
      expect(() => assertFixtureFloor("tiny", 40, floor)).toThrow(/floor/i);
    },
  );
});

describe("fixtureItemFloor", () => {
  test("reads the count out of the fixture's own manifest", () => {
    expect(fixtureItemFloor(fakeManifest({ name: "stress", itemCount: 20_000 }))).toBe(20_000);
  });

  test("a manifest carrying no count is an error, not a floor of zero", () => {
    expect(() => fixtureItemFloor(fakeManifest({ name: "stress" }))).toThrow(/itemCount/);
  });

  test("a missing manifest is an error, not a floor of zero", () => {
    expect(() => fixtureItemFloor(mkdtempSync(join(tmpdir(), "fx-empty-")))).toThrow(/manifest/i);
  });

  test.each([0, -1, NaN, Infinity, 20_000.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an unusable manifest item count (%p)",
    (itemCount) => {
      expect(() => fixtureItemFloor(fakeManifest({ name: "stress", itemCount }))).toThrow(/itemCount/);
    },
  );
});
