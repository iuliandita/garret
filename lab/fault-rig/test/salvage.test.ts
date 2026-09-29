// lab/fault-rig/test/salvage.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  salvageDir, salvageSqlite, salvageProject, collectSalvageEvidence,
} from "../src/salvage";
import { tornWrite, byteFlip } from "../src/corrupt";
import { makeDirBackend } from "../src/backend-dir";
import { makeSqliteBackend } from "../src/backend-sqlite";
import type { EditOp } from "../src/model";

const noop = () => {};

describe("salvageDir", () => {
  test("extracts scenes from an intact manifest and reports zero loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sal-"));
    const b = makeDirBackend(dir);
    await b.open();
    const ops: EditOp[] = [
      { seq: 0, kind: "type", sceneId: "s1", text: "keepme" },
      { seq: 1, kind: "type", sceneId: "s2", text: "andme" },
    ];
    for (const op of ops) await b.apply(op, noop);
    await b.close();

    const report = salvageDir(dir);
    expect(report.recoveredScenes.s1).toBe("keepme");
    expect(report.recoveredScenes.s2).toBe("andme");
    expect(report.losses.length).toBe(0);
  });

  test("reports loss on a torn manifest without modifying the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sal2-"));
    const b = makeDirBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "data" }, noop);
    await b.close();

    const manifest = join(dir, "manifest.json");
    tornWrite(manifest, 0.4);
    const before = createHash("sha256").update(readFileSync(manifest)).digest("hex");

    const report = salvageDir(dir);
    expect(report.losses.length).toBeGreaterThan(0);

    const after = createHash("sha256").update(readFileSync(manifest)).digest("hex");
    expect(after).toBe(before); // source untouched
  });
});

describe("salvageSqlite", () => {
  test("extracts scenes and assets from an intact database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "salq-"));
    const b = makeSqliteBackend(dir);
    await b.open();
    const ops: EditOp[] = [
      { seq: 0, kind: "type", sceneId: "s1", text: "keepme" },
      { seq: 1, kind: "type", sceneId: "s2", text: "andme" },
      { seq: 2, kind: "import-asset", assetName: "a.bin", assetHash: "deadbeef" },
    ];
    for (const op of ops) await b.apply(op, noop);
    await b.close();

    const report = salvageSqlite(dir);
    expect(report.recoveredScenes.s1).toBe("keepme");
    expect(report.recoveredScenes.s2).toBe("andme");
    expect(report.recoveredAssets["a.bin"]).toBe("deadbeef");
    expect(report.losses.length).toBe(0);
  });

  // A header-flipped main db is unopenable in place (the supervisor classifies it
  // CORRUPT), yet the WAL still carries a copy of page 1 — so salvage recovers the
  // content in full. That gap between "detected as corrupt" and "actually lost" is
  // the point of the salvage path.
  test("recovers content from a header-corrupted database via the WAL, source untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "salq2-"));
    const b = makeSqliteBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "data" }, noop);
    await b.close();

    const dbPath = join(dir, "project.db");
    byteFlip(dbPath, 0, 100);
    const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

    const report = salvageSqlite(dir);
    expect(report.recoveredScenes.s1).toBe("data");

    const after = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    expect(after).toBe(before); // source untouched
  });

  test("reports loss when both the database and its WAL are torn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "salq4-"));
    const b = makeSqliteBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "data" }, noop);
    await b.close();

    const dbPath = join(dir, "project.db");
    tornWrite(dbPath, 0.05);
    if (existsSync(dbPath + "-wal")) tornWrite(dbPath + "-wal", 0.05);
    const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

    const report = salvageSqlite(dir);
    expect(report.losses.length).toBeGreaterThan(0);

    const after = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    expect(after).toBe(before); // source untouched
  });

  test("reports a missing database as a loss", () => {
    const dir = mkdtempSync(join(tmpdir(), "salq3-"));
    const report = salvageSqlite(dir);
    expect(report.losses.length).toBeGreaterThan(0);
  });
});

describe("collectSalvageEvidence", () => {
  test("summarizes a rescue and proves the source was not modified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sev-"));
    const b = makeSqliteBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "rescueme" }, noop);
    await b.close();
    byteFlip(join(dir, "project.db"), 0, 100);

    const ev = collectSalvageEvidence("sqlite", dir, "corrupt@flip");
    expect(ev.case).toBe("corrupt@flip");
    expect(ev.candidate).toBe("sqlite");
    expect(ev.recovered_scenes).toBe(1);
    expect(ev.source_unmodified).toBe(true);
    expect(ev.loss_count).toBe(ev.losses.length);
  });

  test("records losses when nothing can be extracted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sev2-"));
    const b = makeDirBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "gone" }, noop);
    await b.close();
    tornWrite(join(dir, "manifest.json"), 0.3);

    const ev = collectSalvageEvidence("dir-manifest", dir, "corrupt@torn");
    expect(ev.recovered_scenes).toBe(0);
    expect(ev.loss_count).toBeGreaterThan(0);
    expect(ev.source_unmodified).toBe(true);
  });

  test("carries no absolute path into the evidence record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sev3-"));
    const b = makeDirBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "x" }, noop);
    await b.close();

    const ev = collectSalvageEvidence("dir-manifest", dir, "clean");
    expect(JSON.stringify(ev)).not.toContain(dir);
  });
});

describe("salvageProject", () => {
  test("dispatches on backend id", async () => {
    const sqliteDir = mkdtempSync(join(tmpdir(), "salp1-"));
    const sq = makeSqliteBackend(sqliteDir);
    await sq.open();
    await sq.apply({ seq: 0, kind: "type", sceneId: "s1", text: "sqlite-text" }, noop);
    await sq.close();
    expect(salvageProject("sqlite", sqliteDir).recoveredScenes.s1).toBe("sqlite-text");

    const dirDir = mkdtempSync(join(tmpdir(), "salp2-"));
    const dm = makeDirBackend(dirDir);
    await dm.open();
    await dm.apply({ seq: 0, kind: "type", sceneId: "s1", text: "dir-text" }, noop);
    await dm.close();
    expect(salvageProject("dir-manifest", dirDir).recoveredScenes.s1).toBe("dir-text");
  });
});
