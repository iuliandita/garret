// app/harness/src/words-floor.ts
// The words rig's own timing resolution. Separate from words-cli.ts for one
// reason: words-cli.ts is a CLI with top-level side effects (it seeds a project
// and spawns a shell), so a test cannot import it, and until this module existed
// the gates test pinned the granularity claim against a fabricated fixture
// number. It asserted that the string said "60 ms" because the fixture said 60,
// which checks nothing about the rig.
//
// word_count_scan_ms is measured between two polling loops, and a polling loop
// cannot resolve anything finer than its own period plus the cost of one read.
// Both endpoints are polled, so both contribute:
//
//   t0  the timing word's commit becoming visible to a read-only connection,
//       detected by a loop that sleeps COMMIT_POLL_MS and then OPENS A FRESH
//       SQLITE CONNECTION and reads every stored body;
//   t1  the exposed name's project half changing, detected by a loop that sleeps
//       WATCH_POLL_MS and then reads one AT-SPI property off a node it already
//       holds.
//
// The rig recorded 0.4 ms as `scan_granularity_ms` and the gate called it "the
// finest interval it can resolve", which understated the true floor by roughly
// fifty times: 0.4 ms was the median NAME READ alone, with the 20 ms sleep
// wrapped around it and the whole commit-side loop unaccounted for. A run then
// recorded `scan_ms: 2` -- a number below the noise floor, presented as a
// measurement.

/** How often the repaint watcher re-reads the exposed name. One AT-SPI property
 *  read off a node the watcher already resolved, NOT a new client per poll:
 *  spawning a pyatspi client at this rate wedges the WebKitGTK bridge. */
export const WATCH_POLL_MS = 20;

/** How often the commit side re-reads the store while timing a write. Each read
 *  opens a fresh read-only connection, so the period is a floor and the read
 *  cost is measured rather than assumed. */
export const COMMIT_POLL_MS = 2;

/** The finest interval the scan measurement can resolve, from the two measured
 *  read costs. Each endpoint contributes its own period-or-cost, whichever
 *  dominates: a loop that sleeps 20 ms cannot report a 2 ms interval, and a loop
 *  whose read costs more than its sleep is bounded by the read. */
export function scanFloorMs(watchReadMs: number, commitReadMs: number): number {
  const floor = Math.max(WATCH_POLL_MS, watchReadMs) + Math.max(COMMIT_POLL_MS, commitReadMs);
  return Number(floor.toFixed(1));
}
