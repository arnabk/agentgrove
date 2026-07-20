# Composer @-file mentions

> Status: approved for roadmap (2026-07). Polish track.

## Problem

Referencing files in a prompt today means drag-dropping, pasting, or
typing a path from memory. The fast path every other tool has (Cursor,
Copilot Chat, Slack) is typing `@` and picking the file from a popup.

## Proposal

Type `@` in the chat composer → autocomplete popup powered by the
existing per-project file index (the same nucleo-matcher index behind
Cmd+P, sub-10ms over 100k files). Selecting a file inserts a mention
chip; on send, the prompt includes the file's absolute path (current
attach behavior) — or, for small files, an inline content excerpt.

## UX

- `@` opens the popup at the caret; typing filters live; arrows +
  Enter to select, Esc to dismiss.
- Chip renders as a compact token (`src/auth.ts ×`) so the prompt text
  stays readable; deleting the chip removes the attachment.
- Multi-select: keep adding chips; popup stays open until Esc or a
  non-matching character.

## Mechanics

- Tiptap mention/suggestion extension in the composer.
- Backend: reuse the file-index search endpoint (add a lightweight
  `?q=` query variant if the Cmd+P endpoint is too heavy for
  per-keystroke calls).
- On send, chips map to the same attachment structure drag-drop
  already produces — no changes to the dispatch path.

## Effort

S: one Tiptap extension + popup UI + mapping to existing attachments.

## Open questions

1. Chip with path only (current attach semantics) vs optional "inline
   content" for small files? (leaning: path only, v1)
2. Should `@` also surface symbols (functions) later via the index?
   (defer)
