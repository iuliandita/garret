// lab/fault-rig/src/child.ts
import { readFileSync, writeSync } from "node:fs";
import { makeBackendFor } from "./backend";
import type { BackendId, EditOp, PhaseMarker } from "./model";

// Truly synchronous write to fd 1: the ACK ledger is the basis of REGRESSION
// detection, so a line must reach the pipe before SIGKILL can land. `Bun.write`
// returns an unawaited promise and could drop trailing ACKs; writeSync cannot.
function emit(line: string) {
  writeSync(1, line + "\n");
}

const [, , backendId, projectDir, workloadPath] = process.argv;
if (!backendId || !projectDir || !workloadPath) {
  console.error("usage: bun child.ts <backendId> <projectDir> <workloadJson>");
  process.exit(2);
}

const ops = JSON.parse(readFileSync(workloadPath, "utf8")) as EditOp[];
const backend = makeBackendFor(backendId as BackendId, projectDir);
await backend.open();
for (const op of ops) {
  const onMark = (m: PhaseMarker) => emit(`MARK ${op.seq} ${m}`);
  await backend.apply(op, onMark);
  emit(`ACK ${op.seq} ${Date.now()}`);
}
await backend.close();
emit("DONE");
