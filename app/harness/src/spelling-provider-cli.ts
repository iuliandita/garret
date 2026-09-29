// Read-only provider observation after typing into an isolated temporary book.
// APP_GUI=1 NO_AT_BRIDGE=0 bun app/harness/src/spelling-provider-cli.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pidListArg, PY_SELECT_APPS } from "./atspi";
import { BIN, assertAtspiBridgeEnabled, findWindowId, runShell, survivingShellPids } from "./shell";

const SENTENCE = "Spelling probe: mispelinggg qqqzzxx elephant.";
const PY = String.raw`
import json, sys, pyatspi
${PY_SELECT_APPS}
if len(matched) != 1:
    raise RuntimeError("expected one attributed application")
rows = []
errors = []
def walk(node):
    try:
        interfaces = node.get_interfaces()
        if any(i == "Text" or i.endswith(".Text") for i in interfaces):
            text = node.queryText()
            value = text.getText(0, -1) or ""
            if "mispelinggg" in value:
                start = value.index("mispelinggg")
                runs = []
                for offset in range(start, min(len(value), start + 35)):
                    attributes, first, last = text.getAttributeRun(offset, True)
                    run = {"attributes": attributes, "start": first, "end": last}
                    if run not in runs:
                        runs.append(run)
                rows.append({"role": node.getRoleName(), "text": value, "runs": runs})
        for child in node:
            walk(child)
    except Exception as error:
        errors.append(type(error).__name__ + ": " + str(error))
walk(matched[0])
print(json.dumps({"nodes": rows, "errors": errors}))
if not rows or errors:
    sys.exit(5)
`;

if (process.env.APP_GUI !== "1") throw new Error("APP_GUI=1 required");
assertAtspiBridgeEnabled(process.env);
if (survivingShellPids().length) throw new Error("another app shell is running");
const work = mkdtempSync(join(tmpdir(), "spelling-provider-"));
const home = join(work, "home");
const project = join(work, "probe.db");
function command(args: string[], display?: string): string {
  const child = Bun.spawnSync(args, { env: { ...process.env, ...(display ? { DISPLAY: display } : {}) }, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`${args[0]} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}
try {
  mkdirSync(join(home, "cc.local.app"), { recursive: true });
  writeFileSync(join(home, "cc.local.app", "settings.json"), JSON.stringify({ theme: "light", locale: "en" }));
  command([BIN, "--seed", "lab/fixtures/out/tiny", project]);
  let observation: unknown;
  const outcome = await runShell({
    mode: "virtual", soakMs: 0, staged: "app/ui/dist", probeA11y: false,
    env: { APP_RUN: "interactive", APP_PROJECT: project, XDG_DATA_HOME: home, GDK_BACKEND: "x11" },
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("virtual display unavailable");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      command(["xdotool", "windowfocus", wid], display);
      command(["xdotool", "key", "--window", wid, "ctrl+End", "Return"], display);
      command(["xdotool", "type", "--window", wid, "--delay", "30", SENTENCE], display);
      command(["xdotool", "key", "--window", wid, "Return"], display);
      await Bun.sleep(2000);
      observation = JSON.parse(command(["python3", "-c", PY, pidListArg(rootPid)]));
      command(["import", "-window", wid, "app/results/screenshots/194-spelling-provider.png"], display);
    },
  });
  if (observation === undefined) throw new Error("provider observation was not captured");
  const result = {
    scope: "One isolated Linux WebKitGTK provider observation. No Learn Spelling action, real IME, speech or screen-reader user certification.",
    source: command(["git", "rev-parse", "HEAD"]),
    environment: { renderer: outcome.renderer, webkitgtk: command(["pkg-config", "--modversion", "webkit2gtk-4.1"]) },
    sentence: SENTENCE, observation,
  };
  writeFileSync("app/results/194-spelling-provider.json", JSON.stringify(result, null, 2) + "\n");
} finally { rmSync(work, { recursive: true, force: true }); }
