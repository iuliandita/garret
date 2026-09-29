// lab/fault-rig/src/durability.ts
// The two fault classes SIGKILL cannot reach: power loss (writes that were never
// fsynced are lost at the block layer) and a genuinely full volume. Root only.
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { buildWorkload } from "./workload";
import { refStates, emptyState, applyPure } from "./refmodel";
import { verifyProject } from "./supervisor";
import { makeBackendFor } from "./backend";
import {
  flakeyTable, sectorsFor, assertSafeImagePath, run, isRoot,
} from "./blockdev";
import { childCommand } from "./childcmd";
import type { BackendId, EditOp, Verdict } from "./model";

// sudo resets PATH, so the child runtime is resolved absolutely rather than
// trusting a bare "bun" to be findable as root.
const RUNTIME = process.execPath;

// Payload appended to each typing op in the disk-full case. Large enough that
// every encoding must allocate new blocks, so neither can coast on in-place
// updates while the volume fills.
const DISK_FULL_OP_BYTES = 256 * 1024;

export interface DurabilityCase {
  case: string;
  verdict: Verdict;
  acked_ops: number;      // ops the writer acknowledged as durable
  detail: string;
  // disk-full only. `hit_enospc` means the VOLUME actually filled, measured by
  // free space, not by whether the writer noticed. A backend that ignores a
  // short write reports no error precisely when it is failing worst, so the
  // writer's own error output cannot be the signal.
  hit_enospc?: boolean;
  free_before_kb?: number;
  free_after_kb?: number;
  writer_error?: string;
}

// Preloaded scene text as untimed ops, applied before the measured workload.
export function preloadOpsFor(preload: Record<string, string>): EditOp[] {
  return Object.entries(preload).map(([sceneId, text], i) => ({
    seq: -1 - i, kind: "type" as const, sceneId, text,
  }));
}

export function freeSpaceKB(mountPath: string): number {
  const out = Bun.spawnSync(["df", "-k", "--output=avail", mountPath])
    .stdout.toString().trim().split("\n");
  return Number(out.at(-1) ?? 0);
}

export interface DurabilitySpec {
  backendId: BackendId;
  workDir: string;        // on a real disk-backed filesystem, never tmpfs
  seed: string;
  scenes: string[];
  opCount: number;
  imageMB: number;
  // Disk-full uses a deliberately small volume so the workload exhausts it.
  diskFullImageMB?: number;
  // Manuscript applied before the measured workload, so commits have real mass.
  preload?: Record<string, string>;
}

interface Volume {
  mountPath: string;
  dmName: string;
  dmPath: string;
  loopDev: string;
  sectors: number;
  cleanup(): void;
}

// Build a loopback-backed ext4 volume sitting behind a dm-flakey device, so the
// device can later be flipped into drop_writes underneath a live filesystem.
function createVolume(workDir: string, tag: string, imageMB: number): Volume {
  const img = join(workDir, `${tag}.img`);
  const mnt = join(workDir, `${tag}-mnt`);
  const dmName = `faultrig-${tag}`;

  writeFileSync(img, "");
  run(["truncate", "-s", `${imageMB}M`, img]);
  assertSafeImagePath(img);

  const loopDev = run(["losetup", "--find", "--show", img]);
  const sectors = sectorsFor(imageMB * 1024 * 1024);
  let created = false;
  let mounted = false;
  try {
    run(["dmsetup", "create", dmName, "--table", flakeyTable(loopDev, sectors, "up")]);
    created = true;
    const dmPath = `/dev/mapper/${dmName}`;
    // -m 0: no reserved-for-root blocks. Everything here runs as root, so a 5%
    // reserve lets the writer keep going after df reports zero available.
    run(["mkfs.ext4", "-q", "-F", "-m", "0", dmPath]);
    mkdirSync(mnt, { recursive: true });
    run(["mount", dmPath, mnt]);
    mounted = true;
    return {
      mountPath: mnt, dmName, dmPath, loopDev, sectors,
      cleanup() {
        // Ordered teardown; each step tolerated failing so one stuck resource
        // never strands the loop device or the mapping.
        Bun.spawnSync(["umount", "-f", mnt]);
        Bun.spawnSync(["dmsetup", "remove", "--force", dmName]);
        Bun.spawnSync(["losetup", "-d", loopDev]);
        rmSync(img, { force: true });
      },
    };
  } catch (e) {
    if (mounted) Bun.spawnSync(["umount", "-f", mnt]);
    if (created) Bun.spawnSync(["dmsetup", "remove", "--force", dmName]);
    Bun.spawnSync(["losetup", "-d", loopDev]);
    throw e;
  }
}

// Run the child writer until `stopAfterAcks` durable acks, then cut the device.
async function writeUntilAcks(
  backendId: BackendId,
  projectDir: string,
  workloadPath: string,
  stopAfterAcks: number,
  onStop: () => void,
): Promise<number> {
  const proc = Bun.spawn(childCommand(backendId, projectDir, workloadPath, RUNTIME),
    { stdout: "pipe", stderr: "pipe" });
  let maxAckedSeq = -1;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  loop: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.startsWith("ACK ")) continue;
      maxAckedSeq = Math.max(maxAckedSeq, Number(line.split(" ")[1]));
      if (maxAckedSeq + 1 >= stopAfterAcks) {
        onStop();               // cut power first, then stop the writer
        proc.kill("SIGKILL");
        break loop;
      }
    }
  }
  try { reader.releaseLock(); } catch {}
  await proc.exited;
  return maxAckedSeq;
}

// POWER LOSS. The device is flipped to drop_writes while the filesystem is live,
// so every block still sitting in the page cache is discarded. Anything the
// writer acked but never fsynced is gone. A backend that skips fsync passes the
// SIGKILL matrix and fails here — that is the entire point of this case.
export async function runPowerLossCase(
  spec: DurabilitySpec,
): Promise<DurabilityCase> {
  const ops = buildWorkload(spec.seed, spec.scenes, spec.opCount);
  const states = refStates(emptyState(), ops);
  const wlDir = mkdtempSync(join(spec.workDir, "wl-"));
  const wlPath = join(wlDir, "wl.json");
  writeFileSync(wlPath, JSON.stringify(ops));

  const vol = createVolume(spec.workDir, `power-${spec.backendId}`, spec.imageMB);
  try {
    const projectDir = join(vol.mountPath, "project");
    mkdirSync(projectDir, { recursive: true });

    const stopAfter = Math.max(1, Math.floor(spec.opCount / 2));
    const maxAckedSeq = await writeUntilAcks(
      spec.backendId, projectDir, wlPath, stopAfter,
      () => {
        run(["dmsetup", "suspend", "--noflush", "--nolockfs", vol.dmName]);
        run(["dmsetup", "reload", vol.dmName,
          "--table", flakeyTable(vol.loopDev, vol.sectors, "drop")]);
        run(["dmsetup", "resume", vol.dmName]);
      },
    );

    // Drop everything cached and bring the volume back with writes flowing
    // again, so what remains is only what actually reached the platter.
    Bun.spawnSync(["umount", "-f", vol.mountPath]);
    run(["dmsetup", "suspend", "--noflush", "--nolockfs", vol.dmName]);
    run(["dmsetup", "reload", vol.dmName,
      "--table", flakeyTable(vol.loopDev, vol.sectors, "up")]);
    run(["dmsetup", "resume", vol.dmName]);
    run(["mount", vol.dmPath, vol.mountPath]);

    const projectAfter = join(vol.mountPath, "project");
    const { verdict, detail } = await verifyProject(
      spec.backendId, projectAfter, states, maxAckedSeq,
    );
    return {
      case: "power-loss@drop-writes",
      verdict,
      acked_ops: maxAckedSeq + 1,
      detail,
    };
  } finally {
    vol.cleanup();
    rmSync(wlDir, { recursive: true, force: true });
  }
}

// DISK FULL. Losing later ops is fine; losing an acked one, or corrupting the
// project, is not.
//
// Free-space ballast cannot make both encodings meet ENOSPC: after a preload,
// sqlite updates rows in place inside already-allocated pages while
// dir-manifest must rewrite the entire manifest, so any single sliver either
// starves one at op 0 or never troubles the other. Instead the volume is sized
// so the WORKLOAD exhausts it — each typing op carries a large payload, which
// forces both encodings to allocate.
export async function runDiskFullCase(
  spec: DurabilitySpec,
): Promise<DurabilityCase> {
  const ops = buildWorkload(spec.seed, spec.scenes, spec.opCount).map((op) =>
    op.kind === "type"
      ? { ...op, text: `${op.text ?? ""}${"x".repeat(DISK_FULL_OP_BYTES)}` }
      : op,
  );
  const wlDir = mkdtempSync(join(spec.workDir, "wl-"));
  const wlPath = join(wlDir, "wl.json");
  writeFileSync(wlPath, JSON.stringify(ops));

  const vol = createVolume(
    spec.workDir, `full-${spec.backendId}`, spec.diskFullImageMB ?? spec.imageMB,
  );
  try {
    const projectDir = join(vol.mountPath, "project");
    mkdirSync(projectDir, { recursive: true });

    // Preload a real manuscript first. Against an empty project the commits are
    // kilobytes and simply never reach ENOSPC, which is exactly how the first
    // version of this case passed without testing anything.
    const preloadOps = preloadOpsFor(spec.preload ?? {});
    let start = emptyState();
    if (preloadOps.length) {
      const pre = makeBackendFor(spec.backendId, projectDir);
      await pre.open();
      for (const op of preloadOps) {
        await pre.apply(op, () => {});
        start = applyPure(start, op);
      }
      await pre.close();
    }
    const states = refStates(start, ops);

    Bun.spawnSync(["sync"]);
    const freeKB = freeSpaceKB(vol.mountPath);

    const proc = Bun.spawn(childCommand(spec.backendId, projectDir, wlPath, RUNTIME),
      { stdout: "pipe", stderr: "pipe" });
    let maxAckedSeq = -1;
    const out = await new Response(proc.stdout).text();
    for (const line of out.split("\n")) {
      if (line.startsWith("ACK ")) {
        maxAckedSeq = Math.max(maxAckedSeq, Number(line.split(" ")[1]));
      }
    }
    const stderr = (await new Response(proc.stderr).text()).trim();
    await proc.exited;
    // SQLite surfaces this as SQLITE_FULL / "database or disk is full", not as
    // the POSIX spelling, so match both rather than one engine's wording.
    const errLine = stderr.split("\n")
      .find((l) => /ENOSPC|no space left|disk is full|SQLITE_FULL/i.test(l))
      ?.trim() ?? "";
    const freeAfterKB = freeSpaceKB(vol.mountPath);
    // The disk genuinely filled if there is essentially nothing left.
    const hitEnospc = freeAfterKB <= 64 || errLine !== "";

    const { verdict, detail } = await verifyProject(
      spec.backendId, projectDir, states, maxAckedSeq,
    );
    return {
      case: "disk-full@enospc",
      verdict,
      acked_ops: maxAckedSeq + 1,
      // Without an actual ENOSPC this case asserts nothing, so whether the
      // writer hit one is recorded as part of the result, not assumed.
      hit_enospc: hitEnospc,
      free_before_kb: freeKB,
      free_after_kb: freeAfterKB,
      writer_error: errLine.slice(0, 160),
      detail: `free ${freeKB}->${freeAfterKB}KB; ` +
        `${maxAckedSeq + 1}/${ops.length} ops acked; writer exit ` +
        `${proc.exitCode}; ${detail}` +
        (errLine ? `; ${errLine.slice(0, 120)}` : "; writer reported no error"),
    };
  } finally {
    vol.cleanup();
    rmSync(wlDir, { recursive: true, force: true });
  }
}

export function requireRoot(): void {
  if (!isRoot()) {
    throw new Error(
      "durability cases need root (loop device, device-mapper, mount)",
    );
  }
}
