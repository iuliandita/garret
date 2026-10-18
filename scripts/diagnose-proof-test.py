#!/usr/bin/env python3
import subprocess
import sys

child = subprocess.Popen(sys.argv[1:])
try:
    status = child.wait(timeout=20)
except subprocess.TimeoutExpired:
    print(f"proof-backtrace pid={child.pid}: test process still alive after 20 seconds", flush=True)
    dump = subprocess.run([
        "sudo", "timeout", "30s", "gdb", "--nx", "--batch", "--pid", str(child.pid),
        "-ex", "set debuginfod enabled off", "-ex", "set pagination off", "-ex", "thread apply all bt",
    ])
    print(f"proof-backtrace debugger exit={dump.returncode}", flush=True)
    status = child.wait()
raise SystemExit(status if status >= 0 else 128 - status)
