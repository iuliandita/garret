// app/harness/src/gates.ts
// Elimination gates, restated from the design spec (NOT imported from lab, per
// the freeze). Only peak_rss_mb is a spec-hard number; the latency and startup
// thresholds are named placeholder hypotheses pending a real-hardware pass.
// A gate whose probe is unavailable reports UNKNOWN — never a silent PASS.

export type GateVerdict = "PASS" | "FAIL" | "UNKNOWN" | "ADVISORY";

export interface GateResult {
  gate: string;
  value: number | string;
  threshold: string;
  verdict: GateVerdict;
}

export interface A11yProbe {
  available: boolean;
  hasNavigator: boolean;
  /** Row count the rows ADVERTISE via aria-setsize. 0 when absent or inconsistent. */
  exposedRows: number;
  /** Row nodes actually present in the tree. */
  mountedRows: number;
  /** One entry per exposed tree item, in AT-SPI walk order. Empty when the
   *  exposed widget is a flat list rather than a tree. */
  /** `id` is the DOM id (`nav-row-<walkIndex>`) and is the only exact join key
   *  onto the expected walk: 2,292 of the 20,000 stress items share a title, so
   *  aligning on `name` silently pairs the wrong rows. Empty when absent. */
  treeRows: {
    id: string;
    name: string;
    level: number;
    setsize: number;
    posinset: number;
    expanded: boolean;
  }[];
  /** How many nodes of each role appeared. Counts, not a flat list: a naive-mode
   *  tree yields 15,220 entries with 13 distinct values, which is 193 KB of noise
   *  in a committed result. Order carried no meaning — the walk is already flat. */
  roleCounts?: Record<string, number>;
}

export interface Cycle {
  cycle: number;
  atMs: number;
  typingP95Ms: number;
  charsTyped: number;
  partial: boolean;
}

export interface Distribution {
  count: number;
  dispatch: { p50: number; p95: number; p99: number };
  frame: { p50: number; p95: number; p99: number };
  stalls: number;
  slowFrames: number;
  histogram: Record<string, number>;
}

export interface Metrics {
  peak_rss_mb: number;
  // Sourced from frame percentiles (typing.frame / nav.frame) at the call
  // site, not dispatch: the spec thresholds describe user-perceived latency.
  typing_p95_ms: number;
  typing_p99_ms: number;
  nav_p95_ms: number;
  typing: Distribution;
  // Required, not optional: the page has always measured the navigation
  // distribution and the harness has always dropped it, so every recorded
  // result carries `nav: null` and the scalar p95 alone. A silent drop is
  // exactly the failure mode the result schema exists to prevent.
  nav: Distribution;
  cycles: Cycle[];
  rows: number;
  a11y: A11yProbe;
  /** Which workload script produced this result; "pre-versioning" for results
   *  recorded before the field existed. See results.ts's scriptOf. Optional so
   *  existing Metrics fixtures that predate this field still typecheck. */
  workload_script?: string;
}

export const THRESHOLDS = {
  typing_p95_ms: 50,
  typing_p99_ms: 100,
  nav_p95_ms: 150,
  cold_start_ms: 3000,
  warm_start_ms: 1500,
  peak_rss_mb: 750,
  /** Last-decile cycle p95 may not exceed the first decile by more than this. */
  cliff_ratio: 1.5,
  /** (stalls + slowFrames) / count for typing samples. */
  typing_stall_rate: 0.01,
} as const;

// Restated from the page (app/ui/src/measure/summary.ts), not imported: the
// harness and the page are built and shipped separately.
export const SLOW_FRAME_MS = 100;

/** Minimum cycles before a trend means anything. Below this the answer is UNKNOWN. */
export const MIN_TREND_CYCLES = 10;

// Decile means rather than first-vs-last cycle: a single slow cycle from a GC
// pause is noise, and discovery's own soak slope was shown to be unstable when
// fitted from too little data.
export function cliffRatio(cycleP95s: number[]): number {
  if (cycleP95s.length < MIN_TREND_CYCLES) return NaN;
  const n = Math.max(1, Math.floor(cycleP95s.length / 10));
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const head = mean(cycleP95s.slice(0, n));
  const tail = mean(cycleP95s.slice(-n));
  return head === 0 ? NaN : tail / head;
}

function threshold(value: number, limit: number): GateVerdict {
  return value < limit ? "PASS" : "FAIL";
}

// p95 is structurally blind to this pathology: in both naive and virtualized
// modes ~95% of frames are a healthy ~34 ms, so p95 reports the same number
// in both. The freeze/stall behaviour only shows up as a rate in the tail,
// which is exactly what stalls+slowFrames over count measures.
export function stallRate(d: Distribution): number {
  if (d.count === 0) return NaN;
  return (d.stalls + d.slowFrames) / d.count;
}

export function evaluateGates(m: Metrics): GateResult[] {
  // A deadline-truncated final cycle carries a handful of samples instead of
  // the full script, so its p95 is "the slowest of a few samples", not a real
  // trend point. Feeding it in poisoned the last decile: one truncated cycle
  // at 1001 ms against a run flat at 34 ms produced a cliff ratio of 8.11.
  // Complete cycles only, and if that drops us below MIN_TREND_CYCLES the
  // honest answer is UNKNOWN, not a trend judged on whatever is left.
  const completeCycles = m.cycles.filter((c) => !c.partial);
  const ratio = cliffRatio(completeCycles.map((c) => c.typingP95Ms));

  return [
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: threshold(m.peak_rss_mb, THRESHOLDS.peak_rss_mb),
    },
    {
      gate: "typing_p95_ms",
      value: m.typing_p95_ms,
      threshold: `< ${THRESHOLDS.typing_p95_ms}`,
      verdict: threshold(m.typing_p95_ms, THRESHOLDS.typing_p95_ms),
    },
    {
      gate: "typing_p99_ms",
      value: m.typing_p99_ms,
      threshold: `< ${THRESHOLDS.typing_p99_ms}`,
      verdict: threshold(m.typing_p99_ms, THRESHOLDS.typing_p99_ms),
    },
    {
      gate: "nav_p95_ms",
      value: m.nav_p95_ms,
      threshold: `< ${THRESHOLDS.nav_p95_ms}`,
      verdict: threshold(m.nav_p95_ms, THRESHOLDS.nav_p95_ms),
    },
    {
      gate: "no_typing_cliff",
      value: Number.isNaN(ratio) ? `${completeCycles.length} complete cycles` : Number(ratio.toFixed(3)),
      threshold: `last decile / first decile < ${THRESHOLDS.cliff_ratio} (min ${MIN_TREND_CYCLES} cycles)`,
      verdict: Number.isNaN(ratio) ? "UNKNOWN" : threshold(ratio, THRESHOLDS.cliff_ratio),
    },
    {
      gate: "typing_stall_rate",
      value: (() => {
        const r = stallRate(m.typing);
        return Number.isNaN(r) ? "0 samples" : Number(r.toFixed(4));
      })(),
      threshold: `< ${THRESHOLDS.typing_stall_rate} (stalled + frameMs > ${SLOW_FRAME_MS} ms, over sample count)`,
      verdict: (() => {
        const r = stallRate(m.typing);
        return Number.isNaN(r) ? "UNKNOWN" : threshold(r, THRESHOLDS.typing_stall_rate);
      })(),
    },
    exposureGate(m),
  ];
}

// This gate compares one advertised setsize against the total row count, which
// only holds for a FLAT list: one sibling group, so per-group setsize and total
// are the same number. A tree advertises per-sibling-group setsize (a chapter's
// setsize is the chapter count of its part), so no row advertises the total and
// the comparison is not merely wrong, it is inapplicable.
//
// Both obvious outcomes are the failure modes this repo keeps hitting: FAIL
// would mean "the tree is correct", PASS would mean "nothing was checked". So
// on a tree run it reports UNKNOWN and names its successor. `a11y_tree_structure`
// (evaluateHierGates) is the gate that can actually fail on a tree.
//
// Detected from the probe rather than a flag, so a result recorded before
// treeRows existed re-reads with exactly the verdict it was recorded with.
function exposureGate(m: Metrics): GateResult {
  const isTree = (m.a11y.treeRows ?? []).length > 0;
  if (m.a11y.available && isTree) {
    return {
      gate: "a11y_exposure",
      value: "not applicable: tree navigator advertises per-sibling-group setsize, see a11y_tree_structure",
      threshold: `advertised rows == ${m.rows} (flat list only)`,
      verdict: "UNKNOWN",
    };
  }
  return {
    gate: "a11y_exposure",
    value: m.a11y.available ? `${m.a11y.exposedRows} of ${m.rows}` : "probe unavailable",
    threshold: `advertised rows == ${m.rows}`,
    verdict: !m.a11y.available
      ? "UNKNOWN"
      : m.a11y.hasNavigator && m.a11y.exposedRows === m.rows
        ? "PASS"
        : "FAIL",
  };
}

// Persistence gates. Restated from the design spec,
// not imported from anywhere: the specification is the source of truth.
export const PERSIST_THRESHOLDS = {
  /** A named hypothesis, not a spec-hard number. Measured commit p50 was
   *  0.86 ms at stress, so this is loose on purpose. */
  flush_p95_ms: 50,
  flush_conflicts: 0,
} as const;

export interface PersistMetrics {
  /** The reopened document's body hash equals the pre-kill hash. */
  restart_body_match: boolean;
  /** The body actually changed from the seeded one during the write run. Not
   *  read by any gate here — Task 14 uses it as a structural check that aborts
   *  before gates are evaluated (a run that never wrote anything would trivially
   *  "match" on restart). Do not add a gate for it or delete it as unused. */
  body_diverged_from_seed: boolean;
  flush_count: number;
  flush_conflicts: number;
  flush_errors: number;
  flush_p50_ms: number;
  flush_p95_ms: number;
}

export function evaluatePersistGates(m: PersistMetrics): GateResult[] {
  return [
    {
      gate: "restart_body_match",
      value: m.restart_body_match ? "match" : "MISMATCH",
      threshold: "reopened body hash == pre-kill body hash",
      verdict: m.restart_body_match ? "PASS" : "FAIL",
    },
    {
      gate: "flush_conflicts",
      value: m.flush_conflicts,
      threshold: `== ${PERSIST_THRESHOLDS.flush_conflicts}`,
      verdict: m.flush_conflicts === PERSIST_THRESHOLDS.flush_conflicts ? "PASS" : "FAIL",
    },
    {
      gate: "flush_errors",
      value: m.flush_errors,
      threshold: "== 0",
      verdict: m.flush_errors === 0 ? "PASS" : "FAIL",
    },
    {
      // A percentile of zero samples is not a passing latency, it is no
      // measurement. UNKNOWN, never PASS.
      gate: "flush_p95_ms",
      value: m.flush_count === 0 ? "0 flushes" : m.flush_p95_ms,
      threshold: `< ${PERSIST_THRESHOLDS.flush_p95_ms}`,
      verdict:
        m.flush_count === 0
          ? "UNKNOWN"
          : threshold(m.flush_p95_ms, PERSIST_THRESHOLDS.flush_p95_ms),
    },
  ];
}

// Hierarchy gates. Restated from the design spec,
// not imported from anywhere: the specification is the source of truth.
export const HIER_THRESHOLDS = {
  /** A named hypothesis. A mutation is one INSERT or UPDATE plus one
   *  fsync, so it should sit near flush latency, not above it. */
  mutation_p95_ms: 50,
} as const;

export interface HierMetrics {
  /** The reopened walk equals the pre-kill walk: ids, parents, positions, order. */
  tree_shape_match: boolean;
  /** The mutation phase actually changed the tree. Not read by a gate here --
   *  hier-cli uses it as a structural check that aborts before gates, because a
   *  run that mutated nothing would trivially "match" on restart. Do not add a
   *  gate for it or delete it as unused. */
  tree_changed: boolean;
  store_nodes: number;
  exposed_nodes: number;
  level_mismatches: number;
  setsize_mismatches: number;
  /** How many mounted rows the structural comparison actually covered. The
   *  window is ~36 rows over two scroll positions, not the whole tree. */
  probed_rows: number;
  mutations: number;
  mutation_errors: number;
  mutation_p50_ms: number;
  mutation_p95_ms: number;
}

export function evaluateHierGates(m: HierMetrics): GateResult[] {
  return [
    {
      gate: "tree_shape_match",
      value: m.tree_shape_match ? "match" : "MISMATCH",
      threshold: "reopened walk == pre-kill walk (ids, parents, positions, order)",
      verdict: m.tree_shape_match ? "PASS" : "FAIL",
    },
    {
      gate: "a11y_tree_structure",
      value:
        m.probed_rows === 0
          ? "no rows probed"
          : `${m.exposed_nodes} of ${m.store_nodes} exposed; ${m.level_mismatches} level and ` +
            `${m.setsize_mismatches} setsize mismatch(es) over ${m.probed_rows} probed row(s)`,
      threshold: "exposed == store nodes; 0 level and 0 setsize mismatches",
      // Zero probed rows means the structural half was never checked. A count
      // match alone is exactly the weak gate this one exists to replace.
      verdict:
        m.probed_rows === 0
          ? "UNKNOWN"
          : m.exposed_nodes === m.store_nodes &&
              m.level_mismatches === 0 &&
              m.setsize_mismatches === 0
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "mutation_errors",
      value: m.mutation_errors,
      threshold: "== 0",
      verdict: m.mutation_errors === 0 ? "PASS" : "FAIL",
    },
    {
      // A percentile of zero samples is not a passing latency, it is no
      // measurement. UNKNOWN, never PASS.
      gate: "mutation_p95_ms",
      value: m.mutations === 0 ? "0 mutations" : m.mutation_p95_ms,
      threshold: `< ${HIER_THRESHOLDS.mutation_p95_ms}`,
      verdict:
        m.mutations === 0
          ? "UNKNOWN"
          : threshold(m.mutation_p95_ms, HIER_THRESHOLDS.mutation_p95_ms),
    },
  ];
}

// Document-switching gates. Restated from the design spec, not imported
// from anywhere: the specification is the source of truth.

export interface SwitchMetrics {
  /** Scene A's stored body contains the sentence typed into scene A. */
  a_holds_own: boolean;
  /** Scene A's stored body contains scene B's sentence. This is the defect. */
  a_holds_other: boolean;
  b_holds_own: boolean;
  b_holds_other: boolean;
  /** Both scenes still have a readable doc row after the reopen. Deliberately
   *  WEAKER than it first reads: every seeded scene already has a non-empty
   *  body before the run starts, so this cannot fail unless a row was deleted,
   *  and nothing in the switching path deletes rows. The claim that the typed
   *  text survived the restart is carried by a_holds_own / b_holds_own, which
   *  are read from the reopened file — not by this. */
  survived_restart: boolean;
  /** One ctrl+z after the suffix removed the suffix and left A's first
   *  sentence: the undo history did not carry across the switch. */
  undo_scoped: boolean;
  /** How many doc rows diverged from the seeded fixture. Not read by a gate
   *  here - switch-cli uses it as a structural check that aborts before gates,
   *  because with one changed document every gate above is asserting something
   *  about a single scene. Do not add a gate for it or delete it as unused. */
  docs_changed: number;
}

export function evaluateSwitchGates(m: SwitchMetrics): GateResult[] {
  const isolated = m.a_holds_own && !m.a_holds_other && m.b_holds_own && !m.b_holds_other;
  return [
    {
      gate: "switch_isolation",
      value: isolated
        ? "each scene holds its own text and neither holds the other's"
        : `A: own=${m.a_holds_own} other=${m.a_holds_other}; B: own=${m.b_holds_own} other=${m.b_holds_other}`,
      threshold: "each scene's body contains its own sentence and not the other's",
      verdict: isolated ? "PASS" : "FAIL",
    },
    {
      // The threshold says what the predicate actually checks, not what the
      // gate's name suggests. The typed text surviving the restart is
      // switch_isolation's claim; this one only rules out a vanished doc row.
      gate: "switch_persistence",
      value: m.survived_restart ? "both doc rows readable" : "A DOC ROW IS GONE",
      threshold: "both scenes still have a readable doc row after the reopen",
      verdict: m.survived_restart ? "PASS" : "FAIL",
    },
    {
      gate: "switch_undo_scope",
      value: m.undo_scoped ? "scoped to the document" : "CROSSED DOCUMENTS",
      threshold: "one undo removes the suffix and leaves the first sentence",
      verdict: m.undo_scoped ? "PASS" : "FAIL",
    },
  ];
}

// First-run gates: what a person meets when they open this application for the
// first time, with no fixture, no project and no settings.
//
// THIS PATH HAD NO COVERAGE OF ANY KIND until 2026-08-26, and it is the first
// one every writer takes. Every other rig here seeds a project through the host
// and boots it with APP_PROJECT; every screenshot in app/results/screenshots is
// of a seeded project. Slices 023 and 024 fixed four defects that were all
// visible in the first frame of the unseeded path -- no way to quit, a book
// called `default`, no rename, an import folder with no name -- and none of them
// could have been found by anything already here.
//
// The gates are deliberately about a PERSON's first five minutes rather than
// about latency: does a window come up, is their book called something, does
// typing land, does asking to leave leave, and is the sentence still there
// afterwards.

export interface FirstRunMetrics {
  /** A window with the shell's WM_CLASS appeared against an empty data home. */
  window_opened: boolean;
  /** The name the project carries -- the window title, which is the same string
   *  the project bar and the project list show. */
  project_name: string;
  /** The stem of the file it was created as. Carried so the naming gate can
   *  compare the two rather than check the name is non-empty: `default` IS a
   *  non-empty name, and a gate satisfied by it would pass against the exact
   *  defect this exists for. */
  project_file_stem: string;
  /** The starter outline read directly from SQLite after the first window
   *  appears, before the rig types or drives any menu action. Kept as rows,
   *  rather than a precomputed boolean, so the gate can distinguish the
   *  localized hierarchy from a merely non-empty first project. */
  starter_items: { id: string; type: string; title: string; parent_id: string | null }[];
  /** The project's word count after a sentence was typed into the starter
   *  scene, read back from the STORE and not from the page. */
  words_after_typing: number;
  /** Ctrl+Q closed the window, rather than the rig having to kill it. The only
   *  automated check that the quit chord closes anything -- every unit test of
   *  that path stops at `requestQuit` being called. */
  quit_closed_the_window: boolean;
  /** The typed sentence is in the stored body after the close. Separate from
   *  the gate above on purpose: a window that shut and dropped the last
   *  sentence is not the same defect as one that would not shut. */
  stored_body_holds_the_sentence: boolean;
  peak_rss_mb: number;
}

/** The same RSS ceiling every other rig here states. Restated rather than
 *  imported for the recorded reason: the specification is the source of truth
 *  and two harnesses sharing a constant hide a drift between them. */
const FIRST_RUN_RSS_MB = 750;

export function evaluateFirstRunGates(m: FirstRunMetrics): GateResult[] {
  const named = m.project_name !== "" && m.project_name !== m.project_file_stem;
  const chapter = m.starter_items.find(
    (item) => item.type === "chapter" && item.title === "Kapitel 1" && item.parent_id === null,
  );
  const localizedStarter =
    m.starter_items.length === 2 &&
    chapter !== undefined &&
    m.starter_items.some(
      (item) => item.type === "scene" && item.title === "Szene 1" && item.parent_id === chapter.id,
    );
  return [
    {
      gate: "first_run_opens",
      value: m.window_opened ? "a window appeared" : "NO WINDOW",
      threshold: "an empty data home with no fixture still produces a window",
      verdict: m.window_opened ? "PASS" : "FAIL",
    },
    {
      gate: "first_run_project_is_named",
      value: named
        ? `the project is called "${m.project_name}"`
        : `the project is called "${m.project_name}" and the file is "${m.project_file_stem}"`,
      threshold: "a writer's first book is not named after its file",
      verdict: named ? "PASS" : "FAIL",
    },
    {
      gate: "first_run_starter_titles_localized",
      value: localizedStarter
        ? "Kapitel 1 contains Szene 1"
        : `${m.starter_items.length} starter item(s): ${m.starter_items
            .map((item) => `${item.type} ${JSON.stringify(item.title)} under ${item.parent_id ?? "root"}`)
            .join(", ")}`,
      threshold: 'exactly one root chapter "Kapitel 1" containing one scene "Szene 1"',
      verdict: localizedStarter ? "PASS" : "FAIL",
    },
    {
      gate: "first_run_accepts_typing",
      value: `${m.words_after_typing} word(s) in the store`,
      threshold: "> 0 -- typing into the starter scene reaches the store",
      verdict: m.words_after_typing > 0 ? "PASS" : "FAIL",
    },
    {
      gate: "first_run_quit_closes",
      value: m.quit_closed_the_window ? "Ctrl+Q closed the window" : "THE WINDOW OUTLIVED Ctrl+Q",
      threshold: "the application can be left from inside itself",
      verdict: m.quit_closed_the_window ? "PASS" : "FAIL",
    },
    {
      gate: "first_run_keeps_the_writing",
      value: m.stored_body_holds_the_sentence
        ? "the sentence is in the stored body"
        : "THE SENTENCE IS NOT IN THE STORED BODY",
      threshold: "the close drains what was typed before the process goes",
      verdict: m.stored_body_holds_the_sentence ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `<= ${FIRST_RUN_RSS_MB}`,
      verdict: m.peak_rss_mb <= FIRST_RUN_RSS_MB ? "PASS" : "FAIL",
    },
  ];
}

// Project-lifecycle gates: the switching gates one level up, across whole
// project FILES rather than scenes within one file. Restated from the
// design spec, not imported from anywhere: the specification is the source
// of truth.
//
// Both projects are seeded from the same fixture generator, so item id
// it-000013 exists in both files. A flush that crossed the project swap would
// land on a real row in the wrong manuscript rather than erroring, which is why
// the isolation gate reads both files rather than checking either alone.

export interface ProjectMetrics {
  /** Project A's scene bodies contain the sentence typed into project A. */
  a_holds_own: boolean;
  /** Project A's file contains project B's sentence. This is the defect. */
  a_holds_other: boolean;
  b_holds_own: boolean;
  b_holds_other: boolean;
  /** Both project files' scene bodies were readable after the reopen.
   *  Deliberately WEAKER than it first reads: it says the reopened stores could
   *  be read at all, not that anything typed survived. Every seeded project
   *  already has readable bodies before the run starts, so this can only fail on
   *  an unopenable or emptied file. The claim that the typed text survived is
   *  carried by a_holds_own / b_holds_own, which are read from the reopened
   *  files -- not by this. */
  survived_restart: boolean;
  /** The host refused a doc_flush carrying a superseded generation.
   *
   *  `null` means NOT PROBED, which is a third state and not a failure. A rig
   *  driving the real UI cannot produce a stale flush at all: the page drains
   *  fully before it tears the outgoing project down, so nothing is ever in
   *  flight or armed across a swap. Reporting that as FAIL would claim a flush
   *  was accepted when none was ever sent, which is the same class of lie as a
   *  percentile over zero samples reading as perfect latency. */
  stale_generation_rejected: boolean | null;
  /** How many of the two project files diverged from their seeds. Not read by a
   *  gate here - project-cli uses it as a structural check that aborts before
   *  gates, because with one changed project every gate above is asserting
   *  something about a single manuscript. Do not add a gate for it or delete it
   *  as unused. */
  projects_changed: number;
}

export function evaluateProjectGates(m: ProjectMetrics): GateResult[] {
  const isolated = m.a_holds_own && !m.a_holds_other && m.b_holds_own && !m.b_holds_other;
  return [
    {
      gate: "project_isolation",
      value: isolated
        ? "each project holds its own text and neither holds the other's"
        : `A: own=${m.a_holds_own} other=${m.a_holds_other}; B: own=${m.b_holds_own} other=${m.b_holds_other}`,
      threshold: "each project's scene bodies contain its own sentence and not the other's",
      verdict: isolated ? "PASS" : "FAIL",
    },
    {
      // The threshold says what the predicate actually checks, not what the
      // gate's name suggests. That the typed text survived is
      // project_isolation's claim; this one only rules out a file that could no
      // longer be read.
      gate: "project_persistence",
      value: m.survived_restart ? "both project files readable" : "A PROJECT FILE IS UNREADABLE",
      threshold: "both project files' scene bodies were readable after the reopen",
      verdict: m.survived_restart ? "PASS" : "FAIL",
    },
    {
      // UNKNOWN, never FAIL, when nothing was probed. A gate that reports a
      // verdict on a measurement it did not take is the failure mode this
      // project has hit four times; inverting it to red does not make it honest.
      gate: "project_generation_guard",
      value:
        m.stale_generation_rejected === null
          ? "not probed: the page drains before teardown, so no stale flush can be produced through the UI"
          : m.stale_generation_rejected
            ? "stale-generation flush rejected"
            : "STALE-GENERATION FLUSH ACCEPTED",
      threshold: "a probed doc_flush carrying a superseded generation is rejected by the host",
      verdict:
        m.stale_generation_rejected === null
          ? "UNKNOWN"
          : m.stale_generation_rejected
            ? "PASS"
            : "FAIL",
    },
  ];
}

// Outline-editing gates. Restated from the design spec, not imported from
// anywhere: the specification is the source of truth.
//
// Three of the four structural gates read the REOPENED file, so they say the
// mutation reached the store and survived a SIGKILL, not merely that the screen
// redrew. The fourth (outline_create_visible) is the opposite claim and reads
// the live projection: the item appeared without a remount.
export const OUTLINE_THRESHOLDS = {
  /** Command plus walk re-read plus reproject. Restated at the same number the
   *  hierarchy slice's mutation_p95_ms uses rather than aliasing
   *  HIER_THRESHOLDS: the two describe different operations and are free to
   *  drift, and a shared constant would hide the day they do. */
  mutation_p95_ms: 50,
} as const;

export interface OutlineMetrics {
  /** Rows in the projection after the create minus rows before it. Exactly 1:
   *  0 means nothing appeared, and more than 1 means the pane was rebuilt
   *  rather than extended, which is the remount this gate exists to catch. */
  create_row_delta: number;
  /** The created item's title is present in the post-create walk. The other
   *  half of the same gate: a row count that grew by one proves an item
   *  appeared, not that it is the item that was asked for. */
  create_title_in_walk: boolean;
  /** The create OPENED the row it made: the sentence typed immediately after
   *  the create, with nothing clicked in between, is in the CREATED item's body.
   *  Owner ruling of 2026-09-01, reversing the 2026-08-28 stance this field used
   *  to encode (create_kept_open_doc: the create left the previous document
   *  open). New scene followed by typing wrote into the previous scene, and
   *  every writer who tried it read that as a defect. */
  create_opened_doc: boolean;
  /** The created row, CLICKED AFTERWARDS, actually opens. The other half of the
   *  create's story and a different instant from create_opened_doc: that one
   *  says the create opened its row, this one says a CLICK on that row - the
   *  "same" outcome now - still leaves the writer typing into it.
   *
   *  It exists because the two can both look right while the feature is half
   *  dead. The opener's type lookup read a BOOT-TIME walk, so an item created
   *  in the session had no known type; open.ts treated an unknown type exactly
   *  as it treats a part - a silent early return. The row appeared, the writer
   *  clicked it, and nothing happened, with no banner, ever. Every other gate
   *  in this list passed on that build. */
  created_scene_opens: boolean;
  /** The deleted item is inside a `trash`-typed root in the REOPENED file.
   *
   *  Read from the store rather than from the page: asking the navigator
   *  whether it drew the row under Trash checks the page against itself, and
   *  the whole point of the bin is where the item is, not where it is drawn. */
  deleted_item_in_bin: boolean;
  /** The deleted item's PROSE is still readable in the reopened file.
   *
   *  The gate that makes "nothing is destroyed" a measurement instead of a
   *  claim, and the one a destructive delete would fail while every other gate
   *  here passed: an item removed from the tree outright is also absent from
   *  the export and the search, so those checks cannot tell the two designs
   *  apart. It is also what makes restore possible at all. */
  deleted_body_survives: boolean;
  /** The item deleted in step 9 is OUT of the bin in the REOPENED file, after a
   *  Restore click.
   *
   *  Read from the store for the same reason `deleted_item_in_bin` is: the
   *  claim is about where the item lives, not where the navigator drew it. */
  restored_item_out_of_bin: boolean;
  /** The restored item still carries the prose typed into it before it was
   *  deleted, in the reopened file.
   *
   *  A restore that produced an empty scene would satisfy the gate above and be
   *  worthless. The two together are the whole round trip: the same text, typed
   *  once, survives a delete, a restart, a restore and a second restart. */
  restored_body_survives: boolean;
  /** The restored item is the last root-level row of a MANUSCRIPT type (not
   *  the bin, the bible, or front/back matter), in the REOPENED walk.
   *
   *  An earlier design record claimed Restore appends, and nothing measured it: the
   *  08-15 capture is cut one row above where the bin would show, and
   *  `outline_restore_leaves_the_bin` only checks "out of the bin", which a
   *  restore that lands at the TOP of the manuscript also satisfies. */
  restored_item_is_last_root: boolean;
  /** The bin is still the last root-level row in the REOPENED walk, after the
   *  restore above.
   *
   *  The other half of the same claim: the design record said Restore never
   *  disturbs the bin, and before this fix `restore()` believed it had to
   *  re-sink the bin below an append that never happened. */
  bin_is_last_root: boolean;
  /** The renamed item carries its NEW title in the walk read from the reopened
   *  project file. */
  rename_title_persisted: boolean;
  /** The reordered item's position among its siblings in the reopened file is
   *  the one the screen showed before the kill. */
  reorder_position_match: boolean;
  /** The reordered row's ordinal among its siblings, read from the live store
   *  BEFORE the Alt+Down reorder. Null only if the row was not found, which the
   *  rig treats as a defect elsewhere and never feeds into a gate as null. */
  undo_ordinal_before: number | null;
  /** The same ordinal AFTER the Alt+Down that reorders it, and before Ctrl+Z. */
  undo_ordinal_after_move: number | null;
  /** The same ordinal AFTER Ctrl+Z, with the navigator still focused. */
  undo_ordinal_after_undo: number | null;
  /** Ctrl+Z in the focused navigator returned the row to the ordinal it held
   *  before the reorder, AND the reorder itself actually moved it - the second
   *  conjunct is why this cannot be satisfied by an undo that does nothing to
   *  an item that never moved. */
  undo_restores_order: boolean;
  /** The text typed into the open scene before the mutations is byte-identical
   *  in the reopened file. */
  document_intact: boolean;
  /** The walk after the mutations differs from the walk before them. Not read
   *  by a gate here — outline-cli uses it as a structural check that aborts
   *  before gates, because a run whose mutations all went nowhere would satisfy
   *  the reopen gates trivially. Do not add a gate for it or delete it as
   *  unused. */
  walk_changed: boolean;
  mutations: number;
  /** Not read by a gate; recorded because a p50 beside a p95 is what makes a
   *  latency number readable a year from now. */
  mutation_p50_ms: number;
  mutation_p95_ms: number;
}

// Drafting-essentials gates. Restated from the design spec, not imported
// from anywhere: the specification is the source of truth.
//
// The slice implements ONE rule -- a word is a maximal run of non-whitespace --
// TWICE, in app/ui/src/words.ts and app/shell-tauri/src-tauri/src/words.rs, and
// says so out loud in both files. The two are pinned to a shared case table in
// unit tests, which catches a drift in the RULE. It cannot catch a drift in what
// each side counts OVER: the page counts the open scene from a live ProseMirror
// document, the host counts every stored body by walking serialized JSON, and
// those two traversals are separate code with no shared table at all. A
// divergence there presents to the writer as a project total that is not the sum
// of its scenes -- a number they would notice and could not explain.
// `word_count_agrees` is the gate for that, and it is the reason this slice is
// graded.
export const WORDS_THRESHOLDS = {
  /** A named hypothesis, not a spec-hard number, and deliberately loose:
   *  what the rig can observe is bounded below by its own polling cost (see
   *  WordsMetrics.scan_granularity_ms), so a tight threshold here would be
   *  grading the harness. Set at roughly 3x the bound measured at the tiny
   *  fixture. The number that matters is at stress and is UNMEASURED. */
  scan_ms: 500,
} as const;

export interface WordsMetrics {
  /** The text of the run carrying an `em` mark in the reopened body, or "" when
   *  no marked run was found. Recorded rather than a bare boolean so a reader
   *  can see WHICH word the mark landed on: the rig selects a word with a key
   *  chord and does not choose the word itself. */
  marked_text: string;
  /** That run still carries its `em` mark in the body read from the REOPENED
   *  project file. The whole claim of marks_persist. */
  mark_persisted: boolean;
  /** An `em` mark reached the store during the live session at all. words-cli
   *  uses it as a vacuity guard that aborts before gates, because a run where
   *  the chord never applied a mark would report marks_persist as the
   *  application losing something it was never given. It is ALSO read by
   *  marks_persist, to decide what an empty `marked_text` means: with a mark
   *  confirmed in the store, a reopened body carrying no marked run at all is
   *  the loss the gate names, not an unmeasured state. Do not delete it as
   *  unused. */
  mark_applied_live: boolean;
  /** FNV-1a over the marked scene's body as the killed process left it in the
   *  store. */
  stored_body_hash: string;
  /** FNV-1a over the reopen boot's own re-serialization of that body, from the
   *  page's sink payload -- what the page produced after parsing the stored
   *  JSON through the ProseMirror schema. Equal hashes mean the parse kept
   *  everything the store held. */
  reopen_loaded_body_hash: string;
  /** The host's `project_word_count`, as the project bar displays it. `null`
   *  means NOT READ, which is a third state and not a disagreement. */
  project_total: number | null;
  /** The sum of the page's OWN per-scene word counts over the same saved state,
   *  computed with the page's `countWordsIn` against every stored body. */
  scene_sum: number;
  /** How many stored documents that sum is over. A sum over zero documents is
   *  zero and would agree with a host total of zero, which is why words-cli
   *  aborts on it rather than recording the agreement. */
  scene_docs: number;
  /** The open scene's own figure, as displayed. Recorded, not graded: it is a
   *  live count of one document and the totals above are over the saved state
   *  of all of them, so the two are not comparable and must not be added. */
  scene_words: number | null;
  /** Flush commit observed in the project file -> the displayed project total
   *  repainted, in ms. `null` means NO REPAINT WAS OBSERVED, which is UNKNOWN
   *  and never a passing latency. */
  scan_ms: number | null;
  /** THE RIG'S RESOLUTION FLOOR in ms, from words-floor.ts's `scanFloorMs`:
   *  each of the two polling endpoints contributes its period or its measured
   *  read cost, whichever dominates. `scan_ms` below this number is not a fast
   *  scan that was resolved, it is a number below the noise floor, and the gate
   *  says so rather than printing it bare.
   *
   *  This field used to hold the watcher's median NAME-READ cost alone (0.4 ms
   *  recorded) while the gate called it "the finest interval it can resolve",
   *  which understated the floor ~50x and let a recorded `scan_ms: 2` read as a
   *  measurement. */
  scan_granularity_ms: number;
  /** The two costs the floor is built from, recorded so the derivation is
   *  checkable against WATCH_POLL_MS / COMMIT_POLL_MS by a later reader. */
  scan_watch_read_ms: number;
  scan_commit_read_ms: number;
  /** The ATK role the word count maps to, or `null` when nothing in the tree
   *  carried its id. THE ATK ROLE, never the `xml-roles` attribute: 36 navigator
   *  rows once carried `xml-roles:treeitem` while mapping to ATK `section`, and
   *  an attribute match would have passed an exposure gate on markup no screen
   *  reader could read. */
  a11y_role: string | null;
  /** Its accessible name, "" when it has none. A node with no name is a node a
   *  screen reader announces as nothing. */
  a11y_name: string;
  /** Its text as the Text interface reports it, "" when it exposes none. */
  a11y_text: string;
  /** That text carries BOTH figures - the scene count and the saved project
   *  total. Half a count is a number a writer would misread. */
  a11y_text_has_both_figures: boolean;
  /** The two figures parsed out of the VISIBLE text, and the two parsed out of
   *  the ACCESSIBLE NAME, as they were read off the live accessibility tree.
   *  `null` when that channel did not parse at all - which the exposure gate
   *  above already fails on, so this one reports NOT COMPARED rather than
   *  claiming a disagreement it did not observe.
   *
   *  Two channels because the page formats them SEPARATELY: the bar gets
   *  "47 words · 2,000 in the book" and a screen reader gets "Word count: 47 words in
   *  this scene, 2,000 saved in the project". That split is deliberate (a bar
   *  beside five controls wants brevity; a listener with no layout needs the
   *  sentence) and it is what this pair exists to police. Before it, the name
   *  was built by reading the visible spans back out of the DOM - impossible to
   *  drift, and impossible to shorten. */
  a11y_text_figures: readonly [string, string] | null;
  a11y_name_figures: readonly [string, string] | null;
}

/** ATK roles that mean "the platform did not accept this as anything". A node
 *  mapping to one of these is in the tree but is not exposed as a thing:
 *  `section` is what the navigator's rows degraded to when an untyped wrapper
 *  voided their role mapping, and it does not support name-from-content. */
const UNUSABLE_ATK_ROLES = new Set([
  "section",
  "unknown",
  "invalid",
  "filler",
  "redundant object",
]);

export function evaluateWordsGates(m: WordsMetrics): GateResult[] {
  const roleUsable = m.a11y_role !== null && !UNUSABLE_ATK_ROLES.has(m.a11y_role.toLowerCase());
  return [
    {
      // Not "an em mark exists somewhere": the mark has to be on the run the
      // rig watched it applied to. A body that gained a mark elsewhere would
      // satisfy the weaker claim while the marked word lost its own.
      gate: "marks_persist",
      value:
        m.marked_text.length === 0
          ? "no marked run in the reopened body"
          : m.mark_persisted
            ? `"${m.marked_text}" still carries em`
            : `"${m.marked_text}" LOST ITS em MARK`,
      // THE THRESHOLD STATES THE EXCLUSION, because the verdict line is what
      // gets read, quoted and pasted into a summary - an exclusion recorded
      // only in metrics.scope is an exclusion nobody sees. Same precedent as
      // outline_mutation_p95_ms carrying "KEYBOARD-DRIVEN SAMPLES ONLY".
      //
      // What it excludes: the reopen boot soaks 0 ms with 0 mutations and the
      // page flushes only on a docChanged transaction, so it writes nothing
      // back. The body this gate reads is the body the killed process left, and
      // a schema that dropped `em` ON THE WAY IN would not disturb it. This
      // gate is a claim about the STORE across a SIGKILL and a reopen, and it
      // is unfalsifiable end to end on its own.
      threshold:
        "STORE-SIDE LOSS ONLY - the word italicised with Mod-i carries its em mark in the body " +
        "read from the reopened project file. This CANNOT detect a parse-side loss: the reopen " +
        "boot writes nothing back, so a page that dropped the mark while parsing would leave " +
        "these bytes intact and this gate would still PASS. reopen_parse_intact is the gate that " +
        "sees that half",
      // No marked run at all is a FAIL once mark_applied_live is true, and that
      // is the whole failure this gate covers: the mark REACHED the store during
      // the live session, so a reopened body with no marked run anywhere is
      // exactly the loss. It read UNKNOWN until 2026-08-12, on the false
      // reasoning that "the rig aborts on that" - mark_applied_live guards the
      // LIVE session, not the reopen, so a mark lost between them landed here
      // and rendered as "not measured". FAIL was then reachable only when the
      // reopened body carried some OTHER marked run, i.e. a mark that moved
      // rather than a mark that was lost.
      //
      // With mark_applied_live false nothing was given, so nothing can have been
      // lost: UNKNOWN, and words-cli aborts before reaching here anyway.
      verdict:
        m.marked_text.length === 0
          ? m.mark_applied_live
            ? "FAIL"
            : "UNKNOWN"
          : m.mark_persisted
            ? "PASS"
            : "FAIL",
    },
    {
      // THE OTHER HALF OF THE ROUND TRIP, and it is a separate gate because it
      // is a separate claim: marks_persist reads the FILE, which SQLite would
      // keep intact even if the page could no longer parse what is in it. This
      // one reads what the reopen boot's own page produced after parsing that
      // body through the ProseMirror schema.
      //
      // It is graded rather than merely recorded because the parse claim was
      // otherwise FREE. The reopen boot soaks 0 ms with 0 mutations and the page
      // flushes only on a docChanged transaction, so it writes nothing back:
      // a schema that dropped `em` on the way IN would leave the stored body
      // untouched and marks_persist would still pass. Only comparing the page's
      // re-serialization against the stored bytes can see it.
      //
      // A hash is sensitive to more than marks, and that is accepted: a reopen
      // that re-serializes a manuscript differently from how it was stored is a
      // finding either way, and the two hashes are recorded so a FAIL can be
      // diffed rather than guessed at.
      gate: "reopen_parse_intact",
      value:
        m.stored_body_hash === m.reopen_loaded_body_hash
          ? `${m.stored_body_hash} re-serialized unchanged`
          : `STORED ${m.stored_body_hash} vs REOPENED ${m.reopen_loaded_body_hash}`,
      threshold:
        "the reopen boot's re-serialization of the marked scene is byte-identical (by FNV-1a) to " +
        "the body the killed process left in the store - the page parsed everything the store held",
      verdict: m.stored_body_hash === m.reopen_loaded_body_hash ? "PASS" : "FAIL",
    },
    {
      // THE DRIFT DETECTOR. Two implementations of one rule, over two different
      // traversals of the same manuscript, compared on one number.
      gate: "word_count_agrees",
      value:
        m.project_total === null
          ? "not read: the displayed project total was never observed"
          : m.project_total === m.scene_sum
            ? `${m.project_total} == ${m.scene_sum} over ${m.scene_docs} document(s)`
            : `HOST ${m.project_total} vs PAGE ${m.scene_sum} over ${m.scene_docs} document(s) ` +
              `(delta ${m.project_total - m.scene_sum})`,
      threshold:
        "the host's project_word_count == the sum of the page's per-scene counts over the same " +
        "saved state",
      verdict:
        m.project_total === null ? "UNKNOWN" : m.project_total === m.scene_sum ? "PASS" : "FAIL",
    },
    {
      // The threshold string states what the interval actually spans, because
      // the VERDICT LINE is what gets read and quoted. Nothing outside the page
      // can time project_word_count on its own: the command is reachable only
      // through the page and the page reports neither the figure nor the
      // latency, so the only observable is the exposed count changing. An UPPER
      // BOUND on the scan, not the scan.
      gate: "word_count_scan_ms",
      value:
        m.scan_ms === null
          ? "no repaint observed"
          : m.scan_ms < m.scan_granularity_ms
            ? `${m.scan_ms} - below the rig's ~${m.scan_granularity_ms} ms floor, so bounded but ` +
              "NOT RESOLVED"
            : m.scan_ms,
      threshold:
        `< ${WORDS_THRESHOLDS.scan_ms} (flush commit observed in the project file -> the project ` +
        "bar's total repainted: an UPPER BOUND covering the flush ack, the page's un-awaited " +
        `refresh, the IPC, the full scan, the repaint AND the rig's own ~${m.scan_granularity_ms} ms ` +
        "RESOLUTION FLOOR - both endpoints are polled, so the floor is the watcher's 20 ms period " +
        "plus a fresh-connection store read, not the cost of one display read)",
      // A latency with no observed repaint is not a fast scan, it is no
      // measurement.
      verdict: m.scan_ms === null ? "UNKNOWN" : threshold(m.scan_ms, WORDS_THRESHOLDS.scan_ms),
    },
    {
      // THE DEFECT DETECTOR. Until 2026-08-12 the word count was absent from the
      // accessibility tree entirely: a full AT-SPI walk showed `document web`
      // with four children and #word-count among none of them, so a screen
      // reader user could not read their own word count. It went unnoticed for a
      // whole slice because nothing graded it, and the rig worked around it by
      // triple-clicking the project bar and scraping the X PRIMARY selection.
      // Both halves are fixed together, and this is what keeps them fixed: a
      // regression in the markup now FAILs here rather than quietly costing the
      // rig its only channel.
      //
      // Three conjuncts, one gate, deliberately: they are one claim - the count
      // is readable. Split apart, a run could report a node that is present,
      // roled and nameless as two-thirds of a pass, and a nameless node is
      // announced as nothing.
      //
      // An absent node is a FAIL, not an UNKNOWN. UNKNOWN is for a measurement
      // that was not taken; this one was taken and the answer was no.
      gate: "a11y_word_count_exposed",
      value:
        m.a11y_role === null
          ? "ABSENT from the accessibility tree"
          : `ATK role "${m.a11y_role}", name ${JSON.stringify(m.a11y_name)}, text ${
              m.a11y_text_has_both_figures ? "carries both figures" : JSON.stringify(m.a11y_text)
            }`,
      threshold:
        "the word count is in the platform accessibility tree under a usable ATK role, carries a " +
        "non-empty accessible name, and its text carries both figures (the open scene's count " +
        "and the project's saved total)",
      verdict:
        roleUsable && m.a11y_name.length > 0 && m.a11y_text_has_both_figures ? "PASS" : "FAIL",
    },
    {
      // THE GUARD ON A DELIBERATE DUPLICATION. The word count is formatted
      // twice from one pair of numbers - once compactly for the bar, once as a
      // sentence for the accessible name - because the two audiences need
      // different things and one string cannot serve both. Two renderings can
      // disagree, and a disagreement here means a screen reader user and a
      // sighted user are told different word counts, which is worse than either
      // formatting alone.
      //
      // The page cannot catch this: both strings come from the same two
      // variables there, so a drift is in the WORDING, not the data. It is only
      // observable from outside, off the live accessibility tree, which is what
      // this run already walks.
      //
      // UNKNOWN, not FAIL, when either channel failed to parse. That is the
      // exposure gate's finding above and it reports it precisely; repeating it
      // here as a second FAIL would double-count one defect, and calling it a
      // disagreement would name the wrong one.
      gate: "a11y_word_count_agrees",
      value:
        m.a11y_text_figures === null || m.a11y_name_figures === null
          ? "NOT COMPARED: one channel did not parse"
          : `screen "${m.a11y_text_figures.join(" / ")}" vs announced "${
              m.a11y_name_figures.join(" / ")
            }"`,
      threshold:
        "the scene figure and the project figure shown on screen are the same two figures the " +
        "accessible name announces (the WORDING around them differs by design; the NUMBERS may " +
        "not)",
      verdict:
        m.a11y_text_figures === null || m.a11y_name_figures === null
          ? "UNKNOWN"
          : m.a11y_text_figures[0] === m.a11y_name_figures[0] &&
              m.a11y_text_figures[1] === m.a11y_name_figures[1]
            ? "PASS"
            : "FAIL",
    },
  ];
}

// Export gates. Restated from the design spec, not
// imported from anywhere: the specification is the source of truth.
//
// The fidelity gate is the one that has to be read carefully. It strips the
// syntax THIS EXPORTER EMITS, with a reader the harness owns
// (app/harness/src/markdown-read.ts), and compares the result to the text the
// store holds. That shows the exporter can read back what it wrote. It does NOT
// show that every CommonMark reader agrees, because there is no CommonMark
// parser in this project and adding one to grade a run would make the run a
// test of that parser. The threshold string says so, because a verdict line
// reading `export_text_fidelity PASS` and meaning something narrower than it
// sounds is exactly the failure this project has caught six times.
export const EXPORT_THRESHOLDS = {
  /** Named hypotheses, not spec-hard numbers, and PER FIXTURE because the
   *  cost is O(manuscript): `tiny` is a couple of dozen items, `stress` is
   *  20,000 items and 15,200 documents parsed as JSON. A latency without its
   *  fixture means nothing, so an unlisted fixture reports UNKNOWN rather than
   *  borrowing a bound nobody set for it.
   *
   *  Set as TOLERANCE bounds rather than fitted to a measurement: a writer who
   *  has chosen File > Export manuscript waits for it with nothing else to do,
   *  and past a couple of seconds the command reads as broken. A threshold an
   *  order of magnitude
   *  above what the design costs is a gate nobody would ever see fail, which is
   *  the same failure as no gate at all. */
  export_ms: { tiny: 1000, stress: 3000 } as Record<string, number>,
} as const;

export interface ExportMetrics {
  /** Which fixture the run drove. Not decoration: both latency and memory are
   *  O(manuscript), and their threshold strings name it. */
  fixture: string;
  /** Items in the store's depth-first walk. */
  export_items: number;
  /** Markdown-only generated contents: verified against the walked titles
   *  before any export gate is evaluated. False on an empty walk, where the
   *  check does not apply. This says nothing about EPUB or PDF navigation. */
  export_markdown_contents_verified: boolean;
  export_markdown_contents_entries: number;
  /** `##`..`######` headings in the exported file. The project name's H1 is not
   *  one of them -- it is the manuscript's title, not an item. */
  export_headings: number;
  /** Of those headings, how many sit at the level their walk item calls for:
   *  `min(depth + 2, 6)`, RESTATED BY THE RIG from the format spec and never
   *  imported from export.rs. Compared BY INDEX, like everything else here.
   *
   *  It exists because the counts alone were the whole predicate until
   *  2026-08-12 while the gate's name and threshold both said "at the expected
   *  level": an exporter that flattened every item onto `##` emits one heading
   *  per item, in order, and passed. The levels were parsed by markdown-read.ts
   *  and unit-tested there, and read by no gate at all. */
  export_levels_matched: number;
  /** Scenes whose stored body held text and whose exported prose was therefore
   *  compared. Sections are aligned to walk items BY INDEX, never by title:
   *  2,292 of the 20,000 stress items share a title. */
  export_scenes_compared: number;
  export_scenes_matched: number;
  /** Words in the exported prose, counted by the rig over its own stripped
   *  text with headings excluded. */
  export_words: number;
  /** The host's `project_word_count`, as the project bar displays it. `null`
   *  means NOT READ, which is a third state and not a disagreement. */
  project_words: number | null;
  /** Emphasis-delimited runs in the exported file carrying the word this run
   *  italicised with Mod-i. */
  export_marks_found: number;
  /** An `em` mark reached the store during the live session at all. export-cli
   *  aborts before the gates when this is false; it is read here so the gate is
   *  honest in isolation -- with nothing given, nothing can have been lost, and
   *  a FAIL would blame the application for the rig. Do not delete it as
   *  unused. */
  marks_applied_live: boolean;
  /** Underlined runs in the scene this run typed into, as the STORE holds them
   *  at the end of the session. The rig applies exactly one with Mod-u and
   *  counts what the store kept, restating the rule (a text node whose `marks`
   *  array carries `underline`) rather than importing it from either side. */
  underlined_runs_in_scene: number;
  /** Occurrences of underline-looking markup in the exported file: `<u>`,
   *  `</u>` and a `__` pair. Zero is the PASS. Emitting HTML into the Markdown
   *  was the rejected fix -- it breaks the escaper, the importer and the
   *  readable mirror's accept path, and the third silently strips every
   *  underline in the document. */
  export_underline_markup_found: number;
  /** The figure the APPLICATION told the writer, parsed out of the export
   *  notice on the live accessibility tree. `null` means NOT READ -- a third
   *  state, not agreement: the banner removes itself after six seconds. */
  export_underline_reported: number | null;
  /** The sentence typed immediately before Export was activated is in the file. */
  export_last_sentence_present: boolean;
  export_second_path_differs: boolean;
  export_first_unchanged: boolean;
  export_ms: number;
}

export function evaluateExportGates(m: ExportMetrics): GateResult[] {
  const msLimit = EXPORT_THRESHOLDS.export_ms[m.fixture];
  return [
    {
      // Counts AND levels. That the prose under each heading is the store's
      // prose is export_text_fidelity's claim, and the index alignment the two
      // share is sound exactly because this gate compares the counts first.
      //
      // The level half is not decoration on the count. One heading per item, in
      // order, at `##` for every one of them is a manuscript whose hierarchy is
      // gone -- parts, chapters and scenes rendered as siblings -- and it
      // satisfies the counts exactly. That was a PASS until 2026-08-12.
      gate: "export_structure",
      value:
        m.export_items === 0
          ? "no items in the walk"
          : `${m.export_headings} heading(s) for ${m.export_items} walked item(s); ` +
            `${m.export_levels_matched} at the expected level`,
      threshold:
        "one heading per item in the store's depth-first walk, AT THE EXPECTED LEVEL: " +
        "`##`..`######` heading count == the walk's item count == the number of headings whose " +
        "level matches, and all > 0. The expected level for the item at walk index i is " +
        "`min(depth + 2, 6)`, RESTATED by this rig from the format spec and NOT imported from " +
        "export.rs -- a rig taking the rule from the emitter would check the exporter against " +
        "itself and this half would grade a tautology. The project name's H1 is NOT counted -- " +
        "it is the manuscript's title, not an item",
      // 0 == 0 is the dangerous agreement: an empty file satisfies an empty
      // manuscript. UNKNOWN, never PASS.
      verdict:
        m.export_items === 0
          ? "UNKNOWN"
          : m.export_headings === m.export_items && m.export_levels_matched === m.export_items
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "export_text_fidelity",
      value:
        m.export_scenes_compared === 0
          ? "no scene was compared"
          : m.export_scenes_matched === m.export_scenes_compared
            ? `${m.export_scenes_matched} of ${m.export_scenes_compared} scene(s) round-tripped`
            : `${m.export_scenes_matched} of ${m.export_scenes_compared} scene(s) round-tripped; ` +
              `${m.export_scenes_compared - m.export_scenes_matched} MISMATCH(ES)`,
      threshold:
        "every compared scene's exported prose, stripped by THIS RIG'S OWN READER " +
        "(app/harness/src/markdown-read.ts) and NOT a CommonMark reference implementation, " +
        "equals the text of its stored ProseMirror body. A NECESSARY CONDITION -- the exporter " +
        "can read back what it wrote -- not a claim that any other Markdown reader agrees. Both " +
        "sides are whitespace-normalized (every run of whitespace collapsed to one space, then " +
        "trimmed) because the exporter trim_end's each block while the store keeps what was " +
        "typed, so a WHITESPACE-ONLY difference is invisible to this gate",
      verdict:
        m.export_scenes_compared === 0
          ? "UNKNOWN"
          : m.export_scenes_matched === m.export_scenes_compared
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "export_word_count_agrees",
      value:
        m.project_words === null
          ? "not read: the displayed project total was never observed"
          : m.export_words === 0
            ? "the exported file holds 0 words"
            : m.export_words === m.project_words
              ? `${m.export_words} == ${m.project_words}`
              : `EXPORT ${m.export_words} vs HOST ${m.project_words} ` +
                `(delta ${m.export_words - m.project_words})`,
      threshold:
        "words in the exported prose (headings excluded, counted by this rig over its own " +
        "stripped text) == the host's project_word_count as the footer displays it, and " +
        "> 0. THE TWO SIDES COUNT OVER DIFFERENT SETS ON PURPOSE: the export counts items in " +
        "the walk, the host counts every `doc` row. A row whose item is not in the walk is prose " +
        "missing from the manuscript, and this gate is the tripwire for it -- not a tolerance",
      // Zero words agreeing with zero is agreement about nothing.
      verdict:
        m.project_words === null || m.export_words === 0
          ? "UNKNOWN"
          : m.export_words === m.project_words
            ? "PASS"
            : "FAIL",
    },
    {
      // TWO CLAIMS AND A TRAP, because "the exporter dropped it" and "the writer
      // was told" are different things and a slice that shipped the first alone
      // would have shipped a silent loss.
      gate: "export_underline_loss_reported",
      value:
        m.underlined_runs_in_scene === 0
          ? "no underline reached the store, and none was applied"
          : m.export_underline_markup_found > 0
            ? `UNDERLINE MARKUP IN THE FILE: ${m.export_underline_markup_found} occurrence(s)`
            : m.export_underline_reported === null
              ? `${m.underlined_runs_in_scene} underlined run(s) dropped; the export notice was not read`
              : m.export_underline_reported === m.underlined_runs_in_scene
                ? `${m.underlined_runs_in_scene} underlined run(s) dropped and reported`
                : `STORE ${m.underlined_runs_in_scene} vs REPORTED ${m.export_underline_reported}`,
      threshold:
        "a run underlined with Mod-u during the session is in the exported file as PLAIN TEXT, " +
        "the file carries no `<u>`/`</u>`/`__` markup, and the export notice reports exactly as " +
        "many dropped runs as the store holds. Markdown has no underline, so the drop is the " +
        "designed behaviour and the TALLY is what makes it not a silent loss. The reported " +
        "figure is read off the live accessibility tree, so `not read` is a third state and " +
        "never agreement",
      verdict:
        m.underlined_runs_in_scene === 0
          ? "UNKNOWN"
          : m.export_underline_markup_found > 0
            ? "FAIL"
            : m.export_underline_reported === null
              ? "UNKNOWN"
              : m.export_underline_reported === m.underlined_runs_in_scene
                ? "PASS"
                : "FAIL",
    },
    {
      gate: "export_marks_survive",
      value:
        m.export_marks_found > 0
          ? `${m.export_marks_found} emphasis-delimited run(s) carry the italicised word`
          : m.marks_applied_live
            ? "no emphasis in the file for a word the store holds marked"
            : "no emphasis in the file, and none was applied",
      threshold:
        "> 0 emphasis-delimited runs in the exported prose carry the word this run italicised " +
        "with Mod-i. `*`/`**`/`***` are the only inline markup this exporter emits, so the " +
        "rig's reader has one thing to look for",
      // Nothing given, nothing lost. export-cli aborts before this, but the
      // gate must not report a FAIL on a measurement that was never taken.
      verdict: m.export_marks_found > 0 ? "PASS" : m.marks_applied_live ? "FAIL" : "UNKNOWN",
    },
    {
      gate: "export_includes_last_keystroke",
      value: m.export_last_sentence_present
        ? "the last sentence typed before the export is in the file"
        : "THE LAST SENTENCE TYPED BEFORE THE EXPORT IS NOT IN THE FILE",
      threshold:
        "the sentence typed immediately before Export was activated is in the exported file. " +
        "THE CLAIM IS THE PAGE'S drain(), NOT THE FLUSH DEBOUNCE: the rig re-reads the store " +
        "between the last keystroke and the activation and aborts without writing if the " +
        "1000 ms debounce had already committed the sentence, because then the file would hold " +
        "it either way and this gate would prove nothing. The route is the application menu as " +
        "of the retirement slice, and metrics.debounce_window_used_ms records how much of the " +
        "debounce elapsed before the prelocated Export item was clicked",
      verdict: m.export_last_sentence_present ? "PASS" : "FAIL",
    },
    {
      gate: "export_never_clobbers",
      value:
        m.export_second_path_differs && m.export_first_unchanged
          ? "two exports, two paths, first file byte-identical"
          : [
              m.export_second_path_differs ? null : "SECOND EXPORT TOOK THE SAME PATH",
              m.export_first_unchanged ? null : "THE FIRST FILE CHANGED",
            ]
              .filter((s) => s !== null)
              .join("; "),
      threshold:
        "a second export returns a different path AND leaves the first file's bytes unchanged. " +
        "A manuscript is evidence and evidence is never silently overwritten",
      verdict: m.export_second_path_differs && m.export_first_unchanged ? "PASS" : "FAIL",
    },
    {
      gate: "export_ms",
      value: m.export_ms,
      threshold:
        msLimit === undefined
          ? `no threshold is stated for the "${m.fixture}" fixture, and borrowing another ` +
            "fixture's bound would report a number as passing something nobody set for it"
          : `< ${msLimit} at the "${m.fixture}" fixture (the number means nothing without it: ` +
            "the cost is O(manuscript)). From the pointer click on the prelocated menu item to " +
            "the exported file being complete and stable on disk, so it INCLUDES pointer delivery, " +
            "the page's flush drain and this rig's file polling period -- it is an UPPER BOUND " +
            "on project_export, not its latency",
      verdict: msLimit === undefined ? "UNKNOWN" : threshold(m.export_ms, msLimit),
    },
    {
      gate: "peak_rss_mb",
      value: "not measured",
      threshold:
        `export working memory unavailable at the "${m.fixture}" fixture: runner sampling ends ` +
        "before interactive export, so the readiness peak cannot grade the export body",
      verdict: "UNKNOWN",
    },
  ];
}

// Find gates. Restated from the design spec, not
// imported from find.rs: the specification is the source of truth, and a rig
// taking its rule from the implementation checks the implementation against
// itself.
//
// `find_total_matches_oracle` is the load-bearing one. The others check that
// search WORKS -- a typed sentence is findable, a title matches, casing does not
// matter. Only the oracle checks that it is COMPLETE, and completeness is the
// property a writer cannot verify for themselves: a search that silently misses
// a scene is indistinguishable from a scene that does not contain the word.
// THERE IS NO find_ms GATE, and that is a measurement result rather than an
// omission.
//
// The design proposed one. The only channel through which this rig can observe
// that a search has finished is the accessibility tree, and polling AT-SPI fast
// enough to time a sub-second operation WEDGES THE WEBKITGTK BRIDGE: the
// application leaves the desktop list and does not come back. That is a
// recorded property of this platform, and the first find run reproduced it
// exactly -- a 250 ms poll got through two searches before the third probe
// returned no matching application at all.
//
// A poll interval slow enough to be safe is ~2.5 s, which is larger than the
// thing being measured, so any figure it produced would be a measurement of the
// rig's own sleep. Reporting that as `find_ms` would be worse than reporting
// nothing: this project has caught six instruments claiming more than they
// earned, and a latency gate whose value is its own polling period would be the
// seventh. The scan's cost is argued from the word-index measurement in the
// design instead, and is stated there as an argument rather than as evidence.

export interface FindMetrics {
  /** Which fixture the run drove. Not decoration: the scan and the memory are
   *  both O(manuscript), and their threshold strings name it. */
  fixture: string;
  /** The cap the page asked the host for. Restated in the truncation gate's
   *  value line so a reader can see what "capped" meant on this run. */
  find_limit: number;

  /** Items the RIG's own scan of the store says contain the oracle term, over
   *  its own restatement of the plain-text projection. */
  oracle_matches: number;
  /** `total` the application reported for that same term, read out of
   *  #find-status. `null` means NOT READ, which is a third state and not a
   *  disagreement. */
  reported_total: number | null;

  /** Rows the application returned for the nonce sentence typed into the boot
   *  scene, and the item the single row named. */
  typed_hits: number;
  typed_item: string | null;
  typed_expected_item: string | null;

  /** A term drawn from a seeded item's TITLE, and whether that item came back.
   *  Its type is recorded because the case worth having is a part or chapter,
   *  which holds no prose at all and can only match by title. */
  title_hits: number;
  title_found_expected: boolean;
  title_expected_kind: string | null;

  /** The ordered item-id lists from three casings of one query agreed. */
  case_variants_agree: boolean;
  /** How many rows each casing returned. 0 makes the agreement vacuous. */
  case_variant_hits: number;

  /** Snippets checked against the rig's own projection of that item's stored
   *  text, and how many were found in it. */
  snippets_checked: number;
  snippets_contained: number;

  /** The truncation probe. `null` throughout when the fixture cannot produce
   *  more matches than the cap -- at `tiny` there are not enough items, and a
   *  gate that cannot fail must not report PASS. */
  truncation_total: number | null;
  truncation_shown: number | null;
  truncation_reported: boolean | null;

  /** Rows and status text after searching for nothing at all. */
  empty_query_hits: number | null;

  /** The query whose result was activated to test the reveal. */
  reveal_query: string;
  /** What the editor showed SELECTED after that activation, read off AT-SPI's
   *  text interface, or null when nothing was selected.
   *
   *  AT-SPI and not the X PRIMARY selection: PRIMARY silently returns the
   *  PREVIOUS selection when a chord selects nothing, which reads as success. */
  reveal_selection: string | null;

  peak_rss_mb: number;
}

/** Case-folds one code point at a time, the way the host and the page both do.
 *  `toLowerCase()` on the whole string applies Unicode SpecialCasing, so a
 *  word-final sigma folds to a form neither of them produces - and this gate
 *  would report a mismatch on a reveal that was correct. */
function foldPerCodePoint(text: string): string {
  let out = "";
  for (const codePoint of text) out += codePoint.toLowerCase();
  return out;
}

export function evaluateFindGates(m: FindMetrics): GateResult[] {
  return [
    {
      // FIRST, because it is the only gate here that grades completeness, and
      // every other gate is conditional on the search having run at all.
      gate: "find_total_matches_oracle",
      value:
        m.reported_total === null
          ? "not read: #find-status never reported a total"
          : m.oracle_matches === 0
            ? "the rig's own scan found 0 matching items"
            : m.reported_total === m.oracle_matches
              ? `${m.reported_total} == ${m.oracle_matches}`
              : `APP ${m.reported_total} vs ORACLE ${m.oracle_matches} ` +
                `(delta ${m.reported_total - m.oracle_matches})`,
      threshold:
        "the total the application reports == the number of items THIS RIG finds by scanning the " +
        "store directly with bun:sqlite and projecting each body to text with its OWN " +
        "restatement of the plain-text walk, never imported from find.rs. Both counts are of " +
        "ITEMS, not occurrences. This is the completeness claim and it is the only one here: a " +
        "search that silently misses a scene is indistinguishable, to a writer, from a scene " +
        "that does not contain the word",
      // 0 == 0 is the dangerous agreement: a term nothing contains is satisfied
      // by a search that returns nothing for every term.
      verdict:
        m.reported_total === null || m.oracle_matches === 0
          ? "UNKNOWN"
          : m.reported_total === m.oracle_matches
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "find_locates_typed_sentence",
      value:
        m.typed_expected_item === null
          ? "the rig never established which item it typed into"
          : m.typed_hits === 1 && m.typed_item === m.typed_expected_item
            ? `1 hit, at the item typed into (${m.typed_expected_item})`
            : `${m.typed_hits} hit(s); named item ${m.typed_item ?? "none"}, ` +
              `expected ${m.typed_expected_item}`,
      threshold:
        "a nonce sentence typed into the boot scene and drained is found by exactly one item, " +
        "and that item is the one it was typed into. The sentence is a nonce so the count is " +
        "exact rather than a lower bound; the rig verifies the sentence reached the STORE before " +
        "searching, so a failure here is the search's and not the drain's",
      verdict:
        m.typed_expected_item === null
          ? "UNKNOWN"
          : m.typed_hits === 1 && m.typed_item === m.typed_expected_item
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "find_title_match",
      value:
        m.title_expected_kind === null
          ? "no seeded item's title supplied a term"
          : m.title_found_expected
            ? `found, and the item is a ${m.title_expected_kind}`
            : `NOT FOUND (${m.title_hits} hit(s) for a term from a ${m.title_expected_kind}'s title)`,
      threshold:
        "a term taken from a seeded item's TITLE returns that item. Graded against a PART or a " +
        "CHAPTER wherever the fixture has one, because those hold no document at all: restricting " +
        "search to prose would silently exclude every part and chapter in the book, which is " +
        "where a writer looks for a character name first",
      verdict:
        m.title_expected_kind === null ? "UNKNOWN" : m.title_found_expected ? "PASS" : "FAIL",
    },
    {
      gate: "find_case_insensitive",
      value:
        m.case_variant_hits === 0
          ? "every casing returned 0 rows, so agreement means nothing"
          : m.case_variants_agree
            ? `3 casings returned the same ${m.case_variant_hits} item(s), in the same order`
            : `3 casings DISAGREED (${m.case_variant_hits} row(s) in the first)`,
      threshold:
        "lower, upper and mixed casings of one query return the same item ids in the same order. " +
        "Compared by the DOM id each result row carries (`find-row-<itemId>`), never by title: " +
        "2,292 of the 20,000 stress items share a title",
      // Three empty lists agree perfectly and prove nothing.
      verdict:
        m.case_variant_hits === 0 ? "UNKNOWN" : m.case_variants_agree ? "PASS" : "FAIL",
    },
    {
      gate: "find_snippet_fidelity",
      value:
        m.snippets_checked === 0
          ? "no snippet was checked"
          : m.snippets_contained === m.snippets_checked
            ? `${m.snippets_contained} of ${m.snippets_checked} snippet(s) occur in their item's text`
            : `${m.snippets_contained} of ${m.snippets_checked}; ` +
              `${m.snippets_checked - m.snippets_contained} NOT IN THE STORED TEXT`,
      threshold:
        "every prose snippet, with its leading and trailing ellipsis characters removed, occurs " +
        "VERBATIM in the text of that item's stored body as this rig projects it. A STRICT " +
        "containment check, with no whitespace normalization on either side -- the snippet is an " +
        "exact substring by construction, so normalizing would make a real difference invisible, " +
        "which is what the export slice's fidelity gate had to give up. Title-only hits carry no " +
        "snippet and are not counted here",
      verdict:
        m.snippets_checked === 0
          ? "UNKNOWN"
          : m.snippets_contained === m.snippets_checked
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "find_truncation_honest",
      value:
        m.truncation_total === null
          ? `not probed: no term at the "${m.fixture}" fixture matches more than the ${m.find_limit} cap`
          : m.truncation_reported === true &&
              m.truncation_total > m.find_limit &&
              m.truncation_shown === m.find_limit
            ? `${m.truncation_shown} shown of ${m.truncation_total}, and the panel says so`
            : `${m.truncation_shown} shown of ${m.truncation_total}; ` +
              `panel ${m.truncation_reported === true ? "says" : "DOES NOT SAY"} it is capped`,
      threshold:
        `a query matching more than the ${m.find_limit}-item cap shows exactly the cap, reports a ` +
        "total ABOVE it, and says on screen that the list is partial. A cap nobody is told about " +
        "reads as completeness -- the same defect class as a silently truncated export. UNKNOWN " +
        "rather than PASS where the fixture cannot produce enough matches to cap, because a gate " +
        "that cannot fail must not report a pass",
      verdict:
        m.truncation_total === null
          ? "UNKNOWN"
          : m.truncation_reported === true &&
              m.truncation_total > m.find_limit &&
              m.truncation_shown === m.find_limit
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "find_empty_query_empty_result",
      value:
        m.empty_query_hits === null
          ? "not probed"
          : m.empty_query_hits === 0
            ? "no rows, no error"
            : `${m.empty_query_hits} ROW(S) FOR AN EMPTY QUERY`,
      threshold:
        "searching for nothing returns nothing and raises no error. Matching the empty string " +
        "against every document would return the entire book, which reads as a catastrophic bug " +
        "rather than as an empty query",
      verdict:
        m.empty_query_hits === null ? "UNKNOWN" : m.empty_query_hits === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "find_reveal_selects_the_match",
      value:
        m.reveal_selection === null
          ? "NOTHING SELECTED after activating the result"
          : foldPerCodePoint(m.reveal_selection) === foldPerCodePoint(m.reveal_query)
            ? `the editor selected ${JSON.stringify(m.reveal_selection)}`
            : `the editor selected ${JSON.stringify(m.reveal_selection)}, NOT the query ` +
              `${JSON.stringify(m.reveal_query)}`,
      threshold:
        "after arrowing onto a result and pressing Return, the text the EDITOR shows selected is " +
        "the query that was searched for, compared case-insensitively by folding one code point " +
        "at a time. Read off AT-SPI's text interface against the live window, which is the only " +
        "channel that can answer what a writer would SEE highlighted -- the page's own report " +
        "would be the page checking itself, and the X PRIMARY selection returns the PREVIOUS " +
        "selection when a chord selects nothing, which reads as success",
      verdict:
        m.reveal_selection !== null &&
        foldPerCodePoint(m.reveal_selection) === foldPerCodePoint(m.reveal_query)
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold:
        `< ${THRESHOLDS.peak_rss_mb} at the "${m.fixture}" fixture. Graded on BOTH fixtures for ` +
        "the reason the export slice's review established: the scan holds every stored body as " +
        "text at once, on top of the manuscript the page already has, and the highest peak any " +
        "configuration has recorded is 691 MB",
      verdict: threshold(m.peak_rss_mb, THRESHOLDS.peak_rss_mb),
    },
  ];
}

export function evaluateOutlineGates(m: OutlineMetrics): GateResult[] {
  // Three conjuncts, one gate, deliberately: they are one claim -- the create
  // was a repaint, not a rebuild. Split across gates, a run could report
  // two-thirds of that fact as a pass.
  const created = m.create_row_delta === 1 && m.create_title_in_walk && m.create_opened_doc;
  return [
    {
      gate: "outline_create_visible",
      value: `${m.create_row_delta} row(s) added; new title ${
        m.create_title_in_walk ? "in" : "NOT IN"
      } the walk; open document ${m.create_opened_doc ? "is the created row" : "IS NOT the created row"}`,
      threshold:
        "row count grew by exactly 1, the new title is in the walk, and the editor now holds the " +
        "CREATED item - measured at the instant AFTER the create and BEFORE anything is clicked. " +
        "A create opens what it made (owner ruling 2026-09-01); outline_created_scene_opens then " +
        "clicks the same row",
      verdict: created ? "PASS" : "FAIL",
    },
    {
      // Deliberately AFTER outline_create_visible in this list: the two are one
      // sequence read top to bottom - the create opened its row, and then a
      // click on that row kept the writer in it.
      gate: "outline_created_scene_opens",
      value: m.created_scene_opens
        ? "the created row opened when clicked"
        : "THE CREATED ROW DID NOT OPEN",
      threshold:
        "clicking the created row AFTER the create opens it: prose typed next is under the " +
        "CREATED item's id in the reopened file, and under no other item's",
      verdict: m.created_scene_opens ? "PASS" : "FAIL",
    },
    {
      gate: "outline_delete_moves_to_bin",
      value: m.deleted_item_in_bin
        ? "the deleted item is inside the bin in the reopened file"
        : "THE DELETED ITEM IS NOT IN THE BIN",
      threshold:
        "after a Delete from the navigator's context menu and a restart, the deleted item's " +
        "parent chain reaches a root " +
        "item of type `trash`. Read from the STORE, not from the navigator: asking the page " +
        "where it drew the row checks the page against itself",
      verdict: m.deleted_item_in_bin ? "PASS" : "FAIL",
    },
    {
      gate: "outline_delete_keeps_the_prose",
      value: m.deleted_body_survives
        ? "the deleted item's prose is still readable after the restart"
        : "THE DELETED PROSE IS GONE",
      threshold:
        "the deleted item's stored body still contains the text typed into it, in the reopened " +
        "file. THE GATE A DESTRUCTIVE DELETE WOULD FAIL AND NO OTHER GATE HERE WOULD: an item " +
        "removed outright is equally absent from the export and the search, so nothing else " +
        "distinguishes the two designs, and restore would have nothing to return",
      verdict: m.deleted_body_survives ? "PASS" : "FAIL",
    },
    {
      gate: "outline_restore_leaves_the_bin",
      value: m.restored_item_out_of_bin
        ? "the restored item is back in the manuscript in the reopened file"
        : "THE RESTORED ITEM IS STILL IN THE BIN",
      threshold:
        "after a Restore from the context menu on the row deleted earlier, and a restart, the " +
        "item's parent " +
        "chain no longer reaches a root of type `trash`. Read from the STORE, not from the " +
        "navigator",
      verdict: m.restored_item_out_of_bin ? "PASS" : "FAIL",
    },
    {
      gate: "outline_restore_keeps_the_prose",
      value: m.restored_body_survives
        ? "the restored item still carries the prose typed into it"
        : "THE RESTORED PROSE IS GONE",
      threshold:
        "the restored item's stored body still contains the sentence typed into it before it " +
        "was deleted. The gate above alone would PASS on a restore that returned an EMPTY " +
        "scene; together they are the whole round trip - typed once, through a delete, a " +
        "restart, a restore and a second restart",
      verdict: m.restored_body_survives ? "PASS" : "FAIL",
    },
    {
      gate: "outline_restore_lands_last",
      value:
        `restored item is ${m.restored_item_is_last_root ? "" : "NOT "}the last manuscript root; ` +
        `bin is ${m.bin_is_last_root ? "" : "NOT "}the last root`,
      threshold:
        "after a Restore from the context menu and a restart, the restored item's root-level " +
        "row is the LAST root of a manuscript type (not the bin, the bible, or front/back " +
        "matter), and the bin is still the last root of all. An earlier design record claimed " +
        "both without either being measured",
      verdict: m.restored_item_is_last_root && m.bin_is_last_root ? "PASS" : "FAIL",
    },
    {
      gate: "outline_rename_persists",
      value: m.rename_title_persisted ? "new title in the reopened walk" : "NEW TITLE LOST",
      threshold: "the renamed item carries its new title in the walk read from the reopened file",
      verdict: m.rename_title_persisted ? "PASS" : "FAIL",
    },
    {
      gate: "outline_reorder_persists",
      value: m.reorder_position_match ? "sibling position match" : "SIBLING POSITION MISMATCH",
      threshold:
        "the reordered item's position among its siblings in the reopened file == the one shown before the kill",
      verdict: m.reorder_position_match ? "PASS" : "FAIL",
    },
    {
      gate: "outline_undo_restores_order",
      value: `ordinal ${m.undo_ordinal_before ?? "?"} -> ${m.undo_ordinal_after_move ?? "?"} -> ${
        m.undo_ordinal_after_undo ?? "?"
      }`,
      threshold:
        "after an Alt+Down reorder, Ctrl+Z in the focused navigator returns the row to its " +
        "previous ordinal among its siblings, read from the STORE in a second process; the move " +
        "itself must have changed the ordinal or the gate would pass on a no-op",
      verdict: m.undo_restores_order ? "PASS" : "FAIL",
    },
    {
      // The tree can be perfect and the writer's prose still be gone: this is
      // the gate that catches a reload which disturbed the editor.
      gate: "outline_document_intact",
      value: m.document_intact ? "byte-identical" : "OPEN DOCUMENT DISTURBED",
      threshold: "text typed before the mutations is byte-identical in the reopened file",
      verdict: m.document_intact ? "PASS" : "FAIL",
    },
    {
      // A percentile of zero samples is not a passing latency, it is no
      // measurement. UNKNOWN, never PASS.
      //
      // The threshold string states the input class because the VERDICT LINE is
      // what gets read, quoted and pasted into a summary, and this project has
      // been burned four separate times by a gate whose name or threshold
      // claimed more than its predicate checked. A reader seeing only "< 50
      // (command + walk re-read + reproject)" would take it as covering the
      // button a writer actually clicks; it does not. See
      // metrics.scope.mutation_latency_input_class in an outline result for the
      // measurements behind the number.
      gate: "outline_mutation_p95_ms",
      value: m.mutations === 0 ? "0 mutations" : m.mutation_p95_ms,
      threshold:
        `< ${OUTLINE_THRESHOLDS.mutation_p95_ms} (command + walk re-read + reproject; ` +
        "KEYBOARD-DRIVEN SAMPLES ONLY - a pointer-driven mutation additionally pays ~87 ms of the " +
        "rig's own X input delivery under Xvfb, which is the display server's path and not the " +
        "application's work. Since the outline bar was retired every operation is reached through " +
        "a context menu run with Return, so every sample is keyboard-driven and the rule selects " +
        "all of them)",
      verdict:
        m.mutations === 0
          ? "UNKNOWN"
          : threshold(m.mutation_p95_ms, OUTLINE_THRESHOLDS.mutation_p95_ms),
    },
  ];
}

/**
 * What an import run measured.
 *
 * Every count here has an ORACLE half computed by the rig from the source file
 * with `markdown-read.ts` — the harness's own restatement of the format, never
 * imported from `export.rs` or `import.rs`. An import checked against the
 * importer would be checking one Rust module against another in the same crate,
 * which is the pair-of-matching-blind-spots failure this project already
 * recorded once.
 */
export interface ImportMetrics {
  /** The import produced a project file the rig could open. */
  created: boolean;
  /** Items the store holds after the import. */
  items: number;
  /** Items the oracle counted in the source. Equality is the gate; an imported
   *  project carrying one MORE than the source is the starter-scene defect. */
  oracle_items: number;
  /** Items whose depth matches the level the oracle read for them. */
  depth_matches: number;
  /** Items whose title matches the oracle's, byte for byte. */
  title_matches: number;
  /** Scenes whose stored text matches the oracle's prose for that section,
   *  both normalized the way `export_text_fidelity` normalizes. */
  prose_matches: number;
  /** Sections the oracle says carry prose. The denominator for the above. */
  oracle_prose_sections: number;
  /** Emphasized runs the oracle found that came back carrying a mark. */
  marks_found: number;
  /** Emphasized runs the oracle found in the source. */
  oracle_marks: number;
  peak_rss_mb: number;
}

export function evaluateImportGates(m: ImportMetrics): GateResult[] {
  return [
    {
      gate: "import_created_project",
      value: m.created ? "a project was created and opens" : "NO PROJECT FILE",
      threshold: "clicking the file in the panel produces a readable project",
      verdict: m.created ? "PASS" : "FAIL",
    },
    {
      // Equality both ways on purpose. Too few loses a chapter; too many is the
      // starter scene `projects::create` writes and `create_imported` must not
      // — a blank scene nobody wrote, at the top of somebody's novel.
      gate: "import_item_count",
      value: `${m.items} of ${m.oracle_items}`,
      threshold: "exactly the items the source file's headings describe",
      verdict: m.items === m.oracle_items ? "PASS" : "FAIL",
    },
    {
      gate: "import_structure",
      value: `${m.depth_matches} of ${m.oracle_items}`,
      threshold: "every item at the depth its heading level implies",
      verdict:
        m.oracle_items > 0 && m.depth_matches === m.oracle_items ? "PASS" : "FAIL",
    },
    {
      gate: "import_titles_verbatim",
      value: `${m.title_matches} of ${m.oracle_items}`,
      threshold: "every title equal to the oracle's, byte for byte",
      verdict: m.oracle_items > 0 && m.title_matches === m.oracle_items ? "PASS" : "FAIL",
    },
    {
      // The gate the whole slice is for. Whitespace is normalized on BOTH
      // sides and that exclusion is stated here rather than only in
      // metrics.scope: the importer joins a paragraph's lines with one space
      // and the oracle does the same, so a whitespace-only difference is
      // invisible to this comparison and a reader of the verdict line has to
      // be told so.
      gate: "import_prose_fidelity",
      value: `${m.prose_matches} of ${m.oracle_prose_sections}`,
      threshold: "every section's prose stored verbatim (whitespace normalized both sides)",
      verdict:
        m.oracle_prose_sections > 0 && m.prose_matches === m.oracle_prose_sections
          ? "PASS"
          : "FAIL",
    },
    {
      // UNKNOWN rather than PASS when the source carried no emphasis: zero of
      // zero is not evidence that marks survive, and reporting it as PASS is
      // the unearned verdict this repo has caught seven instruments giving.
      gate: "import_marks_survive",
      value: `${m.marks_found} of ${m.oracle_marks}`,
      threshold: "every emphasized run in the source carries a mark in the store",
      verdict:
        m.oracle_marks === 0
          ? "UNKNOWN"
          : m.marks_found === m.oracle_marks
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb < THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

/**
 * Plan 093's round trip: project A comes from the Markdown import above;
 * project B comes from importing the DOCX this crate's OWN exporter wrote
 * from A's store. Comparing B back to A, never to the source file, is what
 * makes this a test of the DOCX pair (`docx.rs` writing, `docx_import.rs`
 * reading) rather than a second copy of the Markdown gates above.
 */
export interface DocxImportMetrics {
  /** Items project A's walk holds -- the round trip's baseline. */
  items_a: number;
  /** Items project B's walk holds after the DOCX import. */
  items_b: number;
  /** Items whose title AND depth agree between A and B, at the same index --
   *  the two walks are both depth-first over a tree with no reordering, so
   *  index alignment is the same claim `import-cli.ts`'s own oracle pairing
   *  makes. */
  title_depth_matches: number;
  /** Scenes whose prose (whitespace normalized both sides) agrees between A
   *  and B. */
  prose_matches: number;
  /** Scenes compared -- the denominator above, taken from A's own scene
   *  count so an empty B cannot inflate the fraction to 0 of 0. */
  scenes_compared: number;
  /** Whether the page's loss notice was showing after the DOCX import. This
   *  is the crate's OWN export read back, so decision 10's claim is that
   *  nothing is lost — a notice here is the round trip failing silently
   *  everywhere else and loudly here. */
  loss_notice_shown: boolean;
}

export function evaluateDocxImportGates(m: DocxImportMetrics): GateResult[] {
  return [
    {
      // Item count AND title+depth in one gate, on `import.rs`'s own
      // reasoning for `import_item_count`: too few loses a chapter, too many
      // is a phantom item, and a count that matches while titles or depths
      // do not is a reordered manuscript wearing the right total.
      gate: "import_docx_round_trip_items",
      value: `${m.items_b} of ${m.items_a} item(s); ${m.title_depth_matches} of ${m.items_a} title+depth matched`,
      threshold: "the DOCX round trip holds the same item count, title and depth as project A",
      verdict:
        m.items_a > 0 && m.items_a === m.items_b && m.title_depth_matches === m.items_a
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "import_docx_round_trip_prose",
      value: `${m.prose_matches} of ${m.scenes_compared}`,
      threshold: "every scene's prose equal to project A's (whitespace normalized both sides)",
      verdict:
        m.scenes_compared > 0 && m.prose_matches === m.scenes_compared ? "PASS" : "FAIL",
    },
    {
      gate: "import_docx_reports_no_loss",
      value: m.loss_notice_shown ? "a loss notice was shown" : "no loss notice",
      threshold: "importing this crate's own DOCX export raises no loss notice",
      verdict: m.loss_notice_shown ? "FAIL" : "PASS",
    },
  ];
}

export interface WindowMetrics {
  /** What a first launch with nothing recorded opens at. */
  default_w: number;
  default_h: number;
  /** `default_w` minus the navigator and the editor's padding: the space the
   *  text column actually has. */
  pane_w: number;
  /** The widest measure in px at the default type size. */
  widest_measure_px: number;
  /** What the window was resized to before being closed. */
  resized_w: number;
  resized_h: number;
  /** What the next launch opened at. */
  remembered_w: number;
  remembered_h: number;
  /** What a recorded 1x1 opens at. */
  absurd_w: number;
  absurd_h: number;
}

/** Below this a window has no application in it. Restated from
 *  `projects::MIN_WINDOW`, like every other threshold here. */
const MIN_WINDOW = { w: 640, h: 480 };

export function evaluateWindowGates(m: WindowMetrics): GateResult[] {
  return [
    {
      // The gate this slice exists for, and it FAILS on every build before it:
      // at 900x900 the pane was 532px and even the NARROWEST measure (544px)
      // capped against it, so all three rendered identically and an earlier
      // build shipped a preference nobody could see.
      gate: "window_default_fits_the_widest_measure",
      value: `${m.pane_w}px of pane for a ${m.widest_measure_px}px column`,
      threshold: "a first launch can show the widest measure without capping it",
      verdict: m.pane_w >= m.widest_measure_px ? "PASS" : "FAIL",
    },
    {
      // Equality, not a bound. The rig refuses to reach this gate unless the
      // recorded size differs from the default, because "remembered" and
      // "opened at the default" are otherwise the same picture.
      gate: "window_size_is_remembered",
      value: `left at ${m.resized_w}x${m.resized_h}, reopened at ${m.remembered_w}x${m.remembered_h}`,
      threshold: "the next launch opens at the size the last one was left",
      verdict:
        m.remembered_w === m.resized_w && m.remembered_h === m.resized_h ? "PASS" : "FAIL",
    },
    {
      // `{"width": 1}` parses perfectly well and produces a dot. A preferences
      // file is not a trusted input just because the application wrote it: a
      // half-finished write, a hand edit or a different build all reach here.
      gate: "window_refuses_an_unusable_size",
      value: `${m.absurd_w}x${m.absurd_h} from a recorded 1x1`,
      threshold: `at least ${MIN_WINDOW.w}x${MIN_WINDOW.h}`,
      verdict: m.absurd_w >= MIN_WINDOW.w && m.absurd_h >= MIN_WINDOW.h ? "PASS" : "FAIL",
    },
  ];
}

export interface DialogMetrics {
  /** Whether a window carrying the export dialog's title appeared at all. */
  dialog_opened: boolean;
  /** How many X windows carried the application's WM_CLASS while the dialog was
   *  up. Diagnostic, and the reason this rig finds the dialog by title. */
  class_matches_while_open: number;
  /** The absolute path the rig typed into the dialog. */
  chosen_path: string;
  /** Whether a file exists at exactly that path afterwards. */
  wrote_chosen_path: boolean;
  /** Scenes the harness's own Markdown reader found in the written file, and
   *  items the store holds. Two independent readings of one manuscript. */
  file_scenes: number;
  store_scenes: number;
  /** Whether the nonce sentence typed before the export is in the file. This is
   *  what makes the export "as saved" rather than "as last flushed". */
  nonce_in_file: boolean;
  /** A second boot that CANCELS. Nothing may be written. */
  cancel_dialog_opened: boolean;
  cancel_files_written: number;
  /** The import half. Nothing had ever opened that window: `project_import_pick`
   *  shares the export command's async-callback shape, and the export command's
   *  SYNCHRONOUS ancestor opened no window while reporting nothing — so "same
   *  shape" was an argument, not a measurement. */
  import_dialog_opened: boolean;
  library_projects_after_import: number;
  imported_scenes: number;
  /** Native folder-picker coverage for File > New project. `folder_dialog_opened`
   * is true only after an exact-title X window match. */
  folder_dialog_opened: boolean;
  folder_dialog_closed: boolean;
  folder_chosen_files: number;
  folder_default_files: number;
  folder_database_readable: boolean;
  folder_project_name: string;
  folder_expected_name: string;
  folder_starter_scenes: number;
  /** The independent cancel boot. No new database may appear anywhere under
   * the isolated rig root, and the dialog must have opened and then closed. */
  folder_cancel_dialog_opened: boolean;
  folder_cancel_dialog_closed: boolean;
  /** Whether a second exact-title picker opened and closed after the first
   * cancellation, proving the callback released the route. */
  folder_cancel_ready_again: boolean;
  folder_cancel_files: number;
  peak_rss_mb: number;
}

/** Restated, like every threshold here. The export rig's own bound. */
const DIALOG_RSS_MB = 750;

export function evaluateDialogGates(m: DialogMetrics): GateResult[] {
  return [
    {
      // The gate the whole slice rests on, and it FAILS on the obvious
      // implementation: `blocking_save_file()` from a synchronous command never
      // maps a window at all, parking the command thread while the application
      // stays alive and responsive. There is no error anywhere to catch.
      gate: "dialog_opens",
      value: m.dialog_opened
        ? `a window titled for the export appeared (${m.class_matches_while_open} windows share the app's WM_CLASS while it is up)`
        : "no dialog window ever appeared",
      threshold: "asking the writer where to put the file actually asks them",
      verdict: m.dialog_opened ? "PASS" : "FAIL",
    },
    {
      // The path came from the DIALOG, not from the page. A build that ignored
      // the chosen path and fell back to the automatic exports directory writes
      // a perfectly good manuscript and fails here, which is the distinction
      // this rig exists to draw.
      gate: "dialog_writes_the_chosen_path",
      value: m.wrote_chosen_path ? `wrote ${m.chosen_path}` : `nothing at ${m.chosen_path}`,
      threshold: "the file lands where the writer said, not where the application prefers",
      verdict: m.wrote_chosen_path ? "PASS" : "FAIL",
    },
    {
      // Read back with the harness's own restatement of the format, never with
      // export.rs: a reader built from the emitter would check the exporter
      // against itself.
      gate: "dialog_content_matches_the_store",
      value: `${m.file_scenes} scene(s) in the file, ${m.store_scenes} in the store`,
      threshold: "every scene the store holds is in the file the writer chose",
      verdict:
        m.file_scenes === m.store_scenes && m.store_scenes > 0
          ? "PASS"
          : m.store_scenes === 0
            ? "UNKNOWN"
            : "FAIL",
    },
    {
      // The drain. Export is "as saved", and the last sentence someone types
      // before reaching for the menu is the one at risk.
      gate: "dialog_export_includes_the_last_keystroke",
      value: m.nonce_in_file ? "the typed sentence is in the file" : "the typed sentence is absent",
      threshold: "the export drains before it reads the store",
      verdict: m.nonce_in_file ? "PASS" : "FAIL",
    },
    {
      // Without the first half of this value, a build whose dialog never opens
      // passes trivially: nothing was written because nothing was asked. The
      // rig aborts rather than reporting, but the verdict line has to carry it
      // too, because the verdict line is what gets read and quoted.
      gate: "dialog_cancel_writes_nothing",
      value: m.cancel_dialog_opened
        ? `${m.cancel_files_written} file(s) written after a cancel`
        : "the cancel boot never opened a dialog, so this proves nothing",
      threshold: "a cancelled dialog leaves no file, having actually been opened",
      verdict:
        !m.cancel_dialog_opened ? "UNKNOWN" : m.cancel_files_written === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "dialog_import_opens",
      value: m.import_dialog_opened ? "opened" : "NEVER APPEARED",
      threshold: "File > Import... opens the operating system's own file chooser",
      verdict: m.import_dialog_opened ? "PASS" : "FAIL",
    },
    {
      // The round trip: the file the CHOOSING boot exported, imported back.
      // `file_scenes` comes from the harness's own reader, and
      // `imported_scenes` from SQLite - so neither side is import.rs's account
      // of itself.
      gate: "dialog_imports_the_chosen_file",
      value: !m.import_dialog_opened
        ? "the import dialog never opened, so this proves nothing"
        : `${m.library_projects_after_import} project(s) in the library; ${m.imported_scenes} scene(s) against ${m.file_scenes} in the file`,
      threshold: "the chosen file becomes exactly one new project whose scenes match the file's",
      verdict: !m.import_dialog_opened
        ? "UNKNOWN"
        : m.library_projects_after_import === 1 &&
            m.file_scenes > 0 &&
            m.imported_scenes === m.file_scenes
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "folder_dialog_opens",
      value: m.folder_dialog_opened ? "opened \"Where to keep this book\"" : "the folder dialog never appeared",
      threshold: "File > New project asks for a folder in the operating system dialog",
      verdict: m.folder_dialog_opened ? "PASS" : "FAIL",
    },
    {
      gate: "folder_dialog_closes_after_choice",
      value: m.folder_dialog_closed ? "the chosen-folder dialog disappeared" : "the chosen-folder dialog remained open",
      threshold: "the folder choice is answered before creation is inspected",
      verdict: m.folder_dialog_opened && m.folder_dialog_closed ? "PASS" : "FAIL",
    },
    {
      gate: "folder_dialog_creates_in_the_chosen_directory",
      value: `${m.folder_chosen_files} database(s) in the chosen folder; ${m.folder_default_files} in the default folder`,
      threshold: "exactly one database is created in the chosen folder and none in the default folder",
      verdict: m.folder_dialog_opened && m.folder_dialog_closed && m.folder_chosen_files === 1 && m.folder_default_files === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "folder_dialog_creates_a_readable_named_book",
      value: m.folder_database_readable
        ? `readable book named ${JSON.stringify(m.folder_project_name)} with ${m.folder_starter_scenes} starter scene(s)`
        : "the created database could not be read",
      threshold: "the chosen-folder database records the typed name exactly and contains exactly one starter scene",
      verdict: m.folder_database_readable && m.folder_project_name === m.folder_expected_name && m.folder_starter_scenes === 1 ? "PASS" : "FAIL",
    },
    {
      gate: "folder_dialog_cancel_opens_and_closes",
      value: m.folder_cancel_dialog_opened
        ? m.folder_cancel_dialog_closed
          ? m.folder_cancel_ready_again ? "opened, closed after Escape, and opened again" : "opened and closed after Escape but did not open again"
          : "opened but remained visible after Escape"
        : "the cancel boot never opened the folder dialog",
      threshold: "cancelling closes a real native folder dialog and releases its route for another picker",
      verdict: m.folder_cancel_dialog_opened && m.folder_cancel_dialog_closed && m.folder_cancel_ready_again ? "PASS" : "FAIL",
    },
    {
      gate: "folder_dialog_cancel_creates_nothing",
      value: `${m.folder_cancel_files} database(s) created after cancel`,
      threshold: "a cancelled native folder dialog creates no database",
      verdict: m.folder_cancel_dialog_opened && m.folder_cancel_dialog_closed && m.folder_cancel_files === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: String(m.peak_rss_mb),
      threshold: `<= ${DIALOG_RSS_MB}`,
      verdict: m.peak_rss_mb <= DIALOG_RSS_MB ? "PASS" : "FAIL",
    },
  ];
}

/** One reading of the editable's box, in window coordinates, off a live AT-SPI
 *  tree. Measured rather than computed: this is the whole point of the two
 *  extent gates below, which ask the RENDERING ENGINE what it did rather than
 *  asking the page what it meant. */
export interface ProseBox {
  w: number;
  h: number;
}

export interface PrefsMetrics {
  /** The editable at the smallest size, and at the largest, both over the same
   *  measure and the same prose. */
  small: ProseBox;
  larger: ProseBox;
  /** The editable in each of two fonts, at one size and one measure. */
  serif: ProseBox;
  mono: ProseBox;
  /** The editable at the narrowest measure and the widest, both at one size. */
  narrow: ProseBox;
  wide: ProseBox;
  /** What the panel was clicked to, and what settings.json held afterwards.
   *  Compared as written, so a lost axis is visible rather than averaged away. */
  chosen: string;
  recorded: string;
  /** The editable after relaunching on the recorded preference, against the
   *  same reading taken with that preference seeded into the file directly. */
  restarted: ProseBox;
  seeded_equivalent: ProseBox;
  peak_rss_mb: number;
}

const boxOf = (b: ProseBox): string => `${b.w}x${b.h}`;

export function evaluatePrefsGates(m: PrefsMetrics): GateResult[] {
  return [
    {
      // Read from AT-SPI, which is a DIFFERENT SUBSYSTEM from the CSSOM. A page
      // that reported its intended styles while rendering none of them passes
      // any getComputedStyle check and fails this one.
      //
      // The prose is identical in both runs and the measure is the same, so the
      // only thing that can move the height is the type size. The rig aborts
      // rather than reporting if either box failed to overflow the window: with
      // `min-height: 100%` a short document's editable is exactly the pane's
      // height at every size, and this would compare two clamped figures.
      gate: "prefs_size_reflows",
      value: `${boxOf(m.small)} at small, ${boxOf(m.larger)} at larger`,
      threshold: "the same prose is TALLER at the largest size than at the smallest",
      verdict: m.larger.h > m.small.h ? "PASS" : "FAIL",
    },
    {
      // The font axis needs its own gate, and finding that out cost a sabotage
      // run. `prefs_restart_renders_the_choice` compares two boots OF THE SAME
      // BUILD, so a family that is never applied at all is applied equally
      // little on both sides and the equality still holds. That gate can only
      // see a preference lost between the FILE and the PAGE, never one the page
      // never honours at all.
      //
      // The width here is the discriminator's control rather than its subject:
      // at one size and one measure the column is fixed by the em figure
      // whatever the font, so an equal width with an unequal height is the
      // signature of a font change and of nothing else.
      gate: "prefs_family_reflows",
      value: `${boxOf(m.serif)} serif, ${boxOf(m.mono)} mono`,
      threshold: "the same prose in the same column wraps to a DIFFERENT height in a different font",
      verdict: m.serif.w === m.mono.w && m.serif.h !== m.mono.h ? "PASS" : "FAIL",
    },
    {
      // The measure is stated in `em`, so it is a count of characters and the
      // pixel width follows the size. Both readings are taken at one size for
      // that reason.
      gate: "prefs_measure_widens",
      value: `${m.narrow.w}px narrow, ${m.wide.w}px wide`,
      threshold: "the text column is WIDER at the widest measure than at the narrowest",
      verdict: m.wide.w > m.narrow.w ? "PASS" : "FAIL",
    },
    {
      gate: "prefs_persist",
      value: `chose ${m.chosen}, file holds ${m.recorded}`,
      threshold: "settings.json records every axis the panel was clicked to",
      verdict: m.chosen === m.recorded ? "PASS" : "FAIL",
    },
    {
      // The strongest claim available without asking the page anything: the
      // preference set by CLICKING and reloaded from the file must render the
      // same box as the same preference SEEDED into the file directly. Equality
      // rather than a bound, because the two runs differ in nothing else - same
      // fixture, same typed prose, same window.
      //
      // This covers the font as well, which no other gate here can see: at one
      // size and one measure the width is fixed by the em figure, so a lost
      // family shows up in the HEIGHT, through wrapping.
      gate: "prefs_restart_renders_the_choice",
      value: `${boxOf(m.restarted)} after restart, ${boxOf(m.seeded_equivalent)} seeded`,
      threshold: "relaunching on the recorded preference renders exactly the seeded one",
      verdict:
        m.restarted.w === m.seeded_equivalent.w && m.restarted.h === m.seeded_equivalent.h
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb < THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

export interface GoalsMetrics {
  /** Words typed into the manuscript during the run, counted by the RIG's own
   *  restatement of the word rule over the store -- never by asking the page. */
  typed_words: number;
  /** The day's figure the bar showed before that typing, and after it. */
  today_before: number;
  today_after: number;
  /** The day's figure after a kill and a reopen against the same file. */
  today_after_restart: number;
  /** The independent SQLite reading of today's source_words typing bucket at
   *  the same three points. */
  ledger_today_before: number;
  ledger_today_after: number;
  ledger_today_after_restart: number;
  /** The page and ledger after today's bucket was moved to yesterday, plus the
   *  contribution before the move so preservation is graded. */
  today_after_rollover: number;
  ledger_today_after_rollover: number;
  ledger_yesterday_after_rollover: number;
  typing_before_rollover: number;
  /** What the panel was clicked to, what settings.json then held, and what the
   *  bar read after relaunching on it. */
  chosen_target: string;
  recorded_target: string;
  target_in_bar: string;
  /** The READOUT's own height from AT-SPI component extents, and a control from
   *  the same strip (#footer since 067) and the same walk. Neither is a
   *  restated constant.
   *
   *  The strip itself cannot be used: WebKitGTK prunes it, so its box is not in
   *  the tree at all. The readout's is, because it carries a role and a
   *  name. */
  readout_h: number;
  control_h: number;
  /** The day's two figures as the rig read them out of the visible text and out
   *  of the accessible name, in one normalized form: `<signed count>/<target>`,
   *  DIGITS AS WRITTEN.
   *
   *  The two channels are deliberately different sentences -- "108 of 500 typed
   *  today" against "108 words typed today of a 500 word target" -- so the rig
   *  parses each with its own pattern and this compares what it got. Comparing
   *  the sentences themselves would compare two strings that are supposed to differ.
   *  Digits stay as written, so "1,400" against "1400" is the disagreement it
   *  is. `null` means the channel said something the rig could not read, which
   *  is a FAIL. */
  today_in_text: string | null;
  today_in_name: string | null;
  peak_rss_mb: number;
}

export function evaluateGoalsGates(m: GoalsMetrics): GateResult[] {
  const movement = m.today_after - m.today_before;
  const ledgerMovement = m.ledger_today_after - m.ledger_today_before;
  return [
    {
      // The rig types a known passage and counts it ITSELF, off the store, with
      // its own restatement of the word rule. Asking the page how many words it
      // thinks it added would be checking the page against itself.
      gate: "goal_today_counts_new_words",
      value:
        `page ${m.today_before} -> ${m.today_after}, ledger ` +
        `${m.ledger_today_before} -> ${m.ledger_today_after}, ${m.typed_words} words typed`,
      threshold: "the page and source ledger rise by exactly the stored manuscript movement",
      verdict:
        movement === m.typed_words &&
        ledgerMovement === m.typed_words &&
        m.today_before === m.ledger_today_before &&
        m.today_after === m.ledger_today_after
          ? "PASS"
          : "FAIL",
    },
    {
      // The source ledger is in the project file, so the figure has to survive the
      // application going away. A SIGKILL, not a close: a close is one of three
      // ways this application stops and the least common of them.
      gate: "goal_today_survives_a_restart",
      value:
        `${m.today_after} before the kill, ${m.today_after_restart} after reopening, ` +
        `${m.ledger_today_after_restart} in the ledger`,
      threshold: "the same day's figure, from the file rather than from memory",
      verdict:
        m.today_after_restart === m.today_after &&
        m.ledger_today_after_restart === m.ledger_today_after
          ? "PASS"
          : "FAIL",
    },
    {
      // Yesterday's date written into the file by hand, which is the only way to
      // make a day turn inside a run that lasts a minute. The claim has three
      // halves and all three are graded together: the page reports nothing for
      // today, the absent current-day bucket reads as zero, and yesterday keeps
      // the contribution rather than losing it.
      gate: "goal_new_day_resets",
      value:
        `page ${m.today_after_rollover} today, ledger ${m.ledger_today_after_rollover} today, ` +
        `${m.ledger_yesterday_after_rollover} yesterday`,
      threshold: "a turned day reports 0 today and preserves yesterday's typing contribution",
      verdict:
        m.today_after_rollover === 0 &&
        m.ledger_today_after_rollover === 0 &&
        m.ledger_yesterday_after_rollover === m.typing_before_rollover
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "goal_target_persists_and_renders",
      value: `chose ${m.chosen_target}, file holds ${m.recorded_target}, bar reads ${m.target_in_bar}`,
      threshold:
        "the clicked target reaches the file AND comes back into the bar on the next launch",
      verdict:
        m.chosen_target === m.recorded_target && m.target_in_bar === m.chosen_target
          ? "PASS"
          : "FAIL",
    },
    {
      // THE GEOMETRY CLAIM, and the reason it is graded rather than looked at.
      // The readout gained a third figure in a strip whose height is a
      // click-geometry constant the navigator rigs restate: it was #project-bar
      // (39px) until 067 and is #footer (34px) since, and the control it is
      // measured against is in the same strip either way. A wrapped strip moves
      // every navigator row those rigs click, and they would go on reporting
      // plausible numbers about the wrong rows. An earlier build's panel
      // wrapped for exactly this reason and no gate saw it.
      gate: "goal_bar_stays_one_line",
      value: `readout ${m.readout_h}px against a ${m.control_h}px control beside it`,
      threshold: "the readout is no taller than a single-line control in the same strip",
      verdict: m.readout_h > 0 && m.readout_h <= m.control_h ? "PASS" : "FAIL",
    },
    {
      // Compared AS WRITTEN, so a lost thousands separator or a minus sign that
      // reached only one channel counts. The two renderings come from the same
      // held number inside the page, so nothing there can see them drift -- this
      // is the only instrument that can.
      gate: "a11y_progress_agrees",
      value: `text ${m.today_in_text ?? "ABSENT"}, name ${m.today_in_name ?? "ABSENT"}`,
      threshold: "the day's figure is the same in the visible text and in the accessible name",
      verdict: m.today_in_text !== null && m.today_in_text === m.today_in_name ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb < THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

/** What `menu-cli` measures. Five boots, and the figures come from the STORE,
 *  the FILESYSTEM and the X server — never from the page's account of what it
 *  just did. */
export interface MenuMetrics {
  /** Menu titles located in the accessibility tree. */
  menu_titles_found: number;
  /** Menu-item nodes in the walk taken with every menu CLOSED. */
  baseline_item_nodes: number;
  /** Menu-item nodes in the walk taken with File open. */
  open_item_nodes: number;
  /** The names the open menu's items actually exposed, in tree order. */
  open_item_names: string[];
  /** How many of those exposed an EMPTY accessible name. */
  unnamed_item_nodes: number;
  /** Which ATK roles the menubar, its titles and its items mapped to. */
  menubar_role: string;
  title_role: string;
  item_role: string;
  /** Menu-item nodes still in the tree after Escape, and after activating. */
  items_after_escape: number;
  items_after_activation: number;
  /** The store's walk length either side of Outline > New scene. */
  store_rows_before_create: number;
  store_rows_after_create: number;
  created_row_type: string | null;
  /** Files in the export directory either side of File > Export manuscript. */
  export_files_before: number;
  export_files_after: number;
  /** The exported manuscript read back, against the store read directly.
   *  Sections rather than scenes: `Section` carries no item type, so the
   *  structural claim available here is the one `export-cli` already makes —
   *  one heading per walked item. */
  exported_sections: number;
  store_items: number;
  /** The rendered label, and the selected row's bin state established
   *  INDEPENDENTLY of it — out of SQLite, not out of the page. */
  label_when_live: string;
  label_when_trashed: string;
  live_row_trashed_in_store: boolean;
  trashed_row_trashed_in_store: boolean;
  peak_rss_mb: number;
}

export function evaluateMenuGates(m: MenuMetrics): GateResult[] {
  const opened = m.open_item_nodes > m.baseline_item_nodes;
  return [
    {
      gate: "menu_opens",
      value: `${m.baseline_item_nodes} item node(s) closed -> ${m.open_item_nodes} open, across ${m.menu_titles_found} title(s)`,
      threshold: "opening a menu exposes items AT-SPI could not see while it was closed",
      verdict: m.menu_titles_found === 0 ? "UNKNOWN" : opened ? "PASS" : "FAIL",
    },
    {
      // Not an assertion against a prior measurement — there is none. The
      // roles are RECORDED. What IS asserted is the thing a collapsed role
      // costs a screen-reader user: an item that maps to a role carrying no
      // name is an item nobody can read. That is the recorded `generic`
      // failure mode, and it is falsifiable.
      gate: "menu_roles_exposed",
      value: `menubar:${m.menubar_role} title:${m.title_role} item:${m.item_role}; ${m.unnamed_item_nodes} unnamed of ${m.open_item_nodes}`,
      threshold: "every exposed menu item carries a non-empty accessible name",
      verdict: m.open_item_nodes === 0 ? "UNKNOWN" : m.unnamed_item_nodes === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "menu_creates_an_item",
      value: `${m.store_rows_before_create} -> ${m.store_rows_after_create} row(s); created type ${m.created_row_type ?? "none"}`,
      threshold: "Outline > New scene adds exactly one row of type `scene` to the STORE",
      verdict:
        m.store_rows_after_create === m.store_rows_before_create + 1 && m.created_row_type === "scene"
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "menu_exports",
      value: `${m.export_files_before} -> ${m.export_files_after} file(s); ${m.exported_sections} heading(s) read back against ${m.store_items} walked item(s)`,
      threshold: "File > Export manuscript writes one file with one heading per walked item",
      verdict:
        m.export_files_after === m.export_files_before + 1 &&
        m.store_items > 0 &&
        m.exported_sections === m.store_items
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "menu_context_label",
      value: `live row -> "${m.label_when_live}" (trashed in store: ${m.live_row_trashed_in_store}); binned row -> "${m.label_when_trashed}" (trashed in store: ${m.trashed_row_trashed_in_store})`,
      threshold: "the rendered Delete/Restore matches the selected row's bin state AS THE STORE HAS IT",
      verdict:
        m.label_when_live === "Delete" &&
        !m.live_row_trashed_in_store &&
        m.label_when_trashed === "Restore" &&
        m.trashed_row_trashed_in_store
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "menu_keyboard_opens",
      value: `Alt+F exposed ${m.open_item_nodes} item(s); ${m.items_after_escape} left after Escape`,
      threshold: "Alt+F opens the File menu and Escape closes it, with no pointer involved",
      verdict: !opened ? "FAIL" : m.items_after_escape === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "menu_closes_after_activation",
      value: `${m.items_after_activation} item node(s) remain once an item has run`,
      threshold: "activating an item leaves no menu painted",
      verdict: m.items_after_activation === 0 ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb < THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

// ---------------------------------------------------------------- replace

export interface ReplaceMetrics {
  fixture: string;
  /** The term the rig chose from the fixture's own word frequencies, rather
   *  than a hard-coded word that could silently match nothing. */
  query: string;
  /** A nonce, guaranteed absent from the seeded project. Without that guarantee
   *  "the replacement is there afterwards" would prove nothing. */
  replacement: string;
  /** The scene the page opens at boot: the only scene replace may touch. */
  target_item: string;
  /** A DIFFERENT scene that also held the term before anything ran. */
  other_item: string;
  /** Occurrences the RIG counted in the target scene's seeded body, folding one
   *  code point at a time the way find-locate.ts does. */
  expected_occurrences: number;
  /** The figure the panel announced, parsed out of the live accessibility tree.
   *  Null when the panel never said one. */
  reported_count: number | null;
  /** The target scene's stored body, read WHILE THE APP WAS STILL RUNNING,
   *  projects to the text the rig computed for itself. */
  all_matches_oracle: boolean;
  /** The same reading after the shell was killed and the project reopened. A
   *  separate measurement from the one above, not a second look at it. */
  restart_matches_oracle: boolean;
  reopen_ready: boolean;
  /** The scoping claim, in two halves: the other scene's stored body is
   *  byte-identical to the seeded one, AND it still holds the term. Without the
   *  second half a build that emptied every other scene would pass the first. */
  other_body_unchanged: boolean;
  other_still_contains_term: boolean;
  /** Two presses of Replace (the first selects, the second replaces) against a
   *  freshly seeded copy, compared to the rig's own first-occurrence-only text. */
  one_matches_oracle: boolean;
  one_occurrences_left: number;
  /** The undo phase's vacuity half: the store must have DIVERGED before the
   *  undo, or a replace that never landed would be "restored" trivially. */
  undo_diverged_first: boolean;
  undo_matches_original: boolean;
  /** The marks phase. `marks_probed` is false when the rig could not set up its
   *  own precondition (an emphasised nonce in the store), and the gate then
   *  reports UNKNOWN rather than a pass it did not earn. */
  marks_probed: boolean;
  marks_kept: boolean;
  peak_rss_mb: number;
}

export function evaluateReplaceGates(m: ReplaceMetrics): GateResult[] {
  return [
    {
      // The oracle is the store read with bun:sqlite and projected by the rig's
      // own restatement of the walk, never the panel's account of what it did.
      gate: "replace_all_changes_the_store",
      value: m.all_matches_oracle
        ? `the target scene's stored body is the rig's expected text (${m.expected_occurrences} occurrence(s) of "${m.query}" -> "${m.replacement}")`
        : "the target scene's stored body is NOT the text the rig computed",
      threshold: "the store holds exactly what replacing every occurrence should produce",
      verdict: m.all_matches_oracle ? "PASS" : "FAIL",
    },
    {
      // Counted by the rig in the PRE-replace body. A build that reported the
      // number of matches it found rather than the number it applied would
      // agree here only while those are the same number, which is the point.
      gate: "replace_all_count_agrees",
      value:
        m.reported_count === null
          ? "the panel never announced a count"
          : `panel said ${m.reported_count}, the rig counted ${m.expected_occurrences}`,
      threshold: "the announced count equals the occurrences the rig found before the replace",
      verdict:
        m.reported_count === null
          ? "UNKNOWN"
          : m.reported_count === m.expected_occurrences
            ? "PASS"
            : "FAIL",
    },
    {
      // THE LOAD-BEARING SAFETY GATE OF THE SLICE. Replace is scoped to the
      // open scene because there is no history to undo a manuscript-wide one
      // with; a build that quietly widened the scope would be the single most
      // destructive defect this application could ship.
      gate: "replace_is_scoped_to_the_scene",
      value: m.other_body_unchanged
        ? m.other_still_contains_term
          ? `${m.other_item} is byte-identical and still holds "${m.query}"`
          : `${m.other_item} is byte-identical but no longer holds "${m.query}" — the rig's own precondition failed`
        : `${m.other_item} CHANGED: the replace reached a scene that was not open`,
      threshold: "a different scene holding the same term is untouched, and still holds it",
      verdict: m.other_body_unchanged && m.other_still_contains_term ? "PASS" : "FAIL",
    },
    {
      gate: "replace_survives_a_restart",
      value: !m.reopen_ready
        ? "the reopen boot never became ready, so nothing was read back"
        : m.restart_matches_oracle
          ? "the reopened project still holds the rig's expected text"
          : "the reopened project does NOT hold the expected text",
      threshold: "the replacement is in the file after a kill and a reopen, not merely on screen",
      verdict: !m.reopen_ready ? "UNKNOWN" : m.restart_matches_oracle ? "PASS" : "FAIL",
    },
    {
      // Two presses, one replacement: the first press selects (nothing is
      // selected when the panel opens), the second acts. A build that replaced
      // on the first press, or replaced more than one, fails on the text rather
      // than on the count - the rig knows WHICH occurrence should have gone.
      gate: "replace_one_replaces_one",
      value: m.one_matches_oracle
        ? `exactly the first occurrence changed; ${m.one_occurrences_left} of ${m.expected_occurrences} left`
        : `the body is not "first occurrence replaced"; ${m.one_occurrences_left} of ${m.expected_occurrences} occurrence(s) left`,
      threshold: "one Replace changes the first occurrence and nothing else",
      verdict: m.one_matches_oracle ? "PASS" : "FAIL",
    },
    {
      // ONE press of undo, not many. Replace-all is one transaction precisely
      // so a writer who regrets forty replacements does not have to press
      // Ctrl+Z forty times and cannot stop half way by accident. That is what
      // makes the feature safe, so it is graded rather than argued.
      gate: "replace_undo_restores",
      value: !m.undo_diverged_first
        ? "the store never diverged before the undo, so restoring it proves nothing"
        : m.undo_matches_original
          ? "one undo restored the seeded text exactly"
          : "one undo did NOT restore the seeded text",
      threshold: "a single Undo after Replace all returns the scene to what it was",
      verdict: !m.undo_diverged_first ? "UNKNOWN" : m.undo_matches_original ? "PASS" : "FAIL",
    },
    {
      // By design, the replacement inherits the marks of the run the match starts in.
      // Probed by emphasising a nonce with the shipped Ctrl+I and replacing it,
      // so the fixture (which carries no marks at all) does not have to.
      gate: "replace_keeps_the_marks",
      value: !m.marks_probed
        ? "the rig could not put an emphasised nonce in the store, so nothing was probed"
        : m.marks_kept
          ? "the replacement text node carries the em mark the match sat in"
          : "the replacement text node LOST the em mark",
      threshold: "a replacement inside an italicised run is still italicised in the store",
      verdict: !m.marks_probed ? "UNKNOWN" : m.marks_kept ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb < THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

// ---------------------------------------------------------------- history

/** The version-history run. Every figure here is read from the store with
 *  bun:sqlite, or -- for the one gate that needs the screen -- out of a single
 *  AT-SPI walk. Nothing is the page's account of itself. */
export interface HistoryMetrics {
  fixture: string;
  documents: number;
  /** Versions the boot scene held after one boot's worth of typing. */
  versions_after_typing: number;
  first_version_holds_typed_text: boolean;
  /** Text the RIG wrote into a planted version. The application first meets
   *  these words when it is asked to give them back, which is what makes the
   *  restore oracle independent of the thing it grades. */
  planted_text: string;
  /** The scene's stored text right after the restore, read while the app was
   *  still running. Null when it never changed. */
  text_after_restore: string | null;
  /** Is the body the restore OVERWROTE now in history? Keyed on a nonce typed
   *  in the same boot, which no automatic version can hold. */
  captured_before_restore: boolean;
  /** The stored text after typing ON TOP of the restored document. If the page
   *  never swapped the editor, this holds the PRE-restore text plus the nonce
   *  -- a silent undo of the restore, and the recorded "graded run passed on a
   *  slice whose headline loop was dead" failure mode. */
  text_after_typing_on_restored: string | null;
  nonce_before_restore: string;
  nonce_after_restore: string;
  nonce_ruin: string;
  snapshot_count: number;
  /** Version rows belonging to the newest snapshot. */
  snapshot_documents: number;
  /** Version rows belonging to any snapshot. */
  snapshot_version_rows: number;
  blobs_before_snapshots: number;
  blobs_after_snapshots: number;
  text_at_snapshot_time: string | null;
  text_after_snapshot_restore: string | null;
  /** What the panel said it was listing, out of the one walk. Null when the
   *  status line was not found or said no number. */
  panel_version_count: number | null;
  store_version_count: number;
  /** The version row's focusable controls in paint order, and how many
   *  Shift+Tabs the rig therefore spent reaching Restore. Both parsed from
   *  history.ts; neither is gated. Recorded because a stale count is what made
   *  three restore gates FAIL against a correct application. */
  version_row_controls: string;
  shift_tabs_to_restore: number;
  peak_rss_mb: number;
  omitted_gates: string;
}

const HISTORY_THRESHOLDS = {
  peak_rss_mb: 750,
} as const;

export function evaluateHistoryGates(m: HistoryMetrics): GateResult[] {
  const restored = m.text_after_restore;
  const afterTyping = m.text_after_typing_on_restored;
  const afterSnapshot = m.text_after_snapshot_restore;
  return [
    {
      // The floor of the whole feature: without a version there is nothing to
      // restore, and the rig aborts rather than grading the rest against a
      // history that does not exist.
      gate: "history_auto_version_written",
      value: `${m.versions_after_typing} version(s) after typing; the typed text ${
        m.first_version_holds_typed_text ? "is" : "is NOT"
      } in one of them`,
      threshold: "typing produces at least one version, and it holds what was typed",
      verdict:
        m.versions_after_typing > 0 && m.first_version_holds_typed_text ? "PASS" : "FAIL",
    },
    {
      // Against text the rig wrote itself, not against anything the
      // application produced.
      gate: "history_restore_returns_the_text",
      value:
        restored === null
          ? "the scene's body never changed after the restore was activated"
          : restored === m.planted_text
            ? "the stored body is exactly the planted text"
            : `the stored body is NOT the planted text: ${JSON.stringify(restored.slice(0, 120))}`,
      threshold: "after restoring, the store holds exactly the version's own text",
      verdict: restored === null ? "FAIL" : restored === m.planted_text ? "PASS" : "FAIL",
    },
    {
      // The property that keeps this feature from having a path that loses
      // work. Keyed on a nonce typed in the same boot, so a version holding it
      // can only have been written by the restore capturing what it replaced.
      gate: "history_restore_is_reversible",
      value: m.captured_before_restore
        ? `the body the restore overwrote (holding "${m.nonce_before_restore}") is in history`
        : "the body the restore overwrote is NOWHERE in history",
      threshold: "restoring captures what it replaces, so the restore is itself undoable",
      verdict: m.captured_before_restore ? "PASS" : "FAIL",
    },
    {
      // A store-side check of a PAGE-side claim: if the editor never swapped
      // its document, the next flush writes the pre-restore text and silently
      // undoes the restore. Both halves are required -- the new nonce present,
      // and the pre-restore nonce gone.
      gate: "history_restore_reaches_the_page",
      value:
        afterTyping === null
          ? "typing after the restore never reached the store"
          : `${afterTyping.includes(m.nonce_after_restore) ? "holds" : "does NOT hold"} the new text; ${
              afterTyping.includes(m.nonce_before_restore) ? "STILL HOLDS" : "no longer holds"
            } the pre-restore text`,
      threshold:
        "typing after a restore lands on the RESTORED document: the new text is stored and the " +
        "replaced text is gone. A page that swapped nothing passes neither half.",
      verdict:
        afterTyping === null
          ? "UNKNOWN"
          : afterTyping.includes(m.nonce_after_restore) &&
              !afterTyping.includes(m.nonce_before_restore)
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "history_snapshot_covers_every_document",
      value: `${m.snapshot_documents} version row(s) for ${m.documents} document(s)`,
      threshold: "a named snapshot captures every document in the manuscript, none missing",
      verdict:
        m.documents === 0
          ? "UNKNOWN"
          : m.snapshot_documents === m.documents
            ? "PASS"
            : "FAIL",
    },
    {
      // The whole affordability argument for content addressing. Without it
      // every snapshot is another copy of the book, and a novelist who names
      // ten moments has eleven manuscripts on disk.
      gate: "history_snapshot_dedups",
      value:
        `${m.snapshot_version_rows} snapshot version row(s) share ` +
        `${m.blobs_after_snapshots - m.blobs_before_snapshots} new blob(s) ` +
        `(${m.blobs_before_snapshots} -> ${m.blobs_after_snapshots})`,
      threshold:
        "two snapshots over an unedited manuscript write 2 x documents version rows and at most " +
        "documents new blobs. A second full copy would double the blob count.",
      verdict:
        m.documents === 0 || m.snapshot_count !== 2
          ? "UNKNOWN"
          : m.snapshot_version_rows === 2 * m.documents &&
              m.blobs_after_snapshots - m.blobs_before_snapshots <= m.documents
            ? "PASS"
            : "FAIL",
    },
    {
      // The operation with the largest blast radius in this application.
      gate: "history_snapshot_restore_reverts",
      value:
        afterSnapshot === null
          ? "the manuscript never changed after the snapshot restore was confirmed"
          : afterSnapshot === m.text_at_snapshot_time
            ? "the scene is byte-identical to what the snapshot captured"
            : `the scene does NOT match the snapshot: ${JSON.stringify(afterSnapshot.slice(0, 120))}`,
      threshold:
        "after restoring a snapshot the scene holds exactly what it held when the snapshot was " +
        "taken, and the text typed since is gone",
      verdict:
        afterSnapshot === null || m.text_at_snapshot_time === null
          ? "UNKNOWN"
          : afterSnapshot === m.text_at_snapshot_time && !afterSnapshot.includes(m.nonce_ruin)
            ? "PASS"
            : "FAIL",
    },
    {
      // The one claim that needs the screen, and therefore the one walk. It is
      // also the reopen claim: these versions were written by earlier boots,
      // through kills, and a later window lists them.
      gate: "history_panel_lists_what_the_store_holds",
      value:
        m.panel_version_count === null
          ? "the history panel reported no version count"
          : `the panel said ${m.panel_version_count}, the store holds ${m.store_version_count}`,
      threshold:
        "the panel, in a window opened after four kills, lists exactly the versions the file " +
        "holds for the open scene",
      verdict:
        m.panel_version_count === null
          ? "UNKNOWN"
          : m.panel_version_count === m.store_version_count
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `<= ${HISTORY_THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb <= HISTORY_THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

// ------------------------------------------------- manuscript-wide replace

/** The manuscript-wide replace run. The expected manuscript is computed by the
 *  RIG from the seeded bodies before anything runs; nothing here is the panel's
 *  account of what it did. */
export interface MReplaceMetrics {
  fixture: string;
  documents: number;
  query: string;
  replacement: string;
  scenes_holding_the_term: number;
  /** Occurrences the rig counted OUTSIDE the bin. */
  expected_replacements: number;
  expected_documents: number;
  /** Parsed out of the announced report, in the one AT-SPI walk. */
  reported_replacements: number | null;
  reported_documents: number | null;
  live_matches_oracle: boolean;
  /** The first document that diverged, so a red gate names where to look. */
  live_mismatch: string | null;
  doomed_item: string;
  doomed_untouched: boolean;
  snapshot_count: number;
  snapshot_label: string | null;
  snapshot_documents: number;
  expected_snapshot_label: string;
  reversible: boolean;
  reversible_mismatch: string | null;
  peak_rss_mb: number;
  omitted_gates: string;
}

const MREPLACE_THRESHOLDS = { peak_rss_mb: 750 } as const;

export function evaluateManuscriptReplaceGates(m: MReplaceMetrics): GateResult[] {
  return [
    {
      gate: "mreplace_rewrites_every_live_scene",
      value: m.live_matches_oracle
        ? `every one of ${m.expected_documents} scene(s) holds the text the rig computed`
        : `${m.live_mismatch ?? "a document"} is NOT the text the rig computed`,
      threshold:
        "every live scene that held the term holds exactly what replacing it should produce, " +
        "computed by the rig from the seeded bodies before anything ran",
      verdict: m.live_matches_oracle ? "PASS" : "FAIL",
    },
    {
      gate: "mreplace_count_agrees",
      value:
        m.reported_replacements === null
          ? "the panel never announced a count"
          : `panel said ${m.reported_replacements} in ${m.reported_documents ?? "?"} document(s); ` +
            `the rig counted ${m.expected_replacements} in ${m.expected_documents}`,
      threshold:
        "the announced figures equal the occurrences and documents the rig found before the run",
      verdict:
        m.reported_replacements === null
          ? "UNKNOWN"
          : m.reported_replacements === m.expected_replacements &&
              m.reported_documents === m.expected_documents
            ? "PASS"
            : "FAIL",
    },
    {
      // THE SAFETY GATE. This operation was refused for a long time because it
      // had no inverse. If this ever goes red the feature must be withdrawn,
      // not patched.
      gate: "mreplace_is_reversible",
      value: m.reversible
        ? "every document is byte-identical to the seed after restoring the snapshot"
        : `${m.reversible_mismatch ?? "a document"} did NOT come back`,
      threshold:
        "restoring the snapshot the replace took, through the shipped history panel, returns " +
        "every document in the manuscript byte for byte",
      verdict: m.reversible ? "PASS" : "FAIL",
    },
    {
      gate: "mreplace_takes_a_named_snapshot",
      value:
        m.snapshot_label === null
          ? "no snapshot exists"
          : `"${m.snapshot_label}" over ${m.snapshot_documents} document(s)`,
      threshold:
        "the replace saved a snapshot naming the operation and covering EVERY document, " +
        "the bin included -- a snapshot is of the file",
      verdict:
        m.snapshot_label === null
          ? "FAIL"
          : m.snapshot_label === m.expected_snapshot_label &&
              m.snapshot_documents === m.documents &&
              m.snapshot_count === 1
            ? "PASS"
            : "FAIL",
    },
    {
      // Rewriting deleted work would hand the writer text they never wrote the
      // moment they restored it.
      gate: "mreplace_skips_the_bin",
      value: m.doomed_untouched
        ? `${m.doomed_item}, deleted before the replace, still holds the term`
        : `${m.doomed_item} was rewritten in the bin`,
      threshold: "a scene in the bin holding the term is not rewritten",
      verdict: m.doomed_untouched ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `<= ${MREPLACE_THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb <= MREPLACE_THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

// ------------------------------------------------------- navigator context menu

/** What `context-cli` measures. SIX boots, at most two AT-SPI walks each.
 *
 *  Every figure that decides a verdict comes from the STORE read with
 *  `bun:sqlite` or from the accessibility tree — never from the page's account
 *  of what it just did. The central claim (`context_selects_the_row`) is graded
 *  by EFFECT for exactly that reason: asking the page which row its menu is
 *  about is asking the defect whether it is present. */
export interface ContextMetrics {
  /** Context-item nodes in the walk taken before any right-click, and in the
   *  walk taken with the menu open on a row. */
  baseline_item_nodes: number;
  open_item_nodes: number;
  /** The names those items actually exposed, in tree order, and how many came
   *  back EMPTY — the recorded `generic` collapse costs a name, not a node. */
  open_item_names: string[];
  unnamed_item_nodes: number;
  panel_role: string;
  item_role: string;
  /** The row the application opens on, and the row the rig right-clicked. They
   *  must DIFFER, or every claim below is true of the resting state and the rig
   *  has measured nothing. */
  boot_selection_title: string;
  clicked_row_title: string;
  clicked_row_id: string;
  /** Which rows the STORE has in the bin after Delete ran from the context
   *  menu. Exactly the clicked one, or the menu acted on something else. */
  binned_row_ids: string[];
  /** The create phase: the row right-clicked, and the row the store gained.
   *  `expected_*` is 027's placement rule, restated in context-placement.ts and
   *  evaluated against the store's walk BEFORE the create; `created_row_id` is
   *  the fixture's answer, and `created_row_landed_as_expected` compares the
   *  two AFTER it. */
  create_clicked_row_id: string;
  created_row_id: string | null;
  created_row_parent_id: string | null;
  created_row_type: string | null;
  expected_parent_id: string | null;
  expected_after_id: string | null;
  created_row_landed_as_expected: boolean;
  store_rows_before_create: number;
  store_rows_after_create: number;
  /** The rendered removal label, against the same row's bin state read out of
   *  SQLite rather than out of the page. */
  label_when_live: string;
  label_when_trashed: string;
  live_row_trashed_in_store: boolean;
  trashed_row_trashed_in_store: boolean;
  /** Shift+F10 on the focused row, and what Escape leaves behind. */
  keyboard_item_nodes: number;
  items_after_escape: number;
  /** Visible X windows carrying the shell's WM_CLASS either side of a
   *  right-click inside `#editor`. A GTK popup inherits that class, so an extra
   *  window is the engine's own menu appearing. */
  editor_windows_before: number;
  editor_windows_after: number;
  peak_rss_mb: number;
}

export function evaluateContextGates(m: ContextMetrics): GateResult[] {
  const opened = m.open_item_nodes > m.baseline_item_nodes;
  const distinctTarget =
    m.clicked_row_title.trim().length > 0 && m.clicked_row_title !== m.boot_selection_title;
  return [
    {
      // The CLOSED walk is taken first, deliberately. Walking open then closed
      // would pass on a page that painted its items at boot and merely cleared
      // them afterwards: the menu would be proving it can close while this gate
      // claimed it can open.
      gate: "context_opens",
      value: `${m.baseline_item_nodes} item node(s) before the right-click -> ${m.open_item_nodes} after`,
      threshold: "right-clicking a navigator row exposes menu items AT-SPI could not see before it",
      verdict: opened && m.open_item_nodes > 0 ? "PASS" : "FAIL",
    },
    {
      // The roles are RECORDED, not asserted: there is no prior measurement of
      // this panel's mapping to assert against. What IS asserted is the thing a
      // collapsed role costs — an item exposed under a role that carries no
      // name is an item nobody can read.
      gate: "context_items_named",
      value: `panel:${m.panel_role} item:${m.item_role}; ${m.unnamed_item_nodes} unnamed of ${m.open_item_nodes} [${m.open_item_names.join(" | ")}]`,
      threshold: "every exposed context-menu item carries a non-empty accessible name",
      verdict: m.open_item_nodes === 0 ? "UNKNOWN" : m.unnamed_item_nodes === 0 ? "PASS" : "FAIL",
    },
    {
      // THE CENTRAL CLAIM, and it is graded by effect. The defect this guards
      // is a surface acting on the row the writer LEFT, and a rig that asked
      // the page which row its menu was about would be asking the defect
      // whether it is present. So: right-click a row that is NOT the boot
      // selection, run Delete, and read the bin out of SQLite. A menu acting on
      // the selection instead of the captured row bins the OTHER scene, and
      // this is the only instrument that can see it.
      gate: "context_selects_the_row",
      value: distinctTarget
        ? `right-clicked "${m.clicked_row_title}" (${m.clicked_row_id}) while the boot selection was "${m.boot_selection_title}"; the store has ${m.binned_row_ids.length} row(s) in the bin: ${m.binned_row_ids.join(", ") || "none"}`
        : `the clicked row was the boot selection ("${m.boot_selection_title}"), so the click proves nothing`,
      threshold:
        "Delete from a context menu opened on a row that was NOT selected bins exactly that row",
      verdict:
        !distinctTarget
          ? "UNKNOWN"
          : m.binned_row_ids.length === 1 && m.binned_row_ids[0] === m.clicked_row_id
            ? "PASS"
            : "FAIL",
    },
    {
      // RENAMED from context_creates_under_the_clicked_row: an earlier change
      // made placement type-aware, and a new scene from a scene row lands BESIDE
      // it, under the nearest chapter -- not under the clicked row itself. A
      // name that still asserted the old rule would lie in every result's
      // verdict list, so the gate keeps the new name rather than a repair.
      gate: "context_creates_where_027_places_it",
      value: `${m.store_rows_before_create} -> ${m.store_rows_after_create} row(s); clicked ${m.create_clicked_row_id}, created ${m.created_row_id ?? "nothing"} of type ${m.created_row_type ?? "none"}; expected parent ${m.expected_parent_id ?? "root"} after ${m.expected_after_id ?? "(append)"}, landed under parent ${m.created_row_parent_id ?? "none"}`,
      threshold:
        "New scene from the context menu adds one `scene` under 027's target parent (nearest " +
        "chapter, else part) immediately after the clicked row's ancestor-or-self in that parent",
      verdict:
        m.store_rows_after_create === m.store_rows_before_create + 1 &&
        m.created_row_type === "scene" &&
        m.created_row_landed_as_expected
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "context_label_tracks_the_row",
      value: `live row -> "${m.label_when_live}" (trashed in store: ${m.live_row_trashed_in_store}); binned row -> "${m.label_when_trashed}" (trashed in store: ${m.trashed_row_trashed_in_store})`,
      threshold:
        "the rendered Delete/Restore matches the clicked row's bin state AS THE STORE HAS IT",
      verdict:
        m.label_when_live === "Delete" &&
        !m.live_row_trashed_in_store &&
        m.label_when_trashed === "Restore" &&
        m.trashed_row_trashed_in_store
          ? "PASS"
          : "FAIL",
    },
    {
      // Compared against the POINTER route's count rather than against zero: a
      // chord that opened some other menu, or a truncated one, would satisfy
      // "more than nothing" and fail this.
      gate: "context_keyboard_opens",
      value: `Shift+F10 exposed ${m.keyboard_item_nodes} item(s) against the pointer's ${m.open_item_nodes}; ${m.items_after_escape} left after Escape`,
      threshold: "Shift+F10 on the focused row opens the same menu, and Escape leaves none painted",
      verdict:
        m.keyboard_item_nodes > 0 &&
        m.keyboard_item_nodes === m.open_item_nodes &&
        m.items_after_escape === 0
          ? "PASS"
          : "FAIL",
    },
    {
      // THE SUPPRESSION IS SCOPED, and this is what checks the other half of it.
      // `#nav` cancels `contextmenu`; `#editor` must not, because the engine's
      // own menu there carries WebKitGTK's spelling suggestions, which is the
      // whole of what this scoping delivers. A document-level handler would
      // take them with it and NOTHING in the unit suite would notice, because
      // no test and no gate looks at a menu the engine draws.
      //
      // Measured, not asked: a GTK popup inherits the application's WM_CLASS, so
      // the X server's count of visible windows carrying it moves when the menu
      // appears. That count is also why this rig can grade the claim at all --
      // the popup is not in the page's DOM and not in the accessibility tree
      // under the application, so there is nothing else to look at.
      gate: "context_editor_menu_survives",
      value: `${m.editor_windows_before} -> ${m.editor_windows_after} visible window(s) with the shell's WM_CLASS after a right-click in #editor`,
      threshold: "a right-click inside #editor still raises the engine's own menu (one more X window)",
      verdict:
        m.editor_windows_before < 1
          ? "UNKNOWN"
          : m.editor_windows_after > m.editor_windows_before
            ? "PASS"
            : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `< ${THRESHOLDS.peak_rss_mb}`,
      verdict: m.peak_rss_mb < THRESHOLDS.peak_rss_mb ? "PASS" : "FAIL",
    },
  ];
}

// ---------------------------------------------------------------------------
// Bible gates: the book's second half -- what a scene is ABOUT, who is in it,
// and where they appear -- plus the memory cost of holding a photograph.
//
// WHY ONE FAMILY AND NOT FIVE. Slices 035, 036, 037, 038/042 and 039 shipped
// five surfaces that share one store, one navigator selection and one menu, and
// every claim about all five rests on unit tests and screenshots. That is the
// position the readable mirror was in when a defect that made the whole feature
// inoperative survived four slices (2026-08-27 write-back). Five rigs would be
// five seedings, five Xvfb servers and five walk budgets for surfaces that are
// reached the same way; one rig with a boot per claim is the same coverage at a
// fifth of the wall clock.
//
// EVERY ORACLE HERE IS THE FILE. The store read directly with `bun:sqlite`, the
// exported manuscript read with `markdown-read.ts`, and the regenerated
// thumbnail read with `png.ts` -- none of them the page's account of itself, and
// none of them imported from the host module under test.

/** `pictures::THUMB_MAX`, restated. The harness restates thresholds rather than
 *  importing them, deliberately: two programs, and a shared constant hides a
 *  drift instead of failing on it. */
const THUMB_MAX_PX = 256;

/** The RSS ceiling every other rig here states, restated again for the same
 *  reason. This run is the FIRST anywhere in this project to hold a
 *  multi-megapixel picture while it is measured, so it is also the first
 *  reading of this gate that has anything to say about pictures. */
const BIBLE_RSS_MB = 750;

export interface BibleMetrics {
  /** The `type` of the root the note landed under, or null when the note has no
   *  root or no note was created. The claim is `bible` and not merely "a root":
   *  a note created at the manuscript's own root is the defect 035 exists to
   *  prevent, and it would still be a row under a root. */
  note_root_type: string | null;
  /** The nonce typed into the note is in the note's stored body. Without it the
   *  gate above passes for a note nobody could write in. */
  note_body_holds_nonce: boolean;
  /** The exported manuscript contains the note's nonce. THIS IS THE DEFECT: a
   *  bible is excluded from the book BY ID, and an exporter that walks the tree
   *  blind would carry the writer's private notes into the file they publish. */
  export_holds_note_nonce: boolean;
  /** The exported manuscript still contains a sentence from the manuscript
   *  itself. Without it, an exporter that emitted NOTHING would satisfy the
   *  exclusion gate perfectly -- the recorded "a stability property is vacuous
   *  without a needle" shape. */
  export_holds_manuscript_prose: boolean;

  /** How many `synopsis` rows the file holds after the panel saved one. */
  synopsis_rows: number;
  /** The item the synopsis landed on == the scene the page opens at boot,
   *  computed by the rig from the store's own walk. */
  synopsis_on_the_open_scene: boolean;
  /** What the store holds, and what the rig typed. Compared rather than
   *  contained: a save that truncated or trimmed the writer's paragraphs is a
   *  defect a containment check would pass. */
  synopsis_body: string;
  synopsis_typed: string;
  /** What the store holds after the panel was reopened and Save pressed with
   *  NOTHING typed. A panel that failed to prefill saves an empty field, and the
   *  store deletes the row on an empty body -- so this reads the panel's READ
   *  path through its effect, with no walk and no question asked of the page. */
  synopsis_after_blind_resave: string;

  /** Every cast name in the file, and the one the rig typed into the panel. */
  cast_names: string[];
  cast_typed_name: string;
  /** The kind stored against that name, or null when it is not there. The
   *  panel's select defaults to the first kind; a create that dropped the kind
   *  would store an empty string, which is a member no group can show. */
  cast_kind: string | null;
  cast_expected_kind: string;

  /** The cast members tagged onto the open scene, and the one the rig ticked. */
  appearance_on_scene: string[];
  /** Every (item, member) pair in the file. A panel that wrote the whole cast
   *  onto every item would satisfy the gate above and is not the feature. */
  appearance_rows_total: number;

  /** Every alias stored against the member the rig created, read directly
   *  from `cast_alias` -- the same file-is-the-oracle rule the cast name and
   *  appearance figures above already follow (105). */
  cast_aliases: string[];
  /** The alias the rig typed into the sheet's alias row and saved. */
  cast_alias_typed: string;
  /** Every accessible NAME under the hover card after the rig hovered the
   *  alias in the prose, joined with a newline by `cast-hover.ts`'s
   *  `castCardText` -- null when the card never appeared at all. Read this
   *  way rather than by one hard-coded node, `castCardText`'s own reason:
   *  the card's name element carries no DOM id for AT-SPI to key on. */
  cast_alias_card_text: string | null;

  /** `#cast-picture-full` was in the accessibility tree after the entry was
   *  selected. It is painted ONLY when the host answered with a thumbnail, so
   *  its presence is the panel having asked and the page having drawn -- and its
   *  absence means nothing was pressed, which is why the viewer gate below reads
   *  UNKNOWN rather than FAIL for it. */
  picture_full_button_found: boolean;
  /** `#picture-viewer-close` was in the tree after the press. The viewer is
   *  `hidden` when closed and WebKitGTK prunes a hidden subtree entirely, so
   *  this is the viewer being OPEN and not merely constructed. */
  picture_viewer_open: boolean;
  /** The long side of the thumbnail the HOST regenerated, or 0 when there is no
   *  file at that path and null when there is one and it is not a PNG. The
   *  three answers are different defects. */
  thumbnail_long_side: number | null;
  /** The long side of the original the rig planted, so the bound can be graded
   *  as a REDUCTION and not merely as a number under 256. A thumbnail that is
   *  the original untouched would pass a bare ceiling for any small picture. */
  original_long_side: number;

  peak_rss_mb: number;
}

export function evaluateBibleGates(m: BibleMetrics): GateResult[] {
  const noteOk = m.note_root_type === "bible" && m.note_body_holds_nonce;
  const synopsisOk =
    m.synopsis_rows === 1 && m.synopsis_on_the_open_scene && m.synopsis_body === m.synopsis_typed;
  const castOk = m.cast_names.includes(m.cast_typed_name) && m.cast_kind === m.cast_expected_kind;
  const appearsOk =
    m.appearance_on_scene.length === 1 &&
    m.appearance_on_scene[0] === m.cast_typed_name &&
    m.appearance_rows_total === 1;
  const thumb = m.thumbnail_long_side;
  return [
    {
      gate: "bible_note_created",
      value:
        m.note_root_type === null
          ? "NO NOTE UNDER ANY ROOT"
          : `a note under a "${m.note_root_type}" root, body holds the nonce: ${m.note_body_holds_nonce}`,
      threshold: 'Outline > New note creates a note under a "bible" root and it accepts prose',
      verdict: noteOk ? "PASS" : "FAIL",
    },
    {
      gate: "bible_excluded_from_manuscript",
      value: m.export_holds_note_nonce
        ? "THE EXPORTED MANUSCRIPT CARRIES THE NOTE'S TEXT"
        : `the note's text is absent; manuscript prose present: ${m.export_holds_manuscript_prose}`,
      threshold:
        "the exported manuscript holds the book's prose and none of the bible's " +
        "(the second clause is the needle: an exporter that emitted nothing would pass the first)",
      verdict: !m.export_holds_manuscript_prose
        ? "UNKNOWN"
        : m.export_holds_note_nonce
          ? "FAIL"
          : "PASS",
    },
    {
      gate: "synopsis_saved",
      value: synopsisOk
        ? `1 synopsis on the open scene, ${m.synopsis_body.length} character(s), exactly as typed`
        : `${m.synopsis_rows} row(s); on the open scene: ${m.synopsis_on_the_open_scene}; ` +
          `stored ${JSON.stringify(m.synopsis_body)} against typed ${JSON.stringify(m.synopsis_typed)}`,
      threshold: "one synopsis row, on the scene the page opened, holding exactly what was typed",
      verdict: synopsisOk ? "PASS" : "FAIL",
    },
    {
      // GRADED THROUGH ITS EFFECT, because the alternative is asking the panel
      // what is in its own field. A reopen that did not prefill saves an empty
      // body and the store deletes the row; a reopen that prefilled saves the
      // same paragraphs back.
      gate: "synopsis_prefills_on_reopen",
      value:
        m.synopsis_after_blind_resave === ""
          ? "THE ROW IS GONE: the reopened panel saved an empty field"
          : m.synopsis_after_blind_resave === m.synopsis_typed
            ? "the reopened panel saved back what the store held"
            : `the reopened panel saved ${JSON.stringify(m.synopsis_after_blind_resave)}`,
      threshold:
        "reopening the panel and pressing Save with nothing typed leaves the synopsis unchanged",
      verdict: m.synopsis_after_blind_resave === m.synopsis_typed ? "PASS" : "FAIL",
    },
    {
      gate: "cast_member_created",
      value: castOk
        ? `"${m.cast_typed_name}" is in the book as a ${m.cast_kind}`
        : `the file holds [${m.cast_names.join(", ")}]; kind of the typed name: ${m.cast_kind}`,
      threshold: "the name typed into the panel is in the file, under the kind the select offered",
      verdict: castOk ? "PASS" : "FAIL",
    },
    {
      gate: "appearance_tagged",
      value: appearsOk
        ? `the open scene is tagged with "${m.cast_typed_name}" and nothing else`
        : `the scene carries [${m.appearance_on_scene.join(", ")}]; ${m.appearance_rows_total} row(s) in the file`,
      threshold:
        "ticking one member tags the open scene with that member and writes no other row " +
        "(the second clause rules out a panel that tags everything)",
      verdict: appearsOk ? "PASS" : "FAIL",
    },
    {
      // THE FILE, `cast_member_created`'s own oracle: `cast_alias` read
      // directly rather than asked of the page (105).
      gate: "cast_alias_saved",
      value: m.cast_aliases.length === 0 ? "NO ALIAS STORED" : `[${m.cast_aliases.join(", ")}]`,
      threshold: `the alias typed into the sheet ("${m.cast_alias_typed}") is in the member's alias list`,
      verdict: m.cast_aliases.includes(m.cast_alias_typed) ? "PASS" : "FAIL",
    },
    {
      // THE ORACLE IS THE ACCESSIBILITY TREE, `picture_viewer_opens`'s own
      // reason: an open card is the one channel that can tell "the plugin
      // marked the alias and the page drew a card over it" from "nothing
      // happened at all". FAILS on a card that never opens as well as one
      // that opens naming the wrong person -- both are the same defect from
      // a reader's chair.
      gate: "cast_alias_marks",
      value:
        m.cast_alias_card_text === null
          ? "THE CARD NEVER OPENED"
          : m.cast_alias_card_text.includes(m.cast_typed_name)
            ? `the card is up and names "${m.cast_typed_name}"`
            : `the card is up but does not name "${m.cast_typed_name}": ${JSON.stringify(m.cast_alias_card_text)}`,
      threshold:
        "hovering the alias in the prose opens the card, and the card's own text names the " +
        "member's full name (the canonical name on the card, per the design record)",
      verdict:
        m.cast_alias_card_text !== null && m.cast_alias_card_text.includes(m.cast_typed_name)
          ? "PASS"
          : "FAIL",
    },
    {
      // The oracle is the FILE the host wrote, read by the harness's own PNG
      // reader. Nothing here asks the page whether it showed a picture.
      gate: "picture_thumbnail_bounded",
      value:
        thumb === null
          ? "THE CACHED THUMBNAIL IS NOT A PNG"
          : thumb === 0
            ? "NO THUMBNAIL WAS WRITTEN: the panel never read the picture"
            : `${thumb}px on its long side, down from ${m.original_long_side}px`,
      threshold: `a thumbnail exists, is <= ${THUMB_MAX_PX}px on its long side, and is smaller than the original`,
      verdict:
        thumb !== null && thumb > 0 && thumb <= THUMB_MAX_PX && thumb < m.original_long_side
          ? "PASS"
          : "FAIL",
    },
    {
      // 038 recorded that nothing in this application could show a picture
      // properly, and 042 shipped the viewer that closed it. NOTHING HAS EVER
      // GRADED IT: the claim rested on two screenshots. The oracle is the
      // accessibility tree's account of whether the panel is painted, which is
      // the one channel that can tell an open viewer from a constructed one.
      gate: "picture_viewer_opens",
      value: !m.picture_full_button_found
        ? "nothing was pressed: the sheet showed no picture to enlarge"
        : m.picture_viewer_open
          ? "the viewer is open"
          : "THE VIEWER DID NOT OPEN",
      threshold: "pressing the sheet's picture square paints the picture viewer",
      verdict: !m.picture_full_button_found ? "UNKNOWN" : m.picture_viewer_open ? "PASS" : "FAIL",
    },
    {
      // UNKNOWN WHEN NO PICTURE WAS OPEN, and that is the whole point of this
      // reading. `peak_rss_mb` has been recorded by nine rigs and not one of
      // them held a photograph, so a figure from a boot whose panel showed
      // nothing would be the tenth such number wearing this gate's name.
      gate: "peak_rss_mb",
      value: m.picture_full_button_found
        ? m.peak_rss_mb
        : `${m.peak_rss_mb} (NO PICTURE WAS OPEN)`,
      threshold: `<= ${BIBLE_RSS_MB}, measured with a photograph open at full size`,
      verdict: !m.picture_full_button_found
        ? "UNKNOWN"
        : m.peak_rss_mb <= BIBLE_RSS_MB
          ? "PASS"
          : "FAIL",
    },
  ];
}

// --------------------------------------------------------------- salvage-cli

/** How long a whole salvage of the STRESS fixture may take.
 *
 *  MEASURED FIRST, THEN SET. Four consecutive runs against a 20,000-item,
 *  15,200-document, 16 MB project on the measurement machine: 668, 485, 486, 486 ms, the
 *  first cold. The number is ~5x the warm figure, which is the headroom a
 *  command that copies the file and walks twelve tables has to be allowed for a
 *  colder page cache and a slower disk, and it is still far under any wall clock
 *  a person would call a hang. `tiny` is graded against the same number and
 *  cannot reach it: the threshold string says so, because a gate that only one
 *  fixture can fail must not read as evidence from the other. */
const SALVAGE_MS = 3000;

/** Peak resident memory of the salvage PROCESS, in MB.
 *
 *  Measured 101-104 MB at `stress` on the same four runs. The gate is ~3x that,
 *  and deliberately far below the application's own 750: the command holds the
 *  walk, one document at a time and the rendered manuscript, and a build that
 *  started holding every body at once is exactly what this figure exists to
 *  catch. 046 named this measurement as the thing the rig adds over unit tests
 *  and it had never been taken. */
const SALVAGE_RSS_MB = 300;

/** The worst single salvage over the CORPUS of genuinely damaged files, in ms.
 *
 *  A LIVENESS BOUND AND NOT A BUDGET. The corpus is where a build hangs if it is
 *  ever going to: a b-tree cursor sent to a page that is not there, an
 *  enumeration over a file whose header lies about its size. Measured at
 *  `stress`, the slowest entry is the one that recovers the most (~500 ms) and
 *  every refusal is under 50; the number is an order of magnitude above that,
 *  because what it must separate is "slow" from "never". The rig's own timeout
 *  is far higher again and turns a true hang into a killed process, which
 *  `salvage_corpus_terminates` reports as a disallowed exit rather than as a
 *  slow one. */
const SALVAGE_CORPUS_MS = 5000;

/** How many entries the corpus must hold before its verdicts are evidence. A
 *  corpus that lost its entries to a generator throwing would otherwise report
 *  every property as satisfied over an empty list. */
const SALVAGE_CORPUS_MIN = 7;

/** One damaged file, run. */
export interface SalvageCorpusRun {
  name: string;
  /** The exit codes this entry may legitimately produce, restated from the
   *  corpus plan. 2 is an honest refusal and 3 is salvage WORKING. */
  allowed_exits: number[];
  exit_code: number;
  wall_ms: number;
  /** The process died on a signal, or its stderr carried a Rust panic. */
  panicked: boolean;
  /** null when no manifest was written, which is the refusal path. */
  complete: boolean | null;
  items_recovered: number | null;
  documents_recovered: number | null;
  loss_kinds: string[];
  /** sha256 of the bytes handed to salvage, and of the bytes a SECOND,
   *  independent generation produced from a separately seeded base. */
  digest: string;
  digest_again: string;
}

export interface SalvageMetrics {
  fixture: string;

  /** What the store holds, read with bun:sqlite, against what the manifest says
   *  came back and what is on disk under `documents/`. Three figures, because a
   *  manifest that counted right and wrote nothing is a different defect from
   *  one that wrote files and miscounted. */
  store_items: number;
  store_documents: number;
  manifest_items_recovered: number;
  manifest_documents_recovered: number;
  document_files_written: number;
  /** The manuscript holds a sentence read out of the store. Without it an
   *  exporter that wrote 30 empty files would satisfy every count above. */
  manuscript_holds_stored_prose: boolean;

  /** Planted, recovered, and read back out of `synopses.md` by the harness's own
   *  reader. `bodies_match` compares the strings rather than containing them. */
  synopses_planted: number;
  synopses_recovered: number;
  synopses_in_file: number;
  synopsis_bodies_match: boolean;

  cast_members_planted: number;
  cast_fields_planted: number;
  cast_members_recovered: number;
  cast_fields_recovered: number;
  /** Every planted member is in `cast.md` under a group, with its own details in
   *  the writer's ordinal order and its summary intact. */
  cast_file_agrees: boolean;

  appearances_planted: number;
  appearances_recovered: number;
  /** Each tag is a line under the member it belongs to, naming the item's TITLE
   *  -- which is the whole of what 039 asked for and 048 built. */
  appearance_lines_found: number;

  comments_planted: number;
  comments_recovered: number;
  comments_orphaned: number;
  /** How many notes came back with the `(orphaned)` mark, and how many with
   *  `(resolved)`. Read out of the file, never from the manifest, so the mark
   *  and the count are two independent readings of one fact. */
  comment_orphan_marks: number;
  comment_resolved_marks: number;
  /** Every planted note's body and stored quote are in the file. */
  comment_bodies_match: boolean;
  /** The healthy project holds a COLLAPSED anchor. 049: a collapsed anchor is a
   *  recovered note with a caveat and never a loss, because the row read
   *  perfectly. These are the healthy run's answers. */
  collapsed_anchor_planted: boolean;
  healthy_complete: boolean;
  healthy_loss_kinds: string[];

  wordlist_planted: string[];
  wordlist_recovered: number;
  /** As the file lists them, in the file's order. */
  wordlist_in_file: string[];

  pictures_planted: number;
  pictures_recovered: number;
  /** The copied bytes are byte-identical to the planted original. */
  picture_bytes_match: boolean;

  covers_planted: number;
  covers_recovered: number;
  /** `covers.md` names a front and a back, and both files are on disk. */
  cover_files_written: number;

  /** The five `meta` keys planted, and what the manifest's `design` object holds
   *  against them. Compared VALUE BY VALUE: a design that recovered five nulls
   *  would satisfy a count. */
  design_planted: Record<string, string>;
  design_recovered: Record<string, string | null>;

  snapshots_planted: number;
  snapshot_documents_planted: number;
  snapshots_recovered: number;
  versions_recovered: number;
  /** Files actually written under `snapshots/<id>/`. */
  snapshot_files_written: number;
  /** The prose of the planted past draft is in one of them. */
  snapshot_holds_the_past_draft: boolean;

  /** Automatic versions planted, and what the manifest says it dropped. 050: a
   *  dropped version is in NO loss list, so this figure is the only place it is
   *  said. */
  automatic_versions_planted: number;
  versions_dropped: number;

  /** The damaged run. `expected` is the union of the scripted damage's own owed
   *  kinds; `actual` is what the recovery reported. */
  damaged_exit_code: number;
  damaged_complete: boolean;
  expected_loss_kinds: string[];
  damaged_loss_kinds: string[];
  /** The corrupted body's bytes were written verbatim beside the others. */
  damaged_raw_bodies: number;

  /** All four outcomes, driven through the release binary. 0 recovered
   *  everything, 1 the operator asked wrongly, 2 the source could not be read,
   *  3 it answered and the answer carries losses. */
  exit_healthy: number;
  exit_occupied_destination: number;
  exit_unreadable_source: number;
  exit_damaged: number;

  salvage_ms: number;
  peak_rss_mb: number;

  /** How many `manifest.json` files this run read. The gate below is satisfied
   *  perfectly by a run that read NONE, so the count carries the vacuity
   *  clause. */
  manifests_read: number;
  /** Every string in every manifest this run wrote that names an absolute path
   *  or the directory the run happened in, tagged with the run that wrote it
   *  (054, `decisions/2026-08-29-no-home-directory.md`).
   *
   *  A LIST AND NOT A COUNT, because there is no threshold here: one is too
   *  many, and what a reader needs when it goes red is which key of which
   *  manifest. */
  named_paths_in_manifests: { run: string; at: string; value: string }[];

  /** THE CORPUS OF GENUINELY DAMAGED FILES: a truncated write, a torn page, a
   *  header that lies about the file's geometry, a broken b-tree pointer, an
   *  unreplayable write-ahead log. 051 graded salvage against injuries
   *  inflicted THROUGH SQL, on files SQLite still considers valid; these are
   *  the ones it does not. */
  corpus: SalvageCorpusRun[];
  /** The healthy salvage of the same seeded project, which is the oracle every
   *  corpus entry is read against: a damaged file that reports itself COMPLETE
   *  must have recovered exactly as much as the healthy one did. */
  corpus_healthy_items: number;
  corpus_healthy_documents: number;
}

function sameStringMap(a: Record<string, string>, b: Record<string, string | null>): boolean {
  const keys = Object.keys(a);
  return keys.length > 0 && keys.every((k) => b[k] === a[k]);
}

/** The readable mirror, driven end to end (022).
 *
 * **THE STANDING P0 THIS CLOSES.** Slices 019, 020, 021 and 029 all shipped
 * with the same note in their write-backs: no rig covers the mirror, and every
 * claim about it in this repository is checked by a `cargo` test over a temp
 * directory. 029 was a total defect -- every prose edit invisible to the folder,
 * permanently -- that lived through four slices and was found by READING. These
 * gates are what would have caught it: `mirror_carries_a_prose_edit` fails
 * against the tree 029 fixed.
 */
export interface MirrorMetrics {
  fixture: string;
  /** Markdown files the folder holds after the first boot, and documents the
   *  store holds. Not equal by construction -- containers get an `index.md` --
   *  so the gate compares against the DOCUMENT count as a floor. */
  files_written: number;
  store_documents: number;
  /** The typed sentence, found in a mirror file by the harness's OWN reader
   *  (`mirror-read.ts`), never by the host's parser. The design names an
   *  independent restatement as an obligation of this comparison, and until
   *  this rig existed `mirror-read.ts` shipped with no gate consuming it. */
  file_holds_the_typed_sentence: boolean;
  /** The same sentence typed AFTER the entry's first write. This is 029's
   *  defect exactly: the incremental skip compared the item revision, which no
   *  keystroke moves, so every edit after the first write was skipped forever. */
  file_holds_the_second_sentence: boolean;
  /** After a file was rewritten from outside and the application reopened, the
   *  writer's own words are still the ones on disk. The design calls
   *  overwriting them "the single worst thing this feature could do". */
  external_edit_survived_the_reopen: boolean;
  /** The change set the application itself reported, through its own panel. */
  rows_offered: number;
  /** The scene's body in the STORE holds the words the writer put in the file.
   *  Read from the file after the process that wrote it is gone. */
  accepted_body_in_the_store: boolean;
  /** Every snapshot row's label the HOST composed, in the id order they were
   *  written. The only inverse this application has -- there is no structural
   *  undo -- so an acceptance that left no snapshot left no way back. ALL OF
   *  THEM, not the first: two accepts (a per-row press, then the batch) each
   *  owe a snapshot, and a gate that stopped at the first would be satisfied
   *  by the per-row press alone even if the batch's own accept left none. */
  snapshot_labels: string[];
  /** The accepted document's notes came back collapsed. `anchor_from >=
   *  anchor_to` is the derivation the whole comments feature uses for an
   *  orphan, and this is the one place it is checked end to end. */
  comments_planted: number;
  comments_orphaned: number;
  /** The bytes on disk after the acceptance and the close pass that follows it,
   *  against the bytes the writer's editor left. THE SETTLE GATE: without it
   *  the pass ten seconds later rewrites the file it has just read. */
  file_unchanged_after_accept: boolean;
  /** The manifest's recorded hash for that entry, against the file's. A
   *  baseline that does not describe the file on disk is the one thing it may
   *  never be. */
  manifest_matches_the_file: boolean;
  /** Per-row accept controls the walk found before this rig chose whether to
   *  press one -- named in the two gates below whenever they FAIL, so a run
   *  that could not press because the fixture offered too few says how many
   *  it actually saw rather than just going quiet. */
  row_accepts_offered: number;
  /** Whether this run actually pressed a row's own accept. FALSE covers two
   *  shapes the same way: the walk found fewer than two per-row controls, or
   *  it found two but not the two names this run needed (target's and
   *  other's). Either way there was nothing safe to press, and everything
   *  downstream that depends on a per-row accept having happened -- the two
   *  gates below, and `mirror_accept_is_undoable`'s snapshot count -- reads
   *  this rather than assuming the press it asked for is the press that
   *  landed. */
  row_accept_pressed: boolean;
  /** A change-set row's OWN accept, pressed by its accessible name rather than
   *  the batch control (080) -- read from the store right after that one
   *  press, before the batch control is pressed at all, and read from the
   *  DOCUMENT ROW WHOSE `item_id` IS TARGET'S, never from "any document in the
   *  store": a host that wrote the accepted body into the wrong document, or
   *  into every document, must not pass this by accident. FALSE (and both
   *  per-row gates FAIL) when `row_accept_pressed` is false too -- there is
   *  nothing this run pressed for the words to have followed. */
  row_accept_took_its_file: boolean;
  /** Read at the same moment as `row_accept_took_its_file`, from the document
   *  row whose `item_id` is OTHER'S. The SECOND file's words, staged beside
   *  the first so there is a row the per-row press must leave alone, did NOT
   *  reach the book -- the whole difference between a per-row accept and the
   *  batch, which would have taken both. One of this pair passing without the
   *  other is what a batch press pressed by mistake in the row's place would
   *  produce. */
  row_accept_left_the_other_file: boolean;
  /** The per-row path's OWN settle, `mirror_settles_after_an_accept`'s
   *  counterpart for the accept this slice adds: the bytes target's file
   *  holds, and the manifest's hash for it, after the WHOLE run -- both
   *  boots, both accepts, and the wait past a full mirror cycle. Meaningless
   *  when `row_accept_pressed` is false, which is when the gate below reads
   *  UNKNOWN instead of grading a press that never happened. */
  row_accept_file_unchanged: boolean;
  row_accept_manifest_matches_the_file: boolean;
  peak_rss_mb: number;
}

export function evaluateMirrorGates(m: MirrorMetrics): GateResult[] {
  const wrote = m.files_written >= m.store_documents && m.store_documents > 0;
  const orphaned = m.comments_planted > 0 && m.comments_orphaned === m.comments_planted;
  // ONE SNAPSHOT PER ACCEPT THAT ACTUALLY RAN, never "at least one": the batch
  // always accepts, so a run where the per-row press was skipped still owes
  // exactly one; a run where it landed owes two, and `.find` on the first
  // "Before accepting" label (the old shape of this gate) could not tell a
  // second, missing snapshot from a first one it had already found.
  const beforeAccepting = m.snapshot_labels.filter((l) => l.startsWith("Before accepting"));
  const snapshotsWanted = m.row_accept_pressed ? 2 : 1;
  return [
    {
      gate: "mirror_writes_the_folder",
      value: `${m.files_written} file(s) for ${m.store_documents} document(s)`,
      threshold: "a file per document, and the fixture has documents",
      verdict: wrote ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_carries_a_prose_edit",
      value:
        `first sentence ${m.file_holds_the_typed_sentence ? "in the folder" : "MISSING"}, ` +
        `second ${m.file_holds_the_second_sentence ? "in the folder" : "MISSING"}`,
      threshold: "both -- an edit AFTER an entry's first write still reaches the folder (029)",
      verdict:
        m.file_holds_the_typed_sentence && m.file_holds_the_second_sentence ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_does_not_overwrite_an_outside_edit",
      value: m.external_edit_survived_the_reopen
        ? "the writer's words are still on disk"
        : "THE APPLICATION OVERWROTE THEM",
      threshold: "reopening a project does not rewrite a file edited outside it",
      verdict: m.external_edit_survived_the_reopen ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_offers_the_change",
      value: `${m.rows_offered} row(s) in the change set`,
      threshold: "> 0 -- the application noticed the edit and said so",
      verdict: m.rows_offered > 0 ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_accept_reaches_the_book",
      value: m.accepted_body_in_the_store
        ? "the store holds the words from the file"
        : "THE STORE DOES NOT HOLD THEM",
      threshold: "pressing the control writes the file's words into the manuscript",
      verdict: m.accepted_body_in_the_store ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_accept_is_undoable",
      value:
        `${beforeAccepting.length} of ${snapshotsWanted} wanted "Before accepting" snapshot(s): ` +
        (m.snapshot_labels.length === 0 ? "NONE" : m.snapshot_labels.join(" | ")),
      threshold: m.row_accept_pressed
        ? "two host-composed snapshots -- one per accept that ran (the per-row press, then the batch)"
        : "one host-composed snapshot -- the batch is the only accept that ran",
      verdict: beforeAccepting.length === snapshotsWanted ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_accept_orphans_the_notes",
      value: `${m.comments_orphaned} of ${m.comments_planted} note(s) collapsed`,
      threshold: "every note on a rewritten body, and the fixture planted some",
      verdict: orphaned ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_settles_after_an_accept",
      value:
        `file ${m.file_unchanged_after_accept ? "untouched" : "REWRITTEN"}, ` +
        `manifest ${m.manifest_matches_the_file ? "agrees" : "DISAGREES"}`,
      threshold: "the pass after an accept does not rewrite what it just read",
      verdict: m.file_unchanged_after_accept && m.manifest_matches_the_file ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_row_accept_takes_that_file",
      // NAMES THE OFFERED COUNT ON EVERY FAIL, not only the skip's: a run that
      // pressed the wrong row also has a count worth reading, and a reader of
      // one failing value should not have to cross-reference a second field to
      // learn whether there was anything to press at all.
      value: m.row_accept_took_its_file
        ? "the pressed row's words reached its document"
        : `THE STORE DOES NOT HOLD THEM (${m.row_accepts_offered} per-row accept control(s) offered)`,
      threshold: "pressing one row's own accept, by its accessible name, writes that file's words in",
      verdict: m.row_accept_took_its_file ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_row_accept_leaves_the_other_row",
      value: m.row_accept_left_the_other_file
        ? "the second file's words stayed out of the book"
        : `THE SECOND FILE'S WORDS REACHED THE BOOK TOO (${m.row_accepts_offered} per-row accept control(s) offered)`,
      threshold: "a per-row accept takes only the row it named -- the batch would have taken both",
      verdict: m.row_accept_left_the_other_file ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_row_accept_settles",
      // UNKNOWN, NOT PASS, when the press never happened: an un-pressed file
      // is trivially "untouched", and a gate that read that as a pass would
      // credit a run that tested nothing with having tested the settle.
      value: !m.row_accept_pressed
        ? "not applicable -- the per-row press did not happen"
        : `file ${m.row_accept_file_unchanged ? "untouched" : "REWRITTEN"}, ` +
          `manifest ${m.row_accept_manifest_matches_the_file ? "agrees" : "DISAGREES"}`,
      threshold: "the pass after a per-row accept does not rewrite what it just read either",
      verdict: !m.row_accept_pressed
        ? "UNKNOWN"
        : m.row_accept_file_unchanged && m.row_accept_manifest_matches_the_file
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `<= ${FIRST_RUN_RSS_MB}`,
      verdict: m.peak_rss_mb <= FIRST_RUN_RSS_MB ? "PASS" : "FAIL",
    },
  ];
}

export function evaluateSalvageGates(m: SalvageMetrics): GateResult[] {
  const proseOk =
    m.manifest_items_recovered === m.store_items &&
    m.manifest_documents_recovered === m.store_documents &&
    m.document_files_written === m.store_documents &&
    m.manuscript_holds_stored_prose;
  const synopsisOk =
    m.synopses_recovered === m.synopses_planted &&
    m.synopses_in_file === m.synopses_planted &&
    m.synopsis_bodies_match;
  const castOk =
    m.cast_members_recovered === m.cast_members_planted &&
    m.cast_fields_recovered === m.cast_fields_planted &&
    m.cast_file_agrees;
  const appearsOk =
    m.appearances_recovered === m.appearances_planted &&
    m.appearance_lines_found === m.appearances_planted;
  const commentsOk =
    m.comments_recovered === m.comments_planted &&
    m.comment_resolved_marks + m.comment_orphan_marks > 0 &&
    m.comment_bodies_match;
  const collapsedOk =
    m.collapsed_anchor_planted &&
    m.comments_orphaned === 1 &&
    m.comment_orphan_marks === 1 &&
    m.healthy_complete &&
    m.healthy_loss_kinds.length === 0;
  const wordsSorted = [...m.wordlist_planted].sort();
  const wordlistOk =
    m.wordlist_recovered === m.wordlist_planted.length &&
    m.wordlist_in_file.length === wordsSorted.length &&
    m.wordlist_in_file.every((w, at) => w === wordsSorted[at]);
  const picturesOk = m.pictures_recovered === m.pictures_planted && m.picture_bytes_match;
  const coversOk = m.covers_recovered === m.covers_planted && m.cover_files_written === m.covers_planted;
  const designOk = sameStringMap(m.design_planted, m.design_recovered);
  const snapshotsOk =
    m.snapshots_recovered === m.snapshots_planted &&
    m.versions_recovered === m.snapshot_documents_planted &&
    m.snapshot_files_written === m.snapshot_documents_planted &&
    m.snapshot_holds_the_past_draft;
  // NO `automatic_versions_planted > 0` CLAUSE. It was written and then deleted:
  // the UNKNOWN branch below already refuses a run that planted none, so nothing
  // could reach it, and a guard no input can reach is worse than none because a
  // reader credits it for the refusal. Found by a mutation that survived.
  const droppedOk = m.versions_dropped === m.automatic_versions_planted;
  const missing = m.expected_loss_kinds.filter((k) => !m.damaged_loss_kinds.includes(k));
  const unexpected = m.damaged_loss_kinds.filter((k) => !m.expected_loss_kinds.includes(k));
  const damageOk =
    m.damaged_exit_code === 3 &&
    !m.damaged_complete &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    m.damaged_raw_bodies === 1;
  // A FLOOR AND NOT A CENSUS, deliberately. Tying it to the corpus's own
  // outcomes was written and reverted: a break in one corpus file changes how
  // many manifests exist, so this gate would redden alongside the one that
  // owns the break and the suite's "one break is one red gate" property would
  // stop holding. What guards the count is the rig's own abort, over
  // `manifestsOwed` -- see salvage-read.ts.
  const pathsOk = m.manifests_read >= 2 && m.named_paths_in_manifests.length === 0;
  const exitsOk =
    m.exit_healthy === 0 &&
    m.exit_occupied_destination === 1 &&
    m.exit_unreadable_source === 2 &&
    m.exit_damaged === 3;

  return [
    {
      gate: "salvage_prose_recovered",
      value: proseOk
        ? `${m.store_items} item(s) and ${m.store_documents} document(s), every one on disk`
        : `store ${m.store_items}/${m.store_documents}, manifest ` +
          `${m.manifest_items_recovered}/${m.manifest_documents_recovered}, ` +
          `${m.document_files_written} file(s); manuscript holds stored prose: ` +
          `${m.manuscript_holds_stored_prose}`,
      threshold:
        "every item and every document the store holds is counted in the manifest AND written " +
        "under documents/, and the manuscript carries a sentence read out of the store (the " +
        "last clause is the needle: 30 empty files satisfy every count)",
      verdict: proseOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_synopses_recovered",
      value: synopsisOk
        ? `${m.synopses_planted} summary(ies), each with its own body`
        : `planted ${m.synopses_planted}, manifest ${m.synopses_recovered}, ` +
          `${m.synopses_in_file} in synopses.md; bodies match: ${m.synopsis_bodies_match}`,
      threshold: "every planted synopsis is counted, is in synopses.md, and holds exactly its body",
      verdict: synopsisOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_cast_recovered",
      value: castOk
        ? `${m.cast_members_planted} member(s) and ${m.cast_fields_planted} detail(s), grouped ` +
          "by kind with details in ordinal order"
        : `planted ${m.cast_members_planted}/${m.cast_fields_planted}, manifest ` +
          `${m.cast_members_recovered}/${m.cast_fields_recovered}; cast.md agrees: ` +
          `${m.cast_file_agrees}`,
      threshold:
        "every planted member and detail is counted and in cast.md, each member under its own " +
        "kind's group with its summary and its details in the writer's ordinal order",
      verdict: castOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_appearances_recovered",
      value: appearsOk
        ? `${m.appearances_planted} tag(s), each a line naming the item's title`
        : `planted ${m.appearances_planted}, manifest ${m.appearances_recovered}, ` +
          `${m.appearance_lines_found} line(s) in cast.md`,
      threshold:
        "every planted tag is counted AND appears as a line under its member naming the item " +
        "(039 asked for the title; a count alone would pass a list of uuid pairs)",
      verdict: appearsOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_comments_recovered",
      value: commentsOk
        ? `${m.comments_planted} note(s), ${m.comment_resolved_marks} resolved and ` +
          `${m.comment_orphan_marks} orphaned, each with its stored quote`
        : `planted ${m.comments_planted}, manifest ${m.comments_recovered}; marks ` +
          `${m.comment_resolved_marks} resolved / ${m.comment_orphan_marks} orphaned; ` +
          `bodies and quotes match: ${m.comment_bodies_match}`,
      threshold:
        "every planted note is counted and in comments.md with its range, its STORED quote and " +
        "the writer's words, and the marks the file carries are not all absent",
      verdict: commentsOk ? "PASS" : "FAIL",
    },
    {
      // 049's load-bearing half, and the one gate here whose subject is
      // something salvage must NOT do. A collapsed pair already means "an edit
      // destroyed this passage"; the row read perfectly and the recovery lost
      // nothing, so reporting it would hand `complete: false` and exit 3 to
      // every healthy, heavily revised book.
      gate: "salvage_collapsed_anchor_is_not_a_loss",
      value: !m.collapsed_anchor_planted
        ? "NO COLLAPSED ANCHOR WAS PLANTED"
        : collapsedOk
          ? "the collapsed note came back marked (orphaned), counted, and the salvage is complete"
          : `comments_orphaned ${m.comments_orphaned}, ${m.comment_orphan_marks} mark(s) in the ` +
            `file, complete: ${m.healthy_complete}, losses [${m.healthy_loss_kinds.join(", ")}]`,
      threshold:
        "a project whose only irregularity is a collapsed comment anchor salvages COMPLETE with " +
        "no loss of any kind, and the note comes back counted in comments_orphaned and marked " +
        "(orphaned) in the file",
      verdict: !m.collapsed_anchor_planted ? "UNKNOWN" : collapsedOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_wordlist_recovered",
      value: wordlistOk
        ? `${m.wordlist_recovered} word(s), alphabetically`
        : `planted ${m.wordlist_planted.length}, manifest ${m.wordlist_recovered}, file holds ` +
          `[${m.wordlist_in_file.join(", ")}] against [${wordsSorted.join(", ")}]`,
      threshold:
        "every taught word is counted and listed in wordlist.md, in alphabetical order. THE " +
        "ORDER CLAUSE CANNOT FAIL THROUGH THIS RIG and the count and membership clauses carry " +
        "the whole live claim: `dict_word.word` is UNIQUE, so `SELECT rowid FROM dict_word` is " +
        "answered by a covering scan of that autoindex and the rows reach the writer already " +
        "alphabetical whatever order the file was written in - measured with EXPLAIN QUERY " +
        "PLAN, and no choice of planted words can change it. Deleting the sort from " +
        "write_wordlist leaves this gate GREEN on a live run; the sort is pinned by 049 at that " +
        "function's own boundary, where the input order is chosen",
      verdict: wordlistOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_pictures_recovered",
      value: picturesOk
        ? `${m.pictures_recovered} photograph(s), byte-identical to the original`
        : `planted ${m.pictures_planted}, manifest ${m.pictures_recovered}; bytes match: ` +
          `${m.picture_bytes_match}`,
      threshold:
        "every planted photograph is counted and copied into pictures/ BYTE FOR BYTE (a copy " +
        "that re-encoded would satisfy a count and hand back a different picture)",
      verdict: picturesOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_covers_recovered",
      value: coversOk
        ? `${m.covers_recovered} of 2 covers, both named in covers.md and both on disk`
        : `planted ${m.covers_planted}, manifest ${m.covers_recovered}, ` +
          `${m.cover_files_written} file(s) written`,
      threshold: "both covers are counted, named by side in covers.md, and written into pictures/",
      verdict: coversOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_design_recovered",
      value: designOk
        ? `${Object.keys(m.design_planted).length} of ${Object.keys(m.design_planted).length} ` +
          "design rows, verbatim"
        : `planted ${JSON.stringify(m.design_planted)} against recovered ` +
          JSON.stringify(m.design_recovered),
      threshold:
        "every planted design row is in the manifest's design object with its value VERBATIM " +
        "(compared value by value: five nulls satisfy a count)",
      verdict: designOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_snapshots_recovered",
      value: snapshotsOk
        ? `${m.snapshots_planted} named moment(s), ${m.snapshot_documents_planted} document(s) ` +
          "written, and the past draft is in them"
        : `planted ${m.snapshots_planted}/${m.snapshot_documents_planted}, manifest ` +
          `${m.snapshots_recovered}/${m.versions_recovered}, ${m.snapshot_files_written} file(s); ` +
          `the past draft is present: ${m.snapshot_holds_the_past_draft}`,
      threshold:
        "every named snapshot is counted and indexed, one file per document under " +
        "snapshots/<id>/, and one of them holds the prose of the planted past draft (the last " +
        "clause is the needle: empty files satisfy the counts)",
      verdict: snapshotsOk ? "PASS" : "FAIL",
    },
    {
      // A DROPPED VERSION IS IN NO LOSS LIST. 050: "if it is not on that line it
      // is nowhere", so this figure being right is the whole of what the writer
      // is told about the drafts this command chose not to hand back.
      gate: "salvage_versions_dropped_counted",
      value:
        m.automatic_versions_planted === 0
          ? "NO AUTOMATIC VERSION WAS PLANTED"
          : droppedOk
            ? `${m.versions_dropped} automatic version(s) planted and ${m.versions_dropped} counted as dropped`
            : `${m.automatic_versions_planted} planted, ${m.versions_dropped} reported dropped`,
      threshold:
        "every automatic version in the file is counted in versions_dropped -- a deliberate " +
        "omission is a figure and never a Loss, so an undercount here is silent loss",
      verdict:
        m.automatic_versions_planted === 0 ? "UNKNOWN" : droppedOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_damage_is_reported",
      value: damageOk
        ? `exit 3, complete false, ${m.damaged_loss_kinds.length} kind(s) exactly as scripted, ` +
          `${m.damaged_raw_bodies} body written verbatim`
        : `exit ${m.damaged_exit_code}, complete ${m.damaged_complete}, missing ` +
          `[${missing.join(", ")}], unexpected [${unexpected.join(", ")}], ` +
          `${m.damaged_raw_bodies} raw body(ies)`,
      threshold:
        "the scripted damage produces exit 3, complete: false, EXACTLY the loss kinds the script " +
        "owes and no others, and the body that no longer parses is written verbatim as .raw",
      verdict: damageOk ? "PASS" : "FAIL",
    },
    {
      // Read `cli.rs` before gating on these: a rig that treated a non-zero exit
      // as failure would grade the command backwards. 3 is salvage WORKING on a
      // broken file.
      gate: "salvage_exit_codes",
      value: exitsOk
        ? "0 healthy, 1 occupied destination, 2 unreadable source, 3 answered with losses"
        : `healthy ${m.exit_healthy}, occupied ${m.exit_occupied_destination}, unreadable ` +
          `${m.exit_unreadable_source}, damaged ${m.exit_damaged}`,
      threshold:
        "0 for a complete salvage, 1 for a destination that already exists, 2 for a source that " +
        "cannot be read, 3 for an answer that carries losses",
      verdict: exitsOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_ms",
      value: m.salvage_ms,
      threshold:
        `<= ${SALVAGE_MS} ms for the whole command, sized against the STRESS fixture ` +
        "(20,000 items, 15,200 documents): a tiny run cannot reach this and its PASS is not " +
        "evidence about the stress path",
      verdict: m.salvage_ms <= SALVAGE_MS ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold:
        `<= ${SALVAGE_RSS_MB} MB peak for the salvage PROCESS, sized against the stress fixture ` +
        "and far below the application's own 750: this command holds the walk and one document " +
        "at a time, and a build that started holding every body at once is what this catches",
      verdict: m.peak_rss_mb <= SALVAGE_RSS_MB ? "PASS" : "FAIL",
    },
    {
      // WHAT A RIG CAN HOLD FOREVER, and the reason 054 put it here rather than
      // leaving it to unit tests: `manifest.json` is the plain-text artifact an
      // operator hands to somebody else, and until this slice it opened with
      // the operating-system user's home directory in `source` and `out_dir`
      // and carried a third copy through the `meta` sweep's `recovered_from`.
      // A unit test pins the writer; this pins the FILE, on every manifest
      // every run of this rig produces, including the corpus's.
      gate: "salvage_manifest_names_no_path",
      value: pathsOk
        ? `${m.manifests_read} manifest(s) read, none naming a path`
        : m.named_paths_in_manifests.length === 0
          ? `only ${m.manifests_read} manifest(s) were read`
          : m.named_paths_in_manifests
            .map((p) => `${p.run}: ${p.at} = ${p.value}`)
            .join("; "),
      threshold:
        "no string in any manifest this run wrote is an absolute path or names the directory " +
        "the run happened in - checked over every key of every manifest, the corpus's included, " +
        "and NOT over the terminal report, which belongs to the operator who typed the path. " +
        "At least two manifests must have been read: an empty list over no manifests is the " +
        "same green as a clean one. That floor is not the census - the rig ABORTS when the " +
        "number it collected is not the number its runs wrote, over salvage-read's manifestsOwed",
      verdict: pathsOk ? "PASS" : "FAIL",
    },
    ...salvageCorpusGates(m),
  ];
}

/** A corpus entry recovered LESS than the healthy salvage of the same project.
 *  A refusal (no manifest) is not "less": it is a different answer entirely, and
 *  `salvage_corpus_terminates` grades it by its exit code. */
function lostSomething(r: SalvageCorpusRun, healthyItems: number, healthyDocs: number): boolean {
  if (r.items_recovered === null || r.documents_recovered === null) return false;
  return r.items_recovered < healthyItems || r.documents_recovered < healthyDocs;
}

/** The seven gates over the corpus of genuinely damaged files.
 *
 *  WHAT IS GRADED IS NOT THAT SALVAGE RECOVERS EVERYTHING. It will not, and a
 *  gate that demanded it would be demanding the impossible and would be lowered
 *  the first time it was inconvenient. What is graded is that for every file in
 *  the corpus the command TERMINATES, does not panic, reports what it could not
 *  read, and never claims `complete: true` when it lost something. */
export function salvageCorpusGates(m: SalvageMetrics): GateResult[] {
  const corpus = m.corpus;
  const enough = corpus.length >= SALVAGE_CORPUS_MIN;

  const disallowed = corpus.filter((r) => !r.allowed_exits.includes(r.exit_code));
  const panicked = corpus.filter((r) => r.panicked);
  const terminatesOk = enough && disallowed.length === 0 && panicked.length === 0;

  // A run that says it is complete must have recovered as much as the healthy
  // salvage did, must carry no loss, and must have exited 0. Three readings of
  // one claim, because trusting one field to speak for the other two is how a
  // silent zero ships.
  const claimedComplete = corpus.filter((r) => r.complete === true);
  const dishonest = corpus.filter(
    (r) =>
      r.complete === true &&
      (lostSomething(r, m.corpus_healthy_items, m.corpus_healthy_documents) ||
        r.loss_kinds.length > 0 ||
        r.exit_code !== 0),
  );
  const honestOk = enough && dishonest.length === 0;

  // Every answer that lost something names a loss; every refusal exits 2.
  const silent = corpus.filter(
    (r) =>
      r.complete !== null &&
      lostSomething(r, m.corpus_healthy_items, m.corpus_healthy_documents) &&
      r.loss_kinds.length === 0,
  );
  const wrongRefusal = corpus.filter((r) => r.complete === null && r.exit_code !== 2);
  const reportsOk = enough && silent.length === 0 && wrongRefusal.length === 0;

  const unstable = corpus.filter((r) => r.digest !== r.digest_again);
  const distinct = new Set(corpus.map((r) => r.digest)).size === corpus.length;
  const deterministicOk = enough && unstable.length === 0 && distinct;

  const torn = corpus.find((r) => r.name === "torn_page_zeroed");
  const enumerationOk = torn !== undefined && torn.loss_kinds.includes("enumeration_stopped");

  const tails = corpus.filter((r) => r.name.startsWith("tail_lost_"));
  const tailsRecovered = tails.filter((r) => (r.items_recovered ?? 0) > 0);
  const truncationOk = tails.length >= 2 && tailsRecovered.length === tails.length;

  const worstMs = corpus.reduce((a, r) => Math.max(a, r.wall_ms), 0);

  return [
    {
      gate: "salvage_corpus_terminates",
      value: terminatesOk
        ? `${corpus.length} damaged file(s), every one answered inside its allowed exits`
        : `${corpus.length} entry(ies); disallowed exits [${disallowed
            .map((r) => `${r.name}=${r.exit_code}`)
            .join(", ")}]; panicked [${panicked.map((r) => r.name).join(", ")}]`,
      threshold:
        `at least ${SALVAGE_CORPUS_MIN} damaged files, every one of which terminates with an ` +
        "exit code its corpus entry allows and without a panic. A HANG IS GRADED HERE AND NOT " +
        "BY THE CLOCK: the rig kills a run that passes its timeout, and a killed process exits " +
        "on a signal, which is never an allowed exit",
      verdict: terminatesOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_corpus_completeness_is_honest",
      value: honestOk
        ? `${claimedComplete.length} of ${corpus.length} damaged file(s) called themselves ` +
          `complete and every one of them was (healthy: ${m.corpus_healthy_items} item(s), ` +
          `${m.corpus_healthy_documents} document(s))`
        : `claimed complete while short: [${dishonest.map((r) => r.name).join(", ")}]`,
      threshold:
        "NO file in the corpus reports complete: true while having recovered fewer items or " +
        "fewer documents than the healthy salvage of the same project, while carrying any loss, " +
        "or while exiting anything but 0. Three readings of one claim: a build that set the " +
        "flag from the loss list alone would satisfy one of them. THE VALUE LINE STATES HOW " +
        "MANY FILES CLAIMED COMPLETENESS AT ALL, because a build that never said complete would " +
        "satisfy this gate over an empty set - what refuses that build is salvage_exit_codes' " +
        "own healthy run and salvage_collapsed_anchor_is_not_a_loss, not this gate",
      verdict: honestOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_corpus_reports_what_it_lost",
      value: reportsOk
        ? "every answer that came back short named a loss, and every refusal exited 2"
        : `silent [${silent.map((r) => r.name).join(", ")}]; refused with the wrong code ` +
          `[${wrongRefusal.map((r) => `${r.name}=${r.exit_code}`).join(", ")}]`,
      threshold:
        "every corpus file that ANSWERED with fewer items or documents than the healthy salvage " +
        "names at least one loss kind, and every file salvage refused to answer for exited 2 " +
        "(the refusal path: a refusal that exited 0 or 3 would be a recovery nobody wrote)",
      verdict: reportsOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_corpus_is_byte_exact",
      value: deterministicOk
        ? `${corpus.length} file(s), each identical across two independent generations`
        : `unstable [${unstable.map((r) => r.name).join(", ")}]; ` +
          `${new Set(corpus.map((r) => r.digest)).size} distinct digest(s) of ${corpus.length}`,
      threshold:
        "every corpus file is byte-identical to the one a SECOND generation produced from a " +
        "separately seeded base, and no two entries are the same bytes. A corpus generated by a " +
        "seeded byte-exact procedure is evidence; one that mutates a file at random is an " +
        "anecdote, and two entries that collide are one entry grading twice",
      verdict: deterministicOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_corpus_enumeration_stopped_is_reached",
      value:
        torn === undefined
          ? "NO TORN-PAGE ENTRY WAS GENERATED"
          : enumerationOk
            ? `the torn index page stops an enumeration and salvage says so; ` +
              `${torn.items_recovered ?? 0} item(s) came back from it against ` +
              `${m.corpus_healthy_items} healthy`
            : `torn_page_zeroed reported [${torn.loss_kinds.join(", ")}]`,
      threshold:
        "the file whose torn page is a page of the b-tree a rowid enumeration scans produces an " +
        "`enumeration_stopped` loss. 046 recorded that kind as its one live mutation survivor " +
        "and five slices inherited the hole, because page-level corruption is the only thing " +
        "that reaches it and nothing in this repo constructed one. HOW MUCH CAME BACK BEFORE " +
        "THE CURSOR DIED IS ON THE VALUE LINE AND IS NOT GRADED: at `tiny` the tree is a single " +
        "page, so the enumeration dies having read nothing, and only at `stress` - where it is " +
        "96 pages and the torn one is in the middle - is the partial read the branch's comment " +
        "promises actually observed",
      verdict: torn === undefined ? "UNKNOWN" : enumerationOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_corpus_truncation_is_recovered",
      value: truncationOk
        ? tails.map((r) => `${r.name}: ${r.items_recovered} item(s)`).join(", ")
        : `${tails.length} tail-loss entry(ies), ` +
          tails.map((r) => `${r.name}: ${r.items_recovered ?? "refused"}`).join(", "),
      threshold:
        "both tail-loss files come back with MORE THAN NOTHING. Before 052 a project whose end " +
        "was cut off salvaged as 'this file does not hold a project this build can salvage' " +
        "while every byte of the surviving manuscript was still in it: SQLite refuses to read a " +
        "row out of a file whose header claims more pages than the file holds, and salvage now " +
        "distrusts that number on its own working copy",
      verdict: truncationOk ? "PASS" : "FAIL",
    },
    {
      gate: "salvage_corpus_ms",
      value: worstMs,
      threshold:
        `<= ${SALVAGE_CORPUS_MS} ms for the SLOWEST single file in the corpus, sized against ` +
        "the stress fixture where the slowest entry is the one that recovers the most. A " +
        "liveness bound and not a budget: it separates slow from never, and a true hang is " +
        "killed by the rig and graded by salvage_corpus_terminates",
      verdict: worstMs <= SALVAGE_CORPUS_MS ? "PASS" : "FAIL",
    },
  ];
}

// -------------------------------------------------------------- preflight-cli

/** How long ONE `preflight --json` run over the STRESS fixture, walking every
 *  body in the manuscript for a cross-identity match, may take.
 *
 *  MEASURED FIRST, THEN SET, `SALVAGE_MS`'s own rule. Five runs against the
 *  20,000-item, 15,200-document fixture on the measurement machine, with a one-minute
 *  load of 14 from unrelated processes: 401, 392, 397, 476, 389 ms, median
 *  397. The number is ~5x that median, headroom for a colder page cache and
 *  a slower disk, and still far under anything a person would call a hang.
 *  `tiny` (47 ms) is graded against the same number and cannot reach it: the
 *  threshold string says so. Zero is read by `evaluatePreflightGates` as an
 *  unfilled threshold and FAILS the gate, so a placeholder can never pass. */
const PREFLIGHT_MS = 2000;

/** Peak resident memory of the `preflight` process over the STRESS fixture, in
 *  MB.
 *
 *  Measured 81-83 MB (`VmHWM`) at `stress` on the same five runs, 25-38 at
 *  `tiny`. The gate is ~3x that, `SALVAGE_RSS_MB`'s own rule, and far below
 *  the application's 750: the command holds the walk and one projected body
 *  at a time, and a build that started holding every body at once is what
 *  this figure exists to catch. Zero FAILS the gate, as for `PREFLIGHT_MS`. */
const PREFLIGHT_RSS_MB = 250;

/** The host's own check name, restated rather than imported (`identity.rs`'s
 *  `CHECK_CROSS_IDENTITY`): this rig and the host are two programs, and a rig
 *  that read the host's own spelling of a name could not tell a build that
 *  had changed it from one that had not. */
export const CHECK_CROSS_IDENTITY = "cross_identity";
export const STATE_NOT_APPLICABLE = "not_applicable";
export const STATE_RAN = "ran";
export const STATE_VACUOUS = "vacuous";
export const FINDING_CROSS_IDENTITY = "cross_identity";
/** The host's own severity and surface spellings (`identity.rs`), restated
 *  for the same reason `CHECK_CROSS_IDENTITY` is: a rig reading the host's
 *  own literal could not tell a build that had changed it from one that had
 *  not. */
export const SEVERITY_BLOCKER = "blocker";
export const SURFACE_DOCUMENT_BODY = "document_body";

export interface PreflightMetrics {
  fixture: string;

  /** Step (b): `preflight --json` with no vault at all. */
  vault_absent_exit: number;
  vault_absent_ok: boolean;
  vault_absent_check_state: string;

  /** Step (c): five runs of `preflight --json` against a project whose LAST
   *  scene with a body has had its first text node rewritten to name the
   *  second identity. One exit code, one blocker count and one finding
   *  (item id, matched spelling, severity, surface) per run -- five of each,
   *  so a gate that passed on the first run and dropped on the fifth is still
   *  visible. */
  planted_exit_codes: number[];
  planted_blocker_counts: number[];
  planted_item_id: string;
  planted_finding_item_ids: (string | null)[];
  planted_name: string;
  planted_finding_matches: string[];
  planted_finding_severities: string[];
  planted_finding_surfaces: string[];

  /** The median wall clock of the five runs in (c), and the peak `VmHWM` over
   *  the same five. */
  preflight_ms: number;
  preflight_rss_mb: number;

  /** Step (d): the planted body restored, one more run. */
  clean_exit: number;
  clean_check_state: string;
  clean_finding_count: number;
}

/** The five preflight gates (107). `msLimit` and `rssMb` default to the
 *  module's own placeholder constants and exist as parameters so a boundary
 *  test can exercise the comparison at a real number without waiting for the
 *  stress measurement that sets them. */
export function evaluatePreflightGates(
  m: PreflightMetrics,
  msLimit: number = PREFLIGHT_MS,
  rssLimit: number = PREFLIGHT_RSS_MB,
): GateResult[] {
  const notApplicableOk =
    m.vault_absent_exit === 0 &&
    m.vault_absent_ok &&
    m.vault_absent_check_state === STATE_NOT_APPLICABLE;

  const exitsAllThree = m.planted_exit_codes.every((c) => c === 3);
  const oneBlockerEach = m.planted_blocker_counts.every((n) => n === 1);
  const rightItemEach = m.planted_finding_item_ids.every((id) => id === m.planted_item_id);
  const rightNameEach = m.planted_finding_matches.every((s) => s === m.planted_name);
  const rightSeverityEach = m.planted_finding_severities.every((s) => s === SEVERITY_BLOCKER);
  const rightSurfaceEach = m.planted_finding_surfaces.every((s) => s === SURFACE_DOCUMENT_BODY);
  const findsOk =
    exitsAllThree && oneBlockerEach && rightItemEach && rightNameEach && rightSeverityEach && rightSurfaceEach;

  const msOk = msLimit > 0 && m.preflight_ms <= msLimit;
  const rssOk = rssLimit > 0 && m.preflight_rss_mb > 0 && m.preflight_rss_mb <= rssLimit;

  const cleanOk =
    m.clean_exit === 0 && m.clean_check_state === STATE_RAN && m.clean_finding_count === 0;

  return [
    {
      gate: "preflight_not_applicable_without_vault",
      value: `exit ${m.vault_absent_exit}, ok ${m.vault_absent_ok}, ${CHECK_CROSS_IDENTITY} ${m.vault_absent_check_state}`,
      threshold: `exit 0, ok true, ${CHECK_CROSS_IDENTITY} ${STATE_NOT_APPLICABLE} (no vault at all)`,
      verdict: notApplicableOk ? "PASS" : "FAIL",
    },
    {
      gate: "preflight_finds_the_planted_name",
      value: findsOk
        ? `${m.planted_exit_codes.length} run(s), each exit 3 with one ${SEVERITY_BLOCKER} at ` +
          `${m.planted_item_id} on surface ${SURFACE_DOCUMENT_BODY}`
        : `exits ${JSON.stringify(m.planted_exit_codes)}, blockers ${JSON.stringify(m.planted_blocker_counts)}, ` +
          `item ids ${JSON.stringify(m.planted_finding_item_ids)}, matches ${JSON.stringify(m.planted_finding_matches)}, ` +
          `severities ${JSON.stringify(m.planted_finding_severities)}, surfaces ${JSON.stringify(m.planted_finding_surfaces)}`,
      threshold:
        `every run of five exits 3 with EXACTLY ONE ${CHECK_CROSS_IDENTITY} finding, at the planted ` +
        `item id, matching the planted spelling verbatim, severity ${SEVERITY_BLOCKER} and surface ` +
        SURFACE_DOCUMENT_BODY,
      verdict: findsOk ? "PASS" : "FAIL",
    },
    {
      gate: "preflight_ms",
      value: `${m.preflight_ms} ms`,
      threshold:
        msLimit > 0
          ? `<= ${msLimit} ms, median of five runs at stress; a tiny run cannot reach this line; ` +
            "the number is evidence at stress only"
          : "UNFILLED (0): the operator has not yet set this from a stress run",
      verdict: msOk ? "PASS" : "FAIL",
    },
    {
      gate: "preflight_rss_mb",
      value: `${m.preflight_rss_mb} MB`,
      threshold:
        rssLimit > 0
          ? `<= ${rssLimit} MB, VmHWM peak over five runs at stress (0 MB is no sample taken, not a ` +
            "real reading, and FAILS); a tiny run cannot reach this line; the number is evidence at " +
            "stress only"
          : "UNFILLED (0): the operator has not yet set this from a stress run",
      verdict: rssOk ? "PASS" : "FAIL",
    },
    {
      gate: "preflight_clean_when_the_name_is_gone",
      value: `exit ${m.clean_exit}, ${CHECK_CROSS_IDENTITY} ${m.clean_check_state}, ` +
        `${m.clean_finding_count} finding(s)`,
      threshold: `exit 0, ${CHECK_CROSS_IDENTITY} ${STATE_RAN} (not ${STATE_VACUOUS}), zero findings`,
      verdict: cleanOk ? "PASS" : "FAIL",
    },
  ];
}

// -------------------------------------------------------------- pictures-cli

/** Peak resident memory (`VmHWM`) of the HOST MAIN process across a boot that
 *  decodes and attaches the 49-megapixel photograph, in MB.
 *
 *  MEASURED FIRST, THEN SET, `PREFLIGHT_RSS_MB`'s own rule: 505-510 MB across
 *  five green runs. A SECOND full-resolution RGBA copy of the 7000x7000
 *  decode is ~196 MB and would land the peak near 700 -- the one regression
 *  this figure exists to catch. 650 is the line that catches it while
 *  leaving ~140 MB of headroom over the measured peak; zero of the five runs
 *  failed at this line. Zero is read as an unfilled threshold and FAILS the
 *  gate. */
const PICTURES_HOST_RSS_MB = 650;

/** Both sides of the cached thumbnail, restated from `pictures.rs`'s own
 *  bound. A parameter on the gate (default this constant) so a boundary
 *  test can exercise 256 and 257 without importing the host's number. */
export const PICTURES_THUMB_MAX = 256;

export interface PicturesMetrics {
  /** Act (a): the stored original's bytes are identical (sha256) to the
   *  source file, and its cached thumbnail's both sides are within bound. */
  attach_sha_matches: boolean;
  attach_thumb_width: number;
  attach_thumb_height: number;
  attach_stored_name: string;

  /** The picture panel's image node accessible name, read through AT-SPI
   *  (see pictures-cli.ts's header for why this is the image node's own
   *  name and not `#cast-picture-state`'s text), and the sentence it is
   *  expected to equal -- `"Picture of {name}"`, `castPictureAlt` restated by
   *  the rig against the member it actually created. An empty or wrong name
   *  both read as the same failure: the panel did not say who this picture
   *  is of. */
  attach_state_name: string;
  attach_state_expected_name: string;

  /** Act (b): the oversize photograph must change nothing on the store or the
   *  filesystem, and the banner must carry the refusal sentence. */
  oversize_picture_path_before: string;
  oversize_picture_path_after: string;
  oversize_files_before: number;
  oversize_files_after: number;
  oversize_notice_text: string;
  oversize_expected_notice: string;

  /** Act (c): the host main process's `VmHWM` peak across the whole boot
   *  (VmHWM is monotone, so the peak is not attributable to any one act),
   *  and the polled series behind it -- bounded to the samples where the
   *  value changed, plus the first and last. */
  attach_host_rss_mb: number;
  attach_rss_steps_mb: number[];

  /** Act (d): the front cover's stored file, and the resolution-finding
   *  sentence the panel says about it. */
  cover_meta_value: string | null;
  cover_file_matches: boolean;
  cover_sides_text: string;
  cover_expected_sentence: string;
}

/** The five pictures gates (108). `rssLimit` and `thumbMax` default to the
 *  module's own constants and exist as parameters so a boundary test can
 *  exercise each comparison at a real number without importing the host's. */
export function evaluatePicturesGates(
  m: PicturesMetrics,
  rssLimit: number = PICTURES_HOST_RSS_MB,
  thumbMax: number = PICTURES_THUMB_MAX,
): GateResult[] {
  const attachedOk =
    m.attach_sha_matches &&
    m.attach_thumb_width > 0 &&
    m.attach_thumb_height > 0 &&
    m.attach_thumb_width <= thumbMax &&
    m.attach_thumb_height <= thumbMax &&
    m.attach_stored_name.length > 0;

  const statePresentOk = m.attach_state_name === m.attach_state_expected_name;

  const oversizeOk =
    m.oversize_picture_path_before === m.oversize_picture_path_after &&
    m.oversize_files_before === m.oversize_files_after &&
    m.oversize_notice_text === m.oversize_expected_notice;

  const rssOk = rssLimit > 0 && m.attach_host_rss_mb > 0 && m.attach_host_rss_mb <= rssLimit;

  const coverOk =
    m.cover_meta_value !== null &&
    m.cover_file_matches &&
    m.cover_sides_text.includes(m.cover_expected_sentence);

  return [
    {
      gate: "picture_attached",
      value:
        `sha ${m.attach_sha_matches ? "matches" : "MISMATCH"}, thumbnail ` +
        `${m.attach_thumb_width}x${m.attach_thumb_height}, stored as "${m.attach_stored_name}"`,
      threshold: `sha256 identical to the source, thumbnail both sides <= ${thumbMax}px and > 0`,
      verdict: attachedOk ? "PASS" : "FAIL",
    },
    {
      gate: "picture_state_present",
      value: `accessible name "${m.attach_state_name}" (expected "${m.attach_state_expected_name}")`,
      threshold: `the picture panel's image node accessible name equals "${m.attach_state_expected_name}"`,
      verdict: statePresentOk ? "PASS" : "FAIL",
    },
    {
      gate: "oversize_refused",
      value:
        `picture_path ${m.oversize_picture_path_before === m.oversize_picture_path_after ? "unchanged" : "CHANGED"}, ` +
        `files ${m.oversize_files_before} -> ${m.oversize_files_after}, notice "${m.oversize_notice_text}"`,
      threshold:
        "picture_path unchanged, no new file in the pictures directory, and the banner carries " +
        `the refusal sentence: "${m.oversize_expected_notice}"`,
      verdict: oversizeOk ? "PASS" : "FAIL",
    },
    {
      gate: "attach_host_rss_mb",
      value: `${m.attach_host_rss_mb} MB (${m.attach_rss_steps_mb.length} step(s))`,
      threshold:
        rssLimit > 0
          ? `<= ${rssLimit} MB, VmHWM peak of the host main process across the whole boot ` +
            "(0 MB is no sample taken, not a real reading, and FAILS)"
          : "UNFILLED (0): the operator has not yet set this from a real run",
      verdict: rssOk ? "PASS" : "FAIL",
    },
    {
      gate: "cover_set",
      value: `meta ${JSON.stringify(m.cover_meta_value)}, file matches ${m.cover_file_matches}, panel says "${m.cover_sides_text}"`,
      threshold: `a stored file named in meta, bytes equal to the source, and the panel's text contains "${m.cover_expected_sentence}"`,
      verdict: coverOk ? "PASS" : "FAIL",
    },
  ];
}

/** The three measured lines, per fixture.
 *
 *  MEASURED FIRST, THEN SET, `PREFLIGHT_RSS_MB`'s rule. A line of 0 is read as
 *  UNFILLED and FAILS the gate: a gate that passed an unfilled line would
 *  report a bound nobody chose.
 *
 *  `proof_save_ms` HAS NO `stress` LINE, AND THAT ABSENCE IS THE STATEMENT.
 *  A proof of the `stress` book does not exist to be timed: the host abandons
 *  that render at its own 180-second bound and says so (109 measured it --
 *  "the proof did not finish within 180 seconds", through the CLI, which
 *  paginates through the same printer the rail does). A number here would be a
 *  bound on something no writer can obtain, so the gate reports UNKNOWN and the
 *  record says why. */
export const PREVIEW_THRESHOLDS = {
  /** From the rail's Save as to a complete archive on disk: a whole render and
   *  the container write, polled at 100 ms. Measured 617-621 ms at `tiny` and
   *  1024-1028 at `stress` across seven runs on a machine at load 4-8. The
   *  stress book is 13.9 MB of EPUB and barely slower than the tiny one,
   *  because both are dominated by fixed cost. */
  epub_save_ms: { tiny: 3000, stress: 4000 } as Record<string, number>,
  /** From the rail's Save as to a complete proof. Measured 918-1121 ms at
   *  `tiny` over five runs. No `stress` line: see above. */
  proof_save_ms: { tiny: 4000 } as Record<string, number>,
  /** THE SPEC'S OWN `peak_rss_mb`, 750, AND NOT A FRESH LINE FOR THIS RIG.
   *  Measured 613-619 MB at `tiny` and 640-670 at `stress`, which is 89% of the
   *  line and the tightest margin any workload here has recorded (the 5-minute
   *  persistence soak is 706, the manuscript export 609). The pictures rig set
   *  its own line at 1.3x its measurement, and the same arithmetic here would
   *  be 871 -- this instrument granting the preview rail more memory than the
   *  product promises, which is not a harness's call to make. If this gate goes
   *  red, the rail's memory is the finding and not the threshold. */
  rss_mb: { tiny: 750, stress: 750 } as Record<string, number>,
};

export interface PreviewMetrics {
  fixture: string;

  /** Act (a): the EPUB rail opened and its own summary line agrees with what
   *  the store itself counts. `epub_rail_name` is `#preview-rail`'s
   *  accessible name as AT-SPI carried it; `epub_rail_expected_name` is what
   *  the page's catalog says it must be, restated by the rig. The summary
   *  line's items/words are parsed out of `epub_summary_text` (-1 when the
   *  line did not parse) and checked against the rig's own count, read from
   *  the store with bun:sqlite. */
  epub_rail_name: string;
  epub_rail_expected_name: string;
  epub_summary_text: string;
  epub_summary_items: number;
  epub_summary_words: number;
  store_items: number;
  store_words: number;

  /** Act (b): clicking the option toggle. `toggle_pressed` is the AT-SPI
   *  pressed state of `#preview-flag-caps_title` after the click;
   *  `toggle_meta_tokens` are the tokens of the store's `design.chapter`
   *  meta row after the click; `toggle_expected_token` is `"caps-title"`,
   *  restated by the rig from `design::CAPS_TITLE`. THE HYPHEN IS THE POINT:
   *  the page spells this option `caps_title` in its DOM id and the host
   *  stores it hyphenated, so a rig that restated one for the other would
   *  report a correct application as broken. */
  toggle_pressed: boolean;
  toggle_meta_tokens: string[];
  toggle_expected_token: string;

  /** Act (c): the saved EPUB, read back by an outside tool (`epubcheck`)
   *  rather than trusting the exporter to grade itself. Warnings are
   *  recorded but never gated -- an EPUB with warnings and no errors is a
   *  valid book. */
  epub_save_ms: number;
  epub_bytes: number;
  epubcheck_exit: number;
  epubcheck_fatals: number;
  epubcheck_errors: number;
  epubcheck_warnings: number;

  /** Act (d): the saved proof, read back by another outside tool
   *  (`pdfinfo`). `proof_leaves` is what the rail said the whole book is;
   *  `pdfinfo_pages` is what an outside reader counts in the file the rail
   *  produced. `proof_rail_walks` and `proof_rail_wall_ms` are DIAGNOSTIC
   *  ONLY, never gated: they are AT-SPI polling at a safe interval, which
   *  cannot time a render, and this harness has a recorded rule against
   *  gating a figure that is really the rig's own sleep.
   *
   *  `proof_attempted` IS FALSE ONLY WHERE A PROOF CANNOT BE OBTAINED AT ALL,
   *  and where it is false the refusal ITSELF is graded rather than waived.
   *
   *  The `stress` book does not paginate inside `printer.rs`'s 180-second
   *  render bound, and a boot outlives the page's ready-sink by only 120
   *  seconds, so the rail's own error state at that size cannot be reached
   *  inside one boot at all. What the rig does there instead is run the CLI's
   *  proof export -- the same paginator, without a window -- and record what
   *  came back: `proof_refusal_exit`, `proof_refusal_message` and
   *  `proof_refusal_ms`. `proof_refused_at_the_render_bound` grades that: a
   *  proof that unexpectedly SUCCEEDS at this size, fails for some other
   *  reason, or does not leave the CLI cleanly turns it red. There is no
   *  UNKNOWN and no waived gate.
   *
   *  A proof that was ATTEMPTED and failed is a FAIL, never this: the rig
   *  records zeroes and writes its result rather than aborting, so the red
   *  gate reaches the evidence. */
  proof_attempted: boolean;
  /** The proof rail's own accessible name, and what the catalog says it must
   *  be. The rail rewrites its label on every open, and a rail still reading
   *  "EPUB preview" over a proof is a defect no other reading here catches. */
  proof_rail_name: string;
  proof_rail_expected_name: string;
  /** The proof summary's OWN items and words, beside its leaf count: the same
   *  cross-check act (a) makes for the archive, taken from the sentence the
   *  proof rail states. -1 when the line did not parse. */
  proof_summary_items: number;
  proof_summary_words: number;
  proof_leaves: number;
  pdfinfo_pages: number;
  proof_save_ms: number;
  proof_bytes: number;
  proof_rail_walks: number;
  proof_rail_wall_ms: number;

  /** What the CLI's proof export answered at a fixture whose book cannot be
   *  proofed: the process's own exit status, the sentence it printed, how long
   *  it ran, whether the RIG had to kill it, and whether it left a file behind.
   *  The expected CLI refusal exits 2, prints the host's exact 180-second
   *  timeout text, exits before the rig's 300-second safety net, and leaves no
   *  output file. The gate permits 30 seconds after the render bound for setup
   *  and bounded cleanup; a timed-out process is a FAIL. */
  proof_refusal_exit: number;
  proof_refusal_message: string;
  proof_refusal_ms: number;
  proof_refusal_timed_out: boolean;
  proof_refusal_left_a_file: boolean;

  /** The boot: the summed process-tree peak the boot sampled. */
  preview_rss_mb: number;
}

/** Gates 5-7 share this shape: a latency or memory figure bounded by a
 *  per-fixture threshold. Zero on the threshold side is read as an unfilled
 *  threshold (no operator has set it from a real run) and FAILS; zero on
 *  the value side is read as no measurement taken, not a real reading, and
 *  FAILS the same way. A fixture with no line in the threshold table
 *  reports UNKNOWN rather than borrowing a bound nobody set for it. */
function boundedPreviewGate(
  gate: string,
  value: number,
  limit: number | undefined,
  unit: string,
  fixture: string,
): GateResult {
  if (limit === undefined) {
    return {
      gate,
      value,
      threshold:
        `no threshold is stated for the "${fixture}" fixture, and borrowing another ` +
        "fixture's bound would report a number as passing something nobody set for it",
      verdict: "UNKNOWN",
    };
  }
  if (limit === 0) {
    return {
      gate,
      value,
      threshold: `UNFILLED (0) at the "${fixture}" fixture: the operator has not yet set this from a real run`,
      verdict: "FAIL",
    };
  }
  return {
    gate,
    value,
    threshold: `<= ${limit}${unit} at the "${fixture}" fixture (0 is no measurement taken, not a real reading, and FAILS)`,
    verdict: value > 0 && value <= limit ? "PASS" : "FAIL",
  };
}

/** The preview gates (109): seven where the book can be proofed, six where it
 *  cannot -- there `proof_save_ms` has nothing to time and
 *  `proof_refused_at_the_render_bound` takes the leaves gate's place. Every
 *  row is PASS or FAIL; this rig emits no UNKNOWN of its own. */
export function evaluatePreviewGates(
  m: PreviewMetrics,
  thresholds: typeof PREVIEW_THRESHOLDS = PREVIEW_THRESHOLDS,
): GateResult[] {
  const summaryOk =
    m.epub_rail_name === m.epub_rail_expected_name &&
    m.store_items > 0 &&
    m.store_words > 0 &&
    m.epub_summary_items === m.store_items &&
    m.epub_summary_words === m.store_words;

  const toggleOk =
    m.toggle_pressed &&
    m.toggle_expected_token.length > 0 &&
    m.toggle_meta_tokens.includes(m.toggle_expected_token);

  const epubValidOk = m.epub_bytes > 0 && m.epubcheck_exit === 0 && m.epubcheck_fatals === 0 && m.epubcheck_errors === 0;

  // THE RAIL AND THE FILE IT PRODUCED, one subject: the proof rail says this
  // book is N leaves of M sections and K words, and the file an outside reader
  // opened has N pages. The store's own figures are act (a)'s oracle and are
  // reused here, because it is the same book.
  const leavesOk =
    m.proof_rail_name === m.proof_rail_expected_name &&
    m.store_items > 0 &&
    m.store_words > 0 &&
    m.proof_summary_items === m.store_items &&
    m.proof_summary_words === m.store_words &&
    m.proof_leaves > 0 &&
    m.pdfinfo_pages > 0 &&
    m.proof_leaves === m.pdfinfo_pages;

  // The host's exact refusal when a proof outruns its render bound, both
  // restated from `printer.rs` (`RENDER_TIMEOUT_SECONDS = 180`).
  // A refusal for any OTHER reason is not this refusal.
  const BOUND_SENTENCE = "the proof did not finish within 180 seconds";
  const PROOF_BOUND_MS = 180_000;
  const PROOF_REFUSAL_CEILING_MS = 210_000;
  const refusedOk =
    m.proof_refusal_exit === 2 &&
    m.proof_refusal_ms >= PROOF_BOUND_MS &&
    m.proof_refusal_ms <= PROOF_REFUSAL_CEILING_MS &&
    m.proof_refusal_message === BOUND_SENTENCE &&
    !m.proof_refusal_timed_out &&
    // A proof it could not finish must not have left one behind.
    !m.proof_refusal_left_a_file;

  return [
    {
      gate: "epub_summary_agrees_with_store",
      value:
        `rail "${m.epub_rail_name}" (expected "${m.epub_rail_expected_name}"), summary ` +
        `"${m.epub_summary_text}" parsed as ${m.epub_summary_items} item(s)/${m.epub_summary_words} word(s), ` +
        `store says ${m.store_items} item(s)/${m.store_words} word(s)`,
      threshold:
        "the rail's accessible name equals the expected name, the store's own item and word " +
        "counts are both > 0 (the vacuity guard: zero equalling zero would pass while proving " +
        "nothing), and the summary line's parsed items and words equal the store's",
      verdict: summaryOk ? "PASS" : "FAIL",
    },
    {
      gate: "option_toggle_lands",
      value:
        `pressed ${m.toggle_pressed}, meta tokens [${m.toggle_meta_tokens.join(", ")}] ` +
        `(expected "${m.toggle_expected_token}")`,
      threshold:
        `the toggle's AT-SPI pressed state is true, and the store's design.chapter meta row's ` +
        `tokens include "${m.toggle_expected_token}"`,
      verdict: toggleOk ? "PASS" : "FAIL",
    },
    {
      gate: "epub_file_valid",
      value:
        `${m.epub_bytes} byte(s), epubcheck exit ${m.epubcheck_exit}, ` +
        `${m.epubcheck_fatals} fatal(s), ${m.epubcheck_errors} error(s), ${m.epubcheck_warnings} warning(s)`,
      threshold:
        "epub_bytes > 0, epubcheck's own exit code is 0, and epubcheck reports zero fatals and " +
        "zero errors. Warnings are RECORDED in the value above and NOT gated: a book with " +
        "warnings and no errors is a valid EPUB",
      verdict: epubValidOk ? "PASS" : "FAIL",
    },
    m.proof_attempted
      ? {
          gate: "proof_rail_agrees_with_the_file_it_saved",
          value:
            `rail "${m.proof_rail_name}" (expected "${m.proof_rail_expected_name}") says ` +
            `${m.proof_leaves} leaf(leaves), ${m.proof_summary_items} item(s), ` +
            `${m.proof_summary_words} word(s); pdfinfo counts ${m.pdfinfo_pages} page(s) and the ` +
            `store says ${m.store_items} item(s)/${m.store_words} word(s)`,
          threshold:
            "the proof rail is labelled a proof, its sentence's items and words equal the " +
            "store's own counts, and its leaf count for the whole book equals an outside " +
            "reader's (pdfinfo) count of the file it saved, all of them > 0",
          verdict: leavesOk ? "PASS" : "FAIL",
        }
      : {
          gate: "proof_refused_at_the_render_bound",
          value:
            `the CLI's proof export exited ${m.proof_refusal_exit} after ${m.proof_refusal_ms} ms ` +
            `saying ${JSON.stringify(m.proof_refusal_message)}` +
            `${m.proof_refusal_timed_out ? " (TIMED OUT: the rig had to kill it)" : ""}` +
            `${m.proof_refusal_left_a_file ? ", LEAVING A FILE" : ", leaving no file"}`,
          threshold:
            "a book this size cannot be proofed, and the application must SAY so rather than " +
            "quietly succeed: exit 2, elapsed from the host's own " +
            `${PROOF_BOUND_MS} ms bound through ${PROOF_REFUSAL_CEILING_MS} ms, its exact ` +
            `${JSON.stringify(BOUND_SENTENCE)} sentence, no rig timeout, and no file left behind. ` +
            "A proof that succeeds here turns this red, which is the tripwire for the day the " +
            "bound stops binding.",
          verdict: refusedOk ? "PASS" : "FAIL",
        },
    boundedPreviewGate("epub_save_ms", m.epub_save_ms, thresholds.epub_save_ms[m.fixture], " ms", m.fixture),
    // NOT EMITTED WHERE THERE IS NO PROOF TO TIME. A gate list is what was
    // graded, and an UNKNOWN row about a file that cannot exist would be a
    // verdict carrying no information -- and UNKNOWN does not colour a run.
    ...(m.proof_attempted
      ? [
          boundedPreviewGate(
            "proof_save_ms",
            m.proof_save_ms,
            thresholds.proof_save_ms[m.fixture],
            " ms",
            m.fixture,
          ),
        ]
      : []),
    boundedPreviewGate("preview_rss_mb", m.preview_rss_mb, thresholds.rss_mb[m.fixture], " MB", m.fixture),
  ];
}

/** The mirror's three acts, in one boot (110): (a) turning the mirror on
 *  through the project panel writes the folder and says so; (b) an outside
 *  rewrite of one file reaches the change set WITHOUT a restart, because the
 *  in-process folder watcher is the thing being proved and a reopen would
 *  prove the scan at open instead; (c) both sides changing the same document
 *  becomes a CONFLICT, and the book's own words must survive it in a sidecar
 *  rather than being silently taken by either side. */
export interface MirrorActsMetrics {
  /** Act (a). The mirror directory's own file count read before the enable
   *  press -- the VACUITY GUARD: a directory that already held files would
   *  let `files_in_folder_after` look like the press wrote them when it
   *  wrote nothing, so this must be 0 or the act proves nothing. */
  files_in_folder_before: number;
  /** The same count, read after the press. */
  files_in_folder_after: number;
  /** The store's own document count at the moment of the press, the same
   *  floor the older mirror rig's `mirror_writes_the_folder` uses. */
  store_documents: number;
  /** `#project-mirror-state`'s accessible name, read through AT-SPI right
   *  after the press. */
  state_sentence: string;
  /** The count the rig itself counted on disk, and expects to find named in
   *  `state_sentence` -- never a count restated by the page. */
  state_sentence_expected_count: number;
  /** Whether `#project-mirror-where`'s sentence named the EXACT directory the
   *  rig handed the host, computed by the rig against the path it owns.
   *
   *  A BOOLEAN AND NOT A CONTAINMENT DONE HERE, for two reasons that point the
   *  same way. The sentence is "The mirror is written to {dir}", so a check
   *  against the directory's BASENAME passed on the word "mirror" appearing in
   *  its own sentence -- a fixture that was a fact about itself, caught on this
   *  rig's first green run. And the real directory is a scratch path, which a
   *  committed result may not carry. The rig compares the whole path and
   *  records only the answer and a redacted sentence. */
  where_names_the_directory: boolean;
  /** `#project-mirror-where`'s sentence with the scratch path replaced, so the
   *  result says what the writer was shown without saying where this ran. */
  where_sentence_redacted: string;
  /** The `mirrored_book_ids` list read out of `settings.json` after the press. */
  settings_mirrored_book_ids: string[];
  /** The book identity the rig expects to find in that list. */
  book_id: string;

  /** Act (b). Change-set rows the panel offered while the SAME process that
   *  wrote the outside edit was still running -- never after a reopen. */
  rows_before_any_reopen: number;
  /** Whether the file the writer edited from outside STILL holds their words
   *  after a pass window has gone by, read from disk in the same boot.
   *
   *  THIS IS WHAT THE WATCHER ACTUALLY BUYS, and the gate that reads it was
   *  written after a sabotage run proved the first one wrong. With the watcher
   *  disabled the change panel still offers the row -- it scans when it opens
   *  -- so "a row appeared without a reopen" is the PANEL's doing and passes
   *  with the watcher gone. What the watcher does is notice the edit in time
   *  to PAUSE that entry, so the ten-second pass leaves the file alone. With it
   *  gone the pass rewrites the writer's words with the book's, which the
   *  design calls "the single worst thing this feature could do". */
  edited_file_holds_the_writers_words: boolean;
  /** How long the rig waited between TYPING INTO THE APPLICATION and reading
   *  the outside-edited file back. Anchored at the typing and not at the
   *  outside edit, because `mirror::due` owes a pass only once the store is
   *  dirty: measured from the edit, the waits before the typing alone would
   *  satisfy the bound while no pass was owed for any of them. The vacuity
   *  guard for the gate above: a file is unchanged for free if no pass was
   *  ever owed, so a window shorter than the staleness bound proves nothing. */
  pass_window_ms: number;
  /** Whether the target document's `rev` in the store moved after the typing.
   *  The other half of the same guard, `mirror-cli`'s `typingLanded`: a click
   *  that missed the editor types nothing, the store stays clean, no pass is
   *  ever owed, and the file holds the writer's words with the watcher gone. */
  book_side_rev_moved: boolean;
  /** How long the outside edit LED the typing by. The ordering the rig depends
   *  on, recorded rather than assumed: the file moves first so the watcher
   *  pauses the entry before the store moves. Not gated -- the other order
   *  leaves nothing to conflict about and `conflict_is_reported` says so. */
  outside_edit_led_by_ms: number;
  /** One of those rows names the document the rig edited from outside. */
  watched_document_row_found: boolean;
  /** Whether the process was restarted before those rows were read -- an
   *  OBSERVATION, the pid the rig booted still among the living shells at
   *  the moment of each row walk, never a constant. Must be FALSE: a row seen
   *  only after a restart proves the scan a boot already runs at open, not
   *  the in-process watcher this act exists to prove. */
  process_restarted: boolean;

  /** Act (c). The state sentence on the row for the document both sides
   *  changed. */
  conflict_row_state_text: string;
  /** The sentence the rig expects there, restated from the page's own
   *  catalog rather than typed fresh a second time. */
  conflict_state_expected: string;
  /** The preserved copy's file name. Must end `.from-project.md`. */
  sidecar_name: string;
  sidecar_exists: boolean;
  /** The sidecar's body, read by the harness's own Markdown reader
   *  (`mirror-read.ts`), holds the sentence the rig typed INTO THE
   *  APPLICATION -- the book's side, never the outside file's. */
  sidecar_holds_the_books_words: boolean;
  /** Change-set rows offered at the moment of the conflict. */
  rows_at_conflict: number;
  /** Of those, rows whose title is NOT the edited document's. The rig edited
   *  one document and a mirror with nothing to hide offers one row; a second
   *  row under any title is the sidecar, or something else, reported back to
   *  the writer as a change about their own book. */
  rows_about_other_files: number;
  /** Whether a row's title carries the sidecar's stem or its suffix. The
   *  page names a titleless row by its path, which is how an `added` sidecar
   *  would surface; a `moved` one would surface under the item's own title
   *  and is caught by the count above instead. Must be FALSE. */
  sidecar_named_in_a_row: boolean;

  /** The explicit full check, after the earlier pause has been cleared. */
  thorough_process_restarted: boolean;
  thorough_metadata_preserved: boolean;
  thorough_was_invisible: boolean;
  thorough_pressed: boolean;
  thorough_row_found: boolean;
  thorough_survived_restart: boolean;
  thorough_rev_moved: boolean;
  thorough_pass_ms: number;
  thorough_file_preserved: boolean;

  /** The post-enable marker reached the actual Markdown file through the first
   * scheduled pass. The enable command's manual write cannot answer for it. */
  scheduled_warmup_reached_mirror: boolean;
  /** The entire second marker reached SQLite before the indicator was read. */
  pending_commit_reached_store: boolean;
  /** Elapsed time from the scheduled pass's observed bytes to that commit. */
  pending_window_ms: number;
  /** `#mirror-indicator`'s direct accessible name while the second marker is
   * still absent from the folder. */
  pending_indicator_text: string;
  pending_indicator_expected: string;
  pending_mirror_lacks_second_marker: boolean;
  /** The visible popover capture, kept beside the result for review. */
  pending_popover_captured: boolean;
  /** The second marker later reached the actual Markdown file. */
  completion_reached_mirror: boolean;
  completion_indicator_text: string;
  completion_indicator_expected: string;

  /** Detached process groups this rig created, recorded after each owned reap.
   * A positive killed count is normal: it means this run's own descendants
   * still needed cleanup. `killShellAndReap` throws if any owned member stays. */
  owned_cleanup_killed: number[];
  owned_cleanup_succeeded: boolean[];

  /** The boot: the summed process-tree peak the boot sampled. */
  peak_rss_mb: number;
}

/** The mirror-acts gates (110, 127), including the explicit full check, are kept
 *  apart from the older `evaluateMirrorGates` block because this rig drives all
 *  three acts in ONE boot that never restarts, and that block's metrics answer
 *  a rig whose whole shape is quitting and reopening.
 *
 *  THE PANEL AND THE WATCHER ARE TWO GATES AND NOT ONE. They were one until a
 *  sabotage run with `spawn_mirror_watcher` disabled left it green: the change
 *  panel scans when it opens, so a row appearing "without a reopen" is the
 *  panel's work and survives the watcher's removal. The watcher's own effect is
 *  that the entry is PAUSED in time, which is what keeps the ten-second pass
 *  from writing the book over the writer's file. Two claims, two gates, and the
 *  sabotage separates them. */
export function evaluateMirrorActsGates(m: MirrorActsMetrics, rssLimit = 750): GateResult[] {
  const enableWrote =
    m.files_in_folder_before === 0 &&
    m.store_documents > 0 &&
    m.files_in_folder_after >= m.store_documents;

  // The count as a WHOLE NUMBER in the sentence: a substring test lets an
  // expected 4 pass on "40 files", and a digit in the "last written" clause
  // could answer for the count.
  const countNamed = new RegExp(`(^|\\D)${m.state_sentence_expected_count}(\\D|$)`).test(
    m.state_sentence,
  );
  const reportsWhereAndHowMany =
    m.state_sentence_expected_count > 0 &&
    countNamed &&
    m.where_names_the_directory &&
    m.where_sentence_redacted.length > 0;

  const remembered = /^[0-9a-f]{32}$/.test(m.book_id) && m.settings_mirrored_book_ids.includes(m.book_id);

  const panelOffered =
    m.process_restarted === false &&
    m.rows_before_any_reopen > 0 &&
    m.watched_document_row_found;

  // `mirror::STALENESS_BOUND_MS`, restated: a pass is owed once ten seconds of
  // application-open time have passed since the last one.
  const STALENESS_BOUND_MS = 10_000;
  const watcherHeldThePassOff =
    m.book_side_rev_moved &&
    m.pass_window_ms >= STALENESS_BOUND_MS &&
    m.edited_file_holds_the_writers_words;

  const conflictReported =
    m.conflict_state_expected.length > 0 && m.conflict_row_state_text === m.conflict_state_expected;

  const preserved =
    m.sidecar_exists && m.sidecar_name.endsWith(".from-project.md") && m.sidecar_holds_the_books_words;

  const sidecarNotOffered =
    m.rows_at_conflict > 0 && m.rows_about_other_files === 0 && m.sidecar_named_in_a_row === false;

  const thoroughFound = m.thorough_metadata_preserved && m.thorough_was_invisible
    && m.thorough_pressed && m.thorough_row_found && m.thorough_process_restarted === false;
  const thoroughPreserved = thoroughFound && m.thorough_survived_restart && m.thorough_rev_moved
    && m.thorough_pass_ms >= STALENESS_BOUND_MS && m.thorough_file_preserved;
  const pendingShown =
    m.scheduled_warmup_reached_mirror &&
    m.pending_commit_reached_store &&
    m.pending_window_ms > 0 &&
    m.pending_window_ms < STALENESS_BOUND_MS &&
    m.pending_indicator_expected.length > 0 &&
    m.pending_indicator_text === m.pending_indicator_expected &&
    m.pending_mirror_lacks_second_marker &&
    m.pending_popover_captured;
  const completionShown =
    pendingShown &&
    m.completion_reached_mirror &&
    m.completion_indicator_expected.length > 0 &&
    m.completion_indicator_text === m.completion_indicator_expected;

  return [
    {
      gate: "enable_writes_the_folder",
      value:
        `${m.files_in_folder_before} file(s) before, ${m.files_in_folder_after} after, ` +
        `for ${m.store_documents} document(s)`,
      threshold:
        "the folder is empty before the press (the vacuity guard: a folder that already held " +
        "files would prove nothing about it), the store has documents, and the folder holds at " +
        "least one file per document afterward",
      verdict: enableWrote ? "PASS" : "FAIL",
    },
    {
      gate: "enable_reports_where_and_how_many",
      value:
        `state "${m.state_sentence}" (expected count ${m.state_sentence_expected_count}), ` +
        `where "${m.where_sentence_redacted}" (names the directory: ${m.where_names_the_directory})`,
      threshold:
        "the state sentence names the count the rig itself counted on disk, and the where " +
        "sentence named the WHOLE directory the rig handed the host. Not its basename: the " +
        "sentence is \"The mirror is written to {dir}\", so a basename check passed on the word " +
        "\"mirror\" appearing in its own wording, which this rig's first green run did",
      verdict: reportsWhereAndHowMany ? "PASS" : "FAIL",
    },
    {
      gate: "enable_is_remembered",
      value: `mirrored [${m.settings_mirrored_book_ids.join(", ")}] (expected "${m.book_id}")`,
      threshold: "settings.json's mirrored list includes this project's own slug",
      verdict: remembered ? "PASS" : "FAIL",
    },
    {
      gate: "the_panel_offers_the_change_without_a_reopen",
      value:
        `${m.rows_before_any_reopen} row(s) offered in the same process that wrote the folder, ` +
        `the edited document ${m.watched_document_row_found ? "among" : "NOT among"} them ` +
        `(restarted: ${m.process_restarted})`,
      threshold:
        "the change panel offers the outside edit as a row without the application being " +
        "restarted, and one of those rows names the document that was edited. This is the " +
        "PANEL's own scan on open, not the watcher's -- a sabotage with the watcher disabled " +
        "still passes it, which is why the watcher has a gate of its own below",
      verdict: panelOffered ? "PASS" : "FAIL",
    },
    {
      gate: "the_watcher_keeps_the_pass_off_an_edited_file",
      value:
        `${m.pass_window_ms} ms after the typing (the store's rev ` +
        `${m.book_side_rev_moved ? "moved" : "DID NOT MOVE"}; the outside edit led by ` +
        `${m.outside_edit_led_by_ms} ms) the file ` +
        `${m.edited_file_holds_the_writers_words ? "still holds" : "NO LONGER HOLDS"} the words ` +
        "the writer put in it",
      threshold:
        "the typing reached the store (its rev moved -- otherwise no pass was owed and the file " +
        `is unchanged for free), a pass window of at least ${STALENESS_BOUND_MS} ms went by ` +
        "AFTER the typing, and the file the writer edited from outside still holds their words. " +
        "That is what the in-process watcher buys: it notices the edit in time to PAUSE the " +
        "entry, so the pass leaves the file alone. With the watcher disabled this goes red and " +
        "the panel gate above does not",
      verdict: watcherHeldThePassOff ? "PASS" : "FAIL",
    },
    {
      gate: "conflict_is_reported",
      value: `row state "${m.conflict_row_state_text}" (expected "${m.conflict_state_expected}")`,
      threshold: "the conflicted row's state sentence equals the page's own catalog sentence for it",
      verdict: conflictReported ? "PASS" : "FAIL",
    },
    {
      gate: "the_books_side_is_preserved",
      value:
        `sidecar "${m.sidecar_name}" exists ${m.sidecar_exists}, holds the book's words ` +
        `${m.sidecar_holds_the_books_words}`,
      threshold:
        'the sidecar exists, its name ends ".from-project.md", and its body -- read by the ' +
        "harness's own Markdown reader -- holds the sentence the rig typed into the application",
      verdict: preserved ? "PASS" : "FAIL",
    },
    {
      gate: "the_sidecar_is_not_offered_as_a_change",
      value:
        `${m.rows_at_conflict} row(s) at the conflict, ${m.rows_about_other_files} about another ` +
        `file, sidecar named in a row ${m.sidecar_named_in_a_row}`,
      threshold:
        "rows were offered (the vacuity guard: with no rows at all, \"no row names the sidecar\" " +
        "is true and proves nothing), every one of them is about the document the rig edited, " +
        "and none names the sidecar itself",
      verdict: sidecarNotOffered ? "PASS" : "FAIL",
    },
    {
      gate: "thorough_check_finds_a_preserved_metadata_edit",
      value: `metadata preserved ${m.thorough_metadata_preserved}, invisible before ${m.thorough_was_invisible}, pressed ${m.thorough_pressed}, row found ${m.thorough_row_found}`,
      threshold: "same size and timestamp, no prior change row, explicit check pressed and a row found without restarting",
      verdict: thoroughFound ? "PASS" : "FAIL",
    },
    {
      gate: "thorough_check_keeps_the_pass_off_an_edited_file",
      value: `found after restart ${m.thorough_survived_restart}, revision moved ${m.thorough_rev_moved}, waited ${m.thorough_pass_ms} ms, complete file preserved ${m.thorough_file_preserved}`,
      threshold: "a thorough-only finding survives restart without rechecking and stays byte-identical after a real store revision change and at least 10000 ms for a mirror pass",
      verdict: thoroughPreserved ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_reports_updating_for_a_committed_pending_save",
      value:
        `scheduled warm-up reached the folder ${m.scheduled_warmup_reached_mirror}, entire ` +
        `second marker reached SQLite ${m.pending_commit_reached_store} ${m.pending_window_ms} ms ` +
        `later, indicator "${m.pending_indicator_text}", second marker absent from folder ` +
        `${m.pending_mirror_lacks_second_marker}, captured ${m.pending_popover_captured}`,
      threshold:
        `after the first scheduled pass reached the folder, a complete second save reaches SQLite ` +
        `within 0 < ms < ${STALENESS_BOUND_MS}; while its bytes are absent, the visible popover ` +
        "has the exact accessible name \"The readable folder is being written\" and the visible popover is captured",
      verdict: pendingShown ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_returns_current_after_the_pending_save_lands",
      value:
        `second marker reached the folder ${m.completion_reached_mirror}, indicator ` +
        `"${m.completion_indicator_text}" (expected "${m.completion_indicator_expected}")`,
      threshold:
        "the same pending save later reaches the actual folder and the still-open popover has the exact accessible name \"The readable folder matches what you have typed\"",
      verdict: completionShown ? "PASS" : "FAIL",
    },
    {
      gate: "mirror_actions_reap_every_owned_launch",
      value: `${m.owned_cleanup_succeeded.length} cleanup receipts; killed [${m.owned_cleanup_killed.join(", ")}]`,
      threshold: "all four owned launches (three app sessions and Xvfb) completed cleanup; killed counts are nonnegative integers",
      verdict: m.owned_cleanup_succeeded.length === 4
        && m.owned_cleanup_succeeded.every((ok) => ok === true)
        && m.owned_cleanup_killed.length === 4
        && m.owned_cleanup_killed.every((count) => Number.isInteger(count) && count >= 0)
        ? "PASS" : "FAIL",
    },
    {
      gate: "peak_rss_mb",
      value: m.peak_rss_mb,
      threshold: `<= ${rssLimit} MB (0 is no sample taken, not a real reading, and FAILS)`,
      verdict: m.peak_rss_mb > 0 && m.peak_rss_mb <= rssLimit ? "PASS" : "FAIL",
    },
  ];
}

// The library's own boot gates: does the window open with
// nothing mounted when the writer asked for that, and does `last` keep
// today's behaviour exactly. Three boots of the SAME data home under the
// three words `settings.start` holds, each read back through the sink
// payload rather than through any page-side assertion -- the payload is what
// `home-cli` actually asks the host for, and a rig that asked the page
// whether it opened correctly would be checking the page against itself.
export interface HomeMetrics {
  /** `project_path` the sink reported for the `home` boot. Empty is correct:
   *  nothing is open. */
  home_project_path: string;
  /** `rows` the sink reported for the `home` boot. 0 is correct. */
  home_rows: number;
  /** Whether `#library`'s own marker (`library-new-pen-name`, present
   *  whatever the vault or the filter holds) was found in the AT-SPI tree for
   *  the `home` boot. GATED as of 100: the empty workspace's own button no
   *  longer distinguishes the two screens, since `home` now shows the
   *  library screen over it. */
  home_library_present: boolean;
  /** `project_path` the sink reported for the `last` boot. Non-empty is
   *  correct: today's behaviour, unchanged. */
  last_project_path: string;
  /** Whether `#library`'s marker was found for the `last` boot. Must be
   *  false: `last` mounts the book and no library screen. */
  last_library_present: boolean;
  /** `project_path` the sink reported for the `blank` boot. Empty is
   *  correct: nothing is open, and no library screen either. */
  blank_project_path: string;
  blank_rows: number;
  /** Whether `#library`'s marker was found for the `blank` boot. Must be
   *  false, `last`'s own reason: `blank` mounts nothing but shows no screen
   *  either -- that is what tells it apart from `home`. */
  blank_library_present: boolean;
  /** `library_overview_ms`: how long `library_overview` took to answer at
   *  the `home` boot, with every cover thumbnail already cached. */
  library_overview_ms: number;
  /** `library_words_ms`: how long `library_book_words` took on one `stress`
   *  book. */
  library_words_ms: number;
  /** Pressing the desk's "Continue writing" through AT-SPI mounted the book;
   *  `project_current` names it and `settings.recent[0]` is it. */
  home_opens_the_book: boolean;
}

/** `library_overview` must answer under this many ms at `stress`, with all 12
 *  cover thumbnails already cached: an overview that opens a read-only store
 *  per book and reads a cached thumbnail must not cost more than a single
 *  full word scan of one stress book (`LIBRARY_WORDS_MS`). */
export const LIBRARY_OVERVIEW_MS = 250;

/** `library_book_words` on one `stress` book must answer under this many ms.
 *  The scan parses every one of the book's 15,200 bodies and counts 1.9
 *  million words -- `Store::word_index`, the same pass a project open runs --
 *  and the first stress run measured it at 183 ms on the host's own clock;
 *  the "~58 ms" this line was first set against is in no record and was a
 *  misremembering. 250 ms holds the bound at the overview's and still fails
 *  the regression it exists to catch: a per-document statement loop. */
export const LIBRARY_WORDS_MS = 250;

export function evaluateHomeGates(m: HomeMetrics): GateResult[] {
  const homeNothingOpen = m.home_project_path === "" && m.home_rows === 0 && m.home_library_present;
  const lastOpensTheBook = m.last_project_path !== "" && !m.last_library_present;
  const blankNothingOpen = m.blank_project_path === "" && m.blank_rows === 0 && !m.blank_library_present;
  return [
    {
      gate: "home_boots_nothing_open",
      value: homeNothingOpen
        ? "nothing mounted, rows 0, #library present"
        : `project_path "${m.home_project_path}", rows ${m.home_rows}, #library present: ${m.home_library_present}`,
      threshold: 'start="home" with no APP_PROJECT mounts nothing and shows the library screen',
      verdict: homeNothingOpen ? "PASS" : "FAIL",
    },
    {
      gate: "start_last_boots_the_book",
      value: lastOpensTheBook
        ? `project_path "${m.last_project_path}", no #library`
        : `project_path "${m.last_project_path}", #library present: ${m.last_library_present}`,
      threshold:
        'start="last" is today\'s behaviour, unchanged: the recorded or newest book opens and no #library shows',
      verdict: lastOpensTheBook ? "PASS" : "FAIL",
    },
    {
      gate: "start_blank_boots_nothing",
      value: blankNothingOpen
        ? "nothing mounted, rows 0, no #library"
        : `project_path "${m.blank_project_path}", rows ${m.blank_rows}, #library present: ${m.blank_library_present}`,
      threshold: 'start="blank" mounts nothing and shows no library screen either -- that is what tells it apart from "home"',
      verdict: blankNothingOpen ? "PASS" : "FAIL",
    },
    {
      gate: "library_overview_ms",
      value: `${m.library_overview_ms} ms`,
      threshold: `<= ${LIBRARY_OVERVIEW_MS} ms at stress, all 12 cover thumbnails cached`,
      verdict: m.library_overview_ms <= LIBRARY_OVERVIEW_MS ? "PASS" : "FAIL",
    },
    {
      gate: "library_words_ms",
      value: `${m.library_words_ms} ms`,
      threshold: `<= ${LIBRARY_WORDS_MS} ms for library_book_words on one stress book`,
      verdict: m.library_words_ms <= LIBRARY_WORDS_MS ? "PASS" : "FAIL",
    },
    {
      gate: "home_opens_the_book",
      value: m.home_opens_the_book
        ? "Continue writing mounted the book; project_current and recent[0] name it"
        : "did not mount, or project_current/recent[0] disagreed",
      threshold:
        "pressing the desk's Continue writing through AT-SPI mounts the book; project_current names it; settings.recent[0] is it",
      verdict: m.home_opens_the_book ? "PASS" : "FAIL",
    },
  ];
}

// The timeline's own gates (102, design section 5, thresholds restated per
// this slice's plan rather than imported -- the two will drift, and this
// file is the source of truth for what this build actually grades). All
// four are read from `timeline-cli`'s own run: a `stress`-sized timeline
// (2,000 events) seeded into a `tiny` project.
export interface TimelineMetrics {
  /** p95 over the last 200 Ctrl+wheel zoom notches, each timed from the wheel
   *  event to the end of the culled paint (`#timeline-status`'s own figure --
   *  see timeline-view.ts). */
  timeline_zoom_p95_ms: number;
  /** `.tl-event` buttons in the AT-SPI tree (and in the DOM) after Fit, at
   *  2,000 events -- the number the cull is supposed to hold flat regardless
   *  of the document's size. */
  timeline_visible_count: number;
  /** An event created by double-click and titled through the card is in the
   *  project FILE, read by a second process, after the flush debounce. */
  timeline_event_round_trip: boolean;
  /** Pressing a seeded event's card Open scene through AT-SPI lands the
   *  scene in the editor: `#scene-heading`'s name equals that scene's title. */
  timeline_open_scene: boolean;
  /** 103, plan item 7: pressing "Make this the one I am writing" on the
   *  seeded branch moves `writing` in the project FILE, read by a second
   *  process after the flush debounce -- the file is the oracle wherever it
   *  can answer, mutation target 7's own rule ("passes on the DOM alone"). */
  timeline_branch_swap: boolean;
  /** 103, plan item 7: dragging a seeded event 100px right through xdotool
   *  grows its `at` in the FILE by the units that 100px is worth at the
   *  toolbar's own current px-per-unit (`#timeline-status`'s figure), not a
   *  restated pixel-to-unit constant this rig could drift from. */
  timeline_drag_moves: boolean;
}

/** The design record's line (section 4): a wheel notch's paint at 2,000
 *  events. The 102 plan tightened it to one 60Hz frame (16 ms) before any
 *  run existed; the first real runs measured a p95 of 15 ms on
 *  dmabuf-llvmpipe, one millisecond under that line on a software renderer
 *  whose noise alone is larger. The line stays at the record's 50: a slower
 *  p95 means the cull (or the paint it drives) is doing O(events) work
 *  somewhere Fit and a wheel notch should both avoid, and 15 -> 50 is the
 *  jump that would show. */
export const TIMELINE_ZOOM_P95_MS = 50;

/** The DOM must never hold anywhere near the document's full 2,000 events at
 *  once; 400 is a generous multiple of what a 1200px-wide window at any
 *  sane zoom actually needs on screen; the cull's whole job is to keep this
 *  number flat as the document grows past it. Counted over event AND dot
 *  buttons: after Fit the corpus collapses into dots, and a count of
 *  `.tl-event` alone read 0 of 2,000, a pass that graded nothing. */
export const TIMELINE_VISIBLE_DOM_BOUND = 400;

export function evaluateTimelineGates(m: TimelineMetrics): GateResult[] {
  const zoomOk = m.timeline_zoom_p95_ms < TIMELINE_ZOOM_P95_MS;
  const visibleOk = m.timeline_visible_count < TIMELINE_VISIBLE_DOM_BOUND;
  return [
    {
      gate: "timeline_zoom_p95_ms",
      value: `${m.timeline_zoom_p95_ms} ms`,
      threshold: `< ${TIMELINE_ZOOM_P95_MS} ms, p95 over 200 Ctrl+wheel notches at 2,000 events`,
      verdict: zoomOk ? "PASS" : "FAIL",
    },
    {
      gate: "timeline_visible_dom_bounded",
      value: m.timeline_visible_count,
      threshold: `< ${TIMELINE_VISIBLE_DOM_BOUND} event and dot buttons in the tree after Fit, at 2,000 events`,
      verdict: visibleOk ? "PASS" : "FAIL",
    },
    {
      gate: "timeline_event_round_trip",
      value: m.timeline_event_round_trip
        ? "the typed title is in the file"
        : "the typed title was not found in the file",
      threshold:
        "an event created by double-click and titled through the card is in the FILE after the flush debounce",
      verdict: m.timeline_event_round_trip ? "PASS" : "FAIL",
    },
    {
      gate: "timeline_open_scene",
      value: m.timeline_open_scene
        ? "#scene-heading names the linked scene"
        : "#scene-heading did not match the linked scene",
      threshold:
        "pressing a card's Open scene through AT-SPI lands the scene in the editor; #scene-heading equals its title",
      verdict: m.timeline_open_scene ? "PASS" : "FAIL",
    },
    {
      gate: "timeline_branch_swap",
      value: m.timeline_branch_swap
        ? "the branch's writing flag moved in the file"
        : "the branch's writing flag did not move in the file",
      threshold:
        "pressing the seeded branch's 'Make this the one I am writing' through AT-SPI sets `writing` true in the FILE",
      verdict: m.timeline_branch_swap ? "PASS" : "FAIL",
    },
    {
      gate: "timeline_drag_moves",
      value: m.timeline_drag_moves
        ? "the dragged event's `at` grew by the expected units in the file"
        : "the dragged event's `at` did not grow by the expected units in the file",
      threshold:
        "an xdotool drag of 100px on a seeded event grows its `at` in the FILE by 100 / px-per-unit units",
      verdict: m.timeline_drag_moves ? "PASS" : "FAIL",
    },
  ];
}
