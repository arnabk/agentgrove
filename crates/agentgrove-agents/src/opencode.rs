//! Opencode CLI subprocess provider.
//!
//! Spawns `opencode run --format json -m <model> <prompt>`. The CLI
//! emits one JSON object per line on stdout; we translate the shapes
//! we care about ([`AgentEvent::Token`], [`AgentEvent::ToolCall`],
//! [`AgentEvent::ToolResult`], [`AgentEvent::SessionStart`],
//! [`AgentEvent::Done`]) and drop the rest.
//!
//! ## Authentication
//!
//! Like Claude, we delegate entirely to the user's local CLI auth
//! (the `opencode providers` configuration). No keys flow through
//! AgentGrove.
//!
//! ## Models
//!
//! `opencode models` lists every provider/model the user has
//! configured. We live-fetch via `opencode models` (cached via
//! [`crate::models_cache`]) and fall back to a small curated set of
//! built-in opencode models when the CLI isn't on PATH or the
//! command fails. Users with custom configs can still type any
//! `provider/model` string in the per-chat settings dialog.

use crate::{
    AgentEvent, AgentProvider, ProviderDescriptor, ProviderError, ProviderId, SlashCommand,
    SpawnOptions,
};
use async_trait::async_trait;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::{debug, warn};

const BINARY_NAME: &str = "opencode";
const INSTALL_HINT: &str = "https://opencode.ai/docs/install";

/// Default model when the user hasn't picked one. `opencode/big-pickle`
/// is the built-in flagship that ships with the CLI.
const DEFAULT_MODEL: &str = "opencode/big-pickle";

/// Fallback model list used when `opencode models` fails or the
/// binary isn't on PATH. Kept minimal so the dropdown still shows
/// something usable rather than an empty list.
const FALLBACK_MODELS: &[&str] = &[
    "opencode/big-pickle",
    "opencode/deepseek-v4-flash-free",
    "opencode/nemotron-3-super-free",
];

/// Run `opencode models` and split stdout into one model id per
/// line. Returns `Err` with a human-readable reason on failure so
/// the cache layer can keep serving a previous good entry.
async fn fetch_models_live(binary: &std::path::Path) -> Result<Vec<String>, String> {
    let out = Command::new(binary)
        .arg("models")
        .output()
        .await
        .map_err(|e| format!("spawn opencode models: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "opencode models exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let models: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if models.is_empty() {
        return Err("opencode models returned no entries".into());
    }
    Ok(models)
}

/// Concrete [`AgentProvider`] backed by the `opencode` CLI.
#[derive(Debug, Default, Clone)]
pub struct OpencodeProvider;

impl OpencodeProvider {
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
        // Live-fetch the model list via the cache. When the binary
        // isn't on PATH we skip the fetch entirely (no closure) and
        // serve the curated fallback so the dropdown still has
        // something to show in the dialog before the user installs.
        let models: Vec<String> = if let Some(p) = path.as_ref() {
            let p_owned = p.clone();
            let live = crate::models_cache::get_or_fetch(
                ProviderId::Opencode,
                crate::models_cache::DEFAULT_TTL,
                move || async move { fetch_models_live(&p_owned).await },
            )
            .await;
            if live.is_empty() {
                FALLBACK_MODELS.iter().map(|s| (*s).to_string()).collect()
            } else {
                live
            }
        } else {
            FALLBACK_MODELS.iter().map(|s| (*s).to_string()).collect()
        };
        ProviderDescriptor {
            id: ProviderId::Opencode,
            label: "opencode".to_string(),
            available: path.is_some(),
            path,
            version,
            default_model: DEFAULT_MODEL.to_string(),
            models,
            // Session resume is supported via `--session <id>`. We
            // always pair it with `--dir <cwd>` on the spawn so
            // opencode's cwd-rebinding (it normally resumes against
            // the session's original project record) doesn't drift
            // worktree chats into the wrong tree. See `spawn()` for
            // the rationale + flag wiring.
            supports_resume: true,
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let path = find_binary().ok_or_else(|| ProviderError::NotInstalled {
            provider: "opencode".into(),
            hint: INSTALL_HINT.into(),
        })?;

        let model = opts.model.as_deref().unwrap_or(DEFAULT_MODEL);
        let mut cmd = Command::new(&path);
        cmd.arg("run")
            .arg("--format")
            .arg("json")
            .arg("-m")
            .arg(model);
        // `--thinking` is opt-in via `effort`. Several opencode-
        // routable models (notably the 9router endpoints) hang for
        // 60+ seconds when the flag is set even though they don't
        // surface a reasoning trace — they end up waiting for an
        // upstream stream that never arrives. Gating on `effort`
        // matches the Claude integration (which uses `effort` to
        // unlock extended-thinking output) and keeps the default
        // path fast.
        if opts.effort.is_some() {
            cmd.arg("--thinking");
        }
        // Always pin opencode's working directory via `--dir`.
        // Without this `--session` resume would land tool calls in
        // the directory the session was ORIGINALLY created against
        // (opencode binds sessions to a canonicalised project-path
        // hash and otherwise ignores the spawn cwd on resume). With
        // `--dir` set, opencode honours it for both fresh and
        // resumed sessions, so worktree-scoped chats stay scoped.
        // We also keep `cmd.current_dir()` set below so non-flag
        // path resolution (relative attachments, etc.) works.
        cmd.arg("--dir").arg(&opts.cwd);
        if let Some(session) = opts.resume_session_id.as_deref() {
            cmd.arg("--session").arg(session);
        }
        if opts.auto_approve_tools {
            // Same rationale as Claude: opencode's permission
            // prompts assume a TTY; we never give it one. Without
            // this the run sits forever on the first tool call.
            cmd.arg("--dangerously-skip-permissions");
        }
        // End flag parsing with `--` so a markdown bullet-list /
        // dash-prefixed prompt isn't mistaken for a short option.
        cmd.arg("--").arg(prompt);
        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        debug!(
            cwd = %opts.cwd.display(),
            model = model,
            resume = ?opts.resume_session_id,
            "spawning opencode"
        );

        let mut child = cmd.spawn().map_err(|source| ProviderError::Spawn {
            provider: "opencode".into(),
            source,
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Io(std::io::Error::other("no stdout on child")))?;
        let events_for_stdout = events.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            // Track which session+message ids we've already emitted
            // SessionStart / text-as-token for, so retries don't
            // double-send.
            let mut session_announced: Option<String> = None;
            let mut last_text_per_part: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => {
                        for ev in translate(&v, &mut session_announced, &mut last_text_per_part) {
                            let _ = events_for_stdout.send(ev);
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, line = %line, "opencode: unparseable line");
                    }
                }
            }
        });

        let stderr = child.stderr.take();
        let events_for_stderr = events.clone();
        let stderr_task = if let Some(stderr) = stderr {
            Some(tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = events_for_stderr.send(AgentEvent::Error {
                        message: line.trim().to_string(),
                    });
                }
            }))
        } else {
            None
        };

        let status = child.wait().await?;
        let _ = stdout_task.await;
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        // opencode `run` doesn't emit a terminal `result`-style event
        // in `--format json` today; the stream simply ends when the
        // turn completes. Synthesise a `Done` so downstream logic
        // (FE spinner, persistence flush) knows the turn is over.
        if status.success() {
            let _ = events.send(AgentEvent::Done {
                result: None,
                cost_usd: None,
            });
        } else {
            let _ = events.send(AgentEvent::Error {
                message: format!("opencode exited with status {status}"),
            });
        }

        Ok(())
    }

    /// User + project Markdown commands. opencode doesn't ship a
    /// curated built-in slash set the way Claude does — its CLI
    /// surface is `opencode run [message..]` and that's about it.
    /// What users DO have is per-user + per-project command files
    /// in `~/.config/opencode/command/*.md` and
    /// `<cwd>/.opencode/command/*.md` (note singular `command`,
    /// not `commands` — opencode's convention).
    async fn slash_commands(&self, ctx: crate::SlashCommandContext<'_>) -> Vec<SlashCommand> {
        let mut out: Vec<SlashCommand> = Vec::new();
        // User-level: ~/.config/opencode/command/.
        if let Some(base) = directories_next::BaseDirs::new() {
            let user_dir = base.config_dir().join("opencode").join("command");
            out.extend(crate::slash_files::scan_markdown_commands(&user_dir));
        }
        // Project-level: <cwd>/.opencode/command/.
        if let Some(cwd) = ctx.cwd {
            let proj_dir = cwd.join(".opencode").join("command");
            // Dedupe by name: user-level wins. opencode itself
            // resolves with the same precedence today.
            let names: std::collections::HashSet<String> =
                out.iter().map(|c| c.name.clone()).collect();
            for c in crate::slash_files::scan_markdown_commands(&proj_dir) {
                if !names.contains(&c.name) {
                    out.push(c);
                }
            }
        }
        out
    }
}

/// Translate one JSON line from `opencode run --format json` into
/// zero or more [`AgentEvent`]s.
///
/// Observed event shapes:
///
/// - `{ type: "step_start", sessionID, part: { messageID, ... } }`
///   -> `SessionStart` (first occurrence only).
/// - `{ type: "text", sessionID, part: { id, messageID, text, ... } }`
///   -> `Token` for the **delta** since the last `text` event with
///   the same `part.id`. The CLI sends the cumulative text per part,
///   not deltas, so we diff against the last seen value.
/// - `{ type: "reasoning", part: { text } }` -> `Thinking`.
/// - `{ type: "tool", part: { id, tool, state: { input } } }`
///   -> `ToolCall`.
/// - `{ type: "tool", part: { id, tool, state: { status:"completed",
///        output } } }` -> `ToolResult`.
/// - `{ type: "step_finish" }` -> dropped (terminal `Done` is
///   synthesised in `spawn` on child exit).
fn translate(
    v: &serde_json::Value,
    session_announced: &mut Option<String>,
    last_text_per_part: &mut std::collections::HashMap<String, String>,
) -> Vec<AgentEvent> {
    let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
        return vec![];
    };
    match kind {
        "step_start" => {
            let Some(sid) = v.get("sessionID").and_then(|x| x.as_str()) else {
                return vec![];
            };
            if session_announced.as_deref() == Some(sid) {
                return vec![];
            }
            *session_announced = Some(sid.to_string());
            vec![AgentEvent::SessionStart {
                session_id: sid.to_string(),
            }]
        }
        "text" => {
            let part = match v.get("part") {
                Some(p) => p,
                None => return vec![],
            };
            let Some(part_id) = part.get("id").and_then(|x| x.as_str()) else {
                return vec![];
            };
            let Some(full) = part.get("text").and_then(|x| x.as_str()) else {
                return vec![];
            };
            let prev = last_text_per_part.get(part_id).cloned().unwrap_or_default();
            // Append-only stream in practice; if the new text starts
            // with the previous value emit only the delta, else emit
            // the whole new text (defensive against out-of-order or
            // edited parts).
            let delta = if full.starts_with(&prev) {
                full[prev.len()..].to_string()
            } else {
                full.to_string()
            };
            last_text_per_part.insert(part_id.to_string(), full.to_string());
            if delta.is_empty() {
                vec![]
            } else {
                vec![AgentEvent::Token { text: delta }]
            }
        }
        "reasoning" => {
            let text = v
                .pointer("/part/text")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if text.is_empty() {
                vec![]
            } else {
                vec![AgentEvent::Thinking {
                    text: text.to_string(),
                }]
            }
        }
        "tool" => translate_tool(v),
        _ => vec![],
    }
}

fn translate_tool(v: &serde_json::Value) -> Vec<AgentEvent> {
    let part = match v.get("part") {
        Some(p) => p,
        None => return vec![],
    };
    let name = part
        .get("tool")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let id = part.get("id").and_then(|x| x.as_str()).map(String::from);
    let state = part.get("state");
    let status = state
        .and_then(|s| s.get("status"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    match status {
        "completed" | "error" => {
            let result = state
                .and_then(|s| s.get("output"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            vec![AgentEvent::ToolResult { name, result, id }]
        }
        _ => {
            // running / pending / no-status -> treat as a call.
            let args = state
                .and_then(|s| s.get("input"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            vec![AgentEvent::ToolCall { name, args, id }]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh() -> (Option<String>, std::collections::HashMap<String, String>) {
        (None, std::collections::HashMap::new())
    }

    #[test]
    fn step_start_emits_session_start_once() {
        let line = json!({
            "type": "step_start",
            "sessionID": "ses_abc",
            "part": { "messageID": "msg_1" }
        });
        let (mut sess, mut parts) = fresh();
        let evs = translate(&line, &mut sess, &mut parts);
        assert_eq!(
            evs,
            vec![AgentEvent::SessionStart {
                session_id: "ses_abc".into()
            }]
        );
        // Second occurrence is a no-op.
        let evs2 = translate(&line, &mut sess, &mut parts);
        assert!(evs2.is_empty());
    }

    #[test]
    fn text_event_emits_delta_against_previous() {
        let (mut sess, mut parts) = fresh();
        let first = json!({
            "type": "text",
            "part": { "id": "prt_1", "text": "Hello" }
        });
        assert_eq!(
            translate(&first, &mut sess, &mut parts),
            vec![AgentEvent::Token {
                text: "Hello".into()
            }]
        );
        let second = json!({
            "type": "text",
            "part": { "id": "prt_1", "text": "Hello world" }
        });
        assert_eq!(
            translate(&second, &mut sess, &mut parts),
            vec![AgentEvent::Token {
                text: " world".into()
            }]
        );
    }

    #[test]
    fn text_event_with_unchanged_value_emits_nothing() {
        let (mut sess, mut parts) = fresh();
        let line = json!({
            "type": "text",
            "part": { "id": "prt_1", "text": "same" }
        });
        let _ = translate(&line, &mut sess, &mut parts);
        assert!(translate(&line, &mut sess, &mut parts).is_empty());
    }

    #[test]
    fn reasoning_becomes_thinking() {
        let (mut sess, mut parts) = fresh();
        let line = json!({
            "type": "reasoning",
            "part": { "text": "thinking through it" }
        });
        assert_eq!(
            translate(&line, &mut sess, &mut parts),
            vec![AgentEvent::Thinking {
                text: "thinking through it".into()
            }]
        );
    }

    #[test]
    fn tool_running_becomes_tool_call() {
        let (mut sess, mut parts) = fresh();
        let line = json!({
            "type": "tool",
            "part": {
                "id": "tl_1",
                "tool": "Read",
                "state": { "status": "running", "input": { "path": "x.rs" } }
            }
        });
        assert_eq!(
            translate(&line, &mut sess, &mut parts),
            vec![AgentEvent::ToolCall {
                name: "Read".into(),
                args: json!({ "path": "x.rs" }),
                id: Some("tl_1".into())
            }]
        );
    }

    #[test]
    fn tool_completed_becomes_tool_result() {
        let (mut sess, mut parts) = fresh();
        let line = json!({
            "type": "tool",
            "part": {
                "id": "tl_1",
                "tool": "Read",
                "state": { "status": "completed", "output": "fn main() {}" }
            }
        });
        assert_eq!(
            translate(&line, &mut sess, &mut parts),
            vec![AgentEvent::ToolResult {
                name: "Read".into(),
                result: json!("fn main() {}"),
                id: Some("tl_1".into())
            }]
        );
    }

    #[test]
    fn unknown_types_are_dropped_silently() {
        let (mut sess, mut parts) = fresh();
        let line = json!({ "type": "step_finish" });
        assert!(translate(&line, &mut sess, &mut parts).is_empty());
    }

    #[tokio::test]
    async fn detect_returns_descriptor() {
        let p = OpencodeProvider::new();
        let d = p.detect().await;
        assert_eq!(d.id, ProviderId::Opencode);
        assert_eq!(d.label, "opencode");
        assert_eq!(d.default_model, DEFAULT_MODEL);
        // Opencode resume is enabled, paired with `--dir <cwd>` to
        // override its session-bound cwd. See `detect`/`spawn`
        // docs for the full rationale.
        assert!(d.supports_resume);
        // `available` / `version` / `path` are environment-dependent.
    }
}
