import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createBookCopyPrompt, type BookCopyPrompt } from "../src/book-copy-prompt";

const prompts: Array<{ container: HTMLElement; prompt: BookCopyPrompt }> = [];
const conflict = (canSeparate = true) => ({
  bookId: "book-1",
  canonicalPath: "/books/original.db",
  canSeparate,
});

function mount(): { container: HTMLElement; prompt: BookCopyPrompt; trigger: HTMLButtonElement } {
  const trigger = document.createElement("button");
  const container = document.createElement("div");
  document.body.append(trigger, container);
  const prompt = createBookCopyPrompt(container);
  prompts.push({ container, prompt });
  return { container, prompt, trigger };
}

afterEach(() => {
  for (const { container, prompt } of prompts) {
    prompt.destroy();
    container.previousElementSibling?.remove();
    container.remove();
  }
  prompts.length = 0;
});

const panel = (): HTMLElement => document.getElementById("book-copy-prompt") as HTMLElement;
const button = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;

describe("book copy prompt", () => {
  test("starts hidden and names its nonmodal choice", () => {
    mount();
    expect(panel().hidden).toBe(true);
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBeNull();
    expect(panel().getAttribute("aria-label")?.length).toBeGreaterThan(0);
  });

  test("same book returns the canonical identity", async () => {
    const { prompt } = mount();
    const choice = prompt.choose(conflict());
    button("book-copy-same").click();
    expect(await choice).toEqual({ bookId: "book-1", canonicalPath: "/books/original.db", kind: "same" });
  });

  test("separate book returns the independent choice", async () => {
    const { prompt } = mount();
    const choice = prompt.choose(conflict());
    button("book-copy-separate").click();
    expect(await choice).toEqual({ bookId: "book-1", canonicalPath: "/books/original.db", kind: "separate" });
  });

  test("Cancel and Enter resolve safely without opening either book", async () => {
    const { prompt } = mount();
    const cancelled = prompt.choose(conflict());
    button("book-copy-cancel").click();
    expect(await cancelled).toBeNull();
    const entered = prompt.choose(conflict());
    expect(document.activeElement).toBe(button("book-copy-cancel"));
    button("book-copy-cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(await entered).toBeNull();
  });

  test("Enter can activate a deliberately focused choice", async () => {
    const { prompt } = mount();
    const choice = prompt.choose(conflict());
    const same = button("book-copy-same");
    same.focus();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    same.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(panel().hidden).toBe(false);
    same.click();
    expect((await choice)?.kind).toBe("same");
  });

  test("Escape and an outside click cancel and restore the invoking focus", async () => {
    const { prompt, trigger } = mount();
    trigger.focus();
    const escaped = prompt.choose(conflict());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(await escaped).toBeNull();
    expect(document.activeElement).toBe(trigger);
    const outside = document.createElement("button");
    document.body.append(outside);
    const outsideChoice = prompt.choose(conflict());
    outside.click();
    expect(await outsideChoice).toBeNull();
    expect(document.activeElement).toBe(trigger);
    outside.remove();
  });

  test("a failed original check disables separate and says why", () => {
    const { prompt } = mount();
    void prompt.choose(conflict(false));
    expect(button("book-copy-separate").disabled).toBe(true);
    expect(document.getElementById("book-copy-separate-unavailable")?.hidden).toBe(false);
  });

  test("the host path is text, never parsed as markup", () => {
    const { prompt } = mount();
    const untrusted = '<img id="book-copy-injected" src=x>';
    void prompt.choose({ ...conflict(), canonicalPath: untrusted });
    expect(document.getElementById("book-copy-path")?.textContent).toBe(untrusted);
    expect(document.getElementById("book-copy-injected")).toBeNull();
  });

  test("prompt keyboard focus does not leak Alt shortcuts to the page", () => {
    const { prompt } = mount();
    let shortcuts = 0;
    const pageShortcut = (): void => { shortcuts += 1; };
    document.addEventListener("keydown", pageShortcut);
    try {
      void prompt.choose(conflict());
      panel().dispatchEvent(new KeyboardEvent("keydown", { key: "f", altKey: true, bubbles: true, cancelable: true }));
      expect(shortcuts).toBe(0);
    } finally {
      document.removeEventListener("keydown", pageShortcut);
    }
  });

  test("teardown cancels a pending choice and removes the prompt", async () => {
    const { prompt } = mount();
    const choice = prompt.choose(conflict());
    prompt.destroy();
    expect(await choice).toBeNull();
    expect(document.getElementById("book-copy-prompt")).toBeNull();
  });
});
