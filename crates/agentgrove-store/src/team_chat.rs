//! Team chat module

/// A team chat message.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TeamChatMessage {
    /// ID
    pub id: String,
    /// Sender name
    pub sender: String,
    /// Message body
    pub body: String,
    /// Creation timestamp
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl TeamChatMessage {
    /// Insert a new team chat message.
    pub async fn insert(
        pool: &sqlx::SqlitePool,
        id: &str,
        sender: &str,
        body: &str,
    ) -> Result<Self, sqlx::Error> {
        let msg = sqlx::query_as!(
            Self,
            r#"
            INSERT INTO team_chat_messages (id, sender, body)
            VALUES (?, ?, ?)
            RETURNING id as "id!", sender as "sender!", body as "body!", created_at as "created_at!: chrono::DateTime<chrono::Utc>"
            "#,
            id,
            sender,
            body
        )
        .fetch_one(pool)
        .await?;
        Ok(msg)
    }

    /// List all team chat messages.
    pub async fn list(pool: &sqlx::SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        let msgs = sqlx::query_as!(
            Self,
            r#"
            SELECT id as "id!", sender as "sender!", body as "body!", created_at as "created_at!: chrono::DateTime<chrono::Utc>"
            FROM team_chat_messages
            ORDER BY created_at ASC
            "#
        )
        .fetch_all(pool)
        .await?;
        Ok(msgs)
    }
}
