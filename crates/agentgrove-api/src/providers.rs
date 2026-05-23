//! `/api/providers` route — lists every agent provider known to this
//! build with detection info (installed? version? path?).
//!
//! Providers themselves are implemented in the `agentgrove-agents` crate.
//! This module is a thin BE surface: registry lookup + JSON DTO.
//!
//! See ADR-0005 for the integration model (we launch the user's
//! installed CLI; we do not embed API SDKs).

use crate::state::AppState;
use agentgrove_agents::{AgentProvider, ProviderDescriptor, SlashCommand};
use agentgrove_store::ProviderSecretSummary;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Wire shape for one provider in the `/api/providers` response.
///
/// Mostly mirrors [`ProviderDescriptor`] but flattens `path` to a string
/// for the FE and adds a stable `install_hint` URL.
#[derive(Debug, Serialize)]
pub struct ProviderDto {
    /// Stable id, e.g. `"claude"`.
    pub id: String,
    /// User-facing label, e.g. `"Claude"`.
    pub label: String,
    /// Whether the CLI was found on the host system.
    pub available: bool,
    /// Resolved absolute path to the CLI, when found.
    pub path: Option<String>,
    /// CLI version string, when known.
    pub version: Option<String>,
    /// Default model alias the FE seeds new chats with.
    pub default_model: String,
    /// Curated list of model aliases the provider's CLI accepts.
    /// Drives the model dropdown in the FE's new-chat dialog. May be
    /// empty for providers that don't have stable aliases.
    pub models: Vec<String>,
    /// Whether the provider can resume a previous session.
    pub supports_resume: bool,
    /// URL or text the FE can show next to "not installed".
    pub install_hint: &'static str,
}

impl ProviderDto {
    fn from_descriptor(d: ProviderDescriptor) -> Self {
        let install_hint = match d.id {
            agentgrove_agents::ProviderId::Claude => {
                "https://docs.claude.com/en/docs/claude-code/quickstart"
            }
            agentgrove_agents::ProviderId::Fake => "",
            agentgrove_agents::ProviderId::Opencode => {
                "https://github.com/opencode-ai/opencode#install"
            }
        };
        Self {
            id: d.id.as_str().to_string(),
            label: d.label,
            available: d.available,
            path: d.path.map(|p| p.to_string_lossy().into_owned()),
            version: d.version,
            default_model: d.default_model,
            models: d.models,
            supports_resume: d.supports_resume,
            install_hint,
        }
    }
}

/// Registry of every provider this build knows about. Held in
/// [`AppState`] so handlers can dispatch by id later.
#[derive(Clone)]
pub struct ProviderRegistry {
    /// Ordered list of providers; first one is the default suggestion.
    pub providers: Vec<Arc<dyn AgentProvider>>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        // Order matters: the first available provider is what the FE
        // pre-selects in the new-chat dialog. Today every shipping
        // provider is a CLI subprocess (Claude, opencode); future
        // HTTP-API providers (OpenAI-compat aggregators) would
        // resolve dynamically via `provider_secrets` + `resolve`.
        Self {
            providers: vec![
                Arc::new(agentgrove_agents::claude::ClaudeProvider::new()),
                Arc::new(agentgrove_agents::opencode::OpencodeProvider::new()),
            ],
        }
    }
}

impl ProviderRegistry {
    /// Look up a built-in provider by its stable id (e.g. "claude").
    /// All shipping providers are CLI-backed today; future HTTP-API
    /// providers will register here too once we (re-)add an
    /// aggregator integration.
    pub fn get_builtin(&self, id: &str) -> Option<Arc<dyn AgentProvider>> {
        self.providers
            .iter()
            .find(|p| p.id().as_str() == id)
            .cloned()
    }
}

/// Resolve any provider by id.
///
/// Today this is just the built-in CLI registry — Claude + opencode.
/// The `provider_secrets` infrastructure (encrypted key storage) is
/// kept for future HTTP-API providers but is currently unused by the
/// resolve path.
pub async fn resolve(state: &AppState, id: &str) -> Option<Arc<dyn AgentProvider>> {
    if let Some(p) = state.providers.get_builtin(id) {
        return Some(p);
    }
    None
}

/// `GET /api/providers` handler.
///
/// Returns one entry per known provider — built-ins (Claude, fake)
/// Returns one entry per registered CLI provider (Claude, opencode).
pub async fn list(State(state): State<AppState>) -> Json<Vec<ProviderDto>> {
    let mut out = Vec::with_capacity(state.providers.providers.len());
    for p in state.providers.providers.iter() {
        out.push(ProviderDto::from_descriptor(p.detect().await));
    }
    Json(out)
}

/// `GET /api/providers/:id/commands` — slash commands the provider's
/// CLI exposes. The FE renders these in the chat input's `/` picker.
pub async fn commands(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<SlashCommand>>, StatusCode> {
    let p = resolve(&state, &id).await.ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(p.slash_commands()))
}

/// `POST /api/providers/:id/refresh` — drop the cached model list for
/// `:id` and return a freshly-detected descriptor. Used by the FE
/// refresh icon on the Providers tab and the new-chat model picker
/// when the user wants to pick up newly-installed models without
/// waiting for the TTL.
pub async fn refresh(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProviderDto>, StatusCode> {
    let p = resolve(&state, &id).await.ok_or(StatusCode::NOT_FOUND)?;
    agentgrove_agents::models_cache::invalidate(p.id());
    Ok(Json(ProviderDto::from_descriptor(p.detect().await)))
}

/// Body for `PUT /api/providers/:id/config`. Encrypts + stores the
/// API key at rest; never echoes it back over HTTP.
///
/// `api_key` semantics:
///   - omitted / `null` → leave the existing key untouched (use this
///     to update base_url only).
///   - empty string → clear the stored key.
///   - non-empty → encrypt + persist.
///
/// Model selection is intentionally NOT part of this body — it
/// belongs at chat creation, sourced from `ProviderDescriptor`.
#[derive(Debug, Deserialize)]
pub struct PutProviderConfigBody {
    /// Base URL the provider lives at, e.g. `http://localhost:20128/v1`.
    pub base_url: String,
    /// API key — see body-level doc for the semantics.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// `GET /api/providers/:id/config` — returns the stored base URL +
/// default model + a `has_api_key` flag. The key itself is never
/// returned (we only echo back the summary).
pub async fn get_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProviderSecretSummary>, StatusCode> {
    let row = state
        .provider_secrets
        .get(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match row {
        Some(s) => Ok(Json(ProviderSecretSummary::from(&s))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

/// `PUT /api/providers/:id/config` — upsert per-provider config.
/// See [`PutProviderConfigBody`] for the api_key semantics.
pub async fn put_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PutProviderConfigBody>,
) -> Result<Json<ProviderSecretSummary>, StatusCode> {
    if body.base_url.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .provider_secrets
        .put(&id, &body.base_url, body.api_key.as_deref())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = state
        .provider_secrets
        .get(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ProviderSecretSummary::from(&row)))
}

/// `DELETE /api/providers/:id/config` — wipe per-provider config.
/// Used by the FE when the user disconnects a provider entirely.
pub async fn delete_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let removed = state
        .provider_secrets
        .delete(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
