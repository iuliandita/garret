// app/ui/src/cast-card.ts
// A cast member's sheet, floated under their name in the prose (098, W5).
//
// NO HOST CALL ON HOVER. `project.ts` already holds the cast list it loaded
// for the panel and for cast-marks.ts's own feed; this unit is handed a
// lookup into that same list, never a fetch of its own -- a round trip on
// every `pointerenter` would be the keystroke-path mistake this feature's own
// design record warns against, aimed at the pointer instead of the keyboard.
//
// ON <body>, LIKE #format-bubble AND FOR THE SAME REASON: `#editor {
// will-change: transform }` (064's memory fix) holds only while #editor has
// no positioned descendant, so this card is a sibling of #format-bubble and
// #nav-context-menu, never a child of the pane it floats over.
//
// TWO TIMERS, NOT ONE. Format-bubble debounces a single event (the selection
// coming to rest); this debounces an ENTER and, independently, an EXIT --
// 450 ms before the card appears (long enough that a pointer merely crossing
// a name on its way somewhere else never triggers it), 200 ms after the
// pointer leaves before it goes (long enough to cross the gap onto the card
// itself, which cancels the hide the same way format-bubble's own blur check
// cancels on a move into its own toolbar).
//
// NEVER TAKES FOCUS. `role="tooltip"` promises exactly that: a screen reader
// hears it through `aria-describedby` on the marked run, which this unit
// sets while the card is up and clears when it is not -- never through the
// card's own DOM position, which is a sibling of the prose it describes and
// not adjacent to it in the accessibility tree.
import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { createIcon, type IconName } from "./icons";
import { CAST_MARK_CLASS } from "./cast-marks";
import { kindIconFor } from "./cast-kinds";

export const CAST_CARD_ID = "cast-card";
export const DEFAULT_SHOW_MS = 450;
export const DEFAULT_HIDE_MS = 200;
/** Up to this many fields are shown; the sheet's own full list is what "Open
 *  in Cast" is for. */
const MAX_FIELDS = 3;

export interface CastCardMember {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly summary: string;
  readonly fields: readonly { label: string; value: string }[];
}

export interface CastCardRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface CastCardSize {
  width: number;
  height: number;
}
export interface CastCardPlaced {
  left: number;
  top: number;
}

/** Under the marked run, 8px of gap; above it when there is no room below.
 *  Clamped horizontally to the viewport, so a name near the right edge does
 *  not float the card half off screen. Pure, for the reason
 *  `bubble-placement.ts` is: happy-dom does no layout. */
export function placeCastCard(input: {
  mark: CastCardRect;
  card: CastCardSize;
  viewport: CastCardRect;
}): CastCardPlaced {
  const { mark, card, viewport } = input;
  const GAP = 8;
  const maxLeft = Math.max(viewport.left, viewport.right - card.width);
  const left = Math.min(maxLeft, Math.max(viewport.left, mark.left));
  const below = mark.bottom + GAP + card.height <= viewport.bottom;
  const top = below
    ? mark.bottom + GAP
    : Math.max(viewport.top, mark.top - GAP - card.height);
  return { left, top };
}

export interface CastCardDeps {
  /** <body>. */
  container: HTMLElement;
  /** The current cast list, already loaded elsewhere -- no fetch here. */
  memberFor: (memberId: string) => CastCardMember | undefined;
  /** Open the cast panel on this member. Second caller of whatever
   *  `menuActions.openCast` already opens, on the toolbar buttons' own rule:
   *  a control here must not be a second implementation of opening the
   *  panel. */
  openInCast: (memberId: string) => void;
  showMs?: number;
  hideMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** The card's own size, for the placement clamp. Defaults to
   *  `card.getBoundingClientRect()`; injectable because happy-dom answers
   *  0x0 for every element, `format-bubble.ts`'s own reason for the same
   *  seam. */
  measure?: () => CastCardSize;
  /** The viewport rect the card is clamped inside. Defaults to
   *  `window.innerWidth/innerHeight`; injectable for the same reason. */
  viewport?: () => CastCardRect;
}

export interface CastCard {
  /** The caret sits inside `element`, naming `memberId`: show at once, no
   *  debounce -- Ctrl+Shift+I is a deliberate press, not a pointer that might
   *  be passing through. */
  showFor(element: HTMLElement, memberId: string): void;
  /** An editor transaction changed the document: hide at once. A card
   *  floating over prose that just changed under it would be describing text
   *  that may no longer be there. */
  onDocChanged(): void;
  hide(): void;
  shown(): boolean;
  destroy(): void;
}

function iconFor(kind: string): IconName | null {
  return kindIconFor(kind);
}

/** Ctrl+Shift+I (Cmd+Shift+I), or false. A pure predicate, `isAddCommentChord`
 *  in comments.ts's own reason: the listener that reads this is on the
 *  document and cannot be reached by a test without a page, and a chord that
 *  is nearly right is a chord that fires on the wrong keystroke.
 *
 *  REFUSES AN ALREADY-PREVENTED EVENT, the same rule `isAddCommentChord`
 *  follows: a surface that has already claimed this keystroke keeps it. */
export function isShowCastCardChord(event: KeyboardEvent): boolean {
  if (isCompositionKey(event)) return false;
  if (event.defaultPrevented) return false;
  if (event.key.toLowerCase() !== "i") return false;
  if (!event.shiftKey) return false;
  return event.ctrlKey || event.metaKey;
}

export function createCastCard(deps: CastCardDeps): CastCard {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => window.clearTimeout(h as number));
  const showMs = deps.showMs ?? DEFAULT_SHOW_MS;
  const hideMs = deps.hideMs ?? DEFAULT_HIDE_MS;
  const measure =
    deps.measure ??
    ((): CastCardSize => {
      const box = card.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
  const viewport =
    deps.viewport ??
    ((): CastCardRect => ({
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    }));

  const card = document.createElement("div");
  card.id = CAST_CARD_ID;
  card.setAttribute("role", "tooltip");
  card.hidden = true;

  const header = document.createElement("div");
  header.className = "cast-card-header";
  const icon = document.createElement("span");
  icon.className = "cast-card-icon";
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("div");
  name.className = "cast-card-name";
  // An id for the rigs: a plain div gets no accessible name, and bible-cli
  // reads the card's name through the id-keyed text walk (105).
  name.id = "cast-card-name";
  header.append(icon, name);

  const summary = document.createElement("p");
  summary.className = "cast-card-summary";

  const fields = document.createElement("dl");
  fields.className = "cast-card-fields";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.id = "cast-card-open";
  openButton.textContent = t("cast.card.open");
  openButton.dataset.weight = "quiet";

  card.append(header, summary, fields, openButton);
  deps.container.append(card);

  let destroyed = false;
  let overMark = false;
  let overCard = false;
  let currentMark: HTMLElement | null = null;
  let describedMark: HTMLElement | null = null;
  let shownMemberId: string | null = null;
  let showTimer: unknown = null;
  let hideTimer: unknown = null;

  function clearShowTimer(): void {
    if (showTimer !== null) {
      clearTimer(showTimer);
      showTimer = null;
    }
  }
  function clearHideTimer(): void {
    if (hideTimer !== null) {
      clearTimer(hideTimer);
      hideTimer = null;
    }
  }

  function paint(member: CastCardMember): void {
    icon.replaceChildren();
    const iconName = iconFor(member.kind);
    if (iconName !== null) icon.append(createIcon(iconName));
    name.textContent = member.name;
    summary.textContent = member.summary;
    summary.hidden = member.summary.trim() === "";
    fields.replaceChildren();
    for (const field of member.fields.slice(0, MAX_FIELDS)) {
      const dt = document.createElement("dt");
      dt.textContent = field.label;
      const dd = document.createElement("dd");
      dd.textContent = field.value;
      fields.append(dt, dd);
    }
    fields.hidden = member.fields.length === 0;
  }

  function place(mark: HTMLElement): void {
    const markRect = mark.getBoundingClientRect();
    const size = measure();
    const placed = placeCastCard({ mark: markRect, card: size, viewport: viewport() });
    card.style.left = `${placed.left}px`;
    card.style.top = `${placed.top}px`;
  }

  function show(mark: HTMLElement, memberId: string): void {
    if (destroyed) return;
    const member = deps.memberFor(memberId);
    // The member vanished (deleted) between the pointer arriving and the
    // debounce firing. Nothing to show, and no error: a hover racing a
    // delete is an ordinary thing to happen.
    if (member === undefined) return;
    paint(member);
    card.hidden = false;
    shownMemberId = memberId;
    // ONE DESCRIBED MARK AT A TIME. A previous mark's aria-describedby is
    // cleared before this one is set, so a screen reader is never told two
    // runs share the one tooltip that is actually up.
    if (describedMark !== null && describedMark !== mark) {
      describedMark.removeAttribute("aria-describedby");
    }
    mark.setAttribute("aria-describedby", CAST_CARD_ID);
    describedMark = mark;
    place(mark);
  }

  function hide(): void {
    clearShowTimer();
    clearHideTimer();
    overMark = false;
    overCard = false;
    currentMark = null;
    shownMemberId = null;
    if (card.hidden) return;
    card.hidden = true;
    if (describedMark !== null) {
      describedMark.removeAttribute("aria-describedby");
      describedMark = null;
    }
  }

  function scheduleHide(): void {
    // A pending SHOW is cancelled here too: a pointer that crosses a mark
    // between 250 and 450 ms after entering has left before `scheduleShow`'s
    // own timer fires, and without this the show timer fires anyway and
    // flashes the card up just as the hide it raced is also scheduled.
    clearShowTimer();
    clearHideTimer();
    hideTimer = setTimer(() => {
      hideTimer = null;
      hide();
    }, hideMs);
  }

  function scheduleShow(mark: HTMLElement, memberId: string): void {
    clearHideTimer();
    // The pointer is already resting on the mark the card is showing (or
    // about to show) for -- moving within the same run must not restart the
    // debounce, which `onPointerOver`'s own guard keeps this from ever
    // reaching for anyway; kept as a second guard because a plugin recompute
    // between two `pointerover` events can hand back a DIFFERENT element
    // node for the identical name.
    if (shownMemberId === memberId && !card.hidden) return;
    clearShowTimer();
    showTimer = setTimer(() => {
      showTimer = null;
      show(mark, memberId);
    }, showMs);
  }

  function onPointerOver(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const mark = target.closest<HTMLElement>(`.${CAST_MARK_CLASS}`);
    if (mark !== null) {
      overMark = true;
      const memberId = mark.dataset.memberId;
      if (memberId === undefined) return;
      currentMark = mark;
      scheduleShow(mark, memberId);
      return;
    }
    if (target.closest(`#${CAST_CARD_ID}`) !== null) {
      overCard = true;
      clearHideTimer();
    }
  }

  function onPointerOut(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const related = event.relatedTarget;
    const leavingMark = target.closest<HTMLElement>(`.${CAST_MARK_CLASS}`);
    if (leavingMark !== null && leavingMark === currentMark) {
      // THE FLAG BEING LEFT, ALWAYS -- this used to return before reaching
      // this line whenever `related` was inside the card, which left
      // `overMark` stuck true. That stale true is invisible here (the guard
      // below reads `overCard`, not `overMark`) but poisons the LATER
      // pointerout off the card: `!overMark && !overCard` found `overMark`
      // still true and never scheduled the hide that departure was owed.
      overMark = false;
      if (related instanceof Node && card.contains(related)) {
        // Moving straight onto the card -- not a loss, and settled at once
        // rather than waiting for the card's own pointerover, which would
        // leave a gap between this event and that one for a hide to arm in.
        overCard = true;
        clearHideTimer();
      }
      if (!overMark && !overCard) scheduleHide();
      return;
    }
    if (target.closest(`#${CAST_CARD_ID}`) !== null) {
      overCard = false;
      if (related instanceof Node && currentMark?.contains(related) === true) {
        overMark = true;
        clearHideTimer();
      }
      if (!overMark && !overCard) scheduleHide();
    }
  }

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Escape") return;
    if (card.hidden) return;
    hide();
  }

  function onScroll(): void {
    hide();
  }

  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("keydown", onKeyDown);
  // Capture phase, `format-bubble.ts`'s own reason: #editor's own scroll box
  // is what moves, and a bubble-phase listener on document would miss a
  // scroll that never bubbles that far.
  document.addEventListener("scroll", onScroll, true);

  openButton.addEventListener("click", () => {
    const memberId = shownMemberId;
    if (memberId === null) return;
    deps.openInCast(memberId);
    hide();
  });

  return {
    showFor(element: HTMLElement, memberId: string): void {
      clearShowTimer();
      clearHideTimer();
      currentMark = element;
      show(element, memberId);
    },
    onDocChanged(): void {
      hide();
    },
    hide,
    shown: () => !card.hidden,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      hide();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      card.remove();
    },
  };
}
