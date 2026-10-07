// Accessibility projection and gates for the open project panel.  This is a
// deliberately unfiltered AT-SPI walk: selecting only known ids would turn the
// expected answer into the reader and hide a missing platform mapping.
import type { GateResult } from "./gates";
import { PY_SELECT_APPS } from "./atspi";

export interface PanelA11yNode {
  order: number;
  depth: number;
  role: string;
  name: string;
  text: string | null;
  description: string;
  states: string[];
  id: string | null;
}

export interface PanelA11yWalk {
  nodes: PanelA11yNode[];
}

/**
 * A complete traversal is required.  A child that cannot be read is an error,
 * not a reason to skip its descendants: silently skipping is how a partial
 * panel could be reported as accessible.  queryText is optional per AT-SPI;
 * null means that interface was not advertised, never an empty string.
 */
export const PY_PROJECT_PANEL_WALK = String.raw`
import json
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)

${PY_SELECT_APPS}
if len(matched) != 1:
    sys.exit(4)

out = []
errors = []
def ident(node):
    try:
        for pair in node.getAttributes():
            if pair.startswith("id:"):
                return pair[3:]
    except Exception as e:
        errors.append("attributes: " + type(e).__name__)
    return None

def text_of(node):
    try:
        interfaces = node.get_interfaces()
    except Exception as e:
        errors.append("interfaces: " + type(e).__name__)
        return None
    if not any(i == "Text" or i.endswith(".Text") for i in interfaces):
        return None
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception as e:
        errors.append("text: " + type(e).__name__)
        return None

def walk(node, depth):
    try:
        role = node.getRoleName()
        name = node.name or ""
        description = node.description or ""
        states = [s.value_nick for s in node.getState().get_states()]
        count = node.childCount
    except Exception as e:
        errors.append("node: " + type(e).__name__)
        return
    out.append({"order": len(out), "depth": depth, "role": role, "name": name,
                "text": text_of(node), "description": description, "states": states, "id": ident(node)})
    for i in range(count):
        try:
            child = node.getChildAtIndex(i)
        except Exception as e:
            errors.append("child: " + type(e).__name__)
            continue
        walk(child, depth + 1)

walk(matched[0], 0)
if errors:
    sys.stderr.write("; ".join(errors))
    sys.exit(5)
sys.stdout.write(json.dumps({"nodes": out}))
`;

export function parsePanelA11yWalk(raw: string): PanelA11yWalk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AT-SPI walker did not emit JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { nodes?: unknown }).nodes)) {
    throw new Error("AT-SPI walker emitted no node list");
  }
  const nodes = (parsed as { nodes: unknown[] }).nodes.map((value, index): PanelA11yNode => {
    if (typeof value !== "object" || value === null) throw new Error(`AT-SPI node ${index} is not an object`);
    const n = value as Record<string, unknown>;
    if (
      n.order !== index || typeof n.depth !== "number" || !Number.isInteger(n.depth) || n.depth < 0 || typeof n.role !== "string" ||
      typeof n.name !== "string" || typeof n.description !== "string" || (n.text !== null && typeof n.text !== "string") ||
      !Array.isArray(n.states) || !n.states.every((s) => typeof s === "string") ||
      (n.id !== null && typeof n.id !== "string")
    ) throw new Error(`AT-SPI node ${index} has malformed fields`);
    return { order: index, depth: n.depth, role: n.role, name: n.name, text: n.text, description: n.description, states: n.states as string[], id: n.id as string | null };
  });
  if (nodes.length === 0 || nodes[0]!.depth !== 0 || nodes[0]!.role.toLowerCase() !== "application") {
    throw new Error("AT-SPI walker returned a partial tree");
  }
  if (nodes.some((n, i) => i > 0 && (n.depth === 0 || n.depth > nodes[i - 1]!.depth + 1))) {
    throw new Error("AT-SPI walker returned an impossible depth jump");
  }
  return { nodes };
}

interface PanelScope {
  nodes: PanelA11yNode[];
  valid: boolean;
  reason: string;
}

function scopeOf(walk: PanelA11yWalk): PanelScope {
  const panels = walk.nodes.filter((n) => n.id === "project-panel");
  if (panels.length !== 1) return { nodes: [], valid: false, reason: `${panels.length} project-panel nodes` };
  const panel = panels[0]!;
  const start = panel.order;
  let end = walk.nodes.length;
  for (let i = start + 1; i < walk.nodes.length; i++) {
    if (walk.nodes[i]!.depth <= panel.depth) { end = i; break; }
  }
  return { nodes: walk.nodes.slice(start, end), valid: true, reason: "" };
}
function node(scope: PanelScope, id: string): PanelA11yNode | undefined {
  const found = scope.nodes.filter((n) => n.id === id);
  return found.length === 1 ? found[0] : undefined;
}
function unique(walk: PanelA11yWalk, id: string): boolean {
  return walk.nodes.filter((n) => n.id === id).length === 1;
}
function states(n: PanelA11yNode | undefined, enabled: boolean): boolean {
  if (n === undefined || !n.states.includes("showing") || !n.states.includes("visible")) return false;
  return enabled
    ? n.states.includes("enabled") && n.states.includes("sensitive")
    : !n.states.includes("enabled") && !n.states.includes("sensitive");
}

export function evaluateProjectPanelA11y(walk: PanelA11yWalk): GateResult[] {
  const scope = scopeOf(walk);
  const panel = node(scope, "project-panel");
  const listboxes = [
    ["project-list", "Books", "The open book is not listed in this library. Name another below to create it.", true],
    ["project-imports", "files to import", "Drop a .md or .docx file in the import folder.", true],
    ["project-recovery-points", "recovery points", "No recovery point has been taken on this device yet.", true],
    ["project-archives", "archives", "No archive has been made yet.", false],
  ] as const;
  const explanatory = [
    ["project-recovery-note-help", "About Recovery points on this device", "Restoring adds a new book. Nothing is replaced. New recovery point folders include referenced original pictures. Older database-only points do not."],
    ["project-archive-note-help", "About If you lose this computer", "A new archive is one complete, unencrypted folder. Anyone with access to it can read your book. To protect against losing this computer, move the whole folder off this computer yourself: onto a USB stick, another machine, or a sync folder. Older .db archives did not include pictures."],
    ["project-mirror-note-help", "About A readable copy you can open anywhere", "The mirror keeps your manuscript as ordinary Markdown files, one per scene, within ten seconds of what you have typed. It is a copy to read and edit elsewhere, not a backup: it is on this computer, and this application writes it rather than reading it back."],
  ] as const;
  const headings = [
    // Sentence case (no uppercase labels); the notes as the catalog has held
    // them since recovery points began carrying pictures.
    ["project-import-heading", "Import"],
    ["project-recovery-heading", "Recovery points on this device"],
    ["project-archive-heading", "If you lose this computer"],
    ["project-encrypted-archive-heading", "Encrypted backups"],
    ["project-mirror-heading", "A readable copy you can open anywhere"],
  ] as const;
  const ordered = [
    "project-list", "project-move", "project-new-name", "project-new-choose", "project-create",
    "project-import-heading", "project-imports",
    "project-recovery-heading", "project-recovery-note-help", "project-recovery-points",
    "project-archive-heading", "project-archive-note-help", "project-archive-now", "project-archives",
    "project-encrypted-archive-heading",
    "project-mirror-heading", "project-mirror-note-help", "project-mirror-toggle", "mirror-check",
  ];
  const controls = [["project-new-name", "entry", "New book name"], ["project-create", "button", "Create"], ["project-new-choose", "button", "Choose a folder…"], ["project-move", "button", "Move this book…"], ["project-archive-now", "button", "Make unencrypted archive"], ["project-mirror-toggle", "button", "Turn the mirror on"]] as const;
  const uniqueIds = (ids: readonly string[]): boolean => ids.every((id) => unique(walk, id));
  const listOk = scope.valid && uniqueIds(listboxes.map(([id]) => id)) && listboxes.every(([id, name, empty, actionable]) => {
    const container = node(scope, id);
    if (!container || container.name !== name || !states(container, true)) return false;
    const start = scope.nodes.indexOf(container);
    let end = start + 1;
    while (end < scope.nodes.length && scope.nodes[end]!.depth > container.depth) end++;
    const children = scope.nodes.slice(start + 1, end);
    const rows = children.filter((n) => n.role.toLowerCase() === "list item");
    const buttons = children.filter((n) => n.role.toLowerCase() === "button");
    if (rows.length === 0 && buttons.length === 0) {
      return ["panel", "list"].includes(container.role.toLowerCase()) &&
        children.some((n) => n.text === empty && states(n, true));
    }
    if (container.role.toLowerCase() !== "list" || rows.length === 0) return false;
    if (children.some((n) => n.text === empty)) return false;
    return rows.every((row, index) => {
      if (!states(row, true)) return false;
      const next = rows[index + 1]?.order ?? Infinity;
      const actions = buttons.filter((button) => button.order > row.order && button.order < next && button.depth > row.depth);
      return actionable ? actions.length === 1 && actions[0]!.name !== "" && states(actions[0], true)
        : actions.length === 0 && (row.text !== null && row.text !== "" || row.name !== "");
    }) && (!actionable || buttons.length === rows.length);
  });
  const notes = explanatory.map(([id, name, expected]) => {
    const help = node(scope, id);
    return help?.role.toLowerCase() === "button" && help.name === name && help.description === expected && states(help, true);
  });
  const orderedNodes = ordered.map((id) => node(scope, id));
  // WebKit includes an object replacement character for the nested help button.
  const orderOk = headings.every(([id, expected]) => {
    const heading = node(scope, id);
    return heading?.role.toLowerCase() === "heading" && heading.name === expected && states(heading, true) &&
      heading.text?.replace(/\uFFFC/g, "").trim() === expected;
  }) && orderedNodes.every((n) => n !== undefined) && orderedNodes.every((n, i) => i === 0 || n!.order > orderedNodes[i - 1]!.order);
  const controlsOk = scope.valid && uniqueIds(controls.map(([id]) => id)) && controls.every(([id, role, name]) => node(scope, id)?.role.toLowerCase() === role && node(scope, id)?.name === name && states(node(scope, id), true));
  const check = node(scope, "mirror-check");
  const checkOff = scope.valid && uniqueIds(["mirror-check"]) && check?.role.toLowerCase() === "button" && check.name === "Check the mirror thoroughly" && states(check, false);
  return [
    { gate: "project_panel_open", value: scope.valid ? `${panel?.role ?? "absent"} ${JSON.stringify(panel?.name ?? "")}` : scope.reason, threshold: 'one AT-SPI dialog named "Books"', verdict: scope.valid && panel?.role.toLowerCase() === "dialog" && panel.name === "Books" && states(panel, true) ? "PASS" : "FAIL" },
    { gate: "project_panel_listboxes", value: listboxes.map(([id]) => `${id}=${node(scope, id)?.name ?? "absent"}`).join("; "), threshold: "four named visible containers: populated lists expose rows and their actions; empty containers expose truthful empty messages", verdict: listOk ? "PASS" : "FAIL" },
    { gate: "project_panel_actions", value: controls.map(([id]) => `${id}=${node(scope, id)?.name ?? "absent"}`).join(", "), threshold: "named create input and enabled Create, Choose folder, Move, Archive and mirror buttons", verdict: controlsOk ? "PASS" : "FAIL" },
    { gate: "project_panel_mirror_check_off", value: check === undefined ? "absent" : check.name, threshold: "named mirror check is visibly disabled while the mirror is off", verdict: checkOff ? "PASS" : "FAIL" },
    { gate: "project_panel_explanations", value: notes.every(Boolean) ? "exact recovery, archive and mirror descriptions exposed" : "one or more exact explanatory texts are absent", threshold: "named visible help buttons expose full recovery, archive and mirror descriptions", verdict: scope.valid && uniqueIds(explanatory.map(([id]) => id)) && notes.every(Boolean) ? "PASS" : "FAIL" },
    { gate: "project_panel_reading_order", value: orderedNodes.map((n) => n?.order ?? "absent").join(" < "), threshold: "visible named headings in Create, Import, Recovery, Archive, Encrypted backups, Mirror order, with explanations before actions", verdict: scope.valid && uniqueIds([...ordered, ...headings.map(([id]) => id)]) && orderOk ? "PASS" : "FAIL" },
  ];
}

/** A result projection must be useful without retaining a temporary home,
 *  and must carry no private path: the new-books line names the operator's
 *  real documents folder, so `home` is redacted too (239 found it in a
 *  committed result). */
export function redactPanelA11yWalk(walk: PanelA11yWalk, scratch: string, home?: string): PanelA11yWalk {
  const redact = (value: string | null): string | null => {
    if (value === null) return null;
    const scrubbed = value.split(scratch).join("<scratch>");
    // The whole path under home goes, not just its prefix: the folder names
    // below it are the operator's own layout.
    return home === undefined || home === "" ? scrubbed
      : scrubbed.replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\S*`, "g"), "<home>");
  };
  return { nodes: walk.nodes.map((n) => ({ ...n, name: redact(n.name)!, text: redact(n.text), description: redact(n.description)! })) };
}

/** The full walk establishes attribution and completeness; only the panel's
 * subtree belongs in a durable result. A closed panel is an empty projection. */
export function projectPanelProjection(walk: PanelA11yWalk): PanelA11yWalk {
  return { nodes: scopeOf(walk).nodes };
}
