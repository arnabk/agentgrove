# PR lifecycle (descoped from "native PR flow")

> Status: direction agreed (2026-07); scope cut down after discussion.

## Discussion outcome

The "Create PR" prompt template already covers PR *creation as prose* —
the agent writes a good body from full chat context and runs
`gh pr create`. What's missing is everything *deterministic* around it:

1. **Guaranteed `Closes #N` link.** The
   [issues board](github-issues-board.md) depends on GitHub
   auto-closing issues on merge; an agent that forgets `Closes #123`
   (or writes "Related to") silently breaks the board's state machine.
   This must be backend-injected, not prompt-negotiated.
2. **Checks + merge state in the UI.** The left rail already detects
   PRs and shows merge buttons ("Merging once checks pass") — extend
   that into the board cards and the chat header instead of rebuilding.

## Proposal (slim)

- **Create PR button** on chat/worktree: backend injects `Closes #N`
  from the issue link, generates title/body from recent chat context
  (one cheap one-shot turn) or hands off to the template for prose,
  then runs `gh pr create`. No agent judgment in the critical path.
- **Checks + merge state** surfaced on issue cards and chat headers,
  reusing the existing rail PR detection.
- Keep the prompt template as the power-user path.

## Open question

Descope further to *only* checks/merge polish and leave all creation
to the template? Decided against: the `Closes #N` guarantee alone
justifies the native button.

## Effort

S-M: mostly wiring existing pieces (issue link record, rail PR
detection, one `gh pr create` path).
