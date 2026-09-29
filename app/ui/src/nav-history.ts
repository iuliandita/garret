import { isCompositionKey } from "./composition-key";
// app/ui/src/nav-history.ts
// Back and forward through the scenes the writer has actually opened.
//
// PURE. No DOM, no imports from project.ts, nothing that needs a page. The
// interesting part of this feature is a small set of rules about a stack, and
// every one of them has to be falsifiable without booting anything - the
// recorded defect class in this repo is logic that lived in a file no test can
// import (main.ts) and went uncovered for slices at a time.
//
// The trail records ACTIVATIONS - a document that actually opened - and never
// selections. The navigator's selection moves on every arrow key, so recording
// there would fill the trail with rows nobody looked at; and the synthetic
// measurement workload drives selection directly, tens of thousands of times a
// soak, so a soak would rewrite the thing it is measuring. `open.ts` already
// draws the line in the same place.

/** How many visited scenes the trail holds. Oldest dropped.
 *
 *  Fifty because Back stops being how anyone gets anywhere long before then. A
 *  writer uses it to step back over the last few jumps - "what did I just come
 *  from" - and past a couple of dozen they navigate by the outline or by Ctrl+P,
 *  because they cannot remember the order they visited things in either. Fifty
 *  is comfortably past that point and still a bound: without one, a session that
 *  hops between scenes for eight hours grows this array forever, and a measured
 *  soak activating documents in a loop would grow it fastest of all. */
export const HISTORY_LIMIT = 50;

export interface NavHistory {
  /** A document opened. Called from the activation path, never from a selection
   *  change. Recording the entry the trail is already sitting on is a no-op -
   *  see `back` for why that is the whole of the going-back rule. */
  record(itemId: string): void;
  /** The previous still-openable entry, or null. Moves the position. */
  back(live: ReadonlySet<string>): string | null;
  /** The next still-openable entry, or null. Moves the position. */
  forward(live: ReadonlySet<string>): string | null;
  canGoBack(live: ReadonlySet<string>): boolean;
  canGoForward(live: ReadonlySet<string>): boolean;
  /** A copy, for tests and for nothing else. */
  trail(): readonly string[];
  /** Where in the trail the writer is standing; -1 when it is empty. */
  position(): number;
}

/** Which of the two navigations a keystroke is, or null for anything else.
 *
 *  Takes a plain shape rather than a KeyboardEvent so it stays testable without
 *  a DOM, and so the chord rule sits beside the stack rule it serves.
 *
 *  `defaultPrevented` is a real part of the rule, not a nicety. THE NAVIGATOR
 *  ALREADY BINDS ALT+LEFT AND ALT+RIGHT: with the outline focused they outdent
 *  and indent a row, and it calls preventDefault when it takes them. So the
 *  outline keeps the chords where it has focus and the rest of the application -
 *  which in practice means the editor, where the writer actually is - gets the
 *  browser-conventional back and forward. */
export interface ChordEvent {
  isComposing?: boolean;
  keyCode?: number;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

export function historyChordOf(event: ChordEvent): "back" | "forward" | null {
  if (isCompositionKey(event) || event.defaultPrevented) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}

export function createNavHistory(limit: number = HISTORY_LIMIT): NavHistory {
  // Loud rather than clamped: a limit of zero is a caller bug, and a trail that
  // silently holds nothing is a Back that silently never works.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`nav history limit must be a positive integer, got ${String(limit)}`);
  }

  const trail: string[] = [];
  let index = -1;

  /** The first entry from `from`, walking by `step`, that still exists.
   *
   *  SKIPPED, NOT AN ERROR AND NOT A DEAD END. An entry can name a scene the
   *  writer has since deleted, and stopping there would make Back say "nothing"
   *  while three perfectly good scenes sit behind it. Deliberately does not
   *  PRUNE the dead entry either: this application can restore from the bin, and
   *  a restored scene should come back to the trail it was always part of. */
  function seek(from: number, step: number, live: ReadonlySet<string>): number {
    for (let i = from; i >= 0 && i < trail.length; i += step) {
      const id = trail[i];
      if (id !== undefined && live.has(id)) return i;
    }
    return -1;
  }

  return {
    record(itemId: string): void {
      // THIS LINE IS WHAT STOPS BACK FROM PUSHING. `back` moves the position
      // onto the entry it returns, and the caller then opens that document,
      // which comes back through here - so the trail is already standing where
      // the arrival would be recorded. Without it, going back truncates the
      // forward stack at the position it just moved to and pushes the same id
      // again: Forward is gone, and Back walks between two scenes forever, which
      // is the classic defect of this feature. It also covers the harmless case
      // of re-opening the scene already open.
      if (trail[index] === itemId) return;
      // Somewhere new, so everything ahead is a future the writer did not take.
      // Exactly what a browser does, and for the same reason: keeping it would
      // make Forward mean "a scene from some other trail".
      trail.length = index + 1;
      trail.push(itemId);
      if (trail.length > limit) trail.splice(0, trail.length - limit);
      index = trail.length - 1;
    },
    back(live: ReadonlySet<string>): string | null {
      const at = seek(index - 1, -1, live);
      if (at < 0) return null;
      index = at;
      return trail[at] ?? null;
    },
    forward(live: ReadonlySet<string>): string | null {
      const at = seek(index + 1, 1, live);
      if (at < 0) return null;
      index = at;
      return trail[at] ?? null;
    },
    canGoBack: (live: ReadonlySet<string>): boolean => seek(index - 1, -1, live) >= 0,
    canGoForward: (live: ReadonlySet<string>): boolean => seek(index + 1, 1, live) >= 0,
    trail: (): readonly string[] => [...trail],
    position: (): number => index,
  };
}
