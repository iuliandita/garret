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
  expect(planPlacement(items, "s2", "chapter", "collection")).toEqual({ holders: [], parentId: "p", afterId: "b" });
  expect(planPlacement(items, "s2", "scene", "collection")).toEqual({ holders: [], parentId: "b", afterId: "s2" });
  expect(planPlacement([], null, "chapter", "collection")).toEqual({ holders: [], parentId: null, afterId: null });
});

for (const selected of ["part", null]) {
  test(`collection scenes stay in stories with ${selected ?? "nothing"} selected`, () => {
    const part = item("part", null, "part", 0);
    expect(planPlacement([part], selected, "scene", "collection")).toEqual({
      holders: ["chapter"], parentId: selected, afterId: null,
    });
    const story = item("story", selected, "chapter", selected === null ? 0 : 1);
    const scene = item("scene", "story", "scene", story.depth + 1);
    const laterPart = item("later", null, "part", 0);
    const future = item("future", "later", "chapter", 1);
    const items = [part, story, scene, laterPart, future];
    expect(planPlacement(items, "scene", "scene", "collection")).toEqual({
      holders: [], parentId: "story", afterId: "scene",
    });
    expect(planPlacement(items, selected === null ? null : "later", "scene", "collection")).toEqual({
      holders: [], parentId: "future", afterId: null,
    });
  });
}

test("a selected collection part uses its last story, excluding sections and later parts", () => {
  const items = [
    item("earlier", null, "part", 0), item("a", "earlier", "chapter", 1),
    item("part", null, "part", 0), item("b", "part", "chapter", 1),
    item("nested", "part", "part", 1), item("c", "nested", "chapter", 2),
    item("section", "c", "chapter", 3), item("scene", "section", "scene", 4),
    item("later", null, "part", 0), item("d", "later", "chapter", 1),
  ];
  for (const selected of ["part", "nested"]) {
    expect(planPlacement(items, selected, "scene", "collection")).toEqual({
      holders: [], parentId: "c", afterId: null,
    });
  }
  for (const [selected, parentId, afterId] of [
    ["c", "c", null], ["section", "section", null],
    ["scene", "section", "scene"], [null, "d", null],
  ] as const) {
    expect(planPlacement(items, selected, "scene", "collection")).toEqual({
      holders: [], parentId, afterId,
    });
  }
});

test("an empty collection part keeps the preceding-story or new-story fallback", () => {
  const part = item("part", null, "part", 0);
  const story = item("story", null, "chapter", 0);
  expect(planPlacement([story, part], "part", "scene", "collection")).toEqual({
    holders: [], parentId: "story", afterId: null,
  });
  expect(planPlacement([part, story], "part", "scene", "collection")).toEqual({
    holders: ["chapter"], parentId: "part", afterId: null,
  });
});

test("story fields capture their row, save before export, and stop on a failed save", async () => {
  const original: StoryFields = { id: "second", title: "Forest", author: null, state: "draft", rev: 7 };
  const saved: StoryFields[] = [];
  const exports: string[][] = [];
  const errors: string[] = [];
  const focused: string[] = [];
  let fail = false;
  const panel = createStoryPanel({
    read: async () => original,
    save: async (story) => { if (fail) throw new Error("conflict"); saved.push(story); },
    export: (id, format) => { exports.push([id, format]); },
    notice: (message) => { errors.push(message); }, returnFocus: (id) => { focused.push(id); },
  });
  try {
    await panel.open("second");
    const title = document.getElementById("story-title") as HTMLInputElement;
    const author = document.getElementById("story-author") as HTMLInputElement;
    const status = document.getElementById("story-status") as HTMLSelectElement;
    title.value = " ";
    document.getElementById("story-save")!.click();
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(title.getAttribute("aria-describedby")!)!.textContent).toBe("Enter a story title.");
    expect(saved).toHaveLength(0);
    expect(document.getElementById(author.getAttribute("aria-describedby")!)!.textContent).toContain("pen name");
    const group = document.querySelector(".story-exports")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Save and export this story");
    title.value = "The Forest"; author.value = "Ada Lane"; status.value = "done";
    document.getElementById("story-export-epub")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([{ ...original, title: "The Forest", author: "Ada Lane", state: "done" }]);
    expect(exports).toEqual([["second", "epub"]]);
    expect(focused).toEqual(["second"]);
    await panel.open("second");
    fail = true;
    document.getElementById("story-export-pdf")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exports).toHaveLength(1);
    expect(errors[0]).toContain("conflict");
    expect(document.getElementById("story-panel")!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>("#story-panel .panel-close")!.click();
    expect(focused).toEqual(["second", "second"]);
  } finally { panel.destroy(); }
});
