// app/ui/src/find-bar.ts
// Search the open manuscript: a button in the project bar, a panel with a query
// field, and a list of every item the word occurs in, in the book's own order.
//
// A BUTTON AND A PANEL, NEVER AN INPUT IN THE BAR. The project bar's height is
// 39px and that number is a click-geometry constant restated in three rigs
// (switch-cli, outline-cli, export-cli), each pressing at
// `BAR_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2`. An input element in the
// strip changes the line box, shifts every navigator row underneath it, and all
// three rigs go on clicking coordinates they computed rather than rows a writer
// sees -- silently, as a plausible-looking result. The panel is positioned
// absolutely against the bar, exactly as #project-panel is, so it cannot affect
// layout below it at all.
//
// SEARCH IS "AS SAVED", so it drains first, for the same reason the export bar
// does: `project_find` reads the store on its own read-only connection, and
// anything still sitting in the flush debounce is not in the file. A writer who
// searches for the sentence they just typed and does not find it has been told
// the feature does not work. `drain()`, never `settled()`.
//
// A FAILURE IS A NOTICE, NEVER THE SAVE BANNER. `raiseFailure` latches, so one
// failed search would suppress the banner for every genuine autosave failure
// afterwards. Nothing is lost by a search that did not happen, so there is no
// latching banner on the dep surface at all rather than a convention not to
// call one.

/** One matched item, as the host serializes it. snake_case because these are
 *  plain serde field names: Tauri lower-camels command ARGUMENTS and leaves
 *  returned struct fields alone. */
import { isCompositionKey } from "./composition-key";
import { formatNumber, plural, t } from "./i18n";
import { createPanelShell } from "./panel-shell";

export interface FindHit {
  item_id: string;
  title: string;
  kind: string;
  snippet: string;
  matches: number;
  title_match: boolean;
  openable: boolean;
}

export interface FindResults {
  results: FindHit[];
  /** Items that matched BEFORE the cap. Always rendered when it exceeds the
   *  list, because a truncation nobody is told about reads as completeness. */
  total: number;
  truncated: boolean;
  scanned: number;
  skipped: number;
}

/** Restated from `find::DEFAULT_LIMIT` rather than shared, in the same spirit
 *  as the harness restating gate thresholds: these are two programs. The HOST
 *  clamps to its own ceiling and is authoritative, so a drift here can only ask
 *  for fewer results, never more. */
const FIND_LIMIT = 200;

export interface FindBarDeps {
  /** The bar element, already in index.html. Outside #project-controls, which
   *  the switcher clears wholesale. */
  container: HTMLElement;
  /** Drains the flush scheduler. What makes "as saved" equal what is on screen. */
  drain: () => Promise<void>;
  find: (query: string, limit: number) => Promise<FindResults>;
  /** Opens a scene. Goes through the page's existing activation path, so
   *  everything already true about opening stays true and is not restated. */
  /** `query` is what this panel searched for, handed over so the page can put
   *  the caret on it once the document has opened. The bar cannot do that
   *  itself: opening is asynchronous and the bar does not hold the promise. */
  openItem: (itemId: string, query: string) => void;
  /** Moves the navigator's selection to an item that cannot be opened -- a part
   *  or a chapter, which holds no document. */
  selectItem: (itemId: string) => void;
  /** Replace the selected occurrence in the OPEN SCENE and select the next.
   *  Returns whether text changed: false with a match now selected is the
   *  ordinary first press, false with nothing selected means the scene holds no
   *  occurrence. Optional because the corpus path has no scene to act on. */
  replaceMatch?: (query: string, replacement: string) => boolean;
  /** Replace every occurrence in the OPEN SCENE, in one undoable transaction.
   *  `spanning` counts matches LEFT ALONE because they cross a paragraph break -
   *  replacing one of those merges the two blocks. Optional for the same
   *  reason. */
  replaceAll?: (query: string, replacement: string) => { replaced: number; spanning: number };
  /** Rewrite the term across the WHOLE manuscript, in the host, having first
   *  taken a named snapshot of every document.
   *
   *  Absent on the corpus path, like the two above. Present, it is still behind
   *  a second confirming press: this operation was refused earlier because it had no
   *  inverse, and a writer who has just been shown a result count is not in a
   *  position to have decided beforehand. */
  replaceEverywhere?: (
    query: string,
    replacement: string,
  ) => Promise<{ replaced: number; spanning: number; documents: number; snapshot: { label: string } }>;
  /** Non-latching. A failed search must never suppress the autosave banner. */
  /** GOOD NEWS, and a different channel from onNotice deliberately. Both used
   *  to go through onNotice, which raised a red role="alert" bar that could not
   *  be dismissed - so a replace report was announced as an emergency and then
   *  sat across the top of the application for the rest of the session. A unit
   *  knows which of its own messages is which; the page should not have to guess
   *  from the wording. */
  onDone: (message: string) => void;
  onNotice: (message: string) => void;
  /** Where focus goes when the panel is dismissed. The toggle that used to sit
   *  in the bar was this unit's focus-return target; with the menu as the only
   *  route in, the unit no longer has one of its own and the page decides. */
  onDismiss: () => void;
}

export interface FindBar {
  /** Open the panel and put the caret in the query field, as Ctrl+F does. For
   *  the application menu's Find item, which advertises Ctrl+F rather than
   *  binding it: one binding, two callers. */
  open(): void;
  /** The same panel, with the caret in the REPLACE field.
   *
   *  A separate entry point rather than an argument to `open`, because the two
   *  menu items are two things to have asked for and the caret is what makes
   *  them different - the same reason the project panel takes a SwitcherFocus.
   *  A writer looking for replace looks in a menu; without this, replace is
   *  reachable only by knowing that Ctrl+F's panel has a second row. */
  openReplace(): void;
  /** The same panel, with the query field FILLED WITH `query` and the search
   *  already run -- for the bubble's Find in manuscript, which hands over the
   *  words the writer just selected.
   *
   *  A separate entry point per the `openReplace` precedent above, and for the
   *  same reason: the caret's row is one thing the two menu routes differ on,
   *  and this one differs on what the field HOLDS. Unlike `open()`, which
   *  leaves an old query in place for a writer resuming their own search, this
   *  one OVERWRITES it -- the writer just pointed at different words, and a
   *  stale query sitting under a new selection would search for the wrong
   *  thing without saying so. */
  openWith(query: string): void;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createFindBar(deps: FindBarDeps): FindBar {
  const { container } = deps;

  container.replaceChildren();

  const panel = document.createElement("div");
  panel.id = "find-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus, and aria-modal="true" would tell a screen reader
  // the rest of the page is inert when it is not.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "find-heading");
  panel.hidden = true;

  const input = document.createElement("input");
  input.id = "find-query";
  input.type = "text";
  input.setAttribute("aria-label", t("find.query.label"));
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "find-results");
  input.setAttribute("aria-autocomplete", "none");
  input.setAttribute("aria-expanded", "false");

  const queryLabel = document.createElement("label");
  queryLabel.htmlFor = input.id;
  queryLabel.textContent = t("find.query.label");

  const run = document.createElement("button");
  run.id = "find-run";
  run.type = "button";
  run.textContent = t("find.run");
  // What the panel is for. Everything else in it acts on what this produced.
  run.dataset.weight = "primary";

  // role="status" is correct here and is NOT the case the word count rejected.
  // That figure repaints on every keystroke, so a live region announced
  // constantly; this one changes once per deliberate search, which is exactly
  // what a polite live region is for. It is also the only channel that reports
  // the cap, so it must reach a screen reader rather than only the screen.
  const status = document.createElement("div");
  status.id = "find-status";
  status.setAttribute("role", "status");

  // REPLACE, AND ONLY IN THE OPEN SCENE. Both button labels say "in this
  // scene" through their accessible names, and the visible label on the second
  // says it too - a writer must not be able to read "Replace all" as "in the
  // manuscript". replace.ts records why the wider operation is not offered:
  // there is no history to undo it with yet.
  const replaceInput = document.createElement("input");
  replaceInput.id = "find-replace";
  replaceInput.type = "text";
  replaceInput.setAttribute("aria-label", t("find.replace.label"));

  const replaceLabel = document.createElement("label");
  replaceLabel.htmlFor = replaceInput.id;
  replaceLabel.textContent = t("find.replace.label");

  const replaceOne = document.createElement("button");
  replaceOne.id = "find-replace-one";
  replaceOne.type = "button";
  replaceOne.textContent = t("find.replace-one");
  replaceOne.dataset.weight = "quiet";
  replaceOne.setAttribute("aria-label", t("find.replace-one.label"));

  const replaceAll = document.createElement("button");
  replaceAll.id = "find-replace-all";
  replaceAll.type = "button";
  replaceAll.textContent = t("find.replace-all");
  replaceAll.dataset.weight = "quiet";
  replaceAll.setAttribute("aria-label", t("find.replace-all.label"));

  const results = document.createElement("div");
  results.id = "find-results";
  results.setAttribute("role", "listbox");
  results.setAttribute("aria-label", t("find.results.label"));

  // THE MANUSCRIPT-WIDE ONE, and its label says so in both channels. A writer
  // must never be able to read "All in scene" and "All in book" as the same
  // control, so the visible words differ as much as the accessible name does.
  const replaceBook = document.createElement("button");
  replaceBook.id = "find-replace-book";
  replaceBook.type = "button";
  replaceBook.textContent = t("find.replace-book");
  replaceBook.setAttribute(
    "aria-label",
    t("find.replace-book.label"),
  );
  // QUIET AT REST, like the two replace buttons beside it. The default tier's
  // box made the one irreversible option the most prominent of the three, which
  // reads as a recommendation. Its weight arrives with its confirmation.
  replaceBook.dataset.weight = "quiet";
  replaceBook.hidden = true;

  panel.append(queryLabel, input, run, replaceLabel, replaceInput, replaceOne, replaceAll, replaceBook, status, results);
  container.append(panel);

  let destroyed = false;
  // A search resolving after a newer one was issued, or after the panel closed,
  // must not repaint: the reader would see an older result set overwrite a
  // newer one, with a summary line describing neither.
  let generation = 0;
  /** What the last search's summary said, kept so a replace can restate it
   *  rather than destroy it. The summary is the ONLY channel that reports the
   *  200-result cap, and a truncated list reading as a complete one is exactly
   *  what that message exists to prevent. */
  let shownSummary = "";

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    input.setAttribute("aria-expanded", String(open && results.childElementCount > 0));
    // A confirmation that survives the panel closing is not a confirmation: the
    // next press on a reopened panel would rewrite the book having asked
    // nothing. `disarmBook` is declared below and only ever CALLED from here
    // after the panel has been built.
    if (!open) disarmBook();
  }

  function renderSummary(query: string, found: FindResults): void {
    if (found.total === 0) {
      status.textContent = t("find.summary.none", { query });
      return;
    }
    // formatNumber, consistent with #word-count: a writer in Berlin who chose
    // German sees 4.812, whatever the shell's locale. The rigs boot the
    // English page, which is what lets them parse these figures with [\d,]+.
    const total = formatNumber(found.total);
    if (found.truncated) {
      status.textContent = t("find.summary.truncated", {
        shown: formatNumber(found.results.length),
        total,
        query,
      });
      return;
    }
    status.textContent = plural("find.summary", found.total, { count: total, query });
  }

  function renderResults(found: FindResults): void {
    const frag = document.createDocumentFragment();
    for (const hit of found.results) {
      const row = document.createElement("div");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.dataset.itemId = hit.item_id;
      // A DOM id as well as the dataset entry, because AT-SPI exposes `id` and
      // not `data-*`. Without it a rig can only align probed rows by TITLE, and
      // 2,292 of the 20,000 stress items share one -- the same reason the
      // navigator's rows carry `nav-row-<walkIndex>`. Carries the item id
      // rather than an ordinal so alignment is exact rather than positional.
      row.id = `find-row-${hit.item_id}`;
      // Read back on activation rather than recomputed from the row's text: the
      // text is a display string and reconstructing a flag from it would break
      // on any title containing the separator.
      row.dataset.openable = String(hit.openable);

      const title = document.createElement("span");
      title.className = "find-title";
      title.textContent = hit.title;

      // A title-only hit has no prose to excerpt and the host sends an empty
      // snippet for it. Showing the item's TYPE in that slot says why the row
      // is there; repeating the title -- which is what the first version did --
      // renders the same string twice, one line under the other.
      const titleOnly = hit.snippet === "";
      const snippet = document.createElement("span");
      snippet.className = "find-snippet";
      snippet.textContent = titleOnly ? hit.kind : hit.snippet;

      // The whole row's accessible name, because WebKitGTK prunes untyped
      // generic containers -- the two spans above are exactly that, and the
      // count's slice already found #project-bar itself dropped. The name is
      // the channel certain to survive, so it carries what the screen shows
      // plus the type, which the layout conveys only by position.
      row.setAttribute(
        "aria-label",
        titleOnly
          ? t("find.result.label.title", { title: hit.title, kind: hit.kind })
          : t("find.result.label", { title: hit.title, kind: hit.kind, snippet: hit.snippet }),
      );

      row.append(title, snippet);
      frag.appendChild(row);
    }
    results.replaceChildren(frag);
    // A new list is a new set of rows, so the previous highlight names a row
    // that is gone - or, worse, a row at the same ordinal describing a
    // different scene. Enter then falls back to searching, which is what the
    // writer means by pressing it with nothing arrowed onto.
    highlighted = null;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", String(!panel.hidden && found.results.length > 0));
  }

  // What the rows on screen are about. Empty until a search has rendered.
  let shownQuery = "";

  async function search(): Promise<void> {
    const query = input.value.trim();
    const mine = ++generation;
    highlighted = null;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
    for (const row of results.querySelectorAll('[aria-selected="true"]')) {
      row.setAttribute("aria-selected", "false");
    }
    if (query === "") {
      // Not an error. Matching the empty string would return the whole book;
      // the host declines it too, and this avoids the round trip.
      status.textContent = "";
      results.replaceChildren();
      return;
    }
    status.textContent = t("find.searching");
    let found: FindResults;
    try {
      // Both awaits inside one try: a failed drain must not search. Results
      // computed after the save path failed describe a file that is missing the
      // writer's last edits, and nothing on screen would say so.
      await deps.drain();
      found = await deps.find(query, FIND_LIMIT);
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      status.textContent = t("find.failed");
      results.replaceChildren();
      deps.onNotice(t("find.error", { error: messageOf(error) }));
      return;
    }
    // A resolution landing after teardown would repaint the element the NEXT
    // project has already mounted into -- the defect the outline slice shipped
    // once, and the reason destroy() latches rather than only unbinding.
    if (destroyed || mine !== generation) return;
    // The query THESE results came from, latched here rather than read from the
    // field when a row is clicked. The writer can type on without pressing
    // Return, and the caret must land on the word the row they clicked is
    // actually about - the same rule as the outline bar's latched action.
    shownQuery = query;
    renderSummary(query, found);
    shownSummary = status.textContent ?? "";
    renderResults(found);
  }

  const onRun = (): void => {
    void search();
  };

  /** The LIVE query field, not `shownQuery`.
   *
   *  `shownQuery` is what the results list is about, and a row click has to use
   *  it so the caret lands on the word that row describes. Replace is the other
   *  way round: a button beside a box reading X must replace X, and a writer who
   *  edited the box without pressing Return would otherwise watch Replace act on
   *  the previous word with nothing on screen saying why. */
  const liveQuery = (): string => input.value.trim();

  /** Whether the panel can act, and what to say when it cannot.
   *
   *  Edit > Replace... puts the caret in the REPLACE field and leaves the query
   *  alone, which on a fresh window means empty - so the ordinary first use of
   *  that menu item was: type the replacement, press Replace, and watch nothing
   *  happen. Returning silently is what made that possible. */
  const refuseWithoutQuery = (query: string): boolean => {
    if (query.length > 0) return false;
    status.textContent = t("find.refuse.no-query");
    input.focus();
    return true;
  };

  const onReplaceOne = (): void => {
    const query = liveQuery();
    if (deps.replaceMatch === undefined) return;
    if (refuseWithoutQuery(query)) return;
    const changed = deps.replaceMatch(query, replaceInput.value);
    // Deliberately NOT re-running the search. The writer is stepping through
    // occurrences one press at a time, and re-listing on every press would move
    // the rows under them and pay a drain and a whole-manuscript scan per word.
    // APPENDED to what the status already said, never written over it. That
    // line is the ONLY channel reporting the 200-result cap, so replacing it
    // leaves a truncated list on screen with nothing saying it is truncated -
    // which is the failure the cap message exists to prevent.
    const said = changed ? t("find.replaced.single") : t("find.replaced.none");
    status.textContent =
      shownSummary === "" ? said : t("find.replaced.appended", { said, summary: shownSummary });
  };

  /** What a replace-all did, as one sentence.
   *
   *  `spanning` is never folded into the count and never left out: a writer told
   *  "replaced 5" who can still see a sixth highlighted has been misled, and the
   *  reason is not something they could work out. */
  const replaceReport = (replaced: number, spanning: number): string => {
    const head = plural("find.report.scene", replaced, { count: formatNumber(replaced) });
    if (spanning === 0) return head;
    const left = plural("find.spanning.left", spanning, { count: formatNumber(spanning) });
    const verb = plural("find.spanning.verb", spanning);
    return t("find.report.scene.spanning", { head, left, verb });
  };

  const onReplaceAll = (): void => {
    const query = liveQuery();
    if (deps.replaceAll === undefined) return;
    if (refuseWithoutQuery(query)) return;
    const { replaced, spanning } = deps.replaceAll(query, replaceInput.value);
    if (replaced === 0) {
      status.textContent =
        spanning === 0
          ? t("find.replaced.no-occurrences", { query })
          : replaceReport(0, spanning);
      return;
    }
    // NOT written to the status line. Re-searching is the right thing to do
    // here - the writer has taken one deliberate action and expects the list to
    // be about the manuscript as it is now - and `search()`'s first statement
    // sets the status to "Searching..." SYNCHRONOUSLY, in this same tick. A
    // count written above would never reach a paint. The notice is the only
    // channel that survives, so it is the only one used.
    deps.onDone(replaceReport(replaced, spanning));
    void search();
  };

  /** The snapshot label is repeated back, because it is the writer's handle on
   *  the way back and they did not choose it. */
  const bookReport = (
    replaced: number,
    spanning: number,
    documents: number,
    label: string,
  ): string => {
    const scenes = plural("find.report.documents", documents, {
      count: formatNumber(documents),
    });
    let out = plural("find.report.book", replaced, {
      count: formatNumber(replaced),
      documents: scenes,
    });
    if (spanning > 0) {
      const left = plural("find.spanning.left", spanning, { count: formatNumber(spanning) });
      const verb = plural("find.spanning.verb", spanning);
      out += t("find.report.book.spanning", { left, verb });
    }
    return t("find.report.book.saved", { report: out, label });
  };

  /** Has the whole-manuscript replace been ASKED for but not confirmed? One
   *  press is not enough for an operation whose blast radius is the book, and a
   *  latch is how the second press knows it is the second. Cleared whenever the
   *  panel closes, the query changes or the replacement changes - a confirmation
   *  that outlives what it was confirming is not a confirmation. */
  let bookArmed = false;

  const disarmBook = (): void => {
    if (!bookArmed) return;
    bookArmed = false;
    replaceBook.textContent = t("find.replace-book");
    replaceBook.removeAttribute("data-armed");
    // Back to quiet: at rest this is one of three replace buttons and must not
    // shout, and a danger tint outliving the confirmation it belonged to is a
    // warning about nothing.
    replaceBook.dataset.weight = "quiet";
  };

  const onReplaceBook = (): void => {
    const query = liveQuery();
    if (deps.replaceEverywhere === undefined) return;
    if (refuseWithoutQuery(query)) return;
    if (!bookArmed) {
      bookArmed = true;
      replaceBook.textContent = t("find.replace-book.armed");
      replaceBook.setAttribute("data-armed", "true");
      // ARMED ONLY. This is the one chrome action with no inverse short of the
      // history, and the press that follows is the one that cannot be taken
      // back - so it stops looking like Search at exactly that moment.
      replaceBook.dataset.weight = "danger";
      return;
    }
    disarmBook();
    // Said BEFORE the await, and it is not decoration: the host holds the store
    // mutex across a snapshot of every document and a rewrite of every match,
    // which at a long manuscript is seconds during which nothing else can be
    // saved. A panel that looked idle through that would read as broken.
    status.textContent = t("find.replacing");
    void deps
      .replaceEverywhere(query, replaceInput.value)
      .then((out) => {
        if (destroyed) return;
        deps.onDone(bookReport(out.replaced, out.spanning, out.documents, out.snapshot.label));
        void search();
      })
      .catch((err: unknown) => {
        if (destroyed) return;
        status.textContent = shownSummary;
        deps.onNotice(t("find.error.replace-book", { error: String(err) }));
      });
  };

  const onInputKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    // Arrow keys walk the results while focus STAYS in the query field. Moving
    // focus onto the rows instead would mean the writer has to Shift+Tab back
    // to correct a typo, and the rows would need tabIndex - which puts 200 of
    // them in the page's tab order.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    // Enter means "open the row I am on" once the writer has arrowed onto one,
    // and "search" before that. Unambiguous because arrowing is the only way to
    // highlight from the keyboard, and a new search clears the highlight.
    const rows = rowElements();
    const row = rows.find((r) => r.dataset.itemId === highlighted);
    if (row !== undefined) {
      activate(row);
      return;
    }
    void search();
  };

  /** The row Enter would act on, or null. An ITEM ID, not an index: a row is
   *  identified by the item it names everywhere else in this unit, and an index
   *  would be one re-render away from naming a different scene. */
  let highlighted: string | null = null;

  function rowElements(): HTMLElement[] {
    return [...results.querySelectorAll<HTMLElement>("[data-item-id]")];
  }

  /** Move the highlight by `step`, or onto the first row when nothing is
   *  highlighted yet. Clamped rather than wrapping: a writer holding ArrowDown
   *  to reach the end of a 200-row list should stop there, not reappear at the
   *  top having lost their place. */
  function moveHighlight(step: number): void {
    const rows = rowElements();
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.dataset.itemId === highlighted);
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
    const row = rows[next];
    if (row === undefined) return;
    setHighlight(row);
    // The panel is scrollable and the list can be 200 rows long, so a highlight
    // the writer cannot see is a highlight they will press Enter on by mistake.
    row.scrollIntoView({ block: "nearest" });
  }

  function setHighlight(row: HTMLElement): void {
    for (const other of results.querySelectorAll('[aria-selected="true"]')) {
      other.setAttribute("aria-selected", "false");
    }
    row.setAttribute("aria-selected", "true");
    highlighted = row.dataset.itemId ?? null;
    // Focus stays in the query field - the writer is still typing - so the
    // focused combobox owns the current option in its controlled listbox.
    input.setAttribute("aria-activedescendant", row.id);
  }

  /** Open or select the row for `itemId`. The one path a click and Enter share:
   *  two copies of this is how the mouse and the keyboard come to do different
   *  things. */
  function activate(row: HTMLElement): void {
    const itemId = row.dataset.itemId;
    if (itemId === undefined) return;
    setHighlight(row);
    if (row.dataset.openable === "true") {
      // AMENDS the find slice's "the panel stays open" decision, which was made
      // when activating a result took the writer to the top of a scene and
      // there was nothing under the panel worth seeing.
      //
      // The panel is 520 px wide, anchored to the right of a 900 px window with
      // a 280 px navigator, and its results run to 50vh - so it covers most of
      // the prose column. Now that activating a result puts the caret ON the
      // word, leaving the panel up hides the thing the writer just asked to be
      // shown. A screenshot found that; no gate could.
      //
      // The original reason for staying open still holds and is still served:
      // setOpen only toggles `hidden`, so the query and the rendered results
      // survive. Ctrl+F brings the same list straight back, with the highlight
      // where it was, and the next result is ArrowDown + Return away. Working
      // through several results does not mean searching again.
      setOpen(false);
      deps.openItem(itemId, shownQuery);
    } else {
      // STAYS OPEN here, deliberately. Nothing opened and the editor did not
      // move, so there is nothing behind the panel to look at - and closing it
      // would read as though something had happened.
      // A part or a chapter holds no document, so there is nothing to open.
      // Hiding it from the results would be worse -- the writer's chapter title
      // genuinely matched -- so it selects its navigator row instead.
      deps.selectItem(itemId);
    }
  }

  const onResultsClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest("[data-item-id]");
    if (!(row instanceof HTMLElement)) return;
    activate(row);
  };


  // ON THE DOCUMENT, and deliberately not in the ProseMirror keymap or the
  // navigator's handleKey.
  //
  // The keymap only fires while the editor holds focus, and a writer whose
  // focus is in the navigator still expects Ctrl+F. `navigator.handleKey` is
  // worse: the synthetic measurement workload calls it DIRECTLY for tens of
  // thousands of actions in a soak, so a panel opened from inside it would be
  // opened tens of thousands of times during a run whose numbers are then
  // reported as the application's. Structural mutation was kept out of
  // handleKey for exactly this reason.
  const onDocumentKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "f" && event.key !== "F") return;
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.altKey) return;
    // WebKit has its own find affordance on this chord; without this the page's
    // panel and the engine's would both open.
    event.preventDefault();
    setOpen(true);
    input.focus();
    input.select();
  };

  // Close, Escape and a click elsewhere (the shell's). The panel COVERS the
  // prose column, so a click into the manuscript must put it away. Close and
  // Escape hand focus back where the retired toggle used to: a panel closing
  // into nowhere leaves the writer's next keystroke on <body>.
  const shell = createPanelShell({
    panel,
    title: t("find.title"),
    titleId: "find-heading",
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
  });

  run.addEventListener("click", onRun);
  replaceOne.addEventListener("click", onReplaceOne);
  replaceAll.addEventListener("click", onReplaceAll);
  replaceBook.addEventListener("click", onReplaceBook);
  replaceBook.hidden = deps.replaceEverywhere === undefined;
  // Any change to what would be replaced, or to what it would become, retires a
  // confirmation that was about something else.
  input.addEventListener("input", disarmBook);
  replaceInput.addEventListener("input", disarmBook);
  input.addEventListener("keydown", onInputKeyDown);
  results.addEventListener("click", onResultsClick);
  document.addEventListener("keydown", onDocumentKeyDown);

  return {
    open(): void {
      // The same three lines the Ctrl+F handler runs, deliberately NOT factored
      // into a shared helper with it: that handler also has a preventDefault to
      // do, and a helper covering both would have to take a flag saying which
      // caller it was serving.
      setOpen(true);
      input.focus();
      input.select();
    },
    openReplace(): void {
      setOpen(true);
      // The replace field, and the query field is left ALONE - not cleared and
      // not selected. A writer who searched for a word and then reached for
      // Replace still wants that word; wiping it would make the menu item a
      // slower way of starting over.
      replaceInput.focus();
      replaceInput.select();
    },
    openWith(query: string): void {
      // OVERWRITES the field, unlike open(): the writer just pointed at these
      // words, so the field must show them rather than whatever was last
      // typed here.
      input.value = query;
      setOpen(true);
      onRun();
      input.focus();
      input.select();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // A pending search must not repaint a detached list.
      generation++;
      shell.destroy();
      run.removeEventListener("click", onRun);
      replaceOne.removeEventListener("click", onReplaceOne);
      replaceAll.removeEventListener("click", onReplaceAll);
  replaceBook.removeEventListener("click", onReplaceBook);
  input.removeEventListener("input", disarmBook);
  replaceInput.removeEventListener("input", disarmBook);
      input.removeEventListener("keydown", onInputKeyDown);
      results.removeEventListener("click", onResultsClick);
      // THE ONE THAT MATTERS. Every other listener dies with the elements this
      // unit owns; this one is on the document and outlives them. A leaked copy
      // would answer Ctrl+F after a project switch by focusing an input that is
      // no longer in the page, and would accumulate one handler per switch.
      document.removeEventListener("keydown", onDocumentKeyDown);
      container.replaceChildren();
    },
  };
}
