// app/ui/src/icons.ts
// The icon pack, vendored as data.
//
// LUCIDE (https://lucide.dev), ISC licensed, transcribed from `lucide-react`
// 0.564.0's own icon nodes. The full ISC text -- and the MIT text covering the
// portions Lucide inherits from Feather -- is in THIRD-PARTY-NOTICES.md at the
// root of this repository, beside COPYING.
//
// NOT A DEPENDENCY, NOT A FONT, NOT A URL. This application is offline: it has
// no account, no network and no CDN it could reach even if somebody wrote one
// in. A webfont pack (Font Awesome's free tier, Material Icons as a font) is
// refused on that ground alone, and a runtime package would put a build's icon
// set behind a lockfile resolution rather than in the source tree. What is here
// is the geometry of the icons this application actually draws, and nothing
// else in the pack.
//
// THE ICONS ARE DATA SO THAT SWAPPING PACKS IS A TABLE EDIT. `ICON_PATHS` maps
// a name to path data; `createIcon` is the only code that knows what an SVG
// element looks like. A second file drawing its own geometry would turn a table
// edit back into a search, which is why icons.test.ts asserts that no other
// unit carries a `d="M...`.
//
// TRANSCRIPTION, NOT REDRAWING. Lucide states `italic` and `underline` partly
// as `<line x1 y1 x2 y2>` elements; a line is `M<x1> <y1>L<x2> <y2>` with the
// same stroke, the same cap and the same pixels, so the numbers below are the
// pack's own and no shape here was drawn by hand. An approximation of a named
// pack would be worse than the words it replaced.
//
// THE SVG IS DECORATIVE AND MUST STAY THAT WAY. Every graded rig in this repo
// presses a control by its accessible name through AT-SPI, so the name lives on
// the BUTTON (an `aria-label` out of the i18n catalog) and the graphic is
// `aria-hidden` with `focusable="false"`. An exposed graphic either empties the
// name or pollutes it, and the failure is invisible in a screenshot.

/** The icons this application draws. One entry per control, added when a
 *  control needs one -- not the pack. */
export type IconName =
  | "bold"
  | "italic"
  | "underline"
  | "outline"
  | "menu"
  | "message-square"
  | "search"
  | "book-plus"
  | "book-open"
  | "file-text"
  | "bookmark"
  | "trash-2"
  | "users"
  | "user"
  | "globe"
  | "map-pin"
  | "image"
  | "calendar-range"
  | "circle-check"
  | "x"
  | "circle-help"
  | "grip-vertical"
  | "sun"
  | "moon"
  | "unlink";

const NS = "http://www.w3.org/2000/svg";

/** Lucide's own path data, on its 24x24 grid.
 *
 *  Keys are the pack's icon names, deliberately: a reader who wants to see one
 *  drawn can look it up upstream by the name in this table. */
export const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = Object.freeze({
  // Lucide's sun circle as two arcs, followed by its rays.
  sun: Object.freeze([
    "M16 12a4 4 0 1 1-8 0a4 4 0 0 1 8 0",
    "M12 2v2", "M12 20v2", "M4.93 4.93l1.41 1.41",
    "M17.66 17.66l1.41 1.41", "M2 12h2", "M20 12h2",
    "M6.34 17.66l-1.41 1.41", "M19.07 4.93l-1.41 1.41",
  ]),
  moon: Object.freeze([
    "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401",
  ]),
  bold: Object.freeze(["M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"]),
  italic: Object.freeze(["M19 4L10 4", "M14 20L5 20", "M15 4L9 20"]),
  underline: Object.freeze(["M6 4v6a6 6 0 0 0 12 0V4", "M4 20L20 20"]),
  // "outline" here is Lucide's `panel-left`: an 18x18 rounded rect at (3,3),
  // rx 2, transcribed as a path the same way `underline`'s `<line>` elements
  // were, plus the vertical divider `M9 3v18`.
  outline: Object.freeze([
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M9 3v18",
  ]),
  // Lucide's `menu`: three horizontal `<line>`s, transcribed as `M<x1>
  // <y1>h<dx>` the same way `underline`'s lines were, with the same stroke.
  menu: Object.freeze(["M4 12h16", "M4 6h16", "M4 18h16"]),
  // lucide `message-square`: one path.
  "message-square": Object.freeze(["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"]),
  // lucide `book-plus`: the cover, and a plus on it. Used by the dictionary control.
  "book-plus": Object.freeze([
    "M12 7v6",
    "M16 10H8",
    "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20",
  ]),
  // lucide `search`: a circle (cx 11, cy 11, r 8) as two arcs, and the handle.
  search: Object.freeze(["M19 11a8 8 0 1 1-16 0a8 8 0 0 1 16 0", "M21 21L16.7 16.7"]),
  // the world in the outline. `book-open`, `file-text`, `bookmark` and
  // `trash-2` are the reserved roots' and the notes' glyphs; `users` is the
  // header's cast button. All five straight from `lucide-react` 0.564.0, the
  // package and version THIRD-PARTY-NOTICES.md and this file's own header
  // already name -- the path data is identical between `lucide-react` and
  // `lucide-static` at the same version, but only one name belongs here.
  "book-open": Object.freeze([
    "M12 7v14",
    "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
  ]),
  "file-text": Object.freeze([
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ]),
  bookmark: Object.freeze([
    "M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z",
  ]),
  "trash-2": Object.freeze([
    "M10 11v6",
    "M14 11v6",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M3 6h18",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ]),
  // lucide `users`: two body paths, a partial arc for the second figure, and a
  // circle (cx 9, cy 7, r 4) as two arcs -- the same transcription `search`'s
  // circle already uses.
  users: Object.freeze([
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M16 3.128a4 4 0 0 1 0 7.744",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M13 7a4 4 0 1 1-8 0a4 4 0 0 1 8 0",
  ]),
  // the cast sheet's three kind glyphs and its empty picture square, all
  // straight from `lucide-react`/`lucide-static` 0.564.0, same as the other five.
  // lucide `user`: one path plus a circle (cx 12, cy 7, r 4) as two arcs, the
  // same transcription `search`'s and `users`' circles already use.
  user: Object.freeze([
    "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
    "M16 7a4 4 0 1 1-8 0a4 4 0 0 1 8 0",
  ]),
  // lucide `globe`: a circle (cx 12, cy 12, r 10) as two arcs, then two paths.
  globe: Object.freeze([
    "M22 12a10 10 0 1 1-20 0a10 10 0 0 1 20 0",
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
  ]),
  // lucide `map-pin`: one path, then a circle (cx 12, cy 10, r 3) as two arcs.
  "map-pin": Object.freeze([
    "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
    "M15 10a3 3 0 1 1-6 0a3 3 0 0 1 6 0",
  ]),
  // lucide `image`: a rect (18x18 at (3,3), rx 2) transcribed the same way
  // `outline`'s identical rect already is, a circle (cx 9, cy 9, r 2) as two
  // arcs, and a third path whose upstream form starts with a lowercase `m` --
  // `search`'s own reason for stating its handle as `M21 21L16.7 16.7`
  // rather than lucide's `m21 21-4.3-4.3`: `icons.test.ts` requires every
  // path here to open with an upper-case `M`, so the relative moveto and the
  // relative arc endpoint that follows it are both restated in absolute
  // coordinates, with no change to the shape the numbers draw.
  image: Object.freeze([
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M11 9a2 2 0 1 1-4 0a2 2 0 0 1 4 0",
    "M21 15L17.914 11.914A2 2 0 0 0 15.086 11.914L6 21",
  ]),
  // the timeline's navigator glyph. lucide `calendar-range`, straight
  // from `lucide-react` 0.564.0, same as every icon above. The rect (18x18 at
  // (3,4), rx 2) is transcribed the same way `outline`'s and `image`'s
  // identical rects already are -- only `y` differs (4, not 3), so the arc
  // endpoints move with it (`V6`, not `V5`). The other seven upstream
  // elements are already `<path>`s and need no transcription at all.
  "calendar-range": Object.freeze([
    "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M16 2v4",
    "M3 10h18",
    "M8 2v4",
    "M17 14h-6",
    "M13 18H7",
    "M7 14h.01",
    "M17 18h.01",
  ]),
  // the success notice's mark. lucide `circle-check`: a circle (cx 12,
  // cy 12, r 10) as two arcs, `globe`'s own transcription, then upstream's
  // `m9 12 2 2 4-4` restated with an absolute moveto for the upper-case rule.
  "circle-check": Object.freeze([
    "M22 12a10 10 0 1 1-20 0a10 10 0 0 1 20 0",
    "M9 12l2 2l4-4",
  ]),
  // the panel shell's Close. lucide `x`: upstream's `M18 6 6 18` and
  // `m6 6 12 12` restated with an explicit lineto and an absolute moveto.
  x: Object.freeze(["M18 6L6 18", "M6 6L18 18"]),
  // the help mark beside a figure whose definition left the page. lucide
  // `circle-help`: `circle-check`'s own circle, then upstream's two paths
  // exactly as written.
  "circle-help": Object.freeze([
    "M22 12a10 10 0 1 1-20 0a10 10 0 0 1 20 0",
    "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
    "M12 17h.01",
  ]),
  // the outline table's drag handle. lucide `grip-vertical`: six
  // circles (r 1 at x 9 and 15, y 12, 5 and 19, upstream's order), each as
  // two arcs, the transcription `search`'s circle already uses.
  "grip-vertical": Object.freeze([
    "M10 12a1 1 0 1 1-2 0a1 1 0 0 1 2 0",
    "M10 5a1 1 0 1 1-2 0a1 1 0 0 1 2 0",
    "M10 19a1 1 0 1 1-2 0a1 1 0 0 1 2 0",
    "M16 12a1 1 0 1 1-2 0a1 1 0 0 1 2 0",
    "M16 5a1 1 0 1 1-2 0a1 1 0 0 1 2 0",
    "M16 19a1 1 0 1 1-2 0a1 1 0 0 1 2 0",
  ]),
  // an orphaned comment's mark, the reason its row stands out that
  // survives greyscale. lucide `unlink`: upstream's two relative `m` openers
  // restated with an absolute moveto and an explicit relative lineto for the
  // pair that followed, then its four `<line>`s as `underline`'s were.
  unlink: Object.freeze([
    "M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71",
    "M5.17 11.75l-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71",
    "M8 2L8 5",
    "M2 8L5 8",
    "M16 19L16 22",
    "M19 16L22 16",
  ]),
});

/**
 * The `<svg>` for one icon.
 *
 * Throws on a name nothing vendored, rather than returning an empty graphic: an
 * icon-only control with no icon is a button a writer cannot identify at all,
 * and in a capture it reads as a rendering fault rather than as a missing row
 * in this table.
 *
 * Carries no width, no height and no inline style. Size is the stylesheet's
 * business -- #project-bar's 39px is a click-geometry constant restated in
 * switch-cli and outline-cli, and a length written here would be a second place
 * that constant is decided from.
 */
export function createIcon(name: IconName): SVGSVGElement {
  const paths = ICON_PATHS[name];
  if (paths === undefined) throw new Error(`no vendored icon named ${String(name)}`);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
