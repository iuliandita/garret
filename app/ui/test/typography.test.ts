import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  applyTypography,
  DEFAULT_TYPOGRAPHY,
  FAMILIES,
  isFamily,
  isMeasure,
  isSize,
  MEASURES,
  SIZES,
  typographyFrom,
} from "../src/typography";

afterEach(() => {
  document.body.replaceChildren();
});

describe("typography values", () => {
  test("only the known spellings are values, and no axis accepts another's", () => {
    // The cross-axis half is what a single shared list would fail. Each of
    // these words is legal somewhere in this module and must not be legal here.
    for (const f of FAMILIES) expect(isFamily(f)).toBe(true);
    for (const s of SIZES) expect(isSize(s)).toBe(true);
    for (const m of MEASURES) expect(isMeasure(m)).toBe(true);

    for (const not of ["Serif", "", "large", "narrow", null, 7, undefined]) {
      expect(isFamily(not)).toBe(false);
    }
    for (const not of ["Small", "", "mono", "wide", null, 7, undefined]) {
      expect(isSize(not)).toBe(false);
    }
    for (const not of ["Wide", "", "sans", "larger", null, 7, undefined]) {
      expect(isMeasure(not)).toBe(false);
    }
  });

  test("one unreadable axis costs exactly itself", () => {
    // The same rule the host applies when reading the file. An all-or-nothing
    // narrowing would mean a page that lost one injected value silently
    // rendering at the default size too, and the writer setting two preferences
    // to get one back.
    const got = typographyFrom({ family: "mono", size: 7, measure: "wide" });
    expect(got.family).toBe("mono");
    expect(got.size).toBe(DEFAULT_TYPOGRAPHY.size);
    expect(got.measure).toBe("wide");
  });

  test("an absent injection reads as the defaults rather than throwing", () => {
    expect(typographyFrom({})).toEqual(DEFAULT_TYPOGRAPHY);
  });

  test("the default value is WRITTEN, unlike the theme's system", () => {
    // The opposite of applyTheme on purpose: "system" has no stylesheet rule by
    // design, "medium" has one exactly like the others. A version of
    // applyTypography that removed the attribute for the default would render
    // the same page today, through the var() fallback, and stop the moment a
    // rule keyed on the attribute did anything else.
    const root = document.createElement("html");
    applyTypography(root, DEFAULT_TYPOGRAPHY);
    expect(root.getAttribute("data-prose-family")).toBe("serif");
    expect(root.getAttribute("data-prose-size")).toBe("medium");
    expect(root.getAttribute("data-prose-measure")).toBe("medium");
  });

  test("applying twice replaces rather than accumulating", () => {
    const root = document.createElement("html");
    applyTypography(root, { family: "mono", size: "larger", measure: "narrow" });
    applyTypography(root, { family: "sans", size: "small", measure: "wide" });
    expect(root.getAttribute("data-prose-family")).toBe("sans");
    expect(root.getAttribute("data-prose-size")).toBe("small");
    expect(root.getAttribute("data-prose-measure")).toBe("wide");
  });
});

describe("the three statements of the value lists", () => {
  // Each axis is spelled out in THREE files, and none of them can import the
  // others: index.html's head script must run before the stylesheet and cannot
  // wait for a module, and CSS cannot read a TypeScript constant. So the guard
  // is a parser rather than a shared table - the same shape as the two dark
  // palette blocks in theme.test.ts, and for the same reason.
  const dir = join(import.meta.dir, "..");
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const css = readFileSync(join(dir, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** The array literal passed to the head script's `prose(name, value, [...])`
   *  call for one axis. */
  function headList(axis: string): string[] {
    const found = html.match(new RegExp(`prose\\("${axis}",[^,]+,\\s*\\[([^\\]]*)\\]`));
    if (found === null) throw new Error(`index.html's head script no longer sets ${axis}`);
    return (found[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
  }

  /** Every value the stylesheet actually has a rule for, on one axis. */
  function styledValues(axis: string): string[] {
    const rule = new RegExp(`:root\\[data-prose-${axis}="([^"]+)"\\]`, "g");
    return [...css.matchAll(rule)].map((m) => m[1] ?? "");
  }

  const axes: [string, readonly string[]][] = [
    ["family", FAMILIES],
    ["size", SIZES],
    ["measure", MEASURES],
  ];

  for (const [axis, values] of axes) {
    test(`${axis}: the head script allows exactly what typography.ts knows`, () => {
      // A value the head script rejects is one the writer chose, the host wrote
      // and the next launch silently drops back to the default - which looks
      // exactly like the preference not being saved.
      expect(headList(axis).sort()).toEqual([...values].sort());
    });

    test(`${axis}: the stylesheet has a rule for every value`, () => {
      // A value with no rule falls through to the var() fallback, so choosing it
      // renders the DEFAULT while the panel shows it as chosen. Nothing else in
      // the page could notice.
      expect(styledValues(axis).sort()).toEqual([...values].sort());
    });
  }

  test("the prose rule reads every axis through a custom property with a fallback", () => {
    // The fallback is what makes a page whose injection was lost render the
    // default page rather than an unstyled one - which is every unit test that mounts
    // the editor without the panel.
    const at = css.indexOf("\n#editor .ProseMirror {");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toContain("var(--prose-measure, 39em)");
    expect(block).toContain("var(--prose-size, 19px)");
    expect(block).toMatch(/font-family:\s*var\(--prose-family,\s*"Crimson Pro",\s*Georgia/);
  });

  test("the defaults in typography.ts are the values the fallbacks state", () => {
    // Two statements of "what this application looked like before", and
    // this is what keeps them one answer. A default changed on one side only
    // would make the panel disagree with an unstyled boot.
    const rule = (axis: string, value: string): string => {
      const at = css.indexOf(`:root[data-prose-${axis}="${value}"]`);
      if (at < 0) throw new Error(`no rule for ${axis}=${value}`);
      return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)).trim();
    };
    expect(rule("size", DEFAULT_TYPOGRAPHY.size)).toContain("19px");
    expect(rule("measure", DEFAULT_TYPOGRAPHY.measure)).toContain("39em");
    expect(rule("family", DEFAULT_TYPOGRAPHY.family)).toContain("Georgia");
  });
});

describe("editor typography and book design are two things", () => {
  // THE INVARIANT THIS EXISTS NOT TO BREAK, and the one a later reader is
  // most likely to "simplify" away, because both surfaces have a control called
  // Font. Editor typography is per WRITER, selects one of ten known words, and
  // is applied by `applyTypography` TO THE LIVE EDITOR ROOT. Book design is per
  // BOOK, holds physical measurements with no enum at all, and describes a page
  // nobody is looking at. Conflating them would put a page size on the element
  // the writer is typing into.
  const dir = join(import.meta.dir, "..", "src");
  const read = (file: string): string =>
    readFileSync(join(dir, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const DESIGN = ["book-design.ts", "design-panel.ts"];

  test("no book-design module imports the typography module", () => {
    for (const file of DESIGN) {
      expect({ file, imports: /from "\.\/typography"/.test(read(file)) }).toEqual({
        file,
        imports: false,
      });
    }
  });

  test("the typography module knows nothing about book design", () => {
    const source = read("typography.ts");
    expect(source).not.toContain("book-design");
    expect(source).not.toContain("design-panel");
  });

  test("no book-design module writes an attribute on any root", () => {
    // `applyTypography`'s whole shape, and the one call a book design must
    // never make. Asserted on the CALL, because a module holding the word
    // `root` in a name proves nothing either way.
    for (const file of DESIGN) {
      const source = read(file);
      expect({ file, sets: /\.setAttribute\(\s*"data-/.test(source) }).toEqual({ file, sets: false });
      expect({ file, root: /document\.documentElement/.test(source) }).toEqual({ file, root: false });
    }
    // Vacuity guard: the same probes DO fire on the module they describe, so a
    // regex that had stopped matching anything would fail here rather than pass
    // above.
    const typography = read("typography.ts");
    expect(/\.setAttribute\(\s*"data-/.test(typography)).toBe(true);
  });
});
