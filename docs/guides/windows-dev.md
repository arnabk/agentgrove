# Windows development

AgentGrove is supported on Windows 10 22H2+ and Windows 11.

## Toolchain

- Install Rust via [rustup.rs](https://rustup.rs). Pick the
  `x86_64-pc-windows-msvc` host. Visual Studio Build Tools 2022 with
  "Desktop development with C++" is required for linking.
- Install Node via [nvm-windows](https://github.com/coreybutler/nvm-windows)
  or the Node MSI.
- Install pnpm: `corepack enable pnpm`.
- Install `just`:
  `winget install --id Casey.Just -e` or `cargo install just`.
- Install Git for Windows. Pick "Checkout as-is, commit as-is" to avoid
  CRLF surprises; our `.gitattributes` handles normalization.

## Long paths

Some Rust + Node toolchains generate deep paths. Enable both:

```powershell
git config --global core.longpaths true
# Run as admin:
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
```

## Default shell

AgentGrove auto-detects shell order on Windows: `pwsh` → `powershell` →
`cmd.exe`. Override per-project in the project settings UI.

## ConPTY

`portable-pty` uses ConPTY on Windows. Windows 10 1809+ supports ConPTY; we
require 22H2+ for stability.

## Running commands from these docs

When you see a POSIX command (e.g., `just test-be-e2e`), it works
identically in PowerShell. For the rare cases where a shell-specific helper
is needed, use the PowerShell sibling under `scripts/`:

```powershell
scripts\test-live.ps1
```
