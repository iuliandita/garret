// lab/bakeoff/harness/src/gates.ts
// Elimination gates per spec Track 2. Only peak_rss_mb < 750 is a spec-hard
// number; the latency/startup thresholds are named placeholder hypotheses,
// documented as such. A gate whose probe is unavailable reports UNKNOWN.
import type { GateResult } from "./results";

export interface A11yProbe {
  available: boolean;
  hasEditor: boolean;
  hasNavigator: boolean;
  hasDialog: boolean;
  roles?: string[];
}

export interface Metrics {
  typing_p95: number;
  typing_p99: number;
  nav_p95: number;
  cold_start_ms: number;
  warm_start_ms: number;
  peak_rss_mb: number;
  a11y: A11yProbe;
}

// peak_rss_mb is spec-hard (< 750). The rest are recorded hypotheses (see
// captureEnv biasNotes) pending a real-hardware pass.
export const THRESHOLDS = {
  typing_p95_ms: 50,
  typing_p99_ms: 100,
  nav_p95_ms: 150,
  cold_start_ms: 3000,
  warm_start_ms: 1500,
  peak_rss_mb: 750,
} as const;

// A long writing session, used to project the soak's RSS trend forward. This is
// the placeholder assumption in the soak gate — the 750 MB limit itself is the
// spec's, not invented here. Stated as a number so it can be argued with.
export const SOAK_SESSION_HOURS = 8;

// Below this, a fitted slope is noise, not a trend: a 30-second window over a
// still-settling process produced -2144 MB/h in a smoke run. Short soaks report
// UNKNOWN rather than a projection nobody should quote.
export const SOAK_MIN_TREND_MINUTES = 10;

// Gates that are recorded but do not eliminate. The 8h projection was demoted
// here by a pre-commitment gate revision (A2, 2026-07-26): at 30 minutes the
// fitted slope is not stable enough to multiply by 8. Two baseline soaks of the
// same variant configuration fitted 64.2 and 22.3 MB/h, and two configs
// differing only by lazy-docs fitted 162.1 and 29.1 MB/h over the same 115
// cycles while their peak RSS differed by 95 MB. The projection also ranked
// configs backwards: the only one that passed it failed typing at 1001 ms. The
// measured gates (peak_rss_mb, soak_peak_rss_mb) are unchanged and eliminate.
//
// Keyed by gate NAME, and applied at render time as well as at evaluation time,
// so results recorded before the revision re-render under the revised rule
// without any measured value being rewritten.
export const ADVISORY_GATES: ReadonlySet<string> = new Set([
  `soak_projected_${SOAK_SESSION_HOURS}h_rss_mb`,
]);

export function isAdvisoryGate(gate: string): boolean {
  return ADVISORY_GATES.has(gate);
}

export interface SoakMetrics {
  soak_minutes: number;
  cycles: number;
  chars_typed: number;
  peak_rss_mb: number;
  final_rss_mb: number;
  leak_slope_mb_per_hr: number;
  typing_p95_first_cycle_ms: number;
  typing_p95_last_cycle_ms: number;
}

// Projected resident memory after a full session, if the fitted trend holds.
// A negative slope (memory settling back) must not project BELOW the measured
// final RSS in a way that reads as headroom, so the projection floors there.
export function projectedSessionRssMb(m: SoakMetrics): number {
  const projected = m.final_rss_mb + m.leak_slope_mb_per_hr * SOAK_SESSION_HOURS;
  return Math.round(Math.max(projected, m.final_rss_mb));
}

// The soak does not introduce a new memory threshold: it re-applies the spec's
// 750 MB gate to a sustained session instead of a 30-second run, and re-applies
// the typing threshold to the LAST cycle so latency decay is caught. The
// forward projection is recorded but advisory (see ADVISORY_GATES).
export function evaluateSoakGates(m: SoakMetrics): GateResult[] {
  const projectionGate = `soak_projected_${SOAK_SESSION_HOURS}h_rss_mb`;
  return [
    numGate("soak_peak_rss_mb", m.peak_rss_mb, THRESHOLDS.peak_rss_mb, "MB"),
    m.soak_minutes < SOAK_MIN_TREND_MINUTES
      ? {
          gate: projectionGate,
          value:
            `not fitted (${m.soak_minutes} min < ${SOAK_MIN_TREND_MINUTES} min ` +
            "minimum for a trend)",
          threshold: `< ${THRESHOLDS.peak_rss_mb} MB`,
          verdict: "UNKNOWN",
        }
      : classify(
          numGate(
            projectionGate,
            projectedSessionRssMb(m),
            THRESHOLDS.peak_rss_mb,
            "MB",
          ),
        ),
    numGate(
      "soak_typing_p95_last_cycle",
      m.typing_p95_last_cycle_ms,
      THRESHOLDS.typing_p95_ms,
      "ms",
    ),
  ];
}

function numGate(
  gate: string,
  value: number,
  limit: number,
  unit: string,
): GateResult {
  return {
    gate,
    value,
    threshold: `< ${limit} ${unit}`,
    verdict: value < limit ? "PASS" : "FAIL",
  };
}

// Demote an advisory gate's PASS/FAIL to ADVISORY. The measured value and the
// threshold it was compared against are left exactly as recorded; only the
// consequence changes. UNKNOWN is left alone — an unfitted projection is absent
// evidence, not weak evidence, and the two should not read the same.
export function classify(g: GateResult): GateResult {
  if (!isAdvisoryGate(g.gate) || g.verdict === "UNKNOWN") return g;
  return { ...g, verdict: "ADVISORY" };
}

export function evaluateGates(m: Metrics): GateResult[] {
  const a = m.a11y;
  const a11yVerdict: GateResult["verdict"] = !a.available
    ? "UNKNOWN"
    : a.hasEditor && a.hasNavigator && a.hasDialog
      ? "PASS"
      : "FAIL";
  return [
    numGate("typing_p95", m.typing_p95, THRESHOLDS.typing_p95_ms, "ms"),
    numGate("typing_p99", m.typing_p99, THRESHOLDS.typing_p99_ms, "ms"),
    numGate("nav_p95", m.nav_p95, THRESHOLDS.nav_p95_ms, "ms"),
    numGate("cold_start", m.cold_start_ms, THRESHOLDS.cold_start_ms, "ms"),
    numGate("warm_start", m.warm_start_ms, THRESHOLDS.warm_start_ms, "ms"),
    numGate("peak_rss_mb", m.peak_rss_mb, THRESHOLDS.peak_rss_mb, "MB"),
    {
      gate: "a11y_exposure",
      value: a.available
        ? `editor=${a.hasEditor} nav=${a.hasNavigator} dialog=${a.hasDialog}`
        : "probe-unavailable",
      threshold: "editor+navigator+dialog exposed",
      verdict: a11yVerdict,
    },
  ];
}
