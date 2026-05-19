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

  function statusChip(s: string) {
    switch (s) {
      case "pending":
        return "ag-chip";
      case "running":
        return "ag-chip ag-chip-warn";
      case "done":
        return "ag-chip ag-chip-success";
      default:
        return "ag-chip";
    }
  }

  return (
    <section data-testid="queue-pane" class="flex flex-col h-full">
      <header class="h-11 px-4 flex items-center gap-3 border-b border-border bg-bg-1">
        <h2 class="text-[13px] font-semibold tracking-tight">Prompt Queue</h2>
        <Show when={q()}>
          <span class="ag-chip ag-chip-accent" data-testid="queue-mode">
            mode: {q()!.mode}
          </span>
          <button
            class="ag-btn ag-btn-secondary !py-1 !px-2.5 !text-[12px]"
            onClick={toggleMode}
            data-testid="queue-toggle-mode"
          >
            toggle
          </button>
          <button
            class="ag-btn ag-btn-primary !py-1 !px-2.5 !text-[12px]"
            onClick={runNext}
            data-testid="queue-run-next"
          >
            ▶ run next
          </button>
        </Show>
      </header>
      <form
        onSubmit={enqueue}
        class="px-4 py-3 border-b border-border bg-bg-1 flex gap-2"
        data-testid="queue-form"
      >
        <input
          class="ag-input"
          placeholder="Queue a thought… it'll run after the current prompt."
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          disabled={!state.selectedChatId}
          data-testid="queue-input"
        />
        <button
          type="submit"
          class="ag-btn ag-btn-primary"
          disabled={!state.selectedChatId || !body().trim()}
          data-testid="queue-add"
        >
          Add
        </button>
      </form>
      <ul class="flex-1 overflow-y-auto p-4 space-y-2" data-testid="queue-list">
        <For
          each={q()?.items ?? []}
          fallback={<li class="text-center text-fg-subtle text-sm py-10">No queued prompts.</li>}
        >
          {(it) => (
            <li
              class="flex items-center gap-3 rounded-md bg-bg-1 border border-border px-3 py-2.5 text-[13px]"
              data-testid={`queue-item-${it.id}`}
            >
              <span class={statusChip(it.status)} data-status={it.status}>
                {it.status}
              </span>
              <span class="flex-1 truncate">{it.body}</span>
              <Show when={it.status === "pending"}>
                <button
                  class="ag-btn ag-btn-danger !py-0.5 !px-1.5 !text-[11px]"
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
