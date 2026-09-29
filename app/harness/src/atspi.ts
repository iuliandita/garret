// app/harness/src/atspi.ts
// AT-SPI probe. Emits role<TAB>name<TAB>states<TAB>childCount<TAB>attrs per node
// and reports how many rows the navigator ADVERTISES (aria-setsize) versus how
// many are mounted. The distinction is the point: a windowed list mounts a
// handful of rows and must still tell assistive technology the truth about the
// whole set. The scaffold's boolean "is there a list" would have passed a
// navigator exposing 1500 of 15200.
//
// Any failure (no python, no pyatspi, no bus) => available:false, which maps to
// an UNKNOWN gate, never a silent PASS.
import type { A11yProbe } from "./gates";
import { treePids } from "./rss";

export function unavailable(): A11yProbe {
  return { available: false, hasNavigator: false, exposedRows: 0, mountedRows: 0, treeRows: [] };
}

/** Python, spliced into every desktop walk: binds `matched` to the
 *  applications whose process is one of the pids in `sys.argv[1]`
 *  (comma-separated). `get_process_id()` is answered by the bus daemon, so
 *  a registrant that has stopped answering (the hung portal of 2026-09-03)
 *  costs nothing; reading `.name` was a call into each application and
 *  paid that registrant's D-Bus timeout on every walk. Expects `sys` and
 *  `pyatspi` imported. */
export const PY_SELECT_APPS = String.raw`
pids = {int(p) for p in sys.argv[1].split(",") if p}
desktop = pyatspi.Registry.getDesktop(0)
matched = []
for i in range(desktop.childCount):
    try:
        app = desktop.getChildAtIndex(i)
        if app.get_process_id() in pids:
            matched.append(app)
    except Exception:
        pass
`;

/** The argv the prelude reads: the spawn and everything under it, so the
 *  caller need not know that the registrant is the shell and the spawn is
 *  xvfb-run. Throws on an empty tree rather than handing python an empty
 *  set: an empty set matches nothing and reads as "the application is
 *  gone", which is a different problem. */
export function pidListArg(rootPid: number): string {
  const pids = treePids(rootPid);
  if (pids.length === 0) throw new Error(`no process tree under pid ${rootPid}: the shell is gone`);
  return pids.join(",");
}

export const PY_DUMP = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

def attrs(node):
    try:
        return ";".join(node.getAttributes())
    except Exception:
        return ""

def walk(node, out):
    try:
        role = node.getRoleName()
        name = node.name or ""
        try:
            states = ",".join(s.value_nick for s in node.getState().get_states())
        except Exception:
            states = ""
        n = node.childCount
        out.append("\t".join([role, name, states, str(n), attrs(node)]))
        for i in range(n):
            walk(node.getChildAtIndex(i), out)
    except Exception:
        pass

${PY_SELECT_APPS}
out = ["#apps\t" + str(len(matched))]
for app in matched:
    walk(app, out)
sys.stdout.write("\n".join(out))
`;

// "list item" / "list box" confirmed live against a real WebKitGTK tree for
// role="option" / role="listbox" DOM elements; "tree" / "tree item" confirmed
// live for role="tree" / role="treeitem" once the ownership chain was intact.
// The other aliases are kept as defensive fallbacks for toolkit/version drift,
// unverified. The list roles stay so prior-slice dumps remain readable.
//
// Matching is on the ATK role ONLY, never on the `xml-roles` attribute, and
// that is deliberate. `xml-roles` echoes the DOM's role attribute whether or not
// the platform accepted it: the run that exposed 36 rows as ATK `section` with
// `computed-role:generic` carried `xml-roles:treeitem` on every one of them. An
// xml-roles fallback would have counted those as tree rows and passed the gate
// while a real screen reader saw an unnamed generic list. The gate exists to
// catch exactly that, so the attribute must stay diagnostic, not authoritative.
const TREE_ROW_ROLES = new Set(["tree item", "treeitem"]);
const ROW_ROLES = new Set([
  "list item",
  "list box option",
  "option",
  "listitem",
  ...TREE_ROW_ROLES,
]);
const NAV_ROLES = new Set(["list box", "listbox", "list", "tree", "tree table"]);

// pyatspi's getAttributes() returns "key:value" strings (colon, not "="),
// observed live against WebKitGTK: "posinset:1;computed-role:option;
// toolkit:WebKitGTK;xml-roles:option;id:nav-row-0;setsize:15200;tag:div".
function parseAttrs(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(";")) {
    const colon = pair.indexOf(":");
    if (colon > 0) map.set(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim());
  }
  return map;
}

function num(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// The header line ("#apps<TAB>N") tells the parser how many AT-SPI apps
// matched the pid set before any tree was walked. N !== 1 means the rows
// below cannot be attributed to a single window (zero matched, or several did
// and got concatenated) — refuse rather than merge or pick one. Summing or
// guessing here would reproduce the false-PASS this guard exists to prevent:
// two stale shells that happen to agree on setsize would look like one
// healthy window.
const HEADER_PATTERN = /^#apps\t(\d+)$/;

export function parseAtspiDump(dump: string): A11yProbe {
  const lines = dump.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return unavailable();

  const headerLine = HEADER_PATTERN.exec(lines[0]!);
  if (!headerLine || Number(headerLine[1]) !== 1) return unavailable();
  const rows = lines.slice(1);

  const roleCounts: Record<string, number> = {};
  let hasNavigator = false;
  let mountedRows = 0;
  const setsizes = new Set<number>();
  const treeRows: A11yProbe["treeRows"] = [];

  for (const raw of rows) {
    const [role = "", name = "", states = "", , attrRaw = ""] = raw.split("\t");
    const r = role.toLowerCase();
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;

    if (NAV_ROLES.has(r) || name.toLowerCase().includes("navigator")) hasNavigator = true;

    if (ROW_ROLES.has(r)) {
      mountedRows++;
      const attrs = parseAttrs(attrRaw);
      const setsize = Number(attrs.get("setsize"));
      if (Number.isFinite(setsize) && setsize > 0) setsizes.add(setsize);

      // A tree item missing an attribute records 0, not a skipped row: the
      // structural comparison must count that as a mismatch, not overlook it.
      if (TREE_ROW_ROLES.has(r)) {
        treeRows.push({
          id: attrs.get("id") ?? "",
          name,
          level: num(attrs.get("level")),
          setsize: num(attrs.get("setsize")),
          posinset: num(attrs.get("posinset")),
          expanded: states.split(",").some((s) => s.trim() === "expanded"),
        });
      }
    }
  }

  // One consistent advertised size, or nothing. Disagreement means some rows lie
  // about the set, which is worse than exposing nothing because it survives a
  // spot check.
  const exposedRows = setsizes.size === 1 ? [...setsizes][0]! : 0;

  return { available: true, hasNavigator, exposedRows, mountedRows, treeRows, roleCounts };
}

export function probeAtspi(rootPid: number): A11yProbe {
  try {
    const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, pidListArg(rootPid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return unavailable();
    return parseAtspiDump(proc.stdout.toString());
  } catch {
    return unavailable();
  }
}

/** Text by DOM id: for every id in argv[2] (comma-separated), the text of
 *  the node carrying that `id:` attribute, as JSON {id: text}. Reaches nodes
 *  the role-restricted walk does not (a heading, a status div). Was a private
 *  copy in home-cli and timeline-cli; cast-hover made it a third reader (105). */
export const PY_READ_NODES = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
wanted = set(sys.argv[2].split(","))

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

found = {}

def walk(node):
    try:
        i = ident(node)
        if i in wanted and i not in found:
            found[i] = node.name or own_text(node)
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps(found))
`;
