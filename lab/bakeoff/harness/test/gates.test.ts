import { expect, test } from "bun:test";
import { evaluateGates, THRESHOLDS, type Metrics } from "../src/gates";

const base: Metrics = {
  typing_p95: 20,
  typing_p99: 40,
  nav_p95: 30,
  cold_start_ms: 1500,
  warm_start_ms: 400,
  peak_rss_mb: 500,
  a11y: { available: true, hasEditor: true, hasNavigator: true, hasDialog: true },
};

function verdict(gates: ReturnType<typeof evaluateGates>, name: string) {
  return gates.find((g) => g.gate === name)?.verdict;
}

test("all gates pass on a healthy run", () => {
  const gates = evaluateGates(base);
  expect(gates.every((g) => g.verdict === "PASS")).toBe(true);
});

test("memory over 750MB fails the memory gate", () => {
  const gates = evaluateGates({ ...base, peak_rss_mb: 800 });
  expect(verdict(gates, "peak_rss_mb")).toBe("FAIL");
  expect(THRESHOLDS.peak_rss_mb).toBe(750);
});

test("typing p95/p99 over threshold fail their gates", () => {
  const gates = evaluateGates({
    ...base,
    typing_p95: THRESHOLDS.typing_p95_ms + 1,
    typing_p99: THRESHOLDS.typing_p99_ms + 1,
  });
  expect(verdict(gates, "typing_p95")).toBe("FAIL");
  expect(verdict(gates, "typing_p99")).toBe("FAIL");
});

test("missing a11y probe yields UNKNOWN, not PASS", () => {
  const gates = evaluateGates({
    ...base,
    a11y: { available: false, hasEditor: false, hasNavigator: false, hasDialog: false },
  });
  expect(verdict(gates, "a11y_exposure")).toBe("UNKNOWN");
});

test("a11y available but missing a required node fails", () => {
  const gates = evaluateGates({
    ...base,
    a11y: { available: true, hasEditor: true, hasNavigator: false, hasDialog: true },
  });
  expect(verdict(gates, "a11y_exposure")).toBe("FAIL");
});
