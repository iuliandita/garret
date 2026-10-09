// app/ui/src/history.ts
// The panel that gives a writer their words back.
//
// Two lists over one store: the OPEN SCENE's past states, and the manuscript's
// named moments. They are one panel rather than two because a writer opening
// "history" is asking one question -- what did this used to say -- and the
// answer lives on both sides of that line depending on how long ago they mean.
//
// NOT THE UNDO STACK. Ctrl+Z is per keystroke and per session; this is per five
// minutes and survives the window closing. A restore even RESETS the undo
// history, because `replaceDoc` builds a new editor state -- which is exactly
// why restoring captures what it overwrites first. Undo is not the way back
// from a restore; the version the restore just made is.
import { isCompositionKey } from "./composition-key";
import { formatDate, formatNumber, plural, t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { diffWords, summarize } from "./diff";
import { renderPieces } from "./diff-view";
import { bodyText } from "./editor";

/** One past state, as the host lists it. Field names are the host's, snake_case
 *  by the recorded rule: command ARGUMENTS are camelCase, returned struct
 *  fields are not. */
export interface VersionRow {
  readonly id: number;
  readonly created_at: number;
  readonly words: number;
  readonly snapshot_label: string | null;
  readonly snapshot_id: number | null;
}

export interface SnapshotRow {
  readonly id: number;
  readonly label: string;
  readonly created_at: number;
  readonly documents: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a version was taken, as a reader scans it.
 *
 *  RELATIVE under a week, and that is a decision about testability as much as
 *  about reading. A clock time needs `toLocaleTimeString`, whose output is a
 *  property of the runtime's ICU data -- the recorded reason `localDate` builds
 *  `YYYY-MM-DD` by hand -- so a test asserting one is asserting a fact about
 *  the machine. "Fourteen minutes ago" is also what a writer scanning a column
 *  of versions is actually asking.
 *
 *  Beyond a week the relative form stops helping ("47 days ago" is not a date
 *  anyone can place) and it falls back to the locale's own date, where being
 *  wrong is a display detail rather than a wrong answer.
 */
export function formatWhen(createdAt: number, now: number): string {
  const diff = now - createdAt;
  if (diff < 0) return t("history.when.now");
  if (diff < 45 * 1000) return t("history.when.now");
  if (diff < 90 * MINUTE) return plural("history.when.minutes", Math.round(diff / MINUTE));
  if (diff < 22 * HOUR) return plural("history.when.hours", Math.round(diff / HOUR));
  if (diff < 6 * DAY) return plural("history.when.days", Math.round(diff / DAY));
  return formatDate(createdAt);
}

/** How much longer or shorter this version is than the one before it.
 *
 *  An ABSENT previous and a delta of ZERO are different answers and are said
 *  differently. The oldest version has nothing to compare against; a version
 *  the same length as its predecessor is a real measurement, and a writer
 *  looking for "the one before I cut the chapter" needs to be able to tell
 *  "unchanged" from "unknown".
 *
 *  A loss is drawn with U+2212 MINUS SIGN, matching the goals readout. A hyphen
 *  at the start of a number is a hyphen, and it renders shorter and higher.
 */
export function formatDelta(words: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  const delta = words - previous;
  if (delta === 0) return t("history.delta.none");
  if (delta > 0) return `+${formatNumber(delta)}`;
  return `−${formatNumber(Math.abs(delta))}`;
}

/** What a screen reader is told about a row.
 *
 *  Built from the FIGURES, never by reading the rendered text back out of the
 *  DOM. That is the recorded word-count rule: a name derived from the display
 *  makes the display's wording load-bearing for accessibility, so the visible
 *  form cannot be shortened without shortening what a screen reader hears.
 */
export function versionLabel(row: VersionRow, previous: number | undefined, now: number): string {
  const when = row.snapshot_label !== null
    ? t("history.version.when.snapshot", {
        label: row.snapshot_label,
        when: formatWhen(row.created_at, now),
      })
    : formatWhen(row.created_at, now);
  const words = plural("history.words", row.words, { count: formatNumber(row.words) });
  if (previous === undefined) return t("history.version.label", { when, words });
  const delta = row.words - previous;
  if (delta === 0) return t("history.version.label.same", { when, words });
  const size = formatNumber(Math.abs(delta));
  return delta > 0
    ? t("history.version.label.more", { when, words, size })
    : t("history.version.label.fewer", { when, words, size });
}

/** The row's own visible name for a version: its snapshot label if it has one,
 *  otherwise when it was taken. Stated once because the row and the comparison
 *  below it must call the same version the same thing - a diff headed "2 days
 *  ago" against a row reading "before the second act" is two names for one
 *  thing, and the reader has to work out that it is one thing. */
export function whenText(row: VersionRow, now: number): string {
  return row.snapshot_label !== null
    ? t("history.version.snapshot-label", { label: row.snapshot_label })
    : formatWhen(row.created_at, now);
}

/** The one sentence a comparison is read for, and the figure the row's delta
 *  cannot give.
 *
 *  The delta beside a row is NET: a version 200 words shorter than the one
 *  before it may be a chapter cut and a chapter written, and "−200" says
 *  nothing about either. Added and removed are the two numbers a writer
 *  deciding whether to restore actually needs.
 *
 *  DIRECTION IS IN THE WORDS, not left to the reader. "since this version" is
 *  the whole sentence's frame: what came later is added, what is gone is
 *  removed. A diff whose direction has to be inferred is a diff half its
 *  readers will infer backwards, and being confidently backwards about which
 *  draft holds a paragraph is worse than having no comparison at all.
 *
 *  Zero on both sides is said IN WORDS rather than rendered as an empty box:
 *  "nothing changed" and "the comparison did not run" are different answers,
 *  and an empty region is how the second one looks. */
export function diffSummaryLabel(added: number, removed: number): string {
  if (added === 0 && removed === 0) {
    return t("history.diff.none");
  }
  const parts: string[] = [];
  if (added > 0) parts.push(plural("history.diff.added", added, { count: formatNumber(added) }));
  if (removed > 0) parts.push(t("history.diff.removed.short", { count: formatNumber(removed) }));
  // "89 removed" alone reads as a fragment; with nothing added it is the whole
  // measurement and must say what it counts.
  if (added === 0)
    return plural("history.diff.removed-only", removed, { count: formatNumber(removed) });
  return t("history.diff.summary", { parts: parts.join(", ") });
}

/** "1 document", never "1 documents". A manuscript of one scene is the state
 *  every new project starts in, so the singular is the FIRST thing a writer
 *  sees rather than an edge case - which is how it shipped wrong, and what a
 *  screenshot caught.
 *
 *  The rule is stated ONCE and used by all five places that say it, including
 *  the armed confirmation, whose whole job is to be read carefully. */
export function documentsLabel(count: number): string {
  return plural("history.documents", count, { count: formatNumber(count) });
}

export interface HistoryDeps {
  readonly container: HTMLElement;
  /** Settle pending edits before anything reads or writes bodies. A restore
   *  against a document with an unflushed keystroke would refuse on the rev, or
   *  worse, be overwritten by the flush that lands after it. */
  drain(): Promise<void>;
  /** Own editor writes and departure until the stored result is reconciled. */
  withOperation(operation: () => Promise<void>): Promise<void>;
  activeDocId(): string;
  /** The revision the page believes the open document is at. `undefined` means
   *  the page does not know, and a restore is refused rather than sent with a
   *  guess -- guessing is how a base_rev discipline becomes decorative. */
  revOf(itemId: string): number | undefined;
  versions(itemId: string): Promise<VersionRow[]>;
  restore(itemId: string, versionId: number, baseRev: number): Promise<{ rev: number; body: string }>;
  /** The body the STORE holds for the open document, as JSON, for the "now"
   *  side of a comparison.
   *
   *  FROM THE HOST, never from the live editor, and the drain before it is what
   *  makes the two the same thing. A comparison against unflushed keystrokes
   *  describes a state the store does not hold: the writer would be told a
   *  paragraph is already in the manuscript when nothing has written it yet,
   *  and every other operation in this panel drains for the same reason. */
  currentBody(itemId: string): Promise<string>;
  /** What one past version held, as JSON. The old side of a comparison. */
  versionBody(versionId: number): Promise<string>;
  snapshots(): Promise<SnapshotRow[]>;
  takeSnapshot(label: string): Promise<SnapshotRow>;
  restoreSnapshot(snapshotId: number): Promise<{ documents: number; covered: number }>;
  /** Put the restored body in the editor and re-register the new revision. The
   *  panel does not touch the editor itself: the page owns the session, and a
   *  unit that swapped the document without telling the flush scheduler its new
   *  rev would make the writer's next keystroke a conflict. */
  applyRestored(itemId: string, body: string, rev: number): void | Promise<void>;
  /** After a snapshot restore, every open figure is stale. */
  reloadProject(): Promise<void>;
  onDone(message: string): void;
  onNotice(message: string): void;
  onDismiss(): void;
  now?(): number;
}

export interface History {
  open(): Promise<void>;
  isOpen(): boolean;
  destroy(): void;
}

export function createHistory(deps: HistoryDeps): History {
  const { container } = deps;
  const now = deps.now ?? (() => Date.now());

  const panel = document.createElement("div");
  panel.id = "history-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("history.panel.label"));
  panel.hidden = true;

  const heading = document.createElement("div");
  heading.id = "history-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "3");
  heading.textContent = t("history.heading");

  const list = document.createElement("div");
  list.id = "history-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", t("history.list.label"));

  // Keep the comparison outside the action rows. It moves beside the chosen
  // row, within a list item whose explicit name never includes the diff prose.
  const diff = document.createElement("div");
  diff.id = "history-diff";
  diff.setAttribute("role", "region");
  diff.hidden = true;

  // WHICH VERSION, visibly. The row's Compare button carries it in its
  // accessible name and in `aria-expanded`, and neither is on screen: a reader
  // who compared one version, scrolled, and compared another has nothing
  // telling them which of the two they are looking at. Found by capture - the
  // fifth time in this repo that a picture answered a question no gate asks.
  const diffOf = document.createElement("div");
  diffOf.id = "history-diff-of";

  const diffSummary = document.createElement("div");
  diffSummary.id = "history-diff-summary";

  // The direction, in visible words, once per comparison. The colours below say
  // it too and cannot say it alone: this legend is the only channel that
  // survives a reader who does not distinguish them, and it is the only one at
  // all for a reader who arrives at the diff already scrolled past its heading.
  const diffLegend = document.createElement("div");
  diffLegend.id = "history-diff-legend";
  diffLegend.textContent = t("history.diff.legend");

  const diffBody = document.createElement("div");
  diffBody.id = "history-diff-body";

  diff.append(diffOf, diffSummary, diffLegend, diffBody);

  const status = document.createElement("div");
  status.id = "history-status";
  status.setAttribute("role", "status");

  const snapHeading = document.createElement("div");
  snapHeading.id = "snapshot-heading";
  snapHeading.setAttribute("role", "heading");
  snapHeading.setAttribute("aria-level", "3");
  snapHeading.textContent = t("history.snapshots.heading");

  const snapNameField = document.createElement("div");
  snapNameField.className = "field-with-label";
  const snapNameLabel = document.createElement("label");
  snapNameLabel.htmlFor = "snapshot-name";
  snapNameLabel.textContent = t("history.snapshots.name.label");

  const snapName = document.createElement("input");
  snapName.id = "snapshot-name";
  snapName.type = "text";
  snapName.placeholder = t("history.snapshots.name.placeholder");
  snapNameField.append(snapNameLabel, snapName);

  const snapTake = document.createElement("button");
  snapTake.id = "snapshot-take";
  snapTake.type = "button";
  snapTake.textContent = t("history.snapshots.take");
  // The panel's one CREATING action, against a list of per-row secondaries.
  snapTake.dataset.weight = "primary";
  snapTake.setAttribute("aria-label", t("history.snapshots.take.label"));

  const snapList = document.createElement("div");
  snapList.id = "snapshot-list";
  snapList.setAttribute("role", "list");
  snapList.setAttribute("aria-label", t("history.snapshots.list.label"));

  const snapConfirmation = document.createElement("div");
  snapConfirmation.id = "snapshot-confirmation";
  snapConfirmation.className = "sr-only";
  snapConfirmation.setAttribute("role", "status");
  snapConfirmation.setAttribute("aria-live", "polite");

  panel.append(heading, list, diff, status, snapHeading, snapNameField, snapTake, snapList, snapConfirmation);
  container.append(panel);

  let destroyed = false;
  /** A listing that resolves after a newer one, or after the panel closed, must
   *  not repaint: the reader would act on rows describing a document that is no
   *  longer open. */
  let generation = 0;
  let rows: VersionRow[] = [];
  let listedItemId: string | null = null;
  let busy = false;

  function setBusy(value: boolean): void {
    busy = value;
    if (value) panel.setAttribute("aria-busy", "true");
    else panel.removeAttribute("aria-busy");
    snapName.disabled = value;
    snapTake.disabled = value;
    for (const button of panel.querySelectorAll<HTMLButtonElement>(".history-row button, .snapshot-row")) button.disabled = value;
  }

  async function withOperation(operation: (refreshOwned: () => Promise<void>) => Promise<void>): Promise<void> {
    if (busy || destroyed) return;
    const focused = document.activeElement;
    const owner = focused instanceof HTMLElement && panel.contains(focused) ? focused : null;
    const itemId = deps.activeDocId();
    let ownedGeneration = generation;
    let ownsFocus = owner !== null;
    // WebKit can defer the blur caused by disabling. Blur first so that event
    // cannot be mistaken for the writer leaving during the operation.
    owner?.blur();
    setBusy(true);
    const cancelFocus = (): void => { ownsFocus = false; };
    const onFocus = (event: FocusEvent): void => {
      if (event.target !== owner) cancelFocus();
    };
    const onBlur = (): void => {
      if (owner?.isConnected) cancelFocus();
    };
    document.addEventListener("focusin", onFocus);
    owner?.addEventListener("blur", onBlur);
    window.addEventListener("blur", cancelFocus);
    try {
      await deps.withOperation(() => operation(async () => {
        if (generation !== ownedGeneration) cancelFocus();
        ownedGeneration = generation + 1;
        await refresh();
      }));
    } finally {
      document.removeEventListener("focusin", onFocus);
      owner?.removeEventListener("blur", onBlur);
      window.removeEventListener("blur", cancelFocus);
      setBusy(false);
      if (ownsFocus && !destroyed && !panel.hidden && ownedGeneration === generation && itemId === deps.activeDocId()
        && (document.activeElement === owner || document.activeElement === document.body)) {
        (owner?.isConnected ? owner : snapName).focus();
      }
    }
  }
  /** The snapshot whose restore has been ASKED FOR but not confirmed. One press
   *  is not enough for an operation whose blast radius is the whole book, and a
   *  latch is how the second press knows it is the second. */
  let armed: number | null = null;
  /** The version whose diff is on screen, or null. ONE, because two diffs in a
   *  420px panel is a scroll fold, and the recorded shortcuts-panel failure is
   *  that rows below a fold do not exist for the reader at all. */
  let comparing: number | null = null;
  /** A comparison that resolves after a newer one - or after the list was
   *  rebuilt under it - must not paint. Its own counter rather than
   *  `generation`: a refresh landing mid-comparison should cancel the diff (its
   *  row is being replaced), but a comparison must never cancel a refresh. */
  let compareGeneration = 0;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    if (!open) {
      disarm();
      closeDiff();
    }
  }

  function disarm(): void {
    armed = null;
    snapConfirmation.textContent = "";
    for (const el of snapList.querySelectorAll("[data-armed]")) {
      el.removeAttribute("data-armed");
      el.setAttribute("aria-label", el.getAttribute("data-restore-label") ?? "");
      const label = el.getAttribute("data-label") ?? "";
      const count = Number(el.getAttribute("data-documents") ?? "0");
      el.textContent = t("history.snapshots.row", { label, documents: documentsLabel(count) });
    }
  }

  /** Take the diff down and stop whatever comparison is in flight from
   *  painting. Bumping the counter is the second half: without it a fetch
   *  already sent lands on a hidden region and re-shows it. */
  function closeDiff(): void {
    compareGeneration += 1;
    comparing = null;
    diff.hidden = true;
    list.after(diff);
    diffBody.replaceChildren();
    diffLegend.hidden = false;
    diffOf.textContent = "";
    diffSummary.textContent = "";
    diff.removeAttribute("aria-label");
    for (const el of list.querySelectorAll(".history-compare")) {
      el.setAttribute("aria-expanded", "false");
    }
  }

  function renderVersions(): void {
    const at = now();
    const frag = document.createDocumentFragment();
    for (const [i, row] of rows.entries()) {
      // rows are newest first, so the version BEFORE this one is the next
      // element, not the previous.
      const previous = rows[i + 1]?.words;
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-label", versionLabel(row, previous, at));
      const el = document.createElement("div");
      el.className = "history-row";
      el.dataset.versionId = String(row.id);

      const when = document.createElement("span");
      when.className = "history-when";
      when.textContent = whenText(row, at);

      const words = document.createElement("span");
      words.className = "history-words";
      words.textContent = plural("history.row.words", row.words, { count: formatNumber(row.words) });

      const delta = document.createElement("span");
      delta.className = "history-delta";
      delta.textContent = formatDelta(row.words, previous);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.disabled = busy;
      restore.className = "history-restore";
      restore.dataset.weight = "quiet";
      restore.dataset.versionId = String(row.id);
      restore.textContent = t("history.row.restore");
      restore.setAttribute(
        "aria-label",
        t("history.row.restore.label", { version: versionLabel(row, previous, at) }),
      );

      const compare = document.createElement("button");
      compare.type = "button";
      compare.disabled = busy;
      compare.className = "history-compare";
      compare.dataset.weight = "quiet";
      compare.dataset.versionId = String(row.id);
      compare.textContent = t("history.row.compare");
      compare.setAttribute("aria-expanded", "false");
      compare.setAttribute("aria-controls", "history-diff");
      // The direction is in the button's name as well as in the region's,
      // because this is the control a reader presses BEFORE they have anything
      // to read - and if they have to press it to find out which way round it
      // runs, they have learned it from the answer rather than the question.
      compare.setAttribute(
        "aria-label",
        t("history.row.compare.label", { version: versionLabel(row, previous, at) }),
      );

      el.append(when, words, delta, restore, compare);
      item.append(el);
      frag.append(item);
    }
    list.replaceChildren(frag);
    // The buttons that owned the open diff have just been destroyed, so the
    // region is describing a comparison nothing on screen points at.
    closeDiff();
  }

  function renderSnapshots(snaps: SnapshotRow[]): void {
    if (snaps.length === 0) {
      // An empty listbox is indistinguishable from one that failed to paint.
      // The recorded defect: `renderProjects` had no empty state for six
      // slices and the panel had been photographed that way.
      const empty = document.createElement("div");
      empty.id = "snapshot-empty";
      empty.textContent = t("history.snapshots.empty");
      snapList.replaceChildren(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const snap of snaps) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "snapshot-row";
      el.disabled = busy;
      el.dataset.snapshotId = String(snap.id);
      el.dataset.label = snap.label;
      el.dataset.documents = String(snap.documents);
      el.textContent = t("history.snapshots.row", {
        label: snap.label,
        documents: documentsLabel(snap.documents),
      });
      el.setAttribute(
        "aria-label",
        t("history.snapshots.restore.label", {
          label: snap.label,
          when: formatWhen(snap.created_at, now()),
          documents: documentsLabel(snap.documents),
        }),
      );
      el.dataset.restoreLabel = el.getAttribute("aria-label") ?? "";
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");
      item.append(el);
      frag.append(item);
    }
    snapList.replaceChildren(frag);
  }

  async function refresh(): Promise<void> {
    disarm();
    const mine = ++generation;
    const itemId = deps.activeDocId();
    status.textContent = t("history.reading");
    let versions: VersionRow[];
    let snaps: SnapshotRow[];
    try {
      [versions, snaps] = await Promise.all([deps.versions(itemId), deps.snapshots()]);
    } catch (err) {
      if (destroyed || mine !== generation) return;
      status.textContent = "";
      deps.onNotice(t("history.error.read", { error: String(err) }));
      return;
    }
    if (destroyed || mine !== generation) return;
    listedItemId = itemId;
    rows = versions;
    renderVersions();
    renderSnapshots(snaps);
    status.textContent =
      versions.length === 0
        ? t("history.status.empty")
        : plural("history.status.count", versions.length, {
            count: formatNumber(versions.length),
          });
  }

  async function doCompare(versionId: number, row: VersionRow, previous: number | undefined): Promise<void> {
    // A second press on the row whose diff is up puts it away. The control is
    // the only thing on screen that could, and `aria-expanded` has already told
    // the reader it is a thing that closes.
    if (comparing === versionId) {
      closeDiff();
      return;
    }
    closeDiff();
    const mine = ++compareGeneration;
    comparing = versionId;
    const at = now();
    const button = list.querySelector<HTMLButtonElement>(`.history-compare[data-version-id="${versionId}"]`);
    let reveal = document.activeElement === button;
    const cancelReveal = (): void => { reveal = false; };
    button?.addEventListener("blur", cancelReveal, { once: true });
    button?.setAttribute("aria-expanded", "true");
    button?.closest(".history-row")?.after(diff);
    diff.hidden = false;
    diffOf.textContent = t("history.diff.of", { when: whenText(row, at) });
    diffSummary.textContent = t("history.diff.comparing");
    diff.setAttribute(
      "aria-label",
      t("history.diff.region.label", { version: versionLabel(row, previous, at) }),
    );

    const itemId = listedItemId;
    // DRAIN, THEN READ, and in that order for the reason the dep records: the
    // "now" side is the store's, and until the pending keystrokes are in it the
    // store's answer is not the scene the writer is looking at.
    let before: string;
    let after: string;
    try {
      if (itemId === null || itemId !== deps.activeDocId()) throw new Error(t("history.error.changed"));
      await deps.drain();
      if (destroyed || mine !== compareGeneration) return;
      if (itemId !== deps.activeDocId()) throw new Error(t("history.error.changed"));
      const [oldBody, newBody] = await Promise.all([
        deps.versionBody(versionId),
        deps.currentBody(itemId),
      ]);
      if (destroyed || mine !== compareGeneration) return;
      if (itemId !== deps.activeDocId()) throw new Error(t("history.error.changed"));
      before = bodyText(oldBody, "\n\n");
      after = bodyText(newBody, "\n\n");
    } catch (err) {
      if (destroyed || mine !== compareGeneration) return;
      // NOT the "no difference" line, which is the designed empty state: a
      // store that could not be read would then report two texts as identical,
      // and identical is the one answer that tells a writer to stop looking.
      comparing = null;
      diff.hidden = true;
      button?.setAttribute("aria-expanded", "false");
      deps.onNotice(t("history.error.compare", { error: String(err) }));
      return;
    } finally {
      button?.removeEventListener("blur", cancelReveal);
    }

    const pieces = diffWords(before, after);
    const totals = summarize(pieces);
    diffSummary.textContent = diffSummaryLabel(totals.added, totals.removed);
    // Built from the FIGURES, never by reading the rendered summary back out of
    // the DOM: the recorded word-count rule, which is what stops the visible
    // wording becoming load-bearing for what a screen reader hears.
    diff.setAttribute(
      "aria-label",
      t("history.diff.region.label.totals", {
        version: versionLabel(row, previous, at),
        added: formatNumber(totals.added),
        removed: formatNumber(totals.removed),
      }),
    );
    // The legend explains two marks. With neither on screen it is a caption for
    // nothing, which reads as a diff that failed to paint its own body.
    diffLegend.hidden = totals.added === 0 && totals.removed === 0;
    if (totals.added === 0 && totals.removed === 0) {
      // The summary already says it in words. Painting the whole unchanged
      // scene under a line that says nothing changed is a screenful of prose
      // asking to be read for a difference that is not there.
      diffBody.replaceChildren();
    } else {
      renderPieces(diffBody, pieces);
    }
    // Reveal the summary, then keep its adjacent control fully visible. The
    // whole diff may be taller than the available pane. A writer who moved
    // focus while it loaded has already moved on from this request.
    if (reveal && document.activeElement === button && !panel.hidden) {
      diffSummary.scrollIntoView({ block: "nearest", inline: "nearest" });
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  async function doRestore(versionId: number): Promise<void> {
    const itemId = listedItemId;
    try {
      await withOperation(async () => {
        if (itemId === null || itemId !== deps.activeDocId()) throw new Error(t("history.error.changed"));
        await deps.drain();
        if (destroyed) return;
        if (itemId !== deps.activeDocId()) throw new Error(t("history.error.changed"));
        const baseRev = deps.revOf(itemId);
        if (baseRev === undefined) {
          deps.onNotice(t("history.error.unknown-rev"));
          return;
        }
        const restored = await deps.restore(itemId, versionId, baseRev);
        if (destroyed) return;
        await deps.applyRestored(itemId, restored.body, restored.rev);
        if (destroyed) return;
        setOpen(false);
        deps.onDismiss();
        deps.onDone(t("history.done.restored"));
      });
    } catch (err) {
      if (destroyed) return;
      deps.onNotice(t("history.error.restore", { error: String(err) }));
    }
  }

  async function takeSnapshot(): Promise<void> {
    const label = snapName.value.trim();
    if (label === "") {
      // The recorded states-and-messages finding: a bare `return` on an empty
      // field, in a panel whose first user has just been given that field.
      deps.onNotice(t("history.snapshots.error.no-name"));
      snapName.focus();
      return;
    }
    try {
      await withOperation(async (refreshOwned) => {
        await deps.drain();
        if (destroyed) return;
        const snap = await deps.takeSnapshot(label);
        if (destroyed) return;
        snapName.value = "";
        deps.onDone(
          t("history.snapshots.done.taken", {
            label: snap.label,
            documents: documentsLabel(snap.documents),
          }),
        );
        await refreshOwned();
      });
    } catch (err) {
      if (destroyed) return;
      deps.onNotice(t("history.snapshots.error.take", { error: String(err) }));
    }
  }

  async function restoreSnapshot(snapshotId: number, el: HTMLElement): Promise<void> {
    if (busy) return;
    if (armed !== snapshotId) {
      disarm();
      el.focus();
      armed = snapshotId;
      el.setAttribute("data-armed", "true");
      const label = el.dataset.label ?? "";
      const confirmation = t("history.snapshots.confirm", {
        label,
        documents: documentsLabel(Number(el.dataset.documents ?? "0")),
      });
      el.textContent = confirmation;
      el.setAttribute("aria-label", confirmation);
      snapConfirmation.textContent = confirmation;
      return;
    }
    disarm();
    try {
      await withOperation(async () => {
        await deps.drain();
        if (destroyed) return;
        const out = await deps.restoreSnapshot(snapshotId);
        if (destroyed) return;
        await deps.reloadProject();
        if (destroyed) return;
        // Same reason as a single restore, with more of it: every row in both
        // lists is stale and the writer's manuscript has just moved underneath
        // them.
        setOpen(false);
        deps.onDismiss();
        deps.onDone(
          out.documents === 0
            ? t("history.snapshots.done.no-change")
            : t("history.snapshots.done.restored", {
                documents: formatNumber(out.documents),
                covered: documentsLabel(out.covered),
              }),
        );
      });
    } catch (err) {
      if (destroyed) return;
      deps.onNotice(t("history.snapshots.error.restore", { error: String(err) }));
    }
  }

  function onListClick(event: Event): void {
    if (busy) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const compare = target.closest(".history-compare");
    if (compare instanceof HTMLElement) {
      const id = Number(compare.dataset.versionId);
      if (!Number.isFinite(id)) return;
      // The ROW and its predecessor's length, from the list the panel is
      // holding rather than from the button - the region's name is built from
      // the same figures as the row's, so the two cannot describe different
      // versions of the same comparison.
      const index = rows.findIndex((row) => row.id === id);
      const row = rows[index];
      if (row === undefined) return;
      void doCompare(id, row, rows[index + 1]?.words);
      return;
    }
    const button = target.closest(".history-restore");
    if (!(button instanceof HTMLElement)) return;
    const id = Number(button.dataset.versionId);
    if (!Number.isFinite(id)) return;
    void doRestore(id);
  }

  function onSnapListClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest(".snapshot-row");
    if (!(row instanceof HTMLElement)) return;
    const id = Number(row.dataset.snapshotId);
    if (!Number.isFinite(id)) return;
    void restoreSnapshot(id, row);
  }

  const onSnapshotBlur = (event: FocusEvent): void => {
    if (event.target instanceof HTMLElement && event.target.hasAttribute("data-armed")) disarm();
  };
  const onSnapshotEscape = (event: KeyboardEvent): void => {
    if (isCompositionKey(event) || event.key !== "Escape" || armed === null) return;
    event.preventDefault();
    disarm();
  };
  list.addEventListener("click", onListClick);
  snapList.addEventListener("click", onSnapListClick);
  snapList.addEventListener("blur", onSnapshotBlur, true);
  panel.addEventListener("keydown", onSnapshotEscape);
  window.addEventListener("blur", disarm);
  snapName.addEventListener("keydown", (event) => {
    if (isCompositionKey(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void takeSnapshot();
    }
  });
  snapTake.addEventListener("click", () => void takeSnapshot());

  // Close, Escape and a click elsewhere (the shell's). #history-heading stays
  // as the heading of the scene's own versions, above the snapshots'.
  const shell = createPanelShell({
    panel,
    title: t("history.title"),
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
    inspector: true,
  });

  return {
    async open(): Promise<void> {
      if (busy || destroyed) return;
      setOpen(true);
      snapName.focus();
      await refresh();
    },
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      destroyed = true;
      shell.destroy();
      list.removeEventListener("click", onListClick);
      snapList.removeEventListener("click", onSnapListClick);
      snapList.removeEventListener("blur", onSnapshotBlur, true);
      panel.removeEventListener("keydown", onSnapshotEscape);
      window.removeEventListener("blur", disarm);
      panel.remove();
    },
  };
}
