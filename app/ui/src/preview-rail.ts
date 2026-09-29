// app/ui/src/preview-rail.ts
// THE SIDE RAIL: the book as a FILE, beside the prose it is made of, with the
// four options that change it and the Save that writes it.
//
// ONE RAIL FOR BOTH BOOK FORMATS, and that is a decision rather than an
// economy. This was built for the EPUB; it also shows a proof copy for the PDF. Two rails
// would be two answers to where a preview lives, two Closes, two Save controls
// and two places to forget the six stylesheet lists -- and the FOUR OPTIONS ARE
// THE SAME OPTIONS, because `design.glyph` and `design.chapter` are the book\u2019s
// design and not a format\u2019s. What the format decides is what the rail reads,
// what it paints and what a Save writes.
//
// A RAIL AND NOT A PANEL, and that is the load-bearing distinction. Every panel
// in this application dismisses on a capture-phase outside click, and a preview
// that vanished the moment the writer clicked back into their prose would be a
// preview nobody could work beside. So there is no `closeOnOutsideClick` here,
// there is a Close control instead, and a test says so by name.
//
// IT IS THE THIRD GRID COLUMN, not an overlay anchored to the bar. Every other
// surface in this page is absolutely positioned against `#project-bar`
// precisely so the bar's 39px click-geometry constant is untouched; this one
// takes width from `#editor`, which is the bill the design record says arrives
// here. The column is `0` when the rail is closed, so a run that never opens it
// measures exactly what it measured before.
//
// NOTHING HERE COMPOSES XHTML. The host renders the archive, unzips it, and
// hands back what it read; this unit parses those bytes and paints them. That
// is the publishing track's constraint (c), and it means the rail can only
// disagree with the file when the file is wrong.
//
// NOTHING REPAINTS ON ITS OWN. A render is O(the manuscript) -- 240-300 ms at
// the `stress` fixture -- and this application's keystroke path is measured and
// gated. The rail renders when it is opened, when Refresh is pressed and when
// an option is changed, and it DRAINS the flush scheduler first, so what it
// shows is the book as saved. That is what an export is.
import { isCompositionKey } from "./composition-key";
import { plural, t } from "./i18n";
import {
  STYLE_FLAGS,
  gutterVerdict,
  parseDocumentBody,
  scaleFor,
  shrinkFor,
  scopeStylesheet,
  type ChapterStyle,
  type ChapterStyleView,
  type EpubPreview,
  type PdfPreview,
  type StyleFlag,
} from "./preview";
import { createProofPageSetup, type ProofPageSetup } from "./proof-page-setup";
import type { BookDesign, BookDesignView } from "./book-design";

/** Which book the rail is showing. The ids are the host\u2019s
 *  (`export::Format::id`), exactly as `export-formats.ts` restates them. */
export const PREVIEW_FORMATS = ["epub", "pdf"] as const;
export type PreviewFormat = (typeof PREVIEW_FORMATS)[number];

/** The id the stylesheet is scoped to, and the element the documents land in.
 *  One constant, because the scoping and the painting must name one element. */
const PAGES_ID = "preview-pages";

export interface PreviewRailDeps {
  /** The rail's own grid column from index.html. */
  readonly container: HTMLElement;
  /** Drains the flush scheduler. An export is "as saved", and so is a preview
   *  OF an export -- `drain()`, never `settled()`, for `export-bar.ts`'s
   *  recorded reason. */
  drain(): Promise<void>;
  /** Renders the book as an EPUB and reads the archive back. */
  read(): Promise<EpubPreview>;
  /** Lays the book out as a proof copy and reads the leaves back. */
  readProof(): Promise<PdfPreview>;
  /** The four options, and the ornaments the host offers. */
  readStyle(): Promise<ChapterStyleView>;
  /** Records the whole style and answers with what landed. */
  writeStyle(style: ChapterStyle): Promise<ChapterStyle>;
  readDesign(): Promise<BookDesignView>;
  writeDesign(design: BookDesign): Promise<BookDesign>;
  /** Hands off to the export the menu already has, as EPUB. NOT a second
   *  export path: `export-bar.ts` owns the drain, the single-flight latch and
   *  the notice, and a rail with its own would be a second answer to what
   *  happened. */
  saveAs(format: PreviewFormat): void;
  onNotice(message: string): void;
  /** Where focus goes when the rail is dismissed with Escape. */
  onDismiss(): void;
}

export interface PreviewRail {
  open(format: PreviewFormat): Promise<void>;
  /** Which book is on screen, or null when the rail is closed. */
  format(): PreviewFormat | null;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createPreviewRail(deps: PreviewRailDeps): PreviewRail {
  const { container } = deps;

  const rail = document.createElement("aside");
  rail.id = "preview-rail";
  // A COMPLEMENTARY REGION, not a dialog. It is not modal, it does not trap
  // focus, and it sits beside the prose rather than over it -- which is the one
  // thing that makes it different from every panel in this page.
  rail.setAttribute("role", "complementary");
  // The label and the heading name the FORMAT, and both are rewritten on every
  // open: a rail labelled "EPUB preview" while it shows a proof copy is a
  // region a screen-reader user is told the wrong thing about.
  rail.setAttribute("aria-label", t("preview.epub.label"));
  rail.tabIndex = -1;
  rail.hidden = true;

  const head = document.createElement("div");
  head.id = "preview-rail-head";
  const heading = document.createElement("h2");
  heading.textContent = t("preview.epub.label");
  const refresh = button("preview-refresh", t("preview.refresh"));
  const saveAs = button("preview-save-as", t("preview.save-as"));
  saveAs.dataset.weight = "primary";
  const closeControl = button("preview-close", t("preview.close"));
  head.append(heading, refresh, saveAs, closeControl);

  const ornamentGroup = document.createElement("div");
  ornamentGroup.id = "preview-ornament";
  ornamentGroup.setAttribute("role", "group");
  ornamentGroup.setAttribute("aria-label", t("preview.name.ornament"));
  const ornamentLegend = document.createElement("span");
  ornamentLegend.className = "preview-legend";
  ornamentLegend.setAttribute("aria-hidden", "true");
  ornamentLegend.textContent = t("preview.legend.ornament");
  const ornamentChoices = document.createElement("div");
  ornamentChoices.className = "preview-choices";
  ornamentGroup.append(ornamentLegend, ornamentChoices);

  const flagGroup = document.createElement("div");
  flagGroup.id = "preview-chapter";
  flagGroup.setAttribute("role", "group");
  flagGroup.setAttribute("aria-label", t("preview.name.chapter"));
  const flagLegend = document.createElement("span");
  flagLegend.className = "preview-legend";
  flagLegend.setAttribute("aria-hidden", "true");
  flagLegend.textContent = t("preview.legend.chapter");
  const flagChoices = document.createElement("div");
  flagChoices.className = "preview-choices";
  const flagButtons = new Map<StyleFlag, HTMLButtonElement>();
  for (const flag of STYLE_FLAGS) {
    const control = button(`preview-flag-${flag}`, t(`preview.option.${flag}`));
    control.dataset.previewFlag = flag;
    flagChoices.append(control);
    flagButtons.set(flag, control);
  }
  flagGroup.append(flagLegend, flagChoices);

  const note = document.createElement("p");
  note.id = "preview-note";
  note.textContent = t("preview.epub.note");

  const summary = document.createElement("p");
  summary.id = "preview-summary";
  summary.setAttribute("role", "status");

  const styleElement = document.createElement("style");
  styleElement.id = "preview-style";

  const pages = document.createElement("div");
  pages.id = PAGES_ID;

  rail.append(head, ornamentGroup, flagGroup, note, summary, styleElement, pages);
  container.append(rail);
  let pageSetup: ProofPageSetup | null = null;

  let destroyed = false;
  /** What the host last told us the four options are. Null while nothing has
   *  been read, which is the only state in which a control must do nothing. */
  let style: ChapterStyle | null = null;
  let glyphs: ChapterStyleView["glyphs"] = [];
  /** Which book is being shown, or null while the rail has never been opened.
   *  Read by the render, by Refresh and by Save as, so all three act on the
   *  format the writer is looking at rather than on the one a menu item last
   *  named. */
  let showing: PreviewFormat | null = null;
  /** An answer resolving after a newer render, after a close, or after teardown
   *  must not paint: the writer would be shown a book they have left. */
  let generation = 0;

  function button(id: string, label: string): HTMLButtonElement {
    const control = document.createElement("button");
    control.id = id;
    control.type = "button";
    control.textContent = label;
    return control;
  }

  /** aria-pressed on every option, never a class on the chosen one: "which of
   *  these is in effect" is what a toggle button's pressed state means, and it
   *  has to reach a screen reader. The design panel's rule. */
  function paintOptions(): void {
    if (style === null) return;
    for (const control of ornamentChoices.querySelectorAll<HTMLButtonElement>("button")) {
      const value = control.dataset.previewGlyph ?? "";
      control.setAttribute("aria-pressed", String(value === (style.glyph ?? "")));
    }
    for (const [flag, control] of flagButtons) {
      control.setAttribute("aria-pressed", String(style[flag]));
    }
  }

  function buildOrnaments(): void {
    ornamentChoices.replaceChildren();
    // NONE FIRST and it is a real choice rather than the absence of one: what
    // an absent ornament means is "the plainest book", and a writer turning one
    // off needs somewhere to press.
    const none = document.createElement("button");
    none.type = "button";
    none.textContent = t("preview.glyph.none");
    none.dataset.previewGlyph = "";
    ornamentChoices.append(none);
    for (const glyph of glyphs) {
      const control = document.createElement("button");
      control.type = "button";
      // THE ORNAMENT IS ITS OWN LABEL, and the catalog supplies the NAME for a
      // screen reader. A row of buttons reading "Asterism" tells a writer
      // nothing about what their book will look like; a row of buttons reading
      // the ornaments tells them exactly.
      control.textContent = glyph.ornament;
      control.setAttribute("aria-label", t(`preview.glyph.${glyph.id}`));
      control.dataset.previewGlyph = glyph.id;
      ornamentChoices.append(control);
    }
  }

  /** Paint the documents the host read out of the archive. */
  function paintPreview(view: EpubPreview): void {
    saySummary([
      plural("preview.epub.summary", view.items, {
        items: String(view.items),
        words: String(view.words),
      }),
    ]);
    // THE BOOK'S OWN STYLESHEET, scoped. A stylesheet this page cannot scope is
    // SAID rather than half applied -- see `scopeStylesheet`.
    const scoped = scopeStylesheet(view.css, `#${PAGES_ID} .epub-document`);
    styleElement.textContent = scoped ?? "";
    const painted: Node[] = [];
    if (scoped === null) painted.push(line(t("preview.error.stylesheet")));
    for (const document_ of view.documents) {
      const body = parseDocumentBody(document_.xhtml);
      if (body === null) {
        // NAMED, never skipped. A document a reading system will refuse is the
        // one thing a preview exists to show, and a gap where a chapter should
        // be reads as a chapter the writer forgot to write.
        painted.push(line(t("preview.error.document", { name: document_.name })));
        continue;
      }
      const imported = document.importNode(body, true);
      // THE ONE SUBSTITUTION, and it is not a second rendering. `../cover.png`
      // resolves inside the container and nowhere else; the data URI is cut
      // from the SAME archive entry that document points at.
      if (view.cover_data_uri !== null) {
        for (const image of imported.querySelectorAll("img")) {
          image.setAttribute("src", view.cover_data_uri);
          image.setAttribute("alt", t("preview.cover.alt"));
        }
      }
      const documentWrapper = document.createElement("div");
      documentWrapper.className = "epub-document";
      documentWrapper.append(...[...imported.childNodes]);
      painted.push(documentWrapper);
    }
    // NOT A PROOF. The attribute is removed rather than left, exactly as
    // `data-theme` is removed rather than set to `system`: a hook that is true
    // for the wrong surface works by accident until a rule is added for it.
    delete pages.dataset.proof;
    pages.replaceChildren(...painted);
  }

  /** Paint the leaves the printer was handed.
   *
   *  NOT XHTML. An EPUB document is XML and is parsed strictly, which is the
   *  whole of what that check buys; a proof leaf is HTML the engine itself
   *  serialised out of its own DOM, so parsing it as XML would fail on an
   *  `<img>` and report the writer's book as broken when nothing is. */
  function paintProof(view: PdfPreview): void {
    const lines: string[] = [
      plural("preview.pdf.summary", view.leaves, {
        leaves: String(view.leaves),
        items: String(view.items),
        words: String(view.words),
      }),
    ];
    // WHAT WAS MEASURED, NOT WHAT WAS ASKED FOR. This
    // application ships no font files, and a writer whose machine lacks the
    // face "gets something else and is told nothing". They are told now.
    if (!view.font_resolved) {
      lines.push(t("preview.pdf.font-missing", { font: view.font }));
    }
    // Another open gap: the gutter minimum is banded by page count, which
    // nothing knew until a book was laid out.
    const verdict = gutterVerdict(view.gutter_minimum_um, view.inner_um);
    if (verdict !== "unknown") {
      lines.push(t(`preview.pdf.gutter.${verdict}`, {
        pages: String(view.leaves),
        minimum: millimetres(view.gutter_minimum_um ?? 0),
        inner: millimetres(view.inner_um),
      }));
    }
    if (view.truncated) {
      lines.push(
        t("preview.pdf.truncated", {
          shown: String(view.pages.length),
          leaves: String(view.leaves),
        }),
      );
    }
    saySummary(lines);

    const scoped = scopeStylesheet(view.css, `#${PAGES_ID}`);
    styleElement.textContent = scoped ?? "";
    const painted: Node[] = [];
    if (scoped === null) painted.push(line(t("preview.error.stylesheet")));
    for (const leaf of view.pages) {
      const parsed = new DOMParser().parseFromString(leaf, "text/html");
      const element = parsed.body.firstElementChild;
      if (element === null) continue;
      painted.push(document.importNode(element, true));
    }
    // THE ATTRIBUTE THE STYLESHEET KEYS ON, written here rather than left to a
    // `:has()` selector: the recorded rule is to assert the attribute a unit
    // sets, because a `getComputedStyle` assertion under happy-dom is vacuous.
    pages.dataset.proof = "true";
    pages.replaceChildren(...painted);
    fit();
  }

  /** Shrink the leaves so a whole page fits the rail.
   *
   *  A LAYOUT READ, TAKEN ONCE PER PAINT. A proof leaf is 6 inches wide and the
   *  rail is not; without this the outer margin of every page -- the one a
   *  writer is checking -- is off the edge of the column. The rule itself is
   *  `scaleFor`, out in `preview.ts` where a mutation can reach it. */
  function fit(): void {
    const first = pages.firstElementChild;
    if (!(first instanceof HTMLElement)) return;
    // `clientWidth` INCLUDES THE PADDING and the leaf sits inside it, so
    // scaling against it makes every leaf exactly the padding too wide -- which
    // is a horizontal scrollbar under the book and the outer margin of every
    // page off the edge. Found by looking at the first capture.
    const box = window.getComputedStyle(pages);
    const inset = parseFloat(box.paddingLeft) + parseFloat(box.paddingRight);
    const scale = scaleFor(pages.clientWidth - (Number.isFinite(inset) ? inset : 0), first.offsetWidth);
    pages.style.setProperty("--proof-scale", String(scale));
    // The height the transform stops using. Without it the rail scrolls a
    // page-sized column of blank paper after every leaf.
    pages.style.setProperty(
      "--proof-shrink",
      [String(shrinkFor(first.offsetHeight, scale)), "px"].join(""),
    );
  }

  function sentence(text: string): HTMLElement {
    const element = document.createElement("span");
    element.textContent = text;
    return element;
  }

  /** Put the summary's sentences on the screen AND in its accessible name.
   *
   *  `#preview-summary` is `role="status"`, and WebKitGTK maps that to an ATK
   *  STATUS BAR WHOSE CHILDREN IT PRUNES. A walk of the live application read the node as `status
   *  bar name="" text="" kids=0` while "40 sections, 2000 words." was on the
   *  screen in front of the writer: the one sentence saying what this rail is
   *  showing reached assistive technology as nothing at all. `#word-count`
   *  carries its figures in an `aria-label` for exactly this reason and says so
   *  in its own header; `banner.ts` and the timeline's status line do the same.
   *  This is that fix, and it is the third statement of one WebKitGTK fact.
   *
   *  ONE FUNCTION FOR BOTH FORMATS, so the archive's summary and the proof's
   *  cannot drift into one being readable and the other not. The name is the
   *  same words in the same order, never a second phrasing: a screen-reader
   *  user and a sighted one are looking at one sentence.
   *
   *  WHAT THIS FIXES IS THAT THE SENTENCE CAN BE READ AT ALL. A live region
   *  announces its CONTENTS changing, and the contents are the half WebKitGTK
   *  prunes; naming the node makes the figures reachable on demand and does not
   *  by itself restore the announcement. Whether an actual screen reader speaks
   *  the change on this engine is untested here and is not claimed. */
  function saySummary(sentences: readonly string[]): void {
    summary.replaceChildren(...sentences.map(sentence));
    if (sentences.length === 0) {
      // Cleared rather than left, `#word-count`'s own rule: a name left behind
      // has the rail answer with the last book's figures until the next paint.
      summary.removeAttribute("aria-label");
      return;
    }
    summary.setAttribute("aria-label", sentences.join(" "));
  }

  /** Micrometres as millimetres, for a sentence a writer reads.
   *
   *  THE ONLY ARITHMETIC ON THIS SURFACE, and it is a unit conversion rather
   *  than a measurement: `covers.ts`'s rule is that the page holds no threshold,
   *  and the threshold here arrived from the host. The design panel converts the
   *  same way and neither stores what it displayed. */
  function millimetres(um: number): string {
    return String(Math.round(um / 10) / 100);
  }

  function line(text: string): HTMLElement {
    const element = document.createElement("p");
    element.className = "preview-problem";
    element.textContent = text;
    return element;
  }

  async function render(): Promise<void> {
    generation += 1;
    const mine = generation;
    try {
      // BOTH AWAITS INSIDE ONE TRY, and the drain first: a preview built over a
      // failed save would show the book without the writer's last sentence and
      // still be called their book.
      await deps.drain();
      // THE FORMAT IS READ BEFORE THE AWAIT AND CHECKED AFTER IT, on the
      // generation's own rule: a Refresh pressed for a proof must not paint an
      // archive because the rail was reopened as an EPUB while it ran.
      const wanted = showing;
      if (wanted === "pdf") {
        const view = await deps.readProof();
        if (destroyed || mine !== generation || showing !== wanted) return;
        paintProof(view);
        return;
      }
      const view = await deps.read();
      if (destroyed || mine !== generation || showing !== wanted) return;
      paintPreview(view);
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      // NOT AN EMPTY RAIL. A catch that painted the no-documents state would
      // report a host that could not answer as a book with nothing in it --
      // the recorded `renderImports([])` defect.
      pages.replaceChildren();
      deps.onNotice(t("preview.error.load", { error: messageOf(error) }));
    }
  }

  async function commit(next: ChapterStyle): Promise<void> {
    const mine = generation;
    try {
      const landed = await deps.writeStyle(next);
      if (destroyed) return;
      style = landed;
      paintOptions();
      await render();
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      // NO REPAINT HERE, AND THAT IS DELIBERATE RATHER THAN AN OMISSION.
      // The design panel repaints in its catch because it can be showing a
      // value the writer typed; this rail paints ONLY from the host's answer,
      // so on a refusal the pressed states already say exactly what the file
      // holds. A `paintOptions()` here was written first and a mutation
      // DELETING it survived the whole suite -- no input can tell it from its
      // absence, which is the `import_name_ok` shape, and a guard nothing can
      // reach is worse than none because a reader credits it. Do not add it
      // back: what makes the rail truthful is that nothing is painted before
      // the answer arrives.
      deps.onNotice(t("preview.error.style", { error: messageOf(error) }));
    }
  }

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A LINK IN THE PREVIEW IS INERT, and this is not a nicety. The generated
    // contents is a list of anchors whose hrefs resolve inside the CONTAINER;
    // this page is served from `tauri://localhost/index.html`, so following one
    // takes the whole webview to a document that is not there and the
    // application is gone, with no way back short of relaunching it. Found by
    // looking at the first capture.
    //
    // The href is LEFT ON THE ELEMENT rather than stripped: what is painted is
    // the document as the file holds it, and rewriting its markup to make the
    // preview safe would be the preview showing something the file does not
    // say. What is suppressed is the navigation, which is the page's business
    // and not the book's.
    if (target.closest(`#${PAGES_ID} a`) !== null) {
      event.preventDefault();
      return;
    }
    if (target.closest("#preview-close") !== null) {
      close();
      return;
    }
    if (target.closest("#preview-save-as") !== null) {
      if (showing !== null) deps.saveAs(showing);
      return;
    }
    if (target.closest("#preview-refresh") !== null) {
      void render();
      return;
    }
    const current = style;
    if (current === null) return;
    const ornament = target.closest<HTMLElement>("[data-preview-glyph]");
    if (ornament !== null) {
      const value = ornament.dataset.previewGlyph ?? "";
      // Narrowed against the list the host sent, so a value that reached the
      // DOM by any other route cannot be stored. `design-panel.ts`'s rule.
      if (value !== "" && !glyphs.some((g) => g.id === value)) return;
      void commit({ ...current, glyph: value === "" ? null : value });
      return;
    }
    const flag = target.closest<HTMLElement>("[data-preview-flag]")?.dataset.previewFlag;
    if (flag !== undefined && (STYLE_FLAGS as readonly string[]).includes(flag)) {
      const key = flag as StyleFlag;
      void commit({ ...current, [key]: !current[key] });
    }
  };

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
    deps.onDismiss();
  };

  function close(): void {
    // A CLOSE BUMPS THE GENERATION, so a render still in flight cannot paint
    // into a rail the writer has already dismissed.
    generation += 1;
    pageSetup?.hide();
    rail.hidden = true;
  }

  rail.addEventListener("click", onClick);
  rail.addEventListener("keydown", onKeyDown);

  return {
    async open(format: PreviewFormat): Promise<void> {
      // A REOPEN IN ANOTHER FORMAT BUMPS THE GENERATION, so a render still in
      // flight for the book the writer has left cannot paint over the one they
      // asked for.
      generation += 1;
      const opening = generation;
      showing = format;
      if (format !== "pdf") pageSetup?.hide();
      rail.setAttribute("aria-label", t(`preview.${format}.label`));
      heading.textContent = t(`preview.${format}.label`);
      note.textContent = t(`preview.${format}.note`);
      // THE NAME GOES WITH THE SENTENCES. A reopen that emptied the summary but
      // left its accessible name would announce the PREVIOUS book's figures
      // over the one the writer just asked for.
      saySummary([]);
      pages.replaceChildren();
      styleElement.textContent = "";
      rail.hidden = false;
      // THE RAIL, not a control inside it: landing on an option would look like
      // a setting had been reached for.
      rail.focus();
      const setupReady = format === "pdf"
        ? (pageSetup ??= createProofPageSetup(rail, {
            readDesign: deps.readDesign,
            writeDesign: deps.writeDesign,
            refresh: render,
            onNotice: deps.onNotice,
          }, note)).show()
        : Promise.resolve();
      try {
        await setupReady;
        if (destroyed || rail.hidden || opening !== generation) return;
        const answer = await deps.readStyle();
        if (destroyed || rail.hidden || opening !== generation) return;
        style = answer.style;
        glyphs = answer.glyphs;
        buildOrnaments();
        paintOptions();
      } catch (error: unknown) {
        if (destroyed) return;
        deps.onNotice(t("preview.error.style", { error: messageOf(error) }));
      }
      await render();
    },
    close,
    isOpen(): boolean {
      return !rail.hidden;
    },
    format(): PreviewFormat | null {
      return rail.hidden ? null : showing;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      pageSetup?.destroy();
      rail.removeEventListener("click", onClick);
      rail.removeEventListener("keydown", onKeyDown);
      container.replaceChildren();
    },
  };
}
