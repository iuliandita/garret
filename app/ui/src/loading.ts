// app/ui/src/loading.ts
// The one moment the application has nothing on screen at all.
//
// Two callers, and both scale with the manuscript - so both are longest for the
// writers with the most in it:
//
//   - the FIRST mount, where index.html ships an empty #nav and an empty
//     #editor and every unit builds its own content, so the window is blank
//     until the walk and the first document arrive;
//   - a project SWITCH, which tears the outgoing project down BEFORE it opens
//     the next one, deliberately, so there is a window with no navigator, no
//     editor, no bar and no saved indicator.
//
// EXTRACTED FROM main.ts rather than left there. `main.ts` ends in `void main()`
// at module scope, so importing it boots the page - fetches a corpus, builds a
// DOM, runs a soak - and nothing in it can be tested. A mutation deleting the
// first-mount call survived the whole suite while it lived there, which is the
// recorded shape: new logic that needs coverage must be extracted, not tested
// in place.

import { t } from "./i18n";

/** The element's id, exported so a test and the stylesheet agree on one spelling. */
export const LOADING_ID = "project-loading";

/** Show or hide the loading surface.
 *
 *  IDEMPOTENT in both directions: the switch's `onBusy` can fire true twice if a
 *  second switch begins before the first paints, and hiding an absent element
 *  must not throw on a boot that never showed one.
 *
 *  `role="status"`, not `alert`: it is news about what the application is doing,
 *  not an emergency, and it is replaced by the project itself in a moment.
 */
export function showProjectLoading(busy: boolean, doc: Document = document): void {
  const existing = doc.getElementById(LOADING_ID);
  if (!busy) {
    existing?.remove();
    return;
  }
  const library = doc.getElementById("library");
  const libraryStatus = library?.querySelector<HTMLElement>("#library-busy-status");
  if (libraryStatus?.textContent?.trim() && !libraryStatus.closest("[hidden], [inert]")) {
    existing?.remove();
    return;
  }
  if (existing !== null) return;
  const el = doc.createElement("div");
  el.id = LOADING_ID;
  el.setAttribute("role", "status");
  el.textContent = t("loading.opening");
  doc.body.append(el);
}
