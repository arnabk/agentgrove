-- AgentGrove schema, version 1.
--
-- Notes:
--   * SQLite has no native UUID; ids are TEXT (UUID v7, time-ordered).
--   * Timestamps are stored as INTEGER (Unix millis) for portable ordering.
--   * Strict mode enforces types per-column.

CREATE TABLE projects (
    id          TEXT    PRIMARY KEY NOT NULL,
    name        TEXT    NOT NULL,
    root        TEXT    NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_projects_created_at ON projects (created_at);
