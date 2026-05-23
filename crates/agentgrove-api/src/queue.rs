//! Prompt queue. Per-chat ordered queue with auto/manual modes.
//!
//! Backed by `agentgrove_store::QueueRepo` (SQLite) so pending
//! messages and the per-chat mode toggle survive a server restart.
//! There is no in-memory registry — every operation goes straight to
//! the store. The store rows are small and the queue is rarely deep,
//! so the round-trip cost is negligible compared to the previously-
//! ephemeral in-memory map. See `docs/architecture/chat-queue-routing.md`.

use crate::state::AppState;
use agentgrove_store::{QueueItemRow, QueueMode, QueueStatus};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Wire shape for queue mode. Mirrors `QueueMode` from the store but
/// owns its own serde because the FE serialises the snake-case form
/// (`"auto"` / `"manual"`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Drain pending messages back-to-back as the agent finishes.
    Auto,
    /// Park pending messages until the user runs them.
    Manual,
}

impl From<Mode> for QueueMode {
    fn from(m: Mode) -> Self {
        match m {
            Mode::Auto => Self::Auto,
            Mode::Manual => Self::Manual,
        }
    }
}
impl From<QueueMode> for Mode {
    fn from(m: QueueMode) -> Self {
        match m {
            QueueMode::Auto => Self::Auto,
            QueueMode::Manual => Self::Manual,
        }
    }
}

/// Wire shape for queue item lifecycle.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Waiting for dispatch.
    Pending,
    /// Popped + currently being dispatched.
    Running,
    /// Dispatch finished — items in this state are removed from the
    /// queue today; the variant stays for completeness.
    Done,
    /// Removed by the user.
    Cancelled,
}

impl From<QueueStatus> for Status {
    fn from(s: QueueStatus) -> Self {
        match s {
            QueueStatus::Pending => Self::Pending,
            QueueStatus::Running => Self::Running,
            QueueStatus::Done => Self::Done,
            QueueStatus::Cancelled => Self::Cancelled,
        }
    }
}

/// A single item the FE renders in the queue dock.
#[derive(Debug, Clone, Serialize)]
pub struct QueueItem {
    /// UUID v7 string assigned by the store.
    pub id: String,
    /// Owning chat.
    pub chat_id: String,
    /// User prompt text (with attachment trailer if any).
    pub body: String,
    /// Lifecycle status.
    pub status: Status,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
}

impl From<QueueItemRow> for QueueItem {
    fn from(r: QueueItemRow) -> Self {
        Self {
            id: r.id,
            chat_id: r.chat_id,
            body: r.body,
            status: r.status.into(),
            created_at: r.created_at,
        }
    }
}

/// Aggregated state for one chat's queue (mode + items).
#[derive(Debug, Clone, Serialize)]
pub struct QueueState {
    pub chat_id: String,
    pub mode: Mode,
    pub items: Vec<QueueItem>,
}

// ----- store-backed helpers --------------------------------------------------
//
// These replace the old `QueueRegistry` methods. Call sites that used
// to take a `state.queues.write().await` guard now call these
// helpers directly. They return `Result` because the underlying
// store calls can fail; the call sites either propagate the error
// or log + carry on depending on whether the operation is critical.

/// True if the chat's queue mode is auto. Defaults to true when no
/// row exists (the FE flips to manual only when the user toggles).
pub async fn is_auto(state: &AppState, chat_id: &str) -> bool {
    match state.queue_store.get_mode(chat_id).await {
        Ok(m) => matches!(m, QueueMode::Auto),
        Err(e) => {
            tracing::warn!(chat_id, error = %e, "queue mode read failed; defaulting to auto");
            true
        }
    }
}

/// Read the full queue state for a chat (mode + items, lowest
/// position first).
pub async fn read_state(state: &AppState, chat_id: &str) -> QueueState {
    let mode: Mode = state
        .queue_store
        .get_mode(chat_id)
        .await
        .unwrap_or(QueueMode::Auto)
        .into();
    let items: Vec<QueueItem> = state
        .queue_store
        .list(chat_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(Into::into)
        .collect();
    QueueState {
        chat_id: chat_id.to_owned(),
        mode,
        items,
    }
}

/// Append a new item to the queue's tail.
pub async fn enqueue_item(
    state: &AppState,
    chat_id: &str,
    body: &str,
) -> Result<QueueItem, agentgrove_store::QueueError> {
    state
        .queue_store
        .enqueue(chat_id, body)
        .await
        .map(Into::into)
}

/// Set the queue mode (auto or manual).
pub async fn write_mode(
    state: &AppState,
    chat_id: &str,
    mode: Mode,
) -> Result<(), agentgrove_store::QueueError> {
    state.queue_store.set_mode(chat_id, mode.into()).await
}

/// Pop the next pending item, marking it Running atomically.
pub async fn pop_next_pending(
    state: &AppState,
    chat_id: &str,
) -> Result<Option<QueueItem>, agentgrove_store::QueueError> {
    Ok(state
        .queue_store
        .pop_next_pending(chat_id)
        .await?
        .map(Into::into))
}

/// Remove a Running item from the queue (used after a successful
/// dispatch lands it as a real prompt in the timeline).
pub async fn mark_done(
    state: &AppState,
    item_id: &str,
) -> Result<bool, agentgrove_store::QueueError> {
    state.queue_store.mark_done(item_id).await
}

/// Roll a Running item back to Pending. Used when a drain task
/// bails out mid-flight.
pub async fn reset_to_pending(
    state: &AppState,
    item_id: &str,
) -> Result<bool, agentgrove_store::QueueError> {
    state.queue_store.reset_to_pending(item_id).await
}

/// Cancel (delete) a Pending item.
pub async fn cancel_item(
    state: &AppState,
    item_id: &str,
) -> Result<bool, agentgrove_store::QueueError> {
    state.queue_store.cancel(item_id).await
}

#[derive(Debug, Deserialize)]
pub struct EnqueueBody {
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct ModeBody {
    pub mode: Mode,
}

pub async fn get_queue(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Json<QueueState> {
    Json(read_state(&state, &chat_id).await)
}

pub async fn enqueue(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<EnqueueBody>,
) -> Result<Json<QueueItem>, StatusCode> {
    enqueue_item(&state, &chat_id, &body.body)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::warn!(chat_id, error = %e, "enqueue failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

pub async fn set_mode(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<ModeBody>,
) -> StatusCode {
    if let Err(e) = write_mode(&state, &chat_id, body.mode).await {
        tracing::warn!(chat_id, error = %e, "queue mode write failed");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

/// Manually dispatch the next pending queue item. Used by the FE
/// when the chat is in manual mode and the user clicks Run next.
///
/// Concurrency: we serialise via the same `dispatching` lock used by
/// `send_message` so a Run-next click can't slip past while an
/// agent turn is already mid-flight (which would dispatch two
/// parallel turns and corrupt session state). If the chat is busy
/// we return 409 so the FE can show "already running" instead of
/// silently double-firing.
pub async fn run_next(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<Json<QueueItem>, StatusCode> {
    let mut dispatching = state.dispatching.lock().await;
    if dispatching.contains(&chat_id) {
        return Err(StatusCode::CONFLICT);
    }
    let item = pop_next_pending(&state, &chat_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Insert the dispatching flag + record the prompt under the
    // same lock so a concurrent `send_message` sees us as busy and
    // routes its message to the queue (the correct FIFO behaviour).
    let chat = {
        let reg = state.chats.read().await;
        match reg.get(&chat_id) {
            Some(c) => c.clone(),
            None => return Err(StatusCode::NOT_FOUND),
        }
    };
    let prompt = match crate::chats::persist_add_prompt(&state, &chat_id, &item.body).await {
        Ok(Some(p)) => p,
        _ => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };
    dispatching.insert(chat_id.clone());
    drop(dispatching);

    // Mark the queue item done (i.e. remove it) up front — it's
    // already been turned into a real prompt and will live on in
    // the timeline. The spawned task handles streaming + any
    // follow-up auto-drain.
    if let Err(e) = mark_done(&state, &item.id).await {
        tracing::warn!(item_id = %item.id, error = %e, "queue mark_done failed");
    }
    let topic = format!("chat:{chat_id}");
    state.logbus.publish(
        &topic,
        serde_json::json!({ "queue_dispatched": item.id }).to_string(),
    );

    crate::chats::spawn_dispatch_task(state.clone(), chat_id, chat, prompt, item.body.clone());
    Ok(Json(item))
}

pub async fn cancel(
    State(state): State<AppState>,
    Path((_chat_id, item_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    match cancel_item(&state, &item_id).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err(StatusCode::NOT_FOUND),
        Err(e) => {
            tracing::warn!(item_id, error = %e, "queue cancel failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
