import { describe, expect, test } from "bun:test";
import { project, type TreeNode } from "../src/navigator/visible";

// p-1 > (c-1 > s-1, c-2), p-2 > c-3
const nodes: TreeNode[] = [
  { id: "p-1", parentId: null, depth: 0, title: "Part One" },
  { id: "c-1", parentId: "p-1", depth: 1, title: "Ch A" },
  { id: "s-1", parentId: "c-1", depth: 2, title: "Sc 1" },
  { id: "c-2", parentId: "p-1", depth: 1, title: "Ch B" },
  { id: "p-2", parentId: null, depth: 0, title: "Part Two" },
  { id: "c-3", parentId: "p-2", depth: 1, title: "Ch C" },
];

// p-1 > c-1 > s-1 > b-1, then c-2 back at depth 1
const deep: TreeNode[] = [
  { id: "p-1", parentId: null, depth: 0, title: "Part One" },
  { id: "c-1", parentId: "p-1", depth: 1, title: "Ch A" },
  { id: "s-1", parentId: "c-1", depth: 2, title: "Sc 1" },
  { id: "b-1", parentId: "s-1", depth: 3, title: "Beat 1" },
  { id: "c-2", parentId: "p-1", depth: 1, title: "Ch B" },
];

describe("project", () => {
  test("with nothing collapsed, every node is visible in walk order", () => {
    const rows = project(nodes, new Set());
    expect(rows.map((r) => r.id)).toEqual(["p-1", "c-1", "s-1", "c-2", "p-2", "c-3"]);
  });

  test("setsize and posinset are per sibling group, not per visible list", () => {
    const rows = project(nodes, new Set());
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row("c-1").setsize).toBe(2);
    expect(row("c-1").posinset).toBe(1);
    expect(row("c-2").posinset).toBe(2);
    expect(row("p-1").setsize).toBe(2);
    expect(row("s-1").setsize).toBe(1);
  });

  test("collapsing a parent hides its grandchildren too", () => {
    const rows = project(nodes, new Set(["p-1"]));
    expect(rows.map((r) => r.id)).toEqual(["p-1", "p-2", "c-3"]);
  });

  test("collapsing an inner node hides only its own subtree", () => {
    const rows = project(nodes, new Set(["c-1"]));
    expect(rows.map((r) => r.id)).toEqual(["p-1", "c-1", "c-2", "p-2", "c-3"]);
  });

  test("hasChildren marks branches, so a leaf never claims aria-expanded", () => {
    const rows = project(nodes, new Set());
    expect(rows.find((r) => r.id === "c-1")!.hasChildren).toBe(true);
    expect(rows.find((r) => r.id === "s-1")!.hasChildren).toBe(false);
  });

  test("collapsing a leaf changes nothing", () => {
    expect(project(nodes, new Set(["s-1"])).length).toBe(nodes.length);
  });

  test("an empty walk projects nothing", () => {
    expect(project([], new Set())).toEqual([]);
  });

  test("a collapsed branch is not expanded, and a leaf is never expanded", () => {
    const rows = project(nodes, new Set(["c-1"]));
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row("c-1").expanded).toBe(false);
    expect(row("p-1").expanded).toBe(true);
    expect(project(nodes, new Set(["s-1"])).find((r) => r.id === "s-1")!.expanded).toBe(false);
  });

  // Point 4: collapse state is per node, so re-expanding an ancestor must not
  // resurrect a subtree that is itself still collapsed.
  test("expanding an ancestor leaves a still-collapsed descendant collapsed", () => {
    expect(project(deep, new Set(["p-1", "c-1"])).map((r) => r.id)).toEqual(["p-1"]);
    // p-1 expanded, c-1 still in the set
    const rows = project(deep, new Set(["c-1"]));
    expect(rows.map((r) => r.id)).toEqual(["p-1", "c-1", "c-2"]);
    expect(rows.find((r) => r.id === "c-1")!.expanded).toBe(false);
  });

  test("a collapse three levels down hides only that subtree", () => {
    expect(project(deep, new Set(["s-1"])).map((r) => r.id)).toEqual(["p-1", "c-1", "s-1", "c-2"]);
  });

  // Point 3: posinset counts the row's whole sibling group. Under a valid
  // depth-first walk a group is hidden all at once, so this also pins the
  // invariant that no visible row ever shares a group with a hidden one.
  test("posinset matches the position in the full sibling group under every collapse state", () => {
    const all: TreeNode[] = deep;
    const ids = all.map((n) => n.id);
    const subsets: string[][] = [[], ...ids.map((id) => [id]), ["p-1", "c-1"], ["c-1", "s-1"], ids];
    for (const subset of subsets) {
      const rows = project(all, new Set(subset));
      for (const r of rows) {
        const group = all.filter((n) => n.parentId === r.parentId);
        expect(r.setsize).toBe(group.length);
        expect(r.posinset).toBe(group.findIndex((n) => n.id === r.id) + 1);
      }
    }
  });

  // Point 2: hiding by depth is only equivalent to hiding by ancestry while the
  // input really is a depth-first walk. Mis-ordered input must panic, not
  // silently hide the wrong rows.
  test("a breadth-first walk panics instead of mis-hiding rows", () => {
    const bfs: TreeNode[] = [
      { id: "p-1", parentId: null, depth: 0, title: "Part One" },
      { id: "p-2", parentId: null, depth: 0, title: "Part Two" },
      { id: "c-1", parentId: "p-1", depth: 1, title: "Ch A" },
      { id: "c-3", parentId: "p-2", depth: 1, title: "Ch C" },
    ];
    expect(() => project(bfs, new Set())).toThrow(/depth-first/);
  });

  test("a depth that skips a level panics", () => {
    const jump: TreeNode[] = [
      { id: "p-1", parentId: null, depth: 0, title: "Part One" },
      { id: "s-1", parentId: "p-1", depth: 2, title: "Sc 1" },
    ];
    expect(() => project(jump, new Set())).toThrow(/depth-first/);
  });

  test("a depth-0 node carrying a parent panics", () => {
    const orphan: TreeNode[] = [
      { id: "p-1", parentId: null, depth: 0, title: "Part One" },
      { id: "c-1", parentId: "p-1", depth: 0, title: "Ch A" },
    ];
    expect(() => project(orphan, new Set())).toThrow(/depth-first/);
  });

  test("a root arriving at an impossible depth panics instead of being hidden", () => {
    const sunkenRoot: TreeNode[] = [
      { id: "r", parentId: null, depth: 0, title: "Part One" },
      { id: "c", parentId: "r", depth: 1, title: "Ch A" },
      { id: "z", parentId: null, depth: 3, title: "Part Two" },
    ];
    expect(() => project(sunkenRoot, new Set(["r"]))).toThrow(/depth-first/);
  });

  test("a negative depth panics rather than crashing on the ancestor path", () => {
    const negative: TreeNode[] = [
      { id: "p-1", parentId: null, depth: 0, title: "Part One" },
      { id: "c-1", parentId: null, depth: -1, title: "Ch A" },
    ];
    expect(() => project(negative, new Set())).toThrow(/depth-first/);
  });

  // A repeated id merges two sibling groups under one key: setsize is wrong on
  // both, one collapsed id collapses two unrelated nodes, and a hidden row ends
  // up sharing a group with a visible one.
  test("a duplicate id panics", () => {
    const dupes: TreeNode[] = [
      { id: "r", parentId: null, depth: 0, title: "Part One" },
      { id: "X", parentId: "r", depth: 1, title: "Ch A" },
      { id: "k1", parentId: "X", depth: 2, title: "Sc 1" },
      { id: "X", parentId: null, depth: 0, title: "Part Two" },
      { id: "k2", parentId: "X", depth: 1, title: "Ch C" },
    ];
    expect(() => project(dupes, new Set(["r"]))).toThrow(/duplicate node id X/);
  });

  test("malformed rows inside a collapsed subtree still panic", () => {
    const bad: TreeNode[] = [
      { id: "p-1", parentId: null, depth: 0, title: "Part One" },
      { id: "c-1", parentId: "p-1", depth: 1, title: "Ch A" },
      { id: "s-1", parentId: "nope", depth: 2, title: "Sc 1" },
    ];
    expect(() => project(bad, new Set(["p-1"]))).toThrow(/depth-first/);
  });

  // Point 5: this runs over the whole manuscript on every toggle.
  test("projects a 20,000-node manuscript, collapsed and expanded", () => {
    const big = manuscript(100);
    expect(big.length).toBe(20_100);

    const rows = project(big, new Set());
    const collapsed = project(big, new Set(big.filter((n) => n.depth === 1).map((n) => n.id)));

    expect(rows.length).toBe(big.length);
    expect(collapsed.length).toBe(100 + 1000);
    expect(rows[rows.length - 1]!.setsize).toBe(19);
    expect(rows[rows.length - 1]!.posinset).toBe(19);
    expect(collapsed.every((r) => r.depth <= 1)).toBe(true);
  });

  // Self-normalizing: a wall-clock budget would only measure the machine, and
  // this repo has burned enough time on that. Quadratic growth costs ~16x at 4x
  // the input, so a ratio bounded well above 4 catches it and tolerates noise.
  test("cost grows linearly, not quadratically, with manuscript size", () => {
    const small = manuscript(25);
    const big = manuscript(100);
    expect(big.length).toBe(small.length * 4);

    const best = (nodes: TreeNode[]): number => {
      let min = Infinity;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        project(nodes, new Set());
        min = Math.min(min, performance.now() - started);
      }
      return min;
    };

    best(big); // warm the JIT so the first sample is not the slow one
    expect(best(big) / Math.max(best(small), 0.01)).toBeLessThan(10);
  });
});

function manuscript(parts: number): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (let p = 0; p < parts; p++) {
    nodes.push({ id: `p-${p}`, parentId: null, depth: 0, title: `Part ${p}` });
    for (let c = 0; c < 10; c++) {
      const cid = `c-${p}-${c}`;
      nodes.push({ id: cid, parentId: `p-${p}`, depth: 1, title: `Ch ${c}` });
      for (let s = 0; s < 19; s++) {
        nodes.push({ id: `s-${p}-${c}-${s}`, parentId: cid, depth: 2, title: `Sc ${s}` });
      }
    }
  }
  return nodes;
}
