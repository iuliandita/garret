// app/ui/test/mirror-strings.test.ts
// The one surface in this trio that is NOT a protection, and the wording guard
// that keeps it that way.
//
// `recovery-indicator.test.ts` forbids the same-device strings from borrowing
// device-loss phrasing; `archive-strings.test.ts` forbids the reverse. This is
// the third guard and it is the strongest of the three, because the mirror is
// the one that protects nothing at all: it is a folder of ordinary Markdown on
// the same disk as the manuscript, written by this application and never read
// back. A writer who came to believe it was a backup would be relying on a copy
// that dies with the drive and that this application overwrites on a timer.
//
// The panel already says so in prose ("It is a copy to read and edit
// elsewhere, not a backup"). This guard is what stops a later string from
// quietly taking it back.

import { describe as suite, expect, test } from "bun:test";
import { EN } from "../src/i18n/en";

const mirrorKeys = () =>
  Object.keys(EN).filter((k) => k.startsWith("mirror.") || k.startsWith("switcher.mirror."));

const valueOf = (key: string): string => ((EN as Record<string, string>)[key] ?? "").toLowerCase();

suite("the mirror never describes itself as protection", () => {
  test("the thorough check is named plainly and reports the writer-facing counts", () => {
    expect(valueOf("switcher.mirror.check")).toBe("check the mirror thoroughly");
    for (const name of ["entries", "changed", "deleted"]) {
      expect(valueOf("mirror.notice.checked")).toContain(`{${name}}`);
    }
    expect(valueOf("mirror.notice.checked")).toContain("missing");
  });

  test("no mirror string borrows the protection vocabulary", () => {
    // `backup` and `recovery` are the same-device surface's words, `protect`
    // and `safe` are claims no folder on this disk can make, and "off this
    // computer" is the device-loss sentence the archive guard MANDATES -- a
    // mirror string carrying it would promise the one thing this feature
    // structurally cannot do.
    const forbidden = ["backup", "protect", "safe", "recovery", "off this computer"];
    const keys = mirrorKeys();
    // The vacuity guard both sibling files carry, without which an empty
    // namespace passes every forbidden-phrase check above.
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      const value = valueOf(key);
      for (const phrase of forbidden) {
        // The panel's note says what the mirror is NOT, in those words, and it
        // is the one string allowed to name what it is being distinguished
        // from. Every other key is held to the plain rule.
        if (key === "switcher.mirror.note") continue;
        expect(`${key}: ${value}`).not.toContain(phrase);
      }
    }
  });

  test("the note is the only string allowed to say 'not a backup', and it does", () => {
    // Carved out above, so the carve-out has to be load-bearing rather than an
    // escape hatch a later string can widen.
    expect(valueOf("switcher.mirror.note")).toContain("not a backup");
  });

  test("nothing here calls the folder a merge or a sync", () => {
    // THIS GUARD SURVIVED AND CHANGED WHAT IT MEANS. Until acceptance
    // shipped it said the application never reads a file back, which is no
    // longer true. What is still true, and is the stronger claim, is HOW it
    // reads one: a whole document replaces a whole document, once, because the
    // writer pressed a control on a row they were looking at. There is no merge
    // in this design and there must not be one -- import refuses to merge into
    // an open book for the recorded reason that merging can wreck one with no
    // recovery -- and nothing here is continuous, so it is not a sync either.
    const forbidden = ["merge", "kept in sync", "two-way"];
    const explicitDisclosure = new Set([
      "switcher.mirror.preview.plaintext",
      "switcher.mirror.preview.limit.external",
      "mirror.name.unavailable",
    ]);
    const keys = mirrorKeys();
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      const value = valueOf(key);
      for (const phrase of forbidden) {
        expect(`${key}: ${value}`).not.toContain(phrase);
      }
      if (!explicitDisclosure.has(key)) expect(`${key}: ${value}`).not.toContain("sync");
    }
  });

  test("the accept says whose words move and where the way back is", () => {
    // The two things a writer needs from a control that overwrites their own
    // prose. The direction, because a control on a comparison surface that does
    // not say which side it takes is a control half its readers press
    // backwards; and the snapshot, because it is the ONLY inverse -- this
    // application has no structural undo, and a sentence that did not name the
    // history panel would leave the way back undiscoverable.
    expect(valueOf("mirror.changes.accept.name")).toContain("in the file into");
    for (const key of ["mirror.changes.accepted.one", "mirror.changes.accepted.other"]) {
      expect(valueOf(key)).toContain("history panel");
    }
  });

  test("the underline loss is stated before the press as well as after it", () => {
    // Markdown has no underline, the mirror's own write dropped it, and no
    // accept can bring it back. A writer told this only afterwards has been
    // apologised to; the row string is the one that informs a decision.
    for (const key of [
      "mirror.changes.loss.underline.one",
      "mirror.changes.loss.underline.other",
    ]) {
      expect(valueOf(key)).toContain("underlined run");
      expect(valueOf(key)).toContain("lose");
    }
  });

  test("the paused wording says the application is leaving the file alone", () => {
    // The single worst thing this feature could do is overwrite an external
    // edit. The state that exists to prevent it owes the writer the fact that
    // it IS preventing it -- "paused" alone reads as a mirror that stopped.
    for (const key of ["mirror.name.paused.one", "mirror.name.paused.other"]) {
      expect(valueOf(key)).toContain("not writing over it");
    }
  });

  test("the finding state never borrows the paused or failing wording", () => {
    // The design spends a paragraph on this: a finding does not pause the
    // mirror, does not skip the entry and does not fail the pass. Reporting it
    // in either of their words would claim the folder is out of date at the
    // exact moment it is exactly current.
    const finding = `${valueOf("mirror.text.finding")} ${valueOf("mirror.name.finding")}`;
    expect(finding).not.toContain("paused");
    expect(finding).not.toContain("failing");
    expect(finding).not.toContain("last updated");
    expect(finding).toContain("current");
  });
});
