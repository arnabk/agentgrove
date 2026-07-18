//! Kimi CLI subprocess provider (Moonshot AI's `kimi` agent CLI).
//!
//! Spawns `kimi --print --output-format stream-json --work-dir <cwd>
//! -p <prompt>`. The CLI buffers streamed content parts into whole
//! kosong `Message` objects and prints one JSON per line; we translate
//! the shapes we care about ([`AgentEvent::Token`],
//! [`AgentEvent::Thinking`], [`AgentEvent::ToolCall`],
//! [`AgentEvent::ToolResult`], [`AgentEvent::Done`]) and drop the rest
//! (Notifications, PlanDisplay, step markers).
//!
//! ## Authentication
//!
//! Like Claude / opencode, we delegate entirely to the user's local CLI
//! auth (`kimi login`). No keys flow through AgentGrove.
//!
//! ## MCP isolation
//!
//! kimi eagerly connects every server in `~/.kimi/mcp.json` at startup
//! and **aborts the whole run** when one fails (even in `--print`
//! mode). A single stale entry would make every AgentGrove chat fail
//! before the prompt is processed, so we always point the CLI at an
//! empty MCP config (`--mcp-config-file`) — runs are deterministic at
//! the cost of user MCP tools not being available inside AgentGrove
//! chats.
//!
//! ## Session resume
//!
//! kimi prints `To resume this session: kimi -r <id>` on **stderr** at
//! process exit (success or failure). We parse that line and emit
//! [`AgentEvent::SessionStart`] so the next turn can pass
//! `--session <id>`. The event lands after the last token rather than
//! before the first (unlike Claude's in-stream session id), which is
//! fine: the stored id is only consumed by the *next* dispatch.
//!
//! ## Models
//!
//! kimi has no `models` subcommand; the accepted ids live in
//! `~/.kimi/config.toml` as `[models."<id>"]` sections, with the CLI
//! default at top-level `default_model`. We parse both (cached via
//! [`crate::models_cache`]) and fall back to a single conservative
//! entry when the file is unreadable.

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

const BINARY_NAME: &str = "kimi";
const INSTALL_HINT: &str = "https://moonshotai.github.io/kimi-cli/";

/// Fallback when `~/.kimi/config.toml` is unreadable or declares no
/// models. `kimi-code/k3` is the managed flagship tier every kimi-code
/// account has today; users on other setups can still type any id in
/// the per-chat settings dialog.
const FALLBACK_MODEL: &str = "kimi-code/k3";

/// Marker the CLI prints on stderr when a session is resumable:
/// `To resume this session: kimi -r <id>`.
const RESUME_HINT: &str = "kimi -r ";

/// Concrete [`AgentProvider`] backed by the `kimi` CLI.
#[derive(Debug, Default, Clone)]
pub struct KimiProvider;

impl KimiProvider {
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
    // "kimi, version 1.49.0" -> "1.49.0"
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    raw.split_whitespace().next_back().map(str::to_string)
}

/// What we extract from `~/.kimi/config.toml`.
#[derive(Debug, Default)]
struct KimiConfig {
    default_model: Option<String>,
    models: Vec<String>,
}

/// Line-scan the config: top-level `default_model = "<id>"` plus one
/// `[models."<id>"]` header per declared model. A full TOML parse is
/// overkill for two keys and would pull a new dependency into the
/// crate.
fn parse_config(text: &str) -> KimiConfig {
    let mut cfg = KimiConfig::default();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("default_model") {
            if let Some((_, v)) = rest.split_once('=') {
                let v = v.trim().trim_matches('"');
                if !v.is_empty() {
                    cfg.default_model = Some(v.to_string());
                }
            }
        } else if let Some(inner) = line
            .strip_prefix("[models.\"")
            .and_then(|s| s.strip_suffix("\"]"))
        {
            if !inner.is_empty() {
                cfg.models.push(inner.to_string());
            }
        }
    }
    cfg
}

async fn read_config() -> KimiConfig {
    let Some(base) = directories_next::BaseDirs::new() else {
        return KimiConfig::default();
    };
    let path = base.home_dir().join(".kimi").join("config.toml");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => parse_config(&text),
        Err(_) => KimiConfig::default(),
    }
}

/// Path to a static empty MCP config, written on first use. See the
/// module-level "MCP isolation" note for why this exists.
async fn empty_mcp_config_path() -> Result<PathBuf, ProviderError> {
    let p = std::env::temp_dir().join("agentgrove-kimi-empty-mcp.json");
    if tokio::fs::metadata(&p).await.is_err() {
        tokio::fs::write(&p, "{\"mcpServers\":{}}\n").await?;
    }
    Ok(p)
}

/// Extract a session id from a stderr line carrying the resume hint.
/// Returns `None` for any other line.
fn parse_resume_hint(line: &str) -> Option<String> {
    let idx = line.find(RESUME_HINT)?;
    let id: String = line[idx + RESUME_HINT.len()..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    // Session ids are uuids; guard against truncating into a partial
    // token if the hint format drifts.
    if id.len() >= 32 { Some(id) } else { None }
}

#[async_trait]
impl AgentProvider for KimiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Kimi
    }

    async fn detect(&self) -> ProviderDescriptor {
        let path = find_binary();
        let version = match &path {
            Some(p) => read_version(p).await,
            None => None,
        };
        let live = crate::models_cache::get_or_fetch(
            ProviderId::Kimi,
            crate::models_cache::DEFAULT_TTL,
            || async {
                let cfg = read_config().await;
                if cfg.models.is_empty() {
                    Err("no [models.*] sections in ~/.kimi/config.toml".to_string())
                } else {
                    Ok(cfg.models)
                }
            },
        )
        .await;
        let models = if live.is_empty() {
            vec![FALLBACK_MODEL.to_string()]
        } else {
            live
        };
        // Default model: the CLI's own config default when known, else
        // the first discovered id, else the conservative fallback.
        let cfg_default = read_config().await.default_model;
        let default_model = cfg_default
            .or_else(|| models.first().cloned())
            .unwrap_or_else(|| FALLBACK_MODEL.to_string());
        ProviderDescriptor {
            id: ProviderId::Kimi,
            label: "Kimi".to_string(),
            available: path.is_some(),
            path,
            version,
            default_model,
            models,
            // Via `--session <id>`; the id is captured from the
            // stderr resume hint (see module docs).
            supports_resume: true,
            supports_current_os: crate::supports_current_os(crate::provider_os_support("kimi")),
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let path = find_binary().ok_or_else(|| ProviderError::NotInstalled {
            provider: "Kimi".into(),
            hint: INSTALL_HINT.into(),
        })?;
        let mcp_config = empty_mcp_config_path().await?;

        let mut cmd = Command::new(&path);
        cmd.arg("--print")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--mcp-config-file")
            .arg(&mcp_config)
            // `--work-dir` pins the agent's root the same way
            // opencode's `--dir` does; keep `current_dir` in sync so
            // relative paths in tool args resolve the same.
            .arg("--work-dir")
            .arg(&opts.cwd);
        // Omit `--model` entirely when unset so the CLI applies its
        // own config default rather than a stale id we hard-coded.
        if let Some(m) = opts.model.as_deref().filter(|m| !m.is_empty()) {
            cmd.arg("--model").arg(m);
        }
        if opts.effort.is_some() {
            cmd.arg("--thinking");
        }
        if let Some(session) = opts.resume_session_id.as_deref() {
            cmd.arg("--session").arg(session);
        }
        if opts.auto_approve_tools {
            // `--print` already auto-approves; `--yolo` makes the
            // intent explicit and covers future CLI changes.
            cmd.arg("--yolo");
        }
        cmd.arg("--prompt").arg(prompt);
        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        debug!(
            cwd = %opts.cwd.display(),
            model = ?opts.model,
            resume = ?opts.resume_session_id,
            "spawning kimi"
        );

        let mut child = cmd.spawn().map_err(|source| ProviderError::Spawn {
            provider: "Kimi".into(),
            source,
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Io(std::io::Error::other("no stdout on child")))?;
        let events_for_stdout = events.clone();
        // Non-JSON stdout lines. In `--print` mode the CLI reports
        // fatal errors (auth 401, model typos, …) as PLAIN TEXT on
        // stdout, not stderr — so we keep them for the exit-status
        // error message below.
        let plain_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let plain_capture = plain_lines.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            // tool_call id -> name, so `role:"tool"` result messages
            // (which carry no name) can be matched back to their call.
            let mut tool_names: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => {
                        for ev in translate(&v, &mut tool_names) {
                            let _ = events_for_stdout.send(ev);
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, line = %line, "kimi: unparseable line");
                        if let Ok(mut guard) = plain_capture.lock() {
                            guard.push(line.trim().to_string());
                        }
                    }
                }
            }
        });

        let stderr = child.stderr.take();
        let stderr_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stderr_capture = stderr_lines.clone();
        let events_for_stderr = events.clone();
        let stderr_task = stderr.map(|stderr| {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let mut session_announced = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if !session_announced {
                        if let Some(id) = parse_resume_hint(&line) {
                            session_announced = true;
                            let _ = events_for_stderr
                                .send(AgentEvent::SessionStart { session_id: id });
                            continue;
                        }
                    }
                    if let Ok(mut guard) = stderr_capture.lock() {
                        guard.push(line.trim().to_string());
                    }
                }
            })
        });

        let status = child.wait().await?;
        let _ = stdout_task.await;
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        // The JSON stream has no terminal result event; it ends when
        // the CLI exits. Synthesise `Done` / `Error` from the exit
        // status (same pattern as opencode).
        if status.success() {
            let _ = events.send(AgentEvent::Done {
                result: None,
                cost_usd: None,
            });
        } else {
            // Best error text: meaningful plain lines from either
            // stream, skipping stack noise and the resume hint. The
            // CLI's rich console hard-wraps at 80 cols even when
            // piped, so join the first few lines to reassemble the
            // sentence before truncating.
            let pick = |lines: &Vec<String>| {
                let meaningful: Vec<&str> = lines
                    .iter()
                    .map(String::as_str)
                    .filter(|l| {
                        !l.starts_with("Traceback")
                            && !l.starts_with("  ")
                            && !l.contains(RESUME_HINT)
                    })
                    .take(4)
                    .collect();
                if meaningful.is_empty() {
                    None
                } else {
                    Some(meaningful.join(" "))
                }
            };
            let stderr_msg = stderr_lines.lock().ok().and_then(|g| pick(&g));
            let stdout_msg = plain_lines.lock().ok().and_then(|g| pick(&g));
            let msg = match stderr_msg.or(stdout_msg) {
                Some(s) => {
                    let truncated: String = s.chars().take(300).collect();
                    format!("kimi failed: {truncated}")
                }
                None => format!("kimi exited with status {status}"),
            };
            let _ = events.send(AgentEvent::Error { message: msg });
        }

        Ok(())
    }

    // Slash commands: kimi's extensibility is skill-dir based, not the
    // Markdown-command convention Claude / opencode share. The default
    // (empty) trait impl applies until there's a stable surface to
    // scan.
}

/// Translate one JSON line from `kimi --output-format stream-json`
/// into zero or more [`AgentEvent`]s.
///
/// Line shapes (see `kimi_cli/ui/print/visualize.py` + kosong):
///
/// - Assistant message:
///   `{ "role": "assistant", "content": [ {"type":"text","text":…},
///   {"type":"think","think":…} ], "tool_calls": [ {"type":"function",
///   "id":…, "function": {"name":…, "arguments": "{…}"} } ] }`
///   -> `Token` per text part, `Thinking` per think part, `ToolCall`
///   per tool call.
/// - Tool result: `{ "role": "tool", "content": [ … ], "tool_call_id": … }`
///   -> `ToolResult` (name recovered from the earlier `ToolCall`).
/// - Notifications / PlanDisplay / step markers -> dropped.
fn translate(
    v: &serde_json::Value,
    tool_names: &mut std::collections::HashMap<String, String>,
) -> Vec<AgentEvent> {
    let Some(role) = v.get("role").and_then(|x| x.as_str()) else {
        return vec![];
    };
    match role {
        "assistant" => {
            let mut out = Vec::new();
            if let Some(parts) = v.get("content").and_then(|x| x.as_array()) {
                for part in parts {
                    match part.get("type").and_then(|x| x.as_str()) {
                        Some("text") => {
                            if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    out.push(AgentEvent::Token {
                                        text: t.to_string(),
                                    });
                                }
                            }
                        }
                        Some("think") => {
                            if let Some(t) = part.get("think").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    out.push(AgentEvent::Thinking {
                                        text: t.to_string(),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            if let Some(calls) = v.get("tool_calls").and_then(|x| x.as_array()) {
                for call in calls {
                    let id = call.get("id").and_then(|x| x.as_str()).map(String::from);
                    let name = call
                        .pointer("/function/name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = match call.pointer("/function/arguments") {
                        Some(serde_json::Value::String(s)) => {
                            serde_json::from_str(s).unwrap_or(serde_json::Value::String(s.clone()))
                        }
                        Some(other) => other.clone(),
                        None => serde_json::Value::Null,
                    };
                    if let Some(id) = &id {
                        tool_names.insert(id.clone(), name.clone());
                    }
                    out.push(AgentEvent::ToolCall { name, args, id });
                }
            }
            out
        }
        "tool" => {
            let id = v
                .get("tool_call_id")
                .and_then(|x| x.as_str())
                .map(String::from);
            let name = id
                .as_ref()
                .and_then(|i| tool_names.get(i).cloned())
                .unwrap_or_default();
            let mut texts: Vec<String> = Vec::new();
            if let Some(parts) = v.get("content").and_then(|x| x.as_array()) {
                for part in parts {
                    if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                        texts.push(t.to_string());
                    }
                }
            }
            vec![AgentEvent::ToolResult {
                name,
                result: serde_json::Value::String(texts.join("\n")),
                id,
            }]
        }
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
    fn assistant_text_and_think_become_token_and_thinking() {
        let line = json!({
            "role": "assistant",
            "content": [
                { "type": "think", "think": "reasoning…" },
                { "type": "text", "text": "Hello" }
            ]
        });
        let mut names = fresh();
        let evs = translate(&line, &mut names);
        assert_eq!(
            evs,
            vec![
                AgentEvent::Thinking {
                    text: "reasoning…".into()
                },
                AgentEvent::Token {
                    text: "Hello".into()
                }
            ]
        );
    }

    #[test]
    fn assistant_tool_call_parses_arguments_and_remembers_name() {
        let line = json!({
            "role": "assistant",
            "content": [],
            "tool_calls": [{
                "type": "function",
                "id": "call_1",
                "function": { "name": "Read", "arguments": "{\"path\":\"x.rs\"}" }
            }]
        });
        let mut names = fresh();
        let evs = translate(&line, &mut names);
        assert_eq!(
            evs,
            vec![AgentEvent::ToolCall {
                name: "Read".into(),
                args: json!({ "path": "x.rs" }),
                id: Some("call_1".into())
            }]
        );
        assert_eq!(names.get("call_1").map(String::as_str), Some("Read"));
    }

    #[test]
    fn tool_message_becomes_result_with_recovered_name() {
        let mut names = fresh();
        names.insert("call_1".to_string(), "Read".to_string());
        let line = json!({
            "role": "tool",
            "tool_call_id": "call_1",
            "content": [{ "type": "text", "text": "fn main() {}" }]
        });
        assert_eq!(
            translate(&line, &mut names),
            vec![AgentEvent::ToolResult {
                name: "Read".into(),
                result: json!("fn main() {}"),
                id: Some("call_1".into())
            }]
        );
    }

    #[test]
    fn notifications_and_unknown_roles_are_dropped() {
        let mut names = fresh();
        let notif = json!({ "id": "n1", "category": "sys", "type": "info" });
        assert!(translate(&notif, &mut names).is_empty());
        let user = json!({ "role": "user", "content": [] });
        assert!(translate(&user, &mut names).is_empty());
    }

    #[test]
    fn resume_hint_parses_session_id() {
        let line = "\nTo resume this session: kimi -r 87cb9171-a22f-4dbb-b397-3957b0b32169";
        assert_eq!(
            parse_resume_hint(line).as_deref(),
            Some("87cb9171-a22f-4dbb-b397-3957b0b32169")
        );
        assert!(parse_resume_hint("some other error").is_none());
        assert!(parse_resume_hint("kimi -r short").is_none());
    }

    #[test]
    fn config_parses_default_and_model_sections() {
        let text = r#"
default_model = "kimi-code/k3"
theme = "dark"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
"#;
        let cfg = parse_config(text);
        assert_eq!(cfg.default_model.as_deref(), Some("kimi-code/k3"));
        assert_eq!(
            cfg.models,
            vec![
                "kimi-code/kimi-for-coding".to_string(),
                "kimi-code/k3".to_string()
            ]
        );
    }

    #[test]
    fn config_ignores_malformed_lines() {
        let cfg = parse_config("default_model = \n[models.\"\"]garbage");
        assert!(cfg.default_model.is_none());
        assert!(cfg.models.is_empty());
    }

    #[test]
    fn version_string_takes_last_token() {
        // "kimi, version 1.49.0" -> "1.49.0"
        let s = "kimi, version 1.49.0";
        assert_eq!(s.split_whitespace().next_back(), Some("1.49.0"));
    }
}
