import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPreviewRail, type PreviewRail, type PreviewRailDeps } from "../src/preview-rail";
import type { ChapterStyle, ChapterStyleView, EpubPreview, PdfPreview } from "../src/preview";
import { EN } from "../src/i18n";
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

const XHTML = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

function preview(over: Partial<EpubPreview> = {}): EpubPreview {
  return {
    documents: [
      { name: "OEBPS/text/title.xhtml", xhtml: XHTML("<section><h1>My Novel</h1></section>") },
      { name: "OEBPS/text/0001.xhtml", xhtml: XHTML("<section><h2>One</h2><p>alpha</p></section>") },
    ],
    css: "body { margin: 0 5%; }\np { text-indent: 1.2em; }",
    cover_data_uri: null,
    items: 1,
    words: 1,
    ...over,
  };
}

function styleView(over: Partial<ChapterStyle> = {}): ChapterStyleView {
  return {
    style: { glyph: null, new_page: false, caps_title: false, drop_cap: false, ...over },
    glyphs: [
      { id: "asterisks", ornament: "* * *" },
      { id: "asterism", ornament: "⁂" },
    ],
  };
}

interface Harness {
  rail: PreviewRail;
  container: HTMLElement;
  reads: number;
  proofReads: number;
  styleReads: number;
  written: ChapterStyle[];
  saved: string[];
  notices: string[];
  dismissed: number;
  drains: number;
}

let live: PreviewRail | null = null;
afterEach(() => {
  live?.destroy();
  live = null;
  document.body.replaceChildren();
});

function proofView(over: Partial<PdfPreview> = {}): PdfPreview {
  return {
    pages: [
      '<div class="proof-leaf" data-side="recto" data-folio="1"><div class="proof-runhead">MY NOVEL</div><div class="proof-text"><p>alpha</p></div><div class="proof-folio">1</div></div>',
    ],
    css: ".proof-leaf { width: 152.4mm; }",
    leaves: 1,
    truncated: false,
    font: "Crimson Text",
    font_resolved: true,
    gutter_minimum_um: null,
    inner_um: 19050,
    items: 1,
    words: 1,
    ...over,
  };
}

function mount(
  over: Partial<PreviewRailDeps> = {},
  view = preview(),
  style = styleView(),
  proof = proofView(),
): Harness {
  const container = document.createElement("aside");
  document.body.append(container);
  const h: Harness = {
    rail: null as unknown as PreviewRail,
    container,
    reads: 0,
    proofReads: 0,
    styleReads: 0,
    written: [],
    saved: [],
    notices: [],
    dismissed: 0,
    drains: 0,
  };
  h.rail = createPreviewRail({
    container,
    drain: async () => {
      h.drains += 1;
    },
    read: async () => {
      h.reads += 1;
      return view;
    },
    readProof: async () => {
      h.proofReads += 1;
      return proof;
    },
    readStyle: async () => {
      h.styleReads += 1;
      return style;
    },
    writeStyle: async (next) => {
      h.written.push(next);
      return next;
    },
    readDesign: async () => DESIGN_VIEW,
    writeDesign: async (next) => next,
    saveAs: (format) => {
      h.saved.push(format);
    },
    onNotice: (m) => h.notices.push(m),
    onDismiss: () => {
      h.dismissed += 1;
    },
    ...over,
  });
  live = h.rail;
  return h;
}

const rail = (): HTMLElement => document.querySelector("#preview-rail") as HTMLElement;
const pages = (): HTMLElement | null => document.querySelector("#preview-pages");
const summary = (): HTMLElement | null => document.querySelector("#preview-summary");
const press = (selector: string): void => {
  (document.querySelector(selector) as HTMLButtonElement).click();
};

describe("the rail's own shape", () => {
  test("PDF rendering waits for page setup and a close cancels the waiting open", async () => {
    let release!: (value: typeof DESIGN_VIEW) => void;
    const pending = new Promise<typeof DESIGN_VIEW>((resolve) => { release = resolve; });
    const h = mount({ readDesign: () => pending });
    const opening = h.rail.open("pdf");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.proofReads).toBe(0);
    h.rail.close();
    release(DESIGN_VIEW);
    await opening;
    expect(h.proofReads).toBe(0);
    expect(h.rail.isOpen()).toBe(false);
  });

  test("it is closed on mount and shows nothing", () => {
    const h = mount();
    expect(rail().hidden).toBe(true);
    expect(h.reads).toBe(0);
    expect(h.rail.isOpen()).toBe(false);
  });

  test("IT IS NOT A PANEL: an outside click leaves it open", async () => {
    // THE DECISION THIS TEST EXISTS FOR. Every panel in this application
    // dismisses on a capture-phase outside click; a preview that vanished the
    // moment the writer clicked back into their prose would be useless, and it
    // is exactly what a later reader adding `closeOnOutsideClick` here would
    // do "for consistency".
    const h = mount();
    await h.rail.open("epub");
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    elsewhere.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    elsewhere.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.rail.isOpen()).toBe(true);
  });

  test("Escape closes it and hands focus back", async () => {
    const h = mount();
    await h.rail.open("epub");
    rail().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.rail.isOpen()).toBe(false);
    expect(h.dismissed).toBe(1);
  });

  test("Close closes it", async () => {
    const h = mount();
    await h.rail.open("epub");
    press("#preview-close");
    expect(h.rail.isOpen()).toBe(false);
  });
});

describe("what it renders", () => {
  test("it drains before it reads, because an export is the book AS SAVED", async () => {
    const h = mount();
    await h.rail.open("epub");
    expect(h.drains).toBe(1);
    expect(h.reads).toBe(1);
  });

  test("every document of the reading order is painted, in order", async () => {
    const h = mount();
    await h.rail.open("epub");
    const documents = [...document.querySelectorAll("#preview-pages .epub-document")];
    const headings = documents.map((document_) => document_.querySelector("h1, h2")?.textContent);
    expect(documents).toHaveLength(2);
    expect(headings).toEqual(["My Novel", "One"]);
  });

  test("the book's own stylesheet is applied, scoped to the rail", async () => {
    const h = mount();
    await h.rail.open("epub");
    const style = document.querySelector("#preview-style");
    expect(style?.textContent).toContain("#preview-pages .epub-document p { text-indent: 1.2em; }");
    // EPUB `html` and `body` reset their own document wrapper, never the paper around it.
    expect(style?.textContent).toContain("#preview-pages .epub-document { margin: 0 5%; }");
    expect(style?.textContent).not.toContain("#preview-pages { margin: 0 5%; }");
  });

  test("A DOCUMENT THAT IS NOT WELL-FORMED IS NAMED, not silently skipped", async () => {
    const h = mount(
      {},
      preview({
        documents: [
          {
            name: "OEBPS/text/0001.xhtml",
            xhtml: '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><p>hi</body></html>',
          },
        ],
      }),
    );
    await h.rail.open("epub");
    expect(document.querySelector("#preview-pages")?.textContent).toContain(
      EN["preview.error.document"].replace("{name}", "OEBPS/text/0001.xhtml"),
    );
  });

  test("a stylesheet this page cannot scope is said rather than half applied", async () => {
    const h = mount({}, preview({ css: "@media print { p { margin: 0; } }" }));
    await h.rail.open("epub");
    expect(document.querySelector("#preview-style")?.textContent).toBe("");
    expect(rail().textContent).toContain(EN["preview.error.stylesheet"]);
  });

  test("the cover's container-relative source is replaced by the bytes in the archive", async () => {
    // The one substitution the rail makes, and it is not a second rendering:
    // `../cover.png` resolves inside the container and nowhere else, and the
    // data URI is cut from the SAME archive entry the document points at.
    const h = mount(
      {},
      preview({
        cover_data_uri: "data:image/png;base64,AAA",
        documents: [
          {
            name: "OEBPS/text/cover.xhtml",
            xhtml: XHTML('<section><img src="../cover.png" alt="c"/></section>'),
          },
        ],
      }),
    );
    await h.rail.open("epub");
    expect(document.querySelector<HTMLImageElement>("#preview-pages img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAA",
    );
  });

  test("it states what the book is, so a writer can see the preview is of all of it", async () => {
    const h = mount({}, preview({ items: 40, words: 2000 }));
    await h.rail.open("epub");
    expect(document.querySelector("#preview-summary")?.textContent).toBe(
      EN["preview.epub.summary.other"].replace("{items}", "40").replace("{words}", "2000"),
    );
  });

  test("THE SUMMARY IS ANNOUNCED, not only painted: its figures are in its own name", async () => {
    // 109's rig walked the live application and read `#preview-summary` as
    // `status bar name="" text="" kids=0` while the writer was looking at the
    // sentence: WebKitGTK maps `role="status"` to an ATK status bar and PRUNES
    // its children, so a screen reader was told nothing about what the rail was
    // showing. `#word-count` carries its figures in an `aria-label` for the
    // same recorded reason. Painting the sentence is not saying it.
    const h = mount({}, preview({ items: 40, words: 2000 }));
    await h.rail.open("epub");
    expect(summary()?.getAttribute("aria-label")).toBe(
      EN["preview.epub.summary.other"].replace("{items}", "40").replace("{words}", "2000"),
    );
    // The same words in the same order, never a second phrasing: the two
    // readers are looking at one sentence.
    expect(summary()?.getAttribute("aria-label")).toBe(summary()?.textContent);
  });

  test("a reopen does not leave the last book's figures in the name", async () => {
    // A name left behind would have the rail answer with the PREVIOUS book
    // until the next paint -- `#word-count`'s own teardown rule.
    const h = mount({}, preview({ items: 40, words: 2000 }));
    await h.rail.open("epub");
    expect(summary()?.getAttribute("aria-label")).not.toBeNull();
    h.rail.close();
    // `open` clears the summary synchronously, before its first await, so this
    // is the state a writer's screen reader meets while the next render runs.
    const opening = h.rail.open("epub");
    expect(summary()?.textContent).toBe("");
    expect(summary()?.getAttribute("aria-label")).toBeNull();
    await opening;
  });

  test("NOTHING REPAINTS ON ITS OWN: a second render happens only when asked", async () => {
    // The keystroke path is measured and gated and a render is O(the
    // manuscript). This is what fails if a later slice subscribes the rail to
    // the editor.
    const h = mount();
    await h.rail.open("epub");
    expect(h.reads).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reads).toBe(1);
    press("#preview-refresh");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads).toBe(2);
    expect(h.drains).toBe(2);
  });

  test("a read that fails is said and leaves no half-painted book", async () => {
    // THE SECOND READ IS THE TEST. The first draft failed on the FIRST open, so
    // the pages box had never held anything and a mutation deleting the
    // clear-out survived: an empty box and a box that was emptied look the
    // same. What a writer actually meets is a rail showing their book and then
    // a Refresh that could not answer, and a stale book left under a failure
    // notice is a book they would go on reading.
    let fail = false;
    const h = mount({
      read: async () => {
        if (fail) throw new Error("no");
        return preview();
      },
    });
    await h.rail.open("epub");
    expect(document.querySelector("#preview-pages")?.childElementCount).toBeGreaterThan(0);
    fail = true;
    press("#preview-refresh");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.notices).toEqual([EN["preview.error.load"].replace("{error}", "no")]);
    expect(document.querySelector("#preview-pages")?.childElementCount).toBe(0);
  });
});

describe("the four options", () => {
  test("the ornaments the host offers are the buttons, drawn as themselves", async () => {
    const h = mount();
    await h.rail.open("epub");
    const labels = [...document.querySelectorAll("#preview-ornament button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual([EN["preview.glyph.none"], "* * *", "⁂"]);
  });

  test("pressing an ornament writes the WHOLE style and re-renders", async () => {
    const h = mount();
    await h.rail.open("epub");
    press('[data-preview-glyph="asterism"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.written).toEqual([
      { glyph: "asterism", new_page: false, caps_title: false, drop_cap: false },
    ]);
    expect(h.reads).toBe(2);
  });

  test("None clears the ornament", async () => {
    const h = mount({}, preview(), styleView({ glyph: "asterism" }));
    await h.rail.open("epub");
    press('[data-preview-glyph=""]');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.written[0]?.glyph).toBeNull();
  });

  test("a flag toggles, and only that flag", async () => {
    const h = mount({}, preview(), styleView({ caps_title: true }));
    await h.rail.open("epub");
    press("#preview-flag-new_page");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.written).toEqual([
      { glyph: null, new_page: true, caps_title: true, drop_cap: false },
    ]);
    press("#preview-flag-caps_title");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.written[1]).toEqual({
      glyph: null,
      new_page: true,
      caps_title: false,
      drop_cap: false,
    });
  });

  test("AN ORNAMENT THE HOST NEVER OFFERED CANNOT BE STORED", async () => {
    // The narrowing against the host's own list, and it needed a button the
    // rail did not build: nothing the rail paints carries a word the host did
    // not send, so a mutation deleting the check survived. A stored word this
    // build has no ornament for reads as NO ornament, so a page one version
    // ahead could silently take a writer's ornament away.
    const h = mount();
    await h.rail.open("epub");
    const smuggled = document.createElement("button");
    smuggled.dataset.previewGlyph = "pilcrow";
    document.querySelector("#preview-ornament .preview-choices")?.append(smuggled);
    smuggled.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.written).toEqual([]);
  });

  test("what is in effect is a pressed state and reaches a screen reader", async () => {
    const h = mount({}, preview(), styleView({ glyph: "asterisks", drop_cap: true }));
    await h.rail.open("epub");
    expect(
      document.querySelector('[data-preview-glyph="asterisks"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.querySelector('[data-preview-glyph=""]')?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(document.querySelector("#preview-flag-drop_cap")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.querySelector("#preview-flag-new_page")?.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("A REFUSED WRITE LEAVES THE PRESSED STATE THE FILE ACTUALLY HOLDS", async () => {
    // 040's rule -- a refused design applies nowhere at all -- met by
    // CONSTRUCTION rather than by a repaint: this rail paints only from the
    // host's answer, so a press that was refused never changed what is on
    // screen. A repaint in the catch was written first and a mutation deleting
    // it survived, because no input can tell it from its absence.
    const h = mount({ writeStyle: async () => Promise.reject(new Error("no")) }, preview(), styleView());
    await h.rail.open("epub");
    press("#preview-flag-drop_cap");
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("#preview-flag-drop_cap")?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(h.notices).toEqual([EN["preview.error.style"].replace("{error}", "no")]);
  });
});

describe("a link inside the preview", () => {
  test("A CLICK ON A CONTENTS LINK DOES NOT NAVIGATE THE APPLICATION AWAY", async () => {
    // FOUND BY LOOKING AT A CAPTURE. The generated contents is a list of
    // anchors with container-relative hrefs; the page is served from
    // `tauri://localhost/index.html`, so following one takes the whole webview
    // to a document that does not exist there and the application is gone --
    // with no way back short of relaunching it. The rail is not a reading
    // system and its links are inert.
    const h = mount(
      {},
      preview({
        documents: [
          {
            name: "OEBPS/text/nav.xhtml",
            xhtml: XHTML('<nav><ol><li><a href="0001.xhtml#h1">One</a></li></ol></nav>'),
          },
        ],
      }),
    );
    await h.rail.open("epub");
    const link = document.querySelector("#preview-pages a") as HTMLElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Save as", () => {
  test("it hands off to the export the menu already has, AS THE FORMAT ON SCREEN", async () => {
    // ONE CONTROL, TWO FILES. A Save that always asked for an EPUB would write
    // the wrong file for a writer looking at a proof copy -- and the two are
    // one keystroke apart in the same menu, so this is the ordinary mistake
    // rather than an exotic one.
    const h = mount();
    await h.rail.open("epub");
    press("#preview-save-as");
    await h.rail.open("pdf");
    press("#preview-save-as");
    expect(h.saved).toEqual(["epub", "pdf"]);
  });

  test("a Save with the rail never opened asks for nothing", async () => {
    const h = mount();
    press("#preview-save-as");
    expect(h.saved).toEqual([]);
  });
});

describe("teardown", () => {
  test("destroy empties the container", async () => {
    const h = mount();
    await h.rail.open("epub");
    h.rail.destroy();
    expect(h.container.childElementCount).toBe(0);
  });

  test("an answer landing after destroy paints nothing", async () => {
    let release: (v: EpubPreview) => void = () => {};
    const h = mount({ read: () => new Promise<EpubPreview>((r) => (release = r)) });
    const opening = h.rail.open("epub");
    h.rail.destroy();
    release(preview());
    await opening;
    expect(document.querySelector("#preview-pages")).toBeNull();
  });
});

describe("the proof copy", () => {
  const leaves = (): Element[] => [...(pages()?.children ?? [])];

  test("opening as a proof reads the proof and NEVER the archive", async () => {
    // ONE RAIL, TWO BOOKS. The format decides what is read; a rail that read
    // both would spend a full EPUB render on every proof and paint whichever
    // answer arrived last.
    const h = mount();
    await h.rail.open("pdf");
    expect(h.proofReads).toBe(1);
    expect(h.reads).toBe(0);
    expect(h.rail.format()).toBe("pdf");
  });

  test("opening as an EPUB reads the archive and NEVER the proof", async () => {
    const h = mount();
    await h.rail.open("epub");
    expect(h.reads).toBe(1);
    expect(h.proofReads).toBe(0);
    expect(h.rail.format()).toBe("epub");
  });

  test("a closed rail is showing no format at all", async () => {
    const h = mount();
    expect(h.rail.format()).toBeNull();
    await h.rail.open("pdf");
    h.rail.close();
    expect(h.rail.format()).toBeNull();
  });

  test("it drains before it renders, exactly as the archive does", async () => {
    // A proof built over a failed save would show the book without the
    // writer's last sentence and still be called their book.
    const h = mount();
    await h.rail.open("pdf");
    expect(h.drains).toBe(1);
  });

  test("Refresh re-reads the format on screen and not the other one", async () => {
    const h = mount();
    await h.rail.open("pdf");
    press("#preview-refresh");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.proofReads).toBe(2);
    expect(h.reads).toBe(0);
  });

  test("the label, the heading and the note all name the format on screen", async () => {
    // A region labelled "EPUB preview" while it shows a proof copy tells a
    // screen-reader user the wrong thing about what they are in, and the note
    // is where the "not a printer's file" boundary is stated.
    const h = mount();
    await h.rail.open("pdf");
    expect(rail().getAttribute("aria-label")).toBe(EN["preview.pdf.label"]);
    expect(rail().querySelector("h2")?.textContent).toBe(EN["preview.pdf.label"]);
    expect(document.querySelector("#preview-note")?.textContent).toBe(EN["preview.pdf.note"]);
    await h.rail.open("epub");
    expect(rail().getAttribute("aria-label")).toBe(EN["preview.epub.label"]);
    expect(rail().querySelector("h2")?.textContent).toBe(EN["preview.epub.label"]);
    expect(document.querySelector("#preview-note")?.textContent).toBe(EN["preview.epub.note"]);
  });

  test("the pages box says which kind of book it is holding", async () => {
    // The hook the stylesheet keys on. Asserted as an attribute rather than
    // through `getComputedStyle`, which under happy-dom passes for any
    // implementation including none.
    const h = mount();
    await h.rail.open("pdf");
    expect(pages()?.dataset.proof).toBe("true");
    await h.rail.open("epub");
    expect(pages()?.dataset.proof).toBeUndefined();
  });

  test("the leaves the printer was handed are what is painted", async () => {
    const h = mount();
    await h.rail.open("pdf");
    expect(leaves().length).toBe(1);
    expect(leaves()[0]?.className).toBe("proof-leaf");
    expect(leaves()[0]?.querySelector(".proof-folio")?.textContent).toBe("1");
    expect(leaves()[0]?.querySelector(".proof-runhead")?.textContent).toBe("MY NOVEL");
  });

  test("a leaf is parsed as HTML, because that is what it is", async () => {
    // AN EPUB DOCUMENT IS XML AND A PROOF LEAF IS NOT. The leaf is markup the
    // engine serialised out of its own DOM, so an `<img>` in it carries no
    // closing slash -- and an XML parser would report the writer's book as
    // broken when nothing at all is wrong with it.
    const h = mount({}, preview(), styleView(), proofView({
      pages: ['<div class="proof-leaf"><img src="data:image/png;base64,AA"><br></div>'],
    }));
    await h.rail.open("pdf");
    expect(leaves().length).toBe(1);
    expect(leaves()[0]?.querySelector("img")).not.toBeNull();
    expect(document.querySelector(".preview-problem")).toBeNull();
  });

  test("the summary counts pages as well as sections and words", async () => {
    const h = mount({}, preview(), styleView(), proofView({ leaves: 312, items: 40, words: 90000 }));
    await h.rail.open("pdf");
    expect(summary()?.textContent).toContain("312 pages");
  });

  test("EVERY sentence the proof's summary paints is in its name too", async () => {
    // The proof's summary is not one sentence: the leaf count, a missing face,
    // the gutter verdict and the truncation note all land in the same status
    // region. A name carrying only the first would announce the count and hide
    // the warning, which is the half that matters.
    const h = mount({}, preview(), styleView(), proofView({
      leaves: 312, items: 40, words: 90000,
      font_resolved: false, gutter_minimum_um: 15875, inner_um: 9525,
    }));
    await h.rail.open("pdf");
    const label = summary()?.getAttribute("aria-label") ?? "";
    expect(label).toContain("312 pages");
    expect(label).toContain("Crimson Text is not installed");
    expect(label).toContain("15.88 mm");
    // Painted and announced are the same words: the spans joined in order.
    expect(label).toBe(
      [...(summary()?.children ?? [])].map((c) => c.textContent).join(" "),
    );
  });

  test("one page is one page and not one pages", async () => {
    const h = mount({}, preview(), styleView(), proofView({ leaves: 1 }));
    await h.rail.open("pdf");
    expect(summary()?.textContent).toContain("1 page,");
  });

  test("a font the machine does not have is SAID, and one it has is not mentioned", async () => {
    // 040's recorded gap: this application ships no font files, and a writer
    // whose machine lacks the face "gets something else and is told nothing".
    // The control matters as much as the warning -- a rail that said this
    // always would be a rail nobody reads.
    const missing = mount({}, preview(), styleView(), proofView({ font_resolved: false }));
    await missing.rail.open("pdf");
    expect(summary()?.textContent).toContain("Crimson Text is not installed");
    missing.rail.destroy();
    document.body.replaceChildren();

    const present = mount({}, preview(), styleView(), proofView({ font_resolved: true }));
    live = present.rail;
    await present.rail.open("pdf");
    expect(summary()?.textContent).not.toContain("not installed");
  });

  test("the gutter is judged against the page count, and both verdicts are spoken", async () => {
    const clears = mount({}, preview(), styleView(), proofView({
      leaves: 312, gutter_minimum_um: 15875, inner_um: 19050,
    }));
    await clears.rail.open("pdf");
    expect(summary()?.textContent).toContain("at least 15.88 mm");
    expect(summary()?.textContent).toContain("19.05 mm");
    expect(summary()?.textContent).not.toContain("Book design");
    clears.rail.destroy();
    document.body.replaceChildren();

    const below = mount({}, preview(), styleView(), proofView({
      leaves: 312, gutter_minimum_um: 15875, inner_um: 9525,
    }));
    live = below.rail;
    await below.rail.open("pdf");
    expect(summary()?.textContent).toContain("Margins above");
  });

  test("a book outside a printer's range is told nothing about the gutter", async () => {
    const h = mount({}, preview(), styleView(), proofView({ leaves: 4, gutter_minimum_um: null }));
    await h.rail.open("pdf");
    expect(summary()?.textContent).not.toContain("spine");
  });

  test("a bounded preview says how much of the book it is showing", async () => {
    // The answer to a book too large to render in one go, and it is said rather
    // than left as a rail that quietly stops: a writer reading 48 pages of a
    // 312-page book must not conclude the other 264 are missing from the file.
    const h = mount({}, preview(), styleView(), proofView({ leaves: 312, truncated: true }));
    await h.rail.open("pdf");
    expect(summary()?.textContent).toContain("first 1 of 312 pages");
    expect(summary()?.textContent).toContain("The file has all of them");
  });

  test("a whole preview says nothing about being partial", async () => {
    const h = mount({}, preview(), styleView(), proofView({ truncated: false }));
    await h.rail.open("pdf");
    expect(summary()?.textContent).not.toContain("first");
  });

  test("a proof that could not be rendered is reported and paints no leaves", async () => {
    // NOT AN EMPTY RAIL. The recorded `renderImports([])` defect: a catch that
    // paints the designed empty state reports a host that could not answer as a
    // book with nothing in it.
    const h = mount({ readProof: async () => { throw new Error("no display"); } });
    await h.rail.open("pdf");
    expect(h.notices.some((m) => m.includes("no display"))).toBe(true);
    expect(leaves().length).toBe(0);
  });

  test("changing an option repaints the format on screen", async () => {
    // The four options are the BOOK's design and both formats read them, so a
    // press here has to re-render whichever book the writer is looking at.
    const h = mount();
    await h.rail.open("pdf");
    press("#preview-flag-drop_cap");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.written.at(-1)?.drop_cap).toBe(true);
    expect(h.proofReads).toBe(2);
    expect(h.reads).toBe(0);
  });

  test("reopening in the other format leaves nothing of the previous book on screen", async () => {
    // A rail that kept the archive's leaves while it fetched the proof would
    // show a writer one book under the other book's heading.
    // ONE DEFERRED, HANDED TO EVERY CALLER. A fake that builds a new promise
    // per call cannot be released from outside before the call happens -- the
    // recorded shared-latch shape -- and the test hangs instead of failing.
    let release: (v: PdfPreview) => void = () => {};
    const pending = new Promise<PdfPreview>((r) => (release = r));
    const h = mount({ readProof: () => pending });
    await h.rail.open("epub");
    expect(pages()?.childElementCount).toBeGreaterThan(0);
    const opening = h.rail.open("pdf");
    expect(pages()?.childElementCount).toBe(0);
    release(proofView());
    await opening;
    expect(leaves()[0]?.className).toBe("proof-leaf");
  });
});
