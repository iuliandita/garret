// lab/fault-rig/src/verify.ts
import { hashState } from "./refmodel";
import type { ProjectState, Verdict } from "./model";

// maxAckedSeq is the highest op seq the supervisor saw ACKed before the kill,
// or -1 if none. ref-state index for "after op k" is k+1.
export function classify(
  recovered: ProjectState,
  integrity: { ok: boolean; detail: string },
  refStates: ProjectState[],
  maxAckedSeq: number,
): Verdict {
  if (!integrity.ok) return "CORRUPT";

  const recoveredHash = hashState(recovered);
  // First match is intentional and conservative: duplicate adjacent ref-states
  // (e.g. a `snapshot` no-op) resolve to the LOWEST index, which can only ever
  // yield a false REGRESSION (false alarm), never a false NEW_COMPLETE (false
  // pass). Do NOT switch to findLastIndex — that would open a false-pass hole.
  const matchIndex = refStates.findIndex((s) => hashState(s) === recoveredHash);
  if (matchIndex === -1) return "CORRUPT"; // undetected corruption: unknown state

  const requiredIndex = maxAckedSeq + 1; // ref-state that contains all acked ops

  if (maxAckedSeq === -1) {
    // Nothing durable acknowledged: only the pristine start is acceptable as
    // "old intact"; anything newer is still fine (a commit raced the ack read).
    return matchIndex === 0 ? "OLD_INTACT" : "NEW_COMPLETE";
  }
  if (matchIndex < requiredIndex) return "REGRESSION";
  return "NEW_COMPLETE";
}
