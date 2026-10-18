import { closeHistory } from "prosemirror-history";
import { NodeSelection, TextSelection, type Transaction, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { MAX_ATTRIBUTE_BYTES, validDocumentShape } from "./document-format";
import { createPanelShell } from "./panel-shell";
import { formatNumber, t } from "./i18n";

export interface DocumentAuthoring {
  note(pos?: number): void;
  sceneBreak(): void;
  remove(): void;
  pending(): boolean;
  confirmLeave(): Promise<boolean>;
  destroy(): void;
}

export function createDocumentAuthoring(view: EditorView, options: {
  canEdit(): boolean;
  committed(): Promise<boolean>;
  draftChanged(): void;
  noteOffset(): number;
  restoreDraft?(state: EditorState): void;
}): DocumentAuthoring {
  const panel = document.createElement("section");
  panel.id = "endnote-editor";
  panel.setAttribute("role", "dialog");
  panel.hidden = true;
  document.body.append(panel);
  let alive = true;
  let busy = false;
  let hintSeen = false;
  let target: { pos: number; id: string; inserted: boolean; doc: typeof view.state.doc; before: EditorState } | null = null;
  let leaving: ((allowed: boolean) => void) | null = null;
  let leavePromise: Promise<boolean> | null = null;
  const shell = createPanelShell({ panel, title: t("authoring.endnote"), footer: true,
    outsideClick: false, close: () => { if (!busy) { if (leaving) answer(false); else finish(true); } },
    returnFocus: () => { if (target) field.focus(); else view.focus(); } });
  const label = document.createElement("label");
  label.htmlFor = "endnote-body";
  const field = document.createElement("textarea");
  field.id = label.htmlFor;
  field.rows = 6;
  const hint = document.createElement("p");
  hint.id = "endnote-plain-text-hint";
  hint.textContent = t("authoring.plain-text");
  field.setAttribute("aria-describedby", hint.id);
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const question = document.createElement("p");
  question.textContent = t("authoring.leave");
  question.hidden = true;
  shell.body.append(label, field, hint, error, question);
  const button = (key: string, run: () => void): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = t(key);
    element.addEventListener("click", run);
    shell.footer!.append(element);
    return element;
  };
  const cancel = button("authoring.cancel", () => {
    if (busy) return;
    if (leaving) answer(false); else finish(true);
  });
  const discard = button("authoring.discard", () => { if (!busy) finish(true); });
  discard.hidden = true;
  const save = button("authoring.save", () => { void commit(); });

  function answer(allowed: boolean): void {
    const resolve = leaving;
    leaving = null;
    leavePromise = null;
    question.hidden = true;
    discard.hidden = true;
    if (!allowed && target) field.focus();
    resolve?.(allowed);
  }
  function finish(allowed: boolean, discardDraft = true): void {
    const captured = target;
    target = null;
    if (discardDraft && captured && !view.state.doc.eq(captured.before.doc)) {
      if (options.restoreDraft) options.restoreDraft(captured.before);
      else view.updateState(captured.before);
    }
    panel.hidden = true;
    options.draftChanged();
    answer(allowed);
    if (alive) view.focus();
  }
  function isolated(tr: Transaction): boolean {
    if (!options.canEdit() || !validDocumentShape(tr.doc.toJSON())) return false;
    view.dispatch(closeHistory(tr).setMeta("documentAuthoring", true));
    view.dispatch(closeHistory(view.state.tr).setMeta("addToHistory", false));
    return true;
  }
  async function commit(): Promise<void> {
    const captured = target;
    if (!captured || busy || !options.canEdit()) return;
    if (new TextEncoder().encode(field.value).length > MAX_ATTRIBUTE_BYTES || !view.state.doc.eq(captured.doc)) {
      error.textContent = t("authoring.failed");
      return;
    }
    const attrs = { id: captured.id, fmt: "text", body: field.value };
    const tr = view.state.tr;
    if (captured.inserted) {
      if (tr.doc.nodeAt(captured.pos)?.attrs.id !== captured.id) { error.textContent = t("authoring.failed"); return; }
      if (JSON.stringify(tr.doc.nodeAt(captured.pos)!.attrs) !== JSON.stringify(attrs)) tr.setNodeMarkup(captured.pos, undefined, attrs);
    } else {
      tr.insert(captured.pos, view.state.schema.nodes.endnote.create(attrs));
    }
    if (tr.docChanged && !isolated(tr)) { error.textContent = t("authoring.failed"); return; }
    captured.inserted = true;
    captured.doc = view.state.doc;
    busy = true;
    save.disabled = cancel.disabled = discard.disabled = field.disabled = true;
    try {
      if (!await options.committed()) throw new Error("endnote save failed");
      if (alive && target === captured) finish(true, false);
    } catch {
      if (alive && target === captured) error.textContent = t("authoring.failed");
    } finally {
      busy = false;
      save.disabled = cancel.disabled = discard.disabled = field.disabled = false;
    }
  }
  return {
    note(pos) {
      if (!options.canEdit()) return;
      if (target) { field.focus(); return; }
      const selected = view.state.selection;
      const at = pos ?? selected.from;
      const node = view.state.doc.nodeAt(at);
      const editing = node?.type.name === "endnote";
      if (!editing && !view.state.doc.resolve(at).parent.isTextblock) return;
      let number = options.noteOffset() + 1;
      view.state.doc.nodesBetween(0, at, child => { if (child.type.name === "endnote") number++; });
      const title = t("authoring.reference", { number: formatNumber(number) });
      panel.setAttribute("aria-label", title);
      shell.setTitle(title);
      label.textContent = t("authoring.body", { number: formatNumber(number) });
      field.value = editing ? node.attrs.body as string : "";
      target = { pos: at, id: editing ? node.attrs.id as string : crypto.randomUUID(), inserted: editing, doc: view.state.doc, before: view.state };
      error.textContent = "";
      hint.hidden = hintSeen;
      hintSeen = true;
      panel.hidden = false;
      let box;
      try { box = view.coordsAtPos(at); } catch { box = view.dom.getBoundingClientRect(); }
      panel.style.left = String(Math.max(8, Math.min(box.left, window.innerWidth - 376))) + "px";
      panel.style.top = String(Math.max(8, Math.min(box.bottom + 8, window.innerHeight - 360))) + "px";
      options.draftChanged();
      field.focus();
    },
    sceneBreak() {
      if (target || !options.canEdit()) return;
      const tr = view.state.tr.replaceSelectionWith(view.state.schema.nodes.scene_break.create());
      const end = tr.selection.to;
      if (end >= tr.doc.content.size) tr.insert(end, view.state.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end + 1, tr.doc.content.size))));
      isolated(tr);
      view.focus();
    },
    remove() {
      const selection = view.state.selection;
      if (target || !(selection instanceof NodeSelection) || !["endnote", "scene_break"].includes(selection.node.type.name)) return;
      isolated(view.state.tr.deleteSelection());
    },
    pending: () => target !== null,
    confirmLeave() {
      if (!target) return Promise.resolve(true);
      if (leavePromise) return leavePromise;
      question.hidden = false;
      discard.hidden = false;
      cancel.focus();
      leavePromise = new Promise(resolve => { leaving = resolve; });
      return leavePromise;
    },
    destroy() {
      alive = false;
      target = null;
      answer(false);
      shell.destroy();
      panel.remove();
    },
  };
}
