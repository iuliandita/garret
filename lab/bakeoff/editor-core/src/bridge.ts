// lab/bakeoff/editor-core/src/bridge.ts
// The only surface each shell must implement. run.js reads __bakeoffFixtureUrl
// to fetch scene-data.json and calls __bakeoffSink exactly once with the run
// payload. Everything else in the page is shared, byte-identical code.
import type { Workload } from "./model";

export interface Sample {
  workload: Workload;
  ms: number;
}

// One completed replay of the seeded script during the soak. Per-cycle rather
// than per-action because a 30-minute run produces far too many samples to ship
// through the sink, and the question the soak asks is about drift over time.
export interface SoakCycle {
  cycle: number;
  atMs: number;          // ms since the soak loop started
  typingP95Ms: number;
  charsTyped: number;    // cumulative, so RSS growth can be read against content
  // True when the soak deadline cut this cycle short. Its p95 covers fewer
  // samples than a whole cycle, so it is marked rather than silently averaged in.
  partial?: boolean;
}

export interface SoakPayload {
  requestedMs: number;
  actualMs: number;
  cycles: SoakCycle[];
  charsTyped: number;
}

export interface SinkPayload {
  candidate: string;
  fixture: string;
  seed: string;
  samples: Sample[];
  coldStartMs: number;
  warmStartMs: number;
  // Absent on a normal (non-soak) run.
  soak?: SoakPayload;
}

declare global {
  interface Window {
    __bakeoffFixtureUrl?: string;
    __bakeoffCandidate?: string;
    __bakeoffSeed?: string;
    __bakeoffSink?: (payload: SinkPayload) => void;
  }
}
