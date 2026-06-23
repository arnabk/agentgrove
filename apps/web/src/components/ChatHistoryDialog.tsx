import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { api, type Chat } from "../api/client";
import { addChatTab } from "../stores/app";

interface Props {
  projectId: string;
  onClose: () => void;
  onRestored?: (chat: Chat) => void;
}

export default function ChatHistoryDialog(props: Props) {
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<Chat[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [busyId, setBusyId] = createSignal<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const params: { projectId?: string; q?: string } = { projectId: props.projectId };
      const q = query().trim();
      if (q) params.q = q;
      const list = await api.listChatHistory(params);
      setItems(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => void refresh());

  let timer: number | undefined;
  createEffect(() => {
    query();
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 300) as unknown as number;
  });

  async function restore(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      const chat = await api.restoreChat(id);
      addChatTab({ id: chat.id, title: chat.title });
      props.onRestored?.(chat);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Chat history"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="chat-history-dialog"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => props.onClose()} />
      <div class="relative w-full max-w-lg rounded-xl border border-border bg-bg-1 shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
        <header class="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 class="text-[15px] font-semibold tracking-tight">Chat history</h2>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon"
            onClick={() => props.onClose()}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div class="px-5 py-3 border-b border-border">
          <input
            class="ag-input w-full"
            placeholder="Search by title…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            autofocus
            data-testid="chat-history-search"
          />
        </div>

        <div class="flex-1 overflow-y-auto -mx-2 px-2">
          <Show when={err()}>
            <p class="text-danger text-[12.5px] px-3 py-2">{err()}</p>
          </Show>

          <Show when={!loading() && items().length === 0}>
            <Show when={loading()}>
              <p class="text-center text-[12.5px] text-fg-subtle py-6">Loading…</p>
            </Show>
            <p class="text-center text-[12.5px] text-fg-subtle py-6 italic">
              No deleted chats found.
            </p>
          </Show>

          <ul class="space-y-2 py-3">
            <For each={items()}>
              {(chat) => (
                <li
                  class="rounded-lg border border-border bg-bg-2 px-4 py-3 flex items-center gap-3"
                  data-testid={`chat-history-row-${chat.id}`}
                >
                  <div class="flex-1 min-w-0">
                    <p class="text-[13px] font-medium truncate">{chat.title}</p>
                    <p class="text-[11px] text-fg-subtle mt-0.5">
                      {chat.provider} / {chat.model}
                      {" · "}
                      {new Date(chat.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    class="ag-btn ag-btn-primary ag-btn-sm shrink-0"
                    disabled={busyId() === chat.id}
                    onClick={() => void restore(chat.id)}
                    data-testid={`chat-history-restore-${chat.id}`}
                  >
                    Restore
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>

        <footer class="flex items-center justify-end px-5 py-3 border-t border-border">
          <button type="button" class="ag-btn ag-btn-primary" onClick={() => props.onClose()}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
