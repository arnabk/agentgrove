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
    let iid = mr.get("iid").or_else(|| mr.get("id"))?.as_u64()?;
    // `mr list` is shallow — it doesn't carry pipeline status, approval
    // state, or mergeability. Without those the FE's "Merge" button
    // (gated on checks == success) never appears for GitLab. Fetch the
    // MR detail so GitLab reaches parity with GitHub. Best-effort: if
    // the detail call fails we still return the basic row.
    let detail = glab_mr_detail(cwd, iid).await;
    Some(PrInfo {
        number: iid,
        title: mr.get("title")?.as_str()?.to_string(),
        state: mr
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("opened")
            .to_lowercase(),
        url: mr.get("web_url")?.as_str()?.to_string(),
        source: "glab".into(),
        review_decision: detail.as_ref().and_then(|d| d.review_decision.clone()),
        checks_status: detail.as_ref().and_then(|d| d.checks_status.clone()),
        mergeable: detail.as_ref().and_then(|d| d.mergeable),
    })
}

/// Pipeline/approval/mergeability distilled from `glab mr view`.
struct GlabMrDetail {
    review_decision: Option<String>,
    checks_status: Option<String>,
    mergeable: Option<bool>,
}

/// Fetch a single MR's detail via `glab mr view <iid> -F json` and map
/// GitLab's fields onto our forge-agnostic shape:
///   - `pipeline.status` → checks_status (success/pending/failure)
///   - `detailed_merge_status` / `merge_status` → mergeable
///   - approvals (`approved` or `approvals_left == 0`) → review_decision
async fn glab_mr_detail(cwd: &Path, iid: u64) -> Option<GlabMrDetail> {
    let out = Command::new("glab")
        .args(["mr", "view", &iid.to_string(), "-F", "json"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mr: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;

    // Pipeline / CI status. GitLab statuses: success, failed, running,
    // pending, canceled, skipped, manual, created. Normalize to our
    // success/pending/failure trio the FE badge understands.
    let checks_status = mr
        .pointer("/pipeline/status")
        .or_else(|| mr.pointer("/head_pipeline/status"))
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "success" | "passed" => "success".to_string(),
            "failed" | "canceled" | "cancelled" => "failure".to_string(),
            _ => "pending".to_string(),
        });

    // Mergeability. `detailed_merge_status == "mergeable"` (newer GitLab)
    // or `merge_status == "can_be_merged"` (older).
    let mergeable = mr
        .get("detailed_merge_status")
        .and_then(|v| v.as_str())
        .map(|s| s == "mergeable")
        .or_else(|| {
            mr.get("merge_status")
                .and_then(|v| v.as_str())
                .map(|s| s == "can_be_merged")
        });

    // Approval state. `glab mr view` exposes `approved` (bool) on many
    // GitLab versions; fall back to `approvals_left == 0`. Map to the
    // same vocabulary GitHub uses so the FE gate + badge are shared.
    let approved = mr.get("approved").and_then(|v| v.as_bool()).or_else(|| {
        mr.get("approvals_left")
            .and_then(|v| v.as_u64())
            .map(|left| left == 0)
    });
    let review_decision = match approved {
        Some(true) => Some("approved".to_string()),
        Some(false) => Some("review_required".to_string()),
        None => None,
    };

    Some(GlabMrDetail {
        review_decision,
        checks_status,
        mergeable,
    })
}

/// One open pull/merge request, for the aggregate "PR center" list.
/// Richer than [`PrInfo`] (carries author, branch, timestamps, draft)
/// so the FE can render + sort a cross-project queue.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PrListItem {
    /// PR/MR number (GitHub `number`, GitLab `iid`).
    pub number: u64,
    /// Title.
    pub title: String,
    /// Lifecycle state, lowercased ("open"/"opened").
    pub state: String,
    /// Web URL.
    pub url: String,
    /// Providing CLI ("gh" or "glab").
    pub source: String,
    /// Head/source branch.
    pub branch: String,
    /// Author login/username, when known.
    pub author: Option<String>,
    /// Whether it's a draft/WIP.
    pub draft: bool,
    /// ISO 8601 creation timestamp, when known (for age).
    pub created_at: Option<String>,
    /// CI checks rollup: "success"/"pending"/"failure"/null.
    pub checks_status: Option<String>,
    /// Review decision: "approved"/"changes_requested"/"review_required"/null.
    pub review_decision: Option<String>,
}

/// List all **open** PRs/MRs for the repo at `cwd`, forge-agnostic.
/// Tries `gh` then `glab`; returns an empty vec when no CLI is
/// available or the repo isn't hosted on a supported forge (so the
/// aggregate view degrades gracefully rather than erroring).
pub async fn list_open_prs(cwd: &Path) -> Vec<PrListItem> {
    if let Some(list) = list_gh(cwd).await {
        return list;
    }
    if let Some(list) = list_glab(cwd).await {
        return list;
    }
    Vec::new()
}

async fn list_gh(cwd: &Path) -> Option<Vec<PrListItem>> {
    let out = Command::new("gh")
        .args([
            "pr",
            "list",
            "--state",
            "open",
            "--json",
            "number,title,state,url,headRefName,author,isDraft,createdAt,reviewDecision,statusCheckRollup",
            "--limit",
            "100",
        ])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let prs: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    Some(
        prs.into_iter()
            .filter_map(|pr| {
                let review_decision = pr
                    .get("reviewDecision")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_lowercase());
                let checks_status = pr
                    .get("statusCheckRollup")
                    .and_then(|v| v.as_array())
                    .map(|c| rollup_status(c));
                Some(PrListItem {
                    number: pr.get("number")?.as_u64()?,
                    title: pr.get("title")?.as_str()?.to_string(),
                    state: pr
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("open")
                        .to_lowercase(),
                    url: pr.get("url")?.as_str()?.to_string(),
                    source: "gh".into(),
                    branch: pr
                        .get("headRefName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    author: pr
                        .get("author")
                        .and_then(|a| a.get("login"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    draft: pr.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
                    created_at: pr
                        .get("createdAt")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    checks_status,
                    review_decision,
                })
            })
            .collect(),
    )
}

/// Reduce a GitHub `statusCheckRollup` array to a single status.
fn rollup_status(checks: &[serde_json::Value]) -> String {
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
}

async fn list_glab(cwd: &Path) -> Option<Vec<PrListItem>> {
    let out = Command::new("glab")
        .args(["mr", "list", "-F", "json"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mrs: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    Some(
        mrs.into_iter()
            .filter_map(|mr| {
                Some(PrListItem {
                    number: mr.get("iid").or_else(|| mr.get("id"))?.as_u64()?,
                    title: mr.get("title")?.as_str()?.to_string(),
                    state: mr
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("opened")
                        .to_lowercase(),
                    url: mr.get("web_url")?.as_str()?.to_string(),
                    source: "glab".into(),
                    branch: mr
                        .get("source_branch")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    author: mr
                        .get("author")
                        .and_then(|a| a.get("username"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    draft: mr
                        .get("draft")
                        .or_else(|| mr.get("work_in_progress"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    created_at: mr
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    checks_status: None,
                    review_decision: None,
                })
            })
            .collect(),
    )
}

/// Read the current branch name from a git worktree's HEAD.
/// Returns `None` if the directory isn't a git repo or HEAD is detached.
pub async fn get_current_branch(cwd: &Path) -> Option<String> {
    let head = cmd(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if head.is_empty() || head == "HEAD" {
        return None;
    }
    Some(head)
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

/// Run a forge CLI merge invocation once, returning the trimmed
/// stderr on failure. Separated out so `merge_pr` can attempt a
/// graceful fallback (auto-merge -> direct merge) without duplicating
/// the spawn/diagnostics plumbing.
async fn run_merge(cmd_name: &str, args: &[String], cwd: &Path) -> Result<(), String> {
    let out = Command::new(cmd_name)
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("failed to run {cmd_name}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{cmd_name} exited with {}", out.status)
    } else {
        stderr
    })
}

/// Merge a PR/MR via the forge CLI. Returns Ok(()) on success or an
/// error message on failure.
///
/// For GitHub we first try `--auto` (queue the merge so protected
/// branches with required checks merge themselves once green). Many
/// repos, however, do NOT have the "Allow auto-merge" setting enabled
/// — there `gh pr merge --auto` fails outright with a message like
/// "Auto-merge is not allowed for this repository". In that case we
/// retry immediately without `--auto`, which performs a normal merge
/// when the PR is already mergeable. Every attempt is logged so a
/// failed merge can be diagnosed from the server log instead of only
/// surfacing as a transient FE toast.
pub async fn merge_pr(cwd: &Path, pr_number: u64, source: &str) -> Result<(), String> {
    match source {
        "gh" => {
            let n = pr_number.to_string();
            let auto_args: Vec<String> = vec![
                "pr".into(),
                "merge".into(),
                n.clone(),
                "--merge".into(),
                "--auto".into(),
                "--delete-branch".into(),
            ];
            tracing::info!(pr = pr_number, "merge_pr: attempting gh auto-merge");
            match run_merge("gh", &auto_args, cwd).await {
                Ok(()) => Ok(()),
                Err(e) if auto_merge_unsupported(&e) => {
                    tracing::warn!(
                        pr = pr_number,
                        error = %e,
                        "merge_pr: auto-merge unavailable, retrying direct merge"
                    );
                    let direct_args: Vec<String> = vec![
                        "pr".into(),
                        "merge".into(),
                        n,
                        "--merge".into(),
                        "--delete-branch".into(),
                    ];
                    run_merge("gh", &direct_args, cwd).await.map_err(|e2| {
                        tracing::error!(pr = pr_number, error = %e2, "merge_pr: direct merge failed");
                        e2
                    })
                }
                Err(e) => {
                    tracing::error!(pr = pr_number, error = %e, "merge_pr: gh auto-merge failed");
                    Err(e)
                }
            }
        }
        "glab" => {
            let args: Vec<String> = vec![
                "mr".into(),
                "merge".into(),
                pr_number.to_string(),
                "--yes".into(),
                "--remove-source-branch".into(),
            ];
            tracing::info!(pr = pr_number, "merge_pr: attempting glab merge");
            run_merge("glab", &args, cwd).await.map_err(|e| {
                tracing::error!(pr = pr_number, error = %e, "merge_pr: glab merge failed");
                e
            })
        }
        other => Err(format!("unsupported forge CLI: {other}")),
    }
}

/// Heuristic: does this `gh pr merge --auto` error mean the repo
/// simply doesn't permit auto-merge (so a direct merge might still
/// work), rather than the PR being un-mergeable? GitHub's wording has
/// varied over versions, so match the stable substrings.
fn auto_merge_unsupported(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("auto-merge is not allowed")
        || s.contains("auto-merge is not enabled")
        || (s.contains("auto") && s.contains("not") && s.contains("allow"))
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
