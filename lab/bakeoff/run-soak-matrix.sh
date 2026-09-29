#!/usr/bin/env bash
# Overnight A/B soak matrix for the stress-fixture latency failure.
#
# Attribution experiment: the baseline Tauri stress soak failed the typing and
# projected-memory gates. Each variant changes exactly one thing, so a variant
# that recovers latency identifies the cause.
#
# Runs are strictly sequential: they are pinned to the same four cores by
# throttle-run.sh, and any overlap would contaminate both measurements.
#
# Usage: bakeoff/run-soak-matrix.sh   (from lab/)
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
    # A failed configuration must not abort the night: the remaining ones are
    # independent measurements and are still worth having by morning.
    log "FAIL  $name (see $LOG_DIR/$name.log)"
    return 0
  fi
}

# 1. Wait out any in-flight run rather than contending with it.
waited=0
while pgrep -f "bakeoff-shell-tauri|electron .*shell-electron" >/dev/null 2>&1; do
  if [ "$waited" -ge 3600 ]; then
    log "ABORT: a shell has been running for an hour; not starting the matrix"
    exit 1
  fi
  sleep 30
  waited=$((waited + 30))
done
log "no shell running (waited ${waited}s); starting"

# 2. Validate each variant cheaply before committing hours to it. A variant that
#    crashes the page would otherwise burn 30 minutes to produce an error
#    payload. Validation artifacts are deleted; the log is the record.
for v in "lazy-docs" "contain-nav" "contain-nav,lazy-docs"; do
  name="validate-${v//,/+}"
  run_cfg "$name" --fixture=tiny --only=tauri --variant="$v"
  if ! grep -q "tauri: 0 fails" "$LOG_DIR/$name.log"; then
    log "ABORT: variant '$v' did not pass a tiny run; see $LOG_DIR/$name.log"
    exit 1
  fi
  rm -f "results/bakeoff-tauri-tiny-${v//,/+}.json" \
        "results/report-bakeoff-tiny-tauri-${v//,/+}.md"
done
log "all variants validated at tiny"

# 3. The attribution matrix, 30 minutes each.
#    The baseline is re-run here rather than reused: the committed baseline
#    predates per-cycle capture, so it has no curve, and the variants must be
#    compared against a control measured under the same harness and the same
#    straggler-free conditions.
run_cfg soak-stress-tauri-baseline \
  --fixture=stress --only=tauri --soak-min=30
run_cfg soak-stress-tauri-lazy-docs \
  --fixture=stress --only=tauri --soak-min=30 --variant=lazy-docs
run_cfg soak-stress-tauri-contain-nav \
  --fixture=stress --only=tauri --soak-min=30 --variant=contain-nav
run_cfg soak-stress-tauri-both \
  --fixture=stress --only=tauri --soak-min=30 --variant=contain-nav,lazy-docs

# 4. Electron under sustained load. It was eliminated on the 750 MB memory gate
#    alone; with memory de-prioritized in favour of latency, that elimination
#    needs latency evidence it has never had.
run_cfg soak-stress-electron-baseline \
  --fixture=stress --only=electron --soak-min=30
run_cfg soak-stress-electron-both \
  --fixture=stress --only=electron --soak-min=30 --variant=contain-nav,lazy-docs

log "matrix complete"
