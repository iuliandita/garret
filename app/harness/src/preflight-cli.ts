// app/harness/src/preflight-cli.ts
// Graded run of `preflight`, the read-only cross-identity scan. Until
// this rig, an earlier amendment recorded "NO GRADED RIG COVERS THE CROSS-IDENTITY
// SCAN AT `stress`" -- the CLI existed and its unit tests over a tempdir
// proved the logic, but nothing had ever timed the walk over a real book or
// watched its memory.
//
// HEADLESS, LIKE `salvage-cli.ts`. `preflight` has no page surface: no window,
// no Xvfb, no AT-SPI, nothing here spawns a shell. The rig runs the release
// binary directly and reads its `--json` stdout.
//
// FOUR STEPS. (a) seed the fixture; (b) run with NO vault at all, which must
// read `not_applicable` and answer clean; (c) plant a two-identity vault,
// pin the book to the first, and PLANT the second identity's public name into
// the LAST scene (in book order) that carries a body, then run FIVE times,
// timed and memory-sampled; (d) restore that scene's original body and run
// once more. (b) and (d) are what make (c) falsifiable: a rig that only ran
// (c) could not tell "the scan works" from "the scan always says blocker".
//
// Usage: bun app/harness/src/preflight-cli.ts <tiny|stress>
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plantDemoIdentities, DEMO_VAULT } from "./demo-vault";
import { captureEnv } from "./env";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import {
  CHECK_CROSS_IDENTITY,
  evaluatePreflightGates,
  FINDING_CROSS_IDENTITY,
  type GateResult,
  type PreflightMetrics,
} from "./gates";
import { buildResult, writeResult } from "./results";
import { BIN } from "./shell";

const RESULTS = "app/results";
/** How often the peak-memory sampler reads /proc while the command runs,
 *  `salvage-cli`'s own interval. */
const RSS_POLL_MS = 20;
/** How long one `preflight` may take before the rig calls it never. A
 *  liveness bound, generously above any figure `preflight_ms` will ever
 *  read, and not the gate. */
const PREFLIGHT_TIMEOUT_MS = 60_000;
/** How many timed runs step (c) grades, so one bad run cannot make the
 *  finding gate or set `preflight_ms` alone. */
const PLANTED_RUNS = 5;
/** store/mod.rs MAX_DEPTH, restated as every rig here restates it, so the
 *  plant-site walk below cannot recurse forever on a parent_id cycle. */
const MAX_DEPTH = 64;

const fixture = process.argv[2];
if (fixture !== "tiny" && fixture !== "stress") {
  console.error("usage: bun app/harness/src/preflight-cli.ts <tiny|stress>");
  process.exit(1);
}
const FIXTURE_DIR = `lab/fixtures/out/${fixture}`;

function abort(why: string, cleanup: () => void): never {
  console.error(`\nABORTED: ${why}\nNothing was written to ${RESULTS}.`);
  cleanup();
  process.exit(1);
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function readRows<T>(path: string, sql: string, params: SQLQueryBindings[] = []): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function writeRow(path: string, sql: string, params: SQLQueryBindings[] = []): void {
  const db = new Database(path);
  try {
    db.query(sql).run(...params);
  } finally {
    db.close();
  }
}

// -------------------------------------------------------- shape of the JSON

interface PreflightCheck {
  name: string;
  state: string;
}

interface PreflightFinding {
  kind: string;
  severity: string;
  surface: string;
  item_id: string | null;
  offset: number | null;
  matched: string;
}

interface PreflightJson {
  path: string;
  format: string;
  identity: unknown;
  fields: unknown[];
  checks: PreflightCheck[];
  skipped: string[];
  findings: PreflightFinding[];
  surfaces_checked: string[];
  surfaces_unchecked: string[];
  blockers: number;
  ok: boolean;
}

interface Run {
  exitCode: number;
  wallMs: number;
  peakRssMb: number;
  json: PreflightJson | null;
  stderr: string;
  /** The signal that killed the process, or `null` for a normal exit --
   *  `salvage-cli`'s own field, read for the same reason: a segfault prints
   *  nothing on stdout or stderr, and only the signal says why. */
  signalCode: string | null;
}

/** Run the release binary's `preflight --json` against `dbPath`, with
 *  `XDG_DATA_HOME` set to `dataHome` on the CHILD process only -- never in the
 *  rig's own environment, the same seam `preflight_with`'s tests keep to on
 *  the Rust side.
 *
 *  THE FIGURE IS THE KERNEL'S OWN `VmHWM`, `salvage-cli`'s own instrument and
 *  for its own reason: monotonic, so a poll that misses the busiest instant
 *  still reports the true peak up to its last read. */
async function preflight(dbPath: string, dataHome: string): Promise<Run> {
  const started = performance.now();
  const proc = Bun.spawn([BIN, "preflight", dbPath, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_DATA_HOME: dataHome },
  });
  let hwmKb = 0;
  function sampleOnce(): void {
    try {
      const status = readFileSync(`/proc/${proc.pid}/status`, "utf8");
      const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
      if (m !== null) hwmKb = Math.max(hwmKb, Number(m[1]));
    } catch {
      // the process has not written /proc yet, or already exited
    }
  }
  // ONE READ IMMEDIATELY, before the first interval tick: `preflight` over
  // `tiny` is fast enough that a run has finished and torn down its /proc
  // entry before RSS_POLL_MS elapses, and a sampler that only polls on the
  // interval would report a peak of zero for a process that plainly ran.
  sampleOnce();
  const sampler = setInterval(sampleOnce, RSS_POLL_MS);
  const deadline = setTimeout(() => proc.kill(), PREFLIGHT_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearInterval(sampler);
  clearTimeout(deadline);
  const wallMs = performance.now() - started;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (hwmKb === 0) {
    abort(
      "the peak-memory sampler never read a VmHWM line for this run -- neither the immediate " +
        "read at spawn nor any interval tick caught the process before it exited. Reporting 0 as " +
        "preflight_rss_mb would read as a measurement instead of as no sample taken.",
      cleanup,
    );
  }
  let json: PreflightJson | null = null;
  try {
    json = JSON.parse(stdout) as PreflightJson;
  } catch {
    json = null;
  }
  return {
    exitCode,
    wallMs,
    peakRssMb: Math.round((hwmKb / 1024) * 10) / 10,
    json,
    stderr,
    signalCode: proc.signalCode,
  };
}

function checkState(run: Run, name: string): string {
  const c = run.json?.checks.find((c) => c.name === name);
  if (c === undefined) {
    abort(
      `preflight --json reported no check named "${name}" (checks: ` +
        `${JSON.stringify(run.json?.checks ?? null)}). The rig cannot read a state that is not there.`,
      cleanup,
    );
  }
  return c.state;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// ------------------------------------------------- finding the plant site

/** Find the first `{"type":"text",...}` node in a parsed ProseMirror doc,
 *  depth-first, and return the NODE ITSELF (not a copy) so the caller can
 *  mutate `.text` in place before re-serializing. */
function firstTextNode(node: unknown): { text: string } | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text" && typeof n.text === "string") return n as { text: string };
  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      const found = firstTextNode(child);
      if (found !== null) return found;
    }
  }
  return null;
}

// --------------------------------------------------------------------- run

const workDir = mkdtempSync(join(tmpdir(), "app-preflight-"));
const dataHome = join(workDir, "data");
mkdirSync(join(dataHome, "garret"), { recursive: true });
function cleanup(): void {
  rmSync(workDir, { recursive: true, force: true });
}

const projectPath = join(workDir, "book.db");

console.log(`[1/4] seeding ${fixture} through the release binary`);
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE_DIR, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`, cleanup);
}

const itemCount = readRows<{ n: number }>(projectPath, "SELECT COUNT(*) AS n FROM item")[0]!.n;
try {
  assertFixtureFloor(fixture, itemCount, fixtureItemFloor(FIXTURE_DIR));
} catch (e) {
  abort(String(e instanceof Error ? e.message : e), cleanup);
}

// THE LAST SCENE, IN BOOK ORDER, THAT CARRIES A BODY. `ORDER BY item.position
// DESC` used to stand in for "book order" here, and it does not mean that: the
// fixture seeder REUSES position keys across different parents, so a plain
// sort by position groups siblings correctly but says nothing about the walk
// across parents. `salvage-cli`'s own recursive walk (`walk`, restated here)
// builds the real book-order key -- the concatenation of every ancestor's
// position down to the row itself -- and that is what `ORDER BY path` sorts
// on. `trashed` carries down the recursion so a scene under the bin is never a
// candidate: the scan's own report never counts a trashed scene either. The
// LAST matching row is what makes the plant prove the scan walks everything
// rather than stopping at the first hit. A scene with only the empty paragraph
// `item_create` writes has no text node to rewrite, so the search walks
// backward from the end and takes the next one that has one.
const plantCandidates = readRows<{ item_id: string; body: string; title: string }>(
  projectPath,
  `WITH RECURSIVE w(id, type, path, trashed, depth) AS (
     SELECT id, type, position,
            CASE WHEN type = 'trash' THEN 1 ELSE 0 END, 0
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.type, w.path || '/' || i.position,
            CASE WHEN i.type = 'trash' OR w.trashed THEN 1 ELSE 0 END, w.depth + 1
       FROM item i JOIN w ON i.parent_id = w.id
      WHERE w.depth + 1 < ${MAX_DEPTH}
   )
   SELECT doc.item_id AS item_id, doc.body AS body, item.title AS title
     FROM w
     JOIN doc ON doc.item_id = w.id
     JOIN item ON item.id = w.id
    WHERE w.type = 'scene' AND w.trashed = 0
    ORDER BY w.path`,
);
let plantItemId: string | null = null;
let originalBody: string | null = null;
let plantTitle: string | null = null;
let plantIndex = -1;
for (let i = plantCandidates.length - 1; i >= 0; i--) {
  const row = plantCandidates[i]!;
  const parsed = JSON.parse(row.body) as unknown;
  if (firstTextNode(parsed) !== null) {
    plantItemId = row.item_id;
    originalBody = row.body;
    plantTitle = row.title;
    plantIndex = i;
    break;
  }
}
if (plantItemId === null || originalBody === null || plantTitle === null) {
  abort(
    `no scene in the seeded ${fixture} fixture carries a body with a text node to rewrite; ` +
      "the cross-identity scan would have nothing to find.",
    cleanup,
  );
}

const secondIdentity = DEMO_VAULT.identities[1]!;
const plantedName = secondIdentity.public.name;
const plantedSortName = secondIdentity.public.sort_name;

// VACUITY GUARD. If either spelling of the second identity is already in the
// fixture's own text, before anything is planted, a "finding" the scan reports
// later would not be attributable to the plant -- it would just be the
// fixture repeating itself, and the rig would have no way to tell the two
// apart.
{
  const needles = [plantedName, plantedSortName];
  const bodyHits = readRows<{ item_id: string; body: string }>(
    projectPath,
    "SELECT item_id, body FROM doc",
  ).filter((row) => needles.some((needle) => row.body.includes(needle)));
  const titleHits = readRows<{ id: string; title: string }>(
    projectPath,
    "SELECT id, title FROM item",
  ).filter((row) => needles.some((needle) => row.title.includes(needle)));
  if (bodyHits.length > 0 || titleHits.length > 0) {
    abort(
      `the seeded ${fixture} fixture already carries "${plantedName}" or "${plantedSortName}" ` +
        `before anything was planted (${bodyHits.length} doc body/bodies, ${titleHits.length} item ` +
        "title(s)); the fixture already carried the name, so a finding here would not be evidence " +
        "of the plant.",
      cleanup,
    );
  }
}

function noJsonMessage(run: Run, subject: string): string {
  return (
    `${subject} wrote no JSON on stdout (exit ${run.exitCode}, signal ${run.signalCode ?? "none"}, ` +
    `panic in stderr: ${run.stderr.includes("panicked at")}). stderr: ${run.stderr}`
  );
}

console.log("[2/4] preflight with no vault at all (not_applicable)");
const noVault = await preflight(projectPath, dataHome);
if (noVault.json === null) {
  abort(noJsonMessage(noVault, "the no-vault run"), cleanup);
}
const noVaultState = checkState(noVault, CHECK_CROSS_IDENTITY);
console.log(`      exit ${noVault.exitCode}, ${CHECK_CROSS_IDENTITY} ${noVaultState}, ok ${noVault.json.ok}`);

console.log("[3/4] planting the vault, pinning to the first identity, and naming the second in the last scene's body");
console.log(
  `      plant site: "${plantTitle}" (scene ${plantIndex + 1} of ${plantCandidates.length} in book order)`,
);
plantDemoIdentities(dataHome, projectPath);
{
  const parsed = JSON.parse(originalBody) as unknown;
  const node = firstTextNode(parsed);
  if (node === null) {
    abort("the plant site's body no longer parses to a text node just before rewriting it.", cleanup);
  }
  node.text = `and then ${plantedName} walked in.`;
  writeRow(projectPath, "UPDATE doc SET body = ?1 WHERE item_id = ?2", [
    JSON.stringify(parsed),
    plantItemId,
  ]);
}

const plantedRuns: Run[] = [];
for (let i = 0; i < PLANTED_RUNS; i++) {
  const run = await preflight(projectPath, dataHome);
  plantedRuns.push(run);
  const state = run.json === null ? "NO JSON" : checkState(run, CHECK_CROSS_IDENTITY);
  console.log(
    `      run ${i + 1}/${PLANTED_RUNS}: exit ${run.exitCode}, ${CHECK_CROSS_IDENTITY} ${state}, ` +
      `${run.wallMs.toFixed(1)} ms, ${run.peakRssMb} MB`,
  );
}
for (const run of plantedRuns) {
  if (run.json === null) {
    abort(noJsonMessage(run, "a planted run"), cleanup);
  }
}

console.log("[4/4] restoring the scene's original body and running once more (clean)");
writeRow(projectPath, "UPDATE doc SET body = ?1 WHERE item_id = ?2", [originalBody, plantItemId]);
const clean = await preflight(projectPath, dataHome);
if (clean.json === null) {
  abort(noJsonMessage(clean, "the clean run"), cleanup);
}
const cleanState = checkState(clean, CHECK_CROSS_IDENTITY);
console.log(`      exit ${clean.exitCode}, ${CHECK_CROSS_IDENTITY} ${cleanState}, ok ${clean.json.ok}`);

const plantedFindingsPerRun = plantedRuns.map((run) =>
  run.json!.findings.filter((f) => f.kind === FINDING_CROSS_IDENTITY),
);

const metrics: PreflightMetrics = {
  fixture,
  vault_absent_exit: noVault.exitCode,
  vault_absent_ok: noVault.json.ok,
  vault_absent_check_state: noVaultState,
  planted_exit_codes: plantedRuns.map((r) => r.exitCode),
  planted_blocker_counts: plantedRuns.map((r) => r.json!.blockers),
  planted_item_id: plantItemId,
  planted_finding_item_ids: plantedFindingsPerRun.map((fs) => fs[0]?.item_id ?? null),
  planted_name: plantedName,
  planted_finding_matches: plantedFindingsPerRun.map((fs) => fs[0]?.matched ?? ""),
  planted_finding_severities: plantedFindingsPerRun.map((fs) => fs[0]?.severity ?? ""),
  planted_finding_surfaces: plantedFindingsPerRun.map((fs) => fs[0]?.surface ?? ""),
  preflight_ms: Number(median(plantedRuns.map((r) => r.wallMs)).toFixed(1)),
  preflight_rss_mb: Math.max(...plantedRuns.map((r) => r.peakRssMb)),
  clean_exit: clean.exitCode,
  clean_check_state: cleanState,
  clean_finding_count: clean.json.findings.filter((f) => f.kind === FINDING_CROSS_IDENTITY).length,
};

const verdicts: GateResult[] = evaluatePreflightGates(metrics);

const path = writeResult(
  buildResult({
    workload: "app-preflight",
    runId: `app-preflight-${fixture}`,
    candidate: "tauri",
    fixture,
    verdicts,
    metrics: {
      workload_script: "preflight-v1",
      preflight: metrics,
      preflight_ms_per_run: plantedRuns.map((r) => Number(r.wallMs.toFixed(1))),
      exit_codes_per_step: {
        vault_absent: noVault.exitCode,
        planted: plantedRuns.map((r) => r.exitCode),
        clean: clean.exitCode,
      },
      planted_item_id: plantItemId,
      omitted_gates: [
        {
          gate: "latency, stall, cliff, a11y_exposure, a11y_tree_structure, startup_ms",
          reason:
            "preflight has NO PAGE SURFACE, salvage-cli's own reason: nothing here opens a " +
            "window, spawns an Xvfb or attaches to AT-SPI.",
        },
      ],
      scope: {
        the_oracle:
          "The rig plants both the vault and the planted name itself, so what the scan must " +
          "report is known exactly. Steps (b) and (d) are the falsifiability check: a build " +
          "that always answered 'blocker' would still pass step (c) alone.",
        the_plant_site:
          "The LAST item of type `scene`, in true book order (a recursive walk's own path key, " +
          "not `item.position` alone), that has a doc row, is not under a `trash` item, and has a " +
          "text node to rewrite. Planting the FIRST scene instead would not prove the scan walks " +
          "the whole manuscript.",
        preflight_ms:
          "Median wall clock of five runs against the planted project, covering the vault " +
          "read, the whole-manuscript walk and the JSON write. A liveness-adjacent bound, not " +
          "a per-body latency figure.",
        preflight_rss_mb:
          "The kernel's own VmHWM, peak over the same five runs, sampled every " +
          `${RSS_POLL_MS} ms.`,
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
if (verdicts.some((v) => v.verdict === "FAIL")) process.exit(1);
