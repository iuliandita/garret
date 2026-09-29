// app/harness/test/preflight-gates.test.ts
// The five preflight gates, and the failing direction of each. The two
// numeric gates are exercised AT their boundary and one step past it, with an
// explicit non-zero threshold passed in so the test is about the comparison
// and not about the placeholder constant reading FAIL by design.
import { describe, expect, test } from "bun:test";
import { evaluatePreflightGates, type PreflightMetrics } from "../src/gates";

/** A run where the scan behaved exactly as designed at every step. Every
 *  test below moves ONE field. */
const GREEN: PreflightMetrics = {
  fixture: "tiny",
  vault_absent_exit: 0,
  vault_absent_ok: true,
  vault_absent_check_state: "not_applicable",
  planted_exit_codes: [3, 3, 3, 3, 3],
  planted_blocker_counts: [1, 1, 1, 1, 1],
  planted_item_id: "scene-42",
  planted_finding_item_ids: ["scene-42", "scene-42", "scene-42", "scene-42", "scene-42"],
  planted_name: "Bram Kell",
  planted_finding_matches: ["Bram Kell", "Bram Kell", "Bram Kell", "Bram Kell", "Bram Kell"],
  planted_finding_severities: ["blocker", "blocker", "blocker", "blocker", "blocker"],
  planted_finding_surfaces: ["document_body", "document_body", "document_body", "document_body", "document_body"],
  preflight_ms: 40,
  preflight_rss_mb: 60,
  clean_exit: 0,
  clean_check_state: "ran",
  clean_finding_count: 0,
};

function verdictOf(gate: string, patch: Partial<PreflightMetrics>, ms = 100, rss = 100): string {
  const found = evaluatePreflightGates({ ...GREEN, ...patch }, ms, rss).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate named ${gate}`);
  return found.verdict;
}

test("a run where everything behaved as designed is green on every gate at a real threshold", () => {
  const verdicts = evaluatePreflightGates(GREEN, 100, 100);
  expect(verdicts).toHaveLength(5);
  expect(verdicts.filter((v) => v.verdict !== "PASS")).toEqual([]);
});

test("every gate states a threshold and a value", () => {
  for (const v of evaluatePreflightGates(GREEN, 100, 100)) {
    expect(v.threshold.length).toBeGreaterThan(10);
    expect(String(v.value).length).toBeGreaterThan(0);
  }
});

test("at the module's own constants (filled from the first stress run) the green record passes, and a zero limit is read as unfilled and FAILS", () => {
  const filled = evaluatePreflightGates(GREEN);
  expect(filled.find((v) => v.gate === "preflight_ms")!.verdict).toBe("PASS");
  expect(filled.find((v) => v.gate === "preflight_rss_mb")!.verdict).toBe("PASS");
  const unfilled = evaluatePreflightGates(GREEN, 0, 0);
  expect(unfilled.find((v) => v.gate === "preflight_ms")!.verdict).toBe("FAIL");
  expect(unfilled.find((v) => v.gate === "preflight_rss_mb")!.verdict).toBe("FAIL");
});

describe("preflight_not_applicable_without_vault", () => {
  test("fails when the run did not exit 0", () => {
    expect(verdictOf("preflight_not_applicable_without_vault", { vault_absent_exit: 3 })).toBe("FAIL");
  });
  test("fails when the run reports ok false", () => {
    expect(verdictOf("preflight_not_applicable_without_vault", { vault_absent_ok: false })).toBe("FAIL");
  });
  test("RED when the check state is `ran` instead of `not_applicable`", () => {
    expect(verdictOf("preflight_not_applicable_without_vault", { vault_absent_check_state: "ran" })).toBe(
      "FAIL",
    );
  });
});

describe("preflight_finds_the_planted_name", () => {
  test("fails when one of the five runs does not exit 3", () => {
    expect(verdictOf("preflight_finds_the_planted_name", { planted_exit_codes: [3, 3, 0, 3, 3] })).toBe(
      "FAIL",
    );
  });
  test("RED on zero blockers", () => {
    expect(
      verdictOf("preflight_finds_the_planted_name", { planted_blocker_counts: [1, 1, 0, 1, 1] }),
    ).toBe("FAIL");
  });
  test("fails when a run reports more than one blocker", () => {
    expect(
      verdictOf("preflight_finds_the_planted_name", { planted_blocker_counts: [1, 1, 2, 1, 1] }),
    ).toBe("FAIL");
  });
  test("RED on a wrong item id", () => {
    expect(
      verdictOf("preflight_finds_the_planted_name", {
        planted_finding_item_ids: ["scene-42", "scene-42", "scene-99", "scene-42", "scene-42"],
      }),
    ).toBe("FAIL");
  });
  test("fails when the matched spelling differs from the planted name", () => {
    expect(
      verdictOf("preflight_finds_the_planted_name", {
        planted_finding_matches: ["Bram Kell", "Bram Kell", "bram kell", "Bram Kell", "Bram Kell"],
      }),
    ).toBe("FAIL");
  });
  test("fails when a run reports the wrong severity", () => {
    expect(
      verdictOf("preflight_finds_the_planted_name", {
        planted_finding_severities: ["blocker", "blocker", "advisory", "blocker", "blocker"],
      }),
    ).toBe("FAIL");
  });
  test("fails when a run reports the wrong surface", () => {
    expect(
      verdictOf("preflight_finds_the_planted_name", {
        planted_finding_surfaces: ["document_body", "document_body", "meta", "document_body", "document_body"],
      }),
    ).toBe("FAIL");
  });
});

describe("preflight_ms", () => {
  test("PASSES exactly at the threshold", () => {
    expect(verdictOf("preflight_ms", { preflight_ms: 100 }, 100, 100)).toBe("PASS");
  });
  test("PASSES one step under the threshold", () => {
    expect(verdictOf("preflight_ms", { preflight_ms: 99 }, 100, 100)).toBe("PASS");
  });
  test("FAILS one step over the threshold", () => {
    expect(verdictOf("preflight_ms", { preflight_ms: 101 }, 100, 100)).toBe("FAIL");
  });
  test("FAILS at the unfilled placeholder even when the measured figure is tiny", () => {
    expect(verdictOf("preflight_ms", { preflight_ms: 1 }, 0, 100)).toBe("FAIL");
  });
});

describe("preflight_rss_mb", () => {
  test("PASSES exactly at the threshold", () => {
    expect(verdictOf("preflight_rss_mb", { preflight_rss_mb: 100 }, 100, 100)).toBe("PASS");
  });
  test("PASSES one step under the threshold", () => {
    expect(verdictOf("preflight_rss_mb", { preflight_rss_mb: 99 }, 100, 100)).toBe("PASS");
  });
  test("FAILS one step over the threshold", () => {
    expect(verdictOf("preflight_rss_mb", { preflight_rss_mb: 101 }, 100, 100)).toBe("FAIL");
  });
  test("FAILS at the unfilled placeholder even when the measured figure is tiny", () => {
    expect(verdictOf("preflight_rss_mb", { preflight_rss_mb: 1 }, 100, 0)).toBe("FAIL");
  });
  test("FAILS at 0 MB against a real threshold: a zero reading is no sample, not a clean peak", () => {
    expect(verdictOf("preflight_rss_mb", { preflight_rss_mb: 0 }, 100, 100)).toBe("FAIL");
  });
});

describe("preflight_clean_when_the_name_is_gone", () => {
  test("fails when the run did not exit 0", () => {
    expect(verdictOf("preflight_clean_when_the_name_is_gone", { clean_exit: 3 })).toBe("FAIL");
  });
  test("RED when the check state is `vacuous` instead of `ran`", () => {
    expect(verdictOf("preflight_clean_when_the_name_is_gone", { clean_check_state: "vacuous" })).toBe(
      "FAIL",
    );
  });
  test("fails when a finding of the kind is still reported", () => {
    expect(verdictOf("preflight_clean_when_the_name_is_gone", { clean_finding_count: 1 })).toBe("FAIL");
  });
});
