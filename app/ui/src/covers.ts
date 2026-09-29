// app/ui/src/covers.ts
// The book's front and back covers, as the page sees them.
//
// THIS MODULE HOLDS NO MEASUREMENT AND NO THRESHOLD, which is `book-design.ts`'s
// rule met again and for the same reason. Every figure a writer reads here --
// the pixels, the dots per inch, what the page wants instead, and both verdicts
// -- arrives from the host with the answer, computed by `covers::check` over the
// page size `design::design_of` returned. A page that decided for itself whether
// a cover was sharp enough would be a second statement of a rule the host asks
// anyway, and the recorded way two statements disagree is that nobody notices
// which one answered.
//
// WHAT IS HERE is the mapping from those numbers to a catalog key, and nothing
// else. It is a pure function so it can be tested and mutated, which is what
// `main.ts`'s zero coverage taught: a rule built inline in a panel is a rule no
// mutation can reach.

import { messages, t } from "./i18n";
import { inches, millimetres, type DesignPageSize } from "./book-design";

/** The two sides, in the order a book has them and a panel paints them.
 *  Restated from the host's `covers::SIDES`, exactly as `item-types.ts` restates
 *  the item types and `cast-kinds.ts` the cast kinds -- and `covers.test.ts`
 *  parses `covers.rs` so a third side added on one side only breaks a test. */
export const COVER_SIDES = ["front", "back"] as const;
export type CoverSide = (typeof COVER_SIDES)[number];
export type CoverFit = "contain" | "fill";

/** What the host says about one cover's picture. `pictures::PictureView`, which
 *  the cast panel receives the same shape of: four states, and a `data:` URI of
 *  a thumbnail only when there is one. */
export interface CoverPicture {
  state: string;
  data_uri: string | null;
}

/** What the host measured about one cover, held against this book's page. None
 *  of it is decided here. */
export interface CoverCheck {
  width_px: number;
  height_px: number;
  dpi: number;
  dpi_wanted: number;
  wanted_width_px: number;
  wanted_height_px: number;
  low_resolution: boolean;
  wrong_shape: boolean;
  fit: CoverFit;
}

export interface CoverSideView {
  side: string;
  view: CoverPicture;
  /** Null when there is no readable picture to measure. Never a check full of
   *  zeros: a book with no cover has nothing said about its cover's sharpness. */
  check: CoverCheck | null;
  fit: CoverFit;
}

/** What `covers_get` answers: both sides, and the page they are judged against.
 *  The page travels with the answer so this module states no trim size. */
export interface CoversView {
  page: DesignPageSize;
  sides: CoverSideView[];
}

/** The sentence for a picture state this build knows, or the unreadable one.
 *
 *  A STATE THIS BUILD DOES NOT KNOW FALLS THROUGH TO "could not be read", which
 *  is `pictureSentence`'s rule in the cast panel and `kindKeyFor`'s one surface
 *  further in: a newer host's fifth word must not index into `undefined` and
 *  paint a sentence made of a missing-key marker. It is also the honest answer,
 *  because this build cannot show it. */
export function coverSentence(state: string): string {
  if (state === "none") return t("covers.none");
  if (state === "missing") return t("covers.missing");
  return t("covers.unreadable");
}

/** What the panel says about a cover it CAN measure.
 *
 *  ALWAYS SOMETHING, INCLUDING WHEN NOTHING IS WRONG, and that is the decision
 *  rather than a convenience. A surface that speaks only when it disapproves
 *  leaves a writer unable to tell "this was checked and it is fine" from "this
 *  was not checked", and the moment they need to tell them apart is the moment
 *  before they send their book to a printer.
 *
 *  TWO FINDINGS AND NOT ONE SENTENCE COVERING BOTH. A cover can be sharp and the
 *  wrong shape, or the right shape and far too soft, and the two have different
 *  repairs -- re-export at a larger size, or crop and re-lay-out. One sentence
 *  for both would send a writer to the wrong one half the time, which is the
 *  cast panel's four-states-four-sentences argument in another surface. */
export function coverFindings(check: CoverCheck): string[] {
  const shared = {
    width: String(check.width_px),
    height: String(check.height_px),
    dpi: String(check.dpi),
    wanted: String(check.dpi_wanted),
    wantedWidth: String(check.wanted_width_px),
    wantedHeight: String(check.wanted_height_px),
  };
  const out: string[] = [];
  if (check.low_resolution) out.push(t("covers.check.resolution", shared));
  if (check.wrong_shape) out.push(t(
    check.fit === "fill" ? "covers.check.shape.fill" : "covers.check.shape.contain",
    shared,
  ));
  if (out.length === 0) out.push(t("covers.check.ok", shared));
  return out;
}

/** The line under the heading: what these covers are being held against.
 *
 *  PAINTED FOR EVERY BOOK, `pageReadout`'s rule: it is the only thing on the
 *  panel that says where every figure below it came from, and a writer who
 *  disagrees with a verdict needs to know which page produced it -- and where to
 *  go and change it. */
export function coverPageLine(page: DesignPageSize): string {
  return t("covers.page", {
    width: millimetres(page.width_um),
    height: millimetres(page.height_um),
    widthIn: inches(page.width_um),
    heightIn: inches(page.height_um),
  });
}

/** What a writer reads for a side, and what a screen reader is told a picture
 *  is.
 *
 *  A SIDE THIS PAGE HAS NO WORD FOR renders as the id, `designName`'s rule and
 *  for its reason: the sides come from the host, so a host one version ahead is
 *  exactly the case, and showing `spine` is a true label where showing nothing
 *  is a block with no name at all. */
export function sideName(side: string): string {
  const key = `covers.side.${side}`;
  return messages.has(key) ? t(key) : side;
}

export function coverAlt(side: string): string {
  const key = `covers.alt.${side}`;
  return messages.has(key) ? t(key) : sideName(side);
}
