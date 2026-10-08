// app/ui/src/close-prompt.ts
// The blocking prompt raised when the window is closing while autosave has
// failed with unsaved documents still in memory. See lifecycle.ts, which
// decides WHEN to open this.
//
// The full-window modal used when closing could discard unsaved work. The
// section-move prompt also interrupts for a structural change, but its native
// dialog is scoped to the open manuscript.
//
// role="alertdialog", not "dialog": this interrupts the writer to demand a
// decision rather than offering one they can go read first, and a screen
// reader announces the two differently.
import { isCompositionKey } from "./composition-key";
import { formatNumber, plural, t } from "./i18n";

export interface ClosePromptDeps {
  /** Appended directly to this element. document.body, in production - the
   *  prompt belongs to no panel, no project, and must outlive a project
   *  switch, which nothing else in the chrome does. */
  container: HTMLElement;
}

export type ClosePromptChoice = "stay" | "close";

export interface ClosePrompt {
  /** Show the prompt naming `dirtyCount` unsaved documents and resolve once
   *  the writer answers. "stay" on Escape or the safe button; "close" only on
   *  the button that says what it costs. Never rejects. */
  open(dirtyCount: number): Promise<ClosePromptChoice>;
  /** Ask separately about sidebar count choices that could not be saved. */
  openPreferences(): Promise<ClosePromptChoice>;
  destroy(): void;
}

export function createClosePrompt(deps: ClosePromptDeps): ClosePrompt {
  const panel = document.createElement("div");
  panel.id = "close-prompt-panel";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "close-prompt-heading");
  panel.setAttribute("aria-describedby", "close-prompt-body");
  panel.hidden = true;

  const content = document.createElement("div");
  content.id = "close-prompt-content";
  panel.append(content);

  const heading = document.createElement("h2");
  heading.id = "close-prompt-heading";
  heading.textContent = t("close-prompt.heading");
  content.append(heading);

  const body = document.createElement("p");
  body.id = "close-prompt-body";
  content.append(body);

  const actions = document.createElement("div");
  actions.id = "close-prompt-actions";
  content.append(actions);

  // FIRST in the DOM and the one `open()` focuses: the safe outcome must be
  // what a Return pressed by reflex, before the writer has read a word,
  // lands on.
  const stayButton = document.createElement("button");
  stayButton.type = "button";
  stayButton.textContent = t("close-prompt.stay");

  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.id = "close-prompt-discard";
  // Danger TEXT on the default surface, not a filled red slab: the
  // loudest thing in the prompt must not be the button that loses work.
  discardButton.dataset.weight = "danger";
  discardButton.textContent = t("close-prompt.discard");

  actions.append(stayButton, discardButton);
  deps.container.append(panel);

  let resolveChoice: ((choice: ClosePromptChoice) => void) | null = null;

  function finish(choice: ClosePromptChoice): void {
    panel.hidden = true;
    const resolve = resolveChoice;
    resolveChoice = null;
    resolve?.(choice);
  }

  stayButton.addEventListener("click", () => finish("stay"));
  discardButton.addEventListener("click", () => finish("close"));

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key === "Escape") {
      // The reflex for "get this off my screen", and here that must be the
      // answer that keeps the manuscript.
      event.preventDefault();
      finish("stay");
      return;
    }
    if (event.key !== "Tab") return;
    // A hand-rolled trap over two buttons: nothing about the rest of the page
    // may be reachable while the manuscript's fate is undecided, and this is
    // the one panel in the application that has to mean that literally.
    const focusables = [stayButton, discardButton];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  panel.addEventListener("keydown", onKeyDown);

  function show(): Promise<ClosePromptChoice> {
    panel.hidden = false;
    stayButton.focus();
    return new Promise((resolve) => {
      resolveChoice = resolve;
    });
  }

  let destroyed = false;
  return {
    open(dirtyCount: number): Promise<ClosePromptChoice> {
      heading.textContent = t("close-prompt.heading");
      stayButton.textContent = t("close-prompt.stay");
      discardButton.textContent = t("close-prompt.discard");
      body.textContent = plural("close-prompt.body", dirtyCount, {
        count: formatNumber(dirtyCount),
      });
      return show();
    },
    openPreferences(): Promise<ClosePromptChoice> {
      heading.textContent = t("close-prompt.preferences.heading");
      body.textContent = t("close-prompt.preferences.body");
      stayButton.textContent = t("close-prompt.preferences.stay");
      discardButton.textContent = t("close-prompt.preferences.discard");
      return show();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel.removeEventListener("keydown", onKeyDown);
      panel.remove();
    },
  };
}
