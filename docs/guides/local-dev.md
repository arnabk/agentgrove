# Local development

## First-time setup

```sh
git clone https://github.com/<org>/agentgrove
cd agentgrove
just setup
```

`just setup` runs cross-platform: installs Rust components, pnpm
dependencies, and Playwright browsers.

## Running the app

```sh
just dev
```

This starts the Rust server on an ephemeral port and the Vite dev server,
then prints the URL with a temporary token.

## Tests

See [running-tests.md](./running-tests.md).

## Without `just`

Every recipe in the `justfile` has a documented equivalent under
`scripts/`. Use `scripts/<name>.sh` on Unix or `scripts/<name>.ps1` on
Windows.

## Rust toolchain notes (macOS)

If you previously installed Rust via Homebrew (`brew install rust`),
that ships an older cargo at `/opt/homebrew/bin/cargo` which will shadow
rustup. AgentGrove pins a newer toolchain in `rust-toolchain.toml` and
some transitive dependencies require Cargo 1.85+.

The bundled scripts under `scripts/` (used by `just start`, `just dev-be`,
etc.) automatically prepend the rustup toolchain to `PATH`, so they work
regardless of brew Rust being installed.

If you run `cargo` directly and hit `feature \`edition2024\` is required`,
either:

- prepend rustup to your shell PATH:
  `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- or remove the brew rust: `brew uninstall rust`.
