import { formatNumber, plural, t } from "./i18n";
import type { PrintSection, SectionChange } from "./outline";

const sectionName = (section: PrintSection): string => t(`outline.section.${section}`);

export function createSectionMovePrompt(container: HTMLElement): {
  open: (title: string, change: SectionChange) => Promise<boolean>;
  destroy: () => void;
} {
  const dialog = document.createElement("dialog");
  dialog.id = "section-move-prompt";
  dialog.setAttribute("aria-labelledby", "section-move-heading");
  dialog.setAttribute("aria-describedby", "section-move-body");
  const heading = document.createElement("h2");
  heading.id = "section-move-heading";
  heading.textContent = t("outline.section-change.heading");
  const body = document.createElement("p");
  body.id = "section-move-body";
  const actions = document.createElement("div");
  actions.className = "section-move-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("outline.section-change.cancel");
  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = t("outline.section-change.accept");
  actions.append(cancel, accept);
  dialog.append(heading, body, actions);
  container.append(dialog);

  let resolve: ((accepted: boolean) => void) | null = null;
  const finish = (accepted: boolean): void => {
    if (dialog.open) dialog.close();
    const done = resolve;
    resolve = null;
    done?.(accepted);
  };
  cancel.addEventListener("click", () => finish(false));
  accept.addEventListener("click", () => finish(true));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(false);
  });

  return {
    open(title, change) {
      const key = change.from === change.to
        ? "outline.section-change.same"
        : "outline.section-change.body";
      body.textContent = plural(key, change.count, {
        title,
        count: formatNumber(change.count),
        from: sectionName(change.from),
        to: sectionName(change.to),
      });
      dialog.showModal();
      cancel.focus();
      return new Promise((done) => { resolve = done; });
    },
    destroy() {
      finish(false);
      dialog.remove();
    },
  };
}
