-- Persistent chats + prompts (event log inline as JSON).
--
-- Until now chats lived in-memory (`ChatRegistry`) and were lost on
-- every server restart, breaking the user's session continuity.
-- This migration moves them to SQLite so a kill / upgrade / crash
-- can no longer wipe the conversation history.
--
-- Design notes (see ADR-0007 once filed):
--
--   * `events` is stored as a single JSON array per prompt rather than
--     a separate `prompt_events` table. Reasoning:
--       - A prompt's events are append-only and only ever read as the
--         full sequence (the windowed view trims by count, not by
--         filter).
--       - SQLite handles ~1 MB TEXT columns fine; we cap event count
--         per prompt at 4096 in `chats::ChatRegistry::MAX_EVENTS_PER_PROMPT`
--         so a runaway agent can't blow the column.
--       - Reading prompts then becomes a single row fetch vs N+M joins.
--     If we later need event-level analytics we can shadow-write into
--     a normalised events table without touching the API surface.
--
--   * `touched_paths` is also JSON for the same reasons (tiny, only
--     read as a full set when computing revert plans).
--
--   * `session_id` + `effort` are nullable; they're set after the
--     first turn returns a session id (and when the user picks an
--     effort level via the per-chat settings dialog).
--
--   * Foreign keys ON DELETE CASCADE: when a project goes away its
--     chats and their prompts vanish too. The FE always deletes
--     projects via the API which already nukes worktrees; chats join
--     that same cleanup path.

CREATE TABLE chats (
    id           TEXT    PRIMARY KEY NOT NULL,
    project_id   TEXT    NOT NULL,
    worktree_id  TEXT,
    title        TEXT    NOT NULL,
    provider     TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    effort       TEXT,
    session_id   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
    -- Deliberately no FK on project_id: the legacy worktree-scoped
    -- chat routes (used by older clients + several tests) allow
    -- creating a chat under an arbitrary worktree id without a
    -- corresponding project row. Enforcing the FK here would break
    -- those flows. Cleanup of orphan chats when a project is
    -- deleted is handled in the API layer via persist_chat_delete
    -- on the project teardown path (TODO once the API surfaces
    -- project deletes through that helper).
) STRICT;

CREATE INDEX idx_chats_project ON chats (project_id, created_at);
CREATE INDEX idx_chats_worktree ON chats (worktree_id);

CREATE TABLE prompts (
    id             TEXT    PRIMARY KEY NOT NULL,
    chat_id        TEXT    NOT NULL,
    seq            INTEGER NOT NULL,
    content        TEXT    NOT NULL,
    -- JSON array of AgentEvent (see crates/agentgrove-agents).
    -- Append-only; capped at 4096 real events + an optional leading
    -- Truncated{dropped} sentinel.
    events_json    TEXT    NOT NULL DEFAULT '[]',
    -- JSON array of strings (absolute paths the prompt touched).
    touched_paths_json TEXT NOT NULL DEFAULT '[]',
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    -- A chat's prompts must have a stable monotonic seq starting at 1.
    UNIQUE (chat_id, seq)
) STRICT;

CREATE INDEX idx_prompts_chat ON prompts (chat_id, seq);
