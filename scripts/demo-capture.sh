#!/usr/bin/env bash
# scripts/demo-capture.sh — record one headed Playwright demo with macOS screen capture.
#
# Usage:
#   bash scripts/demo-capture.sh

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

DEMO_URL="http://127.0.0.1:4320"
DEMO_BE_URL="http://127.0.0.1:4320"
DEMO_PROJECT="/home/agentgrove/.data/demo-project"
DEMO_DIR="docs/demos"
VIDEO_FILE="${DEMO_DIR}/demo-capture.mp4"

mkdir -p "$DEMO_DIR"

echo "[demo-capture] checking 9router host endpoint..."
if ! curl -fsS "http://127.0.0.1:20128/v1/models" -H "Authorization: Bearer sk_9router" >/dev/null 2>&1; then
  echo "[demo-capture] error: 9router not reachable on http://127.0.0.1:20128/v1"
  exit 1
fi

echo "[demo-capture] ensuring demo backend is running on :4320..."
if ! curl -fsS "${DEMO_URL}/health" >/dev/null 2>&1; then
  docker compose -f docker/docker-compose.demo.yml up -d
  for i in $(seq 1 60); do
    if curl -fsS "${DEMO_URL}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

echo "[demo-capture] starting screen capture..."
rm -f "$VIDEO_FILE"
ffmpeg -y -f avfoundation -pixel_format uyvy422 -i "1:none" -r 30 -vf "crop=1440:900:0:25" -pix_fmt yuv420p -movflags +faststart "$VIDEO_FILE" &
FFMPEG_PID=$!

# Give ffmpeg time to start.
sleep 2

echo "[demo-capture] running Playwright demo in headed mode..."
cd apps/web
AGENTGROVE_BE_URL="${DEMO_BE_URL}" \
AGENTGROVE_DEMO_URL="${DEMO_URL}" \
REPO_ROOT="${DEMO_PROJECT}" \
  pnpm exec playwright test --config=playwright-demo-capture.config.ts

echo "[demo-capture] stopping screen capture..."
kill -INT "$FFMPEG_PID" 2>/dev/null || true
wait "$FFMPEG_PID" 2>/dev/null || true

cd "$REPO"
echo "[demo-capture] video saved to $VIDEO_FILE"
