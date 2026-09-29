import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLabReferences } from "../src/freeze";

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "freeze-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("findLabReferences", () => {
  test("clean tree yields no findings", () => {
    const dir = scratch({
      "ui/src/main.ts": `import { boot } from "./boot";\nboot();\n`,
    });
    expect(findLabReferences(dir)).toEqual([]);
  });

  test("relative import out of the tree into lab is caught", () => {
    const dir = scratch({
      "ui/src/main.ts": `import { x } from "../../lab/shared/archive";\n`,
    });
    const hits = findLabReferences(dir);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("ui/src/main.ts");
  });

  test("bare specifier naming a lab package is caught", () => {
    const dir = scratch({
      "harness/src/x.ts": `import { y } from "lab/bakeoff/harness/src/gates";\n`,
    });
    expect(findLabReferences(dir).length).toBe(1);
  });

  test("dynamic import and require are caught", () => {
    const dir = scratch({
      "harness/src/a.ts": `const m = await import("../../lab/shared/archive");\n`,
      "harness/src/b.ts": `const n = require("../../lab/fixtures/gen/src/cli");\n`,
    });
    expect(findLabReferences(dir).length).toBe(2);
  });

  test("the word lab inside an identifier or string is not a false positive", () => {
    const dir = scratch({
      "ui/src/labels.ts": `export const label = "collaborate";\nconst labWidth = 3;\n`,
    });
    expect(findLabReferences(dir)).toEqual([]);
  });

  test("reading generated fixture data by path is allowed", () => {
    const dir = scratch({
      "harness/src/fx.ts": `export const CORPUS = "lab/fixtures/out/stress.json";\n`,
    });
    expect(findLabReferences(dir)).toEqual([]);
  });

  test("a backtick dynamic import into lab is caught", () => {
    const dir = scratch({
      "harness/src/c.ts": "const m = await import(`../../lab/shared/archive`);\n",
    });
    expect(findLabReferences(dir).length).toBe(1);
  });

  test("the real app tree imports nothing from lab", () => {
    const appRoot = join(import.meta.dir, "..", "..");
    expect(findLabReferences(appRoot)).toEqual([]);
  });
});
