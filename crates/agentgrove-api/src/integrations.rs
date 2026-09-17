//! `/api/integrations` — connect/disconnect for ticket providers.
//!
//! ClickUp uses a personal API key: the user pastes it in Settings →
//! Integrations and it's stored encrypted via
//! [`agentgrove_store::IntegrationRepo`]. GitHub and GitLab need no
//! stored credential — they ride the already-authenticated `gh` / `glab`
//! CLIs — so their "connection" is just a check that the CLI is
//! installed and logged in.

use crate::state::AppState;
use agentgrove_store::IntegrationSummary;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

/// Body for `POST /api/integrations/clickup/key`.
#[derive(Debug, Deserialize)]
pub struct ClickUpKeyBody {
    pub api_key: String,
}

/// `GET /api/integrations` — list connected integrations.
///
/// Merges the DB-backed connections (ClickUp) with a live probe of the
/// `gh` / `glab` CLIs so the FE sees all three providers' status in one
/// round-trip.
pub async fn list_connections(State(state): State<AppState>) -> Json<Vec<IntegrationSummary>> {
    let mut conns = state
        .integration_store
        .list_connections()
        .await
        .unwrap_or_default();

    // GitHub: no stored token; connection == gh installed & authed.
    if !conns.iter().any(|c| c.provider == "github") {
        let (connected, user_name) = gh_status().await;
        conns.push(IntegrationSummary {
            provider: "github".into(),
            user_name,
            user_id: None,
            connected,
        });
    }

    // GitLab: no stored token; connection == glab installed & authed.
    if !conns.iter().any(|c| c.provider == "gitlab") {
        let (connected, user_name) = glab_status().await;
        conns.push(IntegrationSummary {
            provider: "gitlab".into(),
            user_name,
            user_id: None,
            connected,
        });
    }
    Json(conns)
}

/// `POST /api/integrations/clickup/key` — validate + store a ClickUp
/// personal API key. Validation calls `GET /api/v2/user` with the key;
/// on success the key is persisted (as the access token) alongside the
/// resolved user name/id.
pub async fn save_clickup_key(
    State(state): State<AppState>,
    Json(body): Json<ClickUpKeyBody>,
) -> impl IntoResponse {
    let api_key = body.api_key.trim();
    if api_key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "api_key must not be empty".to_string(),
        )
            .into_response();
    }

    let client = reqwest::Client::new();
    let resp = match client
        .get("https://api.clickup.com/api/v2/user")
        .header(reqwest::header::AUTHORIZATION, api_key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("ClickUp request failed: {e}"),
            )
                .into_response();
        }
    };

    if !resp.status().is_success() {
        return (
            StatusCode::BAD_REQUEST,
            "ClickUp rejected the API key".to_string(),
        )
            .into_response();
    }

    let user: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("ClickUp user decode failed: {e}"),
            )
                .into_response();
        }
    };
    let user_name = user
        .get("user")
        .and_then(|u| u.get("username"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let user_id = user
        .get("user")
        .and_then(|u| u.get("id"))
        .and_then(|v| v.as_i64())
        .map(|n| n.to_string());

    if let Err(e) = state
        .integration_store
        .save_token(
            "clickup",
            api_key,
            None,
            None,
            None,
            user_name.as_deref(),
            user_id.as_deref(),
            None,
        )
        .await
    {
        tracing::warn!(error = %e, "failed to persist ClickUp API key");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to persist key: {e}"),
        )
            .into_response();
    }

    StatusCode::NO_CONTENT.into_response()
}

/// `DELETE /api/integrations/:provider` — disconnect (delete token).
pub async fn disconnect(State(state): State<AppState>, Path(provider): Path<String>) -> StatusCode {
    match state.integration_store.delete_token(&provider).await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::warn!(provider, error = %e, "disconnect failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

// ---- CLI probes (gh / glab) ----------------------------------------------

/// Probe `gh auth status`. Returns `(connected, user_name)`.
async fn gh_status() -> (bool, Option<String>) {
    // `gh auth status` prints to stderr; a success exit means authed.
    let out = tokio::process::Command::new("gh")
        .args(["auth", "status"])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            // Try to extract "Logged in ... as <user>".
            let user = text
                .lines()
                .find_map(|l| l.split(" as ").nth(1))
                .map(|s| {
                    s.split_whitespace()
                        .next()
                        .unwrap_or("")
                        .trim_matches('(')
                        .to_string()
                })
                .filter(|s| !s.is_empty());
            (true, user)
        }
        _ => (false, None),
    }
}

/// Probe `glab auth status`. Returns `(connected, user_name)`.
async fn glab_status() -> (bool, Option<String>) {
    // `glab auth status` prints to stderr; a success exit means authed.
    let out = tokio::process::Command::new("glab")
        .args(["auth", "status"])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            // Try to extract "Logged in ... as <user>".
            let user = text
                .lines()
                .find_map(|l| l.split(" as ").nth(1))
                .map(|s| {
                    s.split_whitespace()
                        .next()
                        .unwrap_or("")
                        .trim_matches('(')
                        .to_string()
                })
                .filter(|s| !s.is_empty());
            (true, user)
        }
        _ => (false, None),
    }
}
