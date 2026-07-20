# MCP server mode

> Status: candidate — not yet discussed in detail. Platform track.

## Idea

Expose AgentGrove itself as an MCP server: chats, queue, worktrees,
issues board as MCP tools so other agents (or Claude Code running
elsewhere) can drive it programmatically (Superset does this).

## Notes

- Turns AgentGrove from a UI into a platform: "spawn a chat on this
  branch with this prompt" becomes a tool call.
- JSON-RPC over stdio (for local CLI clients) and/or HTTP.

## Effort

M.
