import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResult, writeResult, type GateResult } from "../src/results";
import { SUPERSEDED_DIR } from "../../../shared/archive";

const env = {
  kernel: "7.1.2",
  cpu: "test-cpu",
  throttleScope: "0-3 / 8G",
  biasNotes: "test",
};
const gates: GateResult[] = [
  { gate: "typing_p95", value: 12, threshold: "< 50 ms", verdict: "PASS" },
  { gate: "peak_rss_mb", value: 900, threshold: "< 750 MB", verdict: "FAIL" },
];

test("buildResult maps to the spec schema with track bakeoff", () => {
  const rec = buildResult({
    runId: "run-x",
    candidate: "electron",
    fixture: "tiny",
    verdicts: gates,
    metrics: { typing_p95: 12 },
    seed: "s",
    rigCommit: "abc123",
    environment: env,
  });
  expect(rec.track).toBe("bakeoff");
  expect(rec.candidate).toBe("electron");
  expect(rec.workload).toBe("bakeoff-suite");
  expect(rec.rig_commit).toBe("abc123");
  expect(rec.verdicts.length).toBe(2);
});

test("writeResult emits <run_id>.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-res-"));
  try {
    const rec = buildResult({
      runId: "run-y",
      candidate: "tauri",
      fixture: "tiny",
      verdicts: gates,
      metrics: {},
      seed: "s",
      rigCommit: "def",
      environment: env,
    });
    const p = writeResult(rec, dir);
    expect(p.endsWith("run-y.json")).toBe(true);
    const reread = JSON.parse(readFileSync(p, "utf8"));
    expect(reread.candidate).toBe("tauri");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// run_id is a configuration key, so re-running a matrix cell writes to a path
// that may already hold a DIFFERENT run. Overwriting there destroyed a stress
// soak's only JSON copy. The second run must not be able to erase the first.
test("writeResult preserves an earlier run of the same configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-res-"));
  try {
    const rec = (seed: string) => buildResult({
      runId: "bakeoff-tauri-stress-soak",
      candidate: "tauri", fixture: "stress", verdicts: gates,
      metrics: {}, seed, rigCommit: "def", environment: env,
    });

    const first = writeResult(rec("run-one"), dir);
    const second = writeResult(rec("run-two"), dir);

    // The canonical path still names the configuration and holds the newest
    // run: the decision write-backs cite it directly.
    expect(second).toBe(first);
    expect(JSON.parse(readFileSync(second, "utf8")).seed).toBe("run-two");

    // ...and the displaced run is still on disk, intact.
    const archived = readdirSync(join(dir, SUPERSEDED_DIR));
    expect(archived).toHaveLength(1);
    const kept = JSON.parse(
      readFileSync(join(dir, SUPERSEDED_DIR, archived[0]!), "utf8"),
    );
    expect(kept.seed).toBe("run-one");
    expect(kept.run_id).toBe("bakeoff-tauri-stress-soak");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
