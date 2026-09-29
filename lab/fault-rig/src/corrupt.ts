// lab/fault-rig/src/corrupt.ts
import { statSync, truncateSync, openSync, readSync, writeSync, closeSync } from "node:fs";

// Torn write: truncate the file to `fraction` of its length (0..1).
export function tornWrite(path: string, fraction: number): void {
  const size = statSync(path).size;
  truncateSync(path, Math.max(0, Math.floor(size * fraction)));
}

// Byte-flip: XOR 0xFF over `count` bytes starting at `offset`.
export function byteFlip(path: string, offset: number, count: number): void {
  const fd = openSync(path, "r+");
  try {
    const size = statSync(path).size;
    const start = Math.min(offset, Math.max(0, size - 1));
    const len = Math.min(count, size - start);
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    for (let i = 0; i < len; i++) buf[i] ^= 0xff;
    writeSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
}
