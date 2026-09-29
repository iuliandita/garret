// app/harness/src/salvage-cli.ts
// Graded run of `salvage`, the most dangerous command in the tree: it is what a
// writer runs when their book has already broken, and until 2026-08-31 seven
// consecutive slices each had to write the sentence "no graded rig covers
// salvage".
//
// THE ORACLE IS FREE AND THAT IS THE WHOLE DESIGN. 046 specified this rig in one
// sentence: seed at `tiny` and `stress`, PLANT every surface the four salvage
// slices built, damage the file in a fixed scripted way, run the release
// binary's `salvage --json`, and gate on the manifest and the recovered files.
// Because the rig writes the rows and scripts the injuries, it knows exactly
// what must come back -- which is precisely what grading an EPUB or a PDF proof
// lacks, and why those stay ungraded.
//
// WHAT IT ADDS OVER THE UNIT TESTS is the wall clock and the peak resident
// memory of copying and walking a 20,000-item file. 046 named that measurement
// and nothing in this project had ever taken it.
//
// NO WINDOW, NO Xvfb, NO AT-SPI. `salvage` has no page surface -- which is why
// 047 judged a GUI rig the wrong instrument for it and left it ungraded -- so
// nothing here spawns a shell, and none of the recorded AT-SPI, xdotool or
// WebKitGTK hazards apply.
//
// THE READER IS THE HARNESS'S OWN (app/harness/src/salvage-read.ts), written
// from the decision records and not from `salvage.rs`. The DAMAGE and the loss
// kinds it owes live in app/harness/src/salvage-damage.ts, because a rule
// written inside a `*-cli.ts` is unmutatable: this file aborts at module scope,
// so no test can import it.
//
// THE CORPUS. An earlier record noted its own hole: every recovery path here was
// built and graded against damage inflicted THROUGH SQL, on a file SQLite still
// considers valid, and the gap between that and "not a database at all" -- a
// truncated write, a torn page, a header that lies about the file's geometry --
// is the state a writer with a genuinely broken book is most likely in. Phase 8
// generates that corpus from `salvage-corpus.ts` and grades salvage against it
// on FOUR PROPERTIES and not on how much came back: it terminates, it does not
// panic, it reports what it could not read, and it never says complete when it
// lost something.
//
// Usage: bun app/harness/src/salvage-cli.ts <tiny|stress>
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { captureEnv } from "./env";
import { assertFixtureFloor, fixtureItemFloor } from "./fixture-floor";
import {
  evaluateSalvageGates,
  type GateResult,
  type SalvageCorpusRun,
  type SalvageMetrics,
} from "./gates";
import { writePng } from "./png";
import { buildResult, writeResult } from "./results";
import {
  btreePages,
  corpusPlan,
  digest,
  type CorpusEntry,
  type CorpusTargets,
} from "./salvage-corpus";
import { damagePlan, expectedLossKinds, type DamageTargets } from "./salvage-damage";
import {
  manifestsOwed,
  namedPathsIn,
  readCast,
  readComments,
  readCovers,
  readSnapshots,
  readSynopses,
  readWordlist,
} from "./salvage-read";
import { BIN } from "./shell";

const RESULTS = "app/results";
/** store/mod.rs MAX_DEPTH, restated as every rig here restates it. */
const MAX_DEPTH = 64;
/** How often the peak-memory sampler reads /proc while the command runs. */
const RSS_POLL_MS = 20;
/** How long one salvage may take before the rig calls it never. A liveness
 *  bound, generously above `salvage_ms`, and not the gate. */
const SALVAGE_TIMEOUT_MS = 300_000;

const fixture = process.argv[2];
if (fixture !== "tiny" && fixture !== "stress") {
  console.error("usage: bun app/harness/src/salvage-cli.ts <tiny|stress>");
  process.exit(1);
}
const FIXTURE_DIR = `lab/fixtures/out/${fixture}`;

function abort(why: string, cleanup: () => void): never {
  console.error(`\nABORTED: ${why}\nNothing was written to ${RESULTS}.`);
  cleanup();
  process.exit(1);
}

function gitShortSha(): string {
  const proc = Bun.spawnSync(["/usr/bin/git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim() || "unknown";
}

function query<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

function exec(path: string, statements: string[]): void {
  const db = new Database(path);
  try {
    for (const sql of statements) db.run(sql);
  } finally {
    db.close();
  }
}

/** The store's own depth-first walk, restated from store/mod.rs items() and run
 *  against the file. The rig's targets come from here and never from the
 *  fixture's manifest: an id is a fact about the seeded file. */
function walk(path: string): { id: string; type: string; title: string }[] {
  return query(
    path,
    `WITH RECURSIVE w(id, parent_id, type, title, position, depth, path) AS (
       SELECT id, parent_id, type, title, position, 0, position
         FROM item WHERE parent_id IS NULL
       UNION ALL
       SELECT i.id, i.parent_id, i.type, i.title, i.position, w.depth + 1,
              w.path || '/' || i.position
         FROM item i JOIN w ON i.parent_id = w.id
        WHERE w.depth + 1 < ${MAX_DEPTH}
     )
     SELECT id, type, title FROM w ORDER BY path`,
  );
}

/** What the manifest holds. Every field the rig reads, and nothing it invents:
 *  an absent key here is a contract change and must fail loudly. */
interface Manifest {
  items_recovered: number;
  documents_recovered: number;
  synopses_recovered: number;
  cast_members_recovered: number;
  cast_fields_recovered: number;
  appearances_recovered: number;
  comments_recovered: number;
  comments_orphaned: number;
  wordlist_recovered: number;
  snapshots_recovered: number;
  versions_recovered: number;
  versions_dropped: number;
  pictures_recovered: number;
  covers_recovered: number;
  raw_bodies: string[];
  design: Record<string, string | null> | null;
  losses: { kind: string; detail: string }[];
  complete: boolean;
}

interface Run {
  exitCode: number;
  wallMs: number;
  peakRssMb: number;
  manifest: Manifest | null;
  /** Every string in this run's `manifest.json` that names an absolute path or
   *  the directory the run happened in. Read from the FILE, because the
   *  file is the artifact that travels. */
  namedPaths: { at: string; value: string }[];
  /** The process died on a signal, or its stderr carried a Rust panic. BOTH,
   *  because a panic inside a Tauri command is caught and printed while the
   *  process still exits with a code, and a segfault prints nothing at all. */
  panicked: boolean;
}

/** Run the release binary's `salvage` and sample its peak resident memory.
 *
 *  THE FIGURE IS THE KERNEL'S OWN HIGH-WATER MARK (`VmHWM`), not a polled
 *  `VmRSS`. It is monotonic, so a poll that happens to miss the busiest instant
 *  still reports the true peak up to the last read -- a LOWER bound, and the
 *  scope block says so. Polling `VmRSS` at the same interval would report
 *  whatever the sampler happened to catch, which is what `rss.ts` does for a
 *  long-lived GUI tree and is the wrong instrument for a sub-second command. */
async function salvage(source: string, out: string): Promise<Run> {
  const started = performance.now();
  const proc = Bun.spawn([BIN, "salvage", source, out, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let hwmKb = 0;
  const sampler = setInterval(() => {
    try {
      const status = readFileSync(`/proc/${proc.pid}/status`, "utf8");
      const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
      if (m !== null) hwmKb = Math.max(hwmKb, Number(m[1]));
    } catch {
      // the process exited between the poll and the read
    }
  }, RSS_POLL_MS);
  const deadline = setTimeout(() => proc.kill(), SALVAGE_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearInterval(sampler);
  clearTimeout(deadline);
  const wallMs = performance.now() - started;
  const stderr = await new Response(proc.stderr).text();
  const signal = proc.signalCode;
  const panicked =
    stderr.includes("panicked at") ||
    stderr.includes("RUST_BACKTRACE") ||
    signal === "SIGSEGV" ||
    signal === "SIGABRT" ||
    signal === "SIGILL" ||
    signal === "SIGBUS";
  const manifestPath = join(out, "manifest.json");
  const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
  return {
    exitCode,
    wallMs,
    peakRssMb: Math.round((hwmKb / 1024) * 10) / 10,
    manifest: manifestText === null ? null : (JSON.parse(manifestText) as Manifest),
    // `workDir` is what every path in this run is under, so it is what a value
    // made relative to something would still name.
    namedPaths: manifestText === null ? [] : namedPathsIn(manifestText, workDir),
    panicked,
  };
}

// ------------------------------------------------------- what the rig plants

/** The photograph and the two covers. Generated rather than committed, on
 *  `png.ts`'s own precedent: a 3.7 kB checked-in file answers nothing, and these
 *  are compared BYTE FOR BYTE against what came out. */
const PICTURE_W = 240;
const PICTURE_H = 160;
const PLANTED = {
  synopses: [
    { at: 0, body: "the harbour at dawn, and the boat that does not come back" },
    { at: 1, body: "he leaves before dawn" },
  ],
  members: [
    { id: "cm-ada", kind: "character", name: "Ada", summary: "the harbourmaster", picture: true },
    { id: "cm-bo", kind: "place", name: "Bo Quay", summary: "", picture: false },
  ],
  /** Written OUT OF ORDINAL ORDER so the order in `cast.md` is the emitter's. */
  fields: [
    { member: "cm-ada", ordinal: 1, label: "Wound", value: "the fire" },
    { member: "cm-ada", ordinal: 0, label: "Eyes", value: "grey" },
  ],
  comments: [
    { at: 0, body: "tighten this", from: 4, to: 9, quote: "the harbour", resolved: null },
    { at: 0, body: "done now", from: 12, to: 20, quote: "more words", resolved: 5 },
    /** THE COLLAPSED ANCHOR. `from >= to` is what the application itself derives
     *  "an edit destroyed this passage" from, and 049 decided salvage says the
     *  same word by the same derivation and records NO loss for it. */
    { at: 1, body: "lost passage", from: 7, to: 7, quote: "the vanished sentence", resolved: null },
  ],
  /** DELIBERATELY OUT OF ORDER, and mixed case: the order in `wordlist.md` is
   *  then the emitter's and not the input's. */
  words: ["Zelenko", "alderman", "Ravensmoot"],
  design: {
    "design.font": "Crimson Text",
    "design.page": "152400x228600 trade",
    "design.margins": "19050,15875,15875,19050",
    "design.glyph": "fleuron",
    "design.chapter": "new-page drop-cap",
  } as Record<string, string>,
  covers: { "design.cover.front": "front.png", "design.cover.back": "back.png" },
  snapshotId: 7,
  snapshotLabel: "before the cut",
  /** The prose of the past draft, and the needle that tells a written snapshot
   *  file from an empty one. */
  pastDraft: "a past draft of the harbour, before the cut",
  automaticVersions: 2,
};

const DESIGN_KEYS = Object.keys(PLANTED.design);

// --------------------------------------------------------------------- run

const workDir = mkdtempSync(join(tmpdir(), "app-salvage-"));
function cleanup(): void {
  rmSync(workDir, { recursive: true, force: true });
}

const projectPath = join(workDir, "book.db");
const picturesDir = join(workDir, "book.pictures");

console.log(`[1/8] seeding ${fixture} through the release binary`);
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE_DIR, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`seeding failed (exit ${seeded.exitCode})`, cleanup);
}

const seedWalk = walk(projectPath);
const scenes = seedWalk.filter((r) => r.type === "scene");
if (scenes.length < 2) {
  abort(
    `the seeded ${fixture} fixture holds ${scenes.length} scene(s); the plant needs two distinct ` +
      "ones, and the damage script needs the corrupted body and the deleted item to be " +
      "different rows.",
    cleanup,
  );
}
// A rig that cannot see its own fixture must abort, not grade.
try {
  assertFixtureFloor(fixture, seedWalk.length, fixtureItemFloor(FIXTURE_DIR));
} catch (e) {
  abort(String(e instanceof Error ? e.message : e), cleanup);
}

// VACUITY GUARDS. Every count below is graded against what this rig planted, so
// a fixture that already held any of it would grade rows nobody wrote.
for (const [table, what] of [
  ["synopsis", "a synopsis"],
  ["cast_member", "a cast"],
  ["cast_field", "a cast detail"],
  ["appearance", "an appearance"],
  ["comment", "a note"],
  ["dict_word", "a taught word"],
  ["snapshot", "a named snapshot"],
  ["doc_version", "a stored version"],
  ["blob", "a stored blob"],
] as const) {
  const n = query<{ n: number }>(projectPath, `SELECT COUNT(*) AS n FROM ${table}`)[0]!.n;
  if (n !== 0) {
    abort(
      `the seeded ${fixture} fixture already holds ${what} (${n} row(s) in ${table}); every ` +
        "count this rig grades is against what it planted, and a pre-existing row would be " +
        "graded as a recovery of something nobody wrote.",
      cleanup,
    );
  }
}
for (const key of [...DESIGN_KEYS, ...Object.keys(PLANTED.covers)]) {
  const rows = query<{ value: string }>(
    projectPath,
    `SELECT value FROM meta WHERE key = '${key}'`,
  );
  if (rows.length !== 0) {
    abort(`the seeded fixture already carries ${key}; the plant would be invisible.`, cleanup);
  }
}

console.log("[2/8] planting every surface the four salvage slices built");
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const scene1 = scenes[0]!;
const scene2 = scenes[1]!;
const sceneAt = (at: number) => (at === 0 ? scene1 : scene2);
/** EVERY STATEMENT THE PLANT RUNS, BUILT FRESH ON EACH CALL.
 *
 *  Phase 8 seeds a SECOND base and plants it by calling this AGAIN, which is how
 *  the corpus proves it is byte-exact: a digest compared against a copy of
 *  itself proves nothing, and a digest compared against an independently seeded
 *  and independently built file proves both halves at once. A version that built
 *  the array ONCE and replayed it was written first and could not see a clock
 *  read inside the plant at all -- the same literal went into both files -- which
 *  a sabotage found and this shape fixes. */
function buildPlantStatements(): string[] {
  const statements: string[] = [];
  for (const s of PLANTED.synopses) {
    statements.push(
      `INSERT INTO synopsis VALUES (${q(sceneAt(s.at).id)}, ${q(s.body)}, 1, 1)`,
    );
  }
  for (const m of PLANTED.members) {
    statements.push(
      `INSERT INTO cast_member VALUES (${q(m.id)}, ${q(m.kind)}, ${q(m.name)}, ` +
        `${q(m.summary)}, 1, 1, ${m.picture ? q("ada.png") : "NULL"})`,
    );
  }
  for (const f of PLANTED.fields) {
    statements.push(
      `INSERT INTO cast_field VALUES (${q(f.member)}, ${f.ordinal}, ${q(f.label)}, ${q(f.value)})`,
    );
  }
  statements.push(`INSERT INTO appearance VALUES (${q(scene1.id)}, 'cm-ada')`);
  statements.push(`INSERT INTO appearance VALUES (${q(scene2.id)}, 'cm-bo')`);
  for (const c of PLANTED.comments) {
    statements.push(
      "INSERT INTO comment (item_id, body, anchor_from, anchor_to, quote, resolved_at, " +
        `created_at, updated_at) VALUES (${q(sceneAt(c.at).id)}, ${q(c.body)}, ${c.from}, ` +
        `${c.to}, ${q(c.quote)}, ${c.resolved === null ? "NULL" : c.resolved}, 1, 1)`,
    );
  }
  for (const w of PLANTED.words) {
    statements.push(`INSERT INTO dict_word (word, created_at) VALUES (${q(w)}, 1)`);
  }
  for (const [key, value] of Object.entries({ ...PLANTED.design, ...PLANTED.covers })) {
    statements.push(`INSERT INTO meta VALUES (${q(key)}, ${q(value)})`);
  }
  return statements;
}
exec(projectPath, buildPlantStatements());

// THE PHOTOGRAPH AND THE TWO COVERS ARE PLANTED AS FILES, exactly as
// `shot-cli --cast` and `bible-cli` plant, and for their reason: the only route
// a writer has to attach one is the host's OS dialog, which only `dialog-cli`
// drives. What is being graded is the COPY, not the attachment.
mkdirSync(picturesDir, { recursive: true });
const pictureBytes = new Map<string, Uint8Array>();
for (const [name, tint] of [
  ["ada.png", 0],
  ["front.png", 90],
  ["back.png", 180],
] as const) {
  const bytes = writePng(PICTURE_W, PICTURE_H, (x, y) => [
    (x + tint) % 256,
    (y + tint) % 256,
    (x + y) % 256,
  ]);
  pictureBytes.set(name, bytes);
  writeFileSync(join(picturesDir, name), bytes);
}

// THE HISTORY. One named snapshot holding a past draft of both scenes, and two
// AUTOMATIC versions (`snapshot_id IS NULL`, which is the only thing that makes
// a version automatic -- store/mod.rs refuses a `kind` column beside it).
const draftBody = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: PLANTED.pastDraft }] }],
});
const blobKey = new Bun.CryptoHasher("sha256").update(draftBody).digest("hex");
/** The history, on `buildPlantStatements`' rule and for its reason. */
const buildHistoryStatements = (): string[] => [
  `INSERT INTO blob VALUES (${q(blobKey)}, ${q(draftBody)})`,
  `INSERT INTO snapshot (id, label, created_at) VALUES (${PLANTED.snapshotId}, ` +
    `${q(PLANTED.snapshotLabel)}, 30)`,
  ...[scene1.id, scene2.id].map(
    (id) =>
      "INSERT INTO doc_version (item_id, blob_key, created_at, words, snapshot_id) VALUES (" +
      `${q(id)}, ${q(blobKey)}, 30, 8, ${PLANTED.snapshotId})`,
  ),
  ...Array.from({ length: PLANTED.automaticVersions }, (_, n) =>
    "INSERT INTO doc_version (item_id, blob_key, created_at, words, snapshot_id) VALUES (" +
    `${q(scene1.id)}, ${q(blobKey)}, ${10 + n}, 8, NULL)`,
  ),
];
exec(projectPath, buildHistoryStatements());

const storeItems = seedWalk.length;
const storeDocuments = query<{ n: number }>(projectPath, "SELECT COUNT(*) AS n FROM doc")[0]!.n;
/** A sentence out of the STORE, used as the manuscript's needle. Read from the
 *  stored JSON by this rig's own scan, never from the exporter. */
const storedNeedle = (() => {
  const body = query<{ body: string }>(
    projectPath,
    `SELECT body FROM doc WHERE item_id = ${q(scene1.id)}`,
  )[0]?.body;
  const text = body === undefined ? [] : [...body.matchAll(/"text":"((?:[^"\\]|\\.){12,})"/g)];
  return text.length === 0 ? null : (JSON.parse(`"${text[0]![1]!}"`) as string);
})();
if (storedNeedle === null) {
  abort(
    `the seeded ${fixture} fixture's first scene holds no text run long enough to look for in ` +
      "the manuscript. Without a needle, salvage_prose_recovered's last clause is satisfied by " +
      "an exporter that wrote nothing.",
    cleanup,
  );
}

console.log("[3/8] copying the project and inflicting the scripted damage");
const hurtPath = join(workDir, "hurt.db");
const hurtPictures = join(workDir, "hurt.pictures");
copyFileSync(projectPath, hurtPath);
mkdirSync(hurtPictures, { recursive: true });
for (const name of readdirSync(picturesDir)) {
  copyFileSync(join(picturesDir, name), join(hurtPictures, name));
}
const targets: DamageTargets = {
  corruptedScene: scene1.id,
  deletedItem: scene2.id,
  deletedMember: "cm-ada",
  designKey: DESIGN_KEYS[0]!,
  removedCover: PLANTED.covers["design.cover.front"],
};
const plan = damagePlan(targets);
for (const step of plan) {
  if (step.sql.length > 0) exec(hurtPath, step.sql);
  for (const name of step.removeFiles) rmSync(join(hurtPictures, name), { force: true });
}
const expected = expectedLossKinds(plan);

console.log("[4/8] salvaging the healthy project (timed, memory sampled)");
const healthyOut = join(workDir, "out");
const healthy = await salvage(projectPath, healthyOut);
if (healthy.manifest === null) {
  abort(`the healthy salvage wrote no manifest (exit ${healthy.exitCode}).`, cleanup);
}
const manifest = healthy.manifest;

console.log("[5/8] the three refusals: an occupied destination, and a source that will not read");
// EXIT 1: the destination already exists. The SOURCE is fine, so this must not
// read as "could not open the project" -- which is why salvage is the one
// subcommand not routed through `read`.
const occupied = await salvage(projectPath, healthyOut);
// EXIT 2: a zero-byte file. SQLite reads one as an EMPTY DATABASE, so this is
// the case that would otherwise report a truncated manuscript as a project with
// nothing in it.
const emptySource = join(workDir, "empty.db");
writeFileSync(emptySource, new Uint8Array(0));
const unreadable = await salvage(emptySource, join(workDir, "empty-out"));

console.log("[6/8] salvaging the damaged copy");
const damagedOut = join(workDir, "hurt-out");
const damaged = await salvage(hurtPath, damagedOut);
if (damaged.manifest === null) {
  abort(`the damaged salvage wrote no manifest (exit ${damaged.exitCode}).`, cleanup);
}

// A recovery that reported no damage at all cannot tell a correct refusal from a
// broken damage script, so the run stops rather than recording that ambiguity.
if (damaged.manifest.losses.length === 0) {
  abort(
    "the damaged copy salvaged with NO losses at all. Either the damage script wrote nothing or " +
      "the recovery is silent about it; both are findings, and neither is a verdict this run " +
      "may record as a gate.",
    cleanup,
  );
}

console.log("[7/8] reading the recovered files back with the harness's own reader");
const read = (name: string): string | null => {
  const path = join(healthyOut, name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};
const manuscript = read("manuscript.md") ?? "";
const synopses = readSynopses(read("synopses.md") ?? "");
const cast = readCast(read("cast.md") ?? "");
const notes = readComments(read("comments.md") ?? "");
const words = readWordlist(read("wordlist.md") ?? "");
const covers = readCovers(read("covers.md") ?? "");
const snapshots = readSnapshots(read("snapshots.md") ?? "");
const documentFiles = existsSync(join(healthyOut, "documents"))
  ? readdirSync(join(healthyOut, "documents")).filter((n) => n.endsWith(".md"))
  : [];
const snapshotFiles = existsSync(join(healthyOut, "snapshots"))
  ? readdirSync(join(healthyOut, "snapshots"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(e.parentPath, e.name))
  : [];
const recoveredPictures = existsSync(join(healthyOut, "pictures"))
  ? readdirSync(join(healthyOut, "pictures"))
  : [];

const bySynopsisItem = new Map(synopses.map((s) => [s.id, s]));
const synopsisBodiesMatch = PLANTED.synopses.every(
  (s) => bySynopsisItem.get(sceneAt(s.at).id)?.body === s.body,
);

const byMember = new Map(cast.map((m) => [m.id, m]));
const castFileAgrees = PLANTED.members.every((m) => {
  const found = byMember.get(m.id);
  if (found === undefined) return false;
  if (found.name !== m.name || found.summary !== m.summary) return false;
  const owed = PLANTED.fields
    .filter((f) => f.member === m.id)
    .sort((a, b) => a.ordinal - b.ordinal);
  return (
    found.details.length === owed.length &&
    owed.every((f, at) => found.details[at]!.label === f.label && found.details[at]!.value === f.value)
  );
});
const appearanceLines = cast.reduce((a, m) => a + m.appearsIn.length, 0);

const noteKey = (from: number, to: number, body: string) => `${from}-${to}:${body}`;
const notesFound = new Map(notes.map((n) => [noteKey(n.from, n.to, n.body), n]));
const commentBodiesMatch = PLANTED.comments.every((c) => {
  const found = notesFound.get(noteKey(c.from, c.to, c.body));
  return found !== undefined && found.quote === c.quote && found.documentId === sceneAt(c.at).id;
});

const plantedPicture = pictureBytes.get("ada.png")!;
const recoveredPicture = existsSync(join(healthyOut, "pictures", "ada.png"))
  ? new Uint8Array(readFileSync(join(healthyOut, "pictures", "ada.png")))
  : null;
const pictureBytesMatch =
  recoveredPicture !== null &&
  recoveredPicture.length === plantedPicture.length &&
  recoveredPicture.every((b, at) => b === plantedPicture[at]);

const snapshotHoldsDraft = snapshotFiles.some((path) =>
  readFileSync(join(healthyOut, "snapshots", path.slice(path.indexOf("snapshots/") + 10)), "utf8")
    .includes(PLANTED.pastDraft),
);

console.log("[8/8] the corpus of genuinely damaged files");

/** WHICH B-TREE A ROWID ENUMERATION ACTUALLY SCANS, measured rather than
 *  assumed.
 *
 *  This is the fixture trap in its sixth costume and it was waiting here: every
 *  table in this schema answers `SELECT rowid FROM <t>` through a COVERING INDEX
 *  and not through the table, so a corpus that tore a page out of the `item`
 *  TABLE would never stop an enumeration and `salvage_corpus_enumeration_stopped_is_reached`
 *  would grade a file that cannot reach the branch it is named for. The plan is
 *  read with EXPLAIN QUERY PLAN and the root page of whatever it names is what
 *  the corpus tears. */
function enumerationTreeRoot(path: string, table: string): { name: string; root: number } {
  const plan = query<{ detail: string }>(path, `EXPLAIN QUERY PLAN SELECT rowid FROM ${table}`);
  const detail = plan.map((r) => r.detail).join(" ");
  const named = /USING (?:COVERING )?INDEX ([A-Za-z0-9_]+)/.exec(detail);
  const name = named === null ? table : named[1]!;
  const rows = query<{ rootpage: number }>(
    path,
    `SELECT rootpage FROM sqlite_schema WHERE name = ${q(name)}`,
  );
  const root = rows[0]?.rootpage ?? 0;
  if (root < 1) {
    abort(
      `the b-tree \`SELECT rowid FROM ${table}\` scans (${name}) has no root page in ` +
        "sqlite_schema, so the corpus has nothing to tear a page out of.",
      cleanup,
    );
  }
  return { name, root };
}

const enumerationTree = enumerationTreeRoot(projectPath, "item");
const docRoot = query<{ rootpage: number }>(
  projectPath,
  "SELECT rootpage FROM sqlite_schema WHERE name = 'doc'",
)[0]?.rootpage;
if (docRoot === undefined) abort("the seeded fixture has no doc table to tear a page out of.", cleanup);
const corpusTargets: CorpusTargets = {
  enumerationIndexRoot: enumerationTree.root,
  documentTableRoot: docRoot,
};

// THE SECOND BASE. Seeded again through the binary and planted again from the
// captured statements, in its own directory: the digests below compare two
// files that share nothing but the procedure that made them.
const secondBase = join(workDir, "second", "book.db");
mkdirSync(join(workDir, "second"), { recursive: true });
{
  const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE_DIR, secondBase], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) abort(`the second seeding failed (exit ${seeded.exitCode})`, cleanup);
  exec(secondBase, buildPlantStatements());
  exec(secondBase, buildHistoryStatements());
}

const baseBytes = new Uint8Array(readFileSync(projectPath));
const secondBytes = new Uint8Array(readFileSync(secondBase));
let corpus: CorpusEntry[];
let corpusAgain: CorpusEntry[];
try {
  corpus = corpusPlan(baseBytes, corpusTargets);
  corpusAgain = corpusPlan(secondBytes, corpusTargets);
} catch (e) {
  abort(String(e instanceof Error ? e.message : e), cleanup);
}
// A rig that tore a page out of a tree with one page would still reach the
// branch, but it would reach it having read NOTHING, and the entry's own name
// would be the only thing saying it was ever about a partial read.
const enumerationTreePages = btreePages(baseBytes, corpusTargets.enumerationIndexRoot).length;

/** Every string any manifest of this run carries that names a place on this
 *  machine, tagged with the run that wrote it. A LIST AND NOT A COUNT:
 *  the gate that reads it has no threshold, and what a reader needs when it goes
 *  red is which key in which manifest. */
const namedPaths: { run: string; at: string; value: string }[] = [];
/** How many manifests were actually read. The gate above is satisfied by an
 *  empty set, so a run that wrote none must not be able to pass it. */
let manifestsRead = 0;
const collectPaths = (run: string, r: Run): void => {
  if (r.manifest === null) return;
  manifestsRead += 1;
  for (const p of r.namedPaths) namedPaths.push({ run, at: p.at, value: p.value });
};
collectPaths("healthy", healthy);
collectPaths("damaged", damaged);

const corpusRuns: SalvageCorpusRun[] = [];
for (const [at, entry] of corpus.entries()) {
  const dbPath = join(workDir, `corpus-${entry.name}.db`);
  const picturesPath = join(workDir, `corpus-${entry.name}.pictures`);
  const outPath = join(workDir, `corpus-${entry.name}-out`);
  writeFileSync(dbPath, entry.db);
  if (entry.wal !== null) writeFileSync(`${dbPath}-wal`, entry.wal);
  // The photographs go beside every entry, so a file whose database is
  // untouched can legitimately salvage COMPLETE and the honesty gate has a
  // green case to distinguish from a dishonest one.
  mkdirSync(picturesPath, { recursive: true });
  for (const [name, bytes] of pictureBytes) writeFileSync(join(picturesPath, name), bytes);

  const run = await salvage(dbPath, outPath);
  collectPaths(`corpus:${entry.name}`, run);
  corpusRuns.push({
    name: entry.name,
    allowed_exits: entry.allowedExits,
    exit_code: run.exitCode,
    wall_ms: Number(run.wallMs.toFixed(1)),
    panicked: run.panicked,
    complete: run.manifest?.complete ?? null,
    items_recovered: run.manifest?.items_recovered ?? null,
    documents_recovered: run.manifest?.documents_recovered ?? null,
    loss_kinds:
      run.manifest === null ? [] : [...new Set(run.manifest.losses.map((l) => l.kind))].sort(),
    digest: digest(entry.db),
    digest_again: digest(corpusAgain[at]!.db),
  });
  // Removed as we go: at `stress` one entry is a 16 MB file and up to 71 MB of
  // recovery, and /tmp is tmpfs on the measurement machine.
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(picturesPath, { recursive: true, force: true });
  rmSync(outPath, { recursive: true, force: true });
}
rmSync(join(workDir, "second"), { recursive: true, force: true });

// THE COUNT, and it is an abort rather than a gate. `salvage_manifest_names_no_path`
// grades a LIST, so a run that collected fewer manifests than it wrote would
// leave it green over a fraction of its subject -- and this wiring is inside a
// `*-cli.ts`, which no test can reach. The rule is `manifestsOwed`, which has
// its own tests; the abort is what makes a rig that stops collecting loud.
const owed = manifestsOwed(corpusRuns);
if (manifestsRead !== owed) {
  abort(
    `${manifestsRead} manifest(s) were read and this run wrote ${owed}. ` +
      "salvage_manifest_names_no_path grades a list, so a short collection is a gate " +
      "checking less than it says it checks, which is not a verdict this run can record.",
    cleanup,
  );
}

const metrics: SalvageMetrics = {
  fixture,
  store_items: storeItems,
  store_documents: storeDocuments,
  manifest_items_recovered: manifest.items_recovered,
  manifest_documents_recovered: manifest.documents_recovered,
  document_files_written: documentFiles.length,
  manuscript_holds_stored_prose: manuscript.includes(storedNeedle),
  synopses_planted: PLANTED.synopses.length,
  synopses_recovered: manifest.synopses_recovered,
  synopses_in_file: synopses.length,
  synopsis_bodies_match: synopsisBodiesMatch,
  cast_members_planted: PLANTED.members.length,
  cast_fields_planted: PLANTED.fields.length,
  cast_members_recovered: manifest.cast_members_recovered,
  cast_fields_recovered: manifest.cast_fields_recovered,
  cast_file_agrees: castFileAgrees,
  appearances_planted: 2,
  appearances_recovered: manifest.appearances_recovered,
  appearance_lines_found: appearanceLines,
  comments_planted: PLANTED.comments.length,
  comments_recovered: manifest.comments_recovered,
  comments_orphaned: manifest.comments_orphaned,
  comment_orphan_marks: notes.filter((n) => n.flags.includes("orphaned")).length,
  comment_resolved_marks: notes.filter((n) => n.flags.includes("resolved")).length,
  comment_bodies_match: commentBodiesMatch,
  collapsed_anchor_planted: PLANTED.comments.some((c) => c.from >= c.to),
  healthy_complete: manifest.complete,
  healthy_loss_kinds: [...new Set(manifest.losses.map((l) => l.kind))].sort(),
  wordlist_planted: PLANTED.words,
  wordlist_recovered: manifest.wordlist_recovered,
  wordlist_in_file: words,
  pictures_planted: 1,
  pictures_recovered: manifest.pictures_recovered,
  picture_bytes_match: pictureBytesMatch,
  covers_planted: 2,
  covers_recovered: manifest.covers_recovered,
  cover_files_written: [covers.front, covers.back].filter(
    (p) => p !== null && existsSync(join(healthyOut, p)),
  ).length,
  design_planted: PLANTED.design,
  design_recovered: Object.fromEntries(
    DESIGN_KEYS.map((key) => [key, manifest.design?.[key.replace(/^design\./, "")] ?? null]),
  ),
  snapshots_planted: 1,
  snapshot_documents_planted: 2,
  snapshots_recovered: manifest.snapshots_recovered,
  versions_recovered: manifest.versions_recovered,
  snapshot_files_written: snapshotFiles.length,
  snapshot_holds_the_past_draft: snapshotHoldsDraft,
  automatic_versions_planted: PLANTED.automaticVersions,
  versions_dropped: manifest.versions_dropped,
  damaged_exit_code: damaged.exitCode,
  damaged_complete: damaged.manifest.complete,
  expected_loss_kinds: expected,
  damaged_loss_kinds: [...new Set(damaged.manifest.losses.map((l) => l.kind))].sort(),
  damaged_raw_bodies: damaged.manifest.raw_bodies.length,
  exit_healthy: healthy.exitCode,
  exit_occupied_destination: occupied.exitCode,
  exit_unreadable_source: unreadable.exitCode,
  exit_damaged: damaged.exitCode,
  salvage_ms: Number(healthy.wallMs.toFixed(1)),
  peak_rss_mb: healthy.peakRssMb,
  manifests_read: manifestsRead,
  named_paths_in_manifests: namedPaths,
  corpus: corpusRuns,
  corpus_healthy_items: manifest.items_recovered,
  corpus_healthy_documents: manifest.documents_recovered,
};

const verdicts: GateResult[] = evaluateSalvageGates(metrics);

const path = writeResult(
  buildResult({
    workload: "app-salvage",
    runId: `app-salvage-${fixture}`,
    candidate: "tauri",
    fixture,
    verdicts,
    metrics: {
      workload_script: "salvage-v1",
      salvage: metrics,
      source_bytes: query<{ n: number }>(projectPath, "SELECT 1 AS n").length,
      damage_plan: plan.map((s) => ({ name: s.name, expects: s.expects })),
      damaged_losses: damaged.manifest.losses,
      corpus_plan: corpus.map((e, at) => ({
        name: e.name,
        injury: e.injury,
        represents: e.represents,
        allowed_exits: e.allowedExits,
        bytes: e.db.length,
        wal_bytes: e.wal === null ? 0 : e.wal.length,
        sha256: digest(e.db),
        losses: corpusRuns[at]!.loss_kinds,
      })),
      corpus_enumeration_tree: {
        table: "item",
        scanned: enumerationTree.name,
        root_page: enumerationTree.root,
        pages: enumerationTreePages,
      },
      snapshot_files: snapshotFiles.map((p) => basename(p)),
      recovered_pictures: recoveredPictures,
      salvage_ms_per_run: {
        healthy: Number(healthy.wallMs.toFixed(1)),
        damaged: Number(damaged.wallMs.toFixed(1)),
      },
      peak_rss_mb_per_run: { healthy: healthy.peakRssMb, damaged: damaged.peakRssMb },
      omitted_gates: [
        {
          gate: "latency, stall, cliff, a11y_exposure, a11y_tree_structure, startup_ms",
          reason:
            "salvage has NO PAGE SURFACE. Nothing here opens a window, spawns an Xvfb or " +
            "attaches to AT-SPI, so there is no frame cadence, no navigator and no " +
            "accessibility contract to grade. That is 047's reason for judging a GUI rig the " +
            "wrong instrument for this command, and it is why this rig is a CLI one.",
        },
      ],
      scope: {
        the_oracle:
          "FREE, and that is the design. The rig plants every row it grades and scripts every " +
          "injury it inflicts, so what must come back is known exactly rather than inferred. " +
          "Nothing here asks salvage what it did: the counts come from the manifest, the " +
          "content from the written files read by the harness's own reader, and the store side " +
          "from bun:sqlite.",
        the_reader:
          "app/harness/src/salvage-read.ts is the harness's OWN restatement of the six shapes " +
          "salvage writes, built from the samples quoted in the 046, 048, 049 and 050 decision " +
          "records and NOT from salvage.rs. Its tests parse those samples, never output taken " +
          "from a run: a reader checked against the emitter's own bytes agrees with the emitter " +
          "about anything, including a defect.",
        planting:
          "The synopses, cast, tags, notes, wordlist, design, covers, photograph and history " +
          "are written with bun:sqlite and as files beside the store, exactly as shot-cli " +
          "--cast and bible-cli plant and for their reason: the only route a writer has to most " +
          "of these is a panel or an OS dialog, and what is graded here is the RECOVERY, not " +
          "the attachment. The fixture is asserted to hold none of them first.",
        exit_codes:
          "0 is a complete salvage, 1 the operator asking wrongly (here: a destination that " +
          "already exists), 2 a source that cannot be read (here: a zero-byte file, which " +
          "SQLite would otherwise read as an empty database), and 3 an answer that carries " +
          "losses. 3 IS SALVAGE WORKING. A rig that treated a non-zero exit as failure would " +
          "grade this command backwards.",
        the_collapsed_anchor:
          "The healthy project deliberately carries a comment whose anchor has collapsed " +
          "(from >= to), which is what the application itself derives 'an edit destroyed this " +
          "passage' from. 049 decided it is a recovered note with a caveat and never a Loss, " +
          "because the row read perfectly - so the healthy run must still be complete and exit " +
          "0. This is the one gate here whose subject is something salvage must NOT do.",
        peak_rss_mb:
          "The kernel's own high-water mark (VmHWM in /proc/<pid>/status), sampled every " +
          `${RSS_POLL_MS} ms while the command runs and taken as the last value read. VmHWM is ` +
          "monotonic, so the figure is a LOWER BOUND on the true peak: a poll that missed the " +
          "busiest instant still reports the peak up to its last read, and only memory " +
          "allocated after the final poll is invisible. It is the salvage PROCESS alone, not a " +
          "process tree - this command spawns nothing.",
        the_corpus:
          "Eight files SQLite does not consider valid, generated from the seeded and planted " +
          "project by a byte-exact procedure in salvage-corpus.ts: two truncations, two torn " +
          "pages, a header that lies about the page size, a broken b-tree interior pointer, an " +
          "unreplayable -wal sidecar, and a header cut in half. What is graded is NOT how much " +
          "came back - it is that every one terminates, does not panic, reports what it could " +
          "not read, and never says complete while short of the healthy salvage of the same " +
          "project. Determinism is proven by generating the whole corpus a SECOND time from a " +
          "separately seeded and separately planted base and comparing sha256 per entry.",
        the_corpus_target:
          "Which b-tree a rowid enumeration scans is MEASURED with EXPLAIN QUERY PLAN and not " +
          "assumed: every table in this schema answers `SELECT rowid FROM <t>` through a " +
          "covering index rather than through the table, so a corpus that tore a page out of " +
          "the item TABLE could never stop an enumeration and the gate named for that branch " +
          "would grade a file that cannot reach it.",
        what_the_corpus_does_not_claim:
          "A VALID uncheckpointed -wal is not in it: its header carries random salts and its " +
          "frames carry checksums over them, so producing one means either running a process " +
          "and killing it - whose bytes differ every run - or writing a WAL encoder, which is " +
          "inventing an SQLite writer. A LOST -wal is not in it either: the file left behind is " +
          "byte-identical to a healthy older database, so nothing in it says a newer commit " +
          "ever existed and no oracle can tell the two apart. A corrupted page checksum is not " +
          "in it because SQLite main-database pages carry none.",
        salvage_ms:
          "Wall clock from the spawn to the process exiting, so it covers the working copy, " +
          "the twelve-table walk, every file written and the manifest. It is not a latency " +
          "figure for any one part and the threshold is a liveness bound, not a budget.",
      },
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
