import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { ICON_PATHS, createIcon, type IconName } from "../src/icons";

const NAMES: IconName[] = [
  "bold",
  "italic",
  "underline",
  "outline",
  "house",
  "menu",
  "message-square",
  "search",
  "book-open",
  "file-text",
  "bookmark",
  "trash-2",
  "users",
  "user",
  "globe",
  "map-pin",
  "image",
  "calendar-range",
  "circle-check",
  "x",
  "circle-help",
  "sun",
  "moon",
];

beforeEach(() => {
  document.body.replaceChildren();
});

describe("the vendored table", () => {
  test("every name maps to at least one path, and every path is path data", () => {
    // VACUITY GUARD FIRST. An empty table passes every `for` below it, which is
    // the recorded shape of three guards in this repo.
    expect(Object.keys(ICON_PATHS).length).toBeGreaterThanOrEqual(3);
    for (const name of NAMES) {
      const paths = ICON_PATHS[name];
      expect(paths.length).toBeGreaterThan(0);
      for (const d of paths) {
        // Path data, not prose: a move-to and then only the SVG path grammar.
        expect(d).toMatch(/^M[\s\d.-]/);
        expect(d).toMatch(/^[MmZzLlHhVvCcSsQqTtAa0-9,.\s-]+$/);
      }
    }
  });

  test("the table is the only place path data lives", () => {
    // THE POINT OF KEEPING ICONS AS DATA. Swapping packs later is a table edit,
    // and it is only a table edit while no other file draws its own geometry.
    const src = readFileSync(join(import.meta.dir, "..", "src", "format-bubble.ts"), "utf8");
    expect(src).not.toMatch(/\bd="M/);
    expect(src).not.toContain("createElementNS");
  });
});

describe("attribution", () => {
  test("the pack's licence ships with the paths that need it", () => {
    // VENDORED CODE OWES ITS LICENCE, and a notice nothing checks is a notice
    // that goes stale the first time a pack is swapped. There was no
    // third-party attribution file in this repository before these icons,
    // because there was no third-party code in the tree; this is the obvious
    // place for it, beside COPYING.
    const notices = readFileSync(
      join(import.meta.dir, "..", "..", "..", "THIRD-PARTY-NOTICES.md"),
      "utf8",
    );
    expect(notices).toContain("Lucide");
    expect(notices).toContain("ISC License");
    expect(notices).toContain("Permission to use, copy, modify, and/or distribute");
    // It must name where the code actually is, or a reader cannot check it.
    expect(notices).toContain("app/ui/src/icons.ts");
  });
});

describe("the element it builds", () => {
  test("it is an svg carrying one path per table entry", () => {
    const svg = createIcon("underline");
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBe(ICON_PATHS.underline.length);
    expect(paths[0]?.getAttribute("d")).toBe(ICON_PATHS.underline[0]);
  });

  test("it contributes NOTHING to the accessible name", () => {
    // THE WHOLE RISK OF THIS SLICE. Every graded rig presses a control by its
    // accessible name through AT-SPI. A decorative graphic that is exposed
    // either replaces the name with nothing or pollutes it; either way the rig
    // reports a control it cannot find, while the page still looks correct in a
    // screenshot.
    const svg = createIcon("bold");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    // focusable="false" as well as aria-hidden: an SVG is focusable by default
    // in some engines, and a hidden node that still takes a Tab stop is a stop
    // a keyboard user cannot see or name.
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.textContent).toBe("");
  });

  test("it carries the pack's own drawing contract and no inline geometry", () => {
    // Lucide draws on a 24x24 grid with a 2px round stroke in currentColor.
    // Size is the stylesheet's business -- an inline width here would be a
    // geometry constant in a bar whose height two rigs restate.
    const svg = createIcon("italic");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
    expect(svg.getAttribute("style")).toBeNull();
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.getAttribute("height")).toBeNull();
  });

  test("an icon nobody vendored is a throw, not an empty box", () => {
    // A missing icon must not render as a control with no symbol and no text:
    // that is a button a writer cannot identify at all, and it would reach a
    // screenshot looking like a rendering bug rather than a missing table row.
    expect(() => createIcon("no-such-icon" as IconName)).toThrow();
  });
});
