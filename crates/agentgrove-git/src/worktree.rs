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

/// Rename a local branch from `old` to `new` using `git branch -m`.
///
/// This is the metadata side of a worktree rename — the underlying
/// worktree directory keeps its existing path on disk (matches the
/// "rename branch only" policy). Caller must ensure `new` does not
/// already exist; git will refuse otherwise and surface that as
/// [`GitError::NonZero`].
///
/// # Errors
///
/// Returns [`GitError`] when git is missing, the rename collides, or
/// any other non-zero exit from `git branch -m`.
pub async fn rename_branch(
    repo_path: &Path,
    old: &str,
    new: &str,
) -> Result<(), GitError> {
    // `--` is not accepted by `git branch -m`; the two args are
    // positional. We pre-validate the inputs in the calling crate so
    // shell-like values (e.g. starting with `-`) never reach git.
    run_git(&["branch", "-m", old, new], repo_path).await?;
    Ok(())
}

/// Force-delete a local branch with `git branch -D`. Used as the
/// follow-up step when the user removes a worktree AND opts to drop
/// the branch in the same flow. `-D` (rather than `-d`) is required
/// because the branch may be ahead of its base ref.
///
/// # Errors
///
/// Returns [`GitError`] when git is missing or the branch cannot be
/// deleted (e.g. another worktree still has it checked out).
pub async fn delete_branch(repo_path: &Path, branch: &str) -> Result<(), GitError> {
    run_git(&["branch", "-D", branch], repo_path).await?;
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

/// Outcome of a per-file discard, surfaced to the caller so the FE can
/// tell the user what happened (e.g. "restored 2 files, deleted 1
/// untracked file").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscardOutcome {
    /// File was tracked; index + worktree were restored to HEAD.
    Restored,
    /// File was untracked; it was deleted from disk.
    DeletedUntracked,
    /// Path had no changes in either index or worktree — no-op.
    Noop,
}

/// Discard all working-tree changes for `rel_path` (relative to
/// `cwd`), VSCode-style:
///
///   - If `rel_path` is tracked by git: run
///     `git restore --staged --worktree -- <path>` so both the index and
///     working tree drop back to HEAD. Covers modified, staged, and
///     deleted-but-tracked files.
///   - If `rel_path` is untracked: delete the file from disk. Empty
///     parent directories are NOT cleaned (caller can run `git clean`
///     separately if desired).
///   - If `rel_path` has no recorded change: returns `Noop` and does
///     nothing. Idempotent.
///
/// `cwd` must be inside a git working tree (project root or worktree).
/// `rel_path` is treated as a forward-slash-relative path; we pass it
/// straight to git (which is platform-agnostic on path separators).
///
/// # Errors
///
/// Returns [`GitError`] when git is missing, the path cannot be
/// classified, the restore fails, or the untracked-file delete fails.
pub async fn discard_path(cwd: &Path, rel_path: &str) -> Result<DiscardOutcome, GitError> {
    // Reject obviously dangerous inputs up front. `--` separator on
    // every git invocation defends against flags, but we also forbid
    // absolute paths and parent-dir traversal so the caller can't
    // accidentally reset files outside `cwd`.
    if rel_path.is_empty() {
        return Err(GitError::NonZero {
            code: -1,
            stderr: "rel_path must not be empty".into(),
        });
    }
    if rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err(GitError::NonZero {
            code: -1,
            stderr: "rel_path must be repo-relative, not absolute".into(),
        });
    }
    for seg in rel_path.split(['/', '\\']) {
        if seg == ".." {
            return Err(GitError::NonZero {
                code: -1,
                stderr: "rel_path must not contain '..'".into(),
            });
        }
    }

    // Step 1: is this path tracked? `git ls-files --error-unmatch`
    // exits non-zero for untracked paths. We don't distinguish I/O
    // errors from "not tracked" here — git stamps the difference into
    // the exit code (1 = not in index) and we treat anything non-zero
    // as untracked. If git is missing the call below will surface that.
    let tracked = run_git(
        &["ls-files", "--error-unmatch", "--", rel_path],
        cwd,
    )
    .await
    .is_ok();

    if tracked {
        // `git restore` overwrites both staged and worktree copies
        // back to HEAD. `--worktree --staged` is the safest pair to
        // unify modified + staged + deleted cases.
        run_git(
            &["restore", "--source=HEAD", "--staged", "--worktree", "--", rel_path],
            cwd,
        )
        .await?;
        return Ok(DiscardOutcome::Restored);
    }

    // Step 2: untracked. The file may or may not exist on disk — if
    // the user already deleted it manually, treat as a no-op. Resolve
    // through `cwd` so we never touch anything outside the repo.
    let target = cwd.join(rel_path);
    match tokio::fs::metadata(&target).await {
        Ok(meta) if meta.is_file() => {
            tokio::fs::remove_file(&target).await?;
            Ok(DiscardOutcome::DeletedUntracked)
        }
        Ok(meta) if meta.is_dir() => Err(GitError::NonZero {
            code: -1,
            stderr: format!("'{rel_path}' is a directory, refusing to delete"),
        }),
        Ok(_) => Ok(DiscardOutcome::Noop),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DiscardOutcome::Noop),
        Err(e) => Err(GitError::Io(e)),
    }
}
