// app/ui/src/writing-modes.ts
// Two ways of sitting with a manuscript, both spec section 9.
//
// FOCUS dims everything except the paragraph the caret is in, so the sentence
// being written is the only one competing for attention. TYPEWRITER keeps the
// caret's line at a fixed height in the pane, so the writer's eye stays still
// and the page moves under it instead of the line marching down to the bottom
// edge and stopping there.
//
// They are independent: either, both, or neither. A writer who wants a quiet
// page does not necessarily want the scroll behaviour, and the two are usually
// discovered at different times.
//
// NEITHER TOUCHES THE DOCUMENT. Focus is a decoration and a stylesheet rule;
// typewriter is a scroll position. Nothing here can mark the document dirty,
// change a word count, or reach the store - which is what makes it safe to
// apply on every selection change, including the tens of thousands the
// synthetic measurement workload produces.
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Off, or the paragraph the caret is in.
 *
 *  A `sentence` value is the obvious third option and is deliberately absent:
 *  finding a sentence boundary well enough to dim on it needs a rule about
 *  abbreviations, quotes, ellipses and every language the editor accepts, and a
 *  focus mode that guesses wrong dims the half-sentence a writer is looking at.
 *  A paragraph is a structure the document already has. */
export const FOCUS_MODES = ["off", "paragraph"] as const;
export type FocusMode = (typeof FOCUS_MODES)[number];

export const TYPEWRITER_MODES = ["off", "on"] as const;
export type TypewriterMode = (typeof TYPEWRITER_MODES)[number];

export interface WritingModes {
  focus: FocusMode;
  typewriter: TypewriterMode;
}

export const DEFAULT_WRITING_MODES: WritingModes = { focus: "off", typewriter: "off" };

/** Narrow whatever the host injected.
 *
 *  Lenient in the same way and for the same reason the theme is: `read_settings`
 *  maps a failed parse to defaults for the WHOLE file, so a strictly typed field
 *  here would make one bad value discard `last_project` as well and send the
 *  next launch to a different manuscript. */
export function writingModesFrom(raw: { focus?: unknown; typewriter?: unknown }): WritingModes {
  const focus = FOCUS_MODES.find((m) => m === raw.focus) ?? DEFAULT_WRITING_MODES.focus;
  const typewriter =
    TYPEWRITER_MODES.find((m) => m === raw.typewriter) ?? DEFAULT_WRITING_MODES.typewriter;
  return { focus, typewriter };
}

/** Write the modes onto the element the stylesheet keys off.
 *
 *  `off` REMOVES the attribute rather than writing the word, exactly as
 *  `applyTheme` does for `system`: the stylesheet has no rule for that value, so
 *  leaving it behind works by accident today and breaks the day any
 *  `[data-focus]` selector is added. */
export function applyWritingModes(root: HTMLElement, modes: WritingModes): void {
  if (modes.focus === "off") root.removeAttribute("data-focus");
  else root.setAttribute("data-focus", modes.focus);
  if (modes.typewriter === "off") root.removeAttribute("data-typewriter");
  else root.setAttribute("data-typewriter", modes.typewriter);
}

/** The class the stylesheet dims everything else relative to. */
export const FOCUS_CLASS = "focus-block";

/** A decoration on the top-level block holding the selection head.
 *
 *  A DECORATION, not an attribute written by hand: ProseMirror owns the DOM it
 *  renders, and a class set directly on a rendered node is removed the next time
 *  that node is redrawn - silently, and only for the paragraph being edited,
 *  which is the one that matters.
 *
 *  Keyed on the selection HEAD rather than on `from`: a writer selecting
 *  backwards across a paragraph boundary is working at the head, and dimming the
 *  paragraph they are extending away from would be exactly wrong.
 *
 *  Costs one decoration and one walk of the document's TOP LEVEL per selection
 *  change - `doc.childCount`, not `nodeSize` - which is a few hundred at the
 *  longest scene the fixtures produce.
 */
export function focusPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const root = state.doc;
        const head = state.selection.head;
        let pos = 0;
        for (let i = 0; i < root.childCount; i++) {
          const child = root.child(i);
          const end = pos + child.nodeSize;
          if (head >= pos && head <= end) {
            return DecorationSet.create(root, [
              Decoration.node(pos, end, { class: FOCUS_CLASS }),
            ]);
          }
          pos = end;
        }
        // No block holds the head. Not an error and not worth reporting: an
        // empty document has no block to dim, and the answer is to dim nothing
        // rather than to dim everything.
        return DecorationSet.empty;
      },
    },
  });
}

/** How far down the pane the caret's line is held, as a fraction of its height.
 *
 *  0.42 rather than 0.5. Dead centre reads as slightly low, because the eye
 *  weights the text above the caret - which is written - more than the empty
 *  space below it, which is not. Just above centre puts the line where a writer
 *  looking at the page expects it.
 */
export const TYPEWRITER_ANCHOR = 0.42;

/** Scroll `pane` so that the caret's line sits at the anchor height.
 *
 *  Takes the caret's viewport rectangle from the caller rather than reading the
 *  selection itself, so the arithmetic is testable without a layout engine -
 *  happy-dom does none, and every geometry assertion made against it is vacuous.
 *
 *  Returns the scrollTop it wants, and does NOT apply it: applying is the
 *  caller's, so a test can assert the number without a scrolling element.
 */
export function typewriterScrollTop(
  paneTop: number,
  paneHeight: number,
  paneScrollTop: number,
  caretTop: number,
): number {
  // Where the caret is now, in the scrolled content's own coordinates.
  const caretInContent = caretTop - paneTop + paneScrollTop;
  const wanted = caretInContent - paneHeight * TYPEWRITER_ANCHOR;
  // Never negative: at the top of a document there is nothing above the caret to
  // scroll into view, and asking for a negative scrollTop would either be
  // clamped (a wasted write on every keystroke) or, worse, honoured by a
  // container that allows overscroll and leave the first line off screen.
  return Math.max(0, Math.round(wanted));
}
