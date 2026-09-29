// lab/bakeoff/harness/test/variants.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVariants, variantSuffix } from "../src/matrix";
import { materializeFixture } from "../../editor-core/src/loader";

describe("parseVariants", () => {
  test("treats no flag as the baseline", () => {
    expect(parseVariants(undefined)).toEqual([]);
    expect(parseVariants("")).toEqual([]);
  });

  // A typo must not silently produce a baseline run recorded under a variant
  // name — that would be a measurement of the wrong thing, filed as the right
  // thing, which is worse than a crash.
  test("rejects an unknown variant instead of ignoring it", () => {
    expect(() => parseVariants("lazy-doc")).toThrow(/unknown variant/);
    expect(() => parseVariants("lazy-docs,nope")).toThrow(/unknown variant/);
  });

  test("normalizes order and duplicates so the run id is stable", () => {
    expect(parseVariants("contain-nav,lazy-docs")).toEqual(["contain-nav", "lazy-docs"]);
    expect(parseVariants("lazy-docs,contain-nav")).toEqual(["contain-nav", "lazy-docs"]);
    expect(parseVariants("lazy-docs,lazy-docs")).toEqual(["lazy-docs"]);
  });
});

describe("variantSuffix", () => {
  test("leaves the baseline run id unsuffixed", () => {
    expect(variantSuffix([])).toBe("");
  });

  test("names every active variant in the run id", () => {
    expect(variantSuffix(["lazy-docs"])).toBe("-lazy-docs");
    expect(variantSuffix(["contain-nav", "lazy-docs"])).toBe("-contain-nav+lazy-docs");
  });
});

describe("materializeFixture lazy mode", () => {
  const fixtureDir = join(import.meta.dir, "../../../fixtures/out/tiny");

  test("eager mode still ships every doc inline", () => {
    const out = join(mkdtempSync(join(tmpdir(), "mat-eager-")), "scene-data.json");
    const data = materializeFixture(fixtureDir, out, "tiny");
    expect(data.lazy).toBeUndefined();
    expect(data.docs.length).toBe(data.refs.length);
    expect(existsSync(join(out, "..", "docs"))).toBe(false);
  });

  // The whole point of the variant: the manifest the page fetches must not
  // carry the manuscript, or the live set is unchanged and the A/B is void.
  test("lazy mode ships refs only, with one file per scene", () => {
    const out = join(mkdtempSync(join(tmpdir(), "mat-lazy-")), "scene-data.json");
    const data = materializeFixture(fixtureDir, out, "tiny", 0, true);
    expect(data.lazy).toBe(true);
    expect(data.docs.length).toBe(0);
    expect(data.refs.length).toBeGreaterThan(0);

    const onDisk = JSON.parse(readFileSync(out, "utf8"));
    expect(onDisk.docs).toEqual([]);
    for (let i = 0; i < data.refs.length; i++) {
      const doc = JSON.parse(
        readFileSync(join(out, "..", "docs", `${i}.json`), "utf8"),
      );
      expect(doc.id).toBe(data.refs[i]!.id);
    }
  });

  test("lazy scene files carry the same content the eager path inlines", () => {
    const eagerOut = join(mkdtempSync(join(tmpdir(), "mat-cmp-e-")), "scene-data.json");
    const lazyOut = join(mkdtempSync(join(tmpdir(), "mat-cmp-l-")), "scene-data.json");
    const eager = materializeFixture(fixtureDir, eagerOut, "tiny");
    materializeFixture(fixtureDir, lazyOut, "tiny", 0, true);
    eager.docs.forEach((doc, i) => {
      const lazyDoc = JSON.parse(
        readFileSync(join(lazyOut, "..", "docs", `${i}.json`), "utf8"),
      );
      expect(lazyDoc).toEqual(doc);
    });
  });
});
