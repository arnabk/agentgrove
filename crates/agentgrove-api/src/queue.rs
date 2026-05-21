//! Prompt queue. Per-chat ordered queue with auto/manual modes.

use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Running,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueItem {
    pub id: String,
    pub chat_id: String,
    pub body: String,
    pub status: Status,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueState {
    pub chat_id: String,
    pub mode: Mode,
    pub items: Vec<QueueItem>,
}

#[derive(Default, Debug)]
pub struct QueueRegistry {
    by_chat: HashMap<String, QueueState>,
}

impl QueueRegistry {
    fn ensure(&mut self, chat_id: &str) -> &mut QueueState {
        self.by_chat
            .entry(chat_id.to_owned())
            .or_insert_with(|| QueueState {
                chat_id: chat_id.to_owned(),
                mode: Mode::Auto,
                items: vec![],
            })
    }

    pub fn enqueue(&mut self, chat_id: &str, body: String) -> QueueItem {
        let q = self.ensure(chat_id);
        let item = QueueItem {
            id: Uuid::now_v7().to_string(),
            chat_id: chat_id.to_owned(),
            body,
            status: Status::Pending,
            created_at: Utc::now(),
        };
        q.items.push(item.clone());
        item
    }

    pub fn set_mode(&mut self, chat_id: &str, mode: Mode) {
        self.ensure(chat_id).mode = mode;
    }

    pub fn cancel(&mut self, chat_id: &str, item_id: &str) -> bool {
        let q = self.ensure(chat_id);
        if let Some(it) = q.items.iter_mut().find(|i| i.id == item_id) {
            if it.status == Status::Pending {
                it.status = Status::Cancelled;
                return true;
            }
        }
        false
    }

    /// Move the head pending item to `Running` and return a clone.
    /// The caller is responsible for calling [`mark_done`] (success)
    /// or [`mark_cancelled`] (failure) once dispatch finishes; without
    /// that, the item stays Running on subsequent GETs so the UI can
    /// reflect the live state.
    pub fn pop_next_pending(&mut self, chat_id: &str) -> Option<QueueItem> {
        let q = self.ensure(chat_id);
        for it in q.items.iter_mut() {
            if it.status == Status::Pending {
                it.status = Status::Running;
                return Some(it.clone());
            }
        }
        None
    }

    /// Drop a previously-running item from the queue. We don't
    /// preserve history — once an item has been dispatched into the
    /// chat timeline (where it lives as a regular prompt) keeping a
    /// `done` copy in the queue just clutters the dock and confuses
    /// users into thinking the message is still pending elsewhere.
    /// Returns whether a row was removed.
    pub fn mark_done(&mut self, chat_id: &str, item_id: &str) -> bool {
        let q = self.ensure(chat_id);
        let before = q.items.len();
        q.items.retain(|i| !(i.id == item_id && i.status == Status::Running));
        q.items.len() != before
    }

    /// Roll a Running item back to Pending. Used when the dispatch
    /// task bails out mid-drain (e.g. the chat was deleted between
    /// pop and add_prompt). Without this, the popped item would be
    /// stranded as Running with no task tracking it.
    pub fn reset_to_pending(&mut self, chat_id: &str, item_id: &str) -> bool {
        let q = self.ensure(chat_id);
        if let Some(it) = q.items.iter_mut().find(|i| i.id == item_id) {
            if it.status == Status::Running {
                it.status = Status::Pending;
                return true;
            }
        }
        false
    }

    /// True if the chat's queue is set to auto-drain mode.
    pub fn is_auto(&self, chat_id: &str) -> bool {
        self.by_chat
            .get(chat_id)
            .map(|q| q.mode == Mode::Auto)
            .unwrap_or(true)
    }

    pub fn state(&self, chat_id: &str) -> QueueState {
        self.by_chat.get(chat_id).cloned().unwrap_or(QueueState {
            chat_id: chat_id.to_owned(),
            mode: Mode::Auto,
            items: vec![],
        })
    }
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
    Json(state.queues.read().await.state(&chat_id))
}

pub async fn enqueue(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<EnqueueBody>,
) -> Json<QueueItem> {
    Json(state.queues.write().await.enqueue(&chat_id, body.body))
}

pub async fn set_mode(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<ModeBody>,
) -> StatusCode {
    state.queues.write().await.set_mode(&chat_id, body.mode);
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
    let item = state
        .queues
        .write()
        .await
        .pop_next_pending(&chat_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    // Insert the dispatching flag + record the prompt under the
    // same lock so a concurrent `send_message` sees us as busy and
    // routes its message to the queue (the correct FIFO behaviour).
    let (prompt, chat) = {
        let mut reg = state.chats.write().await;
        let chat = match reg.get(&chat_id) {
            Some(c) => c.clone(),
            None => return Err(StatusCode::NOT_FOUND),
        };
        let Some(p) = reg.add_prompt(&chat_id, item.body.clone()) else {
            return Err(StatusCode::NOT_FOUND);
        };
        (p, chat)
    };
    dispatching.insert(chat_id.clone());
    drop(dispatching);

    // Mark the queue item done (i.e. remove it) up front — it's
    // already been turned into a real prompt and will live on in
    // the timeline. The spawned task handles streaming + any
    // follow-up auto-drain.
    state
        .queues
        .write()
        .await
        .mark_done(&chat_id, &item.id);
    let topic = format!("chat:{chat_id}");
    state.logbus.publish(
        &topic,
        serde_json::json!({ "queue_dispatched": item.id }).to_string(),
    );

    crate::chats::spawn_dispatch_task(
        state.clone(),
        chat_id,
        chat,
        prompt,
        item.body.clone(),
    );
    Ok(Json(item))
}

pub async fn cancel(
    State(state): State<AppState>,
    Path((chat_id, item_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    if state.queues.write().await.cancel(&chat_id, &item_id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
