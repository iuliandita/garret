// lab/fault-rig/src/supervisor.ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkload } from "./workload";
import { refStates, emptyState } from "./refmodel";
import { classify } from "./verify";
import { tornWrite, byteFlip } from "./corrupt";
import { primaryArtifact, makeBackendFor } from "./backend";
import { startMutator } from "./mutator";
import { childCommand } from "./childcmd";
import type { BackendId, PhaseMarker, ProjectState, Verdict } from "./model";

export type KillTrigger =
  | { type: "none" }
  | { type: "delay"; ms: number }
  | { type: "marker"; marker: PhaseMarker; occurrence: number }
  // Offline corruption after a clean run: injected before recovery. The
  // verdict MUST be CORRUPT — this is the end-to-end "no silent corruption"
  // assertion the SIGKILL sweep alone cannot make.
  | { type: "corrupt"; mode: "torn" | "flip" };

export interface CaseSpec {
  backendId: BackendId;
  projectDir: string;
  seed: string;
  scenes: string[];
  opCount: number;
  trigger: KillTrigger;
  // A4: run a concurrent external mutator (cloud-folder interference) for the
  // duration of the child writer, dropping churn files into the project dir.
  mutatorIntervalMs?: number;
}

export interface CaseResult {
  verdict: Verdict;
  maxAckedSeq: number;
  killed: boolean;
  detail: string;
}

export async function runCase(spec: CaseSpec): Promise<CaseResult> {
  mkdirSync(spec.projectDir, { recursive: true });
  const ops = buildWorkload(spec.seed, spec.scenes, spec.opCount);
  const states = refStates(emptyState(), ops);

  const wlDir = mkdtempSync(join(tmpdir(), "wl-"));
  const wlPath = join(wlDir, "wl.json");
  writeFileSync(wlPath, JSON.stringify(ops));

  const mutator = spec.mutatorIntervalMs !== undefined
    ? startMutator(spec.projectDir, spec.mutatorIntervalMs)
    : null;

  const proc = Bun.spawn(
    childCommand(spec.backendId, spec.projectDir, wlPath),
    { stdout: "pipe" },
  );

  let maxAckedSeq = -1;
  let killed = false;
  let markerHits = 0;

  const killChild = () => {
    if (!killed) { killed = true; proc.kill("SIGKILL"); }
  };
  if (spec.trigger.type === "delay") {
    setTimeout(killChild, spec.trigger.ms);
  }

  // Stream stdout line by line.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith("ACK ")) {
        maxAckedSeq = Math.max(maxAckedSeq, Number(line.split(" ")[1]));
      } else if (line.startsWith("MARK ") && spec.trigger.type === "marker") {
        const marker = line.split(" ")[2] as PhaseMarker;
        if (marker === spec.trigger.marker) {
          markerHits += 1;
          if (markerHits >= spec.trigger.occurrence) {
            killChild();
            break readLoop;
          }
        }
      }
    }
  }
  try { reader.releaseLock(); } catch {}
  await proc.exited;
  await mutator?.stop();

  // Offline corruption injection: mangle the durable artifact after the writer
  // has exited cleanly, so recovery is forced to detect it.
  if (spec.trigger.type === "corrupt") {
    const target = primaryArtifact(spec.backendId, spec.projectDir);
    // torn: truncate deep enough to cut live pages/header (SQLite tolerates
    // losing only trailing free pages, so a shallow tail cut is non-destructive
    // and legitimately still NEW_COMPLETE). flip: corrupt the leading header.
    if (spec.trigger.mode === "torn") tornWrite(target, 0.05);
    else byteFlip(target, 0, 100);
  }

  try {
    const { verdict, detail } = await verifyProject(
      spec.backendId, spec.projectDir, states, maxAckedSeq,
    );
    return { verdict, maxAckedSeq, killed, detail };
  } finally {
    rmSync(wlDir, { recursive: true, force: true });
  }
}

// Reopen a project and classify it against the ref-model ledger. Recovery must
// tolerate a project too corrupt to open or read: any thrown exception is itself
// an undetected-corruption signal, classified CORRUPT. Shared by the SIGKILL
// matrix and the root-gated durability path so both judge by identical rules.
export async function verifyProject(
  backendId: BackendId,
  projectDir: string,
  states: ProjectState[],
  maxAckedSeq: number,
): Promise<{ verdict: Verdict; detail: string }> {
  const backend = makeBackendFor(backendId, projectDir);
  try {
    await backend.open();
    const recovered = await backend.read();
    const integrity = await backend.integrityCheck();
    await backend.close();
    return {
      verdict: classify(recovered, integrity, states, maxAckedSeq),
      detail: integrity.detail,
    };
  } catch (e) {
    try { await backend.close(); } catch {}
    return { verdict: "CORRUPT", detail: `recovery threw: ${String(e)}` };
  }
}
