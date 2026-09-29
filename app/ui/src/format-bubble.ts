// app/ui/src/format-bubble.ts
// A toolbar that rides the selection instead of sitting in the header.
//
// Bold, italic and underline used to be three buttons
// on the project bar's own line box (format-bar.ts, retired the slice this
// module lands in), always on screen and never near what they act on. This
// one appears 250ms after a selection comes to rest, centred above it, and
// goes away the moment the selection collapses or the editor loses focus. Add
// comment and Find in manuscript ride along: both already act on the current
// selection, and a writer reaching for either was reaching across the header
// to do it.
//
// ON <body>, POSITION: FIXED, NOT A CHILD OF #editor. `#editor { will-change:
// transform }` is half of the fix for the memory climb this repo tracks (see
// ROADMAP item 1), and it holds only while #editor has NO positioned
// descendants -- a bubble absolutely positioned inside the scroll box would be
// exactly that. So this element lives beside #nav-context-menu, which is
// fixed on the body for the same reason, and its left/top are viewport
// coordinates written from bubble-placement.ts's pure answer.
//
// A BLUR TO THE BUBBLE ITSELF IS NOT A LOSS. Clicking Bold moves focus from
// the prose to the button -- ordinary DOM behaviour, and if that blur hid the
// toolbar the writer would be pressing a control that vanishes out from under
// the pointer mid-click on some browsers, and would never get the pressed
// state repainted after. `onBlur` checks `relatedTarget` against the bubble's
// own subtree and only treats the editor as unfocused when the writer's
// attention actually left both.
//
// THE DEBOUNCE EXISTS FOR THE DRAG, NOT FOR TASTE. A selection made by
// dragging fires a transaction, and therefore a call to `onSelection`, on
// every pointer move -- a toolbar that showed on the first of those would
// jump to a new spot every few pixels while the writer is still choosing what
// to select. Arming a timer and clearing it on every subsequent move is what
// makes it appear once the drag actually stops.
//
// A TOOLBAR, THIS TIME, ON THE MENU BAR'S OWN RULE. format-bar.ts was
// deliberately a `role="group"` because three Tab stops beside the menu
// titles could not honestly promise arrow-key navigation. This bar promises
// it and implements it: ONE tab stop into the group (roving `tabIndex`), then
// ArrowLeft/ArrowRight/Home/End move both the focus and which button is that
// one stop, same shape `menu-panel.ts` uses for its own list.
//
// EVERYTHING ELSE format-bar.ts SAID STILL HOLDS. The bar decides nothing:
// every button calls a dep, the editor owns the marks, and toggleBold/
// toggleItalic/toggleUnderline are second callers of the same `toggleMark`
// commands the keymap binds. The name lives on `aria-label`, out of the
// catalog, with a `createTooltip` beside it fed the same string so a sighted
// writer and a screen reader cannot be told two different things. Cancelled
// on `mousedown`, for the reason format-bar.ts recorded: by click time the
// browser has already moved focus, and a writer who presses a button and
// keeps typing must not lose their caret.
//
// FOCUS CAN LEAVE THE BUBBLE WITHOUT EVER TOUCHING THE EDITOR. Tab into a
// button, or press Enter on one, and focus is inside the bar; the editor's
// own blur already fired when focus first arrived here, so nothing further
// tells this unit when focus then leaves the bar for a THIRD element. A
// `focusout` listener on the bar itself is the other half of `onBlur`: same
// relatedTarget check, this time answering for the bar's own subtree instead
// of the editor's. Focus returning to the prose fires the editor's `onFocus`
// again, which this unit already knows how to answer.
//
// A SCROLL OR A RESIZE HIDES, IT DOES NOT FOLLOW. The bubble is `position:
// fixed` in viewport coordinates, so scrolling #editor out from under a live
// selection leaves it parked over whatever prose scrolled into its place.
// Re-placing it on every scroll tick would mean per-frame layout work
// exactly where 064's memory record says the scroll path has to stay cheap;
// hiding is one listener per event and, once the bar is hidden, no work at
// all on the ticks that follow. The next selection change shows it again,
// in the right place.

import { isCompositionKey } from "./composition-key";
import type { ActiveMarks } from "./editor";
import { createIcon, type IconName } from "./icons";
import { t } from "./i18n";
import { createTooltip, type Tooltip } from "./tooltip";
import { bubbleWanted, placeBubble, type Rect, type Size } from "./bubble-placement";
import { isOneWord } from "./word-at";

const DEFAULT_DEBOUNCE_MS = 250;

export interface FormatBubbleDeps {
  /** <body>: position: fixed, viewport coordinates -- see the header comment
   *  on why nothing here may live inside #editor. */
  container: HTMLElement;
  /** #editor's own box, the clamp placeBubble keeps the toolbar inside. */
  pane: () => Rect;
  selection: () => { from: number; to: number };
  selectionRect: () => Rect | null;
  selectedText: () => string;
  blocked?: () => boolean;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  addComment: () => void;
  findInBook: (query: string) => void;
  /** Add one word to the open book's dictionary (111). The control shows only
   *  while the selection IS one word (`isOneWord`), read at show time: a
   *  double-click on an underlined name is the whole reason it is here, and
   *  offering it over a sentence would be offering to add the sentence. */
  addToDictionary: (word: string) => void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** The shown bubble's own size, for placeBubble's clamp. Defaults to
   *  `bar.getBoundingClientRect()`; injectable because happy-dom answers
   *  0x0 for every element regardless of what it holds, so a real fallback
   *  constant here would be a guard nothing in an actual browser could ever
   *  reach -- a shown flex row holding five 24px buttons cannot measure
   *  zero. Tests inject the number they want to assert a placement against
   *  instead. */
  measure?: () => Size;
}

export interface FormatBubble {
  /** From the editor's onStateChange: repaint aria-pressed and re-arm the
   *  debounce against the selection this transaction leaves. Called once per
   *  transaction, a caret move included, the same rule format-bar.ts's
   *  setActive followed. */
  onSelection(): void;
  onFocus(): void;
  onBlur(event: FocusEvent): void;
  /** What the selection carries now. An unchanged reading writes nothing --
   *  see format-bar.ts's identical rule and its reasoning. */
  setActive(marks: ActiveMarks): void;
  /** Whether the bar is on screen right now -- the same state hide()/show()
   *  toggle on `bar.hidden`. chrome-fade.ts reads this to hold its hide
   *  timer rather than sliding #editor out from under a bubble resting on
   *  the selection (071). */
  shown(): boolean;
  destroy(): void;
}

interface Control {
  readonly element: HTMLButtonElement;
  readonly tip: Tooltip;
  /** Present only for the three marks. Add comment and Find act, they do not
   *  reflect a state, so they carry no aria-pressed at all -- an attribute
   *  that never changes is a promise the control cannot keep. */
  readonly reads?: (marks: ActiveMarks) => boolean;
}

export function createFormatBubble(deps: FormatBubbleDeps): FormatBubble {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => window.clearTimeout(handle as number));
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const bar = document.createElement("div");
  bar.id = "format-bubble";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("format.group.label"));
  bar.hidden = true;

  const measure =
    deps.measure ??
    ((): Size => {
      const box = bar.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });

  function control(
    id: string,
    icon: IconName,
    label: string,
    hint: string | null,
    run: () => void,
    reads?: (marks: ActiveMarks) => boolean,
  ): Control {
    const element = document.createElement("button");
    element.type = "button";
    element.id = id;
    // Roving tabindex: exactly one of the five is a tab stop at a time, and
    // that one is set to 0 once the whole row exists, below.
    element.tabIndex = -1;
    element.setAttribute("aria-label", label);
    element.append(createIcon(icon));
    if (reads !== undefined) element.setAttribute("aria-pressed", "false");
    element.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
    });
    element.addEventListener("click", () => {
      run();
    });
    const tip = createTooltip({ control: element, name: label, hint });
    bar.append(tip.anchor);
    return { element, tip, reads };
  }

  const controls: Control[] = [
    control("format-bold", "bold", t("format.bold"), null, deps.toggleBold, (m) => m.bold),
    control(
      "format-italic",
      "italic",
      t("format.italic"),
      null,
      deps.toggleItalic,
      (m) => m.italic,
    ),
    control(
      "format-underline",
      "underline",
      t("format.underline"),
      t("format.underline.hint"),
      deps.toggleUnderline,
      (m) => m.underline,
    ),
    control(
      "format-comment",
      "message-square",
      t("format.comment"),
      t("format.comment.hint"),
      deps.addComment,
    ),
    control("format-find", "search", t("format.find"), t("format.find.hint"), () =>
      deps.findInBook(deps.selectedText()),
    ),
    control(
      "format-dictionary",
      "book-plus",
      t("format.dictionary"),
      t("format.dictionary.hint"),
      () => deps.addToDictionary(deps.selectedText().trim()),
    ),
  ];
  const buttons = controls.map((c) => c.element);
  buttons[0]!.tabIndex = 0;
  const dictionary = buttons[buttons.length - 1]!;
  dictionary.hidden = true;

  /** The controls a key can land on: every button except a hidden one. The
   *  dictionary control is the only one that hides, and arrowing onto an
   *  invisible button would focus nothing the writer can see. */
  function reachable(): HTMLButtonElement[] {
    return buttons.filter((b) => !b.hidden);
  }

  /** Moves the roving tab stop back to Bold. Called whenever the bubble
   *  hides: a writer who arrowed onto Find, then dismissed the bubble by
   *  collapsing the selection, should not find Tab landing on Find the next
   *  time it shows for an unrelated selection. */
  function resetStop(): void {
    const current = buttons.findIndex((b) => b.tabIndex === 0);
    if (current <= 0) return;
    buttons[current]!.tabIndex = -1;
    buttons[0]!.tabIndex = 0;
  }

  // ArrowLeft/ArrowRight wrap, Home/End jump to an end, and only these four
  // keys are handled -- everything else (Tab included) is left alone so the
  // toolbar stays a single stop and Escape, if the page ever binds it, is
  // free to reach the document.
  function onKeyDown(event: KeyboardEvent): void {
    if (isCompositionKey(event)) return;
    const stops = reachable();
    const current = stops.findIndex((b) => b === document.activeElement);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowLeft") next = (current - 1 + stops.length) % stops.length;
    else if (event.key === "ArrowRight") next = (current + 1) % stops.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = stops.length - 1;
    else return;
    event.preventDefault();
    stops[current]!.tabIndex = -1;
    stops[next]!.tabIndex = 0;
    stops[next]!.focus();
  }
  bar.addEventListener("keydown", onKeyDown);

  deps.container.append(bar);

  let focused = false;
  let destroyed = false;
  let timer: unknown = null;

  function hide(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    // A collapsed caret calls this once per keystroke (through onSelection),
    // and most of those keystrokes find the bubble already hidden -- so this
    // is the per-keystroke-cheap path the word-count rescan set the
    // precedent for: nothing written, nothing repainted, when nothing
    // changed.
    if (bar.hidden) return;
    bar.hidden = true;
    resetStop();
  }

  function show(): void {
    timer = null;
    if (deps.blocked?.()) { hide(); return; }
    const rect = deps.selectionRect();
    if (rect === null) {
      // The selection moved, or the view lost layout, between the debounce
      // arming and firing. Nothing to place against.
      hide();
      return;
    }
    // Decided BEFORE measuring: a sixth button changes the bar's width, and
    // the placement must clamp the bar that is actually shown.
    dictionary.hidden = !isOneWord(deps.selectedText());
    if (dictionary.hidden && dictionary.tabIndex === 0) resetStop();
    bar.hidden = false;
    const size = measure();
    const placed = placeBubble({
      selection: rect,
      bubble: size,
      pane: deps.pane(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    bar.style.left = `${placed.left}px`;
    bar.style.top = `${placed.top}px`;
  }

  function scheduleShow(): void {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(show, debounceMs);
  }

  function onSelection(): void {
    if (destroyed) return;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const { from, to } = deps.selection();
    if (deps.blocked?.() || !bubbleWanted({ from, to, focused })) {
      hide();
      return;
    }
    scheduleShow();
  }

  function onFocus(): void {
    if (destroyed) return;
    focused = true;
    onSelection();
  }

  /** Shared by `onBlur` (the editor's own blur) and `onFocusOut` (focus
   *  leaving the bar itself): both ask the identical question, "did the
   *  writer's attention land somewhere outside this toolbar", and answer it
   *  against the same subtree. */
  function handleFocusLoss(related: EventTarget | null): void {
    if (destroyed) return;
    if (related instanceof Node && bar.contains(related)) return;
    focused = false;
    hide();
  }

  function onBlur(event: FocusEvent): void {
    handleFocusLoss(event.relatedTarget);
  }

  // THE HALF `onBlur` CANNOT SEE. Tab into a button, or press Enter on one,
  // and focus is already inside the bar -- the editor's blur fired once, on
  // the way in, and tells this unit nothing about where focus goes from
  // here. `focusout` on the bar itself is what answers for its own subtree,
  // with the identical relatedTarget check `onBlur` uses for the editor's.
  function onFocusOut(event: FocusEvent): void {
    handleFocusLoss(event.relatedTarget);
  }
  bar.addEventListener("focusout", onFocusOut);

  // A scroll or a resize HIDES; it does not follow. See the header comment:
  // one listener per event, no per-frame placement work on the scroll path.
  // Capture phase on `document`, because #editor's own scroll box is what
  // actually moves and a plain bubble-phase listener on document would miss
  // a scroll that never reaches it.
  function onScroll(): void {
    hide();
  }
  function onResize(): void {
    hide();
  }
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);

  let shown: ActiveMarks | null = null;

  function setActive(marks: ActiveMarks): void {
    if (destroyed) return;
    if (
      shown !== null &&
      shown.bold === marks.bold &&
      shown.italic === marks.italic &&
      shown.underline === marks.underline
    ) {
      return;
    }
    shown = { bold: marks.bold, italic: marks.italic, underline: marks.underline };
    for (const c of controls) {
      if (c.reads !== undefined) {
        c.element.setAttribute("aria-pressed", c.reads(marks) ? "true" : "false");
      }
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    hide();
    bar.removeEventListener("keydown", onKeyDown);
    bar.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    for (const c of controls) c.tip.destroy();
    bar.remove();
  }

  return { onSelection, onFocus, onBlur, setActive, shown: () => !bar.hidden, destroy };
}
