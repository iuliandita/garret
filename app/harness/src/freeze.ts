// app/harness/src/freeze.ts
// Structural enforcement of the lab/ freeze. app/ may read lab's GENERATED
// DATA by path (that is how fixtures cross the boundary) but must never import
// lab SOURCE: every committed result JSON names a rig_commit in this history,
// and code that imports lab makes lab live again, so an edit there changes what
// an old result's seed and rig_commit mean.
import { Glob } from "bun";
import { readFileSync } from "node:fs";

// Matches only module-resolution positions: static import/export ... from "X",
// dynamic import("X"), a CommonJS-style require call, and bare side-effect
// import "X". The static form is restricted to a single line so it can't
// swallow unrelated statements between an import keyword and an unrelated
// string. Run against the BLANKED source (see blankTemplateLiterals) so a
// quoted-string specifier written inside someone else's template literal,
// as this scanner's own test fixtures do, isn't mistaken for a real import.
const QUOTED_IMPORT_FORMS = [
  /^\s*(?:import|export)[^;\n]*?\bfrom\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^\s*import\s+["']([^"']+)["']/gm,
];

// Dynamic import can spell its specifier with backticks instead of quotes
// (that is valid code, not just fixture text), so it needs its own form.
// Run this against source with QUOTED strings blanked (see
// blankQuotedStrings), not template literals, so it still sees real
// backtick-quoted imports while ignoring a fixture that spells one out
// inside an ordinary quoted string. A specifier containing $
// (interpolation) is excluded: it can't be statically resolved anyway, so
// skipping it avoids a false positive on a path that merely interpolates.
const BACKTICK_IMPORT_FORM = /\bimport\s*\(\s*`([^`$]+)`\s*\)/g;

// A specifier reaches lab if any path segment is exactly "lab".
function reachesLab(specifier: string): boolean {
  return specifier.split("/").includes("lab");
}

// Backtick template literals can hold source-shaped text as plain string
// data (this scanner's own tests do exactly that, as fixtures for the
// scanner itself). Blank out their contents before matching QUOTED_IMPORT_FORMS
// so a fixture spelled out inside a template literal isn't mistaken for a
// real quoted-string import.
function blankTemplateLiterals(source: string): string {
  return source.replace(/`(?:\\.|[^`\\])*`/g, (m) => " ".repeat(m.length));
}

// The mirror case: an ordinary single/double-quoted string can hold a
// fixture that spells out a backtick-quoted import as plain text. Blank
// those out before matching BACKTICK_IMPORT_FORM, for the same reason.
function blankQuotedStrings(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => " ".repeat(m.length));
}

function collectHits(rel: string, body: string, form: RegExp): string[] {
  const hits: string[] = [];
  form.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = form.exec(body)) !== null) {
    const spec = m[1];
    if (spec && reachesLab(spec)) hits.push(`${rel}: imports "${spec}"`);
  }
  return hits;
}

export function findLabReferences(root: string): string[] {
  const hits: string[] = [];
  const glob = new Glob("**/*.{ts,tsx,js,mjs}");
  for (const rel of glob.scanSync({ cwd: root })) {
    if (rel.includes("node_modules/")) continue;
    const raw = readFileSync(`${root}/${rel}`, "utf8");
    for (const form of QUOTED_IMPORT_FORMS) {
      hits.push(...collectHits(rel, blankTemplateLiterals(raw), form));
    }
    hits.push(...collectHits(rel, blankQuotedStrings(raw), BACKTICK_IMPORT_FORM));
  }
  return hits.sort();
}
