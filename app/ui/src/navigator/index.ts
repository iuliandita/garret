// app/ui/src/navigator/index.ts
// Owns the accessibility contract and the keyboard model; delegates rendering
// to VirtualList. The index arithmetic is exported separately from the DOM
// wiring so it can be tested without a document — an off-by-one here means a
// row the keyboard cannot reach, which is an accessibility defect no latency
// gate would notice.
import { createNavigatorHints } from "../navigator-hints";
import { isCompositionKey } from "../composition-key";
import { t } from "../i18n";
import { DEFAULT_SIDEBAR_WORD_COUNTS, type SidebarWordCounts } from "../sidebar-word-counts";
import { formatCount } from "../outline-counts";
import {
  isRevisionState,
  markFor,
  REVISION_STATES,
  STATE_LABELS,
  stateDescriptionId,
} from "../revision-states";
import { project, type TreeNode, type VisibleRow } from "./visible";
import { createVirtualList, type VirtualList } from "./virtual-list";
import type { FixtureSource } from "../fixture/source";
import type { MoveDirection } from "../outline";
import { isContextMenuChord } from "../nav-context-menu";
import { createIcon, type IconName } from "../icons";
import {
  BACK_MATTER_TYPE,
  BIBLE_TYPE,
  FRONT_MATTER_TYPE,
  NOTE_TYPE,
  RESERVED_ROOT_TYPES,
  TIMELINE_TYPE,
  TRASH_TYPE,
} from "../item-types";

export type NavKey =
  | "ArrowUp" | "ArrowDown" | "PageUp" | "PageDown" | "Home" | "End" | string;

const clamp = (i: number, count: number): number => Math.max(0, Math.min(count - 1, i));

/** The Alt+Arrow chords, and nothing else. Left/Right are outdent/indent
 *  because that is what they already mean unmodified (collapse/expand walks the
 *  same axis), so the modifier changes the verb, not the direction. */
const MOVE_KEYS: Record<string, MoveDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "outdent",
  ArrowRight: "indent",
};

export function nextIndex(key: NavKey, current: number, count: number, page: number): number {
  switch (key) {
    case "ArrowDown": return clamp(current + 1, count);
    case "ArrowUp": return clamp(current - 1, count);
    case "PageDown": return clamp(current + page, count);
    case "PageUp": return clamp(current - page, count);
    case "Home": return 0;
    case "End": return count - 1;
    default: return current;
  }
}

// Searches forward from the row AFTER the current one and wraps, so repeating a
// prefix walks through matches instead of sticking on the first.
export function typeAheadIndex(
  prefix: string,
  current: number,
  count: number,
  titleAt: (i: number) => string,
): number {
  const needle = prefix.toLowerCase();
  if (needle.length === 0) return current;
  for (let step = 1; step <= count; step++) {
    const i = (current + step) % count;
    if (titleAt(i).toLowerCase().startsWith(needle)) return i;
  }
  return current;
}


/** The navigator needs depth and parentage per row. A corpus source has no
 *  tree, so it reports every row at depth 0 and renders as a one-level tree. */
export interface TreeSource extends FixtureSource {
  depthAt?(index: number): number;
  /** The store's item type for the row, painted as `data-type`. Optional and
   *  shaped exactly like `depthAt` for the same reason: a corpus source has
   *  neither a tree nor types, and it supplies neither. */
  typeAt?(index: number): string;
  /** The store's revision state for the row, painted as `data-state`, a mark and
   *  a description. Optional and shaped exactly like `typeAt` for the same
   *  reason: a corpus source has no items and supplies neither. */
  stateAt?(index: number): string | null;
  items?: { id: string; parent_id: string | null }[];
}

export interface NavigatorOptions {
  sidebarWordCounts?: SidebarWordCounts;
  container: HTMLElement;
  source: TreeSource;
  rowHeight: number;
  overscan: number;
  /** naive mounts every visible row at once: the negative control, not a
   *  fallback. */
  mode: "virtual" | "naive";
  onActivate?(itemId: string): void;
  /** Alt+Arrow on the selected row. Reports the intent only: the navigator
   *  neither validates the move nor moves its own cursor. The store applies it
   *  and the new shape arrives back through `reload`. */
  onMove?(itemId: string, direction: MoveDirection): void;
  /** Delete on the selected row. Reports the intent only, exactly like
   *  `onMove`: the outline decides whether the row can go, and the new shape
   *  arrives back through `reload`. */
  onRemove?(itemId: string): void;
  /** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while the tree has focus. Reports
   *  the intent only, exactly like `onMove` and `onRemove` - the outline unit
   *  owns the stack and the new shape arrives back through `reload`. */
  onUndo?(): void;
  onRedo?(): void;
  /** The selection moved, by a real click or a real key. Null when the tree is
   *  empty and there is no row to be on.
   *
   *  NOT fired from `setActive`, so a reload that preserves the selection, the
   *  constructor's initial `setActive(0)` and every synthetic `handleKey` are
   *  all silent. See `announceSelection`. */
  onSelect?(itemId: string | null): void;
  /** A right-click, Shift+F10 or the Menu key on a row. Reports the row and
   *  where to put the menu, in VIEWPORT coordinates.
   *
   *  THE SELECTION HAS ALREADY MOVED ONTO THAT ROW when this fires, and both
   *  halves are load-bearing: the row a menu acts on must be the row the writer
   *  sees selected, or the application repeats quick open's recorded defect
   *  (a scene marked open without the selection following, so the next
   *  selection-driven command acted on the row the writer had LEFT) on a surface
   *  that hides it better, because the row under the pointer looks selected. */
  onContextMenu?(itemId: string, x: number, y: number): void;
}

export interface ManuscriptNavigator {
  activeIndex(): number;
  activeTitle(): string;
  /** Hand over new word counts and repaint the mounted rows.
   *
   *  A REPAINT, not a reprojection: the tree's shape has not changed, only a
   *  figure on each row, so `setCount` and the visible-row projection are both
   *  wrong here - they would rebuild the range and, in the virtual list, reset
   *  the scroll the writer had. */
  setCounts(next: ReadonlyMap<string, number>): void;
  setSidebarWordCounts(next: SidebarWordCounts): void;
  /** Hand over the set of items that carry a synopsis and repaint the mounted
   *  rows, the way `setCounts` does and for the same reason: a mark on a row,
   *  not a change of shape. */
  setSynopses(next: ReadonlySet<string>): void;
  setAppearances(next: ReadonlySet<string>): void;
  /** Visible rows, for the harness's expectation payload. */
  rows(): readonly VisibleRow[];
  handleKey(key: string): void;
  /** Move the selection to an item by id. A no-op when the item is not
   *  currently visible: auto-expanding to reveal a selection is a behaviour
   *  with its own questions (does it stay expanded afterwards?) and no caller
   *  needs it. */
  selectById(itemId: string): void;
  /** Reveal and select one existing row. Unlike `selectById`, this is for a
   *  deliberate jump outside the tree and expands only that row's ancestors. */
  revealAndSelectById?(itemId: string): void;
  /** Which row carries aria-current: the document the editor is showing. */
  setOpen(itemId: string | null): void;
  /** Activate the selected row. Separate from handleKey on purpose: the
   *  synthetic workload drives handleKey directly and must never be able to
   *  trigger a document load. */
  activate(): void;
  /** Replace the walk with a fresh one from the store, in place. Every
   *  structural edit is command -> project_items -> reload, so the store stays
   *  the only source of tree truth and the page never patches its local walk.
   *
   *  Preserves the selection by ITEM id (not by index: a create above the
   *  cursor would otherwise move the reader's place), the collapsed set minus
   *  ids that left the walk, and aria-current unless the open item left.
   *
   *  Two things it does change, both about the selected row. If that row has
   *  moved inside a collapsed branch, its ancestors are expanded so the reader
   *  can see where it landed. If it left the walk entirely there is nothing to
   *  preserve and the selection falls back to row 0 - which at the stress
   *  fixture loses the reader's place in a 20,060-row manuscript, and is the
   *  reason the case above is handled rather than left to the fallback.
   *
   *  Touches nothing OUTSIDE the outline. Not the editor, not its caret or undo
   *  history, not the flush scheduler, not the session, not the open document.
   *  A reload is a repaint of the outline; a remount is what it exists to
   *  avoid. It also never calls onActivate - a reload that activated would open
   *  a document on every rename. */
  reload(next: TreeSource): void;
  destroy(): void;
}

const ROW_ATTRS = [
  "id", "role", "aria-level", "aria-posinset", "aria-setsize", "aria-expanded",
  "aria-selected", "aria-current", "aria-describedby", "data-indent", "data-type",
  "data-state", "data-synopsis", "data-appearances", "data-first-reserved",
];

/** The id of the one sentence a row with a synopsis is described by, beside
 *  its revision state's. */
export const SYNOPSIS_DESCRIPTION_ID = "nav-synopsis-description";
export const APPEARANCES_DESCRIPTION_ID = "nav-appearances-description";
const WORD_DESCRIPTION_ID = "nav-word-description";

/** Deepest indent step style.css draws. Past this the tree is nested further
 *  than a 320px pane can express, so the rows share a margin rather than march
 *  off the right edge - the same honesty as the export collapsing its headings
 *  at H6. The CAP IS VISUAL ONLY: aria-level keeps reporting the true depth,
 *  because the accessibility contract has no width to run out of. */
const INDENT_CAP = 6;

/** Which of the world's rows carry a glyph before their title.
 *
 *  MANUSCRIPT ROWS (part, chapter, scene) AND MATTER DOCUMENTS ARE NOT HERE.
 *  The manuscript is the writer's own hierarchy and stays type, not icon; a
 *  matter document (a dedication, a foreword) keeps the paper's ink for the
 *  same reason `style.css`'s `[data-type="matter"]` rule does -- it is a page
 *  OF the book, not a mark of what is not the book. */
const ROW_ICONS: Readonly<Partial<Record<string, IconName>>> = Object.freeze({
  [BIBLE_TYPE]: "book-open",
  [NOTE_TYPE]: "file-text",
  [TIMELINE_TYPE]: "calendar-range",
  [FRONT_MATTER_TYPE]: "bookmark",
  [BACK_MATTER_TYPE]: "bookmark",
  [TRASH_TYPE]: "trash-2",
});

/** The first reserved-type ROOT in walk order -- front matter, the bible, back
 *  matter or the bin -- or null when the manuscript has none. This is where
 *  the separator goes: the row that answers "the book stops here" is the
 *  first one that is not the book, and it is a property of the WALK, not of
 *  what is currently visible, so collapsing a branch elsewhere must not move
 *  it. */
function firstReservedRootOf(nodes: readonly TreeNode[]): string | null {
  for (const node of nodes) {
    if (node.parentId === null && RESERVED_ROOT_TYPES.includes(node.itemType ?? "")) return node.id;
  }
  return null;
}

/** The two spans every row is built from, created once per ELEMENT and reused.
 *
 *  The row was a bare text node until word counts arrived. Two things made
 *  child elements worth the change and one made them costly, so all three are
 *  written down:
 *
 *  - The count has to be right-aligned against a title that ellipsises, which a
 *    single text node cannot express.
 *  - THE ACCESSIBLE NAME MUST NOT CHANGE. A row's name is computed from its
 *    content, so a count inside it would append itself to every title - and two
 *    graded rigs locate rows BY NAME in the painted tree (`menu-cli`'s
 *    `rowNamed`, and the outline run's alignment). The count span carries
 *    `aria-hidden="true"` so the name stays exactly the title. What that costs
 *    is recorded in the write-back: a screen-reader user is not told a
 *    chapter's length, and getting it to them means changing the tree's names,
 *    which is a decision with two rigs attached rather than a line of markup.
 *  - The virtual list repaints on every scroll, so building two elements per
 *    paint would be real work on the measured path. They are created only when
 *    the element does not already have them, which for a recycled row is never.
 */
function partsOf(el: HTMLElement): {
  title: HTMLElement;
  synopsis: HTMLElement;
  appearances: HTMLElement;
  state: HTMLElement;
  count: HTMLElement;
} {
  const first = el.firstElementChild;
  const second = first?.nextElementSibling;
  const third = second?.nextElementSibling;
  const fourth = third?.nextElementSibling;
  const fifth = fourth?.nextElementSibling;
  if (
    first instanceof HTMLElement &&
    second instanceof HTMLElement &&
    third instanceof HTMLElement &&
    fourth instanceof HTMLElement &&
    fifth instanceof HTMLElement
  ) {
    return { title: first, synopsis: second, appearances: third, state: fourth, count: fifth };
  }
  const title = document.createElement("span");
  title.className = "nav-title";
  // The synopsis mark: a span rather than `.nav-title::after`, so it
  // sits outside the title's ellipsis clip (a long title used to cut it off)
  // and can carry a pointer tooltip saying what it means. Hidden from the
  // accessibility tree like its siblings; the description says it instead.
  const synopsis = document.createElement("span");
  synopsis.className = "nav-synopsis";
  synopsis.setAttribute("aria-hidden", "true");
  const appearances = document.createElement("span");
  appearances.className = "nav-appearances";
  // BETWEEN the title and the count, so the mark sits where the eye finishes
  // the title rather than past a number of varying width.
  const state = document.createElement("span");
  state.className = "nav-state";
  const count = document.createElement("span");
  count.className = "nav-count";
  // The name-from-content rule above, and it applies to the mark for the same
  // reason it applies to the count - more sharply, because a mark read aloud is
  // a character name, not a word. What a screen reader gets instead is the row's
  // aria-describedby, which is a different string on the same object and cannot
  // disturb the name. Not `role="presentation"`: these spans carry text, and
  // hiding it is the claim being made.
  state.setAttribute("aria-hidden", "true");
  appearances.setAttribute("aria-hidden", "true");
  count.setAttribute("aria-hidden", "true");
  el.replaceChildren(title, synopsis, appearances, state, count);
  return { title, synopsis, appearances, state, count };
}

/** The glyph, INSIDE `.nav-title`, before its text (W1, fixed after the
 *  initial ship painted the glyph as a sibling BEFORE `.nav-title` instead --
 *  which put it before the chevron too, since the chevron is
 *  `.nav-title::before` and a `::before` always renders before an element's
 *  real children, sibling or not. Nesting the glyph as `.nav-title`'s own
 *  first child fixes the order for free: chevron (the pseudo-element),
 *  glyph, title text, in that order, with no separate stacking rule needed.
 *
 *  NO GLYPH IS THE EARLIER SHAPE EXACTLY: a bare text node, nothing else, so
 *  a manuscript row (or a matter document) reserves no icon-sized slot a
 *  stray empty span would still take up. `title.textContent = text` below
 *  both sets the text AND clears any glyph a recycled element used to hold,
 *  in one call - the same recycling guarantee `data-type` and
 *  `data-first-reserved` document elsewhere in this file. */
function paintTitle(title: HTMLElement, text: string, iconName: IconName | undefined): void {
  if (iconName === undefined) {
    title.textContent = text;
    return;
  }
  const icon = document.createElement("span");
  icon.className = "nav-icon";
  // The row's name is its title text, never the glyph: `createIcon` already
  // marks the `<svg>` itself `aria-hidden`, and the wrapping span repeats it
  // so the row's accessible name is unchanged even if this span ever gained
  // text content of its own.
  icon.setAttribute("aria-hidden", "true");
  icon.appendChild(createIcon(iconName));
  title.replaceChildren(icon, document.createTextNode(text));
}

/** The five sentences a row's `aria-describedby` points at, mounted once.
 *
 *  VISUALLY HIDDEN RATHER THAN `hidden`. A description is computed from the
 *  referenced element's text, and `display: none` content is only conditionally
 *  included by that computation; the clip technique leaves the text in the
 *  layout tree, where every implementation agrees it counts.
 *
 *  Returns a teardown. Idempotent by id, because a project switch builds a
 *  second navigator while the first is being torn down. */
function mountStateDescriptions(): () => void {
  const HOLDER_ID = "nav-state-descriptions";
  if (document.getElementById(HOLDER_ID) !== null) return () => undefined;
  const holder = document.createElement("div");
  holder.id = HOLDER_ID;
  // Not aria-hidden: the whole point is that a screen reader can read these
  // when a row points at one. It is hidden from SIGHT, by the stylesheet.
  for (const state of REVISION_STATES) {
    const span = document.createElement("span");
    span.id = stateDescriptionId(state);
    span.textContent = STATE_LABELS[state];
    holder.append(span);
  }
  // A sixth sentence, for the synopsis mark. Same holder, same clip.
  const synopsis = document.createElement("span");
  synopsis.id = SYNOPSIS_DESCRIPTION_ID;
  synopsis.textContent = t("nav.synopsis.described");
  holder.append(synopsis);
  const appearances = document.createElement("span");
  appearances.id = APPEARANCES_DESCRIPTION_ID;
  appearances.textContent = t("nav.appearances.described");
  holder.append(appearances);
  const words = document.createElement("span");
  words.id = WORD_DESCRIPTION_ID;
  holder.append(words);
  document.body.append(holder);
  return () => holder.remove();
}

function nodesFrom(source: TreeSource): TreeNode[] {
  const out: TreeNode[] = [];
  for (let i = 0; i < source.count; i++) {
    out.push({
      id: source.idAt(i),
      parentId: source.items?.[i]?.parent_id ?? null,
      depth: source.depthAt?.(i) ?? 0,
      title: source.titleAt(i),
      itemType: source.typeAt?.(i),
      state: source.stateAt?.(i),
    });
  }
  return out;
}

export function createNavigator(opts: NavigatorOptions): ManuscriptNavigator {
  const {
    container, source, rowHeight, overscan, mode, onActivate, onMove, onRemove, onSelect,
    onContextMenu, onUndo, onRedo,
  } = opts;
  let nodes = nodesFrom(source);
  const collapsed = new Set<string>();
  let openId: string | null = null;
  let active = 0;
  /** Word counts per row, containers rolled up. Empty until the page hands them
   *  over, which is after the first flush ack - so a manuscript opens with
   *  titles and gains its figures a moment later rather than waiting on them. */
  let counts: ReadonlyMap<string, number> = new Map();
  let sidebarWordCounts = opts.sidebarWordCounts ?? DEFAULT_SIDEBAR_WORD_COUNTS;
  let synopses: ReadonlySet<string> = new Set();
  let appearances: ReadonlySet<string> = new Set();
  let visible: VisibleRow[] = project(nodes, collapsed);
  // Recomputed only where `nodes` itself changes (the constructor and
  // `reload`), never by a collapse or a selection move: it is a property of
  // the WALK, and reprojecting the visible rows does not change which root is
  // first in it.
  let firstReservedRootId: string | null = firstReservedRootOf(nodes);

  /** The gap's position for the virtual list: the first reserved root's
   *  VISIBLE index, not its walk index -- collapsing a part above it changes
   *  how far down the pane it sits even though `firstReservedRootId` itself
   *  has not moved. Recomputed on every reproject, alongside `visible`
   *  itself, and handed to the list through `setGapIndex`. */
  function gapIndexOf(): number | null {
    if (firstReservedRootId === null) return null;
    const at = visible.findIndex((r) => r.id === firstReservedRootId);
    return at >= 0 ? at : null;
  }

  // Element ids name the ITEM, via its position in the full walk, not its
  // position in the visible list. A visible index is reassigned to a different
  // item by every collapse, so an id built from one would leave
  // aria-activedescendant silently pointing at the wrong scene instead of at
  // nothing.
  const walkIndex = new Map<string, number>();
  function indexWalk(): void {
    walkIndex.clear();
    for (let i = 0; i < nodes.length; i++) walkIndex.set(nodes[i]!.id, i);
  }
  indexWalk();
  function domIdOf(id: string): string {
    const at = walkIndex.get(id);
    if (at === undefined) throw new Error(`navigator: row ${id} is not in the walk`);
    return `nav-row-${at}`;
  }

  const unmountStateDescriptions = mountStateDescriptions();

  container.setAttribute("role", "tree");
  container.setAttribute("aria-label", t("nav.label"));
  container.tabIndex = 0;
  const hints = createNavigatorHints(container);

  // aria-setsize and aria-posinset carry the row's OWN sibling group on every
  // row regardless of how many are mounted: assistive technology must be told
  // the truth about the set, not about the window.
  function paint(index: number, el: HTMLElement): void {
    const row = visible[index];
    if (!row) {
      // Unreachable from `reproject` NOW THAT setCount runs before
      // setGapIndex there (see reproject's own comment) - every render from
      // this point bounds itself by the new count, so `index` never reaches
      // past `visible`'s end. Kept as a guard rather than an assert, because a
      // future caller of setCount/setGapIndex directly is one this branch
      // should still survive. Blank rather than leave another item's ARIA
      // standing.
      for (const attr of ROW_ATTRS) el.removeAttribute(attr);
      el.removeAttribute("data-item-id");
      // BOTH spans, not `textContent = ""`, which would delete them and make
      // the next paint rebuild a pair this element already had.
      const blank = partsOf(el);
      blank.title.textContent = "";
      blank.state.textContent = "";
      blank.count.textContent = "";
      for (const part of Object.values(blank)) delete part.dataset.navHint;
      return;
    }
    el.id = domIdOf(row.id);
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(row.depth + 1));
    el.setAttribute("aria-posinset", String(row.posinset));
    el.setAttribute("aria-setsize", String(row.setsize));
    if (row.hasChildren) el.setAttribute("aria-expanded", String(row.expanded));
    else el.removeAttribute("aria-expanded");
    // The indent step style.css keys its padding-left on. Two things about it
    // are deliberate.
    //
    // It reads `row.depth` - the walk the navigator already holds - and NOT the
    // aria-level attribute set two lines above. aria-level is the accessibility
    // contract's OUTPUT; driving layout from it would couple the pane's
    // appearance to a value the contract is allowed to change independently
    // (it is 1-based, it is capped by nothing, and correcting it one day must
    // not silently re-lay-out the tree). One walk, two consumers, no
    // round-trip through the DOM.
    //
    // And it is written on EVERY paint, not on mount. Both the virtual list and
    // mountNaive repaint recycled elements in place: a row element that last
    // held a depth-3 beat is reused for a depth-0 part on the next collapse, so
    // an indent set once at creation is the wrong indent forever after.
    el.dataset.indent = String(Math.min(row.depth, INDENT_CAP));
    // WHAT the row is, alongside how deep it sits. style.css sets a part in
    // spaced capitals and a chapter in a heavier weight, so the outline reads as
    // a structure rather than as a wall of identically-set titles.
    //
    // Not derived from depth, and that is the point: the product spec makes the
    // hierarchy arbitrary and forbids type-based parent constraints, so a part
    // nested inside a scene is legal and still has to read as a part. Depth and
    // type answer different questions and are painted from different fields.
    //
    // Written on EVERY paint and DELETED when absent, for the recycling reason
    // data-indent documents above: an element that last held a part is reused
    // for a scene, and a type set only when present would leave the row set in
    // capitals forever. A corpus source supplies no types at all, which is the
    // case the delete branch exists for.
    if (row.itemType === undefined) delete el.dataset.type;
    else el.dataset.type = row.itemType;
    // THE SEPARATOR'S ANCHOR. Written on EVERY paint and DELETED
    // when absent, for the recycling reason every other data attribute here
    // is: a row element that last held the first reserved root is reused for
    // an ordinary chapter on the next reproject, and an attribute set only
    // when true would leave the line drawn under a chapter nobody meant to
    // mark. style.css draws the separator's `::before` from this attribute
    // alone, into the 16px gap `gapIndexOf`/`setGapIndex` open above this row
    // in the virtual list -- see that rule for why the line lives in the gap
    // rather than inside the row's own ROW_HEIGHT box.
    if (row.id === firstReservedRootId) el.dataset.firstReserved = "true";
    else delete el.dataset.firstReserved;
    // WHERE THE ROW STANDS. Two channels that say the same thing and neither of
    // which is the accessible NAME: a mark the stylesheet also tints, and a
    // description pointing at one of five sentences mounted once. The mark alone
    // would leave a screen-reader user with nothing; the colour alone would
    // leave a reader who cannot tell two of the tints apart with nothing.
    //
    // Written on EVERY paint and DELETED when absent, for the recycling reason
    // data-indent documents above: a row element that last held a `done` chapter
    // is reused for an unmarked scene, and a state written only when present
    // would leave the old mark, the old tint and - worst of the three - a
    // description saying "Done" on a row nobody has marked.
    //
    // A state this build does not know is treated as no state at all: it can
    // only come from a newer build, and drawing an unknown mark or pointing at a
    // description element that does not exist are both worse than drawing
    // nothing.
    // WHETHER THE ROW HAS A SYNOPSIS, same two channels: an attribute the
    // stylesheet draws a mark from, and a description. Written on every paint
    // and deleted when absent, for the recycling reason above. The two
    // descriptions share one aria-describedby, space-separated, which is what
    // the attribute is for.
    const hasSynopsis = synopses.has(row.id);
    const hasAppearances = row.itemType === "scene" && appearances.has(row.id);
    if (hasSynopsis) el.dataset.synopsis = "true";
    else delete el.dataset.synopsis;
    if (hasAppearances) el.dataset.appearances = "true";
    else delete el.dataset.appearances;
    const described: string[] = [];
    if (isRevisionState(row.state)) {
      el.dataset.state = row.state;
      described.push(stateDescriptionId(row.state));
    } else {
      delete el.dataset.state;
    }
    if (hasSynopsis) described.push(SYNOPSIS_DESCRIPTION_ID);
    if (hasAppearances) described.push(APPEARANCES_DESCRIPTION_ID);
    const showCount = (row.itemType === "scene" || row.itemType === "chapter" || row.itemType === "part")
      && sidebarWordCounts[row.itemType] && counts.has(row.id);
    if (index === active && showCount) {
      const words = document.getElementById(WORD_DESCRIPTION_ID);
      if (words !== null) words.textContent = t("nav.words.described", { count: formatCount(counts.get(row.id)) });
      described.push(WORD_DESCRIPTION_ID);
    }
    if (described.length > 0) el.setAttribute("aria-describedby", described.join(" "));
    else el.removeAttribute("aria-describedby");
    // The ITEM id, not the visible index: a visible index is reassigned to a
    // different item by every collapse, so a click handler resolving one would
    // open the wrong scene.
    el.dataset.itemId = row.id;
    // aria-selected is where the keyboard is; aria-current is the document the
    // editor is actually showing. They are different rows whenever the reader
    // arrows around, which is why both exist.
    if (index === active) el.setAttribute("aria-selected", "true");
    else el.removeAttribute("aria-selected");
    if (row.id === openId) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
    const parts = partsOf(el);
    // THE GLYPH, BEFORE THE TITLE. undefined for every row type not in
    // the table -- the manuscript's part/chapter/scene rows and a matter
    // document -- which paintTitle turns into the exact earlier shape, so
    // those rows reserve no icon-sized slot.
    const iconName = row.itemType === undefined ? undefined : ROW_ICONS[row.itemType];
    paintTitle(parts.title, row.title, iconName);
    // A recycled element may carry the tip the last row's hover measured.
    parts.title.removeAttribute("title");
    parts.synopsis.textContent = hasSynopsis ? "\u00a7" : "";
    parts.synopsis.removeAttribute("title");
    parts.appearances.textContent = hasAppearances ? "\u25c6" : "";
    parts.state.textContent = markFor(row.state);
    // The subtree's total for a container, the document's own for a scene, and
    // NOTHING for an item nothing countable sits under - see outline-counts.ts
    // for why that is not a zero.
    parts.count.textContent = showCount ? formatCount(counts.get(row.id)) : "";
    const descriptions = [
      [parts.synopsis, hasSynopsis ? t("nav.synopsis.described") : ""],
      [parts.appearances, hasAppearances ? t("nav.appearances.described") : ""],
      [parts.state, isRevisionState(row.state) ? t("nav.state.described", { state: STATE_LABELS[row.state] }) : ""],
      [parts.count, showCount ? t("nav.words.described", { count: parts.count.textContent }) : ""],
    ] as const;
    for (const [part, description] of descriptions) {
      if (description) part.dataset.navHint = description;
      else delete part.dataset.navHint;
    }
  }

  let list: VirtualList | null = null;
  function mountNaive(): void {
    container.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < visible.length; i++) {
      const el = document.createElement("div");
      el.style.cssText = `height:${rowHeight}px;`;
      paint(i, el);
      frag.appendChild(el);
    }
    container.appendChild(frag);
  }

  if (mode === "virtual") {
    list = createVirtualList({
      container, count: visible.length, rowHeight, overscan, renderRow: paint,
      gapIndex: gapIndexOf(),
    });
  } else {
    mountNaive();
  }

  // Selection and open state live in two rows' attributes, so a move repaints
  // two rows rather than reprojecting the whole list.
  //
  // Branches on `list`, not on the mode string: virtual rows live inside the
  // spacer and are keyed by a Map, naive rows are direct children. The naive
  // lookup is only correct because mountNaive puts nothing else in the
  // container - a sibling element added there later would silently repaint the
  // wrong node, with no error.
  function repaintRow(index: number): void {
    if (index < 0 || index >= visible.length) return;
    if (list !== null) list.repaint(index);
    else {
      const el = container.children[index];
      if (el instanceof HTMLElement) paint(index, el);
    }
  }

  function setSynopses(next: ReadonlySet<string>): void {
    synopses = next;
    repaintMounted();
  }

  function setAppearances(next: ReadonlySet<string>): void {
    appearances = next;
    repaintMounted();
  }

  function setCounts(next: ReadonlyMap<string, number>): void {
    counts = next;
    repaintMounted();
  }

  function repaintMounted(): void {
    hints.hide();
    // repaint() PER MOUNTED ROW, and NOT `refresh()`, which is the method whose
    // name says otherwise. `refresh` is `render`, and `render` opens with an
    // early return when the mounted RANGE is unchanged - which is exactly the
    // case here, because new figures do not scroll the pane. It would repaint
    // nothing at all, silently, and the counts would appear only when the writer
    // next scrolled. Same shape as the recorded ResizeObserver defect: a
    // function that reads what it needs freshly, called only from the paths that
    // change geometry.
    //
    // setCount is wrong for a different reason - it would rebuild the range and
    // reset the scroll position the writer had - and a reprojection would
    // rebuild the visible array for a change that cannot alter it.
    if (list !== null) {
      const range = list.mountedRange();
      for (let i = range.start; i < range.end; i++) list.repaint(i);
      return;
    }
    for (let i = 0; i < container.children.length; i++) {
      const el = container.children[i];
      if (el instanceof HTMLElement) paint(i, el);
    }
  }

  function setActive(index: number): void {
    const previous = active;
    active = Math.max(0, Math.min(visible.length - 1, index));
    const row = visible[active];
    list?.scrollToIndex(active); // mounts the row before we point at it
    if (row) container.setAttribute("aria-activedescendant", domIdOf(row.id));
    else container.removeAttribute("aria-activedescendant");
    if (previous !== active) repaintRow(previous);
    repaintRow(active);
    hints.refresh();
  }
  setActive(0);

  function activateSelected(): void {
    const row = visible[active];
    if (row) onActivate?.(row.id);
  }

  /** Report where the selection now is.
   *
   *  Called from the real click and keydown listeners, NEVER from setActive,
   *  and that placement is the whole point. setActive is reachable from
   *  handleKey, which the synthetic measurement workload calls directly for
   *  tens of thousands of navigation actions; a listener hung off it would run
   *  the subscriber's work - an ancestor walk over a 20,060-row array, at the
   *  stress fixture - on every measured key. Activation lives outside handleKey
   *  for the same reason, and so does Alt+Arrow.
   *
   *  A human pressing an arrow key reaches this; a soak cannot. Pinned by a
   *  test. */
  function announceSelection(): void {
    onSelect?.(visible[active]?.id ?? null);
  }

  function reproject(keepId: string): void {
    visible = project(nodes, collapsed);
    if (list !== null) {
      // COUNT FIRST. Gap-first was tried and is wrong: setGapIndex's own
      // render() mounts rows using the list's OLD (pre-shrink) count, so a
      // collapse that drops rows below the reserved section can mount an
      // index past the END of the just-reprojected `visible` array before
      // setCount ever runs - and `paint` then reads `visible[index]` as
      // undefined and blanks a row this call was never meant to touch. Count
      // first means every render from here on, including setGapIndex's own,
      // bounds itself by the new (correct) count - see virtual-list.ts's
      // `render`, whose end is `Math.min(count, ...)`.
      list.setCount(visible.length);
      list.setGapIndex(gapIndexOf());
    } else mountNaive();
    const next = visible.findIndex((r) => r.id === keepId);
    setActive(next >= 0 ? next : 0);
  }

  const pageSize = (): number =>
    Math.max(1, Math.floor((container.clientHeight || rowHeight * 10) / rowHeight));

  // In a depth-first projection the parent is the nearest preceding row at a
  // shallower depth, so this walks the current subtree rather than the whole
  // list. A scan from the top would be O(rows) on every ArrowLeft.
  function parentIndexOf(index: number): number {
    const row = visible[index];
    if (!row?.parentId) return index;
    for (let i = index - 1; i >= 0; i--) {
      const candidate = visible[i];
      if (candidate === undefined || candidate.depth >= row.depth) continue;
      return candidate.id === row.parentId ? i : index;
    }
    return index;
  }

  function handleKeyInternal(key: string): void {
    const row = visible[active];
    if (key === "ArrowRight" && row) {
      if (row.hasChildren && !row.expanded) {
        collapsed.delete(row.id);
        reproject(row.id);
      } else if (row.hasChildren) {
        // An expanded branch always has a next visible row, and depth-first
        // order makes it the first child. setActive clamps regardless.
        setActive(active + 1);
      }
      return;
    }
    if (key === "ArrowLeft" && row) {
      if (row.hasChildren && row.expanded) {
        collapsed.add(row.id);
        reproject(row.id);
      } else {
        setActive(parentIndexOf(active));
      }
      return;
    }
    const target =
      key.length === 1 && key !== " "
        ? typeAheadIndex(key, active, visible.length, (i) => visible[i]?.title ?? "")
        : nextIndex(key, active, visible.length, pageSize());
    if (target !== active) setActive(target);
  }

  // Real input. Installed unconditionally, in both run modes: the synthetic
  // workload dispatches no DOM events, so a listener the measured run does not
  // exercise is still the same listener the shipped one has.
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest("[data-item-id]");
    if (!(row instanceof HTMLElement)) return;
    const itemId = row.dataset.itemId;
    if (itemId === undefined) return;
    const at = visible.findIndex((r) => r.id === itemId);
    if (at >= 0) setActive(at);
    announceSelection();
    onActivate?.(itemId);
  };

  /** Where a row sits on screen, for a menu that opens at it.
   *
   *  The element's own box when it is mounted; the pane's top-left when it is
   *  not, which under the virtual list is the ordinary case for a row the
   *  keyboard has scrolled to but the pointer never touched. Never throws and
   *  never returns nothing: a menu that silently declines to open is
   *  indistinguishable from a key that is not bound. */
  function anchorOf(itemId: string): { x: number; y: number } {
    // Scanned rather than selected: an item id is store data and a selector
    // built from it would need escaping the runtime need not provide.
    let el: HTMLElement | null = null;
    for (const candidate of container.querySelectorAll("[data-item-id]")) {
      if (candidate instanceof HTMLElement && candidate.dataset.itemId === itemId) {
        el = candidate;
        break;
      }
    }
    const box = (el ?? container).getBoundingClientRect();
    return { x: box.left, y: box.bottom };
  }

  /** Move the selection onto a row and say so, then hand it to the caller.
   *  ONE path for the pointer and the keyboard, so the two cannot drift on the
   *  rule that decides correctness. */
  function openContextMenu(itemId: string, x: number, y: number): void {
    const at = visible.findIndex((r) => r.id === itemId);
    if (at < 0) return;
    // FIRST, and this is rule one of the slice: a menu that opens on a row it
    // has not selected acts on whatever was selected before it.
    setActive(at);
    announceSelection();
    onContextMenu?.(itemId, x, y);
  }

  // SCOPED TO #nav AND NOTHING ELSE. A document-level suppression would take the
  // editor's native menu with it, and that menu carries WebKitGTK's spelling
  // suggestions - the whole of what the spelling slice delivered. Nothing in the
  // suite would notice, because no test and no gate looks at a menu the engine
  // draws.
  const onContextMenuEvent = (event: Event): void => {
    // Suppressed across the whole pane, not only over a row: the engine's menu
    // on the navigator's blank space offers a writer nothing this application
    // means, and half a suppression reads as a bug in the other half.
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest("[data-item-id]");
    if (!(row instanceof HTMLElement)) return;
    const itemId = row.dataset.itemId;
    if (itemId === undefined) return;
    const at = event instanceof MouseEvent
      ? { x: event.clientX, y: event.clientY }
      : anchorOf(itemId);
    openContextMenu(itemId, at.x, at.y);
  };

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    // Alt+Arrow is a structural command. It lives here rather than in
    // handleKeyInternal for the same reason activation does: the synthetic
    // measurement workload calls handleKey directly, and a measured soak must
    // not be able to rewrite the tree it is measuring.
    //
    // Above the modifier guard below, which Alt would otherwise hit first. The
    // return is unconditional inside the branch: an Alt chord this UI does not
    // define must reach neither activation nor type-ahead, or Alt+r would jump
    // the selection to the first row starting with "r".
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const direction = MOVE_KEYS[event.key];
      const row = visible[active];
      if (direction !== undefined && row) {
        event.preventDefault();
        // No setActive: the store decides where the row lands, and reload
        // restores the selection by item id afterwards.
        onMove?.(row.id, direction);
      }
      return;
    }
    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y is structural undo/redo. Above the
    // modifier guard below for the same reason Alt+Arrow is above it: the
    // synthetic measurement workload drives handleKey directly, and a
    // measured soak must not be able to undo the tree it is measuring.
    //
    // Compared against a lower-cased LOCAL rather than the raw event property,
    // so a shifted press still matches. `help.ts` lists this chord by hand, as
    // the plan requires: it is a Ctrl combination and help.test.ts's own
    // navigator scan only ever reads Alt chords and bare-key comparisons out
    // of this file, so a Ctrl chord was never something that scan could see.
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      const lowered = event.key.toLowerCase();
      if (lowered === "z") {
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (lowered === "y") {
        event.preventDefault();
        onRedo?.();
        return;
      }
    }
    // A modified key is a command, not navigation. Without this, Ctrl+Z in the
    // navigator is a single printable character and type-ahead swallows it.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateSelected();
      return;
    }
    // Delete is a structural command and belongs here for the same reason
    // Alt+Arrow does: the synthetic measurement workload drives handleKey
    // directly, and a soak that deleted rows out of the tree it was measuring
    // would invalidate every gate it reported.
    //
    // BELOW the modifier guard above, so Ctrl+Delete and Alt+Delete are not
    // deletes. Nothing is destroyed by this, so there is no confirmation: the
    // row moves into the outline's bin and stays readable.
    if (event.key === "Delete") {
      event.preventDefault();
      const row = visible[active];
      if (row) onRemove?.(row.id);
      return;
    }
    // The keyboard route to the context menu, and it is here rather than in
    // handleKeyInternal for the reason Delete and Alt+Arrow are: the synthetic
    // measurement workload drives handleKey directly, and a soak that opened
    // menus would be measuring a surface no writer had asked for.
    //
    // The chord is a predicate in nav-context-menu.ts rather than two literals
    // here - see that module for why the shortcuts panel's guard makes that the
    // honest shape.
    if (isContextMenuChord(event)) {
      event.preventDefault();
      const row = visible[active];
      if (row) {
        const at = anchorOf(row.id);
        openContextMenu(row.id, at.x, at.y);
      }
      return;
    }
    const before = active;
    handleKeyInternal(event.key);
    // Only when we actually did something, so an unhandled key still reaches
    // the browser.
    if (active !== before) {
      event.preventDefault();
      announceSelection();
    }
  };

  /** The full title on hover, only where the ellipsis cut it. Measured
   *  when the pointer arrives, never on paint: paint is the scroll path. On the
   *  title span, whose text it repeats exactly, so the row's name is unchanged
   *  whichever way an engine weighs a `title` against content. */
  const onPointerOver = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const title = target.closest(".nav-title");
    if (!(title instanceof HTMLElement)) return;
    if (title.scrollWidth > title.clientWidth) title.title = title.textContent ?? "";
    else title.removeAttribute("title");
  };

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("contextmenu", onContextMenuEvent);
  container.addEventListener("mouseover", onPointerOver);

  return {
    activeIndex: () => active,
    activeTitle: () => visible[active]?.title ?? "",
    setSidebarWordCounts(next) {
      sidebarWordCounts = { ...next };
      repaintMounted();
    },
    setCounts,
    setSynopses,
    setAppearances,
    rows: () => visible,
    handleKey(key: string): void {
      handleKeyInternal(key);
    },
    selectById(itemId: string): void {
      const at = visible.findIndex((r) => r.id === itemId);
      if (at >= 0) setActive(at);
    },
    revealAndSelectById(itemId: string): void {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      let parentId = byId.get(itemId)?.parentId ?? null;
      while (parentId !== null) {
        collapsed.delete(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      reproject(itemId);
    },
    setOpen(itemId: string | null): void {
      const previous = openId;
      openId = itemId;
      for (const id of [previous, itemId]) {
        if (id === null) continue;
        const at = visible.findIndex((r) => r.id === id);
        if (at >= 0) repaintRow(at);
      }
    },
    activate(): void {
      activateSelected();
    },
    reload(next: TreeSource): void {
      const keepId = visible[active]?.id ?? null;
      nodes = nodesFrom(next);
      firstReservedRootId = firstReservedRootOf(nodes);
      // Before anything paints: element ids are `nav-row-<walkIndex>` and
      // domIdOf throws on an id it has not seen, so a repaint against a stale
      // index either names a row that no longer exists or dies on a new one.
      indexWalk();
      // An id no longer in the walk cannot be projected against, and leaving it
      // in the set would make a future item's collapse state arrive from
      // nowhere: `collapsed` is keyed by id, so a stale entry lies dormant
      // until that id returns and then collapses it for no reason the writer
      // can see.
      for (const id of [...collapsed]) if (!walkIndex.has(id)) collapsed.delete(id);
      if (openId !== null && !walkIndex.has(openId)) openId = null;
      // The selected row is still in the manuscript but has moved INSIDE a
      // collapsed branch - Alt+Right indents a row under a previous sibling the
      // writer had collapsed, which is the ordinary case. Preserving by id is
      // not enough there: the id is in `nodes` and not in `visible`, findIndex
      // returns -1, and the fallback drops the reader at row 0 with the row
      // they just moved nowhere on screen. Expanding its ancestors is
      // unambiguously right here and only here - the writer caused the move and
      // is entitled to see where it landed. Collapsing state everywhere else,
      // including on the moved row itself, is left exactly as they set it.
      if (keepId !== null && walkIndex.has(keepId)) {
        const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
        // Bounded by the node count: a cycle in a malformed walk must not hang
        // the page. project() rejects one a moment later anyway.
        const seen = new Set<string>();
        for (
          let ancestor = parentOf.get(keepId) ?? null;
          ancestor !== null && !seen.has(ancestor);
          ancestor = parentOf.get(ancestor) ?? null
        ) {
          seen.add(ancestor);
          collapsed.delete(ancestor);
        }
      }
      // reproject is the single rendering path: a second one here would be the
      // thing that drifts from collapse/expand.
      reproject(keepId ?? "");
      hints.hide();
    },
    destroy(): void {
      hints.destroy();
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("contextmenu", onContextMenuEvent);
      container.removeEventListener("mouseover", onPointerOver);
      list?.destroy();
      unmountStateDescriptions();
      container.removeAttribute("aria-activedescendant");
      container.replaceChildren();
    },
  };
}
