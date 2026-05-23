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
pub mod models_cache;
pub mod opencode;
pub mod slash_files;

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
    /// A chunk of the assistant's *thinking* trace (extended thinking
    /// / reasoning). Emitted alongside (and typically before) Token
    /// events so the FE can render the AI's reasoning in a collapsible
    /// panel separate from the final answer.
    Thinking {
        /// The thinking text chunk.
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
    /// opencode CLI subprocess (paired with its own auth chain).
    Opencode,
}

impl ProviderId {
    /// Stable lowercase string form (e.g. "claude").
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Fake => "fake",
            ProviderId::Opencode => "opencode",
        }
    }
}

/// What the BE returns for each provider on `GET /api/providers`. The
/// FE uses `available` to gate the picker and `version` / `path` for
/// debug surfaces.
///
/// Outgoing-only: the FE never sends this back, so we don't derive
/// `Deserialize` (would force the `models` slice off `'static`).
#[derive(Debug, Clone, Serialize)]
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
    pub default_model: String,
    /// Model aliases / ids this provider's CLI accepts, in display
    /// order. Providers that can interrogate their CLI for the live
    /// list (opencode: `opencode models`) populate it dynamically;
    /// providers without a stable discovery surface (Claude) ship a
    /// curated static list. Power users can still type a free-form
    /// id in the per-chat settings dialog.
    pub models: Vec<String>,
    /// Whether the provider supports session resume across turns
    /// (Claude: yes via `--resume`; FakeProvider: no).
    pub supports_resume: bool,
}

/// A slash-command surfaced by a provider's CLI. The FE renders these
/// inline in the chat input so users can pick from a typed `/` menu
/// without memorising the provider's command set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    /// Command literal **without** the leading slash (e.g. `clear`).
    pub name: String,
    /// One-line human description shown in the picker.
    pub description: String,
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
    /// Provider-specific "thinking effort" hint, e.g. `Some("high")`
    /// to unlock extended thinking on Claude. Providers map this to
    /// their native flag (Claude: `--effort`).
    pub effort: Option<String>,
    /// When `true`, ask the provider to bypass all permission prompts
    /// (Claude / opencode: `--dangerously-skip-permissions`). The
    /// CLIs surface permission prompts on a TTY, which AgentGrove
    /// doesn't allocate — so without this flag the agent stalls
    /// silently the first time it wants to run a tool. The API
    /// layer derives the effective value from
    /// `settings.auto_approve_tools` (global default) with the
    /// per-chat override applied on top.
    pub auto_approve_tools: bool,
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

    /// Slash commands supported by the provider's CLI, optionally
    /// scoped to a project root.
    ///
    /// Implementations typically union three sources:
    ///   1. **Built-in** CLI commands the provider always ships
    ///      (Claude: `/clear`, `/compact`, …).
    ///   2. **User-level** Markdown files in the CLI's config dir
    ///      (Claude: `~/.claude/commands/*.md`; opencode:
    ///      `~/.config/opencode/command/*.md`).
    ///   3. **Project-level** Markdown files in
    ///      `<ctx.cwd>/.claude/commands/*.md` /
    ///      `<ctx.cwd>/.opencode/command/*.md` when `ctx.cwd` is
    ///      `Some`.
    ///
    /// The trait method is async so providers can fs-walk + read
    /// front-matter blocks without blocking. Default impl returns
    /// an empty list (no slash-commands surface).
    async fn slash_commands(&self, _ctx: SlashCommandContext<'_>) -> Vec<SlashCommand> {
        Vec::new()
    }
}

/// Per-request context passed to [`AgentProvider::slash_commands`].
/// `cwd` is `Some(<project_root>)` when the FE is asking for
/// commands in the context of a specific project — providers add
/// project-local command files (e.g.
/// `<cwd>/.claude/commands/*.md`) on top of the user-level set
/// when it's present. `None` means "give me only the user-level
/// + built-in set" (e.g. before any project is selected).
#[derive(Debug, Clone, Copy, Default)]
pub struct SlashCommandContext<'a> {
    /// Absolute path to the active project's working directory.
    pub cwd: Option<&'a std::path::Path>,
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
        let ev = AgentEvent::Token { text: "hi".into() };
        let s = serde_json::to_string(&ev).unwrap();
        assert_eq!(s, "{\"type\":\"token\",\"text\":\"hi\"}");
    }
}
