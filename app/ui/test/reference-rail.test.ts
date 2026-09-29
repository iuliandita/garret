import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createReferenceRail } from "../src/reference-rail";
import { savedProse } from "../src/saved-prose";
import type { ProjectItem } from "../src/store/source";

const item = (id: string, type = "scene"): ProjectItem => ({ id, parent_id: null, type, title: id, position: id, rev: 1, state: null, depth: 0 });
const rich = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
  { type: "text", text: "bold italic", marks: [{ type: "em" }, { type: "strong" }] },
  { type: "text", text: " under", marks: [{ type: "underline" }] },
] }] });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("saved reference", () => {
  test("uses the editor schema for exact text and marks, and refuses unknown data", () => {
    const target = document.createElement("div");
    target.append(savedProse(rich, document)!);
    expect(target.textContent).toBe("bold italic under");
    expect(target.querySelector("em strong")?.textContent).toBe("bold italic");
    expect(target.querySelector("u")?.textContent).toBe(" under");
    expect(savedProse(JSON.stringify({ type: "doc", content: [{ type: "future" }] }), document)).toBeNull();
    expect(savedProse(JSON.stringify({ type: "paragraph", content: [{ type: "text", text: "wrong root" }] }), document)).toBeNull();
    expect(savedProse(JSON.stringify({ type: "doc", content: [] }), document)).toBeNull();
  });

  test("pins an id across selection changes, shows stale revision and removal, and never writes", async () => {
    const container = document.createElement("div"); document.body.append(container);
    let resolveRead: (value: { body: string; rev: number }) => void = () => undefined;
    const calls: string[] = [];
    const notices: string[] = [];
    let rejectDrain = false;
    const rail = createReferenceRail({ container, drain: async () => { calls.push("drain"); if (rejectDrain) throw new Error("save refused"); }, failed: () => false,
      load: (id) => { calls.push(id); return new Promise((resolve) => { resolveRead = resolve; }); },
      openSource: (id) => calls.push(`open:${id}`), onDismiss: () => undefined, onNotice: (message) => notices.push(message) });
    rail.setItems([item("s1"), item("s2")]);
    const pending = rail.open(item("s1")); await tick();
    resolveRead({ body: rich, rev: 4 }); await pending;
    expect(calls).toEqual(["drain", "s1"]);
    expect(container.querySelector(".reference-revision")?.textContent).toContain("4");
    expect(container.querySelector(".reference-body")?.textContent).toBe("bold italic under");
    expect(container.querySelector("[contenteditable]")).toBeNull();
    rail.setItems([item("s1"), item("s2")]);
    rail.invalidateAll();
    expect(container.querySelector(".reference-revision")?.textContent).toContain("refresh");
    rejectDrain = true;
    container.querySelector<HTMLButtonElement>("#reference-refresh")?.click(); await tick();
    expect(notices.at(-1)).toContain("not refreshed");
    expect(container.querySelector(".reference-revision")?.textContent).toContain("refresh");
    expect(container.querySelector(".reference-body")?.textContent).toBe("bold italic under");
    rail.setItems([item("s2")]);
    expect(container.querySelector(".reference-revision")?.textContent).toContain("no longer available");
    expect(container.querySelector<HTMLButtonElement>(".reference-head button")?.disabled).toBe(true);
    expect(container.querySelector(".reference-body")?.textContent).toBe("bold italic under");
    rail.setItems([item("s1"), item("s2")]);
    expect(container.querySelector<HTMLButtonElement>(".reference-head button")?.disabled).toBe(false);
    rail.destroy(); container.remove();
  });

  test("late read cannot repaint after close, and timeline is explicitly refused", async () => {
    const container = document.createElement("div"); document.body.append(container);
    let resolveRead: (value: { body: string; rev: number }) => void = () => undefined;
    const notices: string[] = [];
    let dismissed = 0;
    const rail = createReferenceRail({ container, drain: async () => undefined, failed: () => false,
      load: () => new Promise((resolve) => { resolveRead = resolve; }), openSource: () => undefined,
      onDismiss: () => { dismissed += 1; }, onNotice: (message) => notices.push(message) });
    rail.setItems([item("s1"), item("time", "timeline")]);
    await rail.open(item("time", "timeline"));
    expect(notices[0]).toContain("timeline");
    const pending = rail.open(item("s1")); await tick();
    container.querySelector("#reference-rail")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    resolveRead({ body: rich, rev: 7 }); await pending;
    expect(rail.isOpen()).toBe(false);
    expect(dismissed).toBe(1);
    expect(container.querySelector(".reference-body")?.textContent).toBe("");
    rail.destroy(); container.remove();
  });

  test("closing while the initial save is pending prevents the rail from opening", async () => {
    const container = document.createElement("div"); document.body.append(container);
    let finish: () => void = () => undefined;
    const rail = createReferenceRail({ container, drain: () => new Promise((resolve) => { finish = resolve; }), failed: () => false,
      load: async () => ({ body: rich, rev: 1 }), openSource: () => undefined, onDismiss: () => undefined, onNotice: () => undefined });
    rail.setItems([item("s1")]);
    const pending = rail.open(item("s1"));
    rail.close(); finish(); await pending;
    expect(rail.isOpen()).toBe(false);
    rail.destroy(); container.remove();
  });
});
