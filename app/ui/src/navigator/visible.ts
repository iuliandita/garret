// app/ui/src/navigator/visible.ts
// The visible-row projection, pure and DOM-free. Given the store's depth-first
// walk and a set of collapsed ids, produce the rows a tree should render and
// the ARIA arithmetic each one needs.
//
// Separate and separately tested for the same reason visibleRange is: a
// collapse that hides one row too many, or a setsize computed over the visible
// list instead of the sibling group, is an accessibility defect that no latency
// gate would ever notice.

export interface TreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  title: string;
  /** The store's item type - "part", "chapter", "scene" and whatever else the
   *  schema grows. The navigator paints it as `data-type` so the outline shows
   *  WHAT each row is as well as how deep it sits.
   *
   *  Optional, and absent rather than defaulted: a corpus source has no tree and
   *  no types, exactly as it has no depth. A default would tell the stylesheet
   *  every row of a corpus is a scene, which is a claim nobody made. */
  itemType?: string;
  /** The store's revision state for this row, or null for the default.
   *
   *  Optional AND nullable, which are two different absences: `undefined` is a
   *  source that cannot answer (the corpus path has no items), `null` is a row
   *  the writer has not marked. The navigator draws nothing for either, so
   *  collapsing them would cost nothing today and would make the day a source
   *  reports a state per row indistinguishable from the day it reports none. */
  state?: string | null;
}

export interface VisibleRow extends TreeNode {
  /** 1-based index within this row's OWN sibling group. */
  posinset: number;
  /** Size of this row's own sibling group. Not the visible row count. */
  setsize: number;
  /** Branch nodes get aria-expanded; a leaf carrying it claims children it
   *  does not have. */
  hasChildren: boolean;
  expanded: boolean;
}

type GroupKey = string | null;

export function project(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): VisibleRow[] {
  const groupSize = new Map<GroupKey, number>();
  const groupIndex = new Map<GroupKey, number>();
  const seen = new Set<string>();

  // Ids must be unique: a repeat merges two sibling groups under one key, which
  // corrupts setsize on both and makes one collapsed id collapse two unrelated
  // nodes. Rejecting it is also what makes a hidden row provably unable to
  // share a group with a visible one, which is why posinset may be counted
  // before the visibility check below.
  for (const n of nodes) {
    if (seen.has(n.id)) throw new Error(`project: duplicate node id ${n.id}`);
    seen.add(n.id);
    groupSize.set(n.parentId, (groupSize.get(n.parentId) ?? 0) + 1);
  }

  const rows: VisibleRow[] = [];
  // Depth of the shallowest collapsed ancestor currently hiding rows. Walk
  // order is depth-first, so everything deeper than a collapsed node is its
  // descendant until a row at or above that depth appears.
  let hiddenBelow: number | null = null;
  // path[d] is the id of the ancestor at depth d in the walk so far. Hiding by
  // depth is only equivalent to hiding by ancestry while the input really is a
  // depth-first walk, so check it rather than mis-hide rows silently.
  const path: string[] = [];

  for (const n of nodes) {
    // Depth first: a hole in the walk (or a negative depth) must fail here, or
    // a root arriving at depth 3 reads as a descendant and gets hidden by a
    // collapse it has nothing to do with.
    if (!Number.isInteger(n.depth) || n.depth < 0 || n.depth > path.length) {
      throw new Error(
        `project: not a depth-first walk (node ${n.id} has depth ${n.depth}, walk is ${path.length} deep)`,
      );
    }
    const expectedParent = n.depth === 0 ? null : path[n.depth - 1]!;
    if (expectedParent !== n.parentId) {
      throw new Error(
        `project: not a depth-first walk (node ${n.id} at depth ${n.depth} claims parent ` +
          `${n.parentId ?? "null"}, walk gives ${expectedParent ?? "null"})`,
      );
    }
    path.length = n.depth;
    path.push(n.id);

    // Counted before the visibility check: posinset numbers the row's whole
    // sibling group, which setsize also counts, hidden members included.
    const posinset = (groupIndex.get(n.parentId) ?? 0) + 1;
    groupIndex.set(n.parentId, posinset);

    if (hiddenBelow !== null) {
      if (n.depth > hiddenBelow) continue;
      hiddenBelow = null;
    }

    const hasChildren = (groupSize.get(n.id) ?? 0) > 0;
    const isCollapsed = hasChildren && collapsed.has(n.id);
    rows.push({
      ...n,
      posinset,
      // Every node counted its own group above, so the key exists; assert
      // rather than fall back to a plausible-looking setsize of 1.
      setsize: groupSize.get(n.parentId)!,
      hasChildren,
      expanded: hasChildren && !isCollapsed,
    });
    if (isCollapsed) hiddenBelow = n.depth;
  }

  return rows;
}
