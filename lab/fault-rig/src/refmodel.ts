// lab/fault-rig/src/refmodel.ts
import { createHash } from "node:crypto";
import type { EditOp, ProjectState } from "./model";

export function emptyState(): ProjectState {
  return { scenes: {}, order: [], assets: {}, version: 0 };
}

// Pure: returns a new state, never mutates the input. This is the single
// source of truth every backend must reproduce on reopen.
export function applyPure(state: ProjectState, op: EditOp): ProjectState {
  const next: ProjectState = {
    scenes: { ...state.scenes },
    order: [...state.order],
    assets: { ...state.assets },
    version: state.version,
  };
  switch (op.kind) {
    case "type": {
      const id = op.sceneId!;
      next.scenes[id] = (next.scenes[id] ?? "") + (op.text ?? "");
      if (!next.order.includes(id)) next.order.push(id);
      break;
    }
    case "reorder": {
      const [moved] = next.order.splice(op.fromOrder!, 1);
      if (moved !== undefined) next.order.splice(op.toOrder!, 0, moved);
      break;
    }
    case "import-asset":
      next.assets[op.assetName!] = op.assetHash!;
      break;
    case "migrate":
      next.version += 1;
      break;
    case "snapshot":
      break; // durability barrier only; no state change
  }
  return next;
}

// Canonical hash independent of object key insertion order.
export function hashState(state: ProjectState): string {
  const canonical = {
    scenes: Object.keys(state.scenes).sort().map((k) => [k, state.scenes[k]]),
    order: state.order,
    assets: Object.keys(state.assets).sort().map((k) => [k, state.assets[k]]),
    version: state.version,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Fold a workload into the ordered list of ref-states [s0, s1, ... sN] where
// s0 is the starting state and sK is the state after ops[0..K-1].
export function refStates(
  start: ProjectState,
  ops: EditOp[],
): ProjectState[] {
  const states: ProjectState[] = [start];
  let cur = start;
  for (const op of ops) {
    cur = applyPure(cur, op);
    states.push(cur);
  }
  return states;
}
