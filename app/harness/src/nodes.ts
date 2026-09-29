// app/harness/src/nodes.ts
// Widget geometry from AT-SPI: where a control actually is, in window
// coordinates, as the accessibility layer reports it.
//
// This exists because a click computed from the stylesheet is a click computed
// from a restated constant, and this project has been caught by that twice — a
// project bar that shifted every navigator row 39px down, and an outline button
// pushed under #editor at a width the stylesheet still called correct. A box
// read from the running application cannot drift from the running application.
//
// ONE WALK PER WINDOW WAS THE RULE. Several AT-SPI walks in one window kill
// the application outright -- cleanly, with nothing on stderr, taking the X
// server with it (see the gotchas) -- MEASURED FOR shot-cli's capture window,
// and that measurement still holds there: take the geometry once and click
// from the numbers.
//
// mirror-cli.ts IS THE MEASURED EXCEPTION, as of 2026-09-07: it walks twice in
// its second-boot window (a per-row press, then the batch), and now polls --
// up to twelve more walks, none of them a press -- waiting for the batch
// control's label before that second press. Three runs, 11/11 gates PASS
// each time, all reaching the second walk without losing the shell or the X
// server. The rule is a property of a window's own life, not of AT-SPI
// itself: shot-cli's capture window is a single short-lived screenshot dance,
// mirror-cli's second-boot window is open for tens of seconds already waiting
// on the mirror's own schedule, and that difference is the leading theory for
// why one survives more walks than the other. Read mirror-cli.ts's own
// comments before assuming either rig's number carries over to a third.
//
// outline-cli.ts still carries its own copy of this, deliberately not migrated
// here: it is the load-bearing geometry rig and changing it is not part of the
// slice that extracted this module. The duplication is recorded rather than
// hidden.
import { PY_SELECT_APPS, pidListArg } from "./atspi";
import { survivingShellPids } from "./shell";

/** Roles worth reading geometry for.
 *
 *  `list item` is what WebKitGTK maps `role="option"` inside `role="listbox"`
 *  to, which is what the project panel's rows become. `entry`/`text` are the
 *  editable surfaces. Deliberately a small set: the walk is the expensive and
 *  dangerous part, and every extra role is more of it.
 *
 *  `toggle button` is here because **aria-pressed CHANGES THE ATK ROLE**. A
 *  <button> is `push button` until it carries the attribute, and then it is a
 *  toggle button — so the preferences panel's four groups were invisible to this
 *  probe while being perfectly present, correctly exposed, and clickable. The
 *  failure reads as "the panel did not open", which is a different defect in a
 *  different file. Measured on WebKitGTK 2.52.4, not assumed. */
export const PY_NODES = String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
WANTED = ("push button", "button", "toggle button", "list item", "entry", "text")

def walk(node, out):
    try:
        role = node.getRoleName()
        if role in WANTED:
            ident = ""
            try:
                for pair in node.getAttributes():
                    if pair.startswith("id:"):
                        ident = pair[3:]
            except Exception:
                pass
            e = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
            out.append("\t".join([role, ident, node.name or "", str(e.x), str(e.y), str(e.width), str(e.height)]))
        for i in range(node.childCount):
            walk(node.getChildAtIndex(i), out)
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
out = []
walk(matched[0], out)
sys.stdout.write("\n".join(out))
`;

export interface Node {
  role: string;
  /** The DOM id, when the element has one. Empty otherwise. */
  id: string;
  /** The accessible name, which for a button is its text. */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Every locatable widget in the one running shell, in window coordinates.
 *
 * Throws rather than returning empty when the probe cannot answer: an empty
 * list and a dead bridge are the same value and very different problems, and a
 * caller that took the first for the second would report "the button is not
 * there" about an application that had exited.
 */
export function locateNodes(rootPid: number): Node[] {
  const proc = Bun.spawnSync(["python3", "-c", PY_NODES, pidListArg(rootPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    // "not exactly one matching application" and "the bridge wedged" are
    // different problems with different owners, and the surviving pid count is
    // the one line that tells them apart.
    const alive = survivingShellPids();
    throw new Error(
      `could not read widget geometry from AT-SPI (exit ${proc.exitCode}; ` +
        `${alive.length} shell process(es) alive): ${proc.stderr.toString().trim()}`,
    );
  }
  const out: Node[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    const [role = "", id = "", name = "", x = "", y = "", w = "", h = ""] = line.split("\t");
    if (role.length === 0) continue;
    out.push({ role, id, name, x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
  }
  return out;
}

export function centreOf(node: Node): { x: number; y: number } {
  return { x: Math.round(node.x + node.w / 2), y: Math.round(node.y + node.h / 2) };
}
