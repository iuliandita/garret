// lab/fault-rig/src/matrix.ts
import { runCase, type KillTrigger } from "./supervisor";
import type { BackendId, PhaseMarker } from "./model";
import { collectSalvageEvidence, type SalvageEvidence } from "./salvage";
import type { CaseVerdict } from "./results";

const MARKERS: PhaseMarker[] = ["begin-txn", "fsync", "rename", "commit-done"];

// Build the fault sweep: each phase marker at a few SIGKILL occurrences, random
// delay kills for statistical coverage, plus offline corruption cases that must
// classify CORRUPT (the end-to-end no-silent-corruption assertion).
export interface MatrixCase {
  name: string;
  trigger: KillTrigger;
  mutatorIntervalMs?: number;
}

export function buildTriggers(reps: number): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const marker of MARKERS) {
    for (let occ = 1; occ <= 3; occ++) {
      out.push({ name: `kill@${marker}#${occ}`, trigger: { type: "marker", marker, occurrence: occ } });
    }
  }
  for (let r = 0; r < reps; r++) {
    out.push({ name: `kill@delay-${r}`, trigger: { type: "delay", ms: 1 + r } });
  }
  // A4: the same kills, but with a cloud-sync client churning the project
  // directory throughout. Interference must not change the verdict.
  for (const marker of ["fsync", "rename"] as PhaseMarker[]) {
    out.push({
      name: `mutator+kill@${marker}#1`,
      trigger: { type: "marker", marker, occurrence: 1 },
      mutatorIntervalMs: 2,
    });
  }
  out.push({ name: "corrupt@torn", trigger: { type: "corrupt", mode: "torn" } });
  out.push({ name: "corrupt@flip", trigger: { type: "corrupt", mode: "flip" } });
  return out;
}

export interface MatrixOutcome {
  verdicts: CaseVerdict[];
  salvage: SalvageEvidence[];
}

export async function runMatrixCases(
  backendId: BackendId,
  projectRoot: string,
  seed: string,
  scenes: string[],
  opCount: number,
  cases: MatrixCase[],
): Promise<MatrixOutcome> {
  const verdicts: CaseVerdict[] = [];
  const salvage: SalvageEvidence[] = [];
  for (const { name, trigger, mutatorIntervalMs } of cases) {
    const projectDir = `${projectRoot}/${backendId}-${name.replace(/[@#]/g, "_")}`;
    const res = await runCase({
      backendId, projectDir, seed: `${seed}:${name}`, scenes, opCount, trigger,
      mutatorIntervalMs,
    });
    verdicts.push({ case: name, verdict: res.verdict });
    // Spec: every CORRUPT artifact feeds the read-only salvage prototype, which
    // must extract objects and report losses without modifying the source.
    if (res.verdict === "CORRUPT") {
      salvage.push(collectSalvageEvidence(backendId, projectDir, name));
    }
  }
  return { verdicts, salvage };
}

export async function runMatrix(
  backendId: BackendId,
  projectRoot: string,
  seed: string,
  scenes: string[],
  opCount: number,
  reps: number,
): Promise<MatrixOutcome> {
  return runMatrixCases(
    backendId, projectRoot, seed, scenes, opCount, buildTriggers(reps),
  );
}
