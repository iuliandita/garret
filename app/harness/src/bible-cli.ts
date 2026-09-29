// app/harness/src/bible-cli.ts
// Graded run over the book's OTHER half: the bible, a scene's synopsis, the
// cast, who appears where, and what a photograph costs to hold.
//
// WHY ONE RIG FOR FIVE SLICES. 035, 036, 037, 038/042 and 039 each shipped a
// surface whose every claim rests on unit tests and screenshots, and six
// consecutive slices have each written down, in their own words, that no graded
// rig covers any of them. That is precisely the position the readable mirror
// was in on 2026-08-27, when a defect that made the entire feature inoperative
// survived four slices and was found by READING, because every claim about it
// was a `cargo` test over a temp directory. The five surfaces share one store,
// one navigator selection and one menu, so five rigs would be five seedings and
// five Xvfb servers for the same machinery; this is a boot per claim against
// one project, which is also what a real book looks like.
//
// EVERY ORACLE IS THE FILE. The store read directly with `bun:sqlite`, the
// exported manuscript read as bytes, and the thumbnail the HOST regenerated read
// with the harness's own PNG reader (`png.ts`). Nothing here asks the page what
// it did; the AT-SPI walks in boots 3 and 5 are geometry and presence, never a
// verdict.
//
// THE PICTURE IS GENERATED, NOT `demo-portrait.png`. That fixture is 3.7 kB and
// measuring memory against it would answer nothing -- and `peak_rss_mb` with a
// picture open is the number the 2026-08-25 finding has been blocked on. This
// rig plants a 3000x2000 gradient, which is a camera's shape, and takes the
// figure with the full-size viewer open on it.
//
// WALK BUDGET: zero AT-SPI walks in boots 1 and 2, ONE in boot 3, FIVE in
// boot 4 and TWO in boot 5, which is `menu-cli`'s recorded ceiling for
// a boot that is not counting keystrokes. Boot 3's is new (097 review): it
// reopens on a row boot 2 gave a synopsis, so the panel now opens in READ --
// #synopsis-field and #synopsis-save are `display: none` there and a tab
// count has nothing to land on. Boot 4's five are `locateNodes`, THREE TIMES,
// pressing `#cast-edit`, the alias entry (found by its own accessible name)
// and `#cast-save` BY ID AND BY NAME rather than by a Tab count -- a fresh
// member has no picture control to Tab over, so a count from the DOM's own
// order said nothing about where the caret landed, and the first run of this
// boot stored no alias at all -- plus `cast-hover.ts`'s own TWO: one to find
// the alias in the prose and where it is drawn, one (inside `castCardText`)
// to read the card's name back. There is no separate CONFIRM walk on top of
// that last one: `castCardText` already answers null when there is nothing
// to read, which is exactly what `cast_alias_marks` reads as a miss. Every
// other boot is still driven by KEYSTROKES through the shared menu driver and
// by tab counts the panels' own source fixes, and is verified by EFFECT on
// the file.
//
// Usage: APP_GUI=1 bun app/harness/src/bible-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAST_CARD_SETTLE_MS,
  castCardText,
  castHoverCandidates,
  locateCastHoverRect,
} from "./cast-hover";
import { captureEnv } from "./env";
import { evaluateBibleGates, type BibleMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { pngSize, writePng } from "./png";
import { centreOf, locateNodes } from "./nodes";
import { buildResult, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  findWindowId,
  runShell,
  survivingShellPids,
  type RunOutcome,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** Must match ROW_HEIGHT in app/ui/src/main.ts. Restated rather than imported,
 *  which is this harness's rule for every threshold and every constant the two
 *  programs share: a shared value hides a drift instead of failing on it. */
const ROW_HEIGHT = 24;
/** The one gap the navigator's virtual list ever inserts: 16px above the first
 *  reserved root's row (095's separator). RESTATED from `SECTION_GAP` in
 *  app/ui/src/navigator/virtual-list.ts, for this harness's usual reason: two
 *  programs, not one shared constant. The bible root is itself a reserved
 *  root, so the note this rig clicks under it is always at or past the gap. */
const SECTION_GAP = 16;
/** RESTATED from app/ui/src/item-types.ts's RESERVED_ROOT_TYPES: the bin, the
 *  bible, and the two matter sections, which is where SECTION_GAP is drawn. */
const RESERVED_ROOT_TYPES = ["trash", "bible", "front", "back"];
/** #project-bar plus #nav-header, both 39px by design (the bar declares it),
 *  exactly as `switch-cli` restates them. Every navigator y below
 *  is offset by the pair. */
const NAV_TOP = 39 + 39;
/** #footer { height: 34px }. The navigator's rows still start at
 *  NAV_TOP, but the pane ends this much before the window does, so the
 *  "every row is on screen" guard subtracts it. */
const FOOTER_HEIGHT = 34;
/** The middle of the navigator pane (`--nav-width: 320px`). */
const NAV_CLICK_X = 160;
/** store/mod.rs MAX_DEPTH, so a parent_id cycle fails the walk rather than
 *  hanging the rig. */
const MAX_DEPTH = 64;

/** A TALL SCREEN FOR THE ROW CLICK, `menu-cli`'s precedent on the same axis. The
 *  bible root and its note are appended after the fixture's 40 rows, so the note
 *  sits at y ~= 1080 -- and the pointer is CLAMPED to the X screen, so the
 *  default 1280x1024 would press somewhere else entirely and report whatever
 *  that row did. */
const TALL_SERVER_ARGS = "-screen 0 1600x1200x24 -s 0 -noreset";
const TALL_WINDOW = { w: 1200, h: 1150 };
/** Wide enough for the cast panel's form to sit inside the window, so a
 *  coordinate read from AT-SPI is a coordinate the pointer can reach. */
const PANEL_WINDOW = { w: 1200, h: 900 };

/** xdotool type returns when X has the key events, not when WebKitGTK has turned
 *  them into document state. 500 ms silently truncated typed text; 2500 held. */
const SETTLE_MS = 2500;
/** After a panel's Save, for the round trip to the store and back. */
const SAVE_MS = 1500;
/** A 3000x2000 decode, a downscale to 1600 and a base64 of the result, in the
 *  host, on a machine also running an X server. Generous on purpose: a capture
 *  taken mid-render photographs an empty frame, and a WALK taken mid-render
 *  reports the viewer as absent -- which reads as the feature not working. */
const FULL_RENDER_MS = 8000;

/** Between panel tab stops. The panels move focus synchronously; the keystrokes
 *  are delivered by the X server and a burst can coalesce. */
const TAB_STEP_MS = 200;

// The nonces. Distinctive strings that cannot occur in the fixture's generated
// prose, so a containment check cannot be satisfied by the corpus.
const MANUSCRIPT_NONCE = "Quillfeather anchored the ketch at Vlissingen.";
const NOTE_NONCE = "Bramblewick keeps the guild ledger in his boot.";
const SYNOPSIS_TEXT = "Ilse learns what the ledger says and tells nobody about it.";
const CAST_NAME = "Marisol Quillfeather";
/** The first option of the panel's kind select, restated from
 *  `app/ui/src/cast-kinds.ts`'s order rather than imported. */
const CAST_EXPECTED_KIND = "character";

/** The planted photograph. A camera's shape, and its long side is what the
 *  thumbnail gate grades the host's reduction against. */
const PICTURE_W = 3000;
const PICTURE_H = 2000;
/** A name `pictures::is_stored_name` accepts: a UUID and one known extension.
 *  Fixed rather than random so a failed run leaves a file a human can find. */
const PICTURE_FILE = "0198c0de-0000-7000-8000-0000000004f7.png";
/** `pictures::thumb_of`: the stem plus THUMB_SUFFIX. Restated. */
const THUMB_FILE = "0198c0de-0000-7000-8000-0000000004f7.thumb.png";

interface WalkRow {
  id: string;
  type: string;
  title: string;
  parent_id: string | null;
}

/** The visible index of the first reserved root in `walk`, or null when none
 *  is present. Every row from this index on is SECTION_GAP px lower than
 *  `index * ROW_HEIGHT` would put it. */
function firstReservedIndex(rows: readonly WalkRow[]): number | null {
  const at = rows.findIndex((r) => r.parent_id === null && RESERVED_ROOT_TYPES.includes(r.type));
  return at < 0 ? null : at;
}

/** The interactive-mode sink payload (app/ui/src/main.ts, run === "interactive"). */
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

function gitShortSha(): string {
  const proc = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

/** The store's own depth-first walk, restated from store/mod.rs items() and run
 *  against the file. Read LIVE where the rig needs a row it has just made: the
 *  bible root and its note do not exist at seed time, and arithmetic over "two
 *  more rows at the end" is a restated constant where a query is a measurement. */
function walk(projectPath: string): WalkRow[] {
  const db = new Database(projectPath, { readonly: true });
  try {
    return db
      .query(
        `WITH RECURSIVE walk(id, parent_id, type, title, position, depth, path) AS (
           SELECT id, parent_id, type, title, position, 0, position
             FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.type, i.title, i.position,
                  w.depth + 1, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
            WHERE w.depth + 1 < ${MAX_DEPTH}
         )
         SELECT id, type, title, parent_id FROM walk ORDER BY path`,
      )
      .all() as WalkRow[];
  } finally {
    db.close();
  }
}

function query<T>(projectPath: string, sql: string, ...args: unknown[]): T[] {
  const db = new Database(projectPath, { readonly: true });
  try {
    return db.query(sql).all(...(args as never[])) as T[];
  } finally {
    db.close();
  }
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

/** Ask for a window size and READ IT BACK. An unhonoured resize leaves every
 *  coordinate below computed against a window that does not exist. */
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

/** Tab n times, then Return. The counts are the PANELS' OWN tab order, restated
 *  in the caller with the reason -- the trade `shot-cli --cast` and `--covers`
 *  already make against spending an AT-SPI walk on a control whose position in
 *  the document is fixed by its module's `append` call. */
async function tabsThenReturn(key: (chord: string) => void, tabs: number): Promise<void> {
  for (let i = 0; i < tabs; i++) {
    key("Tab");
    await Bun.sleep(TAB_STEP_MS);
  }
  key("Return");
}

function abort(why: string, cleanup: () => void): never {
  console.error(`\n${why}\nNothing was written.`);
  cleanup();
  process.exit(2);
}

// ---------------------------------------------------------------------------

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; bible run skipped (needs a display and a built shell).");
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
      `refusing to start: ${SHELL_PROC_NAME} already running (pid(s) ${preexisting.join(", ")}).`,
    );
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "app-bible-"));
const projectPath = join(workDir, "book.db");
const exportDir = join(workDir, "exports");
const picturesDir = join(workDir, "book.pictures");
mkdirSync(exportDir, { recursive: true });
function cleanup(): void {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`[1/7] seeding project from ${FIXTURE}`);
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

const seedWalk = walk(projectPath);
/** The scene the page opens at boot: `mountProject` takes the first row of the
 *  store's walk whose type is `scene`. Restated here and computed from the FILE,
 *  so a page that opened something else fails the synopsis gate rather than
 *  being asked where it is. */
const openScene = seedWalk.find((r) => r.type === "scene");
if (openScene === undefined) {
  abort("the seeded fixture holds no scene: there is nothing for the page to open.", cleanup);
}
if (seedWalk.some((r) => r.type === "bible" || r.type === "note")) {
  abort(
    "the seeded fixture already holds a bible root or a note: the create in boot 1 would be " +
      "grading a row it did not make.",
    cleanup,
  );
}
if (query<{ n: number }>(projectPath, "SELECT COUNT(*) AS n FROM synopsis")[0]!.n !== 0) {
  abort("the seeded fixture already holds a synopsis; the panel's write would be invisible.", cleanup);
}
if (query<{ n: number }>(projectPath, "SELECT COUNT(*) AS n FROM cast_member")[0]!.n !== 0) {
  abort("the seeded fixture already holds a cast; the panel's create would be invisible.", cleanup);
}
/** The same row, in a binding TypeScript keeps narrowed inside the hoisted
 *  `boot` declaration below. A guard above a function declaration does not reach
 *  into it, and an assertion at each use would be four places to be wrong. */
const opened: WalkRow = openScene;
console.log(`  ${seedWalk.length} rows; the page will open ${opened.id} ("${opened.title}")`);

/** Every boot's peak, kept so the last one can be read against the four before
 *  it. The graded figure is boot 5's -- the only one with a photograph in the
 *  web process -- and a series is the thing `peak_rss_mb` has never had. */
const peaks: Record<string, number> = {};

async function boot(
  label: string,
  opts: {
    serverArgs?: string;
    window: { w: number; h: number };
    drive: (ctx: {
      display: string;
      wid: string;
      rootPid: number;
      key: (chord: string) => void;
      activate: (itemId: string) => Promise<void>;
    }) => Promise<void>;
  },
): Promise<RunOutcome<InteractiveSinkPayload>> {
  const outcome = await runShell<InteractiveSinkPayload>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    // GDK_BACKEND=x11 is load-bearing: the ambient session sets WAYLAND_DISPLAY
    // and GTK prefers Wayland, so the webview would open on the real desktop
    // instead of the Xvfb display xdotool targets.
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      APP_EXPORT_DIR: exportDir,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    ...(opts.serverArgs === undefined ? {} : { serverArgs: opts.serverArgs }),
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("bible rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      resizeWindow(display, wid, opts.window);
      await Bun.sleep(SETTLE_MS);
      // Without this the keystrokes reach nothing at all, which is the same
      // symptom as the page ignoring the chord (mirror-shot learned it twice).
      xdo(display, ["windowfocus", wid]);
      const driver = menuDriver(display, wid, xdo);
      await opts.drive({ display, wid, rootPid, key: driver.key, activate: driver.activate });
      // No window manager under Xvfb: this destroys the window rather than
      // delivering a close request. The run needs the process gone before the
      // file can be read, and the debounce autosave is what puts prose in the
      // store.
      xdo(display, ["windowclose", wid]);
      await Bun.sleep(3000);
    },
  });
  peaks[label] = outcome.peakRssMb;
  if (outcome.payload.item_id !== opened.id) {
    abort(
      `boot "${label}": the page opened ${outcome.payload.item_id}, not ${opened.id}, which ` +
        "this rig computed from the store's own walk. Every claim below is about the wrong row.",
      cleanup,
    );
  }
  return outcome;
}

// ---- boot 1: the bible, and whether it stays out of the book ---------------
//
// The note is created through the SHIPPED menu item, opened by CLICKING its row
// in the navigator -- `onCreated` only selects, so a rig that typed here without
// the click would put the note's words into whatever was already open, and the
// exclusion gate would then be about the wrong document -- and exported through
// the shipped File > Export manuscript.
console.log("\n[2/7] boot 1: Outline > New note, prose, File > Export manuscript");
await boot("bible", {
  serverArgs: TALL_SERVER_ARGS,
  window: TALL_WINDOW,
  drive: async ({ display, wid, activate }) => {
    // `rows` is the walk this index was found in - the SECTION_GAP fold has to
    // ask that walk, not a stale one, because the gap's own position moves the
    // moment the bible root is created.
    const clickRow = (index: number, rows: readonly WalkRow[]): void => {
      const gapAt = firstReservedIndex(rows);
      const gap = gapAt !== null && index >= gapAt ? SECTION_GAP : 0;
      xdo(display, [
        "mousemove",
        "--window",
        wid,
        String(NAV_CLICK_X),
        String(NAV_TOP + index * ROW_HEIGHT + gap + ROW_HEIGHT / 2),
      ]);
      xdo(display, ["click", "1"]);
    };
    // The manuscript's own needle first, into the scene the page opened.
    const openIndex = seedWalk.findIndex((r) => r.id === opened.id);
    clickRow(openIndex, seedWalk);
    await Bun.sleep(SETTLE_MS);
    xdo(display, ["type", "--delay", "40", MANUSCRIPT_NONCE]);
    await Bun.sleep(SETTLE_MS);

    await activate("menu-new-note");
    await Bun.sleep(SAVE_MS);

    // LIVE, not computed. The bible root and the note are two rows that did not
    // exist a second ago, and the store is the only thing that knows where the
    // walk put them.
    const live = walk(projectPath);
    const noteIndex = live.findIndex((r) => r.type === "note");
    if (noteIndex < 0) {
      throw new Error("Outline > New note left no note row in the store; nothing to click.");
    }
    // The note sits under the bible root, itself a reserved root, so its y is
    // ALWAYS the gap-folded one - the note is at or past the gap by construction.
    const noteGapAt = firstReservedIndex(live);
    const noteGap = noteGapAt !== null && noteIndex >= noteGapAt ? SECTION_GAP : 0;
    if (NAV_TOP + noteIndex * ROW_HEIGHT + noteGap + ROW_HEIGHT > TALL_WINDOW.h - FOOTER_HEIGHT) {
      throw new Error(
        `the note is row ${noteIndex}, which is below the pane of a ${TALL_WINDOW.h}px window ` +
          `less its ${FOOTER_HEIGHT}px footer: the click would land on the footer or the desktop, ` +
          "and X would clamp it onto some other row.",
      );
    }
    clickRow(noteIndex, live);
    await Bun.sleep(SETTLE_MS);
    xdo(display, ["type", "--delay", "40", NOTE_NONCE]);
    await Bun.sleep(SETTLE_MS);

    await activate("menu-export");
    await Bun.sleep(SETTLE_MS);
  },
});

const afterBible = walk(projectPath);
const noteRow = afterBible.find((r) => r.type === "note");
const noteRoot = noteRow === undefined ? null : afterBible.find((r) => r.id === noteRow.parent_id);
const noteBody =
  noteRow === undefined
    ? ""
    : (query<{ body: string }>(projectPath, "SELECT body FROM doc WHERE item_id = ?1", noteRow.id)[0]
        ?.body ?? "");

const exported = readdirSync(exportDir);
if (exported.length !== 1) {
  abort(
    `the export directory holds ${exported.length} file(s) (${exported.join(", ")}). With none, ` +
      "File > Export manuscript never ran and both bible gates would be graded against nothing; " +
      "with more than one there is no single manuscript to read.",
    cleanup,
  );
}
const manuscriptBytes = readFileSync(join(exportDir, exported[0]!), "utf8");

// ---- boot 2: the synopsis --------------------------------------------------
//
// The panel opens with the caret already in its field (an EMPTY synopsis
// opens straight into Edit, 097, W4), so there is nothing to click and no
// coordinate to compute. TWO Tabs reach Save: `#synopsis-form` now appends
// field, Cancel, Save (097 review, ticket 01) -- Cancel is the first tab stop
// after the field, Save the second, and one Tab alone lands on Cancel, whose
// Return would dismiss the whole panel rather than commit it.
console.log("\n[3/7] boot 2: Outline > Synopsis..., type, Save");
await boot("synopsis-write", {
  window: PANEL_WINDOW,
  drive: async ({ display, key, activate }) => {
    await activate("menu-synopsis");
    await Bun.sleep(SAVE_MS);
    xdo(display, ["type", "--delay", "40", SYNOPSIS_TEXT]);
    await Bun.sleep(SETTLE_MS);
    await tabsThenReturn(key, 2);
    await Bun.sleep(SAVE_MS);
  },
});

const synopsisRows = query<{ item_id: string; body: string }>(
  projectPath,
  "SELECT item_id, body FROM synopsis",
);

// ---- boot 3: does the reopened panel PREFILL? ------------------------------
//
// GRADED THROUGH ITS EFFECT, with nothing typed. If the panel prefilled, Save
// writes the same paragraphs back; if it did not, Save writes an empty field and
// the store DELETES the row. Asking the page what is in its own field would be
// asking the defect whether it is present, and reading the field off AT-SPI
// would cost a walk to learn something the file already says.
//
// THE ROW NOW HAS A SYNOPSIS -- boot 2 just wrote one -- so the panel opens in
// READ (097, W4), not Edit: `#synopsis-field` and `#synopsis-save` are
// `display: none` there and no tab count reaches either. #synopsis-edit is
// the control that leaves Read, and this is the ONE WALK in boots 1-4 (see
// the header): its own accessible id is the only way to press it without
// assuming a tab order Read does not have -- `open`'s own `editButton.focus()`
// once Read settles makes a bare Return a plausible shortcut, but Return's
// mapping onto a focused, un-typed `<button>` is a toolkit convention this rig
// does not want to depend on for a gate this load-bearing.
console.log("\n[4/7] boot 3: reopen, Outline > Synopsis..., press Edit, Save with nothing typed");
await boot("synopsis-prefill", {
  window: PANEL_WINDOW,
  drive: async ({ display, wid, rootPid, key, activate }) => {
    await activate("menu-synopsis");
    // Longer than the panel's own paint: the prefill is a round trip to the
    // store, and a press before the answer lands would land on the Edit
    // control that is optimistically shown while it is still in flight,
    // rather than on the settled Read state this boot means to test.
    await Bun.sleep(SETTLE_MS);
    const nodes = locateNodes(rootPid);
    const editButton = nodes.find((n) => n.id === "synopsis-edit");
    if (editButton === undefined) {
      abort(
        "no #synopsis-edit in the accessibility tree: the panel did not open in Read, which " +
          "means boot 2's Save did not leave a synopsis behind. synopsis_prefills_on_reopen " +
          "would pass for a route that never ran.",
        cleanup,
      );
    }
    const at = centreOf(editButton);
    // A BARE click, `boot 5`'s own reason: `--window` sends a synthetic event
    // through XSendEvent and the toolkit drops it.
    xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
    xdo(display, ["click", "1"]);
    await Bun.sleep(SETTLE_MS);
    // Edit's own tab order, boot 2's own reason: the field holds focus and
    // `#synopsis-form` appends field, Cancel, Save.
    await tabsThenReturn(key, 2);
    await Bun.sleep(SAVE_MS);
  },
});

const afterResave = query<{ body: string }>(projectPath, "SELECT body FROM synopsis");

// ---- boot 4: the cast, and who appears here --------------------------------
//
// TWO panels in one boot and no walk in either. The cast panel opens with the
// caret in #cast-new-name, and its `newRow.append(newName, newKind, newButton)`
// puts two tab stops between the field and the create. The appearances panel
// focuses ITSELF, and its list holds one checkbox per member -- so with one
// member, Tab reaches the box and a second Tab reaches Save.
// ALIAS_TYPED: typed into the sheet's first (and only) blank alias row
// after Save, "Quill" -- the leftmost, whole-word occurrence " Quill" below
// puts into the scene's own prose. Not a name this build's matcher could
// confuse with the member's own -- `MIN_CAST_NAME_LENGTH`'s three-character
// floor, restated in `cast-hover.ts`, is well clear of it.
const ALIAS_TYPED = "Quill";
let castAliasCardText: string | null = null;

console.log("\n[5/7] boot 4: Outline > Cast... create, then Who appears here... tag");
await boot("cast", {
  window: PANEL_WINDOW,
  drive: async ({ display, wid, rootPid, key, activate }) => {
    await activate("menu-cast");
    await Bun.sleep(SAVE_MS);
    xdo(display, ["type", "--delay", "40", CAST_NAME]);
    await Bun.sleep(SETTLE_MS);
    await tabsThenReturn(key, 2);
    await Bun.sleep(SAVE_MS);
    key("Escape");
    await Bun.sleep(SAVE_MS);

    await activate("menu-appears");
    await Bun.sleep(SETTLE_MS);
    key("Tab");
    await Bun.sleep(TAB_STEP_MS);
    key("space");
    await Bun.sleep(TAB_STEP_MS);
    await tabsThenReturn(key, 1);
    await Bun.sleep(SAVE_MS);

    // THE ALIAS. Reopen the Cast panel, select the one entry, then
    // press BY ID AND BY NAME through AT-SPI, not by a Tab count: the first
    // version counted "one Tab to the alias row, eight to Save" from
    // cast-panel.ts's DOM order and the run stored no alias at all -- a
    // fresh member has no picture control to Tab over, and nothing in a
    // blind count says where the caret actually landed. `#cast-edit`,
    // the entry named `cast.alias.label` ("an alias") and `#cast-save` are
    // what the tree exposes; pressing them is what a writer's click does.
    await activate("menu-cast");
    await Bun.sleep(SETTLE_MS);
    key("Tab");
    await Bun.sleep(TAB_STEP_MS);
    key("Return");
    await Bun.sleep(SETTLE_MS);
    const pressById = async (id: string): Promise<void> => {
      const node = locateNodes(rootPid).find((n) => n.id === id);
      if (node === undefined) throw new Error(`boot 4: no node with id "${id}" in the tree`);
      const at = centreOf(node);
      xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(SETTLE_MS);
    };
    await pressById("cast-edit");
    {
      const aliasEntry = locateNodes(rootPid).find(
        (n) => (n.role === "entry" || n.role === "text") && n.name === "an alias",
      );
      if (aliasEntry === undefined) throw new Error("boot 4: no alias entry named \"an alias\" in the tree after Edit");
      const at = centreOf(aliasEntry);
      xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(TAB_STEP_MS);
      xdo(display, ["type", "--delay", "40", ALIAS_TYPED]);
      await Bun.sleep(SETTLE_MS);
    }
    await pressById("cast-save");
    await Bun.sleep(SAVE_MS);
    {
      const rows = query<{ alias: string }>(projectPath, "SELECT alias FROM cast_alias");
      console.log(`  [probe] after Save: cast_alias rows ${JSON.stringify(rows.map((r) => r.alias))}`);
    }
    key("Escape");
    await Bun.sleep(SAVE_MS);

    // THE PROSE. Escape above returned focus to the editor
    // (`onDismiss`); `ctrl+End` puts the caret at the end of the scene's own
    // text so the LEADING SPACE below is what keeps "Quill" a whole word --
    // typed anywhere else it risks landing mid-word with nothing this rig
    // controls on its far side.
    key("ctrl+End");
    await Bun.sleep(TAB_STEP_MS);
    xdo(display, ["type", "--delay", "40", ` ${ALIAS_TYPED}`]);
    await Bun.sleep(SETTLE_MS);

    // THE HOVER, `cast-hover.ts`'s own two-walk shape: one AT-SPI walk
    // to find the alias in the prose and where it is drawn, one to read the
    // card's own name back. NO SEPARATE CONFIRM WALK: `castCardText` already
    // answers null when no card (or no named node under one) is there, which
    // is exactly what `cast_alias_marks` reads as a miss -- a third walk here
    // would say nothing a null does not already say, and three walks in one
    // window is above every other rig's own ceiling. NOT A THROW ON FAILURE,
    // boot 5's own rule below: a card that never opens is exactly the shape
    // `cast_alias_marks` exists to report, and aborting the whole run would
    // lose the four gates already earned above for one that has not run yet.
    try {
      const candidates = castHoverCandidates(projectPath);
      const rect = locateCastHoverRect(rootPid, candidates, "boot 4", "alias-only");
      const at = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
      xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
      await Bun.sleep(CAST_CARD_SETTLE_MS);
      castAliasCardText = castCardText(rootPid);
    } catch (err) {
      console.error(`  boot 4: the alias hover threw: ${(err as Error).message}`);
      castAliasCardText = null;
    }
  },
});

const castRows = query<{ id: string; kind: string; name: string }>(
  projectPath,
  "SELECT id, kind, name FROM cast_member",
);
const castAliasRows = query<{ member_id: string; alias: string }>(
  projectPath,
  "SELECT member_id, alias FROM cast_alias",
);
const appearanceRows = query<{ item_id: string; cast_member_id: string }>(
  projectPath,
  "SELECT item_id, cast_member_id FROM appearance",
);
const castById = new Map(castRows.map((r) => [r.id, r.name]));

// ---- boot 5: a photograph, and what it costs -------------------------------
//
// The picture is PLANTED as the original alone and the row is written by hand
// with bun:sqlite, exactly as `shot-cli --cast` plants: the only route a writer
// has to `pictures::attach` is the host's OS file dialog, which only
// `dialog-cli` drives, and this rig's subject is what holding the picture costs
// rather than how it arrived. The THUMBNAIL is deliberately not planted -- the
// host regenerates a missing one on the next read and writes it beside the
// original, which is the filesystem effect this rig grades the panel by.
// BY NAME WHERE IT CAN BE, AND OTHERWISE BY BEING THE ONLY ONE. A lookup on the
// typed name alone means a build that stored the name wrongly takes the picture
// boot down with it -- and the memory figure, and both picture gates, would then
// be missing for a defect in the cast panel. The fixture starts with no cast, so
// "the one row in the table" is unambiguous.
const target =
  castRows.find((r) => r.name === CAST_NAME) ?? (castRows.length === 1 ? castRows[0] : undefined);
let thumbnailLongSide: number | null = 0;
let fullButtonFound = false;
let viewerOpen = false;
let picturePeak = 0;
if (target === undefined) {
  console.log("\n[6/7] boot 5 SKIPPED: no cast member to hang a picture on");
} else {
  console.log(`\n[6/7] boot 5: planting a ${PICTURE_W}x${PICTURE_H} photograph and opening it`);
  mkdirSync(picturesDir, { recursive: true });
  writeFileSync(
    join(picturesDir, PICTURE_FILE),
    // A gradient rather than a flat field: a picture that deflates to nothing
    // costs the host nothing to decode, and the whole point of the fixture is
    // that it is expensive.
    writePng(PICTURE_W, PICTURE_H, (x, y) => [x & 0xff, y & 0xff, (x * 3 + y) & 0xff]),
  );
  {
    const db = new Database(projectPath);
    try {
      db.query("UPDATE cast_member SET picture_path = ?1 WHERE id = ?2").run(
        PICTURE_FILE,
        target.id,
      );
    } finally {
      db.close();
    }
  }
  if (existsSync(join(picturesDir, THUMB_FILE))) {
    abort(
      "a thumbnail already exists beside the planted original: the regeneration gate would " +
        "pass against a cache nothing produced.",
      cleanup,
    );
  }

  const outcome = await boot("picture", {
    window: PANEL_WINDOW,
    drive: async ({ display, wid, rootPid, key, activate }) => {
      await activate("menu-cast");
      await Bun.sleep(SAVE_MS);
      // ONE Tab and a Return select the FIRST entry. The book already holds
      // the member boot 4 created, so the panel opens with the add row
      // collapsed and focus on the panel itself rather than
      // `#cast-new-name` -- the very first Tab reaches the first entry, `shot-cli
      // --cast`'s own count for the same non-empty case.
      await tabsThenReturn(key, 1);
      await Bun.sleep(FULL_RENDER_MS);

      // WALK 1 of 2. `cast-picture-full` is painted only when the host answered
      // with a thumbnail, so finding it is itself an observation: the panel
      // asked, the host regenerated, and the page drew a picture.
      const nodes = locateNodes(rootPid);
      const enlarge = nodes.find((n) => n.id === "cast-picture-full");
      if (enlarge === undefined) {
        // NOT A THROW, deliberately, and this is the fourth time this repo has
        // had to choose. A guard here would be STRICTER THAN THE GATES IT
        // PROTECTS -- the recorded `prefs_persist` shape -- and the run would
        // abort with no verdict at all for a panel that showed no picture, which
        // is exactly the defect `picture_thumbnail_bounded` exists to report.
        // The gates carry it instead: the thumbnail gate FAILS on the file that
        // is not there, and the viewer and memory gates read UNKNOWN, because a
        // figure taken with no photograph in the web process is not the figure
        // either of them claims.
        console.error(
          "  no #cast-picture-full in the accessibility tree: the selected entry is showing no " +
            "picture. The viewer was not pressed and the memory figure is not a picture's.",
        );
        return;
      }
      fullButtonFound = true;
      const at = centreOf(enlarge);
      // A BARE click, never `click --window`: with the flag xdotool sends a
      // synthetic event through XSendEvent and the toolkit drops it -- the
      // pointer hovers and nothing is ever pressed.
      xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
      xdo(display, ["click", "1"]);
      await Bun.sleep(FULL_RENDER_MS);

      // WALK 2 of 2, `menu-cli`'s recorded ceiling. #picture-viewer-close exists
      // only inside a panel that is `hidden` when closed, and WebKitGTK prunes a
      // hidden subtree entirely -- so its presence is the viewer being open.
      viewerOpen = locateNodes(rootPid).some((n) => n.id === "picture-viewer-close");
      // Hold it open across several sampler ticks (250 ms) so the peak is the
      // picture's and not the moment before it.
      await Bun.sleep(FULL_RENDER_MS);
    },
  });
  picturePeak = outcome.peakRssMb;

  const thumbPath = join(picturesDir, THUMB_FILE);
  if (!existsSync(thumbPath)) {
    thumbnailLongSide = 0;
  } else {
    const size = pngSize(new Uint8Array(readFileSync(thumbPath)));
    thumbnailLongSide = size === null ? null : Math.max(size.width, size.height);
  }
}

// ---------------------------------------------------------------------------

console.log("\n[7/7] reading the file");

const metrics: BibleMetrics = {
  note_root_type: noteRoot?.type ?? null,
  note_body_holds_nonce: noteBody.includes(NOTE_NONCE),
  export_holds_note_nonce: manuscriptBytes.includes(NOTE_NONCE),
  export_holds_manuscript_prose: manuscriptBytes.includes(MANUSCRIPT_NONCE),
  synopsis_rows: synopsisRows.length,
  synopsis_on_the_open_scene:
    synopsisRows.length === 1 && synopsisRows[0]!.item_id === opened.id,
  synopsis_body: synopsisRows[0]?.body ?? "",
  synopsis_typed: SYNOPSIS_TEXT,
  synopsis_after_blind_resave: afterResave[0]?.body ?? "",
  cast_names: castRows.map((r) => r.name),
  cast_typed_name: CAST_NAME,
  cast_kind: castRows.find((r) => r.name === CAST_NAME)?.kind ?? null,
  cast_expected_kind: CAST_EXPECTED_KIND,
  appearance_on_scene: appearanceRows
    .filter((r) => r.item_id === opened.id)
    .map((r) => castById.get(r.cast_member_id) ?? r.cast_member_id),
  appearance_rows_total: appearanceRows.length,
  cast_aliases: castAliasRows
    .filter((r) => r.member_id === (castRows.find((c) => c.name === CAST_NAME)?.id ?? ""))
    .map((r) => r.alias),
  cast_alias_typed: ALIAS_TYPED,
  cast_alias_card_text: castAliasCardText,
  picture_full_button_found: fullButtonFound,
  picture_viewer_open: viewerOpen,
  thumbnail_long_side: thumbnailLongSide,
  original_long_side: Math.max(PICTURE_W, PICTURE_H),
  peak_rss_mb: picturePeak,
};

// Structural checks BEFORE the gates. A vacuous pass must not be recorded.
if (metrics.peak_rss_mb === 0) {
  abort(
    "boot 5 did not run at all: there was no cast member to hang a picture on, so no memory " +
      "figure exists and three gates below would be graded against a run that never happened.",
    cleanup,
  );
}
if (afterBible.length <= seedWalk.length) {
  abort(
    `the walk is ${afterBible.length} rows against ${seedWalk.length} at seed time: Outline > ` +
      "New note changed nothing, and every bible gate below would be about the fixture.",
    cleanup,
  );
}
console.log(
  `\nstructural check passed: ${afterBible.length - seedWalk.length} new row(s), ` +
    `${metrics.peak_rss_mb} MB peak with a ${PICTURE_W}x${PICTURE_H} picture open.\n`,
);

const verdicts = evaluateBibleGates(metrics);
const path = writeResult(
  buildResult({
    workload: "app-bible",
    runId: "app-bible-tiny",
    candidate: "tauri",
    fixture: "tiny",
    verdicts,
    metrics: {
      workload_script: "bible-v1",
      peak_rss_mb: metrics.peak_rss_mb,
      peak_rss_mb_per_boot: peaks,
      rss_scope:
        `boot 5 only: a ${PICTURE_W}x${PICTURE_H} PNG attached to a cast member, its thumbnail ` +
        "shown in the panel and its full-size render open in the viewer. The other four boots' " +
        "peaks are recorded beside it as the control this figure has never had.",
      rows: afterBible.length,
      opened_at_boot: opened.id,
      bible: metrics,
      omitted_gates:
        "latency, stall, cliff, a11y_exposure: five boots of seconds each, a11y probing off",
      close_path: "unverified: no window manager under Xvfb; windowclose kills the process",
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
