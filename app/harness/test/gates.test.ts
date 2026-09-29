import { describe, expect, test } from "bun:test";
import {
  HIER_THRESHOLDS,
  OUTLINE_THRESHOLDS,
  PERSIST_THRESHOLDS,
  SLOW_FRAME_MS,
  THRESHOLDS,
  cliffRatio,
  evaluateDocxImportGates,
  evaluateExportGates,
  evaluateFindGates,
  evaluateGates,
  evaluateHierGates,
  evaluateOutlineGates,
  evaluatePersistGates,
  evaluateFirstRunGates,
  evaluateHomeGates,
  evaluateProjectGates,
  evaluateSwitchGates,
  evaluateTimelineGates,
  evaluateWordsGates,
  stallRate,
  TIMELINE_VISIBLE_DOM_BOUND,
  TIMELINE_ZOOM_P95_MS,
  type Distribution,
  type DocxImportMetrics,
  type ExportMetrics,
  type FindMetrics,
  type GateResult,
  type GateVerdict,
  type HierMetrics,
  type Metrics,
  type OutlineMetrics,
  type PersistMetrics,
  type ProjectMetrics,
  type FirstRunMetrics,
  type HomeMetrics,
  type SwitchMetrics,
  type TimelineMetrics,
  type WordsMetrics,
  WORDS_THRESHOLDS,
  EXPORT_THRESHOLDS,
} from "../src/gates";
import { COMMIT_POLL_MS, WATCH_POLL_MS, scanFloorMs } from "../src/words-floor";

const okDistribution = (count: number, stalls = 0, slowFrames = 0): Distribution => ({
  count,
  dispatch: { p50: 1, p95: 2, p99: 3 },
  frame: { p50: 33, p95: 34, p99: 34 },
  stalls,
  slowFrames,
  histogram: { "<20": 0, "20-40": count, "40-100": 0, "100-500": 0, "500-2000": 0, ">=2000": 0 },
});

const ok: Metrics = {
  peak_rss_mb: 500,
  typing_p95_ms: 33,
  typing_p99_ms: 40,
  nav_p95_ms: 30,
  typing: okDistribution(1000),
  nav: okDistribution(150),
  cycles: [
    { cycle: 1, atMs: 0, typingP95Ms: 33, charsTyped: 400, partial: false },
    { cycle: 2, atMs: 1000, typingP95Ms: 33, charsTyped: 800, partial: false },
  ],
  rows: 15_200,
  a11y: { available: true, hasNavigator: true, exposedRows: 15_200, mountedRows: 40, treeRows: [] },
};

describe("thresholds", () => {
  test("match the specification", () => {
    expect(THRESHOLDS.typing_p95_ms).toBe(50);
    expect(THRESHOLDS.typing_p99_ms).toBe(100);
    expect(THRESHOLDS.nav_p95_ms).toBe(150);
    expect(THRESHOLDS.peak_rss_mb).toBe(750);
    expect(THRESHOLDS.typing_stall_rate).toBe(0.01);
    expect(SLOW_FRAME_MS).toBe(100);
  });
});

const verdictOf = (m: Metrics, gate: string): string =>
  evaluateGates(m).find((g) => g.gate === gate)!.verdict;

describe("evaluateGates", () => {
  test("passes a healthy run on every gate except the trend, which needs more cycles", () => {
    for (const g of evaluateGates(ok)) {
      expect(g.verdict).toBe(g.gate === "no_typing_cliff" ? "UNKNOWN" : "PASS");
    }
  });

  test("fails typing p95 at the threshold", () => {
    expect(verdictOf({ ...ok, typing_p95_ms: 50 }, "typing_p95_ms")).toBe("FAIL");
  });

  test("fails memory at the hard threshold", () => {
    expect(verdictOf({ ...ok, peak_rss_mb: 913 }, "peak_rss_mb")).toBe("FAIL");
  });

  // THE BOUNDARY, not a number far past it. 913 is Electron's measured peak and
  // it FAILs whether the comparison is `<` or `<=`, so the gate's own edge was
  // untested for the life of the harness: a predicate widened by one value would
  // have recorded a PASS at exactly the spec's hard number. Every `<` gate below
  // gets the same pair, because "fails somewhere above the line" is not the
  // claim any of them make.
  test("memory FAILs AT the threshold and PASSes one below it", () => {
    expect(verdictOf({ ...ok, peak_rss_mb: THRESHOLDS.peak_rss_mb }, "peak_rss_mb")).toBe("FAIL");
    expect(verdictOf({ ...ok, peak_rss_mb: THRESHOLDS.peak_rss_mb - 1 }, "peak_rss_mb")).toBe(
      "PASS",
    );
  });

  test("typing p95 PASSes one below the threshold it fails at", () => {
    expect(verdictOf({ ...ok, typing_p95_ms: THRESHOLDS.typing_p95_ms - 1 }, "typing_p95_ms")).toBe(
      "PASS",
    );
  });

  test("typing p99 FAILs AT the threshold and PASSes one below it", () => {
    expect(verdictOf({ ...ok, typing_p99_ms: THRESHOLDS.typing_p99_ms }, "typing_p99_ms")).toBe(
      "FAIL",
    );
    expect(verdictOf({ ...ok, typing_p99_ms: THRESHOLDS.typing_p99_ms - 1 }, "typing_p99_ms")).toBe(
      "PASS",
    );
  });

  test("nav p95 FAILs AT the threshold and PASSes one below it", () => {
    expect(verdictOf({ ...ok, nav_p95_ms: THRESHOLDS.nav_p95_ms }, "nav_p95_ms")).toBe("FAIL");
    expect(verdictOf({ ...ok, nav_p95_ms: THRESHOLDS.nav_p95_ms - 1 }, "nav_p95_ms")).toBe("PASS");
  });

  test("exposure PASSES only when the advertised count equals the full row count", () => {
    expect(verdictOf(ok, "a11y_exposure")).toBe("PASS");
  });

  test("exposure FAILS when only the mounted window is advertised", () => {
    const capped: Metrics = {
      ...ok,
      a11y: { available: true, hasNavigator: true, exposedRows: 40, mountedRows: 40, treeRows: [] },
    };
    expect(verdictOf(capped, "a11y_exposure")).toBe("FAIL");
  });

  // A tree advertises per-sibling-group setsize, so no row advertises the total.
  // FAIL here would mean "the tree is correct"; PASS would mean "nothing was
  // checked". Both are the failure modes this repo keeps getting bitten by.
  test("exposure is UNKNOWN on a tree run, not a FAIL that means the tree is correct", () => {
    const tree: Metrics = {
      ...ok,
      a11y: {
        available: true,
        hasNavigator: true,
        exposedRows: 0,
        mountedRows: 36,
        treeRows: [
          { id: "nav-row-0", name: "Part One", level: 1, setsize: 4, posinset: 1, expanded: true },
          { id: "nav-row-1", name: "Ch A", level: 2, setsize: 9, posinset: 1, expanded: false },
        ],
      },
    };
    const g = evaluateGates(tree).find((x) => x.gate === "a11y_exposure")!;
    expect(g.verdict).toBe("UNKNOWN");
    expect(String(g.value)).toContain("a11y_tree_structure");
  });

  // Committed evidence from the navigator and persistence slices predates
  // treeRows entirely; re-reading it must not re-verdict it.
  test("a recorded flat-list probe with no treeRows field still verdicts as before", () => {
    const legacy = {
      ...ok,
      a11y: { available: true, hasNavigator: true, exposedRows: 15_200, mountedRows: 40 },
    } as Metrics;
    expect(verdictOf(legacy, "a11y_exposure")).toBe("PASS");
  });

  test("an unavailable probe is UNKNOWN, never PASS", () => {
    const blind: Metrics = {
      ...ok,
      a11y: { available: false, hasNavigator: false, exposedRows: 0, mountedRows: 0, treeRows: [] },
    };
    expect(verdictOf(blind, "a11y_exposure")).toBe("UNKNOWN");
  });

  test("a cliff across the run FAILS even when the aggregate p95 passes", () => {
    const cliff: Metrics = {
      ...ok,
      typing_p95_ms: 45, // aggregate still under the threshold
      cycles: [
        ...Array.from({ length: 20 }, (_, i) => ({
          cycle: i + 1, atMs: i * 1000, typingP95Ms: 33, charsTyped: 400 * (i + 1), partial: false,
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          cycle: i + 21, atMs: (i + 20) * 1000, typingP95Ms: 900, charsTyped: 400 * (i + 21), partial: false,
        })),
      ],
    };
    expect(verdictOf(cliff, "no_typing_cliff")).toBe("FAIL");
  });

  test("a flat run across many cycles PASSES the trend", () => {
    const flat: Metrics = {
      ...ok,
      cycles: Array.from({ length: 40 }, (_, i) => ({
        cycle: i + 1, atMs: i * 1000, typingP95Ms: 33, charsTyped: 400 * (i + 1), partial: false,
      })),
    };
    expect(verdictOf(flat, "no_typing_cliff")).toBe("PASS");
  });

  test("too few cycles to judge a trend is UNKNOWN, not a pass", () => {
    expect(verdictOf({ ...ok, cycles: ok.cycles.slice(0, 1) }, "no_typing_cliff")).toBe("UNKNOWN");
  });

  // The cliff cases above run at ratio ~27 and ~1, which leaves the edge
  // untested exactly as peak_rss_mb's did. 20 cycles puts the decile at 2, so
  // the first two and last two cycles are the whole comparison.
  test("the cliff FAILs AT the ratio and PASSes just under it", () => {
    const withDeciles = (head: number, tail: number): Metrics => ({
      ...ok,
      cycles: Array.from({ length: 20 }, (_, i) => ({
        cycle: i + 1,
        atMs: i * 1000,
        typingP95Ms: i < 2 ? head : i >= 18 ? tail : head,
        charsTyped: 400 * (i + 1),
        partial: false,
      })),
    });
    expect(cliffRatio(withDeciles(10, 15).cycles.map((c) => c.typingP95Ms))).toBeCloseTo(
      THRESHOLDS.cliff_ratio,
      5,
    );
    expect(verdictOf(withDeciles(10, 15), "no_typing_cliff")).toBe("FAIL");
    expect(verdictOf(withDeciles(10, 14.9), "no_typing_cliff")).toBe("PASS");
  });
});

describe("typing_stall_rate gate", () => {
  test("5 slow frames in 1000 samples passes", () => {
    const m: Metrics = { ...ok, typing: okDistribution(1000, 0, 5) };
    expect(verdictOf(m, "typing_stall_rate")).toBe("PASS");
  });

  test("50 slow frames in 1000 samples fails", () => {
    const m: Metrics = { ...ok, typing: okDistribution(1000, 0, 50) };
    expect(verdictOf(m, "typing_stall_rate")).toBe("FAIL");
  });

  test("stalls count toward the rate the same as slow frames", () => {
    const m: Metrics = { ...ok, typing: okDistribution(1000, 50, 0) };
    expect(verdictOf(m, "typing_stall_rate")).toBe("FAIL");
  });

  test("a zero-sample distribution is UNKNOWN, never PASS", () => {
    const m: Metrics = { ...ok, typing: okDistribution(0) };
    expect(verdictOf(m, "typing_stall_rate")).toBe("UNKNOWN");
  });

  // 5 and 50 in 1000 are 0.005 and 0.05 -- both far off 0.01, so the rate's own
  // edge was untested. 10 in 1000 is the threshold exactly.
  test("the rate FAILs AT the threshold and PASSes one sample below it", () => {
    const at = THRESHOLDS.typing_stall_rate * 1000;
    expect(verdictOf({ ...ok, typing: okDistribution(1000, 0, at) }, "typing_stall_rate")).toBe(
      "FAIL",
    );
    expect(verdictOf({ ...ok, typing: okDistribution(1000, 0, at - 1) }, "typing_stall_rate")).toBe(
      "PASS",
    );
  });
});

describe("stallRate", () => {
  test("computes (stalls + slowFrames) / count", () => {
    expect(stallRate(okDistribution(100, 1, 2))).toBeCloseTo(0.03, 5);
  });

  test("zero samples is NaN, not a fabricated 0", () => {
    expect(Number.isNaN(stallRate(okDistribution(0)))).toBe(true);
  });
});

describe("cliffRatio", () => {
  test("a flat series is ratio 1", () => {
    expect(cliffRatio([10, 10, 10, 10, 10, 10, 10, 10, 10, 10])).toBeCloseTo(1, 5);
  });

  test("a degrading series exceeds 1 in proportion to the degradation", () => {
    expect(cliffRatio([10, 10, 10, 10, 10, 20, 20, 20, 20, 20])).toBeCloseTo(2, 5);
  });

  test("fewer than the minimum cycles yields NaN rather than a fabricated ratio", () => {
    expect(Number.isNaN(cliffRatio([10]))).toBe(true);
  });
});

describe("partial cycles", () => {
  const flat = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      cycle: i + 1, atMs: i * 1000, typingP95Ms: 34, charsTyped: 400 * (i + 1), partial: false,
    }));

  test("a truncated final cycle does not create a cliff that is not there", () => {
    const cycles = [
      ...flat(39),
      { cycle: 40, atMs: 39_000, typingP95Ms: 1001, charsTyped: 15_610, partial: true },
    ];
    const m: Metrics = { ...ok, cycles };
    expect(evaluateGates(m).find((g) => g.gate === "no_typing_cliff")!.verdict).toBe("PASS");
  });

  test("a real cliff in COMPLETE cycles is still caught", () => {
    const cycles = [
      ...flat(20),
      ...Array.from({ length: 20 }, (_, i) => ({
        cycle: i + 21, atMs: (i + 20) * 1000, typingP95Ms: 900, charsTyped: 0, partial: false,
      })),
      { cycle: 41, atMs: 41_000, typingP95Ms: 1001, charsTyped: 0, partial: true },
    ];
    const m: Metrics = { ...ok, cycles };
    expect(evaluateGates(m).find((g) => g.gate === "no_typing_cliff")!.verdict).toBe("FAIL");
  });

  test("when too few COMPLETE cycles remain, the trend is UNKNOWN rather than judged", () => {
    const cycles = [
      ...flat(5),
      ...Array.from({ length: 30 }, (_, i) => ({
        cycle: i + 6, atMs: 0, typingP95Ms: 34, charsTyped: 0, partial: true,
      })),
    ];
    const m: Metrics = { ...ok, cycles };
    expect(evaluateGates(m).find((g) => g.gate === "no_typing_cliff")!.verdict).toBe("UNKNOWN");
  });
});

const okPersist: PersistMetrics = {
  restart_body_match: true,
  body_diverged_from_seed: true,
  flush_count: 42,
  flush_conflicts: 0,
  flush_errors: 0,
  flush_p50_ms: 1,
  flush_p95_ms: 4,
};

describe("persistence gates", () => {
  test("thresholds match the specification", () => {
    expect(PERSIST_THRESHOLDS.flush_p95_ms).toBe(50);
    expect(PERSIST_THRESHOLDS.flush_conflicts).toBe(0);
  });

  test("a healthy run passes every persistence gate", () => {
    for (const g of evaluatePersistGates(okPersist)) expect(g.verdict).toBe("PASS");
  });

  test("a body that did not survive the restart fails", () => {
    const g = evaluatePersistGates({ ...okPersist, restart_body_match: false });
    expect(g.find((x) => x.gate === "restart_body_match")?.verdict).toBe("FAIL");
  });

  test("any conflict fails", () => {
    const g = evaluatePersistGates({ ...okPersist, flush_conflicts: 1 });
    expect(g.find((x) => x.gate === "flush_conflicts")?.verdict).toBe("FAIL");
  });

  test("any flush error fails", () => {
    const g = evaluatePersistGates({ ...okPersist, flush_errors: 1 });
    expect(g.find((x) => x.gate === "flush_errors")?.verdict).toBe("FAIL");
  });

  test("a run with no flushes reports UNKNOWN, never PASS", () => {
    const g = evaluatePersistGates({ ...okPersist, flush_count: 0 });
    expect(g.find((x) => x.gate === "flush_p95_ms")?.verdict).toBe("UNKNOWN");
  });
});

const okMetrics = (): HierMetrics => ({
  tree_shape_match: true,
  tree_changed: true,
  store_nodes: 40,
  exposed_nodes: 40,
  level_mismatches: 0,
  setsize_mismatches: 0,
  probed_rows: 72,
  mutations: 180,
  mutation_errors: 0,
  mutation_p50_ms: 3,
  mutation_p95_ms: 9,
});

describe("hierarchy gates", () => {
  test("thresholds match the specification", () => {
    expect(HIER_THRESHOLDS.mutation_p95_ms).toBe(50);
  });

  test("a clean hierarchy run passes every gate", () => {
    expect(evaluateHierGates(okMetrics()).every((v) => v.verdict === "PASS")).toBe(true);
  });

  test("mutation_p95_ms over zero mutations is UNKNOWN, never PASS", () => {
    const g = evaluateHierGates({ ...okMetrics(), mutations: 0, mutation_p95_ms: 0 });
    expect(g.find((v) => v.gate === "mutation_p95_ms")!.verdict).toBe("UNKNOWN");
  });

  test("one wrong aria-level fails the structural gate", () => {
    const g = evaluateHierGates({ ...okMetrics(), level_mismatches: 1 });
    expect(g.find((v) => v.gate === "a11y_tree_structure")!.verdict).toBe("FAIL");
  });

  test("a tree exposing the right count with wrong setsize still fails", () => {
    const g = evaluateHierGates({ ...okMetrics(), setsize_mismatches: 2 });
    expect(g.find((v) => v.gate === "a11y_tree_structure")!.verdict).toBe("FAIL");
  });

  test("zero probed rows is UNKNOWN: nothing was checked", () => {
    const g = evaluateHierGates({ ...okMetrics(), probed_rows: 0 });
    expect(g.find((v) => v.gate === "a11y_tree_structure")!.verdict).toBe("UNKNOWN");
  });

  test("a restart that lost the tree shape fails", () => {
    const g = evaluateHierGates({ ...okMetrics(), tree_shape_match: false });
    expect(g.find((v) => v.gate === "tree_shape_match")!.verdict).toBe("FAIL");
  });

  test("a node count short of the store fails even with no attribute mismatches", () => {
    const g = evaluateHierGates({ ...okMetrics(), exposed_nodes: 36 });
    expect(g.find((v) => v.gate === "a11y_tree_structure")!.verdict).toBe("FAIL");
  });

  test("any mutation error fails", () => {
    const g = evaluateHierGates({ ...okMetrics(), mutation_errors: 1 });
    expect(g.find((v) => v.gate === "mutation_errors")!.verdict).toBe("FAIL");
  });

  test("mutation p95 fails at the threshold, not above it", () => {
    const g = evaluateHierGates({ ...okMetrics(), mutation_p95_ms: 50 });
    expect(g.find((v) => v.gate === "mutation_p95_ms")!.verdict).toBe("FAIL");
  });

  // The window is ~36 rows over two scroll positions, not the whole tree. A
  // reader a year from now must not mistake the sample for full coverage.
  test("the structural gate's value names the probed sample, not just the totals", () => {
    const g = evaluateHierGates(okMetrics()).find((v) => v.gate === "a11y_tree_structure")!;
    expect(String(g.value)).toContain("72 probed row(s)");
  });
});

describe("evaluateSwitchGates", () => {
  const okSwitch: SwitchMetrics = {
    a_holds_own: true,
    a_holds_other: false,
    b_holds_own: true,
    b_holds_other: false,
    survived_restart: true,
    undo_scoped: true,
    docs_changed: 2,
  };

  test("all three pass on a clean run", () => {
    expect(evaluateSwitchGates(okSwitch).every((v) => v.verdict === "PASS")).toBe(true);
  });

  test("cross-contamination fails isolation", () => {
    const v = evaluateSwitchGates({ ...okSwitch, a_holds_other: true });
    expect(v.find((g) => g.gate === "switch_isolation")?.verdict).toBe("FAIL");
  });

  test("a missing sentence fails isolation, not just persistence", () => {
    const v = evaluateSwitchGates({ ...okSwitch, b_holds_own: false });
    expect(v.find((g) => g.gate === "switch_isolation")?.verdict).toBe("FAIL");
  });

  test("a lost restart fails persistence", () => {
    const v = evaluateSwitchGates({ ...okSwitch, survived_restart: false });
    expect(v.find((g) => g.gate === "switch_persistence")?.verdict).toBe("FAIL");
  });

  test("an unscoped undo fails undo scope", () => {
    const v = evaluateSwitchGates({ ...okSwitch, undo_scoped: false });
    expect(v.find((g) => g.gate === "switch_undo_scope")?.verdict).toBe("FAIL");
  });
});

describe("evaluateFirstRunGates", () => {
  const okFirst: FirstRunMetrics = {
    window_opened: true,
    project_name: "Untitled book",
    project_file_stem: "default",
    starter_items: [
      { id: "chapter-1", type: "chapter", title: "Kapitel 1", parent_id: null },
      { id: "scene-1", type: "scene", title: "Szene 1", parent_id: "chapter-1" },
    ],
    words_after_typing: 6,
    quit_closed_the_window: true,
    stored_body_holds_the_sentence: true,
    peak_rss_mb: 520,
  };

  test("all first-run gates pass on a clean run", () => {
    expect(evaluateFirstRunGates(okFirst).every((v) => v.verdict === "PASS")).toBe(true);
  });

  test("no window fails the opening gate", () => {
    const v = evaluateFirstRunGates({ ...okFirst, window_opened: false });
    expect(v.find((g) => g.gate === "first_run_opens")?.verdict).toBe("FAIL");
  });

  test("a project named after its file stem fails the naming gate", () => {
    // The exact state an earlier fix addressed, and the reason this gate compares the
    // two rather than checking the name is non-empty: `default` IS a non-empty
    // name, and a gate satisfied by it would have passed against the defect.
    const v = evaluateFirstRunGates({ ...okFirst, project_name: "default" });
    expect(v.find((g) => g.gate === "first_run_project_is_named")?.verdict).toBe("FAIL");
  });

  test("an empty name fails the naming gate too", () => {
    const v = evaluateFirstRunGates({ ...okFirst, project_name: "" });
    expect(v.find((g) => g.gate === "first_run_project_is_named")?.verdict).toBe("FAIL");
  });

  test("English starter titles fail the localized hierarchy gate", () => {
    const v = evaluateFirstRunGates({
      ...okFirst,
      starter_items: [
        { id: "chapter-1", type: "chapter", title: "Chapter 1", parent_id: null },
        { id: "scene-1", type: "scene", title: "Scene 1", parent_id: "chapter-1" },
      ],
    });
    expect(v.find((g) => g.gate === "first_run_starter_titles_localized")?.verdict).toBe("FAIL");
  });

  test("wrong titles, swapped types, a wrong parent, and an incomplete outline each fail localization", () => {
    const cases: FirstRunMetrics["starter_items"][] = [
      [
        { id: "chapter-1", type: "chapter", title: "Kapitel 2", parent_id: null },
        { id: "scene-1", type: "scene", title: "Szene 1", parent_id: "chapter-1" },
      ],
      [
        { id: "chapter-1", type: "scene", title: "Kapitel 1", parent_id: null },
        { id: "scene-1", type: "chapter", title: "Szene 1", parent_id: "chapter-1" },
      ],
      [
        { id: "chapter-1", type: "chapter", title: "Kapitel 1", parent_id: null },
        { id: "scene-1", type: "scene", title: "Szene 1", parent_id: null },
      ],
      [{ id: "chapter-1", type: "chapter", title: "Kapitel 1", parent_id: null }],
      [
        { id: "chapter-1", type: "chapter", title: "Kapitel 1", parent_id: null },
        { id: "scene-1", type: "scene", title: "Szene 1", parent_id: "chapter-1" },
        { id: "scene-2", type: "scene", title: "Szene 2", parent_id: "chapter-1" },
      ],
    ];
    for (const starter_items of cases) {
      const v = evaluateFirstRunGates({ ...okFirst, starter_items });
      expect(v.find((g) => g.gate === "first_run_starter_titles_localized")?.verdict).toBe("FAIL");
    }
  });

  test("no words after typing fails the typing gate", () => {
    const v = evaluateFirstRunGates({ ...okFirst, words_after_typing: 0 });
    expect(v.find((g) => g.gate === "first_run_accepts_typing")?.verdict).toBe("FAIL");
  });

  test("a window that outlives the quit chord fails", () => {
    // The ONLY automated check that Ctrl+Q closes anything. Every other test of
    // the quit path stops at `requestQuit` being called.
    const v = evaluateFirstRunGates({ ...okFirst, quit_closed_the_window: false });
    expect(v.find((g) => g.gate === "first_run_quit_closes")?.verdict).toBe("FAIL");
  });

  test("writing lost across the quit fails, and separately from the close", () => {
    const v = evaluateFirstRunGates({ ...okFirst, stored_body_holds_the_sentence: false });
    expect(v.find((g) => g.gate === "first_run_keeps_the_writing")?.verdict).toBe("FAIL");
    // The close itself still passed. Two different failures, two gates: a
    // window that shut and dropped the last sentence is not the same defect as
    // one that would not shut.
    expect(v.find((g) => g.gate === "first_run_quit_closes")?.verdict).toBe("PASS");
  });

  test("RSS over the threshold fails", () => {
    const v = evaluateFirstRunGates({ ...okFirst, peak_rss_mb: 900 });
    expect(v.find((g) => g.gate === "peak_rss_mb")?.verdict).toBe("FAIL");
  });

  test("RSS exactly at the threshold passes, and one over does not", () => {
    // The recorded boundary rule: a threshold test far from the boundary tests
    // the arithmetic and not the comparison.
    expect(
      evaluateFirstRunGates({ ...okFirst, peak_rss_mb: 750 }).find((g) => g.gate === "peak_rss_mb")
        ?.verdict,
    ).toBe("PASS");
    expect(
      evaluateFirstRunGates({ ...okFirst, peak_rss_mb: 751 }).find((g) => g.gate === "peak_rss_mb")
        ?.verdict,
    ).toBe("FAIL");
  });
});

describe("evaluateProjectGates", () => {
  // Named okProject rather than ok: the module-level Metrics fixture is already
  // called ok, and a shadowing fixture bit a previous slice.
  const okProject: ProjectMetrics = {
    a_holds_own: true,
    a_holds_other: false,
    b_holds_own: true,
    b_holds_other: false,
    survived_restart: true,
    stale_generation_rejected: true,
    projects_changed: 2,
  };

  test("all three pass on a clean run", () => {
    expect(evaluateProjectGates(okProject).every((v) => v.verdict === "PASS")).toBe(true);
  });

  // The defect: one manuscript's prose landing in another manuscript's file.
  test("a cross-project write fails isolation", () => {
    const v = evaluateProjectGates({ ...okProject, a_holds_other: true });
    expect(v.find((g) => g.gate === "project_isolation")?.verdict).toBe("FAIL");
  });

  test("a missing sentence fails isolation, not just persistence", () => {
    const v = evaluateProjectGates({ ...okProject, b_holds_own: false });
    expect(v.find((g) => g.gate === "project_isolation")?.verdict).toBe("FAIL");
    expect(v.find((g) => g.gate === "project_persistence")?.verdict).toBe("PASS");
  });

  test("an unreadable file after the reopen fails persistence", () => {
    const v = evaluateProjectGates({ ...okProject, survived_restart: false });
    expect(v.find((g) => g.gate === "project_persistence")?.verdict).toBe("FAIL");
  });

  test("a host that accepted a superseded generation fails the guard", () => {
    const v = evaluateProjectGates({ ...okProject, stale_generation_rejected: false });
    expect(v.find((g) => g.gate === "project_generation_guard")?.verdict).toBe("FAIL");
  });

  test("an unprobed generation guard is UNKNOWN, not FAIL", () => {
    // FAIL would say a stale flush was accepted. Nothing was sent. A rig driving
    // the real UI cannot produce one, because the page drains before it tears
    // the outgoing project down.
    const v = evaluateProjectGates({ ...okProject, stale_generation_rejected: null });
    const gate = v.find((g) => g.gate === "project_generation_guard");
    expect(gate?.verdict).toBe("UNKNOWN");
    expect(String(gate?.value)).toContain("not probed");
  });
});

describe("evaluateOutlineGates: delete", () => {
  const okOutline = (): OutlineMetrics => ({
    created_scene_opens: true,
    deleted_item_in_bin: true,
    deleted_body_survives: true,
    restored_item_out_of_bin: true,
    restored_body_survives: true,
    restored_item_is_last_root: true,
    bin_is_last_root: true,
    create_row_delta: 1,
    create_title_in_walk: true,
    create_opened_doc: true,
    rename_title_persisted: true,
    reorder_position_match: true,
    undo_ordinal_before: 2,
    undo_ordinal_after_move: 3,
    undo_ordinal_after_undo: 2,
    undo_restores_order: true,
    document_intact: true,
    walk_changed: true,
    mutations: 12,
    mutation_p50_ms: 1,
    mutation_p95_ms: 2,
  });

  test("an item left outside the bin FAILs", () => {
    const v = evaluateOutlineGates({ ...okOutline(), deleted_item_in_bin: false });
    expect(v.find((g) => g.gate === "outline_delete_moves_to_bin")?.verdict).toBe("FAIL");
  });

  test("a destroyed body FAILs, and ALONE", () => {
    // The gate exists because no other gate here can see the difference: an
    // item removed outright is equally absent from the export and the search.
    // So it has to be able to fail while everything around it passes.
    const v = evaluateOutlineGates({ ...okOutline(), deleted_body_survives: false });
    expect(v.find((g) => g.gate === "outline_delete_keeps_the_prose")?.verdict).toBe("FAIL");
    const others = v.filter((g) => g.gate !== "outline_delete_keeps_the_prose");
    expect(others.every((g) => g.verdict === "PASS")).toBe(true);
  });

  test("both PASS when the delete behaved", () => {
    const v = evaluateOutlineGates(okOutline());
    expect(v.find((g) => g.gate === "outline_delete_moves_to_bin")?.verdict).toBe("PASS");
    expect(v.find((g) => g.gate === "outline_delete_keeps_the_prose")?.verdict).toBe("PASS");
  });

  test("an item still in the bin after a restore FAILs", () => {
    const v = evaluateOutlineGates({ ...okOutline(), restored_item_out_of_bin: false });
    expect(v.find((g) => g.gate === "outline_restore_leaves_the_bin")?.verdict).toBe("FAIL");
  });

  test("a restored-but-emptied scene FAILs, and ALONE", () => {
    // The pair's whole reason for being two gates. A restore that returned the
    // item without its prose satisfies outline_restore_leaves_the_bin
    // completely, and every other gate here as well.
    const v = evaluateOutlineGates({ ...okOutline(), restored_body_survives: false });
    expect(v.find((g) => g.gate === "outline_restore_keeps_the_prose")?.verdict).toBe("FAIL");
    const others = v.filter((g) => g.gate !== "outline_restore_keeps_the_prose");
    expect(others.every((g) => g.verdict === "PASS")).toBe(true);
  });

  test("both restore gates PASS when the round trip behaved", () => {
    const v = evaluateOutlineGates(okOutline());
    expect(v.find((g) => g.gate === "outline_restore_leaves_the_bin")?.verdict).toBe("PASS");
    expect(v.find((g) => g.gate === "outline_restore_keeps_the_prose")?.verdict).toBe("PASS");
  });

  test("a restore that lands anywhere but the last manuscript root FAILs", () => {
    const v = evaluateOutlineGates({ ...okOutline(), restored_item_is_last_root: false });
    expect(v.find((g) => g.gate === "outline_restore_lands_last")?.verdict).toBe("FAIL");
  });

  test("a bin that is not the last root FAILs, even with the item placed right", () => {
    // The gate that could not PASS on today's code before this fix: an
    // earlier design believed a re-sink kept the bin last, and nothing measured it.
    const v = evaluateOutlineGates({ ...okOutline(), bin_is_last_root: false });
    expect(v.find((g) => g.gate === "outline_restore_lands_last")?.verdict).toBe("FAIL");
  });

  test("PASSes only when the restored item AND the bin are both last", () => {
    const v = evaluateOutlineGates(okOutline());
    expect(v.find((g) => g.gate === "outline_restore_lands_last")?.verdict).toBe("PASS");
  });
});

describe("evaluateOutlineGates", () => {
  const okOutline = (): OutlineMetrics => ({
    created_scene_opens: true,
    deleted_item_in_bin: true,
    deleted_body_survives: true,
    restored_item_out_of_bin: true,
    restored_body_survives: true,
    restored_item_is_last_root: true,
    bin_is_last_root: true,
    create_row_delta: 1,
    create_title_in_walk: true,
    create_opened_doc: true,
    rename_title_persisted: true,
    reorder_position_match: true,
    undo_ordinal_before: 2,
    undo_ordinal_after_move: 3,
    undo_ordinal_after_undo: 2,
    undo_restores_order: true,
    document_intact: true,
    walk_changed: true,
    mutations: 12,
    mutation_p50_ms: 2,
    mutation_p95_ms: 7,
  });

  const outlineVerdict = (m: OutlineMetrics, gate: string): string =>
    evaluateOutlineGates(m).find((g) => g.gate === gate)!.verdict;

  test("thresholds match the specification", () => {
    expect(OUTLINE_THRESHOLDS.mutation_p95_ms).toBe(50);
  });

  test("a clean outline run passes every gate", () => {
    expect(evaluateOutlineGates(okOutline()).every((g) => g.verdict === "PASS")).toBe(true);
  });

  // The create gate carries three independent claims, and a rig that only
  // counted rows would pass an item created under the wrong title, or a create
  // that rebuilt the whole mount. Each conjunct is flipped on its own, or the
  // others are unguarded.
  test("a create that added no row fails", () => {
    expect(outlineVerdict({ ...okOutline(), create_row_delta: 0 }, "outline_create_visible")).toBe(
      "FAIL",
    );
  });

  test("a create that added more than one row fails: a remount is not a create", () => {
    expect(outlineVerdict({ ...okOutline(), create_row_delta: 2 }, "outline_create_visible")).toBe(
      "FAIL",
    );
  });

  test("a row count that grew by one without the new title in the walk still fails", () => {
    const wrongTitle: OutlineMetrics = { ...okOutline(), create_title_in_walk: false };
    expect(outlineVerdict(wrongTitle, "outline_create_visible")).toBe("FAIL");
    // Only that gate: the count half is intact and nothing else was touched.
    for (const g of evaluateOutlineGates(wrongTitle)) {
      if (g.gate !== "outline_create_visible") expect(g.verdict).toBe("PASS");
    }
  });

  // The headline claim of the slice: before it, the only way to get a new item
  // on screen was to destroy and rebuild the whole project mount, losing the
  // editor, the caret, the undo history and the open document. A remount that
  // reopened the same document leaves identical bytes behind, so
  // outline_document_intact cannot see this and only this metric can.
  test("a create that left the previous document open fails, though the row and title are right", () => {
    // The 2026-08-28 behaviour, now the defect: New scene then typing wrote
    // into the old scene.
    const remounted: OutlineMetrics = { ...okOutline(), create_opened_doc: false };
    expect(outlineVerdict(remounted, "outline_create_visible")).toBe("FAIL");
    for (const g of evaluateOutlineGates(remounted)) {
      if (g.gate !== "outline_create_visible") expect(g.verdict).toBe("PASS");
    }
  });

  test("the create gate's value and threshold report all three clauses", () => {
    const g = evaluateOutlineGates(okOutline()).find((x) => x.gate === "outline_create_visible")!;
    expect(String(g.value)).toContain("1 row");
    expect(String(g.value)).toContain("title");
    expect(String(g.value)).toContain("open document");
    // A threshold that describes less than the predicate checks is how a gate's
    // name comes to overstate its evidence.
    expect(g.threshold).toContain("grew by exactly 1");
    expect(g.threshold).toContain("new title is in the walk");
    expect(g.threshold).toContain("CREATED item");
  });

  // The defect this gate was added for: the opener's type lookup read a
  // boot-time walk, so a scene created in the session had no known type, and an
  // unknown type takes the same silent early return as a part. Every other
  // outline gate passed on that build.
  test("a created row that does not open when clicked fails, and only that gate", () => {
    const dead: OutlineMetrics = { ...okOutline(), created_scene_opens: false };
    expect(outlineVerdict(dead, "outline_created_scene_opens")).toBe("FAIL");
    for (const g of evaluateOutlineGates(dead)) {
      if (g.gate !== "outline_created_scene_opens") expect(g.verdict).toBe("PASS");
    }
  });

  // The two create gates read opposite things about the open document at two
  // different instants, and a reader who takes them for a contradiction will
  // eventually "fix" one of them. The threshold strings have to carry the
  // order, because the verdict lines are what get read.
  test("the two create gates state which instant each describes", () => {
    const gates = evaluateOutlineGates(okOutline());
    const created = gates.find((x) => x.gate === "outline_create_visible")!;
    const opens = gates.find((x) => x.gate === "outline_created_scene_opens")!;
    expect(created.threshold).toContain("BEFORE anything is clicked");
    expect(created.threshold).toContain("outline_created_scene_opens");
    expect(opens.threshold).toContain("AFTER the create");
    // And in that order in the emitted list, so the sequence reads top to bottom.
    expect(gates.findIndex((g) => g.gate === "outline_create_visible")).toBeLessThan(
      gates.findIndex((g) => g.gate === "outline_created_scene_opens"),
    );
  });

  test("a rename that did not survive the reopen fails", () => {
    expect(
      outlineVerdict({ ...okOutline(), rename_title_persisted: false }, "outline_rename_persists"),
    ).toBe("FAIL");
  });

  test("a reorder whose sibling position moved back on reopen fails", () => {
    expect(
      outlineVerdict({ ...okOutline(), reorder_position_match: false }, "outline_reorder_persists"),
    ).toBe("FAIL");
  });

  test("Ctrl+Z restoring the pre-move ordinal PASSes", () => {
    expect(outlineVerdict(okOutline(), "outline_undo_restores_order")).toBe("PASS");
  });

  test("an undo that leaves the row at its post-move ordinal FAILs", () => {
    expect(
      outlineVerdict(
        { ...okOutline(), undo_restores_order: false, undo_ordinal_after_undo: 3 },
        "outline_undo_restores_order",
      ),
    ).toBe("FAIL");
  });

  // The conjunct this gate exists to guard: a Ctrl+Z that does nothing to an
  // item the reorder never actually moved would otherwise show "after" equal
  // to "before" and PASS on a no-op.
  test("a no-op move and a no-op undo do not PASS just because before equals after", () => {
    const noop: OutlineMetrics = {
      ...okOutline(),
      undo_ordinal_before: 2,
      undo_ordinal_after_move: 2,
      undo_ordinal_after_undo: 2,
      undo_restores_order: false,
    };
    expect(outlineVerdict(noop, "outline_undo_restores_order")).toBe("FAIL");
  });

  test("the undo gate's value reports all three ordinals in order", () => {
    const g = evaluateOutlineGates(okOutline()).find(
      (x) => x.gate === "outline_undo_restores_order",
    )!;
    expect(String(g.value)).toBe("ordinal 2 -> 3 -> 2");
  });

  // The gate that catches a reload which disturbed the editor: the tree can be
  // perfect and the writer's prose still be gone.
  test("prose disturbed by the reload fails, with every structural gate still passing", () => {
    const disturbed: OutlineMetrics = { ...okOutline(), document_intact: false };
    expect(outlineVerdict(disturbed, "outline_document_intact")).toBe("FAIL");
    for (const g of evaluateOutlineGates(disturbed)) {
      if (g.gate !== "outline_document_intact") expect(g.verdict).toBe("PASS");
    }
  });

  // The verdict line is what gets read and quoted; metrics.scope is not. A
  // threshold naming only the round trip would be read as covering the pointer
  // path a writer's click takes, and the graded samples deliberately exclude it.
  // Pinned here so the string and the rig's sampling rule cannot drift apart.
  //
  // "recorded, not graded" was in this assertion until the outline bar was
  // retired, when the rig lost its one pointer-driven sample: every route to a
  // structural edit now ends in a Return inside the context menu. The rule the
  // string has to keep stating is which input class is in the percentile, not
  // that a second class sits beside it.
  test("the mutation threshold states that only keyboard-driven samples are graded", () => {
    const g = evaluateOutlineGates(okOutline()).find(
      (x) => x.gate === "outline_mutation_p95_ms",
    )!;
    expect(g.threshold).toContain("KEYBOARD-DRIVEN SAMPLES ONLY");
    expect(g.threshold).toContain("pointer");
    expect(g.threshold).toContain("every sample is keyboard-driven");
  });

  test("mutation p95 fails at the threshold, not above it", () => {
    expect(
      outlineVerdict({ ...okOutline(), mutation_p95_ms: 50 }, "outline_mutation_p95_ms"),
    ).toBe("FAIL");
  });

  // percentiles([]) returns zeros, which reads as perfect latency. A p95 over
  // no mutations is no measurement.
  test("mutation p95 over zero mutations is UNKNOWN, never PASS", () => {
    const none: OutlineMetrics = { ...okOutline(), mutations: 0, mutation_p50_ms: 0, mutation_p95_ms: 0 };
    const g = evaluateOutlineGates(none).find((x) => x.gate === "outline_mutation_p95_ms")!;
    expect(g.verdict).toBe("UNKNOWN");
    expect(String(g.value)).toContain("0 mutations");
  });
});

describe("evaluateWordsGates", () => {
  const okWords = (): WordsMetrics => ({
    marked_text: "flood",
    mark_persisted: true,
    mark_applied_live: true,
    project_total: 2008,
    scene_sum: 2008,
    scene_docs: 30,
    scene_words: 54,
    stored_body_hash: "1f2e3d4c",
    reopen_loaded_body_hash: "1f2e3d4c",
    scan_ms: 190,
    // Built from the REAL rig constants, never a hand-picked number: the
    // predecessor wrote 60 here and then asserted the threshold string said
    // "60 ms", which pinned the fixture against itself and checked nothing about
    // the rig. The read costs below are plausible measured values; the floor is
    // whatever words-floor.ts makes of them.
    scan_watch_read_ms: 0.4,
    scan_commit_read_ms: 0.3,
    scan_granularity_ms: scanFloorMs(0.4, 0.3),
    // ATK `panel` is what role="group" maps to on WebKitGTK - measured against
    // the running app, not assumed.
    a11y_role: "panel",
    a11y_name: "Word count: 54 words in this scene, 2,008 saved in the project",
    // A DIFFERENT SENTENCE FROM THE NAME, by design: the bar is compact and the
    // announced name is the full phrase. Same two figures either way, which is
    // the whole of a11y_word_count_agrees' claim.
    a11y_text: "54 words · 2,008 saved",
    a11y_text_has_both_figures: true,
    a11y_text_figures: ["54", "2,008"],
    a11y_name_figures: ["54", "2,008"],
  });

  const wordsVerdict = (m: WordsMetrics, gate: string): GateVerdict =>
    evaluateWordsGates(m).find((g) => g.gate === gate)!.verdict;

  const exposure = (m: WordsMetrics): GateResult =>
    evaluateWordsGates(m).find((g) => g.gate === "a11y_word_count_exposed")!;

  test("a clean run passes all six", () => {
    const gates = evaluateWordsGates(okWords());
    expect(gates).toHaveLength(6);
    for (const g of gates) expect(g.verdict).toBe("PASS");
  });

  // a11y_word_count_agrees. The guard on a deliberate duplication: the page
  // formats one pair of numbers twice, and nothing inside the page can see the
  // two renderings drift, because there they come from the same two variables.
  const agrees = (m: WordsMetrics): GateResult =>
    evaluateWordsGates(m).find((g) => g.gate === "a11y_word_count_agrees")!;

  test("a scene figure on screen that differs from the announced one FAILs", () => {
    // What a stale repaint of one channel looks like: the bar says 54 and a
    // screen reader says 61. Both are plausible; they cannot both be right.
    const drifted: WordsMetrics = { ...okWords(), a11y_text_figures: ["61", "2,008"] };
    expect(agrees(drifted).verdict).toBe("FAIL");
    expect(String(agrees(drifted).value)).toContain("61");
  });

  test("a project figure that differs FAILs too, not just the scene one", () => {
    // Without this the comparison could check only the first element and pass.
    const drifted: WordsMetrics = { ...okWords(), a11y_name_figures: ["54", "2,009"] };
    expect(agrees(drifted).verdict).toBe("FAIL");
  });

  test("the same numbers formatted differently is a disagreement", () => {
    // The figures are compared AS WRITTEN. "2008" and "2,008" are the same
    // value and different renderings, and one channel losing its thousands
    // separator is exactly the drift this gate exists to catch - normalizing
    // them to numbers first would hide it.
    const drifted: WordsMetrics = { ...okWords(), a11y_text_figures: ["54", "2008"] };
    expect(agrees(drifted).verdict).toBe("FAIL");
  });

  test("a channel that did not parse is UNKNOWN, never FAIL", () => {
    // The exposure gate already reports an unreadable channel, and precisely.
    // Repeating it here as a FAIL would double-count one defect, and calling it
    // a disagreement would name the wrong one.
    for (const m of [
      { ...okWords(), a11y_text_figures: null },
      { ...okWords(), a11y_name_figures: null },
    ] satisfies WordsMetrics[]) {
      expect(agrees(m).verdict).toBe("UNKNOWN");
      expect(String(agrees(m).value)).toContain("NOT COMPARED");
    }
  });

  test("agreement does not rescue an absent node, and absence does not fail it", () => {
    // The two gates answer different questions and must not be read as one. A
    // node missing from the tree fails exposure; the figures it never reported
    // are NOT COMPARED rather than in agreement.
    const absent: WordsMetrics = {
      ...okWords(),
      a11y_role: null,
      a11y_name: "",
      a11y_text: "",
      a11y_text_has_both_figures: false,
      a11y_text_figures: null,
      a11y_name_figures: null,
    };
    expect(exposure(absent).verdict).toBe("FAIL");
    expect(agrees(absent).verdict).toBe("UNKNOWN");
  });

  test("a mark lost across the reopen fails, and only that gate", () => {
    const lost: WordsMetrics = { ...okWords(), mark_persisted: false };
    expect(wordsVerdict(lost, "marks_persist")).toBe("FAIL");
    for (const g of evaluateWordsGates(lost)) {
      if (g.gate !== "marks_persist") expect(g.verdict).toBe("PASS");
    }
  });

  // The word the mark landed on is named in the value, because the rig selects
  // it with a key chord rather than choosing it: a reader who cannot see which
  // word was tested cannot tell a real regression from a mis-aimed selection.
  test("the marked word is named in the verdict line, in both directions", () => {
    expect(String(evaluateWordsGates(okWords())[0]!.value)).toContain("flood");
    const lost: WordsMetrics = { ...okWords(), mark_persisted: false };
    expect(String(evaluateWordsGates(lost)[0]!.value)).toContain("flood");
  });

  // THE HOLE THIS GATE USED TO HAVE. A body with no marked run at all is the
  // loss the gate names, and it read UNKNOWN until 2026-08-12 on the false
  // reasoning that "the rig aborts on that": mark_applied_live guards the LIVE
  // session, not the reopen, so a mark that reached the store and then vanished
  // landed here and rendered as "not measured". FAIL was reachable only when the
  // reopened body carried some OTHER marked run - a mark that MOVED.
  test("a mark that reached the store and is then absent entirely FAILs", () => {
    const none: WordsMetrics = {
      ...okWords(),
      marked_text: "",
      mark_persisted: false,
      mark_applied_live: true,
    };
    const g = evaluateWordsGates(none).find((x) => x.gate === "marks_persist")!;
    expect(g.verdict).toBe("FAIL");
    expect(String(g.value)).toContain("no marked run");
  });

  // The one case that genuinely is unmeasured: no mark was ever given, so none
  // can have been lost. words-cli aborts before reaching here.
  test("no marked run and none applied live is UNKNOWN, never FAIL", () => {
    const none: WordsMetrics = {
      ...okWords(),
      marked_text: "",
      mark_persisted: false,
      mark_applied_live: false,
    };
    expect(wordsVerdict(none, "marks_persist")).toBe("UNKNOWN");
  });

  // marks_persist is unfalsifiable end to end from its own rig: the reopen boot
  // writes nothing back, so the bytes it grades are the bytes the killed process
  // left, and a page that lost the mark while PARSING would leave them alone.
  // The verdict line is what gets read, quoted and pasted into a summary, so the
  // exclusion has to be in the threshold rather than only in metrics.scope -
  // the same precedent as outline_mutation_p95_ms carrying "KEYBOARD-DRIVEN
  // SAMPLES ONLY". Pinned here so the pair cannot drift: a threshold that names
  // reopen_parse_intact while reopen_parse_intact has been renamed or dropped is
  // a verdict line pointing at nothing.
  test("marks_persist states what it cannot see, and names the gate that can", () => {
    const gates = evaluateWordsGates(okWords());
    const marks = gates.find((g) => g.gate === "marks_persist")!;
    expect(marks.threshold).toContain("STORE-SIDE LOSS ONLY");
    expect(marks.threshold).toContain("CANNOT detect a parse-side loss");
    expect(marks.threshold).toContain("reopen_parse_intact");
    // And the gate it names is actually emitted by the same call.
    expect(gates.some((g) => g.gate === "reopen_parse_intact")).toBe(true);
  });

  // The reopen boot writes nothing back, so every store-side reopen check is
  // satisfied by the file the killed process left. This gate is the only thing
  // in the run that can see the page's PARSE.
  describe("reopen_parse_intact", () => {
    test("a re-serialization that differs from the stored bytes FAILs, and only that gate", () => {
      const drifted: WordsMetrics = { ...okWords(), reopen_loaded_body_hash: "deadbeef" };
      expect(wordsVerdict(drifted, "reopen_parse_intact")).toBe("FAIL");
      for (const g of evaluateWordsGates(drifted)) {
        if (g.gate !== "reopen_parse_intact") expect(g.verdict).toBe("PASS");
      }
    });

    // Both hashes in the verdict line: "they differ" is not diffable a year
    // later, and the run does not keep the bodies.
    test("both hashes are named in the verdict line", () => {
      const drifted: WordsMetrics = { ...okWords(), reopen_loaded_body_hash: "deadbeef" };
      const value = String(
        evaluateWordsGates(drifted).find((g) => g.gate === "reopen_parse_intact")!.value,
      );
      expect(value).toContain("1f2e3d4c");
      expect(value).toContain("deadbeef");
    });
  });

  // The drift the slice's two implementations exist to expose. Both directions,
  // because an overcount and an undercount are equally wrong and a predicate
  // written as `>=` would pass one of them.
  test("a host total that is not the page's sum fails, in either direction", () => {
    for (const total of [2007, 2009]) {
      const drifted: WordsMetrics = { ...okWords(), project_total: total };
      expect(wordsVerdict(drifted, "word_count_agrees")).toBe("FAIL");
      // And the two numbers are both in the verdict line: the delta alone does
      // not say which side is high.
      const value = String(
        evaluateWordsGates(drifted).find((g) => g.gate === "word_count_agrees")!.value,
      );
      expect(value).toContain(String(total));
      expect(value).toContain("2008");
    }
  });

  // A total that was never read is not agreement. Zero would be the dangerous
  // default: over an empty page-side sum it would compare equal and record a
  // PASS on a run that measured nothing.
  test("a project total that was never read is UNKNOWN, never PASS", () => {
    const unread: WordsMetrics = { ...okWords(), project_total: null };
    const g = evaluateWordsGates(unread).find((x) => x.gate === "word_count_agrees")!;
    expect(g.verdict).toBe("UNKNOWN");
    expect(String(g.value)).toContain("not read");
  });

  test("scan latency fails at the threshold, not above it", () => {
    expect(
      wordsVerdict({ ...okWords(), scan_ms: WORDS_THRESHOLDS.scan_ms }, "word_count_scan_ms"),
    ).toBe("FAIL");
    expect(
      wordsVerdict({ ...okWords(), scan_ms: WORDS_THRESHOLDS.scan_ms - 1 }, "word_count_scan_ms"),
    ).toBe("PASS");
  });

  // Zero would read as an instant scan. No repaint observed is no measurement.
  test("a scan with no observed repaint is UNKNOWN, never PASS", () => {
    const g = evaluateWordsGates({ ...okWords(), scan_ms: null }).find(
      (x) => x.gate === "word_count_scan_ms",
    )!;
    expect(g.verdict).toBe("UNKNOWN");
    expect(String(g.value)).toContain("no repaint observed");
  });

  // The verdict line is what gets read and quoted; metrics.scope is not. This
  // gate's name says "scan" and its predicate covers a whole round trip plus the
  // rig's own polling cost, so the threshold has to carry both facts -- the same
  // rule outline_mutation_p95_ms follows, for the same reason.
  test("the scan threshold states that it is an upper bound and names the rig's floor", () => {
    const m = okWords();
    const g = evaluateWordsGates(m).find((x) => x.gate === "word_count_scan_ms")!;
    expect(g.threshold).toContain("UPPER BOUND");
    expect(g.threshold).toContain("repainted");
    // Against the REAL constants, not a fixture: the floor the string quotes is
    // whatever words-floor.ts computes from the two measured read costs, and it
    // is dominated by the 20 ms watcher period rather than by the sub-millisecond
    // read the predecessor reported as the whole granularity.
    expect(g.threshold).toContain(`${scanFloorMs(m.scan_watch_read_ms, m.scan_commit_read_ms)} ms`);
    expect(g.threshold).toContain("RESOLUTION FLOOR");
  });

  // The defect: scan_granularity_ms reported the watcher's median NAME READ
  // (0.4 ms) while the gate called it the finest interval the rig could resolve.
  // One endpoint sleeps 20 ms between reads and the other opens a fresh SQLite
  // connection every 2 ms, so the true floor is ~50x that, and a recorded
  // scan_ms of 2 was an artifact below the noise floor presented as a
  // measurement.
  describe("the resolution floor is the rig's, not one display read", () => {
    test("the floor is at least the watcher's polling period", () => {
      expect(scanFloorMs(0.4, 0.3)).toBeGreaterThanOrEqual(WATCH_POLL_MS);
      expect(scanFloorMs(0.4, 0.3)).toBeGreaterThanOrEqual(WATCH_POLL_MS + COMMIT_POLL_MS);
    });

    // A read that costs more than its period dominates it. The floor tracks
    // whichever bounds each endpoint, so a slow bus does not read as a fast rig.
    test("a read costlier than its period raises the floor", () => {
      expect(scanFloorMs(120, 0.3)).toBeGreaterThan(scanFloorMs(0.4, 0.3));
      expect(scanFloorMs(0.4, 90)).toBeGreaterThan(scanFloorMs(0.4, 0.3));
    });

    test("a scan below the floor is reported as bounded, not resolved", () => {
      const m: WordsMetrics = { ...okWords(), scan_ms: 2 };
      const g = evaluateWordsGates(m).find((x) => x.gate === "word_count_scan_ms")!;
      // Still PASS: an upper bound below the threshold does bound it. But the
      // value line must not print "2" as if the rig had resolved 2 ms.
      expect(g.verdict).toBe("PASS");
      expect(String(g.value)).toContain("NOT RESOLVED");
      expect(String(g.value)).toContain(`${m.scan_granularity_ms} ms floor`);
    });

    test("a scan above the floor is reported as the bare number", () => {
      const g = evaluateWordsGates(okWords()).find((x) => x.gate === "word_count_scan_ms")!;
      expect(g.value).toBe(190);
    });
  });

  // The defect this gate was added for: the word count was in the DOM, visible
  // on screen, and absent from the platform accessibility tree entirely. A
  // screen reader user could not read their own word count, and nothing graded
  // it for a whole slice.
  describe("a11y_word_count_exposed", () => {
    test("an element absent from the tree FAILs - it is not UNKNOWN", () => {
      // UNKNOWN is for a measurement that was not taken. This one was taken and
      // the answer was no, which is the whole reason the gate exists.
      const gone: WordsMetrics = {
        ...okWords(),
        a11y_role: null,
        a11y_name: "",
        a11y_text: "",
        a11y_text_has_both_figures: false,
      };
      const g = exposure(gone);
      expect(g.verdict).toBe("FAIL");
      expect(String(g.value)).toContain("ABSENT");
    });

    test("a run that only loses the exposure fails that gate and no other", () => {
      const gone: WordsMetrics = {
        ...okWords(),
        a11y_role: null,
        a11y_name: "",
        a11y_text: "",
        a11y_text_has_both_figures: false,
      };
      for (const g of evaluateWordsGates(gone)) {
        if (g.gate !== "a11y_word_count_exposed") expect(g.verdict).toBe("PASS");
      }
    });

    // The scar this restates: 36 navigator rows once carried
    // `xml-roles:treeitem` while mapping to ATK `section`, and a match on the
    // attribute would have passed an exposure gate on markup no screen reader
    // could read. The ATK role is the only authority.
    test("a node that mapped to a generic ATK role FAILs even with a name", () => {
      for (const role of ["section", "unknown", "filler", "redundant object"]) {
        const generic: WordsMetrics = { ...okWords(), a11y_role: role };
        expect(exposure(generic).verdict).toBe("FAIL");
      }
    });

    test("the ATK role is named in the verdict line, so a FAIL says what happened", () => {
      expect(String(exposure({ ...okWords(), a11y_role: "section" }).value)).toContain("section");
      expect(String(exposure(okWords()).value)).toContain("panel");
    });

    // A node with no accessible name is announced as nothing. Present-and-roled
    // is two thirds of the claim and none of the point, which is why the three
    // conjuncts are one gate.
    test("an exposed but nameless node FAILs", () => {
      expect(exposure({ ...okWords(), a11y_name: "" }).verdict).toBe("FAIL");
    });

    // Half a count is a number a writer would misread: the project figure lags
    // by a flush debounce and is only legible because it is qualified "saved".
    test("text carrying only one of the two figures FAILs", () => {
      const half: WordsMetrics = {
        ...okWords(),
        a11y_text: "54 words in this scene",
        a11y_text_has_both_figures: false,
      };
      expect(exposure(half).verdict).toBe("FAIL");
    });

    test("the threshold names all three conjuncts", () => {
      const g = exposure(okWords());
      expect(g.threshold).toContain("ATK role");
      expect(g.threshold).toContain("accessible name");
      expect(g.threshold).toContain("both figures");
    });
  });
});

// Export gates. Both directions for every one of them: a gate only asserted in
// the passing direction is a gate nobody has seen fail.
const okExport = (): ExportMetrics => ({
  fixture: "tiny",
  export_items: 24,
  export_markdown_contents_verified: true,
  export_markdown_contents_entries: 24,
  export_headings: 24,
  export_levels_matched: 24,
  export_scenes_compared: 8,
  export_scenes_matched: 8,
  export_words: 2008,
  project_words: 2008,
  export_marks_found: 1,
  marks_applied_live: true,
  underlined_runs_in_scene: 1,
  export_underline_markup_found: 0,
  export_underline_reported: 1,
  export_last_sentence_present: true,
  export_second_path_differs: true,
  export_first_unchanged: true,
  export_ms: 120,
});

const exportGate = (m: ExportMetrics, gate: string): GateResult =>
  evaluateExportGates(m).find((g) => g.gate === gate)!;

describe("evaluateExportGates", () => {
  test("a clean run passes every functional gate and reports export memory unknown", () => {
    const gates = evaluateExportGates(okExport());
    expect(gates).toHaveLength(9);
    for (const g of gates) {
      expect(g.verdict).toBe(g.gate === "peak_rss_mb" ? "UNKNOWN" : "PASS");
    }
  });

  describe("export_structure", () => {
    test("a heading count that is not the walk's item count FAILs, in either direction", () => {
      // Both directions, because a dropped item and an invented heading are
      // different defects and a predicate written as `>=` would pass one.
      for (const headings of [23, 25]) {
        const m: ExportMetrics = { ...okExport(), export_headings: headings };
        expect(exportGate(m, "export_structure").verdict).toBe("FAIL");
        const value = String(exportGate(m, "export_structure").value);
        expect(value).toContain(String(headings));
        expect(value).toContain("24");
      }
    });

    test("an empty walk is UNKNOWN, never PASS", () => {
      // 0 == 0 is the dangerous agreement: an empty file would satisfy an empty
      // manuscript and record a PASS on a run that exported nothing.
      const m: ExportMetrics = { ...okExport(), export_items: 0, export_headings: 0 };
      const g = exportGate(m, "export_structure");
      expect(g.verdict).toBe("UNKNOWN");
      expect(String(g.value)).toContain("no items");
    });

    // THE CASE THAT USED TO PASS. The gate compared counts alone while its name
    // and its threshold both claimed "at the expected level", so an exporter
    // that emitted every heading at `##` -- one heading per item, in order, and
    // the whole hierarchy flattened -- recorded a PASS. The levels were parsed
    // and unit-tested in markdown-read.ts and read by NO gate.
    test("counts that agree while a level does not FAILs", () => {
      const m: ExportMetrics = { ...okExport(), export_levels_matched: 23 };
      const g = exportGate(m, "export_structure");
      expect(g.verdict).toBe("FAIL");
      expect(String(g.value)).toContain("23");
    });

    test("no heading at its expected level FAILs even with the counts equal", () => {
      const m: ExportMetrics = { ...okExport(), export_levels_matched: 0 };
      expect(exportGate(m, "export_structure").verdict).toBe("FAIL");
    });

    test("the threshold says the H1 is not counted", () => {
      expect(exportGate(okExport(), "export_structure").threshold).toContain("H1");
    });

    // The level claim has to be ON THE VERDICT LINE, including that the rig
    // restates the rule rather than importing it: a rig that imported
    // heading_level from export.rs would check the exporter against itself and
    // the level half would grade a tautology.
    test("the threshold carries the level rule and says the rig restates it", () => {
      const t = exportGate(okExport(), "export_structure").threshold;
      expect(t).toContain("min(depth + 2, 6)");
      expect(t).toContain("RESTATED");
      expect(t).toContain("export.rs");
    });
  });

  describe("export_text_fidelity", () => {
    test("a scene whose prose does not round-trip FAILs, and only that gate", () => {
      const m: ExportMetrics = { ...okExport(), export_scenes_matched: 7 };
      expect(exportGate(m, "export_text_fidelity").verdict).toBe("FAIL");
      for (const g of evaluateExportGates(m)) {
        expect(g.verdict).toBe(
          g.gate === "export_text_fidelity" ? "FAIL" : g.gate === "peak_rss_mb" ? "UNKNOWN" : "PASS",
        );
      }
      // Both counts on the verdict line: "some scenes differ" is not diffable.
      const value = String(exportGate(m, "export_text_fidelity").value);
      expect(value).toContain("7");
      expect(value).toContain("8");
    });

    test("zero scenes compared is UNKNOWN, never PASS", () => {
      const m: ExportMetrics = { ...okExport(), export_scenes_compared: 0, export_scenes_matched: 0 };
      const g = exportGate(m, "export_text_fidelity");
      expect(g.verdict).toBe("UNKNOWN");
      expect(String(g.value)).toContain("no scene");
    });

    // THE LIMIT THIS GATE HAS TO CARRY ON ITS OWN VERDICT LINE. There is no
    // CommonMark parser in this project and adding one would make the run a
    // test of that parser, so the gate proves a necessary condition -- the
    // exporter can read back what it wrote -- and not a sufficient one. An
    // exclusion recorded only in metrics.scope is an exclusion nobody sees.
    test("the threshold names its own reader and denies being a CommonMark check", () => {
      const t = exportGate(okExport(), "export_text_fidelity").threshold;
      expect(t).toContain("THIS RIG'S OWN READER");
      expect(t).toContain("markdown-read.ts");
      expect(t).toContain("NOT a CommonMark reference");
    });

    // The trim_end asymmetry is a property of the format, not a defect, and
    // normalizing both sides is what keeps it out of the verdict. What that
    // costs -- a whitespace-only difference is invisible -- has to be said
    // where the verdict is read.
    test("the threshold states that both sides are whitespace-normalized", () => {
      const t = exportGate(okExport(), "export_text_fidelity").threshold;
      expect(t).toContain("whitespace-normalized");
      expect(t).toContain("trim_end");
    });
  });

  describe("export_word_count_agrees", () => {
    test("a disagreement FAILs in either direction, with both numbers named", () => {
      for (const words of [2007, 2009]) {
        const m: ExportMetrics = { ...okExport(), export_words: words };
        expect(exportGate(m, "export_word_count_agrees").verdict).toBe("FAIL");
        const value = String(exportGate(m, "export_word_count_agrees").value);
        expect(value).toContain(String(words));
        expect(value).toContain("2008");
      }
    });

    test("a host total that was never read is UNKNOWN, never PASS", () => {
      const m: ExportMetrics = { ...okExport(), project_words: null };
      const g = exportGate(m, "export_word_count_agrees");
      expect(g.verdict).toBe("UNKNOWN");
      expect(String(g.value)).toContain("not read");
    });

    test("an export of zero words is UNKNOWN even when the host also says zero", () => {
      // The failure this rules out: an empty file agreeing with an empty
      // manuscript and recording a PASS on a run that counted nothing.
      const m: ExportMetrics = { ...okExport(), export_words: 0, project_words: 0 };
      expect(exportGate(m, "export_word_count_agrees").verdict).toBe("UNKNOWN");
    });

    // The two sides count over different sets on purpose: the export counts
    // WALKED items, the host counts every `doc` row. A row whose item is not in
    // the walk is prose missing from the manuscript, and this gate is the
    // tripwire for it -- not a tolerance to be widened.
    test("the threshold names the divergence it is a tripwire for", () => {
      expect(exportGate(okExport(), "export_word_count_agrees").threshold).toContain("walk");
    });
  });

  describe("export_underline_loss_reported", () => {
    // THE GATE FOR THE COUNTED, SURFACED LOSS. Markdown has no underline, so
    // the export drops the mark on purpose. What must never happen is the drop
    // being silent, and "the exporter dropped it" and "the writer was told"
    // are two different claims -- so this gate asserts BOTH, plus the third
    // thing a well-meaning fix would do instead: smuggle `<u>` into the file.
    const gate = (m: ExportMetrics): GateResult => exportGate(m, "export_underline_loss_reported");

    test("a run that dropped one and reported one PASSes", () => {
      expect(gate(okExport()).verdict).toBe("PASS");
    });

    test("a count that disagrees with the store FAILs, in either direction", () => {
      // Both directions: under-reporting hides a loss and over-reporting
      // invents one, and a predicate written as `>=` would pass one of them.
      for (const reported of [0, 2]) {
        const m: ExportMetrics = { ...okExport(), export_underline_reported: reported };
        expect(gate(m).verdict).toBe("FAIL");
        expect(String(gate(m).value)).toContain(String(reported));
      }
    });

    test("underline markup in the file FAILs even when the count agrees", () => {
      // The rejected fix. Emitting `<u>` breaks the escaper (which escapes
      // `<`), the importer (which has no HTML path) and the readable mirror's
      // accept path, and the third SILENTLY STRIPS every underline in the
      // document. A build that shipped it would report an honest count and
      // still be wrong.
      const m: ExportMetrics = { ...okExport(), export_underline_markup_found: 1 };
      expect(gate(m).verdict).toBe("FAIL");
      expect(String(gate(m).value)).toContain("MARKUP");
    });

    test("no underline applied is UNKNOWN, never PASS", () => {
      // Nothing given, nothing lost. A FAIL here would blame the application
      // for a rig that never pressed the chord, and a PASS would record a
      // verdict about a measurement nobody took.
      const m: ExportMetrics = {
        ...okExport(),
        underlined_runs_in_scene: 0,
        export_underline_reported: 0,
      };
      expect(gate(m).verdict).toBe("UNKNOWN");
      expect(String(gate(m).value)).toContain("no underline");
    });

    test("a notice that could not be read is UNKNOWN, not agreement", () => {
      // A third state. The banner is read off the live accessibility tree and
      // removes itself after six seconds; a walk that missed it says so rather
      // than letting the drop half carry a PASS the surfacing half never
      // earned.
      const m: ExportMetrics = { ...okExport(), export_underline_reported: null };
      const g = gate(m);
      expect(g.verdict).toBe("UNKNOWN");
      expect(String(g.value)).toContain("not read");
    });

    test("only this gate moves when the report is wrong", () => {
      const m: ExportMetrics = { ...okExport(), export_underline_reported: 7 };
      for (const g of evaluateExportGates(m)) {
        expect(g.verdict).toBe(
          g.gate === "export_underline_loss_reported" ? "FAIL" : g.gate === "peak_rss_mb" ? "UNKNOWN" : "PASS",
        );
      }
    });

    test("the threshold names all three claims", () => {
      const t = gate(okExport()).threshold;
      expect(t).toContain("Mod-u");
      expect(t).toContain("export notice");
      expect(t).toContain("<u>");
    });
  });

  describe("export_marks_survive", () => {
    test("a mark applied live and absent from the file FAILs", () => {
      const m: ExportMetrics = { ...okExport(), export_marks_found: 0 };
      const g = exportGate(m, "export_marks_survive");
      expect(g.verdict).toBe("FAIL");
      expect(String(g.value)).toContain("no emphasis");
    });

    test("no mark ever applied is UNKNOWN, never FAIL", () => {
      // Nothing was given, so nothing can have been lost. export-cli aborts
      // before reaching here; the gate must not blame the application anyway.
      const m: ExportMetrics = { ...okExport(), export_marks_found: 0, marks_applied_live: false };
      expect(exportGate(m, "export_marks_survive").verdict).toBe("UNKNOWN");
    });

    test("the threshold says the delimiters are the only inline markup emitted", () => {
      expect(exportGate(okExport(), "export_marks_survive").threshold).toContain("Mod-i");
    });
  });

  describe("export_includes_last_keystroke", () => {
    test("a sentence missing from the file FAILs", () => {
      const m: ExportMetrics = { ...okExport(), export_last_sentence_present: false };
      const g = exportGate(m, "export_includes_last_keystroke");
      expect(g.verdict).toBe("FAIL");
      expect(String(g.value)).toContain("NOT");
    });

    // The gate is about the page's drain(), and it only means that because the
    // rig proved the store did NOT already hold the sentence at click time. If
    // the debounce had fired first the file would contain it either way.
    test("the threshold says the claim is the drain, not the debounce", () => {
      const t = exportGate(okExport(), "export_includes_last_keystroke").threshold;
      expect(t).toContain("drain");
      expect(t).toContain("debounce");
    });
  });

  describe("export_never_clobbers", () => {
    test("a second export onto the same path FAILs, and says which half broke", () => {
      const m: ExportMetrics = { ...okExport(), export_second_path_differs: false };
      const g = exportGate(m, "export_never_clobbers");
      expect(g.verdict).toBe("FAIL");
      expect(String(g.value)).toContain("SAME PATH");
    });

    test("a first file whose bytes changed FAILs, and says so separately", () => {
      const m: ExportMetrics = { ...okExport(), export_first_unchanged: false };
      const g = exportGate(m, "export_never_clobbers");
      expect(g.verdict).toBe("FAIL");
      expect(String(g.value)).toContain("FIRST FILE CHANGED");
    });
  });

  describe("export_ms", () => {
    test("a slow export FAILs at its fixture's threshold", () => {
      const m: ExportMetrics = { ...okExport(), export_ms: EXPORT_THRESHOLDS.export_ms.tiny! };
      expect(exportGate(m, "export_ms").verdict).toBe("FAIL");
    });

    test("the same number passes at stress and fails at tiny", () => {
      // The number means nothing without the fixture: 2 s is a defect over 24
      // items and unremarkable over 20,000.
      const ms = 2000;
      expect(exportGate({ ...okExport(), export_ms: ms }, "export_ms").verdict).toBe("FAIL");
      expect(
        exportGate({ ...okExport(), fixture: "stress", export_ms: ms }, "export_ms").verdict,
      ).toBe("PASS");
    });

    test("the threshold names the fixture", () => {
      expect(exportGate(okExport(), "export_ms").threshold).toContain("tiny");
      expect(exportGate({ ...okExport(), fixture: "stress" }, "export_ms").threshold).toContain(
        "stress",
      );
    });

    test("a fixture with no stated threshold is UNKNOWN, never PASS", () => {
      // Borrowing another fixture's bound would report a number as passing a
      // threshold nobody set for it.
      const g = exportGate({ ...okExport(), fixture: "normal" }, "export_ms");
      expect(g.verdict).toBe("UNKNOWN");
      expect(g.threshold).toContain("no threshold");
    });

    test("the threshold says what the interval covers beyond the command", () => {
      const t = exportGate(okExport(), "export_ms").threshold;
      expect(t).toContain("drain");
      expect(t).toContain("pointer delivery");
    });
  });

  describe("peak_rss_mb", () => {
    test("is UNKNOWN despite low or high legacy readiness values", () => {
      for (const readinessPeak of [1, 10_000]) {
        const legacy = { ...okExport(), peak_rss_mb: readinessPeak } as ExportMetrics;
        const gate = exportGate(legacy, "peak_rss_mb");
        expect(gate.value).toBe("not measured");
        expect(gate.verdict).toBe("UNKNOWN");
      }
    });

    test("the threshold says the export working memory is unavailable", () => {
      const t = exportGate({ ...okExport(), fixture: "stress" }, "peak_rss_mb").threshold;
      expect(t).toContain("stress");
      expect(t).toContain("working memory unavailable");
      expect(t).toContain("sampling ends before interactive export");
    });
  });
});

describe("evaluateFindGates: the reveal", () => {
  // NOTE: this is the FIRST unit test any find gate has had. The other eight
  // still have none, which is the same defect recorded for evaluateGates - a
  // gate whose failing direction is never exercised is a gate that has never
  // been shown to fail. Recorded as open in the slice write-back rather than
  // fixed here, because closing it properly means a fixture per gate.
  const okFind = (): FindMetrics => ({
    fixture: "tiny",
    find_limit: 200,
    oracle_matches: 3,
    reported_total: 3,
    typed_hits: 1,
    typed_item: "s1",
    typed_expected_item: "s1",
    title_hits: 1,
    title_found_expected: true,
    title_expected_kind: "chapter",
    case_variants_agree: true,
    case_variant_hits: 3,
    snippets_checked: 3,
    snippets_contained: 3,
    truncation_total: null,
    truncation_shown: null,
    truncation_reported: null,
    empty_query_hits: 0,
    reveal_query: "ZZQXVNONCE",
    reveal_selection: "ZZQXVNONCE",
    peak_rss_mb: 500,
  });

  const reveal = (m: FindMetrics) =>
    evaluateFindGates(m).find((g) => g.gate === "find_reveal_selects_the_match");

  test("PASSes when the editor selected the query", () => {
    expect(reveal(okFind())?.verdict).toBe("PASS");
  });

  test("FAILs when nothing was selected", () => {
    // The failure a reveal that silently did nothing produces, and the reason
    // null is not folded into the comparison: `null === query` would be false
    // anyway, but the VALUE line has to say which of the two happened.
    const g = reveal({ ...okFind(), reveal_selection: null });
    expect(g?.verdict).toBe("FAIL");
    expect(String(g?.value)).toContain("NOTHING SELECTED");
  });

  test("FAILs when the editor selected some OTHER text", () => {
    // A reveal that lands on the wrong word is worse than one that lands
    // nowhere: the writer believes they are looking at the match.
    const g = reveal({ ...okFind(), reveal_selection: "harbourmaster" });
    expect(g?.verdict).toBe("FAIL");
    expect(String(g?.value)).toContain("NOT the query");
  });

  test("PASSes on a case difference, which is what the search itself allows", () => {
    expect(reveal({ ...okFind(), reveal_selection: "zzqxvnonce" })?.verdict).toBe("PASS");
  });

  test("PASSes on a word-final sigma, which whole-string folding would FAIL", () => {
    // The gate folds one code point at a time. Folding the whole string applies
    // Unicode SpecialCasing, so the selected "ΟΔΟΣ" would fold to "οδος" while
    // the query folds to "οδοσ", and a correct reveal would be graded a defect.
    const g = reveal({ ...okFind(), reveal_query: "οδοσ", reveal_selection: "ΟΔΟΣ" });
    expect(g?.verdict).toBe("PASS");
  });
});

describe("evaluateFindGates: the eight gates that had none", () => {
  // Written to close a gap named in the find-reveal write-back: every gate here
  // predates that slice and none had ever been exercised in its FAILING
  // direction. A gate that has only ever been seen passing is a gate nobody has
  // shown can fail - the same defect recorded for evaluateGates, where a
  // peak_rss_mb threshold ran so far from its boundary that `<=` for `<`
  // survived.
  //
  // The UNKNOWN branches carry as much weight as the FAIL ones here. Four of
  // these gates are satisfied by comparing nothing to nothing, and each one
  // returns UNKNOWN for exactly that case: an oracle of 0 items, three empty
  // result lists agreeing, no snippet checked, no term that can out-match the
  // cap. Those are the branches that stop a silent no-op reading as a pass.
  const okFind = (): FindMetrics => ({
    fixture: "stress",
    find_limit: 200,
    oracle_matches: 25,
    reported_total: 25,
    typed_hits: 1,
    typed_item: "s1",
    typed_expected_item: "s1",
    title_hits: 1,
    title_found_expected: true,
    title_expected_kind: "part",
    case_variants_agree: true,
    case_variant_hits: 25,
    snippets_checked: 22,
    snippets_contained: 22,
    truncation_total: 14048,
    truncation_shown: 200,
    truncation_reported: true,
    empty_query_hits: 0,
    reveal_query: "ZZQXVNONCE",
    reveal_selection: "ZZQXVNONCE",
    peak_rss_mb: 500,
  });

  const gate = (name: string, over: Partial<FindMetrics> = {}) =>
    evaluateFindGates({ ...okFind(), ...over }).find((g) => g.gate === name);

  test("every gate PASSes on a clean run, so the FAIL cases below mean something", () => {
    const all = evaluateFindGates(okFind());
    expect(all.every((g) => g.verdict === "PASS")).toBe(true);
    // Nine, and the count is asserted so a gate added without a test here shows
    // up as a failure rather than as silence.
    expect(all).toHaveLength(9);
  });

  describe("find_total_matches_oracle", () => {
    test("FAILs when the app reports fewer items than the store holds", () => {
      // The completeness claim. A search that silently misses a scene is
      // indistinguishable, to a writer, from a scene without the word.
      const g = gate("find_total_matches_oracle", { reported_total: 24 });
      expect(g?.verdict).toBe("FAIL");
      expect(String(g?.value)).toContain("delta -1");
    });

    test("FAILs when it reports MORE than the store holds", () => {
      expect(gate("find_total_matches_oracle", { reported_total: 26 })?.verdict).toBe("FAIL");
    });

    test("an oracle of 0 is UNKNOWN, not PASS", () => {
      // 0 == 0 is the dangerous agreement: it is satisfied by a search that
      // returns nothing for every term ever given to it.
      const g = gate("find_total_matches_oracle", { oracle_matches: 0, reported_total: 0 });
      expect(g?.verdict).toBe("UNKNOWN");
    });

    test("an unread total is UNKNOWN, not FAIL", () => {
      // FAIL would claim the app answered wrongly. It never answered.
      expect(gate("find_total_matches_oracle", { reported_total: null })?.verdict).toBe("UNKNOWN");
    });
  });

  describe("find_locates_typed_sentence", () => {
    test("FAILs when the nonce is found in more than one item", () => {
      expect(gate("find_locates_typed_sentence", { typed_hits: 2 })?.verdict).toBe("FAIL");
    });

    test("FAILs when the hit is a DIFFERENT item from the one typed into", () => {
      // One hit at the wrong scene passes a count check and is a worse defect
      // than no hit at all.
      const g = gate("find_locates_typed_sentence", { typed_item: "s9" });
      expect(g?.verdict).toBe("FAIL");
      expect(String(g?.value)).toContain("expected s1");
    });

    test("FAILs when nothing was found", () => {
      expect(
        gate("find_locates_typed_sentence", { typed_hits: 0, typed_item: null })?.verdict,
      ).toBe("FAIL");
    });

    test("is UNKNOWN when the rig never established which item it typed into", () => {
      expect(gate("find_locates_typed_sentence", { typed_expected_item: null })?.verdict).toBe(
        "UNKNOWN",
      );
    });
  });

  describe("find_title_match", () => {
    test("FAILs when a term from a seeded title does not return its item", () => {
      // Restricting search to prose would silently exclude every part and
      // chapter - which is where a writer looks for a character name first.
      const g = gate("find_title_match", { title_found_expected: false, title_hits: 0 });
      expect(g?.verdict).toBe("FAIL");
      expect(String(g?.value)).toContain("NOT FOUND");
    });

    test("is UNKNOWN when no seeded title could supply a term", () => {
      expect(gate("find_title_match", { title_expected_kind: null })?.verdict).toBe("UNKNOWN");
    });
  });

  describe("find_case_insensitive", () => {
    test("FAILs when the casings disagree", () => {
      expect(gate("find_case_insensitive", { case_variants_agree: false })?.verdict).toBe("FAIL");
    });

    test("three EMPTY lists agreeing is UNKNOWN, not PASS", () => {
      // Perfect agreement between three empty lists proves nothing at all.
      const g = gate("find_case_insensitive", { case_variant_hits: 0 });
      expect(g?.verdict).toBe("UNKNOWN");
      expect(String(g?.value)).toContain("means nothing");
    });
  });

  describe("find_snippet_fidelity", () => {
    test("FAILs when one snippet does not occur in the stored text", () => {
      // The gate that caught the rig's own doubled block separator at stress,
      // as 12 of 184 - exactly the snippets spanning a paragraph boundary.
      const g = gate("find_snippet_fidelity", { snippets_contained: 21 });
      expect(g?.verdict).toBe("FAIL");
      expect(String(g?.value)).toContain("NOT IN THE STORED TEXT");
    });

    test("checking no snippets at all is UNKNOWN, not PASS", () => {
      expect(gate("find_snippet_fidelity", { snippets_checked: 0, snippets_contained: 0 })?.verdict)
        .toBe("UNKNOWN");
    });
  });

  describe("find_truncation_honest", () => {
    test("FAILs when the panel does not say the list is capped", () => {
      // A cap nobody is told about reads as completeness.
      const g = gate("find_truncation_honest", { truncation_reported: false });
      expect(g?.verdict).toBe("FAIL");
      expect(String(g?.value)).toContain("DOES NOT SAY");
    });

    test("FAILs when fewer than the cap were shown", () => {
      expect(gate("find_truncation_honest", { truncation_shown: 199 })?.verdict).toBe("FAIL");
    });

    test("FAILs when the reported total is not actually above the cap", () => {
      // Otherwise a panel that claims truncation on a complete list passes.
      expect(gate("find_truncation_honest", { truncation_total: 200 })?.verdict).toBe("FAIL");
    });

    test("a fixture that cannot out-match the cap is UNKNOWN, not PASS", () => {
      const g = gate("find_truncation_honest", {
        fixture: "tiny",
        truncation_total: null,
        truncation_shown: null,
        truncation_reported: null,
      });
      expect(g?.verdict).toBe("UNKNOWN");
      expect(String(g?.value)).toContain("not probed");
    });
  });

  describe("find_empty_query_empty_result", () => {
    test("FAILs when an empty query returns rows", () => {
      // Matching the empty string against every document returns the entire
      // book, which reads as catastrophe rather than as an empty query.
      const g = gate("find_empty_query_empty_result", { empty_query_hits: 15200 });
      expect(g?.verdict).toBe("FAIL");
      expect(String(g?.value)).toContain("15200 ROW(S)");
    });

    test("FAILs on a SINGLE row, not just on a flood", () => {
      // The boundary. A test at 15,200 exercises the arithmetic; this one
      // exercises the comparison.
      expect(gate("find_empty_query_empty_result", { empty_query_hits: 1 })?.verdict).toBe("FAIL");
    });

    test("is UNKNOWN when it was never probed", () => {
      expect(gate("find_empty_query_empty_result", { empty_query_hits: null })?.verdict).toBe(
        "UNKNOWN",
      );
    });
  });

  describe("peak_rss_mb, at its boundary", () => {
    test("FAILs AT the threshold, which is the only value that tests the comparison", () => {
      // The recorded defect this closes: the older suite ran this gate at 913
      // against a 750 threshold, so mutating `<` to `<=` survived - a test far
      // from the boundary exercises the arithmetic, not the operator.
      //
      // One step either side does not close it either: `<` and `<=` agree on
      // both of those. Only the exact value separates them, and the gate's own
      // threshold string says `<`, so equality must FAIL.
      const at = THRESHOLDS.peak_rss_mb;
      expect(gate("peak_rss_mb", { peak_rss_mb: at })?.verdict).toBe("FAIL");
      expect(gate("peak_rss_mb", { peak_rss_mb: at - 1 })?.verdict).toBe("PASS");
      expect(gate("peak_rss_mb", { peak_rss_mb: at + 1 })?.verdict).toBe("FAIL");
    });
  });
});

const okDocxImport = (): DocxImportMetrics => ({
  items_a: 4,
  items_b: 4,
  title_depth_matches: 4,
  prose_matches: 2,
  scenes_compared: 2,
  loss_notice_shown: false,
});

const docxImportGate = (m: DocxImportMetrics, gate: string): GateResult =>
  evaluateDocxImportGates(m).find((g) => g.gate === gate)!;

describe("evaluateDocxImportGates", () => {
  test("a clean round trip passes all three", () => {
    const gates = evaluateDocxImportGates(okDocxImport());
    expect(gates).toHaveLength(3);
    for (const g of gates) expect(g.verdict).toBe("PASS");
  });

  describe("import_docx_round_trip_items", () => {
    test("an item count that disagrees FAILs, in either direction", () => {
      for (const items_b of [3, 5]) {
        const m: DocxImportMetrics = { ...okDocxImport(), items_b };
        expect(docxImportGate(m, "import_docx_round_trip_items").verdict).toBe("FAIL");
      }
    });

    test("counts agreeing while a title or depth does not still FAILs", () => {
      // The recorded shape this repo keeps catching: a total that matches
      // while the items underneath it are not the same items, at the same
      // positions, is a reordered manuscript wearing the right count.
      const m: DocxImportMetrics = { ...okDocxImport(), title_depth_matches: 3 };
      expect(docxImportGate(m, "import_docx_round_trip_items").verdict).toBe("FAIL");
    });

    test("an empty project A never PASSes, even 0 of 0", () => {
      const m: DocxImportMetrics = {
        ...okDocxImport(),
        items_a: 0,
        items_b: 0,
        title_depth_matches: 0,
      };
      expect(docxImportGate(m, "import_docx_round_trip_items").verdict).toBe("FAIL");
    });
  });

  describe("import_docx_round_trip_prose", () => {
    test("a scene whose prose does not agree FAILs", () => {
      const m: DocxImportMetrics = { ...okDocxImport(), prose_matches: 1 };
      expect(docxImportGate(m, "import_docx_round_trip_prose").verdict).toBe("FAIL");
    });

    test("no scenes compared is never a PASS", () => {
      const m: DocxImportMetrics = { ...okDocxImport(), scenes_compared: 0, prose_matches: 0 };
      expect(docxImportGate(m, "import_docx_round_trip_prose").verdict).toBe("FAIL");
    });
  });

  describe("import_docx_reports_no_loss", () => {
    test("a loss notice on the crate's own export round trip FAILs", () => {
      const m: DocxImportMetrics = { ...okDocxImport(), loss_notice_shown: true };
      expect(docxImportGate(m, "import_docx_reports_no_loss").verdict).toBe("FAIL");
    });

    test("no notice PASSes", () => {
      expect(docxImportGate(okDocxImport(), "import_docx_reports_no_loss").verdict).toBe("PASS");
    });
  });
});

describe("evaluateHomeGates (099/100)", () => {
  const okHome: HomeMetrics = {
    home_project_path: "",
    home_rows: 0,
    home_library_present: true,
    last_project_path: "/library/tiny.db",
    last_library_present: false,
    blank_project_path: "",
    blank_rows: 0,
    blank_library_present: false,
    library_overview_ms: 40,
    library_words_ms: 60,
    home_opens_the_book: true,
  };

  test("all gates pass on a clean three-boot run", () => {
    expect(evaluateHomeGates(okHome).every((v) => v.verdict === "PASS")).toBe(true);
  });

  test("a book mounted under start=home fails the home gate", () => {
    const v = evaluateHomeGates({ ...okHome, home_project_path: "/library/tiny.db" });
    expect(v.find((g) => g.gate === "home_boots_nothing_open")?.verdict).toBe("FAIL");
  });

  test("rows > 0 under start=home fails the home gate even with an empty path", () => {
    // Sabotaged independently of the path: a sink payload could in principle
    // report no project and a stale row count from the previous mount, and
    // the gate must not read only one of its two fields.
    const v = evaluateHomeGates({ ...okHome, home_rows: 12 });
    expect(v.find((g) => g.gate === "home_boots_nothing_open")?.verdict).toBe("FAIL");
  });

  test("no #library under start=home fails the home gate even with nothing mounted", () => {
    // 100's own addition: the empty workspace's button no longer tells
    // `home` and `blank` apart, so the screen itself has to be checked.
    const v = evaluateHomeGates({ ...okHome, home_library_present: false });
    expect(v.find((g) => g.gate === "home_boots_nothing_open")?.verdict).toBe("FAIL");
  });

  test("nothing mounted under start=last fails the last gate", () => {
    const v = evaluateHomeGates({ ...okHome, last_project_path: "" });
    expect(v.find((g) => g.gate === "start_last_boots_the_book")?.verdict).toBe("FAIL");
  });

  test("#library showing under start=last fails the last gate even with the book mounted", () => {
    const v = evaluateHomeGates({ ...okHome, last_library_present: true });
    expect(v.find((g) => g.gate === "start_last_boots_the_book")?.verdict).toBe("FAIL");
  });

  test("a book mounted under start=blank fails the blank gate", () => {
    const v = evaluateHomeGates({ ...okHome, blank_project_path: "/library/tiny.db" });
    expect(v.find((g) => g.gate === "start_blank_boots_nothing")?.verdict).toBe("FAIL");
  });

  test("rows > 0 under start=blank fails the blank gate even with an empty path", () => {
    const v = evaluateHomeGates({ ...okHome, blank_rows: 3 });
    expect(v.find((g) => g.gate === "start_blank_boots_nothing")?.verdict).toBe("FAIL");
  });

  test("#library showing under start=blank fails the blank gate even with nothing mounted", () => {
    const v = evaluateHomeGates({ ...okHome, blank_library_present: true });
    expect(v.find((g) => g.gate === "start_blank_boots_nothing")?.verdict).toBe("FAIL");
  });

  test("an overview slower than the bound fails library_overview_ms", () => {
    const v = evaluateHomeGates({ ...okHome, library_overview_ms: 251 });
    expect(v.find((g) => g.gate === "library_overview_ms")?.verdict).toBe("FAIL");
    expect(evaluateHomeGates({ ...okHome, library_overview_ms: 250 }).find((g) => g.gate === "library_overview_ms")?.verdict).toBe(
      "PASS",
    );
  });

  test("a word count slower than the bound fails library_words_ms", () => {
    const v = evaluateHomeGates({ ...okHome, library_words_ms: 251 });
    expect(v.find((g) => g.gate === "library_words_ms")?.verdict).toBe("FAIL");
    expect(evaluateHomeGates({ ...okHome, library_words_ms: 250 }).find((g) => g.gate === "library_words_ms")?.verdict).toBe(
      "PASS",
    );
  });

  test("failing to open the book from the desk fails home_opens_the_book", () => {
    const v = evaluateHomeGates({ ...okHome, home_opens_the_book: false });
    expect(v.find((g) => g.gate === "home_opens_the_book")?.verdict).toBe("FAIL");
  });
});

describe("evaluateTimelineGates (102)", () => {
  const okTimeline: TimelineMetrics = {
    timeline_zoom_p95_ms: 8,
    timeline_visible_count: 220,
    timeline_event_round_trip: true,
    timeline_open_scene: true,
    timeline_branch_swap: true,
    timeline_drag_moves: true,
  };

  test("all gates pass on a clean run", () => {
    expect(evaluateTimelineGates(okTimeline).every((v) => v.verdict === "PASS")).toBe(true);
  });

  test("a p95 at the threshold fails (strict less-than)", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_zoom_p95_ms: TIMELINE_ZOOM_P95_MS });
    expect(v.find((g) => g.gate === "timeline_zoom_p95_ms")?.verdict).toBe("FAIL");
    expect(
      evaluateTimelineGates({ ...okTimeline, timeline_zoom_p95_ms: TIMELINE_ZOOM_P95_MS - 1 }).find(
        (g) => g.gate === "timeline_zoom_p95_ms",
      )?.verdict,
    ).toBe("PASS");
  });

  // MUTATION TARGET 10, restated as a FAIL fixture: the gate itself must
  // fail at 2,000 (or anywhere near it), not merely at absurd values.
  test("2,000 visible events fails timeline_visible_dom_bounded", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_visible_count: 2000 });
    expect(v.find((g) => g.gate === "timeline_visible_dom_bounded")?.verdict).toBe("FAIL");
  });

  test("a count at the bound fails (strict less-than)", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_visible_count: TIMELINE_VISIBLE_DOM_BOUND });
    expect(v.find((g) => g.gate === "timeline_visible_dom_bounded")?.verdict).toBe("FAIL");
    expect(
      evaluateTimelineGates({
        ...okTimeline,
        timeline_visible_count: TIMELINE_VISIBLE_DOM_BOUND - 1,
      }).find((g) => g.gate === "timeline_visible_dom_bounded")?.verdict,
    ).toBe("PASS");
  });

  test("a title not found in the file fails timeline_event_round_trip", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_event_round_trip: false });
    expect(v.find((g) => g.gate === "timeline_event_round_trip")?.verdict).toBe("FAIL");
  });

  test("a mismatched scene heading fails timeline_open_scene", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_open_scene: false });
    expect(v.find((g) => g.gate === "timeline_open_scene")?.verdict).toBe("FAIL");
  });

  // 103, plan item 7's two new gates.
  test("a branch flag that did not move in the file fails timeline_branch_swap", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_branch_swap: false });
    expect(v.find((g) => g.gate === "timeline_branch_swap")?.verdict).toBe("FAIL");
  });

  test("an `at` that did not move by the expected units fails timeline_drag_moves", () => {
    const v = evaluateTimelineGates({ ...okTimeline, timeline_drag_moves: false });
    expect(v.find((g) => g.gate === "timeline_drag_moves")?.verdict).toBe("FAIL");
  });
});
