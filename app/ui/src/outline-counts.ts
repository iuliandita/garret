// app/ui/src/outline-counts.ts
// How long is this chapter?
//
// The host keeps a per-DOCUMENT word index and only scenes carry documents, so
// a part or a chapter has no count of its own - it has the sum of the scenes
// underneath it, which is the figure a novelist actually asks for. Rolling that
// up is the whole of this module.
//
// IN THE PAGE, NOT THE HOST, and that is a deliberate split. The host owns the
// index because it owns the store; the page owns the TREE, because the walk is
// what it already holds and re-deriving parent chains in Rust would be a second
// implementation of a shape the page has in front of it. The host answers "how
// many words is this document", the page answers "and what is it inside".
import type { ProjectItem } from "./store/source";
import { formatNumber } from "./i18n";

/** What the host reported, per item id. An id ABSENT from this map is a
 *  document that could not be counted, which is not the same as a document of
 *  zero words - and the difference is why the map is sparse rather than
 *  defaulted. */
export type DocumentCounts = Readonly<Record<string, number>>;

/** The statistics panel's on-demand projection. Like the word-only map, it is
 *  sparse: an absent document is unknown, while all three zeroes are measured. */
export interface DocumentStatistics {
  readonly words: number;
  readonly sentences: number;
  readonly paragraphs: number;
}

export type DocumentStatisticsCounts = Readonly<Record<string, DocumentStatistics>>;

/** The count to show against each row, containers included.
 *
 *  A container's entry is the sum of every countable scene in its subtree. An
 *  item with nothing countable underneath it gets NO entry rather than a zero,
 *  for the same reason the host's map is sparse: a chapter whose scenes are all
 *  unreadable has an unknown length, and printing 0 beside it would be a claim
 *  nobody can support. A scene the writer has genuinely emptied DOES have a
 *  countable body, so it is 0 in the host's map and 0 here.
 *
 *  ONE PASS over the walk, backwards. `items()` is depth-first, so every
 *  descendant appears AFTER its parent - walking from the end and adding each
 *  item's total into its parent therefore accumulates a whole subtree before
 *  the parent is reached. The obvious implementation walks ancestor chains per
 *  item, which is O(n * depth) over a 20,060-row walk on a surface that
 *  repaints after every flush.
 */
export function rollUpCounts(
  items: readonly ProjectItem[],
  perDoc: DocumentCounts,
): Map<string, number> {
  return rollUpMetric(items, perDoc, (count) => count);
}

/** Roll one metric of the sparse document projection up the depth-first walk. */
export function rollUpMetric<T>(
  items: readonly ProjectItem[],
  perDoc: Readonly<Record<string, T>>,
  metric: (count: T) => number,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    const own = Object.prototype.hasOwnProperty.call(perDoc, item.id)
      ? perDoc[item.id]
      : undefined;
    // The subtree's total, already accumulated by the descendants this loop has
    // passed, plus whatever this item carries itself.
    const below = totals.get(item.id);
    let total = below;
    if (own !== undefined) total = (total ?? 0) + metric(own);
    if (total === undefined) continue;
    totals.set(item.id, total);
    const parent = item.parent_id;
    if (parent !== null) totals.set(parent, (totals.get(parent) ?? 0) + total);
  }
  return totals;
}

/** The count as a row shows it.
 *
 *  Grouped, because five figures unseparated is a number a reader has to count
 *  the digits of. `formatNumber` rather than a hand-rolled separator: the
 *  language the writer chose decides (090), and this is one of the few places
 *  in the application where it can without a rule of ours drifting from it.
 *
 *  An absent count renders as NOTHING, not as a dash and not as a zero. The row
 *  is a title first; a marker for "unknown" on every row of a manuscript whose
 *  index has not arrived yet is noise, and the state it describes lasts a few
 *  hundred milliseconds after a project opens.
 */
export function formatCount(count: number | undefined): string {
  if (count === undefined) return "";
  return formatNumber(count);
}
