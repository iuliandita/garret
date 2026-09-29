// app/ui/src/archive-indicator.ts
// One span in the project bar answering the question `recovery-indicator.ts`
// beside it refuses to answer: is there a copy of this manuscript that could
// SURVIVE losing this computer.
//
// READ THIS FILE AND `recovery-indicator.ts` TOGETHER. They are a pair and the
// argument only works that way: that one says "on this device" and means it,
// because a recovery point sits beside the project it recovers and is exactly
// as lost as the project when the disk goes. This one says an archive exists that
// the writer must move off the machine themselves, and never claims it has
// moved. The design's whole section 6 argument is that in-project history,
// same-device recovery and device-loss protection must never blur into one
// sentence, and the failure this feature exists to prevent is a writer
// BELIEVING they are protected when they are not. A later reader who merges
// these two indicators into one has deleted that argument, not removed a
// duplication.
//
// IT NEVER SAYS THE ARCHIVE LEFT. The application cannot see whether it did: there
// is deliberately no file dialog for this status, the writer moves the folder with their own
// file manager, and nothing reports back. So every state in this unit is about
// an ordinary local archive that EXISTS, never about where it is now. Encrypted
// archive files have a separate action and verification notice in the project panel;
// they do not change this persistent status.
//
// A SECOND SPAN, NOT A SECOND LINE. `index.html` and `style.css` both record
// that the project bar's 39px is a click-geometry constant restated in five
// rigs -- "width is free under nowrap; height never is". So this is one more
// statement on the EXISTING line box, and it yields (ellipsis, `min-width: 0`)
// BEFORE `#recovery-indicator` does, which yields before the save indicator,
// which never yields. The order in the strip is deliberate: same-device, then
// off-device, then "is my work in the file".
//
// role="group", NOT role="status", for `save-indicator.ts:15-20`'s recorded
// reason. An archive state that changed while the writer was mid-sentence is
// exactly the announcement the design forbids.

import { t } from "./i18n";
import { formatWhen } from "./recovery-indicator";

/** The host's `recovery::Archive`. Field names are the host's, snake_case by
 *  the recorded rule: command ARGUMENTS are camelCase, returned struct fields
 *  are not. */
export interface Archive {
  readonly id: string;
  /** The archive folder name (or an older database file name), never a path. */
  readonly file: string;
  readonly manifest: string;
  readonly bytes: number;
  readonly at_ms: number;
  readonly verified: boolean;
  readonly verified_at: number | null;
}

/** The host's `recovery::ArchiveReport`, as `archive_status` returns it. */
export interface ArchiveReport {
  readonly slug: string | null;
  /** Where the writer has to go. The ONE path the host hands out for a person
   *  to read rather than for the page to name an artifact with; nothing sends
   *  it back to a command. */
  readonly dir: string;
  /** The newest VERIFIED archive. Null when none has been made, and null when
   *  every archive on disk failed its read-back -- which is why both cases say
   *  the same plain negative. */
  readonly newest_verified_ms: number | null;
  /** Every archive on record, verified or not. */
  readonly archives: number;
}

export type ArchiveState = "none" | "taken";

export interface ArchiveView {
  readonly state: ArchiveState;
  /** What the writer reads in the bar. */
  readonly text: string;
  /** What a screen reader says. Longer, because a name has no bar around it to
   *  give it context. */
  readonly label: string;
}

export interface ArchiveIndicatorDeps {
  readonly container: HTMLElement;
  readonly status: () => Promise<ArchiveReport>;
  /** Write one, because the writer asked. Absent where there is no host. */
  readonly archive?: () => Promise<Archive>;
  readonly subscribe?: (onEvent: () => void) => Promise<unknown>;
  readonly onNotice?: (message: string) => void;
  readonly onDone?: (message: string) => void;
  /** Every state the indicator paints, in order, the opening one included.
   *  The footer's status dot is the one listener: it colours itself from the
   *  three indicators' states and never reads their DOM. */
  readonly onState?: (state: ArchiveState) => void;
  readonly now?: () => number;
}

export interface ArchiveIndicator {
  set(view: ArchiveView): void;
  refresh(): Promise<void>;
  /** Write an archive because the writer asked, then repaint on either
   *  outcome. */
  archiveNow(): Promise<void>;
  destroy(): void;
}

/** What the report is saying, in one place, so the element below is only paint.
 *
 *  `none` covers a report with no project resolved, a directory that has never
 *  produced an archive, AND a directory whose archives all failed their
 *  read-back. They are one answer because a writer can act on all three the
 *  same way, and because an archive the application could not vouch for is not
 *  protection to report. `archives` is deliberately NOT what this branches on. */
export function describe(report: ArchiveReport, now: number): ArchiveView {
  const verified = report.newest_verified_ms;
  if (report.slug === null || verified === null) {
    return {
      state: "none",
      text: t("archive.text.none"),
      label: t("archive.name.none"),
    };
  }
  const when = formatWhen(verified, now);
  return {
    state: "taken",
    text: t("archive.text.taken", { when }),
    label: t("archive.name.taken", { when }),
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createArchiveIndicator(deps: ArchiveIndicatorDeps): ArchiveIndicator {
  const { container } = deps;
  const clock = deps.now ?? ((): number => Date.now());

  container.replaceChildren();

  const element = document.createElement("span");
  element.id = "archive-indicator";
  element.setAttribute("role", "group");

  let destroyed = false;
  let unlisten: (() => void) | null = null;

  const set = (view: ArchiveView): void => {
    element.textContent = view.text;
    element.setAttribute("aria-label", view.label);
    // For the stylesheet, and for a rig that wants the state rather than the
    // wording. A wording change must not break a selector.
    element.dataset.state = view.state;
    deps.onState?.(view.state);
  };

  // Opens on the negative, for the recovery indicator's reason: the first
  // answer is one await away and a bar claiming an off-device copy before
  // anyone had looked is the exact lie this surface exists to prevent.
  set(describe({ slug: null, dir: "", newest_verified_ms: null, archives: 0 }, clock()));

  container.append(element);

  const refresh = async (): Promise<void> => {
    let report: ArchiveReport;
    try {
      report = await deps.status();
    } catch {
      // LEAVE THE LAST THING SAID STANDING. A bridge that stopped answering
      // says nothing about the file on disk, and repainting the negative here
      // would report a missing archive because a call failed.
      return;
    }
    set(describe(report, clock()));
  };

  const archiveNow = async (): Promise<void> => {
    if (deps.archive === undefined) return;
    try {
      const written = await deps.archive();
      // BY NAME. The writer's next act is to find this file in their own file
      // manager, so the one thing the notice owes them is what it is called.
      deps.onDone?.(t("archive.notice.done", { file: written.file }));
    } catch (err: unknown) {
      // The notice channel, never the latched save-failure banner: preparation
      // can fail because saving already failed, and should not latch it twice.
      deps.onNotice?.(t("archive.notice.failed", { error: messageOf(err) }));
    }
    await refresh();
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
        // Nothing to say: the surface still refreshes on mount and after a
        // manual archive, and a bridge that cannot subscribe cannot be told so.
      });
  }

  return {
    set,
    refresh,
    archiveNow,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unlisten?.();
      unlisten = null;
      container.replaceChildren();
    },
  };
}
