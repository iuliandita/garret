import { createRelationshipView } from "./relationship-view";
import { createHelpTip } from "./help-tip";
import { formatNumber, plural, t } from "./i18n";
import { liveItemsIn, manuscriptItemsIn } from "./outline";
import { createPanelShell } from "./panel-shell";
import { proseItem } from "./saved-prose";
import type { ProjectItem } from "./store/source";
import { craftReportCsv, createCraftReport, knowledgeConsistency, type CraftReport, type ReportFinding, type ReportOptions, type WatchTerm } from "./craft-report";

interface Endpoint { kind: string; id: string }
interface Resource { id: string; title: string; original_name: string; media_type: string; bytes: number; sha256: string;
  source_note: string; citation: string; removed_at: number | null; available: boolean }
interface Link { id: string; source: Endpoint; target: Endpoint; source_caption: string; target_caption: string;
  source_available: boolean; target_available: boolean; label: string; note: string; citation: string;
  anchor: { item_id: string; doc_rev: number; from: number; to: number; quote: string } | null; anchor_stale: boolean }
interface Cast { id: string; name: string; aliases: string[] }

/** What an imported copy stores when the writer names no file type: the
 *  host requires one, and "some bytes" is the honest default. */
const UNKNOWN_FILE_TYPE = "application/octet-stream";

/** A source note and its citation as one line: "Collected before the storm
 *  (Notebook, page 4)", or whichever of the two was filled in. */
function sourceLine(note: string, citation: string): string {
  const [n, c] = [note.trim(), citation.trim()];
  if (n !== "" && c !== "") return t("craft.source-line", { note: n, citation: c });
  return n || c;
}

/** A file's size in the units a writer reads on their own computer. */
function fileSize(bytes: number): string {
  if (bytes < 1000) return plural("craft.size.bytes", bytes, { count: formatNumber(bytes) });
  const kb = bytes / 1000;
  if (kb < 1000) return t("craft.size.kb", { size: formatNumber(Math.round(kb)) });
  return t("craft.size.mb", { size: formatNumber(Math.round(kb / 100) / 10) });
}

export interface CraftPanel {
  open(tab?: "knowledge" | "reports" | "relationships"): Promise<void>;
  sourceChanged(id: string): void;
  invalidateAll(): void;
  close(): void;
  destroy(): void;
}

export function createCraftPanel(deps: {
  container: HTMLElement;
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  generation: number;
  items(): readonly ProjectItem[];
  selectedId(): string | null;
  drain(): Promise<void>;
  failed(): boolean;
  anchor(): { item_id: string; from: number; to: number; quote: string } | null;
  openPassage(link: Link): Promise<boolean>;
  openFinding(finding: ReportFinding): Promise<boolean>;
  onNotice(message: string): void;
  onDismiss(): void;
}): CraftPanel {
  const doc = deps.container.ownerDocument;
  const panel = doc.createElement("section");
  panel.id = "craft-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("craft.heading"));
  panel.tabIndex = -1;
  panel.hidden = true;
  const status = doc.createElement("p"); status.id = "craft-status"; status.setAttribute("role", "status");
  const knowledge = doc.createElement("div"); knowledge.id = "craft-knowledge";
  const reports = doc.createElement("div"); reports.id = "craft-reports";
  const relationships = doc.createElement("div"); relationships.id = "craft-relationships";
  const relationshipView = createRelationshipView(relationships);
  const button = (key: string, run: () => void): HTMLButtonElement => {
    const control = doc.createElement("button"); control.type = "button"; control.textContent = t(key);
    control.addEventListener("click", run); return control;
  };
  const field = (key: string, tag: "input" | "textarea" = "input"): HTMLInputElement | HTMLTextAreaElement => {
    const label = doc.createElement("label"); label.textContent = t(key);
    const control = doc.createElement(tag); label.append(control); return control;
  };
  const select = (key: string, choices: readonly [string, string][]): HTMLSelectElement => {
    const label = doc.createElement("label"); label.textContent = t(key);
    const control = doc.createElement("select");
    for (const [value, labelKey] of choices) {
      const option = doc.createElement("option"); option.value = value; option.textContent = t(labelKey); control.append(option);
    }
    label.append(control); return control;
  };
  // A SEGMENTED CONTROL, not buttons dressed as tabs (238), and Close is the
  // shell's, never one of the views.
  const views = doc.createElement("div"); views.id = "craft-views"; views.className = "segmented";
  views.setAttribute("role", "group"); views.setAttribute("aria-label", t("craft.views"));
  const knowledgeTab = button("craft.knowledge", () => show("knowledge"));
  const reportsTab = button("craft.reports", () => show("reports"));
  const relationshipsTab = button("relationships.title", () => { show("relationships"); void refresh(); });
  views.append(knowledgeTab, reportsTab, relationshipsTab);
  panel.append(views, status, knowledge, reports, relationships);
  deps.container.append(panel);

  const search = field("craft.search"); search.id = "craft-search";
  // The limits are the heading's help (239), not a paragraph of MiB in front
  // of the list.
  const resourcesHead = doc.createElement("h3"); resourcesHead.textContent = t("craft.resources");
  resourcesHead.append(createHelpTip({ label: t("craft.resources"), definition: t("craft.resource-limits"), id: "craft-help-resources" }).anchor);
  const resourcesList = doc.createElement("div"); resourcesList.id = "craft-resources";
  const resourceTitle = field("craft.resource-title");
  const resourceType = field("craft.resource-type");
  const resourceNote = field("craft.source-note", "textarea");
  const resourceCitation = field("craft.citation", "textarea");
  const importFile = button("craft.import", () => { void importResource(); }); importFile.id = "craft-import-file";
  const linksHead = doc.createElement("h3"); linksHead.textContent = t("craft.links");
  const source = select("craft.link-from", []); const target = select("craft.link-to", []);
  const label = field("craft.link-label"); label.id = "craft-link-label";
  const note = field("craft.link-note", "textarea");
  const citation = field("craft.citation", "textarea");
  const anchorLabel = doc.createElement("label");
  const anchor = doc.createElement("input"); anchor.type = "checkbox";
  anchorLabel.append(anchor, doc.createTextNode(t("craft.anchor")));
  const addLink = button("craft.add-link", () => { void createLink(); }); addLink.id = "craft-add-link";
  const linksList = doc.createElement("div"); linksList.id = "craft-links";
  knowledge.append(search.parentElement!, resourcesHead, resourcesList, resourceTitle.parentElement!, resourceType.parentElement!,
    resourceNote.parentElement!, resourceCitation.parentElement!, importFile, linksHead,
    source.parentElement!, target.parentElement!, label.parentElement!, note.parentElement!, citation.parentElement!,
    anchorLabel, addLink, linksList);

  const scope = select("craft.scope", [["document", "craft.scope.document"], ["chapter", "craft.scope.chapter"], ["book", "craft.scope.book"]]);
  const language = select("craft.language", [["und", "craft.language.unknown"], ["en", "craft.language.english"], ["de", "craft.language.german"]]);
  const quotes = select("craft.quotes", [["curly_double", "craft.quotes.curly"], ["ascii_double", "craft.quotes.ascii"]]);
  const limitField = (key: string, value: number, max: number): HTMLInputElement => {
    const control = field(key) as HTMLInputElement;
    control.type = "number"; control.min = "1"; control.max = String(max); control.value = String(value);
    return control;
  };
  const documentLimit = limitField("craft.limit.documents", 20, 200);
  const wordLimit = limitField("craft.limit.words", 200_000, 200_000);
  const findingLimit = limitField("craft.limit.findings", 500, 500);
  const watchText = field("craft.watch-term"); watchText.id = "craft-watch-text";
  const watchMode = select("craft.watch-mode", [["literal", "craft.watch.literal"], ["folded", "craft.watch.folded"]]);
  const watchList = doc.createElement("div"); watchList.id = "craft-watchlist";
  // What the export does to a cell, beside the two exports rather than in a
  // paragraph under every report (239).
  const exports = doc.createElement("div"); exports.className = "craft-exports";
  const addWatch = button("craft.watch-add", () => { void addWatchTerm(); });
  const run = button("craft.run", () => { void runReport(); }); run.id = "craft-run-report";
  // The reports view's one primary (238): the reason the view exists.
  run.dataset.weight = "primary";
  const cancel = button("craft.cancel", () => { ++runGeneration; run.disabled = false; status.textContent = t("craft.canceled"); });
  const json = button("craft.export-json", () => { void exportReport("json"); });
  const csv = button("craft.export-csv", () => { void exportReport("csv"); });
  exports.append(json, csv, createHelpTip({ label: t("craft.export-csv"), definition: t("craft.def.csv_text"), id: "craft-help-csv" }).anchor);
  const reportBody = doc.createElement("div"); reportBody.id = "craft-report-body";
  reports.append(scope.parentElement!, language.parentElement!, quotes.parentElement!, documentLimit.parentElement!,
    wordLimit.parentElement!, findingLimit.parentElement!, watchText.parentElement!,
    watchMode.parentElement!, addWatch, watchList, run, cancel, exports, reportBody);

  let destroyed = false;
  let generation = 0;
  let lifecycle = 0;
  let runGeneration = 0;
  let watchPending = false;
  let resources: Resource[] = [];
  let links: Link[] = [];
  let casts: Cast[] = [];
  let watchlist: WatchTerm[] = [];
  let report: CraftReport | null = null;
  const changed = new Set<string>();

  function show(tab: "knowledge" | "reports" | "relationships"): void {
    knowledge.hidden = tab !== "knowledge"; reports.hidden = tab !== "reports"; relationships.hidden = tab !== "relationships";
    relationshipsTab.setAttribute("aria-pressed", String(tab === "relationships"));
    knowledgeTab.setAttribute("aria-pressed", String(tab === "knowledge"));
    reportsTab.setAttribute("aria-pressed", String(tab === "reports"));
  }
  const active = (ticket: number): boolean => !destroyed && !panel.hidden && ticket === lifecycle;
  const error = (value: unknown): void => { status.textContent = t("craft.error", { error: String(value) }); deps.onNotice(status.textContent); };
  const currentError = (value: unknown, ticket: number): void => { if (active(ticket)) error(value); };
  async function mutateAndRefresh(cmd: string, args: Record<string, unknown>, invalidates = true): Promise<void> {
    const ticket = lifecycle;
    try {
      await deps.invoke(cmd, { ...args, generation: deps.generation });
      if (!active(ticket)) return;
      if (invalidates) api.invalidateAll();
      await refresh();
    } catch (reason) { currentError(reason, ticket); }
  }
  function endpoint(value: string): Endpoint { const [kind, id] = value.split(":", 2); return { kind: kind ?? "", id: id ?? "" }; }
  function renderKnowledge(): void {
    const query = search.value.toLocaleLowerCase();
    resourcesList.replaceChildren(); linksList.replaceChildren();
    for (const resource of resources) {
      const text = [resource.title, resource.original_name, resource.media_type, resource.source_note, resource.citation].join(" ");
      if (query && !text.toLocaleLowerCase().includes(query)) continue;
      const row = doc.createElement("p");
      row.textContent = t("craft.resource-row", { title: resource.title, name: resource.original_name,
        size: fileSize(resource.bytes), state: resource.removed_at === null ?
          (resource.available ? t("craft.included") : t("craft.missing")) : t("craft.removed") });
      const source = sourceLine(resource.source_note, resource.citation);
      if (source !== "") {
        const line = doc.createElement("span"); line.className = "craft-row-detail"; line.textContent = source;
        row.append(line);
      }
      if (resource.removed_at === null) {
        row.append(button("craft.save-copy", () => { void mutateAndRefresh("research_save_copy", { id: resource.id }, false); }),
          button("craft.remove", () => { void mutateAndRefresh("research_remove", { id: resource.id }); }));
      } else {
        row.append(button("craft.restore", () => { void mutateAndRefresh("research_restore", { id: resource.id }); }));
      }
      resourcesList.append(row);
    }
    for (const link of links) {
      const text = [link.source_caption, link.target_caption, link.label, link.note, link.citation].join(" ");
      if (query && !text.toLocaleLowerCase().includes(query)) continue;
      const row = doc.createElement("p");
      row.textContent = t(link.label.trim() === "" ? "craft.link-row.plain" : "craft.link-row", {
        source: link.source_caption, target: link.target_caption, label: link.label });
      const extra = [sourceLine(link.note, link.citation),
        !link.source_available || !link.target_available ? t("craft.unavailable") : "",
        link.anchor_stale ? t("craft.anchor-stale") : ""].filter((part) => part.trim() !== "").join(" ");
      if (extra !== "") {
        const line = doc.createElement("span"); line.className = "craft-row-detail"; line.textContent = extra;
        row.append(line);
      }
      if (link.anchor !== null) {
        const quote = doc.createElement("span"); quote.className = "craft-saved-quote";
        quote.textContent = link.anchor.quote;
        row.append(quote, button("craft.open-passage", () => {
          const ticket = lifecycle;
          void deps.openPassage(link).then((opened) => {
            if (active(ticket) && !opened) status.textContent = t("craft.anchor-stale");
          }).catch((reason) => currentError(reason, ticket));
        }));
      }
      row.append(button("craft.remove", () => { void mutateAndRefresh("knowledge_link_remove", { id: link.id }); }));
      linksList.append(row);
    }
    const previousSource = source.value;
    const previousTarget = target.value;
    source.replaceChildren(); target.replaceChildren();
    const endpoints = [
      ...liveItemsIn(deps.items()).map((item) => ({ value: `item:${item.id}`, title: item.title })),
      ...casts.map((cast) => ({ value: `cast:${cast.id}`, title: cast.name })),
      ...resources.filter((resource) => resource.removed_at === null).map((resource) => ({ value: `resource:${resource.id}`, title: resource.title })),
    ];
    for (const point of endpoints) {
      for (const control of [source, target]) {
        const option = doc.createElement("option"); option.value = point.value; option.textContent = point.title; control.append(option);
      }
    }
    source.value = previousSource || ["item", deps.selectedId() ?? ""].join(":");
    target.value = previousTarget;
  }
  async function refresh(): Promise<void> {
    const request = ++generation;
    try {
      const [resourceRows, linkRows, castRows] = await Promise.all([
        deps.invoke("research_list"), deps.invoke("knowledge_links", { endpoint: null }), deps.invoke("cast_list"),
      ]);
      if (request !== generation || destroyed) return;
      resources = resourceRows as Resource[]; links = linkRows as Link[]; casts = castRows as Cast[];
      renderKnowledge();
      renderRelationships();
    } catch (reason) { if (request === generation && !destroyed) error(reason); }
  }
  function renderRelationships(): void {
    relationshipView.update([
        ...liveItemsIn(deps.items()).map((item) => ({ kind: "item", id: item.id, caption: item.title, available: true })),
        ...casts.map((cast) => ({ kind: "cast", id: cast.id, caption: cast.name, available: true })),
        ...resources.map((resource) => ({ kind: "resource", id: resource.id, caption: resource.title,
          available: resource.removed_at === null && resource.available })),
      ], links, { kind: "item", id: deps.selectedId() ?? "" });
  }
  search.addEventListener("input", renderKnowledge);
  async function importResource(): Promise<void> {
    const ticket = lifecycle;
    const args = { generation: deps.generation, title: resourceTitle.value, mediaType: resourceType.value.trim() || UNKNOWN_FILE_TYPE,
      sourceNote: resourceNote.value, citation: resourceCitation.value };
    importFile.disabled = true;
    try {
      const result = await deps.invoke("research_import_pick", args);
      if (active(ticket) && result !== null) { status.textContent = t("craft.imported"); api.invalidateAll(); await refresh(); }
    } catch (reason) { currentError(reason, ticket); } finally { importFile.disabled = false; }
  }
  async function createLink(): Promise<void> {
    const ticket = lifecycle;
    const draft = { source: endpoint(source.value), target: endpoint(target.value),
      label: label.value, note: note.value, citation: citation.value,
      anchor: anchor.checked ? deps.anchor() : null };
    addLink.disabled = true;
    try {
      let passage: Link["anchor"] = null;
      if (anchor.checked) {
        const selected = draft.anchor;
        if (selected === null) throw new Error(t("craft.no-passage"));
        await deps.drain();
        if (!active(ticket)) return;
        if (deps.failed()) throw new Error(t("craft.unsaved"));
        const saved = await deps.invoke("doc_load", { itemId: selected.item_id }) as { rev: number };
        if (!active(ticket)) return;
        passage = { ...selected, doc_rev: saved.rev };
      }
      if (!active(ticket)) return;
      await deps.invoke("knowledge_link_create", { generation: deps.generation, draft: { ...draft, anchor: passage } });
      if (active(ticket)) { status.textContent = t("craft.linked"); api.invalidateAll(); await refresh(); }
    } catch (reason) { currentError(reason, ticket); } finally { addLink.disabled = false; }
  }
  function renderWatch(): void {
    watchList.replaceChildren();
    for (const [index, term] of watchlist.entries()) {
      const row = doc.createElement("p"); row.textContent = t(term.mode === "folded" ? "craft.watch-row.folded" : "craft.watch-row.literal", { term: term.text });
      const remove = button("craft.remove", () => { void saveWatch(watchlist.filter((_, at) => at !== index)); });
      remove.disabled = watchPending;
      row.append(remove);
      watchList.append(row);
    }
  }
  async function saveWatch(next: WatchTerm[]): Promise<boolean> {
    if (watchPending) return false;
    const ticket = lifecycle;
    watchPending = true; addWatch.disabled = true; renderWatch();
    try {
      await deps.invoke("craft_watchlist_set", { generation: deps.generation, terms: next });
      if (!active(ticket)) return false;
      watchlist = next; api.invalidateAll();
      return true;
    } catch (reason) { currentError(reason, ticket); return false; }
    finally {
      watchPending = false; addWatch.disabled = false;
      if (!destroyed && !panel.hidden) renderWatch();
    }
  }
  async function addWatchTerm(): Promise<void> {
    const text = watchText.value.trim();
    if (!text) return;
    const saved = await saveWatch([...watchlist, { text, mode: watchMode.value as WatchTerm["mode"] }]);
    if (saved && watchText.value.trim() === text) watchText.value = "";
  }
  function sourcesFor(scopeValue: ReportOptions["scope"]): ProjectItem[] {
    const items = manuscriptItemsIn(deps.items()).filter((item) => proseItem(item.type));
    if (scopeValue === "book") return items;
    const selected = deps.selectedId();
    if (scopeValue === "document") return items.filter((item) => item.id === selected);
    const byId = new Map(deps.items().map((item) => [item.id, item]));
    let cursor = selected; let chapter: string | null = null;
    while (cursor !== null) {
      const item = byId.get(cursor); if (!item) break;
      if (item.type === "chapter") { chapter = item.id; break; }
      cursor = item.parent_id;
    }
    if (chapter === null) return [];
    return items.filter((item) => {
      let parent: string | null = item.id;
      while (parent !== null) { if (parent === chapter) return true; parent = byId.get(parent)?.parent_id ?? null; }
      return false;
    });
  }
  function renderReport(): void {
    reportBody.replaceChildren();
    if (report === null) return;
    const summary = doc.createElement("p");
    summary.textContent = t("craft.coverage", {
      documents: plural("craft.count.documents", report.coverage.documents, { count: formatNumber(report.coverage.documents) }),
      words: plural("craft.count.words", report.coverage.words, { count: formatNumber(report.coverage.words) }),
      findings: plural("craft.count.findings", report.findings.length, { count: formatNumber(report.findings.length) }),
    });
    if (report.coverage.truncated_by !== null) summary.append(" ", t(`craft.truncated.${report.coverage.truncated_by}`));
    reportBody.append(summary);
    // THE FIGURES, EACH WITH ITS RULE ONE QUESTION MARK AWAY (239): the six
    // definitions used to run together as one paragraph under the summary.
    const metrics = doc.createElement("dl"); metrics.className = "craft-metrics";
    const metric = (key: string, value: string, definition?: string): void => {
      const term = doc.createElement("dt"); term.textContent = t(key);
      if (definition !== undefined) term.append(createHelpTip({ label: t(key), definition, id: `craft-help-${key.split(".").pop()}` }).anchor);
      const figure = doc.createElement("dd"); figure.textContent = value;
      metrics.append(term, figure);
    };
    metric("craft.metric.paragraphs", formatNumber(report.metrics.paragraph_words.length));
    metric("craft.metric.sentences", formatNumber(report.metrics.sentence_words.length), t("craft.def.sentences"));
    metric("craft.metric.dialogue", formatNumber(report.metrics.dialogue_words), t("craft.def.dialogue"));
    metric("craft.metric.unmatched", formatNumber(report.metrics.unmatched_quotes));
    metric("craft.metric.readability", report.metrics.english_readability === null ? t("craft.unavailable")
      : String(report.metrics.english_readability), t("craft.def.readability"));
    reportBody.append(metrics);
    if (report.findings.length > 0) {
      const findingsHead = doc.createElement("h3"); findingsHead.textContent = t("craft.findings");
      findingsHead.append(createHelpTip({ label: t("craft.findings"), id: "craft-help-findings",
        definition: [t("craft.def.tokens"), t("craft.def.repeated_phrase")].join(" ") }).anchor);
      reportBody.append(findingsHead);
    }
    for (const finding of report.findings) {
      const row = doc.createElement("button"); row.type = "button"; row.className = "craft-finding";
      row.textContent = t("craft.finding-row", { kind: t(`craft.finding.${finding.kind}`),
        class: finding.class === "structural" ? t("craft.structural") : t("craft.suggestion"),
        excerpt: finding.excerpt });
      if (changed.has(finding.item_id)) row.append(" ", t("craft.stale"));
      row.addEventListener("click", () => {
        if (changed.has(finding.item_id)) { status.textContent = t("craft.stale"); return; }
        const ticket = lifecycle;
        void deps.openFinding(finding).then((opened) => { if (active(ticket) && !opened) status.textContent = t("craft.stale"); })
          .catch((reason) => currentError(reason, ticket));
      });
      reportBody.append(row);
    }
    for (const finding of report.knowledge) {
      const row = doc.createElement("p");
      row.textContent = t("craft.knowledge-row", { kind: t(`craft.consistency.${finding.kind}`),
        class: finding.class === "structural" ? t("craft.structural") : t("craft.suggestion"),
        caption: finding.caption, detail: finding.detail });
      reportBody.append(row);
    }
  }
  async function runReport(): Promise<void> {
    const ticket = ++runGeneration;
    run.disabled = true;
    report = null; changed.clear(); renderReport();
    try {
      await deps.drain();
      if (deps.failed()) throw new Error(t("craft.unsaved"));
      if (ticket !== runGeneration || destroyed) return;
      changed.clear();
      const scopeValue = scope.value as ReportOptions["scope"];
      const options: ReportOptions = { scope: scopeValue, language: language.value,
        quote_convention: quotes.value as ReportOptions["quote_convention"], watchlist,
        max_documents: Number(documentLimit.value), max_words: Number(wordLimit.value), max_findings: Number(findingLimit.value) };
      const analyzer = createCraftReport(options);
      const sources = sourcesFor(scopeValue);
      if (sources.length === 0) throw new Error(t("craft.no-sources"));
      for (const item of sources) {
        if (ticket !== runGeneration || destroyed) return;
        status.textContent = t("craft.reading", { title: item.title });
        const saved = await deps.invoke("doc_load", { itemId: item.id }) as { body: string; rev: number };
        if (ticket !== runGeneration || destroyed) return;
        if (!analyzer.add({ item_id: item.id, title: item.title, rev: saved.rev, body: saved.body })) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (ticket !== runGeneration || destroyed) return;
      const built = analyzer.finish();
      const [resourceRows, linkRows, castRows, appearances] = await Promise.all([
        deps.invoke("research_list"), deps.invoke("knowledge_links", { endpoint: null }),
        deps.invoke("cast_list"), deps.invoke("appearances_list"),
      ]);
      if (ticket !== runGeneration || destroyed) return;
      built.knowledge = knowledgeConsistency({ links: linkRows as Link[], resources: resourceRows as Resource[],
        cast: castRows as Cast[], appearances: appearances as Record<string, string[]> },
      Math.max(0, options.max_findings - built.findings.length));
      report = built; status.textContent = changed.size > 0 ? t("craft.stale") : t("craft.ready"); renderReport();
    } catch (reason) { if (ticket === runGeneration && !destroyed) error(reason); }
    finally { if (ticket === runGeneration && !destroyed) run.disabled = false; }
  }
  async function exportReport(kind: "json" | "csv"): Promise<void> {
    if (report === null) { status.textContent = t("craft.no-report"); return; }
    if (changed.size > 0) { status.textContent = t("craft.stale"); return; }
    const ticket = lifecycle;
    const text = kind === "json" ? JSON.stringify(report, null, 2) : craftReportCsv(report);
    try { await deps.invoke("craft_report_export_as", { generation: deps.generation, kind, text }); }
    catch (reason) { currentError(reason, ticket); }
  }
  // Close, Escape and a click elsewhere (the shell's). `hide` moves no focus,
  // so the outside click does not either; Close and Escape hand it back.
  function hide(): void { ++lifecycle; ++generation; ++runGeneration; run.disabled = false; panel.hidden = true; }
  const shell = createPanelShell({ panel, title: t("craft.heading"), close: hide, returnFocus: deps.onDismiss, inspector: true });
  const api: CraftPanel = {
    async open(tab = "knowledge") {
      if (destroyed) return;
      const ticket = ++lifecycle;
      panel.hidden = false; show(tab); panel.focus();
      await refresh();
      if (!active(ticket)) return;
      try {
        const loaded = await deps.invoke("craft_watchlist_get") as WatchTerm[];
        if (active(ticket)) { watchlist = loaded; renderWatch(); }
      } catch (reason) { currentError(reason, ticket); }
    },
    sourceChanged(id) {
      if (links.some((link) => link.anchor?.item_id === id && !link.anchor_stale)) {
        links = links.map((link) => link.anchor?.item_id === id ? { ...link, anchor_stale: true } : link);
        renderRelationships();
      }
      if (run.disabled || report?.sources.some((source) => source.item_id === id)) { changed.add(id); renderReport(); } },
    invalidateAll() {
      if (run.disabled) { ++runGeneration; run.disabled = false; status.textContent = t("craft.stale"); }
      for (const source of report?.sources ?? []) changed.add(source.item_id);
      if (report !== null) status.textContent = t("craft.stale");
      renderReport();
    },
    close() { hide(); deps.onDismiss(); },
    destroy() { destroyed = true; ++lifecycle; ++generation; ++runGeneration; shell.destroy(); panel.remove(); },
  };
  return api;
}
