# Cross-platform support

Linux, macOS, and Windows are first-class development and runtime targets.

## Rules

1. Never hardcode `/` as a path separator. Use `std::path::PathBuf` /
   `Path::join`.
2. Never assume a POSIX shell exists at runtime. Pre/post scripts resolve a
   shell per OS:
   - Linux/macOS: `$SHELL` or `/bin/sh`
   - Windows: `pwsh` if present, else `powershell`, else `cmd.exe`
   The shell is configurable per project.
3. PTY uses `portable-pty` (ConPTY on Windows, openpty on Unix).
4. File watching uses `notify-rs` (FSEvents, inotify, ReadDirectoryChangesW).
5. Git operations use `gix` (pure Rust, no `git` binary required).
6. Long paths on Windows: docs instruct enabling
   `git config --system core.longpaths true` and Windows long-path policy.
7. Line endings: `.gitattributes` enforces LF for source; `*.bat`, `*.cmd`,
   `*.ps1` keep CRLF.
8. Contributor scripts ship as both `.sh` and `.ps1`. CI never relies on a
   shebang for a portable script.

## CI matrix

- PR: `ubuntu-latest` (fast feedback).
- Nightly: `ubuntu-latest`, `macos-latest`, `windows-latest`.
- Release: full matrix required.

## Distribution

Release binaries via `cargo dist`:

- `x86_64-unknown-linux-gnu`
- `aarch64-apple-darwin`, `x86_64-apple-darwin`
- `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`
