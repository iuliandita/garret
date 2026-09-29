// app/ui/test/cast-card.test.ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createCastCard, placeCastCard, type CastCardMember } from "../src/cast-card";

const MEMBER: CastCardMember = {
  id: "m1",
  kind: "character",
  name: "Kell",
  summary: "A wandering maestro.",
  fields: [{ label: "Age", value: "40" }],
};

function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.push({ fn, ms, id });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const at = pending.findIndex((p) => p.id === handle);
      if (at !== -1) pending.splice(at, 1);
    },
    fireDue(ms: number): void {
      // Fire every pending timer whose delay is <= ms, in the order armed --
      // enough fidelity for these tests without a real clock.
      const due = pending.filter((p) => p.ms <= ms);
      for (const p of due) {
        const at = pending.indexOf(p);
        if (at !== -1) pending.splice(at, 1);
        p.fn();
      }
    },
    count: () => pending.length,
  };
}

function mountMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "cast-mark";
  mark.dataset.memberId = "m1";
  mark.textContent = "Kell";
  mark.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    right: 140,
    bottom: 116,
    width: 40,
    height: 16,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
  document.body.append(mark);
  return mark;
}

describe("placeCastCard: pure geometry", () => {
  test("sits under the run when there is room below", () => {
    const placed = placeCastCard({
      mark: { left: 100, top: 100, right: 140, bottom: 116 },
      card: { width: 200, height: 80 },
      viewport: { left: 0, top: 0, right: 800, bottom: 600 },
    });
    expect(placed.top).toBe(124);
    expect(placed.left).toBe(100);
  });

  test("flips above when there is no room below", () => {
    const placed = placeCastCard({
      mark: { left: 100, top: 550, right: 140, bottom: 566 },
      card: { width: 200, height: 80 },
      viewport: { left: 0, top: 0, right: 800, bottom: 600 },
    });
    expect(placed.top).toBe(550 - 8 - 80);
  });

  test("clamps horizontally to the viewport", () => {
    const placed = placeCastCard({
      mark: { left: 700, top: 100, right: 740, bottom: 116 },
      card: { width: 200, height: 80 },
      viewport: { left: 0, top: 0, right: 800, bottom: 600 },
    });
    expect(placed.left).toBe(600);
  });
});

describe("createCastCard", () => {
  let container: HTMLElement;
  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
  });

  function build(overrides: Partial<Parameters<typeof createCastCard>[0]> = {}) {
    const timers = fakeTimers();
    const opened: string[] = [];
    const card = createCastCard({
      container,
      memberFor: (id) => (id === "m1" ? MEMBER : undefined),
      openInCast: (id) => opened.push(id),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      measure: () => ({ width: 200, height: 80 }),
      viewport: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      ...overrides,
    });
    return { card, timers, opened };
  }

  test("shows only after the show debounce, not on the first pointerover", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(card.shown()).toBe(false);
    timers.fireDue(450);
    expect(card.shown()).toBe(true);
    card.destroy();
  });

  test("MUTATION TARGET: pointer merely crossing the mark and leaving before the debounce shows nothing", () => {
    // A single fireDue(1000) at the end would fire the show timer and the
    // hide timer TOGETHER, in the order they were armed -- show first, then
    // hide -- so a scheduleHide that forgot to cancel the pending show would
    // still end at `shown() === false` (it flashes true, then hides in the
    // same call) and this test would pass either way. Checking the timer
    // count right after the crossing, before anything fires, is what tells
    // the two apart: with the show timer still armed there are two pending
    // timers, not one.
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(timers.count()).toBe(1);
    mark.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(timers.count()).toBe(1);
    timers.fireDue(200);
    expect(card.shown()).toBe(false);
    card.destroy();
  });

  test("hides 200ms after pointerleave, not sooner", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(card.shown()).toBe(true);
    mark.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(card.shown()).toBe(true);
    timers.fireDue(200);
    expect(card.shown()).toBe(false);
    card.destroy();
  });

  test("moving onto the card itself cancels the hide", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    const cardEl = document.getElementById("cast-card");
    if (cardEl === null) throw new Error("cast-card did not mount");
    mark.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: cardEl }));
    timers.fireDue(500);
    expect(card.shown()).toBe(true);
    card.destroy();
  });

  test("MAJOR FIX: mark to card to away hides after the hide delay, rather than sticking", () => {
    // The bug: leaving the mark for the card returned early without ever
    // setting `overMark` false, so leaving the card afterwards found
    // `overMark` still true and never scheduled a hide -- the card stuck up
    // until Escape. This crosses mark -> card -> away and expects the hide
    // that departure is owed.
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(card.shown()).toBe(true);
    const cardEl = document.getElementById("cast-card");
    if (cardEl === null) throw new Error("cast-card did not mount");
    mark.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: cardEl }));
    expect(card.shown()).toBe(true);
    cardEl.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(card.shown()).toBe(true);
    timers.fireDue(200);
    expect(card.shown()).toBe(false);
    card.destroy();
  });

  test("Escape hides the shown card", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(card.shown()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.shown()).toBe(false);
    card.destroy();
  });

  test("MUTATION TARGET: a document change hides the card even mid-hover", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(card.shown()).toBe(true);
    card.onDocChanged();
    expect(card.shown()).toBe(false);
    card.destroy();
  });

  test("aria-describedby is set on the mark while shown and cleared on hide", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(mark.getAttribute("aria-describedby")).toBe("cast-card");
    card.onDocChanged();
    expect(mark.getAttribute("aria-describedby")).toBeNull();
    card.destroy();
  });

  test("the open button calls openInCast with the shown member and hides", () => {
    const mark = mountMark();
    const { card, timers, opened } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    const button = document.getElementById("cast-card-open");
    if (button === null) throw new Error("cast-card-open did not mount");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual(["m1"]);
    expect(card.shown()).toBe(false);
    card.destroy();
  });

  test("MUTATION TARGET: the card never takes focus", () => {
    const mark = mountMark();
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(document.activeElement === document.getElementById("cast-card")).toBe(false);
    expect(document.getElementById("cast-card")?.getAttribute("tabindex")).toBeNull();
    card.destroy();
  });

  test("showFor shows at once, with no debounce, for the keyboard route", () => {
    const mark = mountMark();
    const { card } = build();
    card.showFor(mark, "m1");
    expect(card.shown()).toBe(true);
    card.destroy();
  });

  test("a vanished member (deleted between hover and debounce) shows nothing", () => {
    const mark = mountMark();
    mark.dataset.memberId = "gone";
    const { card, timers } = build();
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    timers.fireDue(450);
    expect(card.shown()).toBe(false);
    card.destroy();
  });
});
