// app/ui/src/appearances.ts
// Who appears where: the union of a subtree's cast, derived on read.
//
// DERIVED, NOT STORED, and that is the whole shape --
// the short of it: a stored per-container cast
// list would need invalidating on `item_move`, on create, on delete, on restore
// and on the bible's adoption -- five paths -- and that record's own closing line is
// "THERE ARE NOW THREE `replaceDoc` PATHS. A fourth is where this comes back."
//
// IN THE PAGE, NOT THE HOST, which is the split `outline-counts.ts` already
// states: the host owns the JOIN TABLE because it owns the store, and the page
// owns the TREE. The host answers "who is tagged on this item", the page
// answers "and what is it inside".
//
// ONE BACKWARDS PASS, copied from `rollUpCounts` with Set-union in place of
// addition. `items()` is depth-first, so every descendant appears AFTER its
// parent; walking from the end and unioning each item's set into its parent
// therefore accumulates a whole subtree before the parent is reached. The
// ancestor-chain alternative is O(n * depth) over a 20,060-row walk.
import { manuscriptItemsIn } from "./outline";
import type { ProjectItem } from "./store/source";

/** Who the store says is tagged on each item, by item id. An id ABSENT from
 *  this record carries no tags, which is the same answer as an empty list --
 *  unlike the word index, where absent and zero are different claims. */
export type ItemAppearances = Readonly<Record<string, readonly string[]>>;

/** The cast of each item's whole subtree, itself included.
 *
 *  EVERY ITEM IN THE WALK GETS AN ENTRY, and where nobody appears that entry is
 *  an EMPTY SET. This is the one place the module deliberately departs from
 *  `rollUpCounts`, which gives an item with nothing countable underneath it no
 *  entry at all because "printing 0 beside it would be a claim nobody can
 *  support". A word count can be UNKNOWN -- a body that could not be read. A
 *  cast cannot: nobody has been tagged is a true and complete answer, and a
 *  sparse map would make every caller decide for itself whether `undefined`
 *  meant "nobody" or "do not know".
 *
 *  A CONTAINER'S OWN TAGS COUNT TOO. Tagging a chapter directly is allowed --
 *  see the panel and the write-back -- so the set is this item's own names
 *  UNION everything underneath it, not one or the other. */
export function rollUpAppearances(
  items: readonly ProjectItem[],
  perItem: ItemAppearances,
): Map<string, ReadonlySet<string>> {
  const totals = new Map<string, Set<string>>();
  function setFor(id: string): Set<string> {
    let held = totals.get(id);
    if (held === undefined) {
      held = new Set<string>();
      totals.set(id, held);
    }
    return held;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    // The subtree's cast, already accumulated by the descendants this loop has
    // passed, plus whoever is tagged on this row itself.
    const total = setFor(item.id);
    const own = perItem[item.id];
    if (own !== undefined) for (const member of own) total.add(member);
    const parent = item.parent_id;
    // The WHOLE accumulated set moves up, not just this row's own names: a
    // version that carried `own` alone reaches one hop and no further, and
    // every fixture where the tagged row is a direct child of the row asserted
    // passes against it.
    if (parent !== null) {
      const up = setFor(parent);
      for (const member of total) up.add(member);
    }
  }
  return totals;
}

/** The same rollup over the BOOK, which is the walk minus the bin and the
 *  bible.
 *
 *  THE FILTER IS THE POINT OF THIS FUNCTION and it is not a detail. The
 *  precedent in this tree is split against itself: `refreshCounts` rolls up the
 *  RAW walk, because the navigator paints every row including the bin's, while
 *  `computeStatistics` rolls up `manuscriptItemsIn(...)`, because the
 *  statistics panel describes the book. This surface is the second kind -- it
 *  answers "who appears where in this manuscript" -- so a deleted scene's cast
 *  must leave the book exactly as its words do, and the bible's people must
 *  never have been in it.
 *
 *  DERIVED, LIKE THE WORD COUNT, AND THAT IS WHY NOTHING IS WRITTEN WHEN A
 *  SCENE IS BINNED. Binning is an `item_move` into a root item, not a deletion:
 *  the join rows stay, the ids stay stable, and restoring the scene brings its
 *  cast back with it. What changed was the walk, and the walk is read fresh.
 *
 *  ROOT-LEVEL ONLY, through `manuscriptItemsIn`, so a `trash`- or `bible`-typed
 *  row a writer moved inside a live chapter is a ROW and not a section --
 *  keying on the type alone drops the writer's own work out of their book. */
export function appearancesForBook(
  items: readonly ProjectItem[],
  perItem: ItemAppearances,
): Map<string, ReadonlySet<string>> {
  return rollUpAppearances(manuscriptItemsIn(items), perItem);
}
