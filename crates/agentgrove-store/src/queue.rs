//! Per-chat queue persistence.
//!
//! Mirrors the in-memory `queue::QueueRegistry` (in `agentgrove-api`)
//! so pending messages and the auto/manual mode toggle survive a
//! server restart. The API layer takes the canonical decisions
//! (dispatch vs queue, ordering, FIFO under concurrency); this
//! module is purely about storage.
//!
//! See `docs/architecture/chat-queue-routing.md` for the routing
//! rules + the rationale for the `position` column.

use crate::db::DbPool;
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Queue item lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueStatus {
    /// Waiting for dispatch.
    Pending,
    /// Popped + currently being dispatched.
    Running,
    /// Dispatch finished. (We delete rather than preserve `done`
    /// items today; the variant is here for completeness if we ever
    /// surface a history view.)
    Done,
    /// Removed by the user before dispatch.
    Cancelled,
}

impl QueueStatus {
    /// String representation used for DB storage.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "cancelled" => Self::Cancelled,
            _ => Self::Pending,
        }
    }
}

/// Queue auto-drain toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueMode {
    /// BE drains pending items after each turn finishes.
    Auto,
    /// Items wait until the user manually runs them.
    Manual,
}

impl QueueMode {
    /// String representation used for DB storage.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "manual" => Self::Manual,
            _ => Self::Auto,
        }
    }
}

/// A persisted queue item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueItemRow {
    /// UUID v7 string.
    pub id: String,
    /// Owning chat id.
    pub chat_id: String,
    /// Prompt body the BE will dispatch when the item drains.
    pub body: String,
    /// Lifecycle status.
    pub status: QueueStatus,
    /// FIFO position. Lower = drained sooner. Always non-negative.
    pub position: i64,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last-update timestamp.
    pub updated_at: DateTime<Utc>,
}

/// Errors raised by [`QueueRepo`].
#[derive(Debug, Error)]
pub enum QueueError {
    /// Queue item id was not found.
    #[error("queue item not found: {0}")]
    NotFound(String),
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Repository for queue items + per-chat mode. Cheaply cloneable.
#[derive(Debug, Clone)]
pub struct QueueRepo {
    pool: DbPool,
}

impl QueueRepo {
    /// Construct a new repository backed by `pool`.
    #[must_use]
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Append a new pending item at the tail.
    pub async fn enqueue(&self, chat_id: &str, body: &str) -> Result<QueueItemRow, QueueError> {
        let id = Uuid::now_v7().to_string();
        let now_ms = Utc::now().timestamp_millis();
        let now = ts_to_dt(now_ms);
        // Position = max(position) + 1 for this chat. 0 if empty.
        let next_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM queue_items WHERE chat_id = ?1",
        )
        .bind(chat_id)
        .fetch_one(&self.pool)
        .await?;
        sqlx::query(
            "INSERT INTO queue_items (id, chat_id, body, status, position, \
             created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5)",
        )
        .bind(&id)
        .bind(chat_id)
        .bind(body)
        .bind(next_pos)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(QueueItemRow {
            id,
            chat_id: chat_id.to_owned(),
            body: body.to_owned(),
            status: QueueStatus::Pending,
            position: next_pos,
            created_at: now,
            updated_at: now,
        })
    }

    /// Atomically pop the head pending item and mark it Running.
    /// Returns `None` when the queue is empty.
    pub async fn pop_next_pending(
        &self,
        chat_id: &str,
    ) -> Result<Option<QueueItemRow>, QueueError> {
        // Why explicit BEGIN IMMEDIATE: the default `pool.begin()`
        // starts a DEFERRED transaction that takes a read lock
        // first and only escalates to a write lock at the first
        // UPDATE. Under concurrent dispatch (drain loop +
        // smart-send + chat persistence all share the pool) the
        // upgrade can collide with another transaction's write
        // lock and SQLite returns SQLITE_BUSY (5) / BUSY_SNAPSHOT
        // (517) instantly — busy_timeout doesn't help because
        // each transaction holds the only path forward.
        //
        // Pin to one connection so BEGIN/COMMIT land on the same
        // sqlite handle (the pool would otherwise re-dispatch
        // each query).
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let result = async {
            let row: Option<QueueRowTuple> = sqlx::query_as(
                "SELECT id, chat_id, body, status, position, created_at, updated_at \
                 FROM queue_items WHERE chat_id = ?1 AND status = 'pending' \
                 ORDER BY position ASC, created_at ASC LIMIT 1",
            )
            .bind(chat_id)
            .fetch_optional(&mut *conn)
            .await?;
            let Some(tuple) = row else {
                return Ok::<Option<QueueItemRow>, QueueError>(None);
            };
            let id = tuple.0.clone();
            let now_ms = Utc::now().timestamp_millis();
            sqlx::query("UPDATE queue_items SET status = 'running', updated_at = ?1 WHERE id = ?2")
                .bind(now_ms)
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            let mut item = row_to_item(tuple);
            item.status = QueueStatus::Running;
            item.updated_at = ts_to_dt(now_ms);
            Ok(Some(item))
        }
        .await;
        match &result {
            Ok(_) => {
                sqlx::query("COMMIT").execute(&mut *conn).await?;
            }
            Err(_) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            }
        }
        result
    }

    /// Delete a Running item — used by the drain loop after the
    /// dispatch lands as a real prompt in the chat. Returns whether
    /// a row was removed. We don't preserve drained items.
    pub async fn mark_done(&self, item_id: &str) -> Result<bool, QueueError> {
        let res = sqlx::query("DELETE FROM queue_items WHERE id = ?1 AND status = 'running'")
            .bind(item_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Roll a Running item back to Pending. Used when the dispatch
    /// task bails out (chat deleted mid-drain, etc.).
    pub async fn reset_to_pending(&self, item_id: &str) -> Result<bool, QueueError> {
        let now_ms = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "UPDATE queue_items SET status = 'pending', updated_at = ?1 \
             WHERE id = ?2 AND status = 'running'",
        )
        .bind(now_ms)
        .bind(item_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Delete a Pending item — used by the FE's cancel button.
    pub async fn cancel(&self, item_id: &str) -> Result<bool, QueueError> {
        let res = sqlx::query("DELETE FROM queue_items WHERE id = ?1 AND status = 'pending'")
            .bind(item_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }

    /// List queue items for `chat_id`, lowest position first.
    pub async fn list(&self, chat_id: &str) -> Result<Vec<QueueItemRow>, QueueError> {
        let rows: Vec<QueueRowTuple> = sqlx::query_as(
            "SELECT id, chat_id, body, status, position, created_at, updated_at \
             FROM queue_items WHERE chat_id = ?1 \
             ORDER BY position ASC, created_at ASC",
        )
        .bind(chat_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_item).collect())
    }

    /// On startup, reset any Running items to Pending — a previous
    /// server run may have crashed mid-dispatch. Mirrors the
    /// worktree `recover_stale_lifecycle` pattern.
    pub async fn recover_stale_running(&self) -> Result<u64, QueueError> {
        let now_ms = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "UPDATE queue_items SET status = 'pending', updated_at = ?1 \
             WHERE status = 'running'",
        )
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    // -------- queue mode -------------------------------------------------

    /// Read the queue mode for a chat. Defaults to `Auto` when no
    /// row exists yet (the FE flips to manual only when the user
    /// explicitly toggles).
    pub async fn get_mode(&self, chat_id: &str) -> Result<QueueMode, QueueError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT mode FROM chat_queue_mode WHERE chat_id = ?1")
                .bind(chat_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row
            .map(|(m,)| QueueMode::parse(&m))
            .unwrap_or(QueueMode::Auto))
    }

    /// Upsert the queue mode for a chat.
    pub async fn set_mode(&self, chat_id: &str, mode: QueueMode) -> Result<(), QueueError> {
        let now_ms = Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO chat_queue_mode (chat_id, mode, updated_at) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT (chat_id) DO UPDATE SET mode = excluded.mode, \
             updated_at = excluded.updated_at",
        )
        .bind(chat_id)
        .bind(mode.as_str())
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[allow(clippy::type_complexity)]
type QueueRowTuple = (String, String, String, String, i64, i64, i64);

fn row_to_item(r: QueueRowTuple) -> QueueItemRow {
    let (id, chat_id, body, status, position, created_ms, updated_ms) = r;
    QueueItemRow {
        id,
        chat_id,
        body,
        status: QueueStatus::parse(&status),
        position,
        created_at: ts_to_dt(created_ms),
        updated_at: ts_to_dt(updated_ms),
    }
}

fn ts_to_dt(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
}
