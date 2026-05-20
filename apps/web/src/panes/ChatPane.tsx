import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
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
  type UploadDto,
} from "../api/client";
import ChatSettingsDialog from "../components/ChatSettingsDialog";
import { confirm } from "../components/dialog";
import Markdown from "../components/Markdown";
import QueueDrawer from "../components/QueueDrawer";
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
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  // Pending uploads attached to the next prompt. Chips render below
  // the textarea; on send we tack their absolute paths onto the
  // prompt body so the agent's Read tool can fetch them.
  const [uploads, setUploads] = createSignal<UploadDto[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [dragActive, setDragActive] = createSignal(false);
  // Inline rename state. `renamingId` is the chat being edited (or null);
  // `renameDraft` holds the in-flight input value.
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");
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
  // Queue drawer visibility. Persisted across reloads so users who
  // rely on it don't have to re-open after every refresh.
  const [queueOpen, setQueueOpen] = createSignal(
    localStorage.getItem("ag-chat-queue-open") === "1",
  );
  createEffect(() => {
    localStorage.setItem("ag-chat-queue-open", queueOpen() ? "1" : "0");
  });
  // Lightweight queue summary used to drive the header badge. Polled
  // even while the drawer is closed so the count + status stay live.
  const [queueSummary, setQueueSummary] = createSignal<{
    total: number;
    pending: number;
    running: number;
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
      // `queue_dispatched` is a hint from the BE that the queue
      // popped an item and dispatched it as a new prompt. Re-fetch
      // the chat so the new prompt + its events show up in the
      // timeline; otherwise we'd only see them on next switch.
      try {
        if (typeof ev.data === "string") {
          const parsed = JSON.parse(ev.data) as { queue_dispatched?: string };
          if (parsed.queue_dispatched) {
            void loadChat();
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
    for (const live of Object.values(chatStore.liveThinking)) {
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
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function removeUpload(id: string) {
    setUploads((cur) => cur.filter((u) => u.id !== id));
  }

  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void uploadFileList(files);
    }
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
  async function send(ev: SubmitEvent) {
    ev.preventDefault();
    const id = activeId();
    let body = input().trim();
    const atts = uploads();
    if (!id || (!body && atts.length === 0)) return;
    if (atts.length > 0) {
      const lines = atts
        .map(
          (u) =>
            `- ${u.path}${u.content_type ? ` (${u.content_type})` : ""}`,
        )
        .join("\n");
      body = `${body}${body ? "\n\n" : ""}Attached files (absolute paths, read with your Read tool):\n${lines}`;
    }

    // Snapshot the busy state *before* we mutate it so we know which
    // branch the user actually intended.
    const wasBusy = busy();
    if (wasBusy) {
      // Agent is mid-turn: enqueue instead of dispatching. Don't flip
      // the busy signal — that belongs to the in-flight dispatch.
      try {
        await api.enqueue(id, body);
        setInput("");
        setUploads([]);
        queueMicrotask(() => {
          const el = document.querySelector<HTMLTextAreaElement>(
            '[data-testid="chat-input"]',
          );
          autoResizeTextarea(el);
        });
        // Auto-open the queue panel so the user sees what just landed.
        if (!queueOpen()) setQueueOpen(true);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    setBusy(true);
    try {
      // Optimistically add a prompt placeholder; the BE returns the
      // canonical record we replace it with. Token + tool events
      // flow in via the WS subscription.
      const prompt = await api.addPrompt(id, body);
      setChatStore(
        produce((s) => {
          s.prompts.push(prompt);
          if (s.prompts.length > MAX_PROMPTS_IN_VIEW) {
            s.prompts.shift();
          }
        }),
      );
      setInput("");
      setUploads([]);
      // Snap the textarea back to its initial height now that the
      // text is gone. queueMicrotask lets Solid finish patching the
      // value first.
      queueMicrotask(() => {
        const el = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="chat-input"]',
        );
        autoResizeTextarea(el);
      });
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

  // Load slash commands for the active chat's provider. Refreshes
  // whenever the chat (and therefore the provider) changes.
  createEffect(() => {
    const c = chat();
    if (!c) {
      setProviderCommands([]);
      return;
    }
    void api
      .listProviderCommands(c.provider)
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
    const prompts: SlashSuggestion[] = (state.settings.prompts ?? []).map(
      (p) => ({
        key: `prompt:${p.id}`,
        label: p.name,
        hint: "prompt",
        insert: p.body,
        detail: p.body.split("\n")[0] ?? "",
      }),
    );
    const all = [...cmds, ...prompts];
    if (!needle) return all.slice(0, 12);
    return all
      .filter(
        (s) =>
          s.label.toLowerCase().includes(needle) ||
          s.detail.toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }

  /** Apply a suggestion: locate the `/<query>` token in the input
   *  value, swap it for the insertion, and move the caret to the
   *  end of the inserted text. */
  function applySlash(suggestion: SlashSuggestion) {
    const ta = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]',
    );
    if (!ta) return;
    const value = ta.value;
    const cursor = ta.selectionStart;
    // The slash query is everything from the most recent slash before
    // `cursor` (that sits at line start) up to the cursor.
    const before = value.slice(0, cursor);
    const slashAt = before.lastIndexOf("/");
    if (slashAt < 0) return;
    const atLineStart =
      slashAt === 0 || value[slashAt - 1] === "\n" || value[slashAt - 1] === " ";
    if (!atLineStart) return;
    const newValue =
      value.slice(0, slashAt) + suggestion.insert + value.slice(cursor);
    ta.value = newValue;
    setInput(newValue);
    const caret = slashAt + suggestion.insert.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    autoResizeTextarea(ta);
    setSlashQuery(null);
    setSlashIdx(0);
  }

  /** Inspect the textarea's current value + cursor and update the
   *  slash menu state. Called from onInput and after Enter to track
   *  what `/<token>` the user has typed. */
  function updateSlashState(ta: HTMLTextAreaElement) {
    const cursor = ta.selectionStart;
    const before = ta.value.slice(0, cursor);
    const slashAt = before.lastIndexOf("/");
    if (slashAt < 0) {
      setSlashQuery(null);
      return;
    }
    const atLineStart =
      slashAt === 0 || before[slashAt - 1] === "\n" || before[slashAt - 1] === " ";
    if (!atLineStart) {
      setSlashQuery(null);
      return;
    }
    const token = before.slice(slashAt + 1);
    // Token ends at the next whitespace; if it contains one, abort
    // the menu (the user moved on).
    if (/\s/.test(token)) {
      setSlashQuery(null);
      return;
    }
    setSlashQuery(token);
    setSlashIdx(0);
  }

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
          <button
            type="button"
            class="ml-2 ag-chip ag-chip-accent hover:opacity-80"
            title={`${chat()!.provider}/${chat()!.model}${chat()!.effort ? ` · effort ${chat()!.effort}` : ""} — click to configure`}
            data-testid="chat-provider"
            onClick={() => setChatSettingsOpen(true)}
          >
            {chat()!.provider}/{chat()!.model}
            <Show when={chat()!.effort}>
              <span class="ml-1 text-fg-subtle">· {chat()!.effort}</span>
            </Show>
          </button>
        </Show>
        <Show when={activeId() && (queueSummary()?.total ?? 0) > 0}>
          <button
            type="button"
            class="ml-1 ag-chip flex items-center gap-1 hover:bg-bg-3"
            classList={{
              "!border-accent": (queueSummary()?.running ?? 0) > 0,
            }}
            onClick={() => setQueueOpen(!queueOpen())}
            title={`Queue: ${queueSummary()?.pending ?? 0} pending, ${queueSummary()?.running ?? 0} running, ${queueSummary()?.total ?? 0} total`}
            data-testid="chat-queue-badge"
          >
            <span class="text-fg-subtle">⏳ queue</span>
            <span class="text-fg font-mono">
              {queueSummary()?.pending ?? 0}
            </span>
            <Show when={(queueSummary()?.running ?? 0) > 0}>
              <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            </Show>
          </button>
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
        liveThinking={chatStore.liveThinking}
        atStart={chatStore.atStart}
        loadingOlder={chatStore.loadingOlder}
        onLoadOlder={() => void loadOlder()}
        onRevert={(p) => void revert(p)}
      />

      <Show when={activeId()}>
        <QueueDrawer
          chatId={activeId()!}
          open={queueOpen()}
          onClose={() => setQueueOpen(false)}
        />
      </Show>

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
              <span class="ag-chip text-[11.5px] text-fg-subtle italic">
                Uploading…
              </span>
            </Show>
          </div>
        </Show>
        <div class="flex gap-2 items-end">
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
              const ta = document.querySelector<HTMLTextAreaElement>(
                '[data-testid="chat-input"]',
              );
              if (!ta) return;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const newValue =
                ta.value.slice(0, start) + body + ta.value.slice(end);
              ta.value = newValue;
              setInput(newValue);
              const caret = start + body.length;
              ta.focus();
              ta.setSelectionRange(caret, caret);
              autoResizeTextarea(ta);
            }}
          />
          <div class="flex-1 relative">
            <SlashMenu
              query={slashQuery()}
              suggestions={suggestions()}
              activeIdx={slashIdx()}
              onPick={applySlash}
              onHoverIdx={setSlashIdx}
            />
            <textarea
              rows="3"
              class="ag-input resize-none max-h-60 min-h-[3.2em] w-full leading-relaxed"
              placeholder={
                busy()
                  ? "Agent is working… ⏎ to enqueue, ⇧⏎ for newline"
                  : "Message the agent…  (⏎ to send, ⇧⏎ for newline, / for commands, - for bullets, paste/drop files to attach)"
              }
              value={input()}
              onInput={(e) => {
                setInput(e.currentTarget.value);
                autoResizeTextarea(e.currentTarget);
                updateSlashState(e.currentTarget);
              }}
              onPaste={onPaste}
              onKeyDown={(e) => {
                // While the slash menu is open, arrow keys + Enter +
                // Tab + Escape drive the menu instead of the
                // textarea defaults.
                if (slashQuery() !== null) {
                  const list = suggestions();
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (list.length > 0) {
                      setSlashIdx((i) => (i + 1) % list.length);
                    }
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (list.length > 0) {
                      setSlashIdx((i) => (i - 1 + list.length) % list.length);
                    }
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    if (list.length > 0) {
                      e.preventDefault();
                      applySlash(list[slashIdx()] ?? list[0]!);
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashQuery(null);
                    return;
                  }
                }
                onChatInputKeyDown(e, () => {
                  const form = (e.currentTarget as HTMLTextAreaElement).form;
                  form?.requestSubmit();
                });
              }}
              onSelect={(e) =>
                updateSlashState(e.currentTarget as HTMLTextAreaElement)
              }
              onBlur={() => {
                // Defer close so a mouse click on the menu still
                // fires before the menu disappears.
                setTimeout(() => setSlashQuery(null), 150);
              }}
              ref={(el) => {
                queueMicrotask(() => autoResizeTextarea(el));
              }}
              disabled={!activeId()}
              data-testid="chat-input"
            />
          </div>
          <button
            type="submit"
            class="ag-btn ag-btn-primary"
            disabled={
              !activeId() ||
              (!input().trim() && uploads().length === 0)
            }
            title={
              busy()
                ? "Agent is busy — your message will be queued"
                : "Send to the agent"
            }
            data-testid="chat-send"
          >
            {busy() ? "Enqueue" : "Send"}
            <span class="ag-kbd !bg-transparent !border-transparent text-[var(--ag-accent-fg)] opacity-80">
              ⏎
            </span>
          </button>
        </div>
      </form>

      <Show when={chatSettingsOpen() && chat()}>
        <ChatSettingsDialog
          chat={chat()!}
          onClose={() => setChatSettingsOpen(false)}
          onUpdated={(updated) => {
            // Refresh the chat-level view + tab title in case it
            // changed indirectly.
            setChatStore("view", (v) => (v ? { ...v, ...updated } : v));
            setScopeChats(
              tabs().map((t) =>
                t.id === updated.id ? { ...t, title: updated.title } : t,
              ),
            );
          }}
          onInsertCommand={(cmd) => {
            // Insert `/cmd` at cursor in the chat textarea.
            const ta = document.querySelector<HTMLTextAreaElement>(
              '[data-testid="chat-input"]',
            );
            if (!ta) return;
            const insertion = `/${cmd}`;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const newValue =
              ta.value.slice(0, start) + insertion + ta.value.slice(end);
            ta.value = newValue;
            setInput(newValue);
            const caret = start + insertion.length;
            ta.focus();
            ta.setSelectionRange(caret, caret);
            autoResizeTextarea(ta);
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

  /** Height of the un-rendered prefix in pixels. The first virtual
   *  item's `start` happens to be exactly that height since
   *  measurements are cumulative from index 0. */
  const topSpacer = () => virtualizer.getVirtualItems()[0]?.start ?? 0;
  /** Height of the un-rendered suffix in pixels: total - (last
   *  rendered item's end). */
  const bottomSpacer = () => {
    const items = virtualizer.getVirtualItems();
    const total = virtualizer.getTotalSize();
    const last = items[items.length - 1];
    if (!last) return 0;
    return Math.max(0, total - (last.start + last.size));
  };

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

  // Live token / thinking deltas grow the active prompt's bubble —
  // tell the virtualizer to re-measure so the row height stays in
  // sync.
  createEffect(() => {
    // Touch both maps so the effect re-runs on append.
    void Object.keys(props.liveTokens).length;
    void Object.values(props.liveTokens).reduce((n, s) => n + s.length, 0);
    void Object.keys(props.liveThinking).length;
    void Object.values(props.liveThinking).reduce((n, s) => n + s.length, 0);
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
      <div style={{ width: "100%" }}>
        <div
          style={{ height: `${topSpacer()}px` }}
          aria-hidden="true"
        />
        <For each={virtualizer.getVirtualItems()}>
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
                    liveToken={props.liveTokens[prompt()!.id]}
                    liveThinking={props.liveThinking[prompt()!.id]}
                    onRevert={() => props.onRevert(prompt()!)}
                  />
                </div>
              </Show>
            );
          }}
        </For>
        <div
          style={{ height: `${bottomSpacer()}px` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/** A single prompt row: user bubble + assistant bubble + footer.
 *  Pulled out so the virtualizer can measure / remount independently. */
function PromptRow(props: {
  prompt: Prompt;
  liveToken: string | undefined;
  liveThinking: string | undefined;
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

  /** Concatenate the model's thinking trace (extended-thinking
   *  output). Prefers the in-flight live buffer over walking the
   *  events array. Returns the empty string when the model wasn't
   *  asked to think (or doesn't support it). */
  function thinkingText(): string {
    if (props.liveThinking !== undefined) return props.liveThinking;
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

  // Thinking blocks collapse by default — they're verbose and most
  // users don't want them in the way. Sticky to true once expanded.
  const [thinkingOpen, setThinkingOpen] = createSignal(false);

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
      <Show when={thinkingText()}>
        <div class="flex justify-start">
          <details
            class="max-w-[80%] w-full rounded-xl bg-bg-2/40 border border-dashed border-border text-[12.5px] px-3 py-2 text-fg-muted"
            data-testid={`thinking-${props.prompt.id}`}
            open={thinkingOpen()}
            onToggle={(e) => setThinkingOpen(e.currentTarget.open)}
          >
            <summary class="cursor-pointer select-none text-[11.5px] uppercase tracking-wide text-fg-subtle">
              ✦ Thinking{" "}
              <span class="text-fg-subtle">
                ({fmtBytes(thinkingText().length)})
              </span>
            </summary>
            <div class="mt-2 ag-prose">
              <Markdown source={thinkingText()} />
            </div>
          </details>
        </div>
      </Show>
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
/**
 * Resize a textarea to fit its content up to its `max-height`. Solid
 * doesn't ship a directive for this, so we call it manually on input
 * and once after mount.
 *
 * Implementation: reset to `auto` first (otherwise scrollHeight is
 * clamped by the previous height), then snap to scrollHeight. The
 * CSS `max-height` keeps the upper bound; once exceeded, the
 * textarea scrolls.
 */
function autoResizeTextarea(el: HTMLTextAreaElement | null | undefined): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Keydown handler for the chat textarea. Adds two behaviours on top
 * of the default browser handling:
 *
 *   - `⏎` submits the form (caller-supplied `submit`); `⇧⏎` falls
 *     through so a newline gets inserted.
 *   - Pressing `⏎` on a line that starts with `- ` continues the
 *     bullet list. Pressing it again on an *empty* `- ` line clears
 *     the bullet and submits — the standard markdown editor pattern.
 *   - Typing `-` at the very start of a line auto-appends a space
 *     so users don't have to think about the formatting.
 */
function onChatInputKeyDown(
  e: KeyboardEvent,
  submit: () => void,
): void {
  const ta = e.currentTarget as HTMLTextAreaElement;
  if (e.key === "Enter" && !e.shiftKey) {
    // Inspect the current line. If it starts with a `- ` prefix
    // (markdown bullet), continue the list instead of submitting.
    const { selectionStart } = ta;
    const before = ta.value.slice(0, selectionStart);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineSoFar = before.slice(lineStart);
    const bullet = lineSoFar.match(/^(\s*)([-*])\s+(.*)$/);
    if (bullet) {
      const [, indent, marker, rest] = bullet;
      if (rest === "") {
        // Empty bullet → strip it and submit (common "end the list"
        // gesture).
        e.preventDefault();
        const newValue =
          ta.value.slice(0, lineStart) + ta.value.slice(selectionStart);
        ta.value = newValue;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        autoResizeTextarea(ta);
        submit();
        return;
      }
      // Non-empty bullet line: insert newline + same indent + marker.
      e.preventDefault();
      const insertion = `\n${indent}${marker} `;
      const after = ta.value.slice(selectionStart);
      const newValue = before + insertion + after;
      ta.value = newValue;
      const caret = selectionStart + insertion.length;
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      autoResizeTextarea(ta);
      return;
    }
    // Plain Enter outside a bullet: submit.
    e.preventDefault();
    submit();
    return;
  }
  // Auto-format: at line start, "-" alone becomes "- " so users
  // don't have to type the space.
  if (e.key === "-" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const { selectionStart, selectionEnd } = ta;
    if (selectionStart === selectionEnd) {
      const before = ta.value.slice(0, selectionStart);
      const atLineStart =
        selectionStart === 0 || before.endsWith("\n");
      if (atLineStart) {
        e.preventDefault();
        const insertion = "- ";
        const after = ta.value.slice(selectionEnd);
        ta.value = before + insertion + after;
        const caret = selectionStart + insertion.length;
        ta.setSelectionRange(caret, caret);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        autoResizeTextarea(ta);
        return;
      }
    }
  }
}

/** Popover button that lists the user's saved prompt templates and
 *  inserts the chosen body at the chat-input cursor. Uses the
 *  existing `state.settings.prompts` (managed in Settings → Prompts).
 *  No prompts -> the button is still rendered but disabled with a
 *  hint pointing the user at the settings tab. */
/** Popover floating above the chat textarea that surfaces provider
 *  slash-commands and saved prompts matching the user's `/<query>`.
 *  Mounted only when `query` is non-null; an empty string means the
 *  user just typed `/` and we show the full list. */
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
  onPick: (s: {
    key: string;
    label: string;
    hint: string;
    insert: string;
    detail: string;
  }) => void;
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
              <span class="text-[10.5px] uppercase tracking-wide text-fg-subtle">
                {s.hint}
              </span>
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
                      <div class="text-[12.5px] font-medium text-fg truncate">
                        {p.name}
                      </div>
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
