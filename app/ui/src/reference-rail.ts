import { isCompositionKey } from "./composition-key";
import { formatNumber, t } from "./i18n";
import { proseItem, savedProse } from "./saved-prose";
import type { ProjectItem } from "./store/source";

export interface ReferenceRail {
  open(item: ProjectItem): Promise<void>;
  close(): void;
  isOpen(): boolean;
  sourceChanged(id: string): void;
  invalidateAll(): void;
  setItems(items: readonly ProjectItem[]): void;
  destroy(): void;
}

export function createReferenceRail(deps: {
  container: HTMLElement;
  drain(): Promise<void>;
  failed(): boolean;
  load(id: string): Promise<{ body: string; rev: number }>;
  openSource(id: string): void;
  onDismiss(): void;
  onNotice(message: string): void;
}): ReferenceRail {
  const doc = deps.container.ownerDocument;
  const rail = doc.createElement("aside");
  rail.id = "reference-rail";
  rail.setAttribute("role", "complementary");
  rail.setAttribute("aria-label", t("reference.label"));
  rail.hidden = true;
  const head = doc.createElement("div");
  head.className = "reference-head";
  const title = doc.createElement("h2");
  title.tabIndex = -1;
  const revision = doc.createElement("p");
  revision.className = "reference-revision";
  const body = doc.createElement("div");
  body.classList.add("saved-prose", "reference-body");
  const action = (key: string, run: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = t(key);
    button.addEventListener("click", run);
    return button;
  };
  const refresh = action("reference.refresh", () => { void reload(); });
  refresh.id = "reference-refresh";
  const openSource = action("reference.open-source", () => { if (pin !== null) deps.openSource(pin.id); });
  openSource.id = "reference-open-source";
  const close = action("reference.close", () => api.close());
  close.id = "reference-close";
  rail.addEventListener("keydown", (event) => {
    if (isCompositionKey(event)) return;
    if (event.key !== "Escape") return;
    event.preventDefault();
    api.close();
  });
  head.append(title, refresh, openSource, close);
  rail.append(head, revision, body);
  deps.container.append(rail);
  let pin: { id: string; rev: number | null } | null = null;
  let generation = 0;
  let sourceVersion = 0;
  let destroyed = false;
  let items: readonly ProjectItem[] = [];

  const live = (): boolean => pin !== null && items.some((item) => item.id === pin?.id);
  const unavailable = (): void => {
    revision.textContent = t("reference.unavailable");
    refresh.disabled = true;
    openSource.disabled = true;
  };
  async function reload(): Promise<void> {
    const request = ++generation;
    try { await deps.drain(); } catch {
      if (request === generation && !destroyed) deps.onNotice(t("reference.save-refused"));
      return;
    }
    if (request !== generation || destroyed) return;
    if (deps.failed()) { deps.onNotice(t("reference.save-refused")); return; }
    await read();
  }
  async function read(): Promise<void> {
    if (pin === null || destroyed) return;
    const request = ++generation;
    const readVersion = sourceVersion;
    if (!live()) { unavailable(); return; }
    revision.textContent = t("reference.loading");
    try {
      const loaded = await deps.load(pin.id);
      if (request !== generation || pin === null || destroyed || !live()) return;
      const fragment = savedProse(loaded.body, doc);
      if (fragment === null) {
        body.textContent = t("reference.unsupported");
      } else {
        body.replaceChildren(fragment);
      }
      pin.rev = loaded.rev;
      revision.textContent = t(readVersion === sourceVersion ? "reference.revision" : "reference.stale", { revision: formatNumber(loaded.rev) });
      refresh.disabled = false;
      openSource.disabled = false;
    } catch (error) {
      if (request !== generation || pin === null || destroyed) return;
      revision.textContent = t("reference.error", { error: String(error) });
      deps.onNotice(t("reference.error", { error: String(error) }));
    }
  }
  const api: ReferenceRail = {
    async open(item) {
      if (!proseItem(item.type)) {
        deps.onNotice(t(item.type === "timeline" ? "reference.timeline" : "reference.not-prose"));
        return;
      }
      const request = ++generation;
      try { await deps.drain(); } catch {
        if (request === generation && !destroyed) deps.onNotice(t("reference.save-refused"));
        return;
      }
      if (request !== generation || destroyed) return;
      if (deps.failed()) { deps.onNotice(t("reference.save-refused")); return; }
      pin = { id: item.id, rev: null };
      sourceVersion = 0;
      title.textContent = item.title;
      body.replaceChildren();
      rail.hidden = false;
      doc.body.dataset.referenceOpen = "true";
      await read();
      if (pin?.id === item.id && !rail.hidden) title.focus();
    },
    close() {
      const wasOpen = !rail.hidden;
      ++generation;
      pin = null;
      rail.hidden = true;
      body.replaceChildren();
      delete doc.body.dataset.referenceOpen;
      if (wasOpen) deps.onDismiss();
    },
    isOpen: () => !rail.hidden,
    sourceChanged(id) {
      if (pin?.id !== id || rail.hidden) return;
      sourceVersion += 1;
      if (pin.rev !== null) revision.textContent = t("reference.stale", { revision: formatNumber(pin.rev) });
    },
    invalidateAll() {
      if (pin !== null) api.sourceChanged(pin.id);
    },
    setItems(next) {
      items = next;
      if (pin === null) return;
      const source = next.find((item) => item.id === pin?.id);
      if (source === undefined) { ++generation; unavailable(); return; }
      title.textContent = source.title;
      if (refresh.disabled) {
        refresh.disabled = false;
        openSource.disabled = false;
        revision.textContent = pin.rev === null ? t("reference.loading") : t("reference.stale", { revision: formatNumber(pin.rev) });
      }
    },
    destroy() {
      destroyed = true;
      ++generation;
      rail.remove();
      delete doc.body.dataset.referenceOpen;
    },
  };
  return api;
}
