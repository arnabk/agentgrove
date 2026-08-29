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

## Ways to run

There are three, from most interactive to most hands-off:

| Command | What it does | When |
| --- | --- | --- |
| `just dev` | BE + FE with **hot reload** (cargo-watch + Vite HMR) | Hacking on AgentGrove |
| `just start` / `just console` | Foreground BE (:4317) + FE (:5173), Ctrl+C stops both | A quick, stable run |
| `just service-install` | Registers an OS service that **auto-starts on login and restarts on crash** | Daily use / a machine you reboot |

`just console` (`scripts/console.sh`) is a thin, clearly-named wrapper
around `start.sh`. Both `start` and `console` set `AGENTGROVE_PORT=4317`
so the frontend can always find the backend (see the port gotcha below).

## Running as a service (auto-start on login, restart on crash)

If you keep losing the app after a reboot, install it as a native OS
service — no Docker, so it keeps full access to git, the filesystem,
PTYs, and your agent CLIs:

```sh
just service-install     # macOS launchd · Linux systemd --user · Windows Task Scheduler
just service-uninstall   # stop + remove (your .data is untouched)
```

Under the hood the service runs `scripts/service-run.sh`, which frees any
stale port from a previous instance and then execs `start.sh`. It is
registered to start at login and to restart on crash.

Platform notes and gotchas:

- **macOS + external volume.** launchd cannot open a job's
  `StandardOutPath` / `StandardErrorPath` on a non-boot external volume
  (a repo under `/Volumes/...`); it fails the job with `EX_CONFIG` (78)
  before your program runs. The installer therefore writes the
  supervisor log to `~/Library/Logs/agentgrove.service.*.log`, while the
  app's own logs stay in `.data/logs/{backend,frontend}.log`.
- **Backend port defaults to random.** The server defaults
  `AGENTGROVE_PORT` to `0` (an ephemeral port) when unset. Always launch
  via `just dev` / `just start` / `just console` / the service — all set
  `AGENTGROVE_PORT=4317`. If you run `./target/debug/agentgrove` bare, it
  binds a random port and the frontend can't reach it, so the app looks
  empty even though your data is fine.
- **Inspect the service.**
  - macOS: `launchctl print gui/$(id -u)/com.agentgrove.app | grep -E 'state|runs'`
  - Linux: `systemctl --user status agentgrove.service` · `journalctl --user -u agentgrove.service -f`

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
