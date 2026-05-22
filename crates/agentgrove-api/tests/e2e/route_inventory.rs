//! Enforce inventory/coverage parity between router and coverage.txt.

use std::collections::BTreeSet;

fn expected_routes() -> BTreeSet<&'static str> {
    [
        "GET /health",
        "GET /ws",
        "GET /api/projects",
        "POST /api/projects",
        "GET /api/projects/{id}",
        "PATCH /api/projects/{id}",
        "DELETE /api/projects/{id}",
        "GET /api/projects/{id}/worktrees",
        "POST /api/projects/{id}/worktrees",
        "DELETE /api/projects/{project_id}/worktrees/{worktree_id}",
        "PATCH /api/projects/{project_id}/worktrees/{worktree_id}",
        "GET /api/worktrees/history",
        "POST /api/worktrees/{id}/restore",
        "GET /api/worktrees/{id}/chats",
        "POST /api/worktrees/{id}/chats",
        "GET /api/projects/{id}/chats",
        "POST /api/projects/{id}/chats",
        "GET /api/projects/{id}/branches",
        "POST /api/projects/{id}/branch",
        "GET /api/chats/{id}",
        "PATCH /api/chats/{id}",
        "GET /api/chats/{id}/prompts",
        "POST /api/chats/{id}/prompts",
        "POST /api/chats/{id}/messages",
        "POST /api/chats/{chat_id}/prompts/{prompt_id}/revert",
        "GET /api/chats/{id}/queue",
        "POST /api/chats/{id}/queue",
        "POST /api/chats/{id}/queue/mode",
        "POST /api/chats/{id}/queue/next",
        "DELETE /api/chats/{chat_id}/queue/{item_id}",
        "GET /api/chats/{id}/notes",
        "POST /api/chats/{id}/notes",
        "DELETE /api/chats/{chat_id}/notes/{note_id}",
        "GET /api/projects/{id}/notes",
        "POST /api/projects/{id}/notes",
        "DELETE /api/projects/{project_id}/notes/{note_id}",
        "GET /api/projects/{id}/scratchpad",
        "PUT /api/projects/{id}/scratchpad",
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/layout",
        "PUT /api/layout/global",
        "PUT /api/layout/scope",
        "GET /api/terminals",
        "POST /api/terminals",
        "DELETE /api/terminals/{id}",
        "POST /api/terminals/{id}/write",
        "POST /api/terminals/{id}/resize",
        "GET /api/terminals/{id}/history",
        "GET /api/terminals/{id}/status",
        "GET /api/fs/home",
        "GET /api/fs/browse",
        "GET /api/editor/file",
        "POST /api/editor/file",
        "GET /api/editor/diff",
        "GET /api/editor/tree",
        "GET /api/git/status",
        "POST /api/git/discard",
        "GET /api/diag/memory",
        "GET /api/themes",
        "POST /api/themes",
        "GET /api/providers",
        "GET /api/providers/{id}/commands",
        "POST /api/uploads",
        "GET /api/uploads/{id}/raw",
    ]
    .into_iter()
    .collect()
}

#[test]
fn coverage_file_matches_expected_routes() {
    let coverage = include_str!("coverage.txt");
    let actual: BTreeSet<&str> = coverage
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    assert_eq!(actual, expected_routes());
}
