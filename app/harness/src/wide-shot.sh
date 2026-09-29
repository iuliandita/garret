#!/usr/bin/env bash
# A photograph of the application on a REAL, large monitor -- the one thing
# no Xvfb rig can take, because the question it answers ("what does a 4k
# desktop at scale 1 look like") is about a display server the rigs do not
# run. Not a rig: grades nothing, writes no result, and its picture is one
# capture on one operator's desk. An earlier design record is where the
# baseline pair lives; the two committed captures per change go beside the
# rig screenshots with `wide-<zoom>` in the name.
#
# It runs on the live Wayland session under Hyprland, on a workspace the
# operator has pinned to the large output, and crops to the application's
# window: the monitor also shows the operator's bar and any notification,
# and this file's output is committed evidence. It still catches whatever
# the compositor draws OVER the window -- look at the corners before you
# commit a capture, and dismiss notifications first.
#
# usage: WIDE_OUTPUT=<hyprland output name> WIDE_WORKSPACE=<n> \
#        app/harness/src/wide-shot.sh <light|dark> <out.png> [zoom]
# from the repo root, after `cd app/ui && bun run build`. With
# WIDE_SCREEN=library the host boots with NO project and `start`
# "home": a library of three books (the sample on the desk, pinned to the
# first of shot-cli's two demo pen names; two more from the stress and tiny
# fixtures, one pinned to the second) seeded into the data home's own
# `projects/` directory, which is how the overview finds them. The workspace
# must already be bound to the output (`hyprctl keyword workspace "<n>,
# monitor:<output>"`) and a window rule must send the app there
# (`hyprctl keyword windowrule "workspace <n> silent, match:class
# ^([Gg]arret)$"`); both are session-only and neither is set here.
# WIDE_FIXTURE=<dir> seeds that fixture instead of the stress one
# (`app/fixtures/sample` for the sample's own timeline), and
# WIDE_OPEN=<title> opens that document through Quick Open (Ctrl+P, the
# title, Return, typed with wtype into the focused window) before the
# capture -- the route shot-cli takes, for the same reason: no computed row
# coordinate survives a 4k window.
set -euo pipefail
theme="$1"
out="$2"
zoom="${3:-100}"
: "${WIDE_OUTPUT:?set WIDE_OUTPUT to the Hyprland output the workspace is on}"
: "${WIDE_WORKSPACE:?set WIDE_WORKSPACE to the workspace the window rule sends the app to}"
BIN=app/shell-tauri/src-tauri/target/release/garret
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/data/cc.local.app"
# 3800x2100 asks for most of a 3840x2160 screen; the host fits it to the
# work area on launch.
if [[ "${WIDE_SCREEN:-}" == "library" ]]; then
  lib="$work/data/cc.local.app/projects"
  mkdir -p "$lib"
  "$BIN" --seed app/fixtures/sample "$lib/the-salt-cartographer.db" >/dev/null
  "$BIN" --seed lab/fixtures/out/stress "$lib/second-book.db" >/dev/null
  "$BIN" --seed lab/fixtures/out/tiny "$lib/third-book.db" >/dev/null
  sqlite3 "$lib/second-book.db" "INSERT INTO meta (key, value) VALUES ('project_name', 'Second book') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  sqlite3 "$lib/third-book.db" "INSERT INTO meta (key, value) VALUES ('project_name', 'Third book') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  # shot-cli's DEMO_VAULT and pinBook, restated: the pin is the public and
  # publishing tiers only, which is what the host's identity::pin_of builds.
  ada='{"name":"Ada Vane","sort_name":"Vane, Ada","bio":"Writes about harbours and the people who leave them.","links":["https://example.invalid/ada"]}'
  ada_pub='{"imprint":"Vane Press","rights":"(c) Ada Vane"}'
  bram='{"name":"Bram Kell","sort_name":"Kell, Bram","bio":"","links":[]}'
  bram_pub='{"imprint":"","rights":""}'
  printf '{"version":1,"identities":[{"id":"i1","rev":1,"public":%s,"publishing":%s,"private":{"legal_name":"Margaret Hollis","contact":"margaret@example.invalid","admin":"Registered 2019."}},{"id":"i2","rev":1,"public":%s,"publishing":%s,"private":{"legal_name":"","contact":"","admin":""}}]}' \
    "$ada" "$ada_pub" "$bram" "$bram_pub" >"$work/data/cc.local.app/identities.json"
  sqlite3 "$lib/the-salt-cartographer.db" "INSERT INTO meta (key, value) VALUES ('identity.pin', '{\"identity_id\":\"i1\",\"rev\":1,\"pinned_at\":1756400000,\"public\":$ada,\"publishing\":$ada_pub}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  sqlite3 "$lib/second-book.db" "INSERT INTO meta (key, value) VALUES ('identity.pin', '{\"identity_id\":\"i2\",\"rev\":1,\"pinned_at\":1756400000,\"public\":$bram,\"publishing\":$bram_pub}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  printf '{"theme":"%s","zoom":"%s","start":"home","window":{"width":3800,"height":2100}}' "$theme" "$zoom" \
    >"$work/data/cc.local.app/settings.json"
  APP_RUN=interactive APP_DIST=app/ui/dist \
    XDG_DATA_HOME="$work/data" APP_RECOVERY_MODE=off "$BIN" >"$work/log" 2>&1 &
else
  "$BIN" --seed "${WIDE_FIXTURE:-lab/fixtures/out/stress}" "$work/project.db" >/dev/null
  printf '{"theme":"%s","zoom":"%s","window":{"width":3800,"height":2100}}' "$theme" "$zoom" \
    >"$work/data/cc.local.app/settings.json"
  APP_RUN=interactive APP_DIST=app/ui/dist APP_PROJECT="$work/project.db" \
    XDG_DATA_HOME="$work/data" APP_RECOVERY_MODE=off "$BIN" >"$work/log" 2>&1 &
fi
pid=$!
sleep 6
prev=$(hyprctl monitors -j | python3 -c "import json,sys; print([m for m in json.load(sys.stdin) if m['name']=='$WIDE_OUTPUT'][0]['activeWorkspace']['id'])")
hyprctl dispatch workspace "$WIDE_WORKSPACE" >/dev/null
sleep 1.5
if [[ -n "${WIDE_OPEN:-}" ]]; then
  wtype -M ctrl -P p -p p -m ctrl
  sleep 1.5
  wtype -- "$WIDE_OPEN"
  sleep 1.5
  wtype -k Return
  sleep 2.5
fi
geom=$(hyprctl clients -j | python3 -c "import json,sys; c=[c for c in json.load(sys.stdin) if c['class'].lower()=='garret'][0]; print(f\"{c['at'][0]},{c['at'][1]} {c['size'][0]}x{c['size'][1]}\")")
grim -g "$geom" "$out"
hyprctl dispatch workspace "$prev" >/dev/null
kill "$pid" || true
wait "$pid" 2>/dev/null || true
echo "wrote $out"
