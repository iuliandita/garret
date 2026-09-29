import { isCompositionKey } from "./composition-key";
import { closeOnOutsideClick } from "./dismiss-outside";
import { t } from "./i18n";
import type { ProjectOpenDecision } from "./project-switch";

export interface BookCopyConflict {
  bookId: string;
  canonicalPath: string;
  canSeparate: boolean;
}

export interface BookCopyPrompt {
  choose(conflict: BookCopyConflict): Promise<ProjectOpenDecision | null>;
  destroy(): void;
}

export function createBookCopyPrompt(container: HTMLElement): BookCopyPrompt {
  const panel = document.createElement("section");
  panel.id = "book-copy-prompt";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("book-copy.label"));
  panel.tabIndex = -1;
  panel.hidden = true;

  const heading = document.createElement("h2");
  heading.textContent = t("book-copy.heading");
  const explanation = document.createElement("p");
  explanation.id = "book-copy-explanation";
  explanation.textContent = t("book-copy.explanation");
  const path = document.createElement("p");
  path.id = "book-copy-path";
  path.setAttribute("aria-label", t("book-copy.path.label"));
  panel.setAttribute("aria-describedby", [explanation.id, path.id].join(" "));
  const separateUnavailable = document.createElement("p");
  separateUnavailable.id = "book-copy-separate-unavailable";
  separateUnavailable.textContent = t("book-copy.separate.unavailable");
  separateUnavailable.hidden = true;

  const buttons = document.createElement("div");
  buttons.id = "book-copy-actions";
  const same = document.createElement("button");
  same.id = "book-copy-same";
  same.type = "button";
  same.textContent = t("book-copy.same");
  const separate = document.createElement("button");
  separate.id = "book-copy-separate";
  separate.type = "button";
  separate.textContent = t("book-copy.separate");
  const cancel = document.createElement("button");
  cancel.id = "book-copy-cancel";
  cancel.type = "button";
  cancel.textContent = t("book-copy.cancel");
  buttons.append(cancel, same, separate);
  panel.append(heading, explanation, path, separateUnavailable, buttons);
  container.append(panel);

  let destroyed = false;
  let resolve: ((choice: ProjectOpenDecision | null) => void) | null = null;
  let conflict: BookCopyConflict | null = null;
  let focusBefore: HTMLElement | null = null;

  function finish(choice: ProjectOpenDecision | null): void {
    const answer = resolve;
    const returnTo = focusBefore;
    resolve = null;
    conflict = null;
    focusBefore = null;
    panel.hidden = true;
    if (returnTo?.isConnected) returnTo.focus();
    answer?.(choice);
  }

  function choose(kind: ProjectOpenDecision["kind"]): void {
    if (conflict === null || (kind === "separate" && !conflict.canSeparate)) return;
    finish({ bookId: conflict.bookId, canonicalPath: conflict.canonicalPath, kind });
  }

  const onSame = (): void => choose("same");
  const onSeparate = (): void => choose("separate");
  const onCancel = (): void => finish(null);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (resolve === null) return;
    if (event.key === "Escape" || (event.key === "Enter" && (event.target === panel || event.target === cancel))) {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
      return;
    }
    if (panel.contains(document.activeElement)) {
      if (event.altKey || event.ctrlKey || event.metaKey) event.preventDefault();
      event.stopPropagation();
    }
  };
  same.addEventListener("click", onSame);
  separate.addEventListener("click", onSeparate);
  cancel.addEventListener("click", onCancel);
  document.addEventListener("keydown", onKeyDown, true);
  const stopOutsideClick = closeOnOutsideClick(panel, () => resolve !== null, onCancel);

  return {
    choose(next: BookCopyConflict): Promise<ProjectOpenDecision | null> {
      if (destroyed) return Promise.resolve(null);
      if (resolve !== null) finish(null);
      conflict = next;
      focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      path.textContent = next.canonicalPath;
      separate.disabled = !next.canSeparate;
      separateUnavailable.hidden = next.canSeparate;
      panel.hidden = false;
      cancel.focus();
      return new Promise((answer) => {
        resolve = answer;
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      finish(null);
      same.removeEventListener("click", onSame);
      separate.removeEventListener("click", onSeparate);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeyDown, true);
      stopOutsideClick();
      panel.remove();
    },
  };
}
