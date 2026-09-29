import { describe, expect, test } from "bun:test";
import { reportedUnderlinesIn } from "../src/notice-read";
import { EN } from "../../ui/src/i18n";

/** The sentence the page actually shows, built from the catalog the way the
 *  page builds it. Not a hand-written imitation: a rig that parsed a sentence
 *  nobody ships would pass while the real notice went unread. */
function notice(count: number, path: string): string {
  const key = count === 1 ? "export.done.underlined.one" : "export.done.underlined.other";
  const template = EN[key];
  if (template === undefined) throw new Error(`no ${key} in the catalog`);
  return template
    .replaceAll("{path}", path)
    .replaceAll("{count}", String(count))
    // Since 040 the sentence names its format -- twice, and `replace` takes only
    // the first. A helper leaving `{format}` in the string would hand the parser
    // a sentence the page never shows.
    .replaceAll("{format}", "Markdown");
}

describe("reportedUnderlinesIn", () => {
  test("it reads the figure out of the sentence the page ships", () => {
    expect(reportedUnderlinesIn(notice(1, "/exports/novel.md"))).toBe(1);
    expect(reportedUnderlinesIn(notice(4, "/exports/novel.md"))).toBe(4);
  });

  test("digits in the PATH are not the count", () => {
    // `pick_export_path` numbers its files, so the second export of a book is
    // `my-novel-2.md`. A parser taking the first number in the sentence would
    // report 2 for every run and agree with the store by accident about a third
    // of the time.
    expect(reportedUnderlinesIn(notice(1, "/exports/my-novel-2.md"))).toBe(1);
    expect(reportedUnderlinesIn(notice(12, "/exports/my-novel-2.md"))).toBe(12);
  });

  test("an export that lost nothing reads as NOT REPORTED, not as zero", () => {
    // The page says nothing about underlining when it dropped nothing, and the
    // gate must not read that silence as "the application reported 0" -- it
    // treats the whole measurement as untaken instead.
    const plain = (EN["export.done"] ?? "")
      .replaceAll("{path}", "/exports/novel.md")
      .replaceAll("{format}", "Markdown");
    expect(plain.length).toBeGreaterThan(0);
    expect(reportedUnderlinesIn(plain)).toBeNull();
  });

  test("no banner at all is null", () => {
    expect(reportedUnderlinesIn(null)).toBeNull();
    expect(reportedUnderlinesIn("")).toBeNull();
  });

  test("a sentence about underlining with no figure in it is null", () => {
    // Rather than 0 or NaN: a shape this parser does not understand is a
    // measurement it did not take.
    expect(reportedUnderlinesIn("Markdown has no underline.")).toBeNull();
  });

  test("a thousands separator survives", () => {
    // The catalog interpolates with String(value) today, so this cannot arise
    // from the page as it stands -- and a call site that starts formatting is
    // exactly the change that would silently make every reading 1.
    expect(reportedUnderlinesIn("so 1,024 underlined runs were written as plain text.")).toBe(1024);
  });
});
