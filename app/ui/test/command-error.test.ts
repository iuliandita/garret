import { expect, test } from "bun:test";
import { commandFailureMessage, HostCommandError, isApplicationLocked, localizedInvoke, splitHostDetail } from "../src/command-error";
import { t } from "../src/i18n";
import { createPrivacyStartupInvoke } from "../src/privacy";

test("localized failures preserve technical evidence without guessing a cause", async () => {
  const value = { version: 1, code: "operation_failed", operation: "doc_flush", detail: "permission or disk diagnostic" };
  const invoke = localizedInvoke(async () => { throw value; });
  try { await invoke("doc_flush", { prose: "must not enter error" }); throw new Error("expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(HostCommandError);
    const failure = error as HostCommandError;
    expect(failure.code).toBe("operation_failed");
    expect(failure.detail).toBe(value.detail);
    expect(failure.message).toContain("Technical details:");
    expect(failure.message).not.toContain("must not enter error");
    expect(failure.message).not.toContain("nothing was");
  }
  expect(commandFailureMessage("legacy failure")).toContain("Technical details: legacy failure");
  expect(commandFailureMessage({ ...value, version: 2 })).toContain('"version":2');
  expect(commandFailureMessage({ ...value, code: "future_code" })).toContain(value.detail);
});

test("structured privacy refusal retries only bootstrap reads, never a user write", async () => {
  const locked = { version: 1, code: "application_locked", operation: "doc_load", detail: "" };
  let loads = 0;
  let writes = 0;
  const raw = localizedInvoke(async (command) => {
    if (command === "privacy_status") return { locked: false, recovery: false };
    if (command === "doc_flush") { writes++; throw locked; }
    if (++loads === 1) throw locked;
    return "saved body";
  });
  const startup = createPrivacyStartupInvoke(raw, async () => () => {});
  expect(await startup.invoke("doc_load")).toBe("saved body");
  expect(loads).toBe(2);
  await expect(startup.invoke("doc_flush")).rejects.toBeInstanceOf(HostCommandError);
  expect(writes).toBe(1);
  expect(isApplicationLocked(new HostCommandError("doc_load", "application locked"))).toBe(true);
});

test("known host failures read as one plain sentence naming the recovery", () => {
  const failed = (detail: string) => ({ version: 1, code: "operation_failed", operation: "doc_flush", detail });
  const cases: Array<[string, string]> = [
    ["database is locked", "host-error.busy"],
    ["Error code 5: database is busy", "host-error.busy"],
    ["attempt to write a readonly database", "host-error.read-only"],
    ["Read-only file system (os error 30)", "host-error.read-only"],
    ["database or disk is full", "host-error.disk-full"],
    ["No space left on device (os error 28)", "host-error.disk-full"],
    ["disk I/O error", "host-error.io"],
    ["Input/output error (os error 5)", "host-error.io"],
    ["database disk image is malformed", "host-error.corrupt"],
    ["file is not a database", "host-error.corrupt"],
    ["refused scene", "host-error.failed"],
    // pictures.rs's four refusals: the reason, never "try again".
    ["that file is 60000000 bytes and the largest picture this book will take is 52428800", "host-error.picture-bytes"],
    ["that file is not a PNG or a JPEG, whatever it is called", "host-error.picture-format"],
    ["that picture says it is 50410000 pixels and the largest this book will read is 50000000", "host-error.picture-pixels"],
    ["that picture could not be read: invalid signature", "host-error.picture-unreadable"],
  ];
  for (const [detail, key] of cases) {
    const error = new HostCommandError("doc_flush", failed(detail));
    expect(error.problem).toBe(t(key));
    // The headline never carries the diagnostic; the detail keeps it whole.
    expect(error.problem).not.toContain(detail);
    expect(error.detail).toBe(detail);
    expect(error.message.startsWith(t(key))).toBe(true);
  }
  // "(os error 50)" is not EIO.
  expect(new HostCommandError("x", failed("unknown (os error 50)")).problem).toBe(t("host-error.failed"));
  expect(commandFailureMessage({ version: 1, code: "application_locked", operation: "doc_load", detail: "" })).toBe(t("host-error.locked"));
  expect(commandFailureMessage("application locked")).toBe(t("host-error.locked"));
});

test("a banner can lift exactly the diagnostic out of a sentence built around it", () => {
  const error = new HostCommandError("project_open", { version: 1, code: "operation_failed", operation: "project_open", detail: "database is locked" });
  const wrapped = t("switch.error.kept", { path: "/books/a.db", error: error.message });
  const { headline, detail } = splitHostDetail(wrapped);
  expect(detail).toBe("database is locked");
  expect(headline).not.toContain("database is locked");
  expect(headline).not.toContain("Technical details");
  expect(headline).not.toContain("..");
  // The caller's own recovery sentence after {error} survives.
  expect(headline).toContain("The project you were in is still open.");
  // Text this module did not write is left whole.
  expect(splitHostDetail("Technical details: typed by a writer")).toEqual({ headline: "Technical details: typed by a writer", detail: null });
});
