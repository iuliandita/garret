// lab/fault-rig/test/mutator.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMutator } from "../src/mutator";

describe("external mutator", () => {
  test("creates interference files then stops cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-"));
    writeFileSync(join(dir, "manifest.json"), "{}");
    const handle = startMutator(dir, 2); // every 2ms
    await new Promise((r) => setTimeout(r, 30));
    await handle.stop();
    const strays = readdirSync(dir).filter((f) => f.startsWith(".sync-"));
    expect(strays.length).toBeGreaterThan(0);
  });
});
