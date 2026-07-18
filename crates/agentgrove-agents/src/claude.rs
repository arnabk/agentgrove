//! Claude provider: launches the `claude` (Claude Code) CLI as a child
//! process and translates its `stream-json` output to [`AgentEvent`]s.
//!
//! ## Authentication
//!
//! We **do not** pass any credentials to the CLI. Whatever auth the
//! user has set up locally — `ANTHROPIC_API_KEY` environment variable,
//! OAuth keychain entry maintained by the CLI, or a `claude.ai`
//! subscription token managed by the CLI — is used transparently.
//! See ADR-0005 for why.
//!
//! ## Branding
//!
//! Per Anthropic's branding guidelines we surface this provider to
//! users as plain **"Claude"**, never "Claude Code". The CLI is
//! "Claude Code" internally, but the AgentGrove product is not.

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

/// Name of the binary we look up via `which`. Same on every OS the CLI
/// supports.
const BINARY_NAME: &str = "claude";

/// Install hint surfaced when the CLI is missing.
const INSTALL_HINT: &str = "https://docs.claude.com/en/docs/claude-code/quickstart";

/// Default model alias when the user hasn't picked one. `sonnet` always
/// resolves to the current Sonnet release.
const DEFAULT_MODEL: &str = "sonnet";

/// Models Claude's CLI accepts, in dropdown display order.
///
/// Two tiers, deliberately in this order so the picker reads from
/// "easy default" → "specific pin":
///
///   1. Family aliases (`opus`, `sonnet`, `haiku`). Each one resolves
///      to whatever Anthropic currently routes that family to — the
///      dropdown never ages out for the common case.
///   2. Dated releases the CLI accepts today. We list these so users
///      who need reproducibility (benchmarks, regression tests,
///      sticky behaviour across releases) can pin an exact version
///      without leaving the dropdown for the per-chat free-form
///      input.
///
/// Adding new releases here is the only edit required when Anthropic
/// ships a new model — no other code changes hook off this list.
const MODELS: &[&str] = &[
    // Tier 1: family aliases — pick this for "I just want a good
    // current default" without thinking about release tags.
    "sonnet",
    "opus",
    "haiku",
    // Tier 2: specific dated releases, newest first within each
    // family. Keep families grouped so the dropdown reads top-down.
    // Opus 4.x family.
    "claude-opus-4-5-20251101",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    // Sonnet 4.x family.
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-20250514",
    // Haiku 4.x family.
    "claude-haiku-4-5-20251001",
    // Older 3.x lines users sometimes still pin to.
    "claude-3-7-sonnet-20250219",
    "claude-3-5-haiku-20241022",
];

/// Concrete [`AgentProvider`] backed by the `claude` CLI.
#[derive(Debug, Default, Clone)]
pub struct ClaudeProvider;

impl ClaudeProvider {
    /// Construct a provider instance. Cheap; detection happens in
    /// [`AgentProvider::detect`].
    pub fn new() -> Self {
        Self
    }
}

/// Locate the `claude` binary on `PATH`. Returned path is canonical
/// when possible so users can copy/paste it.
/// Append any [`SlashCommand`]s from `additions` to `out` whose
/// `name` isn't already present. Built-ins win on name conflict —
/// a user-authored `clear.md` won't shadow the CLI's own /clear
/// because the merge happens after the built-in set is seeded.
fn merge_unique(out: &mut Vec<SlashCommand>, additions: Vec<SlashCommand>) {
    use std::collections::HashSet;
    let seen: HashSet<String> = out.iter().map(|c| c.name.clone()).collect();
    for c in additions {
        if !seen.contains(&c.name) {
            out.push(c);
        }
    }
}

fn find_binary() -> Option<PathBuf> {
    which::which(BINARY_NAME).ok()
}

/// Run `<path> --version` and return the stripped version string.
/// Returns `None` if the call fails or the output looks unexpected.
async fn read_version(path: &std::path::Path) -> Option<String> {
    let out = Command::new(path).arg("--version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // Examples: "2.1.133 (Claude Code)" -> "2.1.133"
    let first = raw.split_whitespace().next()?;
    Some(first.to_string())
}

#[async_trait]
impl AgentProvider for ClaudeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Claude
    }

    async fn detect(&self) -> ProviderDescriptor {
        let path = find_binary();
        let version = match &path {
            Some(p) => read_version(p).await,
            None => None,
        };
        ProviderDescriptor {
            id: ProviderId::Claude,
            label: "Claude".to_string(),
            available: path.is_some(),
            path,
            version,
            default_model: DEFAULT_MODEL.to_string(),
            models: MODELS.iter().map(|s| (*s).to_string()).collect(),
            supports_resume: true,
            supports_current_os: crate::supports_current_os(crate::provider_os_support("claude")),
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let path = find_binary().ok_or_else(|| ProviderError::NotInstalled {
            provider: "Claude".into(),
            hint: INSTALL_HINT.into(),
        })?;

        let model = opts.model.as_deref().unwrap_or(DEFAULT_MODEL);
        let mut cmd = Command::new(&path);
        // Build every option flag first; the prompt itself is passed
        // as the positional `[prompt]` argument AFTER a `--`
        // separator. Without `--` the CLI's option parser will
        // happily consume a markdown bullet-list prompt like
        // `- one\n- two` as if `-` were a short flag and bail with
        // `unknown option`. `--print` selects non-interactive mode
        // (equivalent to the `-p` short flag) without burning the
        // `-p` token on the prompt itself.
        cmd.arg("--print")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages")
            .arg("--model")
            .arg(model);
        if let Some(session) = opts.resume_session_id.as_deref() {
            cmd.arg("--resume").arg(session);
        }
        if let Some(effort) = opts.effort.as_deref() {
            // Maps to the CLI's `--effort` flag (low|medium|high|xhigh|max).
            // Unlocks extended-thinking output on capable models.
            cmd.arg("--effort").arg(effort);
        }
        if opts.auto_approve_tools {
            // Bypass every permission prompt. The CLI normally
            // expects a TTY for these dialogs; AgentGrove doesn't
            // give it one (we drive stdin closed), so without this
            // the agent would block forever the first time it tried
            // to run a Bash / Write / Edit tool.
            cmd.arg("--dangerously-skip-permissions");
        }
        // `--` ends flag parsing; the prompt that follows is taken
        // verbatim regardless of leading dashes.
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
            "spawning claude"
        );

        let mut child = cmd.spawn().map_err(|source| ProviderError::Spawn {
            provider: "Claude".into(),
            source,
        })?;

        // Drive stdout in a background task: parse one JSON object per
        // line, translate to AgentEvent, push to channel.
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Io(std::io::Error::other("no stdout on child")))?;
        let events_for_stdout = events.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => {
                        for ev in translate(&v) {
                            let _ = events_for_stdout.send(ev);
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, line = %line, "claude: unparseable line");
                    }
                }
            }
        });

        // Drain stderr to a separate task so the child doesn't block on
        // a full pipe. We emit one Error event per stderr line that
        // looks like a real error (we can't easily classify; surface
        // all of it).
        let stderr = child.stderr.take();
        let events_for_stderr = events.clone();
        let stderr_task = stderr.map(|stderr| {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = events_for_stderr.send(AgentEvent::Error {
                        message: line.trim().to_string(),
                    });
                }
            })
        });

        let status = child.wait().await?;
        let _ = stdout_task.await;
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        if !status.success() {
            let _ = events.send(AgentEvent::Error {
                message: format!("claude exited with status {status}"),
            });
        }

        Ok(())
    }

    /// Static set of Claude Code slash commands surfaced to the FE
    /// Slash commands surfaced to the FE picker. Union of three
    /// sources, deduped by name (built-in wins on conflict):
    ///
    ///   1. The curated built-in Claude Code commands. Mirrors the
    ///      universal commands the CLI reports under the
    ///      `slash_commands` field of its `system/init` event;
    ///      MCP-specific commands the user may have installed are
    ///      intentionally omitted because they typically require
    ///      flags the picker can't supply.
    ///   2. User-level commands from `~/.claude/commands/*.md`.
    ///      File name (sans `.md`) is the slug; YAML front-matter
    ///      `description:` is the picker hint.
    ///   3. Project-level commands from
    ///      `<ctx.cwd>/.claude/commands/*.md` when `ctx.cwd` is set.
    ///
    /// All async because (2) + (3) read filesystem; the scan is
    /// cheap (few dozen files at most) but we want to stay off the
    /// runtime thread.
    async fn slash_commands(&self, ctx: crate::SlashCommandContext<'_>) -> Vec<SlashCommand> {
        const BUILTINS: &[(&str, &str)] = &[
            ("clear", "Reset the conversation history."),
            ("compact", "Summarise older turns to free context budget."),
            ("context", "Show current context window usage."),
            ("init", "Initialise a CLAUDE.md for this project."),
            ("review", "Ask Claude to review the staged diff."),
            (
                "security-review",
                "Ask Claude for a security-focused review.",
            ),
            ("usage", "Show today's cost/usage summary."),
            ("extra-usage", "Show detailed model-level usage."),
            ("insights", "Surface project insights Claude has gathered."),
        ];
        let mut out: Vec<SlashCommand> = BUILTINS
            .iter()
            .map(|(name, description)| SlashCommand {
                name: (*name).to_string(),
                description: (*description).to_string(),
            })
            .collect();

        // User-level commands: ~/.claude/commands/.
        if let Some(home) = directories_next::BaseDirs::new() {
            let user_dir = home.home_dir().join(".claude").join("commands");
            merge_unique(
                &mut out,
                crate::slash_files::scan_markdown_commands(&user_dir),
            );
        }

        // Project-level commands: <cwd>/.claude/commands/.
        if let Some(cwd) = ctx.cwd {
            let proj_dir = cwd.join(".claude").join("commands");
            merge_unique(
                &mut out,
                crate::slash_files::scan_markdown_commands(&proj_dir),
            );
        }

        out
    }
}

/// Translate one JSON line from `claude --output-format stream-json`
/// into zero or more [`AgentEvent`]s.
///
/// The CLI emits a discriminated union keyed on `type`. The relevant
/// shapes for us are:
///
/// - `{ type: "system", subtype: "init", session_id, ... }`
///   -> `SessionStart`
/// - `{ type: "stream_event", event: { type: "content_block_delta",
///        delta: { type: "text_delta", text } } }`
///   -> `Token`
/// - `{ type: "assistant", message: { content: [{ type:"tool_use",
///        name, input, id }] } }` -> `ToolCall`
/// - `{ type: "user", message: { content: [{ type:"tool_result",
///        tool_use_id, content }] } }` -> `ToolResult`
/// - `{ type: "result", is_error, result, total_cost_usd }`
///   -> `Done` (success) or `Error` (failure)
///
/// Every other shape we drop on the floor (rate-limit pings,
/// stream message_start, etc).
fn translate(v: &serde_json::Value) -> Vec<AgentEvent> {
    let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
        return vec![];
    };
    match kind {
        "system" => translate_system(v),
        "stream_event" => translate_stream_event(v),
        "assistant" => translate_assistant(v),
        "user" => translate_user(v),
        "result" => translate_result(v),
        _ => vec![],
    }
}

fn translate_system(v: &serde_json::Value) -> Vec<AgentEvent> {
    if v.get("subtype").and_then(|x| x.as_str()) == Some("init") {
        if let Some(sid) = v.get("session_id").and_then(|x| x.as_str()) {
            return vec![AgentEvent::SessionStart {
                session_id: sid.to_string(),
            }];
        }
    }
    vec![]
}

fn translate_stream_event(v: &serde_json::Value) -> Vec<AgentEvent> {
    let inner = match v.get("event") {
        Some(e) => e,
        None => return vec![],
    };
    if inner.get("type").and_then(|x| x.as_str()) != Some("content_block_delta") {
        return vec![];
    }
    let delta = match inner.get("delta") {
        Some(d) => d,
        None => return vec![],
    };
    let delta_kind = delta.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match delta_kind {
        "text_delta" => {
            let Some(text) = delta.get("text").and_then(|x| x.as_str()) else {
                return vec![];
            };
            if text.is_empty() {
                vec![]
            } else {
                vec![AgentEvent::Token {
                    text: text.to_string(),
                }]
            }
        }
        // Extended thinking trace. Anthropic emits this when the model
        // is run with a thinking budget (`--effort` ≥ medium on
        // capable models). The chunked text reads like the model's
        // internal reasoning and is rendered in the FE under a
        // collapsible "Thinking" block separate from the answer.
        "thinking_delta" => {
            let Some(text) = delta.get("thinking").and_then(|x| x.as_str()) else {
                return vec![];
            };
            if text.is_empty() {
                vec![]
            } else {
                vec![AgentEvent::Thinking {
                    text: text.to_string(),
                }]
            }
        }
        _ => vec![],
    }
}

fn translate_assistant(v: &serde_json::Value) -> Vec<AgentEvent> {
    let content = v
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for block in content {
        match block.get("type").and_then(|x| x.as_str()) {
            Some("tool_use") => {
                let name = block
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let id = block.get("id").and_then(|x| x.as_str()).map(String::from);
                let args = block
                    .get("input")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                out.push(AgentEvent::ToolCall { name, args, id });
            }
            // Final-form thinking block (sent on message completion
            // when the model produced reasoning). Streaming
            // thinking_delta events are handled in
            // translate_stream_event. We emit the concatenated
            // result so a client that missed the deltas still has
            // the full text.
            Some("thinking") => {
                if let Some(text) = block.get("thinking").and_then(|x| x.as_str()) {
                    if !text.is_empty() {
                        out.push(AgentEvent::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn translate_user(v: &serde_json::Value) -> Vec<AgentEvent> {
    let content = v
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for block in content {
        if block.get("type").and_then(|x| x.as_str()) != Some("tool_result") {
            continue;
        }
        let id = block
            .get("tool_use_id")
            .and_then(|x| x.as_str())
            .map(String::from);
        let result = block
            .get("content")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        // The provider doesn't repeat the tool name on results; leave
        // empty so the FE can match by id.
        out.push(AgentEvent::ToolResult {
            name: String::new(),
            result,
            id,
        });
    }
    out
}

fn translate_result(v: &serde_json::Value) -> Vec<AgentEvent> {
    if v.get("is_error").and_then(|x| x.as_bool()) == Some(true) {
        let msg = v
            .get("error")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("result").and_then(|x| x.as_str()))
            .unwrap_or("claude reported an error")
            .to_string();
        return vec![AgentEvent::Error { message: msg }];
    }
    let result = v.get("result").and_then(|x| x.as_str()).map(String::from);
    let cost_usd = v.get("total_cost_usd").and_then(|x| x.as_f64());
    vec![AgentEvent::Done { result, cost_usd }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_init_becomes_session_start() {
        let line = json!({
            "type": "system",
            "subtype": "init",
            "session_id": "abc-123",
            "cwd": "/tmp",
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::SessionStart {
                session_id: "abc-123".into()
            }]
        );
    }

    #[test]
    fn text_delta_becomes_token() {
        let line = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "Hello" }
            }
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::Token {
                text: "Hello".into()
            }]
        );
    }

    #[test]
    fn empty_text_delta_is_dropped() {
        let line = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "" }
            }
        });
        assert!(translate(&line).is_empty());
    }

    #[test]
    fn thinking_delta_becomes_thinking_event() {
        let line = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "thinking_delta", "thinking": "Let me work this out…" }
            }
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::Thinking {
                text: "Let me work this out…".into()
            }]
        );
    }

    #[test]
    fn assistant_thinking_block_becomes_thinking_event() {
        let line = json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "thinking", "thinking": "consider three options" }
                ]
            }
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::Thinking {
                text: "consider three options".into()
            }]
        );
    }

    #[test]
    fn assistant_tool_use_becomes_tool_call() {
        let line = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "path": "src/main.rs" }
                    }
                ]
            }
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::ToolCall {
                name: "Read".into(),
                args: json!({ "path": "src/main.rs" }),
                id: Some("toolu_1".into())
            }]
        );
    }

    #[test]
    fn user_tool_result_becomes_tool_result() {
        let line = json!({
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "fn main() {}"
                    }
                ]
            }
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::ToolResult {
                name: String::new(),
                result: json!("fn main() {}"),
                id: Some("toolu_1".into())
            }]
        );
    }

    #[test]
    fn result_success_becomes_done_with_cost() {
        let line = json!({
            "type": "result",
            "is_error": false,
            "result": "Hi there friend",
            "total_cost_usd": 0.079
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::Done {
                result: Some("Hi there friend".into()),
                cost_usd: Some(0.079)
            }]
        );
    }

    #[test]
    fn result_error_becomes_error_event() {
        let line = json!({
            "type": "result",
            "is_error": true,
            "result": "rate limited"
        });
        let evs = translate(&line);
        assert_eq!(
            evs,
            vec![AgentEvent::Error {
                message: "rate limited".into()
            }]
        );
    }

    #[test]
    fn unknown_types_are_dropped_silently() {
        let line = json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": "allowed" }
        });
        assert!(translate(&line).is_empty());
    }

    #[tokio::test]
    async fn detect_returns_descriptor_even_when_cli_missing() {
        // We can't predictably make the binary absent in CI without
        // mucking with PATH, but we can at least verify the call
        // returns a well-formed descriptor and doesn't panic.
        let p = ClaudeProvider::new();
        let d = p.detect().await;
        assert_eq!(d.id, ProviderId::Claude);
        assert_eq!(d.label, "Claude");
        assert!(d.supports_resume);
        assert_eq!(d.default_model, "sonnet");
        // available + version + path are environment-dependent.
    }
}
