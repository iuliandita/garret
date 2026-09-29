// The tagging panel: who appears in ONE part, chapter or scene.
//
// THE ROW IS CAPTURED AT OPEN, which is the SYNOPSIS panel's rule and not the
// cast panel's, and a good part of this file is about that difference: the
// selection is still live behind this panel (an arrow key reaches the navigator
// while it is open), so a save that read the selection at press time would put
// this chapter's cast onto whatever row the writer had wandered to.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test, afterEach } from "bun:test";

// The suite's preload registers happy-dom for files under app/ui, but a file
// run on its own has no document yet.
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createAppearancesPanel, type AppearancesPanel } from "../src/appearances-panel";
import type { CastMemberRow } from "../src/cast-panel";

const CAST: CastMemberRow[] = [
  { id: "m-ada", kind: "character", name: "Ada", summary: "", fields: [], aliases: [] },
  { id: "m-bo", kind: "character", name: "Bo", summary: "", fields: [], aliases: [] },
  { id: "m-harbour", kind: "place", name: "The harbour", summary: "", fields: [], aliases: [] },
];

interface Rig {
  panel: AppearancesPanel;
  container: HTMLElement;
  cast: CastMemberRow[];
  reads: string[];
  writes: Array<{ itemId: string; memberIds: string[] }>;
  stored: Map<string, string[]>;
  notices: string[];
  dones: string[];
  dismissals: number;
  fail: { read: boolean; write: boolean };
  /** Held open so a test can drive what happens WHILE a write is in flight. */
  holdWrite: { release: () => void } | null;
}

const rigs: Rig[] = [];

function rig(): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = {
    panel: undefined as unknown as AppearancesPanel,
    container,
    cast: [...CAST],
    reads: [],
    writes: [],
    stored: new Map(),
    notices: [],
    dones: [],
    dismissals: 0,
    fail: { read: false, write: false },
    holdWrite: null,
  };
  r.panel = createAppearancesPanel({
    container,
    cast: async () => {
      if (r.fail.read) throw new Error("could not read");
      return r.cast;
    },
    read: async (itemId) => {
      r.reads.push(itemId);
      if (r.fail.read) throw new Error("could not read");
      return r.stored.get(itemId) ?? [];
    },
    write: async (itemId, memberIds) => {
      r.writes.push({ itemId, memberIds });
      if (r.holdWrite !== null) {
        await new Promise<void>((resolve) => {
          r.holdWrite = { release: resolve };
        });
      }
      if (r.fail.write) throw new Error("could not write");
      if (memberIds.length === 0) r.stored.delete(itemId);
      else r.stored.set(itemId, memberIds);
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

const panelEl = (): HTMLElement => el("appears-panel");
const list = (): HTMLElement => el("appears-list");
const save = (): HTMLButtonElement => el<HTMLButtonElement>("appears-save");
const status = (): HTMLElement => el("appears-status");
const boxes = (): HTMLInputElement[] => [
  ...list().querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
];
const boxFor = (id: string): HTMLInputElement => {
  const found = boxes().find((b) => b.value === id);
  if (found === undefined) throw new Error(`no box for ${id}`);
  return found;
};

describe("opening against one row", () => {
  test("the panel names the row and paints one box per cast member", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");

    expect(r.panel.isOpen()).toBe(true);
    expect(status().textContent).toContain("Chapter One");
    expect(boxes().map((b) => b.value)).toEqual(["m-ada", "m-bo", "m-harbour"]);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    // AND SAVE IS THERE. The empty-state test asserts the other half; without
    // this one a panel that never showed Save at all satisfied both, and a
    // mutation found exactly that.
    expect(save().hidden).toBe(false);
  });

  test("the boxes the store holds arrive ticked", async () => {
    const r = rig();
    r.stored.set("ch1", ["m-bo"]);

    await r.panel.open("ch1", "Chapter One");

    expect(boxFor("m-bo").checked).toBe(true);
    expect(boxFor("m-ada").checked).toBe(false);
    expect(r.reads).toEqual(["ch1"]);
  });

  test("each KIND is a named group, so the boxes are not a flat run", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");

    const groups = [...list().querySelectorAll<HTMLElement>("[role='group']")];
    expect(groups.map((g) => g.dataset.kind)).toEqual(["character", "place"]);
    expect(groups[0]?.getAttribute("aria-label")).toBe("Characters");
    expect(groups[1]?.getAttribute("aria-label")).toBe("Places");
  });

  test("each row's label carries the kind glyph, and the name is still the whole accessible text", async () => {
    // 097, W4, ticket 05's sibling: the box gains a glyph but the label's own
    // text -- what a screen reader reads -- is unchanged, the same rule the
    // cast panel's own entries state.
    const r = rig();
    await r.panel.open("ch1", "Chapter One");

    const row = boxFor("m-ada").closest("label.appears-row");
    expect(row).not.toBeNull();
    const icon = row?.querySelector(".appears-box-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.querySelector("svg")).not.toBeNull();
    expect(row?.textContent).toBe("Ada");
  });

  test("a kind nobody is in gets NO heading", async () => {
    // An empty heading is a promise of rows that are not there. The cast
    // panel's rule, and the control is the test above, where two of three
    // kinds DO appear.
    const r = rig();
    r.cast = [CAST[0] as CastMemberRow];

    await r.panel.open("ch1", "Chapter One");

    expect(
      [...list().querySelectorAll<HTMLElement>("[role='group']")].map((g) => g.dataset.kind),
    ).toEqual(["character"]);
  });

  test("a book with NO cast says so and Save is disabled", async () => {
    // THE EMPTY STATE IS A DESIGN QUESTION, not a fallback. Tagging is
    // impossible before there is anybody to tag, and a panel painting nothing
    // is indistinguishable from one that failed to paint. Save is disabled so
    // an empty record cannot be written over anything.
    const r = rig();
    r.cast = [];

    await r.panel.open("ch1", "Chapter One");

    expect(boxes()).toHaveLength(0);
    expect(list().textContent).toContain("Cast");
    // NOT THERE, rather than there and disabled. A capture found the first
    // version, which put a Save button under the sentence saying there was
    // nothing to save.
    expect(save().hidden).toBe(true);
  });

  test("THE ROW IS NAMED BEFORE EITHER READ RESOLVES", async () => {
    // The capture is taken SYNCHRONOUSLY, before any await, which is the whole
    // of the synopsis panel's rule. `open()` is not awaited here: what is
    // asserted is the state of the panel in the same tick it was opened in, and
    // a capture taken after the reads would leave this blank while the writer
    // is already looking at the panel.
    const r = rig();
    const opening = r.panel.open("ch1", "Chapter One");

    expect(r.panel.isOpen()).toBe(true);
    expect(status().textContent).toContain("Chapter One");

    await opening;
  });

  test("a second open re-reads rather than showing the first row's ticks", async () => {
    const r = rig();
    r.stored.set("ch1", ["m-ada"]);
    await r.panel.open("ch1", "Chapter One");
    r.panel.close();

    await r.panel.open("ch2", "Chapter Two");

    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(r.reads).toEqual(["ch1", "ch2"]);
  });
});

describe("saving", () => {
  test("Save sends the ticked boxes for the CAPTURED row and closes", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");
    boxFor("m-ada").checked = true;
    boxFor("m-harbour").checked = true;

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "ch1", memberIds: ["m-ada", "m-harbour"] }]);
    expect(r.panel.isOpen()).toBe(false);
    expect(r.dones[0]).toContain("Chapter One");
  });

  test("untagging everybody sends an EMPTY list and says a different sentence", async () => {
    // Two acts, two sentences: a writer who cleared the list deliberately
    // should be told it took, and an empty list is the only way back from
    // having tagged. The synopsis panel's rule.
    const r = rig();
    r.stored.set("ch1", ["m-ada"]);
    await r.panel.open("ch1", "Chapter One");
    boxFor("m-ada").checked = false;

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.writes).toEqual([{ itemId: "ch1", memberIds: [] }]);
    expect(r.dones[0]).not.toBe("");
    expect(r.dones[0]).not.toContain("Saved");
  });

  test("A SAVE WRITES THE ROW THE PANEL OPENED AGAINST, not a later one", async () => {
    // The whole reason this panel captures. There is no way to move the
    // navigator from inside this unit, so the equivalent is a SECOND open with
    // the first save still in flight: the write already in the air must carry
    // the id it was made with.
    const r = rig();
    await r.panel.open("ch1", "Chapter One");
    boxFor("m-ada").checked = true;
    r.holdWrite = { release: () => undefined };

    save().click();
    await Promise.resolve();
    await r.panel.open("ch2", "Chapter Two");

    expect(r.writes).toEqual([{ itemId: "ch1", memberIds: ["m-ada"] }]);
  });

  test("an answer for the row the writer LEFT does not close the panel over the new one", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");
    boxFor("m-ada").checked = true;
    r.holdWrite = { release: () => undefined };
    save().click();
    await Promise.resolve();
    await r.panel.open("ch2", "Chapter Two");

    r.holdWrite?.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.panel.isOpen()).toBe(true);
    expect(status().textContent).toContain("Chapter Two");
    expect(r.dones).toEqual([]);
  });

  test("a failed save leaves the panel open with the boxes as they were", async () => {
    const r = rig();
    r.fail.write = true;
    await r.panel.open("ch1", "Chapter One");
    boxFor("m-ada").checked = true;

    save().click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.panel.isOpen()).toBe(true);
    expect(boxFor("m-ada").checked).toBe(true);
    expect(r.notices).toHaveLength(1);
    expect(r.dones).toEqual([]);
  });
});

describe("a read that fails is not the empty state", () => {
  test("an unreadable store says so and does NOT paint 'nobody yet'", async () => {
    // The recorded `renderImports([])` defect: a catch that renders the
    // designed empty state reports a store this panel could not read as a book
    // with no cast, and the writer goes and adds everybody again.
    const r = rig();
    r.fail.read = true;

    await r.panel.open("ch1", "Chapter One");

    expect(r.notices).toHaveLength(1);
    expect(list().textContent).toBe("");
    expect(save().hidden).toBe(true);
  });
});

describe("dismissal", () => {
  test("Escape closes and hands focus back", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");

    panelEl().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(r.panel.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);
  });

  test("a click outside leaves it open and does NOT move focus", async () => {
    // 241: the inspector. Clicking the prose beside it is the point, so an
    // outside click leaves it open, exactly as it leaves the preview rail.
    const r = rig();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      await r.panel.open("ch1", "Chapter One");

      outside.click();

      expect(r.panel.isOpen()).toBe(true);
      expect(r.dismissals).toBe(0);
    } finally {
      outside.remove();
    }
  });

  test("an answer arriving after a close does not paint into a dismissed panel", async () => {
    // FOUND BY MUTATION. Without the generation bump in `close` the in-flight
    // read arrives, finds `mine === generation`, and paints a list into a
    // hidden element -- whose next open would then show a stale list for an
    // instant before its own read answers.
    const r = rig();
    r.stored.set("ch1", ["m-ada"]);
    const opening = r.panel.open("ch1", "Chapter One");
    r.panel.close();
    await opening;

    expect(r.panel.isOpen()).toBe(false);
    expect(boxes()).toHaveLength(0);
  });

  test("a close discards the ticks rather than saving them", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");
    boxFor("m-ada").checked = true;

    r.panel.close();

    expect(r.writes).toEqual([]);
    expect(r.stored.has("ch1")).toBe(false);
  });
});

describe("teardown", () => {
  test("destroy takes the panel out of the document", async () => {
    const r = rig();
    await r.panel.open("ch1", "Chapter One");

    r.panel.destroy();

    expect(document.getElementById("appears-panel")).toBe(null);
  });
});
