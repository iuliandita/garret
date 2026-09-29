// lab/fault-rig/test/results.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResult, writeResult } from "../src/results";
import { SUPERSEDED_DIR } from "../../shared/archive";

describe("buildResult method override", () => {
  test("uses a caller-supplied method string when given", () => {
    const rec = buildResult({
      runId: "d", backendId: "sqlite", fixture: "tiny", verdicts: [],
      metrics: {}, seed: "s", rigCommit: "abc",
      method: "block-layer power loss via dm-flakey drop_writes",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    expect(rec.method).toContain("dm-flakey");
  });
});

describe("results", () => {
  test("buildResult carries the spec schema fields", () => {
    const rec = buildResult({
      runId: "run-1",
      backendId: "sqlite",
      fixture: "normal",
      verdicts: [{ case: "kill@rename#1", verdict: "NEW_COMPLETE" }],
      metrics: {},
      seed: "s",
      rigCommit: "abc123",
      environment: { kernel: "k", cpu: "c", throttleScope: "scope", biasNotes: "b" },
    });
    expect(rec.track).toBe("fault-rig");
    expect(rec.candidate).toBe("sqlite");
    expect(rec.environment.kernel).toBe("k");
    expect(rec.verdicts[0]!.verdict).toBe("NEW_COMPLETE");
  });

  test("writeResult emits one JSON file into the results dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "res-"));
    const rec = buildResult({
      runId: "run-2", backendId: "dir-manifest", fixture: "tiny",
      verdicts: [], metrics: {}, seed: "s", rigCommit: "def",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const path = writeResult(rec, dir);
    expect(readdirSync(dir)).toContain("run-2.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.run_id).toBe("run-2");
  });

  // `sqlite-<fixture>.json` is the baseline the rusqlite spot-check compares
  // against. Overwriting it in place would silently change what an "agreed
  // 11/11" verdict was measured against, with nothing on disk recording that
  // the baseline had moved.
  test("writeResult preserves an earlier run of the same configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "res-"));
    const rec = (seed: string) => buildResult({
      runId: "sqlite-normal", backendId: "sqlite", fixture: "normal",
      verdicts: [], metrics: {}, seed, rigCommit: "def",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });

    writeResult(rec("baseline-one"), dir);
    const path = writeResult(rec("baseline-two"), dir);

    expect(JSON.parse(readFileSync(path, "utf8")).seed).toBe("baseline-two");

    const archived = readdirSync(join(dir, SUPERSEDED_DIR));
    expect(archived).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(dir, SUPERSEDED_DIR, archived[0]!), "utf8")).seed,
    ).toBe("baseline-one");
  });
});
