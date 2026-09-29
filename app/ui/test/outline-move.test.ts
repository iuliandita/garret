import { describe, expect, test } from "bun:test";
import { planMove, type MoveDirection, type MovePlan, type MoveTarget } from "../src/outline";
import type { ProjectItem } from "../src/store/source";

const moved = (target: MoveTarget): MovePlan => ({ kind: "move", target });

// Every item carries the SAME position string on purpose. planMove must derive
// sibling order from the walk, never from `position`: positions are per-parent
// fractional keys the page is not allowed to interpret, and a fixture whose
// positions happened to sort correctly would hide a planner that read them.
const item = (id: string, parent: string | null, depth: number, type = "scene"): ProjectItem =>
  ({ id, parent_id: parent, type, title: id, position: "0000", rev: 1, state: null, depth });

// Depth-first, exactly as the store's recursive CTE emits it. Two roots minimum
// so the root group is a real sibling group rather than a single item that
// makes every root-level case vacuous.
//
//   p1
//     c1
//       s1 s2 s3
//     c2
//       s4
//   p2
//   p3          (childless: the indent-into-empty-group case)
//   p4
const walk: ProjectItem[] = [
  item("p1", null, 0, "part"),
  item("c1", "p1", 1, "chapter"),
  item("s1", "c1", 2),
  item("s2", "c1", 2),
  item("s3", "c1", 2),
  item("c2", "p1", 1, "chapter"),
  item("s4", "c2", 2),
  item("p2", null, 0, "part"),
  item("p3", null, 0, "part"),
  item("p4", null, 0, "part"),
];

describe("planMove: up", () => {
  test("a middle item lands first in its group, so it follows nothing", () => {
    expect(planMove(walk, "s2", "up")).toEqual(moved({ newParentId: "c1", afterId: null }));
  });

  test("names the sibling TWO back, not one", () => {
    // The naive `sibs[idx - 1]` returns s2 here, which is where s3 already sits.
    // To land above s2, s3 must follow the row before it.
    expect(planMove(walk, "s3", "up")).toEqual(moved({ newParentId: "c1", afterId: "s1" }));
  });

  test("the first item of a group is inert", () => {
    expect(planMove(walk, "s1", "up")).toEqual({ kind: "inert" });
  });
});

describe("planMove: down", () => {
  test("follows the next sibling", () => {
    expect(planMove(walk, "s1", "down")).toEqual(moved({ newParentId: "c1", afterId: "s2" }));
  });

  test("the last item of a group is inert", () => {
    expect(planMove(walk, "s3", "down")).toEqual({ kind: "inert" });
  });
});

describe("planMove: outdent", () => {
  test("becomes the next sibling of its own parent", () => {
    expect(planMove(walk, "s1", "outdent")).toEqual(moved({ newParentId: "p1", afterId: "c1" }));
  });

  test("outdenting into the root group carries a null parent", () => {
    expect(planMove(walk, "c1", "outdent")).toEqual(moved({ newParentId: null, afterId: "p1" }));
  });

  test("a root has nowhere to go", () => {
    expect(planMove(walk, "p1", "outdent")).toEqual({ kind: "inert" });
  });
});

describe("planMove: indent", () => {
  test("becomes the last child of the previous sibling", () => {
    expect(planMove(walk, "c2", "indent")).toEqual(moved({ newParentId: "c1", afterId: "s3" }));
  });

  test("no previous sibling means no destination", () => {
    expect(planMove(walk, "s1", "indent")).toEqual({ kind: "inert" });
  });

  test("works in the root group too", () => {
    expect(planMove(walk, "p2", "indent")).toEqual(moved({ newParentId: "p1", afterId: "c2" }));
  });

  test("a childless previous sibling means first child, not a dangling afterId", () => {
    expect(planMove(walk, "p4", "indent")).toEqual(moved({ newParentId: "p3", afterId: null }));
  });
});

describe("planMove: malformed walk", () => {
  test("outdent refuses when the named parent is absent from the walk", () => {
    // The store's walk detects orphans, so this shape should not reach the
    // page - but the guard is only a guard if something reaches it. Without it
    // the grandparent lookup is undefined and the plan names a destination
    // derived from a parent nobody can see.
    //
    // Tagged `malformed`, not `inert`: the caller reports this one. Refusing
    // silently makes "the store and the page disagree about the shape of the
    // manuscript" look exactly like Alt+Up on the first sibling.
    const orphaned: ProjectItem[] = [item("p1", null, 0, "part"), item("lost", "vanished", 1)];
    const plan = planMove(orphaned, "lost", "outdent");
    expect(plan.kind).toBe("malformed");
    if (plan.kind === "malformed") expect(plan.reason).toContain("vanished");
  });
});

describe("planMove: unknown item", () => {
  const directions: MoveDirection[] = ["up", "down", "outdent", "indent"];
  for (const direction of directions) {
    test(`${direction} on an id absent from the walk is inert`, () => {
      expect(planMove(walk, "ghost", direction)).toEqual({ kind: "inert" });
    });
  }
});

describe("planMove: sibling order comes from the walk", () => {
  test("identical positions do not make the group ambiguous", () => {
    // Same assertion as the down case, restated against the invariant it
    // protects: every row above shares position "0000".
    expect(planMove(walk, "s1", "down")).toEqual(moved({ newParentId: "c1", afterId: "s2" }));
  });

  test("a group whose positions sort BACKWARDS still follows the walk", () => {
    // Identical positions alone cannot catch a position sort - a stable sort
    // leaves them in walk order and the planner passes while reading a field it
    // must not read. These positions descend, so any sort by position reverses
    // the group and `down` on the first row would name r3 instead of r2.
    const descending: ProjectItem[] = [
      { ...item("r0", null, 0, "chapter"), position: "9999" },
      { ...item("r1", "r0", 1), position: "0003" },
      { ...item("r2", "r0", 1), position: "0002" },
      { ...item("r3", "r0", 1), position: "0001" },
    ];
    expect(planMove(descending, "r1", "down")).toEqual(moved({ newParentId: "r0", afterId: "r2" }));
    expect(planMove(descending, "r3", "up")).toEqual(moved({ newParentId: "r0", afterId: "r1" }));
  });
});
