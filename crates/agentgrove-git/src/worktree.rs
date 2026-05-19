//! Worktree mutations via the `git` binary.

use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::process::Command;

/// Errors from worktree operations.
#[derive(Debug, Error)]
pub enum GitError {
    /// `git` binary not found on `PATH`.
    #[error("git binary not found on PATH")]
    GitNotFound,
    /// `git` returned a non-zero exit code.
    #[error("git command failed (exit={code}): {stderr}")]
    NonZero {
        /// Exit code reported by git.
        code: i32,
        /// stderr captured from git.
        stderr: String,
    },
    /// I/O error invoking git.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn git_path() -> Result<PathBuf, GitError> {
    which::which("git").map_err(|_| GitError::GitNotFound)
}

async fn run_git(args: &[&str], cwd: &Path) -> Result<String, GitError> {
    let git = git_path()?;
    let output = Command::new(git)
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await?;
    if !output.status.success() {
        return Err(GitError::NonZero {
            code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Initialize a new git repository at `path`. Creates a default branch
/// (`main`) and an initial empty commit so subsequent worktree-add
/// operations have a valid base ref.
///
/// # Errors
///
/// Returns [`GitError`] if `git` is missing, I/O fails, or git returns
/// non-zero.
pub async fn init_repo(path: &Path) -> Result<(), GitError> {
    std::fs::create_dir_all(path)?;
    run_git(&["init", "-b", "main"], path).await?;
    run_git(&["config", "user.email", "agentgrove@local"], path).await?;
    run_git(&["config", "user.name", "agentgrove"], path).await?;
    run_git(&["commit", "--allow-empty", "-m", "init"], path).await?;
    Ok(())
}

/// Create a new worktree at `worktree_path` rooted in `repo_path`, on a
/// new branch `branch` based on `base_ref`.
///
/// # Errors
///
/// Returns [`GitError`] if git is missing, I/O fails, or git returns
/// non-zero (e.g. invalid base ref, path already exists).
pub async fn add_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
    base_ref: &str,
) -> Result<(), GitError> {
    let wt_str = worktree_path.to_string_lossy().into_owned();
    run_git(
        &["worktree", "add", "-b", branch, &wt_str, base_ref],
        repo_path,
    )
    .await?;
    Ok(())
}

/// Remove a worktree at `worktree_path`. `--force` lets us drop trees
/// with uncommitted changes (caller's responsibility to confirm).
///
/// # Errors
///
/// Returns [`GitError`] if git is missing or returns non-zero.
pub async fn remove_worktree(repo_path: &Path, worktree_path: &Path) -> Result<(), GitError> {
    let wt_str = worktree_path.to_string_lossy().into_owned();
    run_git(&["worktree", "remove", "--force", &wt_str], repo_path).await?;
    Ok(())
}

/// List worktrees in machine-readable porcelain v1 form, returning the
/// raw output. Caller parses.
///
/// # Errors
///
/// Returns [`GitError`] if git is missing or returns non-zero.
pub async fn list_worktrees(repo_path: &Path) -> Result<String, GitError> {
    run_git(&["worktree", "list", "--porcelain"], repo_path).await
}
