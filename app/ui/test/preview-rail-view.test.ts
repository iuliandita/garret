import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test, spyOn } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createPreviewRail,
  IDLE_REFRESH_MS,
  RAIL_AUTO_KEY,
  RAIL_FRAME_KEY,
  RAIL_WIDTH_KEY,
  type PreviewRail,
} from "../src/preview-rail";
import type { ChapterStyleView, EpubPreview, PdfPreview } from "../src/preview";
import type { BookDesign, BookDesignView } from "../src/book-design";

const DESIGN: BookDesign = {
  font: "Crimson Text",
  page: { width_um: 152_400, height_um: 228_600, name: "trade" },
  margins: { inner_um: 19_050, outer_um: 15_875, top_um: 15_875, bottom_um: 19_050 },
};
const DESIGN_VIEW: BookDesignView = {
  design: DESIGN, fonts: ["Crimson Text"],
  page_sizes: [{ name: "trade", width_um: 152_400, height_um: 228_600 }], presets: [],
};
const STYLE: ChapterStyleView = {
  style: { glyph: null, new_page: false, caps_title: false, drop_cap: false, ornament_above: false, sink: "none" },
  glyphs: [],
};
const XHTML = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
const EPUB: EpubPreview = {
  documents: [{ name: "a.xhtml", xhtml: XHTML("<section><h2>One</h2><p>alpha</p></section>") }],
  css: "p { margin: 0; }",
  cover_data_uri: null,
  items: 1,
  words: 1,
};
const leaf = (n: number): string => `<div class="proof-leaf" data-folio="${n}"><p>page ${n}</p></div>`;
const PROOF: PdfPreview = {
  pages: [leaf(1), leaf(2), leaf(3)],
  css: ".proof-leaf { width: 152.4mm; }",
  leaves: 3, truncated: false, font: "Crimson Text", font_resolved: true,
  gutter_minimum_um: null, inner_um: 19050, items: 1, words: 1,
};

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

interface Harness {
  rail: PreviewRail;
  storage: MemoryStorage;
  reads: number;
  proofReads: number;
  drains: number;
  win: { width: number };
  timers: { fn: () => void; ms: number; id: number }[];
  cleared: number[];
}

let live: PreviewRail | null = null;
afterEach(() => {
  live?.destroy();
  live = null;
  document.body.replaceChildren();
});

function mount(
  opts: { storage?: MemoryStorage; width?: number; read?: () => Promise<EpubPreview> } = {},
): Harness {
  const container = document.createElement("div");
  document.body.append(container);
  const h: Harness = {
    rail: null as unknown as PreviewRail,
    storage: opts.storage ?? new MemoryStorage(),
    reads: 0, proofReads: 0, drains: 0,
    win: { width: opts.width ?? 1400 },
    timers: [],
    cleared: [],
  };
  let next = 0;
  h.rail = createPreviewRail({
    container,
    drain: async () => { h.drains += 1; },
    read: opts.read ?? (async () => { h.reads += 1; return EPUB; }),
    readProof: async () => { h.proofReads += 1; return PROOF; },
    readStyle: async () => STYLE,
    writeStyle: async (style) => style,
    readDesign: async () => DESIGN_VIEW,
    writeDesign: async (design) => design,
    saveAs: () => undefined,
    onNotice: () => undefined,
    onDismiss: () => undefined,
    storage: h.storage,
    windowWidth: () => h.win.width,
    setTimer: (fn, ms) => { next += 1; h.timers.push({ fn, ms, id: next }); return next; },
    clearTimer: (handle) => { h.cleared.push(handle as number); },
  });
  live = h.rail;
  return h;
}

const rail = (): HTMLElement => document.querySelector("#preview-rail") as HTMLElement;
const divider = (): HTMLElement => document.querySelector("#preview-divider") as HTMLElement;
const pages = (): HTMLElement => document.querySelector("#preview-pages") as HTMLElement;
const press = (selector: string): void => (document.querySelector(selector) as HTMLButtonElement).click();
const key = (target: Element, name: string, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
};
const widthVar = (): string => rail().style.getPropertyValue("--preview-rail-width");
const valueNow = (): number => Number(divider().getAttribute("aria-valuenow"));
const label = (): string => document.querySelector("#preview-page-label")?.textContent ?? "";
const pending = (h: Harness): { fn: () => void; ms: number; id: number }[] =>
  h.timers.filter((timer) => !h.cleared.includes(timer.id));

/** happy-dom does no layout, so a test says what the layout would have been. */
function layout(width: number, scrollWidth: number): void {
  Object.defineProperty(pages(), "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(pages(), "scrollWidth", { configurable: true, get: () => scrollWidth });
}

describe("the divider", () => {
  test("is a labelled separator with its value, and absent while the rail is closed", async () => {
    const h = mount();
    expect(divider().hidden).toBe(true);
    expect(widthVar()).toBe("");
    await h.rail.open("epub");
    expect(divider().hidden).toBe(false);
    expect(divider().getAttribute("role")).toBe("separator");
    expect(divider().getAttribute("aria-orientation")).toBe("vertical");
    expect(divider().getAttribute("aria-controls")).toBe("preview-rail");
    expect(divider().tabIndex).toBe(0);
    expect(valueNow()).toBe(420);
    expect(divider().getAttribute("aria-valuemin")).toBe("420");
    expect(divider().getAttribute("aria-valuemax")).toBe("700");
    expect(widthVar()).toBe("420px");
    h.rail.close();
    expect(divider().hidden).toBe(true);
  });

  test("keys resize within the bounds and Enter toggles half the window", async () => {
    const h = mount({ width: 1400 });
    await h.rail.open("epub");
    key(divider(), "ArrowLeft");
    expect(valueNow()).toBe(444);
    key(divider(), "ArrowLeft", { shiftKey: true });
    expect(valueNow()).toBe(540);
    key(divider(), "ArrowRight");
    expect(valueNow()).toBe(516);
    key(divider(), "End");
    expect(valueNow()).toBe(700);
    key(divider(), "ArrowLeft", { shiftKey: true });
    expect(valueNow()).toBe(700);
    key(divider(), "Home");
    expect(valueNow()).toBe(420);
    key(divider(), "ArrowRight");
    expect(valueNow()).toBe(420);
    key(divider(), "Enter");
    expect(valueNow()).toBe(700);
    expect(widthVar()).toBe("700px");
    expect(divider().getAttribute("aria-valuetext")).toContain("half the window");
    key(divider(), "Enter");
    expect(valueNow()).toBe(420);
  });

  test("a window under 1200px has no half snap", async () => {
    const h = mount({ width: 1100 });
    await h.rail.open("epub");
    key(divider(), "Enter");
    expect(valueNow()).toBe(420);
  });

  test("the overlay width has no divider", async () => {
    const h = mount({ width: 900 });
    await h.rail.open("epub");
    expect(divider().hidden).toBe(true);
  });

  test("a drag follows the pointer, snaps near half, and is remembered", async () => {
    const h = mount({ width: 1400 });
    await h.rail.open("epub");
    rail().getBoundingClientRect = () => ({ right: 1400 }) as DOMRect;
    const fire = (type: string, clientX: number): void => {
      divider().dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX, button: 0, bubbles: true, cancelable: true }));
    };
    fire("pointerdown", 980);
    expect(divider().dataset.dragging).toBe("true");
    fire("pointermove", 1400 - 560);
    expect(valueNow()).toBe(560);
    // Nothing is stored until the pointer is released.
    expect(h.storage.map.has(RAIL_WIDTH_KEY)).toBe(false);
    fire("pointermove", 1400 - 2000);
    expect(valueNow()).toBe(700);
    fire("pointerup", 1400 - 680);
    expect(valueNow()).toBe(700);
    expect(divider().dataset.dragging).toBeUndefined();
    expect(h.storage.map.get(RAIL_WIDTH_KEY)).toBe("half");

    fire("pointerdown", 900);
    fire("pointerup", 1400 - 500);
    expect(valueNow()).toBe(500);
    expect(h.storage.map.get(RAIL_WIDTH_KEY)).toBe("500");
  });

  test("a cancelled drag keeps the width it showed and stores nothing", async () => {
    const h = mount({ width: 1400 });
    await h.rail.open("epub");
    rail().getBoundingClientRect = () => ({ right: 1400 }) as DOMRect;
    const fire = (type: string, clientX: number): void => {
      divider().dispatchEvent(new PointerEvent(type, { pointerId: 2, clientX, button: 0, bubbles: true }));
    };
    fire("pointerdown", 980);
    fire("pointermove", 1400 - 600);
    fire("pointercancel", 1400 - 600);
    expect(valueNow()).toBe(600);
    expect(h.storage.map.has(RAIL_WIDTH_KEY)).toBe(false);
  });
});

describe("the remembered width", () => {
  test("is read back by the next rail on the same device", async () => {
    const storage = new MemoryStorage();
    const first = mount({ storage, width: 1400 });
    await first.rail.open("epub");
    key(divider(), "ArrowLeft", { shiftKey: true });
    expect(storage.map.get(RAIL_WIDTH_KEY)).toBe("516");
    first.rail.destroy();
    document.body.replaceChildren();

    const second = mount({ storage, width: 1400 });
    // Closed: nothing applied, nothing measured.
    expect(widthVar()).toBe("");
    await second.rail.open("epub");
    expect(widthVar()).toBe("516px");
  });

  test("a shrinking window clamps it without forgetting the request", async () => {
    const h = mount({ width: 1920 });
    await h.rail.open("epub");
    key(divider(), "Enter");
    expect(valueNow()).toBe(960);
    h.win.width = 1000;
    window.dispatchEvent(new Event("resize"));
    expect(valueNow()).toBe(500);
    h.win.width = 1920;
    window.dispatchEvent(new Event("resize"));
    expect(valueNow()).toBe(960);
  });

  test("a storage that refuses writes still resizes for the session", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const rail = createPreviewRail({
      container,
      drain: async () => undefined,
      read: async () => EPUB,
      readProof: async () => PROOF,
      readStyle: async () => STYLE,
      writeStyle: async (style) => style,
      readDesign: async () => DESIGN_VIEW,
      writeDesign: async (design) => design,
      saveAs: () => undefined,
      onNotice: () => undefined,
      onDismiss: () => undefined,
      storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } },
      windowWidth: () => 1400,
    });
    live = rail;
    await rail.open("epub");
    key(divider(), "End");
    expect(valueNow()).toBe(700);
  });
});

describe("the device frame", () => {
  test("is off by default and leaves the pages directly in the rail", async () => {
    const h = mount();
    await h.rail.open("epub");
    expect(document.querySelector("#preview-frame")).toBeNull();
    expect(pages().parentElement).toBe(rail());
    expect(pages().dataset.framed).toBeUndefined();
    expect(document.querySelector("#preview-frame-toggle")?.getAttribute("aria-pressed")).toBe("false");
  });

  test("wraps the same pages in an e-reader, labelled approximate, and unwraps again", async () => {
    const h = mount();
    await h.rail.open("epub");
    const painted = pages().innerHTML;
    press("#preview-frame-toggle");
    const frame = document.querySelector("#preview-frame") as HTMLElement;
    expect(frame.dataset.device).toBe("ereader");
    expect(pages().parentElement?.id).toBe("preview-screen");
    expect(pages().dataset.framed).toBe("true");
    expect(pages().innerHTML).toBe(painted);
    expect(frame.textContent).toContain("Approximate preview");
    expect(document.querySelector("#preview-frame-toggle")?.getAttribute("aria-pressed")).toBe("true");
    expect(h.storage.map.get(RAIL_FRAME_KEY)).toBe("1");

    press("#preview-frame-toggle");
    expect(document.querySelector("#preview-frame")).toBeNull();
    expect(pages().parentElement).toBe(rail());
    expect(pages().dataset.framed).toBeUndefined();
    expect(h.storage.map.get(RAIL_FRAME_KEY)).toBe("0");
  });

  test("a proof gets a tablet, and the choice is remembered", async () => {
    const storage = new MemoryStorage();
    storage.setItem(RAIL_FRAME_KEY, "1");
    const h = mount({ storage });
    await h.rail.open("pdf");
    expect((document.querySelector("#preview-frame") as HTMLElement).dataset.device).toBe("tablet");
    expect(pages().dataset.proof).toBe("true");
    expect(pages().dataset.framed).toBe("true");
  });

  test("does not change a byte the host sent, and stays off the real bytes' scoping", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-frame-toggle");
    expect(pages().querySelector(".epub-document p")?.textContent).toBe("alpha");
    expect(document.querySelector<HTMLStyleElement>("#preview-style")?.textContent).toContain(
      "#preview-pages .epub-document p",
    );
  });
});

describe("paged reading", () => {
  test("an e-reader turns columns, clamps at both ends, and says where it is", async () => {
    const h = mount();
    await h.rail.open("epub");
    layout(300, 1500);
    press("#preview-frame-toggle");
    press("#preview-page-next");
    expect(label()).toBe("Page 2 of 5");
    expect(pages().scrollLeft).toBe(300);
    key(pages(), "ArrowRight");
    key(pages(), "PageDown");
    key(pages(), "ArrowRight");
    expect(label()).toBe("Page 5 of 5");
    expect(pages().scrollLeft).toBe(1200);
    expect((document.querySelector("#preview-page-next") as HTMLButtonElement).disabled).toBe(true);
    press("#preview-page-next");
    expect(label()).toBe("Page 5 of 5");
    key(pages(), "Home");
    expect(label()).toBe("Page 1 of 5");
    expect((document.querySelector("#preview-page-previous") as HTMLButtonElement).disabled).toBe(true);
    key(pages(), "End");
    expect(label()).toBe("Page 5 of 5");
    press("#preview-page-previous");
    expect(label()).toBe("Page 4 of 5");
  });

  test("a narrower window keeps the reader inside the book", async () => {
    const h = mount();
    await h.rail.open("epub");
    layout(300, 1500);
    press("#preview-frame-toggle");
    key(pages(), "End");
    expect(label()).toBe("Page 5 of 5");
    layout(300, 600);
    window.dispatchEvent(new Event("resize"));
    press("#preview-page-previous");
    press("#preview-page-next");
    expect(label()).toBe("Page 2 of 2");
  });

  test("a proof shows one whole leaf at a time", async () => {
    const h = mount();
    await h.rail.open("pdf");
    press("#preview-frame-toggle");
    const current = (): string[] =>
      [...pages().querySelectorAll(".proof-leaf.is-current")].map((el) => el.getAttribute("data-folio") ?? "");
    expect(label()).toBe("Page 1 of 3");
    expect(current()).toEqual(["1"]);
    press("#preview-page-next");
    press("#preview-page-next");
    press("#preview-page-next");
    expect(label()).toBe("Page 3 of 3");
    expect(current()).toEqual(["3"]);
    press("#preview-page-previous");
    expect(current()).toEqual(["2"]);
  });

  test("keys do nothing while the frame is off", async () => {
    const h = mount();
    await h.rail.open("epub");
    layout(300, 1500);
    key(pages(), "ArrowRight");
    expect(pages().scrollLeft).toBe(0);
    expect(label()).toBe("");
  });
});

describe("refresh after a pause", () => {
  test("is off by default: a save after an edit arms nothing", async () => {
    const h = mount();
    await h.rail.open("epub");
    expect(document.querySelector("#preview-auto-toggle")?.getAttribute("aria-pressed")).toBe("false");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    expect(pending(h)).toHaveLength(0);
  });

  test("arms only on a save that follows an edit, for the pause, and renders after draining", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-auto-toggle");
    expect(h.storage.map.get(RAIL_AUTO_KEY)).toBe("1");
    // Nothing has been edited yet.
    h.rail.saveStateChanged("saved");
    expect(pending(h)).toHaveLength(0);

    h.rail.saveStateChanged("pending");
    expect(pending(h)).toHaveLength(0);
    h.rail.saveStateChanged("saved");
    expect(pending(h)).toHaveLength(1);
    expect(pending(h)[0]?.ms).toBe(IDLE_REFRESH_MS);

    const reads = h.reads;
    const drains = h.drains;
    pending(h)[0]!.fn();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.drains).toBe(drains + 1);
    expect(h.reads).toBe(reads + 1);
  });

  test("another edit restarts the pause, so typing never refreshes", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-auto-toggle");
    for (let burst = 0; burst < 20; burst += 1) {
      h.rail.saveStateChanged("pending");
      h.rail.saveStateChanged("saved");
    }
    // Twenty save cycles, one live timer: each edit cancelled the one before.
    expect(h.timers).toHaveLength(20);
    expect(pending(h)).toHaveLength(1);
    expect(pending(h)[0]).toBe(h.timers[19]!);
    const reads = h.reads;
    h.rail.saveStateChanged("pending");
    expect(pending(h)).toHaveLength(0);
    await Promise.resolve();
    expect(h.reads).toBe(reads);
  });

  test("a manual refresh answers the pending edit", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-auto-toggle");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    expect(pending(h)).toHaveLength(1);
    press("#preview-refresh");
    expect(pending(h)).toHaveLength(0);
  });

  test("turning it off, closing, or a failed save cancels it", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-auto-toggle");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    press("#preview-auto-toggle");
    expect(pending(h)).toHaveLength(0);
    expect(h.storage.map.get(RAIL_AUTO_KEY)).toBe("0");

    press("#preview-auto-toggle");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    expect(pending(h)).toHaveLength(1);
    h.rail.close();
    expect(pending(h)).toHaveLength(0);

    await h.rail.open("epub");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("failed");
    expect(pending(h)).toHaveLength(0);
  });

  test("a closed rail ignores the scheduler entirely", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-auto-toggle");
    h.rail.close();
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    expect(h.timers).toHaveLength(0);
  });

  test("switching it on over an edited book catches up after the same pause", async () => {
    const h = mount();
    await h.rail.open("epub");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    expect(pending(h)).toHaveLength(0);
    press("#preview-auto-toggle");
    expect(pending(h)).toHaveLength(1);
  });

  test("a timer that fires after the rail closed renders nothing", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-auto-toggle");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    const stale = pending(h)[0]!;
    h.rail.close();
    const reads = h.reads;
    stale.fn();
    await Promise.resolve(); await Promise.resolve();
    expect(h.reads).toBe(reads);
  });
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("one render at a time", () => {
  test("requests during a render coalesce into exactly one follow-up", async () => {
    let started = 0;
    let active = 0;
    let widest = 0;
    const gates: (() => void)[] = [];
    const read = (): Promise<EpubPreview> => {
      started += 1;
      active += 1;
      widest = Math.max(widest, active);
      return new Promise((resolve) => {
        gates.push(() => { active -= 1; resolve(EPUB); });
      });
    };
    const h = mount({ read });
    const opening = h.rail.open("epub");
    await settle();
    expect(started).toBe(1);
    gates.shift()!();
    await opening;

    press("#preview-refresh");
    await settle();
    expect(started).toBe(2);
    // Refresh again, an idle refresh, and a third Refresh, all mid-render.
    press("#preview-auto-toggle");
    press("#preview-refresh");
    h.rail.saveStateChanged("pending");
    h.rail.saveStateChanged("saved");
    pending(h)[0]!.fn();
    press("#preview-refresh");
    await settle();
    expect(started).toBe(2);
    expect(widest).toBe(1);

    gates.shift()!();
    await settle();
    expect(started).toBe(3);
    expect(widest).toBe(1);
    gates.shift()!();
    await settle();
    expect(started).toBe(3);
    expect(gates).toHaveLength(0);
  });
});

describe("resizing with the pointer", () => {
  test("leaves focus where it was, and the divider stays a tab stop", async () => {
    const h = mount({ width: 1400 });
    await h.rail.open("epub");
    const editor = document.createElement("button");
    document.body.append(editor);
    editor.focus();
    rail().getBoundingClientRect = () => ({ right: 1400 }) as DOMRect;
    const fire = (type: string, clientX: number): boolean =>
      divider().dispatchEvent(new PointerEvent(type, { pointerId: 3, clientX, button: 0, bubbles: true, cancelable: true }));
    const notPrevented = fire("pointerdown", 980);
    fire("pointermove", 1400 - 600);
    fire("pointerup", 1400 - 600);
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);
    expect(divider().tabIndex).toBe(0);
    divider().focus();
    expect(document.activeElement).toBe(divider());
  });
});


describe("lazy EPUB documents", () => {
  async function waitFor(label: string, ready: () => boolean): Promise<void> {
    const deadline = performance.now() + 1000;
    while (!ready()) {
      if (performance.now() >= deadline) throw new Error(`EPUB reader timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const book = (): EpubPreview => ({
    ...EPUB,
    documents: Array.from({ length: 1572 }, (_, i) => ({
      name: `${i}.xhtml`, xhtml: XHTML(`<p>chapter ${i}</p>`).replace("<title>t</title>", `<title>chapter ${i}</title>`),
    })),
  });

  test("mounts only three documents of a large book", async () => {
    const h = mount({ read: async () => book() });
    await h.rail.open("epub");
    expect(pages().querySelectorAll(".epub-document")).toHaveLength(3);
    expect(pages().textContent).not.toContain("chapter 1571");
  });

  test("short documents fill the viewport without waiting for another scroll", async () => {
    const geometry = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!this.hasAttribute("data-epub-name")) return { top: 0, bottom: 600, height: 600, left: 0, right: 300, width: 300 } as DOMRect;
      const heightOf = (el: Element): number => el.classList.contains("epub-document") ? 100 : parseFloat((el as HTMLElement).style.height);
      const siblings = [...this.parentElement!.children];
      const top = siblings.slice(0, siblings.indexOf(this)).reduce((sum, el) => sum + heightOf(el), 0) - pages().scrollTop;
      const height = heightOf(this);
      return { top, bottom: top + height, height, left: 0, right: 300, width: 300 } as DOMRect;
    });
    try {
      const h = mount({ read: async () => book() });
      Object.defineProperty(pages(), "clientHeight", { configurable: true, value: 600 });
      await h.rail.open("epub");
      expect(pages().querySelectorAll(".epub-document")).toHaveLength(7);
      expect(pages().querySelector('[data-epub-name="6.xhtml"]')?.textContent).toBe("chapter 6");
    } finally { geometry.mockRestore(); }
  });

  test.each([1, 3])("the e-reader reaches the last page and refreshes (%i pages in the last document)", async (lastPages) => {
    const h = mount({ read: async () => book() });
    await h.rail.open("epub");
    layout(300, 1572 * 300);
    Object.defineProperty(pages(), "scrollWidth", { configurable: true, get: () =>
      (1572 + (pages().querySelector('[data-epub-name="1571.xhtml"].epub-document') ? lastPages - 1 : 0)) * 300 });
    const indices = new WeakMap<Element, number>();
    const geometry = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const isDocument = this.hasAttribute("data-epub-name");
      if (isDocument && !indices.has(this)) {
        [...this.parentElement!.children].forEach((element, index) => indices.set(element, index));
      }
      const index = isDocument ? indices.get(this)! : 0;
      const left = isDocument ? index * 300 - pages().scrollLeft : 0;
      const width = index === 1571 ? lastPages * 300 : 300;
      return { top: 0, bottom: 600, height: 600, left, right: left + width, width } as DOMRect;
    });
    try {
      press("#preview-frame-toggle");
      key(pages(), "End");
      await waitFor("the last EPUB document to mount", () =>
        pages().querySelector('[data-epub-name="1571.xhtml"].epub-document') !== null);
      expect(pages().querySelector('[data-epub-name="1571.xhtml"]')?.classList.contains("epub-document")).toBe(true);
      expect(pages().querySelectorAll(".epub-document")).toHaveLength(3);
      key(pages(), "End");
      const lastPageLabel = lastPages === 1 ? "Page 1,572 of 1,572" : "Page 1,574 of 1,574";
      await waitFor(lastPageLabel, () => label() === lastPageLabel);
      expect(label()).toBe(lastPages === 1 ? "Page 1,572 of 1,572" : "Page 1,574 of 1,574");
      const lastDocument = pages().querySelector('[data-epub-name="1571.xhtml"].epub-document');
      press("#preview-refresh");
      await waitFor(`a refreshed reader at ${lastPageLabel}`, () => {
        const refreshed = pages().querySelector('[data-epub-name="1571.xhtml"].epub-document');
        return refreshed !== null && refreshed !== lastDocument
          && pages().scrollLeft === (1571 + lastPages - 1) * 300 && label() === lastPageLabel;
      });
      expect(pages().scrollLeft).toBe((1571 + lastPages - 1) * 300);
      expect(label()).toBe(lastPages === 1 ? "Page 1,572 of 1,572" : "Page 1,574 of 1,574");
      key(pages(), "Home");
      await waitFor("the first EPUB document at offset zero", () =>
        pages().querySelector('[data-epub-name="0.xhtml"].epub-document') !== null && pages().scrollLeft === 0);
      expect(pages().querySelector('[data-epub-name="0.xhtml"]')?.classList.contains("epub-document")).toBe(true);
      expect(pages().scrollLeft).toBe(0);
    } finally { geometry.mockRestore(); }
  });

  test("scrolling replaces distant documents and refresh keeps the document and offset", async () => {
    let view = book();
    const h = mount({ read: async () => view });
    await h.rail.open("epub");
    const geometry = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!this.hasAttribute("data-epub-name")) return { top: 0, left: 0, right: 300, bottom: 600, height: 600, width: 300 } as DOMRect;
      const index = [...this.parentElement!.children].indexOf(this);
      return { top: index * 1000 - pages().scrollTop, bottom: (index + 1) * 1000 - pages().scrollTop,
        height: 1000, left: 0, right: 300, width: 300 } as DOMRect;
    });
    Object.defineProperty(pages(), "clientHeight", { configurable: true, value: 600 });
    try {
      pages().scrollTop = 100250;
      pages().dispatchEvent(new Event("scroll"));
      expect([...pages().querySelectorAll(".epub-document")].map(el => el.getAttribute("data-epub-name")))
        .toEqual(["99.xhtml", "100.xhtml", "101.xhtml"]);
      expect(pages().scrollTop).toBe(100250);
      view = { ...view, documents: [{ name: "inserted.xhtml", xhtml: XHTML("<p>new</p>") }, ...view.documents]
        .map((doc, index) => ({ ...doc, name: `${index}.xhtml` })) };
      press("#preview-refresh");
      await settle();
      expect(pages().querySelector('[data-epub-name="101.xhtml"].epub-document p')?.textContent).toBe("chapter 100");
      // The inserted document moves this anchor, but the offset stays 250px.
      expect(pages().scrollTop).toBe(101250);
      // Renaming one of two identically titled chapters must keep its filename,
      // rather than following the remaining title to the other chapter.
      view = { ...view, documents: view.documents.map((doc, index) => index === 1
        ? { ...doc, xhtml: doc.xhtml.replace("<title>chapter 0</title>", "<title>chapter 100</title>") } : doc) };
      press("#preview-refresh");
      await settle();
      view = { ...view, documents: view.documents.map((doc, index) => index === 101
        ? { ...doc, xhtml: doc.xhtml.replace("<title>chapter 100</title>", "<title>renamed</title>") } : doc) };
      press("#preview-refresh");
      await settle();
      expect(pages().querySelector('[data-epub-name="101.xhtml"].epub-document p')?.textContent).toBe("chapter 100");
      expect(pages().scrollTop).toBe(101250);
      h.rail.close();
      expect(pages().childElementCount).toBe(0);
    } finally { geometry.mockRestore(); }
  });
});
