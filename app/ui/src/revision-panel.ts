// app/ui/src/revision-panel.ts
// Where does this stand? The surface that answers it for the selected row.
//
// A PANEL, NOT A BAR CONTROL, for the geometry reason every panel since the
// import slice has been one: the project bar's 39px and the outline bar's 34px
// are click-geometry constants restated in five rigs, and a sixth control in
// either strip risks wrapping it. This hangs off #project-bar exactly as
// #stats-panel, #history-panel and #find-panel do, and costs the bar nothing.
//
// IT ACTS ON THE SELECTION AND READS IT LIVE, never on a captured row. The
// writer moves the selection between opening the panel and pressing a button -
// with the panel open, an arrow key still reaches the navigator - and a captured
// id would mark a row they are no longer looking at. Same rule as the outline
// bar's `selectedId`.
import { formatNumber, t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { TRASH_TYPE, BIBLE_TYPE, FRONT_MATTER_TYPE, BACK_MATTER_TYPE } from "./item-types";
import {
  NO_STATE_LABEL,
  REVISION_STATES,
  STATE_LABELS,
  STATE_MARKS,
  isRevisionState,
  type RevisionState,
} from "./revision-states";

/** The row this panel is about, as the page currently sees it. */
export interface SelectedRow {
  readonly id: string;
  readonly title: string;
  /** What the store last said. `string | null` rather than the narrow type for
   *  the reason store/source.ts gives: a newer build's state must arrive as data
   *  rather than as a type error. */
  readonly state: string | null;
  readonly type?: string;
}

export interface RevisionPassRow {
  id: number; name: string; purpose: string | null;
  open_count: number; done_count: number;
}

export interface RevisionTaskRow {
  id: number; body: string; item_id: string | null;
  target_caption: string | null; target_title: string | null;
  binned: boolean; pass_id: number | null; done: boolean;
}

export interface RevisionPlanningApi {
  passes(): Promise<RevisionPassRow[]>;
  tasks(): Promise<RevisionTaskRow[]>;
  createPass(name: string, purpose: string | null): Promise<unknown>;
  updatePass(id: number, name: string, purpose: string | null): Promise<unknown>;
  deletePass(id: number): Promise<unknown>;
  createTask(body: string, itemId: string | null, passId: number | null): Promise<unknown>;
  updateTask(id: number, body: string, passId: number | null): Promise<unknown>;
  setDone(id: number, done: boolean): Promise<unknown>;
  deleteTask(id: number): Promise<unknown>;
}

/** What setting it did. The outline unit's own outcome, passed straight
 *  through: it already distinguishes an applied change from one the store
 *  refused, and it has already raised the banner for the second. */
export type SetStateOutcome = "applied" | "inert" | "failed";

export interface RevisionPanelDeps {
  readonly container: HTMLElement;
  /** The selected row, read at every paint. Null when nothing is selected. */
  selected(): SelectedRow | null;
  /** null clears the state. Resolves once the store has answered AND the walk
   *  has been re-read, so `selected()` afterwards is the new truth. */
  setState(itemId: string, state: RevisionState | null): Promise<SetStateOutcome>;
  planning?: RevisionPlanningApi;
  /** Where focus goes when the panel is dismissed with Escape. */
  onDismiss(): void;
}

export interface RevisionPanel {
  open(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** What the panel says when there is no row to act on.
 *
 *  Its own sentence, distinct from a failure and from a state of "none": those
 *  are three different things and a reader acts differently on each. The
 *  recorded defect is a `catch` painting the designed empty state, so a
 *  directory that could not be read was reported as one holding nothing. */
export const NO_SELECTION = t("state.no-selection");

const FAILED = t("state.failed");

export function createRevisionPanel(deps: RevisionPanelDeps): RevisionPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "state-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert, so claiming modal
  // would be a lie a screen reader acts on.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("state.panel.label"));
  // So Escape is heard even before a button is focused. Escape only fires while
  // focus is inside the panel, and the recorded failure of the fifth panel is
  // one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;

  const status = document.createElement("div");
  status.id = "state-status";
  // A status rather than an alert: this reports which row is being marked and
  // what just happened to it, which is information, not an interruption.
  status.setAttribute("role", "status");

  const choices = document.createElement("div");
  choices.id = "state-choices";
  // A group rather than a radiogroup, for the reason the preferences panel gives
  // for the same shape: radio semantics carry arrow-key roving-focus
  // expectations this panel does not implement, and promising an interaction
  // model that is not there is worse than not promising it.
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", t("state.choices.label"));

  /** Keyed by the value the button sets: the four states, and "" for the
   *  absence. Held so a repaint is an attribute write per button rather than a
   *  rebuild - rebuilding would destroy the button the writer just pressed and
   *  drop focus to <body>, which is the recorded history-panel defect. */
  const buttons = new Map<string, HTMLButtonElement>();

  function addChoice(value: string, mark: string, label: string): void {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `state-choice-${value === "" ? "none" : value}`;
    button.dataset.stateValue = value;

    const glyph = document.createElement("span");
    glyph.className = "state-mark";
    // The label beside it already says the word; a mark read aloud is a
    // character name.
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = mark;

    const text = document.createElement("span");
    text.textContent = label;

    button.append(glyph, text);
    choices.append(button);
    buttons.set(value, button);
  }

  for (const state of REVISION_STATES) {
    addChoice(state, STATE_MARKS[state], STATE_LABELS[state]);
  }
  // LAST, and it is the default rather than a fifth state - see
  // revision-states.ts. It is offered because a writer who marked a row must be
  // able to unmark it, and the only spelling of that is the absence.
  addChoice("", "", NO_STATE_LABEL);

  panel.append(status, choices);
  // Close, Escape and a click elsewhere (the shell's). Built before planning
  // mounts, so the planning section lands in the shell's body.
  const shell = createPanelShell({
    panel,
    title: t("state.heading"),
    titleId: "state-heading",
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
  });
  const planning = deps.planning === undefined ? null : mountPlanning(shell.body, deps);
  container.append(panel);

  let destroyed = false;
  /** An answer that resolves after a newer press, or after the panel closed,
   *  must not repaint: the writer would be shown the previous choice as
   *  current. */
  let generation = 0;

  function paint(message?: string): void {
    const row = deps.selected();
    const current = row !== null && isRevisionState(row.state) ? row.state : "";
    for (const [value, button] of buttons) {
      // aria-pressed on every button rather than a class on the chosen one: the
      // state has to reach a screen reader, and "which of these is in effect" is
      // exactly what a toggle button's pressed state means.
      button.setAttribute("aria-pressed", String(row !== null && value === current));
      // A button that cannot act says so, rather than looking live and doing
      // nothing - the same reason the menu's Back item names its own emptiness.
      button.disabled = row === null;
    }
    if (message !== undefined) {
      status.textContent = message;
      return;
    }
    status.textContent = row === null ? NO_SELECTION : row.title;
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-state-value]");
    if (!(button instanceof HTMLElement)) return;
    const value = button.dataset.stateValue;
    if (value === undefined) return;
    const row = deps.selected();
    // Not merely a guard: the buttons are disabled with no selection, so this is
    // reachable only if the selection left between the paint and the click.
    // Saying so beats a silent return, which is the recorded empty-query defect
    // - a control that does nothing and does not say why.
    if (row === null) {
      paint(NO_SELECTION);
      return;
    }
    const next = isRevisionState(value) ? value : null;
    generation += 1;
    const mine = generation;
    void deps
      .setState(row.id, next)
      .then((outcome) => {
        if (destroyed || mine !== generation) return;
        // `inert` means the row already stood there, so there is nothing to
        // report and nothing changed. `failed` has already raised the outline's
        // own banner with the detail; this says the short version in the surface
        // the writer is looking at.
        paint(outcome === "failed" ? FAILED : undefined);
      })
      .catch(() => {
        if (destroyed || mine !== generation) return;
        paint(FAILED);
      });
  };

  panel.addEventListener("click", onClick);

  return {
    open(): void {
      setOpen(true);
      // Repainted on every open, never once at construction: the selection and
      // its state have both moved since the panel was built.
      paint();
      void planning?.refresh();
      panel.focus();
    },
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      destroyed = true;
      planning?.destroy();
      shell.destroy();
      panel.removeEventListener("click", onClick);
      panel.remove();
    },
  };
}

/** Where the task field starts saying how long it may be: 90% of its 4,000. */
const TASK_LIMIT_NEAR = 3600;

function mountPlanning(panel: HTMLElement, deps: RevisionPanelDeps): { refresh(): Promise<void>; destroy(): void } {
  const api = deps.planning!;
  const section = document.createElement("section");
  section.id = "revision-planning";
  const title = document.createElement("h2");
  title.textContent = t("planning.heading");
  const message = document.createElement("p");
  message.id = "planning-message";
  message.setAttribute("role", "status");
  const passHeading = document.createElement("h3");
  passHeading.textContent = t("planning.passes");
  const passSelect = document.createElement("select");
  passSelect.id = "planning-pass-filter";
  passSelect.setAttribute("aria-label", t("planning.pass-filter"));
  const passDraftTarget = document.createElement("p");
  passDraftTarget.id = "planning-pass-draft-target";
  const passName = document.createElement("input");
  passName.id = "planning-pass-name";
  passName.maxLength = 120;
  passName.placeholder = t("planning.pass-name");
  passName.setAttribute("aria-label", t("planning.pass-name"));
  const passPurpose = document.createElement("textarea");
  passPurpose.id = "planning-pass-purpose";
  passPurpose.maxLength = 1000;
  passPurpose.rows = 2;
  passPurpose.placeholder = t("planning.pass-purpose");
  passPurpose.setAttribute("aria-label", t("planning.pass-purpose"));
  const passButtons = document.createElement("div");
  passButtons.className = "planning-actions";
  const createPass = action("planning.pass-create");
  const newPass = action("planning.pass-new");
  const savePass = action("planning.pass-save");
  const discardPass = action("planning.pass-discard");
  const removePass = action("planning.pass-remove");
  // ONE PRIMARY, DESTRUCTIVE AS INK (238): five equal buttons gave Discard the
  // same weight as Create. Creating a pass is this row's reason; New only
  // clears the fields; Discard and Remove throw work away.
  createPass.dataset.weight = "primary";
  newPass.dataset.weight = "quiet";
  discardPass.dataset.weight = "danger";
  removePass.dataset.weight = "danger";
  passButtons.append(newPass, createPass, savePass, discardPass, removePass);
  const taskHeading = document.createElement("h3");
  taskHeading.textContent = t("planning.tasks");
  const scope = document.createElement("select");
  scope.id = "planning-scope";
  scope.setAttribute("aria-label", t("planning.scope"));
  option(scope, "book", t("planning.scope-book"));
  option(scope, "selected", t("planning.scope-selected"));
  option(scope, "all", t("planning.scope-all"));
  scope.value = "all";
  const taskList = document.createElement("div");
  taskList.id = "planning-task-list";
  const taskTarget = document.createElement("p");
  taskTarget.id = "planning-task-target";
  const taskBody = document.createElement("textarea");
  taskBody.id = "planning-task-body";
  taskBody.maxLength = 4000;
  taskBody.rows = 3;
  taskBody.placeholder = t("planning.task-placeholder");
  taskBody.setAttribute("aria-label", t("planning.task-text"));
  // THE LIMIT IS SAID NEAR THE LIMIT (239), not printed under an empty
  // field: the field already stops at 4,000 characters.
  const limit = document.createElement("p");
  limit.className = "planning-limit";
  limit.textContent = t("planning.task-limit");
  const syncLimit = (): void => { limit.hidden = taskBody.value.length < TASK_LIMIT_NEAR; };
  syncLimit();
  taskBody.addEventListener("input", syncLimit);
  const taskPass = document.createElement("select");
  taskPass.id = "planning-task-pass";
  taskPass.setAttribute("aria-label", t("planning.task-pass"));
  const taskButtons = document.createElement("div");
  taskButtons.className = "planning-actions";
  const saveTask = action("planning.task-save");
  const discardTask = action("planning.task-discard");
  discardTask.dataset.weight = "danger";
  taskButtons.append(saveTask, discardTask);
  section.append(title, message, passHeading, passSelect, passDraftTarget, passName, passPurpose, passButtons,
    taskHeading, scope, taskList, taskTarget, taskBody, limit, taskPass, taskButtons);
  panel.append(section);

  let passes: RevisionPassRow[] = [];
  let tasks: RevisionTaskRow[] = [];
  let loading = 0;
  let destroyed = false;
  let editingTask: number | null = null;
  let draftTarget: { id: string | null; title: string } | null = null;
  let confirmTask: number | null = null;
  let confirmPass: number | null = null;
  let passDraftDirty = false;
  let passDraftId: number | null = null;
  let passDraftLabel = "";
  let passDraftVersion = 0;
  let taskDraftVersion = 0;
  let taskDraftDirty = false;
  let mutationPending = false;

  function action(key: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t(key);
    return button;
  }
  function option(select: HTMLSelectElement, value: string, label: string): void {
    const entry = document.createElement("option");
    entry.value = value;
    entry.textContent = label;
    select.append(entry);
  }
  function selectedTarget(): { id: string | null; title: string } {
    if (scope.value !== "selected") return { id: null, title: t("planning.scope-book") };
    const row = deps.selected();
    return row === null || !linkable(row)
      ? { id: null, title: t("planning.no-selection") }
      : { id: row.id, title: row.title };
  }
  function linkable(row: SelectedRow): boolean {
    return ![TRASH_TYPE, BIBLE_TYPE, FRONT_MATTER_TYPE, BACK_MATTER_TYPE].includes(row.type ?? "");
  }
  function showTarget(): void {
    const target = draftTarget ?? selectedTarget();
    taskTarget.textContent = t("planning.target", { title: target.title });
  }
  function passId(value: string): number | null {
    return value === "" ? null : Number(value);
  }
  function renderSelectors(): void {
    const filter = passSelect.value;
    const draft = taskPass.value;
    passSelect.replaceChildren();
    option(passSelect, "all", t("planning.pass-all"));
    option(passSelect, "none", t("planning.pass-none"));
    taskPass.replaceChildren();
    option(taskPass, "", t("planning.pass-none"));
    for (const pass of passes) {
      option(passSelect, String(pass.id), t("planning.pass-counts", { name: pass.name, open: formatNumber(pass.open_count), done: formatNumber(pass.done_count) }));
      option(taskPass, String(pass.id), pass.name);
    }
    passSelect.value = [...passSelect.options].some((o) => o.value === filter) ? filter : "all";
    taskPass.value = [...taskPass.options].some((o) => o.value === draft) ? draft : "";
    const chosen = passes.find((p) => String(p.id) === passSelect.value);
    passDraftTarget.textContent = passDraftDirty
      ? t("planning.pass-editing", { name: passDraftLabel }) : "";
    // Refill only when there is no pass draft. A network response must not erase typing.
    if (!passDraftDirty) {
      passName.value = chosen?.name ?? "";
      passPurpose.value = chosen?.purpose ?? "";
    }
    savePass.disabled = (passDraftDirty ? passDraftId === null : chosen === undefined);
    removePass.disabled = chosen === undefined;
    const row = deps.selected();
    scope.querySelector<HTMLOptionElement>('option[value="selected"]')!.disabled = row === null || !linkable(row);
  }
  function renderTasks(): void {
    const focused = document.activeElement instanceof HTMLElement && taskList.contains(document.activeElement)
      ? document.activeElement : null;
    const focusRow = focused?.closest<HTMLElement>(".planning-task")?.dataset.taskId;
    const focusAction = focused?.dataset.action;
    taskList.replaceChildren();
    const selectedId = deps.selected()?.id;
    const shown = tasks.filter((task) => {
      if (scope.value === "book" && task.item_id !== null) return false;
      if (scope.value === "selected" && task.item_id !== selectedId) return false;
      if (passSelect.value === "none" && task.pass_id !== null) return false;
      if (passSelect.value !== "all" && passSelect.value !== "none" && String(task.pass_id) !== passSelect.value) return false;
      return true;
    });
    if (shown.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = t("planning.empty");
      taskList.append(empty);
    }
    for (const task of shown) {
      const row = document.createElement("div");
      row.className = "planning-task";
      row.dataset.taskId = String(task.id);
      const body = document.createElement("p");
      body.textContent = task.body;
      if (task.done) body.className = "planning-done";
      const context = document.createElement("small");
      context.textContent = task.item_id === null && task.target_caption === null
        ? t("planning.scope-book")
        : task.item_id === null
          ? t("planning.target-removed", { title: task.target_caption ?? "" })
          : task.binned
            ? t("planning.target-binned", { title: task.target_title ?? task.target_caption ?? "" })
            : task.target_title ?? task.target_caption ?? "";
      const actions = document.createElement("div");
      actions.className = "planning-actions";
      const done = action(task.done ? "planning.reopen" : "planning.done");
      done.dataset.action = "done";
      done.addEventListener("click", () => void mutate(() => api.setDone(task.id, !task.done)));
      const edit = action("planning.edit");
      edit.dataset.action = "edit";
      edit.addEventListener("click", () => {
        if (taskDraftDirty && editingTask === task.id) {
          taskBody.focus();
          return;
        }
        if (taskDraftDirty) {
          message.textContent = t("planning.discard-task-first");
          taskBody.focus();
          return;
        }
        editingTask = task.id;
        draftTarget = { id: task.item_id, title: context.textContent ?? "" };
        taskBody.value = task.body;
        syncLimit();
        taskPass.value = task.pass_id === null ? "" : String(task.pass_id);
        taskDraftVersion += 1;
        taskDraftDirty = false;
        showTarget();
        taskBody.focus();
      });
      const remove = action(confirmTask === task.id ? "planning.confirm-remove" : "planning.remove");
      remove.dataset.action = "remove";
      remove.addEventListener("click", () => {
        if (confirmTask !== task.id) {
          confirmTask = task.id;
          remove.textContent = t("planning.confirm-remove");
          return;
        }
        confirmTask = null;
        void mutate(() => api.deleteTask(task.id));
      });
      actions.append(done, edit, remove);
      row.append(body, context, actions);
      taskList.append(row);
    }
    if (focusRow !== undefined) {
      const next = [...taskList.querySelectorAll<HTMLElement>(".planning-task")]
        .find((row) => row.dataset.taskId === focusRow)
        ?.querySelector<HTMLElement>(`[data-action="${focusAction ?? ""}"]`);
      (next ?? scope).focus();
    }
  }
  async function refresh(): Promise<void> {
    const mine = ++loading;
    try {
      const [newPasses, newTasks] = await Promise.all([api.passes(), api.tasks()]);
      if (destroyed || mine !== loading) return;
      passes = newPasses;
      tasks = newTasks;
      renderSelectors();
      renderTasks();
      showTarget();
      message.textContent = "";
    } catch (error) {
      if (!destroyed && mine === loading) message.textContent = t("planning.load-failed", { error: String(error) });
    }
  }
  async function mutate(op: () => Promise<unknown>, after?: () => void): Promise<void> {
    if (mutationPending) return;
    mutationPending = true;
    section.setAttribute("aria-busy", "true");
    for (const button of section.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    try {
      await op();
      if (destroyed) return;
      after?.();
      await refresh();
    } catch (error) {
      if (!destroyed) message.textContent = t("planning.save-failed", { error: String(error) });
    } finally {
      mutationPending = false;
      section.removeAttribute("aria-busy");
      if (!destroyed) {
        for (const button of section.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
        renderSelectors();
      }
    }
  }
  function clearTask(): void {
    taskDraftVersion += 1;
    taskDraftDirty = false;
    editingTask = null;
    draftTarget = null;
    taskBody.value = "";
    syncLimit();
    taskPass.value = "";
    showTarget();
  }
  taskBody.addEventListener("input", () => {
    taskDraftVersion += 1;
    taskDraftDirty = true;
    if (draftTarget === null) draftTarget = selectedTarget();
    showTarget();
  });
  taskPass.addEventListener("change", () => { taskDraftVersion += 1; taskDraftDirty = true; });
  saveTask.addEventListener("click", () => {
    if (taskBody.value.trim() === "") { message.textContent = t("planning.task-required"); return; }
    const target = draftTarget ?? selectedTarget();
    if (editingTask === null && scope.value === "selected" && target.id === null) {
      message.textContent = t("planning.no-selection"); return;
    }
    const body = taskBody.value;
    const pass = passId(taskPass.value);
    const id = editingTask;
    const version = taskDraftVersion;
    void mutate(() => id === null ? api.createTask(body, target.id, pass) : api.updateTask(id, body, pass),
      () => { if (taskDraftVersion === version) clearTask(); });
  });
  discardTask.addEventListener("click", clearTask);
  passSelect.addEventListener("change", () => {
    confirmPass = null;
    removePass.textContent = t("planning.pass-remove");
    renderSelectors(); renderTasks();
  });
  scope.addEventListener("change", () => { renderTasks(); showTarget(); });
  function markPassDirty(): void {
    if (!passDraftDirty) {
      const current = passes.find((p) => String(p.id) === passSelect.value);
      passDraftId = current?.id ?? null;
      passDraftLabel = current?.name ?? t("planning.pass-new");
    }
    passDraftDirty = true;
    passDraftVersion += 1;
    renderSelectors();
  }
  passName.addEventListener("input", markPassDirty);
  passPurpose.addEventListener("input", markPassDirty);
  function clearPass(): void {
    passDraftDirty = false;
    passDraftId = null;
    passDraftLabel = "";
    passDraftVersion += 1;
    renderSelectors();
  }
  newPass.addEventListener("click", () => {
    if (passDraftDirty) { message.textContent = t("planning.discard-pass-first"); return; }
    passSelect.value = "all";
    clearPass();
    passName.focus();
  });
  discardPass.addEventListener("click", clearPass);
  createPass.addEventListener("click", () => {
    if (passDraftDirty && passDraftId !== null) { message.textContent = t("planning.discard-pass-first"); return; }
    if (passName.value.trim() === "") { message.textContent = t("planning.pass-required"); return; }
    const name = passName.value;
    const purpose = passPurpose.value || null;
    const version = passDraftVersion;
    void mutate(() => api.createPass(name, purpose), () => {
      if (passDraftVersion === version) clearPass();
    });
  });
  savePass.addEventListener("click", () => {
    const id = passDraftDirty ? passDraftId : Number(passSelect.value);
    if (id === null || !passes.some((p) => p.id === id)) return;
    if (passName.value.trim() === "") { message.textContent = t("planning.pass-required"); return; }
    const name = passName.value;
    const purpose = passPurpose.value || null;
    const version = passDraftVersion;
    void mutate(() => api.updatePass(id, name, purpose), () => {
      if (passDraftVersion === version) clearPass();
    });
  });
  removePass.addEventListener("click", () => {
    if (passDraftDirty) { message.textContent = t("planning.discard-pass-first"); return; }
    const id = Number(passSelect.value);
    if (confirmPass !== id) {
      confirmPass = id;
      removePass.textContent = t("planning.pass-confirm-remove");
      return;
    }
    confirmPass = null;
    removePass.textContent = t("planning.pass-remove");
    void mutate(() => api.deletePass(id), () => { passSelect.value = "all"; });
  });
  return { refresh, destroy: () => { destroyed = true; loading += 1; } };
}
