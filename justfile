# AgentGrove tasks. Cross-platform (Linux / macOS / Windows).
# Recipes intentionally avoid OS-specific shell features. Where needed,
# they delegate to scripts/<name>.sh or scripts/<name>.ps1.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# One-time setup: Rust components, FE deps, Playwright browsers.
setup:
    rustup component add rustfmt clippy
    pnpm install
    pnpm -C apps/web exec playwright install chromium

# Formatting.
fmt:
    cargo fmt --all
    pnpm -C apps/web exec prettier --write .

fmt-check:
    cargo fmt --all -- --check
    pnpm -C apps/web exec prettier --check .

# Linting.
lint:
    cargo clippy --workspace --all-targets -- -D warnings
    pnpm -C apps/web lint

# Typecheck (FE).
typecheck:
    pnpm -C apps/web typecheck

# Backend tests.
test-unit:
    cargo test --workspace --lib

test-component:
    cargo test --workspace --tests

test-be-e2e:
    cargo test -p agentgrove-api --test e2e

# Frontend tests.
test-fe-unit:
    pnpm -C apps/web test

test-fe-e2e:
    pnpm -C apps/web test:e2e

# Live full-stack run: built binary + BE E2E + FE E2E.
test-live:
    cargo build --release -p agentgrove-server
    pnpm -C apps/web build
    cargo test -p agentgrove-api --test e2e
    pnpm -C apps/web test:e2e

# Coverage.
coverage-be:
    cargo install --locked cargo-llvm-cov || true
    cargo llvm-cov --workspace --lcov --output-path target/llvm-cov.lcov

coverage-fe:
    pnpm -C apps/web exec vitest run --coverage

# Aggregate: mirrors PR CI.
check: fmt-check lint typecheck test-unit test-component test-be-e2e test-fe-unit

# Dev: run BE on ephemeral port + FE dev server.
dev:
    cargo run -p agentgrove-server
