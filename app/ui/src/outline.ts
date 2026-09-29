// app/ui/src/outline.ts
// Neighbour arithmetic for outline moves: the pure half of "move this row up /
// down / out / in".
//
// The page never computes a position string. `item_move(id, newParentId,
// afterId, baseRev)` takes the LEFT NEIGHBOUR in the destination group and the
// store derives the fractional key from it - its `between`/`after` helpers have
// preconditions (and a documented unsatisfiable pair) that only the store can
// check against the live sibling group. So this module's whole output is two
// identifiers.
//
// It refuses for two different reasons and the caller must keep them apart.
// "No legal destination" (Alt+Up on the first sibling) is not an error and must
// never reach IPC. A MALFORMED walk - a row naming a parent the walk does not
// contain - is the store and the page disagreeing about the shape of the
// manuscript, and reporting it as "nothing to do" makes it invisible. Hence a
// tagged plan rather than a nullable target.
import { t } from "./i18n";
import { bibleParentFor } from "./bible-rows";
import {
  BACK_MATTER_TYPE,
  BIBLE_FOLDER_TYPE,
  BIBLE_TYPE,
  FRONT_MATTER_TYPE,
  MATTER_TYPE,
  NON_MANUSCRIPT_ROOT_TYPES,
  NOTE_TYPE,
  RESERVED_ROOT_TYPES,
  TIMELINE_TYPE,
  TRASH_TYPE,
} from "./item-types";
import { nextNumberedTitle } from "./numbering";
import { createUndoStack, inverseOf, resolveAfter, type UndoStep } from "./outline-undo";
import { adoptionPreservesOrder, lastManuscriptRootId, planAdoption, planPlacement } from "./placement";
import type { ProjectItem } from "./store/source";

export type MoveDirection = "up" | "down" | "outdent" | "indent";

export interface MoveTarget {
  /** null means the root group. */
  newParentId: string | null;
  /** The row the item lands AFTER. null means first child. */
  afterId: string | null;
}

export type PrintSection = "front" | "body" | "back" | "outside";

export interface SectionChange {
  count: number;
  from: PrintSection;
  to: PrintSection;
}

/** Compare the actual section membership on both sides of a planned move.
 *  The store owns positions, but section membership only needs parent links
 *  and the order of root siblings. */
export function sectionChange(
  items: readonly ProjectItem[], id: string, target: MoveTarget,
): SectionChange | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const moving = byId.get(id);
  if (!moving) return null;
  const oldRoots = items.filter((item) => item.parent_id === null).map((item) => item.id);
  const newRoots = oldRoots.filter((root) => root !== id);
  if (target.newParentId === null) {
    const position = target.afterId === null ? 0 : newRoots.indexOf(target.afterId) + 1;
    if (position <= 0 && target.afterId !== null) return null;
    newRoots.splice(position, 0, id);
  }
  const anchors = (roots: string[]): Record<string, string | undefined> => {
    const found: Record<string, string | undefined> = {};
    for (const root of roots) {
      const type = byId.get(root)?.type;
      if (type && found[type] === undefined) found[type] = root;
    }
    return found;
  };
  const oldAnchors = anchors(oldRoots);
  const newAnchors = anchors(newRoots);
  const section = (rowId: string, found: Record<string, string | undefined>, changed: boolean): PrintSection => {
    let root = rowId;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(root)) return "outside";
      seen.add(root);
      const row = byId.get(root);
      if (!row) return "outside";
      const parent = changed && root === id ? target.newParentId : row.parent_id;
      if (parent === null) break;
      root = parent;
    }
    if (root === found[FRONT_MATTER_TYPE]) return "front";
    if (root === found[BACK_MATTER_TYPE]) return "back";
    if (root === found[BIBLE_TYPE] || root === found[TRASH_TYPE]) return "outside";
    return "body";
  };
  const from = section(id, oldAnchors, false);
  const to = section(id, newAnchors, true);
  const count = items.filter((item) => section(item.id, oldAnchors, false) !== section(item.id, newAnchors, true)).length;
  return count === 0 ? null : { count, from, to };
}

/** Siblings in WALK ORDER. The store's walk is depth-first and each sibling
 *  group is already emitted in position order, so descendants interleaving
 *  between two siblings cannot disturb the siblings' relative order. Sorting by
 *  `position` here would be the page second-guessing a key it does not own. */
function siblingsOf(items: ProjectItem[], parentId: string | null): ProjectItem[] {
  return items.filter((i) => i.parent_id === parentId);
}

/** Place the first front and back section roots where their contents print.
 *  Subtrees remain contiguous; duplicate and nested section types stay in the
 *  ordinary run, matching the store's first-root book walk. */
export function readingOrderItems(
  items: readonly ProjectItem[],
  sectionRoots: readonly ProjectItem[] = items,
): ProjectItem[] {
  const groups: ProjectItem[][] = [];
  for (const item of items) {
    if (item.parent_id === null || groups.length === 0) groups.push([item]);
    else groups[groups.length - 1]!.push(item);
  }
  const first = (type: string): number => {
    const id = sectionRoots.find((item) => item.parent_id === null && item.type === type)?.id;
    return groups.findIndex((group) => group[0]?.id === id);
  };
  const front = first(FRONT_MATTER_TYPE);
  const back = first(BACK_MATTER_TYPE);
  const bible = first(BIBLE_TYPE);
  const trash = first(TRASH_TYPE);
  const special = new Set([front, back, bible, trash].filter((index) => index >= 0));
  const order = [
    ...(front >= 0 ? [groups[front]!] : []),
    ...groups.filter((_, index) => !special.has(index)),
    ...(back >= 0 ? [groups[back]!] : []),
    ...groups.filter((_, index) => index === bible || index === trash),
  ];
  return order.flat();
}

export type MovePlan =
  | { kind: "move"; target: MoveTarget }
  /** Nothing to do. Not an error, and no IPC. */
  | { kind: "inert" }
  /** The walk contradicts itself. The caller must report this. */
  | { kind: "malformed"; reason: string };

const moveTo = (newParentId: string | null, afterId: string | null): MovePlan => ({
  kind: "move",
  target: { newParentId, afterId },
});
const INERT: MovePlan = { kind: "inert" };

/** The catalog pattern a new item of `itemType` is named from.
 *
 *  A LOOKUP WITH A FALLBACK, not `t("item.numbered." + itemType)` directly: a
 *  type this build has no pattern for would otherwise be named with the visible
 *  key -- `item.numbered.note` painted into the writer's outline, which is
 *  exactly the failure the localization slice's fallback-then-visible-key rule
 *  produces and exactly the wrong place for it. Falling back to the scene's
 *  pattern names the row something a person can read and rename.
 */
function numberPattern(itemType: string): string {
  switch (itemType) {
    case "part":
      return t("item.numbered.part");
    case "chapter":
      return t("item.numbered.chapter");
    case NOTE_TYPE:
      return t("item.numbered.note");
    case BIBLE_FOLDER_TYPE:
      return t("item.numbered.bible-folder");
    default:
      return t("item.numbered.scene");
  }
}

export function planMove(
  items: ProjectItem[],
  id: string,
  direction: MoveDirection,
): MovePlan {
  const row = items.find((i) => i.id === id);
  // Inert rather than malformed: the walk is not contradicting itself, the
  // caller asked about a row it does not contain. `move()` checks for that
  // before it plans and reports it there, with the message it deserves.
  if (!row) return INERT;

  const parentId = row.parent_id;
  const sibs = siblingsOf(parentId === null ? readingOrderItems(items) : items, parentId);
  const idx = sibs.findIndex((i) => i.id === id);
  const firstReserved = (candidate: ProjectItem): boolean =>
    candidate.parent_id === null &&
    [...RESERVED_ROOT_TYPES, ...NON_MANUSCRIPT_ROOT_TYPES].includes(candidate.type) &&
    items.find((item) => item.parent_id === null && item.type === candidate.type)?.id === candidate.id;
  const isFirstSection = firstReserved(row) &&
    (row.type === FRONT_MATTER_TYPE || row.type === BACK_MATTER_TYPE);

  switch (direction) {
    case "up": {
      if (isFirstSection) return INERT;
      if (idx <= 0) return INERT;
      if (parentId === null) {
        const previous = sibs[idx - 1]!;
        if (firstReserved(previous)) return INERT;
        const raw = siblingsOf(items, null);
        const rawIndex = raw.findIndex((item) => item.id === previous.id);
        return moveTo(null, rawIndex > 0 ? raw[rawIndex - 1]!.id : null);
      }
      // Two back, not one. `afterId` names the row the item follows, so to sit
      // ABOVE sibs[idx-1] it must follow sibs[idx-2] - and at idx 1 there is
      // nothing left to follow, which is the null case rather than an error.
      return moveTo(parentId, idx >= 2 ? sibs[idx - 2]!.id : null);
    }
    case "down": {
      if (isFirstSection) return INERT;
      if (idx >= sibs.length - 1) return INERT;
      if (parentId === null) {
        const next = sibs[idx + 1]!;
        if (firstReserved(next)) return INERT;
        return moveTo(null, next.id);
      }
      return moveTo(parentId, sibs[idx + 1]!.id);
    }
    case "outdent": {
      if (parentId === null) return INERT;
      const parent = items.find((i) => i.id === parentId);
      // A walk that names a parent it does not contain is malformed; refusing
      // beats guessing a destination from it, and saying so beats silence.
      if (!parent) {
        return { kind: "malformed", reason: t("outline.reason.parent-missing", { parentId }) };
      }
      // Land immediately after the old parent, in the grandparent's group -
      // which is what "one level out, same place in the manuscript" means.
      return moveTo(parent.parent_id, parentId);
    }
    case "indent": {
      if (idx <= 0) return INERT;
      const prev = sibs[idx - 1]!;
      const children = siblingsOf(items, prev.id);
      const last = children[children.length - 1];
      return moveTo(prev.id, last ? last.id : null);
    }
  }
}

/** applied: the store changed and the navigator has been repainted from it.
 *  inert:   nothing to do, and deliberately no IPC.
 *  failed:  reported through onFailure; the caller does nothing further. */
export type OutlineOutcome = "applied" | "inert" | "failed";

/** The bin's title. Only ever read by a human. */
export const TRASH_TITLE = t("outline.trash-title");

/** The bible's title, on the same terms: the page creates the section and
 *  supplies the name, and every rule on both sides keys on the TYPE. */
export const BIBLE_TITLE = t("outline.bible-title");

/** The four kinds of matter document.
 *
 *  A UNION OF FOUR WORDS rather than four methods, because the four differ in
 *  exactly two values and a method each would be four copies of one body. */
export type MatterKind = "dedication" | "foreword" | "acknowledgements" | "afterword";

/** WHICH SECTION EACH KIND GOES IN, and it is the only place that decision is
 *  written down.
 *
 *  Conventional trade order, and the writer is not held to it: a document moves
 *  between the sections with Alt+Up and Alt+Down like any other row, and the
 *  export follows the section it ends up in. A dedication and a foreword come
 *  before the book; an afterword and the acknowledgements come after it.
 *
 *  The titles carry NO `{n}`: see `createMatter`. */
const MATTER_KINDS: Readonly<
  Record<MatterKind, { section: string; sectionTitle: () => string; title: () => string }>
> = {
  dedication: {
    section: FRONT_MATTER_TYPE,
    sectionTitle: () => t("outline.front-matter-title"),
    title: () => t("item.matter.dedication"),
  },
  foreword: {
    section: FRONT_MATTER_TYPE,
    sectionTitle: () => t("outline.front-matter-title"),
    title: () => t("item.matter.foreword"),
  },
  acknowledgements: {
    section: BACK_MATTER_TYPE,
    sectionTitle: () => t("outline.back-matter-title"),
    title: () => t("item.matter.acknowledgements"),
  },
  afterword: {
    section: BACK_MATTER_TYPE,
    sectionTitle: () => t("outline.back-matter-title"),
    title: () => t("item.matter.afterword"),
  },
};

/** Is this the bin, or anything inside it, at any depth?
 *
 *  An ANCESTOR WALK, not a `parent_id === bin` check: the bin's contents keep
 *  their own children, so a scene inside a deleted chapter is a grandchild of
 *  the bin, and it is a visible, selectable row a writer can act on.
 *
 *  Bounded by the walk's length rather than trusting the chain to terminate.
 *  The store detects cycles and refuses to walk one, so this loop cannot meet
 *  one today; the bound costs nothing and does not depend on that staying true.
 *
 *  A free function over an EXPLICIT walk, not a method, because the two callers
 *  need it against two different walks. The unit answers from the walk it last
 *  committed; the page has to answer from the walk a reload is still carrying,
 *  since `refresh` hands the new items to the page BEFORE it commits them (a
 *  reload can throw, and this unit must not plan against a tree the navigator
 *  rejected). Reading the unit's copy from inside a reload therefore answers
 *  about the tree that was on screen a moment ago - which put "Delete" on a row
 *  that had just been deleted, and only the graded run could see it. */
export function isTrashedIn(items: readonly ProjectItem[], id: string): boolean {
  let cursor: string | null = id;
  for (let step = 0; step <= items.length && cursor !== null; step++) {
    const row: ProjectItem | undefined = items.find((i) => i.id === cursor);
    if (!row) return false;
    if (row.type === TRASH_TYPE) return true;
    cursor = row.parent_id;
  }
  return false;
}

/** The walk with the bin and everything in it removed.
 *
 *  ONE PASS, not `isTrashedIn` per row. That function walks an item's ancestor
 *  chain with a linear `find` at every step, which is fine for the one row the
 *  outline bar is labelling and is O(n * depth) over a whole walk - at `stress`
 *  that is 20,060 rows on a surface a writer types into. Because `items()` is a
 *  depth-first walk, every descendant of a trash root appears after it and after
 *  its own parent, so one forward pass carrying a set of excluded ids is enough.
 *
 *  The host already does this for search, export and the word count, by deriving
 *  the excluded set from the walk rather than storing a deleted flag. This is the
 *  page's restatement of the same rule, for the surfaces the page filters itself.
 */
export function liveItemsIn(items: readonly ProjectItem[]): ProjectItem[] {
  return itemsExcludingRoots(items, [TRASH_TYPE]);
}

/** The walk with the bin AND the bible removed. What the BOOK is.
 *
 *  The distinction from `liveItemsIn` is a PRODUCT one and it is why both
 *  exist. Quick open keeps the bible, because a writer who cannot reach their
 *  synopsis by keyboard has a section they can only get to by scrolling; the
 *  statistics panel does not, because a synopsis is not a chapter and rolling
 *  its words into `manuscript` would make the panel disagree with the bar. The
 *  host draws the same line in the same two places (`without_trashed` for
 *  search, `manuscript_items` for export and the mirror). */
export function manuscriptItemsIn(items: readonly ProjectItem[]): ProjectItem[] {
  return readingOrderItems(itemsExcludingRoots(items, NON_MANUSCRIPT_ROOT_TYPES), items);
}

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
 *  The concrete defect this exists to prevent is 033's, restored by a fourth
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
function itemsExcludingRoots(
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

export interface OutlineDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Hands the freshly read walk to the navigator. */
  reload: (items: ProjectItem[]) => void;
  /** The row the writer has selected, or null. */
  selectedId: () => string | null;
  /** A row this unit just created, once the navigator holds it.
   *
   *  THE SELECTION HAS TO FOLLOW THE NEW ROW, and this is not a convenience.
   *  Placement is relative to the selection, so a selection that stays put
   *  makes every create land in the SAME slot -- and three creates in a row
   *  come out in reverse order, each one pushing the last down. Measured on a
   *  live window before this existed: New part, New chapter, New scene produced
   *  Scene, Chapter, Part.
   *
   *  Called after the re-read, so the id names a row the navigator can show. */
  onCreated: (id: string) => void;
  onFailure: (message: string) => void;
  /** A structural undo or redo landed. THE NAME ELEVEN OTHER UNITS USE (wired
   *  to `announce` in `project.ts`), not a name of this unit's own invention:
   *  "Undone: moving s2." is the same class of banner as a save or an export
   *  finishing, not a failure. */
  onDone: (message: string) => void;
  /** Resolve a print-section move before any mutation reaches the store. */
  confirmSectionMove?: (title: string, change: SectionChange) => Promise<boolean>;
  /** The walk the page already read to build the navigator. Seeds this unit's
   *  stored walk at construction, with no IPC: `mountProject` reads the whole
   *  walk through `loadStoreSource` before the navigator exists, and at the
   *  stress fixture that is 20,060 rows - paying for it twice at boot buys
   *  nothing. Empty is legal and means every id is absent until something reads.
   *
   *  NOT a duplicate of `refresh()`. This is construction state; `refresh()` is
   *  an action a caller takes (the graded rig forces a re-read with it). Do not
   *  simplify either into the other. */
  initialItems: readonly ProjectItem[];
}

export interface Outline {
  /** A new item, placed by `planPlacement` relative to `relativeTo` - or to the
   *  SELECTION when it is omitted.
   *
   *  The explicit form exists for the navigator's context menu, which acts on
   *  the row it opened on rather than on whatever is selected when the item
   *  fires - and the selection is read inside the serialized body, so with a
   *  move already in flight the two are genuinely different rows.
   *
   *  NO TITLE ARGUMENT. The title is the next free number for
   *  this type, which is a property of the WALK, and the walk is only
   *  trustworthy inside the serialized body. A caller that passed a title
   *  computed outside it would be numbering against a tree that may already have
   *  changed - the same stale-plan defect the queue exists to remove. */
  create(itemType: string, relativeTo?: string): Promise<OutlineOutcome>;
  /** Create a free-form document in the bible, making the section if the
   *  project has none.
   *
   *  ITS OWN METHOD, not `create("note")`. Every other create is placed by
   *  `planPlacement` from the SELECTION, and a bible document has nothing to do
   *  with what the writer is looking at: it belongs in one section, always, and
   *  reaching that section through a placement rule would mean the same press
   *  landing in the manuscript whenever the selection happened to be there. */
  createNote(): Promise<OutlineOutcome>;
  /** Create a bodyless folder under the selected bible folder, or beside a
   *  selected bible document. Outside the bible, append to its root. */
  createBibleFolder(): Promise<OutlineOutcome>;
  /** Create a timeline in the bible, making the section if the project has
   *  none. `createNote`'s own shape and reason: a timeline belongs in one
   *  section, always, and has nothing to do with what the writer is looking
   *  at. UNNUMBERED, `createMatter`'s reason: `timeline.untitled` is already
   *  the name a writer would give one, and a book with one timeline does not
   *  need it called "Timeline 1". */
  createTimeline(): Promise<OutlineOutcome>;
  /** Create a dedication, a foreword, an acknowledgements page or an afterword,
   *  making its section if the project has none.
   *
   *  ITS OWN METHOD for `createNote`'s reason, and the kind decides the SECTION
   *  rather than the item type: all four are `matter` rows, and where they print
   *  is which section they are in. */
  createMatter(kind: MatterKind): Promise<OutlineOutcome>;
  rename(id: string, title: string): Promise<OutlineOutcome>;
  /** Mark where an item stands, or clear the mark with `null`.
   *
   *  Any item, not only a scene: a writer marks a whole chapter `revising`, and
   *  the product spec makes the hierarchy free-form everywhere else, so a
   *  type check here would be a rule nothing else in the outline has.
   *
   *  `inert` when the item already stands there - the row is re-read on every
   *  panel paint, so pressing the current state again is an ordinary thing to
   *  do and must not cost a write, a rev bump or a reprojection. */
  setState(id: string, state: string | null): Promise<OutlineOutcome>;
  move(id: string, direction: MoveDirection): Promise<OutlineOutcome>;
  /** `count` moves of one row in one direction as ONE undo entry (243): a drag
   *  in the outline table that crosses three siblings is one gesture, and one
   *  Undo puts the row back where the drag found it. Each step is planned
   *  against the walk the step before it re-read, exactly as `count` separate
   *  moves would be; the run stops at the first step that does not apply.
   *  `applied` when any step moved the row. */
  moveBy(id: string, direction: MoveDirection, count: number): Promise<OutlineOutcome>;
  /** Move an item, and everything under it, into the bin.
   *
   *  Nothing is destroyed and nothing is confirmed: the subtree stays in the
   *  store, stays in the navigator under the bin, and a deleted scene stays
   *  readable. What changes is that it leaves the manuscript - the export, the
   *  search and the project word count.
   *
   *  Inert for the bin itself and for anything already inside it. */
  remove(id: string): Promise<OutlineOutcome>;
  /** Move an item, and everything under it, back out of the bin.
   *
   *  The item's original parent was never recorded, so it comes back as the
   *  last item of the manuscript, not where it was. That is the whole of the
   *  promise and the UI says so.
   *
   *  Inert for anything that is not in the bin, and for the bin itself. */
  restore(id: string): Promise<OutlineOutcome>;
  /** Re-read the walk without mutating anything, and hand it to `reload`. The
   *  page does NOT need this at boot - `initialItems` covers that. It exists so
   *  a caller can force the outline back into agreement with the store.
   *
   *  Until the unit has a walk from somewhere, every id is absent and rename and
   *  move fail, correctly: they would otherwise have to invent a base_rev. */
  refresh(): Promise<OutlineOutcome>;
  /** Take back the last structural change this unit landed, or the one
   *  `redo()` last put back. `inert` when the stack is empty - not an error,
   *  the writer just has nothing left to undo.
   *
   *  Reads every `baseRev` from the LIVE walk, never from what was recorded
   *  at push time: the store's own discipline is the only thing
   *  standing between a stale rev and a Conflict, and this unit caches none. */
  undo(): Promise<OutlineOutcome>;
  /** The inverse of `undo()`: replays the change undo just took back. Built
   *  from the reverse `undo()` computed against the live walk the instant
   *  before its own step ran, so this never re-issues the original command -
   *  the row was never deleted, only moved, and redo just moves it back. */
  redo(): Promise<OutlineOutcome>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** What `undo()` would name in its banner, or null with nothing to undo.
   *  Read at PAINT time by the menu and the shortcuts panel, never cached. */
  undoLabel(): string | null;
  redoLabel(): string | null;
  /** The walk this unit last read, or `initialItems` before any read. */
  items(): readonly ProjectItem[];
  /** Stop reporting. Operations already in flight still resolve - nothing can
   *  cancel a store round trip - but neither `reload` nor `onFailure` is called
   *  again, so a create that lands after the project was torn down cannot reach
   *  the destroyed navigator or the next project's page. Idempotent. */
  destroy(): void;
}

/** Every outline mutation is `command -> project_items -> reload`, always in
 *  that order. The unit does hold a walk - it is the only field it has, and
 *  every base_rev is read from it - but it is a copy of what the store last
 *  said, never a projection of what a mutation was expected to do, and nothing
 *  is DERIVED from it that outlives one operation.
 *
 *  That is not just simplicity. The store distinguishes `Conflict` (reload the
 *  rev and retry) from `UnknownItem` (the item is gone, stop), but both flatten
 *  to a plain String at the command boundary, so the page cannot tell them apart
 *  without matching substrings - and getting it backwards means either an
 *  infinite retry loop or a silently dropped edit. A unit that caches no
 *  revision has nothing to retry WITH: on any failure it re-reads and reports,
 *  and the distinction stops mattering. Do not add retry logic. Do not add a rev
 *  cache. */
export function createOutline(deps: OutlineDeps): Outline {
  // The only state in this unit, and it is a copy of what the store last said -
  // never a projection of what a mutation was expected to do.
  //
  // Copied: the caller keeps its own reference to the array it read the
  // navigator from, and every base_rev this unit ever sends is read from here.
  //
  // No `reload` call at construction, deliberately. The navigator was built from
  // this same walk and already displays it; repainting it would cost a
  // reprojection for no new information and reset the reader's selection to the
  // top of the manuscript.
  let walk: ProjectItem[] = deps.initialItems.slice();

  // Outline operations are serialized, not dropped.
  //
  // A held Alt+ArrowDown - the natural gesture for "walk this scene down three
  // places" - fires around thirty keydowns a second, every one of them before
  // the first round trip returns. Unserialized, all of them read `rev` and the
  // sibling order from the same pre-mutation walk: the first succeeds and bumps
  // the rev, and the store refuses every one after it as a Conflict. The writer
  // gets a burst of red banners and a full reprojection each (20,060 rows at
  // the stress fixture) while the row moves exactly one place.
  //
  // Dropping, the way a project switch drops, would be wrong here: a held key
  // is a writer asking for the move to REPEAT. Chaining means each operation
  // reads the walk the previous one just re-read, so it plans against the tree
  // that now exists - which also fixes the other half, a `down` on a row an
  // in-flight move already relocated reading as "inert".
  // Latched by destroy(). Nothing can cancel a store round trip, so the only
  // question is what an operation is allowed to do when it lands late.
  //
  // `navigator.reload` after `navigator.destroy()` does not throw, and the
  // navigator's container is still #nav - the very element the NEXT project has
  // just mounted into. A late reload therefore sets the LIVE navigator's
  // scrollTop and points its aria-activedescendant at `nav-row-<k>` computed
  // from the dead project's walk: at nothing, or at a different scene, for the
  // life of the window. `onFailure` is the same story with a banner, prepended
  // to a body the teardown has already swept.
  let destroyed = false;
  const reload = (items: ProjectItem[]): void => {
    if (destroyed) return;
    deps.reload(items);
  };
  const fail = (message: string): void => {
    if (destroyed) return;
    deps.onFailure(message);
  };
  const done = (message: string): void => {
    if (destroyed) return;
    deps.onDone(message);
  };

  // 085's whole stack: one entry per landed mutation, an inverse PLAN rather
  // than a snapshot. See outline-undo.ts's header for why the arithmetic
  // lives there and not here.
  const undoStack = createUndoStack();

  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(op: () => Promise<T>): Promise<T> {
    // Both arms: a rejected predecessor must not cancel the queue behind it.
    const next = pending.then(op, op);
    // Deliberately not `next` itself. Nothing awaits `pending` for a value, and
    // a rejection parked here would be delivered to whatever queued next
    // instead of to the caller that asked for it.
    pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function refresh(): Promise<void> {
    const next = (await deps.invoke("project_items")) as ProjectItem[];
    // A copy, symmetrically with items(). Nothing aliases today because
    // storeSourceFrom copies what it is handed, but one unit passing its own
    // array out while the other passes a copy is an asymmetry one refactor from
    // a bug.
    reload(next.slice());
    // Committed only once the navigator has accepted it. `reload` really can
    // throw - storeSourceFrom refuses an empty array and project() panics on a
    // malformed walk - and assigning first left this unit planning against a
    // tree the navigator was not showing. Loudly, but still two views of one
    // manuscript.
    walk = next;
  }

  // What the writer reads in the red bar. `item_move failed: conflict: item
  // scene-0` is a sentence for whoever wrote the store, and it is shown to a
  // novelist. The underlying detail still rides along in parentheses - it is
  // the only record of what actually happened and it is what a bug report needs
  // - but the first sentence has to say what did not happen and what is safe.
  const ATTEMPT: Record<string, string> = {
    item_create: t("outline.attempt.create"),
    item_rename: t("outline.attempt.rename"),
    item_set_state: t("outline.attempt.set-state"),
    item_move: t("outline.attempt.move"),
  };
  const attemptCopy = (command: string): string =>
    t("outline.attempt", { attempt: ATTEMPT[command] ?? t("outline.attempt.generic") });

  function revOf(id: string): number | null {
    return walk.find((i) => i.id === id)?.rev ?? null;
  }

  /** The committed walk's answer. See `isTrashedIn` for why the rule is a free
   *  function and why the page must not use this one. */
  function isTrashed(id: string): boolean {
    return isTrashedIn(walk, id);
  }

  async function run(
    command: string,
    args: Record<string, unknown>,
    /** The raw response, handed over only on a successful invoke and BEFORE the
     *  re-read. One caller uses it (`create`, for the new row's id); every other
     *  command here answers something the walk already tells us. */
    capture?: (value: unknown) => void,
  ): Promise<OutlineOutcome> {
    try {
      const value = await deps.invoke(command, args);
      capture?.(value);
    } catch (err: unknown) {
      fail(t("outline.failed.command", { attempt: attemptCopy(command), command, error: String(err) }));
      // Re-read anyway: the command may have committed before the failure
      // reached us, and a screen showing a tree that no longer exists is worse
      // than a slow one. Swallowed because the writer already has one banner
      // about this action and a second one would be about the recovery.
      await refresh().catch(() => undefined);
      return "failed";
    }
    try {
      await refresh();
    } catch (err: unknown) {
      fail(t("outline.failed.reread", { error: String(err) }));
      return "failed";
    }
    return "applied";
  }

  /** Find the bin, or create it. EXTRACTED FROM `remove()` (085): undo of a
   *  create needs the same find-or-create the delete path already has, since
   *  a row this unit is about to bin may be undone before any writer has ever
   *  pressed Delete once.
   *
   *  Returns null on failure, having already raised the banner - callers
   *  return "failed" straight through, exactly as `remove()` did inline. */
  async function ensureBin(): Promise<string | null> {
    let bin = walk.find((i) => i.type === TRASH_TYPE)?.id;
    if (bin === undefined) {
      // parentId explicitly null: see remove()'s own note, which this is
      // extracted from and must not drift from.
      const made = await run("item_create", { parentId: null, itemType: TRASH_TYPE, title: TRASH_TITLE });
      if (made !== "applied") return null;
      bin = walk.find((i) => i.type === TRASH_TYPE)?.id;
      if (bin === undefined) {
        fail(t("outline.failed.no-bin"));
        return null;
      }
    }
    return bin;
  }

  /** Apply one step of an undo or redo entry, and hand back the step that
   *  would take it back again - computed from the LIVE walk the instant
   *  BEFORE this step runs, exactly as the design requires, so the caller can
   *  build the opposite stack's entry without ever re-deriving it later from
   *  a mutation's own report of what it did.
   *
   *  A "bin" step's reverse is asked for as a "move": undoing INTO the bin is
   *  an ordinary move once the bin exists, and its reverse is the row's
   *  current position - which is also what lets a REDO of a binned create put
   *  the row back with no second `item_create`. See outline-undo.ts's header. */
  async function applyUndoStep(step: UndoStep): Promise<{ outcome: OutlineOutcome; reverse: UndoStep | null }> {
    const row = walk.find((i) => i.id === step.id);
    if (row === undefined) {
      fail(t("outline.undo.gone", { title: step.title, id: step.id }));
      return { outcome: "failed", reverse: null };
    }
    switch (step.kind) {
      case "rename": {
        const reverse = inverseOf(step, walk);
        const outcome = await run("item_rename", { id: step.id, title: step.title, baseRev: row.rev });
        return { outcome, reverse: outcome === "applied" ? reverse : null };
      }
      case "state": {
        const reverse = inverseOf(step, walk);
        const outcome = await run("item_set_state", { id: step.id, state: step.state, baseRev: row.rev });
        return { outcome, reverse: outcome === "applied" ? reverse : null };
      }
      case "move": {
        // A recorded parent the live walk no longer holds: refusing beats
        // guessing a destination, exactly as `move()`'s own malformed case
        // does for the forward direction.
        if (step.parentId !== null && !walk.some((i) => i.id === step.parentId)) {
          fail(t("outline.undo.parent-gone", { title: step.title }));
          return { outcome: "failed", reverse: null };
        }
        const reverse = inverseOf(step, walk);
        const afterId = resolveAfter(walk, step.afterId);
        const outcome = await run("item_move", {
          id: step.id, newParentId: step.parentId, afterId, baseRev: row.rev,
        });
        return { outcome, reverse: outcome === "applied" ? reverse : null };
      }
      case "bin": {
        // Computed BEFORE `ensureBin()`, which may itself re-read the whole
        // walk (creating the bin) but never moves `step.id` - the row's
        // current position is unaffected by the bin merely coming into
        // existence somewhere else in the tree.
        const reverse = inverseOf(
          { kind: "move", id: step.id, title: step.title, parentId: null, afterId: null },
          walk,
        );
        const bin = await ensureBin();
        if (bin === null) return { outcome: "failed", reverse: null };
        // `ensureBin()` may have re-read the walk; re-look-up rather than
        // trust the `row` captured above, exactly as `remove()` re-reads the
        // rev after its own bin-create.
        const live = walk.find((i) => i.id === step.id);
        if (live === undefined) {
          fail(t("outline.undo.gone", { title: step.title, id: step.id }));
          return { outcome: "failed", reverse: null };
        }
        const outcome = await run("item_move", { id: step.id, newParentId: bin, afterId: null, baseRev: live.rev });
        return { outcome, reverse: outcome === "applied" ? reverse : null };
      }
    }
  }

  /** Create a document in a reserved SECTION, making the section if the project
   *  has none.
   *
   *  ONE BODY FOR BOTH the bible and the two matter sections, and the serialized
   *  wrapper is what it is for: two operations would let two quick presses each
   *  find no section and each create one, and the walk would then hold two roots
   *  of that type. The host defines that case (the first wins) rather than
   *  rejecting it, so the second section's contents would be silently stranded
   *  in the manuscript.
   *
   *  NOT `planPlacement`. Every other create is placed from the SELECTION, and a
   *  document that belongs in one section always has nothing to do with what the
   *  writer is looking at -- routing it through placement would land a dedication
   *  in the manuscript whenever the selection happened to be a scene. */
  function createInSection(spec: {
    rootType: string;
    rootTitle: string;
    docType: string;
    docTitle: (items: readonly ProjectItem[]) => string;
    noSection: () => string;
  }): Promise<OutlineOutcome> {
    return serialized(async () => {
      const selected = deps.selectedId();
      // ROOT-LEVEL, matching the host's `root_subtree_ids`. A row of one of
      // these types that a writer moved inside a scene is a row, not a section,
      // and filing documents into it would put them in the manuscript.
      const sectionId = (): string | undefined =>
        walk.find((i) => i.parent_id === null && i.type === spec.rootType)?.id;
      let section = sectionId();
      if (section === undefined) {
        // parentId explicitly null: it is an Option arg, and a missing key
        // would ALSO mean "create at root". Correct here by luck, stated
        // anyway, exactly as `remove`'s bin create states it.
        const made = await run("item_create", {
          parentId: null,
          itemType: spec.rootType,
          title: spec.rootTitle,
        });
        if (made !== "applied") return made;
        // From the walk `run` just re-read, not from the create's return.
        section = sectionId();
        if (section === undefined) {
          fail(spec.noSection());
          return "failed";
        }
      }
      // afterId null appends, so the section reads oldest-first and a writer's
      // earlier documents are not pushed down by every new one. The bin's rule.
      const title = spec.docTitle(walk);
      const parentId = spec.rootType === BIBLE_TYPE
        ? bibleParentFor(walk, selected, section)
        : section;
      let id: string | null = null;
      const outcome = await run(
        "item_create",
        { parentId, afterId: null, itemType: spec.docType, title },
        (value) => {
          const got = (value as { id?: unknown } | null)?.id;
          if (typeof got === "string") id = got;
        },
      );
      if (outcome === "applied" && id !== null) {
        deps.onCreated(id);
        // THE DOCUMENT ONLY, never the section. A reserved root a press
        // MADE is never binned - an empty section is harmless, and a reserved
        // type inside the bin is a shape no reader expects. "Undoing 'New
        // bible document' bins the document."
        const createdRow = walk.find((i) => i.id === id);
        const createdTitle = createdRow?.title ?? title;
        undoStack.push({
          label: t("outline.undo.label.create", { title: createdTitle }),
          steps: [{ kind: "bin", id, title: createdTitle }],
        });
      }
      return outcome;
    });
  }

  /** One step of a move, with no undo entry: `move` and `moveBy` push their
   *  own, one per call. */
  async function moveOnce(id: string, direction: MoveDirection): Promise<OutlineOutcome> {
    // Looked up before planMove, which returns null for an unknown id just
    // as it does for a legitimately inert direction. Reporting a page bug
    // as "nothing to do" would hide it.
    const rev = revOf(id);
    if (rev === null) {
      fail(t("outline.gone.move", { id }));
      return "failed";
    }
    const plan = planMove(walk, id, direction);
    // A walk that contradicts itself is not "nothing to do". Reporting it
    // as inert makes it indistinguishable from Alt+Up on the first sibling,
    // which is the one shape of this the writer is supposed to see nothing
    // about.
    if (plan.kind === "malformed") {
      fail(t("outline.failed.malformed", { id, reason: plan.reason }));
      return "failed";
    }
    // No legal destination is not an error and must never reach IPC.
    if (plan.kind === "inert") return "inert";
    const title = walk.find((i) => i.id === id)?.title ?? id;
    const change = sectionChange(walk, id, plan.target);
    if (change && (await deps.confirmSectionMove?.(title, change)) === false) return "inert";
    // All three of `id`, `newParentId` and `afterId` are camelCase; the
    // latter two are Options, so a typo means "to the root" / "first child"
    // instead of an error. See the create case.
    return run("item_move", {
      id,
      newParentId: plan.target.newParentId,
      afterId: plan.target.afterId,
      baseRev: rev,
    });
  }

  /** Up to `count` steps and at most ONE undo entry for all of them. */
  async function movedWithUndo(id: string, direction: MoveDirection, count: number): Promise<OutlineOutcome> {
    // Captured BEFORE the first step: the inverse of "move it anywhere" is
    // "move it back to where it is now", and `walk` still answers that.
    const before = walk;
    const title = before.find((i) => i.id === id)?.title ?? id;
    let moved = false;
    let outcome: OutlineOutcome = "inert";
    for (let step = 0; step < count; step += 1) {
      outcome = await moveOnce(id, direction);
      if (outcome !== "applied") break;
      moved = true;
    }
    if (moved) {
      const inverse = inverseOf({ kind: "move", id, title, parentId: null, afterId: null }, before);
      if (inverse) {
        undoStack.push({ label: t("outline.undo.label.move", { title }), steps: [inverse] });
      }
    }
    return moved && outcome === "inert" ? "applied" : outcome;
  }

  return {
    // Every one of these reads `walk` INSIDE the serialized body, never in the
    // argument expression that queues it: reading it any earlier is exactly the
    // stale-plan defect the queue exists to remove.
    create(itemType: string, relativeTo?: string): Promise<OutlineOutcome> {
      // PLACEMENT AND TITLE ARE BOTH DERIVED FROM `walk`, INSIDE the serialized
      // body. Reading either in the argument expression that queues this call
      // is the stale-plan defect the queue exists to remove: with a move already
      // in flight, the tree the plan was computed against is not the tree the
      // command will land in.
      //
      // The placement rule itself lives in `placement.ts` and the numbering in
      // `numbering.ts`, neither of them here, because a rule inside this
      // closure is a rule no test can reach - the recorded shape that let three
      // flush mutations survive.
      return serialized(async () => {
        // CAPTURED BEFORE ANYTHING RUNS. Undoing a create bins the OUTERMOST
        // row it made and, when it adopted loose chapters, moves
        // each one back to where THIS walk - not any later one - had it.
        const before = walk;
        const anchor = relativeTo ?? deps.selectedId();
        const place = planPlacement(walk, anchor, itemType);
        // THE HOLDERS FIRST, THEN THE ITEM INSIDE THE LAST. `holders` is empty
        // in every case but one -- a chapter with no part above it, which is
        // the press that could not produce indentation, a reported defect.
        // Each holder goes where the one before it put it, and the
        // requested item ends up inside the innermost.
        const creating = [...place.holders, itemType];
        // PLANNED FROM THE PRE-CREATE WALK, and from the LIVE one: the bin and
        // everything in it are not part of the manuscript, and adopting a
        // deleted chapter would be an undelete nobody pressed. Read here rather
        // than after the creates so the list cannot contain a row this press
        // just made.
        // THE MANUSCRIPT WALK, not merely the live one. 033's argument for
        // stripping the bin applies unchanged to the bible: a part the writer
        // keeps among their world building is not a part of the book, and
        // letting one suppress adoption would spend the manuscript's single
        // adoption on a row that is not in it.
        // `chapterItemsIn`, not `manuscriptItemsIn`: front matter is IN the
        // book and OUT of the chapter sequence, and adoption is a question
        // about the sequence. See `chapterItemsIn`.
        const chapterItems = chapterItemsIn(walk);
        const candidates = planAdoption(chapterItems, creating);
        const adoptionSafe = adoptionPreservesOrder(chapterItems, candidates, place);
        const adopt = adoptionSafe ? candidates : [];
        let parentId = place.parentId;
        let afterId = place.afterId;
        let created: string | null = null;
        // The part this press brings into existence, whether the writer asked
        // for it or 030's holder rule built it. There is never more than one.
        let adoptInto: string | null = null;
        // The FIRST row this press made - the outermost holder when there is
        // one, otherwise `created` itself once the loop below finishes. What
        // undo bins: binning it takes its subtree, holder and all, with it.
        let outermostId: string | null = null;
        let outcome: OutlineOutcome = "inert";
        for (const type of creating) {
          // PER STEP, against the walk as it stands NOW: `run` re-reads before
          // it returns, so the item's number is computed after the holder
          // exists rather than against the tree this press started in.
          const title = nextNumberedTitle(walk, type, numberPattern(type));
          let id: string | null = null;
          // camelCase, and every Option arg explicitly present even when null:
          // a missing or misspelled key deserializes to None, which for
          // `parentId` means "create at root" - legal, wrong, and
          // indistinguishable from the call that was intended.
          outcome = await run(
            "item_create",
            { parentId, afterId, itemType: type, title },
            (value) => {
              const got = (value as { id?: unknown } | null)?.id;
              if (typeof got === "string") id = got;
            },
          );
          // STOPS, and leaves what did land. A part created for a chapter that
          // then failed is a part the writer can see and delete; unwinding it
          // would be a second write on a path that has just told us writes are
          // failing, and `item_remove` has its own bin semantics that have no
          // business firing here.
          if (outcome !== "applied" || id === null) return outcome;
          created = id;
          if (outermostId === null) outermostId = id;
          if (type === "part") adoptInto = id;
          parentId = id;
          // Appended inside the holder just made: there is nothing in it yet,
          // and `afterId` from the plan described where the HOLDER went.
          afterId = null;
        }
        // THE CHAPTERS THAT HAD NOWHERE TO LIVE, MOVED IN. Only ever on the
        // press that gives a book its first part, and `planAdoption` carries
        // the argument for why that bound is the whole of what makes this safe.
        // Each one follows the last, so the manuscript keeps its reading order.
        // NO `adoptInto !== null` GUARD. `adopt` is empty unless this press is
        // creating a part, and a create that failed has already returned - so a
        // guard here would be one no input can reach, which this repo deletes
        // rather than keeps (a reader credits an unreachable guard for a
        // refusal it never makes). The empty list IS the guard.
        // THE INVERSE OF EACH ADOPTION MOVE, computed from `before` - the walk
        // as it stood at the very start of this press, which is where undo
        // must put each chapter back. Built alongside the forward moves rather
        // than re-derived later: by the time undo runs, `before` is long gone
        // and only this closure ever held it.
        const adoptedMoves: UndoStep[] = [];
        // PUSHES AN ENTRY FOR WHATEVER LANDED, whether this press finished or
        // a move partway through the adoption loop failed. The holder and
        // every chapter already moved into it are real structural changes -
        // a press that dies halfway still needs a way back, not just the one
        // that finished. THE ADOPTED CHAPTERS FIRST, THEN THE OUTERMOST
        // HOLDER BINNED - the order the design requires: they must be back at
        // the root before the part that held them disappears into the bin, or
        // the store would be asked to move a row out of a subtree that is
        // itself mid-move.
        function pushCreateUndo(): void {
          if (outermostId === null) return;
          const outermostRow = walk.find((i) => i.id === outermostId);
          const outermostTitle = outermostRow?.title ?? outermostId;
          undoStack.push({
            label: t("outline.undo.label.create", { title: outermostTitle }),
            steps: [...adoptedMoves, { kind: "bin", id: outermostId, title: outermostTitle }],
          });
        }
        {
          let after: string | null = null;
          for (const id of adopt) {
            // FRESH PER MOVE. `run` re-reads the whole walk, so the rev this
            // sends is the one the store reports after the previous move rather
            // than the one the plan was made against - the stale-plan defect
            // the queue exists to remove, in the one loop here that repeats.
            const rev = revOf(id);
            // Gone since the plan was made. Nothing to adopt, and no banner: the
            // writer named a part, not this row, and the rest still belong in it.
            if (rev === null) continue;
            const priorRow = before.find((i) => i.id === id);
            outcome = await run("item_move", { id, newParentId: adoptInto, afterId: after, baseRev: rev });
            // STOPS AND LEAVES WHAT LANDED, exactly as a failed holder does.
            // Unwinding would be another write on a path that has just said
            // writes are failing. The undo entry still gets pushed below, for
            // the chapters that DID land before the failure.
            if (outcome !== "applied") {
              pushCreateUndo();
              return outcome;
            }
            if (priorRow !== undefined) {
              const reverse = inverseOf(
                { kind: "move", id, title: priorRow.title, parentId: null, afterId: null },
                before,
              );
              if (reverse) adoptedMoves.push(reverse);
            }
            after = id;
          }
        }
        // AFTER the re-read, which `run` has already done, so the navigator
        // holds the row this names. THE REQUESTED ITEM, never a holder: the
        // writer asked for a chapter, and leaving them selected on a part they
        // did not ask for would make the next press land somewhere else again.
        // Only on success: a failed create has no row to select, and moving the
        // selection anyway would leave the writer pointing at whatever happened
        // to be there.
        if (outcome === "applied" && created !== null) deps.onCreated(created);
        if (outcome === "applied") {
          pushCreateUndo();
          if (!adoptionSafe) done(t("outline.adoption-kept-order"));
        }
        return outcome;
      });
    },

    rename(id: string, title: string): Promise<OutlineOutcome> {
      return serialized(async () => {
        // A blank title is unrecoverable through this UI: the row would have no
        // name left to click. Checked before the lookup because it is a property
        // of the request, not of the tree.
        if (title.trim().length === 0) return "inert";
        const row = walk.find((i) => i.id === id);
        if (!row) {
          fail(t("outline.gone.rename", { id }));
          return "failed";
        }
        if (row.title === title) return "inert";
        const oldTitle = row.title;
        const outcome = await run("item_rename", { id, title, baseRev: row.rev });
        if (outcome === "applied") {
          undoStack.push({
            label: t("outline.undo.label.rename", { title }),
            steps: [{ kind: "rename", id, title: oldTitle }],
          });
        }
        return outcome;
      });
    },

    setState(id: string, state: string | null): Promise<OutlineOutcome> {
      return serialized(async () => {
        // Read INSIDE the serialized body, like every other operation here: a
        // walk read in the argument expression is the stale-plan defect the
        // queue exists to remove.
        const row = walk.find((i) => i.id === id);
        if (!row) {
          fail(t("outline.gone.set-state", { id }));
          return "failed";
        }
        // The store would accept it and bump the rev for nothing, and every
        // watcher of the walk would repaint. Compared against the ABSENCE too:
        // `null` and a missing state are one thing.
        if ((row.state ?? null) === state) return "inert";
        // `state` is present in the object even when null. It is an Option arg
        // host-side and None MEANS the default there, so a missing key would
        // silently CLEAR the state rather than error - the recorded `parentId`
        // hazard, with a destructive reading.
        const oldState = row.state ?? null;
        const outcome = await run("item_set_state", { id, state, baseRev: row.rev });
        if (outcome === "applied") {
          undoStack.push({
            label: t("outline.undo.label.state", { title: row.title }),
            steps: [{ kind: "state", id, title: row.title, state: oldState }],
          });
        }
        return outcome;
      });
    },

    move(id: string, direction: MoveDirection): Promise<OutlineOutcome> {
      return serialized(() => movedWithUndo(id, direction, 1));
    },

    moveBy(id: string, direction: MoveDirection, count: number): Promise<OutlineOutcome> {
      return serialized(() => movedWithUndo(id, direction, count));
    },

    createNote(): Promise<OutlineOutcome> {
      return createInSection({
        rootType: BIBLE_TYPE,
        rootTitle: BIBLE_TITLE,
        docType: NOTE_TYPE,
        // Numbered from the WALK, inside the serialized body: a title computed
        // outside it would be numbered against a tree that may already have
        // changed.
        docTitle: (items) => nextNumberedTitle(items, NOTE_TYPE, numberPattern(NOTE_TYPE)),
        noSection: () => t("outline.failed.no-bible"),
      });
    },

    createBibleFolder(): Promise<OutlineOutcome> {
      return createInSection({
        rootType: BIBLE_TYPE,
        rootTitle: BIBLE_TITLE,
        docType: BIBLE_FOLDER_TYPE,
        docTitle: (items) => nextNumberedTitle(items, BIBLE_FOLDER_TYPE, numberPattern(BIBLE_FOLDER_TYPE)),
        noSection: () => t("outline.failed.no-bible"),
      });
    },

    createTimeline(): Promise<OutlineOutcome> {
      return createInSection({
        rootType: BIBLE_TYPE,
        rootTitle: BIBLE_TITLE,
        docType: TIMELINE_TYPE,
        // NOT NUMBERED, `createMatter`'s reason and not `createNote`'s: the
        // model is one story clock per book, so `timeline.untitled`
        // is already the name a writer would give it.
        docTitle: () => t("timeline.untitled"),
        // THE SAME SECTION AS A NOTE, so the same failure sentence: both are
        // "the bible section could not be created", and a second sentence
        // for the identical failure would be a second thing to translate for
        // no new information.
        noSection: () => t("outline.failed.no-bible"),
      });
    },

    createMatter(kind: MatterKind): Promise<OutlineOutcome> {
      const spec = MATTER_KINDS[kind];
      return createInSection({
        rootType: spec.section,
        rootTitle: spec.sectionTitle(),
        docType: MATTER_TYPE,
        // NOT NUMBERED, unlike every other create in this application. `Scene`,
        // `Chapter` and `Note` are placeholders a writer replaces, so a number
        // is what makes three of them tellable apart; `Dedication` is already
        // the title the page a writer asked for carries, and `Dedication 1` in
        // a book with one dedication is a lie about the book. `nextNumberedTitle`
        // is not consulted at all rather than handed a pattern with no `{n}`.
        docTitle: () => spec.title(),
        noSection: () => t("outline.failed.no-matter"),
      });
    },

    remove(id: string): Promise<OutlineOutcome> {
      // ONE serialized body covering both the bin's creation and the move. Two
      // separate operations would let a held Delete - or simply two quick ones -
      // each find no bin and each create one, and the walk would then hold two
      // roots of TRASH_TYPE. The store defines that case (the first wins) rather
      // than rejecting it, so it would not fail; it would just quietly strand
      // the second bin's contents inside the manuscript.
      return serialized(async () => {
        const row = walk.find((i) => i.id === id);
        if (!row) {
          fail(t("outline.gone.delete", { id }));
          return "failed";
        }
        // Deleting the bin, or something already in it, is not an error and
        // must never reach IPC - it is the writer pressing Delete on a row that
        // is already deleted.
        if (isTrashed(id)) return "inert";

        const bin = await ensureBin();
        if (bin === null) return "failed";

        // AFTER the bin may have been created, so `before` reflects the tree
        // this move actually runs against - and so undo's inverse (the row's
        // ORIGINAL parent and sibling, not restore's root/append)
        // is computed from the same walk the rev below comes from.
        const before = walk;
        // Re-read AFTER the bin may have been created: that create re-read the
        // whole walk, and planning a move with a rev from before it is the
        // stale-plan defect the queue exists to prevent.
        const rev = revOf(id);
        if (rev === null) {
          fail(t("outline.gone.delete", { id }));
          return "failed";
        }
        const title = before.find((i) => i.id === id)?.title ?? id;
        // The bin's LAST child in walk order, null when the bin is empty. A
        // null afterId on item_move is FIRST in the group, not last (the
        // store's moving_to_the_front_uses_a_null_left_neighbour), so naming
        // the earlier binned row is what makes the bin read oldest-first --
        // null here would land every new delete ahead of what came before it.
        const lastInBin = [...before].reverse().find((i) => i.parent_id === bin)?.id ?? null;
        const outcome = await run("item_move", { id, newParentId: bin, afterId: lastInBin, baseRev: rev });
        if (outcome === "applied") {
          const inverse = inverseOf({ kind: "move", id, title, parentId: null, afterId: null }, before);
          if (inverse) {
            undoStack.push({ label: t("outline.undo.label.delete", { title }), steps: [inverse] });
          }
        }
        return outcome;
      });
    },

    restore(id: string): Promise<OutlineOutcome> {
      return serialized(async () => {
        // Not in the bin: nothing to restore, and no IPC. An id the walk does
        // not hold takes this path too, deliberately - it is not in the bin
        // either, and a writer whose row vanished under them gets nothing
        // rather than a banner about an id.
        if (!isTrashed(id)) return "inert";
        // The bin itself. isTrashed is true of it as well as its contents, so
        // the guard above does not catch it: it is not a manuscript item and
        // has nowhere to be returned to.
        if (walk.find((i) => i.id === id)?.type === TRASH_TYPE) return "inert";

        const rev = revOf(id);
        if (rev === null) {
          fail(t("outline.gone.restore", { id }));
          return "failed";
        }
        // Captured BEFORE the move: this is where the row was IN THE BIN, and
        // undoing a restore has to put it back there - not at the manuscript
        // root, which is what `restore()` itself does for the opposite reason.
        const before = walk;
        const title = before.find((i) => i.id === id)?.title ?? id;
        // newParentId explicitly null: it is an Option arg, and a missing key
        // would ALSO mean root. Correct here by luck, stated anyway, because
        // remove's create depends on the same thing and the two must not drift.
        //
        // afterId names the last MANUSCRIPT root (never the bin, the bible or
        // either matter section), so this lands at the end of the manuscript
        // and before every reserved section - the bin needs no re-sink,
        // because it was never displaced. A null afterId on item_move is
        // FIRST in the group, not last, so null is right only when there is
        // no manuscript root to name.
        const afterId = lastManuscriptRootId(before);
        const moved = await run("item_move", { id, newParentId: null, afterId, baseRev: rev });
        if (moved !== "applied") return moved;
        const inverse = inverseOf({ kind: "move", id, title, parentId: null, afterId }, before);
        if (inverse) {
          undoStack.push({ label: t("outline.undo.label.restore", { title }), steps: [inverse] });
        }
        return "applied";
      });
    },

    refresh(): Promise<OutlineOutcome> {
      return serialized(async () => {
        try {
          await refresh();
        } catch (err: unknown) {
          fail(t("outline.failed.read", { error: String(err) }));
          return "failed";
        }
        return "applied";
      });
    },

    undo(): Promise<OutlineOutcome> {
      return serialized(async () => {
        const entry = undoStack.takeUndo();
        // Nothing to undo is not an error - the writer just pressed Ctrl+Z
        // with an empty stack.
        if (entry === null) return "inert";
        for (const step of entry.steps) {
          if (step.kind !== "move") continue;
          const change = sectionChange(walk, step.id, {
            newParentId: step.parentId, afterId: resolveAfter(walk, step.afterId),
          });
          if (change && (await deps.confirmSectionMove?.(step.title, change)) === false) {
            undoStack.pushUndoFromRedo(entry);
            return "inert";
          }
        }
        const redoSteps: UndoStep[] = [];
        for (const step of entry.steps) {
          const { outcome, reverse } = await applyUndoStep(step);
          // A FAILED STEP STOPS THE ENTRY AND DROPS IT: it has
          // already been popped, so there is nothing left to retry, and
          // redo is cleared - a stack whose top no longer applies cleanly is
          // one this unit refuses to reason about further.
          if (outcome !== "applied") {
            undoStack.clearRedo();
            return outcome;
          }
          if (reverse) redoSteps.push(reverse);
        }
        // REVERSED: undo applied step 1..n in that order, so redoing this
        // entry has to replay their reverses n..1 - inv(sn) first, inv(s1)
        // last. Otherwise a create's redo would move the adopted chapters
        // into a part that is still sitting in the bin, because the part's
        // own reverse (collected last, from applying the bin step) would run
        // after theirs instead of before.
        undoStack.pushRedo({ label: entry.label, steps: redoSteps.reverse() });
        done(t("outline.undone", { what: entry.label }));
        return "applied";
      });
    },

    redo(): Promise<OutlineOutcome> {
      return serialized(async () => {
        const entry = undoStack.takeRedo();
        if (entry === null) return "inert";
        for (const step of entry.steps) {
          if (step.kind !== "move") continue;
          const change = sectionChange(walk, step.id, {
            newParentId: step.parentId, afterId: resolveAfter(walk, step.afterId),
          });
          if (change && (await deps.confirmSectionMove?.(step.title, change)) === false) {
            undoStack.pushRedo(entry);
            return "inert";
          }
        }
        const undoSteps: UndoStep[] = [];
        for (const step of entry.steps) {
          const { outcome, reverse } = await applyUndoStep(step);
          // Mirrors undo's own failure branch: the failed entry is already
          // popped, and whatever is left below it in the redo stack was
          // built against a tree this same failure says has moved under us,
          // so it is no more trustworthy than the entry that just failed.
          if (outcome !== "applied") {
            undoStack.clearRedo();
            return outcome;
          }
          if (reverse) undoSteps.push(reverse);
        }
        // REVERSED for the same reason undo's own push is: redo applied
        // step 1..n in that order, so undoing it again has to replay n..1.
        undoStack.pushUndoFromRedo({ label: entry.label, steps: undoSteps.reverse() });
        done(t("outline.redone", { what: entry.label }));
        return "applied";
      });
    },

    canUndo: () => undoStack.canUndo(),
    canRedo: () => undoStack.canRedo(),
    undoLabel: () => undoStack.undoLabel(),
    redoLabel: () => undoStack.redoLabel(),

    // A copy. The caller is handed rows it might sort or splice, and this walk
    // is what every base_rev is read from.
    items: () => walk.slice(),

    // A latch, not a cancellation: the queue keeps draining and every operation
    // still resolves with an honest outcome to whoever awaited it. What stops
    // is the unit's reach into the page.
    destroy(): void {
      destroyed = true;
    },
  };
}
