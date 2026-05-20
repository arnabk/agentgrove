//! Read-only repository inspection.
//!
//! Currently shells out to the `git` binary for two pieces of metadata:
//!   * Is this path a git repository?
//!   * Does it have at least one remote configured?
//!
//! These are surfaced to the UI so worktree affordances are only offered
//! when meaningful.

use std::path::Path;
use tokio::process::Command;

/// What we know about a folder from a git perspective.
#[derive(Debug, Clone, Default)]
pub struct RepoInfo {
    /// The path is inside a git repository (or is its root).
    pub is_git: bool,
    /// At least one remote is configured.
    pub has_remote: bool,
    /// The current branch name, when discoverable.
    pub current_branch: Option<String>,
    /// List of remote names.
    pub remotes: Vec<String>,
}

/// Inspect a folder and report git metadata. Never errors — missing
/// repos / missing `git` binary yield `RepoInfo::default()`.
pub async fn inspect_repo(path: &Path) -> RepoInfo {
    let mut info = RepoInfo::default();

    // Is there a `.git` directory or file at this path? Cheap check first.
    let inside = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(path)
        .output()
        .await;
    match inside {
        Ok(out) if out.status.success() => {
            info.is_git = String::from_utf8_lossy(&out.stdout).trim() == "true";
        }
        _ => return info,
    }

    if !info.is_git {
        return info;
    }

    // Remotes.
    if let Ok(out) = Command::new("git")
        .args(["remote"])
        .current_dir(path)
        .output()
        .await
    {
        if out.status.success() {
            let listing = String::from_utf8_lossy(&out.stdout);
            info.remotes = listing
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect();
            info.has_remote = !info.remotes.is_empty();
        }
    }

    // Current branch.
    if let Ok(out) = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .await
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && s != "HEAD" {
                info.current_branch = Some(s);
            }
        }
    }

    info
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::init_repo;
    use tempfile::tempdir;

    #[tokio::test]
    async fn plain_folder_is_not_git() {
        let d = tempdir().unwrap();
        let info = inspect_repo(d.path()).await;
        assert!(!info.is_git);
        assert!(!info.has_remote);
    }

    #[tokio::test]
    async fn fresh_repo_has_no_remote() {
        let d = tempdir().unwrap();
        init_repo(d.path()).await.unwrap();
        let info = inspect_repo(d.path()).await;
        assert!(info.is_git);
        assert!(!info.has_remote);
        assert_eq!(info.current_branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn repo_with_remote_reports_it() {
        let d = tempdir().unwrap();
        init_repo(d.path()).await.unwrap();
        // Add a fake remote.
        let _ = tokio::process::Command::new("git")
            .args(["remote", "add", "origin", "https://example.com/x.git"])
            .current_dir(d.path())
            .output()
            .await
            .unwrap();
        let info = inspect_repo(d.path()).await;
        assert!(info.is_git);
        assert!(info.has_remote);
        assert_eq!(info.remotes, vec!["origin".to_string()]);
    }
}
