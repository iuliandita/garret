// app/ui/src/timeline-card.ts
// The event card (102, design section 4): read mode, then an in-place form.
//
// ON <body>, `position: fixed`, LIKE `#format-bubble` AND `#cast-card`, AND
// FOR THEIR REASON: `#editor { will-change: transform }` (064) holds only
// while `#editor` has no positioned descendant. The lanes themselves ARE a
// recorded exception to that rule (see timeline-view.ts's header) but the
// card is not one more of them -- it floats OVER the lanes and the prose
// pane alike, so it stays a sibling on `<body>`, positioned from
// `bubble-placement.ts`'s pure geometry exactly as those two are.
//
// A FRESH MOUNT PER OPEN. Nothing here diffs a previous card against a new
// one: `open()` replaces the panel's children outright, which is what keeps
// read/edit and one event/another event from being four states of one
// long-lived form instead of two renders of a short-lived one.
import { isCompositionKey } from "./composition-key";
import { formatNumber, t } from "./i18n";
import { placeBubble, type Rect } from "./bubble-placement";
import { matchItems, type QuickOpenItem } from "./quick-open";
import { calendarDate, type TimelineBranch, type TimelineCalendar, type TimelineEvent, type TimelineTrack } from "./timeline-model";
import type { CastMemberRow } from "./cast-panel";

export interface TimelineCardDeps {
  /** `<body>`, or a test's stand-in. */
  container: HTMLElement;
  cast(): readonly CastMemberRow[];
  /** Openable items, for the scene picker's substring match. */
  items(): readonly QuickOpenItem[];
  /** The scene's title, or undefined for a binned or missing id -- the same
   *  distinction `timeline.scene.gone` reports. */
  sceneTitle(sceneId: string): string | undefined;
  calendar(): TimelineCalendar | null;
  /** The document's branches (103, plan item 1): "The card's branch select
   *  moves an event between main and branches." */
  branches(): readonly TimelineBranch[];
  /** One field at a time so the caller can turn each into its own undo
   *  step (`timeline-model.ts`'s `set`), matching the outline's own grain. */
  onSave(eventId: string, patch: Partial<Omit<TimelineEvent, "id">>): void;
  onDelete(eventId: string): void;
  onOpenScene(sceneId: string): void;
  onDismiss(): void;
}

export interface TimelineCard {
  /** Opens the card over `event`, positioned beside `anchor` (the pressed
   *  event button's viewport rect) and clamped to `pane`. */
  open(
    event: TimelineEvent,
    tracks: readonly TimelineTrack[],
    anchor: Rect,
    pane: Rect,
    mode: "read" | "edit",
  ): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const SCENE_PICK_LIMIT = 8;

export function createTimelineCard(deps: TimelineCardDeps): TimelineCard {
  const panel = document.createElement("div");
  panel.id = "timeline-card";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  // Self-focusing, like #comments-panel and the other four dialogs
  // control-weight.test.ts pins to tabIndex = -1: focusable so read mode has
  // somewhere to put the caret and so Escape is heard, but not a tab stop.
  // Edit mode focuses the title field instead (a real control), which is why
  // only the read-mode branch below calls panel.focus().
  panel.tabIndex = -1;
  panel.style.position = "fixed";
  panel.hidden = true;
  deps.container.append(panel);

  let currentEvent: TimelineEvent | null = null;
  let currentTracks: readonly TimelineTrack[] = [];
  let armed = false;
  let destroyed = false;

  function place(anchor: Rect, pane: Rect): void {
    const box = panel.getBoundingClientRect();
    const placed = placeBubble({ selection: anchor, bubble: { width: box.width, height: box.height }, pane, viewport: { width: window.innerWidth, height: window.innerHeight } });
    panel.style.left = `${placed.left}px`;
    panel.style.top = `${placed.top}px`;
  }

  function disarm(): void {
    armed = false;
  }

  function renderRead(anchor: Rect, pane: Rect): void {
    if (currentEvent === null) return;
    const ev = currentEvent;
    panel.replaceChildren();

    const title = document.createElement("h2");
    title.textContent = ev.title;
    panel.append(title);

    const when = document.createElement("p");
    const calendar = deps.calendar();
    const date = calendar === null ? null : calendarDate(ev.at, calendar);
    when.textContent =
      date === null
        ? t("timeline.card.when", { at: formatNumber(ev.at) })
        : t("timeline.card.when-dated", { at: formatNumber(ev.at), date: date.label });
    panel.append(when);

    if (ev.tracks.length > 0) {
      const trackNames = ev.tracks
        .map((id) => currentTracks.find((tr) => tr.id === id)?.name)
        .filter((n): n is string => n !== undefined);
      const tracksLine = document.createElement("p");
      tracksLine.textContent = t("timeline.card.tracks", { tracks: trackNames.join(", ") });
      panel.append(tracksLine);
    }

    if (ev.scene !== null) {
      const sceneTitle = deps.sceneTitle(ev.scene);
      const sceneLine = document.createElement("p");
      sceneLine.textContent =
        sceneTitle === undefined
          ? t("timeline.scene.gone")
          : t("timeline.card.scene", { title: sceneTitle });
      panel.append(sceneLine);
    }

    if (ev.cast.length > 0) {
      const names = ev.cast
        .map((id) => deps.cast().find((c) => c.id === id)?.name)
        .filter((n): n is string => n !== undefined);
      if (names.length > 0) {
        const castLine = document.createElement("p");
        castLine.textContent = t("timeline.card.cast", { cast: names.join(", ") });
        panel.append(castLine);
      }
    }

    if (ev.note.trim().length > 0) {
      const note = document.createElement("p");
      note.textContent = ev.note;
      panel.append(note);
    }

    const buttons = document.createElement("div");
    buttons.className = "timeline-card-buttons";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = t("timeline.card.edit");
    editBtn.addEventListener("click", () => {
      disarm();
      renderEdit(anchor, pane);
    });
    buttons.append(editBtn);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = t("timeline.card.open-scene");
    const sceneOk = ev.scene !== null && deps.sceneTitle(ev.scene) !== undefined;
    openBtn.disabled = !sceneOk;
    openBtn.addEventListener("click", () => {
      if (ev.scene === null) return;
      disarm();
      // CLOSED BEFORE the call, quick-open.ts's own rule: onOpenScene routes
      // through openDocument, which awaits doc_load, and a card left open
      // and interactive over that in-flight switch is a card describing
      // whichever document happens to load, floating over the scene once
      // it does -- the writer already asked to go there.
      close();
      deps.onOpenScene(ev.scene);
    });
    buttons.append(openBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = armed ? t("timeline.card.delete.confirm") : t("timeline.card.delete");
    if (armed) deleteBtn.setAttribute("data-armed", "true");
    deleteBtn.addEventListener("click", () => {
      if (armed) {
        deps.onDelete(ev.id);
        close();
        return;
      }
      armed = true;
      renderRead(anchor, pane);
    });
    buttons.append(deleteBtn);

    panel.append(buttons);
    place(anchor, pane);
  }

  function renderEdit(anchor: Rect, pane: Rect): void {
    if (currentEvent === null) return;
    const ev = currentEvent;
    panel.replaceChildren();

    const form = document.createElement("form");
    form.addEventListener("submit", (e) => e.preventDefault());

    const titleLabel = document.createElement("label");
    titleLabel.textContent = t("timeline.card.field.title");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = ev.title;
    titleInput.addEventListener("keydown", (e) => {
      if (isCompositionKey(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    titleLabel.append(titleInput);
    form.append(titleLabel);

    const atLabel = document.createElement("label");
    atLabel.textContent = t("timeline.card.field.at");
    const atInput = document.createElement("input");
    atInput.type = "number";
    atInput.step = "1";
    atInput.value = String(ev.at);
    atLabel.append(atInput);
    form.append(atLabel);

    const untilLabel = document.createElement("label");
    untilLabel.textContent = t("timeline.card.field.until");
    const untilInput = document.createElement("input");
    untilInput.type = "number";
    untilInput.step = "1";
    untilInput.value = ev.until === null ? "" : String(ev.until);
    untilLabel.append(untilInput);
    form.append(untilLabel);

    const trackFieldset = document.createElement("fieldset");
    const trackLegend = document.createElement("legend");
    trackLegend.textContent = t("timeline.card.field.tracks");
    trackFieldset.append(trackLegend);
    const trackBoxes: HTMLInputElement[] = [];
    for (const tr of currentTracks) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.trackId = tr.id;
      box.checked = ev.tracks.includes(tr.id);
      trackBoxes.push(box);
      label.append(box, document.createTextNode(tr.name));
      trackFieldset.append(label);
    }
    form.append(trackFieldset);

    // MOVES AN EVENT BETWEEN MAIN AND BRANCHES (plan item 1). The main line
    // is `branch: null` -- there is no branch record for it (design section
    // 2) -- so its option carries the empty string and every real branch's
    // option carries its id.
    const branchLabel = document.createElement("label");
    branchLabel.textContent = t("timeline.card.field.branch");
    const branchSelect = document.createElement("select");
    const mainOption = document.createElement("option");
    mainOption.value = "";
    mainOption.textContent = t("timeline.card.field.branch.main");
    branchSelect.append(mainOption);
    for (const b of deps.branches()) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name;
      branchSelect.append(opt);
    }
    branchSelect.value = ev.branch ?? "";
    branchLabel.append(branchSelect);
    form.append(branchLabel);

    // The scene picker: a substring field over the openable items, EXACTLY
    // quick-open.ts's own ranking (`matchItems`), imported rather than
    // reimplemented so the two surfaces cannot rank the same query
    // differently.
    const sceneLabel = document.createElement("label");
    sceneLabel.textContent = t("timeline.card.field.scene");
    const sceneInput = document.createElement("input");
    sceneInput.type = "text";
    // A combobox pairing, quick-open.ts's own shape: aria-activedescendant is
    // only meaningful with a role that names which row it points into, and
    // this field keeps focus throughout (moving it onto the rows would put
    // up to SCENE_PICK_LIMIT items in the card's tab order for one field).
    sceneInput.setAttribute("role", "combobox");
    sceneInput.setAttribute("aria-expanded", "true");
    sceneInput.setAttribute("aria-controls", "timeline-card-scene-results");
    sceneInput.setAttribute("aria-autocomplete", "list");
    const initialScene = ev.scene === null ? undefined : deps.items().find((i) => i.id === ev.scene);
    sceneInput.value = initialScene?.title ?? "";
    let sceneChoice: string | null = ev.scene;
    const sceneResults = document.createElement("div");
    sceneResults.id = "timeline-card-scene-results";
    sceneResults.setAttribute("role", "listbox");
    let sceneShown: QuickOpenItem[] = [];
    // REVIEW ITEM 11: Enter always picked shown[0] and nothing announced
    // which row that was -- a writer arrowing to the third match had no way
    // to tell the field agreed before pressing Enter and no way to pick
    // anything but the first result at all.
    let sceneActive = 0;

    const markSceneActive = (): void => {
      const rows = [...sceneResults.children];
      for (const [index, row] of rows.entries()) {
        if (!(row instanceof HTMLElement)) continue;
        row.setAttribute("aria-selected", index === sceneActive ? "true" : "false");
      }
      const current = rows[sceneActive];
      if (current instanceof HTMLElement) {
        sceneInput.setAttribute("aria-activedescendant", current.id);
      } else {
        sceneInput.removeAttribute("aria-activedescendant");
      }
    };

    const paintScenePicker = (): void => {
      const { shown } = matchItems(deps.items(), sceneInput.value);
      sceneShown = shown.slice(0, SCENE_PICK_LIMIT);
      sceneActive = 0;
      sceneResults.replaceChildren();
      for (const [index, item] of sceneShown.entries()) {
        const row = document.createElement("div");
        row.id = `timeline-card-scene-${item.id}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", index === 0 ? "true" : "false");
        row.textContent = item.title;
        row.dataset.itemId = item.id;
        sceneResults.append(row);
      }
      markSceneActive();
    };
    const pickScene = (item: QuickOpenItem): void => {
      sceneChoice = item.id;
      sceneInput.value = item.title;
      sceneResults.replaceChildren();
      sceneInput.removeAttribute("aria-activedescendant");
    };
    sceneInput.addEventListener("input", () => {
      sceneChoice = null;
      paintScenePicker();
    });
    sceneInput.addEventListener("keydown", (e) => {
      if (isCompositionKey(e)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (sceneShown.length === 0) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        sceneActive = (sceneActive + step + sceneShown.length) % sceneShown.length;
        markSceneActive();
        return;
      }
      if (e.key === "Enter" && sceneShown.length > 0) {
        e.preventDefault();
        pickScene(sceneShown[sceneActive]!);
      }
    });
    sceneResults.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const id = target.dataset.itemId;
      if (id === undefined) return;
      const picked = sceneShown.find((i) => i.id === id);
      if (picked === undefined) return;
      pickScene(picked);
    });
    sceneLabel.append(sceneInput);
    form.append(sceneLabel, sceneResults);

    const castFieldset = document.createElement("fieldset");
    const castLegend = document.createElement("legend");
    castLegend.textContent = t("timeline.card.field.cast");
    castFieldset.append(castLegend);
    const castBoxes: HTMLInputElement[] = [];
    for (const member of deps.cast()) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.castId = member.id;
      box.checked = ev.cast.includes(member.id);
      castBoxes.push(box);
      label.append(box, document.createTextNode(member.name));
      castFieldset.append(label);
    }
    form.append(castFieldset);

    const noteLabel = document.createElement("label");
    noteLabel.textContent = t("timeline.card.field.note");
    const noteInput = document.createElement("textarea");
    noteInput.value = ev.note;
    noteLabel.append(noteInput);
    form.append(noteLabel);

    const buttons = document.createElement("div");
    buttons.className = "timeline-card-buttons";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = t("timeline.card.save");
    saveBtn.addEventListener("click", () => save());
    buttons.append(saveBtn);
    form.append(buttons);

    panel.append(form);
    place(anchor, pane);
    titleInput.focus();
    titleInput.select();

    function save(): void {
      if (currentEvent === null) return;
      const at = Number.parseInt(atInput.value, 10);
      const untilRaw = untilInput.value.trim();
      const until = untilRaw === "" ? null : Number.parseInt(untilRaw, 10);
      const tracks = trackBoxes.filter((b) => b.checked).map((b) => b.dataset.trackId!);
      const cast = castBoxes.filter((b) => b.checked).map((b) => b.dataset.castId!);
      deps.onSave(currentEvent.id, {
        title: titleInput.value,
        at: Number.isFinite(at) ? at : ev.at,
        until: until === null || Number.isFinite(until) ? until : ev.until,
        tracks,
        branch: branchSelect.value === "" ? null : branchSelect.value,
        scene: sceneChoice,
        cast,
        note: noteInput.value,
      });
      close();
    }
  }

  function close(): void {
    panel.hidden = true;
    panel.replaceChildren();
    currentEvent = null;
    armed = false;
  }

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Escape") return;
    if (panel.hidden) return;
    event.preventDefault();
    close();
    deps.onDismiss();
  };
  const onOutsideClick = (event: Event): void => {
    if (panel.hidden) return;
    const target = event.target;
    if (target instanceof Node && panel.contains(target)) return;
    close();
    deps.onDismiss();
  };
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onOutsideClick, true);

  return {
    open(event, tracks, anchor, pane, mode) {
      currentEvent = event;
      currentTracks = tracks;
      armed = false;
      panel.hidden = false;
      if (mode === "edit") {
        renderEdit(anchor, pane);
      } else {
        renderRead(anchor, pane);
        panel.focus();
      }
    },
    close,
    isOpen: () => !panel.hidden,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onOutsideClick, true);
      panel.remove();
    },
  };
}
