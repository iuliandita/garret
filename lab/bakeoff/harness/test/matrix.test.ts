import { expect, test } from "bun:test";
import { planMatrix, computeMetrics, evalRun } from "../src/matrix";
import type { Sample, SinkPayload } from "../../editor-core/src/bridge";

const noA11y = {
  available: false,
  hasEditor: false,
  hasNavigator: false,
  hasDialog: false,
};

test("planMatrix lists both candidates for the tiny fixture", () => {
  const plan = planMatrix({ fixture: "tiny", candidates: ["tauri", "electron"] });
  expect(plan.map((p) => p.candidate).sort()).toEqual(["electron", "tauri"]);
  for (const p of plan) expect(p.fixture).toBe("tiny");
});

test("computeMetrics splits typing vs navigation percentiles", () => {
  const samples: Sample[] = [
    ...Array.from({ length: 100 }, (_, i) => ({ workload: "typing" as const, ms: i + 1 })),
    ...Array.from({ length: 100 }, (_, i) => ({ workload: "navigation" as const, ms: (i + 1) * 2 })),
  ];
  const m = computeMetrics(
    samples,
    { coldStartMs: 1200, warmStartMs: 300, peakRssKb: 512_000 },
    { available: false, hasEditor: false, hasNavigator: false, hasDialog: false },
  );
  expect(m.typing_p95).toBe(95);
  expect(m.nav_p95).toBe(190);
  expect(m.cold_start_ms).toBe(1200);
  expect(m.peak_rss_mb).toBe(500); // 512000 KB / 1024
  expect(m.a11y.available).toBe(false);
});

test("evalRun grades a healthy run through the gates", () => {
  const payload: SinkPayload = {
    candidate: "electron",
    fixture: "tiny",
    seed: "s",
    coldStartMs: 1200,
    warmStartMs: 300,
    samples: [
      { workload: "typing", ms: 10 },
      { workload: "navigation", ms: 20 },
    ],
  };
  const r = evalRun(payload, 512_000, noA11y);
  expect(r.fixture).toBe("tiny");
  // Healthy run is graded by the real gates (includes typing_p95, peak_rss_mb...).
  expect(r.verdicts.some((v) => v.gate === "typing_p95")).toBe(true);
  expect(r.verdicts.some((v) => v.gate === "peak_rss_mb")).toBe(true);
  // Per-workload percentiles are recorded.
  expect(r.metrics).toHaveProperty("typing");
  expect(r.metrics).toHaveProperty("navigation");
});

test("evalRun records a crashed run as a single failing gate, not a pass", () => {
  // What run.ts sinks on a thrown error: empty samples, -1 timings, "error".
  const crashed: SinkPayload = {
    candidate: "tauri",
    fixture: "error",
    seed: "s",
    coldStartMs: -1,
    warmStartMs: -1,
    samples: [],
  };
  const r = evalRun(crashed, 0, noA11y);
  expect(r.fixture).toBe("error"); // marker survives into the record
  expect(r.verdicts).toHaveLength(1);
  expect(r.verdicts[0]!.gate).toBe("run");
  expect(r.verdicts[0]!.verdict).toBe("FAIL"); // never PASS
});
