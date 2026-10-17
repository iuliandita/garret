import { schema, type Editor } from "../../ui/src/editor";
import { locateMatches } from "../../ui/src/find-locate";
import { mobileMessages } from "./messages";
import type { MobileScene } from "./workspace";

export interface StructureItem { id: string; parent_id: string | null; type: string; title: string; rev: number; depth: number }
export interface MobileGoals { target: string; today: number | null; collecting: boolean; available: boolean }
export interface MobileComment { id: number; body: string; quote: string; anchor_from: number; anchor_to: number; resolved: boolean; orphaned: boolean }
export interface MobileReference { notes: { title: string; body: string }[]; cast: { name: string; summary: string; aliases: string[]; fields: { label: string; value: string }[] }[] }
export interface MobileDrafting {
  structure(): Promise<StructureItem[]>;
  rename(itemId: string, title: string, baseRev: number): Promise<MobileScene[]>;
  move(itemId: string, newParentId: string | null, afterId: string | null, baseRev: number): Promise<MobileScene[]>;
  find(query: string, currentScene: string): Promise<{ results: { item_id: string; title: string; snippet: string; matches: number }[]; truncated: boolean; skipped: number }>;
  goals(day: string, target?: string): Promise<MobileGoals>;
  notes(itemId: string): Promise<{ body: string } | null>;
  saveNotes(itemId: string, body: string): Promise<unknown>;
  reference(): Promise<MobileReference>;
  comments(itemId: string): Promise<MobileComment[]>;
  resolve(itemId: string, commentId: number): Promise<MobileComment[]>;
}
interface Options {
  root: HTMLElement; actions: HTMLElement; locale: "en" | "de";
  host: MobileDrafting; editor: Editor;
  activeId(): string; drain(): Promise<boolean>; localDay(): string;
  lock(value: boolean): void; available(): boolean;
  reload(scenes: MobileScene[]): void; openScene(id: string): Promise<boolean>;
  textSize: number; saveTextSize(size: number): boolean;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(text: string, action: () => void) {
  const result = node("button", text); result.type = "button";
  result.addEventListener("click", action); return result;
}
function field(text: string, input: HTMLElement) {
  const label = node("label", text); label.append(input); return label;
}
export function createDraftingTools(opts: Options) {
  const m = mobileMessages(opts.locale);
  let active: HTMLDialogElement | undefined;
  let pending = false;
  let size = opts.textSize;
  const applySize = () => opts.root.style.setProperty("--prose-size", `${size}px`);
  applySize();
  function open(title: string, render: (content: HTMLElement, run: (work: () => Promise<void>) => void, close: () => void) => Promise<void>) {
    if (!opts.available() || active) return;
    const id = opts.activeId();
    const dialog = node("dialog"); dialog.className = "mobile-outline mobile-drafting";
    dialog.setAttribute("aria-label", title); dialog.dataset.sceneId = id;
    const header = node("header"); const content = node("div"); content.className = "mobile-drafting-content";
    const error = node("p"); error.setAttribute("role", "alert"); error.hidden = true;
    const close = () => { if (!pending) { dialog.close(); finish(); } };
    const dismiss = button(m.close, close);
    header.append(node("h2", title), dismiss); dialog.append(header, error, content);
    opts.root.querySelector<HTMLDialogElement>(".mobile-outline[open]")?.close();
    opts.lock(true); opts.root.append(dialog); active = dialog;
    function finish() {
      if (active !== dialog) return;
      active = undefined;
      const workspaceError = dialog.querySelector<HTMLElement>(".mobile-error");
      if (workspaceError) opts.root.querySelector("header")!.after(workspaceError);
      dialog.remove(); opts.lock(false);
      opts.root.querySelector<HTMLButtonElement>('[data-action="outline"]')?.focus();
    }
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("close", finish);
    const run = (work: () => Promise<void>) => {
      if (pending) return;
      pending = true; error.hidden = true;
      const controls = [...dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button,input,select,textarea")];
      for (const control of controls) control.disabled = true;
      dialog.setAttribute("aria-busy", "true");
      void work().catch(() => { error.textContent = m.operationError; error.hidden = false; })
        .finally(() => { pending = false; for (const control of controls) control.disabled = false; dialog.setAttribute("aria-busy", "false"); });
    };
    dialog.showModal();
    run(async () => {
      if (!await opts.drain()) throw new Error("save failed");
      await render(content, run, close);
    });
  }
  function add(title: string, render: Parameters<typeof open>[1]) {
    opts.actions.append(button(title, () => open(title, render)));
  }
  add(m.rename, async (content, run, close) => {
    const id = opts.activeId();
    const items = await opts.host.structure(); const item = items.find(item => item.id === id)!;
    const form = node("form"); const input = node("input"); input.required = true; input.maxLength = 120; input.value = item.title;
    const submit = node("button", m.saveAction); submit.type = "submit";
    form.append(field(m.sceneTitle, input), submit); content.append(form);
    form.addEventListener("submit", event => { event.preventDefault(); if (!input.value.trim()) return; run(async () => {
      opts.reload(await opts.host.rename(id, input.value.trim(), item.rev));
      // Release after the acknowledged mutation, without allowing another submit.
      pending = false; close();
    }); });
    input.focus(); input.select();
  });
  add(m.move, async (content, run, close) => {
    const id = opts.activeId(); const items = await opts.host.structure(); const item = items.find(item => item.id === id)!;
    const descendants = new Set([id]);
    for (const row of items) if (row.parent_id && descendants.has(row.parent_id)) descendants.add(row.id);
    const parent = node("select"); const after = node("select");
    const option = (value: string, text: string) => { const result = node("option", text); result.value = value; return result; };
    parent.append(option("", m.manuscript));
    for (const row of items) if (!descendants.has(row.id)) parent.append(option(row.id, `${"\u00a0".repeat(Math.min(row.depth, 6) * 2)}${row.title || m.untitled}`));
    parent.value = item.parent_id ?? "";
    function neighbors() {
      after.replaceChildren(option("", m.first));
      for (const row of items) if (row.id !== id && row.parent_id === (parent.value || null)) after.append(option(row.id, row.title || m.untitled));
    }
    neighbors();
    const siblings = items.filter(row => row.parent_id === item.parent_id); const index = siblings.findIndex(row => row.id === id);
    after.value = siblings[index - 1]?.id ?? "";
    parent.addEventListener("change", neighbors);
    const form = node("form"); const submit = node("button", m.move); submit.type = "submit";
    form.append(field(m.destination, parent), field(m.after, after), submit); content.append(form);
    form.addEventListener("submit", event => { event.preventDefault(); run(async () => {
      opts.reload(await opts.host.move(id, parent.value || null, after.value || null, item.rev)); pending = false; close();
    }); });
  });
  add(m.search, async (content, run, close) => {
    const form = node("form"); const input = node("input"); input.type = "search"; input.required = true; input.maxLength = 1000;
    const scene = node("button", m.searchScene); scene.type = "submit";
    const results = node("nav"); const status = node("p"); status.setAttribute("role", "status");
    function jump(id: string, query: string, range?: { from: number; to: number }) {
      close();
      void opts.openScene(id).then(ok => {
        if (ok) { if (range) opts.editor.selectRange(range.from, range.to); else opts.editor.revealMatch(query); opts.editor.focus(); }
      });
    }
    form.append(field(m.query, input), scene, button(m.searchBook, () => {
      const query = input.value.trim(); if (!query) return;
      run(async () => {
        const found = await opts.host.find(query, opts.activeId());
        results.replaceChildren(); status.textContent = [found.results.length ? "" : m.noResults, found.truncated ? m.searchLimited : "", found.skipped ? m.searchSkipped : ""].filter(Boolean).join(" ");
        for (const hit of found.results) {
          const result = button(hit.title || m.untitled, () => jump(hit.item_id, query));
          if (hit.snippet) result.append(node("small", hit.snippet)); results.append(result);
        }
      });
    }));
    form.addEventListener("submit", event => {
      event.preventDefault(); const query = input.value.trim(); if (!query) return;
      const doc = schema.nodeFromJSON(JSON.parse(opts.editor.serialize())); const matches = locateMatches(doc, query);
      results.replaceChildren(); status.textContent = matches.length ? `${matches.length}${matches.length > 200 ? ` ${m.sceneSearchLimited}` : ""}` : m.noResults;
      for (const range of matches.slice(0, 200)) {
        const snippet = doc.textBetween(Math.max(0, range.from - 35), Math.min(doc.content.size, range.to + 35), " ");
        results.append(button(snippet, () => jump(opts.activeId(), query, range)));
      }
    });
    content.append(form, status, results); input.focus();
  });
  add(m.goals, async (content, run) => {
    const form = node("form"); const input = node("input"); input.type = "number"; input.min = "0"; input.max = "1000000"; input.step = "1"; input.required = true;
    const status = node("p"); status.setAttribute("role", "status");
    function paint(goals: MobileGoals) {
      input.value = goals.target === "off" ? "0" : goals.target;
      status.textContent = !goals.available || goals.today === null ? m.goalUnavailable
        : `${m.today}: ${goals.today.toLocaleString(opts.locale)}${goals.target === "off" ? "" : ` / ${Number(goals.target).toLocaleString(opts.locale)}`}`;
      if (!goals.collecting) status.textContent += ` ${m.goalPaused}`;
    }
    paint(await opts.host.goals(opts.localDay()));
    const submit = node("button", m.saveAction); submit.type = "submit";
    form.append(field(m.dailyTarget, input), submit); content.append(status, form);
    form.addEventListener("submit", event => { event.preventDefault(); const value = Number(input.value); if (!Number.isInteger(value) || value < 0 || value > 1_000_000) return; run(async () => paint(await opts.host.goals(opts.localDay(), value === 0 ? "off" : String(value)))); });
  });
  add(m.notes, async (content, run) => {
    const id = opts.activeId(); const notes = await opts.host.notes(id);
    const input = node("textarea"); input.value = notes?.body ?? ""; input.rows = 8;
    const status = node("p"); status.setAttribute("role", "status");
    content.append(node("p", m.notesHint), field(m.notes, input), button(m.saveAction, () => run(async () => {
      await opts.host.saveNotes(id, input.value); status.textContent = m.saved;
    })), status);
    input.addEventListener("input", () => { status.textContent = m.pending; });
  });
  add(m.reference, async content => {
    const reference = await opts.host.reference(); const input = node("input"); input.type = "search";
    const list = node("div");
    function paint() {
      const query = input.value.trim().toLocaleLowerCase(opts.locale); list.replaceChildren();
      for (const [title, records] of [[m.bible, reference.notes], [m.cast, reference.cast.map(member => ({ title: member.name, body: [member.summary, ...member.aliases, ...member.fields.map(field => `${field.label}: ${field.value}`)].join("\n") }))]] as const) {
        const matches = records.filter(row => `${row.title}\n${row.body}`.toLocaleLowerCase(opts.locale).includes(query));
        if (!matches.length) continue;
        list.append(node("h3", title));
        for (const row of matches) { const detail = node("details"); detail.append(node("summary", row.title || m.untitled), node("p", row.body)); list.append(detail); }
      }
      if (!list.childElementCount) list.append(node("p", m.noReferences));
    }
    input.addEventListener("input", paint); content.append(field(m.lookup, input), list); paint();
  });
  add(m.comments, async (content, run, close) => {
    const id = opts.activeId();
    function paint(comments: MobileComment[]) {
      content.replaceChildren();
      opts.editor.setCommentAnchors(comments.map(comment => ({ id: comment.id, from: comment.anchor_from, to: comment.anchor_to, resolved: comment.resolved })));
      if (!comments.length) content.append(node("p", m.noComments));
      for (const comment of comments) {
        const article = node("article"); article.append(node("blockquote", comment.quote), node("p", comment.body));
        if (comment.orphaned) article.append(node("p", m.orphaned));
        else article.append(button(m.showPassage, () => { close(); opts.editor.selectRange(comment.anchor_from, comment.anchor_to); opts.editor.focus(); }));
        if (comment.resolved) article.append(node("p", m.resolved));
        else article.append(button(m.resolve, () => run(async () => paint(await opts.host.resolve(id, comment.id)))));
        content.append(article);
      }
    }
    paint(await opts.host.comments(id));
  });
  add(m.textSize, async content => {
    const input = node("input"); input.type = "range"; input.min = "16"; input.max = "28"; input.step = "1"; input.value = String(size);
    const value = node("output", String(size)); const error = node("p"); error.setAttribute("role", "alert");
    input.addEventListener("input", () => {
      const next = Number(input.value);
      if (!opts.saveTextSize(next)) { error.textContent = m.operationError; input.value = String(size); return; }
      size = next; value.textContent = String(size); error.textContent = ""; applySize();
    });
    content.append(node("p", m.textSizeHint), field(m.textSize, input), value, error);
  });
  return { back() { if (!active) return false; if (!pending) active.querySelector<HTMLButtonElement>("header button")!.click(); return true; } };
}
