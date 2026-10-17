import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { writeWritingPosition } from "../src/position";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("mobile library did not settle");
}

test("a long Library exposes New book before its list and loads the device's remembered scene", async () => {
  const app = document.createElement("div"); app.id = "app"; document.body.append(app);
  const original = Object.getOwnPropertyDescriptor(window, "__TAURI__");
  const requested: string[] = [];
  const created: Record<string, unknown>[] = [];
  let retained = 1;
  let discarded = 0;
  const scenes = [{ id: "a", title: "Before", depth: 0 }, { id: "b", title: "After", depth: 0 }];
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: { core: {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === "mobile_catalog") return { retained_transfers: retained, books: Array.from({ length: 100 }, (_, id) => ({ id: `book-${id}`, name: `Book ${id}` })) };
      if (command === "mobile_transfer_discard") { retained = 0; discarded++; return; }
      if (command === "mobile_open") return { id: args!.id, name: "Book 99", generation: 1, scenes };
      if (command === "mobile_document") {
        requested.push(String(args!.itemId));
        return { item_id: args!.itemId, rev: 1, comments: [], body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "At sea after dawn" }] }] }) };
      }
      if (command === "mobile_scene_create") {
        created.push(args!);
        return { item_id: "next", scenes: [...scenes, { id: "next", title: args!.title, depth: 0 }] };
      }
      if (command === "mobile_close") return;
      throw new Error(`unexpected mobile command ${command}`);
    },
  } } });
  writeWritingPosition(localStorage, "book-99", { sceneId: "b", from: 4, to: 4, scrollTop: 0 });
  try {
    await import("../src/main");
    await waitFor(() => app.querySelectorAll("nav button").length === 100);
    const appearance = app.querySelector<HTMLButtonElement>(".mobile-appearance")!;
    const firstTheme = app.querySelector<HTMLElement>(".mobile-library")!.dataset.theme;
    const firstIcon = appearance.querySelector("path")!.getAttribute("d");
    expect(appearance.textContent).toBe("");
    expect(appearance.getAttribute("aria-label")).toBe(`Appearance: ${firstTheme === "dark" ? "Light" : "Dark"}`);
    expect(appearance.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    appearance.click();
    await waitFor(() => app.querySelectorAll("nav button").length === 100);
    const switched = app.querySelector<HTMLButtonElement>(".mobile-appearance")!;
    expect(app.querySelector<HTMLElement>(".mobile-library")!.dataset.theme).toBe(firstTheme === "dark" ? "light" : "dark");
    expect(switched.getAttribute("aria-label")).toBe(`Appearance: ${firstTheme === "dark" ? "Dark" : "Light"}`);
    expect(switched.querySelector("path")!.getAttribute("d")).not.toBe(firstIcon);
    const discard = Array.from(app.querySelectorAll("button")).find(node => node.textContent === "Discard leftover transfer files")!;
    expect(discard.disabled).toBe(false); discard.click();
    await waitFor(() => !app.textContent!.includes("Discard leftover transfer files"));
    expect(discarded).toBe(1);
    expect(app.querySelectorAll("nav button").length).toBe(100);
    const form = app.querySelector("form")!;
    const list = app.querySelector("nav")!;
    expect(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    app.querySelectorAll<HTMLButtonElement>("nav button")[99].click();
    await waitFor(() => app.querySelector(".mobile-prose") !== null);
    expect(requested).toEqual(["b"]);
    expect(app.querySelector(".mobile-scene-title")!.textContent).toBe("After");
    app.querySelector<HTMLButtonElement>('[data-action="outline"]')!.click();
    const addScene = app.querySelector(".mobile-outline form")!;
    addScene.querySelector<HTMLInputElement>("input")!.value = "Next";
    addScene.dispatchEvent(new Event("submit", { cancelable: true }));
    await waitFor(() => app.querySelector(".mobile-scene-title")?.textContent === "Next");
    expect(created).toEqual([{ generation: 1, title: "Next", currentSceneId: "b" }]);
    expect(requested).toEqual(["b", "next"]);
    app.querySelector<HTMLButtonElement>('[data-action="books"]')!.click();
    await waitFor(() => app.querySelectorAll("nav button").length === 100);
  } finally {
    if (original) Object.defineProperty(window, "__TAURI__", original);
    else Reflect.deleteProperty(window, "__TAURI__");
    localStorage.removeItem("garret.mobile.position.v1.book-99");
    app.remove();
  }
});
