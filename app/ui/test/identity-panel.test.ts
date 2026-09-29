import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createIdentityPanel, type IdentityPanel } from "../src/identity-panel";
import {
  PRIVATE_FIELDS,
  PUBLIC_FIELDS,
  PUBLISHING_FIELDS,
  blankIdentity,
  type IdentitiesView,
  type Identity,
} from "../src/identity";
import { EN } from "../src/i18n";

function identity(id: string, name: string): Identity {
  const next = blankIdentity();
  next.id = id;
  next.rev = 1;
  next.public.name = name;
  return next;
}

function view(over: Partial<IdentitiesView> = {}): IdentitiesView {
  return { identities: [identity("i1", "Ada Vane")], pinned: null, stale: false, ...over };
}

interface Rig {
  panel: IdentityPanel;
  container: HTMLElement;
  answer: IdentitiesView | "fail";
  /** Exactly what each command was handed, so a payload the page composed is
   *  visible rather than inferred. */
  saved: Identity[];
  pinned: unknown[];
  previews: string[];
  unreadablePreview: boolean;
  unpinned: number;
  removed: string[];
  checks: number;
  notices: string[];
  dones: string[];
  dismissed: number;
  teardown(): void;
}

function mount(): Rig {
  const container = document.createElement("span");
  document.body.append(container);
  const rig: Partial<Rig> & { container: HTMLElement } = {
    container,
    answer: view(),
    saved: [],
    pinned: [],
    previews: [],
    unreadablePreview: false,
    unpinned: 0,
    removed: [],
    checks: 0,
    notices: [],
    dones: [],
    dismissed: 0,
  };
  const answer = async (): Promise<IdentitiesView> => {
    if (rig.answer === "fail") throw new Error("boom");
    return rig.answer as IdentitiesView;
  };
  rig.panel = createIdentityPanel({
    container,
    read: answer,
    save: async (identity) => {
      rig.saved?.push(identity);
      return await answer();
    },
    remove: async (id) => {
      rig.removed?.push(id);
      return await answer();
    },
    previewPin: async (id) => {
      rig.previews?.push(id);
      const answerView = await answer();
      const chosen = answerView.identities.find((item) => item.id === id);
      if (chosen === undefined) throw new Error("missing identity");
      return {
        token: "host-preview-token",
        before: rig.unreadablePreview ? null : answerView.pinned,
        before_unreadable: rig.unreadablePreview ?? false,
        after: { identity_id: id, rev: chosen.rev, pinned_at: 0,
          public: chosen.public, publishing: chosen.publishing },
      };
    },
    pin: async (id, token) => {
      rig.pinned?.push([id, token]);
      return await answer();
    },
    unpin: async () => {
      rig.unpinned = (rig.unpinned ?? 0) + 1;
      return await answer();
    },
    showChecks: () => {
      rig.checks = (rig.checks ?? 0) + 1;
    },
    onDone: (m) => rig.dones?.push(m),
    onNotice: (m) => rig.notices?.push(m),
    onDismiss: () => {
      rig.dismissed = (rig.dismissed ?? 0) + 1;
    },
  });
  rig.teardown = (): void => {
    rig.panel?.destroy();
    container.remove();
  };
  return rig as Rig;
}

let live: Rig | null = null;
afterEach(() => {
  live?.teardown();
  live = null;
});

function click(rig: Rig, selector: string): void {
  const node = rig.container.querySelector<HTMLElement>(selector);
  expect({ selector, found: node !== null }).toEqual({ selector, found: true });
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("the pen names panel", () => {
  test("it paints the library and what this book is written as", async () => {
    const rig = (live = mount());
    rig.answer = view({
      identities: [identity("i1", "Ada Vane"), identity("i2", "Bram Kell")],
      pinned: {
        identity_id: "i2",
        rev: 1,
        pinned_at: 10,
        public: { name: "Bram Kell", sort_name: "", bio: "", links: [] },
        publishing: { imprint: "", rights: "" },
      },
    });
    await rig.panel.open();
    const rows = rig.container.querySelectorAll(".identity-row");
    expect(rows.length).toBe(2);
    expect(rig.container.querySelector("#identity-pinned")?.textContent).toContain("Bram Kell");
    // THE PINNED ROW SAYS SO THROUGH `aria-pressed`, which is what the sixth
    // stylesheet list keys on -- a state announced to a screen reader and
    // invisible to everyone else is the defect the design panel shipped with.
    const pressed = [...rig.container.querySelectorAll("[aria-pressed]")].map((n) =>
      n.getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["false", "true"]);
  });

  test("a book pinned to nothing still gets a line saying so", async () => {
    const rig = (live = mount());
    await rig.panel.open();
    expect(rig.container.querySelector("#identity-pinned")?.textContent).toBe(
      EN["identity.unpinned"],
    );
    expect(rig.container.querySelector<HTMLElement>("#identity-stale")?.hidden).toBe(true);
  });

  test("staleness is shown and is not the same line as the pin", async () => {
    const rig = (live = mount());
    rig.answer = view({
      pinned: {
        identity_id: "i1",
        rev: 1,
        pinned_at: 10,
        public: { name: "Ada Vane", sort_name: "", bio: "", links: [] },
        publishing: { imprint: "", rights: "" },
      },
      stale: true,
    });
    await rig.panel.open();
    const stale = rig.container.querySelector<HTMLElement>("#identity-stale");
    expect(stale?.hidden).toBe(false);
    expect(stale?.textContent).toBe(EN["identity.stale"]);
  });

  test("pinning requires preview and passes only its token and identity ID", async () => {
    // THE CONTAINMENT, ASSERTED ON THE WIRE. The rule, one surface further in:
    // a page-composed pin is a page-composed BYLINE, and the whole guarantee of
    // this feature is that what travels inside a project file came from the
    // vault's own public and publishing tiers. The host reads the identity out
    // of the vault itself.
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='pin']");
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.previews).toEqual(["i1"]);
    expect(rig.pinned).toEqual([]);
    expect(rig.container.querySelector("#identity-pin-preview")?.textContent).toContain("Ada Vane");
    click(rig, "[data-identity-action='confirm-pin']");
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.pinned).toEqual([["i1", "host-preview-token"]]);
    // No public, publishing, alias or private tier crosses as an input.
  });

  test("canceling a pin preview leaves the book unchanged", async () => {
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='pin']");
    await Promise.resolve();
    await Promise.resolve();
    click(rig, "[data-identity-action='cancel-pin']");
    expect(rig.pinned).toEqual([]);
    expect(rig.container.querySelector<HTMLElement>("#identity-pin-preview")?.hidden).toBe(true);
  });

  test("a damaged current pin is identified before replacement", async () => {
    const rig = (live = mount());
    rig.unreadablePreview = true;
    await rig.panel.open();
    click(rig, "[data-identity-action='pin']");
    await Promise.resolve();
    await Promise.resolve();
    const preview = rig.container.querySelector("#identity-pin-preview");
    expect(preview?.textContent).toContain(EN["identity.preview.unreadable.value"]);
    expect(preview?.textContent).toContain(EN["identity.preview.unreadable"]);
    expect(preview?.querySelector("[data-identity-action='confirm-pin']")?.textContent)
      .toBe(EN["identity.preview.replace"]);
    expect(rig.pinned).toEqual([]);
  });

  test("a stale pin offers an explicit update with old and new fields", async () => {
    const rig = (live = mount());
    rig.answer = view({ pinned: {
      identity_id: "i1", rev: 1, pinned_at: 10,
      public: { name: "Old Ada", sort_name: "", bio: "Old bio", links: [] },
      publishing: { imprint: "Old Press", rights: "" },
    }, stale: true });
    await rig.panel.open();
    expect(rig.container.querySelector("[data-identity-action='unpin']")).not.toBeNull();
    expect(rig.container.querySelector("[data-identity-action='update-pin']")?.textContent).toBe(EN["identity.repin"]);
    click(rig, "[data-identity-action='update-pin']");
    await Promise.resolve();
    await Promise.resolve();
    const preview = rig.container.querySelector("#identity-pin-preview");
    expect(preview?.textContent).toContain("Old Ada");
    expect(preview?.textContent).toContain("Ada Vane");
    expect(preview?.textContent).toContain("Old Press");
    expect(rig.pinned).toEqual([]);
  });

  test("unpinning takes no argument at all", async () => {
    const rig = (live = mount());
    rig.answer = view({
      pinned: {
        identity_id: "i1",
        rev: 1,
        pinned_at: 10,
        public: { name: "Ada Vane", sort_name: "", bio: "", links: [] },
        publishing: { imprint: "", rights: "" },
      },
    });
    await rig.panel.open();
    click(rig, "[data-identity-action='unpin']");
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.unpinned).toBe(1);
    expect(rig.pinned).toEqual([]);
  });

  test("the form carries all three tiers, and the private one carries its sentence", async () => {
    // The private tier is EDITED here and travels nowhere. It is on this panel
    // because there is nowhere else a legal name can be typed; the sentence
    // beside it says it stays in this file and that the file is not encrypted.
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='edit']");
    for (const field of [...PUBLIC_FIELDS, ...PUBLISHING_FIELDS, ...PRIVATE_FIELDS]) {
      const node = rig.container.querySelector(`[data-identity-field='${field}']`);
      expect({ field, present: node !== null }).toEqual({ field, present: true });
    }
    const notes = [...rig.container.querySelectorAll(".identity-tier-note")].map(
      (n) => n.textContent,
    );
    expect(notes).toEqual([EN["identity.tier.aliases.note"], EN["identity.tier.private.note"]]);
  });

  test("Save sends what the fields hold, with the links split one per line", async () => {
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='edit']");
    const set = (field: string, value: string): void => {
      const node = rig.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-identity-field='${field}']`,
      );
      expect({ field, found: node !== null }).toEqual({ field, found: true });
      if (node !== null) node.value = value;
    };
    set("name", "Ada Vane");
    set("legal_name", "Margaret Hollis");
    set("imprint", "Vane Press");
    set("links", "https://a.invalid\n\nhttps://b.invalid\n");
    set("aliases", "Anne Grey\nB. Grey\n");
    click(rig, "[data-identity-action='save']");
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.saved.length).toBe(1);
    expect(rig.saved[0]?.public.name).toBe("Ada Vane");
    expect(rig.saved[0]?.publishing.imprint).toBe("Vane Press");
    expect(rig.saved[0]?.private.legal_name).toBe("Margaret Hollis");
    expect(rig.saved[0]?.public.links).toEqual(["https://a.invalid", "https://b.invalid"]);
    expect(rig.saved[0]?.aliases).toEqual(["Anne Grey", "B. Grey"]);
    // The id it was opened on, not one the page invented.
    expect(rig.saved[0]?.id).toBe("i1");
  });

  test("New opens a form whose id is empty, so the host mints one", async () => {
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='new']");
    click(rig, "[data-identity-action='save']");
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.saved.length).toBe(1);
    expect(rig.saved[0]?.id).toBe("");
  });

  test("typing into the form and dismissing sends nothing to the host", async () => {
    // WHAT THIS ASSERTS IS THE HOST CALL AND NOT THE ROW, and the difference was
    // found by a mutation. The panel edits the row object itself; a defensive
    // copy was written first and DELETED when a mutation replacing it with the
    // bare assignment survived the whole suite -- `readForm` spreads every tier
    // out of it and nothing assigns through it, so the copy could not change a
    // byte any input reaches. What protects the writer is that a dismissed form
    // is never read: no `identity_save` crosses.
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='edit']");
    const field = rig.container.querySelector<HTMLInputElement>("[data-identity-field='name']");
    if (field !== null) field.value = "Somebody Else";
    rig.container
      .querySelector("#identity-panel")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(rig.saved).toEqual([]);
    // And the form is gone, so a reopen paints from the host rather than from
    // what was typed into the last one.
    expect(rig.container.querySelector("#identity-form")?.childElementCount).toBe(0);
  });

  test("a vault that will not answer raises a notice and does NOT paint an empty library", async () => {
    // THE FAILURE THIS WHOLE SLICE IS ABOUT. A catch that painted the
    // no-pen-names state would report a vault that could not be parsed as a
    // library with nothing in it -- which is exactly the reading that makes the
    // cross-identity check pass by failing.
    const rig = (live = mount());
    rig.answer = "fail";
    await rig.panel.open();
    expect(rig.notices.length).toBe(1);
    expect(rig.notices[0]).toContain("boom");
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.container.querySelector("#identity-empty")).toBeNull();
    expect(rig.container.querySelectorAll(".identity-row").length).toBe(0);
  });

  test("an empty vault that answered IS painted as empty", async () => {
    // The control for the test above: "could not read" and "nothing in it" must
    // be two different pictures, and this is the one that is allowed to be
    // empty.
    const rig = (live = mount());
    rig.answer = view({ identities: [] });
    await rig.panel.open();
    expect(rig.container.querySelector("#identity-empty")?.textContent).toBe(
      EN["identity.list.empty"],
    );
    expect(rig.notices).toEqual([]);
  });

  test("the report is opened from here and this panel does not close to do it", async () => {
    const rig = (live = mount());
    await rig.panel.open();
    click(rig, "[data-identity-action='checks']");
    expect(rig.checks).toBe(1);
  });

  test("closing lets go of the vault it was shown", async () => {
    // A legal name held in a page variable for the life of the window, for a
    // panel nobody is looking at, is the thing this feature exists to prevent.
    const rig = (live = mount());
    await rig.panel.open();
    expect(rig.container.querySelectorAll(".identity-row").length).toBe(1);
    rig.panel.close();
    expect(rig.container.querySelectorAll(".identity-row").length).toBe(0);
    expect(rig.container.querySelector("#identity-form")?.childElementCount).toBe(0);
  });

  test("destroy takes the panel out of the page and unregisters its listener", async () => {
    const rig = (live = mount());
    await rig.panel.open();
    rig.panel.destroy();
    expect(rig.container.childElementCount).toBe(0);
    // A click on the document after destroy must reach nothing of this panel's.
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rig.notices).toEqual([]);
  });
});
