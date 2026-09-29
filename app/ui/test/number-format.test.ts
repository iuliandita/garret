import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DE, EN, createMessages, formatDate, formatDateTime, formatNumber } from "../src/i18n";

const SOURCE = join(import.meta.dir, "..", "src");

// 090: digits are grouped for the language the writer chose, not for the
// process locale. `messages.number` carries the catalog's tag; every figure
// on the page goes through `formatNumber`, and the walk below refuses the
// bare call that would silently follow the shell again.

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("number grouping follows the language", () => {
  test("a German instance groups with a point and an English one with a comma", () => {
    expect(createMessages(DE, "de").number(2000)).toBe("2.000");
    expect(createMessages(EN, "en").number(2000)).toBe("2,000");
    expect(createMessages(DE, "de").number(1234567)).toBe("1.234.567");
  });

  test("the page's own formatNumber is bound to the page's locale", () => {
    // Outside the host the page is English; the number carries a comma.
    expect(formatNumber(4812)).toBe("4,812");
    expect(formatNumber(7)).toBe("7");
  });

  test("display dates use the selected language without changing machine timestamps", () => {
    const atMs = Date.UTC(2026, 5, 15, 12, 34);
    const instant = new Date(atMs);
    const german = createMessages(DE, "de");
    const english = createMessages(EN, "en");
    expect(german.date(atMs)).toBe(instant.toLocaleDateString("de"));
    expect(german.dateTime(atMs)).toBe(instant.toLocaleString("de"));
    expect(english.dateTime(atMs)).toBe(instant.toLocaleString("en"));
    expect(german.dateTime(atMs)).not.toBe(english.dateTime(atMs));
    expect(formatDate(atMs)).toBe(english.date(atMs));
    expect(formatDateTime(atMs)).toBe(english.dateTime(atMs));
  });

  test("no page source calls toLocaleString() bare: every figure goes through formatNumber", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const file of sources(SOURCE)) {
      const rel = relative(SOURCE, file);
      if (rel === join("i18n", "messages.ts")) continue;
      const text = readFileSync(file, "utf8");
      sites += (text.match(/formatNumber\(/g) ?? []).length;
      for (const [index, line] of text.split("\n").entries()) {
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        if (line.includes("toLocaleString(")) offenders.push(`${rel}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity: the walk saw the call sites it protects.
    expect(sites).toBeGreaterThanOrEqual(50);
  });
});
