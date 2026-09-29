import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A rig that calls captureEnv() before its last runShell() records
// renderer: null forever -- runShell is what notes the renderer, and
// captureEnv() only ever reads the registry's current value. Two rigs
// (diag-cli.ts, nav-cli.ts) did this until a later follow-up. A source-parse
// guard because the mistake is invisible in every other test: the field
// typechecks and is present, just always null.
const SRC = join(import.meta.dir, "..", "src");

function offenders(): string[] {
  return readdirSync(SRC).filter((n) => n.endsWith(".ts"));
}

describe("captureEnv() runs after the last runShell() in the same file", () => {
  const files = offenders()
    .filter((n) => {
      const s = readFileSync(join(SRC, n), "utf8");
      return s.includes("captureEnv(") && s.includes("runShell(");
    })
    .sort();

  // Vacuity guard: if this drops near zero, the pattern match broke rather
  // than the codebase having genuinely fewer such rigs.
  test("at least 10 files were checked", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  test.each(files)("%s: last captureEnv( comes after last runShell(", (name) => {
    const s = readFileSync(join(SRC, name), "utf8");
    const lastCaptureEnv = s.lastIndexOf("captureEnv(");
    const lastRunShell = s.lastIndexOf("runShell(");
    expect(lastCaptureEnv).toBeGreaterThan(lastRunShell);
  });
});
