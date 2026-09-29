import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTimelineCard, type TimelineCard, type TimelineCardDeps } from "../src/timeline-card";
import type { TimelineEvent, TimelineTrack } from "../src/timeline-model";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "v1",
    title: "Publishes survey",
    at: 372,
    until: null,
    tracks: ["t1"],
    branch: null,
    scene: null,
    cast: [],
    note: "",
    ...overrides,
  };
}

const tracks: TimelineTrack[] = [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }];
const rect = { left: 0, top: 0, right: 0, bottom: 0 };

describe("createTimelineCard", () => {
  let container: HTMLElement;
  let saved: Array<{ id: string; patch: Partial<TimelineEvent> }>;
  let deleted: string[];
  let opened: string[];
  let dismissed: number;
  let card: TimelineCard;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    saved = [];
    deleted = [];
    opened = [];
    dismissed = 0;
    const deps: TimelineCardDeps = {
      container,
      cast: () => [],
      items: () => [{ id: "it-1", title: "Chapter One", type: "scene" }],
      sceneTitle: (id) => (id === "it-1" ? "Chapter One" : undefined),
      calendar: () => null,
      branches: () => [],
      onSave: (id, patch) => saved.push({ id, patch }),
      onDelete: (id) => deleted.push(id),
      onOpenScene: (id) => opened.push(id),
      onDismiss: () => dismissed++,
    };
    card = createTimelineCard(deps);
  });

  afterEach(() => {
    card.destroy();
    document.body.replaceChildren();
  });

  test("read mode shows the title and is not hidden", () => {
    card.open(event(), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    expect(el.hidden).toBe(false);
    expect(el.querySelector("h2")?.textContent).toBe("Publishes survey");
  });

  test("Open scene is disabled when the event has no scene", () => {
    card.open(event({ scene: null }), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Open scene")!;
    expect(btn.disabled).toBe(true);
  });

  test("Open scene calls onOpenScene with the scene id when present", () => {
    card.open(event({ scene: "it-1" }), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Open scene")!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(opened).toEqual(["it-1"]);
  });

  // MAJOR (review): onOpenScene routes through an async switch (doc_load);
  // a card left open over that in-flight load is interactive over a
  // document that has not arrived yet.
  test("Open scene closes the card", () => {
    card.open(event({ scene: "it-1" }), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Open scene")!;
    btn.click();
    expect(card.isOpen()).toBe(false);
    expect(el.hidden).toBe(true);
  });

  test("a gone scene shows the gone sentence and a disabled link", () => {
    card.open(event({ scene: "missing" }), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    expect(el.textContent).toContain("This scene is missing or in the bin.");
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Open scene")!;
    expect(btn.disabled).toBe(true);
  });

  // Mutation target 5's own shape, restated for the card: Delete arms first.
  test("Delete arms on the first press and deletes on the second", () => {
    card.open(event(), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const del = () => [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Delete"))!;
    del().click();
    expect(deleted).toEqual([]);
    expect(del().hasAttribute("data-armed")).toBe(true);
    del().click();
    expect(deleted).toEqual(["v1"]);
  });

  test("Edit switches to a form with the current title", () => {
    card.open(event(), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const editBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Edit")!;
    editBtn.click();
    const titleInput = el.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(titleInput.value).toBe("Publishes survey");
  });

  // Mutation target 3: a Save must call onDirty (here: onSave).
  test("Save calls onSave with the edited fields", () => {
    card.open(event(), tracks, rect, rect, "edit");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const titleInput = el.querySelector<HTMLInputElement>('input[type="text"]')!;
    titleInput.value = "New title";
    const saveBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    saveBtn.click();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe("v1");
    expect(saved[0]!.patch.title).toBe("New title");
  });

  // REVIEW ITEM 11: the scene picker had role=listbox/option with no arrow-
  // key navigation and no aria-activedescendant, and Enter always picked
  // the FIRST match regardless of what the writer had arrowed to.
  test("the scene picker's Down arrow moves aria-activedescendant, and Enter picks the active row", () => {
    const items = [
      { id: "it-1", title: "Chapter One", type: "scene" },
      { id: "it-2", title: "Chapter Two", type: "scene" },
      { id: "it-3", title: "Chapter Three", type: "scene" },
    ];
    // Destroy the shared beforeEach card first: both it and the one this
    // test builds carry the SAME id ("timeline-card"), and two live at once
    // would make getElementById return whichever happens to be first.
    card.destroy();
    const localSaved: Array<{ id: string; patch: Partial<TimelineEvent> }> = [];
    const localContainer = document.createElement("div");
    document.body.append(localContainer);
    const localCard = createTimelineCard({
      container: localContainer,
      cast: () => [],
      items: () => items,
      sceneTitle: () => undefined,
      calendar: () => null,
      branches: () => [],
      onSave: (id, patch) => localSaved.push({ id, patch }),
      onDelete: () => {},
      onOpenScene: () => {},
      onDismiss: () => {},
    });
    localCard.open(event({ scene: null }), tracks, rect, rect, "edit");
    const el = localContainer.querySelector<HTMLElement>("#timeline-card")!;
    const sceneField = el.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    // Typing narrows the list; all three still match "Chapter".
    sceneField.value = "Chapter";
    sceneField.dispatchEvent(new Event("input", { bubbles: true }));

    expect(sceneField.getAttribute("aria-activedescendant")).toBe("timeline-card-scene-it-1");
    sceneField.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(sceneField.getAttribute("aria-activedescendant")).toBe("timeline-card-scene-it-2");
    sceneField.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(sceneField.getAttribute("aria-activedescendant")).toBe("timeline-card-scene-it-3");
    const activeRow = document.getElementById("timeline-card-scene-it-3")!;
    expect(activeRow.getAttribute("aria-selected")).toBe("true");
    const firstRow = document.getElementById("timeline-card-scene-it-1")!;
    expect(firstRow.getAttribute("aria-selected")).toBe("false");

    sceneField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sceneField.value).toBe("Chapter Three");

    // Save carries the ACTIVE row's id (it-3), not the first match (it-1).
    const saveBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    saveBtn.click();
    expect(localSaved).toHaveLength(1);
    expect(localSaved[0]!.patch.scene).toBe("it-3");

    localCard.destroy();
  });

  test("Enter in the title field saves", () => {
    card.open(event(), tracks, rect, rect, "edit");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    const titleInput = el.querySelector<HTMLInputElement>('input[type="text"]')!;
    titleInput.value = "Via Enter";
    titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.patch.title).toBe("Via Enter");
  });

  test("Escape closes the card and calls onDismiss", () => {
    card.open(event(), tracks, rect, rect, "read");
    expect(card.isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card.isOpen()).toBe(false);
    expect(dismissed).toBe(1);
  });

  test("a click outside the card closes it", () => {
    card.open(event(), tracks, rect, rect, "read");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card.isOpen()).toBe(false);
  });

  test("a click inside the card does not close it", () => {
    card.open(event(), tracks, rect, rect, "read");
    const el = container.querySelector<HTMLElement>("#timeline-card")!;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card.isOpen()).toBe(true);
  });
});
