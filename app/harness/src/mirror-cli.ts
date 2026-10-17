// app/harness/src/mirror-cli.ts
// Graded READABLE-MIRROR run: the folder is written, an edit made outside it is
// noticed and not overwritten, and the writer takes that edit into their book.
//
// THE STANDING P0 THIS CLOSES. Four earlier changes each ended with the
// same sentence in their write-back: no rig covers the mirror, and every claim
// about it in this repository is checked by a `cargo` test over a temp
// directory. One of them was total -- every prose edit invisible to the folder,
// permanently, for four slices -- and it was found by READING the code, by no
// test and no instrument. `mirror_carries_a_prose_edit` below is the gate that
// would have caught it, and the sabotage run that proves it can go red is in
// `app/results/superseded/`.
//
// TWO BOOTS AND AN EDIT BETWEEN THEM, which is what makes this rig expensive and
// is not avoidable: the subject is a writer editing a file OUTSIDE the
// application while it is closed. `mirror-shot.ts` beside this file does the
// same two boots and grades nothing -- it photographs a panel. The two are not
// merged because they want different things from the same dance: one needs a
// diff open in frame, this one needs the store read after the process is gone.
//
// THE ORACLE IS `mirror-read.ts`, NEVER THE HOST'S PARSER. The design names an
// independent restatement as an obligation of this comparison
// (`readable-mirror-design.md:549-559`), and until this rig existed that module
// shipped with no gate consuming it -- flagged as such in an earlier write-back.
//
// THREE THINGS THAT COST THIS RIG'S ANCESTOR FIVE RUNS, all recorded in
// mirror-shot.ts and all still true here:
//   - A boot that types nothing leaves the mirror nothing to write. The pass is
//     owed only after a committed flush, so the folder stays empty and looks
//     exactly like a broken mirror.
//   - Without `xdotool windowfocus` the keystrokes reach nothing, with the same
//     symptom and a different cause. This rig checks a document revision moved
//     and says which of the two happened.
//   - `click --window` is ignored by WebKitGTK: a windowed `mousemove` then a
//     BARE `click`.
//
// Usage: APP_GUI=1 bun app/harness/src/mirror-cli.ts
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
import { join } from "node:path";
import { captureEnv, noteRenderer } from "./env";
import { evaluateMirrorGates, type MirrorMetrics } from "./gates";
import { menuDriver } from "./menu-drive";
import { readDocumentFile } from "./mirror-read";
import { locateNodes, type Node } from "./nodes";
import { nodeToPress, type PressSelector, pressPoint } from "./press-selector";
import { buildResult, writeResult } from "./results";
import { descendantsByComm, sumTreeRssKb } from "./rss";
import { probeRenderer, type RendererRecord } from "./renderer";
import { BIN, SHELL_PROC_NAME, assertAtspiBridgeEnabled, freeDisplayNumber, survivingShellPids } from "./shell";
import { parseGeometry } from "./window-size";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";
const RESULTS = "app/results";
const CLASS = "^[Aa]pp-shell-tauri$";

/** How long to let the ten-second mirror schedule come round, with room. */
const MIRROR_WAIT_MS = 16_000;

// THE BATCH CONTROL IS PRESSED BY ID, NEVER BY NAME. `#mirror-changes-accept-all`
// carries an id the whole time it exists; its accessible name does not --
// `mirror.changes.accept.all.one/other` restates the COUNT of rows it will
// sweep ("Take the words from 1 file" / "... from {count} files"), so the same
// press one row later would be a press by a string that has since changed
// under it. A row's own accept is the opposite case (`ROW_ACCEPT_NAME_PREFIX`
// below): it carries no id at all, so a name is the only channel left, and its
// name is the one piece of it a fixture can restate exactly -- the title.

/** Typed on the first boot, before the folder has ever been written. */
const FIRST = "Quillon watched the sarsen stones darken. ";
/** Typed on the SAME boot after the folder exists, which is 029's case. */
const SECOND = "The harbour lanterns went out one at a time. ";
/** What the writer puts in the file, in an editor that is not this one.
 *
 *  WRITTEN ACROSS TWO LINES, AND THAT IS THE WHOLE FALSIFIABILITY OF THE SETTLE
 *  GATE. The first version of this constant was one line, and
 *  `mirror_settles_after_an_accept` PASSED against a build whose
 *  `settle_accepted` was a no-op: with the manifest left stale the next pass
 *  does rewrite the file, but it rewrites it from a body parsed out of that
 *  same file, and the exporter's rendering of a one-line paragraph is byte for
 *  byte what the writer left. The gate was reading "the round trip is stable",
 *  which is true of both implementations, instead of "the file was not
 *  rewritten". That is the recorded fixture-is-a-fact-about-itself family, in a
 *  gate.
 *
 *  A paragraph is a run of non-blank lines to both readers, so the two lines
 *  parse to one paragraph and the ACCEPT is unaffected -- but the exporter
 *  emits that paragraph on ONE line, so any rewrite changes the bytes and the
 *  gate can see it. The `!OUTSIDE.includes("\n")` check below (and its
 *  OTHER_OUTSIDE twin) refuses to run if either ever becomes a single line
 *  again. */
const OUTSIDE =
  "She had rewritten the whole scene in another editor,\nand the ending was different now.";
/** Words unique to OUTSIDE, checked for in the store rather than the whole
 *  sentence -- the tail is enough to prove the file's own words reached the
 *  book, and it is the same substring `accepted_body_in_the_store` has always
 *  matched on. */
const TARGET_PHRASE = "different now";

/** A SECOND file, rewritten from outside the same way, so the panel offers
 *  TWO comparable rows and a per-row press has something to leave alone.
 *  Different words from OUTSIDE for the same reason 029's fixture needed two
 *  sentences: a defect that pressed the wrong row, or the batch in the row's
 *  place, must be able to leave a trace this rig can tell apart from the
 *  first file's. WRITTEN ACROSS TWO LINES for the same reason OUTSIDE is --
 *  see the paragraph above it. */
const OTHER_OUTSIDE =
  "Someone had left every window in the house open,\nand the smell of rain came in through all of them.";
/** Words unique to OTHER_OUTSIDE, `TARGET_PHRASE`'s counterpart. */
const OTHER_PHRASE = "came in through all of them";

/** The literal the page composes for a row's own accept
 *  (`mirror.changes.accept.name` = "Take the words in the file into {title}"),
 *  restated here rather than imported: this rig presses by the string the
 *  page builds, and importing it would let a renamed string agree with itself
 *  instead of with what the accessibility tree actually says. */
const ROW_ACCEPT_NAME_PREFIX = "Take the words in the file into ";

/** The batch control's label once exactly one comparable row is left
 *  (`mirror.changes.accept.all.one` = "Take the words from 1 file"),
 *  restated for the same reason as the prefix above. Polled for before the
 *  batch press so that press lands on the count the per-row accept actually
 *  left, not on a stale "2 files" the tree has not repainted yet. */
const ACCEPT_ALL_ONE_FILE_LABEL = "Take the words from 1 file";

if (process.env.APP_GUI !== "1") {
  console.log("mirror-cli: skipped (set APP_GUI=1 to run it)");
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

const work = mkdtempSync(join(tmpdir(), "mirror-cli-"));
const project = join(work, "project.db");
const dataHome = join(work, "data");
const mirrorRoot = join(work, "mirror");
mkdirSync(join(dataHome, "garret"), { recursive: true });
mkdirSync(mirrorRoot, { recursive: true });

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
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(p.stdout).trim() || "unknown";
}

/** FNV-1a 64-bit, restated rather than imported: the harness restates the
 *  host's rules by standing rule, and a shared helper would agree with a
 *  shared mistake. */
function fnv64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Move to `node`'s centre and press a BARE click: `click --window` is a
 *  synthesized event WebKitGTK drops while the pointer still moves, the same
 *  rule every press in this repository follows. Every press in this rig goes
 *  through this one primitive, so the click mechanics live in exactly one
 *  place. */
function clickNode(wid: string, node: Node, geometry: { width: number; height: number }): void {
  const at = pressPoint(node, geometry);
  xdo(["mousemove", "--window", wid, String(at.x), String(at.y)]);
  xdo(["click", "1"]);
}

/** Walk the tree once and either press the control `decide` names, or press
 *  nothing at all.
 *
 *  `decide` sees the WHOLE walk and returns the selector to press, or `null`
 *  to skip -- a run this rig cannot safely make (too few of a control, or not
 *  the two specific rows it needs) must leave a RED GATE behind it, never a
 *  thrown error that kills the run before the other nine gates get a verdict.
 *  Skipping spends the SAME walk `decide` was given rather than a second one
 *  spent only to learn there was nothing to press.
 *
 *  BOTH PRESSES IN THIS RIG GO THROUGH THIS ONE FUNCTION (the batch's through
 *  its own poll loop, which shares `clickNode` instead), so that if a run
 *  ever shows an AT-SPI walk in this window killing the shell -- the recorded
 *  rule ("several AT-SPI walks in one window kill the application outright")
 *  is measured for `shot-cli`'s capture window, not this rig's, which has now
 *  survived several in a row (see `nodes.ts`) -- the fallback (a third boot,
 *  walking once in it) is a change to this one function and its poll-loop
 *  sibling, and nothing that calls either. */
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

/** Every `.md` the folder holds, EXCLUDING the preserved side of a conflict --
 *  that one is the application's own file and is not one of the writer's. */
function mirrorFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".md") && !p.endsWith(".from-project.md")) found.push(p);
    }
  };
  walk(mirrorRoot);
  return found.sort();
}

/** The prose of every mirror file, read by the HARNESS's reader. */
function folderText(): string {
  return mirrorFiles()
    .map((f) => readDocumentFile(readFileSync(f, "utf8")).text)
    .join("\n");
}

interface Store {
  documents: number;
  /** Every document, WITH the item it belongs to. A gate that checked "does
   *  ANY document hold these words" would pass a host that wrote the accepted
   *  body into the wrong document, or into every one -- the per-row gates
   *  below key on `item_id` for exactly that reason. */
  docs: { item_id: string; body: string }[];
  /** Every snapshot, in the id order they were written -- `id` is
   *  `INTEGER PRIMARY KEY AUTOINCREMENT` in `store/mod.rs`, so ORDER BY id is
   *  chronological, not a restated assumption. ALL of them, not the first:
   *  two accepts (a per-row press, then the batch) each owe one, and reading
   *  only the first would agree with a build that dropped the second. */
  snapshots: { id: number; label: string }[];
  comments: { anchor_from: number; anchor_to: number }[];
  /** Every item's title, BY ID -- what the page interpolates into a row's
   *  accessible name through `rowLabel`, never the file's own H1. The two
   *  usually agree, but the tree is built from the store's title and a rig
   *  that pressed by the file's would be pressing by a fact about a different
   *  surface. */
  itemTitles: Record<string, string>;
}

function readStore(): Store {
  const db = new Database(project, { readonly: true });
  try {
    return {
      documents: (db.query("SELECT count(*) AS n FROM doc").get() as { n: number }).n,
      docs: db.query("SELECT item_id, body FROM doc").all() as { item_id: string; body: string }[],
      snapshots: db.query("SELECT id, label FROM snapshot ORDER BY id").all() as {
        id: number;
        label: string;
      }[],
      comments: db.query("SELECT anchor_from, anchor_to FROM comment").all() as {
        anchor_from: number;
        anchor_to: number;
      }[],
      itemTitles: Object.fromEntries(
        (db.query("SELECT id, title FROM item").all() as { id: string; title: string }[]).map((r) => [
          r.id,
          r.title,
        ]),
      ),
    };
  } finally {
    db.close();
  }
}

/** Whether any document's revision moved, so a failure to TYPE is reported as
 *  itself rather than as a mirror that wrote nothing. The two are
 *  indistinguishable from the outside and this is the whole difference. */
function typingLanded(): boolean {
  const db = new Database(project, { readonly: true });
  try {
    return (db.query("SELECT rev FROM doc").all() as { rev: number }[]).some((r) => r.rev > 1);
  } finally {
    db.close();
  }
}

const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, project], {
  stdout: "ignore",
  stderr: "inherit",
});
if (seeded.exitCode !== 0) throw new Error("seeding the project failed");
const mirrorDir = join(mirrorRoot, "by-id", readBookId(project));

/** Plant a live note on the document about to be rewritten.
 *
 *  THROUGH SQL, because the gate is about what the STORE does to an anchor and
 *  not about the comments panel -- driving the panel would make this run about
 *  a surface it is not measuring.
 *
 *  PLANTED ON `other`, THE ROW THE BATCH TAKES, and never on `target`: `target`
 *  is accepted by the PER-ROW press, which runs first, and a note planted on it
 *  would already be orphaned by the time the batch press this note exists to
 *  measure even runs. And never on "the first document" generally: the accept
 *  orphans the anchors of exactly the documents it rewrote, so a note on any
 *  other row would be satisfied by an implementation that collapsed nothing --
 *  and one on EVERY row would be satisfied by one that collapsed everything,
 *  which is the defect the rule exists to forbid.
 *
 *  ANCHORS 1..5 ARE INSIDE THE SEEDED BODY, so this is a live note rather than
 *  one already collapsed; an already-collapsed row would satisfy the orphan
 *  gate against an accept that did nothing at all. */
function plantNoteOn(itemId: string): void {
  const db = new Database(project);
  try {
    db.query(
      `INSERT INTO comment (item_id, body, anchor_from, anchor_to, quote, created_at, updated_at)
       VALUES (?1, 'a note about prose that is about to be replaced', 1, 5, 'x', 0, 0)`,
    ).run(itemId);
  } finally {
    db.close();
  }
}

// THE MIRROR IS ENABLED THROUGH `settings.json`, the way every rig here seeds a
// preference: the enable act is a panel click, and driving it would make this
// run about the project panel rather than about the folder.
writeFileSync(
  join(dataHome, "garret", "settings.json"),
  JSON.stringify({ theme: "system", mirrored_book_ids: [readBookId(project)] }),
);

const xvfb = Bun.spawn(["Xvfb", display, "-screen", "0", "1400x1000x24", "-nolisten", "tcp"], {
  stdout: "ignore",
  stderr: "ignore",
});
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

async function boot(): Promise<{ proc: Bun.Subprocess; wid: string }> {
  const proc = Bun.spawn([BIN], { env, stdout: "ignore", stderr: "ignore" });
  let wid: string | null = null;
  for (let waited = 0; waited < 90_000 && wid === null; waited += 500) {
    await Bun.sleep(500);
    wid = windowId();
  }
  if (wid === null) throw new Error("no window appeared");
  xdo(["windowfocus", wid]);
  await Bun.sleep(3000);
  const renderer = probeRenderer(descendantsByComm(proc.pid, "WebKitWebProces"));
  renderers.push(renderer);
  noteRenderer(renderer);
  return { proc, wid };
}

function quit(wid: string): void {
  // Tolerantly: a successful chord destroys the window it was sent to.
  Bun.spawnSync(["xdotool", "key", "--window", wid, "ctrl+q"], {
    env: { ...process.env, DISPLAY: display },
    stdout: "ignore",
    stderr: "ignore",
  });
}

const observed = {
  file_holds_the_typed_sentence: false,
  file_holds_the_second_sentence: false,
  external_edit_survived_the_reopen: false,
  rows_offered: 0,
  file_unchanged_after_accept: false,
  manifest_matches_the_file: false,
};

let filesWritten = 0;
let target = "";
let targetId = "";
let targetTitle = "";
let other = "";
let otherId = "";
let otherTitle = "";
let rowAcceptsOffered = 0;
let rowAccepted = false;
let rowAcceptTookItsFile = false;
let rowAcceptLeftTheOtherFile = false;
let rowAcceptFileUnchanged = false;
let rowAcceptManifestMatchesTheFile = false;
let acceptAllPresent = false;
let acceptAllLabelBeforeBatch = "";
let acceptAllPollMs = 0;
let targetHashBefore = "";
let targetHashAfter = "";
let otherHashBefore = "";
let otherHashAfter = "";

try {
  console.log("[1/5] first boot: type, let the folder be written, type again");
  const first = await boot();
  await Bun.sleep(4000);
  xdo(["mousemove", "--window", first.wid, "700", "500"]);
  xdo(["click", "1"]);
  await Bun.sleep(500);
  xdo(["type", "--window", first.wid, "--delay", "30", FIRST]);
  await Bun.sleep(MIRROR_WAIT_MS);
  if (!typingLanded()) {
    throw new Error(
      "no document revision moved, so nothing marked the folder owed: the keystrokes did not " +
        "reach the editor. Check the windowfocus above before blaming the mirror.",
    );
  }
  observed.file_holds_the_typed_sentence = folderText().includes(FIRST.trim());

  // THE SECOND SENTENCE IS THE WHOLE OF 029. It is typed AFTER the entry has
  // been written once, which is the state in which the incremental skip
  // compared a revision no keystroke moves and dropped every edit forever.
  xdo(["type", "--window", first.wid, "--delay", "30", SECOND]);
  await Bun.sleep(MIRROR_WAIT_MS);
  peakRssMb = Math.max(peakRssMb, Math.round(sumTreeRssKb(first.proc.pid) / 1024));
  observed.file_holds_the_second_sentence = folderText().includes(SECOND.trim());
  quit(first.wid);
  await Bun.sleep(3000);
  first.proc.kill();

  const files = mirrorFiles();
  filesWritten = files.length;
  if (filesWritten === 0) throw new Error("the folder is empty after a boot that typed");

  console.log("[2/5] rewriting two files from outside, as another editor would");
  // FALLS BACK RATHER THAN ABORTING, and the first sabotage run is what taught
  // this rig the difference. With 029's defect put back, no file holds the
  // second sentence -- and the first version of this line threw, so the run
  // produced a stack trace and NO RESULT: the gate written to catch that exact
  // defect had nothing to show for the one run in which it was present. A rig
  // that cannot grade a broken build cannot be said to grade anything.
  //
  // The order is deliberate: the newest sentence, then the older one, then any
  // file with prose at all. Whichever it lands on, the file is a real mirror
  // document and the accept can be driven through it -- so every gate after
  // this one still measures what it is named for while
  // `mirror_carries_a_prose_edit` goes red on its own.
  const withText = (needle: string): string | undefined =>
    files.find((f) => readDocumentFile(readFileSync(f, "utf8")).text.includes(needle));
  target =
    withText(SECOND.trim()) ??
    withText(FIRST.trim()) ??
    files.find((f) => readDocumentFile(readFileSync(f, "utf8")).text.trim() !== "") ??
    "";
  if (target === "") {
    throw new Error(
      "every file in the folder is empty, so there is nothing to edit from outside and no gate " +
        "below has a subject.",
    );
  }
  targetId = readDocumentFile(readFileSync(target, "utf8")).id ?? "";
  if (targetId === "") throw new Error(`${target} carries no id in its front matter`);

  // TITLES COME FROM THE STORE'S ITEM ROW, never the file's H1 -- what the
  // page actually interpolates into a row's accessible name through
  // `rowLabel`. Read once, before either file is rewritten: neither an
  // outside edit nor an accept changes an item's title, so this is the
  // fixture fact both names below are built from.
  const titles = readStore().itemTitles;
  targetTitle = titles[targetId] ?? "";
  if (targetTitle === "") {
    throw new Error(
      `the store's item ${targetId} carries no title, and the per-row accept's accessible name ` +
        "is built from one -- this fixture cannot name the control this run must press.",
    );
  }

  // THE SECOND ROW: another file the folder wrote that still carries prose,
  // under a STORE TITLE DISTINCT FROM TARGET'S. Two rows sharing a title
  // would make `nodeToPress` refuse both presses below with "N controls
  // share this name" -- the accessibility tree cannot tell two same-named
  // rows apart any better than a glance at the panel could.
  for (const f of files) {
    if (f === target) continue;
    const doc = readDocumentFile(readFileSync(f, "utf8"));
    if (doc.text.trim() === "") continue;
    const id = doc.id ?? "";
    if (id === "") continue;
    const title = titles[id] ?? "";
    if (title === "" || title === targetTitle) continue;
    other = f;
    otherId = id;
    otherTitle = title;
    break;
  }
  if (other === "") {
    throw new Error(
      "no second file in the folder carries prose under a store title distinct from target's -- " +
        "the fixture did not stage two nameable rows for this rig to grade.",
    );
  }
  plantNoteOn(otherId);

  const current = readFileSync(target, "utf8");
  const lines = current.split("\n");
  const head = lines.slice(0, lines.findIndex((l) => l.startsWith("# ")) + 1);
  const rewritten = `${head.join("\n")}\n\n${OUTSIDE}\n`;
  // THE VACUITY CONTROL FOR THE SETTLE GATE. If the prose the writer left is
  // something the exporter would emit byte for byte, a pass that rewrites the
  // file is indistinguishable from one that leaves it alone, and the gate below
  // measures the stability of the round trip instead of the settling. See
  // OUTSIDE: a survivor is what put this here.
  if (!OUTSIDE.includes("\n") || !OTHER_OUTSIDE.includes("\n")) {
    throw new Error(
      "an outside edit is a single line, so a pass that rewrote the file would produce the same " +
        "bytes and `mirror_settles_after_an_accept` could not fail.",
    );
  }
  writeFileSync(target, rewritten);
  targetHashBefore = fnv64(new Uint8Array(readFileSync(target)));

  const otherCurrent = readFileSync(other, "utf8");
  const otherLines = otherCurrent.split("\n");
  const otherHead = otherLines.slice(0, otherLines.findIndex((l) => l.startsWith("# ")) + 1);
  const otherRewritten = `${otherHead.join("\n")}\n\n${OTHER_OUTSIDE}\n`;
  writeFileSync(other, otherRewritten);
  otherHashBefore = fnv64(new Uint8Array(readFileSync(other)));

  console.log("[3/5] second boot: the scan notices, the panel offers, the writer takes");
  const second = await boot();
  await Bun.sleep(6000);
  // BEFORE ANYTHING IS PRESSED, on BOTH files. This is the design's "single
  // worst thing this feature could do", measured: the application has been
  // open long enough for a pass to have fired, and the writer's words are
  // still the ones on disk in both places it wrote them.
  observed.external_edit_survived_the_reopen =
    readFileSync(target, "utf8") === rewritten && readFileSync(other, "utf8") === otherRewritten;

  await menuDriver(display, second.wid, (_d, args) => xdo(args)).activate("menu-mirror-changes");
  await Bun.sleep(1500);

  console.log("[3b/5] walking once for both rows' own accepts, pressing target's if both are there");
  const targetRowName = `${ROW_ACCEPT_NAME_PREFIX}${targetTitle}`;
  const otherRowName = `${ROW_ACCEPT_NAME_PREFIX}${otherTitle}`;
  // ONE WALK. `decide` is where the count AND the two specific names are
  // read, all from this same walk: a tree that offers two per-row accepts
  // that are NEITHER target's nor other's is exactly as unpressable as one
  // that offers none, and counting alone would miss that.
  const rowNode = pressByTree(second.wid, second.proc.pid, (nodes) => {
    const rowAccepts = nodes.filter((n) => n.name.startsWith(ROW_ACCEPT_NAME_PREFIX));
    rowAcceptsOffered = rowAccepts.length;
    const hasBoth =
      rowAccepts.some((n) => n.name === targetRowName) && rowAccepts.some((n) => n.name === otherRowName);
    // NOT THROWN when hasBoth is false. A build whose per-row press is
    // secretly the batch, or one that made both rows vanish at once, must
    // leave `mirror_row_accept_takes_that_file` and
    // `_leaves_the_other_row` to FAIL from `rowAcceptsOffered` rather than
    // kill the run before either gate, or the seven besides them, gets a
    // verdict. This is what the first sabotage run actually hit.
    return hasBoth ? { by: "name", value: targetRowName } : null;
  });
  rowAccepted = rowNode !== null;

  if (rowAccepted) {
    await Bun.sleep(2000);
    // READ RIGHT HERE, BEFORE THE BATCH IS EVEN PRESSED: this is the only
    // moment at which "target's words are in, other's are not" is the
    // batch's to falsify rather than something a later press already
    // settled either way. KEYED ON item_id, never "any body in the store" --
    // a host that wrote the accepted words into the wrong document, or into
    // both, must not pass this by accident.
    const afterRowPress = readStore();
    const targetBody = afterRowPress.docs.find((d) => d.item_id === targetId)?.body ?? "";
    const otherBodyAfterRow = afterRowPress.docs.find((d) => d.item_id === otherId)?.body ?? "";
    rowAcceptTookItsFile = targetBody.includes(TARGET_PHRASE);
    rowAcceptLeftTheOtherFile = !otherBodyAfterRow.includes(OTHER_PHRASE);
  } else {
    // NOTHING WAS PRESSED, so neither claim can be true: the pair FAILs, and
    // `rowAcceptsOffered` (recorded above, inside the same walk) is what a
    // reader of the red gate looks at next.
    rowAcceptTookItsFile = false;
    rowAcceptLeftTheOtherFile = false;
  }

  console.log("[3c/5] polling for the batch control's one-file label, then pressing it if it is there");
  // MORE WALKS IN THE SAME WINDOW, on top of the one just above -- up to
  // twelve more, none of them a press. `nodes.ts`'s "one walk per window" is
  // measured for `shot-cli`'s capture window; THIS window survived two AT-SPI
  // walks across three runs on 2026-09-07 (11/11 gates PASS each time)
  // before this poll existed, which is the basis for spending more of the
  // same kind of walk here rather than a fresh boot. If a run ever shows this
  // budget of walks is where it stops surviving, the fallback (a third boot,
  // walking once in it) belongs in this loop and the poll that follows it,
  // not spread through the rest of the file.
  const POLL_STEP_MS = 500;
  const POLL_BUDGET_MS = 6000;
  let waitedForBatchMs = 0;
  let batchNodes = locateNodes(second.proc.pid);
  let acceptAllNode = batchNodes.find((n) => n.id === "mirror-changes-accept-all");
  while (
    waitedForBatchMs < POLL_BUDGET_MS &&
    (acceptAllNode === undefined || !acceptAllNode.name.startsWith(ACCEPT_ALL_ONE_FILE_LABEL))
  ) {
    await Bun.sleep(POLL_STEP_MS);
    waitedForBatchMs += POLL_STEP_MS;
    batchNodes = locateNodes(second.proc.pid);
    acceptAllNode = batchNodes.find((n) => n.id === "mirror-changes-accept-all");
  }
  acceptAllPollMs = waitedForBatchMs;
  acceptAllPresent = acceptAllNode !== undefined;
  // NOT GATED ON WORDING: a label reading "1 file" is evidence the per-row
  // press worked, but `mirror_row_accept_takes_that_file` /
  // `_leaves_the_other_row` already say so from the store, which a stale or
  // wrongly-worded label cannot fool either way. Recorded so a failing run
  // shows what the tree actually said.
  acceptAllLabelBeforeBatch = acceptAllNode?.name ?? "";
  if (acceptAllNode !== undefined) {
    const geometry = parseGeometry(xdo(["getwindowgeometry", "--shell", second.wid]));
    clickNode(second.wid, acceptAllNode, geometry);
  }
  // NOT THROWN when the control never appeared: a per-row press that quietly
  // took every comparable row (the coordinator's own sabotage run) leaves
  // NOTHING for the batch to sweep, and the batch control disappears with the
  // list it would have acted on. `accepted_body_in_the_store` and the settle
  // gate below read their own state regardless and FAIL on their own terms.

  await Bun.sleep(3000);
  peakRssMb = Math.max(peakRssMb, Math.round(sumTreeRssKb(second.proc.pid) / 1024));
  // AND THEN LEFT OPEN PAST A WHOLE MIRROR CYCLE, which is what makes the
  // settle gate mean anything: an accept that did not bring the manifest back
  // into step rewrites the file it has just read on the next tick.
  await Bun.sleep(MIRROR_WAIT_MS);
  quit(second.wid);
  await Bun.sleep(3000);
  second.proc.kill();

  console.log("[4/5] reading the folder and the store, with the process gone");
  // OVER `other`, THE REMAINING ROW -- `target` was already taken by the
  // per-row press above, so a settle check still reading `target` here would
  // be measuring the per-row press's settle a second time, and testing
  // nothing about the batch's own. `other` is the row the batch actually
  // swept, so it is the row whose settle answers what pressing the batch
  // control means for the file left in its wake.
  observed.file_unchanged_after_accept = readFileSync(other, "utf8") === otherRewritten;
  const manifest = JSON.parse(readFileSync(join(mirrorDir, "manifest.json"), "utf8")) as {
    entries: { path: string; hash: string }[];
  };
  const rel = other.slice(mirrorDir.length + 1);
  const row = manifest.entries.find((e) => e.path === rel);
  observed.manifest_matches_the_file =
    row !== undefined && row.hash === fnv64(new Uint8Array(readFileSync(other)));
  targetHashAfter = fnv64(new Uint8Array(readFileSync(target)));
  otherHashAfter = fnv64(new Uint8Array(readFileSync(other)));

  // THE PER-ROW PATH'S OWN SETTLE (`mirror_row_accept_settles`), over
  // `target` -- the row the per-row press took, checked against the SAME
  // manifest read above, after the same whole run (both boots, both accepts,
  // the wait past a full mirror cycle). Computed even when `rowAccepted` is
  // false; the gate itself is what turns that into UNKNOWN rather than a
  // vacuous PASS off a file nothing ever touched.
  const targetRel = target.slice(mirrorDir.length + 1);
  const targetRow = manifest.entries.find((e) => e.path === targetRel);
  rowAcceptFileUnchanged = readFileSync(target, "utf8") === rewritten;
  rowAcceptManifestMatchesTheFile = targetRow !== undefined && targetRow.hash === targetHashAfter;
} finally {
  if (survivingShellPids().length > 0) {
    Bun.spawnSync(["pkill", "-x", SHELL_PROC_NAME]);
    await Bun.sleep(1000);
    Bun.spawnSync(["pkill", "-9", "-x", SHELL_PROC_NAME]);
  }
  xvfb.kill();
  await xvfb.exited;
}

console.log("[5/5] grading");
const store = readStore();
// DISTINCT SNAPSHOT ROWS, not "any label matched" collapsed to a boolean: two
// accepts running should leave two rows, and a count taken from `.some` could
// not tell a run with one accept apart from a run with two, ever.
observed.rows_offered = store.snapshots.filter((s) => s.label.startsWith("Before accepting")).length;

const metrics: MirrorMetrics = {
  fixture: "tiny",
  files_written: filesWritten,
  store_documents: store.documents,
  file_holds_the_typed_sentence: observed.file_holds_the_typed_sentence,
  file_holds_the_second_sentence: observed.file_holds_the_second_sentence,
  external_edit_survived_the_reopen: observed.external_edit_survived_the_reopen,
  rows_offered: observed.rows_offered,
  // OTHER'S DOCUMENT, BY item_id, and OTHER'S phrase, not target's: target
  // was already accepted by the per-row press, so checking ANY body for ITS
  // words would pass even if the batch did nothing, and checking the right
  // words in the wrong document would pass a host that misfiled them.
  accepted_body_in_the_store: (store.docs.find((d) => d.item_id === otherId)?.body ?? "").includes(
    OTHER_PHRASE,
  ),
  snapshot_labels: store.snapshots.map((s) => s.label),
  comments_planted: store.comments.length,
  comments_orphaned: store.comments.filter((c) => c.anchor_from >= c.anchor_to).length,
  file_unchanged_after_accept: observed.file_unchanged_after_accept,
  manifest_matches_the_file: observed.manifest_matches_the_file,
  row_accepts_offered: rowAcceptsOffered,
  row_accept_pressed: rowAccepted,
  row_accept_took_its_file: rowAcceptTookItsFile,
  row_accept_left_the_other_file: rowAcceptLeftTheOtherFile,
  row_accept_file_unchanged: rowAcceptFileUnchanged,
  row_accept_manifest_matches_the_file: rowAcceptManifestMatchesTheFile,
  peak_rss_mb: peakRssMb,
};

const verdicts = evaluateMirrorGates(metrics);
for (const v of verdicts) {
  console.log(`  ${v.verdict.padEnd(7)} ${v.gate}: ${v.value}  [${v.threshold}]`);
}

const written = writeResult(
  buildResult({
    runId: "app-mirror-tiny",
    candidate: "tauri",
    fixture: "tiny",
    workload: "app-mirror",
    verdicts,
    metrics: {
      ...metrics,
      renderers,
      // NOT GATED ON -- recorded so a failing run says which row it pressed
      // and which row it left, in the writer's own paths and bytes rather
      // than in an id nobody reading the result JSON would recognise.
      edited_path: target.slice(mirrorRoot.length + 1),
      other_path: other.slice(mirrorRoot.length + 1),
      row_pressed_by_name: `${ROW_ACCEPT_NAME_PREFIX}${targetTitle}`,
      accept_all_present: acceptAllPresent,
      accept_all_label_before_batch: acceptAllLabelBeforeBatch,
      accept_all_poll_ms: acceptAllPollMs,
      target_hash_before: targetHashBefore,
      target_hash_after: targetHashAfter,
      other_hash_before: otherHashBefore,
      other_hash_after: otherHashAfter,
    },
    seed: "app-v1",
    rigCommit: gitShortSha(),
    environment: captureEnv(),
  }),
  RESULTS,
);
console.log(`\nwrote ${written}`);
rmSync(work, { recursive: true, force: true });
if (verdicts.some((v) => v.verdict === "FAIL")) process.exit(1);
