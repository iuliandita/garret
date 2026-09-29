import { describe, expect, test } from "bun:test";
import { emptyTotals, forecast, selectLibraryBooks, streak, summarize, type Report } from "../src/analytics-metrics";
import type { LibraryBook } from "../src/library";

function report(): Report {
  return {
    recording_enabled: true, metric_version: 1, motivation_since_ms: null, motivation_visible: false,
    forecast_goal_words: null, more_sessions: 0, source_definition: "", coverage_definition: "",
    sessions: [{ id: "session", started_ms: 1, ended_ms: 2, start_day: "2026-09-24", start_offset_min: 120, metric_version: 1,
      gap: false, segments: [{ id: "segment", category: { id: "drafting", name: "Drafting" }, started_ms: 1, ended_ms: 2, gap: false,
        minutes: [{ utc_minute: 10, local_day: "2026-09-24", offset_min: 120 }, { utc_minute: 10, local_day: "2026-09-24", offset_min: 120 },
          { utc_minute: 11, local_day: "2026-09-25", offset_min: 60 }],
        movements: [{ item_id: "scene", utc_ms: 600000, utc_minute: 10, local_day: "2026-09-24", offset_min: 120,
          source: "typing", added: 5, deleted: 2 },
          { item_id: "scene", utc_ms: 660000, utc_minute: 11, local_day: "2026-09-25", offset_min: 60,
            source: "pasted", added: 4, deleted: 0 }], adjustment: null }] }],
  };
}

describe("session metrics", () => {
  test("uses observed local days and distinct UTC edit minutes, never elapsed session time", () => {
    const summary = summarize([report()], { from: "", through: "" }, null);
    expect(summary.observedMinutes).toBe(2);
    expect(summary.days.map((day) => [day.day, day.minutes])).toEqual([["2026-09-24", 1], ["2026-09-25", 1]]);
    expect(summary.observed.typing).toEqual({ added: 5, deleted: 2 });
    expect(summary.adjusted.pasted).toEqual({ added: 4, deleted: 0 });
  });

  test("date and category filter observed events; correction remains separate", () => {
    const reading = report();
    reading.sessions[0].segments[0].adjustment = { category: { id: "revision", name: "Revision" }, minutes: 9,
      source_totals: { ...emptyTotals(), typing: { added: 12, deleted: 1 } }, excluded: false, reason: "fixed", changed_ms: 3 };
    const day = summarize([reading], { from: "2026-09-24", through: "2026-09-24" }, "revision");
    expect(day.observedMinutes).toBe(1);
    expect(day.observed.typing.added).toBe(5);
    expect(day.adjusted.typing.added).toBe(5);
    expect(day.undatedCorrections).toBe(1);
    const all = summarize([reading], { from: "", through: "" }, "revision");
    expect(all.adjusted.typing).toEqual({ added: 12, deleted: 1 });
    expect(all.adjustedMinutes).toBe(9);
    expect(summarize([reading], { from: "", through: "" }, "drafting").observedMinutes).toBe(0);
  });

  test("exclusion removes adjusted activity without deleting observations", () => {
    const reading = report();
    reading.sessions[0].segments[0].adjustment = { category: null, minutes: null, source_totals: null, excluded: true, reason: null, changed_ms: 3 };
    const summary = summarize([reading], { from: "", through: "" }, null);
    expect(summary.observedMinutes).toBe(2);
    expect(summary.adjustedMinutes).toBe(0);
    expect(summary.observed.typing.added).toBe(5);
    expect(summary.adjusted.typing.added).toBe(0);
  });

  test("session and gap counts honor filters and do not call the live session abandoned", () => {
    const reading = report();
    reading.sessions[0].ended_ms = null;
    const all = summarize([reading], { from: "", through: "" }, null, "session");
    expect(all.sessions).toBe(1);
    expect(all.gaps).toBe(0);
    expect(summarize([reading], { from: "", through: "" }, null).gaps).toBe(1);
    expect(summarize([reading], { from: "2026-09-26", through: "2026-09-26" }, null).sessions).toBe(0);
    expect(summarize([reading], { from: "", through: "" }, "review").sessions).toBe(0);
  });

  test("recent positive typing pace forecasts only when there is evidence", () => {
    const days = [{ day: "2026-09-24", minutes: 1, typingNet: 14 }, { day: "2026-09-25", minutes: 1, typingNet: -4 }];
    expect(forecast(days, 28, "2026-09-25")).toBe(40);
    expect(forecast([], 28, "2026-09-25")).toBeNull();
    expect(forecast([{ day: "2026-09-25", minutes: 1, typingNet: -4 }], 28, "2026-09-25")).toBeNull();
    expect(streak(days)).toEqual({ current: 2, longest: 2 });
  });
});

test("library scope requires an explicit representative for duplicate identities", () => {
  const book = (path: string): LibraryBook => ({ path, name: path, book_id: "same", identity_id: "pen", identity_name: "Pen",
    series: { id: "series", name: "Series" }, universe: null, membership_error: null, modified_at: 0, opened_at: null,
    cover: { state: "none", data_uri: null }, error: null, missing: false });
  const books = [book("first"), book("second")];
  const scope = { identity: "pen", series: "series", universe: null };
  const without = selectLibraryBooks(books, scope, new Map(), 1);
  expect(without.books).toHaveLength(0);
  expect(without.unresolvedCopies).toHaveLength(1);
  const selected = selectLibraryBooks(books, scope, new Map([["same", "second"]]), 1);
  expect(selected.books.map((entry) => entry.path)).toEqual(["second"]);
  expect(selected.unknown).toBe(1);
});
