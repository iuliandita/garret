// lab/fault-rig/src/backend.ts
import { join } from "node:path";
import { makeDirBackend } from "./backend-dir";
import { makeSqliteBackend } from "./backend-sqlite";
import { makeNofsyncBackend } from "./backend-nofsync";
import type { BackendId, EditOp, PhaseMarker, ProjectState } from "./model";

// The single durable artifact corruption is injected into and salvage reads.
export function isSqliteEncoding(id: BackendId): boolean {
  return id === "sqlite" || id === "sqlite-rs";
}

export function primaryArtifact(id: BackendId, projectDir: string): string {
  return isSqliteEncoding(id)
    ? join(projectDir, "project.db")
    : join(projectDir, "manifest.json");
}

export interface Backend {
  readonly id: BackendId;
  open(): Promise<void>;
  // Apply exactly one op as a single durable commit, emitting phase markers.
  apply(op: EditOp, emit: (m: PhaseMarker) => void): Promise<void>;
  // Reopen-safe full read of current durable state (verifier path).
  read(): Promise<ProjectState>;
  // Backend-internal consistency check (WAL replay, manifest vs objects).
  integrityCheck(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

export interface BackendFactory {
  (projectDir: string): Backend;
}

// Single backend factory. Previously duplicated across supervisor, child,
// measure and salvage-demo, which meant a new backend had to be registered in
// four places or silently fall through to dir-manifest.
export function makeBackendFor(id: BackendId, projectDir: string): Backend {
  switch (id) {
    // sqlite-rs differs only in its writer (a Rust child process); every read,
    // integrity check and salvage path is the shared bun:sqlite one.
    case "sqlite":
    case "sqlite-rs": return makeSqliteBackend(projectDir);
    case "nofsync-control": return makeNofsyncBackend(projectDir);
    case "dir-manifest": return makeDirBackend(projectDir);
  }
}
