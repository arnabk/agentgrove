# Security policy

## Reporting

Do not open public issues for security problems.

Email `security@agentgrove.dev` (placeholder; update before public launch).
GPG key will be published before public launch.

We aim to acknowledge within 72 hours and provide a remediation timeline
within 7 days.

## Scope

- The Rust backend binary `agentgrove-server`.
- The built static frontend served by the binary.
- Default configuration shipped with releases.

Out of scope:

- User-installed agent CLIs (Claude, Codex, Kimi, etc.).
- User-provided OS shells for pre/post scripts.

## Defaults

- Bind: `127.0.0.1` only.
- Bearer token required for every endpoint.
- Remote mode requires explicit `--bind` and `--token` flags and prints a
  warning at startup and a banner in the UI.
- Provider API keys are stored in the OS keyring
  ([`keyring`](https://crates.io/crates/keyring) crate), never in the
  database.
