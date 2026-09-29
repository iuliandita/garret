// lab/fault-rig/src/fsutil.ts
import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";
import type { PhaseMarker } from "./model";

// write(2) is allowed to write FEWER bytes than requested — notably on a full
// filesystem, where it returns a short count instead of failing. Ignoring the
// return value lets a truncated file be fsynced and atomically renamed into
// place, which is how the dir-manifest backend silently destroyed a project
// under the disk-full case while reporting every commit as durable.
export function writeAll(
  data: Buffer,
  writeChunk: (buf: Buffer, offset: number, length: number) => number,
): void {
  let offset = 0;
  while (offset < data.length) {
    const wrote = writeChunk(data, offset, data.length - offset);
    if (!(wrote > 0)) {
      throw new Error(
        `write made no progress at offset ${offset}/${data.length} ` +
        "(disk full or device error)",
      );
    }
    offset += wrote;
  }
}

export function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Durable atomic replace: write temp, fsync temp, rename, fsync dir.
// `emit` (optional) fires phase markers so the supervisor can SIGKILL between
// the exact durability steps the fault matrix targets.
export async function atomicWrite(
  target: string,
  data: Buffer,
  emit?: (m: PhaseMarker) => void,
): Promise<void> {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.tmp`);
  emit?.("begin-txn");
  const fd = openSync(tmp, "w");
  try {
    writeAll(data, (buf, offset, length) =>
      writeSync(fd, buf, offset, length));
    fsyncSync(fd);
    emit?.("fsync");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  emit?.("rename");
  // fsync the directory so the rename itself is durable.
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
  emit?.("commit-done");
}
