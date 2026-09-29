import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { captureEnv, noteRenderer } from "../src/env";
import {
  assertAtspiBridgeEnabled,
  killShellAndReap,
  runShell,
  spawnOwned,
  type OwnedProcess,
} from "../src/shell";

describe("assertAtspiBridgeEnabled", () => {
  test("rejects NO_AT_BRIDGE=1 with an actionable named error", () => {
    expect(() => assertAtspiBridgeEnabled({ NO_AT_BRIDGE: "1" })).toThrow(
      "NO_AT_BRIDGE=1 disables AT-SPI",
    );
  });

  test("allows an absent or zero bridge setting, including a per-run override", () => {
    expect(() => assertAtspiBridgeEnabled({})).not.toThrow();
    expect(() => assertAtspiBridgeEnabled({ NO_AT_BRIDGE: "0" })).not.toThrow();
    expect(() => assertAtspiBridgeEnabled({ NO_AT_BRIDGE: "1" }, { NO_AT_BRIDGE: "0" })).not.toThrow();
  });

  test("rejects a per-run bridge disablement over a valid inherited environment", () => {
    expect(() => assertAtspiBridgeEnabled({ NO_AT_BRIDGE: "0" }, { NO_AT_BRIDGE: "1" })).toThrow(
      "NO_AT_BRIDGE=1 disables AT-SPI",
    );
  });

  for (const session of [false, true]) {
    test(`runShell rejects the disabled bridge before ${session ? "a session" : "an Xvfb"} launch`, async () => {
      await expect(
        runShell({
          mode: "naive",
          soakMs: 0,
          staged: "unused",
          env: { NO_AT_BRIDGE: "1" },
          session,
        }),
      ).rejects.toThrow("NO_AT_BRIDGE=1 disables AT-SPI");
    });
  }
});

describe("direct GUI launchers", () => {
  const sourceDir = join(import.meta.dir, "..", "src");
  const launchers = ["first-cli.ts", "mirror-cli.ts", "mirror-acts-cli.ts"];

  test.each(launchers)("%s rejects NO_AT_BRIDGE before its first host action", (file) => {
    const source = readFileSync(join(sourceDir, file), "utf8");
    const guard = source.indexOf("assertAtspiBridgeEnabled(process.env)");
      const launch = source.search(/(?:Bun\.spawn(?:Sync)?|spawnOwned)\(\s*\[BIN\]/);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(launch).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(launch);
  });
});

function alive(pid: number): boolean {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    return raw.slice(raw.lastIndexOf(")") + 2).startsWith("Z") === false;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("synthetic subprocess did not become ready");
    await Bun.sleep(10);
  }
}

async function forceCleanup(owned: OwnedProcess): Promise<void> {
  try {
    process.kill(-owned.proc.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await owned.proc.exited;
}

function syntheticXvfb(dir: string): string {
  const bin = join(dir, "bin");
  const wrapper = join(bin, "xvfb-run");
  mkdirSync(bin);
  writeFileSync(wrapper, `#!/bin/sh
printf '%s' "$$" > "$TEST_ROOT"
printf '%s' "$(dirname "$APP_SINK")" > "$TEST_WORK"
case "$RUN_SHELL_SCENARIO" in
  malformed)
    printf '{' > "$APP_SINK"
    while :; do sleep 1; done
    ;;
  stdout)
    if [ -n "$TEST_STDOUT_TARGET" ]; then
      readlink "/proc/$$/fd/1" > "$TEST_STDOUT_TARGET"
    fi
    head -c 1048576 /dev/zero
    printf '%s' 'synthetic stderr' >&2
    printf '%s' '{"ready":true}' > "$APP_SINK"
    ;;
  hook)
    sleep 0.55
    printf '%s' 'synthetic stderr' >&2
    printf '%s' '{"ready":true}' > "$APP_SINK"
    while :; do sleep 1; done
    ;;
  holder)
    python3 -c 'import os, sys, time; os.setsid(); open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(60)' "$TEST_HOLDER" &
    while [ ! -s "$TEST_HOLDER" ]; do sleep 0.01; done
    printf '{' > "$APP_SINK"
    while :; do sleep 1; done
    ;;
  page-failure)
    printf '%s' '{"ready":false,"error":"synthetic page failure"}' > "$APP_SINK"
    while :; do sleep 1; done
    ;;
  no-sink-stderr)
    printf '%s' 'synthetic stderr' >&2
    exit 7
    ;;
esac
`);
  chmodSync(wrapper, 0o755);
  return bin;
}

async function reapSyntheticGroup(rootFile: string): Promise<void> {
  if (!existsSync(rootFile)) return;
  const pid = Number(readFileSync(rootFile, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitFor(() => !alive(pid));
}

async function cleanupSynthetic(dir: string): Promise<void> {
  await reapSyntheticGroup(join(dir, "root.pid"));
  const workFile = join(dir, "work");
  if (existsSync(workFile)) {
    const work = readFileSync(workFile, "utf8");
    if (dirname(work) !== tmpdir() || !basename(work).startsWith("app-nav-")) {
      throw new Error("synthetic cleanup refused an unexpected work directory");
    }
    rmSync(work, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

async function runWithSyntheticWatchdog<T>(rootFile: string, run: () => Promise<T>): Promise<T> {
  const running = run();
  const settled = running.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    settled,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 4_000); }),
  ]).finally(() => clearTimeout(timer));
  if (first === null) {
    await reapSyntheticGroup(rootFile);
    await settled;
    throw new Error("synthetic run watchdog expired");
  }
  if (!first.ok) throw first.error;
  return first.value;
}

async function expectSyntheticFailure<T>(rootFile: string, run: () => Promise<T>): Promise<unknown> {
  try {
    await runWithSyntheticWatchdog(rootFile, run);
  } catch (error) {
    return error;
  }
  throw new Error("expected runShell to reject");
}

function pausedPython(pidFile: string, ignoreTerm = false): string[] {
  const code = [
    "import os, signal, sys",
    ignoreTerm ? "signal.signal(signal.SIGTERM, signal.SIG_IGN)" : "",
    "open(sys.argv[1] + '.tmp', 'w').write(str(os.getpid()))",
    "os.replace(sys.argv[1] + '.tmp', sys.argv[1])",
    "signal.pause()",
  ].filter(Boolean).join("; ");
  return ["python3", "-c", code, pidFile];
}

describe("owned process-group cleanup", () => {
  test("accepts a short-lived command and never rediscovers its finished group", async () => {
    for (let i = 0; i < 20; i++) {
      const owned = await spawnOwned(["true"], { stdout: "ignore", stderr: "ignore" });
      await owned.proc.exited;
      expect(await killShellAndReap(owned)).toBe(0);
      expect(await killShellAndReap(owned)).toBe(0);
    }
  });

  test("sends TERM so a cooperative process can finish its shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-term-"));
    const ready = join(dir, "ready");
    const stopped = join(dir, "stopped");
    const owned = await spawnOwned(["python3", "-c", `
import signal, sys
from pathlib import Path
def stop(*args):
    Path(sys.argv[2]).write_text('stopped')
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path(sys.argv[1]).write_text('ready')
signal.pause()
`, ready, stopped], { stdout: "ignore", stderr: "ignore" });
    try {
      await waitFor(() => existsSync(ready));
      await killShellAndReap(owned);
      expect(existsSync(stopped)).toBeTrue();
    } finally {
      await forceCleanup(owned);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("removes descendants after the wrapper exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-reap-"));
    const pidFile = join(dir, "child.pid");
    try {
      const childArgs = pausedPython(pidFile);
      const owned = await spawnOwned(["sh", "-c", "\"$@\" & exit 0", "sh", ...childArgs], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await waitFor(() => existsSync(pidFile));
        const child = Number(readFileSync(pidFile, "utf8").trim());
        expect(child).toBeGreaterThan(0);
        await waitFor(() => alive(child));
        await killShellAndReap(owned);
        expect(alive(child)).toBeFalse();
      } finally {
        await forceCleanup(owned);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escalates to SIGKILL for a TERM-ignoring descendant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-reap-"));
    const pidFile = join(dir, "term-ignoring.pid");
    const childArgs = pausedPython(pidFile, true);
    const owned = await spawnOwned(["sh", "-c", "\"$@\" & wait", "sh", ...childArgs], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitFor(() => existsSync(pidFile));
      const child = Number(readFileSync(pidFile, "utf8").trim());
      await waitFor(() => alive(child));
      const started = Date.now();
      await killShellAndReap(owned);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(7_500);
      expect(alive(child)).toBeFalse();
    } finally {
      await forceCleanup(owned);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("leaves an unrelated process started later alone", async () => {
    const owned = await spawnOwned(["python3", "-c", "import signal; signal.pause()"], { stdout: "ignore", stderr: "ignore" });
    const unrelated = Bun.spawn(["python3", "-c", "import signal; signal.pause()"], { stdout: "ignore", stderr: "ignore" });
    try {
      await waitFor(() => alive(unrelated.pid));
      await killShellAndReap(owned);
      expect(alive(unrelated.pid)).toBeTrue();
    } finally {
      await forceCleanup(owned);
      if (alive(unrelated.pid)) unrelated.kill("SIGKILL");
      await unrelated.exited;
    }
  });

  test("refuses a forged handle for a non-detached child without signalling its group", async () => {
    const proc = Bun.spawn(["python3", "-c", "import signal; signal.pause()"], { stdout: "ignore", stderr: "ignore" });
    const forged = { proc } as OwnedProcess;
    try {
      await expect(killShellAndReap(forged)).rejects.toThrow("unowned process group");
      expect(alive(proc.pid)).toBeTrue();
    } finally {
      if (alive(proc.pid)) proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});

describe("runShell failure cleanup", () => {
  function syntheticRun(dir: string, scenario: string, extra: Record<string, string> = {}) {
    const bin = syntheticXvfb(dir);
    const root = join(dir, "root.pid");
    const work = join(dir, "work");
    return {
      bin,
      root,
      work,
      run: () => runShell({
        mode: "naive",
        soakMs: 0,
        staged: "unused",
        probeA11y: false,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          NO_AT_BRIDGE: "0",
          RUN_SHELL_SCENARIO: scenario,
          TEST_ROOT: root,
          TEST_WORK: work,
          TEST_STDOUT_TARGET: join(dir, "stdout-target"),
          ...extra,
        },
      }),
    };
  }

  test("reaps a malformed-sink wrapper and removes its work directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-malformed-"));
    const previousRenderer = captureEnv().renderer;
    noteRenderer({ path: "dmabuf-gpu", dmabufDisabledByEnv: false, glesMapped: true,
      llvmpipe: false, gdkBackend: "x11", webProcesses: 1 });
    try {
      const synthetic = syntheticRun(dir, "malformed");
      const error = await expectSyntheticFailure(synthetic.root, synthetic.run);
      expect(String(error)).toContain("JSON");
      const root = Number(readFileSync(synthetic.root, "utf8"));
      const work = readFileSync(synthetic.work, "utf8");
      expect(alive(root)).toBeFalse();
      expect(existsSync(work)).toBeFalse();
      expect(captureEnv().renderer).toBeNull();
    } finally {
      noteRenderer(previousRenderer);
      await cleanupSynthetic(dir);
    }
  });

  test("discards unused stdout so a pipe-sized synthetic payload can report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-stdout-"));
    try {
      const synthetic = syntheticRun(dir, "stdout");
      const outcome = await runWithSyntheticWatchdog(synthetic.root, synthetic.run);
      expect(outcome.payload.ready).toBeTrue();
      expect(outcome.stderr).toContain("synthetic stderr");
      expect(readFileSync(join(dir, "stdout-target"), "utf8").trim()).toBe("/dev/null");
      const root = Number(readFileSync(synthetic.root, "utf8"));
      expect(alive(root)).toBeFalse();
    } finally {
      await cleanupSynthetic(dir);
    }
  }, 10_000);

  test("preserves a malformed-sink error when an escaped stderr holder delays EOF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-holder-"));
    const holder = join(dir, "holder.pid");
    try {
      const synthetic = syntheticRun(dir, "holder", { TEST_HOLDER: holder });
      const started = Date.now();
      const error = await expectSyntheticFailure(synthetic.root, synthetic.run);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors.map(String);
      expect(errors.some((message) => message.includes("JSON"))).toBeTrue();
      expect(errors.some((message) => message.includes("stderr did not reach EOF"))).toBeTrue();
      const holderPid = Number(readFileSync(holder, "utf8"));
      expect(alive(holderPid)).toBeTrue();
      process.kill(holderPid, "SIGKILL");
      await waitFor(() => !alive(holderPid));
    } finally {
      if (existsSync(holder)) {
        const holderPid = Number(readFileSync(holder, "utf8"));
        if (alive(holderPid)) {
          process.kill(holderPid, "SIGKILL");
          await waitFor(() => !alive(holderPid));
        }
      }
      await cleanupSynthetic(dir);
    }
  }, 10_000);

  test("reaps a page-reported failure after the sink is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-page-failure-"));
    try {
      const synthetic = syntheticRun(dir, "page-failure");
      const error = await expectSyntheticFailure(synthetic.root, synthetic.run);
      expect(String(error)).toContain("page reported failure: synthetic page failure");
      const root = Number(readFileSync(synthetic.root, "utf8"));
      expect(alive(root)).toBeFalse();
    } finally {
      await cleanupSynthetic(dir);
    }
  });

  test("preserves an onReady failure after reaping the synthetic wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-ready-failure-"));
    try {
      const synthetic = syntheticRun(dir, "stdout");
      const error = await expectSyntheticFailure(synthetic.root, () => runShell({
        mode: "naive",
        soakMs: 0,
        staged: "unused",
        probeA11y: false,
        onReady: async () => {
          throw new Error("synthetic onReady failure");
        },
        env: {
          PATH: `${synthetic.bin}:${process.env.PATH ?? ""}`,
          NO_AT_BRIDGE: "0",
          RUN_SHELL_SCENARIO: "stdout",
          TEST_ROOT: synthetic.root,
          TEST_WORK: synthetic.work,
        },
      }));
      expect(String(error)).toContain("synthetic onReady failure");
      const root = Number(readFileSync(synthetic.root, "utf8"));
      expect(alive(root)).toBeFalse();
    } finally {
      await cleanupSynthetic(dir);
    }
  });

  test("preserves an undefined value thrown by onReady", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-ready-undefined-"));
    try {
      const synthetic = syntheticRun(dir, "stdout");
      const error = await expectSyntheticFailure(synthetic.root, () => runShell({
        mode: "naive",
        soakMs: 0,
        staged: "unused",
        probeA11y: false,
        onReady: async () => {
          throw undefined;
        },
        env: {
          PATH: `${synthetic.bin}:${process.env.PATH ?? ""}`,
          NO_AT_BRIDGE: "0",
          RUN_SHELL_SCENARIO: "stdout",
          TEST_ROOT: synthetic.root,
          TEST_WORK: synthetic.work,
        },
      }));
      expect(error).toBeUndefined();
      const root = Number(readFileSync(synthetic.root, "utf8"));
      expect(alive(root)).toBeFalse();
    } finally {
      await cleanupSynthetic(dir);
    }
  });

  test("stops sampling before a successful delayed onReady hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-ready-sampling-"));
    try {
      const synthetic = syntheticRun(dir, "hook");
      const callStarted = Date.now();
      let hookStarted = 0;
      const outcome = await runWithSyntheticWatchdog(synthetic.root, () => runShell({
        mode: "naive",
        soakMs: 0,
        staged: "unused",
        probeA11y: false,
        onReady: async () => {
          hookStarted = Date.now();
          await Bun.sleep(600);
        },
        env: {
          PATH: `${synthetic.bin}:${process.env.PATH ?? ""}`,
          NO_AT_BRIDGE: "0",
          RUN_SHELL_SCENARIO: "hook",
          TEST_ROOT: synthetic.root,
          TEST_WORK: synthetic.work,
        },
      }));
      expect(outcome.rssSeries.length).toBeGreaterThan(0);
      expect(outcome.rssSeries.every((sample) => sample.atMs <= hookStarted - callStarted)).toBeTrue();
    } finally {
      await cleanupSynthetic(dir);
    }
  }, 10_000);

  test("keeps no-sink stderr diagnostics after cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-shell-no-sink-stderr-"));
    try {
      const synthetic = syntheticRun(dir, "no-sink-stderr");
      const error = await expectSyntheticFailure(synthetic.root, synthetic.run);
      expect(String(error)).toContain("host exited 7 before reporting");
      expect(String(error)).toContain("synthetic stderr");
    } finally {
      await cleanupSynthetic(dir);
    }
  });
});
