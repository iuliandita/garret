// The prose column, checked against the stylesheet SOURCE.
//
// Same reasoning as nav-row-type.test.ts: happy-dom does no layout and loads no
// stylesheet, so a getComputedStyle assertion here would report initial values
// and pass against any implementation including none. What a source test cannot
// see is whether the result LOOKS like a novel, and nothing in this file claims
// to - that is the screenshot pair beside the slice. What it pins is the part
// that would drift silently.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments stripped before anything is located or split, for the reason
 *  theme.test.ts records: a comment above a declaration otherwise becomes part
 *  of the next property's NAME, and a comment mentioning a selector is found by
 *  indexOf before the rule is. This file's CSS is heavily commented, so the trap
 *  is live rather than hypothetical. */
const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block of a rule, by its exact selector. */
function block(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector} in style.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (close < 0) throw new Error(`unterminated rule for ${selector}`);
  return css.slice(open + 1, close);
}

function lengthOf(declarations: string, property: string, unit: "px" | "em"): number {
  const match = declarations.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([\\d.]+)${unit}`));
  if (match?.[1] === undefined) {
    throw new Error(`no ${property} in ${unit}: ${declarations.trim()}`);
  }
  return Number(match[1]);
}

describe("the manuscript's paragraphs", () => {
  const paragraph = block("#editor .ProseMirror p");
  const successive = block("#editor .ProseMirror p + p");

  test("successive paragraphs are indented", () => {
    expect(lengthOf(successive, "text-indent", "em")).toBeGreaterThan(0);
  });

  test("the first paragraph of a document is NOT indented", () => {
    // This is the whole reason the rule is `p + p` rather than `p`. One scene is
    // one document, so a document's first paragraph is always a scene opening,
    // and a printed novel leaves that one flush. A bare `p { text-indent }`
    // indents it, which is the mistake this asserts against.
    expect(paragraph).not.toContain("text-indent");
  });

  test("each paragraph takes its direction from its own text", () => {
    // Without this the indent is on the wrong end of every RTL paragraph.
    // text-indent resolves against `direction`, nothing in this application
    // sets it, so a Hebrew paragraph computes `ltr` and gets its indent where
    // its line ENDS. Measured, not reasoned: headless Chromium put the Hebrew
    // first line at 403 against a box starting at 377 - the same offset as the
    // Latin one - and plaintext moved it to line-right 868 against box-right
    // 893. Latin was unchanged either way.
    //
    // The tiny fixture's prose is Hebrew and Arabic, so this is the app's
    // ordinary case, not an edge one.
    expect(paragraph).toContain("unicode-bidi: plaintext");
  });

  test("paragraphs are not also spaced apart", () => {
    // Indent AND a blank line is the belt-and-braces version that means neither.
    // In print the blank line is a SCENE break; spending it on every paragraph
    // leaves prose with no way to say anything else.
    expect(paragraph).toContain("margin: 0");
    expect(paragraph).not.toMatch(/margin[^;]*\dem/);
  });
});

describe("the manuscript is the lit surface", () => {
  const pane = block("#editor");
  const page = block("#editor .ProseMirror");

  test("the pane and the page both carry the paper token", () => {
    // The pane and the page share --bg deliberately: one lit
    // tone for the prose, --nav-bg for the frame around it, no seam between
    // them.
    expect(pane).toContain("background: var(--bg)");
    expect(page).toContain("background: var(--bg)");
  });

  test("the desk adds no palette token of its own", () => {
    // Every token is stated three times - light, the media dark block and the
    // [data-theme="dark"] block - and guarded by theme.test.ts. A third
    // recessive tone nobody asked for is not worth that: --nav-bg already
    // names the frame and --bg already names the prose surface, so the desk
    // reuses one of the two that already exist rather than adding a third.
    expect(pane).not.toMatch(/--desk/);
  });

  test("the page fills the pane by a flex rule, never a fixed length", () => {
    // A rig constraint, not taste. outline-cli, export-cli and words-cli each
    // click at `entry.x + entry.w - 4, entry.y + entry.h - 4` off the editable's
    // AT-SPI extents. A FIXED length puts that corner below the window on a
    // short scene, the click lands outside it, and the rig then types somewhere
    // it did not intend and reports a number about it.
    //
    // #editor is a flex column with #scene-heading as its
    // first child, so `flex: 1 0 auto` is what "fill the pane" resolves to
    // now - the grown item fills the pane's content box minus the heading,
    // which is on screen by construction the same way the earlier percentage
    // min-height was. The first draft of THAT slice asserted no min-height at
    // all; the screenshot is what corrected it, and the reasoning still holds
    // here: a page as tall as its prose is a card with dead desk below it,
    // where a click lands on #editor's padding and focus stays put.
    expect(page).toMatch(/flex:\s*1 0 auto/);
    // Anchored to a property boundary. A bare `toContain("height:")` matches
    // `line-height:` and `min-height:` both, which is a guard that cannot be
    // satisfied rather than one that catches anything.
    expect(page).not.toMatch(/(?:^|;)\s*(?:min-)?height\s*:\s*[\d.]+(?:px|em|rem|vh)/);
  });

  // The size and the measure are the writer's, so the figures this
  // section used to read straight out of the page block are var() references
  // now. They come from the :root[data-prose-*] rules instead, and the claim
  // that used to be about ONE column is about TWELVE.
  const sidePadding = Number(
    page.match(/padding:\s*[\d.]+px\s+([\d.]+)px/)?.[1] ??
      (() => {
        throw new Error(`no two-value px padding on the page: ${page.trim()}`);
      })(),
  );

  /** The value one axis rule sets, e.g. `size`/`large` -> 20. */
  function axisLength(axis: string, value: string, unit: "px" | "em"): number {
    return lengthOf(block(`:root[data-prose-${axis}="${value}"]`), `--prose-${axis}`, unit);
  }

  /** The width of the TEXT, which is what a measure describes: box-sizing is
   *  border-box globally, so the page's side padding comes OUT of max-width
   *  rather than sitting around it. */
  const textPx = (size: string, measure: string): number =>
    axisLength("measure", measure, "em") * axisLength("size", size, "px") - 2 * sidePadding;

  test("the page's padding did not eat the default measure", () => {
    // The claim is unchanged and still about the combination every earlier
    // build rendered: 34em is the measure the column was designed at, and adding
    // page padding without raising max-width silently narrows the line length
    // while the comment claiming a comfortable measure goes on saying so.
    expect(textPx("medium", "medium")).toBeGreaterThanOrEqual(34 * axisLength("size", "medium", "px"));
  });

  test("the padding did not eat the narrow measure at the smallest size", () => {
    // The worst of the twelve: the padding is a fixed 32px a side, so it costs
    // the most characters exactly where there are fewest of them. Not held to
    // 34em - narrow is narrower BY REQUEST - but a "narrow" column that came out
    // at half the width of a paperback's would be a broken option rather than a
    // chosen one.
    const smallest = textPx("small", "narrow");
    expect(smallest / axisLength("size", "small", "px")).toBeGreaterThanOrEqual(24);
  });

  test("every measure is wider than the one below it, at every size", () => {
    // The ordering is the whole meaning of the three names. A padding change or
    // an em figure edited in the wrong rule can invert it, and the panel would
    // go on offering Narrow / Medium / Wide as if it had not.
    for (const size of ["small", "medium", "large", "larger"]) {
      expect(textPx(size, "narrow")).toBeLessThan(textPx(size, "medium"));
      expect(textPx(size, "medium")).toBeLessThan(textPx(size, "wide"));
    }
  });

  test("every size is larger than the one below it", () => {
    const px = (value: string): number => axisLength("size", value, "px");
    expect(px("small")).toBeLessThan(px("medium"));
    expect(px("medium")).toBeLessThan(px("large"));
    expect(px("large")).toBeLessThan(px("larger"));
  });
});

describe("the bundled prose serif", () => {
  const ui = join(import.meta.dir, "..");
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]!);

  test("four Crimson Pro faces, each a file in app/ui/fonts, swapped in", () => {
    expect(faces).toHaveLength(4);
    const styles = new Set<string>();
    for (const face of faces) {
      expect(face).toContain('font-family: "Crimson Pro"');
      expect(face).toContain("font-display: swap");
      const file = /url\("([^"/]+\.woff2)"\)/.exec(face)?.[1];
      // Flat: the packages checksum `dist/*`, which a subfolder would break.
      expect(file).toBeDefined();
      expect(existsSync(join(ui, "fonts", file!))).toBe(true);
      styles.add(`${/font-style:\s*(\w+)/.exec(face)?.[1]} ${/font-weight:\s*(\d+)/.exec(face)?.[1]}`);
    }
    expect([...styles].sort()).toEqual(["italic 400", "italic 700", "normal 400", "normal 700"]);
  });

  test("the build copies the fonts flat into dist", () => {
    const pkg = JSON.parse(readFileSync(join(ui, "package.json"), "utf8")) as { scripts: { build: string } };
    expect(pkg.scripts.build).toContain("fonts/*.woff2 dist/");
  });

  test("it leads the serif stack only; sans and mono are the platform's", () => {
    const family = (value: string): string => {
      const at = css.indexOf(`:root[data-prose-family="${value}"]`);
      return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    };
    expect(family("serif")).toMatch(/--prose-family:\s*"Crimson Pro",\s*Georgia/);
    expect(family("sans")).not.toContain("Crimson Pro");
    expect(family("mono")).not.toContain("Crimson Pro");
  });

  test("its licence ships in the notices", () => {
    const notices = readFileSync(join(ui, "..", "..", "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notices).toContain("Crimson Pro");
    expect(notices).toContain("app/ui/fonts/");
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
