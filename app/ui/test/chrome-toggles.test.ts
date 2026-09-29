import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createFocusToggle, createOutlineToggle, NAV_HIDDEN_CLASS } from "../src/chrome-toggles";

describe("the outline toggle", () => {
  test("is a named, pressed icon button that hides the navigator for this session", () => {
    const container = document.createElement("span");
    const toggle = createOutlineToggle({ container, body: document.body });
    const button = container.querySelector("#outline-toggle") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Outline");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    button.click();
    expect(document.body.classList.contains(NAV_HIDDEN_CLASS)).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.click();
    expect(document.body.classList.contains(NAV_HIDDEN_CLASS)).toBe(false);
    toggle.destroy();
    expect(container.children.length).toBe(0);
    expect(document.body.classList.contains(NAV_HIDDEN_CLASS)).toBe(false);
  });
});

describe("the Focus button", () => {
  test("is a word, reflects the mode, and asks for the other mode on click", () => {
    const container = document.createElement("span");
    const asked: string[] = [];
    const toggle = createFocusToggle({ container, initial: "off", setFocus: (m) => asked.push(m) });
    const button = container.querySelector("#focus-toggle") as HTMLButtonElement;
    expect(button.textContent).toBe("Focus");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.click();
    expect(asked).toEqual(["paragraph"]);
    // The button does NOT press itself: the owner reports back.
    expect(button.getAttribute("aria-pressed")).toBe("false");
    toggle.set("paragraph");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    expect(asked).toEqual(["paragraph", "off"]);
    toggle.destroy();
  });

  test("carries its name and hint on a tooltip, not on title, like the outline toggle", () => {
    const container = document.createElement("span");
    const toggle = createFocusToggle({ container, initial: "off", setFocus: () => {} });
    const button = container.querySelector("#focus-toggle") as HTMLButtonElement;
    // Not the native tooltip: a keyboard user tabbing onto the button would be
    // shown nothing until focus, and title shows for the pointer only.
    expect(button.title).toBe("");
    // The tip is a SIBLING of the button, mounted only while shown.
    expect(button.parentElement?.querySelector(".tip")).toBeNull();
    button.dispatchEvent(new Event("mouseenter"));
    const tip = button.parentElement?.querySelector(".tip");
    expect(tip).not.toBeNull();
    expect((tip as HTMLElement).hidden).toBe(false);
    expect(tip?.textContent).toContain("Focus");
    expect(tip?.textContent).toContain("Dim everything but the paragraph you are in");
    toggle.destroy();
  });
});

// GEOMETRY, PARSED FROM THE STYLESHEET ITSELF -- the same approach as
// chrome-heights.test.ts and underline-and-anchor.test.ts's own pressed-state
// check. A pressed control taller than a resting one grows #project-bar, which
// is a click-geometry constant restated in switch-cli and outline-cli.
const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string | null {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) return null;
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

describe("the pressed state changes no geometry", () => {
  for (const selector of [
    '#outline-toggle[aria-pressed="true"]',
    '#focus-toggle[aria-pressed="true"]',
    '#outline-toggle[aria-pressed="true"]:hover',
    '#focus-toggle[aria-pressed="true"]:hover',
    '#outline-toggle[aria-pressed="true"]:active',
    '#focus-toggle[aria-pressed="true"]:active',
  ]) {
    test(selector, () => {
      const pressed = block(selector);
      expect(pressed).not.toBeNull();
      for (const property of [
        /(?:^|;)\s*(?:min-|max-)?height\s*:/,
        /(?:^|;)\s*line-height\s*:/,
        /(?:^|;)\s*font-size\s*:/,
        /(?:^|;)\s*padding(?:-(?:top|right|bottom|left))?\s*:/,
        /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?-width\s*:/,
        /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?\s*:/,
      ]) {
        expect(pressed ?? "").not.toMatch(property);
      }
    });
  }
});
