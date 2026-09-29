// app/ui/src/placement.ts
// Where a new part, chapter or scene lands.
//
// THIS OVERTURNS THE PRIOR RULE OF THE OUTLINE-EDITING DESIGN, deliberately.
// The prior rule was "a new item is created as the last child
// of the selected row", and it named this change's complaint as its own known
// cost: pressing New part with a scene selected put a part INSIDE the scene, and
// nothing a writer could find got it back out.
//
// That rule's second justification was that product spec section 6 forbids type-based
// containment rules -- parts, chapters and scenes form an arbitrary hierarchy and
// "no type constrains another's parent". THAT IS STILL TRUE AND IS NOT WEAKENED
// HERE. Nothing below forbids anything: every item can still be moved anywhere,
// a part can still live inside a scene if a writer puts it there, and the store
// enforces no types at all. What depends on types is only where a new item
// LANDS when the writer has not said. A default is not a constraint.
//
// The rule, in one sentence each way:
//
//   TARGET PARENT is the nearest ancestor-or-self of the selection that
//   conventionally holds this type -- a part for a chapter; a chapter, else a
//   part, for a scene; the root for a part. With nothing selected, or nothing
//   suitable above it, the root.
//
//   POSITION is immediately after whichever ancestor-or-self of the selection is
//   a direct child of that target parent. When the selection IS the target
//   parent, the new item is appended as its last child.
//
// The second half is what makes this feel right rather than merely correct: a
// writer working in the third scene of chapter two gets the new chapter after
// chapter two, not at the end of the part.
//
// PURE, and in its own module rather than inside `outline.ts`, for the recorded
// reason `loading.ts` and `flushAnchorsFor` exist: a rule that cannot be reached
// by a test is a rule mutations survive.
import { RESERVED_ROOT_TYPES } from "./item-types";
import type { ProjectItem } from "./store/source";

export interface Placement {
  /** Containers to create BEFORE the item, outermost first, each inside the
   *  one before it and the item inside the last.
   *
   *  EMPTY IN EVERY CASE BUT ONE. A new book holds one scene and no part, so a
   *  chapter had nowhere to live and landed at the root beside the starter
   *  scene -- and the part created next was placed after THAT, appearing below
   *  the chapter it was meant to contain. Reported with a screenshot on
   *  2026-08-27; every step was correct by the rule and the result was three
   *  flat siblings in an order that reads backwards.
   *
   *  A LIST rather than one optional holder, for the reason `HOLDERS` is a
   *  table: the interesting property is that it is at most one TODAY, and a
   *  shape that could only express one would have to be rewritten rather than
   *  extended.
   *
   *  ONE LEVEL, NEVER TWO. A scene in a bare book does not get a chapter and a
   *  part built over it: a flat book of scenes is a book a writer is allowed to
   *  have, and the product spec makes the hierarchy arbitrary on purpose. Two
   *  rows from one press is the most this rule will ever produce. */
  holders: readonly string[];
  /** null is the root group.
   *
   *  Where the FIRST thing goes -- the outermost holder when there is one,
   *  otherwise the item itself. */
  parentId: string | null;
  /** The row the new item lands AFTER. null appends to the end of the group. */
  afterId: string | null;
}

const AT_ROOT: Placement = { holders: [], parentId: null, afterId: null };

/** Which types conventionally hold which, most specific first.
 *
 *  A TABLE, not a chain of ifs, because the interesting property is that a
 *  scene has TWO fallbacks in order and a chapter has one -- and that ordering
 *  is the thing a later reader is most likely to flatten.
 *
 *  ABSENT is not the same as EMPTY here, and the difference is load-bearing: a
 *  `part` has an empty holder list and belongs at the ROOT, while a type this
 *  table has never heard of belongs BESIDE THE SELECTION. The store accepts any
 *  type string, so a newer build's fourth type must arrive here as data rather
 *  than as a crash -- and sending it to the root would be this module guessing
 *  about a type it does not know.
 */
const HOLDERS: Readonly<Record<string, readonly string[]>> = {
  part: [],
  chapter: ["part"],
  scene: ["chapter", "part"],
};

/** Types that BUILD the container they are missing rather than falling to the
 *  root.
 *
 *  ONE ENTRY, and the line it draws is between a container and a leaf. A
 *  chapter is a container, and a container with nothing above it is the one
 *  press in this application that cannot produce indentation -- which is the
 *  defect reported on 2026-08-27. A scene is where prose lives, and a flat book
 *  of scenes is a book a writer is allowed to have: building a chapter and a
 *  part over a writer who pressed New scene would answer a request for one row
 *  with three, and would impose a hierarchy the product spec deliberately
 *  leaves arbitrary.
 *
 *  A part is absent because it has no holder to build: it IS the top level. */
const MAKES_ITS_HOLDER = new Set(["chapter"]);

/** What a type needs built when nothing suitable is above the selection.
 *
 *  The NEAREST holder only, never the whole chain: one level is the most a
 *  single press will ever produce. */
function holderFor(itemType: string): readonly string[] {
  if (!MAKES_ITS_HOLDER.has(itemType)) return [];
  const nearest = HOLDERS[itemType]?.[0];
  return nearest === undefined ? [] : [nearest];
}

/** The ancestor chain of `id`, nearest first, INCLUDING `id` itself.
 *
 *  BOUNDED BY THE ITEM COUNT, not by trusting the walk to be a tree. The
 *  store's walk is anchored at `parent_id IS NULL` so it cannot contain a cycle
 *  -- but this function is handed a LIST, and a list is not a promise. A
 *  `while (parent !== null)` that trusts its input spins forever, in the page,
 *  on the writer's machine.
 *
 *  ONE GUARD, not two, and that is the second thing the mutation pass taught
 *  this function. The first draft had a `seen` set AND this bound; each survived
 *  its own mutation because the OTHER still terminated the loop, and the answer
 *  on a cyclic walk is identical either way -- the extra pass around a cycle only
 *  appends a duplicate to the tail, which nothing downstream reads. Two rules
 *  refusing the same input cover for each other, which is a recorded shape here.
 *
 *  Removing THIS bound hangs, and a test that runs to completion cannot catch a
 *  hang. What catches it is the mutation harness's per-run timeout, which now
 *  reports a hang as a kill and says so. That is the honest position for a
 *  termination guard: it is not testable by assertion, and pretending otherwise
 *  by adding a second guard makes both of them untestable instead.
 */
/** Is this row one of the reserved roots -- the bin, the bible, or either
 *  matter section?
 *
 *  `RESERVED_ROOT_TYPES`, NOT `NON_MANUSCRIPT_ROOT_TYPES`, and the distinction
 *  is the whole point. Front matter IS part of the book, so it is not in the
 *  second list -- but it is a SECTION, so a new chapter must no more be filed
 *  after it than after the bible, and a selection inside it is no more an anchor
 *  than a selection inside the bin.
 *
 *  ROOT-LEVEL ONLY, exactly as the host's `root_subtree_ids` is. A row of one of
 *  those types that a writer moved inside a scene is a row they put there, and
 *  treating it as a section would make one hand-moved item change where every
 *  later create lands. */
function isReservedRoot(row: ProjectItem): boolean {
  return row.parent_id === null && RESERVED_ROOT_TYPES.includes(row.type);
}

/** The id of the last root-level row that is NOT a reserved section (the bin,
 *  the bible, or either matter section) -- or `null` when there is none.
 *
 *  THIS IS WHERE THE MANUSCRIPT ENDS, root-group-wide, and it is the only
 *  place `restore()` may land a row: a null `afterId` on `item_move` is FIRST
 *  in the group (store/mod.rs's `moving_to_the_front_uses_a_null_left_neighbour`),
 *  not last, so "the manuscript's end" has to be NAMED except in the one case
 *  where there is no manuscript root to name -- there, first among what is
 *  left over IS the end. */
export function lastManuscriptRootId(items: readonly ProjectItem[]): string | null {
  let lastManuscript: string | null = null;
  for (const row of items) {
    if (row.parent_id !== null) continue;
    if (!isReservedRoot(row)) lastManuscript = row.id;
  }
  return lastManuscript;
}

/** Where "append at the root" actually has to land: `null` to append, or the id
 *  of the last manuscript root when appending would put the row after a
 *  reserved one.
 *
 *  The bin and the bible are roots, and both arrive by appending, so a plain
 *  append puts a new part or scene BELOW the writer's world building and their
 *  deleted work -- at the bottom of the navigator, under two sections that are
 *  not the book. Before this slice the bin was the only such root and existed
 *  only after a delete; the bible is visible from the press that makes it, so
 *  the shape stopped being rare.
 *
 *  `null` WHENEVER APPENDING IS ALREADY RIGHT, which is every book with no
 *  reserved root at the end of its root group -- and it is the whole of the
 *  difference between this rule and "always name the last manuscript root". The
 *  two agree on where the row LANDS in every case; they disagree on whether the
 *  create carries an `afterId` that could name a row the writer deleted between
 *  the plan and the command. Naming one only when it changes the answer is the
 *  narrower claim. */
function rootAppendPoint(items: readonly ProjectItem[]): string | null {
  let lastRoot: ProjectItem | null = null;
  for (const row of items) {
    if (row.parent_id !== null) continue;
    lastRoot = row;
  }
  if (lastRoot === null || !isReservedRoot(lastRoot)) return null;
  return lastManuscriptRootId(items);
}

function ancestorsOrSelf(items: readonly ProjectItem[], id: string): ProjectItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const chain: ProjectItem[] = [];
  let current = byId.get(id);
  for (let steps = 0; steps <= items.length && current !== undefined; steps++) {
    chain.push(current);
    const parent = current.parent_id;
    current = parent === null ? undefined : byId.get(parent);
  }
  return chain;
}

/** Where a new `itemType` should land, given the walk and what is selected. */
export function planPlacement(
  items: readonly ProjectItem[],
  selectedId: string | null,
  itemType: string,
): Placement {
  // NOTHING SELECTED, or a selection the walk does not contain -- the caller
  // asked about a row that has since gone, which is the same answer. It appends
  // at the root, and it STILL BUILDS THE HOLDER: a chapter created into an
  // empty book with no row selected needs the part exactly as much as one
  // created beside a scene does, and returning `AT_ROOT` here was the first
  // draft's bug.
  //
  // `after` is `undefined` for "wherever the manuscript ends", which is the
  // last root that is not the bin or the bible -- never a plain append, which
  // would land under both of them.
  const rootAnswer = (after?: string | null): Placement => ({
    holders: holderFor(itemType),
    parentId: null,
    afterId: after === undefined ? rootAppendPoint(items) : after,
  });
  if (selectedId === null) return rootAnswer();
  const chain = ancestorsOrSelf(items, selectedId);
  if (chain.length === 0) return rootAnswer();

  const holders = HOLDERS[itemType];
  if (holders === undefined) {
    // A type this module does not know. The conservative answer is the next
    // sibling of the selection: it swallows nothing, and it does not jump to
    // the root on a guess.
    const selected = chain[0]!;
    return { holders: [], parentId: selected.parent_id, afterId: selected.id };
  }
  // Nearest first, and the holder list is consulted in ITS order at each step
  // rather than the chain's: a scene inside a chapter inside a part must find
  // the chapter, and a scene inside a part with no chapter must find the part.
  let targetIndex = -1;
  for (const holder of holders) {
    targetIndex = chain.findIndex((i) => i.type === holder);
    if (targetIndex !== -1) break;
  }

  if (targetIndex === -1) {
    // The root. The new item follows whichever ancestor of the selection sits
    // at the top level -- which is the last link in the chain, since the chain
    // ends at a row with no parent. A chain that ended because its parent was
    // MISSING has no top-level row, and appending is the honest answer there.
    //
    // NOT WHEN THAT TOP-LEVEL ROW IS THE BIBLE OR THE BIN. Those are not the
    // manuscript, so a manuscript row must not be filed after one because the
    // writer happened to be reading their synopsis. Falling through to the
    // manuscript's own end is the same answer this function gives for no
    // selection at all, which is what a selection outside the book is.
    const top = chain[chain.length - 1];
    if (top !== undefined && isReservedRoot(top)) return rootAnswer();
    const rooted = top !== undefined && top.parent_id === null;
    // NOTHING SUITABLE ANYWHERE, so make it. The nearest holder this type
    // conventionally wants is built at the root and the item goes inside it,
    // which is the only way a press can produce the indentation the writer is
    // asking for in a book that has no structure yet.
    //
    // `holders[0]`, not the whole list: one level. A scene wants a chapter and
    // then a part, and building both would answer a press for one row with
    // three.
    return rootAnswer(rooted ? top.id : null);
  }

  // The selection IS the holder: append inside it. There is no ancestor between
  // the two to follow, and putting the new item first would push it above work
  // the writer already has there.
  if (targetIndex === 0) return { holders: [], parentId: chain[0]!.id, afterId: null };

  // Otherwise follow the ancestor one step below the holder, which is the group
  // the writer is currently inside.
  return {
    holders: [],
    parentId: chain[targetIndex]!.id,
    afterId: chain[targetIndex - 1]!.id,
  };
}

/** Which existing rows move INTO an item this press is about to create.
 *
 *  THE RULE, second half: "chapters inside parts, scenes
 *  inside chapters". A new chapter builds the part it needs, and
 *  every new book gets a chapter, so from the first press onward a book has
 *  chapters at the root -- and a part created BESIDE them reads as an empty
 *  container filed below the work it was meant to hold. That is the same
 *  defect reported twice, one press later each time.
 *
 *  A SEPARATE FUNCTION, not a field of `Placement`, because it answers a
 *  different question with a different verb. Placement is where the new row is
 *  CREATED and is computed from the selection's ancestry; adoption is what is
 *  considered for moving afterwards. The caller must also check the proposed
 *  placement with adoptionPreservesOrder before moving any candidate.
 *
 *  ONCE PER BOOK. Adoption fires only when the book has no part at all. A
 *  writer whose manuscript already contains one has shown they know what parts
 *  are, and their next part is an empty container they intend to fill
 *  themselves -- sweeping every loose chapter into it would restructure a book
 *  that is already structured. This application has a structural undo,
 *  and Ctrl+Z is exactly what takes an adoption back, but the bound stays: how
 *  far it reaches is its own decision, not a side effect of undo existing --
 *  a LATER part adopting would move chapters a writer placed by hand, which is
 *  a different question from whether the FIRST one may. The bound is what
 *  makes the rule safe to ship without answering that question first: it can
 *  reshape a manuscript at most once, on the press that first says "parts".
 *
 *  CHAPTERS ONLY, and only homeless ones. A chapter inside a scene is where a
 *  writer put it. A root SCENE stays put too: scenes are optional, a flat book
 *  of scenes is legal, and a part is not a scene's first holder.
 *
 *  @param items the LIVE walk -- the caller strips the bin, because nothing in
 *  it is part of the manuscript and adopting a deleted chapter would carry it
 *  back out of the bin.
 *  @param creating every type this press will create, holders included. Keyed
 *  on the types being CREATED rather than the one the writer asked for, so the
 *  chapter press that builds its own part adopts exactly as the part press
 *  does.
 *  @returns candidate ids in walk order, subject to the placement order check. */
export function planAdoption(
  items: readonly ProjectItem[],
  creating: readonly string[],
): readonly string[] {
  if (!creating.includes("part")) return [];
  if (items.some((i) => i.type === "part")) return [];
  return items.filter((i) => i.parent_id === null && i.type === "chapter").map((i) => i.id);
}

/** Existing root subtrees must keep their order when gathered into a new part.
 * Create's null afterId appends, unlike move's null (first child). */
export function adoptionPreservesOrder(
  items: readonly ProjectItem[],
  adopting: readonly string[],
  place: Placement,
): boolean {
  if (adopting.length === 0) return true;
  if (place.parentId !== null) return false;
  const roots = items.filter((row) => row.parent_id === null).map((row) => row.id);
  const anchor = place.afterId === null ? roots.length - 1 : roots.indexOf(place.afterId);
  if (place.afterId !== null && anchor === -1) return false;
  const adopted = new Set(adopting);
  const projected = [
    ...roots.slice(0, anchor + 1).filter((id) => !adopted.has(id)),
    ...adopting,
    ...roots.slice(anchor + 1).filter((id) => !adopted.has(id)),
  ];
  return projected.length === roots.length && projected.every((id, index) => id === roots[index]);
}
