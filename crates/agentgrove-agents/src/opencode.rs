//! Opencode CLI subprocess provider — placeholder scaffold.
//!
//! Detection lookups + the install-hint URL are wired up so the FE
//! Settings → Providers tab and the new-chat dropdown both render
//! an "opencode" entry, but `spawn()` is intentionally not
//! implemented yet: the real integration (CLI argv shape, event
//! translation, live model fetch) lands in a follow-up commit.
//!
//! For now the provider reports `available=false` when the
//! `opencode` binary isn't on `PATH`, and `available=true` (with
//! version) when it is — clicking through to a new chat with
//! opencode would surface a "not implemented" error event so the
//! user knows it isn't ready instead of silently failing.

use crate::{
    AgentEvent, AgentProvider, ProviderDescriptor, ProviderError, ProviderId, SlashCommand,
    SpawnOptions,
};
use async_trait::async_trait;
use std::path::PathBuf;
use tokio::process::Command;
use tokio::sync::mpsc;

const BINARY_NAME: &str = "opencode";

/// Concrete [`AgentProvider`] for the opencode CLI. Placeholder for
/// now (see module docs).
#[derive(Debug, Default, Clone)]
pub struct OpencodeProvider;

impl OpencodeProvider {
    /// Construct a fresh provider. No config required at construction
    /// time — auth lives in the CLI itself.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

fn find_binary() -> Option<PathBuf> {
    which::which(BINARY_NAME).ok()
}

async fn read_version(path: &std::path::Path) -> Option<String> {
    let out = Command::new(path).arg("--version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[async_trait]
impl AgentProvider for OpencodeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Opencode
    }

    async fn detect(&self) -> ProviderDescriptor {
        let path = find_binary();
        let version = match &path {
            Some(p) => read_version(p).await,
            None => None,
        };
        ProviderDescriptor {
            id: ProviderId::Opencode,
            label: "opencode".to_string(),
            // Even when the binary is on PATH we report
            // `available=false` until the real spawn() lands so
            // the FE doesn't let users pick a half-wired provider.
            available: false,
            path,
            version,
            default_model: "",
            models: &[],
            supports_resume: false,
        }
    }

    async fn spawn(
        &self,
        _prompt: &str,
        _opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        // Placeholder until the real wire-up lands. We emit an
        // error event so the chat shows something meaningful.
        let _ = events.send(AgentEvent::Error {
            message: "opencode provider is not implemented yet".to_string(),
        });
        Ok(())
    }

    fn slash_commands(&self) -> Vec<SlashCommand> {
        vec![]
    }
}
