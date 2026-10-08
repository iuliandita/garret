// app/ui/src/mirror-changes.ts
// What the writer changed in their folder, as rows they can read.
//
// A REVIEW SURFACE THAT NOW APPLIES -- ON EXACTLY THE ROWS THE HOST SAYS MAY BE
// APPLIED, and on no other. An earlier version shipped this panel with no accept control at
// all and a test asserting there was none; this moves that boundary rather than
// removing it. `can_accept` is the HOST's answer, derived from the change set
// it built itself, and the page's whole part in the decision is to obey it: a
// row painted from a stale read cannot grow a control the host would refuse,
// because the control follows the flag rather than the state name.
//
// The two states that carry one are `prose` -- the design's only applicable row
// -- and `conflict`, once the book's side has been preserved beside the file as
// an ordinary Markdown document the writer can open with anything. Six other
// states carry no body at all or carry one whose acceptance would discard a
// rename, trust a forged identifier, or merge structure into an open book.
//
// THE DIRECTION IS ALWAYS `your book` -> `the file`. It is said in the row's
// summary, in the row's accessible name, in the diff region's accessible name
// and in the legend -- four times, which the comparison design records as
// deliberate: a diff whose direction a reader has to guess is a diff half its
// readers will read backwards, and being confidently backwards about which side
// holds a paragraph is how someone accepts the wrong one.
//
// THE DIFF IS `diff.ts` AND THE PAINT IS `diff-view.ts`, both unchanged. There
// is one diff in this application and one renderer for it; a second of either
// would let this surface and version history disagree about which side is which.
import { diffWords, summarize } from "./diff";
import { renderPieces } from "./diff-view";
import { bodyText } from "./editor";
import { createPanelShell } from "./panel-shell";
import { formatNumber, plural, t } from "./i18n";

/** The host's `mirror::Change`. Field names are the host's snake_case, by the
 *  recorded rule: command ARGUMENTS are camelCase, returned struct fields are
 *  not. */
export interface MirrorChangeRow {
  readonly id: string;
  readonly path: string;
  readonly was_path: string | null;
  readonly state: string;
  readonly title: string;
  readonly file_title: string | null;
  readonly store_body: string | null;
  readonly file_body: string | null;
  readonly error: string | null;
  /** Whether the writer may take this row into their book. THE HOST'S ANSWER;
   *  see the header. The page renders a control where this is true and nowhere
   *  else, and the host refuses the id whether or not the page asked. */
  readonly can_accept: boolean;
  /** Underlined runs the folder ALREADY dropped from the book's side. Markdown
   *  has no underline (`decisions/2026-08-27-underline.md`), so the file never
   *  carried them and taking it cannot bring them back. Said on the row, above
   *  the control -- a notice afterwards would be an apology. */
  readonly store_underlined: number;
}

/** The host's `AcceptOutcome`. */
export interface MirrorAcceptOutcome {
  readonly report: {
    readonly documents: readonly { item_id: string; rev: number; body: string; version_id: number }[];
    readonly snapshot: { id: number; label: string; created_at: number; documents: number };
    readonly net_words: number;
  };
  readonly paths: readonly string[];
  readonly underlined: number;
}

export interface MirrorUndoHandle {
  readonly itemId: string;
  readonly versionId: number;
  readonly snapshotId: number;
  readonly acceptedRev: number;
  readonly title: string;
}

/** The states that carry two bodies and therefore a diff.
 *
 *  A SET, not a `state !== "..."` chain, because the interesting property is
 *  that this list is SHORT and every other state is reported without one. A row
 *  the writer cannot act on must not be dressed as one they can, and painting a
 *  diff is exactly that dressing. */
const COMPARABLE = new Set(["prose", "conflict"]);

/** The state the batch control sweeps.
 *
 *  PROSE AND NOT CONFLICT, deliberately. A conflict is two live versions of one
 *  scene with the writer choosing between them; a control that swept twelve of
 *  those in one press would discard eleven decisions nobody made. The batch is
 *  for the rows where there is nothing to decide. */
const SWEEPABLE = "prose";

export interface MirrorChangesDeps {
  /** Where the panel mounts. */
  container: HTMLElement;
  /** The host's `mirror_changes`. */
  changes(): Promise<MirrorChangeRow[]>;
  /** Flush pending keystrokes before reading the store's side.
   *
   *  DRAIN, THEN READ, and in that order for `history.ts`'s recorded reason:
   *  the "your book" side is the store's, and until the pending keystrokes are
   *  in it the store's answer is not the scene the writer is looking at. Here
   *  it matters more than it does there, because an undrained keystroke also
   *  makes the CONFLICT test wrong -- the document revision the host compares
   *  has not moved yet. */
  drain(): Promise<void>;
  /** Hold editing and conflicting document actions through reconciliation. */
  withOperation?(operation: () => Promise<void>): Promise<void>;
  /** The host's `mirror_accept`. IDS AND NOTHING ELSE: no body, no path, no
   *  revision crosses this boundary, so nothing the page holds can decide what
   *  is written -- only which of the rows the host derived is taken. */
  accept(ids: readonly string[]): Promise<MirrorAcceptOutcome>;
  /** What an accepted change obliges the page to do. THE FOURTH `replaceDoc`
   *  PATH hangs off this: the host has rewritten a body and moved its revision,
   *  so the open scene, its notes and every figure that describes it are stale.
   *  An earlier plan's write-back names this call site before it existed. */
  onAccepted(outcome: MirrorAcceptOutcome): void | Promise<void>;
  /** Restore one document from the acceptance's captured version. */
  undo(handle: MirrorUndoHandle): Promise<void>;
  onNotice(message: string): void;
  /** Where focus goes when Escape dismisses the panel. */
  onDismiss(): void;
}

export interface MirrorChanges {
  setOpen(on: boolean): Promise<void>;
  isOpen(): boolean;
  destroy(): void;
}

/** The words for one row's state. */
function stateText(row: MirrorChangeRow): string {
  switch (row.state) {
    case "moved":
      return t("mirror.changes.state.moved", { from: row.was_path ?? row.path });
    case "unreadable":
      return t("mirror.changes.state.unreadable", { error: row.error ?? "" });
    case "prose":
    case "conflict":
    case "front-matter":
    case "title":
    case "added":
    case "deleted":
      return t(`mirror.changes.state.${row.state}`);
    default:
      // A state this build does not know reaches the writer as its own name
      // rather than as a blank row. The host may grow one before the page does,
      // and a row that rendered as nothing would be a change the writer is
      // never told about.
      return row.state;
  }
}

/** The totals, in words a reader can act on.
 *
 *  ZERO ON BOTH SIDES IS SAID IN WORDS rather than rendered as an empty box:
 *  "nothing changed" and "the comparison did not run" are different answers,
 *  and an empty region is how the second one looks. That is `history.ts`'s
 *  recorded rule and it is shared here; only the sentence differs, because
 *  history's every string ends in "since this version" and neither of these two
 *  sides is a version of the other.
 *
 *  WORDS, not pieces: a piece is a run of whatever length the diff happened to
 *  produce, so counting pieces reports a number that changes with the shape of
 *  an edit rather than with its size. */
export function summaryLabel(added: number, removed: number): string {
  if (added === 0 && removed === 0) return t("mirror.changes.diff.none");
  const parts: string[] = [];
  if (added > 0)
    parts.push(plural("mirror.changes.diff.added", added, { count: formatNumber(added) }));
  if (removed > 0)
    parts.push(plural("mirror.changes.diff.removed", removed, { count: formatNumber(removed) }));
  return t("mirror.changes.diff.summary", { parts: parts.join(", ") });
}

/** What a row is ABOUT, in words. The book's title where there is one, and the
 *  path where there is not -- an added file names no item, and telling a writer
 *  about a change to "" helps nobody. */
function rowLabel(row: MirrorChangeRow): string {
  return row.title === "" ? row.path : row.title;
}

export function createMirrorChanges(deps: MirrorChangesDeps): MirrorChanges {
  let open = false;
  let destroyed = false;
  /** Bumped by every open, so a slow read that lands after the panel closed --
   *  or after a second open started -- paints nothing. */
  let generation = 0;

  const panel = document.createElement("div");
  panel.id = "mirror-changes";
  panel.hidden = true;
  // A REGION, not a dialog. Nothing here is modal and nothing here interrupts;
  // the writer is reading, and the mirror indicator beside it is a group for
  // the same reason.
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", t("mirror.changes.heading"));
  // Escape must work before a row button is focused. This is a non-modal
  // reading surface, so focus enters the region and no focus is trapped.
  panel.tabIndex = -1;

  const note = document.createElement("div");
  note.id = "mirror-changes-note";
  note.textContent = t("mirror.changes.note");

  const status = document.createElement("div");
  status.id = "mirror-changes-status";

  const undos = document.createElement("div");
  undos.id = "mirror-changes-undo";

  // ABOVE THE LIST, read the way the report panel reads it:
  // the list is what grows, and a control below it is a control a writer with
  // forty changed files cannot reach.
  const acceptAll = document.createElement("button");
  acceptAll.type = "button";
  acceptAll.id = "mirror-changes-accept-all";
  // A PLACEHOLDER FOR A HIDDEN BUTTON, never read: `refresh()` always sets
  // the real text through `plural()` before this button's `hidden` flag can
  // ever turn false, so the exact string here only has to be a REAL key --
  // `catalog-key-guard.test.ts` is what caught the previous line calling
  // `t()` on a base key this catalog only carries plural arms for, which
  // rendered the missing-key placeholder for the instant before the first
  // refresh, invisible only because `hidden` was already true.
  acceptAll.textContent = plural("mirror.changes.accept.all", 0, { count: formatNumber(0) });
  acceptAll.hidden = true;

  const list = document.createElement("ul");
  list.id = "mirror-changes-list";

  panel.append(note, status, acceptAll, list, undos);

  let undoHandles: MirrorUndoHandle[] = [];
  let actionPending = false;
  let currentRows: readonly MirrorChangeRow[] = [];

  function renderUndos(): void {
    undos.replaceChildren();
    for (const handle of undoHandles) {
      const row = document.createElement("div");
      row.className = "mirror-change-undo-row";
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "mirror-change-undo";
      undo.textContent = t("mirror.changes.undo");
      undo.setAttribute("aria-label", t("mirror.changes.undo.name", { title: handle.title }));
      undo.addEventListener("click", () => void undoOne(handle));
      const note = document.createElement("div");
      note.className = "mirror-change-undo-note";
      note.textContent = t("mirror.changes.undo.note", { title: handle.title });
      row.append(undo, note);
      undos.append(row);
    }
  }
  deps.container.append(panel);

  function renderRow(row: MirrorChangeRow): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "mirror-change";
    li.dataset.state = row.state;
    li.dataset.path = row.path;

    const what = document.createElement("div");
    what.className = "mirror-change-what";
    what.textContent = rowLabel(row);

    const state = document.createElement("div");
    state.className = "mirror-change-state";
    state.textContent = stateText(row);

    li.append(what, state);

    // The title row is the one place both names exist, and showing only one of
    // them would make a rename look like a change to something else.
    if (row.state === "title" && row.file_title !== null) {
      const was = document.createElement("div");
      was.className = "mirror-change-title-was";
      was.textContent = t("mirror.changes.title.was", {
        book: row.title,
        file: row.file_title,
      });
      li.append(was);
    }

    /** The loss, then the control that incurs it, at the END of the row.
     *
     *  ORDER FOUND BY LOOKING, and the first capture is what said so: the
     *  accept was drawn ABOVE the direction line and the Compare toggle, so the
     *  control that rewrites the writer's scene came before the two things that
     *  tell them which side it takes. On a review surface that is backwards --
     *  the whole reason the direction is stated four times is that a reader who
     *  guesses it presses the wrong way, and a control they meet first is a
     *  control they can press before reading any of it.
     *
     *  It moves down when the diff opens, which is what a disclosure does
     *  everywhere and is the point: the accept is what you do after looking. */
    const appendAccept = (): void => {
      if (!row.can_accept) return;
      if (row.store_underlined > 0) {
        const loss = document.createElement("div");
        loss.className = "mirror-change-loss";
        loss.textContent = plural("mirror.changes.loss.underline", row.store_underlined, {
          count: formatNumber(row.store_underlined),
        });
        li.append(loss);
      }
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "mirror-change-accept";
      accept.textContent = t("mirror.changes.accept");
      accept.setAttribute(
        "aria-label",
        t("mirror.changes.accept.name", { title: rowLabel(row) }),
      );
      accept.addEventListener("click", () => {
        void take([row.id]);
      });
      li.append(accept);
    };

    if (!COMPARABLE.has(row.state)) {
      appendAccept();
      return li;
    }

    const direction = document.createElement("div");
    direction.className = "mirror-change-direction";
    direction.textContent = t("mirror.changes.direction");

    const compare = document.createElement("button");
    compare.type = "button";
    compare.className = "mirror-change-compare";
    compare.textContent = t("mirror.changes.compare");
    compare.setAttribute("aria-expanded", "false");
    compare.setAttribute(
      "aria-label",
      t("mirror.changes.row.name", { title: rowLabel(row), state: stateText(row) }),
    );

    const region = document.createElement("div");
    region.className = "mirror-change-diff";
    region.hidden = true;

    const legend = document.createElement("div");
    legend.className = "mirror-change-legend";
    legend.textContent = t("mirror.changes.legend");

    const summary = document.createElement("div");
    summary.className = "mirror-change-summary";

    const bodyEl = document.createElement("div");
    bodyEl.className = "mirror-change-body";

    region.append(legend, summary, bodyEl);
    li.append(direction, compare, region);

    compare.addEventListener("click", () => {
      const showing = !region.hidden;
      if (showing) {
        region.hidden = true;
        compare.setAttribute("aria-expanded", "false");
        return;
      }
      // BEFORE IS THE BOOK, AFTER IS THE FILE, and the argument is the whole
      // sentence's frame: what the file has is `added`, what only the book has
      // is `removed`. Reversing these two paints a correct-looking diff that
      // says the opposite of what happened.
      let before: string;
      let after: string;
      try {
        before = row.store_body === null ? "" : bodyText(row.store_body);
        after = row.file_body === null ? "" : bodyText(row.file_body);
      } catch (err) {
        // NOT an empty diff, which renders as "nothing changed" -- the one
        // answer that tells a writer to stop looking.
        deps.onNotice(t("mirror.changes.error", { error: String(err) }));
        return;
      }
      const pieces = diffWords(before, after);
      const totals = summarize(pieces);
      summary.textContent = summaryLabel(totals.added, totals.removed);
      // BUILT FROM THE FIGURES, never by reading the rendered summary back out
      // of the DOM: the recorded word-count rule, which is what stops the
      // visible wording becoming load-bearing for what a reader hears.
      //
      // AND IT REUSES `summaryLabel` rather than restating the totals in a
      // second interpolation. The first draft had its own `{removed} words`
      // string here and announced "1 words" -- the singular is the FIRST thing
      // a reader of a one-word change meets, and a sentence built twice is a
      // sentence that gets the plural right in one place.
      region.setAttribute(
        "aria-label",
        t("mirror.changes.diff.region.full", {
          intro: t("mirror.changes.diff.region", { title: rowLabel(row) }),
          summary: summaryLabel(totals.added, totals.removed),
        }),
      );
      renderPieces(bodyEl, pieces);
      region.hidden = false;
      compare.setAttribute("aria-expanded", "true");
    });

    appendAccept();
    return li;
  }

  /** Take the named rows into the book, then read the folder again.
   *
   *  THE RE-READ IS NOT A REFRESH FOR TIDINESS. The rows describe the folder at
   *  the moment it was read and an accept changes that folder; leaving them
   *  painted would show the writer a change they have just resolved and offer
   *  to resolve it a second time.
   *
   *  A REFUSAL LEAVES THE ROWS EXACTLY WHERE THEY ARE. The host refuses the
   *  whole batch or none of it, so the panel is still describing the truth. */
  async function take(ids: readonly string[]): Promise<void> {
    if (destroyed || ids.length === 0 || actionPending) return;
    const labels = new Map(currentRows.map((row) => [row.id, rowLabel(row)]));
    actionPending = true;
    let committed = false;
    try {
      const operation = async (): Promise<void> => {
        await deps.drain();
        if (destroyed) return;
        const outcome = await deps.accept(ids);
        committed = true;
        if (destroyed) return;
        // Reconcile before reading the change set again: the host has moved
        // document revisions and any open content must agree with them.
        try {
          await deps.onAccepted(outcome);
        } catch (err) {
          if (!destroyed) deps.onNotice(t("mirror.changes.accept.reconcile.error", { error: String(err) }));
        }
        if (destroyed) return;
        undoHandles = outcome.report.documents.map((doc) => ({
          itemId: doc.item_id,
          versionId: doc.version_id,
          snapshotId: outcome.report.snapshot.id,
          acceptedRev: doc.rev,
          title: labels.get(doc.item_id) ?? doc.item_id,
        }));
        renderUndos();
        await refresh();
      };
      if (deps.withOperation) await deps.withOperation(operation);
      else await operation();
    } catch (err) {
      if (!destroyed) deps.onNotice(t(committed ? "mirror.changes.accept.reconcile.error" : "mirror.changes.accept.error", { error: String(err) }));
    } finally {
      actionPending = false;
    }
  }

  async function undoOne(handle: MirrorUndoHandle): Promise<void> {
    if (destroyed || actionPending || !undoHandles.includes(handle)) return;
    actionPending = true;
    try {
      await deps.undo(handle);
    } catch (err) {
      if (!destroyed) deps.onNotice(t("mirror.changes.undo.error", { error: String(err) }));
      actionPending = false;
      return;
    }
    if (destroyed) return;
    undoHandles = undoHandles.filter((candidate) => candidate !== handle);
    renderUndos();
    try {
      await refresh();
    } finally {
      actionPending = false;
    }
  }

  async function refresh(): Promise<void> {
    const mine = ++generation;
    await deps.drain();
    if (destroyed || mine !== generation || !open) return;
    let rows: MirrorChangeRow[];
    try {
      rows = await deps.changes();
    } catch (err) {
      if (destroyed || mine !== generation || !open) return;
      status.textContent = t("mirror.changes.error", { error: String(err) });
      list.replaceChildren();
      return;
    }
    if (destroyed || mine !== generation || !open) return;
    currentRows = rows;
    status.textContent =
      rows.length === 0
        ? t("mirror.changes.empty")
        : plural("mirror.changes.status", rows.length, {
            count: formatNumber(rows.length),
          });
    const sweep = rows.filter((r) => r.can_accept && r.state === SWEEPABLE).map((r) => r.id);
    acceptAll.hidden = sweep.length === 0;
    acceptAll.textContent = plural("mirror.changes.accept.all", sweep.length, {
      count: formatNumber(sweep.length),
    });
    acceptAll.onclick = () => {
      void take(sweep);
    };
    list.replaceChildren(...rows.map(renderRow));
  }

  // Close, Escape and a click elsewhere (the shell's). A click has already
  // chosen its focus target, so the outside dismissal does not call onDismiss
  // or pull focus back to the editor; Close and Escape do.
  const shell = createPanelShell({
    panel,
    title: t("mirror.changes.heading"),
    titleId: "mirror-changes-heading",
    isOpen: () => open,
    close: () => void setOpen(false),
    returnFocus: deps.onDismiss,
  });

  async function setOpen(on: boolean): Promise<void> {
    open = on;
    panel.hidden = !on;
    if (!on) {
      acceptAll.hidden = true;
      // EMPTIED ON CLOSE. What the panel showed describes the folder at the
      // moment it was read, and a reopened panel painting yesterday's rows
      // before the new read lands is a writer told about a change that is
      // already resolved.
      list.replaceChildren();
      status.textContent = "";
      return;
    }
    // Focus synchronously, before the asynchronous read. A late read is
    // generation-guarded and must never repaint or refocus after close.
    panel.focus();
    renderUndos();
    await refresh();
  }

  return {
    setOpen,
    isOpen(): boolean {
      return open;
    },
    destroy(): void {
      destroyed = true;
      shell.destroy();
      panel.remove();
    },
  };
}
