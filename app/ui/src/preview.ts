// app/ui/src/preview.ts
// What the preview rail is handed for each of the two book formats, and the
// pure rules it needs before anything can be painted.
//
// SPLIT FROM THE SURFACE for `covers.ts`'s reason and for the recorded
// `main.ts` one: a rule written inside the unit that happens to need it first is
// a rule no mutation can reach. Both functions here are pure and both have a
// mutation-visible failure mode.
//
// THE DOCUMENTS ARE THE FILE'S OWN BYTES. The host renders the archive, unzips
// it and hands back what it read; nothing in this module or the rail composes
// XHTML. That is the publishing track's constraint (c) and it is why the rail
// can be trusted to disagree with the file only when the file is wrong.

/** One document of the reading order, exactly as it sits in the archive. */
export interface PreviewDocument {
  /** Its path INSIDE the container, e.g. `OEBPS/text/0001.xhtml`. Never a path
   *  on this machine. */
  name: string;
  xhtml: string;
}

export interface EpubPreview {
  documents: PreviewDocument[];
  css: string;
  /** The front cover, cut from the bytes IN THE ARCHIVE. Null when the book has
   *  none, and null when the file the book names has gone. */
  cover_data_uri: string | null;
  items: number;
  words: number;
}

/** The four options, as the host spells them. */
export interface ChapterStyle {
  /** The id of an ornament, or null for none. */
  glyph: string | null;
  new_page: boolean;
  caps_title: boolean;
  drop_cap: boolean;
}

export interface Glyph {
  id: string;
  /** The characters printed. THE HOST'S, never restated here: a second copy of
   *  the ornaments would drift from `design::GLYPHS` the first time one was
   *  revised, and the button shows what the book will show. */
  ornament: string;
}

export interface ChapterStyleView {
  style: ChapterStyle;
  glyphs: Glyph[];
}

/** The three options that are nothing but a stylesheet rule, in the order the
 *  rail offers them. The ornament is the fourth and is markup, so it is not in
 *  this list. */
export const STYLE_FLAGS = ["new_page", "caps_title", "drop_cap"] as const;
export type StyleFlag = (typeof STYLE_FLAGS)[number];

/**
 * The book's stylesheet, rewritten so it applies inside `scope` and nowhere
 * else.
 *
 * THE RAIL IS NOT A READING SYSTEM and this is where that is admitted. A
 * faithful preview would need the archive's own stylesheet applied to the
 * archive's own documents in their own document tree, which is an iframe with
 * a base URL that resolves inside a zip -- something no browser offers. What
 * this does instead is exact for the stylesheet this application WRITES: every
 * rule is a plain selector list, so prefixing each selector with the scope
 * yields the same cascade one level deeper, and `html`/`body` become the scope
 * itself because that element is what stands in for the page.
 *
 * IT REFUSES AN AT-RULE RATHER THAN MANGLING ONE. `@media`, `@font-face` and
 * `@import` do not survive a blind prefix, and a preview that silently dropped
 * half a stylesheet would show a book nobody is going to get. `epub.rs`'s
 * `stylesheet` writes none today and a Rust test says so; this is the second
 * statement, in the other program, and null is what the rail reports.
 */
export function scopeStylesheet(css: string, scope: string): string | null {
  if (css.includes("@")) return null;
  const out: string[] = [];
  for (const rule of css.split("}")) {
    const at = rule.indexOf("{");
    if (at < 0) {
      // Trailing whitespace after the last rule. Anything else here is a
      // stylesheet this function has not understood.
      if (rule.trim() !== "") return null;
      continue;
    }
    const selectors = rule
      .slice(0, at)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (selectors.length === 0) return null;
    const declarations = rule.slice(at + 1).trim();
    // Assembled by JOIN rather than by template, and that is not taste: the
    // page's no-hardcoded-strings guard reads a two-substitution template as a
    // two-word sentence, and its own note says the named-exemption list is the
    // last resort rather than the first. Nothing here is a word.
    const scoped = selectors.map((selector) => {
      if (selector === "html" || selector === "body") return scope;
      const nested = selector.startsWith("html ") || selector.startsWith("body ");
      return [scope, nested ? selector.slice(5) : selector].join(" ");
    });
    out.push([scoped.join(", "), "{", declarations, "}"].join(" "));
  }
  return out.join("\n");
}

/**
 * One document's `<body>`, parsed as XHTML, or null when it is not well-formed.
 *
 * THE ONLY THING ON THIS MACHINE THAT CHECKS THE MARKUP THE HOST WROTE, and it
 * checks it on the bytes that went into the file rather than on a copy. XHTML
 * is XML, so a parser is strict where an HTML parser would quietly repair an
 * unclosed tag -- and a repaired preview of a broken file is precisely the
 * instrument this repo has already paid for once.
 *
 * `parsererror` is how both WebKit and the test environment report a refusal;
 * a document that produced no body at all is the same answer.
 */
export function parseDocumentBody(xhtml: string): Element | null {
  const parsed = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  if (parsed.querySelector("parsererror") !== null) return null;
  return parsed.querySelector("body");
}


// ---- 044: the proof copy ---------------------------------------------------
// A PDF cannot be read back the way an archive can, so the agreement between
// the preview and the file is made one level up: the host loads the proof
// document into a web view, that document's own script cuts it into leaves, and
// what arrives here is those leaves. The rail paints the pages the printer was
// handed.

export interface PdfPreview {
  /** Each leaf, as the markup the printer received. Bounded; `leaves` is the
   *  whole book either way. */
  pages: string[];
  /** The leaves' stylesheet, WITHOUT the `@page` rule -- `scopeStylesheet`
   *  refuses an at-rule, and the sheet size means nothing on a screen. */
  css: string;
  leaves: number;
  truncated: boolean;
  font: string;
  /** Whether the book's own face resolved on this machine. */
  font_resolved: boolean;
  /** KDP's gutter minimum for a book this long, and what the writer set, both
   *  in micrometres. Null when the page count is outside the range they print. */
  gutter_minimum_um: number | null;
  inner_um: number;
  items: number;
  words: number;
}

/**
 * How much to shrink a leaf so it fits the rail.
 *
 * A PURE RULE RATHER THAN A LAYOUT READ INSIDE THE PAINT, for the recorded
 * reason every rule in this module is out here: a scale computed inline is a
 * scale no mutation can reach, and this one has a failure mode that is invisible
 * in a unit test and obvious in a capture -- a leaf wider than the rail, with
 * the outer margin of every page off the edge.
 *
 * NEVER ABOVE 1. A proof leaf is a physical page and blowing it up past its own
 * size would show a writer type larger than the book will set it.
 */
export function scaleFor(available: number, natural: number): number {
  if (!(available > 0) || !(natural > 0)) return 1;
  return Math.min(1, available / natural);
}

/**
 * How much vertical space a scaled leaf no longer needs.
 *
 * A TRANSFORM DOES NOT CHANGE LAYOUT. `scale(0.4)` paints a leaf at two fifths
 * of its size and still reserves every millimetre of the box it had, so a rail
 * of shrunken pages would carry a page-sized column of blank paper after each
 * one -- the whole preview scrolling six times further than it has content. The
 * paint hands this back as a negative margin.
 */
export function shrinkFor(natural: number, scale: number): number {
  if (!(natural > 0) || !(scale > 0)) return 0;
  return Math.max(0, natural * (1 - scale));
}

/** What the rail has to say about the gutter, or null when it has nothing. */
export type GutterVerdict = "unknown" | "clears" | "below";

/**
 * Whether the inner margin clears the printer's minimum for a book this long.
 *
 * 040 LEFT THIS OPEN BECAUSE NOTHING KNEW THE PAGE COUNT, and said so in as many
 * words. A laid-out proof knows. The TABLE is the host's -- this decides only
 * which of three sentences a writer reads, which is `covers.ts`'s rule: the page
 * holds no measurement and no threshold.
 */
export function gutterVerdict(minimum: number | null, inner: number): GutterVerdict {
  if (minimum === null) return "unknown";
  return inner >= minimum ? "clears" : "below";
}
