// app/ui/src/library.ts
// The library screen: the pen-name strip, the desk, the shelf,
// and the generated cover -- what the window shows before a book is open, and
// what File > Library… reopens over one that already is.
//
// #library IS NOT A PANEL. It carries `role="region"`, never
// `closeOnOutsideClick`, and Escape closes it only when a book is open behind
// it -- with nothing open there is nowhere to return to but the empty
// workspace, which is what `blank` is for, and the Close control is `hidden`
// in that state (and starts hidden at construction, so it cannot flash
// visible before the first overview answers and `paint()` runs).
//
// THE SHELF IS NOT A VIRTUAL LIST. At most 40 books are shown at all
// (`SHOWN_BOUND` on the host side) and covers are read for the first 12 of
// them; a shelf of covers at 120x180 is 40 images, not 15,200 rows, so
// nothing here needs the navigator's windowing.
//
// WORD TOTALS ARRIVE LATE, ON PURPOSE. `library_overview` never scans a body;
// once the shelf is painted, this module asks for one book's total at a time,
// most recent first, through `bookWords`, and paints each answer in as it
// comes. A GENERATION COUNTER -- the cast panel's own picture-read shape --
// is what lets a screen that has since closed, or been re-filtered, ignore an
// answer that is no longer about what is on screen.
//
// `#library-timing` IS A MEASURING INSTRUMENT, not decoration: `home-cli`
// reads it by name (`export-cli`'s own PY_PROBE shape, a status node whose
// text a rig parses for a figure) to grade `library_overview_ms` and
// `library_words_ms` against the HOST's own `took_ms`, not a wall-clock
// guess taken from outside the process. It shows the overview's own timing
// once `refresh()` answers, and the SLOWEST word count seen so far -- never
// an average, because the bound is about the worst book on screen.
//
// `comments.when.*` and `history.when.*` are NOT a shared helper today (each
// panel restates its own `formatWhen`), so `library.when.*` is a THIRD
// restatement in the same shape rather than a refactor of the other two --
// reported as a follow-up rather than done here.
import type { LibraryCreateResult } from "./library-book-actions";
import { isCompositionKey } from "./composition-key";
import { closeOnOutsideClick } from "./dismiss-outside";
import { createMenuPanel } from "./menu-panel";
import { zoomActionFor } from "./zoom";
import { isQuitChord } from "./quit";
import { createHelpTip } from "./help-tip";
import { formatDate, formatNumber, formatShortDateTime, plural, t } from "./i18n";
import type { PictureView } from "./cast-panel";
import { createPenNameForm, type PenNameFields } from "./pen-name-form";
import {
  duplicateCopies, groupsOf, inScope, selectSummary,
  type BookStats, type GroupEdit, type LibraryGroup, type LibraryMembership,
  type MembershipEdit, type MembershipView, type SourceTotals,
} from "./library-summary";

export interface LibraryIdentity {
  id: string;
  name: string;
  sort_name: string;
  bio: string;
}

export interface LibraryBook {
  path: string;
  name: string;
  modified_at: number;
  opened_at: number | null;
  identity_id: string | null;
  identity_name: string | null;
  book_id: string | null;
  series: LibraryGroup | null;
  universe: LibraryGroup | null;
  membership_error: string | null;
  cover: PictureView;
  error: string | null;
  missing: boolean;
}

export interface LibraryOverview {
  identities: LibraryIdentity[];
  selected_identity: string | null;
  vault_error: string | null;
  books: LibraryBook[];
  more: number;
  /** How long the host's own read took, wall-clock, around the whole
   *  answer -- painted into `#library-timing` and never derived here. */
  took_ms: number;
}

/** `library_book_words`'s answer: the total, and how long the host's own
 *  read-only open plus scan took. */
export interface LibraryWordsAnswer {
  words: number;
  took_ms: number;
}

export interface LibraryDeps {
  diagnostics?: boolean;
  overview(): Promise<LibraryOverview>;
  /** One book's saved total, gated by the host's own `may_open`. */
  bookWords(path: string): Promise<LibraryWordsAnswer>;
  bookStats(path: string, today: string): Promise<BookStats>;
  getMembership(): Promise<MembershipView>;
  saveMembership(generation: number, edit: MembershipEdit): Promise<LibraryMembership>;
  /** The project switch -- the same route the switcher's own rows take. */
  openBook(path: string, name?: string): Promise<boolean>;
  /** Creates and opens the book. A refused switch keeps the room open;
   *  failed attribution preserves its notice without announcing success. */
  createBook(name: string, identityId: string | null): Promise<LibraryCreateResult>;
  openBooks(focus: "import" | "restore"): void;
  openPreferences?(): void;
  openHelp?(): void;
  quit?(): void;
  forget(path: string): Promise<void>;
  /** `identity_save` with an empty id, public tier only. Resolves to the
   *  HOST's fresh identity list -- never just the new id -- so the caller can
   *  find the one it just added by an explicit diff against what it had
   *  before, rather than by assuming it landed last. */
  saveIdentity(fields: PenNameFields): Promise<LibraryIdentity[]>;
  persistHomeIdentity(id: string | null): Promise<void>;
  /** "" when nothing is open. */
  currentPath(): string;
  onNotice(message: string): void;
  onDone(message: string): void;
}

export interface Library {
  open(): void;
  close(): void;
  isOpen(): boolean;
  refresh(): Promise<void>;
  destroy(): void;
}

// ---------------------------------------------------------------------- pure

/** Remove every child, never through `innerHTML`. */
function clear(el: HTMLElement): void {
  while (el.firstChild !== null) el.removeChild(el.firstChild);
}

/** FNV-1a, 32-bit, over UTF-16 code units -- deliberately not a cryptographic
 *  hash, since the only property this needs is "the same path always picks
 *  the same tint" and "different paths spread across the six tokens". */
export function coverTint(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 6) + 1;
}

/** `opened_at` desc, a book never opened sorting after every one that has
 *  been; `modified_at` desc among books sharing that state. The host's own
 *  rule (`commands::library::overview`), restated here so the page can
 *  re-sort after a local change without a round trip. */
export function sortBooks(books: readonly LibraryBook[]): LibraryBook[] {
  return [...books].sort((a, b) => {
    if (a.opened_at !== null && b.opened_at !== null) return b.opened_at - a.opened_at;
    if (a.opened_at !== null) return -1;
    if (b.opened_at !== null) return 1;
    return b.modified_at - a.modified_at;
  });
}

/** `null` is All. */
export function filterBooks(books: readonly LibraryBook[], identityId: string | null, seriesId: string | null = null, universeId: string | null = null): LibraryBook[] {
  return books.filter((book) => inScope(book, { identity: identityId, series: seriesId, universe: universeId }));
}

/** The most recently opened (or, failing that, the most recently modified)
 *  available book of the filtered set is the desk; everything else is the shelf. */
export function deskAndShelf(books: readonly LibraryBook[]): { desk: LibraryBook | null; shelf: LibraryBook[] } {
  const sorted = sortBooks(books);
  const desk = sorted.find((book) => !book.missing && book.error === null) ?? null;
  return { desk, shelf: sorted.filter((book) => book !== desk) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative time under a week, the locale's own date beyond it --
 *  `history.ts`'s own `formatWhen`, restated rather than shared (see the
 *  module header). `atMs` and `nowMs` are both unix MILLISECONDS. */
function formatWhen(atMs: number, nowMs: number): string {
  const diff = nowMs - atMs;
  if (diff < 45 * 1000) return t("library.when.now");
  if (diff < 90 * MINUTE) return plural("library.when.minutes", Math.round(diff / MINUTE));
  if (diff < 22 * HOUR) return plural("library.when.hours", Math.round(diff / HOUR));
  if (diff < 6 * DAY) return plural("library.when.days", Math.round(diff / DAY));
  return formatDate(atMs);
}

/** `modified_at` is unix SECONDS (the file's mtime); `opened_at` is unix
 *  MILLISECONDS (`store::now_ms`). Both land in `formatWhen`, which wants one
 *  unit -- this is the one place that reconciles them. */
function lastOpenedText(book: LibraryBook, nowMs: number): string {
  if (book.opened_at !== null) return t("library.opened", { when: formatWhen(book.opened_at, nowMs) });
  if (book.modified_at > 0) return t("library.opened", { when: formatWhen(book.modified_at * 1000, nowMs) });
  return t("library.never-opened");
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Join non-empty parts with the catalog's own separator, so a middle dot
 *  between two data values is never a literal in this file -- the join
 *  itself carries no source string longer than one character. */
function metaJoin(parts: readonly string[]): string {
  return parts.filter((p) => p !== "").join(t("library.meta-separator"));
}

// ------------------------------------------------------------------- the DOM

export function createLibrary(deps: LibraryDeps): Library {
  const root = document.createElement("div");
  root.id = "library";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", t("library.title"));
  root.hidden = true;
  root.dataset.busy = "false";

  // The garret wordmark, decorative: the region's own label names the room,
  // and the stylesheet picks the ink or paper master for the active theme.
  const wordmark = document.createElement("div");
  wordmark.id = "library-wordmark";
  wordmark.setAttribute("aria-hidden", "true");

  const strip = document.createElement("div");
  strip.className = "library-strip";
  const stripLabel = document.createElement("span");
  stripLabel.id = "library-writing-as";
  stripLabel.className = "library-strip-label";
  stripLabel.textContent = t("library.writing-as");
  const pillRow = document.createElement("div");
  pillRow.className = "pill-row";
  pillRow.setAttribute("role", "group");
  pillRow.setAttribute("aria-labelledby", stripLabel.id);
  // The Close control lives at the right end of THIS row (the strip), not
  // floating after the shelf -- a screen with two books and a screen with
  // forty must put it in the same place. Starts hidden: `paint()` is what
  // decides whether a book is open behind the screen, and initialising this
  // any other way would let it flash visible before the first overview
  // answers.
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.id = "library-close";
  closeButton.className = "library-close";
  closeButton.textContent = t("library.close");
  closeButton.hidden = true;
  closeButton.addEventListener("click", () => close());
  const vaultError = document.createElement("p");
  vaultError.id = "library-vault-error";
  vaultError.hidden = true;
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.id = "library-menu";
  menuButton.dataset.weight = "quiet";
  menuButton.textContent = t("menu.button.label");
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-controls", "library-menu-panel");
  const menu = createMenuPanel({ id: "library-menu-panel", onClose: () => menuButton.setAttribute("aria-expanded", "false") });
  const menuAnchor = document.createElement("div");
  menuAnchor.id = "library-menu-anchor";
  menuAnchor.append(menuButton, menu.element);
  menuButton.addEventListener("click", () => {
    if (creatingBook || openingBook) return;
    if (menu.isOpen()) { menu.close(); return; }
    menu.paint([
      { id: "library-preferences", label: () => t("menu.preferences"), opensDialog: true, run: () => { close(); if (!isOpen) deps.openPreferences?.(); } },
      { id: "library-help", label: () => t("menu.help"), opensDialog: true, run: () => { close(); if (!isOpen) deps.openHelp?.(); } },
      { id: "library-quit", label: () => t("menu.quit"), run: () => { close(); if (!isOpen) deps.quit?.(); } },
    ], t("menu.button.label"));
    menuButton.setAttribute("aria-expanded", "true");
    menu.focusItem(0);
  });
  const removeOutsideMenu = closeOnOutsideClick(menuAnchor, menu.isOpen, menu.close);
  strip.append(stripLabel, pillRow, menuAnchor, closeButton, vaultError);

  const formAnchor = document.createElement("div");
  formAnchor.id = "library-pen-name-form-anchor";
  strip.append(formAnchor);

  const groupFilters = document.createElement("div");
  groupFilters.id = "library-group-filters";
  const seriesFilter = document.createElement("select");
  seriesFilter.id = "library-series-filter";
  seriesFilter.setAttribute("aria-label", t("library.series.filter"));
  const universeFilter = document.createElement("select");
  universeFilter.id = "library-universe-filter";
  universeFilter.setAttribute("aria-label", t("library.universe.filter"));
  const membershipButton = document.createElement("button");
  membershipButton.type = "button";
  membershipButton.id = "library-membership-open";
  membershipButton.textContent = t("library.membership.open");
  const membershipPanel = document.createElement("section");
  membershipPanel.id = "library-membership";
  membershipPanel.hidden = true;
  const summaryButton = document.createElement("button");
  summaryButton.type = "button";
  summaryButton.id = "library-summary-toggle";
  summaryButton.textContent = t("library.summary.open");
  summaryButton.setAttribute("aria-expanded", "false");
  groupFilters.append(seriesFilter, universeFilter, membershipButton, summaryButton);

  const summaryPanel = document.createElement("section");
  summaryPanel.id = "library-summary";
  summaryPanel.setAttribute("aria-label", t("library.summary.title"));
  summaryPanel.hidden = true;

  const heading = document.createElement("h2");
  heading.id = "library-heading";
  const busyStatus = document.createElement("p");
  busyStatus.id = "library-busy-status";
  busyStatus.setAttribute("role", "status");
  busyStatus.setAttribute("aria-live", "polite");
  busyStatus.setAttribute("aria-atomic", "true");
  const headingRow = document.createElement("div");
  headingRow.id = "library-heading-row";
  headingRow.append(heading, busyStatus);
  const bioLine = document.createElement("p");
  bioLine.id = "library-heading-bio";

  const newBookArea = document.createElement("div");
  newBookArea.id = "library-new-book-area";

  const existingBooks = document.createElement("div");
  existingBooks.id = "library-existing-books";
  for (const [focus, key] of [["import", "library.import"], ["restore", "library.restore"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = focus === "restore" ? "library-copies" : `library-${focus}`;
    button.textContent = t(key);
    button.addEventListener("click", () => {
      close();
      if (!isOpen) deps.openBooks(focus);
    });
    existingBooks.append(button);
  }

  const desk = document.createElement("div");
  desk.id = "library-desk";
  desk.className = "desk";

  const shelfHeading = document.createElement("h3");
  shelfHeading.textContent = t("library.shelf");
  // Above the shelf, so the empty state reads as "here is the action" (the
  // New book tile) rather than a sentence trailing after a grid that already
  // held one tile -- found on the first capture, where "No books yet." sat
  // AFTER the tile it was explaining.
  const empty = document.createElement("p");
  empty.id = "library-empty";
  empty.textContent = t("library.empty");
  empty.hidden = true;
  const shelf = document.createElement("div");
  shelf.id = "library-shelf";
  shelf.className = "shelf";

  const more = document.createElement("p");
  more.id = "library-more";
  more.hidden = true;

  // Expose the instrument to native probes only with explicit diagnostics.
  // Its host-measured values remain available in the DOM in every mode.
  const timing = document.createElement("p");
  timing.id = "library-timing";
  timing.className = "library-timing";
  timing.setAttribute("aria-hidden", deps.diagnostics === true ? "false" : "true");

  root.append(wordmark, strip, groupFilters, membershipPanel, headingRow, bioLine, newBookArea, existingBooks, desk, shelfHeading, empty, shelf, more, summaryPanel, timing);
  document.body.append(root);

  const penNameForm = createPenNameForm({
    container: formAnchor,
    save: async (fields) => {
      // THE EXPLICIT DIFF, not "the last element of the answer": the id this
      // save minted is whichever one is in the fresh list and was not in the
      // list this screen already held.
      const before = new Set(latest.identities.map((i) => i.id));
      const identities = await deps.saveIdentity(fields);
      latest = { ...latest, identities };
      const created = identities.find((i) => !before.has(i.id));
      if (created === undefined) {
        throw new Error("the vault reported no new pen name after saving one");
      }
      deps.onDone(t("identity.done.saved", { name: created.name }));
      return created.id;
    },
    onNotice: (message) => deps.onNotice(message),
    onCreated: (id) => {
      penNameForm.close();
      void selectIdentity(id);
    },
    onCancel: () => penNameForm.close(),
  });

  let isOpen = false;
  let generation = 0;
  let latest: LibraryOverview = {
    identities: [],
    selected_identity: null,
    vault_error: null,
    books: [],
    more: 0,
    took_ms: 0,
  };
  let creatingBook = false;
  let openingBook = false;
  const busyControls = new Map<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, boolean>();
  function paintBusy(): void {
    const busy = openingBook || creatingBook;
    root.dataset.busy = String(busy);
    for (const content of [strip, groupFilters, membershipPanel, newBookArea, existingBooks, desk, shelf, summaryPanel]) {
      content.setAttribute("aria-busy", String(busy));
    }
    busyStatus.textContent = openingBook ? t("library.busy.opening") : creatingBook ? t("library.busy.creating") : "";
    if (busy) {
      menu.close();
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button, input, select, textarea")) {
        if (!busyControls.has(control)) busyControls.set(control, control.disabled);
        control.disabled = true;
      }
    } else {
      for (const [control, disabled] of busyControls) control.disabled = disabled;
      busyControls.clear();
    }
  }
  let previousFocus: HTMLElement | null = null;
  const isolated = new Map<HTMLElement, boolean>();
  const isolateWorkspace = (): void => {
    for (const child of document.body.children) {
      if (!(child instanceof HTMLElement) || child === root || ["SCRIPT", "STYLE"].includes(child.tagName) ||
          child.matches("#book-copy-prompt, #close-prompt-panel, [role=alert], [role=status]")) continue;
      if (!isolated.has(child)) isolated.set(child, child.inert);
      child.inert = true;
    }
  };
  const observer = new MutationObserver(() => { if (isOpen) isolateWorkspace(); });
  const releaseWorkspace = (): void => {
    observer.disconnect();
    for (const [element, inert] of isolated) element.inert = inert;
    isolated.clear();
  };
  // The slowest `bookWords` answer seen since the last `refresh()` -- never
  // an average, because the bound this measures is about the worst book on
  // screen, not the typical one.
  let slowestWordsMs: number | null = null;
  // Whether `latest.took_ms` is a real answer yet, rather than the zero the
  // module starts on -- a boot at 0 ms and a boot with no answer yet must not
  // read the same in `#library-timing`.
  let hasOverviewAnswer = false;
  let selectedSeries: string | null = null;
  let selectedUniverse: string | null = null;
  let summaryOpen = false;
  let editorOpen = false;
  let editorDirty = false;
  let editingPath = "";
  let membershipGeneration = 0;
  let summaryGeneration = 0;
  const representatives = new Map<string, string>();

  function onKeydown(event: KeyboardEvent): void {
    // Keep workspace shortcuts from acting behind the room. Privacy remains global.
    const privacyChord = event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey &&
      ["l", "p"].includes(event.key.toLowerCase());
    if (!privacyChord && zoomActionFor(event) === null && !isQuitChord(event)) event.stopPropagation();
    if (isCompositionKey(event)) return;
    if (menu.isOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        menu.close();
        menuButton.focus();
        return;
      }
      if (menu.handleArrowKey(event)) return;
      if (event.key === "Tab" || (event.key === "Unidentified" && event.code === "Tab")) {
        menu.close();
        menuButton.focus();
      }
    }
    // WebKitGTK can report reverse Tab by its physical code alone.
    if (event.key === "Tab" || (event.key === "Unidentified" && event.code === "Tab")) {
      const controls = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")]
        .filter((element) => !element.closest("[hidden], [inert]") && !element.matches(":disabled") && element.tabIndex >= 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
      } else if ((!event.shiftKey && document.activeElement === last) ||
          (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (editorOpen) {
      event.preventDefault();
      event.stopPropagation();
      requestEditorClose();
      return;
    }
    if (deps.currentPath() !== "") close();
  }

  function open(): void {
    if (isOpen) return;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    isOpen = true;
    root.hidden = false;
    isolateWorkspace();
    observer.observe(document.body, { childList: true });
    root.addEventListener("keydown", onKeydown);
    root.tabIndex = -1;
    root.focus();
    void refresh();
  }

  function close(toEditor = false): void {
    if (!isOpen || creatingBook || openingBook) return;
    if (editorOpen && editorDirty) { showDiscard(); return; }
    const restoreFocus = !toEditor || document.activeElement === root;
    finishEditorClose(false);
    menu.close();
    isOpen = false;
    root.hidden = true;
    penNameForm.close();
    root.removeEventListener("keydown", onKeydown);
    releaseWorkspace();
    const canFocus = (element: HTMLElement | null): element is HTMLElement => element !== null &&
      element !== document.body && element !== document.documentElement && element.isConnected &&
      !element.closest("[hidden], [inert], #library") && !element.matches(":disabled") &&
      element.matches("[contenteditable=true], button, input, select, textarea, a[href], [tabindex]");
    const fallback = [...document.querySelectorAll<HTMLElement>(
      "#editor .ProseMirror, #editor [contenteditable=true]",
    )].find(canFocus) ?? [...document.querySelectorAll<HTMLElement>("#app-menu")].find(canFocus);
    const target = !toEditor && canFocus(previousFocus) ? previousFocus : fallback;
    // A prompt or the newly mounted project may already own focus.
    if (restoreFocus) target?.focus();
    previousFocus = null;
    // Cancels any word-count fetch still in flight: a later answer arriving
    // after close must not paint into a screen that is not there.
    generation += 1;
    summaryGeneration += 1;
  }

  function finishEditorClose(returnFocus = true): void {
    membershipGeneration++;
    editorOpen = false;
    editorDirty = false;
    membershipPanel.hidden = true;
    clear(membershipPanel);
    if (returnFocus) membershipButton.focus();
  }

  function showDiscard(): void {
    let prompt = membershipPanel.querySelector<HTMLElement>("#library-membership-discard");
    if (prompt !== null) { prompt.focus(); return; }
    prompt = document.createElement("div");
    prompt.id = "library-membership-discard";
    const text = document.createElement("p");
    text.textContent = t("library.membership.discard-question");
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = t("library.membership.discard");
    discard.addEventListener("click", () => finishEditorClose());
    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = t("library.membership.keep");
    keep.addEventListener("click", () => { prompt?.remove(); membershipPanel.querySelector<HTMLElement>("select")?.focus(); });
    prompt.append(text, discard, keep);
    membershipPanel.append(prompt);
    discard.focus();
  }

  function requestEditorClose(): void {
    if (editorDirty) showDiscard();
    else finishEditorClose();
  }

  function groupLabel(group: { id: string; labels: string[]; sameNameId: boolean }): string {
    const labels = group.labels.join(t("library.group-conflict-separator"));
    return group.sameNameId || group.labels.length > 1
      ? t("library.group-disambiguated", { name: labels, id: group.id.slice(0, 8) })
      : labels;
  }

  function paintGroupFilters(): void {
    const paintOne = (element: HTMLSelectElement, kind: "series" | "universe", selected: string | null) => {
      clear(element);
      const all = document.createElement("option");
      all.value = "";
      all.textContent = t(kind === "series" ? "library.series.all" : "library.universe.all");
      element.append(all);
      const groups = groupsOf(latest.books, kind);
      element.hidden = groups.length === 0;
      for (const group of groups) {
        const option = document.createElement("option");
        option.value = group.id;
        option.textContent = groupLabel(group);
        element.append(option);
      }
      element.value = selected ?? "";
    };
    paintOne(seriesFilter, "series", selectedSeries);
    paintOne(universeFilter, "universe", selectedUniverse);
    membershipButton.hidden = deps.currentPath() === "";
  }

  function groupEditor(kind: "series" | "universe", current: LibraryGroup | null): { root: HTMLElement; read: () => GroupEdit } {
    const row = document.createElement("div");
    row.className = "library-membership-row";
    const label = document.createElement("label");
    label.textContent = t(kind === "series" ? "library.series" : "library.universe");
    const choice = document.createElement("select");
    choice.setAttribute("aria-label", label.textContent);
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("library.membership.none");
    choice.append(none);
    const groups = groupsOf(latest.books, kind);
    if (current !== null && !groups.some((group) => group.id === current.id)) {
      groups.push({ id: current.id, labels: [current.name], sameNameId: false });
    }
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = groupLabel(group);
      choice.append(option);
    }
    const newOption = document.createElement("option");
    newOption.value = "__new__";
    newOption.textContent = t("library.membership.new");
    choice.append(newOption);
    choice.value = current?.id ?? "";
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 120;
    name.setAttribute("aria-label", t(kind === "series" ? "library.series.name" : "library.universe.name"));
    name.value = current?.name ?? "";
    name.hidden = current === null;
    choice.addEventListener("change", () => {
      name.hidden = choice.value === "";
      if (choice.value === "__new__") name.value = "";
      else name.value = groups.find((group) => group.id === choice.value)?.labels[0] ?? "";
      editorDirty = true;
      if (!name.hidden) name.focus();
    });
    name.addEventListener("input", () => { editorDirty = true; });
    label.append(choice);
    row.append(label, name);
    return {
      root: row,
      read: () => choice.value === "" ? { kind: "none" }
        : choice.value === "__new__" ? { kind: "new", name: name.value }
          : { kind: "existing", id: choice.value, name: name.value },
    };
  }

  async function openMembershipEditor(): Promise<void> {
    if (editorOpen) { requestEditorClose(); return; }
    const path = deps.currentPath();
    if (path === "") return;
    const token = ++membershipGeneration;
    const current = () => isOpen && token === membershipGeneration && deps.currentPath() === path;
    try {
      const view = await deps.getMembership();
      if (!current()) return;
      editingPath = path;
      editorOpen = true;
      editorDirty = false;
      clear(membershipPanel);
      membershipPanel.hidden = false;
      const title = document.createElement("h3");
      title.textContent = t("library.membership.title");
      const currentBook = latest.books.find((book) => book.path === path);
      const warning = document.createElement("p");
      warning.textContent = currentBook?.membership_error ?? t("library.membership.scope");
      const series = groupEditor("series", view.membership.series);
      const universe = groupEditor("universe", view.membership.universe);
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = t("library.membership.save");
      save.addEventListener("click", async () => {
        if (deps.currentPath() !== editingPath) { deps.onNotice(t("library.membership.changed")); return; }
        save.disabled = true;
        try {
          await deps.saveMembership(view.generation, { series: series.read(), universe: universe.read() });
          if (!current()) return;
          editorDirty = false;
          finishEditorClose();
          deps.onDone(t("library.membership.saved"));
          await refresh();
        } catch (error: unknown) {
          if (current()) deps.onNotice(messageOf(error));
        } finally { save.disabled = false; }
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = t("library.membership.cancel");
      cancel.addEventListener("click", requestEditorClose);
      membershipPanel.append(title, warning, series.root, universe.root, save, cancel);
      membershipPanel.querySelector<HTMLElement>("select")?.focus();
    } catch (error: unknown) { if (current()) deps.onNotice(messageOf(error)); }
  }

  function localDay(): string {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  }

  async function runSummary(): Promise<void> {
    const token = ++summaryGeneration;
    if (!isOpen || !summaryOpen) return;
    clear(summaryPanel);
    // What the summary counts is the heading's help, not a paragraph
    // above the figures.
    const heading = document.createElement("h3");
    heading.textContent = t("library.summary.title");
    heading.append(createHelpTip({ label: t("library.summary.title"), definition: t("library.summary.definition"), id: "library-summary-help" }).anchor);
    const selection = selectSummary(latest.books, {
      identity: latest.selected_identity, series: selectedSeries, universe: selectedUniverse,
    }, representatives);
    const duplicates = document.createElement("div");
    for (const copies of duplicateCopies(latest.books).values()) {
      const label = document.createElement("label");
      label.textContent = t("library.summary.duplicate", { id: copies[0].book_id?.slice(0, 8) ?? "" });
      const picker = document.createElement("select");
      picker.setAttribute("aria-label", label.textContent);
      const none = document.createElement("option");
      none.value = "";
      none.textContent = t("library.summary.exclude-copies");
      picker.append(none);
      for (const copy of copies) {
        const option = document.createElement("option");
        option.value = copy.path;
        option.textContent = t("library.summary.copy", {
          name: copy.name, path: copy.path,
          series: copy.series?.name ?? t("library.membership.none"),
          universe: copy.universe?.name ?? t("library.membership.none"),
        });
        picker.append(option);
      }
      picker.value = representatives.get(copies[0].book_id ?? "") ?? "";
      picker.addEventListener("change", () => {
        const id = copies[0].book_id;
        if (id === null) return;
        if (picker.value === "") representatives.delete(id);
        else representatives.set(id, picker.value);
        void runSummary();
      });
      label.append(picker);
      duplicates.append(label);
    }
    const result = document.createElement("p");
    result.id = "library-summary-result";
    const coverage = document.createElement("p");
    coverage.id = "library-summary-coverage";
    summaryPanel.append(heading, duplicates, result, coverage);
    const totals: SourceTotals = {
      typing: { added: 0, deleted: 0 }, pasted: { added: 0, deleted: 0 },
      imported: { added: 0, deleted: 0 }, restored: { added: 0, deleted: 0 },
      unattributed: { added: 0, deleted: 0 },
    };
    let words = 0;
    let documents = 0;
    let checked = 0;
    let failed = selection.failedUnknown;
    let availableActivity = 0;
    let interrupted = 0;
    let unreadable = 0;
    let latestReadAt = 0;
    const render = () => {
      result.textContent = t("library.summary.counts", {
        books: plural("library.summary.books", checked, { count: formatNumber(checked) }),
        documents: plural("library.summary.documents", documents, { count: formatNumber(documents) }),
        words: plural("library.summary.words", words, { count: formatNumber(words) }),
      });
      // Sources that moved, joined as a list, never a row of middle dots.
      const activity = (Object.keys(totals) as Array<keyof SourceTotals>)
        .filter((source) => totals[source].added !== 0 || totals[source].deleted !== 0)
        .map((source) => t(`library.summary.source.${source}`, {
          added: formatNumber(totals[source].added), deleted: formatNumber(totals[source].deleted),
        }));
      const activityLine = document.getElementById("library-summary-activity") ?? document.createElement("p");
      activityLine.id = "library-summary-activity";
      activityLine.textContent = availableActivity === 0
        ? t("library.summary.activity-unavailable")
        : t("library.summary.activity", { counted: formatNumber(availableActivity), total: formatNumber(checked),
          values: activity.length === 0 ? t("library.summary.activity-none") : activity.join(", ") });
      if (!activityLine.isConnected) summaryPanel.append(activityLine);
      // WHAT WAS LEFT OUT, one sentence per non-zero reason. The log
      // line this replaces printed nine counters, most of them zero.
      const left = ([
        ["library.summary.left.failed", failed],
        ["library.summary.left.missing", selection.missingUnknown],
        ["library.summary.left.copies", selection.duplicateUnresolved.length],
        ["library.summary.left.membership", selection.membershipUnknown],
        ["library.summary.left.unreadable", unreadable],
        ["library.summary.left.interrupted", interrupted],
        ["library.summary.left.omitted", latest.more],
      ] as const).filter(([, count]) => count > 0).map(([key, count]) => plural(key, count, { count: formatNumber(count) }));
      coverage.textContent = [...left, latestReadAt === 0 ? t("library.summary.not-read")
        : t("library.summary.read", { time: formatShortDateTime(latestReadAt) })].join(" ");
    };
    render();
    for (const book of selection.candidates) {
      if (token !== summaryGeneration) return;
      try {
        const stats = await deps.bookStats(book.path, localDay());
        if (token !== summaryGeneration) return;
        if (stats.identity_id !== book.identity_id || stats.book_id !== book.book_id || JSON.stringify(stats.membership.series) !== JSON.stringify(book.series)
          || JSON.stringify(stats.membership.universe) !== JSON.stringify(book.universe)) {
          failed++; // The overview's scope is stale; a refresh is needed.
          render();
          continue;
        }
        const nextWords = words + stats.words;
        const nextDocuments = documents + stats.documents;
        if (!Number.isSafeInteger(nextWords) || !Number.isSafeInteger(nextDocuments)) { failed++; render(); continue; }
        words = nextWords;
        documents = nextDocuments;
        checked++;
        unreadable += stats.unreadable_documents;
        latestReadAt = Math.max(latestReadAt, stats.read_at_ms);
        if (stats.activity !== null) {
          const sources = Object.keys(totals) as Array<keyof SourceTotals>;
          if (sources.every((source) =>
            Number.isSafeInteger(totals[source].added + stats.activity![source].added)
            && Number.isSafeInteger(totals[source].deleted + stats.activity![source].deleted))) {
            availableActivity++;
            if (stats.activity_interrupted) interrupted++;
            for (const source of sources) {
              totals[source].added += stats.activity[source].added;
              totals[source].deleted += stats.activity[source].deleted;
            }
          }
        }
      } catch { if (token !== summaryGeneration) return; failed++; }
      render();
    }
  }

  seriesFilter.addEventListener("change", () => { selectedSeries = seriesFilter.value || null; generation++; paint(); });
  universeFilter.addEventListener("change", () => { selectedUniverse = universeFilter.value || null; generation++; paint(); });
  membershipButton.addEventListener("click", () => void openMembershipEditor());
  summaryButton.addEventListener("click", () => {
    summaryOpen = !summaryOpen;
    summaryPanel.hidden = !summaryOpen;
    summaryButton.textContent = t(summaryOpen ? "library.summary.close" : "library.summary.open");
    summaryButton.setAttribute("aria-expanded", String(summaryOpen));
    if (summaryOpen) void runSummary(); else summaryGeneration++;
  });

  function renderCover(container: HTMLElement, book: LibraryBook): void {
    clear(container);
    const cover = document.createElement("div");
    cover.className = "cover";
    cover.setAttribute("aria-hidden", "true");
    if (book.cover.state === "present" && book.cover.data_uri !== null) {
      const img = document.createElement("img");
      img.src = book.cover.data_uri;
      img.alt = "";
      cover.append(img);
    } else {
      cover.classList.add("cover-generated");
      cover.dataset.tint = String(coverTint(book.path));
      const title = document.createElement("span");
      title.className = "cover-title";
      title.textContent = book.name;
      const byline = document.createElement("span");
      byline.className = "cover-byline";
      byline.textContent = book.identity_name ?? "";
      cover.append(title, byline);
    }
    container.append(cover);
  }

  function paintStrip(): void {
    clear(pillRow);
    const allPill = document.createElement("button");
    allPill.type = "button";
    allPill.className = "pill";
    allPill.setAttribute("aria-pressed", String(latest.selected_identity === null));
    allPill.textContent = t("library.all");
    allPill.addEventListener("click", () => void selectIdentity(null));
    pillRow.append(allPill);

    for (const identity of latest.identities) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "pill";
      pill.dataset.identityId = identity.id;
      pill.setAttribute("aria-pressed", String(latest.selected_identity === identity.id));
      pill.textContent = identity.name;
      pill.addEventListener("click", () => void selectIdentity(identity.id));
      pillRow.append(pill);
    }

    const newPenName = document.createElement("button");
    newPenName.type = "button";
    newPenName.id = "library-new-pen-name";
    newPenName.className = "pill";
    newPenName.textContent = t("library.new-pen-name");
    newPenName.addEventListener("click", () => (penNameForm.isOpen() ? penNameForm.close() : penNameForm.open()));
    pillRow.append(newPenName);

    if (latest.vault_error !== null) {
      vaultError.hidden = false;
      vaultError.textContent = t("library.vault-error", { error: latest.vault_error });
    } else {
      vaultError.hidden = true;
      vaultError.textContent = "";
    }

    const selected = latest.identities.find((i) => i.id === latest.selected_identity) ?? null;
    heading.textContent = selected?.name ?? t("library.yours");
    bioLine.textContent = selected?.bio ?? "";
  }

  function paintDesk(book: LibraryBook | null, nowMs: number): void {
    clear(desk);
    if (book === null) return;
    const coverBox = document.createElement("div");
    renderCover(coverBox, book);
    coverBox.firstElementChild?.classList.add("desk-cover");
    const info = document.createElement("div");
    info.className = "desk-info";
    const title = document.createElement("h3");
    title.id = "library-desk-title";
    title.textContent = book.name;
    const byline = document.createElement("p");
    byline.textContent =
      book.identity_name !== null ? t("library.by", { name: book.identity_name }) : t("library.no-pen-name");
    const meta = document.createElement("p");
    meta.dataset.path = book.path;
    meta.className = "desk-meta";
    meta.textContent = lastOpenedText(book, nowMs);
    const continueButton = document.createElement("button");
    continueButton.type = "button";
    continueButton.id = "library-continue";
    continueButton.textContent = t("library.continue");
    continueButton.addEventListener("click", () => void openBook(book.path, continueButton, book.name));
    info.append(title, byline, meta, continueButton);
    desk.append(coverBox, info);
  }

  function shelfLabel(book: LibraryBook, when: string, words = ""): string {
    return metaJoin([book.name, book.identity_name === null ? "" : t("library.by", { name: book.identity_name }), when, words]);
  }

  function paintShelf(books: readonly LibraryBook[], nowMs: number): void {
    clear(shelf);
    books.forEach((book, i) => {
      const unavailable = book.missing || book.error !== null;
      const tile = document.createElement(unavailable ? "div" : "button");
      if (tile instanceof HTMLButtonElement) tile.type = "button";
      tile.className = "shelf-tile";
      tile.dataset.path = book.path;
      tile.style.setProperty("--i", String(Math.min(i, 12)));
      const coverBox = document.createElement("div");
      renderCover(coverBox, book);
      const title = document.createElement("span");
      title.className = "shelf-title";
      title.textContent = book.name;
      // The pen name on its own line, so the meta line carries one middle
      // dot at most: "last opened just now · 2,000 words".
      const by = document.createElement("span");
      by.className = "shelf-by";
      by.textContent = book.identity_name ?? "";
      by.hidden = by.textContent === "";
      const meta = document.createElement("span");
      meta.className = "shelf-meta";
      meta.dataset.path = book.path;
      meta.textContent = lastOpenedText(book, nowMs);
      tile.append(coverBox, title, by, meta);
      if (book.missing || book.error !== null) {
        meta.removeAttribute("data-path");
        const errorLine = document.createElement("span");
        errorLine.className = "shelf-error";
        errorLine.textContent = book.error ?? book.path;
        tile.append(errorLine);
        if (book.missing) {
          const forget = document.createElement("button");
          forget.type = "button";
          forget.className = "shelf-forget";
          forget.dataset.forgetPath = book.path;
          forget.textContent = t("switcher.forget");
          forget.setAttribute("aria-label", t("switcher.forget.label", { name: book.name }));
          tile.append(forget);
        }
      } else {
        tile.setAttribute("aria-label", shelfLabel(book, lastOpenedText(book, nowMs)));
        tile.addEventListener("click", () => void openBook(book.path, tile, book.name));
      }
      shelf.append(tile);
    });

    const newBookTile = document.createElement("button");
    newBookTile.type = "button";
    newBookTile.id = "library-new-book-tile";
    newBookTile.classList.add("shelf-tile", "new-book");
    paintNewBookTile(newBookTile, false);
    newBookArea.replaceChildren(newBookTile);
  }

  function paintNewBookTile(tile: HTMLElement, editing: boolean): void {
    // A name field cannot live inside the button that opened it.
    if (editing === (tile instanceof HTMLButtonElement)) {
      const replacement = document.createElement(editing ? "div" : "button");
      if (replacement instanceof HTMLButtonElement) replacement.type = "button";
      replacement.id = tile.id;
      replacement.className = tile.className;
      tile.replaceWith(replacement);
      tile = replacement;
    }
    clear(tile);
    // "a dashed empty cover with a plus" -- a cover-SHAPED box carrying
    // the dashed treatment and the glyph, not the whole tile as one bordered
    // card. Every other tile is a cover plus text under it; this is that
    // same shape with the cover replaced by its own placeholder.
    const placeholder = document.createElement("div");
    placeholder.classList.add("cover", "cover-new");
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = "+";
    if (!editing) {
      const label = document.createElement("span");
      label.className = "shelf-title";
      label.textContent = t("library.new-book");
      tile.append(placeholder, label);
      tile.onclick = () => paintNewBookTile(tile, true);
      return;
    }
    tile.onclick = null;
    const field = document.createElement("div");
    field.className = "field-with-label";
    const label = document.createElement("label");
    label.htmlFor = "library-new-book-name";
    label.textContent = t("library.new-book.name");
    const input = document.createElement("input");
    input.type = "text";
    input.id = "library-new-book-name";
    input.setAttribute("aria-label", t("library.new-book.name"));
    input.classList.add("cover", "cover-new");
    input.addEventListener("keydown", (event) => {
      if (isCompositionKey(event)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void createBook(input.value.trim());
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (openingBook || creatingBook) return;
        paintNewBookTile(tile, false);
        document.getElementById("library-new-book-tile")?.focus();
      }
    });
    const create = document.createElement("button");
    create.type = "button";
    create.id = "library-new-book-create";
    create.textContent = t("library.new-book.create");
    create.addEventListener("click", () => void createBook(input.value.trim()));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.id = "library-new-book-cancel";
    cancel.textContent = t("library.new-book.cancel");
    cancel.addEventListener("click", () => {
      if (openingBook || creatingBook) return;
      paintNewBookTile(tile, false);
      document.getElementById("library-new-book-tile")?.focus();
    });
    field.append(label, input);
    tile.append(field, create, cancel);
    input.focus();
  }

  function paintTiming(): void {
    const parts: string[] = [];
    if (hasOverviewAnswer) parts.push(t("library.timing.overview", { ms: latest.took_ms }));
    if (slowestWordsMs !== null) parts.push(t("library.timing.words", { ms: slowestWordsMs }));
    const text = metaJoin(parts);
    timing.textContent = text;
    if (text !== "") timing.setAttribute("aria-label", text);
    else timing.removeAttribute("aria-label");
  }

  function paint(): void {
    const closeAllowed = deps.currentPath() !== "";
    closeButton.hidden = !closeAllowed;
    const isEmptyLibrary = latest.books.length === 0 && latest.more === 0;
    root.classList.toggle("library-is-empty", isEmptyLibrary);
    groupFilters.hidden = isEmptyLibrary;
    desk.hidden = isEmptyLibrary;
    shelfHeading.hidden = isEmptyLibrary;

    paintStrip();
    paintGroupFilters();
    const filtered = filterBooks(latest.books, latest.selected_identity, selectedSeries, selectedUniverse);
    const { desk: deskBook, shelf: shelfBooks } = deskAndShelf(filtered);
    const nowMs = Date.now();
    paintDesk(deskBook, nowMs);
    paintShelf(shelfBooks, nowMs);
    paintTiming();

    empty.hidden = filtered.length > 0;
    if (latest.more > 0) {
      more.hidden = false;
      more.textContent = plural("library.more", latest.more, {
        menu: [t("menu.file"), t("menu.project-open")].join(" › "),
      });
    } else {
      more.hidden = true;
    }

    const onScreen = [deskBook, ...shelfBooks].filter((b): b is LibraryBook => b !== null);
    void fetchWordCounts(generation, onScreen);
    if (summaryOpen) void runSummary();
    paintBusy();
  }

  async function fetchWordCounts(myGeneration: number, books: readonly LibraryBook[]): Promise<void> {
    let failed = false;
    for (const book of books) {
      if (myGeneration !== generation) return;
      if (book.missing || book.error !== null) continue;
      try {
        const answer = await deps.bookWords(book.path);
        if (myGeneration !== generation) return;
        paintWords(book.path, answer.words);
        slowestWordsMs = slowestWordsMs === null ? answer.took_ms : Math.max(slowestWordsMs, answer.took_ms);
        paintTiming();
      } catch {
        failed = true;
      }
    }
    if (failed && myGeneration === generation) deps.onNotice(t("library.error.words"));
  }

  function paintWords(path: string, words: number): void {
    const text = plural("library.words", words, { count: formatNumber(words) });
    for (const el of root.querySelectorAll<HTMLElement>("[data-path]")) {
      if (el.dataset.path !== path) continue;
      if (el.classList.contains("desk-meta") || el.classList.contains("shelf-meta")) {
        // A shelf tile is 120px wide, so its count takes a line of its own
        // rather than wrapping onto one that starts with a middle dot.
        el.textContent = el.classList.contains("shelf-meta")
          ? [el.textContent ?? "", text].filter((part) => part !== "").join("\n")
          : metaJoin([el.textContent ?? "", text]);
        if (el.classList.contains("shelf-meta")) {
          const book = latest.books.find((candidate) => candidate.path === path);
          const tile = el.closest("button.shelf-tile");
          if (book !== undefined && tile !== null) {
            tile.setAttribute("aria-label", shelfLabel(book, lastOpenedText(book, Date.now()), text));
          }
        }
        el.removeAttribute("data-path");
      }
    }
  }

  async function selectIdentity(id: string | null): Promise<void> {
    latest = { ...latest, selected_identity: id };
    generation += 1;
    slowestWordsMs = null;
    paint();
    try {
      await deps.persistHomeIdentity(id);
    } catch (error: unknown) {
      deps.onNotice(messageOf(error));
    }
  }

  function pendingFocus(): (expectedGeneration: number, target: () => HTMLElement | null) => void {
    root.focus();
    let moved = false;
    const onFocus = (): void => { moved = true; };
    document.addEventListener("focusin", onFocus, true);
    return (expectedGeneration, target) => {
      document.removeEventListener("focusin", onFocus, true);
      if (moved || generation !== expectedGeneration || !isOpen || document.activeElement !== root ||
          !root.isConnected || root.closest("[hidden], [inert]")) return;
      const control = target();
      if (control?.isConnected && !control.closest("[hidden], [inert]") && !control.matches(":disabled")) control.focus();
    };
  }

  async function openBook(path: string, control: HTMLElement, name: string): Promise<void> {
    if (openingBook || creatingBook) return;
    openingBook = true;
    paintBusy();
    const operationGeneration = generation;
    const restoreFocus = pendingFocus();
    let opened = false;
    try {
      opened = await deps.openBook(path, name);
    } catch (error: unknown) {
      deps.onNotice(messageOf(error));
    } finally {
      openingBook = false;
      paintBusy();
    }
    if (opened) close(true);
    restoreFocus(operationGeneration, () => control);
  }

  async function createBook(name: string): Promise<void> {
    if (creatingBook || openingBook || name === "") return;
    creatingBook = true;
    paintBusy();
    const operationGeneration = generation;
    const draft = root.querySelector<HTMLInputElement>("#library-new-book-name");
    const draftName = draft?.value ?? name;
    const restoreFocus = pendingFocus();
    let failed = false;
    let result: LibraryCreateResult = "unopened";
    try {
      result = await deps.createBook(name, latest.selected_identity);
    } catch (error: unknown) {
      failed = true;
      deps.onNotice(t("library.error.create", { name, error: messageOf(error) }));
    } finally {
      creatingBook = false;
      paintBusy();
    }
    if (result === "opened") deps.onDone(t("library.done.book-created", { name }));
    if (result !== "unopened") {
      close(true);
      restoreFocus(operationGeneration, () => null);
    } else {
      const canRefreshFocus = generation === operationGeneration;
      await refresh();
      restoreFocus(canRefreshFocus ? operationGeneration + 1 : operationGeneration, () => {
        const tile = root.querySelector<HTMLElement>("#library-new-book-tile");
        if (!failed || tile === null) return tile;
        if (!draft?.isConnected) paintNewBookTile(tile, true);
        const input = root.querySelector<HTMLInputElement>("#library-new-book-name");
        if (input) input.value = draftName;
        return input;
      });
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const forget = target.closest("[data-forget-path]");
    if (forget instanceof HTMLElement && forget.dataset.forgetPath !== undefined) {
      void deps.forget(forget.dataset.forgetPath).then(() => refresh()).catch((error: unknown) => {
        if (isOpen) deps.onNotice(messageOf(error));
      });
    }
  });

  async function refresh(): Promise<void> {
    generation += 1;
    summaryGeneration += 1;
    const myGeneration = generation;
    slowestWordsMs = null;
    try {
      const answer = await deps.overview();
      if (myGeneration !== generation) return;
      latest = answer;
      representatives.clear();
      if (!groupsOf(answer.books, "series").some((group) => group.id === selectedSeries)) selectedSeries = null;
      if (!groupsOf(answer.books, "universe").some((group) => group.id === selectedUniverse)) selectedUniverse = null;
      hasOverviewAnswer = true;
      paint();
    } catch (error: unknown) {
      if (myGeneration !== generation) return;
      deps.onNotice(t("library.error.overview", { error: messageOf(error) }));
    }
  }

  return {
    open,
    close,
    isOpen: () => isOpen,
    refresh,
    destroy(): void {
      isOpen = false;
      generation++;
      summaryGeneration++;
      membershipGeneration++;
      root.removeEventListener("keydown", onKeydown);
      removeOutsideMenu();
      menu.destroy();
      releaseWorkspace();
      penNameForm.destroy();
      root.remove();
    },
  };
}
