import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResult, scriptOf, writeResult, type ResultInput } from "../src/results";

const input: ResultInput = {
  runId: "app-smoke-tiny",
  candidate: "tauri",
  fixture: "tiny",
  workload: "app-smoke",
  verdicts: [{ gate: "peak_rss_mb", value: 320, threshold: "< 750", verdict: "PASS" }],
  metrics: { peak_rss_mb: 320 },
  seed: "app-v1",
  rigCommit: "abc1234",
  environment: {
    kernel: "7.1.2",
    cpu: "test",
    throttleScope: "none",
    loadAvg1m: 1.5,
    renderer: null,
    biasNotes: "test",
  },
};

describe("buildResult", () => {
  test("emits the fixed top-level schema in snake_case", () => {
    const rec = buildResult(input);
    expect(Object.keys(rec).sort()).toEqual([
      "candidate", "environment", "fixture", "method", "metrics",
      "rig_commit", "run_id", "seed", "track", "verdicts", "workload",
    ]);
    expect(rec.run_id).toBe("app-smoke-tiny");
    expect(rec.track).toBe("app");
    expect(rec.rig_commit).toBe("abc1234");
  });

  // The label was hardcoded, so navigator, persistence and hierarchy evidence
  // all described itself as a smoke run. A result that misnames its own
  // workload is unreadable a year later.
  test("workload comes from the caller, not a constant", () => {
    expect(buildResult({ ...input, workload: "app-hier" }).workload).toBe("app-hier");
    expect(buildResult({ ...input, workload: "app-navigator" }).workload).toBe("app-navigator");
  });

  test("method records the scope limits", () => {
    const rec = buildResult(input);
    expect(rec.method).toContain("Linux");
    expect(rec.method).toContain("hypotheses");
  });
});

describe("workload_script", () => {
  test("a payload from before the field existed reads as pre-versioning", () => {
    // Seven committed results predate this field. They must stay readable, and
    // they must not silently claim to have run the current script.
    expect(scriptOf(undefined)).toBe("pre-versioning");
  });

  test("a payload carrying the field reports it verbatim", () => {
    expect(scriptOf("writing-v1")).toBe("writing-v1");
  });
});

describe("writeResult", () => {
  test("writes to <run_id>.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "res-"));
    const path = writeResult(buildResult(input), dir);
    expect(path).toBe(join(dir, "app-smoke-tiny.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).run_id).toBe("app-smoke-tiny");
  });

  test("a second run of the same configuration displaces the first, never overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "res-"));
    writeResult(buildResult(input), dir);
    writeResult(buildResult({ ...input, metrics: { peak_rss_mb: 400 } }), dir);

    const canonical = JSON.parse(readFileSync(join(dir, "app-smoke-tiny.json"), "utf8"));
    expect(canonical.metrics.peak_rss_mb).toBe(400);
    expect(existsSync(join(dir, "superseded"))).toBe(true);
  });
});
