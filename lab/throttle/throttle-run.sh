#!/usr/bin/env bash
# Run a command approximating reference hardware:
#   4 CPU threads (taskset) + 8G memory cap (systemd user scope).
# Usage: throttle-run.sh [-c CPULIST] [-m MEM] -- command args...
set -euo pipefail

cpulist="0-3"
mem="8G"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) cpulist="${2:?-c requires a CPU list}"; shift 2 ;;
    -m) mem="${2:?-m requires a memory value}"; shift 2 ;;
    --) shift; break ;;
    *) echo "usage: $0 [-c CPULIST] [-m MEM] -- cmd..." >&2; exit 2 ;;
  esac
done
[[ $# -gt 0 ]] || { echo "no command given" >&2; exit 2; }

exec systemd-run --user --scope --quiet \
  -p "MemoryMax=${mem}" -p "MemorySwapMax=0" \
  taskset -c "${cpulist}" "$@"
