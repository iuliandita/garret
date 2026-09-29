import { describe, expect, test } from "bun:test";
import { createMutationPlanner, type PlannerItem } from "../src/measure/mutation-plan";

/** A part with two chapters under it, each holding one scene. Two branch items
 *  (the part and each chapter that has a child), which is the minimum the
 *  mutation phase needs to have somewhere to move things to. */
function tree(): PlannerItem[] {
  return [
    { id: "part", parent_id: null, rev: 1, title: "Part" },
    { id: "ch1", parent_id: "part", rev: 1, title: "Chapter 1" },
    { id: "sc1", parent_id: "ch1", rev: 1, title: "Scene 1" },
    { id: "ch2", parent_id: "part", rev: 1, title: "Chapter 2" },
    { id: "sc2", parent_id: "ch2", rev: 1, title: "Scene 2" },
  ];
}

/** Two roots, each with a chapter and a scene. Moves need more than one root:
 *  in a single-rooted tree the root is an ancestor of every branch, so it has no
 *  legal destination and the planner correctly refuses to move it — which is
 *  what the chain fixture pins. The real stress fixture has 570 roots.
 *  Branch order is [part1, part2, ch1, ch2]; the scan's first candidate for a
 *  target is always the branch immediately before it, so the first candidate for
 *  ch2 is ch1, which is what makes the applyMove test able to fail. */
function forest(): PlannerItem[] {
  return [
    { id: "part1", parent_id: null, rev: 1, title: "Part 1" },
    { id: "part2", parent_id: null, rev: 1, title: "Part 2" },
    { id: "ch1", parent_id: "part1", rev: 1, title: "Chapter 1" },
    { id: "sc1", parent_id: "ch1", rev: 1, title: "Scene 1" },
    { id: "ch2", parent_id: "part2", rev: 1, title: "Chapter 2" },
    { id: "sc2", parent_id: "ch2", rev: 1, title: "Scene 2" },
  ];
}

describe("createMutationPlanner", () => {
  test("accepts a tree with at least two branch items", () => {
    expect(() => createMutationPlanner(tree())).not.toThrow();
  });

  test("refuses a tree with fewer than two branch items", () => {
    // One parent, one child: exactly one item has children, so a move has
    // nowhere legal to go and the phase would report caller errors as store
    // errors.
    const thin: PlannerItem[] = [
      { id: "part", parent_id: null, rev: 1, title: "Part" },
      { id: "ch1", parent_id: "part", rev: 1, title: "Chapter 1" },
    ];
    expect(() => createMutationPlanner(thin)).toThrow(
      "mutation phase needs at least two branch items",
    );
  });

  test("refuses a flat list with no branches at all", () => {
    const flat: PlannerItem[] = [
      { id: "a", parent_id: null, rev: 1, title: "A" },
      { id: "b", parent_id: null, rev: 1, title: "B" },
    ];
    expect(() => createMutationPlanner(flat)).toThrow(
      "mutation phase needs at least two branch items",
    );
  });
});

describe("plan: create and rename", () => {
  test("every third mutation starting at 0 is a create under a branch", () => {
    const planner = createMutationPlanner(tree());
    const plan = planner.plan(0);
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return; // narrows for tsc
    expect(["part", "ch1", "ch2"]).toContain(plan.parentId);
    expect(plan.seq).toBe(0);
  });

  test("a rename carries the item's boot revision the first time", () => {
    const planner = createMutationPlanner(tree());
    const plan = planner.plan(1);
    expect(plan.kind).toBe("rename");
    if (plan.kind !== "rename") return; // narrows for tsc
    expect(plan.baseRev).toBe(1);
    expect(plan.title).toContain("(r1)");
  });

  test("a rename after a rename uses the TRACKED revision, not the boot one", () => {
    // The regression this exists to catch: with a hardcoded or boot-time
    // baseRev, the second mutation of any item conflicts, and the phase reports
    // a wall of swallowed conflicts as though they were mutations.
    const planner = createMutationPlanner(tree());
    const first = planner.plan(1);
    if (first.kind !== "rename") throw new Error("expected plan(1) to be a rename");

    planner.applyRename(first.id, 99);

    // plan(1) is deterministic, so asking again after the ack must now carry the
    // acked revision rather than the boot revision.
    const second = planner.plan(1);
    if (second.kind !== "rename") throw new Error("expected plan(1) to be a rename");
    expect(second.id).toBe(first.id);
    expect(second.baseRev).toBe(99);
  });

  test("a rename of an unknown item is a planner error, not a silent zero", () => {
    const planner = createMutationPlanner(tree());
    expect(() => planner.applyRename("nope", 5)).toThrow("no tracked revision for nope");
  });
});

/** Returns every ancestor id of `id`, plus `id` itself. Test-side and
 *  independent of the planner's own walk, so a bug shared by both cannot hide. */
function subtreeOf(items: PlannerItem[], id: string): Set<string> {
  const inside = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items) {
      if (i.parent_id !== null && inside.has(i.parent_id) && !inside.has(i.id)) {
        inside.add(i.id);
        grew = true;
      }
    }
  }
  return inside;
}

describe("plan: moves", () => {
  test("every third mutation starting at 2 is a move", () => {
    const planner = createMutationPlanner(forest());
    expect(planner.plan(2).kind).toBe("move");
    expect(planner.plan(5).kind).toBe("move");
  });

  test("a move never targets the item itself or one of its descendants", () => {
    const items = forest();
    const planner = createMutationPlanner(items);
    for (let n = 2; n < 60; n += 3) {
      const plan = planner.plan(n);
      if (plan.kind !== "move") throw new Error(`plan(${n}) should be a move`);
      expect(subtreeOf(items, plan.id).has(plan.newParentId)).toBe(false);
    }
  });

  test("a move carries the tracked revision and the ack updates it", () => {
    const planner = createMutationPlanner(forest());
    const first = planner.plan(2);
    if (first.kind !== "move") throw new Error("expected plan(2) to be a move");
    expect(first.baseRev).toBe(1);

    planner.applyMove(first.id, first.newParentId, 42);

    const second = planner.plan(2);
    if (second.kind !== "move") throw new Error("expected plan(2) to be a move");
    expect(second.baseRev).toBe(42);
  });

  test("applyMove updates the parent map, so later scans see the new shape", () => {
    const planner = createMutationPlanner(forest());
    // At n = 2 the target is ch2 and the FIRST candidate the scan offers is ch1.
    const before = planner.plan(2);
    if (before.kind !== "move") throw new Error("expected plan(2) to be a move");
    expect(before.id).toBe("ch2");
    expect(before.newParentId).toBe("ch1");

    // Now put ch1 inside ch2. ch1 stops being a legal destination for ch2, and a
    // planner still holding the boot parents would offer it anyway.
    planner.applyMove("ch1", "ch2", 2);

    const after = planner.plan(2);
    if (after.kind !== "move") throw new Error("expected plan(2) to be a move");
    expect(after.id).toBe("ch2");
    expect(after.newParentId).not.toBe("ch1");
  });

  test("throws when every branch is inside the target's own subtree", () => {
    // A straight chain a > b > c > d. The branches are a, b and c; at n = 2 the
    // target is branches[(2 + 1) % 3] = a, the root, and every branch is one of
    // its descendants. There is no legal destination, and the planner must say
    // so rather than emit a move the store is required to refuse.
    const chain: PlannerItem[] = [
      { id: "a", parent_id: null, rev: 1, title: "A" },
      { id: "b", parent_id: "a", rev: 1, title: "B" },
      { id: "c", parent_id: "b", rev: 1, title: "C" },
      { id: "d", parent_id: "c", rev: 1, title: "D" },
    ];
    const planner = createMutationPlanner(chain);
    expect(() => planner.plan(2)).toThrow("no legal new parent for a");
  });

  test("a parent cycle terminates instead of hanging", () => {
    // The candidate's ancestor chain must enter a cycle that does NOT contain
    // the target, or the walk stops early on its own and the bound is never
    // exercised. Here branches are [t, x, y]: at n = 2 the target is t and the
    // first candidate is y, whose chain is y -> x -> y -> ... and never reaches
    // t. Unbounded, that spins forever; bounded, it gives up after items.length
    // hops and reports the candidate legal.
    const cyclic: PlannerItem[] = [
      { id: "t", parent_id: null, rev: 1, title: "T" },
      { id: "tc", parent_id: "t", rev: 1, title: "T child" },
      { id: "x", parent_id: "y", rev: 1, title: "X" },
      { id: "y", parent_id: "x", rev: 1, title: "Y" },
    ];
    const planner = createMutationPlanner(cyclic);
    // The assertion is that this RETURNS AT ALL. Either a plan or a throw is
    // acceptable; hanging is not, and bun's per-test timeout is what catches it.
    const plan = planner.plan(2);
    expect(plan.kind).toBe("move");
  });
});
