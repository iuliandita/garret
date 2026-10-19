import { closeHistory } from "prosemirror-history";
import { NodeSelection, TextSelection, type Transaction, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { MAX_ATTRIBUTE_BYTES, validDocumentShape } from "./document-format";
import { createPanelShell } from "./panel-shell";
import { noteNumberAt } from "./document-reader";
import { formatNumber, t } from "./i18n";
import { appendTrailingTextblock } from "./trailing-block";

export interface FigureAsset { id: string; width_px: number; height_px: number; orientation: number }
export interface FigureDetails { asset: FigureAsset; column_inches: number; height_inches: number; original_warning?: string | null }

export interface DocumentAuthoring {
  figure(pos?: number): Promise<void>;
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
  pickFigure?: () => Promise<FigureAsset | null>;
  figureDetails?: (assetId: string) => Promise<FigureDetails>;
}): DocumentAuthoring {
  const panel = document.createElement("section");
  panel.id = "endnote-editor";
  panel.setAttribute("role", "dialog");
  panel.hidden = true;
  document.body.append(panel);
  let alive = true;
  let busy = false;
  let hintSeen = false;
  let target: { kind: "endnote" | "figure"; assetId?: string; pos: number; id: string; inserted: boolean; doc: typeof view.state.doc; before: EditorState } | null = null;
  let leaving: ((allowed: boolean) => void) | null = null;
  let leavePromise: Promise<boolean> | null = null;
  const shell = createPanelShell({ panel, title: t("authoring.endnote"), footer: true,
    outsideClick: false, close: () => { if (!busy) { if (leaving) answer(false); else finish(true); } },
    returnFocus: focusTarget });
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
  const properties = document.createElement("div");
  properties.hidden = true;
  const property = (id: string, text: string, element: HTMLElement) => {
    const label = document.createElement("label"); label.htmlFor = id; label.textContent = t(text);
    element.id = id; properties.append(label, element);
  };
  const width = document.createElement("select");
  for (const [value, key] of [["full", "figure.width-full"], ["half", "figure.width-half"], ["page", "figure.width-page"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = t(key); width.append(option);
  }
  property("figure-width", "figure.width", width);
  const caption = document.createElement("textarea"); caption.rows = 2;
  property("figure-caption", "figure.caption", caption);
  const alt = document.createElement("textarea"); alt.rows = 3;
  property("figure-alt", "figure.alt", alt);
  const resolution = document.createElement("p"); resolution.setAttribute("role", "status");
  const originalWarning = document.createElement("p"); originalWarning.setAttribute("role", "status");
  properties.append(resolution, originalWarning);
  let details: FigureDetails | null = null;
  function updateResolution(): void {
    if (!details) return;
    const asset = details.asset;
    const pixels = asset.orientation >= 5 ? asset.height_px : asset.width_px;
    const tall = asset.orientation >= 5 ? asset.width_px : asset.height_px;
    const placed = Math.min(details.column_inches * (width.value === "half" ? .5 : 1), details.height_inches * pixels / tall);
    const dpi = pixels / placed;
    resolution.dataset.resolution = dpi < 200 ? "flag" : dpi < 300 ? "warning" : "accepted";
    resolution.textContent = t(dpi < 200 ? "figure.dpi-flag" : dpi < 300 ? "figure.dpi-warning" : "figure.dpi", { dpi: formatNumber(Math.floor(dpi)) });
  }
  width.addEventListener("change", updateResolution);
  shell.body.append(label, field, hint, properties, error, question);
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

  function focusTarget(): void {
    if (target?.kind === "figure") alt.focus(); else if (target) field.focus(); else view.focus();
  }
  function showSaveError(): void {
    error.textContent = t(target?.kind === "figure" ? "figure.failed" : "authoring.failed");
  }
  function answer(allowed: boolean): void {
    const resolve = leaving;
    leaving = null;
    leavePromise = null;
    question.hidden = true;
    discard.hidden = true;
    if (!allowed && target) focusTarget();
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
    if (!captured || busy || !options.canEdit() || (captured.kind === "figure" && !details)) return;
    const values = captured.kind === "figure" ? [caption.value, alt.value] : [field.value];
    if (values.some(value => new TextEncoder().encode(value).length > MAX_ATTRIBUTE_BYTES) || !view.state.doc.eq(captured.doc)) {
      showSaveError();
      return;
    }
    const attrs = captured.kind === "endnote" ? { id: captured.id, fmt: "text", body: field.value } : {
      id: captured.id, asset_id: captured.assetId, width: width.value, caption: caption.value, alt: alt.value,
    };
    const tr = view.state.tr;
    if (captured.inserted) {
      if (tr.doc.nodeAt(captured.pos)?.attrs.id !== captured.id) { showSaveError(); return; }
      const current = tr.doc.nodeAt(captured.pos)!;
      if (Object.entries(attrs).some(([key, value]) => current.attrs[key] !== value)) tr.setNodeMarkup(captured.pos, undefined, attrs);
    } else {
      if (captured.kind === "endnote") tr.insert(captured.pos, view.state.schema.nodes.endnote.create(attrs));
      else {
        tr.setSelection(TextSelection.near(tr.doc.resolve(captured.pos)));
        tr.replaceSelectionWith(view.state.schema.nodes.figure.create(attrs));
        let inserted = -1;
        tr.doc.descendants((node, pos) => { if (node.type.name === "figure" && node.attrs.id === captured.id) inserted = pos; });
        if (inserted < 0) { error.textContent = t("figure.failed"); return; }
        captured.pos = inserted;
        // The caret goes on past the figure, into a paragraph made for it when
        // the figure is the last block.
        appendTrailingTextblock(tr);
        tr.setSelection(TextSelection.near(tr.doc.resolve(inserted + tr.doc.nodeAt(inserted)!.nodeSize), 1));
      }
    }
    if (tr.docChanged && !isolated(tr)) { showSaveError(); return; }
    captured.inserted = true;
    captured.doc = view.state.doc;
    busy = true;
    save.disabled = cancel.disabled = discard.disabled = field.disabled = true;
    width.disabled = caption.disabled = alt.disabled = true;
    try {
      if (!await options.committed()) throw new Error("endnote save failed");
      if (alive && target === captured) finish(true, false);
    } catch {
      if (alive && target === captured) showSaveError();
    } finally {
      busy = false;
      save.disabled = cancel.disabled = discard.disabled = field.disabled = false;
      width.disabled = caption.disabled = alt.disabled = false;
    }
  }
  return {
    async figure(pos) {
      if (!options.canEdit() || target || !options.pickFigure || !options.figureDetails) return;
      const at = pos ?? view.state.selection.from;
      const node = pos !== undefined || view.state.selection instanceof NodeSelection ? view.state.doc.nodeAt(at) : null;
      const editing = node?.type.name === "figure";
      const captured = { kind: "figure" as const, pos: at, id: editing ? node.attrs.id as string : crypto.randomUUID(),
        assetId: editing ? node.attrs.asset_id as string : undefined, inserted: editing, doc: view.state.doc, before: view.state };
      target = captured;
      properties.hidden = false; label.hidden = field.hidden = hint.hidden = true;
      error.textContent = ""; details = null; resolution.textContent = ""; originalWarning.textContent = "";
      question.textContent = t("figure.leave");
      shell.setTitle(t(editing ? "figure.properties" : "figure.insert-title"));
      shell.closeButton.setAttribute("aria-label", t("panel.close", { title: t(editing ? "figure.properties" : "figure.insert-title") }));
      panel.setAttribute("aria-label", t(editing ? "figure.properties" : "figure.insert-title"));
      options.draftChanged(); busy = true;
      save.disabled = cancel.disabled = true;
      try {
        const asset = editing ? null : await options.pickFigure();
        if (!alive || target !== captured) return;
        if (!editing && !asset) { finish(true); return; }
        captured.assetId = editing ? captured.assetId : asset!.id;
        details = await options.figureDetails(captured.assetId!);
        if (!alive || target !== captured) return;
        width.value = editing ? node.attrs.width as string : "full";
        caption.value = editing ? node.attrs.caption as string : "";
        alt.value = editing ? node.attrs.alt as string : "";
        originalWarning.textContent = details.original_warning ? t("figure.original-warning") : "";
        updateResolution();
        panel.style.left = Math.max(8, (window.innerWidth - 360) / 2) + "px";
        panel.style.top = "80px"; panel.hidden = false; alt.focus();
      } catch (errorValue) { if (alive && target === captured) {
        const key = String(errorValue).includes("figure_symlink") ? "figure.symlink" : String(errorValue).includes("figure_retention_limit") ? "figure.retention-limit" : "figure.failed";
        error.textContent = t(key); panel.hidden = false;
      } }
      finally { busy = false; save.disabled = !details; cancel.disabled = false; }
    },
    note(pos) {
      if (!options.canEdit()) return;
      if (target) { focusTarget(); return; }
      const selected = view.state.selection;
      const at = pos ?? selected.from;
      const node = view.state.doc.nodeAt(at);
      const editing = node?.type.name === "endnote";
      if (!editing && !view.state.doc.resolve(at).parent.isTextblock) return;
      const number = noteNumberAt(view.state.doc, at, options.noteOffset());
      const title = t("authoring.reference", { number: formatNumber(number) });
      panel.setAttribute("aria-label", title);
      shell.setTitle(title);
      shell.closeButton.setAttribute("aria-label", t("panel.close", { title }));
      label.textContent = t("authoring.body", { number: formatNumber(number) });
      field.value = editing ? node.attrs.body as string : "";
      target = { kind: "endnote", pos: at, id: editing ? node.attrs.id as string : crypto.randomUUID(), inserted: editing, doc: view.state.doc, before: view.state };
      label.hidden = field.hidden = false; properties.hidden = true;
      save.disabled = false;
      question.textContent = t("authoring.leave");
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
      if (target || !(selection instanceof NodeSelection) || !["endnote", "figure", "scene_break"].includes(selection.node.type.name)) return;
      isolated(view.state.tr.deleteSelection());
    },
    pending: () => target !== null,
    confirmLeave() {
      if (!target) return Promise.resolve(true);
      if (leavePromise) return leavePromise;
      if (busy) return Promise.resolve(false);
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
