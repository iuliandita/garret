// app/harness/src/first-cli.ts
// Graded FIRST-RUN run: what a person meets when they open this application for
// the first time.
//
// THE PATH NO OTHER RIG HERE TAKES, and until 2026-08-26 the only path in the
// application with no coverage of any kind. Every other graded rig seeds a
// project through the host and boots it with `APP_PROJECT`; every screenshot in
// `app/results/screenshots/` is of a seeded project. Slices 023 and 024 fixed
// four defects that were all visible in the FIRST FRAME of the unseeded path -
// no way to quit the application from inside it, a starter project called
// `default`, no rename anywhere, and an import section naming no folder - and
// not one of them could have been found by anything already in this directory.
//
// So this rig does the opposite of `runShell`. No fixture. No `APP_PROJECT`, no
// `APP_RUN=measure`, no `APP_MODE`, no sink, no isolated-data-home flag from the
// harness's own contract. An EMPTY `XDG_DATA_HOME` and the binary, which is what
// `scripts/run-app` does and what a desktop entry does.
//
// TWO DELIBERATE DEVIATIONS, both stated rather than hidden:
//
//   - `XDG_DATA_HOME` points at a fresh temp directory. That IS the subject -
//     "first run" means no library and no settings - and it is also what keeps
//     the rig from writing into the operator's real manuscripts, which seven
//     graded rigs did before `runShell` isolated them.
//   - `APP_DIST` names `app/ui/dist`. The host resolves its asset root from the
//     working directory when nothing names it, and a rig that depends on its own
//     cwd for which BUILD it measures is the stale-`dist` failure with an extra
//     step. This variable chooses no project, no mode and no workload; it says
//     where the page is.
//
// WHAT IT ASSERTS is a person's first five minutes, not latency: a window comes
// up, their book is called something that is not a filename, typing reaches the
// store, Ctrl+Q actually leaves, and the sentence is still there afterwards.
// The quit gate is the only automated check in this repo that the chord closes
// anything at all - every unit test of that path stops at `requestQuit` being
// called.
//
// Usage: APP_GUI=1 bun app/harness/src/first-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { evaluateFirstRunGates, type FirstRunMetrics } from "./gates";
import { buildResult, writeResult } from "./results";
import { sumTreeRssKb } from "./rss";
import {
  BIN,
  SHELL_PROC_NAME,
  SHELL_WINDOW_CLASS_PATTERN,
  assertAtspiBridgeEnabled,
  freeDisplayNumber,
  killShellAndReap,
  spawnOwned,
  survivingShellPids,
} from "./shell";

const DIST = "app/ui/dist";
const RESULTS = "app/results";

/** The file the host creates when there is nothing to open. Restated from
 *  `DEFAULT_PROJECT` in main.rs rather than imported - two programs, and a
 *  shared constant hides a drift instead of failing on it. Its STEM is what the
 *  naming gate compares the project's name against. */
const DEFAULT_PROJECT_FILE = "default.db";

/** Typed into the starter scene. Six words, none of which appear anywhere in the
 *  application's own strings, so finding it in a stored body cannot be a match
 *  against boilerplate. */
const SENTENCE = "Quillon watched the sarsen stones darken.";
const SENTENCE_WORDS = 6;

/** How long to wait for a window that a cold WebKit has to create, map and lay
 *  out under Xvfb. Polled, not slept through.
 *
 *  A FIRST attempt at this session used nine seconds and reported "no window"
 *  for an application that was starting normally. `STARTUP_GRACE_MS` in
 *  shell.ts is 300 s for the same reason and against the same failure. */
const WINDOW_WAIT_MS = 90_000;
const WINDOW_POLL_MS = 500;

/** xdotool returns when X has the key events, not when WebKitGTK has turned
 *  them into document state. Measured elsewhere in this harness at 500 ms
 *  silently truncating typed text; 2500 ms is what held. */
const SETTLE_MS = 2500;

/** The flush debounce plus room. Typing has to reach the STORE, not just the
 *  document, before the quit - otherwise the writing gate would be measuring
 *  the close's drain and the typing gate would be measuring nothing. */
const FLUSH_WAIT_MS = 3000;

/** How long the window is given to go away after Ctrl+Q. The host's own
 *  fallback thread force-closes at 2 s when the page is not holding the close
 *  open, so anything past that is the window refusing. */
const QUIT_WAIT_MS = 12_000;
const QUIT_POLL_MS = 250;

if (process.env.APP_GUI !== "1") {
  console.log("first-cli: skipped (set APP_GUI=1 to run it)");
  process.exit(0);
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

/** The one visible window carrying the shell's class, or null.
 *
 *  BY CLASS, never by title: the title is the open project's NAME, and this rig
 *  exists partly to find out what that name is. Matching on it would be matching
 *  on the thing under test. */
function windowId(display: string): string | null {
  const proc = Bun.spawnSync(
    ["xdotool", "search", "--onlyvisible", "--class", SHELL_WINDOW_CLASS_PATTERN],
    { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" },
  );
  const ids = proc.stdout.toString().trim().split("\n").filter(Boolean);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

/** Every scene body in the project, read from the FILE after the process that
 *  wrote it is gone. The store's own account, not the application's. */
function storedBodies(projectPath: string): string[] {
  const db = new Database(projectPath, { readonly: true });
  try {
    const rows = db.query("SELECT body FROM doc").all() as { body: string }[];
    return rows.map((r) => r.body);
  } finally {
    db.close();
  }
}

/** The project's own name, from the meta row `summarize` reads. Empty when the
 *  project carries none, which is the state the naming gate exists to fail. */
function storedName(projectPath: string): string {
  const db = new Database(projectPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'project_name'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? "";
  } finally {
    db.close();
  }
}

/** The first outline exactly as the host wrote it. This is deliberately a
 * direct SQLite read: page labels can be localized even when the host-created
 * rows behind them are not. */
function storedStarterItems(
  projectPath: string,
): { id: string; type: string; title: string; parent_id: string | null }[] {
  const db = new Database(projectPath, { readonly: true });
  try {
    return db.query("SELECT id, type, title, parent_id FROM item ORDER BY rowid").all() as {
      id: string;
      type: string;
      title: string;
      parent_id: string | null;
    }[];
  } finally {
    db.close();
  }
}

/** The prose inside a stored body.
 *
 *  A body is a ProseMirror document as JSON, and the first version of this rig
 *  counted words in the RAW STRING. An empty scene serializes to
 *  `{"type":"doc","content":[{"type":"paragraph"}]}` -- no whitespace at all --
 *  so it counted as ONE word and the typing gate passed against a run in which
 *  nothing had been typed. It took a real FAIL elsewhere in the same run to
 *  notice. The gate now reads text nodes, where an empty document is 0. */
function proseIn(body: string): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") out.push(record.text);
    if (record.content !== undefined) visit(record.content);
  };
  try {
    visit(JSON.parse(body));
  } catch {
    // A body that is not JSON is not prose this rig can read, and reporting it
    // as prose would be worse than reporting none.
    return "";
  }
  return out.join(" ");
}

/** Words across every stored body. Deliberately crude and deliberately NOT
 *  `words.ts`'s rule: this gate asks whether typing reached the store at all,
 *  and restating the product's word rule here would make a disagreement about
 *  hyphens look like a lost sentence. */
function wordsIn(bodies: string[]): number {
  return bodies
    .map(proseIn)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

async function main(): Promise<void> {
  assertAtspiBridgeEnabled(process.env);
  if (!existsSync(DIST)) {
    throw new Error(`${DIST} does not exist. Build the page first: cd app/ui && bun run build`);
  }
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} does not exist. Build the host: cd app/shell-tauri/src-tauri && cargo build --release`);
  }
  if (survivingShellPids().length > 0) {
    throw new Error(
      `a ${SHELL_PROC_NAME} is already running; this rig counts windows by class and a second one ` +
        `would make the count ambiguous.`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), "app-first-"));
  const dataHome = join(work, "data-home");
  // THE PROJECTS DIRECTORY IS NOT CREATED. A first run has to create its own
  // library and its own default project, and a rig that made either one first
  // has quietly done the application's first act for it.
  //
  // ONLY `settings.json` ITSELF IS PLANTED, and only since 100 flipped
  // `Start`'s default to `Home`: this rig's whole subject is the
  // CREATED-DEFAULT path (`open_from_library`'s `Choice::Default` arm), which
  // `Start::Home` would skip entirely with no `APP_PROJECT` to fall back to --
  // this rig has none, because the project this asserts on does not exist
  // before the boot it creates it in. `start: "last"` is the one line that
  // keeps this rig testing the same path it always has; nothing else about
  // "first run" changes.
  mkdirSync(join(dataHome, "cc.local.app"), { recursive: true });
  writeFileSync(
    join(dataHome, "cc.local.app", "settings.json"),
    JSON.stringify({ start: "last", locale: "de" }),
  );
  // Through the harness's own picker, reserving an unused private display for
  // the Xvfb process this rig starts and owns below.
  const display = `:${freeDisplayNumber()}`;
  const projectPath = join(dataHome, "cc.local.app", "projects", DEFAULT_PROJECT_FILE);

  const observed = {
    window_opened: false,
    quit_closed_the_window: false,
    peak_rss_mb: 0,
  };
  let starterItems: { id: string; type: string; title: string; parent_id: string | null }[] = [];

  console.log(`[1/4] launching with an EMPTY data home (${dataHome})`);
  // THE X SERVER IS STARTED SEPARATELY, and this rig is the only one here that
  // does it. Every other rig goes through `xvfb-run`, which exits when its child
  // exits and tears the display down with it -- and this rig's whole subject is
  // the application EXITING. The first version used `xvfb-run` and the quit gate
  // failed with "X connection to :91 broken": Ctrl+Q had worked, the host had
  // gone, the wrapper had shut the server down, and xdotool -- which restores
  // the modifier map after `--clearmodifiers` -- reported the loss as its own
  // failure. The instrument was being destroyed by the thing it measures.
  const xvfb = Bun.spawn(
    ["Xvfb", display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
    { stdout: "ignore", stderr: "ignore" },
  );
  await Bun.sleep(1500);

  const owned = await spawnOwned(
    [BIN],
    {
      env: {
        ...process.env,
        // AFTER the spread, not before. An operator running this from a live
        // session has a DISPLAY of their own, and a rig that let it win would
        // put the window on their desktop and type into it.
        DISPLAY: display,
        XDG_DATA_HOME: dataHome,
        APP_DIST: DIST,
        // XWayland/X11 rather than native Wayland, exactly as scripts/run-app
        // does and for the same recorded reason: a native-Wayland client on this
        // machine will not take keyboard focus by IPC at all.
        GDK_BACKEND: "x11",
      },
      // Ignored rather than piped: nothing here reads it, and a pipe nobody
      // drains blocks the writer once the buffer fills.
      stdout: "ignore",
      stderr: "pipe",
    },
  ).catch(async (error: unknown) => {
    xvfb.kill();
    await xvfb.exited;
    throw error;
  });
  const proc = owned.proc;

  // Collected as it arrives, not read at the end: a rig whose subject died has
  // to be able to SAY why, and a piped stream nobody drains can also fill and
  // block the writer. The first version of this rig reported "X connection
  // broken" for a host that had exited with a reason on stderr nobody read.
  let hostErr = "";
  void (async (): Promise<void> => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) hostErr += decoder.decode(value, { stream: true });
    }
  })();

  const withHostErr = (message: string): string => {
    const tail = hostErr
      .split("\n")
      .filter((line) => line.trim() !== "" && !/Gtk-(WARNING|Message)|libenchant|libEGL/.test(line))
      .slice(-8)
      .join("\n");
    return tail === "" ? message : `${message}\n\nthe host said:\n${tail}`;
  };

  try {
    let wid: string | null = null;
    for (let waited = 0; waited < WINDOW_WAIT_MS && wid === null; waited += WINDOW_POLL_MS) {
      await Bun.sleep(WINDOW_POLL_MS);
      wid = windowId(display);
    }
    if (wid === null) {
      throw new Error(
        withHostErr(
          `no window with class ${SHELL_WINDOW_CLASS_PATTERN} on ${display} after ` +
            `${WINDOW_WAIT_MS / 1000}s. A first run produced no application.`,
        ),
      );
    }
    observed.window_opened = true;
    console.log(`[2/4] window up, titled "${xdoRead(display, ["getwindowname", wid]).trim()}"`);
    // Before typing or any menu action. The initial title rows are the host's
    // creation act, so reading labels later through the page would only prove
    // the page catalog, not what a new project stores.
    starterItems = storedStarterItems(projectPath);

    // Click into the prose column and type. A click rather than a keystroke for
    // the reason switch-cli clicks: it is the affordance most likely to be
    // broken and least likely to be caught by a unit test.
    const geometry = xdoRead(display, ["getwindowgeometry", "--shell", wid]);
    const width = Number(geometry.match(/\bWIDTH=(\d+)/)?.[1] ?? 0);
    const height = Number(geometry.match(/\bHEIGHT=(\d+)/)?.[1] ?? 0);
    if (width === 0 || height === 0) {
      throw new Error(`the window reports ${width}x${height}; there is nothing to click into.`);
    }
    // FOCUS FIRST, and check it took. Without this the click selects and the
    // keystrokes go nowhere: the first version of this rig typed a sentence into
    // a window that did not have the keyboard and recorded an empty scene.
    // `dialog-cli` already does exactly this and says the same thing.
    xdo(display, ["windowfocus", wid]);
    await Bun.sleep(300);
    const focused = xdoRead(display, ["getwindowfocus"]).trim();
    if (focused !== wid) {
      throw new Error(`refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`);
    }
    xdo(display, ["mousemove", "--window", wid, String(Math.floor(width * 0.7)), String(Math.floor(height * 0.4))]);
    xdo(display, ["click", "--window", wid, "1"]);
    await Bun.sleep(600);
    xdo(display, ["type", "--window", wid, "--clearmodifiers", "--delay", "20", SENTENCE]);
    await Bun.sleep(SETTLE_MS + FLUSH_WAIT_MS);
    observed.peak_rss_mb = Math.max(observed.peak_rss_mb, Math.round(sumTreeRssKb(proc.pid) / 1024));

    console.log("[3/4] asking to leave with Ctrl+Q");
    // The window has to still BE there to be asked. A host that died during the
    // typing would otherwise be reported as "X connection broken", which names
    // the display and not the application.
    if (windowId(display) === null) {
      throw new Error(
        withHostErr("the window went away before Ctrl+Q was pressed, so the quit gate has no subject."),
      );
    }
    // SENT TOLERANTLY, and this is the one place in the rig where an xdotool
    // failure is not a rig failure. The chord's SUCCESS destroys the window it
    // was sent to, so xdotool can be mid-request when the window goes: one run
    // failed with `BadWindow ... X_SendEvent` for a quit that had worked
    // perfectly. Whether the application left is decided by the poll below --
    // by looking -- and never by this command's exit status.
    Bun.spawnSync(["xdotool", "key", "--window", wid, "--clearmodifiers", "ctrl+q"], {
      env: { ...process.env, DISPLAY: display },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let waited = 0; waited < QUIT_WAIT_MS; waited += QUIT_POLL_MS) {
      await Bun.sleep(QUIT_POLL_MS);
      if (windowId(display) === null && proc.exitCode !== null) {
        observed.quit_closed_the_window = true;
        break;
      }
    }
  } catch (error) {
    // EVERY failure carries the host's own words, not just the two that
    // remembered to ask for them. A rig that reports "BadWindow" for an
    // application that printed a reason and exited has told the reader about
    // xdotool.
    throw new Error(withHostErr(error instanceof Error ? error.message : String(error)));
  } finally {
    // Always, and after the quit gate has already been decided: a rig that
    // cannot tell its own cleanup from the application leaving would report the
    // kill as a successful quit.
    try {
      await killShellAndReap(owned);
    } finally {
      // The server is deliberately independent so quitting the app does not
      // destroy the instrument before xdotool finishes its key-up.
      xvfb.kill();
      await xvfb.exited;
    }
  }

  console.log("[4/4] reading the project the first run created");
  if (!existsSync(projectPath)) {
    throw new Error(
      `no project at ${projectPath} after a first run. The application opened a window and created ` +
        `no manuscript, so every gate below would be describing a run with no subject.`,
    );
  }
  const bodies = storedBodies(projectPath);
  const metrics: FirstRunMetrics = {
    window_opened: observed.window_opened,
    project_name: storedName(projectPath),
    project_file_stem: DEFAULT_PROJECT_FILE.replace(/\.db$/, ""),
    starter_items: starterItems,
    words_after_typing: wordsIn(bodies),
    quit_closed_the_window: observed.quit_closed_the_window,
    stored_body_holds_the_sentence: bodies.some((b) => proseIn(b).includes(SENTENCE)),
    peak_rss_mb: observed.peak_rss_mb,
  };

  const verdicts = evaluateFirstRunGates(metrics);
  for (const v of verdicts) {
    console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
  }

  const record = buildResult({
    runId: "app-first-run",
    candidate: "tauri",
    fixture: "none",
    workload: "app-first",
    verdicts,
    metrics: {
      ...metrics,
      // The sentence is recorded so a later reader can tell a lost sentence
      // from a rig that changed what it types.
      sentence_words: SENTENCE_WORDS,
      documents: bodies.length,
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  });
  const written = writeResult(record, RESULTS);
  console.log(`\nwrote ${written}`);
  rmSync(work, { recursive: true, force: true });
  if (verdicts.some((v) => v.verdict === "FAIL")) process.exit(1);
}

await main();
