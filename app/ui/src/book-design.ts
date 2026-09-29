// app/ui/src/book-design.ts
// How the book is set when it LEAVES this application: the body font, the page
// it is set on, and the four margins around it. Per book.
//
// NOT `typography.ts`, AND THE DISTINCTION IS THE WHOLE POINT. That module
// selects one of ten known words and writes it as an attribute on the LIVE
// EDITOR ROOT; every actual value lives in style.css and nothing crosses but
// the word. This module carries physical measurements, has no enum to select
// from, describes a printed page nobody is looking at, and must never touch the
// element the writer is typing into. Editor typography is per writer; book
// design is per book.
//
// THE MEASUREMENTS ARE THE HOST'S AND SO ARE THE RULES. This module holds no
// page size, no margin and no font name: they arrive with `book_design_get`,
// which also carries the presets and everything on offer. What is here is
// arithmetic for the readout and one parser for what a writer types -- and the
// parser answers only "is this a number of millimetres", never "is this design
// legal", because `design::check` in the host owns that and two statements of
// it would drift.

import { messages, t } from "./i18n";

/** Micrometres. One inch is exactly 25 400 of them, so every trim size and
 *  margin quoted in inch fractions is an exact integer, and so is every
 *  millimetre value to three decimals. */
export const UM_PER_MM = 1000;
export const UM_PER_INCH = 25400;

export interface DesignPageSize {
  width_um: number;
  height_um: number;
  /** The name of a size the application offers, when the stored design named
   *  one. Null is a complete answer: a design can hold measurements no preset
   *  has a word for, and the readout says what they are either way. */
  name: string | null;
}

export interface DesignMargins {
  inner_um: number;
  outer_um: number;
  top_um: number;
  bottom_um: number;
}

export interface BookDesign {
  font: string;
  page: DesignPageSize;
  margins: DesignMargins;
}

export interface PageSizeOffer {
  name: string;
  width_um: number;
  height_um: number;
}

export interface DesignPreset {
  id: string;
  design: BookDesign;
}

/** What `book_design_get` answers: how this book is set, and what else it
 *  could be set as. The offerings travel with the answer so this page holds no
 *  measurement of its own. */
export interface BookDesignView {
  design: BookDesign;
  fonts: string[];
  page_sizes: PageSizeOffer[];
  presets: DesignPreset[];
}

/** The four margins, in the order a panel paints them and a stored value lists
 *  them. Inner and outer rather than left and right: facing pages mirror, and
 *  the margin against the binding is the same physical margin on both. */
export const MARGIN_AXES = ["inner", "outer", "top", "bottom"] as const;
export type MarginAxis = (typeof MARGIN_AXES)[number];

export function marginOf(margins: DesignMargins, axis: MarginAxis): number {
  return margins[`${axis}_um`];
}

export function withMargin(
  margins: DesignMargins,
  axis: MarginAxis,
  um: number,
): DesignMargins {
  return { ...margins, [`${axis}_um`]: um };
}

/** A micrometre count as millimetres, with no trailing zeros: 152400 reads
 *  `152.4` and 148000 reads `148`. Three decimals is exactly the resolution
 *  micrometres have, so nothing is rounded away. */
export function millimetres(um: number): string {
  return trim((um / UM_PER_MM).toFixed(3));
}

/** The same in inches, to two decimals -- which is how trim sizes are quoted
 *  (6 x 9, 5.5 x 8.5, 7 x 10) and is not exact for a metric size. The
 *  millimetre reading beside it is the one that is. */
export function inches(um: number): string {
  return trim((um / UM_PER_INCH).toFixed(2));
}

/** Editable inch values keep five decimals: enough to round any integer
 * micrometre back to itself, unlike the two-decimal page readout. */
export function editableInches(um: number): string {
  return trim((um / UM_PER_INCH).toFixed(5));
}

function trim(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** The line under the page-size buttons. ALWAYS PAINTED, for every design,
 *  named or not: it is the only thing on the panel that says what the page
 *  actually measures, and a size this build has no name for would otherwise
 *  light no button and show nothing at all. */
export function pageReadout(page: DesignPageSize): string {
  return t("design.page.readout", {
    width: millimetres(page.width_um),
    height: millimetres(page.height_um),
    widthIn: inches(page.width_um),
    heightIn: inches(page.height_um),
  });
}

/**
 * Millimetres a writer typed, as micrometres, or null.
 *
 * ONLY "is this a number of millimetres". Whether the resulting design fits on
 * the page is `design::check`'s question in the host, and it is asked there
 * because it is asked there anyway -- a page that answered it too would be a
 * second statement of one rule, and the recorded way those two end up
 * disagreeing is that nobody notices which one refused.
 */
export function micrometresFromMillimetres(typed: string): number | null {
  return micrometresFrom(typed, UM_PER_MM);
}

/** Inches a writer typed, as micrometres, or null. */
export function micrometresFromInches(typed: string): number | null {
  return micrometresFrom(typed, UM_PER_INCH);
}

function micrometresFrom(typed: string, unit: number): number | null {
  const text = typed.trim();
  // TWO RULES, and a negative is refused by BOTH -- the pattern has no sign in
  // it and the positivity check below rejects the value. That overlap is
  // inherent rather than a dead guard: neither is redundant (`15mm` and `.5`
  // reach only the pattern, `0` reaches only the check), and no pattern that
  // accepts a bare decimal can accept a minus sign as well. A mutation adding
  // `-?` here is an EQUIVALENT program, and is recorded as one rather than
  // chased with a test that cannot tell the two apart.
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const um = Math.round(Number(text) * unit);
  return um > 0 ? um : null;
}

/** What a writer reads for a named page size or a preset.
 *
 *  An id this page has no word for renders as the id. Not a fallback nobody can
 *  reach: the names come from the host, so a host one version ahead of this page
 *  is exactly the case, and showing `royal` is a true label where showing
 *  nothing is a button with no name at all. */
export function designName(area: "page" | "preset", id: string): string {
  const key = `design.${area}.${id}`;
  return messages.has(key) ? t(key) : id;
}
