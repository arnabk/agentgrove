#!/usr/bin/env bash
# scripts/demo-thumbs.sh — regenerate demo thumbnails for every video in
# docs/demos. Instead of always taking the midpoint frame, sample several
# timestamps and keep the most detailed one (JPEG byte size at a fixed
# quality is a good proxy for sharpness / content richness), so README
# thumbnails show a representative frame instead of a transition blur.
#
# Usage: bash scripts/demo-thumbs.sh

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_DIR="$REPO/docs/demos"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

filesize() {
  # macOS: stat -f%z; GNU: stat -c%s
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1"
}

for video in "$DEMO_DIR"/*.mp4; do
  name="$(basename "$video" .mp4)"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")
  best=""
  best_size=0
  # Candidates in the mid band: early frames are often startup states
  # (empty panes), late ones teardown.
  for frac in 0.30 0.45 0.60 0.75; do
    ts=$(awk -v d="$dur" -v f="$frac" 'BEGIN { printf "%.2f", d * f }')
    out="$TMP/$name-$frac.jpg"
    # Save the full-res frame as a candidate output…
    ffmpeg -y -loglevel error -ss "$ts" -i "$video" -vframes 1 -q:v 2 -update 1 "$out"
    # …but SCORE a heavily downscaled copy. The app's dashed background
    # pattern is high-frequency noise that inflates JPEG size at full
    # res; at 90px it blurs away entirely while layout-level content
    # (text blocks, grids, terminal output) still differentiates.
    small="$TMP/$name-$frac-small.jpg"
    ffmpeg -y -loglevel error -i "$out" -vf scale=90:-1 -q:v 2 -update 1 "$small"
    size=$(filesize "$small")
    if [ "$size" -gt "$best_size" ]; then
      best_size=$size
      best=$out
    fi
  done
  cp "$best" "$DEMO_DIR/$name-thumb.jpg"
  echo "[thumbs] $name -> picked frame at $(basename "$best" .jpg | sed "s/$name-//") of video (${best_size} bytes)"
done

echo "[thumbs] done"
