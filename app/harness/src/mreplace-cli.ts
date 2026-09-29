// app/harness/src/mreplace-cli.ts
// Graded manuscript-wide replace. Drives the SHIPPED find panel's third button
// -- Ctrl+F, a term, Edit > Replace..., three Tabs, and the two presses "All in
// book" demands -- and asks whether the manuscript afterwards is the one the
// rig computed, and whether the way back is really there.
//
// THE ORACLE IS THE STORE, read with bun:sqlite and projected to plain text by
// THIS RIG'S OWN restatement of the walk. The expected text of every scene is
// computed by the rig BEFORE anything runs, from the seeded bodies, folding one
// code point at a time the way find.rs does. Nothing here believes the panel's
// account of what it did.
//
// THE REVERSIBILITY GATE IS THE POINT. This operation was refused for a long
// time because it had no inverse; the host takes a named snapshot of every
// document in the same transaction. `mreplace_is_reversible` restores that snapshot
// through the shipped history panel and compares every document, byte for byte,
// against the seed. If that gate ever goes red the feature must be withdrawn,
// not patched.
//
// WALK BUDGET:
//
//   boot 1  delete a scene, then replace throughout   ONE walk (the announced count)
//           ...taken by a client ATTACHED BEFORE the operation: attaching costs
//           ~15 s on the measurement machine and the report it reads lives for 6. See
//           `startProbe`.
//   boot 2  restore the snapshot, whole manuscript    ZERO walks
//
// Usage: APP_GUI=1 bun app/harness/src/mreplace-cli.ts <tiny|stress>
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateManuscriptReplaceGates, type GateResult, type MReplaceMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import { BIN, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";

const TYPE_DELAY_MS = 20;
const PANEL_OPEN_MS = 700;
const SEARCH_SETTLE_MS = 6000;
const ACTION_SETTLE_MS = 900;
/** A manuscript-wide replace snapshots every document and rewrites every match
 *  inside one transaction. At `stress` that is 15,200 of each. */
const REPLACE_SETTLE_MS = 20_000;
/** How long the page is given, after the store has committed, to finish
 *  reloading the open document and announce what it did. Short, because the
 *  announcement it produces lives for six seconds -- see `startProbe`. */
const ANNOUNCE_SETTLE_MS = 700;
const COMMIT_TIMEOUT_MS = 90_000;
const STORE_POLL_MS = 50;
const MAX_DEPTH = 64;

/** A nonce, so "the replacement is in the store afterwards" cannot be satisfied
 *  by text that was already there. Guarded anyway, below. */
const REPLACEMENT = "QZBOOKWORD";

const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
     SELECT id, parent_id, type, title, position, 0, position
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.title, i.position,
            w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ?1
   )
   SELECT id, parent_id, type, title, depth FROM walk ORDER BY path`;

interface WalkRow {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  depth: number;
}

function projectText(body: string): string | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;
  if ((root as { type?: unknown }).type !== "doc") return null;
  let out = "";
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; content?: unknown };
    if (n.type === "text") {
      if (typeof n.text === "string") out += n.text;
      return;
    }
    if (out !== "") out += " ";
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };
  walk(root);
  return out;
}

/** ONE CODE POINT AT A TIME, never `String.prototype.toLowerCase` on a whole
 *  string: JS implements Unicode SpecialCasing (Final_Sigma) and the host folds
 *  per character, so a whole-string fold here would make the rig and the
 *  application disagree about Greek. The recorded find-reveal rule. */
function foldForFind(text: string): string {
  let out = "";
  for (const codePoint of text) out += codePoint.toLowerCase();
  return out;
}

interface Span {
  from: number;
  to: number;
}

function occurrences(text: string, needle: string): Span[] {
  if (needle === "") return [];
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const codePoint of text) {
    const f = foldForFind(codePoint);
    folded += f;
    for (let i = 0; i < f.length; i++) {
      starts.push(offset);
      ends.push(offset + codePoint.length);
    }
    offset += codePoint.length;
  }
  const out: Span[] = [];
  let at = folded.indexOf(needle);
  while (at >= 0) {
    const from = starts[at];
    const to = ends[at + needle.length - 1];
    if (from !== undefined && to !== undefined) out.push({ from, to });
    at = folded.indexOf(needle, at + needle.length);
  }
  return out;
}

function replaceIn(text: string, query: string, replacement: string): string {
  const hits = occurrences(text, query);
  let out = "";
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.from) + replacement;
    cursor = hit.to;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------- store reads

function openDb(path: string): Database {
  return new Database(path, { readonly: true });
}

function readWalk(path: string): WalkRow[] {
  const db = openDb(path);
  try {
    return db.query(WALK_SQL).all(MAX_DEPTH) as WalkRow[];
  } finally {
    db.close();
  }
}

function readBodies(path: string): Map<string, string> {
  const db = openDb(path);
  try {
    const rows = db.query("SELECT item_id, body FROM doc").all() as {
      item_id: string;
      body: string;
    }[];
    return new Map(rows.map((r) => [r.item_id, r.body]));
  } finally {
    db.close();
  }
}

function readTexts(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, body] of readBodies(path)) {
    const text = projectText(body);
    if (text !== null) out.set(id, text);
  }
  return out;
}

interface SnapshotRecord {
  id: number;
  label: string;
  documents: number;
}

function snapshotsIn(path: string): SnapshotRecord[] {
  const db = openDb(path);
  try {
    return db
      .query(
        `SELECT s.id, s.label, COUNT(v.id) AS documents
           FROM snapshot s LEFT JOIN doc_version v ON v.snapshot_id = s.id
          GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC`,
      )
      .all() as SnapshotRecord[];
  } finally {
    db.close();
  }
}

/** Every id under a trash root, by the same rule the host derives it: the walk
 *  is depth-first, so every descendant of a bin follows it. */
function trashedIds(walk: WalkRow[]): Set<string> {
  const out = new Set<string>();
  const roots = new Set(walk.filter((r) => r.type === "trash").map((r) => r.id));
  for (const row of walk) {
    if (roots.has(row.id)) {
      out.add(row.id);
      continue;
    }
    if (row.parent_id !== null && out.has(row.parent_id)) out.add(row.id);
  }
  return out;
}

// ---------------------------------------------------------------- AT-SPI

export const PY_TEXT = String.raw`
import json, sys
try:
    import pyatspi
except Exception:
    sys.stdout.write("ERROR:no-pyatspi\n")
    sys.stdout.flush()
    sys.exit(0)

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

found = {"open-error": None, "find-status": None}

def own_text(node):
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception:
        return ""

def subtree_text(node):
    out = own_text(node) or (node.name or "")
    try:
        for k in range(node.childCount):
            out += subtree_text(node.getChildAtIndex(k))
    except Exception:
        pass
    return out

def walk(node):
    try:
        i = ident(node)
        if i in found and found[i] is None:
            found[i] = subtree_text(node) or (node.name or "")
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

# RESOLVED NOW, WALKED LATER. get_process_id() is answered by the bus daemon
# rather than the application, so this pays no per-registrant timeout -- see
# the rig's note on the pre-warm below, which the pid selector does not remove:
# the resolution below is still paid before the run needs an answer, and is
# now cheap rather than merely early.
${PY_SELECT_APPS}
if len(matched) != 1:
    sys.stdout.write("ERROR:not-one-app:%d\n" % len(matched))
    sys.stdout.flush()
    sys.exit(0)
root = matched[0]
sys.stdout.write("READY\n")
sys.stdout.flush()
sys.stdin.readline()
walk(root)
sys.stdout.write(json.dumps(found) + "\n")
sys.stdout.flush()
`;

interface Seen {
  "open-error": string | null;
  "find-status": string | null;
}

/** The ONE walk of this run, spawned EARLY and read LATE.
 *
 *  THE REPORT IS ANNOUNCED IN A BANNER THAT TAKES ITSELF AWAY after
 *  INFO_BANNER_MS (6,000) -- `project.ts` raises good news with tone `info` and
 *  removes it on a timer, deliberately, because a success message with no way
 *  out is the defect that surface was split to fix. Resolving the target
 *  application USED TO cost FIFTEEN SECONDS on the measurement machine: one client on the
 *  operator's session bus blocked for ~15 s reading `.name` off every
 *  registrant to find the one matching by name, and every rig here paid it
 *  before it read anything. Measured, not assumed: a probe spawned after the
 *  replace read `find-status` at t+15.03 s and the walk itself at t+15.04, so
 *  the whole cost was the enumeration and the banner had been gone for nine
 *  seconds. The first version of this rig therefore reported `the panel never
 *  announced a count` about an announcement that was correct, on screen and
 *  photographed. `get_process_id()` (073) answers from the bus daemon rather
 *  than the application and costs nothing per registrant, but the early spawn
 *  below is unchanged: it is still the one AT-SPI client this window takes.
 *
 *  So the probe is spawned BEFORE the confirming press and waits on stdin. It
 *  is one AT-SPI client taking one walk; what moved is when the connection is
 *  made, not how much of the tree is read. */
async function startProbe(rootPid: number): Promise<{ walk: () => Promise<Seen> }> {
  const proc = Bun.spawn(["python3", "-c", PY_TEXT, pidListArg(rootPid)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const readLine = async (): Promise<string> => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        const alive = survivingShellPids();
        throw new Error(
          "the accessibility probe exited without answering; " +
            `${alive.length > 0 ? "the app is off the AT-SPI bus" : "THE APP IS GONE"}`,
        );
      }
      buffered += decoder.decode(value, { stream: true });
    }
    const at = buffered.indexOf("\n");
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return line;
  };
  const ready = await readLine();
  if (ready !== "READY") throw new Error(`could not attach to the accessibility tree: ${ready}`);
  return {
    walk: async (): Promise<Seen> => {
      proc.stdin.write("go\n");
      proc.stdin.flush();
      return JSON.parse(await readLine()) as Seen;
    },
  };
}



/** Restated from find-bar.ts's `bookReport`. */
const REPLACED_PATTERN = /Replaced ([\d,]+) occurrences? in ([\d,]+) documents?/u;

function parseReport(...texts: (string | null)[]): { replaced: number; documents: number } | null {
  for (const text of texts) {
    if (text === null) continue;
    const m = text.match(REPLACED_PATTERN);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      return {
        replaced: Number(m[1].replaceAll(",", "")),
        documents: Number(m[2].replaceAll(",", "")),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- driving

function xdo(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

// ---------------------------------------------------------------- setup

const fixtureName = process.argv[2] ?? "tiny";
if (fixtureName !== "tiny" && fixtureName !== "stress") {
  console.error("usage: APP_GUI=1 bun app/harness/src/mreplace-cli.ts <tiny|stress>");
  process.exit(1);
}
const FIXTURE = `lab/fixtures/out/${fixtureName}`;

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; manuscript-replace run skipped.");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — build the shell and the UI, and generate the fixture.`);
    process.exit(1);
  }
}
{
  const survivors = survivingShellPids();
  if (survivors.length > 0) {
    console.error(`${survivors.length} shell process(es) already running.`);
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "app-mreplace-"));
const cleanup = (): void => {
  rmSync(workDir, { recursive: true, force: true });
};
function abort(reason: string): never {
  console.error(`ABORTED, nothing written: ${reason}`);
  cleanup();
  process.exit(1);
}

const projectPath = join(workDir, "book.db");
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`);
}

console.log(`[1/5] seeded from ${FIXTURE}; computing the expected manuscript`);
const seedWalk = readWalk(projectPath);
const SEED_BODIES = readBodies(projectPath);
const seedTexts = readTexts(projectPath);
if (seedWalk.length === 0) abort("VACUITY GUARD: the seeded project has no items.");

const scenes = seedWalk.filter((r) => r.type === "scene" && (seedTexts.get(r.id) ?? "") !== "");
if (scenes.length < 3) {
  abort("VACUITY GUARD: fewer than three scenes with prose; the trash gate needs a spare.");
}

/** A single ASCII word, chosen from the fixture's own frequencies. SINGLE, so
 *  it cannot span a block boundary: the spanning REFUSAL is unit-tested with a
 *  fixture only the correct implementation satisfies, and what this run can
 *  honestly grade is that neither side INVENTS a refusal. */
const words = new Map<string, number>();
for (const scene of scenes) {
  const seen = new Set<string>();
  for (const word of foldForFind(seedTexts.get(scene.id) ?? "").split(/[^a-z]+/u)) {
    if (word.length >= 4 && word.length <= 14) seen.add(word);
  }
  for (const word of seen) words.set(word, (words.get(word) ?? 0) + 1);
}
const ALL_TITLES = seedWalk.map((r) => foldForFind(r.title)).join("   ");
const candidates = [...words.entries()]
  .filter(([word, sceneCount]) => sceneCount >= 3 && !ALL_TITLES.includes(word))
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const chosen = candidates[0];
if (chosen === undefined) {
  abort(
    "VACUITY GUARD: no ASCII word of 4+ characters occurs in three or more scenes and in no " +
      "item title. Without one, the trash gate has no scene to spare and the replace is not a " +
      "manuscript-wide operation at all.",
  );
}
const QUERY = chosen[0];

for (const [, text] of seedTexts) {
  if (occurrences(text, foldForFind(REPLACEMENT)).length > 0) {
    abort(`VACUITY GUARD: "${REPLACEMENT}" already occurs in the seeded manuscript.`);
  }
}

/** The scenes that hold the term, in book order. The LAST one is deleted before
 *  the replace, so the trash gate has a subject that would otherwise change. */
const holders = scenes.filter((s) => occurrences(seedTexts.get(s.id) ?? "", QUERY).length > 0);
const doomed = holders.at(-1);
if (doomed === undefined || holders.length < 3) {
  abort("VACUITY GUARD: fewer than three scenes hold the chosen term.");
}
const survivors = holders.filter((s) => s.id !== doomed.id);

/** What every live document should hold afterwards, computed by the RIG. */
const EXPECTED = new Map<string, string>();
let expectedReplacements = 0;
for (const scene of survivors) {
  const text = seedTexts.get(scene.id) ?? "";
  EXPECTED.set(scene.id, replaceIn(text, QUERY, REPLACEMENT));
  expectedReplacements += occurrences(text, QUERY).length;
}
if (expectedReplacements === 0) abort("internal: the expected replacement count is zero.");

console.log(
  `  ${seedWalk.length} items, ${SEED_BODIES.size} documents\n` +
    `  term "${QUERY}" -> ${holders.length} scene(s), ${expectedReplacements} occurrence(s) ` +
    `outside the bin\n` +
    `  doomed scene = ${doomed.id} ("${doomed.title}"), deleted before the replace`,
);

const observed = {
  reported: null as { replaced: number; documents: number } | null,
  liveMatchesOracle: false,
  liveMismatch: null as string | null,
  doomedUntouched: false,
  snapshotLabel: null as string | null,
  snapshotDocuments: 0,
  snapshotCount: 0,
  reversible: false,
  reversibleMismatch: null as string | null,
  peakRssMb: 0,
};

async function waitFor(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + COMMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(STORE_POLL_MS);
  }
  return false;
}

async function boot(
  drive: (ctx: { display: string; wid: string; rootPid: number }) => Promise<void>,
): Promise<void> {
  const run = await runShell<{ ready: boolean; startup_ms: number }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", APP_PROJECT: projectPath, GDK_BACKEND: "x11" },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("this rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(`refusing to type: focus is ${focused}, not ${wid}`);
      }
      await drive({ display, wid, rootPid });
    },
  });
  observed.peakRssMb = Math.max(observed.peakRssMb, run.peakRssMb);
}

// -- boot 1: delete a scene, then replace throughout -------------------------
console.log("[2/5] boot 1: delete one scene, then replace throughout the manuscript");
await boot(async ({ display, wid, rootPid }) => {
  const menu = menuDriver(display, wid, xdo);
  // Quick open selects AND opens by title, so the delete that follows acts on a
  // row the rig named rather than on an index it computed -- and it costs no
  // AT-SPI walk, unlike locating the row's box.
  await menu.activate("menu-go-to");
  await Bun.sleep(PANEL_OPEN_MS);
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), doomed.title]);
  await Bun.sleep(600);
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(ACTION_SETTLE_MS);
  await menu.activate("menu-remove");
  await Bun.sleep(ACTION_SETTLE_MS);
  const binned = await waitFor(() => trashedIds(readWalk(projectPath)).has(doomed.id));
  if (!binned) throw new Error(`the doomed scene ${doomed.id} never reached the bin`);

  xdo(display, ["key", "--window", wid, "ctrl+f"]);
  await Bun.sleep(PANEL_OPEN_MS);
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), QUERY]);
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(SEARCH_SETTLE_MS);

  // Edit > Replace... lands the caret in the REPLACE field. Three Tabs then
  // reach "All in book", in the order find-bar.ts appends the buttons.
  await menu.activate("menu-replace");
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), REPLACEMENT]);
  await Bun.sleep(300);
  for (let i = 0; i < 3; i++) {
    xdo(display, ["key", "--window", wid, "Tab"]);
    await Bun.sleep(150);
  }
  // ONE press arms; the SECOND confirms.
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(ACTION_SETTLE_MS);
  const early = readTexts(projectPath);
  const firstSurvivor = survivors[0];
  if (firstSurvivor !== undefined && early.get(firstSurvivor.id) !== seedTexts.get(firstSurvivor.id)) {
    throw new Error("the FIRST press replaced: the confirming second press is not there");
  }
  // ATTACHED BEFORE THE OPERATION, read after it. The connection is what costs
  // the time, and the report it has to read lives for six seconds.
  const probe = await startProbe(rootPid);
  xdo(display, ["key", "--window", wid, "Return"]);
  const landed = await waitFor(() => {
    const now = readTexts(projectPath);
    return survivors.every((s) => now.get(s.id) === EXPECTED.get(s.id));
  });
  if (!landed) {
    // Not fatal: the gates below report exactly which document diverged, which
    // is more use than an abort that says only "it did not happen". Given the
    // whole settle, since something is evidently still in flight.
    await Bun.sleep(REPLACE_SETTLE_MS);
    console.error("  note: the manuscript did not reach the expected text before the deadline");
  }
  // The store commits before the page hears about it: `replaceEverywhere`
  // reloads the open document before it resolves, and only then is the report
  // announced. This waits for THAT, not for the transaction, which the poll
  // above has already seen.
  await Bun.sleep(ANNOUNCE_SETTLE_MS);
  // THE ONE WALK.
  const seen = await probe.walk();
  observed.reported = parseReport(seen["open-error"], seen["find-status"]);
  await Bun.sleep(ACTION_SETTLE_MS);
});

// -- what the store holds now ------------------------------------------------
console.log("[3/5] reading the manuscript back");
{
  const after = readTexts(projectPath);
  observed.liveMatchesOracle = true;
  for (const scene of survivors) {
    if (after.get(scene.id) !== EXPECTED.get(scene.id)) {
      observed.liveMatchesOracle = false;
      observed.liveMismatch = scene.id;
      break;
    }
  }
  observed.doomedUntouched =
    occurrences(after.get(doomed.id) ?? "", QUERY).length ===
    occurrences(seedTexts.get(doomed.id) ?? "", QUERY).length;
  const snaps = snapshotsIn(projectPath);
  observed.snapshotCount = snaps.length;
  observed.snapshotLabel = snaps[0]?.label ?? null;
  observed.snapshotDocuments = snaps[0]?.documents ?? 0;
  if (snaps.length === 0) {
    abort(
      "VACUITY GUARD: no snapshot exists at all, so the reversibility gate -- the whole safety " +
        "argument of this slice -- would have nothing to restore.",
    );
  }
}

// -- boot 2: restore the snapshot, and compare every document ----------------
console.log("[4/5] boot 2: restore the snapshot through the shipped history panel");
await boot(async ({ display, wid }) => {
  const menu = menuDriver(display, wid, xdo);
  await menu.activate("menu-history");
  await Bun.sleep(PANEL_OPEN_MS);
  // Focus opens on #snapshot-name; Tab twice reaches the first snapshot row.
  xdo(display, ["key", "--window", wid, "Tab"]);
  await Bun.sleep(200);
  xdo(display, ["key", "--window", wid, "Tab"]);
  await Bun.sleep(200);
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(ACTION_SETTLE_MS);
  xdo(display, ["key", "--window", wid, "Return"]);
  await waitFor(() => {
    const now = readBodies(projectPath);
    return survivors.every((s) => now.get(s.id) === SEED_BODIES.get(s.id));
  });
  await Bun.sleep(REPLACE_SETTLE_MS);
});

console.log("[5/5] comparing the restored manuscript against the seed");
{
  const restored = readBodies(projectPath);
  observed.reversible = true;
  for (const [id, body] of SEED_BODIES) {
    if (restored.get(id) !== body) {
      observed.reversible = false;
      observed.reversibleMismatch = id;
      break;
    }
  }
}

// ---------------------------------------------------------------- verdicts

const metrics: MReplaceMetrics = {
  fixture: fixtureName,
  documents: SEED_BODIES.size,
  query: QUERY,
  replacement: REPLACEMENT,
  scenes_holding_the_term: holders.length,
  expected_replacements: expectedReplacements,
  expected_documents: survivors.length,
  reported_replacements: observed.reported?.replaced ?? null,
  reported_documents: observed.reported?.documents ?? null,
  live_matches_oracle: observed.liveMatchesOracle,
  live_mismatch: observed.liveMismatch,
  doomed_item: doomed.id,
  doomed_untouched: observed.doomedUntouched,
  snapshot_count: observed.snapshotCount,
  snapshot_label: observed.snapshotLabel,
  snapshot_documents: observed.snapshotDocuments,
  expected_snapshot_label: `Before replacing "${QUERY}" with "${REPLACEMENT}"`,
  reversible: observed.reversible,
  reversible_mismatch: observed.reversibleMismatch,
  peak_rss_mb: observed.peakRssMb,
  omitted_gates:
    "typing_p95_ms, typing_stall_rate, cliff_ratio and a11y_exposure are not evaluated: this run " +
    "types one term and one replacement and spends its wall clock inside two transactions, so it " +
    "has nothing true to say about frame cadence. The SPANNING refusal is not graded here " +
    "either: the term is a single word by construction, so it cannot span a block, and the " +
    "refusal is unit-tested with a fixture only the correct implementation satisfies.",
};

const verdicts: GateResult[] = evaluateManuscriptReplaceGates(metrics);

const result = buildResult({
  runId: `app-mreplace-${fixtureName}`,
  candidate: "tauri",
  fixture: fixtureName,
  workload: "app-mreplace",
  verdicts,
  metrics: metrics as unknown as Record<string, unknown>,
  seed: "mreplace-v1",
  rigCommit: gitShortSha(),
  environment: captureEnv(),
});
const written = writeResult(result, RESULTS);
cleanup();

for (const v of verdicts) {
  console.log(`${v.verdict.padEnd(8)} ${v.gate}  ${String(v.value)}`);
}
console.log(`\nwrote ${written}`);
process.exit(verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0);
