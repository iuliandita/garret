import { mobileMessages } from "./messages";
import { createIcon } from "../../ui/src/icons";
import { openingScene, readWritingPosition, writeWritingPosition, type WritingPosition } from "./position";
import type { MobileDocument, MobileScene, MobileWorkspace } from "./workspace";
import type { FlushAck } from "../../ui/src/store/flush";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface OpenBook { id: string; name: string; generation: number; scenes: MobileScene[] }
interface Catalog { books: { id: string; name: string; unavailable?: boolean }[]; current_id?: string }
const locale = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
window.__appLocale = locale;
const m = mobileMessages(locale);
document.documentElement.lang = locale;
const native = (window as Window & { __TAURI__?: { core: { invoke: Invoke } } }).__TAURI__;
const appearanceBridge = (window as Window & { garretAppearance?: { current(): string; set(value: string): void } }).garretAppearance;
const lifecycle = window as Window & { __mobileWriting?: boolean };
window.addEventListener("mobile-back", () => workspace?.back());
let workspace: MobileWorkspace | undefined;
const savedTheme = appearanceBridge?.current();
let theme: "light" | "dark" = savedTheme === "light" || savedTheme === "dark"
  ? savedTheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let busy = false;
const mount = document.querySelector<HTMLElement>("#app")!;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
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
      bookTitle: book.name, locale, theme, scenes: book.scenes, initial,
      initialPosition: position?.sceneId === first.id ? position : undefined,
      positionUnavailable,
      savePosition: position => writeWritingPosition(localStorage, book.id, position),
      loadDoc: itemId => native.core.invoke<MobileDocument>("mobile_document", { generation, itemId }),
      flush: (entries, attribution) => native.core.invoke<FlushAck[]>("mobile_flush", { generation, entries, attribution }),
      createScene: title => native.core.invoke<{ scenes: MobileScene[]; item_id: string }>("mobile_scene_create", { generation, title }),
      localDay: () => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      },
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
    let failure = error instanceof Error && error.message === m.unsupported ? m.unsupported : m.operationError;
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
      const bookTitle = element("span", book.unavailable ? m.unavailableBook : book.name);
      bookTitle.className = "mobile-book-name";
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
    root.append(form, list);
  } catch { message(m.operationError); }
  finally { setBusy(false); }
}

void library();
