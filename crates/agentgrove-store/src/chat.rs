//! Chat + prompt repository.
//!
//! Backs the in-memory `ChatRegistry` (in `agentgrove-api`) with a
//! durable SQLite store so chat history survives restarts. The API
//! layer keeps a write-through cache for hot reads; this module is
//! purely about persistence.
//!
//! Wire shapes match the legacy in-memory types so existing serde
//! roundtrips (FE / WS frames / tests) keep working.

use crate::db::DbPool;
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use thiserror::Error;
use uuid::Uuid;

/// A persisted chat row. Events live on individual prompts; this row
/// only carries chat-level metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatRow {
    /// UUID v7 string.
    pub id: String,
    /// Owning project.
    pub project_id: String,
    /// Optional worktree scope. `None` ⇒ project-root scope.
    pub worktree_id: Option<String>,
    /// User-facing title.
    pub title: String,
    /// Agent provider id (e.g. `"claude"`).
    pub provider: String,
    /// Model alias (e.g. `"sonnet"`) or fully-qualified id.
    pub model: String,
    /// Thinking-effort hint (low / medium / high / xhigh / max).
    pub effort: Option<String>,
    /// Provider session id, captured from the first SessionStart event.
    pub session_id: Option<String>,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last-update timestamp.
    pub updated_at: DateTime<Utc>,
}

/// A persisted prompt row + its event log.
///
/// `events` is a JSON array; the API layer maps it to its own
/// `AgentEvent` enum on the way in/out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptRow {
    /// UUID v7 string.
    pub id: String,
    /// Owning chat id.
    pub chat_id: String,
    /// Monotonic sequence within the chat (1-based).
    pub seq: u32,
    /// User-typed prompt text.
    pub content: String,
    /// Event log (token deltas, thinking, tool calls, done, …).
    pub events: JsonValue,
    /// Files the prompt is known to have touched. JSON array of
    /// absolute path strings.
    pub touched_paths: JsonValue,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
}

/// Errors raised by [`ChatRepo`].
#[derive(Debug, Error)]
pub enum ChatError {
    /// Required field was empty / blank.
    #[error("chat title must not be empty")]
    EmptyTitle,
    /// Chat id does not exist.
    #[error("chat not found: {0}")]
    NotFound(String),
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    /// JSON serialisation failure (events / touched_paths).
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Repository for chats + prompts. Cheaply cloneable.
#[derive(Debug, Clone)]
pub struct ChatRepo {
    pool: DbPool,
}

impl ChatRepo {
    /// Construct a new repository backed by `pool`.
    #[must_use]
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Insert a new chat row. The id is generated as a UUID v7 so
    /// rows are naturally ordered by creation time. Returns the
    /// persisted record.
    ///
    /// # Errors
    /// - [`ChatError::EmptyTitle`] when the title is blank after trimming.
    /// - [`ChatError::Db`] for any sqlx failure.
    pub async fn create(
        &self,
        project_id: &str,
        worktree_id: Option<&str>,
        title: &str,
        provider: &str,
        model: &str,
        effort: Option<&str>,
    ) -> Result<ChatRow, ChatError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(ChatError::EmptyTitle);
        }
        let id = Uuid::now_v7().to_string();
        let now_ms = Utc::now().timestamp_millis();
        let now = ts_to_dt(now_ms);
        sqlx::query(
            "INSERT INTO chats (id, project_id, worktree_id, title, provider, model, \
             effort, session_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
        )
        .bind(&id)
        .bind(project_id)
        .bind(worktree_id)
        .bind(title)
        .bind(provider)
        .bind(model)
        .bind(effort)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(ChatRow {
            id,
            project_id: project_id.to_owned(),
            worktree_id: worktree_id.map(str::to_owned),
            title: title.to_owned(),
            provider: provider.to_owned(),
            model: model.to_owned(),
            effort: effort.map(str::to_owned),
            session_id: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Fetch a single chat by id.
    pub async fn get(&self, id: &str) -> Result<ChatRow, ChatError> {
        let row: Option<ChatRowTuple> = sqlx::query_as(
            "SELECT id, project_id, worktree_id, title, provider, model, effort, \
             session_id, created_at, updated_at FROM chats WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_chat)
            .ok_or_else(|| ChatError::NotFound(id.to_owned()))
    }

    /// List all chats for a project (any worktree scope). Ordered by
    /// `created_at ASC, id ASC`.
    pub async fn list_for_project(&self, project_id: &str) -> Result<Vec<ChatRow>, ChatError> {
        let rows: Vec<ChatRowTuple> = sqlx::query_as(
            "SELECT id, project_id, worktree_id, title, provider, model, effort, \
             session_id, created_at, updated_at FROM chats \
             WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC",
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_chat).collect())
    }

    /// List all chats for a specific worktree.
    pub async fn list_for_worktree(&self, worktree_id: &str) -> Result<Vec<ChatRow>, ChatError> {
        let rows: Vec<ChatRowTuple> = sqlx::query_as(
            "SELECT id, project_id, worktree_id, title, provider, model, effort, \
             session_id, created_at, updated_at FROM chats \
             WHERE worktree_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC",
        )
        .bind(worktree_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_chat).collect())
    }

    /// List every chat in the database, oldest first. Used by the
    /// API layer's in-memory cache hydration at startup.
    pub async fn list_all(&self) -> Result<Vec<ChatRow>, ChatError> {
        let rows: Vec<ChatRowTuple> = sqlx::query_as(
            "SELECT id, project_id, worktree_id, title, provider, model, effort, \
             session_id, created_at, updated_at FROM chats \
             WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_chat).collect())
    }

    /// Partial update. Each `Some` field is written; `None` leaves
    /// the existing value alone. Returns the updated row.
    ///
    /// # Errors
    /// - [`ChatError::NotFound`] if no chat matched.
    pub async fn update(
        &self,
        id: &str,
        title: Option<&str>,
        model: Option<&str>,
        effort: Option<Option<&str>>,
        session_id: Option<Option<&str>>,
    ) -> Result<ChatRow, ChatError> {
        // Build a small SET clause by inspecting what changed. The
        // alternative (one query per field) hurts more than it
        // helps here — there are only four fields and the writes
        // are rare.
        let now_ms = Utc::now().timestamp_millis();
        let mut sets: Vec<&'static str> = Vec::new();
        // Local strings keeping borrows alive across the bind loop.
        let t = title.map(str::to_owned);
        let m = model.map(str::to_owned);
        let e = effort.map(|o| o.map(str::to_owned));
        let s = session_id.map(|o| o.map(str::to_owned));
        // Hand-roll the SQL because sqlx::query_builder is a fair
        // amount of dep weight for what is essentially a 1-of-4
        // SET clause.
        if t.is_some() {
            sets.push("title = ?");
        }
        if m.is_some() {
            sets.push("model = ?");
        }
        if e.is_some() {
            sets.push("effort = ?");
        }
        if s.is_some() {
            sets.push("session_id = ?");
        }
        if sets.is_empty() {
            return self.get(id).await;
        }
        sets.push("updated_at = ?");
        let sql = format!("UPDATE chats SET {} WHERE id = ?", sets.join(", "));
        let mut q = sqlx::query(&sql);
        if let Some(v) = &t {
            q = q.bind(v);
        }
        if let Some(v) = &m {
            q = q.bind(v);
        }
        if let Some(v) = &e {
            q = q.bind(v.as_deref());
        }
        if let Some(v) = &s {
            q = q.bind(v.as_deref());
        }
        q = q.bind(now_ms).bind(id);
        let res = q.execute(&self.pool).await?;
        if res.rows_affected() == 0 {
            return Err(ChatError::NotFound(id.to_owned()));
        }
        self.get(id).await
    }

    /// Soft-delete a chat (set deleted_at timestamp).
    /// Returns whether a row was updated.
    pub async fn delete(&self, id: &str) -> Result<bool, ChatError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let res =
            sqlx::query("UPDATE chats SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL")
                .bind(now_ms)
                .bind(id)
                .execute(&self.pool)
                .await?;
        Ok(res.rows_affected() == 1)
    }

    /// List soft-deleted chats, optionally filtered by project_id and
    /// title substring. Most recently deleted first.
    pub async fn list_deleted(
        &self,
        project_id: Option<&str>,
        worktree_id: Option<&str>,
        q: Option<&str>,
    ) -> Result<Vec<ChatRow>, ChatError> {
        let mut sql = String::from(
            "SELECT id, project_id, worktree_id, title, provider, model, effort, session_id, created_at, updated_at \
             FROM chats WHERE deleted_at IS NOT NULL",
        );
        if project_id.is_some() {
            sql.push_str(" AND project_id = ?");
        }
        if worktree_id.is_some() {
            sql.push_str(" AND worktree_id = ?");
        }
        if q.is_some() {
            sql.push_str(" AND title LIKE ?");
        }
        sql.push_str(" ORDER BY deleted_at DESC LIMIT 100");

        let mut query = sqlx::query_as::<_, ChatRowTuple>(&sql);
        if let Some(pid) = project_id {
            query = query.bind(pid);
        }
        if let Some(wid) = worktree_id {
            query = query.bind(wid);
        }
        if let Some(search) = q {
            query = query.bind(format!("%{search}%"));
        }
        let rows: Vec<ChatRowTuple> = query.fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(row_to_chat).collect())
    }

    /// Restore a soft-deleted chat (clear deleted_at).
    pub async fn restore(&self, id: &str) -> Result<Option<ChatRow>, ChatError> {
        let res = sqlx::query(
            "UPDATE chats SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Ok(None);
        }
        self.get(id).await.map(Some)
    }
}

// ---------- Prompts ---------------------------------------------------------

impl ChatRepo {
    /// Insert a new prompt at the next seq for `chat_id`. Returns
    /// the persisted record (with the assigned seq + id).
    ///
    /// # Errors
    /// - [`ChatError::NotFound`] when the chat doesn't exist.
    pub async fn add_prompt(&self, chat_id: &str, content: &str) -> Result<PromptRow, ChatError> {
        // Confirm the chat exists first so we don't insert a
        // dangling prompt (FK would catch this too but the error
        // message is clearer this way).
        let _ = self.get(chat_id).await?;

        // Compute next seq under a brief read.
        let next_seq: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) + 1 FROM prompts WHERE chat_id = ?1")
                .bind(chat_id)
                .fetch_one(&self.pool)
                .await?;

        let id = Uuid::now_v7().to_string();
        let now_ms = Utc::now().timestamp_millis();
        let now = ts_to_dt(now_ms);
        sqlx::query(
            "INSERT INTO prompts (id, chat_id, seq, content, events_json, \
             touched_paths_json, created_at) VALUES (?1, ?2, ?3, ?4, '[]', '[]', ?5)",
        )
        .bind(&id)
        .bind(chat_id)
        .bind(next_seq)
        .bind(content)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        // Touch the parent chat's updated_at so list views can sort
        // by "recently active".
        sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
            .bind(now_ms)
            .bind(chat_id)
            .execute(&self.pool)
            .await?;
        Ok(PromptRow {
            id,
            chat_id: chat_id.to_owned(),
            seq: next_seq as u32,
            content: content.to_owned(),
            events: JsonValue::Array(vec![]),
            touched_paths: JsonValue::Array(vec![]),
            created_at: now,
        })
    }

    /// List prompts for `chat_id` in seq order. Optionally clamp to
    /// `limit` rows starting at `start_seq` (1-based, inclusive).
    /// Pass `None` for both to return the entire history.
    pub async fn list_prompts(
        &self,
        chat_id: &str,
        start_seq: Option<u32>,
        limit: Option<u32>,
    ) -> Result<Vec<PromptRow>, ChatError> {
        let mut sql = String::from(
            "SELECT id, chat_id, seq, content, events_json, touched_paths_json, \
             created_at FROM prompts WHERE chat_id = ?1",
        );
        if start_seq.is_some() {
            sql.push_str(" AND seq >= ?");
        }
        sql.push_str(" ORDER BY seq ASC");
        if limit.is_some() {
            sql.push_str(" LIMIT ?");
        }
        let mut q = sqlx::query_as::<_, PromptRowTuple>(&sql).bind(chat_id);
        if let Some(s) = start_seq {
            q = q.bind(s as i64);
        }
        if let Some(l) = limit {
            q = q.bind(l as i64);
        }
        let rows = q.fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_prompt).collect()
    }

    /// Replace a prompt's `events` array. The caller is responsible
    /// for honouring the per-prompt event cap (the API layer does
    /// this via `ChatRegistry::MAX_EVENTS_PER_PROMPT`).
    pub async fn write_events(&self, prompt_id: &str, events: &JsonValue) -> Result<(), ChatError> {
        let serialized = serde_json::to_string(events)?;
        sqlx::query("UPDATE prompts SET events_json = ?1 WHERE id = ?2")
            .bind(serialized)
            .bind(prompt_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Replace a prompt's `touched_paths` array.
    pub async fn write_touched_paths(
        &self,
        prompt_id: &str,
        paths: &JsonValue,
    ) -> Result<(), ChatError> {
        let serialized = serde_json::to_string(paths)?;
        sqlx::query("UPDATE prompts SET touched_paths_json = ?1 WHERE id = ?2")
            .bind(serialized)
            .bind(prompt_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a prompt by id. Returns whether a row was removed.
    /// Note: prompts are append-only in normal use; this exists for
    /// future revert-purge flows and tests.
    pub async fn delete_prompt(&self, id: &str) -> Result<bool, ChatError> {
        let res = sqlx::query("DELETE FROM prompts WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }
}

// ---------- row plumbing ----------------------------------------------------

#[allow(clippy::type_complexity)]
type ChatRowTuple = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
);

fn row_to_chat(r: ChatRowTuple) -> ChatRow {
    let (
        id,
        project_id,
        worktree_id,
        title,
        provider,
        model,
        effort,
        session_id,
        created_ms,
        updated_ms,
    ) = r;
    ChatRow {
        id,
        project_id,
        worktree_id,
        title,
        provider,
        model,
        effort,
        session_id,
        created_at: ts_to_dt(created_ms),
        updated_at: ts_to_dt(updated_ms),
    }
}

#[allow(clippy::type_complexity)]
type PromptRowTuple = (String, String, i64, String, String, String, i64);

fn row_to_prompt(r: PromptRowTuple) -> Result<PromptRow, ChatError> {
    let (id, chat_id, seq, content, events_json, touched_paths_json, created_ms) = r;
    let events: JsonValue = serde_json::from_str(&events_json)?;
    let touched_paths: JsonValue = serde_json::from_str(&touched_paths_json)?;
    Ok(PromptRow {
        id,
        chat_id,
        seq: seq as u32,
        content,
        events,
        touched_paths,
        created_at: ts_to_dt(created_ms),
    })
}

fn ts_to_dt(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
}
