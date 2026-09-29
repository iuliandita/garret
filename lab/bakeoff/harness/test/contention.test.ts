import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentionScripts, startContention } from "../src/contention";

test("contention script files exist", () => {
  const s = contentionScripts();
  expect(existsSync(s.autosave)).toBe(true);
  expect(existsSync(s.index)).toBe(true);
});

test("startContention writes an autosave file within the cadence, stop is clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-cont-"));
  const c = startContention(dir);
  try {
    await Bun.sleep(1500); // past one autosave cadence
    expect(existsSync(join(dir, "autosave.sqlite"))).toBe(true);
  } finally {
    c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
