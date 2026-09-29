import { describe, expect, test } from "bun:test";
import { percentiles } from "../src/measure/stats";
import { ACTION_EFFECTS, buildWorkload, type ActionKind } from "../src/measure/workload";

describe("percentiles", () => {
  test("nearest-rank on a known series", () => {
    const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p.p50).toBe(5);
    expect(p.p95).toBe(10);
    expect(p.p99).toBe(10);
  });

  test("a single sample is its own percentile", () => {
    const p = percentiles([42]);
    expect(p.p50).toBe(42);
    expect(p.p99).toBe(42);
  });

  test("an empty series is 0, not NaN", () => {
    const p = percentiles([]);
    expect(p.p50).toBe(0);
    expect(p.p95).toBe(0);
    expect(p.p99).toBe(0);
  });

  test("order of input does not change the result", () => {
    expect(percentiles([9, 1, 5, 3, 7]).p50).toBe(percentiles([1, 3, 5, 7, 9]).p50);
  });
});

describe("buildWorkload", () => {
  test("produces the requested mix of actions", () => {
    const script = buildWorkload("seed-a", 15_200, { typingChars: 400, navJumps: 60 });
    expect(script.filter((a) => a.kind === "type").length).toBe(400);
    expect(script.filter((a) => a.kind === "nav").length).toBe(60);
  });

  test("is deterministic for a given seed", () => {
    const a = buildWorkload("seed-a", 15_200, { typingChars: 20, navJumps: 5 });
    const b = buildWorkload("seed-a", 15_200, { typingChars: 20, navJumps: 5 });
    expect(a).toEqual(b);
  });

  test("a different seed produces a different order", () => {
    const a = buildWorkload("seed-a", 15_200, { typingChars: 50, navJumps: 20 });
    const b = buildWorkload("seed-b", 15_200, { typingChars: 50, navJumps: 20 });
    expect(a).not.toEqual(b);
  });

  test("every navigation action carries a key from the navigator's own key set", () => {
    const navActions = buildWorkload("seed-a", 15_200, { typingChars: 0, navJumps: 200 }).filter(
      (a) => a.kind === "nav",
    );

    expect(navActions.length).toBe(200);
    for (const action of navActions) {
      // Asserted, not assumed: a nav action without a key would be dropped by a
      // filter-based fix and the test would still pass.
      const key = action.key;
      expect(key).toBeDefined();
      if (key === undefined) continue; // unreachable given the assertion above; narrows for tsc
      expect([
        "ArrowDown",
        "ArrowUp",
        "PageDown",
        "PageUp",
        "Home",
        "End",
        "ArrowLeft",
        "ArrowRight",
      ]).toContain(key);
    }
  });

  test("the key set actually exercises collapse and expand", () => {
    // The whole point of the change: unit tests covered collapse, no graded run
    // ever had. A drawn sample proves the keys are reachable, not merely listed.
    const keys = new Set(
      buildWorkload("seed-a", 15_200, { typingChars: 0, navJumps: 2000 })
        .filter((a) => a.kind === "nav")
        .map((a) => a.key),
    );
    expect(keys.has("ArrowLeft")).toBe(true);
    expect(keys.has("ArrowRight")).toBe(true);
  });

  test("derives break, erase and caret counts from the typing volume", () => {
    const script = buildWorkload("seed-a", 15_200, { typingChars: 400, navJumps: 60 });
    expect(script.filter((a) => a.kind === "type").length).toBe(400);
    expect(script.filter((a) => a.kind === "nav").length).toBe(60);
    expect(script.filter((a) => a.kind === "break").length).toBe(7); // ceil(400/60)
    expect(script.filter((a) => a.kind === "erase").length).toBe(16); // ceil(400/25)
    expect(script.filter((a) => a.kind === "caret").length).toBe(2); // ceil(400/200)
  });

  test("the rates scale with typingChars rather than being fixed", () => {
    const script = buildWorkload("seed-a", 15_200, { typingChars: 1200, navJumps: 0 });
    expect(script.filter((a) => a.kind === "break").length).toBe(20);
    expect(script.filter((a) => a.kind === "erase").length).toBe(48);
    expect(script.filter((a) => a.kind === "caret").length).toBe(6);
  });

  test("no typing means no editing actions at all", () => {
    // ceil(0/n) is 0, so a nav-only script stays nav-only. diag-cli runs one.
    const script = buildWorkload("seed-a", 15_200, { typingChars: 0, navJumps: 50 });
    expect(script.every((a) => a.kind === "nav")).toBe(true);
  });

  test("every caret action carries an in-range non-negative index", () => {
    const carets = buildWorkload("seed-a", 15_200, { typingChars: 4000, navJumps: 0 }).filter(
      (a) => a.kind === "caret",
    );
    expect(carets.length).toBe(20);
    for (const action of carets) {
      const index = action.index;
      expect(index).toBeDefined();
      if (index === undefined) continue; // narrows for tsc
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(4096);
    }
  });

  test("the new kinds are interleaved with typing, not appended in a block", () => {
    // The shuffle is what makes the workload a session rather than three phases.
    // Without it every break would land after every character.
    const script = buildWorkload("seed-a", 15_200, { typingChars: 600, navJumps: 0 });
    const firstBreak = script.findIndex((a) => a.kind === "break");
    const lastType = script.map((a) => a.kind).lastIndexOf("type");
    expect(firstBreak).toBeLessThan(lastType);
  });
});

describe("ACTION_EFFECTS", () => {
  test("declares effects for every action kind", () => {
    // Record<ActionKind, ...> makes a missing kind a compile error; this asserts
    // the runtime object matches, which a type alone does not guarantee once a
    // cast is anywhere in the chain.
    const kinds: ActionKind[] = ["type", "nav", "break", "caret", "erase"];
    for (const kind of kinds) {
      expect(ACTION_EFFECTS[kind]).toBeDefined();
    }
    expect(Object.keys(ACTION_EFFECTS).sort()).toEqual([...kinds].sort());
  });

  test("every editor kind is measured as typing; only nav is not", () => {
    expect(ACTION_EFFECTS.type.measuredAs).toBe("typing");
    expect(ACTION_EFFECTS.break.measuredAs).toBe("typing");
    expect(ACTION_EFFECTS.erase.measuredAs).toBe("typing");
    expect(ACTION_EFFECTS.caret.measuredAs).toBe("typing");
    expect(ACTION_EFFECTS.nav.measuredAs).toBe("nav");
  });

  test("caret is the only editor kind that cannot dirty the document", () => {
    // A caret jump moves the cursor. Marking it dirty arms the flush debounce and
    // can produce a store write with no edit behind it, which makes flush_count
    // and flush_p95_ms dishonest. This was a real defect, found in review.
    expect(ACTION_EFFECTS.caret.mutatesDocument).toBe(false);
    expect(ACTION_EFFECTS.type.mutatesDocument).toBe(true);
    expect(ACTION_EFFECTS.break.mutatesDocument).toBe(true);
    expect(ACTION_EFFECTS.erase.mutatesDocument).toBe(true);
    expect(ACTION_EFFECTS.nav.mutatesDocument).toBe(false);
  });

  test("only type counts as a character", () => {
    // charsTyped is the onset tracker's x-axis, and this project distinguishes
    // "degradation tracks characters" from "degradation tracks wall-clock" on it.
    const counting = Object.entries(ACTION_EFFECTS)
      .filter(([, fx]) => fx.countsAsCharacter)
      .map(([kind]) => kind);
    expect(counting).toEqual(["type"]);
  });
});
