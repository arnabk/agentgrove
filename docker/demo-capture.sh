#!/usr/bin/env bash
# docker/demo-capture.sh — record a demo video inside the AgentGrove demo container.
# Called via docker compose exec from scripts/demo-capture.sh on the host.

set -eu

SCENARIO="${1:-ai-chat}"
DEMO_URL="http://127.0.0.1:4317"
DEMO_PROJECT="/home/agentgrove/.data/demo-project"
DEMO_DIR="/home/agentgrove/demos"
VIDEO_FILE="${DEMO_DIR}/${SCENARIO}.mp4"
SPEC_FILE="e2e/demo-${SCENARIO}.spec.ts"

echo "[in-container] scenario: ${SCENARIO}"

mkdir -p "$DEMO_DIR"

if [ ! -f "/home/agentgrove/apps/web/${SPEC_FILE}" ]; then
  echo "[in-container] error: spec not found: /home/agentgrove/apps/web/${SPEC_FILE}"
  exit 1
fi

# Seed a small demo project so file search and terminal demos have content.
mkdir -p "${DEMO_PROJECT}/src"
printf '{\n  "name": "demo-project",\n  "version": "1.0.0"\n}\n' > "${DEMO_PROJECT}/package.json"
printf '# Demo Project\nThis is a demo project for AgentGrove.\n' > "${DEMO_PROJECT}/README.md"
printf 'export const greeting = "Hello, AgentGrove!";\n' > "${DEMO_PROJECT}/src/index.ts"

# Wait for the demo backend.
echo "[in-container] waiting for demo backend on ${DEMO_URL}..."
for i in $(seq 1 60); do
  if curl -fsS "${DEMO_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "${DEMO_URL}/health" >/dev/null 2>&1 || { echo "[in-container] backend did not start"; exit 1; }

# Ensure 9router is reachable for AI scenarios.
case "$SCENARIO" in
  ai-chat|prompt-queue)
    if ! curl -fsS "http://host.docker.internal:20128/v1/models" -H "Authorization: Bearer sk_9router" >/dev/null 2>&1; then
      echo "[in-container] error: 9router not reachable on http://host.docker.internal:20128/v1"
      exit 1
    fi
    ;;
esac

# Start virtual display.
echo "[in-container] starting Xvfb..."
Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR >/dev/null 2>&1 &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

# Clean up on exit.
FFMPEG_PID=""
cleanup() {
  if [ -n "$FFMPEG_PID" ]; then
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    wait "$FFMPEG_PID" 2>/dev/null || true
  fi
  kill -9 "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Start screen capture.
echo "[in-container] starting screen capture..."
rm -f "$VIDEO_FILE"
ffmpeg -y -f x11grab -draw_mouse 1 -framerate 30 -video_size 1440x900 -i :99.0+0,0 -pix_fmt yuv420p -movflags +faststart "$VIDEO_FILE" &
FFMPEG_PID=$!
sleep 2

# Run the Playwright demo.
echo "[in-container] running Playwright demo..."
cd /home/agentgrove/apps/web
AGENTGROVE_BE_URL="${DEMO_URL}" \
AGENTGROVE_DEMO_URL="${DEMO_URL}" \
REPO_ROOT="${DEMO_PROJECT}" \
DISPLAY=:99 \
  pnpm exec playwright test --config=playwright-demo-docker-capture.config.ts "${SPEC_FILE}"

echo "[in-container] video saved to $VIDEO_FILE"
