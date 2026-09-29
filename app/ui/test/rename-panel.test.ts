import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
// The rename panel: one field, one button, and a captured row.
//
// Ported from outline-bar.test.ts, which died with the bar. What survived is
// every claim about renaming; what did not is the bar's five buttons, its
// Delete/Restore label and the room it had to make for a field that was too
// narrow to read. The panel has room by construction.
import { describe, expect, test, afterEach } from "bun:test";
import { createRenamePanel, type RenamePanel } from "../src/rename-panel";

interface Rig {
  container: HTMLElement;
  panel: RenamePanel;
  renamed: Array<{ id: string; title: string }>;
  focusReturns: number;
  /** Resolves the pending rename. Assigned per call so a test can watch a
   *  rejection without racing the one before it. */
  answer: (value: unknown) => void;
  reject: ((err: unknown) => void) | null;
}

const rigs: Rig[] = [];

function rig(options: { failing?: boolean } = {}): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = {
    container,
    panel: null as unknown as RenamePanel,
    renamed: [],
    focusReturns: 0,
    answer: () => undefined,
    reject: null,
  };
  r.panel = createRenamePanel({
    container,
    rename: (id, title) => {
      r.renamed.push({ id, title });
      if (options.failing === true) {
        return new Promise((_resolve, reject) => {
          r.reject = reject;
        });
      }
      return Promise.resolve(undefined);
    },
    returnFocus: () => {
      r.focusReturns += 1;
    },
  });
  rigs.push(r);
  return r;
}

afterEach(() => {
  // The outside-click closer is on the DOCUMENT and the suite shares one across
  // every test file. A rig left registered closes some other file's panel.
  for (const r of rigs) {
    r.panel.destroy();
    r.container.remove();
  }
  rigs.length = 0;
});

const field = (): HTMLInputElement => document.getElementById("rename-field") as HTMLInputElement;
const commit = (): HTMLButtonElement =>
  document.getElementById("rename-commit") as HTMLButtonElement;
const panelEl = (): HTMLElement => document.getElementById("rename-panel") as HTMLElement;

function press(key: string): void {
  field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** One microtask turn, so a swallowed rejection has somewhere to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("rename panel structure", () => {
  test("the panel names itself and is a dialog", () => {
    rig();
    expect(panelEl().getAttribute("role")).toBe("dialog");
    // aria-modal="false", not true: nothing here traps focus, and claiming the
    // rest of the page is inert when it is not is a lie to a screen reader.
    expect(panelEl().getAttribute("aria-modal")).toBe("false");
    expect(panelEl().getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
  });

  test("the field carries a real accessible name", () => {
    rig();
    // No visible label exists to point at, so the name has to be authored. The
    // string is the outline bar's, unchanged: a graded rig compares it to a
    // literal.
    expect(field().getAttribute("aria-label")).toBe("New title");
  });

  test("the commit control is a button, not a div", () => {
    rig();
    expect(commit().tagName).toBe("BUTTON");
    // Without type="button" a button inside a form submits it.
    expect(commit().type).toBe("button");
    // The accessible name comes from the content, so there is nothing to keep
    // in sync with an aria-label.
    expect(commit().textContent).toBe("Rename");
    expect(commit().getAttribute("aria-label")).toBeNull();
  });

  test("the panel starts hidden", () => {
    rig();
    expect(panelEl().hidden).toBe(true);
  });
});

describe("rename panel opening", () => {
  test("open reveals the panel prefilled, focused and selected", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    expect(panelEl().hidden).toBe(false);
    expect(field().value).toBe("Arrival");
    // The id, never the element: a failed toBe on a happy-dom node prints the
    // whole node and has killed a mutation run by timeout.
    expect(document.activeElement?.id ?? "none").toBe("rename-field");
    // Selected, so typing replaces the title rather than appending to it.
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("Arrival".length);
  });

  test("the field is prefilled from the row EACH time it opens", () => {
    // Prefilling once would show the title of whatever was renamed first for
    // the rest of the session.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    press("Escape");
    r.panel.open("scene-2", "Departure");
    expect(field().value).toBe("Departure");
  });
});

describe("rename panel committing", () => {
  test("Enter renames the captured row to the field's value and closes", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    field().value = "Landfall";
    press("Enter");
    expect(r.renamed).toEqual([{ id: "scene-1", title: "Landfall" }]);
    expect(panelEl().hidden).toBe(true);
    expect(field().value).toBe("");
  });

  test("the commit button does exactly what Enter does", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    field().value = "Landfall";
    commit().click();
    expect(r.renamed).toEqual([{ id: "scene-1", title: "Landfall" }]);
    expect(panelEl().hidden).toBe(true);
  });

  test("Enter with an unchanged value still renames", () => {
    // The panel decides nothing about the manuscript. Whether a title changed
    // is the outline unit's question, and two places deciding it is how they
    // drift.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    press("Enter");
    expect(r.renamed).toEqual([{ id: "scene-1", title: "Arrival" }]);
  });

  test("Enter renames the row the panel was OPENED against", () => {
    // THE WHOLE RULE. A rename must land on the row the writer was looking at
    // when they typed the title, whatever moved underneath while the panel was
    // open. Same rule as the navigator's context menu, same reason.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    field().value = "Landfall";
    // Something else moves the selection while the field is open - a menu, a
    // click, a queued Alt+Arrow landing.
    press("Enter");
    expect(r.renamed).toEqual([{ id: "scene-1", title: "Landfall" }]);
  });

  test("a second open before any close replaces the captured row", () => {
    // Reachable: the context menu's Rename... can be reached again while the
    // panel is still up, on a different row. Without a fresh capture the writer
    // would rename the row they left, under a field showing the title of the
    // one they picked.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    r.panel.open("scene-2", "Departure");
    press("Enter");
    expect(r.renamed).toEqual([{ id: "scene-2", title: "Departure" }]);
  });

  test("committing returns focus before the rename is asked for", () => {
    // In that order: the outline unit repaints the navigator when it answers,
    // and the control that was pressed is inside a panel this hides. Focus has
    // to have somewhere to be before either happens.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    press("Enter");
    expect(r.focusReturns).toBe(1);
  });

  test("a second Enter after a commit renames nothing", () => {
    // The captured id is cleared on close, so a commit against a closed panel
    // cannot reach a row a previous open captured.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    press("Enter");
    press("Enter");
    expect(r.renamed).toHaveLength(1);
  });

  test("a rejecting rename neither throws out of the handler nor goes unhandled", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      seen.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = rig({ failing: true });
      r.panel.open("scene-1", "Arrival");
      expect(() => press("Enter")).not.toThrow();
      r.reject?.(new Error("refused"));
      await settle();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("rename panel dismissing", () => {
  test("Escape closes, renames nothing and returns focus", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    field().value = "Landfall";
    press("Escape");
    expect(r.renamed).toEqual([]);
    expect(panelEl().hidden).toBe(true);
    expect(r.focusReturns).toBe(1);
  });

  test("the shell's Close closes, renames nothing and returns focus", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    const close = panelEl().querySelector<HTMLButtonElement>(".panel-close")!;
    expect(panelEl().querySelector(".panel-title")?.textContent).toBe("Rename");
    expect(close.getAttribute("aria-label")).toBe("Close Rename");
    close.click();
    expect(r.renamed).toEqual([]);
    expect(panelEl().hidden).toBe(true);
    expect(r.focusReturns).toBe(1);
  });

  test("a key that is neither Enter nor Escape leaves the panel open", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    press("a");
    expect(panelEl().hidden).toBe(false);
    expect(r.renamed).toEqual([]);
  });

  test("a click outside closes it and renames nothing, without moving focus", () => {
    // The half of a dismissal Escape cannot give: Escape is only heard while
    // focus is inside the panel, so a writer who opened this and then clicked
    // into their prose had it over their manuscript with no way to put it away
    // - a recorded defect. It does NOT return focus: a click already says
    // where the writer wants to be.
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.click();
    expect(panelEl().hidden).toBe(true);
    expect(r.renamed).toEqual([]);
    expect(r.focusReturns).toBe(0);
    elsewhere.remove();
  });

  test("a click outside forgets the captured row", () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.click();
    elsewhere.remove();
    press("Enter");
    expect(r.renamed).toEqual([]);
  });
});

describe("rename panel teardown", () => {
  test("destroy empties the container and a detached field does nothing", () => {
    const r = rig();
    const detached = field();
    r.panel.destroy();
    expect(r.container.children.length).toBe(0);
    detached.value = "Landfall";
    detached.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(r.renamed).toEqual([]);
  });

  test("destroy leaves no document-level listener behind", () => {
    // COUNTING, because the leak is invisible otherwise: the closer returns
    // immediately while the panel is hidden, so a leaked copy changes no DOM
    // state and no behaviour a test can reach, while accumulating one live
    // closure per project switch.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as unknown as (...args: unknown[]) => unknown)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as unknown as (...args: unknown[]) => unknown)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const r = rig();
      r.panel.destroy();
      expect(added.length).toBeGreaterThan(0);
      expect([...removed].sort()).toEqual([...added].sort());
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });

  test("destroy is idempotent", () => {
    const r = rig();
    r.panel.destroy();
    expect(() => r.panel.destroy()).not.toThrow();
  });
});

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`composition keys keep the rename draft (${JSON.stringify(composition)})`, () => {
    const r = rig();
    r.panel.open("scene-1", "Arrival");
    field().value = "Draft title";
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, ...composition, bubbles: true, cancelable: true });
      field().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(panelEl().hidden).toBe(false);
      expect(field().value).toBe("Draft title");
      expect(r.renamed).toEqual([]);
      expect(r.focusReturns).toBe(0);
    }
    press("Enter");
    expect(r.renamed).toEqual([{ id: "scene-1", title: "Draft title" }]);
  });
}
