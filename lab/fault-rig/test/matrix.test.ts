// lab/fault-rig/test/matrix.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTriggers, runMatrixCases } from "../src/matrix";

const SCENES = ["s1", "s2", "s3"];

describe("buildTriggers", () => {
  test("covers every phase marker and both corruption modes", () => {
    const names = buildTriggers(2).map((t) => t.name);
    expect(names).toContain("kill@fsync#1");
    expect(names).toContain("kill@commit-done#3");
    expect(names).toContain("corrupt@torn");
    expect(names).toContain("corrupt@flip");
  });

  test("includes cloud-folder interference cases with a running mutator", () => {
    const cases = buildTriggers(2);
    const withMutator = cases.filter((c) => c.mutatorIntervalMs !== undefined);
    expect(withMutator.length).toBeGreaterThan(0);
    for (const c of withMutator) expect(c.name).toContain("mutator");
  });
});

describe("mutator interference", () => {
  test(
    "an external mutator churning the project dir does not corrupt a commit",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "mtx3-"));
      const cases = buildTriggers(0).filter((c) => c.mutatorIntervalMs !== undefined);
      const out = await runMatrixCases("dir-manifest", root, "mut-test", SCENES, 4, cases);

      expect(out.verdicts.length).toBe(cases.length);
      for (const v of out.verdicts) {
        expect(["OLD_INTACT", "NEW_COMPLETE"]).toContain(v.verdict);
      }
    },
    30_000,
  );
});

describe("runMatrixCases", () => {
  test(
    "feeds every CORRUPT artifact to the read-only salvage prototype",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "mtx-"));
      const cases = buildTriggers(0).filter((t) => t.name.startsWith("corrupt@"));
      const out = await runMatrixCases("sqlite", root, "matrix-test", SCENES, 3, cases);

      expect(out.verdicts.length).toBe(2);
      const corrupted = out.verdicts.filter((v) => v.verdict === "CORRUPT");
      expect(corrupted.length).toBeGreaterThan(0);
      // One salvage attempt per CORRUPT verdict, no more and no fewer.
      expect(out.salvage.length).toBe(corrupted.length);
      for (const ev of out.salvage) {
        expect(ev.source_unmodified).toBe(true);
        expect(ev.candidate).toBe("sqlite");
      }
    },
    20_000,
  );

  test(
    "records no salvage attempt when nothing is classified CORRUPT",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "mtx2-"));
      const cases = buildTriggers(0).filter((t) => t.name === "kill@commit-done#1");
      const out = await runMatrixCases("dir-manifest", root, "matrix-test", SCENES, 3, cases);

      expect(out.verdicts.length).toBe(1);
      expect(out.verdicts[0]!.verdict).not.toBe("CORRUPT");
      expect(out.salvage.length).toBe(0);
    },
    20_000,
  );
});
