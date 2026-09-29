import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createOutlineView, createOutlineViewTransitions, moveAvailability, outlinePage, outlineRowKey, planDrop, readingPage, OUTLINE_PAGE_SIZE, type OutlineViewDeps } from "../src/outline-view";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, type = "scene", depth = 0): ProjectItem => ({ id, parent_id: null, type, title: `Title ${id}`, position: id, rev: 1, state: null, depth });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const noDeps = (): OutlineViewDeps => ({ editor: document.body, items: [], readSynopses: async () => [], onSelect: () => undefined, onOpen: () => undefined, onMove: () => undefined, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: () => undefined });

describe("outline view", () => {
  test("caps DOM rows at 100 and excludes bin and bible branches", async () => {
    const manuscript = Array.from({ length: 201 }, (_, i) => item(`s${i}`));
    const gone = { ...item("gone", "scene", 1), parent_id: "bin" };
    const note = { ...item("note", "note", 1), parent_id: "bible" };
    const items = [item("bin", "trash"), gone, item("bible", "bible"), note, ...manuscript];
    expect(outlinePage(items, 1).rows).toHaveLength(OUTLINE_PAGE_SIZE);
    expect(outlinePage(items, 3).rows).toHaveLength(1);
    expect(outlinePage(items, 3).rows[0]?.id).toBe("s200");
    expect(outlinePage(items, 3).total).toBe(201);
    const editor = document.createElement("main"); document.body.append(editor);
    const requests: string[][] = [];
    const view = createOutlineView({ editor, items, readSynopses: async (ids) => { requests.push(ids); return []; }, onSelect: () => undefined, onOpen: () => undefined, onMove: () => undefined, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: () => undefined });
    view.show("cards"); await tick();
    expect(view.element.querySelectorAll(".outline-view-row")).toHaveLength(100);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(100);
    expect(view.element.textContent).toContain("201");
    view.element.querySelectorAll(".outline-view-pages button")[1]?.dispatchEvent(new Event("click")); await tick();
    expect(view.element.querySelectorAll(".outline-view-row")).toHaveLength(100);
    expect(requests).toHaveLength(2);
    view.destroy(); editor.remove();
  });

  test("empty manuscript names its exclusion scope without creating rows", () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const view = createOutlineView({ editor, items: [item("bin", "trash"), item("bible", "bible")], readSynopses: async () => [], onSelect: () => undefined, onOpen: () => undefined, onMove: () => undefined, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: () => undefined });
    view.show("table");
    expect(view.element.querySelectorAll(".outline-view-row")).toHaveLength(0);
    expect(view.element.querySelector(".outline-view-empty")?.textContent).toContain("No manuscript items");
    expect(view.element.querySelector(".outline-view-scope")?.textContent).toContain("Bin and bible excluded");
    view.destroy(); editor.remove();
  });

  test("table selection and move carry the same canonical id", () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const selected: string[] = [];
    const moved: string[] = [];
    const opened: string[] = [];
    const view = createOutlineView({ editor, items: [item("s0"), item("s1")], readSynopses: async () => [], onSelect: (id) => selected.push(id), onOpen: (id) => opened.push(id), onMove: (id, direction) => { moved.push(`${id}:${direction}`); }, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: () => undefined });
    view.show("table");
    expect(view.element.querySelectorAll("th")).toHaveLength(6);
    const rowOf = (id: string) => view.element.querySelector<HTMLElement>(`.outline-view-row[data-item-id="${id}"]`)!;
    rowOf("s1").querySelector<HTMLElement>(".outline-view-synopsis")?.click();
    expect(selected).toEqual(["s1"]);
    expect(rowOf("s1").getAttribute("data-selected")).toBe("true");
    rowOf("s1").querySelector<HTMLButtonElement>(".outline-view-title")?.click();
    expect(opened).toEqual(["s1"]);
    // One Move button per row, not four, and no chip: the title is a link.
    expect(rowOf("s1").querySelectorAll("button")).toHaveLength(3);
    const move = rowOf("s1").querySelector<HTMLButtonElement>('button[data-action="move"]')!;
    expect(move.getAttribute("aria-label")).toBe("Move Title s1");
    move.click();
    const menu = document.getElementById("outline-move-menu")!;
    expect(menu.hidden).toBe(false);
    expect(move.getAttribute("aria-expanded")).toBe("true");
    expect([...menu.querySelectorAll("button")].map((b) => `${b.textContent}:${b.getAttribute("aria-disabled")}`)).toEqual(["Move up:false", "Move down:true", "Move out:true", "Move in:false"]);
    menu.querySelector<HTMLButtonElement>("#outline-move-down")?.click();
    expect(moved).toEqual([]);
    menu.querySelector<HTMLButtonElement>("#outline-move-up")?.click();
    expect(moved).toEqual(["s1:up"]);
    expect(menu.hidden).toBe(true);
    expect(rowOf("s1").getAttribute("data-selected")).toBe("true");
    expect((document.activeElement as HTMLElement).dataset.itemId).toBe("s1");
    expect((document.activeElement as HTMLElement).dataset.action).toBe("row");
    view.destroy(); editor.remove();
    expect(document.getElementById("outline-move-menu")).toBeNull();
  });

  test("Escape closes the Move menu onto its button, and a second press on the button closes it", () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const view = createOutlineView({ ...noDeps(), editor, items: [item("s0"), item("s1")] });
    view.show("table");
    const move = view.element.querySelector<HTMLButtonElement>('button[data-action="move"]')!;
    move.click();
    const menu = document.getElementById("outline-move-menu")!;
    expect(document.activeElement?.id).toBe("outline-move-down");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(move);
    move.click();
    expect(menu.hidden).toBe(false);
    move.click();
    expect(menu.hidden).toBe(true);
    view.destroy(); editor.remove();
  });

  test("rows rove: arrows walk them, Alt+Arrow moves the focused row, Enter opens a scene and selects a chapter", () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const moved: string[] = [];
    const opened: string[] = [];
    const selected: string[] = [];
    const items = [item("c1", "chapter"), { ...item("a", "scene", 1), parent_id: "c1" }, { ...item("b", "scene", 1), parent_id: "c1" }];
    const view = createOutlineView({ ...noDeps(), editor, items, onMove: (id, direction) => { moved.push(`${id}:${direction}`); }, onOpen: (id) => opened.push(id), onSelect: (id) => selected.push(id) });
    view.show("table");
    const rows = () => [...view.element.querySelectorAll<HTMLElement>(".outline-view-row")];
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    expect(rows()[1]!.querySelector<HTMLButtonElement>("button")!.tabIndex).toBe(-1);
    const key = (init: KeyboardEventInit) => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    rows()[0]!.focus();
    key({ key: "Enter" });
    expect(selected).toEqual(["c1"]);
    expect(opened).toEqual([]);
    key({ key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset.itemId).toBe("a");
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    expect(rows()[1]!.querySelector<HTMLButtonElement>("button")!.tabIndex).toBe(0);
    key({ key: "End" });
    expect((document.activeElement as HTMLElement).dataset.itemId).toBe("b");
    key({ key: "ArrowUp", altKey: true });
    expect(moved).toEqual(["b:up"]);
    expect((document.activeElement as HTMLElement).dataset.itemId).toBe("b");
    expect((document.activeElement as HTMLElement).dataset.action).toBe("row");
    key({ key: "Home" });
    expect((document.activeElement as HTMLElement).dataset.itemId).toBe("c1");
    key({ key: "ArrowDown" });
    key({ key: "Enter" });
    expect(opened).toEqual(["a"]);
    key({ key: "F10", shiftKey: true });
    expect(document.getElementById("outline-move-menu")?.hidden).toBe(false);
    view.destroy(); editor.remove();
  });

  test("a drag resolves to up or down steps, announces a run that moved, and Escape cancels one", async () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const moved: string[] = [];
    const announced: string[] = [];
    const items = [item("c1", "chapter"), ...["a", "b", "c"].map((id) => ({ ...item(id, "scene", 1), parent_id: "c1" }))];
    const view = createOutlineView({ ...noDeps(), editor, items, onMove: async (id, direction, count) => { moved.push(`${id}:${direction}:${count}`); return "applied" as const; }, onAnnounce: (message) => announced.push(message) });
    view.show("table");
    const rowOf = (id: string) => view.element.querySelector<HTMLElement>(`.outline-view-row[data-item-id="${id}"]`)!;
    const originalFromPoint = document.elementFromPoint;
    const originalRect = Element.prototype.getBoundingClientRect;
    let over = "c";
    document.elementFromPoint = () => rowOf(over).querySelector("td");
    Element.prototype.getBoundingClientRect = function () { return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect; };
    try {
      const pointer = (target: Element, type: string, clientY: number) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 5, clientY }));
      let grip = rowOf("a").querySelector(".outline-view-grip")!;
      pointer(grip, "pointerdown", 5);
      pointer(grip, "pointermove", 15);
      expect(rowOf("c").dataset.drop).toBe("after");
      pointer(grip, "pointerup", 15);
      // One call for the run of two, so it lands as one undo entry.
      expect(moved).toEqual(["a:down:2"]);
      await Promise.resolve(); await Promise.resolve();
      expect(announced).toEqual(["Moved Title a."]);
      grip = rowOf("b").querySelector(".outline-view-grip")!;
      pointer(grip, "pointerdown", 5);
      over = "a";
      pointer(grip, "pointermove", 5);
      expect(rowOf("a").dataset.drop).toBe("before");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      expect(rowOf("a").dataset.drop).toBeUndefined();
      pointer(grip, "pointerup", 5);
      expect(moved).toEqual(["a:down:2"]);
    } finally {
      document.elementFromPoint = originalFromPoint;
      Element.prototype.getBoundingClientRect = originalRect;
      view.destroy(); editor.remove();
    }
  });

  test("a drop under another parent is refused out loud, and moves nothing", () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const moved: string[] = [];
    const refused: string[] = [];
    const items = [item("c1", "chapter"), { ...item("a", "scene", 1), parent_id: "c1" }, item("c2", "chapter"), { ...item("e", "scene", 1), parent_id: "c2" }];
    const view = createOutlineView({ ...noDeps(), editor, items, onMove: (id, direction) => { moved.push(`${id}:${direction}`); }, onRefuse: (message) => refused.push(message) });
    view.show("table");
    const rowOf = (id: string) => view.element.querySelector<HTMLElement>(`.outline-view-row[data-item-id="${id}"]`)!;
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => rowOf("e");
    try {
      const grip = rowOf("a").querySelector(".outline-view-grip")!;
      const pointer = (type: string) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 2, clientX: 5, clientY: 5 }));
      pointer("pointerdown"); pointer("pointermove");
      expect(rowOf("e").dataset.drop).toBe("refused");
      pointer("pointerup");
      expect(moved).toEqual([]);
      expect(refused).toHaveLength(1);
    } finally {
      document.elementFromPoint = originalFromPoint;
      view.destroy(); editor.remove();
    }
  });

  test("focus stays on the same row after selection and count refresh, then moves to a live page control", () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const view = createOutlineView({ editor, items: Array.from({ length: 101 }, (_, i) => item(`s${i}`)), readSynopses: async () => [], onSelect: () => undefined, onOpen: () => undefined, onMove: () => undefined, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: () => undefined });
    view.show("cards");
    const row = view.element.querySelector<HTMLElement>(".outline-view-row");
    row?.focus(); row?.click();
    expect((document.activeElement as HTMLElement).dataset.action).toBe("row");
    view.setCounts(new Map([["s0", 12]]));
    expect((document.activeElement as HTMLElement).dataset.itemId).toBe("s0");
    expect(view.element.querySelector(".outline-view-meta")?.textContent).toBe("Scene · 12 words");
    const next = view.element.querySelector<HTMLButtonElement>('button[data-action="next"]');
    next?.focus(); next?.click();
    expect((document.activeElement as HTMLElement).dataset.action).toBe("previous");
    expect(view.element.querySelectorAll(".outline-view-cards > article")).toHaveLength(1);
    view.destroy(); editor.remove();
  });

  test("a failed synopsis read is shown as unavailable, while a stale failure is ignored", async () => {
    const editor = document.createElement("main"); document.body.append(editor);
    let rejectRead: (error: Error) => void = () => undefined;
    const errors: unknown[] = [];
    const view = createOutlineView({ editor, items: [item("s1")], readSynopses: () => new Promise((_, reject) => { rejectRead = reject; }), onSelect: () => undefined, onOpen: () => undefined, onMove: () => undefined, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: (error) => errors.push(error) });
    view.show("table");
    expect(view.element.querySelector(".outline-view-synopsis")?.textContent).toContain("Loading");
    rejectRead(new Error("offline")); await tick();
    expect(view.element.querySelector(".outline-view-synopsis")?.textContent).toContain("unavailable");
    expect(errors).toHaveLength(1);
    view.hide(); view.show("cards"); view.destroy();
    rejectRead(new Error("stale")); await tick();
    expect(errors).toHaveLength(1);
    editor.remove();
  });

  test("only the newest view request may complete after a delayed save", async () => {
    let resolveDrain: () => void = () => undefined;
    const drain = new Promise<void>((resolve) => { resolveDrain = resolve; });
    let mode: "manuscript" | "table" | "cards" | "reading" = "manuscript";
    const transitions = createOutlineViewTransitions({ mode: () => mode, drain: () => drain, failed: () => false, show: (next) => { mode = next; }, returnToEditor: () => { mode = "manuscript"; } });
    const table = transitions.show("table");
    const cards = transitions.show("cards");
    resolveDrain();
    expect(await table).toBe(false);
    expect(await cards).toBe(true);
    expect(String(mode)).toBe("cards");
    transitions.returnToEditor();
    let finishSecondDrain: () => void = () => undefined;
    const secondDrain = new Promise<void>((resolve) => { finishSecondDrain = resolve; });
    const second = createOutlineViewTransitions({ mode: () => mode, drain: () => secondDrain, failed: () => false, show: (next) => { mode = next; }, returnToEditor: () => { mode = "manuscript"; } });
    const another = second.show("table");
    second.returnToEditor();
    finishSecondDrain();
    expect(await another).toBe(false);
    expect(mode).toBe("manuscript");
    const refused = createOutlineViewTransitions({ mode: () => mode, drain: async () => { throw new Error("save failed"); }, failed: () => true, show: (next) => { mode = next; }, returnToEditor: () => { mode = "manuscript"; } });
    expect(await refused.show("reading")).toBe(false);
    expect(mode).toBe("manuscript");
  });

  test("read-through loads at most 20 prose documents in canonical order and opens the selected source", async () => {
    const editor = document.createElement("main"); document.body.append(editor);
    const items = [item("bin", "trash"), { ...item("gone", "scene", 1), parent_id: "bin" }, item("bible", "bible"), { ...item("note", "note", 1), parent_id: "bible" }, item("chapter", "chapter"), ...Array.from({ length: 25 }, (_, i) => ({ ...item(`s${i}`, "scene", 1), parent_id: "chapter" }))];
    expect(readingPage(items, 1).rows).toHaveLength(20);
    expect(readingPage(items, 2).rows.map((row) => row.item.id)).toEqual(["s20", "s21", "s22", "s23", "s24"]);
    const reads: string[] = [];
    const opened: string[] = [];
    const body = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "marked", marks: [{ type: "strong" }] }] }] });
    const view = createOutlineView({ editor, items, readSynopses: async () => [], readDocument: async (id) => { reads.push(id); return { body, rev: 1 }; }, onSelect: () => undefined, onOpen: (id) => opened.push(id), onMove: () => undefined, onUndo: () => undefined, onRedo: () => undefined, onReturn: () => undefined, onError: () => undefined });
    view.show("reading"); await tick();
    expect(reads).toHaveLength(20);
    expect(reads[0]).toBe("s0");
    expect(view.element.querySelectorAll(".reading-document")).toHaveLength(20);
    expect(view.element.querySelector(".reading-revision")?.textContent).toContain("1");
    expect(view.element.querySelector(".reading-revision")?.textContent).not.toContain("s0");
    expect(view.element.querySelector(".reading-document strong")?.textContent).toBe("marked");
    view.setCounts(new Map([["s0", 1]]));
    expect(reads).toHaveLength(20);
    view.element.querySelector<HTMLButtonElement>('button[data-action="next"]')?.click(); await tick();
    expect(reads).toHaveLength(25);
    expect(view.element.querySelectorAll(".reading-document")).toHaveLength(5);
    view.element.querySelector<HTMLButtonElement>('button[data-action="open"]')?.click();
    expect(opened).toEqual(["s20"]);
    view.destroy(); editor.remove();
  });
});

describe("outline view: the pure rules", () => {
  const tree = [
    item("c1", "chapter"),
    { ...item("a", "scene", 1), parent_id: "c1" },
    { ...item("b", "scene", 1), parent_id: "c1" },
    { ...item("c", "scene", 1), parent_id: "c1" },
    { ...item("d", "scene", 1), parent_id: "c1" },
    item("c2", "chapter"),
    { ...item("e", "scene", 1), parent_id: "c2" },
  ];

  test("the Move menu enables exactly the moves planMove would make", () => {
    expect(moveAvailability(tree, "a")).toEqual({ up: false, down: true, outdent: true, indent: false });
    expect(moveAvailability(tree, "b")).toEqual({ up: true, down: true, outdent: true, indent: true });
    expect(moveAvailability(tree, "d")).toEqual({ up: true, down: false, outdent: true, indent: true });
    expect(moveAvailability(tree, "c1")).toEqual({ up: false, down: true, outdent: false, indent: false });
    expect(moveAvailability(tree, "c2")).toEqual({ up: true, down: false, outdent: false, indent: true });
    expect(moveAvailability(tree, "gone")).toEqual({ up: false, down: false, outdent: false, indent: false });
  });

  test("row keys: arrows clamp, Home and End, activation, the move chord and the menu chord", () => {
    const k = (key: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(outlineRowKey(k("ArrowDown"), 1, 3, true)).toEqual({ kind: "focus", index: 2 });
    expect(outlineRowKey(k("ArrowDown"), 2, 3, true)).toEqual({ kind: "focus", index: 2 });
    expect(outlineRowKey(k("ArrowUp"), 0, 3, true)).toEqual({ kind: "focus", index: 0 });
    expect(outlineRowKey(k("Home"), 2, 3, true)).toEqual({ kind: "focus", index: 0 });
    expect(outlineRowKey(k("End"), 0, 3, true)).toEqual({ kind: "focus", index: 2 });
    expect(outlineRowKey(k("Enter"), 0, 3, true)).toEqual({ kind: "activate" });
    expect(outlineRowKey(k(" "), 0, 3, true)).toEqual({ kind: "activate" });
    expect(outlineRowKey(k("ArrowLeft", { altKey: true }), 0, 3, true)).toEqual({ kind: "move", direction: "outdent" });
    expect(outlineRowKey(k("ArrowRight", { altKey: true }), 0, 3, false)).toEqual({ kind: "move", direction: "indent" });
    expect(outlineRowKey(k("F10", { shiftKey: true }), 0, 3, true)).toEqual({ kind: "menu" });
    expect(outlineRowKey(k("ContextMenu"), 0, 3, true)).toEqual({ kind: "menu" });
    // A control inside the row keeps its own keys.
    expect(outlineRowKey(k("Enter"), 0, 3, false)).toBeNull();
    expect(outlineRowKey(k("ArrowDown"), 0, 3, false)).toBeNull();
    expect(outlineRowKey(k("ArrowDown", { ctrlKey: true }), 0, 3, true)).toBeNull();
    expect(outlineRowKey(k("ArrowUp", { altKey: true, shiftKey: true }), 0, 3, true)).toBeNull();
    expect(outlineRowKey(k("x"), 0, 3, true)).toBeNull();
  });

  test("a drop is a run of up or down steps among siblings, snapped to a sibling's block, refused across parents", () => {
    expect(planDrop(tree, "a", "c", "after")).toEqual({ kind: "reorder", steps: ["down", "down"], line: { id: "c", edge: "after" } });
    expect(planDrop(tree, "d", "b", "before")).toEqual({ kind: "reorder", steps: ["up", "up"], line: { id: "b", edge: "before" } });
    expect(planDrop(tree, "a", "b", "before")).toEqual({ kind: "same" });
    expect(planDrop(tree, "a", "a", "after")).toEqual({ kind: "same" });
    expect(planDrop(tree, "a", "e", "before")).toEqual({ kind: "refused" });
    expect(planDrop(tree, "a", "c2", "before")).toEqual({ kind: "refused" });
    // A chapter over a scene in the other chapter snaps to that chapter's
    // nearer end: the upper half of c1's block is before c1.
    expect(planDrop(tree, "c2", "b", "before")).toEqual({ kind: "reorder", steps: ["up"], line: { id: "c1", edge: "before" } });
    expect(planDrop(tree, "c2", "d", "after")).toEqual({ kind: "same" });
    expect(planDrop(tree, "c1", "e", "after")).toEqual({ kind: "reorder", steps: ["down"], line: { id: "e", edge: "after" } });
    // Over its own subtree: no move.
    expect(planDrop(tree, "c1", "b", "after")).toEqual({ kind: "same" });
    expect(planDrop(tree, "gone", "b", "after")).toEqual({ kind: "refused" });
  });
});
