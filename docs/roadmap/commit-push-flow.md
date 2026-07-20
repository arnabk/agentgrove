# Commit & push flow

> Status: candidate — not yet discussed in detail. Polish track.

## Idea

One-click commit + push per worktree from the UI (claude-squad has
one-key commit+push). Today we only have diff view and per-file
discard.

## Notes

- Button on the worktree row / chat header: stages all, commits with a
  user-entered or AI-suggested message (one cheap one-shot turn), and
  pushes with upstream tracking.
- Natural companion to the issues board: after the review loop
  approves a diff, this is the next click before the PR button.

## Effort

S.
