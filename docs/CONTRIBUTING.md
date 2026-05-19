# Contributing to AgentGrove

Thanks for helping. AgentGrove is TDD-first and cross-platform. Please read
this whole page before opening a PR.

## Prerequisites

- Rust stable (1.83+). Install via [rustup](https://rustup.rs).
- Node 20+ (24 recommended). We recommend [nvm](https://github.com/nvm-sh/nvm)
  on Unix or [nvm-windows](https://github.com/coreybutler/nvm-windows).
- pnpm 9+ (`corepack enable pnpm`).
- `just` task runner: `brew install just`, `cargo install just`, or
  [other installers](https://github.com/casey/just#installation).
- Git 2.40+.

Optional but recommended:

- `cargo-llvm-cov`, `cargo-mutants`, `cargo-audit`, `cargo-deny`.

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

## TDD

See [docs/testing/tdd-policy.md](./testing/tdd-policy.md). Short version:
write the failing test first, then the code.

## Coding standards

- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. No `unwrap` in
  non-test code without justification comment.
- TypeScript: `eslint` + `prettier`. Strict TS (`tsc --noEmit` is a gate).
- Conventional Commits. DCO sign-off required: `git commit -s`.

## Adding a feature

1. Open an issue describing the behavior.
2. Add a failing L4 BE endpoint test or L5 Playwright test that captures
   the user-visible behavior.
3. Add unit / component tests as you implement.
4. Update docs under `docs/`.
5. Open a PR. Fill the template. Ensure all checks pass.

## Adding a route

Checklist:

1. Write L4 endpoint test in `crates/agentgrove-api/tests/e2e/`.
2. Add route to OpenAPI annotations and the router.
3. Regenerate OpenAPI: `just gen-openapi`. Commit the diff.
4. FE typed client regenerates automatically via `just gen`.
5. Write L5 Playwright spec for the user-visible flow.

## Adding an agent provider

1. Record a sample stream with `cargo run -p agentgrove-agents --bin record`.
2. Commit fixture under `tests/fixtures/agents/<provider>/`.
3. Write parser tests against fixtures.
4. Implement `AgentProvider` trait.
5. Add an E2E flow using `FakeProvider` scripted from the fixture.

## Windows notes

See [docs/guides/windows-dev.md](./guides/windows-dev.md). Enable long paths
and pick a default shell (`pwsh` recommended).

## Reporting bugs

Open an issue with reproduction steps. Bug-fix PRs must include a
regression test.

## Security

Do not file security issues publicly. See
[docs/SECURITY.md](./SECURITY.md).

## Code of Conduct

By participating you agree to the
[Contributor Covenant](./CODE_OF_CONDUCT.md).
