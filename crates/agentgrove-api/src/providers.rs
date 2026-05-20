//! `/api/providers` route — lists every agent provider known to this
//! build with detection info (installed? version? path?).
//!
//! Providers themselves are implemented in the `agentgrove-agents` crate.
//! This module is a thin BE surface: registry lookup + JSON DTO.
//!
//! See ADR-0005 for the integration model (we launch the user's
//! installed CLI; we do not embed API SDKs).

use crate::state::AppState;
use agentgrove_agents::{AgentProvider, ProviderDescriptor};
use axum::{extract::State, Json};
use serde::Serialize;
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
        };
        Self {
            id: d.id.as_str().to_string(),
            label: d.label,
            available: d.available,
            path: d.path.map(|p| p.to_string_lossy().into_owned()),
            version: d.version,
            default_model: d.default_model.to_string(),
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
        // Order matters: the first non-fake provider is what the FE
        // pre-selects in the new-chat dialog.
        Self {
            providers: vec![Arc::new(agentgrove_agents::claude::ClaudeProvider::new())],
        }
    }
}

impl ProviderRegistry {
    /// Look up a provider by its stable id (e.g. "claude").
    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentProvider>> {
        self.providers
            .iter()
            .find(|p| p.id().as_str() == id)
            .cloned()
    }
}

/// `GET /api/providers` handler.
pub async fn list(State(state): State<AppState>) -> Json<Vec<ProviderDto>> {
    let mut out = Vec::with_capacity(state.providers.providers.len());
    for p in state.providers.providers.iter() {
        out.push(ProviderDto::from_descriptor(p.detect().await));
    }
    Json(out)
}
