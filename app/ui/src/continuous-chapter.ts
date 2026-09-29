import { formatNumber, t } from "./i18n";
import { manuscriptItemsIn } from "./outline";
import { savedProse } from "./saved-prose";
import type { ProjectItem } from "./store/source";

export const CONTINUOUS_WINDOW = 20;

export interface ChapterWindow {
  scope: string;
  scenes: ProjectItem[];
  start: number;
  total: number;
}

/** Resolve by stable ids against the current canonical walk, never row offsets. */
function chapterScope(items: readonly ProjectItem[], activeId: string): { scope: string; scenes: ProjectItem[] } | null {
  const walk = manuscriptItemsIn(items);
  const context = new Map<string, { root: ProjectItem; chapter: ProjectItem | null }>();
  for (const item of walk) {
    const parent = item.parent_id === null ? undefined : context.get(item.parent_id);
    context.set(item.id, {
      root: parent?.root ?? item,
      chapter: item.type === "chapter" ? item : parent?.chapter ?? null,
    });
  }
  const active = walk.find((item) => item.id === activeId);
  const chosen = context.get(activeId);
  if (active?.type !== "scene" || chosen === undefined) return null;
  const key = (scope: { root: ProjectItem; chapter: ProjectItem | null }): string =>
    scope.chapter !== null ? `chapter:${scope.chapter.id}` : scope.root.type === "scene" ? "loose-root" : `root:${scope.root.id}`;
  const selectedKey = key(chosen);
  const scenes = walk.filter((item) => item.type === "scene" && context.get(item.id) !== undefined && key(context.get(item.id)!) === selectedKey);
  return { scope: chosen.chapter ? chosen.chapter.title : chosen.root.type === "scene" ? t("continuous.loose") : t("continuous.loose-in", { title: chosen.root.title }), scenes };
}

export function chapterWindow(items: readonly ProjectItem[], activeId: string, requestedStart?: number): ChapterWindow | null {
  const result = chapterScope(items, activeId);
  if (result === null) return null;
  const { scenes } = result;
  const activeIndex = scenes.findIndex((item) => item.id === activeId);
  const maxStart = Math.max(0, scenes.length - CONTINUOUS_WINDOW);
  const defaultStart = Math.min(activeIndex, maxStart);
  const start = requestedStart === undefined || activeIndex < requestedStart || activeIndex >= requestedStart + CONTINUOUS_WINDOW
    ? defaultStart
    : Math.max(0, Math.min(requestedStart, maxStart));
  return {
    scope: result.scope,
    scenes: scenes.slice(start, start + CONTINUOUS_WINDOW), start, total: scenes.length,
  };
}

export interface ContinuousChapter {
  enter(): boolean;
  exit(): void;
  activeChanged(id: string): void;
  setItems(items: readonly ProjectItem[]): void;
  beforeSwap(id: string, body: string): void;
  sourceChanged(id?: string): void;
  isOpen(): boolean;
  neighbor(direction: -1 | 1): void;
  page(direction: -1 | 1): void;
  /** True when a browser selection has an endpoint outside the one writer. */
  crossBoundarySelection(): boolean;
  destroy(): void;
}

export function createContinuousChapter(deps: {
  heading: HTMLElement;
  editor: HTMLElement;
  items: readonly ProjectItem[];
  activeId(): string;
  readDocument(id: string): Promise<{ body: string; rev: number }>;
  activate(id: string): Promise<void>;
  onReturn(): void;
  onError(error: unknown): void;
}): ContinuousChapter {
  let items = deps.items;
  let open = false;
  let destroyed = false;
  let requestedStart: number | undefined;
  let generation = 0;
  const bodies = new Map<string, string>();
  const toolbar = document.createElement("div");
  toolbar.className = "continuous-toolbar";
  const before = document.createElement("div");
  before.className = "continuous-before";
  const after = document.createElement("div");
  after.className = "continuous-after";
  toolbar.hidden = before.hidden = after.hidden = true;
  deps.heading.before(toolbar, before);
  deps.editor.after(after);

  function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }

  function render(): void {
    if (!open || destroyed) return;
    const request = ++generation;
    const activeId = deps.activeId();
    const projection = chapterWindow(items, activeId, requestedStart);
    if (projection === null) { api.exit(); return; }
    requestedStart = projection.start;
    const visible = new Set(projection.scenes.map((item) => item.id));
    for (const id of bodies.keys()) if (!visible.has(id)) bodies.delete(id);
    const activeIndex = projection.scenes.findIndex((item) => item.id === activeId);
    const prior = projection.scenes.slice(0, activeIndex);
    const later = projection.scenes.slice(activeIndex + 1);
    const scope = document.createElement("span");
    scope.className = "continuous-scope";
    scope.textContent = t("continuous.scope", { title: projection.scope });
    const count = document.createElement("span");
    count.className = "continuous-count";
    count.textContent = t("continuous.window", {
      first: formatNumber(projection.start + 1),
      last: formatNumber(projection.start + projection.scenes.length),
      total: formatNumber(projection.total),
    });
    const previous = button(t("continuous.previous"), () => api.page(-1), projection.start === 0);
    const next = button(t("continuous.next"), () => api.page(1), projection.start + projection.scenes.length >= projection.total);
    const active = document.createElement("strong");
    active.textContent = t("continuous.editing", { title: projection.scenes[activeIndex]?.title ?? "" });
    toolbar.replaceChildren(scope, count, active, previous, next, button(t("continuous.return"), deps.onReturn));
    const paint = (host: HTMLElement, scenes: ProjectItem[]): void => {
      host.replaceChildren();
      for (const item of scenes) {
        const article = document.createElement("article");
        article.className = "continuous-scene";
        article.dataset.itemId = item.id;
        const title = document.createElement("h2");
        title.append(button(item.title, () => {
          if (!open || destroyed || chapterWindow(items, deps.activeId(), requestedStart)?.scenes.some((scene) => scene.id === item.id) !== true) return;
          void deps.activate(item.id);
        }));
        const prose = document.createElement("div");
        prose.className = "continuous-prose";
        prose.setAttribute("contenteditable", "false");
        const body = bodies.get(item.id);
        if (body === undefined) {
          prose.textContent = t("continuous.loading");
          void deps.readDocument(item.id).then((loaded) => {
            if (destroyed || !open || request !== generation || deps.activeId() === item.id || !article.isConnected) return;
            if (!bodies.has(item.id)) bodies.set(item.id, loaded.body);
            const fragment = savedProse(bodies.get(item.id)!, document);
            prose.replaceChildren(fragment ?? document.createTextNode(t("continuous.unavailable")));
          }).catch((error: unknown) => {
            if (destroyed || !open || request !== generation || !article.isConnected) return;
            prose.textContent = t("continuous.unavailable");
            deps.onError(error);
          });
        } else {
          prose.replaceChildren(savedProse(body, document) ?? document.createTextNode(t("continuous.unavailable")));
        }
        article.append(title, prose);
        host.append(article);
      }
    };
    paint(before, prior);
    paint(after, later);
  }

  const api: ContinuousChapter = {
    enter() {
      if (destroyed || chapterWindow(items, deps.activeId()) === null) return false;
      open = true;
      toolbar.hidden = before.hidden = after.hidden = false;
      document.body.dataset.continuousOpen = "true";
      render();
      return true;
    },
    exit() {
      open = false;
      ++generation;
      requestedStart = undefined;
      bodies.clear();
      toolbar.hidden = before.hidden = after.hidden = true;
      before.replaceChildren();
      after.replaceChildren();
      delete document.body.dataset.continuousOpen;
    },
    activeChanged(id) { if (open) { bodies.delete(id); render(); } },
    setItems(next) { items = next; if (open) render(); },
    beforeSwap(id, body) { if (open) bodies.set(id, body); },
    sourceChanged(id) { if (id === undefined) bodies.clear(); else bodies.delete(id); if (open) render(); },
    isOpen: () => open,
    neighbor(direction) {
      if (!open) return;
      const activeId = deps.activeId();
      const scoped = chapterScope(items, activeId)?.scenes ?? [];
      const index = scoped.findIndex((item) => item.id === activeId);
      const target = scoped[index + direction];
      if (target) void deps.activate(target.id);
    },
    page(direction) {
      if (!open) return;
      const activeId = deps.activeId();
      const scope = chapterScope(items, activeId);
      const projection = chapterWindow(items, activeId, requestedStart);
      if (scope === null || projection === null) return;
      const index = direction < 0 ? Math.max(0, projection.start - CONTINUOUS_WINDOW) : Math.min(scope.scenes.length - 1, projection.start + CONTINUOUS_WINDOW);
      const target = scope.scenes[index];
      if (target && target.id !== activeId) void deps.activate(target.id);
    },
    crossBoundarySelection() {
      if (!open) return false;
      const selection = document.getSelection();
      if (selection === null || selection.isCollapsed || selection.anchorNode === null || selection.focusNode === null) return false;
      return !deps.editor.contains(selection.anchorNode) || !deps.editor.contains(selection.focusNode);
    },
    destroy() { api.exit(); destroyed = true; toolbar.remove(); before.remove(); after.remove(); },
  };
  return api;
}
