# Contributing to AgentGrove

Thanks for helping. AgentGrove is TDD-first and cross-platform. Please read
this whole page before opening a PR.

## Prerequisites

- Rust, installed via [rustup](https://rustup.rs) (Linux, macOS, and Windows).
  The exact version is pinned in [`rust-toolchain.toml`](../rust-toolchain.toml);
  rustup downloads and uses it automatically the first time you run `cargo`
  in this repo, on every platform — you do **not** install a specific version
  by hand. See the note below if you hit a `failed to parse manifest` error.
- Node 20+ (24 recommended). We recommend [nvm](https://github.com/nvm-sh/nvm)
  on Unix or [nvm-windows](https://github.com/coreybutler/nvm-windows).
- pnpm 9+ (`corepack enable pnpm`).
- `just` task runner: `cargo install just`, `winget install --id Casey.Just`
  (Windows), `brew install just` (macOS), or
  [other installers](https://github.com/casey/just#installation).
- Git 2.40+.

Optional but recommended:

- `cargo-llvm-cov`, `cargo-mutants`, `cargo-audit`, `cargo-deny`.

### Use the rustup-managed toolchain (all platforms)

This repo pins its Rust toolchain in `rust-toolchain.toml`, and some
dependencies require a recent edition (rustc ≥ 1.85). rustup honours that
pin automatically — **as long as the `cargo`/`rustc` on your `PATH` are the
rustup shims**, not a separate, older install.

If a non-rustup Rust is ahead of rustup on your `PATH`, the build fails with
something like:

```
error: failed to download `hashbrown vX.Y.Z`
Caused by: failed to parse manifest ... (edition 2024 / rust-version ...)
```

That older toolchain can't read a newer crate manifest. This is not
platform-specific — it happens with a distro package on Linux (`apt`/`dnf`
`cargo`), a standalone installer on Windows, or Homebrew's `cargo` on macOS
shadowing rustup. Fix it the same way everywhere:

1. Check which toolchain you're actually using:

   ```sh
   cargo --version
   rustc --version
   rustup show        # shows the pinned/active toolchain
   ```

2. Make sure rustup's shim directory comes first on `PATH`:
   - Linux/macOS: `~/.cargo/bin` should precede any other Rust dir (e.g.
     `/opt/homebrew/bin`, `/usr/bin`). Adjust your shell rc accordingly.
   - Windows: `%USERPROFILE%\.cargo\bin` should precede other Rust entries.

3. Or invoke the pinned toolchain explicitly without touching `PATH`:

   ```sh
   rustup run "$(rustup show active-toolchain | cut -d' ' -f1)" cargo build
   ```

   (Equivalent to `cargo +<pinned-version> build`.)

Prefer installing Rust **only** via rustup so this can't happen.

## Setup

```sh
git clone https://github.com/<org>/agentgrove
cd agentgrove
just setup
```

`just setup` installs Rust components, pnpm dependencies, and Playwright
browsers, on Linux/macOS/Windows alike.

## Daily commands

| Task              | Command                  |
| ----------------- | ------------------------ |
| Format            | `just fmt`               |
| Lint              | `just lint`              |
| Unit tests        | `just test-unit`         |
| Component tests   | `just test-component`    |
| BE endpoint E2E   | `just test-be-e2e`       |
| FE E2E (Playwright) | `just test-fe-e2e`     |
| Full live run     | `just test-live`         |
| Everything        | `just check`             |

Windows users without `just` can use the PowerShell scripts under
`scripts/` directly.

## Tests are mandatory

**Every PR must add or update both unit tests and integration tests for
the change.** This is a hard requirement enforced by review. PRs without
both will be sent back.

### What counts as a unit test

- **Backend**: a `#[test]` / `#[tokio::test]` inside the crate under
  test, exercising a single function or small module in isolation. Lives
  next to the source (`#[cfg(test)] mod tests`) or under `crates/<crate>/tests/`
  for component-level tests against the real public API.
- **Frontend**: a Vitest test under `apps/web/tests/` or co-located as
  `*.test.tsx`, exercising a single component or pure function. Use
  `@solidjs/testing-library` for component-level assertions.

### What counts as an integration test

- **Backend**: an L4 endpoint test in `crates/agentgrove-api/tests/e2e/`
  that boots the real Axum router via `BeHarness::start()` and hits the
  HTTP route end-to-end (status code, headers, JSON body). Multi-route
  flows (create a project → create a chat under it → list it back) are
  ideal.
- **Frontend**: a Playwright spec under `apps/web/e2e/` driving the live
  app against a running backend, asserting user-visible behavior.
- **Cross-cutting**: when a change touches more than one crate, an
  integration test should exercise the seam (e.g. `chats` route +
  `worktrees` repo + `agents` event).

### Coverage expectations

- Lines ≥ 85%, branches ≥ 80% per
  [docs/testing/strategy.md](./testing/strategy.md).
- Every public function or route gets at least one happy-path test and
  one error-path test.
- Every bug fix gets a regression test that fails on `main` and passes
  on the branch (the CI "red-proof" job verifies this).

### Route inventory

When you add or remove an HTTP route, update both
`crates/agentgrove-api/tests/e2e/route_inventory.rs` and
`crates/agentgrove-api/tests/e2e/coverage.txt`. The route-inventory test
fails the build if they drift.

## TDD

See [docs/testing/tdd-policy.md](./testing/tdd-policy.md). Short version:
write the failing test first, then the code. CI runs
`scripts/check-tdd.sh` on every PR to verify the test-line count grew.

## Coding standards

- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. No `unwrap` in
  non-test code without justification comment.
- TypeScript: `eslint` + `prettier`. Strict TS (`tsc --noEmit` is a gate).
- Conventional Commits. DCO sign-off required: `git commit -s`.
- No native browser dialogs (`window.confirm`, `alert`, `prompt`) — use
  the themed `confirm` / `alert` from `apps/web/src/components/dialog.tsx`.
- Cross-platform paths: `std::path::PathBuf`, never hardcode separators.

## Adding a feature

1. Open an issue describing the behavior.
2. **Write the failing tests first** — unit (covering the new function
   or component) and integration (covering the user-visible flow). They
   must fail on `main`.
3. Implement the smallest change that makes them pass.
4. Add more tests as edge cases surface.
5. Update docs under `docs/`.
6. Open a PR. Fill the template **including the Tests section**. Ensure
   all checks pass.

## Adding a route

Checklist:

1. **Add a failing L4 endpoint test first** in
   `crates/agentgrove-api/tests/e2e/`. Cover at least: happy path,
   missing/invalid input → 400, missing resource → 404.
2. Implement the handler.
3. Add the route to the router and to both `route_inventory.rs` +
   `coverage.txt`.
4. Add a unit test for any non-trivial helper the handler calls.
5. If user-visible: add a Playwright spec under `apps/web/e2e/`.
6. Update OpenAPI annotations (when we generate clients, this matters).

## Adding an agent provider

1. Record a sample stream with `cargo run -p agentgrove-agents --bin record`.
2. Commit fixture under `tests/fixtures/agents/<provider>/`.
3. **Write parser unit tests against fixtures** (cover every event
   shape: token, tool-call, tool-result, done, error).
4. Implement `AgentProvider` trait.
5. **Add an integration test** using `FakeProvider` scripted from the
   fixture that exercises chat → prompt → streamed events.

## Windows notes

See [docs/guides/windows-dev.md](./guides/windows-dev.md). Enable long paths
and pick a default shell (`pwsh` recommended).

## Reporting bugs

Open an issue with reproduction steps. **Bug-fix PRs must include a
regression test** that fails on `main` and passes on the branch.

## Security

Do not file security issues publicly. See
[docs/SECURITY.md](./SECURITY.md).

## Code of Conduct

By participating you agree to the
[Contributor Covenant](./CODE_OF_CONDUCT.md).
