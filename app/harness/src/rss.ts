// app/harness/src/rss.ts
// Summed resident memory across a process tree, read from /proc. Linux-only,
// which is the whole supported scope. Sums a shell's main + webview + helper
// RSS for the < 750 MB gate. VmRSS in /proc/<pid>/status is KB.
import { readFileSync, readdirSync } from "node:fs";

export function readRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0; // process gone or not readable
  }
}

function childrenOf(pid: number): number[] {
  const kids: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return kids;
  }
  for (const p of pids) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      // comm (field 2) may contain spaces and parens; parse after the last ')'.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(after[1]) === pid) kids.push(Number(p));
    } catch {
      // race: process exited mid-scan, skip
    }
  }
  return kids;
}

function commOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

/** The same tree walk as `sumTreeRssKb`, kept per process NAME (`comm`, the
 *  kernel's 15-character truncation, so WebKit's helpers read
 *  `WebKitWebProces` and `WebKitNetworkPr`). Two processes sharing a name are
 *  summed under it. A process that exits mid-walk contributes 0 under "" and
 *  is dropped. The sum of the values is what `sumTreeRssKb` would have read
 *  at the same instant; the split is what it cannot say: one number across
 *  three processes hid a 100 MB climb in one of them for a week. */
export function treeRssByCommKb(rootPid: number): Record<string, number> {
  const seen = new Set<number>();
  const stack = [rootPid];
  const out: Record<string, number> = {};
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const comm = commOf(pid);
    if (comm !== "") out[comm] = (out[comm] ?? 0) + readRssKb(pid);
    for (const c of childrenOf(pid)) if (!seen.has(c)) stack.push(c);
  }
  return out;
}

/** Every descendant of `rootPid` (root excluded) whose `comm` is `comm`,
 *  sorted ascending by pid -- the walk itself visits siblings in reverse, so
 *  "first found" is not a claim this function can make; the first of the
 *  sorted result is the oldest web process in the usual case. The web
 *  process is `WebKitWebProces` (the kernel's 15-char truncation), never
 *  found by a global pgrep: another WebKitGTK application on the desktop
 *  has one too, and the first probe written for 072 read the wrong
 *  application's renderer that way. */
export function descendantsByComm(rootPid: number, comm: string): number[] {
  const seen = new Set<number>([rootPid]);
  const stack = [...childrenOf(rootPid)];
  const out: number[] = [];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (commOf(pid) === comm) out.push(pid);
    for (const c of childrenOf(pid)) if (!seen.has(c)) stack.push(c);
  }
  return out.sort((a, b) => a - b);
}

/** Every pid in `rootPid`'s process tree, root included, depth-first -- the
 *  same walk as `sumTreeRssKb`, minus the RSS read. A dead root contributes
 *  nothing: `commOf` reads "" for a pid that is not there, and a dead root
 *  cannot have live children either, so the walk's own liveness check is
 *  enough without a separate existence probe. */
export function treePids(rootPid: number): number[] {
  const seen = new Set<number>();
  const stack = [rootPid];
  const out: number[] = [];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (commOf(pid) === "") continue;
    out.push(pid);
    for (const c of childrenOf(pid)) if (!seen.has(c)) stack.push(c);
  }
  return out;
}

export function sumTreeRssKb(rootPid: number): number {
  const seen = new Set<number>();
  const stack = [rootPid];
  let total = 0;
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += readRssKb(pid);
    for (const c of childrenOf(pid)) if (!seen.has(c)) stack.push(c);
  }
  return total;
}
