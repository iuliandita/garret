// lab/bakeoff/harness/src/report.ts
// Markdown rendered straight from result JSON. Numbers are never hand-edited;
// this is the only path from measurements to prose. Any FAIL gate eliminates a
// stack (spec: "failing a gate irrecoverably on any tested OS is out").
import {
  SOAK_SESSION_HOURS, SOAK_MIN_TREND_MINUTES, projectedSessionRssMb, classify,
  type SoakMetrics,
} from "./gates";
import type { ResultRecord } from "./results";

// Sustained-session memory behavior: the one dimension a short run cannot show.
function renderSoak(records: ResultRecord[]): string[] {
  const soaked = records.filter((r) => r.metrics.soak);
  if (soaked.length === 0) return [];
  const lines = ["", "## Soak (sustained session)", ""];
  lines.push(
    "| candidate | minutes | cycles | chars typed | peak RSS MB | final RSS MB | " +
    `leak slope MB/h | projected ${SOAK_SESSION_HOURS}h RSS MB | typing p95 first -> last ms |`,
  );
  lines.push("|" + "---|".repeat(9));
  for (const rec of soaked) {
    const s = rec.metrics.soak as SoakMetrics;
    // Below the minimum the fit is noise; printing the number anywhere, even
    // beside an UNKNOWN gate, invites it being quoted as a measurement.
    const fitted = s.soak_minutes >= SOAK_MIN_TREND_MINUTES;
    lines.push("| " + [
      rec.candidate,
      String(s.soak_minutes),
      String(s.cycles),
      String(s.chars_typed),
      String(s.peak_rss_mb),
      String(s.final_rss_mb),
      fitted ? s.leak_slope_mb_per_hr.toFixed(1) : "not fitted (soak too short)",
      fitted ? String(projectedSessionRssMb(s)) : "not fitted",
      `${s.typing_p95_first_cycle_ms.toFixed(1)} -> ${s.typing_p95_last_cycle_ms.toFixed(1)}`,
    ].join(" | ") + " |");
  }
  lines.push("");
  lines.push(
    "The soak replays the same seeded script continuously and never undoes the " +
    "typed text, so the document grows the way a real session grows: `chars " +
    "typed` is reported beside the slope precisely because RSS growth is not " +
    "automatically a leak. `leak slope` is a least-squares fit over the sampled " +
    "RSS series with the first 20% dropped as startup allocation. The projection " +
    `carries that slope forward over a ${SOAK_SESSION_HOURS}-hour session and ` +
    "compares it against the spec's existing 750 MB limit — the session length " +
    "is the assumption, the memory threshold is not new. A soak shorter than " +
    `${SOAK_MIN_TREND_MINUTES} minutes reports no slope at all: a fit over a ` +
    "still-settling process is noise, not a trend. The projection is ADVISORY " +
    "and does not eliminate: at 30 minutes the slope is not stable enough to " +
    "multiply by eight (two baseline soaks of the same variant configuration " +
    "fitted 64.2 and 22.3 MB/h). Memory eliminations rest on measured peak RSS, " +
    "not on the projection.",
  );
  return lines;
}

export function renderReport(records: ResultRecord[]): string {
  const lines: string[] = ["# Bake-off results (Track 2)", ""];

  // Verdicts are re-classified here, not just at evaluation time, so results
  // recorded before a gate revision render under the current rule. The value
  // and threshold columns are passed through untouched: a revision changes what
  // a number means, never the number.
  const graded = records.map((rec) => ({
    rec,
    verdicts: rec.verdicts.map(classify),
  }));

  // Per-gate detail table.
  lines.push("| candidate | fixture | gate | value | threshold | verdict |");
  lines.push("|---|---|---|---|---|---|");
  for (const { rec, verdicts } of graded) {
    for (const g of verdicts) {
      lines.push(
        `| ${rec.candidate} | ${rec.fixture} | ${g.gate} | ${g.value} | ` +
          `${g.threshold} | ${g.verdict} |`,
      );
    }
  }
  lines.push("");

  // Elimination summary.
  lines.push("| candidate | fails | unknowns | advisory | outcome |");
  lines.push("|---|---|---|---|---|");
  for (const { rec, verdicts } of graded) {
    const fails = verdicts.filter((g) => g.verdict === "FAIL").length;
    const unknowns = verdicts.filter((g) => g.verdict === "UNKNOWN").length;
    const advisory = verdicts.filter((g) => g.verdict === "ADVISORY").length;
    const outcome = fails > 0 ? "ELIMINATED" : "SURVIVES";
    lines.push(
      `| ${rec.candidate} | ${fails} | ${unknowns} | ${advisory} | ${outcome} |`,
    );
  }
  lines.push(...renderSoak(records));
  lines.push("");
  lines.push(
    "Exit bar: a stack failing any gate irrecoverably on a tested OS is out. " +
      "UNKNOWN gates (probe unavailable, e.g. AT-SPI/pyatspi absent) do not " +
      "eliminate but block promotion until measured. ADVISORY gates are " +
      "recorded and argued with, never decisive. If both survive, the tie " +
      "breaks on variance, memory headroom, and accessibility quality. macOS " +
      "remains an unmeasured gap: no gate promotes to contract without it.",
  );
  return lines.join("\n") + "\n";
}
