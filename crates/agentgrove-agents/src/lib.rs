//! Agent provider abstraction and concrete providers.
//!
//! AgentGrove integrates AI coding agents by **launching their official,
//! user-installed CLIs** as child processes and translating the CLI's
//! event stream into our [`AgentEvent`] enum. See ADR-0005 for the full
//! rationale.
//!
//! The crate defines:
//!
//! - [`AgentEvent`] — the canonical streaming event our UI consumes.
//! - [`ProviderId`] — stable string identifier per provider.
//! - [`ProviderDescriptor`] — what the FE/list endpoint returns about
//!   each provider (label, availability, version, default model).
//! - [`AgentProvider`] — trait every provider implements
//!   (`detect()` + `spawn()`).
//! - Concrete providers: [`claude::ClaudeProvider`], [`fake::FakeProvider`].

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;
use tokio::sync::mpsc;

pub mod claude;
pub mod fake;

/// Streaming event emitted by an agent provider.
///
/// Providers translate their native streaming format (Claude's
/// `stream-json`, Codex's NDJSON, ...) into this enum before publishing
/// to the LogBus. The FE consumes this single shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// The provider has accepted the prompt and reports a session id
    /// (used for resuming on subsequent turns).
    SessionStart {
        /// Opaque provider session id.
        session_id: String,
    },
    /// A text token from the assistant. May be a single character, a
    /// word, or a full sentence chunk depending on the provider's
    /// chunking.
    Token {
        /// The token text.
        text: String,
    },
    /// The assistant is invoking a tool.
    ToolCall {
        /// Tool name as reported by the provider.
        name: String,
        /// Tool arguments as a JSON value.
        args: serde_json::Value,
        /// Provider-assigned tool-use id (for matching to a result).
        id: Option<String>,
    },
    /// Result of a tool call.
    ToolResult {
        /// Tool name.
        name: String,
        /// Result as a JSON value.
        result: serde_json::Value,
        /// Matching tool-use id from the original `ToolCall`.
        id: Option<String>,
    },
    /// Stream finished cleanly. Carries the final assistant text and
    /// usage / cost details when the provider supplies them.
    Done {
        /// Final assistant text concatenated, when known.
        result: Option<String>,
        /// Total cost in USD if the provider reports it.
        cost_usd: Option<f64>,
    },
    /// Stream errored.
    Error {
        /// Human-readable error message.
        message: String,
    },
    /// Sentinel inserted in place of events evicted from a bounded
    /// per-prompt buffer. Carries the count so the FE can render
    /// "N earlier events hidden" and offer to fetch detail.
    Truncated {
        /// Number of events dropped at this position.
        dropped: u32,
    },
}

/// Stable identifier per provider. Used as the on-the-wire enum value
/// and as the key for `GET /api/providers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    /// Anthropic Claude via the `claude` Claude Code CLI.
    Claude,
    /// Test-only deterministic provider.
    Fake,
}

impl ProviderId {
    /// Stable lowercase string form (e.g. "claude").
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Fake => "fake",
        }
    }
}

/// What the BE returns for each provider on `GET /api/providers`. The
/// FE uses `available` to gate the picker and `version` / `path` for
/// debug surfaces.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderDescriptor {
    /// Stable id (e.g. "claude").
    pub id: ProviderId,
    /// User-facing label (e.g. "Claude"). Per Anthropic's branding
    /// guidelines we do not use "Claude Code" here.
    pub label: String,
    /// Whether the underlying CLI is installed and runnable.
    pub available: bool,
    /// Path to the CLI binary when `available` is true.
    pub path: Option<PathBuf>,
    /// CLI version string when known (`claude --version` etc).
    pub version: Option<String>,
    /// Default model alias (e.g. "sonnet"). FE seeds new chats with
    /// this if the user doesn't pick one.
    pub default_model: &'static str,
    /// Whether the provider supports session resume across turns
    /// (Claude: yes via `--resume`; FakeProvider: no).
    pub supports_resume: bool,
}

/// Per-turn options passed to [`AgentProvider::spawn`].
#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// Working directory the CLI should run in (worktree path).
    pub cwd: PathBuf,
    /// Model alias / id to use, e.g. `Some("sonnet")`. None means use
    /// the provider's default.
    pub model: Option<String>,
    /// Session id to resume from a previous turn, if any.
    pub resume_session_id: Option<String>,
}

/// Errors surfaced by the provider layer.
#[derive(Debug, Error)]
pub enum ProviderError {
    /// The provider's CLI is not on `PATH`.
    #[error("{provider} CLI not found on PATH (install instructions: {hint})")]
    NotInstalled {
        /// Provider human label.
        provider: String,
        /// Install hint URL or text.
        hint: String,
    },
    /// Failed to spawn the child process.
    #[error("failed to spawn {provider}: {source}")]
    Spawn {
        /// Provider human label.
        provider: String,
        /// Underlying io error.
        #[source]
        source: std::io::Error,
    },
    /// IO error reading from the child.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// A provider knows how to discover its CLI and spawn a single
/// prompt-to-completion turn. Implementations live in `crate::claude`,
/// `crate::fake`, ...
///
/// `spawn` writes [`AgentEvent`]s to the provided channel as they
/// arrive from the CLI and resolves when the CLI exits. The channel is
/// closed when the turn ends so callers can `while let Some(ev) = rx.recv()`.
#[async_trait]
pub trait AgentProvider: Send + Sync {
    /// The provider's id.
    fn id(&self) -> ProviderId;

    /// Locate the CLI on the host system and return its descriptor.
    /// Always returns a descriptor (with `available=false` if the CLI
    /// is missing) so the FE can render the picker uniformly.
    async fn detect(&self) -> ProviderDescriptor;

    /// Spawn a single turn. `prompt` is the user message, `opts` carries
    /// cwd / model / resume / etc. Events flow on `events`. Returns when
    /// the underlying CLI exits.
    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_round_trips_through_json() {
        let id = ProviderId::Claude;
        let s = serde_json::to_string(&id).unwrap();
        assert_eq!(s, "\"claude\"");
        let back: ProviderId = serde_json::from_str(&s).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn agent_event_session_start_serializes_with_type_tag() {
        let ev = AgentEvent::SessionStart {
            session_id: "abc".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"type\":\"session_start\""));
        assert!(s.contains("\"session_id\":\"abc\""));
    }

    #[test]
    fn agent_event_token_serializes_with_type_tag() {
        let ev = AgentEvent::Token {
            text: "hi".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert_eq!(s, "{\"type\":\"token\",\"text\":\"hi\"}");
    }
}
