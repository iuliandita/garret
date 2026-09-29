#!/usr/bin/env bash
# Phase 2 of the stress-soak investigation.
#
# Phase 1 established: lazy-docs fixes memory and not latency (so retained heap
# is not the cause of the stall), and contain-nav is a severe regression that
# changed three things at once and therefore tested nothing cleanly.
#
# This phase runs the clean one-variable navigator test, and the Electron soaks
# that were structurally impossible until the shell's hardcoded 5-minute
# watchdog was made to scale with the soak length.
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

waited=0
while pgrep -f "bakeoff-shell-tauri|shell-electron" >/dev/null 2>&1; do
  if [ "$waited" -ge 600 ]; then
    log "ABORT: a shell is still running after 10 minutes"
    exit 1
  fi
  sleep 15
  waited=$((waited + 15))
done

# Validate the new variant before spending 30 minutes on it.
run_cfg validate-nav-cap --fixture=tiny --only=tauri --variant=nav-cap
if ! grep -q "tauri: 0 fails" "$LOG_DIR/validate-nav-cap.log"; then
  log "ABORT: nav-cap did not pass a tiny run"
  exit 1
fi
rm -f results/bakeoff-tauri-tiny-nav-cap.json results/report-bakeoff-tiny-tauri-nav-cap.md

# Confirm Electron can now outlive its watchdog before committing to 30 minutes.
# The harness has two distinct markers and this guard needs both: a shell killed
# by its watchdog writes nothing and reports "no sink payload", while a shell
# that survives but never soaked reports "no soak payload". Matching only the
# latter missed exactly the failure this guard exists to catch, and a broken
# Electron shell ran twice before that was noticed. Phase 3 matches both.
run_cfg validate-electron-soak --fixture=tiny --only=electron --soak-min=6
if grep -qE "no sink payload|no soak payload" \
    "$LOG_DIR/validate-electron-soak.log"; then
  log "ABORT: Electron still cannot soak past its watchdog"
  exit 1
fi
rm -f results/bakeoff-electron-tiny-soak.json results/report-bakeoff-tiny-soak-electron.md

# 1. The attribution question: is the navigator's node count the cause?
run_cfg soak-stress-tauri-nav-cap \
  --fixture=stress --only=tauri --soak-min=30 --variant=nav-cap

# 2. Electron under sustained load, finally measurable. Latency is the axis that
#    matters now that the memory gate is de-prioritized, and Electron has never
#    been measured on it.
run_cfg soak-stress-electron-baseline \
  --fixture=stress --only=electron --soak-min=30

# 3. Electron with the one variant that helped Tauri, for a like-for-like best
#    configuration on both shells.
run_cfg soak-stress-electron-lazy-docs \
  --fixture=stress --only=electron --soak-min=30 --variant=lazy-docs

log "phase 2 complete"
