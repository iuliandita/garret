// lab/fault-rig/src/model.ts
// "nofsync-control" is a negative control, never a candidate encoding: it exists
// so the power-loss harness can be shown to detect a missing fsync.
// "sqlite-rs" is the same encoding written through rusqlite instead of
// bun:sqlite: the pre-committed hedge that the SQLite durability result is a
// property of SQLite and the OS rather than of one binding.
export type BackendId =
  | "dir-manifest" | "sqlite" | "sqlite-rs" | "nofsync-control";

// One durable edit. `seq` is a monotonic 0-based index into the workload.
export interface EditOp {
  seq: number;
  kind: "type" | "reorder" | "import-asset" | "snapshot" | "migrate";
  sceneId?: string;        // type, reorder target
  text?: string;           // type: text appended to the scene
  fromOrder?: number;      // reorder: current index
  toOrder?: number;        // reorder: destination index
  assetName?: string;      // import-asset
  assetHash?: string;      // import-asset: content hash (deterministic)
}

// The single correct project state after applying ops 0..seq.
export interface ProjectState {
  scenes: Record<string, string>;   // sceneId -> full concatenated text
  order: string[];                  // scene ids in manuscript order
  assets: Record<string, string>;   // assetName -> content hash
  version: number;                  // schema/migration version
}

// Phase markers a backend emits during one durable commit. The supervisor
// may SIGKILL immediately after seeing any of these.
export type PhaseMarker = "begin-txn" | "fsync" | "rename" | "commit-done";

export type Verdict = "OLD_INTACT" | "NEW_COMPLETE" | "REGRESSION" | "CORRUPT";

// A durability acknowledgement read by the supervisor from child stdout.
export interface DurableAck {
  seq: number;
  ts: number;   // ms epoch when apply() returned
}
