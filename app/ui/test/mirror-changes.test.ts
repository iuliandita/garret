import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMirrorChanges,
  summaryLabel,
  type MirrorAcceptOutcome,
  type MirrorChangeRow,
  type MirrorChanges,
} from "../src/mirror-changes";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

const body = (...words: string[]): string =>
  JSON.stringify({
    type: "doc",
    content: words.map((w) => ({ type: "paragraph", content: [{ type: "text", text: w }] })),
  });

function row(over: Partial<MirrorChangeRow> = {}): MirrorChangeRow {
  return {
    id: "it-1",
    path: "0000-Part/0000-Letter-Storm.md",
    was_path: null,
    state: "prose",
    title: "Letter Storm",
    file_title: null,
    store_body: body("the book has these words"),
    file_body: body("the file has other words"),
    error: null,
    can_accept: true,
    store_underlined: 0,
    ...over,
  };
}

interface Rig {
  panel: HTMLElement;
  unit: MirrorChanges;
  notices: string[];
  order: string[];
  /** Every `accept` call's id list, in order. */
  accepted: string[][];
  /** Every outcome handed to `onAccepted`. */
  landed: MirrorAcceptOutcome[];
  undone: { itemId: string; versionId: number; snapshotId: number; acceptedRev: number; title: string }[];
  dismissed: number[];
}

function mount(
  rows: MirrorChangeRow[] | (() => Promise<MirrorChangeRow[]>),
  pending: { reconcile?: () => Promise<void>; undo?: () => Promise<void> } = {},
): Rig {
  // A FRESH CONTAINER PER MOUNT, and the panel is looked up INSIDE it rather
  // than by id on the document: the suite shares one happy-dom document and
  // `getElementById` answers with the FIRST match, so a stale panel from an
  // earlier test would be the one read. That is the recorded switcher defect.
  const container = document.createElement("div");
  document.body.append(container);
  const notices: string[] = [];
  const order: string[] = [];
  const accepted: string[][] = [];
  const landed: MirrorAcceptOutcome[] = [];
  const undone: { itemId: string; versionId: number; snapshotId: number; acceptedRev: number; title: string }[] = [];
  const dismissed: number[] = [];
  const unit = createMirrorChanges({
    container,
    changes: async () => {
      order.push("changes");
      return typeof rows === "function" ? await rows() : rows;
    },
    drain: async () => {
      order.push("drain");
    },
    accept: async (ids) => {
      order.push("accept");
      accepted.push([...ids]);
      if (pendingAccept !== null) return await pendingAccept;
      if (failAccept) throw new Error("the store said no");
      return {
        report: {
          documents: ids.map((id) => ({ item_id: id, rev: 2, body: body("landed"), version_id: 8 })),
          snapshot: { id: 7, label: "Before accepting 1 change from the readable folder", created_at: 0, documents: 3 },
          net_words: 2,
        },
        paths: ids.map(() => "a.md"),
        underlined: 0,
      };
    },
    onAccepted: async (outcome) => {
      landed.push(outcome);
      if (rejectAccepted) throw new Error("the open scene could not reload");
      await pending.reconcile?.();
    },
    undo: async (handle) => {
      undone.push(handle);
      await pending.undo?.();
    },
    onNotice: (m) => notices.push(m),
    onDismiss: () => dismissed.push(1),
  });
  const panel = container.querySelector("#mirror-changes") as HTMLElement;
  return { panel, unit, notices, order, accepted, landed, undone, dismissed };
}

/** Set by the one test that needs the host to refuse. */
let failAccept = false;
/** Set by the teardown test that needs an in-flight host refusal. */
let pendingAccept: Promise<MirrorAcceptOutcome> | null = null;
let rejectAccepted = false;

const items = (rig: Rig): HTMLElement[] =>
  [...rig.panel.querySelectorAll("li.mirror-change")] as HTMLElement[];

describe("the change set panel", () => {
  test("a prose row names what changed and offers a comparison", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    const [li] = items(rig);
    expect(li?.dataset.state).toBe("prose");
    expect(li?.textContent).toContain("Letter Storm");
    expect(li?.textContent).toContain("The words changed");
    expect(li?.querySelector("button.mirror-change-compare")).not.toBeNull();
    rig.unit.destroy();
  });

  test("a row nobody could act on offers NO comparison", async () => {
    // A row the writer cannot act on must not be dressed as one they can, and
    // a diff is exactly that dressing. Four states at once, because the report
    // that motivated the split was that several behaved alike and all were
    // wrong; asserting one would leave the others free to regress.
    for (const state of ["front-matter", "title", "added", "deleted", "unreadable"]) {
      const rig = mount([row({ state })]);
      await rig.unit.setOpen(true);
      expect(
        items(rig)[0]?.querySelector("button.mirror-change-compare"),
        `${state} offered a comparison`,
      ).toBeNull();
      rig.unit.destroy();
    }
  });

  test("the diff reads your book as the OLD side and the file as the NEW one", async () => {
    // The direction, and the assertion is on the ELEMENTS rather than on the
    // text: reversing the two sides paints a diff that looks entirely correct
    // and says the opposite of what happened.
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    const compare = items(rig)[0]?.querySelector("button.mirror-change-compare") as HTMLElement;
    compare.click();
    const region = items(rig)[0]?.querySelector(".mirror-change-diff") as HTMLElement;
    expect(region.hidden).toBe(false);
    const removed = [...region.querySelectorAll("del")].map((n) => n.textContent).join("");
    const added = [...region.querySelectorAll("ins")].map((n) => n.textContent).join("");
    expect(removed).toContain("book");
    expect(added).toContain("file");
    rig.unit.destroy();
  });

  test("a second press puts the comparison away", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    const compare = items(rig)[0]?.querySelector("button.mirror-change-compare") as HTMLElement;
    const region = items(rig)[0]?.querySelector(".mirror-change-diff") as HTMLElement;
    compare.click();
    expect(compare.getAttribute("aria-expanded")).toBe("true");
    compare.click();
    expect(region.hidden).toBe(true);
    expect(compare.getAttribute("aria-expanded")).toBe("false");
    rig.unit.destroy();
  });

  test("the comparison's accessible name carries both totals", async () => {
    // THE CHANGE IS IN THE MIDDLE, deliberately. A token in `diff.ts` is a word
    // TOGETHER WITH the whitespace that follows it, so appending to the end
    // reports the previous last word as removed and re-added -- documented, and
    // a fixture that walked into it would make this test about tokenisation
    // rather than about the announcement.
    const rig = mount([
      row({ store_body: body("one two three"), file_body: body("one XX three") }),
    ]);
    await rig.unit.setOpen(true);
    const compare = items(rig)[0]?.querySelector("button.mirror-change-compare") as HTMLElement;
    compare.click();
    const label = items(rig)[0]
      ?.querySelector(".mirror-change-diff")
      ?.getAttribute("aria-label");
    expect(label).toContain("Letter Storm");
    expect(label).toContain("1 word only in the file");
    expect(label).toContain("1 word only in your book");
    rig.unit.destroy();
  });

  test("a renamed heading shows BOTH names", async () => {
    // Showing one of them would make a rename look like a change to something
    // else entirely.
    const rig = mount([row({ state: "title", file_title: "A Name The Writer Chose" })]);
    await rig.unit.setOpen(true);
    const text = items(rig)[0]?.textContent ?? "";
    expect(text).toContain("Letter Storm");
    expect(text).toContain("A Name The Writer Chose");
    rig.unit.destroy();
  });

  test("a moved file says where it came from", async () => {
    const rig = mount([
      row({ state: "moved", was_path: "0000-Part/0000-Letter-Storm.md", path: "elsewhere.md" }),
    ]);
    await rig.unit.setOpen(true);
    expect(items(rig)[0]?.textContent).toContain("0000-Part/0000-Letter-Storm.md");
    rig.unit.destroy();
  });

  test("an unreadable file shows the reason", async () => {
    const rig = mount([
      row({ state: "unreadable", error: "the file does not open with a front-matter fence" }),
    ]);
    await rig.unit.setOpen(true);
    expect(items(rig)[0]?.textContent).toContain("front-matter fence");
    rig.unit.destroy();
  });

  test("nothing to report is said in WORDS", async () => {
    // An empty list is how "the read failed" looks. The two answers must not
    // render the same way.
    const rig = mount([]);
    await rig.unit.setOpen(true);
    expect(rig.panel.querySelector("#mirror-changes-status")?.textContent).toBe(
      "Nothing in your folder differs from your book.",
    );
    rig.unit.destroy();
  });

  test("a read that fails says so instead of reporting no changes", async () => {
    const rig = mount(async () => {
      throw new Error("boom");
    });
    await rig.unit.setOpen(true);
    const status = rig.panel.querySelector("#mirror-changes-status")?.textContent ?? "";
    expect(status).toContain("Could not read the folder");
    expect(status).toContain("boom");
    rig.unit.destroy();
  });

  test("the store is DRAINED before it is read", async () => {
    // The "your book" side is the store's, and until the pending keystrokes are
    // in it the store's answer is not the scene the writer is looking at. It
    // matters more here than in history: an undrained keystroke also makes the
    // conflict test wrong, because the document revision the host compares has
    // not moved yet.
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    expect(rig.order).toEqual(["drain", "changes"]);
    rig.unit.destroy();
  });

  test("closing EMPTIES what it showed", async () => {
    // The rows describe the folder at the moment it was read. A reopened panel
    // painting yesterday's rows before the new read lands tells the writer
    // about a change that is already resolved.
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    expect(items(rig).length).toBe(1);
    await rig.unit.setOpen(false);
    expect(items(rig).length).toBe(0);
    expect(rig.panel.hidden).toBe(true);
    rig.unit.destroy();
  });

  test("Escape closes, clears, and returns focus through the page", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    expect(document.activeElement).toBe(rig.panel);
    rig.panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    expect(rig.panel.hidden).toBe(true);
    expect(items(rig)).toHaveLength(0);
    expect(rig.dismissed).toEqual([1]);
    rig.unit.destroy();
  });

  test("an outside click closes without taking focus back", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.click();
    await Promise.resolve();
    expect(rig.panel.hidden).toBe(true);
    expect(rig.dismissed).toEqual([]);
    outside.remove();
    rig.unit.destroy();
  });

  test("an inside click leaves the panel open", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    items(rig)[0]?.querySelector<HTMLButtonElement>("button.mirror-change-compare")?.click();
    expect(rig.panel.hidden).toBe(false);
    rig.unit.destroy();
  });

  test("destroy removes the outside-click listener", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    rig.unit.destroy();
    document.body.click();
    await Promise.resolve();
    expect(rig.dismissed).toEqual([]);
    expect(rig.unit.isOpen()).toBe(true);
  });

  test("a delayed refresh after close or destroy cannot repaint or refocus", async () => {
    let resolveChanges: ((rows: MirrorChangeRow[]) => void) | undefined;
    const rig = mount(
      () =>
        new Promise<MirrorChangeRow[]>((resolve) => {
          resolveChanges = resolve;
        }),
    );
    const opening = rig.unit.setOpen(true);
    await Promise.resolve();
    await Promise.resolve();
    await rig.unit.setOpen(false);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    resolveChanges?.([row()]);
    await opening;
    expect(items(rig)).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
    rig.unit.destroy();

    const second = mount(
      () =>
        new Promise<MirrorChangeRow[]>((resolve) => {
          resolveChanges = resolve;
        }),
    );
    const reopening = second.unit.setOpen(true);
    await Promise.resolve();
    await Promise.resolve();
    second.unit.destroy();
    outside.focus();
    resolveChanges?.([row()]);
    await reopening;
    expect(second.panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test("ONLY A ROW THE HOST MARKED APPLICABLE CARRIES AN ACCEPT", async () => {
    // An earlier version asserted that NO button here applies anything. This ships the accept,
    // so the boundary moves rather than disappearing: the control exists on
    // exactly the rows the HOST said may be taken, and on no other. The page
    // does not decide -- `can_accept` is the host's answer and this is a test
    // that the page obeys it, which is what makes a row rendered from a stale
    // read unable to grow a button the host would refuse.
    const rig = mount([
      row(),
      row({ state: "conflict", id: "it-2", path: "b.md", can_accept: true }),
      row({ state: "conflict", id: "it-5", path: "e.md", can_accept: false }),
      row({ state: "title", id: "it-3", path: "c.md", file_title: "X", can_accept: false }),
      row({ state: "deleted", id: "it-4", path: "d.md", can_accept: false }),
    ]);
    await rig.unit.setOpen(true);
    const withAccept = items(rig)
      .filter((li) => li.querySelector("button.mirror-change-accept") !== null)
      .map((li) => li.dataset.path);
    expect(withAccept).toEqual(["0000-Part/0000-Letter-Storm.md", "b.md"]);
    rig.unit.destroy();
  });

  test("THE ACCEPT IS THE LAST THING IN THE ROW, AFTER THE COMPARISON", async () => {
    // FOUND BY LOOKING, and only by looking: the first capture showed the
    // accept drawn above the direction line and the Compare toggle, so the
    // control that rewrites a scene came before the two things that say which
    // side it takes. Asserted as ORDER rather than as presence, because
    // presence is what the first version had and it was wrong.
    const rig = mount([row({ store_underlined: 2 })]);
    await rig.unit.setOpen(true);
    const classes = [...(items(rig)[0]?.children ?? [])].map((el) => el.className);
    expect(classes).toEqual([
      "mirror-change-what",
      "mirror-change-state",
      "mirror-change-direction",
      "mirror-change-compare",
      "mirror-change-diff",
      "mirror-change-loss",
      "mirror-change-accept",
    ]);
    rig.unit.destroy();
  });

  test("a row with no comparison still puts its accept last", async () => {
    // The other branch of the same rule. A state that carries no diff has
    // fewer things above the control and must not therefore get it first.
    const rig = mount([row({ state: "something-new", can_accept: true })]);
    await rig.unit.setOpen(true);
    const classes = [...(items(rig)[0]?.children ?? [])].map((el) => el.className);
    expect(classes[classes.length - 1]).toBe("mirror-change-accept");
    rig.unit.destroy();
  });

  test("accepting one row names that row's id and nothing else", async () => {
    const rig = mount([
      row(),
      row({ state: "prose", id: "it-2", path: "b.md" }),
    ]);
    await rig.unit.setOpen(true);
    const accept = items(rig)[1]?.querySelector<HTMLButtonElement>("button.mirror-change-accept");
    expect(accept).not.toBeNull();
    accept?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.accepted).toEqual([["it-2"]]);
    rig.unit.destroy();
  });

  test("ACCEPT ALL TAKES THE PROSE ROWS AND LEAVES EVERY CONFLICT", async () => {
    // A conflict is two live versions of one scene and the writer is choosing
    // between them; a control that swept twelve of those in one press is a
    // control that discards eleven decisions nobody made. The batch is for the
    // rows where there is nothing to decide.
    const rig = mount([
      row(),
      row({ state: "prose", id: "it-2", path: "b.md" }),
      row({ state: "conflict", id: "it-3", path: "c.md", can_accept: true }),
      row({ state: "title", id: "it-4", path: "d.md", can_accept: false }),
    ]);
    await rig.unit.setOpen(true);
    const all = rig.panel.querySelector<HTMLButtonElement>("#mirror-changes-accept-all");
    expect(all?.hidden).toBe(false);
    all?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.accepted).toEqual([["it-1", "it-2"]]);
    rig.unit.destroy();
  });

  test("there is no accept-all when nothing can be swept", async () => {
    const rig = mount([
      row({ state: "conflict", can_accept: true }),
      row({ state: "title", id: "it-4", path: "d.md", can_accept: false }),
    ]);
    await rig.unit.setOpen(true);
    // HIDDEN RATHER THAN ABSENT, and the assertion is the FLAG rather than the
    // element: the recorded trap is that an assertion on a happy-dom node
    // prints the whole node on failure and takes the run down with it.
    expect(
      rig.panel.querySelector<HTMLButtonElement>("#mirror-changes-accept-all")?.hidden,
    ).toBe(true);
    rig.unit.destroy();
  });

  test("THE ROW SAYS WHAT THE FOLDER ALREADY DROPPED, BEFORE THE PRESS", async () => {
    // Markdown has no underline, so the mirror's own write dropped it and no
    // accept can bring it back. A notice afterwards is an apology; this is on
    // the row, above the control, where it is a fact the writer decides with.
    const rig = mount([row({ store_underlined: 3 })]);
    await rig.unit.setOpen(true);
    const warning = items(rig)[0]?.querySelector(".mirror-change-loss");
    expect(warning?.textContent).toBe(
      "3 underlined runs in your book are not in this file, and taking the file will lose them.",
    );
    rig.unit.destroy();
  });

  test("a row with nothing to lose says nothing", async () => {
    const rig = mount([row({ store_underlined: 0 })]);
    await rig.unit.setOpen(true);
    expect(items(rig)[0]?.querySelector(".mirror-change-loss")).toBeNull();
    rig.unit.destroy();
  });

  test("the singular is the first thing a reader of one lost run meets", async () => {
    const rig = mount([row({ store_underlined: 1 })]);
    await rig.unit.setOpen(true);
    expect(items(rig)[0]?.querySelector(".mirror-change-loss")?.textContent).toBe(
      "1 underlined run in your book is not in this file, and taking the file will lose it.",
    );
    rig.unit.destroy();
  });

  test("an accept hands the outcome on and reads the folder again", async () => {
    // The panel's rows describe the folder at the moment it was read, and an
    // accept changes that folder. Leaving them painted would show the writer a
    // change they have just resolved and offer to resolve it twice.
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    rig.order.length = 0;
    items(rig)[0]?.querySelector<HTMLButtonElement>("button.mirror-change-accept")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.landed.length).toBe(1);
    expect(rig.landed[0]?.report.documents[0]?.item_id).toBe("it-1");
    expect(rig.order).toEqual(["drain", "accept", "drain", "changes"]);
    rig.unit.destroy();
  });

  test("an accepted row keeps one undo through close and consumes it on success", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    items(rig)[0]?.querySelector<HTMLButtonElement>("button.mirror-change-accept")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.panel.querySelectorAll("button.mirror-change-undo")).toHaveLength(1);

    await rig.unit.setOpen(false);
    await rig.unit.setOpen(true);
    const undo = rig.panel.querySelector<HTMLButtonElement>("button.mirror-change-undo");
    expect(undo).not.toBeNull();
    undo?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(rig.undone).toEqual([{ itemId: "it-1", versionId: 8, snapshotId: 7, acceptedRev: 2, title: "Letter Storm" }]);
    expect(rig.panel.querySelectorAll("button.mirror-change-undo")).toHaveLength(0);
    rig.unit.destroy();
  });

  test("a reconciliation refusal keeps the exact accepted undo handle usable", async () => {
    rejectAccepted = true;
    try {
      const rig = mount([row()]);
      await rig.unit.setOpen(true);
      items(rig)[0]?.querySelector<HTMLButtonElement>("button.mirror-change-accept")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.notices.join(" ")).toContain("could not be refreshed");
      const undo = rig.panel.querySelector<HTMLButtonElement>("button.mirror-change-undo");
      expect(undo).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      undo?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rig.undone).toHaveLength(1);
      rig.unit.destroy();
    } finally {
      rejectAccepted = false;
    }
  });

  test("batch undo consumes only its selected handle and ignores duplicate presses", async () => {
    let release = (): void => undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const rig = mount([row(), row({ id: "it-2", title: "Second" })], { undo: () => wait });
    await rig.unit.setOpen(true);
    const accept = rig.panel.querySelector<HTMLButtonElement>("#mirror-changes-accept-all");
    expect(accept?.hidden).toBe(false);
    accept!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const undos = rig.panel.querySelectorAll<HTMLButtonElement>(".mirror-change-undo");
    expect(undos).toHaveLength(2);
    undos[0]!.click();
    undos[0]!.click();
    undos[1]!.click();
    expect(rig.undone.map((handle) => handle.itemId)).toEqual(["it-1"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const remaining = rig.panel.querySelectorAll<HTMLButtonElement>(".mirror-change-undo");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.getAttribute("aria-label")).toBe("Undo taking the words into Second");
    // Even a retained reference to a consumed button cannot repeat an undo.
    undos[0]!.click();
    expect(rig.undone).toHaveLength(1);
    rig.unit.destroy();
  });

  test("a later acceptance replaces the previous undo group", async () => {
    const rig = mount([row(), row({ id: "it-2", title: "Second" })]);
    await rig.unit.setOpen(true);
    const first = rig.panel.querySelector<HTMLButtonElement>(".mirror-change-accept");
    expect(first).not.toBeNull();
    first!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.panel.querySelectorAll(".mirror-change-undo")).toHaveLength(1);
    const second = rig.panel.querySelectorAll<HTMLButtonElement>(".mirror-change-accept")[1];
    expect(second).toBeDefined();
    second!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const undos = rig.panel.querySelectorAll<HTMLButtonElement>(".mirror-change-undo");
    expect(undos).toHaveLength(1);
    expect(undos[0]!.getAttribute("aria-label")).toBe("Undo taking the words into Second");
    rig.unit.destroy();
  });

  test("undo is unavailable until the accepted editor body has reconciled", async () => {
    let release = (): void => undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const rig = mount([row()], { reconcile: () => wait });
    await rig.unit.setOpen(true);
    const accept = rig.panel.querySelector<HTMLButtonElement>(".mirror-change-accept");
    expect(accept).not.toBeNull();
    accept!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.landed).toHaveLength(1);
    expect(rig.panel.querySelectorAll(".mirror-change-undo")).toHaveLength(0);
    accept!.click();
    expect(rig.accepted).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.panel.querySelectorAll(".mirror-change-undo")).toHaveLength(1);
    rig.unit.destroy();
  });

  test("a refused undo retains its original handle for a successful retry", async () => {
    let refuse = true;
    const rig = mount([row()], { undo: async () => { if (refuse) throw new Error("changed since acceptance"); } });
    await rig.unit.setOpen(true);
    rig.panel.querySelector<HTMLButtonElement>(".mirror-change-accept")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const undo = rig.panel.querySelector<HTMLButtonElement>(".mirror-change-undo");
    expect(undo).not.toBeNull();
    undo!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.notices.join(" ")).toContain("changed since acceptance");
    expect(rig.panel.querySelectorAll(".mirror-change-undo")).toHaveLength(1);
    refuse = false;
    undo!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.undone).toHaveLength(2);
    expect(rig.undone[1]).toEqual(rig.undone[0]);
    expect(rig.panel.querySelectorAll(".mirror-change-undo")).toHaveLength(0);
    rig.unit.destroy();
  });

  test("reopening during acceptance reconciliation retains the original document title", async () => {
    let release = (): void => undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let rows = [row()];
    const rig = mount(async () => rows, { reconcile: () => wait });
    await rig.unit.setOpen(true);
    rig.panel.querySelector<HTMLButtonElement>(".mirror-change-accept")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.landed).toHaveLength(1);
    rows = [];
    await rig.unit.setOpen(false);
    await rig.unit.setOpen(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.panel.querySelector(".mirror-change-undo")?.getAttribute("aria-label"))
      .toBe("Undo taking the words into Letter Storm");
    rig.unit.destroy();
  });

  test("a refused accept says so and leaves the rows where they are", async () => {
    failAccept = true;
    try {
      const rig = mount([row()]);
      await rig.unit.setOpen(true);
      items(rig)[0]?.querySelector<HTMLButtonElement>("button.mirror-change-accept")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.notices.join(" ")).toContain("the store said no");
      expect(rig.landed.length).toBe(0);
      expect(items(rig).length).toBe(1);
      rig.unit.destroy();
    } finally {
      failAccept = false;
    }
  });

  test("a refused accept after destroy cannot notify through the next project", async () => {
    let refuse: ((reason: Error) => void) | undefined;
    pendingAccept = new Promise<MirrorAcceptOutcome>((_, reject) => {
      refuse = reject;
    });
    try {
      const rig = mount([row()]);
      await rig.unit.setOpen(true);
      items(rig)[0]?.querySelector<HTMLButtonElement>("button.mirror-change-accept")?.click();
      await Promise.resolve();
      rig.unit.destroy();
      refuse?.(new Error("the store said no"));
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.notices).toEqual([]);
      expect(rig.landed).toEqual([]);
    } finally {
      pendingAccept = null;
    }
  });

  test("a state this build does not know still reaches the writer", async () => {
    // The host may grow a state before the page does. A row that rendered as
    // nothing would be a change the writer is never told about.
    const rig = mount([row({ state: "something-new" })]);
    await rig.unit.setOpen(true);
    expect(items(rig)[0]?.textContent).toContain("something-new");
    rig.unit.destroy();
  });

  test("destroy takes the panel out of the page", async () => {
    const rig = mount([row()]);
    await rig.unit.setOpen(true);
    rig.unit.destroy();
    expect(rig.panel.isConnected).toBe(false);
  });
});

describe("summaryLabel", () => {
  test("no difference is said in words", () => {
    expect(summaryLabel(0, 0)).toBe(
      "No difference: your book and this file hold the same words.",
    );
  });

  test("the singular is the first thing a reader sees", () => {
    expect(summaryLabel(1, 0)).toBe("1 word only in the file.");
    expect(summaryLabel(0, 1)).toBe("1 word only in your book.");
  });

  test("both sides name which side they are", () => {
    // The direction again. "3 added, 2 removed" is the sentence this must not
    // be: added TO WHAT is the whole question a reviewer is asking.
    expect(summaryLabel(3, 2)).toBe("3 words only in the file, 2 words only in your book.");
  });
});
