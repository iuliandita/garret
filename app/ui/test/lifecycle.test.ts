import { describe, expect, test } from "bun:test";
import { wireLifecycle, type LifecycleDeps } from "../src/lifecycle";

class Harness {
  flushes = 0;
  invoked: string[] = [];
  windowListeners = new Map<string, () => void>();
  documentListeners = new Map<string, () => void>();
  hostListeners = new Map<string, (event?: { payload: number }) => void | Promise<void>>();
  hidden = false;
  isFailed = false;
  dirty = 0;

  readonly deps: LifecycleDeps = {
    session: {
      flushPending: async () => {
        this.flushes += 1;
      },
      failed: () => this.isFailed,
      dirtyCount: () => this.dirty,
    },
    invoke: async (cmd: string) => {
      this.invoked.push(cmd);
    },
    listen: async (event: string, cb: (event?: { payload: number }) => void | Promise<void>) => {
      this.hostListeners.set(event, cb);
    },
    addWindowListener: (type, cb) => {
      this.windowListeners.set(type, cb);
    },
    addDocumentListener: (type, cb) => {
      this.documentListeners.set(type, cb);
    },
    isHidden: () => this.hidden,
  };
}

function harness(): Harness {
  return new Harness();
}

describe("wireLifecycle", () => {
  test("a failed draft-close preparation keeps the window without releasing another hold", async () => {
    const h = harness();
    const errors: string[] = [];
    let released = false;
    h.deps.onError = (message) => errors.push(message);
    h.deps.drafts = { pending: () => true, prepareClose: async () => { throw new Error("draft still busy"); }, cancelClose: () => { released = true; } };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).not.toContain("confirm_close");
    expect(h.invoked.at(-1)).toBe("release_close");
    expect(errors).toEqual(["Error: draft still busy"]);
    expect(released).toBe(false);
  });

  test("keeping a review draft holds and releases close without discarding", async () => {
    const h = harness();
    let releases = 0;
    h.deps.drafts = { pending: () => true, prepareClose: async () => false, cancelClose: () => { releases++; } };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "release_close"]);
    expect(h.flushes).toBe(0);
    expect(releases).toBe(0);
  });

  test("a locked close retains a review draft without showing its discard prompt", async () => {
    const h = harness();
    h.deps.privacyLocked = async () => true;
    h.deps.drafts = { pending: () => true, prepareClose: async () => { throw new Error("must not reveal draft"); }, cancelClose: () => {} };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["privacy_close_failed"]);
    expect(h.flushes).toBe(1);
  });

  test("a lock during draft confirmation never confirms application close", async () => {
    const h = harness();
    let locked = false;
    h.deps.privacyLocked = async () => locked;
    h.deps.drafts = { pending: () => true, prepareClose: async () => { locked = true; return false; }, cancelClose: () => {} };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "privacy_close_failed"]);
  });

  test("confirmed draft discard precedes manuscript drain and final close", async () => {
    const h = harness();
    let pending = true;
    h.deps.drafts = { pending: () => pending, prepareClose: async () => { pending = false; return true; }, cancelClose: () => { throw new Error("confirmed departure must remain held"); } };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "confirm_close"]);
    expect(h.flushes).toBe(1);
  });

  test("a successful draft preparation is released when privacy locks before close", async () => {
    const h = harness(); let locked = false; let releases = 0;
    h.deps.privacyLocked = async () => locked;
    h.deps.drafts = { pending: () => true, prepareClose: async () => { locked = true; return true; },
      cancelClose: () => { releases++; } };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "privacy_close_failed"]);
    expect(releases).toBe(1);
  });

  test("a blur drains", async () => {
    const h = harness();
    wireLifecycle(h.deps);
    h.windowListeners.get("blur")!();
    await Promise.resolve();
    expect(h.flushes).toBe(1);
  });

  test("becoming hidden drains", async () => {
    const h = harness();
    wireLifecycle(h.deps);
    h.hidden = true;
    h.documentListeners.get("visibilitychange")!();
    await Promise.resolve();
    expect(h.flushes).toBe(1);
  });

  test("becoming VISIBLE does not drain", async () => {
    // visibilitychange fires in both directions. Draining on the way back is
    // pointless work on every window focus, and it would hide a missing
    // hidden-side drain in the test above.
    const h = harness();
    wireLifecycle(h.deps);
    h.hidden = false;
    h.documentListeners.get("visibilitychange")!();
    await Promise.resolve();
    expect(h.flushes).toBe(0);
  });

  test("a close request drains and only then confirms", async () => {
    const h = harness();
    const order: string[] = [];
    h.deps.session = {
      flushPending: async () => {
        // A real flush yields: it awaits an IPC round trip to the store. The
        // fake must yield too, or this test cannot tell an awaited call from a
        // fire-and-forget one — an async function with no internal await runs
        // its whole body synchronously, so the ordering would come out right
        // even if the close handler dropped the await.
        await Promise.resolve();
        order.push("flush");
      },
      failed: () => false,
      dirtyCount: () => 0,
    };
    h.deps.invoke = async (cmd: string) => {
      order.push(cmd);
    };
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(order).toEqual(["flush", "confirm_close"]);
  });

  test("an unexpected close drain rejection explains why the window stays open", async () => {
    const h = harness();
    const errors: string[] = [];
    h.deps.session.flushPending = async () => { throw new Error("save preparation failed"); };
    h.deps.onError = (message) => errors.push(message);
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "release_close"]);
    expect(errors).toEqual(["Error: save preparation failed"]);
  });

  test("failed with dirty work at close raises the prompt and does not confirm", async () => {
    const h = harness();
    h.isFailed = true;
    h.dirty = 3;
    let promptedWith: number | undefined;
    h.deps.promptUnsavedClose = async (dirtyCount) => {
      promptedWith = dirtyCount;
      return "stay";
    };
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(promptedWith).toBe(3);
    expect(h.invoked).toEqual(["holding_close", "release_close"]);
    expect(h.invoked).not.toContain("confirm_close");
  });

  test("failed but nothing dirty does not prompt", async () => {
    const h = harness();
    h.isFailed = true;
    h.dirty = 0;
    h.deps.promptUnsavedClose = async () => {
      throw new Error("must not be called when nothing is dirty");
    };
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["confirm_close"]);
  });

  test("choosing close-and-lose at the prompt confirms the close", async () => {
    const h = harness();
    h.isFailed = true;
    h.dirty = 1;
    h.deps.promptUnsavedClose = async () => "close";
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "confirm_close"]);
  });

  test("discarding the work never releases the latch", async () => {
    // The release is the DECLINE path only. Releasing on the way to a
    // confirmed close would unlatch `Closing` and make the host prevent the
    // very close it was just told to allow.
    const h = harness();
    h.isFailed = true;
    h.dirty = 1;
    h.deps.promptUnsavedClose = async () => "close";
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).not.toContain("release_close");
  });

  test("no prompt dep at all defaults to staying open, never confirming", async () => {
    // The safe default when nothing can ask: never destroy work.
    const h = harness();
    h.isFailed = true;
    h.dirty = 2;
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", "release_close"]);
  });

  test("a rejected listen reports through onError", async () => {
    const h = harness();
    const errors: string[] = [];
    h.deps.listen = async () => {
      throw new Error("Command plugin:event|listen not allowed by ACL");
    };
    h.deps.onError = (message) => {
      errors.push(message);
    };
    wireLifecycle(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("Command plugin:event|listen not allowed by ACL");
  });

  test("a resolved listen does not call onError", async () => {
    const h = harness();
    const errors: string[] = [];
    h.deps.onError = (message) => {
      errors.push(message);
    };
    wireLifecycle(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(0);
  });

  test("wiring survives a host with no event bridge", () => {
    // The corpus path and a plain browser have no Tauri globals. Nothing here
    // may throw, or the page fails to assemble at all.
    const h = harness();
    h.deps.invoke = undefined;
    h.deps.listen = undefined;
    expect(() => wireLifecycle(h.deps)).not.toThrow();
    expect(h.windowListeners.has("blur")).toBe(true);
  });
});


describe("concealed lifecycle", () => {
  test("locked close holds failed work without asking or releasing", async () => {
    const h = harness();
    h.deps.privacyLocked = async () => true;
    h.isFailed = true;
    h.dirty = 1;
    h.deps.promptUnsavedClose = async () => { throw new Error("must stay concealed"); };
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.flushes).toBe(1);
    expect(h.invoked).toEqual(["privacy_close_failed"]);
  });

  test("locked close refuses rejected drains and dirty healthy schedulers", async () => {
    for (const rejection of [false, true]) {
      const h = harness();
      h.deps.privacyLocked = async () => true;
      if (rejection) h.deps.session.flushPending = async () => { throw new Error("save failed"); };
      else h.dirty = 1;
      wireLifecycle(h.deps);
      await h.hostListeners.get("app://close-requested")!();
      expect(h.invoked).toEqual(["privacy_close_failed"]);
    }
  });

  test("status failure is concealed and a clean locked close confirms", async () => {
    const h = harness();
    h.deps.privacyLocked = async () => { throw new Error("unavailable"); };
    h.dirty = 1;
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["privacy_close_failed"]);
    h.dirty = 0;
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["privacy_close_failed", "confirm_close"]);
  });

  test("lock acknowledgements wait for the live session, including empty startup", async () => {
    const h = harness();
    let session: { flushPending(): Promise<void>; failed: boolean; dirty: number } | null = null;
    const results: unknown[] = [];
    h.deps.session = {
      flushPending: () => session?.flushPending() ?? Promise.resolve(),
      failed: () => session?.failed ?? false,
      dirtyCount: () => session?.dirty ?? 0,
    };
    h.deps.invoke = async (cmd, args) => { results.push([cmd, args]); };
    wireLifecycle(h.deps);
    await h.hostListeners.get("app://privacy-lock")!();
    session = { flushPending: async () => { await Promise.resolve(); results.push("flushed"); }, failed: false, dirty: 0 };
    await h.hostListeners.get("app://privacy-lock")!();
    session.failed = true;
    await h.hostListeners.get("app://privacy-lock")!();
    session.flushPending = async () => { throw new Error("failure"); };
    await h.hostListeners.get("app://privacy-lock")!();
    expect(results).toEqual([
      ["privacy_drain_result", { ok: true }], "flushed",
      ["privacy_drain_result", { ok: true }], "flushed",
      ["privacy_drain_result", { ok: false }],
      ["privacy_drain_result", { ok: false }],
    ]);
  });
});


test("a lock arriving during a failed close drain cannot raise the discard prompt", async () => {
  const h = harness();
  let locked = false;
  h.deps.privacyLocked = async () => locked;
  h.deps.session.flushPending = async () => { locked = true; h.isFailed = true; h.dirty = 1; };
  h.deps.promptUnsavedClose = async () => { throw new Error("must stay concealed"); };
  wireLifecycle(h.deps);
  await h.hostListeners.get("app://close-requested")!();
  expect(h.invoked).toEqual(["privacy_close_failed"]);
});

test("readiness waits for registration and refuses either failed listener", async () => {
  for (const failedEvent of ["app://privacy-lock", "app://close-requested"]) {
    const h = harness();
    h.deps.listen = async (event) => { if (event === failedEvent) throw new Error("denied"); };
    expect(await wireLifecycle(h.deps)).toBe(false);
  }
  const h = harness();
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  h.deps.listen = async () => { await barrier; };
  let ready = false;
  const pending = wireLifecycle(h.deps).then((installed) => { ready = installed; });
  await Promise.resolve();
  expect(ready).toBe(false);
  release(); await pending;
  expect(ready).toBe(true);
});


test("close acknowledgements retain their request generation across a delayed flush", async () => {
  const h = harness();
  let finish = () => {};
  h.deps.session.flushPending = () => new Promise<void>((resolve) => { finish = resolve; });
  const acknowledgements: unknown[] = [];
  h.deps.invoke = async (command, args) => { acknowledgements.push([command, args]); };
  await wireLifecycle(h.deps);
  const pending = h.hostListeners.get("app://close-requested")!({ payload: 7 });
  await Promise.resolve();
  expect(acknowledgements).toEqual([]);
  finish();
  await pending;
  expect(acknowledgements).toEqual([["confirm_close", { attempt: 7 }]]);
});

test("locking during the discard prompt keeps unsaved work concealed and held", async () => {
  const h = harness();
  h.isFailed = true;
  h.dirty = 1;
  let locked = false;
  h.deps.privacyLocked = async () => locked;
  h.deps.promptUnsavedClose = async () => { locked = true; return "close"; };
  await wireLifecycle(h.deps);
  await h.hostListeners.get("app://close-requested")!({ payload: 2 });
  expect(h.invoked).toEqual(["holding_close", "privacy_close_failed"]);
});


for (const locked of [false, true]) {
  test(`count preparation failure respects privacy lock ${locked}`, async () => {
    const h = harness();
    let canceled = 0;
    let prompts = 0;
    h.deps.privacyLocked = async () => locked;
    h.deps.preferences = { prepareClose: async () => false, cancelClose: () => { canceled++; } };
    h.deps.promptPreferencesClose = async () => { prompts++; return "stay"; };
    await wireLifecycle(h.deps);
    await h.hostListeners.get("app://close-requested")!();
    expect(h.invoked).toEqual(["holding_close", locked ? "privacy_close_failed" : "release_close"]);
    expect(prompts).toBe(locked ? 0 : 1);
    expect(canceled).toBe(1);
  });
}

test("locked close waits for count preparation before manuscript drain and confirmation", async () => {
  const h = harness();
  let finish = () => {};
  h.deps.privacyLocked = async () => true;
  h.deps.preferences = {
    prepareClose: () => new Promise<boolean>((resolve) => { finish = () => resolve(true); }),
    cancelClose: () => { throw new Error("confirmed close must retain preference hold"); },
  };
  await wireLifecycle(h.deps);
  const closing = h.hostListeners.get("app://close-requested")!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.invoked).toEqual(["holding_close"]);
  expect(h.flushes).toBe(0);
  finish();
  await closing;
  expect(h.invoked).toEqual(["holding_close", "confirm_close"]);
  expect(h.flushes).toBe(1);
});

test("keeping a review draft restores prepared count controls", async () => {
  const h = harness();
  let canceled = 0;
  h.deps.preferences = { prepareClose: async () => true, cancelClose: () => { canceled++; } };
  h.deps.drafts = { pending: () => true, prepareClose: async () => false, cancelClose: () => {} };
  await wireLifecycle(h.deps);
  await h.hostListeners.get("app://close-requested")!();
  expect(h.invoked).toEqual(["holding_close", "holding_close", "release_close"]);
  expect(canceled).toBe(1);
});

test("a lock during the preference discard prompt refuses close and releases count controls", async () => {
  const h = harness();
  let locked = false;
  let canceled = 0;
  h.deps.privacyLocked = async () => locked;
  h.deps.preferences = { prepareClose: async () => false, cancelClose: () => { canceled++; } };
  h.deps.promptPreferencesClose = async () => { locked = true; return "close"; };
  await wireLifecycle(h.deps);
  await h.hostListeners.get("app://close-requested")!();
  expect(h.invoked).toEqual(["holding_close", "privacy_close_failed"]);
  expect(canceled).toBe(1);
});
