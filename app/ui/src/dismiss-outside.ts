// app/ui/src/dismiss-outside.ts
// A click anywhere outside an open panel closes it.
//
// THIS IS THE HALF OF A TOGGLE NOBODY COUNTS. Until the retirement slice, the
// find, preferences and project panels were each opened by a button in the
// project bar, and pressing that button again closed them. Retiring the buttons
// into the application menu removed the OPEN affordance visibly and the CLOSE
// affordance silently: what was left was Escape, which only fires while focus is
// inside the panel. A writer who opened Preferences and then clicked into their
// manuscript had a panel over their prose and no way at all to dismiss it.
//
// Not caught by any unit test, because every test drives the panel from inside
// it, and not by any gate, because a panel that is up is a panel that opened.
// The menu bar had this from the day it shipped; the panels did not.
//
// DOES NOT MOVE FOCUS, deliberately, and that is the difference between this and
// Escape. Escape is "take me back to what I was doing", so it hands the page an
// `onDismiss` and the page focuses the editor. A click already says where the
// writer wants to be, and pulling focus away from what they just clicked would
// be the panel arguing with them on the way out.

/** Close `panel` when a click lands outside it.
 *
 *  Returns the unsubscribe. Callers must keep it and call it in `destroy()`: the
 *  listener is on the DOCUMENT, so it is the one that outlives its own elements
 *  and accumulates one live closure per project switch.
 */
export function closeOnOutsideClick(
  panel: HTMLElement,
  isOpen: () => boolean,
  close: () => void,
  doc: Document = document,
): () => void {
  const onDocumentClick = (event: Event): void => {
    // A modal isolates the background before its own buttons receive clicks.
    if (!isOpen() || panel.closest("[inert]")) return;
    const target = event.target;
    // NO isConnected CHECK. The first draft had one, on the theory that a row
    // removed by the click that selected it reports a target the panel can no
    // longer contain - which would read as "outside" and close a panel the
    // writer clicked INSIDE. No input can reach that: this runs in the capture
    // phase, so it runs BEFORE the target's own handler could detach anything,
    // and a click dispatched on an already-detached node never propagates to the
    // document at all. A mutation deleting the check survived the whole suite,
    // which is what a guard nothing can reach looks like - and a reader credits
    // it for a refusal it never makes. Same call as `import_name_ok`.
    if (target instanceof Node && panel.contains(target)) return;
    close();
  };
  // CAPTURE, exactly as the menu bar registers its own. A menu item that opens
  // this panel runs in the bubble phase, so a capture-phase close sees the panel
  // in its pre-click state and the item then opens it again - which is the
  // correct outcome for "click Preferences while Preferences is open". Registered
  // in the bubble phase instead, the two would race and the panel would close
  // itself immediately after opening.
  doc.addEventListener("click", onDocumentClick, true);
  return () => doc.removeEventListener("click", onDocumentClick, true);
}
