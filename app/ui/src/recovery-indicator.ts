// app/ui/src/recovery-indicator.ts
// One span in the project bar answering a question the save indicator beside it
// does not: is there a SECOND copy of this manuscript, and how old is it.
//
// IT SAYS "ON THIS DEVICE" AND IT MEANS IT. A recovery point lives beside the
// project it recovers, so it is exactly as lost as the project is when the disk
// or the machine goes. The design's whole section 6 argument is that the three
// protections -- in-project history, same-device recovery, and a file the writer
// moves off the computer themselves -- must never blur into one sentence, and
// the failure this surface exists to prevent is a writer BELIEVING they are
// protected when they are not. Nothing here may imply the third thing.
//
// THE THIRD THING EXISTS ELSEWHERE, and this span still does not say it.
// `archive-indicator.ts` is its own span, immediately after this one, under its
// own `archive.*` catalog namespace -- and the split is what keeps this file's
// forward guard at full strength, since the design mandates the phrase "move
// this file off this computer yourself" and that guard forbids "off this
// computer" in every `recovery.*` key. Read the two headers together: the
// argument is that these are two promises about two files, and a later reader
// who merges the indicators has deleted the argument rather than a duplication.
//
// A RESTORE EXISTS ELSEWHERE, and this surface still does not mention it.
// That is a decision, not an oversight: the bar answers "is there a second copy
// and how old is it", and where a writer ACTS on that answer is the project
// panel, beside the library the restore adds a project to. Widening this span
// into a second verb would put the action on a surface that has no room to say
// what it does -- and what it does, "adds a new project and replaces nothing",
// is the part that makes it safe to press.
//
// THE TWO TIMES STAY APART. `newest_verified_ms` is read from the manifest --
// the artifact on disk -- and `status.last_attempt_ms` is what the attempts
// remember. They disagree after a manual prune, and a surface that collapses
// them is the silent-staleness failure `recovery.rs:395-397` names. Every
// failing state therefore says BOTH: when the attempt failed, and how old the
// point that is still good is.
//
// role="group", NOT role="status", for save-indicator.ts:15-20's recorded
// reason -- and here the argument is stronger rather than weaker. A recovery
// state that changed while the writer was mid-sentence is exactly the
// announcement the design forbids ("not an alert, not a modal").
import { plural, t } from "./i18n";

/** The host's `recovery::Status`. Field names are the host's, snake_case by the
 *  recorded rule: command ARGUMENTS are camelCase, returned struct fields are
 *  not. */
export interface RecoveryStatus {
  readonly last_attempt_ms: number;
  readonly last_attempt_ok: boolean;
  readonly last_error: string | null;
  /** What the ATTEMPTS remember. Not the manifest's answer; see the header. */
  readonly last_verified_ms: number | null;
  readonly consecutive_failures: number;
}

/** The host's `recovery::Point`, as `recovery_points` returns it. `mtime_ms` is
 *  the host's own serde rename of `at_ms`; it is the field on the wire and
 *  renaming it here would be a second name for one value. */
export interface RecoveryPoint {
  readonly id: string;
  readonly mtime_ms: number;
  readonly bytes: number;
  readonly hash: string;
  readonly verified: boolean;
  /** Database and inventory are sound; originals may still be incomplete. */
  readonly database_verified?: boolean;
  readonly verified_at: number | null;
  /** False for older database-only points, which omitted original pictures. */
  readonly bundle?: boolean;
  readonly errors?: readonly string[];
}

/** The host's `recovery::Report`, as `recovery_status` returns it. */
export interface RecoveryReport {
  readonly slug: string | null;
  readonly status: RecoveryStatus | null;
  /** The newest VERIFIED point, from the manifest. Null when the directory has
   *  never produced one, and null when the newest point failed its read-back --
   *  which is why both cases say the same plain negative. */
  readonly newest_verified_ms: number | null;
  readonly verified_points: number;
}

/** The host event that means "the files changed". No payload, deliberately: the
 *  page re-invokes `recovery_status`, because one source of truth is the files
 *  and not a payload that can disagree with them. */
export const RECOVERY_EVENT = "app://recovery-changed";

/** How many consecutive failed attempts move the surface from quiet to visibly
 *  stale.
 *
 *  ON THE PAGE, not in the host, because it is a render decision and the design
 *  says it is chosen beside the thing it renders. The host keeps emitting a
 *  count and no threshold. THREE, matching the design's own example -- a chosen
 *  number, never a measured one, and reachable by a test at exactly its value,
 *  because this repo has a recorded rule that a guard no input can reach is
 *  worse than none. */
export const ESCALATE_AFTER = 3;

export type RecoveryState = "none" | "protected" | "attempt-failed" | "stale";

export interface RecoveryView {
  readonly state: RecoveryState;
  /** What the writer reads in the bar. */
  readonly text: string;
  /** What a screen reader says. Longer, because a name has no bar around it to
   *  give it context -- and the only channel certain to survive WebKitGTK's
   *  pruning of #project-bar. */
  readonly label: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a point was taken, as a reader scans it.
 *
 *  A THIRD COPY of `history.ts`'s shape, under its own keys, and deliberately
 *  not extracted. `comments-panel.ts:25-31` argues the existing duplication;
 *  a shared module with one new caller would be a speculative abstraction, and
 *  refactoring the two existing callers is adjacent code this slice was not
 *  asked to touch. The cost is real: a wording change here does not reach the
 *  other two. */
export function formatWhen(atMs: number, now: number): string {
  const diff = now - atMs;
  if (diff < 45 * 1000) return t("recovery.when.now");
  if (diff < 90 * MINUTE) return plural("recovery.when.minutes", Math.round(diff / MINUTE));
  if (diff < 22 * HOUR) return plural("recovery.when.hours", Math.round(diff / HOUR));
  if (diff < 6 * DAY) return plural("recovery.when.days", Math.round(diff / DAY));
  return new Date(atMs).toLocaleDateString();
}

/** What the report is saying, in one place, so the element below is only paint.
 *
 *  The `none` branch covers a report with no project resolved AND a project
 *  whose directory has never produced a verified point. They are one answer
 *  because a writer can act on neither, and because the alternative -- a
 *  sentence about a point that exists but did not read back -- is the removed
 *  `main.ts` sentence's defect with a new mechanism behind it. */
export function describe(report: RecoveryReport, now: number): RecoveryView {
  const verified = report.newest_verified_ms;
  if (report.slug === null || verified === null) {
    return {
      state: "none",
      text: t("recovery.text.none"),
      label: t("recovery.name.none"),
    };
  }
  const earlier = formatWhen(verified, now);
  const status = report.status;
  if (status === null || status.last_attempt_ok) {
    return {
      state: "protected",
      text: t("recovery.text.protected", { when: earlier }),
      label: t("recovery.name.protected", { when: earlier }),
    };
  }
  const when = formatWhen(status.last_attempt_ms, now);
  if (status.consecutive_failures >= ESCALATE_AFTER) {
    return {
      state: "stale",
      text: t("recovery.text.stale", { when, earlier }),
      label: t("recovery.name.stale", { when, earlier }),
    };
  }
  return {
    state: "attempt-failed",
    text: t("recovery.text.attempt-failed", { when, earlier }),
    label: t("recovery.name.attempt-failed", { when, earlier }),
  };
}

/** Ask the host for its report, on the one screen that exists because something
 *  else already failed.
 *
 *  ABSENT AND REJECTING ARE THE SAME ANSWER: null, and no sentence. A rejection
 *  escaping here would replace the explanation of the writer's actual failure
 *  with an unhandled one. The host command never errors and answers even with
 *  no project open -- but the bridge itself can be gone, and this path is
 *  precisely the one where the ordinary assumptions did not hold.
 *
 *  Extracted rather than written inside `showStartupFailure`, because importing
 *  `main.ts` boots the page: a rule that lives there is a rule no test can
 *  reach, and this repo has four recorded survivors of exactly that shape. */
export async function readRecoveryReport(
  invoke: ((cmd: string) => Promise<unknown>) | undefined,
): Promise<RecoveryReport | null> {
  if (invoke === undefined) return null;
  try {
    return ((await invoke("recovery_status")) as RecoveryReport | null) ?? null;
  } catch {
    return null;
  }
}

/** The one extra sentence on the startup-failure screen.
 *
 *  It may name a point ONLY when one is verified. `newest_verified_ms` is null
 *  both when nothing was ever taken and when the newest point failed its
 *  read-back, so both get the same negative that promises nothing -- and an
 *  absent report (no host, or a rejected call) gets no sentence at all rather
 *  than an error on the screen whose whole job is to explain an error. */
export function startupRecoverySentence(report: RecoveryReport | null, now: number): string {
  if (report === null) return "";
  if (report.newest_verified_ms === null) return t("recovery.startup.none");
  return t("recovery.startup.point", { when: formatWhen(report.newest_verified_ms, now) });
}

export interface RecoveryIndicatorDeps {
  /** The bar element, already in index.html. Its OWN span: `createSaveIndicator`
   *  calls `container.replaceChildren()` on mount and on destroy, so anything
   *  sharing #save-controls is wiped on the next project mount. */
  container: HTMLElement;
  /** `recovery_status`. Never errors in the host; a rejection here means the
   *  bridge is gone, not that the answer is bad. */
  status: () => Promise<RecoveryReport>;
  /** `project_backup_now`. Absent where there is no host to ask. */
  backup?: () => Promise<unknown>;
  /** Subscribe to RECOVERY_EVENT. Resolves the unlisten handle. */
  subscribe?: (cb: () => void) => Promise<unknown>;
  /** GOOD NEWS, a different channel from onNotice for export-bar.ts's recorded
   *  reason: success painted in the failure surface is an emergency nobody can
   *  dismiss. */
  onDone?: (message: string) => void;
  /** Non-latching, and NEVER `raiseFailure`. A backup failure is not a save
   *  failure: the manuscript the writer is looking at is untouched. */
  onNotice?: (message: string) => void;
  /** Every state the indicator paints, in order, the opening one included.
   *  The footer's status dot is the one listener: it colours itself from the
   *  three indicators' states and never reads their DOM. */
  onState?: (state: RecoveryState) => void;
  now?: () => number;
}

export interface RecoveryIndicator {
  set(view: RecoveryView): void;
  /** Ask the host and repaint. */
  refresh(): Promise<void>;
  /** Take a point because the writer asked, then repaint on either outcome. */
  backupNow(): Promise<void>;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createRecoveryIndicator(deps: RecoveryIndicatorDeps): RecoveryIndicator {
  const { container } = deps;
  const clock = deps.now ?? ((): number => Date.now());

  container.replaceChildren();

  const element = document.createElement("span");
  element.id = "recovery-indicator";
  element.setAttribute("role", "group");

  let destroyed = false;
  let unlisten: (() => void) | null = null;

  const set = (view: RecoveryView): void => {
    element.textContent = view.text;
    element.setAttribute("aria-label", view.label);
    // For the stylesheet, and for a rig that wants the state rather than the
    // wording. A wording change must not break a selector.
    element.dataset.state = view.state;
    deps.onState?.(view.state);
  };

  // Opens on the negative. The first answer is one await away and a bar that
  // claimed a point before anyone had looked would be the exact lie this
  // surface exists to prevent.
  set(describe({ slug: null, status: null, newest_verified_ms: null, verified_points: 0 }, clock()));

  container.append(element);

  const refresh = async (): Promise<void> => {
    let report: RecoveryReport;
    try {
      report = await deps.status();
    } catch {
      // LEAVE THE LAST THING SAID STANDING. A bridge that stopped answering
      // says nothing about the point on disk, and repainting "no recovery
      // point" here would report a missing file because a call failed.
      return;
    }
    set(describe(report, clock()));
  };

  const backupNow = async (): Promise<void> => {
    if (deps.backup === undefined) return;
    try {
      await deps.backup();
      deps.onDone?.(t("recovery.notice.done"));
    } catch (err: unknown) {
      deps.onNotice?.(t("recovery.notice.failed", { error: messageOf(err) }));
    }
    // Both outcomes. The host emits its event on both, and a failed attempt
    // moves the failure count this element paints.
    await refresh();
  };

  if (deps.subscribe !== undefined) {
    void deps.subscribe(() => {
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
        // Nothing to say: the surface still refreshes on mount and after a
        // manual backup, and a bridge that cannot subscribe cannot be told so.
      });
  }

  return {
    set,
    refresh,
    backupNow,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // NOT the save indicator's "no guard needed" case. This unit holds a
      // host subscription, and a project switch that left one attached would
      // stack one live closure per switch -- the recorded shape of the menu
      // bar's leaked document handler, which no behavioural test could see.
      unlisten?.();
      unlisten = null;
      container.replaceChildren();
    },
  };
}
