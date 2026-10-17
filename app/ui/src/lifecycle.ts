// app/ui/src/lifecycle.ts
// When to force a drain. Three points, in increasing order of desperation:
// blur and visibility loss are cheap and cover the ordinary "click away, then
// quit" sequence; the close round trip must confirm a successful drain or
// explicit discard. Host timeout only permits retry; it never destroys the window.
//
// Every capability is injected. The unit is pure decision-making, so it can be
// tested without a window, a document or a Tauri bridge.

export interface LifecycleDeps {
  session: {
    flushPending(): Promise<void>;
    /** Whether autosave has stopped after a failure. Reached through the
     *  scheduler, not through `Session` -- `Session` deliberately exposes
     *  neither this nor `dirtyCount` (see session.ts), and this unit is not
     *  the place to widen it. */
    failed(): boolean;
    /** How many documents are unwritten. Only meaningful once `failed()` is
     *  true; a healthy scheduler drains to zero before this is read. */
    dirtyCount(): number;
  };
  privacyLocked?: () => Promise<boolean>;
  /** Capture before preparation disables controls; restore after cancellation. */
  captureCloseFocus?: () => (() => void);
  drafts?: {
    pending(): boolean;
    /** True grants this close attempt a hold; false or throw grants none. */
    prepareClose(): Promise<boolean>;
    cancelClose(): void;
  };
  preferences?: {
    prepareClose(): Promise<boolean>;
    cancelClose(): void;
  };
  /** Ask before losing count choices that failed to persist. */
  promptPreferencesClose?: () => Promise<"stay" | "close">;
  /** Absent outside the Tauri host. */
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Absent outside the Tauri host. */
  listen?: (event: string, cb: (event?: { payload: number }) => void | Promise<void>) => Promise<unknown>;
  addWindowListener: (type: string, cb: () => void) => void;
  addDocumentListener: (type: string, cb: () => void) => void;
  isHidden: () => boolean;
  /** Called when the close listener fails to install. Without this a rejected
   *  `listen` promise is swallowed entirely, and a user whose editor cannot
   *  flush on quit is never told before losing work. */
  onError?: (message: string) => void;
  /** Ask the writer what to do about unsaved work before the window is
   *  allowed to close. Only called when the drain above left the scheduler
   *  failed with a non-zero dirty count. Resolves "stay" to leave the window
   *  open and "close" to discard the unsaved work and proceed.
   *
   *  Absent in every environment with no page to put a dialog on (the corpus
   *  path, a soak). Missing here is treated the same as the writer choosing
   *  "stay": the default this unit picks when it cannot ask is the one that
   *  cannot destroy work. */
  promptUnsavedClose?: (dirtyCount: number) => Promise<"stay" | "close">;
}

export const CLOSE_EVENT = "app://close-requested";

export async function wireLifecycle(deps: LifecycleDeps): Promise<boolean> {
  let installed = true;
  const flush = (): void => {
    void deps.session.flushPending().catch((err: unknown) => deps.onError?.(String(err)));
  };

  deps.addWindowListener("blur", flush);
  deps.addDocumentListener("visibilitychange", () => {
    // Only on the way OUT. visibilitychange fires in both directions.
    if (deps.isHidden()) flush();
  });

  const lockListener = deps.listen?.("app://privacy-lock", async () => {
    let ok = false;
    try {
      await deps.session.flushPending();
      ok = !deps.session.failed() && deps.session.dirtyCount() === 0;
    } catch {
      // Detailed save errors remain on the concealed page until authentication.
    }
    await deps.invoke?.("privacy_drain_result", { ok });
  }).catch((err: unknown) => { installed = false; deps.onError?.(String(err)); });

  const closeListener = deps.listen?.(CLOSE_EVENT, async (event) => {
    const restoreFocus = deps.captureCloseFocus?.();
    const attempt = event?.payload;
    let confirmed = false;
    let prepared = false;
    let preferencesPrepared = false;
    try {
      // A failed status read must never allow the ordinary discard dialog.
      let locked = await deps.privacyLocked?.().catch(() => true) ?? false;
      if (deps.preferences) {
        await deps.invoke?.("holding_close", { attempt });
        preferencesPrepared = true;
        const saved = await deps.preferences.prepareClose();
        locked = locked || (await deps.privacyLocked?.().catch(() => true) ?? false);
        if (!saved) {
          if (locked) {
            await deps.invoke?.("privacy_close_failed");
            return;
          }
          const choice = (await deps.promptPreferencesClose?.()) ?? "stay";
          if (await deps.privacyLocked?.().catch(() => true)) {
            await deps.invoke?.("privacy_close_failed");
            return;
          }
          if (choice !== "close") {
            await deps.invoke?.("release_close", { attempt });
            return;
          }
        }
      }
      if (!locked && deps.drafts) {
        if (deps.drafts.pending()) await deps.invoke?.("holding_close", { attempt });
        const mayClose = await deps.drafts.prepareClose();
        prepared = mayClose;
        locked = await deps.privacyLocked?.().catch(() => true) ?? false;
        if (locked) {
          await deps.invoke?.("privacy_close_failed");
          return;
        }
        if (!mayClose) {
          await deps.invoke?.("release_close", { attempt });
          return;
        }
      }
      let rejected = false;
      let rejection = "";
      try {
        await deps.session.flushPending();
      } catch (error) {
        rejected = true;
        rejection = String(error);
      }
      locked = locked || (await deps.privacyLocked?.().catch(() => true) ?? false);
      if (locked) {
        if (rejected || deps.session.failed() || deps.session.dirtyCount() > 0 || deps.drafts?.pending()) {
          await deps.invoke?.("privacy_close_failed");
          return;
        }
        await deps.invoke?.("confirm_close", { attempt });
        confirmed = true;
        return;
      }
      if (rejected) {
        await deps.invoke?.("holding_close", { attempt });
        deps.onError?.(rejection);
        await deps.invoke?.("release_close", { attempt });
        return;
      }
      // A failed drain leaves the entries it could not write still dirty (see
      // flush.ts's `fire`), so this is exactly the writer's unsaved work, not a
      // guess at it.
      if (deps.session.failed() && deps.session.dirtyCount() > 0) {
        // Keep this attempt held while the question is open so another
        // close request cannot start a duplicate drain and prompt.
        await deps.invoke?.("holding_close", { attempt });
        const choice = (await deps.promptUnsavedClose?.(deps.session.dirtyCount())) ?? "stay";
        if (await deps.privacyLocked?.().catch(() => true)) {
          await deps.invoke?.("privacy_close_failed");
          return;
        }
        if (choice !== "close") {
          // End this held attempt so the next close requests a fresh drain
          // and prompts again for any work that is still unsaved.
          await deps.invoke?.("release_close", { attempt });
          return;
        }
      }
      await deps.invoke?.("confirm_close", { attempt });
      confirmed = true;
    } catch (error) {
      deps.onError?.(String(error));
      if (await deps.privacyLocked?.().catch(() => true)) {
        await deps.invoke?.("privacy_close_failed");
      } else {
        await deps.invoke?.("holding_close", { attempt });
        await deps.invoke?.("release_close", { attempt });
      }
    } finally {
      if (!confirmed && prepared) deps.drafts?.cancelClose();
      if (!confirmed && preferencesPrepared) deps.preferences?.cancelClose();
      if (!confirmed && restoreFocus && !(await deps.privacyLocked?.().catch(() => true) ?? false)) restoreFocus();
    }
  }).catch((err: unknown) => {
    installed = false;
    deps.onError?.(`could not install the close listener: ${String(err)}`);
  });
  await Promise.all([lockListener, closeListener]);
  return installed;
}
