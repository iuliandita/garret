// lab/fault-rig/src/backend-sqlite.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyPure, emptyState } from "./refmodel";
import type { Backend } from "./backend";
import type { EditOp, PhaseMarker, ProjectState } from "./model";

// Backend keeps a small ProjectState in memory mirroring the tables, folded
// through refmodel so table writes and the reference agree by construction.
export function makeSqliteBackend(projectDir: string) {
  const dbPath = join(projectDir, "project.db");
  let db: Database | null = null;
  let state: ProjectState = emptyState();

  function openDb() {
    mkdirSync(projectDir, { recursive: true });
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, text TEXT, ord INTEGER);
      CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, hash TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    state = readState(db);
  }

  function readState(d: Database): ProjectState {
    const scenes: Record<string, string> = {};
    const rows = d.query("SELECT id, text, ord FROM scenes ORDER BY ord").all() as
      { id: string; text: string; ord: number }[];
    for (const r of rows) scenes[r.id] = r.text;
    const order = rows.map((r) => r.id);
    const assets: Record<string, string> = {};
    for (const r of d.query("SELECT name, hash FROM assets").all() as
      { name: string; hash: string }[]) assets[r.name] = r.hash;
    const vrow = d.query("SELECT v FROM meta WHERE k = 'version'").get() as
      { v: string } | null;
    return { scenes, order, assets, version: vrow ? Number(vrow.v) : 0 };
  }

  // Apply one op as the smallest set of row writes that reaches `target`, inside
  // one transaction. Writing only the delta is the whole argument for a database
  // encoding, so the baseline must not rewrite the manuscript per commit.
  function writeDelta(
    d: Database, prev: ProjectState, target: ProjectState, op: EditOp,
  ) {
    const tx = d.transaction(() => {
      switch (op.kind) {
        case "type": {
          const id = op.sceneId!;
          const ord = target.order.indexOf(id);
          d.prepare(
            "INSERT INTO scenes (id, text, ord) VALUES (?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET text = excluded.text, ord = excluded.ord",
          ).run(id, target.scenes[id] ?? "", ord);
          break;
        }
        case "reorder": {
          // Only the scenes whose position actually moved are rewritten.
          const upd = d.prepare("UPDATE scenes SET ord = ? WHERE id = ?");
          target.order.forEach((id, i) => {
            if (prev.order[i] !== id) upd.run(i, id);
          });
          break;
        }
        case "import-asset":
          d.prepare(
            "INSERT INTO assets (name, hash) VALUES (?, ?) " +
            "ON CONFLICT(name) DO UPDATE SET hash = excluded.hash",
          ).run(op.assetName!, op.assetHash!);
          break;
        case "migrate":
          d.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('version', ?)")
            .run(String(target.version));
          break;
        case "snapshot":
          // Durability barrier only: the commit below is the whole point.
          break;
      }
    });
    tx();
  }

  const backend: Backend & { journalMode(): string; totalChanges(): number } = {
    id: "sqlite",
    async open() { openDb(); },
    async apply(op: EditOp, emit: (m: PhaseMarker) => void) {
      if (!db) throw new Error("not open");
      const next = applyPure(state, op);
      emit("begin-txn");
      writeDelta(db, state, next, op);   // commit with synchronous=FULL
      emit("fsync");
      // WAL checkpoint makes the commit durable in the main db file.
      db.exec("PRAGMA wal_checkpoint(FULL);");
      emit("rename");
      state = next;
      emit("commit-done");
    },
    async read(): Promise<ProjectState> {
      const d = new Database(dbPath);
      try { return readState(d); } finally { d.close(); }
    },
    async integrityCheck() {
      // Cold-storage inspection: open our own handle and never throw. A file
      // too corrupt to open ("file is not a database") is itself CORRUPT.
      let d: Database | null = null;
      try {
        d = new Database(dbPath);
        const r = d.query("PRAGMA integrity_check").get() as
          { integrity_check: string } | null;
        const ok = r?.integrity_check === "ok";
        return { ok, detail: r?.integrity_check ?? "no result" };
      } catch (e) {
        return { ok: false, detail: String(e) };
      } finally {
        d?.close();
      }
    },
    async close() { db?.close(); db = null; },
    // Row writes SQLite has performed on this connection; the incrementality
    // assertion reads it around a single commit.
    totalChanges() {
      if (!db) throw new Error("not open");
      const r = db.query("SELECT total_changes() AS n").get() as { n: number };
      return r.n;
    },
    journalMode() {
      if (!db) throw new Error("not open");
      const r = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      return r.journal_mode.toLowerCase();
    },
  };
  return backend;
}
