// Captures the unresolved legacy-protection notice and paths through human startup.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pidListArg } from "./atspi";
import { menuDriver } from "./menu-drive";
import { PY_PROJECT_PANEL_WALK, parsePanelA11yWalk, projectPanelProjection, type PanelA11yNode, type PanelA11yWalk } from "./project-panel-a11y";
import { BIN, assertAtspiBridgeEnabled, findWindowId, runShell } from "./shell";

const theme = process.argv[2];
if (theme !== "light" && theme !== "dark") throw new Error("usage: APP_GUI=1 bun app/harness/src/legacy-protection-shot.ts <light|dark>");
if (process.env.APP_GUI !== "1") throw new Error("APP_GUI=1 is required");
if (process.env.APP_PROJECT !== undefined) throw new Error("unset APP_PROJECT for the human startup path");
assertAtspiBridgeEnabled(process.env);

function xdo(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`xdotool ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

function seed(path: string): void {
  const proc = Bun.spawnSync([BIN, "--seed", "lab/fixtures/out/tiny", path], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`seed failed: ${proc.stderr.toString().trim()}`);
}

function makeV10(path: string): void {
  const db = new Database(path);
  try {
    db.run("DELETE FROM meta WHERE key IN ('book_id', 'book_identity_origin')");
    db.run("PRAGMA user_version = 10");
  } finally { db.close(); }
}

function values(nodes: readonly PanelA11yNode[]): string[] {
  return nodes.flatMap((node) => [node.name, node.text ?? ""]).filter((value) => value.length > 0);
}

function legacyVisible(walk: PanelA11yWalk, heading: string, path: string): boolean {
  const exposed = values(projectPanelProjection(walk).nodes.filter((node) =>
    node.states.includes("showing") && node.states.includes("visible")));
  return exposed.includes(heading) && path.length > 0 && exposed.includes(path);
}

const work = mkdtempSync(join(tmpdir(), "legacy-protection-"));
const data = join(work, "data");
const app = join(data, "cc.local.app");
const primary = join(app, "projects", "legacy.db");
const competitor = join(work, "competitor", "legacy.db");
const recovery = join(app, "recovery", "legacy");
const mirror = join(app, "mirror", "legacy");
const locale = theme === "dark" ? "de" : "en";
const recoveryHeading = locale === "de" ? "Älterer Wiederherstellungsordner zur Prüfung" : "Older recovery folder to inspect";
const mirrorHeading = locale === "de" ? "Älterer lesbarer Ordner zur Prüfung" : "Older readable folder to inspect";
const notice = locale === "de"
  ? "Ältere Wiederherstellungsordner oder lesbare Ordner konnten diesem Buch nicht zugeordnet werden. Öffnen Sie das Projektfenster, um ihre Speicherorte zu prüfen."
  : "Older recovery or readable folders could not be linked to this book. Open the project panel to inspect their locations.";
const screenshot = `app/results/screenshots/156-legacy-protection-${theme}.png`;

try {
  mkdirSync(dirname(primary), { recursive: true });
  mkdirSync(dirname(competitor), { recursive: true });
  mkdirSync(recovery, { recursive: true });
  mkdirSync(mirror, { recursive: true });
  seed(primary);
  seed(competitor);
  makeV10(primary);
  writeFileSync(join(app, "settings.json"), JSON.stringify({ theme, locale, start: "last", last_project: primary, books: [competitor] }));
  await runShell({
    mode: "virtual", soakMs: 0, staged: "app/ui/dist", probeA11y: false,
    env: { APP_RUN: "interactive", XDG_DATA_HOME: data, GDK_BACKEND: "x11" },
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("isolated display missing");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      xdo(display, ["windowfocus", wid]);
      if (xdo(display, ["getwindowfocus"]) !== wid) throw new Error("window focus failed");
      await menuDriver(display, wid, xdo, "app/ui/src/menu-bar.ts", `app/ui/src/i18n/${locale}.ts`).activate("menu-project-open");
      await Bun.sleep(1000);
      function capture(suffix: string): PanelA11yWalk {
        const probe = Bun.spawnSync(["python3", "-c", PY_PROJECT_PANEL_WALK, pidListArg(rootPid)], { stdout: "pipe", stderr: "pipe" });
        if (probe.exitCode !== 0) throw new Error(`AT-SPI walk failed: ${probe.stderr.toString().trim()}`);
        const walk = parsePanelA11yWalk(probe.stdout.toString());
        const target = screenshot.replace(".png", `${suffix}.png`);
        mkdirSync(dirname(target), { recursive: true });
        const shot = Bun.spawnSync(["import", "-window", wid, target], { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
        if (shot.exitCode !== 0) throw new Error(`screenshot failed: ${shot.stderr.toString().trim()}`);
        return walk;
      }
      const upper = capture("");
      if (!legacyVisible(upper, recoveryHeading, recovery) || !values(upper.nodes).includes(notice)) {
        console.error(JSON.stringify(upper));
        throw new Error("legacy recovery path, heading, and startup notice were not visibly exposed");
      }
      // Scroll inside the panel through real input so its lower controls are reachable.
      xdo(display, ["mousemove", "100", "200", "click", "--repeat", "12", "--delay", "40", "5"]);
      await Bun.sleep(500);
      const lower = capture("-scrolled");
      if (!legacyVisible(lower, mirrorHeading, mirror)) {
        console.error(JSON.stringify(lower));
        throw new Error("legacy mirror path and heading were not visibly exposed after scrolling");
      }
    },
  });
  console.log(`captured: ${screenshot}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
