// app/ui/test/catalog-completeness.test.ts
// De is typed against `Readonly<Record<string, string>>`, the same as `EN` --
// so a missing key, a dropped placeholder, or an untranslated value is not a
// compile error. This file is the check that catches all three at runtime,
// and it is what the plan calls "the completeness test's own sabotage": drop
// a key from `de.ts`, or make one of its values byte-identical to English
// outside the allowlist below, and this file turns red.

import { describe, expect, test } from "bun:test";
import { DE } from "../src/i18n/de";
import { EN } from "../src/i18n/en";

const en: Readonly<Record<string, string>> = EN;
const de: Readonly<Record<string, string>> = DE;

/** German CLDR has only `one` and `other`. A key ending in one of these four
 *  suffixes is a plural arm English needed and German structurally cannot --
 *  `messages.plural` falls back to `.other` for any category a catalog omits,
 *  so DE not carrying one is correct, not a gap. */
const EXTRA_PLURAL_ARM = /\.(zero|two|few|many)$/;

/** The same placeholder syntax `messages.ts` interpolates against. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function placeholdersIn(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** Whether a value carries any translatable text at all, once its
 *  placeholders are removed. A template built entirely of punctuation and
 *  `{vars}` -- "{name} - {error}", "{parts}." -- has nothing in it a
 *  translator could reword, so German holding the same glue is not a missed
 *  translation and needs no entry in the allowlist below. */
function hasTranslatableText(value: string): boolean {
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value.replace(PLACEHOLDER, ""));
}

/** One keyboard chord or key name, or None. `de.ts`'s own header records why
 *  these are not translated: the letters are what `menu-bar.ts` binds and
 *  `help.test.ts` compares a catalog's claim against, so a German spelling
 *  here would be a claim about a chord nothing listens for. */
const CHORD_TOKEN =
  /^(Ctrl|Alt|Shift|Up|Down|Left|Right|Home|End|Enter|Escape|Delete|Space|Page|Menu|F\d{1,2}|[A-Z0-9])$/;

/** A value made only of chord tokens joined by "+", "/" or a space -- "Ctrl+Z",
 *  "Alt+Left / Alt+Right", "Page Up / Page Down". Structural, not a fixed
 *  list, so a new chord added to a future key needs no maintenance here. */
function isChordValue(value: string): boolean {
  const tokens = value.split(/[\s/+]+/).filter((t) => t.length > 0);
  return tokens.length > 0 && tokens.every((t) => CHORD_TOKEN.test(t));
}

/** Proper terms this file's own scan found actually colliding between the two
 *  catalogs: loanwords German keeps unchanged (System, Import, Zoom), the
 *  typeface and page-size names spec section 17 names in English, format
 *  names (Markdown, EPUB, PDF, Word), the two language names in the one control
 *  that must name both, and one numeric readout with no words in it besides
 *  a unit and a multiplication "x".
 *
 *  NOT a list to add to freely: `the_allowlist_holds_no_dead_entries` fails
 *  the moment an entry stops colliding, which is what keeps this from
 *  becoming a place a real translation gap hides. */
const ALLOWLIST: readonly string[] = [
  // The banner's disclosure summary: the same loanword in both.
  "Details",
  "Neutral",
  "System",
  "Serif",
  "Sans",
  "Mono",
  "Zoom",
  // Preferences' start-select label: a genuine German loanword,
  // identical in both catalogs on purpose -- shortened from a full sentence
  // after a review capture showed the sentence wrapping onto its own
  // full-width line above the row, breaking the label-left layout every
  // other group in this panel has. The group's title is in the three
  // option sentences, which stayed full German prose.
  "Start",
  "English",
  "Deutsch",
  "Name",
  "Import",
  "A5 (148 x 210 mm)",
  "A4 (210 x 297 mm)",
  "ISO B5 (176 x 250 mm)",
  "mm",
  "in", // Shared short unit suffix; accessible labels use localized full names.
  "Markdown",
  "EPUB",
  "Links",
  "PDF",
  "Word",
  "{width} x {height} mm ({widthIn} x {heightIn} in)",
  // A research copy's size: the SI unit symbols read the same in both.
  "{size} KB",
  "{size} MB",
];

describe("the German catalog against the English one", () => {
  test("the vacuity floor: English holds hundreds of keys, not a handful", () => {
    // Without this, every test below passes vacuously the day `en.ts` is
    // gutted to three keys and `de.ts` follows it down to match: "every key
    // present is present" is true of an empty catalog too.
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(900);
  });

  test("every English key is in German, except the plural arms German's CLDR does not have", () => {
    const missing = Object.keys(en).filter(
      (key) => !(key in de) && !EXTRA_PLURAL_ARM.test(key),
    );
    expect(missing).toEqual([]);
  });

  test("English holds a plural base for every extra arm the vacuity check would otherwise wave through", () => {
    // Neither catalog carries a `.zero`/`.two`/`.few`/`.many` key today (see
    // `en.ts`'s own header), which would make the exemption above vacuous --
    // a filter that never matches anything is a filter nobody can tell apart
    // from one that is wrong. Asserted directly rather than assumed.
    const extraArms = Object.keys(en).filter((key) => EXTRA_PLURAL_ARM.test(key));
    expect(extraArms).toEqual([]);
  });

  test("German holds no key English does not have", () => {
    const extra = Object.keys(de).filter((key) => !(key in en));
    expect(extra).toEqual([]);
  });

  test("every placeholder in an English value is present in its German value", () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(en)) {
      const germanValue = de[key];
      if (germanValue === undefined) continue; // covered by the key-coverage test above
      for (const name of placeholdersIn(value)) {
        if (!germanValue.includes(`{${name}}`)) {
          offenders.push(`${key}: missing {${name}} (German: ${JSON.stringify(germanValue)})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no German value is byte-identical to its English twin outside the allowlist", () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(en)) {
      const germanValue = de[key];
      if (germanValue === undefined) continue;
      if (germanValue !== value) continue;
      if (!hasTranslatableText(value)) continue; // pure glue, nothing to translate
      if (isChordValue(value)) continue; // the chord vocabulary, not prose
      if (ALLOWLIST.includes(value)) continue;
      offenders.push(`${key}: ${JSON.stringify(value)}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the allowlist is non-vacuous and bounded", () => {
    expect(ALLOWLIST.length).toBeGreaterThanOrEqual(1);
    expect(ALLOWLIST.length).toBeLessThanOrEqual(40);
  });

  test("the allowlist holds no dead entries: every one of it actually collides", () => {
    // A rule that permitted a value nothing uses would rot silently -- the
    // next entry added "for later" and never checked again.
    const colliding = new Set<string>();
    for (const [key, value] of Object.entries(en)) {
      if (de[key] === value) colliding.add(value);
    }
    const dead = ALLOWLIST.filter((entry) => !colliding.has(entry));
    expect(dead).toEqual([]);
  });
});


describe("catalog wording conventions", () => {
  test("Library and Books use the same creation action", () => {
    for (const catalog of [en, de]) {
      expect(catalog["switcher.create"]).toBe(catalog["library.new-book.create"]);
      expect(catalog["switcher.refuse.no-name"]).toContain(catalog["switcher.create"]!);
    }
  });

  test("catalog ellipses use the typographic character", () => {
    for (const catalog of [en, de]) {
      const offenders = Object.entries(catalog)
        .filter(([, value]) => value.includes("..."))
        .map(([key]) => key);
      expect(offenders).toEqual([]);
    }
  });

  test("German catalog prose avoids informal address", () => {
    const informalAddress = (value: string): boolean => {
      const prose = value.replace(PLACEHOLDER, "").replace(/`[^`]*`/g, "");
      return /(?:^|[^\p{L}])(?:du|dich|dir|dein(?:e|en|em|er|es|s)?|schließe|öffne|warte|gib)(?=$|[^\p{L}])/iu.test(prose);
    };
    for (const address of ["du", "dich", "dir", "dein", "deine", "deinen", "deinem", "deiner", "deines", "Schließe", "Öffne", "warte", "Gib"]) {
      expect(informalAddress(address)).toBe(true);
    }
    expect(informalAddress("Öffnen Sie {dir}. Bitte warten Sie.")).toBe(false);
    expect(informalAddress("`garret salvage <out-dir>`")).toBe(false);
    const offenders = Object.entries(de)
      .filter(([, value]) => informalAddress(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  test("manuscript scope labels use the established Bible section name", () => {
    for (const catalog of [en, de]) {
      for (const key of ["reading.scope", "outline-view.scope"]) {
        expect(catalog[key]).toContain(catalog["outline.bible-title"]!);
      }
    }
  });

  test("protection guidance names the current recovery and encrypted backup commands", () => {
    for (const catalog of [en, de]) {
      const guide = catalog["help.guide.protect.body"]!;
      for (const key of ["menu.backup-now", "menu.encrypted-backups"]) {
        const label = catalog[key]!.replace(/(?:\.\.\.|…)$/, "");
        const copies = catalog["menu.copies"]!.replace(/(?:\.\.\.|…)$/, "");
        expect(guide).toContain(`${catalog["menu.file"]} > ${copies} > ${label}`);
      }
      const planning = catalog["menu.planning"]!.replace(/(?:\.\.\.|…)$/, "");
      const synopsis = catalog["menu.synopsis"]!.replace(/(?:\.\.\.|…)$/, "");
      expect(catalog["help.guide.annotate.body"]).toContain(`${catalog["menu.outline"]} > ${planning} > ${synopsis}`);
      const publishing = catalog["menu.publishing"]!.replace(/(?:\.\.\.|…)$/, "");
      expect(catalog["help.guide.export.body"]).toContain(`${catalog["menu.file"]} > ${publishing}`);
    }
    expect(en["help.guide.protect.body"]).not.toContain("Back up now");
    expect(de["help.guide.protect.body"]).not.toContain("Jetzt sichern");
  });
});

test("Find summaries use the locale's quotation marks", () => {
  for (const suffix of ["none", "truncated", "one", "other"]) {
    expect(en[`find.summary.${suffix}`]).toContain("“{query}”");
    expect(de[`find.summary.${suffix}`]).toContain("„{query}“");
  }
});


test("replacement names include visible labels in both languages", () => {
  for (const catalog of [en, de]) {
    for (const key of ["find.replace-all", "find.replace-book"]) {
      expect(catalog[`${key}.label`]?.startsWith(`${catalog[key]}:`)).toBe(true);
    }
  }
  expect(de["help.guide.protect.body"]).toContain("Privatsphärensperre");
  expect(de["help.guide.protect.body"]).not.toContain("Datenschutzsperre");
});
