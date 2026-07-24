import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  declareMemorySource,
  estimateJsonBytes,
  estimateStringBytes,
  recordMemoryUsage,
} from "../lib/memory";

declareMemorySource("chat.activeView", "Chat events");
import {
  api,
  type AgentEvent,
  type ChatView,
  type Prompt,
  type ProviderDescriptor,
  type QueueItem,
  type QueueState,
  type UploadDto,
} from "../api/client";
import QueueTimeline from "../components/QueueTimeline";
import Select from "../components/Select";
import ChatSettingsDialog from "../components/ChatSettingsDialog";
import { confirm } from "../components/dialog";
import Markdown from "../components/Markdown";

import ChatComposer, { type ChatComposerHandle } from "../components/ChatComposer";
import { ToolRail } from "./chat/ToolRail";
import { useSyncSubscription } from "../lib/crossInstanceSync";
import {
  addChatTab,
  currentScope,
  currentScopeKey,
  currentWorktreeId,
  getChatDraft,
  pendingChatInjection,
  selectedChatId,
  setBusyChats,
  setChatDraft,
  setPendingChatInjection,
  setScopeChats,
  state,
} from "../stores/app";

/**
 * Windowed chat timeline (ADR-0006).
 *
 * Loads the last 50 prompts × 200 events via `GET /api/chats/:id` and
 * appends incoming events from `/ws?topic=chat:{id}` as the agent
 * produces them. Token deltas accumulate in a per-prompt buffer (kept
 * out of the heavy `events` array on the prompt record) so character-
 * per-event providers don't trigger a full re-render on every byte.
 *
 * Older prompts are backfilled on demand via the "Load older" affordance.
 * The FE keeps a hard cap on in-memory prompts; oldest beyond the cap
 * are dropped on backfill if needed.
 */

/** Hard cap on prompts held in the FE store per chat (ADR-0006). */
const MAX_PROMPTS_IN_VIEW = 2000;

interface ChatStore {
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

const freshChatStore = (): ChatStore => ({
  view: null,
  prompts: [],
  liveTokens: {},
  liveThinking: {},
  loadingOlder: false,
  atStart: false,
});

export default function ChatPane() {
  const [chatStore, setChatStore] = createStore<ChatStore>(freshChatStore());
  const [input, setInput] = createSignal("");
  /** Imperative handle to the rich composer. Used by slash-menu
   *  apply, prompt-picker insert, file-paths append, and the
   *  per-chat settings dialog's "insert command" action. Replaces
   *  the old `document.querySelector('[data-testid="chat-input"]')`
   *  textarea pokes. */
  let composer: ChatComposerHandle | null = null;
  // Whether the agent is currently working on this chat's *latest*
  // prompt. Only the tail prompt can be in-flight — older prompts
  // are immutable history.
  //
  // We can't rely on the POST /prompts call to flip a flag because
  // that resolves the instant the BE accepts the prompt, long before
  // the AI is done streaming tokens. Instead we inspect the tail:
  //   - empty events array → BE accepted it but no events yet, the
  //     agent is just spinning up → busy.
  //   - last event is `done` or `error` → turn finished → idle.
  //   - anything else → token / thinking / tool_use stream is mid-
  //     flight → busy.
  //
  // Note: the BE's smart-send endpoint (POST /api/chats/:id/messages)
  // makes the authoritative dispatch-vs-queue decision so the FE
  // doesn't need a `busy` signal for routing. We do compute one
  // here for *UI* purposes only — driving the Send/Stop button
  // toggle. "Streaming" means the tail prompt has at least one
  // non-terminal event flowing.
  const isStreaming = (): boolean => {
    const tail = chatStore.prompts[chatStore.prompts.length - 1];
    if (!tail) return false;
    const evs = tail.events;
    if (evs.length === 0) {
      // Newly accepted prompt — events haven't started flowing yet.
      // Treat as "streaming" so the Stop button is reachable
      // even during the brief pre-token window.
      return true;
    }
    const last = evs[evs.length - 1]!;
    return last.type !== "done" && last.type !== "error";
  };
  const [err, setErr] = createSignal<string | null>(null);
  // Pending uploads attached to the next prompt. Chips render below
  // the textarea; on send we tack their absolute paths onto the
  // prompt body so the agent's Read tool can fetch them.
  const [uploads, setUploads] = createSignal<UploadDto[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [dragActive, setDragActive] = createSignal(false);
  // Inline rename state. `renamingId` is the chat being edited (or null);
  // `renameDraft` holds the in-flight input value.
  // Per-chat settings dialog (model / effort / slash commands).
  const [chatSettingsOpen, setChatSettingsOpen] = createSignal(false);
  // Slash-command menu. We open it as soon as the user types `/` at
  // the very start of the input (or the start of any line) and close
  // on space / Esc / send. The query is whatever follows the slash
  // up to the next whitespace.
  const [slashQuery, setSlashQuery] = createSignal<string | null>(null);
  const [slashIdx, setSlashIdx] = createSignal(0);
  // Cached slash commands for the active chat's provider. Refreshed
  // on chat change (effect declared further down after chat() exists).
  const [providerCommands, setProviderCommands] = createSignal<
    { name: string; description: string }[]
  >([]);
  // Cached provider list so the composer's model dropdown can show
  // the curated `models` array per provider without refetching on
  // every chat switch. Loaded once on mount; provider versions don't
  // change at runtime.
  const [providers, setProviders] = createSignal<ProviderDescriptor[]>([]);
  onMount(() => {
    void (async () => {
      try {
        setProviders(await api.listProviders());
      } catch {
        // best-effort — composer falls back to a single-item list
        // ("current model") if the providers endpoint is unreachable.
      }
    })();
  });
  // Queue drawer visibility. Persisted across reloads so users who
  // Lightweight queue summary used to drive the header badge. Polled
  // even while the drawer is closed so the count + status stay live.
  const [queueSummary, setQueueSummary] = createSignal<{
    total: number;
    pending: number;
    running: number;
    /** Per-chat queue mode read straight from the BE so the
     *  composer's mode dropdown reflects what the server will
     *  actually do, not a stale FE assumption. */
    mode: "auto" | "manual";
  } | null>(null);
  createEffect(() => {
    const id = activeId();
    if (!id) {
      setQueueSummary(null);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const q = await api.getQueue(id!);
        if (cancelled) return;
        setQueueSummary({
          total: q.items.length,
          pending: q.items.filter((i) => i.status === "pending").length,
          running: q.items.filter((i) => i.status === "running").length,
          mode: q.mode,
        });
      } catch {
        // ignore — badge is best-effort
      }
    }
    void poll();
    const handle = setInterval(() => void poll(), 2000);
    onCleanup(() => {
      cancelled = true;
      clearInterval(handle);
    });
  });

  const scope = () => currentScope();
  const tabs = () => scope()?.tabs.filter((t) => t.kind === "chat") ?? [];
  const activeId = () => selectedChatId();

  // ---- Inline queue (rendered at the bottom of the timeline) --------
  // The queue used to live in the right sidebar; it now sits in the
  // chat flow. ChatPane owns the state because it already holds the WS
  // connection + the busy/streaming signal that locks the queue.
  const [queueState, setQueueState] = createSignal<QueueState | null>(null);
  const [queueBusy, setQueueBusy] = createSignal(false);
  const [queueExpanded, setQueueExpanded] = createSignal<Set<string>>(new Set());
  // Ids of queue items currently being edited inline. While non-empty we
  // pause queue polling so a refresh doesn't re-create the row and drop
  // the user's in-progress edit.
  const [queueEditingIds, setQueueEditingIds] = createSignal<Set<string>>(new Set());
  function onQueueItemEditing(itemId: string, editing: boolean) {
    setQueueEditingIds((s) => {
      const next = new Set(s);
      if (editing) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }
  // Keep queue item references stable across polls so Solid's <For>
  // reuses DOM nodes instead of re-mounting every card on each refresh.
  // Only items whose body/status actually change get a new object.
  const queueItemCache = new Map<string, QueueItem>();
  const queueItems = createMemo(() => {
    const items = queueState()?.items ?? [];
    // Filter out queue items whose body already exists as a prompt
    // in the timeline. This prevents the brief duplicate where a
    // drained item (now a real prompt) is still visible as a
    // "running" queue card before the next poll removes it.
    const promptContents = new Set(chatStore.prompts.map((p) => p.content));
    const visible = items.filter((i) => i.status === "pending" || !promptContents.has(i.body));

    for (const item of visible) {
      const existing = queueItemCache.get(item.id);
      if (
        existing &&
        existing.body === item.body &&
        existing.status === item.status &&
        existing.created_at === item.created_at
      ) {
        continue;
      }
      queueItemCache.set(item.id, item);
    }
    for (const id of queueItemCache.keys()) {
      if (!visible.some((i) => i.id === id)) queueItemCache.delete(id);
    }
    return visible.map((item) => queueItemCache.get(item.id)!);
  });
  const queueMode = () => queueState()?.mode ?? "auto";
  // Lock the whole queue while the agent is working (product decision):
  // queued items can't be edited / removed / reordered mid-turn.
  const queueLocked = () => isStreaming();

  async function refreshQueue() {
    const id = activeId();
    if (!id) {
      setQueueState(null);
      return;
    }
    try {
      setQueueState(await api.getQueue(id));
    } catch {
      // Queue is non-critical chrome; swallow transient errors so a
      // hiccup doesn't spam the chat error banner.
    }
  }

  function toggleQueueExpanded(itemId: string) {
    setQueueExpanded((s) => {
      const next = new Set(s);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function cancelQueueItem(item: QueueItem) {
    setQueueBusy(true);
    try {
      await api.cancelQueueItem(activeId()!, item.id);
    } catch (e) {
      // 404 = already gone (dispatched / removed elsewhere). Benign.
      const notFound = e instanceof Error && e.message.includes("404");
      if (!notFound) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshQueue();
      setQueueBusy(false);
    }
  }

  async function updateQueueItem(item: QueueItem, body: string) {
    setQueueBusy(true);
    try {
      await api.updateQueueItem(activeId()!, item.id, body);
      await refreshQueue();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQueueBusy(false);
    }
  }

  async function setQueueMode(mode: "auto" | "manual") {
    setQueueBusy(true);
    try {
      await api.setQueueMode(activeId()!, mode);
      await refreshQueue();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQueueBusy(false);
    }
  }

  async function runNextQueue() {
    setQueueBusy(true);
    try {
      await api.runNextQueue(activeId()!);
      await refreshQueue();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQueueBusy(false);
    }
  }

  // Poll the queue while a chat is active. Cheap (small JSON) + the
  // BE auto-drains, so most queues shrink fast; this just keeps the
  // inline cards in sync. Also re-reads on every chat switch.
  createEffect(() => {
    const id = activeId();
    if (!id) {
      setQueueState(null);
      return;
    }
    void refreshQueue();
    const handle = setInterval(() => {
      // Pause polling while a card is being edited so the refresh
      // doesn't re-create the row and discard the in-progress edit.
      if (queueEditingIds().size > 0) return;
      void refreshQueue();
    }, 1000);
    onCleanup(() => clearInterval(handle));
  });

  /** Refresh the chat list for the active scope from the BE.
   *
   *  Tabs in this scope are user-curated: closing a tab is a local
   *  action (the chat itself stays on the server, reachable from
   *  the LeftRail). So we DO NOT replace the tab list with whatever
   *  the BE returns — that would resurrect tabs the user has
   *  intentionally closed every time they switch scopes.
   *
   *  Instead we reconcile in two passes:
   *    1. **Bootstrap** — if the scope has never had any tabs (fresh
   *       project / first visit), seed with every BE chat so the
   *       user isn't staring at an empty pane.
   *    2. **Intersect** — for an already-populated scope, drop tabs
   *       whose chat was deleted server-side (defensive; should be
   *       rare) and update titles in place. Chats the user closed
   *       stay closed; new server chats only appear when the user
   *       opens them from the LeftRail.
   */
  async function refreshScopeChats() {
    const pid = state.selectedProjectId;
    if (!pid) {
      setScopeChats([]);
      return;
    }
    // Read the worktree ID from the store at call time. If we're called
    // during mount before route-sync has set selectedWorktreeByProject,
    // this will be null — defer to the next effect run when the scope
    // settles rather than bootstrapping with the wrong filter.
    const wt = currentWorktreeId();
    const key = currentScopeKey();
    // Guard: if the scope key contains a worktree segment but wt is
    // still null, the store hasn't caught up yet — skip this run.
    if (key && key.includes("::") && key.split("::")[1] && !wt) return;
    try {
      const all = await api.listProjectChats(pid);
      const beChats = all.filter((c) => (c.worktree_id ?? null) === wt);
      const beById = new Map(beChats.map((c) => [c.id, c]));
      const current = scope()?.tabs.filter((t) => t.kind === "chat") ?? [];
      const hydrated = scope()?.chatsHydrated ?? false;
      if (current.length === 0 && !hydrated) {
        // Bootstrap: scope has NEVER been visited — seed with
        // everything the BE knows about. Once hydrated=true is set
        // (via setScopeChats), an empty list means "user closed
        // everything" and we respect that rather than re-seeding.
        setScopeChats(beChats.map((c) => ({ id: c.id, title: c.title })));
        return;
      }
      if (current.length === 0 && hydrated && beChats.length === 0) {
        // User has explicitly closed every tab AND there are no
        // BE chats — leave the tab strip empty.
        return;
      }
      if (current.length === 0 && hydrated && beChats.length > 0) {
        // Edge case: hydrated flag was set (possibly from a buggy
        // earlier run) but BE has chats the user never saw. Re-seed
        // rather than hiding them forever.
        setScopeChats(beChats.map((c) => ({ id: c.id, title: c.title })));
        return;
      }
      // Reconcile: keep the local tab order, drop tabs whose chat
      // vanished server-side, refresh titles in place, AND preserve
      // any per-tab draft text the user has typed. Dropping `draft`
      // here silently wiped composer state on every scope-switch /
      // page-reload because this reconcile runs whenever a chat
      // pane mounts.
      const reconciled = current
        .filter((t) => beById.has(t.id))
        .map((t) => ({
          id: t.id,
          title: beById.get(t.id)!.title,
          ...(t.draft ? { draft: t.draft } : {}),
        }));
      setScopeChats(reconciled);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Replace the in-memory chat from the windowed BE view. */
  async function loadChat() {
    const id = activeId();
    if (!id) {
      setChatStore(freshChatStore());
      return;
    }
    try {
      const view = await api.getChat(id);
      setChatStore({
        ...freshChatStore(),
        view,
        prompts: view.prompts,
        atStart: view.prompts.length >= view.prompts_total,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Soft reconcile: pulls the latest chat view but PRESERVES the
   *  live token / thinking buffers + any optimistic placeholder
   *  prompts the user just submitted. Used as the response to a
   *  `queue_dispatched` WS frame — the BE has appended one or more
   *  drained prompts, and we want them to show up without nuking
   *  the active token stream.
   *
   *  Merge rules:
   *    - Each BE prompt is identified by its id.
   *    - If a prompt with the same id already exists locally, we
   *      replace it with the BE copy (which may have more events).
   *    - Local prompts whose id is NOT in the BE view are kept only
   *      if they extend the known window: older prompts (seq lower
   *      than the first BE prompt) are prepended, and newer prompts
   *      or optimistic placeholders (seq higher than the last BE
   *      prompt, or seq -1) are appended.
   *    - Order = older local-only prompts, then BE order, then newer
   *      local-only prompts / placeholders.
   */
  async function reconcileChat() {
    const id = activeId();
    if (!id) return;
    try {
      const view = await api.getChat(id);
      setChatStore(
        produce((s) => {
          s.view = view;
          s.atStart = view.prompts.length >= view.prompts_total;
          const beIds = new Set(view.prompts.map((p) => p.id));
          // Content of BE prompts, used to drop optimistic placeholders
          // that the BE has already materialized under a real id. Without
          // this, a reconcile that races an in-flight injected send (e.g.
          // the drift "pull & merge" badge, which switches scope mid-
          // dispatch) leaves the `pending-` placeholder orphaned next to
          // the real prompt — a visible duplicate.
          const beContents = new Set(view.prompts.map((p) => p.content));
          const localOnly = s.prompts.filter(
            (p) => !beIds.has(p.id) && !(p.id.startsWith("pending-") && beContents.has(p.content)),
          );
          const beFirstSeq = view.prompts[0]?.seq ?? Infinity;
          const beLastSeq = view.prompts[view.prompts.length - 1]?.seq ?? -Infinity;
          const before = localOnly.filter((p) => p.seq >= 0 && p.seq < beFirstSeq);
          const after = localOnly.filter((p) => p.seq < 0 || p.seq > beLastSeq);
          s.prompts = [...before, ...view.prompts, ...after];
          // Drop any liveTokens / liveThinking entries whose prompt
          // has reached a terminal event in the BE copy — they're
          // canonical now.
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
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Prepend an older page of prompts when the user scrolls up. */
  async function loadOlder() {
    const id = activeId();
    const oldest = chatStore.prompts[0];
    if (!id || !oldest || chatStore.atStart || chatStore.loadingOlder) return;
    setChatStore("loadingOlder", true);
    try {
      const page = await api.listPrompts(id, oldest.seq, 50);
      setChatStore(
        produce((s) => {
          // Combine + cap at MAX_PROMPTS_IN_VIEW.
          s.prompts = page.prompts.concat(s.prompts);
          if (s.prompts.length > MAX_PROMPTS_IN_VIEW) {
            // Drop the newest beyond the cap. Most callers care about
            // older context after a scroll-up, not the freshest tail.
            s.prompts = s.prompts.slice(0, MAX_PROMPTS_IN_VIEW);
          }
          s.atStart = page.at_start;
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChatStore("loadingOlder", false);
    }
  }

  // Subscribe to per-chat event stream with auto-reconnect.
  // When the WS drops (BE restart, network blip, cargo-watch
  // rebuild) we back off and re-establish so streaming resumes
  // without the user having to reload the page.
  createEffect(() => {
    const id = activeId();
    if (!id) return;
    const url = wsUrlFor(`chat:${id}`);
    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1_000;
    const RECONNECT_MAX = 10_000;

    function connect() {
      if (closed) return;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return;
      }
      socket.addEventListener("open", () => {
        reconnectDelay = 1_000;
      });
      socket.addEventListener("message", (ev) => {
        if (closed) return;
        try {
          if (typeof ev.data === "string") {
            const parsed = JSON.parse(ev.data) as {
              queue_dispatched?: string;
              chat_idle?: boolean;
              subscribed?: string;
            };
            if (parsed.subscribed) {
              // Fresh subscription (initial connect or reconnect).
              // Reconcile from the BE so we have the canonical events,
              // which clears liveTokens/liveThinking for any finished
              // prompts. We do NOT blanket-clear the live buffers here
              // — that wiped in-flight thinking text when the user
              // switched scopes and came back.
              void reconcileChat();
              return;
            }
            if (parsed.queue_dispatched) {
              void reconcileChat();
              // A queued item just drained into the chat — refresh the
              // inline queue so the dispatched card disappears promptly.
              void refreshQueue();
              return;
            }
            if (parsed.chat_idle) {
              void reconcileChat();
              // Turn finished: the queue unlocks + may have auto-drained.
              void refreshQueue();
              return;
            }
          }
        } catch {
          // fall through to the normal event path
        }
        const frame = parseWsFrame(ev.data);
        if (!frame) return;
        setChatStore(produce((s) => applyWsFrame(s, frame)));
      });
      socket.addEventListener("close", () => {
        socket = null;
        if (!closed) {
          // Auto-reconnect with exponential backoff.
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
            connect();
          }, reconnectDelay);
        }
      });
      socket.addEventListener("error", () => {
        // The close event fires right after error; reconnect
        // happens there. Suppress user-facing noise.
        try {
          socket?.close();
        } catch {
          // ignore
        }
      });
    }

    connect();

    onCleanup(() => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        // ignore
      }
    });
  });

  // Belt-and-suspenders: while a prompt is in flight (no `done` /
  // `error` event on the tail) poll the chat view every 3 s as a
  // fallback for lost WS frames. The user reported one case where
  // the assistant bubble stayed at "working..." until a refresh
  // even though the BE had streamed + persisted the answer; this
  // ensures the FE catches up within at most 3 s.
  createEffect(() => {
    const id = activeId();
    if (!id) return;
    const tail = chatStore.prompts[chatStore.prompts.length - 1];
    if (!tail) return;
    const evs = tail.events;
    const last = evs[evs.length - 1];
    const isInFlight = evs.length === 0 || (last && last.type !== "done" && last.type !== "error");
    if (!isInFlight) return;
    const handle = setInterval(() => {
      // `reconcileChat` is soft: it preserves liveTokens for any
      // still-streaming prompts. Safe to call repeatedly.
      void reconcileChat();
    }, 3000);
    onCleanup(() => clearInterval(handle));
  });

  // Refresh tab list whenever the active scope changes.
  createEffect(() => {
    void state.selectedProjectId;
    void currentWorktreeId();
    void refreshScopeChats();
  });

  // Cross-instance sync: another client (any browser, any
  // machine) created or updated a chat in this scope. Reconcile
  // our tab list so the row shows up (or its title catches up to
  // a remote rename). Filter on scope so unrelated chats in
  // other projects don't trigger a refresh.
  useSyncSubscription((frame) => {
    if (frame.kind !== "chat_created" && frame.kind !== "chat_updated") return;
    if (frame.project_id !== state.selectedProjectId) return;
    if ((frame.worktree_id ?? null) !== currentWorktreeId()) return;
    void refreshScopeChats();
    // Refresh the active chat view too so a remote rename / model
    // change is reflected in the header chip.
    if (frame.kind === "chat_updated" && frame.chat_id === activeId()) {
      void loadChat();
    }
  });

  // Reload the open chat whenever the active chat id changes.
  // Also restore that chat's persisted composer draft (or clear the
  // input if it has none) so unsent text follows the chat the user
  // expects to find it in.
  createEffect(() => {
    const id = activeId();
    void loadChat();
    setInput(id ? getChatDraft(id) : "");
  });

  // Maintain the global busyChats signal so the TabStrip (and any
  // other global UI) can show which chats have an in-flight turn —
  // even when the user is viewing a different tab. Without this,
  // switching away from a chat during a long silent turn makes it
  // look like nothing is happening.
  createEffect(() => {
    const id = activeId();
    const busy = isStreaming();
    if (!id) return;
    setBusyChats((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
    onCleanup(() => {
      setBusyChats((prev) => {
        const next = new Set(prev);
        next.delete(id!);
        return next;
      });
    });
  });

  // Report this chat's memory footprint to the global registry. The
  // estimate sums prompt content + per-event JSON + the per-prompt
  // live token buffer. We recompute on every store change; the work
  // is O(prompts + events), bounded by the FE store cap.
  createEffect(() => {
    let bytes = 0;
    for (const p of chatStore.prompts) {
      bytes += estimateStringBytes(p.content);
      bytes += estimateStringBytes(p.id);
      bytes += 32; // small constant for the prompt envelope
      for (const ev of p.events) {
        bytes += estimateJsonBytes(ev);
      }
    }
    for (const live of Object.values(chatStore.liveTokens)) {
      bytes += estimateStringBytes(live);
    }
    for (const live of Object.values(chatStore.liveThinking)) {
      bytes += estimateStringBytes(live);
    }
    recordMemoryUsage("chat.activeView", bytes);
  });

  /** Hand a list of File objects to the BE. Successful uploads append
   *  to the pending-uploads list (rendered as chips). Failures bubble
   *  up to the error chip. */
  async function uploadFileList(files: File[]) {
    if (files.length === 0) return;
    setErr(null);
    setUploading(true);
    try {
      const dtos = await api.uploadFiles(files);
      setUploads((cur) => [...cur, ...dtos]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        "upload failed:",
        msg,
        files.map((f) => `${f.name} (${f.type})`),
      );
      setErr(msg);
    } finally {
      setUploading(false);
    }
  }

  function removeUpload(id: string) {
    setUploads((cur) => cur.filter((u) => u.id !== id));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) void uploadFileList(files);
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setDragActive(true);
    }
  }

  function onDragLeave(e: DragEvent) {
    // Only deactivate when we leave the form entirely, not when
    // moving between its child elements.
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
      setDragActive(false);
    }
  }

  /**
   * Send the user's input. Behaviour depends on whether the agent is
   * already processing a turn for this chat:
   *
   *   - **idle** → POST /api/chats/:id/prompts (the normal dispatch).
   *     The chat goes busy until the turn finishes; the FE flips back
   *     when the response resolves.
   *   - **busy** → POST /api/chats/:id/queue (enqueue the prompt).
   *     The user sees their entry land in the Queue panel instantly.
   *     The BE will drain it when the current turn finishes (manual
   *     mode: user clicks Run next; auto mode: BE auto-drains —
   *     wiring still pending).
   *
   * Attachments are bundled into the prompt body the same way for
   * both paths; queue items carry the full body so the dispatch
   * later picks them up via the agent's Read tool.
   */
  /** Core send: optimistic-insert `body` into the timeline for chat
   *  `id`, then dispatch to the BE. Shared by the composer `send`
   *  handler and programmatic injections (e.g. the drift "pull &
   *  merge" badge). `onFail` lets the composer path restore its draft;
   *  injections pass nothing. Returns true on success. */
  async function dispatchBody(id: string, body: string, onFail?: () => void): Promise<boolean> {
    // Push an OPTIMISTIC placeholder prompt so the user's message
    // lands in the timeline instantly. We don't know yet whether
    // the BE will dispatch or queue — if it queues, we remove the
    // placeholder once the BE responds.
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    const placeholder: Prompt = {
      id: tempId,
      seq: -1,
      content: body,
      events: [],
      touched_paths: [],
      created_at: new Date().toISOString(),
    };
    setChatStore(
      produce((s) => {
        s.prompts.push(placeholder);
        if (s.prompts.length > MAX_PROMPTS_IN_VIEW) {
          s.prompts.shift();
        }
      }),
    );

    try {
      // Authoritative server decision: dispatched vs queued. No
      // FE-side race against stale busy / queue counts.
      const res = await api.sendMessage(id, body);
      if (res.kind === "dispatched") {
        // Swap placeholder for the real prompt record so live WS
        // events (keyed by the real id) light up the streaming
        // bubble.
        setChatStore(
          produce((s) => {
            const idx = s.prompts.findIndex((p) => p.id === tempId);
            if (idx >= 0) {
              s.prompts[idx] = res.prompt;
            } else {
              s.prompts.push(res.prompt);
            }
          }),
        );
      } else {
        // Queued. Drop the placeholder (the message lives in the
        // queue dock, not the timeline). Sidebar toggle state
        // remains as the user left it.
        setChatStore(
          produce((s) => {
            const idx = s.prompts.findIndex((p) => p.id === tempId);
            if (idx >= 0) s.prompts.splice(idx, 1);
          }),
        );
      }
      return true;
    } catch (e) {
      // Remove the placeholder; let the caller restore any state.
      setChatStore(
        produce((s) => {
          const idx = s.prompts.findIndex((p) => p.id === tempId);
          if (idx >= 0) s.prompts.splice(idx, 1);
        }),
      );
      onFail?.();
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function send(ev: SubmitEvent) {
    ev.preventDefault();
    const id = activeId();
    let body = input().trim();
    const atts = uploads();
    if (!id || (!body && atts.length === 0)) return;
    if (atts.length > 0) {
      const lines = atts
        .map((u) => `- ${u.path}${u.content_type ? ` (${u.content_type})` : ""}`)
        .join("\n");
      body = `${body}${body ? "\n\n" : ""}Attached files (absolute paths, read with your Read tool):\n${lines}`;
    }

    // OPTIMISTIC CLEAR: drop the text + attachments out of the
    // composer the instant the user hits Enter, BEFORE we await the
    // BE call. Otherwise the textarea stays full while the request
    // round-trips, which looks broken to the user. We snapshot the
    // pre-cleared state so a failure can restore it.
    const snapshot = { body, uploads: atts };
    setInput("");
    setUploads([]);
    // Drop the persisted draft for this chat — the message is now
    // in flight, no point keeping it as recoverable text.
    const chatId = activeId();
    if (chatId) setChatDraft(chatId, "");
    queueMicrotask(() => {
      composer?.setMarkdown("");
      composer?.focus();
    });

    const ok = await dispatchBody(id, body, () => {
      // Restore the composer + draft so the user can retry without
      // retyping.
      setInput(snapshot.body);
      setUploads(snapshot.uploads);
      if (chatId) setChatDraft(chatId, snapshot.body);
    });
    if (ok) {
      queueMicrotask(() => composer?.focus());
    }
  }

  // Consume programmatic message injections (e.g. the drift "pull &
  // merge" badge in the LeftRail). The badge can't send directly —
  // the target chat may not be the active scope yet, and a raw
  // api.sendMessage would skip the optimistic insert so the user
  // bubble wouldn't appear until the BE round-trips. The badge sets
  // a global signal instead; here we wait until the matching chat is
  // active, then run the same optimistic dispatch the composer uses,
  // so the bubble shows instantly.
  createEffect(() => {
    const pending = pendingChatInjection();
    if (!pending) return;
    const id = activeId();
    if (!id) return;
    // An empty chatId means "send into whichever chat becomes active
    // next" (the new-chat flow, where the id isn't known until the
    // dialog creates the chat). A concrete id must match exactly.
    if (pending.chatId && pending.chatId !== id) return;
    setPendingChatInjection(null);
    void dispatchBody(id, pending.text);
  });

  /** Cancel the in-flight agent turn. BE kills the provider
   *  subprocess + appends a synthetic `cancelled by user` error
   *  event so the prompt's history shows why the turn ended early.
   *  The chat stays put — the next message picks up the same
   *  thread (and may resume the session if the provider supports
   *  it). */
  async function stopChat() {
    const id = activeId();
    if (!id) return;
    try {
      await api.stopChat(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) {
        // 404 = no in-flight turn. If the tail prompt is still
        // stuck (0 events, no terminal), the agent crashed or
        // never ran. Force-append a synthetic error so the UI
        // unsticks and the user can send a new message.
        setChatStore(
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
        void reconcileChat();
      } else {
        setErr(msg);
      }
    }
  }

  async function revert(p: Prompt) {
    const id = activeId();
    if (!id) return;
    const ok = await confirm({
      title: `Revert prompt #${p.seq}?`,
      body: "AgentGrove will ask the assistant to undo the file changes this prompt produced. You can keep editing if it goes wrong.",
      confirmLabel: "Revert",
      testId: "confirm-revert-prompt",
    });
    if (!ok) return;
    await api.revertPrompt(id, p.id);
    await loadChat();
  }

  async function forkFromPrompt(p: Prompt) {
    const id = activeId();
    if (!id) return;
    try {
      const result = await api.forkChat(id, p.seq);
      addChatTab({ id: result.id, title: result.title });
      // Force an immediate load of the forked chat so the timeline
      // switches from the source chat to the new chat before the user
      // starts typing again.
      await loadChat();
    } catch {
      setErr("Failed to fork chat");
    }
  }

  async function resendPrompt(p: Prompt) {
    const id = activeId();
    if (!id) return;
    try {
      await api.sendMessage(id, p.content);
      await loadChat();
    } catch {
      setErr("Failed to resend message");
    }
  }

  async function retryPrompt(p: Prompt) {
    const id = activeId();
    if (!id) return;
    void p; // callback receives the prompt; retry always targets the last turn
    try {
      await api.retryChat(id);
      await loadChat();
    } catch {
      setErr("Failed to retry prompt");
    }
  }

  async function truncateFromPrompt(p: Prompt) {
    const id = activeId();
    if (!id) return;
    const ok = await confirm({
      title: `Delete from prompt #${p.seq}?`,
      body: "This will permanently remove this message and everything after it from the conversation. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      testId: "confirm-truncate-chat",
    });
    if (!ok) return;
    try {
      await api.truncateChat(id, p.seq);
      await loadChat();
    } catch {
      setErr("Failed to delete messages");
    }
  }

  const chat = createMemo(() => chatStore.view);

  /** Dropdown options for the inline composer-row model picker.
   *  Pulls the curated `models` list off the active chat's provider
   *  descriptor + decorates each entry with a hint:
   *    - aliases (no date suffix) → `→ latest`
   *    - dated releases           → `family X.Y` parsed from the id
   *
   *  Also ensures the chat's currently-selected model is present in
   *  the list even if the provider doesn't expose it in its curated
   *  set (e.g. a power-user picked a custom id via the settings
   *  dialog). Without this safeguard the Select would render the
   *  trigger blank because none of its options match `value`. */
  const modelOptions = createMemo(() => {
    const c = chat();
    if (!c) return [];
    const provider = providers().find((p) => p.id === c.provider);
    const list = [...(provider?.models ?? [])];
    if (c.model && !list.includes(c.model)) list.push(c.model);
    const datedRe = /-(\d{8})$/;
    return list.map((m) => {
      const match = datedRe.exec(m);
      if (match) {
        const inner = m
          .replace(/^claude-/, "")
          .replace(/-\d{8}$/, "")
          .split("-");
        const family = inner.shift() ?? "";
        const version = inner.join(".");
        return {
          value: m,
          label: m,
          hint: version ? `${family} ${version}` : family,
        };
      }
      return { value: m, label: m, hint: "→ latest" };
    });
  });

  /** Persist a model change for the current chat. PATCHes the BE,
   *  then merges the updated DTO into the local chat store so the
   *  trigger label reflects the change immediately. We deliberately
   *  do NOT bounce the agent's running session — model selection
   *  applies to the next turn. */
  async function changeModel(model: string) {
    const c = chat();
    if (!c || c.model === model) return;
    try {
      const updated = await api.updateChat(c.id, { model });
      setChatStore("view", (v) => (v ? { ...v, ...updated } : v));
      setScopeChats(tabs().map((t) => (t.id === updated.id ? { ...t, title: updated.title } : t)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Load slash commands for the active chat's provider. Refreshes
  // whenever the chat (and therefore the provider) changes.
  createEffect(() => {
    const c = chat();
    if (!c) {
      setProviderCommands([]);
      return;
    }
    // Scope by active project so we pull project-level Markdown
    // commands too (`<project>/.claude/commands/*.md`).
    void api
      .listProviderCommands(c.provider, state.selectedProjectId ?? undefined)
      .then(setProviderCommands)
      .catch(() => setProviderCommands([]));
  });

  /** Combined suggestion list filtered by `slashQuery()`. Provider
   *  slash commands first, then saved prompt templates. Each entry
   *  knows how to apply itself to the textarea. */
  interface SlashSuggestion {
    key: string;
    label: string;
    hint: string;
    /** Text to insert (replaces the `/<query>` token). */
    insert: string;
    /** Description for tooltip / second line. */
    detail: string;
  }
  function suggestions(): SlashSuggestion[] {
    const q = slashQuery();
    if (q === null) return [];
    const needle = q.toLowerCase();
    const cmds: SlashSuggestion[] = providerCommands().map((c) => ({
      key: `cmd:${c.name}`,
      label: `/${c.name}`,
      hint: "command",
      insert: `/${c.name}`,
      detail: c.description,
    }));
    const prompts: SlashSuggestion[] = (state.settings.prompts ?? []).map((p) => ({
      key: `prompt:${p.id}`,
      label: p.name,
      hint: "prompt",
      insert: p.body,
      detail: p.body.split("\n")[0] ?? "",
    }));
    const all = [...cmds, ...prompts];
    if (!needle) return all.slice(0, 12);
    return all
      .filter(
        (s) => s.label.toLowerCase().includes(needle) || s.detail.toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }

  /** Apply a suggestion. We work on the serialised Markdown value
   *  rather than the editor's internal selection: the slash trigger
   *  lives at a known string position (the most recent `/` at line
   *  start), so we rewrite the document end-to-end and let the
   *  composer rebuild ProseMirror nodes. Simpler than poking the
   *  ProseMirror selection directly and avoids surprises around
   *  inline marks (e.g. the slash query landing inside a code span). */
  function applySlash(suggestion: SlashSuggestion) {
    const value = input();
    if (!value) return;
    const slashAt = value.lastIndexOf("/");
    if (slashAt < 0) return;
    const atLineStart = slashAt === 0 || value[slashAt - 1] === "\n" || value[slashAt - 1] === " ";
    if (!atLineStart) return;
    const newValue = value.slice(0, slashAt) + suggestion.insert;
    setInput(newValue);
    composer?.setMarkdown(newValue);
    composer?.focus();
    setSlashQuery(null);
    setSlashIdx(0);
  }

  /** Inspect the composer's serialised markdown and update the slash
   *  menu state. Called whenever the input value changes. We no
   *  longer have raw textarea cursor info (Tiptap owns the
   *  selection), but the trigger is "user just typed `/foo` at a
   *  line start" — easy to derive from the final character of the
   *  current markdown string. */
  function updateSlashState(md: string) {
    if (!md) {
      setSlashQuery(null);
      return;
    }
    // The user's caret is conceptually at the end of the latest
    // edit; tiptap-markdown emits the document as a single string,
    // so we use the end of the string as our reference point. This
    // is the same behaviour the old textarea path had whenever the
    // caret was at the end of the input — the most common case for
    // an in-progress slash trigger.
    const slashAt = md.lastIndexOf("/");
    if (slashAt < 0) {
      setSlashQuery(null);
      return;
    }
    const atLineStart = slashAt === 0 || md[slashAt - 1] === "\n" || md[slashAt - 1] === " ";
    if (!atLineStart) {
      setSlashQuery(null);
      return;
    }
    const token = md.slice(slashAt + 1);
    if (/\s/.test(token)) {
      setSlashQuery(null);
      return;
    }
    setSlashQuery(token);
    setSlashIdx(0);
  }

  return (
    <section data-testid="chat-pane" class="flex flex-col h-full">
      {/* Chat-specific status badges (queue + PR + error + settings).
          Title is shown in the unified TabStrip — not repeated here. */}
      <Show when={activeId() && ((queueSummary()?.total ?? 0) > 0 || err())}>
        <header
          class="h-8 px-4 flex items-center gap-1.5 border-b border-border bg-bg-1 overflow-x-auto"
          data-testid="chat-status-bar"
        >
          <Show when={activeId() && (queueSummary()?.total ?? 0) > 0}>
            <div
              class="ml-1 ag-chip flex items-center gap-1"
              classList={{
                "!border-accent": (queueSummary()?.running ?? 0) > 0,
              }}
              title={`Queue: ${queueSummary()?.pending ?? 0} pending, ${queueSummary()?.running ?? 0} running, ${queueSummary()?.total ?? 0} total`}
              data-testid="chat-queue-badge"
            >
              <span class="text-fg-subtle">⏳ queue</span>
              <span class="text-fg font-mono">{queueSummary()?.pending ?? 0}</span>
              <Show when={(queueSummary()?.running ?? 0) > 0}>
                <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              </Show>
            </div>
          </Show>
          <Show when={err()}>
            <span
              class="ml-auto text-[11.5px] text-danger"
              data-testid="chat-error"
              title={err() ?? ""}
            >
              {err()}
            </span>
          </Show>
        </header>
      </Show>

      {/*
        Chat body: a horizontal split with the timeline + composer
        on the left and the queue dock as an optional right column.
        The queue is per-chat (the BE stores mode + items keyed by
        chatId) so docking it inside this pane matches its scope.
        `min-h-0` on the row + `min-w-0` on the left column let the
        timeline shrink horizontally when the dock opens; without
        them the textarea pushes the row wider than the pane.
      */}
      <div class="flex-1 flex min-h-0">
        <div class="flex-1 flex flex-col min-w-0">
          <Show
            when={activeId()}
            fallback={
              <div class="flex-1 flex items-center justify-center text-[13px] text-fg-subtle px-6 text-center">
                <Show
                  when={tabs().length === 0 && state.selectedProjectId}
                  fallback={<span>Select a project from the left to get started.</span>}
                >
                  <span>
                    No chat open. Click <span class="ag-kbd">+ chat</span> in the left rail to start
                    a conversation.
                  </span>
                </Show>
              </div>
            }
          >
            <VirtualizedTimeline
              prompts={chatStore.prompts}
              liveTokens={chatStore.liveTokens}
              liveThinking={chatStore.liveThinking}
              atStart={chatStore.atStart}
              loadingOlder={chatStore.loadingOlder}
              onLoadOlder={() => void loadOlder()}
              onRevert={(p) => void revert(p)}
              onFork={(p) => void forkFromPrompt(p)}
              onResend={(p) => void resendPrompt(p)}
              onRetry={(p) => void retryPrompt(p)}
              onTruncate={(p) => void truncateFromPrompt(p)}
            />
          </Show>

          {/* Inline queue: pending messages line up at the bottom of the
              timeline, just above the composer. Editable until the agent
              is busy (then the whole queue is locked). */}
          <Show when={activeId()}>
            <QueueTimeline
              items={queueItems()}
              mode={queueMode()}
              busy={queueBusy()}
              locked={queueLocked()}
              expanded={queueExpanded()}
              onToggleExpanded={toggleQueueExpanded}
              onCancel={(item) => void cancelQueueItem(item)}
              onUpdate={(item, body) => void updateQueueItem(item, body)}
              onRunNext={() => void runNextQueue()}
              onSetMode={(m) => void setQueueMode(m)}
              onItemEditing={onQueueItemEditing}
            />
          </Show>

          {/* Composer renders ONLY when there's an active chat — the
          outer <Show when={activeId()}> on the timeline above already
          handles the empty-state for the whole body. This inner Show
          is kept as a SECOND gate so the composer form has its own
          mount/unmount lifecycle (the chat-input Tiptap editor is
          expensive to keep alive when no chat is selected). */}
          <Show
            when={activeId()}
            fallback={
              <div
                class="px-4 py-4 border-t border-border bg-bg-1 text-center text-[12.5px] text-fg-subtle"
                data-testid="chat-empty-composer"
              >
                <Show
                  when={state.selectedProjectId}
                  fallback={<span>Select a project on the left to start chatting.</span>}
                >
                  <span>Open or create a chat in the left rail to start messaging.</span>
                </Show>
              </div>
            }
          >
            <form
              onSubmit={send}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              class="px-4 py-3 border-t border-border bg-bg-1 flex flex-col gap-2 relative"
              classList={{ "ring-2 ring-accent ring-inset": dragActive() }}
              data-testid="chat-input-form"
            >
              <Show when={dragActive()}>
                <div
                  class="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-2/80 backdrop-blur-sm text-[13px] text-fg"
                  data-testid="chat-drop-overlay"
                >
                  Drop files to attach
                </div>
              </Show>
              <Show when={uploads().length > 0 || uploading()}>
                <div class="flex flex-wrap gap-1.5" data-testid="chat-uploads">
                  <For each={uploads()}>
                    {(u) => (
                      <span
                        class="ag-chip font-mono text-[11.5px] flex items-center gap-1"
                        title={`${u.path} · ${fmtBytes(u.size)}`}
                        data-testid={`chat-upload-${u.id}`}
                      >
                        <Show
                          when={u.content_type.startsWith("image/")}
                          fallback={<span class="text-fg-subtle">📎</span>}
                        >
                          <img
                            src={api.uploadRawUrl(u.id)}
                            alt={u.filename}
                            class="w-4 h-4 rounded-sm object-cover"
                          />
                        </Show>
                        <span class="truncate max-w-[160px]">{u.filename}</span>
                        <button
                          type="button"
                          class="text-fg-subtle hover:text-danger"
                          onClick={() => removeUpload(u.id)}
                          aria-label={`Remove ${u.filename}`}
                        >
                          ✕
                        </button>
                      </span>
                    )}
                  </For>
                  <Show when={uploading()}>
                    <span class="ag-chip text-[11.5px] text-fg-subtle italic">Uploading…</span>
                  </Show>
                </div>
              </Show>
              {/*
          Unified input shell — borders + focus ring live on the
          OUTER container so the textarea, the action icons, and the
          Send button read as a single surface (closer to ChatGPT /
          VSCode's chat composer). Layout:

            ┌──┬─────────────────────────────────┐
            │📎│ textarea (border-less, grows)   │
            │✨│                                  │
            │  │                          [Send] │
            └──┴─────────────────────────────────┘

          The icon column on the left stacks attach + prompts
          vertically (so the previously-empty vertical band gets
          filled), and Send floats in the bottom-right corner over the
          textarea via absolute positioning. We pin it to the bottom
          rather than the top so it stays close to where the caret is
          when the user is finishing a message.
        */}
              {/*
          Composer shell — single bordered surface laid out top→bottom:
            ┌──────────────────────────────────────────────────┐
            │ textarea (border-less, full width, grows up to   │
            │           max-h-60)                              │
            │                                                  │
            ├──────────────────────────────────────────────────┤
            │ 📎  ✨                                       [↑] │  ← action row
            └──────────────────────────────────────────────────┘
          The earlier left-gutter design left a tall vertical band of
          empty space next to short messages. Moving the action icons
          underneath the textarea matches Antigravity/ChatGPT and
          removes the dead space entirely. SlashMenu still positions
          itself above the textarea via its own absolute layer.
        */}
              <div
                class="ag-chat-input-shell flex flex-col rounded-lg border border-border bg-bg-0 shadow-sm relative"
                classList={{ "opacity-60": !activeId() }}
              >
                <SlashMenu
                  query={slashQuery()}
                  suggestions={suggestions()}
                  activeIdx={slashIdx()}
                  onPick={applySlash}
                  onHoverIdx={setSlashIdx}
                />
                <ChatComposer
                  value={input()}
                  onChange={(md) => {
                    setInput(md);
                    updateSlashState(md);
                    // Persist as a per-chat draft so switching scope /
                    // reloading the page doesn't drop the unsent text.
                    const id = activeId();
                    if (id) setChatDraft(id, md);
                  }}
                  onSubmit={() => {
                    // Find the surrounding form + submit it (preserves the
                    // existing chat-input-form handler chain).
                    const form = document.querySelector<HTMLFormElement>(
                      '[data-testid="chat-input-form"]',
                    );
                    form?.requestSubmit();
                    queueMicrotask(() => composer?.focus());
                  }}
                  onPasteFiles={(files) => void uploadFileList(files)}
                  onKey={(e) => {
                    // Slash menu navigation steals priority while open.
                    if (slashQuery() !== null) {
                      const list = suggestions();
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        if (list.length > 0) {
                          setSlashIdx((i) => (i + 1) % list.length);
                        }
                        return true;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        if (list.length > 0) {
                          setSlashIdx((i) => (i - 1 + list.length) % list.length);
                        }
                        return true;
                      }
                      if ((e.key === "Enter" || e.key === "Tab") && list.length > 0) {
                        e.preventDefault();
                        applySlash(list[slashIdx()] ?? list[0]!);
                        return true;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSlashQuery(null);
                        return true;
                      }
                    }
                    return false;
                  }}
                  disabled={!activeId()}
                  placeholder="Message the agent…  ⏎ send · ⇧⏎ newline · / commands"
                  ref={(h) => (composer = h)}
                  testId="chat-input"
                />

                {/* Bottom action row. Icons left, Send right. No divider
              between the textarea and this row — the reference design
              treats the whole shell as one surface, so a visible
              border line just split the composer in two. The slight
              `pt-0` keeps icons hugging the textarea without leaving
              an awkward gap. */}
                <div class="flex items-center gap-1 px-2 pt-0 pb-1.5">
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost ag-btn-icon"
                    title="Attach files"
                    aria-label="Attach files"
                    data-testid="chat-attach"
                    onClick={(e) => {
                      const input = (e.currentTarget as HTMLButtonElement)
                        .nextElementSibling as HTMLInputElement | null;
                      input?.click();
                    }}
                  >
                    <PaperclipIcon />
                  </button>
                  <input
                    type="file"
                    multiple
                    class="hidden"
                    data-testid="chat-attach-input"
                    onChange={(e) => {
                      const files = Array.from(e.currentTarget.files ?? []);
                      e.currentTarget.value = "";
                      if (files.length > 0) void uploadFileList(files);
                    }}
                  />
                  <PromptsPicker
                    onInsert={(body) => {
                      composer?.insertAtCursor(body);
                      composer?.focus();
                    }}
                  />

                  {/*
              Inline model picker. We render it next to the other
              composer-row controls so the user can switch models
              without opening the per-chat Settings dialog (which
              still hosts thinking-effort and slash commands).

              Layout notes:
                - Wrapper is `relative` + has a fixed width so the
                  trigger doesn't stretch the action row when the
                  selected label is long.
                - `placement="top"` makes the dropdown open ABOVE
                  the composer, avoiding the bug where the menu
                  pushed the input upwards because it grew the row.
                - We hide the picker entirely when no chat is
                  active or providers haven't loaded yet, instead of
                  rendering a disabled trigger that would look like
                  a layout glitch.
            */}
                  <Show when={chat() && modelOptions().length > 0}>
                    <div
                      class="w-44 text-[11.5px]"
                      title="Model — switch on the fly"
                      data-testid="chat-model-picker"
                    >
                      <Select
                        value={chat()!.model}
                        options={modelOptions()}
                        onChange={(v) => void changeModel(v)}
                        ariaLabel="Model"
                        placement="top"
                        testId="chat-model-select"
                      />
                    </div>
                  </Show>

                  <Show
                    when={isStreaming()}
                    fallback={
                      <button
                        type="submit"
                        class="ag-btn ag-btn-primary ml-auto !py-1 !px-2.5 text-[12px]"
                        disabled={!activeId() || (!input().trim() && uploads().length === 0)}
                        // Always "Send" while idle. The send handler routes
                        // idle messages to the dispatch path and busy ones
                        // to the queue path automatically; queue mode
                        // defaults to auto, so the BE drains messages
                        // back-to-back. We swap to a Stop button (below)
                        // while the agent is mid-turn.
                        title="Send to the agent"
                        data-testid="chat-send"
                      >
                        Send
                        <span class="ag-kbd !bg-transparent !border-transparent text-[var(--ag-accent-fg)] opacity-80 ml-1">
                          ⏎
                        </span>
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="ag-btn ag-btn-danger ml-auto !py-1 !px-2.5 text-[12px]"
                      onClick={() => void stopChat()}
                      title="Stop the agent. The chat keeps its history; you can send the next message right after."
                      data-testid="chat-stop"
                    >
                      ✕ Stop
                    </button>
                  </Show>
                </div>
              </div>
            </form>
          </Show>
        </div>
      </div>

      <Show when={chatSettingsOpen() && chat()}>
        <ChatSettingsDialog
          chat={chat()!}
          onClose={() => setChatSettingsOpen(false)}
          onUpdated={(updated) => {
            // Refresh the chat-level view + tab title in case it
            // changed indirectly.
            setChatStore("view", (v) => (v ? { ...v, ...updated } : v));
            setScopeChats(
              tabs().map((t) => (t.id === updated.id ? { ...t, title: updated.title } : t)),
            );
          }}
          onInsertCommand={(cmd) => {
            composer?.insertAtCursor(`/${cmd}`);
            composer?.focus();
            setChatSettingsOpen(false);
          }}
        />
      </Show>
    </section>
  );
}

/** Windowed timeline rendered through `@tanstack/solid-virtual`. Only
 *  rows in the viewport (plus a small overscan) are mounted into the
 *  DOM, keeping the tab memory budget under control even for chats
 *  with thousands of prompts. See ADR-0006.
 *
 *  Each row's height is measured on first layout and cached by the
 *  virtualizer's `measureElement` so variable-length user / assistant
 *  bubbles size correctly. */
function VirtualizedTimeline(props: {
  prompts: Prompt[];
  liveTokens: Record<string, string>;
  liveThinking: Record<string, string>;
  atStart: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRevert: (p: Prompt) => void;
  onFork: (p: Prompt) => void;
  onResend: (p: Prompt) => void;
  onRetry: (p: Prompt) => void;
  onTruncate: (p: Prompt) => void;
}) {
  let scrollRef!: HTMLDivElement;
  let contentRef!: HTMLDivElement;
  let prevLength = 0;
  let prevFirstId: string | undefined = undefined;
  const BOTTOM_THRESHOLD_PX = 10;

  // Last user-controlled scroll position. `null` means we haven't seen a
  // user scroll yet (initial load / chat switch) so we should land on the
  // bottom instead of restoring a stale position.
  let userScrollTop: number | null = null;
  let userAtBottom = true;
  let lastContentHeight = 0;

  const virtualizer = createVirtualizer({
    get count() {
      return props.prompts.length;
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 120,
    overscan: 6,
    // Use prompt id as the key when in bounds; the virtualizer may
    // call this with a stale index briefly after a refresh shrinks
    // the array, so fall back to the index to avoid a TypeError.
    getItemKey: (i) => props.prompts[i]?.id ?? i,
  });

  const virtualItems = createMemo(() => {
    // Track both the source count and the virtualizer total size so
    // this memo re-runs whenever the virtual window is recomputed.
    void props.prompts.length;
    void props.prompts.map((p) => p.id).join(",");
    void virtualizer.getTotalSize();
    return virtualizer.getVirtualItems().map((vi) => ({
      index: vi.index,
      key: vi.key,
      start: vi.start,
      end: vi.end,
      size: vi.size,
    }));
  });

  /** Height of the un-rendered prefix in pixels. The first virtual
   *  item's `start` happens to be exactly that height since
   *  measurements are cumulative from index 0. */
  const topSpacer = () => virtualItems()[0]?.start ?? 0;
  /** Height of the un-rendered suffix in pixels: total - (last
   *  rendered item's end). */
  const bottomSpacer = () => {
    const items = virtualItems();
    const total = virtualizer.getTotalSize();
    const last = items[items.length - 1];
    if (!last) return 0;
    return Math.max(0, total - (last.start + last.size));
  };

  // Auto-scroll behaviour:
  //   - On the FIRST render with a non-empty prompt list (chat
  //     switch, page refresh, etc.) jump straight to the bottom so
  //     the user lands on the most recent turn.
  //   - On tail growth (new user message or assistant reply), keep
  //     the scroll at the bottom ONLY if the user was already at
  //     the bottom. Otherwise we do not touch the scroll position.
  //   - On backfill of OLDER prompts we restore the user's reading
  //     position relative to the first visible row.
  //
  // Scroll intent is enforced by a ResizeObserver on the content
  // wrapper: whenever the content height changes, we apply the
  // simple rule above. This counteracts browser/scroll-anchoring
  // behaviour that would otherwise move the viewport when content
  // grows at the tail while the user is reviewing history.

  function scrollToBottom() {
    const len = props.prompts.length;
    if (len === 0) return;
    markProgrammatic(400);
    virtualizer.scrollToIndex(len - 1, { align: "end" });
  }

  /** Programmatic-scroll guard. Chrome reports scroll events caused by
   *  OUR scrollTop writes (scrollToIndex, anchor restores) as trusted,
   *  so `onScroll` was recording them as user intent — on chat switch
   *  the intermediate positions during measurement settling became the
   *  "user position" and the ResizeObserver kept restoring the wrong
   *  spot (the "scroll jumps around" bug). While this window is active
   *  and no real wheel gesture is in flight, onScroll ignores events. */
  let programmaticUntil = 0;
  function markProgrammatic(ms = 250) {
    programmaticUntil = Date.now() + ms;
  }

  /** Apply the user's scroll rule: if we haven't established a user
   *  position yet, or the user is already at the bottom, jump to the
   *  bottom. Otherwise restore the last user scroll position. */
  function enforceScrollRule() {
    if (!scrollRef || scrollRef.clientHeight === 0) return;
    if (userScrollTop === null || userAtBottom) {
      scrollToBottom();
    } else {
      markProgrammatic();
      scrollRef.scrollTop = userScrollTop;
    }
  }

  createEffect(() => {
    const ps = props.prompts;
    const len = ps.length;
    const firstId = ps[0]?.id;

    // First non-empty load or chat switch: forget any user scroll position
    // and land on the bottom. The ResizeObserver will also enforce this when
    // the content height settles.
    if (prevLength === 0 && len > 0) {
      userScrollTop = null;
      userAtBottom = true;
      // eslint-disable-next-line solid/reactivity
      queueMicrotask(() => enforceScrollRule());
    } else if (firstId !== prevFirstId && len > 0 && prevLength > 0) {
      const isBackfill = prevFirstId !== undefined && ps.some((p) => p.id === prevFirstId);
      if (!isBackfill) {
        userScrollTop = null;
        userAtBottom = true;
        // eslint-disable-next-line solid/reactivity
        queueMicrotask(() => enforceScrollRule());
      }
    } else if (len > prevLength && firstId === prevFirstId) {
      // Tail growth in an already-mounted chat: open the enforcement window
      // *before* the DOM mutates so the browser's layout-induced scroll is not
      // recorded as a user gesture. The observers below will enforce the rule.
      contentChangedUntil = Date.now() + 300;
    }
    prevLength = len;
    prevFirstId = firstId;
  });

  // Used to ignore scroll events triggered by our own scroll restoration
  // (or the browser's immediate follow-up scroll anchoring) so they don't
  // overwrite the user-controlled scroll position. We re-apply the rule for
  // a short window because the browser sometimes animates the scroll after a
  // content height change. Large height changes (new prompt) need a longer
  // window than small live-token growth.
  const LARGE_CHANGE_THRESHOLD_PX = 100;
  let contentChangedAt = 0;
  let contentChangedUntil = 0;

  function scheduleEnforceLoop(windowMs: number) {
    contentChangedAt = Date.now();
    contentChangedUntil = contentChangedAt + windowMs;
    const end = contentChangedUntil;
    const step = () => {
      if (Date.now() > end) return;
      enforceScrollRule();
      requestAnimationFrame(step);
    };
    step();
  }

  // ResizeObserver on the content wrapper: whenever the rendered
  // content changes height (new prompts, streaming tokens, row
  // measurements) we enforce the scroll rule. This is what makes
  // "don't touch the scroll when the user is scrolled up" actually
  // stick, because the browser/scroll-anchoring sometimes moves the
  // viewport when the content grows at the tail.
  onMount(() => {
    if (!contentRef) return;

    // MutationObserver fires synchronously after DOM mutations, before the
    // browser has a chance to apply its own scroll-anchoring / auto-scroll.
    // We snap the scroll position back to the user's reading position here.
    // eslint-disable-next-line solid/reactivity
    const mo = new window.MutationObserver(() => {
      if (!scrollRef || scrollRef.clientHeight === 0) return;
      if (preserveAnchor) return; // backfill effect handles this
      // Block onScroll from treating the browser's layout-induced scroll as a
      // user gesture. The ResizeObserver below will replace this with a shorter,
      // size-based enforcement window.
      contentChangedUntil = Date.now() + 300;
      if (userScrollTop === null || userAtBottom) {
        scrollToBottom();
      } else {
        markProgrammatic();
        scrollRef.scrollTop = userScrollTop;
      }
    });
    mo.observe(contentRef, { childList: true, subtree: true });

    const ro = new ResizeObserver(() => {
      if (!scrollRef || scrollRef.clientHeight === 0) return;
      if (preserveAnchor) return; // backfill effect handles this
      const h = scrollRef.scrollHeight;
      const delta = Math.abs(h - lastContentHeight);
      if (h === lastContentHeight) return;
      lastContentHeight = h;
      wheelActive = false;
      if (wheelTimeout) clearTimeout(wheelTimeout);
      if (userScrollTop === null) {
        scrollToBottom();
        return;
      }
      // Large changes (new prompts) can trigger a delayed browser auto-scroll,
      // so we enforce for longer. Small changes (live tokens) only need a
      // brief window.
      const windowMs = delta > LARGE_CHANGE_THRESHOLD_PX ? 200 : 100;
      scheduleEnforceLoop(windowMs);
    });
    ro.observe(contentRef);
    onCleanup(() => {
      mo.disconnect();
      ro.disconnect();
    });
  });

  // Live token / thinking deltas grow the active prompt's bubble —
  // tell the virtualizer to re-measure so the row height stays in
  // sync. Also re-measure when any prompt's event content changes
  // (streamed tokens often arrive via reconcile, not live maps).
  // The ResizeObserver on the content wrapper will enforce the scroll
  // rule after the measurement updates.
  createEffect(() => {
    void Object.keys(props.liveTokens).length;
    void Object.values(props.liveTokens).reduce((n, s) => n + s.length, 0);
    void Object.keys(props.liveThinking).length;
    void Object.values(props.liveThinking).reduce((n, s) => n + s.length, 0);
    // Serialise the full prompts array so the effect re-runs on ANY
    // change — new prompts, appended events, or live map updates
    // that were reconciled into the canonical events array.
    for (const p of props.prompts) void p.events.length;
    virtualizer.measure();
  });

  // Reverse lazy loading: when the user scrolls within
  // SCROLL_TRIGGER_PX of the top AND there are older prompts the
  // BE knows about, kick `onLoadOlder()` automatically. We snapshot
  // the scroll height + offset BEFORE the backfill lands so we can
  // restore the user's reading position once new rows prepend
  // (otherwise the new rows would push everything down and the
  // user would lose their place).
  const SCROLL_TRIGGER_PX = 200;
  let preserveAnchor: { scrollTop: number; scrollHeight: number } | null = null;

  let wheelActive = false;
  let wheelTimeout: ReturnType<typeof setTimeout> | null = null;

  function onWheel(event: Event) {
    if (!scrollRef) return;
    const deltaY = (event as unknown as { deltaY: number }).deltaY;
    wheelActive = true;
    if (wheelTimeout) clearTimeout(wheelTimeout);
    wheelTimeout = setTimeout(() => {
      wheelActive = false;
    }, 300);
    const maxScrollTop = scrollRef.scrollHeight - scrollRef.clientHeight;
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, scrollRef.scrollTop + deltaY));
    userAtBottom =
      scrollRef.scrollHeight - nextScrollTop - scrollRef.clientHeight <= BOTTOM_THRESHOLD_PX;
    userScrollTop = userAtBottom ? null : nextScrollTop;
  }

  function onScroll(event: Event) {
    if (!scrollRef) return;
    if (Date.now() < programmaticUntil && !wheelActive) return;
    if (Date.now() < contentChangedUntil && !wheelActive) return;
    if (event.isTrusted || wheelActive) {
      const distance = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
      userAtBottom = distance <= BOTTOM_THRESHOLD_PX;
      userScrollTop = userAtBottom ? null : scrollRef.scrollTop;
    }
    if (props.atStart || props.loadingOlder || preserveAnchor) return;
    if (scrollRef.scrollTop < SCROLL_TRIGGER_PX) {
      preserveAnchor = {
        scrollTop: scrollRef.scrollTop,
        scrollHeight: scrollRef.scrollHeight,
      };
      props.onLoadOlder();
    }
  }

  // After a successful backfill the older prompts prepend at the
  // top; restore the user's scroll position relative to the FIRST
  // visible row by adding the delta-in-content-height to the prior
  // scrollTop. Triggered by `prompts.length` growing while
  // `firstId` changed.
  createEffect(() => {
    void props.prompts.length;
    if (!preserveAnchor || !scrollRef) return;
    queueMicrotask(() => {
      if (!scrollRef || !preserveAnchor) return;
      const delta = scrollRef.scrollHeight - preserveAnchor.scrollHeight;
      if (delta > 0) {
        markProgrammatic();
        scrollRef.scrollTop = preserveAnchor.scrollTop + delta;
      }
      preserveAnchor = null;
      // Update the tracked user position so the ResizeObserver doesn't
      // fight the restored anchor.
      userScrollTop = scrollRef.scrollTop;
      userAtBottom =
        scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight <=
        BOTTOM_THRESHOLD_PX;
    });
  });

  return (
    <div
      ref={(el) => (scrollRef = el)}
      class="flex-1 overflow-y-auto px-6"
      style={{ "overflow-anchor": "none" }}
      onScroll={onScroll}
      onWheel={onWheel}
      data-testid="chat-timeline"
    >
      <Show when={!props.atStart && props.prompts.length > 0}>
        <div class="flex justify-center pt-4 pb-2" data-testid="chat-older-indicator">
          <Show
            when={props.loadingOlder}
            fallback={
              <span class="text-[11.5px] text-fg-subtle">Scroll up to load older messages</span>
            }
          >
            <span class="text-[11.5px] text-fg-subtle inline-flex items-center gap-2">
              <span class="inline-flex gap-0.5">
                <span
                  class="w-1 h-1 rounded-full bg-fg-subtle animate-pulse"
                  style={{ "animation-delay": "0ms" }}
                />
                <span
                  class="w-1 h-1 rounded-full bg-fg-subtle animate-pulse"
                  style={{ "animation-delay": "150ms" }}
                />
                <span
                  class="w-1 h-1 rounded-full bg-fg-subtle animate-pulse"
                  style={{ "animation-delay": "300ms" }}
                />
              </span>
              Loading older…
            </span>
          </Show>
        </div>
      </Show>
      {/* Flow-layout windowed render.
       *
       * We previously used the virtualizer's transform-positioned
       * absolute layout, but variable-height bubbles (assistant
       * replies grow as tokens stream in) consistently failed to
       * re-measure correctly in our usage — items overlapped at
       * the estimated stride.
       *
       * For the chat use case (modest counts; growing bubbles) the
       * windowed-but-naturally-stacked approach is much more
       * robust: we still mount only the visible-plus-overscan
       * window via virtualizer.getVirtualItems(), but each row is
       * `position: static`, so the browser handles the layout
       * arithmetic that the virtualizer's estimateSize struggles
       * with.
       *
       * Top/bottom padding spacers fake the height of the
       * un-rendered prefix / suffix so the scrollbar stays
       * proportional. */}
      <div ref={(el) => (contentRef = el)} style={{ width: "100%" }}>
        <div style={{ height: `${topSpacer()}px` }} aria-hidden="true" />
        <For each={virtualItems()}>
          {(vi) => {
            const prompt = () => props.prompts[vi.index];
            return (
              <Show when={prompt()}>
                <div
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  style={{ width: "100%" }}
                >
                  <PromptRow
                    prompt={prompt()!}
                    liveTokens={props.liveTokens}
                    liveThinking={props.liveThinking}
                    isLast={vi.index === props.prompts.length - 1}
                    onRevert={() => props.onRevert(prompt()!)}
                    onFork={() => props.onFork(prompt()!)}
                    onResend={() => props.onResend(prompt()!)}
                    onRetry={() => props.onRetry(prompt()!)}
                    onTruncate={() => props.onTruncate(prompt()!)}
                  />
                </div>
              </Show>
            );
          }}
        </For>
        <div style={{ height: `${bottomSpacer()}px` }} aria-hidden="true" />
      </div>
    </div>
  );
}

/** A single prompt row: user bubble + assistant bubble + footer.
 *  Pulled out so the virtualizer can measure / remount independently. */
function PromptRow(props: {
  prompt: Prompt;
  liveTokens: Record<string, string>;
  liveThinking: Record<string, string>;
  isLast: boolean;
  onRevert: () => void;
  onFork: () => void;
  onResend: () => void;
  onRetry: () => void;
  onTruncate: () => void;
}) {
  function assistantText(): string {
    const live = props.liveTokens[props.prompt.id];
    if (live !== undefined) return live;
    let out = "";
    for (const ev of props.prompt.events) {
      if (ev.type === "token") out += ev.text;
    }
    return out;
  }

  /** Concatenate the model's thinking trace (extended-thinking
   *  output). Prefers the in-flight live buffer over walking the
   *  events array. Returns the empty string when the model wasn't
   *  asked to think (or doesn't support it). */
  function thinkingText(): string {
    const live = props.liveThinking[props.prompt.id];
    if (live !== undefined) return live;
    let out = "";
    for (const ev of props.prompt.events) {
      if (ev.type === "thinking") out += ev.text;
    }
    return out;
  }

  function tools(): AgentEvent[] {
    return props.prompt.events.filter(
      (e) =>
        e.type === "tool_call" ||
        e.type === "tool_result" ||
        e.type === "error" ||
        e.type === "truncated",
    );
  }

  /** Error events emitted by the provider (rate limits, spawn failures,
   *  cancellations, …). Shown prominently in the assistant bubble so the
   *  user isn't left staring at a blank turn or a collapsed internals panel. */
  function errorMessages(): string[] {
    return props.prompt.events.filter((e) => e.type === "error").map((e) => e.message);
  }

  /** True while the agent hasn't yet finished this prompt. Used to
   *  show a placeholder assistant bubble (with a pulsing dots
   *  affordance) before the first token arrives. */
  function isPending(): boolean {
    if (
      props.liveTokens[props.prompt.id] !== undefined ||
      props.liveThinking[props.prompt.id] !== undefined
    ) {
      return true;
    }
    const evs = props.prompt.events;
    if (evs.length === 0) return true;
    const last = evs[evs.length - 1]!;
    return last.type !== "done" && last.type !== "error";
  }

  // Very long user messages (e.g. a pasted transcript) would otherwise
  // render as one giant bubble that fills the whole timeline. Collapse
  // them to a capped height with a "Show more" toggle. We gate on a
  // simple length heuristic so normal messages are never affected.
  const userIsLong = () => {
    const c = props.prompt.content ?? "";
    return c.length > 1200 || c.split("\n").length > 16;
  };
  const [userExpanded, setUserExpanded] = createSignal(false);

  // ---- "working…" liveliness while we wait for output ----
  // While a prompt is pending and no assistant text has streamed yet,
  // we run a little timer so the wait feels alive (a cycling status
  // phrase + an elapsed counter). It also lets us tell the user when a
  // model isn't streaming: if several seconds pass with zero tokens,
  // the model is almost certainly returning the whole reply at once, so
  // we surface a friendly note instead of leaving them guessing.
  const [elapsed, setElapsed] = createSignal(0);

  // Internals (thinking + tools) start open while the turn is in
  // flight so the user can watch the agent work, then auto-collapse
  // once the final response arrives. `autoClosedInternals` tracks the
  // one-time auto-close so user re-opens aren't repeatedly closed.
  //
  // The state is also reset when the prompt instance changes so that
  // virtualizer recycling doesn't leak the open/closed state from one
  // row to another.
  let autoClosedInternals = false;
  const [internalsOpen, setInternalsOpen] = createSignal(isPending());

  createEffect(() => {
    if (!isPending() && !autoClosedInternals) {
      setInternalsOpen(false);
      autoClosedInternals = true;
    }
  });

  // Reset internals state when the virtualizer recycles this row for a
  // different prompt; otherwise the previous row's toggle state leaks.
  createEffect(() => {
    void props.prompt.id;
    setInternalsOpen(isPending());
    autoClosedInternals = false;
  });

  function onToggleInternals(e: Event & { currentTarget: { open: boolean } }) {
    if (e.isTrusted) autoClosedInternals = true;
    setInternalsOpen(e.currentTarget.open);
  }

  const waiting = () => isPending() && !assistantText() && !thinkingText();
  createEffect(() => {
    if (!waiting()) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const h = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    onCleanup(() => clearInterval(h));
  });
  // Cycle a playful status phrase every ~1.8s so the indicator reads as
  // live even when the backend is silent (non-streaming models).
  const WORK_PHRASES = [
    "thinking",
    "consulting the model",
    "drafting a response",
    "connecting the dots",
    "almost there",
  ];
  const phrase = () => WORK_PHRASES[Math.floor(elapsed() / 2) % WORK_PHRASES.length]!;
  // After this many seconds with no streamed text, assume the model
  // delivers its answer in one shot (no live token stream).
  const NONSTREAM_AFTER = 3;
  const looksNonStreaming = () => waiting() && elapsed() >= NONSTREAM_AFTER;

  // Format prompt creation time as a compact date+time string.
  const formatTime = (dateString: string) => {
    const d = new Date(dateString);
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <article class="space-y-3 group py-4" data-testid={`prompt-${props.prompt.id}`}>
      {/*
        User bubble. Wrapped in a `group/bubble` so the copy button
        only reveals on hover of THIS bubble, not the whole row
        (otherwise hovering anywhere in the row — including the
        assistant bubble — would reveal both copy buttons at once
        and confuse the user about which one they're about to
        click).
      */}
      <div class="flex justify-end">
        <div class="relative group/bubble max-w-[80%]">
          <div
            class="rounded-2xl rounded-br-md bg-accent text-[var(--ag-accent-fg)] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] shadow-sm overflow-y-auto"
            classList={{
              // Cap the height of long messages so a pasted transcript
              // can't take over the whole timeline; the bubble scrolls
              // internally and a toggle expands it.
              "max-h-[16rem]": userIsLong() && !userExpanded(),
            }}
            data-testid={`user-bubble-${props.prompt.id}`}
          >
            {props.prompt.content}
          </div>
          <div class="text-right mt-1 text-[10px] text-fg-subtle">
            {formatTime(props.prompt.created_at)}
          </div>
          <Show when={userIsLong()}>
            <button
              type="button"
              class="mt-1 text-[11.5px] text-accent hover:underline"
              onClick={() => setUserExpanded((v) => !v)}
              data-testid={`user-bubble-toggle-${props.prompt.id}`}
            >
              {userExpanded() ? "Show less" : "Show more"}
            </button>
          </Show>
          <CopyButton
            text={props.prompt.content}
            class="absolute -top-2 -left-2 opacity-0 group-hover/bubble:opacity-100 transition-opacity"
            testId={`copy-user-${props.prompt.id}`}
            label="Copy your message"
          />
        </div>
      </div>
      {/*
        Internals: thinking trace + tool activity. Rendered above the
        assistant bubble and collapsed automatically when the turn finishes.
      */}
      <Show when={thinkingText() || tools().length > 0}>
        <div class="flex justify-start">
          <details
            class="w-full rounded-xl bg-bg-2/40 border border-dashed border-border text-[12.5px] px-3 py-2 text-fg-muted"
            data-testid={`internals-${props.prompt.id}`}
            open={internalsOpen()}
            onToggle={onToggleInternals}
          >
            <summary class="cursor-pointer select-none text-[11.5px] uppercase tracking-wide text-fg-subtle">
              ✦ Internals
              <Show when={thinkingText()}>
                <span class="text-fg-subtle"> · Thinking {fmtBytes(thinkingText().length)}</span>
              </Show>
              <Show when={tools().length > 0}>
                <span class="text-fg-subtle">
                  {" "}
                  · {tools().length} tool{tools().length === 1 ? "" : "s"}
                </span>
              </Show>
            </summary>
            <div class="mt-2 space-y-3">
              <Show when={thinkingText()}>
                <div class="ag-prose">
                  <Markdown source={thinkingText()} />
                </div>
              </Show>
              <Show when={tools().length > 0}>
                <ToolRail events={tools()} promptId={props.prompt.id} />
              </Show>
            </div>
          </details>
        </div>
      </Show>
      {/*
        Assistant bubble. We render it whenever:
          - the assistant has produced any text or tool activity, OR
          - the prompt is fresh (no terminal event yet) — this
            covers the optimistic-placeholder case where the user
            just hit Enter and is waiting for the first token. A
            pulsing "working…" affordance makes the wait visible
            instead of leaving the user staring at their own
            bubble wondering if anything happened.
      */}
      <Show when={assistantText() || isPending() || errorMessages().length > 0}>
        <div class="flex justify-start">
          <div class="relative group/bubble w-full">
            <div class="rounded-2xl rounded-bl-md bg-bg-1 border border-border text-[13.5px] leading-relaxed px-5 py-4 [overflow-wrap:anywhere]">
              <Show when={assistantText()}>
                <Markdown source={assistantText()} class="ag-prose-chat" />
              </Show>

              <Show when={errorMessages().length > 0}>
                <div class="space-y-2" data-testid={`assistant-error-${props.prompt.id}`}>
                  <For each={errorMessages()}>
                    {(msg) => (
                      <div class="text-[13px] text-danger flex items-start gap-2">
                        <span aria-hidden="true">⚠</span>
                        <span class="whitespace-pre-wrap">{msg}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* While the agent is still generating (no terminal
                  event), show a small inline indicator after the
                  streamed text so the user knows more is coming. */}
              <Show when={isPending() && assistantText()}>
                <span class="inline-flex items-center gap-1.5 mt-2 text-fg-subtle text-[11.5px]">
                  <span class="inline-flex gap-0.5 items-end h-2.5">
                    <span
                      class="w-1 h-1 rounded-full bg-accent/60 ag-bounce"
                      style="animation-delay:0ms"
                    />
                    <span
                      class="w-1 h-1 rounded-full bg-accent/60 ag-bounce"
                      style="animation-delay:160ms"
                    />
                    <span
                      class="w-1 h-1 rounded-full bg-accent/60 ag-bounce"
                      style="animation-delay:320ms"
                    />
                  </span>
                  <em class="ag-shimmer not-italic opacity-70">generating…</em>
                </span>
              </Show>

              <Show when={isPending() && !assistantText()}>
                <div class="flex flex-col gap-1.5" data-testid={`working-${props.prompt.id}`}>
                  <span class="flex items-center gap-2 text-fg-subtle">
                    <span class="inline-flex gap-1 items-end h-3">
                      <span
                        class="w-1.5 h-1.5 rounded-full bg-accent ag-bounce"
                        style="animation-delay:0ms"
                      />
                      <span
                        class="w-1.5 h-1.5 rounded-full bg-accent ag-bounce"
                        style="animation-delay:160ms"
                      />
                      <span
                        class="w-1.5 h-1.5 rounded-full bg-accent ag-bounce"
                        style="animation-delay:320ms"
                      />
                    </span>
                    <em class="ag-shimmer not-italic font-medium">{phrase()}…</em>
                    <Show when={elapsed() >= 1}>
                      <span class="text-[11px] tabular-nums opacity-70">{elapsed()}s</span>
                    </Show>
                  </span>
                  <span
                    class="text-[11.5px] text-fg-subtle inline-flex items-center gap-1.5 transition-opacity"
                    classList={{ "opacity-0 invisible": !looksNonStreaming() }}
                    data-testid={`nonstream-note-${props.prompt.id}`}
                  >
                    <span class="ag-chip !text-[10px] !py-[1px]">no live stream</span>
                    This model returns the full reply at once — generating it now.
                  </span>
                </div>
              </Show>
            </div>
            <div class="text-left mt-1 text-[10px] text-fg-subtle">
              {formatTime(props.prompt.created_at)}
            </div>
            {/* Only offer Copy when there's actual text to copy — a
                bubble that still shows just the "working…" pulse
                has nothing useful to put on the clipboard yet. */}
            <Show when={assistantText()}>
              <CopyButton
                text={assistantText()}
                class="absolute -top-2 -right-2 opacity-0 group-hover/bubble:opacity-100 transition-opacity"
                testId={`copy-assistant-${props.prompt.id}`}
                label="Copy AI response"
              />
            </Show>
          </div>
        </div>
      </Show>
      <div class="flex items-center gap-2 text-[11px] text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity">
        <span class="ag-chip">#{props.prompt.seq}</span>
        <button
          class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px]"
          onClick={() => props.onResend()}
          data-testid={`resend-${props.prompt.id}`}
          title="Re-send this message to the agent"
        >
          ↻ Resend
        </button>
        <Show when={props.isLast}>
          <button
            class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px]"
            onClick={() => props.onRetry()}
            data-testid={`retry-${props.prompt.id}`}
            title="Regenerate the last response"
          >
            ↺ Retry
          </button>
        </Show>
        <button
          class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px]"
          onClick={() => props.onFork()}
          data-testid={`fork-${props.prompt.id}`}
          title="Fork a new chat from this point in the conversation"
        >
          ⑂ Fork
        </button>
        <button
          class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px]"
          onClick={() => props.onRevert()}
          data-testid={`revert-${props.prompt.id}`}
          title="Ask AI to revert this prompt's changes"
        >
          ↺ Revert
        </button>
        <button
          class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px] text-danger"
          onClick={() => props.onTruncate()}
          data-testid={`truncate-${props.prompt.id}`}
          title="Delete this message and everything after it"
        >
          ✂ Delete from here
        </button>
      </div>
    </article>
  );
}

/** Render a single tool-call / tool-result / error / truncated badge. */
/**
 * Resize a textarea to fit its content up to its `max-height`. Solid
 * doesn't ship a directive for this, so we call it manually on input
 * and once after mount.
/** Floating slash-menu popover positioned above the composer.
 *  Renders matched slash-commands and saved prompts matching the
 *  user's `/<query>`. */
function SlashMenu(props: {
  query: string | null;
  suggestions: {
    key: string;
    label: string;
    hint: string;
    insert: string;
    detail: string;
  }[];
  activeIdx: number;
  onPick: (s: { key: string; label: string; hint: string; insert: string; detail: string }) => void;
  onHoverIdx: (i: number) => void;
}) {
  return (
    <Show when={props.query !== null && props.suggestions.length > 0}>
      <div
        class="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-bg-1 shadow-2xl z-30"
        data-testid="chat-slash-menu"
      >
        <For each={props.suggestions}>
          {(s, i) => (
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 flex items-baseline gap-2"
              classList={{
                "bg-bg-3": i() === props.activeIdx,
                "hover:bg-bg-2": i() !== props.activeIdx,
              }}
              onMouseEnter={() => props.onHoverIdx(i())}
              onMouseDown={(e) => {
                // Prevent textarea blur so the click lands on the
                // pick handler before our onBlur dismiss timer.
                e.preventDefault();
                props.onPick(s);
              }}
              data-testid={`chat-slash-${s.key}`}
            >
              <span class="text-[12.5px] font-mono text-fg">{s.label}</span>
              <span class="text-[10.5px] uppercase tracking-wide text-fg-subtle">{s.hint}</span>
              <span class="text-[11.5px] text-fg-subtle truncate flex-1 text-right">
                {s.detail}
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

function PromptsPicker(props: { onInsert: (body: string) => void }) {
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;

  function onDocDown(e: MouseEvent) {
    if (!open()) return;
    if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
  }
  onMount(() => document.addEventListener("mousedown", onDocDown));
  onCleanup(() => document.removeEventListener("mousedown", onDocDown));

  const prompts = () => state.settings.prompts ?? [];

  return (
    <div ref={(el) => (rootEl = el)} class="relative">
      <button
        type="button"
        class="ag-btn ag-btn-ghost ag-btn-icon"
        title={
          prompts().length > 0
            ? "Insert a saved prompt"
            : "No prompts saved yet — add some in Settings → Prompts"
        }
        aria-label="Insert prompt"
        data-testid="chat-prompts-toggle"
        onClick={() => setOpen(!open())}
      >
        <SparkleIcon />
      </button>
      <Show when={open()}>
        <div
          class="absolute bottom-full left-0 mb-2 w-72 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-1 shadow-2xl z-30"
          data-testid="chat-prompts-menu"
        >
          <div class="px-3 py-2 border-b border-border text-[11.5px] uppercase tracking-wider text-fg-subtle">
            Saved prompts
          </div>
          <Show
            when={prompts().length > 0}
            fallback={
              <p class="px-3 py-3 text-[12.5px] text-fg-subtle">
                No prompts yet. Open Settings → Prompts to add one.
              </p>
            }
          >
            <ul>
              <For each={prompts()}>
                {(p) => (
                  <li>
                    <button
                      type="button"
                      class="w-full text-left px-3 py-2 hover:bg-bg-2 border-b border-border last:border-b-0"
                      onClick={() => {
                        props.onInsert(p.body);
                        setOpen(false);
                      }}
                      data-testid={`chat-prompt-pick-${p.id}`}
                    >
                      <div class="text-[12.5px] font-medium text-fg truncate">{p.name}</div>
                      <div class="text-[11px] text-fg-subtle truncate">
                        {p.body.split("\n")[0] || "(empty)"}
                      </div>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Lucide `sparkles` — used by the prompts picker button. */
function SparkleIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6 7.7 7.7M16.3 16.3l2.1 2.1M5.6 18.4 7.7 16.3M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

/** Lucide `paperclip` — used by the chat input's attach button. */
function PaperclipIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/** Floating copy-to-clipboard button that pops over a chat bubble's
 *  corner on hover. Uses the async clipboard API with a textarea
 *  fallback for browsers that block it (rare on a localhost dev
 *  server but worth not crashing on).
 *
 *  Visual feedback: the icon swaps to a check for ~1.2 s after a
 *  successful copy so the user knows something happened — without
 *  this it was easy to double-click thinking the first one missed. */
function CopyButton(props: { text: string; class?: string; label: string; testId?: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: number | null = null;

  async function doCopy(ev: MouseEvent) {
    ev.stopPropagation();
    const payload = props.text;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        // Fallback for non-secure contexts. Solid's reactivity is
        // fine with a temporary DOM node we clean up ourselves.
        const ta = document.createElement("textarea");
        ta.value = payload;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Silent fail — the next attempt or a hard "select-all + copy"
      // is the user's escape hatch.
    }
  }

  onCleanup(() => {
    if (timer !== null) window.clearTimeout(timer);
  });

  return (
    <button
      type="button"
      class={`rounded-md border border-border bg-bg-1 text-fg-subtle hover:text-fg hover:bg-bg-2 shadow-sm p-1 ${props.class ?? ""}`}
      onClick={(e) => void doCopy(e)}
      aria-label={props.label}
      title={copied() ? "Copied!" : props.label}
      data-testid={props.testId}
    >
      <Show when={copied()} fallback={<CopyIcon />}>
        <CheckIcon />
      </Show>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="0.95em" height="0.95em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M5 15V6a2 2 0 0 1 2-2h9"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="0.95em" height="0.95em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12l5 5 9-11"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Compact byte formatter for upload chips. */
function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fixed = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(fixed)} ${units[i]}`;
}

/** Decode a WS message into a `(promptId, event)` pair, or `null` for
 *  non-event frames (e.g. the `{subscribed:topic}` hello). */
interface WsFrame {
  promptId: string;
  event: AgentEvent;
}
function parseWsFrame(raw: unknown): WsFrame | null {
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
function applyWsFrame(s: ChatStore, frame: WsFrame): void {
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
  prompt.events.push(ev);
  if (ev.type === "done" || ev.type === "error") {
    // Stream finished — drop the live buffers so PromptRow falls
    // back to the events array (canonical, persisted text).
    delete s.liveTokens[promptId];
    delete s.liveThinking[promptId];
  }
}

/** Build the WS URL for a topic. Reuses the same base URL the REST
 *  client uses so we hit the BE directly under Vite dev (5173 → 4317)
 *  and same-origin in production. */
function wsUrlFor(topic: string): string {
  const apiBase = api.baseUrl() || window.location.origin;
  const url = new URL(apiBase, window.location.origin);
  url.protocol = url.protocol.startsWith("https") ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("topic", topic);
  return url.toString();
}
