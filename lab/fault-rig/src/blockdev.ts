// lab/fault-rig/src/blockdev.ts
// Root-gated block-layer fault injection. Everything here operates on a loopback
// image file this rig created; it must never touch a real device.
import { statSync } from "node:fs";

const SECTOR = 512;

export type FlakeyMode = "up" | "drop";

export function sectorsFor(bytes: number): number {
  return Math.floor(bytes / SECTOR);
}

// dm-flakey table: <start> <len> flakey <dev> <offset> <up> <down> [<n> <feat>]
// "up" passes everything through. "drop" is a permanently-down device with
// drop_writes: writes are silently discarded, reads still succeed — the block
// layer's version of losing power with a dirty page cache.
export function flakeyTable(
  device: string, sectors: number, mode: FlakeyMode,
): string {
  return mode === "up"
    ? `0 ${sectors} flakey ${device} 0 1 0`
    : `0 ${sectors} flakey ${device} 0 0 60 1 drop_writes`;
}

// Running as root with mkfs in hand, a wrong path is unrecoverable. Only accept
// an absolute path to a regular file outside /dev.
export function assertSafeImagePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`image path must be absolute: ${path}`);
  }
  if (path === "/dev" || path.startsWith("/dev/")) {
    throw new Error(`refusing to operate on a device path: ${path}`);
  }
  const st = statSync(path);
  if (!st.isFile()) {
    throw new Error(`image path is not a regular file: ${path}`);
  }
}

export function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString().trim();
}

export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}
