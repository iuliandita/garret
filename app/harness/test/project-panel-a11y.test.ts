import { expect, test } from "bun:test";
import { evaluateProjectPanelA11y, parsePanelA11yWalk, redactPanelA11yWalk, type PanelA11yNode, type PanelA11yWalk } from "../src/project-panel-a11y";

const ids = ["project-panel", "project-list", "project-move", "project-new-name", "project-new-choose", "project-create", "project-import-heading", "project-imports", "project-recovery-heading", "project-recovery-note-help", "project-recovery-points", "project-archive-heading", "project-archive-note-help", "project-archive-now", "project-archives", "project-encrypted-archive-heading", "project-mirror-heading", "project-mirror-note-help", "project-mirror-toggle", "mirror-check"];
function n(id: string, order: number): PanelA11yNode {
  const names: Record<string, string> = { "project-panel": "Books", "project-list": "Books", "project-imports": "files to import", "project-recovery-points": "recovery points", "project-archives": "archives", "project-create": "Create", "project-new-choose": "Choose a folder…", "project-move": "Move this book…", "project-archive-now": "Make an archive", "project-mirror-toggle": "Turn the mirror on", "mirror-check": "Check the mirror thoroughly", "project-import-heading": "Import", "project-recovery-heading": "Recovery points on this device", "project-archive-heading": "If you lose this computer", "project-encrypted-archive-heading": "Encrypted backups", "project-mirror-heading": "A readable copy you can open anywhere" };
  const notes: Record<string, string> = { "project-import-heading": "Import", "project-recovery-heading": "Recovery points on this device", "project-archive-heading": "If you lose this computer", "project-encrypted-archive-heading": "Encrypted backups", "project-mirror-heading": "A readable copy you can open anywhere", "project-recovery-note-help": "Restoring adds a new book. Nothing is replaced. New recovery point folders include referenced original pictures. Older database-only points do not.", "project-archive-note-help": "A new archive is one complete folder. To protect against losing this computer, move the whole folder off this computer yourself: onto a USB stick, another machine, or a sync folder. Older .db archives did not include pictures.", "project-mirror-note-help": "The mirror keeps your manuscript as ordinary Markdown files, one per scene, within ten seconds of what you have typed. It is a copy to read and edit elsewhere, not a backup: it is on this computer, and this application writes it rather than reading it back." };
  const role = id === "project-panel" ? "dialog" : id === "project-new-name" ? "entry" : ["project-list", "project-recovery-points", "project-imports", "project-archives"].includes(id) ? "list" : id.endsWith("heading") ? "heading" : "button";
  const helpName = id === "project-recovery-note-help" ? "About Recovery points on this device" : id === "project-archive-note-help" ? "About If you lose this computer" : id === "project-mirror-note-help" ? "About A readable copy you can open anywhere" : null;
  return { order, depth: id === "project-panel" ? 1 : 2, role, name: helpName ?? names[id] ?? (id === "project-new-name" ? "New book name" : ""), text: id.endsWith("heading") ? notes[id] ?? null : null, description: helpName ? notes[id]! : "", states: id === "mirror-check" ? ["showing", "visible"] : ["enabled", "sensitive", "showing", "visible"], id };
}
function good(): PanelA11yWalk {
  return { nodes: [
    { order: 0, depth: 0, role: "application", name: "test", text: null, description: "", states: [], id: null },
    ...ids.flatMap((id) => {
      const parent = n(id, 0);
      if (!["project-list", "project-imports", "project-recovery-points", "project-archives"].includes(id)) return [parent];
      const empty: Record<string, string> = { "project-list": "The open book is not listed in this library. Name another below to create it.", "project-imports": "Drop a .md or .docx file in the import folder.", "project-recovery-points": "No recovery point has been taken on this device yet.", "project-archives": "No archive has been made yet." };
      parent.role = "panel";
      return [parent, { ...parent, id: null, depth: 3, role: "section", name: "", text: empty[id]! }];
    }),
  ].map((node, order) => ({ ...node, order })) };
}
function gate(walk: PanelA11yWalk, name: string): string { return evaluateProjectPanelA11y(walk).find((v) => v.gate === name)!.verdict; }

test("good complete project panel passes every gate", () => expect(evaluateProjectPanelA11y(good()).every((v) => v.verdict === "PASS")).toBe(true));
test("each required platform mapping has a negative control", () => {
  const cases: [string, (w: PanelA11yWalk) => void][] = [
    ["project_panel_open", (w) => { w.nodes[1]!.role = "section"; }],
    ["project_panel_listboxes", (w) => { w.nodes.find((n) => n.id === "project-imports")!.name = ""; }],
    ["project_panel_actions", (w) => { w.nodes.find((n) => n.id === "project-move")!.states = ["sensitive"]; }],
    ["project_panel_mirror_check_off", (w) => { w.nodes.find((n) => n.id === "mirror-check")!.states = ["enabled"]; }],
    ["project_panel_explanations", (w) => { w.nodes.find((n) => n.id === "project-archive-note-help")!.description = ""; }],
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
  expect(() => parsePanelA11yWalk(JSON.stringify({ nodes: [{ order: 0, depth: 0, role: "dialog", name: "x", text: 3, description: "", states: [], id: null }] }))).toThrow(/malformed/);
  expect(() => parsePanelA11yWalk(JSON.stringify({ nodes: [{ order: 0, depth: 0, role: "application", name: "x", text: null, description: "", states: [], id: null }, { order: 1, depth: 2, role: "x", name: "", text: null, description: "", states: [], id: null }] }))).toThrow(/depth jump/);
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


test("heading text, accessible name, platform role and visibility are required", () => {
  for (const id of ["project-import-heading", "project-recovery-heading", "project-archive-heading", "project-encrypted-archive-heading", "project-mirror-heading", "project-recovery-note-help", "project-archive-note-help", "project-mirror-note-help"]) {
    const target = id.endsWith("heading") ? "project_panel_reading_order" : "project_panel_explanations";
    for (const spoil of [
      (node: PanelA11yNode) => { if (id.endsWith("heading")) node.text = "truncated"; else node.description = "truncated"; },
      (node: PanelA11yNode) => { node.role = "section"; },
      (node: PanelA11yNode) => { node.name = ""; },
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
    ["project-recovery-note-help", "project-recovery-points"],
    ["project-archive-note-help", "project-archive-now"],
    ["project-mirror-note-help", "project-mirror-toggle"],
  ]) {
    const w = good();
    const a = w.nodes.findIndex((n) => n.id === note);
    const b = w.nodes.findIndex((n) => n.id === action);
    [w.nodes[a], w.nodes[b]] = [w.nodes[b]!, w.nodes[a]!];
    w.nodes.forEach((n, i) => { n.order = i; });
    expect(gate(parsePanelA11yWalk(JSON.stringify(w)), "project_panel_reading_order")).toBe("FAIL");
  }
});

function populated(id = "project-imports"): PanelA11yWalk {
  const w = good();
  const at = w.nodes.findIndex((n) => n.id === id);
  const container = w.nodes[at]!;
  container.role = "list";
  const row = { ...container, id: null, depth: 3, role: "list item", name: "", text: null };
  const action = { ...container, id: null, depth: 4, role: "button", name: "Pride and Prejudice excerpt.md", text: null };
  w.nodes.splice(at + 1, 1, row, action);
  w.nodes.forEach((n, i) => { n.order = i; });
  return w;
}

test("populated lists require native list, row and one enabled named button", () => {
  expect(gate(populated(), "project_panel_listboxes")).toBe("PASS");
  for (const spoil of [
    (w: PanelA11yWalk) => { w.nodes.find((n) => n.id === "project-imports")!.role = "panel"; },
    (w: PanelA11yWalk) => { w.nodes.find((n) => n.role === "list item")!.role = "section"; },
    (w: PanelA11yWalk) => { w.nodes = w.nodes.filter((n) => n.name !== "Pride and Prejudice excerpt.md"); },
    (w: PanelA11yWalk) => { w.nodes.find((n) => n.name === "Pride and Prejudice excerpt.md")!.states = ["showing", "visible"]; },
    (w: PanelA11yWalk) => { w.nodes.find((n) => n.name === "Pride and Prejudice excerpt.md")!.name = ""; },
    (w: PanelA11yWalk) => { const at = w.nodes.findIndex((n) => n.name === "Pride and Prejudice excerpt.md"); w.nodes.splice(at, 0, { ...w.nodes[at]! }); },
  ]) {
    const w = populated(); spoil(w); w.nodes.forEach((n, i) => { n.order = i; });
    expect(gate(w, "project_panel_listboxes")).toBe("FAIL");
  }
});

test("empty list containers must expose the truthful message and cannot claim listbox semantics", () => {
  for (const spoil of [
    (w: PanelA11yWalk) => { w.nodes.find((n) => n.text === "No archive has been made yet.")!.text = ""; },
    (w: PanelA11yWalk) => { w.nodes.find((n) => n.id === "project-archives")!.role = "list box"; },
  ]) { const w = good(); spoil(w); expect(gate(w, "project_panel_listboxes")).toBe("FAIL"); }
});

test("each gate owns its uniqueness checks", () => {
  const w = good();
  const help = w.nodes.find((n) => n.id === "project-archive-note-help")!;
  w.nodes.push({ ...help, order: w.nodes.length });
  expect(gate(w, "project_panel_explanations")).toBe("FAIL");
  expect(gate(w, "project_panel_actions")).toBe("PASS");
  expect(gate(w, "project_panel_listboxes")).toBe("PASS");
  expect(gate(w, "project_panel_mirror_check_off")).toBe("PASS");
  const control = good();
  control.nodes.push({ ...control.nodes.find((n) => n.id === "project-create")!, order: control.nodes.length });
  expect(gate(control, "project_panel_actions")).toBe("FAIL");
  expect(gate(control, "project_panel_explanations")).toBe("PASS");
});

test("native help object markers do not change the heading text contract", () => {
  const w = good();
  w.nodes.find((n) => n.id === "project-archive-heading")!.text += "\uFFFC\n";
  expect(gate(w, "project_panel_reading_order")).toBe("PASS");
});

test("accessible descriptions are required by the parser and redacted", () => {
  const w = good();
  w.nodes[0]!.description = "Read /home/writer/Books/private and /tmp/panel/x";
  expect(redactPanelA11yWalk(w, "/tmp/panel", "/home/writer").nodes[0]!.description).toBe("Read <home> and <scratch>/x");
  const raw = JSON.parse(JSON.stringify(w));
  delete raw.nodes[0].description;
  expect(() => parsePanelA11yWalk(JSON.stringify(raw))).toThrow(/malformed/);
});

test("distinct list rows may expose actions with the same display name", () => {
  const w = populated();
  const at = w.nodes.findIndex((n) => n.id === "project-imports");
  w.nodes.splice(at + 3, 0, { ...w.nodes[at + 1]! }, { ...w.nodes[at + 2]! });
  w.nodes.forEach((n, i) => { n.order = i; });
  expect(gate(w, "project_panel_listboxes")).toBe("PASS");
});

test("an open-book panel refuses the contradictory empty-library message", () => {
  const w = good();
  const list = w.nodes.find((n) => n.id === "project-list")!;
  w.nodes[list.order + 1]!.text = "No books in the library yet. Name one below and create it.";
  expect(gate(w, "project_panel_listboxes")).toBe("FAIL");
});
