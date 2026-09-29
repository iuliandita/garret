import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createSceneNotes } from "../src/scene-notes";
import { ICON_PATHS } from "../src/icons";

const open = { id: 1, item_id: "scene-0", anchor_from: 1, anchor_to: 3, quote: "one", body: "note", created_at: 0, updated_at: 0, resolved: false, orphaned: false };
const orphan = { id: 2, item_id: "scene-0", anchor_from: 4, anchor_to: 4, quote: "gone", body: "orphan", created_at: 0, updated_at: 0, resolved: false, orphaned: true };
const resolved = { id: 3, item_id: "scene-0", anchor_from: 2, anchor_to: 4, quote: "done", body: "settled", created_at: 0, updated_at: 0, resolved: true, orphaned: false };

describe("scene notes", () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => document.body.replaceChildren());

  function mount() {
    const calls: string[] = [];
    const notes = createSceneNotes(document.body, () => calls.push("open"));
    const button = (): HTMLButtonElement => {
      const found = document.querySelector<HTMLButtonElement>("#scene-notes");
      if (found === null) throw new Error("scene notes did not mount");
      return found;
    };
    return { notes, button, calls };
  }

  test("shows the unresolved count, including an orphan, and uses the existing message icon", () => {
    const rig = mount();
    rig.notes.setRows([open, orphan, resolved]);
    expect(rig.button().hidden).toBe(false);
    expect(rig.button().textContent).toBe("2");
    expect(rig.button().getAttribute("aria-label")).toBe("Open comments for this scene, 2 open comments");
    expect(rig.button().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(rig.button().querySelector("path")?.getAttribute("d")).toBe(ICON_PATHS["message-square"][0]);
    rig.notes.destroy();
  });

  test("stays hidden for no rows or resolved-only rows", () => {
    const rig = mount();
    rig.notes.setRows([]);
    expect(rig.button().hidden).toBe(true);
    rig.notes.setRows([resolved]);
    expect(rig.button().hidden).toBe(true);
    rig.notes.destroy();
  });

  test("updates after a comments mutation and clears while another scene is loading", () => {
    const rig = mount();
    rig.notes.setRows([open, orphan]);
    expect(rig.button().textContent).toBe("2");
    rig.notes.setRows([orphan]);
    expect(rig.button().textContent).toBe("1");
    rig.notes.clear();
    expect(rig.button().hidden).toBe(true);
    expect(rig.button().textContent).toBe("");
    rig.notes.destroy();
  });

  test("opens the existing comments action and removes its control on teardown", () => {
    const rig = mount();
    rig.notes.setRows([open]);
    rig.button().click();
    expect(rig.calls).toEqual(["open"]);
    rig.notes.destroy();
    rig.notes.setRows([open]);
    expect(document.querySelector("#scene-notes")).toBeNull();
  });
});
