#!/usr/bin/env bash
# verify.sh — end-to-end acceptance of every feature M0 claims to ship.
#
# Boots the full stack on ephemeral ports, asserts every feature, tears
# everything down, prints a green/red summary, exits non-zero on failure.

set +u  # arrays + bash 3 on macOS are unfriendly to `set -u`

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Toolchain PATH (rustup wins over brew rust).
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
[ -d "/opt/homebrew/opt/rustup/bin" ] && PATH="/opt/homebrew/opt/rustup/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for v in v24.6.0 v22.11.0 v20.10.0; do
    [ -x "$HOME/.nvm/versions/node/$v/bin/node" ] && PATH="$HOME/.nvm/versions/node/$v/bin:$PATH" && break
  done
fi
export PATH

LOG_DIR="$REPO/.data/logs"

PASS=()
FAIL=()
check() {
  local name="$1"; shift
  if "$@"; then PASS+=("$name"); else FAIL+=("$name"); fi
}

cleanup() {
  trap '' INT TERM EXIT
  [ -n "${BE_PID:-}" ] && kill "$BE_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill "$FE_PID" 2>/dev/null || true
  sleep 1
  [ -n "${BE_PID:-}" ] && kill -9 "$BE_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill -9 "$FE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Pick a free TCP port.
free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

BE_PORT="$(free_port)"
FE_PORT="$(free_port)"

# Clean prior state and logs.
rm -rf "$REPO/.data"
mkdir -p "$LOG_DIR"
BE_LOG="$LOG_DIR/verify-backend.log"
FE_LOG="$LOG_DIR/verify-frontend.log"

echo "[verify] backend port = $BE_PORT, frontend port = $FE_PORT"

# ---- build + launch backend ---------------------------------------------
echo "[verify] building backend"
if ! cargo build -p agentgrove-server >"$BE_LOG.build" 2>&1; then
  echo "BUILD FAILED"; tail -40 "$BE_LOG.build"; exit 1
fi

echo "[verify] launching backend"
AGENTGROVE_PORT="$BE_PORT" ./target/debug/agentgrove >"$BE_LOG" 2>&1 &
BE_PID=$!

BE_OK=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$BE_PORT/health" >/dev/null 2>&1; then BE_OK=1; break; fi
  kill -0 "$BE_PID" 2>/dev/null || { echo "backend exited"; tail -40 "$BE_LOG"; exit 1; }
  sleep 1
done
[ "$BE_OK" = 1 ] || { echo "backend never became ready"; tail -40 "$BE_LOG"; exit 1; }

TOKEN="$(grep -oE '^token: .*' "$BE_LOG" | head -1 | awk '{print $2}')"
echo "[verify] backend ready, token=$TOKEN"

# ---- launch frontend -----------------------------------------------------
echo "[verify] launching frontend"
pnpm -C apps/web exec vite --port "$FE_PORT" --strictPort >"$FE_LOG" 2>&1 &
FE_PID=$!

FE_OK=0
for i in $(seq 1 40); do
  if curl -fsS "http://localhost:$FE_PORT" >/dev/null 2>&1; then FE_OK=1; break; fi
  kill -0 "$FE_PID" 2>/dev/null || { echo "frontend exited"; tail -40 "$FE_LOG"; exit 1; }
  sleep 1
done
[ "$FE_OK" = 1 ] || { echo "frontend never became ready"; tail -40 "$FE_LOG"; exit 1; }
echo "[verify] frontend ready"

# ---- BE assertions -------------------------------------------------------
check "01: BE printed listening URL" bash -c "grep -q 'agentgrove listening on' '$BE_LOG'"
check "02: BE printed state dir"     bash -c "grep -q '^state dir: ' '$BE_LOG'"
check "03: BE printed token"         bash -c "grep -q '^token: ' '$BE_LOG'"
check "04: .data created"            test -d "$REPO/.data"

HEALTH_CODE="$(curl -s -o /tmp/ag-health.json -w '%{http_code}' "http://127.0.0.1:$BE_PORT/health")"
HEALTH_BODY="$(cat /tmp/ag-health.json)"
check "05: /health -> 200"           test "$HEALTH_CODE" = 200
check "06: /health status=ok"        bash -c "echo '$HEALTH_BODY' | grep -q '\"status\":\"ok\"'"
check "07: /health version present"  bash -c "echo '$HEALTH_BODY' | grep -q '\"version\"'"

CODE_NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BE_PORT/whoami")"
CODE_BAD="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "http://127.0.0.1:$BE_PORT/whoami")"
WHOAMI_BODY="$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$BE_PORT/whoami")"
check "08: /whoami no-auth -> 401"   test "$CODE_NOAUTH" = 401
check "09: /whoami bad-token -> 401" test "$CODE_BAD" = 401
check "10: /whoami good-token -> body=authenticated" test "$WHOAMI_BODY" = "authenticated"

# ---- FE assertions -------------------------------------------------------
INDEX="$(curl -fsS "http://localhost:$FE_PORT")"
check "11: FE serves index.html"     bash -c "[[ '$INDEX' == *'<div id=\"root\">'* ]]"
check "12: FE loads main.tsx"        bash -c "[[ '$INDEX' == *'/src/main.tsx'* ]]"
check "13: FE serves Tailwind on body" bash -c "[[ '$INDEX' == *'bg-bg'* ]]"

# ---- Browser assertions (Playwright) -------------------------------------
echo "[verify] running browser checks"
BASE_URL="http://localhost:$FE_PORT" PW_LIVE=1 \
  pnpm -C apps/web exec playwright test e2e/verify-live.spec.ts --reporter=line >"$LOG_DIR/verify-playwright.log" 2>&1
PW_EXIT=$?
check "14: Solid app renders + theme toggle + Tailwind applies" test "$PW_EXIT" = 0

# ---- summary -------------------------------------------------------------
echo
echo "================ VERIFY RESULTS ================"
for p in "${PASS[@]}"; do printf "  \033[32mPASS\033[0m  %s\n" "$p"; done
for f in "${FAIL[@]}"; do printf "  \033[31mFAIL\033[0m  %s\n" "$f"; done
echo "================================================"
echo "passed: ${#PASS[@]}, failed: ${#FAIL[@]}"
echo "logs:   $LOG_DIR"
if [ "${#FAIL[@]}" -ne 0 ]; then
  echo
  echo "--- backend log (tail) ---"; tail -30 "$BE_LOG"
  echo "--- frontend log (tail) ---"; tail -30 "$FE_LOG"
  echo "--- playwright log (tail) ---"; tail -50 "$LOG_DIR/verify-playwright.log" 2>/dev/null || true
  exit 1
fi
