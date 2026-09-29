// The closed set, the words that describe it, and the distribution the
// statistics panel counts.
//
// Pure: no DOM anywhere in this file except where a source is parsed as text.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NO_STATE_LABEL,
  REVISION_STATES,
  STATE_LABELS,
  STATE_MARKS,
  isRevisionState,
  markFor,
  stateDescriptionId,
  stateDistribution,
} from "../src/revision-states";

const RUST = readFileSync(
  join(import.meta.dir, "..", "..", "shell-tauri", "src-tauri", "src", "store", "mod.rs"),
  "utf8",
);

describe("the set is closed and both languages agree on it", () => {
  test("the page's states are the host's states, in the same order", () => {
    // RESTATED, NOT IMPORTED - there is no import across that boundary, exactly
    // as with TRASH_TYPE and the word rule. What a shared constant would hide,
    // two statements plus this test fail on. Order matters as well as
    // membership: it is the progression a manuscript makes, and the panel and
    // the distribution both list them in it.
    const match = RUST.match(/pub const ITEM_STATES: \[&str; (\d+)\] = \[([^\]]+)\];/);
    expect(match).not.toBeNull();
    const declared = [...(match?.[2] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(declared).toEqual([...REVISION_STATES]);
    // The array's own length, so a member added to the literal without widening
    // the type is caught host-side rather than at the first refusal.
    expect(Number(match?.[1])).toBe(REVISION_STATES.length);
  });

  test("`none` is not a member in either language", () => {
    // The absence, not a fifth word. A default stored as a value is a default
    // free to drift from the code's idea of the default, and it makes "the
    // writer chose none" and "the writer chose nothing" two states of one fact.
    expect(REVISION_STATES).not.toContain("none" as never);
    // The Rust LITERAL, never the whole file: the comment beside it explains why
    // `none` is not a member and names the word, so a search over the source
    // finds it in the prose and fails against the correct implementation. Third
    // instance of the recorded theme.test.ts trap, twice in this slice.
    const literal = RUST.match(/pub const ITEM_STATES[^;]+;/)?.[0] ?? "";
    expect(literal.length).toBeGreaterThan(0);
    expect(literal).not.toContain('"none"');
    expect(isRevisionState("none")).toBe(false);
    expect(isRevisionState(null)).toBe(false);
    expect(isRevisionState(undefined)).toBe(false);
  });

  test("every state has a label and a mark, and no two share either", () => {
    // A duplicate mark is the failure this feature would be worst at: two states
    // that look identical in the navigator, in a surface a writer scans rather
    // than reads.
    const labels = REVISION_STATES.map((s) => STATE_LABELS[s]);
    const marks = REVISION_STATES.map((s) => STATE_MARKS[s]);
    expect(new Set(labels).size).toBe(REVISION_STATES.length);
    expect(new Set(marks).size).toBe(REVISION_STATES.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(2);
    // One character each: the row is a box of exactly ROW_HEIGHT and a mark that
    // wrapped would break every rig computing a click from it.
    for (const mark of marks) expect([...mark].length).toBe(1);
    expect(labels).not.toContain(NO_STATE_LABEL);
  });

  test("a description id is distinct per state", () => {
    const ids = REVISION_STATES.map(stateDescriptionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("markFor", () => {
  test("a known state gets its mark", () => {
    expect(markFor("done")).toBe(STATE_MARKS.done);
  });

  test("no state, and a state from a newer build, both get nothing", () => {
    // Not a placeholder and not a question mark: the second is the surface
    // claiming to know something about a word it has never heard of.
    expect(markFor(null)).toBe("");
    expect(markFor(undefined)).toBe("");
    expect(markFor("abandoned")).toBe("");
  });
});

describe("stateDistribution", () => {
  const walk = (...states: (string | null)[]): { state: string | null }[] =>
    states.map((state) => ({ state }));

  test("counts each state and the absence, over every item handed to it", () => {
    const seen = stateDistribution(
      walk("draft", "draft", "done", null, "outline", null, "revising"),
    );
    expect(seen.counts).toEqual({ outline: 1, draft: 2, revising: 1, done: 1 });
    expect(seen.none).toBe(2);
    expect(seen.total).toBe(7);
  });

  test("every state is present at zero rather than absent", () => {
    // A zero is a real answer here - "nothing is done yet" is a measurement -
    // and a panel that omitted the row would say something different: that the
    // state does not exist.
    const seen = stateDistribution(walk("draft"));
    expect(seen.counts.done).toBe(0);
    expect(seen.counts.outline).toBe(0);
    expect(seen.counts.revising).toBe(0);
  });

  test("the parts always sum to the total", () => {
    // What makes the distribution readable as a distribution rather than as five
    // unrelated figures. A row double-counted or dropped shows up here and
    // nowhere else.
    const rows = walk("done", null, "abandoned", "draft", null, "revising", "outline");
    const seen = stateDistribution(rows);
    const summed =
      seen.none + REVISION_STATES.reduce((total, state) => total + seen.counts[state], 0);
    expect(summed).toBe(seen.total);
    expect(seen.total).toBe(rows.length);
  });

  test("a state this build does not know counts as none, not as its own bucket", () => {
    // It can only come from a newer build; the navigator draws nothing for it,
    // and a distribution that named it would be the only surface in the
    // application claiming to understand it.
    const seen = stateDistribution(walk("abandoned", "abandoned"));
    expect(seen.none).toBe(2);
    expect(seen.counts).toEqual({ outline: 0, draft: 0, revising: 0, done: 0 });
  });

  test("an empty walk is all zeros and not an error", () => {
    const seen = stateDistribution([]);
    expect(seen.total).toBe(0);
    expect(seen.none).toBe(0);
  });
});
