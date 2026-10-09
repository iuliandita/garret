// One fresh boot and one complete, attributed AT-SPI walk of the project panel.
// Usage: APP_GUI=1 bun app/harness/src/project-panel-a11y-cli.ts <light|dark> [result.json] [screenshot.png]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pidListArg } from "./atspi";
import { captureEnv } from "./env";
import { menuDriver } from "./menu-drive";
import { centreOf, locateNodes } from "./nodes";
import { PY_PROJECT_PANEL_WALK, evaluateProjectPanelA11y, parsePanelA11yWalk, projectPanelProjection, redactPanelA11yWalk, type PanelA11yWalk } from "./project-panel-a11y";
import { buildResult, writeResult } from "./results";
import { BIN, assertAtspiBridgeEnabled, findWindowId, runShell, survivingShellPids } from "./shell";

const theme = process.argv[2];
if (theme !== "light" && theme !== "dark") throw new Error('usage: <light|dark> [result.json] [screenshot.png]');
if (process.env.APP_GUI !== "1") throw new Error("APP_GUI=1 is required; no result was written");
assertAtspiBridgeEnabled(process.env);
if (survivingShellPids().length > 0) throw new Error("an app shell is already running; isolated attribution is required");
const resultOverride = process.argv[3];
const screenshot = process.argv[4] ?? `app/results/screenshots/129-project-panel-${theme}.png`;
const work = mkdtempSync(join(tmpdir(), "project-panel-a11y-"));
const home = join(work, "private-home");
const fixture = "pride-and-prejudice";
const project = join(work, `${fixture}.db`);
const imports = join(work, "imports");
const pendingImport = "Pride and Prejudice excerpt.md";
let walk: PanelA11yWalk | null = null;

// Open the copies disclosure; pending imports open their section automatically.
const DISCLOSURES = ["project-copies-toggle", "project-import-toggle"] as const;
const TALL_SERVER_ARGS = "-screen 0 1600x1200x24 -s 0 -noreset";
const TALL_W = 1200;
const TALL_H = 1150;

function xdo(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}
function gitShortSha(): string { return Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" }).stdout.toString().trim(); }

try {
  mkdirSync(join(home, "garret"), { recursive: true });
  writeFileSync(join(home, "garret", "settings.json"), JSON.stringify({ theme, books: [project] }));
  mkdirSync(imports);
  writeFileSync(join(imports, pendingImport), "# Pride and Prejudice\n\n## Chapter I\n\nIt is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.\n");
  const seed = Bun.spawnSync([BIN, "--seed", `app/fixtures/classics/${fixture}`, project], { stdout: "pipe", stderr: "pipe" });
  if (seed.exitCode !== 0) throw new Error(`classic seed failed: ${seed.stderr.toString().trim()}`);
  const outcome = await runShell<{ ready: boolean; error?: string }>({
    mode: "virtual", soakMs: 0, staged: "app/ui/dist", probeA11y: false, serverArgs: TALL_SERVER_ARGS,
    env: { APP_RUN: "interactive", APP_PROJECT: project, XDG_DATA_HOME: home, APP_IMPORT_DIR: imports, GDK_BACKEND: "x11" },
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("project-panel accessibility rig requires a fixed display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowsize", wid, String(TALL_W), String(TALL_H)]);
      await Bun.sleep(1500);
      const seen = /Geometry: (\d+)x(\d+)/.exec(xdo(display, ["getwindowgeometry", wid]));
      if (seen === null || Number(seen[2]) < TALL_H - 40) throw new Error(`the window did not take the resize to ${TALL_W}x${TALL_H}`);
      xdo(display, ["windowfocus", wid]);
      if (xdo(display, ["getwindowfocus"]) !== wid) throw new Error("shell window did not receive focus");
      await menuDriver(display, wid, xdo).activate("menu-project-open");
      await Bun.sleep(1000);
      const located = locateNodes(rootPid);
      const toggles = DISCLOSURES.filter((id) => id !== "project-import-toggle" || !located.some((n) => n.name === pendingImport && n.role === "button")).map((id) => {
        const found = located.filter((n) => n.id === id);
        if (found.length !== 1) throw new Error(`expected one #${id} to open before the walk, found ${found.length}`);
        return found[0]!;
      });
      for (const toggle of toggles) {
        const at = centreOf(toggle);
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(600);
      }
      // Off the panel, so no hover state is in the screenshot.
      xdo(display, ["mousemove", "--window", wid, String(TALL_W - 20), String(TALL_H - 60)]);
      await Bun.sleep(400);
      const probe = Bun.spawnSync(["python3", "-c", PY_PROJECT_PANEL_WALK, pidListArg(rootPid)], { stdout: "pipe", stderr: "pipe" });
      if (probe.exitCode !== 0) throw new Error(`complete AT-SPI walk failed (exit ${probe.exitCode}): ${probe.stderr.toString().trim()}`);
      walk = parsePanelA11yWalk(probe.stdout.toString());
      mkdirSync(dirname(screenshot), { recursive: true });
      const shot = Bun.spawnSync(["import", "-window", wid, screenshot], { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
      if (shot.exitCode !== 0) throw new Error(`same-boot screenshot failed: ${shot.stderr.toString().trim()}`);
    },
  });
  if (walk === null) throw new Error("AT-SPI walk was never captured");
  const projection = projectPanelProjection(walk);
  for (const name of ["Pride and Prejudice", pendingImport]) {
    if (projection.nodes.filter((n) => n.role === "button" && n.name === name).length !== 1) {
      throw new Error(`the populated fixture did not expose exactly one action for ${name}; no result was written`);
    }
  }
  const verdicts = evaluateProjectPanelA11y(walk);
  const record = buildResult({
    workload: "app-diagnostic", runId: `app-project-panel-a11y-${theme}`, candidate: "tauri", fixture, verdicts,
    metrics: { theme, renderer: outcome.renderer, panel_walk: redactPanelA11yWalk(projection, work, homedir()), screenshot: basename(screenshot), scope: "One fresh boot at 1200x1150, one complete attributed AT-SPI walk after the real File > Open book route, opening Backups and archives and preserving the automatically expanded pending import section. A registered Pride and Prejudice book and a real Markdown import exercise action-bearing rows. Recovery and archive lists are genuinely empty. Accessible descriptions are read from each node; queryText is null only where the Text interface is unavailable.", omitted_gates: "latency, stall, cliff and a11y_exposure: this is a bounded platform-semantics measurement." },
    seed: fixture, rigCommit: gitShortSha(), environment: captureEnv(),
  });
  const targetDir = resultOverride === undefined ? "app/results" : dirname(resultOverride);
  const written = writeResult({ ...record, run_id: resultOverride === undefined ? record.run_id : resultOverride.split("/").at(-1)!.replace(/\.json$/, "") }, targetDir);
  console.log(`recorded: ${written}`);
  for (const result of verdicts) console.log(`${result.verdict} ${result.gate}: ${result.value}`);
  if (verdicts.some((result) => result.verdict !== "PASS")) process.exitCode = 1;
} finally { rmSync(work, { recursive: true, force: true }); }
