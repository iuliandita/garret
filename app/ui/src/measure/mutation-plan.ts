// app/ui/src/measure/mutation-plan.ts
// Plans the mutation phase's store writes and owns the state those writes
// change. Extracted from main.ts, which cannot be imported by a test: it ends in
// `void main()` at module scope, so importing it boots the page. Revision
// tracking and subtree avoidance are the two arguments that were previously
// defended only by a comment and a GUI-only gate.
export type MutationPlan =
  | { kind: "create"; parentId: string; seq: number }
  | { kind: "rename"; id: string; title: string; baseRev: number }
  | { kind: "move"; id: string; newParentId: string; baseRev: number };

/** The subset of a store item the planner needs. Declared here rather than
 *  imported from store/source so planning does not depend on the IPC payload
 *  shape; ProjectItem satisfies it structurally. */
export interface PlannerItem {
  id: string;
  parent_id: string | null;
  rev: number;
  title: string;
}

export interface MutationPlanner {
  /** The nth mutation of the phase. Throws rather than returning a plan the
   *  store is supposed to refuse: a caller-side impossibility is a workload bug,
   *  and reporting it as a store defect is the exact conflation the subtree scan
   *  exists to prevent. */
  plan(n: number): MutationPlan;
  applyRename(id: string, rev: number): void;
  applyMove(id: string, parentId: string | null, rev: number): void;
}

export function createMutationPlanner(items: readonly PlannerItem[]): MutationPlanner {
  const withChildren = new Set(
    items.map((i) => i.parent_id).filter((p): p is string => p !== null),
  );
  const branches = items.filter((i) => withChildren.has(i.id));
  if (branches.length < 2) {
    throw new Error("mutation phase needs at least two branch items to move between");
  }

  const parentOf = new Map(items.map((i) => [i.id, i.parent_id] as const));
  // Revisions are TRACKED, not guessed: rename and move both bump rev, so a
  // fixed baseRev conflicts on the second mutation of any item.
  const revs = new Map(items.map((i) => [i.id, i.rev] as const));

  const revOf = (id: string): number => {
    const rev = revs.get(id);
    if (rev === undefined) throw new Error(`no tracked revision for ${id}`);
    return rev;
  };

  const isSelfOrDescendant = (candidate: string, ofId: string): boolean => {
    let at: string | null = candidate;
    // Bounded by the item count: a parent cycle would otherwise hang the page
    // silently, which looks exactly like a slow run.
    for (let hops = 0; at !== null && hops <= items.length; hops++) {
      if (at === ofId) return true;
      at = parentOf.get(at) ?? null;
    }
    return false;
  };

  return {
    plan(n: number): MutationPlan {
      if (n % 3 === 0) {
        return { kind: "create", parentId: branches[n % branches.length]!.id, seq: n };
      }
      if (n % 3 === 1) {
        const target = items[n % items.length]!;
        return {
          kind: "rename",
          id: target.id,
          title: `${target.title} (r${n})`,
          baseRev: revOf(target.id),
        };
      }
      const target = branches[(n + 1) % branches.length]!;
      // DELIBERATE, do not simplify to `branches[n % branches.length]`: that
      // destination can be the moved item itself or one of its own descendants,
      // and item_move refuses such a move BY DESIGN. Scanning for a destination
      // outside the target's subtree keeps every issued mutation one the store is
      // supposed to accept, which is what lets the gate hold mutation_errors at 0
      // and read a non-zero count as a real defect rather than as the workload
      // misusing the API. Skipping illegal candidates costs no mutations: one is
      // still issued per n.
      for (let k = 0; k < branches.length; k++) {
        const candidate = branches[(n + k) % branches.length]!;
        if (!isSelfOrDescendant(candidate.id, target.id)) {
          return {
            kind: "move",
            id: target.id,
            newParentId: candidate.id,
            baseRev: revOf(target.id),
          };
        }
      }
      throw new Error(`no legal new parent for ${target.id}: every branch is inside its subtree`);
    },
    applyRename(id: string, rev: number): void {
      revOf(id); // an ack for an item the planner never saw is a caller bug
      revs.set(id, rev);
    },
    applyMove(id: string, parentId: string | null, rev: number): void {
      revOf(id); // an ack for an item the planner never saw is a caller bug
      revs.set(id, rev);
      parentOf.set(id, parentId);
    },
  };
}
