//! Remote drift detection — pure `git`, no forge assumptions.
//!
//! Works with GitHub, GitLab, Bitbucket, self-hosted — any remote.
//!
//! Two modes:
//!   - **`check_drift_quick`**: `git ls-remote` to compare remote HEAD
//!     with local. Cheap (no object download), good for frequent poll.
//!   - **`check_drift_full`**: `git fetch` + `rev-list --count` for
//!     exact ahead/behind. Called on-demand (e.g. user clicks badge).

use std::path::Path;
use tokio::process::Command;

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DriftInfo {
    pub behind: u32,
    pub ahead: u32,
    pub tracking: Option<String>,
    pub diverged: bool,
}

pub async fn check_drift_quick(cwd: &Path, branch: &str) -> DriftInfo {
    let mut info = DriftInfo::default();
    let local_sha = match cmd(cwd, &["rev-parse", branch]).await {
        Some(s) => s,
        None => return info,
    };
    let tracking = match cmd(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    )
    .await
    {
        Some(s) if !s.is_empty() => s,
        _ => return info,
    };
    info.tracking = Some(tracking.clone());
    let remote = tracking.split('/').next().unwrap_or("origin");
    let remote_sha = match cmd(cwd, &["ls-remote", "--heads", remote, branch]).await {
        Some(line) => line.split_whitespace().next().unwrap_or("").to_string(),
        None => return info,
    };
    info.diverged = !remote_sha.is_empty() && remote_sha != local_sha;
    info
}

pub async fn check_drift_full(cwd: &Path, branch: &str) -> DriftInfo {
    let mut info = DriftInfo::default();
    let _ = Command::new("git")
        .args(["fetch", "origin", "--prune", "--quiet"])
        .current_dir(cwd)
        .output()
        .await;
    let tracking = match cmd(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    )
    .await
    {
        Some(s) if !s.is_empty() => s,
        _ => return info,
    };
    info.tracking = Some(tracking.clone());
    if let Some(s) = cmd(
        cwd,
        &["rev-list", "--count", &format!("{branch}..{tracking}")],
    )
    .await
    {
        info.behind = s.parse().unwrap_or(0);
    }
    if let Some(s) = cmd(
        cwd,
        &["rev-list", "--count", &format!("{tracking}..{branch}")],
    )
    .await
    {
        info.ahead = s.parse().unwrap_or(0);
    }
    info.diverged = info.behind > 0 || info.ahead > 0;
    info
}

async fn cmd(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn quick_drift_on_non_git_dir() {
        let d = tempfile::tempdir().unwrap();
        let info = check_drift_quick(d.path(), "main").await;
        assert!(!info.diverged);
        assert_eq!(info.behind, 0);
    }
}
