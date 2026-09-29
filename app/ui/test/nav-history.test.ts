import { describe, expect, test } from "bun:test";

import { createNavHistory, historyChordOf, HISTORY_LIMIT } from "../src/nav-history";

/** Everything named is openable. The live set is the only thing this unit knows
 *  about the manuscript, so a test that wants a deleted scene simply leaves it
 *  out. */
const live = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("recording", () => {
  test("an opened document goes on the trail", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    expect(history.trail()).toEqual(["a", "b"]);
    expect(history.position()).toBe(1);
  });

  test("re-opening the document already open records nothing", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("a");
    expect(history.trail()).toEqual(["a"]);
  });

  test("the same scene visited again later is a new entry", () => {
    // Not the same case as above: the writer went somewhere and came back by
    // clicking, which is a move and belongs on the trail.
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    history.record("a");
    expect(history.trail()).toEqual(["a", "b", "a"]);
  });
});

describe("back and forward", () => {
  test("back then forward returns to where the writer started", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    history.record("c");
    expect(history.back(live("a", "b", "c"))).toBe("b");
    expect(history.back(live("a", "b", "c"))).toBe("a");
    expect(history.forward(live("a", "b", "c"))).toBe("b");
    expect(history.forward(live("a", "b", "c"))).toBe("c");
    expect(history.trail()).toEqual(["a", "b", "c"]);
  });

  test("going back does not push a new entry", () => {
    // THE DEFECT THIS FEATURE IS USUALLY SHIPPED WITH. The caller opens the
    // document `back` returned, and that open comes back through `record` - so
    // an implementation without the standing-still guard truncates the forward
    // stack and pushes the id again, leaving Back walking between two scenes
    // forever with Forward permanently empty.
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    history.record("c");
    const target = history.back(live("a", "b", "c"));
    expect(target).toBe("b");
    // What the activation path does with the answer.
    history.record(target as string);
    expect(history.trail()).toEqual(["a", "b", "c"]);
    expect(history.position()).toBe(1);
    expect(history.canGoForward(live("a", "b", "c"))).toBe(true);
    expect(history.forward(live("a", "b", "c"))).toBe("c");
  });

  test("a new navigation discards the forward stack", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    history.record("c");
    history.back(live("a", "b", "c"));
    history.record("b");
    history.record("d");
    expect(history.trail()).toEqual(["a", "b", "d"]);
    expect(history.canGoForward(live("a", "b", "c", "d"))).toBe(false);
  });

  test("back at the beginning of the trail does nothing", () => {
    const history = createNavHistory();
    history.record("a");
    expect(history.canGoBack(live("a"))).toBe(false);
    expect(history.back(live("a"))).toBeNull();
    expect(history.position()).toBe(0);
  });

  test("forward at the end of the trail does nothing", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    expect(history.canGoForward(live("a", "b"))).toBe(false);
    expect(history.forward(live("a", "b"))).toBeNull();
    expect(history.position()).toBe(1);
  });

  test("back on an empty trail does nothing", () => {
    const history = createNavHistory();
    expect(history.position()).toBe(-1);
    expect(history.canGoBack(live())).toBe(false);
    expect(history.back(live())).toBeNull();
    expect(history.canGoForward(live())).toBe(false);
    expect(history.forward(live())).toBeNull();
  });
});

describe("entries that no longer exist", () => {
  test("a deleted entry is skipped, not a dead end", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("gone");
    history.record("c");
    // "gone" was deleted, or moved to the bin, while the writer was in "c".
    expect(history.back(live("a", "c"))).toBe("a");
    expect(history.position()).toBe(0);
  });

  test("a run of deleted entries is skipped in one step", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("gone-1");
    history.record("gone-2");
    history.record("d");
    expect(history.back(live("a", "d"))).toBe("a");
  });

  test("back with nothing openable behind it reports nothing", () => {
    const history = createNavHistory();
    history.record("gone");
    history.record("b");
    expect(history.canGoBack(live("b"))).toBe(false);
    expect(history.back(live("b"))).toBeNull();
    // Position unmoved: a refused navigation must leave the writer where they
    // are, or the next Forward walks a trail they never travelled.
    expect(history.position()).toBe(1);
  });

  test("forward skips a deleted entry too", () => {
    const history = createNavHistory();
    history.record("a");
    history.record("gone");
    history.record("c");
    history.back(live("a", "c"));
    expect(history.forward(live("a", "c"))).toBe("c");
  });

  test("a restored entry becomes reachable again", () => {
    // Deliberately no pruning: this application restores from the bin, and a
    // trail that deleted its own entries would forget a scene the writer got
    // back.
    const history = createNavHistory();
    history.record("a");
    history.record("b");
    history.record("c");
    expect(history.back(live("a", "c"))).toBe("a");
    expect(history.forward(live("a", "b", "c"))).toBe("b");
  });
});

describe("the bound", () => {
  test("the oldest entry is dropped past the limit", () => {
    const history = createNavHistory(3);
    for (const id of ["a", "b", "c", "d"]) history.record(id);
    expect(history.trail()).toEqual(["b", "c", "d"]);
    expect(history.position()).toBe(2);
  });

  test("the position still names the newest entry after a drop", () => {
    // The drop shifts every index down by one. A position left where it was
    // would put the writer one entry back with no navigation having happened.
    const history = createNavHistory(2);
    history.record("a");
    history.record("b");
    history.record("c");
    expect(history.trail()).toEqual(["b", "c"]);
    expect(history.back(live("b", "c"))).toBe("b");
  });

  test("the shipped limit is a positive integer", () => {
    expect(Number.isInteger(HISTORY_LIMIT)).toBe(true);
    expect(HISTORY_LIMIT).toBeGreaterThan(1);
  });

  test("a limit below one is refused rather than clamped", () => {
    expect(() => createNavHistory(0)).toThrow();
    expect(() => createNavHistory(-1)).toThrow();
  });
});

describe("the chord rule", () => {
  const event = (over: Partial<Parameters<typeof historyChordOf>[0]>): Parameters<typeof historyChordOf>[0] => ({
    key: "ArrowLeft",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...over,
  });

  test("Alt+Left is back and Alt+Right is forward", () => {
    expect(historyChordOf(event({}))).toBe("back");
    expect(historyChordOf(event({ key: "ArrowRight" }))).toBe("forward");
  });

  test("the arrows alone are not the chord", () => {
    expect(historyChordOf(event({ altKey: false }))).toBeNull();
    expect(historyChordOf(event({ key: "ArrowRight", altKey: false }))).toBeNull();
  });

  test("another modifier alongside Alt is a different chord", () => {
    expect(historyChordOf(event({ ctrlKey: true }))).toBeNull();
    expect(historyChordOf(event({ metaKey: true }))).toBeNull();
    expect(historyChordOf(event({ shiftKey: true }))).toBeNull();
  });

  test("a keystroke something else already took is not ours", () => {
    // The navigator binds Alt+Left and Alt+Right to outdent and indent while the
    // outline has focus, and calls preventDefault when it takes them. This is
    // how the outline keeps them there without the two features fighting.
    expect(historyChordOf(event({ defaultPrevented: true }))).toBeNull();
    expect(historyChordOf(event({ key: "ArrowRight", defaultPrevented: true }))).toBeNull();
  });

  test("Alt+Up and Alt+Down are left to the outline", () => {
    expect(historyChordOf(event({ key: "ArrowUp" }))).toBeNull();
    expect(historyChordOf(event({ key: "ArrowDown" }))).toBeNull();
  });
});
