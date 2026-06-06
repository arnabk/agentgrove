//! Remote drift detection + PR status.
//!
//! `check_drift` fetches from origin and counts how many commits the
//! local branch is ahead/behind the remote tracking branch.
//!
//! `check_pr` calls the `gh` CLI (GitHub CLI) to see if a pull request
//! is open for the given branch. Silently returns `None` if `gh` is not
//! installed or the project isn't hosted on GitHub.

use std::path::Path;
use tokio::process::Command;

/// Drift between a local branch and its remote tracking branch.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DriftInfo {
    pub behind: u32,
    pub ahead: u32,
    pub tracking: Option<String>,
}

/// A GitHub pull request associated with a branch.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or `null`.
    pub review_decision: Option<String>,
}

/// Fetch from origin (best-effort, silent on failure) then count how
/// many commits `branch` is ahead/behind its remote tracking ref.
pub async fn check_drift(cwd: &Path, branch: &str) -> DriftInfo {
    let mut info = DriftInfo::default();

    // Best-effort fetch — may fail (no network, no remote, etc.).
    let _ = Command::new("git")
        .args(["fetch", "origin", "--prune", "--quiet"])
        .current_dir(cwd)
        .output()
        .await;

    // Find the tracking branch (e.g. origin/feature-x).
    let tracking = match Command::new("git")
        .args([
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ])
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                return info;
            }
            s
        }
        _ => return info,
    };
    info.tracking = Some(tracking.clone());

    // Commits behind: local..remote
    if let Ok(out) = Command::new("git")
        .args(["rev-list", "--count", &format!("{branch}..{tracking}")])
        .current_dir(cwd)
        .output()
        .await
    {
        if out.status.success() {
            info.behind = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .unwrap_or(0);
        }
    }

    // Commits ahead: remote..local
    if let Ok(out) = Command::new("git")
        .args(["rev-list", "--count", &format!("{tracking}..{branch}")])
        .current_dir(cwd)
        .output()
        .await
    {
        if out.status.success() {
            info.ahead = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .unwrap_or(0);
        }
    }

    info
}

/// Check if a GitHub PR exists for `branch` using the `gh` CLI.
/// Returns `None` if `gh` is not installed, the repo isn't on GitHub,
/// or no PR is open for that branch.
pub async fn check_pr(cwd: &Path, branch: &str) -> Option<PrInfo> {
    let out = Command::new("gh")
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--json",
            "number,title,state,url,reviewDecision",
            "--limit",
            "1",
        ])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;

    if !out.status.success() {
        return None;
    }

    let parsed: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    let pr = parsed.into_iter().next()?;

    Some(PrInfo {
        number: pr.get("number")?.as_u64()?,
        title: pr.get("title")?.as_str()?.to_string(),
        state: pr
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_string(),
        url: pr.get("url")?.as_str()?.to_string(),
        review_decision: pr
            .get("reviewDecision")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}
