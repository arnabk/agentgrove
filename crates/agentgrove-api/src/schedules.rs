//! Per-chat recurring messages.
//!
//! CRUD routes plus [`spawn_ticker`], one background task that wakes
//! every few seconds and sends due schedules through the normal
//! smart-send path, so a busy chat queues the message instead of
//! running two turns at once.

use crate::chats::{send_message, SendMessageBody};
use crate::state::AppState;
use agentgrove_store::ScheduleRow;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use std::time::Duration;

/// Shortest allowed interval. Below this a slow agent turn would just
/// pile messages onto the queue.
pub const MIN_INTERVAL_SECS: i64 = 10;
/// ponytail: fixed 5s tick, so a schedule fires up to 5s late; switch
/// to a sleep-until-next-due timer if sub-second accuracy matters.
const TICK: Duration = Duration::from_secs(5);

fn topic(chat_id: &str) -> String {
    format!("chat:{chat_id}")
}

fn notify(state: &AppState, chat_id: &str) {
    state.logbus.publish(
        &topic(chat_id),
        serde_json::json!({ "schedules_changed": true }).to_string(),
    );
}

fn db_err(e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::warn!(error = %e, "schedule db error");
    (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}"))
}

fn validate(body: Option<&str>, interval: Option<i64>) -> Result<(), (StatusCode, String)> {
    if body.is_some_and(|b| b.trim().is_empty()) {
        return Err((StatusCode::BAD_REQUEST, "message is empty".into()));
    }
    if interval.is_some_and(|i| i < MIN_INTERVAL_SECS) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("interval must be at least {MIN_INTERVAL_SECS}s"),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub body: String,
    pub interval_secs: i64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    pub body: Option<String>,
    pub interval_secs: Option<i64>,
    pub enabled: Option<bool>,
}

/// `GET /api/chats/:id/schedules`
pub async fn list(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<Json<Vec<ScheduleRow>>, (StatusCode, String)> {
    state
        .schedules
        .list(&chat_id)
        .await
        .map(Json)
        .map_err(db_err)
}

/// `POST /api/chats/:id/schedules`
pub async fn create(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(b): Json<CreateBody>,
) -> Result<Json<ScheduleRow>, (StatusCode, String)> {
    validate(Some(&b.body), Some(b.interval_secs))?;
    if state.chats.read().await.get(&chat_id).is_none() {
        return Err((StatusCode::NOT_FOUND, format!("chat {chat_id} not found")));
    }
    let row = state
        .schedules
        .create(&chat_id, b.body.trim(), b.interval_secs)
        .await
        .map_err(db_err)?;
    notify(&state, &chat_id);
    Ok(Json(row))
}

/// `PATCH /api/chats/:chat_id/schedules/:schedule_id`
pub async fn update(
    State(state): State<AppState>,
    Path((chat_id, id)): Path<(String, String)>,
    Json(b): Json<UpdateBody>,
) -> Result<Json<ScheduleRow>, (StatusCode, String)> {
    validate(b.body.as_deref(), b.interval_secs)?;
    let row = state
        .schedules
        .update(
            &chat_id,
            &id,
            b.body.as_deref().map(str::trim),
            b.interval_secs,
            b.enabled,
        )
        .await
        .map_err(db_err)?
        .ok_or((StatusCode::NOT_FOUND, format!("schedule {id} not found")))?;
    notify(&state, &chat_id);
    Ok(Json(row))
}

/// `DELETE /api/chats/:chat_id/schedules/:schedule_id`
pub async fn delete(
    State(state): State<AppState>,
    Path((chat_id, id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !state
        .schedules
        .delete(&chat_id, &id)
        .await
        .map_err(db_err)?
    {
        return Err((StatusCode::NOT_FOUND, format!("schedule {id} not found")));
    }
    notify(&state, &chat_id);
    Ok(StatusCode::NO_CONTENT)
}

/// Send every schedule due at `now` (unix ms) once. Pub so tests can
/// drive it with a future clock instead of waiting on the timer.
pub async fn fire_due(state: &AppState, now: i64) {
    let due = match state.schedules.due(now).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "schedule due query failed");
            return;
        }
    };
    for s in due {
        // Advance first: a failed send must not re-fire every tick.
        if let Err(e) = state.schedules.mark_ran(&s.id, now).await {
            tracing::warn!(schedule = %s.id, error = %e, "schedule mark_ran failed");
            continue;
        }
        // Last copy still waiting in the queue (chat busy, or queue in
        // manual mode): skip so copies don't pile up every interval.
        let already_queued = crate::queue::read_state(state, &s.chat_id)
            .await
            .items
            .iter()
            .any(|i| i.status == crate::queue::Status::Pending && i.body == s.body);
        if already_queued {
            tracing::info!(schedule = %s.id, "previous run still queued; skipped");
            continue;
        }
        let res = send_message(
            State(state.clone()),
            Path(s.chat_id.clone()),
            Json(SendMessageBody {
                content: s.body.clone(),
            }),
        )
        .await;
        match res {
            Ok(_) => tracing::info!(schedule = %s.id, chat = %s.chat_id, "schedule fired"),
            Err(StatusCode::NOT_FOUND) => {
                // Chat was deleted. Pause rather than delete so it comes
                // back if the chat is restored.
                let _ = state.schedules.disable(&s.id).await;
                tracing::info!(schedule = %s.id, "chat gone; schedule paused");
            }
            Err(code) => tracing::warn!(schedule = %s.id, %code, "schedule send failed"),
        }
        // The new prompt (or queue card) came from the server, not the
        // browser: tell any open view to reload.
        state.logbus.publish(
            &topic(&s.chat_id),
            serde_json::json!({ "schedule_fired": s.id }).to_string(),
        );
    }
}

/// Start the background ticker. Call once at server startup.
pub fn spawn_ticker(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            fire_due(&state, chrono::Utc::now().timestamp_millis()).await;
        }
    });
}
