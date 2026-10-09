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
    ["No such file or directory (os error 2)", "host-error.unavailable"],
    ["The system cannot find the path specified. (os error 3)", "host-error.unavailable"],
    ["Permission denied (os error 13)", "host-error.unavailable"],
    ["Access is denied", "host-error.unavailable"],
    ["unable to open database file", "host-error.unavailable"],
    ["SQLITE_CANTOPEN", "host-error.unavailable"],
    ["database is locked; unable to open database file", "host-error.busy"],
    ["readonly database; permission denied", "host-error.read-only"],
    ["file is not a database; permission denied", "host-error.corrupt"],
    ["database or disk is full; permission denied", "host-error.disk-full"],
    ["disk I/O error; unable to open database file", "host-error.io"],
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
  const wrapped = t("switch.error.kept", { name: "A", error: error.message });
  const { headline, detail } = splitHostDetail(wrapped);
  expect(detail).toBe("database is locked");
  expect(headline).not.toContain("database is locked");
  expect(headline).not.toContain("Technical details");
  expect(headline).not.toContain("..");
  // The caller's own recovery sentence after {error} survives.
  expect(headline).toContain("The book you were in is still open.");
  // Text this module did not write is left whole.
  expect(splitHostDetail("Technical details: typed by a writer")).toEqual({ headline: "Technical details: typed by a writer", detail: null });
});


test("retained archive Details explain recovery while preserving the raw diagnostic", () => {
  const raw = 'unfinished encrypted archive staging .encrypted-archive-stage-abc; application-private temporary backup files (may contain plaintext); parent directory: /local/backup; retained stage: /local/backup/.encrypted-archive-stage-abc';
  const error = new HostCommandError("encrypted_archive_create", raw);
  expect(error.problem).toBe(t("host-error.archive-stage"));
  expect(error.detail).toBe(raw);
  const wrapped = t("switch.error.kept", { name: "A", error: error.message });
  const split = splitHostDetail(wrapped);
  expect(split.detail).toBe(`${raw}\n\n${t("host-error.archive-stage.steps")}`);
  expect(split.headline).toContain(t("host-error.archive-stage"));
  expect(split.headline).not.toContain(raw);
  expect(split.headline).toContain("The book you were in is still open.");
  expect(error.message).toContain('archive-stage-clean "<parent-folder>" "<stage-name>"');
  expect(error.message).not.toContain('archive-stage-clean "/local/backup"');
  expect(commandFailureMessage(error)).toBe(error.message);
});

test("adding a path to Details preserves the original failure classification", () => {
  const full = new HostCommandError("project_open", "disk full");
  const split = splitHostDetail(commandFailureMessage(full, `${full.detail}\n/books/a.db`));
  expect(split.headline).toBe(t("host-error.disk-full"));
  expect(split.detail).toBe("disk full\n/books/a.db");
  const locked = new HostCommandError("project_open", "application locked");
  expect(commandFailureMessage(locked, "/books/a.db")).toBe(t("host-error.locked"));
  const picture = new HostCommandError("project_open", "that picture could not be read: invalid signature");
  expect(splitHostDetail(commandFailureMessage(picture, `/books/a.db\n${picture.detail}`)).headline)
    .toBe(t("host-error.picture-unreadable"));
});

for (const locale of ["en", "de"]) {
  test(`settings write permission guidance uses ${locale} and preserves Details`, () => {
    const detail = "cannot replace /settings/settings.json: Permission denied (os error 13)";
    const script = `globalThis.__appLocale = ${JSON.stringify(locale)};
      const { HostCommandError, splitHostDetail } = await import(${JSON.stringify(new URL("../src/command-error.ts", import.meta.url).pathname)});
      const error = new HostCommandError("settings_set_sidebar_word_counts", { version: 1, code: "operation_failed", operation: "settings_set_sidebar_word_counts", detail: ${JSON.stringify(detail)} });
      console.log(JSON.stringify(splitHostDetail(error.message)));`;
    const result = Bun.spawnSync([process.execPath, "-e", script]);
    expect(result.exitCode).toBe(0);
    const actual = JSON.parse(result.stdout.toString());
    expect(actual.detail).toBe(detail);
    expect(actual.headline).toBe(locale === "en"
      ? "Preferences could not be saved. Check that you can write to the application settings folder, then try again."
      : "Die Einstellungen konnten nicht gespeichert werden. Prüfen Sie, ob Sie in den Einstellungsordner der Anwendung schreiben können, und versuchen Sie es dann erneut.");
  });
}


test("permission guidance is scoped to settings writes and keeps stronger failure diagnoses", () => {
  const details = [
    "cannot write /settings/settings.json.tmp: Permission denied (os error 13)",
    "cannot replace /settings/settings.json: Access is denied. (os error 5)",
  ];
  for (const detail of details) {
    const operation = "settings_set_sidebar_word_counts";
    const failure = { version: 1, code: "operation_failed", operation, detail };
    expect(new HostCommandError(operation, failure).problem).toBe(t("host-error.settings-permission"));
    expect(new HostCommandError(operation, detail).problem).toBe(t("host-error.settings-permission"));
    expect(new HostCommandError("project_open", { ...failure, operation: "project_open" }).problem)
      .toBe(t(detail.includes("os error 5") ? "host-error.io" : "host-error.unavailable"));
  }
  for (const [detail, key] of [
    ["No space left on device (os error 28)", "host-error.disk-full"],
    ["Read-only file system (os error 30)", "host-error.read-only"],
    ["Input/output error (os error 5)", "host-error.io"],
    ["No such file or directory (os error 2)", "host-error.unavailable"],
  ]) {
    expect(new HostCommandError("settings_set_theme", detail).problem).toBe(t(key));
  }
});

for (const locale of ["en", "de"]) {
  test(`completed move registration guidance uses ${locale} and preserves Details`, () => {
    const detail = "the book moved to /books/moved.db, but its saved location could not be updated: cannot replace settings.json: Permission denied (os error 13). Keep the book open and retry adding its new location to Library in Books";
    const script = `globalThis.__appLocale = ${JSON.stringify(locale)};
      const { HostCommandError, splitHostDetail } = await import(${JSON.stringify(new URL("../src/command-error.ts", import.meta.url).pathname)});
      const error = new HostCommandError("project_move", { version: 1, code: "operation_failed", operation: "project_move", detail: ${JSON.stringify(detail)} });
      console.log(JSON.stringify(splitHostDetail(error.message)));`;
    const result = Bun.spawnSync([process.execPath, "-e", script]);
    expect(result.exitCode).toBe(0);
    const actual = JSON.parse(result.stdout.toString());
    expect(actual.detail).toBe(detail);
    expect(actual.headline).toBe(locale === "en"
      ? "Your book moved and is still open, but its new location could not be remembered. Keep garret open and choose Add to Library in Books before closing."
      : "Ihr Buch wurde verschoben und ist weiterhin geöffnet, aber der neue Speicherort konnte nicht gespeichert werden. Lassen Sie garret geöffnet und wählen Sie unter Bücher die Aktion Zur Bibliothek hinzufügen, bevor Sie garret schließen.");
  });
}

test("completed move guidance distinguishes unavailable retry and actual open failures", () => {
  const moved = "the book moved to /books/moved.db, but its saved location could not be updated: Permission denied (os error 13). ";
  const noRetry = new HostCommandError("project_move", moved + "Reopen the book from its new location; a registration retry is unavailable: identity could not be read");
  expect(noRetry.problem).toBe("Your book moved and is still open, but its new location could not be remembered. Keep a separate backup and open Details for the saved location and recovery information.");
  expect(noRetry.problem).not.toContain("Add to Library");
  const retrySuffix = "Keep the book open and retry adding its new location to Library in Books";
  expect(new HostCommandError("project_move", moved + retrySuffix).problem).toBe(t("host-error.move-registration"));
  expect(new HostCommandError("project_move", moved + retrySuffix + "\n").problem).toBe(t("host-error.move-registration-unavailable"));
  const openFailure = new HostCommandError("project_move", "could not open the book after its move: Permission denied (os error 13)");
  expect(openFailure.problem).toBe(t("host-error.unavailable"));
  expect(new HostCommandError("project_open", moved).problem).toBe(t("host-error.unavailable"));
});
