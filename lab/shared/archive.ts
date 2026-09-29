// lab/shared/archive.ts
// Shared by both tracks' writeResult. Deliberately one implementation: this is
// the guard that stops evidence being destroyed, and two copies of it would
// drift.
//
// `run_id` names a CONFIGURATION (candidate + fixture + variant set), not a run.
// Two runs of one configuration therefore target one filename, and writing in
// place made the second silently replace the first. That is not hypothetical: it
// destroyed the JSON for a 33-minute stress soak, which survives only as an
// already-rendered report (`results/report-bakeoff-stress-soak.md`) because that
// run happened to have been invoked in a way that produced a differently-named
// report. Nothing about the result files themselves recorded that a run had been
// replaced.
//
// The canonical path keeps pointing at the newest run, because the decision
// write-backs cite `results/<run_id>.json` directly and renaming would break
// every reference. The displaced copy moves aside instead.
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const SUPERSEDED_DIR = "superseded";

// Stamped from the displaced file's own mtime, so the archived name says when
// that run was written rather than when it happened to be pushed aside.
// Filesystem-safe: colons and dots out, milliseconds dropped.
export function archiveStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

// Move an existing result aside. Returns the archived path, or null if there was
// nothing there. Callers write the new file afterwards.
export function archiveIfPresent(path: string): string | null {
  if (!existsSync(path)) return null;

  const dir = join(dirname(path), SUPERSEDED_DIR);
  mkdirSync(dir, { recursive: true });

  const ext = extname(path);
  const stem = `${basename(path, ext)}.${archiveStamp(statSync(path).mtime)}`;

  // Two runs displaced within the same second must not collapse into one
  // archive entry — that would be the original bug, one directory down.
  let target = join(dir, `${stem}${ext}`);
  for (let n = 2; existsSync(target); n++) {
    target = join(dir, `${stem}.${n}${ext}`);
  }

  renameSync(path, target);
  return target;
}
