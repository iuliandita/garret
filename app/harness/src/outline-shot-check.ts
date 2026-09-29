import { PY_SELECT_APPS } from "./atspi";

/** One AT-SPI walk after the menu press. Hidden views do not appear in the
 * accessibility tree, so this checks the photographed surface itself. */
export const PY_OUTLINE_VIEW = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception:
        pass
    return ""

def text(node):
    if node.name:
        return node.name
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception:
        return ""

def extents(node):
    try:
        box = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
        return [box.x, box.y, box.width, box.height]
    except Exception:
        return None

def buttons(node, out):
    try:
        # WebKitGTK names a button "button" here and a button with
        # aria-haspopup (Move) "combo box"; older stacks say "push button".
        if node.getRoleName() in ("button", "push button", "push button menu", "combo box"):
            out.append(extents(node))
        for k in range(node.childCount):
            buttons(node.getChildAtIndex(k), out)
    except Exception:
        pass
    return out

found = False
headings = []
rows = []
roles = set()
def walk(node, in_view=False):
    global found
    try:
        in_view = in_view or ident(node) == "outline-view"
        if in_view:
            found = True
            role = node.getRoleName()
            roles.add(role)
            if role == "heading":
                headings.append(text(node))
            # 242: a table row's own box, its first cell (where the drag grip
            # sits) and its last button (Move), for --outline-act.
            if role == "table row" and node.childCount > 0:
                pressed = buttons(node, [])
                if pressed:
                    rows.append({"row": extents(node), "first": extents(node.getChildAtIndex(0)), "move": pressed[-1]})
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k), in_view)
    except Exception:
        pass

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)
walk(matched[0])
sys.stdout.write(json.dumps({"view": found, "headings": headings, "rows": rows, "roles": sorted(roles)}))
`;

export function assertOutlineViewShown(probe: unknown, mode: "table" | "cards" | "reading", title: string): void {
  if (typeof probe !== "object" || probe === null || !("view" in probe) || !("headings" in probe) ||
      typeof probe.view !== "boolean" || !Array.isArray(probe.headings) || !probe.headings.every((heading) => typeof heading === "string")) {
    throw new Error(`--outline-view ${mode}: invalid accessibility probe result`);
  }
  if (!probe.view || !probe.headings.includes(title)) {
    throw new Error(`--outline-view ${mode}: expected visible heading ${JSON.stringify(title)}; found ${probe.view ? JSON.stringify(probe.headings) : "no outline view"}`);
  }
}

export type OutlineBox = [number, number, number, number];
export interface OutlineRowGeometry { row: OutlineBox; first: OutlineBox; move: OutlineBox }

/** The table rows the probe found, for `--outline-act` (242). Refuses a probe
 *  without enough rows rather than clicking at a guessed coordinate. */
export function outlineRows(probe: unknown, needed: number): OutlineRowGeometry[] {
  const box = (value: unknown): value is OutlineBox => Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number");
  const rows = typeof probe === "object" && probe !== null && "rows" in probe && Array.isArray(probe.rows) ? probe.rows as unknown[] : [];
  const valid = rows.filter((row): row is OutlineRowGeometry =>
    typeof row === "object" && row !== null && "row" in row && "first" in row && "move" in row && box(row.row) && box(row.first) && box(row.move));
  if (valid.length < needed) {
    const roles = typeof probe === "object" && probe !== null && "roles" in probe ? JSON.stringify(probe.roles) : "[]";
    throw new Error(`--outline-act needs ${needed} table rows with geometry; the probe found ${valid.length} (roles in the view: ${roles})`);
  }
  return valid;
}
