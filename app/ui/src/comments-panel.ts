// app/ui/src/comments-panel.ts
// The notes a writer left on this scene, and the way back to the passage each
// one is about.
//
// ONE PANEL, TWO ENTRANCES, exactly like Find and Replace: `Edit > Comments…`
// opens the list, `Edit > Add comment…` (and Ctrl+Alt+M) opens the same panel
// with the caret in the compose field and the selected passage already quoted
// above it. Two items for one surface, distinguished by where the caret lands.
//
// IT READS POSITIONS LIVE, never from the row the host handed it. The host's
// `anchor_from`/`anchor_to` are where the note was at the last FLUSH; the editor
// has been mapping them through every transaction since. Painting the stored
// pair would show a note a second's worth of typing out of date, and clicking it
// would take the writer to the wrong words - which is the whole failure this
// feature exists not to have.
import { formatNumber, plural, t } from "./i18n";
import { createIcon } from "./icons";
import { createPanelShell } from "./panel-shell";
import { type CommentAnchor, type CommentRow, isOrphaned } from "./comments";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a note was made, as a reader scans it.
 *
 *  Relative under a week and the locale's date beyond it, the same rule and for
 *  the same reason `formatWhen` in history.ts gives: a clock time is a property
 *  of the runtime's ICU data, so a test asserting one asserts a fact about the
 *  machine. Restated rather than imported because the two panels are free to
 *  diverge and neither should be able to change the other's wording by accident.
 */
export function formatWhen(createdAt: number, now: number): string {
  const diff = now - createdAt;
  if (diff < 45 * 1000) return t("comments.when.now");
  if (diff < 90 * MINUTE) return plural("comments.when.minutes", Math.round(diff / MINUTE));
  if (diff < 22 * HOUR) return plural("comments.when.hours", Math.round(diff / HOUR));
  if (diff < 6 * DAY) return plural("comments.when.days", Math.round(diff / DAY));
  return new Date(createdAt).toLocaleDateString();
}

/** What the panel says when the passage a note was on is gone.
 *
 *  SAID, not implied by an absence, and this is the sentence the whole design
 *  turns on. The alternative every naive implementation reaches for is to move
 *  the note to whatever prose is nearest - and then a writer reads a note about
 *  a paragraph they deleted as though it were about the paragraph that replaced
 *  it. Being told the subject is gone costs them a moment; being told the wrong
 *  subject costs them a revision made on a false reading. */
export const ORPHAN_NOTE = t("comments.orphan");

/** What it says when the ceiling stopped the mapping. See MAX_MAPPED_COMMENTS.
 *
 *  Names the consequence rather than the mechanism: a writer does not need to
 *  know what mapping is, they need to know that the marks in their prose are no
 *  longer following their edits. */
export const CAPPED_NOTE = t("comments.capped");

export const NO_SELECTION = t("comments.no-selection");

export const EMPTY_BODY = t("comments.empty-body");

/** The one sentence at the top of the list. Absent, all-resolved and
 *  some-resolved are three different answers and a reader acts differently on
 *  each - an empty list under a hidden toggle looks exactly like a panel that
 *  failed to paint. */
export function statusLabel(open: number, resolved: number, showResolved: boolean): string {
  if (open === 0 && resolved === 0) return t("comments.status.none");
  if (open === 0) {
    const settled = plural("comments.status.resolved", resolved, {
      count: formatNumber(resolved),
    });
    return showResolved
      ? t("comments.status.settled.shown", { settled })
      : t("comments.status.settled.hidden", { settled });
  }
  const live = plural("comments.status.open", open, { count: formatNumber(open) });
  if (resolved === 0) return t("comments.status.live", { live });
  return showResolved
    ? t("comments.status.live.shown", { live, resolved: formatNumber(resolved) })
    : t("comments.status.live.hidden", { live, resolved: formatNumber(resolved) });
}

/** What a screen reader is told about one row.
 *
 *  Built from the FIGURES and the state, never by reading the rendered row back
 *  out of the DOM - the recorded word-count rule, which is what stops the
 *  visible wording becoming load-bearing for what a screen reader hears. */
export function commentLabel(
  row: CommentRow,
  passage: string,
  orphaned: boolean,
  now: number,
): string {
  const when = formatWhen(row.created_at, now);
  const state = row.resolved ? t("comments.row.state.resolved") : t("comments.row.state.open");
  if (orphaned) return t("comments.row.label.orphaned", { state, when, body: row.body });
  return t("comments.row.label", { state, when, passage, body: row.body });
}

export interface CommentsDeps {
  readonly container: HTMLElement;
  /** Settle pending edits before anything reads or writes. A note created
   *  against an unflushed keystroke would be anchored to positions the store has
   *  not seen. */
  drain(): Promise<void>;
  activeDocId(): string;
  list(itemId: string): Promise<CommentRow[]>;
  create(
    itemId: string,
    body: string,
    from: number,
    to: number,
    quote: string,
  ): Promise<CommentRow>;
  setBody(id: number, body: string): Promise<void>;
  setResolved(id: number, resolved: boolean): Promise<void>;
  /** Where the editor currently holds this note, after every transaction since
   *  the last flush. Undefined when the editor has never been told about it. */
  anchorOf(id: number): CommentAnchor | undefined;
  /** The live text of a range. */
  quoteAt(from: number, to: number): string;
  /** What the writer has selected in the editor right now. */
  selectionRange(): { from: number; to: number };
  /** Select a passage in the editor and scroll it into view. */
  reveal(from: number, to: number): boolean;
  /** Whether the editor has stopped following this document's notes. */
  capped(): boolean;
  /** Re-read the notes into the editor, so the marks and the flush agree with
   *  what the store now holds. */
  syncEditor(rows: readonly CommentRow[]): void;
  onDone(message: string): void;
  onNotice(message: string): void;
  onDismiss(): void;
  now?(): number;
}

export interface CommentsPanel {
  /** `list` shows what is there; `compose` puts the caret in the note field with
   *  the selected passage quoted above it. */
  open(mode?: "list" | "compose"): Promise<void>;
  isOpen(): boolean;
  destroy(): void;
}

export function createCommentsPanel(deps: CommentsDeps): CommentsPanel {
  const { container } = deps;
  const now = deps.now ?? (() => Date.now());

  const panel = document.createElement("div");
  panel.id = "comments-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert, so claiming modal
  // would be a lie a screen reader acts on.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("comments.panel.label"));
  // So Escape is heard before anything inside is focused. The recorded failure
  // of the fifth panel is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;

  const status = document.createElement("div");
  status.id = "comments-status";
  status.setAttribute("role", "status");

  /** The ceiling's sentence, on its own line and only when it applies. An alert
   *  rather than a status: it says the marks in the writer's prose have stopped
   *  being maintained, which is a thing to act on rather than a figure to read.
   *  It is NOT the failure banner - editing is not paused and nothing is
   *  unsaved. */
  const capped = document.createElement("div");
  capped.id = "comments-capped";
  capped.setAttribute("role", "alert");
  capped.textContent = CAPPED_NOTE;
  capped.hidden = true;

  const list = document.createElement("div");
  list.id = "comments-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("comments.list.label"));

  const showResolved = document.createElement("button");
  showResolved.id = "comments-show-resolved";
  showResolved.type = "button";
  showResolved.setAttribute("aria-pressed", "false");
  showResolved.textContent = t("comments.show-resolved");
  // A filter over the list, not the panel's reason for existing.
  showResolved.dataset.weight = "quiet";

  /** What the note being composed is about, quoted, above the field. A writer
   *  who opened this panel, scrolled the list and came back has otherwise
   *  nothing telling them which passage the note they are typing will land on -
   *  the recorded diff-panel defect, found by capture. */
  const composeQuote = document.createElement("div");
  composeQuote.id = "comments-compose-quote";

  const composeField = document.createElement("textarea");
  composeField.id = "comments-compose";
  composeField.rows = 3;
  composeField.placeholder = t("comments.compose.placeholder");
  composeField.setAttribute("aria-label", t("comments.compose.label"));

  const composeAdd = document.createElement("button");
  composeAdd.id = "comments-add";
  composeAdd.type = "button";
  composeAdd.textContent = t("comments.compose.add");
  // The one thing this panel is FOR. Drawn like the per-row secondaries beside
  // it, it was the least findable control on the surface.
  composeAdd.dataset.weight = "primary";

  const composeCancel = document.createElement("button");
  composeCancel.id = "comments-cancel";
  composeCancel.type = "button";
  composeCancel.textContent = t("comments.compose.cancel");
  composeCancel.hidden = true;

  panel.append(
    status,
    capped,
    showResolved,
    list,
    composeQuote,
    composeField,
    composeAdd,
    composeCancel,
  );
  container.append(panel);

  let destroyed = false;
  /** A listing that resolves after a newer one, or after the panel closed, must
   *  not repaint: the reader would act on rows describing a scene that is no
   *  longer open. */
  let generation = 0;
  let rows: CommentRow[] = [];
  let resolvedVisible = false;
  /** The note being edited, or null while composing a new one. Reuses one field
   *  rather than growing an input into every row: the list is rebuilt on every
   *  refresh, and a field inside a row would be destroyed mid-edit with whatever
   *  was typed in it - the recorded reason rename is a bar field and not an
   *  inline one. */
  let editing: number | null = null;
  /** The range a new note will land on, captured when compose opened. Captured
   *  rather than read at press time because focus moves into the textarea and
   *  the writer may click a row in between; the quote above the field is the
   *  visible half of the same decision. */
  let composeRange: { from: number; to: number } | null = null;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  /** Where the editor holds this note NOW, falling back to what the store said.
   *
   *  The fallback is not cosmetic: a panel opened before the editor has been
   *  told about a note - the window between a create and its sync - would
   *  otherwise show every row as an orphan, which is the one thing this panel
   *  must never say wrongly. */
  function anchorFor(row: CommentRow): { from: number; to: number } {
    const live = deps.anchorOf(row.id);
    if (live !== undefined) return { from: live.from, to: live.to };
    return { from: row.anchor_from, to: row.anchor_to };
  }

  function renderRows(): void {
    const at = now();
    const shown = rows.filter((row) => resolvedVisible || !row.resolved);
    if (shown.length === 0) {
      // An empty listbox is indistinguishable from one that failed to paint -
      // the recorded `renderProjects` defect, which had shipped for six slices
      // and had been photographed.
      const empty = document.createElement("div");
      empty.id = "comments-empty";
      empty.textContent =
        rows.length === 0
          ? t("comments.empty.none")
          : t("comments.empty.all-resolved");
      list.replaceChildren(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of shown) {
      const anchor = anchorFor(row);
      const orphaned = isOrphaned(anchor);
      const passage = orphaned ? row.quote : deps.quoteAt(anchor.from, anchor.to);

      const el = document.createElement("div");
      el.className = "comment-row";
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", "false");
      el.dataset.commentId = String(row.id);
      if (orphaned) el.dataset.orphaned = "true";
      if (row.resolved) el.dataset.resolved = "true";
      el.setAttribute("aria-label", commentLabel(row, passage, orphaned, at));

      const quote = document.createElement("button");
      quote.type = "button";
      quote.className = "comment-quote";
      quote.dataset.commentId = String(row.id);
      // An orphan's quote is what the passage USED to say, so it is drawn as a
      // quotation and not as a link into prose that no longer holds it.
      quote.textContent = passage === "" ? t("comments.quote.empty") : passage;
      quote.disabled = orphaned;
      // aria-hidden: the row's own name already carries the passage, and a
      // screen reader reading the button would say it twice.
      quote.setAttribute("aria-hidden", "true");
      quote.tabIndex = -1;

      const body = document.createElement("div");
      body.className = "comment-body";
      body.textContent = row.body;

      const meta = document.createElement("div");
      meta.className = "comment-meta";
      meta.textContent = orphaned
        ? t("comments.meta.orphaned", { note: ORPHAN_NOTE, when: formatWhen(row.created_at, at) })
        : formatWhen(row.created_at, at);
      // The glyph is what marks an orphan in greyscale; the tint behind the
      // row is only its colour.
      if (orphaned) meta.prepend(createIcon("unlink"));

      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.className = "comment-resolve";
      resolve.dataset.weight = "quiet";
      resolve.dataset.commentId = String(row.id);
      resolve.textContent = row.resolved ? t("comments.row.reopen") : t("comments.row.resolve");
      resolve.setAttribute(
        "aria-label",
        row.resolved
          ? t("comments.row.reopen.label", { body: row.body })
          : t("comments.row.resolve.label", { body: row.body }),
      );

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "comment-edit";
      edit.dataset.weight = "quiet";
      edit.dataset.commentId = String(row.id);
      edit.textContent = t("comments.row.edit");
      edit.setAttribute("aria-label", t("comments.row.edit.label", { body: row.body }));

      el.append(quote, body, meta, resolve, edit);
      frag.append(el);
    }
    list.replaceChildren(frag);
  }

  function paintStatus(): void {
    const open = rows.filter((r) => !r.resolved).length;
    status.textContent = statusLabel(open, rows.length - open, resolvedVisible);
    capped.hidden = !deps.capped();
  }

  function paintCompose(): void {
    if (editing !== null) {
      const row = rows.find((r) => r.id === editing);
      composeQuote.textContent =
        row === undefined
          ? ""
          : t("comments.compose.editing", { when: formatWhen(row.created_at, now()) });
      composeAdd.textContent = t("comments.compose.save");
      composeCancel.hidden = false;
      return;
    }
    composeAdd.textContent = t("comments.compose.add");
    composeCancel.hidden = true;
    if (composeRange === null) {
      composeQuote.textContent = NO_SELECTION;
      return;
    }
    const text = deps.quoteAt(composeRange.from, composeRange.to);
    composeQuote.textContent = text === "" ? NO_SELECTION : t("comments.compose.on", { text });
  }

  async function refresh(): Promise<void> {
    const mine = ++generation;
    const itemId = deps.activeDocId();
    status.textContent = t("comments.reading");
    let listed: CommentRow[];
    try {
      listed = await deps.list(itemId);
    } catch (err) {
      if (destroyed || mine !== generation) return;
      status.textContent = "";
      deps.onNotice(t("comments.error.read", { error: String(err) }));
      return;
    }
    if (destroyed || mine !== generation) return;
    rows = listed;
    // The editor's marks come from the same read as the panel's rows, so the
    // two cannot describe different sets of notes.
    deps.syncEditor(rows);
    renderRows();
    paintStatus();
    paintCompose();
  }

  async function submit(): Promise<void> {
    const body = composeField.value.trim();
    if (body === "") {
      // The recorded states-and-messages finding: a bare `return` in a panel
      // whose first user has just been given a focused field.
      deps.onNotice(EMPTY_BODY);
      composeField.focus();
      return;
    }
    if (editing !== null) {
      const id = editing;
      try {
        await deps.setBody(id, body);
        if (destroyed) return;
        editing = null;
        composeField.value = "";
        await refresh();
        deps.onDone(t("comments.done.rewritten"));
      } catch (err) {
        if (destroyed) return;
        deps.onNotice(t("comments.error.rewrite", { error: String(err) }));
      }
      return;
    }
    const range = composeRange;
    if (range === null || range.from >= range.to) {
      deps.onNotice(NO_SELECTION);
      return;
    }
    const quote = deps.quoteAt(range.from, range.to);
    // DRAIN FIRST. The anchor is a pair of positions in the document the store
    // holds, and until the pending keystrokes are in it the two are different
    // documents.
    await deps.drain();
    if (destroyed) return;
    try {
      await deps.create(deps.activeDocId(), body, range.from, range.to, quote);
      if (destroyed) return;
      composeField.value = "";
      composeRange = null;
      await refresh();
      deps.onDone(t("comments.done.added"));
    } catch (err) {
      if (destroyed) return;
      deps.onNotice(t("comments.error.add", { error: String(err) }));
    }
  }

  async function toggleResolved(id: number): Promise<void> {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return;
    try {
      await deps.setResolved(id, !row.resolved);
      if (destroyed) return;
      // A note resolved while the resolved rows are hidden vanishes from the
      // list, so the status line is the only thing that can say what happened.
      await refresh();
      deps.onDone(
        row.resolved
          ? t("comments.done.reopened")
          : t("comments.done.resolved"),
      );
    } catch (err) {
      if (destroyed) return;
      deps.onNotice(t("comments.error.change", { error: String(err) }));
    }
  }

  function beginEdit(id: number): void {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return;
    editing = id;
    composeField.value = row.body;
    paintCompose();
    composeField.focus();
  }

  function cancelEdit(): void {
    editing = null;
    composeField.value = "";
    paintCompose();
  }

  function reveal(id: number): void {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return;
    const anchor = anchorFor(row);
    if (isOrphaned(anchor)) {
      // The button is disabled, so this is reachable only if the passage went
      // between the paint and the click. Saying so beats a silent return - the
      // recorded empty-query defect.
      deps.onNotice(ORPHAN_NOTE);
      return;
    }
    if (!deps.reveal(anchor.from, anchor.to)) {
      deps.onNotice(ORPHAN_NOTE);
      return;
    }
    // The panel is not closed. Unlike a restore, reading a note and looking at
    // the passage it is about is one act with two halves, and a writer working
    // down a list of notes would have to reopen the panel for every one.
  }

  function onListClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const resolve = target.closest(".comment-resolve");
    if (resolve instanceof HTMLElement) {
      const id = Number(resolve.dataset.commentId);
      if (Number.isFinite(id)) void toggleResolved(id);
      return;
    }
    const edit = target.closest(".comment-edit");
    if (edit instanceof HTMLElement) {
      const id = Number(edit.dataset.commentId);
      if (Number.isFinite(id)) beginEdit(id);
      return;
    }
    const quote = target.closest(".comment-quote");
    if (quote instanceof HTMLElement) {
      const id = Number(quote.dataset.commentId);
      if (Number.isFinite(id)) reveal(id);
    }
  }

  function onToggleResolvedVisible(): void {
    resolvedVisible = !resolvedVisible;
    showResolved.setAttribute("aria-pressed", String(resolvedVisible));
    showResolved.textContent = resolvedVisible
      ? t("comments.hide-resolved")
      : t("comments.show-resolved");
    renderRows();
    paintStatus();
  }

  list.addEventListener("click", onListClick);
  showResolved.addEventListener("click", onToggleResolvedVisible);
  composeAdd.addEventListener("click", () => void submit());
  composeCancel.addEventListener("click", cancelEdit);

  // Close, Escape and a click elsewhere (the shell's).
  const shell = createPanelShell({
    panel,
    title: t("comments.heading"),
    titleId: "comments-heading",
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
    inspector: true,
  });

  return {
    async open(mode: "list" | "compose" = "list"): Promise<void> {
      // BEFORE the panel is shown, and before focus moves: opening the panel is
      // what takes focus out of the editor, and a selection read afterwards is a
      // selection nobody made.
      if (mode === "compose") {
        editing = null;
        const range = deps.selectionRange();
        composeRange = range.from < range.to ? range : null;
      }
      setOpen(true);
      paintCompose();
      if (mode === "compose") composeField.focus();
      else panel.focus();
      await refresh();
      if (destroyed) return;
      if (mode === "compose" && composeRange === null) {
        // SAID, not a field that silently does nothing. The recorded defect is
        // exactly this shape: Edit > Replace… landed the caret in a field whose
        // handler returned on an empty query.
        deps.onNotice(NO_SELECTION);
      }
    },
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      destroyed = true;
      shell.destroy();
      list.removeEventListener("click", onListClick);
      showResolved.removeEventListener("click", onToggleResolvedVisible);
      panel.remove();
    },
  };
}
