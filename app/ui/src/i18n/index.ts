// app/ui/src/i18n/index.ts
// The instance the page uses.
//
// ONE MODULE-SCOPE INSTANCE, not a dependency threaded through thirty-two
// units. Every other unit here is a factory taking its dependencies, and this
// one deliberately is not: `createMessages` IS that factory and is what the
// tests build, but a catalog is not a collaborator a unit can meaningfully be
// given a different version of. Threading it would have rewritten every
// constructor and every test's call to one, inside the same change that moved
// four hundred literals - and an unreviewable migration is how a reworded
// string reaches a rig unnoticed.
//
// The instance holds no mutable state: both catalogs are frozen and nothing
// writes to them. The language is chosen by host injection, like the theme and
// the typography - `catalogFor` below is where that choice is made, and
// `app/ui/test/catalog-completeness.test.ts` is what keeps a second catalog
// honest against the first: every key of `EN` in `DE`, every placeholder
// carried over, and no value equal to its English twin except a named,
// non-vacuous allowlist of proper terms.

import { EN } from "./en";
import { DE } from "./de";
import { createMessages, type Catalog, type Messages } from "./messages";

export { createMessages, missingKeyText, type Catalog, type Messages, type Vars } from "./messages";
export { EN } from "./en";
export { DE } from "./de";

/** Every catalog this build ships, by BCP-47 tag. Exported so a third list of
 *  languages - the preferences panel's own `LOCALES` - can be checked against
 *  this one rather than drift from it silently; see
 *  `preferences.test.ts`'s own test of that. */
export const CATALOGS: Readonly<Record<string, Catalog>> = { en: EN, de: DE };

/**
 * Which catalog a language tag selects, falling back to English.
 *
 * EXTRACTED AND INJECTABLE rather than inlined below, for this repo's recorded
 * reason: a rule written where no test can reach it is an instrument nobody can
 * falsify, and `catalogFor(window.__appLocale)` inlined would be exactly that -
 * `messages` below is built once, at module load, and an ordinary test import
 * only ever evaluates that once. `i18n.test.ts` still reaches the module-scope
 * read directly, through a cache-busted dynamic import that forces a second
 * evaluation with `__appLocale` already set - but that is one test earning
 * back what `catalogFor`'s own extraction already made falsifiable on its own
 * terms.
 */
export function catalogFor(
  tag: string | undefined,
  catalogs: Readonly<Record<string, Catalog>> = CATALOGS,
): { locale: string; catalog: Catalog } {
  // `Object.hasOwn`, not a bracket read compared to `undefined`: `catalogs` is
  // a plain object literal, so `catalogs["constructor"]` answers the `Object`
  // constructor rather than `undefined` and a bracket-only check would render
  // the page as if a tag named "constructor" were a real, known language.
  const catalog = tag !== undefined && Object.hasOwn(catalogs, tag) ? catalogs[tag] : undefined;
  return catalog === undefined ? { locale: "en", catalog: catalogs.en ?? EN } : { locale: tag as string, catalog };
}

/** The tag the HOST chose, from `settings.json`, injected beside the theme and
 *  the typography. Absent when the page is opened outside the host. */
const chosen = catalogFor(
  (globalThis as { __appLocale?: string }).__appLocale,
);

/** The page's messages, in the language the host said. */
export const messages: Messages = createMessages(chosen.catalog, chosen.locale);

/** `t("key", vars)` - the ordinary lookup. Bound so a call site can import it
 *  alone. */
export const t: Messages["t"] = (key, vars) => messages.t(key, vars);

/** `plural("key", n, vars)` - selects `key.<CLDR category>`. */
export const plural: Messages["plural"] = (key, count, vars) => messages.plural(key, count, vars);

/** `formatNumber(n)` - digits grouped for the language the host chose, not
 *  for the process locale (090). Every figure the page shows goes through
 *  this; `number-format.test.ts` refuses a bare `toLocaleString()`. */
export const formatNumber: Messages["number"] = (n) => messages.number(n);

/** Display-only dates follow the host-selected language; stored dates do not. */
export const formatDate: Messages["date"] = (atMs) => messages.date(atMs);
export const formatDateTime: Messages["dateTime"] = (atMs) => messages.dateTime(atMs);
export const formatShortDateTime: Messages["shortDateTime"] = (atMs) => messages.shortDateTime(atMs);
export const formatShortDate: Messages["shortDate"] = (atMs) => messages.shortDate(atMs);
