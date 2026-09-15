//! `/api/integrations` — OAuth connect/disconnect for ticket providers.
//!
//! GitHub and ClickUp use a standard authorization-code OAuth flow; the
//! resulting tokens are stored encrypted via
//! [`agentgrove_store::IntegrationRepo`]. GitLab needs no OAuth — it
//! rides the already-authenticated `glab` CLI — so its "connection" is
//! just a check that `glab` is installed and logged in.
//!
//! Client credentials are read from the environment
//! (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`,
//! `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET`). The redirect_uri is
//! fixed to the loopback callback route on port 4317.

use crate::state::AppState;
use agentgrove_store::IntegrationSummary;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect, Response},
    Json,
};
use serde::Deserialize;

const REDIRECT_BASE: &str = "http://localhost:4317/api/integrations";

/// Query params on the OAuth callback.
#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    #[allow(dead_code)]
    pub state: Option<String>,
    /// Provider-reported error (e.g. user denied consent).
    pub error: Option<String>,
}

/// `GET /api/integrations` — list connected integrations.
///
/// Merges the DB-backed connections (GitHub / ClickUp) with a live
/// probe of GitLab's `glab` CLI so the FE sees all three providers'
/// status in one round-trip.
pub async fn list_connections(State(state): State<AppState>) -> Json<Vec<IntegrationSummary>> {
    let mut conns = state
        .integration_store
        .list_connections()
        .await
        .unwrap_or_default();

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

/// `GET /api/integrations/:provider/auth` — redirect to the provider's
/// OAuth authorize URL. GitLab returns 200 with a note (no OAuth).
pub async fn auth_redirect(
    State(_state): State<AppState>,
    Path(provider): Path<String>,
) -> Response {
    match provider.as_str() {
        "github" => {
            let Ok(client_id) = std::env::var("GITHUB_CLIENT_ID") else {
                return (
                    StatusCode::BAD_REQUEST,
                    "GITHUB_CLIENT_ID is not set on the server".to_string(),
                )
                    .into_response();
            };
            let redirect_uri = format!("{REDIRECT_BASE}/github/callback");
            let url = format!(
                "https://github.com/login/oauth/authorize?client_id={}&scope=repo&state={}&redirect_uri={}",
                urlencode(&client_id),
                urlencode(&random_state()),
                urlencode(&redirect_uri),
            );
            Redirect::temporary(&url).into_response()
        }
        "clickup" => {
            let Ok(client_id) = std::env::var("CLICKUP_CLIENT_ID") else {
                return (
                    StatusCode::BAD_REQUEST,
                    "CLICKUP_CLIENT_ID is not set on the server".to_string(),
                )
                    .into_response();
            };
            let redirect_uri = format!("{REDIRECT_BASE}/clickup/callback");
            let url = format!(
                "https://app.clickup.com/api?client_id={}&redirect_uri={}",
                urlencode(&client_id),
                urlencode(&redirect_uri),
            );
            Redirect::temporary(&url).into_response()
        }
        "gitlab" => (
            StatusCode::OK,
            "GitLab uses the glab CLI — run `glab auth login`, no OAuth redirect needed."
                .to_string(),
        )
            .into_response(),
        other => (
            StatusCode::BAD_REQUEST,
            format!("unknown provider: {other}"),
        )
            .into_response(),
    }
}

/// `GET /api/integrations/:provider/callback` — exchange the auth code
/// for tokens, fetch the user profile, persist, and return a
/// self-closing HTML page.
pub async fn auth_callback(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> Response {
    if let Some(err) = q.error {
        return error_page(&format!("{provider} authorization failed: {err}"));
    }
    let Some(code) = q.code else {
        return error_page("missing authorization code");
    };

    let result = match provider.as_str() {
        "github" => connect_github(&state, &code).await,
        "clickup" => connect_clickup(&state, &code).await,
        other => Err(format!("unknown provider: {other}")),
    };

    match result {
        Ok(who) => success_page(&provider, &who),
        Err(e) => {
            tracing::warn!(provider, error = %e, "oauth callback failed");
            error_page(&e)
        }
    }
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

// ---- GitHub OAuth --------------------------------------------------------

async fn connect_github(state: &AppState, code: &str) -> Result<String, String> {
    let client_id =
        std::env::var("GITHUB_CLIENT_ID").map_err(|_| "GITHUB_CLIENT_ID is not set".to_string())?;
    let client_secret = std::env::var("GITHUB_CLIENT_SECRET")
        .map_err(|_| "GITHUB_CLIENT_SECRET is not set".to_string())?;

    let client = reqwest::Client::new();
    let token_resp: serde_json::Value = client
        .post("https://github.com/login/oauth/access_token")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        }))
        .send()
        .await
        .map_err(|e| format!("token exchange request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("token exchange decode failed: {e}"))?;

    let access_token = token_resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            token_resp
                .get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or("no access_token in response")
                .to_string()
        })?
        .to_string();
    let scope = token_resp
        .get("scope")
        .and_then(|v| v.as_str())
        .map(String::from);
    let token_type = token_resp
        .get("token_type")
        .and_then(|v| v.as_str())
        .map(String::from);

    // Fetch the user profile.
    let user: serde_json::Value = client
        .get("https://api.github.com/user")
        .header(reqwest::header::USER_AGENT, "agentgrove")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("user profile request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("user profile decode failed: {e}"))?;
    let user_name = user
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| user.get("login").and_then(|v| v.as_str()))
        .map(String::from);
    let user_id = user
        .get("id")
        .and_then(|v| v.as_u64())
        .map(|n| n.to_string());

    state
        .integration_store
        .save_token(
            "github",
            &access_token,
            None,
            token_type.as_deref(),
            scope.as_deref(),
            user_name.as_deref(),
            user_id.as_deref(),
            None,
        )
        .await
        .map_err(|e| format!("failed to persist token: {e}"))?;
    Ok(user_name.unwrap_or_else(|| "GitHub".to_string()))
}

// ---- ClickUp OAuth -------------------------------------------------------

async fn connect_clickup(state: &AppState, code: &str) -> Result<String, String> {
    let client_id = std::env::var("CLICKUP_CLIENT_ID")
        .map_err(|_| "CLICKUP_CLIENT_ID is not set".to_string())?;
    let client_secret = std::env::var("CLICKUP_CLIENT_SECRET")
        .map_err(|_| "CLICKUP_CLIENT_SECRET is not set".to_string())?;

    let client = reqwest::Client::new();
    let token_resp: serde_json::Value = client
        .post("https://api.clickup.com/api/v2/oauth/token")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        }))
        .send()
        .await
        .map_err(|e| format!("token exchange request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("token exchange decode failed: {e}"))?;

    let access_token = token_resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            token_resp
                .get("err")
                .and_then(|v| v.as_str())
                .unwrap_or("no access_token in response")
                .to_string()
        })?
        .to_string();

    // Fetch the user profile.
    let user: serde_json::Value = client
        .get("https://api.clickup.com/api/v2/user")
        .header(reqwest::header::AUTHORIZATION, &access_token)
        .send()
        .await
        .map_err(|e| format!("user profile request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("user profile decode failed: {e}"))?;
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

    state
        .integration_store
        .save_token(
            "clickup",
            &access_token,
            None,
            Some("Bearer"),
            None,
            user_name.as_deref(),
            user_id.as_deref(),
            None,
        )
        .await
        .map_err(|e| format!("failed to persist token: {e}"))?;
    Ok(user_name.unwrap_or_else(|| "ClickUp".to_string()))
}

// ---- GitLab (glab CLI) ---------------------------------------------------

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

// ---- HTML pages + helpers ------------------------------------------------

fn success_page(provider: &str, who: &str) -> Response {
    Html(format!(
        "<!doctype html><html><body style=\"font-family:sans-serif;text-align:center;padding:3rem\">\
         <h2>Connected to {provider}!</h2>\
         <p>Signed in as {who}. You can close this window.</p>\
         <script>window.close()</script></body></html>"
    ))
    .into_response()
}

fn error_page(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Html(format!(
            "<!doctype html><html><body style=\"font-family:sans-serif;text-align:center;padding:3rem\">\
             <h2>Connection failed</h2><p>{msg}</p></body></html>"
        )),
    )
        .into_response()
}

/// Minimal application/x-www-form-urlencoded component encoder for the
/// small set of characters that appear in our OAuth URLs (`:`, `/`, `?`,
/// `&`, `=`, space). Avoids pulling a new dependency into the runtime
/// crate for one query string.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Opaque CSRF state token. Loopback-only + single-user, so this is a
/// low-value nonce; we generate it fresh per authorize call.
fn random_state() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
