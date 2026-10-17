import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { expect, test } from "bun:test";
import { storyIds } from "../src/collection";
import { planPlacement } from "../src/placement";
import { createStoryPanel, type StoryFields } from "../src/story-panel";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, parent_id: string | null, type: string, depth: number): ProjectItem =>
  ({ id, parent_id, type, depth, title: id, state: null, position: "0000", rev: 1 });

test("collections recognize outer chapters and place new stories without parts", () => {
  const items = [item("a", null, "chapter", 0), item("s1", "a", "scene", 1), item("section", "a", "chapter", 1), item("p", null, "part", 0), item("b", "p", "chapter", 1), item("s2", "b", "scene", 2)];
  expect([...storyIds(items)]).toEqual(["a", "b"]);
  expect(planPlacement(items, "s1", "chapter", "collection")).toEqual({ holders: [], parentId: null, afterId: "a" });
  expect(planPlacement(items, "s2", "scene", "collection")).toEqual({ holders: [], parentId: "b", afterId: "s2" });
  expect(planPlacement([], null, "chapter", "collection")).toEqual({ holders: [], parentId: null, afterId: null });
});

test("story fields capture their row, save before export, and stop on a failed save", async () => {
  const original: StoryFields = { id: "second", title: "Forest", author: null, state: "draft", rev: 7 };
  const saved: StoryFields[] = [];
  const exports: string[][] = [];
  const errors: string[] = [];
  let fail = false;
  const panel = createStoryPanel({
    read: async () => original,
    save: async (story) => { if (fail) throw new Error("conflict"); saved.push(story); },
    export: (id, format) => { exports.push([id, format]); },
    notice: (message) => { errors.push(message); }, returnFocus: () => {},
  });
  try {
    await panel.open("second");
    const title = document.getElementById("story-title") as HTMLInputElement;
    const author = document.getElementById("story-author") as HTMLInputElement;
    const status = document.getElementById("story-status") as HTMLSelectElement;
    title.value = "The Forest"; author.value = "Ada Lane"; status.value = "done";
    document.getElementById("story-export-epub")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([{ ...original, title: "The Forest", author: "Ada Lane", state: "done" }]);
    expect(exports).toEqual([["second", "epub"]]);
    await panel.open("second");
    fail = true;
    document.getElementById("story-export-pdf")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exports).toHaveLength(1);
    expect(errors[0]).toContain("conflict");
    expect(document.getElementById("story-panel")!.hidden).toBe(false);
  } finally { panel.destroy(); }
});
