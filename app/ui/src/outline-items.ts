import { RESERVED_ROOT_TYPES } from "./item-types";
import type { ProjectItem } from "./store/source";

/** The walk with EVERY reserved section removed: the bin, the bible, and both
 *  matter sections. What the CHAPTER SEQUENCE is.
 *
 *  A THIRD FILTER, and it exists because the second one stopped being enough the
 *  moment front matter joined the book. `manuscriptItemsIn` answers "what does
 *  this book contain", and front matter is in that answer. This one answers
 *  "what is the book's structure", and a dedication is not structure: it has no
 *  chapter number, it is not adopted into a part, and it must not decide whether
 *  a book already has one.
 *
 *  The concrete defect this exists to prevent is restored by a fourth
 *  root: a `part` a writer parked in their front matter would satisfy
 *  `planAdoption`'s "this book already has a part" and suppress adoption for the
 *  life of the manuscript. Pinned by `placement.test.ts`. */
export function chapterItemsIn(items: readonly ProjectItem[]): ProjectItem[] {
  return itemsExcludingRoots(items, RESERVED_ROOT_TYPES);
}

/** One forward pass dropping every named root and its whole subtree.
 *
 *  FIRST ROOT OF EACH TYPE ONLY, matching the host's `root_subtree_ids`, so a
 *  nested or duplicate row of one of those types is an ordinary book row.
 *  The first draft keyed on the type alone,
 *  which is what the bin's version did -- correct only because nothing could
 *  produce a nested bin, and no longer correct once a second type joined it. */
export function itemsExcludingRoots(
  items: readonly ProjectItem[],
  types: readonly string[],
): ProjectItem[] {
  const dropped = new Set<string>();
  const usedRoots = new Set<string>();
  const out: ProjectItem[] = [];
  for (const item of items) {
    const parent = item.parent_id;
    const firstRoot = parent === null && types.includes(item.type) && !usedRoots.has(item.type);
    if (firstRoot) usedRoots.add(item.type);
    if (firstRoot || (parent !== null && dropped.has(parent))) {
      dropped.add(item.id);
      continue;
    }
    out.push(item);
  }
  return out;
}
