// lab/fault-rig/test/rust-child.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkload } from "../src/workload";
import { makeSqliteBackend } from "../src/backend-sqlite";
import { refStates, hashState, emptyState } from "../src/refmodel";
import { RUST_CHILD, RUST_CHILD_BUILD } from "../src/childcmd";
import type { EditOp } from "../src/model";

// The Rust child is an optional build artifact, so the suite stays runnable
// without a Rust toolchain. It is loud about skipping: a silent skip here would
// let the hedge look tested when it never ran.
const built = existsSync(RUST_CHILD);
if (!built) {
  console.warn(
    `[rust-child] SKIPPED: binary not built at ${RUST_CHILD}\n` +
    `  build it with: ${RUST_CHILD_BUILD}`,
  );
}
const rustTest = built ? test : test.skip;

async function runRustChild(ops: EditOp[]): Promise<{ dir: string; out: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "rustchild-"));
  const projectDir = join(tmp, "proj");
  const wlPath = join(tmp, "wl.json");
  writeFileSync(wlPath, JSON.stringify(ops));
  const proc = Bun.spawn([RUST_CHILD, projectDir, wlPath], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`rust child exited ${code}: ${err}`);
  return { dir: projectDir, out };
}

describe("rusqlite child writer", () => {
  rustTest("clean run persists the refmodel final state", async () => {
    const ops = buildWorkload("rust-clean", ["s1", "s2", "s3"], 15);
    const { dir, out } = await runRustChild(ops);

    expect(out.split("\n").filter((l) => l.startsWith("ACK ")).length).toBe(15);
    expect(out.trimEnd().endsWith("DONE")).toBe(true);

    // Read back through the SAME bun:sqlite verifier the matrix uses, which is
    // what makes a verdict comparison against the baseline meaningful.
    const b = makeSqliteBackend(dir);
    await b.open();
    const state = await b.read();
    const integrity = await b.integrityCheck();
    await b.close();
    expect(integrity.ok).toBe(true);
    expect(hashState(state)).toBe(hashState(refStates(emptyState(), ops).at(-1)!));
  });

  // The port of refmodel.applyPure into Rust is the part most likely to drift:
  // out-of-range `fromOrder` must be a no-op and `toOrder` must clamp, exactly
  // as JS splice does. A longer workload over more scenes hits both paths.
  rustTest("agrees with the bun:sqlite backend op for op", async () => {
    const scenes = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const ops = buildWorkload("rust-conformance", scenes, 120);
    const { dir } = await runRustChild(ops);

    const tsDir = mkdtempSync(join(tmpdir(), "tschild-"));
    const ts = makeSqliteBackend(tsDir);
    await ts.open();
    for (const op of ops) await ts.apply(op, () => {});
    const tsState = await ts.read();
    await ts.close();

    const rs = makeSqliteBackend(dir);
    await rs.open();
    const rsState = await rs.read();
    await rs.close();

    expect(hashState(rsState)).toBe(hashState(tsState));
    // `order` is carried by the `ord` column, not just by row content, so a
    // hash match with a scrambled order would be impossible — assert it anyway
    // because ordering is the one field a delta-writer can silently corrupt.
    expect(rsState.order).toEqual(tsState.order);
  });

  // The supervisor kills on a marker and treats the last ACK as durable, so the
  // per-op sequence must be begin-txn -> fsync -> rename -> commit-done -> ACK.
  // Any other order would make the kill land at the wrong point in the commit.
  rustTest("emits the phase markers in commit order before each ACK", async () => {
    const ops = buildWorkload("rust-protocol", ["s1", "s2"], 6);
    const { out } = await runRustChild(ops);
    const lines = out.split("\n").filter(Boolean);
    for (const op of ops) {
      const own = lines
        .filter((l) => l.split(" ")[1] === String(op.seq))
        .map((l) => (l.startsWith("ACK ") ? "ACK" : l.split(" ")[2]));
      expect(own).toEqual(["begin-txn", "fsync", "rename", "commit-done", "ACK"]);
    }
  });

  rustTest("keeps the database in WAL mode", async () => {
    const ops = buildWorkload("rust-wal", ["s1"], 3);
    const { dir } = await runRustChild(ops);
    const b = makeSqliteBackend(dir);
    await b.open();
    const mode = b.journalMode();
    await b.close();
    expect(mode).toBe("wal");
  });

  rustTest("reports the SQLite version it linked", async () => {
    const r = Bun.spawnSync([RUST_CHILD, "--sqlite-version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toMatch(/^3\.\d+\.\d+$/);
  });
});
