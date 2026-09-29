import { describe, expect, test } from "bun:test";

import { evaluateGoalsGates, type GoalsMetrics } from "../src/gates";

// Written because the recorded gap is real and repeats: `evaluateFindGates` had
// no unit tests at all when it shipped, five gates in the older `evaluateGates`
// had untested boundaries, and `evaluatePrefsGates` and `evaluateWindowGates`
// still have none. A gate evaluator nobody tests is an instrument nobody can
// falsify, which is the shape this project has been caught by seven times.

/** Everything PASSing, so each test below moves exactly one figure. */
const OK: GoalsMetrics = {
  typed_words: 108,
  today_before: 0,
  today_after: 108,
  today_after_restart: 108,
  ledger_today_before: 0,
  ledger_today_after: 108,
  ledger_today_after_restart: 108,
  today_after_rollover: 0,
  ledger_today_after_rollover: 0,
  ledger_yesterday_after_rollover: 108,
  typing_before_rollover: 108,
  chosen_target: "500",
  recorded_target: "500",
  target_in_bar: "500",
  readout_h: 21,
  control_h: 24,
  today_in_text: "108/500",
  today_in_name: "108/500",
  peak_rss_mb: 400,
};

const verdictOf = (m: GoalsMetrics, gate: string): string => {
  const found = evaluateGoalsGates(m).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate ${gate}`);
  return found.verdict;
};

describe("the goals gates", () => {
  test("a healthy run passes every gate", () => {
    // The control. Without it, a gate that FAILed unconditionally would satisfy
    // every failing-direction test below.
    expect(evaluateGoalsGates(OK).every((v) => v.verdict === "PASS")).toBe(true);
  });

  test("the gate list is fixed and named", () => {
    expect(evaluateGoalsGates(OK).map((v) => v.gate)).toEqual([
      "goal_today_counts_new_words",
      "goal_today_survives_a_restart",
      "goal_new_day_resets",
      "goal_target_persists_and_renders",
      "goal_bar_stays_one_line",
      "a11y_progress_agrees",
      "peak_rss_mb",
    ]);
  });
});

describe("goal_today_counts_new_words", () => {
  test("a figure that moved by the wrong amount fails, by ONE word", () => {
    // At the boundary. A test that moved it by a hundred would be checking the
    // arithmetic rather than the comparison.
    expect(verdictOf({ ...OK, today_after: 107 }, "goal_today_counts_new_words")).toBe("FAIL");
    expect(verdictOf({ ...OK, today_after: 109 }, "goal_today_counts_new_words")).toBe("FAIL");
  });

  test("a figure that never moved at all fails", () => {
    expect(verdictOf({ ...OK, today_after: 0 }, "goal_today_counts_new_words")).toBe("FAIL");
  });

  test("the MOVEMENT is graded, not the figure", () => {
    // A day that already had words in it before the rig typed. The gate must
    // still pass, or it would only ever be true on the first run of a day.
    expect(
      verdictOf(
        {
          ...OK,
          today_before: 900,
          today_after: 1_008,
          ledger_today_before: 900,
          ledger_today_after: 1_008,
        },
        "goal_today_counts_new_words",
      ),
    ).toBe("PASS");
  });

  test("a day spent cutting is graded the same way", () => {
    expect(
      verdictOf(
        {
          ...OK,
          typed_words: -40,
          today_before: 900,
          today_after: 860,
          ledger_today_before: 900,
          ledger_today_after: 860,
        },
        "goal_today_counts_new_words",
      ),
    ).toBe("PASS");
  });

  test("a ledger movement one word away from the manuscript fails", () => {
    expect(
      verdictOf({ ...OK, ledger_today_after: 107 }, "goal_today_counts_new_words"),
    ).toBe("FAIL");
  });
});

describe("goal_today_survives_a_restart", () => {
  test("a figure that came back one word short fails", () => {
    expect(verdictOf({ ...OK, today_after_restart: 107 }, "goal_today_survives_a_restart")).toBe(
      "FAIL",
    );
  });

  test("a figure that came back at zero fails", () => {
    // What a lost source ledger looks like: the reopened application reports a
    // day with nothing in it.
    expect(verdictOf({ ...OK, today_after_restart: 0 }, "goal_today_survives_a_restart")).toBe(
      "FAIL",
    );
  });

  test("a ledger that came back one word short fails", () => {
    expect(
      verdictOf(
        { ...OK, ledger_today_after_restart: 107 },
        "goal_today_survives_a_restart",
      ),
    ).toBe("FAIL");
  });
});

describe("goal_new_day_resets", () => {
  test("all three halves are required", () => {
    // The page did not reset.
    expect(verdictOf({ ...OK, today_after_rollover: 12 }, "goal_new_day_resets")).toBe("FAIL");
    // The current ledger bucket did not disappear.
    expect(
      verdictOf({ ...OK, ledger_today_after_rollover: 12 }, "goal_new_day_resets"),
    ).toBe("FAIL");
    // Moving the bucket lost yesterday's contribution.
    expect(
      verdictOf({ ...OK, ledger_yesterday_after_rollover: 0 }, "goal_new_day_resets"),
    ).toBe("FAIL");
  });

  test("a preserved contribution one word off fails", () => {
    expect(
      verdictOf({ ...OK, ledger_yesterday_after_rollover: 107 }, "goal_new_day_resets"),
    ).toBe("FAIL");
  });
});

describe("goal_target_persists_and_renders", () => {
  test("a target that reached the file but not the bar fails", () => {
    expect(
      verdictOf({ ...OK, target_in_bar: "off" }, "goal_target_persists_and_renders"),
    ).toBe("FAIL");
  });

  test("a target that reached the bar but not the file fails", () => {
    // Both halves, because a page that applied the click in this window and
    // never wrote it would render correctly and forget by the next launch.
    expect(
      verdictOf({ ...OK, recorded_target: "off" }, "goal_target_persists_and_renders"),
    ).toBe("FAIL");
  });

  test("an absent readout fails rather than reading as off", () => {
    expect(
      verdictOf({ ...OK, target_in_bar: "ABSENT" }, "goal_target_persists_and_renders"),
    ).toBe("FAIL");
  });
});

describe("goal_bar_stays_one_line", () => {
  test("a readout exactly as tall as the control passes", () => {
    // The boundary, and it is on the passing side deliberately: the control is a
    // button with padding and a border, so a single-line readout is normally
    // SHORTER. Equal is still one line.
    expect(verdictOf({ ...OK, readout_h: 24, control_h: 24 }, "goal_bar_stays_one_line")).toBe(
      "PASS",
    );
  });

  test("one pixel taller than the control fails", () => {
    expect(verdictOf({ ...OK, readout_h: 25, control_h: 24 }, "goal_bar_stays_one_line")).toBe(
      "FAIL",
    );
  });

  test("a wrapped readout fails", () => {
    expect(verdictOf({ ...OK, readout_h: 42, control_h: 24 }, "goal_bar_stays_one_line")).toBe(
      "FAIL",
    );
  });

  test("a readout with no height at all fails rather than passing trivially", () => {
    // 0 <= anything. Without the explicit floor, a node the probe could not
    // measure would be the healthiest possible reading.
    expect(verdictOf({ ...OK, readout_h: 0 }, "goal_bar_stays_one_line")).toBe("FAIL");
  });
});

describe("a11y_progress_agrees", () => {
  test("a lost thousands separator is a disagreement, not a rounding", () => {
    // Compared AS WRITTEN. One channel formatting 1,400 and the other 1400 is
    // two renderings drifting, which is the whole thing this gate exists for.
    expect(
      verdictOf({ ...OK, today_in_text: "1,400/500", today_in_name: "1400/500" }, "a11y_progress_agrees"),
    ).toBe("FAIL");
  });

  test("a sign that reached only one channel fails", () => {
    // The bar draws U+2212 and the name says "cut". Two ways of saying the same
    // thing, and a build that lost one of them is a build that tells a screen
    // reader a day of cutting was a day of writing.
    expect(
      verdictOf({ ...OK, today_in_text: "-900/500", today_in_name: "900/500" }, "a11y_progress_agrees"),
    ).toBe("FAIL");
  });

  test("a target that reached only one channel fails", () => {
    expect(
      verdictOf({ ...OK, today_in_name: "108/off" }, "a11y_progress_agrees"),
    ).toBe("FAIL");
  });

  test("a figure present in one channel and absent from the other fails", () => {
    expect(verdictOf({ ...OK, today_in_name: null }, "a11y_progress_agrees")).toBe("FAIL");
    expect(verdictOf({ ...OK, today_in_text: null }, "a11y_progress_agrees")).toBe("FAIL");
  });

  test("both absent fails rather than agreeing", () => {
    // null === null is true, which would have made a readout that reached
    // NEITHER channel the strongest possible pass.
    expect(
      verdictOf({ ...OK, today_in_text: null, today_in_name: null }, "a11y_progress_agrees"),
    ).toBe("FAIL");
  });
});
