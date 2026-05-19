import { For, Show, createEffect, createSignal } from "solid-js";
import { api, type Chat, type Prompt } from "../api/client";
import { state } from "../stores/app";

export default function ChatPane() {
  const [chat, setChat] = createSignal<Chat | null>(null);
  const [input, setInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function reload() {
    const id = state.selectedChatId;
    if (!id) {
      setChat(null);
      return;
    }
    const c = await api.getChat(id);
    setChat(c);
  }

  createEffect(() => {
    void state.selectedChatId;
    void reload();
  });

  async function send(ev: SubmitEvent) {
    ev.preventDefault();
    const id = state.selectedChatId;
    const body = input().trim();
    if (!id || !body) return;
    setBusy(true);
    try {
      await api.addPrompt(id, body);
      setInput("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function revert(p: Prompt) {
    const id = state.selectedChatId;
    if (!id) return;
    if (!confirm(`Revert prompt #${p.seq}?`)) return;
    await api.revertPrompt(id, p.id);
    await reload();
  }

  return (
    <section data-testid="chat-pane" class="flex flex-col h-full">
      <header class="px-4 py-2 border-b border-[var(--ag-muted)]">
        <h2 class="font-semibold" data-testid="chat-title">
          {chat()?.title ?? "Select a chat"}
        </h2>
      </header>
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-4" data-testid="chat-timeline">
        <Show
          when={chat() && chat()!.prompts.length > 0}
          fallback={<p class="text-[var(--ag-muted)]">No prompts yet.</p>}
        >
          <For each={chat()!.prompts}>
            {(p) => (
              <article
                class="border border-[var(--ag-muted)] rounded p-3"
                data-testid={`prompt-${p.id}`}
              >
                <div class="flex items-center justify-between mb-2">
                  <span class="text-xs text-[var(--ag-muted)]">#{p.seq}</span>
                  <button
                    class="text-xs text-amber-400"
                    onClick={() => revert(p)}
                    data-testid={`revert-${p.id}`}
                  >
                    Revert
                  </button>
                </div>
                <p class="font-mono text-sm whitespace-pre-wrap">{p.content}</p>
                <div class="mt-2 text-sm">
                  <For each={p.events}>
                    {(ev) => {
                      if (ev.type === "token") return <span>{ev.text}</span>;
                      if (ev.type === "done")
                        return <em class="text-[var(--ag-muted)]"> (done)</em>;
                      if (ev.type === "error")
                        return <em class="text-red-400"> error: {ev.message}</em>;
                      return null;
                    }}
                  </For>
                </div>
              </article>
            )}
          </For>
        </Show>
      </div>
      <form
        onSubmit={send}
        class="p-3 border-t border-[var(--ag-muted)] flex gap-2"
        data-testid="chat-input-form"
      >
        <input
          class="flex-1 px-3 py-2 rounded bg-transparent border border-[var(--ag-muted)]"
          placeholder="Send a prompt..."
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          disabled={!state.selectedChatId || busy()}
          data-testid="chat-input"
        />
        <button
          type="submit"
          class="px-4 py-2 rounded bg-[var(--ag-accent)] text-white"
          disabled={!state.selectedChatId || busy()}
          data-testid="chat-send"
        >
          Send
        </button>
      </form>
    </section>
  );
}
