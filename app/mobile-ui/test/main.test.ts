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
  const scenes = [{ id: "a", title: "Before", depth: 0 }, { id: "b", title: "After", depth: 0 }];
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: { core: {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === "mobile_catalog") return { books: Array.from({ length: 100 }, (_, id) => ({ id: `book-${id}`, name: `Book ${id}` })) };
      if (command === "mobile_open") return { id: args!.id, name: "Book 99", generation: 1, scenes };
      if (command === "mobile_document") {
        requested.push(String(args!.itemId));
        return { item_id: args!.itemId, rev: 1, comments: [], body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "At sea after dawn" }] }] }) };
      }
      if (command === "mobile_close") return;
      throw new Error(`unexpected mobile command ${command}`);
    },
  } } });
  writeWritingPosition(localStorage, "book-99", { sceneId: "b", from: 4, to: 4, scrollTop: 0 });
  try {
    await import("../src/main");
    await waitFor(() => app.querySelectorAll("nav button").length === 100);
    const form = app.querySelector("form")!;
    const list = app.querySelector("nav")!;
    expect(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    app.querySelectorAll<HTMLButtonElement>("nav button")[99].click();
    await waitFor(() => app.querySelector(".mobile-prose") !== null);
    expect(requested).toEqual(["b"]);
    expect(app.querySelector(".mobile-scene-title")!.textContent).toBe("After");
    app.querySelector<HTMLButtonElement>('[data-action="books"]')!.click();
    await waitFor(() => app.querySelectorAll("nav button").length === 100);
  } finally {
    if (original) Object.defineProperty(window, "__TAURI__", original);
    else Reflect.deleteProperty(window, "__TAURI__");
    localStorage.removeItem("garret.mobile.position.v1.book-99");
    app.remove();
  }
});
