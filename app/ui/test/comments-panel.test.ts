// app/ui/test/comments-panel.test.ts
// The surface a writer reads their notes in.
//
// Every assertion here compares strings, ids and booleans, never elements: the
// recorded trap is that `expect(<happy-dom node>)` serializes megabytes on
// failure and has taken a 2.7 s suite to 150 s.
import { afterEach, describe, expect, test } from "bun:test";
import {
  CAPPED_NOTE,
  EMPTY_BODY,
  NO_SELECTION,
  ORPHAN_NOTE,
  commentLabel,
  createCommentsPanel,
  formatWhen,
  statusLabel,
  type CommentsPanel,
} from "../src/comments-panel";
import type { CommentAnchor, CommentRow } from "../src/comments";

const NOW = 1_700_000_000_000;

function row(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 1,
    item_id: "scene-0",
    body: "does she know yet?",
    anchor_from: 10,
    anchor_to: 20,
    quote: "the moon",
    orphaned: false,
    resolved: false,
    created_at: NOW - 60_000,
    updated_at: NOW - 60_000,
    ...over,
  };
}

interface Rig {
  panel: CommentsPanel;
  container: HTMLElement;
  notices: string[];
  dones: string[];
  created: { body: string; from: number; to: number; quote: string }[];
  resolved: { id: number; resolved: boolean }[];
  bodies: { id: number; body: string }[];
  revealed: { from: number; to: number }[];
  synced: number[][];
  rows: CommentRow[];
  anchors: Map<number, CommentAnchor>;
  selection: { from: number; to: number };
  capped: boolean;
  quote: string;
}

function mount(over: Partial<Pick<Rig, "rows" | "selection" | "capped" | "quote">> = {}): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const rig: Rig = {
    panel: undefined as unknown as CommentsPanel,
    container,
    notices: [],
    dones: [],
    created: [],
    resolved: [],
    bodies: [],
    revealed: [],
    synced: [],
    rows: over.rows ?? [],
    anchors: new Map(),
    selection: over.selection ?? { from: 0, to: 0 },
    capped: over.capped ?? false,
    quote: over.quote ?? "the moon",
  };
  rig.panel = createCommentsPanel({
    container,
    drain: async () => undefined,
    activeDocId: () => "scene-0",
    list: async () => rig.rows,
    create: async (_itemId, body, from, to, quote) => {
      rig.created.push({ body, from, to, quote });
      const made = row({ id: 99, body, anchor_from: from, anchor_to: to, quote });
      rig.rows = [...rig.rows, made];
      return made;
    },
    setBody: async (id, body) => {
      rig.bodies.push({ id, body });
      rig.rows = rig.rows.map((r) => (r.id === id ? { ...r, body } : r));
    },
    setResolved: async (id, resolved) => {
      rig.resolved.push({ id, resolved });
      rig.rows = rig.rows.map((r) => (r.id === id ? { ...r, resolved } : r));
    },
    anchorOf: (id) => rig.anchors.get(id),
    quoteAt: (from, to) => (from < to ? rig.quote : ""),
    selectionRange: () => rig.selection,
    reveal: (from, to) => {
      rig.revealed.push({ from, to });
      return from < to;
    },
    capped: () => rig.capped,
    syncEditor: (rows) => rig.synced.push(rows.map((r) => r.id)),
    onDone: (m) => rig.dones.push(m),
    onNotice: (m) => rig.notices.push(m),
    onDismiss: () => undefined,
    now: () => NOW,
  });
  return rig;
}

const mounted: Rig[] = [];
function rigFor(over: Parameters<typeof mount>[0] = {}): Rig {
  const rig = mount(over);
  mounted.push(rig);
  return rig;
}

afterEach(() => {
  while (mounted.length > 0) {
    const rig = mounted.pop();
    rig?.panel.destroy();
    rig?.container.remove();
  }
});

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no #${id}`);
  return found;
}

function rowIds(): string[] {
  return [...document.querySelectorAll("#comments-list .comment-row")].map(
    (e) => (e as HTMLElement).dataset.commentId ?? "",
  );
}

function click(selector: string): void {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${selector}`);
  found.click();
}

describe("the status line", () => {
  test("no comments at all says so", () => {
    expect(statusLabel(0, 0, false)).toBe("No comments on this scene yet.");
  });

  test("all resolved and hidden is its own sentence, not '0 open comments'", () => {
    // The two look identical in the list - both are empty - and a reader acts
    // differently on each. The recorded defect is exactly this shape: an empty
    // listbox with nothing saying why.
    //
    // ASSERTED AS A WHOLE STRING. An earlier version asked only that the two
    // differ and that one contains "hidden", and a mutation dropping the branch
    // entirely SURVIVED it: the fall-through says "0 open comments. 3 resolved,
    // hidden.", which differs and contains "hidden" and is a sentence nobody
    // should ship.
    expect(statusLabel(0, 3, false)).toBe("Nothing open. 3 resolved comments, hidden.");
    expect(statusLabel(0, 3, true)).toBe("Nothing open. 3 resolved comments, shown below.");
    expect(statusLabel(0, 1, false)).toBe("Nothing open. 1 resolved comment, hidden.");
  });

  test("the singular is not '1 comments'", () => {
    expect(statusLabel(1, 0, false)).toBe("1 open comment.");
  });
});

describe("the accessible name of a row", () => {
  test("carries the passage, the note and when", () => {
    const name = commentLabel(row(), "the moon", false, NOW);

    expect(name).toContain("the moon");
    expect(name).toContain("does she know yet?");
    expect(name).toContain("1 minute ago");
  });

  test("an orphan's name says the passage was deleted instead of quoting it", () => {
    // Built from the STATE, not by reading the rendered row back out of the DOM
    // - the recorded word-count rule.
    const name = commentLabel(row(), "the moon", true, NOW);

    expect(name).toContain("deleted");
    expect(name).not.toContain("“the moon”");
  });

  test("a resolved note says it is resolved", () => {
    expect(commentLabel(row({ resolved: true }), "x", false, NOW)).toContain("resolved comment");
  });
});

describe("formatWhen", () => {
  test("a moment ago is 'just now'", () => {
    expect(formatWhen(NOW - 1000, NOW)).toBe("just now");
  });

  test("the singular minute is not '1 minutes'", () => {
    expect(formatWhen(NOW - 60_000, NOW)).toBe("1 minute ago");
  });
});

describe("listing", () => {
  test("a row is painted per comment and the editor is told the same set", async () => {
    const rig = rigFor({ rows: [row({ id: 1 }), row({ id: 2, anchor_from: 30, anchor_to: 40 })] });

    await rig.panel.open();

    expect(rowIds()).toEqual(["1", "2"]);
    // ONE READ feeds both, so the marks and the list cannot describe different
    // sets of notes.
    expect(rig.synced.at(-1)).toEqual([1, 2]);
  });

  test("an empty scene says what to do rather than painting nothing", async () => {
    const rig = rigFor();

    await rig.panel.open();

    expect(el("comments-empty").textContent).toContain("Select a passage");
  });

  test("resolved rows are hidden until the toggle is pressed", async () => {
    const rig = rigFor({ rows: [row({ id: 1 }), row({ id: 2, resolved: true })] });
    await rig.panel.open();

    expect(rowIds()).toEqual(["1"]);

    click("#comments-show-resolved");

    expect(rowIds()).toEqual(["1", "2"]);
    expect(el("comments-show-resolved").getAttribute("aria-pressed")).toBe("true");
  });

  test("the panel reads POSITIONS FROM THE EDITOR, not from the stored row", async () => {
    // The store holds where a note was at the last flush; the editor has been
    // mapping it through every transaction since. Painting the stored pair would
    // take the writer to the wrong words.
    const rig = rigFor({ rows: [row({ id: 1, anchor_from: 10, anchor_to: 20 })] });
    rig.anchors.set(1, { id: 1, from: 55, to: 61, resolved: false });
    await rig.panel.open();

    click(".comment-quote");

    expect(rig.revealed).toEqual([{ from: 55, to: 61 }]);
  });

  test("a note the editor has not been told about falls back to the stored pair", async () => {
    // Without the fallback every row would read as an orphan in the window
    // between a create and its sync - which is the one thing this panel must
    // never say wrongly.
    const rig = rigFor({ rows: [row({ id: 1, anchor_from: 10, anchor_to: 20 })] });
    await rig.panel.open();

    click(".comment-quote");

    expect(rig.revealed).toEqual([{ from: 10, to: 20 }]);
  });
});

describe("an orphaned note", () => {
  test("says the passage was deleted and quotes what it used to say", async () => {
    const rig = rigFor({ rows: [row({ id: 1, quote: "the drowned orchard" })] });
    rig.anchors.set(1, { id: 1, from: 12, to: 12, resolved: false });

    await rig.panel.open();

    const meta = document.querySelector(".comment-meta")?.textContent ?? "";
    expect(meta).toContain(ORPHAN_NOTE);
    // The STORED quote, because there is nothing in the document left to read.
    expect(document.querySelector(".comment-quote")?.textContent).toBe("the drowned orchard");
    expect(
      (document.querySelector(".comment-row") as HTMLElement | null)?.dataset.orphaned,
    ).toBe("true");
    // The mark that survives greyscale, decorative so the name stays the row's.
    expect(document.querySelector(".comment-meta svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("keeps its text", async () => {
    const rig = rigFor({ rows: [row({ id: 1, body: "cut this?" })] });
    rig.anchors.set(1, { id: 1, from: 12, to: 12, resolved: false });

    await rig.panel.open();

    expect(document.querySelector(".comment-body")?.textContent).toBe("cut this?");
  });

  test("cannot be jumped to, and its button is the thing that says so", async () => {
    const rig = rigFor({ rows: [row({ id: 1 })] });
    rig.anchors.set(1, { id: 1, from: 12, to: 12, resolved: false });

    await rig.panel.open();

    expect((document.querySelector(".comment-quote") as HTMLButtonElement).disabled).toBe(true);
    expect(rig.revealed).toEqual([]);
  });
});

describe("adding a note", () => {
  test("compose quotes the selected passage above the field", async () => {
    const rig = rigFor({ selection: { from: 10, to: 20 }, quote: "the moon" });

    await rig.panel.open("compose");

    expect(el("comments-compose-quote").textContent).toContain("the moon");
    expect(rig.notices).toEqual([]);
  });

  test("with no selection it SAYS why it cannot act", async () => {
    // The recorded states-and-messages defect: a panel whose first use is a bare
    // return. Both the quote line and a notice, because the first is only read
    // by someone looking at the panel and the second reaches a screen reader.
    const rig = rigFor({ selection: { from: 7, to: 7 } });

    await rig.panel.open("compose");

    expect(el("comments-compose-quote").textContent).toBe(NO_SELECTION);
    expect(rig.notices).toEqual([NO_SELECTION]);
  });

  test("an empty note is refused with a sentence, not a silent return", async () => {
    const rig = rigFor({ selection: { from: 10, to: 20 } });
    await rig.panel.open("compose");

    (el("comments-compose") as HTMLTextAreaElement).value = "   ";
    click("#comments-add");
    await Promise.resolve();

    expect(rig.notices).toContain(EMPTY_BODY);
    expect(rig.created).toEqual([]);
  });

  test("the note lands on the selection the panel opened with", async () => {
    const rig = rigFor({ selection: { from: 10, to: 20 }, quote: "the moon" });
    await rig.panel.open("compose");
    (el("comments-compose") as HTMLTextAreaElement).value = "does she know?";

    click("#comments-add");
    await new Promise((r) => setTimeout(r, 0));

    expect(rig.created).toEqual([
      { body: "does she know?", from: 10, to: 20, quote: "the moon" },
    ]);
    expect(rig.dones).toContain("Comment added.");
  });

  test("pressing add with no selection at all creates nothing and says so", async () => {
    const rig = rigFor({ selection: { from: 3, to: 3 } });
    await rig.panel.open("compose");
    rig.notices.length = 0;
    (el("comments-compose") as HTMLTextAreaElement).value = "orphan note";

    click("#comments-add");
    await new Promise((r) => setTimeout(r, 0));

    expect(rig.created).toEqual([]);
    expect(rig.notices).toContain(NO_SELECTION);
  });
});

describe("resolving", () => {
  test("resolve keeps the note and says where it went", async () => {
    const rig = rigFor({ rows: [row({ id: 1 })] });
    await rig.panel.open();

    click(".comment-resolve");
    await new Promise((r) => setTimeout(r, 0));

    expect(rig.resolved).toEqual([{ id: 1, resolved: true }]);
    // A note resolved while the resolved rows are hidden vanishes from the list,
    // so this sentence is the only thing that can say what happened.
    expect(rig.dones.at(-1)).toContain("Show resolved");
    expect(rig.rows).toHaveLength(1);
  });

  test("a resolved row's button reopens it", async () => {
    const rig = rigFor({ rows: [row({ id: 1, resolved: true })] });
    await rig.panel.open();
    click("#comments-show-resolved");

    click(".comment-resolve");
    await new Promise((r) => setTimeout(r, 0));

    expect(rig.resolved).toEqual([{ id: 1, resolved: false }]);
  });
});

describe("rewriting", () => {
  test("Edit loads the note into the one field and saving sends it", async () => {
    const rig = rigFor({ rows: [row({ id: 1, body: "first" })] });
    await rig.panel.open();

    click(".comment-edit");
    expect((el("comments-compose") as HTMLTextAreaElement).value).toBe("first");
    (el("comments-compose") as HTMLTextAreaElement).value = "second";
    click("#comments-add");
    await new Promise((r) => setTimeout(r, 0));

    expect(rig.bodies).toEqual([{ id: 1, body: "second" }]);
    // And it did NOT create a new note beside the one it was rewriting.
    expect(rig.created).toEqual([]);
  });

  test("cancel puts the field back to composing", async () => {
    const rig = rigFor({ rows: [row({ id: 1, body: "first" })] });
    await rig.panel.open();
    click(".comment-edit");

    click("#comments-cancel");

    expect((el("comments-compose") as HTMLTextAreaElement).value).toBe("");
    expect(el("comments-add").textContent).toBe("Add comment");
  });
});

describe("the ceiling's sentence", () => {
  test("is hidden while mapping is running", async () => {
    const rig = rigFor({ rows: [row({ id: 1 })] });

    await rig.panel.open();

    expect(el("comments-capped").hidden).toBe(true);
  });

  test("is shown when the editor has stopped following the notes", async () => {
    const rig = rigFor({ rows: [row({ id: 1 })], capped: true });

    await rig.panel.open();

    expect(el("comments-capped").hidden).toBe(false);
    expect(el("comments-capped").textContent).toBe(CAPPED_NOTE);
  });
});

describe("housekeeping", () => {
  test("a listing that resolves after the panel was destroyed paints nothing", async () => {
    const rig = mount({ rows: [row({ id: 1 })] });
    const opened = rig.panel.open();
    rig.panel.destroy();
    await opened;

    expect(document.getElementById("comments-panel")).toBeNull();
    rig.container.remove();
  });

  test("Escape closes the panel", async () => {
    const rig = rigFor({ rows: [row({ id: 1 })] });
    await rig.panel.open();

    el("comments-panel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(rig.panel.isOpen()).toBe(false);
  });
});
