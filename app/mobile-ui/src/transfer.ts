import { element } from "./element";
import { mobileMessages } from "./messages";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface TransferStatus {
  token: string;
  phase: string;
  code?: string;
  preview?: { title?: string; related: string[]; unreadable_books?: number };
  book_id?: string;
}
export function transferError(code: unknown, locale: "en" | "de") {
  const m = mobileMessages(locale);
  if (typeof code === "string" && code.startsWith("transfer_format:")) {
    return m.transferFormat.replace("{item}", code.slice("transfer_format:".length));
  }
  const messages: Record<string, string> = {
    unsupported_schema: m.unsupportedSchema,
    unsupported_project_preset: m.unsupportedPreset,
    transfer_storage: m.transferStorage, transfer_too_large: m.transferTooLarge,
    transfer_key: m.transferKeyError, transfer_provider: m.transferProvider,
    transfer_stale: m.transferStale,
    transfer_cleanup: m.transferCleanup, transfer_retained: m.transferRetained,
    transfer_disabled: m.transferDisabled, transfer_restart: m.transferRestart,
    transfer_busy: m.transferBusy, transfer_publish: m.transferPublish,
    transfer_library_unreadable: m.transferLibraryUnreadable, transfer_incomplete: m.transferIncomplete,
    transfer_cancelled: m.transferCancelled,
  };
  return messages[String(code)] ?? m.transferInvalid;
}
export async function showTransfer(mount: HTMLElement, options: {
  invoke: Invoke; locale: "en" | "de"; theme: "light" | "dark";
  direction: "import" | "export"; generation: number; existing?: TransferStatus;
}): Promise<void> {
  const m = mobileMessages(options.locale);
  const dialog = element("dialog");
  dialog.className = "mobile-transfer mobile-workspace";
  dialog.dataset.theme = options.theme;
  dialog.setAttribute("aria-label", m.transfer);
  const title = element("h2", options.direction === "export" ? m.exportBook : m.importBook);
  const hint = element("p", m.transferHint);
  const limits = element("p", m.transferLimits);
  const state = element("p"); state.setAttribute("role", "status"); state.setAttribute("aria-live", "polite");
  const preview = element("div");
  const actions = element("div"); actions.className = "mobile-transfer-actions";
  dialog.append(title, hint, limits, state, preview, actions);
  const lifecycle = window as Window & { __mobileTransfer?: boolean };
  lifecycle.__mobileTransfer = true;
  let status = options.existing;
  let pending = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClose: () => void;
  const closed = new Promise<void>(resolve => { resolveClose = resolve; });
  function button(label: string, action: () => Promise<void>) {
    const node = element("button", label); node.type = "button";
    node.addEventListener("click", () => {
      if (pending || finished) return;
      pending = true;
      for (const child of actions.querySelectorAll("button")) child.disabled = true;
      void action().catch(error => { state.textContent = transferError(error, options.locale); })
        .finally(() => { pending = false; for (const child of actions.querySelectorAll("button")) child.disabled = false; });
    });
    actions.append(node);
    return node;
  }
  function schedule() {
    if (!finished && timer === undefined) timer = setTimeout(() => { timer = undefined; void poll(); }, 400);
  }
  async function poll() {
    if (!status || finished) return;
    try {
      status = await options.invoke<TransferStatus>("mobile_transfer_status", { token: status.token });
      render();
    } catch (error) { state.textContent = transferError(error, options.locale); schedule(); }
  }
  async function cancel() {
    if (!status) { close(); return; }
    if (["done", "failed", "cancelled"].includes(status.phase)) {
      await options.invoke("mobile_transfer_finish", { token: status.token }); close(); return;
    }
    if (["publishing", "cancelling", "restart_required"].includes(status.phase)) return;
    await options.invoke("mobile_transfer_cancel", { token: status.token });
    await poll();
  }
  function close() {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener("mobile-back", onBack, true);
    lifecycle.__mobileTransfer = false;
    dialog.close(); dialog.remove(); resolveClose();
  }
  function render() {
    actions.replaceChildren(); preview.replaceChildren();
    if (!status) {
      state.textContent = "";
      const start = async (keyChoice: "existing" | "new") => {
        status = await options.invoke<TransferStatus>("mobile_transfer_start", {
          direction: options.direction, generation: options.generation, keyChoice,
        });
        render();
      };
      if (options.direction === "export") {
        button(m.existingKey, () => start("existing")); button(m.newKey, () => start("new"));
      } else button(m.importBook, () => start("existing"));
      button(m.cancel, async () => close());
      return;
    }
    const phaseMessages: Record<string, string> = {
      key: m.transferKey, archive: m.transferArchive, save_key: m.transferSaveKey,
      save_archive: m.transferSaveArchive, reading: m.transferReading, writing: m.transferWriting,
      publishing: m.transferPublishing, cancelling: m.transferCancelling, preparing: m.transferPreparing,
      restart_required: m.transferRestart, cancelled: m.transferCancelled, done: status.book_id ? m.importDone : m.transferDone,
      failed: transferError(status.code, options.locale), preview: m.previewHint,
    };
    state.textContent = phaseMessages[status.phase] ?? m.transferPreparing;
    if (status.phase === "done" && status.code) state.textContent += ` ${transferError(status.code, options.locale)}`;
    if (status.phase === "preview" && status.preview) {
      const name = element("h3", status.preview.title || m.unnamedBook);
      preview.append(name);
      if (status.preview.unreadable_books) preview.append(element("p", m.transferLibraryUnreadable));
      if (status.preview.related.length) {
        const label = element("p", m.relatedBooks); preview.append(label);
        const list = element("ul");
        for (const related of status.preview.related) { const row = element("li", related || m.unnamedBook); list.append(row); }
        preview.append(list);
      }
      button(status.preview.related.length ? m.keepBoth : m.importCopy, async () => {
        await options.invoke("mobile_transfer_confirm", { token: status!.token }); await poll();
      });
      button(m.cancel, cancel);
    } else if (["done", "failed", "cancelled"].includes(status.phase)) {
      button(m.close, async () => { await options.invoke("mobile_transfer_finish", { token: status!.token }); close(); });
    } else if (status.phase !== "restart_required") {
      if (!["publishing", "cancelling"].includes(status.phase)) button(m.cancel, cancel);
      schedule();
    }
  }
  function onBack(event: Event) {
    event.stopImmediatePropagation();
    if (!pending) void cancel().catch(error => { state.textContent = transferError(error, options.locale); });
  }
  window.addEventListener("mobile-back", onBack, true);
  dialog.addEventListener("cancel", event => { event.preventDefault(); onBack(event); });
  mount.append(dialog); render(); dialog.showModal();
  await closed;
}
