import { expect, test } from "bun:test";
import { renderReport } from "../src/report";
import { buildResult } from "../src/results";

const env = { kernel: "7.1", cpu: "cpu", throttleScope: "0-3 / 8G", biasNotes: "b" };

const electron = buildResult({
  runId: "r1", candidate: "electron", fixture: "tiny", metrics: {},
  seed: "s", rigCommit: "c", environment: env,
  verdicts: [
    { gate: "typing_p95", value: 12, threshold: "< 50 ms", verdict: "PASS" },
    { gate: "peak_rss_mb", value: 900, threshold: "< 750 MB", verdict: "FAIL" },
    { gate: "a11y_exposure", value: "probe-unavailable", threshold: "x", verdict: "UNKNOWN" },
  ],
});
const tauri = buildResult({
  runId: "r2", candidate: "tauri", fixture: "tiny", metrics: {},
  seed: "s", rigCommit: "c", environment: env,
  verdicts: [
    { gate: "typing_p95", value: 18, threshold: "< 50 ms", verdict: "PASS" },
    { gate: "peak_rss_mb", value: 300, threshold: "< 750 MB", verdict: "PASS" },
    { gate: "a11y_exposure", value: "editor=true nav=true dialog=true", threshold: "x", verdict: "PASS" },
  ],
});

test("renders a per-candidate gate table", () => {
  const md = renderReport([electron, tauri]);
  expect(md).toContain("electron");
  expect(md).toContain("tauri");
  expect(md).toContain("typing_p95");
  expect(md).toContain("peak_rss_mb");
});

test("summarizes stack pass/fail with any FAIL eliminating the stack", () => {
  const md = renderReport([electron, tauri]);
  // electron has a FAIL gate => eliminated; tauri all PASS => survives.
  expect(md).toMatch(/electron\s*\|\s*1\s*\|\s*1\s*\|\s*0\s*\|\s*ELIMINATED/);
  expect(md).toMatch(/tauri\s*\|\s*0\s*\|\s*0\s*\|\s*0\s*\|\s*SURVIVES/);
});

// Results recorded before the 2026-07-26 gate revision carry verdict "FAIL" on
// the projection gate. They must re-render under the current rule without the
// stored JSON being touched, or the amendment could only be applied by editing
// evidence — which is exactly what the rig exists to prevent.
test("re-classifies a stored projection FAIL as advisory at render time", () => {
  const preRevision = buildResult({
    runId: "r3", candidate: "tauri", fixture: "stress", metrics: {},
    seed: "s", rigCommit: "c", environment: env,
    verdicts: [
      { gate: "peak_rss_mb", value: 573, threshold: "< 750 MB", verdict: "PASS" },
      { gate: "soak_peak_rss_mb", value: 573, threshold: "< 750 MB", verdict: "PASS" },
      { gate: "soak_projected_8h_rss_mb", value: 792, threshold: "< 750 MB", verdict: "FAIL" },
    ],
  });
  const md = renderReport([preRevision]);
  expect(md).toContain("| 792 | < 750 MB | ADVISORY |");
  // The advisory gate is counted, but it does not eliminate.
  expect(md).toMatch(/tauri\s*\|\s*0\s*\|\s*0\s*\|\s*1\s*\|\s*SURVIVES/);
});

// A revision that quietly rewrote the measurement would be indistinguishable in
// the report from one that changed its consequence. Only the latter is allowed.
test("leaves the recorded value and threshold untouched when demoting", () => {
  const md = renderReport([
    buildResult({
      runId: "r4", candidate: "electron", fixture: "stress", metrics: {},
      seed: "s", rigCommit: "c", environment: env,
      verdicts: [
        { gate: "peak_rss_mb", value: 911, threshold: "< 750 MB", verdict: "FAIL" },
        { gate: "soak_projected_8h_rss_mb", value: 1135, threshold: "< 750 MB", verdict: "FAIL" },
      ],
    }),
  ]);
  expect(md).toContain("| 1135 | < 750 MB | ADVISORY |");
  // Measured peak still eliminates: demoting the projection did not rescue it.
  expect(md).toMatch(/electron\s*\|\s*1\s*\|\s*0\s*\|\s*1\s*\|\s*ELIMINATED/);
});
