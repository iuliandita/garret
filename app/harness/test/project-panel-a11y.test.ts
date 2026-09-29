import { expect, test } from "bun:test";
import { evaluateProjectPanelA11y, parsePanelA11yWalk, redactPanelA11yWalk, type PanelA11yNode, type PanelA11yWalk } from "../src/project-panel-a11y";

const ids = ["project-panel", "project-list", "project-move", "project-new-name", "project-new-choose", "project-create", "project-import-heading", "project-imports", "project-recovery-heading", "project-recovery-note", "project-recovery-points", "project-archive-heading", "project-archive-note", "project-archive-now", "project-archives", "project-mirror-heading", "project-mirror-note", "project-mirror-toggle", "mirror-check"];
function n(id: string, order: number): PanelA11yNode {
  const names: Record<string, string> = { "project-panel": "projects", "project-list": "projects", "project-imports": "files to import", "project-recovery-points": "recovery points", "project-archives": "archives", "project-create": "Create", "project-new-choose": "Choose a folder…", "project-move": "Move this book…", "project-archive-now": "Make an archive", "project-mirror-toggle": "Turn the mirror on", "mirror-check": "Check the mirror thoroughly", "project-import-heading": "", "project-recovery-heading": "", "project-archive-heading": "", "project-mirror-heading": "" };
  const notes: Record<string, string> = { "project-import-heading": "Import", "project-recovery-heading": "Recovery points on this device", "project-archive-heading": "If you lose this computer", "project-mirror-heading": "A readable copy you can open anywhere", "project-recovery-note": "Restoring adds a new project. Nothing is replaced. New recovery point folders include referenced original pictures. Older database-only points do not.", "project-archive-note": "A new archive is one complete folder. To protect against losing this computer, move the whole folder off this computer yourself: onto a USB stick, another machine, or a sync folder. Older .db archives did not include pictures.", "project-mirror-note": "The mirror keeps your manuscript as ordinary Markdown files, one per scene, within ten seconds of what you have typed. It is a copy to read and edit elsewhere, not a backup: it is on this computer, and this application writes it rather than reading it back." };
  const role = id === "project-panel" ? "dialog" : id === "project-new-name" ? "entry" : ["project-list", "project-imports", "project-recovery-points", "project-archives"].includes(id) ? "list box" : id in notes ? "section" : "button";
  return { order, depth: id === "project-panel" ? 1 : 2, role, name: names[id] ?? (id === "project-new-name" ? "New project name" : ""), text: notes[id] ?? null, states: id === "mirror-check" ? ["showing", "visible"] : ["enabled", "sensitive", "showing", "visible"], id };
}
function good(): PanelA11yWalk {
  return { nodes: [
    { order: 0, depth: 0, role: "application", name: "test", text: null, states: [], id: null },
    ...ids.map((id, index) => n(id, index + 1)),
  ] };
}
function gate(walk: PanelA11yWalk, name: string): string { return evaluateProjectPanelA11y(walk).find((v) => v.gate === name)!.verdict; }

test("good complete project panel passes every gate", () => expect(evaluateProjectPanelA11y(good()).every((v) => v.verdict === "PASS")).toBe(true));
test("each required platform mapping has a negative control", () => {
  const cases: [string, (w: PanelA11yWalk) => void][] = [
    ["project_panel_open", (w) => { w.nodes[1]!.role = "section"; }],
    ["project_panel_listboxes", (w) => { w.nodes.find((n) => n.id === "project-imports")!.name = ""; }],
    ["project_panel_actions", (w) => { w.nodes.find((n) => n.id === "project-move")!.states = ["sensitive"]; }],
    ["project_panel_mirror_check_off", (w) => { w.nodes.find((n) => n.id === "mirror-check")!.states = ["enabled"]; }],
    ["project_panel_explanations", (w) => { w.nodes.find((n) => n.id === "project-archive-note")!.text = null; }],
    ["project_panel_reading_order", (w) => { const a = w.nodes.findIndex((n) => n.id === "project-mirror-heading");
      const b = w.nodes.findIndex((n) => n.id === "project-import-heading");
      [w.nodes[a], w.nodes[b]] = [w.nodes[b]!, w.nodes[a]!];
      w.nodes.forEach((n, i) => { n.order = i; }); }],
  ];
  for (const [name, spoil] of cases) { const w = good(); spoil(w); expect(gate(w, name)).toBe("FAIL"); }
});
test("absent or duplicate panel fails, never passes", () => { const w = good(); w.nodes = w.nodes.filter((n) => n.id !== "project-panel"); expect(gate(w, "project_panel_open")).toBe("FAIL"); const duplicate = good(); duplicate.nodes.push({ ...duplicate.nodes[1]!, order: duplicate.nodes.length }); expect(gate(duplicate, "project_panel_open")).toBe("FAIL"); });
test("malformed and partial walker output is refused", () => {
  expect(() => parsePanelA11yWalk("not json")).toThrow(/JSON/);
  const twoRoots = good();
  twoRoots.nodes.push({ ...twoRoots.nodes[0]!, order: twoRoots.nodes.length });
  expect(() => parsePanelA11yWalk(JSON.stringify(twoRoots))).toThrow(/depth jump|partial/);
  expect(() => parsePanelA11yWalk(JSON.stringify({ nodes: [] }))).toThrow(/partial/);
  expect(() => parsePanelA11yWalk(JSON.stringify({ nodes: [{ order: 0, depth: 0, role: "dialog", name: "x", text: 3, states: [], id: null }] }))).toThrow(/malformed/);
  expect(() => parsePanelA11yWalk(JSON.stringify({ nodes: [{ order: 0, depth: 0, role: "application", name: "x", text: null, states: [], id: null }, { order: 1, depth: 2, role: "x", name: "", text: null, states: [], id: null }] }))).toThrow(/depth jump/);
});
test("projection redacts only the supplied scratch prefix and preserves unavailable queryText", () => {
  const w = good(); w.nodes[0]!.name = "/tmp/panel/project"; w.nodes[1]!.text = null;
  const redacted = redactPanelA11yWalk(w, "/tmp/panel");
  expect(redacted.nodes[0]!.name).toBe("<scratch>/project");
  expect(redacted.nodes[1]!.text).toBeNull();
});
test("projection also redacts the operator's home, after the scratch prefix", () => {
  const w = good(); w.nodes[0]!.name = "New books go in /home/writer/Documents/Books"; w.nodes[1]!.text = "/tmp/panel/x";
  const redacted = redactPanelA11yWalk(w, "/tmp/panel", "/home/writer");
  expect(redacted.nodes[0]!.name).toBe("New books go in <home>");
  expect(redacted.nodes[1]!.text).toBe("<scratch>/x");
});


test("section text, platform role and visibility are required", () => {
  for (const id of ["project-import-heading", "project-recovery-heading", "project-archive-heading", "project-mirror-heading", "project-recovery-note", "project-archive-note", "project-mirror-note"]) {
    const target = id.endsWith("heading") ? "project_panel_reading_order" : "project_panel_explanations";
    for (const spoil of [
      (node: PanelA11yNode) => { node.text = "truncated"; },
      (node: PanelA11yNode) => { node.role = "button"; },
      (node: PanelA11yNode) => { node.states = ["enabled", "sensitive"]; },
    ]) {
      const w = good();
      spoil(w.nodes.find((node) => node.id === id)!);
      expect(gate(w, target)).toBe("FAIL");
    }
  }
});

test("Choose folder needs its own visible named enabled button", () => {
  for (const spoil of [
    (node: PanelA11yNode) => { node.name = ""; },
    (node: PanelA11yNode) => { node.role = "section"; },
    (node: PanelA11yNode) => { node.states = ["showing", "visible"]; },
    (node: PanelA11yNode) => { node.id = "wrong-id"; },
  ]) {
    const w = good();
    spoil(w.nodes.find((node) => node.id === "project-new-choose")!);
    expect(gate(w, "project_panel_actions")).toBe("FAIL");
  }
});

test("a lookalike outside the panel cannot fill a missing control", () => {
  const w = good();
  const at = w.nodes.findIndex((node) => node.id === "project-new-choose");
  const [outside] = w.nodes.splice(at, 1);
  w.nodes.push({ ...outside!, depth: 1 });
  w.nodes.forEach((node, index) => { node.order = index; });
  expect(gate(parsePanelA11yWalk(JSON.stringify(w)), "project_panel_actions")).toBe("FAIL");
});


test("protection explanations precede their action or list", () => {
  for (const [note, action] of [
    ["project-recovery-note", "project-recovery-points"],
    ["project-archive-note", "project-archive-now"],
    ["project-mirror-note", "project-mirror-toggle"],
  ]) {
    const w = good();
    const a = w.nodes.findIndex((n) => n.id === note);
    const b = w.nodes.findIndex((n) => n.id === action);
    [w.nodes[a], w.nodes[b]] = [w.nodes[b]!, w.nodes[a]!];
    w.nodes.forEach((n, i) => { n.order = i; });
    expect(gate(parsePanelA11yWalk(JSON.stringify(w)), "project_panel_reading_order")).toBe("FAIL");
  }
});
