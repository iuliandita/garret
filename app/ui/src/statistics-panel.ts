// app/ui/src/statistics-panel.ts
// The surface that shows what `statistics.ts` computed, and says what each
// figure means.
//
// A PANEL, NOT BAR CHROME, and that is a geometry decision before it is a design
// one. The project bar's 39px height is a click-geometry constant restated in
// five rigs, each pressing at a coordinate computed from it; a strip of counters
// moves every navigator row down and every one of those rigs goes on clicking
// where it computed rather than where the writer sees. This hangs off
// #project-bar exactly as #find-panel, #prefs-panel, #history-panel and
// #quick-open-panel do, and costs the bar nothing.
//
// COMPUTED WHEN IT OPENS, and at no other time. There is no timer here and
// nothing arms it from the flush path. The recorded regression is a
// full-manuscript scan after every flush that cost a measurable frame tail while
// every scalar gate stayed green, and a panel nobody is looking at is the
// cheapest possible place to pay for a measurement.
import { t } from "./i18n";
import { createHelpTip, type HelpTip } from "./help-tip";
import { createPanelShell } from "./panel-shell";
import type { TimeTracking } from "./writing-time";
import {
  computeStatistics,
  statisticRows,
  STATISTICS_EMPTY,
  STATISTICS_NOTE,
  type SessionTotals,
  type StatGroup,
  type TodayFigures,
} from "./statistics";
import type { DocumentStatisticsCounts } from "./outline-counts";
import type { StatisticsFileKind } from "./statistics-export";
import type { ProjectItem } from "./store/source";

export interface StatisticsPanelDeps {
  readonly container: HTMLElement;
  /** Settle pending edits before anything is measured. Every figure here is "as
   *  saved", and a writer who has just typed a paragraph and opens this to see
   *  it counted is asking about the paragraph. The same reason the history panel
   *  and the export command drain. */
  drain(): Promise<void>;
  /** The LIVE walk, never a boot snapshot: a scene created a moment ago exists
   *  there and nowhere else. */
  items(): readonly ProjectItem[];
  /** The host's per-document statistics projection, paid once per open. */
  documentCounts(): Promise<DocumentStatisticsCounts>;
  openItemId(): string | null;
  session(): SessionTotals;
  /** What the host holds about today. Read on every open, like the counts. */
  today(): Promise<TodayFigures>;
  /** The off switch for the one figure here that measures the WRITER rather
   *  than the manuscript. Persists, then the panel re-reads. */
  setTracking(tracking: TimeTracking): Promise<void>;
  /** Pause or resume measuring saved words. The caller settles pending saves
   *  and locks the editor around the host call; a rejection is shown here. */
  setCollecting(collecting: boolean): Promise<void>;
  /** Start the saved-word measurement over. Same contract as setCollecting. */
  resetSources(): Promise<void>;
  /** The figures as a file, through the OS save dialog (moved here from
   *  the File menu, beside what it writes). Absent where there is no host. */
  exportFile?(kind: StatisticsFileKind): void;
  onDismiss(): void;
}

export interface StatisticsPanel {
  open(): Promise<void>;
  isOpen(): boolean;
  destroy(): void;
}

/** What is on screen while the counts are being read.
 *
 *  Distinct from the empty state and from the failure, because they are three
 *  different things and a reader acts differently on each. The recorded defect
 *  is a `catch` that painted the designed empty state and so reported a
 *  directory it could not read as one holding nothing. */
const LOADING = t("stats.panel.loading");
const FAILED = t("stats.panel.failed");

export function createStatisticsPanel(deps: StatisticsPanelDeps): StatisticsPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "stats-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert, so claiming modal
  // would be a lie a screen reader acts on.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "statistics");
  // So `open()` can put focus somewhere Escape is heard from. Escape only fires
  // while focus is inside the panel, and the recorded failure of the fifth panel
  // is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;

  const status = document.createElement("div");
  status.id = "stats-status";
  status.setAttribute("role", "status");
  status.textContent = LOADING;

  const groups = document.createElement("div");
  groups.id = "stats-groups";

  // The shared rule, once, at the bottom. Scope, exclusions, timezone and the
  // word rule's version - what spec section 11 asks a metric to expose and the
  // part of it that would otherwise be repeated fifteen times.
  const note = document.createElement("div");
  note.id = "stats-note";
  note.textContent = STATISTICS_NOTE;

  // THE OFF SWITCH, beside the figure it switches off and nowhere else. A
  // measurement of the writer ships with a way to stop it, or it does not
  // ship; putting the switch in Preferences would put it a panel away from
  // the number a writer is looking at when they decide.
  const tracking = document.createElement("button");
  tracking.id = "stats-tracking";
  tracking.type = "button";
  tracking.dataset.weight = "quiet";
  tracking.hidden = true;

  // The saved-word controls. Hidden until a reading that carries source
  // figures lands, and hidden again at the start of every reading, so a
  // control never describes a state the panel is no longer showing.
  const sourceControls = document.createElement("div");
  sourceControls.id = "stats-sources-controls";
  sourceControls.hidden = true;
  const collect = document.createElement("button");
  collect.id = "stats-sources-collect";
  collect.type = "button";
  collect.dataset.weight = "quiet";
  const reset = document.createElement("button");
  reset.id = "stats-sources-reset";
  reset.type = "button";
  reset.dataset.weight = "quiet";
  // ARMING AND ACTING ARE TWO BUTTONS. `reset` only arms and cancels, so a
  // double-click or a held Enter on it toggles and never deletes; the one
  // control that acts appears beside the text saying what goes and what stays.
  const resetConfirm = document.createElement("div");
  resetConfirm.id = "stats-sources-reset-confirm-group";
  resetConfirm.hidden = true;
  const resetNote = document.createElement("div");
  resetNote.id = "stats-sources-reset-note";
  resetNote.textContent = t("stats.sources.reset.note");
  const confirm = document.createElement("button");
  confirm.id = "stats-sources-reset-confirm";
  confirm.type = "button";
  confirm.dataset.weight = "quiet";
  confirm.textContent = t("stats.sources.reset.confirm");
  confirm.setAttribute("aria-describedby", resetNote.id);
  resetConfirm.append(resetNote, confirm);
  const sourceError = document.createElement("div");
  sourceError.id = "stats-sources-error";
  sourceError.setAttribute("role", "alert");
  sourceError.hidden = true;
  sourceControls.append(collect, reset, resetConfirm);

  panel.append(status, groups, sourceControls, sourceError, tracking, note);
  container.append(panel);

  let destroyed = false;
  /** A read that resolves after a newer one, or after the panel closed, must not
   *  repaint: the reader would be shown figures for a manuscript that has since
   *  changed under them. */
  let generation = 0;

  let collecting = true;
  let armed = false;
  let running = false;

  function disarm(): void {
    armed = false;
    reset.textContent = t("stats.sources.reset");
    reset.setAttribute("aria-expanded", "false");
    resetConfirm.hidden = true;
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    if (!open) disarm();
  }

  /** The help marks of the rows on screen, released on every repaint. */
  let tips: HelpTip[] = [];

  function paint(groupList: readonly StatGroup[]): void {
    for (const tip of tips) tip.destroy();
    tips = [];
    const built: HTMLElement[] = [];
    for (const group of groupList) {
      const section = document.createElement("div");
      section.className = "stat-group";

      const title = document.createElement("div");
      title.className = "stat-group-heading";
      title.textContent = group.heading;
      section.append(title);

      for (const row of group.rows) {
        const el = document.createElement("div");
        el.className = "stat-row";
        el.dataset.stat = row.key;

        const line = document.createElement("div");
        line.className = "stat-line";

        const label = document.createElement("span");
        label.className = "stat-label";
        label.textContent = row.label;

        const value = document.createElement("span");
        value.className = "stat-value";
        value.textContent = row.value;

        // THE DEFINITION IS ONE QUESTION MARK AWAY, not printed under
        // every figure: "it crowds the page with no
        // purpose". It is the help mark's tooltip on hover and focus and its
        // accessible description, so it is kept, not deleted, and a figure
        // can still be checked against its rule without leaving the panel.
        const help = createHelpTip({ label: row.label, definition: row.definition, id: `stats-help-${row.key}` });
        tips.push(help);
        const name = document.createElement("span");
        name.className = "stat-name";
        name.append(label, help.anchor);

        line.append(name, value);
        el.append(line);

        if (row.detail !== null) {
          const detail = document.createElement("div");
          detail.className = "stat-detail";
          detail.textContent = row.detail;
          el.append(detail);
        }

        el.setAttribute("aria-label", t("stats.panel.row.label", {
            label: row.label,
            value: row.value,
          }));
        section.append(el);
      }
      built.push(section);
    }
    groups.replaceChildren(...built);
  }

  async function refresh(): Promise<void> {
    generation += 1;
    const mine = generation;
    status.textContent = LOADING;
    groups.replaceChildren();
    sourceControls.hidden = true;
    disarm();
    let perDoc: DocumentStatisticsCounts;
    let today: TodayFigures;
    try {
      await deps.drain();
      perDoc = await deps.documentCounts();
      today = await deps.today();
    } catch {
      if (destroyed || mine !== generation) return;
      // NOT the empty state, and not a table of zeros. Both would be a claim
      // about the manuscript; this is a statement about the reading.
      status.textContent = FAILED;
      return;
    }
    if (destroyed || mine !== generation) return;

    const stats = computeStatistics({
      items: deps.items(),
      perDoc,
      openItemId: deps.openItemId(),
      session: deps.session(),
      today,
    });
    if (stats.structure.scenes === 0) {
      status.textContent = STATISTICS_EMPTY;
      return;
    }
    status.textContent = "";
    paint(statisticRows(stats));
    current = today.tracking;
    tracking.textContent = current === "on" ? t("stats.tracking.stop") : t("stats.tracking.start");
    tracking.hidden = false;
    if (today.sources !== undefined) {
      collecting = today.sources.collecting;
      collect.textContent = collecting ? t("stats.sources.pause") : t("stats.sources.resume");
      sourceControls.hidden = false;
    }
  }

  /** The repaint hides the controls while it reads, which drops focus to the
   *  body, where Escape no longer reaches the panel. Put it back on the
   *  control that stands where the pressed one did, or on the panel. */
  function shown(el: Element | null): boolean {
    if (el === null || !panel.contains(el)) return false;
    for (let node: Element | null = el; node !== null && node !== panel; node = node.parentElement) {
      if ((node as HTMLElement).hidden) return false;
    }
    return true;
  }

  function refocus(target: HTMLElement): void {
    if (destroyed || panel.hidden || shown(document.activeElement)) return;
    if (shown(target)) target.focus();
    else panel.focus();
  }

  async function runSources(command: () => Promise<void>, back: HTMLElement): Promise<void> {
    if (running) return;
    running = true;
    collect.disabled = true;
    reset.disabled = true;
    confirm.disabled = true;
    sourceError.hidden = true;
    try {
      await command();
    } catch (error) {
      sourceError.textContent = t("stats.sources.error", {
        error: error instanceof Error ? error.message : String(error),
      });
      sourceError.hidden = false;
    } finally {
      running = false;
      collect.disabled = false;
      reset.disabled = false;
      confirm.disabled = false;
    }
    // Re-read either way: the host's state is the answer, not the click.
    if (destroyed) return;
    await refresh();
    refocus(back);
  }

  const onCollect = (): void => {
    disarm();
    void runSources(() => deps.setCollecting(!collecting), collect);
  };
  const onReset = (): void => {
    if (armed) {
      disarm();
      return;
    }
    armed = true;
    reset.textContent = t("stats.sources.reset.cancel");
    reset.setAttribute("aria-expanded", "true");
    resetConfirm.hidden = false;
  };
  const onConfirm = (): void => {
    if (!armed) return;
    disarm();
    void runSources(() => deps.resetSources(), reset);
  };
  collect.addEventListener("click", onCollect);
  reset.addEventListener("click", onReset);
  confirm.addEventListener("click", onConfirm);

  let current: TimeTracking = "on";
  let switching = false;
  async function onTracking(): Promise<void> {
    if (switching) return;
    switching = true;
    try {
      await deps.setTracking(current === "on" ? "off" : "on");
    } catch {
      // The switch failed to persist; the panel re-reads and shows what the
      // host actually holds, which is the honest answer either way.
    } finally {
      switching = false;
    }
    if (!destroyed) await refresh();
  }
  tracking.addEventListener("click", () => void onTracking());

  // Close, Escape and a click elsewhere (the shell's); the title keeps the
  // heading's id.
  const shell = createPanelShell({
    panel,
    title: t("stats.panel.heading"),
    titleId: "stats-heading",
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
    inspector: true,
    footer: deps.exportFile !== undefined,
  });

  // The two files, as the footer's actions. Two buttons rather than one with
  // a format choice inside: the host learns only the path the writer picked,
  // never a dialog filter, so the format is decided by which one was pressed.
  const exports: HTMLButtonElement[] = [];
  const onExport = (event: Event): void => {
    const kind = (event.currentTarget as HTMLElement).dataset.statsExport;
    if (kind === "csv" || kind === "json") deps.exportFile?.(kind);
  };
  for (const kind of ["csv", "json"] as const) {
    if (shell.footer === null) break;
    const control = document.createElement("button");
    control.type = "button";
    control.id = `stats-export-${kind}`;
    control.dataset.statsExport = kind;
    control.textContent = t(`stats.export.${kind}`);
    control.addEventListener("click", onExport);
    shell.footer.append(control);
    exports.push(control);
  }

  return {
    async open(): Promise<void> {
      setOpen(true);
      sourceError.hidden = true;
      panel.focus();
      await refresh();
    },
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      destroyed = true;
      shell.destroy();
      for (const tip of tips) tip.destroy();
      collect.removeEventListener("click", onCollect);
      reset.removeEventListener("click", onReset);
      confirm.removeEventListener("click", onConfirm);
      for (const control of exports) control.removeEventListener("click", onExport);
      panel.remove();
    },
  };
}
