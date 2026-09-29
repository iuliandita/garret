// app/ui/src/timeline-view.ts
// The timeline's lanes (102, design section 4). Mounted into `#editor` when a
// `timeline` item is activated; the ProseMirror view is hidden, never
// destroyed, and this module's DOM leaves `#editor` on `destroy()`.
//
// POSITIONED DESCENDANTS INSIDE `#editor`, RECORDED. `#editor {
// will-change: transform }` (064's memory fix) holds only while `#editor`
// has no positioned descendant -- every other floating surface in this
// application (the bubble toolbar, the cast card, the timeline's own event
// card) stays OFF `#editor` for exactly that reason. The lanes are the one
// deliberate exception: they are the content of the pane while a timeline is
// open, not a float over it, so `mountTimeline` adds `timeline-open` to
// `#editor`'s class list and `style.css` turns the hint off for as long as
// that class is present. `chrome-fade.ts`'s prose-typing gate is unaffected
// (no prose is typed into a timeline), and `persist-cli` re-runs to show the
// scene path unchanged (102's harness item).
//
// THE VIEW HOLDS THE PARSED `Timeline` AS ITS STATE (Decision, plan). Every
// mutation re-serializes the whole document and hands it to `onDirty`; the
// flusher already debounces, so there is no diffing here and no reason for
// one.
//
// HTML, NOT SVG. Every event is a `<button>` carrying its title as its
// accessible name, absolutely positioned in its lane; lines, ticks and the
// scale strip are plain elements the stylesheet draws. A screen reader hears
// the events, Tab and the arrow keys reach them, and a rig presses one by
// name through AT-SPI exactly as it presses a navigator row.
//
// ONLY THE VISIBLE WINDOW IS IN THE DOM. `cull` (timeline-model.ts) runs on
// every render; pan and zoom re-run it through `requestAnimationFrame`, one
// scheduled frame at a time, which is what keeps a 2,000-event document
// culling like a 20-event one and is the graded figure (`timeline_zoom_p95_ms`,
// `timeline_visible_dom_bounded`).
import { isCompositionKey } from "./composition-key";
import { formatNumber, plural, t } from "./i18n";
import { percentiles } from "./measure/stats";
import {
  applyStep,
  bandLevel,
  branchTracks,
  calendarDate,
  collapse,
  commitTrackName,
  cull,
  EVENT_MAX_WIDTH_PX,
  fitView,
  inverseOf,
  laneAssignment,
  mintId,
  parseTimeline,
  pxToUnit,
  serialize,
  unitToPx,
  zoomAround,
  zoomToSeparate,
  type Timeline,
  type TimelineBranch,
  type TimelineEvent,
  type TimelineStep,
  type TimelineTrack,
  type TimelineViewState,
} from "./timeline-model";
import { createTimelineCard, type TimelineCardDeps } from "./timeline-card";
import { createTimelineScalePanel } from "./timeline-scale-panel";
import { placeBubble } from "./bubble-placement";
import { createTooltip, type Tooltip } from "./tooltip";
import { clampToViewport, createMenuPanel, type MenuItemSpec } from "./menu-panel";
import { closeOnOutsideClick } from "./dismiss-outside";
import { isContextMenuChord } from "./nav-context-menu";
import type { CastMemberRow } from "./cast-panel";
import type { QuickOpenItem } from "./quick-open";

const MIN_GAP_PX = 24;
const CULL_MARGIN_SCREENS = 1;
const ZOOM_FACTOR = 1.15;
const MAX_ZOOM_SAMPLES = 200;
const MIN_TICK_GAP_PX = 80;
/** A calendar tick reads "Kellstide 36", about twice a bare number's width;
 *  at 80px the sample's labels overlapped at every zoom (104's captures). */
const CALENDAR_TICK_GAP_PX = 130;
/** A press becomes a pan only after this much travel. Capturing the pointer
 *  ON pointerdown retargeted the browser's compatibility click and dblclick
 *  to the capturing element, so a stationary double-click on a lane's empty
 *  space arrived at `#timeline-lanes`, never at the layer whose handler
 *  creates the event: timeline-cli's round trip found 2,000 events and no
 *  card, while the happy-dom test (dblclick dispatched at the layer) passed. */
const PAN_THRESHOLD_PX = 4;
/** A point event's box is clipped to the room before the next item on its
 *  lane, less this gap, and never below EVENT_MIN_WIDTH_PX (an ellipsis
 *  still shows). collapse() only groups under MIN_GAP_PX; between that gap
 *  and a label's width the first capture painted boxes over each other. */
const EVENT_GAP_PX = 4;
const EVENT_MIN_WIDTH_PX = 28;
/** How long the pointer has to sit still, inside the lanes, before this
 *  counts as the "stillness" chromeFade.onPointerStill() arms on (design
 *  section 4). Debounced HERE rather than calling onActivity per event: a
 *  timeline has no typing to arm the chrome's own 1.5s hide timer with, and
 *  chrome-fade.ts's OWN wake-on-mousemove listener fires in the SAME
 *  dispatch as every wheel/pointermove this view sees, so an unthrottled
 *  call would arm and immediately undo itself on every single event. */
const POINTER_STILL_DEBOUNCE_MS = 300;

export interface TimelineMountDeps {
  /** `#editor`. */
  container: HTMLElement;
  body: string;
  /** Called with the serialized body on every mutation. Never called for a
   *  `newer` or `invalid` document (the whole-document leniency rule, design
   *  section 3). */
  onDirty(body: string): void;
  openScene(itemId: string): void;
  cast(): readonly CastMemberRow[];
  items(): readonly QuickOpenItem[];
  onNotice(message: string): void;
  onDone(message: string): void;
  /** Focus mode's wake hook (chrome-fade.ts): a timeline has no typing, so
   *  only pointer stillness feeds it, through the same rules prose uses. */
  onActivity?: () => void;
}

export interface TimelineMount {
  destroy(): void;
  focus(): void;
  setBody(body: string): void;
  /** The current pan/zoom state, exposed for `shot-cli` captures that need a
   *  known frame. */
  view(): TimelineViewState;
}

function trackColourVar(colour: number): string {
  const n = ((colour - 1 + 8) % 8) + 1;
  return `var(--track-${n})`;
}

export function mountTimeline(deps: TimelineMountDeps): TimelineMount {
  const { container } = deps;
  container.classList.add("timeline-open");

  const root = document.createElement("div");
  root.id = "timeline-view";
  container.append(root);

  const notice = document.createElement("p");
  notice.id = "timeline-notice";
  notice.hidden = true;
  root.append(notice);

  const toolbar = document.createElement("div");
  toolbar.id = "timeline-toolbar";
  root.append(toolbar);

  const scaleLabel = document.createElement("span");
  scaleLabel.id = "timeline-scale-label";
  toolbar.append(scaleLabel);

  const editScaleBtn = document.createElement("button");
  editScaleBtn.type = "button";
  editScaleBtn.textContent = t("timeline.toolbar.edit-scale");
  toolbar.append(editScaleBtn);

  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.textContent = t("timeline.toolbar.fit");
  toolbar.append(fitBtn);

  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.type = "button";
  zoomOutBtn.textContent = t("timeline.toolbar.zoom-out");
  toolbar.append(zoomOutBtn);

  const zoomInBtn = document.createElement("button");
  zoomInBtn.type = "button";
  zoomInBtn.textContent = t("timeline.toolbar.zoom-in");
  toolbar.append(zoomInBtn);

  const addTrackBtn = document.createElement("button");
  addTrackBtn.type = "button";
  addTrackBtn.textContent = t("timeline.toolbar.add-track");
  toolbar.append(addTrackBtn);

  const addEventBtn = document.createElement("button");
  addEventBtn.type = "button";
  addEventBtn.textContent = t("timeline.toolbar.add-event");
  toolbar.append(addEventBtn);

  const addBranchBtn = document.createElement("button");
  addBranchBtn.type = "button";
  addBranchBtn.textContent = t("timeline.toolbar.add-branch");
  toolbar.append(addBranchBtn);

  // THE MEASURING INSTRUMENT (100's `#library-timing` pattern, restated in
  // section 4). Clipped off-screen, never `display: none`, so it stays a
  // node in the accessibility tree for `timeline-cli` to read by name.
  const status = document.createElement("p");
  status.id = "timeline-status";
  status.className = "timeline-status";
  status.setAttribute("role", "status");
  toolbar.append(status);

  // ERAS DRAW AS A SECOND BAND ROW, ABOVE THE TICKS (design section 4, plan
  // item 2) -- its OWN element, a sibling of `#timeline-scale` rather than
  // nested inside it, so `#timeline-scale`'s existing flat
  // spacer-then-ticks shape (and everything that reads it, `widthPx()`
  // included) is untouched. It shares the SAME spacer rule so its bands
  // start at the events layer's own x=0.
  const eraScale = document.createElement("div");
  eraScale.id = "timeline-era-scale";
  const eraSpacer = document.createElement("div");
  eraSpacer.className = "timeline-lane-header";
  const eraTicks = document.createElement("div");
  eraTicks.className = "timeline-era-band";
  eraScale.append(eraSpacer, eraTicks);
  root.append(eraScale);

  // MONTH/SEASON/YEAR BANDS (review, MAJOR: not implemented, plan item 2's
  // own words). A second sibling row, same spacer-sharing shape as the era
  // row above it -- whichever level `bandLevel` picks for the current zoom,
  // never more than one at a time.
  const calendarScale = document.createElement("div");
  calendarScale.id = "timeline-calendar-scale";
  const calendarSpacer = document.createElement("div");
  calendarSpacer.className = "timeline-lane-header";
  const calendarTicks = document.createElement("div");
  calendarTicks.className = "timeline-calendar-band";
  calendarScale.append(calendarSpacer, calendarTicks);
  root.append(calendarScale);

  const scale = document.createElement("div");
  scale.id = "timeline-scale";
  // A spacer sharing .timeline-lane-header's own CSS rule, so the ticks
  // container beside it starts at the events layer's x=0 whatever the
  // header's real width is -- see style.css's own comment on #timeline-scale.
  const scaleSpacer = document.createElement("div");
  scaleSpacer.className = "timeline-lane-header";
  const scaleTicks = document.createElement("div");
  scaleTicks.className = "timeline-scale-ticks";
  scale.append(scaleSpacer, scaleTicks);
  root.append(scale);

  const lanes = document.createElement("div");
  lanes.id = "timeline-lanes";
  // A KEYBOARD OPEN'S FOCUS TARGET, carry-in from 102's review: the fallback
  // used to be `root.focus()`, which drew the browser's default ring around
  // the WHOLE pane (toolbar, scale strip and empty state included) the
  // moment a writer opened an empty timeline with no event to land on.
  // `#timeline-lanes:focus-visible` (style.css) now draws an INSET ring on
  // just the lanes area instead -- kept, not removed, so a keyboard user
  // opening an empty timeline still sees where focus landed.
  lanes.tabIndex = -1;
  root.append(lanes);

  // The drag's own tooltip (plan item 4: "shows a tooltip with the number
  // and the calendar date"): its content changes on every pointermove of an
  // active drag, which is a different job from `tooltip.ts`'s fixed
  // name+hint (that module wraps a STATIC control; this one follows a
  // moving pointer and is shown only for the drag's own duration).
  const dragTip = document.createElement("div");
  dragTip.id = "timeline-drag-tip";
  dragTip.hidden = true;
  root.append(dragTip);

  const empty = document.createElement("div");
  empty.id = "timeline-empty";
  empty.hidden = true;
  const emptyText = document.createElement("p");
  emptyText.textContent = t("timeline.empty");
  const emptyAddTrack = document.createElement("button");
  emptyAddTrack.type = "button";
  emptyAddTrack.textContent = t("timeline.toolbar.add-track");
  empty.append(emptyText, emptyAddTrack);
  root.append(empty);

  let destroyed = false;
  let timeline: Timeline | null = null;
  let readOnlySentence: string | null = null;

  const parsed = parseTimeline(deps.body);
  if ("newer" in parsed) {
    readOnlySentence = t("timeline.newer");
  } else if ("invalid" in parsed) {
    readOnlySentence = t("timeline.invalid");
  } else {
    timeline = parsed;
  }
  if (readOnlySentence !== null) {
    notice.hidden = false;
    notice.textContent = readOnlySentence;
    toolbar.hidden = true;
    scale.hidden = true;
    lanes.hidden = true;
    empty.hidden = true;
  }

  let view: TimelineViewState = { pxPerUnit: 1, originUnit: 0, widthPx: 800 };
  let undoStack: TimelineStep[][] = [];
  let redoStack: TimelineStep[][] = [];
  let zoomSamples: number[] = [];
  let armedDeleteId: string | null = null;
  let armedBranchDeleteId: string | null = null;
  let rafScheduled = false;
  let pendingZoomStart: number | null = null;
  let pointerStillTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced pointer activity: reset on every wheel/pointermove inside the
   *  lanes, fired once the pointer has actually stopped for
   *  POINTER_STILL_DEBOUNCE_MS -- see the constant's own comment. */
  function notePointerActivity(): void {
    if (pointerStillTimer !== null) clearTimeout(pointerStillTimer);
    pointerStillTimer = setTimeout(() => {
      pointerStillTimer = null;
      deps.onActivity?.();
    }, POINTER_STILL_DEBOUNCE_MS);
  }

  const cardDeps: TimelineCardDeps = {
    container: document.body,
    cast: deps.cast,
    items: deps.items,
    sceneTitle: (sceneId) => deps.items().find((i) => i.id === sceneId)?.title,
    calendar: () => timeline?.scale.calendar ?? null,
    branches: () => timeline?.branches ?? [],
    onSave(eventId, patch) {
      const fields = Object.entries(patch) as [string, unknown][];
      const steps: TimelineStep[] = fields.map(([field, value]) => ({
        kind: "set",
        entity: "event",
        id: eventId,
        field,
        value,
      }));
      doEntry(steps);
    },
    onDelete(eventId) {
      doEntry([{ kind: "remove", entity: "event", id: eventId }]);
    },
    onOpenScene(sceneId) {
      deps.openScene(sceneId);
    },
    onDismiss() {
      lanes.focus();
    },
  };
  const card = createTimelineCard(cardDeps);

  const scalePanel = createTimelineScalePanel({
    container: document.body,
    onSave(scale) {
      if (timeline === null) return;
      // Eras minted here, at APPLY time, rather than by the panel: the panel
      // is pure UI and never reads the document's id space
      // (`mintId`'s own convention -- ids are minted from the WHOLE document,
      // never a sub-array, and the panel only ever sees `scale.eras`).
      let t2 = timeline;
      const eras = scale.eras.map((e) => {
        if (!e.id.startsWith("pending-")) return e;
        const id = mintId(t2, "e");
        t2 = { ...t2, scale: { ...t2.scale, eras: [...t2.scale.eras, { ...e, id }] } };
        return { ...e, id };
      });
      // NOT THROUGH doEntry/undo: the plan's own words are "Save serializes
      // through onDirty" (item 2), and a form this large re-opened to "undo"
      // one field is a worse writer experience than re-editing it. Every
      // OTHER mutation in this view (events, tracks, branches) is a small,
      // undoable act; the scale is edited as a whole document instead.
      timeline = { ...timeline, scale: { ...scale, eras } };
      flushAndRender();
    },
    onDismiss() {
      lanes.focus();
    },
  });

  /** The EVENTS LAYER's width, not #editor's. `.timeline-lane-events` sits
   *  right of a `.timeline-lane-header` (measured, never a restated 140px)
   *  and every unit<->px conversion in this module is against that layer,
   *  since that is what unitToPx positions events INTO -- fitView and every
   *  press of Fit fed the pane's own width here first, and the header ate
   *  140px nothing in the model ever subtracted, which is why a document
   *  fit to a 1200px window centred its farthest event at screen x=1384,
   *  off the pane entirely. Falls back to the container's width minus a
   *  measured header (0 when none exists yet, e.g. no lane has painted a
   *  first time) rather than the events layer itself when no lane is
   *  mounted -- the empty state and the very first call before render()
   *  has ever run. */
  function widthPx(): number {
    const eventsLayer = lanes.querySelector<HTMLElement>(".timeline-lane-events");
    if (eventsLayer !== null) {
      const w = eventsLayer.getBoundingClientRect().width;
      if (w > 0) return w;
    }
    const header = lanes.querySelector<HTMLElement>(".timeline-lane-header");
    const headerWidth = header !== null ? header.getBoundingClientRect().width : 0;
    const w = container.getBoundingClientRect().width - headerWidth;
    return w > 0 ? w : 800;
  }

  function doEntry(steps: TimelineStep[]): void {
    if (timeline === null) return;
    let t2 = timeline;
    const inverses: TimelineStep[] = [];
    for (const step of steps) {
      const inv = inverseOf(t2, step);
      t2 = applyStep(t2, step);
      if (inv !== null) inverses.unshift(inv);
    }
    timeline = t2;
    undoStack.push(inverses);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    flushAndRender();
  }

  function undo(): void {
    if (timeline === null) return;
    const steps = undoStack.pop();
    if (steps === undefined) return;
    let t2 = timeline;
    const redoSteps: TimelineStep[] = [];
    for (const step of steps) {
      const inv = inverseOf(t2, step);
      t2 = applyStep(t2, step);
      if (inv !== null) redoSteps.unshift(inv);
    }
    timeline = t2;
    redoStack.push(redoSteps);
    if (redoStack.length > 200) redoStack.shift();
    flushAndRender();
  }

  function redo(): void {
    if (timeline === null) return;
    const steps = redoStack.pop();
    if (steps === undefined) return;
    let t2 = timeline;
    const undoSteps: TimelineStep[] = [];
    for (const step of steps) {
      const inv = inverseOf(t2, step);
      t2 = applyStep(t2, step);
      if (inv !== null) undoSteps.unshift(inv);
    }
    timeline = t2;
    undoStack.push(undoSteps);
    if (undoStack.length > 200) undoStack.shift();
    flushAndRender();
  }

  function flushAndRender(): void {
    if (timeline === null) return;
    deps.onDirty(serialize(timeline));
    render();
  }

  function scheduleRepaint(timeZoom: boolean): void {
    if (timeZoom && pendingZoomStart === null) pendingZoomStart = performance.now();
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      render();
      if (pendingZoomStart !== null) {
        const duration = performance.now() - pendingZoomStart;
        pendingZoomStart = null;
        zoomSamples.push(duration);
        if (zoomSamples.length > MAX_ZOOM_SAMPLES) zoomSamples.shift();
        paintStatus();
      }
    });
  }

  function niceTickStep(pxPerUnit: number, gapPx: number): number {
    const rawUnit = gapPx / pxPerUnit;
    const mag = 10 ** Math.floor(Math.log10(Math.max(rawUnit, 1e-9)));
    const norm = rawUnit / mag;
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return Math.max(1, niceNorm * mag);
  }

  // -------------------------------------------------------------- drag (103)

  /** True for the duration between a drag's `pointerup` and the synthetic
   *  `click` the browser fires right after it -- `eventButton`'s own click
   *  handler reads this to refuse opening the card over a drag that just
   *  moved something. Reset the moment that click is swallowed. */
  let dragMoved = false;

  interface DragSession {
    event: TimelineEvent;
    button: HTMLButtonElement;
    pointerId: number;
    startX: number;
    startY: number;
    startAt: number;
    originTrack: string;
    originBranchId: string | null;
    dragging: boolean;
    targetTrack: string;
    targetBranchId: string | null;
    snappedAt: number;
  }
  let drag: DragSession | null = null;

  /** A lane's real track id AND the branch group it belongs to (`null` for a
   *  main lane) -- both read from `renderOneLane`'s own `dataset` (review,
   *  BLOCKER: a branch lane's dataset used to carry only the bare track id,
   *  indistinguishable from that same track's main lane, so a drag INTO or
   *  OUT OF a group silently kept `branch` unchanged). */
  function laneRowAt(clientY: number): { trackId: string; branchId: string | null; row: HTMLElement } | null {
    for (const row of lanes.querySelectorAll<HTMLElement>(".timeline-lane")) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const trackId = row.dataset.trackId;
        if (trackId !== undefined) {
          const branchId = row.dataset.branchId;
          return { trackId, branchId: branchId === undefined || branchId === "" ? null : branchId, row };
        }
      }
    }
    return null;
  }

  /** Positioned near the POINTER (review, MINOR: it used to sit at the
   *  layer's static origin, showing text but never moving), in the lanes'
   *  own coordinate space since `dragTip`'s parent is `#timeline-view`. */
  function showDragTip(snappedAt: number, clientX: number, clientY: number): void {
    const calendar = timeline?.scale.calendar ?? null;
    const date = calendar === null ? null : calendarDate(snappedAt, calendar);
    dragTip.textContent =
      date === null
        ? t("timeline.drag.at", { at: formatNumber(snappedAt) })
        : t("timeline.drag.at-dated", { at: formatNumber(snappedAt), date: date.label });
    const paneRect = lanes.getBoundingClientRect();
    const tipLeftPx = clientX - paneRect.left + 12;
    const tipTopPx = clientY - paneRect.top - 24;
    dragTip.style.left = `${tipLeftPx}px`;
    dragTip.style.top = `${tipTopPx}px`;
    dragTip.hidden = false;
  }

  function endDrag(commit: boolean): void {
    if (drag === null) return;
    const session = drag;
    drag = null;
    dragTip.hidden = true;
    // ONLY WHEN A REAL CAPTURE WAS TAKEN (review, MAJOR): `releasePointerCapture`
    // throws `NotFoundError` when the id names no active capture, which every
    // ordinary click (never past the 4px threshold, never captured) used to
    // hit -- on WebKitGTK, not under happy-dom, where `stubCapture` replaces
    // the method with a no-op and hides exactly this.
    if (session.dragging && session.button.hasPointerCapture?.(session.pointerId)) {
      session.button.releasePointerCapture(session.pointerId);
    }
    delete session.button.dataset.pointerId;
    if (!commit || !session.dragging) return;
    dragMoved = true;
    // The click the browser fires after the mouseup comes in the SAME input
    // dispatch, before any task; if it never comes (the commit below
    // re-renders the lanes, so the button under the pointer is a new one,
    // or a dot, or nothing), the flag must not survive to swallow the next
    // real click -- the rig's press on the anchor after a drag opened no
    // card, because this flag was still set from the drag before it.
    setTimeout(() => {
      dragMoved = false;
    }, 0);
    const steps: TimelineStep[] = [
      { kind: "set", entity: "event", id: session.event.id, field: "at", value: session.snappedAt },
    ];
    // TRACKS ONLY WHEN THE LANE ACTUALLY CHANGED -- a drag confined to its
    // own lane must never touch `tracks`, or a meeting dragged along its own
    // row would silently collapse to one track. Two "set" steps in ONE undo
    // entry (carry-in from 102's review, timeline-model.ts's own comment on
    // "move"): undoing this restores the FULL prior `tracks` array, not just
    // its first element.
    if (session.targetTrack !== session.originTrack) {
      steps.push({ kind: "set", entity: "event", id: session.event.id, field: "tracks", value: [session.targetTrack] });
    }
    // BRANCH FOLLOWS THE GROUP THE POINTER ENDED IN (review, BLOCKER): a
    // drag into a branch's dashed lanes sets `branch` to that group; a drag
    // out, back onto the main lanes, sets it to `null`. Independent of the
    // track-changed check above -- a drag confined to one track but crossing
    // from a branch's own lane back onto that SAME track's main lane must
    // still clear `branch`, with no `tracks` step at all.
    if (session.targetBranchId !== session.originBranchId) {
      steps.push({ kind: "set", entity: "event", id: session.event.id, field: "branch", value: session.targetBranchId });
    }
    doEntry(steps);
  }

  /** ONE set of listeners, on `lanes`, for the LIFE OF THE MOUNT -- not one
   *  per button (review, MAJOR). Binding pointermove/pointerup/pointercancel
   *  on each button left `drag` non-null forever the moment a fast press
   *  left the small pill before crossing the 4px arm threshold (pointer
   *  capture, which redirects events back to the button regardless of its
   *  position, is not yet in effect at that point) -- the stale session then
   *  swallowed the very next Escape (`onKeyDown`'s own first branch) and
   *  confused `focusedEvent`. Bound here, they see every move and every
   *  release inside the pane whether or not the pointer is still over the
   *  button that started the drag. */
  function bindEventDrag(btn: HTMLButtonElement, ev: TimelineEvent): void {
    btn.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const trackId = btn.dataset.trackId ?? ev.tracks[0] ?? "";
      const branchIdAttr = btn.dataset.branchId;
      const branchId = branchIdAttr === undefined || branchIdAttr === "" ? null : branchIdAttr;
      drag = {
        event: ev,
        button: btn,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startAt: ev.at,
        originTrack: trackId,
        originBranchId: branchId,
        dragging: false,
        targetTrack: trackId,
        targetBranchId: branchId,
        snappedAt: ev.at,
      };
    });
  }

  const onDragPointerMove = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging) {
      if (Math.abs(event.clientX - drag.startX) < PAN_THRESHOLD_PX && Math.abs(event.clientY - drag.startY) < PAN_THRESHOLD_PX) {
        return;
      }
      drag.dragging = true;
      drag.button.setPointerCapture(event.pointerId);
      drag.button.dataset.pointerId = String(event.pointerId);
    }
    // BY THE POINTER'S DELTA FROM THE PRESS, not by its absolute position:
    // snapping `at` to the unit under the pointer made the event jump on
    // the first move until its LEFT edge sat under a pointer that had
    // pressed its middle. timeline-cli's 100px drag on a box pressed at
    // its centre read as 140px in the file.
    const dxPx = event.clientX - drag.startX;
    drag.snappedAt = Math.round(drag.startAt + dxPx / view.pxPerUnit);
    const lane = laneRowAt(event.clientY);
    if (lane !== null) {
      drag.targetTrack = lane.trackId;
      drag.targetBranchId = lane.branchId;
    }
    const snappedPx = unitToPx(drag.snappedAt, view);
    drag.button.style.left = `${snappedPx}px`;
    showDragTip(drag.snappedAt, event.clientX, event.clientY);
  };
  const onDragPointerUp = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    endDrag(true);
  };
  const onDragPointerCancel = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    endDrag(false);
  };
  lanes.addEventListener("pointermove", onDragPointerMove);
  lanes.addEventListener("pointerup", onDragPointerUp);
  lanes.addEventListener("pointercancel", onDragPointerCancel);

  function renderScale(): void {
    scaleTicks.replaceChildren();
    eraTicks.replaceChildren();
    if (timeline === null) return;
    const calendar = timeline.scale.calendar;
    const step = niceTickStep(view.pxPerUnit, calendar === null ? MIN_TICK_GAP_PX : CALENDAR_TICK_GAP_PX);
    const first = Math.floor(view.originUnit / step) * step;
    for (let u = first; u <= view.originUnit + view.widthPx / view.pxPerUnit + step; u += step) {
      const px = unitToPx(u, view);
      if (px < -MIN_TICK_GAP_PX || px > view.widthPx + MIN_TICK_GAP_PX) continue;
      const tick = document.createElement("div");
      tick.className = "timeline-tick";
      tick.style.left = `${px}px`;
      const label = document.createElement("span");
      const date = calendar === null ? null : calendarDate(Math.round(u), calendar);
      label.textContent = date === null ? formatNumber(Math.round(u)) : date.tick;
      tick.append(label);
      scaleTicks.append(tick);
    }

    // ERAS, a second band row above the ticks, in their tint, with the
    // name (design section 4). ABSOLUTE RANGES, independent of the
    // calendar -- unitToPx against the same view every tick uses.
    //
    // HIDDEN WITH NO ERAS (coordinator follow-up, from the shot-cli
    // captures): every capture so far shows an empty grey strip -- a row
    // with nothing in it is not a row worth a line of chrome.
    eraScale.hidden = timeline.scale.eras.length === 0;
    for (const era of timeline.scale.eras) {
      const fromPx = unitToPx(era.from, view);
      const toPx = unitToPx(era.to, view);
      const lo = Math.min(fromPx, toPx);
      const hi = Math.max(fromPx, toPx);
      if (hi < -MIN_TICK_GAP_PX || lo > view.widthPx + MIN_TICK_GAP_PX) continue;
      const band = document.createElement("div");
      band.className = "timeline-era";
      band.style.left = `${lo}px`;
      const widthPxVal = Math.max(1, hi - lo);
      band.style.width = `${widthPxVal}px`;
      const n = ((era.tint - 1 + 6) % 6) + 1;
      band.style.background = `var(--era-${n})`;
      band.textContent = era.name;
      eraTicks.append(band);
    }

    renderCalendarBands();
  }

  /** MONTH/SEASON/YEAR BANDS (review, MAJOR: plan item 2, not implemented
   *  at all before). `bandLevel` (timeline-model.ts, pure) picks the one
   *  level the current zoom shows; this walks the calendar's own cycle
   *  arithmetic (the same "day 0 is day 1 of month 1 of the epoch" rule
   *  `calendarDate` uses) to find every band's own [start, end) in units,
   *  across as many whole cycles as the viewport spans, and paints only
   *  the ones that overlap it. */
  function renderCalendarBands(): void {
    calendarTicks.replaceChildren();
    if (timeline === null) return;
    const calendar = timeline.scale.calendar;
    const level = bandLevel(view.pxPerUnit, calendar);
    calendarScale.hidden = level === null;
    if (level === null || calendar === null) return;

    const totalDays = calendar.months.reduce((sum, m) => sum + m.days, 0);
    const offsets: number[] = [];
    let acc = 0;
    for (const m of calendar.months) {
      offsets.push(acc);
      acc += m.days;
    }

    const paintBand = (fromAt: number, toAt: number, name: string): void => {
      const fromPx = unitToPx(fromAt, view);
      const toPx = unitToPx(toAt, view);
      if (toPx < -MIN_TICK_GAP_PX || fromPx > view.widthPx + MIN_TICK_GAP_PX) return;
      const band = document.createElement("div");
      band.className = "timeline-calendar-band-item";
      band.style.left = `${fromPx}px`;
      const bandWidthPx = Math.max(1, toPx - fromPx);
      band.style.width = `${bandWidthPx}px`;
      band.textContent = name;
      calendarTicks.append(band);
    };

    const visibleFrom = view.originUnit;
    const visibleTo = view.originUnit + view.widthPx / view.pxPerUnit;
    const firstCycle = Math.floor(visibleFrom / totalDays) - 1;
    const lastCycle = Math.floor(visibleTo / totalDays) + 1;

    for (let c = firstCycle; c <= lastCycle; c++) {
      const cycleStart = c * totalDays;
      if (level === "year") {
        const year = calendar.epochYear + c;
        paintBand(cycleStart, cycleStart + totalDays, calendar.yearLabel.replace("{n}", String(year)));
        continue;
      }
      if (level === "month") {
        calendar.months.forEach((m, i) => {
          paintBand(cycleStart + offsets[i]!, cycleStart + offsets[i]! + m.days, m.name);
        });
        continue;
      }
      // "season": consecutive months sharing a season name merge into one
      // band, so a four-month season paints once, not four times.
      let i = 0;
      while (i < calendar.months.length) {
        const season = calendar.months[i]!.season;
        let j = i;
        while (j < calendar.months.length && calendar.months[j]!.season === season) j++;
        const endOffset = j < calendar.months.length ? offsets[j]! : totalDays;
        paintBand(cycleStart + offsets[i]!, cycleStart + endOffset, season);
        i = j;
      }
    }
  }

  function eventButton(
    ev: TimelineEvent,
    leftPx: number,
    isMeeting: boolean,
    laneIndex: number,
    trackId: string,
    branchId: string | null,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("tl-event");
    if (isMeeting) btn.classList.add("tl-meeting");
    btn.textContent = ev.title;
    btn.dataset.eventId = ev.id;
    btn.dataset.lane = String(laneIndex);
    // THE LANE THIS BUTTON IS *IN*, not `ev.tracks[0]` -- a meeting renders
    // one button per lane it touches (the per-track loop below calls this
    // once per track), so the button dragged is the one under the pointer,
    // on ITS OWN lane, never the event's first track regardless of which
    // copy the writer actually grabbed.
    btn.dataset.trackId = trackId;
    // THE BRANCH GROUP THIS BUTTON IS IN, "" for a main lane -- read back by
    // `bindEventDrag`'s own pointerdown so a drag knows where it STARTED
    // (review, BLOCKER: without this a drag out of a group could not tell
    // it had left one).
    btn.dataset.branchId = branchId ?? "";
    btn.style.left = `${leftPx}px`;
    btn.style.maxWidth = `${EVENT_MAX_WIDTH_PX}px`;
    if (ev.until !== null) {
      const widthPxVal = Math.max(4, unitToPx(ev.until, view) - leftPx);
      btn.style.width = `${widthPxVal}px`;
      btn.classList.add("tl-range");
    }
    btn.tabIndex = -1;
    if (armedDeleteId === ev.id) btn.setAttribute("data-armed", "true");
    btn.addEventListener("click", () => {
      // A DRAG THAT MOVED never opens the card -- `pointerup`'s own commit
      // already ran and the click that follows a drag's mouseup is the
      // browser's, not the writer's.
      if (dragMoved) {
        dragMoved = false;
        return;
      }
      openCard(ev, "read", btn);
    });
    bindEventDrag(btn, ev);
    return btn;
  }

  function openCard(ev: TimelineEvent, mode: "read" | "edit", anchorEl: HTMLElement): void {
    if (timeline === null) return;
    const anchor = anchorEl.getBoundingClientRect();
    const pane = container.getBoundingClientRect();
    card.open(ev, timeline.tracks, anchor, pane, mode);
  }

  /** `deps.cast()`, resolved live -- a cast track's lane header (design
   *  section 1.3, plan item 3), never the value stored on the track at
   *  creation time. `timeline.track.gone` for a member id the cast no
   *  longer holds; the track and its events are never auto-deleted. */
  function trackDisplayName(tr: TimelineTrack): { text: string; gone: boolean } {
    if (tr.kind !== "cast") return { text: tr.name, gone: false };
    const member = deps.cast().find((c) => c.id === tr.memberId);
    return member === undefined ? { text: t("timeline.track.gone"), gone: true } : { text: member.name, gone: false };
  }

  function renderOneLane(
    trackId: string,
    laneIndex: number,
    colour: number,
    headerText: string,
    events: readonly TimelineEvent[],
    dashed: boolean,
    branchId: string | null,
  ): HTMLElement {
    const lane = document.createElement("div");
    lane.className = "timeline-lane";
    if (dashed) lane.classList.add("timeline-lane-dashed");
    // THE REAL TRACK ID, ALWAYS -- never the branch group's composite
    // "b1:t1" a first draft used (review, BLOCKER): a branch lane's `branch`
    // membership lives in ITS OWN `dataset.branchId` below, so `laneRowAt`
    // (the drag's own lookup) and this lane's dblclick handler both read the
    // track an event actually belongs on.
    lane.dataset.trackId = trackId;
    // "" rather than omitting the attribute: `dataset.branchId` reads as
    // `undefined` either way from the DOM's own perspective, but an EXPLICIT
    // empty string is what `laneRowAt` below treats as "the main lane",
    // never confused with "no group id was ever set here at all".
    lane.dataset.branchId = branchId ?? "";
    lane.style.setProperty("--track-colour", trackColourVar(colour));

    const header = document.createElement("div");
    header.className = "timeline-lane-header";
    header.textContent = headerText;
    lane.append(header);

    const eventsLayer = document.createElement("div");
    eventsLayer.className = "timeline-lane-events";
    eventsLayer.addEventListener("dblclick", (e) => {
      if (e.target !== eventsLayer) return;
      const rect = eventsLayer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      // AN EVENT CREATED INSIDE A BRANCH GROUP CARRIES THAT BRANCH (review,
      // BLOCKER, plan item 1's own words: "Events created by double-click
      // inside a group get that `branch`").
      createEventAt(Math.round(pxToUnit(x, view)), trackId, branchId);
    });
    lane.append(eventsLayer);

    const marginPx = view.widthPx * CULL_MARGIN_SCREENS;
    const culled = cull(events, view, marginPx);
    const items = collapse(culled, view, MIN_GAP_PX);
    items.forEach((item, i) => {
      if (item.kind === "event") {
        const isMeeting = item.event.tracks.length > 1;
        const btn = eventButton(item.event, item.leftPx, isMeeting, laneIndex, trackId, branchId);
        const next = items[i + 1];
        if (next !== undefined && item.event.until === null) {
          const room = next.leftPx - item.leftPx - EVENT_GAP_PX;
          const clippedPx = Math.max(EVENT_MIN_WIDTH_PX, Math.min(EVENT_MAX_WIDTH_PX, room));
          btn.style.maxWidth = `${clippedPx}px`;
        }
        eventsLayer.append(btn);
      } else {
        eventsLayer.append(dotButton(item.leftPx, item.events, laneIndex));
      }
    });

    return lane;
  }

  /** `dot`'s own tooltip.ts anchor (plan item 5): "focus or hover lists the
   *  titles". Positioned itself, since createTooltip wraps `control` inside
   *  its own `anchor` element -- the caller appends the ANCHOR into the
   *  layer, not the button. Held so `destroy()` can tear every one down. */
  let dotTooltips: Tooltip[] = [];

  function dotButton(leftPx: number, events: readonly TimelineEvent[], laneIndex: number): HTMLElement {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "tl-dot";
    dot.textContent = String(events.length);
    const countLabel = plural("timeline.dot.count", events.length);
    dot.setAttribute("aria-label", countLabel);
    dot.dataset.eventIds = events.map((e) => e.id).join(",");
    // A dot's OWN lane, `.tl-event`'s reason (review, MINOR: dots were
    // reachable by mouse only past the first one on a lane -- arrow-key
    // navigation walked the MODEL's events and silently no-op'd the moment
    // a neighbour turned out to be inside a dot). The roving functions
    // below read this exactly as they read a `.tl-event` button's own.
    dot.dataset.lane = String(laneIndex);
    dot.tabIndex = -1;
    dot.addEventListener("click", () => zoomOnDot(dot, events));
    const tip = createTooltip({ control: dot, name: countLabel, hint: events.map((e) => e.title).join(", ") });
    // ADDED, not set: `tip.anchor` already carries tooltip.ts's own
    // "tip-anchor" class, which the tip's OWN absolute positioning is
    // relative to -- overwriting it would leave `.tip` positioned against
    // whichever ancestor happens to be positioned next (`.timeline-lane-events`),
    // not the dot it is meant to sit beside.
    tip.anchor.classList.add("tl-dot-anchor");
    tip.anchor.style.left = `${leftPx}px`;
    dotTooltips.push(tip);
    return tip.anchor;
  }

  function zoomOnDot(dot: HTMLButtonElement, events: readonly TimelineEvent[]): void {
    const layer = dot.closest<HTMLElement>(".timeline-lane-events");
    const rect = layer?.getBoundingClientRect();
    const anchor = dot.closest<HTMLElement>(".tl-dot-anchor");
    const pointerPx =
      anchor !== null && rect !== undefined ? anchor.getBoundingClientRect().left - rect.left : view.widthPx / 2;
    view = zoomToSeparate(view, events, pointerPx, MIN_GAP_PX, ZOOM_FACTOR);
    scheduleRepaint(true);
  }

  function render(): void {
    if (timeline === null) return;
    view.widthPx = widthPx();
    empty.hidden = timeline.tracks.length > 0;
    lanes.hidden = timeline.tracks.length === 0;
    scale.hidden = timeline.tracks.length === 0;
    scaleLabel.textContent = t("timeline.toolbar.scale", { unit: timeline.scale.unit });

    renderScale();
    // BOTH BAND ROWS ALSO NEED NO TRACKS -- `renderScale`/`renderCalendarBands`
    // decide their own hidden state from eras/the calendar alone, which
    // would unhide either row over an empty timeline that has neither.
    if (timeline.tracks.length === 0) {
      eraScale.hidden = true;
      calendarScale.hidden = true;
    }
    lanes.replaceChildren();
    for (const tip of dotTooltips) tip.destroy();
    dotTooltips = [];

    const la = laneAssignment(timeline);

    timeline.tracks.forEach((tr, laneIndex) => {
      const display = trackDisplayName(tr);
      const lane = renderOneLane(tr.id, laneIndex, tr.colour, display.text, la.main.get(tr.id) ?? [], false, null);
      if (display.gone) lane.classList.add("timeline-lane-gone");
      bindLaneHeader(lane, tr);
      lanes.append(lane);
    });

    renderBranches(la);

    // The roving tab stop: the first visible event or dot, so Tab into the
    // pane lands somewhere useful rather than nowhere at all.
    const firstItem = lanes.querySelector<HTMLButtonElement>(".tl-event, .tl-dot");
    if (firstItem !== null) firstItem.tabIndex = 0;

    paintStatus();
  }

  // ----------------------------------------------------------- branches (103)

  function renderBranches(la: ReturnType<typeof laneAssignment>): void {
    if (timeline === null) return;
    for (const b of timeline.branches) {
      const group = document.createElement("div");
      group.className = "timeline-branch-group";
      group.dataset.branchId = b.id;

      const header = document.createElement("div");
      header.className = "timeline-branch-header";
      const forkTrack = timeline.tracks.find((tr) => tr.id === b.forkTrack);
      const label = document.createElement("span");
      label.textContent = t("timeline.branch.header", {
        name: b.name,
        at: formatNumber(b.forkAt),
        track: forkTrack?.name ?? "",
      });
      header.append(label);

      const writeBtn = document.createElement("button");
      writeBtn.type = "button";
      writeBtn.textContent = b.writing ? t("timeline.branch.writing") : t("timeline.branch.not-writing");
      writeBtn.setAttribute("aria-pressed", String(b.writing));
      writeBtn.disabled = b.writing;
      writeBtn.addEventListener("click", () => setWritingBranch(b.id));
      header.append(writeBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = armedBranchDeleteId === b.id ? t("timeline.branch.delete.confirm") : t("timeline.branch.delete");
      if (armedBranchDeleteId === b.id) deleteBtn.setAttribute("data-armed", "true");
      deleteBtn.addEventListener("click", () => deleteBranch(b.id));
      header.append(deleteBtn);

      group.append(header);

      const groupTracks = branchTracks(timeline, b);
      groupTracks.forEach((trackId, i) => {
        const tr = timeline!.tracks.find((x) => x.id === trackId);
        if (tr === undefined) return;
        const display = trackDisplayName(tr);
        const events = la.branch.get(b.id)?.get(trackId) ?? [];
        const lane = renderOneLane(trackId, -1, tr.colour, display.text, events, true, b.id);
        if (i === 0) lane.classList.add("timeline-branch-fork-lane");
        group.append(lane);
      });

      lanes.append(group);
    }
  }

  function setWritingBranch(branchId: string): void {
    if (timeline === null) return;
    const steps: TimelineStep[] = timeline.branches.map((b) => ({
      kind: "set",
      entity: "branch",
      id: b.id,
      field: "writing",
      value: b.id === branchId,
    }));
    doEntry(steps);
  }

  function deleteBranch(branchId: string): void {
    if (timeline === null) return;
    const orphans = timeline.events.filter((e) => e.branch === branchId);
    if (armedBranchDeleteId !== branchId) {
      armedBranchDeleteId = branchId;
      // ANNOUNCED ON ARMING TOO (review, MINOR): the armed label is the
      // bare "Delete for good?", which never told the writer how many
      // events would go with it before they had to agree -- only the
      // second press did, after it was too late to change their mind.
      if (orphans.length > 0) {
        deps.onDone(plural("timeline.branch.delete.count", orphans.length));
      }
      render();
      return;
    }
    armedBranchDeleteId = null;
    const steps: TimelineStep[] = [
      { kind: "remove", entity: "branch", id: branchId },
      ...orphans.map((e): TimelineStep => ({ kind: "remove", entity: "event", id: e.id })),
    ];
    doEntry(steps);
    if (orphans.length > 0) {
      deps.onDone(plural("timeline.branch.delete.count", orphans.length));
    }
  }

  function paintStatus(): void {
    const p95 = zoomSamples.length === 0 ? 0 : percentiles(zoomSamples).p95;
    const visibleCount = lanes.querySelectorAll(".tl-event").length;
    // PX PER UNIT, TO 4 DECIMALS (103, plan item 7): `timeline_drag_moves`
    // reads this figure to compute the units an xdotool drag of a known
    // pixel distance is supposed to move `at` by -- the page's own live
    // scale, never a restated pixel-to-unit constant the rig could drift
    // from as the view zooms.
    const text = t("timeline.status", {
      p95: Math.round(p95),
      visible: visibleCount,
      pxPerUnit: view.pxPerUnit.toFixed(4),
    });
    status.textContent = text;
    status.setAttribute("aria-label", text);
  }

  function createEventAt(at: number, trackId: string, branchId: string | null): void {
    if (timeline === null) return;
    const id = mintId(timeline, "v");
    const value: TimelineEvent = {
      id,
      title: t("timeline.event.untitled"),
      at,
      until: null,
      tracks: [trackId],
      branch: branchId,
      scene: null,
      cast: [],
      note: "",
    };
    doEntry([{ kind: "add", entity: "event", value }]);
    const btn = lanes.querySelector<HTMLButtonElement>(`[data-event-id="${id}"]`);
    if (btn !== null) openCard(value, "edit", btn);
  }

  // ----------------------------------------------------- track kind & rename

  /** Set while a lane header shows an inline `<input>` instead of its text --
   *  a THREAD track only (plan item 3: a cast track's header "is not
   *  renamable; rename the member"). Cleared by Enter, Escape or a blur. */
  let renamingTrackId: string | null = null;

  function addThreadTrack(): void {
    if (timeline === null) return;
    const id = mintId(timeline, "t");
    const value: TimelineTrack = {
      id,
      name: t("timeline.track.default", { n: timeline.tracks.length + 1 }),
      kind: "thread",
      colour: (timeline.tracks.length % 8) + 1,
    };
    doEntry([{ kind: "add", entity: "track", value }]);
    renamingTrackId = id;
    render();
  }

  function addCastTrack(memberId: string, memberName: string): void {
    if (timeline === null) return;
    const id = mintId(timeline, "t");
    const value: TimelineTrack = {
      id,
      name: memberName,
      kind: "cast",
      memberId,
      colour: (timeline.tracks.length % 8) + 1,
    };
    doEntry([{ kind: "add", entity: "track", value }]);
  }

  const trackKindMenu = createMenuPanel({ id: "timeline-track-kind-menu" });
  const castMemberMenu = createMenuPanel({ id: "timeline-cast-member-menu" });
  document.body.append(trackKindMenu.element, castMemberMenu.element);
  trackKindMenu.element.style.position = "fixed";
  castMemberMenu.element.style.position = "fixed";
  const unsubscribeTrackKindOutside = closeOnOutsideClick(trackKindMenu.element, trackKindMenu.isOpen, trackKindMenu.close);
  const unsubscribeCastMemberOutside = closeOnOutsideClick(
    castMemberMenu.element,
    castMemberMenu.isOpen,
    castMemberMenu.close,
  );

  function placeMenuAt(el: HTMLElement, x: number, y: number): void {
    const box = el.getBoundingClientRect();
    const clamped = clampToViewport(x, y, box.width || 160, box.height || 80, window.innerWidth, window.innerHeight);
    el.style.left = `${clamped.x}px`;
    el.style.top = `${clamped.y}px`;
  }

  function openCastMemberMenu(anchorRect: DOMRect, onPick: (memberId: string, memberName: string) => void): void {
    const items: MenuItemSpec[] = deps.cast().map((member) => ({
      id: `timeline-cast-pick-${member.id}`,
      label: () => member.name,
      run: () => onPick(member.id, member.name),
    }));
    castMemberMenu.paint(items, t("timeline.track.new.cast"));
    document.body.append(castMemberMenu.element);
    placeMenuAt(castMemberMenu.element, anchorRect.left, anchorRect.bottom);
    castMemberMenu.focusItem(0);
  }

  function relinkTrack(trackId: string, memberId: string, memberName: string): void {
    doEntry([
      { kind: "set", entity: "track", id: trackId, field: "memberId", value: memberId },
      { kind: "set", entity: "track", id: trackId, field: "name", value: memberName },
    ]);
  }

  function openTrackKindMenu(anchorRect: DOMRect): void {
    const items: MenuItemSpec[] = [
      { id: "timeline-track-kind-thread", label: () => t("timeline.track.new.thread"), run: () => addThreadTrack() },
      {
        id: "timeline-track-kind-cast",
        label: () => t("timeline.track.new.cast"),
        run: () => openCastMemberMenu(anchorRect, (memberId, memberName) => addCastTrack(memberId, memberName)),
      },
    ];
    trackKindMenu.paint(items, t("timeline.toolbar.add-track"));
    document.body.append(trackKindMenu.element);
    placeMenuAt(trackKindMenu.element, anchorRect.left, anchorRect.bottom);
    trackKindMenu.focusItem(0);
  }

  function commitRename(input: HTMLInputElement, trackId: string): void {
    if (timeline === null) return;
    const tr = timeline.tracks.find((t2) => t2.id === trackId);
    if (tr === undefined) return;
    const next = commitTrackName(input.value, tr.name);
    renamingTrackId = null;
    if (next !== tr.name) doEntry([{ kind: "set", entity: "track", id: trackId, field: "name", value: next }]);
    else render();
  }

  const trackContextMenu = createMenuPanel({ id: "timeline-track-context-menu" });
  document.body.append(trackContextMenu.element);
  trackContextMenu.element.style.position = "fixed";
  const unsubscribeTrackContextOutside = closeOnOutsideClick(
    trackContextMenu.element,
    trackContextMenu.isOpen,
    trackContextMenu.close,
  );

  const onMenuKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    const menu = [trackKindMenu, castMemberMenu, trackContextMenu].find((candidate) => candidate.isOpen());
    if (menu === undefined) return;
    if (event.key === "Escape") {
      event.preventDefault();
      menu.close();
      (lanes.hidden ? emptyAddTrack : lanes).focus();
      return;
    }
    if (menu.element.contains(document.activeElement)) menu.handleArrowKey(event);
  };
  document.addEventListener("keydown", onMenuKeyDown);

  function deleteTrack(trackId: string): void {
    if (timeline === null) return;
    doEntry([{ kind: "remove", entity: "track", id: trackId }]);
  }

  function openLaneHeaderContextMenu(header: HTMLElement, tr: TimelineTrack, x: number, y: number): void {
    const items: MenuItemSpec[] =
      tr.kind === "thread"
        ? [
            {
              id: "timeline-track-rename",
              label: () => t("timeline.track.rename"),
              run: () => {
                renamingTrackId = tr.id;
                render();
              },
            },
            { id: "timeline-track-delete", label: () => t("timeline.track.delete"), run: () => deleteTrack(tr.id) },
          ]
        : [
            {
              id: "timeline-track-relink",
              label: () => t("timeline.track.relink"),
              run: () =>
                openCastMemberMenu(header.getBoundingClientRect(), (memberId, memberName) =>
                  relinkTrack(tr.id, memberId, memberName),
                ),
            },
            { id: "timeline-track-delete", label: () => t("timeline.track.delete"), run: () => deleteTrack(tr.id) },
          ];
    trackContextMenu.paint(items, tr.name);
    document.body.append(trackContextMenu.element);
    placeMenuAt(trackContextMenu.element, x, y);
    trackContextMenu.focusItem(0);
  }

  function bindLaneHeader(lane: HTMLElement, tr: TimelineTrack): void {
    const header = lane.querySelector<HTMLElement>(".timeline-lane-header");
    if (header === null) return;

    // KEYBOARD REACHABLE (review, MAJOR: a plain `div` with no `tabIndex`
    // had no keyboard route to the context menu at all -- double-click was
    // the ONLY path to rename). `role="button"` and an explicit
    // `aria-label` because the header's own text is either the track name
    // (thread) or the cast member's live name -- `trackDisplayName` is
    // read once here rather than trusting `header.textContent`, which the
    // rename branch below clears.
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    header.setAttribute("aria-label", trackDisplayName(tr).text);

    if (tr.kind === "thread" && renamingTrackId === tr.id) {
      header.textContent = "";
      const input = document.createElement("input");
      input.type = "text";
      input.value = tr.name;
      input.className = "timeline-lane-rename";
      input.setAttribute("aria-label", t("timeline.track.rename"));
      // SET BEFORE THE RE-RENDER, NOT AFTER (review, MINOR): an engine that
      // fires `blur` when its focused element is removed from the document
      // (Firefox does this; WebKitGTK is unverified here) would otherwise
      // run `commitRename` a second time on the very text Escape just
      // discarded -- `render()` below removes this input from the document
      // the instant it runs.
      let cancelled = false;
      input.addEventListener("keydown", (e) => {
        if (isCompositionKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commitRename(input, tr.id);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled = true;
          renamingTrackId = null;
          render();
        }
      });
      input.addEventListener("blur", () => {
        if (cancelled) return;
        commitRename(input, tr.id);
      });
      header.append(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    }

    if (tr.kind === "thread") {
      header.addEventListener("dblclick", () => {
        renamingTrackId = tr.id;
        render();
      });
    }

    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openLaneHeaderContextMenu(header, tr, e.clientX, e.clientY);
    });

    // THE MENU KEY AND SHIFT+F10 AT THE FOCUSED HEADER (review, MAJOR),
    // `nav-context-menu.ts`'s own chord, `isContextMenuChord` restated from
    // there rather than duplicated -- anchored at the header's own rect
    // since a keyboard activation carries no pointer coordinates.
    header.addEventListener("keydown", (e) => {
      if (isCompositionKey(e)) return;
      if (isContextMenuChord(e)) {
        e.preventDefault();
        const r = header.getBoundingClientRect();
        openLaneHeaderContextMenu(header, tr, r.left, r.bottom);
      }
    });
  }

  function zoom(factor: number, pointerPx: number): void {
    view = zoomAround(view, factor, pointerPx);
    scheduleRepaint(true);
  }

  function fit(): void {
    if (timeline === null) return;
    view = fitView(timeline.events, widthPx(), EVENT_MAX_WIDTH_PX);
    scheduleRepaint(true);
  }

  fitBtn.addEventListener("click", () => fit());
  zoomInBtn.addEventListener("click", () => zoom(ZOOM_FACTOR, widthPx() / 2));
  zoomOutBtn.addEventListener("click", () => zoom(1 / ZOOM_FACTOR, widthPx() / 2));
  addTrackBtn.addEventListener("click", () => openTrackKindMenu(addTrackBtn.getBoundingClientRect()));
  emptyAddTrack.addEventListener("click", () => openTrackKindMenu(emptyAddTrack.getBoundingClientRect()));
  editScaleBtn.addEventListener("click", () => {
    if (timeline === null) return;
    const anchorEl = document.getElementById("project-bar") ?? editScaleBtn;
    const anchor = anchorEl.getBoundingClientRect();
    const pane = container.getBoundingClientRect();
    scalePanel.open(timeline.scale, anchor, pane);
  });
  addBranchBtn.addEventListener("click", () => openBranchForm());

  // -------------------------------------------------------- + Branch (103)

  const branchForm = document.createElement("div");
  branchForm.id = "timeline-branch-form";
  branchForm.setAttribute("role", "dialog");
  branchForm.setAttribute("aria-modal", "false");
  branchForm.setAttribute("aria-labelledby", "timeline-branch-form-title");
  branchForm.tabIndex = -1;
  branchForm.style.position = "fixed";
  branchForm.hidden = true;
  document.body.append(branchForm);
  const unsubscribeBranchFormOutside = closeOnOutsideClick(
    branchForm,
    () => !branchForm.hidden,
    () => closeBranchForm(),
  );
  const onBranchFormKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event) || event.key !== "Escape") return;
    if (branchForm.hidden) return;
    event.preventDefault();
    closeBranchForm();
  };
  document.addEventListener("keydown", onBranchFormKeyDown, true);

  function closeBranchForm(): void {
    branchForm.hidden = true;
    branchForm.replaceChildren();
    lanes.focus();
  }

  function createBranch(name: string, forkAt: number, forkTrack: string): void {
    if (timeline === null) return;
    const id = mintId(timeline, "b");
    const value = { id, name: commitTrackName(name, t("timeline.branch.untitled")), forkAt, forkTrack, writing: false };
    doEntry([{ kind: "add", entity: "branch", value }]);
  }

  function openBranchForm(): void {
    if (timeline === null || timeline.tracks.length === 0) return;
    // Defaults from the currently focused event, when there is one (plan
    // item 1: "defaults from the selected event"); otherwise the viewport's
    // centre on the first track.
    const focused = focusedEvent();
    const defaultAt = focused?.event.at ?? Math.round(view.originUnit + view.widthPx / view.pxPerUnit / 2);
    const defaultTrack = focused?.event.tracks[0] ?? timeline.tracks[0]!.id;

    branchForm.replaceChildren();
    const title = document.createElement("h2");
    title.id = "timeline-branch-form-title";
    title.textContent = t("timeline.branch.form.title");
    branchForm.append(title);

    const form = document.createElement("form");
    form.addEventListener("submit", (e) => e.preventDefault());

    const nameLabel = document.createElement("label");
    nameLabel.textContent = t("timeline.branch.field.name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameLabel.append(nameInput);
    form.append(nameLabel);

    const atLabel = document.createElement("label");
    atLabel.textContent = t("timeline.branch.field.fork-at");
    const atInput = document.createElement("input");
    atInput.type = "number";
    atInput.step = "1";
    atInput.value = String(defaultAt);
    atLabel.append(atInput);
    form.append(atLabel);

    const trackLabel = document.createElement("label");
    trackLabel.textContent = t("timeline.branch.field.fork-track");
    const trackSelect = document.createElement("select");
    for (const tr of timeline.tracks) {
      const opt = document.createElement("option");
      opt.value = tr.id;
      opt.textContent = trackDisplayName(tr).text;
      trackSelect.append(opt);
    }
    trackSelect.value = defaultTrack;
    trackLabel.append(trackSelect);
    form.append(trackLabel);

    const buttons = document.createElement("div");
    buttons.className = "timeline-branch-form-buttons";
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.textContent = t("timeline.branch.create");
    createBtn.addEventListener("click", () => {
      const at = Number.parseInt(atInput.value, 10);
      createBranch(nameInput.value, Number.isFinite(at) ? at : defaultAt, trackSelect.value);
      closeBranchForm();
    });
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = t("timeline.branch.cancel");
    cancelBtn.addEventListener("click", () => closeBranchForm());
    buttons.append(createBtn, cancelBtn);
    form.append(buttons);
    branchForm.append(form);

    branchForm.hidden = false;
    const anchor = addBranchBtn.getBoundingClientRect();
    const pane = container.getBoundingClientRect();
    const box = branchForm.getBoundingClientRect();
    const placed = placeBubble({ selection: anchor, bubble: { width: box.width, height: box.height }, pane, viewport: { width: window.innerWidth, height: window.innerHeight } });
    branchForm.style.left = `${placed.left}px`;
    branchForm.style.top = `${placed.top}px`;
    nameInput.focus();
  }
  addEventBtn.addEventListener("click", () => {
    if (timeline === null || timeline.tracks.length === 0) return;
    createEventAt(Math.round(view.originUnit + view.widthPx / view.pxPerUnit / 2), timeline.tracks[0]!.id, null);
  });

  const onWheel = (event: WheelEvent): void => {
    if (timeline === null) return;
    notePointerActivity();
    if (event.ctrlKey) {
      event.preventDefault();
      const rect = lanes.getBoundingClientRect();
      const pointerPx = event.clientX - rect.left;
      const factor = event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      zoom(factor, pointerPx);
      return;
    }
    event.preventDefault();
    view = { ...view, originUnit: view.originUnit + event.deltaY / view.pxPerUnit };
    scheduleRepaint(false);
  };
  root.addEventListener("wheel", onWheel, { passive: false });

  let armed = false;
  let dragging = false;
  let dragStartX = 0;
  let dragStartOrigin = 0;
  const onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof HTMLElement && event.target.closest(".tl-event, .tl-dot, button")) return;
    armed = true;
    dragging = false;
    dragStartX = event.clientX;
    dragStartOrigin = view.originUnit;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!armed) return;
    if (!dragging) {
      if (Math.abs(event.clientX - dragStartX) < PAN_THRESHOLD_PX) return;
      dragging = true;
      lanes.setPointerCapture(event.pointerId);
    }
    notePointerActivity();
    const dxPx = event.clientX - dragStartX;
    view = { ...view, originUnit: dragStartOrigin - dxPx / view.pxPerUnit };
    scheduleRepaint(false);
  };
  const onPointerUp = (): void => {
    armed = false;
    dragging = false;
  };
  lanes.addEventListener("pointerdown", onPointerDown);
  lanes.addEventListener("pointermove", onPointerMove);
  lanes.addEventListener("pointerup", onPointerUp);

  function focusedEvent(): { event: TimelineEvent; lane: number } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const id = active.dataset.eventId;
    if (id === undefined || timeline === null) return null;
    const ev = timeline.events.find((e) => e.id === id);
    if (ev === undefined) return null;
    const lane = Number(active.dataset.lane ?? "0");
    return { event: ev, lane };
  }

  function focusButtonFor(eventId: string): void {
    const btn = lanes.querySelector<HTMLButtonElement>(`[data-event-id="${eventId}"]`);
    if (btn === null) return;
    lanes.querySelectorAll<HTMLButtonElement>(".tl-event").forEach((b) => (b.tabIndex = -1));
    btn.tabIndex = 0;
    btn.focus();
  }

  interface RovingItem {
    el: HTMLButtonElement;
    leftPx: number;
  }

  /** Every focusable item on a MAIN lane -- events AND dots (review, MINOR:
   *  arrow-key navigation used to walk the model's own events and silently
   *  no-op the moment a neighbour turned out to be collapsed into a dot),
   *  in SCREEN ORDER left to right. A dot's own position is its
   *  `.tl-dot-anchor` wrapper's `left`, never the button's own (the anchor
   *  is what carries the coordinate; see `dotButton`). */
  function rovingItemsOnLane(laneIndex: number): RovingItem[] {
    const items: RovingItem[] = [];
    lanes.querySelectorAll<HTMLButtonElement>(`.tl-event[data-lane="${laneIndex}"]`).forEach((el) => {
      items.push({ el, leftPx: Number.parseFloat(el.style.left) || 0 });
    });
    lanes.querySelectorAll<HTMLElement>(".tl-dot-anchor").forEach((anchor) => {
      const dot = anchor.querySelector<HTMLButtonElement>(".tl-dot");
      if (dot === null || dot.dataset.lane !== String(laneIndex)) return;
      items.push({ el: dot, leftPx: Number.parseFloat(anchor.style.left) || 0 });
    });
    items.sort((a, b) => a.leftPx - b.leftPx);
    return items;
  }

  /** The focused button's own lane and screen position, whether it is an
   *  event or a dot -- the roving equivalent of `focusedEvent()`, which
   *  only ever answers for a real event. */
  function focusedRoving(): { laneIndex: number; leftPx: number } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (active.classList.contains("tl-event")) {
      const laneIndex = Number(active.dataset.lane ?? "-1");
      return { laneIndex, leftPx: Number.parseFloat(active.style.left) || 0 };
    }
    if (active.classList.contains("tl-dot")) {
      const laneIndex = Number(active.dataset.lane ?? "-1");
      const anchor = active.closest<HTMLElement>(".tl-dot-anchor");
      const leftPx = anchor !== null ? Number.parseFloat(anchor.style.left) || 0 : 0;
      return { laneIndex, leftPx };
    }
    return null;
  }

  function focusRovingItem(el: HTMLButtonElement): void {
    lanes.querySelectorAll<HTMLButtonElement>(".tl-event, .tl-dot").forEach((b) => (b.tabIndex = -1));
    el.tabIndex = 0;
    el.focus();
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (timeline === null) return;
    // ESCAPE CANCELS A DRAG (design section 4, plan item 4), checked before
    // anything else this handler does: the drop never commits and a
    // re-render (nothing in `timeline` changed) puts the dragged button back
    // exactly where it started.
    if (event.key === "Escape" && drag !== null) {
      event.preventDefault();
      endDrag(false);
      render();
      return;
    }
    // ENTER ON A DOT ZOOMS UNTIL THE GROUP SEPARATES (plan item 5), mutation
    // target 6's own case: checked against the FOCUSED element directly,
    // because a dot carries no `data-event-id` for `focusedEvent()` below to
    // find.
    if (event.key === "Enter") {
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && active.classList.contains("tl-dot")) {
        event.preventDefault();
        const ids = (active.dataset.eventIds ?? "").split(",").filter((s) => s !== "");
        const events = timeline.events.filter((e) => ids.includes(e.id));
        if (events.length > 0) zoomOnDot(active, events);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (!event.ctrlKey && !event.metaKey) {
      if (event.key === "-") {
        event.preventDefault();
        zoom(1 / ZOOM_FACTOR, view.widthPx / 2);
        return;
      }
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoom(ZOOM_FACTOR, view.widthPx / 2);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        fit();
        return;
      }
    }
    const current = focusedEvent();
    if (event.key === "Enter") {
      if (current === null) return;
      event.preventDefault();
      const btn = lanes.querySelector<HTMLButtonElement>(`[data-event-id="${current.event.id}"]`);
      if (btn !== null) openCard(current.event, "read", btn);
      return;
    }
    if (event.key === "Delete") {
      if (current === null) return;
      event.preventDefault();
      if (armedDeleteId === current.event.id) {
        doEntry([{ kind: "remove", entity: "event", id: current.event.id }]);
        armedDeleteId = null;
      } else {
        armedDeleteId = current.event.id;
        // render() rebuilds the lane DOM wholesale, which would otherwise
        // drop focus off the button the writer just armed -- and the SECOND
        // Delete press reads focusedEvent() from document.activeElement, so
        // a lost focus here would silently turn "arm, then delete" into
        // "arm, then nothing" the moment a writer actually presses it twice.
        render();
        focusButtonFor(current.event.id);
      }
      return;
    }
    // Any other key disarms delete (the cast panel's own rule).
    if (armedDeleteId !== null) {
      armedDeleteId = null;
      render();
    }
    // ARROW NAVIGATION WALKS SCREEN ORDER, EVENTS AND DOTS ALIKE (review,
    // MINOR): `focusedEvent()` above answers only for a real event, so a
    // dot's own position is read through `focusedRoving()` instead --
    // `current` (from `focusedEvent()`) is still what Enter and Delete act
    // on, above, since neither means anything for a dot.
    const roving = focusedRoving();
    if (roving === null) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const items = rovingItemsOnLane(roving.laneIndex);
      const idx = items.findIndex((it) => it.leftPx === roving.leftPx);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = items[idx + step];
      if (next !== undefined) focusRovingItem(next.el);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextLane = roving.laneIndex + step;
      // BOUNDED TO THE MAIN LANES [0, tracks.length) -- branch-group items
      // carry lane index -1 (`renderOneLane`'s own convention), which would
      // otherwise match going ArrowUp from lane 0 and jump focus into a
      // group arrow navigation was never meant to reach.
      if (nextLane < 0 || nextLane >= timeline.tracks.length) return;
      const items = rovingItemsOnLane(nextLane);
      if (items.length === 0) return;
      let nearest = items[0]!;
      let best = Math.abs(nearest.leftPx - roving.leftPx);
      for (const it of items) {
        const d = Math.abs(it.leftPx - roving.leftPx);
        if (d < best) {
          best = d;
          nearest = it;
        }
      }
      focusRovingItem(nearest.el);
    }
  };
  root.tabIndex = -1;
  root.addEventListener("keydown", onKeyDown);

  if (timeline !== null) {
    view = fitView(timeline.events, widthPx(), EVENT_MAX_WIDTH_PX);
    render();
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pointerStillTimer !== null) clearTimeout(pointerStillTimer);
      card.destroy();
      scalePanel.destroy();
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("keydown", onKeyDown);
      lanes.removeEventListener("pointerdown", onPointerDown);
      lanes.removeEventListener("pointermove", onPointerMove);
      lanes.removeEventListener("pointerup", onPointerUp);
      lanes.removeEventListener("pointermove", onDragPointerMove);
      lanes.removeEventListener("pointerup", onDragPointerUp);
      lanes.removeEventListener("pointercancel", onDragPointerCancel);
      for (const tip of dotTooltips) tip.destroy();
      dotTooltips = [];
      document.removeEventListener("keydown", onBranchFormKeyDown, true);
      unsubscribeBranchFormOutside();
      branchForm.remove();
      document.removeEventListener("keydown", onMenuKeyDown);
      trackKindMenu.destroy();
      castMemberMenu.destroy();
      trackContextMenu.destroy();
      unsubscribeTrackKindOutside();
      unsubscribeCastMemberOutside();
      unsubscribeTrackContextOutside();
      container.classList.remove("timeline-open");
      root.remove();
    },
    focus() {
      const firstEvent = lanes.querySelector<HTMLButtonElement>(".tl-event");
      if (firstEvent !== null) firstEvent.focus();
      else lanes.focus();
    },
    setBody(body: string) {
      const next = parseTimeline(body);
      if ("newer" in next) {
        deps.onNotice(t("timeline.newer"));
        return;
      }
      if ("invalid" in next) {
        deps.onNotice(t("timeline.invalid"));
        return;
      }
      timeline = next;
      view = fitView(timeline.events, widthPx(), EVENT_MAX_WIDTH_PX);
      render();
    },
    view: () => view,
  };
}
