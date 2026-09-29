// lab/bakeoff/harness/src/contention-autosave.ts
// Autosave contention: every second, durably commit a growing snapshot row to a
// temporary SQLite file, matching the spec's one-second durable-write cadence.
// Spawned as a sibling process during a shell run; killed when the run ends.
import { Database } from "bun:sqlite";

const file = process.argv[2] ?? "autosave.sqlite";
const db = new Database(file);
db.run("CREATE TABLE IF NOT EXISTS snap (seq INTEGER, ts INTEGER, blob TEXT)");
const insert = db.prepare("INSERT INTO snap (seq, ts, blob) VALUES (?, ?, ?)");
const blob = "x".repeat(4096);
let seq = 0;
setInterval(() => {
  insert.run(seq++, Date.now(), blob);
}, 1000);
