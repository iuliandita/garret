#!/usr/bin/env python3
"""Bound the isolated proof process tree, collecting live evidence before TERM."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


class Interrupted(Exception):
    def __init__(self, number: int):
        self.number = number


def interrupt(number: int, _frame) -> None:
    raise Interrupted(number)


def phase(message: str) -> None:
    line = f"proof-phase ts={time.time():.3f} pid={os.getpid()} {message}\n".encode()
    os.write(2, line)
    with open(os.environ["GARRET_PROOF_PHASE_LOG"], "ab", buffering=0) as log:
        log.write(line)


def snapshot(group: int, directory: Path) -> None:
    phase("outer deadline reached; collecting live process diagnostics before TERM")
    members = []
    with (directory / "threads.log").open("w") as log:
        for process in sorted(Path("/proc").glob("[0-9]*")):
            try:
                pid = int(process.name)
                if os.getpgid(pid) != group:
                    continue
                name = (process / "comm").read_text().strip()
                members.append((pid, name))
                log.write(f"pid={pid} comm={name}\n")
                for thread in sorted((process / "task").iterdir()):
                    for field in ("comm", "wchan", "stack"):
                        try:
                            value = (thread / field).read_text().strip()
                        except OSError as error:
                            value = str(error)
                        log.write(f"tid={thread.name} {field}={value}\n")
                log.flush()
            except (OSError, ProcessLookupError):
                continue
    # Prioritize the fixture and WebKit, with a fixed total debugger budget.
    members.sort(key=lambda item: (not item[1].startswith("garret-"), item[0]))
    deadline = time.monotonic() + 20
    for pid, name in members:
        if not (name.startswith("garret-") or "WebKit" in name):
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        with (directory / f"stacks-{pid}.log").open("w") as log:
            try:
                subprocess.run(
                    ["gdb", "-nx", "-batch", "-iex", "set auto-load off",
                     "-ex", "set pagination off", "-ex", "thread apply all bt",
                     "-p", str(pid)],
                    stdout=log, stderr=subprocess.STDOUT, timeout=min(8, remaining),
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                log.write(f"debugger unavailable or timed out: {error}\n")
    phase("live diagnostics saved; sending TERM to proof process group")


def main() -> int:
    seconds, directory, *command = sys.argv[1:]
    phase("outer supervisor starting child process group")
    child = subprocess.Popen(command, start_new_session=True)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    phase(f"outer supervisor started child pid={child.pid}")
    terminate = False
    try:
        try:
            returncode = child.wait(timeout=float(seconds))
            phase(f"outer supervisor child exited status={returncode}")
            return returncode if returncode >= 0 else 128 - returncode
        except subprocess.TimeoutExpired:
            terminate = True
            snapshot(child.pid, Path(directory))
            phase("outer supervisor deadline failure status=124")
            return 124
    except Interrupted as error:
        terminate = True
        phase(f"outer supervisor interrupted signal={error.number}")
        return 128 + error.number
    finally:
        if terminate:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            time.sleep(5)
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                phase("proof child did not reap after KILL")


if __name__ == "__main__":
    sys.exit(main())
