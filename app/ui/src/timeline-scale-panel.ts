// app/ui/src/timeline-scale-panel.ts
// `Edit scale…`: unit name, zero label,
// the calendar toggle and its month table, the year label, the epoch year,
// and the eras list.
//
// ANCHORED TO `#project-bar`, LIKE THE REST OF THE PAGE'S PANELS -- not to
// the toolbar button that opened it, which is INSIDE the timeline pane and
// would place the panel over the very lanes it edits. `closeOnOutsideClick`
// (dismiss-outside.ts) and Escape both close it, the two dismissals every
// panel here carries; the timeline's OWN event card (timeline-card.ts) closes
// on the same two events but re-implements them inline because it opens from
// a pressed button's own geometry -- this panel opens from a fixed anchor and
// has no reason to duplicate that.
//
// A FRESH PAINT PER OPEN, timeline-card.ts's own rule: `open()` replaces the
// panel's children outright rather than diffing a previous scale against a
// new one.
import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { placeBubble, type Rect } from "./bubble-placement";
import { closeOnOutsideClick } from "./dismiss-outside";
import { monthTableValid, type TimelineCalendar, type TimelineEra, type TimelineMonth, type TimelineScale } from "./timeline-model";

export interface TimelineScalePanelDeps {
  /** `<body>`, or a test's stand-in. */
  container: HTMLElement;
  onSave(scale: TimelineScale): void;
  onDismiss(): void;
}

export interface TimelineScalePanel {
  open(scale: TimelineScale, anchor: Rect, pane: Rect): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** The eight tints on `TimelineTrack.colour` are indexed 1..8; an era's tint
 *  is a SEPARATE, smaller palette (`--era-1..6`, design section 2), so the
 *  select this panel offers goes to 6, not 8. */
const ERA_TINT_COUNT = 6;

export function createTimelineScalePanel(deps: TimelineScalePanelDeps): TimelineScalePanel {
  const panel = document.createElement("div");
  panel.id = "timeline-scale-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "timeline-scale-panel-title");
  panel.tabIndex = -1;
  panel.style.position = "fixed";
  panel.hidden = true;
  deps.container.append(panel);

  let months: TimelineMonth[] = [];
  let eras: TimelineEra[] = [];
  let calendarOn = false;
  let error: string | null = null;

  function place(anchor: Rect, pane: Rect): void {
    const box = panel.getBoundingClientRect();
    const placed = placeBubble({ selection: anchor, bubble: { width: box.width, height: box.height }, pane, viewport: { width: window.innerWidth, height: window.innerHeight } });
    panel.style.left = `${placed.left}px`;
    panel.style.top = `${placed.top}px`;
  }

  function render(anchor: Rect, pane: Rect): void {
    panel.replaceChildren();

    const title = document.createElement("h2");
    title.id = "timeline-scale-panel-title";
    title.textContent = t("timeline.scale.panel.title");
    panel.append(title);

    const form = document.createElement("form");
    form.addEventListener("submit", (e) => e.preventDefault());

    const unitLabel = document.createElement("label");
    unitLabel.textContent = t("timeline.scale.field.unit");
    const unitInput = document.createElement("input");
    unitInput.type = "text";
    unitInput.id = "timeline-scale-unit";
    unitInput.value = pendingUnit;
    unitInput.addEventListener("input", () => (pendingUnit = unitInput.value));
    unitLabel.append(unitInput);
    form.append(unitLabel);

    const zeroLabel = document.createElement("label");
    zeroLabel.textContent = t("timeline.scale.field.zero-label");
    const zeroInput = document.createElement("input");
    zeroInput.type = "text";
    zeroInput.id = "timeline-scale-zero";
    zeroInput.value = pendingZero;
    zeroInput.addEventListener("input", () => (pendingZero = zeroInput.value));
    zeroLabel.append(zeroInput);
    form.append(zeroLabel);

    // THE PRESSED TOGGLE (item 6): `aria-pressed`, never a class on the
    // control itself, exactly design-panel.ts's own rule -- so this panel
    // joins the sixth selector list, not just the first four.
    const calendarToggle = document.createElement("button");
    calendarToggle.type = "button";
    calendarToggle.id = "timeline-scale-calendar-toggle";
    calendarToggle.textContent = t("timeline.scale.use-calendar");
    calendarToggle.setAttribute("aria-pressed", String(calendarOn));
    calendarToggle.addEventListener("click", () => {
      calendarOn = !calendarOn;
      render(anchor, pane);
    });
    form.append(calendarToggle);

    if (calendarOn) {
      const monthsFieldset = document.createElement("fieldset");
      monthsFieldset.id = "timeline-scale-months";
      const monthsLegend = document.createElement("legend");
      monthsLegend.textContent = t("timeline.scale.months");
      monthsFieldset.append(monthsLegend);

      months.forEach((m, i) => {
        const row = document.createElement("div");
        row.className = "timeline-scale-month-row";
        row.dataset.index = String(i);

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.setAttribute("aria-label", t("timeline.scale.month.name"));
        nameInput.value = m.name;
        nameInput.addEventListener("input", () => (months[i]!.name = nameInput.value));

        const daysInput = document.createElement("input");
        daysInput.type = "number";
        daysInput.step = "1";
        daysInput.setAttribute("aria-label", t("timeline.scale.month.days"));
        daysInput.value = String(m.days);
        daysInput.addEventListener("input", () => {
          const n = Number.parseInt(daysInput.value, 10);
          months[i]!.days = Number.isFinite(n) ? n : m.days;
        });

        const seasonInput = document.createElement("input");
        seasonInput.type = "text";
        seasonInput.setAttribute("aria-label", t("timeline.scale.month.season"));
        seasonInput.value = m.season;
        seasonInput.addEventListener("input", () => (months[i]!.season = seasonInput.value));

        // Alt+Up/Down reorder, the navigator row's own convention (plan item 2).
        const onRowKeyDown = (event: KeyboardEvent): void => {
          if (isCompositionKey(event)) return;
          if (!event.altKey) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          const step = event.key === "ArrowUp" ? -1 : 1;
          const target = i + step;
          if (target < 0 || target >= months.length) return;
          const [moved] = months.splice(i, 1);
          months.splice(target, 0, moved!);
          render(anchor, pane);
        };
        for (const el of [nameInput, daysInput, seasonInput]) el.addEventListener("keydown", onRowKeyDown);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = t("timeline.scale.month.remove");
        removeBtn.addEventListener("click", () => {
          months.splice(i, 1);
          render(anchor, pane);
        });

        row.append(nameInput, daysInput, seasonInput, removeBtn);
        monthsFieldset.append(row);
      });

      const addMonthBtn = document.createElement("button");
      addMonthBtn.type = "button";
      addMonthBtn.textContent = t("timeline.scale.month.add");
      addMonthBtn.addEventListener("click", () => {
        months.push({ name: "", days: 30, season: "" });
        render(anchor, pane);
      });
      monthsFieldset.append(addMonthBtn);
      form.append(monthsFieldset);

      const yearLabelLabel = document.createElement("label");
      yearLabelLabel.textContent = t("timeline.scale.field.year-label");
      const yearLabelInput = document.createElement("input");
      yearLabelInput.type = "text";
      yearLabelInput.value = pendingYearLabel;
      yearLabelInput.addEventListener("input", () => (pendingYearLabel = yearLabelInput.value));
      yearLabelLabel.append(yearLabelInput);
      form.append(yearLabelLabel);

      const epochLabel = document.createElement("label");
      epochLabel.textContent = t("timeline.scale.field.epoch-year");
      const epochInput = document.createElement("input");
      epochInput.type = "number";
      epochInput.step = "1";
      epochInput.value = String(pendingEpochYear);
      epochInput.addEventListener("input", () => {
        const n = Number.parseInt(epochInput.value, 10);
        if (Number.isFinite(n)) pendingEpochYear = n;
      });
      epochLabel.append(epochInput);
      form.append(epochLabel);
    }

    const erasFieldset = document.createElement("fieldset");
    erasFieldset.id = "timeline-scale-eras";
    const erasLegend = document.createElement("legend");
    erasLegend.textContent = t("timeline.era.eras");
    erasFieldset.append(erasLegend);

    eras.forEach((e, i) => {
      const row = document.createElement("div");
      row.className = "timeline-scale-era-row";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.setAttribute("aria-label", t("timeline.era.name"));
      nameInput.value = e.name;
      nameInput.addEventListener("input", () => (eras[i]!.name = nameInput.value));

      const fromInput = document.createElement("input");
      fromInput.type = "number";
      fromInput.step = "1";
      fromInput.setAttribute("aria-label", t("timeline.era.from"));
      fromInput.value = String(e.from);
      fromInput.addEventListener("input", () => {
        const n = Number.parseInt(fromInput.value, 10);
        eras[i]!.from = Number.isFinite(n) ? n : e.from;
      });

      const toInput = document.createElement("input");
      toInput.type = "number";
      toInput.step = "1";
      toInput.setAttribute("aria-label", t("timeline.era.to"));
      toInput.value = String(e.to);
      toInput.addEventListener("input", () => {
        const n = Number.parseInt(toInput.value, 10);
        eras[i]!.to = Number.isFinite(n) ? n : e.to;
      });

      const tintSelect = document.createElement("select");
      tintSelect.setAttribute("aria-label", t("timeline.era.tint"));
      for (let n = 1; n <= ERA_TINT_COUNT; n++) {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = String(n);
        tintSelect.append(opt);
      }
      tintSelect.value = String(e.tint);
      tintSelect.addEventListener("change", () => (eras[i]!.tint = Number.parseInt(tintSelect.value, 10)));

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = t("timeline.era.remove");
      removeBtn.addEventListener("click", () => {
        eras.splice(i, 1);
        render(anchor, pane);
      });

      row.append(nameInput, fromInput, toInput, tintSelect, removeBtn);
      erasFieldset.append(row);
    });

    const addEraBtn = document.createElement("button");
    addEraBtn.type = "button";
    addEraBtn.textContent = t("timeline.era.add");
    addEraBtn.addEventListener("click", () => {
      pendingEraCounter += 1;
      eras.push({ id: `pending-${pendingEraCounter}`, name: "", from: 0, to: 0, tint: 1 });
      render(anchor, pane);
    });
    erasFieldset.append(addEraBtn);
    form.append(erasFieldset);

    if (error !== null) {
      const errorEl = document.createElement("p");
      errorEl.id = "timeline-scale-error";
      errorEl.textContent = error;
      form.append(errorEl);
    }

    const buttons = document.createElement("div");
    buttons.className = "timeline-scale-buttons";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = t("timeline.scale.save");
    saveBtn.addEventListener("click", () => save(anchor, pane));
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = t("timeline.scale.cancel");
    cancelBtn.addEventListener("click", () => {
      close();
      deps.onDismiss();
    });
    buttons.append(saveBtn, cancelBtn);
    form.append(buttons);

    panel.append(form);
    place(anchor, pane);
  }

  // Held across re-renders (a month row edit, a toggle) rather than read back
  // from the DOM on Save, exactly `months`/`eras` above.
  let pendingUnit = "";
  let pendingZero = "";
  let pendingYearLabel = t("timeline.scale.year-label.default");
  let pendingEpochYear = 1;
  // MONOTONIC, NOT `eras.length` (review, MINOR): a pending era's id repeats
  // after a removal (add two, remove the first, add another -> two
  // "pending-1"), and the list uses this id as identity. Reset on every
  // `open()` -- a fresh document should not carry a counter forward from
  // whichever one was edited last.
  let pendingEraCounter = 0;

  function save(anchor: Rect, pane: Rect): void {
    // A MONTH TABLE WITH NO ROWS AND THE CALENDAR ON IS REFUSED AT SAVE (the
    // plan's own Decisions section), and so is any month with 0 or fewer
    // days (mutation target 3) -- `monthTableValid` is the one place both
    // rules live, shared with `calendarDate`'s own guard.
    if (calendarOn && !monthTableValid(months)) {
      error = t("timeline.calendar.days");
      render(anchor, pane);
      return;
    }
    for (const e of eras) {
      if (e.to < e.from) {
        error = t("timeline.era.range");
        render(anchor, pane);
        return;
      }
    }
    error = null;
    const calendar: TimelineCalendar | null = calendarOn
      ? { months, yearLabel: pendingYearLabel, epochYear: pendingEpochYear }
      : null;
    deps.onSave({ unit: pendingUnit, zero: pendingZero, calendar, eras });
    close();
  }

  function close(): void {
    panel.hidden = true;
    panel.replaceChildren();
  }

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Escape") return;
    if (panel.hidden) return;
    event.preventDefault();
    close();
    deps.onDismiss();
  };
  document.addEventListener("keydown", onKeyDown, true);
  const unsubscribeOutside = closeOnOutsideClick(
    panel,
    () => !panel.hidden,
    () => {
      close();
      deps.onDismiss();
    },
  );

  let destroyed = false;
  return {
    open(scale, anchor, pane) {
      pendingUnit = scale.unit;
      pendingZero = scale.zero;
      calendarOn = scale.calendar !== null;
      months = scale.calendar === null ? [] : scale.calendar.months.map((m) => ({ ...m }));
      pendingYearLabel = scale.calendar?.yearLabel ?? t("timeline.scale.year-label.default");
      pendingEpochYear = scale.calendar?.epochYear ?? 1;
      eras = scale.eras.map((e) => ({ ...e }));
      pendingEraCounter = 0;
      error = null;
      panel.hidden = false;
      render(anchor, pane);
      const unitField = panel.querySelector<HTMLInputElement>("#timeline-scale-unit");
      unitField?.focus();
    },
    close,
    isOpen: () => !panel.hidden,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      unsubscribeOutside();
      panel.remove();
    },
  };
}
