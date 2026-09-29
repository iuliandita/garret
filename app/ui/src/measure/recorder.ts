// app/ui/src/measure/recorder.ts
// Separates two different costs that the old single-number recorder fused
// together: the synchronous cost of the action itself (dispatchMs) and the
// time until the browser actually paints a settled frame (frameMs, via
// double-rAF: the first flushes the DOM write, the second fires after layout
// and paint). Fusing them made every sample land on a frame-cadence boundary
// (34 ms / 1001 ms) instead of describing the action's own cost.
//
// The frame wait is raced against a timeout so a stalled rAF pipeline cannot
// hang the soak loop forever: a stall is evidence of the pathology under
// test, not an error to swallow or propagate.
export interface Sample {
  /** Synchronous cost of the action itself: dispatch, DOM mutation, layout invalidation. */
  dispatchMs: number;
  /** Time from action start until the second animation frame fires. Frame cadence. */
  frameMs: number;
  /** True when the frame did not arrive within the stall timeout. */
  stalled: boolean;
}

export const STALL_TIMEOUT_MS = 5_000;

/**
 * The timers `measure` needs, injectable so a test can drive them without a
 * real DOM or real wall-clock waits. Defaults to the real browser globals, so
 * every existing call site is unaffected.
 */
export interface MeasureClock {
  now: () => number;
  requestFrame: (cb: (time: number) => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

const defaultClock: MeasureClock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
};

export async function measure(
  action: () => void,
  stallTimeoutMs: number = STALL_TIMEOUT_MS,
  clock: MeasureClock = defaultClock,
): Promise<Sample> {
  const t0 = clock.now();
  try {
    action();
  } catch (err) {
    // A synchronous throw must not kill a multi-hour soak. rAF scheduling is
    // independent of whether the action succeeded, so the frame race below
    // still runs and reports real cadence data rather than a fabricated
    // value or a rejected promise.
    console.error("measure: action threw", err);
  }
  const dispatchMs = Math.max(0, clock.now() - t0);

  let raf1: number | undefined;
  let raf2: number | undefined;
  let timeoutId: number | undefined;

  const framePromise = new Promise<number>((resolve) => {
    raf1 = clock.requestFrame(() => {
      raf2 = clock.requestFrame(() => {
        resolve(Math.max(0, clock.now() - t0));
      });
    });
  });

  const timeoutPromise = new Promise<"stalled">((resolve) => {
    timeoutId = clock.setTimer(() => resolve("stalled"), stallTimeoutMs);
  });

  const outcome = await Promise.race([framePromise, timeoutPromise]);

  if (outcome === "stalled") {
    // Whichever raf never fired is cancelled so it cannot fire later; a stale
    // or already-fired id passed to cancelFrame is a harmless no-op, so no
    // "did it already run" bookkeeping is needed.
    if (raf1 !== undefined) clock.cancelFrame(raf1);
    if (raf2 !== undefined) clock.cancelFrame(raf2);
    return { dispatchMs, frameMs: Math.max(0, clock.now() - t0), stalled: true };
  }
  // The frame won the race, so the stall timer is still pending: clear it so
  // it does not sit alive for its full duration inside the process whose
  // frame cadence is the thing being measured.
  if (timeoutId !== undefined) clock.clearTimer(timeoutId);
  return { dispatchMs, frameMs: outcome, stalled: false };
}
