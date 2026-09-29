// lab/fault-rig/src/loopback.ts
// Root-gated disk-full harness. Creates a small ext4 loopback image, mounts it,
// and returns the mount path so a project can be generated until the volume
// fills. Requires root (mount) and is opt-in via FAULTRIG_LOOPBACK=1.
// NOT exercised by the test suite; documented for manual runs on the lab host.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Loopback {
  mountPath: string;
  cleanup(): void;
}

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

export function withLoopback(sizeMB: number): Loopback {
  if (process.env.FAULTRIG_LOOPBACK !== "1") {
    throw new Error("loopback disabled; set FAULTRIG_LOOPBACK=1 and run as root");
  }
  const work = mkdtempSync(join(tmpdir(), "loop-"));
  const img = join(work, "disk.img");
  const mnt = join(work, "mnt");
  run(["dd", "if=/dev/zero", `of=${img}`, "bs=1M", `count=${sizeMB}`]);
  run(["mkfs.ext4", "-q", img]);
  run(["mkdir", "-p", mnt]);
  run(["sudo", "mount", "-o", "loop", img, mnt]);
  return {
    mountPath: mnt,
    cleanup() {
      Bun.spawnSync(["sudo", "umount", mnt]);
    },
  };
}
