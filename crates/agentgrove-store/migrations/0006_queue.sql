-- Per-chat prompt queue + mode toggle.
--
-- The queue was in-memory (`queue::QueueRegistry`) — pending messages
-- vanished on every server restart. This migration moves both the
-- queue items and the auto/manual mode toggle into SQLite so the FE's
-- queue dock reflects the canonical server state across restarts.
--
-- Schema notes:
--   * `position` lets us preserve / reorder FIFO without depending on
--     `created_at` resolution. Lower position = earlier in queue.
--   * `status` is one of: pending | running | done | cancelled.
--     We currently delete items as they move out of the queue (no
--     history), but the column stays because Running is observable
--     while a dispatch is in flight.
--   * `chat_queue_mode` is a separate one-row-per-chat table (rather
--     than a column on `chats`) because queue mode is a queue
--     concern; bundling it with chat metadata invites accidental
--     overrides when chats are renamed or model-switched.

CREATE TABLE queue_items (
    id          TEXT    PRIMARY KEY NOT NULL,
    chat_id     TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    status      TEXT    NOT NULL CHECK (status IN ('pending','running','done','cancelled')),
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
    -- chat_id is not a hard FK because tests enqueue against
    -- chat ids that aren't backed by real project rows. Orphan
    -- cleanup is the API layer's job.
) STRICT;

CREATE INDEX idx_queue_items_chat ON queue_items (chat_id, position);
CREATE INDEX idx_queue_items_status ON queue_items (chat_id, status, position);

CREATE TABLE chat_queue_mode (
    chat_id     TEXT    PRIMARY KEY NOT NULL,
    mode        TEXT    NOT NULL CHECK (mode IN ('auto','manual')),
    updated_at  INTEGER NOT NULL
) STRICT;
