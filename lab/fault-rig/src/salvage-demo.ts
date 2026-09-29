// lab/fault-rig/src/salvage-demo.ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkload } from "./workload";
import { primaryArtifact, makeBackendFor } from "./backend";
import { byteFlip } from "./corrupt";
import { collectSalvageEvidence, type SalvageEvidence } from "./salvage";
import type { BackendId } from "./model";

// Damage sites as a fraction of the artifact, from header to tail. The matrix's
// own corruption cases only hit the header; sweeping deeper sites is what turns
// "salvage ran" into "salvage recovered something".
export const DEMO_OFFSETS = [0, 0.25, 0.5, 0.8, 0.95] as const;

const FLIP_BYTES = 64;

export interface SalvageDemoSpec {
  backendId: BackendId;
  seed: string;
  scenes: string[];
  opCount: number;
}

// Builds one project per damage site, flips bytes there, and runs the read-only
// salvage prototype against it. Each site gets a fresh project so the reported
// recovery is attributable to that damage alone.
export async function runSalvageDemo(
  spec: SalvageDemoSpec,
): Promise<SalvageEvidence[]> {
  const evidence: SalvageEvidence[] = [];
  const ops = buildWorkload(spec.seed, spec.scenes, spec.opCount);

  for (const fraction of DEMO_OFFSETS) {
    const dir = mkdtempSync(join(tmpdir(), `salvage-demo-${spec.backendId}-`));
    const backend = makeBackendFor(spec.backendId, dir);
    await backend.open();
    for (const op of ops) await backend.apply(op, () => {});
    await backend.close();

    const artifact = primaryArtifact(spec.backendId, dir);
    const size = statSync(artifact).size;
    const offset = Math.min(
      Math.floor(size * fraction),
      Math.max(0, size - FLIP_BYTES),
    );
    byteFlip(artifact, offset, FLIP_BYTES);

    const pct = Math.round(fraction * 100);
    evidence.push(collectSalvageEvidence(spec.backendId, dir, `demo@flip-${pct}pct`));
  }
  return evidence;
}
