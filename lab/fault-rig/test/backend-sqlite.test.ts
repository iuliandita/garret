// lab/fault-rig/test/backend-sqlite.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSqliteBackend } from "../src/backend-sqlite";
import type { EditOp } from "../src/model";

const noop = () => {};

describe("sqlite backend", () => {
  test("persists state across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlb-"));
    const b1 = makeSqliteBackend(dir);
    await b1.open();
    const ops: EditOp[] = [
      { seq: 0, kind: "type", sceneId: "s1", text: "hi" },
      { seq: 1, kind: "type", sceneId: "s1", text: " there" },
      { seq: 2, kind: "import-asset", assetName: "a.bin", assetHash: "h9" },
      { seq: 3, kind: "migrate" },
    ];
    for (const op of ops) await b1.apply(op, noop);
    await b1.close();

    const b2 = makeSqliteBackend(dir);
    await b2.open();
    const state = await b2.read();
    const chk = await b2.integrityCheck();
    await b2.close();
    expect(state.scenes.s1).toBe("hi there");
    expect(state.assets["a.bin"]).toBe("h9");
    expect(state.version).toBe(1);
    expect(chk.ok).toBe(true);
  });

  // The point of the SQLite candidate is that a commit costs the change, not the
  // manuscript. A rewrite-everything baseline would measure the harness instead
  // of the encoding, so row writes per commit must not grow with project size.
  test("writes only the touched rows, independent of project size", async () => {
    const rowsWrittenForProjectOf = async (sceneCount: number) => {
      const dir = mkdtempSync(join(tmpdir(), "sqlinc-"));
      const b = makeSqliteBackend(dir);
      await b.open();
      for (let i = 0; i < sceneCount; i++) {
        await b.apply({ seq: i, kind: "type", sceneId: `s${i}`, text: "seed" }, noop);
      }
      const before = b.totalChanges();
      await b.apply(
        { seq: sceneCount, kind: "type", sceneId: "s0", text: " more" }, noop,
      );
      const after = b.totalChanges();
      await b.close();
      return after - before;
    };

    const small = await rowsWrittenForProjectOf(5);
    const large = await rowsWrittenForProjectOf(60);
    expect(large).toBe(small);
    expect(small).toBeLessThan(5);
  });

  test("uses WAL journal mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlb2-"));
    const b = makeSqliteBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "x" }, noop);
    expect(b.journalMode()).toBe("wal");
    await b.close();
  });
});
