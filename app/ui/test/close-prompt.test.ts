// The close prompt: the full-window modal, raised when the
// window is closing while autosave has failed with unsaved work.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createClosePrompt, type ClosePrompt } from "../src/close-prompt";

function mount(): { container: HTMLElement; panel: ClosePrompt } {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, panel: createClosePrompt({ container }) };
}

function panelEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("#close-prompt-panel");
  if (el === null) throw new Error("#close-prompt-panel did not mount");
  return el;
}

function press(el: HTMLElement, key: string, shiftKey = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
}

describe("createClosePrompt", () => {
  test("mounts hidden, marked as an alertdialog, and opens on request", () => {
    const { container, panel } = mount();
    try {
      const el = panelEl(container);
      expect(el.hidden).toBe(true);
      expect(el.getAttribute("role")).toBe("alertdialog");
      expect(el.getAttribute("aria-modal")).toBe("true");
      const content = el.querySelector<HTMLElement>("#close-prompt-content");
      expect(content?.parentElement).toBe(el);
      for (const id of ["close-prompt-heading", "close-prompt-body", "close-prompt-actions"]) {
        expect(el.querySelector(`#${id}`)?.parentElement).toBe(content);
      }
      void panel.open(1);
      expect(el.hidden).toBe(false);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("naming how many documents are unsaved, singular and plural", () => {
    const { container, panel } = mount();
    try {
      void panel.open(1);
      const body = container.querySelector("#close-prompt-body");
      expect(body?.textContent).toContain("1 document");
      expect(body?.textContent).not.toContain("1 documents");

      void panel.open(3);
      expect(body?.textContent).toContain("3 documents");
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("focus lands on the safe action, not the destructive one, on open", () => {
    const { container, panel } = mount();
    try {
      void panel.open(2);
      const discard = container.querySelector<HTMLElement>("#close-prompt-discard");
      expect(discard).not.toBeNull();
      // Asserted POSITIVELY - "activeElement !== discard" alone would also
      // pass with focus landing nowhere at all, e.g. if `stayButton.focus()`
      // were ever deleted and focus just stayed on <body>. A Return pressed by
      // reflex must land on the safe button, not merely miss the dangerous one.
      const buttons = [...container.querySelectorAll<HTMLElement>("#close-prompt-panel button")];
      const stay = buttons.find((b) => b !== discard);
      expect(stay).toBeDefined();
      expect(document.activeElement).toBe(stay as HTMLElement);
      expect(document.activeElement).not.toBe(discard);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("stay-open confirms nothing: the promise resolves 'stay' and the button never even exists as the default", async () => {
    const { container, panel } = mount();
    try {
      const el = panelEl(container);
      const choice = panel.open(1);
      const buttons = el.querySelectorAll("button");
      // Exactly two outcomes, per the plan: stay open, close and lose.
      expect(buttons.length).toBe(2);
      const stay = [...buttons].find((b) => b.dataset.weight !== "danger");
      expect(stay).toBeDefined();
      stay?.click();
      expect(await choice).toBe("stay");
      expect(el.hidden).toBe(true);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("close-and-lose resolves 'close' exactly once per open, from the labelled destructive button", async () => {
    const { container, panel } = mount();
    try {
      const el = panelEl(container);
      const choice = panel.open(1);
      const discard = el.querySelector<HTMLButtonElement>("#close-prompt-discard");
      expect(discard).not.toBeNull();
      // The label must say what is lost, not read as a neutral acknowledgement.
      expect(discard?.textContent?.toLowerCase()).not.toBe("ok");
      discard?.click();
      expect(await choice).toBe("close");
      expect(el.hidden).toBe(true);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("Escape means stay open", async () => {
    const { container, panel } = mount();
    try {
      const el = panelEl(container);
      const choice = panel.open(1);
      press(el, "Escape");
      expect(await choice).toBe("stay");
      expect(el.hidden).toBe(true);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("Tab from the last control wraps to the first, trapping focus", () => {
    const { container, panel } = mount();
    try {
      const el = panelEl(container);
      void panel.open(1);
      const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
      const last = buttons[buttons.length - 1];
      expect(last).toBeDefined();
      last?.focus();
      press(el, "Tab");
      expect(document.activeElement).toBe(buttons[0]);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("Shift+Tab from the first control wraps to the last, trapping focus", () => {
    const { container, panel } = mount();
    try {
      const el = panelEl(container);
      void panel.open(1);
      const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
      const first = buttons[0];
      expect(first).toBeDefined();
      first?.focus();
      press(el, "Tab", true);
      expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("discard is danger TEXT on the default surface, never a filled slab", () => {
    // 236. The weight names the tier; the prompt's own two-id rule paints it,
    // because the shared danger tier is still the filled armed style.
    const { container, panel } = mount();
    try {
      const discard = panelEl(container).querySelector<HTMLButtonElement>("#close-prompt-discard");
      expect(discard?.dataset.weight).toBe("danger");
      const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const rules = [...css.matchAll(/#close-prompt-panel #close-prompt-discard[^{]*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
      expect(rules.length).toBe(2);
      for (const body of rules) {
        expect(body).toContain("color: var(--danger)");
        expect(body).not.toContain("background: var(--danger)");
      }
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("destroy removes the panel from the container", () => {
    const { container, panel } = mount();
    panel.destroy();
    expect(container.querySelector("#close-prompt-panel")).toBeNull();
    container.remove();
  });
});
