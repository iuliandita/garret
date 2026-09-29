// app/harness/src/pictures-cli.ts
// Graded run over the ONE surface the pictures record and the covers record
// both said, in their own words, had never been graded: a photograph
// attached through the host's own OS dialog, an oversize one refused, and a
// cover set on the book -- and, alongside all three, the host's own memory
// while it decodes a 49-megapixel file.
//
// ONE BOOT, FIVE WALKS, none of them while a dialog is up -- one over the
// recorded four-walk comfort line, and stated: walk 1 locates `#cast-edit`
// (a counted Tab to it landed elsewhere), and walk 2, right after that
// press, reads BOTH `#cast-picture-choose` and `#cast-save`'s coordinates in
// one pass. Act (a) attaches the 49-megapixel photograph with the cached
// choose coordinate. Walk 2, right after, reads the MOVED
// `#cast-picture-choose` coordinate (the layout shifted once a thumbnail
// replaced the "no picture" paragraph) and `#cast-picture`'s accessible name
// in the same pass. Act (b) attaches the oversize photograph with that
// coordinate and is refused; walk 3, right after its dialog closes, reads
// the refusal banner's text, before the Escape that dismisses it. Act (d)
// sets the front cover through counted keystrokes (XTEST, see below); walk 4,
// at the very end, reads the covers panel's text. Every act that reaches a
// dialog follows `dialog-cli`'s hard rule: ONE walk before it opens (never
// while it is up) -- several walks in one window have killed the application
// outright, and a GTK dialog inherits this application's WM_CLASS, so
// `findWindowId` while one is open sees two windows and reads a MISSING
// window as an extra one.
//
// Every photograph is GENERATED into the run's scratch with `png.ts`'s
// `writePng` -- a two-colour gradient, never committed -- because a fixture
// this large in the repository is a file every clone pays for and nobody can
// diff, `bible-cli`'s own reason for generating its 3000x2000.
//
// `#cast-picture-state` DOES NOT CARRY THE "PRESENT" SENTENCE. Read
// `cast-panel.ts`'s `paintPicture`: that paragraph is appended to the DOM
// only when `view.data_uri === null` (the none/missing/unreadable states),
// and the host sends a `data_uri` only with `present` -- so a present
// picture is drawn as `<img id="cast-picture">` and the paragraph is never
// in the tree at all. The plan that named this rig assumed a sentence that
// does not exist in `en.ts` for that state. The RIG is corrected here: what
// AT-SPI can actually say about "present" is the image node's own accessible
// name (`cast.picture.alt`, "Picture of {name}"), restated below and read
// off the tree instead.
//
// THE OVERSIZE REFUSAL NEVER TOUCHES #cast-picture-state EITHER. The pick
// promise rejects; `cast-panel.ts`'s `.catch` calls `onNotice` and nothing
// else, so the picture block is left exactly as act (a) painted it. What
// carries the refusal is the notice banner (`banner.ts`, id `open-error`,
// tone `problem`) -- and a `problem` banner is NOT auto-dismissed
// (`INFO_BANNER_MS` only fires for tone `info`), so there is no race against
// its removal the way an `info` banner would force.
//
// Usage: APP_GUI=1 bun app/harness/src/pictures-cli.ts
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { PY_READ_NODES, PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { PICTURES_THUMB_MAX, evaluatePicturesGates, type PicturesMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { pngSize, writePng } from "./png";
import { buildResult, writeResult } from "./results";
import { treePids } from "./rss";
import { BIN, SHELL_PROC_NAME, type RunOutcome, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** Restated from `pictures.rs`, deliberately not imported -- the harness's
 *  usual rule for every threshold it grades against. */
const MAX_PICTURE_BYTES = 16 * 1024 * 1024;

/** Restated from `commands/dialogs.rs`'s `PICTURE_DIALOG_TITLE`. Both the
 *  cast photograph and the cover share this one dialog and this one title. */
const PICTURE_DIALOG_TITLE = "Choose a picture";

const CAST_NAME = "Marisol Quillfeather";
/** 7000x7000 = 49,000,000 pixels: under the 50,000,000 bound on purpose, so a
 *  picture AT the bound is not what this rig tests -- that comparison
 *  operator is the host's own unit test's job. */
const PICTURE_W = 7000;
const PICTURE_H = 7000;
/** 7100x7100 = 50,410,000 pixels: OVER `pictures.rs`'s 50,000,000 bound. */
const OVERSIZE_W = 7100;
const OVERSIZE_H = 7100;
/** The trade page's cover: right shape (600x900 = 2:3, the fixture's own
 *  trim), short of print resolution -- `shot-cli --covers`'s own pair,
 *  restated. */
const COVER_W = 600;
const COVER_H = 900;

/** Between counted keystrokes, bible-cli's own figure. */
const TAB_STEP_MS = 250;
const SETTLE_MS = 2500;
const SAVE_MS = 1500;
const DIALOG_WAIT_MS = 12_000;
const DIALOG_POLL_MS = 250;
/** How long past the dialog closing to keep polling `VmHWM`: the decode
 *  and the page's own render of the thumbnail both happen after Return, not
 *  the instant the dialog goes away. */
const POST_DIALOG_POLL_MS = 2000;
const HWM_POLL_MS = 20;

/** Wide enough for the cast and covers panels' forms to sit inside the
 *  window, `bible-cli`'s own `PANEL_WINDOW`, restated. */
const PANEL_WINDOW = { w: 1200, h: 900 };

function gitShortSha(): string {
  const proc = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Restated from `pictures::dir_for`: the project's stem plus
 *  `PICTURES_SUFFIX`, beside the project file. */
function picturesDirFor(projectPath: string): string {
  return join(dirname(projectPath), `${basename(projectPath, extname(projectPath))}.pictures`);
}

/** Restated from `pictures::thumb_of`: every stored name ends in a
 *  four-character extension, and the thumbnail's name is the stem plus
 *  `THUMB_SUFFIX`. Only ever called on a name the host itself wrote. */
function thumbNameOf(stored: string): string {
  return `${stored.slice(0, -4)}.thumb.png`;
}

/** A camera-shaped fixture with no committed bytes: colour depends only on
 *  `x`, so every row is identical and the file compresses to a fraction of
 *  its raw size -- `bible-cli`'s own reason for a gradient over a flat
 *  field, at a size that would otherwise cost tens of megabytes raw. */
function twoColourGradient(width: number): (x: number, y: number) => [number, number, number] {
  const a: [number, number, number] = [30, 60, 120];
  const b: [number, number, number] = [230, 210, 160];
  return (x: number, _y: number) => {
    const t = width <= 1 ? 0 : x / (width - 1);
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  };
}

/** The pid of the application's own process under `rootPid`: the one whose
 *  comm is `SHELL_PROC_NAME`, or `rootPid` itself when that is it. */
function hostProcessOf(rootPid: number): number {
  for (const pid of [rootPid, ...treePids(rootPid)]) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === SHELL_PROC_NAME) return pid;
    } catch {
      // gone between listing and reading
    }
  }
  throw new Error(`no process named ${SHELL_PROC_NAME} under pid ${rootPid}: the host was expected to be running`);
}

function readVmHwmKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
    return m !== null ? Number(m[1]) : 0;
  } catch {
    return 0; // process gone or not readable
  }
}

/** The samples where the value CHANGED (VmHWM is monotone), plus the first
 *  and last -- a committed series that grows with sample count instead of
 *  with what actually happened. */
function boundedSteps(samplesMb: number[]): number[] {
  if (samplesMb.length === 0) return [];
  const steps: number[] = [samplesMb[0]!];
  for (let i = 1; i < samplesMb.length; i++) {
    if (samplesMb[i] !== samplesMb[i - 1]) steps.push(samplesMb[i]!);
  }
  const last = samplesMb[samplesMb.length - 1]!;
  if (steps[steps.length - 1] !== last) steps.push(last);
  return steps;
}

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

/** `xdo`, with `--window <wid>` stripped from ANY verb it is given. Real
 *  input after a dialog: `xdotool key/type --window` (a synthetic
 *  XSendEvent) reaches nothing once a GTK dialog has taken the keyboard
 *  grab away, while clicks and window-targetless keys (XTEST) reach the
 *  focused window regardless -- six captures showed the menu never opening
 *  and the panel never closing before this was found. One wrapper for both
 *  the menu driver and bare keys, rather than two private copies of the
 *  same strip. */
function xtest(display: string, args: string[]): void {
  const i = args.indexOf("--window");
  xdo(display, i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)]);
}

/** Windows carrying a title, without `findWindowId`'s exactly-one guard: a
 *  search that finds nothing is a legitimate answer here, `dialog-cli`'s own
 *  reason. */
function windowsTitled(display: string, title: string): string[] {
  const proc = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", `^${title}$`], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout.toString().trim().split("\n").filter(Boolean);
}

async function waitForDialog(display: string, title: string): Promise<string | null> {
  const deadline = Date.now() + DIALOG_WAIT_MS;
  while (Date.now() < deadline) {
    const found = windowsTitled(display, title);
    if (found.length > 0) return found[0] ?? null;
    await Bun.sleep(DIALOG_POLL_MS);
  }
  return null;
}

/** Ask for a window size and read it back -- an unhonoured resize leaves every
 *  coordinate below computed against a window that does not exist,
 *  `bible-cli`'s own guard. */
function resizeWindow(display: string, wid: string, size: { w: number; h: number }): void {
  xdo(display, ["windowsize", wid, String(size.w), String(size.h)]);
  const geometry = xdoRead(display, ["getwindowgeometry", "--shell", wid]);
  const height = Number(geometry.match(/\bHEIGHT=(\d+)/)?.[1] ?? 0);
  const width = Number(geometry.match(/\bWIDTH=(\d+)/)?.[1] ?? 0);
  if (height !== size.h || width !== size.w) {
    throw new Error(
      `the window is ${width}x${height} after asking for ${size.w}x${size.h}: every coordinate ` +
        `in this rig assumes the size it asked for.`,
    );
  }
}

function clickAt(display: string, wid: string, rect: { x: number; y: number; w: number; h: number }): void {
  const x = Math.round(rect.x + rect.w / 2);
  const y = Math.round(rect.y + rect.h / 2);
  // A BARE click, never `click --window`: with the flag xdotool sends a
  // synthetic event through XSendEvent and WebKit/GTK drop it silently.
  xdo(display, ["mousemove", "--window", wid, String(x), String(y)]);
  xdo(display, ["click", "1"]);
}

interface NodeInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/** Geometry AND accessible text, by DOM id, in ONE walk. Every id in `ids`
 *  that exists anywhere in the tree is returned with its window-coordinate
 *  extents (0x0 if the node has no Component interface, e.g. it is hidden)
 *  and its name-or-own-text. This is the walk this rig actually needs for a
 *  control it must both click and read: `locateNodes`' own header records
 *  that several AT-SPI walks in one window have killed the application
 *  outright, so a click coordinate and the text beside it are read together
 *  rather than in two passes. */
const PY_NODE_INFO = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
wanted = set(sys.argv[2].split(","))

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

found = {}

def walk(node):
    try:
        i = ident(node)
        if i in wanted and i not in found:
            info = extents(node)
            info["text"] = node.name or own_text(node)
            found[i] = info
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

function readNodeInfo(rootPid: number, ids: readonly string[]): Record<string, NodeInfo> {
  const proc = Bun.spawnSync(["python3", "-c", PY_NODE_INFO, pidListArg(rootPid), ids.join(",")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const alive = survivingShellPids();
    throw new Error(
      `could not read node info from AT-SPI for [${ids.join(", ")}] (exit ${proc.exitCode}; ` +
        `${alive.length} shell process(es) alive): ${proc.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(proc.stdout.toString()) as Record<string, NodeInfo>;
}

/** One of `ids` from a `readNodeInfo` walk, or a thrown error naming which
 *  id came back empty: an id absent from the tree parses to `undefined`
 *  silently otherwise, and a click on `undefined`'s coordinates would read
 *  as a click at (NaN, NaN) rather than as the missing-control error it is. */
function requireNode(info: Record<string, NodeInfo>, id: string): NodeInfo {
  const node = info[id];
  if (node === undefined) throw new Error(`no node with id "${id}" in the AT-SPI tree`);
  return node;
}

/** Text by DOM id, `home-cli`/`timeline-cli`/`cast-hover.ts`'s own
 *  `PY_READ_NODES` shape, restated here per this harness's rule that a
 *  probe belongs to the rig that reads it. `locateNodes`'s role-restricted
 *  walk cannot see the notice banner (role "status") -- this one matches by
 *  id alone and reaches it. */
function readNodeTexts(rootPid: number, ids: readonly string[]): Record<string, string> {
  try {
    const proc = Bun.spawnSync(["python3", "-c", PY_READ_NODES, pidListArg(rootPid), ids.join(",")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return {};
    return JSON.parse(proc.stdout.toString()) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Every accessible name and leaf text under the node carrying the DOM id in
 *  argv[2], one per line. `castCardText`'s shape, walking EVERY matched
 *  application entry (after a GTK file dialog the pid registers more than
 *  once). Module-level so `py-scripts.test` sees it as a spliced walk. */
const PY_COLLECT_UNDER = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
target_id = sys.argv[2]
${PY_SELECT_APPS}
def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""
root = None
def find(node):
    global root
    try:
        if root is not None:
            return
        if ident(node) == target_id:
            root = node
            return
        for k in range(node.childCount):
            find(node.getChildAtIndex(k))
    except Exception:
        pass
# EVERY matched entry, PY_READ_NODES's shape: after a GTK file dialog the
# application's pid is registered more than once, and "exactly one" found
# nothing (exit 5) on a panel the id reader was reading at the same moment.
for app in matched:
    find(app)
if root is None:
    sys.exit(5)
names = []
def collect(node):
    try:
        if node.name:
            names.append(node.name)
        elif node.childCount == 0:
            # A paragraph carries its words through the Text interface, not
            # as a name; the first green run read the panel back as "".
            try:
                text = node.queryText().getText(0, -1) or ""
            except Exception:
                text = ""
            if text.strip():
                names.append(text)
        for k in range(node.childCount):
            collect(node.getChildAtIndex(k))
    except Exception:
        pass
collect(root)
sys.stdout.write("\n".join(names))
`;

function collectNamesUnder(rootPid: number, targetId: string): string {
  const proc = Bun.spawnSync(
    [
      "python3",
      "-c",
      PY_COLLECT_UNDER,
      pidListArg(rootPid),
      targetId,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
}

/** The `cast_member.picture_path` for the member named `name`, read with a
 *  short retry against `SQLITE_BUSY`: the host holds this file open for the
 *  whole boot, and a read taken between two of its own statements can catch
 *  it mid-write. Used ONLY to bracket the oversize act with two readings
 *  taken at two different times -- the "before" and "after" a single
 *  post-teardown read cannot tell apart. */
async function probePicturePath(dbPath: string, name: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .query<{ picture_path: string | null }, [string]>(
            "SELECT picture_path FROM cast_member WHERE name = ?1",
          )
          .all(name);
        return rows[0]?.picture_path ?? null;
      } finally {
        db.close();
      }
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`could not read picture_path for "${name}" after 20 retries against a busy store`);
}

/** Original (non-thumbnail) files in the pictures directory, so the oversize
 *  act's own file-count bracket does not have to guess at a count taken
 *  after the whole boot -- act (d)'s cover would already have been added by
 *  then. */
function originalFilesIn(picturesDir: string): number {
  if (!existsSync(picturesDir)) return 0;
  return readdirSync(picturesDir).filter((n) => !n.endsWith(".thumb.png")).length;
}

// ---------------------------------------------------------------------------
// THE RESTATED ENGLISH SENTENCES. Restated from app/ui/src/i18n/en.ts and
// app/ui/src/covers.ts's callers, deliberately NOT imported -- the harness's
// usual rule for every threshold and every string it grades a page against.

/** `cast.picture.alt`: "Picture of {name}". */
function castPictureAlt(name: string): string {
  return `Picture of ${name}`;
}
/** `cast.error.picture`: "Could not change the picture, and nothing was
 *  changed: {error}". */
function castErrorPicture(error: string): string {
  return `Could not change the picture, and nothing was changed: ${error}`;
}
/** `covers.check.resolution`: "{width} x {height} pixels is about {dpi} dpi
 *  on this page. Print wants {wanted} dpi, which is {wantedWidth} x
 *  {wantedHeight} pixels." Filled for a 600x900 cover on the fixture's 6x9in
 *  trade page at PRINT_DPI 300: dpi 100 (600/6in), wanted 1800x2700
 *  (`covers.rs`'s own test asserts this pair for the same page). Right
 *  shape (600:900 = 2:3 = 6:9), so the SHAPE finding never fires and this is
 *  the only sentence the panel says about this cover. */
const COVER_EXPECTED_SENTENCE =
  "600 x 900 pixels is about 100 dpi on this page. Print wants 300 dpi, which is 1800 x 2700 pixels.";

// ---------------------------------------------------------------------------

let root = "";
function abort(message: string): never {
  console.error(`\n${message}\nNothing was written.`);
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; pictures run skipped (needs a display and a built shell).");
  process.exit(0);
}
for (const p of [BIN, DIST, FIXTURE]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} -- build it or generate the fixture before running.`);
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

root = mkdtempSync(join(tmpdir(), "app-pictures-"));
const projectPath = join(root, "book.db");
const picsDir = join(root, "pics");
mkdirSync(picsDir, { recursive: true });

console.log(`[1/6] seeding project from ${FIXTURE}`);
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`);
}

{
  const db = new Database(projectPath, { readonly: true });
  try {
    const withPicture = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM cast_member WHERE picture_path IS NOT NULL",
      )
      .all()[0]!.n;
    if (withPicture > 0) {
      abort("the seeded project already has a member with a picture: act (a) would be attaching " +
        "over one that is already there, and the attach gate would be about the wrong file.");
    }
  } finally {
    db.close();
  }
}

console.log(`[2/6] generating ${PICTURE_W}x${PICTURE_H}, ${OVERSIZE_W}x${OVERSIZE_H} and ${COVER_W}x${COVER_H} photographs`);
const photoOkPath = join(picsDir, "photo-49mp.png");
const photoOversizePath = join(picsDir, "photo-51mp.png");
const coverPath = join(picsDir, "cover-600x900.png");
await Bun.write(photoOkPath, writePng(PICTURE_W, PICTURE_H, twoColourGradient(PICTURE_W)));
await Bun.write(photoOversizePath, writePng(OVERSIZE_W, OVERSIZE_H, twoColourGradient(OVERSIZE_W)));
await Bun.write(coverPath, writePng(COVER_W, COVER_H, twoColourGradient(COVER_W)));
{
  const bytes = statSync(photoOkPath).size;
  if (bytes > MAX_PICTURE_BYTES) {
    abort(
      `the generated 49-megapixel photograph is ${bytes} bytes, over MAX_PICTURE_BYTES ` +
        `(${MAX_PICTURE_BYTES}): the gradient did not compress the way this rig expected, and ` +
        "attaching it would exercise the byte ceiling this rig is not testing.",
    );
  }
  console.log(`  ${photoOkPath}: ${bytes} bytes`);
}
{
  // The oversize refusal has to be attributable to the PIXEL bound alone: a
  // file that also tripped MAX_PICTURE_BYTES would be refused for a second,
  // untested reason, and the notice text this rig compares against names
  // only the pixel count.
  const bytes = statSync(photoOversizePath).size;
  if (bytes > MAX_PICTURE_BYTES) {
    abort(
      `the generated 51-megapixel photograph is ${bytes} bytes, over MAX_PICTURE_BYTES ` +
        `(${MAX_PICTURE_BYTES}): the refusal this rig measures would be ambiguous between the ` +
        "pixel bound and the byte bound.",
    );
  }
  console.log(`  ${photoOversizePath}: ${bytes} bytes`);
}
const sourcePhotoBytes = readFileSync(photoOkPath);
const sourceCoverBytes = readFileSync(coverPath);

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
let attachStateName = "";
let attachHostRssMb = 0;
let attachRssStepsMb: number[] = [];
let oversizeNoticeText = "";
let oversizePicturePathBefore = "";
let oversizePicturePathAfter = "";
let oversizeFilesBefore = 0;
let oversizeFilesAfter = 0;
let coverSidesText = "";
const picturesDir = picturesDirFor(projectPath);
const attachStateExpectedName = castPictureAlt(CAST_NAME);

console.log("\n[3/6] booting: File > Cast, create a member, attach, refuse an oversize one, File > Covers");
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
      // THE HOST, NOT THE BOOT'S ROOT. `rootPid` is the process the shell
      // spawned, and on this rig's first green run its VmHWM read 3.8 MB -- a
      // wrapper, not the application. The decode happens in the process whose
      // comm is the binary's name; the web process is a descendant with its
      // own (`WebKitWebProces`).
      const hostPid = hostProcessOf(rootPid);
      if (displayNum === null) throw new Error("pictures rig requires a fixed X display");
      const display = `:${displayNum}`;

      // SAMPLED FROM BEFORE ACT (a) TO THE END OF THIS FUNCTION: VmHWM is a
      // monotonic high-water mark, so the peak already reflects the whole
      // boot's life up to the last poll -- narrowing the window to "around
      // the attach" would have under-measured a peak set by decoding the
      // cover in act (d).
      const hwmRawMb: number[] = [];
      let hwmPeakKb = 0;
      const sampler = setInterval(() => {
        const kb = readVmHwmKb(hostPid);
        if (kb > 0) {
          hwmPeakKb = Math.max(hwmPeakKb, kb);
          hwmRawMb.push(Math.round((kb / 1024) * 10) / 10);
        }
      }, HWM_POLL_MS);

      try {
        // Before any dialog exists, while the exactly-one guard still means
        // something -- a GTK dialog inherits this application's WM_CLASS.
        const wid = findWindowId(display);
        resizeWindow(display, wid, PANEL_WINDOW);
        await Bun.sleep(SETTLE_MS);
        xdo(display, ["windowfocus", wid]);
        const focused = xdoRead(display, ["getwindowfocus"]).trim();
        if (focused !== wid) {
          throw new Error(
            `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`,
          );
        }
        const driver = menuDriver(display, wid, xdo);

        // ---- create the member -------------------------------------------
        await driver.activate("menu-cast");
        await Bun.sleep(SAVE_MS);
        xdo(display, ["type", "--delay", "40", CAST_NAME]);
        await Bun.sleep(SETTLE_MS);
        driver.key("Tab");
        await Bun.sleep(200);
        driver.key("Tab");
        await Bun.sleep(200);
        driver.key("Return");
        await Bun.sleep(SAVE_MS);
        driver.key("Escape");
        await Bun.sleep(SAVE_MS);

        // Reopen and select the one entry by counted keystrokes, then
        // WALK 1: `#cast-edit` located and clicked. A counted Tab to it was
        // tried and landed elsewhere (the edit form never opened, and walk 2
        // found no choose button), so this is bible-cli's route: located,
        // one walk, five in the boot rather than four. The count is stated
        // in the header for the recorded reason.
        await driver.activate("menu-cast");
        await Bun.sleep(SETTLE_MS);
        driver.key("Tab");
        await Bun.sleep(200);
        driver.key("Return");
        await Bun.sleep(SETTLE_MS);
        clickAt(display, wid, requireNode(readNodeInfo(rootPid, ["cast-edit"]), "cast-edit"));
        await Bun.sleep(SETTLE_MS);

        // ---- act (a): attach the 49-megapixel photograph -----------------
        // WALK 2: both `#cast-picture-choose` and `#cast-save`'s
        // coordinates, for act (a)'s press; walk 3 re-reads both.
        const editInfo = readNodeInfo(rootPid, ["cast-picture-choose", "cast-save"]);
        let chooseRect = requireNode(editInfo, "cast-picture-choose");
        let saveRect = requireNode(editInfo, "cast-save");

        clickAt(display, wid, chooseRect);
        const dialog1 = await waitForDialog(display, PICTURE_DIALOG_TITLE);
        if (dialog1 === null) {
          throw new Error(`the "${PICTURE_DIALOG_TITLE}" dialog never opened for the 49-megapixel photograph.`);
        }
        xdo(display, ["windowfocus", dialog1]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", dialog1, "ctrl+l"]);
        await Bun.sleep(300);
        xdo(display, ["type", "--window", dialog1, "--delay", "20", photoOkPath]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", dialog1, "Return"]);
        // The decode and the store round trip happen after the dialog is gone.
        await Bun.sleep(POST_DIALOG_POLL_MS + SAVE_MS);

        // WALK 3: the MOVED `#cast-picture-choose` and `#cast-save` (the
        // layout shifted once a thumbnail replaced the "no picture"
        // paragraph) and `#cast-picture`'s accessible name (an `<img>`, role
        // "image" -- not in `locateNodes`'s WANTED set, hence this id-matched
        // walk). Present is drawn there, never in `#cast-picture-state` --
        // see the header. SAVE IS RE-READ TOO (239): with 237's 30px
        // controls, walk 2's Save coordinate lands on the thumbnail's
        // "Change picture..." button, which reopened the picture dialog and
        // let act (d)'s cover path attach to the cast member instead -- the
        // "sha mismatch" (a 170x256 thumbnail, the cover's shape) and the
        // empty covers panel were both that one stale click.
        const attachedInfo = readNodeInfo(rootPid, ["cast-picture-choose", "cast-save", "cast-picture"]);
        chooseRect = requireNode(attachedInfo, "cast-picture-choose");
        saveRect = requireNode(attachedInfo, "cast-save");
        attachStateName = requireNode(attachedInfo, "cast-picture").text;

        // ---- act (b): the oversize photograph is refused -----------------
        // BEFORE the act, bracketing it against the same two readings taken
        // AFTER: a single post-teardown read of picture_path could not tell
        // "never changed" from "changed and changed back", and act (d)'s cover
        // would already be in the pictures directory by the time a post-boot
        // file count ran.
        oversizePicturePathBefore = (await probePicturePath(projectPath, CAST_NAME)) ?? "";
        oversizeFilesBefore = originalFilesIn(picturesDir);
        clickAt(display, wid, chooseRect);
        const dialog2 = await waitForDialog(display, PICTURE_DIALOG_TITLE);
        if (dialog2 === null) {
          throw new Error(`the "${PICTURE_DIALOG_TITLE}" dialog never opened for the oversize photograph.`);
        }
        xdo(display, ["windowfocus", dialog2]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", dialog2, "ctrl+l"]);
        await Bun.sleep(300);
        xdo(display, ["type", "--window", dialog2, "--delay", "20", photoOversizePath]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", dialog2, "Return"]);
        await Bun.sleep(SETTLE_MS);

        // WALK 4: the notice banner (role "status", also outside
        // `locateNodes`'s WANTED set), read before the Escape below removes
        // it. `problem` tone is not auto-dismissed, so there is no race
        // against `INFO_BANNER_MS` here -- the race is against this rig's
        // own next keystroke.
        {
          const texts = readNodeTexts(rootPid, ["open-error"]);
          oversizeNoticeText = texts["open-error"] ?? "";
        }
        oversizePicturePathAfter = (await probePicturePath(projectPath, CAST_NAME)) ?? "";
        oversizeFilesAfter = originalFilesIn(picturesDir);

        // SAVE (the coordinate walk 3 re-read), ONE ESCAPE for the
        // banner, THEN a click into the prose to close the panel
        // (`closeOnOutsideClick`) -- what the page actually does: Escape
        // dismisses the `problem` banner, and the panel itself is left up
        // until the outside click, which is also what returns focus to the
        // editor so the File chord below is heard.
        clickAt(display, wid, saveRect);
        await Bun.sleep(SAVE_MS);
        driver.key("Escape");
        await Bun.sleep(SAVE_MS);
        xdo(display, ["mousemove", "--window", wid, "520", "560"]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(SAVE_MS);

        // ---- act (d): the front cover -------------------------------------
        // REAL INPUT AFTER A DIALOG. Every keystroke this rig sends before the
        // first file dialog is heard; after one, `xdotool key --window` (a
        // synthetic XSendEvent) reaches nothing, while clicks (XTEST) do -- six
        // captures with the menu never opening and the panel never closing.
        // `windowfocus` then keys with no `--window` go through XTEST too --
        // `xtest` strips the flag from every verb it is given.
        xdo(display, ["windowfocus", wid]);
        await Bun.sleep(300);
        const refocused = xdoRead(display, ["getwindowfocus"]).trim();
        if (refocused !== wid) {
          throw new Error(
            `refusing to send act (d)'s keys: keyboard focus is window ${refocused}, not the app's ${wid}.`,
          );
        }
        const xtestKey = (chord: string): void => xtest(display, ["key", chord]);
        const xtestDriver = menuDriver(display, wid, xtest);
        await xtestDriver.activate("menu-covers");
        await Bun.sleep(SETTLE_MS);
        // NO WALK: the panel focuses ITSELF and is not a tab stop, so the
        // first Tab reaches the FRONT side's "PDF page placement" select and
        // the second its "Add a cover..." (the sides paint in `covers.ts`'s
        // COVER_SIDES order, front first; the placement select came before
        // the button when cover fit landed, and one Tab then opened the
        // select's list instead -- 239's debug capture). A walk taken here
        // found no push button under the panel at all on the first run, so
        // this is counted keystrokes rather than a located coordinate; a
        // wrong landing is caught by its effect, the picture dialog never
        // opening.
        for (const key of ["Tab", "Tab", "Return"]) {
          xtestKey(key);
          await Bun.sleep(TAB_STEP_MS);
        }
        const dialog3 = await waitForDialog(display, PICTURE_DIALOG_TITLE);
        if (dialog3 === null) {
          throw new Error(`the "${PICTURE_DIALOG_TITLE}" dialog never opened for the cover.`);
        }
        xdo(display, ["windowfocus", dialog3]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", dialog3, "ctrl+l"]);
        await Bun.sleep(300);
        xdo(display, ["type", "--window", dialog3, "--delay", "20", coverPath]);
        await Bun.sleep(400);
        xdo(display, ["key", "--window", dialog3, "Return"]);
        await Bun.sleep(SETTLE_MS + SAVE_MS);

        // WALK 5: every named descendant under the covers panel -- a plain,
        // unlabelled container carries no name of its own, so what a screen
        // reader hears is every named descendant's text, which is what
        // `covers-panel.ts`'s finding paragraphs and legends carry
        // (`castCardText`'s shape). UNDER THE PANEL, NOT `#covers-sides`:
        // that div carries no role and the engine flattens it out of the
        // tree, so its legends and finding paragraphs are the panel's own
        // children. The heading and the page line come along; the gate asks
        // whether the text CONTAINS the sentence.
        coverSidesText = collectNamesUnder(rootPid, "covers-panel").replace(/\n/g, " ");

        driver.key("Escape");
        await Bun.sleep(SAVE_MS);
      } finally {
        clearInterval(sampler);
      }
      attachHostRssMb = Math.round((hwmPeakKb / 1024) * 10) / 10;
      attachRssStepsMb = boundedSteps(hwmRawMb);
    },
  });
} catch (err) {
  abort(`the interactive boot threw: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("\n[4/6] reading the file");

if (oversizeNoticeText.includes("/")) {
  abort(
    `the oversize notice carries a "/": "${oversizeNoticeText}" -- that shape is a ` +
      "PictureError::Io message (a path), not the TooManyPixels refusal this rig expects.",
  );
}

const memberRow = (() => {
  const db = new Database(projectPath, { readonly: true });
  try {
    const rows = db
      .query<{ id: string; picture_path: string | null }, [string]>(
        "SELECT id, picture_path FROM cast_member WHERE name = ?1",
      )
      .all(CAST_NAME);
    return rows[0] ?? null;
  } finally {
    db.close();
  }
})();
if (memberRow === null) {
  abort(`no cast_member named "${CAST_NAME}" exists after the boot: act (a) never created one.`);
}
const storedName = memberRow.picture_path ?? "";
if (storedName.length === 0) {
  abort("the member's picture_path is empty after the boot: the attach never landed on the store.");
}

const storedOriginalBytes = existsSync(join(picturesDir, storedName))
  ? readFileSync(join(picturesDir, storedName))
  : null;
const shaMatches =
  storedOriginalBytes !== null && sha256Hex(storedOriginalBytes) === sha256Hex(sourcePhotoBytes);

const thumbName = thumbNameOf(storedName);
const thumbPath = join(picturesDir, thumbName);
let thumbW = 0;
let thumbH = 0;
if (existsSync(thumbPath)) {
  const size = pngSize(new Uint8Array(readFileSync(thumbPath)));
  if (size !== null) {
    thumbW = size.width;
    thumbH = size.height;
  }
}

const coverMetaValue = (() => {
  const db = new Database(projectPath, { readonly: true });
  try {
    const rows = db
      .query<{ value: string | null }, []>("SELECT value FROM meta WHERE key = 'design.cover.front'")
      .all();
    return rows[0]?.value ?? null;
  } finally {
    db.close();
  }
})();
const coverFileMatches =
  coverMetaValue !== null &&
  existsSync(join(picturesDir, coverMetaValue)) &&
  sha256Hex(readFileSync(join(picturesDir, coverMetaValue))) === sha256Hex(sourceCoverBytes);

// THE HEADLINE IS THE PLAIN SENTENCE (239): since 236 a host diagnostic sits
// behind the banner's Details and `command-error.ts` names the problem, and
// for this refusal it names it as `host-error.picture-pixels`. Restated, not
// imported; the host's own figures stay in the Details.
const PICTURE_PIXELS_SENTENCE =
  "That picture has more pixels than this book can read. Choose a smaller picture, or resize it first.";
const oversizeExpectedNotice = castErrorPicture(PICTURE_PIXELS_SENTENCE);

const metrics: PicturesMetrics = {
  attach_sha_matches: shaMatches,
  attach_thumb_width: thumbW,
  attach_thumb_height: thumbH,
  attach_stored_name: storedName,
  attach_state_name: attachStateName,
  attach_state_expected_name: attachStateExpectedName,
  oversize_picture_path_before: oversizePicturePathBefore,
  // Read from the SAME row right after the refusal, before act (d)'s cover
  // lands in the same directory.
  oversize_picture_path_after: oversizePicturePathAfter,
  oversize_files_before: oversizeFilesBefore,
  oversize_files_after: oversizeFilesAfter,
  oversize_notice_text: oversizeNoticeText,
  oversize_expected_notice: oversizeExpectedNotice,
  attach_host_rss_mb: attachHostRssMb,
  attach_rss_steps_mb: attachRssStepsMb,
  cover_meta_value: coverMetaValue,
  cover_file_matches: coverFileMatches,
  cover_sides_text: coverSidesText,
  cover_expected_sentence: COVER_EXPECTED_SENTENCE,
};

console.log(
  `\nattach: sha ${metrics.attach_sha_matches}, thumbnail ${metrics.attach_thumb_width}x` +
    `${metrics.attach_thumb_height} (<= ${PICTURES_THUMB_MAX}px), accessible name "${metrics.attach_state_name}"`,
);
console.log(`oversize: notice "${metrics.oversize_notice_text}"`);
console.log(`host VmHWM peak: ${metrics.attach_host_rss_mb} MB over ${metrics.attach_rss_steps_mb.length} step(s)`);
console.log(`cover: meta ${JSON.stringify(metrics.cover_meta_value)}, matches ${metrics.cover_file_matches}`);
console.log(`covers panel text: "${metrics.cover_sides_text}"`);

const verdicts = evaluatePicturesGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

const path = writeResult(
  buildResult({
    runId: "app-pictures-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-pictures",
    verdicts,
    metrics: {
      ...metrics,
      omitted_gates:
        "latency, stall, cliff, a11y_exposure: one boot of a handful of dialogs, which has " +
        "nothing true to say about frame cadence.",
      scope:
        "attach_host_rss_mb is the host main process's own VmHWM, polled every 20ms from before " +
        "the first act to the end of the boot; VmHWM is the kernel's monotonic high-water mark, " +
        "so the reading already reflects the process's peak over its whole life up to the last " +
        "poll. attach_rss_steps_mb is bounded to the samples where the value changed, plus the " +
        "first and last.",
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

console.log(`\n[5/6] recorded: ${path}`);
console.log(`[6/6] outcome payload item_id: ${outcome.payload.item_id ?? "null"}`);

rmSync(root, { recursive: true, force: true });
process.exit(verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0);
