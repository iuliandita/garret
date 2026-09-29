// app/ui/test/timeline-scale-panel.test.ts
// The scale panel had NO test file at all (review, MAJOR): `monthTableValid`
// was tested pure but nothing exercised `save()`, so mutation target 3 ("the
// month table accepts 0 days") survived at the surface that implements the
// refusal. This file closes that gap: the 0-day refusal, the empty-table
// refusal, the era range refusal, Save reaching `onSave` (never `onDirty`
// directly -- the view wires that, per the plan's own words), and Alt+Up/
// Down reorder.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTimelineScalePanel, type TimelineScalePanel } from "../src/timeline-scale-panel";
import type { TimelineScale } from "../src/timeline-model";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function baseScale(overrides: Partial<TimelineScale> = {}): TimelineScale {
  return {
    unit: "day",
    zero: "Kell's death",
    calendar: null,
    eras: [],
    ...overrides,
  };
}

const ANCHOR = rect(100, 20, 10, 10);
const PANE = rect(1200, 800);

describe("createTimelineScalePanel", () => {
  let container: HTMLElement;
  let panel: TimelineScalePanel;
  let saved: TimelineScale[];
  let dismissed: number;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    saved = [];
    dismissed = 0;
    panel = createTimelineScalePanel({
      container,
      onSave: (scale) => saved.push(scale),
      onDismiss: () => {
        dismissed += 1;
      },
    });
  });

  afterEach(() => {
    panel.destroy();
    document.body.replaceChildren();
  });

  function saveButton(): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save")!;
  }

  function calendarToggle(): HTMLButtonElement {
    return document.getElementById("timeline-scale-calendar-toggle") as HTMLButtonElement;
  }

  // NIT (review): the dialog carried no aria-labelledby to its own heading.
  test("the dialog is labelled by its own heading", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    const dialog = document.getElementById("timeline-scale-panel")!;
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).not.toBeNull();
    expect(document.getElementById(labelId!)?.tagName).toBe("H2");
  });

  test("opens with the unit and zero fields filled from the given scale", () => {
    panel.open(baseScale({ unit: "day", zero: "Kell's death" }), ANCHOR, PANE);
    const unitInput = document.getElementById("timeline-scale-unit") as HTMLInputElement;
    const zeroInput = document.getElementById("timeline-scale-zero") as HTMLInputElement;
    expect(unitInput.value).toBe("day");
    expect(zeroInput.value).toBe("Kell's death");
  });

  test("Save with no calendar reaches onSave, never onDirty directly (the view wires that)", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    saveButton().click();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.calendar).toBeNull();
    expect(panel.isOpen()).toBe(false);
  });

  // Mutation target 3, at the surface that actually implements it: deleting
  // the `monthTableValid` guard in `save()` must fail THIS test, not only
  // the pure `monthTableValid` unit tests.
  test("Save is refused when the calendar is on and a month has 0 days", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    calendarToggle().click();
    const addMonth = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "+ Month",
    )!;
    addMonth.click();
    // The freshly added row defaults to 30 days; drive it to 0.
    const daysInput = container.querySelector<HTMLInputElement>(".timeline-scale-month-row input[type='number']")!;
    daysInput.value = "0";
    daysInput.dispatchEvent(new Event("input", { bubbles: true }));
    saveButton().click();
    expect(saved).toEqual([]);
    expect(document.getElementById("timeline-scale-error")).not.toBeNull();
    expect(panel.isOpen()).toBe(true);
  });

  test("Save is refused when the calendar is on with an empty month table", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    calendarToggle().click();
    // No + Month press: the table is empty.
    saveButton().click();
    expect(saved).toEqual([]);
    expect(panel.isOpen()).toBe(true);
  });

  test("Save succeeds once the month table is valid, carrying the calendar", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    calendarToggle().click();
    const addMonth = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "+ Month",
    )!;
    addMonth.click();
    const row = container.querySelector<HTMLElement>(".timeline-scale-month-row")!;
    const [nameInput, daysInput] = [...row.querySelectorAll<HTMLInputElement>("input")];
    nameInput!.value = "Thaw";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    daysInput!.value = "36";
    daysInput!.dispatchEvent(new Event("input", { bubbles: true }));
    saveButton().click();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.calendar?.months).toEqual([{ name: "Thaw", days: 36, season: "" }]);
  });

  // Alt+Up/Down reorder, the navigator row's own convention.
  test("Alt+Down moves a month row later in the table", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    calendarToggle().click();
    const addMonth = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "+ Month",
    )!;
    addMonth.click();
    addMonth.click();
    const rows = () => [...container.querySelectorAll<HTMLElement>(".timeline-scale-month-row")];
    const firstRowNameInput = () => rows()[0]!.querySelector<HTMLInputElement>("input[type='text']")!;
    firstRowNameInput().value = "First";
    firstRowNameInput().dispatchEvent(new Event("input", { bubbles: true }));
    const secondRowNameInput = rows()[1]!.querySelector<HTMLInputElement>("input[type='text']")!;
    secondRowNameInput.value = "Second";
    secondRowNameInput.dispatchEvent(new Event("input", { bubbles: true }));

    firstRowNameInput().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));

    const namesAfter = rows().map((r) => r.querySelector<HTMLInputElement>("input[type='text']")!.value);
    expect(namesAfter).toEqual(["Second", "First"]);
  });

  test("Save is refused when an era's end comes before its start", () => {
    panel.open(baseScale({ eras: [{ id: "e1", name: "War", from: 10, to: 5, tint: 1 }] }), ANCHOR, PANE);
    saveButton().click();
    expect(saved).toEqual([]);
    expect(document.getElementById("timeline-scale-error")).not.toBeNull();
  });

  test("Save succeeds with a valid era, minting no new id for one already saved", () => {
    panel.open(baseScale({ eras: [{ id: "e1", name: "War", from: 5, to: 10, tint: 1 }] }), ANCHOR, PANE);
    saveButton().click();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.eras).toEqual([{ id: "e1", name: "War", from: 5, to: 10, tint: 1 }]);
  });

  // MINOR (review): a pending era's id repeated after a removal.
  test("pending era ids stay unique across an add, a remove, and another add", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    const addEra = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "+ Era")!.click();
    addEra();
    addEra();
    const removeFirst = container.querySelector<HTMLButtonElement>(".timeline-scale-era-row button")!;
    removeFirst.click();
    addEra();
    saveButton().click();
    const ids = saved[0]!.eras.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("Cancel closes without calling onSave, and calls onDismiss", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    const cancelBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    cancelBtn.click();
    expect(saved).toEqual([]);
    expect(dismissed).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  test("Escape closes and calls onDismiss without saving", () => {
    panel.open(baseScale(), ANCHOR, PANE);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(saved).toEqual([]);
    expect(dismissed).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });
});
