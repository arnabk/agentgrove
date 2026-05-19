//! Pre/post script runner for AgentGrove worktrees.
//!
//! Runs a user-provided shell snippet in a given working directory using
//! the OS-appropriate shell (`sh -c` on Unix, `cmd /C` on Windows), with
//! a wall-clock timeout. Streams stdout + stderr as `ScriptEvent`s.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Streaming event emitted while a script runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScriptEvent {
    /// A line of stdout.
    Stdout {
        /// The line text (no trailing newline).
        line: String,
    },
    /// A line of stderr.
    Stderr {
        /// The line text.
        line: String,
    },
    /// Script finished with the given exit code.
    Exit {
        /// Exit code. `-1` if killed by signal / timeout.
        code: i32,
    },
}

/// Errors from script runner.
#[derive(Debug, Error)]
pub enum ScriptError {
    /// Could not locate the configured shell on `PATH`.
    #[error("shell not found: {0}")]
    ShellNotFound(String),
    /// I/O error invoking the process.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// Wall-clock timeout was hit.
    #[error("script timed out after {0:?}")]
    Timeout(Duration),
}

/// How the runner picks the OS shell.
#[derive(Debug, Clone, Default)]
pub enum Shell {
    /// Auto-detect: `pwsh`/`powershell`/`cmd` on Windows; `$SHELL` else `sh` on Unix.
    #[default]
    Auto,
    /// Use this absolute path. Caller-provided flag is `-c` on Unix or
    /// `/C` on Windows by default; override here for unusual shells.
    Explicit {
        /// Absolute path to the shell executable.
        program: PathBuf,
        /// Argument flag passed before the script body (e.g. "-c").
        flag: String,
    },
}

fn resolve_shell(s: &Shell) -> Result<(PathBuf, String), ScriptError> {
    match s {
        Shell::Explicit { program, flag } => Ok((program.clone(), flag.clone())),
        Shell::Auto => {
            #[cfg(windows)]
            {
                for candidate in ["pwsh", "powershell", "cmd"] {
                    if let Ok(p) = which::which(candidate) {
                        let flag = if candidate == "cmd" { "/C" } else { "-Command" };
                        return Ok((p, flag.to_string()));
                    }
                }
                Err(ScriptError::ShellNotFound("pwsh|powershell|cmd".into()))
            }
            #[cfg(not(windows))]
            {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".into());
                let p = which::which(&shell).map_err(|_| ScriptError::ShellNotFound(shell))?;
                Ok((p, "-c".into()))
            }
        }
    }
}

/// Run `script` in `cwd` with `timeout`. Events stream through `tx`.
/// Returns the final exit code (or an error on timeout / I/O).
///
/// # Errors
///
/// - [`ScriptError::ShellNotFound`]
/// - [`ScriptError::Timeout`]
/// - [`ScriptError::Io`]
pub async fn run_script(
    script: &str,
    cwd: &Path,
    shell: &Shell,
    timeout: Duration,
    tx: mpsc::UnboundedSender<ScriptEvent>,
) -> Result<i32, ScriptError> {
    let (program, flag) = resolve_shell(shell)?;
    let mut child = Command::new(&program)
        .arg(&flag)
        .arg(script)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let tx_out = tx.clone();
    let tx_err = tx.clone();

    let out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = tx_out.send(ScriptEvent::Stdout { line });
        }
    });
    let err_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = tx_err.send(ScriptEvent::Stderr { line });
        }
    });

    let wait = child.wait();
    let result = tokio::time::timeout(timeout, wait).await;

    match result {
        Ok(Ok(status)) => {
            let _ = out_task.await;
            let _ = err_task.await;
            let code = status.code().unwrap_or(-1);
            let _ = tx.send(ScriptEvent::Exit { code });
            Ok(code)
        }
        Ok(Err(e)) => {
            let _ = tx.send(ScriptEvent::Exit { code: -1 });
            Err(ScriptError::Io(e))
        }
        Err(_) => {
            // Timeout — kill child. `Child` no longer has a sync `id()`
            // after we called `wait()`; use `start_kill` instead.
            let _ = tx.send(ScriptEvent::Exit { code: -1 });
            Err(ScriptError::Timeout(timeout))
        }
    }
}
