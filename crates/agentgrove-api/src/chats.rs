//! In-memory chat aggregate.
//!
//! Chats are owned by a **project**. They may optionally be scoped to a
//! specific **worktree** within that project. There is **no per-project
//! cap**; the UI lets users create chats freely and lists them as tabs.
//!
//! Persistence: in-memory for now; SQLite once the AI-revert timeline lands.

use crate::state::AppState;
use agentgrove_agents::AgentEvent;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRecord {
    pub id: String,
    pub project_id: String,
    /// `None` ⇒ chat lives under the project root scope.
    pub worktree_id: Option<String>,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: DateTime<Utc>,
    pub prompts: Vec<PromptRecord>,
    /// Provider-supplied session id, captured from the first
    /// `SessionStart` event of a turn. Passed back to the provider on
    /// subsequent turns to preserve context. `None` until the first
    /// turn completes (or for providers that don't report sessions).
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRecord {
    pub id: String,
    pub seq: u32,
    pub content: String,
    pub events: Vec<AgentEvent>,
    pub touched_paths: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Default, Debug)]
pub struct ChatRegistry {
    by_id: HashMap<String, ChatRecord>,
    by_project: HashMap<String, Vec<String>>,
}

impl ChatRegistry {
    /// Insert a new chat owned by `project_id`, optionally scoped to a
    /// `worktree_id`.
    pub fn create(
        &mut self,
        project_id: String,
        worktree_id: Option<String>,
        title: String,
        provider: String,
        model: String,
    ) -> ChatRecord {
        let rec = ChatRecord {
            id: Uuid::now_v7().to_string(),
            project_id: project_id.clone(),
            worktree_id,
            title,
            provider,
            model,
            created_at: Utc::now(),
            prompts: vec![],
            session_id: None,
        };
        self.by_project
            .entry(project_id)
            .or_default()
            .push(rec.id.clone());
        self.by_id.insert(rec.id.clone(), rec.clone());
        rec
    }

    pub fn count_for_project(&self, project_id: &str) -> usize {
        self.by_project.get(project_id).map(|v| v.len()).unwrap_or(0)
    }

    /// List all chats for a project. If `worktree_id` is `Some(_)`,
    /// returns only chats scoped to that worktree (plus chats that match
    /// the supplied id). If `None`, returns all chats in the project.
    pub fn list_for_project(
        &self,
        project_id: &str,
        worktree_id: Option<&str>,
    ) -> Vec<ChatRecord> {
        let ids = match self.by_project.get(project_id) {
            Some(v) => v,
            None => return vec![],
        };
        ids.iter()
            .filter_map(|i| self.by_id.get(i).cloned())
            .filter(|c| match worktree_id {
                Some(w) => c.worktree_id.as_deref() == Some(w),
                None => true,
            })
            .collect()
    }

    /// Legacy: list every chat whose worktree_id matches.
    pub fn list_for_worktree(&self, wt: &str) -> Vec<ChatRecord> {
        self.by_id
            .values()
            .filter(|c| c.worktree_id.as_deref() == Some(wt))
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&ChatRecord> {
        self.by_id.get(id)
    }

    pub fn add_prompt(&mut self, chat_id: &str, content: String) -> Option<PromptRecord> {
        let chat = self.by_id.get_mut(chat_id)?;
        let seq = chat.prompts.len() as u32 + 1;
        let rec = PromptRecord {
            id: Uuid::now_v7().to_string(),
            seq,
            content,
            events: vec![],
            touched_paths: vec![],
            created_at: Utc::now(),
        };
        chat.prompts.push(rec.clone());
        Some(rec)
    }

    /// Maximum number of *real* events kept in memory per prompt. The
    /// vec may also carry a single leading `Truncated { dropped }`
    /// sentinel when older events have been evicted; the sentinel
    /// itself does not count against this cap. See ADR-0006.
    const MAX_EVENTS_PER_PROMPT: usize = 4096;

    /// Effective vec cap once a sentinel is present. Used internally.
    const SLOTS_WITH_SENTINEL: usize = Self::MAX_EVENTS_PER_PROMPT + 1;

    pub fn append_event(&mut self, chat_id: &str, prompt_id: &str, ev: AgentEvent) {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            if let Some(p) = chat.prompts.iter_mut().find(|p| p.id == prompt_id) {
                let has_sentinel =
                    matches!(p.events.first(), Some(AgentEvent::Truncated { .. }));
                let cap = if has_sentinel {
                    Self::SLOTS_WITH_SENTINEL
                } else {
                    Self::MAX_EVENTS_PER_PROMPT
                };
                if p.events.len() >= cap {
                    if has_sentinel {
                        // Drop the oldest real event (events[1]) and
                        // bump the sentinel counter.
                        let _ = p.events.remove(1);
                        if let Some(AgentEvent::Truncated { dropped }) = p.events.first_mut() {
                            *dropped += 1;
                        }
                    } else {
                        // First eviction: replace the oldest real
                        // event with a Truncated{1} sentinel in place.
                        p.events[0] = AgentEvent::Truncated { dropped: 1 };
                    }
                }
                p.events.push(ev);
            }
        }
    }

    /// Record the provider-issued session id for the chat. Called when
    /// a `SessionStart` arrives so the next turn can `--resume` it.
    pub fn set_session_id(&mut self, chat_id: &str, session_id: String) {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            chat.session_id = Some(session_id);
        }
    }

    /// Rename a chat. Returns true if the chat was found. Caller is
    /// responsible for trimming + validating the title.
    pub fn rename(&mut self, chat_id: &str, title: String) -> bool {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            chat.title = title;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateChatBody {
    pub title: String,
    pub provider: String,
    pub model: String,
    /// Optional worktree scope. Ignored by the worktree-specific route
    /// (which derives this from the URL).
    #[serde(default)]
    pub worktree_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddPromptBody {
    pub content: String,
}

// ---- project-scoped routes ---------------------------------------------

pub async fn list_for_project_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<Vec<ChatRecord>> {
    let reg = state.chats.read().await;
    Json(reg.list_for_project(&project_id, None))
}

pub async fn create_for_project_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<CreateChatBody>,
) -> Result<Json<ChatRecord>, (StatusCode, String)> {
    // Validate project exists.
    if state.projects.get(&project_id).await.is_err() {
        return Err((StatusCode::NOT_FOUND, "project not found".into()));
    }

    // Validate optional worktree belongs to the project.
    if let Some(wid) = body.worktree_id.as_deref() {
        match state.worktrees.get(wid).await {
            Ok(w) if w.project_id == project_id => {}
            Ok(_) => return Err((StatusCode::BAD_REQUEST, "worktree not in project".into())),
            Err(_) => return Err((StatusCode::NOT_FOUND, "worktree not found".into())),
        }
    }

    let mut reg = state.chats.write().await;
    Ok(Json(reg.create(
        project_id,
        body.worktree_id,
        body.title,
        body.provider,
        body.model,
    )))
}

// ---- worktree-scoped routes (legacy, retained) -------------------------

pub async fn list(State(state): State<AppState>, Path(wt): Path<String>) -> Json<Vec<ChatRecord>> {
    let reg = state.chats.read().await;
    Json(reg.list_for_worktree(&wt))
}

pub async fn create(
    State(state): State<AppState>,
    Path(wt): Path<String>,
    Json(body): Json<CreateChatBody>,
) -> Result<Json<ChatRecord>, (StatusCode, String)> {
    // Derive the owning project. Worktrees not backed by a record (used by
    // some tests) fall back to "wt-as-project" so we don't panic.
    let project_id = match state.worktrees.get(&wt).await {
        Ok(rec) => rec.project_id,
        Err(_) => wt.clone(),
    };

    let mut reg = state.chats.write().await;
    Ok(Json(reg.create(
        project_id,
        Some(wt),
        body.title,
        body.provider,
        body.model,
    )))
}

// ---- prompt-level ------------------------------------------------------

/// Wire shape for `GET /api/chats/:id`. Bounded so a single fetch
/// never returns more than the last 50 prompts × 200 events. The FE
/// uses [`prompts_total`] to decide whether to surface a "load older"
/// affordance. See ADR-0006.
#[derive(Debug, Clone, Serialize)]
pub struct ChatView {
    pub id: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: DateTime<Utc>,
    pub session_id: Option<String>,
    /// Most recent `<= prompts_window>` prompts, oldest first. Each
    /// prompt's `events` is itself capped at `events_per_prompt`.
    pub prompts: Vec<PromptRecord>,
    /// Total prompts on the server. `prompts.len() < prompts_total`
    /// means earlier prompts exist and can be fetched via
    /// `/api/chats/:id/prompts?before=<id>`.
    pub prompts_total: u32,
    /// The window sizes the server applied for this response.
    pub prompts_window: u32,
    pub events_per_prompt: u32,
}

/// Default cap on prompts returned by `GET /api/chats/:id`. Larger
/// chats trigger client-side virtualization.
const DEFAULT_PROMPTS_WINDOW: usize = 50;
/// Default cap on events kept per prompt in the windowed view. The
/// in-memory registry stores up to `MAX_EVENTS_PER_PROMPT` but most
/// of those are token deltas a fresh viewer never needs.
const DEFAULT_EVENTS_PER_PROMPT: usize = 200;

fn window_chat(rec: &ChatRecord) -> ChatView {
    let total = rec.prompts.len() as u32;
    let start = rec.prompts.len().saturating_sub(DEFAULT_PROMPTS_WINDOW);
    let windowed: Vec<PromptRecord> = rec.prompts[start..]
        .iter()
        .map(|p| {
            let ev_start = p.events.len().saturating_sub(DEFAULT_EVENTS_PER_PROMPT);
            PromptRecord {
                events: p.events[ev_start..].to_vec(),
                ..p.clone()
            }
        })
        .collect();
    ChatView {
        id: rec.id.clone(),
        project_id: rec.project_id.clone(),
        worktree_id: rec.worktree_id.clone(),
        title: rec.title.clone(),
        provider: rec.provider.clone(),
        model: rec.model.clone(),
        created_at: rec.created_at,
        session_id: rec.session_id.clone(),
        prompts: windowed,
        prompts_total: total,
        prompts_window: DEFAULT_PROMPTS_WINDOW as u32,
        events_per_prompt: DEFAULT_EVENTS_PER_PROMPT as u32,
    }
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ChatView>, StatusCode> {
    let reg = state.chats.read().await;
    reg.get(&id)
        .map(window_chat)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Body for `PATCH /api/chats/:id`. Today only `title` is mutable;
/// further fields land later behind the same envelope.
#[derive(Debug, Deserialize)]
pub struct UpdateChatBody {
    pub title: Option<String>,
}

/// `PATCH /api/chats/:id` — rename the chat (and, later, edit other
/// metadata). Empty/whitespace titles return 400.
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateChatBody>,
) -> Result<Json<ChatView>, (StatusCode, String)> {
    let mut reg = state.chats.write().await;
    if let Some(raw) = body.title {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "title cannot be empty".into(),
            ));
        }
        if !reg.rename(&id, trimmed.to_string()) {
            return Err((StatusCode::NOT_FOUND, format!("chat {id} not found")));
        }
    }
    let rec = reg
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, format!("chat {id} not found")))?;
    Ok(Json(window_chat(rec)))
}

/// Query for `GET /api/chats/:id/prompts`.
#[derive(Debug, Deserialize)]
pub struct PromptsBackfillQuery {
    /// Return prompts with `seq < before`. Use the seq of the oldest
    /// prompt the client currently has.
    pub before: u32,
    /// Maximum number of prompts to return. Server-clamped to 200.
    #[serde(default = "default_backfill_limit")]
    pub limit: u32,
}

fn default_backfill_limit() -> u32 {
    50
}

/// Wire shape for backfill responses.
#[derive(Debug, Clone, Serialize)]
pub struct PromptsBackfill {
    /// Older prompts, oldest first.
    pub prompts: Vec<PromptRecord>,
    /// True when the response is the start of the history (no older
    /// prompts exist). FE uses this to disable the "load older" UI.
    pub at_start: bool,
}

/// `GET /api/chats/:id/prompts?before=&limit=` — backfill older
/// prompts for the chat timeline. Each prompt is event-windowed the
/// same way `GET /api/chats/:id` does.
pub async fn list_prompts(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<PromptsBackfillQuery>,
) -> Result<Json<PromptsBackfill>, StatusCode> {
    let reg = state.chats.read().await;
    let chat = reg.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let limit = q.limit.min(200).max(1) as usize;
    let before = q.before;
    // Collect prompts with seq < before, take the last `limit`.
    let mut slice: Vec<PromptRecord> = chat
        .prompts
        .iter()
        .filter(|p| p.seq < before)
        .cloned()
        .collect();
    let at_start = slice.len() <= limit;
    if slice.len() > limit {
        let start = slice.len() - limit;
        slice = slice.split_off(start);
    }
    let windowed: Vec<PromptRecord> = slice
        .into_iter()
        .map(|mut p| {
            let ev_start = p.events.len().saturating_sub(DEFAULT_EVENTS_PER_PROMPT);
            p.events = p.events[ev_start..].to_vec();
            p
        })
        .collect();
    Ok(Json(PromptsBackfill {
        prompts: windowed,
        at_start,
    }))
}

pub async fn add_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AddPromptBody>,
) -> Result<Json<PromptRecord>, StatusCode> {
    // Phase 1: record the prompt + capture everything we need for the
    // provider call. We drop the lock before awaiting any I/O so other
    // requests on the chat (e.g. polling GET) don't deadlock during a
    // multi-second model turn.
    let (prompt, provider_id, model, session_id, cwd) = {
        let mut reg = state.chats.write().await;
        let chat = reg.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone();
        let prompt = reg
            .add_prompt(&id, body.content.clone())
            .ok_or(StatusCode::NOT_FOUND)?;
        let cwd = resolve_cwd(&state, &chat).await;
        (
            prompt,
            chat.provider.clone(),
            chat.model.clone(),
            chat.session_id.clone(),
            cwd,
        )
    };

    // Phase 2: dispatch via the registered provider. Fake/echo path:
    // if the chat's provider isn't in the registry (e.g. legacy
    // "fake/echo") we fall back to the synchronous echo so existing
    // tests + UI scaffolding keep working.
    let topic = format!("chat:{id}");
    let provider = state.providers.get(&provider_id);
    if let Some(p) = provider {
        dispatch_via_provider(
            &state,
            &id,
            &prompt,
            &topic,
            p,
            &body.content,
            &model,
            session_id,
            cwd,
        )
        .await;
    } else {
        dispatch_echo(&state, &id, &prompt, &topic, &body.content).await;
    }

    Ok(Json(prompt))
}

/// Resolve the working directory for a chat: worktree path when the
/// chat is scoped to one, else the project root, else `/tmp` as a last
/// resort (which only happens if the chat is orphaned).
async fn resolve_cwd(state: &AppState, chat: &ChatRecord) -> std::path::PathBuf {
    if let Some(wt_id) = chat.worktree_id.as_deref() {
        if let Ok(wt) = state.worktrees.get(wt_id).await {
            return wt.path;
        }
    }
    if let Ok(p) = state.projects.get(&chat.project_id).await {
        return p.root;
    }
    std::path::PathBuf::from("/tmp")
}

/// Stream a provider's events into both the per-chat registry (for
/// later GET) and the logbus topic (for live WS subscribers).
#[allow(clippy::too_many_arguments)]
async fn dispatch_via_provider(
    state: &AppState,
    chat_id: &str,
    prompt: &PromptRecord,
    topic: &str,
    provider: std::sync::Arc<dyn agentgrove_agents::AgentProvider>,
    user_text: &str,
    model: &str,
    resume_session_id: Option<String>,
    cwd: std::path::PathBuf,
) {
    use agentgrove_agents::SpawnOptions;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    let opts = SpawnOptions {
        cwd,
        model: Some(model.to_string()),
        resume_session_id,
    };
    let prompt_text = user_text.to_string();
    let provider_for_task = provider.clone();
    let spawn_task = tokio::spawn(async move {
        provider_for_task.spawn(&prompt_text, opts, tx).await
    });

    // Token-coalescing state. Providers (Claude in particular) emit
    // one Token event per text-delta — sometimes per character. We
    // buffer consecutive Token deltas and flush when either:
    //   - the buffer reaches `TOKEN_FLUSH_BYTES`, or
    //   - `TOKEN_FLUSH_INTERVAL` has passed since the last flush, or
    //   - a non-Token event arrives.
    // See ADR-0006 for the budget rationale.
    const TOKEN_FLUSH_BYTES: usize = 64;
    const TOKEN_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    let mut pending_text = String::new();

    async fn flush_pending(
        state: &AppState,
        chat_id: &str,
        prompt: &PromptRecord,
        topic: &str,
        pending: &mut String,
    ) {
        if pending.is_empty() {
            return;
        }
        let ev = AgentEvent::Token {
            text: std::mem::take(pending),
        };
        let payload = serde_json::json!({
            "prompt_id": prompt.id,
            "event": ev,
        });
        state.logbus.publish(topic, payload.to_string());
        let mut reg = state.chats.write().await;
        reg.append_event(chat_id, &prompt.id, ev);
    }

    loop {
        let next = tokio::time::timeout(TOKEN_FLUSH_INTERVAL, rx.recv()).await;
        match next {
            // Timed out: flush whatever we've buffered.
            Err(_) => {
                flush_pending(state, chat_id, prompt, topic, &mut pending_text).await;
                continue;
            }
            // Channel closed: spawn finished.
            Ok(None) => break,
            // Got an event.
            Ok(Some(ev)) => match ev {
                AgentEvent::Token { text } => {
                    pending_text.push_str(&text);
                    if pending_text.len() >= TOKEN_FLUSH_BYTES {
                        flush_pending(state, chat_id, prompt, topic, &mut pending_text).await;
                    }
                }
                other => {
                    // Any non-token event forces a token flush so the
                    // ordering stays intact (token deltas precede the
                    // tool call / done / error they produced).
                    flush_pending(state, chat_id, prompt, topic, &mut pending_text).await;

                    if let AgentEvent::SessionStart { session_id } = &other {
                        let mut reg = state.chats.write().await;
                        reg.set_session_id(chat_id, session_id.clone());
                    }
                    let payload = serde_json::json!({
                        "prompt_id": prompt.id,
                        "event": other,
                    });
                    state.logbus.publish(topic, payload.to_string());
                    let mut reg = state.chats.write().await;
                    reg.append_event(chat_id, &prompt.id, other);
                }
            },
        }
    }
    // Final flush in case the stream ended with token text.
    flush_pending(state, chat_id, prompt, topic, &mut pending_text).await;

    // Surface spawn errors as a synthetic Error event so the FE can
    // render them inline instead of just observing a silent close.
    match spawn_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let ev = AgentEvent::Error {
                message: e.to_string(),
            };
            let payload = serde_json::json!({
                "prompt_id": prompt.id,
                "event": ev,
            });
            state.logbus.publish(topic, payload.to_string());
            let mut reg = state.chats.write().await;
            reg.append_event(chat_id, &prompt.id, ev);
        }
        Err(join_err) => {
            let ev = AgentEvent::Error {
                message: format!("provider task panicked: {join_err}"),
            };
            let payload = serde_json::json!({
                "prompt_id": prompt.id,
                "event": ev,
            });
            state.logbus.publish(topic, payload.to_string());
            let mut reg = state.chats.write().await;
            reg.append_event(chat_id, &prompt.id, ev);
        }
    }
}

/// Fallback echo dispatcher for chats whose provider is not in the
/// registry (most often the legacy `fake`/`echo` pairing used by tests
/// and the empty chat scaffolding).
async fn dispatch_echo(
    state: &AppState,
    chat_id: &str,
    prompt: &PromptRecord,
    topic: &str,
    user_text: &str,
) {
    let evs = vec![
        AgentEvent::Token {
            text: format!("echo: {user_text}"),
        },
        AgentEvent::Done {
            result: Some(format!("echo: {user_text}")),
            cost_usd: None,
        },
    ];
    for ev in evs {
        let payload = serde_json::json!({
            "prompt_id": prompt.id,
            "event": ev,
        });
        state.logbus.publish(topic, payload.to_string());
        let mut reg = state.chats.write().await;
        reg.append_event(chat_id, &prompt.id, ev);
    }
}

pub async fn revert_prompt(
    State(state): State<AppState>,
    Path((chat_id, prompt_id)): Path<(String, String)>,
) -> Result<Json<PromptRecord>, StatusCode> {
    let mut reg = state.chats.write().await;
    let chat = reg.get(&chat_id).ok_or(StatusCode::NOT_FOUND)?.clone();
    let target = chat
        .prompts
        .iter()
        .find(|p| p.id == prompt_id)
        .ok_or(StatusCode::NOT_FOUND)?
        .clone();
    let body = format!(
        "Revert the changes made by prompt {} (\"{}\"). Touched files: {}.",
        target.seq,
        target.content,
        if target.touched_paths.is_empty() {
            "(none recorded)".to_string()
        } else {
            target.touched_paths.join(", ")
        }
    );
    let new = reg
        .add_prompt(&chat_id, body)
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(new))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentgrove_agents::AgentEvent;

    fn fresh_chat(reg: &mut ChatRegistry) -> (String, String) {
        let c = reg.create(
            "proj".into(),
            None,
            "t".into(),
            "fake".into(),
            "echo".into(),
        );
        let p = reg.add_prompt(&c.id, "hi".into()).unwrap();
        (c.id, p.id)
    }

    /// Per ADR-0006: each prompt's event buffer is bounded so a
    /// runaway tool spammer can't blow up server RSS. The vec keeps
    /// at most `MAX_EVENTS_PER_PROMPT` real events + 1 sentinel slot.
    #[test]
    fn append_event_caps_at_max_per_prompt() {
        let mut reg = ChatRegistry::default();
        let (cid, pid) = fresh_chat(&mut reg);
        let max = ChatRegistry::MAX_EVENTS_PER_PROMPT;
        let pushed = max + 25;
        for i in 0..pushed {
            reg.append_event(
                &cid,
                &pid,
                AgentEvent::Token {
                    text: format!("t{i}"),
                },
            );
        }
        let chat = reg.get(&cid).unwrap();
        let p = chat.prompts.iter().find(|p| p.id == pid).unwrap();
        // Real events stay capped at `max`; sentinel adds one extra slot.
        assert_eq!(
            p.events.len(),
            max + 1,
            "vec is exactly cap + 1 sentinel slot"
        );
        match p.events.first().unwrap() {
            AgentEvent::Truncated { dropped } => assert_eq!(*dropped, 25),
            other => panic!("expected leading Truncated sentinel, got {other:?}"),
        }
        // Newest token is still at the tail.
        match p.events.last().unwrap() {
            AgentEvent::Token { text } => assert_eq!(text, &format!("t{}", pushed - 1)),
            other => panic!("expected newest Token at tail, got {other:?}"),
        }
        // Exactly one Truncated sentinel in the whole vec.
        let sentinels = p
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Truncated { .. }))
            .count();
        assert_eq!(sentinels, 1);
    }

    /// Truncated sentinels collapse rather than stacking — keeps the
    /// event log compact when many evictions happen back-to-back.
    #[test]
    fn repeated_evictions_accumulate_into_single_truncated() {
        let mut reg = ChatRegistry::default();
        let (cid, pid) = fresh_chat(&mut reg);
        let max = ChatRegistry::MAX_EVENTS_PER_PROMPT;
        for i in 0..(max + 3) {
            reg.append_event(
                &cid,
                &pid,
                AgentEvent::Token {
                    text: format!("t{i}"),
                },
            );
        }
        let chat = reg.get(&cid).unwrap();
        let p = chat.prompts.iter().find(|p| p.id == pid).unwrap();
        let leading = p
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Truncated { .. }))
            .count();
        assert_eq!(leading, 1, "all evictions roll into one sentinel");
        match p.events.first().unwrap() {
            AgentEvent::Truncated { dropped } => assert_eq!(*dropped, 3),
            other => panic!("expected Truncated{{3}}, got {other:?}"),
        }
    }
}
