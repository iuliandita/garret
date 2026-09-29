// app/harness/src/archive.ts
// Never-clobber guard for result files. run_id names a CONFIGURATION, not a
// run, so two runs of one configuration target one filename and writing in
// place silently replaces the first. That destroyed a 33-minute soak's JSON
// during discovery. The canonical path keeps the newest run because write-backs
// cite it directly; the displaced copy moves aside.
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const SUPERSEDED_DIR = "superseded";

// Stamped from the displaced file's own mtime, so the archived name says when
// that run was written, not when it was pushed aside.
export function archiveStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

export function archiveIfPresent(path: string): string | null {
  if (!existsSync(path)) return null;

  const dir = join(dirname(path), SUPERSEDED_DIR);
  mkdirSync(dir, { recursive: true });

  const ext = extname(path);
  const stem = `${basename(path, ext)}.${archiveStamp(statSync(path).mtime)}`;

  let target = join(dir, `${stem}${ext}`);
  for (let n = 2; existsSync(target); n++) {
    target = join(dir, `${stem}.${n}${ext}`);
  }

  renameSync(path, target);
  return target;
}
