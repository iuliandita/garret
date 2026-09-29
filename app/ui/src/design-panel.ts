// app/ui/src/design-panel.ts
// The one surface where a writer says how their book is set: the body font, the
// page, and the four margins.
//
// A PANEL OF ITS OWN AND NOT A GROUP IN PREFERENCES. Preferences is per WRITER
// and its one per-project group -- the dictionary -- calls itself out as the
// exception and costs a `setDictionary` repaint hook, because that panel is
// mounted once and a project switch must not leave the previous manuscript's
// words on screen. This panel READS ON EVERY OPEN instead, so it cannot show a
// book it is not about; there is nothing for a switch to repaint.
//
// NOTHING HERE IS APPLIED TO THE PAGE. `applyTypography` writes attributes on
// the live editor root; this unit writes nowhere but the store. A book's page
// size has no business changing what the writer is looking at, and the moment
// one of these values reached the editor root the two settings would have
// become one.
//
// NO SAVE BUTTON, deliberately, and not by omission: every control here IS the
// save, exactly as the preferences panel's are. A Save on a panel whose changes
// have already landed is a control a writer has to learn does nothing -- the
// recorded defect from the appearances slice, found by looking at a capture.
//
// NO UNBOUNDED LIST. Every row is a fixed set the host sent: two presets, four
// fonts, four page sizes, four margins. The other recorded capture defect is a
// primary action pushed under the fold by a list that grows with the book, and
// there is nothing here that can grow.
import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import {
  MARGIN_AXES,
  designName,
  editableInches,
  marginOf,
  micrometresFromInches,
  micrometresFromMillimetres,
  millimetres,
  pageReadout,
  withMargin,
  type BookDesign,
  type BookDesignView,
  type MarginAxis,
} from "./book-design";

export interface DesignPanelDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** How the OPEN book is set, and what else it could be set as. Called on
   *  every open: this panel is about whichever book is open now. */
  read(): Promise<BookDesignView>;
  /** Record the whole design and answer with what landed.
   *
   *  THE WHOLE DESIGN, ALWAYS, because the host checks all of it before writing
   *  any of it -- margins that do not fit the page must change nothing rather
   *  than the font and nothing else. The answer is what the panel repaints
   *  from: the file, not what this unit hoped it wrote. */
  write(design: BookDesign): Promise<BookDesign>;
  exportDesign(): Promise<string | null>;
  previewDesign(): Promise<DesignTransferPreview | null>;
  applyDesign(token: string): Promise<DesignTransferPreview>;
  onDone(message: string): void;
  onNotice(message: string): void;
  /** Where focus goes when the panel is dismissed with Escape. */
  onDismiss(): void;
}

export interface DesignTransferPreview {
  source: "book-design" | "salvage";
  token: string;
  changes: { field: string; before: string | null; after: string | null }[];
  skipped: { field: string; reason: string }[];
}

export interface DesignPanel {
  /** Open against the OPEN project, painted from what the host holds. */
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function transferValue(field: string, raw: string | null, view: BookDesignView | null): string {
  if (raw === null) return t("design.transfer.default");
  const invalid = t("design.transfer.invalid-saved");
  if (field === "font") {
    const valid = raw !== "" && raw.trim() === raw && [...raw].length <= 100 &&
      !/[\p{Cc}<>{}@;]/u.test(raw);
    return valid ? raw : invalid;
  }
  if (field === "page") {
    const found = /^(\d+)x(\d+)(?: ([a-z0-9-]+))?$/.exec(raw);
    if (found === null) return invalid;
    const width_um = Number(found[1]);
    const height_um = Number(found[2]);
    const name = found[3] ?? null;
    if (![width_um, height_um].every((size) => Number.isSafeInteger(size) && size >= 10_000 && size <= 1_000_000)) return invalid;
    const size = pageReadout({ width_um, height_um, name });
    if (name === null) return size;
    if (view?.page_sizes.some((page) => page.name === name)) {
      return t("design.transfer.named-page", { name: designName("page", name), size });
    }
    return t("design.transfer.custom-page", { name, size });
  }
  if (field === "margins") {
    const parts = raw.split(",");
    if (parts.length !== MARGIN_AXES.length || parts.some((part) => !/^[1-9]\d*$/.test(part) ||
        !Number.isSafeInteger(Number(part)))) return invalid;
    return MARGIN_AXES.map((axis, index) => t("design.transfer.margin-value", {
      axis: t(`design.margin.${axis}`), value: millimetres(Number(parts[index])),
    })).join(", ");
  }
  if (field === "glyph") {
    if (raw === "") return t("preview.glyph.none");
    return ["asterisks", "asterism", "fleuron", "diamond"].includes(raw)
      ? t(`preview.glyph.${raw}`) : invalid;
  }
  if (field === "chapter") {
    if (raw === "") return t("design.transfer.no-options");
    const flags = raw.split(" ");
    const known: Record<string, string> = {
      "new-page": "new_page", "caps-title": "caps_title", "drop-cap": "drop_cap",
    };
    if (flags.some((flag) => known[flag] === undefined) || new Set(flags).size !== flags.length) return invalid;
    return flags.map((flag) => t(`preview.option.${known[flag]}`)).join(", ");
  }
  if (field === "cover_fit_front" || field === "cover_fit_back") {
    if (raw === "contain" || raw === "fill") return t(`covers.fit.${raw}`);
  }
  return invalid;
}

export function createDesignPanel(deps: DesignPanelDeps): DesignPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "design-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("design.panel.label"));
  // So Escape is heard before anything inside takes focus. The recorded failure
  // of the fifth panel is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;

  const presetGroup = buildGroup("design-preset", t("design.legend.preset"), t("design.name.preset"));
  const fontGroup = buildGroup("design-font", t("design.legend.font"), t("design.name.font"));
  const pageGroup = buildGroup("design-page", t("design.legend.page"), t("design.name.page"));
  const pageSelect = document.createElement("select");
  pageSelect.id = "design-page-select";
  pageSelect.setAttribute("aria-label", t("design.name.page"));
  pageGroup.querySelector(".design-choices")?.append(pageSelect);

  /** WHAT THE PAGE ACTUALLY MEASURES, painted for every design. A size no
   *  button matches lights no button, and without this line the panel would
   *  then say nothing at all about the page the book is set on. */
  const pageReadoutLine = document.createElement("p");
  pageReadoutLine.id = "design-page-readout";
  pageReadoutLine.setAttribute("role", "status");

  const marginGroup = document.createElement("div");
  marginGroup.id = "design-margins";
  marginGroup.setAttribute("role", "group");
  marginGroup.setAttribute("aria-label", t("design.legend.margins"));
  const marginLegend = document.createElement("span");
  marginLegend.className = "design-legend";
  marginLegend.textContent = t("design.legend.margins");
  const unitChoices = document.createElement("span");
  unitChoices.className = "design-margin-choices";
  for (const unit of ["mm", "in"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `design-margin-unit-${unit}`;
    button.dataset.designMarginUnit = unit;
    button.setAttribute("aria-label", t(`design.margin.unit.label.${unit}`));
    button.textContent = unit;
    unitChoices.append(button);
  }
  marginLegend.append(unitChoices);
  marginGroup.append(marginLegend);

  const marginFields = new Map<MarginAxis, HTMLInputElement>();
  for (const axis of MARGIN_AXES) {
    const field = document.createElement("label");
    field.className = "design-margin";
    const caption = document.createElement("span");
    caption.className = "design-margin-name";
    caption.setAttribute("aria-hidden", "true");
    caption.textContent = t(`design.margin.${axis}`);
    const input = document.createElement("input");
    input.id = `design-margin-${axis}`;
    // `text`, not `number`: a spinner is a second interaction model in a page
    // whose panels are all click-and-Escape, and the parse is the same either
    // way. What a browser would validate for free is the one rule this page
    // deliberately does not own -- whether the design fits.
    input.type = "text";
    input.inputMode = "decimal";
    input.setAttribute("aria-label", t("design.margin.label.unit", { axis: t(`design.margin.${axis}`), unit: t("design.margin.unit.mm") }));
    const unit = document.createElement("span");
    unit.className = "design-margin-unit";
    unit.setAttribute("aria-hidden", "true");
    unit.textContent = t("design.margin.abbr.mm");
    field.append(caption, input, unit);
    marginGroup.append(field);
    marginFields.set(axis, input);
  }

  const transfer = document.createElement("div");
  transfer.id = "design-transfer";
  const transferTitle = document.createElement("p");
  transferTitle.textContent = t("design.transfer.heading");
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.dataset.designTransfer = "export";
  exportButton.textContent = t("design.transfer.export");
  const previewButton = document.createElement("button");
  previewButton.type = "button";
  previewButton.dataset.designTransfer = "preview";
  previewButton.textContent = t("design.transfer.preview");
  const review = document.createElement("div");
  review.id = "design-transfer-review";
  review.hidden = true;
  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.dataset.designTransfer = "apply";
  applyButton.textContent = t("design.transfer.apply");
  transfer.append(transferTitle, exportButton, previewButton, review, applyButton);
  applyButton.hidden = true;
  panel.append(presetGroup, fontGroup, pageGroup, pageReadoutLine, marginGroup, transfer);
  container.append(panel);

  let destroyed = false;
  /** What the host last told us this book is. Null while nothing has been read,
   *  which is the only state in which a control must do nothing at all. */
  let current: BookDesign | null = null;
  let view: BookDesignView | null = null;
  /** An answer resolving after a newer open, or after the panel closed, must
   *  not repaint: the writer would be shown a book they are no longer in. */
  let generation = 0;
  let marginUnit: "mm" | "in" = "mm";
  let pendingPreview: DesignTransferPreview | null = null;
  let transferBusy = false;

  function paintTransfer(preview: DesignTransferPreview): void {
    review.replaceChildren();
    const intro = document.createElement("p");
    intro.textContent = t("design.transfer.review", {
      source: t(`design.transfer.source.${preview.source}`),
    });
    review.append(intro);
    // A LIST OF SENTENCES, one per setting (239): "Body font changes from
    // Crimson Text to Author's Serif", never a log line with an arrow and a
    // "build default (no saved choice)" standing in for "the default".
    const list = document.createElement("ul");
    list.className = "design-transfer-changes";
    for (const change of preview.changes) {
      const line = document.createElement("li");
      line.textContent = t("design.transfer.change", {
        field: t(`design.transfer.field.${change.field}`),
        before: transferValue(change.field, change.before, view),
        after: transferValue(change.field, change.after, view),
      });
      list.append(line);
    }
    for (const skipped of preview.skipped) {
      const line = document.createElement("li");
      line.textContent = t("design.transfer.skipped", {
        field: t(`design.transfer.field.${skipped.field}`),
        reason: t(`design.transfer.reason.${skipped.reason}`),
      });
      list.append(line);
    }
    if (list.childElementCount > 0) review.append(list);
    const note = document.createElement("p");
    note.textContent = t("design.transfer.note");
    review.append(note);
    review.hidden = false;
    applyButton.hidden = preview.changes.length === 0;
  }

  async function runTransfer(action: "export" | "preview" | "apply"): Promise<void> {
    if (transferBusy) return;
    transferBusy = true;
    const mine = generation;
    try {
      if (action === "export") {
        const dest = await deps.exportDesign();
        if (!destroyed && mine === generation && dest !== null) deps.onDone(t("design.transfer.exported", { path: dest }));
      } else if (action === "preview") {
        pendingPreview = null;
        review.hidden = true;
        applyButton.hidden = true;
        const preview = await deps.previewDesign();
        if (destroyed || mine !== generation || preview === null) return;
        pendingPreview = preview;
        paintTransfer(preview);
      } else {
        const pending = pendingPreview;
        if (pending === null) return;
        await deps.applyDesign(pending.token);
        if (destroyed || mine !== generation) return;
        pendingPreview = null;
        review.hidden = true;
        applyButton.hidden = true;
        deps.onDone(t("design.transfer.applied"));
        let next: BookDesignView;
        try {
          next = await deps.read();
        } catch (error: unknown) {
          if (!destroyed && mine === generation) {
            deps.onNotice(t("design.transfer.refresh-error", { error: messageOf(error) }));
          }
          return;
        }
        if (destroyed || mine !== generation) return;
        view = next;
        current = next.design;
        paint();
      }
    } catch (error: unknown) {
      if (!destroyed && mine === generation) deps.onNotice(t("design.transfer.error", { error: messageOf(error) }));
    } finally {
      transferBusy = false;
    }
  }

  const formatMargin = (um: number): string => marginUnit === "mm" ? millimetres(um) : editableInches(um);
  const parseMargin = (text: string): number | null => marginUnit === "mm" ? micrometresFromMillimetres(text) : micrometresFromInches(text);

  function paintMarginUnit(): void {
    for (const button of unitChoices.querySelectorAll<HTMLButtonElement>("button")) {
      const unit = button.dataset.designMarginUnit;
      button.setAttribute("aria-pressed", String(unit === marginUnit));
    }
    for (const axis of MARGIN_AXES) {
      const input = marginFields.get(axis);
      if (input === undefined) continue;
      input.setAttribute("aria-label", t("design.margin.label.unit", { axis: t(`design.margin.${axis}`), unit: t(`design.margin.unit.${marginUnit}`) }));
      const suffix = input.nextElementSibling;
      if (suffix !== null) suffix.textContent = t(`design.margin.abbr.${marginUnit}`);
    }
  }

  function buildGroup(id: string, legend: string, name: string): HTMLElement {
    const group = document.createElement("div");
    group.id = id;
    // A group rather than a radiogroup, matching the preferences panel: radio
    // semantics promise arrow-key roving focus this page does not implement.
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", name);
    const caption = document.createElement("span");
    caption.className = "design-legend";
    caption.setAttribute("aria-hidden", "true");
    caption.textContent = legend;
    // A COLUMN OF ITS OWN FOR THE BUTTONS, not buttons as siblings of the
    // legend. With the legend in the same flex row, a row that wrapped -- Font,
    // at four family names -- began its second line UNDER THE LEGEND rather
    // than under the buttons above it, reading as another group with no name.
    // That is the preferences panel's recorded capture defect, met again here
    // and found the same way.
    const choices = document.createElement("div");
    choices.className = "design-choices";
    group.append(caption, choices);
    return group;
  }

  function buildButtons(
    group: HTMLElement,
    kind: string,
    values: readonly { value: string; label: string }[],
  ): void {
    const choices = group.querySelector(".design-choices");
    if (choices === null) return;
    choices.replaceChildren();
    for (const { value, label } of values) {
      const button = document.createElement("button");
      // NO id, unlike the preferences panel's buttons, and the reason is the
      // font row: a family name is a proper noun with spaces in it, and an
      // `id` may not carry whitespace. Slugging one would invent a second
      // spelling of a value that already crosses the IPC boundary, and giving
      // ids to three rows and not the fourth is the inconsistency a reader
      // would eventually "fix" by inventing it anyway. Everything that has to
      // find these -- a test, a rig, the click handler -- finds them by the
      // data attributes below, which hold the value verbatim.
      button.type = "button";
      button.textContent = label;
      button.dataset.designKind = kind;
      button.dataset.designValue = value;
      choices.append(button);
    }
  }

  /** aria-pressed on every button, never a class on the chosen one: "which of
   *  these is in effect" is exactly what a toggle button's pressed state means,
   *  and it has to reach a screen reader. */
  function paint(): void {
    const design = current;
    if (design === null) return;
    for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-design-value]")) {
      const kind = button.dataset.designKind;
      const value = button.dataset.designValue;
      const chosen =
        (kind === "font" && value === design.font) ||
        (kind === "preset" && value !== undefined && isPreset(value, design));
      button.setAttribute("aria-pressed", String(chosen));
    }
    if (view !== null) {
      const matching = view.page_sizes.find(
        (p) => p.width_um === design.page.width_um && p.height_um === design.page.height_um,
      );
      pageSelect.value = matching?.name ?? "";
    }
    pageReadoutLine.textContent = pageReadout(design.page);
    for (const axis of MARGIN_AXES) {
      const input = marginFields.get(axis);
      if (input === undefined) continue;
      // NOT WHILE THE WRITER IS IN IT. Rewriting the field under the caret
      // would move it to the end on every keystroke that reached a commit.
      if (document.activeElement === input) continue;
      input.value = formatMargin(marginOf(design.margins, axis));
    }
    paintMarginUnit();
  }

  /** Whether the design IS this preset, compared by value.
   *
   *  A stored `preset` name would be a fourth thing to keep in step with three
   *  values that can each be changed on their own -- press Fiction, widen the
   *  gutter, and a recorded name would go on claiming Fiction. What a writer
   *  reads here is true by construction instead. */
  function isPreset(id: string, design: BookDesign): boolean {
    const preset = view?.presets.find((p) => p.id === id);
    return preset !== undefined && JSON.stringify(preset.design) === JSON.stringify(design);
  }

  async function commit(next: BookDesign): Promise<void> {
    const mine = generation;
    try {
      const landed = await deps.write(next);
      if (destroyed || mine !== generation) return;
      current = landed;
      paint();
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      // REPAINT FROM WHAT WE STILL BELIEVE, so a refused margin does not leave
      // the field showing a value the file does not hold. The opposite of the
      // preferences panel's rule, and the difference is real: a refused
      // preference still applies in this window, and a refused design applies
      // nowhere at all.
      paint();
      deps.onNotice(t("design.error.save", { error: messageOf(error) }));
    }
  }

  const onPanelClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const transferButton = target.closest<HTMLButtonElement>("[data-design-transfer]");
    if (transferButton !== null) {
      const action = transferButton.dataset.designTransfer;
      if (action === "export" || action === "preview" || action === "apply") void runTransfer(action);
      return;
    }
    const unitButton = target.closest("[data-design-margin-unit]");
    if (unitButton instanceof HTMLButtonElement) {
      if (current === null) return;
      const next = unitButton.dataset.designMarginUnit as "mm" | "in" | undefined;
      if (next === undefined || next === marginUnit) return;
      const drafts = [...marginFields].map(([axis, input]) => ({ axis, input, um: parseMargin(input.value) }));
      if (drafts.some((draft) => draft.um === null)) {
        const typed = drafts.find((draft) => draft.um === null)?.input.value ?? "";
        deps.onNotice(t("design.error.margin.unit", { typed, unit: t(`design.margin.unit.${marginUnit}`) }));
        return;
      }
      marginUnit = next;
      for (const draft of drafts) draft.input.value = formatMargin(draft.um!);
      paintMarginUnit();
      return;
    }
    const button = target.closest("[data-design-value]");
    if (!(button instanceof HTMLElement)) return;
    const kind = button.dataset.designKind;
    const value = button.dataset.designValue;
    const design = current;
    if (kind === undefined || value === undefined || design === null) return;

    if (kind === "preset") {
      const preset = view?.presets.find((p) => p.id === value);
      if (preset === undefined) return;
      void commit(preset.design);
      return;
    }
    if (kind === "font") {
      // Narrowed against the list the host sent, so a value that reached the
      // DOM by any other route cannot be stored.
      if (!(view?.fonts ?? []).includes(value)) return;
      void commit({ ...design, font: value });
      return;
    }
  };

  // Keep the draft focused: blur would save or reset it before the unit click.
  const onUnitMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("[data-design-margin-unit]") === null) return;
    for (const input of marginFields.values()) {
      if (document.activeElement === input) {
        event.preventDefault();
        return;
      }
    }
  };

  /** A margin is committed when the writer LEAVES the field or presses Enter,
   *  not on every keystroke: `1` on the way to `19` is a legal measurement and
   *  a round trip nobody asked for. */
  const commitMargin = (axis: MarginAxis, input: HTMLInputElement): void => {
    const design = current;
    if (design === null) return;
    const um = parseMargin(input.value);
    if (um === null) {
      deps.onNotice(t("design.error.margin.unit", { typed: input.value, unit: t(`design.margin.unit.${marginUnit}`) }));
      input.value = formatMargin(marginOf(design.margins, axis));
      return;
    }
    if (um === marginOf(design.margins, axis)) return;
    void commit({ ...design, margins: withMargin(design.margins, axis, um) });
  };

  const onMarginChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    for (const [axis, field] of marginFields) {
      if (field === input) commitMargin(axis, input);
    }
  };

  const onMarginKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Enter") return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    event.preventDefault();
    for (const [axis, field] of marginFields) {
      if (field === input) commitMargin(axis, input);
    }
  };

  function close(): void {
    // A CLOSE BUMPS THE GENERATION, so a read still in flight cannot paint into
    // a panel the writer has already dismissed.
    generation += 1;
    pendingPreview = null;
    review.hidden = true;
    applyButton.hidden = true;
    panel.hidden = true;
  }

  panel.addEventListener("click", onPanelClick);
  unitChoices.addEventListener("mousedown", onUnitMouseDown);
  for (const input of marginFields.values()) {
    input.addEventListener("change", onMarginChange);
    input.addEventListener("keydown", onMarginKeyDown);
  }

  pageSelect.addEventListener("change", () => {
    const size = view?.page_sizes.find((p) => p.name === pageSelect.value);
    if (size === undefined || current === null) return;
    void commit({ ...current, page: { width_um: size.width_um, height_um: size.height_um, name: size.name } });
  });

  // Close, Escape and a click elsewhere (the shell's).
  const shell = createPanelShell({
    panel,
    title: t("design.heading"),
    titleId: "design-heading",
    close,
    returnFocus: deps.onDismiss,
  });

  return {
    async open(): Promise<void> {
      generation += 1;
      const mine = generation;
      pendingPreview = null;
      review.hidden = true;
      applyButton.hidden = true;
      panel.hidden = false;
      // The PANEL, not a control inside: landing on a button would look like a
      // setting had been reached for.
      panel.focus();
      try {
        const answer = await deps.read();
        if (destroyed || mine !== generation) return;
        view = answer;
        current = answer.design;
        buildButtons(
          presetGroup,
          "preset",
          answer.presets.map((p) => ({ value: p.id, label: designName("preset", p.id) })),
        );
        buildButtons(
          fontGroup,
          "font",
          // The FAMILY NAME is the label. There is no second string to drift
          // from what is stored, and a font is called what it is called.
          answer.fonts.map((font) => ({ value: font, label: font })),
        );
        pageSelect.replaceChildren();
        const matching = answer.page_sizes.some(
          (p) => p.width_um === answer.design.page.width_um && p.height_um === answer.design.page.height_um,
        );
        if (!matching) {
          const custom = document.createElement("option");
          custom.value = "";
        custom.disabled = true;
          custom.textContent = pageReadout(answer.design.page);
          pageSelect.append(custom);
        }
        for (const size of answer.page_sizes) {
          const option = document.createElement("option");
          option.value = size.name;
          option.textContent = designName("page", size.name);
          pageSelect.append(option);
        }
        paint();
      } catch (error: unknown) {
        if (destroyed || mine !== generation) return;
        // NOT AN EMPTY PANEL. A catch that painted the designed-nothing state
        // would report a host that could not answer as a book with no design --
        // the recorded `renderImports([])` defect.
        deps.onNotice(t("design.error.load", { error: messageOf(error) }));
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
      unitChoices.removeEventListener("mousedown", onUnitMouseDown);
      for (const input of marginFields.values()) {
        input.removeEventListener("change", onMarginChange);
        input.removeEventListener("keydown", onMarginKeyDown);
      }
      // THE ONE THAT MATTERS: it is on the document, so it outlives these
      // elements and would accumulate one live closure per project switch.
      shell.destroy();
      container.replaceChildren();
    },
  };
}
