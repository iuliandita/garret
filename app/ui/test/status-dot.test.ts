import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createStatusDot, dotState, type DotState } from "../src/status-dot";

const quiet = { recovery: "protected", archive: "taken", mirror: "current" } as const;

describe("dotState", () => {
  test("quiet only when all three are content", () => {
    expect(dotState(quiet)).toBe("quiet");
  });
  const cases: Array<[string, Parameters<typeof dotState>[0], DotState]> = [
    // Not set up is not a failure (236, amending 067).
    ["no recovery point", { ...quiet, recovery: "none" }, "neutral"],
    ["no archive", { ...quiet, archive: "none" }, "neutral"],
    ["no folder", { ...quiet, mirror: "off" }, "neutral"],
    ["nothing set up at all", { recovery: "none", archive: "none", mirror: "off" }, "neutral"],
    ["nothing reported yet", { recovery: null, archive: null, mirror: null }, "neutral"],
    ["one reported, two pending", { recovery: "protected", archive: null, mirror: null }, "neutral"],
    ["a failed attempt", { ...quiet, recovery: "attempt-failed" }, "amber"],
    ["stale recovery", { ...quiet, recovery: "stale" }, "amber"],
    // A failure outranks "not set up" elsewhere: the one real problem is what
    // the dot must say.
    ["failed backup, nothing else set up", { recovery: "attempt-failed", archive: "none", mirror: "off" }, "amber"],
    ["identity check unavailable", { ...quiet, mirror: "unavailable" }, "amber"],
    ["paused folder", { ...quiet, mirror: "paused" }, "amber"],
    ["failing folder", { ...quiet, mirror: "failing" }, "amber"],
    ["stale folder", { ...quiet, mirror: "stale" }, "amber"],
    ["updating folder", { ...quiet, mirror: "updating" }, "quiet"],
    ["one to check", { ...quiet, mirror: "finding" }, "quiet"],
  ];
  for (const [name, states, expected] of cases) {
    test(name, () => expect(dotState(states)).toBe(expected));
  }
});

type Extra = Omit<Parameters<typeof createStatusDot>[0], "container" | "popover" | "openChanges">;
function rig(openChanges?: () => void, extra: Extra = {}, anchors = false) {
  const container = document.createElement("span");
  const popover = document.createElement("div");
  popover.id = "status-popover";
  popover.hidden = true;
  if (anchors) {
    for (const id of ["recovery-controls", "archive-controls", "mirror-controls"]) {
      const span = document.createElement("span");
      span.id = id;
      popover.append(span);
    }
  }
  container.append(popover);
  document.body.append(container);
  const dot = createStatusDot({ container, popover, openChanges, ...extra });
  return { container, popover, dot };
}

describe("one action per sentence that needs one", () => {
  const shown = (container: HTMLElement): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>(".status-action")].filter((b) => !b.hidden).map((b) => b.id);

  test("each action sits right after the sentence it answers", () => {
    const { container, popover, dot } = rig(() => {}, { backupNow: () => {}, makeArchive: () => {}, openMirrorSetup: () => {} }, true);
    const ids = [...popover.children].map((el) => el.id);
    expect(ids.indexOf("status-backup-now")).toBe(ids.indexOf("recovery-controls") + 1);
    expect(ids.indexOf("status-make-archive")).toBe(ids.indexOf("archive-controls") + 1);
    expect(ids.indexOf("status-mirror-setup")).toBeGreaterThan(ids.indexOf("mirror-controls"));
    dot.destroy();
    container.remove();
  });

  test("a content copy offers nothing; a missing or failed one offers its command", () => {
    const { container, dot } = rig(() => {}, { backupNow: () => {}, makeArchive: () => {}, openMirrorSetup: () => {} });
    dot.report("recovery", "protected");
    dot.report("archive", "taken");
    dot.report("mirror", "current");
    expect(shown(container)).toEqual(["status-open-changes"]);
    dot.report("recovery", "attempt-failed");
    dot.report("archive", "none");
    dot.report("mirror", "off");
    expect(shown(container).sort()).toEqual(["status-backup-now", "status-make-archive", "status-mirror-setup"]);
    dot.destroy();
    container.remove();
  });

  test("an action closes the popover, then runs the command it reuses", () => {
    let ran = 0;
    const { container, popover, dot } = rig(undefined, {
      backupNow: () => {
        ran += 1;
        expect(popover.hidden).toBe(true);
      },
    });
    dot.report("recovery", "none");
    (container.querySelector("#status-dot") as HTMLButtonElement).click();
    (container.querySelector("#status-backup-now") as HTMLButtonElement).click();
    expect(ran).toBe(1);
    dot.destroy();
    expect(container.querySelector("#status-backup-now")).toBeNull();
    container.remove();
  });
});

describe("the dot", () => {
  test("the Changes action dismisses the popover before opening the panel", () => {
    let calls = 0;
    const { container, popover, dot } = rig(() => {
      calls += 1;
      expect(popover.hidden).toBe(true);
      expect(container.querySelector("#status-dot")?.getAttribute("aria-expanded")).toBe("false");
    });
    (container.querySelector("#status-dot") as HTMLButtonElement).click();
    const action = container.querySelector("#status-open-changes") as HTMLButtonElement;
    expect(action.type).toBe("button");
    action.click();
    expect(calls).toBe(1);
    dot.destroy();
    container.remove();
  });

  test("opens neutral with all three unknown, with no warning words", () => {
    // An unanswered status read is not a failure; a dot that flashed amber
    // at every mount would teach the writer to ignore it.
    const { container, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    expect(button.dataset.state).toBe("neutral");
    expect(button.getAttribute("aria-label")).toBe("Copies: not all of them are set up");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect((button.querySelector(".status-dot-label") as HTMLElement).hidden).toBe(true);
    dot.destroy();
    container.remove();
  });

  test("amber shows visible words beside the dot, and only amber", () => {
    const { container, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    const label = button.querySelector(".status-dot-label") as HTMLElement;
    dot.report("recovery", "attempt-failed");
    expect(button.dataset.state).toBe("amber");
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe("Copies need attention");
    // The words are for the eye; the name is still the sentence.
    expect(button.getAttribute("aria-label")).toBe("Copies: something needs attention");
    dot.report("recovery", "protected");
    expect(label.hidden).toBe(true);
    dot.destroy();
    container.remove();
  });

  test("goes quiet only once all three have reported content", () => {
    const { container, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    dot.report("recovery", "protected");
    dot.report("archive", "taken");
    expect(button.dataset.state).toBe("neutral");
    dot.report("mirror", "current");
    expect(button.dataset.state).toBe("quiet");
    expect(button.getAttribute("aria-label")).toBe("Copies: all three are current");
    dot.destroy();
    container.remove();
  });

  test("the button is mounted before the popover, not inside it", () => {
    // The popover is static markup; the dot goes in front of it so the DOM
    // order is control, then what it controls. A button appended AFTER would
    // still pass every other test here.
    const { container, popover, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    expect(popover.contains(button)).toBe(false);
    expect(button.compareDocumentPosition(popover) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(button.getAttribute("aria-controls")).toBe("status-popover");
    dot.destroy();
    container.remove();
  });

  test("click opens the popover and focuses it; Escape closes and returns focus", () => {
    const { container, popover, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    button.click();
    expect(popover.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Asserted on the id, never on the element: a happy-dom node printed by a
    // failing matcher is megabytes and takes the runner out by timeout.
    expect(document.activeElement?.id).toBe("status-popover");
    popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.id).toBe("status-dot");
    dot.destroy();
    container.remove();
  });

  test("it is a push button to ATK: no aria-haspopup, no aria-pressed", () => {
    // aria-haspopup on its own makes the role `combo box`, which is outside
    // the WANTED set in nodes.ts, so no rig would find the dot; aria-pressed
    // makes it `toggle button`. aria-expanded on a plain button leaves it a
    // push button, which is what it is.
    const { container, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    expect(button.hasAttribute("aria-haspopup")).toBe(false);
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    dot.destroy();
    container.remove();
  });

  test("Escape on the dot itself closes the popover and leaves focus there", () => {
    // Shift+Tab out of the open popover lands on the dot. Escape there is
    // also the tooltip's keydown, which hides the tip and nothing else.
    const { container, popover, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    button.click();
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.id).toBe("status-dot");
    dot.destroy();
    container.remove();
  });

  test("a second click closes it", () => {
    const { container, popover, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    button.click();
    button.click();
    expect(popover.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    dot.destroy();
    container.remove();
  });

  test("a click outside closes it", () => {
    // closeOnOutsideClick listens for `click` in the capture phase, so that is
    // the event dispatched here; a mousedown would prove nothing about it.
    const { container, popover, dot } = rig();
    (container.querySelector("#status-dot") as HTMLButtonElement).click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover.hidden).toBe(true);
    dot.destroy();
    container.remove();
  });

  test("a click outside does not move focus", () => {
    // A click already says where the writer wants to be; the closer must not
    // argue on the way out (dismiss-outside.ts). Open leaves focus on the
    // popover; the outside click closes it and touches focus not at all.
    const { container, popover, dot } = rig();
    (container.querySelector("#status-dot") as HTMLButtonElement).click();
    expect(document.activeElement?.id).toBe("status-popover");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("status-popover");
    dot.destroy();
    container.remove();
  });

  test("the tooltip is a sibling of the button, never a child", () => {
    const { container, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    const tip = container.querySelector(".tip");
    expect(tip).not.toBeNull();
    expect(button.contains(tip)).toBe(false);
    expect(tip?.textContent).toBe("Copies: not all of them are set up");
    dot.destroy();
    container.remove();
  });

  test("a dot that went quiet under the pointer stops saying attention", () => {
    const { container, dot } = rig();
    const button = container.querySelector("#status-dot") as HTMLButtonElement;
    dot.report("recovery", "stale");
    button.dispatchEvent(new Event("mouseenter"));
    expect(container.querySelector(".tip")?.textContent).toBe("Copies: something needs attention");
    dot.report("recovery", "protected");
    dot.report("archive", "taken");
    dot.report("mirror", "current");
    expect(container.querySelector(".tip")?.textContent).toBe(
      "Copies: all three are current",
    );
    dot.destroy();
    container.remove();
  });

  test("destroy removes the button and the document listener", () => {
    const { container, popover, dot } = rig();
    (container.querySelector("#status-dot") as HTMLButtonElement).click();
    dot.destroy();
    expect(container.querySelector("#status-dot")).toBeNull();
    expect(popover.hidden).toBe(true);
    // The document listener is gone: reopening by hand and clicking outside
    // leaves the popover as it was.
    popover.hidden = false;
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover.hidden).toBe(false);
    container.remove();
  });
});
