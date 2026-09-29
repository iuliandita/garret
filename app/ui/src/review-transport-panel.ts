import { formatNumber, t } from "./i18n";
import type { FragmentToken, ReviewHunk } from "./review-fragments";
import type { ReviewAuthor } from "./review-types";
import { reviewRich } from "./review-rich";

export type ReviewAuthorChoice = { kind: "existing"; id: number } | { kind: "create"; display_name: string };
export interface ReviewExportPreview {
  token: string; item_id: string; scene_title: string; doc_rev: number;
  authors: string[]; messages: { author_name: string; body: string }[];
}
export interface ReviewReturnPreview {
  token: string; item_id: string; scene_title: string; doc_rev: number;
  decisions: { hunk_id: number; decision: "accept" | "reject"; proposal_author: string;
    before: FragmentToken[]; after: FragmentToken[] }[];
  new_hunks: { author_name: string; hunk: ReviewHunk }[];
  new_messages: { group_id: number; author_name: string; body: string }[];
  source_authors: string[];
}
export interface ReviewReturnRequest {
  token: string;
  sources: { source_name: string; choice: ReviewAuthorChoice }[];
  deciding_actor: ReviewAuthorChoice | null;
}
export class ReviewAppliedViewError extends Error {
  constructor(reason: string) { super(reason); this.name = "ReviewAppliedViewError"; }
}
export class ReviewBusyError extends Error {
  constructor(reason: string) { super(reason); this.name = "ReviewBusyError"; }
}
export interface ReviewTransportDeps {
  container: HTMLElement;
  exportPreview(itemId: string): Promise<ReviewExportPreview>;
  exportSave(token: string, itemId: string): Promise<boolean>;
  returnPreview(itemId: string): Promise<ReviewReturnPreview | null>;
  returnApply(request: ReviewReturnRequest, itemId: string): Promise<void>;
  cancel(token: string): Promise<void>;
  isLocked?(): boolean;
  onNotice(message: string): void;
  /** A completed save or apply. Its own channel: through `onNotice` it was
   *  painted in the problem tone, red, as "Returned review applied." (223). */
  onSuccess(message: string): void;
  onStateChange(): void;
  onDone(): void;
}
export interface ReviewTransportPanel {
  setTarget(itemId: string, title: string, authors: ReviewAuthor[]): Promise<void>;
  setAuthors(authors: ReviewAuthor[]): void;
  setBlocked(blocked: boolean): void;
  hasPendingReturn(): boolean;
  hasPreview(): boolean;
  busy(): boolean;
  discard(): Promise<void>;
  destroy(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(key: string, action: () => void): HTMLButtonElement {
  const element = node("button", t(key)); element.type = "button";
  element.addEventListener("click", action); return element;
}

export function createReviewTransportPanel(deps: ReviewTransportDeps): ReviewTransportPanel {
  const root = node("section"); root.id = "review-transport";
  const heading = node("h3", t("review.transport.heading"));
  const note = node("p", t("review.transport.scope"));
  const actions = node("div"); actions.className = "review-actions";
  const startExport = button("review.transport.export", () => { void previewExport(); });
  const startReturn = button("review.transport.return", () => { void previewReturn(); });
  actions.append(startExport, startReturn);
  const status = node("p"); status.id = "review-transport-status"; status.setAttribute("role", "status");
  const preview = node("section"); preview.id = "review-transport-preview"; preview.hidden = true; preview.tabIndex = -1;
  root.append(heading, note, actions, status, preview);
  deps.container.append(root);

  let itemId: string | null = null, authors: ReviewAuthor[] = [];
  let held: ReviewExportPreview | ReviewReturnPreview | null = null;
  let kind: "export" | "return" | null = null, working = 0, blocked = false, stale = false, destroyed = false;
  let epoch = 0;

  function notice(key: string, reason?: unknown): void {
    const message = reason === undefined ? t(key) : t(key, { reason: String(reason) });
    status.textContent = message; deps.onNotice(message);
  }
  function done(key: string): void {
    const message = t(key);
    status.textContent = message; deps.onSuccess(message);
  }
  function update(): void {
    const disabled = working > 0 || blocked || destroyed || !!deps.isLocked?.();
    root.setAttribute("aria-busy", String(working > 0));
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button,input,select")) field.disabled = disabled;
    startExport.disabled = disabled || itemId === null;
    startReturn.disabled = disabled || itemId === null;
    const save = preview.querySelector<HTMLButtonElement>("#review-transport-save");
    if (save) save.disabled = disabled || stale;
    const apply = preview.querySelector<HTMLButtonElement>("#review-transport-apply");
    if (apply) apply.disabled = disabled || stale || !selectionComplete();
    for (const row of preview.querySelectorAll<HTMLElement>(".review-transport-choice")) {
      const select = row.querySelector<HTMLSelectElement>("select")!;
      const name = row.querySelector<HTMLInputElement>("input")!;
      name.hidden = select.value !== "create";
      name.disabled = disabled || select.value !== "create";
    }
  }
  function clear(): void {
    held = null; kind = null; stale = false; preview.replaceChildren(); preview.hidden = true;
    status.textContent = "";
    update(); deps.onStateChange();
  }
  async function discard(): Promise<void> {
    const token = held?.token;
    ++epoch; clear();
    if (!token) return;
    working++; update(); deps.onStateChange();
    try { await deps.cancel(token); }
    catch { /* Lock or project change can make this ticket unusable by epoch. */ }
    finally { working--; update(); deps.onStateChange(); }
  }
  function choiceRow(labelText: string, name: string): HTMLElement {
    const row = node("div"); row.className = "review-transport-choice"; row.dataset.source = name;
    const label = node("label", labelText);
    const select = node("select"); select.setAttribute("aria-label", labelText);
    const empty = node("option", t("review.transport.choose-author")); empty.value = ""; select.append(empty);
    for (const author of authors) {
      const option = node("option", author.display_name); option.value = `existing:${author.id}`; select.append(option);
    }
    const create = node("option", t("review.transport.create-author")); create.value = "create"; select.append(create);
    const input = node("input"); input.type = "text"; input.maxLength = 80;
    input.placeholder = t("review.transport.new-author-name"); input.setAttribute("aria-label", t("review.transport.new-author-name"));
    input.hidden = true; input.disabled = true;
    select.addEventListener("change", update); input.addEventListener("input", update);
    row.append(label, select, input); return row;
  }
  function selectedChoice(row: HTMLElement): ReviewAuthorChoice | null {
    const select = row.querySelector<HTMLSelectElement>("select")!;
    if (select.value.startsWith("existing:")) {
      const id = Number(select.value.slice(9));
      return Number.isSafeInteger(id) && authors.some((author) => author.id === id) ? { kind: "existing", id } : null;
    }
    if (select.value === "create") {
      const name = row.querySelector<HTMLInputElement>("input")!.value.trim();
      if (name && name.length <= 80 && !/\p{Cc}/u.test(name)) return { kind: "create", display_name: name };
    }
    return null;
  }
  function selectionComplete(): boolean {
    if (kind !== "return" || !held) return false;
    return [...preview.querySelectorAll<HTMLElement>(".review-transport-choice")].every((row) => selectedChoice(row) !== null);
  }
  function disclosure(messages: { author_name: string; body: string }[]): HTMLElement {
    const details = node("details"); details.className = "review-transport-discussion";
    details.append(node("summary", t("review.transport.discussion", { count: formatNumber(messages.length) })));
    for (const message of messages) {
      const article = node("article"); article.append(node("h5", message.author_name), node("p", message.body)); details.append(article);
    }
    return details;
  }
  function paintExport(value: ReviewExportPreview): void {
    preview.replaceChildren(); preview.hidden = false;
    status.textContent = t("review.transport.export-ready");
    preview.append(node("h4", t("review.transport.export-preview")),
      node("p", t("review.transport.scene", { title: value.scene_title })),
      node("p", t("review.transport.authors", { names: value.authors.join(", ") || t("review.transport.none") })),
      node("p", t("review.transport.export-warning")), disclosure(value.messages));
    const controls = node("div"); controls.className = "review-actions";
    const save = button("review.transport.save", () => { void saveExport(); }); save.id = "review-transport-save";
    controls.append(save, button("review.transport.cancel", () => { void discard(); })); preview.append(controls);
    update(); preview.focus();
  }
  function changeView(before: FragmentToken[], after: FragmentToken[]): HTMLElement {
    const change = node("div"); change.className = "review-transport-change";
    change.append(node("h5", t("review.before")), reviewRich(before), node("h5", t("review.after")), reviewRich(after));
    return change;
  }
  function paintReturn(value: ReviewReturnPreview): void {
    preview.replaceChildren(); preview.hidden = false;
    status.textContent = t("review.transport.return-ready");
    preview.append(node("h4", t("review.transport.return-preview")),
      node("p", t("review.transport.scene", { title: value.scene_title })),
      node("p", t("review.transport.return-warning")));
    const decisions = node("section"); decisions.append(node("h5", t("review.transport.old-decisions", { count: formatNumber(value.decisions.length) })));
    for (const entry of value.decisions) {
      const article = node("article"); article.append(node("h6", t(`review.transport.${entry.decision}`, { author: entry.proposal_author })),
        changeView(entry.before, entry.after)); decisions.append(article);
    }
    preview.append(decisions);
    const suggestions = node("section"); suggestions.append(node("h5", t("review.transport.new-suggestions", { count: formatNumber(value.new_hunks.length) })));
    for (const entry of value.new_hunks) {
      const article = node("article"); article.append(node("h6", entry.author_name), changeView(entry.hunk.before, entry.hunk.after)); suggestions.append(article);
    }
    preview.append(suggestions, disclosure(value.new_messages));
    const mappings = node("section"); mappings.id = "review-transport-mappings";
    mappings.append(node("h5", t("review.transport.attribution")));
    if (value.decisions.length) {
      const row = choiceRow(t("review.transport.decision-actor"), ""); row.dataset.actor = "true"; mappings.append(row);
    }
    for (const source of value.source_authors) mappings.append(choiceRow(t("review.transport.map-author", { name: source }), source));
    if (!value.decisions.length && !value.source_authors.length) mappings.append(node("p", t("review.transport.no-new-work")));
    preview.append(mappings);
    const controls = node("div"); controls.className = "review-actions";
    const apply = button("review.transport.apply", () => { void applyReturn(); }); apply.id = "review-transport-apply";
    controls.append(apply, button("review.transport.cancel", () => { void discard(); })); preview.append(controls);
    update(); preview.focus();
  }
  async function previewExport(): Promise<void> {
    if (working || blocked || destroyed || deps.isLocked?.() || itemId === null) return;
    const item = itemId, mine = ++epoch; working++; update(); deps.onStateChange();
    try {
      const oldToken = held?.token; clear();
      if (oldToken) { try { await deps.cancel(oldToken); } catch { /* A replaced ticket may already be invalid. */ } }
      const result = await deps.exportPreview(item);
      if (destroyed || mine !== epoch || itemId !== item) { if (result?.token) await deps.cancel(result.token); return; }
      if (deps.isLocked?.()) { await deps.cancel(result.token); return; }
      if (result.item_id !== item || !result.token || !Number.isSafeInteger(result.doc_rev)) throw new Error(t("review.invalid-result"));
      held = result; kind = "export"; paintExport(result);
    } catch (error) { if (mine === epoch && !destroyed) notice("review.transport.preview-failed", error); }
    finally { working--; update(); deps.onStateChange(); }
  }
  async function previewReturn(): Promise<void> {
    if (working || blocked || destroyed || deps.isLocked?.() || itemId === null) return;
    const item = itemId, mine = ++epoch; working++; update(); deps.onStateChange();
    try {
      const oldToken = held?.token; clear();
      if (oldToken) { try { await deps.cancel(oldToken); } catch { /* A replaced ticket may already be invalid. */ } }
      const result = await deps.returnPreview(item);
      if (destroyed || mine !== epoch || itemId !== item) { if (result?.token) await deps.cancel(result.token); return; }
      if (result === null) return;
      if (deps.isLocked?.()) { await deps.cancel(result.token); return; }
      if (result.item_id !== item || !result.token || !Number.isSafeInteger(result.doc_rev)) throw new Error(t("review.invalid-result"));
      held = result; kind = "return"; paintReturn(result);
    } catch (error) { if (mine === epoch && !destroyed) notice("review.transport.preview-failed", error); }
    finally { working--; update(); deps.onStateChange(); }
  }
  async function saveExport(): Promise<void> {
    if (working || blocked || destroyed || deps.isLocked?.() || kind !== "export" || !held || stale) return;
    const token = held.token; working++; update(); deps.onStateChange();
    try {
      if (await deps.exportSave(token, itemId!)) { clear(); done("review.transport.saved"); deps.onDone(); }
    } catch (error) {
      if (!(error instanceof ReviewBusyError)) stale = true;
      notice("review.transport.save-failed", error);
    }
    finally { working--; update(); deps.onStateChange(); }
  }
  async function applyReturn(): Promise<void> {
    if (working || blocked || destroyed || deps.isLocked?.() || kind !== "return" || !held || stale || !selectionComplete() || itemId === null) return;
    const value = held as ReviewReturnPreview, item = itemId;
    const actorRow = preview.querySelector<HTMLElement>("[data-actor]");
    const request: ReviewReturnRequest = {
      token: value.token,
      deciding_actor: actorRow ? selectedChoice(actorRow) : null,
      sources: [...preview.querySelectorAll<HTMLElement>(".review-transport-choice[data-source]")]
        .filter((row) => !row.hasAttribute("data-actor"))
        .map((row) => ({ source_name: row.dataset.source!, choice: selectedChoice(row)! })),
    };
    working++; update(); deps.onStateChange();
    try {
      await deps.returnApply(request, item);
      clear(); done("review.transport.applied"); deps.onDone();
    } catch (error) {
      if (error instanceof ReviewAppliedViewError) {
        clear(); notice("review.transport.reconcile-failed", error); deps.onDone();
      } else {
        if (!(error instanceof ReviewBusyError)) stale = true;
        notice("review.transport.apply-failed", error);
      }
    }
    finally { working--; update(); deps.onStateChange(); }
  }
  update();
  return {
    async setTarget(id, caption, localAuthors) {
      if (itemId !== id) await discard();
      itemId = id; note.textContent = t("review.transport.scope", { title: caption });
      authors = [...localAuthors]; update();
    },
    setAuthors(value) { authors = [...value]; update(); },
    setBlocked(value) { blocked = value; update(); },
    hasPendingReturn: () => kind === "return" && held !== null,
    hasPreview: () => held !== null,
    busy: () => working > 0,
    discard,
    destroy() { destroyed = true; ++epoch; void discard(); root.remove(); },
  };
}
