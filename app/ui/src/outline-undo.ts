// app/ui/src/outline-undo.ts
// The pure half of structural undo (085): a stack of inverse PLANS, and the
// arithmetic that turns a step into its own reverse against a walk.
//
// AN ENTRY IS AN INVERSE PLAN, NOT A SNAPSHOT. `outline.ts` builds one from the
// walk it read just before a mutation landed, and applies it step by step,
// recomputing each step's reverse from the LIVE walk right before that step
// runs -- so redo is the same machinery pointed the other way, and nothing here
// is derived from a mutation's own report of what it did. That discipline is
// the unit's standing rule (see `outline.ts`'s header) and this module is
// where it is enforced for undo specifically.
//
// FREE FUNCTIONS, not methods on a class: a rule inside `createOutline`'s
// closure is a rule no test can reach without a full rig, which is the shape
// that let three flush mutations survive before this file existed for the
// same reason `placement.ts` does.
import type { ProjectItem } from "./store/source";

export type UndoStep =
  | {
      kind: "move";
      id: string;
      /** The row's title, carried for messaging ONLY -- never sent over IPC.
       *  A row can vanish between push and apply, and the failure sentence
       *  names it by the title it had when this step was recorded, not by an
       *  id a writer cannot read. */
      title: string;
      /** null means the root group. */
      parentId: string | null;
      /** The row this step's target lands AFTER. null means first child. */
      afterId: string | null;
    }
  | { kind: "rename"; id: string; title: string }
  | { kind: "state"; id: string; title: string; state: string | null }
  /** Undo of a create: move the row (and its subtree) into the bin, making
   *  the bin first if the walk has none. Kept apart from "move" because
   *  applying it needs `ensureBin()`, which "move" never does -- the bin may
   *  not exist yet when this step was recorded, so no fixed `parentId` could
   *  be written down for it. */
  | { kind: "bin"; id: string; title: string };

export interface UndoEntry {
  /** One catalog sentence naming the act and the row's title, e.g.
   *  "moving s2". What both the menu and the "Undone: {what}." banner show. */
  label: string;
  steps: UndoStep[];
}

/** Siblings in WALK ORDER, matching `outline.ts`'s own `siblingsOf` -- the
 *  store's walk is depth-first and each sibling group is already emitted in
 *  position order. Restated here rather than imported: that copy is a private
 *  detail of `outline.ts` and this module has no dependency on it. */
function siblingsOf(walk: readonly ProjectItem[], parentId: string | null): ProjectItem[] {
  return walk.filter((i) => i.parent_id === parentId);
}

/** The sibling immediately before `id`, in the group it currently sits in, or
 *  null when it is the first child (or absent from the walk). */
export function previousSiblingOf(walk: readonly ProjectItem[], id: string): string | null {
  const row = walk.find((i) => i.id === id);
  if (row === undefined) return null;
  const sibs = siblingsOf(walk, row.parent_id);
  const idx = sibs.findIndex((i) => i.id === id);
  if (idx <= 0) return null;
  return sibs[idx - 1]?.id ?? null;
}

/** The fallback: a recorded `afterId` the walk no longer holds falls back to
 *  null, which `item_move` (store/mod.rs) takes as FIRST in the destination
 *  group -- not "append", which is what a missing `afterId` means everywhere
 *  ELSE in this unit. The sibling this row followed is gone, so there is no
 *  "same place" left to land in; first is a place the writer can still see,
 *  and the entry's own redo (computed live, from wherever this lands) still
 *  works either way. `null` itself always resolves to `null` -- there is no
 *  sibling to have gone missing. */
export function resolveAfter(walk: readonly ProjectItem[], afterId: string | null): string | null {
  if (afterId === null) return null;
  return walk.some((i) => i.id === afterId) ? afterId : null;
}

/** The step that would take `step`'s row back to where `walk` currently has
 *  it. ONLY `step.kind` and `step.id` are read from the input -- the inverse
 *  of "move this row anywhere" is "move it back to where it is now", which
 *  `walk` already answers regardless of where the forward step was headed.
 *
 *  NO "bin" CASE: a "bin" step has no inverse of its own kind, since undoing
 *  INTO the bin is a move like any other once the bin exists, and its reverse
 *  (computed the moment before undo's own move runs) is an ordinary "move"
 *  back to the live position -- which is also what lets a REDO of a binned
 *  create put the row back without a second `item_create`. `outline.ts` asks
 *  for that reverse by spelling the request as a "move" over the same id, so
 *  the parameter type excludes "bin" rather than carrying an arm nothing ever
 *  reaches -- the precedent is `import_name_ok`: a guard nothing can reach is
 *  worse than no guard, because it documents a behaviour as available.
 *
 *  null when `step.id` is not in `walk`: nothing to invert, and the caller
 *  reports that as its own failure rather than inventing a target. */
export function inverseOf(
  step: Exclude<UndoStep, { kind: "bin" }>,
  walk: readonly ProjectItem[],
): UndoStep | null {
  const row = walk.find((i) => i.id === step.id);
  if (row === undefined) return null;
  switch (step.kind) {
    case "move":
      return {
        kind: "move",
        id: step.id,
        title: row.title,
        parentId: row.parent_id,
        afterId: previousSiblingOf(walk, step.id),
      };
    case "rename":
      return { kind: "rename", id: step.id, title: row.title };
    case "state":
      return { kind: "state", id: step.id, title: row.title, state: row.state ?? null };
  }
}

export interface UndoStack {
  /** A new operation's entry. Clears redo and drops the OLDEST undo
   *  entry once the stack holds more than `cap`. */
  push(entry: UndoEntry): void;
  /** Pop the most recent undo entry, or null when there is none. */
  takeUndo(): UndoEntry | null;
  /** Pop the most recent redo entry, or null when there is none. */
  takeRedo(): UndoEntry | null;
  /** Undo's own reverse, computed while applying an undo entry. Does NOT
   *  clear undo -- this is bookkeeping mid-undo, not a new operation. */
  pushRedo(entry: UndoEntry): void;
  /** Redo's own reverse, computed while applying a redo entry, pushed back
   *  onto undo. Does NOT clear redo, for the same reason. */
  pushUndoFromRedo(entry: UndoEntry): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** The top undo entry's label, or null when the stack is empty. Painted at
   *  paint time by both the menu and the navigator's chord (indirectly,
   *  through the banner it raises), never cached. */
  undoLabel(): string | null;
  redoLabel(): string | null;
  /** Empties the redo stack. Exposed separately from `push` because a failed
   *  undo step clears redo without pushing anything. */
  clearRedo(): void;
}

export function createUndoStack(cap = 200): UndoStack {
  let undo: UndoEntry[] = [];
  let redo: UndoEntry[] = [];

  function capped(list: UndoEntry[]): UndoEntry[] {
    // Drops the OLDEST, not the newest: shift() over the front of the array,
    // which holds the entries pushed longest ago.
    while (list.length > cap) list.shift();
    return list;
  }

  return {
    push(entry: UndoEntry): void {
      undo.push(entry);
      capped(undo);
      redo = [];
    },
    takeUndo(): UndoEntry | null {
      return undo.pop() ?? null;
    },
    takeRedo(): UndoEntry | null {
      return redo.pop() ?? null;
    },
    pushRedo(entry: UndoEntry): void {
      redo.push(entry);
      capped(redo);
    },
    pushUndoFromRedo(entry: UndoEntry): void {
      undo.push(entry);
      capped(undo);
    },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    undoLabel: () => undo[undo.length - 1]?.label ?? null,
    redoLabel: () => redo[redo.length - 1]?.label ?? null,
    clearRedo(): void {
      redo = [];
    },
  };
}
