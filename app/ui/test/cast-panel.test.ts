// The cast panel: the characters, places and points of interest of a book.
//
// A PANEL AND NOT A NAVIGATOR SECTION, which is what most of this file's shape
// follows from. The navigator is a virtual list over the STORE'S ITEM WALK
// (`storeSourceFrom` takes `ProjectItem[]` and every row needs an id, a
// parent_id, a type, a position, a rev and a depth); a cast member has none of
// those, so a cast row in the navigator would have to be a synthesised item -
// which is the third exclusion the whole design exists to avoid.
//
// THE DRAFTS ARE THE PART WORTH TESTING HARDEST. Selecting another entry with
// unsaved typing in the form must not discard it, because the list and the form
// are one surface and moving between entries is the ordinary way to use it.
import { HostCommandError } from "../src/command-error";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test, afterEach } from "bun:test";

// The suite's preload registers happy-dom for files under app/ui, but a file
// run on its own has no document yet.
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createCastPanel,
  type CastPanel,
  type CastMemberRow,
  type PictureView,
} from "../src/cast-panel";
import { CAST_KINDS, KIND_CHARACTER, KIND_PLACE, KIND_POI } from "../src/cast-kinds";
import { t } from "../src/i18n";

interface Rig {
  panel: CastPanel;
  container: HTMLElement;
  stored: CastMemberRow[];
  deleted: CastMemberRow[];
  creates: Array<{ kind: string; name: string }>;
  saves: CastMemberRow[];
  removes: string[];
  notices: string[];
  dones: string[];
  dismissals: number;
  fail: { list: boolean; create: boolean; save: boolean; remove: boolean };
  /** Thrown by `save` instead of the generic "could not save": a BARE
   *  STRING, matching what a real Tauri command rejection actually is (the
   *  exact `Err(String)` the host returned, never wrapped in a JS `Error`) --
   *  lets a test fake `cast_set_wire_error`'s JSON without a real host. */
  saveError: string | Error | null;
  /** What the host says about the selected member's picture, keyed by id. */
  views: Map<string, PictureView>;
  /** Which member ids the panel asked the host about. */
  viewed: string[];
  /** What the picture dialog answers next: a member, or null for cancelled. */
  picked: CastMemberRow | null | "fail";
  picks: string[];
  clears: string[];
  /** What the FULL-SIZE read answers next, and what the viewer was handed. */
  fullView: PictureView;
  fulls: string[];
  shown: Array<{ dataUri: string; label: string }>;
  /** Hold the next picture read open, so the test can move on while it is in
   *  flight. */
  holdPicture: { wait: Promise<void>; release: (() => void) | undefined } | null;
  /** Trim the way the store does, so a draft that outlived its save is
   *  distinguishable from one that did not. */
  trims: boolean;
  /** Hold the next save open, so the test can act while it is in flight. */
  holdSave: { wait: Promise<void>; release: (() => void) | undefined } | null;
  holdRestore: { wait: Promise<void>; release: (() => void) | undefined } | null;
  next: number;
}

const rigs: Rig[] = [];

function member(over: Partial<CastMemberRow> = {}): CastMemberRow {
  return {
    id: "m1",
    kind: KIND_CHARACTER,
    name: "Ilse",
    summary: "",
    fields: [],
    aliases: [],
    picture_path: null,
    ...over,
  };
}

function rig(seed: CastMemberRow[] = []): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = {
    panel: undefined as unknown as CastPanel,
    container,
    stored: seed.slice(),
    deleted: [],
    creates: [],
    saves: [],
    removes: [],
    notices: [],
    dones: [],
    dismissals: 0,
    fail: { list: false, create: false, save: false, remove: false },
    saveError: null,
    views: new Map(),
    viewed: [],
    picked: null,
    picks: [],
    clears: [],
    fullView: { state: "present", data_uri: "data:image/png;base64,FULL" },
    fulls: [],
    shown: [],
    holdPicture: null,
    trims: false,
    holdSave: null,
    holdRestore: null,
    next: 100,
  };
  r.panel = createCastPanel({
    container,
    list: async () => {
      if (r.fail.list) throw new Error("could not read");
      return r.stored.map((m) => ({
        ...m,
        fields: m.fields.map((f) => ({ ...f })),
        aliases: [...m.aliases],
      }));
    },
    listDeleted: async () => r.deleted.map((m) => ({ ...m })),
    restore: async (id) => {
      if (r.holdRestore !== null) await r.holdRestore.wait;
      const restored = r.deleted.find((m) => m.id === id);
      if (restored === undefined) throw new Error("missing removed entry");
      r.deleted = r.deleted.filter((m) => m.id !== id);
      r.stored.push({ ...restored, deleted_at: null });
      return restored;
    },
    create: async (kind, name) => {
      r.creates.push({ kind, name });
      if (r.fail.create) throw new Error("could not create");
      const made = member({ id: `m${(r.next += 1)}`, kind, name });
      r.stored.push(made);
      return made;
    },
    save: async (id, kind, name, summary, fields, aliases) => {
      if (r.holdSave !== null) await r.holdSave.wait;
      if (r.saveError !== null) throw r.saveError;
      if (r.fail.save) throw new Error("could not save");
      const saved = member({
        id,
        kind,
        name: r.trims ? name.trim() : name,
        summary: r.trims ? summary.trim() : summary,
        fields,
        aliases,
      });
      r.saves.push(saved);
      r.stored = r.stored.map((m) => (m.id === id ? saved : m));
      return saved;
    },
    remove: async (id) => {
      r.removes.push(id);
      if (r.fail.remove) throw new Error("could not delete");
      const removed = r.stored.find((m) => m.id === id);
      if (removed !== undefined) r.deleted.push({ ...removed, deleted_at: 1 });
      r.stored = r.stored.filter((m) => m.id !== id);
    },
    picture: async (id) => {
      r.viewed.push(id);
      if (r.holdPicture !== null) await r.holdPicture.wait;
      return r.views.get(id) ?? { state: "none", data_uri: null };
    },
    pickPicture: async (id) => {
      r.picks.push(id);
      const picked = r.picked;
      if (picked === "fail") throw new Error("that file is not a PNG or a JPEG");
      if (picked !== null) {
        r.stored = r.stored.map((m) => (m.id === id ? picked : m));
        r.views.set(id, { state: "present", data_uri: "data:image/png;base64,AAA" });
      }
      return picked;
    },
    clearPicture: async (id) => {
      r.clears.push(id);
      const cleared = { ...member({ id }), picture_path: null };
      r.stored = r.stored.map((m) => (m.id === id ? cleared : m));
      r.views.set(id, { state: "none", data_uri: null });
      return cleared;
    },
    fullPicture: async (id) => {
      r.fulls.push(id);
      if (r.fullView.state === "fail") throw new Error("could not read it");
      return r.fullView;
    },
    showFullSize: (dataUri, label) => r.shown.push({ dataUri, label }),
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
  for (const r of rigs.splice(0)) {
    r.panel.destroy();
    r.container.remove();
  }
});

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no #${id} in the document`);
  return found as T;
};
const entries = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".cast-entry"));
const entryNamed = (name: string): HTMLButtonElement => {
  const found = entries().find((b) => b.textContent === name);
  if (found === undefined) {
    throw new Error(`no entry named ${name} among ${entries().map((b) => b.textContent).join(", ")}`);
  }
  return found;
};
const fieldRows = (): Array<{ label: HTMLInputElement; value: HTMLInputElement }> =>
  Array.from(document.querySelectorAll<HTMLElement>(".cast-field-row")).map((row) => ({
    label: row.querySelector<HTMLInputElement>(".cast-field-label")!,
    value: row.querySelector<HTMLInputElement>(".cast-field-value")!,
  }));
const aliasRows = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>(".cast-alias-row input"));

/** Drain the microtask queue.
 *
 *  A COUNTED RUN OF `await Promise.resolve()` IS A TEST THAT DEPENDS ON HOW MANY
 *  awaits the implementation happens to have. Every act here is a click that
 *  starts a promise chain of a length nobody should have to know, so this waits
 *  for a macrotask instead: everything already queued runs first. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Whether an element with this id is in the document.
 *
 *  A BOOLEAN AND NEVER THE ELEMENT. `expect(<node>).toBe(null)` prints the WHOLE
 *  happy-dom node on failure -- megabytes of getters -- which killed four
 *  mutation runs by their own timeout and reported them with no exit
 *  status. That is the recorded "compare ids, never elements" rule in a second
 *  shape: a mutation harness cannot tell a timeout from a pass, and a harness
 *  that calls one a kill is worse than one that calls it a survivor. */
const present = (id: string): boolean => document.getElementById(id) !== null;

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the cast panel", () => {
  test("it starts hidden and opens on the list", async () => {
    const r = rig([member()]);
    expect(r.panel.isOpen()).toBe(false);
    expect(el("cast-panel").hidden).toBe(true);

    await r.panel.open();

    expect(r.panel.isOpen()).toBe(true);
    expect(entries().map((b) => b.textContent)).toEqual(["Ilse"]);
  });

  test("both kind selects offer the three kinds IN WORDS, not in wire tokens", async () => {
    // A select whose options read "character", "place", "poi" is a control
    // labelled with the strings that cross the boundary, and it looks perfectly
    // correct to every assertion that only checks how many options there are.
    const r = rig([member()]);
    await r.panel.open();
    entryNamed("Ilse").click();

    for (const id of ["cast-new-kind", "cast-kind"]) {
      const select = el<HTMLSelectElement>(id);
      const options = Array.from(select.options);
      expect(options.map((o) => o.value)).toEqual([...CAST_KINDS]);
      for (const option of options) {
        expect(option.textContent).not.toBe("");
        expect(option.textContent).not.toBe(option.value);
      }
    }
  });

  test("the three kinds are grouped, each group named, in the declared order", async () => {
    // The whole product point of one table with a kind: a writer looking for a
    // place must not read past every character to find it. The groups carry a
    // name so the entries under them are not a flat list of buttons to a screen
    // reader either.
    const r = rig([
      member({ id: "a", kind: KIND_POI, name: "The burnt letter" }),
      member({ id: "b", kind: KIND_PLACE, name: "The Kelp Quay" }),
      member({ id: "c", kind: KIND_CHARACTER, name: "Ilse" }),
    ]);

    await r.panel.open();

    const groups = Array.from(document.querySelectorAll<HTMLElement>(".cast-group"));
    expect(groups.map((g) => g.dataset.kind)).toEqual([...CAST_KINDS]);
    for (const group of groups) {
      const label = group.getAttribute("aria-label");
      // NAMED FROM THE CATALOG, not from the wire token: a group headed "poi"
      // is a group headed by an internal string, and it would satisfy any
      // assertion that only checked the label was non-empty.
      expect(label).not.toBe(null);
      expect(label).not.toBe("");
      expect(label).not.toBe(group.dataset.kind);
      expect(group.querySelector(".cast-group-title")?.textContent ?? null).toBe(label);
    }
    // And the entries are under the group they belong to, not merely present.
    expect(groups[0]?.querySelectorAll(".cast-entry").length).toBe(1);
    expect(groups[0]?.textContent).toContain("Ilse");
  });

  test("a kind nobody has an entry in shows no group at all", async () => {
    // An empty heading is a promise of rows that are not there.
    const r = rig([member()]);
    await r.panel.open();
    const groups = Array.from(document.querySelectorAll<HTMLElement>(".cast-group"));
    expect(groups.map((g) => g.dataset.kind)).toEqual([KIND_CHARACTER]);
  });

  test("an empty cast says so rather than painting an empty box", async () => {
    // The recorded `renderProjects` defect: an empty listbox is
    // indistinguishable from one that failed to paint.
    const r = rig();

    await r.panel.open();

    expect(entries()).toHaveLength(0);
    expect(el("cast-entries").textContent).not.toBe("");
    expect(r.notices).toEqual([]);
  });

  test("a list that could not be read is NOT painted as an empty cast", async () => {
    // The recorded `renderImports([])` defect: a `catch` that renders the
    // designed empty state reports a store it could not read as a book with
    // nobody in it, and the writer would then add everyone again.
    const r = rig([member()]);
    r.fail.list = true;

    await r.panel.open();

    expect(r.notices).toHaveLength(1);
    expect(el("cast-entries").textContent).toBe("");
    expect(el<HTMLButtonElement>("cast-new").disabled).toBe(true);
  });

  test("adding one sends the kind and the name and selects what came back", async () => {
    const r = rig();
    await r.panel.open();

    type(el<HTMLInputElement>("cast-new-name"), "  The Kelp Quay  ");
    el<HTMLSelectElement>("cast-new-kind").value = KIND_PLACE;
    el<HTMLButtonElement>("cast-new").click();
    await settle();

    expect(r.creates).toEqual([{ kind: KIND_PLACE, name: "The Kelp Quay" }]);
    expect(r.dones).toHaveLength(1);
    // Selected, so the writer can go straight on to the detail. Adding a name
    // and then having to find it in the list is the shape of a form nobody
    // finishes.
    expect(el("cast-detail").hidden).toBe(false);
    // Add opens in Read like any other selection, so reaching the form
    // to check what it holds means pressing Edit first -- a #cast-edit that
    // failed to reveal the form would leave the assertion below unreachable.
    el<HTMLButtonElement>("cast-edit").click();
    expect(el<HTMLInputElement>("cast-name").value).toBe("The Kelp Quay");
    // And the field the writer typed into is empty again, so the next one does
    // not arrive prefilled with the last one's name.
    expect(el<HTMLInputElement>("cast-new-name").value).toBe("");
  });

  test("adding with no name SAYS SO rather than doing nothing", async () => {
    // The recorded pair: `Edit > Replace…` and the project panel's Create both
    // returned silently on an empty field, and the first use of each was a
    // writer pressing a button and watching nothing happen.
    const r = rig();
    await r.panel.open();

    el<HTMLButtonElement>("cast-new").click();
    await settle();

    expect(r.creates).toEqual([]);
    expect(r.notices).toHaveLength(1);
  });

  test("selecting an entry fills the form with what the store holds", async () => {
    const r = rig([
      member({
        id: "a",
        name: "Ilse",
        summary: "Keeps the letter.",
        fields: [
          { label: "accent", value: "flat northern" },
          { label: "wants", value: "to be believed" },
        ],
      }),
    ]);
    await r.panel.open();

    entryNamed("Ilse").click();
    // selecting opens Read; the form these lines check is Edit's, so a
    // #cast-edit that failed to reveal it would leave every line below
    // reading whatever the elements happened to hold beforehand.
    el<HTMLButtonElement>("cast-edit").click();

    expect(el<HTMLInputElement>("cast-name").value).toBe("Ilse");
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("Keeps the letter.");
    // Every field the store holds, IN ORDER, plus one blank row to type into.
    expect(fieldRows().map((f) => [f.label.value, f.value.value])).toEqual([
      ["accent", "flat northern"],
      ["wants", "to be believed"],
      ["", ""],
    ]);
    expect(entryNamed("Ilse").getAttribute("aria-pressed")).toBe("true");
    // And the panel SAYS which entry the form is about. Without it the writer
    // has a form over their manuscript and nothing saying whose it is -- the
    // recorded compose-quote defect in the comments panel, found by capture.
    expect(el("cast-status").textContent).toContain("Ilse");
  });

  test("saving sends the whole record and the blank trailing row is not sent", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();

    type(el<HTMLInputElement>("cast-name"), "Ilse Vandermeer");
    type(el<HTMLTextAreaElement>("cast-summary"), "Keeps the letter.");
    el<HTMLSelectElement>("cast-kind").value = KIND_POI;
    el<HTMLSelectElement>("cast-kind").dispatchEvent(new Event("change", { bubbles: true }));
    const [first] = fieldRows();
    type(first!.label, "accent");
    type(first!.value, "flat northern");
    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(r.saves).toHaveLength(1);
    expect(r.saves[0]).toEqual({
      id: "a",
      kind: KIND_POI,
      name: "Ilse Vandermeer",
      summary: "Keeps the letter.",
      fields: [{ label: "accent", value: "flat northern" }],
      // ONE BLANK ROW, untouched -- `fields`' own trailing-row shape, one
      // column over: the host's `normalise_aliases` drops it, and this test
      // is about the FORM'S wire, not the store's trimming.
      aliases: [""],
      // THE PICTURE IS NOT IN THE SAVE, and that is the whole containment: the
      // form cannot carry one, correctly or otherwise, so a Save can never lose
      // a photograph. The host's `cast_set` names four columns and this is a
      // fifth. `picture_path` rides here only because the FAKE returns the row
      // the store would return.
      picture_path: null,
    });
    expect(r.dones).toHaveLength(1);
  });

  test("Add detail gives a second empty row without touching the first", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(fieldRows()[0]!.label, "accent");

    el<HTMLButtonElement>("cast-add-field").click();

    expect(fieldRows().map((f) => f.label.value)).toEqual(["accent", ""]);
  });

  test("clearing both halves of a row sends it EMPTIED, not still carrying its label", async () => {
    // There is no per-row remove control, deliberately: the store already drops
    // a row that is blank on both sides, so emptying one IS the delete and a
    // button would be a second way to say it. What the PANEL owes is that the
    // row it sends carries what the writer left in it and not what was there
    // when the form was painted -- the dropping itself is the store's rule and
    // is asserted in `store/cast.rs`.
    const r = rig([
      member({ id: "a", name: "Ilse", fields: [{ label: "accent", value: "flat" }] }),
    ]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(fieldRows()[0]!.label, "");
    type(fieldRows()[0]!.value, "");

    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(r.saves).toHaveLength(1);
    expect(r.saves[0]?.fields.some((f) => f.label !== "" || f.value !== "")).toBe(false);
  });

  test("typing in one entry and selecting another KEEPS the first entry's draft", async () => {
    // The failure this panel would otherwise have, and it is on the ordinary
    // path: the list and the form are one surface, so moving between entries is
    // how the panel is used and it must not be how work is lost.
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "half a thought");

    entryNamed("Zoya").click();
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("");
    entryNamed("Ilse").click();

    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("half a thought");
    expect(r.saves).toEqual([]);
  });

  test("Deleted entries toggle keeps an unsaved cast draft and updates the status", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "half a thought");

    el<HTMLButtonElement>("cast-deleted-toggle").click();
    expect(el("cast-status").textContent).toBe(t("cast.deleted.status"));
    expect(el("cast-detail").hidden).toBe(true);
    el<HTMLButtonElement>("cast-deleted-toggle").click();
    expect(el("cast-status").textContent).toBe(t("cast.status.choose"));
    entryNamed("Ilse").click();
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("half a thought");
    expect(r.saves).toEqual([]);
  });

  test("a saved entry shows what the STORE now holds, not what was typed", async () => {
    // The other half of the drafts, and the fixture is what makes it
    // falsifiable: the rig's save TRIMS, exactly as the store does, so a draft
    // that outlived its save shows the writer their own untrimmed typing over
    // what the file actually holds. With a save that echoed its argument back
    // the two implementations would be indistinguishable.
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    r.trims = true;
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "   saved text   ");
    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("saved text");
    entryNamed("Zoya").click();
    entryNamed("Ilse").click();

    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("saved text");
    expect(r.saves).toHaveLength(1);
  });

  test("a save that lands after the writer moved on does NOT leave a stale draft", async () => {
    // THE WINDOW P2 FOUND. Ordinarily the repaint after a save overwrites the
    // draft, so dropping it looks free -- but a writer who presses Save and then
    // clicks the next entry before the answer arrives never gets that repaint,
    // and the draft is the pre-save typing. Coming back to the entry would then
    // show it their own stale text over what the file actually holds, which is
    // the one thing the drafts exist not to do.
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    r.trims = true;
    const hold: { wait: Promise<void>; release: (() => void) | undefined } = {
      wait: Promise.resolve(),
      release: undefined,
    };
    hold.wait = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    r.holdSave = hold;
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "   what was typed   ");

    el<HTMLButtonElement>("cast-save").click();
    // The writer moves on BEFORE the save answers, so no repaint of Ilse's form
    // ever happens.
    entryNamed("Zoya").click();
    r.holdSave = null;
    hold.release?.();
    await settle();

    entryNamed("Ilse").click();

    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("what was typed");
  });

  test("Delete ARMS on the first press and only removes on the second", async () => {
    // Removal is recoverable through the Cast panel's Deleted entries view.
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- Delete lives in the form, and a #cast-edit that
    // failed to reveal it would leave this whole test acting on a control a
    // writer could never reach.
    el<HTMLButtonElement>("cast-edit").click();

    const remove = el<HTMLButtonElement>("cast-remove");
    const resting = remove.textContent;
    remove.click();
    await settle();

    expect(r.removes).toEqual([]);
    expect(remove.textContent).not.toBe(resting);

    remove.click();
    await settle();

    expect(r.removes).toEqual(["a"]);
    expect(r.dones).toHaveLength(1);
    expect(entries()).toHaveLength(0);
    expect(el("cast-detail").hidden).toBe(true);
  });

  test("a removed entry remains available by id and restores its complete record", async () => {
    const original = member({ id: "a", name: "Ilse", summary: "A singer", fields: [{ label: "voice", value: "alto" }], aliases: ["Ils"], picture_path: "face.png" });
    const r = rig([original]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    el<HTMLButtonElement>("cast-remove").click();
    el<HTMLButtonElement>("cast-remove").click();
    await settle();
    expect(r.deleted[0]).toMatchObject({ ...original, deleted_at: 1 });
    el<HTMLButtonElement>("cast-deleted-toggle").click();
    const restore = document.querySelector<HTMLButtonElement>("[data-restore-id='a']");
    expect(restore?.getAttribute("aria-label")).toContain("Ilse");
    restore?.click();
    await settle();
    expect(r.deleted).toHaveLength(0);
    expect(r.stored[0]).toMatchObject({ ...original, deleted_at: null });
    expect(el("cast-sheet-name").textContent).toBe("Ilse");
    expect((document.activeElement as HTMLElement).dataset.id).toBe("a");
  });

  test("a restore answer arriving after close does not repaint the dismissed panel", async () => {
    const r = rig();
    r.deleted = [member({ id: "a", name: "Ilse", deleted_at: 1 })];
    const gate: { release: (() => void) | undefined } = { release: undefined };
    const wait = new Promise<void>((resolve) => { gate.release = resolve; });
    r.holdRestore = { wait, release: gate.release };
    await r.panel.open();
    el<HTMLButtonElement>("cast-deleted-toggle").click();
    document.querySelector<HTMLButtonElement>("[data-restore-id='a']")?.click();
    r.panel.close();
    gate.release?.();
    await settle();
    expect(r.panel.isOpen()).toBe(false);
    expect(r.dones).toEqual([]);
    expect(document.querySelector("[data-restore-id='a']")).toBeNull();
  });

  test("the armed Delete disarms when the writer does anything else", async () => {
    // An armed destructive control that stays armed is one a writer meets a
    // minute later having forgotten they armed it.
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "Delete ARMS...".
    el<HTMLButtonElement>("cast-edit").click();
    const remove = el<HTMLButtonElement>("cast-remove");
    const resting = remove.textContent;
    remove.click();

    entryNamed("Zoya").click();

    expect(remove.textContent).toBe(resting);
    remove.click();
    await settle();
    expect(r.removes).toEqual([]);
  });

  test("a failed save LEAVES THE PANEL OPEN with the writing still in it", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "paragraphs the writer typed");
    r.fail.save = true;

    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(r.notices).toHaveLength(1);
    expect(r.panel.isOpen()).toBe(true);
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("paragraphs the writer typed");
  });

  test("Escape closes it and hands focus back; an outside click leaves it open", async () => {
    // the inspector. Clicking the prose beside it is the point.
    const r = rig([member()]);
    await r.panel.open();

    el("cast-panel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(r.panel.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);

    await r.panel.open();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(r.panel.isOpen()).toBe(true);
    expect(r.dismissals).toBe(1);
  });

  test("a second open re-reads the store rather than showing what it held", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    r.panel.close();
    r.stored.push(member({ id: "b", kind: KIND_PLACE, name: "The Kelp Quay" }));

    await r.panel.open();

    expect(entries().map((b) => b.textContent)).toEqual(["Ilse", "The Kelp Quay"]);
  });

  test("destroy takes its document listener with it", async () => {
    // The recorded menu-bar shape: a leaked document-level listener changes no
    // DOM state and no behaviour a test can reach, while accumulating one live
    // closure per project switch. Counting is what finds it.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const r = rig([member()]);
      await r.panel.open();
      r.panel.destroy();
      expect(added.slice().sort()).toEqual(removed.slice().sort());
      // no outside-click closer on the inspector.
      expect(added).not.toContain("click");
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });

  test("an answer that lands after the panel closed repaints nothing", async () => {
    // The generation rule every panel here follows: a writer told about a list
    // they are no longer looking at is being told about somebody else's book.
    const r = rig([member()]);
    // A MUTABLE RECORD, not a `let`. A local assigned only inside a closure is
    // narrowed to `null` for the rest of the file, so `release?.()` compiles to
    // a call on `never` -- the recorded shape where a guard type-checks while
    // asserting nothing. Property narrowing resets.
    const gate: { release: (() => void) | undefined } = { release: undefined };
    const waiting = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const panel = createCastPanel({
      container: r.container,
      list: async () => {
        await waiting;
        return [member({ name: "Arrived late" })];
      },
      listDeleted: async () => [],
      restore: async () => member(),
      create: async () => member(),
      save: async () => member(),
      remove: async () => undefined,
      picture: async () => ({ state: "none", data_uri: null }),
      pickPicture: async () => null,
      clearPicture: async () => member(),
      fullPicture: async () => ({ state: "none", data_uri: null }),
      showFullSize: () => undefined,
      onDone: () => undefined,
      onNotice: () => undefined,
      onDismiss: () => undefined,
    });
    const opening = panel.open();
    panel.close();
    gate.release?.();
    await opening;

    expect(document.body.textContent).not.toContain("Arrived late");
    panel.destroy();
  });

  test("with members and none selected, the status points at the add row below it", async () => {
    // `cast-status` sits BEFORE `cast-new-row` in the panel (heading, status,
    // newRow, entries). A word saying "above" would send the writer to the
    // heading; pin the word to the real document order.
    const r = rig([member()]);
    await r.panel.open();

    const status = el("cast-status");
    const newRow = el("cast-new-row");
    expect(
      status.compareDocumentPosition(newRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const text = status.textContent ?? "";
    expect(text).toMatch(/below/);
    expect(text).not.toMatch(/above/);
  });

  test("with no members, cast.empty points at the add row above it (control)", async () => {
    // The one sentence already correct: `cast-empty` lives in
    // `entries`, which is appended AFTER `newRow`, so "above" is the right
    // word here. This is the control that must already pass.
    const r = rig([]);
    await r.panel.open();

    const newRow = el("cast-new-row");
    const empty = document.querySelector(".cast-empty") as HTMLElement;
    expect(
      newRow.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const text = empty.textContent ?? "";
    expect(text).toMatch(/above/);
    expect(text).not.toMatch(/below/);
  });
});

describe("the kinds", () => {
  test("the page's three strings are the host's three strings", async () => {
    // THE WIRE CONTRACT, restated on both sides rather than shared, exactly as
    // the item types are. There is no build step joining the page and the host,
    // so a fourth kind added on one side only must break a test rather than
    // pass silently.
    const rust = await Bun.file(
      "app/shell-tauri/src-tauri/src/store/cast.rs",
    ).text();
    for (const kind of CAST_KINDS) {
      expect(rust).toContain(`"${kind}"`);
    }
    // Vacuity guard: an empty list would satisfy the loop above.
    expect(CAST_KINDS).toHaveLength(3);
    expect(rust).toContain("pub const CAST_KINDS: [&str; 3]");
  });
});

describe("the cast panel's picture", () => {
  // THE PANEL NEVER SEES A PATH AND NEVER SEES AN ORIGINAL. What crosses to it
  // is a state word and, at most, a data URI of a THUMBNAIL the host already
  // bounded at 256 px -- so a page holding a picture holds kilobytes rather
  // than a decoded photograph. `app/shell-tauri/src-tauri/src/pictures.rs` is
  // where that is enforced; here it is what the deps' shape allows.

  test("a member with no picture shows the empty state and no image", async () => {
    const r = rig([member()]);
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    expect(r.viewed).toEqual(["m1"]);
    expect(present("cast-picture")).toBe(false);
    expect(el("cast-picture-state").textContent).toBe("No picture yet.");
    // NOTHING TO REMOVE, so no control offering it. A disabled button that is
    // never enabled is a control the writer has to learn does nothing.
    expect(present("cast-picture-clear")).toBe(false);
    expect(el<HTMLButtonElement>("cast-picture-choose").hidden).toBe(false);
  });

  test("a present picture renders the thumbnail the host handed over", async () => {
    const r = rig([member({ picture_path: "a.jpg" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    const img = el<HTMLImageElement>("cast-picture");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,QUJD");
    // NAMED for a screen reader, and named after the MEMBER rather than after
    // the file: a uuid is not a description of anybody.
    expect(img.getAttribute("alt")).toBe("Picture of Ilse");
    expect(present("cast-picture-clear")).toBe(true);
  });

  test("a picture whose file is gone says so and keeps the remove control", async () => {
    // IT DOES NOT CLEAR THE COLUMN. A writer whose external drive is unmounted
    // has not asked to forget which photograph they chose, so the record stands
    // and the panel reports. The remove control stays because removing is now
    // the one thing the writer might actually want to do.
    const r = rig([member({ picture_path: "gone.jpg" })]);
    r.views.set("m1", { state: "missing", data_uri: null });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    expect(present("cast-picture")).toBe(false);
    expect(el("cast-picture-state").textContent).toBe(
      "The picture file is not where this book keeps it.",
    );
    expect(present("cast-picture-clear")).toBe(true);
  });

  test("a picture that cannot be read says something different from one that is gone", async () => {
    // TWO SENTENCES, NOT ONE. "It is not there" and "it is there and I cannot
    // read it" send a writer to two different places, and one word for both
    // would send them to the wrong one half the time.
    const r = rig([member({ picture_path: "broken.jpg" })]);
    r.views.set("m1", { state: "unreadable", data_uri: null });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    expect(el("cast-picture-state").textContent).toBe("That picture could not be read.");
  });

  test("choosing a picture repaints the member and says so", async () => {
    const r = rig([member()]);
    r.picked = member({ picture_path: "new.jpg" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    el("cast-picture-choose").click();
    await settle();

    expect(r.picks).toEqual(["m1"]);
    expect(r.dones).toContain("Picture added to Ilse.");
    expect(el<HTMLImageElement>("cast-picture").getAttribute("src")).toBe(
      "data:image/png;base64,AAA",
    );
  });

  test("cancelling the dialog changes nothing and says nothing", async () => {
    // `project_export_as`'s rule: cancelling is an ANSWER, not a failure. It
    // must raise no notice, announce no success and repaint nothing.
    const r = rig([member()]);
    r.picked = null;
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    const before = r.dones.length;

    el("cast-picture-choose").click();
    await settle();

    expect(r.picks).toEqual(["m1"]);
    expect(r.dones.length).toBe(before);
    expect(r.notices).toEqual([]);
    expect(present("cast-picture")).toBe(false);
  });

  test("a refused file is reported and the member is left alone", async () => {
    const r = rig([member()]);
    r.picked = "fail";
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    el("cast-picture-choose").click();
    await settle();

    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toContain("not a PNG or a JPEG");
    expect(el("cast-picture-state").textContent).toBe("No picture yet.");
  });

  test("removing a picture asks the host and repaints the empty state", async () => {
    const r = rig([member({ picture_path: "a.jpg" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();

    el("cast-picture-clear").click();
    await settle();

    expect(r.clears).toEqual(["m1"]);
    expect(r.dones).toContain("Picture removed from Ilse.");
    expect(present("cast-picture")).toBe(false);
    expect(el("cast-picture-state").textContent).toBe("No picture yet.");
  });

  test("the picture is read again when the writer moves to another entry", async () => {
    // ONE MEMBER AT A TIME, which is the memory rule this slice keeps: the page
    // holds the thumbnail of the entry that is open and no other. A list-shaped
    // read would put every picture in the book into the web process at once.
    const r = rig([member({ id: "m1", name: "Ilse" }), member({ id: "m2", name: "Bram" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    entryNamed("Bram").click();
    await settle();

    expect(r.viewed).toEqual(["m1", "m2"]);
  });

  test("a picture answer that arrives after the writer moved on does not paint", async () => {
    // The generation rule the rest of this panel already follows, on a new
    // channel: a slow read for the entry the writer LEFT must not paint a
    // photograph over the entry they are looking at now. Ilse has a picture and
    // Bram has none, so the two answers are visibly different.
    const r = rig([member({ id: "m1", name: "Ilse" }), member({ id: "m2", name: "Bram" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,SVNMRQ==" });
    let release: (() => void) | undefined;
    r.holdPicture = { wait: new Promise<void>((r2) => (release = r2)), release: undefined };
    await r.panel.open();

    entryNamed("Ilse").click();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();
    // Ilse's read is held. Move on before it answers.
    r.holdPicture = null;
    entryNamed("Bram").click();
    await settle();
    // Bram's answer has landed. Now let Ilse's stale one through.
    release?.();
    await settle();

    expect(r.viewed).toEqual(["m1", "m2"]);
    expect(present("cast-picture")).toBe(false);
    expect(el("cast-picture-state").textContent).toBe("No picture yet.");
  });

  test("the picture block is emptied when the selection goes away", async () => {
    // A read still in flight for the entry that was open must not paint into a
    // form that is now about nobody -- and the block is EMPTIED rather than
    // hidden, so a stale answer has nothing to arrive into.
    const r = rig([member({ picture_path: "a.jpg" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();
    expect(present("cast-picture")).toBe(true);

    // The member goes away underneath the panel, which is what `reload` does
    // when the store no longer holds it.
    r.stored = [];
    r.panel.close();
    await r.panel.open();
    await settle();

    expect(el("cast-detail").hidden).toBe(true);
    expect(present("cast-picture")).toBe(false);
    expect(present("cast-picture-choose")).toBe(false);
  });

  test("choosing a picture disarms an armed delete", async () => {
    // ANY other interaction disarms, which is the arming control's whole rule.
    // A new surface inside the form is exactly where that gets forgotten.
    const r = rig([member()]);
    r.picked = member({ picture_path: "new.jpg" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- the picture controls this test drives live in the
    // form, and a #cast-edit that failed to reveal it would leave them
    // unreachable.
    el<HTMLButtonElement>("cast-edit").click();
    el("cast-remove").click();
    expect(el("cast-remove").textContent).toBe("Move to Deleted entries?");

    el("cast-picture-choose").click();
    await settle();

    expect(el("cast-remove").textContent).toBe("Remove");
    expect(r.removes).toEqual([]);
  });
  test("a present picture offers a full-size view and a broken one does not", async () => {
    // THERE WAS NO WAY TO SEE A PICTURE FULL SIZE BEFORE THIS. The
    // control is offered only where there IS one: the three broken states have
    // nothing to show, and a control whose whole answer is "there is nothing to
    // show" exists to disappoint. This moves the control onto the sheet, so
    // this reads it straight off Read -- no `cast-edit` needed to see it.
    const r = rig([
      member({ picture_path: "a.jpg" }),
      member({ id: "m2", name: "Bram", picture_path: "gone.jpg" }),
    ]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    r.views.set("m2", { state: "missing", data_uri: null });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    expect(present("cast-picture-full")).toBe(true);
    // EDIT KEEPS NO ENLARGE CONTROL OF ITS OWN: the sheet's square is the only
    // one the panel has since an earlier version retired the form's separate button, and this
    // checks the form's picture block specifically rather than the whole
    // document, which still holds the sheet's square underneath.
    el<HTMLButtonElement>("cast-edit").click();
    expect(el("cast-picture-block").querySelector("#cast-picture-full")).toBeNull();

    // TWO MEMBERS AND NOT ONE MEMBER TWICE: selecting the entry the form is
    // already on does not re-read the picture, so a fixture that clicked the
    // same row again would be asserting a property of the panel's caching.
    entryNamed("Bram").click();
    await settle();

    expect(present("cast-picture-full")).toBe(false);
  });

  test("View full size asks the host AGAIN rather than enlarging the thumbnail", async () => {
    // The thumbnail is 256 px on its long side, and blowing it up is exactly
    // the picture the writer pressed this because they could not see. What
    // crosses is still bounded -- `pictures::FULL_MAX` -- so the web process
    // never holds an original.
    const r = rig([member({ picture_path: "a.jpg" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();

    el("cast-picture-full").click();
    await settle();

    expect(r.fulls).toEqual(["m1"]);
    expect(r.shown).toEqual([
      { dataUri: "data:image/png;base64,FULL", label: "Picture of Ilse" },
    ]);
  });

  test("a full read that comes back with nothing is NAMED, not silent", async () => {
    // A full read can fail where the thumbnail beside it succeeded, because the
    // file can go between the two reads -- and a press that appears to do
    // nothing reads as a broken control.
    const r = rig([member({ picture_path: "a.jpg" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    r.fullView = { state: "missing", data_uri: null };
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();

    el("cast-picture-full").click();
    await settle();

    expect(r.shown).toEqual([]);
    expect(r.notices.length).toBe(1);
  });

  test("viewing a picture disarms an armed delete", async () => {
    // ANY other interaction disarms. Delete only arms from Edit -- `cast-remove`
    // lives in its form -- but the control pressed here to disarm it is the
    // sheet's: this moved viewing there, and the sheet never leaves the
    // document while Edit is open.
    const r = rig([member({ picture_path: "a.jpg" })]);
    r.views.set("m1", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();
    el<HTMLButtonElement>("cast-edit").click();
    el("cast-remove").click();
    expect(el("cast-remove").textContent).toBe("Move to Deleted entries?");

    el("cast-picture-full").click();
    await settle();

    expect(el("cast-remove").textContent).toBe("Remove");
    expect(r.removes).toEqual([]);
  });
});

describe("drafts across a close", () => {
  test("typing that was never saved is still in the form after the panel is closed and reopened", async () => {
    // An earlier version dropped drafts on close as "a deliberate act"; the writer who hit
    // Escape by accident lost a paragraph. Owner's call of 2026-09-01.
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    await settle();
    entryNamed("Ilse").click();
    await settle();
    // Edit first -- see the comment on "selecting an entry fills the
    // form...".
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLInputElement>("cast-name"), "Ilse Vandermeer");

    r.panel.close();
    await r.panel.open();
    await settle();
    entryNamed("Ilse").click();
    await settle();

    expect(el<HTMLInputElement>("cast-name").value).toBe("Ilse Vandermeer");
    // Nothing reached the store: a draft is not a save.
    expect(r.saves).toHaveLength(0);
  });
});

describe("the sheet is read, the form is Edit", () => {
  // happy-dom never applies style.css, so none of these can watch `#cast-
  // sheet` or `#cast-detail` actually disappear -- that half is CSS, keyed on
  // `panel.dataset.mode`, and is a fact about the stylesheet a screenshot
  // checks. What IS a fact about this file is the DATA each surface holds and
  // which mode the panel claims to be in, and that is what these assert.

  test("selecting an entry opens Read, not Edit, and the sheet shows what the store holds", async () => {
    const r = rig([
      member({
        id: "a",
        name: "Ilse",
        summary: "Keeps the letter.",
        fields: [{ label: "accent", value: "flat northern" }],
      }),
    ]);
    await r.panel.open();

    entryNamed("Ilse").click();

    expect(el("cast-panel").dataset.mode).toBe("read");
    expect(el("cast-sheet-name").textContent).toBe("Ilse");
    expect(el("cast-sheet-summary").textContent).toBe("Keeps the letter.");
    expect(
      Array.from(document.querySelectorAll("#cast-sheet-fields dt")).map((n) => n.textContent),
    ).toEqual(["accent"]);
    expect(
      Array.from(document.querySelectorAll("#cast-sheet-fields dd")).map((n) => n.textContent),
    ).toEqual(["flat northern"]);
  });

  test("an empty summary and an empty field list show nothing, not a placeholder", async () => {
    const r = rig([member({ id: "a", name: "Ilse", summary: "", fields: [] })]);
    await r.panel.open();

    entryNamed("Ilse").click();

    expect(el("cast-sheet-summary").hidden).toBe(true);
    expect(el("cast-sheet-fields").hidden).toBe(true);
  });

  test("pressing Edit shows today's form and puts the caret in the name field", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();

    el<HTMLButtonElement>("cast-edit").click();

    expect(el("cast-panel").dataset.mode).toBe("edit");
    expect(document.activeElement).toBe(el("cast-name"));
  });

  test("Cancel returns to Read and discards the draft for that member, and nothing was saved", async () => {
    const r = rig([
      member({ id: "a", name: "Ilse", summary: "before" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "typed but never saved");

    el<HTMLButtonElement>("cast-cancel").click();

    expect(el("cast-panel").dataset.mode).toBe("read");
    expect(r.saves).toEqual([]);
    // FOCUS MOVES TO #cast-edit: #cast-cancel is about to be
    // hidden by the mode CSS, and a hidden element cannot hold focus in any
    // engine -- without moving it explicitly, it falls to <body>, and the
    // panel's own Escape handler stops hearing anything.
    expect(document.activeElement).toBe(el("cast-edit"));
    // THE DRAFT IS GONE, not merely hidden: pressing Edit again on the SAME
    // member without reselecting it must show the store's own text, not the
    // typing Cancel was pressed over.
    el<HTMLButtonElement>("cast-edit").click();
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("before");
    // AND STILL GONE after a round trip through another member, which is the
    // path `select` reads and writes drafts on. The discard is the repaint
    // from the store: leaving Ilse writes the repainted form back as her
    // draft, so a Cancel that skipped the repaint would hand the typing back
    // here.
    el<HTMLButtonElement>("cast-cancel").click();
    entryNamed("Zoya").click();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("before");
  });

  test("Cancel does not disturb another member's draft (037's rule, still true)", async () => {
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "Ilse's unsaved typing");
    entryNamed("Zoya").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "Zoya's unsaved typing");

    el<HTMLButtonElement>("cast-cancel").click();
    entryNamed("Ilse").click();

    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("Ilse's unsaved typing");
  });

  test("pressing Cancel disarms an armed delete", async () => {
    // ANY other interaction disarms, which is the arming control's whole
    // rule -- the picture tests already model this for the picture surface.
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    const remove = el<HTMLButtonElement>("cast-remove");
    remove.click();
    expect(remove.textContent).toBe("Move to Deleted entries?");

    el<HTMLButtonElement>("cast-cancel").click();

    expect(remove.textContent).toBe("Remove");
  });

  test("pressing Edit disarms an armed delete", async () => {
    // Armed inside Edit, then Edit pressed again -- a redundant press, but
    // ANY other interaction disarms and this control is no exception.
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    const remove = el<HTMLButtonElement>("cast-remove");
    remove.click();
    expect(remove.textContent).toBe("Move to Deleted entries?");

    el<HTMLButtonElement>("cast-edit").click();

    expect(remove.textContent).toBe("Remove");
  });

  test("a successful Save returns to Read", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "saved text");

    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(el("cast-panel").dataset.mode).toBe("read");
    expect(el("cast-sheet-summary").textContent).toBe("saved text");
    // FOCUS MOVES TO #cast-edit, the same reason Cancel's own
    // test asserts it: #cast-save is about to be hidden by the mode CSS.
    expect(document.activeElement).toBe(el("cast-edit"));
  });

  test("a failed Save stays in Edit with the writing still in the form", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    r.fail.save = true;
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(el<HTMLTextAreaElement>("cast-summary"), "paragraphs the writer typed");

    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(el("cast-panel").dataset.mode).toBe("edit");
    expect(el<HTMLTextAreaElement>("cast-summary").value).toBe("paragraphs the writer typed");
  });

  test("selecting a different member always opens Read, even out of an Edit in progress", async () => {
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();

    entryNamed("Zoya").click();

    expect(el("cast-panel").dataset.mode).toBe("read");
  });

  test("with no members the list says so (037's sentence, the only one) and the add row is open", async () => {
    // a SECOND sentence used to live in the sheet
    // ("cast.sheet.empty") and said the add row was BELOW, which contradicted
    // this file's own list sentence ("above") the moment the row was made to open
    // automatically -- it always opens above the (empty) list. One sentence
    // is kept; `cast-panel.test.ts`'s own "control" test above already
    // pins its wording and position.
    const r = rig([]);
    await r.panel.open();

    expect(present("cast-sheet-empty")).toBe(false);
    expect(el("cast-sheet-record").hidden).toBe(true);
    expect(el<HTMLElement>("cast-new-row").hidden).toBe(false);
  });

  test("with members and none selected, the sheet shows nothing at all", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();

    expect(el("cast-sheet").hidden).toBe(true);
  });

  test("a member with no picture shows the image glyph and an Add-a-picture text button", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();

    expect(present("cast-picture-full")).toBe(false);
    expect(present("cast-sheet-picture-add")).toBe(true);
    expect(el("cast-sheet-picture-add").textContent).toBe("Add a picture…");
  });

  test("a present picture is the clickable square, and clicking it views full size", async () => {
    const r = rig([member({ id: "a", name: "Ilse", picture_path: "a.jpg" })]);
    r.views.set("a", { state: "present", data_uri: "data:image/png;base64,QUJD" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();

    expect(present("cast-sheet-picture-add")).toBe(false);
    el("cast-picture-full").click();
    await settle();

    expect(r.fulls).toEqual(["a"]);
    expect(r.shown).toEqual([
      { dataUri: "data:image/png;base64,FULL", label: "Picture of Ilse" },
    ]);
  });

  test("choosing a picture from the sheet works without entering Edit", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    r.picked = member({ id: "a", name: "Ilse", picture_path: "new.jpg" });
    await r.panel.open();
    entryNamed("Ilse").click();
    await settle();

    el("cast-sheet-picture-add").click();
    await settle();

    expect(r.picks).toEqual(["a"]);
    expect(el("cast-panel").dataset.mode).toBe("read");
    expect(present("cast-picture-full")).toBe(true);
  });

  test("keyboard focus on the selected entry survives the repaint", async () => {
    // `select` ends in `paintEntries`, which rebuilds every entry button --
    // including the one the writer just activated with the keyboard. Without
    // restoring focus onto its replacement, it falls to <body>, and the
    // panel's own Escape handler stops hearing anything.
    const r = rig([
      member({ id: "a", name: "Ilse" }),
      member({ id: "b", name: "Zoya" }),
    ]);
    await r.panel.open();
    const ilse = entryNamed("Ilse");
    ilse.focus();
    ilse.click();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe("Ilse");
  });

  test("a repaint NOT driven by the list leaves focus wherever it already was", async () => {
    // The other half of the rule above: a reload triggered by something else
    // (here, choosing a picture, which reloads the whole list) must not go
    // hunting for an entry to focus when the writer's keyboard was never in
    // the list to begin with. Picture, not Save: a successful Save moves
    // focus to #cast-edit on its own (the Escape-after-Save
    // fix), which would make this test assert the wrong thing for the wrong
    // reason.
    const r = rig([member({ id: "a", name: "Ilse" })]);
    r.picked = member({ id: "a", name: "Ilse", picture_path: "new.jpg" });
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    const summary = el<HTMLTextAreaElement>("cast-summary");
    summary.focus();

    el<HTMLButtonElement>("cast-picture-choose").click();
    await settle();

    expect(document.activeElement).toBe(summary);
  });

  test("every cast entry's kind glyph is aria-hidden and does not join the accessible name", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();

    const icon = document.querySelector(".cast-entry-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(entryNamed("Ilse").textContent).toBe("Ilse");
  });

  test("the foot-of-list Add… toggle reveals the new-entry row in place", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();

    expect(el<HTMLElement>("cast-new-row").hidden).toBe(true);
    const toggle = document.getElementById("cast-new-toggle");
    expect(toggle).not.toBeNull();

    toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(el<HTMLElement>("cast-new-row").hidden).toBe(false);
    expect(document.activeElement).toBe(el("cast-new-name"));
  });

  test("a successful Add closes the row again", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    document.getElementById("cast-new-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    type(el<HTMLInputElement>("cast-new-name"), "Zoya");

    el<HTMLButtonElement>("cast-new").click();
    await settle();

    expect(el<HTMLElement>("cast-new-row").hidden).toBe(true);
  });

  test("Escape over an open, closable add row collapses the row and leaves the panel open", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    document.getElementById("cast-new-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Cancelable, as a real key event is: the row's collapse claims the key by
    // preventDefault, and that is what tells the shell not to close as well.
    el("cast-panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(r.panel.isOpen()).toBe(true);
    expect(r.dismissals).toBe(0);
    expect(el<HTMLElement>("cast-new-row").hidden).toBe(true);
  });

  test("Escape over the always-open row of an empty cast still closes the whole panel", async () => {
    const r = rig([]);
    await r.panel.open();
    expect(el<HTMLElement>("cast-new-row").hidden).toBe(false);

    el("cast-panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(r.panel.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);
  });
});

describe("aliases (105, \"including aliases\")", () => {
  test("the sheet shows Also called, and hides it when there are none", async () => {
    const r = rig([
      member({ id: "a", name: "Marisol Quillfeather", aliases: ["Quill", "Marisol"] }),
      member({ id: "b", name: "Ada" }),
    ]);
    await r.panel.open();

    entryNamed("Marisol Quillfeather").click();
    expect(el("cast-sheet-aliases").hidden).toBe(false);
    expect(el("cast-sheet-aliases").textContent).toContain("Quill, Marisol");

    entryNamed("Ada").click();
    expect(el("cast-sheet-aliases").hidden).toBe(true);
  });

  test("Edit shows one alias row per stored alias, plus one blank row to type into", async () => {
    const r = rig([member({ id: "a", name: "Ilse", aliases: ["Ils"] })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();

    expect(aliasRows().map((i) => i.value)).toEqual(["Ils", ""]);
  });

  test("saving sends every alias row, blank trailing row included", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();

    type(aliasRows()[0]!, "Ils");
    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(r.saves).toHaveLength(1);
    expect(r.saves[0]!.aliases).toEqual(["Ils"]);
  });

  test("a stored alias round-trips into the reopened form", async () => {
    const r = rig([member({ id: "a", name: "Ilse", aliases: ["Ils", "Els"] })]);
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();

    expect(aliasRows().map((i) => i.value)).toEqual(["Ils", "Els", ""]);
  });

  for (const [code, key, alias] of [
    ["alias_too_short", "cast.alias.short", "Il"],
    ["alias_is_name", "cast.alias.same-as-name", "Ilse"],
    ["alias_repeated", "cast.alias.repeated", "Ils"],
  ] as const) {
    test(`MUTATION TARGET: a ${code} refusal surfaces its own sentence, not the generic save notice`, async () => {
      const r = rig([member({ id: "a", name: "Ilse" })]);
      // THE WIRE SHAPE ITSELF, `cast_set_wire_error`'s own contract --
      // a bare JSON string, exactly what a real command rejection is.
      r.saveError = JSON.stringify({ code, alias });
      await r.panel.open();
      entryNamed("Ilse").click();
      el<HTMLButtonElement>("cast-edit").click();
      type(aliasRows()[0]!, alias);

      el<HTMLButtonElement>("cast-save").click();
      await settle();

      // ASSERTED AGAINST THE CATALOG FUNCTION, not a copy of its English --
      // classified by CODE, so a rewrite of the sentence cannot silently
      // degrade this to the generic notice the way a regex over prose did.
      expect(r.notices).toEqual([t(key, { alias })]);
      // The panel stays open with the writer's draft, `cast.error.save`'s
      // own rule for any failed save.
      expect(r.panel.isOpen()).toBe(true);
      expect(aliasRows()[0]!.value).toBe(alias);
    });
  }

  test("the structured command boundary preserves the typed alias refusal and draft", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    r.saveError = new HostCommandError("cast_set", { version: 1, code: "operation_failed", operation: "cast_set", detail: JSON.stringify({ code: "alias_too_short", alias: "Il" }) });
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();
    type(aliasRows()[0]!, "Il");
    el<HTMLButtonElement>("cast-save").click();
    await settle();
    expect(r.notices).toEqual([t("cast.alias.short", { alias: "Il" })]);
    expect(aliasRows()[0]!.value).toBe("Il");
  });

  test("an unrecognized code falls through to the generic notice", async () => {
    // Neither a parse failure NOR one of the three known codes: the boundary
    // between "the host sent an alias refusal" and "the host sent something
    // else that happens to be JSON".
    const r = rig([member({ id: "a", name: "Ilse" })]);
    r.saveError = JSON.stringify({ code: "something_else", alias: "Ils" });
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();

    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(r.notices[0]).toContain("Could not save");
  });

  test("a generic save failure still gets the ordinary notice", async () => {
    const r = rig([member({ id: "a", name: "Ilse" })]);
    r.fail.save = true;
    await r.panel.open();
    entryNamed("Ilse").click();
    el<HTMLButtonElement>("cast-edit").click();

    el<HTMLButtonElement>("cast-save").click();
    await settle();

    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("Could not save");
  });
});
