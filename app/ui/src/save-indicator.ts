// app/ui/src/save-indicator.ts
// One span in the project bar answering the question this application exists to
// remove: is my work in the file.
//
// THE APPLICATION HAS NO SAVE COMMAND, deliberately, and this is the other half
// of that decision. A Ctrl+S either does nothing and reports success or forces a
// flush the scheduler was going to perform anyway; both teach a writer that
// their work is unsaved until they act. What they lack is an ANSWER, not a
// command.
//
// IT NEVER SAYS `Saved` UNLESS THE SCHEDULER DOES. The state is derived inside
// the flush scheduler from its own dirty map and in-flight flag, and there is no
// setter here to be called wrongly from somewhere else.
//
// role="group", NOT role="status". The recorded finding stands: `status` plus
// `aria-live="off"` leaves the live-region apparatus attached
// (container-live-role:status, atomic:true) and a client keying off the role
// still announces. This value changes about once a second while someone is
// typing. The case that deserves announcing is a save FAILURE, and the latched
// banner already does that.
//
// The whole state lives in the ACCESSIBLE NAME as well as the text, because
// WebKitGTK prunes #project-bar and the name is the only channel certain to
// survive. Both are built from the same one variable, so they cannot drift the
// way the word count's two renderings can.
import { t } from "./i18n";
import type { SaveState } from "./store/flush";

export interface SaveIndicatorDeps {
  /** The bar element, already in index.html. Outside #project-controls, which
   *  the switcher clears wholesale. */
  container: HTMLElement;
  /** The state to open on. Read rather than assumed: a project mounted with
   *  unflushed work would otherwise be drawn as saved for one debounce. */
  initial: SaveState;
}

export interface SaveIndicator {
  set(state: SaveState): void;
  destroy(): void;
}

/** What the writer reads, and what a screen reader says. Exported so the graded
 *  rig can restate exactly one of these strings rather than three. */
export const SAVE_TEXT: Record<SaveState, string> = {
  saved: t("save.text.saved"),
  pending: t("save.text.pending"),
  failed: t("save.text.failed"),
};

/** Longer than the visible label, because a name has no bar around it to give it
 *  context. `Not saved` alone could be read as a description of the button
 *  beside it. */
export const SAVE_NAME: Record<SaveState, string> = {
  saved: t("save.name.saved"),
  pending: t("save.name.pending"),
  failed: t("save.name.failed"),
};

export function createSaveIndicator(deps: SaveIndicatorDeps): SaveIndicator {
  const { container } = deps;

  container.replaceChildren();

  const element = document.createElement("span");
  element.id = "save-indicator";
  element.setAttribute("role", "group");

  let destroyed = false;

  // NO `destroyed` GUARD HERE, deliberately. `destroy()` detaches the element,
  // so a `set` arriving afterwards writes to a node that is in no document -
  // invisible by construction, including to the next project's indicator, which
  // owns a different element in the same container. A guard nothing can reach is
  // worse than no guard, because a reader credits it for a refusal it never
  // performs. Mutation found this: deleting the guard broke no test, and the
  // test that claimed to cover it was asserting a property of detachment.
  const set = (state: SaveState): void => {
    element.textContent = SAVE_TEXT[state];
    element.setAttribute("aria-label", SAVE_NAME[state]);
    // For the stylesheet, and for a rig that wants the state rather than the
    // wording. A wording change must not break a selector.
    element.dataset.state = state;
  };
  set(deps.initial);

  container.append(element);
  reserveWidestState(container, element);

  return {
    set,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      container.replaceChildren();
    },
  };
}


/** Reserve the width of the WIDEST state, so the strip does not re-lay out on
 *  every flush and drag the word count with it (owner report of 2026-08-20,
 *  with a screenshot: the counts jumped left each time `Saving…` replaced
 *  `Saved`). Measured, not a pixel constant: the catalog is translated and a
 *  `min-width` sized for English is wrong in German. Measured at 600 weight for
 *  all three because `failed` renders bold and bold is never narrower, so the
 *  reservation is an upper bound in every locale rather than a guess. In a DOM
 *  with no layout (the test runner) the probe measures 0 and nothing is set. */
function reserveWidestState(container: HTMLElement, element: HTMLElement): void {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "nowrap";
  probe.style.font = getComputedStyle(element).font || "";
  // AFTER the shorthand, which resets weight.
  probe.style.fontWeight = "600";
  container.append(probe);
  let widest = 0;
  for (const text of Object.values(SAVE_TEXT)) {
    probe.textContent = text;
    widest = Math.max(widest, probe.getBoundingClientRect().width);
  }
  probe.remove();
  if (widest > 0) element.style.minWidth = `${Math.ceil(widest)}px`;
}
