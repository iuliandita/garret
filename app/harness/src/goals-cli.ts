// app/harness/src/goals-cli.ts
// Graded writing-goals run. FIVE boots, one or two AT-SPI walks each.
//
// The claim under test is a dated typing contribution that spans a process
// death: today's figure comes from the project's source_words ledger, and
// neither number is worth anything if the reopened application forgets it.
//
// THE ORACLE IS THE STORE, READ DIRECTLY. Every word figure this rig grades
// against is computed here, from `bun:sqlite`: the manuscript delta uses the
// PAGE's word rule over stored bodies, and the source oracle reads source_words
// directly. Neither asks the host for its own answer.
//
// WHAT IT CANNOT SEE: whether a goal helps anybody write. It is a number beside
// two other numbers, and the claim is only that it is the true number.
//
// Usage: APP_GUI=1 bun app/harness/src/goals-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countWordsIn, schema } from "../../ui/src/editor";
import { localDate } from "../../ui/src/goals";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { evaluateGoalsGates, type GoalsMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { buildResult, writeResult } from "./results";
import { BIN, SHELL_PROC_NAME, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** The DOM id the readout carries into the accessibility tree. How this rig
 *  finds it; its ROLE and its BOX are then read off the node. */
const COUNT_ID = "word-count";

/** What the panel is clicked to. Not `off`, which is the default -- a target
 *  equal to the default cannot tell a click that landed from one that did not. */
const CHOSEN_TARGET = "500";

/** xdotool returns when X has the events, not when WebKitGTK has turned them
 *  into document state. 500 ms was found silently truncating typed text. */
const SETTLE_MS = 2500;

/** The flush debounce is 1000 ms and the host then writes; the day's figure is
 *  re-asked from the flush closure. Long enough for all of that to land. */
const FLUSH_SETTLE_MS = 4000;

/** Replaces the open scene's prose, so what the store holds afterwards is the
 *  rig's and only the rig's. The word DELTA is what the gate grades, and it is
 *  computed from the store rather than from this string's length -- a passage
 *  counted by eye is a fourth implementation of the word rule. */
const PASSAGE =
  "The harbour kept its own accounts and settled them nightly with the tide. ".repeat(12);

/** A date no writer has ever had this application open on, written into the
 *  project by hand. The only way to turn a day inside a run that lasts a
 *  minute; waiting for midnight is not a test. */
const YESTERDAY = "2000-01-01";

/** store/mod.rs MAX_DEPTH. Without it the CTE recurses forever on a parent_id
 *  cycle where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;
const WALK_SQL = `WITH RECURSIVE walk(id, parent_id, position, depth, path) AS (
     SELECT id, parent_id, position, 0, position FROM item WHERE parent_id IS NULL
     UNION ALL
     SELECT i.id, i.parent_id, i.position, w.depth + 1, w.path || '/' || i.position
       FROM item i JOIN walk w ON i.parent_id = w.id
      WHERE w.depth + 1 < ${MAX_DEPTH}
   )
   SELECT id FROM walk ORDER BY path`;

/** The count node as the accessibility tree holds it, WITH ITS BOX. words-cli's
 *  probe reads the same node without extents, because that rig has no geometry
 *  claim and this one does. A separate script rather than a shared one, for the
 *  reason every rig here owns its probe: the walk is the dangerous part of a
 *  run, and a shared probe grows every caller's walk.
 *
 *  `combo box` IS IN `GEOM` DELIBERATELY, and it is the only role here that is
 *  not obviously a widget. A menu TITLE maps to ATK `combo box` on WebKitGTK
 *  2.52.4, decided by `aria-haspopup` alone — measured by single-variable
 *  runs, not assumed. The geometry anchor below WAS a menu title until an
 *  earlier redesign, and without this entry it was invisible: the failure
 *  read as "the menu bar is not there" rather than "the probe cannot see
 *  that role". The anchor is the
 *  footer's status dot now (a `push button`, already here); the entry stays so
 *  the walk records the same nodes it did, and dropping it is its own decision.
 *
 *  Added HERE rather than to `nodes.ts`'s shared `WANTED` set: this rig owns its
 *  own probe already, and widening the shared filter would grow the walk of
 *  every rig that uses it — and the walk is what kills the application. The
 *  alternative considered was carrying a second, unfiltered walk the way
 *  `menu-cli` does; that costs a whole extra walk per window for one box, which
 *  is the more dangerous half of the trade. */
export const PY_PROBE = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
count_id = sys.argv[2]
GEOM = ("push button", "button", "toggle button", "combo box", "entry", "text")

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

nodes = []
found = {"count": None}

def walk(node):
    try:
        role = node.getRoleName()
        i = ident(node)
        if role in GEOM:
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            nodes.append({"role": role, "id": i, "name": node.name or "",
                          "x": e.x, "y": e.y, "w": e.width, "h": e.height})
        if i == count_id and found["count"] is None:
            text = ""
            try:
                t = node.queryText()
                text = t.getText(0, t.characterCount)
            except Exception:
                text = ""
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            found["count"] = {"role": role, "id": i, "name": node.name or "", "text": text,
                              "x": e.x, "y": e.y, "w": e.width, "h": e.height}
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps({"nodes": nodes, "count": found["count"]}))
`;

interface ProbeNode {
  role: string;
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CountNode extends ProbeNode {
  text: string;
}

interface Probe {
  nodes: ProbeNode[];
  count: CountNode | null;
}

/** One AT-SPI walk. Throws when the probe fails, because then nothing was
 *  measured and a written result would describe a tree that was never read.
 *
 *  A failure here reads as "the bridge wedged" and is just as often "the
 *  application is gone" -- several walks in one window kill it outright, and one
 *  line distinguishes the two. */
function probeTree(rootPid: number): Probe {
  const proc = Bun.spawnSync(["python3", "-c", PY_PROBE, pidListArg(rootPid), COUNT_ID], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const alive = survivingShellPids();
    throw new Error(
      `could not read the accessibility tree (exit ${proc.exitCode}); ` +
        `${alive.length === 0 ? "THE SHELL IS GONE" : `shell alive at ${alive.join(", ")}`}: ` +
        proc.stderr.toString().trim(),
    );
  }
  return JSON.parse(proc.stdout.toString()) as Probe;
}

function xdo(display: string, args: string[]): string {
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

function clickNode(display: string, wid: string, node: ProbeNode): void {
  xdo(display, [
    "mousemove",
    "--window",
    wid,
    String(Math.round(node.x + node.w / 2)),
    String(Math.round(node.y + node.h / 2)),
  ]);
  xdo(display, ["click", "1"]);
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function nodeById(nodes: ProbeNode[], id: string): ProbeNode {
  const found = nodes.find((n) => n.id === id);
  if (found === undefined) {
    const seen = nodes.map((n) => n.id || n.role).join(", ");
    throw new Error(`#${id} is absent from the accessibility tree. Nodes seen: ${seen || "none"}`);
  }
  return found;
}

// ---- the rig's own reading of the store -------------------------------------

function openRead(projectPath: string): Database {
  return new Database(projectPath, { readonly: true });
}

/** The manuscript's word count over the WALKED items only -- the same scope the
 *  host counts, so a `doc` row whose item is not in the tree contributes to
 *  neither figure.
 *
 *  `countWordsIn` is IMPORTED from the page rather than restated, deliberately
 *  and against this harness's usual rule: the claim is that the HOST's figure
 *  moves by what the PAGE would count, and those two are the pair under
 *  comparison. A third implementation here could disagree with either and hide
 *  which two were being checked. */
function storeWords(projectPath: string): number {
  const db = openRead(projectPath);
  try {
    const walk = new Set((db.query(WALK_SQL).all() as { id: string }[]).map((r) => r.id));
    const rows = db.query("SELECT item_id, body FROM doc").all() as {
      item_id: string;
      body: string;
    }[];
    let total = 0;
    for (const row of rows) {
      if (!walk.has(row.item_id)) continue;
      total += countWordsIn(schema.nodeFromJSON(JSON.parse(row.body) as Record<string, unknown>));
    }
    return total;
  } finally {
    db.close();
  }
}

function meta(projectPath: string, key: string): string | null {
  const db = openRead(projectPath);
  try {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

interface SourceWordsLedger {
  version: 1;
  started_at: number;
  totals: Record<
    "typing" | "pasted" | "imported" | "restored" | "unattributed",
    { added: number; deleted: number }
  >;
  typing_days: { day: string; net: number }[];
}

function sourceLedger(projectPath: string): SourceWordsLedger | null {
  const held = meta(projectPath, "source_words");
  if (held === null) return null;
  const decoded: unknown = JSON.parse(held);
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("source_words is not an object");
  }
  const parsed = decoded as Partial<SourceWordsLedger>;
  if (parsed.version !== 1 || !Array.isArray(parsed.typing_days)) {
    throw new Error("source_words has an unreadable version or typing_days list");
  }
  const seen = new Set<string>();
  for (const row of parsed.typing_days) {
    if (
      typeof row?.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(row.day) ||
      !Number.isSafeInteger(row.net) ||
      seen.has(row.day)
    ) {
      throw new Error("source_words has an invalid or repeated typing day");
    }
    seen.add(row.day);
  }
  if (parsed.typing_days.length > 32) throw new Error("source_words exceeds its 32-day bound");
  return parsed as SourceWordsLedger;
}

/** Missing is zero: reading a fresh day must not write a bucket merely to
 * answer the goal. */
function sourceTyping(projectPath: string, day: string): number {
  return sourceLedger(projectPath)?.typing_days.find((row) => row.day === day)?.net ?? 0;
}

/** The one write this rig makes into a project. Moves the contribution rather
 * than deleting it, so rollover cannot pass by losing the ledger. */
function moveTypingDay(projectPath: string, from: string, to: string): number {
  const ledger = sourceLedger(projectPath);
  if (ledger === null) throw new Error("source_words is absent after typing");
  const row = ledger.typing_days.find((entry) => entry.day === from);
  if (row === undefined) throw new Error(`source_words has no ${from} typing bucket`);
  if (ledger.typing_days.some((entry) => entry.day === to)) {
    throw new Error(`source_words already has the rollover target ${to}`);
  }
  const preserved = ledger.typing_days.reduce((sum, entry) => sum + entry.net, 0);
  row.day = to;
  ledger.typing_days.sort((a, b) => b.day.localeCompare(a.day));
  if (ledger.typing_days.reduce((sum, entry) => sum + entry.net, 0) !== preserved) {
    throw new Error("moving the typing day changed its net contribution");
  }

  const db = new Database(projectPath);
  try {
    const result = db.run("UPDATE meta SET value = ? WHERE key = 'source_words'", [
      JSON.stringify(ledger),
    ]);
    if (result.changes !== 1) throw new Error("source_words rollover updated no ledger");
  } finally {
    db.close();
  }
  return row.net;
}

// ---- what the bar says ------------------------------------------------------

/** The day's clause of the VISIBLE readout: "47 words · 2,000 in the book 320 of 500
 *  typed today" (239: the day's figure follows a plain space, drawn as a gap,
 *  not a second middle dot). Absent until the first answer lands, which is a
 *  state and not a zero. */
const TEXT_PATTERN = /^[\d,]+ words? · (?:[\d,]+|…|—) in the book (.+)$/u;

/** The day's clause of the ACCESSIBLE NAME, which is a DIFFERENT SENTENCE from
 *  the visible one and needs a different pattern. Sharing one would make the
 *  agreement gate compare a string with itself. */
const NAME_PATTERN =
  /^Word count: [\d,]+ words? in this scene, (?:[\d,]+|…|—) saved in the project, (.+)$/u;

const clauseOf = (pattern: RegExp, text: string): string | null => text.match(pattern)?.[1] ?? null;

/** The signed figure out of the visible clause. U+2212 for a negative day, which
 *  `Number` does not parse, so the sign is handled rather than assumed away. */
function todayFrom(clause: string | null): number | null {
  if (clause === null) return null;
  const m = clause.match(/^(−?)([\d,]+)(?: of [\d,]+)? typed today$/u);
  if (m === null) return null;
  return (m[1] === "−" ? -1 : 1) * Number(m[2]!.replaceAll(",", ""));
}

/** The target the bar counts against, or "off" when it names none. Read back out
 *  of the READOUT rather than out of the file -- the file is the other half of
 *  that gate, and a rig that read one thing twice would grade nothing. */
function targetFrom(clause: string | null): string {
  if (clause === null) return "ABSENT";
  const m = clause.match(/of ([\d,]+) typed today$/u);
  return m === null ? "off" : m[1]!.replaceAll(",", "");
}

/** The two figures out of the VISIBLE clause, AS WRITTEN: "108 of 500 typed
 *  today" becomes "108/500", "−900 typed today" becomes "-900/off". Not
 *  parsed to numbers, because "1,400" against "1400" is a real disagreement --
 *  one channel is being formatted differently from the other -- and normalizing
 *  it away would hide exactly that. The U+2212 the bar draws is written as an
 *  ASCII "-" here so the two channels can be compared at all; what the gate then
 *  sees is that one of them lost the sign, not which glyph it used.
 *
 *  null when the clause does not match, which is a FAIL and never an abort:
 *  a readout that says something this rig cannot read is the defect. */
function figuresOfText(clause: string | null): string | null {
  const m = clause?.match(/^(−?)([\d,]+)(?: of ([\d,]+))? typed today$/u);
  if (m === undefined || m === null) return null;
  return `${m[1] === "−" ? "-" : ""}${m[2]}/${m[3] ?? "off"}`;
}

/** The same two figures out of the ACCESSIBLE NAME, which is a DIFFERENT
 *  SENTENCE and carries the sign as a WORD rather than as a glyph: "900 words
 *  cut today" is the negative day. Two patterns rather than one is the whole
 *  point -- a rig that read both channels with one regex could only ever compare
 *  a string with itself. */
function figuresOfName(clause: string | null): string | null {
  const m = clause?.match(
    /^([\d,]+) words? (typed|cut) today(?: of a ([\d,]+) word target)?$/u,
  );
  if (m === undefined || m === null) return null;
  return `${m[2] === "cut" ? "-" : ""}${m[1]}/${m[3] ?? "off"}`;
}

interface Reading {
  count: CountNode;
  nodes: ProbeNode[];
  textClause: string | null;
  nameClause: string | null;
  today: number | null;
}

function readingFrom(probe: Probe, where: string): Reading {
  if (probe.count === null) {
    throw new Error(`#${COUNT_ID} is absent from the accessibility tree in ${where}`);
  }
  const textClause = clauseOf(TEXT_PATTERN, probe.count.text);
  return {
    count: probe.count,
    nodes: probe.nodes,
    textClause,
    nameClause: clauseOf(NAME_PATTERN, probe.count.name),
    today: todayFrom(textClause),
  };
}

function fail(why: string): never {
  console.error(`${why}; nothing was written.`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

// ---- preamble ---------------------------------------------------------------

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; goals run skipped (needs a display and a built shell).");
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

const root = mkdtempSync(join(tmpdir(), "app-goals-"));
const homeFor = (label: string): string => {
  const dir = join(root, `home-${label}`);
  mkdirSync(join(dir, "cc.local.app"), { recursive: true });
  return dir;
};
const settingsPath = (dataHome: string): string => join(dataHome, "cc.local.app", "settings.json");

function seed(label: string): string {
  const path = join(root, `${label}.db`);
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, path], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) fail(`seeding ${label} failed (exit ${seeded.exitCode})`);
  return path;
}

interface BootOptions {
  label: string;
  projectPath: string;
  dataHome: string;
  /** Replace the open scene's prose with PASSAGE, wait for the flush, and take a
   *  SECOND reading. Two walks, which is what hier-cli and prefs-cli take; the
   *  boundary that kills the application has been seen at the third. */
  type?: boolean;
  /** Open the preferences panel and click through to CHOSEN_TARGET. Also two
   *  walks: the panel's buttons do not exist until it opens. */
  chooseTarget?: boolean;
}

interface BootResult {
  first: Reading;
  afterTyping: Reading | null;
  peakRssMb: number;
}

async function boot(options: BootOptions): Promise<BootResult> {
  // A rig local assigned only inside a closure narrows to `null` for the rest of
  // the file, so a later `=== null` guard type-checks while asserting nothing.
  // A mutable record resets the narrowing.
  const captured: { first: Reading | null; after: Reading | null } = { first: null, after: null };
  const outcome = await runShell({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    env: {
      APP_RUN: "interactive",
      APP_PROJECT: options.projectPath,
      // Explicit, so it survives shell.ts's own per-run isolation: the settings
      // file is half of this rig's subject.
      XDG_DATA_HOME: options.dataHome,
      // This machine's ambient session sets WAYLAND_DISPLAY and GTK prefers
      // Wayland, so the webview would open on the real desktop rather than on
      // the Xvfb display xdotool targets.
      GDK_BACKEND: "x11",
    },
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("goals rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      await Bun.sleep(SETTLE_MS);
      xdo(display, ["windowfocus", wid]);

      const first = readingFrom(probeTree(rootPid), options.label);
      captured.first = first;

      if (options.type === true) {
        // A point inside the page, computed from the window rather than from the
        // editable's extents: reading those would spend this window's second
        // walk before the reading that matters.
        xdo(display, ["mousemove", "--window", wid, "500", "300"]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(500);
        // Replaced, not appended: what the store holds afterwards has to be the
        // rig's prose and only the rig's.
        xdo(display, ["key", "ctrl+a"]);
        xdo(display, ["type", "--delay", "1", PASSAGE]);
        await Bun.sleep(FLUSH_SETTLE_MS);
        captured.after = readingFrom(probeTree(rootPid), `${options.label} after typing`);
      }

      if (options.chooseTarget === true) {
        // File > Preferences…, by keystroke. #prefs-toggle was deleted by the
        // retirement slice and the menu is the only route in; the item's index
        // is parsed out of `menu-bar.ts` by `menu-drive`, never restated, so an
        // item inserted above Preferences moves this with it rather than leaving
        // the rig pressing Return on its neighbour and reporting what THAT did.
        //
        // Costs no walk. The panel's own buttons do not exist until it opens, so
        // opening still costs the second walk.
        await menuDriver(display, wid, xdo).activate("menu-preferences");
        await Bun.sleep(SETTLE_MS);
        const open = probeTree(rootPid);
        clickNode(display, wid, nodeById(open.nodes, `prefs-goal-${CHOSEN_TARGET}`));
        await Bun.sleep(SETTLE_MS);
      }

      xdo(display, ["windowclose", wid]);
      await Bun.sleep(1500);
    },
  });

  if (captured.first === null) fail(`${options.label} produced no reading`);
  return { first: captured.first, afterTyping: captured.after, peakRssMb: outcome.peakRssMb };
}

console.log("[1/5] a first launch: today's source bucket is empty, then a known passage is typed");
const dayHome = homeFor("day");
const dayProject = seed("day");
const today = localDate(new Date());
const totalBefore = storeWords(dayProject);
const ledgerBefore = sourceTyping(dayProject, today);
const typed = await boot({
  label: "anchor-and-type",
  projectPath: dayProject,
  dataHome: dayHome,
  type: true,
});
const totalAfter = storeWords(dayProject);
const typedWords = totalAfter - totalBefore;
const ledgerAfter = sourceTyping(dayProject, today);
const afterTyping = typed.afterTyping;

if (typed.first.today === null) {
  fail("the bar never reported a day's figure at all, so there is nothing here to grade");
}
if (typed.first.today !== 0) {
  fail(
    `a fresh project on a fresh day reported ${typed.first.today} today rather than 0, so every ` +
      `figure below is about something else`,
  );
}
if (typedWords === 0) {
  fail("the typed passage did not move the store's word total, so nothing was written to count");
}
if (afterTyping === null || afterTyping.today === null) {
  fail("the bar reported no day's figure after typing");
}
console.log(
  `  store ${totalBefore} -> ${totalAfter} words (${typedWords} typed), ` +
    `ledger ${ledgerBefore} -> ${ledgerAfter}, bar says ${afterTyping.today} today`,
);

console.log("[2/5] reopened against the same file, the same day");
const reopened = await boot({ label: "reopen", projectPath: dayProject, dataHome: dayHome });
const ledgerAfterRestart = sourceTyping(dayProject, today);
console.log(`  ledger says ${ledgerAfterRestart}, bar says ${reopened.first.today} today`);

console.log(`[3/5] today's ledger bucket moved to ${YESTERDAY}, then reopened`);
const movedTyping = moveTypingDay(dayProject, today, YESTERDAY);
const rolled = await boot({ label: "rollover", projectPath: dayProject, dataHome: dayHome });
const ledgerTodayAfterRollover = sourceTyping(dayProject, today);
const ledgerYesterdayAfterRollover = sourceTyping(dayProject, YESTERDAY);
console.log(
  `  ledger preserved ${ledgerYesterdayAfterRollover} on ${YESTERDAY} and says ` +
    `${ledgerTodayAfterRollover} today; bar says ${rolled.first.today} today`,
);

console.log(`[4/5] clicking the SHIPPED panel through to a ${CHOSEN_TARGET} word goal`);
const targetHome = homeFor("target");
const targetProject = seed("target");
await boot({
  label: "choose-target",
  projectPath: targetProject,
  dataHome: targetHome,
  chooseTarget: true,
});

const recordedTarget = ((): string => {
  const path = settingsPath(targetHome);
  if (!existsSync(path)) return "ABSENT";
  const held = (JSON.parse(readFileSync(path, "utf8")) as { daily_target?: unknown }).daily_target;
  return typeof held === "string" ? held : "ABSENT";
})();
if (recordedTarget === "off" || recordedTarget === "ABSENT") {
  // `off` is the default, so an unchanged file cannot be told apart from a click
  // that never landed.
  fail(`settings.json holds ${recordedTarget} after the click, so nothing was actually clicked`);
}
console.log(`  settings.json holds ${recordedTarget}`);

console.log("[5/5] relaunched on the recorded goal, and written into");
// TYPED INTO, deliberately. Without it this boot reads 0 today -- the project
// was seeded in phase 4 and nothing has been written to it since -- and the
// agreement gate below would be comparing "0/500" with "0/500". A zero exercises
// the target and the formatting and nothing else: no thousands separator, no
// sign, no figure that could have come from the wrong place.
const relaunched = await boot({
  label: "relaunch-on-target",
  projectPath: targetProject,
  dataHome: targetHome,
  type: true,
});
const shown = relaunched.afterTyping;
if (shown === null) fail("the relaunched boot produced no reading after typing");
const targetInBar = targetFrom(shown.textClause);
console.log(`  the bar counts against ${targetInBar}`);

// The readout against a control in the same strip. Both boxes come from the same
// walk of the same window, so neither is a restated constant: if the three
// figures wrapped onto a second line the readout is about twice this tall and
// the control beside it is not.
//
// THE ANCHOR IS THE FOOTER'S STATUS DOT, since the readout moved off
// #project-bar and into #footer. `status-dot` rather than a menu title because
// the titles stayed in the header, and a control in another strip says nothing
// about whether THIS one wrapped. The dot is the one control unconditionally
// painted in the same strip as the readout, and it is built to the 24px
// control box every control in the chrome shares — the equality `style.css`
// states as a rule ("do not simplify this by deleting the border and padding:
// it looks identical at rest and silently shortens the tallest control in the
// bar"). Before 067 the anchor was `menu-file`, and before that #prefs-toggle.
//
// It is a `push button`, which is in the probe's GEOM set above.
const readout = shown.count;
const control = nodeById(shown.nodes, "status-dot");

if (shown.today === null || shown.today === 0) {
  // A zero would make the agreement gate compare two renderings of nothing:
  // no separator, no sign, and a figure that could equally have come from a
  // page that never counted anything.
  fail(`the relaunched boot reported ${shown.today} today, so the agreement gate would be vacuous`);
}

const metrics: GoalsMetrics = {
  typed_words: typedWords,
  today_before: typed.first.today,
  today_after: afterTyping.today,
  today_after_restart: reopened.first.today ?? -1,
  ledger_today_before: ledgerBefore,
  ledger_today_after: ledgerAfter,
  ledger_today_after_restart: ledgerAfterRestart,
  today_after_rollover: rolled.first.today ?? -1,
  ledger_today_after_rollover: ledgerTodayAfterRollover,
  ledger_yesterday_after_rollover: ledgerYesterdayAfterRollover,
  typing_before_rollover: movedTyping,
  chosen_target: CHOSEN_TARGET,
  recorded_target: recordedTarget,
  target_in_bar: targetInBar,
  readout_h: readout.h,
  control_h: control.h,
  today_in_text: figuresOfText(shown.textClause),
  today_in_name: figuresOfName(shown.nameClause),
  peak_rss_mb: Math.max(typed.peakRssMb, reopened.peakRssMb, rolled.peakRssMb, relaunched.peakRssMb),
};

const verdicts = evaluateGoalsGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

writeResult(
  buildResult({
    runId: "app-goals-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-goals",
    verdicts,
    metrics: {
      ...metrics,
      scope:
        "the day is turned by moving today's source_words typing bucket to a past date, not by " +
        "waiting for midnight. The contribution is preserved under that date and the absent " +
        "current-day bucket reads as zero without a write. This says nothing about a system " +
        "clock changing under a running process.",
      omitted_gates:
        "no latency, stall, cliff or a11y_exposure figures: a run that types one passage and " +
        "never clicks a navigator row has nothing true to say about frame cadence, and the " +
        "exposure claim for this readout is words-cli's.",
    },
    seed: "n/a",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

rmSync(root, { recursive: true, force: true });
process.exit(verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0);
