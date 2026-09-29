// lab/fault-rig/test/backend-dir.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDirBackend } from "../src/backend-dir";
import type { EditOp } from "../src/model";

const noop = () => {};

async function drive(dir: string, ops: EditOp[]) {
  const b = makeDirBackend(dir);
  await b.open();
  for (const op of ops) await b.apply(op, noop);
  await b.close();
}

describe("dir-manifest backend", () => {
  test("persists state across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dirb-"));
    await drive(dir, [
      { seq: 0, kind: "type", sceneId: "s1", text: "abc" },
      { seq: 1, kind: "import-asset", assetName: "a.bin", assetHash: "h1" },
      { seq: 2, kind: "migrate" },
    ]);
    const b = makeDirBackend(dir);
    await b.open();
    const state = await b.read();
    await b.close();
    expect(state.scenes.s1).toBe("abc");
    expect(state.assets["a.bin"]).toBe("h1");
    expect(state.version).toBe(1);
  });

  test("integrityCheck passes on a clean project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dirb2-"));
    await drive(dir, [{ seq: 0, kind: "type", sceneId: "s1", text: "x" }]);
    const b = makeDirBackend(dir);
    await b.open();
    const chk = await b.integrityCheck();
    await b.close();
    expect(chk.ok).toBe(true);
  });

  test("emits ordered phase markers within one commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dirb3-"));
    const b = makeDirBackend(dir);
    await b.open();
    const seen: string[] = [];
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "z" }, (m) => seen.push(m));
    await b.close();
    expect(seen).toEqual(["begin-txn", "fsync", "rename", "commit-done"]);
  });
});
