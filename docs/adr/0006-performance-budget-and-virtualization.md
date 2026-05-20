# ADR-0006: Performance budget and virtualization strategy

- Status: Accepted
- Date: 2026-05-20

## Context

AgentGrove is a local-first developer workspace that lives in the
user's browser tab next to their editor, terminals, and chat session
with an AI agent. Three observations drive this ADR:

1. **Long chat sessions are normal.** A single agentic coding session
   can produce thousands of messages: every token delta from the model,
   every tool call (Read, Edit, Bash, Glob...) and every tool result
   counts as an event. A naive implementation that keeps the whole
   conversation in DOM crashes the tab around the 5–10k node mark.
2. **Tabs are not the only consumer.** The same process hosts the
   editor (CodeMirror), terminals (xterm.js), diff (CodeMirror
   MergeView), and a multi-project rail. Every MB the chat hoards is a
   MB the rest of the app can't use.
3. **AgentGrove is meant to run alongside the user's existing
   environment** — VS Code, browsers, ffmpeg, Docker. We do not get to
   own all available memory.

## Decision

We adopt a **strict resource budget** for the AgentGrove tab and a
**virtualization-by-default** policy across every potentially-large
list and stream.

### Hard tab-memory budget

The whole-tab memory reported by
`performance.measureUserAgentSpecificMemory()` must stay under:

| Working set                                  | Budget |
| -------------------------------------------- | ------ |
| Idle (no chat open, projects loaded)         | 80 MB  |
| 1 project + 5 worktrees + editor + terminals | 150 MB |
| 1 open chat with 10,000 events               | 200 MB |
| 10 open chats × 1,000 events each            | 250 MB |

The MemoryIndicator already surfaces this number to the user; CI will
later add a Playwright probe that fails if a synthetic 10k-event chat
takes the tab past 200 MB.

### Virtualization is the default

Any list that **can in principle grow without bound** is rendered
through a windowed virtualizer. Concretely, that includes:

- Chat prompt timeline (this ADR's primary motivator).
- Per-prompt event log (token + tool-call + tool-result stream).
- File tree under a project / worktree (handled by lazy expansion;
  large flat directories still need to virtualize).
- Worktree history dialog.
- Terminals' xterm scrollback (already handled by xterm.js).
- Editor (already handled by CodeMirror).

The new bits we own (chat timeline and event log) use a tiny
in-house Solid virtualizer plus the absolute-position-windowing
pattern: keep an internal `Map<id, dom-node>` of nodes currently in
the viewport plus a small overscan, recycle DOM nodes when items
scroll off.

### Pagination on every list endpoint

Every BE list route accepts `?limit=N&before=<cursor>` (or
`&after=`) parameters and returns at most 100 items per page.
Today's offenders we'll fix as part of this ADR:

| Endpoint                                         | Cap policy                                          |
| ------------------------------------------------ | --------------------------------------------------- |
| `GET /api/chats/:id`                             | Returns the last 50 prompts + their last 200 events. Full prompt body fetched lazily via `GET /api/chats/:id/prompts/:pid`. |
| `GET /api/chats/:id/prompts?before=&limit=`      | Backfill earlier prompts as user scrolls up.        |
| `GET /api/chats/:id/prompts/:pid?events_after=&limit=` | Page deeper into one prompt's event log.      |
| `GET /api/projects/:id/chats`                    | Limit 200, oldest dropped.                          |
| `GET /api/worktrees/history`                     | Limit 200; client may filter further with `q=`.     |
| `GET /api/terminals`                             | Already small, no pagination.                       |

### Bounded server-side state

The in-memory chat registry stores **at most N events per prompt**
(currently `N = 4096`) so a runaway tool spam can't blow up server
RSS either. Older events spill to a per-prompt sqlite table when we
add persistence (M3). Until then, exceeding the cap drops the
oldest events with an inserted `Truncated { dropped: count }`
sentinel.

### Token coalescing

Provider streams emit one event per text-delta — sometimes one event
per **character**. We coalesce those server-side before publishing
on the LogBus topic: deltas accumulate in a per-prompt buffer and
flush when either:

- 64 bytes of token text have accumulated, or
- 50 ms have passed since the last flush, or
- a non-token event arrives (tool call, done, error).

This reduces both the per-message LogBus + WS framing overhead and
the FE re-render frequency by 10–50×.

### FE-side caps

- Chat timeline holds at most **2,000 prompts in memory** even if the
  BE returns more on backfill; the virtualizer evicts oldest from
  its store when the cap is hit.
- Per-prompt event log holds at most **5,000 events** in memory.
  Older events are summarized as "N earlier events" and re-fetched
  on demand.
- WebSocket frames are processed via `requestIdleCallback` batches
  during quiet user input to avoid jank.
- `<For>` lists are always keyed by stable id (Solid then reuses
  DOM nodes across updates).

## Consequences

- **More plumbing for every list endpoint.** Every BE list handler
  gains pagination; every FE list view gains a windowed renderer.
  Worth it.
- **The chat protocol becomes layered.** Initial fetch is light:
  metadata + last 50 prompts each with their last few events.
  Detail is fetched on demand. The WS stream is for *new* events
  only, not for replaying history.
- **Throughput, not latency, is the metric.** Token coalescing adds
  up to 50 ms of latency to the very first visible token, but it
  cuts the steady-state rendering cost dramatically. The first
  token is still rendered immediately (the buffer flushes the
  moment any meaningful payload accumulates).
- **CI cost.** A memory-budget Playwright probe materially adds to
  CI run time (~30 s). Worth the regression protection.

## Migration plan

1. Land bounded BE state + token coalescing (this ADR + follow-up
   PR).
2. Add `?before=` pagination to chat reads. Existing `GET
   /api/chats/:id` returns its windowed shape immediately; old
   clients get last 50 prompts as if nothing happened.
3. Convert ChatPane to a virtualized timeline. The current
   non-virtualized timeline becomes a fallback for short chats
   (≤30 prompts) where virtualization overhead isn't worth it.
4. Add the Playwright memory probe to CI behind a `--budget` flag
   so unrelated regressions don't break the build before the probe
   is stable.

## Non-goals

- We do not attempt to push memory below browser baselines (Chromium's
  per-tab overhead is ~30–40 MB regardless of what we render).
- We do not pre-fetch off-screen prompts; backfill is on-demand and
  user-initiated by scrolling.
- We do not store full chat history in localStorage; persistence is
  the BE's job.
