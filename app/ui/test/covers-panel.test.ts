import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createCoversPanel, type CoversPanel } from "../src/covers-panel";
import type { CoverCheck, CoverPicture, CoverSideView, CoversView } from "../src/covers";
import { EN } from "../src/i18n";

const TRADE = { width_um: 152400, height_um: 228600, name: "trade" };
const THUMB = "data:image/png;base64,THUMB";
const FULL = "data:image/png;base64,FULL";

function ok(): CoverCheck {
  return {
    width_px: 1800,
    height_px: 2700,
    dpi: 300,
    dpi_wanted: 300,
    wanted_width_px: 1800,
    wanted_height_px: 2700,
    low_resolution: false,
    wrong_shape: false,
    fit: "contain",
  };
}

function side(over: Partial<CoverSideView> = {}): CoverSideView {
  return { side: "front", view: { state: "none", data_uri: null }, check: null, fit: "contain", ...over };
}

function view(front: Partial<CoverSideView> = {}, back: Partial<CoverSideView> = {}): CoversView {
  return {
    page: TRADE,
    sides: [side({ ...front, side: "front" }), side({ ...back, side: "back" })],
  };
}

interface Rig {
  panel: CoversPanel;
  container: HTMLElement;
  answer: CoversView;
  /** What the dialog answers next: a view, or null for cancelled. */
  picked: CoversView | null | "fail";
  picks: string[];
  clears: string[];
  fits: Array<{ side: string; fit: string }>;
  full: CoverPicture | "fail";
  fulls: string[];
  shown: Array<{ dataUri: string; label: string }>;
  notices: string[];
  dones: string[];
  dismissals: number;
  failRead: boolean;
  /** Hold the next read open, so a test can act while it is in flight. */
  hold: { wait: Promise<void>; release: (() => void) | undefined } | null;
}

const rigs: Rig[] = [];

function rig(answer: CoversView = view()): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = {
    panel: undefined as unknown as CoversPanel,
    container,
    answer,
    picked: null,
    picks: [],
    clears: [],
    fits: [],
    full: { state: "present", data_uri: FULL },
    fulls: [],
    shown: [],
    notices: [],
    dones: [],
    dismissals: 0,
    failRead: false,
    hold: null,
  };
  r.panel = createCoversPanel({
    container,
    read: async () => {
      if (r.hold !== null) await r.hold.wait;
      if (r.failRead) throw new Error("could not read");
      return r.answer;
    },
    pick: async (s) => {
      r.picks.push(s);
      if (r.picked === "fail") throw new Error("that file is not a PNG or a JPEG");
      if (r.picked !== null) r.answer = r.picked;
      return r.picked;
    },
    clear: async (s) => {
      r.clears.push(s);
      r.answer = view();
      return r.answer;
    },
    setFit: async (side, fit) => {
      r.fits.push({ side, fit });
      r.answer = view({ fit: side === "front" ? fit as "fill" | "contain" : "contain" }, { fit: side === "back" ? fit as "fill" | "contain" : "contain" });
      return r.answer;
    },
    full: async (s) => {
      r.fulls.push(s);
      if (r.full === "fail") throw new Error("could not read it");
      return r.full;
    },
    showFullSize: (dataUri, label) => r.shown.push({ dataUri, label }),
    onNotice: (m) => r.notices.push(m),
    onDone: (m) => r.dones.push(m),
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

const panel = (): HTMLElement => document.getElementById("covers-panel") as HTMLElement;
const block = (s: string): HTMLElement =>
  document.querySelector(`.cover-side[data-cover-side="${s}"]`) as HTMLElement;
const control = (s: string, action: string): HTMLButtonElement | null =>
  document.querySelector(
    `[data-cover-side="${s}"][data-cover-action="${action}"]`,
  ) as HTMLButtonElement | null;

function gate(): { wait: Promise<void>; release: (() => void) | undefined } {
  const held: { wait: Promise<void>; release: (() => void) | undefined } = {
    wait: Promise.resolve(),
    release: undefined,
  };
  held.wait = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  return held;
}

describe("the covers panel", () => {
  test("it opens on both sides and says what page they are judged against", async () => {
    const r = rig();

    await r.panel.open();

    expect(r.panel.isOpen()).toBe(true);
    expect(block("front")).not.toBe(null);
    expect(block("back")).not.toBe(null);
    // PAINTED FOR EVERY BOOK: it is the only thing on the panel that says where
    // every figure below it came from.
    const line = document.getElementById("covers-page")?.textContent ?? "";
    expect(line).toContain("152.4");
    expect(line).toContain("228.6");
  });

  test("the PDF fit choice belongs to each side and lands before repaint", async () => {
    const r = rig();
    await r.panel.open();
    const front = block("front").querySelector<HTMLSelectElement>("[data-cover-fit-side='front']");
    expect(front?.value).toBe("contain");
    expect([...front!.options].map((option) => option.textContent)).toEqual([
      EN["covers.fit.option.contain"], EN["covers.fit.option.fill"],
    ]);
    expect(block("front").querySelector("[data-cover-fit-explanation='front']")?.textContent)
      .toBe(EN["covers.fit.explain.contain"]);
    front!.value = "fill";
    front!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(r.fits).toEqual([{ side: "front", fit: "fill" }]);
    expect(block("front").querySelector<HTMLSelectElement>("select")?.value).toBe("fill");
    expect(block("front").querySelector("[data-cover-fit-explanation='front']")?.textContent)
      .toBe(EN["covers.fit.explain.fill"]);
    expect(block("back").querySelector<HTMLSelectElement>("select")?.value).toBe("contain");
  });

  test("Fill page keeps its crop tradeoff visible when the image shape passes", async () => {
    const r = rig(view({
      view: { state: "present", data_uri: THUMB }, fit: "fill", check: { ...ok(), fit: "fill" },
    }));
    await r.panel.open();

    expect(block("front").querySelector("[data-cover-fit-explanation='front']")?.textContent)
      .toBe(EN["covers.fit.explain.fill"]);
    expect(block("front").querySelector(".cover-finding")?.textContent)
      .toContain("That suits it.");
  });

  test("a book with no covers offers Add on both sides and Remove on neither", async () => {
    // The empty state offers no control with nothing to act on -- the cast
    // panel's rule: a Remove that is disabled whenever there is nothing to
    // remove is a control a writer has to learn does nothing.
    const r = rig();

    await r.panel.open();

    for (const s of ["front", "back"]) {
      expect(control(s, "pick")?.textContent).toBe(EN["covers.choose"]);
      expect(control(s, "clear")).toBe(null);
      expect(control(s, "full")).toBe(null);
      expect(block(s).textContent).toContain(EN["covers.none"]);
    }
  });

  test("a cover that is there is drawn, and the control says Change", async () => {
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));

    await r.panel.open();

    const img = block("front").querySelector("img");
    expect(img?.getAttribute("src")).toBe(THUMB);
    expect(img?.getAttribute("alt")).toBe(EN["covers.alt.front"]);
    expect(control("front", "pick")?.textContent).toBe(EN["covers.replace"]);
    expect(control("front", "clear")).not.toBe(null);
    expect(control("front", "full")).not.toBe(null);
    // The other side is untouched by the first: a panel painting one answer
    // into both blocks would pass every assertion above.
    expect(block("back").querySelector("img")).toBe(null);
    expect(control("back", "clear")).toBe(null);
  });

  test("a cover whose file is gone keeps its claim and offers the repair", async () => {
    // A MISSING FILE DOES NOT CLEAR THE ROW -- one owner out: a
    // writer whose external drive is unmounted has not asked to forget that
    // their book had a cover. Remove is offered precisely here, because taking
    // the claim off IS the repair.
    const r = rig(view({ view: { state: "missing", data_uri: null } }));

    await r.panel.open();

    expect(block("front").textContent).toContain(EN["covers.missing"]);
    expect(control("front", "clear")).not.toBe(null);
    // And nothing to enlarge, because there is nothing to show.
    expect(control("front", "full")).toBe(null);
  });

  test("a cover this build has something to say about says it", async () => {
    const r = rig(
      view({
        view: { state: "present", data_uri: THUMB },
        check: { ...ok(), dpi: 150, low_resolution: true },
      }),
    );

    await r.panel.open();

    const findings = block("front").querySelectorAll(".cover-finding");
    expect(findings.length).toBe(1);
    expect(findings[0]?.textContent).toContain("150");
  });

  test("a cover with nothing wrong is TOLD there is nothing wrong", async () => {
    // A surface that speaks only when it disapproves leaves a writer unable to
    // tell "checked and fine" from "not checked".
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));

    await r.panel.open();

    expect(block("front").querySelectorAll(".cover-finding").length).toBe(1);
    expect(block("front").textContent).toContain("300");
  });

  test("a side with no picture has nothing said about its sharpness", async () => {
    const r = rig();

    await r.panel.open();

    expect(block("front").querySelectorAll(".cover-finding").length).toBe(0);
  });

  test("Add opens the host dialog for THAT side and repaints from the answer", async () => {
    const r = rig();
    r.picked = view({ view: { state: "present", data_uri: THUMB }, check: ok() });
    await r.panel.open();

    control("back", "pick")?.click();
    await Promise.resolve();
    await Promise.resolve();

    // THE SIDE THE WRITER PRESSED, which is the whole of "front and back": a
    // panel sending one side for both controls passes every other test here.
    expect(r.picks).toEqual(["back"]);
    expect(r.dones.length).toBe(1);
    expect(r.dones[0]).toContain(EN["covers.side.back"]);
    expect(block("front").querySelector("img")).not.toBe(null);
  });

  test("cancelling the dialog is an ANSWER: no notice, no announcement", async () => {
    // `project_export_as`'s rule. The writer did exactly what they intended.
    const r = rig();
    r.picked = null;
    await r.panel.open();

    control("front", "pick")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.picks).toEqual(["front"]);
    expect(r.dones).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  test("a refused picture is named and nothing is repainted", async () => {
    const r = rig();
    r.picked = "fail";
    await r.panel.open();

    control("front", "pick")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toContain("PNG");
    expect(r.dones).toEqual([]);
  });

  test("Remove takes that side off and repaints", async () => {
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    await r.panel.open();

    control("front", "clear")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.clears).toEqual(["front"]);
    expect(r.dones[0]).toContain(EN["covers.side.front"]);
    expect(block("front").querySelector("img")).toBe(null);
    expect(control("front", "clear")).toBe(null);
  });

  test("View full size asks the host again and hands the answer to the viewer", async () => {
    // IT GOES THROUGH THE HOST AGAIN rather than enlarging the thumbnail the
    // block already holds: the thumbnail is 256 px on its long side and blowing
    // it up is exactly the picture the writer pressed this because they could
    // not see.
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    await r.panel.open();

    control("front", "full")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.fulls).toEqual(["front"]);
    expect(r.shown).toEqual([{ dataUri: FULL, label: EN["covers.alt.front"] }]);
  });

  test("a full read that comes back with nothing is NAMED, not silent", async () => {
    // A full read can fail where the thumbnail beside it succeeded -- the file
    // can go between the two reads -- and a press that appears to do nothing
    // reads as a broken control.
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    r.full = { state: "missing", data_uri: null };
    await r.panel.open();

    control("front", "full")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.shown).toEqual([]);
    expect(r.notices).toEqual([EN["viewer.unavailable"]]);
  });

  test("a full read that throws is named too", async () => {
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    r.full = "fail";
    await r.panel.open();

    control("front", "full")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(r.shown).toEqual([]);
    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toContain("could not read it");
  });

  test("a host that cannot answer is NAMED, not painted as a book with no covers", async () => {
    // The recorded `renderImports([])` defect: a catch that paints the designed
    // empty state reports a failure as an absence, and the writer acts on the
    // confident sentence rather than on the banner.
    const r = rig();
    r.failRead = true;

    await r.panel.open();

    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toContain("could not read");
    expect(r.panel.isOpen()).toBe(false);
    expect(document.querySelectorAll(".cover-side").length).toBe(0);
  });

  test("an answer that resolves after the panel closed paints nothing", async () => {
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    r.hold = gate();
    const opening = r.panel.open();

    r.panel.close();
    r.hold.release?.();
    await opening;

    expect(document.querySelectorAll(".cover-side").length).toBe(0);
  });

  test("closing drops the thumbnails it was holding", async () => {
    // Two data URIs is not much, and holding them for the life of the window
    // for a panel nobody is looking at is the shape the viewer's own close
    // refuses at a hundred times the size.
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    await r.panel.open();
    expect(panel().innerHTML).toContain(THUMB);

    r.panel.close();

    expect(panel().innerHTML).not.toContain(THUMB);
  });

  test("the picture frame is only reserved when there IS a picture", async () => {
    // THE SECOND CAPTURE DEFECT, pinned. The frame exists so two columns holding
    // different shapes and different numbers of sentences put their controls on
    // one line; with NO cover on either side there is nothing to align and it is
    // a 150px hole in the panel -- in the state every new book is in. "Does
    // either column hold a picture" is a cross-column question CSS cannot ask,
    // so the panel answers it and the stylesheet keys on the attribute.
    const empty = rig();
    await empty.panel.open();
    expect(document.getElementById("covers-sides")?.dataset.anyPicture).toBe("false");

    const one = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    await one.panel.open();
    // ONE COVER IS ENOUGH: a book with a front and no back is the case the
    // alignment is actually for, so the frame must be reserved on both sides.
    expect(document.querySelectorAll("#covers-sides")[1]?.getAttribute("data-any-picture")).toBe(
      "true",
    );
  });

  test("Escape closes it and hands focus back", async () => {
    const r = rig();
    await r.panel.open();

    panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(r.panel.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);
  });

  test("a click outside closes it and does not move focus", async () => {
    const r = rig();
    await r.panel.open();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(r.panel.isOpen()).toBe(false);
    expect(r.dismissals).toBe(0);
  });

  test("there is no Save control on it at all", async () => {
    // The rule, pinned here for the reason it is pinned there: every control
    // IS the act, and a Save on a panel whose changes have already landed is a
    // control a writer has to learn does nothing.
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    await r.panel.open();

    const labels = [...panel().querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((l) => /save/i.test(l))).toBe(false);
  });

  test("no control on it carries a danger weight", async () => {
    // An earlier defect, found by looking: filled red, Remove picture was
    // the loudest control on a panel whose reason for existing is something
    // else -- and the file it unlinks is a COPY. Proportion is the point.
    const r = rig(view({ view: { state: "present", data_uri: THUMB }, check: ok() }));
    await r.panel.open();

    expect(panel().querySelector("[data-weight=\"danger\"]")).toBe(null);
  });

  test("destroy unregisters the document listener it bound", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const r = rig();
      r.panel.destroy();
      expect(added.length).toBeGreaterThan(0);
      expect(removed.sort()).toEqual(added.sort());
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });
});
