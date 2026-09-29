// app/harness/src/preview-cli.ts
// Graded run over the two BOOK previews: the EPUB rail and the PDF proof.
//
// WHAT THIS IS FOR. Four earlier changes each had to write "no graded rig
// opens the rail", and one added "no rig drives the PDF save dialog" and "the
// proof's own render is not measured at stress". Every claim about the archive
// the rail shows, about the leaves the printer was handed, and about the file
// either one saves has rested on unit tests, on `epubcheck` run by hand, and on
// screenshots. This is the instrument.
//
// THE FILE COMES FROM THE RAIL'S OWN "Save as", THROUGH THE OS DIALOG, and not
// from the CLI's `export` subcommand. The gap the records name is the SAVE
// path: the CLI reaches the printer through `render_standalone` while the rail
// reaches it through `render_via`, on the app's own GTK thread, from a button a
// writer presses. A rig that exported from the CLI would grade the half nobody
// doubted.
//
// TWO OUTSIDE READERS GRADE THE TWO FILES. `epubcheck` is the reading systems'
// own validator and `pdfinfo` is poppler's; neither is this project's code, and
// neither was written from the emitter's logic. That is the whole reason the
// two file gates mean anything: `export-cli`'s recorded rule is that a reader
// built out of the emitter would check the exporter against itself.
//
// THE LEAF COUNT IS THE ONE CROSS-CHECK OF "ONE RENDER, TWO CONSUMERS".
// `proof_preview_of` says the whole book is N leaves while handing the rail at
// most `pdf::PREVIEW_LEAVES` of them; the file the same rail then saves is
// counted by poppler. Those two numbers agreeing is the only evidence from
// outside both programs that the preview is of the file.
//
// THE WALK BUDGET IS THE DESIGN CONSTRAINT, not the timings. Several AT-SPI
// walks in one window are known to KILL the application outright
// (reproduced at the third to fifth walk; it is a race, so the
// boundary moves). This rig needs to read the rail three times -- after the
// EPUB render, after the option toggle, after the proof render -- so every walk
// fetches geometry AND text AND the toggle's pressed state in one pass, the
// count is capped, and both the count and each walk's duration are recorded in
// the result. Neither is gated -- what a spent budget actually produces is an
// empty summary reading, and THAT is what turns a gate red; the counts are the
// diagnosis a reader needs beside it.
//
// A BOOT LASTS 120 SECONDS AND THAT IS THE HARD CEILING ON THIS RIG.
// `main.rs`'s `sink` command spawns a thread that exits the process 120 s after
// the page reports ready -- deliberately, as the safety net that stops a rig
// leaving a window on the desktop forever. Every timing below is chosen so the
// whole boot finishes inside it: two runs were lost to this before it was
// found, both reported as "the shell is gone" at ~110 s, on the `tiny` book as
// readily as on `stress`, with the rail open and with it shut. If a phase here
// grows, take it out of another one -- do not assume the boot will wait.
//
// NOTHING HERE IS TYPED INTO THE BOOK. The fixture is seeded and left alone, so
// the store's own item and word counts are a stable oracle for what the rail's
// summary line claims -- which is act (a)'s gate. `export-cli` types a sentence
// and its recorded figures are 12 words above a fresh seed's for exactly that
// reason.
//
// Usage: APP_GUI=1 bun app/harness/src/preview-cli.ts <tiny|stress>
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluatePreviewGates, type PreviewMetrics } from "./gates";
import { countWords } from "./markdown-read";
import { menuDriver } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  type RunOutcome,
  findWindowId,
  runShell,
  survivingShellPids,
} from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";
const FIXTURES = new Set(["tiny", "stress"]);

/** store/mod.rs MAX_DEPTH, restated as `export-cli` restates it: without it the
 *  CTE recurses forever on a parent_id cycle. */
const MAX_DEPTH = 64;

/** The rail's own DOM ids, restated from `preview-rail.ts`. The flag id spells
 *  the option the PAGE's way (`STYLE_FLAGS`, underscores) and the META ROW
 *  spells it the HOST's way (`design::CAPS_TITLE`, hyphens); they are two
 *  different strings for one fact and a rig that restated either for the other
 *  would report a correct application as broken. Both are below, named apart. */
const RAIL_ID = "preview-rail";

const SUMMARY_ID = "preview-summary";
const FLAG_ID = "preview-flag-caps_title";
const SAVE_AS_ID = "preview-save-as";

/** The rail's accessible label per format, restated from `i18n/en.ts`
 *  (`preview.epub.label`, `preview.pdf.label`). The rail rewrites its own
 *  `aria-label` on every open, and a rail still labelled "EPUB preview" while
 *  it shows a proof is the defect this reading exists to catch. */
const EPUB_RAIL_NAME = "EPUB preview";
const PDF_RAIL_NAME = "PDF proof";

/** The save dialogs' titles, restated from `commands/dialogs.rs`
 *  (`EPUB_DIALOG_TITLE`, `PDF_DIALOG_TITLE`). Each format has a title of its
 *  own precisely so a rig can tell two dialogs apart. */
const EPUB_DIALOG_TITLE = "Save EPUB";
const PDF_DIALOG_TITLE = "Save PDF proof";

/** `design::CHAPTER_KEY` and `design::CAPS_TITLE`, restated. The row is a
 *  space-joined flag list and absence means the plainest book. */
const CHAPTER_META_KEY = "design.chapter";
const CAPS_TITLE_TOKEN = "caps-title";

/** The summary sentences, restated from `i18n/en.ts` as patterns rather than
 *  as text: the figures are the point and the plural forms differ by one
 *  letter (`preview.epub.summary.one` against `.other`). Anchored at the START
 *  only, because a proof's summary carries further sentences after this one --
 *  the missing face, the gutter verdict, the truncation note. */
const EPUB_SUMMARY_PATTERN = /^(\d+) sections?, (\d+) words\./u;
const PDF_SUMMARY_PATTERN = /^(\d+) pages?, (\d+) sections?, (\d+) words\./u;

/** `epubcheck`'s tally line. It SINGULARISES at one ("1 fatal / 1 error / 0
 *  warnings"), which a pattern demanding the plural would fail to parse while
 *  reporting nothing wrong -- measured against a deliberately corrupted
 *  archive before this rig was written. */
const EPUBCHECK_MESSAGES_PATTERN = /(\d+)\s+fatals?\s*\/\s*(\d+)\s+errors?\s*\/\s*(\d+)\s+warnings?/u;
/** poppler's page line. */
const PDFINFO_PAGES_PATTERN = /^Pages:\s+(\d+)$/mu;

/** Wide enough for the rail to sit beside the prose with its head controls in
 *  the window: the rail is the third grid column and takes its width from
 *  `#editor`. `bible-cli`'s and `pictures-cli`'s own panel window, restated. */
const PANEL_WINDOW = { w: 1200, h: 900 };

/** How many AT-SPI walks this rig may take in one boot before it refuses to
 *  take another.
 *
 *  THE RECORDED KILL IS AT THREE TO FIVE and it is a race, so this is a budget
 *  and not a safe number: three walks are the plan, and the rest are for a
 *  render that has not finished painting. Spending them is a finding, which is
 *  why the count is recorded rather than merely bounded. `pictures-cli` takes
 *  five in a boot and has survived five green runs. */
const WALK_CAP = 8;

/** How many walks each rail reading may spend before the rig goes on with what
 *  it has.
 *
 *  GOING ON IS THE POINT. A reading that never arrives is a FAIL the gate can
 *  state, where spending the whole budget on one rail would end the boot in an
 *  exception and record nothing about the rest of it. The three phases sum to
 *  six, under the cap, so the last phase can still take its reading after the
 *  first two have taken every retry they are allowed. */
const EPUB_RAIL_WALK_MAX = 2;
const PROOF_RAIL_WALK_MAX = 3;

const SETTLE_MS = 2500;
const CLICK_SETTLE_MS = 1500;
const DIALOG_WAIT_MS = 20_000;
const DIALOG_POLL_MS = 250;
/** Between the Return that dismisses a save dialog and the first look at the
 *  destination. It is also the granularity of both save figures: a save is
 *  reported complete at the first poll that sees a stable, terminated file, so
 *  `epub_save_ms` and `proof_save_ms` each carry up to this much of the rig's
 *  own sleep. The thresholds are set well clear of it. */
const SAVE_POLL_MS = 100;

/** How long the two outside readers may take before the rig stops waiting.
 *  Generous: `epubcheck` over the 13.9 MB `stress` archive is the slow one, and
 *  this is a liveness bound rather than a measurement. */
const READER_TIMEOUT_MS = 300_000;

/** How long the CLI's proof export may take before the rig stops waiting. It
 *  is expected to give up at the host's own 180-second bound; this is the
 *  outer limit on waiting for that to happen. */
const PROOF_REFUSAL_TIMEOUT_MS = 300_000;

/** Everything that scales with the size of the book.
 *
 *  MEASURED BEFORE THEY WERE WRITTEN, on the measurement machine, through the CLI's own
 *  export of the same fixtures: the archive is 0.35 s at `stress` and the
 *  proof is minutes. These are LIVENESS bounds and not gates -- the graded
 *  figures are `epub_save_ms` and `proof_save_ms`, which are measured, not
 *  bounded here. A bound hit is reported as a failure with the elapsed time in
 *  it, never as a silent skip. */
const TIMING: Record<string, {
  /** Whether this fixture's book can be proofed AT ALL.
   *
   *  FALSE AT `stress`, AND IT IS A MEASUREMENT RATHER THAN A CHOICE. A
   *  20000-item book does not paginate inside `printer.rs`'s own
   *  `RENDER_TIMEOUT_SECONDS` (180): the render is abandoned and the host says
   *  "the proof did not finish within 180 seconds", which this rig measured
   *  through the CLI -- the same paginator the rail reaches -- before the flag
   *  was written. There is no proof to save, so the two proof readings report
   *  UNKNOWN and the PDF record's open question ("the proof's own render is not
   *  measured at stress") is answered in the negative rather than left open.
   *
   *  The EPUB half runs at both fixtures: an archive of the same book is 0.35 s. */
  attemptsProof: boolean;
  epubRailSettleMs: number;
  /** The repaint the option toggle causes: the same render again, from the
   *  host's answer. Its own knob because the boot's 120 s has to be divided
   *  between the two paints and the save. */
  toggleRepaintMs: number;
  epubRailRetryMs: number;
  proofRailSettleMs: number;
  proofRailRetryMs: number;
  epubSaveTimeoutMs: number;
  proofSaveTimeoutMs: number;
}> = {
  tiny: {
    attemptsProof: true,
    epubRailSettleMs: 4_000,
    toggleRepaintMs: 4_000,
    epubRailRetryMs: 8_000,
    proofRailSettleMs: 12_000,
    proofRailRetryMs: 20_000,
    epubSaveTimeoutMs: 120_000,
    proofSaveTimeoutMs: 300_000,
  },
  stress: {
    attemptsProof: false,
    // INSIDE THE 120-SECOND BOOT, with the whole act sequence budgeted: 2.5 s
    // to resize and focus, 30 s for the first render of a 20000-item book
    // (measured: the rail's summary was right at the first walk), a walk, 25 s
    // for the repaint the option toggle causes, a walk, then the save. That
    // leaves roughly 30 s of headroom. The proof is not attempted here at all.
    epubRailSettleMs: 30_000,
    toggleRepaintMs: 20_000,
    epubRailRetryMs: 4_000,
    proofRailSettleMs: 0,
    proofRailRetryMs: 0,
    epubSaveTimeoutMs: 45_000,
    proofSaveTimeoutMs: 0,
  },
};

const fixture = process.argv[2] ?? "tiny";
if (!FIXTURES.has(fixture)) {
  console.error(`unknown fixture ${JSON.stringify(fixture)}; expected one of ${[...FIXTURES].join(", ")}.`);
  process.exit(1);
}
const FIXTURE = `lab/fixtures/out/${fixture}`;
const timing = TIMING[fixture]!;

let root = "";

function abort(message: string): never {
  console.error(`\n${message}\nNothing was written.`);
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

// ---------------------------------------------------------------- the desktop

function xdoRead(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

function xdo(display: string, args: string[]): void {
  xdoRead(display, args);
}

/** `xdo`, with `--window <wid>` stripped from any verb it is given.
 *
 *  REAL INPUT AFTER A DIALOG, `pictures-cli`'s finding: once a GTK dialog has
 *  taken the keyboard grab, `xdotool key --window` (a synthetic XSendEvent)
 *  reaches nothing, while a window-targetless key goes through XTEST and lands
 *  on whatever holds focus. Every menu chord this rig sends AFTER the first
 *  save dialog goes through here. */
function xtest(display: string, args: string[]): void {
  const i = args.indexOf("--window");
  xdo(display, i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)]);
}

/** Windows carrying a title, without `findWindowId`'s exactly-one guard: a
 *  search that finds nothing is a legitimate answer while a dialog is opening.
 *  `dialog-cli`'s own reason. */
function windowsTitled(display: string, title: string): string[] {
  const proc = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", `^${title}$`], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  const found = proc.stdout.toString().trim().split("\n").filter(Boolean);
  // EXIT 1 WITH NOTHING ON EITHER STREAM IS "no such window", which is a real
  // answer while a dialog is opening. Exit 1 with something on stderr, or any
  // other status, is the DESKTOP failing -- a dead X server reads exactly like
  // a dialog that never opened, and this rig has already spent runs on that
  // confusion. They are different problems with different owners.
  const complaint = proc.stderr.toString().trim();
  if (found.length === 0 && (complaint.length > 0 || (proc.exitCode ?? 0) > 1)) {
    throw new Error(
      `xdotool search for ${JSON.stringify(title)} failed (exit ${proc.exitCode}): ${complaint}`,
    );
  }
  return found;
}

async function waitForDialog(display: string, title: string): Promise<string> {
  const deadline = Date.now() + DIALOG_WAIT_MS;
  while (Date.now() < deadline) {
    const found = windowsTitled(display, title);
    if (found.length > 1) {
      throw new Error(
        `${found.length} windows carry the title ${JSON.stringify(title)}: this rig cannot say ` +
          "which dialog it is about to type a path into.",
      );
    }
    const one = found[0];
    if (one !== undefined) return one;
    await Bun.sleep(DIALOG_POLL_MS);
  }
  throw new Error(`the ${JSON.stringify(title)} dialog never opened within ${DIALOG_WAIT_MS} ms.`);
}

/** Ask for a window size and read it back: an unhonoured resize leaves every
 *  coordinate below computed against a window that does not exist.
 *  `bible-cli`'s guard, restated. */
function resizeWindow(display: string, wid: string, size: { w: number; h: number }): void {
  xdo(display, ["windowsize", wid, String(size.w), String(size.h)]);
  const geometry = xdoRead(display, ["getwindowgeometry", "--shell", wid]);
  const width = Number(geometry.match(/\bWIDTH=(\d+)/u)?.[1] ?? 0);
  const height = Number(geometry.match(/\bHEIGHT=(\d+)/u)?.[1] ?? 0);
  if (width !== size.w || height !== size.h) {
    throw new Error(
      `the window is ${width}x${height} after asking for ${size.w}x${size.h}: every coordinate ` +
        "in this rig assumes the size it asked for.",
    );
  }
}

function clickAt(
  display: string,
  wid: string,
  rect: { x: number; y: number; w: number; h: number },
): void {
  if (rect.w <= 0 || rect.h <= 0) {
    throw new Error(
      `refusing to click a node with no extents (${rect.w}x${rect.h}): it is hidden or has no ` +
        "Component interface, and the click would land wherever the last one did.",
    );
  }
  const x = Math.round(rect.x + rect.w / 2);
  const y = Math.round(rect.y + rect.h / 2);
  // A BARE click, never `click --window`: with the flag xdotool sends a
  // synthetic event through XSendEvent and WebKit/GTK drop it silently.
  xdo(display, ["mousemove", "--window", wid, String(x), String(y)]);
  xdo(display, ["click", "1"]);
}

// ------------------------------------------------------------------- the walk

/** Geometry, text AND toggle state, by DOM id, in ONE walk.
 *
 *  ONE TEMPLATE FOR EVERY READING THIS RIG TAKES, which is the walk budget in
 *  the header made structural: a rig that read geometry in one pass and text in
 *  another would double the number of walks, and several walks in one window
 *  have killed this application outright.
 *
 *  IT READS THE NAME AND NOT THE SUBTREE. The rail's summary is `role="status"`,
 *  which WebKitGTK maps to an ATK status bar WHOSE CHILDREN IT PRUNES: its
 *  sentences are only reachable through the node's accessible name, which the
 *  page sets (that was fixed; `#word-count` has always done it). An earlier
 *  version of this walk collected every descendant's text as a fallback, and it
 *  was a guard nothing could reach -- the children it would have read do not
 *  exist, and collecting them from the rail, which is an ANCESTOR of the
 *  painted book, cost 49.9 seconds at `stress` against a 120-second boot.
 *
 *  IT STOPS THE MOMENT IT HAS EVERYTHING, and that is why a `stress` reading is
 *  affordable at all. The painted book is 15200 documents at `stress` -- every
 *  heading, paragraph, list and link of them in the accessibility tree -- and a
 *  walk that traversed it took 49.5 SECONDS (measured), most of a boot's
 *  120-second life; two of those and the application is reaped mid-read, which
 *  reads as "Failed creating new xdo instance" and looks exactly like the
 *  recorded walk-kill.
 *
 *  SKIPPING THE BOOK BY ID DOES NOT WORK AND THAT IS THE FINDING. `#preview-
 *  pages` is a role-less `div`, so it is NOT IN THE TREE at all (108 found the
 *  same of `#covers-sides`): its documents hang off the rail directly and there
 *  is no node to refuse to descend into. What works is the short circuit --
 *  every id this rig asks for is a child of the rail ABOVE the book, so the
 *  walk has them all before it would reach the first document.
 *
 *  `pressed` reads STATE_PRESSED *or* STATE_CHECKED: `aria-pressed` on a
 *  button surfaces as one or the other depending on how the bridge maps a
 *  toggle button, both spell the same ARIA fact, and the store-side half of
 *  that gate is what makes the claim falsifiable either way. */
const PY_NODE_VIEW = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
wanted = set(sys.argv[2].split(","))

class Done(Exception):
    pass

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

def own_text(node):
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception:
        return ""

def extents(node):
    try:
        e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
        return {"x": e.x, "y": e.y, "w": e.width, "h": e.height}
    except Exception:
        return {"x": 0, "y": 0, "w": 0, "h": 0}

def pressed(node):
    try:
        states = node.getState()
        return bool(states.contains(pyatspi.STATE_PRESSED) or states.contains(pyatspi.STATE_CHECKED))
    except Exception:
        return False

found = {}

def walk(node):
    try:
        i = ident(node)
        if i in wanted and i not in found:
            info = extents(node)
            info["text"] = node.name or own_text(node)
            info["pressed"] = pressed(node)
            found[i] = info
            if len(found) == len(wanted):
                raise Done()
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Done:
        raise
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
try:
    walk(matched[0])
except Done:
    pass
sys.stdout.write(json.dumps(found))
`;

interface NodeView {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  pressed: boolean;
}

/** How many walks this boot has taken, and how long each one cost.
 *
 *  THE DURATIONS ARE WHY THE SHORT CIRCUIT EXISTS, so they are recorded rather
 *  than merely watched: an unpruned walk of the `stress` book was 49.5 s
 *  against a 120-second boot, and the failure it produced looked like anything
 *  but a slow walk. A future reader who sees these climb has the diagnosis in
 *  the result.  */
let walksTaken = 0;
const walkMs: number[] = [];

function readNodeView(rootPid: number, ids: readonly string[]): Record<string, NodeView> {
  if (walksTaken >= WALK_CAP) {
    throw new Error(
      `refusing an AT-SPI walk past the budget of ${WALK_CAP} in one boot: several walks in one ` +
        "window have killed this application outright, and a rig that kept walking would report " +
        "the kill as its own timeout.",
    );
  }
  walksTaken += 1;
  const started = Date.now();
  const proc = Bun.spawnSync(
    ["python3", "-c", PY_NODE_VIEW, pidListArg(rootPid), ids.join(",")],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  walkMs.push(Date.now() - started);
  if (proc.exitCode !== 0) {
    // "the bridge wedged" and "the app is gone" are different problems with
    // different owners, and one line distinguishes them.
    const alive = survivingShellPids();
    throw new Error(
      `could not read [${ids.join(", ")}] from AT-SPI on walk ${walksTaken} (exit ` +
        `${proc.exitCode}; ${alive.length} shell process(es) alive): ${proc.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(proc.stdout.toString()) as Record<string, NodeView>;
}

/** One id from a walk, or a thrown error naming which id was absent: an id
 *  missing from the tree parses to `undefined` silently otherwise, and a click
 *  on its coordinates would read as a click at (NaN, NaN) rather than as the
 *  missing-control error it is. `pictures-cli`'s `requireNode`. */
function requireNode(view: Record<string, NodeView>, id: string): NodeView {
  const node = view[id];
  if (node === undefined) throw new Error(`no node with id ${JSON.stringify(id)} in the AT-SPI tree`);
  return node;
}

/** A node's words as one line, whitespace collapsed.
 *
 *  THE NAME IS WHERE THE WORDS ARE. This rig's first run read the summary as
 *  `status bar name="" text="" kids=0` with "40 sections, 2000 words." on the
 *  screen: WebKitGTK prunes a status region's children and the page carried no
 *  accessible name for it, which was a defect this slice fixed. Collapsing the
 *  whitespace is what lets the summary patterns be written against the
 *  catalog's sentence rather than against the bridge's spacing. */
function lineOf(node: NodeView | undefined): string {
  return (node?.text ?? "").replace(/\s+/gu, " ").trim();
}

// -------------------------------------------------------------- the two files

/** Wait for a file to appear at `path` and be COMPLETE.
 *
 *  Complete means: it exists, its size stopped changing between two polls, and
 *  `isComplete` says its bytes end the way that format's bytes end. The host
 *  writes a manuscript with one `write_all` and a `sync_all`, which is not
 *  atomic to an observer -- `export-cli` polls for the trailing newline for
 *  this reason and these two formats are binary, so each brings its own
 *  ending. */
async function awaitFile(
  path: string,
  timeoutMs: number,
  isComplete: (bytes: Buffer) => boolean,
): Promise<{ ms: number; bytes: Buffer }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === lastSize) {
        const bytes = readFileSync(path);
        if (isComplete(bytes)) return { ms: Date.now() - started, bytes };
      }
      lastSize = size;
    }
    await Bun.sleep(SAVE_POLL_MS);
  }
  throw new Error(
    `no complete file appeared at ${path} within ${timeoutMs} ms (last size ${lastSize} bytes).`,
  );
}

/** A zip archive is complete when it carries an end-of-central-directory
 *  record, which is the last thing a writer writes. The signature may be
 *  followed by up to 65535 bytes of comment, so the search is over the tail
 *  rather than at a fixed offset. */
function isCompleteZip(bytes: Buffer): boolean {
  if (bytes.length < 22 || bytes.subarray(0, 2).toString("latin1") !== "PK") return false;
  // THE RECORD HAS TO ADD UP, not merely be present. Those four bytes occur by
  // chance in 13.9 MB of deflate output, and a signature found mid-stream would
  // end the wait on a HALF-WRITTEN archive -- which epubcheck would then report
  // as a broken book, blaming the application for the rig's impatience. The
  // real record ends the file: its comment length must span exactly the bytes
  // that follow it.
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const earliest = Math.max(0, bytes.length - (22 + 65535));
  for (let at = bytes.length - 22; at >= earliest; at -= 1) {
    if (bytes.compare(signature, 0, 4, at, at + 4) !== 0) continue;
    if (at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) return true;
  }
  return false;
}

/** A PDF is complete when it begins with the header and its tail carries the
 *  trailer marker. */
function isCompletePdf(bytes: Buffer): boolean {
  if (bytes.length < 32 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return false;
  return bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1").includes("%%EOF");
}

/** What the CLI's proof export answers for a book that cannot be proofed.
 *
 *  THE SAME PAGINATOR, WITHOUT A WINDOW. `printer.rs` bounds a proof render at
 *  180 seconds and a rig boot outlives the page's ready-sink by 120, so the
 *  rail's own error state at `stress` cannot be reached inside a boot at all --
 *  the application is reaped before it gives up. The CLI has no such ceiling
 *  and reaches the same `render_via`/`render_standalone` bound, so this is
 *  where the refusal is measurable. A run that comes back with exit 0 has found
 *  something: the bound stopped binding, and the rig's own `attemptsProof: false`
 *  is stale. */
function measureProofRefusal(projectPath: string, dest: string): {
  exit: number;
  message: string;
  ms: number;
  timedOut: boolean;
  leftAFile: boolean;
} {
  const started = Date.now();
  const proc = Bun.spawnSync(
    ["xvfb-run", "-a", BIN, "export", projectPath, dest, "--format", "pdf"],
    {
      // The proof needs a display and the compositor is not wanted under Xvfb,
      // exactly as this rig requires for a proof from the CLI.
      env: { ...process.env, WEBKIT_DISABLE_COMPOSITING_MODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: PROOF_REFUSAL_TIMEOUT_MS,
    },
  );
  const said = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  // The host's own sentence, not the whole log: GTK theme warnings and the
  // web process's teardown noise are on the same stream and are not the
  // application's answer.
  const line = said
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes("did not finish within")) ?? said.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const ms = Date.now() - started;
  return {
    exit: proc.exitCode ?? -1,
    message: line,
    ms,
    // The rig's own bound was reached, so the process did not end on its own.
    timedOut: ms >= PROOF_REFUSAL_TIMEOUT_MS,
    leftAFile: existsSync(dest) && statSync(dest).size > 0,
  };
}

interface EpubCheckReport {
  exit: number;
  fatals: number;
  errors: number;
  warnings: number;
}

/** The reading systems' own validator, run over the file the rail saved.
 *
 *  BOTH STREAMS ARE READ. epubcheck prints its tally on stdout and its
 *  diagnostics on stderr; a rig that read one would parse a report with half
 *  its lines missing. An unparsable tally is -1 in all three counts, which
 *  fails the gate rather than passing it -- a validator whose output this rig
 *  cannot read is not a validated book. */
function runEpubCheck(path: string): EpubCheckReport {
  const proc = Bun.spawnSync(["epubcheck", path], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: READER_TIMEOUT_MS,
  });
  const report = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const m = report.match(EPUBCHECK_MESSAGES_PATTERN);
  if (m === null) {
    console.error(`  epubcheck said:\n${report.trim()}`);
    return { exit: proc.exitCode ?? -1, fatals: -1, errors: -1, warnings: -1 };
  }
  return {
    exit: proc.exitCode ?? -1,
    fatals: Number(m[1]),
    errors: Number(m[2]),
    warnings: Number(m[3]),
  };
}

/** poppler's page count for the proof, or -1 when its report cannot be read.
 *  -1 fails the gate: a file no outside reader could count is not a proof. */
function runPdfInfoPages(path: string): number {
  const proc = Bun.spawnSync(["pdfinfo", path], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: READER_TIMEOUT_MS,
  });
  const m = proc.stdout.toString().match(PDFINFO_PAGES_PATTERN);
  if (proc.exitCode !== 0 || m === null) {
    console.error(`  pdfinfo exit ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
    return -1;
  }
  return Number(m[1]);
}

// ------------------------------------------------------------------ the store

const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
     SELECT id, parent_id, type, title, position, 0, position
       FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.type, i.title, i.position,
            w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ${MAX_DEPTH}
   )
   SELECT id, parent_id, type, title, depth FROM walk ORDER BY path`;

interface PmJson {
  type: string;
  text?: string;
  content?: PmJson[];
}

/** The text a stored body holds, by this rig's own walk of the ProseMirror
 *  JSON. `export-cli`'s `storedText`, restated for the same recorded reason:
 *  a reader taken from either side of the comparison would grade a tautology. */
function storedText(body: string): string {
  let out = "";
  const walk = (node: PmJson): void => {
    if (node.type === "text") {
      out += node.text ?? "";
      return;
    }
    if (out.length > 0) out += " ";
    for (const child of node.content ?? []) walk(child);
  };
  walk(JSON.parse(body) as PmJson);
  return out;
}

/** What the book IS, counted from the file: the walked items, and the words in
 *  the bodies those items carry.
 *
 *  THE ORACLE FOR THE RAIL'S SUMMARY LINE. The host counts over the WALKED
 *  items' bodies and not over every `doc` row (`render_project_with`'s own
 *  note), so this counts the same way -- and it counts with the harness's own
 *  `countWords`, which is neither the page's nor the host's. Verified against
 *  both fixtures before the rig was written: 40 items / 2000 words at `tiny`
 *  and 20000 / 1911798 at `stress`, exactly what the CLI's own export reports. */
function bookFigures(projectPath: string): { items: number; words: number } {
  const db = new Database(projectPath, { readonly: true });
  try {
    const walk = db.query(WALK_SQL).all() as { id: string }[];
    const rows = db.query("SELECT item_id, body FROM doc").all() as {
      item_id: string;
      body: string;
    }[];
    const bodies = new Map(rows.map((r) => [r.item_id, r.body]));
    let words = 0;
    for (const item of walk) {
      const body = bodies.get(item.id);
      if (body !== undefined) words += countWords(storedText(body));
    }
    return { items: walk.length, words };
  } finally {
    db.close();
  }
}

/** The tokens of the chapter-style meta row, or none when the row is absent
 *  (which is the plainest book and this fixture's starting state). */
function chapterTokens(projectPath: string): string[] {
  const db = new Database(projectPath, { readonly: true });
  try {
    const row = db
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(CHAPTER_META_KEY);
    return (row?.value ?? "").split(/\s+/u).filter(Boolean);
  } finally {
    db.close();
  }
}

// -------------------------------------------------------------------- the run

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; preview run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} -- build it or generate the fixture before running.`);
    process.exit(1);
  }
}
for (const tool of ["epubcheck", "pdfinfo", "xdotool", "python3"]) {
  const found = Bun.spawnSync(["which", tool], { stdout: "pipe", stderr: "pipe" });
  if (found.exitCode !== 0) {
    console.error(
      `missing ${tool}: this rig grades the two saved files with outside readers and cannot ` +
        "grade them without one.",
    );
    process.exit(1);
  }
}
{
  const preexisting = survivingShellPids();
  if (preexisting.length > 0) {
    console.error(
      `refusing to start: ${SHELL_PROC_NAME} already running (pid(s) ${preexisting.join(", ")}).`,
    );
    process.exit(1);
  }
}

root = mkdtempSync(join(tmpdir(), "app-preview-"));
const projectPath = join(root, "book.db");
const outDir = join(root, "out");
mkdirSync(outDir, { recursive: true });
const epubPath = join(outDir, "book.epub");
const pdfPath = join(outDir, "book.pdf");

console.log(`[1/5] seeding project from ${FIXTURE}`);
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`);
}

const figures = bookFigures(projectPath);
if (figures.items === 0 || figures.words === 0) {
  abort(
    `VACUITY GUARD: the seeded project walks ${figures.items} item(s) holding ${figures.words} ` +
      "word(s). A summary line agreeing with zero would pass while proving nothing.",
  );
}
console.log(`  the store says ${figures.items} item(s), ${figures.words} word(s)`);

{
  // The toggle act must MOVE something. A fixture that already had the option
  // on would let `option_toggle_lands` pass on a click that did nothing.
  const before = chapterTokens(projectPath);
  if (before.includes(CAPS_TITLE_TOKEN)) {
    abort(
      `the seeded project already has ${JSON.stringify(CAPS_TITLE_TOKEN)} in its ` +
        `${CHAPTER_META_KEY} row: the toggle gate would pass on a click that changed nothing.`,
    );
  }
  console.log(`  ${CHAPTER_META_KEY} starts as [${before.join(", ")}]`);
}

interface InteractiveSinkPayload {
  ready: boolean;
  error?: string;
  candidate: string;
  seed: string;
  mode: string;
  run: "interactive";
  rows: number;
  startup_ms: number;
  item_id: string | null;
}

// Filled inside onReady, read after runShell returns.
let epubRailName = "";
let epubSummaryText = "";
let epubSummaryItems = -1;
let epubSummaryWords = -1;
let togglePressed = false;
let epubSaveMs = 0;
let proofRailName = "";
let proofSummaryText = "";
let proofLeaves = 0;
let proofSaveMs = 0;
let proofSummaryItems = -1;
let proofSummaryWords = -1;
let proofRailWalks = 0;
let proofRailWallMs = 0;
let toggleMetaTokens: string[] = [];
/** The first act that failed while the application was still standing, or
 *  null. Recorded into the result beside the zeroes it explains. */
let actFailed: string | null = null;

console.log(
  `\n[2/5] booting: File > EPUB preview, the Capitals option, Save as, then File > PDF proof and Save as`,
);
let outcome: RunOutcome<InteractiveSinkPayload>;
try {
  outcome = await runShell<InteractiveSinkPayload>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("preview rig requires a fixed X display");
      const display = `:${displayNum}`;

      // Before any dialog exists, while the exactly-one guard still means
      // something -- a GTK dialog inherits this application's WM_CLASS.
      const wid = findWindowId(display);
      resizeWindow(display, wid, PANEL_WINDOW);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["windowfocus", wid]);
      const focused = xdoRead(display, ["getwindowfocus"]).trim();
      if (focused !== wid) {
        throw new Error(
          `refusing to send keys: keyboard focus is window ${focused}, not the app's ${wid}. ` +
            "Whatever is focused would receive them.",
        );
      }

      // EVERY ACT FROM HERE IS RECORDED RATHER THAN THROWN, and that is the
      // difference between a red gate and no evidence at all. A dialog that
      // never opens, a control that is not in the tree, a file that never
      // appears: each of those is the application failing at something this
      // rig grades, and aborting on it would leave YESTERDAY's green result in
      // place with nothing to say that today's run found a broken preview.
      // What still aborts is the rig failing: if the application is GONE, the
      // remaining acts cannot be attempted and their zeroes would be the rig's
      // own fault rather than a finding.
      const record = async (act: string, body: () => Promise<void>): Promise<void> => {
        if (actFailed !== null) {
          console.error(`  skipping ${act}: ${actFailed}`);
          return;
        }
        try {
          await body();
        } catch (error: unknown) {
          const alive = survivingShellPids();
          if (alive.length === 0) throw error;
          actFailed = `${act}: ${String(error)}`;
          console.error(`  ${actFailed}`);
        }
      };

      // ---- act (a): the EPUB rail ---------------------------------------
      // BY MENU ID through the shared driver, which reads the item's index out
      // of `menu-bar.ts`: an item inserted above the previews moves this with
      // it rather than opening whatever now sits at a restated index. Nothing
      // is typed and nothing is clicked -- the rail takes focus itself and
      // renders from the host the moment it opens.
      const driver = menuDriver(display, wid, xdo);
      await driver.activate("menu-epub-preview");

      const railIds = [RAIL_ID, SUMMARY_ID, FLAG_ID, SAVE_AS_ID];
      let railView: Record<string, NodeView> = {};
      {
        // THE RENDER FIRST, THEN THE WALK. A whole EPUB is rendered, unzipped
        // and parsed into the page before the summary says anything, and a
        // walk taken mid-render reads an empty rail -- which is the recorded
        // shape of a capture that reads as a broken feature.
        await Bun.sleep(timing.epubRailSettleMs);
        for (let attempt = 1; ; attempt += 1) {
          railView = readNodeView(rootPid, railIds);
          epubSummaryText = lineOf(railView[SUMMARY_ID]);
          epubRailName = lineOf(railView[RAIL_ID]);
          const m = epubSummaryText.match(EPUB_SUMMARY_PATTERN);
          // BOTH READINGS, OR NEITHER. An EMPTY name is the bridge failing, not
          // the page: at `stress` the same walk that reads the summary
          // perfectly intermittently answers "" for the rail's own name, and
          // asked for that node alone it has also thrown on the role while
          // returning the name. A WRONG name is a non-empty string and fails
          // the gate on the first reading, which is the case that matters; an
          // empty one is worth one more walk before it is called a verdict.
          if (m !== null && epubRailName.length > 0) {
            epubSummaryItems = Number(m[1]);
            epubSummaryWords = Number(m[2]);
            break;
          }
          if (attempt >= EPUB_RAIL_WALK_MAX) {
            console.error(
              `  after ${attempt} walk(s) the rail reads name=${JSON.stringify(epubRailName)} ` +
                `summary=${JSON.stringify(epubSummaryText)}; going on so the rest of the boot ` +
                "is measured.",
            );
            break;
          }
          await Bun.sleep(timing.epubRailRetryMs);
        }
      }
      console.log(`  rail "${epubRailName}" says ${JSON.stringify(epubSummaryText)}`);

      // ---- act (b): the Capitals option ---------------------------------
      await record("the Capitals option", async () => {
      // A CLICK ON THE OPTION, not a keystroke: the rail focuses itself and a
      // counted Tab into a row of four ornaments and three flags would land by
      // arithmetic on a layout nobody pinned.
      clickAt(display, wid, requireNode(railView, FLAG_ID));
      // The option is recorded through the host and the rail RE-RENDERS the
      // whole book from the answer, so this waits for that render and not for
      // the click.
      await Bun.sleep(timing.toggleRepaintMs);
      {
        const after = readNodeView(rootPid, [FLAG_ID, SAVE_AS_ID]);
        togglePressed = requireNode(after, FLAG_ID).pressed;
        // The save control's coordinate is re-read in the same walk: the head
        // does not move on a repaint, but reading it here costs nothing and a
        // stale coordinate would click into the book.
        railView = { ...railView, ...after };
      }
      toggleMetaTokens = chapterTokens(projectPath);
      console.log(
        `  Capitals pressed=${togglePressed}, ${CHAPTER_META_KEY} = [${toggleMetaTokens.join(", ")}]`,
      );
      });

      // ---- act (c): Save as, as an EPUB ---------------------------------
      await record("saving the archive", async () => {
      clickAt(display, wid, requireNode(railView, SAVE_AS_ID));
      const epubDialog = await waitForDialog(display, EPUB_DIALOG_TITLE);
      xdo(display, ["windowfocus", epubDialog]);
      await Bun.sleep(400);
      // ctrl+a first, then an absolute path: a GTK save dialog's name entry
      // accepts one and treats it as one, and the default name is selected in
      // most themes and not in all of them -- typing over an unselected
      // default would produce a path nobody chose. `dialog-cli`'s route.
      xdo(display, ["key", "--window", epubDialog, "ctrl+a"]);
      await Bun.sleep(200);
      xdo(display, ["type", "--window", epubDialog, "--delay", "20", epubPath]);
      await Bun.sleep(400);
      const epubStarted = Date.now();
      xdo(display, ["key", "--window", epubDialog, "Return"]);
      {
        const written = await awaitFile(epubPath, timing.epubSaveTimeoutMs, isCompleteZip);
        // From the Return to a complete file, which is the whole of what a
        // writer waits through: the dialog's own dismissal, the render, the
        // container write and the fsync.
        epubSaveMs = Date.now() - epubStarted;
        console.log(`  wrote ${written.bytes.length} byte(s) of EPUB in ${epubSaveMs} ms`);
      }
      await Bun.sleep(CLICK_SETTLE_MS);
      });

      // ---- act (d): the proof, and its own Save as ----------------------
      if (!timing.attemptsProof) {
        console.log(
          "  the proof rail is not opened at this fixture: a book this size does not paginate " +
            "inside the host's 180-second bound, and a boot does not outlive that bound. The " +
            "refusal is measured after the boot instead, and it is GRADED.",
        );
        return;
      }
      await record("the proof", async () => {
      // REAL INPUT AFTER A DIALOG: every menu chord from here goes through
      // XTEST, because `xdotool key --window` reaches nothing once a GTK
      // dialog has held the keyboard grab. `pictures-cli`'s finding.
      xdo(display, ["windowfocus", wid]);
      await Bun.sleep(400);
      const refocused = xdoRead(display, ["getwindowfocus"]).trim();
      if (refocused !== wid) {
        throw new Error(
          `refusing to open the proof: keyboard focus is window ${refocused}, not the app's ${wid}.`,
        );
      }
      const xtestDriver = menuDriver(display, wid, xtest);
      const proofStartedWall = Date.now();
      await xtestDriver.activate("menu-pdf-preview");

      {
        // A PROOF COSTS MORE THAN AN ARCHIVE and this is the reading nobody
        // has taken: the host loads the book into a SECOND web view, that
        // document's own script cuts it into leaves, and only then is there a
        // summary to read.
        await Bun.sleep(timing.proofRailSettleMs);
        const walksBefore = walksTaken;
        for (let attempt = 1; ; attempt += 1) {
          const view = readNodeView(rootPid, [RAIL_ID, SUMMARY_ID, SAVE_AS_ID]);
          proofRailName = lineOf(view[RAIL_ID]);
          proofSummaryText = lineOf(view[SUMMARY_ID]);
          const m = proofSummaryText.match(PDF_SUMMARY_PATTERN);
          // The rail's name and its sentence together, act (a)'s rule.
          if (m !== null && proofRailName.length > 0) {
            proofLeaves = Number(m[1]);
            proofSummaryItems = Number(m[2]);
            proofSummaryWords = Number(m[3]);
            railView = { ...railView, ...view };
            break;
          }
          if (attempt >= PROOF_RAIL_WALK_MAX || walksTaken >= WALK_CAP) {
            console.error(
              `  the proof summary still reads ${JSON.stringify(proofSummaryText)} after ` +
                `${attempt} walk(s) and ${Date.now() - proofStartedWall} ms.`,
            );
            railView = { ...railView, ...view };
            break;
          }
          await Bun.sleep(timing.proofRailRetryMs);
        }
        proofRailWalks = walksTaken - walksBefore;
        proofRailWallMs = Date.now() - proofStartedWall;
      }
      console.log(
        `  rail "${proofRailName}" says ${JSON.stringify(proofSummaryText)} ` +
          `(${proofRailWalks} walk(s), ~${proofRailWallMs} ms)`,
      );

      clickAt(display, wid, requireNode(railView, SAVE_AS_ID));
      const pdfDialog = await waitForDialog(display, PDF_DIALOG_TITLE);
      xdo(display, ["windowfocus", pdfDialog]);
      await Bun.sleep(400);
      xdo(display, ["key", "--window", pdfDialog, "ctrl+a"]);
      await Bun.sleep(200);
      xdo(display, ["type", "--window", pdfDialog, "--delay", "20", pdfPath]);
      await Bun.sleep(400);
      const pdfStarted = Date.now();
      xdo(display, ["key", "--window", pdfDialog, "Return"]);
      {
        const written = await awaitFile(pdfPath, timing.proofSaveTimeoutMs, isCompletePdf);
        proofSaveMs = Date.now() - pdfStarted;
        console.log(`  wrote ${written.bytes.length} byte(s) of PDF in ${proofSaveMs} ms`);
      }
      await Bun.sleep(CLICK_SETTLE_MS);
      });
    },
  });
} catch (error: unknown) {
  abort(`the boot failed after ${walksTaken} AT-SPI walk(s): ${String(error)}`);
}

let refusal = { exit: 0, message: "", ms: 0, timedOut: false, leftAFile: false };
if (!timing.attemptsProof) {
  console.log(
    `\n[3/5] measuring the refusal: the CLI's own proof export of the same book, ` +
      `bounded at ${PROOF_REFUSAL_TIMEOUT_MS} ms`,
  );
  refusal = measureProofRefusal(projectPath, join(outDir, "refused.pdf"));
  console.log(
    `  exit ${refusal.exit} after ${refusal.ms} ms${refusal.timedOut ? " (killed: it did not exit)" : ""}: ` +
      `${JSON.stringify(refusal.message)}; file left behind: ${refusal.leftAFile}`,
  );
}

console.log(`\n[3/5] reading the two files back with epubcheck and pdfinfo`);
const epubBytes = existsSync(epubPath) ? statSync(epubPath).size : 0;
const pdfBytes = existsSync(pdfPath) ? statSync(pdfPath).size : 0;
const epubReport = epubBytes > 0
  ? runEpubCheck(epubPath)
  : { exit: -1, fatals: -1, errors: -1, warnings: -1 };
const pdfPages = pdfBytes > 0 ? runPdfInfoPages(pdfPath) : -1;
console.log(
  `  epubcheck exit ${epubReport.exit}: ${epubReport.fatals} fatal(s), ${epubReport.errors} ` +
    `error(s), ${epubReport.warnings} warning(s)`,
);
console.log(`  pdfinfo counts ${pdfPages} page(s); the rail said ${proofLeaves} leaf(leaves)`);

const metrics: PreviewMetrics = {
  fixture,
  epub_rail_name: epubRailName,
  epub_rail_expected_name: EPUB_RAIL_NAME,
  epub_summary_text: epubSummaryText,
  epub_summary_items: epubSummaryItems,
  epub_summary_words: epubSummaryWords,
  store_items: figures.items,
  store_words: figures.words,
  toggle_pressed: togglePressed,
  toggle_meta_tokens: toggleMetaTokens,
  toggle_expected_token: CAPS_TITLE_TOKEN,
  proof_attempted: timing.attemptsProof,
  proof_rail_name: proofRailName,
  proof_rail_expected_name: PDF_RAIL_NAME,
  proof_summary_items: proofSummaryItems,
  proof_summary_words: proofSummaryWords,
  proof_refusal_exit: refusal.exit,
  proof_refusal_message: refusal.message,
  proof_refusal_ms: refusal.ms,
  proof_refusal_timed_out: refusal.timedOut,
  proof_refusal_left_a_file: refusal.leftAFile,
  epub_save_ms: epubSaveMs,
  epub_bytes: epubBytes,
  epubcheck_exit: epubReport.exit,
  epubcheck_fatals: epubReport.fatals,
  epubcheck_errors: epubReport.errors,
  epubcheck_warnings: epubReport.warnings,
  proof_leaves: proofLeaves,
  pdfinfo_pages: pdfPages,
  proof_save_ms: proofSaveMs,
  proof_bytes: pdfBytes,
  proof_rail_walks: proofRailWalks,
  proof_rail_wall_ms: proofRailWallMs,
  preview_rss_mb: outcome.peakRssMb,
};

const verdicts = evaluatePreviewGates(metrics);
console.log(
  `\n[4/5] verdicts (${walksTaken} AT-SPI walk(s) in the boot, cap ${WALK_CAP}; ` +
    `${walkMs.join(", ")} ms each)`,
);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

const path = writeResult(
  buildResult({
    runId: `app-preview-${fixture}`,
    candidate: "tauri",
    fixture,
    workload: "app-preview",
    verdicts,
    metrics: {
      ...metrics,
      proof_summary_text: proofSummaryText,
      atspi_walks: walksTaken,
      atspi_walk_cap: WALK_CAP,
      atspi_walk_ms: walkMs,
      act_failed: actFailed,
      startup_ms: outcome.payload.startup_ms,
      rows: outcome.payload.rows,
      omitted_gates:
        "latency, stall, cliff, a11y_exposure: one boot that opens two previews and saves two " +
        "files has nothing true to say about frame cadence.",
      scope:
        "epub_save_ms and proof_save_ms are measured from the Return that dismisses each save " +
        "dialog to a file on disk that is stable across two polls and carries its format's own " +
        "terminator (the archive's end-of-central-directory record, the proof's %%EOF). Each " +
        "therefore covers the render and the write, and each is polled at 100 ms, so it carries " +
        "up to that much of the rig's own sleep and is an upper bound rather than a precise " +
        "figure. It does NOT bracket the host's fsync: `write_manuscript` syncs after the bytes " +
        "are visible, so a poll can see a complete file before `sync_all` returns. " +
        "proof_rail_wall_ms is the rail's own render at AT-SPI polling granularity: DIAGNOSTIC " +
        "and never gated, because a figure polled at 20-120 s intervals is mostly this rig's " +
        "own sleep. preview_rss_mb is the summed process tree, which is where the proof's " +
        "second web view lives.",
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

console.log(`\n[5/5] recorded: ${path}`);
rmSync(root, { recursive: true, force: true });
// AN UNKNOWN IS NOT A PASS. This rig emits none of its own, but a fixture added
// without its threshold lines would produce them, and a run of all-UNKNOWN
// would otherwise exit 0 and read as green.
process.exit(verdicts.some((v) => v.verdict !== "PASS") ? 1 : 0);
