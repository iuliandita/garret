// Verifies the ignored busy-proof test also leaves no WebKit renderer behind.
// Builds its test executable from the current source before launching it.
import { archiveIfPresent } from "./archive";
import { captureEnv, noteRenderer } from "./env";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeRenderer, type RendererRecord } from "./renderer";
import { freeDisplayNumber } from "./shell";

const TEST = "printer::tests::a_busy_proof_times_out_once_without_killing_another_view";
const TIMEOUT_MS = 15_000;
const POLL_MS = 50;
const GRACE_MS = 500;
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface ProcIdentity {
  pid: number;
  startTicks: string;
  comm: string;
}

interface Attempt {
  attempt: number;
  exit: number | null;
  elapsed_ms: number;
  timed_out: boolean;
  test_ran_once: boolean;
  test_passed: boolean;
  watchdog_error: boolean;
  runner_error: boolean;
  tracked_descendants: number;
  surviving_descendants: string[];
  renderer: RendererRecord | null;
  gates: Record<string, boolean>;
}

function usage(message?: string): never {
  if (message) console.error(`printer-lifecycle-cli: ${message}`);
  console.error(
    "usage: APP_GUI=1 bun app/harness/src/printer-lifecycle-cli.ts " +
      "[--count N] [--out path]",
  );
  process.exit(2);
}

function parseArgs(): { count: number; out: string } {
  let count = 3;
  let out = "app/results/126-printer-lifecycle.json";
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === "--count" || arg === "--out") {
      const value = process.argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      if (arg === "--count") {
        count = Number(value);
      } else {
        out = value;
      }
    } else if (arg.startsWith("-")) {
      usage(`unknown option ${arg}`);
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }
  if (!Number.isInteger(count) || count < 1) usage("--count must be a positive integer");
  return {
    count,
    out: isAbsolute(out) ? out : resolve(ROOT, out),
  };
}

function identity(pid: number): ProcIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = after[19];
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return startTicks === undefined || comm === "" ? null : { pid, startTicks, comm };
  } catch {
    return null;
  }
}

function parentMap(): Map<number, number[]> {
  const parents = new Map<number, number[]>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const parent = Number(after[1]);
        const children = parents.get(parent) ?? [];
        children.push(Number(name));
        parents.set(parent, children);
      } catch {
        // A process can exit during the one snapshot.
      }
    }
  } catch {
    // /proc is unavailable or unreadable; the WebKit-observation gate fails.
  }
  return parents;
}

function descendantsOf(rootPid: number, parents: ReadonlyMap<number, readonly number[]>): number[] {
  const seen = new Set<number>([rootPid]);
  const stack = [...(parents.get(rootPid) ?? [])];
  const out: number[] = [];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (identity(pid) === null) continue;
    out.push(pid);
    stack.push(...(parents.get(pid) ?? []));
  }
  return out;
}

async function stopOwned(
  proc: ReturnType<typeof Bun.spawn>,
  id: ProcIdentity | null,
): Promise<void> {
  if (id !== null && isLive(id)) {
    try {
      process.kill(id.pid, "SIGTERM");
    } catch {
      // A process can exit between the identity check and the signal.
    }
  } else if (id === null && proc.exitCode === null) {
    // Bun owns this direct child even when /proc could not identify it.
    proc.kill();
  }
  await Promise.race([proc.exited, Bun.sleep(GRACE_MS)]);
  if (id !== null && isLive(id)) {
    try {
      process.kill(id.pid, "SIGKILL");
    } catch {
      // A process can exit between the identity check and the signal.
    }
  } else if (id === null && proc.exitCode === null) {
    proc.kill("SIGKILL");
  }
  await Promise.race([proc.exited, Bun.sleep(GRACE_MS)]);
}

function isLive(id: ProcIdentity): boolean {
  const current = identity(id.pid);
  if (current === null || current.startTicks !== id.startTicks) return false;
  try {
    const stat = readFileSync(`/proc/${id.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).charAt(0) !== "Z";
  } catch {
    return false;
  }
}

function reap(ids: Iterable<ProcIdentity>, signal: "SIGTERM" | "SIGKILL"): void {
  for (const id of ids) {
    if (!isLive(id)) continue;
    try {
      process.kill(id.pid, signal);
    } catch {
      // A process can exit between the identity check and the signal.
    }
  }
}

function drain(stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) append(decoder.decode(value, { stream: true }));
    }
  })();
}

function gitOutput(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return proc.stdout.toString();
}

function sourceState(): { revision: string; diff_sha256: string } {
  if (gitOutput(["ls-files", "--others", "--exclude-standard", "--", "app/shell-tauri", "app/harness/src"]).trim()) {
    throw new Error("commit new host and harness source files before running the lifecycle checker");
  }
  return {
    revision: gitOutput(["rev-parse", "HEAD"]).trim(),
    diff_sha256: createHash("sha256")
      .update(gitOutput(["diff", "HEAD", "--", "app/shell-tauri", "app/harness/src"]))
      .digest("hex"),
  };
}

async function buildTest(): Promise<string> {
  const proc = Bun.spawn([
    "cargo", "test", "--release", "--locked", "--no-run", "--bin", "app-shell-tauri",
    "--message-format=json",
  ], { cwd: resolve(ROOT, "app/shell-tauri/src-tauri"), stdout: "pipe", stderr: "inherit" });
  const output = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error("could not build the printer test executable");
  const artifacts = output.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((item) => item.reason === "compiler-artifact" && item.profile?.test === true
      && item.target?.name === "app-shell-tauri" && typeof item.executable === "string");
  if (artifacts.length !== 1) throw new Error("Cargo did not identify exactly one printer test executable");
  return artifacts[0].executable;
}

async function runAttempt(executable: string, attempt: number): Promise<Attempt> {
  const display = `:${freeDisplayNumber()}`;
  const xvfb = Bun.spawn(["Xvfb", display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const tracked = new Map<number, ProcIdentity>();
  let renderer: RendererRecord | null = null;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let output = "";
  let timedOut = false;
  let exit: number | null = null;
  let started = 0;
  let exitedAt: number | null = null;
  let observedSurvivors: string[] = [];
  let observedWebkit = false;
  let runnerError = false;
  let streams: Promise<void>[] = [];
  let rootId: ProcIdentity | null = null;
  const xvfbId = identity(xvfb.pid);

  try {
    await Bun.sleep(250);
    if (xvfb.exitCode !== null) throw new Error("the isolated X server failed to start");
    proc = Bun.spawn([executable, TEST, "--ignored", "--exact", "--nocapture", "--test-threads=1"], {
      cwd: ROOT,
      env: { ...process.env, DISPLAY: display, GDK_BACKEND: "x11", WEBKIT_DISABLE_COMPOSITING_MODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    rootId = identity(proc.pid);
    started = performance.now();
    streams = [
      drain(proc.stdout as ReadableStream<Uint8Array>, (text) => { if (output.length < 256_000) output += text; }),
      drain(proc.stderr as ReadableStream<Uint8Array>, (text) => { if (output.length < 256_000) output += text; }),
    ];
    let settled = false;
    void proc.exited.then((code) => {
      exit = code;
      exitedAt = performance.now();
      settled = true;
    });

    while (!settled && performance.now() - started < TIMEOUT_MS) {
      for (const pid of descendantsOf(proc.pid, parentMap())) {
        const id = identity(pid);
        if (id !== null) tracked.set(pid, id);
      }
      const webPids = [...tracked.values()]
        .filter((id) => id.comm === "WebKitWebProces" && isLive(id))
        .map((id) => id.pid);
      observedWebkit ||= webPids.length > 0;
      const seenRenderer = probeRenderer(webPids);
      if (seenRenderer !== null) {
        renderer = seenRenderer;
        noteRenderer(seenRenderer);
      }
      await Bun.sleep(POLL_MS);
    }
    if (!settled) {
      timedOut = true;
      proc.kill();
      reap(tracked.values(), "SIGTERM");
    }
    await Promise.race([proc.exited.then((code) => { exit = code; }), Bun.sleep(GRACE_MS)]);
    await Bun.sleep(GRACE_MS);
    observedSurvivors = [...tracked.values()].filter(isLive).map((id) => id.comm).sort();
  } catch (error) {
    runnerError = true;
    console.error(
      `printer-lifecycle-cli: attempt ${attempt} failed: ` +
        (error instanceof Error ? error.stack ?? error.message : String(error)),
    );
  } finally {
    if (proc !== null && exit === null) await stopOwned(proc, rootId);
    reap(tracked.values(), "SIGTERM");
    await Bun.sleep(150);
    reap(tracked.values(), "SIGKILL");
    await stopOwned(xvfb, xvfbId);
    await Promise.race([Promise.all(streams), Bun.sleep(1000)]);
  }

  // A survivor was recorded before cleanup, then re-checked after its grace;
  // leave that observation in the result while still reaping only our own pids.
  const testRanOnce = (output.match(/running 1 test/g) ?? []).length === 1 && output.includes(`test ${TEST}`);
  const testPassed = /test result: ok\. 1 passed; 0 failed;/.test(output);
  const watchdogError = output.includes("WebProcess didn't exit as expected");
  const gates = {
    runner_completed: !runnerError,
    exit_zero: exit === 0,
    within_15_seconds: !timedOut && exitedAt !== null && exitedAt - started <= TIMEOUT_MS,
    test_ran_once: testRanOnce,
    test_passed: testPassed,
    no_watchdog_error: !watchdogError,
    web_process_observed: observedWebkit,
    no_descendant_survivors: observedSurvivors.length === 0,
  };
  return {
    attempt,
    exit,
    elapsed_ms: exitedAt === null ? TIMEOUT_MS : Math.round(exitedAt - started),
    timed_out: timedOut,
    test_ran_once: testRanOnce,
    test_passed: testPassed,
    watchdog_error: watchdogError,
    tracked_descendants: tracked.size,
    surviving_descendants: observedSurvivors,
    runner_error: runnerError,
    renderer,
    gates,
  };
}

if (process.env.APP_GUI !== "1") {
  console.log("printer-lifecycle-cli: skipped (set APP_GUI=1 to run it)");
  process.exit(0);
}

const { count, out } = parseArgs();
const source = sourceState();
const executable = await buildTest();
if (JSON.stringify(sourceState()) !== JSON.stringify(source)) {
  throw new Error("source changed during the test build; rerun the checker");
}
const executableHash = createHash("sha256").update(readFileSync(executable)).digest("hex");

const attempts: Attempt[] = [];
for (let attempt = 1; attempt <= count; attempt++) {
  const result = await runAttempt(executable, attempt);
  attempts.push(result);
  console.log(JSON.stringify(result));
}
if (JSON.stringify(sourceState()) !== JSON.stringify(source)) {
  throw new Error("source changed during verification; rerun the checker");
}
const passed = attempts.every((attempt) => Object.values(attempt.gates).every(Boolean));
const record = {
  schema: "printer-lifecycle-v1",
  source_revision: source.revision,
  source_diff_sha256: source.diff_sha256,
  built_by_checker: true,
  executable_sha256: executableHash,
  test: TEST,
  repetitions: count,
  timeout_ms: TIMEOUT_MS,
  expected_gates: {
    runner_completed: true,
    exit_zero: true,
    within_15_seconds: true,
    test_ran_once: true,
    test_passed: true,
    no_watchdog_error: true,
    web_process_observed: true,
    no_descendant_survivors: true,
  },
  passed,
  environment: captureEnv(),
  attempts,
};
mkdirSync(dirname(out), { recursive: true });
const displaced = archiveIfPresent(out);
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
if (displaced !== null) console.warn("previous result archived in superseded/");
process.exit(passed ? 0 : 1);
