import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createTooltip, type Tooltip } from "../src/tooltip";

interface Harness {
  control: HTMLButtonElement;
  tip: Tooltip;
}

function mount(hint: string | null = null): Harness {
  const control = document.createElement("button");
  control.type = "button";
  control.setAttribute("aria-label", "Bold");
  const tip = createTooltip({ control, name: "Bold", hint });
  document.body.append(tip.anchor);
  return { control, tip };
}

const shown = (t: Tooltip): boolean => !t.tip.hidden;

beforeEach(() => {
  document.body.replaceChildren();
});

describe("what a tooltip is here", () => {
  test("it rests hidden, outside the control, and outside its name", () => {
    // THE CONTROL'S NAME IS THE ONE THING THIS SLICE MUST NOT BREAK. A tip
    // INSIDE the button would be part of the button's name-from-content, so the
    // hint sentence would be read out as part of "Underline" to a screen-reader
    // user and every rig matching the name exactly would stop finding it.
    const { control, tip } = mount();
    try {
      expect(tip.tip.hidden).toBe(true);
      expect(tip.tip.getAttribute("aria-hidden")).toBe("true");
      expect(control.contains(tip.tip)).toBe(false);
      expect(tip.anchor.contains(control)).toBe(true);
      // NOT IN THE DOCUMENT AT REST, and that is a measured decision rather
      // than a tidiness one: mounted and hidden, the three tips cost
      // outline-cli about 2.5 ms on its mutation p95, for six elements a
      // writer sees only under the pointer.
      expect(tip.anchor.contains(tip.tip)).toBe(false);
    } finally {
      tip.destroy();
    }
  });

  test("it says what the control is called, and the hint when there is one", () => {
    // THE VISIBLE ROUTE BACK. The name used to be the visible text; it is an
    // aria-label now, which a sighted mouse user cannot read at all.
    const plain = mount();
    try {
      expect(plain.tip.tip.textContent).toContain("Bold");
      expect(plain.tip.tip.textContent).not.toContain("Markdown");
    } finally {
      plain.tip.destroy();
    }
    const hinted = mount("Underline is kept in your book but not in the Markdown export.");
    try {
      expect(hinted.tip.tip.textContent).toContain("Bold");
      expect(hinted.tip.tip.textContent).toContain("Markdown");
    } finally {
      hinted.tip.destroy();
    }
  });
});

describe("what it says can change", () => {
  test("a renamed control's tip says the new name", () => {
    // The status dot's name follows its state. It renames its tip in place
    // rather than rebuilding, because createTooltip moves the control into
    // its anchor and a rebuild would move the button on every state change.
    const { control, tip } = mount("Underline is kept in your book but not in the Markdown export.");
    try {
      tip.setName("Protected");
      control.dispatchEvent(new MouseEvent("mouseenter"));
      expect(tip.tip.textContent).toContain("Protected");
      expect(tip.tip.textContent).not.toContain("Bold");
      // The hint is not what was renamed.
      expect(tip.tip.textContent).toContain("Markdown");
    } finally {
      tip.destroy();
    }
  });
});

describe("when it appears", () => {
  test("on hover, and it goes away when the pointer leaves", () => {
    const { control, tip } = mount();
    try {
      control.dispatchEvent(new MouseEvent("mouseenter"));
      expect(shown(tip)).toBe(true);
      // And it is in the document while it is shown, or "shown" would be a flag
      // on an element nobody can see.
      expect(tip.anchor.contains(tip.tip)).toBe(true);
      // BESIDE the control and not inside it, asserted HERE and not only at
      // rest: at rest the tip is in no document at all, so `not inside the
      // control` is true of a build that puts it there the moment it is shown
      // -- and that build folds the hint sentence into the control's
      // accessible name. A mutation appending to the control instead of the
      // anchor survived until this line existed.
      expect(control.contains(tip.tip)).toBe(false);
      control.dispatchEvent(new MouseEvent("mouseleave"));
      expect(shown(tip)).toBe(false);
      expect(tip.anchor.contains(tip.tip)).toBe(false);
    } finally {
      tip.destroy();
    }
  });

  test("on KEYBOARD FOCUS, and it goes away on blur", () => {
    // THE HALF A `title` ATTRIBUTE CANNOT DO, and the reason this unit exists
    // rather than a one-line `element.title`. A keyboard user tabbing onto an
    // icon-only control gets a native tooltip never: the browser shows one for
    // the pointer alone. Without this the control has no name a sighted
    // keyboard user can reach at all.
    const { control, tip } = mount();
    try {
      control.dispatchEvent(new FocusEvent("focus"));
      expect(shown(tip)).toBe(true);
      control.dispatchEvent(new FocusEvent("blur"));
      expect(shown(tip)).toBe(false);
    } finally {
      tip.destroy();
    }
  });

  test("the pointer can enter the explanation and leave it again", () => {
    const { control, tip } = mount("A longer explanation.");
    try {
      control.dispatchEvent(new MouseEvent("mouseenter"));
      control.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: tip.tip }));
      tip.tip.dispatchEvent(new MouseEvent("mouseenter"));
      expect(shown(tip)).toBe(true);
      tip.tip.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
      expect(shown(tip)).toBe(false);
    } finally { tip.destroy(); }
  });

  test("focus retains help after the pointer leaves, and hover retains it after blur", () => {
    const { control, tip } = mount();
    try {
      control.dispatchEvent(new FocusEvent("focus"));
      control.dispatchEvent(new MouseEvent("mouseenter"));
      control.dispatchEvent(new MouseEvent("mouseleave"));
      expect(shown(tip)).toBe(true);
      control.dispatchEvent(new MouseEvent("mouseenter"));
      control.dispatchEvent(new FocusEvent("blur"));
      expect(shown(tip)).toBe(true);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(shown(tip)).toBe(false);
    } finally { tip.destroy(); }
  });

  test("Escape dismisses it while the control still has focus", () => {
    // A tip that can only be dismissed by leaving the control covers whatever
    // is under it for as long as the writer stays there.
    const { control, tip } = mount();
    try {
      control.dispatchEvent(new FocusEvent("focus"));
      expect(shown(tip)).toBe(true);
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(shown(tip)).toBe(false);
      // And an ordinary key does not dismiss it, or the assertion above would
      // hold for a handler that hides on anything at all.
      control.dispatchEvent(new FocusEvent("focus"));
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(shown(tip)).toBe(true);
    } finally {
      tip.destroy();
    }
  });
});

describe("teardown", () => {
  test("destroy() removes every listener it added", () => {
    // COUNTING, not behaviour. A leaked listener on a control that is itself
    // discarded changes nothing observable and is still one live closure per
    // project switch -- the recorded shape of the menu bar's capture-phase
    // handler, which no behavioural test could see.
    const control = document.createElement("button");
    const added: string[] = [];
    const removed: string[] = [];
    const addOriginal = control.addEventListener.bind(control);
    const removeOriginal = control.removeEventListener.bind(control);
    control.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (addOriginal as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof control.addEventListener;
    control.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (removeOriginal as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof control.removeEventListener;

    const tip = createTooltip({ control, name: "Bold", hint: null });
    document.body.append(tip.anchor);
    expect(added.length).toBeGreaterThan(0);
    tip.destroy();
    expect([...removed].sort()).toEqual([...added].sort());
  });

  test("a destroyed tooltip cannot be shown again", () => {
    const { control, tip } = mount();
    tip.destroy();
    control.dispatchEvent(new FocusEvent("focus"));
    expect(shown(tip)).toBe(false);
  });
});


test("the first Escape dismisses help and the second reaches its panel", () => {
  const { control, tip } = mount();
  const panel = document.createElement("div");
  document.body.append(panel);
  panel.append(tip.anchor);
  let closes = 0;
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) closes++;
  });
  control.focus();
  const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  control.dispatchEvent(first);
  expect(first.defaultPrevented).toBe(true);
  expect(shown(tip)).toBe(false);
  expect(closes).toBe(0);
  expect(document.activeElement === control).toBe(true);
  control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(closes).toBe(1);
  tip.destroy();
});
