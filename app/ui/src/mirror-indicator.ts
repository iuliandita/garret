// app/ui/src/mirror-indicator.ts
// One span in the project bar answering a question neither indicator beside it
// answers: is the folder I can open in another editor keeping up with what I
// have typed.
//
// READ THIS WITH `recovery-indicator.ts` AND `archive-indicator.ts`. The three
// share a line box and are deliberately about three different things. Those two
// are protections -- one on this device, one that must leave it -- and this one
// is not a protection at all. It reports the CURRENCY of a projection: a folder
// of ordinary Markdown, on the same disk as the manuscript, that this
// application writes and does not read back. A writer who came to believe it
// was a backup would be relying on a copy that dies with the drive.
// `mirror-strings.test.ts` is what keeps that from eroding one string at a
// time, and it is the strongest of the three wording guards for that reason.
//
// EVERY STATE IS ABOUT THE FOLDER, NEVER ABOUT THE BOOK. The manuscript is
// unaffected by all of them, including `failing`: a mirror that cannot be
// written is a stale projection and nothing else. That is why none of this is
// modal, none of it is a banner, and none of it interrupts -- and also why none
// of it is merely logged, because "my folder is up to date" is exactly the
// belief this feature can falsify.
//
// role="group", NOT role="status", for `save-indicator.ts:15-20`'s recorded
// finding. This value changes when a pass lands, which can be while the writer
// is mid-sentence, and `status` plus `aria-live="off"` still announces on
// WebKitGTK.

import { plural, t } from "./i18n";
import { formatWhen } from "./recovery-indicator";

/** The host's event name, restated here rather than imported from the switcher:
 *  this unit and the panel both listen, and a page that had to reach into a
 *  panel to learn an event name would couple the bar to it. */
export const MIRROR_EVENT = "app://mirror-changed";

/** The host's `mirror::MirrorReport`, as `mirror_status` returns it. Field
 *  names are the host's, snake_case by the recorded rule: command ARGUMENTS
 *  are camelCase, returned struct fields are not. */
export interface MirrorReport {
  /** Whether the writer turned it on for this project. OFF IS THE DEFAULT and
   *  is not a failure. */
  readonly enabled: boolean;
  /** The RESOLVED destination. The panel shows it; this span never does. */
  readonly dir: string;
  readonly files: number;
  /** When the last pass finished, from the MANIFEST on disk. Deliberately not
   *  `last_run_ms`: the two disagree after a pass that failed before writing,
   *  and this is the one that describes the folder. */
  readonly generated_at: number | null;
  readonly last_ok: boolean;
  readonly last_error: string | null;
  readonly last_run_ms: number | null;
  /** How many entries have a pending inbound change. */
  readonly paused: number;
  /** Whether a pass is owed. */
  readonly updating: boolean;
  /** Location of a known other-identity occurrence written to the folder. */
  readonly finding: string | null;
  /** An older or unreadable report must not read as a clean check. */
  readonly identity_check: "clear" | "finding" | "not_applicable" | "unavailable";
}

export type MirrorState = "current" | "updating" | "paused" | "failing" | "stale" | "finding" | "not_applicable" | "unavailable" | "off";

export interface MirrorView {
  readonly state: MirrorState;
  /** What the writer reads in the bar. */
  readonly text: string;
  /** What a screen reader says. Longer, because a name has no bar around it to
   *  give it context -- and because the cause, the count and the finding's
   *  location all only fit here. */
  readonly label: string;
}

export interface MirrorIndicatorDeps {
  readonly container: HTMLElement;
  readonly status: () => Promise<MirrorReport>;
  readonly subscribe?: (onEvent: () => void) => Promise<unknown>;
  /** Every state the indicator paints, in order, the opening one included.
   *  The footer's status dot is the one listener: it colours itself from the
   *  three indicators' states and never reads their DOM. */
  readonly onState?: (state: MirrorState) => void;
  readonly now?: () => number;
}

export interface MirrorIndicator {
  set(view: MirrorView): void;
  refresh(): Promise<void>;
  destroy(): void;
}

/** What the report is saying, in one place, so the element below is only paint.
 *
 *  THE ORDER OF THESE BRANCHES IS THE DESIGN, not a convenience:
 *
 *  `failing` and `paused` come first because both mean the folder has stopped
 *  keeping up, and a writer can act on both. `updating` is transient and true
 *  for ten seconds at a time, so it must not hide either of them -- a pause
 *  reported as `updating` would flip to `paused` when the next pass landed and
 *  read as flapping rather than as a fact.
 *
 *  `finding` comes LAST of the positives and never outranks a negative, because
 *  it means "current, WITH a finding". The design spends a paragraph on this:
 *  a finding does not pause the mirror, does not skip the entry and does not
 *  fail the pass. Reporting it as either of those would claim the folder is out
 *  of date at the exact moment it is exactly current, which is the falsehood
 *  this whole indicator is built to avoid. */
export function describe(report: MirrorReport, now: number): MirrorView {
  const when =
    report.generated_at === null
      ? t("mirror.when.never")
      : formatWhen(report.generated_at, now);

  if (!report.enabled) {
    // Disabling LEAVES THE FILES, so a folder that was written once is still
    // sitting in the writer's manuscripts directory, exactly as old as the
    // moment they switched it off. Saying only "folder off" would describe
    // something that is there.
    if (report.generated_at === null) {
      return { state: "off", text: t("mirror.text.off"), label: t("mirror.name.off") };
    }
    return {
      state: "stale",
      text: t("mirror.text.stale", { when }),
      label: t("mirror.name.stale", { when }),
    };
  }

  if (!report.last_ok) {
    return {
      state: "failing",
      text: t("mirror.text.failing", { when }),
      // NAMES THE CAUSE, which the design requires of this state: "the mirror
      // is failing" with nothing after it is a sentence a writer cannot act on.
      label: t("mirror.name.failing", { when, error: report.last_error ?? "" }),
    };
  }

  if (report.paused > 0) {
    return {
      state: "paused",
      text: t("mirror.text.paused", { when }),
      label: plural("mirror.name.paused", report.paused, { when }),
    };
  }

  // A mirror just turned on has no folder yet to be current. The enable act
  // passes immediately, so this is the moment between the two -- and reporting
  // `current` for an empty directory is the same lie with a shorter fuse.
  if (report.updating || report.generated_at === null) {
    return {
      state: "updating",
      text: t("mirror.text.updating"),
      label: t("mirror.name.updating"),
    };
  }

  // `typeof`, not `!== null`. The host sends `finding: null` and a host that
  // stopped sending the field at all would make `undefined !== null` true and
  // render the finding state around a location that is not there. This is the
  // one field on this report whose absence is indistinguishable from a value.
  if (typeof report.finding === "string" && report.finding !== "") {
    return {
      state: "finding",
      text: t("mirror.text.finding"),
      label: t("mirror.name.finding", { where: report.finding }),
    };
  }

  if (report.identity_check === "unavailable") {
    return {
      state: "unavailable",
      text: t("mirror.text.unavailable"),
      label: t("mirror.name.unavailable"),
    };
  }

  if (report.identity_check === "not_applicable") {
    return {
      state: "not_applicable",
      text: t("mirror.text.not_applicable"),
      label: t("mirror.name.not_applicable"),
    };
  }

  return { state: "current", text: t("mirror.text.current"), label: t("mirror.name.current") };
}

export function createMirrorIndicator(deps: MirrorIndicatorDeps): MirrorIndicator {
  const { container } = deps;
  const clock = deps.now ?? ((): number => Date.now());

  container.replaceChildren();

  const element = document.createElement("span");
  element.id = "mirror-indicator";
  element.setAttribute("role", "group");

  let destroyed = false;
  let unlisten: (() => void) | null = null;

  const set = (view: MirrorView): void => {
    element.textContent = view.text;
    element.setAttribute("aria-label", view.label);
    // For the stylesheet, and for a rig that wants the state rather than the
    // wording. A wording change must not break a selector.
    element.dataset.state = view.state;
    deps.onState?.(view.state);
  };

  // Opens on `off`, for the reason both indicators beside it open on their
  // negatives: the first answer is one await away, and a bar reporting a
  // current folder before anything had been read would be this surface's own
  // failure mode.
  set(
    describe(
      {
        enabled: false,
        dir: "",
        files: 0,
        generated_at: null,
        last_ok: true,
        last_error: null,
        last_run_ms: null,
        paused: 0,
        updating: false,
        finding: null,
        identity_check: "unavailable",
      },
      clock(),
    ),
  );

  container.append(element);

  const refresh = async (): Promise<void> => {
    let report: MirrorReport;
    try {
      report = await deps.status();
    } catch {
      // LEAVE THE LAST THING SAID STANDING. A bridge that stopped answering
      // says nothing about the folder on disk, and repainting the negative
      // here would report a missing mirror because a call failed.
      return;
    }
    set(describe(report, clock()));
  };

  if (deps.subscribe !== undefined) {
    void deps
      .subscribe(() => {
        void refresh();
      })
      .then((handle: unknown) => {
        if (typeof handle === "function") unlisten = handle as () => void;
        // The project may already have been torn down by the time the handle
        // arrives; releasing it here is the only chance left.
        if (destroyed) {
          unlisten?.();
          unlisten = null;
        }
      })
      .catch(() => {
        // Nothing to say: the surface still refreshes on mount, and a bridge
        // that cannot subscribe cannot be told so.
      });
  }

  return {
    set,
    refresh,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unlisten?.();
      unlisten = null;
      container.replaceChildren();
    },
  };
}
