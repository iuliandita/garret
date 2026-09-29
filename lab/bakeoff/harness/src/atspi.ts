// lab/bakeoff/harness/src/atspi.ts
// AT-SPI accessibility-tree probe. Shells out to python3 + pyatspi to dump the
// running app's a11y tree (role<TAB>name<TAB>states per line), then classifies
// exposure. Gated: any failure (no python, no pyatspi, no bus) => available:
// false, which maps to an UNKNOWN gate, never a silent PASS.
import type { A11yProbe } from "./gates";

const PY_DUMP = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
target = sys.argv[1] if len(sys.argv) > 1 else "bakeoff"
def walk(node, out):
    try:
        role = node.getRoleName()
        name = node.name or ""
        try:
            states = ",".join(s.value_nick for s in node.getState().get_states())
        except Exception:
            states = ""
        out.append(role + "\t" + name + "\t" + states)
        for i in range(node.childCount):
            walk(node.getChildAtIndex(i), out)
    except Exception:
        pass
desktop = pyatspi.Registry.getDesktop(0)
out = []
for app in desktop:
    try:
        if target.lower() in (app.name or "").lower():
            walk(app, out)
    except Exception:
        pass
sys.stdout.write("\n".join(out))
`;

export function parseAtspiDump(dump: string): A11yProbe {
  const lines = dump.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { available: false, hasEditor: false, hasNavigator: false, hasDialog: false };
  }
  const roles: string[] = [];
  let hasEditor = false;
  let hasNavigator = false;
  let hasDialog = false;
  for (const line of lines) {
    const [role = "", name = ""] = line.split("\t");
    roles.push(role);
    const r = role.toLowerCase();
    const n = name.toLowerCase();
    if (r.includes("document") || r.includes("text") || r.includes("entry")) hasEditor = true;
    if (n.includes("navigator") || r === "list") hasNavigator = true;
    if (r.includes("dialog")) hasDialog = true;
  }
  return { available: true, hasEditor, hasNavigator, hasDialog, roles };
}

// Live probe (gated). Returns available:false on any failure.
export function probeAtspi(appNameMatch: string): A11yProbe {
  try {
    const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, appNameMatch], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      return { available: false, hasEditor: false, hasNavigator: false, hasDialog: false };
    }
    return parseAtspiDump(proc.stdout.toString());
  } catch {
    return { available: false, hasEditor: false, hasNavigator: false, hasDialog: false };
  }
}
