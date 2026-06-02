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

## Rust toolchain notes (Linux, macOS, Windows)

AgentGrove pins its Rust toolchain in `rust-toolchain.toml`, and some
transitive dependencies require a recent edition (Cargo/rustc 1.85+).
[rustup](https://rustup.rs) reads that pin and uses the right version
automatically on every platform — **provided the `cargo`/`rustc` on your
`PATH` are rustup's shims** and not a separate, older Rust install.

A non-rustup toolchain ahead of rustup on `PATH` will shadow the pin and
the build fails with `feature \`edition2024\` is required` or
`failed to parse manifest ...`. This is not OS-specific; common culprits:

- **Linux** — a distro package (`apt install cargo` / `dnf install cargo`)
  at `/usr/bin/cargo`.
- **macOS** — Homebrew Rust (`brew install rust`) at `/opt/homebrew/bin/cargo`.
- **Windows** — a standalone Rust installer instead of `rustup`.

The bundled scripts under `scripts/` (used by `just start`, `just dev-be`,
`scripts/verify.sh`, etc.) already prepend the rustup toolchain to `PATH`,
so they work regardless of which other Rust is installed.

If you run `cargo` directly and hit the error, do any one of:

- **Recommended:** install Rust only via rustup and remove the other one
  (`brew uninstall rust`, `apt remove cargo`, uninstall the standalone
  Windows package), so rustup is the only Rust on `PATH`.
- Put rustup's shim dir first on `PATH`:
  - Linux/macOS: `export PATH="$HOME/.cargo/bin:$PATH"` (ahead of
    `/usr/bin`, `/opt/homebrew/bin`, …).
  - Windows (PowerShell): ensure `%USERPROFILE%\.cargo\bin` precedes other
    Rust entries in your `Path`.
- Or invoke the pinned toolchain explicitly without changing `PATH`:
  `rustup run "$(rustup show active-toolchain | cut -d' ' -f1)" cargo build`
  (equivalent to `cargo +<pinned-version> build`).
