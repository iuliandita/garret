import { isCompositionKey } from "./composition-key";
import { formatNumber, plural, t } from "./i18n";
import { createIcon } from "./icons";
import { clampToViewport, createMenuPanel, type MenuItemSpec } from "./menu-panel";
import { isContextMenuChord } from "./nav-context-menu";
import { isOpenableType } from "./open";
import { manuscriptItemsIn, planMove, type MoveDirection, type OutlineOutcome } from "./outline";
import { formatCount } from "./outline-counts";
import { proseItem, savedProse } from "./saved-prose";
import { isRevisionState, NO_STATE_LABEL, STATE_LABELS } from "./revision-states";
import type { ProjectItem } from "./store/source";
import { createTooltip } from "./tooltip";

export type OutlineViewMode = "manuscript" | "table" | "cards" | "reading";
export const OUTLINE_PAGE_SIZE = 100;
export const READING_PAGE_SIZE = 20;

export interface OutlineViewTransitions {
  show(mode: "table" | "cards" | "reading"): Promise<boolean>;
  returnToEditor(): void;
  cancel(): void;
}

export function createOutlineViewTransitions(deps: {
  mode(): OutlineViewMode;
  drain(): Promise<void>;
  failed(): boolean;
  show(mode: "table" | "cards" | "reading"): void;
  returnToEditor(): void;
}): OutlineViewTransitions {
  let generation = 0;
  return {
    async show(mode) {
      const request = ++generation;
      if (deps.mode() === "manuscript") {
        try { await deps.drain(); } catch { return false; }
      }
      if (request !== generation || deps.failed()) return false;
      deps.show(mode);
      return true;
    },
    returnToEditor() { ++generation; deps.returnToEditor(); },
    cancel() { ++generation; },
  };
}

function itemTypeLabel(type: string): string {
  switch (type) {
    case "part": return t("outline-view.type.part");
    case "chapter": return t("outline-view.type.chapter");
    case "scene": return t("outline-view.type.scene");
    case "front": return t("outline-view.type.front");
    case "back": return t("outline-view.type.back");
    case "matter": return t("outline-view.type.matter");
    default: return type;
  }
}

export function outlinePage(items: readonly ProjectItem[], page: number): { rows: ProjectItem[]; page: number; pages: number; total: number } {
  const rows = manuscriptItemsIn(items);
  const pages = Math.max(1, Math.ceil(rows.length / OUTLINE_PAGE_SIZE));
  const current = Math.max(1, Math.min(page, pages));
  return { rows: rows.slice((current - 1) * OUTLINE_PAGE_SIZE, current * OUTLINE_PAGE_SIZE), page: current, pages, total: rows.length };
}

export function readingPage(items: readonly ProjectItem[], page: number): { rows: { item: ProjectItem; path: string }[]; page: number; pages: number; total: number } {
  const ancestors: string[] = [];
  const rows: { item: ProjectItem; path: string }[] = [];
  for (const item of manuscriptItemsIn(items)) {
    ancestors.length = item.depth;
    if (proseItem(item.type)) rows.push({ item, path: [...ancestors.filter(Boolean), item.title].join(" / ") });
    ancestors[item.depth] = item.title;
  }
  const pages = Math.max(1, Math.ceil(rows.length / READING_PAGE_SIZE));
  const current = Math.max(1, Math.min(page, pages));
  return { rows: rows.slice((current - 1) * READING_PAGE_SIZE, current * READING_PAGE_SIZE), page: current, pages, total: rows.length };
}

const MOVE_ORDER: readonly { direction: MoveDirection; key: string }[] = [
  { direction: "up", key: "move-up" },
  { direction: "down", key: "move-down" },
  { direction: "outdent", key: "move-out" },
  { direction: "indent", key: "move-in" },
];

/** Which of the four moves a row's Move menu offers as enabled.
 *
 *  `planMove` itself, against the walk the view was painted from, so the menu
 *  greys exactly what the navigator's Alt+Arrow would find inert. The store
 *  still decides when the item runs: this is what the writer is SHOWN, never a
 *  gate the move depends on. */
export function moveAvailability(items: readonly ProjectItem[], id: string): Record<MoveDirection, boolean> {
  const walk = items.slice();
  const can = (direction: MoveDirection): boolean => planMove(walk, id, direction).kind === "move";
  return { up: can("up"), down: can("down"), outdent: can("outdent"), indent: can("indent") };
}

export type OutlineRowKeyAction =
  | { kind: "focus"; index: number }
  | { kind: "move"; direction: MoveDirection }
  | { kind: "activate" }
  | { kind: "menu" };

const ROW_MOVE_KEYS: Readonly<Record<string, MoveDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "outdent",
  ArrowRight: "indent",
};

/** The outline view's row keys, as a pure answer.
 *
 *  The navigator's model restated for a table: arrows and Home/End walk the
 *  rows, Enter and Space activate, Alt+Arrow is the navigator's own move chord
 *  and Shift+F10 / the ContextMenu key open the row's Move menu. `onRow` is
 *  false while focus is on a control inside the row: that control owns its
 *  own Enter, Space and arrows, and only the move chord still applies. */
export function outlineRowKey(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  index: number,
  count: number,
  onRow: boolean,
): OutlineRowKeyAction | null {
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    const direction = ROW_MOVE_KEYS[event.key];
    return direction === undefined ? null : { kind: "move", direction };
  }
  if (!onRow) return null;
  if (isContextMenuChord(event as KeyboardEvent)) return { kind: "menu" };
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const last = Math.max(0, count - 1);
  switch (event.key) {
    case "ArrowUp": return { kind: "focus", index: Math.max(0, index - 1) };
    case "ArrowDown": return { kind: "focus", index: Math.min(last, index + 1) };
    case "Home": return { kind: "focus", index: 0 };
    case "End": return { kind: "focus", index: last };
    case "Enter":
    case " ": return { kind: "activate" };
    default: return null;
  }
}

export type DropPlan =
  /** Where the drop line is drawn: on the edge of `id`'s row. */
  | { kind: "reorder"; steps: MoveDirection[]; line: { id: string; edge: "before" | "after" } }
  | { kind: "same" }
  | { kind: "refused" };

/** Resolve a pointer over `overId`'s row (its upper or lower half) into the
 *  move steps a drop there means.
 *
 *  WITHIN ONE PARENT ONLY. The store's own moves are the four the navigator
 *  has; a drop is resolved into a run of up or down steps, each planned by the
 *  unit against the live walk, so a drag is exactly the Alt+Arrow presses it
 *  stands for. A row under another parent is refused rather than guessed into a
 *  run of outs and ins.
 *
 *  A pointer over a sibling's DESCENDANT snaps to the nearer end of that
 *  sibling's block, because the only places a drop can land are between
 *  siblings. `rows` is the manuscript walk, depth-first. */
export function planDrop(
  rows: readonly ProjectItem[],
  draggedId: string,
  overId: string,
  half: "before" | "after",
): DropPlan {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const dragged = byId.get(draggedId);
  const over = byId.get(overId);
  if (dragged === undefined || over === undefined) return { kind: "refused" };
  let anchor: ProjectItem | undefined = over;
  const seen = new Set<string>();
  while (anchor !== undefined && anchor.parent_id !== dragged.parent_id) {
    if (anchor.id === draggedId || seen.has(anchor.id)) break;
    seen.add(anchor.id);
    anchor = anchor.parent_id === null ? undefined : byId.get(anchor.parent_id);
  }
  if (anchor === undefined) return { kind: "refused" };
  if (anchor.id === draggedId || anchor.parent_id !== dragged.parent_id) return { kind: "same" };
  const start = rows.indexOf(anchor);
  let end = start + 1;
  while (end < rows.length && rows[end]!.depth > anchor.depth) end += 1;
  const blockLength = end - start;
  const offset = rows.indexOf(over) - start + (half === "after" ? 0.75 : 0.25);
  const edge: "before" | "after" = offset < blockLength / 2 ? "before" : "after";
  const siblings = rows.filter((row) => row.parent_id === dragged.parent_id);
  const from = siblings.indexOf(dragged);
  const at = siblings.indexOf(anchor) + (edge === "after" ? 1 : 0);
  const to = at > from ? at - 1 : at;
  if (to === from) return { kind: "same" };
  const steps: MoveDirection[] = Array.from({ length: Math.abs(to - from) }, () => (to < from ? "up" : "down"));
  return { kind: "reorder", steps, line: edge === "before" ? { id: anchor.id, edge } : { id: rows[end - 1]!.id, edge } };
}

export interface OutlineView {
  element: HTMLElement;
  show(mode: "table" | "cards" | "reading"): void;
  hide(): void;
  mode(): OutlineViewMode;
  setItems(items: readonly ProjectItem[]): void;
  setCounts(counts: ReadonlyMap<string, number>): void;
  selectById(id: string | null): void;
  destroy(): void;
}

export interface OutlineViewDeps {
  editor: HTMLElement;
  items: readonly ProjectItem[];
  readSynopses(ids: string[]): Promise<readonly { item_id: string; body: string }[]>;
  readDocument?(id: string): Promise<{ body: string; rev: number }>;
  onSelect(id: string): void;
  onOpen(id: string): void;
  /** May answer with the unit's outcome; a drag announces only a run that
   *  moved something. `count` is a drag's whole run of steps in one
   *  direction, which must land as ONE undo entry; the keyboard and the
   *  Move menu send one step and leave it out. */
  onMove(id: string, direction: MoveDirection, count?: number): void | Promise<OutlineOutcome>;
  onUndo(): void;
  onRedo(): void;
  onReturn(): void;
  onError(error: unknown): void;
  /** A completed drag, through the page's own announce route. */
  onAnnounce?(message: string): void;
  /** A drop the view refuses, said out loud rather than ignored. */
  onRefuse?(message: string): void;
}

export function createOutlineView(deps: OutlineViewDeps): OutlineView {
  const element = document.createElement("main");
  element.id = "outline-view";
  element.hidden = true;
  deps.editor.after(element);
  let items = deps.items;
  let counts: ReadonlyMap<string, number> = new Map();
  let selectedId: string | null = null;
  let activeId: string | null = null;
  let currentMode: OutlineViewMode = "manuscript";
  let page = 1;
  let readGeneration = 0;
  const synopsisCache = new Map<string, string | null>();
  const synopsisFailures = new Set<string>();
  const tableResize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    for (const entry of entries) {
      const scroll = entry.target as HTMLElement;
      scroll.dataset.overflow = String(scroll.scrollWidth > scroll.clientWidth);
    }
  });

  function button(label: string, action: () => void, disabled = false, actionId?: string, itemId?: string): HTMLButtonElement {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.disabled = disabled;
    if (actionId !== undefined) control.dataset.action = actionId;
    if (itemId !== undefined) control.dataset.itemId = itemId;
    control.addEventListener("click", action);
    return control;
  }

  function paint(): void {
    if (currentMode === "manuscript") return;
    tableResize?.disconnect();
    cancelDrag();
    closeMenu();
    if (currentMode === "reading") { paintReading(); return; }
    const previousScroll = element.querySelector<HTMLElement>(".outline-view-table-scroll");
    const scrollLeft = previousScroll?.scrollLeft ?? 0;
    const scrollTop = previousScroll?.scrollTop ?? 0;
    const focused = element.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusAction = focused?.dataset.action;
    const focusItemId = focused?.dataset.itemId;
    const restoreFocus = (): void => {
      if (focused === null) return;
      if (focused === previousScroll) {
        const scroll = element.querySelector<HTMLElement>(".outline-view-table-scroll");
        if (scroll !== null) { scroll.focus({ preventScroll: true }); return; }
      }
      const controls = [...element.querySelectorAll<HTMLElement>("[data-action]")];
      const live = (control: HTMLElement): boolean => !(control instanceof HTMLButtonElement && control.disabled);
      const same = controls.find((control) => control.dataset.action === focusAction && control.dataset.itemId === focusItemId && live(control));
      const fallback = controls.find((control) => control.dataset.action === "previous" && live(control))
        ?? controls.find((control) => control.dataset.action === "next" && live(control));
      const target = same ?? fallback ?? element.querySelector<HTMLElement>("h1");
      if (target?.tagName === "H1") target.tabIndex = -1;
      if (target?.dataset.action === "row" && target.dataset.itemId !== undefined) setActive(target.dataset.itemId);
      target?.focus();
    };
    const projection = outlinePage(items, page);
    page = projection.page;
    const heading = document.createElement("h1");
    heading.textContent = t(currentMode === "table" ? "outline-view.table" : "outline-view.cards");
    const scope = document.createElement("p");
    scope.className = "outline-view-scope";
    scope.textContent = t("outline-view.scope");
    const toolbar = document.createElement("div");
    toolbar.className = "outline-view-toolbar";
    toolbar.append(button(t("outline-view.return"), deps.onReturn, false, "return"));
    const pagination = document.createElement("nav");
    pagination.className = "outline-view-pages";
    pagination.setAttribute("aria-label", t("outline-view.pages.label"));
    pagination.append(
      button(t("outline-view.previous"), () => { page -= 1; paint(); }, page <= 1, "previous"),
      Object.assign(document.createElement("span"), { textContent: plural("outline-view.page", projection.total, { page: formatNumber(page), pages: formatNumber(projection.pages), count: formatNumber(projection.total) }) }),
      button(t("outline-view.next"), () => { page += 1; paint(); }, page >= projection.pages, "next"),
    );
    const actions = document.createElement("div");
    actions.className = "outline-view-actions";
    actions.append(button(t("outline-view.undo"), deps.onUndo, false, "undo"), button(t("outline-view.redo"), deps.onRedo, false, "redo"));
    // One line of controls above the rows: three stacked strips of
    // buttons read as three toolbars and pushed the first row down the page.
    const controlsBar = document.createElement("div");
    controlsBar.className = "outline-view-controls";
    controlsBar.append(toolbar, pagination, actions);
    const surface = document.createElement(currentMode === "table" ? "table" : "div");
    surface.className = currentMode === "table" ? "outline-view-table" : "outline-view-cards";
    if (currentMode === "table") {
      const head = document.createElement("thead");
      const tr = document.createElement("tr");
      for (const key of ["title", "type", "state", "words", "synopsis", "actions"]) {
        const th = document.createElement("th"); th.scope = "col"; th.textContent = t(`outline-view.column.${key}`); th.dataset.column = key; tr.append(th);
      }
      head.append(tr); surface.append(head);
    }
    const rowsHost = currentMode === "table" ? document.createElement("tbody") : surface;
    if (projection.total === 0) {
      const empty = document.createElement("p"); empty.className = "outline-view-empty"; empty.textContent = t("outline-view.empty");
      element.replaceChildren(heading, scope, controlsBar, empty);
      restoreFocus();
      return;
    }
    if (!projection.rows.some((item) => item.id === activeId)) {
      activeId = projection.rows.find((item) => item.id === selectedId)?.id ?? projection.rows[0]!.id;
    }
    for (const item of projection.rows) {
      const row = document.createElement(currentMode === "table" ? "tr" : "article");
      row.className = "outline-view-row";
      row.dataset.itemId = item.id;
      row.dataset.action = "row";
      row.dataset.type = item.type;
      row.dataset.selected = String(item.id === selectedId);
      row.tabIndex = item.id === activeId ? 0 : -1;
      const state = item.state === null ? NO_STATE_LABEL : isRevisionState(item.state) ? STATE_LABELS[item.state] : item.state;
      const counted = counts.get(item.id);
      const words = formatCount(counted) || t("outline-view.uncounted");
      const openable = isOpenableType(item.type);
      // A title is text, and a link where the row opens: the bordered
      // chip read as a button beside the real buttons. Parts and chapters are
      // not openable, so theirs is plain text and the row itself selects.
      const title: HTMLElement = openable
        ? button(item.title, () => { selectedId = item.id; activeId = item.id; deps.onOpen(item.id); }, false, "open-title", item.id)
        : document.createElement("span");
      if (!openable) title.textContent = item.title;
      title.classList.add("outline-view-title");
      title.setAttribute("aria-current", item.id === selectedId ? "true" : "false");
      const synopsis = document.createElement(currentMode === "table" ? "td" : "div");
      synopsis.className = "outline-view-synopsis";
      const synopsisText = document.createElement("p");
      synopsisText.className = "outline-view-synopsis-text";
      synopsisText.dataset.synopsisId = item.id;
      synopsisText.textContent = synopsisFailures.has(item.id)
        ? t("outline-view.synopsis-unavailable")
        : synopsisCache.has(item.id)
          ? synopsisCache.get(item.id) || t("outline-view.no-synopsis")
          : t("outline-view.synopsis-loading");
      synopsis.append(synopsisText);
      const controls = document.createElement(currentMode === "table" ? "td" : "div");
      controls.className = "outline-view-row-actions";
      if (openable) {
        // "Open" on the row, "Open in editor" to a screen reader: the long
        // label beside Move pushed the column past the pane's right edge.
        const open = button(t("outline-view.open.short"), () => { selectedId = item.id; activeId = item.id; deps.onOpen(item.id); }, false, "open", item.id);
        open.setAttribute("aria-label", t("outline-view.open"));
        controls.append(open);
      }
      const move = button(t("outline-view.move"), () => toggleMenu(item.id, move), false, "move", item.id);
      move.setAttribute("aria-label", t("outline-view.move.label", { title: item.title }));
      move.setAttribute("aria-haspopup", "menu");
      move.setAttribute("aria-expanded", "false");
      controls.append(move);
      for (const control of [title, ...controls.children]) {
        if (control instanceof HTMLButtonElement) control.tabIndex = item.id === activeId ? 0 : -1;
      }
      if (currentMode === "table") {
        const titleCell = document.createElement("td");
        titleCell.className = "outline-view-title-cell";
        titleCell.style.setProperty("--outline-depth", String(item.depth));
        const grip = document.createElement("span");
        grip.className = "outline-view-grip";
        // Decorative for the accessibility tree: the keyboard route to the
        // same act is Alt+Arrow and the Move menu, both of which are named.
        grip.setAttribute("aria-hidden", "true");
        grip.append(createIcon("grip-vertical"));
        grip.addEventListener("pointerdown", (event) => startDrag(event, item.id, grip, row));
        const titleLine = document.createElement("div");
        titleLine.className = "outline-view-title-line";
        titleLine.append(grip, title);
        titleCell.append(titleLine);
        const cells: HTMLElement[] = [titleCell];
        for (const [column, content] of [["type", itemTypeLabel(item.type)], ["state", state], ["words", words]] as const) {
          const cell = document.createElement("td");
          cell.dataset.column = column;
          cell.textContent = content;
          cells.push(cell);
        }
        row.append(...cells, synopsis, controls);
      } else {
        const cardTitle = document.createElement("h2"); cardTitle.append(title);
        const meta = document.createElement("p"); meta.className = "outline-view-meta";
        const wordsLine = counted === undefined ? words : plural("outline-view.words", counted, { count: words });
        meta.textContent = item.state === null
          ? t("outline-view.meta.no-state", { type: itemTypeLabel(item.type), words: wordsLine })
          : t("outline-view.meta", { type: itemTypeLabel(item.type), state, words: wordsLine });
        row.append(cardTitle, meta, synopsis, controls);
      }
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button") !== null) return;
        selectedId = item.id;
        setActive(item.id);
        deps.onSelect(item.id);
        paint();
      });
      rowsHost.append(row);
    }
    rowsHost.addEventListener("keydown", onRowsKey);
    if (currentMode === "table") surface.append(rowsHost);
    if (currentMode === "table") {
      const hint = document.createElement("p");
      hint.className = "outline-view-scroll-hint";
      hint.textContent = t("outline-view.scroll-hint");
      const tableScroll = document.createElement("div");
      tableScroll.className = "outline-view-table-scroll";
      tableScroll.setAttribute("role", "region");
      tableScroll.setAttribute("aria-label", t("outline-view.table"));
      tableScroll.tabIndex = 0;
      tableScroll.append(surface);
      element.replaceChildren(heading, scope, controlsBar, hint, tableScroll);
      tableScroll.scrollLeft = scrollLeft;
      tableScroll.scrollTop = scrollTop;
      tableScroll.dataset.overflow = String(tableScroll.scrollWidth > tableScroll.clientWidth);
      tableResize?.observe(tableScroll);
    } else {
      element.replaceChildren(heading, scope, controlsBar, surface);
    }
    restoreFocus();
    const generation = ++readGeneration;
    const ids = projection.rows.filter((item) => !synopsisCache.has(item.id) && !synopsisFailures.has(item.id)).map((item) => item.id);
    if (ids.length === 0) { tipTruncated(generation); return; }
    void deps.readSynopses(ids).then((synopses) => {
      if (generation !== readGeneration || element.hidden) return;
      const byId = new Map(synopses.map((synopsis) => [synopsis.item_id, synopsis.body]));
      for (const id of ids) synopsisCache.set(id, byId.get(id) ?? null);
      for (const node of element.querySelectorAll<HTMLElement>("[data-synopsis-id]")) {
        node.textContent = synopsisCache.get(node.dataset.synopsisId ?? "") || t("outline-view.no-synopsis");
      }
      tipTruncated(generation);
    }).catch((error: unknown) => {
      if (generation !== readGeneration || element.hidden) return;
      for (const id of ids) synopsisFailures.add(id);
      for (const node of element.querySelectorAll<HTMLElement>("[data-synopsis-id]")) {
        if (ids.includes(node.dataset.synopsisId ?? "")) node.textContent = t("outline-view.synopsis-unavailable");
      }
      deps.onError(error);
    });
  }

  /** The synopsis is clamped to two lines; the whole of it is in the DOM, so
   *  the accessibility tree already carries every word. A pointer reader gets
   *  the rest from a tip, and only where the clamp actually cut something:
   *  measured after layout, so a short synopsis never repeats itself. */
  function tipTruncated(generation: number): void {
    const measure = (): void => {
      if (generation !== readGeneration || element.hidden) return;
      for (const node of element.querySelectorAll<HTMLElement>("[data-synopsis-id]")) {
        const text = synopsisCache.get(node.dataset.synopsisId ?? "");
        if (!text || node.parentElement?.classList.contains("tip-anchor") || node.scrollHeight <= node.clientHeight + 1) continue;
        const holder = node.parentElement;
        const tip = createTooltip({ control: node, name: text, hint: null });
        holder?.append(tip.anchor);
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure); else measure();
  }

  function rowElements(): HTMLElement[] {
    return [...element.querySelectorAll<HTMLElement>(".outline-view-row")];
  }

  /** Roving tabindex: one row, and that row's own controls, are in the
   *  Tab order; every other row is reached with the arrows. A hundred rows of
   *  three controls each would otherwise be three hundred Tab stops. */
  function setActive(id: string): void {
    activeId = id;
    for (const row of rowElements()) {
      const on = row.dataset.itemId === id;
      row.tabIndex = on ? 0 : -1;
      for (const control of row.querySelectorAll<HTMLButtonElement>("button")) control.tabIndex = on ? 0 : -1;
    }
  }

  function focusRow(id: string): void {
    const row = rowElements().find((candidate) => candidate.dataset.itemId === id);
    if (row === undefined) return;
    setActive(id);
    row.focus();
  }

  /** Every move this view makes, from the keyboard, the menu or a drop: the
   *  row is selected first, exactly as the four buttons did, and focus sits on
   *  the row so the repaint that follows the store's answer puts it back. */
  function moveRow(id: string, direction: MoveDirection, count?: number): ReturnType<OutlineViewDeps["onMove"]> {
    selectedId = id;
    deps.onSelect(id);
    paint();
    focusRow(id);
    return count === undefined ? deps.onMove(id, direction) : deps.onMove(id, direction, count);
  }

  function onRowsKey(event: KeyboardEvent): void {
    if (isCompositionKey(event)) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".outline-view-row");
    const id = row?.dataset.itemId;
    if (row === null || id === undefined) return;
    const rows = rowElements();
    const action = outlineRowKey(event, rows.indexOf(row), rows.length, target === row);
    if (action === null) return;
    event.preventDefault();
    switch (action.kind) {
      case "focus": {
        const next = rows[action.index]?.dataset.itemId;
        if (next !== undefined) focusRow(next);
        return;
      }
      // The navigator's own guard against a held chord: nothing is dropped
      // here, because the outline unit chains every move behind the one before
      // it and plans each against the walk that one left.
      case "move": void moveRow(id, action.direction); return;
      case "menu": {
        const opener = row.querySelector<HTMLButtonElement>('button[data-action="move"]');
        if (opener !== null) toggleMenu(id, opener);
        return;
      }
      case "activate": {
        const item = items.find((candidate) => candidate.id === id);
        if (item !== undefined && isOpenableType(item.type)) { selectedId = id; deps.onOpen(id); return; }
        selectedId = id;
        deps.onSelect(id);
        paint();
        return;
      }
    }
  }

  // THE MOVE MENU: one dropdown for the view, the shared `menu-panel.ts`,
  // opened under the row's Move button. The four items call the same
  // `deps.onMove` the four buttons did, with the same catalog labels.
  const menu = createMenuPanel({
    id: "outline-move-menu",
    onClose: () => { menuOpener?.setAttribute("aria-expanded", "false"); menuOpener = null; menuFor = null; },
  });
  document.body.append(menu.element);
  let menuFor: string | null = null;
  let menuOpener: HTMLButtonElement | null = null;

  function closeMenu(): void { menu.close(); }

  function toggleMenu(id: string, opener: HTMLButtonElement): void {
    if (menuFor === id) { closeMenu(); return; }
    closeMenu();
    const title = items.find((item) => item.id === id)?.title ?? id;
    const can = moveAvailability(items, id);
    const specs: MenuItemSpec[] = MOVE_ORDER.map(({ direction, key }) => ({
      id: `outline-move-${direction}`,
      label: () => t(`menu.${key}`),
      enabled: () => can[direction],
      run: () => { void moveRow(id, direction); },
    }));
    setActive(id);
    menu.paint(specs, t("outline-view.move.label", { title }));
    menuFor = id;
    menuOpener = opener;
    opener.setAttribute("aria-expanded", "true");
    const box = opener.getBoundingClientRect();
    const width = menu.element.offsetWidth;
    const height = menu.element.offsetHeight;
    const below = box.bottom + 4;
    const y = below + height > window.innerHeight ? box.top - height - 4 : below;
    const at = clampToViewport(box.right - width, y, width, height, window.innerWidth, window.innerHeight);
    menu.element.style.left = `${at.x}px`;
    menu.element.style.top = `${at.y}px`;
    const first = MOVE_ORDER.findIndex(({ direction }) => can[direction]);
    menu.focusItem(Math.max(0, first));
  }

  const onDocumentKey = (event: KeyboardEvent): void => {
    if (isCompositionKey(event) || !menu.isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const opener = menuOpener;
      closeMenu();
      opener?.focus();
      return;
    }
    if (event.key === "Tab") { closeMenu(); return; }
    menu.handleArrowKey(event);
  };
  // Capture, like `dismiss-outside.ts`, and the opener excluded: a click on the
  // Move button that opened the menu is the button's own toggle, not an
  // outside click that would close the menu for the button to reopen.
  const onDocumentClick = (event: Event): void => {
    if (!menu.isOpen()) return;
    const target = event.target;
    if (target instanceof Node && (menu.element.contains(target) || menuOpener?.contains(target) === true)) return;
    closeMenu();
  };
  document.addEventListener("keydown", onDocumentKey);
  document.addEventListener("click", onDocumentClick, true);

  // DRAG TO REORDER. Pointer events with capture on the grip, not HTML5
  // drag and drop: WebKitGTK's native drag starts a toolkit drag session that
  // the X test rigs cannot drive and that paints its own ghost. The drop is
  // `planDrop`'s run of up or down steps, sent through `deps.onMove` as one
  // call with its count so the run is one undo entry.
  let drag: { id: string; pointerId: number; grip: HTMLElement; row: HTMLElement; plan: DropPlan | null; marked: HTMLElement | null } | null = null;

  function clearMark(): void {
    if (drag?.marked) { delete drag.marked.dataset.drop; drag.marked = null; }
  }

  function startDrag(event: PointerEvent, id: string, grip: HTMLElement, row: HTMLElement): void {
    if (event.button !== 0 || currentMode !== "table") return;
    event.preventDefault();
    closeMenu();
    cancelDrag();
    try { grip.setPointerCapture(event.pointerId); } catch { /* capture is a convenience: the moves below still arrive */ }
    drag = { id, pointerId: event.pointerId, grip, row, plan: null, marked: null };
    row.dataset.dragging = "true";
    element.dataset.dragging = "true";
    grip.addEventListener("pointermove", onDragMove);
    grip.addEventListener("pointerup", onDragEnd);
    grip.addEventListener("pointercancel", cancelDrag);
    document.addEventListener("keydown", onDragKey, true);
  }

  function onDragMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const bounds = element.getBoundingClientRect();
    if (event.clientY < bounds.top + 40) element.scrollTop -= 12;
    else if (event.clientY > bounds.bottom - 40) element.scrollTop += 12;
    clearMark();
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".outline-view-row");
    const overId = over?.dataset.itemId;
    if (over === null || over === undefined || overId === undefined) { drag.plan = null; return; }
    const box = over.getBoundingClientRect();
    const plan = planDrop(manuscriptItemsIn(items), drag.id, overId, event.clientY < box.top + box.height / 2 ? "before" : "after");
    drag.plan = plan;
    const marked = plan.kind === "reorder"
      ? rowElements().find((candidate) => candidate.dataset.itemId === plan.line.id) ?? null
      : plan.kind === "refused" ? over : null;
    if (marked !== null) {
      marked.dataset.drop = plan.kind === "reorder" ? plan.line.edge : "refused";
      drag.marked = marked;
    }
  }

  function onDragEnd(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const { id, plan } = drag;
    cancelDrag();
    if (plan?.kind === "refused") { deps.onRefuse?.(t("outline-view.drop-refused")); return; }
    if (plan?.kind !== "reorder") return;
    const title = items.find((item) => item.id === id)?.title ?? id;
    // Every step of a plan runs one way (planDrop), so the run is one call.
    void Promise.resolve(moveRow(id, plan.steps[0]!, plan.steps.length)).then((result) => {
      if (result === "applied") deps.onAnnounce?.(t("outline-view.moved", { title }));
    });
  }

  function onDragKey(event: KeyboardEvent): void {
    if (drag === null || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
  }

  function cancelDrag(): void {
    if (drag === null) return;
    const { grip, row, pointerId } = drag;
    clearMark();
    drag = null;
    delete row.dataset.dragging;
    delete element.dataset.dragging;
    grip.removeEventListener("pointermove", onDragMove);
    grip.removeEventListener("pointerup", onDragEnd);
    grip.removeEventListener("pointercancel", cancelDrag);
    document.removeEventListener("keydown", onDragKey, true);
    try { if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId); } catch { /* already released with the element */ }
  }

  function paintReading(): void {
    const generation = ++readGeneration;
    const focusAction = element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
    const focusItemId = element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.itemId : undefined;
    const projection = readingPage(items, page);
    page = projection.page;
    const heading = document.createElement("h1");
    heading.textContent = t("reading.title");
    const scope = document.createElement("p");
    scope.className = "outline-view-scope";
    scope.textContent = t("reading.scope", { from: formatNumber(projection.total ? (page - 1) * READING_PAGE_SIZE + 1 : 0), to: formatNumber((page - 1) * READING_PAGE_SIZE + projection.rows.length), total: formatNumber(projection.total) });
    const nav = document.createElement("nav");
    nav.className = "outline-view-pages";
    nav.setAttribute("aria-label", t("reading.pages"));
    nav.append(
      button(t("outline-view.return"), deps.onReturn, false, "return"),
      button(t("outline-view.previous"), () => { page -= 1; paintReading(); element.scrollTop = 0; }, page <= 1, "previous"),
      Object.assign(document.createElement("span"), { textContent: t("reading.page", { page: formatNumber(page), pages: formatNumber(projection.pages) }) }),
      button(t("outline-view.next"), () => { page += 1; paintReading(); element.scrollTop = 0; }, page >= projection.pages, "next"),
    );
    const surface = document.createElement("div");
    surface.className = "reading-documents";
    for (const row of projection.rows) {
      const article = document.createElement("article");
      article.className = "reading-document";
      article.dataset.itemId = row.item.id;
      const label = document.createElement("h2");
      label.textContent = row.path;
      const revision = document.createElement("p");
      revision.className = "reading-revision";
      revision.textContent = t("reading.loading");
      const open = button(t("outline-view.open"), () => deps.onOpen(row.item.id), false, "open", row.item.id);
      const content = document.createElement("div");
      content.className = "saved-prose";
      content.textContent = t("reading.loading");
      article.append(label, revision, open, content);
      surface.append(article);
      if (deps.readDocument === undefined) { revision.textContent = t("reading.unavailable"); content.textContent = t("reading.unavailable"); continue; }
      void deps.readDocument(row.item.id).then((loaded) => {
        if (generation !== readGeneration || element.hidden) return;
        const fragment = savedProse(loaded.body, content.ownerDocument);
        revision.textContent = t("reference.revision", { revision: formatNumber(loaded.rev) });
        if (fragment === null) content.textContent = t("reference.unsupported");
        else content.replaceChildren(fragment);
      }).catch(() => {
        if (generation === readGeneration && !element.hidden) {
          revision.textContent = t("reading.unavailable");
          content.textContent = t("reading.unavailable");
        }
      });
    }
    if (projection.total === 0) surface.textContent = t("outline-view.empty");
    element.replaceChildren(heading, scope, nav, surface);
    if (focusAction !== undefined) {
      const same = [...element.querySelectorAll<HTMLButtonElement>("button[data-action]")]
        .find((control) => control.dataset.action === focusAction && control.dataset.itemId === focusItemId && !control.disabled);
      const target = same
        ?? element.querySelector<HTMLButtonElement>('button[data-action="previous"]:not(:disabled)')
        ?? element.querySelector<HTMLButtonElement>('button[data-action="next"]:not(:disabled)');
      target?.focus();
    }
  }

  return {
    element,
    show(mode) { ++readGeneration; if (currentMode === "manuscript") { synopsisCache.clear(); synopsisFailures.clear(); } currentMode = mode; page = 1; element.hidden = false; paint(); element.querySelector<HTMLElement>("h1")?.setAttribute("tabindex", "-1"); element.querySelector<HTMLElement>("h1")?.focus(); },
    hide() { ++readGeneration; tableResize?.disconnect(); cancelDrag(); closeMenu(); currentMode = "manuscript"; element.hidden = true; },
    mode: () => currentMode,
    setItems(next) { items = next; synopsisCache.clear(); synopsisFailures.clear(); if (currentMode !== "reading") { const index = manuscriptItemsIn(items).findIndex((item) => item.id === selectedId); if (index >= 0) page = Math.floor(index / OUTLINE_PAGE_SIZE) + 1; } paint(); },
    setCounts(next) { counts = next; if (currentMode !== "reading") paint(); },
    selectById(id) { selectedId = id; if (currentMode === "table" || currentMode === "cards") { const index = manuscriptItemsIn(items).findIndex((item) => item.id === id); if (index >= 0) page = Math.floor(index / OUTLINE_PAGE_SIZE) + 1; paint(); } },
    destroy() {
      ++readGeneration;
      tableResize?.disconnect();
      cancelDrag();
      document.removeEventListener("keydown", onDocumentKey);
      document.removeEventListener("click", onDocumentClick, true);
      menu.destroy();
      element.remove();
    },
  };
}
