// app/harness/src/shell.ts
// Spawning, sampling and reaping one shell run. Extracted from nav-cli so a
// diagnostic run can drive the SAME code path as a graded one: a probe that
// spawns the host slightly differently answers a question about the probe.
//
// The Xvfb argument list and the reaping rules are the parts that must not
// diverge between callers — both have already cost a run each (see the notes
// on the constants below).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAtspi, unavailable } from "./atspi";
import type { Cycle, Distribution } from "./gates";
import { noteRenderer } from "./env";
import { probeRenderer, type RendererRecord } from "./renderer";
import { descendantsByComm, sumTreeRssKb, treeRssByCommKb } from "./rss";
import type { RssSample } from "./rss-series";

export const BIN = "app/shell-tauri/src-tauri/target/release/app-shell-tauri";

// -s 0 disables the X screensaver. Xvfb defaults to blanking after 600 s, and
// the workload dispatches transactions programmatically without generating X
// input events, so the idle timer never resets. Blanking stops the compositor
// and rAF falls to ~1 Hz. Keep it: `xvfb-run -a --server-args=... xset q` now
// reports `timeout: 0` and no DPMS extension, so X-level power management is
// genuinely out of the picture. It was NOT the cause of the latency collapse
// (which survives the fix, at the same onset), only a real misconfiguration.
//
// 1280x1024 because the shell builds a 900x900 window and xvfb-run defaults to
// 640x480, so the window has never fit the virtual screen.
export const SERVER_ARGS = "-screen 0 1280x1024x24 -s 0 -noreset";

export const XVFB_ARGS = ["xvfb-run", "-a", `--server-args=${SERVER_ARGS}`, BIN];

export function xvfbArgs(serverArgs: string = SERVER_ARGS): string[] {
  return ["xvfb-run", "-a", `--server-args=${serverArgs}`, BIN];
}

// A 30-minute soak of naive mode at the stress fixture overran a 60-second
// grace: page setup builds 15,200 DOM rows before the soak clock starts, and
// that startup cost is not bounded by soakMs. A generous timeout is free on
// success (the sink writes as soon as the page is done, regardless of the
// deadline) and only delays the report when the host has genuinely hung.
export const STARTUP_GRACE_MS = 300_000;

export const SHELL_PROC_NAME = "app-shell-tauri";

// Match the window by WM_CLASS, not by title: the title carries the open
// project's name and changes again on every project switch, so a title match is
// a match against data. The class is fixed by the binary.
//
// The two spellings are one recorded property of this app: native Wayland
// reports the lowercase app_id `app-shell-tauri`, XWayland reports GTK3's
// capitalized WM_CLASS `App-shell-tauri`. Xvfb is plain X11, but hand-cli runs
// on the live session, so both must match. `xdotool search` takes an extended
// regex and has no case-insensitivity flag, hence the character class.
export const SHELL_WINDOW_CLASS_PATTERN = "^[Aa]pp-shell-tauri$";

// --onlyvisible, because GTK creates a second window carrying the same WM_CLASS:
// an unmapped 10x10 group-leader beside the real 900x900 toplevel. The title
// match never saw it (the leader is named after the binary, not the page), so
// the class match needs the mapped-only filter to keep the exactly-one guard
// meaningful. Measured under Xvfb on this app: 2 windows by class, 1 with it.
const WINDOW_SEARCH_ARGS = ["search", "--onlyvisible", "--class", SHELL_WINDOW_CLASS_PATTERN];

/** The one X window of the running shell on `display` (a raw DISPLAY value).
 *  Throws unless exactly one matches — clicks or keystrokes landing in another
 *  window would prove nothing about this one. */
export function findWindowId(display: string): string {
  const proc = Bun.spawnSync(["xdotool", ...WINDOW_SEARCH_ARGS], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
  });
  const ids = proc.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(
      `expected exactly 1 visible window with class matching ${SHELL_WINDOW_CLASS_PATTERN} ` +
        `on ${display}, found ${ids.length}`,
    );
  }
  return ids[0]!;
}

/** Where the run stopped being healthy, to the exact action. Null if it never did. */
export interface OnsetRecord {
  actionIndex: number;
  kind: "type" | "nav";
  charsTyped: number;
  atMs: number;
  dispatchMs: number;
  frameMs: number;
  stalled: boolean;
}

/** Flush-scheduler stats as reported by app/ui/src/store/flush.ts's `stats()`.
 *  Restated here rather than imported: the harness does not depend on the ui
 *  package's internals, same as every other page-shaped type in this file. */
export interface FlushStats {
  count: number;
  entries: number;
  errors: number;
  conflicts: number;
  p50: number;
  p95: number;
}

/** Emitted only in write-mode payloads (persist runs with a flush scheduler).
 *  `flush` is never null here — a write run either has a scheduler and reports
 *  its stats, or has `persist` itself as null (no project, no scheduler). */
export interface WritePersistBlock {
  project: true;
  mode: "write";
  item_id: string | null;
  rev: number;
  seeded_body_hash: string;
  body_hash: string;
  error: string | null;
  flush: FlushStats;
}

/** Emitted only by a verify-mode run (APP_PERSIST_MODE=verify): the page opens
 *  the store, hashes what it finds, and reports without typing or flushing.
 *  `flush` is always null here — verify mode never schedules one. */
export interface VerifyPersistBlock {
  project: true;
  mode: "verify";
  item_id: string | null;
  rev: number;
  body_hash: string;
  error: null;
  flush: null;
}

export interface SinkPayload {
  ready: boolean;
  error?: string;
  /** The first slow frame of the run, blip or not. `onset` is the sustained one. */
  first_slow: OnsetRecord | null;
  mode: string;
  /** Optional so a payload recorded before this field existed still parses. */
  workload_script?: string;
  rows: number;
  startup_ms: number;
  typing_chars_per_cycle: number;
  nav_jumps_per_cycle: number;
  action_delay_ms: number;
  actions: number;
  onset: OnsetRecord | null;
  slow_actions: number;
  typing: Distribution;
  nav: Distribution;
  cycles: Cycle[];
  /** Present only on write runs; null on a run with no flush scheduler.
   *  Optional so a payload recorded before this field existed still parses. */
  persist?: WritePersistBlock | null;
}

/** The entire payload shape a verify-mode run sinks. NOT a `SinkPayload` with
 *  fields missing: it has no typing/nav/cycles/actions at all, because verify
 *  mode types nothing and flushes nothing — it just opens the store and reports
 *  a hash. Modeling it as an optional-everywhere SinkPayload would let a
 *  consumer read `payload.cycles` on a verify run and get `undefined` silently
 *  instead of a type error. */
export interface VerifySinkPayload {
  ready: boolean;
  error?: string;
  candidate: string;
  seed: string;
  mode: string;
  rows: number;
  startup_ms: number;
  persist: VerifyPersistBlock;
}

// Generic over the payload shape: a verify-mode run sinks a VerifySinkPayload,
// which is NOT a SinkPayload with fields missing (see the type above) — it has
// no typing/nav/cycles at all. Defaulting to SinkPayload keeps every existing
// caller's inferred type unchanged; only a caller that names the type param
// (persist-cli, for the verify phase) sees anything different.
export interface RunOutcome<P extends { ready: boolean; error?: string } = SinkPayload> {
  payload: P;
  peakRssMb: number;
  /** Every RSS sample taken, at ~250 ms, since the shell was spawned.
   *  `peakRssMb` is its maximum; the series is what a peak cannot say. */
  rssSeries: RssSample[];
  /** The same samples split by process name (`comm`): the host binary, the
   *  WebKit web process, the network process. `rssSeries` is their sum. */
  rssByProcess: Record<string, RssSample[]>;
  /** The renderer that drew this run's page, or null if the web process was
   *  gone before it could be read. */
  renderer: RendererRecord | null;
  a11y: ReturnType<typeof probeAtspi>;
  /** Session-state transitions during a live-session run. Empty under Xvfb. */
  sessionStates: SessionState[];
  /** The host's stderr, captured for the whole run. Lets a caller confirm
   *  which host-side code paths actually ran (e.g. via eprintln probes)
   *  instead of inferring it from side effects alone. */
  stderr: string;
}

export interface RunOptions {
  mode: "naive" | "virtual";
  soakMs: number;
  staged: string;
  /** Extra host env. Values are interpolated into the page's init script, so
   *  callers pass numbers, not user input. */
  env?: Record<string, string>;
  /** AT-SPI probing costs a synchronous tree walk against the live app every
   *  10 s. A diagnostic that is measuring the app's own frame cadence should
   *  turn it off rather than measure the probe as well. */
  probeA11y?: boolean;
  /** X server arguments. Graded runs use SERVER_ARGS; a diagnostic that varies
   *  them must record what it used, because the display server is part of what
   *  is being measured. */
  serverArgs?: string;
  /** Move the pointer this often, so the display stops looking idle. The
   *  workload dispatches transactions programmatically and generates no X input
   *  at all, which is the one property the rig does not share with a real
   *  writing session. Requires a fixed display number, so it forgoes
   *  `xvfb-run -a`. */
  inputPulseMs?: number;
  /** Run on the caller's live desktop session instead of a private Xvfb, by
   *  spawning the shell directly. Everything measured so far comes from a
   *  headless X server with no compositor, which is the one property the rig
   *  cannot share with a real writing session — and the ~600 s frame collapse
   *  might belong to either. The window is REAL: it appears on the user's
   *  desktop and must stay visible, because compositors stop delivering frame
   *  callbacks to occluded surfaces and that would look exactly like the
   *  pathology under test. */
  session?: boolean;
  /** Runs once the page has sunk its payload and before the shell is killed.
   *  `displayNum` is the X display the shell was started on, or null on a
   *  live-session run, where the caller drives the compositor instead.
   *  `rootPid` is the spawn's own pid, for a rig that needs an AT-SPI probe:
   *  the registrant is a descendant of it, not the pid itself. */
  onReady?: (ctx: { displayNum: number | null; rootPid: number }) => Promise<void>;
}

/** Reject the accessibility bridge setting that makes every AT-SPI probe
 * unavailable. Per-run overrides win over the terminal environment, exactly
 * as they do in the child process launched by runShell. */
export function assertAtspiBridgeEnabled(
  inheritedEnv: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {},
): void {
  const noAtBridge = overrides.NO_AT_BRIDGE ?? inheritedEnv.NO_AT_BRIDGE;
  if (noAtBridge === "1") {
    throw new Error(
      "NO_AT_BRIDGE=1 disables AT-SPI, so the harness cannot probe the application. " +
        "Unset it or pass NO_AT_BRIDGE=0 before launching the harness.",
    );
  }
}

// xvfb-run -a picks a free display and never tells us which, so injecting input
// into that display is impossible. Claiming a number ourselves is the price of
// being able to talk to the server we started.
/** Exported for `first-cli`, which cannot go through `runShell` at all -- its
 *  whole subject is a launch with none of the harness's environment on it -- and
 *  which still needs a display number it can point xdotool at. A fourth copy of
 *  this loop is a fourth chance for direct Xvfb launchers to drift apart. */
export function freeDisplayNumber(): number {
  for (let n = 90; n < 130; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error("no free X display number in 90-129");
}

/** Session conditions that produce the pathology's signature without being it.
 *  A blanked screen, an idle-throttled session, or a window on another
 *  workspace all stop frame callbacks. Unrecorded, they are indistinguishable
 *  from the event under test — which is exactly the position the live-session
 *  runs of 2026-08-02 were left in. */
export interface SessionState {
  atMs: number;
  /** logind's idle hint for the session. */
  idle: boolean | null;
  /** Any monitor powered off (DPMS). */
  dpmsOff: boolean | null;
  /** The shell's window is on the active workspace. */
  visible: boolean | null;
}

function jsonOf(cmd: string[]): unknown | null {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    return JSON.parse(new TextDecoder().decode(proc.stdout));
  } catch {
    return null;
  }
}

export function sampleSessionState(atMs: number): SessionState {
  const sessionId = process.env.XDG_SESSION_ID;
  let idle: boolean | null = null;
  if (sessionId !== undefined) {
    const proc = Bun.spawnSync(["loginctl", "show-session", sessionId, "-p", "IdleHint"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out.startsWith("IdleHint=")) idle = out.endsWith("yes");
  }

  const monitors = jsonOf(["hyprctl", "-j", "monitors"]) as { dpmsStatus?: boolean }[] | null;
  const dpmsOff = monitors === null ? null : monitors.some((m) => m.dpmsStatus === false);

  const clients = jsonOf(["hyprctl", "-j", "clients"]) as
    | { pid?: number; workspace?: { id?: number } }[]
    | null;
  const active = jsonOf(["hyprctl", "-j", "activeworkspace"]) as { id?: number } | null;
  let visible: boolean | null = null;
  if (clients !== null && active !== null) {
    const pids = new Set(survivingShellPids().map(Number));
    const win = clients.find((c) => c.pid !== undefined && pids.has(c.pid));
    visible = win === undefined ? false : win.workspace?.id === active.id;
  }

  return { atMs, idle, dpmsOff, visible };
}

export function survivingShellPids(): string[] {
  const proc = Bun.spawnSync(["pgrep", "-x", SHELL_PROC_NAME], { stdout: "pipe" });
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out.length > 0 ? out.split("\n") : [];
}

interface ProcStat {
  pid: number;
  state: string;
  processGroup: number;
  startTime: string;
}

function procStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) throw new Error(`could not parse /proc/${pid}/stat`);
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    if (fields.length < 20) throw new Error(`could not parse /proc/${pid}/stat`);
    return {
      pid,
      state: fields[0]!,
      processGroup: Number(fields[2]),
      startTime: fields[19]!,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Evidence captured immediately after a detached spawn. Cleanup is scoped to
 * xvfb-run, Xvfb, the host, and descendants that retain this process group. */
export interface OwnedProcess {
  readonly proc: ReturnType<typeof Bun.spawn>;
}

interface OwnedProcessRecord {
  groupId: number;
  rootStartTime: string | null;
  finished: boolean;
}

const ownedProcessRecords = new WeakMap<OwnedProcess, OwnedProcessRecord>();

/** Spawn a run in a new session. Bun documents `detached` as `setsid()` on
 * POSIX, so the child pid is also the process-group id we later signal. */
export async function spawnOwned(
  command: string[],
  options: Parameters<typeof Bun.spawn>[1],
): Promise<OwnedProcess> {
  const proc = Bun.spawn(command, { ...options, detached: true });
  const owned = Object.freeze({ proc });
  try {
    const stat = procStat(proc.pid);
    if (stat !== null && stat.processGroup !== proc.pid) {
      throw new Error(`owned cleanup requires a detached process group rooted at pid ${proc.pid}`);
    }
    // A fast command may already have exited. Do not later rediscover a group
    // after observing that this launch has no remaining members.
    const finished = stat === null && liveGroupMembers(proc.pid).length === 0;
    ownedProcessRecords.set(owned, { groupId: proc.pid, rootStartTime: stat?.startTime ?? null, finished });
    return owned;
  } catch (error) {
    // The detached launch itself authorizes this group even if /proc failed.
    // Await cleanup before returning the failed launch to the caller.
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ESRCH") {
        proc.kill("SIGKILL");
        await waitForRootExit(owned);
        throw new AggregateError([error, cleanupError], "launch validation and group cleanup failed");
      }
    }
    // A failed detached-group check can leave the direct child in another
    // group. Its subprocess handle still belongs to this launch.
    proc.kill("SIGKILL");
    await waitForRootExit(owned);
    if ((await waitForGroupExit(proc.pid)).length > 0) {
      throw new AggregateError([error], "failed launch retained live group members after SIGKILL");
    }
    throw error;
  }
}

function liveGroupMembers(groupId: number): ProcStat[] {
  const members: ProcStat[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid)) continue;
    const stat = procStat(pid);
    // Zombies have no runnable process to reap. Keeping them here would make a
    // successful cleanup look like a leak until their parent happens to wait.
    if (stat !== null && stat.processGroup === groupId && stat.state !== "Z") members.push(stat);
  }
  return members;
}

function assertOwnedGroup(owned: OwnedProcess): OwnedProcessRecord | null {
  const record = ownedProcessRecords.get(owned);
  if (record === undefined || record.groupId <= 0 || record.groupId !== owned.proc.pid) {
    throw new Error("owned cleanup refused an unowned process group");
  }
  if (record.finished) return null;
  const self = procStat(process.pid);
  if (self?.processGroup === record.groupId) {
    throw new Error("owned cleanup refused to signal its own process group");
  }
  const root = procStat(owned.proc.pid);
  if (root !== null && root.processGroup !== record.groupId) {
    throw new Error("owned cleanup refused an unowned process group");
  }
  if (root !== null && root.startTime !== record.rootStartTime) {
    throw new Error(`owned cleanup lost process identity for group ${record.groupId}`);
  }
  // If the root has exited, live members carrying the original PGID are the
  // evidence that the group still belongs to this launch. A new group cannot
  // reuse that PGID until this membership is empty.
  if (root === null && liveGroupMembers(record.groupId).length === 0) {
    record.finished = true;
    return null;
  }
  return record;
}

async function waitForGroupExit(groupId: number): Promise<ProcStat[]> {
  let survivors = liveGroupMembers(groupId);
  for (let i = 0; i < 20 && survivors.length > 0; i++) {
    await Bun.sleep(250);
    survivors = liveGroupMembers(groupId);
  }
  return survivors;
}

async function waitForRootExit(owned: OwnedProcess): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      owned.proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`owned process root ${owned.proc.pid} did not exit after cleanup`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Terminate exactly the detached process group this run created. The root can
 * exit before its descendants, so membership is checked by PGID, not parentage.
 * A PGID cannot be reused while it still has members; if it has none, there is
 * nothing left to signal. */
export async function killShellAndReap(owned: OwnedProcess): Promise<number> {
  const record = assertOwnedGroup(owned);
  if (record === null) {
    await waitForRootExit(owned);
    return 0;
  }
  let survivors = liveGroupMembers(record.groupId);
  if (survivors.length === 0) {
    record.finished = true;
    await waitForRootExit(owned);
    return 0;
  }
  const killedCount = survivors.length;
  try {
    process.kill(-record.groupId, "SIGTERM");
  } catch (error) {
    if (liveGroupMembers(record.groupId).length > 0) throw error;
    record.finished = true;
    await waitForRootExit(owned);
    return killedCount;
  }
  survivors = await waitForGroupExit(record.groupId);
  if (survivors.length > 0) {
    // Revalidate the original leader if it remains. If it has gone, the live
    // members we just observed retain this PGID; a new group cannot take that
    // numeric id until they are gone.
    if (assertOwnedGroup(owned) === null) {
      await waitForRootExit(owned);
      return killedCount;
    }
    try {
      process.kill(-record.groupId, "SIGKILL");
    } catch (error) {
      if (liveGroupMembers(record.groupId).length > 0) throw error;
    }
    survivors = await waitForGroupExit(record.groupId);
    if (survivors.length > 0) {
      throw new Error(`owned process group ${record.groupId} survived SIGKILL: ${survivors.map((p) => p.pid).join(", ")}`);
    }
  }
  record.finished = true;
  await waitForRootExit(owned);
  return killedCount;
}

const STDERR_EOF_GRACE_MS = 1_000;

interface StderrCapture {
  text: Promise<string>;
  cancel(): void;
}

function captureStderr(stream: ReadableStream<Uint8Array>): StderrCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text = (async () => {
    let output = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      output += decoder.decode(value, { stream: true });
    }
  })();
  // Observe an early stream failure while the soak is still running. The
  // cleanup path awaits the same promise and reports that failure later.
  void text.catch(() => {});
  return {
    text,
    cancel() {
      // Do not await cancel: a descendant outside the owned group can retain
      // the descriptor, and cleanup itself must remain bounded.
      void reader.cancel().catch(() => {});
    },
  };
}

async function readStderrBeforeTimeout(capture: StderrCapture): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      capture.text,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`stderr did not reach EOF within ${STDERR_EOF_GRACE_MS} ms after reaping`));
        }, STDERR_EOF_GRACE_MS);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      capture.cancel();
      // The stream may settle after this bounded cleanup path returns. Keep
      // its rejection observed so it cannot become an unhandled rejection.
      void capture.text.catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runShell<P extends { ready: boolean; error?: string } = SinkPayload>(
  opts: RunOptions,
): Promise<RunOutcome<P>> {
  const {
    mode,
    soakMs,
    staged,
    env: extraEnv = {},
    probeA11y = true,
    serverArgs = SERVER_ARGS,
    inputPulseMs = 0,
    session = false,
  } = opts;
  let work: string | undefined;
  let owned: OwnedProcess | undefined;
  let stderrCapture: StderrCapture | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let prober: ReturnType<typeof setInterval> | undefined;
  let pulser: ReturnType<typeof setInterval> | undefined;
  let sessionSampler: ReturnType<typeof setInterval> | undefined;
  let pulses = 0;
  let result: RunOutcome<P> | undefined;
  let renderer: RendererRecord | null = null;
  let failure: unknown;
  let hasFailure = false;
  let noSinkError: Error | undefined;
  let pulseReported = false;
  const cleanupErrors: unknown[] = [];
  const stopSampling = () => {
    if (sampler !== undefined) {
      clearInterval(sampler);
      sampler = undefined;
    }
    if (prober !== undefined) {
      clearInterval(prober);
      prober = undefined;
    }
    if (sessionSampler !== undefined) {
      clearInterval(sessionSampler);
      sessionSampler = undefined;
    }
    if (pulser !== undefined) {
      clearInterval(pulser);
      pulser = undefined;
      if (!pulseReported) {
        pulseReported = true;
        console.log(`  pulsed pointer input ${pulses} time(s)`);
      }
    }
  };

  try {
    // Check the final NO_AT_BRIDGE value before creating a work directory or
    // launching either Xvfb or the shell. The setting is inherited by both Xvfb
    // and live-session runs unless a caller explicitly overrides it.
    assertAtspiBridgeEnabled(process.env, extraEnv);
    if (session && inputPulseMs > 0) {
      throw new Error("inputPulseMs drives a display the harness started; it cannot pulse a live session");
    }
    work = mkdtempSync(join(tmpdir(), `app-nav-${mode}-`));
    const sinkPath = join(work, "sink.json");
    // A measurement run must not read or write the operator's real state, and
    // seven graded rigs did until this line existed. It never mattered while
    // nothing wrote settings.json unasked — and then the window began recording
    // its own size on close, at which point every `outline-cli` run would have
    // silently set the operator's window to the 1000px the rig resizes it to.
    //
    // Here rather than in each CLI, for the same reason APP_RUN is pinned here:
    // seven copies is seven chances for one to forget, and the failure is
    // invisible. A caller that genuinely wants a specific data home still wins,
    // because extraEnv is spread after this.
    const isolatedDataHome = join(work, "data-home");
    mkdirSync(isolatedDataHome, { recursive: true });

    // A hook that drives xdotool needs to know which display to target, so it
    // forces a fixed display number exactly as inputPulseMs does.
    const needsFixedDisplay = inputPulseMs > 0 || opts.onReady !== undefined;
    const displayNum = !session && needsFixedDisplay ? freeDisplayNumber() : undefined;
    const args = session
      ? [BIN]
      : displayNum === undefined
        ? xvfbArgs(serverArgs)
        : ["xvfb-run", "-n", String(displayNum), `--server-args=${serverArgs}`, BIN];
    if (displayNum !== undefined && inputPulseMs > 0) {
      console.log(`  pulsing pointer input on :${displayNum} every ${inputPulseMs} ms`);
    }

    const startedAt = Date.now();
    owned = await spawnOwned(args, {
      env: {
        ...process.env,
        APP_DIST: staged,
        APP_SINK: sinkPath,
        APP_SEED: "app-v1",
        APP_MODE: mode,
        APP_SOAK_MS: String(soakMs),
        // The page defaults to interactive so a bare launch is an application.
        // Every harness run is a measurement; setting it here rather than in four
        // CLIs means no CLI can forget and silently record nothing. extraEnv is
        // spread after, so the hand test can override it.
        APP_RUN: "measure",
        // A 24 ms VACUUM INTO every 15 minutes is nothing to a writer and is a
        // fifth unattributed source of drift in a soak that straddles one. Here
        // rather than in each CLI, for the same reason APP_RUN is: seven copies
        // is seven chances for one to forget, and the failure is invisible.
        // extraEnv is spread after, so a rig that wants to measure the schedule
        // can still turn it on.
        APP_RECOVERY_MODE: "off",
        // THE DISPLAY THE RIG STARTED, not the one the operator is looking at.
        // This machine's session carries WAYLAND_DISPLAY, process.env is spread
        // above, and GTK3 prefers Wayland when both are set -- so until this
        // line existed every rig that did not set GDK_BACKEND itself
        // (persist-cli, nav-cli, hier-cli, smoke-cli, diag-cli) opened its
        // window on the live compositor while xvfb-run kept an X server nobody
        // drew on. Every persist-cli latency figure before 2026-09-02 was
        // rendered by Hyprland. A session run is the one case that WANTS the
        // live display, and extraEnv is spread after, so hand-cli's own
        // override still wins.
        ...(session ? {} : { GDK_BACKEND: "x11" }),
        GTK_A11Y: "atspi",
        // The page formats its figures for the LANGUAGE the settings chose (090:
        // `formatNumber`), so the English page the rigs boot reads "2,011" under
        // any shell locale; before 090 the shell's locale decided, and under
        // de_DE the count read "2.011" and under fr_FR "2 011". words-cli parses
        // those figures out of the exposed accessible name with a [\d,]+ pattern,
        // which stops matching - and the run then degrades to UNKNOWN verdicts,
        // never a false PASS, but produces no evidence at all for a reason nothing
        // in the result would explain. Pinned here rather than in words-cli so
        // every rig's display reads the same way on every operator's machine.
        // The PRODUCT's formatting is deliberately left alone: a writer in Berlin
        // should see 2.011.
        LANG: "C",
        LC_ALL: "C",
        XDG_DATA_HOME: isolatedDataHome,
        ...extraEnv,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const proc = owned.proc;

    // This launch explicitly requests piped stderr; the ownership wrapper also
    // accepts ignored streams for subprocess tests.
    stderrCapture = captureStderr(proc.stderr as ReadableStream<Uint8Array>);

    let peakRssKb = 0;
    const spawnedAt = Date.now();
    const rssSeries: RssSample[] = [];
    const rssByProcess: Record<string, RssSample[]> = {};
    sampler = setInterval(() => {
      // One walk per tick; the summed figure and the split are the same reading,
      // so the gate's peak and the per-process series cannot disagree.
      const byComm = treeRssByCommKb(proc.pid);
      const kb = Object.values(byComm).reduce((a, b) => a + b, 0);
      const atMs = Date.now() - spawnedAt;
      peakRssKb = Math.max(peakRssKb, kb);
      rssSeries.push({ atMs, rssMb: Math.round(kb / 1024) });
      for (const [comm, commKb] of Object.entries(byComm)) {
        (rssByProcess[comm] ??= []).push({ atMs, rssMb: Math.round(commKb / 1024) });
      }
    }, 250);

    // Probe accessibility mid-run, while the window is definitely up.
    let a11y = probeA11y
      ? probeAtspi(proc.pid)
      : unavailable();
    prober = probeA11y
      ? setInterval(() => {
        const p = probeAtspi(proc.pid);
        if (p.available && p.hasNavigator) a11y = p;
      }, 10_000)
      : undefined;

    // Alternating coordinates: xdotool moving the pointer to where it already is
    // generates no motion event, which would make the pulse a no-op that looks
    // like it ran.
    // Gated on inputPulseMs > 0, not just a fixed display: onReady (the hand
    // test) also forces a fixed display, with inputPulseMs left at its default
    // of 0. setInterval(fn, 0) fires as fast as the event loop allows, which
    // spawned thousands of xdotool subprocesses over a few seconds and was
    // observed dropping keystrokes mid-`xdotool type` under the contention.
    pulser =
      displayNum === undefined || inputPulseMs <= 0
        ? undefined
        : setInterval(() => {
          const x = 100 + (pulses % 2) * 50;
          Bun.spawn(["xdotool", "mousemove", String(x), "100"], {
            env: { ...process.env, DISPLAY: `:${displayNum}` },
            stdout: "ignore",
            stderr: "ignore",
          });
          pulses++;
        }, inputPulseMs);

    // Transitions only: a 45-minute run at 10 s sampling is 270 samples, almost
    // all identical, and only the changes carry information.
    const sessionStates: SessionState[] = [];
    sessionSampler = session
      ? setInterval(() => {
        const at = Date.now() - startedAt;
        const s = sampleSessionState(at);
        const prev = sessionStates.at(-1);
        if (
          prev === undefined ||
          prev.idle !== s.idle ||
          prev.dpmsOff !== s.dpmsOff ||
          prev.visible !== s.visible
        ) {
          sessionStates.push(s);
          console.log(
            `  session state at ${(at / 1000).toFixed(0)} s: idle=${s.idle} dpmsOff=${s.dpmsOff} visible=${s.visible}`,
          );
        }
      }, 10_000)
      : undefined;

    const deadline = startedAt + soakMs + STARTUP_GRACE_MS;
    while (!existsSync(sinkPath) && Date.now() < deadline && proc.exitCode === null) {
      await Bun.sleep(250);
    }
    stopSampling();

    if (!existsSync(sinkPath)) {
      // Two distinct failures, two distinct messages. Collapsing them is how a
      // broken shell ran twice unnoticed during discovery.
      const why =
        proc.exitCode !== null
          ? `no sink payload: host exited ${proc.exitCode} before reporting`
          : `no soak payload: host is alive but never reported within ${Date.now() - startedAt} ms`;
      noSinkError = new Error(why);
      throw noSinkError;
    }

    const payload = JSON.parse(readFileSync(sinkPath, "utf8")) as P;

    // The web process is alive and has painted. Read which renderer drew it
    // now, before the kill: this is the variable that separated 703 PASS
    // (Wayland, GPU) from 778 FAIL (Xvfb) on one build, and it was in neither
    // result. Descendants of the spawn, never a global search -- another
    // WebKitGTK application's web process answers a pgrep by name.
    //
    // The registry is only noted once the run is confirmed good, below: noting
    // it here and then throwing on a page-reported failure would leave a
    // renderer record standing for a run whose own result never got written.
    renderer = probeRenderer(descendantsByComm(proc.pid, "WebKitWebProces"));
    console.log(`  renderer: ${renderer?.path ?? "unrecorded"}`);

    // The window is up and the page has reported. This is the only point at which
    // a caller can drive the live shell, so it runs before the kill, not after.
    // onReady's own errors must not skip the kill/reap below — a thrown onReady
    // (e.g. hand-cli's focus-verification guard) would otherwise leak the shell
    // process exactly like the failure modes killShellAndReap already guards
    // against.
    if (opts.onReady !== undefined) {
      if (!session && displayNum === undefined) {
        throw new Error(
          "onReady needs a fixed display number to target with xdotool; it cannot run on " +
          "xvfb-run's automatic display",
        );
      } else {
        await opts.onReady({ displayNum: displayNum ?? null, rootPid: proc.pid });
      }
    }

    if (payload.ready !== true) {
      throw new Error(`page reported failure: ${payload.error ?? JSON.stringify(payload)}`);
    }
    result = {
      payload,
      peakRssMb: Math.round(peakRssKb / 1024),
      rssSeries,
      rssByProcess,
      renderer,
      a11y,
      sessionStates,
      stderr: "",
    };
  } catch (error) {
    hasFailure = true;
    failure = error;
  } finally {
    stopSampling();
    if (owned !== undefined) {
      try {
        const reaped = await killShellAndReap(owned);
        if (reaped > 0) console.log(`note: reaped ${reaped} owned process(es) after the ${mode} phase`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (stderrCapture !== undefined) {
      try {
        const stderr = await readStderrBeforeTimeout(stderrCapture);
        if (result !== undefined) result.stderr = stderr;
        if (failure === noSinkError && noSinkError !== undefined && stderr.length > 0) {
          noSinkError.message += `\n${stderr}`;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (work !== undefined) {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (hasFailure || cleanupErrors.length > 0) {
    noteRenderer(null);
    if (hasFailure && cleanupErrors.length > 0) {
      throw new AggregateError([failure, ...cleanupErrors], "runShell failed and cleanup was incomplete");
    }
    if (hasFailure) throw failure;
    throw new AggregateError(cleanupErrors, "runShell cleanup was incomplete");
  }
  if (result === undefined) throw new Error("runShell completed without an outcome");
  noteRenderer(renderer);
  return result;
}
