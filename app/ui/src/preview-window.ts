import { parseDocumentBody, type EpubPreview } from "./preview";

// One neighbor each way, with three documents at either book boundary. Short
// documents that share a viewport are included before adding the neighbors.
export const EPUB_WINDOW_MIN = 3;
const ESTIMATED_HEIGHT = 1000;

interface Position {
  name: string;
  title?: string;
  index: number;
  offset: number;
}

export interface PreviewWindow {
  elements: HTMLElement[];
  position(): Position | undefined;
  restore(position?: Position): void;
  resetLayout(position?: Position): void;
  revealLast(): void;
  update(): void;
  destroy(): void;
}

/** Keep archive strings, never parsed bodies, for documents outside the window.
 * Empty slots preserve scroll geometry; unvisited lengths are estimates until
 * measured. CSS columns use the same slots, fragmented into reader pages. */
export function createPreviewWindow(
  pages: HTMLElement,
  view: EpubPreview,
  deps: {
    framed(): boolean;
    problem(name: string): HTMLElement;
    coverAlt(): string;
    /** A fetched figure's data URI, or undefined when it has not arrived. */
    figureCached(key: string): string | undefined;
    /** Fetch a figure by key; null when the host could not serve it. */
    figureLoad(key: string): Promise<string | null>;
  },
): PreviewWindow {
  const figureKeys = new Set(view.figure_keys);
  const elements = view.documents.map(({ name }) => {
    const slot = document.createElement("div");
    slot.dataset.epubName = name;
    return slot;
  });
  const titles = view.documents.map(doc => doc.xhtml.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
  const titleCounts = new Map<string, number>();
  for (const title of titles) if (title !== undefined) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  const heights = new Map<string, number>();
  const mounted = new Set<number>();
  let busy = false;
  let dead = false;
  let width = 0;
  let wasFramed = deps.framed();

  function placeholder(index: number): void {
    const slot = elements[index]!;
    slot.className = "epub-placeholder";
    slot.setAttribute("aria-hidden", "true");
    // clientHeight rounds up fractional screens, spilling a placeholder into
    // another column. Keep the exact height inside the reader's 20px margins.
    const height = heights.get(slot.dataset.epubName!)
      ?? (deps.framed() ? Math.max(1, pages.getBoundingClientRect().height - 40) : ESTIMATED_HEIGHT);
    slot.style.height = `${height}px`;
    slot.style.breakBefore = deps.framed() && index > 0 ? "column" : "";
    // Do not let margins escape the slot and change its measured extent.
    slot.style.display = "flow-root";
  }

  function mount(index: number): void {
    const slot = elements[index]!;
    const doc = view.documents[index]!;
    const body = parseDocumentBody(doc.xhtml);
    slot.className = "epub-document";
    slot.removeAttribute("aria-hidden");
    slot.style.height = "";
    if (body === null) slot.append(deps.problem(doc.name));
    else {
      const imported = document.importNode(body, true);
      for (const image of imported.querySelectorAll("img")) {
        if (image.closest("section.cover") !== null) {
          if (view.cover_data_uri === null) continue;
          image.setAttribute("src", view.cover_data_uri);
          image.setAttribute("alt", deps.coverAlt());
        } else {
          // The document names `../assets/<sha256>.png` and the host lists
          // `assets/<sha256>.png`. The page cannot load that path, so the
          // source is dropped (alt text shows) until the bytes arrive; a source
          // the host did not list is left as written.
          const key = (image.getAttribute("src") ?? "").replace(/^\.\.\//, "");
          if (!figureKeys.has(key)) continue;
          const cached = deps.figureCached(key);
          if (cached !== undefined) image.setAttribute("src", cached);
          else {
            image.removeAttribute("src");
            void deps.figureLoad(key).then((uri) => {
              if (uri !== null && !dead && image.isConnected) image.setAttribute("src", uri);
            });
          }
        }
      }
      slot.append(...imported.childNodes);
      for (const link of slot.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        link.tabIndex = -1;
        link.setAttribute("aria-disabled", "true");
      }
    }
    mounted.add(index);
  }

  function extent(index: number): number {
    const slot = elements[index]!;
    // A column-fragmented element's bounding box spans all its columns. The
    // individual fragment heights retain the amount of content it occupies.
    return [...slot.getClientRects()].reduce((sum, rect) => sum + rect.height, 0)
      || slot.getBoundingClientRect().height;
  }

  function visible(): { first: number; last: number; offset: number } {
    const box = pages.getBoundingClientRect();
    const horizontal = deps.framed();
    const origin = horizontal ? box.left : box.top;
    const end = origin + (horizontal ? pages.clientWidth : pages.clientHeight);
    let first = -1;
    let last = -1;
    let offset = 0;
    for (let i = 0; i < elements.length; i += 1) {
      const rect = elements[i]!.getBoundingClientRect();
      const start = horizontal ? rect.left : rect.top;
      const finish = horizontal ? rect.right : rect.bottom;
      if (first >= 0 && start >= end) break;
      if (finish > origin) {
        if (first < 0) { first = i; offset = origin - start; }
        last = i;
      }
    }
    return { first: Math.max(0, first), last: Math.max(first, last, 0), offset };
  }

  const titleAt = (index: number): string | undefined => titles[index];

  function position(): Position | undefined {
    if (!elements.length) return undefined;
    const { first, offset } = visible();
    const title = titleAt(first);
    return { name: view.documents[first]!.name,
      title: title !== undefined && titleCounts.get(title) === 1 ? title : undefined,
      index: first, offset };
  }

  function fill(first: number, last: number): void {
    const start = Math.max(0, Math.min(first - 1, elements.length - EPUB_WINDOW_MIN));
    const end = Math.min(elements.length, Math.max(last + 2, start + EPUB_WINDOW_MIN));
    for (const index of mounted) {
      if (index >= start && index < end) continue;
      const height = extent(index);
      heights.set(view.documents[index]!.name, height);
      elements[index]!.replaceChildren();
      placeholder(index);
      mounted.delete(index);
    }
    for (let i = start; i < end; i += 1) if (!mounted.has(i)) mount(i);
  }

  function align(index: number, offset: number): void {
    const rect = elements[index]?.getBoundingClientRect();
    if (!rect) return;
    const box = pages.getBoundingClientRect();
    if (deps.framed()) pages.scrollLeft += rect.left - box.left + offset;
    else pages.scrollTop += rect.top - box.top + offset;
  }

  function restore(saved?: Position): void {
    if (!elements.length) return;
    let found = saved ? view.documents.findIndex(doc => doc.name === saved.name) : 0;
    // The exporter numbers filenames by order. A unique unchanged title can
    // follow a chapter when an earlier insertion renumbers those files. Read
    // only the XML header here; offscreen bodies remain unparsed.
    if (saved?.title !== undefined && titleAt(found) !== saved.title) {
      const matches = view.documents.flatMap((_, index) => titleAt(index) === saved.title ? [index] : []);
      if (matches.length === 1) found = matches[0]!;
    }
    const index = found < 0 ? Math.min(saved?.index ?? 0, elements.length - 1) : found;
    fill(index, index);
    if (saved) align(index, saved.offset);
  }

  function resetLayout(saved = position()): void {
    heights.clear();
    for (let i = 0; i < elements.length; i += 1) {
      elements[i]!.style.breakBefore = deps.framed() && i > 0 ? "column" : "";
      if (!mounted.has(i)) placeholder(i);
    }
    wasFramed = deps.framed();
    width = pages.clientWidth;
    restore(saved);
  }

  function update(): void {
    if (busy || dead) return;
    busy = true;
    try {
      const saved = position();
      if (width !== pages.clientWidth || wasFramed !== deps.framed()) resetLayout(saved);
      // Short documents can expose another placeholder when first mounted.
      // Settle that viewport now instead of leaving blank paper until a scroll.
      for (let pass = 0; pass < elements.length; pass += 1) {
        const { first, last, offset } = visible();
        fill(first, last);
        align(first, offset);
        const next = visible();
        if (next.first === first && next.last === last) break;
      }
    } finally { busy = false; }
  }

  for (let i = 0; i < elements.length; i += 1) placeholder(i);
  pages.style.overflowAnchor = "none";
  pages.addEventListener("scroll", update, { passive: true });
  return {
    elements, position, restore, resetLayout, update,
    revealLast(): void {
      const index = elements.length - 1;
      if (index >= 0) restore({ name: view.documents[index]!.name, index, offset: 0 });
    },
    destroy(): void {
      dead = true;
      pages.removeEventListener("scroll", update);
      pages.style.overflowAnchor = "";
    },
  };
}
