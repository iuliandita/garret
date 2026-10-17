import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { mobileMessages } from "../src/messages";
import { showTransfer, transferError, type TransferStatus } from "../src/transfer";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
async function settled() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
function press(root: HTMLElement, label: string) {
  const button = Array.from(root.querySelectorAll("button")).find(node => node.textContent === label);
  if (!button) throw new Error(`missing control: ${label}`);
  button.click();
}
test("import previews escape titles and publish only after the localized keep-both action", async () => {
  for (const [locale, theme] of [["en", "light"], ["de", "dark"]] as const) {
    const mount = document.createElement("section"); document.body.append(mount);
    const m = mobileMessages(locale); const calls: string[] = [];
    let status: TransferStatus = { token: "opaque-job", phase: "preview", preview: { title: "<img src=x>", related: ["Harbour"] } };
    const done = showTransfer(mount, { locale, theme, generation: 9, direction: "import", existing: status,
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push(command); expect(args?.token).toBe("opaque-job");
        if (command === "mobile_transfer_confirm") { status = { token: status.token, phase: "done", book_id: "new-copy" }; return undefined as T; }
        if (command === "mobile_transfer_status") return status as T;
        if (command === "mobile_transfer_finish") return undefined as T;
        throw new Error(command);
      },
    });
    expect(mount.querySelector("dialog")!.dataset.theme).toBe(theme);
    expect(mount.querySelector("img")).toBeNull();
    expect(mount.querySelector("h3")!.textContent).toBe("<img src=x>");
    expect(calls).toEqual([]);
    press(mount, m.keepBoth); await settled();
    expect(calls).toEqual(["mobile_transfer_confirm", "mobile_transfer_status"]);
    expect(mount.querySelector('[role="status"]')!.textContent).toBe(m.importDone);
    press(mount, m.close); await done;
    expect(calls.at(-1)).toBe("mobile_transfer_finish"); mount.remove();
  }
});
test("cancellation waits for a late native result before offering Close", async () => {
  const mount = document.createElement("section"); document.body.append(mount);
  let phase = "cancelling"; const calls: string[] = [];
  const done = showTransfer(mount, { locale: "en", theme: "dark", generation: 3, direction: "export", existing: { token: "job", phase: "writing" },
    invoke: async <T>(command: string) => {
      calls.push(command);
      if (command === "mobile_transfer_cancel" || command === "mobile_transfer_finish") return undefined as T;
      if (command === "mobile_transfer_status") return { token: "job", phase } as T;
      throw new Error(command);
    },
  });
  window.dispatchEvent(new Event("mobile-back")); await settled();
  expect(mount.textContent).toContain("original operation");
  expect(Array.from(mount.querySelectorAll("button")).some(node => node.textContent === "Close")).toBe(false);
  phase = "cancelled";
  await new Promise(resolve => setTimeout(resolve, 450)); await settled();
  expect(mount.textContent).toContain("unverified");
  press(mount, "Close"); await done;
  expect(calls.indexOf("mobile_transfer_finish")).toBeGreaterThan(calls.indexOf("mobile_transfer_cancel")); mount.remove();
});
test("export explicitly saves a new key first and passes only opaque operation data", async () => {
  const mount = document.createElement("section"); document.body.append(mount);
  const commands: string[] = [];
  const done = showTransfer(mount, { locale: "en", theme: "light", generation: 42, direction: "export",
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      commands.push(command);
      if (command === "mobile_transfer_start") {
        expect(args).toEqual({ direction: "export", generation: 42, keyChoice: "new" });
        return { token: "job", phase: "failed", code: "transfer_storage" } as T;
      }
      if (command === "mobile_transfer_finish") return undefined as T;
      throw new Error(command);
    },
  });
  expect(mount.textContent).toContain("lost key");
  press(mount, "Save a new recovery key first"); await settled();
  expect(mount.querySelector('[role="status"]')!.textContent).toContain("Not enough private storage");
  press(mount, "Close"); await done; expect(commands).toEqual(["mobile_transfer_start", "mobile_transfer_finish"]); mount.remove();
});
test("preset refusal and provider failure are localized without exposing native paths or errors", () => {
  for (const locale of ["en", "de"] as const) {
    const m = mobileMessages(locale);
    expect(transferError("unsupported_schema", locale)).toBe(m.unsupportedSchema);
    expect(transferError("unsupported_project_preset", locale)).toBe(m.unsupportedPreset);
    expect(transferError("transfer_provider", locale)).toBe(m.transferProvider);
    expect(transferError("native provider internals", locale)).toBe(m.transferInvalid);
  }
});
