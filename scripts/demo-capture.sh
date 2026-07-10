#!/usr/bin/env bash
# scripts/demo-capture.sh — orchestrate demo video recording inside the Docker container.
#
# The actual recording (browser, screen capture, ffmpeg) runs inside the
# AgentGrove demo container so the host machine is not disturbed.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

SCENARIO="${1:-ai-chat}"
DEMO_DIR="docs/demos"
VIDEO_FILE="${DEMO_DIR}/${SCENARIO}.mp4"
THUMB_FILE="${DEMO_DIR}/${SCENARIO}-thumb.jpg"
CONTAINER_DEMO="/home/agentgrove/demos/${SCENARIO}.mp4"

echo "[demo-capture] scenario: ${SCENARIO}"

if [ ! -f "apps/web/e2e/demo-${SCENARIO}.spec.ts" ]; then
  echo "[demo-capture] error: spec not found: apps/web/e2e/demo-${SCENARIO}.spec.ts"
  exit 1
fi

mkdir -p "$DEMO_DIR"

echo "[demo-capture] resetting demo state..."
docker compose -f docker/docker-compose.demo.yml down -v >/dev/null 2>&1 || true

echo "[demo-capture] building / starting demo container..."
docker compose -f docker/docker-compose.demo.yml up --build -d

echo "[demo-capture] recording inside container..."
docker compose -f docker/docker-compose.demo.yml exec -T agentgrove-demo /home/agentgrove/demo-capture.sh "${SCENARIO}"

echo "[demo-capture] copying video from container..."
rm -f "$VIDEO_FILE" "$THUMB_FILE"
docker compose -f docker/docker-compose.demo.yml cp "agentgrove-demo:${CONTAINER_DEMO}" "$VIDEO_FILE"

echo "[demo-capture] generating thumbnail at midpoint..."
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_FILE")
THUMB_TIME=$(echo "$DURATION / 2" | bc -l | xargs -I {} printf "%.2f" {})
ffmpeg -y -i "$VIDEO_FILE" -ss "$THUMB_TIME" -vframes 1 -q:v 2 -update 1 "$THUMB_FILE"

echo "[demo-capture] done: $VIDEO_FILE"
