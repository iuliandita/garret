import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createCraftPanel } from "../src/craft-panel";
import type { ProjectItem } from "../src/store/source";

const scene: ProjectItem = { id: "s1", parent_id: null, type: "scene", title: "Scene", position: "a", rev: 1, state: null, depth: 0 };
const body = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "one one blue dark sea blue dark sea." }] }] });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1500;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("craft panel did not reach the expected state");
    await settle();
  }
};

describe("knowledge and craft panel", () => {
  test("reads saved prose after draining and rejects a stale finding before navigation", async () => {
    const container = document.createElement("span"); document.body.append(container);
    const calls: string[] = [];
    let nav = 0;
    const panel = createCraftPanel({ container, generation: 1, items: () => [scene], selectedId: () => scene.id,
      drain: async () => { calls.push("drain"); panel.sourceChanged(scene.id); }, failed: () => false, anchor: () => null,
      openPassage: async () => false,
      openFinding: async () => { nav++; return true; }, onNotice: () => undefined, onDismiss: () => undefined,
      invoke: async (cmd) => {
        calls.push(cmd);
        if (cmd === "doc_load") return { body, rev: 3 };
        if (cmd === "appearances_list") return {};
        return [];
      },
    });
    try {
      await panel.open("reports");
      const run = [...container.querySelectorAll<HTMLButtonElement>("#craft-reports button")]
        .find((button) => button.textContent?.includes("Run"));
      expect(run).toBeDefined(); run!.click();
      await waitFor(() => container.querySelector(".craft-finding") !== null);
      expect(calls.indexOf("drain")).toBeLessThan(calls.indexOf("doc_load"));
      const finding = container.querySelector<HTMLButtonElement>(".craft-finding");
      expect(finding?.textContent).toContain("one one");
      expect(container.querySelector("#craft-status")?.textContent).toContain("Report ready");
      panel.sourceChanged(scene.id);
      finding?.click(); await settle();
      expect(nav).toBe(0);
      expect(container.querySelector("#craft-status")?.textContent).toContain("The text changed; run the report again");
    } finally { panel.destroy(); container.remove(); }
  });

  test("canceling a deferred document read leaves no result and permits a fresh run", async () => {
    const container = document.createElement("span"); document.body.append(container);
    let finish: (value: { body: string; rev: number }) => void = () => undefined;
    let reads = 0;
    const panel = createCraftPanel({ container, generation: 1, items: () => [scene], selectedId: () => scene.id,
      drain: async () => undefined, failed: () => false, anchor: () => null,
      openPassage: async () => false,
      openFinding: async () => true, onNotice: () => undefined, onDismiss: () => undefined,
      invoke: async (cmd) => {
        if (cmd === "doc_load") {
          reads++;
          if (reads === 1) return await new Promise<{ body: string; rev: number }>((resolve) => { finish = resolve; });
          return { body, rev: 4 };
        }
        if (cmd === "appearances_list") return {};
        return [];
      },
    });
    try {
      await panel.open("reports");
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("#craft-reports button")];
      const run = buttons.find((button) => button.textContent?.includes("Run"))!;
      const cancel = buttons.find((button) => button.textContent?.includes("Cancel"))!;
      run.click(); await waitFor(() => reads === 1);
      cancel.click();
      expect(run.disabled).toBe(false);
      expect(reads).toBe(1);
      finish({ body, rev: 3 }); await settle();
      expect(container.querySelector(".craft-finding")).toBeNull();
      run.click(); await waitFor(() => container.querySelector(".craft-finding") !== null);
      expect(reads).toBe(2);
      expect(container.querySelector(".craft-finding")).not.toBeNull();
    } finally { panel.destroy(); container.remove(); }
  });

  test("freezes a passage draft through save drain and refuses a closed panel's delayed write", async () => {
    const container = document.createElement("span"); document.body.append(container);
    let finishDrain: () => void = () => undefined;
    let drains = 0;
    const writes: Record<string, unknown>[] = [];
    const panel = createCraftPanel({ container, generation: 7, items: () => [scene], selectedId: () => scene.id,
      drain: async () => { drains++; await new Promise<void>((resolve) => { finishDrain = resolve; }); },
      failed: () => false, anchor: () => ({ item_id: scene.id, from: 1, to: 4, quote: "one" }),
      openPassage: async () => false, openFinding: async () => false,
      onNotice: () => undefined, onDismiss: () => undefined,
      invoke: async (cmd, args) => {
        if (cmd === "knowledge_link_create") writes.push(args ?? {});
        if (cmd === "doc_load") return { rev: 3 };
        return [];
      },
    });
    try {
      await panel.open("knowledge");
      const label = container.querySelector<HTMLInputElement>("#craft-link-label")!;
      const target = container.querySelectorAll<HTMLSelectElement>("#craft-knowledge select")[1]!;
      const anchor = container.querySelector<HTMLInputElement>("#craft-knowledge input[type=checkbox]")!;
      target.value = "item:s1"; anchor.checked = true; label.value = "from first draft";
      container.querySelector<HTMLButtonElement>("#craft-add-link")!.click();
      await waitFor(() => drains === 1);
      label.value = "later edit"; finishDrain();
      await waitFor(() => writes.length === 1);
      expect(writes[0]?.generation).toBe(7);
      expect((writes[0]?.draft as { label: string }).label).toBe("from first draft");
      await waitFor(() => !container.querySelector<HTMLButtonElement>("#craft-add-link")!.disabled);
      container.querySelector<HTMLButtonElement>("#craft-add-link")!.click();
      await waitFor(() => drains === 2);
      panel.close(); finishDrain(); await settle();
      expect(writes.length).toBe(1);
    } finally { panel.destroy(); container.remove(); }
  });

  test("serializes watchlist writes and hides late import errors after reopening", async () => {
    const container = document.createElement("span"); document.body.append(container);
    let finishWatch: () => void = () => undefined;
    let rejectImport: (reason: Error) => void = () => undefined;
    const notices: string[] = [];
    let watchWrites = 0;
    const panel = createCraftPanel({ container, generation: 9, items: () => [scene], selectedId: () => scene.id,
      drain: async () => undefined, failed: () => false, anchor: () => null,
      openPassage: async () => false, openFinding: async () => false,
      onNotice: (message) => notices.push(message), onDismiss: () => undefined,
      invoke: async (cmd, args) => {
        if (cmd === "craft_watchlist_set") {
          watchWrites++; expect(args?.generation).toBe(9);
          await new Promise<void>((resolve) => { finishWatch = resolve; });
        }
        if (cmd === "research_import_pick") return await new Promise((_, reject) => { rejectImport = reject; });
        return [];
      },
    });
    try {
      await panel.open("reports");
      container.querySelector<HTMLInputElement>("#craft-watch-text")!.value = "harbor";
      const add = [...container.querySelectorAll<HTMLButtonElement>("#craft-reports button")][0]!;
      add.click(); add.click();
      expect(watchWrites).toBe(1);
      finishWatch(); await waitFor(() => !add.disabled);
      expect(container.querySelector("#craft-watchlist")?.textContent).toContain("harbor");
      await panel.open("knowledge");
      container.querySelector<HTMLButtonElement>("#craft-import-file")!.click();
      panel.close(); await panel.open("knowledge");
      rejectImport(new Error("old project's file chooser failed")); await settle();
      expect(notices).toEqual([]);
      expect(container.querySelector("#craft-status")?.textContent).not.toContain("old project's");
    } finally { panel.destroy(); container.remove(); }
  });
});


test("relationships reread on switch, disclose changed anchors and discard closed or destroyed reads", async () => {
  const container = document.createElement("span"); document.body.append(container);
  let caption = "Original"; let reads = 0;
  let pending: ((value: unknown) => void) | null = null;
  let delay = false;
  const rows = () => [{ id: "l1", source: { kind: "item", id: scene.id }, target: { kind: "cast", id: "c1" },
    source_caption: scene.title, target_caption: caption, source_available: true, target_available: true,
    label: "knows", note: "", citation: "", anchor: { item_id: scene.id, quote: "before", doc_rev: 1, from: 1, to: 2 }, anchor_stale: false }];
  const panel = createCraftPanel({ container, generation: 1, items: () => [scene], selectedId: () => scene.id,
    drain: async () => undefined, failed: () => false, anchor: () => null,
    openPassage: async () => false, openFinding: async () => false, onNotice: () => undefined, onDismiss: () => undefined,
    invoke: async (cmd) => {
      if (cmd === "knowledge_links") { reads++; if (delay) return await new Promise((resolve) => { pending = resolve; }); return rows(); }
      return [];
    },
  });
  try {
    await panel.open("relationships");
    expect(container.querySelector<HTMLElement>("#craft-relationships")!.hidden).toBe(false);
    expect(container.querySelector("#relationship-list")?.textContent).toContain("Original");
    panel.sourceChanged(scene.id);
    expect(container.querySelector("#relationship-list")?.textContent).toContain("passage changed");
    caption = "Updated";
    const tab = [...container.querySelectorAll<HTMLButtonElement>("#craft-views > button")].find((b) => b.textContent === "Relationships")!;
    tab.click(); await waitFor(() => container.querySelector("#relationship-list")?.textContent?.includes("Updated") === true);
    expect(reads).toBe(2);
    delay = true;
    const opening = panel.open("relationships"); await waitFor(() => pending !== null);
    panel.close(); caption = "Late"; pending!(rows()); await opening;
    expect(container.querySelector("#relationship-list")?.textContent).not.toContain("Late");
    pending = null;
    const destroyed = panel.open("relationships"); await waitFor(() => pending !== null);
    panel.destroy(); pending!(rows()); await destroyed;
    expect(container.querySelector("#craft-panel") !== null).toBe(false);
  } finally { panel.destroy(); container.remove(); }
});
