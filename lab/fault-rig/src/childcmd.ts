// lab/fault-rig/src/childcmd.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BackendId } from "./model";

const TS_CHILD = join(import.meta.dir, "child.ts");
export const RUST_CHILD = join(
  import.meta.dir, "..", "rust-child", "target", "release", "fault-rig-rust-child",
);
export const RUST_CHILD_BUILD =
  "cd lab/fault-rig/rust-child && cargo build --release";

// `sqlite-rs` is the Q3 hedge candidate: the same encoding driven by rusqlite
// instead of bun:sqlite. Only the WRITER differs — verification, corruption and
// salvage all go through the same bun:sqlite reader, so a verdict difference can
// only come from the write path.
export function isRustCandidate(id: BackendId): boolean {
  return id === "sqlite-rs";
}

// Single place the child process is resolved, so the durability path cannot
// quietly run the TypeScript writer while the results claim a Rust candidate.
// `runtime` is the absolute interpreter path (sudo resets PATH).
export function childCommand(
  backendId: BackendId,
  projectDir: string,
  workloadPath: string,
  runtime = "bun",
): string[] {
  if (!isRustCandidate(backendId)) {
    return [runtime, TS_CHILD, backendId, projectDir, workloadPath];
  }
  if (!existsSync(RUST_CHILD)) {
    throw new Error(
      `rust child binary missing: ${RUST_CHILD}\nbuild it with: ${RUST_CHILD_BUILD}`,
    );
  }
  // The binary takes no backend id: it implements exactly one encoding.
  return [RUST_CHILD, projectDir, workloadPath];
}
