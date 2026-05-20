//! Local branch enumeration + checkout/switch helpers.

use crate::worktree::GitError;
use std::path::Path;
use tokio::process::Command;

/// One local branch as reported by `git for-each-ref`.
#[derive(Debug, Clone)]
pub struct BranchInfo {
    /// Short name (e.g. `main`, `feature/foo`).
    pub name: String,
    /// Whether this is the branch currently checked out at `cwd`.
    pub current: bool,
}

/// List local branches in `cwd`. Returns an empty vec when not a git repo
/// or git is unavailable.
pub async fn list_local(cwd: &Path) -> Vec<BranchInfo> {
    // Current branch first — empty when detached.
    let current = match Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s == "HEAD" {
                String::new()
            } else {
                s
            }
        }
        _ => String::new(),
    };

    let out = match Command::new("git")
        .args([
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads/",
        ])
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|name| BranchInfo {
            name: name.to_string(),
            current: !current.is_empty() && name == current,
        })
        .collect()
}

/// Switch `cwd` to `branch`. When `create` is true, creates the branch
/// off HEAD with `git switch -c`. Refuses uncommitted changes by relying
/// on git's own safety (returns non-zero with stderr forwarded).
pub async fn switch_branch(cwd: &Path, branch: &str, create: bool) -> Result<(), GitError> {
    let mut args: Vec<&str> = vec!["switch"];
    if create {
        args.push("-c");
    }
    args.push(branch);
    let out = Command::new("git")
        .args(&args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(GitError::Io)?;
    if !out.status.success() {
        return Err(GitError::NonZero {
            code: out.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::init_repo;
    use tempfile::tempdir;

    #[tokio::test]
    async fn lists_initial_branch_as_current() {
        let d = tempdir().unwrap();
        init_repo(d.path()).await.unwrap();
        let branches = list_local(d.path()).await;
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current);
    }

    #[tokio::test]
    async fn switch_creates_then_switches() {
        let d = tempdir().unwrap();
        init_repo(d.path()).await.unwrap();
        switch_branch(d.path(), "feature/x", true).await.unwrap();
        let branches = list_local(d.path()).await;
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"feature/x"));
        let current = branches.iter().find(|b| b.current).unwrap();
        assert_eq!(current.name, "feature/x");

        // Switch back to main (no -c)
        switch_branch(d.path(), "main", false).await.unwrap();
        let branches = list_local(d.path()).await;
        let current = branches.iter().find(|b| b.current).unwrap();
        assert_eq!(current.name, "main");
    }

    #[tokio::test]
    async fn switch_to_unknown_branch_errors() {
        let d = tempdir().unwrap();
        init_repo(d.path()).await.unwrap();
        let err = switch_branch(d.path(), "nope", false).await.unwrap_err();
        match err {
            GitError::NonZero { .. } => {}
            other => panic!("expected NonZero, got {other:?}"),
        }
    }
}
