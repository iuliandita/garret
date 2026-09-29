import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createChromeFade, HIDDEN_CLASS, HIDE_AFTER_MS, type ChromeFade } from "../src/chrome-fade";

// Held so afterEach can always reach the fade a test built, even one whose
// own assertion threw before it called destroy() itself -- a leaked fade
// keeps its document listeners live and has broken a LATER test's own
// assertions this way once already.
let current: ChromeFade | null = null;

function rig(focus: "paragraph" | "off" = "paragraph", wake = true) {
  const root = document.documentElement;
  if (focus === "off") root.removeAttribute("data-focus");
  else root.setAttribute("data-focus", focus);
  const pane = document.createElement("main");
  pane.id = "editor";
  const inside = document.createElement("div");
  inside.tabIndex = 0;
  pane.appendChild(inside);
  const outside = document.createElement("button");
  document.body.append(pane, outside);
  // Typing means the pane has focus (item 2 below): the rig starts there by
  // default so every existing "typing" test still describes typing, and a
  // test that means to check the focus guard itself moves focus explicitly.
  inside.focus();
  const timers: { fn: () => void; ms: number }[] = [];
  const fade = createChromeFade({
    root,
    body: document.body,
    pane,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: (h) => {
      // Splice, not neuter: the module never holds more than one pending
      // timer (onType's own guard), so a cancelled handle is always the
      // array's sole entry and armed() -- timers.length -- is a true count
      // of what is still pending only if a clear actually removes it.
      const idx = (h as number) - 1;
      if (timers[idx]) timers.splice(idx, 1);
    },
  });
  current = fade;
  // The existing timer tests cover typing after the writer reveals the chrome.
  if (wake) fade.wake();
  return {
    fade,
    inside,
    outside,
    hidden: () => document.body.classList.contains(HIDDEN_CLASS),
    fire: () => {
      const t = timers.shift();
      if (!t) throw new Error("no timer armed");
      t.fn();
    },
    armed: () => timers.length,
    move: (x: number, y: number) =>
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true })),
    key: (key: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  };
}

afterEach(() => {
  current?.destroy();
  current = null;
  document.body.replaceChildren();
  document.body.classList.remove(HIDDEN_CLASS);
  document.documentElement.removeAttribute("data-focus");
});

describe("hiding", () => {
  test("mounting with focus mode on hides without typing or a timer", () => {
    const r = rig("paragraph", false);
    expect(r.hidden()).toBe(true);
    expect(r.armed()).toBe(0);
  });

  test("turning focus mode on starts hiding without typing", async () => {
    const r = rig("off", false);
    document.documentElement.setAttribute("data-focus", "paragraph");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.hidden()).toBe(true);
    expect(r.armed()).toBe(0);
  });

  test("rewriting an enabled mode does not hide controls the writer revealed", async () => {
    const r = rig("paragraph", false);
    r.fade.wake();
    document.documentElement.setAttribute("data-focus", "paragraph");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.hidden()).toBe(false);
  });

  test("the first keystroke arms 1.5 s, the timer hides, later keystrokes arm nothing", () => {
    const r = rig();
    r.fade.onType();
    expect(r.armed()).toBe(1);
    r.fade.onType();
    expect(r.armed()).toBe(1);
    r.fire();
    expect(r.hidden()).toBe(true);
    r.fade.onType();
    expect(r.armed()).toBe(0);
  });

  test("HIDE_AFTER_MS is 1500 and is what gets armed", () => {
    const timers: number[] = [];
    const fade = createChromeFade({
      root: document.documentElement,
      body: document.body,
      pane: document.body,
      setTimer: (_fn, ms) => {
        timers.push(ms);
        return 1;
      },
      clearTimer: () => undefined,
    });
    current = fade;
    document.documentElement.setAttribute("data-focus", "paragraph");
    fade.onType();
    expect(timers).toEqual([HIDE_AFTER_MS]);
    expect(HIDE_AFTER_MS).toBe(1500);
  });

  test("outside focus mode typing arms nothing", () => {
    const r = rig("off");
    r.fade.onType();
    expect(r.armed()).toBe(0);
  });

  test("a timer that fires after focus mode ended hides nothing", () => {
    const r = rig();
    r.fade.onType();
    document.documentElement.removeAttribute("data-focus");
    r.fire();
    expect(r.hidden()).toBe(false);
  });

  test("a document change while focus is outside the pane arms nothing", () => {
    // Replace / Replace all runs from #find-panel, inside #project-bar, and
    // that is a document change and not typing -- onType must tell the two
    // apart or a replace hides the very panel it ran from.
    const r = rig();
    r.outside.focus();
    r.fade.onType();
    expect(r.armed()).toBe(0);
    r.inside.focus();
    r.fade.onType();
    expect(r.armed()).toBe(1);
  });
});

// A timeline has no typing, so its stillness (debounced in
// timeline-view.ts, not here) calls this directly instead of onType.
describe("onPointerStill", () => {
  test("arms the same 1.5s timer onType does", () => {
    const r = rig();
    r.fade.onPointerStill();
    expect(r.armed()).toBe(1);
    r.fire();
    expect(r.hidden()).toBe(true);
  });

  test("arms with focus OUTSIDE the pane, unlike onType -- a pointer pan focuses nothing", () => {
    const r = rig();
    r.outside.focus();
    r.fade.onPointerStill();
    expect(r.armed()).toBe(1);
  });

  test("outside focus mode it arms nothing", () => {
    const r = rig("off");
    r.fade.onPointerStill();
    expect(r.armed()).toBe(0);
  });

  test("a second call while one is already armed arms nothing more", () => {
    const r = rig();
    r.fade.onPointerStill();
    r.fade.onPointerStill();
    expect(r.armed()).toBe(1);
  });

  test("a real pointer move (chrome-fade's own wake) cancels the arm", () => {
    const r = rig();
    r.fade.onPointerStill();
    expect(r.armed()).toBe(1);
    r.move(50, 50);
    expect(r.armed()).toBe(0);
    expect(r.hidden()).toBe(false);
  });
});

describe("waking", () => {
  test("a pointer displacement wakes and disarms; the same coordinates do not", () => {
    const r = rig();
    r.move(10, 10);
    r.fade.onType();
    r.fire();
    expect(r.hidden()).toBe(true);
    r.move(10, 10);
    expect(r.hidden()).toBe(true);
    r.move(12, 10);
    expect(r.hidden()).toBe(false);
    r.fade.onType();
    r.move(30, 30);
    expect(r.armed()).toBe(0);
  });

  test("the first pointer event after a hide wakes", () => {
    // No seed move: under Xvfb the pointer can genuinely never have moved
    // since load, and a writer whose pointer rested since launch is the same
    // case. The very first mousemove this module sees must still count as
    // movement -- a real capture caught the opposite (--fade woken
    // photographed the chrome still gone).
    const r = rig();
    r.fade.onType();
    r.fire();
    expect(r.hidden()).toBe(true);
    r.move(11, 11);
    expect(r.hidden()).toBe(false);
  });

  test("Escape wakes and is not consumed", () => {
    const r = rig();
    r.fade.onType();
    r.fire();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(r.hidden()).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("focus leaving the pane wakes; focus inside it does not", () => {
    const r = rig();
    r.fade.onType();
    r.fire();
    r.inside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(r.hidden()).toBe(true);
    r.outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(r.hidden()).toBe(false);
  });

  test("leaving focus mode wakes", async () => {
    const r = rig();
    r.fade.onType();
    r.fire();
    document.documentElement.removeAttribute("data-focus");
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.hidden()).toBe(false);
  });

  test("destroy wakes and detaches", () => {
    const r = rig();
    r.fade.onType();
    r.fire();
    r.fade.destroy();
    expect(r.hidden()).toBe(false);
    r.fade.onType();
    expect(r.armed()).toBe(0);
  });
});

describe("a shown format bubble", () => {
  test("blocks the hide; the next keystroke arms again", () => {
    document.documentElement.setAttribute("data-focus", "paragraph");
    const pane = document.createElement("main");
    pane.tabIndex = 0;
    document.body.appendChild(pane);
    pane.focus();
    let blocked = true;
    const timers: { fn: () => void; ms: number }[] = [];
    const fade = createChromeFade({
      root: document.documentElement,
      body: document.body,
      pane,
      blocked: () => blocked,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: (h) => {
        const idx = (h as number) - 1;
        if (timers[idx]) timers.splice(idx, 1);
      },
    });
    current = fade;
    fade.onType();
    const first = timers.shift();
    first?.fn();
    expect(document.body.classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(timers.length).toBe(0);
    blocked = false;
    fade.onType();
    expect(timers.length).toBe(1);
    const second = timers.shift();
    second?.fn();
    expect(document.body.classList.contains(HIDDEN_CLASS)).toBe(true);
  });
});

// THE STYLESHEET'S HALF. block() is tonal-surfaces.test.ts's helper, copied:
// it anchors on the exact blank-line-then-selector text a real stylesheet
// author would write, so a multi-selector list must be spelled one selector
// per line, exactly as below.
const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

describe("the stylesheet's half", () => {
  test("two durations, one declaration per target", () => {
    expect(block("body")).toMatch(/--chrome-ms:\s*120ms/);
    expect(block("body")).toMatch(/--chrome-vis-delay:\s*0s/);
    expect(block("body.chrome-hidden")).toMatch(/--chrome-ms:\s*1000ms/);
    expect(block("body.chrome-hidden")).toMatch(/--chrome-vis-delay:\s*1000ms/);
    const targets = block("#project-bar,\n#nav-column,\n#footer");
    expect(targets).toMatch(/transition:\s*opacity var\(--chrome-ms\) ease-out,\s*visibility 0s linear var\(--chrome-vis-delay\)/);
    const hidden = block("body.chrome-hidden #project-bar,\nbody.chrome-hidden #nav-column,\nbody.chrome-hidden #footer");
    expect(hidden).toMatch(/opacity:\s*0\s*;/);
    expect(hidden).toMatch(/visibility:\s*hidden/);
  });

  test("the pane recentres by transform, only while the navigator occupies a layout column", () => {
    expect(block("#editor")).toMatch(/transition:\s*transform var\(--chrome-ms\) ease-out/);
    const shifted = block('body.chrome-hidden:not(.nav-hidden):not(.nav-narrow):not([data-reference-open="true"]):not([data-continuous-open="true"]):not([data-inspector-open="true"]) #editor');
    expect(shifted).toMatch(/transform:\s*translateX\(calc\(var\(--nav-width\) \/ -2\)\)/);
    expect(stripped).not.toMatch(/body\.chrome-hidden #editor \{/);
  });

  test("reduced motion makes both instant", () => {
    const at = stripped.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    const rest = stripped.slice(at);
    expect(rest).toMatch(/body,\s*body\.chrome-hidden \{[^}]*--chrome-ms:\s*0ms[^}]*--chrome-vis-delay:\s*0s/);
  });

  test("the chrome's reduced-motion rule comes after body.chrome-hidden, so it wins the cascade", () => {
    // Equal specificity, same properties: whichever block is LATER in the
    // sheet wins. A reduced-motion rule placed before body.chrome-hidden's
    // own --chrome-ms: 1000ms would lose to it and hiding would still
    // animate under reduced motion -- the defect a real capture caught.
    const hiddenAt = stripped.indexOf("\n\nbody.chrome-hidden {");
    expect(hiddenAt).toBeGreaterThan(-1);
    const match = /body,\s*body\.chrome-hidden \{[^}]*--chrome-ms:\s*0ms[^}]*--chrome-vis-delay:\s*0s/.exec(stripped);
    expect(match).not.toBeNull();
    expect((match as RegExpExecArray).index).toBeGreaterThan(hiddenAt);
  });
});
