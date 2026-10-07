// app/harness/src/dialog-cli.ts
// Graded native-dialog run. Export/import prove file dialogs; two independent
// project-creation boots prove choosing a folder and cancelling it.
//
// The subject is a window this application does not draw. `project_export_as`
// asks the operating system where to put the file, so the dialog is a GTK
// window belonging to the host process, and every figure about it here comes
// from `xdotool` — the X server's account of a window it owns — rather than
// from the application's account of itself.
//
// WHY THIS RIG EXISTS AT ALL: the obvious implementation of the command
// (`blocking_save_file()` from a synchronous `#[tauri::command]`) never opens a
// window. Not a crash, not an error: the command thread parks forever while the
// application stays alive and the webview stays responsive, so the feature
// silently does nothing and there is no host-side signal anywhere. Nothing in
// the unit suite can see that — a `#[tauri::command]` is not callable from a
// test, and the part that fails is the toolkit's, not this codebase's.
// `dialog_opens` is the only instrument in the repo that can.
//
// ONE AT-SPI WALK PER BOOT, and none at all while a dialog is up. The recorded
// failure is that several walks in one window kill the application outright —
// cleanly, taking xvfb-run's server with it. The menu is driven by KEYSTROKES
// rather than by located coordinates for that reason, and the keystroke path is
// self-checking: activating the wrong item produces either no dialog or the
// import dialog, and this rig matches the export dialog's title specifically.
//
// Usage: APP_GUI=1 bun app/harness/src/dialog-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { evaluateDialogGates, type DialogMetrics } from "./gates";
import { readManuscript } from "./markdown-read";
import { menuDriver } from "./menu-drive";
import { centreOf, locateNodes, type Node } from "./nodes";
import { buildResult, writeResult } from "./results";
import {
  BIN,
  SHELL_PROC_NAME,
  SHELL_WINDOW_CLASS_PATTERN,
  findWindowId,
  runShell,
  survivingShellPids,
} from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** Restated from `EXPORT_DIALOG_TITLE` in `commands/dialogs.rs`, deliberately
 *  not imported —
 *  there is no import across that boundary, and a threshold restated is a
 *  threshold that fails loudly when the two drift. The application names its own
 *  dialog for exactly this: GTK's default is "Save File", and a default chosen
 *  by the toolkit can change under us. */
const EXPORT_DIALOG_TITLE = "Export manuscript";
const IMPORT_DIALOG_TITLE = "Import manuscript";
const FOLDER_DIALOG_TITLE = "Where to keep this book";

/** A sentence that exists nowhere in the fixture, typed immediately before the
 *  export is asked for. It is in the file only if the export drained first. */
const NONCE = "Verbena.Quillon.Sarsen.";

/** xdotool returns when X has the key events, not when the toolkit has acted on
 *  them. Measured at 500ms racing the teardown and truncating typed text. */
const SETTLE_MS = 2500;

/** How long to wait for a window that a toolkit has to create, map and lay out.
 *  Polled rather than slept through, so a working build is not charged the
 *  worst case. */
const DIALOG_WAIT_MS = 12_000;
const DIALOG_POLL_MS = 250;

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

/** A closing key can destroy the dialog before its key-up event. Target the
 * verified focus on this private display instead of sending key-up to a dead XID. */
function answerDialog(display: string, dialog: string, key: string): void {
  xdo(display, ["windowfocus", dialog]);
  if (xdo(display, ["getwindowfocus"]) !== dialog) throw new Error("native dialog did not receive focus");
  xdo(display, ["key", key]);
}

/** Windows carrying a title, without the exactly-one guard `findWindowId`
 *  applies. A search that FINDS NOTHING is a legitimate answer here — it is how
 *  "the dialog never opened" is detected — so xdotool's exit code 1 for an empty
 *  result must not throw. */
function windowsTitled(display: string, title: string): string[] {
  const proc = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", `^${title}$`], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout.toString().trim().split("\n").filter(Boolean);
}

/** How many windows share the application's own WM_CLASS. Diagnostic, and the
 *  reason this rig never calls `findWindowId` while a dialog is open: the GTK
 *  dialog inherits the app's class, so that helper's exactly-one guard fires,
 *  correctly, and the failure reads as a MISSING window rather than an extra
 *  one. */
function classMatches(display: string): number {
  const proc = Bun.spawnSync(
    ["xdotool", "search", "--onlyvisible", "--class", SHELL_WINDOW_CLASS_PATTERN],
    { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" },
  );
  return proc.stdout.toString().trim().split("\n").filter(Boolean).length;
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

async function waitForDialogGone(display: string, title: string, waitMs = DIALOG_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (windowsTitled(display, title).length === 0) return true;
    await Bun.sleep(DIALOG_POLL_MS);
  }
  return false;
}

/** GTK completes long paths while `xdotool type` is still writing them, and
 * duplicates path components. xclip forks to own the clipboard, so its output
 * streams must not be piped into this synchronous rig. */
function pasteClipboard(display: string, wid: string, value: string): void {
  const clipped = Bun.spawnSync(["xclip", "-selection", "clipboard"], {
    stdin: Buffer.from(value),
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, DISPLAY: display },
  });
  if (clipped.exitCode !== 0) {
    throw new Error(`xclip failed with exit ${clipped.exitCode}`);
  }
  xdo(display, ["key", "--window", wid, "ctrl+v"]);
}

function captureDialogWindow(display: string, wid: string, name: string): void {
  const directory = process.env.APP_DIALOG_CAPTURE_DIR;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  const shot = Bun.spawnSync(["import", "-display", display, "-window", wid, join(directory, `${name}.png`)],
    { stdout: "ignore", stderr: "pipe" });
  if (shot.exitCode !== 0) throw new Error(`folder capture failed: ${shot.stderr.toString()}`);
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

/** Scenes the store holds, read directly with bun:sqlite. The ORACLE: a count
 *  taken from the application would be checking the application against itself.
 *  Trashed items are excluded the way the exporter excludes them — by walking
 *  from the roots and skipping the bin's subtree — but the tiny fixture seeds no
 *  bin, so this is the plain count and says so if that ever changes. */
function storeScenes(projectPath: string): number {
  const db = new Database(projectPath, { readonly: true });
  try {
    const rows = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item WHERE type = 'scene'")
      .all();
    return rows[0]?.n ?? 0;
  } finally {
    db.close();
  }
}

function markdownFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".md"));
}

function databaseFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".db"));
}

/** Kept inside this temporary rig root and reduced to a count before results are
 * written. The cancel oracle therefore catches any new database, wherever the
 * broken picker put it, without retaining private filenames. */
function databasePathsUnder(dir: string): string[] {
  const found: string[] = [];
  const visit = (at: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".db")) found.push(path);
    }
  };
  visit(dir);
  return found;
}

function createdBook(path: string): { readable: boolean; name: string; starterScenes: number } {
  if (!existsSync(path)) return { readable: false, name: "", starterScenes: 0 };
  try {
    const db = new Database(path, { readonly: true });
    try {
      const name = db.query("SELECT value FROM meta WHERE key = 'project_name'").get() as { value?: string } | undefined;
      const scenes = db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'scene'").get() as { n?: number } | undefined;
      return { readable: true, name: name?.value ?? "", starterScenes: scenes?.n ?? 0 };
    } finally {
      db.close();
    }
  } catch {
    return { readable: false, name: "", starterScenes: 0 };
  }
}

let root = "";
function abort(message: string): never {
  console.error(`\n${message}\nNothing was written.`);
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; dialog run skipped (needs a display and a built shell).");
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

root = mkdtempSync(join(tmpdir(), "app-dialog-"));

interface BootResult {
  dialogOpened: boolean;
  classMatchesWhileOpen: number;
  peakRssMb: number;
}

/** One boot. `chosenPath` null means CANCEL the dialog instead of accepting it.
 *
 *  The nonce is typed BEFORE the menu is opened, which is what makes the drain
 *  claim measurable: the flush debounce is 1000ms and everything from the
 *  keystroke to the export is a handful of xdotool spawns inside it. */
async function boot(
  label: string,
  projectPath: string,
  exportDir: string,
  dataHome: string,
  chosenPath: string | null,
): Promise<BootResult> {
  const observed = { dialogOpened: false, classMatchesWhileOpen: 0 };
  const run = await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      // Where the dialog OPENS, so the rig does not depend on the process's cwd
      // and does not have to type a directory as well as a name.
      APP_EXPORT_DIR: exportDir,
      XDG_DATA_HOME: dataHome,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("dialog rig requires a fixed X display");
      const display = `:${displayNum}`;
      // Before any dialog exists, so the exactly-one guard is still meaningful
      // and still worth having.
      const wid = findWindowId(display);

      // windowfocus / getwindowfocus, never windowactivate: the developer's
      // XWayland does not answer EWMH active-window queries, and typing into
      // whatever happens to be focused once put test sentences into the
      // operator's live terminal.
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(
          `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`,
        );
      }

      // THE ONE WALK. Its only job is the editable's box; the menu is driven by
      // keystrokes precisely so a second walk is never needed.
      const nodes: Node[] = locateNodes(rootPid);
      const editable = nodes.find((n) => n.role === "entry" || n.role === "text");
      if (editable === undefined) {
        throw new Error(
          `no editable in the accessibility tree; saw roles: ${[...new Set(nodes.map((n) => n.role))].join(", ")}`,
        );
      }
      // The centre of the editable, not its bottom-right corner. AT-SPI reports
      // LAYOUT extents, so a document longer than the pane puts that corner
      // outside the window - and X clamps the pointer to the screen rather than
      // erroring, so the click lands somewhere else and still reports success.
      // The centre of a scene's first paragraph is inside the pane at every
      // fixture size, and the caret only has to be IN the document: the nonce is
      // a sentence, not an append to a specific position.
      const at = centreOf(editable);
      xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
      xdo(display, ["click", "--window", wid, "1"]);
      await Bun.sleep(400);
      xdo(display, ["type", "--window", wid, "--delay", "20", NONCE]);
      await Bun.sleep(400);

      await menuDriver(display, wid, xdo).activate("menu-export-as");

      const dialog = await waitForDialog(display, EXPORT_DIALOG_TITLE);
      if (dialog === null) {
        // Left as false. The gates preserve this product failure as evidence.
        return;
      }
      observed.dialogOpened = true;
      observed.classMatchesWhileOpen = classMatches(display);

      xdo(display, ["windowfocus", dialog]);
      await Bun.sleep(400);

      if (chosenPath === null) {
        answerDialog(display, dialog, "Escape");
      } else {
        // ctrl+a first: the name entry opens with the default filename selected
        // in most themes and not in all of them, and typing over an unselected
        // default would produce a path nobody chose.
        xdo(display, ["key", "--window", dialog, "ctrl+a"]);
        await Bun.sleep(200);
        // A GTK save dialog's name entry accepts an absolute path and treats it
        // as one, which is what lets this rig name a destination outside the
        // directory the dialog opened in.
        xdo(display, ["type", "--window", dialog, "--delay", "20", chosenPath]);
        await Bun.sleep(400);
        answerDialog(display, dialog, "Return");
      }
      await Bun.sleep(SETTLE_MS);
    },
  });
  console.log(
    `  ${label.padEnd(10)} dialog ${observed.dialogOpened ? "opened" : "NEVER APPEARED"}, ` +
      `peak RSS ${run.peakRssMb} MB`,
  );
  return { ...observed, peakRssMb: run.peakRssMb };
}

interface FolderBootResult {
  dialogOpened: boolean;
  dialogClosed: boolean;
  dialogReadyAgain: boolean;
  peakRssMb: number;
}

/** One independent project-creation boot. The File-menu route opens the panel
 * with its name field focused; one Tab reaches `#project-new-choose`, whose
 * activation is therefore keyboard-only and does not add an AT-SPI walk. */
async function folderBoot(
  label: string,
  projectPath: string,
  dataHome: string,
  name: string,
  chosenDir: string | null,
): Promise<FolderBootResult> {
  const observed = { dialogOpened: false, dialogClosed: false, dialogReadyAgain: false };
  const run = await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      XDG_DATA_HOME: dataHome,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum }) => {
      if (displayNum === null) throw new Error("dialog rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowfocus", wid]);
      if (xdo(display, ["getwindowfocus"]) !== wid) {
        throw new Error("refusing to type: keyboard focus is not the app window");
      }

      await menuDriver(display, wid, xdo).activate("menu-project-new");
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["type", "--window", wid, "--delay", "20", name]);
      xdo(display, ["key", "--window", wid, "Tab"]);
      xdo(display, ["key", "--window", wid, "Return"]);

      const dialog = await waitForDialog(display, FOLDER_DIALOG_TITLE);
      if (dialog === null) return;
      observed.dialogOpened = true;
      xdo(display, ["windowfocus", dialog]);
      await Bun.sleep(400);
      captureDialogWindow(display, dialog, chosenDir === null ? "folder-cancel" : "folder-choose");
      if (chosenDir === null) {
        answerDialog(display, dialog, "Escape");
      } else {
        xdo(display, ["key", "--window", dialog, "ctrl+l"]);
        await Bun.sleep(300);
        pasteClipboard(display, dialog, chosenDir);
        await Bun.sleep(300);
        answerDialog(display, dialog, "Return");
        // Some GTK builds accept the location on Return; others enter the
        // folder first. Do not send the second acceptance to a dead window.
        if (!await waitForDialogGone(display, FOLDER_DIALOG_TITLE, 500)) {
          try {
            answerDialog(display, dialog, "alt+o");
          } catch (error) {
            if (windowsTitled(display, FOLDER_DIALOG_TITLE).length > 0) throw error;
          }
        }
      }
      observed.dialogClosed = await waitForDialogGone(display, FOLDER_DIALOG_TITLE);
      if (chosenDir === null && observed.dialogClosed) {
        // A vanished picker is not enough: a host crash or unresolved callback
        // leaves no window and no database too. Reopen the same exact-title
        // picker, then cancel it, to prove the first cancellation released it.
        try {
          await Bun.sleep(SETTLE_MS);
          xdo(display, ["windowfocus", wid]);
          captureDialogWindow(display, wid, "folder-cancel-return");
          await menuDriver(display, wid, xdo).activate("menu-project-new");
          await Bun.sleep(SETTLE_MS);
          xdo(display, ["key", "--window", wid, "ctrl+a"]);
          xdo(display, ["type", "--window", wid, "--delay", "20", name]);
          xdo(display, ["key", "--window", wid, "Tab"]);
          xdo(display, ["key", "--window", wid, "Return"]);
          captureDialogWindow(display, wid, "folder-cancel-retry");
          const retry = await waitForDialog(display, FOLDER_DIALOG_TITLE);
          if (retry !== null) {
            xdo(display, ["windowfocus", retry]);
            answerDialog(display, retry, "Escape");
            observed.dialogReadyAgain = await waitForDialogGone(display, FOLDER_DIALOG_TITLE);
          }
        } catch (error) {
          console.error(`folder retry failed: ${error instanceof Error ? error.message : String(error)}`);
          // Product liveness failures stay as red evidence rather than becoming
          // a harness abort after the first cancellation has been observed.
        }
      }
      await Bun.sleep(SETTLE_MS);
    },
  });
  console.log(
    `  ${label.padEnd(10)} folder dialog ${observed.dialogOpened ? "opened" : "NEVER APPEARED"}, ` +
      `${observed.dialogClosed ? "closed" : "STILL OPEN"}, ${observed.dialogReadyAgain ? "ready again" : "NOT READY AGAIN"}, peak RSS ${run.peakRssMb} MB`,
  );
  return { ...observed, peakRssMb: run.peakRssMb };
}

/** The import half. A SEPARATE function rather than a flag on `boot`: the two
 *  drive different menu items, wait on different titles, and are graded against
 *  different oracles, and a boot that branched four ways on a parameter would
 *  be harder to read than two that each do one thing.
 *
 *  Nothing had ever opened this window. `project_import_pick` shares
 *  `ask_for_*`'s async-callback shape with the export command, and the export
 *  command's SYNCHRONOUS ancestor opened no window at all while reporting
 *  nothing — so "it is the same shape" was an argument, not a measurement. */
async function importBoot(
  projectPath: string,
  dataHome: string,
  sourcePath: string,
): Promise<{ dialogOpened: boolean; peakRssMb: number }> {
  const observed = { dialogOpened: false };
  const run = await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: projectPath,
      XDG_DATA_HOME: dataHome,
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum }) => {
      if (displayNum === null) throw new Error("dialog rig requires a fixed X display");
      // Before any dialog exists, while the exactly-one guard still means
      // something: a GTK dialog inherits this application's WM_CLASS.
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowfocus", wid]);
      const focused = xdo(display, ["getwindowfocus"]);
      if (focused !== wid) {
        throw new Error(`refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`);
      }
      // NO AT-SPI WALK AT ALL in this boot. It needs no widget geometry: the
      // menu is keystrokes and the dialog is found by title.
      await menuDriver(display, wid, xdo).activate("menu-import");

      const dialog = await waitForDialog(display, IMPORT_DIALOG_TITLE);
      if (dialog === null) return;
      observed.dialogOpened = true;

      xdo(display, ["windowfocus", dialog]);
      await Bun.sleep(400);
      // Ctrl+L is the GTK file chooser's "type a location" affordance; the
      // open dialog has no name entry to type into the way the save one does.
      xdo(display, ["key", "--window", dialog, "ctrl+l"]);
      await Bun.sleep(300);
      pasteClipboard(display, dialog, sourcePath);
      await Bun.sleep(400);
      answerDialog(display, dialog, "Return");
      await Bun.sleep(SETTLE_MS);
    },
  });
  console.log(
    `  ${"import".padEnd(10)} dialog ${observed.dialogOpened ? "opened" : "NEVER APPEARED"}, ` +
      `peak RSS ${run.peakRssMb} MB`,
  );
  return { ...observed, peakRssMb: run.peakRssMb };
}

/** The projects the library holds, which is where an import lands. */
function libraryProjects(dataHome: string): string[] {
  const dir = join(dataHome, "garret", "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => join(dir, name));
}

function seed(path: string): void {
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, path], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`);
}

function homeFor(label: string): string {
  const dir = join(root, `home-${label}`);
  mkdirSync(join(dir, "garret"), { recursive: true });
  return dir;
}

console.log("[1/5] choosing an export destination in the dialog");
const chooseProject = join(root, "choose.db");
seed(chooseProject);
const chooseExportDir = join(root, "exports-choose");
mkdirSync(chooseExportDir, { recursive: true });
// Deliberately NOT inside the export directory the dialog opens in: a build that
// ignored the chosen path and wrote where it prefers would otherwise land in the
// same folder and the gate could not tell the two apart.
const chosenDir = join(root, "chosen");
mkdirSync(chosenDir, { recursive: true });
const chosenPath = join(chosenDir, "the-writers-choice.md");

const chose = await boot("choose", chooseProject, chooseExportDir, homeFor("choose"), chosenPath);

const wroteChosen = existsSync(chosenPath);
const written = wroteChosen ? readFileSync(chosenPath, "utf8") : "";
const manuscript = wroteChosen ? readManuscript(written) : null;
// The exporter emits an H2 for a part, H3 for a chapter, H4 for a scene at the
// tiny fixture's depths; scenes are the sections that carry prose. Counted from
// the harness's OWN reader, never from export.rs.
const fileScenes = manuscript?.sections.filter((s) => s.text.length > 0).length ?? 0;
const scenesInStore = storeScenes(chooseProject);
if (scenesInStore === 0) {
  abort("the seeded project holds no scenes, so the content gate would compare two zeroes");
}

console.log("[2/5] cancelling the export dialog");
const cancelProject = join(root, "cancel.db");
seed(cancelProject);
const cancelExportDir = join(root, "exports-cancel");
mkdirSync(cancelExportDir, { recursive: true });
const cancelDir = join(root, "cancelled");
mkdirSync(cancelDir, { recursive: true });

const cancelled = await boot("cancel", cancelProject, cancelExportDir, homeFor("cancel"), null);
// Everywhere a file could plausibly land: the directory the dialog opened in and
// the one the choosing boot wrote into. A cancel that wrote SOMEWHERE is still a
// cancel that wrote.
const cancelWrote =
  markdownFilesIn(cancelExportDir).length + markdownFilesIn(cancelDir).length;

console.log("[3/5] choosing a project folder in the dialog");
const folderName = "A Book Chosen Here";
const folderHome = homeFor("folder-choose");
const folderSource = join(root, "folder-source.db");
seed(folderSource);
const folderChosenDir = join(root, "folder-chosen");
mkdirSync(folderChosenDir, { recursive: true });
const folderDefaultDir = join(folderHome, "garret", "projects");
const folderChosen = await folderBoot("folder choose", folderSource, folderHome, folderName, folderChosenDir);
const folderChosenFiles = databaseFilesIn(folderChosenDir);
const folderBook = folderChosenFiles.length === 1
  ? createdBook(join(folderChosenDir, folderChosenFiles[0] as string))
  : { readable: false, name: "", starterScenes: 0 };

console.log("[4/5] cancelling the project folder dialog");
const folderCancelHome = homeFor("folder-cancel");
const folderCancelSource = join(root, "folder-cancel-source.db");
seed(folderCancelSource);
const folderCancelBefore = new Set(databasePathsUnder(root));
const folderCancelled = await folderBoot(
  "folder cancel",
  folderCancelSource,
  folderCancelHome,
  "A Book Not Created",
  null,
);
const folderCancelFiles = databasePathsUnder(root).filter((path) => !folderCancelBefore.has(path)).length;

console.log("[5/5] importing through the dialog");
// The file the CHOOSING boot exported, imported back in. A genuine round trip
// through both dialogs, and its structure is guaranteed valid because the
// application wrote it - a hand-authored fixture would be testing my
// restatement of the format as much as the importer.
const importHome = homeFor("import");
const importProject = join(root, "import-host.db");
seed(importProject);
if (libraryProjects(importHome).length !== 0) {
  abort("the library already held a project before the import, so a new one cannot be attributed");
}
const imported = wroteChosen
  ? await importBoot(importProject, importHome, chosenPath)
  : { dialogOpened: false, peakRssMb: 0 };
const libraryAfter = libraryProjects(importHome);
// The imported project read out of SQLite, against the FILE read with the
// harness's own restatement of the format. Never against import.rs.
const importedScenes = libraryAfter.length === 1 ? storeScenes(libraryAfter[0] as string) : -1;

const metrics: DialogMetrics = {
  dialog_opened: chose.dialogOpened,
  class_matches_while_open: chose.classMatchesWhileOpen,
  chosen_path: chosenPath,
  wrote_chosen_path: wroteChosen,
  file_scenes: fileScenes,
  store_scenes: scenesInStore,
  nonce_in_file: written.includes(NONCE),
  cancel_dialog_opened: cancelled.dialogOpened,
  cancel_files_written: cancelWrote,
  import_dialog_opened: imported.dialogOpened,
  library_projects_after_import: libraryAfter.length,
  imported_scenes: importedScenes,
  folder_dialog_opened: folderChosen.dialogOpened,
  folder_dialog_closed: folderChosen.dialogClosed,
  folder_chosen_files: folderChosenFiles.length,
  folder_default_files: databaseFilesIn(folderDefaultDir).length,
  folder_database_readable: folderBook.readable,
  folder_project_name: folderBook.name,
  folder_expected_name: folderName,
  folder_starter_scenes: folderBook.starterScenes,
  folder_cancel_dialog_opened: folderCancelled.dialogOpened,
  folder_cancel_dialog_closed: folderCancelled.dialogClosed,
  folder_cancel_ready_again: folderCancelled.dialogReadyAgain,
  folder_cancel_files: folderCancelFiles,
  // The tree's peak, sampled by runShell, from the CHOOSING boot: that is the
  // one that renders the whole manuscript and holds it alongside the store and
  // the dialog's own GTK window.
  peak_rss_mb: chose.peakRssMb,
};

const verdicts = evaluateDialogGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

writeResult(
  buildResult({
    runId: "app-dialog-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-dialog",
    verdicts,
    metrics: {
      ...metrics,
      scope:
        "the dialog is a GTK window belonging to the host process, not something this " +
        "application draws, and every figure about it is xdotool's reading of the X server. " +
        "The project-folder boots route through File > New project, type a name and activate " +
        "Choose a folder with the keyboard; their exact-title native dialog and SQLite reads " +
        "distinguish the chosen directory from the default library. " +
        "Xvfb has no window manager and no XDG portal, so this measures the gtk3 backend only: " +
        "enabling tauri-plugin-dialog's xdg-portal feature would put a different implementation " +
        "under the same gates and this run would say nothing about it.",
      omitted_gates:
        "no latency, stall, cliff or a11y figures: this rig types one sentence and opens two " +
        "windows, which has nothing true to say about frame cadence. No a11y_exposure either - " +
        "the dialog's accessibility is GTK's, not this application's, and one AT-SPI walk per " +
        "boot is spent on the editable's box because several walks in one window kill the app. " +
        "The import boot takes NO walk at all - it needs no widget geometry, because the menu " +
        "is keystrokes and the dialog is found by title.",
    },
    seed: "n/a",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

rmSync(root, { recursive: true, force: true });
process.exit(verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0);
