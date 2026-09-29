// app/ui/src/covers-panel.ts
// The one surface where a writer puts a picture on the front and the back of
// their book.
//
// A PANEL OF ITS OWN AND NOT A BLOCK IN `File > Book design…`, and the argument
// is that panel's own. 040 recorded that it deliberately holds NOTHING THAT CAN
// GROW, and that this is why it has no `max-height` and no scroll: "the fix is
// to have no unbounded list, not to scroll one". Two cover previews are not
// unbounded, but they are TALL -- and a panel with no scroll that outgrows the
// window has no recourse at all, so the margin fields, which are the only things
// on that panel a writer has to reach with a caret, would go under the fold of a
// default window. That is the recorded capture defect (a primary control pushed
// down by something above it) waiting to be reintroduced by exactly the reader
// who thinks the two belong together.
//
// THEY DO BELONG TOGETHER, WHICH IS WHY THIS PANEL STATES THE PAGE. A cover is
// judged against the trim size the design panel sets, so the first line here
// says what that page is and where to change it. Coupled in fact, separate in
// surface.
//
// NO SAVE CONTROL, deliberately, and not by omission: every control here IS the
// act. Add, Change, Remove and View each do their whole job on the press. A Save
// on a panel whose changes have already landed is a control a writer has to
// learn does nothing -- the defect 039 found by looking at a capture, and 040
// pinned.
//
// THE PANEL NEVER NAMES A FILE, IN EITHER DIRECTION. It sends a side; the writer
// chooses a picture in the HOST's own OS dialog; the host copies it under a uuid
// it generated. So there is nothing inbound for a traversal rule to guard and
// nothing outbound a writer could paste somewhere -- 038's rule, one owner out.
//
// THE FINDINGS ARE A STATE AND NOT A NOTICE. Whether a cover suits this book
// depends on a page size the writer changes in another panel, so a verdict
// raised once when the picture was chosen would be stale exactly when it began
// to matter. Every open recomputes it, and it is painted beside the picture
// rather than announced.
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import {
  coverAlt,
  coverFindings,
  coverPageLine,
  coverSentence,
  sideName,
  type CoverPicture,
  type CoverSideView,
  type CoversView,
} from "./covers";

export interface CoversPanelDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** Both covers of the OPEN book, and the page they are judged against. Called
   *  on every open: this panel is about whichever book is open now, and the
   *  findings follow a page size that can have changed since it last looked. */
  read(): Promise<CoversView>;
  /** Open the operating system's picture dialog for `side` and attach what the
   *  writer chose. Null is CANCELLED, which is an answer and not a failure. */
  pick(side: string): Promise<CoversView | null>;
  /** Take the cover off, and its files with it. */
  clear(side: string): Promise<CoversView>;
  setFit(side: string, fit: string): Promise<CoversView>;
  /** The same picture at full size, for the viewer. Answers the same four
   *  states, because the file can go between the two reads. */
  full(side: string): Promise<CoverPicture>;
  /** Show a picture full size. The panel does not own the viewer: the cast
   *  panel shows one too, and one viewer is one answer to how big full size is. */
  showFullSize(dataUri: string, label: string): void;
  onNotice(message: string): void;
  onDone(message: string): void;
  /** Where focus goes when the panel is dismissed with Escape. */
  onDismiss(): void;
}

export interface CoversPanel {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCoversPanel(deps: CoversPanelDeps): CoversPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "covers-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("covers.panel.label"));
  // So Escape is heard before anything inside takes focus.
  panel.tabIndex = -1;
  panel.hidden = true;

  /** WHAT THE COVERS ARE JUDGED AGAINST, painted for every book. See the header. */
  const pageLine = document.createElement("p");
  pageLine.id = "covers-page";
  pageLine.setAttribute("role", "status");

  /** THE TWO SIDES SIT BESIDE EACH OTHER, which is how a book has them and is
   *  what keeps this panel half as tall as it would be stacked. A panel taller
   *  than the window has nowhere to put the controls at the bottom of it. */
  const sides = document.createElement("div");
  sides.id = "covers-sides";

  panel.append(pageLine, sides);
  container.append(panel);

  let destroyed = false;
  /** What the host last told us this book's covers are. Null while nothing has
   *  been read, which is the only state in which a control must do nothing. */
  let current: CoversView | null = null;
  /** An answer resolving after a newer open, after a newer act, or after the
   *  panel closed must not repaint: the writer would be shown a book they are
   *  no longer looking at. Every act bumps it, including a dialog, because a
   *  writer can dismiss the panel while the OS dialog is up. */
  let generation = 0;

  function paint(): void {
    const view = current;
    if (view === null) return;
    pageLine.textContent = coverPageLine(view.page);
    // WHETHER THERE IS ANYTHING TO ALIGN, and a capture is what asked for it.
    // The fixed picture frame exists so that two columns holding different
    // shapes and different numbers of sentences put their controls on one line.
    // With NO cover on either side there is nothing to align and the frame is a
    // 150px hole in the panel -- in the state every new book is in, which is the
    // first one a writer meets. A cross-column condition is not something CSS
    // can ask, so the panel answers it here and the stylesheet keys on it.
    sides.dataset.anyPicture = String(view.sides.some((s) => s.view.data_uri !== null));
    sides.replaceChildren();
    for (const side of view.sides) {
      sides.append(buildSide(side));
    }
  }

  /** One side's whole block, rebuilt per state rather than shown and hidden.
   *
   *  REBUILT, for `paintPicture`'s recorded reason in the cast panel: an `<img>`
   *  with no source is a broken-image glyph in every engine, and a Remove that
   *  is disabled whenever there is nothing to remove is a control a writer has
   *  to learn does nothing. */
  function buildSide(side: CoverSideView): HTMLElement {
    const block = document.createElement("div");
    block.className = "cover-side";
    block.dataset.coverSide = side.side;

    const legend = document.createElement("span");
    legend.className = "cover-legend";
    // The block's own accessible name carries the side, so this is decoration
    // for the eye -- `design-legend`'s rule.
    legend.setAttribute("aria-hidden", "true");
    legend.textContent = sideName(side.side);
    block.append(legend);

    // KEYED ON THE PICTURE AND NOT ON THE WORD. The host sends a `data_uri`
    // only with `present`, so a `state === "present" &&` beside this would
    // refuse exactly what the null check already refuses -- the redundancy a
    // mutation proved in the cast panel, where two rules covering for each
    // other made deleting one survive the whole suite.
    // A FRAME OF ITS OWN, AND A FIXED ONE, and a capture is what settled it.
    // The two sides' pictures are different shapes and their finding blocks are
    // different lengths, so painted straight into the column the front's
    // controls sat 66px above the back's -- two ragged stacks rather than two of
    // the same thing. A frame that is the same height whatever is in it makes
    // the sentences below start at the same line in both columns, and it holds
    // the empty state too, so a book with one cover aligns with a book with two.
    const frame = document.createElement("div");
    frame.className = "cover-frame";
    if (side.view.data_uri !== null) {
      const img = document.createElement("img");
      img.className = "cover-thumb";
      img.dataset.coverImage = side.side;
      img.src = side.view.data_uri;
      img.alt = coverAlt(side.side);
      frame.append(img);
    } else {
      const state = document.createElement("p");
      state.className = "cover-state";
      state.textContent = coverSentence(side.view.state);
      frame.append(state);
    }
    block.append(frame);

    const fitLabel = document.createElement("label");
    fitLabel.className = "cover-fit";
    fitLabel.textContent = t("covers.fit.label");
    const fitSelect = document.createElement("select");
    fitSelect.dataset.coverFitSide = side.side;
    for (const fit of ["contain", "fill"] as const) {
      const option = document.createElement("option");
      option.value = fit;
      option.textContent = t(`covers.fit.option.${fit}`);
      fitSelect.append(option);
    }
    fitSelect.value = side.fit;
    const fitExplanation = document.createElement("span");
    fitExplanation.dataset.coverFitExplanation = side.side;
    fitExplanation.textContent = t(`covers.fit.explain.${side.fit}`);
    fitLabel.append(fitSelect, fitExplanation);
    block.append(fitLabel);

    // WHAT IS TRUE ABOUT IT, including when nothing is wrong -- see
    // `coverFindings`. Only when there is something to measure: a book with no
    // cover has nothing said about its cover's sharpness.
    if (side.check !== null) {
      for (const sentence of coverFindings(side.check)) {
        const finding = document.createElement("p");
        finding.className = "cover-finding";
        finding.textContent = sentence;
        block.append(finding);
      }
    }

    // THE CONTROLS IN A GROUP, pushed to the bottom of the column by the
    // stylesheet. The finding block above is one sentence on one side and two on
    // the other, and controls that follow the text directly end up at two
    // different heights -- the second half of the capture defect the frame above
    // is the first half of.
    const controls = document.createElement("div");
    controls.className = "cover-controls";

    const choose = document.createElement("button");
    choose.type = "button";
    choose.dataset.coverAction = "pick";
    choose.dataset.coverSide = side.side;
    choose.textContent =
      side.view.state === "none" ? t("covers.choose") : t("covers.replace");
    controls.append(choose);

    // OFFERED ONLY WHEN THERE IS A PICTURE TO ENLARGE. The three broken states
    // have nothing to show, and a control that reports "there is nothing to
    // show" is a control that exists to disappoint.
    if (side.view.data_uri !== null) {
      const view = document.createElement("button");
      view.type = "button";
      view.dataset.coverAction = "full";
      view.dataset.coverSide = side.side;
      view.textContent = t("covers.view");
      controls.append(view);
    }

    // OFFERED IN THE THREE STATES THAT HAVE A CLAIM ON A FILE -- including when
    // the file is gone or unreadable, which is exactly when removing is what the
    // writer wants: the book says it has a cover and there is no way to see it,
    // so taking the claim off is the repair. `cast-panel.ts`'s rule.
    //
    // NO `data-weight="danger"`, and 038's capture is what settled it: the file
    // it unlinks is a COPY and the picture the writer chose is still wherever
    // they got it. An application that shouts at every removal teaches a writer
    // to ignore it shouting.
    if (side.view.state !== "none") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.coverAction = "clear";
      remove.dataset.coverSide = side.side;
      remove.textContent = t("covers.remove");
      controls.append(remove);
    }

    block.append(controls);
    return block;
  }

  async function act(
    side: string,
    run: () => Promise<CoversView | null>,
    done: string,
  ): Promise<void> {
    const mine = generation;
    try {
      const landed = await run();
      if (destroyed || mine !== generation) return;
      // CANCELLED IS AN ANSWER. No notice, no announcement, no repaint --
      // `project_export_as`'s rule, and the writer did exactly what they
      // intended.
      if (landed === null) return;
      current = landed;
      paint();
      deps.onDone(t(done, { side: sideName(side) }));
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      deps.onNotice(t("covers.error.change", { error: messageOf(error) }));
    }
  }

  async function showFull(side: string): Promise<void> {
    const mine = generation;
    try {
      const picture = await deps.full(side);
      if (destroyed || mine !== generation) return;
      if (picture.data_uri === null) {
        // NAMED RATHER THAN SILENT. A full read can fail where the thumbnail
        // beside it succeeded -- the file can go between the two reads -- and a
        // press that appears to do nothing reads as a broken control.
        deps.onNotice(t("viewer.unavailable"));
        return;
      }
      deps.showFullSize(picture.data_uri, coverAlt(side));
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      deps.onNotice(t("viewer.error", { error: messageOf(error) }));
    }
  }

  const onPanelClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-cover-action]");
    if (!(button instanceof HTMLElement)) return;
    const action = button.dataset.coverAction;
    const side = button.dataset.coverSide;
    if (side === undefined || current === null) return;
    // EVERY ACT BUMPS THE GENERATION, so an answer for the press before it
    // cannot paint over the one the writer is looking at.
    generation += 1;
    if (action === "pick") {
      void act(side, () => deps.pick(side), "covers.done.added");
      return;
    }
    if (action === "clear") {
      void act(side, () => deps.clear(side), "covers.done.removed");
      return;
    }
    if (action === "full") {
      void showFull(side);
    }
  };

  const onPanelChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const side = target.dataset.coverFitSide;
    if (side === undefined || current === null) return;
    generation += 1;
    void act(side, () => deps.setFit(side, target.value), "covers.done.fit");
  };

  function close(): void {
    // A CLOSE BUMPS THE GENERATION, so a read still in flight cannot paint into
    // a panel the writer has already dismissed -- and, here, so a picture
    // arriving from an OS dialog the writer walked away from cannot either.
    generation += 1;
    panel.hidden = true;
    // THE THUMBNAILS GO WITH IT. Two data URIs is not much, and holding them
    // for the life of the window for a panel nobody is looking at is the shape
    // the viewer's own `close` refuses at a hundred times the size.
    sides.replaceChildren();
  }

  panel.addEventListener("click", onPanelClick);
  panel.addEventListener("change", onPanelChange);

  // Close, Escape and a click elsewhere (the shell's).
  const shell = createPanelShell({
    panel,
    title: t("covers.heading"),
    titleId: "covers-heading",
    close,
    returnFocus: deps.onDismiss,
  });

  return {
    async open(): Promise<void> {
      generation += 1;
      const mine = generation;
      panel.hidden = false;
      // The PANEL, not a control inside: landing on Add a cover would look like
      // the application had reached for the writer's file dialog.
      panel.focus();
      try {
        const answer = await deps.read();
        if (destroyed || mine !== generation) return;
        current = answer;
        paint();
      } catch (error: unknown) {
        if (destroyed || mine !== generation) return;
        // NOT AN EMPTY PANEL. A catch that painted the no-cover state would
        // report a host that could not answer as a book with no covers -- the
        // recorded `renderImports([])` defect.
        deps.onNotice(t("covers.error.load", { error: messageOf(error) }));
        close();
      }
    },
    close,
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel.removeEventListener("click", onPanelClick);
      panel.removeEventListener("change", onPanelChange);
      shell.destroy();
      container.replaceChildren();
    },
  };
}
