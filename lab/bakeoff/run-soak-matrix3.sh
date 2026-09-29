#!/usr/bin/env bash
# Phase 3. Attribution is settled: nav-cap removes the latency cliff entirely
# (typing p95 flat 33 ms over 30 minutes, 115 cycles vs the baseline's 39), so
# the stall is the navigator's node count, not retained heap and not the shell.
#
# Remaining questions:
#   1. The combined best configuration, which no run has covered: nav-cap fixes
#      latency, lazy-docs fixes memory, neither fixes the other.
#   2. Electron under sustained load, never once measured — its elimination
#      rested solely on a memory gate that has been de-prioritized.
set -euo pipefail

cd "$(dirname "$0")/.."   # lab/
LOG_DIR="results/soak-matrix-logs"
mkdir -p "$LOG_DIR"

log() { echo "[$(date -Is)] $*"; }

run_cfg() {
  local name="$1"; shift
  log "START $name"
  if BAKEOFF_GUI=1 throttle/throttle-run.sh -- \
      bun bakeoff/harness/src/matrix.ts "$@" >"$LOG_DIR/$name.log" 2>&1; then
    log "DONE  $name -> $(tail -2 "$LOG_DIR/$name.log" | tr '\n' ' ')"
  else
    log "FAIL  $name (see $LOG_DIR/$name.log)"
    return 0
  fi
}

# The guard in phase 2 grepped "no soak payload" while the harness says "no sink
# payload", so it never fired and a broken Electron shell ran twice. Match both.
broken() {
  grep -qE "no sink payload|no soak payload|Cannot read properties|SyntaxError" \
    "$LOG_DIR/$1.log"
}

# 1. The best configuration, first: it is the deliverable.
run_cfg soak-stress-tauri-best \
  --fixture=stress --only=tauri --soak-min=30 --variant=lazy-docs,nav-cap

# 2. Prove the Electron shell actually starts and outlives its watchdog before
#    spending an hour on it. Two rebuilds in a row shipped a main.js that could
#    not boot, and each cost a full run to discover.
run_cfg validate-electron --fixture=tiny --only=electron --soak-min=6
if broken validate-electron; then
  log "ABORT: Electron shell still cannot complete a soak; skipping Electron runs"
  log "phase 3 complete (Electron skipped)"
  exit 0
fi
rm -f results/bakeoff-electron-tiny-soak.json results/report-bakeoff-tiny-soak-electron.md

run_cfg soak-stress-electron-baseline \
  --fixture=stress --only=electron --soak-min=30
run_cfg soak-stress-electron-best \
  --fixture=stress --only=electron --soak-min=30 --variant=lazy-docs,nav-cap

log "phase 3 complete"
