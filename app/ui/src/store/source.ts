// app/ui/src/store/source.ts
// A FixtureSource over the project store. Identifiers and titles only: the
// navigator never needs bodies, and retaining them is the memory lever
// `lazy-docs` measured at 95 MB. Implementing the SAME interface the corpus
// path uses is what keeps the navigator, its virtualization and its ARIA
// contract untouched by this slice.
import type { FixtureSource } from "../fixture/source";

export interface ProjectItem {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  position: string;
  rev: number;
  /** Where the writer says this item stands: one of `REVISION_STATES`, or null
   *  for the default. NULL IS `none` - the word is never stored and never sent,
   *  so a row that has never been marked and a row marked "none" are one thing.
   *
   *  Typed as `string | null` rather than as `RevisionState | null` because it
   *  is what the HOST said, and a newer build's fifth state must arrive here as
   *  data rather than as a type error. Narrowed at the point of use. */
  state: string | null;
  /** 0 for a root item. Produced by the store's walk, not stored. */
  depth: number;
}

export interface StoreSource extends FixtureSource {
  readonly items: ProjectItem[];
  depthAt(index: number): number;
  /** The row's revision state, which the navigator paints as `data-state` and a
   *  mark. Shaped exactly like `typeAt` and `depthAt`, and for the same reason:
   *  a corpus source has no items and so has nothing to answer with. */
  stateAt(index: number): string | null;
  /** The row's item type, which the navigator paints as `data-type` so a part,
   *  a chapter and a scene are told apart on sight. The store's walk already
   *  carries it; the corpus path has nothing to answer with and omits the
   *  method entirely, exactly as it omits `depthAt`. */
  typeAt(index: number): string;
}

export function storeSourceFrom(items: ProjectItem[], seed: string): StoreSource {
  if (items.length === 0) {
    throw new Error("project has no items: a navigator with no rows would pass every gate vacuously");
  }

  // No filter and no sort. The store's walk is already depth-first, and
  // positions now repeat across parents -- sorting by position here would
  // interleave chapters from different parts into one flat, wrong list.
  // Copied because `count` is snapshotted while `at()` reads live: sharing the
  // caller's array lets a later push desynchronize the two.
  const rows = items.slice();

  function at(index: number): ProjectItem {
    const row = rows[index];
    if (!row) throw new RangeError(`row index ${index} out of range (count ${rows.length})`);
    return row;
  }

  return {
    items: rows,
    count: rows.length,
    seed,
    titleAt: (i) => at(i).title,
    idAt: (i) => at(i).id,
    depthAt: (i) => at(i).depth,
    typeAt: (i) => at(i).type,
    stateAt: (i) => at(i).state,
  };
}

export async function loadStoreSource(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  seed: string,
): Promise<StoreSource> {
  const items = (await invoke("project_items")) as ProjectItem[];
  return storeSourceFrom(items, seed);
}
