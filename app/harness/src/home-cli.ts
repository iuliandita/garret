// app/harness/src/home-cli.ts
// Graded no-project-boot run: does the window come up with nothing
// mounted when `settings.start` says so, does `last` keep today's behaviour
// exactly, and does `home` show the library screen with an affordable
// overview and word count and a working Continue-writing press.
//
// THE PATH `switch-cli` AND `project-cli` NEVER TAKE: both of them seed a
// project and pass `APP_PROJECT`, which is the harness's own contract and
// ignores `start` entirely -- no graded rig before this one has ever
// booted the host without it. This one deliberately does not: it plants
// `settings.json` itself and boots with `APP_PROJECT` UNSET, `project-cli`'s
// own shape (it boots with no `APP_PROJECT` too, so the startup order can
// pick a project on its own; this rig goes one step further and asks the
// startup order to pick NOTHING).
//
// ONE DATA HOME, THREE BOOTS. The same seeded library and the same
// `last_project` every time; only `settings.start` changes between them, so a
// difference in what mounts is a difference `start` made and nothing else.
//
// THE LIBRARY MIX: `tiny` seeds 3 `tiny`-fixture books; `APP_HOME_STRESS=1`
// seeds 9 `tiny`-fixture books plus 3 `stress`-fixture ones (12 total) --
// NOT 12 `stress` books, which an earlier design first proposed and then
// refused: twelve books at ~15,200 documents each is a day of seeding for a
// number this rig only needs one `stress` book to produce. The `stress`
// books are seeded LAST on purpose: with no `settings.recent` entry for any
// of them, the overview's own sort falls back to mtime, so the freshest
// (the `stress` books) is what the shelf's most-recent-first word-count
// fetch reaches FIRST -- which is what lets a short wait still catch the
// figure this rig actually needs.
//
// LIBRARY_OVERVIEW_MS AND LIBRARY_WORDS_MS ARE THE HOST'S OWN NUMBERS.
// `library_overview` answers with `took_ms` and `library_book_words` with
// `{ words, took_ms }`; the page paints both into `#library-timing`, a quiet
// status line library.ts owns, and this rig reads it by id through a small
// dedicated AT-SPI probe (export-cli's own PY_PROBE shape: found by id
// regardless of role, not the generic widget walk `nodes.ts` restricts to
// buttons and entries). Two earlier attempts are gone: a wall-clock read
// around process spawn and WebKit boot (it measured the window coming up,
// not the command), and timing the CLI's `inspect` subcommand for words
// (a different program that never called `library_book_words` or its
// `may_open` gate at all).
//
// `home_opens_the_book` READS THE DESK, IT DOES NOT ASSUME IT. Every seeded
// book here shares one fixture's project name unless this rig gives each one
// its own (`nameBook`, below) -- the first version of this rig did not, so
// every book showed the SAME name in the header and the press could never be
// told apart from a no-op. This reads `#library-desk-title` BEFORE pressing,
// maps that name back to a path through the rig's own seeded list, and after
// the press checks TWO observables against it: the tree has no `#library`
// marker and the header names the same book, AND `settings.recent[0]` is
// that book's path. A failure prints both readings.
//
// Usage: APP_GUI=1 bun app/harness/src/home-cli.ts
//        APP_GUI=1 APP_HOME_STRESS=1 bun app/harness/src/home-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PY_READ_NODES, PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateHomeGates, type HomeMetrics } from "./gates";
import { locateNodes } from "./nodes";
import { nodeToPress, parsePressSelector, pressPoint } from "./press-selector";
import { buildResult, writeResult } from "./results";
import { parseGeometry } from "./window-size";
import {
  BIN,
  SHELL_PROC_NAME,
  findWindowId,
  runShell,
  survivingShellPids,
  type RunOutcome,
} from "./shell";

const DIST = "app/ui/dist";
const TINY_FIXTURE = "lab/fixtures/out/tiny";
const STRESS_FIXTURE = "lab/fixtures/out/stress";
const RESULTS = "app/results";
const APP_DIR = "garret";
const PROJECTS_DIR = "projects";

/** A figure this rig could not read at all -- large enough to fail either
 *  gate's threshold outright rather than pass by accident, and still a
 *  finite number JSON can carry (`Infinity` serializes to `null`). */
const UNMEASURED_MS = 999_999;

/** `APP_HOME_STRESS=1` seeds the twelve-book mix instead of three `tiny` books. */
const STRESS = process.env.APP_HOME_STRESS === "1";

/** The interactive-mode sink payload (app/ui/src/main.ts, `run ===
 *  "interactive"`). NOT a SinkPayload: interactive mode types nothing and
 *  sinks no typing, nav or cycle data at all. Restated from project-cli.ts's
 *  own copy rather than shared -- two rigs, and a shared type across them
 *  hides a drift in what main.ts actually sinks instead of failing on it. */
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
  project_path: string;
  project_name: string;
  generation: number;
}

/** The three words `settings.start` holds. */
type Start = "home" | "last" | "blank";

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

if (process.env.APP_GUI !== "1") {
  console.log("home-cli: skipped (set APP_GUI=1 to run it)");
  process.exit(0);
}

for (const p of [BIN, DIST, TINY_FIXTURE, ...(STRESS ? [STRESS_FIXTURE] : [])]) {
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

// A private XDG_DATA_HOME, so the library under test is the one this rig
// seeded and nothing of the operator's -- project-cli's own reason.
const dataHome = mkdtempSync(join(tmpdir(), "app-home-"));
const library = join(dataHome, APP_DIR, PROJECTS_DIR);
const settingsPath = join(dataHome, APP_DIR, "settings.json");
function cleanup(): void {
  rmSync(dataHome, { recursive: true, force: true });
}

/** Seed one book from `fixture` at `<library>/<name>.db` and give it `name`
 *  as its OWN `project_name` meta row, overwriting whatever the fixture
 *  itself carried there.
 *
 *  EVERY BOOK A FIXTURE PRODUCES SHARES THAT FIXTURE'S PROJECT NAME
 *  (`lab/fixtures/out/tiny/project.json`'s `meta.name` is literally "tiny"),
 *  so three books seeded from one fixture show the SAME title on the desk
 *  and in the header. The first version of this rig did not rename them and
 *  `home_opens_the_book` could never tell a press from a no-op as a result --
 *  the header read "tiny" whether or not anything had actually switched. */
function seedBook(fixture: string, name: string): string {
  const path = join(library, `${name}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", fixture, path], { stdout: "inherit", stderr: "inherit" });
  if (seeded.exitCode !== 0) {
    console.error(`seeding ${name} failed (exit ${seeded.exitCode}); nothing was written.`);
    cleanup();
    process.exit(1);
  }
  const db = new Database(path);
  try {
    db.query(
      "INSERT INTO meta (key, value) VALUES ('project_name', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(name);
  } finally {
    db.close();
  }
  return path;
}

console.log(
  STRESS
    ? "[1/4] seeding a library of 9 tiny books + 3 stress books"
    : `[1/4] seeding a library of 3 books from ${TINY_FIXTURE}`,
);
mkdirSync(library, { recursive: true });
// `stress` seeded LAST under STRESS: freshest mtime, so with no
// `settings.recent` entry for anything the overview's own sort (opened_at
// desc, mtime desc among ties) puts it first in the shelf's most-recent-
// first word-count fetch -- see the module header.
const seededPaths: string[] = STRESS
  ? [
      ...Array.from({ length: 9 }, (_, i) => seedBook(TINY_FIXTURE, `tiny-${i + 1}`)),
      ...Array.from({ length: 3 }, (_, i) => seedBook(STRESS_FIXTURE, `stress-${i + 1}`)),
    ]
  : Array.from({ length: 3 }, (_, i) => seedBook(TINY_FIXTURE, `tiny-${i + 1}`));

/** `last_project` names A book -- any of them -- in every phase; only
 *  `start` changes between boots, so a difference in what mounts is a
 *  difference `start` made and nothing else. Not tied to whichever book the
 *  `home` boot's own desk turns out to be: the `last` boot does not care. */
function plantSettings(start: Start): void {
  writeFileSync(settingsPath, JSON.stringify({ last_project: seededPaths[0], start }));
}

// ------------------------------------------------------- the AT-SPI probe

/** Read a small set of nodes BY ID, whatever their ATK role -- `export-
 *  cli.ts`'s own `PY_PROBE` shape, needed here because `#library-timing` and
 *  `#library-desk-title` are plain text containers, not the buttons and
 *  entries `nodes.ts`'s generic walk is restricted to. ONE WALK for however
 *  many ids are asked for, `nodes.ts`'s own rule about the cost of a walk.
 *  Best-effort: a bridge that cannot answer at all returns an empty map
 *  rather than throwing, so a probe failure reads as "not found" and fails
 *  the gate it was for, rather than aborting the whole boot. */

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

/** `#library-timing`'s text is `library.timing.overview`/`.words`
 *  concatenated with the catalog's own separator -- restated here as a
 *  pattern, `export-cli.ts`'s `NAME_PATTERN` precedent for a rig reading a
 *  catalog-composed sentence back out of the accessibility tree. A figure
 *  this cannot find reads as `UNMEASURED_MS`, which fails its gate rather
 *  than passing on a coincidence. */
function parseTiming(text: string): { overviewMs: number; wordsMs: number } {
  const overview = /Overview (\d+) ms/.exec(text);
  const words = /Words (\d+) ms/.exec(text);
  return {
    overviewMs: overview !== null ? Number(overview[1]) : UNMEASURED_MS,
    wordsMs: words !== null ? Number(words[1]) : UNMEASURED_MS,
  };
}

/** Whether `#library`'s own marker -- the "New pen name…" pill, present
 *  whatever the vault or the filter holds -- was found in the AT-SPI tree.
 *  ONE WALK, `nodes.ts`'s own rule, and never a click by itself: this asks
 *  whether the screen is up, not whether its buttons work. */
function libraryPresent(rootPid: number): boolean {
  try {
    return locateNodes(rootPid).some((n) => n.id === "library-new-pen-name");
  } catch {
    return false;
  }
}

/** Which seeded path `name` (a `#library-desk-title` reading) names, through
 *  `nameBook`'s own naming -- `<name>.db` inside the seeded library. `null`
 *  when the name matches none of them, which happens if the probe answered
 *  something this rig never wrote. */
function pathForName(name: string): string | null {
  return seededPaths.find((p) => p.endsWith(`/${name}.db`)) ?? null;
}

/** Press the desk's "Continue writing" through AT-SPI and xdotool, then read
 *  back TWO observables: the tree with no `#library` marker and the
 *  header naming the SAME book `deskTitleBefore` named, and
 *  `settings.recent[0]` naming that book's path. Both must hold for this to
 *  report success -- a page-side mount failure after a real host-side open
 *  would still write `settings.recent[0]` and must not read as a pass on
 *  that alone. */
function pressContinueWriting(
  display: string,
  rootPid: number,
  deskTitleBefore: string | undefined,
): { ok: boolean; diagnostic: string } {
  if (deskTitleBefore === undefined) {
    return { ok: false, diagnostic: "could not read #library-desk-title before pressing" };
  }
  const wantedPath = pathForName(deskTitleBefore);
  try {
    const wid = findWindowId(display);
    const geometry = parseGeometry(
      new TextDecoder().decode(
        Bun.spawnSync(["xdotool", "getwindowgeometry", "--shell", wid], {
          env: { ...process.env, DISPLAY: display },
          stdout: "pipe",
        }).stdout,
      ),
    );
    const node = nodeToPress(locateNodes(rootPid), parsePressSelector("id:library-continue"), "home-cli");
    const at = pressPoint(node, geometry);
    Bun.spawnSync(["xdotool", "mousemove", "--window", wid, String(at.x), String(at.y)], {
      env: { ...process.env, DISPLAY: display },
    });
    Bun.spawnSync(["xdotool", "click", "1"], { env: { ...process.env, DISPLAY: display } });
    // The debounced settings write plus the mirror scan and the switch's own
    // mount: not measured, only waited past.
    Bun.sleepSync(1500);
    const after = readNodeTexts(rootPid, ["library-new-pen-name", "project-name-label"]);
    const stillShowsLibrary = after["library-new-pen-name"] !== undefined;
    const headerName = after["project-name-label"];
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { recent?: { path: string }[] };
    // The host writes this path `~/`-relative when the data home sits under
    // HOME; under /tmp it is absolute. Expand before comparing so the
    // gate does not depend on where TMPDIR points.
    const recentRaw = settings.recent?.[0]?.path;
    const recentPath = recentRaw?.startsWith("~/") ? join(homedir(), recentRaw.slice(2)) : recentRaw;
    const nameMatches = !stillShowsLibrary && headerName === deskTitleBefore;
    const pathMatches = wantedPath !== null && recentPath === wantedPath;
    if (nameMatches && pathMatches) return { ok: true, diagnostic: "" };
    return {
      ok: false,
      diagnostic:
        `the desk showed "${deskTitleBefore}" (mapped to ${wantedPath ?? "NO SEEDED PATH MATCHES IT"}); ` +
        `after the press: #library present=${stillShowsLibrary}, header="${headerName ?? "(not found)"}", ` +
        `settings.recent[0]=${recentPath ?? "(none)"}`,
    };
  } catch (err) {
    return { ok: false, diagnostic: `Continue writing press failed: ${String(err)}` };
  }
}

/** One boot of the shared data home under `start`, with no `APP_PROJECT` --
 *  `project-cli`'s own reason: the startup order is part of what is under
 *  test, and handing the host a path would skip it entirely, `start`
 *  included (`APP_PROJECT` ignores `start` exactly as it ignores
 *  `last_project`). `press` is only meaningful under `start="home"`. */
async function boot(
  start: Start,
  press: boolean,
): Promise<{
  outcome: RunOutcome<InteractiveSinkPayload>;
  libraryPresent: boolean;
  overviewMs: number;
  wordsMs: number;
  opensTheBook: boolean;
  diagnostic: string;
}> {
  plantSettings(start);
  let present = false;
  let overviewMs = UNMEASURED_MS;
  let wordsMs = UNMEASURED_MS;
  let opensTheBook = false;
  let diagnostic = "";
  const outcome = await runShell<InteractiveSinkPayload>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: { APP_RUN: "interactive", APP_LIBRARY_DIAGNOSTICS: "1", XDG_DATA_HOME: dataHome, GDK_BACKEND: "x11" },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      const before = readNodeTexts(rootPid, ["library-new-pen-name", "library-desk-title"]);
      present = before["library-new-pen-name"] !== undefined;
      if (!press) return;
      if (!present || displayNum === null) {
        diagnostic = `#library was not present at boot (found: ${Object.keys(before).join(", ") || "nothing"})`;
        return;
      }
      // Time for the shelf's sequential word-count fetch to answer at least
      // the freshest (and, under STRESS, the `stress`-sized) book before
      // this reads the timing line.
      Bun.sleepSync(STRESS ? 4000 : 1500);
      const timing = readNodeTexts(rootPid, ["library-timing"])["library-timing"] ?? "";
      ({ overviewMs, wordsMs } = parseTiming(timing));
      const result = pressContinueWriting(`:${displayNum}`, rootPid, before["library-desk-title"]);
      opensTheBook = result.ok;
      diagnostic = result.diagnostic;
    },
  });
  return { outcome, libraryPresent: present, overviewMs, wordsMs, opensTheBook, diagnostic };
}

let home: Awaited<ReturnType<typeof boot>>;
let last: Awaited<ReturnType<typeof boot>>;
let blank: Awaited<ReturnType<typeof boot>>;
try {
  console.log('[2/4] booting with start="home"');
  home = await boot("home", true);
  console.log('[3/4] booting with start="last"');
  last = await boot("last", false);
  console.log('[4/4] booting with start="blank"');
  blank = await boot("blank", false);
} catch (err: unknown) {
  cleanup();
  throw err;
}

for (const [phase, r] of [
  ["home", home],
  ["last", last],
  ["blank", blank],
] as const) {
  if (!r.outcome.payload.ready) {
    console.error(
      `\nSTRUCTURAL CHECK FAILED\n  start="${phase}" never sank a ready payload: ${r.outcome.payload.error ?? "no reason given"}.\n` +
        "Nothing was written.",
    );
    cleanup();
    process.exit(2);
  }
}

if (home.diagnostic !== "") {
  console.log(`  [diagnostic] home_opens_the_book: ${home.diagnostic}`);
}

const metrics: HomeMetrics = {
  home_project_path: home.outcome.payload.project_path,
  home_rows: home.outcome.payload.rows,
  home_library_present: home.libraryPresent,
  last_project_path: last.outcome.payload.project_path,
  last_library_present: last.libraryPresent,
  blank_project_path: blank.outcome.payload.project_path,
  blank_rows: blank.outcome.payload.rows,
  blank_library_present: blank.libraryPresent,
  library_overview_ms: home.overviewMs,
  library_words_ms: home.wordsMs,
  home_opens_the_book: home.opensTheBook,
};

const verdicts = evaluateHomeGates(metrics);
const written = writeResult(
  buildResult({
    workload: "app-home",
    runId: STRESS ? "app-home-stress" : "app-home-tiny",
    candidate: "tauri",
    fixture: STRESS ? "stress" : "tiny",
    verdicts,
    metrics: {
      ...metrics,
      home_startup_ms: home.outcome.payload.startup_ms,
      last_startup_ms: last.outcome.payload.startup_ms,
      blank_startup_ms: blank.outcome.payload.startup_ms,
      last_project_name: last.outcome.payload.project_name,
      last_generation: last.outcome.payload.generation,
      library_mix: STRESS ? "9 tiny + 3 stress" : "3 tiny",
      home_diagnostic: home.diagnostic,
      // No latency, stall or a11y_exposure gate: three short boots have
      // nothing true to say about any of them, and the AT-SPI walk here is a
      // presence check, not an exposure measurement.
      omitted_gates: "latency, stall, cliff, a11y_exposure",
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

cleanup();
console.log(`\nrecorded: ${written}`);
for (const v of verdicts) console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
if (verdicts.some((v) => v.verdict === "FAIL")) process.exit(1);
