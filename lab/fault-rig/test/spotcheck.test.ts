// lab/fault-rig/test/spotcheck.test.ts
import { describe, expect, test } from "bun:test";
import {
  SPOTCHECK_CASE_NAMES, spotcheckCases, compareVerdicts, buildSpotcheckEvidence,
} from "../src/spotcheck";
import { buildTriggers } from "../src/matrix";
import type { CaseVerdict } from "../src/results";

describe("spotcheckCases", () => {
  // The hedge is only comparable if its case names are the sweep's own. If the
  // matrix renames a case, this must fail rather than quietly shrink the subset.
  test("resolves every name from the real matrix sweep", () => {
    const cases = spotcheckCases(3);
    expect(cases.length).toBe(SPOTCHECK_CASE_NAMES.length);
    const sweep = new Set(buildTriggers(3).map((c) => c.name));
    for (const c of cases) expect(sweep.has(c.name)).toBe(true);
  });

  test("carries the sweep's own triggers, not re-declared ones", () => {
    const byName = new Map(buildTriggers(3).map((c) => [c.name, c]));
    for (const c of spotcheckCases(3)) {
      expect(c.trigger).toEqual(byName.get(c.name)!.trigger);
      expect(c.mutatorIntervalMs).toBe(byName.get(c.name)!.mutatorIntervalMs);
    }
  });

  test("includes both corruption detection cases", () => {
    const names = spotcheckCases(3).map((c) => c.name);
    expect(names).toContain("corrupt@torn");
    expect(names).toContain("corrupt@flip");
  });
});

describe("compareVerdicts", () => {
  const baseline: CaseVerdict[] = [
    { case: "kill@fsync#1", verdict: "NEW_COMPLETE" },
    { case: "corrupt@torn", verdict: "CORRUPT" },
  ];

  test("reports nothing when every verdict matches", () => {
    expect(compareVerdicts(baseline, baseline)).toEqual([]);
  });

  test("reports a changed verdict", () => {
    const candidate: CaseVerdict[] = [
      { case: "kill@fsync#1", verdict: "REGRESSION" },
      { case: "corrupt@torn", verdict: "CORRUPT" },
    ];
    expect(compareVerdicts(baseline, candidate)).toEqual([
      { case: "kill@fsync#1", baseline: "NEW_COMPLETE", candidate: "REGRESSION" },
    ]);
  });

  // An unmatched case proves nothing about binding-independence, so it counts
  // as a divergence instead of being dropped from the agreement tally.
  test("reports a case the baseline never ran", () => {
    const candidate: CaseVerdict[] = [
      { case: "kill@rename#9", verdict: "OLD_INTACT" },
    ];
    expect(compareVerdicts(baseline, candidate)).toEqual([
      { case: "kill@rename#9", baseline: "missing", candidate: "OLD_INTACT" },
    ]);
  });
});

describe("buildSpotcheckEvidence", () => {
  const args = {
    baselineRunId: "sqlite-normal",
    baselineRigCommit: "abc1234",
    readerBinding: "bun:sqlite",
    writerBinding: "rusqlite",
    sqliteVersionReader: "3.53.0",
    sqliteVersionWriter: "3.53.3",
    baseline: [
      { case: "kill@fsync#1", verdict: "NEW_COMPLETE" },
      { case: "corrupt@torn", verdict: "CORRUPT" },
    ] as CaseVerdict[],
  };

  test("counts agreements against the compared cases only", () => {
    const ev = buildSpotcheckEvidence({
      ...args,
      candidate: [
        { case: "kill@fsync#1", verdict: "NEW_COMPLETE" },
        { case: "corrupt@torn", verdict: "OLD_INTACT" },
      ],
    });
    expect(ev.cases_compared).toBe(2);
    expect(ev.agreements).toBe(1);
    expect(ev.divergences.map((d) => d.case)).toEqual(["corrupt@torn"]);
  });

  // The evidence file has to stand alone: a reader must be able to see both
  // sides per case without also holding the baseline JSON.
  test("records both verdicts per case and both SQLite versions", () => {
    const ev = buildSpotcheckEvidence({
      ...args,
      candidate: [{ case: "kill@fsync#1", verdict: "NEW_COMPLETE" }],
    });
    expect(ev.comparison).toEqual([
      { case: "kill@fsync#1", baseline: "NEW_COMPLETE", candidate: "NEW_COMPLETE" },
    ]);
    expect(ev.sqlite_version_reader).toBe("3.53.0");
    expect(ev.sqlite_version_writer).toBe("3.53.3");
  });
});
