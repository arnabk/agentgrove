# Day 3 — why worktrees

Why worktrees instead of just branches: two agents on the same checkout will happily overwrite each other's changes. With one worktree per task, each agent gets its own directory, so a broken attempt doesn't take down the other one.

Downside: every worktree needs its own dependency install, and a big node_modules adds up on disk. There's a pre-script hook per project for the install, but the disk cost is real.
