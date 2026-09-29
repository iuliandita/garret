// app/harness/test/salvage-damage.test.ts
// The scripted damage, and the claim that makes this rig's oracle free: every
// step breaks the row it was AIMED at, and the kinds it owes are the union of
// the steps' own, ordered and stated once.
import { describe, expect, test } from "bun:test";
import {
  assertDistinctTargets,
  damagePlan,
  expectedLossKinds,
  sqlString,
  type DamageStep,
  type DamageTargets,
} from "../src/salvage-damage";

/** Five DISTINCT and distinctive targets. Nothing here is a substring of
 *  anything else, so a step that interpolated the wrong one is caught by name
 *  rather than by a count. */
const TARGETS: DamageTargets = {
  corruptedScene: "scene-alpha",
  deletedItem: "item-bravo",
  deletedMember: "member-charlie",
  designKey: "design.delta",
  removedCover: "cover-echo.png",
};

describe("sqlString", () => {
  test("doubles an embedded quote", () => {
    expect(sqlString("O'Hare")).toBe("'O''Hare'");
  });

  test("doubles EVERY embedded quote, not just the first", () => {
    // A `replace` without the global flag passes the test above and truncates
    // this one into a statement SQLite would reject -- a damage step that
    // silently does nothing, and a gate reporting a correct recovery as broken.
    expect(sqlString("a'b'c")).toBe("'a''b''c'");
  });

  test("an ordinary id is quoted and otherwise untouched", () => {
    expect(sqlString("it-000008")).toBe("'it-000008'");
  });
});

describe("damagePlan", () => {
  const plan = damagePlan(TARGETS);

  test("every step names at least one loss and carries an injury", () => {
    for (const step of plan) {
      expect(step.expects.length).toBeGreaterThan(0);
      expect(step.sql.length + step.removeFiles.length).toBeGreaterThan(0);
    }
  });

  test("each target appears in the step that was aimed at it and in no other", () => {
    // THE TEST THAT KILLS A HARD-CODED ID. Each target is looked for by name
    // across the whole plan and must be found exactly once: a step that
    // interpolated a literal, or the wrong field, moves the count off one.
    const text = plan.map((s) => [...s.sql, ...s.removeFiles].join(" "));
    for (const target of [
      TARGETS.corruptedScene,
      TARGETS.deletedItem,
      TARGETS.deletedMember,
      TARGETS.designKey,
      TARGETS.removedCover,
    ]) {
      expect(text.filter((t) => t.includes(target))).toHaveLength(1);
    }
  });

  test("the deleted item and the corrupted body are different rows", () => {
    const deleting = plan.find((s) => s.sql.some((q) => q.startsWith("DELETE FROM item")));
    const corrupting = plan.find((s) => s.sql.some((q) => q.startsWith("UPDATE doc")));
    expect(deleting!.sql[0]).toContain(TARGETS.deletedItem);
    expect(deleting!.sql[0]).not.toContain(TARGETS.corruptedScene);
    expect(corrupting!.sql[0]).toContain(TARGETS.corruptedScene);
    expect(corrupting!.sql[0]).not.toContain(TARGETS.deletedItem);
  });

  test("the body it writes is not JSON, which is what makes it unreadable", () => {
    // A body that PARSED would be recovered perfectly and `unreadable_body`
    // would never be owed. The claim is about the bytes, so it is asserted about
    // the bytes: JSON.parse must refuse them.
    const corrupting = plan.find((s) => s.sql.some((q) => q.startsWith("UPDATE doc")))!;
    const body = /body = '([^']*)'/.exec(corrupting.sql[0]!)![1]!;
    expect(() => JSON.parse(body)).toThrow();
  });

  test("the whole plan is refused when two steps would land on one row", () => {
    expect(() => damagePlan({ ...TARGETS, deletedItem: TARGETS.corruptedScene })).toThrow(
      /damage targets collide/,
    );
  });
});

describe("assertDistinctTargets", () => {
  test("accepts targets that differ", () => {
    expect(() => assertDistinctTargets(TARGETS)).not.toThrow();
  });

  test("names BOTH roles the colliding id is playing", () => {
    // A refusal that says only "targets collide" leaves the reader to find which
    // two, and the fix is a one-word argument change at the call site.
    expect(() =>
      assertDistinctTargets({ ...TARGETS, corruptedScene: TARGETS.deletedItem }),
    ).toThrow(/item-bravo is both the item deleted and the item whose body is corrupted/);
  });
});

describe("expectedLossKinds", () => {
  /** Built by hand and DELIBERATELY OUT OF ORDER, with one kind owed twice.
   *  Fed `damagePlan`'s own output, a sort is unfalsifiable the moment the plan
   *  happens to be written in alphabetical order -- the fixture-is-a-fact-about-
   *  itself shape, and the reason this input is not the real plan. */
  const SCRAMBLED: DamageStep[] = [
    { name: "one", sql: [], removeFiles: [], expects: ["zeta", "alpha"] },
    { name: "two", sql: [], removeFiles: [], expects: ["mu", "alpha"] },
  ];

  test("orders the kinds and states each once", () => {
    expect(expectedLossKinds(SCRAMBLED)).toEqual(["alpha", "mu", "zeta"]);
  });

  test("an empty plan owes nothing", () => {
    expect(expectedLossKinds([])).toEqual([]);
  });

  test("the real plan owes orphan_appearance once, from two steps", () => {
    // The one kind two steps genuinely share: a tag has an end at each of them.
    // Demanded twice it could never be satisfied by a recovery that reports each
    // kind once, and the deduplication is what this asserts.
    const plan = damagePlan(TARGETS);
    const owing = plan.filter((s) => s.expects.includes("orphan_appearance"));
    expect(owing).toHaveLength(2);
    expect(expectedLossKinds(plan).filter((k) => k === "orphan_appearance")).toHaveLength(1);
  });
});
