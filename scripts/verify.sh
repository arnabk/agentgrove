#!/usr/bin/env bash
# verify.sh — end-to-end acceptance of every shipped feature.
#
# Boots the full stack twice (auth-disabled default + auth-enabled), asserts
# every feature, tears everything down, prints a green/red summary.

set +u  # arrays + bash 3 on macOS are unfriendly to `set -u`

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Toolchain PATH.
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
  [ -n "${BE2_PID:-}" ] && kill "$BE2_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill "$FE_PID" 2>/dev/null || true
  sleep 1
  [ -n "${BE_PID:-}" ] && kill -9 "$BE_PID" 2>/dev/null || true
  [ -n "${BE2_PID:-}" ] && kill -9 "$BE2_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill -9 "$FE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

BE_PORT="$(free_port)"
BE2_PORT="$(free_port)"
FE_PORT="$(free_port)"

rm -rf "$REPO/.data"
mkdir -p "$LOG_DIR"
BE_LOG="$LOG_DIR/verify-backend.log"
BE2_LOG="$LOG_DIR/verify-backend-auth.log"
FE_LOG="$LOG_DIR/verify-frontend.log"

echo "[verify] backend (no-auth) port = $BE_PORT, backend (auth) port = $BE2_PORT, frontend port = $FE_PORT"

# ---- build backend -------------------------------------------------------
echo "[verify] building backend"
if ! cargo build -p agentgrove-server >"$BE_LOG.build" 2>&1; then
  echo "BUILD FAILED"; tail -40 "$BE_LOG.build"; exit 1
fi

# ---- launch backend in default (auth-disabled) mode ---------------------
echo "[verify] launching backend (auth disabled)"
AGENTGROVE_PORT="$BE_PORT" ./target/debug/agentgrove >"$BE_LOG" 2>&1 &
BE_PID=$!
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$BE_PORT/health" >/dev/null 2>&1 && break
  kill -0 "$BE_PID" 2>/dev/null || { echo "backend exited"; tail -40 "$BE_LOG"; exit 1; }
  sleep 1
done

# ---- launch backend in auth-enabled mode --------------------------------
AUTH_TOKEN="test-token-$$-$RANDOM"
echo "[verify] launching backend (auth enabled)"
AGENTGROVE_PORT="$BE2_PORT" AGENTGROVE_TOKEN="$AUTH_TOKEN" AGENTGROVE_STATE_DIR="$REPO/.data/auth" \
  ./target/debug/agentgrove >"$BE2_LOG" 2>&1 &
BE2_PID=$!
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$BE2_PORT/health" >/dev/null 2>&1 && break
  kill -0 "$BE2_PID" 2>/dev/null || { echo "backend (auth) exited"; tail -40 "$BE2_LOG"; exit 1; }
  sleep 1
done

# ---- launch frontend -----------------------------------------------------
echo "[verify] launching frontend"
pnpm -C apps/web exec vite --port "$FE_PORT" --strictPort >"$FE_LOG" 2>&1 &
FE_PID=$!
for i in $(seq 1 40); do
  curl -fsS "http://localhost:$FE_PORT" >/dev/null 2>&1 && break
  kill -0 "$FE_PID" 2>/dev/null || { echo "frontend exited"; tail -40 "$FE_LOG"; exit 1; }
  sleep 1
done
echo "[verify] frontend ready"

# ---- BE assertions (no-auth default) ------------------------------------
check "01: BE printed listening URL" bash -c "grep -q 'agentgrove listening on' '$BE_LOG'"
check "02: BE printed state dir"     bash -c "grep -q '^state dir: ' '$BE_LOG'"
check "03: BE prints 'auth disabled' by default" bash -c "grep -q 'auth: disabled' '$BE_LOG'"
check "04: .data created"            test -d "$REPO/.data"

HEALTH_CODE="$(curl -s -o /tmp/ag-health.json -w '%{http_code}' "http://127.0.0.1:$BE_PORT/health")"
HEALTH_BODY="$(cat /tmp/ag-health.json)"
check "05: /health -> 200"           test "$HEALTH_CODE" = 200
check "06: /health status=ok"        bash -c "echo '$HEALTH_BODY' | grep -q '\"status\":\"ok\"'"
check "07: /health version present"  bash -c "echo '$HEALTH_BODY' | grep -q '\"version\"'"

# Without a token configured, /whoami should answer 200 with no auth header.
CODE_NOAUTH_OPEN="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BE_PORT/whoami")"
check "08: /whoami open when auth disabled -> 200" test "$CODE_NOAUTH_OPEN" = 200

# Same against the auth-enabled instance: now 401 expected.
CODE_NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BE2_PORT/whoami")"
CODE_BAD="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "http://127.0.0.1:$BE2_PORT/whoami")"
WHOAMI_BODY="$(curl -s -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:$BE2_PORT/whoami")"
check "09: /whoami no-auth -> 401 when token set" test "$CODE_NOAUTH" = 401
check "10: /whoami bad-token -> 401"              test "$CODE_BAD" = 401
check "11: /whoami good-token -> body=authenticated" test "$WHOAMI_BODY" = "authenticated"

# ---- FE assertions -------------------------------------------------------
INDEX="$(curl -fsS "http://localhost:$FE_PORT")"
check "12: FE serves index.html"     bash -c "[[ '$INDEX' == *'<div id=\"root\">'* ]]"
check "13: FE loads main.tsx"        bash -c "[[ '$INDEX' == *'/src/main.tsx'* ]]"
check "14: FE serves Tailwind on body" bash -c "[[ '$INDEX' == *'bg-bg'* ]]"

# ---- Browser assertions (Playwright) -------------------------------------
echo "[verify] running browser checks"
BASE_URL="http://localhost:$FE_PORT" PW_LIVE=1 \
  AGENTGROVE_BE_URL="http://127.0.0.1:$BE_PORT" \
  REPO_ROOT="$REPO" \
  pnpm -C apps/web exec playwright test e2e/verify-live.spec.ts --reporter=line >"$LOG_DIR/verify-playwright.log" 2>&1
PW_EXIT=$?
check "15: Full UI flow (panes + features)" test "$PW_EXIT" = 0

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
  echo "--- backend log (no-auth, tail) ---"; tail -30 "$BE_LOG"
  echo "--- backend log (auth, tail) ---"; tail -30 "$BE2_LOG"
  echo "--- frontend log (tail) ---"; tail -30 "$FE_LOG"
  echo "--- playwright log (tail) ---"; tail -50 "$LOG_DIR/verify-playwright.log" 2>/dev/null || true
  exit 1
fi
