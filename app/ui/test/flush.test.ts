import { describe, expect, test } from "bun:test";
import { createFlushScheduler, type FlushEntry } from "../src/store/flush";

/** A hand-driven clock: the scheduler's timer only fires when a test says so. */
function manualTimers() {
  let pending: { fn: () => void; at: number } | null = null;
  let now = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      pending = { fn, at: now + ms };
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
    advance(ms: number) {
      now += ms;
      if (pending && now >= pending.at) {
        const { fn } = pending;
        pending = null;
        fn();
      }
    },
    armed: () => pending !== null,
  };
}

function recorder() {
  const calls: FlushEntry[][] = [];
  return {
    calls,
    invoke: async (entries: FlushEntry[]) => {
      calls.push(entries.map((e) => ({ ...e })));
      return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
    },
  };
}

describe("createFlushScheduler", () => {
  test("no dirty documents means no invoke at all", () => {
    const t = manualTimers();
    const r = recorder();
    createFlushScheduler({ invoke: r.invoke, ...t });
    t.advance(5000);
    expect(r.calls.length).toBe(0);
  });

  test("the first edit arms the timer and it fires at 1000 ms", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    s.markDirty("a", "body-1");
    t.advance(999);
    expect(r.calls.length).toBe(0);
    t.advance(1);
    await s.settled();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]).toEqual([{ item_id: "a", body: "body-1", base_rev: 1 }]);
  });

  test("edits inside the window coalesce into one batched invoke", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    s.register("b", 4);
    s.markDirty("a", "a1");
    t.advance(300);
    s.markDirty("a", "a2");
    s.markDirty("b", "b1");
    t.advance(700);
    await s.settled();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]).toEqual([
      { item_id: "a", body: "a2", base_rev: 1 },
      { item_id: "b", body: "b1", base_rev: 4 },
    ]);
  });

  test("continuous typing flushes on a fixed cadence, not a sliding window", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    // An edit every 100 ms for 3 seconds. A sliding debounce would never fire.
    for (let i = 0; i < 30; i++) {
      s.markDirty("a", `body-${i}`);
      t.advance(100);
      await s.settled();
    }
    expect(r.calls.length).toBe(3);
  });

  test("a successful flush advances the base_rev the next flush sends", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    s.markDirty("a", "one");
    t.advance(1000);
    await s.settled();
    s.markDirty("a", "two");
    t.advance(1000);
    await s.settled();
    expect(r.calls[1]).toEqual([{ item_id: "a", body: "two", base_rev: 2 }]);
  });

  test("a conflict disarms the scheduler permanently and keeps the dirty buffer", async () => {
    const t = manualTimers();
    const calls: FlushEntry[][] = [];
    const s = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        throw new Error("conflict: a changed underneath this flush");
      },
      ...t,
    });
    s.register("a", 1);
    s.markDirty("a", "one");
    t.advance(1000);
    await s.settled();

    expect(s.failed()).toBe(true);
    expect(s.stats().errors).toBe(1);
    // Still dirty: nothing may be dropped on the floor before the user acts.
    expect(s.dirtyCount()).toBe(1);

    s.markDirty("a", "two");
    t.advance(5000);
    await s.settled();
    expect(calls.length).toBe(1);
    expect(t.armed()).toBe(false);
  });

  test("stats report flush latency percentiles", async () => {
    const t = manualTimers();
    const s = createFlushScheduler({
      invoke: async () => {
        t.advance(7);
        return [];
      },
      ...t,
    });
    s.register("a", 1);
    s.markDirty("a", "one");
    t.advance(1000);
    await s.settled();
    expect(s.stats().count).toBe(1);
    expect(s.stats().p95).toBe(7);
  });

  test("a new edit after a successful flush arms a fresh timer and flushes again", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    s.markDirty("a", "one");
    t.advance(1000);
    await s.settled();
    expect(r.calls.length).toBe(1);
    expect(t.armed()).toBe(false);

    s.markDirty("a", "two");
    expect(t.armed()).toBe(true);
    t.advance(1000);
    await s.settled();
    expect(r.calls.length).toBe(2);
  });

  test("revOf reports the registered rev, then the acked rev, then undefined if never registered", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 5);
    expect(s.revOf("a")).toBe(5);

    s.markDirty("a", "one");
    t.advance(1000);
    await s.settled();
    expect(s.revOf("a")).toBe(6);

    expect(s.revOf("b")).toBeUndefined();
  });

  test("drain flushes a pending edit immediately, without advancing the clock", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    s.markDirty("a", "one");
    expect(t.armed()).toBe(true);

    await s.drain();

    expect(r.calls.length).toBe(1);
    expect(r.calls[0]).toEqual([{ item_id: "a", body: "one", base_rev: 1 }]);
    expect(s.dirtyCount()).toBe(0);
  });

  test("drain on a scheduler with nothing dirty is a no-op", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);

    await s.drain();

    expect(r.calls.length).toBe(0);
  });

  test("drain on a failed scheduler does not invoke and terminates", async () => {
    const t = manualTimers();
    const calls: FlushEntry[][] = [];
    const s = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        throw new Error("conflict: a changed underneath this flush");
      },
      ...t,
    });
    s.register("a", 1);
    s.markDirty("a", "one");
    t.advance(1000);
    await s.settled();
    expect(s.failed()).toBe(true);
    calls.length = 0;

    await s.drain();

    expect(calls.length).toBe(0);
  });

  test("after drain, revOf reports the acked revision", async () => {
    const t = manualTimers();
    const r = recorder();
    const s = createFlushScheduler({ invoke: r.invoke, ...t });
    s.register("a", 1);
    s.markDirty("a", "one");

    await s.drain();

    expect(s.revOf("a")).toBe(2);
  });
});

describe("stop", () => {
  for (const reject of [false, true]) {
    test(`late ${reject ? "failure" : "success"} cannot revive or notify a stopped scheduler`, async () => {
      let finish!: () => void;
      const notices: string[] = [];
      const f = createFlushScheduler({
        invoke: () => new Promise((resolve, fail) => {
          finish = () => reject ? fail(new Error("late")) : resolve([{ item_id: "a", rev: 2 }]);
        }),
        onFailure: (message) => notices.push(message),
        onStateChange: (state) => notices.push(state),
      });
      f.register("a", 1);
      f.markDirty("a", "unsaved");
      const draining = f.drain();
      f.stop();
      notices.length = 0;
      finish();
      await draining;
      expect(notices).toEqual([]);
      expect(f.dirtyCount()).toBe(0);
      expect(f.revOf("a")).toBe(1);
    });
  }

  test("clears an armed timer so it can never fire", () => {
    // Dropping the reference is not enough: the timer holds a live callback,
    // and after a project switch it would fire into a store whose rows these
    // item ids no longer describe.
    const timers: (() => void)[] = [];
    let cleared = 0;
    const calls: FlushEntry[][] = [];
    const f = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {
        cleared++;
      },
    });
    f.register("scene-1", 1);
    f.markDirty("scene-1", "body");
    expect(timers).toHaveLength(1);

    f.stop();
    expect(cleared).toBe(1);
    // Even if the host fires it anyway - a cleared handle is advisory in some
    // environments - the callback must do nothing.
    timers[0]?.();
    expect(calls).toEqual([]);
  });

  test("refuses further work", () => {
    const calls: FlushEntry[][] = [];
    const f = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        return [];
      },
      setTimer: (fn) => {
        fn();
        return 1;
      },
    });
    f.stop();
    f.markDirty("scene-1", "body");
    expect(f.dirtyCount()).toBe(0);
    expect(calls).toEqual([]);
  });

  test("is idempotent", () => {
    const f = createFlushScheduler({ invoke: async () => [] });
    f.stop();
    f.stop();
    expect(f.dirtyCount()).toBe(0);
  });
});

describe("comment positions ride the flush", () => {
  for (const boundary of ["comments", "invoke"]) {
    test(`synchronous ${boundary} failure retains dirty work and terminates drain`, async () => {
      const states: string[] = [];
      const failures: string[] = [];
      let invokes = 0;
      const f = createFlushScheduler({
        commentsOf: () => {
          if (boundary === "comments") throw new Error("comment lookup failed");
          return [];
        },
        invoke: () => { invokes++; throw new Error("bridge failed"); },
        onFailure: (message) => failures.push(message),
        onStateChange: (state) => states.push(state),
      });
      f.register("a", 1);
      f.markDirty("a", "unsaved body");
      await f.drain();
      expect(f.failed()).toBe(true);
      expect(f.dirtyCount()).toBe(1);
      expect(f.revOf("a")).toBe(1);
      expect(states).toEqual(["pending", "failed"]);
      expect(failures).toHaveLength(1);
      expect(invokes).toBe(boundary === "comments" ? 0 : 1);
      f.markDirty("a", "later unsaved body");
      await f.drain();
      expect(f.dirtyCount()).toBe(1);
      expect(failures).toHaveLength(1);
      expect(invokes).toBe(boundary === "comments" ? 0 : 1);
    });
  }

  /** One flush, forced immediately, returning what reached the host. */
  async function flushedWith(
    commentsOf: (itemId: string) => readonly { id: number; from: number; to: number }[] | undefined,
  ): Promise<FlushEntry[][]> {
    const calls: FlushEntry[][] = [];
    const f = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
      },
      commentsOf,
    });
    f.register("scene-0", 3);
    f.markDirty("scene-0", "body");
    await f.drain();
    return calls;
  }

  test("the entry carries where the notes now are", async () => {
    const calls = await flushedWith(() => [{ id: 7, from: 10, to: 20 }]);

    expect(calls[0]?.[0]?.comments).toEqual([{ id: 7, from: 10, to: 20 }]);
  });

  test("undefined means leave them alone, and is not an empty list", async () => {
    // The distinction is load-bearing: an empty list would be a page saying "this
    // document has no notes", and the host would then have nothing to move -
    // which is the same answer here but not the same claim, and the flush path
    // is where an "I am not tracking these" has to survive.
    const calls = await flushedWith(() => undefined);

    expect(calls[0]?.[0]?.comments).toBeUndefined();
  });

  test("the positions are read AT FLUSH TIME, not when the edit was marked", async () => {
    // A second's worth of typing separates the two, and the whole point of
    // riding the flush is that the positions written are the ones the prose
    // written beside them describes.
    const calls: FlushEntry[][] = [];
    let where = 10;
    const f = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
      },
      commentsOf: () => [{ id: 7, from: where, to: where + 4 }],
    });
    f.register("scene-0", 3);
    f.markDirty("scene-0", "body");
    where = 40;

    await f.drain();

    expect(calls[0]?.[0]?.comments).toEqual([{ id: 7, from: 40, to: 44 }]);
  });

  test("each dirty document is asked about its own notes", async () => {
    const asked: string[] = [];
    const calls: FlushEntry[][] = [];
    const f = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
      },
      commentsOf: (itemId) => {
        asked.push(itemId);
        return itemId === "scene-0" ? [{ id: 7, from: 1, to: 2 }] : undefined;
      },
    });
    f.register("scene-0", 3);
    f.register("scene-1", 3);
    f.markDirty("scene-0", "a");
    f.markDirty("scene-1", "b");

    await f.drain();

    expect(asked.sort()).toEqual(["scene-0", "scene-1"]);
    const sent = calls[0] ?? [];
    expect(sent.find((e) => e.item_id === "scene-1")?.comments).toBeUndefined();
  });

  test("a scheduler with no commentsOf sends nothing about notes", async () => {
    // The corpus path builds one without the dep at all, and an entry carrying a
    // stray field would be a page telling the host something it does not know.
    const calls: FlushEntry[][] = [];
    const f = createFlushScheduler({
      invoke: async (entries) => {
        calls.push(entries);
        return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
      },
    });
    f.register("scene-0", 3);
    f.markDirty("scene-0", "body");

    await f.drain();

    expect(calls[0]?.[0]?.comments).toBeUndefined();
  });
});

describe("source attribution and serialized writes", () => {
  test("aggregates directional source movement at one checkpoint", async () => {
    const sent: { entries: FlushEntry[]; attribution?: unknown }[] = [];
    const f = createFlushScheduler({
      invoke: async (entries, attribution) => {
        sent.push({ entries, attribution });
        return entries.map((entry) => ({ item_id: entry.item_id, rev: entry.base_rev + 1 }));
      },
      wordCountOf: (body) => (body ? body.split(" ").length : 0),
      localDay: () => "2026-09-20",
    });
    f.register("scene-0", 3);
    f.markDirty("scene-0", "one two", { source: "typing", beforeWords: 1 });
    f.markDirty("scene-0", "one two three", { source: "pasted", beforeWords: 2 });
    f.markDirty("scene-0", "one", { source: "typing", beforeWords: 3 });

    await f.drain();

    expect(sent).toEqual([
      {
        entries: [{ item_id: "scene-0", body: "one", base_rev: 3 }],
        attribution: [
          {
            item_id: "scene-0",
            day: "2026-09-20",
            changes: [
              { source: "typing", added: 1, deleted: 2 },
              { source: "pasted", added: 1, deleted: 0 },
            ],
          },
        ],
      },
    ]);
  });

  test("a registered reload starts from its own source baseline", async () => {
    const sent: (readonly { item_id: string; day: string; changes: unknown[] }[] | undefined)[] = [];
    const f = createFlushScheduler({
      invoke: async (entries, attribution) => {
        sent.push(attribution);
        return entries.map((entry) => ({ item_id: entry.item_id, rev: entry.base_rev + 1 }));
      },
      wordCountOf: (body) => (body ? body.split(" ").length : 0),
      localDay: () => "2026-09-20",
    });
    f.register("scene-0", 3);
    f.markDirty("scene-0", "one two three four five", { source: "typing", beforeWords: 0 });
    await f.drain();

    // A reload replaces the editor state. Its first typed change has an
    // authoritative before count, rather than continuing from the five-word
    // checkpoint in the discarded state.
    f.register("scene-0", 20);
    f.markDirty("scene-0", "one two three", { source: "typing", beforeWords: 2 });
    await f.drain();

    expect(sent[1]).toEqual([
      {
        item_id: "scene-0",
        day: "2026-09-20",
        changes: [{ source: "typing", added: 1, deleted: 0 }],
      },
    ]);
  });

  test("waits for an acknowledgement before claiming newer edits", async () => {
    const t = manualTimers();
    const calls: FlushEntry[][] = [];
    const releases: (() => void)[] = [];
    let signalSecond: () => void = () => {};
    const secondStarted = new Promise<void>((resolve) => {
      signalSecond = resolve;
    });
    let active = 0;
    let mostActive = 0;
    const f = createFlushScheduler({
      invoke: (entries) => {
        calls.push(entries.map((entry) => ({ ...entry })));
        if (calls.length === 2) signalSecond();
        active++;
        mostActive = Math.max(mostActive, active);
        return new Promise((resolve) => {
          releases.push(() => {
            active--;
            resolve(entries.map((entry) => ({ item_id: entry.item_id, rev: entry.base_rev + 1 })));
          });
        });
      },
      ...t,
    });
    f.register("scene-0", 7);
    f.markDirty("scene-0", "first");
    const drained = f.drain();
    f.markDirty("scene-0", "second");
    // This timer expires while the first request owns the revision. It must not
    // take the newer snapshot or send base_rev 7 a second time.
    t.advance(1000);
    f.register("scene-0", 99);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({ item_id: "scene-0", body: "first", base_rev: 7 });

    releases.shift()?.();
    await secondStarted;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toMatchObject({ item_id: "scene-0", body: "second", base_rev: 8 });
    expect(mostActive).toBe(1);
    releases.shift()?.();
    await drained;
  });

  test("a rejected in-flight write keeps the latest body and stays failed", async () => {
    const t = manualTimers();
    const calls: FlushEntry[][] = [];
    let reject: (reason: unknown) => void = () => {};
    const f = createFlushScheduler({
      invoke: (entries) => {
        calls.push(entries.map((entry) => ({ ...entry })));
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
      wordCountOf: (body) => (body ? body.split(" ").length : 0),
      localDay: () => "2026-09-20",
      ...t,
    });
    f.register("scene-0", 4);
    f.markDirty("scene-0", "first", { source: "typing", beforeWords: 0 });
    const drained = f.drain();
    f.markDirty("scene-0", "second words", { source: "pasted", beforeWords: 1 });
    t.advance(1000);
    reject(new Error("conflict: changed underneath this flush"));
    await drained;

    expect(f.failed()).toBe(true);
    expect(f.dirtyCount()).toBe(1);
    expect(calls).toEqual([[{ item_id: "scene-0", body: "first", base_rev: 4 }]]);
    await f.drain();
    expect(calls).toHaveLength(1);
  });
});
