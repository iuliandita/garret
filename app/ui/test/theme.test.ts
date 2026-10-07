import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

// The control that used to live here is gone: the cycling bar
// button was retired into the preferences panel, and its behaviour is tested in
// preferences.test.ts. What is left is the palette's VALUES and the stylesheet
// guard, which is what index.html, the panel and style.css all agree about.
import { THEMES, THEME_FAMILIES, applyTheme, applyThemeFamily, isTheme, isThemeFamily, themeFamilyFrom, themeFrom } from "../src/theme";

afterEach(() => {
  document.body.replaceChildren();
});

describe("theme values", () => {
  test("only the three known spellings are themes", () => {
    for (const t of THEMES) expect(isTheme(t)).toBe(true);
    for (const not of ["Dark", "", "auto", "system ", null, 7, undefined]) {
      expect(isTheme(not)).toBe(false);
    }
  });

  test("an unrecognized injection reads as system rather than throwing", () => {
    // A value here that is not a theme means the host injection was lost. The
    // desktop's preference is what every build before this slice did, so it is
    // the only safe answer.
    expect(themeFrom(undefined)).toBe("system");
    expect(themeFrom("chartreuse")).toBe("system");
    expect(themeFrom("dark")).toBe("dark");
  });

  test("system removes the attribute rather than writing its name", () => {
    // The stylesheet has no rule for [data-theme="system"], so a leftover
    // attribute would work by accident today and break the day a [data-theme]
    // selector is added.
    const root = document.createElement("html");
    applyTheme(root, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyTheme(root, "system");
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});

describe("the stylesheet's two dark blocks", () => {
  /** Comments stripped BEFORE anything is located or split, and both halves of
   *  that matter.
   *
   *  Splitting a raw declaration block on ";" makes the comment above a token
   *  part of that token's NAME, so a documented palette parses as a set of
   *  tokens none of which are the ones declared - and the two dark blocks then
   *  compare equal while saying nothing. A comment containing a colon (this
   *  file's "Secondary text: the word count") produces a phantom token outright.
   *
   *  And locating a selector in the raw text finds it in the PROSE first: the
   *  header comment says "bare :root is already light", so `indexOf(":root")`
   *  landed there and the block that got parsed was whichever rule opened next.
   *  That happened to be the right one, which is the worst way for it to be
   *  wrong - it would have kept working until someone wrote a comment
   *  mentioning a selector anywhere above the palette. */
  const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /** The declarations of the first rule whose selector text matches. Parsed
   *  rather than asserted as a literal: a literal copy in the test would be a
   *  THIRD statement of the same tokens, and drift between two is what this
   *  guard exists to catch. */
  function declarations(selector: string): Record<string, string> {
    const at = css.indexOf(selector);
    if (at < 0) throw new Error(`style.css no longer contains the selector ${selector}`);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    if (open < 0 || close < 0) throw new Error(`${selector} has no declaration block`);
    const out: Record<string, string> = {};
    for (const part of css.slice(open + 1, close).split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
    return out;
  }

  test("control boundaries contrast at least 3:1 against every adjacent theme surface", () => {
    const luminance = (hex: string): number => {
      const linear = [1, 3, 5].map((at) => {
        const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    for (const selector of [":root", ':root[data-theme="dark"]',
      ':root[data-family="neutral"]', ':root[data-family="neutral"][data-theme="dark"]',
      ':root[data-family="atmospheric"]', ':root[data-family="atmospheric"][data-theme="dark"]']) {
      const colors = declarations(selector);
      const border = luminance(colors["--control-border"]!);
      for (const surface of ["--control-bg", "--bg", "--nav-bg", "--chrome-bg"]) {
        const background = luminance(colors[surface]!);
        expect((Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("text tokens contrast at least 4.5:1 on resting and selected theme surfaces", () => {
    const luminance = (hex: string): number => {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      const linear = [1, 3, 5].map((at) => {
        const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    for (const selector of [":root", ':root[data-theme="dark"]',
      ':root[data-family="neutral"]', ':root[data-family="neutral"][data-theme="dark"]',
      ':root[data-family="atmospheric"]', ':root[data-family="atmospheric"][data-theme="dark"]']) {
      const colors = declarations(selector);
      for (const text of ["--fg", "--muted", "--accent", "--danger"]) {
        for (const surface of ["--bg", "--nav-bg", "--chrome-bg", "--control-bg", "--accent-soft"]) {
          const foreground = luminance(colors[text]!);
          const background = luminance(colors[surface]!);
          expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("declare exactly the same tokens with exactly the same values", () => {
    // CSS cannot share a declaration block between a media rule and a plain one
    // without a preprocessor, so the dark palette is stated twice. This is the
    // guard that makes that a cost rather than a latent bug: without it, a
    // colour changed in one place gives the desktop-dark writer and the
    // override-dark writer two different applications.
    const inMedia = declarations(':root:not([data-theme="light"])');
    const chosen = declarations(':root[data-theme="dark"]');
    expect(Object.keys(inMedia).length).toBeGreaterThan(0);
    expect(chosen).toEqual(inMedia);
  });

  test("the light palette defines every token the dark blocks override", () => {
    // A token defined only under dark is a token the light page renders with an
    // empty value, which paints as nothing rather than as a colour.
    const light = declarations(":root");
    for (const token of Object.keys(declarations(':root[data-theme="dark"]'))) {
      expect(light[token]).toBeDefined();
    }
  });

  describe("the other two families", () => {
    // Spec section 17 names three. Editorial is the default and IS the palette
    // on bare :root - it is not restated, and `data-family` is removed rather
    // than set to its name, exactly as `data-theme` is for "system".
    const OTHERS = ["neutral", "atmospheric"] as const;

    for (const family of OTHERS) {
      test(`${family} states the same tokens as Editorial, in both schemes`, () => {
        // A family that overrode SOME tokens would inherit the rest from
        // Editorial - which is not a third palette, it is the default with a
        // few colours changed, and the two would drift into each other as the
        // default is tuned.
        const base = Object.keys(declarations(":root"))
          .filter((t) => t.startsWith("--") && t !== "--nav-width")
          .sort();
        for (const selector of [
          `:root[data-family="${family}"]`,
          `:root[data-family="${family}"]:not([data-theme="light"])`,
          `:root[data-family="${family}"][data-theme="dark"]`,
        ]) {
          expect(Object.keys(declarations(selector)).sort()).toEqual(base);
        }
      });

      test(`${family}'s two dark statements agree`, () => {
        // CSS cannot share a block between a media rule and a plain one, so each
        // family's dark palette is stated twice - the same cost the default's
        // has, and the same guard.
        const inMedia = declarations(`:root[data-family="${family}"]:not([data-theme="light"])`);
        const chosen = declarations(`:root[data-family="${family}"][data-theme="dark"]`);
        expect(Object.keys(inMedia).length).toBeGreaterThan(0);
        expect(chosen).toEqual(inMedia);
      });

      test(`${family} actually differs from Editorial`, () => {
        // A family whose tokens all matched the default would be a control that
        // does nothing, and every test above would still pass.
        const base = declarations(":root");
        const theirs = declarations(`:root[data-family="${family}"]`);
        const differing = Object.keys(theirs).filter((t) => theirs[t] !== base[t]);
        expect(differing.length).toBeGreaterThan(6);
        // AND the tokens a writer would actually notice. A family differing in
        // ten incidental colours while sharing the paper, the ink, the navigator
        // and the accent is a control that appears to do nothing - and the
        // count above would still pass.
        for (const token of ["--bg", "--fg", "--nav-bg", "--accent"]) {
          expect(theirs[token]).not.toBe(base[token]);
        }
      });
    }

    test("each family's explicit-dark block comes AFTER Editorial's", () => {
      // ORDER, not specificity. `:root[data-family="neutral"]` (the LIGHT block)
      // and `:root[data-theme="dark"]` are both (0,2,0), so a writer on Neutral
      // and Dark gets whichever came last where the two disagree. The family's
      // own dark block is (0,3,0) and wins outright - but it has to be present
      // and it has to be below, or the light block wins by order.
      const editorialDark = css.indexOf(':root[data-theme="dark"]');
      expect(editorialDark).toBeGreaterThan(-1);
      for (const family of OTHERS) {
        const at = css.indexOf(`:root[data-family="${family}"][data-theme="dark"]`);
        expect(at).toBeGreaterThan(editorialDark);
      }
    });

    test("every family's light block comes BEFORE every dark block", () => {
      const firstDark = css.indexOf("prefers-color-scheme: dark");
      expect(firstDark).toBeGreaterThan(-1);
      for (const family of OTHERS) {
        const light = css.indexOf(`:root[data-family="${family}"] {`);
        expect(light).toBeGreaterThan(-1);
        expect(light).toBeLessThan(firstDark);
      }
    });

    test("the head script allows exactly what theme.ts knows", async () => {
      // Three statements of one list - theme.ts, the head script, the
      // stylesheet - and none can import the others: the head script runs before
      // the bundle and CSS cannot read a TS constant.
      const html = await Bun.file("app/ui/index.html").text();
      const line = html.match(/var f = window\.__appThemeFamily;[\s\S]{0,220}/);
      expect(line).not.toBeNull();
      const allowed = [...(line?.[0] ?? "").matchAll(/f === "([a-z]+)"/g)].map((m) => m[1]).sort();
      // The default is NOT in the head script: it writes nothing, because the
      // stylesheet carries it on bare :root.
      expect(allowed).toEqual([...OTHERS].sort());
    });

    test("the stylesheet has a block for every non-default family theme.ts knows", () => {
      for (const family of THEME_FAMILIES) {
        const selector = `:root[data-family="${family}"]`;
        if (family === "editorial") expect(css).not.toContain(selector);
        else expect(css).toContain(selector);
      }
    });
  });
});

describe("the theme family", () => {
  test("only the three named spellings are families", () => {
    for (const family of ["editorial", "neutral", "atmospheric"]) {
      expect(isThemeFamily(family)).toBe(true);
    }
    for (const value of ["Editorial", "sage", "", 7, null, undefined, {}]) {
      expect(isThemeFamily(value)).toBe(false);
    }
  });

  test("an unrecognized injection reads as the default rather than throwing", () => {
    // The host validates what it writes, so a value arriving here that is not a
    // family means the injection was LOST - and Editorial is what every build
    // before this slice rendered.
    expect(themeFamilyFrom("sage")).toBe("editorial");
    expect(themeFamilyFrom(undefined)).toBe("editorial");
    expect(themeFamilyFrom(7)).toBe("editorial");
    expect(themeFamilyFrom("neutral")).toBe("neutral");
  });

  test("editorial REMOVES the attribute rather than writing its name", () => {
    // The stylesheet carries the default family on bare :root and has no rule
    // for the word, so leaving it behind works by accident today and breaks the
    // day any [data-family] selector is added. Same call applyTheme makes for
    // "system", pinned here for the same reason.
    const root = document.createElement("html");
    applyThemeFamily(root, "neutral");
    expect(root.getAttribute("data-family")).toBe("neutral");
    applyThemeFamily(root, "editorial");
    expect(root.hasAttribute("data-family")).toBe(false);
  });

  test("applying twice replaces rather than accumulating", () => {
    const root = document.createElement("html");
    applyThemeFamily(root, "neutral");
    applyThemeFamily(root, "atmospheric");
    expect(root.getAttribute("data-family")).toBe("atmospheric");
  });

  test("the family is independent of the theme", () => {
    // Two attributes, six combinations. A family that cleared the theme - or a
    // theme that cleared the family - would make the panel's two controls one.
    const root = document.createElement("html");
    applyTheme(root, "dark");
    applyThemeFamily(root, "neutral");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-family")).toBe("neutral");
  });
});
