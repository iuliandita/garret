// app/harness/src/find-cli.ts
// Graded manuscript-search run. Types a nonce sentence into the open scene,
// drains it, then drives the SHIPPED find panel with real keystrokes -- Ctrl+F,
// a query, Return -- and asks whether what the panel says agrees with what the
// store holds.
//
// THE ORACLE IS THE STORE, read directly with bun:sqlite and projected to plain
// text by THIS RIG'S OWN restatement of the walk (`projectText` below), never
// imported from find.rs or store/mod.rs. A rig that asked the application
// whether it had found everything would be checking the application against
// itself, and `find_total_matches_oracle` -- the only gate here that grades
// COMPLETENESS -- would grade a tautology.
//
// Completeness is the property that matters and the one a writer cannot check.
// A search that silently misses a scene is indistinguishable, from the outside,
// from a scene that does not contain the word.
//
// Every child process is spawned as an argv ARRAY through Bun.spawnSync. No
// shell is involved anywhere in this file, so no query term, title or fixture
// path can be interpreted as a command.
//
// Usage: APP_GUI=1 bun app/harness/src/find-cli.ts <tiny|stress>
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateFindGates, type FindMetrics, type GateResult } from "./gates";
import { buildResult, writeResult } from "./results";
import { BIN, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";

/** The cap app/ui/src/find-bar.ts asks the host for. Restated, like every other
 *  constant this harness shares with the application: two programs. */
const FIND_LIMIT = 200;

/** xdotool type returns when X has the key events, not when WebKitGTK has
 *  turned them into document state. hand-cli.ts found 500 ms silently
 *  truncating typed text; 2500 ms is what held. */
const SETTLE_MS = 2500;
const TYPE_DELAY_MS = 20;
/** Between two full AT-SPI walks. Repeated pyatspi clients a few hundred
 *  milliseconds apart wedge the WebKitGTK bridge: the app leaves the desktop
 *  list and does not come back, and one probe run once hung 300 s. */
const PROBE_SPACING_MS = 2500;
/** How long a search is given to finish before the single probe reads it.
 *
 *  A fixed settle, because polling is not available here: see `search` below.
 *  Generous enough for a stress scan and the drain in front of it; a search
 *  that had not finished would leave #find-status reading "Searching...",
 *  which parseStatus does not accept, so the run reports UNKNOWN rather than a
 *  wrong number. */
const SEARCH_SETTLE_MS = 6000;
/** How long a store write may take to appear before the rig calls it lost. */
const COMMIT_TIMEOUT_MS = 15_000;
const STORE_POLL_MS = 5;

/** store/mod.rs MAX_DEPTH. Without it the CTE recurses forever on a parent_id
 *  cycle where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;

/** Typed into the scene the page opens at boot, then searched for.
 *
 *  A NONCE, so the expected hit count is exactly 1 rather than a lower bound.
 *  The searched fragment carries no space: everything else is typed into the
 *  editor, but this one is typed into the find field, and if anything has gone
 *  wrong with focus a space in the navigator is ACTIVATION rather than
 *  type-ahead. Without spaces a misplaced focus types into nothing, which is
 *  the failure it should be. */
const NONCE_SENTENCE = "The archivist filed crate ZZQXVNONCE before dusk.";
const NONCE_TOKEN = "ZZQXVNONCE";

const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
     SELECT id, parent_id, type, title, position, 0, position
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.title, i.position,
            w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ?1
   )
   SELECT id, type, title, depth FROM walk ORDER BY path`;

interface WalkRow {
  id: string;
  type: string;
  title: string;
  depth: number;
}

/** THE RIG'S OWN plain-text projection of a stored ProseMirror body.
 *
 *  Restated from the format, deliberately, and not imported from
 *  `store::document_text`. It is the same rule -- text nodes concatenated with
 *  nothing between them, a separator before each block node's content -- but
 *  restating it is what makes the oracle independent. A projection taken from
 *  the implementation would agree with the implementation by construction, and
 *  `find_total_matches_oracle` would say nothing at all.
 *
 *  Returns null for a body that is not a document, which is what the store
 *  counts as `skipped`. */
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
    // Every non-text node in the page's schema is a block, so its content
    // begins a new run: ONE separator before the node's content, and none
    // between its children -- a mark boundary splits one word across several
    // text nodes, and separating those would turn "bewitched" into two words.
    //
    // The `out.length > 0` guard matters: without it the projection starts with
    // a leading space the store's text does not have.
    //
    // The first version of this restatement emitted a separator before EVERY
    // CHILD instead, doubling every block separator. `find_total_matches_oracle`
    // could not see it -- single-word containment does not care how many spaces
    // sit between paragraphs -- and it PASSED at 14,048 == 14,048 while the
    // projection was wrong. `find_snippet_fidelity` caught it, at `stress`
    // only, as 12 of 184 snippets: exactly the ones spanning a paragraph
    // boundary. THE DEFECT WAS THE RIG'S, not the application's.
    if (out.length > 0) out += " ";
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  };
  walk(root);
  return out;
}

interface Corpus {
  walk: WalkRow[];
  /** item id -> projected prose. Absent for an item with no readable document. */
  texts: Map<string, string>;
}

function readCorpus(projectPath: string): Corpus {
  const db = new Database(projectPath, { readonly: true });
  try {
    const walk = db.query(WALK_SQL).all(MAX_DEPTH) as WalkRow[];
    const texts = new Map<string, string>();
    const rows = db.query("SELECT item_id, body FROM doc").all() as {
      item_id: string;
      body: string;
    }[];
    for (const row of rows) {
      const text = projectText(row.body);
      if (text !== null) texts.set(row.item_id, text);
    }
    return { walk, texts };
  } finally {
    db.close();
  }
}

/** The rig's own answer: which items contain `term`, case-insensitively, in
 *  their title or their prose. The oracle for find_total_matches_oracle.
 *
 *  Folding is `toLowerCase()` on both sides, which is NOT the per-character
 *  folding find.rs uses. The two differ only where `str::to_lowercase` is
 *  context-dependent -- Greek final sigma -- and neither fixture contains
 *  Greek. Every term this rig chooses is drawn from the fixture, so it cannot
 *  select one that would expose the difference; if a future fixture adds Greek,
 *  this is where the oracle and the application would disagree, and the gate
 *  would FAIL loudly rather than quietly. */
function oracleMatches(corpus: Corpus, term: string): WalkRow[] {
  const needle = term.toLowerCase();
  return corpus.walk.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) ||
      (corpus.texts.get(item.id)?.toLowerCase().includes(needle) ?? false),
  );
}

// ---------------------------------------------------------------- AT-SPI

/** Full walk: every find result row, with the DOM id that identifies it. */
export const PY_ROWS = String.raw`
import json, sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

rows = []
status = {"text": None}
# What the writer would see highlighted in the editor. Read in the SAME walk as
# the rows, because several walks in one window kill this application -- see the
# comment on runQuery. AT-SPI's own text selection, not the X PRIMARY selection:
# PRIMARY silently returns the PREVIOUS selection when a chord selects nothing,
# which reads as success.
selection = {"text": None}

def selected_text(node):
    try:
        text = node.queryText()
    except Exception:
        return None
    try:
        if text.getNSelections() < 1:
            return None
        start, end = text.getSelection(0)
    except Exception:
        return None
    if end <= start:
        return None
    try:
        return text.getText(start, end)
    except Exception:
        return None

def walk(node):
    try:
        i = ident(node)
        if i == "find-status" and status["text"] is None:
            try:
                status["text"] = node.queryText().getText(0, -1)
            except Exception:
                status["text"] = ""
        if i.startswith("find-row-"):
            rows.append({"id": i[len("find-row-"):], "name": node.name or ""})
        if selection["text"] is None:
            got = selected_text(node)
            # A zero-length selection is a caret, not a selection, and
            # selected_text already returns None for it. Anything non-empty is
            # a real highlighted run.
            if got:
                selection["text"] = got
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps({
    "rows": rows,
    "status": status["text"],
    "selection": selection["text"],
}))
`;

interface ProbeRow {
  id: string;
  name: string;
}

interface Probe {
  rows: ProbeRow[];
  status: string | null;
  /** The text the editor shows selected, or null when nothing is. */
  selection: string | null;
}

function probeRows(rootPid: number): Probe {
  const proc = Bun.spawnSync(["python3", "-c", PY_ROWS, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    // Exit 4 is "not exactly one matching application", which has two very
    // different causes: the WebKitGTK bridge wedged (the app is alive but has
    // left the desktop list) or the app DIED. Distinguishing them matters --
    // one is a rig problem and the other is a defect in the thing under test --
    // and the process table answers it directly.
    const alive = survivingShellPids();
    throw new Error(
      `could not read the accessibility tree (exit ${proc.exitCode}); ` +
        `${alive.length} shell process(es) alive (${alive.join(", ") || "none"}) — ` +
        `${alive.length > 0 ? "the app is running but off the AT-SPI bus" : "THE APP IS GONE"}` +
        `: ${proc.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(proc.stdout.toString()) as Probe;
}

/** The summary line's three shapes, restated from find-bar.ts. `total` is the
 *  TRUE count in every one of them -- the capped shape reports both figures
 *  precisely so a reader is never shown a partial list as a complete one. */
const STATUS_DONE = [
  /^(?<total>[\d,]+) results? for "/u,
  /^Showing (?<shown>[\d,]+) of (?<total>[\d,]+) results for "/u,
  /^No matches for "/u,
];

interface Summary {
  total: number;
  shown: number | null;
  truncated: boolean;
}

function parseStatus(text: string | null): Summary | null {
  if (text === null) return null;
  for (const pattern of STATUS_DONE) {
    const m = text.match(pattern);
    if (m === null) continue;
    const total = m.groups?.total;
    const shown = m.groups?.shown;
    // "No matches" carries no figures; zero is the honest reading of it.
    if (total === undefined) return { total: 0, shown: 0, truncated: false };
    return {
      total: Number(total.replaceAll(",", "")),
      shown: shown === undefined ? null : Number(shown.replaceAll(",", "")),
      truncated: shown !== undefined,
    };
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

function abort(reason: string, cleanup: () => void): never {
  console.error(`ABORTED, nothing written: ${reason}`);
  cleanup();
  process.exit(1);
}

/** A casing that is neither all-lower nor all-upper, so the three variants the
 *  casing gate compares are genuinely three. */
function toMixedCase(term: string): string {
  return [...term].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join("");
}

// ---------------------------------------------------------------- main

const fixtureName = process.argv[2];
if (fixtureName !== "tiny" && fixtureName !== "stress") {
  console.error("usage: APP_GUI=1 bun app/harness/src/find-cli.ts <tiny|stress>");
  process.exit(1);
}
const FIXTURE = `lab/fixtures/out/${fixtureName}`;

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; find run skipped (needs a display and a built shell).");
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
    console.error(
      `${survivors.length} shell process(es) already running (${survivors.join(", ")}). ` +
        "The AT-SPI probe refuses any dump it cannot attribute to exactly one window.",
    );
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "app-find-"));
const projectPath = join(workDir, "project.db");
const cleanup = (): void => {
  rmSync(workDir, { recursive: true, force: true });
};

console.log(`[1/4] seeding project from ${FIXTURE}`);
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) {
    console.error(`seeding failed (exit ${seeded.exitCode}); nothing was written.`);
    cleanup();
    process.exit(1);
  }
}

console.log("[2/4] reading the store as the rig's own oracle");
const corpus = readCorpus(projectPath);
if (corpus.walk.length === 0) {
  abort(
    "VACUITY GUARD: the seeded project has no items, so every gate would compare 0 to 0.",
    cleanup,
  );
}
const firstScene = corpus.walk.find((r) => r.type === "scene");
if (firstScene === undefined) {
  abort("the fixture has no scene: there is nothing to open or type into.", cleanup);
}
/** The scene the page opens at boot: project.ts takes the first scene of the
 *  depth-first walk. Bound to its own const so the narrowing above survives
 *  into the closures below -- a hoisted function declaration does not inherit
 *  the guard's flow analysis, and `bootScene!` would assert rather than check. */
const bootScene: WalkRow = firstScene;

/** How many ITEMS each lowercase word occurs in, across titles and prose. The
 *  rig picks its own query terms from this rather than hard-coding words,
 *  because a term hard-coded against one fixture silently matches nothing in
 *  another and every gate then reports UNKNOWN. */
const itemsPerWord = new Map<string, number>();
for (const item of corpus.walk) {
  const seen = new Set<string>();
  const haystack = `${item.title} ${corpus.texts.get(item.id) ?? ""}`.toLowerCase();
  for (const word of haystack.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 4) seen.add(word);
  }
  for (const word of seen) itemsPerWord.set(word, (itemsPerWord.get(word) ?? 0) + 1);
}
const byFrequency = [...itemsPerWord.entries()].sort(
  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
);

/** A term matching several items but not so many that the panel caps -- the row
 *  list is what the snippet and casing gates read. Falls back to the most
 *  frequent term the fixture has. */
const oracleEntry =
  byFrequency.find(([, count]) => count >= 2 && count <= FIND_LIMIT) ?? byFrequency[0];
if (oracleEntry === undefined) {
  abort("VACUITY GUARD: no word of 4+ characters occurs anywhere in the fixture.", cleanup);
}
const ORACLE_TERM = oracleEntry[0];
const oracleExpected = oracleMatches(corpus, ORACLE_TERM);
if (oracleExpected.length === 0) {
  abort(
    `VACUITY GUARD: the rig's own scan finds 0 items containing "${ORACLE_TERM}", so ` +
      "find_total_matches_oracle would PASS on 0 == 0 against a search that returns nothing " +
      "for every term.",
    cleanup,
  );
}

/** A part or a chapter wherever the fixture has one: those hold no document at
 *  all, so they can only be found by title, and restricting search to prose
 *  would silently exclude every one of them. */
const titleItem =
  corpus.walk.find((r) => r.type === "part" || r.type === "chapter") ?? corpus.walk[0]!;
const TITLE_TERM = titleItem.title;

/** The most frequent term, used only if it out-matches the cap. At `tiny` it
 *  will not, and the truncation gate then reports UNKNOWN rather than PASS. */
const truncationEntry = byFrequency[0];
const truncationExpected =
  truncationEntry === undefined ? 0 : oracleMatches(corpus, truncationEntry[0]).length;
const TRUNCATION_TERM = truncationExpected > FIND_LIMIT ? truncationEntry![0] : null;

console.log(
  `  ${corpus.walk.length} items, ${corpus.texts.size} readable documents\n` +
    `  boot scene = ${bootScene.id}\n` +
    `  oracle term "${ORACLE_TERM}" -> ${oracleExpected.length} item(s)\n` +
    `  title term "${TITLE_TERM}" (${titleItem.type})\n` +
    `  truncation term ${
      TRUNCATION_TERM === null
        ? "none (fixture cannot out-match the cap)"
        : `"${TRUNCATION_TERM}" -> ${truncationExpected}`
    }`,
);

/** What the live phase observed. A mutable record rather than a handful of
 *  `let`s: a local assigned only inside a closure is narrowed to its initial
 *  type for the rest of the file, so `if (x === null) abort()` compiles happily
 *  and asserts nothing. */
const observed = {
  typedHits: 0,
  typedItem: null as string | null,
  reportedTotal: null as number | null,
  caseAgree: false,
  caseHits: 0,
  snippetsChecked: 0,
  snippetsContained: 0,
  titleHits: 0,
  titleFound: false,
  truncationTotal: null as number | null,
  truncationShown: null as number | null,
  truncationReported: null as boolean | null,
  emptyHits: null as number | null,
  /** What the editor showed selected after a result was activated. */
  revealSelection: null as string | null,
  sentenceReachedStore: false,
  /** The highest peak across every boot: each query gets its own window, so a
   *  single run's memory figure is the worst of them, not the last. */
  peakRssMb: 0,
  ready: false,
  startupMs: 0,
};

function storeBodyOf(itemId: string): string {
  const db = new Database(projectPath, { readonly: true });
  try {
    const row = db.query("SELECT body FROM doc WHERE item_id = ?1").get(itemId) as
      | { body: string }
      | null;
    return row?.body ?? "";
  } finally {
    db.close();
  }
}

console.log("[3/4] booting the shell once per query and driving the shipped panel");

/** ONE BOOT PER QUERY, and that is a measured requirement rather than caution.
 *
 *  The first version of this rig kept one window open and searched several
 *  times, walking the accessibility tree after each. The application DIED --
 *  cleanly, with no panic, no core dump and nothing on its stderr -- somewhere
 *  between the third and the fifth search, and the Xvfb server went with it, so
 *  the next xdotool call reported "Failed creating new xdo instance". A single
 *  search followed by a single walk is stable; several are not, and where the
 *  boundary sits moved when the rig's own timing changed.
 *
 *  That matches the recorded WebKitGTK/AT-SPI fragility (repeated pyatspi
 *  clients wedge the bridge) in a more severe form than was recorded: the app
 *  does not merely leave the desktop list, it exits. A dead webview process
 *  takes the window with it and a Tauri app with no windows exits, which is
 *  exactly the clean, silent exit observed.
 *
 *  Booting per query costs about ten seconds each and buys two things: the run
 *  finishes, and no measurement can be contaminated by a previous query's
 *  state. The nonce is typed in the FIRST boot only -- it is flushed to the
 *  store, so every later boot searches a file that already contains it. */
interface QueryOutcome {
  summary: Summary | null;
  rows: ProbeRow[];
  /** What the editor showed selected at the moment of the walk. */
  selection: string | null;
  peakRssMb: number;
  ready: boolean;
  startupMs: number;
}

async function runQuery(
  query: string,
  typeNonce: boolean,
  /** Arrow onto the first result and press Return before the walk, so the walk
   *  reads the selection the reveal left in the editor. Keystrokes only, which
   *  is what keeps this at ONE walk per boot: clicking a row would need widget
   *  geometry, and geometry is a second walk. */
  activateFirst = false,
): Promise<QueryOutcome> {
  const outcome = {
    summary: null as Summary | null,
    rows: [] as ProbeRow[],
    selection: null as string | null,
  };
  const run = await runShell<{ ready: boolean; error?: string; rows: number; startup_ms: number }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      GDK_BACKEND: "x11",
    },
    // The shell's own periodic prober would add walks this rig did not ask for,
    // and walks are exactly what the app does not survive many of.
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("the find rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);

      // windowfocus / getwindowfocus, never windowactivate / getactivewindow:
      // the developer's XWayland does not answer EWMH active-window queries, and
      // typing into whatever happens to be focused once put test sentences into
      // the operator's live terminal.
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(
          `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`,
        );
      }

      if (typeNonce) {
        xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), NONCE_SENTENCE]);
        await Bun.sleep(SETTLE_MS);
      }

      xdo(display, ["key", "--window", wid, "ctrl+f"]);
      await Bun.sleep(400);
      if (query === "") {
        // The field is selected by Ctrl+F, so one BackSpace empties it.
        xdo(display, ["key", "--window", wid, "BackSpace"]);
      } else {
        xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), query]);
      }
      xdo(display, ["key", "--window", wid, "Return"]);
      await Bun.sleep(SEARCH_SETTLE_MS);

      if (activateFirst) {
        // ArrowDown then Return: the shipped keyboard path, and the only one
        // there is until a writer reaches for the mouse. Return alone would
        // re-run the search, which is the fallback when nothing is highlighted.
        xdo(display, ["key", "--window", wid, "Down"]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", wid, "Return"]);
        // The open is a round trip to the store before the reveal can run.
        await Bun.sleep(SETTLE_MS);
      }

      // THE ONLY WALK THIS BOOT PERFORMS.
      const probe = probeRows(rootPid);
      outcome.summary = parseStatus(probe.status);
      outcome.rows = probe.rows;
      outcome.selection = probe.selection;

      if (typeNonce) {
        // BY EFFECT, and only after the search has drained the page: if this
        // sentence is not in the store, a search that failed to find it would
        // be indistinguishable from a keystroke that never landed.
        const deadline = Date.now() + COMMIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (storeBodyOf(bootScene.id).includes(NONCE_TOKEN)) {
            observed.sentenceReachedStore = true;
            break;
          }
          await Bun.sleep(STORE_POLL_MS);
        }
      }
    },
  });
  return {
    summary: outcome.summary,
    rows: outcome.rows,
    selection: outcome.selection,
    peakRssMb: run.peakRssMb,
    ready: run.payload.ready === true,
    startupMs: run.payload.startup_ms,
  };
}

// -- 1. the nonce, typed in this boot and persisted for every later one -----
const nonce = await runQuery(NONCE_TOKEN, true);
observed.typedHits = nonce.rows.length;
observed.typedItem = nonce.rows[0]?.id ?? null;
observed.peakRssMb = nonce.peakRssMb;
observed.ready = nonce.ready;
observed.startupMs = nonce.startupMs;
console.log(
  `  nonce "${NONCE_TOKEN}": ${nonce.rows.length} row(s), total ${nonce.summary?.total ?? "?"}`,
);

// -- 2. the oracle term, and the rows the snippet gate reads ---------------
const oracle = await runQuery(ORACLE_TERM, false);
observed.reportedTotal = oracle.summary?.total ?? null;
observed.peakRssMb = Math.max(observed.peakRssMb, oracle.peakRssMb);
const oracleIds = oracle.rows.map((r) => r.id);
observed.caseHits = oracleIds.length;
console.log(
  `  oracle "${ORACLE_TERM}": total ${observed.reportedTotal ?? "?"}, ` +
    `${oracleIds.length} row(s) shown`,
);

// Snippet fidelity. The row's accessible name is `<title>, <kind>: <snippet>`
// for a prose hit and `<title>, <kind>, title match` for a title-only one, so
// the prefix is reconstructed from the RIG's own walk rather than parsed out of
// the name -- titles contain commas and colons, and 2,292 stress items share
// one. That makes this check verify the title and the type as well.
{
  const byId = new Map(corpus.walk.map((r) => [r.id, r]));
  for (const row of oracle.rows) {
    const item = byId.get(row.id);
    if (item === undefined) continue;
    const prosePrefix = `${item.title}, ${item.type}: `;
    if (!row.name.startsWith(prosePrefix)) continue; // title-only hit
    observed.snippetsChecked++;
    const snippet = row.name.slice(prosePrefix.length).replaceAll("…", "");
    const text = corpus.texts.get(row.id);
    if (text !== undefined && text.includes(snippet)) observed.snippetsContained++;
  }
}

// -- 3. casing -------------------------------------------------------------
{
  let agree = true;
  for (const variant of [ORACLE_TERM.toUpperCase(), toMixedCase(ORACLE_TERM)]) {
    const run = await runQuery(variant, false);
    observed.peakRssMb = Math.max(observed.peakRssMb, run.peakRssMb);
    const ids = run.rows.map((r) => r.id);
    if (ids.length !== oracleIds.length || ids.some((id, i) => id !== oracleIds[i])) {
      agree = false;
    }
  }
  observed.caseAgree = agree;
}

// -- 4. a title, ideally a part's or a chapter's ---------------------------
{
  const run = await runQuery(TITLE_TERM, false);
  observed.peakRssMb = Math.max(observed.peakRssMb, run.peakRssMb);
  const ids = run.rows.map((r) => r.id);
  observed.titleHits = ids.length;
  observed.titleFound = ids.includes(titleItem.id);
  console.log(`  title "${TITLE_TERM}": ${ids.length} row(s), expected item ${
    observed.titleFound ? "found" : "NOT FOUND"
  }`);
}

// -- 5. nothing at all -----------------------------------------------------
{
  const run = await runQuery("", false);
  observed.peakRssMb = Math.max(observed.peakRssMb, run.peakRssMb);
  observed.emptyHits = run.rows.length;
}

// -- 6. more matches than the cap, where the fixture can produce them -------
if (TRUNCATION_TERM !== null) {
  const run = await runQuery(TRUNCATION_TERM, false);
  observed.peakRssMb = Math.max(observed.peakRssMb, run.peakRssMb);
  observed.truncationTotal = run.summary?.total ?? null;
  observed.truncationShown = run.rows.length;
  observed.truncationReported = run.summary?.truncated ?? null;
  console.log(
    `  truncation "${TRUNCATION_TERM}": ${run.rows.length} shown of ${
      run.summary?.total ?? "?"
    }, capped=${String(run.summary?.truncated)}`,
  );
}

// -- 7. the reveal: does activating a result put the caret on the word? -----
//
// The NONCE is the query, not the oracle term, and that is what makes the
// activation unambiguous. It matches exactly one item, that item is the scene
// the page opens at boot, and a scene is the only kind of row that opens at
// all - so "arrow onto the first result" cannot land on a chapter, where
// nothing would open and this gate would fail describing the wrong thing.
//
// That the scene is already open is deliberate rather than a compromise: a
// writer searching for a word in the scene they are looking at still expects to
// be taken to it, and the reveal runs on the resolved open either way.
const reveal = await runQuery(NONCE_TOKEN, false, true);
observed.peakRssMb = Math.max(observed.peakRssMb, reveal.peakRssMb);
observed.revealSelection = reveal.selection;
console.log(
  `  reveal "${NONCE_TOKEN}": selection ${
    reveal.selection === null ? "NONE" : JSON.stringify(reveal.selection)
  }`,
);

console.log("[4/4] grading");

if (!observed.ready) {
  abort("the page never became ready on the first boot", cleanup);
}
if (!observed.sentenceReachedStore) {
  abort(
    "VACUITY GUARD: the nonce sentence never reached the store, so a search that failed to " +
      "find it would be indistinguishable from a keystroke that never landed.",
    cleanup,
  );
}
if (observed.typedHits !== 1) {
  abort(
    `VACUITY GUARD: the nonce matched ${observed.typedHits} item(s), not 1, so the reveal boot ` +
      "had nothing unambiguous to arrow onto and the selection gate would grade whatever " +
      "happened to be highlighted.",
    cleanup,
  );
}
if (observed.reportedTotal === null) {
  abort(
    "VACUITY GUARD: #find-status never reported a total for the oracle term, so the run " +
      "observed nothing to compare against the store.",
    cleanup,
  );
}

const metrics: FindMetrics = {
  fixture: fixtureName,
  find_limit: FIND_LIMIT,
  oracle_matches: oracleExpected.length,
  reported_total: observed.reportedTotal,
  typed_hits: observed.typedHits,
  typed_item: observed.typedItem,
  typed_expected_item: bootScene.id,
  title_hits: observed.titleHits,
  title_found_expected: observed.titleFound,
  title_expected_kind: titleItem.type,
  case_variants_agree: observed.caseAgree,
  case_variant_hits: observed.caseHits,
  snippets_checked: observed.snippetsChecked,
  snippets_contained: observed.snippetsContained,
  truncation_total: observed.truncationTotal,
  truncation_shown: observed.truncationShown,
  truncation_reported: observed.truncationReported,
  empty_query_hits: observed.emptyHits,
  reveal_query: NONCE_TOKEN,
  reveal_selection: observed.revealSelection,
  peak_rss_mb: observed.peakRssMb,
};

const verdicts: GateResult[] = evaluateFindGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${String(v.value)}`);
}

const result = buildResult({
  workload: "app-find",
  runId: `app-find-${fixtureName}`,
  candidate: "tauri",
  fixture: fixtureName,
  verdicts,
  metrics: {
    workload_script: "find-v1",
    peak_rss_mb: observed.peakRssMb,
    startup_ms: observed.startupMs,
    items: corpus.walk.length,
    readable_documents: corpus.texts.size,
    find: metrics,
    oracle_term: ORACLE_TERM,
    oracle_term_items: oracleExpected.length,
    title_term: TITLE_TERM,
    title_term_kind: titleItem.type,
    truncation_term: TRUNCATION_TERM,
    nonce: NONCE_TOKEN,
    omitted_gates: [
      {
        gate: "latency, stall, cliff, a11y_exposure, a11y_tree_structure",
        reason:
          "the run types one sentence and presses Return a handful of times. It is not a soak " +
          "and it never mutates the tree, so it has nothing true to say about frame cadence, a " +
          "leak slope, or the navigator's accessibility contract -- that is the hierarchy run's " +
          "claim. peak_rss_mb IS graded, on both fixtures, because the scan holds every stored " +
          "body as text at once on top of the manuscript the page already has.",
      },
    ],
    scope: {
      input:
        "Real X input throughout: xdotool keystrokes only -- Ctrl+F, the query, Return. No " +
        "pointer input at all, so no result row is CLICKED and this run makes no claim that " +
        "activating a result opens the scene. That claim is unit-tested in " +
        "app/ui/test/find-bar.test.ts and is NOT graded here.",
      the_oracle:
        "The store, read directly with bun:sqlite through a recursive CTE this rig restates, " +
        "with every body projected to text by projectText() -- the rig's OWN restatement of the " +
        "plain-text walk, written from the format and not imported from store::document_text or " +
        "find.rs. A projection taken from the implementation would agree with the " +
        "implementation by construction and find_total_matches_oracle would say nothing.",
      folding:
        "The oracle folds with JavaScript toLowerCase(); find.rs folds per CHARACTER, because " +
        "str::to_lowercase is context-dependent for Greek final sigma. Neither fixture contains " +
        "Greek and every query term is drawn from the fixture, so the difference is unreachable " +
        "on this run. A fixture that added Greek would surface it as a LOUD gate failure here, " +
        "which is the intended behaviour rather than a gap.",
      alignment:
        "Result rows are aligned to walk items by the DOM id each row carries " +
        "(`find-row-<itemId>`), never by title: 2,292 of the 20,000 stress items share a title. " +
        "The snippet check reconstructs each row's expected `<title>, <kind>: ` prefix from the " +
        "rig's own walk rather than parsing it out of the accessible name, so it verifies the " +
        "title and the type as well as the snippet.",
      no_latency_gate:
        "THERE IS NO find_ms GATE, and that is a measurement rather than an omission. The only " +
        "channel through which this rig can see that a search has finished is the accessibility " +
        "tree, and polling AT-SPI fast enough to time a sub-second operation WEDGES the " +
        "WebKitGTK bridge: the first version of this rig polled every 250 ms, got through two " +
        "searches, and then found no matching application on the desktop at all. A poll " +
        `interval slow enough to be safe is ~${PROBE_SPACING_MS} ms, which is larger than the ` +
        "thing being measured, so any figure would be a measurement of the rig's own sleep. " +
        "The scan's cost is argued in the design from the word-index measurement, and is stated " +
        "there as an argument rather than as evidence.",
      truncation:
        TRUNCATION_TERM === null
          ? `no term at the "${fixtureName}" fixture matches more than the ${FIND_LIMIT} cap, so ` +
            "find_truncation_honest was NOT PROBED and reports UNKNOWN. A gate that cannot fail " +
            "must not report a pass."
          : `probed with "${TRUNCATION_TERM}", which the rig's own scan puts at ` +
            `${truncationExpected} items against a ${FIND_LIMIT} cap.`,
    },
  },
  seed: "app-v1",
  rigCommit: gitShortSha(),
  environment: captureEnv(),
});

writeResult(result, RESULTS);
cleanup();

const failed = verdicts.filter((v) => v.verdict === "FAIL");
console.log(
  failed.length === 0
    ? `all ${verdicts.length} gate(s) PASS or UNKNOWN`
    : `${failed.length} gate(s) FAILED`,
);
process.exit(failed.length === 0 ? 0 : 1);
