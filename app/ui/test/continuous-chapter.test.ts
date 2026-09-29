import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { chapterWindow, CONTINUOUS_WINDOW, createContinuousChapter } from "../src/continuous-chapter";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, type: string, parent_id: string | null, depth: number): ProjectItem =>
  ({ id, type, parent_id, depth, title: `Title ${id}`, position: id, rev: 1, state: null });
const body = (text: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => { document.body.replaceChildren(); delete document.body.dataset.continuousOpen; });

describe("continuous chapter", () => {
  test("scopes nearest chapter by id, excludes binned scenes, and bounds the visible window", () => {
    const scenes = Array.from({ length: 45 }, (_, n) => item(`s${n}`, "scene", "chapter", 2));
    const walk = [item("bin", "trash", null, 0), item("gone", "scene", "bin", 1), item("part", "part", null, 0), item("chapter", "chapter", "part", 1), ...scenes, item("other", "chapter", "part", 1), item("s-other", "scene", "other", 2)];
    const result = chapterWindow(walk, "s31");
    expect(result?.scope).toBe("Title chapter");
    expect(result?.total).toBe(45);
    expect(result?.scenes).toHaveLength(CONTINUOUS_WINDOW);
    expect(result?.scenes[0]?.id).toBe("s25");
    expect(result?.scenes.at(-1)?.id).toBe("s44");
    expect(chapterWindow(walk, "gone")).toBeNull();
    const loose = [item("loose-a", "scene", null, 0), item("nested", "scene", "loose-a", 1), item("loose-b", "scene", null, 0), item("part", "part", null, 0), item("chapter", "chapter", "part", 1), item("held", "scene", "chapter", 2)];
    expect(chapterWindow(loose, "nested")?.scenes.map((scene) => scene.id)).toEqual(["loose-a", "nested", "loose-b"]);
    expect(chapterWindow(loose, "nested")?.scope).toContain("Loose scenes");
  });

  test("keeps the one editor mounted while switching, and ignores a stale saved read", async () => {
    const pane = document.createElement("main");
    pane.id = "editor";
    const heading = document.createElement("h1");
    heading.id = "scene-heading";
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    pane.append(heading, editor);
    document.body.append(pane);
    const items = [item("chapter", "chapter", null, 0), item("s1", "scene", "chapter", 1), item("s2", "scene", "chapter", 1), item("s3", "scene", "chapter", 1)];
    let active = "s2";
    let release: (value: { body: string; rev: number }) => void = () => undefined;
    const pending = new Promise<{ body: string; rev: number }>((resolve) => { release = resolve; });
    const activated: string[] = [];
    const view = createContinuousChapter({ heading, editor, items,
      activeId: () => active,
      readDocument: (id) => id === "s1" ? pending : Promise.resolve({ body: body(id), rev: 1 }),
      activate: async (id) => { activated.push(id); active = id; view.activeChanged(id); },
      onReturn: () => view.exit(), onError: () => undefined,
    });
    expect(view.enter()).toBe(true);
    expect(pane.querySelectorAll(".ProseMirror")).toHaveLength(1);
    view.beforeSwap("s2", body("latest s2"));
    pane.querySelector<HTMLButtonElement>('[data-item-id="s1"] button')?.click();
    await tick();
    expect(activated).toEqual(["s1"]);
    release({ body: body("stale s1"), rev: 1 });
    await tick();
    expect(pane.querySelector('[data-item-id="s2"]')?.textContent).toContain("latest s2");
    expect(pane.querySelectorAll(".ProseMirror")).toHaveLength(1);
    expect(heading.nextElementSibling).toBe(editor);
    view.exit();
    expect(pane.querySelectorAll(".continuous-scene")).toHaveLength(0);
    view.destroy();
  });

  test("re-entry refreshes saved neighbors and previous pages move by a full window", async () => {
    const pane = document.createElement("main");
    const heading = document.createElement("h1");
    const editor = document.createElement("div");
    pane.append(heading, editor); document.body.append(pane);
    const items = [item("chapter", "chapter", null, 0), ...Array.from({ length: 60 }, (_, n) => item(`s${n}`, "scene", "chapter", 1))];
    let active = "s20";
    let saved = "original neighbor";
    const view = createContinuousChapter({ heading, editor, items, activeId: () => active,
      readDocument: async () => ({ body: body(saved), rev: 1 }),
      activate: async (id) => { active = id; view.activeChanged(id); },
      onReturn: () => view.exit(), onError: () => undefined });
    view.enter(); await tick();
    expect(pane.querySelector('[data-item-id="s21"]')?.textContent).toContain("original neighbor");
    view.exit(); saved = "edited while closed";
    view.enter(); await tick();
    expect(pane.querySelector('[data-item-id="s21"]')?.textContent).toContain("edited while closed");
    view.page(-1); await tick();
    expect(active).toBe("s0");
    view.page(1); await tick();
    expect(active).toBe("s20");
    view.destroy();
  });

  test("reorders by stable ids, exits when the active scene is binned, and refuses cross-boundary selection", async () => {
    const pane = document.createElement("main");
    const heading = document.createElement("h1");
    const editor = document.createElement("div");
    const inside = document.createTextNode("editable"); editor.append(inside);
    pane.append(heading, editor); document.body.append(pane);
    const chapter = item("chapter", "chapter", null, 0);
    const first = item("s1", "scene", "chapter", 1);
    const second = item("s2", "scene", "chapter", 1);
    const view = createContinuousChapter({ heading, editor, items: [chapter, first, second], activeId: () => "s1",
      readDocument: async () => ({ body: body("second"), rev: 1 }), activate: async () => undefined,
      onReturn: () => undefined, onError: () => undefined });
    view.enter(); await tick();
    const outside = pane.querySelector('[data-item-id="s2"] .continuous-prose p')?.firstChild;
    expect(outside).toBeTruthy();
    const selection = document.getSelection()!;
    const range = document.createRange(); range.setStart(inside, 0); range.setEnd(outside!, 1);
    selection.removeAllRanges(); selection.addRange(range);
    expect(view.crossBoundarySelection()).toBe(true);
    selection.removeAllRanges();
    view.setItems([chapter, { ...second, title: "Renamed" }, first]);
    expect(pane.querySelector(".continuous-before")?.textContent).toContain("Renamed");
    view.setItems([item("bin", "trash", null, 0), { ...first, parent_id: "bin" }, chapter, second]);
    expect(view.isOpen()).toBe(false);
    view.destroy();
  });
});
