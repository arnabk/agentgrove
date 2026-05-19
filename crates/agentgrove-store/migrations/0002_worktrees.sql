CREATE TABLE worktrees (
    id          TEXT    PRIMARY KEY NOT NULL,
    project_id  TEXT    NOT NULL,
    branch      TEXT    NOT NULL,
    base_ref    TEXT    NOT NULL,
    path        TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL,
    pre_script  TEXT,
    post_script TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_worktrees_project ON worktrees (project_id);
CREATE INDEX idx_worktrees_created_at ON worktrees (created_at);
