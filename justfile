# AgentGrove tasks. Cross-platform (Linux / macOS / Windows).
# Recipes intentionally avoid OS-specific shell features. Where needed,
# they delegate to scripts/<name>.sh or scripts/<name>.ps1.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# One-time setup: Rust components, FE deps, Playwright browsers, git hooks.
setup:
    rustup component add rustfmt clippy
    pnpm install
    pnpm -C apps/web exec playwright install chromium
    @# Wire git pre-commit hook that blocks edits to applied migrations.
    @# See ADR-0007 for the data-safety rationale.
    git config core.hooksPath scripts/git-hooks

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

# Live end-to-end acceptance of every feature M0 ships.
[unix]
verify:
    @bash {{justfile_directory()}}/scripts/verify.sh

[windows]
verify:
    @pwsh {{justfile_directory()}}/scripts/verify.ps1

# Dev: run only the BE.
[unix]
dev-be:
    @bash {{justfile_directory()}}/scripts/dev-be.sh

[windows]
dev-be:
    @pwsh {{justfile_directory()}}/scripts/dev-be.ps1

# Dev: run only the FE.
dev-fe:
    pnpm -C apps/web dev

# Start the full app (BE + FE) in one command. Cross-platform.
[unix]
start:
    @bash {{justfile_directory()}}/scripts/start.sh

[windows]
start:
    @pwsh {{justfile_directory()}}/scripts/start.ps1

# Start BE + FE with hot reload for development.
[unix]
dev:
    @bash {{justfile_directory()}}/scripts/dev.sh

[windows]
dev:
    @pwsh {{justfile_directory()}}/scripts/dev.ps1

# Run the app in the foreground in this terminal (Ctrl+C stops both
# BE + FE). Same as `just start`; named for the console-vs-service split.
[unix]
console:
    @bash {{justfile_directory()}}/scripts/console.sh

[windows]
console:
    @pwsh {{justfile_directory()}}/scripts/console.ps1

# ── Run as a system service (auto-start on login, restart on crash) ──
# Register AgentGrove with the OS service manager (launchd / systemd /
# Task Scheduler) so it comes back after a reboot and restarts if it
# crashes. Runs natively (no Docker) so it keeps full host access.
[unix]
service-install:
    @bash {{justfile_directory()}}/scripts/service-install.sh

[windows]
service-install:
    @pwsh {{justfile_directory()}}/scripts/service-install.ps1

# Stop and remove the auto-start service (your .data is untouched).
[unix]
service-uninstall:
    @bash {{justfile_directory()}}/scripts/service-uninstall.sh

[windows]
service-uninstall:
    @pwsh {{justfile_directory()}}/scripts/service-uninstall.ps1

# List every DB snapshot in <state_dir>/backups, newest first.
[unix]
backups:
    @bash {{justfile_directory()}}/scripts/db-backups.sh

[windows]
backups:
    @pwsh {{justfile_directory()}}/scripts/db-backups.ps1

# Restore the DB from a snapshot directory. The current DB is
# snapshotted first as `db-<ts>-pre-restore` so a wrong restore can
# itself be undone. Usage: `just restore-db db-20260522-064556`.
[unix]
restore-db SNAPSHOT:
    @bash {{justfile_directory()}}/scripts/db-restore.sh {{SNAPSHOT}}

[windows]
restore-db SNAPSHOT:
    @pwsh {{justfile_directory()}}/scripts/db-restore.ps1 {{SNAPSHOT}}
