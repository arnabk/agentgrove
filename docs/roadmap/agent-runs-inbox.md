# Agent runs inbox & visual job manager

> Status: approved direction (2026-07) — **reframes the deferred
> "scheduled automations" item.** Delight track.

## Why not a native scheduler

Scheduling is where Claude Code, Kimi, and opencode are all racing
(scheduled tasks, background agents, GitHub Action integrations), and
`crontab + claude -p "…"` already works today. Building our own cron
runner would compete with our own providers — against the
"orchestrate, don't replicate" philosophy. **Dropped: native cron,
job creation UI.** For team-grade automation the honest answer is
GitHub Actions with the CLI; we'll ship a recipe doc instead.

## The gap we *do* own: visibility

A cron-run agent writes to a log file nobody reads. The real need is
"where did last night's run go and what did it do?" — answered in a
nice visual way, without us running anything.

## Proposal

### Runs inbox

Watch the CLI providers' own session stores
(`~/.claude/projects`, `~/.kimi/sessions`, opencode's session dir) and
show a unified, chronological inbox of recent runs:

- Provider, cwd (matched to an AgentGrove project when possible),
  start time, status (running / done / error), last-message preview.
- Distinguish AgentGrove chats from external runs (cron, user-launched
  terminals, other tools).
- One click opens the transcript read-only — or imports it as a chat
  (attach/resume where the provider supports it).

### Jobs view (visual crontab manager)

Parse the user's crontab, detect entries that invoke agent CLIs
(`claude`, `kimi`, `opencode`, …) and present them visually:

- Human-readable schedule, command, last run + outcome, next run.
- Enable/disable a job by commenting/uncommenting the crontab line —
  management, not ownership.
- Links from a job to its runs in the inbox.

### Non-goals

- No AgentGrove-native scheduler, no "new job" wizard (recipe doc
  instead), no replacement for GitHub Actions.

## Effort

M: session-dir watchers + inbox UI (main item); S-M: crontab parsing
+ jobs view (follow-up).

## Open questions

1. Inbox entries: read-only transcript vs import-as-resumable-chat by
   default?
2. Match runs to projects by cwd only, or also by session metadata?
3. Crontab toggle: plain comment/uncomment, or move entries into a
   managed block (`# agentgrove: begin/end`) we can safely edit?
