// app/ui/src/quick-open.ts
// Ctrl+P: type part of a title, press Return, land in that scene.
//
// The navigator already has type-ahead, and this is not a second copy of it.
// Type-ahead jumps to the next row whose title STARTS with what you type, in
// walk order, and it only works while focus is in the navigator. That is a
// good way to move a few rows; it is not a way to reach chapter forty of a book
// you are three hundred scenes into, because you have to be looking at the tree
// and you have to know the title's first letters.
//
// This filters the whole manuscript on a substring, from anywhere in the
// application, without the writer's hands leaving the keyboard.
//
// SUBSTRING, not fuzzy subsequence. A subsequence match ranks "Harbour" against
// "H...a...r" and produces results a writer cannot predict or explain; when it
// surprises them, there is nothing to learn. A substring match is a rule anyone
// can hold in their head, and a writer who gets no results knows exactly why.
//
// The list is the OUTLINE'S LIVE WALK, read at open time and never cached: a
// scene created a moment ago must be reachable, and a Map built at mount answers
// `undefined` for it - the defect the outline slice shipped once, where a
// created row appeared and clicking it did nothing.
import { isCompositionKey } from "./composition-key";
import { formatNumber, plural, t } from "./i18n";
import { closeOnOutsideClick } from "./dismiss-outside";
import { foldForFind } from "./find-locate";
import { isOpenableType } from "./open";

/** What the panel needs of an item. A structural subset of the store's
 *  ProjectItem rather than that type itself, so a test can build one without a
 *  position string and a revision it has no opinion about. */
export interface QuickOpenItem {
  id: string;
  title: string;
  type: string;
}

export interface QuickOpenDeps {
  /** The bar element from index.html. The panel is positioned absolutely
   *  against #project-bar, so this contributes nothing to the strip. */
  container: HTMLElement;
  /** The LIVE walk. Called on every open, never cached. */
  items: () => readonly QuickOpenItem[];
  /** Opens a scene, through the page's existing activation path so everything
   *  already true about opening stays true and is not restated here. */
  openItem: (itemId: string) => void;
  /** Moves the navigator's selection. Called for EVERY chosen row, not only for
   *  a part or a chapter: the selection is what Outline > Delete, a create and
   *  Alt+Arrow all act on, so a jump that moves the open document and not the
   *  selection leaves those commands pointing at the row the writer left. */
  selectItem: (itemId: string) => void;
  /** Where focus goes when the panel is dismissed without choosing. */
  onDismiss: () => void;
}

export interface QuickOpen {
  /** Open the panel and put the caret in the field, as Ctrl+P does. For the
   *  application menu's item: one binding, two callers. */
  open(): void;
  destroy(): void;
}

/** How many rows the panel will paint.
 *
 *  A cap, not a page. At `stress` a two-character query matches thousands of
 *  titles, and a writer scrolling a list of thousands has not been helped -
 *  they have been handed the manuscript back. The status line says how many
 *  matched, so the number is never hidden; the answer to "too many" is a longer
 *  query, and the panel says so. */
const SHOWN_LIMIT = 40;

/** Matches, in walk order, capped.
 *
 *  Exported for its own tests: the ranking rule is the whole behaviour of this
 *  unit and it must be falsifiable without a DOM.
 *
 *  Order is TITLE-PREFIX matches first, then the rest, each keeping walk order.
 *  A writer typing "harb" wants "Harbour Lights" before "The Old Harbour", and
 *  within each group the manuscript's own order is the only one that means
 *  anything - alphabetical would scatter a book's chapters. */
export function matchItems(
  items: readonly QuickOpenItem[],
  query: string,
): { shown: QuickOpenItem[]; total: number } {
  const needle = foldForFind(query.trim());
  if (needle.length === 0) {
    // Everything, in walk order. An empty field is not "no results" - the panel
    // opens on it, and a panel that opens empty looks broken.
    return { shown: items.slice(0, SHOWN_LIMIT), total: items.length };
  }
  const prefix: QuickOpenItem[] = [];
  const rest: QuickOpenItem[] = [];
  for (const item of items) {
    const folded = foldForFind(item.title);
    if (folded.startsWith(needle)) prefix.push(item);
    else if (folded.includes(needle)) rest.push(item);
  }
  const all = [...prefix, ...rest];
  return { shown: all.slice(0, SHOWN_LIMIT), total: all.length };
}

export function createQuickOpen(deps: QuickOpenDeps): QuickOpen {
  const { container } = deps;
  container.replaceChildren();

  const panel = document.createElement("div");
  panel.id = "quick-open-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus, and aria-modal="true" would tell a screen reader
  // the rest of the page is inert when it is not. Same as the find panel.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("quick-open.panel.label"));
  panel.hidden = true;

  const input = document.createElement("input");
  input.id = "quick-open-query";
  input.type = "text";
  input.setAttribute("aria-label", t("quick-open.query.label"));
  // The listbox this field drives, and the row it has highlighted. Without both,
  // a screen reader announces the typing and nothing about what it selected.
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "quick-open-results");
  input.setAttribute("aria-autocomplete", "list");

  const status = document.createElement("div");
  status.id = "quick-open-status";
  status.setAttribute("role", "status");

  const results = document.createElement("div");
  results.id = "quick-open-results";
  results.setAttribute("role", "listbox");
  results.setAttribute("aria-label", t("quick-open.results.label"));

  panel.append(input, status, results);
  container.append(panel);

  let destroyed = false;
  /** The rows currently painted, and which one is highlighted. */
  let shown: QuickOpenItem[] = [];
  let active = 0;

  function paint(): void {
    const { shown: matches, total } = matchItems(deps.items(), input.value);
    shown = matches;
    active = 0;
    const frag = document.createDocumentFragment();
    for (const [index, item] of matches.entries()) {
      const row = document.createElement("div");
      row.id = `quick-open-row-${item.id}`;
      row.setAttribute("role", "option");
      row.dataset.itemId = item.id;
      row.dataset.itemType = item.type;
      row.setAttribute("aria-selected", index === 0 ? "true" : "false");
      row.textContent = item.title;
      frag.appendChild(row);
    }
    results.replaceChildren(frag);
    if (total === 0) {
      status.textContent = t("quick-open.none", { query: input.value.trim() });
    } else if (total > matches.length) {
      // The cap is SAID, never silent. A panel showing forty of nine hundred
      // without saying so is a panel that has quietly answered a different
      // question than the one asked.
      status.textContent = t("quick-open.truncated", {
        total: formatNumber(total),
        shown: matches.length,
      });
    } else {
      status.textContent = plural("quick-open.count", total, {
        count: formatNumber(total),
      });
    }
    markActive();
  }

  function markActive(): void {
    const rows = [...results.children];
    for (const [index, row] of rows.entries()) {
      if (!(row instanceof HTMLElement)) continue;
      row.setAttribute("aria-selected", index === active ? "true" : "false");
    }
    const current = rows[active];
    if (current instanceof HTMLElement) {
      // The field keeps focus; this is what tells a screen reader which row the
      // field's own arrow keys have landed on. Moving focus onto the rows would
      // mean Shift+Tab to correct a typo, and would put forty rows in the page's
      // tab order - the same rule the find panel's results follow.
      input.setAttribute("aria-activedescendant", current.id);
      // scrollIntoView rather than arithmetic: the list is a plain scrolling
      // block, not a virtual one, so the browser knows where the row is.
      current.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  function choose(item: QuickOpenItem | undefined): void {
    if (item === undefined) return;
    // Closed BEFORE the item is reached, not after. Opening a scene moves focus
    // into the editor, and a panel still up over the prose the writer just asked
    // for is the find panel's recorded mistake - it took a whole slice and a
    // screenshot to notice, because no gate could see it.
    setOpen(false);
    // THE SELECTION MOVES FIRST, for a scene as well as for a container.
    // Opening a scene marks it as the open row and leaves the KEYBOARD where it
    // was, and every selection-driven command reads that: Outline > Delete bins
    // the row the writer left, a create lands under it, Alt+Arrow reorders it.
    // So "go to chapter forty and delete this scene" deleted a scene the writer
    // could not see - silently, in their manuscript. The find panel has always
    // selected before opening; this panel did not, and the two were the same
    // operation. Measured by mreplace-cli, which binned the boot scene.
    deps.selectItem(item.id);
    // Only a scene holds a document. A part or a chapter is selected and no
    // more, which is the honest answer to "take me there" for a row that
    // cannot open.
    if (isOpenableType(item.type)) deps.openItem(item.id);
  }

  const onInputKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + shown.length) % shown.length;
      markActive();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      deps.onDismiss();
    }
  };

  const onInput = (): void => {
    paint();
  };

  const onResultsClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest("[data-item-id]");
    if (!(row instanceof HTMLElement)) return;
    const id = row.dataset.itemId;
    choose(shown.find((item) => item.id === id));
  };

  // ON THE DOCUMENT, for the same two reasons Ctrl+F is: the editor's keymap
  // only fires while the editor holds focus, and `navigator.handleKey` is driven
  // DIRECTLY by the synthetic measurement workload tens of thousands of times a
  // soak - a panel opened from in there would open tens of thousands of times
  // during a run whose numbers are then reported as the application's.
  const onDocumentKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "p" && event.key !== "P") return;
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.altKey) return;
    // WebKit prints on this chord. Without preventDefault the writer gets a
    // print dialog over the panel they asked for.
    event.preventDefault();
    openPanel();
  };

  function openPanel(): void {
    setOpen(true);
    // Cleared, unlike the find panel's query. Quick open is a jump, not a
    // search: the writer is going somewhere new, and the previous destination
    // is not a useful starting point. select() would leave the old text visible
    // and one keystroke from being restored, which is a different promise.
    input.value = "";
    paint();
    input.focus();
  }

  input.addEventListener("keydown", onInputKeyDown);
  input.addEventListener("input", onInput);
  results.addEventListener("click", onResultsClick);
  document.addEventListener("keydown", onDocumentKeyDown);
  const stopOutsideClick = closeOnOutsideClick(
    panel,
    () => !panel.hidden,
    () => setOpen(false),
  );

  return {
    open(): void {
      openPanel();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      input.removeEventListener("keydown", onInputKeyDown);
      input.removeEventListener("input", onInput);
      results.removeEventListener("click", onResultsClick);
      // THE TWO THAT MATTER. Both are on the document, so they outlive these
      // elements and would accumulate one live closure per project switch.
      document.removeEventListener("keydown", onDocumentKeyDown);
      stopOutsideClick();
      container.replaceChildren();
    },
  };
}
