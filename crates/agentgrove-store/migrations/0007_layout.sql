-- Per-scope UI layout: which chat tab is active, which pane is
-- focused, terminal tabs, open editor file, queue dock visibility.
--
-- Previously these lived in browser localStorage which is hostile to
-- "switch laptops" workflows and lost everything if the user cleared
-- site data. Storing them server-side lets the BE be the single
-- source of truth — the FE still keeps a runtime cache but writes
-- through to this table on every mutation.
--
-- A "scope" is keyed by `(project_id, worktree_id?)`. Worktree-less
-- scopes use `worktree_id = ''` (empty string) rather than NULL so
-- the PRIMARY KEY can be a clean composite without nullable handling
-- in lookups.
--
-- We store the layout as an opaque JSON blob rather than columns
-- because:
--   * The FE owns the shape; the BE just persists what it's told.
--   * Adding new fields (collapsed sections, sort order, etc.) is a
--     FE-only change with zero migration work.

CREATE TABLE layout_scope (
    project_id  TEXT    NOT NULL,
    worktree_id TEXT    NOT NULL DEFAULT '',
    blob_json   TEXT    NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, worktree_id)
) STRICT;

-- Global single-row layout for UI state that isn't scope-bound:
-- rail width, file-tree visibility, theme overrides not covered by
-- settings.json, etc. Keyed on a hard-coded `id = 'singleton'` so
-- there's never more than one row.
CREATE TABLE layout_global (
    id          TEXT    PRIMARY KEY NOT NULL,
    blob_json   TEXT    NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL
) STRICT;
