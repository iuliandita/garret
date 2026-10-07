import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector text matches -- parsed
 *  rather than asserted as a literal, `theme.test.ts`'s own reason: a literal
 *  copy here would be a second statement of the same tokens. */
function declarations(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector);
  if (at < 0) throw new Error(`style.css no longer contains the selector ${selector}`);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const part of CSS.slice(open + 1, close).split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

/** The full text of the first brace-balanced block starting at `selector`,
 *  braces and all -- used for the `@media` block below, which nests rules a
 *  colon-split cannot represent. */
function blockOf(selector: string): string {
  const at = CSS.indexOf(selector);
  if (at < 0) throw new Error(`style.css no longer contains ${selector}`);
  const open = CSS.indexOf("{", at);
  let depth = 0;
  let i = open;
  for (; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return CSS.slice(at, i);
}

const COVER_TOKENS = ["--cover-1", "--cover-2", "--cover-3", "--cover-4", "--cover-5", "--cover-6"];

describe("the library screen's stylesheet facts", () => {
  test("the six cover tokens are declared in all three theme blocks", () => {
    for (const selector of [":root", ':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
      const tokens = declarations(selector);
      for (const cover of COVER_TOKENS) {
        expect(tokens[cover], `${selector} is missing ${cover}`).toBeDefined();
      }
    }
  });

  test("the six cover tokens are declared for the other two families too", () => {
    for (const family of ["neutral", "atmospheric"]) {
      for (const selector of [
        `:root[data-family="${family}"]`,
        `:root[data-family="${family}"]:not([data-theme="light"])`,
        `:root[data-family="${family}"][data-theme="dark"]`,
      ]) {
        const tokens = declarations(selector);
        for (const cover of COVER_TOKENS) {
          expect(tokens[cover], `${selector} is missing ${cover}`).toBeDefined();
        }
      }
    }
  });

  test("#library[hidden] restates display: none against this file's own display: flex", () => {
    const rule = declarations("#library[hidden]");
    expect(rule.display).toBe("none");
  });

  test("every shelf animation and hover-motion declaration lives inside prefers-reduced-motion: no-preference", () => {
    const guarded = blockOf("@media (prefers-reduced-motion: no-preference)");
    expect(guarded).toContain("shelf-in");
    expect(guarded).toContain(".shelf-tile:hover");
    // The vacuity half: the motion declarations really are IN the file, so a
    // guard that matched nothing upstream would not pass this by omission.
    const outsideGuard = CSS.replace(guarded, "");
    expect(outsideGuard).not.toContain("shelf-in");
    expect(outsideGuard).not.toMatch(/\.shelf-tile:hover\s*\{[^}]*transform/);
  });

  test("the generated cover's tint selectors cover exactly six tints", () => {
    for (let i = 1; i <= 6; i++) {
      expect(CSS).toContain(`.cover-generated[data-tint="${i}"]`);
    }
    expect(CSS).not.toContain('.cover-generated[data-tint="7"]');
  });

  // THE SPECIFICITY BUG THE CAPTURES FOUND: `#library button` (one id, one
  // type -- (1,0,1)) outranks a bare class selector, so `.shelf-tile { border:
  // none }` or `.pill { padding: ... }` alone would be IN the file, matching,
  // and silently overridden -- the shelf rendering as bordered cards, exactly
  // the look the design refuses. Every override that has to beat the shared button
  // rule is written `#library <selector>` (id + class, (1,1,0)) or, for a
  // single id, `#library button#id` ((1,0,1), declared after the shared rule
  // so it wins the tie). These assertions are the falsifiable half: a rule
  // reverted to a bare class selector fails here even though the class name
  // and the property are both still present in the file.
  describe("overrides beat #library button on specificity, not just on being present", () => {
    test("the shelf tile's border and background removal is qualified by #library", () => {
      const rule = declarations("#library .shelf-tile");
      expect(rule.background).toBe("transparent");
      expect(rule.border).toBe("none");
      // The unqualified selector must not carry these -- if it did, this
      // test would still pass on a regression that reintroduced the bug by
      // restating the win on the WEAKER selector.
      // Anchored to the START OF A LINE: every rule in this file opens flush
      // left, so this matches a selector that is EXACTLY `.shelf-tile` and
      // not `#library .shelf-tile` (which is indented under nothing, but
      // begins with `#`, never `.`).
      const bare = CSS.match(/^\.shelf-tile\s*\{([^}]*)\}/m);
      if (bare !== null) {
        expect(bare[1]).not.toContain("background: transparent");
        expect(bare[1]).not.toContain("border: none");
      }
    });

    test("the pill's own dimensions are qualified by #library", () => {
      const rule = declarations("#library .pill");
      expect(rule["border-radius"]).toBe("var(--radius-pill)");
      expect(rule.padding).toBe("6px 14px");
    });

    test("Continue writing's filled background is qualified to beat the shared button rule", () => {
      const rule = declarations("#library button#library-continue");
      expect(rule.background).toBe("var(--accent)");
    });

    test("the Close control's quiet look is qualified by #library", () => {
      const rule = declarations("#library .library-close");
      expect(rule.background).toBe("transparent");
    });
  });

  test("Close sits in the WRITING AS row, not floating after the shelf", () => {
    // A DOM-order check: .library-strip (the WRITING AS row) is declared
    // before #library-shelf in this file's own selector order for the
    // surfaces that hold each, which is a proxy for what main.ts's own
    // element order says more directly (library.ts appends closeButton into
    // `strip`, not after `shelf`) -- this half pins the STYLE side: Close is
    // never given shelf-following layout (margin-top after a grid, or
    // position at the bottom of the column).
    expect(CSS).not.toMatch(/#library-shelf[^}]*\}[^{]*#library[^{]*\.library-close/s);
  });

  test("the new book tile's placeholder is a dashed cover, not a bordered tile", () => {
    const cover = declarations(".cover-new");
    expect(cover.border).toContain("dashed");
    // The tile itself (`.shelf-tile`, shared) carries none of that: the
    // placeholder is scoped to the cover-shaped box inside it.
    const tile = declarations("#library .shelf-tile");
    expect(tile.border).toBe("none");
  });

  test("the cover has a resting shadow, deepened on hover", () => {
    // Anchored to a line starting with exactly `.cover {`: `CSS.indexOf`
    // would otherwise match INSIDE `.shelf-tile .cover {` or
    // `.cover-generated {`, both of which contain the substring `.cover {`
    // and both of which appear earlier in the file than the bare rule.
    const restMatch = CSS.match(/^\.cover\s*\{([^}]*)\}/m);
    expect(restMatch).not.toBeNull();
    expect(restMatch![1]).toContain("box-shadow");
    expect(restMatch![1]).not.toContain("box-shadow: none");
    const hover = declarations(".shelf-tile:hover:not(:disabled) .cover");
    expect(hover["box-shadow"]).toBeDefined();
  });

  test("the wordmark is ink by default and paper under both dark selectors", () => {
    expect(declarations("#library-wordmark {").background).toContain("garret-wordmark-ink.png");
    expect(blockOf('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) #library-wordmark')).toContain(
      "garret-wordmark-paper.png",
    );
    expect(declarations(':root[data-theme="dark"] #library-wordmark')["background-image"]).toContain(
      "garret-wordmark-paper.png",
    );
  });
});


test("armed snapshots beat the shared button rule and Books scroll targets keep an inset", () => {
  expect(declarations("#history-panel .snapshot-row[data-armed]").background).toBe("var(--accent)");
  expect(declarations("#project-panel .panel-body")["scroll-padding-block"]).toBe("var(--space-3)");
  expect(declarations("#project-encrypted-archive-heading")["scroll-margin-block"]).toBe("var(--space-3)");
});
