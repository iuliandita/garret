import { describe, expect, test } from "bun:test";
import {
  applyStep,
  bandLevel,
  branchTracks,
  calendarDate,
  collapse,
  commitTrackName,
  cull,
  fitView,
  inverseOf,
  laneAssignment,
  mintId,
  monthTableValid,
  parseTimeline,
  pxToUnit,
  serialize,
  unitToPx,
  zoomAround,
  zoomToSeparate,
  type Timeline,
  type TimelineEvent,
  type TimelineViewState,
} from "../src/timeline-model";

function baseTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    kind: "timeline",
    version: 1,
    scale: { unit: "day", zero: "Kell's death", calendar: null, eras: [] },
    tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
    branches: [],
    events: [],
    ...overrides,
  };
}

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "v1",
    title: "Publishes survey",
    at: 372,
    until: null,
    tracks: ["t1"],
    branch: null,
    scene: null,
    cast: [],
    note: "",
    ...overrides,
  };
}

describe("parseTimeline", () => {
  test("round-trips a minimal document", () => {
    const t = baseTimeline({ events: [event()] });
    const parsed = parseTimeline(serialize(t));
    expect(parsed).toEqual(t);
  });

  test("a document with a calendar and eras round-trips", () => {
    const t = baseTimeline({
      scale: {
        unit: "day",
        zero: "",
        calendar: {
          months: [{ name: "Thaw", days: 36, season: "Spring" }],
          yearLabel: "year {n}",
          epochYear: 1,
        },
        eras: [{ id: "e1", name: "Spring", from: 340, to: 460, tint: 3 }],
      },
    });
    expect(parseTimeline(serialize(t))).toEqual(t);
  });

  test("not JSON is invalid", () => {
    const out = parseTimeline("not json");
    expect("invalid" in out).toBe(true);
  });

  test("the wrong kind is invalid", () => {
    const out = parseTimeline(JSON.stringify({ kind: "not-timeline", version: 1 }));
    expect("invalid" in out).toBe(true);
  });

  test("a missing array is invalid", () => {
    const t = baseTimeline();
    const raw = JSON.parse(serialize(t));
    delete raw.events;
    const out = parseTimeline(JSON.stringify(raw));
    expect("invalid" in out).toBe(true);
  });

  test("version above 1 is newer, not invalid", () => {
    const raw = { ...JSON.parse(serialize(baseTimeline())), version: 2 };
    const out = parseTimeline(JSON.stringify(raw));
    expect(out).toEqual({ newer: true });
  });

  test("a fractional at is invalid", () => {
    const t = baseTimeline({ events: [event({ at: 1.5 })] });
    const out = parseTimeline(serialize(t));
    expect("invalid" in out).toBe(true);
  });

  test("500 generated events round-trip byte-for-byte through parse/serialize", () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(
        event({
          id: `v${i}`,
          title: `Event ${i}`,
          at: (i * 37) % 3000,
          until: i % 5 === 0 ? ((i * 37) % 3000) + 10 : null,
          tracks: [i % 2 === 0 ? "t1" : "t2"],
          scene: i % 7 === 0 ? `it-${i}` : null,
          cast: i % 3 === 0 ? ["c1"] : [],
        }),
      );
    }
    const t = baseTimeline({
      tracks: [
        { id: "t1", name: "Ines", kind: "thread", colour: 1 },
        { id: "t2", name: "Thren", kind: "cast", colour: 2, memberId: "c1" },
      ],
      events,
    });
    const parsed = parseTimeline(serialize(t));
    expect(parsed).toEqual(t);
  });
});

describe("mintId", () => {
  test("mints v1 for an empty document", () => {
    expect(mintId(baseTimeline(), "v")).toBe("v1");
  });

  test("mints one past the highest existing id with that prefix", () => {
    const t = baseTimeline({ events: [event({ id: "v3" }), event({ id: "v7" })] });
    expect(mintId(t, "v")).toBe("v8");
  });

  test("scans every collection, not just events", () => {
    const t = baseTimeline({ tracks: [{ id: "t5", name: "X", kind: "thread", colour: 1 }] });
    expect(mintId(t, "t")).toBe("t6");
  });
});

describe("unit/px conversion", () => {
  const view: TimelineViewState = { pxPerUnit: 2, originUnit: 100, widthPx: 800 };

  test("unitToPx and pxToUnit invert each other", () => {
    expect(unitToPx(150, view)).toBe(100);
    expect(pxToUnit(100, view)).toBe(150);
  });
});

describe("cull", () => {
  const view: TimelineViewState = { pxPerUnit: 1, originUnit: 0, widthPx: 100 };

  test("keeps events inside the viewport plus margin, drops those outside", () => {
    const inside = event({ id: "v1", at: 50 });
    const justOutMargin = event({ id: "v2", at: 500 });
    const withinMargin = event({ id: "v3", at: 120 });
    const out = cull([inside, justOutMargin, withinMargin], view, 30);
    const ids = out.map((e) => e.id);
    expect(ids).toContain("v1");
    expect(ids).toContain("v3");
    expect(ids).not.toContain("v2");
  });

  test("a range event visible only through its until is kept", () => {
    const spanning = event({ id: "v1", at: -500, until: 50 });
    const out = cull([spanning], view, 0);
    expect(out.map((e) => e.id)).toContain("v1");
  });

  // Mutation target 1: cull must not simply render every event.
  test("cull is not the identity function over a wide field", () => {
    const far = event({ id: "far", at: 100000 });
    const out = cull([far], view, 10);
    expect(out).toHaveLength(0);
  });
});

describe("fitView", () => {
  test("frames the union of at..until with a 5% margin", () => {
    const events = [event({ id: "v1", at: 0 }), event({ id: "v2", at: 100, until: 200 })];
    const view = fitView(events, 1000);
    // Span is 0..200 = 200, 5% margin each side = 10, total 220.
    expect(view.originUnit).toBeCloseTo(-10, 5);
    expect(view.pxPerUnit).toBeCloseTo(1000 / 220, 5);
  });

  // Mutation target 8: fitView must not ignore `until`.
  test("a range's until extends the frame past a point event's at", () => {
    const events = [event({ id: "v1", at: 0, until: 1000 })];
    const view = fitView(events, 1000);
    // With until ignored the span would be 0 (a single point), producing a
    // pxPerUnit far larger than what a 1000-unit span demands.
    expect(view.pxPerUnit).toBeLessThan(2);
  });

  test("reservePx keeps the farthest point event's box inside the frame", () => {
    const events = [event({ id: "v1", at: 0 }), event({ id: "v2", at: 6000 })];
    const view = fitView(events, 1060, 220);
    const farRightPx = unitToPx(6000, view);
    // The box starts at `at` and grows rightward up to 220px; without the
    // reserve it starts at 95% of the layer and is clipped at the edge.
    expect(farRightPx + 220).toBeLessThanOrEqual(1060);
    expect(farRightPx).toBeGreaterThan(700);
  });

  test("an empty document frames a plain window without throwing", () => {
    const view = fitView([], 800);
    expect(Number.isFinite(view.pxPerUnit)).toBe(true);
    expect(Number.isFinite(view.originUnit)).toBe(true);
  });
});

describe("zoomAround", () => {
  // Mutation target 2: zoomAround must not ignore the pointer.
  test("the unit under the pointer stays under the pointer", () => {
    const view: TimelineViewState = { pxPerUnit: 1, originUnit: 0, widthPx: 800 };
    const pointerPx = 300;
    const unitBefore = pxToUnit(pointerPx, view);
    const zoomed = zoomAround(view, 2, pointerPx);
    const unitAfter = pxToUnit(pointerPx, zoomed);
    expect(unitAfter).toBeCloseTo(unitBefore, 6);
    expect(zoomed.pxPerUnit).toBeCloseTo(2, 6);
  });

  test("the scale is clamped to the documented bounds", () => {
    const view: TimelineViewState = { pxPerUnit: 60, originUnit: 0, widthPx: 800 };
    const zoomed = zoomAround(view, 10, 100);
    expect(zoomed.pxPerUnit).toBeLessThanOrEqual(64);
    const zoomedOut = zoomAround({ pxPerUnit: 0.03, originUnit: 0, widthPx: 800 }, 0.01, 100);
    expect(zoomedOut.pxPerUnit).toBeGreaterThanOrEqual(0.02);
  });
});

describe("collapse", () => {
  const view: TimelineViewState = { pxPerUnit: 10, originUnit: 0, widthPx: 800 };

  test("a lone event is a pill, never a dot", () => {
    const out = collapse([event({ id: "v1", at: 10 })], view, 24);
    expect(out).toEqual([{ kind: "event", event: expect.anything(), leftPx: 100 }]);
  });

  test("two events under the gap collapse into one dot with both events", () => {
    const a = event({ id: "v1", at: 10 });
    const b = event({ id: "v2", at: 11 }); // 10px apart at pxPerUnit 10, under 24
    const out = collapse([a, b], view, 24);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("dot");
    if (out[0]!.kind === "dot") {
      expect(out[0]!.events.map((e) => e.id).sort()).toEqual(["v1", "v2"]);
    }
  });

  test("two events well past the gap stay separate pills", () => {
    const a = event({ id: "v1", at: 0 });
    const b = event({ id: "v2", at: 100 });
    const out = collapse([a, b], view, 24);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.kind === "event")).toBe(true);
  });
});

describe("calendarDate", () => {
  const calendar = {
    months: [
      { name: "Thaw", days: 36, season: "Spring" },
      { name: "Bloom", days: 36, season: "Spring" },
    ],
    yearLabel: "year {n}",
    epochYear: 1,
  };

  test("day 0 is day 1 of month 1 of the epoch year", () => {
    expect(calendarDate(0, calendar)).toEqual({
      year: 1,
      month: 1,
      day: 1,
      label: "Thaw 1, year 1", // en catalog's "timeline.calendar.label": "{month} {day}, {year}"
      tick: "Thaw 1",
    });
  });

  test("a day past the first month rolls into the second", () => {
    expect(calendarDate(36, calendar)).toEqual({
      year: 1,
      month: 2,
      day: 1,
      label: "Bloom 1, year 1",
      tick: "Bloom 1",
    });
  });

  test("a day past the year rolls the year forward", () => {
    expect(calendarDate(72, calendar)).toEqual({
      year: 2,
      month: 1,
      day: 1,
      label: "Thaw 1, year 2",
      tick: "Thaw 1",
    });
  });

  test("a negative day counts backwards", () => {
    expect(calendarDate(-1, calendar)).toEqual({
      year: 0,
      month: 2,
      day: 36,
      label: "Bloom 36, year 0",
      tick: "Bloom 36",
    });
  });

  test("a calendar with no months answers null rather than throw", () => {
    expect(calendarDate(0, { months: [], yearLabel: "{n}", epochYear: 1 })).toBeNull();
  });
});

describe("applyStep / inverseOf", () => {
  test("add then its inverse (remove) round-trips the document", () => {
    const t = baseTimeline();
    const step = { kind: "add" as const, entity: "event" as const, value: event() };
    const inv = inverseOf(t, step);
    const added = applyStep(t, step);
    expect(added.events).toHaveLength(1);
    expect(inv).not.toBeNull();
    const reverted = applyStep(added, inv!);
    expect(reverted).toEqual(t);
  });

  test("remove then its inverse (add) round-trips the document", () => {
    const t = baseTimeline({ events: [event()] });
    const step = { kind: "remove" as const, entity: "event" as const, id: "v1" };
    const inv = inverseOf(t, step);
    const removed = applyStep(t, step);
    expect(removed.events).toHaveLength(0);
    expect(inv).not.toBeNull();
    const reverted = applyStep(removed, inv!);
    expect(reverted).toEqual(t);
  });

  test("set then its inverse round-trips a field", () => {
    const t = baseTimeline({ events: [event({ title: "Old" })] });
    const step = { kind: "set" as const, entity: "event" as const, id: "v1", field: "title", value: "New" };
    const inv = inverseOf(t, step);
    const changed = applyStep(t, step);
    expect(changed.events[0]!.title).toBe("New");
    const reverted = applyStep(changed, inv!);
    expect(reverted.events[0]!.title).toBe("Old");
  });

  // Mutation target 9: undo of move must restore the CORRECT original track,
  // not merely some track.
  test("move then its inverse restores the exact original track and day", () => {
    const t = baseTimeline({
      tracks: [
        { id: "t1", name: "Ines", kind: "thread", colour: 1 },
        { id: "t2", name: "Danse", kind: "thread", colour: 2 },
      ],
      events: [event({ id: "v1", at: 10, tracks: ["t2"] })],
    });
    const step = { kind: "move" as const, id: "v1", at: 999, track: "t1" };
    const inv = inverseOf(t, step);
    expect(inv).toEqual({ kind: "move", id: "v1", at: 10, track: "t2" });
    const moved = applyStep(t, step);
    expect(moved.events[0]).toMatchObject({ at: 999, tracks: ["t1"] });
    const reverted = applyStep(moved, inv!);
    expect(reverted.events[0]).toMatchObject({ at: 10, tracks: ["t2"] });
    // Never "restores the wrong track": t2, specifically, not t1 or anything else.
    expect(reverted.events[0]!.tracks).toEqual(["t2"]);
  });

  test("a step targeting an id absent from the document inverts to null", () => {
    const t = baseTimeline();
    expect(inverseOf(t, { kind: "remove", entity: "event", id: "gone" })).toBeNull();
    expect(inverseOf(t, { kind: "set", entity: "event", id: "gone", field: "title", value: "x" })).toBeNull();
    expect(inverseOf(t, { kind: "move", id: "gone", at: 1, track: "t1" })).toBeNull();
  });

  test("applyStep never mutates its input", () => {
    const t = baseTimeline({ events: [event()] });
    const before = serialize(t);
    applyStep(t, { kind: "remove", entity: "event", id: "v1" });
    expect(serialize(t)).toBe(before);
  });

  // Carry-in from 102's review item 10: the drag commits AT and TRACKS as
  // two "set" steps in one undo entry rather than one "move" step, and
  // "set"'s own inverseOf reads the FULL prior array -- undoing a drag on a
  // MEETING (two tracks) must restore both, not just the first.
  test("undoing a drag's two 'set' steps restores a meeting's full track list", () => {
    const t = baseTimeline({
      tracks: [
        { id: "t1", name: "Ines", kind: "thread", colour: 1 },
        { id: "t2", name: "Danse", kind: "thread", colour: 2 },
        { id: "t3", name: "Thren", kind: "thread", colour: 3 },
      ],
      events: [event({ id: "v1", at: 10, tracks: ["t1", "t2"] })],
    });
    const steps = [
      { kind: "set" as const, entity: "event" as const, id: "v1", field: "at", value: 50 },
      { kind: "set" as const, entity: "event" as const, id: "v1", field: "tracks", value: ["t3"] },
    ];
    let cursor = t;
    const inverses: (ReturnType<typeof inverseOf>)[] = [];
    for (const step of steps) {
      inverses.unshift(inverseOf(cursor, step));
      cursor = applyStep(cursor, step);
    }
    expect(cursor.events[0]).toMatchObject({ at: 50, tracks: ["t3"] });
    let reverted = cursor;
    for (const inv of inverses) reverted = applyStep(reverted, inv!);
    expect(reverted.events[0]).toMatchObject({ at: 10, tracks: ["t1", "t2"] });
  });
});

describe("laneAssignment (103)", () => {
  function branchesTimeline(writing: boolean): Timeline {
    return baseTimeline({
      tracks: [
        { id: "t1", name: "Ines", kind: "thread", colour: 1 },
        { id: "t2", name: "Danse", kind: "thread", colour: 2 },
      ],
      branches: [{ id: "b1", name: "Danse wins", forkAt: 100, forkTrack: "t2", writing }],
      events: [
        event({ id: "v1", at: 50, tracks: ["t1"], branch: null }),
        event({ id: "v2", at: 150, tracks: ["t2"], branch: null }),
        event({ id: "v3", at: 200, tracks: ["t2"], branch: "b1" }),
      ],
    });
  }

  test("branchTracks is the branch's own tracks plus forkTrack always", () => {
    const t = branchesTimeline(false);
    const b = t.branches[0]!;
    expect(branchTracks(t, b)).toEqual(["t2"]);
  });

  test("a branch with no events still carries its forkTrack", () => {
    const t = baseTimeline({
      tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
      branches: [{ id: "b1", name: "Empty", forkAt: 10, forkTrack: "t1", writing: false }],
    });
    expect(branchTracks(t, t.branches[0]!)).toEqual(["t1"]);
  });

  // Mutation target 1: laneAssignment swaps nothing when writing is set.
  test("while writing is false, main and branch stay apart", () => {
    const t = branchesTimeline(false);
    const la = laneAssignment(t);
    expect(la.main.get("t1")!.map((e) => e.id)).toEqual(["v1"]);
    expect(la.main.get("t2")!.map((e) => e.id)).toEqual(["v2"]);
    expect(la.branch.get("b1")!.get("t2")!.map((e) => e.id)).toEqual(["v3"]);
  });

  test("while writing is true, the branch's events move to the main lane and the main line's events at or after the fork move into the group", () => {
    const t = branchesTimeline(true);
    const la = laneAssignment(t);
    expect(la.main.get("t1")!.map((e) => e.id)).toEqual(["v1"]);
    // v2 (main-line, t2, at 150 >= forkAt 100) swaps INTO the group.
    expect(la.main.get("t2")!.map((e) => e.id)).toEqual(["v3"]);
    expect(la.branch.get("b1")!.get("t2")!.map((e) => e.id)).toEqual(["v2"]);
  });

  test("a main-line event before the fork never swaps even while writing", () => {
    const t = baseTimeline({
      tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
      branches: [{ id: "b1", name: "B", forkAt: 100, forkTrack: "t1", writing: true }],
      events: [event({ id: "v1", at: 50, tracks: ["t1"], branch: null })],
    });
    const la = laneAssignment(t);
    expect(la.main.get("t1")!.map((e) => e.id)).toEqual(["v1"]);
  });

  // BLOCKER (review): a multi-track main event whose branch only touches ONE
  // of its tracks must stay on the unclaimed lane and move only on the
  // claimed one -- the per-EVENT `claimed` test used to drop it from the
  // page entirely (both lanes, since the whole event's tracks were pushed
  // as a unit into whichever side "claimed" won).
  test("a two-track main event: the branch's own track swaps, the other track does not", () => {
    const t = baseTimeline({
      tracks: [
        { id: "t1", name: "Ines", kind: "thread", colour: 1 },
        { id: "t2", name: "Danse", kind: "thread", colour: 2 },
      ],
      branches: [{ id: "b1", name: "B", forkAt: 100, forkTrack: "t2", writing: true }],
      events: [event({ id: "v1", at: 150, tracks: ["t1", "t2"], branch: null })],
    });
    const la = laneAssignment(t);
    // t1: the branch never touches it, so the meeting stays on the main lane.
    expect(la.main.get("t1")!.map((e) => e.id)).toEqual(["v1"]);
    expect(la.branch.get("b1")!.get("t1")).toBeUndefined();
    // t2: the branch's own track, at or after the fork -- swaps into the group.
    expect(la.main.get("t2")!.map((e) => e.id)).toEqual([]);
    expect(la.branch.get("b1")!.get("t2")!.map((e) => e.id)).toEqual(["v1"]);
  });
});

describe("commitTrackName (103)", () => {
  test("trims and keeps a real name", () => {
    expect(commitTrackName("  The harbour  ", "Track 1")).toBe("The harbour");
  });

  // Mutation target 8: a track rename with an empty name is accepted.
  test("an empty or whitespace-only name falls back", () => {
    expect(commitTrackName("", "Track 1")).toBe("Track 1");
    expect(commitTrackName("   ", "Track 1")).toBe("Track 1");
  });
});

describe("monthTableValid (103)", () => {
  test("a populated table with positive day counts is valid", () => {
    expect(
      monthTableValid([
        { name: "Thaw", days: 36, season: "Spring" },
        { name: "High", days: 40, season: "Summer" },
      ]),
    ).toBe(true);
  });

  test("an empty table is invalid", () => {
    expect(monthTableValid([])).toBe(false);
  });

  // Mutation target 3: the month table accepts 0 days.
  test("a month with zero days is invalid", () => {
    expect(monthTableValid([{ name: "Thaw", days: 0, season: "Spring" }])).toBe(false);
  });

  test("a month with negative days is invalid", () => {
    expect(monthTableValid([{ name: "Thaw", days: -5, season: "Spring" }])).toBe(false);
  });
});

describe("calendarDate with negative days (103 decisions)", () => {
  const calendar = {
    months: [
      { name: "Thaw", days: 10, season: "Spring" },
      { name: "High", days: 10, season: "Summer" },
    ],
    yearLabel: "year {n}",
    epochYear: 1,
  };

  test("day 0 is day 1 of month 1 of the epoch year", () => {
    const d = calendarDate(0, calendar);
    expect(d).toMatchObject({ year: 1, month: 1, day: 1 });
  });

  test("a negative day counts backwards into the year before the epoch", () => {
    const d = calendarDate(-1, calendar);
    expect(d).toMatchObject({ year: 0, month: 2, day: 10 });
  });

  test("a negative day spanning a full cycle lands a further year back", () => {
    const d = calendarDate(-21, calendar);
    expect(d).toMatchObject({ year: -1, month: 2, day: 10 });
  });
});

// MAJOR (review): plan item 2's month/season/year bands, not implemented.
describe("bandLevel (103)", () => {
  const calendar = {
    months: [
      { name: "Thaw", days: 20, season: "Spring" },
      { name: "High", days: 20, season: "Spring" },
      { name: "Fall", days: 20, season: "Autumn" },
      { name: "Frost", days: 20, season: "Autumn" },
    ],
    yearLabel: "year {n}",
    epochYear: 1,
  };
  // Average month = 20 units, average season = 40 units (2 seasons over 80
  // total days), the year = 80 units.

  test("no calendar means no bands", () => {
    expect(bandLevel(10, null)).toBeNull();
  });

  test("zoomed in enough that a month exceeds 60px draws month bands", () => {
    // 20 units * 4px/unit = 80px > 60.
    expect(bandLevel(4, calendar)).toBe("month");
  });

  test("zoomed out past a month but a season still exceeds 60px draws season bands", () => {
    // month: 20 * 2 = 40px (<= 60); season: 40 * 2 = 80px (> 60).
    expect(bandLevel(2, calendar)).toBe("season");
  });

  test("zoomed out past both draws year bands", () => {
    // month: 20 * 0.5 = 10px; season: 40 * 0.5 = 20px; neither over 60.
    expect(bandLevel(0.5, calendar)).toBe("year");
  });

  // Mutation target 3's own neighbour: a calendar bandLevel cannot band a
  // zero-day month against either.
  test("a calendar with a zero-day month has no band level", () => {
    const broken = { ...calendar, months: [{ name: "Thaw", days: 0, season: "Spring" }] };
    expect(bandLevel(100, broken)).toBeNull();
  });

  test("an empty month table has no band level", () => {
    expect(bandLevel(100, { ...calendar, months: [] })).toBeNull();
  });
});

describe("zoomToSeparate (103)", () => {
  function view(pxPerUnit: number): TimelineViewState {
    return { pxPerUnit, originUnit: 0, widthPx: 800 };
  }

  // Mutation target 6: the dots' Enter zooms around the centre instead of
  // the dot.
  test("zooms around the dot's own pixel, not the viewport centre", () => {
    const events = [event({ id: "v1", at: 100 }), event({ id: "v2", at: 101 })];
    const v0 = view(1); // 1px apart at this scale: one dot.
    const dotPx = unitToPx(100.5, v0);
    const result = zoomToSeparate(v0, events, dotPx, 24, 1.15);
    // The dot's own unit must still map close to dotPx after zooming, which
    // only holds if the zoom was anchored there rather than at widthPx / 2.
    expect(Math.abs(unitToPx(100.5, result) - dotPx)).toBeLessThan(1);
  });

  test("stops once the group no longer collapses to one dot", () => {
    const events = [event({ id: "v1", at: 100 }), event({ id: "v2", at: 101 })];
    const v0 = view(1);
    const result = zoomToSeparate(v0, events, unitToPx(100.5, v0), 24, 1.15);
    const items = collapse(events, result, 24);
    expect(items.length).toBe(2);
  });

  test("a single-event group is never a dot and needs no zoom", () => {
    const events = [event({ id: "v1", at: 100 })];
    const v0 = view(1);
    const result = zoomToSeparate(v0, events, unitToPx(100, v0), 24, 1.15);
    expect(result).toEqual(v0);
  });

  test("stops at the clamp rather than looping forever", () => {
    // Two events so close together that no zoom under the clamp separates
    // them by 24px.
    const events = [event({ id: "v1", at: 100 }), event({ id: "v2", at: 100.0000001 })];
    const v0 = view(1);
    const result = zoomToSeparate(v0, events, unitToPx(100, v0), 24, 1.15);
    expect(result.pxPerUnit).toBeLessThanOrEqual(64);
  });
});
