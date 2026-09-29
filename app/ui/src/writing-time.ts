// app/ui/src/writing-time.ts
// The minutes a writer edited in today, and the one rule behind the figure.
//
// A MINUTE COUNTS WHEN AN EDIT LANDED IN IT. Not a timer, not idle detection,
// no threshold a reader would have to be told: the definition beside the
// figure is the whole definition, and a writer can check it against their own
// memory of the afternoon. The host keeps the count in the project (one `meta`
// row per minute of writing at most); this unit only decides WHEN to tell it,
// which is once per minute and never while tracking is off.

import { localDate } from "./goals";
import { t } from "./i18n";

export type TimeTracking = "on" | "off";

export function timeTrackingFrom(value: unknown): TimeTracking {
  return value === "off" ? "off" : "on";
}

export interface WritingTimeDeps {
  /** Whether the writer has the count switched on. Read per edit, so the
   *  switch takes effect on the next keystroke and not the next launch. */
  tracking(): TimeTracking;
  /** Tell the host an edit landed in this minute of `today`. Answers the
   *  day's minutes, which nothing here keeps. */
  note(today: string): Promise<number>;
  /** The current minute, epoch minutes. Injected so a test can turn it. */
  minute(): number;
}

export interface WritingTime {
  /** The manuscript changed. Cheap: a comparison, and one call per minute. */
  touch(): void;
}

export function createWritingTime(deps: WritingTimeDeps): WritingTime {
  let last: number | null = null;
  return {
    touch(): void {
      if (deps.tracking() === "off") return;
      const now = deps.minute();
      if (now === last) return;
      last = now;
      // Swallowed: the count is informational, and a notice on a keystroke
      // path over a bookkeeping row would cost more than the row is worth.
      deps.note(localDate(new Date())).catch(() => undefined);
    },
  };
}

/** "12 min", "1 h 05 min". Minutes are the unit the rule is stated in, so
 *  minutes are always shown, even past an hour. */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 60) return t("stats.time.minutes", { minutes: String(whole) });
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return t("stats.time.hours", { hours: String(hours), minutes: rest.toString().padStart(2, "0") });
}
