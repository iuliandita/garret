import { isApplicationLocked } from "./command-error";
import { t } from "./i18n";

export type PrivacyShortcut = "ctrl_alt_l" | "ctrl_alt_p" | "off";

export function privacyShortcutLabel(shortcut: PrivacyShortcut): string {
  return shortcut === "off" ? "" : t(shortcut === "ctrl_alt_p" ? "privacy.shortcut.alternate" : "privacy.shortcut");
}

export interface PrivacyStatus {
  enabled: boolean;
  locked: boolean;
  recovery: boolean;
  shortcut: PrivacyShortcut;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, callback: () => void | Promise<void>) => Promise<unknown>;

/** Subscribe before reading so an unlock during startup cannot be missed. */
export async function waitForPrivacyUnlock(invoke: Invoke, listen: Listen): Promise<void> {
  let generation = 0;
  let finish: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const check = async (): Promise<void> => {
    const own = ++generation;
    try {
      const status = await invoke("privacy_status") as PrivacyStatus;
      if (own === generation && !status.locked && !status.recovery) finish();
    } catch (error) { fail(error); }
  };
  const off = await listen("app://privacy-changed", check);
  try {
    await check();
    await ready;
  } finally {
    if (typeof off === "function") off();
  }
}


/** Resume bootstrap reads in place; never replay a user mutation or remount twice. */
export function createPrivacyStartupInvoke(invoke: Invoke, listen: Listen): { invoke: Invoke; complete(): void } {
  let starting = true;
  const reads = new Set(["project_items", "doc_load", "project_current", "dict_list", "writing_time_today", "project_document_counts"]);
  return {
    complete: () => { starting = false; },
    invoke: async (command, args) => {
      for (;;) {
        try { return await invoke(command, args); }
        catch (error) {
          if (!starting || !isApplicationLocked(error) || !reads.has(command)) throw error;
          await waitForPrivacyUnlock(invoke, listen);
        }
      }
    },
  };
}
