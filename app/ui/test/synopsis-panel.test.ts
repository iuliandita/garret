// The synopsis panel: what a part, a chapter or a scene is about.
//
// TWO MODES: Read shows what the store holds as a paragraph, Edit
// is the textarea this panel has always had. An EMPTY synopsis has no Read
// state -- opening on one, or saving one down to nothing, goes straight to
// Edit -- and most of this file is about that boundary plus the ROW-CAPTURE
// rule this panel has kept: a writer types paragraphs into a
// textarea and the selection is still live behind the panel - an arrow key
// reaches the navigator while it is open - so a save that read the selection
// at press time would put this chapter's summary on whatever row the writer
// had wandered to.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test, afterEach } from "bun:test";

// The suite's preload registers happy-dom for files under app/ui, but a file
// run on its own has no document yet.
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createSynopsisPanel, type SynopsisPanel } from "../src/synopsis-panel";

interface Rig {
  panel: SynopsisPanel;
  container: HTMLElement;
  reads: string[];
  writes: Array<{ itemId: string; body: string }>;
  stored: Map<string, string>;
  notices: string[];
  dones: string[];
  dismissals: number;
  fail: { read: boolean; write: boolean };
  /** Set by `holdWrite` to make a write wait for `releaseWrite`, so a test can
   *  put an answer in flight and act on the panel BEFORE it resolves. */
  writeGate: Promise<void> | null;
  releaseWrite: (() => void) | null;
}

/** A write started after this call does not resolve until `r.releaseWrite()`
 *  is called. Exists for the generation-guard tests, which need to act on the
 *  panel (Escape, a second open) while a `commit` is still in flight. */
function holdWrite(r: Rig): void {
  r.writeGate = new Promise((resolve) => {
    r.releaseWrite = resolve;
  });
}

const rigs: Rig[] = [];

function rig(): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = {
    panel: undefined as unknown as SynopsisPanel,
    container,
    reads: [],
    writes: [],
    stored: new Map(),
    notices: [],
    dones: [],
    dismissals: 0,
    fail: { read: false, write: false },
    writeGate: null,
    releaseWrite: null,
  };
  r.panel = createSynopsisPanel({
    container,
    read: async (itemId) => {
      r.reads.push(itemId);
      if (r.fail.read) throw new Error("could not read");
      return r.stored.get(itemId) ?? null;
    },
    write: async (itemId, body) => {
      r.writes.push({ itemId, body });
      if (r.writeGate !== null) await r.writeGate;
      if (r.fail.write) throw new Error("could not write");
      const trimmed = body.trim();
      if (trimmed === "") r.stored.delete(itemId);
      else r.stored.set(itemId, trimmed);
    },
    onDone: (message) => r.dones.push(message),
    onNotice: (message) => r.notices.push(message),
    onDismiss: () => {
      r.dismissals += 1;
    },
  });
  rigs.push(r);
  return r;
}

afterEach(() => {
  // The closer is on the DOCUMENT and the suite shares one across every test
  // file. A rig left registered closes some other file's panel.
  for (const r of rigs) {
    r.panel.destroy();
    r.container.remove();
  }
  rigs.length = 0;
});

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no #${id}`);
  return found as T;
}

const field = (): HTMLTextAreaElement => el<HTMLTextAreaElement>("synopsis-field");
const save = (): HTMLButtonElement => el<HTMLButtonElement>("synopsis-save");
const cancel = (): HTMLButtonElement => el<HTMLButtonElement>("synopsis-cancel");
const edit = (): HTMLButtonElement => el<HTMLButtonElement>("synopsis-edit");
const text = (): HTMLElement => el("synopsis-text");
const status = (): HTMLElement => el("synopsis-status");
const panelEl = (): HTMLElement => el("synopsis-panel");
const mode = (): string | undefined => panelEl().dataset.mode;

describe("opening", () => {
  test("a row with a synopsis opens in READ, painted as a paragraph", async () => {
    const r = rig();
    r.stored.set("i1", "She finds the letter and burns it.");

    await r.panel.open("i1", "Chapter One");

    expect(panelEl().hidden).toBe(false);
    expect(mode()).toBe("read");
    expect(text().textContent).toBe("She finds the letter and burns it.");
    // WHICH ROW THIS IS ABOUT, said in the panel regardless of mode.
    expect(status().textContent).toContain("Chapter One");
  });

  test("an EMPTY synopsis opens in EDIT directly -- there is nothing to read", async () => {
    const r = rig();

    await r.panel.open("i1", "Chapter One");

    expect(panelEl().hidden).toBe(false);
    expect(mode()).toBe("edit");
    expect(field().value).toBe("");
    expect(r.reads).toEqual(["i1"]);
  });

  test("reopening on a second row does not show the first row's text", async () => {
    // The panel is built once and outlives any number of opens. Prefilling from
    // a held value rather than a fresh read would show whatever was edited first
    // for the rest of the session.
    const r = rig();
    r.stored.set("i1", "about the first");
    await r.panel.open("i1", "Chapter One");
    r.panel.close();

    await r.panel.open("i2", "Chapter Two");

    expect(mode()).toBe("edit");
    expect(field().value).toBe("");
    expect(status().textContent).toContain("Chapter Two");
  });

  test("the field is cleared and the mode is EDIT before the read resolves, not after", async () => {
    // Otherwise the previous row's summary sits painted under a heading naming
    // a different row for the length of a round trip.
    //
    // THE FIRST OPEN IS AWAITED and the second is NOT, which is the whole
    // shape: the panel has to be showing chapter one's real Read state before
    // the claim means anything, and the claim is about the instant after the
    // second call and before its answer.
    const r = rig();
    r.stored.set("i1", "about the first");
    await r.panel.open("i1", "Chapter One");
    expect(mode()).toBe("read");

    void r.panel.open("i2", "Chapter Two");

    expect(mode()).toBe("edit");
    expect(field().value).toBe("");
  });

  test("a read that fails says so and does not paint an empty field as an answer", async () => {
    // THE RECORDED `catch` DEFECT: a failure path that renders the designed
    // empty state reports a store it could not read as a row nobody has written
    // about - and the writer then types over prose they still have.
    const r = rig();
    r.fail.read = true;

    await r.panel.open("i1", "Chapter One");

    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toContain("could not read");
    // Disabled, so the writer cannot save an empty body over a synopsis this
    // panel failed to load.
    expect(field().disabled).toBe(true);
    expect(save().disabled).toBe(true);
    expect(cancel().disabled).toBe(true);
    expect(mode()).toBe("edit");
  });
});

describe("entering and leaving Edit", () => {
  test("Edit shows the field prefilled with the stored text, autosized", async () => {
    const r = rig();
    r.stored.set("i1", "one\ntwo\nthree");
    await r.panel.open("i1", "Chapter One");

    edit().click();

    expect(mode()).toBe("edit");
    expect(field().value).toBe("one\ntwo\nthree");
    expect(document.activeElement).toBe(field());
  });

  test("Cancel with stored text reverts the field and returns to Read", async () => {
    const r = rig();
    r.stored.set("i1", "the original text");
    await r.panel.open("i1", "Chapter One");
    edit().click();
    field().value = "a change nobody asked to keep";

    cancel().click();

    expect(mode()).toBe("read");
    expect(text().textContent).toBe("the original text");
    expect(r.writes.length).toBe(0);
    expect(document.activeElement).toBe(edit());
    // AND THE FIELD ITSELF WAS REVERTED, not only the paragraph over it: the
    // paragraph is painted from the store either way, so a Cancel that left
    // the abandoned typing in the hidden textarea would pass every line above
    // and hand it back on the next Edit. The mutation pass found that one.
    edit().click();
    expect(field().value).toBe("the original text");
  });

  test("Cancel on an EMPTY synopsis dismisses the whole panel", async () => {
    // Nothing to revert to and no Read state to return to, so Cancel behaves
    // exactly as Escape does here.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "typed, then abandoned";

    cancel().click();

    expect(panelEl().hidden).toBe(true);
    expect(r.dismissals).toBe(1);
    expect(r.writes.length).toBe(0);
  });
});

describe("autosize", () => {
  test("the field grows with typed lines, bounded at 4 and 16", async () => {
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    expect(Number(field().rows)).toBe(4);

    field().value = "one\ntwo\nthree\nfour\nfive\nsix";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    expect(Number(field().rows)).toBe(6);

    field().value = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    field().dispatchEvent(new Event("input", { bubbles: true }));
    expect(Number(field().rows)).toBe(16);

    field().value = "one line";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    expect(Number(field().rows)).toBe(4);
  });

  test("pressing Edit on a long-existing synopsis autosizes without typing", async () => {
    // NAMED FOR ITS OWN CLAIM: the panel's `open`
    // already autosizes the field once, before Read is even painted, so a
    // test that never pressed Edit was passing for a route it never ran --
    // `onEditClick`'s own call to `autosize` was unverified by anything.
    const r = rig();
    r.stored.set("i1", Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    await r.panel.open("i1", "Chapter One");
    field().rows = 4; // undone deliberately, so the assertion below is Edit's own doing.

    edit().click();

    expect(Number(field().rows)).toBe(10);
  });

  test("a real scrollHeight sizes the field directly, clamped to the bound", async () => {
    // a paragraph with no literal newline used to open
    // at the 4-row minimum no matter how long it read once wrapped. happy-dom
    // never lays text out -- `scrollHeight` is always 0 here, which is what
    // the fallback test above exercises -- so this fakes a real engine's
    // answer to prove the OTHER branch: the one dividing by the field's own
    // line height rather than counting newlines.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    const el = field();

    Object.defineProperty(el, "scrollHeight", { value: 100, configurable: true });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    // happy-dom's `line-height` is the keyword `normal`, which the module
    // falls back to a fixed 20px for -- ceil(100 / 20) = 5.
    expect(Number(el.rows)).toBe(5);

    Object.defineProperty(el, "scrollHeight", { value: 400, configurable: true });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(Number(el.rows)).toBe(16); // clamped at the max, not ceil(400 / 20) = 20.

    Object.defineProperty(el, "scrollHeight", { value: 10, configurable: true });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(Number(el.rows)).toBe(4); // clamped at the min, not ceil(10 / 20) = 1.
  });
});

describe("saving", () => {
  test("Save writes the field to the captured row and returns to Read", async () => {
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "She burns the letter.";

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "i1", body: "She burns the letter." }]);
    // THE WHOLE SENTENCE, not merely that one was said. Writing and clearing
    // are different acts and the two messages must not be swappable without a
    // test noticing - the recorded weak-status-line shape.
    expect(r.dones).toEqual(["Synopsis saved."]);
    // SAVE RETURNS TO READ (decision 1), not closes -- unlike this panel's
    // predecessor.
    expect(panelEl().hidden).toBe(false);
    expect(mode()).toBe("read");
    expect(text().textContent).toBe("She burns the letter.");
    expect(document.activeElement).toBe(edit());
  });

  test("the row it saves to is the one it was OPENED on, not the current one", async () => {
    // THE WHOLE REASON THIS PANEL CAPTURES. A rename panel does the same and
    // records the same argument. Driven here by opening on one row and then
    // asking the panel to open on another WITHOUT closing - which is what a
    // second menu press does - and checking the first body did not follow.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "belongs to chapter one";
    await r.panel.open("i2", "Chapter Two");
    field().value = "belongs to chapter two";

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "i2", body: "belongs to chapter two" }]);
  });

  test("an emptied field is a real save, not a silent nothing, and stays in Edit", async () => {
    // Clearing a synopsis is the only way back from having written one, and the
    // store's answer to an empty body is to delete the row. A panel that
    // refused an empty field would make that unreachable. AN EMPTY SYNOPSIS HAS
    // NO READ STATE, so this does not switch to Read with nothing in it.
    const r = rig();
    r.stored.set("i1", "written earlier");
    await r.panel.open("i1", "Chapter One");
    edit().click();
    field().value = "";

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "i1", body: "" }]);
    expect(r.stored.has("i1")).toBe(false);
    // A DIFFERENT SENTENCE from the one a save gets. "Synopsis saved." after
    // emptying the field would tell a writer they had stored a blank summary.
    expect(r.dones).toEqual(["Synopsis cleared."]);
    expect(mode()).toBe("edit");
    expect(panelEl().hidden).toBe(false);
  });

  test("a field holding only spaces is CLEARED, not saved", async () => {
    // The store trims, so this is the same act as an empty field - and the
    // message has to agree with what the file did.
    const r = rig();
    r.stored.set("i1", "written earlier");
    await r.panel.open("i1", "Chapter One");
    edit().click();
    field().value = "   \n  ";

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.dones).toEqual(["Synopsis cleared."]);
    expect(mode()).toBe("edit");
  });

  test("what the writer typed while the read was in flight is not wiped", async () => {
    // The window is short and it is real: the panel opens on the field, so the
    // very next keystroke can land before the store has answered. A prefill
    // that wrote the empty string for a row with no synopsis would silently
    // discard it. Found by mutation.
    const r = rig();
    const open = r.panel.open("i1", "Chapter One");
    field().value = "typed straight away";
    await open;

    expect(field().value).toBe("typed straight away");
    expect(mode()).toBe("edit");
  });

  test("Save on a CLOSED panel writes nothing", async () => {
    // The panel releases the row it captured when it closes, so a press that
    // arrives afterwards has nothing to write to. Not reachable by a writer -
    // the button is inside a hidden panel - and reachable here, which is what
    // makes the release a property rather than a claim in a comment.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "never asked for";
    r.panel.close();

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([]);
  });

  test("the row is captured SYNCHRONOUSLY, before the read answers", async () => {
    // A capture taken after the await is a capture the writer can outrun: the
    // menu press opens the panel and the field takes focus immediately, so a
    // Save landing before the store answers would go to whichever row the
    // PREVIOUS open captured.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    void r.panel.open("i2", "Chapter Two");
    field().value = "belongs to chapter two";

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "i2", body: "belongs to chapter two" }]);
  });

  test("a write that fails says so and leaves the panel open on the row", async () => {
    // OPEN, deliberately: closing would take the writer's unsaved paragraphs
    // off the screen at the moment they are told the save did not land.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "worth keeping";
    r.fail.write = true;

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toContain("could not write");
    expect(panelEl().hidden).toBe(false);
    expect(mode()).toBe("edit");
    expect(field().value).toBe("worth keeping");
    expect(r.dones.length).toBe(0);
  });

  test("a save that resolves after Escape does not repaint the dismissed panel", async () => {
    // `close` (Escape, Cancel on an empty synopsis, an
    // outside click) used to leave `generation` untouched, so a `commit`
    // still in flight when it fires held the SAME generation the write
    // started with -- its own guard never tripped, and the answer repainted a
    // panel the writer had already put away.
    const r = rig();
    r.stored.set("i1", "already written");
    await r.panel.open("i1", "Chapter One");
    edit().click();
    field().value = "typed, then the writer hit Escape before it landed";
    holdWrite(r);
    save().click();

    panelEl().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(panelEl().hidden).toBe(true);

    r.releaseWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panelEl().hidden).toBe(true);
    expect(r.dones.length).toBe(0);
    expect(text().textContent).toBe("");
    expect(mode()).toBe("edit");
  });

  test("a save that resolves after the panel moved to another row does not report", async () => {
    // The generation guard every panel in this codebase carries. Without it a
    // slow answer repaints a surface that is now about a different row.
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "first";
    save().click();
    await r.panel.open("i2", "Chapter Two");
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "i1", body: "first" }]);
    expect(r.dones.length).toBe(0);
  });
});

describe("dismissal", () => {
  test("Escape closes and hands the keyboard back", async () => {
    const r = rig();
    await r.panel.open("i1", "Chapter One");

    panelEl().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(panelEl().hidden).toBe(true);
    expect(r.dismissals).toBe(1);
    expect(r.writes.length).toBe(0);
  });

  test("Escape inside the field closes too, and does not save", async () => {
    // The field is where focus lands on open, so this is the ordinary path and
    // not an edge case. It must not commit: Escape means "never mind".
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "half a thought";

    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(panelEl().hidden).toBe(true);
    expect(r.writes.length).toBe(0);
  });

  test("Escape from Read closes too", async () => {
    const r = rig();
    r.stored.set("i1", "already written");
    await r.panel.open("i1", "Chapter One");
    expect(mode()).toBe("read");

    panelEl().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(panelEl().hidden).toBe(true);
    expect(r.dismissals).toBe(1);
  });

  test("Enter in the field is a newline, not a commit", async () => {
    // A synopsis is paragraphs. The rename field commits on Enter because a
    // title is one line; here the same binding would make the second paragraph
    // impossible to type.
    const r = rig();
    await r.panel.open("i1", "Chapter One");

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    field().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(r.writes.length).toBe(0);
    expect(panelEl().hidden).toBe(false);
  });

  test("a click outside leaves it open, saves nothing and moves no focus", async () => {
    // the inspector. Clicking the prose beside it is the point, so an
    // outside click leaves it open, exactly as it leaves the preview rail.
    const r = rig();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await r.panel.open("i1", "Chapter One");

    elsewhere.click();

    expect(panelEl().hidden).toBe(false);
    expect(r.writes.length).toBe(0);
    expect(r.dismissals).toBe(0);
    elsewhere.remove();
  });
});

describe("teardown", () => {
  test("destroy removes the panel and a later outside click does nothing", async () => {
    const r = rig();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await r.panel.open("i1", "Chapter One");

    r.panel.destroy();

    expect(document.getElementById("synopsis-panel")).toBeNull();
    elsewhere.click();
    expect(r.dismissals).toBe(0);
    elsewhere.remove();
  });

  test("destroy unregisters exactly what it registered on the document", () => {
    // COUNTING, because the leak is unobservable any other way: the outside
    // closer returns immediately when the panel is hidden, so a leaked copy
    // changes no DOM state and no behaviour a test can reach while
    // accumulating one live closure per project switch. The recorded shape,
    // and the recorded way to catch it.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const r = rig();
      // no outside-click closer on the inspector.
      expect(added).not.toContain("click");
      r.panel.destroy();
      expect([...removed].sort()).toEqual([...added].sort());
    } finally {
      document.addEventListener = realAdd as typeof document.addEventListener;
      document.removeEventListener = realRemove as typeof document.removeEventListener;
    }
  });

  test("an answer arriving after destroy paints nothing", async () => {
    const r = rig();
    await r.panel.open("i1", "Chapter One");
    field().value = "in flight";
    save().click();
    r.panel.destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.dones.length).toBe(0);
    expect(r.notices.length).toBe(0);
  });
});
