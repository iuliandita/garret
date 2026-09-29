// app/harness/src/context-placement.ts
// Where 027 says a new item lands, restated for the rig from the store's
// walk. The harness restates rules rather than importing the page's
// `placement.ts`: a drift between the two is a failing gate, an import
// would make the gate a fact about itself.
export interface PlacedRow {
  id: string;
  parent_id: string | null;
  type: string;
  /** The store's fractional-index key: a base-62 string ("000G", "000W",
   *  "001C") that sorts correctly as TEXT under SQLite's default BINARY
   *  collation. Not a number, and never parsed as one -- see
   *  app/shell-tauri/src-tauri/src/store/position.rs. */
  position: string;
}

/** Holders in preference order; a part has none and belongs at the root. */
const HOLDERS: Readonly<Record<string, readonly string[]>> = {
  part: [],
  chapter: ["part"],
  scene: ["chapter", "part"],
};

/** Root-level types `placement.ts`'s `isReservedRoot` treats as not-the-
 *  manuscript: the bin, the bible, front matter, back matter. Restated here
 *  (never imported from app/ui/src/item-types.ts) for the same reason the
 *  rest of this module restates 027's rule instead of importing it: a drift
 *  between the two belongs in a failing gate, not in a shared import. */
const RESERVED_ROOT_TYPES: readonly string[] = ["trash", "bible", "front", "back"];

export interface ExpectedPlacement {
  parentId: string | null;
  /** The sibling the new row must come IMMEDIATELY after, or null for
   *  "append" (the selection is the parent). */
  afterId: string | null;
}

/** Null when the fixture staged an arm this rig chooses not to grade -- the
 *  page still answers in each of these cases, it is only that this
 *  restatement does not hold a single anchor to check it against:
 *   - an unknown type: the page files the new row beside the selection, as
 *     its next sibling, rather than guessing at a holder for a type it does
 *     not know;
 *   - a root-level scene or chapter with no chapter/part above it: the page
 *     roots the new row after the selection's own top-level ancestor;
 *   - no holder anywhere in the selection's chain: the page BUILDS one (a
 *     scene created in a bare part gets a chapter) and files the new row
 *     inside it.
 *  Also null when the selection sits under a reserved root (the bin, the
 *  bible, front matter, back matter): a selection there is no more an
 *  anchor for the manuscript than one inside the bin, per `isReservedRoot`. */
export function expectedPlacement(
  rows: readonly PlacedRow[],
  selectedId: string,
  itemType: string,
): ExpectedPlacement | null {
  const holders = HOLDERS[itemType];
  if (holders === undefined) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const selected = byId.get(selectedId);
  if (selected === undefined) return null;
  // Ancestor-or-self chain, selection first.
  const chain: PlacedRow[] = [];
  for (let cur: PlacedRow | undefined = selected; cur !== undefined; cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id)) {
    chain.push(cur);
  }
  const top = chain[chain.length - 1]!;
  if (top.parent_id === null && RESERVED_ROOT_TYPES.includes(top.type)) return null;
  if (holders.length === 0) {
    // A part: the root, after the selection's top-level ancestor -- but only
    // when the chain actually REACHED the root. A chain that stopped because
    // a parent row is missing from `rows` never got there, and has no
    // top-level ancestor to name.
    if (top.parent_id !== null) return null;
    return { parentId: null, afterId: top.id };
  }
  for (const holder of holders) {
    const idx = chain.findIndex((r) => r.type === holder);
    if (idx === -1) continue;
    const parent = chain[idx]!;
    if (idx === 0) return { parentId: parent.id, afterId: null }; // the selection IS the parent: append
    return { parentId: parent.id, afterId: chain[idx - 1]!.id };
  }
  return null;
}

/** True when `created` sits where `expected` says: same parent, and its
 *  position key comes IMMEDIATELY after `afterId`'s key in sibling order (or
 *  last among siblings, for append). Keys compare as STRINGS -- the same
 *  BINARY collation SQLite itself sorts them under -- never as numbers. */
export function landedAsExpected(
  rows: readonly PlacedRow[],
  created: PlacedRow,
  expected: ExpectedPlacement,
): boolean {
  const siblings = rows
    .filter((r) => r.parent_id === expected.parentId)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  const at = siblings.findIndex((r) => r.id === created.id);
  if (at === -1) return false;
  if (expected.afterId === null) return at === siblings.length - 1;
  return at > 0 && siblings[at - 1]!.id === expected.afterId;
}
