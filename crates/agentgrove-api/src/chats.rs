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
    pub(crate) by_id: HashMap<String, ChatRecord>,
    pub(crate) by_project: HashMap<String, Vec<String>>,
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
        self.by_project
            .get(project_id)
            .map(|v| v.len())
            .unwrap_or(0)
    }

    /// List all chats for a project. If `worktree_id` is `Some(_)`,
    /// returns only chats scoped to that worktree (plus chats that match
    /// the supplied id). If `None`, returns all chats in the project.
    pub fn list_for_project(&self, project_id: &str, worktree_id: Option<&str>) -> Vec<ChatRecord> {
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
                let has_sentinel = matches!(p.events.first(), Some(AgentEvent::Truncated { .. }));
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

    /// Insert a pre-built chat (used by hydration to load rows from
    /// the SQLite store at startup). Skips the usual id-generation
    /// because the caller already has the persisted id.
    pub fn ingest_chat(&mut self, rec: ChatRecord) {
        self.by_project
            .entry(rec.project_id.clone())
            .or_default()
            .push(rec.id.clone());
        self.by_id.insert(rec.id.clone(), rec);
    }

    /// Replace the prompt vector of an existing chat. Used during
    /// hydration to splice the persisted prompts back in after the
    /// chat row has been ingested.
    pub fn ingest_prompts(&mut self, chat_id: &str, prompts: Vec<PromptRecord>) {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            chat.prompts = prompts;
        }
    }

    /// Append a pre-built prompt (with the store-issued id + seq).
    /// Used by `persist_add_prompt` so the in-memory record matches
    /// the persisted one exactly. Returns whether the chat existed.
    pub fn ingest_prompt(&mut self, chat_id: &str, prompt: PromptRecord) -> bool {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            chat.prompts.push(prompt);
            true
        } else {
            false
        }
    }

    /// Remove a chat from the cache. The store-side cascade handles
    /// the actual deletion; this just keeps the cache in sync.
    pub fn evict(&mut self, chat_id: &str) {
        if let Some(rec) = self.by_id.remove(chat_id) {
            if let Some(ids) = self.by_project.get_mut(&rec.project_id) {
                ids.retain(|i| i != chat_id);
            }
        }
    }

    /// Drop every cached chat for which `keep(&rec)` returns false.
    /// Used by the project-delete cascade: we walk the by_id map
    /// and evict any chat whose project_id matches the deleted
    /// project so the FE doesn't keep showing orphans until the
    /// next page reload.
    pub fn retain_chats<F: FnMut(&ChatRecord) -> bool>(&mut self, mut keep: F) {
        let drop_ids: Vec<String> = self
            .by_id
            .values()
            .filter(|c| !keep(c))
            .map(|c| c.id.clone())
            .collect();
        for id in drop_ids {
            self.evict(&id);
        }
    }

    /// Borrow a chat mutably so a store-roundtrip method can update
    /// the cached events vec after a persist. The public callers
    /// stay shielded behind the helpers below.
    pub fn chat_mut(&mut self, chat_id: &str) -> Option<&mut ChatRecord> {
        self.by_id.get_mut(chat_id)
    }
}

/// Hydrate the in-memory chat registry from the persistent
/// `ChatRepo` store. Called once on server startup. Without this,
/// every restart wiped the user's session continuity — which broke
/// the project's basic usability story. See
/// `docs/architecture/chat-queue-routing.md` for the full
/// persistence model.
///
/// Errors fetching individual prompts are logged + skipped so a
/// single corrupt row doesn't block the whole boot.
pub async fn hydrate_from_store(state: &AppState) {
    let chats = match state.chat_store.list_all().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "failed to list chats from store; starting empty");
            return;
        }
    };
    let mut reg = state.chats.write().await;
    for row in chats {
        let prompts = match state.chat_store.list_prompts(&row.id, None, None).await {
            Ok(rows) => rows
                .into_iter()
                .filter_map(prompt_from_store_row)
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    chat_id = %row.id,
                    error = %e,
                    "failed to load prompts; chat will appear empty",
                );
                vec![]
            }
        };
        let chat = chat_from_store_row(row, prompts);
        reg.ingest_chat(chat);
    }
}

fn chat_from_store_row(row: agentgrove_store::ChatRow, prompts: Vec<PromptRecord>) -> ChatRecord {
    ChatRecord {
        id: row.id,
        project_id: row.project_id,
        worktree_id: row.worktree_id,
        title: row.title,
        provider: row.provider,
        model: row.model,
        created_at: row.created_at,
        prompts,
        session_id: row.session_id,
        effort: row.effort,
    }
}

fn prompt_from_store_row(row: agentgrove_store::PromptRow) -> Option<PromptRecord> {
    // The store keeps `events` + `touched_paths` as opaque JSON;
    // we map them back into the strongly-typed in-memory form. A
    // parse failure means the row was written by a future BE
    // version — we keep the prompt but drop its events so the
    // chat still renders.
    let events: Vec<AgentEvent> = serde_json::from_value(row.events.clone()).unwrap_or_else(|_| {
        tracing::warn!(
            prompt_id = %row.id,
            "events_json failed to deserialise; dropping events for this prompt",
        );
        vec![]
    });
    let touched_paths: Vec<String> =
        serde_json::from_value(row.touched_paths.clone()).unwrap_or_default();
    Some(PromptRecord {
        id: row.id,
        seq: row.seq,
        content: row.content,
        events,
        touched_paths,
        created_at: row.created_at,
    })
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

    persist_create_chat(
        &state,
        project_id,
        body.worktree_id,
        body.title,
        body.provider,
        body.model,
        body.effort,
    )
    .await
    .map(Json)
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

    persist_create_chat(
        &state,
        project_id,
        Some(wt),
        body.title,
        body.provider,
        body.model,
        body.effort,
    )
    .await
    .map(Json)
}

/// Persist a single prompt + ingest into the cache. The store
/// owns the id + seq so the cached record can't ever diverge from
/// disk.
pub(crate) async fn persist_add_prompt(
    state: &AppState,
    chat_id: &str,
    content: &str,
) -> Result<Option<PromptRecord>, agentgrove_store::ChatError> {
    let row = state.chat_store.add_prompt(chat_id, content).await?;
    let prompt = PromptRecord {
        id: row.id,
        seq: row.seq,
        content: row.content,
        events: vec![],
        touched_paths: vec![],
        created_at: row.created_at,
    };
    let mut reg = state.chats.write().await;
    let ok = reg.ingest_prompt(chat_id, prompt.clone());
    Ok(if ok { Some(prompt) } else { None })
}

/// Flush the current in-memory `events` vec for a prompt to the
/// store. Called on terminal events (`done` / `error`) so the high-
/// frequency token deltas don't slam SQLite while still surviving
/// restart. Fire-and-forget on the store side: errors are logged
/// rather than propagated because the in-memory state is already
/// correct — losing a flush just means the next restart shows the
/// turn one step short.
pub(crate) async fn persist_prompt_events(state: &AppState, prompt_id: &str) {
    // Resolve the chat + prompt from the cache first so we can
    // serialise the current events without holding the read lock
    // across the SQLite call.
    let events_json = {
        let reg = state.chats.read().await;
        let mut found = None;
        for chat in reg.by_id.values() {
            if let Some(p) = chat.prompts.iter().find(|p| p.id == prompt_id) {
                found = Some(serde_json::to_value(&p.events));
                break;
            }
        }
        match found {
            Some(Ok(v)) => v,
            Some(Err(e)) => {
                tracing::warn!(prompt_id, error = %e, "events serialise failed");
                return;
            }
            None => return,
        }
    };
    if let Err(e) = state.chat_store.write_events(prompt_id, &events_json).await {
        tracing::warn!(prompt_id, error = %e, "events persist failed");
    }
}

/// Persist a chat-level field update (rename / model / effort /
/// session id) and update the cache. Setting a new model implicitly
/// clears the session id since resume tokens are model-bound — we
/// mirror that contract through the store too so a restart can't
/// resurrect a stale token.
pub(crate) async fn persist_chat_update(
    state: &AppState,
    chat_id: &str,
    title: Option<&str>,
    model: Option<&str>,
    effort: Option<Option<&str>>,
    session_id: Option<Option<&str>>,
) -> Result<(), agentgrove_store::ChatError> {
    // Resolve whether `model` is actually changing so we know
    // whether to also clear session_id transparently.
    let model_changes = if let Some(new_model) = model {
        let reg = state.chats.read().await;
        match reg.get(chat_id) {
            Some(c) => c.model != new_model,
            None => true,
        }
    } else {
        false
    };
    // If the model is changing AND the caller didn't already pass
    // session_id, force-clear it.
    let effective_session: Option<Option<&str>> = if model_changes && session_id.is_none() {
        Some(None)
    } else {
        session_id
    };
    state
        .chat_store
        .update(chat_id, title, model, effort, effective_session)
        .await?;
    let mut reg = state.chats.write().await;
    if let Some(chat) = reg.chat_mut(chat_id) {
        if let Some(t) = title {
            chat.title = t.to_owned();
        }
        if let Some(m) = model {
            if chat.model != m {
                chat.model = m.to_owned();
                chat.session_id = None;
            }
        }
        if let Some(e) = effort {
            chat.effort = e.map(str::to_owned);
        }
        if let Some(s) = effective_session {
            chat.session_id = s.map(str::to_owned);
        }
    }
    Ok(())
}

/// Delete a chat from BOTH the store and the cache.
#[allow(dead_code)]
pub(crate) async fn persist_chat_delete(
    state: &AppState,
    chat_id: &str,
) -> Result<bool, agentgrove_store::ChatError> {
    let removed = state.chat_store.delete(chat_id).await?;
    state.chats.write().await.evict(chat_id);
    Ok(removed)
}

/// Create a chat in BOTH the persistent store and the in-memory
/// registry, returning the canonical record. The store write happens
/// first so the row's UUID is what we hand back to the caller — the
/// in-memory registry uses the same id so future writes keep them in
/// sync.
///
/// If the store insert fails (e.g. a project_id FK violation because
/// the project was deleted between the validation above and the
/// insert here) we return a 500 with the underlying error message;
/// the FE surfaces it as an error toast.
async fn persist_create_chat(
    state: &AppState,
    project_id: String,
    worktree_id: Option<String>,
    title: String,
    provider: String,
    model: String,
    effort: Option<String>,
) -> Result<ChatRecord, (StatusCode, String)> {
    let trimmed = title.trim().to_owned();
    if trimmed.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "title is empty".into()));
    }
    let row = state
        .chat_store
        .create(
            &project_id,
            worktree_id.as_deref(),
            &trimmed,
            &provider,
            &model,
            effort.as_deref(),
        )
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("chat store: {e}"),
            )
        })?;

    let rec = ChatRecord {
        id: row.id,
        project_id: row.project_id,
        worktree_id: row.worktree_id,
        title: row.title,
        provider: row.provider,
        model: row.model,
        created_at: row.created_at,
        prompts: vec![],
        session_id: row.session_id,
        effort: row.effort,
    };

    let mut reg = state.chats.write().await;
    reg.ingest_chat(rec.clone());
    drop(reg);

    // Cross-instance sync: tell every browser/tab subscribed to
    // the global `sync` topic that a new chat appeared so they
    // can refresh their LeftRail chat lists. Payload stays tiny
    // (ids + scope) — clients pull the full chat record on
    // demand via GET /api/projects/:id/chats.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "chat_created",
            "chat_id": rec.id,
            "project_id": rec.project_id,
            "worktree_id": rec.worktree_id,
        })
        .to_string(),
    );
    Ok(rec)
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

/// `DELETE /api/chats/:id` — soft-delete a chat.
pub async fn delete_chat(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    persist_chat_delete(&state, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/chats/history` — list soft-deleted chats.
/// Optional query params: `project_id`, `q` (title search).
#[derive(Debug, Deserialize)]
pub struct ChatHistoryQuery {
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub q: Option<String>,
}

pub async fn chat_history(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<ChatHistoryQuery>,
) -> Result<Json<Vec<ChatRecord>>, StatusCode> {
    let rows = state
        .chat_store
        .list_deleted(
            q.project_id.as_deref(),
            q.worktree_id.as_deref(),
            q.q.as_deref(),
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let out: Vec<ChatRecord> = rows
        .into_iter()
        .map(|r| ChatRecord {
            id: r.id,
            project_id: r.project_id,
            worktree_id: r.worktree_id,
            title: r.title,
            provider: r.provider,
            model: r.model,
            created_at: r.created_at,
            prompts: Vec::new(),
            session_id: r.session_id,
            effort: r.effort,
        })
        .collect();
    Ok(Json(out))
}

/// `POST /api/chats/:id/restore` — restore a soft-deleted chat.
pub async fn restore_chat(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ChatRecord>, (StatusCode, String)> {
    let row = state
        .chat_store
        .restore(&id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("chat {id} not found or not deleted"),
        ))?;
    let rec = ChatRecord {
        id: row.id,
        project_id: row.project_id,
        worktree_id: row.worktree_id,
        title: row.title,
        provider: row.provider,
        model: row.model,
        created_at: row.created_at,
        prompts: Vec::new(),
        session_id: row.session_id,
        effort: row.effort,
    };
    state.chats.write().await.ingest_chat(rec.clone());
    Ok(Json(rec))
}

/// One active (mid-turn) chat, with the project/worktree it belongs
/// to so the FE can light up the matching left-rail row.
#[derive(Debug, Serialize)]
pub struct ActiveChat {
    pub chat_id: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
}

/// `GET /api/chats/active` — chats that currently have an in-flight
/// agent turn (server truth, from `state.dispatching`). The FE polls
/// this to show a per-project/worktree "working" indicator in the
/// left rail, independent of which chat tab is open. Cheap: a single
/// set intersection under two short-lived read locks.
pub async fn active_chats(State(state): State<AppState>) -> Json<Vec<ActiveChat>> {
    let dispatching = state.dispatching.lock().await;
    let reg = state.chats.read().await;
    let out: Vec<ActiveChat> = dispatching
        .iter()
        .filter_map(|id| {
            reg.get(id).map(|c| ActiveChat {
                chat_id: c.id.clone(),
                project_id: c.project_id.clone(),
                worktree_id: c.worktree_id.clone(),
            })
        })
        .collect();
    Json(out)
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
    {
        let reg = state.chats.read().await;
        if reg.get(&id).is_none() {
            return Err((StatusCode::NOT_FOUND, format!("chat {id} not found")));
        }
    }
    let title_owned: Option<String> = match body.title {
        Some(raw) => {
            let trimmed = raw.trim().to_owned();
            if trimmed.is_empty() {
                return Err((StatusCode::BAD_REQUEST, "title cannot be empty".into()));
            }
            Some(trimmed)
        }
        None => None,
    };
    let model_owned: Option<String> = match body.model {
        Some(raw) => {
            let trimmed = raw.trim().to_owned();
            if trimmed.is_empty() {
                return Err((StatusCode::BAD_REQUEST, "model cannot be empty".into()));
            }
            Some(trimmed)
        }
        None => None,
    };
    let effort_owned: Option<Option<String>> = body.effort.map(|inner| {
        inner.and_then(|s| {
            let trimmed = s.trim().to_owned();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
    });

    persist_chat_update(
        &state,
        &id,
        title_owned.as_deref(),
        model_owned.as_deref(),
        effort_owned.as_ref().map(|o| o.as_deref()),
        None,
    )
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("chat store: {e}"),
        )
    })?;

    let reg = state.chats.read().await;
    let rec = reg
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, format!("chat {id} not found")))?;
    let project_id = rec.project_id.clone();
    let worktree_id = rec.worktree_id.clone();
    let view = window_chat(rec);
    drop(reg);

    // Cross-instance sync: notify all subscribers that this chat
    // changed (title rename, model/effort tweak). Payload carries
    // the chat id + scope so the FE can decide if it cares — a
    // tab pointing at a different project ignores the message.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "chat_updated",
            "chat_id": id,
            "project_id": project_id,
            "worktree_id": worktree_id,
        })
        .to_string(),
    );
    Ok(Json(view))
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
    let limit = (q.limit).clamp(1, 200) as usize;
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
    let chat = {
        let reg = state.chats.read().await;
        reg.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone()
    };
    let prompt = persist_add_prompt(&state, &id, &body.content)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

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
    let pending_in_queue = crate::queue::read_state(&state, &id)
        .await
        .items
        .iter()
        .filter(|i| i.status == crate::queue::Status::Pending)
        .count();

    if is_dispatching || pending_in_queue > 0 {
        // Enqueue. Three cases:
        //
        //   (a) is_dispatching=true → an active drain loop is
        //       running and will pick this up.
        //   (b) is_dispatching=false, mode=auto, pending>0 → the
        //       previous drain finished before our enqueue landed;
        //       we need to kick a fresh drain so this + the older
        //       pending items get processed. We claim the
        //       dispatching flag while still holding the routing
        //       lock so a concurrent smart-send cannot also kick
        //       (which would double-dispatch).
        //   (c) is_dispatching=false, mode=manual → user is
        //       explicitly running things manually; leave the item
        //       parked.
        //
        // Case (b) was the bug: without it, fast successive
        // smart-sends could outrun the drain, leaving items
        // permanently stuck.
        let item = crate::queue::enqueue_item(&state, &id, &body.content)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let need_kick = if !is_dispatching {
            let auto = crate::queue::is_auto(&state, &id).await;
            if auto {
                dispatching.insert(id.clone());
                true
            } else {
                false
            }
        } else {
            false
        };
        drop(dispatching);
        if need_kick {
            spawn_drain_task(state.clone(), id.clone());
        }
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
    let chat = {
        let reg = state.chats.read().await;
        reg.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone()
    };
    let prompt = persist_add_prompt(&state, &id, &body.content)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    drop(dispatching);

    spawn_dispatch_task(state.clone(), id, chat, prompt.clone(), body.content);
    Ok(Json(SendMessageResponse::Dispatched { prompt }))
}

/// `POST /api/chats/:id/stop` — cancel the chat's in-flight turn.
///
/// Looks up the per-chat `CancellationToken` installed by the
/// dispatch task and trips it. The token's `cancelled()` future
/// wins the `tokio::select!` inside `dispatch_via_provider`, which
/// drops the provider's spawn future — and with it the
/// `tokio::process::Child` (created with `kill_on_drop`), which
/// terminates the CLI subprocess. The dispatch task then appends a
/// synthetic `error: cancelled by user` event so the prompt's
/// history shows why the turn ended, and the dispatching flag is
/// released via `DispatchGuard` so the user can send the next
/// message immediately.
///
/// Returns:
///   - 204 if we successfully tripped a running turn.
///   - 404 if there's no in-flight turn for the chat (idle, or
///     already cancelled).
pub async fn stop_turn(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    let token = {
        let map = state.cancel_tokens.lock().await;
        map.get(&id).cloned()
    };
    let result = match token {
        Some(t) => {
            t.cancel();
            StatusCode::NO_CONTENT
        }
        None => {
            // No in-flight turn. Check if the tail prompt is stuck
            // (0 events / no terminal event) and write a synthetic
            // error so the chat doesn't stay permanently "busy" on
            // reload.
            if let Ok(prompts) = state.chat_store.list_prompts(&id, None, None).await {
                if let Some(tail) = prompts.last() {
                    let events: Vec<serde_json::Value> =
                        tail.events.as_array().cloned().unwrap_or_default();
                    let has_terminal = events.iter().any(|e| {
                        e.get("type")
                            .and_then(|t| t.as_str())
                            .map(|t| t == "done" || t == "error")
                            .unwrap_or(false)
                    });
                    if !has_terminal {
                        let mut patched = events;
                        patched.push(serde_json::json!({
                            "type": "error",
                            "message": "Turn did not complete — the agent may have crashed or timed out."
                        }));
                        let patched_json = serde_json::Value::Array(patched);
                        let _ = state.chat_store.write_events(&tail.id, &patched_json).await;
                    }
                }
            }
            StatusCode::NOT_FOUND
        }
    };

    // After cancelling the in-flight turn, make sure a queued backlog
    // doesn't get stranded. The dispatch task that was running its own
    // post-turn drain may have already exited (or never started a drain
    // — e.g. a direct, non-queue send that the user stopped), leaving
    // auto-mode items sitting with no drainer. If the chat is no longer
    // dispatching, the queue is in auto mode, and items remain pending,
    // kick a fresh drain so the next message goes out automatically —
    // which is exactly what users expect after hitting Stop.
    {
        let mut dispatching = state.dispatching.lock().await;
        let is_dispatching = dispatching.contains(&id);
        if !is_dispatching && crate::queue::is_auto(&state, &id).await {
            let pending = crate::queue::read_state(&state, &id)
                .await
                .items
                .iter()
                .filter(|i| i.status == crate::queue::Status::Pending)
                .count();
            if pending > 0 {
                dispatching.insert(id.clone());
                drop(dispatching);
                spawn_drain_task(state.clone(), id.clone());
            }
        }
    }

    result
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
            state
                .logbus
                .publish(&topic, serde_json::json!({ "chat_idle": true }).to_string());
        });
    }
}

/// Spawn a drain-only task for `chat_id`. The dispatching flag is
/// assumed to already be set by the caller (so concurrent smart-
/// sends route correctly); this task only pops + dispatches queue
/// items and clears the flag on exit.
pub(crate) fn spawn_drain_task(state: AppState, chat_id: String) {
    tokio::spawn(async move {
        let _guard = DispatchGuard {
            state: state.clone(),
            chat_id: chat_id.clone(),
        };
        drain_until_idle(&state, &chat_id).await;
        drop(_guard);
    });
}

/// Drain loop body with re-check: keeps draining + tries to clear
/// the dispatching flag, looping if a concurrent enqueue arrived
/// during our drain. This is the only safe way to release the
/// flag under the rapid-fire enqueue pattern; see `clear_dispatching`.
async fn drain_until_idle(state: &AppState, chat_id: &str) {
    loop {
        drain_loop(state, chat_id).await;
        if clear_dispatching(state, chat_id).await {
            return;
        }
        // Items arrived; loop and drain again.
    }
}

/// Drain loop body. Extracted from `spawn_dispatch_task` so the
/// initial-dispatch path and the "kicked" drain-only path share
/// the same code.
async fn drain_loop(state: &AppState, chat_id: &str) {
    while crate::queue::is_auto(state, chat_id).await {
        let next_item = match crate::queue::pop_next_pending(state, chat_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(chat_id, error = %e, "queue pop failed; ending drain");
                break;
            }
        };
        let Some(item) = next_item else {
            break;
        };
        if !crate::queue::is_auto(state, chat_id).await {
            let _ = crate::queue::reset_to_pending(state, &item.id).await;
            break;
        }

        let chat_opt = {
            let reg = state.chats.read().await;
            reg.get(chat_id).cloned()
        };
        let Some(drain_chat) = chat_opt else {
            let _ = crate::queue::reset_to_pending(state, &item.id).await;
            break;
        };
        let drain_prompt = match persist_add_prompt(state, chat_id, &item.body).await {
            Ok(Some(p)) => p,
            _ => {
                let _ = crate::queue::reset_to_pending(state, &item.id).await;
                break;
            }
        };
        let drain_topic = format!("chat:{chat_id}");
        let drain_cwd = resolve_cwd(state, &drain_chat).await;
        let drain_provider = crate::providers::resolve(state, &drain_chat.provider).await;
        if let Some(p) = drain_provider {
            dispatch_via_provider(
                state,
                chat_id,
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
            dispatch_echo(state, chat_id, &drain_prompt, &drain_topic, &item.body).await;
        }
        if let Err(e) = crate::queue::mark_done(state, &item.id).await {
            tracing::warn!(item_id = %item.id, error = %e, "queue mark_done failed");
        }
        state.logbus.publish(
            &drain_topic,
            serde_json::json!({ "queue_dispatched": item.id }).to_string(),
        );
    }
}

/// Clear the dispatching flag + publish `chat_idle`. Pulled out so
/// both `spawn_dispatch_task` and `spawn_drain_task` share it.
///
/// Returns `true` if we successfully released the flag, `false` if
/// we observed a pending queue item under the lock and therefore
/// kept the flag held (the caller must continue draining). This
/// "double-check under lock" closes a race where a smart-send
/// could enqueue between our last `pop_next_pending` and the flag
/// clear, leaving the item stranded with no drainer.
async fn clear_dispatching(state: &AppState, chat_id: &str) -> bool {
    let mut set = state.dispatching.lock().await;
    // Check the queue UNDER the dispatching lock so any concurrent
    // smart-send is either:
    //   (a) already finished (item visible to us → don't clear), OR
    //   (b) waiting on the lock (it'll see us as still-dispatching
    //       once it enters, route to enqueue, and trigger a kick
    //       OR rely on our caller to keep draining).
    let pending = crate::queue::read_state(state, chat_id)
        .await
        .items
        .iter()
        .filter(|i| i.status == crate::queue::Status::Pending)
        .count();
    if pending > 0 && crate::queue::is_auto(state, chat_id).await {
        // Items arrived between our last drain pass and now. Keep
        // the flag held; caller will loop again.
        return false;
    }
    set.remove(chat_id);
    drop(set);
    let topic = format!("chat:{chat_id}");
    state
        .logbus
        .publish(&topic, serde_json::json!({ "chat_idle": true }).to_string());
    true
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
        let provider = crate::providers::resolve(&state, &chat.provider).await;
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
        // Auto-drain (loops until queue + clear are both atomic).
        drain_until_idle(&state, &chat_id).await;
        drop(_guard);
    });
}

/// Resolve the working directory for a chat: worktree path when the
/// chat is scoped to one, else the project root, else `/tmp` as a last
/// resort (which only happens if the chat is orphaned).
async fn resolve_cwd(state: &AppState, chat: &ChatRecord) -> std::path::PathBuf {
    if let Some(wt_id) = chat.worktree_id.as_deref() {
        match state.worktrees.get(wt_id).await {
            Ok(wt) => {
                tracing::info!(
                    chat_id = %chat.id,
                    worktree_id = %wt_id,
                    cwd = %wt.path.display(),
                    "resolve_cwd: using worktree path"
                );
                return wt.path;
            }
            Err(e) => {
                tracing::warn!(
                    chat_id = %chat.id,
                    worktree_id = %wt_id,
                    error = %e,
                    "resolve_cwd: worktree lookup failed; falling back to project root"
                );
            }
        }
    }
    match state.projects.get(&chat.project_id).await {
        Ok(p) => {
            tracing::info!(
                chat_id = %chat.id,
                project_id = %chat.project_id,
                cwd = %p.root.display(),
                "resolve_cwd: using project root"
            );
            p.root
        }
        Err(e) => {
            tracing::warn!(
                chat_id = %chat.id,
                project_id = %chat.project_id,
                error = %e,
                "resolve_cwd: project lookup failed; using /tmp"
            );
            std::path::PathBuf::from("/tmp")
        }
    }
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
    // Effective auto-approve = global default from settings.json
    // (defaulting to `true`) until the per-chat override lands in
    // migration 0010 + ChatRecord. Reading the file per turn is
    // fine: it's a few hundred bytes on local disk and dispatch is
    // already an I/O-heavy moment.
    let auto_approve_tools = crate::settings::load(&state.state_dir)
        .await
        .is_auto_approve_default();
    let opts = SpawnOptions {
        cwd,
        model: Some(model.to_string()),
        resume_session_id,
        effort,
        auto_approve_tools,
    };
    let prompt_text = user_text.to_string();
    let provider_for_task = provider.clone();
    // Install a per-chat cancellation token so the caller can
    // abort this turn via `POST /api/chats/:id/cancel`. The token
    // is dropped on exit so subsequent turns get a fresh one.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let mut map = state.cancel_tokens.lock().await;
        map.insert(chat_id.to_string(), cancel_token.clone());
    }
    let cancel_for_task = cancel_token.clone();
    let spawn_task = tokio::spawn(async move {
        // Race the provider against the cancellation token. On
        // cancel we return Ok(()) so the outer flow treats it as
        // a clean shutdown — the synthetic "cancelled" event is
        // appended below.
        tokio::select! {
            biased;
            _ = cancel_for_task.cancelled() => Ok(()),
            res = provider_for_task.spawn(&prompt_text, opts, tx) => res,
        }
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
                        // Persist + cache in one helper so a restart
                        // remembers the provider's resume token.
                        let sid = session_id.clone();
                        if let Err(e) =
                            persist_chat_update(state, chat_id, None, None, None, Some(Some(&sid)))
                                .await
                        {
                            tracing::warn!(chat_id, error = %e, "persist session_id failed");
                        }
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
    // Special-case cancellation: if the user cancelled the turn,
    // emit a friendlier "cancelled by user" error so the FE can
    // style it differently (and the persisted history shows why
    // the turn ended early).
    let was_cancelled = cancel_token.is_cancelled();
    match spawn_task.await {
        Ok(Ok(())) if was_cancelled => {
            let ev = AgentEvent::Error {
                message: "cancelled by user".to_string(),
            };
            let payload = serde_json::json!({
                "prompt_id": prompt.id,
                "event": ev,
            });
            state.logbus.publish(topic, payload.to_string());
            let mut reg = state.chats.write().await;
            reg.append_event(chat_id, &prompt.id, ev);
        }
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
    // Drop the cancel token from the map — subsequent turns get a
    // fresh one. Doing this *before* the persist guarantees a
    // race-free state.cancel_tokens map.
    {
        let mut map = state.cancel_tokens.lock().await;
        map.remove(chat_id);
    }
    // Persist the prompt's final events array so the turn survives
    // a restart. We deliberately wait until the spawn task ends —
    // mid-stream token deltas would slam SQLite at ~20 writes/sec.
    persist_prompt_events(state, &prompt.id).await;
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
    // Persist the now-complete events array so a restart preserves
    // the turn. dispatch_via_provider has its own flush at the
    // bottom; echo is the simpler test path.
    persist_prompt_events(state, &prompt.id).await;
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
