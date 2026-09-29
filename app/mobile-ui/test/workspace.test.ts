import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createMobileWorkspace, type MobileDocument, type MobileWorkspaceOptions } from "../src/workspace";
import { openingScene, readWritingPosition, writeWritingPosition, type WritingPosition } from "../src/position";
import type { FlushEntry } from "../../ui/src/store/flush";

function doc(item_id: string, text: string, rev = 3): MobileDocument {
  return { item_id, rev, comments: [], body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) };
}
function fixture(overrides: Partial<MobileWorkspaceOptions> = {}) {
  const writes: FlushEntry[][] = [];
  const mount = document.createElement("div");
  document.body.append(mount);
  const workspace = createMobileWorkspace(mount, {
    bookTitle: "The Night Ferry", locale: "en", theme: "light",
    scenes: [{ id: "a", title: "The landing", depth: 0 }, { id: "b", title: "At sea", depth: 1 }],
    initial: doc("a", "Before dawn"), loadDoc: async id => doc(id, "A different scene", 9),
    flush: async entries => { writes.push(entries); return entries.map(entry => ({ item_id: entry.item_id, rev: entry.base_rev + 1 })); },
    localDay: () => "2026-09-25", onLeave: () => {}, ...overrides,
  });
  return { workspace, mount, writes };
}

test("the footer uses the singular word in both languages", async () => {
  for (const [locale, singular, plural] of [["en", "1 word", "3 words"], ["de", "1 Wort", "3 Wörter"]] as const) {
    const f = fixture({ locale, initial: doc("a", "Before") });
    const count = f.mount.querySelector(".mobile-words")!;
    expect(count.textContent).toBe(singular);
    await f.workspace.openScene("b");
    expect(count.textContent).toBe(plural);
    await f.workspace.close(); f.mount.remove();
  }
});

test("switching saves the outgoing scene and its mapped notes before loading another", async () => {
  const initial = doc("a", "Before dawn");
  initial.comments = [{ id: 4, from: 2, to: 5, resolved: false }];
  const f = fixture({ initial });
  f.workspace.editor.typeChar("x");
  expect(await f.workspace.openScene("b")).toBe(true);
  expect(f.writes[0][0].item_id).toBe("a");
  expect(f.writes[0][0].base_rev).toBe(3);
  expect(f.writes[0][0].comments).toEqual([{ id: 4, from: 3, to: 6 }]);
  f.workspace.editor.typeChar("y");
  await f.workspace.drain();
  expect(f.writes[1][0].item_id).toBe("b");
  expect(f.writes[1][0].base_rev).toBe(9);
  expect(f.writes[1][0].comments).toBeUndefined();
  expect(f.mount.querySelector("h1")!.textContent).toBe("At sea");
  await f.workspace.close(); f.mount.remove();
});

test("an in-flight scene read freezes edits and refuses a concurrent departure", async () => {
  let answer!: (doc: MobileDocument) => void;
  const f = fixture({ loadDoc: () => new Promise(resolve => { answer = resolve; }) });
  const pending = f.workspace.openScene("b");
  await Promise.resolve(); await Promise.resolve();
  const before = f.workspace.editor.serialize();
  f.workspace.editor.typeChar("must not land");
  expect(f.workspace.editor.serialize()).toBe(before);
  expect(await f.workspace.close()).toBe(false);
  answer(doc("b", "After loading"));
  expect(await pending).toBe(true);
  await f.workspace.close(); f.mount.remove();
});

test("unknown content refuses a scene switch without losing the outgoing prose", async () => {
  const newer = doc("b", "New scene");
  newer.body = JSON.stringify({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "new format" }] }] });
  const f = fixture({ loadDoc: async () => newer });
  const before = f.workspace.editor.serialize();
  expect(await f.workspace.openScene("b")).toBe(false);
  expect(f.workspace.editor.serialize()).toBe(before);
  expect(f.mount.querySelector("h1")!.textContent).toBe("The landing");
  expect(f.mount.querySelector<HTMLElement>(".mobile-error")!.hidden).toBe(false);
  await f.workspace.close(); f.mount.remove();
});

test("save failure keeps prose mounted and blocks departure and same-scene error clearing", async () => {
  const f = fixture({ flush: async () => { throw new Error("disk full"); } });
  f.workspace.editor.typeChar("unsaved");
  const before = f.workspace.editor.serialize();
  expect(await f.workspace.close()).toBe(false);
  expect(await f.workspace.openScene("a")).toBe(false);
  expect(f.workspace.editor.serialize()).toBe(before);
  expect(f.mount.querySelector(".mobile-save")!.textContent).toBe("Not saved");
  expect(f.mount.querySelector<HTMLElement>(".mobile-error")!.hidden).toBe(false);
  // Simulate document destruction only after asserting the refused public close.
  f.workspace.editor.destroy(); f.mount.remove();
});

test("background drain sends the last edit and saved appears only after acknowledgement", async () => {
  let acknowledge!: () => void;
  const f = fixture({ flush: entries => new Promise(resolve => { acknowledge = () => resolve(entries.map(e => ({ item_id: e.item_id, rev: e.base_rev + 1 }))); }) });
  f.workspace.editor.typeChar("last edit");
  window.dispatchEvent(new Event("pagehide"));
  await Promise.resolve();
  expect(f.mount.querySelector(".mobile-save")!.textContent).toBe("Saving...");
  acknowledge();
  expect(await f.workspace.drain()).toBe(true);
  expect(f.mount.querySelector(".mobile-save")!.textContent).toBe("Saved on this device");
  await f.workspace.close(); f.mount.remove();
});

test("native close failure retains the editor and allows another guarded close", async () => {
  let fail = true;
  const f = fixture({ beforeLeave: async () => { if (fail) throw new Error("checkpoint failed"); } });
  f.workspace.editor.typeChar("still here");
  const before = f.workspace.editor.serialize();
  expect(await f.workspace.close()).toBe(false);
  expect(f.workspace.editor.serialize()).toBe(before);
  expect(f.mount.querySelector(".mobile-prose") !== null).toBe(true);
  fail = false;
  expect(await f.workspace.close()).toBe(true);
  expect(f.mount.querySelector(".mobile-prose") !== null).toBe(false);
  f.mount.remove();
});


const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

function showOutline(mount: HTMLElement): HTMLDialogElement {
  mount.querySelector<HTMLButtonElement>('[data-action="outline"]')!.click();
  return mount.querySelector<HTMLDialogElement>(".mobile-outline")!;
}

async function settled(mount: HTMLElement) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (mount.querySelector("section")!.getAttribute("aria-busy") !== "true") return;
    await nextTask();
  }
  throw new Error("mobile operation did not settle");
}

test("device-local positions survive a fresh read, remain book-specific and reject damaged records", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const position = { sceneId: "b", from: 3, to: 6, scrollTop: 240 };
  writeWritingPosition(storage, "ferry", position);
  expect(readWritingPosition(storage, "ferry")).toEqual(position);
  expect(readWritingPosition(storage, "another book")).toBeUndefined();
  const scenes = [{ id: "a" }, { id: "b" }];
  expect(openingScene(scenes, readWritingPosition(storage, "ferry"))?.id).toBe("b");
  expect(openingScene(scenes, { ...position, sceneId: "deleted" })?.id).toBe("a");
  const key = [...values.keys()][0];
  for (const invalid of ["broken json", "null", JSON.stringify({ ...position, from: -1 }), JSON.stringify({ ...position, to: 1 }), JSON.stringify({ ...position, scrollTop: "240" })]) {
    values.set(key, invalid);
    expect(readWritingPosition(storage, "ferry")).toBeUndefined();
  }
});

test("a reopened scene restores and clamps selection and scroll without changing manuscript bytes", async () => {
  const remembered: WritingPosition[] = [];
  const f = fixture({ initial: doc("b", "Short"), initialPosition: { sceneId: "b", from: 3, to: 900, scrollTop: 800 }, savePosition: position => remembered.push(position) });
  const page = f.mount.querySelector<HTMLElement>(".mobile-page")!;
  Object.defineProperties(page, { scrollHeight: { value: 700 }, clientHeight: { value: 300 } });
  const before = f.workspace.editor.serialize();
  await nextFrame();
  expect(f.workspace.editor.selection()).toEqual({ from: 3, to: 6 });
  expect(page.scrollTop).toBe(400);
  expect(remembered.at(-1)).toEqual({ sceneId: "b", from: 3, to: 6, scrollTop: 400 });
  expect(f.workspace.editor.serialize()).toBe(before);
  expect(f.writes).toHaveLength(0);
  await f.workspace.close(); f.mount.remove();
  const caret = fixture({ initialPosition: { sceneId: "a", from: 4, to: 4, scrollTop: 0 } });
  expect(caret.workspace.editor.selection()).toEqual({ from: 4, to: 4 });
  await caret.workspace.close(); caret.mount.remove();
});

test("backgrounding remembers a selection and scrolling, and scene changes replace the last position", async () => {
  const remembered: WritingPosition[] = [];
  const f = fixture({ savePosition: position => remembered.push(position) });
  await nextFrame();
  f.workspace.editor.restoreSelection(2, 5);
  const page = f.mount.querySelector<HTMLElement>(".mobile-page")!;
  page.scrollTop = 125;
  page.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("mobile-background"));
  expect(remembered.at(-1)).toEqual({ sceneId: "a", from: 2, to: 5, scrollTop: 125 });
  expect(await f.workspace.openScene("b")).toBe(true);
  expect(remembered.at(-1)?.sceneId).toBe("b");
  expect(remembered.at(-1)?.scrollTop).toBe(0);
  f.workspace.editor.restoreSelection(4, 4);
  await f.workspace.close();
  expect(remembered.at(-1)).toEqual({ sceneId: "b", from: 4, to: 4, scrollTop: 0 });
  f.mount.remove();
});

test("an immediate switch cannot apply the outgoing scene's delayed scroll restoration to the incoming scene", async () => {
  const remembered: WritingPosition[] = [];
  const f = fixture({ initialPosition: { sceneId: "a", from: 4, to: 4, scrollTop: 800 }, savePosition: position => remembered.push(position) });
  const page = f.mount.querySelector<HTMLElement>(".mobile-page")!;
  Object.defineProperties(page, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
  expect(await f.workspace.openScene("b")).toBe(true);
  await nextFrame();
  expect(page.scrollTop).toBe(0);
  expect(remembered.at(-1)?.sceneId).toBe("b");
  await f.workspace.close(); f.mount.remove();
});

test("position storage failure reports the problem without blocking writing or manuscript saving", async () => {
  const f = fixture({ savePosition: () => { throw new Error("storage unavailable"); } });
  await nextFrame();
  expect(f.mount.querySelector(".mobile-error")!.textContent).toContain("writing position");
  f.workspace.editor.typeChar("still writable");
  expect(await f.workspace.close()).toBe(true);
  expect(f.writes).toHaveLength(1);
  f.mount.remove();
});

test("Outline shows chapter and part context while only scenes are actionable", async () => {
  const part = { id: "p", title: "Part one", kind: "part" } as const;
  const f = fixture({ scenes: [
    { id: "a", title: "Arrival", depth: 2, context: [part, { id: "c1", title: "Before", kind: "chapter" }] },
    { id: "b", title: "Arrival", depth: 2, context: [part, { id: "c2", title: "After", kind: "chapter" }] },
  ] });
  const outline = showOutline(f.mount);
  expect([...outline.querySelectorAll("h3")].map(node => node.textContent)).toEqual(["Part one", "Before", "After"]);
  expect(outline.querySelectorAll("nav button")).toHaveLength(2);
  expect([...outline.querySelectorAll("nav button")].map(button => button.getAttribute("aria-label"))).toEqual(["Part one, Before, Arrival", "Part one, After, Arrival"]);
  expect(await f.workspace.openScene("p")).toBe(false);
  await f.workspace.close(); f.mount.remove();
});

test("a rejected scene load reports inside Outline and preserves the current scene", async () => {
  const f = fixture({ loadDoc: async () => { await nextTask(); throw new Error("read failed"); } });
  const outline = showOutline(f.mount);
  const before = f.workspace.editor.serialize();
  expect(await f.workspace.openScene("b")).toBe(false);
  const alert = outline.querySelector<HTMLElement>("[role=alert]")!;
  expect(outline.open).toBe(true);
  expect(alert.hidden).toBe(false);
  expect(alert.textContent).toContain("current scene is still here");
  expect(f.workspace.editor.serialize()).toBe(before);
  f.workspace.back();
  expect(outline.open).toBe(false);
  await nextTask();
  expect(f.mount.querySelector("section > .mobile-error")).not.toBeNull();
  await f.workspace.close(); f.mount.remove();
});

test("a delayed scene creation keeps a newer title draft and preserves the draft on failure", async () => {
  for (const fail of [false, true]) {
    let answer!: () => void;
    const f = fixture({ createScene: () => new Promise((resolve, reject) => {
      answer = () => fail ? reject(new Error("creation failed")) : resolve({ scenes: [{ id: "a", title: "The landing", depth: 0 }, { id: "b", title: "First draft", depth: 1 }], item_id: "b" });
    }) });
    const outline = showOutline(f.mount);
    const input = outline.querySelector<HTMLInputElement>("input")!;
    input.value = "First draft";
    outline.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await nextTask();
    input.value = "Second draft";
    answer();
    await settled(f.mount);
    expect(input.value).toBe("Second draft");
    if (fail) {
      expect(outline.open).toBe(true);
      expect(outline.querySelector<HTMLElement>("[role=alert]")!.hidden).toBe(false);
      expect(f.mount.querySelector("h1")!.textContent).toBe("The landing");
    } else expect(f.mount.querySelector("h1")!.textContent).toBe("First draft");
    await f.workspace.close(); f.mount.remove();
  }
});

test("native Back dismisses recovery before Outline or book departure and keeps unsaved text recoverable", async () => {
  let departed = 0;
  const f = fixture({ flush: async () => { throw new Error("disk full"); }, beforeLeave: async () => { departed++; } });
  f.workspace.editor.typeChar("unsaved writing");
  const outline = showOutline(f.mount);
  expect(await f.workspace.openScene("b")).toBe(false);
  const copy = outline.querySelector<HTMLButtonElement>(".mobile-error button")!;
  copy.click();
  const recovery = f.mount.querySelector<HTMLDialogElement>(".mobile-recovery")!;
  expect(recovery.open).toBe(true);
  expect(recovery.querySelector("textarea")!.value).toContain("unsaved writing");
  f.workspace.back();
  expect(recovery.open).toBe(false);
  expect(outline.open).toBe(true);
  expect(departed).toBe(0);
  await nextTask();
  copy.click();
  expect(f.mount.querySelector<HTMLDialogElement>(".mobile-recovery")!.open).toBe(true);
  f.workspace.back();
  f.workspace.back();
  expect(outline.open).toBe(false);
  expect(await f.workspace.close()).toBe(false);
  expect(departed).toBe(0);
  f.workspace.editor.destroy(); f.mount.remove();
});


test("closing before the initial animation frame persists the restored position and cancels delayed writes", async () => {
  const remembered: WritingPosition[] = [];
  const f = fixture({ initialPosition: { sceneId: "a", from: 4, to: 4, scrollTop: 200 }, savePosition: position => remembered.push(position) });
  const page = f.mount.querySelector<HTMLElement>(".mobile-page")!;
  Object.defineProperties(page, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
  expect(await f.workspace.close()).toBe(true);
  expect(remembered.at(-1)).toEqual({ sceneId: "a", from: 4, to: 4, scrollTop: 200 });
  const count = remembered.length;
  await nextFrame();
  expect(remembered).toHaveLength(count);
  f.mount.remove();
});


test("opening Outline brings an existing save failure and recovery action into the modal", async () => {
  let departed = 0;
  const f = fixture({ flush: async () => { throw new Error("disk full"); }, beforeLeave: async () => { departed++; } });
  f.workspace.editor.typeChar("unsaved before Outline");
  expect(await f.workspace.drain()).toBe(false);
  const alert = f.mount.querySelector<HTMLElement>("section > .mobile-error")!;
  const before = f.workspace.editor.serialize();
  expect(alert.hidden).toBe(false);
  const outline = showOutline(f.mount);
  expect(alert.parentElement === outline).toBe(true);
  const copy = alert.querySelector<HTMLButtonElement>("button")!;
  expect(outline.contains(copy)).toBe(true);
  copy.click();
  const recovery = f.mount.querySelector<HTMLDialogElement>(".mobile-recovery")!;
  expect(recovery.open).toBe(true);
  expect(recovery.querySelector("textarea")!.value).toContain("unsaved before Outline");
  f.workspace.back();
  expect(recovery.open).toBe(false);
  expect(outline.open).toBe(true);
  expect(departed).toBe(0);
  f.workspace.back();
  await nextTask();
  expect(outline.open).toBe(false);
  expect(alert.parentElement === f.mount.querySelector("section")).toBe(true);
  expect(f.workspace.editor.serialize()).toBe(before);
  f.workspace.editor.destroy(); f.mount.remove();
});
