// lab/fault-rig/src/salvage.ts
import { Database } from "bun:sqlite";
import {
  readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { hashBytes } from "./fsutil";
import { primaryArtifact, isSqliteEncoding } from "./backend";
import type { BackendId } from "./model";

export interface SalvageReport {
  recoveredScenes: Record<string, string>;
  recoveredAssets: Record<string, string>;
  losses: string[];   // human-readable loss descriptions
}

// Read-only. Never writes to the source directory.
export function salvageDir(projectDir: string): SalvageReport {
  const report: SalvageReport = {
    recoveredScenes: {}, recoveredAssets: {}, losses: [],
  };
  const manifestPath = join(projectDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    report.losses.push("no manifest present");
    return report;
  }
  const raw = readFileSync(manifestPath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report.losses.push(`manifest unparseable (${raw.length} bytes, likely torn)`);
    return report;
  }
  const scenes = parsed?.state?.scenes ?? {};
  const objects = parsed?.objects ?? {};
  for (const [id, text] of Object.entries(scenes)) {
    const h = hashBytes(Buffer.from(text as string));
    if (h in objects) report.recoveredScenes[id] = text as string;
    else report.losses.push(`scene ${id}: content object missing`);
  }
  for (const [name, hash] of Object.entries(parsed?.state?.assets ?? {})) {
    if ((hash as string) in objects) report.recoveredAssets[name] = hash as string;
    else report.losses.push(`asset ${name}: object missing`);
  }
  return report;
}

// Read-only by construction: SQLite recovery WRITES (WAL replay, checkpoint,
// hot-journal rollback), so salvage never opens the source. It copies the db
// plus its sidecars into a scratch dir and extracts from the copy, leaving the
// corrupt artifact byte-identical for later forensics.
export function salvageSqlite(projectDir: string): SalvageReport {
  const report: SalvageReport = {
    recoveredScenes: {}, recoveredAssets: {}, losses: [],
  };
  const src = join(projectDir, "project.db");
  if (!existsSync(src)) {
    report.losses.push("no database present");
    return report;
  }
  const work = mkdtempSync(join(tmpdir(), "salvage-"));
  const copy = join(work, "project.db");
  try {
    copyFileSync(src, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, copy + suffix);
    }
    // `new Database` is lazy, so the integrity probe doubles as the open test:
    // a file too damaged to parse throws here rather than at first query.
    let db: Database;
    let check: { integrity_check: string } | null;
    try {
      db = new Database(copy);
      check = db.query("PRAGMA integrity_check").get() as
        { integrity_check: string } | null;
    } catch (e) {
      report.losses.push(`database unopenable: ${String(e)}`);
      return report;
    }
    try {
      if (check?.integrity_check !== "ok") {
        report.losses.push(`integrity_check: ${check?.integrity_check ?? "no result"}`);
      }
      // Each table is extracted independently so damage to one does not lose
      // the other; a partial rescue is still a rescue.
      try {
        const rows = db.query("SELECT id, text FROM scenes").all() as
          { id: string; text: string }[];
        for (const r of rows) report.recoveredScenes[r.id] = r.text;
      } catch (e) {
        report.losses.push(`scenes table unreadable: ${String(e)}`);
      }
      try {
        const rows = db.query("SELECT name, hash FROM assets").all() as
          { name: string; hash: string }[];
        for (const r of rows) report.recoveredAssets[r.name] = r.hash;
      } catch (e) {
        report.losses.push(`assets table unreadable: ${String(e)}`);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return report;
}

export function salvageProject(id: BackendId, projectDir: string): SalvageReport {
  return isSqliteEncoding(id) ? salvageSqlite(projectDir) : salvageDir(projectDir);
}

// Committed evidence, so it carries counts and messages only — never a path.
export interface SalvageEvidence {
  case: string;
  candidate: BackendId;
  recovered_scenes: number;
  recovered_assets: number;
  loss_count: number;
  losses: string[];
  source_unmodified: boolean;   // artifact hash identical before and after
  // Durable files beside the primary artifact at salvage time (basenames only).
  // For SQLite the `-wal` sidecar is a second copy of recent pages, so whether
  // it survived decides how much a rescue can recover.
  sidecars: string[];
}

// Loss strings can quote engine errors carrying filesystem paths; results JSON
// must stay free of them.
function scrub(message: string): string {
  return message.replace(/(\/[\w.\-]+)+/g, "<path>");
}

function artifactHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return hashBytes(readFileSync(path));
}

// Runs the read-only salvage prototype against one artifact and proves, by
// hashing before and after, that the rescue never wrote to the source.
export function collectSalvageEvidence(
  id: BackendId,
  projectDir: string,
  caseName: string,
): SalvageEvidence {
  const artifact = primaryArtifact(id, projectDir);
  const primary = basename(artifact);
  const sidecars = readdirSync(projectDir).filter((f) => f !== primary).sort();
  const before = artifactHash(artifact);
  const report = salvageProject(id, projectDir);
  const after = artifactHash(artifact);
  return {
    sidecars,
    case: caseName,
    candidate: id,
    recovered_scenes: Object.keys(report.recoveredScenes).length,
    recovered_assets: Object.keys(report.recoveredAssets).length,
    loss_count: report.losses.length,
    losses: report.losses.map(scrub),
    source_unmodified: before === after,
  };
}
