import { element } from "./element";
import type { MobileDrafting } from "./drafting";
import { mobileMessages } from "./messages";
import { showTransfer, transferError, type TransferStatus } from "./transfer";
import { createIcon } from "../../ui/src/icons";
import { openingScene, readWritingPosition, writeWritingPosition, type WritingPosition } from "./position";
import type { MobileDocument, MobileScene, MobileWorkspace } from "./workspace";
import type { FlushAck } from "../../ui/src/store/flush";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface OpenBook { id: string; name: string; generation: number; scenes: MobileScene[] }
interface Catalog { books: { id: string; name: string; unavailable?: boolean; unsupported?: boolean; newer_schema?: boolean; imported?: boolean }[]; current_id?: string; generation?: number; retained_transfers?: number; transfers_available?: boolean; transfer?: TransferStatus }
const locale = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
window.__appLocale = locale;
const m = mobileMessages(locale);
document.documentElement.lang = locale;
const native = (window as Window & { __TAURI__?: { core: { invoke: Invoke } } }).__TAURI__;
const appearanceBridge = (window as Window & { garretAppearance?: { current(): string; set(value: string): void; textSize?(): number; setTextSize?(value: number): boolean } }).garretAppearance;
const lifecycle = window as Window & { __mobileWriting?: boolean };
window.addEventListener("mobile-back", () => workspace?.back());
let workspace: MobileWorkspace | undefined;
const savedTheme = appearanceBridge?.current();
let theme: "light" | "dark" = savedTheme === "light" || savedTheme === "dark"
  ? savedTheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let busy = false;
const mount = document.querySelector<HTMLElement>("#app")!;

function message(text: string) {
  const alert = mount.querySelector<HTMLElement>("[role=alert]");
  if (alert) { alert.textContent = text; alert.hidden = false; }
}
function setBusy(value: boolean) {
  busy = value;
  mount.setAttribute("aria-busy", String(value));
  for (const control of mount.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = value || control.dataset.unavailable === "true";
}
async function open(command: "mobile_open" | "mobile_create", args: Record<string, unknown>) {
  if (busy || !native) return;
  setBusy(true);
  let opened: OpenBook | undefined;
  try {
    const book = await native.core.invoke<OpenBook>(command, args);
    opened = book;
    let position: WritingPosition | undefined;
    let positionUnavailable = false;
    try { position = readWritingPosition(localStorage, book.id); }
    catch { positionUnavailable = true; }
    const first = openingScene(book.scenes, position);
    if (!first) throw new Error("No writing scene");
    const generation = book.generation;
    const initial = await native.core.invoke<MobileDocument>("mobile_document", { generation, itemId: first.id });
    const { createMobileWorkspace } = await import("./workspace");
    // Build before retiring the library, so malformed content leaves recovery UI.
    const container = element("div");
    workspace = createMobileWorkspace(container, {
      figurePreview: (itemId, instanceId, assetId) => native.core.invoke<import("../../ui/src/document-reader").FigurePreview>("mobile_figure_preview", { generation, itemId, instanceId, assetId }),
      bookTitle: book.name || m.unnamedBook, locale, theme, scenes: book.scenes, initial,
      initialPosition: position?.sceneId === first.id ? position : undefined,
      positionUnavailable,
      savePosition: position => writeWritingPosition(localStorage, book.id, position),
      loadDoc: itemId => native.core.invoke<MobileDocument>("mobile_document", { generation, itemId }),
      flush: (entries, attribution) => native.core.invoke<FlushAck[]>("mobile_flush", { generation, entries, attribution }),
      createScene: (title, currentSceneId) => native.core.invoke<{ scenes: MobileScene[]; item_id: string }>("mobile_scene_create", { generation, title, currentSceneId }),
      textSize: appearanceBridge?.textSize?.() ?? 19,
      saveTextSize: size => appearanceBridge?.setTextSize?.(size) ?? false,
      drafting: {
        structure: () => native.core.invoke<Awaited<ReturnType<MobileDrafting["structure"]>>>("mobile_structure", { generation }),
        rename: (itemId, title, baseRev) => native.core.invoke<Awaited<ReturnType<MobileDrafting["rename"]>>>("mobile_scene_rename", { generation, itemId, title, baseRev }),
        move: (itemId, newParentId, afterId, baseRev) => native.core.invoke<Awaited<ReturnType<MobileDrafting["move"]>>>("mobile_scene_move", { generation, itemId, newParentId, afterId, baseRev }),
        find: (query, currentScene) => native.core.invoke<Awaited<ReturnType<MobileDrafting["find"]>>>("mobile_find", { generation, query, currentScene }),
        goals: (day, target) => native.core.invoke<Awaited<ReturnType<MobileDrafting["goals"]>>>("mobile_goals", { generation, day, target: target ?? null }),
        notes: itemId => native.core.invoke<Awaited<ReturnType<MobileDrafting["notes"]>>>("mobile_scene_notes", { generation, itemId }),
        saveNotes: (itemId, body) => native.core.invoke("mobile_scene_notes_set", { generation, itemId, body }),
        reference: () => native.core.invoke<Awaited<ReturnType<MobileDrafting["reference"]>>>("mobile_reference", { generation }),
        comments: itemId => native.core.invoke<Awaited<ReturnType<MobileDrafting["comments"]>>>("mobile_comments", { generation, itemId }),
        resolve: (itemId, commentId) => native.core.invoke<Awaited<ReturnType<MobileDrafting["resolve"]>>>("mobile_comment_resolve", { generation, itemId, commentId }),
      },
      localDay: () => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      },
      exportBook: () => showTransfer(container, { invoke: native.core.invoke, locale, theme, direction: "export", generation }),
      beforeLeave: () => native.core.invoke<void>("mobile_close", { generation }),
      onLeave: () => {
        workspace = undefined;
        lifecycle.__mobileWriting = false;
        void library();
      },
    });
    mount.replaceChildren(container);
    lifecycle.__mobileWriting = true;
  } catch (error) {
    let failure = String(error) === "unsupported_schema" ? m.unsupportedSchema
      : String(error) === "unsupported_project_preset" ? m.unsupportedPreset
      : error instanceof Error && error.message === m.unsupported ? m.unsupported : m.operationError;
    if (opened) {
      try { await native.core.invoke("mobile_close", { generation: opened.generation }); }
      catch { failure = m.closeError; }
    }
    message(failure);
  }
  finally { setBusy(false); }
}

async function library(errorText?: string, resumeOpen = true) {
  const root = element("section");
  root.className = "mobile-workspace mobile-library";
  root.dataset.theme = theme;
  const header = element("header");
  const wordmark = element("span");
  wordmark.className = "mobile-wordmark";
  wordmark.setAttribute("aria-hidden", "true");
  const title = element("h1", m.libraryTitle);
  header.append(wordmark);
  const appearance = element("button");
  appearance.className = "mobile-appearance";
  appearance.append(createIcon(theme === "dark" ? "sun" : "moon"));
  appearance.type = "button";
  appearance.setAttribute("aria-label", `${m.appearance}: ${theme === "dark" ? m.light : m.dark}`);
  appearance.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    appearanceBridge?.set(theme);
    void library();
  });
  header.append(appearance);
  const error = element("p", errorText ?? "");
  error.setAttribute("role", "alert"); error.hidden = !errorText;
  root.append(header, title, element("p", m.libraryHint), error);
  mount.replaceChildren(root);
  if (!native) { error.textContent = m.nativeRequired; error.hidden = false; return; }
  setBusy(true);
  try {
    const catalog = await native.core.invoke<Catalog>("mobile_catalog");
    if (catalog.transfer) {
      setBusy(false);
      await showTransfer(root, { invoke: native.core.invoke, locale, theme, direction: catalog.current_id ? "export" : "import", generation: catalog.generation ?? 0, existing: catalog.transfer });
      await library();
      return;
    }
    if (catalog.current_id && resumeOpen) {
      setBusy(false);
      await open("mobile_open", { id: catalog.current_id });
      if (!workspace) await library(error.textContent || m.operationError, false);
      return;
    }
    const list = element("nav"); list.setAttribute("aria-label", m.books);
    for (const book of catalog.books) {
      const button = element("button");
      button.type = "button";
      const cover = element("span", book.unavailable ? "" : (Array.from(book.name.trim())[0] ?? ""));
      cover.className = "mobile-book-cover";
      cover.setAttribute("aria-hidden", "true");
      const bookTitle = element("span", book.newer_schema ? m.unsupportedSchema : book.unsupported ? m.unsupportedPreset : book.unavailable ? m.unavailableBook : book.name || m.unnamedBook);
      bookTitle.className = "mobile-book-name";
      if (book.imported) bookTitle.append(element("small", m.importedCopy));
      button.append(cover, bookTitle);
      if (book.unavailable) {
        button.dataset.unavailable = "true";
        button.disabled = true;
      } else button.addEventListener("click", () => { void open("mobile_open", { id: book.id }); });
      list.append(button);
    }
    if (catalog.books.length === 0) root.append(element("p", m.empty));
    const form = element("form");
    const label = element("label", m.bookName);
    const input = element("input"); input.name = "title"; input.required = true; input.maxLength = 120;
    label.append(input);
    const submit = element("button", m.create); submit.type = "submit";
    form.append(element("h2", m.newBook), label, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const name = input.value.trim();
      if (name) void open("mobile_create", { name });
    });
    const transfer = element("button", m.importBook); transfer.type = "button";
    transfer.addEventListener("click", () => {
      if (busy) return;
      setBusy(true);
      void showTransfer(root, { invoke: native.core.invoke, locale, theme, direction: "import", generation: catalog.generation ?? 0 })
        .then(() => library()).catch(error => message(transferError(error, locale))).finally(() => setBusy(false));
    });
    if (catalog.transfers_available === false) {
      transfer.dataset.unavailable = "true"; transfer.disabled = true;
      root.append(element("p", m.transferDisabled));
    }
    root.append(form, transfer, list);
    if (catalog.retained_transfers) {
      root.append(element("p", m.transferRetained));
      const discard = element("button", m.discardTransfers); discard.type = "button";
      discard.addEventListener("click", () => {
        if (busy) return;
        setBusy(true);
        void native.core.invoke("mobile_transfer_discard").then(() => library())
          .catch(error => message(transferError(error, locale))).finally(() => setBusy(false));
      });
      root.append(discard);
    }
  } catch { message(m.operationError); }
  finally { setBusy(false); }
}

void library();
