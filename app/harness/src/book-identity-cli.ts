// Copied-book choices through the real native window; SQLite and settings are the oracle.
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBookId } from "./book-id";
import { captureEnv } from "./env";
import type { GateResult } from "./gates";
import { locateNodes } from "./nodes";
import { buildResult, writeResult } from "./results";
import { BIN, assertAtspiBridgeEnabled, findWindowId, runShell } from "./shell";

const theme = process.argv[2] ?? "light";
if (theme !== "light" && theme !== "dark") throw new Error("expected light or dark");
if (process.env.APP_GUI !== "1") throw new Error("APP_GUI=1 is required");
if (process.env.APP_PROJECT !== undefined) throw new Error("unset APP_PROJECT for the human startup path");
assertAtspiBridgeEnabled(process.env);

function xdo(display: string, args: string[]): string {
  const run = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

function manuscript(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return JSON.stringify({
      items: db.query("SELECT * FROM item ORDER BY id").all(),
      documents: db.query("SELECT * FROM doc ORDER BY item_id").all(),
      versions: db.query("SELECT * FROM doc_version ORDER BY id").all(),
      snapshots: db.query("SELECT * FROM snapshot ORDER BY id").all(),
    });
  } finally { db.close(); }
}

function gate(name: string, passed: boolean, threshold: string): GateResult {
  return { gate: name, value: passed ? "observed" : "not observed", threshold, verdict: passed ? "PASS" : "FAIL" };
}

const work = mkdtempSync(join(tmpdir(), "book-identity-"));
const verdicts: GateResult[] = [];
const renderers = [];
try {
  for (const choice of ["cancel", "same", "separate"] as const) {
    const data = join(work, choice, "data");
    const library = join(data, "cc.local.app", "projects");
    mkdirSync(library, { recursive: true });
    const original = join(library, "original.db");
    const copy = join(library, "copy.db");
    const seeded = Bun.spawnSync([BIN, "--seed", "lab/fixtures/out/tiny", original], { stdout: "inherit", stderr: "inherit" });
    if (seeded.exitCode !== 0) throw new Error("seed failed");
    copyFileSync(original, copy);
    const id = readBookId(original);
    const before = manuscript(original);
    if (manuscript(copy) !== before) throw new Error("copy fixture differs before the choice");
    const settingsPath = join(data, "cc.local.app", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      theme, locale: theme === "dark" ? "de" : "en", start: "last",
      last_project: copy, book_locations: [{ book_id: id, path: original }],
    }));
    let promptSeen = false;
    let promptDismissed = false;
    const launch = await runShell({
      mode: "virtual", soakMs: 0, staged: "app/ui/dist", probeA11y: false,
      env: { APP_RUN: "interactive", XDG_DATA_HOME: data, GDK_BACKEND: "x11" },
      onReady: async ({ displayNum, rootPid }) => {
        if (displayNum === null) throw new Error("isolated display missing");
        const display = `:${displayNum}`;
        const wid = findWindowId(display);
        xdo(display, ["windowfocus", wid]);
        if (xdo(display, ["getwindowfocus"]) !== wid) throw new Error("window focus failed");
        await Bun.sleep(1000);
        const nodes = locateNodes(rootPid);
        promptSeen = ["cancel", "same", "separate"].every((kind) =>
          nodes.some((node) => node.id === `book-copy-${kind}` && node.w > 0 && node.h > 0));
        if (choice === "cancel") {
          mkdirSync("app/results/screenshots", { recursive: true });
          const capture = Bun.spawnSync(["import", "-window", wid, `app/results/screenshots/156-book-copy-${theme}.png`], {
            env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe",
          });
          if (capture.exitCode !== 0) throw new Error("copy-choice screenshot failed");
        }
        // Initial focus is Cancel; native Tab/Return also verifies the real keyboard route.
        if (promptSeen) {
          if (choice !== "cancel") xdo(display, ["key", "Tab"]);
          if (choice === "separate") xdo(display, ["key", "Tab"]);
          xdo(display, ["key", "Return"]);
          await Bun.sleep(1500);
          promptDismissed = !locateNodes(rootPid).some((node) => node.id === "book-copy-cancel" && node.w > 0 && node.h > 0);
        }
      },
    });
    renderers.push(launch.renderer);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      book_locations: { book_id: string; path: string }[];
    };
    const copyId = readBookId(copy);
    const canonical = (bookId: string): string | undefined => settings.book_locations.find((row) => row.book_id === bookId)?.path;
    verdicts.push(gate(`${choice}_prompt_and_keyboard`, promptSeen && promptDismissed, "copied-book prompt appears and the keyboard choice dismisses it"));
    verdicts.push(gate(`${choice}_keeps_manuscripts`, manuscript(original) === before && manuscript(copy) === before, "both manuscripts, versions and snapshots remain unchanged"));
    verdicts.push(gate(`${choice}_identity`, readBookId(original) === id && (choice === "separate" ? copyId !== id : copyId === id), "only Separate gives the copied file a new identity"));
    verdicts.push(gate(`${choice}_canonical_location`, choice === "same" ? canonical(id) === copy
      : choice === "separate" ? canonical(id) === original && canonical(copyId) === copy
      : canonical(id) === original, "Cancel preserves the registry; Same selects the copy; Separate records both identities"));
  }
  const git = Bun.spawnSync(["/usr/bin/git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error("cannot identify rig revision");
  const result = buildResult({
    runId: `app-book-identity-tiny-${theme}`, candidate: "tauri", fixture: "tiny", workload: "app-project",
    verdicts, metrics: { launches: renderers.length, renderers }, seed: "app-v1",
    rigCommit: git.stdout.toString().trim(), environment: captureEnv(),
  });
  result.method = "Three isolated native launches through human startup, with copied SQLite files. Real Tab/Return choices; independent manuscript and canonical registry reads. English light or German dark screenshot. No timing claim.";
  console.log(writeResult(result, "app/results"));
  if (verdicts.some((row) => row.verdict !== "PASS")) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
