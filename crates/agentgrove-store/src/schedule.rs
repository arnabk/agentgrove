//! Per-chat recurring messages ("send this every N seconds").
//!
//! Storage only. The API layer's ticker decides when a schedule fires
//! and routes the message through the normal smart-send path.

use crate::db::DbPool;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A persisted schedule. Timestamps are unix milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct ScheduleRow {
    /// UUID v7.
    pub id: String,
    /// Chat the message is sent into.
    pub chat_id: String,
    /// Message text.
    pub body: String,
    /// Seconds between sends.
    pub interval_secs: i64,
    /// Next send time.
    pub next_run_at: i64,
    /// Last send time, if it has fired.
    pub last_run_at: Option<i64>,
    /// Paused when false.
    pub enabled: bool,
    /// Creation time.
    pub created_at: i64,
    /// Last edit time.
    pub updated_at: i64,
}

const COLS: &str = "id, chat_id, body, interval_secs, next_run_at, last_run_at, \
                    enabled, created_at, updated_at";

/// Repository for chat schedules. Cheaply cloneable.
#[derive(Debug, Clone)]
pub struct ScheduleRepo {
    pool: DbPool,
}

impl ScheduleRepo {
    /// Construct a repository backed by `pool`.
    #[must_use]
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Create an enabled schedule whose first run is one interval from now.
    pub async fn create(
        &self,
        chat_id: &str,
        body: &str,
        interval_secs: i64,
    ) -> Result<ScheduleRow, sqlx::Error> {
        let now = Utc::now().timestamp_millis();
        let id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO chat_schedules (id, chat_id, body, interval_secs, next_run_at, \
             enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        )
        .bind(&id)
        .bind(chat_id)
        .bind(body)
        .bind(interval_secs)
        .bind(now + interval_secs * 1000)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get(&id).await?.ok_or_else(|| sqlx::Error::RowNotFound)
    }

    /// Fetch one schedule by id.
    pub async fn get(&self, id: &str) -> Result<Option<ScheduleRow>, sqlx::Error> {
        sqlx::query_as(&format!("SELECT {COLS} FROM chat_schedules WHERE id = ?1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await
    }

    /// All schedules for a chat, oldest first.
    pub async fn list(&self, chat_id: &str) -> Result<Vec<ScheduleRow>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {COLS} FROM chat_schedules WHERE chat_id = ?1 ORDER BY created_at"
        ))
        .bind(chat_id)
        .fetch_all(&self.pool)
        .await
    }

    /// Enabled schedules whose `next_run_at` has passed.
    pub async fn due(&self, now_ms: i64) -> Result<Vec<ScheduleRow>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {COLS} FROM chat_schedules WHERE enabled = 1 AND next_run_at <= ?1 \
             ORDER BY next_run_at"
        ))
        .bind(now_ms)
        .fetch_all(&self.pool)
        .await
    }

    /// Record a fire. The next run stays on the original cadence (a late
    /// tick doesn't push every later run back). If that slot has already
    /// passed too (server was down), restart from now, so a missed run
    /// fires once, not once per missed interval.
    pub async fn mark_ran(&self, id: &str, now_ms: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE chat_schedules SET last_run_at = ?2, updated_at = ?2, \
             next_run_at = CASE WHEN next_run_at + interval_secs * 1000 > ?2 \
                 THEN next_run_at + interval_secs * 1000 \
                 ELSE ?2 + interval_secs * 1000 END \
             WHERE id = ?1",
        )
        .bind(id)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Patch body / interval / enabled. Changing the interval or
    /// re-enabling restarts the countdown from now. Returns the updated
    /// row, or `None` if it doesn't belong to `chat_id`.
    pub async fn update(
        &self,
        chat_id: &str,
        id: &str,
        body: Option<&str>,
        interval_secs: Option<i64>,
        enabled: Option<bool>,
    ) -> Result<Option<ScheduleRow>, sqlx::Error> {
        let Some(cur) = self.get(id).await?.filter(|r| r.chat_id == chat_id) else {
            return Ok(None);
        };
        let now = Utc::now().timestamp_millis();
        let interval = interval_secs.unwrap_or(cur.interval_secs);
        let enabled_now = enabled.unwrap_or(cur.enabled);
        let restart = interval != cur.interval_secs || (enabled_now && !cur.enabled);
        let next = if restart {
            now + interval * 1000
        } else {
            cur.next_run_at
        };
        sqlx::query(
            "UPDATE chat_schedules SET body = ?2, interval_secs = ?3, enabled = ?4, \
             next_run_at = ?5, updated_at = ?6 WHERE id = ?1",
        )
        .bind(id)
        .bind(body.unwrap_or(&cur.body))
        .bind(interval)
        .bind(enabled_now)
        .bind(next)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get(id).await
    }

    /// Returns whether a row was removed.
    pub async fn delete(&self, chat_id: &str, id: &str) -> Result<bool, sqlx::Error> {
        let res = sqlx::query("DELETE FROM chat_schedules WHERE id = ?1 AND chat_id = ?2")
            .bind(id)
            .bind(chat_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Pause a schedule without the chat-ownership check (ticker use:
    /// the chat it belongs to is gone).
    pub async fn disable(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE chat_schedules SET enabled = 0, updated_at = ?2 WHERE id = ?1")
            .bind(id)
            .bind(Utc::now().timestamp_millis())
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
