# ADR-0003: Cross-platform support

- Status: Accepted
- Date: 2026-05-18

## Context

Developers contribute on Linux, macOS, and Windows. All three must work
for both running and developing AgentGrove.

## Decision

- Path handling uses `std::path::PathBuf` only; no hardcoded separators.
- PTY uses `portable-pty` (ConPTY on Windows, openpty on Unix).
- File watching uses `notify-rs`.
- Git uses `gix` (pure Rust); no `git` binary requirement at runtime.
- Pre/post scripts pick an OS-appropriate shell with project-level override.
- Contributor scripts ship as both `.sh` and `.ps1`.
- CI: PR runs Linux only for speed; macOS + Windows on nightly and release.

## Consequences

- More test surface (three OSes nightly).
- Slightly more code (script duplication, shell selection).
- True portability without WSL or VM workarounds.
