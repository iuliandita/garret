// app/harness/src/mirror-acts-cli.ts
// Graded run over the three mirror acts no rig has ever reached: the writer
// TURNING THE MIRROR ON, the watcher noticing an outside edit WITHOUT the
// application being restarted, and a CONFLICT preserving the book's side.
//
// WHY THIS IS NOT PART OF `mirror-cli`. That rig's whole shape is "type, quit,
// edit the file, reopen": every change row it has ever seen came from the scan
// at open, and it seeds `mirrored` into `settings.json` with a comment saying
// that driving the enable act would make the run about the project panel. Both
// choices are right for what it grades and both are exactly what leaves these
// three unmeasured. This rig presses the button and keeps those acts in one boot.
//
// THE WATCHER GATE ONLY MEANS ANYTHING IN A PROCESS THAT HAS NOT RESTARTED.
// `spawn_mirror_watcher`'s own header calls itself "an optimization and never
// the guarantee" -- the scan at open is what makes a change noticed at all --
// and nothing has ever checked that the optimization does anything. So the rig
// records `process_restarted` beside the row count and the gate reads both: a
// row seen after a restart is the scan's work and proves nothing here.
//
// THE ORDER OF THE LAST TWO ACTS IS THE HARD-WON PART. A conflict is "the file
// changed AND the store changed too" (`mirror::CONFLICT`), so both sides have
// to move between one pass and the next. The outside edit lands FIRST, which
// makes the watcher pause that entry; the typing lands SECOND, into the same
// document, while the entry is paused and the pass therefore cannot carry the
// typing out to the file. Do it the other way and the ten-second pass writes
// the book's new words into the file before the outside edit arrives, and there
// is nothing left to conflict about.
//
// The final act clears the known conflict, makes an equal-size/equal-mtime
// edit, and presses the explicit thorough check. A third boot must retain that
// finding before another application edit exercises the outbound pass.
//
// Usage: APP_GUI=1 bun app/harness/src/mirror-acts-cli.ts [tiny|stress] [light|dark]
import { readBookId } from "./book-id";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PY_READ_NODES, pidListArg } from "./atspi";
import { captureEnv, noteRenderer } from "./env";
import { evaluateMirrorActsGates, type MirrorActsMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { readDocumentFile } from "./mirror-read";
import { locateNodes, type Node } from "./nodes";
import { nodeToPress, type PressSelector, pressPoint } from "./press-selector";
import { buildResult, writeResult } from "./results";
import { descendantsByComm, sumTreeRssKb } from "./rss";
import { probeRenderer, type RendererRecord } from "./renderer";
import {
  BIN,
  SHELL_PROC_NAME,
  assertAtspiBridgeEnabled,
  freeDisplayNumber,
  killShellAndReap,
  spawnOwned,
  survivingShellPids,
  type OwnedProcess,
} from "./shell";
import { parseGeometry } from "./window-size";

const DIST = "app/ui/dist";
const fixture = process.argv[2] ?? "tiny";
const scheme = process.argv[3] ?? "light";
if (!["tiny", "stress"].includes(fixture) || !["light", "dark"].includes(scheme)) {
  throw new Error("usage: mirror-acts-cli.ts [tiny|stress] [light|dark]");
}
const FIXTURE = `lab/fixtures/out/${fixture}`;
const RESULTS = "app/results";
const CLASS = "^[Aa]pp-shell-tauri$";

/** `mirror::STALENESS_BOUND_MS` is 10 s and a pass is owed once it has passed;
 *  this is that plus room for the write itself. */
const PASS_WAIT_MS = 13_000;
/** `mirror::WATCH_QUIET_MS` is 750 ms -- how long the watcher waits for a
 *  directory to stop moving before it scans. This is that plus room for the
 *  scan and the paint that follows it. */
const WATCH_SETTLE_MS = 3_000;
/** The store's flush ceiling is 1 s; this is that with room, so a typed
 *  sentence is committed before anything reads the store for it. */
const FLUSH_MS = 2_500;
/** Poll the SQLite store and mirror file directly. The page is never the
 * oracle for either a committed flush or an exported byte. */
const POLL_MS = 25;
const COMMIT_TIMEOUT_MS = 15_000;
/** A scheduled mirror pass is due within ten seconds; this allows the write
 * itself without turning the liveness bound into a latency claim. */
const MIRROR_TIMEOUT_MS = 15_000;
/** After a menu chord, before the panel is walked. */
const PANEL_MS = 1_200;

/** The project panel's mirror controls, restated from `switcher.ts`. The
 *  TOGGLE IS PRESSED BY ID and never by name: its label is the act it will
 *  perform ("Turn the mirror on" / "Turn the mirror off"), so the name changes
 *  under the press it is meant to identify. */
const MIRROR_TOGGLE_ID = "project-mirror-toggle";
const MIRROR_STATE_ID = "project-mirror-state";
const MIRROR_WHERE_ID = "project-mirror-where";

/** `mirror.changes.state.conflict` from `i18n/en.ts`, restated rather than
 *  imported: the claim is that the panel SAYS this, and importing the catalog
 *  would let a renamed string agree with itself. */
const CONFLICT_STATE = "The words changed here and in your book";
/** `mirror.changes.state.prose`, restated for the same reason -- the rig
 *  reports which sentence it actually read, and this is the one a run that
 *  never reached a conflict would find in its place. */
const PROSE_STATE = "The words changed";
/** `mirror.changes.row.name` is "{title}. {state}. Comparing what is in your
 *  book with what is in the file." -- the tail is how a row is told from every
 *  other node in the walk, and the state is what sits between the title and it. */
const ROW_NAME_TAIL = ". Comparing what is in your book with what is in the file.";

/** `mirror::FROM_PROJECT_SUFFIX`. The suffix REPLACES the extension so a folder
 *  listing sorts the preserved copy beside the file it preserves. */
const FROM_PROJECT_SUFFIX = ".from-project.md";

/** Typed BEFORE the mirror is turned on, so the folder the enable act writes
 *  has this document's words in it and the rig can tell which file belongs to
 *  the scene the application opened at. */
const MARKER = "Quillon counted the sarsen stones twice. ";
/** The enable command writes a manual pass but does not seed the worker's
 * last-run clock. This marker proves the FIRST scheduled pass actually ran. */
const WARM_UP_MARKER = "The surveyor marked the first scheduled pass. ";
/** Typed immediately after the scheduled pass. Its bytes must be absent while
 * the footer says the folder is updating, then present once it says current. */
const PENDING_MARKER = "The second scheduled sentence is still on its way. ";
/** Typed into the application AFTER the file was edited outside: the book's
 *  side of the conflict, and the words the preserved copy must hold. */
const BOOK_SIDE = "The lantern keeper had written it down differently. ";
/** What the writer put in the file, in an editor that is not this one.
 *
 *  TWO LINES, `mirror-cli`'s recorded reason: the exporter emits a paragraph on
 *  one line, so a single-line edit is byte-identical to what a rewrite would
 *  produce and a gate about "the file was not rewritten" could not fail. */
const OUTSIDE =
  "She had rewritten the whole scene in another editor,\nand the ending was different now.";
/** The line the file is checked for afterwards -- DERIVED from the edit, so
 *  changing the sentence cannot detach the gate from what was written. */
const OUTSIDE_LAST_LINE = OUTSIDE.split("\n").at(-1) ?? "";

if (process.env.APP_GUI !== "1") {
  console.log("mirror-acts-cli: skipped (set APP_GUI=1 to run it)");
  process.exit(0);
}
assertAtspiBridgeEnabled(process.env);
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} -- build it or generate the fixture before running.`);
    process.exit(1);
  }
}
if (survivingShellPids().length > 0) {
  console.error(
    `refusing to start: ${SHELL_PROC_NAME} is already running, and this rig counts windows by class.`,
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "mirror-acts-"));
const project = join(work, "project.db");
const dataHome = join(work, "data");
const mirrorRoot = join(work, "mirror");
mkdirSync(join(dataHome, "garret"), { recursive: true });
mkdirSync(mirrorRoot, { recursive: true });

/** `recovery::target_slug` for `<stem>.db` is the stem, which is what
 *  `set_mirrored` writes into `settings.json`. */
const PROJECT_SLUG = basename(project, ".db");

const display = `:${freeDisplayNumber()}`;

function xdo(args: string[]): string {
  const p = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`xdotool ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function windowId(): string | null {
  const p = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--class", CLASS], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  const ids = p.stdout.toString().trim().split("\n").filter(Boolean);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

function gitShortSha(): string {
  const p = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(p.stdout).trim() || "unknown";
}

/** Move to `node`'s centre and press a BARE click: `click --window` is a
 *  synthesized event WebKitGTK drops. Every press here goes through it. */
function clickNode(wid: string, node: Node, geometry: { width: number; height: number }): void {
  const at = pressPoint(node, geometry);
  xdo(["mousemove", "--window", wid, String(at.x), String(at.y)]);
  xdo(["click", "1"]);
}

/** Walk once and press what `decide` names, or press nothing.
 *
 *  RETURNS NULL RATHER THAN THROWING, `mirror-cli`'s recorded rule: a run that
 *  cannot safely press must leave a RED GATE behind it, not a stack trace that
 *  kills every other gate's verdict before it is written. */
function pressByTree(
  wid: string,
  pid: number,
  decide: (nodes: readonly Node[]) => PressSelector | null,
): Node | null {
  const geometry = parseGeometry(xdo(["getwindowgeometry", "--shell", wid]));
  const nodes = locateNodes(pid);
  const selector = decide(nodes);
  if (selector === null) return null;
  const node = nodeToPress(nodes, selector);
  clickNode(wid, node, geometry);
  return node;
}

/** Text by DOM id, for nodes the role-restricted walk does not carry: the
 *  mirror's two sentences are paragraphs. `PY_READ_NODES`' own shape. */
function readTexts(pid: number, ids: readonly string[]): Record<string, string> {
  const p = Bun.spawnSync(["python3", "-c", PY_READ_NODES, pidListArg(pid), ids.join(",")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) {
    const alive = survivingShellPids();
    throw new Error(
      `could not read [${ids.join(", ")}] from AT-SPI (exit ${p.exitCode}; ${alive.length} ` +
        `shell process(es) alive): ${p.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(p.stdout.toString()) as Record<string, string>;
}

/** Every change row the panel is offering, as `{title, state}`.
 *
 *  A ROW IS TOLD BY ITS TAIL. `mirror.changes.row.name` ends in one fixed
 *  sentence, so a node whose name ends with it is a row and nothing else is;
 *  what precedes it is "{title}. {state}", split at the LAST ". " so a title
 *  carrying a full stop cannot be mistaken for the boundary. */
function rowsFrom(nodes: readonly Node[]): { title: string; state: string }[] {
  const out: { title: string; state: string }[] = [];
  for (const node of nodes) {
    const name = node.name ?? "";
    if (!name.endsWith(ROW_NAME_TAIL)) continue;
    const head = name.slice(0, -ROW_NAME_TAIL.length);
    const at = head.lastIndexOf(". ");
    if (at < 0) continue;
    out.push({ title: head.slice(0, at), state: head.slice(at + 2) });
  }
  return out;
}

/** Every `.md` the folder holds, EXCLUDING a preserved conflict copy -- that
 *  one is the application's own file and not one of the writer's. */
function mirrorFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".md") && !p.endsWith(FROM_PROJECT_SUFFIX)) found.push(p);
    }
  };
  walk(mirrorRoot);
  return found.sort();
}

/** Every preserved copy the folder holds. */
function sidecarFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(FROM_PROJECT_SUFFIX)) found.push(p);
    }
  };
  walk(mirrorRoot);
  return found.sort();
}

interface Store {
  documents: number;
  itemTitles: Record<string, string>;
}

/** The document revision the store holds for one item. `mirror-cli`'s
 *  `typingLanded`, narrowed to the one document this rig types into: a pass
 *  is owed only once the store is dirty, so keystrokes that missed the editor
 *  leave the outside file untouched for free and prove nothing. */
function docRev(itemId: string): number {
  const db = new Database(project, { readonly: true });
  try {
    const row = db.query("SELECT rev FROM doc WHERE item_id = ?").get(itemId) as { rev: number } | null;
    return row?.rev ?? 0;
  } finally {
    db.close();
  }
}

function docBody(itemId: string): string {
  const db = new Database(project, { readonly: true });
  try {
    const row = db.query("SELECT body FROM doc WHERE item_id = ?").get(itemId) as { body: string } | null;
    return row?.body ?? "";
  } finally {
    db.close();
  }
}

async function waitForDocText(itemId: string, text: string): Promise<boolean> {
  const deadline = Date.now() + COMMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (docBody(itemId).includes(text)) return true;
    await Bun.sleep(POLL_MS);
  }
  return docBody(itemId).includes(text);
}

async function waitForMirrorText(path: string, text: string): Promise<boolean> {
  const deadline = Date.now() + MIRROR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return true;
    await Bun.sleep(POLL_MS);
  }
  return existsSync(path) && readFileSync(path, "utf8").includes(text);
}

function readStore(): Store {
  const db = new Database(project, { readonly: true });
  try {
    return {
      documents: (db.query("SELECT count(*) AS n FROM doc").get() as { n: number }).n,
      itemTitles: Object.fromEntries(
        (db.query("SELECT id, title FROM item").all() as { id: string; title: string }[]).map(
          (r) => [r.id, r.title],
        ),
      ),
    };
  } finally {
    db.close();
  }
}

/** The `mirrored_book_ids` list `settings.json` holds, or an empty list when the file
 *  has none. Read from disk, never from the page: the claim is that the
 *  writer's next launch mirrors without being asked. */
function settingsMirrored(): string[] {
  const path = join(dataHome, "garret", "settings.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { mirrored_book_ids?: unknown };
  return Array.isArray(parsed.mirrored_book_ids) ? (parsed.mirrored_book_ids as string[]) : [];
}

/** The scratch directory taken out of a sentence bound for the result. */
function redactScratch(text: string | null): string | null {
  return text === null ? null : text.split(work).join("<scratch>");
}

function abort(message: string): never {
  console.error(`\n${message}\nNothing was written.`);
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// THE PROJECT IS NOT MIRRORED AT BOOT, and that is the act: `mirror-cli` seeds
// `mirrored` here and says in as many words that it is not driving the button.
writeFileSync(
  join(dataHome, "garret", "settings.json"),
  JSON.stringify({ theme: scheme }),
);

{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, project], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`);
}
const bookId = readBookId(project);
const store = readStore();
if (store.documents === 0) {
  abort("the seeded project holds no documents, so the folder this rig grades would be empty.");
}
if (mirrorFiles().length > 0) {
  abort(
    "the mirror directory already holds files before the enable act: `enable_writes_the_folder` " +
      "would pass on files nobody pressed a button for.",
  );
}

const allOwned: OwnedProcess[] = [];
const ownedCleanupKilled: number[] = [];
const ownedCleanupSucceeded: boolean[] = [];
const xvfb = await spawnOwned(["Xvfb", display, "-screen", "0", "1400x1000x24", "-nolisten", "tcp"], {
  stdout: "ignore",
  stderr: "ignore",
});
allOwned.push(xvfb);
await Bun.sleep(1500);

const env = {
  ...process.env,
  DISPLAY: display,
  XDG_DATA_HOME: dataHome,
  APP_DIST: DIST,
  APP_PROJECT: project,
  APP_MIRROR_DIR: mirrorRoot,
  APP_RUN: "interactive",
  GDK_BACKEND: "x11",
};

let peakRssMb = 0;
const renderers: (RendererRecord | null)[] = [];

async function boot(): Promise<{ owned: OwnedProcess; proc: Bun.Subprocess; wid: string }> {
  const owned = await spawnOwned([BIN], { env, stdout: "ignore", stderr: "ignore" });
  allOwned.push(owned);
  const proc = owned.proc;
  let wid: string | null = null;
  for (let waited = 0; waited < 90_000 && wid === null; waited += 500) {
    await Bun.sleep(500);
    wid = windowId();
  }
  if (wid === null) {
    // `finally` reaps this owned group before the next run can inspect the
    // class guard. Do not signal a process by ambient name or direct handle.
    throw new Error("no window appeared");
  }
  xdo(["windowfocus", wid]);
  await Bun.sleep(3000);
  const renderer = probeRenderer(descendantsByComm(proc.pid, "WebKitWebProces"));
  renderers.push(renderer);
  noteRenderer(renderer);
  return { owned, proc, wid };
}

function quit(wid: string): void {
  Bun.spawnSync(["xdotool", "key", "--window", wid, "ctrl+q"], {
    env: { ...process.env, DISPLAY: display },
    stdout: "ignore",
    stderr: "ignore",
  });
}

// Filled by the acts, read after the boot. An act that fails while the
// application still stands records what it got and lets the next one run
// (109's rule): the red gate is the finding, and a rig that threw would write
// no result at all.
let filesBefore = 0;
let filesAfter = 0;
let stateSentence = "";
let whereSentence = "";
let whereNamesTheDirectory = false;
let mirroredAfter: string[] = [];
let rowsBeforeReopen = 0;
let watchedRowFound = false;
let editedFileHoldsTheWritersWords = false;
let passWindowMs = 0;
let editedOutsideAt = 0;
let typedBookSideAt = 0;
let bookSideRevMoved = false;
let processRestarted = false;
let rowsAboutOtherFiles = 0;
let targetItemId = "";
let conflictStateText = "";
let rowsAtConflict = 0;
let sidecarName = "";
let sidecarHoldsTheBooksWords = false;
let sidecarNamedInARow = false;
let thoroughProcessRestarted = false;
let thoroughMetadataPreserved = false;
let thoroughWasInvisible = false;
let thoroughPressed = false;
let thoroughRowFound = false;
let thoroughSurvivedRestart = false;
let thoroughRevMoved = false;
let thoroughPassMs = 0;
let thoroughFilePreserved = false;
let scheduledWarmupReachedMirror = false;
let pendingCommitReachedStore = false;
let pendingWindowMs = 0;
let pendingIndicatorText = "";
// PY_READ_NODES returns the accessible name before visible text. Restated from
// the catalog rather than imported: this is the reader-facing label the rig
// observes while the screenshot preserves the short visible wording.
const pendingIndicatorExpected = "The readable folder is being written";
let pendingMirrorLacksSecondMarker = false;
let pendingPopoverCaptured = false;
let completionReachedMirror = false;
let completionIndicatorText = "";
const completionIndicatorExpected = "The readable folder matches what you have typed";
let actFailed: string | null = null;

let session: { owned: OwnedProcess; proc: Bun.Subprocess; wid: string } | null = null;
let bootFailed: string | null = null;

try {
  console.log("[1/6] booting with the mirror OFF");
  session = await boot();
  let { proc, wid } = session;
  let pid = proc.pid;
  filesBefore = mirrorFiles().length;

  const record = async (act: string, body: () => Promise<void>): Promise<void> => {
    if (actFailed !== null) {
      console.error(`  skipping ${act}: ${actFailed}`);
      return;
    }
    try {
      await body();
    } catch (error: unknown) {
      if (proc.exitCode !== null) throw error;
      actFailed = `${act}: ${String(error)}`;
      console.error(`  ${actFailed}`);
    }
  };

  // The scene the application opened at, marked so the folder the enable act
  // writes can be traced back to it.
  await Bun.sleep(3000);
  xdo(["mousemove", "--window", wid, "700", "500"]);
  xdo(["click", "1"]);
  await Bun.sleep(500);
  xdo(["type", "--window", wid, "--delay", "30", MARKER]);
  await Bun.sleep(FLUSH_MS);

  console.log("[2/6] act (a): turning the mirror on through the panel");
  let menu = menuDriver(display, wid, (_d, args) => xdo(args));
  let target = "";
  let targetTitle = "";
  let original = "";
  let originalAtimeNs = 0n;
  let originalMtimeNs = 0n;
  let statusDot: Node | null = null;
  const restoreTimes = (): void => {
    const result = Bun.spawnSync(["python3", "-c",
      "import os,sys; os.utime(sys.argv[1],ns=(int(sys.argv[2]),int(sys.argv[3])))",
      target, String(originalAtimeNs), String(originalMtimeNs)], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error("could not restore the fixture's file timestamps");
  };
  await record("the enable act", async () => {
    await menu.activate("menu-project-open");
    await Bun.sleep(PANEL_MS);
    // WALK 1: the toggle, by id.
    const pressed = pressByTree(wid, pid, (nodes) => {
      // Prelocate the footer control from this existing walk. The pending check
      // must not add another full WebKitGTK accessibility traversal.
      statusDot = nodes.find((node) => node.id === "status-dot") ?? null;
      return { by: "id", value: MIRROR_TOGGLE_ID };
    });
    if (pressed === null) throw new Error(`${MIRROR_TOGGLE_ID} was not in the tree`);
    // `mirror_enable` runs the pass itself and only then answers, so the
    // folder is written by the time the label stops saying "Writing the
    // mirror...". This waits for that answer and the paint after it.
    await Bun.sleep(4000);
    filesAfter = mirrorFiles().length;
    mirroredAfter = settingsMirrored();
    // WALK 2: the two sentences the panel now shows.
    const texts = readTexts(pid, [MIRROR_STATE_ID, MIRROR_WHERE_ID]);
    stateSentence = texts[MIRROR_STATE_ID] ?? "";
    const where = texts[MIRROR_WHERE_ID] ?? "";
    // THE WHOLE PATH, never its basename. The sentence is "The mirror is
    // written to {dir}", so a check against the last component passed on the
    // word "mirror" inside its own sentence -- the recorded
    // fixture-is-a-fact-about-itself shape, found on this rig's first green
    // run. What is compared is the directory this rig handed the host; what is
    // RECORDED is the sentence with the scratch path taken out, because a
    // committed result carries no path from the machine it ran on.
    whereNamesTheDirectory = where.includes(join(mirrorRoot, "by-id", bookId));
    whereSentence = where.split(mirrorRoot).join("<scratch>");
    console.log(`  ${filesBefore} file(s) -> ${filesAfter}; "${stateSentence}"`);

    const files = mirrorFiles();
    target =
      files.find((f) => readDocumentFile(readFileSync(f, "utf8")).text.includes(MARKER.trim())) ??
      "";
    if (target === "") {
      throw new Error(
        "no file in the folder holds the typed marker, so the rig cannot tell which file belongs " +
          "to the open scene and the two acts after this have no subject.",
      );
    }
    const id = readDocumentFile(readFileSync(target, "utf8")).id ?? "";
    targetItemId = id;
    targetTitle = store.itemTitles[id] ?? "";
    if (targetTitle === "") throw new Error(`the store's item ${id} carries no title`);
    mkdirSync(join(RESULTS, "screenshots"), { recursive: true });
    const screenshot = Bun.spawnSync(["import", "-window", wid,
      join(RESULTS, "screenshots", `127-mirror-check-${scheme}-${fixture}.png`)],
      { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
    if (screenshot.exitCode !== 0) throw new Error("could not capture the mirror check control");
    // Escape closes the panel and returns focus to the prose.
    xdo(["key", "--window", wid, "Escape"]);
    await Bun.sleep(600);
  });

  console.log("[3/7] pending indication: scheduled pass, then a committed second save");
  await record("the pending indication", async () => {
    // The enable command itself passes manually. Type a warm-up marker after it
    // and wait for the actual folder bytes, proving a scheduled pass completed.
    // A long enable can blur its disabled button, leaving Escape outside the
    // panel's listener. Close it from the neutral header before focusing prose.
    xdo(["mousemove", "--window", wid, "700", "10"]);
    xdo(["click", "1"]);
    await Bun.sleep(300);
    xdo(["mousemove", "--window", wid, "700", "200"]);
    xdo(["click", "1"]);
    await Bun.sleep(300);
    xdo(["key", "--window", wid, "ctrl+End"]);
    xdo(["type", "--window", wid, "--delay", "8", WARM_UP_MARKER]);
    await waitForDocText(targetItemId, WARM_UP_MARKER.trim());
    scheduledWarmupReachedMirror = await waitForMirrorText(target, WARM_UP_MARKER.trim());
    const warmupAt = scheduledWarmupReachedMirror ? Date.now() : 0;

    // The second save belongs inside the next ten-second scheduling window.
    xdo(["type", "--window", wid, "--delay", "8", PENDING_MARKER]);
    pendingCommitReachedStore = await waitForDocText(targetItemId, PENDING_MARKER.trim());
    const committedAt = pendingCommitReachedStore ? Date.now() : 0;
    pendingWindowMs = warmupAt === 0 || committedAt === 0 ? 0 : committedAt - warmupAt;
    await Bun.sleep(300);

    if (statusDot !== null) {
      clickNode(wid, statusDot, parseGeometry(xdo(["getwindowgeometry", "--shell", wid])));
      await Bun.sleep(300);
      pendingIndicatorText = readTexts(pid, ["mirror-indicator"])["mirror-indicator"] ?? "";
      mkdirSync(join(RESULTS, "screenshots"), { recursive: true });
      const screenshot = Bun.spawnSync(["import", "-window", wid,
        join(RESULTS, "screenshots", `152-mirror-updating-${scheme}-${fixture}.png`)],
        { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
      pendingPopoverCaptured = screenshot.exitCode === 0;
      // The marker only moves outward here; absence after the capture proves
      // that the captured frame belonged to the pending interval.
      pendingMirrorLacksSecondMarker = !readFileSync(target, "utf8").includes(PENDING_MARKER.trim());
    }

    completionReachedMirror = await waitForMirrorText(target, PENDING_MARKER.trim());
    await Bun.sleep(300);
    completionIndicatorText = readTexts(pid, ["mirror-indicator"])["mirror-indicator"] ?? "";
    xdo(["key", "--window", wid, "Escape"]);
    await Bun.sleep(300);

    // This baseline belongs to the later external edit. Taking it only after
    // both scheduled-pass observations keeps the thorough act independent.
    original = readFileSync(target, "utf8");
    const originalStat = statSync(target, { bigint: true });
    originalAtimeNs = originalStat.atimeNs;
    originalMtimeNs = originalStat.mtimeNs;
    console.log(
      `  warm-up ${scheduledWarmupReachedMirror ? "reached" : "DID NOT REACH"} the folder; ` +
        `pending "${pendingIndicatorText}", completion "${completionIndicatorText}"`,
    );
  });

  console.log("[4/7] act (b): an outside edit, noticed without a reopen");
  await record("the watcher", async () => {
    const current = readFileSync(target, "utf8");
    const lines = current.split("\n");
    const headingAt = lines.findIndex((l) => l.startsWith("# "));
    if (headingAt < 0) {
      // Sliced to nothing, the rewrite would drop the front matter and the
      // host would classify the file as `front-matter` or `added`, not the
      // prose change the two acts after this assume.
      throw new Error("the target file carries no heading, so the outside edit cannot keep its front matter");
    }
    const head = lines.slice(0, headingAt + 1);
    if (!OUTSIDE.includes("\n")) {
      throw new Error("the outside edit is a single line, which a rewrite would reproduce exactly");
    }
    writeFileSync(target, `${head.join("\n")}\n\n${OUTSIDE}\n`);
    // The window the file has to survive starts HERE, at the writer's own
    // save, and not at the act that follows it.
    editedOutsideAt = Date.now();
    await Bun.sleep(WATCH_SETTLE_MS);

    await menu.activate("menu-mirror-changes");
    await Bun.sleep(PANEL_MS);
    // WALK 3: the rows, in the SAME process that wrote the folder.
    const rows = rowsFrom(locateNodes(pid));
    // OBSERVED, not assumed: the pid this rig booted is still the one alive.
    processRestarted = processRestarted || proc.exitCode !== null;
    rowsBeforeReopen = rows.length;
    watchedRowFound = rows.some((r) => r.title === targetTitle);
    console.log(
      `  ${rowsBeforeReopen} row(s) with no reopen; the edited document ` +
        `${watchedRowFound ? "is" : "is NOT"} among them`,
    );
    xdo(["key", "--window", wid, "Escape"]);
    await Bun.sleep(600);
  });

  console.log("[5/7] act (c): the book's side moves too, and the conflict is preserved");
  await record("the conflict", async () => {
    // INTO THE SAME DOCUMENT, which is the one the application still has open:
    // nothing above changed the selection, and the marker proved this scene is
    // the one behind `target`.
    xdo(["mousemove", "--window", wid, "700", "500"]);
    xdo(["click", "1"]);
    await Bun.sleep(500);
    const revBefore = docRev(targetItemId);
    xdo(["type", "--window", wid, "--delay", "30", BOOK_SIDE]);
    // THE PASS WINDOW STARTS HERE, not at the outside edit: `mirror::due`
    // owes a pass only once the store is dirty, and nothing before this
    // keystroke dirtied it.
    typedBookSideAt = Date.now();
    // The pass that honours the pause is what writes the preserved copy, so
    // this waits out the staleness bound rather than the flush.
    await Bun.sleep(PASS_WAIT_MS);
    bookSideRevMoved = docRev(targetItemId) > revBefore;
    peakRssMb = Math.max(peakRssMb, Math.round(sumTreeRssKb(pid) / 1024));

    // WHAT THE WATCHER ACTUALLY BUYS, read from disk in this same boot. A pass
    // has been owed and has run by now; the writer's words are still in their
    // file only because the watcher noticed the edit in time to pause the
    // entry. Disable the watcher and this is where the book overwrites them.
    passWindowMs = typedBookSideAt === 0 ? 0 : Date.now() - typedBookSideAt;
    editedFileHoldsTheWritersWords = readFileSync(target, "utf8").includes(OUTSIDE_LAST_LINE);

    const sidecars = sidecarFiles();
    sidecarName = sidecars.length > 0 ? basename(sidecars[0] ?? "") : "";
    if (sidecars.length > 0) {
      const preserved = readDocumentFile(readFileSync(sidecars[0] ?? "", "utf8")).text;
      sidecarHoldsTheBooksWords = preserved.includes(BOOK_SIDE.trim());
    }

    await menu.activate("menu-mirror-changes");
    await Bun.sleep(PANEL_MS);
    // WALK 4: the rows again, now that both sides have moved.
    const rows = rowsFrom(locateNodes(pid));
    processRestarted = processRestarted || proc.exitCode !== null;
    rowsAtConflict = rows.length;
    rowsAboutOtherFiles = rows.filter((r) => r.title !== targetTitle).length;
    conflictStateText = rows.find((r) => r.title === targetTitle)?.state ?? "";
    // The preserved copy must not be reported back to the writer as a change
    // about their own book -- `walk_for_unmatched` skips the name, and this is
    // the outside check of that. A titleless row is named by its path, which
    // is how an `added` sidecar would surface; one surfacing under the item's
    // own title is a second row about the target and `rows_about_other_files`
    // does not see it, so `rows_at_conflict` is checked against 1 below.
    const sidecarStem = sidecarName.replace(FROM_PROJECT_SUFFIX, "");
    sidecarNamedInARow =
      rows.some((r) => r.title.includes(FROM_PROJECT_SUFFIX)) ||
      (sidecarName !== "" && rows.some((r) => r.title.includes(sidecarStem)));
    console.log(
      `  ${rowsAtConflict} row(s); the edited document says "${conflictStateText}"; ` +
        `preserved copy ${sidecarName === "" ? "MISSING" : sidecarName}`,
    );
  });

  console.log("[6/7] act (d): checking a size- and timestamp-preserving edit");
  await record("the thorough check", async () => {
    // A fresh boot limits AT-SPI walks per process. Restore the baseline
    // before that boot so neither an old pause nor an open-time finding can
    // preserve the new hidden edit without the explicit action.
    quit(wid);
    await Promise.race([proc.exited, Bun.sleep(3000)]);
    if (proc.exitCode === null) throw new Error("the first mirror session did not close cleanly");
    writeFileSync(target, original);
    restoreTimes();
    session = await boot();
    ({ proc, wid } = session);
    pid = proc.pid;
    menu = menuDriver(display, wid, (_d, args) => xdo(args));
    await Bun.sleep(WATCH_SETTLE_MS);
    await menu.activate("menu-mirror-changes");
    await Bun.sleep(PANEL_MS);
    if (rowsFrom(locateNodes(pid)).some((row) => row.title === targetTitle)) {
      throw new Error("restoring the baseline did not clear the earlier change");
    }
    xdo(["key", "--window", wid, "Escape"]);
    const changed = original.replace(MARKER.trim(), MARKER.trim().replace("Quillon", "Ruillon"));
    if (changed === original) throw new Error("the preserved-metadata edit has no marker to change");
    writeFileSync(target, changed);
    restoreTimes();
    const editedStat = statSync(target, { bigint: true });
    thoroughMetadataPreserved = editedStat.size === BigInt(Buffer.byteLength(original))
      && editedStat.mtimeNs === originalMtimeNs;
    await Bun.sleep(WATCH_SETTLE_MS);
    await menu.activate("menu-mirror-changes");
    await Bun.sleep(PANEL_MS);
    thoroughWasInvisible = !rowsFrom(locateNodes(pid)).some((row) => row.title === targetTitle);
    xdo(["key", "--window", wid, "Escape"]);
    await menu.activate("menu-project-open");
    await Bun.sleep(PANEL_MS);
    thoroughPressed = pressByTree(wid, pid, () => ({ by: "id", value: "mirror-check" })) !== null;
    await Bun.sleep(WATCH_SETTLE_MS);
    xdo(["key", "--window", wid, "Escape"]);
    await menu.activate("menu-mirror-changes");
    await Bun.sleep(PANEL_MS);
    thoroughRowFound = rowsFrom(locateNodes(pid)).some((row) => row.title === targetTitle);
    thoroughProcessRestarted = proc.exitCode !== null;
    // A successful check must remain effective after the runtime pause set
    // disappears. Do not press the check again in this third process.
    quit(wid);
    await Promise.race([proc.exited, Bun.sleep(3000)]);
    if (proc.exitCode === null) throw new Error("the checked mirror session did not close cleanly");
    session = await boot();
    ({ proc, wid } = session);
    pid = proc.pid;
    menu = menuDriver(display, wid, (_d, args) => xdo(args));
    await Bun.sleep(WATCH_SETTLE_MS);
    await menu.activate("menu-mirror-changes");
    await Bun.sleep(PANEL_MS);
    thoroughSurvivedRestart = rowsFrom(locateNodes(pid)).some((row) => row.title === targetTitle);
    xdo(["key", "--window", wid, "Escape"]);
    xdo(["mousemove", "--window", wid, "700", "500"]);
    xdo(["click", "1"]);
    const before = docRev(targetItemId);
    xdo(["type", "--window", wid, "--delay", "30", "The third version stayed in the book. "]);
    const typedAt = Date.now();
    await Bun.sleep(PASS_WAIT_MS);
    thoroughPassMs = Date.now() - typedAt;
    thoroughRevMoved = docRev(targetItemId) > before;
    thoroughFilePreserved = readFileSync(target, "utf8") === changed;
    thoroughSurvivedRestart &&= proc.exitCode === null;
  });

  peakRssMb = Math.max(peakRssMb, Math.round(sumTreeRssKb(pid) / 1024));
  quit(wid);
  await Bun.sleep(2000);
} catch (error: unknown) {
  bootFailed = String(error);
} finally {
  // Every process belongs to a detached group created by this run. Never reap
  // by the global shell name: another app instance is not this rig's to kill.
  if (session !== null && bootFailed !== null) quit(session.wid);
  for (const owned of [...allOwned].reverse()) {
    try {
      const killed = await killShellAndReap(owned);
      ownedCleanupKilled.push(killed);
      ownedCleanupSucceeded.push(true);
    } catch (error: unknown) {
      ownedCleanupSucceeded.push(false);
      bootFailed = `${bootFailed ?? "owned cleanup failed"}; ${String(error)}`;
    }
  }
}
if (bootFailed !== null) abort(`the boot failed: ${bootFailed}`);

const metrics: MirrorActsMetrics = {
  files_in_folder_before: filesBefore,
  files_in_folder_after: filesAfter,
  store_documents: store.documents,
  state_sentence: stateSentence,
  state_sentence_expected_count: filesAfter,
  where_names_the_directory: whereNamesTheDirectory,
  where_sentence_redacted: whereSentence,
  settings_mirrored_book_ids: mirroredAfter,
  book_id: bookId,
  rows_before_any_reopen: rowsBeforeReopen,
  edited_file_holds_the_writers_words: editedFileHoldsTheWritersWords,
  pass_window_ms: passWindowMs,
  book_side_rev_moved: bookSideRevMoved,
  outside_edit_led_by_ms:
    editedOutsideAt === 0 || typedBookSideAt === 0 ? 0 : typedBookSideAt - editedOutsideAt,
  watched_document_row_found: watchedRowFound,
  // OBSERVED at each row walk from this owned launch's own process handle.
  process_restarted: processRestarted,
  conflict_row_state_text: conflictStateText,
  conflict_state_expected: CONFLICT_STATE,
  sidecar_name: sidecarName,
  sidecar_exists: sidecarName !== "",
  sidecar_holds_the_books_words: sidecarHoldsTheBooksWords,
  rows_at_conflict: rowsAtConflict,
  rows_about_other_files: rowsAboutOtherFiles,
  sidecar_named_in_a_row: sidecarNamedInARow,
  thorough_process_restarted: thoroughProcessRestarted,
  thorough_metadata_preserved: thoroughMetadataPreserved,
  thorough_was_invisible: thoroughWasInvisible,
  thorough_pressed: thoroughPressed,
  thorough_row_found: thoroughRowFound,
  thorough_survived_restart: thoroughSurvivedRestart,
  thorough_rev_moved: thoroughRevMoved,
  thorough_pass_ms: thoroughPassMs,
  thorough_file_preserved: thoroughFilePreserved,
  scheduled_warmup_reached_mirror: scheduledWarmupReachedMirror,
  pending_commit_reached_store: pendingCommitReachedStore,
  pending_window_ms: pendingWindowMs,
  pending_indicator_text: pendingIndicatorText,
  pending_indicator_expected: pendingIndicatorExpected,
  pending_mirror_lacks_second_marker: pendingMirrorLacksSecondMarker,
  pending_popover_captured: pendingPopoverCaptured,
  completion_reached_mirror: completionReachedMirror,
  completion_indicator_text: completionIndicatorText,
  completion_indicator_expected: completionIndicatorExpected,
  owned_cleanup_killed: ownedCleanupKilled,
  owned_cleanup_succeeded: ownedCleanupSucceeded,
  peak_rss_mb: peakRssMb,
};

const verdicts = evaluateMirrorActsGates(metrics);
console.log("\n[7/7] verdicts");
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

const path = writeResult(
  buildResult({
    runId: `app-mirror-acts-${fixture}`,
    candidate: "tauri",
    fixture,
    workload: "app-mirror-acts",
    verdicts,
    metrics: {
      ...metrics,
      scheme,
      renderers,
      prose_state_for_comparison: PROSE_STATE,
      // The error text can carry the scratch directory (a file path, xdotool's
      // stderr), redacted the way the where-sentence is.
      act_failed: redactScratch(actFailed),
      omitted_gates:
        "latency, stall, cliff, a11y_exposure: one boot that presses a button and edits a file " +
        "has nothing true to say about frame cadence.",
      scope:
        "The first boot grades the watcher without restarting; a fresh second boot grades the explicit full check, and a third grades restart persistence. Every " +
        "row this rig reads was offered by a process that had already written the folder. The " +
        "conflict is reached by moving the FILE first and the STORE second, so the paused entry " +
        "cannot be overwritten by the pass in between.",
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

console.log(`\nrecorded: ${path}`);
rmSync(work, { recursive: true, force: true });
process.exit(verdicts.some((v) => v.verdict !== "PASS") ? 1 : 0);
