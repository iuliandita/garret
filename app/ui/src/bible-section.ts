import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { bibleEntriesIn, bibleRowsFrom, visibleBibleEntries } from "./bible-rows";
import type { ProjectItem } from "./store/source";

export interface BibleSection {
  setItems(items: readonly ProjectItem[]): void;
  setActiveId(id: string | null): void;
  setSelectedId(id: string | null): void;
  setBibleRows(rows: number): void;
  destroy(): void;
}

export function mountBibleSection(deps: {
  container: HTMLElement;
  items: readonly ProjectItem[];
  bibleRows: number;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}): BibleSection {
  const section = document.createElement("section");
  section.id = "bible-section";
  section.hidden = true;
  const heading = document.createElement("h2");
  heading.id = "bible-heading";
  heading.textContent = t("bible.heading");
  section.setAttribute("aria-labelledby", heading.id);
  const list = document.createElement("div");
  list.id = "bible-list";
  section.append(heading, list);
  deps.container.append(section);
  let activeId: string | null = null;
  let selectedId: string | null = null;
  let items = deps.items;
  const collapsed = new Set<string>();
  const buttons = new Map<string, HTMLButtonElement>();

  const paintStates = (): void => {
    for (const [id, button] of buttons) {
      button.setAttribute("aria-current", String(id === activeId));
      button.setAttribute("aria-pressed", String(id === selectedId));
    }
  };

  const paint = (): void => {
    const focusedId = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.bibleId ?? null
      : null;
    const previousScroll = list.scrollTop;
    const entries = bibleEntriesIn(items);
    section.hidden = entries.length === 0;
    buttons.clear();
    const visible = visibleBibleEntries(entries, collapsed);
    list.replaceChildren(...visible.map(({ item, level, folder }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.bibleId = item.id;
      button.style.setProperty("--bible-level", String(level));
      button.textContent = item.title;
      if (folder) {
        button.dataset.bibleFolder = "true";
        button.setAttribute("aria-label", t("bible.folder.label", { title: item.title }));
        button.setAttribute("aria-expanded", String(!collapsed.has(item.id)));
      }
      buttons.set(item.id, button);
      return button;
    }));
    list.scrollTop = previousScroll;
    paintStates();
    if (focusedId !== null) {
      let cursor: string | null = focusedId;
      const byId = new Map(items.map((item) => [item.id, item]));
      while (cursor !== null && !buttons.has(cursor)) cursor = byId.get(cursor)?.parent_id ?? null;
      (cursor === null ? buttons.values().next().value : buttons.get(cursor))?.focus();
    }
  };

  const select = (id: string): void => {
    selectedId = id;
    paintStates();
    deps.onSelect(id);
  };
  const toggle = (id: string): void => {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    paint();
    buttons.get(id)?.focus();
  };
  const click = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-bible-id]");
    const id = button?.dataset.bibleId;
    if (id === undefined) return;
    if (button?.dataset.bibleFolder === "true") { select(id); toggle(id); }
    else deps.onOpen(id);
  };
  const keydown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-bible-folder]") : null;
    const id = button?.dataset.bibleId;
    if (id === undefined) return;
    const shouldCollapse = event.key === "ArrowLeft";
    if (collapsed.has(id) === shouldCollapse) return;
    event.preventDefault();
    select(id);
    toggle(id);
  };
  list.addEventListener("click", click);
  list.addEventListener("keydown", keydown);
  const setBibleRows = (rows: number): void => section.style.setProperty("--bible-visible-rows", String(bibleRowsFrom(rows)));
  setBibleRows(deps.bibleRows);
  paint();
  return {
    setItems(next) {
      items = next;
      const folderIds = new Set(bibleEntriesIn(items).filter((entry) => entry.folder).map((entry) => entry.item.id));
      for (const id of collapsed) if (!folderIds.has(id)) collapsed.delete(id);
      paint();
    },
    setActiveId(id) {
      activeId = id;
      let expanded = false;
      const byId = new Map(items.map((item) => [item.id, item]));
      let cursor = id === null ? null : byId.get(id)?.parent_id ?? null;
      for (let step = 0; step <= items.length && cursor !== null; step++) {
        if (collapsed.delete(cursor)) expanded = true;
        cursor = byId.get(cursor)?.parent_id ?? null;
      }
      if (expanded) paint();
      else paintStates();
      if (id !== null) buttons.get(id)?.scrollIntoView?.({ block: "nearest" });
    },
    setSelectedId(id) { selectedId = id; paintStates(); },
    setBibleRows,
    destroy() { list.removeEventListener("click", click); list.removeEventListener("keydown", keydown); section.remove(); },
  };
}
