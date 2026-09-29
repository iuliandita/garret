// lab/fixtures/gen/test/generate.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture } from "../src/generate";
import { countWords } from "../src/words";
import type { FixtureSpec } from "../src/model";

const TINY: FixtureSpec = {
  name: "tiny",
  seed: "tiny-v1",
  totalWords: 2_000,
  structuralItems: 40,
  records: 20,
  assetBytes: 1024 * 128,
  assetCount: 3,
};

describe("generateFixture", () => {
  test("emits complete fixture with exact word count and valid manifest", async () => {
    const out = mkdtempSync(join(tmpdir(), "fixture-"));
    const manifest = await generateFixture(TINY, out);

    const dir = join(out, "tiny");
    expect(existsSync(join(dir, "project.json"))).toBe(true);
    expect(existsSync(join(dir, "scenes.ndjson"))).toBe(true);
    expect(existsSync(join(dir, "records.ndjson"))).toBe(true);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);

    let words = 0;
    const lines = readFileSync(join(dir, "scenes.ndjson"), "utf8")
      .trim().split("\n");
    for (const line of lines) {
      const scene = JSON.parse(line);
      for (const block of scene.blocks) {
        words += countWords(block.text, block.script);
      }
    }
    expect(words).toBe(TINY.totalWords);
    expect(manifest.totalWords).toBe(TINY.totalWords);
    expect(manifest.itemCount).toBe(TINY.structuralItems);
    expect(manifest.recordCount).toBe(TINY.records);
    expect(manifest.seed).toBe(TINY.seed);
  });

  test("two runs produce byte-identical text outputs", async () => {
    const a = mkdtempSync(join(tmpdir(), "fa-"));
    const b = mkdtempSync(join(tmpdir(), "fb-"));
    await generateFixture(TINY, a);
    await generateFixture(TINY, b);
    for (const f of ["project.json", "scenes.ndjson", "records.ndjson"]) {
      expect(readFileSync(join(a, "tiny", f), "utf8"))
        .toBe(readFileSync(join(b, "tiny", f), "utf8"));
    }
  });
});
