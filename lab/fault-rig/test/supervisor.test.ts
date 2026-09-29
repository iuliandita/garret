// lab/fault-rig/test/supervisor.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase } from "../src/supervisor";

const scenes = ["s1", "s2", "s3"];

describe("supervisor", () => {
  test("kill at rename marker never loses acked edits (dir-manifest)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    const res = await runCase({
      backendId: "dir-manifest",
      projectDir: join(dir, "p"),
      seed: "sup1",
      scenes,
      opCount: 30,
      trigger: { type: "marker", marker: "rename", occurrence: 3 },
    });
    expect(["OLD_INTACT", "NEW_COMPLETE"]).toContain(res.verdict);
  });

  test("kill at random delay never corrupts (sqlite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup2-"));
    const res = await runCase({
      backendId: "sqlite",
      projectDir: join(dir, "p"),
      seed: "sup2",
      scenes,
      opCount: 30,
      trigger: { type: "delay", ms: 5 },
    });
    expect(res.verdict).not.toBe("CORRUPT");
    expect(res.verdict).not.toBe("REGRESSION");
  });

  test("full clean run (no kill) is NEW_COMPLETE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup3-"));
    const res = await runCase({
      backendId: "dir-manifest",
      projectDir: join(dir, "p"),
      seed: "sup3",
      scenes,
      opCount: 10,
      trigger: { type: "none" },
    });
    expect(res.verdict).toBe("NEW_COMPLETE");
  });

  // End-to-end no-silent-corruption: inject corruption after a clean run and
  // require the full supervisor->recovery->classify pipeline to return CORRUPT.
  for (const backendId of ["dir-manifest", "sqlite"] as const) {
    for (const mode of ["torn", "flip"] as const) {
      test(`corrupt ${mode} on ${backendId} recovers as CORRUPT`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "supc-"));
        const res = await runCase({
          backendId,
          projectDir: join(dir, "p"),
          seed: `corrupt-${backendId}-${mode}`,
          scenes,
          opCount: 20,
          trigger: { type: "corrupt", mode },
        });
        expect(res.verdict).toBe("CORRUPT");
      });
    }
  }
});
