#!/usr/bin/env python3
"""Exercise the deadline against a live process and a TERM-resistant descendant."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


if len(sys.argv) > 1 and sys.argv[1] == "--child":
    directory = Path(sys.argv[2])
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
    print("Proof supervisor: live diagnostics, TERM flush, deadline and exit status passed.")
