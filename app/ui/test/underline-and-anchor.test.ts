// The underline mark and the comment anchor must not be the same visual signal.
//
// The stylesheet's own comment on `.comment-anchor` states the premise this
// slice broke: "Colour is NOT the channel: the underline is the mark, and the
// tint only says which kind of mark it is." That was true while nothing else in
// the prose drew a line under a word. `underline` is now a mark a writer can
// apply with Mod-u and a button, so a passage carrying a note and a passage the
// writer underlined would differ by weight, position and a 13% wash -- and by
// nothing a reader could name.
//
// Checked against the stylesheet SOURCE, not with getComputedStyle: happy-dom
// does no layout and loads no stylesheet, so it reports initial values and an
// assertion on it passes for every implementation including none. Same side of
// that trap as control-weight.test.ts and theme.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments stripped FIRST. This stylesheet's prose names properties and
 *  selectors constantly -- the note quoted above contains the word "underline"
 *  four times -- and a guard reading the raw text would find its target in the
 *  sentence explaining the target. That is a recorded trap in this repo, hit
 *  three times. */
const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block of the first rule whose selector text contains
 *  `selector`. Null when no such rule exists, which every test below treats as
 *  a failure rather than as a pass. */
function block(selector: string): string | null {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

/** The `border-bottom` shorthand's line style, if the block sets one. */
function borderBottomStyle(declarations: string): string | null {
  const match = /(?:^|;)\s*border-bottom\s*:([^;]*)/.exec(declarations);
  if (match === null) return null;
  const words = (match[1] ?? "").trim().split(/\s+/);
  return words.find((w) => /^(solid|dotted|dashed|double|groove|ridge)$/.test(w)) ?? null;
}

/** The declaration block of the rule whose selector is EXACTLY `selector`.
 *
 *  `block()` above matches a substring, which is fine for the two prose rules it
 *  was written for and wrong here: `.tip` is a prefix of
 *  `.tip-anchor`, so a substring search would read the anchor's
 *  block and report on the wrong rule while looking like it worked. */
function exact(selector: string): string | null {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]*+?^$(){}|\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`);
  const match = re.exec(css);
  return match === null ? null : (match[1] ?? "");
}

describe("the two lines under a word are different lines", () => {
  test("the stylesheet actually carries both rules", () => {
    // VACUITY GUARD. Every assertion below reads one of these two blocks, so a
    // renamed selector would pass the file while checking nothing.
    expect(block("#editor .ProseMirror .comment-anchor")).not.toBeNull();
    expect(block("#editor .ProseMirror u")).not.toBeNull();
  });

  test("the comment anchor no longer draws a plain solid line", () => {
    // The distinguishing treatment the underline decision record asks for. A
    // solid 2px accent border under a passage is what a writer's own underline
    // now looks like, so the anchor takes a line style of its own.
    const anchor = block("#editor .ProseMirror .comment-anchor") ?? "";
    const style = borderBottomStyle(anchor);
    expect(style).not.toBeNull();
    expect(style).not.toBe("solid");
  });

  test("the underline mark is a text-decoration, and the anchor is not", () => {
    // Two channels, not one. The anchor is a border below the line box (which
    // is why it clears descenders and why it can carry a wash); the mark is the
    // decoration the writer asked for. A reader who cannot separate the accent
    // tint from the paper still sees two different lines.
    const mark = block("#editor .ProseMirror u") ?? "";
    expect(mark).toMatch(/(?:^|;)\s*text-decoration(?:-line)?\s*:/);
    expect(mark).not.toMatch(/(?:^|;)\s*border-bottom\s*:/);

    const anchor = block("#editor .ProseMirror .comment-anchor") ?? "";
    expect(anchor).not.toMatch(/(?:^|;)\s*text-decoration(?:-line)?\s*:/);
  });

  test("the mark clears descenders instead of sitting on the baseline", () => {
    // The stylesheet's ink-not-boxes lesson, twice learned in this repo: a
    // decoration underline sits on the text's own baseline and cuts through the
    // descenders of g, j, p, q and y at this size. An offset is what moves it.
    const mark = block("#editor .ProseMirror u") ?? "";
    expect(mark).toMatch(/(?:^|;)\s*text-underline-offset\s*:/);
  });

  test("neither rule can change how tall a line of prose sets", () => {
    // A commented paragraph must set identically to an uncommented one and an
    // underlined one to a plain one: the marks come and go as notes are added
    // and as a writer formats, and a paragraph that changed height each time
    // would move everything below it while they read.
    for (const selector of ["#editor .ProseMirror .comment-anchor", "#editor .ProseMirror u"]) {
      const declarations = block(selector) ?? "";
      expect(declarations).not.toMatch(/(?:^|;)\s*(?:min-|max-)?height\s*:/);
      expect(declarations).not.toMatch(/(?:^|;)\s*line-height\s*:/);
      expect(declarations).not.toMatch(/(?:^|;)\s*font-size\s*:/);
      // A non-zero padding-bottom on an inline box does not reflow, but it does
      // grow the painted background, and the anchor paints one.
      expect(declarations).not.toMatch(/(?:^|;)\s*padding\s*:/);
    }
  });
});

describe("the formatting controls in the bubble", () => {
  test("the pressed state changes no geometry", () => {
    // The bubble is a fixed-position toolbar over the selection, not a bar
    // whose height a rig restates -- but a pressed control that grows still
    // shifts the whole toolbar's placement math, so the shared chrome-button
    // rule stays the only place that owns any of these lengths.
    const pressed = block('#format-bubble button[aria-pressed="true"]');
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

  test("the bubble is fixed and above the panels", () => {
    // #format-bubble lives on <body>, never inside #editor -- the memory fix
    // holds only while #editor has no positioned descendants. `fixed`
    // is what lets its left/top be the viewport coordinates
    // bubble-placement.ts computes, and its z-index has to clear every
    // panel's 10 so the toolbar can sit over the prose it rides.
    const bubble = exact("#format-bubble") ?? "";
    expect(bubble).toMatch(/(?:^|;)\s*position\s*:\s*fixed/);
    const z = /(?:^|;)\s*z-index\s*:\s*(\d+)/.exec(bubble);
    expect(z).not.toBeNull();
    expect(Number(z?.[1])).toBeGreaterThan(10);
  });

  test("the symbol is sized in one place, and that size rebuilds the same box", () => {
    // THE ICON'S BOX IS 18px BECAUSE THE LABEL SET IN AN 18px LINE BOX. The
    // shared chrome-button rule is 13px type in an 18px line box, 2px of
    // padding and a 1px border: a 24px control. A BLOCK svg makes the content
    // box exactly its own height, so 16px of glyph plus 1px of margin on every
    // side rebuilds the same 18px box and the same 24px button.
    // `display: block` is half the claim: an inline replaced box is measured
    // against the strut instead, and 18px above the baseline is taller than the
    // strut's ascent.
    //
    // The 16/1 split rather than a flat 18 is optical and a capture set it: at
    // 18px the glyph ran edge to edge and read two sizes larger than the menu
    // titles beside it. The arithmetic is asserted, not the taste.
    const icon = exact("#format-bubble button svg");
    expect(icon).not.toBeNull();
    expect(icon ?? "").toMatch(/(?:^|;)\s*display\s*:\s*block/);
    const size = /(?:^|;)\s*height\s*:\s*(\d+)px/.exec(icon ?? "");
    const margin = /(?:^|;)\s*margin\s*:\s*(\d+)px/.exec(icon ?? "");
    expect(size).not.toBeNull();
    expect(margin).not.toBeNull();
    expect(Number(size?.[1]) + 2 * Number(margin?.[1])).toBe(18);
    expect(icon ?? "").toMatch(/(?:^|;)\s*width\s*:\s*\d+px/);
  });

  test("the tooltip is out of flow, so it cannot change the strip", () => {
    // A TIP IN FLOW IS AN EARLIER DEFECT WITH A NEW CAUSE. That earlier version shipped a
    // control that got NARROWER and wrapped the group at 900px, growing the bar
    // and moving every navigator row under two rigs that went on reporting
    // plausible numbers. A tip is a box with a sentence in it; in flow it would
    // do the same thing every time a writer hovered a control.
    const tip = exact(".tip");
    expect(tip).not.toBeNull();
    expect(tip ?? "").toMatch(/(?:^|;)\s*position\s*:\s*absolute/);
    // And the anchor it is positioned against contributes no box of its own.
    const anchor = exact(".tip-anchor");
    expect(anchor).not.toBeNull();
    expect(anchor ?? "").toMatch(/(?:^|;)\s*position\s*:\s*relative/);
    for (const property of [
      /(?:^|;)\s*(?:min-|max-)?height\s*:/,
      /(?:^|;)\s*line-height\s*:/,
      /(?:^|;)\s*font-size\s*:/,
      /(?:^|;)\s*padding(?:-(?:top|right|bottom|left))?\s*:/,
      /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?(?:-width)?\s*:/,
      /(?:^|;)\s*margin(?:-(?:top|bottom))?\s*:/,
    ]) {
      expect(anchor ?? "").not.toMatch(property);
    }
  });

  test("the tooltip is hidden by an attribute, not by a display rule", () => {
    // `hidden` is what the unit toggles. A `display` declaration on the tip
    // itself would out-specify the UA rule behind that attribute and paint a
    // tooltip that never goes away -- visible in a capture and in nothing else.
    const tip = exact(".tip") ?? "";
    expect(tip).not.toMatch(/(?:^|;)\s*display\s*:/);
    expect(exact(".tip[hidden]") ?? "").toMatch(/display\s*:\s*none/);
  });

  test("a pressed control keeps its treatment under the pointer", () => {
    // The filled tiers carry their own :hover for this reason, and the pressed
    // state is a filled tier: the shared hover rule repaints the background and
    // would leave --bg text on top of it, which is unreadable rather than
    // merely wrong.
    expect(block('#format-bubble button[aria-pressed="true"]:hover')).not.toBeNull();
  });
});
