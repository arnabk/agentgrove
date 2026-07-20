# Generic "any CLI" provider

> Status: candidate — not yet discussed in detail. Platform track.

## Idea

A user-defined provider: launch template (binary + args) with a
plain-text passthrough stream, so Codex / Gemini / Aider / future CLI
users plug in without us writing an adapter (claude-squad "profiles",
Superset "works with any CLI agent").

## Notes

- The `AgentProvider` trait already abstracts providers; this is one
  more impl with `Token`-only events (no structured tool events for
  unknown CLIs).
- Provider descriptor could come from settings UI (name, binary, arg
  template, optional resume flag).

## Effort

S-M.
