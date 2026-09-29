// app/ui/src/status-dot.ts
// One dot in the footer for the three copies' sentences.

import { isCompositionKey } from "./composition-key";
import { closeOnOutsideClick } from "./dismiss-outside";
import { t } from "./i18n";
import type { ArchiveState } from "./archive-indicator";
import type { MirrorState } from "./mirror-indicator";
import type { RecoveryState } from "./recovery-indicator";
import { createTooltip, type Tooltip } from "./tooltip";

// ONE DOT, THREE SENTENCES. The bar carried four status sentences at one
// weight and they read as loud as the menus (2026-09-02 captures). The dot
// answers "is anything wrong" and the popover answers "what"; the three
// indicator modules keep computing their sentences and render into the
// popover, so nothing about what the writer is told changed - only where.
//
// THE COLOUR IS A PURE FUNCTION OF THREE STATES fed by the indicators'
// onState callbacks. The dot never reads the indicators' DOM: a data-state
// attribute is the stylesheet's channel, not this module's.
//
// AMBER, NEVER --danger. The danger ink is reserved for "your work is not in
// the file", the save indicator's alone (style.css beside #save-indicator).
//
// THREE STATES SINCE 236 (the calm-panels record amends 067). A copy that is
// merely not set up is NEUTRAL: a new book has no archive and no readable
// folder, and a dot that was amber for every new book taught the writer to
// ignore it. AMBER is kept for a copy that failed, went stale or is paused,
// and only then does the dot carry a visible label. A copy that has not
// reported yet is not a failure either, so it counts as neutral: the dot must
// not flash a warning at every mount while the first answers are in flight.
//
// ONE ACTION PER SENTENCE THAT NEEDS ONE, each a button after its sentence
// that runs the command the menus and the project panel already own. The dot
// does no copying of its own.

export type DotState = "quiet" | "neutral" | "amber";

export interface CopyStates {
  recovery: RecoveryState | null;
  archive: ArchiveState | null;
  mirror: MirrorState | null;
}

const QUIET_RECOVERY: ReadonlySet<RecoveryState> = new Set(["protected"]);
const QUIET_ARCHIVE: ReadonlySet<ArchiveState> = new Set(["taken"]);
const QUIET_MIRROR: ReadonlySet<MirrorState> = new Set(["current", "updating", "finding", "not_applicable"]);
/** Something went wrong with a copy that exists. `unavailable` stays here as
 *  before: the folder is written but its identity check could not run, and
 *  its sentence asks the writer to inspect it before sharing. */
const AMBER_RECOVERY: ReadonlySet<RecoveryState> = new Set(["attempt-failed", "stale"]);
const AMBER_MIRROR: ReadonlySet<MirrorState> = new Set(["paused", "failing", "stale", "unavailable"]);

/** Amber when any copy failed, went stale or is paused; quiet only when all
 *  three have reported a content state; neutral otherwise (not set up, or not
 *  reported yet). */
export function dotState(states: CopyStates): DotState {
  if (
    (states.recovery !== null && AMBER_RECOVERY.has(states.recovery)) ||
    (states.mirror !== null && AMBER_MIRROR.has(states.mirror))
  ) return "amber";
  const quiet =
    states.recovery !== null &&
    QUIET_RECOVERY.has(states.recovery) &&
    states.archive !== null &&
    QUIET_ARCHIVE.has(states.archive) &&
    states.mirror !== null &&
    QUIET_MIRROR.has(states.mirror);
  return quiet ? "quiet" : "neutral";
}

export interface StatusDotDeps {
  /** #status-controls. The button is mounted BEFORE the popover, which is
   *  static markup inside the same span. */
  container: HTMLElement;
  /** #status-popover, already holding the three indicator anchors. */
  popover: HTMLElement;
  openChanges?: () => void;
  /** The File menu's Back up now. Offered while recovery has no point, failed
   *  or went stale. */
  backupNow?: () => void;
  /** The project panel's Make an archive. Offered while there is none. */
  makeArchive?: () => void;
  /** Opens the project panel, where the readable folder is turned on. Offered
   *  while the folder is off. */
  openMirrorSetup?: () => void;
}

export interface StatusDot {
  report<K extends keyof CopyStates>(which: K, state: NonNullable<CopyStates[K]>): void;
  /** The dot as painted now. The project panel reads it on open (240). */
  state(): DotState;
  destroy(): void;
}

export function createStatusDot(deps: StatusDotDeps): StatusDot {
  const { container, popover } = deps;
  const states: CopyStates = { recovery: null, archive: null, mirror: null };

  const button = document.createElement("button");
  button.id = "status-dot";
  button.type = "button";
  // aria-expanded and aria-controls only. NO aria-haspopup: on its own that
  // makes the ATK role `combo box`, outside the WANTED set in nodes.ts, and
  // NO aria-pressed, which makes it `toggle button`. It is a push button.
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", popover.id);

  popover.setAttribute("aria-label", t("status.popover.label"));
  popover.tabIndex = -1;

  // Built once: createTooltip moves the button INTO its anchor, and the
  // anchor is what goes in the DOM, before the static popover. Renamed by
  // paint() rather than rebuilt, or the button would move between anchors on
  // every state change.
  const tooltip: Tooltip = createTooltip({ control: button, name: "", hint: null });

  // Visible words beside the dot, only while amber: a colour alone does not
  // say anything to a writer who has not learned what it means. Inside the
  // button so the strip gains no item; the name stays the aria-label.
  const label = document.createElement("span");
  label.className = "status-dot-label";
  label.textContent = t("status.label.amber");
  label.hidden = true;
  button.append(label);

  const setOpen = (open: boolean): void => {
    popover.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };

  interface Action {
    readonly el: HTMLButtonElement;
    readonly run: () => void;
    readonly wanted: () => boolean;
  }
  const actions: Action[] = [];
  const onAction = (event: Event): void => {
    const action = actions.find((a) => a.el === event.currentTarget);
    setOpen(false);
    action?.run();
  };
  /** After its sentence's anchor when the popover has one, so each action
   *  reads under what it answers; appended in order otherwise. */
  const addAction = (id: string, text: string, after: string, run: (() => void) | undefined, wanted: () => boolean): void => {
    if (run === undefined) return;
    const el = document.createElement("button");
    el.id = id;
    el.type = "button";
    el.className = "status-action";
    el.textContent = text;
    el.addEventListener("click", onAction);
    const anchor = popover.querySelector(`#${after}`);
    if (anchor !== null) anchor.after(el);
    else popover.append(el);
    actions.push({ el, run, wanted });
  };
  addAction("status-backup-now", t("menu.backup-now"), "recovery-controls", deps.backupNow,
    () => states.recovery !== null && states.recovery !== "protected");
  addAction("status-make-archive", t("switcher.archive.action"), "archive-controls", deps.makeArchive,
    () => states.archive === "none");
  addAction("status-mirror-setup", t("status.action.mirror-setup"), "mirror-controls", deps.openMirrorSetup,
    () => states.mirror === "off");
  // The folder's one action once it exists. Shown before the first report, as
  // it always was; hidden only while the folder is off, when setup replaces it.
  addAction("status-open-changes", t("menu.mirror-changes"), "mirror-controls", deps.openChanges,
    () => states.mirror !== "off");

  const paint = (): void => {
    const state = dotState(states);
    button.dataset.state = state;
    const name = t(`status.name.${state}`);
    button.setAttribute("aria-label", name);
    label.hidden = state !== "amber";
    // The tip's text is the name, so a dot that went quiet under the pointer
    // stops saying "attention".
    tooltip.setName(name);
    for (const action of actions) action.el.hidden = !action.wanted();
  };

  const onClick = (): void => {
    const opening = popover.hidden;
    setOpen(opening);
    if (opening) popover.focus();
  };

  const onPopoverKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event) || event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    button.focus();
  };

  // ESCAPE ON THE DOT ITSELF. Shift+Tab out of the open popover lands on the
  // dot, and Escape there reaches the tooltip's own keydown, which hides the
  // tip and nothing else. Focus stays where it is: the writer is already on
  // the control.
  const onButtonKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event) || event.key !== "Escape") return;
    if (popover.hidden) return;
    event.preventDefault();
    setOpen(false);
  };

  paint();
  container.prepend(tooltip.anchor);
  button.addEventListener("click", onClick);
  button.addEventListener("keydown", onButtonKeyDown);
  popover.addEventListener("keydown", onPopoverKeyDown);
  // THE CONTAINER IS THE CLOSER'S PANEL, not the popover. The closer runs in
  // the capture phase, so with the popover as its panel a second click on the
  // dot would close the popover first and onClick would then see it hidden
  // and open it again: a dot that cannot be clicked shut. #status-controls
  // holds exactly the dot and the popover, so a click on either is "inside".
  const stopOutsideClick = closeOnOutsideClick(container, () => !popover.hidden, () => setOpen(false));

  return {
    report(which, state) {
      states[which] = state;
      paint();
    },
    state: () => dotState(states),
    destroy(): void {
      setOpen(false);
      button.removeEventListener("click", onClick);
      button.removeEventListener("keydown", onButtonKeyDown);
      popover.removeEventListener("keydown", onPopoverKeyDown);
      for (const action of actions) {
        action.el.removeEventListener("click", onAction);
        action.el.remove();
      }
      stopOutsideClick();
      tooltip.destroy();
      tooltip.anchor.remove();
    },
  };
}
