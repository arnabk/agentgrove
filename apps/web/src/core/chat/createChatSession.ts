import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api, type Prompt } from "@/core/api/client";
import {
  MAX_PROMPTS_IN_VIEW,
  applyWsFrame,
  chatWsUrl,
  freshChatStore,
  parseWsFrame,
  type ChatStore,
  type WsFrame,
} from "@/core/chat/chatStream";

/**
 * Headless chat session: owns one chat's timeline, its WebSocket, and
 * the send/stop verbs. Lifted out of ChatPane so a shell only has to
 * supply a chat id and render `store`.
 *
 * Must be created inside a reactive owner (a component body) — it
 * registers effects and cleanups.
 *
 * NOTE: ChatPane still runs its own copy of this engine. Rewiring it
 * onto this primitive is a follow-up; the subtle parts (the frame
 * protocol and the per-prompt derivations) are already shared via
 * chatStream, so the two cannot disagree about what a turn says.
 */

/** How long token/thinking deltas are merged before one store commit. */
const DELTA_FLUSH_MS = 100;
/** Debounce on opening the socket, so a fast A->B->C switch only
 *  connects to the chat the user settles on. */
const CONNECT_DEBOUNCE_MS = 120;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** Fallback reconcile cadence while a turn is in flight, in case a
 *  `done` frame is lost and the bubble would otherwise stay stuck. */
const INFLIGHT_POLL_MS = 3_000;

export interface ChatSessionOptions {
  /** Active chat id, or null for "nothing open". Reactive. */
  chatId: Accessor<string | null>;
  /** Called when the BE reports a queued item drained into the chat. */
  onQueueDispatched?: () => void;
  /** Called when the BE reports the chat went idle. */
  onChatIdle?: () => void;
}

export interface ChatSession {
  /** Reactive timeline. Read-only from the caller's perspective. */
  store: ChatStore;
  /** Latest error message, or null. */
  error: Accessor<string | null>;
  clearError: () => void;
  /** True while the tail prompt has an unfinished turn. */
  isStreaming: Accessor<boolean>;
  /** Re-fetch the windowed view, blanking first. */
  reload: () => Promise<void>;
  /** Re-fetch without disturbing in-flight live buffers. */
  reconcile: () => Promise<void>;
  /** Backfill one older page. No-op at the start of history. */
  loadOlder: () => Promise<void>;
  /** Optimistic send. Resolves false when the BE rejected it. */
  send: (body: string) => Promise<boolean>;
  /** Cancel the in-flight turn. */
  stop: () => Promise<void>;
}

export function createChatSession(opts: ChatSessionOptions): ChatSession {
  const [store, setStore] = createStore<ChatStore>(freshChatStore());
  const [error, setError] = createSignal<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const isStreaming = () => {
    const tail = store.prompts[store.prompts.length - 1];
    if (!tail) return false;
    // Accepted but no events yet: the agent is spinning up, so the
    // Stop affordance must already be reachable.
    if (tail.events.length === 0) return true;
    const last = tail.events[tail.events.length - 1]!;
    return last.type !== "done" && last.type !== "error";
  };

  async function reload() {
    const id = opts.chatId();
    if (!id) {
      setStore(freshChatStore());
      return;
    }
    setStore(freshChatStore());
    try {
      const view = await api.getChat(id);
      // A fast switch may have moved on; don't clobber the new chat.
      if (opts.chatId() !== id) return;
      setStore({
        ...freshChatStore(),
        view,
        prompts: view.prompts,
        atStart: view.prompts.length >= view.prompts_total,
      });
    } catch (e) {
      fail(e);
    }
  }

  /**
   * Soft refresh. Preserves live token/thinking buffers and any
   * optimistic placeholder the user just submitted, so it is safe to
   * call repeatedly mid-turn.
   */
  async function reconcile() {
    const id = opts.chatId();
    if (!id) return;
    try {
      const view = await api.getChat(id);
      if (opts.chatId() !== id) return;
      setStore(
        produce((s) => {
          s.view = view;
          s.atStart = view.prompts.length >= view.prompts_total;
          const beIds = new Set(view.prompts.map((p) => p.id));
          // Drop placeholders the BE has already materialised under a
          // real id, or the send would show as a visible duplicate.
          const beContents = new Set(view.prompts.map((p) => p.content));
          const localOnly = s.prompts.filter(
            (p) => !beIds.has(p.id) && !(p.id.startsWith("pending-") && beContents.has(p.content)),
          );
          const beFirstSeq = view.prompts[0]?.seq ?? Infinity;
          const beLastSeq = view.prompts[view.prompts.length - 1]?.seq ?? -Infinity;
          const before = localOnly.filter((p) => p.seq >= 0 && p.seq < beFirstSeq);
          const after = localOnly.filter((p) => p.seq < 0 || p.seq > beLastSeq);
          s.prompts = [...before, ...view.prompts, ...after];
          // Keep the TAIL on overflow: the in-flight turn is what the
          // user is watching. (Backfill drops the other end.)
          if (s.prompts.length > MAX_PROMPTS_IN_VIEW) {
            s.prompts = s.prompts.slice(s.prompts.length - MAX_PROMPTS_IN_VIEW);
          }
          for (const p of view.prompts) {
            const last = p.events[p.events.length - 1];
            if (last && (last.type === "done" || last.type === "error")) {
              delete s.liveTokens[p.id];
              delete s.liveThinking[p.id];
            }
          }
        }),
      );
    } catch (e) {
      fail(e);
    }
  }

  async function loadOlder() {
    const id = opts.chatId();
    const oldest = store.prompts[0];
    if (!id || !oldest || store.atStart || store.loadingOlder) return;
    setStore("loadingOlder", true);
    try {
      const page = await api.listPrompts(id, oldest.seq, 50);
      setStore(
        produce((s) => {
          s.prompts = page.prompts.concat(s.prompts);
          // Drop the newest beyond the cap — a reader scrolling up
          // wants the older context they just asked for.
          if (s.prompts.length > MAX_PROMPTS_IN_VIEW) {
            s.prompts = s.prompts.slice(0, MAX_PROMPTS_IN_VIEW);
          }
          s.atStart = page.at_start;
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setStore("loadingOlder", false);
    }
  }

  function dropPlaceholder(tempId: string) {
    setStore(
      produce((s) => {
        const idx = s.prompts.findIndex((p) => p.id === tempId);
        if (idx >= 0) s.prompts.splice(idx, 1);
      }),
    );
  }

  async function send(body: string): Promise<boolean> {
    const id = opts.chatId();
    if (!id || !body.trim()) return false;

    // Optimistic placeholder so the user's message lands instantly.
    // Whether the BE dispatches or queues isn't known yet.
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    const placeholder: Prompt = {
      id: tempId,
      seq: -1,
      content: body,
      events: [],
      touched_paths: [],
      created_at: new Date().toISOString(),
    };
    setStore(
      produce((s) => {
        s.prompts.push(placeholder);
        if (s.prompts.length > MAX_PROMPTS_IN_VIEW) s.prompts.shift();
      }),
    );

    try {
      // Authoritative server decision — no FE race against stale
      // busy / queue counts.
      const res = await api.sendMessage(id, body);
      if (res.kind === "dispatched") {
        // Swap in the real record so WS frames, which are keyed by the
        // real prompt id, light up this bubble.
        setStore(
          produce((s) => {
            const idx = s.prompts.findIndex((p) => p.id === tempId);
            if (idx >= 0) s.prompts[idx] = res.prompt;
            else s.prompts.push(res.prompt);
          }),
        );
      } else {
        // Queued: the message lives in the queue, not the timeline.
        dropPlaceholder(tempId);
      }
      return true;
    } catch (e) {
      dropPlaceholder(tempId);
      fail(e);
      return false;
    }
  }

  async function stop() {
    const id = opts.chatId();
    if (!id) return;
    try {
      await api.stopChat(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("404")) {
        setError(msg);
        return;
      }
      // 404 = nothing in flight. If the tail is still stuck with no
      // terminal event the agent crashed or never ran, so synthesise
      // one to unstick the UI.
      setStore(
        produce((s) => {
          const tail = s.prompts[s.prompts.length - 1];
          if (!tail) return;
          const last = tail.events[tail.events.length - 1];
          if (!last || (last.type !== "done" && last.type !== "error")) {
            tail.events.push({
              type: "error",
              message: "Turn did not complete — the agent may have crashed or timed out.",
            });
          }
        }),
      );
      void reconcile();
    }
  }

  // Reload whenever the active chat changes.
  createEffect(() => {
    void opts.chatId();
    void reload();
  });

  // Per-chat event stream, with delta batching and auto-reconnect.
  createEffect(() => {
    const id = opts.chatId();
    if (!id) return;
    const url = chatWsUrl(`chat:${id}`);
    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_BASE_MS;

    // A streaming turn delivers deltas dozens of times per second.
    // Committing each one re-renders the timeline, which re-parses the
    // whole accumulated reply through marked + DOMPurify — O(n^2) per
    // frame. Merging ~100ms into one commit keeps it visually live at
    // a fraction of the render cost.
    let pending: WsFrame[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const tokens = new Map<string, string>();
      const thinking = new Map<string, string>();
      for (const f of batch) {
        if (f.event.type === "token") {
          tokens.set(f.promptId, (tokens.get(f.promptId) ?? "") + f.event.text);
        } else if (f.event.type === "thinking") {
          thinking.set(f.promptId, (thinking.get(f.promptId) ?? "") + f.event.text);
        }
      }
      setStore(
        produce((s) => {
          for (const [pid, text] of tokens) s.liveTokens[pid] = (s.liveTokens[pid] ?? "") + text;
          for (const [pid, text] of thinking) {
            s.liveThinking[pid] = (s.liveThinking[pid] ?? "") + text;
          }
        }),
      );
    }

    function enqueue(frame: WsFrame) {
      const t = frame.event.type;
      if (t !== "token" && t !== "thinking") {
        // Control frame: apply after buffered deltas so ordering holds
        // (`done` must follow the final tokens).
        flush();
        setStore(produce((s) => applyWsFrame(s, frame)));
        return;
      }
      pending.push(frame);
      if (!flushTimer) flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
    }

    function connect() {
      if (closed) return;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        fail(e);
        return;
      }
      socket.addEventListener("open", () => {
        reconnectDelay = RECONNECT_BASE_MS;
      });
      socket.addEventListener("message", (ev) => {
        if (closed) return;
        if (typeof ev.data === "string") {
          try {
            const parsed = JSON.parse(ev.data) as {
              queue_dispatched?: string;
              chat_idle?: boolean;
              subscribed?: string;
            };
            if (parsed.subscribed) {
              // Fresh (re)subscription: pull canonical events so any
              // prompt that finished while we were disconnected clears
              // its live buffers. Deliberately NOT a blanket clear —
              // that wipes in-flight thinking text.
              void reconcile();
              return;
            }
            if (parsed.queue_dispatched) {
              void reconcile();
              opts.onQueueDispatched?.();
              return;
            }
            if (parsed.chat_idle) {
              void reconcile();
              opts.onChatIdle?.();
              return;
            }
          } catch {
            // Not a control frame — fall through.
          }
        }
        const frame = parseWsFrame(ev.data);
        if (frame) enqueue(frame);
      });
      socket.addEventListener("close", () => {
        socket = null;
        if (closed) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay);
      });
      socket.addEventListener("error", () => {
        // `close` fires right after and owns the reconnect. Closing
        // here just makes that deterministic.
        try {
          socket?.close();
        } catch {
          // ignore
        }
      });
    }

    const connectTimer = setTimeout(connect, CONNECT_DEBOUNCE_MS);

    onCleanup(() => {
      closed = true;
      // Flush buffered deltas so unmounting mid-turn doesn't silently
      // drop the tail of the stream.
      flush();
      clearTimeout(connectTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        // ignore
      }
    });
  });

  // Belt-and-braces: poll while a turn is in flight so a lost `done`
  // frame costs at most one interval rather than a page reload.
  createEffect(() => {
    if (!opts.chatId() || !isStreaming()) return;
    const handle = setInterval(() => void reconcile(), INFLIGHT_POLL_MS);
    onCleanup(() => clearInterval(handle));
  });

  return {
    store,
    error,
    clearError: () => setError(null),
    isStreaming,
    reload,
    reconcile,
    loadOlder,
    send,
    stop,
  };
}
