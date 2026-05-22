//! 9router HTTP provider.
//!
//! 9router (https://github.com/decolua/9router) is a locally-run
//! OpenAI-compatible aggregator: the user installs the CLI
//! (`npm install -g 9router`), starts the server (`9router`), and
//! connects upstream providers (Claude Code, OpenCode Free, Kiro AI,
//! etc.) through 9router's own dashboard. AgentGrove then talks to
//! 9router's `POST /v1/chat/completions` endpoint as if it were any
//! other OpenAI-compatible service.
//!
//! Why HTTP rather than a CLI subprocess (like Claude):
//!   * 9router IS a long-running server, not a per-prompt subprocess.
//!     Spawning the CLI for every turn would re-launch the entire
//!     dashboard and waste a 1-2 s startup.
//!   * The endpoint is genuinely OpenAI-compatible; we get streaming
//!     SSE for free with a tiny client.
//!
//! Config: `base_url` + `api_key` come from
//! `agentgrove_store::ProviderSecretRepo` (user pastes them in
//! Settings → Providers). When either is missing the provider
//! reports `available=false` with an install hint.

use crate::{
    AgentEvent, AgentProvider, ProviderDescriptor, ProviderError, ProviderId, SlashCommand,
    SpawnOptions,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Default install hint URL shown when 9router isn't configured.
const INSTALL_HINT: &str = "https://github.com/decolua/9router#install";

/// Concrete [`AgentProvider`] backed by 9router's HTTP API.
///
/// `Arc` because the provider is shared between the API handler
/// (lives in `AppState`) and the dispatch task (clones the handle
/// for the spawned future). The config is captured at construction
/// time — if the user updates Settings, the API layer rebuilds the
/// provider.
#[derive(Debug, Clone)]
pub struct NineRouterProvider {
    base_url: Arc<str>,
    api_key: Arc<str>,
}

impl NineRouterProvider {
    /// Construct from validated config. Callers should ensure
    /// `base_url` is a real URL and `api_key` is non-empty before
    /// instantiating; the provider's `detect()` will surface a
    /// runtime error if 9router isn't reachable, but it doesn't
    /// re-validate inputs.
    #[must_use]
    pub fn new(base_url: impl Into<Arc<str>>, api_key: impl Into<Arc<str>>) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
        }
    }

    /// Build the chat-completions URL by joining the configured base
    /// URL with the OpenAI standard path. Tolerates a trailing
    /// slash on `base_url` so the user can paste either
    /// `http://host/v1` or `http://host/v1/`.
    fn chat_url(&self) -> String {
        let trimmed = self.base_url.trim_end_matches('/');
        format!("{trimmed}/chat/completions")
    }

    /// Build the models URL the same way.
    fn models_url(&self) -> String {
        let trimmed = self.base_url.trim_end_matches('/');
        format!("{trimmed}/models")
    }
}

#[async_trait]
impl AgentProvider for NineRouterProvider {
    fn id(&self) -> ProviderId {
        ProviderId::NineRouter
    }

    async fn detect(&self) -> ProviderDescriptor {
        // Probe `/models` with the configured key. Success ⇒
        // available + populate a curated short list. We don't
        // surface the full model list here because some 9router
        // installs report dozens; the new-chat dialog has a
        // free-form input for power users.
        let client = reqwest::Client::new();
        let res = client
            .get(self.models_url())
            .bearer_auth(self.api_key.as_ref())
            .send()
            .await;
        let available = res
            .as_ref()
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        let version = res
            .ok()
            .and_then(|r| r.headers().get("x-9router-version").cloned())
            .and_then(|v| v.to_str().ok().map(str::to_owned));
        ProviderDescriptor {
            id: ProviderId::NineRouter,
            label: "9router".to_string(),
            available,
            path: None,
            version,
            // Default to the `free-combo` route since that's
            // 9router's headline "use any free provider" alias.
            default_model: "free-combo",
            models: NINE_ROUTER_MODELS,
            // 9router itself doesn't track session ids — every
            // turn is independent at the HTTP layer. (The upstream
            // provider may, but that's invisible to us.)
            supports_resume: false,
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let model = opts
            .model
            .as_deref()
            .unwrap_or("free-combo")
            .to_string();
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "user", "content": prompt }
            ],
            "stream": true,
        });
        let client = reqwest::Client::new();
        let req = client
            .post(self.chat_url())
            .bearer_auth(self.api_key.as_ref())
            .header("content-type", "application/json")
            .body(body.to_string());
        let res = req.send().await.map_err(|e| ProviderError::Spawn {
            provider: "9router".to_string(),
            source: std::io::Error::other(e.to_string()),
        })?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            let _ = events.send(AgentEvent::Error {
                message: format!("9router returned HTTP {status}: {body}"),
            });
            return Ok(());
        }

        // Parse SSE: each event is `data: <json>\n\n` with a
        // sentinel `data: [DONE]\n\n`. The JSON shape is the
        // OpenAI streaming chunk: `choices[0].delta.content` for
        // tokens, `choices[0].finish_reason` flips non-null on the
        // final chunk.
        let mut stream = res.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut done_ok = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ProviderError::Spawn {
                provider: "9router".to_string(),
                source: std::io::Error::other(e.to_string()),
            })?;
            buf.extend_from_slice(&chunk);
            // Process complete SSE events delimited by `\n\n`.
            while let Some(boundary) = find_double_newline(&buf) {
                let frame = buf.drain(..boundary + 2).collect::<Vec<u8>>();
                let frame = match std::str::from_utf8(&frame) {
                    Ok(s) => s,
                    Err(_) => continue, // skip malformed
                };
                // An SSE frame may have multiple lines; we only
                // care about `data: <payload>` lines.
                for line in frame.lines() {
                    let Some(payload) = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")) else {
                        continue;
                    };
                    let payload = payload.trim();
                    if payload.is_empty() {
                        continue;
                    }
                    if payload == "[DONE]" {
                        done_ok = true;
                        let _ = events.send(AgentEvent::Done {
                            result: None,
                            cost_usd: None,
                        });
                        return Ok(());
                    }
                    let parsed: Result<OpenAiChunk, _> = serde_json::from_str(payload);
                    let Ok(parsed) = parsed else {
                        // Tolerate malformed mid-stream frames —
                        // some providers emit keep-alives.
                        continue;
                    };
                    if let Some(choice) = parsed.choices.first() {
                        if let Some(delta) = &choice.delta {
                            if let Some(text) = &delta.content {
                                if !text.is_empty() {
                                    let _ = events.send(AgentEvent::Token {
                                        text: text.clone(),
                                    });
                                }
                            }
                        }
                        if choice.finish_reason.is_some() && !done_ok {
                            done_ok = true;
                            let _ = events.send(AgentEvent::Done {
                                result: None,
                                cost_usd: None,
                            });
                            return Ok(());
                        }
                    }
                }
            }
        }
        // Stream ended without a [DONE] sentinel — still emit Done
        // so the FE doesn't stay in "working..." forever.
        if !done_ok {
            let _ = events.send(AgentEvent::Done {
                result: None,
                cost_usd: None,
            });
        }
        Ok(())
    }

    fn slash_commands(&self) -> Vec<SlashCommand> {
        // 9router doesn't expose its own slash commands today —
        // surface a small curated set so the FE picker isn't empty.
        vec![
            SlashCommand {
                name: "clear".into(),
                description: "Reset the conversation context.".into(),
            },
        ]
    }
}

/// Curated model list shown in the FE picker. Mirrors 9router's
/// "headline" combos + a handful of common direct models. Power
/// users can type any `/v1/models` id in the per-chat settings
/// dialog — the BE doesn't gate on this list.
const NINE_ROUTER_MODELS: &[&str] = &[
    "free-combo",
    "cc/claude-opus-4-5-20251101",
    "cc/claude-sonnet-4-5-20250929",
    "openai/gpt-5",
    "openai/gpt-4o",
];

/// Minimal OpenAI streaming chunk shape — just the fields we
/// actually read. `serde_json::from_str` ignores unknown keys.
#[derive(Debug, Deserialize)]
struct OpenAiChunk {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    delta: Option<OpenAiDelta>,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiDelta {
    content: Option<String>,
}

/// Find the position of the first `\n\n` in `buf`. Returns the
/// index of the first `\n` of the pair, or `None` if absent.
fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_url_strips_trailing_slash() {
        let p = NineRouterProvider::new("http://localhost:20128/v1/", "sk-x");
        assert_eq!(p.chat_url(), "http://localhost:20128/v1/chat/completions");
    }

    #[test]
    fn chat_url_with_no_trailing_slash() {
        let p = NineRouterProvider::new("http://localhost:20128/v1", "sk-x");
        assert_eq!(p.chat_url(), "http://localhost:20128/v1/chat/completions");
    }

    #[test]
    fn find_double_newline_locates_separator() {
        assert_eq!(find_double_newline(b"abc\n\ndef"), Some(3));
        assert_eq!(find_double_newline(b"no-blank-line"), None);
    }
}
