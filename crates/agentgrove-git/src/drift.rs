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

/// Information about how much the branch has drifted from its tracking remote.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DriftInfo {
    /// Number of commits the local branch is behind the remote.
    pub behind: u32,
    /// Number of commits the local branch is ahead of the remote.
    pub ahead: u32,
    /// Name of the remote tracking branch, e.g. "origin/main", if any.
    pub tracking: Option<String>,
    /// Whether the local branch has diverged from the remote tracking branch.
    pub diverged: bool,
}

/// `base_ref` is the branch the worktree was created from (e.g. "dev",
/// "main"). Used as a fallback when the actual HEAD branch has no
/// upstream tracking ref configured.
pub async fn check_drift_quick(cwd: &Path, _branch: &str, base_ref: &str) -> DriftInfo {
    let mut info = DriftInfo::default();

    // Use the ACTUAL HEAD branch, not the stored worktree record name
    // (the user may have switched/renamed branches inside the worktree).
    let head = match cmd(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Some(s) if !s.is_empty() && s != "HEAD" => s,
        _ => return info,
    };
    let local_sha = match cmd(cwd, &["rev-parse", "HEAD"]).await {
        Some(s) => s,
        None => return info,
    };

    // Try the configured upstream first; fall back to origin/<base_ref>.
    let tracking = cmd(
        cwd,
        &["rev-parse", "--abbrev-ref", &format!("{head}@{{upstream}}")],
    )
    .await
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| format!("origin/{base_ref}"));
    info.tracking = Some(tracking.clone());

    let remote = tracking.split('/').next().unwrap_or("origin");
    let ref_to_check = tracking.split_once('/').map(|x| x.1).unwrap_or(base_ref);
    let remote_sha = match cmd(cwd, &["ls-remote", "--heads", remote, ref_to_check]).await {
        Some(line) => line.split_whitespace().next().unwrap_or("").to_string(),
        None => return info,
    };
    info.diverged = !remote_sha.is_empty() && remote_sha != local_sha;
    info
}

/// Performs a full drift check (including fetching remote and listing PRs).
pub async fn check_drift_full(cwd: &Path, _branch: &str, base_ref: &str) -> DriftInfo {
    let mut info = DriftInfo::default();
    let _ = Command::new("git")
        .args(["fetch", "origin", "--prune", "--quiet"])
        .current_dir(cwd)
        .output()
        .await;
    let head = match cmd(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Some(s) if !s.is_empty() && s != "HEAD" => s,
        _ => return info,
    };
    let tracking = cmd(
        cwd,
        &["rev-parse", "--abbrev-ref", &format!("{head}@{{upstream}}")],
    )
    .await
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| format!("origin/{base_ref}"));
    info.tracking = Some(tracking.clone());
    if let Some(s) = cmd(cwd, &["rev-list", "--count", &format!("HEAD..{tracking}")]).await {
        info.behind = s.parse().unwrap_or(0);
    }
    if let Some(s) = cmd(cwd, &["rev-list", "--count", &format!("{tracking}..HEAD")]).await {
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

// ---- PR / MR status (forge-agnostic) ------------------------------------

/// A pull/merge request associated with a branch.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PrInfo {
    /// PR number.
    pub number: u64,
    /// PR title.
    pub title: String,
    /// e.g. "open", "merged", "closed".
    pub state: String,
    /// URL to the PR.
    pub url: String,
    /// Which forge CLI provided this ("gh", "glab", …).
    pub source: String,
    /// Review decision: "approved", "changes_requested", "review_required", or null.
    pub review_decision: Option<String>,
    /// CI checks rollup: "success", "pending", "failure", or null.
    pub checks_status: Option<String>,
    /// Whether the PR is mergeable (no conflicts, checks pass, approved).
    pub mergeable: Option<bool>,
}

/// Detect an open PR/MR for `branch` by trying each available forge
/// CLI in order. First success wins; if none are installed or the repo
/// isn't hosted on a supported forge, returns `None` gracefully.
///
/// Currently supported:
///   - `gh` (GitHub CLI) — `gh pr list --head <branch> --json …`
///   - `glab` (GitLab CLI) — `glab mr list --source-branch <branch> -F json`
///
/// Each CLI handles its own authentication (OAuth token, SSH key, etc.)
/// so we don't need API keys or tokens in our config.
pub async fn check_pr(cwd: &Path, branch: &str) -> Option<PrInfo> {
    // Try GitHub CLI first (most common).
    if let Some(pr) = try_gh(cwd, branch).await {
        return Some(pr);
    }
    // Try GitLab CLI.
    if let Some(pr) = try_glab(cwd, branch).await {
        return Some(pr);
    }
    // No forge CLI available or no PR found.
    None
}

async fn try_gh(cwd: &Path, branch: &str) -> Option<PrInfo> {
    let out = Command::new("gh")
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--json",
            "number,title,state,url,reviewDecision,statusCheckRollup,mergeable",
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
    let prs: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    let pr = prs.into_iter().next()?;
    let review_decision = pr
        .get("reviewDecision")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase());
    let checks_status = pr
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .map(|checks| {
            if checks.iter().any(|c| {
                c.get("conclusion")
                    .and_then(|v| v.as_str())
                    .map(|s| s == "FAILURE" || s == "ERROR")
                    .unwrap_or(false)
            }) {
                "failure".to_string()
            } else if checks
                .iter()
                .any(|c| c.get("conclusion").and_then(|v| v.as_str()).is_none())
            {
                "pending".to_string()
            } else {
                "success".to_string()
            }
        });
    let mergeable = pr
        .get("mergeable")
        .and_then(|v| v.as_str())
        .map(|s| s == "MERGEABLE");
    Some(PrInfo {
        number: pr.get("number")?.as_u64()?,
        title: pr.get("title")?.as_str()?.to_string(),
        state: pr
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("open")
            .to_lowercase(),
        url: pr.get("url")?.as_str()?.to_string(),
        source: "gh".into(),
        review_decision,
        checks_status,
        mergeable,
    })
}

async fn try_glab(cwd: &Path, branch: &str) -> Option<PrInfo> {
    let out = Command::new("glab")
        .args(["mr", "list", "--source-branch", branch, "-F", "json"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mrs: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    let mr = mrs.into_iter().next()?;
    Some(PrInfo {
        number: mr.get("iid").or_else(|| mr.get("id"))?.as_u64()?,
        title: mr.get("title")?.as_str()?.to_string(),
        state: mr
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("opened")
            .to_lowercase(),
        url: mr.get("web_url")?.as_str()?.to_string(),
        source: "glab".into(),
        review_decision: None,
        checks_status: None,
        mergeable: None,
    })
}

// ---- Forge detection + CLI suggestion -----------------------------------

/// Detected forge and whether the matching CLI is installed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeInfo {
    /// e.g. "github", "gitlab", "bitbucket", "unknown".
    pub forge: String,
    /// The CLI that would provide PR/MR info (e.g. "gh", "glab").
    pub cli: Option<String>,
    /// Whether that CLI is currently installed on this machine.
    pub cli_installed: bool,
    /// Human-readable install hint if the CLI is missing.
    pub install_hint: Option<String>,
}

/// Detect which forge hosts the repo (from `git remote get-url origin`)
/// and check whether the matching CLI is installed.
pub async fn detect_forge(cwd: &Path) -> ForgeInfo {
    let url = cmd(cwd, &["remote", "get-url", "origin"])
        .await
        .unwrap_or_default();
    let (forge, cli, hint) = if url.contains("github.com") {
        (
            "github",
            "gh",
            "Install GitHub CLI: https://cli.github.com — enables PR status badges.",
        )
    } else if url.contains("gitlab.com") || url.contains("gitlab") {
        (
            "gitlab",
            "glab",
            "Install GitLab CLI: https://gitlab.com/gitlab-org/cli — enables MR status badges.",
        )
    } else if url.contains("bitbucket.org") || url.contains("bitbucket") {
        (
            "bitbucket",
            "bb", // Bitbucket doesn't have an official CLI; placeholder.
            "No official Bitbucket CLI is available for PR status.",
        )
    } else {
        return ForgeInfo {
            forge: "unknown".into(),
            cli: None,
            cli_installed: false,
            install_hint: None,
        };
    };
    let installed = Command::new(cli)
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    ForgeInfo {
        forge: forge.into(),
        cli: Some(cli.into()),
        cli_installed: installed,
        install_hint: if installed { None } else { Some(hint.into()) },
    }
}

/// Merge a PR/MR via the forge CLI. Returns Ok(()) on success or an
/// error message on failure.
pub async fn merge_pr(cwd: &Path, pr_number: u64, source: &str) -> Result<(), String> {
    let (cmd_name, args): (&str, Vec<String>) = match source {
        "gh" => (
            "gh",
            vec![
                "pr".into(),
                "merge".into(),
                pr_number.to_string(),
                "--merge".into(),
                "--delete-branch".into(),
            ],
        ),
        "glab" => (
            "glab",
            vec![
                "mr".into(),
                "merge".into(),
                pr_number.to_string(),
                "--yes".into(),
                "--remove-source-branch".into(),
            ],
        ),
        other => return Err(format!("unsupported forge CLI: {other}")),
    };
    let out = Command::new(cmd_name)
        .args(&args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("failed to run {cmd_name}: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{cmd_name} exited with {}", out.status)
        } else {
            stderr
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn quick_drift_on_non_git_dir() {
        let d = tempfile::tempdir().unwrap();
        let info = check_drift_quick(d.path(), "main", "main").await;
        assert!(!info.diverged);
        assert_eq!(info.behind, 0);
    }
}
