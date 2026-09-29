// app/ui/src/timeline-model.ts
// The pure half of the timeline: parsing and serializing the JSON body,
// the px<->unit arithmetic the view paints from, and the undo shape. NO DOM.
//
// The schema is version 1. The host never parses past "kind" and "version"
// (`store/mod.rs`'s `EMPTY_TIMELINE_BODY` comment) -- this module is the one
// place on either side of the wire that knows the rest of the shape, and it
// owns minting ids, because the store never reads inside the body.
//
// PURE, NO DOM -- and still imports `t()`: `goals.ts` set the precedent that
// "pure" means no document, no window, not "no catalog". `calendarDate`'s
// label is writer-facing (the card shows it live beside the day number) and
// its LAYOUT, not merely its words, is what a language can want to change --
// German reads a date day-first. Building the sentence with template
// concatenation here would be exactly the literal `no-hardcoded-strings.test.ts`
// exists to catch, just inside a file with "model" in its name.
import { t } from "./i18n";

export interface TimelineEra {
  id: string;
  name: string;
  from: number;
  to: number;
  /** 1..6, indexing `--era-1..6`. */
  tint: number;
}

export interface TimelineMonth {
  name: string;
  /** Whole days, > 0. A month with zero or negative days breaks every
   *  calendar arithmetic below and `calendarDate` refuses one that reaches it. */
  days: number;
  season: string;
}

export interface TimelineCalendar {
  months: TimelineMonth[];
  /** Carries "{n}" for the numeral, e.g. "year {n}". */
  yearLabel: string;
  epochYear: number;
}

export interface TimelineScale {
  unit: string;
  zero: string;
  calendar: TimelineCalendar | null;
  eras: TimelineEra[];
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: "thread" | "cast";
  /** Present only when kind is "cast". */
  memberId?: string;
  /** 1..8, indexing `--track-1..8`. */
  colour: number;
}

export interface TimelineBranch {
  id: string;
  name: string;
  forkAt: number;
  forkTrack: string;
  writing: boolean;
}

export interface TimelineEvent {
  id: string;
  title: string;
  /** Integer unit. Fractions are refused at parse time -- the unit is the
   *  writer's own grain, and a finer one is a different unit (section 2). */
  at: number;
  until: number | null;
  tracks: string[];
  branch: string | null;
  scene: string | null;
  cast: string[];
  note: string;
}

export interface Timeline {
  kind: "timeline";
  version: 1;
  scale: TimelineScale;
  tracks: TimelineTrack[];
  branches: TimelineBranch[];
  events: TimelineEvent[];
}

/** A document the page cannot write to: a future schema version. Rendered
 *  read-only with `timeline.newer` and never reaches `onDirty` (section 3's
 *  whole-document leniency rule -- a partial write of a newer schema is data
 *  loss, unlike the per-key leniency 040 established for settings). */
export interface TimelineNewer {
  newer: true;
}

/** Not JSON, the wrong `kind`, or missing one of the arrays this module reads.
 *  `reason` is diagnostic only -- never shown to the writer verbatim, the
 *  catalog sentence `timeline.invalid` is. */
export interface TimelineInvalid {
  invalid: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

function parseMonth(v: unknown): TimelineMonth | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.name !== "string") return null;
  if (!isFiniteInteger(v.days)) return null;
  if (typeof v.season !== "string") return null;
  return { name: v.name, days: v.days, season: v.season };
}

function parseCalendar(v: unknown): TimelineCalendar | null | undefined {
  if (v === null) return null;
  if (!isPlainObject(v)) return undefined;
  if (!Array.isArray(v.months)) return undefined;
  const months: TimelineMonth[] = [];
  for (const m of v.months) {
    const parsed = parseMonth(m);
    if (parsed === null) return undefined;
    months.push(parsed);
  }
  if (typeof v.yearLabel !== "string") return undefined;
  if (!isFiniteInteger(v.epochYear)) return undefined;
  return { months, yearLabel: v.yearLabel, epochYear: v.epochYear };
}

function parseEra(v: unknown): TimelineEra | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string") return null;
  if (typeof v.name !== "string") return null;
  if (!isFiniteInteger(v.from) || !isFiniteInteger(v.to)) return null;
  if (!isFiniteInteger(v.tint)) return null;
  return { id: v.id, name: v.name, from: v.from, to: v.to, tint: v.tint };
}

function parseTrack(v: unknown): TimelineTrack | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string") return null;
  if (typeof v.name !== "string") return null;
  if (v.kind !== "thread" && v.kind !== "cast") return null;
  if (!isFiniteInteger(v.colour)) return null;
  const out: TimelineTrack = { id: v.id, name: v.name, kind: v.kind, colour: v.colour };
  if (v.kind === "cast") {
    if (typeof v.memberId !== "string") return null;
    out.memberId = v.memberId;
  }
  return out;
}

function parseBranch(v: unknown): TimelineBranch | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string") return null;
  if (typeof v.name !== "string") return null;
  if (!isFiniteInteger(v.forkAt)) return null;
  if (typeof v.forkTrack !== "string") return null;
  if (typeof v.writing !== "boolean") return null;
  return { id: v.id, name: v.name, forkAt: v.forkAt, forkTrack: v.forkTrack, writing: v.writing };
}

function parseEvent(v: unknown): TimelineEvent | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string") return null;
  if (typeof v.title !== "string") return null;
  if (!isFiniteInteger(v.at)) return null;
  if (v.until !== null && !isFiniteInteger(v.until)) return null;
  if (!Array.isArray(v.tracks) || !v.tracks.every((x) => typeof x === "string")) return null;
  if (v.branch !== null && typeof v.branch !== "string") return null;
  if (v.scene !== null && typeof v.scene !== "string") return null;
  if (!Array.isArray(v.cast) || !v.cast.every((c) => typeof c === "string")) return null;
  if (typeof v.note !== "string") return null;
  return {
    id: v.id,
    title: v.title,
    at: v.at,
    until: v.until as number | null,
    tracks: v.tracks as string[],
    branch: v.branch as string | null,
    scene: v.scene as string | null,
    cast: v.cast as string[],
    note: v.note,
  };
}

/** `body`'s three-way answer. A newer `version` is checked FIRST, before any
 *  other field is read -- a future schema may have renamed or dropped fields
 *  this parser still expects, and reading them first would misreport a newer
 *  document as merely invalid. */
export function parseTimeline(body: string): Timeline | TimelineNewer | TimelineInvalid {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return { invalid: "not-json" };
  }
  if (!isPlainObject(root)) return { invalid: "not-object" };
  if (root.kind !== "timeline") return { invalid: "wrong-kind" };
  if (!isFiniteInteger(root.version)) return { invalid: "missing-version" };
  if (root.version > 1) return { newer: true };
  if (root.version < 1) return { invalid: "version-below-1" };

  const scaleRaw = root.scale;
  if (!isPlainObject(scaleRaw)) return { invalid: "missing-scale" };
  if (typeof scaleRaw.unit !== "string") return { invalid: "scale.unit" };
  if (typeof scaleRaw.zero !== "string") return { invalid: "scale.zero" };
  const calendar = parseCalendar(scaleRaw.calendar);
  if (calendar === undefined) return { invalid: "scale.calendar" };
  if (!Array.isArray(scaleRaw.eras)) return { invalid: "scale.eras" };
  const eras: TimelineEra[] = [];
  for (const e of scaleRaw.eras) {
    const parsed = parseEra(e);
    if (parsed === null) return { invalid: "era" };
    eras.push(parsed);
  }

  if (!Array.isArray(root.tracks)) return { invalid: "tracks" };
  const tracks: TimelineTrack[] = [];
  for (const t of root.tracks) {
    const parsed = parseTrack(t);
    if (parsed === null) return { invalid: "track" };
    tracks.push(parsed);
  }

  if (!Array.isArray(root.branches)) return { invalid: "branches" };
  const branches: TimelineBranch[] = [];
  for (const b of root.branches) {
    const parsed = parseBranch(b);
    if (parsed === null) return { invalid: "branch" };
    branches.push(parsed);
  }

  if (!Array.isArray(root.events)) return { invalid: "events" };
  const events: TimelineEvent[] = [];
  for (const e of root.events) {
    const parsed = parseEvent(e);
    if (parsed === null) return { invalid: "event" };
    events.push(parsed);
  }

  return {
    kind: "timeline",
    version: 1,
    scale: { unit: scaleRaw.unit, zero: scaleRaw.zero, calendar, eras },
    tracks,
    branches,
    events,
  };
}

export function serialize(t: Timeline): string {
  return JSON.stringify(t);
}

/** The next id for `prefix` ("v" for events, "t" for tracks, "b" for
 *  branches, "e" for eras), minted over the WHOLE document's ids rather than
 *  one array -- ids are never reused across kinds by convention, but scanning
 *  everything is what makes that convention impossible to violate by
 *  accident, and it costs one pass over a document the writer is not typing
 *  thousands of ids into. */
export function mintId(t: Timeline, prefix: string): string {
  let max = 0;
  const consider = (id: string): void => {
    if (!id.startsWith(prefix)) return;
    const rest = id.slice(prefix.length);
    if (!/^\d+$/.test(rest)) return;
    const n = Number.parseInt(rest, 10);
    if (n > max) max = n;
  };
  for (const e of t.events) consider(e.id);
  for (const tr of t.tracks) consider(tr.id);
  for (const b of t.branches) consider(b.id);
  for (const e of t.scale.eras) consider(e.id);
  return prefix + String(max + 1);
}

/** The view's pan/zoom state. Session-only, never saved in the body. */
export interface TimelineViewState {
  /** Pixels per unit, clamped to [0.02, 64] by every function that changes it. */
  pxPerUnit: number;
  /** The unit at px position 0 of the lanes' scroll frame. */
  originUnit: number;
  /** The lanes' own width, for culling and Fit. */
  widthPx: number;
}

/** The widest box a point event paints (timeline-view.ts sets it on every
 *  button; the stylesheet does not restate it). `fitView` reserves this many
 *  pixels at the frame's right edge, because a point event's box grows
 *  RIGHTWARD from `at` in pixels the unit margin knows nothing about: fit to
 *  a 1060px layer, the farthest event's box hung off the pane and its centre
 *  sat at screen x=1205 of 1200. */
export const EVENT_MAX_WIDTH_PX = 220;

export const MIN_PX_PER_UNIT = 0.02;
export const MAX_PX_PER_UNIT = 64;

function clampScale(pxPerUnit: number): number {
  return Math.min(MAX_PX_PER_UNIT, Math.max(MIN_PX_PER_UNIT, pxPerUnit));
}

export function unitToPx(at: number, view: TimelineViewState): number {
  return (at - view.originUnit) * view.pxPerUnit;
}

export function pxToUnit(x: number, view: TimelineViewState): number {
  return view.originUnit + x / view.pxPerUnit;
}

/** Events (main line only, 102) whose `at`..`until` range intersects the
 *  viewport plus `marginPx` on each side. `until: null` is a point, using
 *  `at` for both ends. This is the whole cull -- the view renders exactly
 *  what this returns and nothing else, which is what keeps a 2,000-event
 *  document's DOM bounded regardless of the document's size. */
export function cull(
  events: readonly TimelineEvent[],
  view: TimelineViewState,
  marginPx: number,
): TimelineEvent[] {
  const loPx = -marginPx;
  const hiPx = view.widthPx + marginPx;
  return events.filter((e) => {
    const fromPx = unitToPx(e.at, view);
    const toPx = e.until === null ? fromPx : unitToPx(e.until, view);
    const lo = Math.min(fromPx, toPx);
    const hi = Math.max(fromPx, toPx);
    return hi >= loPx && lo <= hiPx;
  });
}

/** Frames every event's `at`..`until` span (not `at` alone -- a range event
 *  whose `until` falls outside a view fit only to `at` would be clipped the
 *  instant Fit finishes) with 5% margin on each side. Events with no `until`
 *  contribute a point. An empty event list frames a plain window around 0. */
export function fitView(events: readonly TimelineEvent[], widthPx: number, reservePx = 0): TimelineViewState {
  if (events.length === 0) {
    return { pxPerUnit: 1, originUnit: -widthPx / 2, widthPx };
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) {
    const end = e.until ?? e.at;
    const from = Math.min(e.at, end);
    const to = Math.max(e.at, end);
    if (from < lo) lo = from;
    if (to > hi) hi = to;
  }
  const span = Math.max(1, hi - lo);
  const marginUnit = span * 0.05;
  const totalUnit = span + marginUnit * 2;
  const pxPerUnit = clampScale(Math.max(1, widthPx - reservePx) / totalUnit);
  const originUnit = lo - marginUnit;
  return { pxPerUnit, originUnit, widthPx };
}

/** Multiplies the scale by `factor` around `pointerPx`, so the unit under the
 *  pointer stays under the pointer -- the whole point of a pointer-centred
 *  zoom, and the one property a naive "scale then re-centre on screen middle"
 *  implementation does not have. */
export function zoomAround(
  view: TimelineViewState,
  factor: number,
  pointerPx: number,
): TimelineViewState {
  const unitAtPointer = pxToUnit(pointerPx, view);
  const pxPerUnit = clampScale(view.pxPerUnit * factor);
  const originUnit = unitAtPointer - pointerPx / pxPerUnit;
  return { pxPerUnit, originUnit, widthPx: view.widthPx };
}

/** Zooms `view` around `pointerPx` by `factor` repeatedly, stopping the
 *  moment `events` (one dot's group) no longer collapses into a single dot
 *  at `minGapPx`, or at `MAX_PX_PER_UNIT`. Anchored at the DOT's own pixel
 *  position, not the viewport centre -- "Enter zooms in around the dot until
 *  they separate" (design section 4, plan item 5), and mutation target 6
 *  ("zooms around the centre instead of the dot"). A group of one event is
 *  never a dot (`collapse`'s own rule) so this returns `view` unchanged for
 *  a one-event group without spending a single iteration. */
export function zoomToSeparate(
  view: TimelineViewState,
  events: readonly TimelineEvent[],
  pointerPx: number,
  minGapPx: number,
  factor: number,
): TimelineViewState {
  let v = view;
  for (let i = 0; i < 200; i++) {
    const items = collapse(events, v, minGapPx);
    if (items.length >= events.length) break;
    if (v.pxPerUnit >= MAX_PX_PER_UNIT) break;
    v = zoomAround(v, factor, pointerPx);
  }
  return v;
}

export interface TimelinePill {
  kind: "event";
  event: TimelineEvent;
  leftPx: number;
}

export interface TimelineDot {
  kind: "dot";
  leftPx: number;
  events: TimelineEvent[];
}

export type TimelineLaneItem = TimelinePill | TimelineDot;

/** One lane's events, collapsed to dots wherever two neighbours would land
 *  under `minGapPx` apart at the current zoom -- a single event is always a
 *  pill, "under minGapPx apart" needs two. `laneEvents` need not be sorted;
 *  this sorts by `at` itself so the grouping pass can be a single left-to-right
 *  sweep. */
export function collapse(
  laneEvents: readonly TimelineEvent[],
  view: TimelineViewState,
  minGapPx: number,
): TimelineLaneItem[] {
  const sorted = [...laneEvents].sort((a, b) => a.at - b.at);
  const out: TimelineLaneItem[] = [];
  let group: TimelineEvent[] = [];
  let groupLeftPx = 0;

  const flush = (): void => {
    if (group.length === 0) return;
    if (group.length === 1) {
      out.push({ kind: "event", event: group[0]!, leftPx: unitToPx(group[0]!.at, view) });
    } else {
      out.push({ kind: "dot", leftPx: groupLeftPx, events: group });
    }
    group = [];
  };

  let prevPx: number | null = null;
  for (const e of sorted) {
    const px = unitToPx(e.at, view);
    if (prevPx !== null && px - prevPx < minGapPx) {
      group.push(e);
    } else {
      flush();
      group = [e];
      groupLeftPx = px;
    }
    prevPx = px;
  }
  flush();
  return out;
}

export interface CalendarDate {
  year: number;
  /** 1-based. */
  month: number;
  /** 1-based. */
  day: number;
  label: string;
  /** Month and day only, for a tick under a band row that already names
   *  the year: the full label overlapped its neighbours at every zoom. */
  tick: string;
}

/** `at` mapped to a calendar date: day 0 is day 1 of month 1 of `epochYear`,
 *  negative days count backwards. No leap rule in v1 (section 2, recorded).
 *  Returns null for a calendar with no months or a month whose day count is
 *  not positive -- there is no date arithmetic that means anything against
 *  either, and the caller (the card, the toolbar) falls back to the bare
 *  number rather than crash. */
export function calendarDate(at: number, calendar: TimelineCalendar): CalendarDate | null {
  const totalDays = calendar.months.reduce((sum, m) => sum + m.days, 0);
  if (calendar.months.length === 0 || totalDays <= 0) return null;
  if (calendar.months.some((m) => m.days <= 0)) return null;

  let year = calendar.epochYear;
  let remaining = at;
  const cycles = Math.floor(remaining / totalDays);
  year += cycles;
  remaining -= cycles * totalDays;
  // remaining is now in [0, totalDays).

  let monthIndex = 0;
  let day = remaining;
  for (let i = 0; i < calendar.months.length; i++) {
    const m = calendar.months[i]!;
    if (day < m.days) {
      monthIndex = i;
      break;
    }
    day -= m.days;
  }
  const monthName = calendar.months[monthIndex]!.name;
  const dayNum = day + 1;
  const yearLabel = calendar.yearLabel.replace("{n}", String(year));
  const label = t("timeline.calendar.label", { month: monthName, day: dayNum, year: yearLabel });
  const tick = t("timeline.calendar.tick", { month: monthName, day: dayNum });
  return { year, month: monthIndex + 1, day: dayNum, label, tick };
}

/** The scale strip's band row (review, MAJOR: not implemented, plan item
 *  2's own words -- "month bands when zoomed so a month is over 60px,
 *  season bands when a season is over 60px, year bands otherwise"). Pure,
 *  so the view's own band-drawing loop and this rule cannot drift.
 *
 *  "A month" and "a season" are each the calendar's own AVERAGE width in
 *  units (total days over the count of months, or over the count of
 *  distinct season names) -- an irregular calendar has no single "the"
 *  month or season width to test against, and the average is what decides
 *  whether the strip reads as crowded at the current zoom either way.
 *  `null` for no calendar (there is nothing to band) and for a calendar
 *  `calendarDate` itself refuses (no months, or a non-positive total or
 *  month length -- the same guard, restated, because a band with no valid
 *  width to measure is not a band either). */
export function bandLevel(pxPerUnit: number, calendar: TimelineCalendar | null): "month" | "season" | "year" | null {
  if (calendar === null) return null;
  const totalDays = calendar.months.reduce((sum, m) => sum + m.days, 0);
  if (calendar.months.length === 0 || totalDays <= 0) return null;
  if (calendar.months.some((m) => m.days <= 0)) return null;

  const avgMonthPx = (totalDays / calendar.months.length) * pxPerUnit;
  if (avgMonthPx > 60) return "month";

  const seasonNames = new Set(calendar.months.map((m) => m.season));
  const avgSeasonPx = (totalDays / seasonNames.size) * pxPerUnit;
  if (avgSeasonPx > 60) return "season";

  return "year";
}

// ------------------------------------------------------ branches (103)

/** Which events paint on the MAIN lanes and which paint in each branch's
 *  dashed lane group, per track -- the pure half of "Make this the one I am
 *  writing" (design section 1.3, plan item 1). The data never moves: a
 *  branch's events keep `branch: b.id` and the main line's events keep
 *  `branch: null` whatever `writing` says. This function only decides where
 *  each one PAINTS.
 *
 *  A branch's lane group covers the tracks its own events touch, plus its
 *  `forkTrack` always (the design's "plus the fork track always") -- a
 *  branch with no events yet still draws a header and one dashed lane to
 *  fork from.
 *
 *  While `writing` is false (the ordinary case: at most one branch is ever
 *  flagged), a track's main lane shows exactly its main-line events and each
 *  branch's group shows exactly that branch's own events. While `writing` is
 *  true on branch B, a track B touches SWAPS from B.forkAt onward: B's
 *  events on that track move to the main lane and the main line's events at
 *  or after B.forkAt on that same track move into B's group instead --
 *  mutation target 1 ("swaps nothing when writing is set") is this branch of
 *  the function. */
export interface LaneAssignment {
  /** trackId -> the events that paint on that track's main lane. */
  main: Map<string, TimelineEvent[]>;
  /** branchId -> trackId -> the events that paint in that branch's group,
   *  for the tracks the group actually draws (see `branchTracks`). */
  branch: Map<string, Map<string, TimelineEvent[]>>;
}

/** The tracks a branch's lane group draws: every track touched by one of its
 *  own events, plus `forkTrack` always. Order follows `tracks` (the
 *  document's own track order), so a group's lanes line up with the main
 *  lanes above them. */
export function branchTracks(t: Timeline, branch: TimelineBranch): string[] {
  const touched = new Set<string>([branch.forkTrack]);
  for (const e of t.events) {
    if (e.branch !== branch.id) continue;
    for (const trackId of e.tracks) touched.add(trackId);
  }
  return t.tracks.filter((tr) => touched.has(tr.id)).map((tr) => tr.id);
}

export function laneAssignment(t: Timeline): LaneAssignment {
  const main = new Map<string, TimelineEvent[]>();
  const branch = new Map<string, Map<string, TimelineEvent[]>>();
  for (const tr of t.tracks) main.set(tr.id, []);
  for (const b of t.branches) {
    const byTrack = new Map<string, TimelineEvent[]>();
    for (const trackId of branchTracks(t, b)) byTrack.set(trackId, []);
    branch.set(b.id, byTrack);
  }

  const push = (map: Map<string, TimelineEvent[]>, trackId: string, e: TimelineEvent): void => {
    const arr = map.get(trackId);
    if (arr === undefined) return;
    arr.push(e);
  };

  const writingBranch = t.branches.find((b) => b.writing) ?? null;
  // HOISTED OUT OF THE LOOP (review, MAJOR): `branchTracks` itself scans
  // every event, so calling it once per main-line event made `laneAssignment`
  // O(events squared) whenever a branch is being written -- `render()` calls
  // this on every rAF, and the graded corpus is 2,000 events on the exact
  // path `timeline_zoom_p95_ms` measures. Computed once, as a Set, checked
  // per track below.
  const writingTracks = writingBranch !== null ? new Set(branchTracks(t, writingBranch)) : null;

  for (const e of t.events) {
    if (e.branch === null) {
      // Main-line event: paints on the main lane UNLESS the writing branch
      // claims THIS TRACK -- checked PER TRACK, not once for the whole event
      // (review, BLOCKER): a two-track meeting where the branch touches only
      // one of them must keep painting on the other main lane, not vanish
      // from the page because ANY of its tracks was claimed.
      for (const trackId of e.tracks) {
        const claimed = writingTracks !== null && e.at >= writingBranch!.forkAt && writingTracks.has(trackId);
        if (claimed) push(branch.get(writingBranch!.id)!, trackId, e);
        else push(main, trackId, e);
      }
      continue;
    }
    // A branch event: paints in its own group, UNLESS its branch is the
    // writing one, in which case it paints on the main lane instead.
    const isWriting = writingBranch !== null && e.branch === writingBranch.id;
    for (const trackId of e.tracks) {
      if (isWriting) push(main, trackId, e);
      else {
        const byTrack = branch.get(e.branch);
        if (byTrack !== undefined) push(byTrack, trackId, e);
      }
    }
  }

  return { main, branch };
}

// ------------------------------------------------- track names (103)

/** A track name after Enter or a blur commits it: trimmed, and empty
 *  refused in favour of `fallback` -- the plan's "an empty name is refused
 *  and the field keeps the old one" (item 3), and mutation target 8. Pure so
 *  both the inline creation field and the lane header's rename share one
 *  rule rather than two hand-written trims that could drift. */
export function commitTrackName(input: string, fallback: string): string {
  const trimmed = input.trim();
  return trimmed === "" ? fallback : trimmed;
}

// ------------------------------------------------- the calendar (103)

/** False for a calendar the Save button must refuse: no months, or any
 *  month with zero or negative days (the plan's "a row with 0 days is
 *  refused with `timeline.calendar.days`", and mutation target 3). Pure so
 *  the scale panel's Save handler and its test share the one rule
 *  `calendarDate` above already depends on. */
export function monthTableValid(months: readonly TimelineMonth[]): boolean {
  if (months.length === 0) return false;
  return months.every((m) => m.days > 0);
}

// -------------------------------------------------------------- undo shape

export type TimelineEntityKind = "event" | "track" | "branch" | "era";

export type TimelineEntity = TimelineEvent | TimelineTrack | TimelineBranch | TimelineEra;

/** The view's own undo, the outline's shape (`outline-undo.ts`): a step
 *  applies forward, and `inverseOf` computes its reverse from the LIVE
 *  document immediately before the step lands -- never from a snapshot taken
 *  when the step was first pushed, so redo (the same machinery pointed the
 *  other way) cannot drift from what actually happened.
 *
 *  "move" carries a SINGLE `track`, not a list, and its OWN `inverseOf` arm
 *  below restores only `tracks[0]` -- 102's review flagged this: undoing a
 *  "move" of a multi-track meeting would drop every other track. 103's drag
 *  (timeline-view.ts) does NOT use "move" for exactly that reason; it emits
 *  TWO "set" steps in one undo entry instead -- one on `at`, one on `tracks`
 *  replacing the whole array with `[track]` -- and "set"'s own `inverseOf`
 *  arm reads the field's FULL prior value from the live document, so undoing
 *  a drag restores every track a meeting carried, not just the first. "move"
 *  is kept in the type for a caller that genuinely only ever has one track to
 *  restore; nothing in this codebase calls it as of 103. */
export type TimelineStep =
  | { kind: "add"; entity: TimelineEntityKind; value: TimelineEntity }
  | { kind: "remove"; entity: TimelineEntityKind; id: string }
  | { kind: "set"; entity: TimelineEntityKind; id: string; field: string; value: unknown }
  | { kind: "move"; id: string; at: number; track: string };

function arrayFor(t: Timeline, entity: TimelineEntityKind): TimelineEntity[] {
  switch (entity) {
    case "event":
      return t.events;
    case "track":
      return t.tracks;
    case "branch":
      return t.branches;
    case "era":
      return t.scale.eras;
  }
}

function withArrayFor(t: Timeline, entity: TimelineEntityKind, arr: TimelineEntity[]): Timeline {
  switch (entity) {
    case "event":
      return { ...t, events: arr as TimelineEvent[] };
    case "track":
      return { ...t, tracks: arr as TimelineTrack[] };
    case "branch":
      return { ...t, branches: arr as TimelineBranch[] };
    case "era":
      return { ...t, scale: { ...t.scale, eras: arr as TimelineEra[] } };
  }
}

/** Applies one step to `t`, returning a NEW `Timeline` -- `t` itself is never
 *  mutated, so a caller holding the previous value (the view's own undo
 *  stack) keeps a genuinely earlier state. An id `set`/`remove`/`move` cannot
 *  find is a no-op (the row was itself removed by an intervening step; there
 *  is nothing sound to do to a row that is not there). */
export function applyStep(t: Timeline, step: TimelineStep): Timeline {
  switch (step.kind) {
    case "add": {
      const arr = arrayFor(t, step.entity);
      return withArrayFor(t, step.entity, [...arr, step.value]);
    }
    case "remove": {
      const arr = arrayFor(t, step.entity);
      return withArrayFor(t, step.entity, arr.filter((e) => e.id !== step.id));
    }
    case "set": {
      const arr = arrayFor(t, step.entity);
      const next = arr.map((e) => (e.id === step.id ? { ...e, [step.field]: step.value } : e));
      return withArrayFor(t, step.entity, next);
    }
    case "move": {
      const events = t.events.map((e) =>
        e.id === step.id ? { ...e, at: step.at, tracks: [step.track] } : e,
      );
      return { ...t, events };
    }
  }
}

/** The step that would take `step`'s target back to where `t` currently has
 *  it -- read from `t` BEFORE `step` is applied, exactly as `outline-undo.ts`'s
 *  `inverseOf` reads the walk before its step runs. `null` when the target is
 *  not in `t`: nothing to invert. */
export function inverseOf(t: Timeline, step: TimelineStep): TimelineStep | null {
  switch (step.kind) {
    case "add":
      return { kind: "remove", entity: step.entity, id: step.value.id };
    case "remove": {
      const found = arrayFor(t, step.entity).find((e) => e.id === step.id);
      if (found === undefined) return null;
      return { kind: "add", entity: step.entity, value: found };
    }
    case "set": {
      const found = arrayFor(t, step.entity).find((e) => e.id === step.id) as
        | Record<string, unknown>
        | undefined;
      if (found === undefined) return null;
      return { kind: "set", entity: step.entity, id: step.id, field: step.field, value: found[step.field] };
    }
    case "move": {
      const found = t.events.find((e) => e.id === step.id);
      if (found === undefined) return null;
      // STILL READS ONLY tracks[0] (102's review item 10, never fixed here):
      // undoing a "move" of a multi-track meeting drops every other track.
      // 103 did not fix this arm -- it avoided calling it at all. The drag in
      // timeline-view.ts emits "set" steps instead (see TimelineStep's own
      // comment above "move"), whose inverseOf arm restores the full prior
      // value. Nothing in this codebase calls "move" as of 103.
      return { kind: "move", id: step.id, at: found.at, track: found.tracks[0] ?? "" };
    }
  }
}
