#!/usr/bin/env bash
# Capture every scene and build the blind A/B pairs the critic reads.
# Usage: tools/prep-critique.sh [round] [port]
set -u
ROUND="${1:-1}"; PORT="${2:-5173}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REFS="/tmp/claude-0/-home-user-Claudecrazygame/99119084-1c6e-5444-a770-d874fd691b96/scratchpad/refs"
OUT="$ROOT/shots/round$ROUND"
cd "$ROOT"

if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "starting dev server on $PORT"
  (npx vite --host 127.0.0.1 --port "$PORT" > "/tmp/vite-critique.log" 2>&1 &)
  for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
fi

node tools/capture-all.mjs --port "$PORT" --out "$OUT" --w 1600 --h 900 || exit 1

# Blind pairs: our frame vs the real game, neutral names, randomised order.
mkdir -p "$ROOT/shots/blind"
pair() {  # pair <scene> <reference>
  [ -f "$OUT/$1.png" ] || { echo "missing $OUT/$1.png"; return; }
  node tools/blindpair.mjs "$OUT/$1.png" "$2" "$ROOT/shots/blind/$1" > /dev/null && echo "blind pair ready: $1"
}
pair vista  "$REFS/ref_bl3_vista.jpg"
pair combat "$REFS/ref_bl3_combat.jpg"
pair hud    "$REFS/ref_bl4_hud.jpg"
echo "captures -> $OUT"
