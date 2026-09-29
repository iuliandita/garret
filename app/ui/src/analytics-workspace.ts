import { formatNumber, formatShortDate, plural, t } from "./i18n";
import { createHelpTip } from "./help-tip";
import { HostCommandError } from "./command-error";
import type { LibraryBook, LibraryOverview } from "./library";
import { duplicateCopies, groupsOf, type LibraryScope } from "./library-summary";
import type { BookStats } from "./library-summary";
import { localDate } from "./goals";
import {
  SOURCES, emptyTotals, forecast, selectLibraryBooks, streak, summarize,
  type AdjustmentInput, type AnalyticsView, type Category, type CustomCategory, type Report, type Segment, type Totals,
} from "./analytics-metrics";

export interface AnalyticsWorkspaceDeps {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  drain(): Promise<void>;
  bookWords(): Promise<number>;
  openStatistics(): void;
  onDismiss(): void;
}

interface LibraryAnalyticsReport {
  book_id: string | null;
  identity_id: string | null;
  membership: { series: LibraryBook["series"]; universe: LibraryBook["universe"] };
  report: Report | null;
}

function matchesBook(book: LibraryBook, value: LibraryAnalyticsReport | BookStats): boolean {
  return value.book_id === book.book_id && value.identity_id === book.identity_id
    && JSON.stringify(value.membership.series) === JSON.stringify(book.series)
    && JSON.stringify(value.membership.universe) === JSON.stringify(book.universe);
}

export interface AnalyticsWorkspace { open(): Promise<void>; close(): void; destroy(): void }

const BUILTINS: Category[] = [
  { id: "drafting", name: "" }, { id: "revision", name: "" },
  { id: "planning", name: "" }, { id: "review", name: "" },
];

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", key?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (key) element.textContent = t(key);
  return element;
}

function button(key: string, id: string, run: () => void): HTMLButtonElement {
  const element = node("button", "analytics-button", key);
  element.type = "button";
  element.id = id;
  element.addEventListener("click", run);
  return element;
}

function label(key: string, control: HTMLElement): HTMLLabelElement {
  const element = node("label", "analytics-label");
  element.append(node("span", "", key), control);
  return element;
}

/** A checkbox BEFORE its words, the order every platform draws (239). */
function check(key: string, control: HTMLInputElement): HTMLLabelElement {
  const element = node("label", "analytics-check");
  element.append(control, node("span", "", key));
  return element;
}

/** A heading with the help mark that holds what used to be a paragraph of
 *  method above the controls (239). The text is the mark's tooltip and its
 *  accessible description; it is moved, not deleted. */
function heading(key: string, id: string, definition?: string): HTMLHeadingElement {
  const element = node("h3", "", key);
  if (definition !== undefined) {
    element.append(createHelpTip({ label: t(key), definition, id: `analytics-help-${id}` }).anchor);
  }
  return element;
}

/** A stored local day ("2026-09-25") as the writer's own short date. */
function dayLabel(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || [y, m, d].some((n) => !Number.isInteger(n))) return value;
  return formatShortDate(new Date(y, m - 1, d).getTime());
}

function categoryName(category: Category, customs: readonly CustomCategory[]): string {
  if (BUILTINS.some((builtIn) => builtIn.id === category.id)) return t(`analytics.category.${category.id}`);
  const folded = category.name.trim().toLowerCase();
  const duplicates = customs.filter((entry) => entry.category.name.trim().toLowerCase() === folded)
    .sort((a, b) => a.category.id.localeCompare(b.category.id));
  const number = duplicates.findIndex((entry) => entry.category.id === category.id) + 1;
  const retired = customs.some((entry) => entry.category.id === category.id && entry.retired);
  const numbered = number > 0 && duplicates.length > 1;
  const key = retired ? (numbered ? "analytics.category.retiredDuplicate" : "analytics.category.retiredNamed")
    : (numbered ? "analytics.category.namedDuplicate" : "analytics.category.named");
  return t(key, { name: category.name.trim(), number });
}

function categorySelect(categories: readonly Category[], selected: string | null, customs: readonly CustomCategory[]): HTMLSelectElement {
  const select = node("select");
  for (const category of categories) {
    const option = node("option");
    option.value = category.id;
    option.textContent = categoryName(category, customs);
    option.selected = category.id === selected;
    select.append(option);
  }
  return select;
}

function numeric(value: number | null, id: string): HTMLInputElement {
  const input = node("input");
  input.type = "number";
  input.min = "0";
  input.max = "9007199254740991";
  input.step = "1";
  input.id = id;
  input.value = value === null ? "" : String(value);
  return input;
}

function readNumber(input: HTMLInputElement, max = 9_007_199_254_740_991): number | null {
  if (input.value.trim() === "") return null;
  const value = Number(input.value);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(t("analytics.error.number"));
  return value;
}

function net(totals: Totals): number {
  return SOURCES.reduce((count, source) => count + totals[source].added - totals[source].deleted, 0);
}

export function createAnalyticsWorkspace(deps: AnalyticsWorkspaceDeps): AnalyticsWorkspace {
  const root = node("section", "analytics-workspace");
  root.id = "analytics-workspace";
  root.hidden = true;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", t("analytics.title"));
  const header = node("header", "analytics-header");
  const title = node("h2", "", "analytics.title");
  const closeButton = button("analytics.close", "analytics-close", () => close());
  header.append(title, closeButton);
  const status = node("p", "analytics-status");
  status.id = "analytics-status";
  status.setAttribute("role", "status");
  const content = node("div", "analytics-content");
  root.append(header, status, content);
  document.body.append(root);

  let destroyed = false;
  let request = 0;
  let view: AnalyticsView | null = null;
  let library: LibraryOverview | null = null;
  let libraryReports: Report[] = [];
  let librarySessionUnknown = 0;
  let libraryStatsUnknown = 0;
  let representatives = new Map<string, string>();
  let scope: "book" | "library" = "book";
  let scopeFilter: LibraryScope = { identity: null, series: null, universe: null };
  let categoryFilter: string | null = null;
  let from = "";
  let through = "";
  let bookWords = 0;
  let libraryWords = 0;
  let libraryUnreadable = 0;

  const currentArgs = (): Record<string, unknown> => {
    if (view === null) throw new Error(t("analytics.error.closed"));
    return { generation: view.generation, sessionId: view.session_id };
  };
  const say = (message: string, failure = false): void => {
    status.textContent = message;
    status.setAttribute("role", failure ? "alert" : "status");
  };
  async function mutate(command: string, args: Record<string, unknown>, focusId?: string): Promise<void> {
    if (destroyed || root.hidden || view === null) return;
    const epoch = request;
    const boundary = currentArgs();
    const active = (): boolean => !destroyed && !root.hidden && request === epoch;
    try {
      await deps.drain();
      if (!active()) return;
      await deps.invoke(command, { ...boundary, ...args });
      if (!active()) return;
      const reloadEpoch = request + 1;
      await reload();
      if (!destroyed && !root.hidden && request === reloadEpoch && focusId) document.getElementById(focusId)?.focus();
    } catch (error) {
      if (!active()) return;
      const message = command === "analytics_custom_add" && error instanceof HostCommandError
        && error.detail === "analytics_category_name_taken"
        ? t("analytics.category.duplicate") : t("analytics.error.action", { error: String(error) });
      say(message, true);
    }
  }

  function paintCorrection(segment: Segment, host: HTMLElement): void {
    const correction = segment.adjustment;
    const form = node("div", "analytics-correction-form");
    const category = categorySelect([...BUILTINS, ...(view?.custom_categories.filter((entry) => !entry.retired || entry.category.id === correction?.category?.id).map((entry) => entry.category) ?? [])],
      correction?.category?.id ?? segment.category.id, view?.custom_categories ?? []);
    const minutes = numeric(correction?.minutes ?? null, `analytics-minutes-${segment.id}`);
    minutes.max = "1000000";
    const excluded = node("input");
    excluded.type = "checkbox";
    excluded.checked = correction?.excluded ?? false;
    const reason = node("input");
    reason.type = "text";
    reason.maxLength = 500;
    reason.value = correction?.reason ?? "";
    form.append(label("analytics.correction.category", category), label("analytics.correction.minutes", minutes),
      check("analytics.correction.exclude", excluded), label("analytics.correction.reason", reason));
    const wordGrid = node("div", "analytics-correction-words");
    const observedTotals = emptyTotals();
    for (const movement of segment.movements) {
      observedTotals[movement.source].added += movement.added;
      observedTotals[movement.source].deleted += movement.deleted;
    }
    const inputs = new Map<string, [HTMLInputElement, HTMLInputElement]>();
    for (const source of SOURCES) {
      const added = numeric(correction?.source_totals?.[source].added ?? null, `analytics-added-${source}-${segment.id}`);
      const deleted = numeric(correction?.source_totals?.[source].deleted ?? null, `analytics-deleted-${source}-${segment.id}`);
      inputs.set(source, [added, deleted]);
      wordGrid.append(label(`analytics.source.${source}`, added), label("analytics.deleted", deleted));
    }
    form.append(node("p", "", "analytics.correction.words"), wordGrid);
    form.append(button("analytics.save", `analytics-correction-save-${segment.id}`, () => {
      try {
        const totals = emptyTotals();
        let any = false;
        for (const source of SOURCES) {
          const [added, deleted] = inputs.get(source)!;
          const a = readNumber(added);
          const d = readNumber(deleted);
          if (a !== null || d !== null) any = true;
          totals[source] = { added: a ?? observedTotals[source].added, deleted: d ?? observedTotals[source].deleted };
        }
        const chosen = [...BUILTINS, ...(view?.custom_categories.map((entry) => entry.category) ?? [])].find((entry) => entry.id === category.value);
        if (chosen === undefined) throw new Error(t("analytics.error.category"));
        const adjustment: AdjustmentInput = { category: chosen.id === segment.category.id ? null : chosen,
          minutes: readNumber(minutes, 1_000_000), source_totals: any ? totals : null,
          excluded: excluded.checked, reason: reason.value.trim() || null };
        void mutate("analytics_adjust", { segmentId: segment.id, adjustment }, `analytics-correction-${segment.id}`);
      } catch (error) { say(String(error), true); }
    }));
    form.append(button("analytics.revert", `analytics-correction-revert-${segment.id}`, () =>
      void mutate("analytics_adjust", { segmentId: segment.id,
        adjustment: { category: null, minutes: null, source_totals: null, excluded: false, reason: null } }, `analytics-correction-${segment.id}`)));
    host.append(form);
  }

  function paint(): void {
    if (view === null || root.hidden) return;
    const focusId = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
    content.replaceChildren();
    const report = view.report;
    const recording = node("section", "analytics-controls");
    recording.append(heading("analytics.recording", "recording", [t("analytics.coverage"), t("analytics.archive")].join(" ")));
    recording.append(node("p", "", report.recording_enabled ? "analytics.recording.on" : "analytics.recording.off"));
    if (report.recording_enabled && !view.tracking_on) recording.append(node("p", "analytics-muted", "analytics.recording.timeOff"));
    const availableCategories = [...BUILTINS, ...view.custom_categories.filter((entry) => !entry.retired).map((entry) => entry.category)];
    const selected = categorySelect(availableCategories, view.selected_category?.id ?? "drafting", view.custom_categories);
    selected.id = "analytics-category-select";
    recording.append(label("analytics.category", selected));
    recording.append(button(report.recording_enabled ? (view.session_id === null ? "analytics.recording.resume" : "analytics.recording.disable") : "analytics.recording.enable", "analytics-record-toggle", () => {
      const chosen = availableCategories.find((entry) => entry.id === selected.value);
      if (chosen) void mutate("analytics_set_recording", { enabled: !report.recording_enabled || view?.session_id === null, category: chosen }, "analytics-record-toggle");
    }));
    if (report.recording_enabled && view.session_id !== null) selected.addEventListener("change", () => {
      const chosen = availableCategories.find((entry) => entry.id === selected.value);
      if (chosen) void mutate("analytics_set_category", { category: chosen }, "analytics-category-select");
    });
    const custom = node("input");
    custom.id = "analytics-custom-name";
    custom.type = "text";
    custom.maxLength = 80;
    recording.append(label("analytics.category.custom", custom));
    recording.append(node("p", "analytics-muted", "analytics.category.namingRule"));
    recording.append(button("analytics.category.add", "analytics-custom-add", () => {
      const name = custom.value.trim();
      if (!name) return;
      if (view?.custom_categories.some((entry) => !entry.retired && entry.category.name.trim().toLowerCase() === name.toLowerCase())) {
        say(t("analytics.category.duplicate"), true);
        custom.focus();
        return;
      }
      void mutate("analytics_custom_add", { name }, "analytics-custom-name");
    }));
    const retire = button("analytics.category.retire", "analytics-custom-retire", () =>
      void mutate("analytics_custom_retire", { id: selected.value }, "analytics-category-select"));
    retire.disabled = BUILTINS.some((entry) => entry.id === selected.value) || view.selected_category?.id === selected.value;
    selected.addEventListener("change", () => { retire.disabled = BUILTINS.some((entry) => entry.id === selected.value) || view?.selected_category?.id === selected.value; });
    recording.append(retire);
    content.append(recording);

    const filters = node("section", "analytics-controls");
    filters.append(heading("analytics.filters", "filters", scope === "library" ? t("analytics.library.coverage") : undefined));
    const scopeSelect = node("select");
    for (const [value, key] of [["book", "analytics.scope.book"], ["library", "analytics.scope.library"]]) {
      const option = node("option", "", key); option.value = value; option.selected = value === scope; scopeSelect.append(option);
    }
    scopeSelect.id = "analytics-scope";
    scopeSelect.addEventListener("change", () => {
      scope = scopeSelect.value as "book" | "library";
      if (scope === "library" && categoryFilter !== null && !BUILTINS.some((entry) => entry.id === categoryFilter)) categoryFilter = null;
      void reload();
    });
    filters.append(label("analytics.scope", scopeSelect));
    const fromInput = node("input"); fromInput.type = "date"; fromInput.value = from; fromInput.id = "analytics-from";
    const throughInput = node("input"); throughInput.type = "date"; throughInput.value = through; throughInput.id = "analytics-through";
    fromInput.addEventListener("change", () => { from = fromInput.value; paint(); });
    throughInput.addEventListener("change", () => { through = throughInput.value; paint(); });
    filters.append(label("analytics.from", fromInput), label("analytics.through", throughInput));
    const categoryFilterSelect = node("select");
    categoryFilterSelect.id = "analytics-category-filter";
    const all = node("option", "", "analytics.category.all"); all.value = ""; categoryFilterSelect.append(all);
    const filterCategories = scope === "library" ? BUILTINS
      : [...availableCategories, ...view.custom_categories.filter((entry) => entry.retired).map((entry) => entry.category)];
    for (const category of filterCategories) { const option = node("option"); option.value = category.id; option.textContent = categoryName(category, view.custom_categories); categoryFilterSelect.append(option); }
    categoryFilterSelect.value = categoryFilter ?? "";
    categoryFilterSelect.addEventListener("change", () => { categoryFilter = categoryFilterSelect.value || null; paint(); });
    filters.append(label("analytics.category.filter", categoryFilterSelect));
    if (scope === "library" && library !== null) {
      const selector = (key: string, entries: readonly { id: string; name: string }[], current: string | null, change: (value: string | null) => void): void => {
        const select = node("select");
        const allOption = node("option", "", "analytics.scope.all"); allOption.value = ""; select.append(allOption);
        for (const entry of entries) { const option = node("option"); option.value = entry.id; option.textContent = entry.name; select.append(option); }
        select.value = current ?? "";
        select.addEventListener("change", () => { change(select.value || null); void reload(); });
        filters.append(label(key, select));
      };
      selector("analytics.identity", library.identities, scopeFilter.identity, (value) => { scopeFilter.identity = value; });
      selector("analytics.series", groupsOf(library.books, "series").map((entry) => ({ id: entry.id, name: entry.labels.join(" / ") })), scopeFilter.series, (value) => { scopeFilter.series = value; });
      selector("analytics.universe", groupsOf(library.books, "universe").map((entry) => ({ id: entry.id, name: entry.labels.join(" / ") })), scopeFilter.universe, (value) => { scopeFilter.universe = value; });
      const chosen = selectLibraryBooks(library.books, scopeFilter, representatives, library.more);
      for (const copies of duplicateCopies(library.books).values()) {
        const select = node("select");
        const prompt = node("option", "", "analytics.duplicate.skip"); prompt.value = ""; select.append(prompt);
        for (const copy of copies) { const option = node("option"); option.value = copy.path; option.textContent = copy.name; select.append(option); }
        select.value = representatives.get(copies[0].book_id!) ?? "";
        select.addEventListener("change", () => { if (select.value) representatives.set(copies[0].book_id!, select.value); else representatives.delete(copies[0].book_id!); void reload(); });
        filters.append(label("analytics.duplicate.choose", select));
      }
      // NON-ZERO PARTS ONLY (239): a line listing four zeros says nothing.
      const missing = [
        ["analytics.library.unknown.books", chosen.unknown],
        ["analytics.library.unknown.sessions", librarySessionUnknown],
        ["analytics.library.unknown.words", libraryStatsUnknown],
        ["analytics.library.unknown.copies", chosen.unresolvedCopies.length],
      ] as const;
      for (const [key, count] of missing) {
        if (count === 0) continue;
        const line = node("p", "analytics-muted");
        line.textContent = plural(key, count, { count: formatNumber(count) });
        filters.append(line);
      }
    }
    content.append(filters);

    const reports = scope === "book" ? [report] : libraryReports;
    const moreSessions = reports.reduce((total, entry) => total + entry.more_sessions, 0);
    const summary = summarize(reports, { from, through }, categoryFilter, view.session_id);
    const metrics = node("section", "analytics-metrics");
    metrics.append(heading("analytics.summary", "summary", t("analytics.summary.definition", { version: report.metric_version })));
    const coverage = node("p", "analytics-muted");
    coverage.textContent = summary.coverageStart === null ? t("analytics.no-history")
      : t("analytics.since", { date: dayLabel(summary.coverageStart) });
    metrics.append(coverage);
    const figures = node("div", "analytics-figures");
    const figure = (key: string, value: number, definition?: string): void => {
      const el = node("div", "analytics-figure");
      const name = node("span", "", key);
      if (definition !== undefined) name.append(createHelpTip({ label: t(key), definition, id: `analytics-help-${key.split(".").pop()}` }).anchor);
      el.append(name);
      const strong = node("strong"); strong.textContent = formatNumber(value); el.append(strong); figures.append(el);
    };
    figure("analytics.minutes", summary.adjustedMinutes, t("analytics.definition"));
    figure("analytics.net", net(summary.adjusted));
    figure(scope === "book" ? "analytics.saved.book" : "analytics.saved.library", scope === "book" ? bookWords : libraryWords);
    figure("analytics.sessions", summary.sessions);
    const pace = summary.adjustedMinutes > 0 ? Math.round(net(summary.adjusted) / summary.adjustedMinutes) : 0;
    figure("analytics.pace", pace);
    metrics.append(figures);
    if (scope === "library" && libraryUnreadable > 0) {
      const unreadable = node("p", "analytics-muted");
      unreadable.textContent = plural("analytics.saved.unreadable", libraryUnreadable, { count: formatNumber(libraryUnreadable) });
      metrics.append(unreadable);
    }
    for (const [key, count] of [["analytics.gaps.sessions", summary.gaps],
      ["analytics.gaps.corrections", summary.undatedCorrections], ["analytics.gaps.more", moreSessions]] as const) {
      if (count === 0) continue;
      const gap = node("p", "analytics-muted");
      gap.textContent = plural(key, count, { count: formatNumber(count) });
      metrics.append(gap);
    }
    const table = node("table", "analytics-table");
    const head = node("tr");
    for (const key of ["analytics.source", "analytics.added", "analytics.deleted", "analytics.net", "analytics.observed"]) head.append(node("th", "", key));
    head.firstElementChild?.append(createHelpTip({ label: t("analytics.source"), definition: t("analytics.source.definition"), id: "analytics-help-source" }).anchor);
    table.append(head);
    for (const source of SOURCES) {
      const row = node("tr");
      const adjusted = summary.adjusted[source], observed = summary.observed[source];
      for (const value of [t(`analytics.source.${source}`), String(adjusted.added), String(adjusted.deleted), String(adjusted.added - adjusted.deleted), String(observed.added - observed.deleted)]) {
        const cell = node("td"); cell.textContent = value; row.append(cell);
      }
      table.append(row);
    }
    metrics.append(table);
    const daily = node("div", "analytics-days");
    daily.append(heading("analytics.daily", "daily", t("analytics.daily.definition")));
    for (const day of summary.days.slice(-60)) {
      const line = node("div", "analytics-day");
      const fill = node("span", "analytics-day-fill");
      fill.style.setProperty("--activity", String(Math.min(1, day.minutes / 8)));
      line.append(fill);
      const words = node("span"); words.textContent = plural("analytics.day", day.minutes, { date: dayLabel(day.day), count: formatNumber(day.minutes), net: formatNumber(day.typingNet) });
      line.append(words); daily.append(line);
    }
    metrics.append(daily);
    content.append(metrics);

    const structure = node("section", "analytics-metrics");
    structure.append(heading("analytics.structure", "structure", t("analytics.structure.definition")));
    const structuralFigures = node("div", "analytics-figures");
    const structureFigure = (key: string, value: number): void => {
      const el = node("div", "analytics-figure");
      el.append(node("span", "", key));
      const strong = node("strong"); strong.textContent = formatNumber(value); el.append(strong); structuralFigures.append(el);
    };
    for (const [key, value] of [["analytics.structure.parts", view.structure.parts], ["analytics.structure.chapters", view.structure.chapters],
      ["analytics.structure.scenes", view.structure.scenes], ["analytics.structure.passes", view.structure.revision_passes],
      ["analytics.structure.tasks.open", view.structure.tasks_open], ["analytics.structure.tasks.done", view.structure.tasks_done],
      ["analytics.structure.comments.open", view.structure.comments_open], ["analytics.structure.comments.resolved", view.structure.comments_resolved]] as const) {
      structureFigure(key, value);
    }
    structure.append(structuralFigures);
    const states = node("p", "analytics-muted");
    const marked = Object.values(view.structure.revision_states).reduce((total, count) => total + count, 0);
    states.textContent = plural("analytics.structure.states", marked, { count: formatNumber(marked) });
    structure.append(states);
    structure.append(button("analytics.structure.statistics", "analytics-open-statistics", () => { close(); deps.openStatistics(); }));
    content.append(structure);

    const motivation = node("section", "analytics-controls");
    motivation.append(node("h3", "", "analytics.motivation"));
    const display = node("input"); display.type = "checkbox"; display.checked = report.motivation_visible;
    const goal = numeric(report.forecast_goal_words, "analytics-goal");
    motivation.append(check("analytics.motivation.show", display), label("analytics.goal", goal));
    const saveMotivation = (): void => {
      try { void mutate("analytics_set_motivation", { visible: display.checked, goalWords: readNumber(goal) }, "analytics-goal"); }
      catch (error) { say(String(error), true); }
    };
    display.addEventListener("change", saveMotivation);
    goal.addEventListener("change", saveMotivation);
    if (report.motivation_visible) {
      const today = localDate(new Date());
      const baselineDay = report.motivation_since_ms === null ? null : localDate(new Date(report.motivation_since_ms));
      const motivationDays = baselineDay === null ? summary.days : summary.days.filter((day) => day.day >= baselineDay);
      const value = streak(motivationDays, today);
      const streakLine = node("p"); streakLine.textContent = t("analytics.streak", {
        current: plural("analytics.days", value.current, { count: formatNumber(value.current) }),
        longest: plural("analytics.days", value.longest, { count: formatNumber(value.longest) }) });
      motivation.append(streakLine);
      if (baselineDay !== null) {
        const baseline = node("p", "analytics-muted"); baseline.textContent = t("analytics.motivation.since", { date: dayLabel(baselineDay) }); motivation.append(baseline);
      }
      if (report.forecast_goal_words !== null && scope === "book") {
        const days = forecast(motivationDays, Math.max(0, report.forecast_goal_words - bookWords), today);
        const forecastLine = node("p");
        forecastLine.textContent = days === null ? t("analytics.forecast.unavailable") : plural("analytics.forecast", days, { count: formatNumber(days) });
        motivation.append(forecastLine);
      }
      motivation.append(button("analytics.motivation.reset", "analytics-motivation-reset", () =>
        void mutate("analytics_reset_motivation", {}, "analytics-motivation-reset")));
      const milestone = motivationDays.reduce((total, day) => total + day.minutes, 0);
      const reached = [1, 10, 60, 300].filter((threshold) => milestone >= threshold).at(-1);
      if (reached !== undefined) {
        const line = node("p"); line.textContent = plural("analytics.milestone", reached, { count: formatNumber(reached) }); motivation.append(line);
      }
    }
    content.append(motivation);

    const history = node("section", "analytics-history");
    history.append(heading("analytics.history", "history", t("analytics.spanDefinition")));
    for (const session of report.sessions) {
      const card = node("article", "analytics-session");
      const title = node("h4"); title.textContent = t("analytics.session", { date: dayLabel(session.start_day), id: session.id.slice(0, 8) });
      card.append(title);
      card.append(node("p", "analytics-muted", session.id === view.session_id ? "analytics.current" : session.ended_ms === null ? "analytics.unfinished" : "analytics.ended"));
      const excluded = session.segments.length > 0 && session.segments.every((segment) => segment.adjustment?.excluded);
      card.append(button(excluded ? "analytics.include" : "analytics.exclude", `analytics-session-${session.id}`, () =>
        void mutate("analytics_exclude_session", { targetId: session.id, excluded: !excluded }, `analytics-session-${session.id}`)));
      for (const segment of session.segments) {
        const row = node("div", "analytics-segment");
        const info = node("p");
        const minutes = segment.adjustment?.minutes ?? segment.minutes.length;
        info.textContent = plural("analytics.segment", minutes, { category: categoryName(segment.adjustment?.category ?? segment.category, view.custom_categories), count: formatNumber(minutes) });
        row.append(info);
        const edit = button("analytics.correct", `analytics-correction-${segment.id}`, () => {
          const open = row.querySelector<HTMLElement>(".analytics-correction-form");
          if (open) { open.remove(); return; }
          paintCorrection(segment, row);
        });
        row.append(edit);
        card.append(row);
      }
      history.append(card);
    }
    content.append(history);
    const actions = node("section", "analytics-controls");
    actions.append(button("analytics.export", "analytics-export", () => {
      if (destroyed || root.hidden || view === null) return;
      const epoch = request;
      const boundary = currentArgs();
      const active = (): boolean => !destroyed && !root.hidden && request === epoch;
      void (async () => {
        try {
          await deps.drain();
          if (!active()) return;
          const path = await deps.invoke("analytics_raw_export", boundary) as string;
          if (active()) say(t("analytics.export.done", { path }));
        } catch (error) { if (active()) say(t("analytics.error.action", { error: String(error) }), true); }
      })();
    }));
    const purgeNote = node("p", "analytics-muted", "analytics.purge.note");
    const purgeConfirm = button("analytics.purge.confirm", "analytics-purge-confirm", () => void mutate("analytics_purge", { confirm: true }, "analytics-record-toggle"));
    purgeNote.hidden = true; purgeConfirm.hidden = true;
    actions.append(button("analytics.purge", "analytics-purge", () => { purgeNote.hidden = !purgeNote.hidden; purgeConfirm.hidden = !purgeConfirm.hidden; }), purgeNote, purgeConfirm);
    content.append(actions);
    if (focusId) document.getElementById(focusId)?.focus();
  }

  async function reload(): Promise<void> {
    const token = ++request;
    say(t("analytics.loading"));
    try {
      await deps.drain();
      const answer = await deps.invoke("analytics_get") as AnalyticsView;
      const words = await deps.bookWords();
      let overview: LibraryOverview | null = null;
      let reports: Report[] = [];
      let sessionUnknown = 0;
      let statsUnknown = 0;
      let scopedWords = 0;
      let unreadable = 0;
      if (scope === "library") {
        overview = await deps.invoke("library_overview") as LibraryOverview;
        const selection = selectLibraryBooks(overview.books, scopeFilter, representatives, overview.more);
        for (const book of selection.books) {
          let stats: BookStats;
          try {
            stats = await deps.invoke("library_book_stats", { path: book.path, today: localDate(new Date()) }) as BookStats;
            if (token !== request || destroyed || root.hidden) return;
            if (!matchesBook(book, stats)) throw new Error("stale summary");
          } catch { statsUnknown++; sessionUnknown++; continue; }
          try {
            const fresh = await deps.invoke("analytics_book_report", { path: book.path }) as LibraryAnalyticsReport;
            if (token !== request || destroyed || root.hidden) return;
            if (!matchesBook(book, fresh)) { statsUnknown++; sessionUnknown++; continue; }
            scopedWords += stats.words;
            unreadable += stats.unreadable_documents;
            if (fresh.report === null) sessionUnknown++;
            else reports.push(fresh.report);
          } catch { statsUnknown++; sessionUnknown++; }
          if (token !== request || destroyed || root.hidden) return;
        }
      }
      if (token !== request || destroyed || root.hidden) return;
      view = answer; bookWords = words; library = overview; libraryReports = reports;
      librarySessionUnknown = sessionUnknown; libraryStatsUnknown = statsUnknown;
      libraryWords = scopedWords; libraryUnreadable = unreadable;
      say(t("analytics.ready"));
      paint();
    } catch (error) { if (token === request && !destroyed && !root.hidden) say(t("analytics.error.load", { error: String(error) }), true); }
  }

  function close(): void {
    if (root.hidden) return;
    request++;
    root.hidden = true;
    view = null;
    deps.onDismiss();
  }
  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!root.hidden && event.key === "Escape") { event.preventDefault(); close(); }
  };
  root.addEventListener("keydown", keydown);
  return {
    async open(): Promise<void> { if (destroyed) return; root.hidden = false; closeButton.focus(); await reload(); },
    close,
    destroy(): void { destroyed = true; request++; root.remove(); },
  };
}
