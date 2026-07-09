#!/usr/bin/env bash
# scripts/demo-capture.sh — record a headed Playwright demo with macOS screen capture.
#
# Usage:
#   bash scripts/demo-capture.sh <scenario>
#
# Scenarios are Playwright specs named e2e/demo-<scenario>.spec.ts.
# Output: docs/demos/<scenario>.mp4

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

SCENARIO="${1:-ai-chat}"
DEMO_URL="http://127.0.0.1:4320"
DEMO_BE_URL="http://127.0.0.1:4320"
DEMO_PROJECT="/home/agentgrove/.data/demo-project"
DEMO_DIR="docs/demos"
VIDEO_FILE="${DEMO_DIR}/${SCENARIO}.mp4"
SPEC_FILE="e2e/demo-${SCENARIO}.spec.ts"

mkdir -p "$DEMO_DIR"

if [ ! -f "apps/web/${SPEC_FILE}" ]; then
  echo "[demo-capture] error: spec not found: apps/web/${SPEC_FILE}"
  exit 1
fi

echo "[demo-capture] scenario: ${SCENARIO}"

echo "[demo-capture] checking 9router host endpoint..."
if curl -fsS "http://127.0.0.1:20128/v1/models" -H "Authorization: Bearer sk_9router" >/dev/null 2>&1; then
  echo "[demo-capture] 9router reachable"
else
  case "$SCENARIO" in
    ai-chat|prompt-queue)
      echo "[demo-capture] error: 9router not reachable on http://127.0.0.1:20128/v1 (required for ${SCENARIO})"
      exit 1
      ;;
    *)
      echo "[demo-capture] warning: 9router not reachable (OK for ${SCENARIO})"
      ;;
  esac
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

# Ensure the demo project directory exists inside the container and seed a few files.
seed_files=$(cat <<'EOF'
mkdir -p /home/agentgrove/.data/demo-project/src
printf '{\n  "name": "demo-project",\n  "version": "1.0.0"\n}\n' > /home/agentgrove/.data/demo-project/package.json
printf '# Demo Project\nThis is a demo project for AgentGrove.\n' > /home/agentgrove/.data/demo-project/README.md
printf 'export const greeting = "Hello, AgentGrove!";\n' > /home/agentgrove/.data/demo-project/src/index.ts
EOF
)
docker compose -f docker/docker-compose.demo.yml exec -T agentgrove-demo sh -c "$seed_files" 2>/dev/null || true

FFMPEG_PID=""
kill_ffmpeg() {
  if [ -n "$FFMPEG_PID" ]; then
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    wait "$FFMPEG_PID" 2>/dev/null || true
  fi
}
trap kill_ffmpeg EXIT

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
  pnpm exec playwright test --config=playwright-demo-capture.config.ts "${SPEC_FILE}"

cd "$REPO"
echo "[demo-capture] video saved to $VIDEO_FILE"
