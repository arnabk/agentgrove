import { For, Show, createEffect, createSignal } from "solid-js";
import { api, type QueueState } from "../api/client";
import { state } from "../stores/app";

export default function QueuePane() {
  const [q, setQ] = createSignal<QueueState | null>(null);
  const [body, setBody] = createSignal("");

  async function reload() {
    const id = state.selectedChatId;
    if (!id) {
      setQ(null);
      return;
    }
    setQ(await api.getQueue(id));
  }

  createEffect(() => {
    void state.selectedChatId;
    void reload();
  });

  async function enqueue(ev: SubmitEvent) {
    ev.preventDefault();
    const id = state.selectedChatId;
    if (!id || !body().trim()) return;
    await api.enqueue(id, body());
    setBody("");
    await reload();
  }

  async function toggleMode() {
    const id = state.selectedChatId;
    const cur = q()?.mode;
    if (!id || !cur) return;
    await api.setQueueMode(id, cur === "auto" ? "manual" : "auto");
    await reload();
  }

  async function runNext() {
    const id = state.selectedChatId;
    if (!id) return;
    await api.runNextQueue(id);
    await reload();
  }

  async function cancel(itemId: string) {
    const id = state.selectedChatId;
    if (!id) return;
    await api.cancelQueueItem(id, itemId);
    await reload();
  }

  return (
    <section data-testid="queue-pane" class="flex flex-col h-full">
      <header class="px-4 py-2 border-b border-[var(--ag-muted)] flex items-center gap-3">
        <h2 class="font-semibold">Queue</h2>
        <Show when={q()}>
          <span
            class="text-xs px-2 py-1 rounded border border-[var(--ag-muted)]"
            data-testid="queue-mode"
          >
            mode: {q()!.mode}
          </span>
          <button
            class="text-xs text-[var(--ag-accent)]"
            onClick={toggleMode}
            data-testid="queue-toggle-mode"
          >
            toggle
          </button>
          <button class="text-xs text-emerald-400" onClick={runNext} data-testid="queue-run-next">
            run next
          </button>
        </Show>
      </header>
      <form
        onSubmit={enqueue}
        class="p-3 border-b border-[var(--ag-muted)] flex gap-2"
        data-testid="queue-form"
      >
        <input
          class="flex-1 px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
          placeholder="Queue a thought..."
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          disabled={!state.selectedChatId}
          data-testid="queue-input"
        />
        <button
          type="submit"
          class="px-3 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
          disabled={!state.selectedChatId}
          data-testid="queue-add"
        >
          Add
        </button>
      </form>
      <ul class="flex-1 overflow-y-auto p-3 space-y-2" data-testid="queue-list">
        <For each={q()?.items ?? []}>
          {(it) => (
            <li
              class="flex items-center gap-2 border border-[var(--ag-muted)] rounded p-2 text-sm"
              data-testid={`queue-item-${it.id}`}
            >
              <span
                class="text-xs px-1 rounded border border-[var(--ag-muted)]"
                data-status={it.status}
              >
                {it.status}
              </span>
              <span class="flex-1 truncate">{it.body}</span>
              <Show when={it.status === "pending"}>
                <button
                  class="text-xs text-red-400"
                  onClick={() => cancel(it.id)}
                  data-testid={`queue-cancel-${it.id}`}
                >
                  cancel
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
