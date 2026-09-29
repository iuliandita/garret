import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPanelShell, type PanelShell, type PanelShellOptions } from "../src/panel-shell";

interface Rig {
  panel: HTMLElement;
  outside: HTMLButtonElement;
  shell: PanelShell;
  calls: string[];
}

const rigs: Rig[] = [];

function rig(extra: Partial<PanelShellOptions> = {}): Rig {
  const panel = document.createElement("div");
  panel.id = "test-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "test things");
  const first = document.createElement("p");
  first.id = "first";
  const second = document.createElement("button");
  second.id = "second";
  panel.append(first, second);
  const outside = document.createElement("button");
  document.body.append(panel, outside);
  const calls: string[] = [];
  const shell = createPanelShell({
    panel,
    title: "Things",
    close: () => {
      calls.push("close");
      panel.hidden = true;
    },
    returnFocus: () => calls.push("focus"),
    ...extra,
  });
  const r = { panel, outside, shell, calls };
  rigs.push(r);
  return r;
}

afterEach(() => {
  // The outside-click listener is on the shared document.
  for (const r of rigs) {
    r.shell.destroy();
    r.panel.remove();
    r.outside.remove();
  }
  rigs.length = 0;
});

function escape(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("the frame", () => {
  test("header, body, footer, then Close: the content is the first Tab stop", () => {
    const r = rig({ footer: true });
    const kids = [...r.panel.children];
    expect(kids).toEqual([r.shell.header, r.shell.body, r.shell.footer!, r.shell.closeButton]);
    expect([...r.shell.body.children].map((c) => c.id)).toEqual(["first", "second"]);
    expect(r.panel.classList.contains("panel-shell")).toBe(true);
  });

  test("no footer unless asked", () => {
    const r = rig();
    expect(r.shell.footer).toBeNull();
    expect(r.panel.querySelector(".panel-footer")).toBeNull();
  });

  test("the panel keeps its id, role and accessible name", () => {
    const r = rig();
    expect(r.panel.id).toBe("test-panel");
    expect(r.panel.getAttribute("role")).toBe("dialog");
    expect(r.panel.getAttribute("aria-label")).toBe("test things");
    expect(r.panel.hasAttribute("aria-labelledby")).toBe(false);
  });

  test("the title is a heading; the subtitle is hidden until it has words", () => {
    const r = rig({ titleId: "kept-heading" });
    expect(r.shell.title.tagName).toBe("H2");
    expect(r.shell.title.id).toBe("kept-heading");
    expect(r.shell.title.textContent).toBe("Things");
    expect(r.shell.subtitle.hidden).toBe(true);
    r.shell.setSubtitle("Chapter one");
    expect(r.shell.subtitle.hidden).toBe(false);
    expect(r.shell.subtitle.textContent).toBe("Chapter one");
    r.shell.setSubtitle("");
    expect(r.shell.subtitle.hidden).toBe(true);
    r.shell.setTitle("Other");
    expect(r.shell.title.textContent).toBe("Other");
  });

  test("Close is a quiet icon named from the catalog, the graphic hidden", () => {
    const r = rig({ closeId: "kept-close" });
    const close = r.shell.closeButton;
    expect(close.id).toBe("kept-close");
    expect(close.type).toBe("button");
    expect(close.dataset.weight).toBe("quiet");
    expect(close.getAttribute("aria-label")).toBe("Close Things");
    expect(close.textContent).toBe("");
    const svg = close.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  test("a fixed name keeps Close's name when the visible title changes", () => {
    const r = rig({ name: "Synopsis", title: "Synopsis of Chapter 3" });
    expect(r.shell.closeButton.getAttribute("aria-label")).toBe("Close Synopsis");
  });
});

describe("the three dismissals", () => {
  test("Close closes and hands focus back", () => {
    const r = rig();
    r.shell.closeButton.click();
    expect(r.calls).toEqual(["close", "focus"]);
  });

  test("Escape closes and hands focus back", () => {
    const r = rig();
    const event = escape(r.panel.querySelector<HTMLElement>("#second")!);
    expect(r.calls).toEqual(["close", "focus"]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("an Escape something inside already answered is left alone", () => {
    const r = rig();
    const inner = r.panel.querySelector<HTMLElement>("#second")!;
    inner.addEventListener("keydown", (event) => event.preventDefault());
    escape(inner);
    expect(r.calls).toEqual([]);
  });

  test("an Escape that confirms an input method's candidate is not a dismissal", () => {
    const r = rig();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    r.panel.dispatchEvent(event);
    expect(r.calls).toEqual([]);
  });

  test("Escape on a closed panel does nothing", () => {
    const r = rig();
    r.panel.hidden = true;
    escape(r.panel);
    expect(r.calls).toEqual([]);
  });

  test("an outside click closes and moves no focus; an inside click does not close", () => {
    const r = rig();
    r.panel.querySelector<HTMLElement>("#second")!.click();
    expect(r.calls).toEqual([]);
    r.outside.click();
    expect(r.calls).toEqual(["close"]);
  });

  test("outsideClick: false leaves the panel open", () => {
    const r = rig({ outsideClick: false });
    r.outside.click();
    expect(r.calls).toEqual([]);
  });

  test("destroy unregisters every listener", () => {
    const r = rig();
    r.shell.destroy();
    r.outside.click();
    escape(r.panel);
    r.shell.closeButton.click();
    expect(r.calls).toEqual([]);
  });
});

describe("the enter motion", () => {
  const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8");

  test("the shell enters with opacity and a 4px rise over the shared duration", () => {
    const rule = /\.panel-shell\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("animation: panel-enter var(--dur) var(--ease-out);");
    // No fill mode: a transform-ish value left on the panel would make it a
    // containing block for anything fixed inside it, after the motion ended.
    expect(rule).not.toMatch(/forwards|both/);
    const frames = /@keyframes panel-enter\s*\{\s*from\s*\{([^}]*)\}\s*\}/.exec(css)?.[1] ?? "";
    expect(frames).toContain("opacity: 0;");
    // translate, not transform: the centred panels' translateX(-50%) survives.
    expect(frames).toContain("translate: 0 4px;");
    expect(frames).not.toContain("transform");
  });

  test("reduced motion removes it", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.panel-shell\s*\{\s*animation: none;\s*\}\s*\}/);
  });
});
