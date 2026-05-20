import { For, Show, createEffect, createSignal } from "solid-js";
import { api, type Chat, type Prompt } from "../api/client";
import { confirm } from "../components/dialog";
import {
  addChatTab,
  closeChatTab,
  currentScope,
  currentWorktreeId,
  selectedChatId,
  setActiveChat,
  setScopeChats,
  state,
} from "../stores/app";

export default function ChatPane() {
  const [chat, setChat] = createSignal<Chat | null>(null);
  const [input, setInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const scope = () => currentScope();
  const tabs = () => scope()?.chats ?? [];
  const activeId = () => selectedChatId();

  /** Refresh the chat list for the active scope from the BE. Called on
   *  every scope (project / worktree) change so the tab strip mirrors
   *  server state and is filtered to the active worktree (or project
   *  root when no worktree is selected). */
  async function refreshScopeChats() {
    const pid = state.selectedProjectId;
    if (!pid) {
      setScopeChats([]);
      return;
    }
    try {
      const all = await api.listProjectChats(pid);
      const wt = currentWorktreeId();
      // BE returns the union; filter client-side so each scope shows its
      // own chats (worktree chats stay under their worktree, project-
      // root chats stay under the project root).
      const filtered = all.filter((c) => (c.worktree_id ?? null) === wt);
      setScopeChats(filtered.map((c) => ({ id: c.id, title: c.title })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function reload() {
    const id = activeId();
    if (!id) {
      setChat(null);
      return;
    }
    try {
      setChat(await api.getChat(id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Refresh tab list whenever the active scope changes.
  createEffect(() => {
    void state.selectedProjectId;
    void currentWorktreeId();
    void refreshScopeChats();
  });

  // Reload the open chat whenever the active chat id changes.
  createEffect(() => {
    void activeId();
    void reload();
  });

  async function newChat() {
    const pid = state.selectedProjectId;
    if (!pid) return;
    setErr(null);
    setCreating(true);
    try {
      const wt = currentWorktreeId();
      const body: {
        title: string;
        provider: string;
        model: string;
        worktree_id?: string;
      } = {
        title: `chat ${tabs().length + 1}`,
        provider: "fake",
        model: "echo",
      };
      if (wt) body.worktree_id = wt;
      const created = await api.createProjectChat(pid, body);
      addChatTab({ id: created.id, title: created.title });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
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
      await api.addPrompt(id, body);
      setInput("");
      await reload();
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
      {/* Tab strip */}
      <header
        class="h-11 px-2 flex items-center gap-1.5 border-b border-border bg-bg-1 overflow-x-auto"
        data-testid="chat-tabs"
      >
        <For
          each={tabs()}
          fallback={
            <span class="text-[12.5px] text-fg-subtle italic px-2">
              No chats in this scope.
            </span>
          }
        >
          {(t) => (
            <div
              class="group inline-flex items-center gap-1 rounded-md border border-border bg-bg-2 pl-2 pr-1 py-1 text-[12px] cursor-pointer"
              classList={{
                "!border-accent !bg-accent-soft": t.id === activeId(),
                "hover:bg-bg-3": t.id !== activeId(),
              }}
              onClick={() => setActiveChat(t.id)}
              title={t.title}
              data-testid={`chat-tab-${t.id}`}
            >
              <span class="truncate max-w-[180px]">{t.title}</span>
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
            </div>
          )}
        </For>
        <button
          class="ag-btn ag-btn-ghost ag-btn-sm ml-1"
          onClick={() => void newChat()}
          disabled={creating() || !state.selectedProjectId}
          title="New chat in this scope"
          data-testid="chat-new"
        >
          + New
        </button>
        <Show when={chat()}>
          <span class="ml-2 ag-chip ag-chip-accent" data-testid="chat-provider">
            {chat()!.provider}/{chat()!.model}
          </span>
        </Show>
        <Show when={err()}>
          <span class="ml-auto text-[11.5px] text-danger" data-testid="chat-error" title={err() ?? ""}>
            {err()}
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
