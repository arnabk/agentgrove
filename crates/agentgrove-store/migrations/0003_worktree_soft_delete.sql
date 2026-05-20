-- Soft-delete support for worktrees.
--
-- Removing a worktree from the AgentGrove view does NOT erase the row;
-- it sets `removed_at` to the current Unix-millis timestamp. The history
-- view surfaces these rows and offers a "restore" action.
--
-- All existing queries that listed worktrees filter on `removed_at IS NULL`
-- to keep showing only live entries.

ALTER TABLE worktrees ADD COLUMN removed_at INTEGER;
CREATE INDEX idx_worktrees_removed_at ON worktrees (removed_at);
