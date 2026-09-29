// app/ui/test/save-indicator.test.ts
// The indicator's one claim is that it never says `Saved` when the writer's
// work is not in the file. Most of these tests exist to attack that.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createSaveIndicator, SAVE_NAME, SAVE_TEXT } from "../src/save-indicator";
import { createFlushScheduler, type FlushAck, type SaveState } from "../src/store/flush";

function container(): HTMLElement {
  const el = document.createElement("span");
  document.body.append(el);
  return el;
}

/** A scheduler whose flush resolution the test controls, so the window between
 *  "the map was cleared" and "the store acked" is reachable. That window is the
 *  whole reason `flushing` exists. */
function controllable(opts: { onStateChange?: (s: SaveState) => void } = {}) {
  let release: ((acks: FlushAck[]) => void) | null = null;
  let reject: ((err: Error) => void) | null = null;
  const timers: Array<() => void> = [];
  const scheduler = createFlushScheduler({
    invoke: () =>
      new Promise<FlushAck[]>((res, rej) => {
        release = res;
        reject = rej;
      }),
    // Fired by the test rather than by the clock.
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
    onStateChange: opts.onStateChange,
  });
  return {
    scheduler,
    fireDebounce: () => {
      const fn = timers.shift();
      if (fn === undefined) throw new Error("no timer was armed");
      fn();
    },
    ack: async (acks: FlushAck[] = []) => {
      release?.(acks);
      await scheduler.settled();
    },
    fail: async (message = "disk full") => {
      reject?.(new Error(message));
      await scheduler.settled();
    },
  };
}

describe("the save state a scheduler derives", () => {
  test("a scheduler with nothing to write is saved", () => {
    expect(controllable().scheduler.saveState()).toBe("saved");
  });

  test("an edit makes it pending before any flush is attempted", () => {
    const rig = controllable();
    rig.scheduler.markDirty("a", "body");
    expect(rig.scheduler.saveState()).toBe("pending");
  });

  test("it stays pending while the flush is in flight, with the dirty map already cleared", async () => {
    // The window this test exists for. `fire` clears the dirty map BEFORE it
    // awaits, so a state derived from `dirty.size` alone reports `saved` for the
    // entire duration of the write that is still happening - which is the one
    // lie this surface must never tell. Deleting `flushing` from saveState()
    // passes every other test in this file.
    const rig = controllable();
    rig.scheduler.markDirty("a", "body");
    rig.fireDebounce();

    expect(rig.scheduler.dirtyCount()).toBe(0);
    expect(rig.scheduler.saveState()).toBe("pending");

    await rig.ack([{ item_id: "a", rev: 1 }]);
    expect(rig.scheduler.saveState()).toBe("saved");
  });

  test("a failed flush is failed, not pending and not saved", async () => {
    const rig = controllable();
    rig.scheduler.markDirty("a", "body");
    rig.fireDebounce();
    await rig.fail();
    expect(rig.scheduler.saveState()).toBe("failed");
  });

  test("a failed scheduler stays failed when the writer types again", async () => {
    // The entries go back into the dirty map on failure, so a state that only
    // consulted the map would read `pending` here - which reads as "it is being
    // written", and it is not: autosave has stopped.
    const rig = controllable();
    rig.scheduler.markDirty("a", "body");
    rig.fireDebounce();
    await rig.fail();
    rig.scheduler.markDirty("a", "more");
    expect(rig.scheduler.saveState()).toBe("failed");
  });
});

describe("what the scheduler announces", () => {
  test("a transition is announced once, not once per keystroke", () => {
    const seen: SaveState[] = [];
    const rig = controllable({ onStateChange: (s) => seen.push(s) });
    rig.scheduler.markDirty("a", "b");
    rig.scheduler.markDirty("a", "bo");
    rig.scheduler.markDirty("a", "bod");
    expect(seen).toEqual(["pending"]);
  });

  test("the round trip announces pending then saved", async () => {
    const seen: SaveState[] = [];
    const rig = controllable({ onStateChange: (s) => seen.push(s) });
    rig.scheduler.markDirty("a", "b");
    rig.fireDebounce();
    await rig.ack([{ item_id: "a", rev: 1 }]);
    expect(seen).toEqual(["pending", "saved"]);
  });

  test("a failure announces failed", async () => {
    const seen: SaveState[] = [];
    const rig = controllable({ onStateChange: (s) => seen.push(s) });
    rig.scheduler.markDirty("a", "b");
    rig.fireDebounce();
    await rig.fail();
    expect(seen).toEqual(["pending", "failed"]);
  });

  test("stop does not announce saved", () => {
    // `stop` clears the dirty map, so the DERIVED state becomes `saved` - but
    // that work was discarded rather than written. Announcing here would tell a
    // departing project's display that the writer's unsaved work is safe.
    const seen: SaveState[] = [];
    const rig = controllable({ onStateChange: (s) => seen.push(s) });
    rig.scheduler.markDirty("a", "b");
    seen.length = 0;
    rig.scheduler.stop();
    expect(seen).toEqual([]);
  });
});

describe("what the indicator draws", () => {
  test("it opens on the state it was given, not on saved", () => {
    // A project mounted with work already dirty would otherwise be drawn as
    // saved until the next transition - and there may not be one.
    const el = container();
    const indicator = createSaveIndicator({ container: el, initial: "pending" });
    try {
      expect(el.querySelector("#save-indicator")?.textContent).toBe(SAVE_TEXT.pending);
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("both channels carry the state, and they are different sentences", () => {
    // The visible text and the accessible name are built from ONE variable, so
    // they cannot drift the way the word count's two renderings can. They are
    // deliberately not the same string: a name has no bar around it to give it
    // context, and `Not saved` alone could be read as describing the control
    // beside it.
    const el = container();
    const indicator = createSaveIndicator({ container: el, initial: "saved" });
    try {
      const node = el.querySelector("#save-indicator");
      for (const state of ["saved", "pending", "failed"] as const) {
        indicator.set(state);
        expect(node?.textContent).toBe(SAVE_TEXT[state]);
        expect(node?.getAttribute("aria-label")).toBe(SAVE_NAME[state]);
        expect(SAVE_NAME[state]).not.toBe(SAVE_TEXT[state]);
      }
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("it is a group, never a live region", () => {
    // The recorded finding: role="status" plus aria-live="off" leaves the
    // live-region apparatus attached and a client keying off the role still
    // announces. This value changes about once a second while someone types.
    const el = container();
    const indicator = createSaveIndicator({ container: el, initial: "saved" });
    try {
      const node = el.querySelector("#save-indicator");
      expect(node?.getAttribute("role")).toBe("group");
      expect(node?.getAttribute("aria-live")).toBeNull();
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("the state is on a data attribute so the stylesheet does not key on wording", () => {
    const el = container();
    const indicator = createSaveIndicator({ container: el, initial: "saved" });
    try {
      indicator.set("failed");
      expect(el.querySelector<HTMLElement>("#save-indicator")?.dataset.state).toBe("failed");
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("a set after destroy cannot reach the next project's element", () => {
    // The scheduler's onStateChange closure outlives the mount, so a flush
    // settling after a project switch DOES reach a destroyed indicator.
    //
    // What makes that safe is detachment, not a flag: `destroy` empties the
    // container, so the old indicator's element is in no document and the next
    // project owns a different one. This test asserts the observable half - the
    // live element is untouched - and deliberately does NOT claim the dead
    // indicator "draws nothing", which was the earlier version's wording and
    // was unfalsifiable: it passed with every guard removed, because writing to
    // a detached node is invisible either way.
    const el = container();
    const indicator = createSaveIndicator({ container: el, initial: "saved" });
    indicator.destroy();
    const next = createSaveIndicator({ container: el, initial: "pending" });

    indicator.set("failed");

    expect(el.querySelectorAll("#save-indicator")).toHaveLength(1);
    expect(el.querySelector("#save-indicator")?.textContent).toBe(SAVE_TEXT.pending);
    next.destroy();
    el.remove();
  });
});

describe("width reservation", () => {
  // A reported defect: the counts jumped left every time
  // `Saving…` replaced `Saved`, because the span reserved nothing and the three
  // states are three lengths. happy-dom lays nothing out, so the probe is given
  // a width proportional to its text and the assertion is about which text won.
  test("reserves the widest state's width and leaves no probe behind", () => {
    const el = container();
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { width: (this.textContent ?? "").length * 7 } as DOMRect;
    };
    try {
      createSaveIndicator({ container: el, initial: "saved" });
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
    const widest = Math.max(...Object.values(SAVE_TEXT).map((s) => s.length)) * 7;
    const node = el.querySelector<HTMLElement>("#save-indicator");
    expect(node?.style.minWidth).toBe(`${Math.ceil(widest)}px`);
    expect(el.children.length).toBe(1);
    expect(el.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  test("sets nothing when the DOM cannot measure", () => {
    const el = container();
    createSaveIndicator({ container: el, initial: "saved" });
    expect(el.querySelector<HTMLElement>("#save-indicator")?.style.minWidth).toBe("");
    expect(el.children.length).toBe(1);
  });
});
