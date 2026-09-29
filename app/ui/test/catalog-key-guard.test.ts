// app/ui/test/catalog-key-guard.test.ts
// Every t("...") and plural("...") call site names a key that must exist in
// the English catalog. Bare-toLocaleString's own shape, restated for
// catalog keys instead of number formatting: a call site with a typo'd or
// never-added key renders `missing-key-text`'s placeholder marker for a
// writer instead of throwing at build time, and nothing else in this repo
// catches that before someone reads a capture closely enough to notice.
//
// COMMENTS STRIPPED FIRST, `no-hardcoded-strings.test.ts`'s own reason: the
// prose in this repo's source quotes catalog keys constantly (explaining
// why one exists, or citing one by name), and a scan of the raw text would
// find those quotes as if they were call sites.
//
// ONLY STATIC STRING LITERALS ARE CHECKED. `t(`design.margin.${axis}`)` and
// its several siblings (status-dot.ts, preview-rail.ts, statistics.ts,
// mirror-changes.ts, export-formats.ts, statistics-export.ts) build their
// key from a closed, small enumeration this file cannot see without
// importing each module's own type -- the same reason this guard cannot
// reach them, and reading each one confirms every arm they can produce is a
// real key in en.ts. A regex requiring a literal `"` immediately after `t(`
// or `plural(` already excludes every one of them, by construction, since a
// template literal opens with a backtick: nothing here needs a second
// exemption list for them to fall through cleanly.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EN } from "../src/i18n";

const en: Readonly<Record<string, string>> = EN;

const SOURCE = join(import.meta.dir, "..", "src");
const CATALOG_FILES = new Set([join(SOURCE, "i18n", "en.ts"), join(SOURCE, "i18n", "de.ts")]);

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function tsFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesIn(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

interface Call {
  file: string;
  line: number;
  kind: "t" | "plural";
  key: string;
}

/** `t("key"` and `plural("key"`, word-boundaried so `format(t("x"))` and
 *  `notAT("x")`-shaped false positives (there are none today, but the
 *  boundary costs nothing) cannot both match `t(`. */
const CALL_RE = /\b(t|plural)\(\s*"((?:[^"\\]|\\.)*)"/g;

function callsIn(file: string, src: string): Call[] {
  const stripped = stripComments(src);
  const out: Call[] = [];
  for (const m of stripped.matchAll(CALL_RE)) {
    const before = stripped.slice(0, m.index ?? 0);
    const line = before.split("\n").length;
    out.push({ file, line, kind: m[1] as "t" | "plural", key: m[2]! });
  }
  return out;
}

describe("every t()/plural() call site names a key the EN catalog holds", () => {
  const files = tsFilesIn(SOURCE).filter((f) => !CATALOG_FILES.has(f));

  test("the parser reaches every source file and finds calls in them", () => {
    // VACUITY GUARD, `no-hardcoded-strings.test.ts`'s own precedent: a
    // parser matching nothing passes everything, which is the recorded
    // shape of three guards in this repo.
    expect(files.length).toBeGreaterThan(30);
    const all = files.flatMap((f) => callsIn(f, readFileSync(f, "utf8")));
    expect(all.length).toBeGreaterThan(100);
  });

  test("no t() call names a key missing from the EN catalog", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const call of callsIn(file, readFileSync(file, "utf8"))) {
        if (call.kind !== "t") continue;
        if (en[call.key] === undefined) {
          offenders.push(`${file.slice(SOURCE.length + 1)}:${call.line}  t("${call.key}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no plural() call names a base key with no .other arm in the EN catalog", () => {
    // messages.ts's own fallback: plural(key, count) looks up
    // `${key}.${category}` and falls back to `${key}.other` when the
    // language-specific category is absent, but `.other` itself is not
    // optional -- a catalog missing it renders the raw key for whichever
    // count that category never covers, which is the real error `plural`'s
    // own comment already names.
    const offenders: string[] = [];
    for (const file of files) {
      for (const call of callsIn(file, readFileSync(file, "utf8"))) {
        if (call.kind !== "plural") continue;
        if (en[`${call.key}.other`] === undefined) {
          offenders.push(`${file.slice(SOURCE.length + 1)}:${call.line}  plural("${call.key}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
