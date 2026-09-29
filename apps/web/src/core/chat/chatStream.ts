import type { AgentEvent, ChatView, Prompt } from "@/core/api/client";
import { api } from "@/core/api/client";

/**
 * The chat stream protocol: the shape a chat timeline is held in, and
 * how a `/ws?topic=chat:{id}` frame is folded into it.
 *
 * This lives in `core` rather than next to a pane because both shells
 * consume the same stream. Keeping one copy means the desktop and mobile
 * timelines cannot drift on token coalescing, the `Truncated` sentinel,
 * or auto-retry handling — all of which are subtle and were tuned
 * against real provider output (see ADR-0006).
 *
 * Everything here is pure except `chatWsUrl`, which reads the API base.
 */

/** Hard cap on prompts held in the FE store per chat (ADR-0006).
 *  DOM is virtualized, so this only bounds the *data* the Solid store
 *  retains (each prompt carries an events array that Solid wraps in a
 *  reactive proxy). 600 keeps a windowed chat fully scrollable while
 *  bounding worst-case retention well below what 2000 × 200 events
 *  (≈400K proxied objects) cost before. */
export const MAX_PROMPTS_IN_VIEW = 600;

/** Hard cap on events kept per prompt in the FE store. Mirrors the
 *  BE's bounded per-prompt buffer (`Truncated { dropped }` sentinel):
 *  while a turn streams, every tool / done / error event is pushed
 *  here with no bound, so a long agent run could balloon a single
 *  prompt to thousands of proxied events. Dropping the oldest real
 *  event (never token/thinking — those live in `liveTokens`/`liveThinking`
 *  and are mirrored into events only by the BE window) keeps the tail
 *  the UI actually renders. */
export const MAX_EVENTS_IN_VIEW = 400;

export interface ChatStore {
  /** Loaded chat metadata + paged prompts. `null` until the first fetch. */
  view: ChatView | null;
  /** Prompts the user is currently looking at. Oldest first. May be
   *  longer than view.prompts after backfill. */
  prompts: Prompt[];
  /** Live token accumulators keyed by promptId. Token deltas append to
   *  this string; the rendered assistantText() prefers it over the
   *  prompt's events array so we avoid re-walking thousands of events
   *  on every keystroke. */
  liveTokens: Record<string, string>;
  /** Live thinking accumulators keyed by promptId. Same shape as
   *  liveTokens but separate so the thinking and answer streams
   *  don't collide while both are arriving. */
  liveThinking: Record<string, string>;
  /** True when a backfill request is in flight. */
  loadingOlder: boolean;
  /** True when there are no more older prompts to load. */
  atStart: boolean;
}

export const freshChatStore = (): ChatStore => ({
  view: null,
  prompts: [],
  liveTokens: {},
  liveThinking: {},
  loadingOlder: false,
  atStart: false,
});

/** Decode a WS message into a `(promptId, event)` pair, or `null` for
 *  non-event frames (e.g. the `{subscribed:topic}` hello). */
export interface WsFrame {
  promptId: string;
  event: AgentEvent;
}
export function parseWsFrame(raw: unknown): WsFrame | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const msg = parsed as {
    prompt_id?: string;
    event?: AgentEvent;
    subscribed?: string;
  };
  if (msg.subscribed) return null;
  if (!msg.prompt_id || !msg.event) return null;
  return { promptId: msg.prompt_id, event: msg.event };
}

/** Append an event to a prompt's events array with a hard bound.
 *  Mirrors the BE's `Truncated { dropped }` sentinel: once `events`
 *  reaches `max` entries, the oldest *real* event (index 1 when a
 *  sentinel is present, otherwise index 0) is dropped and the new
 *  event is appended, keeping the tail the UI renders. token/thinking
 *  events never reach this path (they live in `liveTokens`/`liveThinking`),
 *  and `done`/`error` are always at the tail, so nothing the renderer
 *  needs is evicted. */
export function appendEventBounded(events: AgentEvent[], ev: AgentEvent, max: number): void {
  if (events.length < max) {
    events.push(ev);
    return;
  }
  const first = events[0];
  if (first && first.type === "truncated") {
    events.splice(1, 1); // drop oldest real event
    first.dropped += 1;
  } else {
    events[0] = { type: "truncated", dropped: 1 };
    events.splice(1, 1); // drop oldest real event
  }
  events.push(ev);
}

/** Apply a decoded WS frame to the chat store. Called inside a
 *  `produce` block so all mutations are batched into one update.
 *
 *  Note on persistence: token deltas are tracked in `liveTokens` for
 *  cheap rendering while a turn is in flight. The BE *also* writes
 *  the same coalesced Token events into the prompt's `events` array
 *  (so a subsequent GET /api/chats/:id replays the full text). We
 *  therefore must NOT inject a synthetic token back into events on
 *  `done` — the canonical text is already there. We only need to
 *  drop the liveTokens entry so subsequent renders read from events. */
export function applyWsFrame(s: ChatStore, frame: WsFrame): void {
  const { promptId, event: ev } = frame;
  if (ev.type === "token") {
    // Append to the per-prompt live buffer — single string update
    // instead of walking the events array on every render. The
    // event itself is mirrored into prompts[].events server-side
    // via append_event, so we don't push it here.
    s.liveTokens[promptId] = (s.liveTokens[promptId] ?? "") + ev.text;
    return;
  }
  if (ev.type === "thinking") {
    s.liveThinking[promptId] = (s.liveThinking[promptId] ?? "") + ev.text;
    return;
  }
  const idx = s.prompts.findIndex((p) => p.id === promptId);
  if (idx < 0) return;
  const prompt = s.prompts[idx]!;
  appendEventBounded(prompt.events, ev, MAX_EVENTS_IN_VIEW);
  if (ev.type === "done" || ev.type === "error") {
    // Stream finished — drop the live buffers so PromptRow falls
    // back to the events array (canonical, persisted text).
    delete s.liveTokens[promptId];
    delete s.liveThinking[promptId];
  }
  // Auto-retry: the BE detected a stale session, cleared it, and is
  // re-dispatching with fresh context. Reset this prompt so the UI
  // goes back to "working" and the retry's tokens stream in cleanly.
  const evAny = ev as { type: string; message?: string };
  if (evAny.type === "retry") {
    delete s.liveTokens[promptId];
    delete s.liveThinking[promptId];
    prompt.events = [ev];
  }
}

/** Build the WS URL for a topic. Reuses the same base URL the REST
 *  client uses so we hit the BE directly under Vite dev (5173 → 4317)
 *  and same-origin in production. */
export function chatWsUrl(topic: string): string {
  const apiBase = api.baseUrl() || window.location.origin;
  const url = new URL(apiBase, window.location.origin);
  url.protocol = url.protocol.startsWith("https") ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("topic", topic);
  return url.toString();
}

// ---- Per-prompt derivations -------------------------------------------
//
// Pure reads over `(prompt, liveTokens, liveThinking)`. Shared so the
// desktop and mobile timelines agree on what a turn currently says --
// in particular on preferring the live buffer over the events array
// while a turn streams, which is what keeps a reply from appearing
// twice once the BE's mirrored Token events land.

/** The assistant's reply text so far. */
export function assistantText(prompt: Prompt, liveTokens: Record<string, string>): string {
  const live = liveTokens[prompt.id];
  if (live !== undefined) return live;
  let out = "";
  for (const ev of prompt.events) {
    if (ev.type === "token") out += ev.text;
  }
  return out;
}

/** The model's extended-thinking trace. Empty when the model wasn't
 *  asked to think, or doesn't support it. */
export function thinkingText(prompt: Prompt, liveThinking: Record<string, string>): string {
  const live = liveThinking[prompt.id];
  if (live !== undefined) return live;
  let out = "";
  for (const ev of prompt.events) {
    if (ev.type === "thinking") out += ev.text;
  }
  return out;
}

/** Tool activity plus the sentinels worth surfacing next to it. */
export function toolEvents(prompt: Prompt): AgentEvent[] {
  return prompt.events.filter(
    (e) =>
      e.type === "tool_call" ||
      e.type === "tool_result" ||
      e.type === "error" ||
      e.type === "truncated",
  );
}

/** Provider errors (rate limits, spawn failures, cancellations). Shown
 *  prominently so a failed turn never reads as an empty one. */
export function errorMessages(prompt: Prompt): string[] {
  return prompt.events.filter((e) => e.type === "error").map((e) => e.message);
}

/**
 * Whether the agent is still working on this prompt.
 *
 * Gated on `isLast` deliberately: the queue drains one prompt at a time,
 * so once a newer prompt exists this one is immutable history. Without
 * the gate, a prompt that never received its terminal `done`/`error`
 * frame (a dropped WS message) stays stuck on "working…" forever.
 */
export function isPromptPending(
  prompt: Prompt,
  liveTokens: Record<string, string>,
  liveThinking: Record<string, string>,
  isLast: boolean,
): boolean {
  if (!isLast) return false;
  if (liveTokens[prompt.id] !== undefined || liveThinking[prompt.id] !== undefined) return true;
  const evs = prompt.events;
  if (evs.length === 0) return true;
  const last = evs[evs.length - 1]!;
  return last.type !== "done" && last.type !== "error";
}
