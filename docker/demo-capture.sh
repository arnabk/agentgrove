#!/usr/bin/env bash
# docker/demo-capture.sh — record a demo video inside the AgentGrove demo container.
# Called via docker compose exec from scripts/demo-capture.sh on the host.
#
# ffmpeg is started only after Playwright signals that the page is visible, so
# the recording begins with a real frame instead of a black screen.

set -eu

SCENARIO="${1:-ai-chat}"
DEMO_URL="http://127.0.0.1:4317"
DEMO_PROJECT="/home/agentgrove/.data/demo-project"
DEMO_DIR="/home/agentgrove/demos"
VIDEO_FILE="${DEMO_DIR}/${SCENARIO}.mp4"
SPEC_FILE="e2e/demo-${SCENARIO}.spec.ts"
MARKER_FILE="/tmp/demo-recording-marker"
SIGNAL_FILE="/tmp/demo-recording-signal"
MUSIC_FILE="/home/agentgrove/assets/music.mp3"
MUSIC_URL="https://assets.mixkit.co/music/623/623.mp3"

export DEMO_RECORDING_MARKER="$MARKER_FILE"
export DEMO_RECORDING_SIGNAL="$SIGNAL_FILE"

echo "[in-container] scenario: ${SCENARIO}"

mkdir -p "$DEMO_DIR"
rm -f "$MARKER_FILE" "$SIGNAL_FILE"

# Download royalty-free background music once.
# Track: Deep Urban by Eugenio Mininni (Mixkit Free License).
if [ ! -f "$MUSIC_FILE" ]; then
  echo "[in-container] downloading background music..."
  mkdir -p "$(dirname "$MUSIC_FILE")"
  curl -fsSL -o "$MUSIC_FILE" "$MUSIC_URL"
fi

if [ ! -f "/home/agentgrove/apps/web/${SPEC_FILE}" ]; then
  echo "[in-container] error: spec not found: /home/agentgrove/apps/web/${SPEC_FILE}"
  exit 1
fi

# Seed a small demo project so file search and terminal demos have content.
mkdir -p "${DEMO_PROJECT}/src"
printf '{\n  "name": "demo-project",\n  "version": "1.0.0"\n}\n' > "${DEMO_PROJECT}/package.json"
printf '# Demo Project\nThis is a demo project for AgentGrove.\n' > "${DEMO_PROJECT}/README.md"
printf 'export const greeting = "Hello, AgentGrove!";\n' > "${DEMO_PROJECT}/src/index.ts"

# Initialize as a git repo with a local bare origin so worktree demos work.
if [ ! -d "${DEMO_PROJECT}/.git" ]; then
  BARE_ORIGIN="/home/agentgrove/.data/demo-origin.git"
  git -C "${DEMO_PROJECT}" init -b main
  git -C "${DEMO_PROJECT}" config user.email "demo@agentgrove.local"
  git -C "${DEMO_PROJECT}" config user.name "Demo User"
  git -C "${DEMO_PROJECT}" add .
  git -C "${DEMO_PROJECT}" commit -m "initial commit"
  git init --bare "${BARE_ORIGIN}"
  git -C "${DEMO_PROJECT}" remote add origin "${BARE_ORIGIN}"
  git -C "${DEMO_PROJECT}" push -u origin main
fi

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
  ai-chat|prompt-queue|overview)
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
PW_PID=""
cleanup() {
  if [ -n "$FFMPEG_PID" ]; then
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    wait "$FFMPEG_PID" 2>/dev/null || true
  fi
  if [ -n "$PW_PID" ]; then
    kill -INT "$PW_PID" 2>/dev/null || true
    wait "$PW_PID" 2>/dev/null || true
  fi
  kill -9 "$XVFB_PID" 2>/dev/null || true
  rm -f "$MARKER_FILE" "$SIGNAL_FILE"
}
trap cleanup EXIT

# Start Playwright in the background. It will create the marker file once the
# page is visible.
echo "[in-container] warming up Playwright demo..."
cd /home/agentgrove/apps/web
AGENTGROVE_BE_URL="${DEMO_URL}" \
AGENTGROVE_DEMO_URL="${DEMO_URL}" \
REPO_ROOT="${DEMO_PROJECT}" \
DISPLAY=:99 \
  pnpm exec playwright test --config=playwright-demo-docker-capture.config.ts "${SPEC_FILE}" &
PW_PID=$!

# Wait for the page to be visible before starting the recorder.
echo "[in-container] waiting for visible page marker..."
for i in $(seq 1 60); do
  if [ -f "$MARKER_FILE" ]; then
    break
  fi
  sleep 0.2
done
[ -f "$MARKER_FILE" ] || { echo "[in-container] marker not created; aborting"; exit 1; }

# Start screen capture now that the browser is showing content.
echo "[in-container] starting screen capture..."
rm -f "$VIDEO_FILE"
ffmpeg -y -f x11grab -draw_mouse 1 -framerate 30 -video_size 1440x900 -i :99.0+0,0 -pix_fmt yuv420p -movflags +faststart "$VIDEO_FILE" &
FFMPEG_PID=$!
sleep 1

# Tell Playwright to continue with the demo actions.
echo "[in-container] recording demo actions..."
touch "$SIGNAL_FILE"
wait "$PW_PID"

# Stop screen capture gracefully and wait for it to finalize the file.
echo "[in-container] stopping screen capture..."
if [ -n "$FFMPEG_PID" ]; then
  kill -INT "$FFMPEG_PID" 2>/dev/null || true
  wait "$FFMPEG_PID" 2>/dev/null || true
fi

# Mix in subtle background music (trimmed to video length, faded out).
if [ -f "$MUSIC_FILE" ]; then
  echo "[in-container] mixing background music..."
  DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_FILE")
  FADE_START=$(awk -v dur="$DURATION" 'BEGIN {print (dur > 3) ? dur - 2 : 0}')
  TMP_MIX="${VIDEO_FILE}.mixed.mp4"
  ffmpeg -y -i "$VIDEO_FILE" -i "$MUSIC_FILE" \
    -filter_complex "[1:a]volume=-12dB,afade=t=out:st=${FADE_START}:d=2,atrim=0:${DURATION}[a]" \
    -map 0:v -map "[a]" -c:v copy -movflags +faststart "$TMP_MIX" \
    && mv "$TMP_MIX" "$VIDEO_FILE"
fi

echo "[in-container] video saved to $VIDEO_FILE"
