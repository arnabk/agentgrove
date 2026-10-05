//! Kiro CLI subprocess provider (`kiro-cli chat`).
//!
//! Spawns `kiro-cli chat --no-interactive --output-format stream-json
//! [--model <id>] [--effort <level>] [--resume-id <id>]
//! [-a | --trust-tools=] <prompt>`. The CLI streams newline-delimited
//! ACP events; we translate the shapes we care about into
//! [`AgentEvent`]s and drop the rest.
//!
//! ## Authentication
//!
//! Like Claude / opencode / codex, we delegate entirely to the user's
//! local CLI auth (`kiro-cli login`). No keys flow through AgentGrove.
//!
//! ## Event stream (`--output-format stream-json`)
//!
//! One JSON object per line, keyed by `type`:
//! - `runStarted` — ignored (protocol banner).
//! - `metadata` → carries `data.sessionId`. The first one maps to
//!   [`AgentEvent::SessionStart`] (used for resume); later ones carry
//!   usage/metering and are otherwise ignored.
//! - `sessionUpdate` with `data.update.sessionUpdate`:
//!   - `agent_message_chunk` → [`AgentEvent::Token`] (streamed per
//!     chunk via `content.text`).
//!   - `agent_thought_chunk` → [`AgentEvent::Thinking`].
//!   - `tool_call` → [`AgentEvent::ToolCall`] (`toolCallId`, `title`,
//!     `kind`, `rawInput`).
//!   - `tool_call_update` with `status == "completed"` →
//!     [`AgentEvent::ToolResult`] (`rawOutput`).
//! - `runFinished` → [`AgentEvent::Done`] (`finalText`).
//! - `runError` → [`AgentEvent::Error`] (`message`); the process also
//!   exits non-zero in this case.
//!
//! ## Session resume
//!
//! `kiro-cli chat --resume-id <uuid> <prompt>` replays a prior
//! conversation. We pass the id captured from the previous turn's
//! first `metadata.sessionId`.
//!
//! ## Tool approval
//!
//! `kiro-cli chat` prompts for tool approval on a TTY, which
//! AgentGrove never allocates — so an unapproved tool would stall. We
//! pass `--trust-all-tools` when tool auto-approval is on (the same
//! intent as Claude's `--dangerously-skip-permissions`); otherwise we
//! trust no tools via `--trust-tools=`.

use crate::{
    AgentEvent, AgentProvider, ProviderDescriptor, ProviderError, ProviderId, SpawnOptions,
};
use async_trait::async_trait;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::{debug, warn};

const BINARY_NAME: &str = "kiro-cli";
const INSTALL_HINT: &str = "https://kiro.dev/docs/cli/";

/// Concrete [`AgentProvider`] backed by the `kiro-cli` CLI.
#[derive(Debug, Default, Clone)]
pub struct KiroProvider;

impl KiroProvider {
    /// Construct a provider. Cheap; detection happens in
    /// [`AgentProvider::detect`].
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
    // "kiro-cli 2.26.1" -> "2.26.1"
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    raw.split_whitespace().next_back().map(str::to_string)
}

/// The model ids `kiro-cli` offers for the logged-in account, read via
/// `kiro-cli chat --list-models --format json`. The shape is
/// `{ "models": [ { "model_id": "claude-sonnet-5", … }, … ],
/// "default_model": "auto" }`.
async fn read_models(path: &std::path::Path) -> Vec<String> {
    let out = Command::new(path)
        .arg("chat")
        .arg("--list-models")
        .arg("--format")
        .arg("json")
        .output()
        .await
        .ok();
    let Some(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_models(&text)
}

/// Extract `model_id`s from the `--list-models --format json` output.
fn parse_models(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("model_id").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl AgentProvider for KiroProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Kiro
    }

    async fn detect(&self) -> ProviderDescriptor {
        let path = find_binary();
        let version = match &path {
            Some(p) => read_version(p).await,
            None => None,
        };
        let models = match &path {
            Some(p) => {
                let p = p.clone();
                crate::models_cache::get_or_fetch(
                    ProviderId::Kiro,
                    crate::models_cache::DEFAULT_TTL,
                    || async move {
                        let m = read_models(&p).await;
                        if m.is_empty() {
                            Err("kiro-cli --list-models returned no entries".to_string())
                        } else {
                            Ok(m)
                        }
                    },
                )
                .await
            }
            None => Vec::new(),
        };
        ProviderDescriptor {
            id: ProviderId::Kiro,
            label: "Kiro".to_string(),
            available: path.is_some(),
            path,
            version,
            // Empty default → omit `--model` so the CLI applies its own
            // account default ("auto") rather than a stale id we hard-code.
            default_model: String::new(),
            models,
            supports_resume: true,
            supports_current_os: crate::supports_current_os(crate::provider_os_support("kiro")),
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let path = find_binary().ok_or_else(|| ProviderError::NotInstalled {
            provider: "Kiro".into(),
            hint: INSTALL_HINT.into(),
        })?;

        let mut cmd = Command::new(&path);
        cmd.arg("chat")
            .arg("--no-interactive")
            .arg("--output-format")
            .arg("stream-json");
        if opts.auto_approve_tools {
            cmd.arg("--trust-all-tools");
        } else {
            // Trust no tools: the model can't run anything without a
            // TTY approval prompt we never show.
            cmd.arg("--trust-tools=");
        }
        if let Some(m) = opts.model.as_deref().filter(|m| !m.is_empty()) {
            cmd.arg("--model").arg(m);
        }
        if let Some(e) = opts.effort.as_deref().filter(|e| !e.is_empty()) {
            cmd.arg("--effort").arg(e);
        }
        if let Some(session) = opts.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--resume-id").arg(session);
        }
        // Prompt is the trailing positional argument.
        cmd.arg(prompt);
        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        debug!(
            cwd = %opts.cwd.display(),
            model = ?opts.model,
            resume = ?opts.resume_session_id,
            "spawning kiro-cli"
        );

        let mut child = cmd.spawn().map_err(|source| ProviderError::Spawn {
            provider: "Kiro".into(),
            source,
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Io(std::io::Error::other("no stdout on child")))?;
        let events_for_stdout = events.clone();
        // Whether the stream carried its own terminal event
        // (runFinished / runError). If it did, we don't synthesise one
        // from the exit status.
        let terminated = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let terminated_w = terminated.clone();
        // Track which `sessionUpdate` was the first metadata so only
        // that one becomes SessionStart.
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut session_announced = false;
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => {
                        for ev in translate(&v, &mut session_announced) {
                            if matches!(ev, AgentEvent::Done { .. } | AgentEvent::Error { .. }) {
                                terminated_w.store(true, std::sync::atomic::Ordering::SeqCst);
                            }
                            let _ = events_for_stdout.send(ev);
                        }
                    }
                    Err(e) => warn!(error = %e, line = %line, "kiro-cli: unparseable line"),
                }
            }
        });

        let stderr = child.stderr.take();
        let stderr_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stderr_capture = stderr_lines.clone();
        let stderr_task = stderr.map(|stderr| {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(mut guard) = stderr_capture.lock() {
                        guard.push(line.to_string());
                    }
                }
            })
        });

        let status = child.wait().await?;
        let _ = stdout_task.await;
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        // Only synthesise a terminal event when the stream didn't carry
        // one (e.g. the process died before emitting runFinished).
        if !terminated.load(std::sync::atomic::Ordering::SeqCst) {
            if status.success() {
                let _ = events.send(AgentEvent::Done {
                    result: None,
                    cost_usd: None,
                });
            } else {
                let tail = stderr_lines
                    .lock()
                    .ok()
                    .map(|g| {
                        g.iter()
                            .rev()
                            .take(4)
                            .rev()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .filter(|s| !s.is_empty());
                let msg = match tail {
                    Some(s) => {
                        format!(
                            "kiro-cli failed: {}",
                            s.chars().take(300).collect::<String>()
                        )
                    }
                    None => format!("kiro-cli exited with status {status}"),
                };
                let _ = events.send(AgentEvent::Error { message: msg });
            }
        }

        Ok(())
    }
}

/// Translate one `--output-format stream-json` line into zero or more
/// [`AgentEvent`]s. `session_announced` tracks whether we've already
/// emitted [`AgentEvent::SessionStart`] (only the first `metadata`
/// line's `sessionId` should). See the module docs for the vocabulary.
fn translate(v: &serde_json::Value, session_announced: &mut bool) -> Vec<AgentEvent> {
    let Some(ty) = v.get("type").and_then(|x| x.as_str()) else {
        return vec![];
    };
    match ty {
        "metadata" => {
            if *session_announced {
                return vec![];
            }
            v.pointer("/data/sessionId")
                .and_then(|x| x.as_str())
                .map(|id| {
                    *session_announced = true;
                    vec![AgentEvent::SessionStart {
                        session_id: id.to_string(),
                    }]
                })
                .unwrap_or_default()
        }
        "sessionUpdate" => translate_session_update(v.pointer("/data/update")),
        "runFinished" => {
            let result = v
                .pointer("/data/finalText")
                .and_then(|x| x.as_str())
                .filter(|t| !t.is_empty())
                .map(String::from);
            vec![AgentEvent::Done {
                result,
                cost_usd: None,
            }]
        }
        "runError" => {
            let msg = v
                .pointer("/data/message")
                .and_then(|x| x.as_str())
                .unwrap_or("kiro-cli run error")
                .to_string();
            vec![AgentEvent::Error { message: msg }]
        }
        _ => vec![],
    }
}

/// Translate a `sessionUpdate` envelope's inner `update` object.
fn translate_session_update(update: Option<&serde_json::Value>) -> Vec<AgentEvent> {
    let Some(update) = update else { return vec![] };
    let kind = update
        .get("sessionUpdate")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => update
            .pointer("/content/text")
            .and_then(|x| x.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| {
                vec![AgentEvent::Token {
                    text: t.to_string(),
                }]
            })
            .unwrap_or_default(),
        "agent_thought_chunk" => update
            .pointer("/content/text")
            .and_then(|x| x.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| {
                vec![AgentEvent::Thinking {
                    text: t.to_string(),
                }]
            })
            .unwrap_or_default(),
        "tool_call" => {
            let id = update
                .get("toolCallId")
                .and_then(|x| x.as_str())
                .map(String::from);
            let name = update
                .get("kind")
                .and_then(|x| x.as_str())
                .or_else(|| update.get("title").and_then(|x| x.as_str()))
                .unwrap_or("tool")
                .to_string();
            let args = update
                .get("rawInput")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            vec![AgentEvent::ToolCall { name, args, id }]
        }
        "tool_call_update" => {
            // Only emit a result once the tool call completes.
            let status = update.get("status").and_then(|x| x.as_str()).unwrap_or("");
            if status != "completed" {
                return vec![];
            }
            let id = update
                .get("toolCallId")
                .and_then(|x| x.as_str())
                .map(String::from);
            let name = update
                .get("kind")
                .and_then(|x| x.as_str())
                .unwrap_or("tool")
                .to_string();
            let result = update
                .get("rawOutput")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            vec![AgentEvent::ToolResult { name, result, id }]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_metadata_becomes_session_start_once() {
        let mut announced = false;
        let line = json!({"type":"metadata","data":{"sessionId":"abc-123"}});
        assert_eq!(
            translate(&line, &mut announced),
            vec![AgentEvent::SessionStart {
                session_id: "abc-123".into()
            }]
        );
        // Subsequent metadata lines don't re-announce.
        let again = json!({"type":"metadata","data":{"sessionId":"abc-123","turnDurationMs":10}});
        assert!(translate(&again, &mut announced).is_empty());
    }

    #[test]
    fn agent_message_chunk_becomes_token() {
        let mut announced = true;
        let line = json!({
            "type":"sessionUpdate",
            "data":{"sessionId":"s","update":{
                "sessionUpdate":"agent_message_chunk",
                "content":{"type":"text","text":"pong"}
            }}
        });
        assert_eq!(
            translate(&line, &mut announced),
            vec![AgentEvent::Token {
                text: "pong".into()
            }]
        );
    }

    #[test]
    fn agent_thought_chunk_becomes_thinking() {
        let mut announced = true;
        let line = json!({
            "type":"sessionUpdate",
            "data":{"update":{
                "sessionUpdate":"agent_thought_chunk",
                "content":{"type":"text","text":"I'll check"}
            }}
        });
        assert_eq!(
            translate(&line, &mut announced),
            vec![AgentEvent::Thinking {
                text: "I'll check".into()
            }]
        );
    }

    #[test]
    fn tool_call_and_completed_update_become_call_and_result() {
        let mut announced = true;
        let call = json!({
            "type":"sessionUpdate",
            "data":{"update":{
                "sessionUpdate":"tool_call",
                "toolCallId":"toolu_1",
                "title":"Reading listing",
                "kind":"read",
                "rawInput":{"operations":[{"mode":"Directory","path":"/tmp"}]}
            }}
        });
        assert_eq!(
            translate(&call, &mut announced),
            vec![AgentEvent::ToolCall {
                name: "read".into(),
                args: json!({"operations":[{"mode":"Directory","path":"/tmp"}]}),
                id: Some("toolu_1".into())
            }]
        );
        let update = json!({
            "type":"sessionUpdate",
            "data":{"update":{
                "sessionUpdate":"tool_call_update",
                "toolCallId":"toolu_1",
                "kind":"read",
                "status":"completed",
                "rawOutput":{"items":[{"Text":"file.txt"}]}
            }}
        });
        assert_eq!(
            translate(&update, &mut announced),
            vec![AgentEvent::ToolResult {
                name: "read".into(),
                result: json!({"items":[{"Text":"file.txt"}]}),
                id: Some("toolu_1".into())
            }]
        );
    }

    #[test]
    fn in_progress_tool_update_is_dropped() {
        let mut announced = true;
        let update = json!({
            "type":"sessionUpdate",
            "data":{"update":{
                "sessionUpdate":"tool_call_update",
                "toolCallId":"toolu_1",
                "status":"in_progress"
            }}
        });
        assert!(translate(&update, &mut announced).is_empty());
    }

    #[test]
    fn run_finished_is_done_with_final_text() {
        let mut announced = true;
        let line = json!({
            "type":"runFinished",
            "data":{"sessionId":"s","status":"success","stopReason":"end_turn","finalText":"pong"}
        });
        assert_eq!(
            translate(&line, &mut announced),
            vec![AgentEvent::Done {
                result: Some("pong".into()),
                cost_usd: None
            }]
        );
    }

    #[test]
    fn run_error_becomes_error() {
        let mut announced = true;
        let line = json!({
            "type":"runError",
            "data":{"sessionId":"s","stage":"prompt","message":"boom"}
        });
        assert_eq!(
            translate(&line, &mut announced),
            vec![AgentEvent::Error {
                message: "boom".into()
            }]
        );
    }

    #[test]
    fn run_started_and_unknown_are_dropped() {
        let mut announced = false;
        assert!(translate(&json!({"type":"runStarted","data":{}}), &mut announced).is_empty());
        assert!(translate(&json!({"type":"whatever"}), &mut announced).is_empty());
    }

    #[test]
    fn parse_models_reads_model_ids_and_tolerates_drift() {
        let text = r#"{"models":[
            {"model_name":"auto","model_id":"auto"},
            {"model_name":"Claude Sonnet 5","model_id":"claude-sonnet-5"},
            {"model_name":"no id here"}
        ],"default_model":"auto"}"#;
        assert_eq!(
            parse_models(text),
            vec!["auto".to_string(), "claude-sonnet-5".to_string()]
        );
        assert!(parse_models("not json").is_empty());
        assert!(parse_models("{}").is_empty());
    }

    #[test]
    fn version_string_takes_last_token() {
        assert_eq!(
            "kiro-cli 2.26.1".split_whitespace().next_back(),
            Some("2.26.1")
        );
    }
}
