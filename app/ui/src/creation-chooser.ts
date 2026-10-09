import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import type { MatterKind } from "./outline";

export interface BibleCreation {
  destination: string;
  entry(): void;
  folder(): void;
  timeline(): void;
}

export function createCreationChooser(deps: {
  create(type: string): void;
  bible(): BibleCreation;
  matter(kind: MatterKind): void;
  returnFocus(): void;
}): { open(bible?: boolean): void; destroy(): void } {
  const panel = document.createElement("div");
  panel.id = "creation-chooser";
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "creation-heading");
  const shell = createPanelShell({
    panel, title: t("creation.manuscript"), titleId: "creation-heading",
    close: () => { panel.hidden = true; }, returnFocus: deps.returnFocus,
  });
  document.body.append(panel);
  let destroyed = false;
  const action = (id: string, label: string, run: () => void): HTMLButtonElement => {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (destroyed) return;
      panel.hidden = true;
      deps.returnFocus();
      run();
    });
    return button;
  };
  const bibleChoices = (target: BibleCreation, showHeading = true): HTMLElement => {
    const group = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = t("creation.bible");
    const destination = document.createElement("p");
    destination.className = "creation-destination";
    destination.textContent = t("creation.destination", { name: target.destination });
    if (showHeading) group.append(heading);
    group.append(destination,
      action("create-bible-entry", t("creation.entry"), target.entry),
      action("create-bible-folder", t("creation.folder"), target.folder),
      action("create-bible-timeline", t("creation.timeline"), target.timeline));
    return group;
  };
  return {
    open(bible = false): void {
      if (destroyed) return;
      const target = deps.bible();
      const title = t(bible ? "creation.bible" : "creation.manuscript");
      shell.setTitle(title);
      shell.closeButton.setAttribute("aria-label", t("panel.close", { title }));
      shell.body.replaceChildren();
      if (bible) {
        shell.body.append(bibleChoices(target, false));
      } else {
        for (const type of ["scene", "chapter", "part"]) {
          shell.body.append(action(`create-${type}`, t(`menu.new-${type}`), () => deps.create(type)));
        }
        const more = document.createElement("details");
        more.id = "creation-more";
        const summary = document.createElement("summary");
        summary.setAttribute("role", "button");
        summary.setAttribute("aria-expanded", "false");
        more.addEventListener("toggle", () => summary.setAttribute("aria-expanded", String(more.open)));
        summary.textContent = t("menu.more");
        more.append(summary, bibleChoices(target));
        const pages = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = t("menu.book-pages");
        pages.append(heading);
        for (const kind of ["dedication", "foreword", "acknowledgements", "afterword"] as const) {
          pages.append(action(`create-${kind}`, t(`menu.new-${kind}`), () => deps.matter(kind)));
        }
        more.append(pages);
        shell.body.append(more);
      }
      panel.hidden = false;
      shell.body.querySelector<HTMLButtonElement>("button")?.focus();
    },
    destroy(): void {
      destroyed = true;
      shell.destroy();
      panel.remove();
    },
  };
}
