#!/usr/bin/env bash
# scripts/demo-record.sh — orchestrate isolated Docker demo recordings.
#
# Usage:
#   bash scripts/demo-record.sh
#
# Steps:
#   1. Ensure 9router is reachable on the host.
#   2. Build + start the demo AgentGrove container on :4320.
#   3. Seed a demo project + chat.
#   4. Run Playwright demo recordings.
#   5. Copy videos to docs/demos.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

DEMO_URL="http://127.0.0.1:4320"
DEMO_BE_URL="http://127.0.0.1:4320"
DEMO_PROJECT="/home/agentgrove/.data/demo-project"

echo "[demo] checking 9router host endpoint..."
if ! curl -fsS "http://127.0.0.1:20128/v1/models" -H "Authorization: Bearer sk_9router" >/dev/null 2>&1; then
  echo "[demo] error: 9router not reachable on http://127.0.0.1:20128/v1"
  exit 1
fi

echo "[demo] building demo image..."
docker compose -f docker/docker-compose.demo.yml build

echo "[demo] starting demo container on :4320..."
docker compose -f docker/docker-compose.demo.yml up -d

# Wait for backend health.
for i in $(seq 1 60); do
  if curl -fsS "${DEMO_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[demo] seeding demo project directory..."
docker compose -f docker/docker-compose.demo.yml exec -T -u agentgrove agentgrove-demo sh -c "mkdir -p ${DEMO_PROJECT}"

echo "[demo] recording videos..."
cd apps/web
AGENTGROVE_BE_URL="${DEMO_BE_URL}" \
AGENTGROVE_DEMO_URL="${DEMO_URL}" \
REPO_ROOT="${DEMO_PROJECT}" \
  pnpm exec playwright test --config=playwright-demo-docker.config.ts

echo "[demo] videos are in docs/demos/"

echo "[demo] stopping demo container..."
cd "${REPO}"
docker compose -f docker/docker-compose.demo.yml down

echo "[demo] done"
