//! Agent provider trait and implementations.
//!
//! M0 scope: `AgentEvent` enum and a `FakeProvider` used by tests. Real
//! providers (Claude/Codex/Kimi/OpenAI-compat) land in M3.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use serde::{Deserialize, Serialize};

/// Streaming event emitted by an agent provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A text token from the assistant.
    Token {
        /// The token text. May be multiple characters.
        text: String,
    },
    /// The assistant is invoking a tool.
    ToolCall {
        /// Tool name.
        name: String,
        /// JSON arguments.
        args: serde_json::Value,
    },
    /// Result of a tool call.
    ToolResult {
        /// Tool name.
        name: String,
        /// JSON result.
        result: serde_json::Value,
    },
    /// Stream finished cleanly.
    Done,
    /// Stream errored.
    Error {
        /// Error message.
        message: String,
    },
}
