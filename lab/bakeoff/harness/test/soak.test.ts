// lab/bakeoff/test/soak.test.ts
import { describe, expect, test } from "bun:test";
import { leakSlopeMbPerHour, type RssSample } from "../src/rss";
import {
  evaluateSoakGates, projectedSessionRssMb, SOAK_SESSION_HOURS,
  SOAK_MIN_TREND_MINUTES, type SoakMetrics,
} from "../src/gates";
import { evalSoak } from "../src/matrix";
import type { SinkPayload, SoakCycle } from "../../editor-core/src/bridge";

const HOUR_MS = 3_600_000;

function series(points: [number, number][]): RssSample[] {
  return points.map(([atMs, rssKb]) => ({ atMs, rssKb }));
}

describe("leakSlopeMbPerHour", () => {
  // A flat process is the case that must not produce a phantom leak.
  test("reports zero slope for flat memory", () => {
    const flat = series([[0, 500_000], [1000, 500_000], [2000, 500_000], [3000, 500_000]]);
    expect(leakSlopeMbPerHour(flat)).toBe(0);
  });

  test("recovers a known linear growth rate", () => {
    // 100 MB/h over one hour, sampled every 6 minutes.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) pts.push([i * (HOUR_MS / 10), 500_000 + i * 10 * 1024]);
    expect(leakSlopeMbPerHour(series(pts), 0)).toBeCloseTo(100, 1);
  });

  test("reports a negative slope when memory settles back", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) pts.push([i * (HOUR_MS / 10), 600_000 - i * 5 * 1024]);
    expect(leakSlopeMbPerHour(series(pts), 0)).toBeCloseTo(-50, 1);
  });

  // Startup allocation is not a leak. A run that climbs steeply then flattens
  // must fit the flat part, or every process looks like it leaks.
  test("drops the warmup window before fitting", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 5; i++) pts.push([i * 60_000, 200_000 + i * 100_000]); // ramp
    for (let i = 5; i < 25; i++) pts.push([i * 60_000, 600_000]);             // flat
    expect(leakSlopeMbPerHour(series(pts), 0.2)).toBeCloseTo(0, 1);
    expect(leakSlopeMbPerHour(series(pts), 0)).toBeGreaterThan(100);
  });

  test("claims no trend from fewer than two usable points", () => {
    expect(leakSlopeMbPerHour(series([[0, 500_000]]))).toBe(0);
    expect(leakSlopeMbPerHour([])).toBe(0);
  });

  test("survives a series whose samples share one timestamp", () => {
    expect(leakSlopeMbPerHour(series([[0, 500_000], [0, 600_000]]), 0)).toBe(0);
  });
});

describe("projectedSessionRssMb", () => {
  const base: SoakMetrics = {
    soak_minutes: 30, cycles: 40, chars_typed: 16_000,
    peak_rss_mb: 570, final_rss_mb: 560, leak_slope_mb_per_hr: 10,
    typing_p95_first_cycle_ms: 34, typing_p95_last_cycle_ms: 34,
  };

  test("carries the slope forward over the session", () => {
    expect(projectedSessionRssMb(base)).toBe(560 + 10 * SOAK_SESSION_HOURS);
  });

  // A process whose memory settles must not be credited with headroom it does
  // not have: the projection floors at the measured final RSS.
  test("never projects below the measured final RSS", () => {
    expect(projectedSessionRssMb({ ...base, leak_slope_mb_per_hr: -50 })).toBe(560);
  });
});

describe("evaluateSoakGates", () => {
  const ok: SoakMetrics = {
    soak_minutes: 30, cycles: 40, chars_typed: 16_000,
    peak_rss_mb: 564, final_rss_mb: 560, leak_slope_mb_per_hr: 2,
    typing_p95_first_cycle_ms: 34, typing_p95_last_cycle_ms: 34,
  };

  test("passes a stable session, with the projection recorded as advisory", () => {
    const gates = evaluateSoakGates(ok);
    expect(gates.filter((g) => g.verdict === "FAIL")).toHaveLength(0);
    expect(gates.find((g) => g.gate.startsWith("soak_projected"))!.verdict)
      .toBe("ADVISORY");
  });

  // The projection still reports a leak heading through the gate within one
  // working session, but it does not eliminate: the 30-minute slope is not
  // stable enough to multiply by eight (A2 revision, 2026-07-26). The measured
  // peak gate is what eliminates.
  test("records a leaky projection as advisory, never as a failure", () => {
    const leaky = { ...ok, leak_slope_mb_per_hr: 40 };
    const gates = evaluateSoakGates(leaky);
    expect(gates.find((g) => g.gate === "soak_peak_rss_mb")!.verdict).toBe("PASS");
    const projected = gates.find((g) => g.gate.startsWith("soak_projected"))!;
    expect(projected.verdict).toBe("ADVISORY");
    // The number itself must survive the demotion, or the gate stops informing.
    expect(projected.value).toBe(560 + 40 * SOAK_SESSION_HOURS);
    expect(gates.filter((g) => g.verdict === "FAIL")).toHaveLength(0);
  });

  // A slope fitted over a few seconds is noise. The smoke run that motivated
  // this produced -2144 MB/h from a 30-second window; UNKNOWN keeps that number
  // out of a gate table where it would read as a measurement.
  test("refuses to project a trend from too short a soak", () => {
    const short = { ...ok, soak_minutes: 1, leak_slope_mb_per_hr: -2144.4 };
    const g = evaluateSoakGates(short).find((x) => x.gate.startsWith("soak_projected"))!;
    expect(g.verdict).toBe("UNKNOWN");
    expect(String(g.value)).toContain(`< ${SOAK_MIN_TREND_MINUTES} min`);
  });

  test("projects once the soak is long enough to fit", () => {
    const long = { ...ok, soak_minutes: SOAK_MIN_TREND_MINUTES };
    const g = evaluateSoakGates(long).find((x) => x.gate.startsWith("soak_projected"))!;
    expect(g.verdict).toBe("ADVISORY");
    expect(typeof g.value).toBe("number");
  });

  // An unfitted projection is absent evidence; an advisory one is measured
  // evidence that does not decide. Collapsing them would hide which is which.
  test("keeps UNKNOWN distinct from ADVISORY", () => {
    const short = { ...ok, soak_minutes: 1 };
    expect(
      evaluateSoakGates(short).find((x) => x.gate.startsWith("soak_projected"))!.verdict,
    ).toBe("UNKNOWN");
  });

  test("fails when typing latency decays by the last cycle", () => {
    const slow = { ...ok, typing_p95_last_cycle_ms: 80 };
    expect(
      evaluateSoakGates(slow).find((g) => g.gate === "soak_typing_p95_last_cycle")!.verdict,
    ).toBe("FAIL");
  });
});

describe("evalSoak", () => {
  function payload(cycles: SoakCycle[]): SinkPayload {
    return {
      candidate: "tauri", fixture: "normal", seed: "s",
      samples: [], coldStartMs: 10, warmStartMs: 5,
      soak: cycles.length
        ? { requestedMs: 1_800_000, actualMs: 1_800_000, cycles, charsTyped: 16_000 }
        : undefined,
    };
  }

  test("returns null for a run that carried no soak", () => {
    expect(evalSoak(payload([]), [], 500_000)).toBeNull();
  });

  test("reads final RSS from the end of the series, not the peak", () => {
    const cycles: SoakCycle[] = [
      { cycle: 1, atMs: 1000, typingP95Ms: 34, charsTyped: 400 },
      { cycle: 2, atMs: 2000, typingP95Ms: 36, charsTyped: 800 },
    ];
    const res = evalSoak(
      payload(cycles),
      series([[0, 700_000], [1000, 600_000], [2000, 580_000]]),
      700_000,
    )!;
    expect(res.metrics.peak_rss_mb).toBe(Math.round(700_000 / 1024));
    expect(res.metrics.final_rss_mb).toBe(Math.round(580_000 / 1024));
    expect(res.metrics.typing_p95_first_cycle_ms).toBe(34);
    expect(res.metrics.typing_p95_last_cycle_ms).toBe(36);
    expect(res.verdicts.length).toBe(3);
  });

  // A cycle cut short by the deadline has a p95 over a handful of samples;
  // gating on it would let run length decide the verdict.
  test("gates on the last complete cycle, not a partial one", () => {
    const cycles: SoakCycle[] = [
      { cycle: 1, atMs: 1000, typingP95Ms: 34, charsTyped: 400 },
      { cycle: 2, atMs: 2000, typingP95Ms: 45, charsTyped: 800 },
      { cycle: 3, atMs: 2100, typingP95Ms: 9, charsTyped: 810, partial: true },
    ];
    const res = evalSoak(payload(cycles), series([[0, 600_000], [2100, 610_000]]), 610_000)!;
    expect(res.metrics.typing_p95_last_cycle_ms).toBe(45);
    expect(res.cycles).toHaveLength(3); // the partial one is still recorded
  });

  // A soak failure is uninterpretable without the shape of the degradation:
  // first/last alone cannot tell a steady climb from a late cliff.
  test("keeps the whole per-cycle series, not just first and last", () => {
    const cycles: SoakCycle[] = [
      { cycle: 1, atMs: 1000, typingP95Ms: 34, charsTyped: 400 },
      { cycle: 2, atMs: 2000, typingP95Ms: 40, charsTyped: 800 },
      { cycle: 3, atMs: 3000, typingP95Ms: 900, charsTyped: 1200 },
    ];
    const res = evalSoak(payload(cycles), series([[0, 600_000], [3000, 610_000]]), 610_000)!;
    expect(res.cycles).toEqual(cycles);
  });
});
