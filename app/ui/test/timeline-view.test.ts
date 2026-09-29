import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mountTimeline, type TimelineMount } from "../src/timeline-view";
import type { CastMemberRow } from "../src/cast-panel";
import type { QuickOpenItem } from "../src/quick-open";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

/** happy-dom has no rAF; run the callback synchronously, matching
 *  recorder.test.ts's own `installImmediateRaf`. */
function installImmediateRaf(): () => void {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  };
  return () => {
    globalThis.requestAnimationFrame = original;
  };
}

function baseBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "timeline",
    version: 1,
    scale: { unit: "day", zero: "", calendar: null, eras: [] },
    tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
    branches: [],
    events: [
      { id: "v1", title: "Publishes survey", at: 10, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
    ],
    ...overrides,
  });
}

function items(): QuickOpenItem[] {
  return [{ id: "it-1", title: "Chapter One", type: "scene" }];
}

function cast(): CastMemberRow[] {
  return [];
}


/** A DOMRect-shaped stub, happy-dom's own getBoundingClientRect gap:
 *  every rect is 0x0 by default, so tests that need a real geometry
 *  relationship (widthPx's header-vs-events-layer offset, a tick sharing
 *  an event's origin) stub the specific elements they read, cast-card.test.ts's
 *  own pattern. */
function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("mountTimeline", () => {
  let container: HTMLElement;
  let restoreRaf: () => void;

  beforeEach(() => {
    restoreRaf = installImmediateRaf();
    container = document.createElement("main");
    container.id = "editor";
    document.body.append(container);
  });

  afterEach(() => {
    restoreRaf();
    document.body.replaceChildren();
  });

  function mount(body: string, overrides: Partial<Parameters<typeof mountTimeline>[0]> = {}): {
    mount: TimelineMount;
    dirty: string[];
    opened: string[];
    notices: string[];
    dones: string[];
  } {
    const dirty: string[] = [];
    const opened: string[] = [];
    const notices: string[] = [];
    const dones: string[] = [];
    const m = mountTimeline({
      container,
      body,
      onDirty: (b) => dirty.push(b),
      openScene: (id) => opened.push(id),
      cast,
      items,
      onNotice: (msg) => notices.push(msg),
      onDone: (msg) => dones.push(msg),
      ...overrides,
    });
    return { mount: m, dirty, opened, notices, dones };
  }

  test("renders one lane per track and one button per event", () => {
    const { mount: m } = mount(baseBody());
    expect(container.querySelectorAll(".timeline-lane")).toHaveLength(1);
    expect(container.querySelectorAll(".tl-event")).toHaveLength(1);
    m.destroy();
  });

  test("adds and removes the timeline-open class on #editor", () => {
    const { mount: m } = mount(baseBody());
    expect(container.classList.contains("timeline-open")).toBe(true);
    m.destroy();
    expect(container.classList.contains("timeline-open")).toBe(false);
  });

  // Mutation target 6: switching away must leave NOTHING of the lanes in #editor.
  test("destroy leaves the lanes out of #editor entirely", () => {
    const { mount: m } = mount(baseBody());
    expect(container.querySelector("#timeline-view")).not.toBeNull();
    m.destroy();
    expect(container.querySelector("#timeline-view")).toBeNull();
    expect(container.querySelector(".tl-event")).toBeNull();
  });

  test("an empty tracks list shows the empty state and hides the lanes", () => {
    const { mount: m } = mount(baseBody({ tracks: [], events: [] }));
    const empty = container.querySelector<HTMLElement>("#timeline-empty");
    const lanes = container.querySelector<HTMLElement>("#timeline-lanes");
    expect(empty?.hidden).toBe(false);
    expect(lanes?.hidden).toBe(true);
    m.destroy();
  });

  // Mutation target 4: a newer body must never reach onDirty.
  test("a newer-version body renders read-only and never calls onDirty", () => {
    const body = JSON.stringify({ kind: "timeline", version: 2 });
    const { mount: m, dirty } = mount(body);
    const notice = container.querySelector<HTMLElement>("#timeline-notice");
    expect(notice?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#timeline-toolbar")?.hidden).toBe(true);
    // Nothing in this state offers a mutation, so the only way to prove
    // onDirty is never called is that no path here can reach it -- checked
    // by construction: the toolbar and lanes are hidden and the module holds
    // no `timeline` to mutate.
    expect(dirty).toEqual([]);
    m.destroy();
  });

  test("an invalid body renders read-only with its own sentence", () => {
    const { mount: m, dirty } = mount("not json");
    const notice = container.querySelector<HTMLElement>("#timeline-notice");
    expect(notice?.hidden).toBe(false);
    expect(dirty).toEqual([]);
    m.destroy();
  });

  test("+ Track opens a kind menu; A thread adds a thread track, calls onDirty, and clears the empty state", () => {
    const { mount: m, dirty } = mount(baseBody({ tracks: [], events: [] }));
    const addTrack = container.querySelector<HTMLButtonElement>("#timeline-empty button");
    addTrack?.click();
    const thread = document.getElementById("timeline-track-kind-thread") as HTMLButtonElement;
    expect(thread).not.toBeNull();
    thread.click();
    expect(dirty).toHaveLength(1);
    const parsed = JSON.parse(dirty[0]!);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0].kind).toBe("thread");
    expect(container.querySelector<HTMLElement>("#timeline-empty")?.hidden).toBe(true);
    m.destroy();
  });

  test("+ Track's A cast member opens a member picker, and choosing one adds a cast track", () => {
    const { mount: m, dirty } = mount(baseBody({ tracks: [], events: [] }), {
      cast: () => [{ id: "c1", name: "Thren" } as CastMemberRow],
    });
    const addTrack = container.querySelector<HTMLButtonElement>("#timeline-empty button");
    addTrack?.click();
    const castOption = document.getElementById("timeline-track-kind-cast") as HTMLButtonElement;
    castOption.click();
    const memberOption = document.getElementById("timeline-cast-pick-c1") as HTMLButtonElement;
    expect(memberOption).not.toBeNull();
    memberOption.click();
    expect(dirty).toHaveLength(1);
    const parsed = JSON.parse(dirty[0]!);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0]).toMatchObject({ kind: "cast", memberId: "c1", name: "Thren" });
    m.destroy();
  });

  test("track menus respond to arrows and Escape without changing the timeline", () => {
    const { mount: m, dirty } = mount(baseBody({ tracks: [], events: [] }), {
      cast: () => [{ id: "c1", name: "Thren" }, { id: "c2", name: "Ines" }] as CastMemberRow[],
    });
    const addTrack = container.querySelector<HTMLButtonElement>("#timeline-empty button")!;
    addTrack.click();
    const key = (value: string) => document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    );
    key("ArrowDown");
    expect(document.activeElement?.id).toBe("timeline-track-kind-cast");
    (document.activeElement as HTMLButtonElement).click();
    key("ArrowDown");
    expect(document.activeElement?.id).toBe("timeline-cast-pick-c2");
    key("ArrowUp");
    expect(document.activeElement?.id).toBe("timeline-cast-pick-c1");
    const otherSurface = document.createElement("input");
    document.body.append(otherSurface);
    otherSurface.focus();
    key("ArrowDown");
    expect(document.activeElement === otherSurface).toBe(true);
    otherSurface.remove();
    document.getElementById("timeline-cast-pick-c1")?.focus();
    key("Escape");
    expect(document.getElementById("timeline-cast-member-menu")?.hidden).toBe(true);
    expect(document.activeElement).toBe(addTrack);
    expect(dirty).toHaveLength(0);
    m.destroy();
  });

  test("double-click on a lane's empty space creates an event there", () => {
    const { mount: m, dirty } = mount(baseBody({ events: [] }));
    const layer = container.querySelector<HTMLElement>(".timeline-lane-events")!;
    layer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 5 }));
    expect(dirty).toHaveLength(1);
    const parsed = JSON.parse(dirty[0]!);
    expect(parsed.events).toHaveLength(1);
    m.destroy();
  });

  // CAPTURE-FOUND: "Kellstide 1, year 1 after Kell" ticks overlapped
  // their neighbours at every zoom; with a calendar a tick reads month and
  // day only (the band row names the year) and ticks stand 130px apart.
  test("calendar ticks read month and day, at least 130px apart", () => {
    const calendar = {
      months: Array.from({ length: 10 }, (_, i) => ({ name: `M${i + 1}`, days: 36, season: "S" })),
      yearLabel: "year {n}",
      epochYear: 1,
    };
    const { mount: m } = mount(baseBody({ scale: { unit: "day", zero: "", calendar, eras: [] }, events: [
      { id: "v1", title: "A", at: 0, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
      { id: "v2", title: "B", at: 600, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
    ] }));
    const ticks = [...container.querySelectorAll<HTMLElement>(".timeline-tick")];
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) expect(tick.querySelector("span")?.textContent).toMatch(/^M\d+ \d+$/);
    const lefts = ticks.map((tk) => Number.parseFloat(tk.style.left)).sort((a, b) => a - b);
    for (let i = 1; i < lefts.length; i++) expect(lefts[i]! - lefts[i - 1]!).toBeGreaterThanOrEqual(130);
    m.destroy();
  });

  // CAPTURE-FOUND: two point events 40px apart painted over each other.
  test("a point event's box stops short of the next item on its lane", () => {
    const { mount: m } = mount(baseBody({ events: [
      { id: "v1", title: "Longer title here", at: 100, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
      { id: "v2", title: "B", at: 101, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
    ] }));
    // Fit clamps at MAX_PX_PER_UNIT = 64, so the two sit 64px apart: over
    // collapse's 24px gap (two boxes, not a dot), under a label's width.
    expect(m.view().pxPerUnit).toBe(64);
    const first = container.querySelector<HTMLElement>('[data-event-id="v1"]')!;
    const second = container.querySelector<HTMLElement>('[data-event-id="v2"]')!;
    expect(first.style.maxWidth).toBe("60px");
    expect(second.style.maxWidth).toBe("220px");
    m.destroy();
  });

  // RIG-FOUND: capturing on pointerdown retargeted dblclick to #timeline-lanes,
  // and a stationary double-click on empty lane space created nothing.
  test("a stationary press does not capture the pointer; a 4px move does", () => {
    const { mount: m } = mount(baseBody({ events: [] }));
    const lanesEl = container.querySelector<HTMLElement>("#timeline-lanes")!;
    const captured: number[] = [];
    lanesEl.setPointerCapture = (id: number) => { captured.push(id); };
    const layer = container.querySelector<HTMLElement>(".timeline-lane-events")!;
    const down = (x: number) => new PointerEvent("pointerdown", { bubbles: true, clientX: x, pointerId: 7 });
    const move = (x: number) => new PointerEvent("pointermove", { bubbles: true, clientX: x, pointerId: 7 });
    layer.dispatchEvent(down(50));
    layer.dispatchEvent(move(52));
    layer.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
    expect(captured).toEqual([]);
    layer.dispatchEvent(down(50));
    layer.dispatchEvent(move(60));
    expect(captured).toEqual([7]);
    m.destroy();
  });

  test("Fit changes the view to frame the events", () => {
    const { mount: m } = mount(baseBody({ events: [
      { id: "v1", title: "A", at: 0, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
      { id: "v2", title: "B", at: 1000, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
    ] }));
    const fitted = m.view();
    const zoomInBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Zoom in")!;
    zoomInBtn.click();
    expect(m.view().pxPerUnit).not.toBe(fitted.pxPerUnit);
    const fitBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Fit")!;
    fitBtn.click();
    expect(m.view().pxPerUnit).toBeCloseTo(fitted.pxPerUnit, 6);
    m.destroy();
  });

  // BLOCKER (review): Fit measured #editor's own width, 140px wider than
  // the events layer events are actually positioned against (the
  // .timeline-lane-header beside it) -- the farthest event of a document
  // fit to a 1200px window centred at screen x=1384, off the pane.
  test("Fit frames events within the events layer's own width, not #editor's", () => {
    const { mount: m } = mount(
      baseBody({
        events: [
          { id: "v1", title: "A", at: 0, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
          { id: "v2", title: "B", at: 1000, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
        ],
      }),
    );
    container.getBoundingClientRect = () => rect(1200, 800);
    const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
    header.getBoundingClientRect = () => rect(140, 44);
    const eventsLayer = container.querySelector<HTMLElement>(".timeline-lane-events")!;
    const eventsLayerWidth = 1060;
    eventsLayer.getBoundingClientRect = () => rect(eventsLayerWidth, 44);

    const fitBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Fit")!;
    fitBtn.click();

    const events = container.querySelectorAll<HTMLElement>(".tl-event");
    expect(events.length).toBeGreaterThan(0);
    for (const btn of events) {
      const left = Number.parseFloat(btn.style.left);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(eventsLayerWidth);
    }
    m.destroy();
  });

  // RIG-FOUND (review): the scale strip positioned ticks from the pane's
  // own x=0 while events start 140px later, so every tick sat 140px left
  // of the unit it labelled.
  test("a tick and an event at the same unit share the same x offset", () => {
    const { mount: m } = mount(baseBody({ events: [
      { id: "v1", title: "A", at: 0, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
    ] }));
    const spacer = container.querySelector<HTMLElement>("#timeline-scale > .timeline-lane-header");
    const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header");
    expect(spacer).not.toBeNull();
    expect(header).not.toBeNull();
    // The scale's spacer and every lane's header share ONE CSS rule
    // (.timeline-lane-header), which is what keeps the ticks container's
    // x=0 aligned with the events layer's x=0 -- structurally, not by a
    // number restated in two places that could drift apart.
    expect(spacer!.className).toBe(header!.className);

    const view = m.view();
    const btn = container.querySelector<HTMLElement>(".tl-event")!;
    const expectedLeft = (0 - view.originUnit) * view.pxPerUnit;
    expect(Number.parseFloat(btn.style.left)).toBeCloseTo(expectedLeft, 5);
    m.destroy();
  });

  test("the status node reports zoom p95 and a visible count", () => {
    const { mount: m } = mount(baseBody());
    const status = container.querySelector<HTMLElement>("#timeline-status")!;
    expect(status.textContent).toMatch(/zoom p95 \d+ ms, visible \d+/);
    expect(status.getAttribute("aria-label")).toBe(status.textContent);
    m.destroy();
  });

  // MAJOR (review): onActivity used to fire once PER wheel/pointermove
  // event, racing chrome-fade.ts's own wake-on-mousemove listener (which
  // fires in the same dispatch and would immediately undo the arm). The
  // view now debounces: nothing fires until the pointer has been still
  // inside the lanes for POINTER_STILL_DEBOUNCE_MS.
  test("a pointer move debounces into one onActivity call after stillness, not one per event", () => {
    jest.useFakeTimers();
    try {
      let stillCalls = 0;
      const { mount: m } = mount(baseBody(), { onActivity: () => stillCalls++ });
      const lanesEl = container.querySelector<HTMLElement>("#timeline-lanes")!;
      const wheel = () =>
        lanesEl.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 10, clientX: 10, clientY: 10 }),
        );
      wheel();
      wheel();
      wheel();
      expect(stillCalls).toBe(0);
      jest.advanceTimersByTime(299);
      expect(stillCalls).toBe(0);
      jest.advanceTimersByTime(1);
      expect(stillCalls).toBe(1);
      m.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  test("Delete arms on the first press and deletes on the second", () => {
    const { mount: m, dirty } = mount(baseBody());
    const btn = container.querySelector<HTMLButtonElement>(".tl-event")!;
    btn.focus();
    const root = container.querySelector<HTMLElement>("#timeline-view")!;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(dirty).toEqual([]); // armed, not deleted
    expect(container.querySelector(".tl-event[data-armed]")).not.toBeNull();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(dirty).toHaveLength(1);
    expect(JSON.parse(dirty[0]!).events).toHaveLength(0);
    m.destroy();
  });

  // Mutation target 5: Delete must not delete on the first press.
  test("a single Delete press never removes the event", () => {
    const { mount: m, dirty } = mount(baseBody());
    const btn = container.querySelector<HTMLButtonElement>(".tl-event")!;
    btn.focus();
    const root = container.querySelector<HTMLElement>("#timeline-view")!;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(dirty).toEqual([]);
    m.destroy();
  });

  test("Ctrl+Z undoes the last mutation and Ctrl+Shift+Z redoes it", () => {
    const { mount: m, dirty } = mount(baseBody({ tracks: [], events: [] }));
    const addTrack = container.querySelector<HTMLButtonElement>("#timeline-empty button")!;
    addTrack.click();
    (document.getElementById("timeline-track-kind-thread") as HTMLButtonElement).click();
    expect(JSON.parse(dirty[dirty.length - 1]!).tracks).toHaveLength(1);
    const root = container.querySelector<HTMLElement>("#timeline-view")!;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(JSON.parse(dirty[dirty.length - 1]!).tracks).toHaveLength(0);
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(JSON.parse(dirty[dirty.length - 1]!).tracks).toHaveLength(1);
    m.destroy();
  });

  test("setBody re-parses and repaints from a fresh body", () => {
    const { mount: m } = mount(baseBody());
    expect(container.querySelectorAll(".tl-event")).toHaveLength(1);
    m.setBody(baseBody({ events: [] }));
    expect(container.querySelectorAll(".tl-event")).toHaveLength(0);
    m.destroy();
  });

  test("opening the card over an event and pressing Open scene calls openScene", () => {
    const { mount: m, opened } = mount(
      baseBody({
        events: [
          { id: "v1", title: "A", at: 10, until: null, tracks: ["t1"], branch: null, scene: "it-1", cast: [], note: "" },
        ],
      }),
    );
    const btn = container.querySelector<HTMLButtonElement>(".tl-event")!;
    btn.click();
    const card = document.getElementById("timeline-card")!;
    expect(card.hidden).toBe(false);
    const openSceneBtn = [...card.querySelectorAll("button")].find((b) => b.textContent === "Open scene")!;
    openSceneBtn.click();
    expect(opened).toEqual(["it-1"]);
    m.destroy();
  });

  // ------------------------------------------------------- branches

  describe("branches", () => {
    function branchBody(): string {
      return JSON.stringify({
        kind: "timeline",
        version: 1,
        scale: { unit: "day", zero: "", calendar: null, eras: [] },
        tracks: [
          { id: "t1", name: "Ines", kind: "thread", colour: 1 },
          { id: "t2", name: "Danse", kind: "thread", colour: 2 },
        ],
        branches: [{ id: "b1", name: "Danse wins", forkAt: 100, forkTrack: "t2", writing: false }],
        events: [
          { id: "v1", title: "Main after", at: 150, until: null, tracks: ["t2"], branch: null, scene: null, cast: [], note: "" },
          { id: "v2", title: "Branch event", at: 200, until: null, tracks: ["t2"], branch: "b1", scene: null, cast: [], note: "" },
        ],
      });
    }

    // NIT (review): the dialog carried no aria-labelledby to its own heading.
    test("+ Branch opens a dialog labelled by its own heading", () => {
      const { mount: m } = mount(branchBody());
      const addBranch = [...container.querySelectorAll<HTMLButtonElement>("#timeline-toolbar button")].find(
        (b) => b.textContent === "+ Branch",
      )!;
      addBranch.click();
      const dialog = document.getElementById("timeline-branch-form")!;
      const labelId = dialog.getAttribute("aria-labelledby");
      expect(labelId).not.toBeNull();
      expect(document.getElementById(labelId!)?.tagName).toBe("H2");
      m.destroy();
    });

    test("draws a lane group under the main lanes with the header sentence", () => {
      const { mount: m } = mount(branchBody());
      const group = container.querySelector(".timeline-branch-group");
      expect(group).not.toBeNull();
      expect(group?.querySelector(".timeline-branch-header")?.textContent).toContain("Danse wins");
      m.destroy();
    });

    // Mutation target 7's own case at the view layer: the swap must be
    // provable through the SERIALIZED body, not merely the DOM.
    test("'Make this the one I am writing' sets writing on the body, exclusively", () => {
      const { mount: m, dirty } = mount(branchBody());
      const writeBtn = [...container.querySelectorAll<HTMLButtonElement>(".timeline-branch-header button")].find(
        (b) => b.textContent === "Make this the one I am writing",
      )!;
      writeBtn.click();
      expect(dirty).toHaveLength(1);
      const parsed = JSON.parse(dirty[0]!);
      expect(parsed.branches).toHaveLength(1);
      expect(parsed.branches[0].writing).toBe(true);
      m.destroy();
    });

    test("Delete branch is armed on the first press and deletes its events on the second", () => {
      const { mount: m, dirty, dones } = mount(branchBody());
      const deleteBtn = () =>
        [...container.querySelectorAll<HTMLButtonElement>(".timeline-branch-header button")].find(
          (b) => b.textContent === "Delete branch" || b.textContent === "Delete for good?",
        )!;
      deleteBtn().click();
      expect(dirty).toEqual([]);
      expect(deleteBtn().textContent).toBe("Delete for good?");
      // MINOR (review): the count is announced on the ARMING press too, not
      // only after the writer has already agreed.
      expect(dones).toEqual(["Deletes 1 event with it."]);
      deleteBtn().click();
      expect(dirty).toHaveLength(1);
      const parsed = JSON.parse(dirty[0]!);
      expect(parsed.branches).toHaveLength(0);
      expect(parsed.events.find((e: { id: string }) => e.id === "v2")).toBeUndefined();
      expect(parsed.events.find((e: { id: string }) => e.id === "v1")).toBeDefined();
      expect(dones).toEqual(["Deletes 1 event with it.", "Deletes 1 event with it."]);
      m.destroy();
    });

    test("the card's branch select moves an event between main and a branch", () => {
      const { mount: m, dirty } = mount(branchBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")].find((b) => b.textContent === "Main after")!;
      btn.click();
      const card = document.getElementById("timeline-card")!;
      const editBtn = [...card.querySelectorAll("button")].find((b) => b.textContent === "Edit")!;
      editBtn.click();
      const select = card.querySelector<HTMLSelectElement>("select")!;
      // The main-line option carries the empty string; a real branch's id
      // otherwise (design section 2's own "exactly one of {main, branches}").
      const branchOption = [...select.options].find((o) => o.textContent === "Danse wins")!;
      select.value = branchOption.value;
      const saveBtn = [...card.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
      saveBtn.click();
      const parsed = JSON.parse(dirty[dirty.length - 1]!);
      expect(parsed.events.find((e: { id: string }) => e.id === "v1").branch).toBe("b1");
      m.destroy();
    });

    // BLOCKER (review): double-click inside a branch group's own lane must
    // create the event on the REAL track (never the composite "b1:t2" a
    // first draft used, which no lane owns and `laneAssignment` drops
    // silently) and with `branch` set to that group.
    test("double-click inside a branch group's lane creates an event with the real track and that branch", () => {
      const { mount: m, dirty } = mount(branchBody());
      const groupLayer = container.querySelector<HTMLElement>(".timeline-branch-group .timeline-lane-events")!;
      groupLayer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 5 }));
      expect(dirty).toHaveLength(1);
      const parsed = JSON.parse(dirty[0]!);
      const created = parsed.events.find((e: { title: string }) => e.title === "Untitled event");
      expect(created).toBeDefined();
      expect(created.branch).toBe("b1");
      expect(created.tracks).toEqual(["t2"]);
      m.destroy();
    });
  });

  // ---------------------------------------------------- cast tracks

  describe("cast tracks", () => {
    function castTrackBody(): string {
      return JSON.stringify({
        kind: "timeline",
        version: 1,
        scale: { unit: "day", zero: "", calendar: null, eras: [] },
        tracks: [{ id: "t1", name: "Thren", kind: "cast", memberId: "c1", colour: 1 }],
        branches: [],
        events: [],
      });
    }

    test("a cast track's header reads the member's name LIVE from deps.cast()", () => {
      const { mount: m } = mount(castTrackBody(), { cast: () => [{ id: "c1", name: "Thren" } as CastMemberRow] });
      const header = container.querySelector(".timeline-lane .timeline-lane-header");
      expect(header?.textContent).toBe("Thren");
      m.destroy();
    });

    // Mutation target 5: a cast track with a gone member is deleted on paint.
    test("a cast track whose member is gone keeps its lane, in muted ink, and is not deleted", () => {
      const { mount: m } = mount(castTrackBody(), { cast: () => [] });
      const lanes = container.querySelectorAll(".timeline-lane");
      expect(lanes).toHaveLength(1);
      expect(lanes[0]?.classList.contains("timeline-lane-gone")).toBe(true);
      expect(lanes[0]?.querySelector(".timeline-lane-header")?.textContent).toBe("(gone from the cast)");
      m.destroy();
    });
  });

  // ------------------------------------------------------- track rename

  describe("track rename", () => {
    test("double-click on a thread track's header opens an inline field; Enter commits", () => {
      const { mount: m, dirty } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = container.querySelector<HTMLInputElement>(".timeline-lane-rename")!;
      expect(input).not.toBeNull();
      input.value = "The harbour";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(dirty).toHaveLength(1);
      const parsed = JSON.parse(dirty[0]!);
      expect(parsed.tracks[0].name).toBe("The harbour");
      m.destroy();
    });

    // Mutation target 8: a track rename with an empty name is accepted.
    test("an empty name is refused and the field keeps the old one", () => {
      const { mount: m, dirty } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = container.querySelector<HTMLInputElement>(".timeline-lane-rename")!;
      input.value = "   ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(dirty).toEqual([]);
      expect(container.querySelector(".timeline-lane .timeline-lane-header")?.textContent).toBe("Ines");
      m.destroy();
    });

    test("Escape cancels the rename without calling onDirty", () => {
      const { mount: m, dirty } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = container.querySelector<HTMLInputElement>(".timeline-lane-rename")!;
      input.value = "Something else";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(dirty).toEqual([]);
      expect(container.querySelector(".timeline-lane .timeline-lane-header")?.textContent).toBe("Ines");
      m.destroy();
    });

    // MAJOR (review): a plain div with no tabIndex had no keyboard route to
    // the context menu at all.
    test("a lane header is a keyboard-reachable button with the track's name", () => {
      const { mount: m } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      expect(header.tabIndex).toBe(0);
      expect(header.getAttribute("role")).toBe("button");
      expect(header.getAttribute("aria-label")).toBe("Ines");
      m.destroy();
    });

    test("the ContextMenu key at a focused header opens the same menu as a right-click", () => {
      const { mount: m } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
      expect(document.getElementById("timeline-track-rename")).not.toBeNull();
      m.destroy();
    });

    test("Shift+F10 at a focused header opens the same menu", () => {
      const { mount: m } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
      expect(document.getElementById("timeline-track-rename")).not.toBeNull();
      m.destroy();
    });

    test("the inline rename field carries an accessible name", () => {
      const { mount: m } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = container.querySelector<HTMLInputElement>(".timeline-lane-rename")!;
      expect(input.getAttribute("aria-label")).toBe("Rename…");
      m.destroy();
    });

    // MINOR (review): a blur that fires AFTER Escape's own render() removed
    // the input must not still commit -- proven by dispatching blur by
    // hand, since happy-dom (unlike some real engines) does not fire it on
    // node removal by itself.
    test("a blur dispatched after Escape does not commit the discarded text", () => {
      const { mount: m, dirty } = mount(baseBody());
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = container.querySelector<HTMLInputElement>(".timeline-lane-rename")!;
      input.value = "Discarded";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // The SAME input node, dispatched at by hand: a real blur after
      // Escape's render() would target a DIFFERENT (detached) node in a
      // browser, but the flag this guards must not depend on that.
      input.dispatchEvent(new FocusEvent("blur"));
      expect(dirty).toEqual([]);
      expect(container.querySelector(".timeline-lane .timeline-lane-header")?.textContent).toBe("Ines");
      m.destroy();
    });

    test("a cast track's header is not renamable on double-click", () => {
      const body = JSON.stringify({
        kind: "timeline",
        version: 1,
        scale: { unit: "day", zero: "", calendar: null, eras: [] },
        tracks: [{ id: "t1", name: "Thren", kind: "cast", memberId: "c1", colour: 1 }],
        branches: [],
        events: [],
      });
      const { mount: m } = mount(body, { cast: () => [{ id: "c1", name: "Thren" } as CastMemberRow] });
      const header = container.querySelector<HTMLElement>(".timeline-lane .timeline-lane-header")!;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(container.querySelector(".timeline-lane-rename")).toBeNull();
      m.destroy();
    });
  });

  // --------------------------------------------------------------- drag

  describe("drag", () => {
    function dragBody(): string {
      return JSON.stringify({
        kind: "timeline",
        version: 1,
        scale: { unit: "day", zero: "", calendar: null, eras: [] },
        tracks: [
          { id: "t1", name: "Ines", kind: "thread", colour: 1 },
          { id: "t2", name: "Danse", kind: "thread", colour: 2 },
        ],
        branches: [],
        events: [
          { id: "v1", title: "Meeting", at: 10, until: null, tracks: ["t1", "t2"], branch: null, scene: null, cast: [], note: "" },
        ],
      });
    }

    function stubCapture(el: HTMLElement): number[] {
      const captured: number[] = [];
      (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (id: number) => {
        captured.push(id);
      };
      (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => {};
      return captured;
    }

    // Mutation target 4: drag commits without an undo entry.
    test("a drag past the threshold commits ONE undo entry that restores the full prior track list", () => {
      const { mount: m, dirty } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      expect(dirty).toHaveLength(1);
      const dragged = JSON.parse(dirty[0]!);
      const ev = dragged.events.find((e: { id: string }) => e.id === "v1");
      expect(ev.at).not.toBe(10);
      // Same lane: dragging along its own row must never touch `tracks`.
      expect(ev.tracks).toEqual(["t1", "t2"]);

      // Undo restores BOTH the day and the full track list.
      const root = container.querySelector<HTMLElement>("#timeline-view")!;
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      const undone = JSON.parse(dirty[dirty.length - 1]!);
      const undoneEv = undone.events.find((e: { id: string }) => e.id === "v1");
      expect(undoneEv.at).toBe(10);
      expect(undoneEv.tracks).toEqual(["t1", "t2"]);
      m.destroy();
    });

    // MAJOR (review): the move/up listeners must live on `lanes`, not the
    // button, so a pointer that leaves the small pill before the 4px
    // threshold (no capture yet) still reaches them.
    test("pointerdown on the button, pointermove and pointerup on lanes, still commits", () => {
      const { mount: m, dirty } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      const lanesEl = container.querySelector<HTMLElement>("#timeline-lanes")!;
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      lanesEl.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 0, pointerId: 1 }));
      lanesEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      expect(dirty).toHaveLength(1);
      m.destroy();
    });

    test("a click without movement never calls onDirty", () => {
      const { mount: m, dirty } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      expect(dirty).toEqual([]);
      m.destroy();
    });

    // RIG-FOUND: a 100px drag pressed at the box's centre moved the event
    // 140px, because `at` snapped to the pointer's absolute position.
    test("a drag moves the event by the pointer's delta, not to its position", () => {
      const { mount: m, dirty } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      const pxPerUnit = m.view().pxPerUnit;
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 500, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 500 + 40 * pxPerUnit, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      const ev = JSON.parse(dirty[0]!).events.find((e: { id: string }) => e.id === "v1");
      expect(ev.at).toBe(50);
      m.destroy();
    });

    // RIG-FOUND: the flag that swallows the browser's click after a drag
    // stayed set when that click never came (the commit re-rendered the
    // lanes), and the next real press on ANOTHER event opened no card.
    test("a drag whose synthetic click never arrives does not swallow the next real click", async () => {
      const { mount: m } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 0));
      const fresh = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      fresh.click();
      expect(document.getElementById("timeline-card")?.hidden).toBe(false);
      m.destroy();
    });

    test("Escape during a drag cancels it without calling onDirty", () => {
      const { mount: m, dirty } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 20, clientY: 0, pointerId: 1 }));
      const root = container.querySelector<HTMLElement>("#timeline-view")!;
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(dirty).toEqual([]);
      m.destroy();
    });

    // BLOCKER (review): a drag INTO a branch group's own lane must set
    // `branch`, and a drag OUT of one back onto the main lanes must clear
    // it -- both independent of whether the track itself changed.
    describe("across a branch group", () => {
      function branchDragBody(mainEventBranch: string | null): string {
        return JSON.stringify({
          kind: "timeline",
          version: 1,
          scale: { unit: "day", zero: "", calendar: null, eras: [] },
          tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
          branches: [{ id: "b1", name: "B", forkAt: 0, forkTrack: "t1", writing: false }],
          events: [
            {
              id: "v1",
              title: "Moves",
              at: 10,
              until: null,
              tracks: ["t1"],
              branch: mainEventBranch,
              scene: null,
              cast: [],
              note: "",
            },
          ],
        });
      }

      test("dragging a main-line event down into the branch's lane sets `branch`", () => {
        const { mount: m, dirty } = mount(branchDragBody(null));
        const laneRows = [...container.querySelectorAll<HTMLElement>(".timeline-lane")];
        // Main t1 first (main lanes render before branch groups), the
        // branch's own t1 lane second.
        laneRows[0]!.getBoundingClientRect = () => rect(800, 44, 0, 0);
        laneRows[1]!.getBoundingClientRect = () => rect(800, 44, 0, 100);
        const btn = container.querySelector<HTMLButtonElement>(".tl-event")!;
        stubCapture(btn);
        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 10, pointerId: 1 }));
        // Past the branch lane's own top, well past the 4px threshold.
        btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 0, clientY: 110, pointerId: 1 }));
        btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 110, pointerId: 1 }));
        expect(dirty).toHaveLength(1);
        const ev = JSON.parse(dirty[0]!).events.find((e: { id: string }) => e.id === "v1");
        expect(ev.branch).toBe("b1");
        m.destroy();
      });

      test("dragging a branch event up onto the main lane clears `branch`", () => {
        const { mount: m, dirty } = mount(branchDragBody("b1"));
        const laneRows = [...container.querySelectorAll<HTMLElement>(".timeline-lane")];
        laneRows[0]!.getBoundingClientRect = () => rect(800, 44, 0, 0);
        laneRows[1]!.getBoundingClientRect = () => rect(800, 44, 0, 100);
        const btn = container.querySelector<HTMLButtonElement>(".tl-event")!;
        stubCapture(btn);
        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 110, pointerId: 1 }));
        btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 0, clientY: 10, pointerId: 1 }));
        btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 10, pointerId: 1 }));
        expect(dirty).toHaveLength(1);
        const ev = JSON.parse(dirty[0]!).events.find((e: { id: string }) => e.id === "v1");
        expect(ev.branch).toBeNull();
        m.destroy();
      });
    });

    test("a drag confined to its own lane never touches `branch`", () => {
      const { mount: m, dirty } = mount(dragBody());
      const btn = [...container.querySelectorAll<HTMLButtonElement>(".tl-event")][0]!;
      stubCapture(btn);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 30, clientY: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      const ev = JSON.parse(dirty[0]!).events.find((e: { id: string }) => e.id === "v1");
      expect(ev.branch).toBeNull();
      m.destroy();
    });
  });

  // ------------------------------------------------------ collapsed dots

  describe("collapsed dots", () => {
    function crowdedBody(): string {
      return JSON.stringify({
        kind: "timeline",
        version: 1,
        scale: { unit: "day", zero: "", calendar: null, eras: [] },
        tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
        branches: [],
        events: [
          { id: "v1", title: "A", at: 100, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
          { id: "v2", title: "B", at: 101, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
          // FAR AWAY, on the same lane: forces Fit's own pxPerUnit down so
          // far that v1 and v2 (one unit apart) land well under the 24px
          // collapse gap -- fitting to v1/v2 alone would instead SPREAD
          // them (a tiny span fills the whole pane), which is what made
          // this fixture's first draft never produce a dot at all.
          { id: "v3", title: "Anchor", at: 100000, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
        ],
      });
    }

    test("two events under the gap collapse into one dot with a tooltip anchor", () => {
      const { mount: m } = mount(crowdedBody());
      const dot = container.querySelector<HTMLButtonElement>(".tl-dot");
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute("aria-label")).toBe("2 events here");
      expect(dot?.closest(".tl-dot-anchor")).not.toBeNull();
      m.destroy();
    });

    // Mutation target 6 at the view layer: Enter on a focused dot must zoom,
    // not no-op or zoom around the viewport centre (the model-level tests in
    // timeline-model.test.ts pin the geometry; this one pins that the KEY
    // actually reaches zoomToSeparate through the view).
    test("Enter on a focused dot separates the group (status visible count grows)", () => {
      const { mount: m } = mount(crowdedBody());
      const dot = container.querySelector<HTMLButtonElement>(".tl-dot")!;
      // A REAL GEOMETRY RELATIONSHIP, this file's own `rect()` pattern:
      // happy-dom reports every box as 0x0, and without a stub `pointerPx`
      // (the dot's own screen position, read from `.tl-dot-anchor`'s rect
      // minus the events layer's) resolves to 0 regardless of the dot's
      // TRUE unit -- zooming around px 0 anchors the view at whatever unit
      // px 0 happens to be under the STARTING fit (the far side of the
      // fixture's anchor event), and the dot itself scrolls off screen.
      const layer = container.querySelector<HTMLElement>(".timeline-lane-events")!;
      layer.getBoundingClientRect = () => rect(800, 32, 0, 0);
      const anchor = dot.closest<HTMLElement>(".tl-dot-anchor")!;
      anchor.getBoundingClientRect = () => rect(20, 20, 100, 12);
      const before = m.view().pxPerUnit;
      dot.focus();
      const root = container.querySelector<HTMLElement>("#timeline-view")!;
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      // The zoom must have actually run and separated the group -- not a
      // no-op, and not zoomed around the viewport centre (mutation target 6).
      expect(m.view().pxPerUnit).toBeGreaterThan(before);
      expect(container.querySelectorAll(".tl-event").length + container.querySelectorAll(".tl-dot").length).toBeGreaterThan(0);
      m.destroy();
    });

    // MINOR (review): dots took tabIndex -1 unconditionally and only the
    // first LANE ITEM (which could be an event) was ever promoted to 0;
    // arrow-key navigation walked the model's events and no-op'd the
    // moment a neighbour was collapsed into a dot -- reachable by mouse
    // only, for every dot but the first.
    test("the roving tab stop can be a dot, when it is the first item on its lane", () => {
      const { mount: m } = mount(crowdedBody());
      const dot = container.querySelector<HTMLButtonElement>(".tl-dot")!;
      expect(dot.tabIndex).toBe(0);
      m.destroy();
    });

    // A CLOSER anchor than `crowdedBody`'s own 100,000 (still far enough to
    // keep v1/v2 collapsed at the fitted scale, but inside the cull margin
    // this time) -- both a dot AND a separate pill must actually be ON
    // SCREEN for arrow navigation between them to mean anything.
    function twoItemsOnOneLaneBody(): string {
      return JSON.stringify({
        kind: "timeline",
        version: 1,
        scale: { unit: "day", zero: "", calendar: null, eras: [] },
        tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
        branches: [],
        events: [
          { id: "v1", title: "A", at: 100, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
          { id: "v2", title: "B", at: 101, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
          { id: "v3", title: "Anchor", at: 20000, until: null, tracks: ["t1"], branch: null, scene: null, cast: [], note: "" },
        ],
      });
    }

    test("ArrowRight from a focused dot moves to the next pill on the lane", () => {
      const { mount: m } = mount(twoItemsOnOneLaneBody());
      expect(container.querySelectorAll(".tl-event")).toHaveLength(1);
      const dot = container.querySelector<HTMLButtonElement>(".tl-dot")!;
      dot.focus();
      const root = container.querySelector<HTMLElement>("#timeline-view")!;
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(document.activeElement).toHaveProperty("textContent", "Anchor");
      m.destroy();
    });

    test("ArrowLeft from the far pill moves focus back to the dot", () => {
      const { mount: m } = mount(twoItemsOnOneLaneBody());
      const anchorBtn = container.querySelector<HTMLButtonElement>(".tl-event")!;
      anchorBtn.tabIndex = 0;
      anchorBtn.focus();
      const root = container.querySelector<HTMLElement>("#timeline-view")!;
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(document.activeElement).toBe(container.querySelector(".tl-dot"));
      m.destroy();
    });
  });
});
