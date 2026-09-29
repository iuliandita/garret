// lab/fixtures/gen/test/records.test.ts
import { describe, expect, test } from "bun:test";
import { makePrng } from "../src/prng";
import { buildStructure } from "../src/structure";
import { buildRecords } from "../src/records";

describe("buildRecords", () => {
  test("emits requested count, deterministic, links resolve", () => {
    const items = buildStructure(makePrng("r-items"), 100, 5_000);
    const a = buildRecords(makePrng("r1"), 50, items);
    const b = buildRecords(makePrng("r1"), 50, items);
    expect(a).toEqual(b);
    expect(a.length).toBe(50);
    const itemIds = new Set(items.map((i) => i.id));
    for (const rec of a) {
      expect(rec.id).toMatch(/^kr-\d{6}$/);
      for (const link of rec.linkedItemIds) expect(itemIds.has(link)).toBe(true);
    }
  });

  test("covers all record kinds", () => {
    const items = buildStructure(makePrng("r-items2"), 100, 5_000);
    const recs = buildRecords(makePrng("r2"), 200, items);
    const kinds = new Set(recs.map((r) => r.kind));
    expect(kinds).toEqual(
      new Set(["person", "place", "object", "custom", "research"]),
    );
  });
});
