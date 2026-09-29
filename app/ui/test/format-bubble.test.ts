import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createFormatBubble, type FormatBubble } from "../src/format-bubble";
import type { Rect } from "../src/bubble-placement";
import { ICON_PATHS } from "../src/icons";
import { EN } from "../src/i18n";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

interface MountOptions {
  rect?: Rect | null;
  text?: string;
}

interface Rig {
  container: HTMLElement;
  bubble: FormatBubble;
  element: () => HTMLElement;
  calls: string[];
  focus: () => void;
  blur: (target: EventTarget | null) => void;
  select: (from: number, to: number) => void;
  show: (range: { from: number; to: number }) => void;
  tick: (ms: number) => void;
  /** How many debounce timers are currently armed. Used to prove a call
   *  after destroy() schedules nothing, rather than merely failing to paint
   *  -- a timer that fires into a detached element is the actual defect. */
  pendingTimers: () => number;
  destroy: () => void;
}

/** A manual clock, so the 250ms debounce can be driven a millisecond at a
 *  time without a real timer ever firing under the test runner. */
function mount(options: MountOptions = {}): Rig {
  const container = document.createElement("div");
  document.body.append(container);

  const calls: string[] = [];
  let sel = { from: 0, to: 0 };
  const rect: Rect | null = options.rect ?? null;
  const text = options.text ?? "";
  let now = 0;
  let timers: Timer[] = [];
  let nextId = 1;

  const bubble = createFormatBubble({
    container,
    pane: () => ({ left: 320, top: 39, right: 1200, bottom: 766 }),
    selection: () => sel,
    selectionRect: () => rect,
    selectedText: () => text,
    toggleBold: () => calls.push("bold"),
    toggleItalic: () => calls.push("italic"),
    toggleUnderline: () => calls.push("underline"),
    addComment: () => calls.push("comment"),
    findInBook: (query) => calls.push(`find:${query}`),
    addToDictionary: (word) => calls.push(`dict:${word}`),
    // happy-dom answers 0x0 for getBoundingClientRect regardless of what an
    // element holds; this is the number placement is asserted against.
    measure: () => ({ width: 200, height: 32 }),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
  });

  function element(): HTMLElement {
    const el = container.querySelector<HTMLElement>("#format-bubble");
    if (el === null) throw new Error("no #format-bubble in the container");
    return el;
  }

  function tick(ms: number): void {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (next === undefined) break;
      now = next.at;
      timers = timers.filter((timer) => timer.id !== next.id);
      next.fn();
    }
    now = until;
  }

  function focus(): void {
    bubble.onFocus();
  }

  function blur(target: EventTarget | null): void {
    bubble.onBlur(new FocusEvent("blur", { relatedTarget: target }));
  }

  function select(from: number, to: number): void {
    sel = { from, to };
    bubble.onSelection();
  }

  function show(range: { from: number; to: number }): void {
    focus();
    select(range.from, range.to);
    tick(300);
  }

  return {
    container,
    bubble,
    element,
    calls,
    focus,
    blur,
    select,
    show,
    tick,
    pendingTimers: () => timers.length,
    destroy: () => {
      bubble.destroy();
      container.remove();
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("the five controls", () => {
  test("it paints one button per mark, unpressed", () => {
    const rig = mount();
    for (const id of ["format-bold", "format-italic", "format-underline"]) {
      const el = rig.element().querySelector<HTMLButtonElement>(`#${id}`);
      expect(el).not.toBeNull();
      expect(el?.type).toBe("button");
      expect(el?.getAttribute("aria-pressed")).toBe("false");
    }
    for (const id of ["format-comment", "format-find"]) {
      const el = rig.element().querySelector<HTMLButtonElement>(`#${id}`);
      expect(el).not.toBeNull();
      expect(el?.hasAttribute("aria-pressed")).toBe(false);
    }
    rig.destroy();
  });

  test("each button carries its catalog string as its ACCESSIBLE NAME", () => {
    const rig = mount();
    const bar = rig.element();
    expect(bar.querySelector("#format-bold")?.getAttribute("aria-label")).toBe(EN["format.bold"]);
    expect(bar.querySelector("#format-italic")?.getAttribute("aria-label")).toBe(
      EN["format.italic"],
    );
    expect(bar.querySelector("#format-underline")?.getAttribute("aria-label")).toBe(
      EN["format.underline"],
    );
    expect(bar.querySelector("#format-comment")?.getAttribute("aria-label")).toBe(
      EN["format.comment"],
    );
    expect(bar.querySelector("#format-find")?.getAttribute("aria-label")).toBe(EN["format.find"]);
    rig.destroy();
  });

  test("the symbol is a vendored icon and it is hidden from the name", () => {
    const rig = mount();
    const bar = rig.element();
    for (const [id, icon] of [
      ["format-bold", "bold"],
      ["format-italic", "italic"],
      ["format-underline", "underline"],
      ["format-comment", "message-square"],
      ["format-find", "search"],
    ] as const) {
      const el = bar.querySelector<HTMLButtonElement>(`#${id}`);
      expect(el?.textContent?.trim()).toBe("");
      const svg = el?.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      expect(svg?.querySelector("path")?.getAttribute("d")).toBe(ICON_PATHS[icon][0]);
    }
    rig.destroy();
  });

  test("a name nobody can see has a visible route back, on hover AND on focus", () => {
    const rig = mount();
    const el = rig.element().querySelector<HTMLButtonElement>("#format-bold");
    if (el === null) throw new Error("no #format-bold");
    const anchor = el.parentElement;
    expect(anchor?.querySelector(".tip")).toBeNull();
    el.dispatchEvent(new FocusEvent("focus"));
    expect(anchor?.querySelector(".tip")?.textContent).toBe(EN["format.bold"]);
    el.dispatchEvent(new FocusEvent("blur"));
    expect(anchor?.querySelector(".tip")).toBeNull();
    el.dispatchEvent(new MouseEvent("mouseenter"));
    expect(anchor?.querySelector(".tip")).not.toBeNull();
    rig.destroy();
  });

  test("the underline control still says what the export cannot carry", () => {
    const rig = mount();
    const bar = rig.element();
    const underline = bar.querySelector<HTMLButtonElement>("#format-underline");
    if (underline === null) throw new Error("no #format-underline");
    underline.dispatchEvent(new FocusEvent("focus"));
    const tip = underline.parentElement?.querySelector<HTMLElement>(".tip");
    expect(tip?.textContent).toContain(EN["format.underline.hint"]);
    const bold = bar.querySelector<HTMLButtonElement>("#format-bold");
    bold?.dispatchEvent(new FocusEvent("focus"));
    const plain = bold?.parentElement?.querySelector<HTMLElement>(".tip");
    expect(plain?.textContent).toBe(EN["format.bold"]);
    expect(underline.title).toBe("");
    rig.destroy();
  });

  test("pressing a button calls its dep and nothing else", () => {
    const rig = mount();
    const bar = rig.element();
    bar.querySelector<HTMLButtonElement>("#format-italic")?.click();
    expect(rig.calls).toEqual(["italic"]);
    bar.querySelector<HTMLButtonElement>("#format-underline")?.click();
    bar.querySelector<HTMLButtonElement>("#format-bold")?.click();
    expect(rig.calls).toEqual(["italic", "underline", "bold"]);
    rig.destroy();
  });

  test("a press does not take focus away from the prose", () => {
    const rig = mount();
    const bar = rig.element();
    for (const id of [
      "format-bold",
      "format-italic",
      "format-underline",
      "format-comment",
      "format-find",
    ]) {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      bar.querySelector<HTMLButtonElement>(`#${id}`)?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    rig.destroy();
  });
});

describe("the pressed state", () => {
  test("it reflects what the selection carries", () => {
    const rig = mount();
    rig.bubble.setActive({ bold: true, italic: false, underline: true });
    const bar = rig.element();
    expect(bar.querySelector("#format-bold")?.getAttribute("aria-pressed")).toBe("true");
    expect(bar.querySelector("#format-italic")?.getAttribute("aria-pressed")).toBe("false");
    expect(bar.querySelector("#format-underline")?.getAttribute("aria-pressed")).toBe("true");
    rig.bubble.setActive({ bold: false, italic: false, underline: false });
    expect(bar.querySelector("#format-bold")?.getAttribute("aria-pressed")).toBe("false");
    expect(bar.querySelector("#format-underline")?.getAttribute("aria-pressed")).toBe("false");
    rig.destroy();
  });

  test("an unchanged reading writes nothing", () => {
    const rig = mount();
    rig.bubble.setActive({ bold: true, italic: false, underline: false });
    const el = rig.element().querySelector<HTMLButtonElement>("#format-bold");
    if (el === null) throw new Error("no #format-bold");
    let writes = 0;
    const original = el.setAttribute.bind(el);
    el.setAttribute = (name: string, value: string): void => {
      writes++;
      original(name, value);
    };
    rig.bubble.setActive({ bold: true, italic: false, underline: false });
    rig.bubble.setActive({ bold: true, italic: false, underline: false });
    expect(writes).toBe(0);
    rig.bubble.setActive({ bold: false, italic: false, underline: false });
    expect(writes).toBeGreaterThan(0);
    expect(el.getAttribute("aria-pressed")).toBe("false");
    rig.destroy();
  });
});

describe("the toolbar's own keyboard contract", () => {
  test("it is a toolbar with one tab stop and roving arrows", () => {
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.show({ from: 1, to: 4 });
    const bar = rig.element();
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe(EN["format.group.label"]);
    const buttons = [...bar.querySelectorAll("button")];
    // Six buttons; the dictionary control is hidden over a three-letter
    // selection whose text the rig leaves empty, and a hidden button is no stop.
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(buttons[5]?.hidden).toBe(true);
    buttons[0]?.focus();
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement?.id).toBe("format-find");
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement?.id).toBe("format-bold");

    // Arrow onto Find again, then hide and re-show: the roving stop must
    // come back to Bold rather than staying parked on whatever a PREVIOUS
    // selection last arrowed onto.
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement?.id).toBe("format-find");
    rig.select(4, 4);
    rig.show({ from: 1, to: 4 });
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    rig.destroy();
  });
});

describe("when it shows and hides", () => {
  test("it shows for a range with focus, after the debounce, at the placed spot", () => {
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.focus();
    rig.select(1, 4);
    expect(rig.element().hidden).toBe(true);
    rig.tick(250);
    expect(rig.element().hidden).toBe(false);
    expect(rig.element().style.left).toBe("550px");
    rig.destroy();
  });

  test("shown() tracks the same state hidden does: false, then true, then false", () => {
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    expect(rig.bubble.shown()).toBe(false);
    rig.focus();
    rig.select(1, 4);
    rig.tick(250);
    expect(rig.bubble.shown()).toBe(true);
    rig.select(4, 4);
    expect(rig.bubble.shown()).toBe(false);
    rig.destroy();
  });

  test("a collapse hides it at once; a blur to the bubble does not", () => {
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.focus();
    rig.select(1, 4);
    rig.tick(250);
    rig.blur(rig.element().querySelector("#format-bold"));
    expect(rig.element().hidden).toBe(false);
    rig.blur(document.body);
    expect(rig.element().hidden).toBe(true);
    rig.focus();
    rig.select(1, 4);
    rig.tick(250);
    rig.select(4, 4);
    expect(rig.element().hidden).toBe(true);
    rig.destroy();
  });

  test("a selection with no layout (null rect) never shows", () => {
    const rig = mount({ rect: null });
    rig.focus();
    rig.select(1, 4);
    rig.tick(250);
    expect(rig.element().hidden).toBe(true);
    rig.destroy();
  });

  test("a drag that keeps moving never shows until it rests", () => {
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.focus();
    rig.select(1, 4);
    rig.tick(200);
    rig.select(1, 6);
    rig.tick(200);
    expect(rig.element().hidden).toBe(true);
    rig.tick(50);
    expect(rig.element().hidden).toBe(false);
    rig.destroy();
  });

  test("Add comment and Find call their deps; Find hands over the selected words", () => {
    const rig = mount({
      rect: { left: 600, top: 300, right: 700, bottom: 320 },
      text: "two three",
    });
    rig.focus();
    rig.select(1, 4);
    rig.tick(250);
    rig.element().querySelector<HTMLButtonElement>("#format-comment")?.click();
    rig.element().querySelector<HTMLButtonElement>("#format-find")?.click();
    expect(rig.calls).toEqual(["comment", "find:two three"]);
    rig.destroy();
  });
});

describe("focus leaving the bar itself", () => {
  test("a focusout to a third element hides it; a focusout to another button does not", () => {
    // onBlur only ever hears the EDITOR's blur, which fires once, on the way
    // IN when a button first takes focus. Tab or Enter can then move focus
    // again without the editor ever hearing about it -- this is the other
    // half of the same relatedTarget check, answering for the bar's own
    // subtree instead.
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.show({ from: 1, to: 4 });
    rig.element().querySelector<HTMLButtonElement>("#format-bold")?.focus();
    rig.element().dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: document.body }),
    );
    expect(rig.element().hidden).toBe(true);

    rig.show({ from: 1, to: 4 });
    rig.element().querySelector<HTMLButtonElement>("#format-bold")?.focus();
    const italic = rig.element().querySelector<HTMLButtonElement>("#format-italic");
    rig.element().dispatchEvent(new FocusEvent("focusout", { relatedTarget: italic }));
    expect(rig.element().hidden).toBe(false);
    rig.destroy();
  });
});

describe("scroll and resize", () => {
  test("either one hides the bubble instead of chasing the selection", () => {
    // position: fixed in viewport coordinates: a scroll or a resize moves
    // what is under the toolbar without moving the toolbar. Hiding is one
    // listener per event and no per-frame placement work; re-placing on
    // every tick would cost exactly what 064's memory record says the
    // scroll path must not spend.
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.show({ from: 1, to: 4 });
    document.dispatchEvent(new Event("scroll"));
    expect(rig.element().hidden).toBe(true);

    rig.show({ from: 1, to: 4 });
    window.dispatchEvent(new Event("resize"));
    expect(rig.element().hidden).toBe(true);
    rig.destroy();
  });
});

describe("after destroy", () => {
  test("a selection arms nothing", () => {
    // Without a destroyed latch, onSelection still runs after destroy() has
    // removed the element: it would arm a debounce timer whose show() later
    // styles and un-hides a node no longer in any document. The editor
    // itself is torn down after this unit in project.ts's teardown order,
    // so a late transaction reaching onSelection is a real sequence, not a
    // hypothetical one.
    const rig = mount({ rect: { left: 600, top: 300, right: 700, bottom: 320 } });
    rig.focus();
    rig.destroy();
    rig.select(1, 4);
    expect(rig.pendingTimers()).toBe(0);
  });
});

describe("the dictionary control (111)", () => {
  const rect = { left: 600, top: 300, right: 700, bottom: 320 };

  test("it shows over one word and hides over more, decided at show time", () => {
    const one = mount({ rect, text: "Carahlo " });
    one.show({ from: 1, to: 9 });
    const control = one.element().querySelector<HTMLButtonElement>("#format-dictionary");
    expect(control?.hidden).toBe(false);
    expect(control?.getAttribute("aria-label")).toBe(EN["format.dictionary"]);
    expect(control?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    one.destroy();

    const many = mount({ rect, text: "two words" });
    many.show({ from: 1, to: 10 });
    expect(many.element().querySelector<HTMLButtonElement>("#format-dictionary")?.hidden).toBe(
      true,
    );
    many.destroy();
  });

  test("a press hands the trimmed word to the dependency", () => {
    const rig = mount({ rect, text: " Carahlo " });
    rig.show({ from: 1, to: 10 });
    rig.element().querySelector<HTMLButtonElement>("#format-dictionary")?.click();
    expect(rig.calls).toEqual(["dict:Carahlo"]);
    rig.destroy();
  });

  test("the roving stops reach it only while it is shown", () => {
    const rig = mount({ rect, text: "Carahlo" });
    rig.show({ from: 1, to: 8 });
    const bar = rig.element();
    bar.querySelector<HTMLButtonElement>("#format-bold")?.focus();
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement?.id).toBe("format-dictionary");
    rig.destroy();
  });
});
