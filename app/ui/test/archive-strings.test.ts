// app/ui/test/archive-strings.test.ts
// The device-loss namespace, and the wording the design mandates for it.
//
// This is the INVERSE of `recovery-indicator.test.ts`'s blur guard and it
// exists for the same argument. That one forbids the same-device strings from
// borrowing device-loss phrasing; this one forbids the device-loss strings from
// borrowing same-device phrasing and requires the whole folder instruction.
//
// The namespace split is why both guards can be at full strength. The mandated
// sentence contains "off this computer", which the recovery guard forbids in
// every `recovery.*` key -- so these strings live under `archive.*` rather than
// the recovery guard being weakened to admit them.

import { describe, expect, test } from "bun:test";
import { EN } from "../src/i18n/en";

const archiveKeys = () =>
  Object.keys(EN).filter(
    (k) => k.startsWith("archive.") || k.startsWith("switcher.archive."),
  );

describe("the device-loss strings say which protection they are", () => {
  test("the whole archive folder must leave this computer", () => {
    // The asset-aware archive is a directory, so moving only project.db would
    // silently omit its original images.
    const values = archiveKeys().map((k) => (EN as Record<string, string>)[k] ?? "");
    expect(values.length).toBeGreaterThan(8);
    const carrying = values.filter((v) =>
      v.toLowerCase().includes("move the whole folder off this computer yourself"),
    );
    expect(carrying.length).toBeGreaterThan(0);
  });

  test("nothing here claims the application moved the file", () => {
    // The application has no way to know the file left the device and no
    // dialog through which to arrange it. A past tense about the file's
    // location is the failure this whole feature exists to prevent: a writer
    // believing they are protected when they are not.
    const forbidden = [
      "backed up off",
      "saved off this computer",
      "uploaded",
      "synced",
      "sent to",
      "your book is safe",
      "protected from losing this computer",
    ];
    const keys = archiveKeys();
    // The vacuity guard, without which an empty namespace passes every
    // forbidden-phrase check in this file.
    expect(keys.length).toBeGreaterThan(8);
    for (const key of keys) {
      const value = ((EN as Record<string, string>)[key] ?? "").toLowerCase();
      for (const phrase of forbidden) {
        expect(`${key}: ${value}`).not.toContain(phrase);
      }
    }
  });

  test("no archive string describes itself as being on this device", () => {
    // "on this device" is the SAME-DEVICE surface's phrase and it is
    // load-bearing there. An archive that borrowed it would describe the one
    // file in this feature that is meant to leave as though it were the one
    // that cannot.
    const keys = archiveKeys();
    expect(keys.length).toBeGreaterThan(8);
    for (const key of keys) {
      const value = ((EN as Record<string, string>)[key] ?? "").toLowerCase();
      expect(`${key}: ${value}`).not.toContain("on this device");
    }
  });

  test("the heading names device loss and never says 'recovery'", () => {
    // The maintenance note: a panel with one "Recovery" heading covering
    // both protections is the design's forbidden blur with a different shape.
    const heading = (EN as Record<string, string>)["switcher.archive.heading"];
    expect(heading).toBeDefined();
    expect(heading.toLowerCase()).not.toContain("recovery");
  });
});
