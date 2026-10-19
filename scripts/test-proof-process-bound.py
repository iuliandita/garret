#!/usr/bin/env python3
"""Exercise the deadline against a live process and a TERM-resistant descendant."""
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


if len(sys.argv) > 1 and sys.argv[1] == "--child":
    directory = Path(sys.argv[2])
    native = ctypes.CDLL(None)
    assert native.prctl(15, b"garret-probe", 0, 0, 0) == 0
    # Permit only this disposable process to be inspected on Yama-enabled hosts.
    assert native.prctl(0x59616D61, ctypes.c_ulong(-1), 0, 0, 0) == 0
    if os.fork() == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (directory / "descendant-pid").write_text(str(os.getpid()))
        while True:
            time.sleep(1)

    def terminate(_signal, _frame):
        (directory / "term-received").write_text("flushed before kill")
        sys.exit(0)

    signal.signal(signal.SIGTERM, terminate)
    while True:
        time.sleep(1)


with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    environment = dict(os.environ, GARRET_PROOF_PHASE_LOG=str(directory / "phases.log"))
    bound = Path(__file__).with_name("proof-process-bound.py")
    result = subprocess.run(
        [sys.executable, str(bound), "0.5", temporary,
         sys.executable, __file__, "--child", temporary],
        env=environment, capture_output=True, text=True, timeout=35,
    )
    assert result.returncode == 124, result
    assert (directory / "term-received").read_text() == "flushed before kill"
    assert "wchan=" in (directory / "threads.log").read_text()
    stacks = list(directory.glob("stacks-*.log"))
    assert stacks, "native stack capture was not attempted"
    if os.environ.get("CI"):
        assert any("Thread " in stack.read_text() for stack in stacks), "no native backtrace"
    phases = (directory / "phases.log").read_text()
    assert phases.index("collecting live") < phases.index("sending TERM")
    assert "status=124" in phases
    descendant = Path("/proc") / (directory / "descendant-pid").read_text()
    if descendant.exists():
        assert ") Z " in (descendant / "stat").read_text(), "descendant survived KILL"
    result = subprocess.run(
        [sys.executable, str(bound), "5", temporary,
         sys.executable, "-c", "raise SystemExit(7)"],
        env=environment, timeout=10,
    )
    assert result.returncode == 7, result
    for number in (signal.SIGINT, signal.SIGTERM):
        (directory / "descendant-pid").unlink()
        (directory / "term-received").unlink()
        with (directory / "interrupt.log").open("w") as log:
            supervisor = subprocess.Popen(
                [sys.executable, str(bound), "60", temporary,
                 sys.executable, __file__, "--child", temporary],
                env=environment, stdout=log, stderr=log,
            )
            try:
                deadline = time.monotonic() + 5
                while not (directory / "descendant-pid").exists():
                    assert time.monotonic() < deadline, "child did not start"
                    time.sleep(0.01)
                supervisor.send_signal(number)
                assert supervisor.wait(timeout=15) == 128 + number
                assert (directory / "term-received").exists(), "TERM did not flush"
                descendant = Path("/proc") / (directory / "descendant-pid").read_text()
                if descendant.exists():
                    assert ") Z " in (descendant / "stat").read_text(), "descendant survived interruption"
            finally:
                if supervisor.poll() is None:
                    supervisor.send_signal(signal.SIGTERM)
                    supervisor.wait(timeout=15)
    print("Proof supervisor: live diagnostics, TERM flush, deadline, interruption and exit status passed.")
