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
    /// Provider-specific "thinking effort" hint. Forwarded to the
    /// provider on each turn via `SpawnOptions::effort` (Claude: maps
    /// to `--effort`). None ⇒ provider default.
    #[serde(default)]
    pub effort: Option<String>,
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
        effort: Option<String>,
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
            effort,
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

    /// Switch the model used for future turns. Caller validates the
    /// string is non-empty. Also clears any captured session_id since
    /// a resume token issued by one model cannot generally be replayed
    /// against another.
    pub fn set_model(&mut self, chat_id: &str, model: String) -> bool {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            if chat.model != model {
                chat.model = model;
                chat.session_id = None;
            }
            true
        } else {
            false
        }
    }

    /// Set or clear the provider effort hint. `None` resets to the
    /// provider default.
    pub fn set_effort(&mut self, chat_id: &str, effort: Option<String>) -> bool {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            chat.effort = effort;
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
    /// Provider-specific thinking effort hint (Claude: low|medium|
    /// high|xhigh|max). When set, the chat unlocks extended thinking
    /// output. Defaults to None (provider default — usually off).
    #[serde(default)]
    pub effort: Option<String>,
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
        body.effort,
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
        body.effort,
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
    /// Provider thinking-effort hint (Claude: low|medium|high|xhigh|max).
    pub effort: Option<String>,
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
        effort: rec.effort.clone(),
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

/// Body for `PATCH /api/chats/:id`. Each field is optional; unset
/// fields leave the corresponding chat property unchanged.
#[derive(Debug, Deserialize)]
pub struct UpdateChatBody {
    pub title: Option<String>,
    /// Override the model used for future turns of this chat (e.g.
    /// `"sonnet"` -> `"opus"`). Empty / whitespace-only is rejected.
    pub model: Option<String>,
    /// Provider thinking-effort hint. `Some(Some(_))` sets a new
    /// value, `Some(None)` clears it back to the provider default.
    /// (Using `Option<Option<…>>` lets the client express "leave
    /// untouched" vs "clear".)
    #[serde(default, deserialize_with = "deser_optional_option_string")]
    pub effort: Option<Option<String>>,
}

/// Custom serde adapter for the `effort: Option<Option<String>>`
/// pattern. Distinguishes "field absent" (don't touch) from
/// "field=null" (clear it).
fn deser_optional_option_string<'de, D>(de: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::de::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Some(Option::<String>::deserialize(de)?))
}

/// `PATCH /api/chats/:id` — update title, model, or effort. Empty
/// `title`/`model` returns 400. Unknown id returns 404.
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateChatBody>,
) -> Result<Json<ChatView>, (StatusCode, String)> {
    let mut reg = state.chats.write().await;
    // Ensure the chat exists before mutating, so all field updates
    // either all succeed or all roll back via early return.
    if reg.get(&id).is_none() {
        return Err((StatusCode::NOT_FOUND, format!("chat {id} not found")));
    }
    if let Some(raw) = body.title {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "title cannot be empty".into(),
            ));
        }
        reg.rename(&id, trimmed.to_string());
    }
    if let Some(raw) = body.model {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "model cannot be empty".into()));
        }
        reg.set_model(&id, trimmed.to_string());
    }
    if let Some(eff) = body.effort {
        // Inner `None` clears; inner `Some(_)` sets.
        let normalized = eff.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        reg.set_effort(&id, normalized);
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

/// Legacy direct-dispatch endpoint. Used by tests + `queue::run_next`.
/// New FE code should prefer `send_message`, which routes between
/// dispatch and queue atomically.
///
/// This handler still enforces the per-chat serialisation: it takes
/// the dispatching lock around the prompt insertion + flag-flip so a
/// concurrent `send_message` can't slip past with a stale "not
/// dispatching" reading.
pub async fn add_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AddPromptBody>,
) -> Result<Json<PromptRecord>, StatusCode> {
    let mut dispatching = state.dispatching.lock().await;

    // Record the prompt + capture chat metadata while holding the
    // routing lock. Returning the canonical record (with its real
    // id + seq) BEFORE the agent starts streaming is what lets the
    // FE optimistic placeholder get swapped in time for the first
    // WS event.
    let (prompt, chat) = {
        let mut reg = state.chats.write().await;
        let chat = reg.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone();
        let p = reg
            .add_prompt(&id, body.content.clone())
            .ok_or(StatusCode::NOT_FOUND)?;
        (p, chat)
    };

    dispatching.insert(id.clone());
    drop(dispatching);

    spawn_dispatch_task(state.clone(), id, chat, prompt.clone(), body.content);
    Ok(Json(prompt))
}

/// Wire body for `POST /api/chats/:id/messages` (the "smart send"
/// endpoint). Just text content for now; we'll extend with metadata
/// later (e.g. queue mode override per send).
#[derive(Debug, Deserialize)]
pub struct SendMessageBody {
    pub content: String,
}

/// Wire response for the smart-send endpoint. The discriminator tells
/// the FE whether the BE dispatched immediately or parked the message
/// on the queue — so the FE can update its UI optimistically without
/// having to guess from busy state.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SendMessageResponse {
    Dispatched { prompt: PromptRecord },
    Queued { item_id: String },
}

/// Smart send: the FE just hands us a message and the BE decides
/// whether to dispatch right now or park it on the queue. Rules:
///
///   1. If the chat is already mid-turn (`dispatching` set has it),
///      enqueue.
///   2. If the queue has any pending items (preserving FIFO ordering
///      so the new message can't jump ahead of an older one), enqueue.
///   3. Otherwise, dispatch immediately.
///
/// CRITICAL: the decision + the action that commits it (mark
/// dispatching, or push onto the queue) MUST happen atomically.
/// Concurrent requests on the same chat would otherwise both pass
/// the "not dispatching, queue empty" check and both go through the
/// dispatch path, producing parallel agent turns and dropping or
/// reordering messages.
///
/// We serialise per-chat by holding `state.dispatching` (a single
/// `Mutex<HashSet<chat_id>>`) across the entire decide+commit
/// section. Reads of the queue and chat registry happen inside this
/// guard so no other smart-send call can race past them. The
/// downstream provider dispatch is still async — it runs on a
/// spawned task and the guard is dropped before we return.
pub async fn send_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SendMessageBody>,
) -> Result<Json<SendMessageResponse>, StatusCode> {
    // Take the routing lock FIRST. Every send_message call for any
    // chat goes through this single mutex — short critical section,
    // no per-chat locks needed.
    let mut dispatching = state.dispatching.lock().await;

    // Confirm the chat exists under the lock so the 404 path can't
    // race with a delete.
    {
        let reg = state.chats.read().await;
        if reg.get(&id).is_none() {
            return Err(StatusCode::NOT_FOUND);
        }
    }

    // Rule 1: chat is mid-turn.
    let is_dispatching = dispatching.contains(&id);

    // Rule 2: queue has pending items. We must read this UNDER the
    // dispatching lock so a parallel send_message that just
    // enqueued can't slip its item in between our queue-read and
    // our decision.
    let pending_in_queue = {
        let reg = state.queues.read().await;
        reg.state(&id)
            .items
            .iter()
            .filter(|i| i.status == crate::queue::Status::Pending)
            .count()
    };

    if is_dispatching || pending_in_queue > 0 {
        // Enqueue under the same lock so the resulting "queue
        // non-empty" state is observable to any next request that
        // takes the lock after us.
        let item = state
            .queues
            .write()
            .await
            .enqueue(&id, body.content.clone());
        drop(dispatching);
        return Ok(Json(SendMessageResponse::Queued { item_id: item.id }));
    }

    // Dispatch path. Mark the chat as dispatching INSIDE the lock
    // so any concurrent send_message that wakes up after us sees
    // it and enqueues correctly. The spawned task in
    // `dispatch_for_chat` clears the flag when the turn (and any
    // auto-drain follow-up) finishes.
    dispatching.insert(id.clone());

    // Capture everything we need from the chats registry while the
    // lock is held — that way the spawned task is purely
    // self-contained and doesn't need to re-resolve the chat under
    // contention.
    let (prompt, chat) = {
        let mut reg = state.chats.write().await;
        let chat = reg.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone();
        let p = reg
            .add_prompt(&id, body.content.clone())
            .ok_or(StatusCode::NOT_FOUND)?;
        (p, chat)
    };
    drop(dispatching);

    spawn_dispatch_task(state.clone(), id, chat, prompt.clone(), body.content);
    Ok(Json(SendMessageResponse::Dispatched { prompt }))
}

/// RAII guard that clears the chat's `dispatching` flag on drop.
///
/// This is the single source of truth for "this chat is no longer
/// busy". Earlier we cleared the flag manually at the bottom of the
/// spawned task, which had two failure modes:
///
///   1. A panic in `dispatch_via_provider` (or anywhere in the
///      drain loop) unwound past the manual `remove` call, leaving
///      the chat permanently marked dispatching — the FE then saw
///      every `run_next` rejected with 409 and the chat appeared
///      "stuck".
///   2. An early `break` from the drain loop on a missing chat /
///      add_prompt failure didn't orphan the dispatching flag
///      itself, but it did orphan the Running queue item the same
///      iteration had just popped. We fix that separately below by
///      mark_done-ing the popped item if we exit early.
///
/// Using a guard means: as long as the tokio task runs *at all* —
/// even if every internal step panics — we'll release the flag and
/// publish the idle hint. We use a synchronous `std::sync::Mutex`
/// in [`AppState::dispatching`] so this `Drop` impl can clear the
/// flag without `.await` (Drop is not async).
struct DispatchGuard {
    state: AppState,
    chat_id: String,
}

impl Drop for DispatchGuard {
    fn drop(&mut self) {
        // Drop is sync but `tokio::sync::Mutex` is async — we can't
        // `.await` here, so we hand the clear off to a fresh
        // tokio::spawn. The happy path in `spawn_dispatch_task`
        // clears the flag synchronously BEFORE this Drop fires, so
        // most of the time the spawn finds the flag already gone
        // and does nothing. This is the panic-safety insurance
        // path: if the spawned task panicked mid-flight, the guard
        // still issues a clear so the chat doesn't stay marked
        // busy forever.
        let state = self.state.clone();
        let chat_id = self.chat_id.clone();
        tokio::spawn(async move {
            {
                let mut set = state.dispatching.lock().await;
                set.remove(&chat_id);
            }
            let topic = format!("chat:{chat_id}");
            state.logbus.publish(
                &topic,
                serde_json::json!({ "chat_idle": true }).to_string(),
            );
        });
    }
}

/// Spawn the agent-turn + auto-drain task for a freshly-dispatched
/// prompt. Extracted out so both `send_message` and the legacy
/// `add_prompt` handler share the same code path; the `dispatching`
/// flag is OWNED by this task — released via [`DispatchGuard`]'s
/// `Drop` impl so an unwind from a provider panic can't leave the
/// chat permanently busy.
pub(crate) fn spawn_dispatch_task(
    state: AppState,
    chat_id: String,
    chat: ChatRecord,
    prompt: PromptRecord,
    body: String,
) {
    tokio::spawn(async move {
        // Guard goes on the stack first so it'll be dropped LAST
        // (after every other local), ensuring the dispatching flag
        // outlives any panic + the final mark_done call.
        let _guard = DispatchGuard {
            state: state.clone(),
            chat_id: chat_id.clone(),
        };

        let topic = format!("chat:{chat_id}");
        let cwd = resolve_cwd(&state, &chat).await;
        let provider = state.providers.get(&chat.provider);
        if let Some(p) = provider {
            dispatch_via_provider(
                &state,
                &chat_id,
                &prompt,
                &topic,
                p,
                &body,
                &chat.model,
                chat.session_id.clone(),
                chat.effort.clone(),
                cwd,
            )
            .await;
        } else {
            dispatch_echo(&state, &chat_id, &prompt, &topic, &body).await;
        }

        // Auto-drain: while the chat is in auto mode and the queue
        // has pending items, pop them one at a time. The drain runs
        // in this same task so per-chat ordering is preserved and
        // the `dispatching` flag stays set until the very end.
        while state.queues.read().await.is_auto(&chat_id) {
            let next_item = state.queues.write().await.pop_next_pending(&chat_id);
            let Some(item) = next_item else { break };

            // Resolve the chat record + insert a prompt placeholder.
            // If EITHER step fails (chat deleted, prompt insert
            // race), we must NOT leave the item we just popped
            // sitting in the queue as Running — that's the orphan
            // bug. Roll it back to Pending so a subsequent
            // run_next (or the user re-enabling auto mode) can pick
            // it up again.
            let drain = {
                let mut reg = state.chats.write().await;
                let chat_opt = reg.get(&chat_id).cloned();
                match chat_opt {
                    None => None,
                    Some(c) => reg
                        .add_prompt(&chat_id, item.body.clone())
                        .map(|p| (p, c)),
                }
            };
            let Some((drain_prompt, drain_chat)) = drain else {
                state.queues.write().await.reset_to_pending(&chat_id, &item.id);
                break;
            };
            let drain_topic = format!("chat:{chat_id}");
            let drain_cwd = resolve_cwd(&state, &drain_chat).await;
            let drain_provider = state.providers.get(&drain_chat.provider);
            if let Some(p) = drain_provider {
                dispatch_via_provider(
                    &state,
                    &chat_id,
                    &drain_prompt,
                    &drain_topic,
                    p,
                    &item.body,
                    &drain_chat.model,
                    drain_chat.session_id.clone(),
                    drain_chat.effort.clone(),
                    drain_cwd,
                )
                .await;
            } else {
                dispatch_echo(&state, &chat_id, &drain_prompt, &drain_topic, &item.body).await;
            }
            state.queues.write().await.mark_done(&chat_id, &item.id);
            state.logbus.publish(
                &drain_topic,
                serde_json::json!({ "queue_dispatched": item.id }).to_string(),
            );
        }

        // Happy-path clear: release the dispatching flag + publish
        // chat_idle SYNCHRONOUSLY before this task ends so a
        // follow-up run_next or smart-send sees the cleared flag
        // immediately. Without this we'd rely on the `_guard`'s
        // Drop, which spawns a fresh task to clear (Drop can't
        // .await) and opens a small race window where run_next
        // returns 409 even though the agent is actually idle.
        //
        // The guard still runs at end-of-scope as panic-safety; in
        // the happy path its spawn just no-ops because the flag is
        // already gone.
        {
            let mut set = state.dispatching.lock().await;
            set.remove(&chat_id);
        }
        let idle_topic = format!("chat:{chat_id}");
        state.logbus.publish(
            &idle_topic,
            serde_json::json!({ "chat_idle": true }).to_string(),
        );
        drop(_guard);
    });
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
    effort: Option<String>,
    cwd: std::path::PathBuf,
) {
    use agentgrove_agents::SpawnOptions;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    let opts = SpawnOptions {
        cwd,
        model: Some(model.to_string()),
        resume_session_id,
        effort,
    };
    let prompt_text = user_text.to_string();
    let provider_for_task = provider.clone();
    let spawn_task = tokio::spawn(async move {
        provider_for_task.spawn(&prompt_text, opts, tx).await
    });

    // Coalescing state. Providers (Claude in particular) emit one
    // Token / Thinking event per text-delta — sometimes per character.
    // We keep two independent buffers and flush each when either:
    //   - the buffer reaches `FLUSH_BYTES`, or
    //   - `FLUSH_INTERVAL` has passed since the last flush, or
    //   - a non-matching event arrives (forces ordering).
    // See ADR-0006 for the budget rationale.
    const FLUSH_BYTES: usize = 64;
    const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    let mut pending_token = String::new();
    let mut pending_thinking = String::new();

    /// Kind of streaming-text buffer the coalescer is flushing. Lets a
    /// single `flush_pending` helper emit either AgentEvent variant.
    #[derive(Clone, Copy)]
    enum BufKind {
        Token,
        Thinking,
    }

    async fn flush_pending(
        state: &AppState,
        chat_id: &str,
        prompt: &PromptRecord,
        topic: &str,
        kind: BufKind,
        pending: &mut String,
    ) {
        if pending.is_empty() {
            return;
        }
        let text = std::mem::take(pending);
        let ev = match kind {
            BufKind::Token => AgentEvent::Token { text },
            BufKind::Thinking => AgentEvent::Thinking { text },
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
        let next = tokio::time::timeout(FLUSH_INTERVAL, rx.recv()).await;
        match next {
            // Timed out: flush whatever we've buffered.
            Err(_) => {
                flush_pending(
                    state,
                    chat_id,
                    prompt,
                    topic,
                    BufKind::Token,
                    &mut pending_token,
                )
                .await;
                flush_pending(
                    state,
                    chat_id,
                    prompt,
                    topic,
                    BufKind::Thinking,
                    &mut pending_thinking,
                )
                .await;
                continue;
            }
            // Channel closed: spawn finished.
            Ok(None) => break,
            // Got an event.
            Ok(Some(ev)) => match ev {
                AgentEvent::Token { text } => {
                    // Switching streams: flush the other buffer first.
                    flush_pending(
                        state,
                        chat_id,
                        prompt,
                        topic,
                        BufKind::Thinking,
                        &mut pending_thinking,
                    )
                    .await;
                    pending_token.push_str(&text);
                    if pending_token.len() >= FLUSH_BYTES {
                        flush_pending(
                            state,
                            chat_id,
                            prompt,
                            topic,
                            BufKind::Token,
                            &mut pending_token,
                        )
                        .await;
                    }
                }
                AgentEvent::Thinking { text } => {
                    flush_pending(
                        state,
                        chat_id,
                        prompt,
                        topic,
                        BufKind::Token,
                        &mut pending_token,
                    )
                    .await;
                    pending_thinking.push_str(&text);
                    if pending_thinking.len() >= FLUSH_BYTES {
                        flush_pending(
                            state,
                            chat_id,
                            prompt,
                            topic,
                            BufKind::Thinking,
                            &mut pending_thinking,
                        )
                        .await;
                    }
                }
                other => {
                    // Any other event forces both stream buffers to
                    // flush so the ordering stays intact (any text
                    // deltas precede the tool call / done / error
                    // they produced).
                    flush_pending(
                        state,
                        chat_id,
                        prompt,
                        topic,
                        BufKind::Token,
                        &mut pending_token,
                    )
                    .await;
                    flush_pending(
                        state,
                        chat_id,
                        prompt,
                        topic,
                        BufKind::Thinking,
                        &mut pending_thinking,
                    )
                    .await;

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
    // Final flush in case the stream ended with buffered text.
    flush_pending(
        state,
        chat_id,
        prompt,
        topic,
        BufKind::Token,
        &mut pending_token,
    )
    .await;
    flush_pending(
        state,
        chat_id,
        prompt,
        topic,
        BufKind::Thinking,
        &mut pending_thinking,
    )
    .await;

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
            None,
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
