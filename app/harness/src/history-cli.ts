// app/harness/src/history-cli.ts
// Graded version-history run. Drives the SHIPPED history panel -- Edit >
// History..., Shift+Tab onto a version's Restore, the snapshot name field, the
// two presses a whole-manuscript restore demands -- and asks whether what ends
// up in the store is what the writer asked for.
//
// THE ORACLE IS THE STORE, read directly with bun:sqlite and projected to plain
// text by THIS RIG'S OWN restatement of the walk, never imported from
// store/mod.rs or history.rs. For the restore gates the oracle is stronger
// still: the rig PLANTS a version whose text it wrote itself, so "the restore
// returned the right words" is checked against words the application never
// saw until it was asked to give them back.
//
// WALK BUDGET:
//
//   boot 1  type, and let the first flush record a version   ZERO walks
//   boot 2  restore one version through the panel            ZERO walks
//   boot 3  take two named snapshots                         ZERO walks
//   boot 4  restore the whole manuscript from a snapshot     ZERO walks
//   boot 5  read what the panel says it holds                ONE walk
//
// ONE walk in the whole run, and it is in the LAST boot -- so the recorded
// several-walks-kill-the-application defect cannot reach any gate here except
// the one that needs the screen. Everything else is keystrokes in and SQLite
// out.
//
// THE PANEL'S TAB ORDER IS LOAD-BEARING AND IT IS NOT AN ACCIDENT. history.ts
// appends: the version list, the status line, the snapshot heading, the name
// field, Take snapshot, the snapshot list. `open()` focuses the name field. So
// walking BACKWARDS from there reaches the LAST version row -- which is the
// OLDEST version, because the list is newest first -- and Tab twice forwards
// reaches the first snapshot row. Both are reached with no geometry and
// therefore with no walk.
//
// HOW MANY Shift+Tabs THAT TAKES IS PARSED, NOT RESTATED. It was a literal 1,
// which was right until the comparison slice appended a Compare button to every
// row: one Shift+Tab then landed on Compare, Return opened a diff, and three
// restore gates FAILed describing an application that was behaving perfectly.
// `history-row.ts` reads the count out of history.ts for the same reason
// `menu-drive.ts` reads the menu index out of menu-bar.ts. If the row's shape
// changes in a way the parse cannot follow, it throws and the run writes
// nothing, rather than pressing Return on whatever is now in that position.
//
// NO POINTER INPUT AT ALL, which also sidesteps the recorded
// `xdotool click --window` hazard (synthetic button events are discarded by
// the toolkit while reporting success).
//
// Usage: APP_GUI=1 bun app/harness/src/history-cli.ts [tiny|stress]
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { parseVersionRowControls } from "./history-row";
import { evaluateHistoryGates, type GateResult, type HistoryMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import { BIN, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";

/** xdotool type returns when X has the key events, not when WebKitGTK has
 *  turned them into document state. */
const TYPE_DELAY_MS = 20;
const PANEL_OPEN_MS = 900;
const ACTION_SETTLE_MS = 900;
/** The flush debounce is 1000 ms; a write has this long to appear. */
const COMMIT_TIMEOUT_MS = 30_000;
const STORE_POLL_MS = 25;
/** A snapshot walks every document in the manuscript inside one transaction. */
const SNAPSHOT_SETTLE_MS = 4000;

/** store/mod.rs MAX_DEPTH. */
const MAX_DEPTH = 64;

/** Read out of history.ts, never restated. See the header. */
const ROW_CONTROLS = parseVersionRowControls();

/** Four nonces, one per thing the run has to be able to tell apart. Upper-case
 *  ASCII with no spaces: a space typed into the navigator is ACTIVATION, so a
 *  keystroke that reaches the wrong surface should type into nothing rather
 *  than open something. */
const NONCE_FIRST = "QZHISTONE";
/** Typed in boot 2 and NEVER versioned automatically (it lands inside the
 *  five-minute interval), so a version holding it can only have been written by
 *  the restore capturing what it overwrote. That is what makes
 *  `history_restore_is_reversible` non-vacuous: without it the pre-restore body
 *  is byte-identical to the version boot 1 already recorded, content addressing
 *  collapses them to one blob, and the gate could not tell a capture from
 *  nothing at all. */
const NONCE_BEFORE_RESTORE = "QZHISTTWO";
/** Typed AFTER the restore. If the page did not swap the editor's document, the
 *  next flush writes the pre-restore text with this appended and silently
 *  undoes the restore -- which is what `history_restore_reaches_the_page`
 *  refuses, and it is the recorded "6/6 PASS on a slice whose headline loop was
 *  dead" failure mode. */
const NONCE_AFTER_RESTORE = "QZHISTTHREE";
/** Typed in boot 4 and expected to be GONE after the snapshot restore. */
const NONCE_RUIN = "QZHISTRUIN";

/** The text the rig plants a version of. Never typed, never seeded: the
 *  application first meets these words when it is asked to give them back. */
const PLANTED_TEXT = "QZPLANTEDPARA the sentence a writer wants back.";
const PLANTED_BODY = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: PLANTED_TEXT }] }],
});
const PLANTED_KEY = "rig-planted-blob";
/** Three hours back, so the panel renders it "3 hours ago" and it sorts LAST --
 *  the row Shift+Tab reaches. Also old enough that no automatic version can
 *  land in its retention bucket during the run. */
const PLANTED_AGE_MS = 3 * 60 * 60 * 1000;

const SNAPSHOT_ONE = "QZSNAPONE";
const SNAPSHOT_TWO = "QZSNAPTWO";

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

/** THE RIG'S OWN plain-text projection of a stored ProseMirror body. Restated
 *  from the format rather than imported, which is what makes the oracle
 *  independent of the thing it grades. */
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

function storeBodyOf(path: string, itemId: string): string {
  const db = openDb(path);
  try {
    const row = db.query("SELECT body FROM doc WHERE item_id = ?1").get(itemId) as
      | { body: string }
      | null;
    return row?.body ?? "";
  } finally {
    db.close();
  }
}

function storeTextOf(path: string, itemId: string): string | null {
  return projectText(storeBodyOf(path, itemId));
}

interface VersionRecord {
  id: number;
  created_at: number;
  words: number;
  snapshot_id: number | null;
  body: string;
}

function versionsOf(path: string, itemId: string): VersionRecord[] {
  const db = openDb(path);
  try {
    return db
      .query(
        `SELECT v.id, v.created_at, v.words, v.snapshot_id, b.body
           FROM doc_version v JOIN blob b ON b.key = v.blob_key
          WHERE v.item_id = ?1
          ORDER BY v.created_at DESC, v.id DESC`,
      )
      .all(itemId) as VersionRecord[];
  } finally {
    db.close();
  }
}

function scalar(path: string, sql: string, ...args: unknown[]): number {
  const db = openDb(path);
  try {
    const row = db.query(sql).get(...(args as never[])) as Record<string, number> | null;
    if (row === null) return 0;
    const first = Object.values(row)[0];
    return typeof first === "number" ? first : 0;
  } finally {
    db.close();
  }
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

/** Plant a version the application has never seen.
 *
 *  Written with a WRITABLE handle while nothing is running, between boots. The
 *  blob key is arbitrary rather than hashed: keys are opaque to everything that
 *  reads them, so restating the host's hash here would be a restatement with no
 *  claim attached to it. What the run DOES check about hashing is dedup, and
 *  that is checked through the shipped snapshot path.
 */
function plantVersion(path: string, itemId: string, at: number): number {
  const db = new Database(path);
  try {
    db.run("INSERT OR REPLACE INTO blob (key, body) VALUES (?1, ?2)", [PLANTED_KEY, PLANTED_BODY]);
    db.run(
      `INSERT INTO doc_version (item_id, blob_key, created_at, words, snapshot_id)
       VALUES (?1, ?2, ?3, ?4, NULL)`,
      [itemId, PLANTED_KEY, at, PLANTED_TEXT.split(/\s+/u).filter(Boolean).length],
    );
    const row = db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
    return row.id;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- AT-SPI

/** The ONE walk of this run, in the LAST boot. Reads `#history-status` and
 *  nothing else. */
export const PY_TEXT = String.raw`
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

found = {"history-status": None}

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

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps(found))
`;

function probeStatus(rootPid: number): string | null {
  const proc = Bun.spawnSync(["python3", "-c", PY_TEXT, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    // Exit 4 is "not exactly one matching application", which has two very
    // different causes with two different owners: the bridge wedged, or the app
    // DIED. The process table answers it.
    const alive = survivingShellPids();
    throw new Error(
      `could not read the accessibility tree (exit ${proc.exitCode}); ` +
        `${alive.length} shell process(es) alive — ` +
        `${alive.length > 0 ? "the app is running but off the AT-SPI bus" : "THE APP IS GONE"}` +
        `: ${proc.stderr.toString().trim()}`,
    );
  }
  const found = JSON.parse(proc.stdout.toString()) as { "history-status": string | null };
  return found["history-status"];
}

/** Restated from history.ts's status line. `toLocaleString` under the harness's
 *  LANG=C gives a comma-grouped figure. */
const VERSIONS_PATTERN = /([\d,]+) versions? of this scene/u;

function parseVersionCount(text: string | null): number | null {
  if (text === null) return null;
  const m = text.match(VERSIONS_PATTERN);
  if (m?.[1] === undefined) return null;
  return Number(m[1].replaceAll(",", ""));
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
  console.error("usage: APP_GUI=1 bun app/harness/src/history-cli.ts [tiny|stress]");
  process.exit(1);
}
const FIXTURE = `lab/fixtures/out/${fixtureName}`;

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; history run skipped (needs a display and a built shell).");
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
      `${survivors.length} shell process(es) already running (${survivors.join(", ")}).`,
    );
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "app-history-"));
const cleanup = (): void => {
  rmSync(workDir, { recursive: true, force: true });
};

function abort(reason: string): never {
  console.error(`ABORTED, nothing written: ${reason}`);
  cleanup();
  process.exit(1);
}

const projectPath = join(workDir, "history.db");
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`);
}

console.log(`[1/7] seeded from ${FIXTURE}; reading the store as the rig's own oracle`);
const walk = readWalk(projectPath);
if (walk.length === 0) abort("VACUITY GUARD: the seeded project has no items.");
const documentCount = scalar(projectPath, "SELECT COUNT(*) AS n FROM doc");
if (documentCount === 0) {
  abort("VACUITY GUARD: the seeded project holds no documents, so a snapshot would cover nothing.");
}
const scenes = walk.filter((r) => r.type === "scene" && (storeTextOf(projectPath, r.id) ?? "") !== "");
const bootScene = scenes[0];
if (bootScene === undefined) abort("VACUITY GUARD: the fixture has no scene with prose.");
const SEEDED_TEXT = storeTextOf(projectPath, bootScene.id) ?? "";
if (SEEDED_TEXT.includes(PLANTED_TEXT)) {
  abort(`VACUITY GUARD: the planted sentence already occurs in ${bootScene.id}.`);
}
for (const nonce of [NONCE_FIRST, NONCE_BEFORE_RESTORE, NONCE_AFTER_RESTORE, NONCE_RUIN]) {
  for (const scene of scenes) {
    if ((storeTextOf(projectPath, scene.id) ?? "").includes(nonce)) {
      abort(`VACUITY GUARD: the nonce "${nonce}" already occurs in ${scene.id}.`);
    }
  }
}
if (scalar(projectPath, "SELECT COUNT(*) AS n FROM doc_version") !== 0) {
  abort("VACUITY GUARD: a freshly seeded project already carries version rows.");
}

console.log(
  `  ${walk.length} items, ${documentCount} documents, boot scene = ${bootScene.id} ` +
    `("${bootScene.title}")`,
);

const observed = {
  firstVersionHoldsTypedText: false,
  versionsAfterTyping: 0,
  textAfterRestore: null as string | null,
  capturedBeforeRestore: false,
  textAfterTypingOnRestored: null as string | null,
  snapshotDocuments: 0,
  snapshotCount: 0,
  snapshotVersionRows: 0,
  blobsAfterSnapshots: 0,
  textAfterSnapshotRestore: null as string | null,
  textAtSnapshotTime: null as string | null,
  panelVersionCount: null as number | null,
  storeVersionCount: 0,
  peakRssMb: 0,
};

async function waitForStore(itemId: string, ok: (text: string) => boolean): Promise<string | null> {
  const deadline = Date.now() + COMMIT_TIMEOUT_MS;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = storeTextOf(projectPath, itemId);
    if (last !== null && ok(last)) return last;
    await Bun.sleep(STORE_POLL_MS);
  }
  return last;
}

async function boot(
  drive: (ctx: { display: string; wid: string; rootPid: number }) => Promise<void>,
): Promise<void> {
  const run = await runShell<{ ready: boolean; startup_ms: number }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      GDK_BACKEND: "x11",
    },
    // The shell's own periodic prober would add walks this rig did not ask for.
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("the history rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(
          `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`,
        );
      }
      await drive({ display, wid, rootPid });
    },
  });
  observed.peakRssMb = Math.max(observed.peakRssMb, run.peakRssMb);
}

/** Put the caret at the end of the open scene and type. Ctrl+End rather than a
 *  click: a click needs geometry and geometry needs a walk. */
function typeIntoScene(display: string, wid: string, text: string): void {
  xdo(display, ["key", "--window", wid, "ctrl+End"]);
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), ` ${text}`]);
}

async function openHistory(display: string, wid: string): Promise<void> {
  const menu = menuDriver(display, wid, xdo);
  await menu.activate("menu-history");
  await Bun.sleep(PANEL_OPEN_MS);
}

// -- boot 1: typing records a version ---------------------------------------
console.log("[2/7] boot 1: type, and let the first flush record a version");
await boot(async ({ display, wid }) => {
  typeIntoScene(display, wid, NONCE_FIRST);
  const text = await waitForStore(bootScene.id, (t) => t.includes(NONCE_FIRST));
  if (text === null || !text.includes(NONCE_FIRST)) {
    throw new Error("the typed nonce never reached the store");
  }
  await Bun.sleep(ACTION_SETTLE_MS);
});
{
  const versions = versionsOf(projectPath, bootScene.id);
  observed.versionsAfterTyping = versions.length;
  observed.firstVersionHoldsTypedText = versions.some((v) =>
    (projectText(v.body) ?? "").includes(NONCE_FIRST),
  );
  if (versions.length === 0) {
    abort(
      "VACUITY GUARD: typing produced no version at all, so every restore gate below would be " +
        "graded against a history that does not exist.",
    );
  }
}

// -- plant a version the application has never seen -------------------------
console.log("[3/7] planting a version whose text the application has never met");
plantVersion(projectPath, bootScene.id, Date.now() - PLANTED_AGE_MS);
{
  const current = storeTextOf(projectPath, bootScene.id) ?? "";
  if (current === PLANTED_TEXT) {
    abort(
      "VACUITY GUARD: the planted text equals the current body, so 'restored' and 'did nothing' " +
        "would be one picture.",
    );
  }
  const versions = versionsOf(projectPath, bootScene.id);
  const oldest = versions.at(-1);
  if (oldest === undefined || projectText(oldest.body) !== PLANTED_TEXT) {
    abort(
      "VACUITY GUARD: the planted version is not the OLDEST, so Shift+Tab would reach a " +
        "different row than the one this run grades.",
    );
  }
}

// -- boot 2: restore one version through the shipped panel -------------------
console.log("[4/7] boot 2: restore the planted version, then type on top of it");
await boot(async ({ display, wid }) => {
  typeIntoScene(display, wid, NONCE_BEFORE_RESTORE);
  const before = await waitForStore(bootScene.id, (t) => t.includes(NONCE_BEFORE_RESTORE));
  if (before === null || !before.includes(NONCE_BEFORE_RESTORE)) {
    throw new Error("the pre-restore nonce never reached the store");
  }
  await openHistory(display, wid);
  // Focus opens on #snapshot-name. Walking back past every control the row
  // paints after Restore reaches the LAST Restore button, which is the oldest
  // version -- the planted one. The count comes from history.ts. See the header.
  for (let i = 0; i < ROW_CONTROLS.shiftTabsToRestore; i += 1) {
    xdo(display, ["key", "--window", wid, "shift+Tab"]);
    await Bun.sleep(120);
  }
  await Bun.sleep(300);
  xdo(display, ["key", "--window", wid, "Return"]);
  observed.textAfterRestore = await waitForStore(
    bootScene.id,
    (t) => t.includes(PLANTED_TEXT) && !t.includes(NONCE_BEFORE_RESTORE),
  );
  await Bun.sleep(ACTION_SETTLE_MS);
  // NOW type. If the page never swapped the editor's document, this flush
  // writes the PRE-restore text with the nonce appended and silently undoes
  // the restore.
  typeIntoScene(display, wid, NONCE_AFTER_RESTORE);
  observed.textAfterTypingOnRestored = await waitForStore(bootScene.id, (t) =>
    t.includes(NONCE_AFTER_RESTORE),
  );
  await Bun.sleep(ACTION_SETTLE_MS);
});
{
  const versions = versionsOf(projectPath, bootScene.id);
  observed.capturedBeforeRestore = versions.some((v) =>
    (projectText(v.body) ?? "").includes(NONCE_BEFORE_RESTORE),
  );
}

// -- boot 3: two named snapshots --------------------------------------------
console.log("[5/7] boot 3: take two named snapshots of the whole manuscript");
const blobsBeforeSnapshots = scalar(projectPath, "SELECT COUNT(*) AS n FROM blob");
observed.textAtSnapshotTime = storeTextOf(projectPath, bootScene.id);
await boot(async ({ display, wid }) => {
  await openHistory(display, wid);
  // Focus is already in #snapshot-name, and Enter there takes the snapshot.
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), SNAPSHOT_ONE]);
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(SNAPSHOT_SETTLE_MS);
  xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), SNAPSHOT_TWO]);
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(SNAPSHOT_SETTLE_MS);
});
{
  const snaps = snapshotsIn(projectPath);
  observed.snapshotCount = snaps.length;
  observed.snapshotDocuments = snaps[0]?.documents ?? 0;
  observed.snapshotVersionRows = scalar(
    projectPath,
    "SELECT COUNT(*) AS n FROM doc_version WHERE snapshot_id IS NOT NULL",
  );
  observed.blobsAfterSnapshots = scalar(projectPath, "SELECT COUNT(*) AS n FROM blob");
  if (snaps.length !== 2) {
    abort(
      `VACUITY GUARD: expected two snapshots after boot 3, the store holds ${snaps.length}. ` +
        "The dedup gate compares the second against the first and has nothing to compare.",
    );
  }
  if (blobsBeforeSnapshots >= observed.blobsAfterSnapshots) {
    abort(
      "VACUITY GUARD: the first snapshot wrote no blobs at all, so 'the second added none' is " +
        "true of a snapshot that captured nothing.",
    );
  }
}

// -- boot 4: restore the whole manuscript ------------------------------------
console.log("[6/7] boot 4: ruin the scene, then restore the whole manuscript from a snapshot");
await boot(async ({ display, wid }) => {
  typeIntoScene(display, wid, NONCE_RUIN);
  const ruined = await waitForStore(bootScene.id, (t) => t.includes(NONCE_RUIN));
  if (ruined === null || !ruined.includes(NONCE_RUIN)) {
    throw new Error("the ruin nonce never reached the store");
  }
  await openHistory(display, wid);
  // Tab twice from #snapshot-name: Take snapshot, then the first snapshot row.
  xdo(display, ["key", "--window", wid, "Tab"]);
  await Bun.sleep(200);
  xdo(display, ["key", "--window", wid, "Tab"]);
  await Bun.sleep(200);
  // ONE press arms; the SECOND confirms. A rig that pressed once and saw the
  // manuscript change would be grading a missing confirmation as a feature.
  xdo(display, ["key", "--window", wid, "Return"]);
  await Bun.sleep(ACTION_SETTLE_MS);
  const stillRuined = storeTextOf(projectPath, bootScene.id) ?? "";
  if (!stillRuined.includes(NONCE_RUIN)) {
    throw new Error(
      "the FIRST press restored the manuscript: the confirming second press is not there",
    );
  }
  xdo(display, ["key", "--window", wid, "Return"]);
  observed.textAfterSnapshotRestore = await waitForStore(
    bootScene.id,
    (t) => !t.includes(NONCE_RUIN),
  );
  await Bun.sleep(SNAPSHOT_SETTLE_MS);
});

// -- boot 5: what the panel says it holds (THE ONE WALK) ---------------------
console.log("[7/7] boot 5: read what the panel reports (the one AT-SPI walk)");
observed.storeVersionCount = versionsOf(projectPath, bootScene.id).length;
await boot(async ({ display, wid, rootPid }) => {
  await openHistory(display, wid);
  await Bun.sleep(ACTION_SETTLE_MS);
  observed.panelVersionCount = parseVersionCount(probeStatus(rootPid));
});

// ---------------------------------------------------------------- verdicts

const metrics: HistoryMetrics = {
  fixture: fixtureName,
  documents: documentCount,
  versions_after_typing: observed.versionsAfterTyping,
  first_version_holds_typed_text: observed.firstVersionHoldsTypedText,
  planted_text: PLANTED_TEXT,
  text_after_restore: observed.textAfterRestore,
  captured_before_restore: observed.capturedBeforeRestore,
  text_after_typing_on_restored: observed.textAfterTypingOnRestored,
  nonce_before_restore: NONCE_BEFORE_RESTORE,
  nonce_after_restore: NONCE_AFTER_RESTORE,
  nonce_ruin: NONCE_RUIN,
  snapshot_count: observed.snapshotCount,
  snapshot_documents: observed.snapshotDocuments,
  snapshot_version_rows: observed.snapshotVersionRows,
  blobs_before_snapshots: blobsBeforeSnapshots,
  blobs_after_snapshots: observed.blobsAfterSnapshots,
  text_at_snapshot_time: observed.textAtSnapshotTime,
  text_after_snapshot_restore: observed.textAfterSnapshotRestore,
  panel_version_count: observed.panelVersionCount,
  store_version_count: observed.storeVersionCount,
  /** What the backwards walk to Restore actually cost, parsed from history.ts.
   *  Recorded because it is the difference between this run and the one whose
   *  restore gates FAILed on a correct application. */
  version_row_controls: ROW_CONTROLS.buttons.join(", "),
  shift_tabs_to_restore: ROW_CONTROLS.shiftTabsToRestore,
  peak_rss_mb: observed.peakRssMb,
  omitted_gates:
    "typing_p95_ms, typing_stall_rate, cliff_ratio and a11y_exposure are not evaluated: this " +
    "run types four short nonces and spends most of its wall clock waiting on menus and " +
    "transactions, so it has nothing true to say about frame cadence, and it takes ONE AT-SPI " +
    "walk deliberately, which is not an exposure survey.",
};

const verdicts: GateResult[] = evaluateHistoryGates(metrics);

const result = buildResult({
  runId: `app-history-${fixtureName}`,
  candidate: "tauri",
  fixture: fixtureName,
  workload: "app-history",
  verdicts,
  metrics: metrics as unknown as Record<string, unknown>,
  seed: "history-v1",
  rigCommit: gitShortSha(),
  environment: captureEnv(),
});
const written = writeResult(result, RESULTS);
cleanup();

for (const v of verdicts) {
  console.log(`${v.verdict.padEnd(8)} ${v.gate}  ${String(v.value)}`);
}
console.log(`\nwrote ${written}`);
const failed = verdicts.filter((v) => v.verdict === "FAIL");
process.exit(failed.length === 0 ? 0 : 1);
