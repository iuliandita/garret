import { describe, expect, test } from "bun:test";
import {
  createUndoStack,
  inverseOf,
  previousSiblingOf,
  resolveAfter,
  type UndoEntry,
  type UndoStep,
} from "../src/outline-undo";
import type { ProjectItem } from "../src/store/source";

const item = (
  id: string,
  parent: string | null,
  rev = 1,
  title = id,
  type = "scene",
  state: string | null = null,
): ProjectItem => ({ id, parent_id: parent, type, title, position: "0000", rev, state, depth: 0 });

//   p1
//     c1
//       s1 s2
//   p2
const walk = (): ProjectItem[] => [
  item("p1", null, 1, "p1", "part"),
  item("c1", "p1", 7, "c1", "chapter"),
  item("s1", "c1"),
  item("s2", "c1"),
  item("p2", null, 1, "p2", "part"),
];

const move = (
  id: string,
  parentId: string | null,
  afterId: string | null,
): Extract<UndoStep, { kind: "move" }> => ({
  kind: "move",
  id,
  title: id,
  parentId,
  afterId,
});

describe("createUndoStack", () => {
  const entry = (label: string): UndoEntry => ({ label, steps: [] });

  test("push then takeUndo returns the entry, and canUndo flips", () => {
    const stack = createUndoStack();
    expect(stack.canUndo()).toBe(false);
    stack.push(entry("moving s2"));
    expect(stack.canUndo()).toBe(true);
    expect(stack.takeUndo()).toEqual(entry("moving s2"));
    expect(stack.canUndo()).toBe(false);
  });

  test("redo is empty until an undo happened", () => {
    const stack = createUndoStack();
    stack.push(entry("moving s2"));
    expect(stack.canRedo()).toBe(false);
    stack.pushRedo(entry("moving s2 back"));
    expect(stack.canRedo()).toBe(true);
    expect(stack.takeRedo()).toEqual(entry("moving s2 back"));
  });

  test("push clears redo", () => {
    const stack = createUndoStack();
    stack.push(entry("a"));
    stack.pushRedo(entry("a back"));
    expect(stack.canRedo()).toBe(true);
    stack.push(entry("b"));
    expect(stack.canRedo()).toBe(false);
  });

  test("cap 200 drops the OLDEST", () => {
    const stack = createUndoStack(200);
    for (let i = 0; i < 201; i++) stack.push(entry(`entry-${i}`));
    // The newest 200 survive; the very first (entry-0) is gone.
    const popped: string[] = [];
    while (stack.canUndo()) {
      const e = stack.takeUndo();
      if (e) popped.push(e.label);
    }
    expect(popped.length).toBe(200);
    expect(popped).not.toContain("entry-0");
    expect(popped[popped.length - 1]).toBe("entry-1");
    expect(popped[0]).toBe("entry-200");
  });

  test("takeUndo and takeRedo answer null on an empty stack", () => {
    const stack = createUndoStack();
    expect(stack.takeUndo()).toBeNull();
    expect(stack.takeRedo()).toBeNull();
  });

  test("undoLabel/redoLabel read the TOP entry, or null", () => {
    const stack = createUndoStack();
    expect(stack.undoLabel()).toBeNull();
    expect(stack.redoLabel()).toBeNull();
    stack.push(entry("a"));
    stack.push(entry("b"));
    expect(stack.undoLabel()).toBe("b");
    stack.pushRedo(entry("b back"));
    expect(stack.redoLabel()).toBe("b back");
  });

  test("clearRedo empties it without touching undo", () => {
    const stack = createUndoStack();
    stack.push(entry("a"));
    stack.pushRedo(entry("a back"));
    stack.clearRedo();
    expect(stack.canRedo()).toBe(false);
    expect(stack.canUndo()).toBe(true);
  });

  test("pushUndoFromRedo puts an entry back on undo without clearing redo", () => {
    const stack = createUndoStack();
    stack.push(entry("a"));
    stack.pushRedo(entry("a back"));
    stack.pushUndoFromRedo(entry("a forward again"));
    expect(stack.canRedo()).toBe(true);
    expect(stack.undoLabel()).toBe("a forward again");
  });
});

describe("previousSiblingOf", () => {
  test("the sibling immediately before, in walk order", () => {
    expect(previousSiblingOf(walk(), "s2")).toBe("s1");
  });

  test("the first child has no previous sibling", () => {
    expect(previousSiblingOf(walk(), "s1")).toBeNull();
  });

  test("an id not in the walk has no previous sibling", () => {
    expect(previousSiblingOf(walk(), "ghost")).toBeNull();
  });
});

describe("resolveAfter", () => {
  test("a sibling id present in the walk is returned unchanged", () => {
    expect(resolveAfter(walk(), "s1")).toBe("s1");
  });

  test("an id absent from the walk falls back to null", () => {
    expect(resolveAfter(walk(), "gone")).toBeNull();
  });

  test("null resolves to null", () => {
    expect(resolveAfter(walk(), null)).toBeNull();
  });
});

describe("inverseOf", () => {
  test("move: the inverse of moving s2 away is moving it back to (c1, after s1)", () => {
    // The forward target's own parentId/afterId are irrelevant to the
    // inverse -- only the walk's CURRENT position of s2 matters, which is
    // what this asserts by feeding a forward step aimed somewhere else
    // entirely (root, after p2).
    const forward = move("s2", null, "p2");
    expect(inverseOf(forward, walk())).toEqual(move("s2", "c1", "s1"));
  });

  test("move: the inverse for the FIRST child carries afterId: null", () => {
    const forward = move("s1", null, "p2");
    expect(inverseOf(forward, walk())).toEqual(move("s1", "c1", null));
  });

  test("rename: reads the CURRENT title from the walk", () => {
    const step: UndoStep = { kind: "rename", id: "c1", title: "New" };
    expect(inverseOf(step, walk())).toEqual({ kind: "rename", id: "c1", title: "c1" });
  });

  test("state: reads the CURRENT state from the walk", () => {
    const marked = walk().map((i) => (i.id === "s1" ? { ...i, state: "drafting" } : i));
    const step: UndoStep = { kind: "state", id: "s1", title: "s1", state: "outline" };
    expect(inverseOf(step, marked)).toEqual({ kind: "state", id: "s1", title: "s1", state: "drafting" });
  });

  test("state: a row with no state answers null, not undefined", () => {
    const step: UndoStep = { kind: "state", id: "s1", title: "s1", state: "drafting" };
    expect(inverseOf(step, walk())).toEqual({ kind: "state", id: "s1", title: "s1", state: null });
  });

  test("an id not in the walk returns null", () => {
    expect(inverseOf(move("ghost", null, null), walk())).toBeNull();
    expect(inverseOf({ kind: "rename", id: "ghost", title: "x" }, walk())).toBeNull();
  });
});
