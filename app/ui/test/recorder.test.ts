import { afterEach, describe, expect, test } from "bun:test";
import { measure, STALL_TIMEOUT_MS, type MeasureClock } from "../src/measure/recorder";

// bun test has no DOM, so requestAnimationFrame/cancelAnimationFrame are
// undefined by default. Each test installs a controllable stub and restores
// whatever was there before (undefined, in this environment).
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

function installImmediateRaf(): void {
  let nextId = 1;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    setTimeout(() => cb(performance.now()), 0);
    return id;
  };
  globalThis.cancelAnimationFrame = (): void => {};
}

function installNeverFiringRaf(): void {
  let nextId = 1;
  globalThis.requestAnimationFrame = (): number => nextId++;
  globalThis.cancelAnimationFrame = (): void => {};
}

/**
 * A fully fake clock: no real timers, no real rAF. `now` is driven by hand so
 * a test can assert exact durations instead of tolerating real scheduler
 * jitter. Frames and timers are queued and released explicitly with
 * `fireFrame`/`fireTimer`, which is what lets a test observe "the second rAF
 * fired much later than the action" and "the timeout was cleared" directly.
 */
function makeFakeClock() {
  let clockNow = 0;
  let nextId = 1;
  const frames = new Map<number, (time: number) => void>();
  const timers = new Map<number, () => void>();
  const clearedTimers: number[] = [];
  const cancelledFrames: number[] = [];

  const clock: MeasureClock = {
    now: () => clockNow,
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      cancelledFrames.push(id);
      frames.delete(id);
    },
    setTimer: (cb, _ms) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (id) => {
      clearedTimers.push(id);
      timers.delete(id);
    },
  };

  return {
    clock,
    advanceTo(ms: number): void {
      clockNow = ms;
    },
    /** Fires the OLDEST still-pending frame (rAF callbacks fire in queue order). */
    fireNextFrame(): void {
      const [id, cb] = [...frames.entries()][0] ?? [];
      if (id === undefined) throw new Error("no pending frame to fire");
      frames.delete(id);
      cb(clockNow);
    },
    fireAllTimers(): void {
      for (const [id, cb] of [...timers.entries()]) {
        timers.delete(id);
        cb();
      }
    },
    pendingTimerCount: () => timers.size,
    clearedTimerCount: () => clearedTimers.length,
    cancelledFrameCount: () => cancelledFrames.length,
  };
}

describe("measure", () => {
  test("a normal action reports dispatch cost and a non-stalled frame", async () => {
    installImmediateRaf();
    const sample = await measure(() => {
      // synchronous work the recorder should see as dispatch cost
      let x = 0;
      for (let i = 0; i < 1000; i++) x += i;
    });
    expect(sample.stalled).toBe(false);
    expect(sample.frameMs).toBeGreaterThanOrEqual(sample.dispatchMs);
  });

  test("frames that never fire resolve as stalled instead of hanging", async () => {
    installNeverFiringRaf();
    // A short injected timeout so the test doesn't wait for the real
    // STALL_TIMEOUT_MS (5s); the timeout is a parameter for exactly this.
    const sample = await measure(() => {}, 20);
    expect(sample.stalled).toBe(true);
  });

  test("does not reject when the action throws", async () => {
    installImmediateRaf();
    const sample = await measure(() => {
      throw new Error("boom");
    });
    expect(sample.stalled).toBe(false);
  });

  test("STALL_TIMEOUT_MS is the documented default", () => {
    expect(STALL_TIMEOUT_MS).toBe(5_000);
  });

  test("dispatchMs covers only the synchronous action, not the frame wait", async () => {
    const fake = makeFakeClock();
    const promise = measure(
      () => {
        fake.advanceTo(7); // the action itself "takes" 7ms on the fake clock
      },
      5_000,
      fake.clock,
    );
    // dispatchMs must be captured as soon as the action returns, before any
    // frame has fired — advance the clock far past the action's own cost to
    // simulate a slow frame pipeline, and only then release the frames.
    fake.advanceTo(500);
    fake.fireNextFrame(); // raf1
    fake.advanceTo(9_000);
    fake.fireNextFrame(); // raf2
    const sample = await promise;
    expect(sample.dispatchMs).toBe(7);
    expect(sample.frameMs).toBe(9_000);
  });

  test("frameMs spans to the SECOND rAF, not the first", async () => {
    const fake = makeFakeClock();
    const promise = measure(() => {}, 5_000, fake.clock);
    fake.advanceTo(40); // first rAF fires "soon"
    fake.fireNextFrame(); // raf1
    fake.advanceTo(1_040); // second rAF fires much later (simulated stall)
    fake.fireNextFrame(); // raf2
    const sample = await promise;
    expect(sample.stalled).toBe(false);
    expect(sample.frameMs).toBe(1_040);
  });

  test("the stall path reports stalled=true when no frame ever arrives", async () => {
    const fake = makeFakeClock();
    const promise = measure(() => {}, 20, fake.clock);
    fake.advanceTo(20);
    fake.fireAllTimers();
    const sample = await promise;
    expect(sample.stalled).toBe(true);
    // Only raf1 was ever requested (raf2 is requested from inside raf1's own
    // callback, which never fired), so exactly one cancellation happens.
    expect(fake.cancelledFrameCount()).toBe(1);
  });

  test("the healthy path clears the stall timer instead of leaking it", async () => {
    const fake = makeFakeClock();
    const promise = measure(() => {}, 5_000, fake.clock);
    expect(fake.pendingTimerCount()).toBe(1);
    fake.fireNextFrame(); // raf1
    fake.fireNextFrame(); // raf2
    await promise;
    expect(fake.pendingTimerCount()).toBe(0);
    expect(fake.clearedTimerCount()).toBe(1);
  });
});
