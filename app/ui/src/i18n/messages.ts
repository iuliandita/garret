// app/ui/src/i18n/messages.ts
// Message keys, one catalog per language, and locale-bound display formatting.
//
// Product spec sections 5 and 19 ask for message keys, an English source
// catalog, fallback-then-visible-key behaviour, CLDR plurals and loadable
// bundles. This is the whole of that machinery: no dependency, no framework,
// no build step. `en.ts` and `de.ts` are the two catalogs this build ships;
// this module does not know or care how many there are, which is what lets a
// second one exist without a change here.
//
// A MISSING KEY RENDERS THE KEY, VISIBLY. Not empty text, which is invisible
// in a screenshot and in the accessibility tree alike; not a throw, which
// turns one absent label into a blank window. `⟦nav.label⟧` in a capture says
// what is missing and where to fix it, and every capture in this repo is a
// measurement.
//
// INTERPOLATED NUMBERS AND DATES ARE NOT FORMATTED HERE, deliberately. `goals.ts` records
// why `localDate` builds `YYYY-MM-DD` by hand rather than through
// `toLocaleDateString("en-CA")`: that shape is a locale convention and a
// property of whatever ICU data the runtime was built with, and the host
// refuses anything else. The same reasoning holds for every figure a rig
// parses out of the accessibility tree. So interpolation does `String(value)`
// and nothing more. Display figures and timestamps use the locale-bound
// helpers below; machine dates keep their exact stored shape.
// Plural categories also follow the catalog's language.

/** A language's messages. Keys are `area.name`; a plural has one entry per
 *  CLDR category under `area.name.<category>`. */
export type Catalog = Readonly<Record<string, string>>;

/** Interpolation values. Numbers are stringified with `String`, never
 *  formatted - see the header. */
export type Vars = Readonly<Record<string, string | number>>;

export interface Messages {
  /** The string for `key`, with `{name}` placeholders filled from `vars`. */
  t(key: string, vars?: Vars): string;
  /** The string for `key.<category>`, where the category is the CLDR plural
   *  category of `count` in this catalog's language. `count` is available to
   *  the template as `{count}` unless `vars` names it. */
  plural(key: string, count: number, vars?: Vars): string;
  /** Whether the catalog holds `key`. For guards and tests, not for call
   *  sites - a call site that has to ask has a missing key. */
  has(key: string): boolean;
  /** The language this instance was built for. */
  readonly locale: string;
  /** A count or figure with the catalog's own digit grouping ("2,000" in
   *  English, "2.000" in German), whatever the process locale is. */
  number(n: number): string;
  /** A displayed date in this catalog's language, never a stored machine date. */
  date(atMs: number): string;
  /** A displayed local date and time in this catalog's language. */
  dateTime(atMs: number): string;
  /** A short date and time for a summary line ("Sep 25, 10:15 PM"): no
   *  seconds, and the year only when it is not this year. */
  shortDateTime(atMs: number): string;
  /** A short date for a list row ("Sep 25"), the year only when it differs. */
  shortDate(atMs: number): string;
}

/** How a missing key renders. Two characters no message uses, so a capture,
 *  a grep and an accessibility dump all show it unambiguously. */
export function missingKeyText(key: string): string {
  return `⟦${key}⟧`;
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Fill `{name}` from `vars`. AN UNKNOWN NAME IS LEFT AS WRITTEN rather than
 *  replaced with nothing, for the same reason a missing key renders visibly:
 *  a label reading `{count} words` is a bug report, `words` is a mystery. */
function interpolate(template: string, vars: Vars | undefined): string {
  if (vars === undefined) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * A lookup over one catalog.
 *
 * The catalog and the locale are INJECTED, so a test can build an instance
 * over three keys and a second language's rules without touching the English
 * catalog or any global.
 */
/** Month and day, and the year only when it is not the current one. */
function shortDay(atMs: number): Intl.DateTimeFormatOptions {
  const sameYear = new Date(atMs).getFullYear() === new Date().getFullYear();
  return sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
}

export function createMessages(catalog: Catalog, locale = "en"): Messages {
  // Constructed once. `Intl.PluralRules` is not free and `plural` runs on the
  // typing path (the word count relabels per keystroke).
  const rules = new Intl.PluralRules(locale);

  function t(key: string, vars?: Vars): string {
    const template = catalog[key];
    if (template === undefined) return missingKeyText(key);
    return interpolate(template, vars);
  }

  function plural(key: string, count: number, vars?: Vars): string {
    const category = rules.select(count);
    // `other` is the fallback INSIDE the plural lookup, not `missingKeyText`:
    // a language whose catalog was written with only `one` and `other` must
    // not render a raw key the day a `few` case is selected. A catalog missing
    // `other` as well does render the key, which is the real error.
    const template = catalog[`${key}.${category}`] ?? catalog[`${key}.other`];
    if (template === undefined) return missingKeyText(`${key}.${category}`);
    return interpolate(template, { count, ...vars });
  }

  return {
    t, plural, has: (key) => catalog[key] !== undefined, locale,
    number: (n) => n.toLocaleString(locale),
    date: (atMs) => new Date(atMs).toLocaleDateString(locale),
    dateTime: (atMs) => new Date(atMs).toLocaleString(locale),
    shortDateTime: (atMs) => new Date(atMs).toLocaleString(locale, {
      ...shortDay(atMs), hour: "numeric", minute: "2-digit",
    }),
    shortDate: (atMs) => new Date(atMs).toLocaleDateString(locale, shortDay(atMs)),
  };
}
