import { isCompositionKey } from "./composition-key";
// app/ui/src/quit.ts
// Leaving.
//
// UNTIL THIS SLICE THERE WAS NO WAY OUT OF THIS APPLICATION FROM INSIDE IT. The
// File menu offered no Quit and no chord mapped to one, so the unsaved-work
// prompt built by plans 011 and 012 -- the loudest moment this application has,
// and the only failure here whose cost is unbounded -- could be reached only by
// clicking the window manager's close button. On a WM-less server there was no
// way to reach it at all, which is how a first-run session ended in a SIGTERM.
//
// THE HOST STILL DECIDES, and that is the point. `requestQuit` calls one host
// command whose whole body is `window.close()`, so a Quit from here enters the
// SAME `CloseRequested` path a title-bar click enters: the window size is
// recorded, the close is prevented, the page is asked to flush, and the prompt
// happens if there is unsaved work. Nothing about that sequence is restated
// here, and this module cannot close a window.
//
// Not `confirm_close`, which is the trap next to this one: that command calls
// `window.close()` with the `Closing` latch already true. Called cold it takes
// the close handler's first branch, prevents the close and emits the close
// event again -- a Quit item that flushes the manuscript and leaves the window
// standing.

/** Ctrl+Q, or Meta+Q on a keyboard that has one.
 *
 *  A pure predicate, and separate from the listener, so every arm of it is
 *  reachable by a test. Alt is REFUSED rather than ignored: Ctrl+Alt+Q is a
 *  window-management chord on several desktops, and a predicate that accepted it
 *  would quit the application on a keypress meant for the compositor. */
export function isQuitChord(event: KeyboardEvent): boolean {
  if (isCompositionKey(event)) return false;
  if (event.key !== "q" && event.key !== "Q") return false;
  if (event.altKey) return false;
  return event.ctrlKey || event.metaKey;
}

export interface QuitDeps {
  /** Ask the host to begin a close. Synchronous from this module's point of
   *  view: what happens next is a round trip through the close event, and this
   *  unit is not part of it. */
  requestQuit: () => void;
}

export interface Quit {
  /** Ask without a keyboard. This is what the File menu's item calls, so the
   *  menu and the chord are one implementation rather than two. */
  run(): void;
  destroy(): void;
}

export function createQuit(deps: QuitDeps): Quit {
  // A document-level listener, matching what the find bar and quick open
  // already do: the editor's keymap only fires while the editor holds focus,
  // and a writer whose focus is in the navigator still expects Ctrl+Q.
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (!isQuitChord(event)) return;
    // Prevented for the reason Ctrl+F is: the engine has its own binding on
    // this chord and both would fire.
    event.preventDefault();
    deps.requestQuit();
  };

  document.addEventListener("keydown", onKeyDown);

  return {
    run: () => deps.requestQuit(),
    destroy: () => document.removeEventListener("keydown", onKeyDown),
  };
}
