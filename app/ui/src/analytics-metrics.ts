import type { LibraryBook } from "./library";
import type { LibraryScope } from "./library-summary";
import { selectSummary } from "./library-summary";

export const SOURCES = ["typing", "pasted", "imported", "restored", "unattributed"] as const;
export type Source = typeof SOURCES[number];
export interface Counts { added: number; deleted: number }
export type Totals = Record<Source, Counts>;
export interface Category { id: string; name: string }
export interface Minute { utc_minute: number; local_day: string; offset_min: number }
export interface Movement extends Minute { item_id: string; utc_ms: number; source: Source; added: number; deleted: number }
export interface Adjustment { category: Category | null; minutes: number | null; source_totals: Totals | null; excluded: boolean; reason: string | null; changed_ms: number }
export type AdjustmentInput = Omit<Adjustment, "changed_ms">;
export interface Segment { id: string; category: Category; started_ms: number; ended_ms: number | null; gap: boolean; minutes: Minute[]; movements: Movement[]; adjustment: Adjustment | null }
export interface Session { id: string; started_ms: number; ended_ms: number | null; start_day: string; start_offset_min: number; metric_version: number; gap: boolean; segments: Segment[] }
export interface Report { recording_enabled: boolean; metric_version: number; motivation_since_ms: number | null; motivation_visible: boolean; forecast_goal_words: number | null; sessions: Session[]; more_sessions: number; source_definition: string; coverage_definition: string }
export interface CustomCategory { category: Category; retired: boolean }
export interface Structure { parts: number; chapters: number; scenes: number; revision_states: Record<string, number>; revision_passes: number; tasks_open: number; tasks_done: number; comments_open: number; comments_resolved: number }
export interface AnalyticsView { generation: number; session_id: string | null; report: Report; custom_categories: CustomCategory[]; selected_category: Category | null; structure: Structure; tracking_on: boolean }

export interface DateRange { from: string; through: string }
export interface Daily { day: string; minutes: number; typingNet: number }
export interface Summary {
  observed: Totals;
  adjusted: Totals;
  observedMinutes: number;
  adjustedMinutes: number;
  days: Daily[];
  sessions: number;
  gaps: number;
  corrections: number;
  undatedCorrections: number;
  coverageStart: string | null;
}

export function emptyTotals(): Totals {
  return Object.fromEntries(SOURCES.map((source) => [source, { added: 0, deleted: 0 }])) as unknown as Totals;
}

function add(target: Totals, source: Source, added: number, deleted: number): void {
  target[source].added += added;
  target[source].deleted += deleted;
}

export function summarize(reports: readonly Report[], range: DateRange, categoryId: string | null, liveSessionId: string | null = null): Summary {
  const observed = emptyTotals();
  const adjusted = emptyTotals();
  const observedMinutes = new Set<string>();
  const adjustedMinutes = new Set<string>();
  const days = new Map<string, { minutes: Set<string>; typingNet: number }>();
  let manualMinutes = 0;
  let sessions = 0;
  let gaps = 0;
  let corrections = 0;
  let undatedCorrections = 0;
  let coverageStart: string | null = null;
  const inRange = (day: string): boolean => (range.from === "" || day >= range.from) && (range.through === "" || day <= range.through);
  for (const report of reports) for (const session of report.sessions) {
    const eligible = session.segments.some((segment) => {
      const category = segment.adjustment?.category ?? segment.category;
      return (categoryId === null || category.id === categoryId)
        && (inRange(session.start_day) || segment.minutes.some((minute) => inRange(minute.local_day))
          || segment.movements.some((movement) => inRange(movement.local_day)));
    });
    if (!eligible) continue;
    sessions++;
    if (session.gap || (session.ended_ms === null && session.id !== liveSessionId) || session.segments.some((segment) => segment.gap)) gaps++;
    if (coverageStart === null || session.start_day < coverageStart) coverageStart = session.start_day;
    for (const segment of session.segments) {
      const correction = segment.adjustment;
      const category = correction?.category ?? segment.category;
      if (categoryId !== null && category.id !== categoryId) continue;
      const included = !correction?.excluded;
      const minutes = segment.minutes.filter((minute) => inRange(minute.local_day));
      const movements = segment.movements.filter((movement) => inRange(movement.local_day));
      if (minutes.length === 0 && movements.length === 0 && (range.from !== "" || range.through !== "")) {
        if (correction !== null) undatedCorrections++;
        continue;
      }
      const allInRange = segment.minutes.every((minute) => inRange(minute.local_day))
        && segment.movements.every((movement) => inRange(movement.local_day));
      for (const minute of minutes) {
        const key = `${minute.utc_minute}`;
        observedMinutes.add(key);
        if (included) {
          adjustedMinutes.add(key);
          const day = days.get(minute.local_day) ?? { minutes: new Set<string>(), typingNet: 0 };
          day.minutes.add(key);
          days.set(minute.local_day, day);
        }
      }
      for (const movement of movements) {
        add(observed, movement.source, movement.added, movement.deleted);
        if (included) {
          add(adjusted, movement.source, movement.added, movement.deleted);
          if (movement.source === "typing") {
            const day = days.get(movement.local_day) ?? { minutes: new Set<string>(), typingNet: 0 };
            day.typingNet += movement.added - movement.deleted;
            days.set(movement.local_day, day);
          }
        }
      }
      if (correction !== null) {
        corrections++;
        // A segment correction has no individual event dates. Apply it to a
        // filtered total only when that segment is wholly in the date range.
        if (!allInRange) { undatedCorrections++; continue; }
        if (included && correction.source_totals !== null) {
          for (const movement of segment.movements) {
            adjusted[movement.source].added -= movement.added;
            adjusted[movement.source].deleted -= movement.deleted;
          }
          for (const source of SOURCES) add(adjusted, source, correction.source_totals[source].added, correction.source_totals[source].deleted);
          undatedCorrections++;
        }
        if (included && correction.minutes !== null) {
          manualMinutes += correction.minutes - new Set(segment.minutes.map((minute) => minute.utc_minute)).size;
          undatedCorrections++;
        }
      }
    }
  }
  return {
    observed, adjusted, observedMinutes: observedMinutes.size, adjustedMinutes: Math.max(0, adjustedMinutes.size + manualMinutes),
    days: [...days].map(([day, value]) => ({ day, minutes: value.minutes.size, typingNet: value.typingNet })).sort((a, b) => a.day.localeCompare(b.day)),
    sessions, gaps, corrections, undatedCorrections, coverageStart,
  };
}

export interface LibrarySelection {
  books: LibraryBook[];
  unresolvedCopies: LibraryBook[][];
  unknown: number;
  outsideScope: number;
}

export function selectLibraryBooks(books: readonly LibraryBook[], scope: LibraryScope, representatives: ReadonlyMap<string, string>, more: number): LibrarySelection {
  const result = selectSummary(books, scope, representatives);
  return { books: result.candidates, unresolvedCopies: result.duplicateUnresolved,
    unknown: result.missingUnknown + result.failedUnknown + result.membershipUnknown + more,
    outsideScope: result.outsideScope };
}

export function streak(days: readonly Daily[], today?: string): { current: number; longest: number } {
  const active = days.filter((day) => day.minutes > 0).map((day) => day.day).sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of active) {
    const previousDay = previous === null ? null : new Date(`${previous}T00:00:00Z`).getTime();
    run = previousDay !== null && new Date(`${day}T00:00:00Z`).getTime() - previousDay === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  const latest = active.at(-1);
  const todayMs = today === undefined ? null : new Date(`${today}T00:00:00Z`).getTime();
  const latestMs = latest === undefined ? null : new Date(`${latest}T00:00:00Z`).getTime();
  return { current: latestMs === null || (todayMs !== null && todayMs - latestMs > 86_400_000) ? 0 : run, longest };
}

export function forecast(days: readonly Daily[], goalRemaining: number, today: string): number | null {
  if (goalRemaining <= 0) return 0;
  const end = new Date(`${today}T00:00:00Z`).getTime();
  const start = end - 13 * 86_400_000;
  const recent = days.filter((day) => { const time = new Date(`${day.day}T00:00:00Z`).getTime(); return time >= start && time <= end; });
  const net = recent.reduce((total, day) => total + day.typingNet, 0);
  const pace = net / 14;
  return pace > 0 ? Math.ceil(goalRemaining / pace) : null;
}
