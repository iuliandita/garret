// lab/fault-rig/src/backend-dir.ts
import {
  mkdirSync, readFileSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite, hashBytes } from "./fsutil";
import { applyPure, emptyState } from "./refmodel";
import type { Backend } from "./backend";
import type { EditOp, PhaseMarker, ProjectState } from "./model";

// On-disk manifest is the full serialized ProjectState plus an objects map.
interface Manifest {
  state: ProjectState;
  objects: Record<string, string>; // hash -> literal content (naive inline)
}

export function makeDirBackend(projectDir: string): Backend {
  const manifestPath = join(projectDir, "manifest.json");
  let manifest: Manifest = { state: emptyState(), objects: {} };

  function load(): Manifest {
    if (!existsSync(manifestPath)) return { state: emptyState(), objects: {} };
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  }

  return {
    id: "dir-manifest",
    async open() {
      mkdirSync(projectDir, { recursive: true });
      manifest = load();
    },
    async apply(op: EditOp, emit: (m: PhaseMarker) => void) {
      const nextState = applyPure(manifest.state, op);
      const objects = { ...manifest.objects };
      // Record content objects so integrity can cross-check manifest vs store.
      if (op.kind === "type" && op.sceneId) {
        const content = nextState.scenes[op.sceneId] ?? "";
        objects[hashBytes(Buffer.from(content))] = content;
      }
      if (op.kind === "import-asset" && op.assetHash) {
        objects[op.assetHash] = op.assetName ?? "";
      }
      const next: Manifest = { state: nextState, objects };
      await atomicWrite(manifestPath, Buffer.from(JSON.stringify(next)), emit);
      manifest = next;
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
      // Every referenced scene content hash must exist in the object store.
      for (const [id, text] of Object.entries(m.state.scenes)) {
        const h = hashBytes(Buffer.from(text));
        if (!(h in m.objects)) {
          return { ok: false, detail: `missing object for scene ${id}` };
        }
      }
      return { ok: true, detail: "ok" };
    },
    async close() {},
  };
}
