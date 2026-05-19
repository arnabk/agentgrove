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
    setChat(await api.getChat(id));
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

  function assistantText(p: Prompt) {
    return p.events
      .filter((e): e is { type: "token"; text: string } => e.type === "token")
      .map((e) => e.text)
      .join("");
  }

  return (
    <section data-testid="chat-pane" class="flex flex-col h-full">
      <header class="h-11 px-4 flex items-center border-b border-border bg-bg-1">
        <h2 class="text-[13px] font-semibold tracking-tight" data-testid="chat-title">
          {chat()?.title ?? "No chat selected"}
        </h2>
        <Show when={chat()}>
          <span class="ml-2 ag-chip ag-chip-accent">
            {chat()!.provider}/{chat()!.model}
          </span>
        </Show>
      </header>

      <div class="flex-1 overflow-y-auto px-6 py-6 space-y-5" data-testid="chat-timeline">
        <Show
          when={chat() && chat()!.prompts.length > 0}
          fallback={
            <div class="text-center text-fg-subtle text-sm mt-20">
              <Show when={chat()} fallback={<>Select or create a chat to begin.</>}>
                <>Start the conversation below.</>
              </Show>
            </div>
          }
        >
          <For each={chat()!.prompts}>
            {(p) => (
              <article class="space-y-3 group" data-testid={`prompt-${p.id}`}>
                {/* User bubble */}
                <div class="flex justify-end">
                  <div class="max-w-[80%] rounded-2xl rounded-br-md bg-accent text-[var(--ag-accent-fg)] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap shadow-sm">
                    {p.content}
                  </div>
                </div>
                {/* Assistant bubble */}
                <Show when={assistantText(p) || p.events.length > 0}>
                  <div class="flex justify-start">
                    <div class="max-w-[80%] rounded-2xl rounded-bl-md bg-bg-1 border border-border text-[13.5px] leading-relaxed whitespace-pre-wrap px-4 py-2.5">
                      <Show
                        when={assistantText(p)}
                        fallback={<em class="text-fg-subtle">no response</em>}
                      >
                        {assistantText(p)}
                      </Show>
                    </div>
                  </div>
                </Show>
                {/* Footer: seq + revert */}
                <div class="flex items-center gap-2 text-[11px] text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity">
                  <span class="ag-chip">#{p.seq}</span>
                  <button
                    class="ag-btn ag-btn-ghost !py-0.5 !px-1.5 !text-[11px]"
                    onClick={() => revert(p)}
                    data-testid={`revert-${p.id}`}
                    title="Ask AI to revert this prompt's changes"
                  >
                    ↺ Revert
                  </button>
                </div>
              </article>
            )}
          </For>
        </Show>
      </div>

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
          disabled={!state.selectedChatId || busy()}
          data-testid="chat-input"
        />
        <button
          type="submit"
          class="ag-btn ag-btn-primary"
          disabled={!state.selectedChatId || busy() || !input().trim()}
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
