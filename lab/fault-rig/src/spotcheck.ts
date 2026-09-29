// lab/fault-rig/src/spotcheck.ts
// The Q3 hedge: re-run the worst fault cases against a second SQLite binding
// (rusqlite) and check the verdicts are identical. This is NOT a re-run of Q3 —
// it cannot re-decide the encoding, and it measures no latency. Its only claim
// is binding-independence, so a divergence is the finding.
import { buildTriggers, type MatrixCase } from "./matrix";
import type { CaseVerdict } from "./results";
import type { Verdict } from "./model";

// The 11 worst cases from the full sweep (the spec says ~10): kills at the
// three markers where a
// commit is actually in flight (begin-txn is excluded — nothing is durable yet),
// the same kills under cloud-sync interference (A4), and both offline
// corruption cases, which are the only ones that assert detection rather than
// survival. Names must match the full sweep exactly so verdicts are comparable.
export const SPOTCHECK_CASE_NAMES = [
  "kill@fsync#1",
  "kill@fsync#2",
  "kill@fsync#3",
  "kill@rename#1",
  "kill@rename#2",
  "kill@rename#3",
  "kill@commit-done#1",
  "mutator+kill@fsync#1",
  "mutator+kill@rename#1",
  "corrupt@torn",
  "corrupt@flip",
] as const;

// Resolved from the real sweep rather than re-declared, so a matrix change that
// renames or drops a case fails here instead of silently shrinking the hedge.
// `reps` only adds random-delay cases, and the subset contains none, so the
// default of 0 is not a narrowing — the selection is rep-independent.
export function spotcheckCases(reps = 0): MatrixCase[] {
  const all = buildTriggers(reps);
  return SPOTCHECK_CASE_NAMES.map((name) => {
    const found = all.find((c) => c.name === name);
    if (!found) {
      throw new Error(
        `spot-check case "${name}" no longer exists in the matrix sweep`,
      );
    }
    return found;
  });
}

export interface VerdictDiff {
  case: string;
  baseline: Verdict | "missing";
  candidate: Verdict;
}

// Compare candidate verdicts against the recorded bun:sqlite run. A case the
// baseline never ran is a divergence too: an unmatched case proves nothing, and
// silently dropping it would inflate the agreement count.
export function compareVerdicts(
  baseline: CaseVerdict[],
  candidate: CaseVerdict[],
): VerdictDiff[] {
  const byCase = new Map(baseline.map((v) => [v.case, v.verdict]));
  const diffs: VerdictDiff[] = [];
  for (const cv of candidate) {
    const base = byCase.get(cv.case);
    if (base === undefined) {
      diffs.push({ case: cv.case, baseline: "missing", candidate: cv.verdict });
    } else if (base !== cv.verdict) {
      diffs.push({ case: cv.case, baseline: base, candidate: cv.verdict });
    }
  }
  return diffs;
}

export interface SpotcheckEvidence {
  baseline_run_id: string;
  baseline_rig_commit: string;
  // Which SQLite each side actually linked: a version gap would explain a
  // divergence without implicating either binding.
  reader_binding: string;
  writer_binding: string;
  sqlite_version_reader: string;
  sqlite_version_writer: string;
  cases_compared: number;
  agreements: number;
  divergences: VerdictDiff[];
  // Per-case detail, so the evidence stands alone without the baseline file.
  comparison: { case: string; baseline: Verdict | "missing"; candidate: Verdict }[];
}

export function buildSpotcheckEvidence(
  args: {
    baselineRunId: string;
    baselineRigCommit: string;
    readerBinding: string;
    writerBinding: string;
    sqliteVersionReader: string;
    sqliteVersionWriter: string;
    baseline: CaseVerdict[];
    candidate: CaseVerdict[];
  },
): SpotcheckEvidence {
  const byCase = new Map(args.baseline.map((v) => [v.case, v.verdict]));
  const comparison = args.candidate.map((cv) => ({
    case: cv.case,
    baseline: byCase.get(cv.case) ?? ("missing" as const),
    candidate: cv.verdict,
  }));
  const divergences = compareVerdicts(args.baseline, args.candidate);
  return {
    baseline_run_id: args.baselineRunId,
    baseline_rig_commit: args.baselineRigCommit,
    reader_binding: args.readerBinding,
    writer_binding: args.writerBinding,
    sqlite_version_reader: args.sqliteVersionReader,
    sqlite_version_writer: args.sqliteVersionWriter,
    cases_compared: comparison.length,
    agreements: comparison.length - divergences.length,
    divergences,
    comparison,
  };
}
