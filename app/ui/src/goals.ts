// app/ui/src/goals.ts
// How many words a day the writer is aiming for, and what today's figure reads
// as against it.
//
// Presets are the panel's shortcuts; custom values share the host's canonical
// decimal-string contract. No root attribute or first-paint script is involved.
//
// The spellings ARE the numbers ("500" -> 500), which is why no table maps one to
// the other. A third statement listing `{ "500": 500 }` would be a place for the
// two to disagree, and the disagreement would be silent: the panel would offer
// five hundred and the bar would count against something else.

import { formatNumber, plural, t } from "./i18n";

export type DailyTarget = "off" | `${number}`;

/** In control order, which is the order the panel paints. `off` first because it
 *  is the default and because a writer turning the goal off looks for it where a
 *  list starts. */
export const DAILY_TARGETS = ["off", "250", "500", "1000", "2000"] as const;
export type DailyTargetPreset = (typeof DAILY_TARGETS)[number];

export const DEFAULT_DAILY_TARGET: DailyTarget = "off";

export function isDailyTarget(value: unknown): value is DailyTarget {
  if (typeof value !== "string") return false;
  if (value === "off") return true;
  const words = Number(value);
  return Number.isInteger(words) && words >= 1 && words <= 1_000_000 && String(words) === value;
}

/** Narrow whatever the host injected. Anything else is `off`: a page that cannot
 *  read the target must not invent one, because a figure counted against a
 *  target the writer did not choose is worse than no figure at all. */
export function dailyTargetFrom(value: unknown): DailyTarget {
  return isDailyTarget(value) ? value : DEFAULT_DAILY_TARGET;
}

/** The number behind the name, or null for `off`. `Number(target)` and nothing
 *  else, so the name and the count cannot drift apart. */
export function targetWords(target: DailyTarget): number | null {
  return target === "off" ? null : Number(target);
}

/**
 * The writer's own date, as `YYYY-MM-DD`.
 *
 * BUILT BY HAND rather than by `toLocaleDateString("en-CA")`, which produces
 * this shape today. That is a locale convention and a property of whatever ICU
 * data the runtime was built with, not a guarantee; the host refuses anything
 * that is not ten characters of the expected shape, so a runtime that formatted
 * it differently would turn the day's figure into an em dash and give no clue
 * why. Three lines of arithmetic have no such dependency.
 *
 * LOCAL, never UTC. A writer's day is the one their clock shows; `toISOString`
 * would give a writer west of Greenwich a day that turns in the afternoon.
 */
export function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Today's line in the bar.
 *
 * THE SIGN IS CARRIED, and the minus sign is U+2212 rather than a hyphen: this
 * is a negative quantity being displayed, not a range or a compound word, and a
 * hyphen-minus renders visibly shorter next to the digits it belongs to.
 *
 * A day spent cutting reads as a loss because it IS one, in the only unit this
 * bar counts. Flooring at zero would tell a writer who deleted a chapter that
 * their afternoon did not happen.
 *
 * With a target set the figure is `320 of 500 today`, which says what the second
 * number is without a word for it. `320 / 500` needs the reader to know the
 * convention; `320 of 500` does not.
 */
export function progressDisplay(today: number, target: DailyTarget): string {
  const words = targetWords(target);
  const count = today < 0 ? `−${formatNumber(Math.abs(today))}` : formatNumber(today);
  return words === null
    ? t("goals.today", { count })
    : t("goals.today.target", { count, target: formatNumber(words) });
}

/**
 * The same two figures for a screen reader, which has no bar to look at.
 *
 * A SECOND INDEPENDENT RENDERING of the same held numbers, never the string
 * above parsed or extended: the display is compact because it sits beside five
 * controls, and the spoken form has no such constraint. Tying them together is
 * the recorded defect that made the bar's wording load-bearing for
 * accessibility.
 *
 * "written today" rather than "today", because read aloud after two other
 * figures a bare number and a date word do not say what was counted.
 */
export function progressSpoken(today: number, target: DailyTarget): string {
  const words = targetWords(target);
  const magnitude = formatNumber(Math.abs(today));
  const count =
    today < 0
      ? plural("goals.spoken.cut", Math.abs(today), { count: magnitude })
      : plural("goals.spoken.written", today, { count: magnitude });
  return words === null
    ? t("goals.spoken.today", { count })
    : t("goals.spoken.today.target", { count, target: formatNumber(words) });
}
