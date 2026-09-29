import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createDesignPanel, type DesignPanel, type DesignTransferPreview } from "../src/design-panel";
import type { BookDesign, BookDesignView } from "../src/book-design";
import { EN } from "../src/i18n";

const FICTION: BookDesign = {
  font: "Crimson Text",
  page: { width_um: 152_400, height_um: 228_600, name: "trade" },
  margins: { inner_um: 19_050, outer_um: 15_875, top_um: 15_875, bottom_um: 19_050 },
};

const NON_FICTION: BookDesign = {
  font: "Source Serif 4",
  page: { width_um: 177_800, height_um: 254_000, name: "large" },
  margins: { inner_um: 22_225, outer_um: 19_050, top_um: 19_050, bottom_um: 22_225 },
};

function view(design: BookDesign): BookDesignView {
  return {
    design,
    fonts: ["Crimson Text", "EB Garamond", "Libre Baskerville", "Source Serif 4"],
    page_sizes: [
      { name: "digest", width_um: 139_700, height_um: 215_900 },
      { name: "a5", width_um: 148_000, height_um: 210_000 },
      { name: "trade", width_um: 152_400, height_um: 228_600 },
      { name: "large", width_um: 177_800, height_um: 254_000 },
    ],
    presets: [
      { id: "fiction", design: FICTION },
      { id: "non-fiction", design: NON_FICTION },
    ],
  };
}

interface Rig {
  panel: DesignPanel;
  container: HTMLElement;
  reads: () => number;
  writes: () => BookDesign[];
  notices: () => string[];
  dones: () => string[];
  dismissals: () => number;
  el: (id: string) => HTMLElement | null;
  button: (kind: string, value: string) => HTMLButtonElement;
  unit: (value: "mm" | "in") => HTMLButtonElement;
  field: (axis: string) => HTMLInputElement;
}

interface Options {
  read?: () => Promise<BookDesignView>;
  write?: (design: BookDesign) => Promise<BookDesign>;
  exportDesign?: () => Promise<string | null>;
  previewDesign?: () => Promise<DesignTransferPreview | null>;
  applyDesign?: (token: string) => Promise<DesignTransferPreview>;
}

let open: Rig | null = null;

function mount(options: Options = {}): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  let reads = 0;
  const writes: BookDesign[] = [];
  const notices: string[] = [];
  const dones: string[] = [];
  let dismissals = 0;
  const panel = createDesignPanel({
    container,
    read: () => {
      reads++;
      return options.read?.() ?? Promise.resolve(view(FICTION));
    },
    write: (design) => {
      writes.push(design);
      return options.write?.(design) ?? Promise.resolve(design);
    },
    exportDesign: () => options.exportDesign?.() ?? Promise.resolve(null),
    previewDesign: () => options.previewDesign?.() ?? Promise.resolve(null),
    applyDesign: (token) => options.applyDesign?.(token) ?? Promise.reject(new Error("no design preview")),
    onDone: (message) => dones.push(message),
    onNotice: (m) => notices.push(m),
    onDismiss: () => {
      dismissals++;
    },
  });
  const rig: Rig = {
    panel,
    container,
    reads: () => reads,
    writes: () => [...writes],
    notices: () => [...notices],
    dones: () => [...dones],
    dismissals: () => dismissals,
    el: (id) => container.querySelector<HTMLElement>(`#${id}`),
    button: (kind, value) => {
      const all = [...container.querySelectorAll<HTMLButtonElement>(`[data-design-kind="${kind}"]`)];
      const b = all.find((el) => el.dataset.designValue === value);
      if (b === undefined) throw new Error(`no ${kind} button for ${value}`);
      return b;
    },
    unit: (value) => {
      const button = container.querySelector<HTMLButtonElement>(`#design-margin-unit-${value}`);
      if (button === null) throw new Error(`no ${value} unit button`);
      return button;
    },
    field: (axis) => {
      const f = container.querySelector<HTMLInputElement>(`#design-margin-${axis}`);
      if (f === null) throw new Error(`no field for ${axis}`);
      return f;
    },
  };
  open = rig;
  return rig;
}

afterEach(() => {
  open?.panel.destroy();
  open?.container.remove();
  open = null;
});

describe("the book design panel", () => {
  test("a salvage design is reviewed before an explicit apply", async () => {
    const tokens: string[] = [];
    const preview: DesignTransferPreview = {
      source: "salvage",
      token: "fresh-preview",
      changes: [{ field: "font", before: "Crimson Text", after: "EB Garamond" }],
      skipped: [{ field: "glyph", reason: "unknown_ornament" }],
    };
    const r = mount({
      previewDesign: async () => preview,
      applyDesign: async (token) => { tokens.push(token); return preview; },
    });
    await r.panel.open();
    const apply = r.container.querySelector<HTMLButtonElement>("[data-design-transfer='apply']")!;
    expect(apply.hidden).toBe(true);
    r.container.querySelector<HTMLButtonElement>("[data-design-transfer='preview']")!.click();
    await Promise.resolve();
    await Promise.resolve();
    // One sentence per setting, in a list (239), never an arrow log line.
    const lines = [...r.el("design-transfer-review")!.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual([
      "Body font will change from Crimson Text to EB Garamond.",
      "Chapter ornament will stay as it is: unknown ornament.",
    ]);
    expect(apply.hidden).toBe(false);
    apply.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(tokens).toEqual(["fresh-preview"]);
    expect(r.dones()).toContain(EN["design.transfer.applied"]);
    expect(apply.hidden).toBe(true);
  });
  test("the transfer review describes measurements and choices rather than stored codes", async () => {
    const r = mount({
      previewDesign: async () => ({
        source: "book-design", token: "labels", skipped: [],
        changes: [
          { field: "font", before: "Author's Serif", after: "EB Garamond" },
          { field: "page", before: "160000x240000 custom-trim", after: "152400x228600 trade" },
          { field: "margins", before: null, after: "19050,15875,15875,19050" },
          { field: "chapter", before: "", after: "new-page caps-title drop-cap" },
          { field: "glyph", before: "unlisted", after: "fleuron" },
          { field: "cover_fit_front", before: "contain", after: "fill" },
        ],
      }),
    });
    await r.panel.open();
    r.container.querySelector<HTMLButtonElement>("[data-design-transfer='preview']")!.click();
    await settle();
    const text = r.el("design-transfer-review")?.textContent ?? "";
    expect(text).toContain("Author's Serif");
    expect(text).toContain("Custom size (custom-trim): 160 x 240 mm");
    expect(text).toContain("Trade (6 x 9 in): 152.4 x 228.6 mm");
    expect(text).toContain("Inner 19.05 mm");
    expect(text).toContain("Outer 15.875 mm");
    expect(text).toContain("No chapter options");
    expect(text).toContain("New page for parts and chapters");
    expect(text).toContain("Book-body headings in capitals");
    expect(text).toContain("Fleuron");
    expect(text).toContain("Chapter ornament will change from a setting this version cannot read to Fleuron.");
    expect(text).toContain("Margins will change from the default to");
    expect(text).not.toContain("→");
    expect(text).toContain("Fill page (crop edges)");
    expect(text).not.toContain("19050,15875");
    expect(text).not.toContain("caps-title");
  });
  test("a post-apply read failure reports refresh without calling the transfer failed", async () => {
    const preview: DesignTransferPreview = {
      source: "book-design", token: "reviewed", changes: [{ field: "font", before: null, after: "EB Garamond" }], skipped: [],
    };
    let reads = 0;
    const r = mount({
      read: async () => {
        reads++;
        if (reads === 1) return view(FICTION);
        throw new Error("read failed");
      },
      previewDesign: async () => preview,
      applyDesign: async () => preview,
    });
    await r.panel.open();
    r.container.querySelector<HTMLButtonElement>("[data-design-transfer='preview']")!.click();
    await settle();
    r.container.querySelector<HTMLButtonElement>("[data-design-transfer='apply']")!.click();
    await settle();
    expect(r.dones()).toContain(EN["design.transfer.applied"]);
    expect(r.notices().some((notice) => notice.includes("could not refresh"))).toBe(true);
    expect(r.notices().some((notice) => notice.includes("Could not move the book design"))).toBe(false);
  });
  test("it reads the open book on EVERY open", async () => {
    // What makes this panel per-book without a repaint hook. The preferences
    // panel is mounted once and needs `setDictionary` for its one per-project
    // group; this one cannot be showing a book it is not about.
    const rig = mount();
    await rig.panel.open();
    rig.panel.close();
    await rig.panel.open();
    expect(rig.reads()).toBe(2);
  });

  test("it paints what the host says the book is", async () => {
    const rig = mount();
    await rig.panel.open();
    expect(rig.button("font", "Crimson Text").getAttribute("aria-pressed")).toBe("true");
    expect(rig.button("font", "EB Garamond").getAttribute("aria-pressed")).toBe("false");
    expect((rig.el("design-page-select") as HTMLSelectElement).value).toBe("trade");
    expect(rig.button("preset", "fiction").getAttribute("aria-pressed")).toBe("true");
    expect(rig.button("preset", "non-fiction").getAttribute("aria-pressed")).toBe("false");
    expect(rig.field("inner").value).toBe("19.05");
    expect(rig.field("bottom").value).toBe("19.05");
    expect(rig.field("outer").value).toBe("15.875");
    expect(rig.field("inner").nextElementSibling?.textContent).toBe("mm");
    expect(rig.unit("mm").getAttribute("aria-label")).toBe("Millimetres");
    expect(rig.unit("in").getAttribute("aria-label")).toBe("Inches");
  });

  test("a page size no button names lights no button and still says what it measures", async () => {
    // The reason the readout is painted unconditionally. A stored design can
    // hold measurements this build has no word for -- another build wrote it,
    // or a later slice offers more sizes -- and a panel that showed nothing at
    // all there would be a panel that lies about the book by omission.
    const custom: BookDesign = {
      ...FICTION,
      page: { width_um: 160_000, height_um: 240_000, name: null },
    };
    const rig = mount({ read: () => Promise.resolve(view(custom)) });
    await rig.panel.open();
    expect((rig.el("design-page-select") as HTMLSelectElement).value).toBe("");
    const readout = rig.el("design-page-readout")?.textContent ?? "";
    expect(readout).toContain("160");
    expect(readout).toContain("240");
  });

  test("a design that is not a preset lights no preset", async () => {
    // The preset buttons are compared BY VALUE, so nothing has to be kept in
    // step: press Fiction, widen the gutter, and a stored preset name would go
    // on claiming Fiction.
    const widened: BookDesign = {
      ...FICTION,
      margins: { ...FICTION.margins, inner_um: 25_400 },
    };
    const rig = mount({ read: () => Promise.resolve(view(widened)) });
    await rig.panel.open();
    expect(rig.button("preset", "fiction").getAttribute("aria-pressed")).toBe("false");
    expect(rig.button("preset", "non-fiction").getAttribute("aria-pressed")).toBe("false");
  });

  test("pressing a preset writes the WHOLE design", async () => {
    const rig = mount();
    await rig.panel.open();
    rig.button("preset", "non-fiction").click();
    await settle();
    expect(rig.writes()).toEqual([NON_FICTION]);
    expect(rig.button("preset", "non-fiction").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("inner").value).toBe("22.225");
  });

  test("pressing a font changes the font and nothing else", async () => {
    const rig = mount();
    await rig.panel.open();
    rig.button("font", "EB Garamond").click();
    await settle();
    expect(rig.writes()).toEqual([{ ...FICTION, font: "EB Garamond" }]);
  });

  test("pressing a page size sends the measurements as well as the name", async () => {
    // The name is a label. A build that sent the name alone would leave the
    // stored measurements at whatever they were, and the readout would then
    // disagree with the pressed button.
    const rig = mount();
    await rig.panel.open();
    const select = rig.el("design-page-select") as HTMLSelectElement;
    select.value = "a5";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(rig.writes()).toEqual([
      { ...FICTION, page: { width_um: 148_000, height_um: 210_000, name: "a5" } },
    ]);
  });

  test("a margin the writer typed is committed in micrometres when they leave the field", async () => {
    const rig = mount();
    await rig.panel.open();
    const field = rig.field("top");
    field.value = "20";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(rig.writes()).toEqual([
      { ...FICTION, margins: { ...FICTION.margins, top_um: 20_000 } },
    ]);
  });

  test("a margin retyped to the value it already had is not a write", async () => {
    // Leaving a field is not asking for anything. A round trip per blur would
    // put a store write on moving the caret.
    const rig = mount();
    await rig.panel.open();
    const field = rig.field("top");
    field.value = "15.875";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(rig.writes()).toEqual([]);
  });

  test("inches retain odd micrometres through repeated switches and unchanged blur", async () => {
    const odd = { ...FICTION, margins: { ...FICTION.margins, top_um: 19_051 } };
    const rig = mount({ read: () => Promise.resolve(view(odd)) });
    await rig.panel.open();
    rig.unit("in").click();
    expect(rig.unit("in").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("top").value).toBe("0.75004");
    expect(rig.field("top").nextElementSibling?.textContent).toBe("in");
    rig.unit("mm").click();
    rig.unit("in").click();
    rig.field("top").dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(rig.writes()).toEqual([]);
  });

  test("a unit switch converts all drafts without writing", async () => {
    const rig = mount();
    await rig.panel.open();
    rig.field("inner").value = "20";
    rig.field("outer").value = "16";
    rig.unit("in").click();
    expect(rig.field("inner").value).toBe("0.7874");
    expect(rig.field("outer").value).toBe("0.62992");
    expect(rig.writes()).toEqual([]);
  });

  test("a primary unit mousedown preserves a focused valid draft for conversion", async () => {
    const rig = mount();
    await rig.panel.open();
    const field = rig.field("inner");
    field.value = "20";
    field.focus();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    rig.unit("in").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    if (!down.defaultPrevented) field.dispatchEvent(new Event("change", { bubbles: true }));
    rig.unit("in").click();
    expect(rig.field("inner").value).toBe("0.7874");
    expect(rig.writes()).toEqual([]);
  });

  test("an invalid draft preserves every field and the selected unit", async () => {
    const rig = mount();
    await rig.panel.open();
    rig.field("outer").value = "wide-ish";
    const before = [...["inner", "outer", "top", "bottom"]].map((axis) => rig.field(axis).value);
    rig.unit("in").click();
    expect(["inner", "outer", "top", "bottom"].map((axis) => rig.field(axis).value)).toEqual(before);
    expect(rig.unit("mm").getAttribute("aria-pressed")).toBe("true");
    expect(rig.notices()[0]).toContain("millimetres");
  });

  test("a primary unit mousedown keeps a focused invalid draft literal", async () => {
    const rig = mount();
    await rig.panel.open();
    const field = rig.field("outer");
    field.value = "wide-ish";
    field.focus();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    rig.unit("in").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    if (!down.defaultPrevented) field.dispatchEvent(new Event("change", { bubbles: true }));
    rig.unit("in").click();
    expect(field.value).toBe("wide-ish");
    expect(rig.unit("mm").getAttribute("aria-pressed")).toBe("true");
  });

  test("a unit click before the initial design read is ignored", async () => {
    const held: { resolve: ((answer: BookDesignView) => void) | null } = { resolve: null };
    const rig = mount({ read: () => new Promise<BookDesignView>((resolve) => (held.resolve = resolve)) });
    const opening = rig.panel.open();
    rig.unit("in").click();
    expect(rig.notices()).toEqual([]);
    expect(rig.writes()).toEqual([]);
    if (held.resolve === null) throw new Error("the read was never called");
    held.resolve(view(FICTION));
    await opening;
    expect(rig.unit("mm").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("inner").value).toBe("19.05");
  });

  test("a pending millimetre write repaints in inches without another write", async () => {
    const held: { resolve: ((design: BookDesign) => void) | null } = { resolve: null };
    const rig = mount({
      write: () => new Promise<BookDesign>((resolve) => (held.resolve = resolve)),
    });
    await rig.panel.open();
    rig.field("inner").value = "20";
    rig.field("inner").dispatchEvent(new Event("change", { bubbles: true }));
    expect(rig.writes()).toHaveLength(1);
    rig.unit("in").click();
    if (held.resolve === null) throw new Error("the write was never called");
    held.resolve({ ...FICTION, margins: { ...FICTION.margins, inner_um: 20_000 } });
    await settle();
    expect(rig.unit("in").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("inner").value).toBe("0.7874");
    expect(rig.writes()).toHaveLength(1);
  });

  test("a preset success retains inches and repaints its margins", async () => {
    const rig = mount();
    await rig.panel.open();
    rig.unit("in").click();
    rig.button("preset", "non-fiction").click();
    await settle();
    expect(rig.unit("in").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("inner").value).toBe("0.875");
  });

  test("a refused preset retains inches and the stored margins", async () => {
    const rig = mount({ write: () => Promise.reject(new Error("refused")) });
    await rig.panel.open();
    rig.unit("in").click();
    rig.button("preset", "non-fiction").click();
    await settle();
    expect(rig.unit("in").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("inner").value).toBe("0.75");
  });

  test("inches stay selected when the mounted panel closes and reopens", async () => {
    const rig = mount();
    await rig.panel.open();
    rig.unit("in").click();
    rig.panel.close();
    await rig.panel.open();
    expect(rig.unit("in").getAttribute("aria-pressed")).toBe("true");
    expect(rig.field("inner").value).toBe("0.75");
  });

  test("a margin that is not a measurement is refused, said, and put back", async () => {
    const rig = mount();
    await rig.panel.open();
    const field = rig.field("outer");
    field.value = "wide-ish";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(rig.writes()).toEqual([]);
    expect(rig.notices()).toEqual([
      (EN["design.error.margin.unit"] ?? "").replace("{typed}", "wide-ish").replace("{unit}", "millimetres"),
    ]);
    // PUT BACK, not left showing a value the file does not hold.
    expect(field.value).toBe("15.875");
  });

  test("a refused write leaves the panel showing what the file still holds", async () => {
    // The opposite of the preferences panel's rule, and the difference is real:
    // a refused preference still applies in this window, and a refused design
    // applies nowhere at all.
    const rig = mount({ write: () => Promise.reject(new Error("the side margins leave no width")) });
    await rig.panel.open();
    const field = rig.field("inner");
    field.value = "900";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(field.value).toBe("19.05");
    expect(rig.notices()).toEqual([
      (EN["design.error.save"] ?? "").replace("{error}", "the side margins leave no width"),
    ]);
  });

  test("a host that cannot answer is said, not painted as a book with no design", async () => {
    // The recorded `renderImports([])` defect: a catch that renders the designed
    // empty state reports a failure as an answer.
    const rig = mount({ read: () => Promise.reject(new Error("no project is open")) });
    await rig.panel.open();
    expect(rig.notices()).toEqual([
      (EN["design.error.load"] ?? "").replace("{error}", "no project is open"),
    ]);
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.el("design-page-readout")?.textContent).toBe("");
  });

  test("an answer landing after the panel closed does not paint it", async () => {
    // A RECORD rather than a bare `let`: a local assigned only inside a closure
    // narrows to `null` for the rest of the file, and the call below would then
    // type-check against `never` while asserting nothing. Recorded hazard.
    const held: { release: ((v: BookDesignView) => void) | null } = { release: null };
    const rig = mount({
      read: () => new Promise<BookDesignView>((resolve) => (held.release = resolve)),
    });
    const opening = rig.panel.open();
    rig.panel.close();
    if (held.release === null) throw new Error("the read was never called");
    held.release(view(NON_FICTION));
    await opening;
    await settle();
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.el("design-page-readout")?.textContent).toBe("");
  });

  test("Escape closes it and hands focus back", async () => {
    const rig = mount();
    await rig.panel.open();
    const panel = rig.el("design-panel");
    panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.dismissals()).toBe(1);
  });

  test("there is no Save control on it at all", async () => {
    // NOT an omission. Every control here IS the save, exactly as the
    // preferences panel's are, and a Save on a panel whose changes have already
    // landed is a control a writer has to learn does nothing -- the recorded
    // defect found by looking at a capture of the appearances panel.
    const rig = mount();
    await rig.panel.open();
    const labels = [...rig.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.toLowerCase()).not.toContain("save");
    expect(rig.container.querySelector('[data-weight="primary"]')).toBeNull();
  });

  test("nothing it does touches the document root", async () => {
    // THE RULE THIS SLICE EXISTS NOT TO BREAK. `applyTypography` writes on the
    // live editor root; a book's page size must never reach the element the
    // writer is typing into. Compared as a whole attribute list, so a NEW
    // attribute is caught as well as a changed one.
    const before = [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`);
    const rig = mount();
    await rig.panel.open();
    rig.button("preset", "non-fiction").click();
    rig.button("font", "EB Garamond").click();
    const select = rig.el("design-page-select") as HTMLSelectElement;
    select.value = "a5";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect([...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`)).toEqual(before);
  });
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
