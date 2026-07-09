//! Health probe + version check.

use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

use crate::state::AppState;

/// Body returned by `/health`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Health {
    /// Static literal `"ok"` when the server has started.
    pub status: &'static str,
    /// Crate version (matches binary).
    pub version: &'static str,
}

/// Health handler. Always returns `200 OK` once Axum is serving requests.
pub async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// GitHub release metadata we care about.
#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
}

/// Body returned by `/api/version`.
#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    /// Version baked into this binary.
    pub current: String,
    /// Latest release tag from GitHub, if reachable.
    pub latest: Option<String>,
    /// Link to the latest release page, if reachable.
    pub html_url: Option<String>,
    /// `true` when `latest` differs from `current`.
    pub update_available: bool,
}

const VERSION_TTL: Duration = Duration::from_secs(300);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Return the current version and whether a newer GitHub release exists.
///
/// The result is cached for 5 minutes so the FE can poll without
/// hammering GitHub. Network failures are non-fatal: the endpoint
/// still returns `200` with `latest: null`.
pub async fn version(State(state): State<AppState>) -> Result<Json<VersionInfo>, StatusCode> {
    {
        let guard = state.version_cache.lock().await;
        if let Some((info, fetched_at)) = guard.as_ref() {
            if fetched_at.elapsed() < VERSION_TTL {
                return Ok(Json(info.clone()));
            }
        }
    }

    let current = env!("CARGO_PKG_VERSION").to_string();
    let github = fetch_latest_release().await;

    let (latest, html_url) = match github {
        Some(rel) => (Some(rel.tag_name), Some(rel.html_url)),
        None => (None, None),
    };

    let update_available = latest
        .as_ref()
        .map(|tag| normalize_version(tag) != current)
        .unwrap_or(false);

    let info = VersionInfo {
        current,
        latest,
        html_url,
        update_available,
    };

    *state.version_cache.lock().await = Some((info.clone(), Instant::now()));
    Ok(Json(info))
}

async fn fetch_latest_release() -> Option<GitHubRelease> {
    let client = reqwest::Client::builder()
        .timeout(VERSION_TIMEOUT)
        .user_agent("agentgrove/version-check")
        .build()
        .ok()?;

    let resp = client
        .get("https://api.github.com/repos/agentgrove/agentgrove/releases/latest")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let mut rel: GitHubRelease = resp.json().await.ok()?;
    rel.tag_name = normalize_version(&rel.tag_name);
    Some(rel)
}

fn normalize_version(tag: &str) -> String {
    tag.trim().strip_prefix('v').unwrap_or(tag).to_string()
}
