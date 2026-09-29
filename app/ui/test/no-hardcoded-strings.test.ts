import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { EN } from "../src/i18n";

const SOURCE = join(import.meta.dir, "..", "src");

// THE POINT OF THIS FILE. An architecture nobody is forced to use is worth
// roughly nothing the week after it lands: the next slice adds forty labels,
// none of them has a key, and the catalog becomes a museum. This guard fails
// the build on a user-facing literal anywhere in `app/ui/src` outside the
// catalog.
//
// COMMENTS ARE STRIPPED BEFORE ANYTHING IS PARSED. Three guards in this repo
// have been bitten by finding their target in the comment explaining why the
// target was absent, and every note below about why a string is exempt is
// itself prose full of quoted strings.

/** Strip `//` and block comments, preserving string literals verbatim and
 *  keeping newline count so a reported line number is the real one. */
export function stripComments(src: string): string {
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

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** The 100 characters before the opening quote, comments already gone. */
  readonly before: string;
}

function literalsIn(file: string, src: string): Literal[] {
  const s = stripComments(src);
  const out: Literal[] = [];
  let i = 0;
  let line = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const startLine = line;
      const before = s.slice(Math.max(0, i - 100), i);
      let text = "";
      i++;
      while (i < s.length) {
        if (s[i] === "\\") {
          text += s[i] + (s[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          i++;
          break;
        }
        if (s[i] === "\n") line++;
        text += s[i];
        i++;
      }
      out.push({ file, line: startLine, text, before });
      continue;
    }
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

/** A literal that is not prose at all: an element id, a class, a `data-`
 *  value, an ARIA role, a DOM event name, a CSS declaration, a selector. */
function isTechnical(text: string): boolean {
  if (!/[A-Za-z]/.test(text)) return true;
  // One lower-case token: `treeitem`, `aria-label`, `keydown`, `scene`.
  if (/^[a-z0-9_-]+$/.test(text)) return true;
  // A selector or a CSS declaration block.
  if (/^[#.[]/.test(text)) return true;
  if (/(?:^|;)\s*[a-z-]+\s*:\s*[^;]*(?:px|%|;)/.test(text)) return true;
  return false;
}

/** SVG PATH DATA, which is geometry and not a sentence.
 *
 *  `"M6 12h9a4 4 0 0 1 0 8"` is several space-separated tokens and would
 *  otherwise read as prose. The rule is deliberately narrow: a leading move-to
 *  command, and then NOTHING but the path grammar -- the command letters, digits
 *  and separators. A sentence cannot satisfy it, because the moment a word
 *  appears that is not one of those letters the whole literal is refused. That
 *  narrowness is the point: a pattern-shaped exemption is how a real label slips
 *  through this guard. */
function isPathData(text: string): boolean {
  return /^M[\s\d.,-]/.test(text) && /^[MmZzLlHhVvCcSsQqTtAa0-9,.\s-]+$/.test(text);
}

/** Prose the writer never sees: the argument to a `throw new Error(...)`. */
function isInternalThrow(before: string): boolean {
  return /new (?:Error|TypeError|RangeError)\(\s*$/.test(before);
}

/** A DOM key name being COMPARED, not shown. `event.key === "Escape"` is not
 *  a label; the shortcuts panel's own spelling of the same chord is, and it
 *  went behind `help.keys.*`. */
function isKeyNameComparison(text: string, before: string): boolean {
  const KEYS =
    /^(Escape|Enter|Tab|Backspace|Delete|Home|End|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown)$/;
  if (!KEYS.test(text)) return false;
  return /\bkey\b|\bcode\b|MOVE_KEYS|case\s*$/.test(before);
}

/**
 * Literals that are genuinely not UI text and that no rule above catches.
 *
 * NAMED ONE AT A TIME, deliberately, and kept short. A pattern-shaped
 * exemption is how a real label slips through: the next person adds a
 * sentence next to one of these and the guard stays quiet. If this list grows
 * past about thirty the boundary is in the wrong place and the guard, not the
 * list, is what needs fixing.
 */
const ALLOWED = new Map<string, string>([
  ["(max-width: 900px)", "chrome-toggles.ts: responsive media query, not displayed text"],
  ["application locked", "command-error.ts: legacy host lock rejection recognized during bootstrap, not a displayed label"],
  [
    "${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}",
    "goals.ts: the writer's local date as YYYY-MM-DD, built by hand because that shape is a host contract and not a locale convention",
  ],
  [
    "could not install the close listener: ${String(err)}",
    "lifecycle.ts: a diagnostic for a bridge that is not there; never rendered",
  ],
  [
    "the expectation payload would not describe the whole tree",
    "main.ts: the tail of an invariant throw the measurement harness reads",
  ],
  ["Added scene ${plan.seq}", "main.ts: a synthetic soak workload's item title, not a writer's"],
  [
    "${target.title} (r${n})",
    "measure/mutation-plan.ts: a synthetic soak workload's item title",
  ],
  ["measure: action threw", "measure/recorder.ts: a console.error, not a surface"],
  ["Home", "navigator and workload: a DOM key name in a type union and a key table"],
  ["End", "navigator and workload: a DOM key name in a type union and a key table"],
  [
    "${totalHeight(count, rowHeight, gapIndex)}px",
    "navigator/virtual-list.ts: a CSS length",
  ],
  ["${rowTop(index, rowHeight, gapIndex)}px", "navigator/virtual-list.ts: a CSS length"],
  [
    '${n.parentId ?? "null"}, walk gives ${expectedParent ?? "null"})',
    "navigator/visible.ts: the tail of an invariant throw",
  ],
  ["input, textarea, [role='dialog']", "project.ts: a CSS selector list"],
  [
    'state-choice-${value === "" ? "none" : value}',
    "revision-panel.ts: an element id built from a state name",
  ],
]);

/** Everything left: what a writer could read. */
function isUserFacing(lit: Literal): boolean {
  const text = lit.text;
  if (isTechnical(text)) return false;
  if (isInternalThrow(lit.before)) return false;
  if (isKeyNameComparison(text, lit.before)) return false;
  if (isPathData(text)) return false;
  if (ALLOWED.has(text)) return false;
  const words = text.trim().split(/\s+/);
  if (words.length > 1) return true;
  // A single word is prose only if it looks like one: `Rename`, `Cancel`.
  // `Saving…` and `Measuring…` count too, which is how both were found.
  return /^[A-Z][a-z]+[….]*$/.test(text.trim());
}

const CATALOG = join(SOURCE, "i18n", "en.ts");

/** Every catalog file, and the only files this rule exempts. `de.ts` is
 *  exempt for `en.ts`'s reason and for no other: it is the same strings in
 *  another language, and the vacuity guard below still measures ENGLISH, so
 *  a second catalog cannot be what carries the load. */
const CATALOG_FILES = new Set([CATALOG, join(SOURCE, "i18n", "de.ts")]);

describe("no user-facing literal outside the catalog", () => {
  const files = tsFilesIn(SOURCE);

  test("the parser reaches every source file and finds literals in them", () => {
    // VACUITY GUARD. A parser that silently matches nothing passes everything,
    // which is the recorded shape of three guards in this repo. These two
    // counts are what makes the assertion below mean something.
    expect(files.length).toBeGreaterThan(30);
    const all = files.flatMap((f) => literalsIn(f, readFileSync(f, "utf8")));
    expect(all.length).toBeGreaterThan(1000);
  });

  test("the parser strips comments before it looks", () => {
    // The third instance of the `theme.test.ts` trap in this repo was a guard
    // that found its target in the sentence explaining the target's absence.
    const stripped = stripComments(
      ['const a = "kept";', '// const b = "commented out";', '/* "block" */ const c = 1;'].join(
        "\n",
      ),
    );
    expect(stripped).toContain('"kept"');
    expect(stripped).not.toContain('"commented out"');
    expect(stripped).not.toContain('"block"');
    // And it does not eat the lines, so a reported line number is the real one.
    expect(stripped.split("\n")).toHaveLength(3);
  });

  test("the catalog itself is where the strings live", () => {
    // The one file exempt from the rule, and it must actually be carrying the
    // load: if `en.ts` were empty every other file would pass by having been
    // emptied too.
    const catalog = literalsIn(CATALOG, readFileSync(CATALOG, "utf8")).filter(isUserFacing);
    expect(catalog.length).toBeGreaterThan(200);
    expect(Object.keys(EN).length).toBeGreaterThan(200);
  });

  test("every other file carries keys, not sentences", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (CATALOG_FILES.has(file)) continue;
      for (const lit of literalsIn(file, readFileSync(file, "utf8"))) {
        if (!isUserFacing(lit)) continue;
        offenders.push(`${relative(SOURCE, file)}:${lit.line}  ${JSON.stringify(lit.text)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the path-data exemption takes geometry and refuses prose", () => {
    // THE MUTATION THIS RULE INVITES is a widened pattern that quietly exempts
    // sentences. Both directions are asserted, and the negative half carries a
    // sentence that STARTS like path data -- `M` followed by a space is where a
    // loose rule would let one through.
    expect(isPathData("M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8")).toBe(
      true,
    );
    expect(isPathData("M4 20L20 20")).toBe(true);
    expect(isPathData("M 4 words the writer can read")).toBe(false);
    expect(isPathData("Underline is kept in your book")).toBe(false);
    expect(isPathData("Exported to {path}")).toBe(false);
    // And the guard still refuses a sentence the moment it is asked about one
    // through the real entry point, which is what the rule above plugs into.
    expect(
      isUserFacing({ file: "x.ts", line: 1, text: "Underline", before: "" }),
    ).toBe(true);
  });

  test("the allowlist is short, and every entry is still reachable", () => {
    // Past about thirty the boundary is in the wrong place; and an entry
    // nothing matches any more is an exemption a reader credits for a refusal
    // that is not happening.
    expect(ALLOWED.size).toBeLessThanOrEqual(30);
    const seen = new Set<string>();
    for (const file of files) {
      for (const lit of literalsIn(file, readFileSync(file, "utf8"))) {
        if (ALLOWED.has(lit.text)) seen.add(lit.text);
      }
    }
    expect([...ALLOWED.keys()].filter((k) => !seen.has(k))).toEqual([]);
  });
});
