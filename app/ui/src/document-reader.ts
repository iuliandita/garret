import { Plugin } from "prosemirror-state";
import { isHistoryTransaction } from "prosemirror-history";
import type { Transaction } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import type { EditorView, NodeViewConstructor } from "prosemirror-view";
import { t, formatNumber } from "./i18n";

export interface FigurePreview { state: string; data_uri: string | null }
export type LoadFigurePreview = (instanceId: string, assetId: string) => Promise<FigurePreview>;

const cachedAtoms = new WeakMap<PmNode, readonly string[]>();
function atomsIn(node: PmNode): readonly string[] {
  const cached = cachedAtoms.get(node);
  if (cached) return cached;
  const atoms: string[] = [];
  if (["endnote", "figure", "scene_break"].includes(node.type.name)) atoms.push(JSON.stringify(node.toJSON()));
  else node.forEach(child => { for (const atom of atomsIn(child)) atoms.push(atom); });
  cachedAtoms.set(node, atoms);
  return atoms;
}

export function atomSignature(doc: PmNode): string {
  return JSON.stringify(atomsIn(doc));
}

/** Reader builds permit prose edits, but never manufacture or change atoms. */
export function mayChangeAtoms(tr: Transaction, authoring = false): boolean {
  return authoring && (tr.getMeta("documentAuthoring") === true || isHistoryTransaction(tr));
}

export function preserveAtoms(authoring = false): Plugin {
  return new Plugin({
    filterTransaction: (tr, state) => !tr.docChanged || mayChangeAtoms(tr, authoring) || atomSignature(tr.doc) === atomSignature(state.doc),
  });
}

export function readerViews(load?: LoadFigurePreview, options: {
  editFigure?: (pos: number) => void;
  editNote?: (pos: number) => void;
  noteOffset?: () => number;
} = {}): Record<string, NodeViewConstructor> {
  return {
    endnote(node, view: EditorView, getPos) {
      const dom = document.createElement("span");
      dom.className = "document-endnote-reader";
      dom.contentEditable = "false";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.endnoteId = node.attrs.id as string;
      let number = (options.noteOffset?.() ?? 0) + 1;
      const pos = getPos();
      if (pos !== undefined) view.state.doc.nodesBetween(0, pos, child => { if (child.type.name === "endnote") number++; });
      button.textContent = formatNumber(number);
      button.setAttribute("aria-label", t(options.editNote ? "authoring.reference" : "document.note-reference", { number: formatNumber(number) }));
      button.setAttribute("aria-expanded", "false");
      const body = document.createElement("span");
      body.className = "document-endnote-body";
      body.textContent = node.attrs.body as string;
      body.hidden = true;
      const close = () => { body.hidden = true; button.setAttribute("aria-expanded", "false"); };
      button.addEventListener("click", () => {
        const position = getPos();
        if (options.editNote && position !== undefined) { options.editNote(position); return; }
        body.hidden = !body.hidden; button.setAttribute("aria-expanded", String(!body.hidden)); });
      dom.addEventListener("keydown", event => { if (event.key === "Escape") { close(); button.focus(); event.preventDefault(); event.stopPropagation(); } });
      dom.append(button, body);
      return { dom, stopEvent: () => true, ignoreMutation: () => true };
    },
    figure(node, _view, getPos) {
      const dom = document.createElement("figure");
      dom.className = "document-figure";
      dom.dataset.width = node.attrs.width as string;
      dom.contentEditable = "false";
      const placeholder = document.createElement("span");
      placeholder.textContent = t("document.figure-placeholder");
      const caption = document.createElement("figcaption");
      caption.textContent = node.attrs.caption as string;
      const alt = document.createElement("span");
      alt.className = "document-figure-alt";
      alt.textContent = node.attrs.alt as string;
      dom.append(placeholder, caption, alt);
      if (options.editFigure) {
        const edit = document.createElement("button"); edit.type = "button"; edit.textContent = t("figure.properties");
        edit.addEventListener("click", () => { const pos = getPos(); if (pos !== undefined) options.editFigure?.(pos); });
        dom.append(edit);
      }
      let alive = true;
      let started = false;
      const start = () => {
        if (!alive || started || !load) return;
        started = true;
        void load(node.attrs.id as string, node.attrs.asset_id as string).then(preview => {
          if (!alive) return;
          if (preview.state === "save_failed") {
            placeholder.textContent = t("document.figure-save-failed");
            return;
          }
          if (preview.state !== "present" || !preview.data_uri?.startsWith("data:image/")) return;
          const image = document.createElement("img");
          image.src = preview.data_uri;
          image.alt = node.attrs.alt as string;
          placeholder.replaceWith(image);
        }).catch(() => { /* The named placeholder retains a failed preview. */ });
      };
      const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start(); }
      });
      if (observer) observer.observe(dom); else start();
      return { dom, stopEvent: event => event.target instanceof Element && event.target.closest("button") !== null,
        ignoreMutation: () => true, destroy() { alive = false; observer?.disconnect(); } };
    },
  };
}

export function refreshNoteReferences(view: EditorView, offset: number, editable = false): void {
  const numbers = new Map<string, number>();
  view.state.doc.descendants(node => {
    if (node.type.name === "endnote") numbers.set(node.attrs.id as string, offset + numbers.size + 1);
  });
  for (const button of view.dom.querySelectorAll<HTMLButtonElement>("button[data-endnote-id]")) {
    const number = numbers.get(button.dataset.endnoteId!);
    if (number === undefined) continue;
    button.textContent = formatNumber(number);
    button.setAttribute("aria-label", t(editable ? "authoring.reference" : "document.note-reference", { number: formatNumber(number) }));
  }
}
