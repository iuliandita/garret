import { describe, expect, test } from "bun:test";
import { generateTimelineCorpus } from "../src/timeline-corpus";
import { parseTimeline } from "../../ui/src/timeline-model";

const BASE = {
  eventCount: 200,
  trackCount: 6,
  spreadUnits: 3000,
  rangeFraction: 0.1,
  meetingFraction: 0.05,
  sceneLinkFraction: 0.15,
  sceneIds: ["it-000008", "it-000009", "it-000010"],
  seed: 42,
};

describe("generateTimelineCorpus", () => {
  test("is deterministic for the same seed", () => {
    const a = generateTimelineCorpus(BASE);
    const b = generateTimelineCorpus(BASE);
    expect(a).toEqual(b);
  });

  test("a different seed produces a different document", () => {
    const a = generateTimelineCorpus(BASE);
    const b = generateTimelineCorpus({ ...BASE, seed: 43 });
    expect(a).not.toEqual(b);
  });

  test("produces exactly the requested counts of events and tracks", () => {
    const corpus = generateTimelineCorpus(BASE);
    expect((corpus.events as unknown[]).length).toBe(BASE.eventCount);
    expect((corpus.tracks as unknown[]).length).toBe(BASE.trackCount);
  });

  // THE FIXTURE IS A FACT ABOUT ITSELF: cross-checked against the PAGE's own
  // parser rather than trusted by construction, so a schema drift between
  // this restatement and timeline-model.ts fails a test instead of seeding a
  // document the page would call `invalid`.
  test("the generated body parses as a valid v1 Timeline through the page's own parser", () => {
    const corpus = generateTimelineCorpus(BASE);
    const parsed = parseTimeline(JSON.stringify(corpus));
    expect("invalid" in parsed).toBe(false);
    expect("newer" in parsed).toBe(false);
    if ("kind" in parsed) {
      expect(parsed.events).toHaveLength(BASE.eventCount);
      expect(parsed.tracks).toHaveLength(BASE.trackCount);
    }
  });

  test("every event's at falls inside [0, spreadUnits)", () => {
    const corpus = generateTimelineCorpus(BASE);
    for (const e of corpus.events as { at: number }[]) {
      expect(e.at).toBeGreaterThanOrEqual(0);
      expect(e.at).toBeLessThan(BASE.spreadUnits);
    }
  });

  test("roughly the requested fraction of events are ranges", () => {
    const corpus = generateTimelineCorpus({ ...BASE, eventCount: 2000 });
    const ranges = (corpus.events as { until: number | null }[]).filter((e) => e.until !== null);
    const fraction = ranges.length / 2000;
    expect(fraction).toBeGreaterThan(0.05);
    expect(fraction).toBeLessThan(0.16);
  });

  test("roughly the requested fraction of events are meetings (two tracks)", () => {
    const corpus = generateTimelineCorpus({ ...BASE, eventCount: 2000 });
    const meetings = (corpus.events as { tracks: string[] }[]).filter((e) => e.tracks.length > 1);
    const fraction = meetings.length / 2000;
    expect(fraction).toBeGreaterThan(0.02);
    expect(fraction).toBeLessThan(0.09);
  });

  test("every scene link is drawn from sceneIds, and none when sceneIds is empty", () => {
    const corpus = generateTimelineCorpus({ ...BASE, eventCount: 2000 });
    const scenes = (corpus.events as { scene: string | null }[])
      .map((e) => e.scene)
      .filter((s): s is string => s !== null);
    expect(scenes.length).toBeGreaterThan(0);
    for (const s of scenes) expect(BASE.sceneIds).toContain(s);

    const noScenes = generateTimelineCorpus({ ...BASE, eventCount: 2000, sceneIds: [] });
    expect((noScenes.events as { scene: string | null }[]).every((e) => e.scene === null)).toBe(true);
  });

  test("no event carries more than two tracks", () => {
    const corpus = generateTimelineCorpus({ ...BASE, eventCount: 2000 });
    for (const e of corpus.events as { tracks: string[] }[]) {
      expect(e.tracks.length).toBeLessThanOrEqual(2);
    }
  });
});
