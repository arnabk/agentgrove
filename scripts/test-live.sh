#!/usr/bin/env bash
# test-live.sh — full-stack live run.
#   1. build release binary
#   2. build FE
#   3. run BE endpoint E2E
#   4. run FE E2E (Playwright)
#
# Usage: scripts/test-live.sh

set -euo pipefail

cargo build --release -p agentgrove-server
pnpm -C apps/web build
cargo test -p agentgrove-api --test e2e
pnpm -C apps/web test:e2e
