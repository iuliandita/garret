import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createMobileWorkspace, type MobileScene } from "../src/workspace";
import type { MobileDrafting, MobileComment } from "../src/drafting";
import { mobileMessages } from "../src/messages";

const body = (text: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const scenes: MobileScene[] = [{ id: "a", title: "Arrival", depth: 1 }, { id: "b", title: "Departure", depth: 1 }];
const structure = [
  { id: "chapter", parent_id: null, type: "chapter", title: "Before", rev: 1, depth: 0 },
  ...scenes.map(scene => ({ ...scene, parent_id: "chapter", type: "scene", rev: 4 })),
  { id: "later", parent_id: null, type: "chapter", title: "Later", rev: 7, depth: 0 },
];
const task = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(overrides: Partial<MobileDrafting> = {}, locale: "en" | "de" = "en", theme: "light" | "dark" = "light") {
  const host: MobileDrafting = {
    structure: async () => structure,
    rename: async () => scenes, move: async () => scenes,
    find: async () => ({ results: [], truncated: false, skipped: 0 }),
    goals: async () => ({ target: "500", today: 12, available: true, collecting: true }),
    notes: async () => ({ body: "Watch the tide" }), saveNotes: async () => {},
    reference: async () => ({ notes: [{ title: "Harbour", body: "A tidal port" }], cast: [{ name: "Ada", summary: "The captain", aliases: ["Skipper"], fields: [{ label: "Ship", value: "Ferry" }] }] }),
    comments: async () => [], resolve: async () => [], ...overrides,
  };
  const writes: string[] = []; const sizes: number[] = [];
  const mount = document.createElement("div"); document.body.append(mount);
  const workspace = createMobileWorkspace(mount, {
    bookTitle: "The Ferry", scenes, locale, theme,
    initial: { item_id: "a", body: body("Tide at dawn, tide at dusk"), rev: 1, comments: [] },
    loadDoc: async id => ({ item_id: id, body: body("A different tide"), rev: 1, comments: [] }),
    flush: async entries => { writes.push(...entries.map(entry => entry.body)); return entries.map(entry => ({ item_id: entry.item_id, rev: entry.base_rev + 1 })); },
    drafting: host, localDay: () => "2026-10-17", onLeave: () => {},
    textSize: 22, saveTextSize: size => { sizes.push(size); return true; },
  });
  return { mount, workspace, writes, sizes, m: mobileMessages(locale) };
}
function click(root: ParentNode, text: string) {
  const control = [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text);
  if (!control) throw new Error(`Missing button: ${text}`);
  control.click();
}
async function ready(mount: HTMLElement) {
  for (let n = 0; n < 30; n++) {
    const dialog = mount.querySelector<HTMLDialogElement>(".mobile-drafting");
    if (dialog && dialog.getAttribute("aria-busy") === "false") return dialog;
    await task();
  }
  throw new Error("Tool did not become ready");
}
async function open(f: ReturnType<typeof fixture>, title: string) {
  f.mount.querySelector<HTMLButtonElement>('[data-action="outline"]')!.click();
  click(f.mount.querySelector(".mobile-outline")!, title);
  return ready(f.mount);
}
async function finish(f: ReturnType<typeof fixture>) {
  f.workspace.back(); await task(); expect(await f.workspace.close()).toBe(true); f.mount.remove();
}

test("mobile rename and move use the selected scene and fresh item revision, then reload the acknowledged outline", async () => {
  const calls: unknown[] = [];
  const f = fixture({
    structure: async () => [...structure, ...["part", "chapter"].map(type => ({ id: `empty-${type}`, type, title: "", parent_id: null, depth: 0, rev: 1 }))],
    rename: async (...args) => { calls.push(args); return [{ ...scenes[0], title: "Renamed" }, scenes[1]]; },
    move: async (...args) => { calls.push(args); return [scenes[1], { ...scenes[0], title: "Renamed", context: [{ id: "later", title: "Later", kind: "chapter" }] }]; },
  });
  const rename = await open(f, f.m.rename);
  rename.querySelector("input")!.value = "Renamed";
  rename.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await task(); await task();
  expect(calls[0]).toEqual(["a", "Renamed", 4]); expect(f.mount.querySelector("h1")!.textContent).toBe("Renamed");
  const move = await open(f, f.m.move);
  const selects = move.querySelectorAll("select");
  expect(selects[0].querySelector('option[value="empty-part"]')!.textContent).toBe(f.m.untitledPart);
  expect(selects[0].querySelector('option[value="empty-chapter"]')!.textContent).toBe(f.m.untitledChapter);
  expect([...selects[0].options].some(option => option.value === "a")).toBe(false);
  selects[0].value = "later"; selects[0].dispatchEvent(new Event("change"));
  expect(selects[1].options.length).toBe(1);
  move.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await task(); await task();
  expect(calls[1]).toEqual(["a", "later", null, 4]);
  expect([...f.mount.querySelectorAll(".mobile-outline nav button")].map(button => button.textContent)).toEqual(["Departure", "Renamed"]);
  expect(f.mount.querySelector("h3")!.textContent).toBe("Later"); expect(f.writes).toHaveLength(0);
  await finish(f);
});

test("mobile search selects occurrences without writing and opens book results with the desktop match locator", async () => {
  let search: unknown;
  const f = fixture({ find: async (...args) => { search = args; return { results: [{ item_id: "b", title: "Departure", snippet: "A different tide", matches: 1 }], truncated: true, skipped: 1 }; } });
  let dialog = await open(f, f.m.search); dialog.querySelector("input")!.value = "tide";
  dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(dialog.querySelectorAll("nav button")).toHaveLength(2);
  (dialog.querySelectorAll("nav button")[1] as HTMLButtonElement).click(); await task();
  expect(f.workspace.editor.selection()).toEqual({ from: 15, to: 19 });
  dialog = await open(f, f.m.search); dialog.querySelector("input")!.value = "tide";
  click(dialog, f.m.searchBook); dialog = await ready(f.mount);
  expect(search).toEqual(["tide", "a"]); expect(dialog.textContent).toContain(f.m.searchLimited); expect(dialog.textContent).toContain(f.m.searchSkipped);
  dialog.querySelector<HTMLButtonElement>("nav button")!.click(); await task(); await task();
  expect(f.mount.querySelector("h1")!.textContent).toBe("Departure"); expect(f.workspace.editor.selection()).toEqual({ from: 13, to: 17 }); expect(f.writes).toHaveLength(0);
  await finish(f);
});

test("mobile goals preserve negative daily progress and save canonical custom targets for the local day", async () => {
  const calls: unknown[] = [];
  const f = fixture({ goals: async (...args) => { calls.push(args); return { target: args[1] ?? "750", today: -12, collecting: false, available: true }; } });
  const dialog = await open(f, f.m.goals);
  expect(dialog.textContent).toContain("-12 / 750"); expect(dialog.textContent).toContain(f.m.goalPaused);
  dialog.querySelector("input")!.value = "1250";
  dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await ready(f.mount);
  expect(calls).toEqual([["2026-10-17"], ["2026-10-17", "1250"]]); expect(dialog.textContent).toContain("1,250");
  await finish(f);
});

test("mobile notes read and save the captured scene's synopsis, preserve drafts after failure and stay separate from prose", async () => {
  let fail = true; const saved: unknown[] = [];
  const f = fixture({ saveNotes: async (...args) => { saved.push(args); if (fail) throw new Error("disk full"); } });
  const before = f.workspace.editor.serialize(); const dialog = await open(f, f.m.notes);
  const textarea = dialog.querySelector("textarea")!; expect(textarea.value).toBe("Watch the tide"); textarea.value = "A new note";
  click(dialog, f.m.saveAction); await ready(f.mount);
  expect(dialog.querySelector<HTMLElement>("[role=alert]")!.hidden).toBe(false); expect(textarea.value).toBe("A new note");
  fail = false; click(dialog, f.m.saveAction); await ready(f.mount);
  expect(saved).toEqual([["a", "A new note"], ["a", "A new note"]]); expect(dialog.textContent).toContain(f.m.saved);
  expect(f.workspace.editor.serialize()).toBe(before); expect(f.writes).toHaveLength(0); await finish(f);
});

test("mobile reference lookup searches aliases and fields and exposes no editing controls", async () => {
  const f = fixture(); const before = f.workspace.editor.serialize(); const dialog = await open(f, f.m.reference);
  expect(dialog.querySelectorAll("details")).toHaveLength(2);
  const input = dialog.querySelector("input")!; input.value = "Skipper"; input.dispatchEvent(new Event("input"));
  expect(dialog.querySelectorAll("details")).toHaveLength(1); expect(dialog.querySelector("summary")!.textContent).toBe("Ada");
  input.value = "Ferry"; input.dispatchEvent(new Event("input")); expect(dialog.textContent).toContain("Ship: Ferry");
  input.value = "missing"; input.dispatchEvent(new Event("input")); expect(dialog.textContent).toContain(f.m.noReferences);
  expect(dialog.querySelectorAll("textarea,form")).toHaveLength(0); expect(dialog.querySelectorAll("button")).toHaveLength(1);
  expect(f.workspace.editor.serialize()).toBe(before); await finish(f);
});

test("mobile comments retain quotes and orphan status and refresh resolved editor anchors after acknowledgment", async () => {
  const comment: MobileComment = { id: 7, body: "Check the tide", quote: "Tide", anchor_from: 1, anchor_to: 5, orphaned: false, resolved: false };
  const calls: unknown[] = [];
  const f = fixture({ comments: async () => [comment, { ...comment, id: 8, orphaned: true, quote: "Lost" }], resolve: async (...args) => { calls.push(args); return [{ ...comment, resolved: true }]; } });
  const before = f.workspace.editor.serialize(); const dialog = await open(f, f.m.comments);
  expect(dialog.textContent).toContain("Lost"); expect(dialog.textContent).toContain(f.m.orphaned);
  (dialog.querySelectorAll("article button")[1] as HTMLButtonElement).click(); await ready(f.mount);
  expect(calls).toEqual([["a", 7]]); expect(dialog.textContent).toContain(f.m.resolved);
  expect(f.workspace.editor.commentAnchors()[0].resolved).toBe(true); expect(f.workspace.editor.serialize()).toBe(before); expect(f.writes).toHaveLength(0);
  await finish(f);
});

test("mobile tools localize in both themes and text size uses the acknowledged device preference without changing prose", async () => {
  for (const locale of ["en", "de"] as const) for (const theme of ["light", "dark"] as const) {
    const f = fixture({}, locale, theme); const before = f.workspace.editor.serialize();
    const dialog = await open(f, f.m.textSize);
    expect(dialog.getAttribute("aria-label")).toBe(f.m.textSize); expect(f.mount.querySelector<HTMLElement>("section")!.dataset.theme).toBe(theme);
    expect(f.mount.querySelector<HTMLElement>("section")!.style.getPropertyValue("--prose-size")).toBe("22px");
    const input = dialog.querySelector("input")!; input.value = "26"; input.dispatchEvent(new Event("input"));
    expect(f.sizes).toEqual([26]); expect(f.mount.querySelector<HTMLElement>("section")!.style.getPropertyValue("--prose-size")).toBe("26px");
    expect(f.workspace.editor.serialize()).toBe(before); expect(f.writes).toHaveLength(0); await finish(f);
  }
});

test("mobile tool reads wait for saved prose and pending operations block Back and book departure", async () => {
  let answer!: () => void; let reads = 0;
  const f = fixture({ notes: () => { reads++; return new Promise(resolve => { answer = () => resolve({ body: "Saved note" }); }); } });
  f.workspace.editor.typeChar("new writing");
  f.mount.querySelector<HTMLButtonElement>('[data-action="outline"]')!.click(); click(f.mount.querySelector(".mobile-outline")!, f.m.notes);
  await task(); expect(f.writes).toHaveLength(1); expect(reads).toBe(1);
  const before = f.workspace.editor.serialize(); f.workspace.editor.typeChar("blocked"); expect(f.workspace.editor.serialize()).toBe(before);
  f.workspace.back(); expect(f.mount.querySelector<HTMLDialogElement>(".mobile-drafting")!.open).toBe(true); expect(await f.workspace.close()).toBe(false);
  answer(); const dialog = await ready(f.mount); expect(dialog.querySelector("textarea")!.value).toBe("Saved note"); await finish(f);
});
