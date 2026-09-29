// app/ui/src/revision-states.ts
// Where each part of the manuscript stands, as data. No DOM and no IPC: the
// navigator paints it, the panel sets it, the statistics panel counts it, and
// all three read the words from here.
//
// THE SET IS CLOSED and it is RESTATED, not imported. `ITEM_STATES` in
// store/mod.rs is the host's copy and there is no import across that boundary,
// exactly as `TRASH_TYPE` and `SCENE_TYPE` are restated. A drift shows up as a
// state the host refuses (a banner) rather than as a silent nothing, and
// `revision-states.test.ts` parses the Rust to fail on it here first.
//
// `none` IS NOT A MEMBER. It is the absence of a state, spelled `null` on the
// page and NULL in the store - the same rule as `data-theme="system"` being
// removed rather than written, and as an absent word count rendering as nothing
// rather than as 0. A default written as a value is a default free to drift from
// the code's idea of the default.

import { t } from "./i18n";

export type RevisionState = "outline" | "draft" | "revising" | "done";

/** In the order a manuscript moves through them, which is also the order the
 *  panel and the statistics distribution list them in. Nothing enforces the
 *  progression: a writer may put a finished chapter back to `revising`, which is
 *  most of what revising is. */
export const REVISION_STATES: readonly RevisionState[] = [
  "outline",
  "draft",
  "revising",
  "done",
];

export function isRevisionState(value: unknown): value is RevisionState {
  return typeof value === "string" && (REVISION_STATES as readonly string[]).includes(value);
}

/** What the writer reads, and what a screen reader is told. One string per
 *  state, used by the panel's buttons, by the row descriptions and by the
 *  statistics rows - so a wording change happens once. */
export const STATE_LABELS: Record<RevisionState, string> = {
  outline: t("state.label.outline"),
  draft: t("state.label.draft"),
  revising: t("state.label.revising"),
  done: t("state.label.done"),
};

/** The absence, named. Only ever shown where a choice is offered (the panel's
 *  fifth button, the distribution's last row); a row carrying no state shows
 *  NOTHING in the navigator, for the same reason an absent word count does. */
export const NO_STATE_LABEL = t("state.label.none");

/** The mark a row wears.
 *
 *  A FILL PROGRESSION, NOT A PALETTE, and that is the whole reason these are
 *  glyphs rather than four coloured dots. Colour alone cannot carry the state:
 *  about one man in twelve cannot tell the red from the green half of any scale
 *  built that way, and a manuscript printed or screenshotted in grey loses it
 *  entirely. An empty ring filling to a solid disc says how far along a row is
 *  with no colour at all; the stylesheet then tints them, so the two channels
 *  agree and either one alone is enough.
 *
 *  ONE CHARACTER EACH. The row is a flex line of exactly ROW_HEIGHT and a mark
 *  that wrapped would break every geometry rig that computes a click from it.
 */
export const STATE_MARKS: Record<RevisionState, string> = {
  outline: "○", // ○ empty ring
  draft: "◔", // ◔ a quarter filled
  revising: "◕", // ◕ three quarters filled
  done: "●", // ● solid
};

/** The mark for a row, or "" for a row with no state. Never a placeholder: a
 *  marker for "unset" on most rows of a manuscript nobody has marked yet is
 *  noise in the surface a writer scans. */
export function markFor(state: string | null | undefined): string {
  return isRevisionState(state) ? STATE_MARKS[state] : "";
}

/** The id of the element a row's `aria-describedby` points at.
 *
 *  A DESCRIPTION, NOT A NAME, and the distinction is load-bearing. Two graded
 *  rigs locate navigator rows BY ACCESSIBLE NAME (`menu-cli`'s `rowNamed` and
 *  the outline run's alignment), so a state folded into the name would report as
 *  a row that cannot be found rather than as a broken feature - and a writer's
 *  chapter would stop being called what they called it. A description is a
 *  separate string on the same object: the row is still named "Chapter Seven"
 *  and is additionally described as "Draft".
 *
 *  FIVE STATIC ELEMENTS, not one per row. The virtual list recycles row
 *  elements, so a per-row description node would have to be built, kept in sync
 *  and torn down on every paint; an id reference costs one attribute write. */
export function stateDescriptionId(state: RevisionState): string {
  return `nav-state-${state}`;
}

/** How many items carry each state, and how many carry none.
 *
 *  Over whatever walk it is handed - the caller decides what "the manuscript"
 *  means, and the statistics panel hands it the live walk with the bin already
 *  removed. EVERY ITEM TYPE COUNTS, not only scenes: a writer marks a whole
 *  chapter `revising` and that is the ordinary use, so counting scenes alone
 *  would report a book nobody had marked. */
export interface StateDistribution {
  /** Keyed by state, every member present, 0 where nothing carries it. Zero is a
   *  real answer here (nothing is `done` yet) rather than an absence. */
  readonly counts: Record<RevisionState, number>;
  /** Items carrying no state at all. */
  readonly none: number;
  /** Items counted, which is `none` plus every count. */
  readonly total: number;
}

export function stateDistribution(
  items: readonly { readonly state?: string | null }[],
): StateDistribution {
  const counts: Record<RevisionState, number> = {
    outline: 0,
    draft: 0,
    revising: 0,
    done: 0,
  };
  let none = 0;
  for (const item of items) {
    // A state the host reported that this build does not know counts as NONE,
    // and deliberately not as its own bucket: it can only come from a newer
    // build, the navigator draws nothing for it, and a distribution that named
    // it would be the only surface in the application claiming to understand it.
    if (isRevisionState(item.state)) counts[item.state] += 1;
    else none += 1;
  }
  return { counts, none, total: items.length };
}
