import { isCompositionKey } from "./composition-key";
// app/ui/src/chrome-fade.ts
// Focus mode hides the chrome as soon as it turns on.
// After a wake, typing or timeline pointer stillness starts the re-hide timer. This module owns exactly one thing -- the `chrome-hidden` class on
// `<body>` and the timer that adds it -- the stylesheet does the fading, the
// visibility flip and the pane's recentring transform (style.css, near
// `:root[data-focus="paragraph"]`).
//
// AFTER A WAKE, THE TIMER RUNS FROM THE FIRST KEYSTROKE, NOT THE LAST. "After 1.5 s of typing" means the writer has been typing for 1.5 s;
// a timer re-armed on every keystroke would instead hide the chrome 1.5 s
// after the writer PAUSES, which is exactly when they look up to read what
// they wrote. So `onType` arms once and does nothing on every call after,
// until a wake (or the timer firing) lets the next keystroke arm it again.
//
// `onType` IS FED FROM EVERY DOCUMENT-CHANGING TRANSACTION, not only real
// keystrokes -- Find's Replace / Replace all is one too, and its focus sits
// in `#find-panel` inside `#project-bar`. Without a focus check, running a
// replace from the find panel would arm the same timer that hides the panel
// it is running from. So `onType` first asks whether the PANE currently owns
// focus; a document change with focus elsewhere is not typing.
//
// THE FIRST POINTER EVENT COUNTS AS MOVEMENT. It once did not: the plan's
// original reasoning was that WebKit dispatches a synthetic mousemove after
// layout and scroll changes, repeating the pointer's last real position, and
// that the very first mousemove seen (no prior position) was one of those --
// a pointer already resting when the page loaded is not movement. That
// reasoning does not hold under Xvfb, where the pointer genuinely never
// moves after load: `shot-cli --fade woken`'s deliberate nudge WAS the first
// mousemove this module ever saw, and got swallowed as if it were the
// synthetic kind, leaving the chrome hidden in a capture meant to show it
// woken. A writer whose pointer has rested since launch hits the same bug.
// The mitigation the synthetic-move case still needs holds without treating
// "first ever" specially: a synthetic move REPEATS the last real coordinates,
// so it is caught by the displacement check on every event after the first
// regardless.
//
// WAKE SOURCES, each decided in the plan: a pointer displacement (2); focus
// landing outside #editor, so a chord that opens a menu or panel does not
// open it inside an invisible header (3); Escape, captured on the document
// so it still reaches the find bar, panels and ProseMirror uncontested (4);
// the root's `data-focus` attribute leaving "paragraph", watched by a
// MutationObserver so leaving the mode itself never leaves the chrome
// hidden (5); and `destroy()`, so unmounting the editor never leaves a
// hidden header behind.
//
// `blocked()` HOLDS THE TIMER RATHER THAN CANCELLING IT: the format bubble
// (format-bubble.ts) is fixed on `<body>` and placed from the selection's own
// coordinates, so sliding `#editor` to recentre would detach a bubble that is
// resting on screen from the text it is next to. The timer callback checks
// `deps.blocked?.()` and, if it answers true, clears itself without hiding --
// the NEXT keystroke arms a fresh 1.5 s rather than the hide silently never
// happening.
export const HIDDEN_CLASS = "chrome-hidden";
export const HIDE_AFTER_MS = 1500;

export interface ChromeFadeDeps {
  root: HTMLElement;
  body: HTMLElement;
  pane: HTMLElement;
  hideAfterMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** True while something the fade must not cover is on screen (the format
   *  bubble, so far). Checked on mode entry and when the timer fires. */
  blocked?: () => boolean;
}

export interface ChromeFade {
  onType(): void;
  /** The timeline's own arm: it has no typing, so
   *  the 1.5s hide timer keys off pointer STILLNESS instead. Callers debounce
   *  this themselves (a short idle timer after the last pointer move) and
   *  call it once the pointer has actually stopped -- calling it on every
   *  move would race the SAME module's own wake-on-mousemove listener below,
   *  which fires in the same dispatch and would immediately undo the arm. */
  onPointerStill(): void;
  wake(): void;
  destroy(): void;
}

export function focusModeOn(root: HTMLElement): boolean {
  return root.getAttribute("data-focus") === "paragraph";
}

export function createChromeFade(deps: ChromeFadeDeps): ChromeFade {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const hideAfterMs = deps.hideAfterMs ?? HIDE_AFTER_MS;
  // The events this module listens for are watched on the document that owns
  // the elements it was given, not the global `document` -- so what a test
  // injects is what gets watched, and a real mount watches the page's own.
  const doc = deps.body.ownerDocument;
  let timer: unknown = null;
  let destroyed = false;
  let lastX: number | null = null;
  let lastY: number | null = null;

  const wake = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    deps.body.classList.remove(HIDDEN_CLASS);
  };

  /** The shared arm: books the SAME 1.5s hide timer either caller uses,
   *  once, and only while focus mode is actually on. */
  const arm = (): void => {
    if (timer !== null || deps.body.classList.contains(HIDDEN_CLASS)) return;
    timer = setTimer(() => {
      timer = null;
      if (destroyed || !focusModeOn(deps.root)) return;
      if (deps.blocked?.() === true) return;
      deps.body.classList.add(HIDDEN_CLASS);
    }, hideAfterMs);
  };

  const onType = (): void => {
    if (destroyed || !focusModeOn(deps.root)) return;
    // Typing means the pane owns focus; a replace from the find panel is a
    // document change and not typing.
    if (!deps.pane.contains(doc.activeElement)) return;
    arm();
  };

  const onPointerStill = (): void => {
    if (destroyed || !focusModeOn(deps.root)) return;
    arm();
  };

  const onMouseMove = (event: MouseEvent): void => {
    const moved = lastX === null || event.clientX !== lastX || event.clientY !== lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (moved) wake();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (event.key === "Escape") wake();
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Node && deps.pane.contains(event.target)) return;
    wake();
  };
  const hideOnEntry = (): void => {
    if (deps.blocked?.() !== true) deps.body.classList.add(HIDDEN_CLASS);
  };
  let modeWasOn = focusModeOn(deps.root);
  if (modeWasOn) hideOnEntry();
  const observer = new MutationObserver(() => {
    const modeIsOn = focusModeOn(deps.root);
    if (!modeIsOn) wake();
    else if (!modeWasOn) {
      wake();
      hideOnEntry();
    }
    modeWasOn = modeIsOn;
  });
  observer.observe(deps.root, { attributes: true, attributeFilter: ["data-focus"] });
  doc.addEventListener("mousemove", onMouseMove, { passive: true });
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn);

  return {
    onType,
    onPointerStill,
    wake,
    destroy() {
      destroyed = true;
      wake();
      observer.disconnect();
      doc.removeEventListener("mousemove", onMouseMove);
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("focusin", onFocusIn);
    },
  };
}
