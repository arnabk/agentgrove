-- One-time schedules: interval_secs becomes nullable. NULL = send once
-- at next_run_at, then the schedule disables itself. SQLite can't drop
-- a NOT NULL, so the table is rebuilt.
CREATE TABLE chat_schedules_new (
    id            TEXT    PRIMARY KEY NOT NULL,
    chat_id       TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    interval_secs INTEGER CHECK (interval_secs IS NULL OR interval_secs > 0),
    next_run_at   INTEGER NOT NULL,
    last_run_at   INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
) STRICT;
INSERT INTO chat_schedules_new
    SELECT id, chat_id, body, interval_secs, next_run_at, last_run_at,
           enabled, created_at, updated_at
    FROM chat_schedules;
DROP TABLE chat_schedules;
ALTER TABLE chat_schedules_new RENAME TO chat_schedules;
CREATE INDEX idx_chat_schedules_chat ON chat_schedules (chat_id);
CREATE INDEX idx_chat_schedules_due ON chat_schedules (enabled, next_run_at);
