import { onCleanup, onMount } from "solid-js";

/**
 * Cross-tab synchronisation for AgentGrove.
 *
 * Multiple tabs of the same FE pointing at the same BE used to
 * diverge silently: tab A creates a chat, tab B never sees it
 * unless the user reloads. Local state (composer drafts, active
 * scope, pane choice) was per-tab, not per-user.
 *
 * This module fixes that with two layers:
 *
 *   1. **BroadcastChannel** for runtime sync. Every store-write
 *      that other tabs care about is published; subscribers
 *      apply incoming messages with `applyingRemote=true` so
 *      they don't re-broadcast. Sub-millisecond, same-origin.
 *      Falls back to localStorage events on browsers without
 *      BroadcastChannel (older Safari).
 *
 *   2. **Leader election** so only one tab polls the BE for
 *      changes that won't fire a WS event (project list,
 *      worktree list, settings). The leader publishes those
 *      results back via the same BroadcastChannel.
 *
 * Caller pattern: import `broadcast`, `subscribe`, and
 * `installCrossTabSync` (latter wires up the heartbeat +
 * subscribes the App component to the leader signal).
 */

/** Messages all tabs understand. `kind` is the discriminant. */
export type CrossTabMessage =
  | { kind: "ping"; tabId: string; ts: number }
  | { kind: "store"; tabId: string; topic: string; payload: unknown }
  | { kind: "leader-claim"; tabId: string; ts: number };

const CHANNEL_NAME = "agentgrove";
const HEARTBEAT_KEY = "ag-leader-heartbeat";
const LEADER_TTL_MS = 2500;
const HEARTBEAT_INTERVAL_MS = 1000;

/** Unique per-tab id so subscribers can ignore their own
 *  broadcasts. Crypto-random — collisions are theoretically
 *  possible but vanishingly so for the lifetime of one session. */
export const TAB_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
})();

// BroadcastChannel is supported in every modern browser; the
// fallback path (localStorage 'storage' events) exists for old
// Safari + iOS WKWebView. The two surfaces look identical to the
// rest of the FE: publish() goes out, subscribe() gets called.
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

type Listener = (msg: CrossTabMessage) => void;
const listeners = new Set<Listener>();

if (channel) {
  channel.onmessage = (e) => {
    const msg = e.data as CrossTabMessage;
    if (!msg || typeof msg !== "object") return;
    for (const fn of listeners) fn(msg);
  };
} else if (typeof window !== "undefined") {
  // localStorage fallback. We write the message to a known key +
  // immediately delete it; other tabs fire `storage` and pick up
  // the value via the event's newValue (it's set + cleared in
  // the same tick so reading the key directly would return null).
  window.addEventListener("storage", (e) => {
    if (e.key !== `${HEARTBEAT_KEY}:msg` || !e.newValue) return;
    try {
      const msg = JSON.parse(e.newValue) as CrossTabMessage;
      for (const fn of listeners) fn(msg);
    } catch {
      // ignore malformed messages
    }
  });
}

/** Publish a message to every other tab on the same origin. */
export function broadcast(msg: CrossTabMessage) {
  if (channel) {
    channel.postMessage(msg);
    return;
  }
  if (typeof window === "undefined") return;
  try {
    const key = `${HEARTBEAT_KEY}:msg`;
    window.localStorage.setItem(key, JSON.stringify(msg));
    window.localStorage.removeItem(key);
  } catch {
    // localStorage may be full / blocked in private windows; if
    // sync fails the worst case is staleness, not corruption.
  }
}

/** Subscribe to broadcast messages from other tabs. The handler is
 *  called for EVERY message, including ones this tab sent. Callers
 *  typically filter by `msg.tabId !== TAB_ID` to skip own writes. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Publish a typed store-mutation message. The topic is a free-form
 *  string that subscribers match on (e.g. "settings", "projects",
 *  "layout:<scope-key>"). Payload is the full new value of the
 *  topic — we don't ship diffs because the FE store handles diffing
 *  at the signal level. */
export function broadcastStoreWrite(topic: string, payload: unknown) {
  broadcast({ kind: "store", tabId: TAB_ID, topic, payload });
}

// ---------- leader election ----------------------------------------------

/** Returns true when this tab is currently the elected leader. The
 *  caller can gate periodic BE polls on this so only one tab pings
 *  the server. The election is heartbeat-based via localStorage: a
 *  tab claims leadership by writing its id + ts; followers respect
 *  the claim if the timestamp is fresh (< LEADER_TTL_MS old). */
export function isLeader(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(HEARTBEAT_KEY);
    if (!raw) return false;
    const heart = JSON.parse(raw) as { tabId: string; ts: number };
    return heart.tabId === TAB_ID;
  } catch {
    return false;
  }
}

/** Install the leader-heartbeat + visibility-aware reconnect for
 *  the App component. Call once in App's onMount. Returns a
 *  function the caller can poll to read the current leader state
 *  reactively (we wrap it in a signal so consumers can subscribe). */
export function installCrossTabSync(): {
  isLeader: () => boolean;
  dispose: () => void;
} {
  let leader = isLeader();
  const tickers: ReturnType<typeof setInterval>[] = [];

  function tryClaim() {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(HEARTBEAT_KEY);
      const now = Date.now();
      if (!raw) {
        // No leader → claim it.
        window.localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
        leader = true;
        broadcast({ kind: "leader-claim", tabId: TAB_ID, ts: now });
        return;
      }
      const heart = JSON.parse(raw) as { tabId: string; ts: number };
      if (heart.tabId === TAB_ID) {
        // We're already the leader → refresh the heartbeat.
        window.localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
        leader = true;
      } else if (now - heart.ts > LEADER_TTL_MS) {
        // Leader is stale → steal the role.
        window.localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
        leader = true;
        broadcast({ kind: "leader-claim", tabId: TAB_ID, ts: now });
      } else {
        leader = false;
      }
    } catch {
      // localStorage unavailable; pretend we're alone.
      leader = true;
    }
  }

  // First claim attempt synchronously so the App component sees a
  // sensible value during its first render.
  tryClaim();
  tickers.push(setInterval(tryClaim, HEARTBEAT_INTERVAL_MS));

  // Release leadership when the tab is closed so the next tab
  // doesn't wait LEADER_TTL_MS to take over.
  function onUnload() {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(HEARTBEAT_KEY);
      if (!raw) return;
      const heart = JSON.parse(raw) as { tabId: string; ts: number };
      if (heart.tabId === TAB_ID) {
        window.localStorage.removeItem(HEARTBEAT_KEY);
      }
    } catch {
      // best effort
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onUnload);
  }

  return {
    isLeader: () => leader,
    dispose: () => {
      for (const t of tickers) clearInterval(t);
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", onUnload);
      }
      onUnload();
    },
  };
}

/** Solid-flavoured convenience: wire `subscribe` to a component's
 *  lifecycle. The handler is registered on mount, cleaned up on
 *  dispose. Callers don't have to track unsubscribe themselves. */
export function useCrossTabSubscription(fn: Listener) {
  let off: (() => void) | null = null;
  onMount(() => {
    off = subscribe(fn);
  });
  onCleanup(() => {
    off?.();
  });
}
