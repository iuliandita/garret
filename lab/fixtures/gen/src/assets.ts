// lab/fixtures/gen/src/assets.ts
import { mkdirSync, createWriteStream, closeSync, openSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import type { Prng } from "./prng";

const CHUNK = 1 << 16; // 64 KiB

// Streams PRNG noise so 20 GB stress assets never sit in memory.
//
// `sparse` allocates the apparent size without writing blocks. Sound here only
// because the asset bytes are never read: the fault rig hashes seed strings to
// synthesize asset names and never opens the files, and the bake-off
// materializes `scenes.ndjson` alone. The noise exists for file count and
// apparent volume, both of which sparse preserves. Anything that starts reading
// asset CONTENT must stop using sparse, because it would read zeros.
export async function writeAssets(
  rng: Prng,
  dir: string,
  count: number,
  totalBytes: number,
  sparse = false,
): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const per = Math.floor(totalBytes / count);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const size = i === count - 1 ? totalBytes - per * (count - 1) : per;
    const name = `a${i.toString().padStart(4, "0")}.bin`;
    names.push(name);
    if (sparse) {
      const fd = openSync(join(dir, name), "w");
      try { ftruncateSync(fd, size); } finally { closeSync(fd); }
      continue;
    }
    const stream = createWriteStream(join(dir, name));
    // Capture write errors as they fire (e.g. ENOSPC mid-stream on the 20 GB
    // set) so they surface instead of hanging a later `drain` await.
    let streamErr: Error | null = null;
    const errored = new Promise<never>((_, reject) => {
      stream.once("error", (err: Error) => {
        streamErr = err;
        reject(err);
      });
    });
    errored.catch(() => {}); // rejection is consumed via streamErr / race below
    let written = 0;
    while (written < size) {
      if (streamErr) throw streamErr;
      const n = Math.min(CHUNK, size - written);
      const buf = Buffer.allocUnsafe(n);
      let off = 0;
      while (off + 4 <= n) {
        buf.writeUInt32LE((rng.next() * 0x100000000) >>> 0, off);
        off += 4;
      }
      while (off < n) buf[off++] = rng.int(256);
      if (!stream.write(buf)) {
        await Promise.race([
          new Promise<void>((r) => stream.once("drain", r)),
          errored,
        ]);
      }
      written += n;
    }
    await new Promise<void>((resolve, reject) => {
      if (streamErr) return reject(streamErr);
      stream.end(() => resolve());
      stream.once("error", reject);
    });
  }
  return names;
}
