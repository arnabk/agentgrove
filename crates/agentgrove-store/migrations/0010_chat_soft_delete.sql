-- Add soft-delete support for chats. Mirrors the worktree pattern:
-- deleted chats keep their prompts + events intact so they can be
-- restored from the chat history dialog.
ALTER TABLE chats ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_chats_deleted ON chats (deleted_at);
