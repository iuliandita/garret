import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { loadSceneRefs, loadSceneDocs, materializeFixture } from "../src/loader";

let root: string;
let fixtureDir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bakeoff-loader-"));
  // Generate the tiny fixture into a temp outRoot (deterministic, fast).
  await $`bun ${join(import.meta.dir, "../../../fixtures/gen/src/cli.ts")} tiny ${root}`.quiet();
  fixtureDir = join(root, "tiny");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("loadSceneRefs returns scene items sorted by order", () => {
  const refs = loadSceneRefs(fixtureDir);
  expect(refs.length).toBeGreaterThan(0);
  for (let i = 1; i < refs.length; i++) {
    expect(refs[i]!.order).toBeGreaterThanOrEqual(refs[i - 1]!.order);
  }
  expect(refs[0]).toHaveProperty("id");
  expect(refs[0]).toHaveProperty("title");
});

test("loadSceneDocs returns one doc per scene ref with blocks", () => {
  const refs = loadSceneRefs(fixtureDir);
  const docs = loadSceneDocs(fixtureDir);
  expect(docs.size).toBe(refs.length);
  for (const ref of refs) {
    const doc = docs.get(ref.id);
    expect(doc).toBeDefined();
    expect(Array.isArray(doc!.blocks)).toBe(true);
  }
});

test("materializeFixture writes refs+docs json, limit caps scene count", () => {
  const out = join(root, "scene-data.json");
  const data = materializeFixture(fixtureDir, out, "tiny", 5);
  expect(data.refs.length).toBeLessThanOrEqual(5);
  expect(data.docs.length).toBe(data.refs.length);
  const reread = JSON.parse(readFileSync(out, "utf8"));
  expect(reread.fixture).toBe("tiny");
  expect(reread.refs.length).toBe(data.refs.length);
});
