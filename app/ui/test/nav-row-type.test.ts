// The navigator row's type, checked against the stylesheet SOURCE.
//
// Not with getComputedStyle: happy-dom does no layout and loads no stylesheet,
// so it reports initial values and an assertion on it passes for every
// implementation including none. That is a recorded trap, and this
// file is deliberately on the other side of it - it reads the CSS as text, the
// way theme.test.ts reads the two palette blocks.
//
// What it cannot check is that the text actually FITS. That was measured by
// rendering "Jonquil pygmy gravy Qq" under headless Chromium against this
// stylesheet with overflow visible and reading the pixels: inherited, the ink
// runs to offset 21 of a 20px row and the bottom 2px of every descender is cut;
// at line-height 20px it runs 4..19 and fits. Chromium is not WebKitGTK, so
// that settles the box model and the screenshot beside the slice is the other
// half. What this file pins is the part that would silently drift: the
// line-height and ROW_HEIGHT agreeing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** app/ui/src/project.ts, and switch-cli / outline-cli / export-cli, all of
 *  which press at `BAR_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2`. Restated
 *  here for the same reason those rigs restate it: a shared constant hides a
 *  drift, two statements fail on it. */
const ROW_HEIGHT = 24;

const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8");

/** The declaration block of a rule, by its exact selector. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector} in style.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (close < 0) throw new Error(`unterminated rule for ${selector}`);
  return css.slice(open + 1, close);
}

/** The declaration block of the rule a selector belongs to, whether it stands
 *  alone or SHARES its block with others in a group. `block` above insists on
 *  `selector {` and therefore only ever finds the last selector of a group --
 *  which is how the bible's rule, grouped with the bin's, was outside
 *  the line-height guard without anything saying so. */
function groupedBlock(selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no rule for ${selector} in style.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) throw new Error(`unterminated rule for ${selector}`);
  return css.slice(open + 1, close);
}

function pxOf(declarations: string, property: string): number {
  const match = declarations.match(new RegExp(`(?:^|;|\\*/)\\s*${property}\\s*:\\s*([\\d.]+)px`));
  if (match?.[1] === undefined) throw new Error(`no ${property} in px: ${declarations.trim()}`);
  return Number(match[1]);
}

describe("the navigator row declares its own type", () => {
  const row = block('#nav [role="treeitem"]');

  test("line-height is exactly ROW_HEIGHT", () => {
    // Inherited, it is body's 16px/1.6 = 25.6px in a 20px box, and the row's
    // `overflow: hidden` cuts the difference off the glyphs. Any value other
    // than ROW_HEIGHT puts the text off-centre in its own row.
    expect(pxOf(row, "line-height")).toBe(ROW_HEIGHT);
  });

  test("the row sets 14px, one step under the 16px UI default", () => {
    // Reversed later: the earlier rule here pinned an INHERITED 16px,
    // on the finding that 16px fits the row's line box without clipping
    // descenders. That finding still holds - line-height is still ROW_HEIGHT,
    // above, for the same reason - but the design now asks for a stated 14px
    // regardless: the navigator is a list a writer scans quickly, one step
    // under the UI default, not a place competing with the prose for size.
    expect(pxOf(row, "font-size")).toBe(14);
  });

  /** Every item type this application creates. Restated here rather than
   *  imported from `item-types.ts`, on the wire-contract rule: a type added on
   *  one side without a rule on the other must break a test. */
  const TYPES = ["part", "chapter", "scene", "trash", "bible", "note", "front", "back", "matter"];

  test("each item type the store emits has a rule of its own", () => {
    // The navigator paints data-type on every row so the outline shows WHAT a
    // row is, not only how deep it sits. A type with no rule renders exactly
    // like a scene, which is the wall-of-identical-text this slice removed - and
    // it would do so silently, because an unmatched attribute selector is not an
    // error.
    // EVERY type the outline can produce, not the three it started with. A
    // section header that rendered exactly like a chapter is the defect the
    // bible's rule exists for, and two more sections and a document
    // type to go under them.
    for (const type of TYPES) {
      expect(css).toContain(`#nav [role="treeitem"][data-type="${type}"]`);
    }
  });

  test("no type rule sets a line-height", () => {
    // The type rules change weight, size, letter-spacing and case, all of which
    // change a line's WIDTH. A line-height would change its HEIGHT, and the row
    // is an absolutely positioned box of exactly ROW_HEIGHT px whose coordinates
    // three rigs compute. Width is free here; height is not.
    for (const type of TYPES) {
      expect(groupedBlock(`#nav [role="treeitem"][data-type="${type}"]`)).not.toContain(
        "line-height",
      );
    }
  });

  test("the row still refuses to wrap", () => {
    // The reason the row can have a fixed height at all. A wrapped row overflows
    // its absolutely positioned box and every rig goes on clicking the row it
    // computed rather than the row a writer sees - silently, as a plausible
    // result.
    expect(row).toContain("white-space: nowrap");
    expect(row).toContain("overflow: hidden");
  });

  test("the TITLE is what truncates, and it can", () => {
    // `text-overflow` moved off the row when the row gained a word count and
    // became a flex container: it only does anything on the element whose text
    // overflows, which is now the title span.
    //
    // `min-width: 0` is the load-bearing half. A flex item's default minimum is
    // its CONTENT, so without it a long title refuses to shrink and pushes the
    // count off the right edge instead of ellipsising - the row does not wrap,
    // so nothing about its height gives the defect away.
    const title = block("#nav .nav-title");
    expect(title).toContain("text-overflow: ellipsis");
    expect(title).toContain("overflow: hidden");
    expect(title).toContain("min-width: 0");
  });

  test("the count changes no height", () => {
    // Same rule the type styles follow, and the same reason: the row is a box of
    // exactly ROW_HEIGHT px whose coordinates five rigs compute. The count
    // uses smaller text without adding line-height, padding or height.
    const count = block("#nav .nav-count");
    expect(count).toContain("font-size");
    expect(count).not.toContain("line-height");
    expect(count).not.toMatch(/(?:^|;)\s*padding\s*:/);
    expect(count).not.toMatch(/(?:^|;)\s*(?:min-)?height\s*:/);
  });
});

describe("the word count does not change a row's accessible name", () => {
  test("the count, state and appearance spans are aria-hidden in the source", () => {
    // A row's accessible name is computed from its CONTENT, so a count inside it
    // appends itself to every title. Two graded rigs locate rows BY NAME in the
    // painted tree - menu-cli's rowNamed, which additionally refuses a duplicate
    // title, and the outline run's alignment. Neither would report a broken
    // name; they would report a row that could not be found.
    //
    // The cost is real and recorded in the write-back: a screen-reader user is
    // not told a chapter's length. Getting it to them means changing the tree's
    // names, which is a decision with two rigs attached rather than a line of
    // markup.
    return Bun.file("app/ui/src/navigator/index.ts")
      .text()
      .then((src) => {
        for (const cls of ["nav-count", "nav-state", "nav-appearances", "nav-synopsis"]) {
          const at = src.indexOf(`className = "${cls}"`);
          expect(at).toBeGreaterThan(-1);
          expect(src.slice(at, at + 900)).toContain('setAttribute("aria-hidden", "true")');
        }
        // The state reaches a screen reader through a DESCRIPTION instead, which
        // is a different string on the same object and cannot disturb the name.
        expect(src).toContain("described.push(stateDescriptionId(");
        expect(src).toContain('setAttribute("aria-describedby", described.join(" "))');
      });
  });

  test("the four spans are created once per element, not per paint", () => {
    // The virtual list repaints on every scroll, so building four elements per
    // paint would be real work on a measured path. partsOf returns the existing
    // set when the element already has one, which for a recycled row is always.
    // Appearance summaries have their own span; the world glyph remains
    // nested inside `.nav-title` by `paintTitle`.
    return Bun.file("app/ui/src/navigator/index.ts")
      .text()
      .then((src) => {
        const at = src.indexOf("function partsOf");
        expect(at).toBeGreaterThan(-1);
        // "\n}\n", not "\n}": partsOf's own RETURN TYPE is a multi-line object
        // annotation, so the first "\n}" in it closes the type rather than the
        // function and the slice held no body at all.
        const body = src.slice(at, src.indexOf("\n}\n", at));
        // The early return reuses all four elements.
        expect(body).toContain(
          "return { title: first, synopsis: second, appearances: third, state: fourth, count: fifth }",
        );
        // And the paint path must go through it rather than setting textContent
        // on the row, which would delete every span.
        expect(src).not.toContain("el.textContent = row.title");
      });
  });
});
