# Chat send routing

When the user hits Enter in the chat composer the BE decides — atomically
— whether to dispatch the message to the agent immediately or park it on
the per-chat queue. The FE never makes this decision; that's how we avoid
the entire class of "stale busy state" races we used to ship.

This doc captures the rules + how each one is enforced and tested. Treat
it as the contract for [`POST /api/chats/:id/messages`] (a.k.a. "smart
send") and [`POST /api/chats/:id/queue/next`] (manual drain).

## Rules

| Rule | Trigger                                                    | Action                                                    |
| ---- | ---------------------------------------------------------- | --------------------------------------------------------- |
| 1    | Chat idle + queue empty                                    | Dispatch immediately. Spawn the agent turn.              |
| 2    | Chat busy (a turn or auto-drain is in flight)              | Enqueue. The drain loop will pick it up.                  |
| 3    | Chat idle but queue has pending items                       | Enqueue. Preserves FIFO ordering across the queue.       |
| 4    | Mode = auto                                                 | After each dispatched turn, pop the next pending item.   |
| 5    | Mode = manual                                               | Pending items wait until `POST /queue/next` is called.   |
| 6    | Concurrent rapid-fire on the same chat                      | No message dropped or reordered.                          |

## Implementation

- **Dispatch lock**: `AppState::dispatching: Arc<Mutex<HashSet<ChatId>>>`.
  - `send_message` takes the lock, inspects busy + queue state, and
    either inserts the chat into the set (dispatch path) or enqueues
    (queue path) — all inside the same critical section.
  - `add_prompt` (legacy direct dispatch) takes the same lock so it
    can't race with `send_message`.
  - `run_next` takes the lock too and rejects with 409 if the chat is
    already busy, so a click can't trigger two parallel turns.

- **DispatchGuard**: an RAII wrapper around the spawned dispatch task.
  `Drop` clears the dispatching flag and publishes a `chat_idle` WS hint
  even if any awaited future panics. The happy path also clears the flag
  *synchronously* before the task returns so a follow-up `send_message`
  can dispatch with zero latency — without this we relied solely on
  `Drop`, which schedules the clear on a new task and opens a small
  409-during-cleanup window.

- **Mid-drain queue rollback**: if the auto-drain loop pops an item to
  `Running` but the subsequent `add_prompt` fails (e.g. the chat was
  deleted between pop and prompt insert), `reset_to_pending` rolls the
  popped item back to `Pending` so it isn't orphaned in `Running` with
  no task tracking it.

## Tests

Every rule has at least one regression test. The list below is the
canonical mapping; if you change `send_message` / `add_prompt` /
`spawn_dispatch_task` / `run_next` you must keep these green.

| Rule | BE test (`crates/agentgrove-api/tests/e2e/chat_queue_notes_routes.rs`) | FE Playwright spec (`apps/web/e2e/chat-routing.spec.ts`) |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| 1    | `smart_send_dispatches_when_idle_and_queue_empty`                     | `rule 1: idle + queue empty → dispatch into timeline`    |
| 2    | `smart_send_no_loss_under_concurrent_fire`                            | `rule 2 + 3: rapid-fire 5 → 1 dispatched + 4 queued`     |
| 3    | `smart_send_enqueues_when_queue_has_pending_items`                    | `rule 2 + 3: rapid-fire 5 → 1 dispatched + 4 queued`     |
| 4    | `smart_send_drains_queue_in_order_under_auto_mode`                    | `rule 4: auto mode drains queue back into timeline`      |
| 4    | `queue_auto_drains_pending_items_after_send`                          | —                                                        |
| 5    | `queue_manual_mode_does_not_auto_drain`                               | `rule 5 + bug repro: rapid-fire → flip manual → run_next` |
| 5    | `run_next_rejects_when_already_dispatching`                           | —                                                        |
| 6    | `smart_send_no_loss_under_concurrent_fire`                            | `rule 2 + 3: rapid-fire 5 …`                             |
| 6    | `rapid_fire_10_then_followup_send_runs_immediately`                   | —                                                        |
| —    | `rapid_fire_then_manual_then_run_next_drains_every_item`              | `rule 5 + bug repro: …`                                   |
| —    | `mode_flip_mid_drain_does_not_orphan_running_items`                   | —                                                        |
| —    | `smart_send_publishes_chat_idle_after_dispatch_completes`             | —                                                        |
| —    | `smart_send_unknown_chat_returns_404`                                 | —                                                        |

### Running the regression suite

```sh
# Backend e2e (fast — these run against the real Axum router on an
# ephemeral port, no FE):
just test                   # all crates
cargo test -p agentgrove-api --test e2e

# Frontend Playwright (needs FE + BE running):
just dev                    # starts FE on 5173, BE on 4317
pnpm -C apps/web exec playwright test e2e/chat-routing.spec.ts \
    --project=chromium
```

The Playwright spec talks to the FE's real composer + reads BE state
directly for the queue / chat-view assertions. The BE e2e suite is the
faster source of truth — only run Playwright when you're touching the
composer JSX or the WS event flow.

## Historical bugs

These shipped, broke users, and now have permanent test coverage. If a
test in the table above starts failing, check this list first.

1. **AI message stuck after rapid-fire → manual → run_next.** The
   dispatch task cleared the dispatching flag only via the
   `DispatchGuard::Drop` impl, which itself spawned a fresh task — so
   `run_next` could observe a still-set flag and return 409. Fix: clear
   synchronously in the happy path; keep the guard as panic insurance.
   Regression: `rapid_fire_then_manual_then_run_next_drains_every_item`.

2. **Orphan Running queue items after a chat delete mid-drain.** The
   auto-drain popped an item but couldn't insert the prompt, then
   `break`ed out — leaving the item Running with no task. Fix:
   `reset_to_pending` rollback on the early-exit paths. Regression:
   `mode_flip_mid_drain_does_not_orphan_running_items`.

3. **Concurrent send race.** Two `send_message` calls could both see
   "not dispatching, queue empty" before either committed, then BOTH
   dispatched. Fix: hold the dispatching lock across the entire
   decision + commit. Regression:
   `smart_send_no_loss_under_concurrent_fire`.

[`POST /api/chats/:id/messages`]: ../../crates/agentgrove-api/src/chats.rs
[`POST /api/chats/:id/queue/next`]: ../../crates/agentgrove-api/src/queue.rs
