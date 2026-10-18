-- Per-chat recurring messages. The server's ticker sends `body` into
-- the chat every `interval_secs`, starting at `next_run_at` (unix ms).
-- chat_id is not a hard FK, same as queue_items.
CREATE TABLE chat_schedules (
    id            TEXT    PRIMARY KEY NOT NULL,
    chat_id       TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    interval_secs INTEGER NOT NULL CHECK (interval_secs > 0),
    next_run_at   INTEGER NOT NULL,
    last_run_at   INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_chat_schedules_chat ON chat_schedules (chat_id);
CREATE INDEX idx_chat_schedules_due ON chat_schedules (enabled, next_run_at);
