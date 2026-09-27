//! OpenAI Codex CLI subprocess provider (`codex exec`).
//!
//! Spawns `codex exec --json -C <cwd> [-m <model>] [resume <id>]
//! <prompt>`. The CLI streams newline-delimited JSON events; we
//! translate the shapes we care about into [`AgentEvent`]s and drop
//! the rest.
//!
//! ## Authentication
//!
//! Like Claude / opencode / kimi, we delegate entirely to the user's
//! local CLI auth (`codex login`). No keys flow through AgentGrove.
//!
//! ## Event stream (`codex exec --json`)
//!
//! One JSON object per line, keyed by `type`:
//! - `thread.started` → `{ "thread_id": "<uuid>" }` — the session id
//!   for resume. Emitted first, so it maps cleanly to
//!   [`AgentEvent::SessionStart`].
//! - `turn.started` — ignored.
//! - `item.completed` with `item.type == "agent_message"` →
//!   [`AgentEvent::Token`] (Codex emits the whole message at once, not
//!   per-token).
//! - `item.type == "reasoning"` → [`AgentEvent::Thinking`] (only when
//!   the model surfaces reasoning items).
//! - `item.type == "command_execution"` → [`AgentEvent::ToolCall`] on
//!   `item.started`, [`AgentEvent::ToolResult`] on `item.completed`.
//! - `item.type == "error"` → [`AgentEvent::Error`].
//! - `turn.completed` → [`AgentEvent::Done`] (carries token usage, no
//!   USD cost).
//! - `turn.failed` / top-level `{ "type": "error" }` →
//!   [`AgentEvent::Error`].
//!
//! Note: `codex exec` exits 0 even on a failed turn, so completion vs
//! failure is decided by the `turn.completed` / `turn.failed` events,
//! never the process exit status.
//!
//! ## Session resume
//!
//! `codex exec resume <uuid> <prompt>` replays a prior thread. We pass
//! the id captured from the previous turn's `thread.started`.
//!
//! ## Sandbox
//!
//! `codex exec` sandboxes model-run shell commands and prompts for
//! approval on a TTY — which AgentGrove never allocates, so an
//! unapproved command would stall. We pass
//! `--dangerously-bypass-approvals-and-sandbox` when tool
//! auto-approval is on (the same intent as Claude's
//! `--dangerously-skip-permissions`); otherwise we run `read-only`.

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

const BINARY_NAME: &str = "codex";
const INSTALL_HINT: &str = "https://github.com/openai/codex#installation";

/// Concrete [`AgentProvider`] backed by the `codex` CLI.
#[derive(Debug, Default, Clone)]
pub struct CodexProvider;

impl CodexProvider {
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
    // "codex-cli 0.146.1" -> "0.146.1"
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    raw.split_whitespace().next_back().map(str::to_string)
}

/// The model ids `codex` knows are usable for the logged-in account,
/// read from `$CODEX_HOME/models_cache.json` (the CLI refreshes this
/// itself). The shape is `{ "models": [ { "id": "gpt-5.6-sol", … }, … ] }`.
/// Hardcoding ids is wrong: a ChatGPT-account login only accepts the
/// models tied to that account (e.g. `gpt-5.6-*`), not the API-plan
/// ids — picking an unsupported one fails the whole turn with a 400.
async fn read_models() -> Vec<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| directories_next::BaseDirs::new().map(|b| b.home_dir().join(".codex")));
    let Some(dir) = home else {
        return Vec::new();
    };
    let path = dir.join("models_cache.json");
    let Ok(text) = tokio::fs::read_to_string(&path).await else {
        return Vec::new();
    };
    parse_models(&text)
}

/// Extract user-pickable model slugs from the models-cache JSON. Each
/// entry keys its id under `slug` and marks pickability with
/// `visibility` (`"list"` = show, `"hide"` = internal like
/// `gpt-reserve` / `codex-auto-review`). We keep only visible ones so
/// the dropdown never offers a model the account can't run.
fn parse_models(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| {
                    // Default to visible when the field is absent so a
                    // future shape drop doesn't hide everything.
                    m.get("visibility").and_then(|x| x.as_str()).unwrap_or("list") != "hide"
                })
                .filter_map(|m| m.get("slug").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl AgentProvider for CodexProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Codex
    }

    async fn detect(&self) -> ProviderDescriptor {
        let path = find_binary();
        let version = match &path {
            Some(p) => read_version(p).await,
            None => None,
        };
        let models = crate::models_cache::get_or_fetch(
            ProviderId::Codex,
            crate::models_cache::DEFAULT_TTL,
            || async {
                let m = read_models().await;
                if m.is_empty() {
                    Err("no models in ~/.codex/models_cache.json".to_string())
                } else {
                    Ok(m)
                }
            },
        )
        .await;
        ProviderDescriptor {
            id: ProviderId::Codex,
            label: "Codex".to_string(),
            available: path.is_some(),
            path,
            version,
            // Empty default → omit `-m` so the CLI applies its own
            // account default rather than a stale id we hard-code (a
            // wrong id fails a ChatGPT-account turn with a 400).
            default_model: String::new(),
            models,
            supports_resume: true,
            supports_current_os: crate::supports_current_os(crate::provider_os_support("codex")),
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let path = find_binary().ok_or_else(|| ProviderError::NotInstalled {
            provider: "Codex".into(),
            hint: INSTALL_HINT.into(),
        })?;

        let mut cmd = Command::new(&path);
        cmd.arg("exec").arg("--json").arg("--skip-git-repo-check");
        if opts.auto_approve_tools {
            cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        } else {
            cmd.arg("--sandbox").arg("read-only");
        }
        cmd.arg("-C").arg(&opts.cwd);
        if let Some(m) = opts.model.as_deref().filter(|m| !m.is_empty()) {
            cmd.arg("--model").arg(m);
        }
        // Resume uses the `resume <id>` subcommand form; the prompt is
        // the trailing positional either way.
        if let Some(session) = opts.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("resume").arg(session);
        }
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
            "spawning codex"
        );

        let mut child = cmd.spawn().map_err(|source| ProviderError::Spawn {
            provider: "Codex".into(),
            source,
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Io(std::io::Error::other("no stdout on child")))?;
        let events_for_stdout = events.clone();
        // Whether the stream carried its own terminal event
        // (turn.completed / turn.failed / error). If it did, we don't
        // synthesise one from the exit status.
        let terminated = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let terminated_w = terminated.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut tool_names: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => {
                        for ev in translate(&v, &mut tool_names) {
                            if matches!(ev, AgentEvent::Done { .. } | AgentEvent::Error { .. }) {
                                terminated_w.store(true, std::sync::atomic::Ordering::SeqCst);
                            }
                            let _ = events_for_stdout.send(ev);
                        }
                    }
                    Err(e) => warn!(error = %e, line = %line, "codex: unparseable line"),
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
                    // The models-cache warning is noise on every run.
                    if line.is_empty() || line.contains("Reading additional input") {
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
        // one. `codex exec` exits 0 even on turn failure, so trust the
        // in-stream turn.completed / turn.failed over the exit code.
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
                    .map(|g| g.iter().rev().take(4).rev().cloned().collect::<Vec<_>>().join(" "))
                    .filter(|s| !s.is_empty());
                let msg = match tail {
                    Some(s) => format!("codex failed: {}", s.chars().take(300).collect::<String>()),
                    None => format!("codex exited with status {status}"),
                };
                let _ = events.send(AgentEvent::Error { message: msg });
            }
        }

        Ok(())
    }
}

/// Translate one `codex exec --json` line into zero or more
/// [`AgentEvent`]s. See the module docs for the event vocabulary.
fn translate(
    v: &serde_json::Value,
    tool_names: &mut std::collections::HashMap<String, String>,
) -> Vec<AgentEvent> {
    let Some(ty) = v.get("type").and_then(|x| x.as_str()) else {
        return vec![];
    };
    match ty {
        "thread.started" => v
            .get("thread_id")
            .and_then(|x| x.as_str())
            .map(|id| {
                vec![AgentEvent::SessionStart {
                    session_id: id.to_string(),
                }]
            })
            .unwrap_or_default(),
        "item.started" | "item.completed" => translate_item(ty, v.get("item"), tool_names),
        "turn.completed" => vec![AgentEvent::Done {
            result: None,
            cost_usd: None,
        }],
        "turn.failed" => {
            let msg = v
                .pointer("/error/message")
                .and_then(|x| x.as_str())
                .unwrap_or("codex turn failed")
                .to_string();
            vec![AgentEvent::Error { message: msg }]
        }
        "error" => {
            let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("codex error")
                .to_string();
            vec![AgentEvent::Error { message: msg }]
        }
        _ => vec![],
    }
}

/// Translate an `item.*` envelope's inner `item` object.
fn translate_item(
    envelope: &str,
    item: Option<&serde_json::Value>,
    tool_names: &mut std::collections::HashMap<String, String>,
) -> Vec<AgentEvent> {
    let Some(item) = item else { return vec![] };
    let item_type = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match item_type {
        // Whole assistant message arrives on completion.
        "agent_message" if envelope == "item.completed" => item
            .get("text")
            .and_then(|x| x.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| {
                vec![AgentEvent::Token {
                    text: t.to_string(),
                }]
            })
            .unwrap_or_default(),
        "reasoning" if envelope == "item.completed" => item
            .get("text")
            .and_then(|x| x.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| {
                vec![AgentEvent::Thinking {
                    text: t.to_string(),
                }]
            })
            .unwrap_or_default(),
        "command_execution" => {
            let id = item.get("id").and_then(|x| x.as_str()).map(String::from);
            let command = item.get("command").and_then(|x| x.as_str()).unwrap_or("");
            if envelope == "item.started" {
                if let Some(i) = &id {
                    tool_names.insert(i.clone(), "shell".to_string());
                }
                vec![AgentEvent::ToolCall {
                    name: "shell".to_string(),
                    args: serde_json::json!({ "command": command }),
                    id,
                }]
            } else {
                let output = item
                    .get("aggregated_output")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let exit = item.get("exit_code").and_then(|x| x.as_i64());
                vec![AgentEvent::ToolResult {
                    name: "shell".to_string(),
                    result: serde_json::json!({ "exit_code": exit, "output": output }),
                    id,
                }]
            }
        }
        "error" => item
            .get("message")
            .and_then(|x| x.as_str())
            .map(|m| {
                vec![AgentEvent::Error {
                    message: m.to_string(),
                }]
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh() -> std::collections::HashMap<String, String> {
        std::collections::HashMap::new()
    }

    #[test]
    fn thread_started_becomes_session_start() {
        let mut n = fresh();
        let evs = translate(&json!({"type":"thread.started","thread_id":"abc-123"}), &mut n);
        assert_eq!(
            evs,
            vec![AgentEvent::SessionStart {
                session_id: "abc-123".into()
            }]
        );
    }

    #[test]
    fn agent_message_completed_becomes_token() {
        let mut n = fresh();
        let line = json!({
            "type": "item.completed",
            "item": { "id": "item_0", "type": "agent_message", "text": "Hello!" }
        });
        assert_eq!(
            translate(&line, &mut n),
            vec![AgentEvent::Token {
                text: "Hello!".into()
            }]
        );
    }

    #[test]
    fn command_execution_start_and_complete_become_toolcall_and_result() {
        let mut n = fresh();
        let start = json!({
            "type": "item.started",
            "item": { "id": "item_1", "type": "command_execution", "command": "ls", "status": "in_progress" }
        });
        assert_eq!(
            translate(&start, &mut n),
            vec![AgentEvent::ToolCall {
                name: "shell".into(),
                args: json!({ "command": "ls" }),
                id: Some("item_1".into())
            }]
        );
        let done = json!({
            "type": "item.completed",
            "item": { "id": "item_1", "type": "command_execution", "command": "ls",
                      "aggregated_output": "file.txt\n", "exit_code": 0, "status": "completed" }
        });
        assert_eq!(
            translate(&done, &mut n),
            vec![AgentEvent::ToolResult {
                name: "shell".into(),
                result: json!({ "exit_code": 0, "output": "file.txt\n" }),
                id: Some("item_1".into())
            }]
        );
    }

    #[test]
    fn turn_completed_is_done_and_turn_failed_is_error() {
        let mut n = fresh();
        assert_eq!(
            translate(&json!({"type":"turn.completed","usage":{}}), &mut n),
            vec![AgentEvent::Done {
                result: None,
                cost_usd: None
            }]
        );
        let fail = json!({"type":"turn.failed","error":{"message":"boom"}});
        assert_eq!(
            translate(&fail, &mut n),
            vec![AgentEvent::Error {
                message: "boom".into()
            }]
        );
    }

    #[test]
    fn top_level_error_and_item_error_become_error() {
        let mut n = fresh();
        assert_eq!(
            translate(&json!({"type":"error","message":"bad"}), &mut n),
            vec![AgentEvent::Error {
                message: "bad".into()
            }]
        );
        let item_err = json!({
            "type": "item.completed",
            "item": { "id": "item_0", "type": "error", "message": "model not found" }
        });
        assert_eq!(
            translate(&item_err, &mut n),
            vec![AgentEvent::Error {
                message: "model not found".into()
            }]
        );
    }

    #[test]
    fn turn_started_and_unknown_are_dropped() {
        let mut n = fresh();
        assert!(translate(&json!({"type":"turn.started"}), &mut n).is_empty());
        assert!(translate(&json!({"type":"whatever"}), &mut n).is_empty());
    }

    #[test]
    fn version_string_takes_last_token() {
        assert_eq!("codex-cli 0.146.1".split_whitespace().next_back(), Some("0.146.1"));
    }

    #[test]
    fn parse_models_reads_visible_slugs_and_tolerates_drift() {
        let text = r#"{"fetched_at":"x","models":[
            {"slug":"gpt-reserve","visibility":"hide"},
            {"slug":"gpt-5.6-sol","visibility":"list"},
            {"slug":"gpt-5.5"},
            {"display_name":"no slug here","visibility":"list"}
        ]}"#;
        // gpt-reserve hidden; the no-slug entry dropped; missing
        // visibility defaults to visible.
        assert_eq!(parse_models(text), vec!["gpt-5.6-sol".to_string(), "gpt-5.5".to_string()]);
        assert!(parse_models("not json").is_empty());
        assert!(parse_models("{}").is_empty());
    }
}
