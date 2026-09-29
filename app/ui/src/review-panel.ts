import { createEditor, schema, type Editor } from "./editor";
import { parseReviewBody, proposalBetween, type ReviewHunk } from "./review-fragments";
import type { ReviewAuthor, ReviewDecision, ReviewGroup, ReviewMessage, ReviewState, ReviewSummary } from "./review-types";
import { formatNumber, formatShortDateTime, messages, t } from "./i18n";
import { isCompositionKey } from "./composition-key";
import { reviewRich } from "./review-rich";
import { createPanelShell } from "./panel-shell";
import { createReviewTransportPanel, type ReviewTransportDeps, type ReviewTransportPanel } from "./review-transport-panel";

export interface ReviewPanelDeps {
  container?: HTMLElement;
  load(itemId: string, beforeId: number | null, pendingOnly: boolean): Promise<ReviewState>;
  group(id: number): Promise<ReviewGroup>;
  messages(id: number): Promise<ReviewMessage[]>;
  createAuthor(name: string): Promise<ReviewAuthor>;
  createGroup(itemId: string, expectedDocRev: number, authorId: number, hunks: ReviewHunk[]): Promise<unknown>;
  addMessage(groupId: number, expectedGroupRev: number, authorId: number, body: string): Promise<unknown>;
  decide(itemId: string, groupId: number, expectedGroupRev: number, expectedDocRev: number,
    ids: number[], decision: ReviewDecision, authorId: number): Promise<void>;
  transport?: Omit<ReviewTransportDeps, "container" | "onStateChange" | "onDone">;
  isLocked?(): boolean;
  onDone(): void;
  onNotice(message: string): void;
  onDismiss(): void;
}
export interface ReviewPanel {
  open(itemId: string, title: string): Promise<boolean>;
  requestClose(): Promise<boolean>;
  confirmLeave(): Promise<boolean>;
  hasUnsaved(): boolean;
  busy(): boolean;
  setLeaving(leaving: boolean): void;
  invalidateTransport(): void;
  destroy(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(key: string, action: () => void): HTMLButtonElement {
  const element = node("button", t(key)); element.type = "button";
  element.addEventListener("click", action);
  return element;
}
function label(key: string, field: HTMLElement): HTMLLabelElement {
  const element = node("label", t(key)); element.append(field); return element;
}
/** A checkbox BEFORE its words, the order every platform draws. */
function check(key: string, field: HTMLInputElement): HTMLLabelElement {
  const element = node("label"); element.className = "review-check";
  element.append(field, t(key)); return element;
}

/** "Mara, Sep 25, 10:15 PM: 1 pending": the non-zero counts only, joined the
 *  way the catalog's language joins a list. A line of four counts with
 *  three zeros in it reads as a log, not as a sentence. */
export function proposalSummary(group: Pick<ReviewSummary, "author_name" | "created_at" | "pending" | "conflicted" | "accepted" | "rejected">): string {
  const parts = (["pending", "conflicted", "accepted", "rejected"] as const)
    .filter((state) => group[state] > 0)
    .map((state) => t(`review.count.${state}`, { count: formatNumber(group[state]) }));
  const when = { author: group.author_name, date: formatShortDateTime(group.created_at) };
  if (parts.length === 0) return t("review.summary.bare", when);
  const counts = new Intl.ListFormat(messages.locale, { type: "conjunction" }).format(parts);
  return t("review.summary", { ...when, counts });
}

export function createReviewPanel(deps: ReviewPanelDeps): ReviewPanel {
  const panel = node("section"); panel.id = "review-panel"; panel.hidden = true; panel.tabIndex = -1;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("review.heading"));
  const status = node("p"); status.id = "review-status"; status.setAttribute("role", "status");
  const author = node("select"); author.id = "review-author";
  const authorName = node("input"); authorName.id = "review-author-name"; authorName.maxLength = 80;
  const addAuthor = button("review.author-create", () => {
    if (!authorName.value.trim()) return;
    const name = authorName.value;
    void mutate(async () => {
      const created = await deps.createAuthor(name);
      authorId = created.id; authorName.value = "";
      showAuthorForm(false);
    });
  });
  // CREATING A REVIEWER IS BEHIND A BUTTON. Seven controls stood
  // before the first proposal; naming a new reviewer is done once per
  // person, choosing one is done every visit. The form opens under the row.
  const authorToggle = button("review.author-add", () => showAuthorForm(authorForm.hidden));
  authorToggle.id = "review-author-add"; authorToggle.dataset.weight = "quiet";
  authorToggle.setAttribute("aria-expanded", "false"); authorToggle.setAttribute("aria-controls", "review-author-form");
  const authorForm = node("div"); authorForm.id = "review-author-form"; authorForm.hidden = true;
  authorForm.append(label("review.author-name", authorName), addAuthor);
  function showAuthorForm(open: boolean): void {
    authorForm.hidden = !open; authorToggle.setAttribute("aria-expanded", String(open));
    if (open) authorName.focus();
  }
  const authors = node("div"); authors.className = "review-authors";
  authors.append(label("review.author", author), authorToggle, authorForm);
  // A SEGMENTED CONTROL, not buttons dressed as tabs: one row of views,
  // the pressed one tinted, and Close is never one of them.
  const tabs = node("div"); tabs.className = "segmented"; tabs.id = "review-views";
  tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", t("review.views"));
  const proposalsTab = button("review.proposals", () => showDraft(false));
  const draftTab = button("review.new", () => showDraft(true)); tabs.append(proposalsTab, draftTab);
  const transportTab = deps.transport ? button("review.transport.tab", () => showTransport()) : null;
  if (transportTab) { transportTab.id = "review-transport-tab"; tabs.append(transportTab); }
  const proposals = node("div"); proposals.id = "review-proposals";
  const controls = node("div"); controls.className = "review-actions";
  const history = node("input"); history.type = "checkbox"; history.id = "review-history";
  const refresh = button("review.refresh", () => { void reload(); }); refresh.id = "review-refresh";
  const first = button("review.first", () => { cursor = null; void reload(); });
  const next = button("review.next", () => { if (state?.page.before_id) { cursor = state.page.before_id; void reload(); } });
  controls.append(check("review.history", history));
  // Paging and Refresh AFTER the list: the proposals lead.
  const paging = node("div"); paging.className = "review-actions"; paging.id = "review-paging";
  paging.append(first, next, refresh);
  const list = node("ul"); list.id = "review-list";
  const detail = node("section"); detail.id = "review-detail";
  const discussion = node("section"); discussion.id = "review-discussion";
  const message = node("textarea"); message.id = "review-message"; message.maxLength = 4000;
  const post = button("review.post", () => {
    if (!selected || !authorId || !message.value.trim()) return;
    const id = selected.id, rev = selected.rev, by = authorId, body = message.value;
    void mutate(async () => { await deps.addMessage(id, rev, by, body); messageDrafts.delete(id); message.value = ""; });
  }); post.id = "review-post";
  const messageBox = node("div"); messageBox.id = "review-message-box";
  messageBox.append(label("review.message", message), node("p", t("review.message-immutable")), post);
  proposals.append(controls, list, paging, detail, discussion, messageBox);
  const draft = node("section"); draft.id = "review-draft"; draft.hidden = true;
  const draftStatus = node("p"); draftStatus.id = "review-draft-status";
  const toolbar = node("div"); toolbar.className = "review-actions";
  const formatButtons: [HTMLButtonElement, "bold" | "italic" | "underline"][] = [];
  for (const [key, command, mark] of [
    ["review.bold", "toggleBold", "bold"], ["review.italic", "toggleItalic", "italic"], ["review.underline", "toggleUnderline", "underline"],
  ] as const) {
    const control = button(key, () => { editor?.[command](); editor?.focus(); });
    control.addEventListener("mousedown", (event) => event.preventDefault());
    toolbar.append(control); formatButtons.push([control, mark]);
  }
  const mount = node("div"); mount.id = "review-draft-editor";
  const submit = button("review.submit", () => {
    if (!editor || !baseline || !authorId || !target) return;
    try {
      const hunk = proposalBetween(parseReviewBody(baseline.body, schema), parseReviewBody(editor.serialize(), schema));
      if (!hunk) { notice(t("review.unchanged")); return; }
      const item = target, rev = baseline.rev, by = authorId;
      void mutate(async () => {
        await deps.createGroup(item, rev, by, [hunk]);
        clearDraft(); showDraft(false);
      });
    } catch { notice(t("review.invalid-draft")); }
  }); submit.id = "review-submit"; submit.dataset.weight = "primary";
  draft.append(node("h3", t("review.new")), node("p", t("review.one-block")), draftStatus, toolbar, mount, submit);
  const transportMount = node("section"); transportMount.id = "review-transport-view"; transportMount.hidden = true;
  const leave = node("div"); leave.id = "review-leave"; leave.hidden = true;
  leave.setAttribute("role", "alertdialog"); leave.setAttribute("aria-label", t("review.leave-question"));
  const keep = button("review.keep", () => finishLeave(false));
  const discard = button("review.discard", () => { if (!deps.isLocked?.() && !mutating) { finishLeave(true); } });
  discard.dataset.weight = "danger";
  leave.append(node("p", t("review.leave-question")), keep, discard);
  panel.append(status, authors, tabs, proposals, draft, transportMount, leave);
  (deps.container ?? document.body).append(panel);
  // Close asks the leave question first, so it is `requestClose`, which hands
  // focus back itself. No outside click: this panel holds drafts, and a click
  // in the prose it is reviewing must not ask whether to throw them away.
  // Its own Escape (below) answers the leave question before closing. As the
  // inspector it is replaced only when nothing would be lost; otherwise
  // the replacement refuses and Close's leave question is asked instead.
  const shell = createPanelShell({
    panel, title: t("review.heading"), closeId: "review-close",
    close: () => { void requestClose(); }, outsideClick: false,
    inspector: {
      replace: () => {
        if (mutating || leaving || deps.isLocked?.() || (transport?.busy() ?? false) || hasUnsaved()) return false;
        ++epoch; ++reading; ++selecting; panel.hidden = true; clearDrafts(); void transport?.discard();
        return true;
      },
    },
  });
  // The scene under review, one line under the title.
  const title = shell.subtitle; title.classList.add("review-target");
  let target: string | null = null, state: ReviewState | null = null, selected: ReviewGroup | null = null;
  let authorId: number | null = null, cursor: number | null = null;
  let epoch = 0, reading = 0, selecting = 0, mutating = false, destroyed = false, leaving = false;
  let editor: Editor | null = null, baseline: ReviewState["document"] | null = null, draftDirty = false;
  const messageDrafts = new Map<number, string>(); const checked = new Set<number>();
  let leaveResolve: ((answer: boolean) => void) | null = null;
  let leavePromise: Promise<boolean> | null = null;
  let transport: ReviewTransportPanel | null = null;

  function notice(text: string): void { status.textContent = text; deps.onNotice(text); }
  function hasUnsaved(): boolean { return draftDirty || [...messageDrafts.values()].some((body) => body.length > 0) || (transport?.hasPendingReturn() ?? false); }
  function update(): void {
    const blocked = mutating || leaving || (transport?.busy() ?? false);
    panel.setAttribute("aria-busy", String(blocked));
    for (const field of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("button,input,select,textarea")) {
      if (leave.contains(field)) field.disabled = blocked;
      else if (!transportMount.contains(field)) field.disabled = blocked || (transport?.hasPreview() ?? false);
    }
    transport?.setBlocked(mutating || leaving);
    const reviewBlocked = blocked || (transport?.hasPreview() ?? false);
    author.disabled = reviewBlocked || !state;
    submit.disabled = reviewBlocked || !authorId || !draftDirty;
    post.disabled = reviewBlocked || !authorId || !selected || !message.value.trim();
    next.disabled = reviewBlocked || !state?.page.before_id;
    first.disabled = reviewBlocked || cursor === null;
    draftTab.disabled = reviewBlocked || !state;
    if (transportTab) transportTab.disabled = blocked || !state;
    messageBox.hidden = !selected;
    editor?.setEditable(!reviewBlocked);
    for (const [control, mark] of formatButtons) control.setAttribute("aria-pressed", String(editor?.activeMarks()[mark] ?? false));
    const selectedHunks = selected?.hunks.filter((hunk) => checked.has(hunk.id)) ?? [];
    const accept = detail.querySelector<HTMLButtonElement>("[data-decision=accept]");
    const reject = detail.querySelector<HTMLButtonElement>("[data-decision=reject]");
    if (accept) accept.disabled = reviewBlocked || !authorId || !selectedHunks.length || selectedHunks.some((hunk) => hunk.state !== "pending");
    if (reject) reject.disabled = reviewBlocked || !authorId || !selectedHunks.length || selectedHunks.some((hunk) => !["pending", "conflicted"].includes(hunk.state));
    for (const input of detail.querySelectorAll<HTMLInputElement>("input[data-hunk]")) {
      input.disabled = reviewBlocked || !selected?.hunks.some((hunk) => hunk.id === Number(input.dataset.hunk) && ["pending", "conflicted"].includes(hunk.state));
    }
    draftStatus.textContent = t(draftDirty ? "review.unsaved" : "review.saved-baseline");
  }
  function clearDraft(): void { editor?.destroy(); editor = null; baseline = null; draftDirty = false; mount.replaceChildren(); }
  function clearDrafts(): void { clearDraft(); messageDrafts.clear(); message.value = ""; update(); }
  function showDraft(show: boolean): void {
    if ((mutating && show) || leaving || destroyed || deps.isLocked?.() || transport?.busy()) return;
    if (transport?.hasPreview()) { notice(t("review.transport.cancel-first")); return; }
    if (show && !editor) {
      if (!state) return;
      try {
        const parsed = parseReviewBody(state.document.body, schema);
        baseline = { ...state.document };
        editor = createEditor(mount, { kind: "pmjson", json: parsed.toJSON() }, {
          onChange: () => { draftDirty = editor?.serialize() !== JSON.stringify(parsed.toJSON()); update(); },
          onStateChange: update,
        });
        const prose = mount.querySelector<HTMLElement>(".ProseMirror");
        prose?.setAttribute("aria-label", t("review.draft-label"));
        prose?.setAttribute("role", "textbox"); prose?.setAttribute("aria-multiline", "true");
      } catch { notice(t("review.invalid-draft")); return; }
    }
    draft.hidden = !show; proposals.hidden = show; transportMount.hidden = true;
    draftTab.setAttribute("aria-pressed", String(show)); proposalsTab.setAttribute("aria-pressed", String(!show));
    transportTab?.setAttribute("aria-pressed", "false");
    update(); if (show) editor?.focus();
  }
  function showTransport(): void {
    if (!transport || mutating || leaving || destroyed || deps.isLocked?.() || transport.busy()) return;
    if (draftDirty || [...messageDrafts.values()].some((body) => body.length > 0)) {
      notice(t("review.transport.drafts-first")); return;
    }
    draft.hidden = true; proposals.hidden = true; transportMount.hidden = false;
    draftTab.setAttribute("aria-pressed", "false"); proposalsTab.setAttribute("aria-pressed", "false");
    transportTab?.setAttribute("aria-pressed", "true"); update();
  }
  function paintAuthors(): void {
    author.replaceChildren(); const empty = node("option", t("review.choose-author")); empty.value = ""; author.append(empty);
    for (const entry of state?.authors ?? []) {
      const option = node("option", entry.display_name); option.value = String(entry.id); author.append(option);
    }
    if (!state?.authors.some((entry) => entry.id === authorId)) authorId = null;
    author.value = authorId === null ? "" : String(authorId);
    transport?.setAuthors(state?.authors ?? []);
  }
  function paintList(): void {
    list.replaceChildren();
    for (const group of state?.page.groups ?? []) {
      const row = node("li"); const open = button("review.proposals", () => { void selectGroup(group.id); });
      open.textContent = proposalSummary(group);
      open.dataset.group = String(group.id); open.setAttribute("aria-pressed", String(selected?.id === group.id));
      row.append(open); list.append(row);
    }
    if (!state?.page.groups.length) list.append(node("li", t("review.empty")));
  }
  function stateText(value: string): string {
    return ["pending", "conflicted", "accepted", "rejected"].includes(value) ? t(`review.state.${value}`) : t("review.state.unknown");
  }
  function paintDetail(messages: ReviewMessage[]): void {
    detail.replaceChildren(); discussion.replaceChildren(); checked.clear();
    if (!selected) { update(); return; }
    detail.append(node("h3", t("review.by", { author: selected.author_name })));
    for (const [index, hunk] of selected.hunks.entries()) {
      const article = node("article"); article.className = "review-hunk";
      const input = node("input"); input.type = "checkbox"; input.dataset.hunk = String(hunk.id);
      const caption = node("label", t("review.hunk", { number: formatNumber(index + 1), state: stateText(hunk.state) })); caption.prepend(input);
      input.addEventListener("change", () => { if (input.checked) checked.add(hunk.id); else checked.delete(hunk.id); update(); });
      article.append(caption);
      if (hunk.decision_author_name) article.append(node("p", t("review.decided-by", { author: hunk.decision_author_name })));
      if (hunk.state === "conflicted") article.append(node("p", t("review.conflict")));
      article.append(node("h4", t("review.before")), reviewRich(hunk.original.before), node("h4", t("review.after")), reviewRich(hunk.original.after));
      detail.append(article);
    }
    const actions = node("div"); actions.className = "review-actions";
    for (const decision of ["accept", "reject"] as const) {
      const act = button(`review.${decision}`, () => decide(decision)); act.dataset.decision = decision;
      if (decision === "accept") act.dataset.weight = "primary";
      actions.append(act);
    }
    detail.append(actions);
    discussion.append(node("h3", t("review.discussion")));
    for (const entry of messages) {
      const article = node("article"); article.append(node("h4", t("review.message-by", { author: entry.author_name, date: formatShortDateTime(entry.created_at) })), node("p", entry.body));
      discussion.append(article);
    }
    message.value = messageDrafts.get(selected.id) ?? ""; paintList(); update();
  }
  async function selectGroup(id: number): Promise<void> {
    if (mutating || leaving || destroyed || transport?.hasPreview() || transport?.busy()) return;
    const mine = ++selecting, session = epoch;
    selected = null; detail.replaceChildren(); discussion.replaceChildren(); update();
    try {
      const [group, messages] = await Promise.all([deps.group(id), deps.messages(id)]);
      if (destroyed || session !== epoch || mine !== selecting) return;
      if (group.item_id !== target || group.id !== id || messages.some((entry) => entry.group_id !== id)) throw new Error("Wrong review target");
      selected = group; paintDetail(messages);
    } catch { if (!destroyed && session === epoch && mine === selecting) notice(t("review.load-failed")); }
  }
  async function reload(): Promise<void> {
    if (!target || destroyed) return;
    const mine = ++reading, session = epoch, item = target, selectedId = selected?.id;
    try {
      const loaded = await deps.load(item, cursor, !history.checked);
      if (destroyed || session !== epoch || mine !== reading) return;
      if (loaded.document.item_id !== item || loaded.page.groups.length > 50) throw new Error("Wrong review snapshot");
      state = loaded; paintAuthors(); paintList(); status.textContent = ""; update();
      if (selectedId !== undefined) await selectGroup(selectedId);
    } catch { if (!destroyed && session === epoch && mine === reading) notice(t("review.load-failed")); }
  }
  async function mutate(operation: () => Promise<void>): Promise<void> {
    if (mutating || leaving || destroyed || deps.isLocked?.() || transport?.hasPreview() || transport?.busy()) return;
    mutating = true; ++reading; ++selecting; update();
    try { await operation(); deps.onDone(); }
    catch { notice(t("review.save-failed")); return; }
    finally { mutating = false; update(); }
    await reload();
  }
  function decide(decision: ReviewDecision): void {
    if (!selected || !state || !target || !authorId) return;
    const ids = selected.hunks.filter((hunk) => checked.has(hunk.id) && (hunk.state === "pending" || decision === "reject" && hunk.state === "conflicted")).map((hunk) => hunk.id);
    if (!ids.length || ids.length !== checked.size) return;
    const item = target, group = selected.id, groupRev = selected.rev, docRev = state.document.rev, by = authorId;
    void mutate(() => deps.decide(item, group, groupRev, docRev, ids, decision, by));
  }
  function finishLeave(answer: boolean): void {
    leave.hidden = true; const resolve = leaveResolve; leaveResolve = null; leavePromise = null; resolve?.(answer);
    if (!answer) panel.focus();
  }
  async function confirmLeave(): Promise<boolean> {
    if (mutating || leaving || deps.isLocked?.() || transport?.busy()) return false;
    if (!hasUnsaved()) { await transport?.discard(); return true; }
    if (!leavePromise) {
      leave.hidden = false; keep.focus();
      leavePromise = new Promise<boolean>((resolve) => { leaveResolve = resolve; });
    }
    const answer = await leavePromise;
    if (!answer || mutating || leaving || deps.isLocked?.()) return false;
    await transport?.discard();
    clearDrafts();
    return true;
  }
  async function requestClose(): Promise<boolean> {
    if (!await confirmLeave()) return false;
    if (mutating || leaving || deps.isLocked?.()) return false;
    ++epoch; ++reading; ++selecting; panel.hidden = true; clearDrafts(); deps.onDismiss(); return true;
  }
  author.addEventListener("change", () => { authorId = author.value ? Number(author.value) : null; update(); });
  message.addEventListener("input", () => { if (selected) messageDrafts.set(selected.id, message.value); update(); });
  history.addEventListener("change", () => { cursor = null; void reload(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || isCompositionKey(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (leaveResolve) finishLeave(false); else void requestClose();
  });
  if (deps.transport) transport = createReviewTransportPanel({
    ...deps.transport, container: transportMount, onStateChange: update,
    onDone: () => { selected = null; detail.replaceChildren(); discussion.replaceChildren(); void reload(); },
  });
  update();
  return {
    async open(itemId, caption) {
      if (destroyed || mutating || leaving || deps.isLocked?.() || transport?.busy()) return false;
      if (!panel.hidden && target === itemId) { panel.focus(); return true; }
      if (hasUnsaved()) { notice(t("review.keep-target")); panel.focus(); return false; }
      await transport?.setTarget(itemId, caption, []);
      ++epoch; ++selecting; target = itemId; shell.setSubtitle(caption); state = null; selected = null;
      authorId = null; cursor = null; history.checked = false; clearDrafts(); detail.replaceChildren(); discussion.replaceChildren(); list.replaceChildren();
      panel.hidden = false; showDraft(false); panel.focus(); await reload(); return !destroyed && target === itemId;
    },
    requestClose, confirmLeave, hasUnsaved, busy: () => mutating || (transport?.busy() ?? false),
    setLeaving(value) { leaving = value; update(); },
    invalidateTransport() { void transport?.discard(); },
    destroy() {
      if (mutating || transport?.busy() || hasUnsaved()) return;
      destroyed = true; ++epoch; finishLeave(false); clearDraft(); shell.destroy(); panel.remove();
      transport?.destroy();
    },
  };
}
