import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
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
} from "../api/client";
import { confirm } from "../components/dialog";
import Markdown from "../components/Markdown";
import {
  closeChatTab,
  currentScope,
  currentWorktreeId,
  selectedChatId,
  setActiveChat,
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
  /** True when a backfill request is in flight. */
  loadingOlder: boolean;
  /** True when there are no more older prompts to load. */
  atStart: boolean;
}

const freshChatStore = (): ChatStore => ({
  view: null,
  prompts: [],
  liveTokens: {},
  loadingOlder: false,
  atStart: false,
});

export default function ChatPane() {
  const [chatStore, setChatStore] = createStore<ChatStore>(freshChatStore());
  const [input, setInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  // Inline rename state. `renamingId` is the chat being edited (or null);
  // `renameDraft` holds the in-flight input value.
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");

  const scope = () => currentScope();
  const tabs = () => scope()?.chats ?? [];
  const activeId = () => selectedChatId();

  /** Refresh the chat list for the active scope from the BE. */
  async function refreshScopeChats() {
    const pid = state.selectedProjectId;
    if (!pid) {
      setScopeChats([]);
      return;
    }
    try {
      const all = await api.listProjectChats(pid);
      const wt = currentWorktreeId();
      const filtered = all.filter((c) => (c.worktree_id ?? null) === wt);
      setScopeChats(filtered.map((c) => ({ id: c.id, title: c.title })));
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

  // Subscribe to per-chat event stream. Tears down on chat switch.
  createEffect(() => {
    const id = activeId();
    if (!id) return;
    const url = wsUrlFor(`chat:${id}`);
    let socket: WebSocket | null = null;
    let closed = false;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    socket.addEventListener("message", (ev) => {
      if (closed) return;
      const frame = parseWsFrame(ev.data);
      if (!frame) return;
      setChatStore(produce((s) => applyWsFrame(s, frame)));
    });
    socket.addEventListener("error", () => {
      // BE will reconnect via our manual fetch on next interaction;
      // don't surface transient WS hiccups as user errors.
    });
    onCleanup(() => {
      closed = true;
      try {
        socket?.close();
      } catch {
        // ignore
      }
    });
  });

  // Refresh tab list whenever the active scope changes.
  createEffect(() => {
    void state.selectedProjectId;
    void currentWorktreeId();
    void refreshScopeChats();
  });

  // Reload the open chat whenever the active chat id changes.
  createEffect(() => {
    void activeId();
    void loadChat();
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
    recordMemoryUsage("chat.activeView", bytes);
  });

  function startRename(id: string, current: string) {
    setRenamingId(id);
    setRenameDraft(current);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft("");
  }

  async function commitRename(id: string, current: string) {
    const next = renameDraft().trim();
    cancelRename();
    if (!next || next === current) return;
    try {
      const updated = await api.renameChat(id, next);
      // Update local tab list + (if this is the active chat) the
      // chat view so the provider chip / window header refresh.
      setScopeChats(
        tabs().map((t) => (t.id === id ? { ...t, title: updated.title } : t)),
      );
      if (chatStore.view && chatStore.view.id === id) {
        setChatStore("view", { ...chatStore.view, title: updated.title });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function closeTab(id: string, title: string) {
    const ok = await confirm({
      title: `Close chat "${title}"?`,
      body: "The chat tab will be removed from this view. The conversation history stays on the server and can be reopened from the project rail.",
      confirmLabel: "Close",
      testId: "confirm-close-chat",
    });
    if (!ok) return;
    closeChatTab(id);
  }

  async function send(ev: SubmitEvent) {
    ev.preventDefault();
    const id = activeId();
    const body = input().trim();
    if (!id || !body) return;
    setBusy(true);
    try {
      // Optimistically add a prompt placeholder; the BE returns the
      // canonical record we replace it with. Token + tool events
      // flow in via the WS subscription.
      const prompt = await api.addPrompt(id, body);
      setChatStore(
        produce((s) => {
          // The BE may already have appended terminal events (Done,
          // Truncated) by the time the response returns; ignore them
          // for tokens and rely on liveTokens, but keep the events
          // array authoritative for tool calls / done / errors.
          s.prompts.push(prompt);
          if (s.prompts.length > MAX_PROMPTS_IN_VIEW) {
            s.prompts.shift();
          }
        }),
      );
      setInput("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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

  const chat = createMemo(() => chatStore.view);

  return (
    <section data-testid="chat-pane" class="flex flex-col h-full">
      {/* Tab strip */}
      <header
        class="h-11 px-2 flex items-center gap-1.5 border-b border-border bg-bg-1 overflow-x-auto"
        data-testid="chat-tabs"
      >
        <For each={tabs()}>
          {(t) => (
            <div
              class="group inline-flex items-center gap-1 rounded-md border border-border bg-bg-2 pl-2 pr-1 py-1 text-[12px] cursor-pointer"
              classList={{
                "!border-accent !bg-accent-soft": t.id === activeId(),
                "hover:bg-bg-3":
                  t.id !== activeId() && renamingId() !== t.id,
              }}
              onClick={() => {
                if (renamingId() !== t.id) setActiveChat(t.id);
              }}
              onDblClick={(e) => {
                e.stopPropagation();
                startRename(t.id, t.title);
              }}
              onKeyDown={(e) => {
                // F2 starts rename when the tab is focused/active.
                if (
                  e.key === "F2" &&
                  t.id === activeId() &&
                  renamingId() !== t.id
                ) {
                  e.preventDefault();
                  startRename(t.id, t.title);
                }
              }}
              title={renamingId() === t.id ? "" : `${t.title} · double-click to rename`}
              data-testid={`chat-tab-${t.id}`}
              tabIndex={0}
            >
              <Show
                when={renamingId() === t.id}
                fallback={
                  <span class="truncate max-w-[180px]">{t.title}</span>
                }
              >
                <input
                  class="ag-input !py-0 !px-1 !h-6 !text-[12px] max-w-[180px]"
                  value={renameDraft()}
                  onInput={(e) => setRenameDraft(e.currentTarget.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => void commitRename(t.id, t.title)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.currentTarget as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  data-testid={`chat-rename-input-${t.id}`}
                  ref={(el) => {
                    // Focus + select on mount.
                    queueMicrotask(() => {
                      el.focus();
                      el.select();
                    });
                  }}
                />
              </Show>
              <Show when={renamingId() !== t.id}>
                <button
                  type="button"
                  class="ml-1 px-1 text-fg-subtle hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(t.id, t.title);
                  }}
                  aria-label={`Close ${t.title}`}
                  data-testid={`chat-close-${t.id}`}
                  title="Close chat tab"
                >
                  ✕
                </button>
              </Show>
            </div>
          )}
        </For>
        <Show when={chat()}>
          <span class="ml-2 ag-chip ag-chip-accent" data-testid="chat-provider">
            {chat()!.provider}/{chat()!.model}
          </span>
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

      <VirtualizedTimeline
        prompts={chatStore.prompts}
        liveTokens={chatStore.liveTokens}
        atStart={chatStore.atStart}
        loadingOlder={chatStore.loadingOlder}
        onLoadOlder={() => void loadOlder()}
        onRevert={(p) => void revert(p)}
      />

      <form
        onSubmit={send}
        class="px-4 py-3 border-t border-border bg-bg-1 flex gap-2 items-end"
        data-testid="chat-input-form"
      >
        <textarea
          rows="1"
          class="ag-input resize-none max-h-40"
          placeholder="Message the agent…  (⏎ to send, ⇧⏎ for newline)"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const form = (e.currentTarget as HTMLTextAreaElement).form;
              form?.requestSubmit();
            }
          }}
          disabled={!activeId() || busy()}
          data-testid="chat-input"
        />
        <button
          type="submit"
          class="ag-btn ag-btn-primary"
          disabled={!activeId() || busy() || !input().trim()}
          data-testid="chat-send"
        >
          Send
          <span class="ag-kbd !bg-transparent !border-transparent text-[var(--ag-accent-fg)] opacity-80">
            ⏎
          </span>
        </button>
      </form>
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
  atStart: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRevert: (p: Prompt) => void;
}) {
  let scrollRef!: HTMLDivElement;
  let prevLength = props.prompts.length;
  let prevFirstId: string | undefined = props.prompts[0]?.id;

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

  // Auto-scroll to bottom when a new prompt is appended at the tail
  // (the user just hit send). Don't auto-scroll on backfill of older
  // prompts — that would yank the viewport away from what the user
  // was reading.
  createEffect(() => {
    const ps = props.prompts;
    const len = ps.length;
    const firstId = ps[0]?.id;
    if (len > prevLength && firstId === prevFirstId) {
      // Tail growth.
      virtualizer.scrollToIndex(len - 1, { align: "end" });
    }
    prevLength = len;
    prevFirstId = firstId;
  });

  // Live token deltas grow the active prompt's text — make sure the
  // virtualizer re-measures its row.
  createEffect(() => {
    // Touch the liveTokens map so the effect re-runs on append.
    void Object.keys(props.liveTokens).length;
    void Object.values(props.liveTokens).reduce((n, s) => n + s.length, 0);
    virtualizer.measure();
  });

  return (
    <div
      ref={(el) => (scrollRef = el)}
      class="flex-1 overflow-y-auto px-6"
      data-testid="chat-timeline"
    >
      <Show when={!props.atStart && props.prompts.length > 0}>
        <div class="flex justify-center pt-4 pb-2">
          <button
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => props.onLoadOlder()}
            disabled={props.loadingOlder}
            data-testid="chat-load-older"
          >
            {props.loadingOlder ? "Loading…" : "↑ Load older messages"}
          </button>
        </div>
      </Show>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        <For each={virtualizer.getVirtualItems()}>
          {(vi) => {
            const prompt = props.prompts[vi.index];
            if (!prompt) return null;
            return (
              <div
                ref={(el) => virtualizer.measureElement(el)}
                data-index={vi.index}
                style={{
                  position: "absolute",
                  top: "0px",
                  left: "0px",
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <PromptRow
                  prompt={prompt}
                  liveToken={props.liveTokens[prompt.id]}
                  onRevert={() => props.onRevert(prompt)}
                />
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** A single prompt row: user bubble + assistant bubble + footer.
 *  Pulled out so the virtualizer can measure / remount independently. */
function PromptRow(props: {
  prompt: Prompt;
  liveToken: string | undefined;
  onRevert: () => void;
}) {
  function assistantText(): string {
    if (props.liveToken !== undefined) return props.liveToken;
    let out = "";
    for (const ev of props.prompt.events) {
      if (ev.type === "token") out += ev.text;
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

  return (
    <article
      class="space-y-3 group py-2.5"
      data-testid={`prompt-${props.prompt.id}`}
    >
      <div class="flex justify-end">
        <div class="max-w-[80%] rounded-2xl rounded-br-md bg-accent text-[var(--ag-accent-fg)] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap shadow-sm">
          {props.prompt.content}
        </div>
      </div>
      <Show when={assistantText() || tools().length > 0}>
        <div class="flex justify-start">
          <div class="max-w-[80%] rounded-2xl rounded-bl-md bg-bg-1 border border-border text-[13.5px] leading-relaxed px-4 py-2.5">
            <Show
              when={assistantText()}
              fallback={<em class="text-fg-subtle">working…</em>}
            >
              <Markdown source={assistantText()} />
            </Show>
            <For each={tools()}>{(ev) => <ToolBadge ev={ev} />}</For>
          </div>
        </div>
      </Show>
      <div class="flex items-center gap-2 text-[11px] text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity">
        <span class="ag-chip">#{props.prompt.seq}</span>
        <button
          class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px]"
          onClick={() => props.onRevert()}
          data-testid={`revert-${props.prompt.id}`}
          title="Ask AI to revert this prompt's changes"
        >
          ↺ Revert
        </button>
      </div>
    </article>
  );
}

/** Render a single tool-call / tool-result / error / truncated badge. */
function ToolBadge(props: { ev: AgentEvent }) {
  switch (props.ev.type) {
    case "tool_call":
      return (
        <div
          class="mt-2 inline-block ag-chip font-mono text-[11.5px]"
          title={safeStringify(props.ev.args)}
          data-testid="tool-call"
        >
          → {props.ev.name}
        </div>
      );
    case "tool_result":
      return (
        <div
          class="mt-1 inline-block ag-chip font-mono text-[11.5px] text-fg-subtle"
          title={safeStringify(props.ev.result)}
          data-testid="tool-result"
        >
          ✓ {props.ev.name || "result"}
        </div>
      );
    case "error":
      return (
        <div
          class="mt-2 inline-block ag-chip font-mono text-[11.5px] text-danger"
          data-testid="tool-error"
        >
          ⚠ {props.ev.message}
        </div>
      );
    case "truncated":
      return (
        <div
          class="mt-2 inline-block ag-chip font-mono text-[11.5px] text-fg-subtle"
          data-testid="tool-truncated"
        >
          ⋯ {props.ev.dropped} earlier event{props.ev.dropped === 1 ? "" : "s"} dropped
        </div>
      );
    default:
      return null;
  }
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return String(v);
  }
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
  const idx = s.prompts.findIndex((p) => p.id === promptId);
  if (idx < 0) return;
  const prompt = s.prompts[idx]!;
  prompt.events.push(ev);
  if (ev.type === "done" || ev.type === "error") {
    // Stream finished — drop the live buffer so PromptRow falls back
    // to the events array (which holds the canonical, persisted text).
    delete s.liveTokens[promptId];
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
