import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createMobileWorkspace, type MobileDocument, type MobileWorkspaceOptions } from "../src/workspace";
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
