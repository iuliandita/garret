// Two isolated launches exercise the real change-panel batch accept and one undo.
import { readBookId } from "./book-id";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { captureEnv } from "./env";
import type { GateResult } from "./gates";
import { menuDriver } from "./menu-drive";
import { locateNodes } from "./nodes";
import { nodeToPress, pressPoint, type PressSelector } from "./press-selector";
import { buildResult, writeResult } from "./results";
import { BIN, assertAtspiBridgeEnabled, findWindowId, runShell } from "./shell";
import { parseGeometry } from "./window-size";

const theme = process.argv[2] ?? "light";
if (theme !== "light" && theme !== "dark") throw new Error("expected light or dark");
if (process.env.APP_GUI !== "1") throw new Error("APP_GUI=1 is required");
assertAtspiBridgeEnabled(process.env);
const FIRST = "A unique sentence before accepting outside words.";
const OUTSIDE = [
  "An outside revision changed the first scene.\nIts ending now belongs to another draft.",
  "A second outside revision must remain accepted.\nUndoing its neighbor must leave these words alone.",
];
type Doc = { item_id: string; title: string; body: string; rev: number };
type Entry = { id: string; path: string };
function docs(project: string): Doc[] {
  const db = new Database(project, { readonly: true });
  try {
    return db.query("SELECT d.item_id, i.title, d.body, d.rev FROM doc d JOIN item i ON i.id = d.item_id").all() as Doc[];
  } finally { db.close(); }
}
function manifest(root: string): { dir: string; entries: Entry[] } {
  const found: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "manifest.json") found.push(path);
    }
  }
  walk(root);
  if (found.length !== 1) throw new Error("expected exactly one mirror manifest");
  return { dir: dirname(found[0]!), entries: JSON.parse(readFileSync(found[0]!, "utf8")).entries };
}
function xdo(display: string, args: string[]): string {
  const run = Bun.spawnSync(["xdotool", ...args], { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}
function focus(display: string): string {
  const wid = findWindowId(display);
  xdo(display, ["windowfocus", wid]);
  if (xdo(display, ["getwindowfocus"]) !== wid) throw new Error("window focus failed");
  return wid;
}
function press(display: string, wid: string, rootPid: number, selector: PressSelector): boolean {
  const nodes = locateNodes(rootPid);
  // A missing application control is a failing behavior, not a lost result.
  if (!nodes.some((node) => (selector.by === "id" ? node.id : node.name) === selector.value)) return false;
  const node = nodeToPress(nodes, selector, "mirror-undo");
  const at = pressPoint(node, parseGeometry(xdo(display, ["getwindowgeometry", "--shell", wid])));
  xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
  xdo(display, ["click", "1"]);
  return true;
}
async function until(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (check()) return true;
    await Bun.sleep(250);
  }
  return check();
}
function gate(name: string, passed: boolean, threshold: string): GateResult {
  return { gate: name, value: passed ? "observed" : "not observed", threshold, verdict: passed ? "PASS" : "FAIL" };
}
function mirrorMatches(path: string, expected: string): boolean {
  try {
    return readFileSync(path, "utf8") === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const work = mkdtempSync(join(tmpdir(), "mirror-undo-"));
try {
  const project = join(work, "project.db");
  const data = join(work, "data");
  const mirror = join(work, "mirror");
  mkdirSync(join(data, "cc.local.app"), { recursive: true });
  mkdirSync(mirror);
  const seeded = Bun.spawnSync([BIN, "--seed", "lab/fixtures/out/tiny", project], { stdout: "inherit", stderr: "inherit" });
  if (seeded.exitCode !== 0) throw new Error("seed failed");
  writeFileSync(join(data, "cc.local.app", "settings.json"), JSON.stringify({ theme, language: "en", mirrored_book_ids: [readBookId(project)] }));
  const env = { APP_RUN: "interactive", APP_PROJECT: project, APP_MIRROR_DIR: mirror, XDG_DATA_HOME: data, GDK_BACKEND: "x11" };
  const first = await runShell({
    mode: "virtual", soakMs: 0, staged: "app/ui/dist", env, probeA11y: false,
    onReady: async ({ displayNum }) => {
      if (displayNum === null) throw new Error("isolated display missing");
      const display = `:${displayNum}`;
      const wid = focus(display);
      await Bun.sleep(4000);
      xdo(display, ["mousemove", "--window", wid, "700", "500"]);
      xdo(display, ["click", "1"]);
      xdo(display, ["type", "--window", wid, "--delay", "40", FIRST]);
      await Bun.sleep(16_000);
      if (!docs(project).some((doc) => doc.body.includes(FIRST))) throw new Error("first typing did not land");
    },
  });
  const before = docs(project);
  const target = before.find((doc) => doc.body.includes(FIRST))!;
  const written = manifest(mirror);
  const targetEntry = written.entries.find((entry) => entry.id === target.item_id);
  const otherEntry = written.entries.find((entry) => entry.id !== target.item_id && before.some((doc) => doc.item_id === entry.id));
  if (!targetEntry || !otherEntry) throw new Error("fixture needs two mirrored documents");
  const targetPath = join(written.dir, targetEntry.path);
  const originalFile = readFileSync(targetPath, "utf8");
  [targetEntry, otherEntry].forEach((entry, index) => {
    const path = join(written.dir, entry.path);
    const lines = readFileSync(path, "utf8").split("\n");
    const heading = lines.findIndex((line) => line.startsWith("# "));
    if (heading < 0) throw new Error("mirror heading missing");
    const revised = `${lines.slice(0, heading + 1).join("\n")}\n\n${OUTSIDE[index]}\n`;
    if (revised === readFileSync(path, "utf8")) throw new Error("outside edit is vacuous");
    writeFileSync(path, revised);
  });
  let verdicts: GateResult[] = [];
  const second = await runShell({
    mode: "virtual", soakMs: 0, staged: "app/ui/dist", env, probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("isolated display missing");
      const display = `:${displayNum}`;
      const wid = focus(display);
      await Bun.sleep(6000);
      await menuDriver(display, wid, xdo).activate("menu-mirror-changes");
      await Bun.sleep(1500);
      const batchPressed = press(display, wid, rootPid, { by: "id", value: "mirror-changes-accept-all" });
      const accepted = batchPressed && await until(() => {
        const rows = docs(project);
        return [targetEntry, otherEntry].every((entry, index) => rows.find((doc) => doc.item_id === entry.id)?.body.includes(OUTSIDE[index]!.split("\n")[0]!));
      });
      const afterAccept = docs(project);
      verdicts.push(gate("batch_accepts_both_documents", accepted, "both outside bodies committed before undo"));
      await Bun.sleep(1500);
      const out = `app/results/screenshots/151-mirror-undo-${theme}-tiny.png`;
      mkdirSync(dirname(out), { recursive: true });
      const capture = Bun.spawnSync(["import", "-window", wid, out], { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
      if (capture.exitCode !== 0) throw new Error("undo screenshot failed");
      if (accepted) {
        press(display, wid, rootPid, { by: "name", value: `Undo taking the words into ${target.title}` });
        await until(() => docs(project).find((doc) => doc.item_id === target.item_id)?.body === target.body);
      }
      const afterUndo = docs(project);
      const restored = afterUndo.find((doc) => doc.item_id === target.item_id);
      const acceptedTarget = afterAccept.find((doc) => doc.item_id === target.item_id)!;
      verdicts.push(gate("undo_restores_selected_document", accepted && restored?.body === target.body && restored.rev === acceptedTarget.rev + 1, "selected document returns to its exact preaccept body at the next revision"));
      verdicts.push(gate("undo_preserves_other_documents", accepted && afterAccept.filter((doc) => doc.item_id !== target.item_id).every((doc) => {
        const after = afterUndo.find((row) => row.item_id === doc.item_id);
        return after?.body === doc.body && after.rev === doc.rev;
      }), "every other document keeps its postaccept body and revision"));
      const db = new Database(project, { readonly: true });
      try {
        const history = db.query("SELECT b.body FROM doc_version v JOIN blob b ON b.key = v.blob_key WHERE v.item_id = ?").all(target.item_id) as { body: string }[];
        verdicts.push(gate("undo_preserves_accepted_history", accepted && history.some((row) => row.body === acceptedTarget.body), "accepted words remain in durable document history"));
      } finally { db.close(); }
      await Bun.sleep(16_000);
      verdicts.push(gate("undo_reaches_readable_mirror", accepted && mirrorMatches(targetPath, originalFile), "normal outbound pass writes the exact original readable document"));
    },
  });
  const git = Bun.spawnSync(["/usr/bin/git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error("cannot identify rig revision");
  const result = buildResult({
    runId: `app-mirror-undo-tiny-${theme}`, candidate: "tauri", fixture: "tiny", workload: "app-mirror",
    verdicts, metrics: { launches: 2, renderers: [first.renderer, second.renderer] }, seed: "app-v1",
    rigCommit: git.stdout.toString().trim(), environment: captureEnv(),
  });
  result.method = "Two owned isolated Linux launches; real panel batch accept and per-document undo, checked against SQLite and readable mirror bytes. Screenshot before undo. No working-memory or performance measurement.";
  console.log(writeResult(result, "app/results"));
  if (verdicts.some((row) => row.verdict !== "PASS")) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
