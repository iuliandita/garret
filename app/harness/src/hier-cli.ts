// app/harness/src/hier-cli.ts
// Graded hierarchy run: seed a fresh project, boot with APP_PROJECT, run the
// unchanged typing/nav soak, then a bounded mutation phase, kill the shell,
// reboot against the same file, and assert the tree shape survived.
//
// The typing and nav cycle is byte-identical to nav-cli's and persist-cli's on
// purpose: its numbers have to stay comparable across slices. Reworking the
// workload here would mean a latency change could be the workload or the tree,
// with nothing to tell them apart.
//
// Budget: capped at 5 minutes, as persist-cli is. Any Xvfb run long enough to
// straddle ~600 s has its latency gates measuring the rig's unexplained event
// rather than the application (2026-08-02 write-back).
//
// No staged dist: both boots run with APP_PROJECT set, and main.ts only fetches
// corpus.json on the APP_PROJECT===null branch.
//
// TWO DEVIATIONS FROM THE SLICE PLAN, both forced by what the page emits. They
// are recorded in the result under `metrics.scope` so a reader a year out sees
// what was and was not checked:
//
//  1. The reopen boot runs in APP_PERSIST_MODE=write with APP_MUTATIONS=0, not
//     in verify mode. Verify mode sinks and returns BEFORE the tree block is
//     built (app/ui/src/main.ts), so a verify payload carries no walk at all
//     and `tree_shape_match` would have nothing to compare. Write mode with
//     zero mutations reopens the same file, reprojects the reopened store and
//     reports `tree.rows`; the 1 s soak it also runs touches the document, not
//     the tree.
//  2. The two AT-SPI probes are taken at two POINTS IN TIME, not at two
//     commanded scroll positions. The navigator has no DOM key wiring — the
//     workload calls `navigator.handleKey` directly — and the page exposes no
//     scroll-target env knob, so the harness cannot drive it anywhere. The
//     soak's own random nav jumps move the mounted window; each probe records
//     where the window actually was, measured from the rows it saw.
//
// Usage: APP_GUI=1 bun app/harness/src/hier-cli.ts [soakMinutes]
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAtspi, unavailable } from "./atspi";
import { captureEnv } from "./env";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import {
  evaluateGates,
  evaluateHierGates,
  type A11yProbe,
  type GateResult,
  type HierMetrics,
  type Metrics,
} from "./gates";
import { buildResult, scriptOf, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  runShell,
  survivingShellPids,
  type RunOutcome,
  type SinkPayload,
} from "./shell";
import { degradationStep } from "./step";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/stress";
const FIXTURE_LABEL = "stress";
const RESULTS = "app/results";
const MAX_MINUTES = 5;
const MUTATIONS = 180;
/** Reopen boot: long enough to load, short enough not to be a second soak. */
const REOPEN_SOAK_MS = 1000;
/** Give up waiting for the first probe rather than probe an app that never came up. */
const PROBE_WAIT_MS = 300_000;

interface TreeRow {
  id: string;
  level: number;
  setsize: number;
  posinset: number;
}

interface WalkRow {
  id: string;
  parent_id: string | null;
  position: string;
}

// Three fields, three instants, and the page's field names say which is which.
// pre_mutation_* is the page's own projection before the soak and before any
// mutation; post_walk is the store's walk after them. On a 180-mutation stress
// run pre_mutation_nodes is 15,200 and post_walk.length is 15,260 — the created
// scenes, not a shape mismatch. Nothing here compares the two counts.
interface TreeBlock {
  pre_mutation_nodes: number;
  /** The page's OWN visible.ts projection, before the soak and the mutations. */
  pre_mutation_rows: TreeRow[];
  /** Post-mutation store walk from the Rust CTE. Null when nothing was mutated. */
  post_walk: WalkRow[] | null;
  /** Denominator. attempts == mutations + mutation_errors. */
  mutation_attempts: number;
  /** Writes that LANDED. The percentiles below are over these only, so this is
   *  the count to check before trusting mutation_p95_ms. */
  mutations: number;
  mutation_errors: number;
  mutation_error_messages: string[];
  mutation_p50_ms: number;
  mutation_p95_ms: number;
}

type HierSinkPayload = SinkPayload & { tree: TreeBlock };

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function metricsOf(o: RunOutcome<HierSinkPayload>): Metrics {
  return {
    peak_rss_mb: o.peakRssMb,
    typing_p95_ms: o.payload.typing.frame.p95,
    typing_p99_ms: o.payload.typing.frame.p99,
    nav_p95_ms: o.payload.nav.frame.p95,
    typing: o.payload.typing,
    nav: o.payload.nav,
    cycles: o.payload.cycles,
    rows: o.payload.rows,
    workload_script: scriptOf(o.payload.workload_script),
    a11y: o.a11y,
  };
}

/** Parent of each row in a depth-first projection: the nearest preceding row
 *  one level shallower. Lets a payload that carries `level` but no parent id
 *  (tree.rows) be compared against one that carries parent ids (post_walk). */
function parentsFromLevels(rows: readonly TreeRow[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const path: string[] = [];
  for (const r of rows) {
    const depth = r.level - 1;
    path.length = Math.min(path.length, depth);
    parents.set(r.id, depth === 0 ? null : (path[depth - 1] ?? null));
    path[depth] = r.id;
  }
  return parents;
}

/** 1-based ordinal within the parent's child group, in walk order. `position`
 *  itself is an internal fractional-index key the page never reports, so the
 *  ordinal it induces is the comparable form of the same fact. */
function ordinalsFromWalk(walk: readonly WalkRow[]): Map<string, number> {
  const seen = new Map<string | null, number>();
  const out = new Map<string, number>();
  for (const w of walk) {
    const n = (seen.get(w.parent_id) ?? 0) + 1;
    seen.set(w.parent_id, n);
    out.set(w.id, n);
  }
  return out;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

interface ProbeSample {
  label: string;
  at_ms: number;
  probed_rows: number;
  /** Rows carrying a usable `nav-row-<index>` DOM id, so a comparison was possible. */
  aligned_rows: number;
  /** Rows with no id, an unparseable one, one past the end of the projection, or
   *  one a previous row in the same dump already claimed. */
  unattributable_rows: number;
  level_mismatches: number;
  setsize_mismatches: number;
  posinset_mismatches: number;
  /** Where the mounted window sat, as a fraction of the projection. Null when
   *  nothing aligned. Measured, not commanded — see the header. */
  window_median_index: number | null;
  window_fraction: number | null;
}

/**
 * Compare one AT-SPI dump against the page's own projection.
 *
 * The two sides are derived independently ON PURPOSE. The left side is the live
 * accessibility tree as WebKitGTK's ATK bridge reports it; the right side is
 * the page's `visible.ts` projection as it sinks it. Reading one source twice
 * would make a mismatch impossible and the gate theatre.
 *
 * The join is the row's DOM id, `nav-row-<walkIndex>`, which the probe now
 * carries. It is exact: names were never a key (WebKitGTK gives these rows an
 * empty accessible name, and 2,292 of the 20,000 stress titles are shared
 * anyway), while the walk index names one item and nothing else.
 *
 * `walkIndex` indexes the navigator's FULL walk; `pre_mutation_rows` is the
 * VISIBLE projection of that walk. They coincide because the soak's key set is
 * ArrowUp/Down, PageUp/Down, Home and End — no ArrowLeft — so nothing is ever
 * collapsed and every node stays visible. If that stops holding, the two
 * diverge by whole subtrees and this reports a wall of level/setsize
 * mismatches. It cannot pass by accident.
 *
 * What this alignment CANNOT catch: it says nothing about rows that were never
 * mounted (~36 of 15,200 per probe), and a row painted with the wrong CONTENT
 * under the right id is invisible to it — level, setsize and posinset are the
 * only things compared.
 */
const NAV_ROW_ID = /^nav-row-(\d+)$/;

function compareProbe(
  label: string,
  atMs: number,
  probe: A11yProbe,
  pageRows: readonly TreeRow[],
): ProbeSample {
  let aligned = 0;
  let unattributable = 0;
  let levelMismatches = 0;
  let setsizeMismatches = 0;
  let posinsetMismatches = 0;
  const indices: number[] = [];
  const claimed = new Set<number>();

  for (const row of probe.treeRows) {
    const matched = row.id.match(NAV_ROW_ID);
    const at = matched === null ? -1 : Number(matched[1]);
    const page = at >= 0 ? pageRows[at] : undefined;
    // A repeat means two mounted rows claim the same item: a defect, not a
    // sample. Count it, and do not let it vote twice on the comparison.
    if (page === undefined || claimed.has(at)) {
      unattributable++;
      continue;
    }
    claimed.add(at);
    aligned++;
    if (row.level !== page.level) levelMismatches++;
    if (row.setsize !== page.setsize) setsizeMismatches++;
    if (row.posinset !== page.posinset) posinsetMismatches++;
    indices.push(at);
  }

  indices.sort((a, b) => a - b);
  const median = indices.length === 0 ? null : indices[Math.floor(indices.length / 2)]!;

  return {
    label,
    at_ms: atMs,
    probed_rows: probe.treeRows.length,
    aligned_rows: aligned,
    unattributable_rows: unattributable,
    level_mismatches: levelMismatches,
    setsize_mismatches: setsizeMismatches,
    posinset_mismatches: posinsetMismatches,
    window_median_index: median,
    window_fraction:
      median === null || pageRows.length === 0
        ? null
        : Number((median / pageRows.length).toFixed(4)),
  };
}

function abort(message: string, cleanup: () => void): never {
  console.error(`\n${message}\nNothing was written.`);
  cleanup();
  process.exit(2);
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; hierarchy run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — build it or generate the fixture before running.`);
    process.exit(1);
  }
}
{
  const preexisting = survivingShellPids();
  if (preexisting.length > 0) {
    console.error(
      `refusing to start: ${SHELL_PROC_NAME} already running (pid(s) ${preexisting.join(", ")}).\n` +
        `A pre-existing instance makes the AT-SPI probe unable to attribute rows to exactly one ` +
        `window, so the structural gate cannot be measured.\n` +
        `Clear it (kill the stray process) and re-run.`,
    );
    process.exit(1);
  }
}

const requested = Number(process.argv[2] ?? MAX_MINUTES);
if (!Number.isFinite(requested) || requested <= 0) {
  console.error(`bad soak budget "${process.argv[2]}": expected a positive number of minutes.`);
  process.exit(1);
}
if (requested > MAX_MINUTES) {
  console.error(
    `refusing a ${requested}-minute run: budgets over ${MAX_MINUTES} minutes straddle the ~600 s ` +
      `headless event, so their latency gates measure the rig rather than the application.`,
  );
  process.exit(1);
}
const soakMs = Math.round(requested * 60_000);
const fixtureFloor = fixtureItemFloor(FIXTURE);

const projectDir = mkdtempSync(join(tmpdir(), "app-hier-"));
const projectPath = join(projectDir, "project.db");
function cleanup(): void {
  rmSync(projectDir, { recursive: true, force: true });
}

console.log(`[1/3] seeding project from ${FIXTURE}`);
const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
  stdout: "inherit",
  stderr: "inherit",
});
if (seeded.exitCode !== 0) {
  console.error(`seeding failed (exit ${seeded.exitCode}); nothing was written.`);
  cleanup();
  process.exit(1);
}

console.log(`\n[2/3] write run, ${requested} min, ${MUTATIONS} mutations`);
let finished = false;
const writePromise = runShell<HierSinkPayload>({
  mode: "virtual",
  soakMs,
  staged: DIST,
  env: {
    APP_PROJECT: projectPath,
    APP_PERSIST_MODE: "write",
    APP_MUTATIONS: String(MUTATIONS),
  },
}).then(
  (o) => {
    finished = true;
    return o;
  },
  (e: unknown) => {
    finished = true;
    throw e;
  },
);
// The rejection is handled below by awaiting; this only stops Bun treating the
// window between here and that await as an unhandled rejection.
writePromise.catch(() => undefined);

/** This rig has no `onReady`; the AT-SPI walk races `writePromise` instead of
 *  running inside it, so there is no `rootPid` from `runShell` to hand
 *  `probeAtspi`. The pre-existing-instance refusal above guarantees at most
 *  one `SHELL_PROC_NAME` is alive once the spawn has happened, so its own pid
 *  stands in for the spawn's -- `probeAtspi` walks its descendants either
 *  way, and the registrant is the shell process itself. No shell yet (or no
 *  longer) reads as an unavailable probe, not a thrown error. */
function probeRunningShell(): A11yProbe {
  const pids = survivingShellPids();
  if (pids.length !== 1) return unavailable();
  return probeAtspi(Number(pids[0]));
}

const runStartedAt = Date.now();
const probes: { probe: A11yProbe; atMs: number; label: string }[] = [];

// Probe 1: as soon as the tree is up. Two probes at two POINTS IN TIME, not at
// two commanded positions — see the header. The soak's own nav jumps move the
// window between them, and each probe records where it actually landed.
let lastProbeState = "";
while (!finished && Date.now() - runStartedAt < PROBE_WAIT_MS) {
  const p = probeRunningShell();
  if (p.available && p.treeRows.length > 0) {
    probes.push({ probe: p, atMs: Date.now() - runStartedAt, label: "first-window" });
    break;
  }
  // An unavailable probe and an available one exposing no tree rows are
  // different failures — one is the bus, the other is the navigator's roles —
  // and a run that ends in the vacuity guard must say which it hit.
  const state = `available=${p.available} mounted=${p.mountedRows} treeRows=${p.treeRows.length}`;
  if (state !== lastProbeState) {
    console.log(`  probe at ${((Date.now() - runStartedAt) / 1000).toFixed(0)} s: ${state}`);
    lastProbeState = state;
  }
  await Bun.sleep(2000);
}
if (probes.length > 0) {
  console.log(`  probe 1 at ${(probes[0]!.atMs / 1000).toFixed(0)} s: ${probes[0]!.probe.treeRows.length} tree rows`);
  // Probe 2 late in the soak, so the workload has had time to move the window.
  const secondAt = runStartedAt + probes[0]!.atMs + Math.round(soakMs * 0.7);
  while (!finished && Date.now() < secondAt) await Bun.sleep(1000);
  if (!finished) {
    const p = probeRunningShell();
    if (p.available && p.treeRows.length > 0) {
      probes.push({ probe: p, atMs: Date.now() - runStartedAt, label: "later-window" });
      console.log(`  probe 2 at ${(probes[1]!.atMs / 1000).toFixed(0)} s: ${p.treeRows.length} tree rows`);
    } else {
      console.log("  probe 2 unavailable; the structural check falls back to one window.");
    }
  } else {
    console.log("  run finished before the second probe; the structural check has one window.");
  }
} else {
  console.log("  no AT-SPI tree rows seen during the run.");
}

const write = await writePromise;
try {
  assertFixtureFloor(FIXTURE_LABEL, write.payload.tree.pre_mutation_nodes, fixtureFloor);
} catch (e) {
  abort((e as Error).message, cleanup);
}
console.log(
  `  runShell's own probe: available=${write.a11y.available} mounted=${write.a11y.mountedRows} ` +
    `treeRows=${write.a11y.treeRows.length} roles=${Object.keys(write.a11y.roleCounts ?? {}).join(",")}`,
);
// A page that could not construct a legal mutation sinks ready:false, and
// runShell throws on it rather than returning a payload — a failed run, not a
// gradeable one, so nothing below is reached.
const tree = write.payload.tree;
console.log(
  `  mutations: ${tree.mutations} landed of ${tree.mutation_attempts} attempted, ` +
    `errors ${tree.mutation_errors}, p50 ${tree.mutation_p50_ms} ms, p95 ${tree.mutation_p95_ms} ms`,
);
for (const m of tree.mutation_error_messages) console.log(`  mutation error: ${m}`);
console.log(`  cycles (p95 ms per cycle, * = partial):`);
for (const c of write.payload.cycles) {
  console.log(`    cycle ${c.cycle} at ${(c.atMs / 1000).toFixed(0)} s: ${c.typingP95Ms}${c.partial ? " *" : ""}`);
}
const step = degradationStep(write.payload.cycles);
console.log(
  step === null
    ? "  no sustained cycle-level step detected"
    : `  cycle-level step at cycle ${step.cycle} (${(step.atMs / 1000).toFixed(0)} s): ` +
        `${step.p95Ms} ms vs baseline ${step.baselineP95Ms} ms`,
);
console.log(
  write.payload.onset === null
    ? "  no action-level onset"
    : `  action-level onset at ${(write.payload.onset.atMs / 1000).toFixed(1)} s, action ${write.payload.onset.actionIndex}`,
);

// Vacuity guards, before any gate is evaluated. Each of these would let
// tree_shape_match and a11y_tree_structure pass against something nothing
// touched — the same class of false pass the persistence slice's guard caught.
if (tree.mutations === 0) {
  abort(
    `VACUITY GUARD: no mutations landed (${tree.mutation_attempts} attempted, ` +
      `${tree.mutation_errors} error(s)). tree_shape_match would compare an untouched store ` +
      "against itself and mutation_p95_ms would be a percentile over zero successful writes." +
      (tree.mutation_error_messages.length > 0
        ? `\n  ${tree.mutation_error_messages.join("\n  ")}`
        : ""),
    cleanup,
  );
}
if (tree.post_walk === null || tree.post_walk === undefined) {
  abort(
    `VACUITY GUARD: ${tree.mutations} mutation(s) landed but the payload carries no post_walk, so ` +
      "there is no post-mutation shape to assert anything about.",
    cleanup,
  );
}
if (!Array.isArray(tree.pre_mutation_rows) || tree.pre_mutation_rows.length === 0) {
  abort(
    "VACUITY GUARD: the payload carries no pre_mutation_rows, so the AT-SPI dump has nothing " +
      "independent to be compared against and a11y_tree_structure would grade nothing.",
    cleanup,
  );
}
const postWalk: WalkRow[] = tree.post_walk;

const bootIds = tree.pre_mutation_rows.map((r) => r.id);
const bootParents = parentsFromLevels(tree.pre_mutation_rows);
const postIds = postWalk.map((w) => w.id);
const treeChanged =
  !sameOrder(bootIds, postIds) ||
  postWalk.some((w) => bootParents.get(w.id) !== w.parent_id);
if (!treeChanged) {
  abort(
    "VACUITY GUARD: the tree is identical before and after the mutation phase (same ids in the " +
      "same order, same parents). tree_shape_match would pass against a store the mutations " +
      "never reached.",
    cleanup,
  );
}

const samples = probes.map((p) => compareProbe(p.label, p.atMs, p.probe, tree.pre_mutation_rows));
const probedRows = samples.reduce((a, s) => a + s.probed_rows, 0);
if (probedRows === 0) {
  abort(
    "VACUITY GUARD: no tree rows were probed. a11y_tree_structure would report UNKNOWN and the " +
      "run would prove nothing about the accessibility contract.\n" +
      `  AT-SPI roles seen: ${Object.entries(write.a11y.roleCounts ?? {})
        .map(([r, n]) => `${r} x${n}`)
        .join(", ")}\n` +
      "  If those are all generic ('section'), the probe is not failing — WebKitGTK is not " +
      "mapping the navigator's ARIA tree onto tree roles, and atspi.ts matches on role.",
    cleanup,
  );
}
for (const s of samples) {
  console.log(
    `  ${s.label} at ${(s.at_ms / 1000).toFixed(0)} s: ${s.probed_rows} rows, ${s.aligned_rows} aligned, ` +
      `${s.unattributable_rows} unattributable, window ~${
        s.window_fraction === null ? "?" : `${(s.window_fraction * 100).toFixed(1)}%`
      }`,
  );
}

console.log(`\n[3/3] reopen run against the same project`);
const reopen = await runShell<HierSinkPayload>({
  mode: "virtual",
  soakMs: REOPEN_SOAK_MS,
  staged: DIST,
  env: {
    APP_PROJECT: projectPath,
    // write, not verify: the verify payload returns before the tree block is
    // built, so it carries no walk to compare. See the header.
    APP_PERSIST_MODE: "write",
    APP_MUTATIONS: "0",
  },
  probeA11y: false,
});

// The reopened shape, reprojected by a SECOND process from the file the killed
// one left behind, against the walk the first process reported before it died.
// The reopen boot runs zero mutations, so its `pre_mutation_rows` IS its whole
// projection of the reopened store: the post-restart instant.
const reopenRows = reopen.payload.tree.pre_mutation_rows;
const reopenIds = reopenRows.map((r) => r.id);
const reopenParents = parentsFromLevels(reopenRows);
const postOrdinals = ordinalsFromWalk(postWalk);
const idsMatch = sameOrder(postIds, reopenIds);
const parentsMatch = postWalk.every((w) => reopenParents.get(w.id) === w.parent_id);
const ordinalsMatch = reopenRows.every((r) => postOrdinals.get(r.id) === r.posinset);
const treeShapeMatch = idsMatch && parentsMatch && ordinalsMatch;
console.log(
  `  ids/order ${idsMatch ? "match" : "MISMATCH"}, parents ${parentsMatch ? "match" : "MISMATCH"}, ` +
    `sibling ordinals ${ordinalsMatch ? "match" : "MISMATCH"} ` +
    `(${postIds.length} walked vs ${reopenIds.length} reprojected)`,
);

// exposed_nodes / store_nodes are WINDOW-SCOPED, and the result says so. A
// virtualized tree mounts ~36 of 20,000 rows, so no AT-SPI dump can carry a
// full-set node count; the flat navigator's "one advertised setsize == total"
// has no tree equivalent (which is why a11y_exposure is omitted below). What is
// assertable is that every row the accessibility tree exposed names a distinct
// item of the walk: a row with no id, a stale id past the end of the
// projection, or two rows claiming the same item all fail it.
const exposedNodes = samples.reduce((a, s) => a + s.aligned_rows, 0);
const hierMetrics: HierMetrics = {
  tree_shape_match: treeShapeMatch,
  tree_changed: treeChanged,
  store_nodes: probedRows,
  exposed_nodes: exposedNodes,
  level_mismatches: samples.reduce((a, s) => a + s.level_mismatches, 0),
  setsize_mismatches: samples.reduce((a, s) => a + s.setsize_mismatches, 0),
  probed_rows: probedRows,
  mutations: tree.mutations,
  mutation_errors: tree.mutation_errors,
  mutation_p50_ms: tree.mutation_p50_ms,
  mutation_p95_ms: tree.mutation_p95_ms,
};

// a11y_exposure is filtered out, not left to report. It reads "the single
// consistent aria-setsize the rows advertise, else 0", which is a flat-list
// concept: a tree advertises per-sibling-group setsize, so several distinct
// values, and the gate collapses to 0. It would sit in the same result
// contradicting a11y_tree_structure on the same dump, which is unresolvable for
// whoever reads this a year from now. The omission is recorded in metrics so
// its absence is not mistaken for an oversight.
const OMITTED_GATE = "a11y_exposure";
const verdicts: GateResult[] = [
  ...evaluateGates(metricsOf(write)).filter((g) => g.gate !== OMITTED_GATE),
  ...evaluateHierGates(hierMetrics),
];

const path = writeResult(
  buildResult({
    workload: "app-hier",
    // w2 is the workload generation, not the harness version: the hierarchy
    // slice's evidence at app-hier-stress-5m.json was produced by a workload
    // that typed into one paragraph and never collapsed anything, and a run of
    // the new script must not overwrite it.
    runId: `app-hier-w2-stress-${requested}m`,
    candidate: "tauri",
    fixture: "stress",
    verdicts,
    metrics: {
      ...metricsOf(write),
      startup_ms: write.payload.startup_ms,
      soak_minutes: requested,
      fixture_floor: fixtureFloor,
      actions: write.payload.actions,
      onset: write.payload.onset,
      slow_actions: write.payload.slow_actions,
      degradation_step: degradationStep(write.payload.cycles),
      hier: hierMetrics,
      mutation_attempts: tree.mutation_attempts,
      // Attached whenever there is one: a mutation_errors failure with no
      // message costs somebody an afternoon a year from now.
      ...(tree.mutation_error_messages.length > 0
        ? { mutation_error_messages: tree.mutation_error_messages }
        : {}),
      pre_mutation_nodes: tree.pre_mutation_nodes,
      post_walk_nodes: postWalk.length,
      reopen_nodes: reopen.payload.tree.pre_mutation_nodes,
      reopen_peak_rss_mb: reopen.peakRssMb,
      a11y_probes: samples,
      tree_shape: {
        ids_match: idsMatch,
        parents_match: parentsMatch,
        sibling_ordinals_match: ordinalsMatch,
      },
      omitted_gates: [
        {
          gate: OMITTED_GATE,
          reason:
            "flat-list concept: it reads the single consistent aria-setsize the rows advertise, " +
            "else 0. A tree advertises per-sibling-group setsize, so it collapses to 0 and would " +
            "contradict a11y_tree_structure on the same dump. Superseded by a11y_tree_structure.",
        },
      ],
      scope: {
        instants:
          "a11y_tree_structure compares the live AT-SPI tree against tree.pre_mutation_rows, the " +
          "page's projection BEFORE the soak and the mutations — which is also what the DOM still " +
          "shows, since the navigator never re-reads the store. tree_shape_match compares " +
          "tree.post_walk, the store's walk AFTER the mutations, against the reopened boot's own " +
          `projection of the same file. Two different instants by design: ${tree.pre_mutation_nodes} ` +
          `pre-mutation nodes versus ${postWalk.length} post-mutation, the difference being the ` +
          "scenes the mutation phase created. No gate compares those two counts.",
        a11y:
          "Window-scoped. The navigator mounts ~36 of " +
          `${tree.pre_mutation_nodes} rows, so exposed_nodes/store_nodes count the PROBED rows, ` +
          "not the whole tree. Each probed row is joined to the projection by its DOM id " +
          "(nav-row-<walkIndex>), which is exact; level, setsize and posinset are then compared. " +
          "Rows that were never mounted are outside the sample entirely.",
        probe_positions:
          "Two points in time, not two commanded scroll positions. The navigator has no DOM key " +
          "wiring and the page takes no scroll-target env knob, so the harness cannot drive it; " +
          "the soak's own nav jumps move the window and a11y_probes records where each probe " +
          "actually landed (window_fraction).",
        tree_shape_match:
          "The reopen boot runs APP_PERSIST_MODE=write with APP_MUTATIONS=0, because the verify " +
          "payload returns before the tree block is built and carries no walk. Compared: ids in " +
          "walk order, parents, and 1-based ordinal within each parent. The raw `position` keys " +
          "are not compared — the reopened boot does not report them.",
      },
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

cleanup();
console.log(`\nrecorded: ${path}`);
for (const v of verdicts) console.log(`  ${v.gate}: ${v.value} (${v.threshold}) ${v.verdict}`);
console.log(`  ${OMITTED_GATE}: omitted (see metrics.omitted_gates)`);
