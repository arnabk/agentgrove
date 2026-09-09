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

/// A local branch with enough metadata for a searchable branch list:
/// last-commit time/subject and upstream tracking.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BranchDetail {
    /// Short branch name.
    pub name: String,
    /// Whether it's the checked-out branch at `cwd`.
    pub current: bool,
    /// ISO 8601 timestamp of the branch tip's commit (author date).
    pub committed_at: Option<String>,
    /// Subject line of the tip commit.
    pub subject: Option<String>,
    /// Upstream ref (e.g. `origin/main`), when the branch tracks one.
    pub upstream: Option<String>,
}

/// List local branches in `cwd` with commit metadata, newest-committed
/// first. Empty vec when not a git repo. One `for-each-ref` call with a
/// unit-separated format so subjects containing spaces parse cleanly.
pub async fn list_detailed(cwd: &Path) -> Vec<BranchDetail> {
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

    // \x1f (unit separator) between fields, \x1e (record separator)
    // between refs — neither appears in branch names or subjects.
    let fmt = "%(refname:short)\x1f%(committerdate:iso-strict)\x1f%(upstream:short)\x1f%(contents:subject)\x1e";
    let out = match Command::new("git")
        .args([
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
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
        .split('\x1e')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let mut f = record.split('\x1f');
            let name = f.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let committed_at = f
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
            let upstream = f
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
            let subject = f
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
            Some(BranchDetail {
                current: !current.is_empty() && name == current,
                name,
                committed_at,
                subject,
                upstream,
            })
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
