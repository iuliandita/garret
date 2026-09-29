// app/harness/src/import-cli.ts
// Graded import run. Writes a Markdown manuscript into the drop directory,
// opens the SHIPPED project panel from the application menu and clicks the file
// with a real pointer event to import it, then reads
// the created project out of SQLite and grades it against an oracle the rig
// computes ITSELF.
//
// The oracle is `markdown-read.ts`, the harness's own restatement of the
// format, written from the spec and deliberately NOT imported from `export.rs`
// or `import.rs`. Checking the importer against the exporter would be checking
// two modules of one Rust crate against each other, and this repo has already
// recorded once what a pair of matching blind spots costs: two figures scanning
// the same rows agreed while prose was missing from the file.
//
// The panel's rows are located through AT-SPI COMPONENT EXTENTS, not computed
// from the stylesheet. The panel is absolutely positioned and its contents are
// a list of variable length, an input, a button, a heading and a second list;
// arithmetic over that would be five restated constants, each free to drift,
// and a wrong one lands the click on the Create button instead — which creates
// a project named after whatever is in the input and looks, from the store,
// almost like a successful import.
//
// ONE AT-SPI walk, after the panel opens. Several walks in one window kill the
// application outright (recorded in the gotchas), so this rig takes its
// geometry once and clicks from the numbers. The retirement slice made that
// literally true rather than nearly: the panel used to be opened by clicking
// #project-toggle, which had to be LOCATED first, so a second walk ran before
// the one this header describes. The bar button is gone and the panel is
// reached from File > Open project…, which is keystrokes — and a keystroke
// needs no geometry.
//
// Usage: APP_GUI=1 bun app/harness/src/import-cli.ts
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./env";
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import {
  evaluateDocxImportGates,
  evaluateImportGates,
  type DocxImportMetrics,
  type GateResult,
  type ImportMetrics,
} from "./gates";
import { expectedHeadingLevel, normalizeText, readManuscript } from "./markdown-read";
import { buildResult, writeResult } from "./results";
import { menuDriver } from "./menu-drive";
import { centreOf, locateNodes } from "./nodes";
import { BIN, SHELL_PROC_NAME, findWindowId, runShell, survivingShellPids } from "./shell";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";

/** The name the rig drops in. Must end `.md`, or `project_import_list` will not
 *  offer it and the run would abort on a missing row — correctly, but for the
 *  rig's reason rather than the application's. */
const SOURCE_NAME = "harbour-lights.md";

/** The manuscript the rig imports.
 *
 * Written to exercise the things a novelist's file actually contains and the
 * parser's stated subset at once:
 *   - a lone H1, so the file names itself and does not gain a level
 *   - a part containing chapters, so nesting is more than one deep
 *   - a section with prose AND children, which must come back a scene
 *   - a paragraph split across source lines, which must join with one space
 *   - emphasis, both kinds
 *   - an escaped metacharacter, which must come back as the character
 *   - non-Latin prose, because the fixtures' own prose is Hebrew and Arabic and
 *     a Latin-only rig would not notice a byte-level defect in either
 *   - a blank-line paragraph break inside one section
 *
 * NOT generated from the app's own export: a source the exporter wrote would
 * make this a round trip against the emitter rather than against the format. */
const SOURCE = [
  "# Harbour Lights",
  "",
  "## Part One",
  "",
  "### The Keeper",
  "",
  "She counted seven ships before dawn and did not",
  "write any of them down.",
  "",
  "The lamp was *quite* cold by then, and the glass **entirely** salted over.",
  "",
  "### The Cartographer",
  "",
  "He refused to name the island. A star \\* is not a footnote, he said.",
  "",
  "## Part Two",
  "",
  "Prose directly under a part, which has children as well.",
  "",
  "### הנמל",
  "",
  "הספינה עגנה בשקט לפני עלות השחר.",
  "",
  "### الفنار",
  "",
  "لم يكن الضوء كافيا لرؤية الشاطئ.",
  "",
].join("\n");

/** xdotool type/click returns when X has the events, not when WebKitGTK has
 *  acted on them. hand-cli.ts found 500 ms silently truncating; 2500 ms held. */
const SETTLE_MS = 2500;
/** The import parses a file, creates a database and writes a tree. Longer than
 *  SETTLE_MS because none of that is on the frame clock. */
const IMPORT_MS = 4000;

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

function gitShortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

/** A minimal restatement of `export-cli.ts`'s own notice-reading probe,
 *  narrowed to the one thing this rig's second walk needs: the WHOLE
 *  subtree text under the node carrying `id` -- the same banner
 *  `project.ts`'s `announce`/`raiseNotice` share ("open-error"), which is
 *  the channel 093's decision 7 reuses for the import loss notice. A
 *  sentinel NUL byte distinguishes "no node carried that id" (an info
 *  banner removes itself after six seconds, which is a real state) from a
 *  banner that carries the empty string, which would otherwise read as the
 *  same bytes on the wire. */
const PY_NOTICE = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
notice_id = sys.argv[2]

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

def subtree_text(node):
    out = own_text(node) or (node.name or "")
    try:
        for k in range(node.childCount):
            out += subtree_text(node.getChildAtIndex(k))
    except Exception:
        pass
    return out

found = {"text": None}

def walk(node):
    try:
        if ident(node) == notice_id and found["text"] is None:
            found["text"] = subtree_text(node) or (node.name or "")
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(found["text"] if found["text"] is not None else chr(0))
`;

function readNoticeText(rootPid: number, id: string): string | null {
  const proc = Bun.spawnSync(["python3", "-c", PY_NOTICE, pidListArg(rootPid), id], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const text = proc.stdout.toString();
  return text === "\0" ? null : text;
}

/** store/mod.rs MAX_DEPTH: without it a parent_id cycle recurses forever here
 *  where the store's own walk bounds it and reports Corrupt. */
const MAX_DEPTH = 64;

interface StoredItem {
  id: string;
  type: string;
  title: string;
  depth: number;
  body: string | null;
}

/** The store's depth-first walk plus each scene's body, restated from
 *  store/mod.rs items() and run against the file directly with bun:sqlite. The
 *  process that wrote it is dead by the time this runs, so this is the store's
 *  own account rather than the application's. */
function readStore(path: string): StoredItem[] {
  const db = new Database(path, { readonly: true });
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
         SELECT w.id, w.type, w.title, w.depth, d.body
           FROM walk w LEFT JOIN doc d ON d.item_id = w.id
          ORDER BY w.path`,
      )
      .all() as StoredItem[];
  } finally {
    db.close();
  }
}

/** A stored ProseMirror body projected to text.
 *
 * The rig's OWN restatement of `store::document_text`'s rule: inline text
 * concatenated with nothing, one space before each block's content. Not
 * imported and not inferred from the importer — the same reason
 * `markdown-read.ts` exists. */
function bodyText(body: string): string {
  const root: unknown = JSON.parse(body);
  let out = "";
  const append = (node: unknown, isBlock: boolean): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; content?: unknown };
    if (n.type === "text") {
      if (typeof n.text === "string") out += n.text;
      return;
    }
    if (isBlock && out.length > 0) out += " ";
    if (Array.isArray(n.content)) for (const child of n.content) append(child, false);
  };
  const top = root as { content?: unknown };
  if (Array.isArray(top.content)) for (const block of top.content) append(block, true);
  return out;
}

/** Every run of text in a body that carries at least one mark. */
function markedRuns(body: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; marks?: unknown; content?: unknown };
    if (n.type === "text" && typeof n.text === "string" && Array.isArray(n.marks) && n.marks.length > 0) {
      out.push(n.text);
    }
    if (Array.isArray(n.content)) for (const child of n.content) visit(child);
  };
  visit(JSON.parse(body));
  return out;
}

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; import run skipped (needs a display and a built shell).");
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

const root = mkdtempSync(join(tmpdir(), "app-import-"));
const dataHome = join(root, "data");
const dropDir = join(root, "drop");
const projectPath = join(root, "open.db");
mkdirSync(dataHome, { recursive: true });
mkdirSync(dropDir, { recursive: true });
function cleanup(): void {
  rmSync(root, { recursive: true, force: true });
}

writeFileSync(join(dropDir, SOURCE_NAME), SOURCE);

// The oracle, computed before anything is launched. If the rig's own reader
// cannot make sense of the file it authored, no verdict below would mean
// anything.
const oracle = readManuscript(SOURCE);
if (oracle.title === null || oracle.sections.length === 0 || oracle.orphanBlocks !== 0) {
  console.error(
    `the rig's own source file did not read back cleanly ` +
      `(title=${oracle.title}, sections=${oracle.sections.length}, orphans=${oracle.orphanBlocks}); ` +
      `nothing was written.`,
  );
  cleanup();
  process.exit(2);
}
const oracleMarks = oracle.sections.flatMap((s) => s.emphasized);
if (oracleMarks.length === 0) {
  // import_marks_survive would render UNKNOWN and the run would be quietly
  // weaker than it reads. The source is the rig's own, so this is a rig defect.
  console.error("the rig's source carries no emphasis; the marks gate would prove nothing.");
  cleanup();
  process.exit(2);
}
console.log(
  `[1/4] oracle: "${oracle.title}", ${oracle.sections.length} sections, ` +
    `${oracleMarks.length} emphasized run(s)`,
);

console.log(`[2/4] seeding the project the window opens on, from ${FIXTURE}`);
const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, projectPath], {
  stdout: "inherit",
  stderr: "inherit",
});
if (seeded.exitCode !== 0) {
  console.error(`seeding failed (exit ${seeded.exitCode}); nothing was written.`);
  cleanup();
  process.exit(1);
}

console.log("[3/4] interactive run: open the project panel and click the file");
const outcome = await runShell({
  mode: "virtual",
  soakMs: 0,
  staged: DIST,
  env: {
    APP_RUN: "interactive",
    APP_PROJECT: projectPath,
    // The library the import lands in. An isolated data home, so a run neither
    // reads nor writes the operator's real manuscripts.
    XDG_DATA_HOME: dataHome,
    APP_IMPORT_DIR: dropDir,
    // Load-bearing: a developer's ambient session sets WAYLAND_DISPLAY and GTK
    // prefers Wayland, so the webview would open on the real desktop instead of
    // the Xvfb display xdotool targets.
    GDK_BACKEND: "x11",
  },
  probeA11y: false,
  onReady: async ({ displayNum, rootPid }) => {
    if (displayNum === null) throw new Error("import rig requires a fixed X display");
    const display = `:${displayNum}`;
    const wid = findWindowId(display);
    await Bun.sleep(SETTLE_MS);
    xdo(display, ["windowfocus", wid]);
    // A key send not preceded by this guard is a key send with no evidence
    // behind it: an unfocused window swallows the chord, which reads exactly
    // like the page ignoring it — and the whole panel route below is chords.
    const focused = xdo(display, ["getwindowfocus"]).trim();
    if (focused !== wid) {
      throw new Error(`focus is on window ${focused}, not the shell's ${wid}; refusing to drive the menu`);
    }

    // The panel is closed at boot, so the import rows do not exist yet. It is
    // opened from File > Open project…, which is where it lives since the
    // retirement slice took #project-toggle out of the bar. The item's index
    // inside the File menu is PARSED out of menu-bar.ts by menu-drive.ts, never
    // restated here — an item inserted above it moves this with it.
    const menu = menuDriver(display, wid, xdo);
    await menu.activate("menu-project-open");
    await Bun.sleep(SETTLE_MS);

    // The ONE walk that matters. Several walks in one window kill the app, so
    // everything below is computed from this single reading.
    const open = locateNodes(rootPid);

    // The replacement for the old "#project-toggle is absent" abort, and it
    // carries the same force in the other direction: that guard refused to
    // click a button that was not there, this one refuses to grade a panel that
    // never opened. #project-panel itself is a `role="dialog"` and locateNodes
    // filters to a small set of roles that does not include it, so the witness
    // is the Create button — a `push button` that only exists inside the panel
    // and only while it is shown. Without this, a menu route that silently did
    // nothing would fall through to the row guard below and be reported as
    // "project_import_list did not offer the file", which is a different defect
    // in a different file.
    if (open.find((n) => n.id === "project-create") === undefined) {
      throw new Error(
        `the project panel did not open: File > Open project… left no #project-create button in ` +
          `the accessibility tree, so the menu route did not reach the panel. Nodes seen: ` +
          `${open.map((n) => n.id || n.role).join(", ") || "none"}`,
      );
    }

    const row = open.find((n) => n.role === "list item" && n.name === SOURCE_NAME);
    if (row === undefined) {
      const items = open.filter((n) => n.role === "list item").map((n) => n.name);
      throw new Error(
        `no import row named ${SOURCE_NAME} in the panel. List items seen: ` +
          `${items.join(" | ") || "none"}. The panel IS open (checked above), so ` +
          `project_import_list did not offer the file.`,
      );
    }
    const target = centreOf(row);
    xdo(display, ["mousemove", "--window", wid, String(target.x), String(target.y)]);
    xdo(display, ["click", "1"]);
    await Bun.sleep(IMPORT_MS);

    // No window manager under Xvfb: this kills the process rather than
    // delivering a graceful close. The import has already been committed by the
    // host by this point — it is one synchronous command, not a debounced
    // autosave — so nothing here depends on the close round trip.
    xdo(display, ["windowclose", wid]);
    await Bun.sleep(2000);
  },
});

console.log("[4/4] reading the imported project back out of SQLite");
const library = join(dataHome, "cc.local.app", "projects");
const created = existsSync(library)
  ? readdirSync(library).filter((f) => f.endsWith(".db"))
  : [];
if (created.length > 1) {
  // Two projects means something other than the one import also created one,
  // and grading whichever sorts first would be grading an accident.
  console.error(`the library holds ${created.length} projects (${created.join(", ")}); expected 1.`);
  cleanup();
  process.exit(2);
}

const importedPath = created[0] === undefined ? null : join(library, created[0]);
const items = importedPath === null ? [] : readStore(importedPath);

// The oracle's sections are in file order, which is the depth-first order the
// walk comes back in, so they align by index.
const paired = oracle.sections.map((section, n) => ({ section, stored: items[n] }));

let depthMatches = 0;
let titleMatches = 0;
let proseMatches = 0;
let oracleProseSections = 0;
const foundMarks: string[] = [];

for (const { section, stored } of paired) {
  if (stored === undefined) continue;
  // The oracle reports a heading LEVEL; the store reports a DEPTH. The rig's
  // own restatement of the mapping is expectedHeadingLevel, used in the
  // direction it was written for so the two rigs cannot disagree about it.
  if (expectedHeadingLevel(stored.depth) === section.level) depthMatches++;
  if (stored.title === section.title) titleMatches++;
  const wanted = normalizeText(section.text);
  if (wanted.length > 0) {
    oracleProseSections++;
    if (stored.body !== null && normalizeText(bodyText(stored.body)) === wanted) proseMatches++;
  }
  if (stored.body !== null) foundMarks.push(...markedRuns(stored.body));
}

const marksFound = oracleMarks.filter((run) => foundMarks.includes(run)).length;

const metrics: ImportMetrics = {
  created: importedPath !== null,
  items: items.length,
  oracle_items: oracle.sections.length,
  depth_matches: depthMatches,
  title_matches: titleMatches,
  prose_matches: proseMatches,
  oracle_prose_sections: oracleProseSections,
  marks_found: marksFound,
  oracle_marks: oracleMarks.length,
  peak_rss_mb: outcome.peakRssMb,
};

const verdicts = evaluateImportGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

writeResult(
  buildResult({
    runId: "app-import-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-import",
    verdicts,
    metrics: {
      ...metrics,
      project_name: oracle.title,
      source_bytes: SOURCE.length,
      // Stated here as well as on the fidelity gate's threshold line: an
      // exclusion recorded only in scope is an exclusion nobody sees.
      scope:
        "prose compared with whitespace collapsed on both sides; the source is the rig's own " +
        "manuscript, not an export, so this grades the FORMAT rather than a round trip against " +
        "the emitter",
      omitted_gates:
        "no import_ms: the only channel for seeing that an import finished is AT-SPI, and " +
        "polling it fast enough to time a sub-second operation is what kills the app (see " +
        "find-cli). A safe interval is larger than the thing being measured.",
    },
    seed: "n/a",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);

// -------------------------------------------------------- the DOCX round trip
//
// Plan 093's decision 11. Project A above came from the Markdown import; this
// exports A through the CLI's own `export --format docx` (headless, no
// window) into the SAME drop directory, then imports THAT file through the
// panel in a SECOND BOOT and compares the result back to A -- never to the
// rig's own Markdown source, which would make this a second copy of the
// gates above rather than a test of the DOCX pair (`docx.rs` writing,
// `docx_import.rs` reading).
//
// A SECOND BOOT, NOT A SECOND IMPORT IN THIS WINDOW. The plan's own words:
// "if a second import in one window is not possible the way the panel is
// built, a second boot is the fallback and the plan author decides." This
// rig already spends its one measured walk locating and clicking the
// Markdown row above; asking the SAME window to do that again for a second
// file -- reopening the panel a second time after a project was just
// created under it -- is an untested sequence this file's own header warns
// against risking. A fresh boot pays a slower run for a shape this rig
// already knows survives: one walk to find the row and click it, exactly as
// above. The one departure from "one walk per window" is the SECOND walk
// inside this boot that reads the loss notice after the click -- `nodes.ts`'s
// own recorded exception (mirror-cli.ts, two walks surviving a window open
// for tens of seconds) is the precedent spent here rather than a THIRD boot.
/** The three DOCX gates, FAILed with `cause` as the value, for a run that
 *  never got far enough to measure them at all. A gate this rig cannot run
 *  is not a gate that passed -- reporting nothing here, on the reasoning
 *  that follows `verdicts` alone into the exit code, is how a broken export
 *  or a project that never got created reads as a green run. */
function failedDocxVerdicts(cause: string): GateResult[] {
  const verdicts: GateResult[] = [
    {
      gate: "import_docx_round_trip_items",
      value: cause,
      threshold: "the DOCX round trip holds the same item count, title and depth as project A",
      verdict: "FAIL",
    },
    {
      gate: "import_docx_round_trip_prose",
      value: cause,
      threshold: "every scene's prose equal to project A's (whitespace normalized both sides)",
      verdict: "FAIL",
    },
    {
      gate: "import_docx_reports_no_loss",
      value: cause,
      threshold: "importing this crate's own DOCX export raises no loss notice",
      verdict: "FAIL",
    },
  ];
  for (const v of verdicts) {
    console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
  }
  return verdicts;
}

let docxVerdicts: GateResult[] = [];

if (importedPath === null) {
  const cause = "project A was not created, so the DOCX round trip has nothing to export";
  console.log(`[5/6] ${cause}.`);
  docxVerdicts = failedDocxVerdicts(cause);
} else {
  console.log("[5/6] exporting project A as DOCX, headlessly, for the round trip");
  const docxName = "harbour-lights.docx";
  const docxPath = join(dropDir, docxName);
  const exported = Bun.spawnSync([BIN, "export", importedPath, docxPath, "--format", "docx"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (exported.exitCode !== 0) {
    const cause = `could not export project A as DOCX (exit ${exported.exitCode})`;
    console.error(`[5/6] ${cause}.`);
    docxVerdicts = failedDocxVerdicts(cause);
  } else {
    console.log("[6/6] second boot: importing the DOCX export through the panel");
    // Computed INSIDE the closure below and copied into these two plain
    // values rather than read back from a `let string | null` afterwards:
    // TypeScript's control-flow narrowing of a variable reassigned inside an
    // async callback does not survive the `await` boundary cleanly, and a
    // `noticeText.trim()` after it was typechecked as `never`.
    // `noticeRaw` is a plain `string`, never `null`, on the same reasoning
    // the comment above already gives for `noticeShown`: TypeScript's
    // control-flow narrowing of a `let` reassigned inside an async callback
    // does not survive the `await` boundary, and a nullable type here
    // typechecked the later `.includes` call as unreachable on `never`.
    let noticeShown = false;
    let noticeRaw = "";

    // A SECOND DATA HOME, so project B has a library of its own. The DOCX
    // carries project A's name in its Title paragraph, and importing it into
    // A's library is refused as a duplicate ("a project named ... already
    // exists") -- which the first run of this boot read off the banner as a
    // loss notice and graded 0 of 6. B is therefore the only store file in
    // its library, and `import_docx_reports_no_loss` still fails on ANY
    // banner, error or loss alike, which is the honest reading.
    const dataHomeB = join(root, "data-b");
    mkdirSync(dataHomeB, { recursive: true });
    const libraryB = join(dataHomeB, "cc.local.app", "projects");

    await runShell({
      mode: "virtual",
      soakMs: 0,
      staged: DIST,
      env: {
        APP_RUN: "interactive",
        APP_PROJECT: projectPath,
        XDG_DATA_HOME: dataHomeB,
        APP_IMPORT_DIR: dropDir,
        GDK_BACKEND: "x11",
      },
      probeA11y: false,
      onReady: async ({ displayNum, rootPid }) => {
        if (displayNum === null) throw new Error("import rig requires a fixed X display");
        const display = `:${displayNum}`;
        const wid = findWindowId(display);
        await Bun.sleep(SETTLE_MS);
        xdo(display, ["windowfocus", wid]);
        const focused = xdo(display, ["getwindowfocus"]).trim();
        if (focused !== wid) {
          throw new Error(
            `focus is on window ${focused}, not the shell's ${wid}; refusing to drive the menu`,
          );
        }

        const menu = menuDriver(display, wid, xdo);
        await menu.activate("menu-project-open");
        await Bun.sleep(SETTLE_MS);

        const open = locateNodes(rootPid);
        if (open.find((n) => n.id === "project-create") === undefined) {
          throw new Error(
            "the project panel did not open for the DOCX import: File > Open project… left no " +
              `#project-create button in the accessibility tree. Nodes seen: ` +
              `${open.map((n) => n.id || n.role).join(", ") || "none"}`,
          );
        }
        const row = open.find((n) => n.role === "list item" && n.name === docxName);
        if (row === undefined) {
          const rows = open.filter((n) => n.role === "list item").map((n) => n.name);
          throw new Error(
            `no import row named ${docxName} in the panel. List items seen: ` +
              `${rows.join(" | ") || "none"}.`,
          );
        }
        const target = centreOf(row);
        xdo(display, ["mousemove", "--window", wid, String(target.x), String(target.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(IMPORT_MS);

        // THE SECOND WALK: the loss notice, off `open-error` -- the same
        // banner id `announce`/`raiseNotice` share -- read only now that
        // the import has actually landed and had a chance to raise one.
        const notice = readNoticeText(rootPid, "open-error");
        noticeShown = notice !== null && notice.trim().length > 0;
        noticeRaw = notice ?? "";

        xdo(display, ["windowclose", wid]);
        await Bun.sleep(2000);
      },
    });

    console.log("reading project B back out of SQLite");
    const afterSecondBoot = existsSync(libraryB)
      ? readdirSync(libraryB).filter((f) => f.endsWith(".db"))
      : [];
    if (afterSecondBoot.length > 1) {
      // A bare `throw` here would skip `cleanup()` and the final `process.exit`
      // below entirely -- an uncaught exception at top level, leaving the temp
      // root behind and the process exit code to Node/Bun's own default rather
      // than this rig's. The library-A guard above already goes through
      // `cleanup()` before exiting; this one must too.
      console.error(`library B holds ${afterSecondBoot.length} store files; expected the one import`);
      cleanup();
      process.exit(2);
    }
    const bName = afterSecondBoot[0];
    const bPath = bName === undefined ? null : join(libraryB, bName);
    const itemsB = bPath === null ? [] : readStore(bPath);

    let titleDepthMatches = 0;
    for (let i = 0; i < Math.min(items.length, itemsB.length); i++) {
      const a = items[i]!;
      const b = itemsB[i]!;
      if (a.title === b.title && a.depth === b.depth) titleDepthMatches++;
    }

    const scenesA = items.filter((i) => i.body !== null);
    let docxProseMatches = 0;
    for (const a of scenesA) {
      const idx = items.indexOf(a);
      const b = itemsB[idx];
      if (
        b !== undefined &&
        b.body !== null &&
        normalizeText(bodyText(a.body!)) === normalizeText(bodyText(b.body))
      ) {
        docxProseMatches++;
      }
    }

    const docxMetrics: DocxImportMetrics = {
      items_a: items.length,
      items_b: itemsB.length,
      title_depth_matches: titleDepthMatches,
      prose_matches: docxProseMatches,
      scenes_compared: scenesA.length,
      loss_notice_shown: noticeShown,
    };

    docxVerdicts = evaluateDocxImportGates(docxMetrics);
    for (const v of docxVerdicts) {
      console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
    }

    // `notice_kind` carries the fact a committed result needs ("did a
    // banner show"); `notice_text` carries the WORDS only when they cannot
    // be a path. The banner this walk reads is `open-error`'s own text, and
    // that channel is shared with refusals that DO name a path (a project
    // already existing at a location, for one) -- recording it unconditionally
    // would put an absolute filesystem path into committed evidence the very
    // first time this rig ran against a duplicate.
    const noticeKind: "none" | "shown" = noticeShown ? "shown" : "none";
    const noticeText = noticeRaw.includes("/")
      ? "(a banner carrying a path; not recorded)"
      : noticeRaw || "(none)";

    writeResult(
      buildResult({
        runId: "app-import-docx-round-trip",
        candidate: "tauri",
        fixture: "tiny",
        workload: "app-import-docx",
        verdicts: docxVerdicts,
        metrics: {
          ...docxMetrics,
          notice_kind: noticeKind,
          notice_text: noticeText,
          scope:
            "project B (imported from A's own DOCX export) compared to project A -- never to " +
            "the rig's Markdown source, which would grade the Markdown pair a second time " +
            "instead of the DOCX one",
        },
        seed: "n/a",
        rigCommit: gitShortSha(),
        environment: captureEnv(),
      }),
      RESULTS,
    );
  }
}

cleanup();
process.exit(
  [...verdicts, ...docxVerdicts].some((v) => v.verdict === "FAIL") ? 1 : 0,
);
