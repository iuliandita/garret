// lab/fault-rig/test/corrupt.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tornWrite, byteFlip } from "../src/corrupt";
import { makeDirBackend } from "../src/backend-dir";
import { makeSqliteBackend } from "../src/backend-sqlite";
import type { EditOp } from "../src/model";

const noop = () => {};
async function seedProject(make: any, dir: string) {
  const b = make(dir);
  await b.open();
  const ops: EditOp[] = [
    { seq: 0, kind: "type", sceneId: "s1", text: "alpha" },
    { seq: 1, kind: "type", sceneId: "s2", text: "beta" },
    { seq: 2, kind: "import-asset", assetName: "a.bin", assetHash: "hh" },
  ];
  for (const op of ops) await b.apply(op, noop);
  await b.close();
}

describe("corruption injectors", () => {
  test("torn-write on dir-manifest is detected as CORRUPT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cor-"));
    await seedProject(makeDirBackend, dir);
    tornWrite(join(dir, "manifest.json"), 0.5); // truncate to half
    // integrityCheck is a cold-read: it must detect corruption without open().
    const chk = await makeDirBackend(dir).integrityCheck();
    expect(chk.ok).toBe(false);
  });

  test("byte-flip on sqlite is detected by integrity_check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cor2-"));
    await seedProject(makeSqliteBackend, dir);
    byteFlip(join(dir, "project.db"), 8, 200); // flip bytes in the db pages
    const chk = await makeSqliteBackend(dir).integrityCheck();
    expect(chk.ok).toBe(false);
  });
});
