// lab/fixtures/gen/test/structure.test.ts
import { describe, expect, test } from "bun:test";
import { makePrng } from "../src/prng";
import { buildStructure } from "../src/structure";

describe("buildStructure", () => {
  test("emits exactly the requested item count", () => {
    const items = buildStructure(makePrng("s1"), 200, 10_000);
    expect(items.length).toBe(200);
  });

  test("scene word targets sum to totalWords", () => {
    const items = buildStructure(makePrng("s2"), 150, 12_345);
    const sum = items
      .filter((i) => i.type === "scene")
      .reduce((acc, i) => acc + (i.sceneWordTarget ?? 0), 0);
    expect(sum).toBe(12_345);
  });

  test("hierarchy is well-formed: children reference existing parents", () => {
    const items = buildStructure(makePrng("s3"), 300, 5_000);
    const ids = new Set(items.map((i) => i.id));
    for (const it of items) {
      if (it.parentId !== null) expect(ids.has(it.parentId)).toBe(true);
    }
    expect(items.filter((i) => i.parentId === null).length).toBeGreaterThan(0);
  });

  test("deterministic", () => {
    const a = buildStructure(makePrng("s4"), 100, 1_000);
    const b = buildStructure(makePrng("s4"), 100, 1_000);
    expect(a).toEqual(b);
  });

  test("includes tricky titles for cross-platform cases", () => {
    const items = buildStructure(makePrng("s5"), 500, 1_000);
    const titles = items.map((i) => i.title).join("|");
    expect(/Straße|CAFÉ|café/.test(titles)).toBe(true);
  });
});
