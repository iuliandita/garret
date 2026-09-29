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
const project = join(work, "tiny.db");
let walk: PanelA11yWalk | null = null;

// SINCE 240 THE PANEL OPENS FOLDED: the empty import folder and Backups and
// archives are disclosures, closed on a fresh book. The gates grade the
// controls INSIDE them, so the rig opens both, the way a writer would, before
// the walk it grades. Copies first: it is the lower of the two, so opening
// it moves nothing the second click aims at. And a TALLER window, because
// with both open the panel's body runs past an 800px window, and a control
// scrolled out of the body is not "showing" -- the gates' fold failure that
// 238 recorded. The gates themselves are unchanged.
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
  mkdirSync(join(home, "cc.local.app"), { recursive: true });
  writeFileSync(join(home, "cc.local.app", "settings.json"), JSON.stringify({ theme }));
  const seed = Bun.spawnSync([BIN, "--seed", "lab/fixtures/out/tiny", project], { stdout: "pipe", stderr: "pipe" });
  if (seed.exitCode !== 0) throw new Error(`tiny seed failed: ${seed.stderr.toString().trim()}`);
  const outcome = await runShell<{ ready: boolean; error?: string }>({
    mode: "virtual", soakMs: 0, staged: "app/ui/dist", probeA11y: false, serverArgs: TALL_SERVER_ARGS,
    env: { APP_RUN: "interactive", APP_PROJECT: project, XDG_DATA_HOME: home, GDK_BACKEND: "x11" },
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
      const toggles = DISCLOSURES.map((id) => {
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
  const verdicts = evaluateProjectPanelA11y(walk);
  const record = buildResult({
    workload: "app-diagnostic", runId: `app-project-panel-a11y-${theme}`, candidate: "tauri", fixture: "tiny", verdicts,
    metrics: { theme, renderer: outcome.renderer, panel_walk: redactPanelA11yWalk(projectPanelProjection(walk), work, homedir()), screenshot: basename(screenshot), scope: "One fresh boot at 1200x1150, one complete attributed AT-SPI walk after the real File > Open project route and pressing its two disclosures (Backups and archives, the import folder) open. queryText is null only where the Text interface is unavailable.", omitted_gates: "latency, stall, cliff and a11y_exposure: this is a bounded platform-semantics measurement." },
    seed: "tiny", rigCommit: gitShortSha(), environment: captureEnv(),
  });
  const targetDir = resultOverride === undefined ? "app/results" : dirname(resultOverride);
  const written = writeResult({ ...record, run_id: resultOverride === undefined ? record.run_id : resultOverride.split("/").at(-1)!.replace(/\.json$/, "") }, targetDir);
  console.log(`recorded: ${written}`);
  for (const result of verdicts) console.log(`${result.verdict} ${result.gate}: ${result.value}`);
  if (verdicts.some((result) => result.verdict !== "PASS")) process.exitCode = 1;
} finally { rmSync(work, { recursive: true, force: true }); }
