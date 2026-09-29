import { createEditor, schema, countWordsIn, type Editor } from "../../ui/src/editor";
import { flushAnchorsFor, MAX_MAPPED_COMMENTS, type CommentAnchor } from "../../ui/src/comments";
import { parseReviewBody } from "../../ui/src/review-fragments";
import { createSession, type Session } from "../../ui/src/session";
import { createFlushScheduler, type FlushEntry, type FlushAck, type FlushAttribution } from "../../ui/src/store/flush";
import { mobileMessages } from "./messages";

export interface MobileDocument {
  item_id: string;
  body: string;
  rev: number;
  comments: readonly CommentAnchor[];
}
export interface MobileScene { id: string; title: string; depth: number }
export interface MobileWorkspaceOptions {
  bookTitle: string;
  locale: "en" | "de";
  theme: "light" | "dark";
  scenes: readonly MobileScene[];
  initial: MobileDocument;
  // The native adapter captures the project generation. Never read a later
  // global project identity when a delayed save reaches this boundary.
  loadDoc(itemId: string): Promise<MobileDocument>;
  flush(entries: FlushEntry[], attribution?: FlushAttribution[]): Promise<FlushAck[]>;
  createScene?(title: string): Promise<{ scenes: MobileScene[]; item_id: string }>;
  localDay(): string;
  beforeLeave?(): Promise<void>;
  onLeave(): void;
}
export interface MobileWorkspace {
  readonly editor: Editor;
  openScene(itemId: string): Promise<boolean>;
  drain(): Promise<boolean>;
  close(): Promise<boolean>;
  back(): void;
}

export function createMobileWorkspace(mount: HTMLElement, opts: MobileWorkspaceOptions): MobileWorkspace {
  const m = mobileMessages(opts.locale);
  let scenes = [...opts.scenes];
  function checked(doc: MobileDocument, expectedId: string) {
    if (doc.item_id !== expectedId || !Number.isSafeInteger(doc.rev) || doc.rev < 0) throw new Error(m.unsupported);
    try {
      const parsed = parseReviewBody(doc.body, schema);
      const ids = new Set<number>();
      if (doc.comments.length > MAX_MAPPED_COMMENTS) throw new Error(m.unsupported);
      for (const anchor of doc.comments) {
        if (!Number.isSafeInteger(anchor.id) || ids.has(anchor.id)
          || !Number.isSafeInteger(anchor.from) || !Number.isSafeInteger(anchor.to)
          || anchor.from < 0 || anchor.to < 0 || anchor.from > parsed.content.size
          || anchor.to > parsed.content.size || typeof anchor.resolved !== "boolean") throw new Error(m.unsupported);
        ids.add(anchor.id);
      }
      return parsed.toJSON();
    }
    catch { throw new Error(m.unsupported); }
  }
  const initial = checked(opts.initial, opts.initial.item_id);
  if (!opts.scenes.some(scene => scene.id === opts.initial.item_id)) throw new Error(m.unsupported);
  const root = document.createElement("section");
  root.className = "mobile-workspace";
  root.dataset.theme = opts.theme;
  root.lang = opts.locale;
  root.innerHTML = `<header class="mobile-header"><button type="button" data-action="books"></button><div class="mobile-book-title"></div><button type="button" data-action="outline"></button></header>
    <div class="mobile-error" role="alert" hidden></div>
    <main class="mobile-page"><h1 class="mobile-scene-title"></h1><div class="mobile-prose"></div></main>
    <div class="mobile-tools" role="group"></div>
    <footer class="mobile-footer"><span class="mobile-save" role="status"></span><span class="mobile-words"></span></footer>
    <dialog class="mobile-outline"><header><h2></h2><button type="button" data-action="close-outline"></button></header><nav></nav></dialog>`;
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const books = get<HTMLButtonElement>('[data-action="books"]');
  const outlineButton = get<HTMLButtonElement>('[data-action="outline"]');
  const outline = get<HTMLDialogElement>("dialog");
  const error = get(".mobile-error");
  const heading = get(".mobile-scene-title");
  const save = get(".mobile-save");
  const words = get(".mobile-words");
  const tools = get(".mobile-tools");
  books.textContent = m.books;
  outlineButton.textContent = m.outline;
  outlineButton.setAttribute("aria-haspopup", "dialog");
  outline.setAttribute("aria-label", m.outline);
  get(".mobile-book-title").textContent = opts.bookTitle;
  get(".mobile-outline h2").textContent = m.outline;
  get('[data-action="close-outline"]').textContent = m.close;
  tools.setAttribute("aria-label", m.writing);
  let session: Session;
  let editor: Editor;
  let busy = false;
  let closed = false;
  let countFrame: number | undefined;
  const markButtons = new Map<string, HTMLButtonElement>();
  const showError = (message: string) => {
    error.textContent = message;
    error.hidden = false;
    if (flusher.failed()) {
      const copy = document.createElement("button"); copy.type = "button"; copy.textContent = m.recoverText;
      copy.addEventListener("click", () => {
        const recovery = document.createElement("dialog"); recovery.className = "mobile-outline mobile-recovery";
        recovery.setAttribute("aria-label", m.recoverText);
        const hint = document.createElement("p"); hint.textContent = m.recoveryHint;
        const field = document.createElement("textarea"); field.readOnly = true;
        field.setAttribute("aria-label", m.recoverText);
        const doc = schema.nodeFromJSON(JSON.parse(editor.serialize()));
        field.value = doc.textBetween(0, doc.content.size, "\n\n");
        const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = m.close;
        dismiss.addEventListener("click", () => recovery.close());
        recovery.addEventListener("close", () => recovery.remove(), { once: true });
        recovery.append(hint, field, dismiss); root.append(recovery); recovery.showModal(); field.focus(); field.select();
      });
      error.append(copy);
    }
  };
  const flusher = createFlushScheduler({
    invoke: (entries, attribution) => opts.flush(entries, attribution),
    commentsOf: id => flushAnchorsFor(session.activeDocId(), id, editor.commentsCapped(), editor.commentAnchors()),
    wordCountOf: body => countWordsIn(schema.nodeFromJSON(JSON.parse(body))),
    localDay: opts.localDay,
    onFailure: () => showError(m.saveError),
    onStateChange: state => { save.textContent = m[state]; save.dataset.state = state; },
  });
  function refreshCount() {
    words.textContent = `${editor.wordCount().toLocaleString(opts.locale)} ${m.words}`;
  }
  function refresh() {
    if (!editor) return;
    const marks = editor.activeMarks();
    for (const [key, button] of markButtons) button.setAttribute("aria-pressed", String(marks[key as keyof typeof marks]));
  }
  editor = createEditor(get(".mobile-prose"), { kind: "pmjson", json: initial }, {
    onChange: change => {
      session.noteChange(change);
      if (countFrame === undefined) countFrame = requestAnimationFrame(() => {
        countFrame = undefined;
        if (!closed) refreshCount();
      });
    }, onStateChange: refresh,
  });
  const loading: { incoming?: MobileDocument } = {};
  const loadedDocument = (): MobileDocument | undefined => loading.incoming;
  session = createSession({
    editor, flusher, docId: opts.initial.item_id,
    loadDoc: async id => {
      const doc = await opts.loadDoc(id);
      checked(doc, id);
      loading.incoming = doc;
      return doc;
    },
  });
  flusher.register(opts.initial.item_id, opts.initial.rev);
  editor.setCommentAnchors(opts.initial.comments);
  save.textContent = m.saved;
  save.dataset.state = "saved";
  const actions: [string, string, () => void, string?][] = [
    ["B", m.bold, () => editor.toggleBold(), "bold"],
    ["I", m.italic, () => editor.toggleItalic(), "italic"],
    ["U", m.underline, () => editor.toggleUnderline(), "underline"],
    ["↶", m.undo, () => editor.undo()], ["↷", m.redo, () => editor.redo()],
  ];
  for (const [label, name, action, mark] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", name);
    button.title = name;
    button.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("click", () => { if (!busy && !closed) { action(); editor.focus(); } });
    if (mark) markButtons.set(mark, button);
    tools.append(button);
  }
  const sceneButtons = new Map<string, HTMLButtonElement>();
  function drawScenes() {
    sceneButtons.clear();
    get(".mobile-outline nav").replaceChildren();
    for (const scene of scenes) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = scene.title || m.untitled;
    button.style.paddingInlineStart = `${16 + Math.min(Math.max(scene.depth, 0), 4) * 12}px`;
    button.addEventListener("click", () => { void openScene(scene.id); });
    sceneButtons.set(scene.id, button);
    get(".mobile-outline nav").append(button);
    }
  }
  drawScenes();
  if (opts.createScene) {
    const form = document.createElement("form");
    const label = document.createElement("label"); label.textContent = m.sceneTitle;
    const input = document.createElement("input"); input.required = true; input.maxLength = 120;
    label.append(input);
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = m.addScene;
    form.append(label, submit);
    outline.append(form);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title || busy || closed) return;
      void (async () => {
        setBusy(true);
        try {
          if (!await drain()) { showError(m.saveError); return; }
          const result = await opts.createScene!(title);
          if (!result.scenes.some(scene => scene.id === result.item_id)
            || !result.scenes.some(scene => scene.id === session.activeDocId())) throw new Error(m.openError);
          scenes = result.scenes;
          drawScenes();
          input.value = "";
          setBusy(false);
          if (!await openScene(result.item_id)) showError(m.openError);
        } catch { showError(m.operationError); }
        finally { setBusy(false); }
      })();
    });
  }
  function sceneChanged() {
    const id = session.activeDocId();
    heading.textContent = scenes.find(scene => scene.id === id)?.title || m.untitled;
    for (const [sceneId, button] of sceneButtons) {
      if (sceneId === id) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    refresh();
    refreshCount();
  }
  function setBusy(value: boolean) {
    busy = value;
    editor.setEditable(!value);
    root.setAttribute("aria-busy", String(value));
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
  }
  async function openScene(id: string): Promise<boolean> {
    if (closed || busy || !sceneButtons.has(id)) return false;
    if (flusher.failed()) { showError(m.saveError); return false; }
    setBusy(true);
    loading.incoming = undefined;
    try {
      const result = await session.switchTo(id);
      if (result !== "switched" && result !== "same") {
        showError(flusher.failed() ? m.saveError : m.openError);
        return false;
      }
      const loaded = loadedDocument();
      if (result === "switched" && loaded) editor.setCommentAnchors(loaded.comments);
      error.hidden = true;
      sceneChanged();
      if (outline.open) outline.close();
      return true;
    } finally { setBusy(false); }
  }
  async function drain() {
    if (closed) return true;
    await session.flushPending();
    return !flusher.failed();
  }
  async function close() {
    if (closed) return true;
    if (busy) return false;
    setBusy(true);
    if (!await drain()) { setBusy(false); return false; }
    try { await opts.beforeLeave?.(); }
    catch { showError(m.closeError); setBusy(false); return false; }
    closed = true;
    flusher.stop();
    if (countFrame !== undefined) cancelAnimationFrame(countFrame);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onBackground);
    window.removeEventListener("mobile-background", onBackground);
    editor.destroy();
    root.remove();
    return true;
  }
  const onBackground = () => { void drain(); };
  const onVisibility = () => { if (document.visibilityState === "hidden") onBackground(); };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onBackground);
  window.addEventListener("mobile-background", onBackground);
  books.addEventListener("click", () => { void close().then(ok => { if (ok) opts.onLeave(); }); });
  outlineButton.addEventListener("click", () => outline.showModal());
  get('[data-action="close-outline"]').addEventListener("click", () => outline.close());
  sceneChanged();
  mount.append(root);
  return { editor, openScene, drain, close, back() {
    if (outline.open) outline.close();
    else books.click();
  } };
}
