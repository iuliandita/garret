// lab/fault-rig/src/backend-nofsync.ts
// NEGATIVE CONTROL, not a candidate encoding. Identical bookkeeping to
// dir-manifest, but it writes the manifest in place with no fsync and no atomic
// rename. It therefore acks writes that may exist only in the page cache.
//
// It must PASS the SIGKILL matrix (the page cache survives a process kill) and
// FAIL the power-loss case. If it ever passes power-loss, the block-layer
// injection is not working and every durability result is meaningless.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "./fsutil";
import { applyPure, emptyState } from "./refmodel";
import type { Backend } from "./backend";
import type { EditOp, PhaseMarker, ProjectState } from "./model";

interface Manifest {
  state: ProjectState;
  objects: Record<string, string>;
}

export function makeNofsyncBackend(projectDir: string): Backend {
  const manifestPath = join(projectDir, "manifest.json");
  let manifest: Manifest = { state: emptyState(), objects: {} };

  function load(): Manifest {
    if (!existsSync(manifestPath)) return { state: emptyState(), objects: {} };
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  }

  return {
    id: "nofsync-control",
    async open() {
      mkdirSync(projectDir, { recursive: true });
      manifest = load();
    },
    async apply(op: EditOp, emit: (m: PhaseMarker) => void) {
      const nextState = applyPure(manifest.state, op);
      const objects = { ...manifest.objects };
      if (op.kind === "type" && op.sceneId) {
        const content = nextState.scenes[op.sceneId] ?? "";
        objects[hashBytes(Buffer.from(content))] = content;
      }
      if (op.kind === "import-asset" && op.assetHash) {
        objects[op.assetHash] = op.assetName ?? "";
      }
      const next: Manifest = { state: nextState, objects };
      emit("begin-txn");
      // The whole control: in-place write, no fsync, no rename. Markers are
      // still emitted so the SIGKILL matrix can drive it unchanged.
      writeFileSync(manifestPath, JSON.stringify(next));
      emit("fsync");
      emit("rename");
      manifest = next;
      emit("commit-done");
    },
    async read(): Promise<ProjectState> {
      return load().state;
    },
    async integrityCheck() {
      if (!existsSync(manifestPath)) return { ok: true, detail: "empty" };
      let m: Manifest;
      try {
        m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      } catch (e) {
        return { ok: false, detail: `manifest parse error: ${String(e)}` };
      }
      for (const [id, text] of Object.entries(m.state.scenes)) {
        if (!(hashBytes(Buffer.from(text)) in m.objects)) {
          return { ok: false, detail: `missing object for scene ${id}` };
        }
      }
      return { ok: true, detail: "ok" };
    },
    async close() {},
  };
}
