-- 0011_team_chats.sql
CREATE TABLE IF NOT EXISTS team_chat_messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
