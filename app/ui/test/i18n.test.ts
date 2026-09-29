import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DE, EN, catalogFor, createMessages, messages, missingKeyText, plural, t } from "../src/i18n";

const SOURCE = join(import.meta.dir, "..", "src");

/** A five-key catalog, so every assertion here is about the lookup and not
 *  about whatever the English catalog happens to hold today. */
const FIXTURE = {
  "test.plain": "A plain sentence.",
  "test.filled": "Opened {name} at {when}.",
  "test.count.one": "{count} scene",
  "test.count.other": "{count} scenes",
  "test.other-only.other": "{count} things",
} as const;

describe("the catalog lookup", () => {
  test("a known key returns its string", () => {
    const m = createMessages(FIXTURE);
    expect(m.t("test.plain")).toBe("A plain sentence.");
  });

  test("a missing key renders the key itself, visibly", () => {
    const m = createMessages(FIXTURE);
    const out = m.t("test.absent");
    // Not empty, not a throw: the two failure modes this rule exists to
    // prevent. Empty text is invisible in a capture and in the accessibility
    // tree alike, and a throw turns one absent label into a blank window.
    expect(out).not.toBe("");
    expect(out).toContain("test.absent");
    expect(out).toBe(missingKeyText("test.absent"));
    // And it must be TELLABLE from a real string. A bare key would render as
    // ordinary-looking text in a screenshot.
    expect(out).not.toBe("test.absent");
  });

  test("a missing key does not throw", () => {
    const m = createMessages(FIXTURE);
    expect(() => m.t("test.absent")).not.toThrow();
  });

  test("interpolation substitutes every placeholder", () => {
    const m = createMessages(FIXTURE);
    expect(m.t("test.filled", { name: "Chapter Two", when: "just now" })).toBe(
      "Opened Chapter Two at just now.",
    );
  });

  test("a placeholder with no value is left as written", () => {
    // Same reasoning as the visible key: `{when}` on screen is a bug report,
    // an empty gap is a mystery.
    const m = createMessages(FIXTURE);
    expect(m.t("test.filled", { name: "Chapter Two" })).toBe("Opened Chapter Two at {when}.");
  });

  test("a number is stringified, never formatted", () => {
    // THE RECORDED TRAP. `goals.ts` builds YYYY-MM-DD by hand because a
    // locale-shaped date is a property of the runtime's ICU data, and two
    // graded rigs parse figures out of the accessibility tree. Formatting
    // inside the catalog would move that decision somewhere nobody looks.
    const m = createMessages({ "test.n": "{n} words" });
    expect(m.t("test.n", { n: 12345 })).toBe("12345 words");
  });

  test("has() answers for a present and an absent key", () => {
    const m = createMessages(FIXTURE);
    expect(m.has("test.plain")).toBe(true);
    expect(m.has("test.absent")).toBe(false);
  });
});

describe("CLDR plural categories", () => {
  // 0, 1, 2, 11 and 21 - the set that tells English apart from the languages
  // whose rules key on the last digit or on a `few`.
  const CASES: ReadonlyArray<readonly [number, string]> = [
    [0, "0 scenes"],
    [1, "1 scene"],
    [2, "2 scenes"],
    [11, "11 scenes"],
    [21, "21 scenes"],
  ];

  for (const [count, expected] of CASES) {
    test(`${count} selects the right category`, () => {
      const m = createMessages(FIXTURE);
      expect(m.plural("test.count", count)).toBe(expected);
    });
  }

  test("count is available as {count} without being passed", () => {
    const m = createMessages(FIXTURE);
    expect(m.plural("test.count", 3)).toBe("3 scenes");
  });

  test("an explicit vars entry wins over the raw count", () => {
    // The formatted figure is what a writer reads: `1,204 scenes`, not
    // `1204 scenes`. The call site formats and passes it under the same name.
    const m = createMessages(FIXTURE);
    expect(m.plural("test.count", 1204, { count: "1,204" })).toBe("1,204 scenes");
  });

  test("a category the catalog omits falls back to other", () => {
    const m = createMessages(FIXTURE);
    expect(m.plural("test.other-only", 1)).toBe("1 things");
  });

  test("a plural key with no entries at all renders the key visibly", () => {
    const m = createMessages(FIXTURE);
    const out = m.plural("test.absent", 2);
    expect(out).toBe(missingKeyText("test.absent.other"));
    expect(out).toContain("test.absent");
  });

  test("the locale drives the rules, not the machine", () => {
    // Welsh has six categories; the point is only that the injected locale is
    // the one asked, so a second catalog gets its own language's rules rather
    // than English's.
    const cy = createMessages({ "n.zero": "dim", "n.other": "rhai" }, "cy");
    expect(cy.locale).toBe("cy");
    expect(cy.plural("n", 0)).toBe("dim");
    const en = createMessages({ "n.zero": "dim", "n.other": "rhai" }, "en");
    expect(en.plural("n", 0)).toBe("rhai");
  });
});

describe("the English catalog", () => {
  test("the module-level instance reads the English catalog", () => {
    expect(messages.locale).toBe("en");
    const entries = Object.entries(EN as Record<string, string>);
    expect(entries.length).toBeGreaterThan(200);
    for (const [key, value] of entries) expect(t(key)).toBe(value);
  });

  test("every plural base the catalog declares has an English one and other", () => {
    const bases = new Set<string>();
    for (const key of Object.keys(EN)) {
      const m = /^(.*)\.(one|other|zero|two|few|many)$/.exec(key);
      if (m?.[1] !== undefined) bases.add(m[1]);
    }
    // Vacuity guard: a catalog holding no plural pairs would satisfy the loop
    // below by having nothing to check.
    expect(bases.size).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const base of bases) {
      for (const category of ["one", "other"]) {
        if (!(`${base}.${category}` in EN)) missing.push(`${base}.${category}`);
      }
    }
    expect(missing).toEqual([]);
    // And the bound helper reaches every one of them.
    for (const base of bases) expect(plural(base, 2)).not.toContain("⟦");
  });

  test("the catalog file parses and declares no key twice", () => {
    // A duplicate key in an object literal is legal TypeScript: the later one
    // silently wins and the earlier string is unreachable. Nothing at runtime
    // can see it, so this is read off the source.
    const source = readFileSync(join(SOURCE, "i18n", "en.ts"), "utf8");
    const body = source.slice(source.indexOf("export const EN"));
    const declared = [...body.matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1] as string);
    expect(declared.length).toBeGreaterThan(200);
    // Every key the source declares is a key the module exports, which is what
    // makes the count above a real vacuity guard rather than a regex that
    // matched something else in the file.
    expect(new Set(declared)).toEqual(new Set(Object.keys(EN)));
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const key of declared) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  test("no catalog string is empty", () => {
    const empty = Object.entries(EN as Record<string, string>)
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });
});

describe("which catalog the page uses", () => {
  test("the host's injected tag chooses the catalog", () => {
    // WHERE THE LANGUAGE IS CHOSEN: the host reads
    // `settings.json` and injects the tag, exactly as it injects the theme and
    // the typography.
    const chosen = catalogFor("en");
    expect(chosen.locale).toBe("en");
    expect(chosen.catalog).toBe(EN);
  });

  test("a REAL second catalog is chosen by its own tag, not just an injected one", () => {
    // The falsifiability requirement: with `de` a real shipped catalog
    // rather than a fixture, `catalogFor("de")` answering `EN` and answering
    // `DE` are now different claims.
    const chosen = catalogFor("de");
    expect(chosen.locale).toBe("de");
    expect(chosen.catalog).toBe(DE);
  });

  test("a tag this build has no catalog for falls back to English", () => {
    // Both the absent injection (a page opened outside the host) and a tag the
    // host knows and the page does not. Neither may render `⟦key⟧` for every
    // label on the screen.
    for (const tag of [undefined, "", "fr", "en-GB"]) {
      const chosen = catalogFor(tag);
      expect(chosen.locale).toBe("en");
      expect(chosen.catalog).toBe(EN);
    }
  });

  test("a tag that names a property every object inherits still falls back to English", () => {
    // `catalogs` is a plain object literal, so `catalogs["constructor"]` reads
    // the `Object` constructor off the prototype chain rather than `undefined`
    // -- a bracket-read-compared-to-undefined implementation would have
    // rendered the page as if "constructor" were a real, known language.
    for (const tag of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const chosen = catalogFor(tag);
      expect(chosen.locale).toBe("en");
      expect(chosen.catalog).toBe(EN);
    }
  });

  test("the fallback is a fallback and not the only branch", () => {
    // The vacuity half: a `catalogFor` that ignored its argument entirely
    // would pass both tests above. Asked about a catalog that is NOT English,
    // it must answer with that one.
    const other = { "nav.label": "x" } as const;
    expect(catalogFor("qq", { en: EN, qq: other }).catalog).toBe(other);
    expect(catalogFor("qq", { en: EN, qq: other }).locale).toBe("qq");
  });
});

describe("the module-scope instance the page actually boots with", () => {
  // THE FOURTH EQUIVALENT MUTANT from the single-catalog record, pinned:
  // `messages`/`t` at the top of `index.ts` are built ONCE, from
  // `window.__appLocale`, when the module is first evaluated -- not on every
  // call. With one catalog shipping, a build that read the global and one
  // that hard-coded "en" produced the same module every time. `de` being a
  // real second catalog is what makes that read falsifiable, and reaching it
  // needs a FRESH evaluation of the module with the global already set, which
  // is what the cache-busted dynamic import below is for.
  test("__appLocale set before the module loads renders the German catalog", async () => {
    const globals = globalThis as { __appLocale?: string };
    const before = globals.__appLocale;
    globals.__appLocale = "de";
    try {
      const path = join(import.meta.dir, "..", "src", "i18n", "index.ts");
      const fresh = (await import(`${path}?bust=${Date.now()}-${Math.random()}`)) as {
        t: typeof t;
        formatDateTime: (atMs: number) => string;
      };
      expect(fresh.t("menu.file")).toBe("Datei");
      expect(fresh.t("menu.file")).not.toBe(EN["menu.file"]);
      const atMs = Date.UTC(2026, 5, 15, 12, 34);
      expect(fresh.formatDateTime(atMs)).toBe(new Date(atMs).toLocaleString("de"));
    } finally {
      globals.__appLocale = before;
    }
  });
});
