// lab/fault-rig/test/measure.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureCommits } from "../src/measure";
import type { BackendId } from "../src/model";

const SCENES = ["s1", "s2", "s3"];

describe("measureCommits", () => {
  for (const backendId of ["dir-manifest", "sqlite"] as BackendId[]) {
    test(`emits latency, size and mirror numbers for ${backendId}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `meas-${backendId}-`));
      const m = await measureCommits({
        backendId,
        projectDir: dir,
        seed: "measure-test",
        scenes: SCENES,
        opCount: 8,
        mirrorWindowMs: 20,
      });

      expect(m.ops).toBe(8);
      expect(m.commit_latency_ms.samples).toBe(8);
      expect(m.commit_latency_ms.p50).toBeGreaterThan(0);
      expect(m.commit_latency_ms.p99).toBeGreaterThanOrEqual(m.commit_latency_ms.p50);

      expect(m.size.bytes_after).toBeGreaterThan(0);
      expect(m.size.logical_bytes).toBeGreaterThan(0);
      expect(m.size.bytes_per_op).toBeCloseTo(m.size.bytes_after / 8, 5);

      expect(m.mirror.flushes).toBeGreaterThan(0);
      expect(m.mirror.bytes_written).toBeGreaterThan(0);
      // A mirror ships whole durable artifacts, so it always moves more bytes
      // than the user actually typed.
      expect(m.mirror.amplification).toBeGreaterThan(1);
    });
  }

  // dir-manifest rewrites the whole project on every commit, sqlite writes only
  // the change. That difference is invisible on an empty project, so commit cost
  // has to be measured against a manuscript-sized one.
  test("charges commit latency against a preloaded manuscript", async () => {
    const preload: Record<string, string> = {};
    for (let i = 0; i < 40; i++) preload[`p${i}`] = "x".repeat(20_000);

    const loaded = await measureCommits({
      backendId: "dir-manifest",
      projectDir: mkdtempSync(join(tmpdir(), "meas-load-")),
      seed: "scale", scenes: SCENES, opCount: 8, mirrorWindowMs: 20,
      preload,
    });
    const empty = await measureCommits({
      backendId: "dir-manifest",
      projectDir: mkdtempSync(join(tmpdir(), "meas-empty-")),
      seed: "scale", scenes: SCENES, opCount: 8, mirrorWindowMs: 20,
    });

    expect(loaded.preloaded_bytes).toBeGreaterThan(700_000);
    expect(empty.preloaded_bytes).toBe(0);
    expect(loaded.size.bytes_after).toBeGreaterThan(empty.size.bytes_after);
    // Preload is applied before timing starts, so it never enters the samples.
    expect(loaded.commit_latency_ms.samples).toBe(8);
  }, 20_000);

  test("is deterministic in op count across repeated runs", async () => {
    const runOnce = () =>
      measureCommits({
        backendId: "dir-manifest",
        projectDir: mkdtempSync(join(tmpdir(), "meas-det-")),
        seed: "same-seed",
        scenes: SCENES,
        opCount: 6,
        mirrorWindowMs: 20,
      });
    const a = await runOnce();
    const b = await runOnce();
    expect(a.size.logical_bytes).toBe(b.size.logical_bytes);
    expect(a.size.bytes_after).toBe(b.size.bytes_after);
  });
});
