// app/harness/src/timeline-corpus.ts
// A stress-sized timeline document, generated for timeline-cli.ts's seed.
//
// RESTATES `timeline-model.ts`'s SCHEMA, DOES NOT IMPORT IT. This module
// runs under Bun on the harness side of the freeze boundary, and the wire
// contract for a timeline's body is JSON the host never parses past "kind"
// and "version" -- the same restatement rule `item-types.ts` and
// `store/mod.rs` already follow for the item type strings, extended once
// more here so a drift between the page's model and this generator fails a
// test instead of silently seeding a body `parseTimeline` would call
// `invalid`.
//
// DETERMINISTIC. `seed` is a small LCG, not `Math.random()`: two runs of
// this rig must plant byte-identical corpora, or a flake in
// `timeline_zoom_p95_ms` could not be told from a genuinely different
// document.

export interface TimelineCorpusOptions {
  eventCount: number;
  trackCount: number;
  /** Events land at integer units in [0, spreadUnits). */
  spreadUnits: number;
  /** Roughly this fraction of events carry a non-null `until` (a range). */
  rangeFraction: number;
  /** Roughly this fraction of events sit on two tracks (a meeting). */
  meetingFraction: number;
  /** Roughly this fraction of events carry a `scene` id, drawn from
   *  `sceneIds`. */
  sceneLinkFraction: number;
  sceneIds: readonly string[];
  seed: number;
}

/** mulberry32: small, fast, and the same sequence for the same seed on every
 *  platform Bun runs this rig on -- unlike `Math.random()`, which makes no
 *  such promise. */
function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The body a fresh Bun process (timeline-cli's OWN generator, never the
 *  page's `timeline-model.ts`) hands to `seed.rs`'s `timelines.ndjson`
 *  reader, at the design spec's timeline schema, version 1. */
export function generateTimelineCorpus(opts: TimelineCorpusOptions): Record<string, unknown> {
  const rand = lcg(opts.seed);
  const tracks = Array.from({ length: opts.trackCount }, (_, i) => ({
    id: `t${i + 1}`,
    name: `Track ${i + 1}`,
    kind: "thread" as const,
    colour: (i % 8) + 1,
  }));

  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < opts.eventCount; i++) {
    const at = Math.floor(rand() * opts.spreadUnits);
    const isRange = rand() < opts.rangeFraction;
    const until = isRange ? at + 1 + Math.floor(rand() * 20) : null;
    const isMeeting = rand() < opts.meetingFraction && tracks.length > 1;
    const primary = tracks[Math.floor(rand() * tracks.length)]!.id;
    const eventTracks = [primary];
    if (isMeeting) {
      let second = tracks[Math.floor(rand() * tracks.length)]!.id;
      let tries = 0;
      while (second === primary && tries < 8) {
        second = tracks[Math.floor(rand() * tracks.length)]!.id;
        tries++;
      }
      if (second !== primary) eventTracks.push(second);
    }
    const hasScene = rand() < opts.sceneLinkFraction && opts.sceneIds.length > 0;
    const scene = hasScene ? opts.sceneIds[Math.floor(rand() * opts.sceneIds.length)]! : null;
    events.push({
      id: `v${i + 1}`,
      title: `Event ${i + 1}`,
      at,
      until,
      tracks: eventTracks,
      branch: null,
      scene,
      cast: [],
      note: "",
    });
  }

  return {
    kind: "timeline",
    version: 1,
    scale: { unit: "day", zero: "", calendar: null, eras: [] },
    tracks,
    branches: [],
    events,
  };
}
