import { describe, expect, test } from "bun:test";
import { loadStoreSource, storeSourceFrom, type ProjectItem } from "../src/store/source";

// Two parts, each with a first child at position "0000". Positions are
// per-parent, so this is the shape any sort by position gets wrong: the
// fixture must contain a duplicate position across parents or the sort it
// exists to forbid is a no-op on it.
const tree: ProjectItem[] = [
  { id: "p-1", parent_id: null, type: "part", title: "Part One", position: "0000", rev: 1, state: null, depth: 0 },
  { id: "c-1", parent_id: "p-1", type: "chapter", title: "Ch A", position: "0000", rev: 1, state: null, depth: 1 },
  { id: "s-1", parent_id: "c-1", type: "scene", title: "Sc 1", position: "0000", rev: 1, state: null, depth: 2 },
  { id: "p-2", parent_id: null, type: "part", title: "Part Two", position: "0001", rev: 1, state: null, depth: 0 },
  { id: "c-2", parent_id: "p-2", type: "chapter", title: "Ch B", position: "0000", rev: 1, state: null, depth: 1 },
];

describe("storeSourceFrom over a tree", () => {
  test("keeps every item, not just scenes", () => {
    const source = storeSourceFrom(tree, "nested-v1");
    expect(source.count).toBe(5);
    expect(source.titleAt(0)).toBe("Part One");
  });

  test("preserves the store's order rather than re-sorting", () => {
    // A sort by position would pull both "0000" chapters up next to the parts
    // and leave Part Two's chapter above Part One's scene.
    const source = storeSourceFrom(tree, "nested-v1");
    const ids = Array.from({ length: source.count }, (_, i) => source.idAt(i));
    expect(ids).toEqual(["p-1", "c-1", "s-1", "p-2", "c-2"]);
  });

  test("exposes depth", () => {
    const source = storeSourceFrom(tree, "nested-v1");
    expect(source.depthAt(2)).toBe(2);
    expect(Array.from({ length: 5 }, (_, i) => source.depthAt(i))).toEqual([0, 1, 2, 0, 1]);
  });

  test("an empty project is an error, not a vacuous pass", () => {
    expect(() => storeSourceFrom([], "x")).toThrow(/no items/);
  });

  test("an out-of-range index is an error, not a silent empty string", () => {
    const source = storeSourceFrom(tree, "nested-v1");
    expect(() => source.titleAt(5)).toThrow();
    expect(() => source.titleAt(-1)).toThrow();
  });

  test("does not mutate the caller's input array", () => {
    const copy = tree.map((i) => ({ ...i }));
    storeSourceFrom(tree, "nested-v1");
    expect(tree).toEqual(copy);
  });

  test("a later push by the caller cannot desynchronize count from the reachable rows", () => {
    const mutable = tree.slice();
    const source = storeSourceFrom(mutable, "nested-v1");
    mutable.push({
      id: "late", parent_id: null, type: "part", title: "Late", position: "0002", rev: 1, state: null, depth: 0,
    });
    expect(source.count).toBe(5);
    expect(() => source.idAt(5)).toThrow();
  });
});

describe("loadStoreSource", () => {
  test("never loads a document body while building the navigator source", async () => {
    const seen: string[] = [];
    const invoke = async (cmd: string): Promise<unknown> => {
      seen.push(cmd);
      if (cmd === "project_items") return tree;
      throw new Error(`unexpected command ${cmd}`);
    };
    const src = await loadStoreSource(invoke, "nested-v1");
    expect(src.count).toBe(5);
    // The guard that keeps 11.8 MB of manuscript out of the navigator.
    expect(seen).toEqual(["project_items"]);
  });
});
