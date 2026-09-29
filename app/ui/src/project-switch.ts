// app/ui/src/project-switch.ts
// Switching the whole PROJECT, one level up from session.switchTo's document
// switch. The ordering is the load-bearing part of this file.
//
// doc_flush carries item ids and base_rev values that only mean something
// inside the project they were read from, and two projects seeded from the same
// fixture generator share item ids outright - `it-000013` exists in both files.
// A flush still in flight across the swap therefore lands on a real row in the
// wrong manuscript, with no type error, no store error and no visible symptom
// until the reader notices a paragraph from another book. The host's monotonic
// generation check is the backstop; this ordering is the argument that the
// backstop never has to fire.
import { t } from "./i18n";
import type { FlushScheduler } from "./store/flush";
import type { Session } from "./session";

export type ProjectSwitchOutcome = "switched" | "same" | "busy" | "cancelled" | "failed";

export interface ProjectOpenDecision {
  bookId: string;
  canonicalPath: string;
  kind: "same" | "separate";
}

/** The whole surface the switcher is allowed to touch. Narrower than
 *  MountedProject on purpose, the way SessionDeps narrows FlushScheduler: a
 *  switcher that reached for the navigator, the editor, or the flusher's write
 *  side would fail to compile rather than fail in a soak. A MountedProject
 *  satisfies this structurally. */
export interface SwitchableProject {
  session: Pick<Session, "flushPending"> | null;
  flusher: Pick<FlushScheduler, "failed"> | null;
  /** True grants this caller a departure hold; false or throw grants none. */
  prepareToLeave?(): Promise<boolean>;
  cancelLeave?(): void;
  destroy(): void;
}

export interface ProjectSwitchDeps<P extends SwitchableProject> {
  current(): P;
  setCurrent(next: P): void;
  currentPath(): string;
  /** null cancels; undefined means no copied-book choice was needed. */
  prepareOpen?(path: string): Promise<ProjectOpenDecision | null | undefined>;
  openProject(path: string, decision?: ProjectOpenDecision): Promise<{ path: string; name: string; generation: number }>;
  mount(generation: number): Promise<P>;
  /** The switch completed. Called AFTER setCurrent, and never on a failure -
   *  which is the point: a caller that recorded "which project is open" from
   *  openProject's answer instead would record it for a project that then
   *  failed to mount, leaving the header naming a manuscript that is not open
   *  and the `same` check swallowing the retry. */
  onSwitched?(opened: { path: string; name: string; generation: number }): void;
  /** Called with `true` the moment the outgoing project is destroyed, and with
   *  `false` once the incoming one is mounted or the switch has failed.
   *
   *  A LOADING STATE, and this is the surface that most needs one: the teardown
   *  comes FIRST, so between those two calls the navigator, the editor, the
   *  outline bar, the word count and the saved indicator are all gone and the
   *  writer is looking at a completely blank application with nothing saying a
   *  project is being opened. The cost scales with the manuscript, so it is
   *  longest for the writers with the most to lose. Optional because a caller
   *  that shows nothing is no worse off than before this existed. */
  onBusy?(busy: boolean): void;
  onFailure(message: string): void;
}

export function createProjectSwitcher<P extends SwitchableProject>(
  deps: ProjectSwitchDeps<P>,
): (path: string) => Promise<ProjectSwitchOutcome> {
  let switching = false;

  return async function switchProject(path: string): Promise<ProjectSwitchOutcome> {
    if (path === deps.currentPath()) return "same";
    // Dropped, not queued, for the same reason session.switchTo drops: the head
    // of a queue is stale by the time it runs, and a project switch is far more
    // expensive to run twice. The user's next click still works.
    if (switching) return "busy";
    switching = true;
    let closed = false;
    let prepared = false;
    try {
      const decision = await deps.prepareOpen?.(path);
      if (decision === null) return "cancelled";
      const mayLeave = await deps.current().prepareToLeave?.();
      if (mayLeave === false) return "cancelled";
      prepared = mayLeave === true;
      // 1. Everything dirty reaches the outgoing project's store while that
      //    store is still the one the ids belong to.
      await deps.current().session?.flushPending();
      // 2. Autosave is broken and the failure banner is already up. Tearing the
      //    project down now puts the unsaved text out of reach with no way back
      //    to it. Nothing has been destroyed yet, so returning here is free.
      if (deps.current().flusher?.failed() === true) return "failed";
      // 3. Destroy before opening. Opening first would mean two live stores and
      //    two flush schedulers at once, with a window in which a flush could
      //    reach either - the exact confusion this ordering exists to prevent,
      //    and one that fails silently into the wrong manuscript. Destroying
      //    first cannot lose a write (the drain above already happened), and its
      //    failure mode is loud: if the open or the mount below rejects, the
      //    user is left with no project open and told so. Both orders are
      //    imperfect; this is the one whose failure is visible.
      deps.current().destroy();
      closed = true;
      // AFTER the teardown, not before it: until this line there is still a
      // project on screen, and covering it would hide work the writer can still
      // see while the drain above decides whether the switch may happen at all.
      deps.onBusy?.(true);
      const opened = await deps.openProject(path, decision);
      const next = await deps.mount(opened.generation);
      deps.setCurrent(next);
      deps.onSwitched?.(opened);
      return "switched";
    } catch (err: unknown) {
      // The message turns on whether the teardown actually happened. A rejecting
      // flushPending throws before it, and telling the writer their project was
      // closed when it is still on screen would be worse than saying nothing.
      deps.onFailure(
        closed
          ? t("switch.error.closed", { path, error: String(err) })
          : t("switch.error.kept", { path, error: String(err) }),
      );
      return "failed";
    } finally {
      switching = false;
      if (!closed && prepared) deps.current().cancelLeave?.();
      // In `finally`, so a rejection between the teardown and the mount does not
      // leave the writer looking at a loading state forever with a failure
      // message on top of it.
      if (closed) deps.onBusy?.(false);
    }
  };
}
